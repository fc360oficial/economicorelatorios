// Portal do Fornecedor (PWA em /fornecedor/) — Gestão de Compras > Cotação.
//
// O que é (Tiago, 13/10/2026): em vez de mandar o link de cada cotação pelo WhatsApp, o vendedor cria um LOGIN no
// portal UMA vez e as próximas cotações chegam como AVISO (Web Push), com atalho direto pra página dele. O WhatsApp
// fica só pra quem ainda não entrou.
//
//   1. conta: o vendedor recebe o link do portal (convite da tela administrativa ou painel na página da cotação) e
//      cria o login com nome, WhatsApp, PIN de 6 números e e-mail (obrigatório, mas não é login — Tiago, 13/10: "não
//      deixe o e-mail opcional"; pode repetir entre vendedores da mesma empresa). Histórico: primeiro "login e senha com
//      e-mail", depois "vai ser número e PIN" — fornecedor com 3 vendedores e 1 e-mail não casava; o WhatsApp é único
//      por vendedor e é o que já casa com a cotação). PIN guardado com scrypt + sal, nunca em texto. Depois de entrar,
//      o celular guarda um token longo (vt) que identifica a sessão em toda chamada. O(a) comprador(a) redefine o PIN
//      e desconecta na tela administrativa.
//   2. casamento com cotações/pedidos: o vendedor "é" o vendedor da cotação quando o WhatsApp (normalizado, sem 55)
//      bate; fornecedor sem WhatsApp cadastrado vale o e-mail; sem os dois vale a empresa (ligada à conta quando ele
//      entra pelo link de uma cotação/pedido dela)
//   3. push: inscrição por aparelho (Web Push, chave VAPID gerada sozinha na 1ª subida e guardada em data/);
//      avisos: nova cotação, lembrete 2 h antes do prazo, pedido gerado
//   4. Acompanhamento: cada fornecedor mostra o CANAL — "app" (vendedor com aparelho inscrito, avisado sozinho ao
//      criar a cotação) ou "whatsapp" (segue o "um por um"). Avisar pelo app marca enviadoEm na cotação, então os
//      botões de WhatsApp já listam só quem falta.
//
// Persistência: data/portal-fornecedor/ (vendedores.json, avisos.json, vapid.json). NADA é escrito no ERP.
// web-push é carregado em try/catch: sem o pacote (npm install ainda não rodou) o portal funciona sem avisos e
// o estado (/api/portal-admin/estado) diz o motivo.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.PORTAL_FORNECEDOR_DIR || path.join(__dirname, '..', 'data', 'portal-fornecedor');
const arq = n => path.join(DIR, n);
const LEMBRETE_MS = 2 * 60 * 60 * 1000;   // lembrete de prazo: 2 h antes
const TTL_NOVA = 24 * 60 * 60, TTL_LEMBRETE = 2 * 60 * 60, TTL_PEDIDO = 3 * 24 * 60 * 60;   // segundos que o aviso espera o celular voltar
const RECIBO_MS = 7 * 24 * 60 * 60 * 1000;   // recibo de entrega do aviso (rid no push) fica guardado 7 dias

let deps = {};             // { cotacao, pedidosFornec, lerCotForn, vendedores (cadastro único, 26/10), log }
let webpush = null, webpushErro = null, vapid = null;
let V = null;              // vendedores { [id = whats]: { id, nome, whats, email (opcional), senha (hash scrypt do PIN; nome do campo ficou da tarde de e-mail+senha), senhaEm, token (sessão), empresas:[{codFornec,nome}], dispositivos:[{endpoint,keys,ua,criadoEm}], criadoEm, ultimoAcesso } }
let CFG = null;            // config.json { exigeLogin } — login obrigatório pra responder cotação (Tiago, 13/10: "quero forçar já agora nessa cotação"); ligado por padrão
let A = null;              // avisos { cotacoes: { [cotId]: { [codFornec]: { avisadoEm, vendedores, reenvios, motivo, lembreteEm, lembreteOk,
                           //   rid, rids, entregueEm, entregueRid, entreguePor, abriuEm, abriuRid, lembreteRid, lembreteEntregueEm, lembreteAbriuEm (recibo, 10/11),
                           //   lembretesAnteriores: [{ em, ok, entregueEm, abriuEm, rid, prazoMudouEm }] (lembretes zerados por mudança de prazo, revisão 10/11) } } },
                           //   pedidos: { [pedId]: { avisadoEm, vendedores, push, portal, rid, rids, entregueEm, entregueRid, entreguePor, abriuEm, abriuRid } },
                           //   recibos: { [rid]: { tipo: 'cotacao'|'lembrete'|'pedido'|'teste', cid, codFornec, pid, vendedores, em, entregueEm, abriuEm } } }

const lerJson = (n, padrao) => { try { return JSON.parse(fs.readFileSync(arq(n), 'utf8')); } catch (e) { return padrao; } };
const gravarJson = (n, obj) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(arq(n), JSON.stringify(obj, null, 1)); };
const salvarV = () => gravarJson('vendedores.json', V);
const salvarA = () => gravarJson('avisos.json', A);
const log = (...a) => (deps.log || console.log)('[PORTAL]', ...a);
const agoraISO = () => new Date().toISOString();

