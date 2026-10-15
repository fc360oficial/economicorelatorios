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

let deps = {};             // { cotacao, pedidosFornec, lerCotForn, log }
let webpush = null, webpushErro = null, vapid = null;
let V = null;              // vendedores { [id = whats]: { id, nome, whats, email (opcional), senha (hash scrypt do PIN; nome do campo ficou da tarde de e-mail+senha), senhaEm, token (sessão), empresas:[{codFornec,nome}], dispositivos:[{endpoint,keys,ua,criadoEm}], criadoEm, ultimoAcesso } }
let CFG = null;            // config.json { exigeLogin } — login obrigatório pra responder cotação (Tiago, 13/10: "quero forçar já agora nessa cotação"); ligado por padrão
let A = null;              // avisos { cotacoes: { [cotId]: { [codFornec]: { avisadoEm, vendedores, reenvios, lembreteEm } } }, pedidos: { [pedId]: { avisadoEm, vendedores } } }

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
  if (!A.cotacoes) A.cotacoes = {}; if (!A.pedidos) A.pedidos = {};
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
  return { webpush: !!webpush, erro: webpushErro, vapid: !!vapid, exigeLogin: exigeLogin(), sync_empresas: SYNC_EMP, vendedores: vs.length, comLogin: vs.filter(v => v.senha).length, comApp: vs.filter(comApp).length, dispositivos: vs.reduce((s, v) => s + (v.dispositivos || []).length, 0) };
}
const chavePublica = () => (vapid && vapid.publicKey) || null;
// login obrigatório pra responder cotação: sem sessão, a página da cotação trava num painel "crie seu login" sem "Agora não"
// (hook.js); desligado, o painel é só um convite que dá pra pular. Pedido do vendedor nunca trava (confirmar entrega é urgente).
const exigeLogin = () => !!(CFG && CFG.exigeLogin);
function setConfig(c) { CFG = Object.assign({ exigeLogin: true }, CFG || {}, c || {}); CFG.exigeLogin = !!CFG.exigeLogin; CFG.alteradoEm = agoraISO(); gravarJson('config.json', CFG); return { exigeLogin: CFG.exigeLogin }; }

// ── vendedores ──────────────────────────────────────────────────────────────
const comApp = v => !!(v && v.dispositivos && v.dispositivos.length);
function vendedorPorToken(vt) { if (!ehToken(vt)) return null; return Object.values(V).find(v => v.token === vt) || null; }
function vendedorPorEmail(email) { const e = normEmail(email); if (!e) return null; return Object.values(V).find(v => normEmail(v.email) === e) || null; }
function visaoPublica(v) { return { id: v.id, nome: v.nome || null, whats: v.whats || null, whats_mascara: mascara(v.whats), email: v.email || null, tem_pin: !!v.senha, pinEm: v.senhaEm || null, empresas: v.empresas || [], dispositivos: (v.dispositivos || []).length, criadoEm: v.criadoEm, ultimoAcesso: v.ultimoAcesso || null, teste: !!v.teste, navegador: resumoUa(v.ultimoUa), aparelhos: (v.dispositivos || []).map(d => ({ criadoEm: d.criadoEm, ultimoEnvio: d.ultimoEnvio || null, navegador: resumoUa(d.ua) })) }; }
// "Chrome · Android" / "Safari · iPhone" a partir do user-agent, só pra tela administrativa
function resumoUa(ua) { ua = String(ua || ''); if (!ua) return null; const so = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'outro'; const nav = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'navegador'; return nav + ' · ' + so; }