// WhatsApp no padrão da casa (pedidos-fornecedor.normWhats): só dígitos, sem 55; 9 dígitos ganham 81, 8 ganham 81 9
function normWhats(v) {
  let d = String(v || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length === 9) d = '81' + d; else if (d.length === 8) d = '819' + d;
  return d.length === 10 || d.length === 11 ? d : '';
}
// (81) 9••••-4410 — a lista "quem é você?" mostra o número mascarado
function mascara(w) { const d = normWhats(w); if (!d) return ''; const ddd = d.slice(0, 2), fim = d.slice(-4), meio = d.slice(2, -4); return '(' + ddd + ') ' + meio.charAt(0) + '•'.repeat(Math.max(0, meio.length - 1)) + '-' + fim; }
const novoToken = () => crypto.randomBytes(16).toString('hex');
const ehToken = t => /^[a-f0-9]{32}$/.test(String(t || ''));
const normEmail = e => String(e || '').trim().toLowerCase().slice(0, 120);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
// PIN de 6 números, guardado como hash scrypt + sal no campo `senha` (nome que ficou da tarde em que o login foi e-mail + senha;
// quem criou conta naquele formato continua entrando com a senha antiga — a tela administrativa redefine pra um PIN)
const PIN_RE = /^\d{6}$/;
function hashSenha(s) { const sal = crypto.randomBytes(16).toString('hex'); return 'scrypt$' + sal + '$' + crypto.scryptSync(String(s), sal, 32).toString('hex'); }
function confereSenha(s, h) { const p = String(h || '').split('$'); if (p.length !== 3 || p[0] !== 'scrypt') return false; const a = crypto.scryptSync(String(s), p[1], 32), b = Buffer.from(p[2], 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function pinInvalido(p) { return PIN_RE.test(String(p == null ? '' : p).trim()) ? null : 'O PIN tem 6 números'; }
// chute de PIN: 8 erros seguidos no mesmo WhatsApp travam a entrada por 10 min (só em memória; reinício do servidor zera)
const TENT = new Map(); const TENT_MAX = 8, TENT_MS = 10 * 60 * 1000;
function bloqueado(e) { const t = TENT.get(e); return !!(t && t.n >= TENT_MAX && Date.now() - t.em < TENT_MS); }
function errou(e) { const t = TENT.get(e); if (t && Date.now() - t.em < TENT_MS) { t.n++; t.em = Date.now(); } else TENT.set(e, { n: 1, em: Date.now() }); }
function acertou(e) { TENT.delete(e); }

// ── init ────────────────────────────────────────────────────────────────────
function init(d) {
  deps = d || {};
  fs.mkdirSync(DIR, { recursive: true });
  V = lerJson('vendedores.json', {}); A = lerJson('avisos.json', { cotacoes: {}, pedidos: {} });
  if (!A.cotacoes) A.cotacoes = {}; if (!A.pedidos) A.pedidos = {}; if (!A.recibos) A.recibos = {};   // avisos.json de antes de 10/11 não tem recibos
  CFG = Object.assign({ exigeLogin: true }, lerJson('config.json', {}));
  try { sincronizarEmpresas(); } catch (e) { log('sincronizar empresas:', e.message); }
  // exemplos de teste (vendedores TESTE 81 90000-000x) saíram de cena (Tiago, 13/10: "quero que fique real e tire todos os
  // testes"): qualquer registro de teste ainda no disco é apagado ao subir
  let lixo = 0; for (const id of Object.keys(V)) if (V[id].teste) { delete V[id]; lixo++; }
  if (lixo) { salvarV(); log('exemplos de teste removidos:', lixo); }
  try { webpush = deps.webpush || require('web-push'); webpushErro = null; }
  catch (e) { webpush = null; webpushErro = 'pacote web-push não instalado (npm install): ' + e.message; log(webpushErro); }
  if (webpush) {
    vapid = lerJson('vapid.json', null);
    if (!vapid || !vapid.publicKey || !vapid.privateKey) { vapid = webpush.generateVAPIDKeys(); vapid.criadoEm = agoraISO(); gravarJson('vapid.json', vapid); log('chave VAPID gerada'); }
    webpush.setVapidDetails('mailto:' + (deps.contato || 'compras@economico.com.br'), vapid.publicKey, vapid.privateKey);
  }
  return estado();
}
function estado() {
  const vs = Object.values(V || {}).filter(v => !v.teste);
  return { webpush: !!webpush, erro: webpushErro, vapid: !!vapid, exigeLogin: exigeLogin(), sync_empresas: SYNC_EMP, vendedores: vs.length, comLogin: vs.filter(v => v.senha).length, instalados: vs.filter(v => v.instalado).length, comApp: vs.filter(comApp).length, dispositivos: vs.reduce((s, v) => s + (v.dispositivos || []).length, 0) };
}
const chavePublica = () => (vapid && vapid.publicKey) || null;
// login obrigatório pra responder cotação: sem sessão, a página da cotação trava num painel "crie seu login" sem "Agora não"
// (hook.js); desligado, o painel é só um convite que dá pra pular. Pedido do vendedor nunca trava (confirmar entrega é urgente).
const exigeLogin = () => !!(CFG && CFG.exigeLogin);
// app obrigatório no celular (13/11/26): sem o app instalado e os avisos ativos, o vendedor não responde pedido nem cotação pelo celular.
// Ligado por padrão; desliga em /api/portal-admin/config { exigeApp: false }. No computador nunca vale.
const exigeApp = () => !(CFG && CFG.exigeApp === false);
function setConfig(c) { CFG = Object.assign({ exigeLogin: true }, CFG || {}, c || {}); CFG.exigeLogin = !!CFG.exigeLogin; CFG.exigeApp = CFG.exigeApp !== false; CFG.alteradoEm = agoraISO(); gravarJson('config.json', CFG); return { exigeLogin: CFG.exigeLogin, exigeApp: CFG.exigeApp }; }

// ── vendedores ──────────────────────────────────────────────────────────────
const comApp = v => !!(v && v.dispositivos && v.dispositivos.length);
function vendedorPorToken(vt) { if (!ehToken(vt)) return null; return Object.values(V).find(v => v.token === vt) || null; }
function vendedorPorEmail(email) { const e = normEmail(email); if (!e) return null; return Object.values(V).find(v => normEmail(v.email) === e) || null; }
function visaoPublica(v) { return { id: v.id, nome: v.nome || null, whats: v.whats || null, whats_mascara: mascara(v.whats), email: v.email || null, tem_pin: !!v.senha, pinEm: v.senhaEm || null, instalado: v.instalado ? { desde: v.instalado.desde, em: v.instalado.em, navegador: resumoUa(v.instalado.ua) } : null, empresas: v.empresas || [], dispositivos: (v.dispositivos || []).length, criadoEm: v.criadoEm, ultimoAcesso: v.ultimoAcesso || null, teste: !!v.teste, navegador: resumoUa(v.ultimoUa), aparelhos: (v.dispositivos || []).map(d => ({ criadoEm: d.criadoEm, ultimoEnvio: d.ultimoEnvio || null, navegador: resumoUa(d.ua) })) }; }
// "Chrome · Android" / "Safari · iPhone" a partir do user-agent, só pra tela administrativa
function resumoUa(ua) { ua = String(ua || ''); if (!ua) return null; const so = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'outro'; const nav = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'navegador'; return nav + ' · ' + so; }

// Cadastro único de vendedores (26/10): dois números são a mesma pessoa quando o cadastro diz (número corrigido ou unido fica
// em `antigos`), então a conta criada com o número antigo continua vendo as cotações/pedidos que já trazem o número novo
function mesmaPessoa(w1, w2) {
  if (!w1 || !w2) return false; if (w1 === w2) return true;
  const reg = deps.vendedores && deps.vendedores.porWhats; if (!reg) return false;
  const a = reg(w1); return !!a && a === reg(w2);
}
// conta do portal de um número, passando pelo cadastro (número atual ou antigo do mesmo vendedor)
function contaPorWhats(w) {
  w = normWhats(w); if (!w) return null; if (V[w]) return V[w];
  const r = deps.vendedores && deps.vendedores.porWhats ? deps.vendedores.porWhats(w) : null; if (!r) return null;
  for (const k of [r.whats].concat(r.antigos || [])) if (k && V[k] && !V[k].teste) return V[k];
  return null;
}
// visão da conta pro cadastro único (tela Vendedores): tem PIN, quando entrou, aparelhos, app instalado
function contaDe(w) { const v = contaPorWhats(w); if (!v || v.teste) return null; return { whats: v.whats, tem_pin: !!v.senha, pinEm: v.senhaEm || null, criadoEm: v.criadoEm || null, ultimoAcesso: v.ultimoAcesso || null, instalado: !!v.instalado, dispositivos: (v.dispositivos || []).length, nome: v.nome || null, email: v.email || null, empresas: v.empresas || [] }; }
function contas() { return Object.values(V || {}).filter(v => !v.teste).map(v => ({ nome: v.nome || null, whats: v.whats, email: v.email || null, empresas: v.empresas || [] })); }
// conta nova / login: entra no cadastro único (só preenche o que o cadastro ainda não tem)
function registrarNoCadastro(v) { if (!(deps.vendedores && deps.vendedores.registrar) || !v || v.teste) return; try { const e = (v.empresas || [])[0] || {}; deps.vendedores.registrar({ nome: v.nome, whats: v.whats, email: v.email, codFornec: e.codFornec, empresa: e.nome }, 'portal'); } catch (err) { log('cadastro de vendedores:', err.message); } }
// o cadastro único corrigiu o número (ou uniu dois registros): a conta segue a pessoa — re-chaveada sem perder PIN, sessão,
// aparelhos e avisos; se já existia conta no número novo, fica a que tem PIN e os aparelhos somam
function atualizarVendedor(antigo, dados) {
  antigo = normWhats(antigo); const novo = normWhats(dados && dados.whats);
  const v = antigo ? V[antigo] : null; if (!v) return { conta: false };
  let rechaveada = false, juntada = false;
  if (novo && novo !== antigo) {
    const alvo = V[novo];
    if (alvo) {
      const fica = (alvo.senha || !v.senha) ? alvo : v, sai = fica === alvo ? v : alvo;
      fica.dispositivos = (fica.dispositivos || []).concat((sai.dispositivos || []).filter(d => !(fica.dispositivos || []).some(x => x.endpoint === d.endpoint))).slice(-5);
      for (const e of (sai.empresas || [])) if (!(fica.empresas || []).some(x => x.codFornec === e.codFornec)) (fica.empresas = fica.empresas || []).push(e);
      if (!fica.email && sai.email) fica.email = sai.email; if (!fica.nome && sai.nome) fica.nome = sai.nome;
      if (!fica.instalado && sai.instalado) fica.instalado = sai.instalado;
      if (!fica.ultimoAcesso || (sai.ultimoAcesso && sai.ultimoAcesso > fica.ultimoAcesso)) fica.ultimoAcesso = sai.ultimoAcesso || fica.ultimoAcesso;
      V[novo] = fica; juntada = true;
    } else V[novo] = v;
    delete V[antigo]; V[novo].id = novo; V[novo].whats = novo; rechaveada = true;
    // ids nos avisos E nos recibos seguem a pessoa (revisão 10/11: A.recibos ficava de fora e o recibo que chegava depois da correção do
    // número saía com entreguePor = número cru); conta juntada pode repetir o id → sem duplicata
    const troca = arr => [...new Set(arr.map(x => x === antigo ? novo : x))];
    for (const reg of Object.values(A.cotacoes || {})) for (const a of Object.values(reg || {})) if (a && Array.isArray(a.vendedores)) a.vendedores = troca(a.vendedores);
    for (const a of Object.values(A.pedidos || {})) if (a && Array.isArray(a.vendedores)) a.vendedores = troca(a.vendedores);
    for (const r of Object.values(A.recibos || {})) if (r && Array.isArray(r.vendedores)) r.vendedores = troca(r.vendedores);
    salvarA();
  }
  const c = V[novo || antigo]; if (dados && dados.nome) c.nome = dados.nome; if (dados && dados.email) c.email = dados.email; salvarV();
  log('conta', antigo, rechaveada ? '-> ' + novo : 'atualizada', juntada ? '(juntada com a conta que já existia no número novo)' : '');
  return { conta: true, rechaveada, juntada, whats: c.whats };
}
// vendedores da cotação/pedido que "são" este vendedor do portal
function fornecedorEhDoVendedor(f, v) {
  if (!f || !v || v.teste) return false;
  const vends = [f.vendedor].concat(f.vendedores || []).filter(Boolean);
  const ws = vends.map(x => normWhats(x.whats)).filter(Boolean);
  if (ws.length) return !!v.whats && ws.some(w => mesmaPessoa(w, v.whats));
  // fornecedor sem WhatsApp cadastrado: vale o e-mail do vendedor (o e-mail da empresa pode ser o mesmo pra vários
  // vendedores, por isso ele só conta quando não tem WhatsApp pra desempatar)
  const es = vends.map(x => normEmail(x.email)).filter(Boolean);
  if (es.length) return !!v.email && es.includes(normEmail(v.email));
  // sem WhatsApp nem e-mail: vale a empresa (todos os vendedores dela recebem o mesmo link)
  const cod = f.codFornecErp || f.codFornec;
  return !!cod && (v.empresas || []).some(e => e.codFornec === cod);
}
function vendedoresDoFornecedor(f) { return Object.values(V).filter(v => fornecedorEhDoVendedor(f, v)); }
function pedidoEhDoVendedor(p, v) {
  if (!p || !v || v.teste) return false;
  const w = normWhats(p.vendedor && p.vendedor.whats);
  if (w) return !!v.whats && mesmaPessoa(w, v.whats);
  const e = normEmail(p.vendedor && p.vendedor.email);
  if (e) return !!v.email && normEmail(v.email) === e;
  return !!p.codFornec && (v.empresas || []).some(x => x.codFornec === p.codFornec);
}

// ── convite (público, por token da cotação ou do pedido): quem é o vendedor daquele link, pra pré-preencher a conta ──
function fonte(tipo, token) {
  if (!ehToken(token)) return null;
  if (tipo === 'pedido') {
    const p = deps.pedidosFornec && deps.pedidosFornec.porToken(token); if (!p) return null;
    return { tipo, id: p.id, nome: p.lista_nome, fornecedor: p.fornecedor, codFornecErp: p.codFornec || null, vendedores: [p.vendedor].filter(x => x && (x.nome || x.whats)), status: p.status };
  }
  const r = deps.cotacao && deps.cotacao.porToken(token); if (!r) return null;
  const { c, f } = r;
  return { tipo: 'cotacao', id: c.id, nome: c.nome, fornecedor: f.empresa || f.nome, codFornecErp: f.codFornecErp || f.codFornec, vendedores: [f.vendedor].concat(f.vendedores || []).filter(x => x && (x.nome || x.whats)), status: c.status };
}
// O link da cotação é o segredo do próprio vendedor (foi mandado no WhatsApp dele), então aqui vai o WhatsApp e o
// e-mail inteiros: a tela "Criar meu login" preenche nome/WhatsApp/e-mail com isso.
function convite(tipo, token) {
  const s = fonte(tipo, token); if (!s) return null;
  return { tipo: s.tipo, id: s.id, nome: s.nome, fornecedor: s.fornecedor, exige_login: exigeLogin(), vendedores: s.vendedores.map((x, idx) => { const w = normWhats(x.whats), v = w ? contaPorWhats(w) : null; return { idx, nome: x.nome || null, whats: w || null, email: x.email || null, ja_no_portal: !!v, tem_pin: !!(v && v.senha) }; }) };
}
// vendedor que entrou pelo link de uma cotação/pedido fica ligado àquela empresa (vale pro casamento sem WhatsApp/e-mail)
function ligarEmpresa(v, de) {
  if (!de || !de.token) return false;
  const s = fonte(de.tipo === 'pedido' ? 'pedido' : 'cotacao', de.token); if (!s || !s.codFornecErp) return false;
  // link repassado de OUTRO vendedor não pode pendurar a empresa dele nesta conta (15/10: Lucila da Karne Keijo virou "BRF"):
  // só liga se o WhatsApp (ou, sem WhatsApp, o e-mail) do link é o desta conta; link sem vendedor identificado liga a empresa
  const ws = (s.vendedores || []).map(x => normWhats(x.whats)).filter(Boolean), es = (s.vendedores || []).map(x => normEmail(x.email)).filter(Boolean);
  if (ws.length && !(v.whats && ws.includes(v.whats))) return false;
  if (!ws.length && es.length && !(v.email && es.includes(normEmail(v.email)))) return false;
  v.empresas = v.empresas || [];
  if (v.empresas.some(e => e.codFornec === s.codFornecErp)) return false;
  v.empresas.push({ codFornec: s.codFornecErp, nome: s.fornecedor }); return true;
}
function marcarAcesso(v, ua) { v.ultimoAcesso = agoraISO(); if (ua) v.ultimoUa = String(ua).slice(0, 200); }

// ── conta: criar login (WhatsApp + PIN), entrar, trocar PIN (público) ─────────
function criarConta({ nome, whats, email, pin, de, ua }) {
  nome = String(nome || '').trim().slice(0, 80); const w = normWhats(whats), e = normEmail(email);
  if (nome.length < 2) return { erro: 'Informe seu nome' };
  if (!w) return { erro: 'WhatsApp inválido: use DDD + número, ex. 81 99999-0000' };
  if (!emailOk(e)) return { erro: 'Informe um e-mail válido' };
  const pi = pinInvalido(pin); if (pi) return { erro: pi };
  let v = V[w];
  if (v && v.senha) return { erro: 'Este WhatsApp já tem login no portal. Entre com o número e o PIN, ou peça pro(a) comprador(a) da Econômico redefinir o PIN.' };
  // e-mail pode repetir: vários vendedores da mesma empresa usam o e-mail da empresa (o login é o WhatsApp)
  if (!v) { v = V[w] = { id: w, nome, whats: w, email: e, token: novoToken(), empresas: [], dispositivos: [], criadoEm: agoraISO() }; log('conta nova', w, nome); }
  else { v.nome = nome; v.email = e; if (!v.token) v.token = novoToken(); log('conta criada num vendedor que já existia (entrou pelo "Sou eu" antes do login)', w, nome); }
  v.senha = hashSenha(String(pin).trim()); v.senhaEm = agoraISO(); v.pin_claro = String(pin).trim();   // em claro só pra tela administrativa (Tiago, 15/10)
  ligarEmpresa(v, de); marcarAcesso(v, ua); salvarV(); registrarNoCadastro(v);
  return { vt: v.token, vendedor: visaoPublica(v) };
}
function entrar({ whats, pin, de, ua }) {
  const w = normWhats(whats); if (!w) return { erro: 'Informe seu WhatsApp com DDD, ex. 81 99999-0000' };
  if (!pin) return { erro: 'Informe o PIN' };
  if (bloqueado(w)) return { erro: 'Muitas tentativas erradas. Espere 10 minutos ou peça pro(a) comprador(a) da Econômico redefinir seu PIN.', bloqueado: true };
  const v = V[w];
  if (!v || !v.senha || !confereSenha(String(pin).trim(), v.senha)) { errou(w); return { erro: 'WhatsApp ou PIN não conferem' }; }
  acertou(w); v.pin_claro = String(pin).trim();   // quem criou o PIN antes de 15/10 passa a aparecer na tela administrativa no próximo login
  if (!v.token) v.token = novoToken();
  ligarEmpresa(v, de); marcarAcesso(v, ua); salvarV(); registrarNoCadastro(v);
  return { vt: v.token, vendedor: visaoPublica(v) };
}
// vendedor logado troca o PIN; quem entrou pelo "Sou eu" (antes do login existir) ainda não tem PIN e cria aqui
function trocarPin(vt, { pin_atual, pin_novo, email }) {
  const v = vendedorPorToken(vt); if (!v) return { erro: 'Sessão inválida' };
  const pi = pinInvalido(pin_novo); if (pi) return { erro: pi };
  if (!v.senha) { const e = normEmail(email || v.email); if (!emailOk(e)) return { erro: 'Informe um e-mail válido' }; v.email = e; }   // "Sou eu" antigo: completa o cadastro
  if (v.senha && !(pin_atual && confereSenha(String(pin_atual).trim(), v.senha))) return { erro: 'PIN atual não confere' };
  v.senha = hashSenha(String(pin_novo).trim()); v.senhaEm = agoraISO(); v.pin_claro = String(pin_novo).trim(); salvarV();
  return { ok: true, vendedor: visaoPublica(v) };
}
function tocar(v) { v.ultimoAcesso = agoraISO(); salvarV(); }
// abriu pelo app instalado (ícone na tela inicial): v.instalado = { desde, em, ua } — painel mostra quem tem e quem não tem (Tiago, 15/10)
function marcarInstalado(vt, ua) {
  const v = vendedorPorToken(vt); if (!v) return null;
  const agora = agoraISO(), antes = v.instalado && v.instalado.em;
  v.instalado = { desde: (v.instalado && v.instalado.desde) || agora, em: agora, ua: String(ua || '').slice(0, 200) };
  if (!antes || Date.now() - new Date(antes).getTime() > 60 * 60 * 1000) salvarV();   // grava no máximo 1x por hora
  return v.instalado;
}

// ── push ────────────────────────────────────────────────────────────────────
function inscrever(vt, sub, ua) {
  const v = vendedorPorToken(vt); if (!v) return { erro: 'Sessão do portal inválida: entre de novo com WhatsApp e PIN' };
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { erro: 'Inscrição de push incompleta' };
  v.dispositivos = (v.dispositivos || []).filter(d => d.endpoint !== sub.endpoint);
  v.dispositivos.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, expirationTime: sub.expirationTime || null, ua: String(ua || '').slice(0, 200), criadoEm: agoraISO() });
  if (v.dispositivos.length > 5) v.dispositivos = v.dispositivos.slice(-5);
  v.ultimoAcesso = agoraISO(); salvarV();
  return { ok: true, dispositivos: v.dispositivos.length };
}
function desinscrever(vt, endpoint) {
  const v = vendedorPorToken(vt); if (!v) return { erro: 'Sessão inválida' };
  const n = (v.dispositivos || []).length; v.dispositivos = (v.dispositivos || []).filter(d => d.endpoint !== endpoint); salvarV();
  return { ok: true, removidos: n - v.dispositivos.length };
}
function desconectarTodos(vendedorId) { const v = V[vendedorId]; if (!v) return null; v.dispositivos = []; v.token = novoToken(); salvarV(); return visaoPublica(v); }
// "Excluir vendedor" no cadastro único (Tiago, 10/11/26): a conta do portal vai junto, inteira (PIN, sessão, aparelhos inscritos).
// TODAS as contas da pessoa (revisão 10/11): o número pedido mais, pelo cadastro, o número atual e os antigos — a troca de número feita
// pela página da cotação (corrigirPorCopia, semPortal) deixa a conta antiga chaveada pelo número antigo e o vendedor pode ter criado outra
// com o novo; apagando só uma, a outra continuava entrando com PIN. Conta de outra pessoa nunca entra (só chaves do mesmo registro do
// cadastro). Chamado por lib/vendedores.js via deps.portal.apagarConta(whats). Devolve ids = chaves apagadas e mantidas = contas
// que ficaram: um número que sobrou em `antigos` pode ser hoje de OUTRA pessoa (ela criou login nele e o cadastro ainda o atribui ao
// excluído) — só sai a conta que parece ser da mesma pessoa (nome ou e-mail igual ao da conta do número pedido / do cadastro) (revisão 3, 10/11).
function apagarConta(whats) {
  const w = normWhats(whats); if (!w) return { ok: true, apagada: false };
  const r = deps.vendedores && deps.vendedores.porWhats ? deps.vendedores.porWhats(w) : null;
  // mesma pessoa = mesmo e-mail, ou mesmo nome / mesmo primeiro nome (no portal ele digita "Carlos", na lista está "Carlos Menezes");
  // sem nome nem e-mail de referência (conta no número atual não existe e o cadastro veio sem nome), confia no cadastro
  const chaveN = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const primeiro = s => chaveN(s).split(' ')[0] || '';
  const refNomes = [V[w] && V[w].nome, r && r.nome].map(chaveN).filter(Boolean), refEmails = [V[w] && V[w].email, r && r.email].filter(Boolean).map(e => String(e).trim().toLowerCase());
  const mesmaPessoa = k => { if (k === w) return true; if (!refNomes.length && !refEmails.length) return true; const n = chaveN(V[k].nome), p = primeiro(V[k].nome), e = String(V[k].email || '').trim().toLowerCase(); return refNomes.some(x => x === n || (!!p && x.split(' ')[0] === p)) || (!!e && refEmails.includes(e)); };
  const todas = [...new Set([w].concat(r ? [r.whats].concat(r.antigos || []) : []).map(normWhats))].filter(k => k && V[k] && !V[k].teste);
  const chaves = todas.filter(mesmaPessoa), mantidas = todas.filter(k => !mesmaPessoa(k));
  if (mantidas.length) log('conta mantida (parece ser de outra pessoa):', mantidas.map(k => k + '=' + (V[k].nome || '')).join(', '));
  const extra = mantidas.length ? { mantidas } : {};
  if (!chaves.length) return { ok: true, apagada: false, ...extra };
  const nome = chaves.map(k => V[k].nome).find(Boolean) || null;
  for (const k of chaves) { acertou(k); delete V[k]; }
  salvarV();
  log('conta apagada', chaves.join(', '), nome || '');
  return { ok: true, apagada: true, id: chaves[0], nome, ids: chaves, ...extra };
}

// manda um aviso pra todos os aparelhos do vendedor; aparelho que sumiu (404/410) é apagado
async function enviarPush(v, payload, ttl) {
  if (!webpush) return { ok: 0, falhas: 0, erro: webpushErro || 'push indisponível' };
  const corpo = JSON.stringify(payload); let ok = 0, falhas = 0, removidos = 0; const erros = [];
  for (const d of (v.dispositivos || []).slice()) {
    try { await webpush.sendNotification({ endpoint: d.endpoint, keys: d.keys }, corpo, { TTL: ttl || TTL_NOVA, urgency: 'high' }); ok++; d.ultimoEnvio = agoraISO(); }
    catch (e) {
      falhas++; erros.push((e.statusCode || '') + ' ' + (e.body || e.message || '').slice(0, 120));
      if (e.statusCode === 404 || e.statusCode === 410) { v.dispositivos = v.dispositivos.filter(x => x.endpoint !== d.endpoint); removidos++; }
    }
  }
  if (ok || removidos) salvarV();
  return { ok, falhas, removidos, erro: erros.length ? erros.join(' · ') : null };
}
const fmtR = n => 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
function prazoTxt(p) { const n = deps.cotacao && deps.cotacao.normPrazo ? deps.cotacao.normPrazo(p) : null; if (!n) return ''; const d = new Date(n); return DIAS[d.getDay()] + ' ' + n.slice(8, 10) + '/' + n.slice(5, 7) + ' às ' + n.slice(11, 16); }

async function testarPush(vt) {
  const v = vendedorPorToken(vt); if (!v) return { erro: 'Sessão inválida' };
  const rid = novoRid();
  const r = await enviarPush(v, { title: 'Avisos ativados ✓', body: 'Você vai receber as próximas cotações da Econômico aqui.', url: '/fornecedor/', tag: 'teste', rid }, 600);
  if (r.ok) novoRecibo(rid, 'teste', { vendedores: [v.id] });
  fimEnvio(rid, r.ok);   // recibo do 1º aparelho que chegou durante o envio pro 2º (revisão 10/11)
  if (r.ok) salvarA();
  return { ...r, ok: r.ok > 0, enviados: r.ok, rid: r.ok ? rid : null };
}