// vendedores da cotação/pedido que "são" este vendedor do portal
function fornecedorEhDoVendedor(f, v) {
  if (!f || !v || v.teste) return false;
  const vends = [f.vendedor].concat(f.vendedores || []).filter(Boolean);
  const ws = vends.map(x => normWhats(x.whats)).filter(Boolean);
  if (ws.length) return !!v.whats && ws.includes(v.whats);
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
  if (w) return !!v.whats && v.whats === w;
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
  return { tipo: s.tipo, id: s.id, nome: s.nome, fornecedor: s.fornecedor, exige_login: exigeLogin(), vendedores: s.vendedores.map((x, idx) => { const w = normWhats(x.whats), v = w ? V[w] : null; return { idx, nome: x.nome || null, whats: w || null, email: x.email || null, ja_no_portal: !!v, tem_pin: !!(v && v.senha) }; }) };
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
  ligarEmpresa(v, de); marcarAcesso(v, ua); salvarV();
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
  ligarEmpresa(v, de); marcarAcesso(v, ua); salvarV();
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
  const r = await enviarPush(v, { title: 'Avisos ativados ✓', body: 'Você vai receber as próximas cotações da Econômico aqui.', url: '/fornecedor/', tag: 'teste' }, 600);
  return { ...r, ok: r.ok > 0, enviados: r.ok };
}

// nova cotação (ou fornecedor adicionado depois): avisa cada fornecedor que tem vendedor com app; marca enviadoEm
async function avisarNovaCotacao(c, { reenvio = false, soNaoAbriram = false, codFornecs = null } = {}) {
  const out = { cotacao: c.id, avisados: 0, semApp: 0, falhas: 0, detalhes: [] };
  if (!c || c.status !== 'aberta') return out;
  const reg = A.cotacoes[c.id] = A.cotacoes[c.id] || {};
  for (const f of c.fornecedores || []) {
    if (codFornecs && !codFornecs.includes(f.codFornec)) continue;
    if (f.status === 'finalizado') continue;
    if (soNaoAbriram && f.abertoEm) continue;
    const ja = reg[f.codFornec];
    if (ja && ja.avisadoEm && !reenvio) continue;
    const vs = vendedoresDoFornecedor(f).filter(comApp);
    if (!vs.length) { out.semApp++; continue; }
    const payload = { title: 'Nova cotação #' + c.id + ' · ' + c.nome, body: (c.itens || []).length + ' itens' + (c.prazo ? ' · prazo ' + prazoTxt(c.prazo) : '') + '. Toque pra digitar seus preços.', url: '/fornecedor/cotacao/' + f.token, tag: 'cot-' + c.id };
    let ok = 0, erro = null;
    for (const v of vs) { const r = await enviarPush(v, payload, TTL_NOVA); ok += r.ok; if (r.erro) erro = r.erro; }
    if (ok) {
      reg[f.codFornec] = { avisadoEm: agoraISO(), vendedores: vs.map(v => v.id), reenvios: ja ? (ja.reenvios || 0) + (ja.avisadoEm ? 1 : 0) : 0, lembreteEm: ja ? ja.lembreteEm || null : null };
      out.avisados++; out.detalhes.push({ codFornec: f.codFornec, fornecedor: f.nome, vendedores: vs.map(v => v.nome || v.whats), ok });
      if (!f.enviadoEm && deps.cotacao && deps.cotacao.marcarEnviado) { try { deps.cotacao.marcarEnviado(c.id, f.codFornec); f.enviadoEm = agoraISO(); } catch (e) { log('marcarEnviado', e.message); } }
    } else { out.falhas++; out.detalhes.push({ codFornec: f.codFornec, fornecedor: f.nome, erro: erro || 'nenhum aparelho recebeu' }); }
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
      if (f.status === 'finalizado') continue;
      const ja = reg[f.codFornec]; if (ja && ja.lembreteEm) continue;
      const vs = vendedoresDoFornecedor(f).filter(comApp); if (!vs.length) continue;
      const faltam = (c.itens || []).filter(i => !(f.precos && f.precos[i.cod] && f.precos[i.cod].preco > 0)).length;
      const min = Math.round(resta / 60000), tempo = min >= 60 ? Math.floor(min / 60) + ' h' + (min % 60 ? ' e ' + (min % 60) + ' min' : '') : min + ' min';
      const payload = { title: 'Prazo acaba em ' + tempo + ' · Cotação #' + c.id, body: (faltam ? 'Faltam ' + faltam + ' itens sem preço. ' : '') + 'Envie a proposta até ' + n.slice(11, 16) + '.', url: '/fornecedor/cotacao/' + f.token, tag: 'cot-' + c.id + '-prazo' };
      let ok = 0; for (const v of vs) { const r = await enviarPush(v, payload, TTL_LEMBRETE); ok += r.ok; }
      reg[f.codFornec] = { ...(ja || { avisadoEm: null, vendedores: vs.map(v => v.id), reenvios: 0 }), lembreteEm: agoraISO(), lembreteOk: ok };
      if (ok) out.enviados++;
    }
  }
  if (out.enviados) { salvarA(); log('lembretes de prazo', out.enviados); }
  return out;
}