// pedido já realizado com a proposta deste fornecedor (28/10/26): a página dele está travada, não há o que digitar nem enviar
const pedidoRealizado = (c, f) => { const p = (c.pedidos || []).find(x => +x.codFornec === +f.codFornec); if (p) return p.id || 0; const pp = (c.prePedidos || {})[f.codFornec]; return pp && pp.status === 'realizado' ? (pp.pedidoId || 0) : null; };
// Texto do aviso da cotação por situação (Tiago, 09/11/26: "reenviar aviso no app tem que escolher qual enviar"): 'nova' = convite
// (quem nem abriu o link), 'sem_preco' = abriu o link e não digitou nada, 'nao_enviou' = digitou preço e não tocou em Enviar,
// 'reaberta' = reabriu a proposta e ainda não reenviou. motivoDe() lê a situação REAL do fornecedor na hora do envio (revisão 09/11:
// a tela monta os grupos de um estado de até 30 s atrás; se o vendedor abriu o link ou digitou nesse meio tempo, o texto sairia errado).
const itensTxt = n => n + (n === 1 ? ' item' : ' itens');
const cotadosDe = (c, f) => (c.itens || []).filter(i => f.precos && f.precos[i.cod] && f.precos[i.cod].preco > 0).length;
function motivoDe(c, f) {
  if (f.reabertoEm && f.status === 'digitacao') return 'reaberta';
  if (cotadosDe(c, f) > 0) return 'nao_enviou';
  return f.abertoEm ? 'sem_preco' : 'nova';
}
function payloadCotacao(c, f, motivo) {
  // tag por fornecedor: aviso novo do MESMO fornecedor substitui o anterior no celular; vendedor com 2 empresas na mesma cotação vê os dois
  const n = (c.itens || []).length, prazo = c.prazo ? ' · prazo ' + prazoTxt(c.prazo) : '', url = '/fornecedor/cotacao/' + f.token, tag = 'cot-' + c.id + '-' + f.codFornec;
  if (motivo === 'reaberta' || (f.reabertoEm && f.status === 'digitacao')) {   // reabriu a proposta e ainda não reenviou: vale mais que o motivo pedido
    const cotados = cotadosDe(c, f);
    return { title: 'Proposta reaberta · Cotação #' + c.id + ' · ' + c.nome, body: 'Você reabriu a proposta e ainda não enviou de novo.' + (cotados > 0 ? ' ' + cotados + ' preço(s) salvos.' : '') + (c.prazo ? ' Envie até ' + prazoTxt(c.prazo) + '.' : ' Toque em Enviar proposta.'), url, tag };
  }
  if (motivo === 'nao_enviou') {
    const cotados = cotadosDe(c, f), faltam = n - cotados;
    return { title: 'Falta enviar · Cotação #' + c.id + ' · ' + c.nome, body: 'Você digitou ' + cotados + ' preço(s), mas não tocou em Enviar proposta.' + (faltam === 1 ? ' Falta 1 item sem preço.' : faltam > 1 ? ' Faltam ' + faltam + ' itens sem preço.' : '') + (c.prazo ? ' Envie até ' + prazoTxt(c.prazo) + '.' : ' Toque pra enviar.'), url, tag };
  }
  if (motivo === 'sem_preco') return { title: 'Sem preços · Cotação #' + c.id + ' · ' + c.nome, body: 'Você abriu a cotação, mas ainda não digitou nenhum preço. ' + itensTxt(n) + prazo + '. Toque pra digitar.', url, tag };
  return { title: 'Nova cotação #' + c.id + ' · ' + c.nome, body: itensTxt(n) + prazo + '. Toque pra digitar seus preços.', url, tag };
}
// nova cotação (ou fornecedor adicionado depois): avisa cada fornecedor que tem vendedor com app; marca enviadoEm.
// Reenvio pelo Acompanhamento ("Avisar vendedores"): codFornecs escolhidos na tela; o texto sai da situação de cada um AGORA (motivoDe).
async function avisarNovaCotacao(c, { reenvio = false, soNaoAbriram = false, codFornecs = null } = {}) {
  const out = { cotacao: c.id, avisados: 0, semApp: 0, falhas: 0, detalhes: [] };
  if (!c || c.status !== 'aberta') return out;
  // prazo encerrado: a página do vendedor recusa preço, então "toque pra digitar" só confunde (o(a) comprador(a) libera o prazo antes)
  if (deps.cotacao && deps.cotacao.prazoVencido && deps.cotacao.prazoVencido(c)) { out.prazoVencido = true; return out; }
  const reg = A.cotacoes[c.id] = A.cotacoes[c.id] || {};
  for (const f of c.fornecedores || []) {
    if (codFornecs && !codFornecs.includes(f.codFornec)) continue;
    if (f.status === 'finalizado' || pedidoRealizado(c, f) != null) continue;   // pedido já saiu com a proposta dele: nada a digitar (28/10/26)
    if (soNaoAbriram && f.abertoEm) continue;
    const ja = reg[f.codFornec];
    if (ja && ja.avisadoEm && !reenvio) continue;
    const vs = vendedoresDoFornecedor(f).filter(comApp);
    if (!vs.length) { out.semApp++; continue; }
    const motivo = motivoDe(c, f), rid = novoRid(), payload = { ...payloadCotacao(c, f, motivo), rid };   // rid: recibo de entrega (ver registrarRecibo)
    let ok = 0, erro = null; const inicio = agoraISO();   // avisadoEm = começo do envio: o recibo do 1º aparelho pode chegar antes do laço acabar
    for (const v of vs) { const r = await enviarPush(v, payload, TTL_NOVA); ok += r.ok; if (r.erro) erro = r.erro; }
    if (ok) {
      novoRecibo(rid, 'cotacao', { cid: c.id, codFornec: f.codFornec, vendedores: vs.map(v => v.id) });
      // o histórico do fornecedor (entregue/abriu/lembrete) fica; rid = último envio, rids = últimos 10 (recibo atrasado de um reenvio anterior ainda casa)
      reg[f.codFornec] = { ...(ja || {}), avisadoEm: inicio, vendedores: vs.map(v => v.id), reenvios: ja ? (ja.reenvios || 0) + (ja.avisadoEm ? 1 : 0) : 0, lembreteEm: ja ? ja.lembreteEm || null : null, motivo, rid, rids: ((ja && ja.rids) || []).concat(rid).slice(-10) };
      out.avisados++; out.detalhes.push({ codFornec: f.codFornec, fornecedor: f.nome, vendedores: vs.map(v => v.nome || v.whats), ok });
      if (!f.enviadoEm && deps.cotacao && deps.cotacao.marcarEnviado) { try { deps.cotacao.marcarEnviado(c.id, f.codFornec); f.enviadoEm = agoraISO(); } catch (e) { log('marcarEnviado', e.message); } }
    } else { out.falhas++; out.detalhes.push({ codFornec: f.codFornec, fornecedor: f.nome, erro: erro || 'nenhum aparelho recebeu' }); }
    fimEnvio(rid, ok);   // recibo que chegou durante o laço (revisão 10/11): só agora o registro com o rid existe
  }
  salvarA();
  if (out.avisados || out.falhas) log('cotação', c.id, 'avisados', out.avisados, 'sem app', out.semApp, 'falhas', out.falhas);
  return out;
}

// lembrete 2 h antes do prazo pra quem ainda não enviou a proposta (1 por fornecedor por cotação)
async function lembretesPrazo(agora = Date.now()) {
  const out = { enviados: 0 };
  if (!deps.cotacao) return out;
  for (const c of deps.cotacao.listar()) {
    if (c.status !== 'aberta' || !c.prazo) continue;
    const n = deps.cotacao.normPrazo(c.prazo); if (!n) continue;
    const resta = new Date(n).getTime() - agora;
    if (resta <= 0 || resta > LEMBRETE_MS) continue;
    const reg = A.cotacoes[c.id] = A.cotacoes[c.id] || {};
    for (const f of c.fornecedores || []) {
      if (f.status === 'finalizado' || pedidoRealizado(c, f) != null) continue;   // com pedido realizado a página dele está travada: cobrar envio não tem saída (28/10/26)
      const ja = reg[f.codFornec]; if (ja && ja.lembreteEm) continue;
      const vs = vendedoresDoFornecedor(f).filter(comApp); if (!vs.length) continue;
      const faltam = (c.itens || []).filter(i => !(f.precos && f.precos[i.cod] && f.precos[i.cod].preco > 0)).length;
      const min = Math.round(resta / 60000), tempo = min >= 60 ? Math.floor(min / 60) + ' h' + (min % 60 ? ' e ' + (min % 60) + ' min' : '') : min + ' min';
      const rid = novoRid(), payload = { title: 'Prazo acaba em ' + tempo + ' · Cotação #' + c.id, body: (faltam === 1 ? 'Falta 1 item sem preço. ' : faltam ? 'Faltam ' + faltam + ' itens sem preço. ' : '') + 'Envie a proposta até ' + n.slice(11, 16) + '.', url: '/fornecedor/cotacao/' + f.token, tag: 'cot-' + c.id + '-prazo', rid };
      let ok = 0; const inicio = agoraISO(); for (const v of vs) { const r = await enviarPush(v, payload, TTL_LEMBRETE); ok += r.ok; }
      if (ok) novoRecibo(rid, 'lembrete', { cid: c.id, codFornec: f.codFornec, vendedores: vs.map(v => v.id) });
      reg[f.codFornec] = { ...(ja || { avisadoEm: null, vendedores: vs.map(v => v.id), reenvios: 0 }), lembreteEm: inicio, lembreteOk: ok, lembreteRid: ok ? rid : null };
      fimEnvio(rid, ok);   // recibo que chegou durante o laço (revisão 10/11)
      if (ok) out.enviados++;
    }
  }
  if (out.enviados) { salvarA(); log('lembretes de prazo', out.enviados); }
  return out;
}

// pedido gerado (cotação fechada / pré-pedido realizado / "Enviar pro fornecedor" no Radar)
// Pedido APROVADO pela Econômico: aviso no app de quem responde por ele (uma vez por pedido). O pedido aparece no portal em
// "Pedidos fechados", com o PDF. Não substitui o WhatsApp com o PDF da tela de aprovação; é o aviso que não depende dele.
async function avisarPedidoAprovado(p) {
  const out = { pedido: p && p.id, avisados: 0 };
  if (!p || !p.token || p.status !== 'aprovado') return out;
  const ja = A.pedidos[p.id] || {};
  if (ja.aprovadoAvisadoEm) return out;
  const vs = Object.values(V).filter(v => pedidoEhDoVendedor(p, v)).filter(comApp);
  if (!vs.length) return out;
  const total = p.totais && (p.totais.digitado || p.totais.total);
  const rid = novoRid(), payload = { title: 'Pedido #' + p.id + ' aprovado · ' + (p.lista_nome || p.fornecedor || ''), body: 'A Econômico aprovou o pedido: ' + (p.itens || []).length + ' itens' + (total ? ' · ' + fmtR(total) : '') + '. Abra pra ver o PDF e a entrega por loja.', url: '/fornecedor/pedido/' + p.token, tag: 'ped-' + p.id, rid };
  let ok = 0; for (const v of vs) { const r = await enviarPush(v, payload, TTL_PEDIDO); ok += r.ok; }
  if (ok) novoRecibo(rid, 'pedido', { pid: p.id, codFornec: p.codFornec || null, vendedores: vs.map(v => v.id) });
  A.pedidos[p.id] = { ...ja, aprovadoAvisadoEm: agoraISO(), aprovadoPush: ok, rids: ok ? (ja.rids || []).concat(rid).slice(-10) : ja.rids || [] };
  fimEnvio(rid, ok); salvarA();
  out.avisados = ok; log('pedido', p.id, 'APROVADO: aviso em', ok, 'aparelho(s)');
  return out;
}
async function avisarPedido(p, extra = {}) {
  const out = { pedido: p && p.id, avisados: 0 };
  if (!p || !p.token) return out;
  if (A.pedidos[p.id] && A.pedidos[p.id].avisadoEm && !extra.reenvio) return out;
  // Regra (Tiago, 15/10): o pedido vai direto pro portal de cada vendedor — push pra quem tem aparelho e, pra todo vendedor com
  // login, o pedido fica marcado "enviado pelo portal" (ele vê em Pedidos no app, sem precisar do WhatsApp)
  const todos = Object.values(V).filter(v => pedidoEhDoVendedor(p, v)), comLogin = todos.filter(v => v.senha), vs = todos.filter(comApp);
  if (!vs.length && !comLogin.length) return out;
  const total = p.totais && (p.totais.digitado || p.totais.total);
  const ent = p.cotacao && p.cotacao.entrega ? ' · entrega ' + String(p.cotacao.entrega).slice(0, 10).split('-').reverse().join('/') : '';
  const rid = novoRid(), payload = { title: 'Pedido #' + p.id + ' · ' + (p.lista_nome || p.fornecedor || '') , body: (p.itens || []).length + ' itens' + (total ? ' · ' + fmtR(total) : '') + ent + '. Abra pra ver o PDF e confirmar.', url: '/fornecedor/pedido/' + p.token, tag: 'ped-' + p.id, rid };
  let ok = 0; const inicio = agoraISO(); for (const v of vs) { const r = await enviarPush(v, payload, TTL_PEDIDO); ok += r.ok; }
  const quem = (comLogin.length ? comLogin : vs), ja = A.pedidos[p.id] || {};
  if (ok) novoRecibo(rid, 'pedido', { pid: p.id, codFornec: p.codFornec || null, vendedores: vs.map(v => v.id) });
  // entregue/abriu do envio anterior ficam; rid só muda quando algum aparelho aceitou este envio
  A.pedidos[p.id] = { ...ja, avisadoEm: inicio, vendedores: quem.map(v => v.id), push: ok, portal: comLogin.length, rid: ok ? rid : ja.rid || null, rids: ok ? (ja.rids || []).concat(rid).slice(-10) : ja.rids || [] };
  fimEnvio(rid, ok);   // recibo que chegou durante o laço (revisão 10/11)
  salvarA();
  if (deps.pedidosFornec && deps.pedidosFornec.marcarPortal) { try { deps.pedidosFornec.marcarPortal(p.id, { em: agoraISO(), vendedores: quem.map(v => v.nome || v.whats), push: ok }); } catch (e) { log('marcarPortal', p.id, e.message); } }
  out.avisados = ok; out.portal = comLogin.length; log('pedido', p.id, 'no portal de', comLogin.length, 'vendedor(es), aviso em', ok, 'aparelho(s)');
  return out;
}

// ── recibo de entrega do aviso no app (Tiago, 10/11/26: "a mensagem precisa chegar; saber se chegou") ──────────────────
// "avisadoEm" só diz que o Google/Apple aceitou a mensagem (web-push 201): o Acompanhamento mostrava "avisado · 4 reenvio(s)" e o
// vendedor nunca abriu, sem jeito de saber se o celular chegou a mostrar o aviso. Agora cada envio por fornecedor leva um `rid`
// (id do recibo) no JSON do push e o sw.js devolve POST /api/portal/recibo { rid, ev } quando a notificação aparece ('recebido')
// e quando o vendedor toca nela ('abriu'). Um rid por fornecedor-envio: todos os aparelhos/vendedores daquele fornecedor naquele
// disparo compartilham (os ids ficam no recibo). A.recibos[rid] vive 7 dias (podado a cada recibo novo; o rid que ainda é o envio atual de
// algum aviso fica, pra o toque tardio na notificação ainda marcar). Só vale a partir do sw.js
// novo no celular: ele troca quando o vendedor abre uma página do portal de novo (ou no próximo push, quando o Chrome checa atualização).
// Corrida do recibo (revisão 10/11, achados 4/25): o rid vai no payload antes do laço de envio, mas A.recibos[rid] e o registro com o rid só
// nascem DEPOIS do laço; enquanto o servidor espera o 201 do 2º aparelho/vendedor do mesmo fornecedor, o 1º celular já mostrou o aviso e
// postou o recibo → ele caía como 'desconhecido' e se perdia. CEDO guarda, por rid em envio, o que o celular mandou antes da hora; fimEnvio()
// aplica depois que o registro foi gravado. Só rid gerado por novoRid() entra (quem chuta rid não ocupa memória); TTL de 5 min e teto de
// 200 limpam envio que morreu no meio.
const CEDO = new Map(); const CEDO_MS = 5 * 60 * 1000, CEDO_MAX = 200;
function novoRid() {
  const rid = crypto.randomBytes(16).toString('hex'), agora = Date.now();
  for (const [r, e] of CEDO) if (agora - e.desde > CEDO_MS) CEDO.delete(r);
  while (CEDO.size >= CEDO_MAX) CEDO.delete(CEDO.keys().next().value);
  CEDO.set(rid, { desde: agora, recebidoEm: null, abriuEm: null });
  return rid;
}
// fim de um envio (o registro com o rid já está gravado): com algum aparelho aceitando, aplica os recibos que chegaram cedo, com a hora em que
// chegaram; sem nenhum aparelho, só esquece o rid
function fimEnvio(rid, ok) {
  const e = CEDO.get(rid); CEDO.delete(rid); if (!e || !ok) return 0;
  let n = 0;
  if (e.recebidoEm) { aplicarRecibo(rid, 'recebido', e.recebidoEm); n++; }
  if (e.abriuEm) { aplicarRecibo(rid, 'abriu', e.abriuEm); n++; }
  if (n) log('recibo chegou antes do envio terminar; aplicado', rid.slice(0, 8));
  return n;
}
const ehRid = r => /^[0-9a-f]{32}$/.test(String(r || ''));
// rids que algum registro ainda aponta como o envio atual (aviso da cotação, lembrete, pedido): a poda não os apaga (revisão 10/11, achado 7:
// a notificação do pedido fica na bandeja do Android até o toque; tocada 8 dias depois, o rid tinha sumido e nada era marcado)
function ridsEmUso() {
  const s = new Set();
  for (const reg of Object.values(A.cotacoes || {})) for (const a of Object.values(reg || {})) { if (a && a.rid) s.add(a.rid); if (a && a.lembreteRid) s.add(a.lembreteRid); }
  for (const a of Object.values(A.pedidos || {})) if (a && a.rid) s.add(a.rid);
  return s;
}
function podarRecibos(agora = Date.now()) { const uso = ridsEmUso(); let n = 0; for (const [rid, r] of Object.entries(A.recibos || {})) { if (uso.has(rid)) continue; const em = r && r.em ? new Date(r.em).getTime() : 0; if (!em || agora - em > RECIBO_MS) { delete A.recibos[rid]; n++; } } return n; }
// grava o recibo de um envio que algum aparelho aceitou (quem chama já pôs o rid no payload e grava o avisos.json depois)
function novoRecibo(rid, tipo, { cid = null, codFornec = null, pid = null, vendedores = [] } = {}) {
  if (!A.recibos) A.recibos = {}; podarRecibos();
  A.recibos[rid] = { tipo, cid, codFornec, pid, vendedores: vendedores.slice(), em: agoraISO() };
  return rid;
}
// nome do vendedor pelo id; id que o cadastro único já trocou (conta re-chaveada ou apagada) passa pelo cadastro antes de cair no número cru
const nomeDe = id => { const v = V[id] || contaPorWhats(id); return (v && (v.nome || v.whats)) || id; };
// quem recebeu: só quando o recibo é de 1 vendedor (com 2 vendedores no mesmo fornecedor não dá pra saber qual celular mostrou)
const entreguePorDe = rec => ((rec && rec.vendedores) || []).length === 1 ? nomeDe(rec.vendedores[0]) : null;
// posição do envio em reg.rids (últimos 10): recibo de um envio mais antigo nunca rebaixa um mais novo já marcado (revisão 10/11, achado 6:
// com 3 envios, o recibo do 2º e depois o atrasado do 1º voltavam entregueRid pro 1º); rid fora da lista conta como o mais antigo
const posRid = (reg, rid) => (reg.rids || []).indexOf(rid);
// marca "entregue" no registro (aviso da cotação ou pedido): fica a 1ª confirmação de cada envio; recibo atrasado de um envio ANTERIOR não
// rebaixa um envio mais novo já confirmado (dois pushes chegam juntos quando o celular volta e os recibos podem vir fora de ordem)
function marcarEntregue(reg, rid, rec, agora) {
  if (reg.entregueRid === rid) return false;
  if (reg.rid && reg.entregueRid === reg.rid && rid !== reg.rid) return false;
  if (reg.entregueRid && posRid(reg, rid) < posRid(reg, reg.entregueRid)) return false;
  reg.entregueEm = agora; reg.entregueRid = rid; reg.entreguePor = entreguePorDe(rec); return true;
}
// marca "tocou" (abriuEm = hora do toque, abriuRid = em qual envio): 2º toque no mesmo envio (outro aparelho, tocou de novo) não regrava e
// toque atrasado num envio anterior não rebaixa (revisão 10/11, achados 5 e 6). O Acompanhamento compara abriuRid com rid (abriu_ultimo).
function marcarAbriu(reg, rid, agora) {
  if (reg.abriuRid === rid) return false;
  if (reg.abriuRid && posRid(reg, rid) < posRid(reg, reg.abriuRid)) return false;
  reg.abriuEm = agora; reg.abriuRid = rid; return true;
}
// POST /api/portal/recibo { rid, ev }: ev 'recebido' (a notificação apareceu) | 'abriu' (o vendedor tocou nela; também prova que apareceu).
// rid inválido não faz nada; rid de um envio ainda em curso fica guardado (CEDO) e vale quando o envio termina; rid desconhecido não faz
// nada (a rota responde 204 do mesmo jeito).
function registrarRecibo(rid, ev) {
  rid = String(rid || ''); ev = String(ev || '');
  if (!ehRid(rid) || !['recebido', 'abriu'].includes(ev)) return { ok: false, motivo: 'inválido' };
  return aplicarRecibo(rid, ev, agoraISO());
}
function aplicarRecibo(rid, ev, agora) {
  const rec = A.recibos && A.recibos[rid];
  if (!rec) {
    const e = CEDO.get(rid); if (!e) return { ok: false, motivo: 'desconhecido' };
    if (!e.recebidoEm) e.recebidoEm = agora; if (ev === 'abriu' && !e.abriuEm) e.abriuEm = agora;
    return { ok: false, motivo: 'cedo' };
  }
  let mudou = false;
  if (!rec.entregueEm) { rec.entregueEm = agora; mudou = true; }
  if (ev === 'abriu' && !rec.abriuEm) { rec.abriuEm = agora; mudou = true; }
  if (rec.tipo === 'cotacao' || rec.tipo === 'lembrete') {
    const reg = (A.cotacoes[rec.cid] || {})[rec.codFornec];
    if (reg && rec.tipo === 'cotacao') {
      if (marcarEntregue(reg, rid, rec, agora)) mudou = true;
      if (ev === 'abriu' && marcarAbriu(reg, rid, agora)) mudou = true;
    } else if (reg && reg.lembreteEm && reg.lembreteRid === rid) {   // só o disparo atual conta aqui (lembrete que falhou em todo aparelho fica com lembreteRid null e nenhum recibo pode confirmá-lo; revisão 3, 10/11)
      if (!reg.lembreteEntregueEm) { reg.lembreteEntregueEm = agora; mudou = true; }
      if (ev === 'abriu' && !reg.lembreteAbriuEm) { reg.lembreteAbriuEm = agora; reg.abriuEm = agora; mudou = true; }   // 1º toque no lembrete = abriu um aviso desta cotação
    } else if (reg) {   // lembrete zerado por mudança de prazo (revisão 10/11, achado 23): o recibo atrasado ainda completa a linha do histórico
      const h = (reg.lembretesAnteriores || []).find(x => x && x.rid === rid);
      if (h) { if (!h.entregueEm) { h.entregueEm = agora; mudou = true; } if (ev === 'abriu' && !h.abriuEm) { h.abriuEm = agora; mudou = true; } }
    }
  } else if (rec.tipo === 'pedido') {
    const reg = A.pedidos[rec.pid];
    if (reg) { if (marcarEntregue(reg, rid, rec, agora)) mudou = true; if (ev === 'abriu' && marcarAbriu(reg, rid, agora)) mudou = true; }
  }
  if (mudou) { salvarA(); log('recibo', ev, rec.tipo, rec.tipo === 'pedido' ? '#' + rec.pid : 'cotação ' + rec.cid + ' fornec. ' + rec.codFornec, (rec.vendedores || []).map(nomeDe).join(', ')); }
  return { ok: true, tipo: rec.tipo, ev, mudou };
}
// o prazo da cotação mudou: zera o lembrete de 2 h antes de todos os fornecedores, pra ele disparar de novo com o prazo novo (o server.js
// chama na rota que muda o prazo, só quando o prazo realmente mudou). O lembrete já mandado não some: fica em lembretesAnteriores (últimos 5)
// e avisosRecentes o mostra marcado "prazo mudou depois" (revisão 10/11, achado 23). Idempotente: sem lembrete pra zerar, limpos 0 e nada gravado.
function resetLembrete(cotId) {
  const reg = (A.cotacoes || {})[cotId] || {}; let limpos = 0; const agora = agoraISO();
  for (const a of Object.values(reg)) {
    if (!a || (a.lembreteEm == null && a.lembreteOk == null && a.lembreteEntregueEm == null && a.lembreteRid == null && a.lembreteAbriuEm == null)) continue;
    if (a.lembreteEm) a.lembretesAnteriores = (a.lembretesAnteriores || []).concat([{ em: a.lembreteEm, ok: a.lembreteOk == null ? null : a.lembreteOk, entregueEm: a.lembreteEntregueEm || null, abriuEm: a.lembreteAbriuEm || null, rid: a.lembreteRid || null, prazoMudouEm: agora }]).slice(-5);
    a.lembreteEm = null; a.lembreteOk = null; a.lembreteEntregueEm = null; a.lembreteRid = null; a.lembreteAbriuEm = null; limpos++;
  }
  if (limpos) salvarA();
  return { ok: true, limpos };
}