// pedido gerado (cotação fechada / pré-pedido realizado / "Enviar pro fornecedor" no Radar)
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
  const payload = { title: 'Pedido #' + p.id + ' · ' + (p.lista_nome || p.fornecedor || '') , body: (p.itens || []).length + ' itens' + (total ? ' · ' + fmtR(total) : '') + ent + '. Abra pra ver o PDF e confirmar.', url: '/fornecedor/pedido/' + p.token, tag: 'ped-' + p.id };
  let ok = 0; for (const v of vs) { const r = await enviarPush(v, payload, TTL_PEDIDO); ok += r.ok; }
  const quem = (comLogin.length ? comLogin : vs);
  A.pedidos[p.id] = { avisadoEm: agoraISO(), vendedores: quem.map(v => v.id), push: ok, portal: comLogin.length }; salvarA();
  if (deps.pedidosFornec && deps.pedidosFornec.marcarPortal) { try { deps.pedidosFornec.marcarPortal(p.id, { em: agoraISO(), vendedores: quem.map(v => v.nome || v.whats), push: ok }); } catch (e) { log('marcarPortal', p.id, e.message); } }
  out.avisados = ok; out.portal = comLogin.length; log('pedido', p.id, 'no portal de', comLogin.length, 'vendedor(es), aviso em', ok, 'aparelho(s)');
  return out;
}