// O último envio do aviso foi confirmado? (revisão 10/11, contrato com o Acompanhamento — achados 5 e 14)
//   entregue_ultimo   = o celular mostrou o ÚLTIMO envio (recibo 'recebido' ou 'abriu' daquele rid)
//   abriu_ultimo      = tocou no último envio OU num lembrete de prazo disparado depois dele
//   lembrete_ultimo   = um lembrete disparado depois do último envio foi confirmado
//   confirmado_ultimo = qualquer dos três: o celular provou que recebe push depois do último envio (coluna Canal e caixa 📲→💬 usam este)
// abriuEm continua sendo a hora do último toque de qualquer envio: a tela mostra "tocou no aviso anterior" quando abriu_ultimo é false.
function flagsDe(a) {
  if (!a) return { entregue_ultimo: false, abriu_ultimo: false, lembrete_ultimo: false, confirmado_ultimo: false };
  const lembDepois = !!(a.lembreteEm && (!a.avisadoEm || a.lembreteEm >= a.avisadoEm));
  const entregue_ultimo = !!(a.rid && a.entregueRid === a.rid);
  const abriu_ultimo = !!((a.rid && a.abriuRid === a.rid) || (lembDepois && a.lembreteAbriuEm));
  const lembrete_ultimo = !!(lembDepois && a.lembreteEntregueEm);
  return { entregue_ultimo, abriu_ultimo, lembrete_ultimo, confirmado_ultimo: entregue_ultimo || abriu_ultimo || lembrete_ultimo };
}
// canal de cada fornecedor da cotação (vai no cotDetalhe do Acompanhamento)
function canalDe(c, f) {
  const a = (A.cotacoes[c.id] || {})[f.codFornec] || null;
  const vs = vendedoresDoFornecedor(f), app = vs.filter(comApp).map(v => ({ id: v.id, nome: v.nome || v.whats }));
  // no portal = algum vendedor deste fornecedor criou login (WhatsApp + PIN), mesmo sem avisos ativos (Tiago, 15/10: "quem está no portal e quem não está")
  const portal = vs.filter(v => v.senha).map(v => ({ id: v.id, nome: v.nome || v.whats }));
  return {
    canal: app.length ? 'app' : 'whatsapp', app, portal, no_portal: portal.length > 0, avisadoEm: (a && a.avisadoEm) || null, reenvios: a ? a.reenvios || 0 : 0, lembreteEm: (a && a.lembreteEm) || null,
    // recibo do app (10/11): entregueEm = a notificação apareceu num celular; entreguePor = nome, quando o recibo é de 1 vendedor; abriuEm = hora do
    // último toque (de qualquer envio). entregue_ultimo / abriu_ultimo / lembrete_ultimo / confirmado_ultimo valem pro ÚLTIMO envio (reenvio zera até
    // chegar recibo novo — ver flagsDe). Aviso de antes do recibo sai null/false.
    entregueEm: (a && a.entregueEm) || null, ...flagsDe(a), entreguePor: (a && a.entreguePor) || null, abriuEm: (a && a.abriuEm) || null, lembreteEntregueEm: (a && a.lembreteEntregueEm) || null
  };
}
function resumoCanais(c) { const cs = (c.fornecedores || []).map(f => canalDe(c, f)); return { app: cs.filter(x => x.canal === 'app').length, whatsapp: cs.filter(x => x.canal === 'whatsapp').length, no_portal: cs.filter(x => x.no_portal).length, sem_portal: cs.filter(x => !x.no_portal).length, avisados: cs.filter(x => x.avisadoEm).length, exigeLogin: exigeLogin() }; }

// ── tela inicial do vendedor ────────────────────────────────────────────────
function resumoVendedor(vt) {
  const v = vendedorPorToken(vt); if (!v) return null;
  tocar(v);
  const abertas = [], resultados = [];
  const cots = deps.cotacao ? deps.cotacao.listar() : [];
  for (const c of cots) {
    if (c.status === 'cancelada' || c.teste) continue;
    for (const f of c.fornecedores || []) {
      if (!fornecedorEhDoVendedor(f, v)) continue;
      const cotados = (c.itens || []).filter(i => f.precos && f.precos[i.cod] && f.precos[i.cod].preco > 0).length;
      const base = { id: c.id, nome: c.nome, lista: c.lista || null, status: c.status, prazo: deps.cotacao.normPrazo(c.prazo), prazo_vencido: deps.cotacao.prazoVencido(c), criadoEm: c.criadoEm, token: f.token, link: '/fornecedor/cotacao/' + f.token, fornecedor: f.empresa || f.nome, itens: (c.itens || []).length, cotados, f_status: f.status, pedido_realizado: pedidoRealizado(c, f), finalizadoEm: f.finalizadoEm || null, abertoEm: f.abertoEm || null, comprador: c.comprador ? { nome: c.comprador.nome || null, whats: c.comprador.whats || null } : null };
      if (c.status === 'aberta') abertas.push(base);
      else if (resultados.length < 12) {
        let venc = null; try { const cp = deps.cotacao.comparativo(c); const x = cp.fornecedores.find(y => y.codFornec === f.codFornec); if (x) venc = { itens: x.itens_vencedor || 0, total: x.total_vencedor || 0, pedidoId: x.pedidoId || null }; } catch (e) { /* comparativo antigo */ }
        // PDF do pedido gerado nesta cotação, direto no card (Tiago, 15/10: "cotações fechadas: só traz o PDF do pedido")
        if (venc && venc.pedidoId && deps.pedidosFornec) { try { const pd = deps.pedidosFornec.obter(venc.pedidoId); if (pd && pd.token) { venc.pdf = '/fornecedor/pedido/' + pd.token + '/pdf'; venc.entrega = (pd.cotacao && pd.cotacao.entrega) || null; venc.status = pd.status || null; } } catch (e) { /* sem pdf */ } }
        resultados.push({ ...base, venceu: venc });
      }
    }
  }
  abertas.sort((a, b) => String(a.prazo || '9').localeCompare(String(b.prazo || '9')));
  const pendentes = [], historico = [];
  const peds = deps.pedidosFornec ? deps.pedidosFornec.listar() : [];
  for (const p of peds) {
    // pedido de teste não aparece pra ninguém; o de ENSAIO DO ROBÔ aparece só pra conta do WhatsApp posto nele (o do Tiago), nunca pro vendedor real
    if ((p.teste && !(p.ensaio && p.vendedor && p.vendedor.whats)) || !pedidoEhDoVendedor(p, v)) continue;
    if (['sugestao', 'analise', 'cancelado', 'excluido'].includes(p.status)) continue;   // ainda não foi mandado pro vendedor / cancelado / excluído
    if (p.cotacao && p.cotacao.id) continue;   // pedido de cotação fica na aba Cotações, como PDF no card da cotação fechada (Tiago, 15/10)
    if (p.usar_ultimo_custo && p.status === 'finalizado' && !p.enviadoEm) continue;   // fechado pelo(a) comprador(a) com o último custo, nunca foi mandado ao vendedor: só aparece depois de aprovado (13/11)
    const item = { id: p.id, lista_nome: p.lista_nome, fornecedor: p.fornecedor, status: p.status, criadoEm: p.criadoEm, enviadoEm: p.enviadoEm || null, finalizadoEm: p.finalizadoEm || null, aprovadoEm: p.aprovadoEm || null, itens: (p.itens || []).length, lojas: p.lojas || [], total: p.totais ? (p.totais.digitado || p.totais.total || null) : null, token: p.token, link: '/fornecedor/pedido/' + p.token, pdf: '/fornecedor/pedido/' + p.token + '/pdf', cotacao: p.cotacao ? { id: p.cotacao.id, nome: p.cotacao.nome, entrega: p.cotacao.entrega || null } : null };
    if (['aguardando', 'digitacao'].includes(p.status)) pendentes.push(item); else if (historico.length < 20) historico.push(item);
  }
  // cadastro do fornecedor nas listas (condição, entrega, pedido mínimo, e-mail) — o que o vendedor já preencheu
  let cadastro = null;
  try {
    const todos = deps.lerCotForn ? deps.lerCotForn() : {}; const cods = new Set((v.empresas || []).map(e => e.codFornec));
    for (const [lista, arr] of Object.entries(todos)) {
      if (!Array.isArray(arr)) continue;
      for (const cad of arr) {
        if (!cods.has(cad.codFornec)) continue;
        const vend = [cad.vendedor].concat(cad.vendedores || []).find(x => x && normWhats(x.whats) === v.whats) || null;
        if (!cadastro) cadastro = { fornecedor: cad.nome, condicao: cad.condicao || null, prazo_entrega: cad.prazo_entrega ?? null, faturamento_minimo: cad.faturamento_minimo ?? null, email: (vend && vend.email) || v.email || null, listas: [] };
        if (!cadastro.condicao && cad.condicao) cadastro.condicao = cad.condicao;
        if (cadastro.prazo_entrega == null && cad.prazo_entrega != null) cadastro.prazo_entrega = cad.prazo_entrega;
        if (cadastro.faturamento_minimo == null && cad.faturamento_minimo != null) cadastro.faturamento_minimo = cad.faturamento_minimo;
        if (!cadastro.email && vend && vend.email) cadastro.email = vend.email;
        cadastro.listas.push(parseInt(lista) || lista);
      }
    }
  } catch (e) { log('cadastro', e.message); }
  return { vendedor: visaoPublica(v), cotacoes_abertas: abertas, resultados, pedidos_pendentes: pendentes, pedidos_historico: historico, cadastro, push: { disponivel: !!webpush, chave: chavePublica(), dispositivos: (v.dispositivos || []).length } };
}

// comprador(a) redefine o PIN de quem esqueceu (ou de quem criou conta na tarde do e-mail+senha); manda o novo pelo WhatsApp
function definirPin(vendedorId, { pin }) {
  const v = V[vendedorId]; if (!v) return { erro: 'Vendedor não encontrado' };
  const pi = pinInvalido(pin); if (pi) return { erro: pi };
  v.senha = hashSenha(String(pin).trim()); v.senhaEm = agoraISO(); v.senhaPor = 'comprador(a)'; v.pin_claro = String(pin).trim(); if (v.whats) acertou(v.whats); salvarV();
  return { ok: true, vendedor: visaoPublica(v) };
}
async function testarPushVendedor(vendedorId) {
  const v = V[vendedorId]; if (!v) return { erro: 'Vendedor não encontrado' };
  if (v.teste) return { ok: true, simulado: true, enviados: (v.dispositivos || []).length, falhas: 0, removidos: 0 };
  if (!(v.dispositivos || []).length) return { erro: 'Este vendedor não tem aparelho inscrito' };
  const rid = novoRid();
  const r = await enviarPush(v, { title: 'Teste do Portal do Fornecedor', body: 'Aviso de teste mandado pela Econômico. Se chegou, está tudo certo.', url: '/fornecedor/', tag: 'teste', rid }, 600);
  if (r.ok) novoRecibo(rid, 'teste', { vendedores: [v.id] });
  fimEnvio(rid, r.ok);   // recibo do 1º aparelho que chegou durante o envio pro 2º (revisão 10/11)
  if (r.ok) salvarA();
  return { ...r, ok: r.ok > 0, enviados: r.ok, rid: r.ok ? rid : null };
}
// últimos avisos mandados (cotações e pedidos), pra tela administrativa
function avisosRecentes(n = 30) {
  const out = [];
  for (const [cid, reg] of Object.entries(A.cotacoes || {})) {
    const c = deps.cotacao && deps.cotacao.obter(parseInt(cid));
    for (const [cod, a] of Object.entries(reg)) {
      const f = c && (c.fornecedores || []).find(x => x.codFornec === parseInt(cod));
      const base = { id: parseInt(cid), nome: c ? c.nome : null, fornecedor: f ? f.nome : 'cód. ' + cod, vendedores: (a.vendedores || []).map(nomeDe), abriu: (f && f.abertoEm) || null, respondeu: (f && f.finalizadoEm) || null, teste: !!(c && c.teste) };
      // entregueEm / abriuEm = recibo do app (10/11): a notificação apareceu no celular / o vendedor tocou nela; null sem recibo.
      // entregue_ultimo / abriu_ultimo / entreguePor (revisão 10/11, achado 24): valem pro ÚLTIMO envio — a linha é do reenvio e entregueEm/abriuEm
      // podem ser do envio anterior; a tela só escreve "chegou"/"tocou" com o flag (mesmo critério do canalDe do Acompanhamento)
      if (a.avisadoEm) { const fl = flagsDe(a); out.push({ tipo: 'cotacao', motivo: a.motivo || 'nova', em: a.avisadoEm, ...base, reenvios: a.reenvios || 0, entregueEm: a.entregueEm || null, abriuEm: a.abriuEm || null, entregue_ultimo: fl.entregue_ultimo, abriu_ultimo: fl.abriu_ultimo, confirmado_ultimo: fl.confirmado_ultimo, entreguePor: a.entreguePor || null }); }
      if (a.lembreteEm) out.push({ tipo: 'lembrete', em: a.lembreteEm, ...base, reenvios: 0, entregueEm: a.lembreteEntregueEm || null, abriuEm: a.lembreteAbriuEm || null, entregue_ultimo: !!a.lembreteEntregueEm, abriu_ultimo: !!a.lembreteAbriuEm, entreguePor: a.lembreteEntregueEm ? entreguePorDe(A.recibos[a.lembreteRid]) : null, prazo_mudou: false });
      // lembretes zerados por mudança de prazo (achado 23) continuam no histórico, marcados: a tela escreve "(prazo mudou depois)"
      for (const h of a.lembretesAnteriores || []) if (h && h.em) out.push({ tipo: 'lembrete', em: h.em, ...base, reenvios: 0, entregueEm: h.entregueEm || null, abriuEm: h.abriuEm || null, entregue_ultimo: !!h.entregueEm, abriu_ultimo: !!h.abriuEm, entreguePor: h.entregueEm ? entreguePorDe(A.recibos[h.rid]) : null, prazo_mudou: true, prazo_mudou_em: h.prazoMudouEm || null });
    }
  }
  for (const [pid, a] of Object.entries(A.pedidos || {})) {
    const p = deps.pedidosFornec && deps.pedidosFornec.obter(parseInt(pid));
    out.push({ tipo: 'pedido', em: a.avisadoEm, id: parseInt(pid), nome: p ? p.lista_nome : null, fornecedor: p ? p.fornecedor : null, vendedores: (a.vendedores || []).map(nomeDe), reenvios: 0, abriu: (p && p.abertoEm) || null, respondeu: (p && p.finalizadoEm) || null, teste: !!(p && p.teste), entregueEm: a.entregueEm || null, abriuEm: a.abriuEm || null, entregue_ultimo: !!(a.rid && a.entregueRid === a.rid), abriu_ultimo: !!(a.rid && a.abriuRid === a.rid), entreguePor: a.entreguePor || null });
  }
  return out.sort((a, b) => String(b.em).localeCompare(String(a.em))).slice(0, n);
}
// empresas de um WhatsApp pelo cadastro das listas (lerCotForn) e das cotações — fonte da verdade da coluna "Fornecedor(es)"
function empresasDoWhats(w) {
  const m = {}; w = normWhats(w); if (!w) return [];
  const bate = (x) => x && normWhats(x.whats) === w;
  try { const todos = deps.lerCotForn ? deps.lerCotForn() : {}; for (const arr of Object.values(todos || {})) { if (!Array.isArray(arr)) continue; for (const cad of arr) if ([cad.vendedor].concat(cad.vendedores || []).some(bate) && cad.codFornec) m[cad.codFornec] = m[cad.codFornec] || { codFornec: +cad.codFornec, nome: cad.nome }; } } catch (e) { log('empresasDoWhats listas:', e.message); }
  try { for (const c of (deps.cotacao ? deps.cotacao.listar() : [])) { if (c.teste) continue; for (const f of c.fornecedores || []) { const cod = f.codFornecErp || f.codFornec; if (cod && [f.vendedor].concat(f.vendedores || []).some(bate)) m[cod] = m[cod] || { codFornec: +cod, nome: f.empresa || f.nome }; } } } catch (e) { log('empresasDoWhats cotações:', e.message); }
  return Object.values(m);
}
// ao subir: empresa de cada conta = a do cadastro (pelo WhatsApp); o que veio pendurado por link só fica quando o cadastro
// não conhece o número (Tiago, 15/10: "verifica tudo")
let SYNC_EMP = null;
function sincronizarEmpresas() {
  let corrigidos = 0, semCadastro = 0;
  for (const v of Object.values(V)) {
    if (v.teste || !v.whats) continue;
    const emp = empresasDoWhats(v.whats);
    if (!emp.length) { semCadastro++; continue; }
    const antes = JSON.stringify((v.empresas || []).map(e => +e.codFornec).sort()), depois = JSON.stringify(emp.map(e => e.codFornec).sort());
    if (antes !== depois) { v.empresas = emp; corrigidos++; }
  }
  if (corrigidos) salvarV();
  SYNC_EMP = { em: agoraISO(), corrigidos, semCadastro };
  log('empresas sincronizadas pelo cadastro:', corrigidos, 'corrigida(s),', semCadastro, 'número(s) fora do cadastro');
  return SYNC_EMP;
}
// vendedores conhecidos (cadastro das listas + cotações) que ainda NÃO criaram login — pra o(a) comprador(a) convidar pelo
// WhatsApp (Tiago, 15/10). Chave = WhatsApp normalizado; quem entrou pelo "Sou eu" antigo sem PIN também aparece, marcado.
// Com o cadastro único (26/10): fora do portal = vendedor do cadastro (com WhatsApp) cuja conta não tem PIN. Traz também quem
// "parece ser" outro registro (mesmo nome / número com um dígito trocado), pra o(a) comprador(a) unir em vez de convidar de novo.
function foraDoPortalCadastro() {
  const todos = deps.vendedores.listar().filter(v => v.ativo !== false && !v.teste);
  const sus = deps.vendedores.suspeitos ? deps.vendedores.suspeitos() : [];
  const porId = Object.fromEntries(todos.map(v => [v.id, v]));
  const noPortal = v => { const c = v && v.whats ? contaPorWhats(v.whats) : null; return !!(c && c.senha); };
  return todos.filter(v => v.whats && !noPortal(v)).map(v => {
    const s = sus.find(p => p.a === v.id || p.b === v.id); const outro = s ? porId[s.a === v.id ? s.b : s.a] : null;
    return { id: v.id, whats: v.whats, nome: v.nome, email: v.email, empresas: [v.empresa].concat((v.outras_empresas || []).map(e => e.nome)).filter(Boolean), listas: v.listas || [], cotacoes: v.cotacoes || [], sem_pin: !!contaPorWhats(v.whats), parecido: outro ? { id: outro.id, nome: outro.nome, whats: outro.whats, no_portal: noPortal(outro), motivo: s.motivo } : null };
  }).sort((a, b) => String(a.empresas[0] || '').localeCompare(String(b.empresas[0] || ''), 'pt-BR') || String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
}
function foraDoPortal() {
  if (deps.vendedores && deps.vendedores.listar) { try { return foraDoPortalCadastro(); } catch (e) { log('fora do portal (cadastro):', e.message); } }
  const m = {};
  const add = (x, emp, lista, cot) => {
    const w = normWhats(x && x.whats); if (!w) return; if (V[w] && V[w].senha) return;
    const r = m[w] = m[w] || { whats: w, nome: null, email: null, empresas: [], listas: [], cotacoes: [], sem_pin: !!V[w] };
    if (!r.nome && x.nome) r.nome = String(x.nome).trim(); if (!r.email && x.email) r.email = String(x.email).trim();
    if (emp && !r.empresas.includes(emp)) r.empresas.push(emp); if (lista && !r.listas.includes(lista)) r.listas.push(lista);
    if (cot && !r.cotacoes.some(c => c.id === cot.id)) r.cotacoes.push(cot);
  };
  try { const todos = deps.lerCotForn ? deps.lerCotForn() : {}; for (const [lista, arr] of Object.entries(todos || {})) { if (!Array.isArray(arr)) continue; for (const cad of arr) for (const x of [cad.vendedor].concat(cad.vendedores || [])) add(x, cad.nome, parseInt(lista) || lista, null); } } catch (e) { log('fora do portal (listas):', e.message); }
  try { for (const c of (deps.cotacao ? deps.cotacao.listar() : [])) { if (c.teste) continue; for (const f of c.fornecedores || []) for (const x of [f.vendedor].concat(f.vendedores || [])) add(x, f.empresa || f.nome, null, { id: c.id, nome: c.nome, status: c.status, criadoEm: c.criadoEm }); } } catch (e) { log('fora do portal (cotações):', e.message); }
  return Object.values(m).map(r => ({ ...r, cotacoes: r.cotacoes.sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm))).slice(0, 3) }))
    .sort((a, b) => String(a.empresas[0] || '').localeCompare(String(b.empresas[0] || ''), 'pt-BR') || String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
}
// lista administrativa (Acompanhamento / diagnóstico): quem tem o portal
function listarVendedores() { return Object.values(V).map(v => ({ ...visaoPublica(v), pin: v.pin_claro || null })).sort((a, b) => String(b.ultimoAcesso || '').localeCompare(String(a.ultimoAcesso || ''))); }