// canal de cada fornecedor da cotação (vai no cotDetalhe do Acompanhamento)
function canalDe(c, f) {
  const a = (A.cotacoes[c.id] || {})[f.codFornec] || null;
  const vs = vendedoresDoFornecedor(f), app = vs.filter(comApp).map(v => ({ id: v.id, nome: v.nome || v.whats }));
  // no portal = algum vendedor deste fornecedor criou login (WhatsApp + PIN), mesmo sem avisos ativos (Tiago, 15/10: "quem está no portal e quem não está")
  const portal = vs.filter(v => v.senha).map(v => ({ id: v.id, nome: v.nome || v.whats }));
  return { canal: app.length ? 'app' : 'whatsapp', app, portal, no_portal: portal.length > 0, avisadoEm: a ? a.avisadoEm : null, reenvios: a ? a.reenvios || 0 : 0, lembreteEm: a ? a.lembreteEm : null };
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
      const base = { id: c.id, nome: c.nome, lista: c.lista || null, status: c.status, prazo: deps.cotacao.normPrazo(c.prazo), prazo_vencido: deps.cotacao.prazoVencido(c), criadoEm: c.criadoEm, token: f.token, link: '/fornecedor/cotacao/' + f.token, fornecedor: f.empresa || f.nome, itens: (c.itens || []).length, cotados, f_status: f.status, finalizadoEm: f.finalizadoEm || null, abertoEm: f.abertoEm || null, comprador: c.comprador ? { nome: c.comprador.nome || null, whats: c.comprador.whats || null } : null };
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
    if (p.teste || !pedidoEhDoVendedor(p, v)) continue;
    if (['sugestao', 'analise', 'cancelado', 'excluido'].includes(p.status)) continue;   // ainda não foi mandado pro vendedor / cancelado / excluído
    if (p.cotacao && p.cotacao.id) continue;   // pedido de cotação fica na aba Cotações, como PDF no card da cotação fechada (Tiago, 15/10)
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
  const r = await enviarPush(v, { title: 'Teste do Portal do Fornecedor', body: 'Aviso de teste mandado pela Econômico. Se chegou, está tudo certo.', url: '/fornecedor/', tag: 'teste' }, 600);
  return { ...r, ok: r.ok > 0, enviados: r.ok };
}
// últimos avisos mandados (cotações e pedidos), pra tela administrativa
function avisosRecentes(n = 30) {
  const out = [];
  for (const [cid, reg] of Object.entries(A.cotacoes || {})) {
    const c = deps.cotacao && deps.cotacao.obter(parseInt(cid));
    for (const [cod, a] of Object.entries(reg)) {
      const f = c && (c.fornecedores || []).find(x => x.codFornec === parseInt(cod));
      const vends = (a.vendedores || []).map(id => (V[id] && (V[id].nome || V[id].whats)) || id);
      if (a.avisadoEm) out.push({ tipo: 'cotacao', em: a.avisadoEm, id: parseInt(cid), nome: c ? c.nome : null, fornecedor: f ? f.nome : 'cód. ' + cod, vendedores: vends, reenvios: a.reenvios || 0, abriu: f ? f.abertoEm : null, respondeu: f ? f.finalizadoEm : null, teste: !!(c && c.teste) });
      if (a.lembreteEm) out.push({ tipo: 'lembrete', em: a.lembreteEm, id: parseInt(cid), nome: c ? c.nome : null, fornecedor: f ? f.nome : 'cód. ' + cod, vendedores: vends, reenvios: 0, abriu: f ? f.abertoEm : null, respondeu: f ? f.finalizadoEm : null, teste: !!(c && c.teste) });
    }
  }
  for (const [pid, a] of Object.entries(A.pedidos || {})) {
    const p = deps.pedidosFornec && deps.pedidosFornec.obter(parseInt(pid));
    out.push({ tipo: 'pedido', em: a.avisadoEm, id: parseInt(pid), nome: p ? p.lista_nome : null, fornecedor: p ? p.fornecedor : null, vendedores: (a.vendedores || []).map(id => (V[id] && (V[id].nome || V[id].whats)) || id), reenvios: 0, abriu: p ? p.abertoEm : null, respondeu: p ? p.finalizadoEm : null, teste: !!(p && p.teste) });
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
function foraDoPortal() {
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
  app.get('/api/portal/eu', (req, res) => {
    const r = resumoVendedor(vtDe(req));
    if (!r) return res.status(401).json({ error: 'Sessão do portal inválida: entre de novo com seu WhatsApp e PIN' });
    res.set('Cache-Control', 'no-store'); res.json(r);
  });
  app.get('/api/portal/vapid', (req, res) => res.json({ chave: chavePublica(), erro: webpushErro }));
  app.get('/api/portal/config', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ exigeLogin: exigeLogin() }); });
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
  // administrativas (login do Econômico)
  app.get('/api/portal-admin/estado', (req, res) => res.json({ ...estado(), vendedores_lista: listarVendedores(), avisos: avisosRecentes(40), fora: foraDoPortal() }));
  app.post('/api/portal-admin/vendedores/:id/pin', (req, res) => { const b = req.body || {}; const r = definirPin(req.params.id, { pin: b.pin }); if (r.erro) return res.status(400).json({ error: r.erro }); res.json(r); });
  app.post('/api/portal-admin/config', (req, res) => res.json(setConfig({ exigeLogin: !!(req.body && req.body.exigeLogin) })));
  app.post('/api/portal-admin/vendedores/:id/desconectar', (req, res) => { const r = desconectarTodos(req.params.id); if (!r) return res.status(404).json({ error: 'Vendedor não encontrado' }); res.json(r); });
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
      res.json(await avisarNovaCotacao(c, { reenvio: true, soNaoAbriram: !!(req.body && req.body.soNaoAbriram), codFornecs: req.body && Array.isArray(req.body.codFornecs) ? req.body.codFornecs.map(Number) : null }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { init, estado, chavePublica, normWhats, mascara, convite, criarConta, entrar, trocarPin, definirPin, hashSenha, confereSenha, pinInvalido, vendedorPorToken, vendedorPorEmail, inscrever, desinscrever, desconectarTodos, enviarPush, testarPush, testarPushVendedor, avisosRecentes, avisarNovaCotacao, lembretesPrazo, avisarPedido, canalDe, resumoCanais, resumoVendedor, listarVendedores, foraDoPortal, empresasDoWhats, sincronizarEmpresas, registrarRotas, fornecedorEhDoVendedor, pedidoEhDoVendedor, exigeLogin, setConfig, LEMBRETE_MS, TENT_MAX, DIR };