// ── rotas (públicas em /api/portal/*; administrativas em /api/portal-admin/*, atrás do login) ────────────────
function registrarRotas(app) {
  const vtDe = req => String((req.body && req.body.vt) || req.query.vt || req.get('x-portal-vt') || '').trim();
  app.get('/api/portal/convite/:tipo/:token', (req, res) => {
    const c = convite(req.params.tipo === 'pedido' ? 'pedido' : 'cotacao', req.params.token);
    if (!c) return res.status(404).json({ error: 'Link não encontrado' });
    res.json(c);
  });
  const deDe = b => (b && b.de && typeof b.de === 'object') ? { tipo: b.de.tipo, token: String(b.de.token || '') } : null;
  app.post('/api/portal/conta/criar', (req, res) => {
    const b = req.body || {};
    const r = criarConta({ nome: b.nome, whats: b.whats, email: b.email, pin: b.pin, de: deDe(b), ua: req.get('user-agent') });
    if (r.erro) return res.status(400).json({ error: r.erro });
    res.json(r);
  });
  app.post('/api/portal/conta/entrar', (req, res) => {
    const b = req.body || {};
    const r = entrar({ whats: b.whats, pin: b.pin, de: deDe(b), ua: req.get('user-agent') });
    if (r.erro) return res.status(r.bloqueado ? 429 : 400).json({ error: r.erro });
    res.json(r);
  });
  app.post('/api/portal/conta/pin', (req, res) => {
    const b = req.body || {};
    const r = trocarPin(vtDe(req), { pin_atual: b.pin_atual, pin_novo: b.pin_novo, email: b.email });
    if (r.erro) return res.status(400).json({ error: r.erro });
    res.json(r);
  });
  app.post('/api/portal/instalado', (req, res) => { const r = marcarInstalado(vtDe(req), req.get('user-agent')); if (!r) return res.status(401).json({ error: 'Sessão inválida' }); res.json({ ok: true, instalado: r }); });
  app.get('/api/portal/eu', (req, res) => {
    if (req.query.app === '1') marcarInstalado(vtDe(req), req.get('user-agent'));   // abriu pelo app instalado
    const r = resumoVendedor(vtDe(req));
    if (!r) return res.status(401).json({ error: 'Sessão do portal inválida: entre de novo com seu WhatsApp e PIN' });
    res.set('Cache-Control', 'no-store'); res.json(r);
  });
  app.get('/api/portal/vapid', (req, res) => res.json({ chave: chavePublica(), erro: webpushErro }));
  app.get('/api/portal/config', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ exigeLogin: exigeLogin(), exigeApp: exigeApp() }); });
  // diagnóstico sem login (nada sensível: só contagens)
  // conferir uma conta pelo WhatsApp (token): empresa guardada × empresa do cadastro (15/10, "Lucila está com BRF")
  app.get('/api/portal/_diag-whats', (req, res) => {
    if (req.query.token !== 'diag2026') return res.status(403).end();
    const w = normWhats(req.query.whats), v = w ? V[w] : null;
    res.json({ whats: w, conta: v ? { nome: v.nome, empresas: v.empresas || [], tem_pin: !!v.senha } : null, cadastro: w ? empresasDoWhats(w) : [] });
  });
  app.get('/api/portal/_diag', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ...estado(), testes_restantes: Object.values(V).filter(v => v.teste).length }); });
  app.post('/api/portal/push/inscrever', (req, res) => {
    const r = inscrever(vtDe(req), req.body && req.body.subscription, req.get('user-agent'));
    if (r.erro) return res.status(400).json({ error: r.erro });
    res.json(r);
  });
  app.post('/api/portal/push/sair', (req, res) => {
    const r = desinscrever(vtDe(req), req.body && req.body.endpoint);
    if (r.erro) return res.status(400).json({ error: r.erro });
    res.json(r);
  });
  app.post('/api/portal/push/testar', async (req, res) => {
    try { const r = await testarPush(vtDe(req)); if (r.erro && !r.ok) return res.status(400).json({ error: r.erro }); res.json(r); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // recibo do aviso no app, mandado pelo sw.js sem login (o celular não tem sessão na hora do push): 'recebido' = a notificação apareceu,
  // 'abriu' = o vendedor tocou nela (Tiago, 10/11/26: "a mensagem precisa chegar; saber se chegou"). Sempre 204: rid inválido ou
  // desconhecido não diz nada a quem chuta.
  app.post('/api/portal/recibo', (req, res) => { try { registrarRecibo(req.body && req.body.rid, req.body && req.body.ev); } catch (e) { log('recibo:', e.message); } res.status(204).end(); });
  // administrativas (login do Econômico)
  app.get('/api/portal-admin/estado', (req, res) => res.json({ ...estado(), vendedores_lista: listarVendedores(), avisos: avisosRecentes(40), fora: foraDoPortal() }));
  app.post('/api/portal-admin/vendedores/:id/pin', (req, res) => { const b = req.body || {}; const r = definirPin(req.params.id, { pin: b.pin }); if (r.erro) return res.status(400).json({ error: r.erro }); res.json(r); });
  app.post('/api/portal-admin/config', (req, res) => { const b = req.body || {}, c = {}; if ('exigeLogin' in b) c.exigeLogin = !!b.exigeLogin; if ('exigeApp' in b) c.exigeApp = !!b.exigeApp; res.json(setConfig(c)); });
  app.post('/api/portal-admin/vendedores/:id/desconectar', (req, res) => { const r = desconectarTodos(req.params.id); if (!r) return res.status(404).json({ error: 'Vendedor não encontrado' }); res.json(r); });
  // botão "Testar" da tela administrativa (public/portal-fornecedor.html testar(id)) chamava esta rota, que nunca tinha sido registrada → 404 (achado em 09/11/26)
  app.post('/api/portal-admin/vendedores/:id/testar', async (req, res) => { try { res.json(await testarPushVendedor(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); } });
  // pedidos fechados de uma cotação → portal de cada vendedor (reenvio); usado pelo botão "Mandar todos pro portal" (Tiago, 15/10)
  app.post('/api/portal-admin/cotacoes/:id/avisar-pedidos', async (req, res) => {
    try {
      const c = deps.cotacao.obter(parseInt(req.params.id)); if (!c) return res.status(404).json({ error: 'cotação não encontrada' });
      const out = []; for (const x of (c.pedidos || [])) { const p = deps.pedidosFornec.obter(x.id); if (!p || p.teste) continue; const r = await avisarPedido(p, { reenvio: true }); out.push({ pedido: p.id, fornecedor: p.fornecedor, avisados: r.avisados || 0, portal: r.portal || 0, sem_login: !(r.portal || r.avisados) }); }
      res.json({ pedidos: out.length, no_portal: out.filter(x => x.portal).length, avisados: out.reduce((s, x) => s + x.avisados, 0), sem_login: out.filter(x => x.sem_login).length, detalhes: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/portal-admin/cotacoes/:id/avisar', async (req, res) => {
    try {
      const c = deps.cotacao.obter(parseInt(req.params.id)); if (!c) return res.status(404).json({ error: 'cotação não encontrada' });
      // texto por situação de cada fornecedor (nova / sem preço / falta enviar / reaberta), lida no servidor na hora do envio — ver motivoDe
      res.json(await avisarNovaCotacao(c, { reenvio: true, soNaoAbriram: !!(req.body && req.body.soNaoAbriram), codFornecs: req.body && Array.isArray(req.body.codFornecs) ? req.body.codFornecs.map(Number) : null }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { avisarPedidoAprovado, payloadCotacao, motivoDe, init, estado, contaDe, contas, contaPorWhats, mesmaPessoa, atualizarVendedor, chavePublica, normWhats, mascara, convite, criarConta, entrar, trocarPin, definirPin, hashSenha, confereSenha, pinInvalido, vendedorPorToken, vendedorPorEmail, inscrever, desinscrever, desconectarTodos, enviarPush, testarPush, testarPushVendedor, avisosRecentes, avisarNovaCotacao, lembretesPrazo, avisarPedido, registrarRecibo, resetLembrete, apagarConta, canalDe, resumoCanais, resumoVendedor, listarVendedores, foraDoPortal, marcarInstalado, empresasDoWhats, sincronizarEmpresas, registrarRotas, fornecedorEhDoVendedor, pedidoEhDoVendedor, exigeLogin, setConfig, LEMBRETE_MS, TENT_MAX, DIR };
