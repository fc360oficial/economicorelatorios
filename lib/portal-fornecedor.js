// Portal do Fornecedor (PWA em /fornecedor/) — Gestão de Compras > Cotação.
//
// O que é (Tiago, 13/10/2026): em vez de mandar o link de cada cotação pelo WhatsApp, o vendedor cria um LOGIN no
// portal UMA vez e as próximas cotações chegam como AVISO (Web Push), com atalho direto pra página dele. O WhatsApp
// fica só pra quem ainda não entrou.
//
//   1. conta: o vendedor recebe o link do portal (convite da tela administrativa ou painel na página da cotação) e
//      cria o login com nome, WhatsApp e PIN de 6 números; e-mail opcional (Tiago, 13/10: primeiro "login e senha com
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
  return { webpush: !!webpush, erro: webpushErro, vapid: !!vapid, exigeLogin: exigeLogin(), vendedores: vs.length, comLogin: vs.filter(v => v.senha).length, comApp: vs.filter(comApp).length, dispositivos: vs.reduce((s, v) => s + (v.dispositivos || []).length, 0) };
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
  if (e && !emailOk(e)) return { erro: 'E-mail inválido (ou deixe em branco)' };
  const pi = pinInvalido(pin); if (pi) return { erro: pi };
  let v = V[w];
  if (v && v.teste) return { erro: 'Este WhatsApp é reservado pros exemplos de teste' };
  if (v && v.senha) return { erro: 'Este WhatsApp já tem login no portal. Entre com o número e o PIN, ou peça pro(a) comprador(a) da Econômico redefinir o PIN.' };
  if (e) { const outro = vendedorPorEmail(e); if (outro && outro !== v) return { erro: 'Este e-mail já está no cadastro de outro vendedor: use outro ou deixe em branco' }; }
  if (!v) { v = V[w] = { id: w, nome, whats: w, email: e || null, token: novoToken(), empresas: [], dispositivos: [], criadoEm: agoraISO() }; log('conta nova', w, nome); }
  else { v.nome = nome; if (e) v.email = e; if (!v.token) v.token = novoToken(); log('conta criada num vendedor que já existia (entrou pelo "Sou eu" antes do login)', w, nome); }
  v.senha = hashSenha(String(pin).trim()); v.senhaEm = agoraISO();
  ligarEmpresa(v, de); marcarAcesso(v, ua); salvarV();
  return { vt: v.token, vendedor: visaoPublica(v) };
}
function entrar({ whats, pin, de, ua }) {
  const w = normWhats(whats); if (!w) return { erro: 'Informe seu WhatsApp com DDD, ex. 81 99999-0000' };
  if (!pin) return { erro: 'Informe o PIN' };
  if (bloqueado(w)) return { erro: 'Muitas tentativas erradas. Espere 10 minutos ou peça pro(a) comprador(a) da Econômico redefinir seu PIN.', bloqueado: true };
  const v = V[w];
  if (!v || !v.senha || !confereSenha(String(pin).trim(), v.senha)) { errou(w); return { erro: 'WhatsApp ou PIN não conferem' }; }
  acertou(w);
  if (!v.token) v.token = novoToken();
  ligarEmpresa(v, de); marcarAcesso(v, ua); salvarV();
  return { vt: v.token, vendedor: visaoPublica(v) };
}
// vendedor logado troca o PIN; quem entrou pelo "Sou eu" (antes do login existir) ainda não tem PIN e cria aqui
function trocarPin(vt, { pin_atual, pin_novo }) {
  const v = vendedorPorToken(vt); if (!v) return { erro: 'Sessão inválida' };
  const pi = pinInvalido(pin_novo); if (pi) return { erro: pi };
  if (v.senha && !(pin_atual && confereSenha(String(pin_atual).trim(), v.senha))) return { erro: 'PIN atual não confere' };
  v.senha = hashSenha(String(pin_novo).trim()); v.senhaEm = agoraISO(); salvarV();
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
  const vs = Object.values(V).filter(v => pedidoEhDoVendedor(p, v)).filter(comApp);
  if (!vs.length) return out;
  const total = p.totais && (p.totais.digitado || p.totais.total);
  const ent = p.cotacao && p.cotacao.entrega ? ' · entrega ' + String(p.cotacao.entrega).slice(0, 10).split('-').reverse().join('/') : '';
  const payload = { title: 'Pedido #' + p.id + ' · ' + (p.lista_nome || p.fornecedor || '') , body: (p.itens || []).length + ' itens' + (total ? ' · ' + fmtR(total) : '') + ent + '. Abra pra ver o PDF e confirmar.', url: '/fornecedor/pedido/' + p.token, tag: 'ped-' + p.id };
  let ok = 0; for (const v of vs) { const r = await enviarPush(v, payload, TTL_PEDIDO); ok += r.ok; }
  if (ok) { A.pedidos[p.id] = { avisadoEm: agoraISO(), vendedores: vs.map(v => v.id) }; salvarA(); out.avisados = vs.length; log('pedido', p.id, 'avisado', vs.length); }
  return out;
}

// canal de cada fornecedor da cotação (vai no cotDetalhe do Acompanhamento)
function canalDe(c, f) {
  const a = (A.cotacoes[c.id] || {})[f.codFornec] || null;
  const app = vendedoresDoFornecedor(f).filter(comApp).map(v => ({ id: v.id, nome: v.nome || v.whats }));
  return { canal: app.length ? 'app' : 'whatsapp', app, avisadoEm: a ? a.avisadoEm : null, reenvios: a ? a.reenvios || 0 : 0, lembreteEm: a ? a.lembreteEm : null };
}
function resumoCanais(c) { const cs = (c.fornecedores || []).map(f => canalDe(c, f)); return { app: cs.filter(x => x.canal === 'app').length, whatsapp: cs.filter(x => x.canal === 'whatsapp').length, avisados: cs.filter(x => x.avisadoEm).length, exigeLogin: exigeLogin() }; }

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
        resultados.push({ ...base, venceu: venc });
      }
    }
  }
  abertas.sort((a, b) => String(a.prazo || '9').localeCompare(String(b.prazo || '9')));
  const pendentes = [], historico = [];
  const peds = deps.pedidosFornec ? deps.pedidosFornec.listar() : [];
  for (const p of peds) {
    if (p.teste || !pedidoEhDoVendedor(p, v)) continue;
    if (['sugestao', 'analise', 'cancelado'].includes(p.status)) continue;   // ainda não foi mandado pro vendedor / cancelado
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
  v.senha = hashSenha(String(pin).trim()); v.senhaEm = agoraISO(); v.senhaPor = 'comprador(a)'; if (v.whats) acertou(v.whats); salvarV();
  return { ok: true, vendedor: visaoPublica(v) };
}
async function testarPushVendedor(vendedorId) {
  const v = V[vendedorId]; if (!v) return { erro: 'Vendedor não encontrado' };
  if (v.teste) return { ok: true, simulado: true, enviados: (v.dispositivos || []).length, falhas: 0, removidos: 0 };
  if (!(v.dispositivos || []).length) return { erro: 'Este vendedor não tem aparelho inscrito' };
  const r = await enviarPush(v, { title: 'Teste do Portal do Fornecedor', body: 'Aviso de teste mandado pela Econômico. Se chegou, está tudo certo.', url: '/fornecedor/', tag: 'teste' }, 600);
  return { ...r, ok: r.ok > 0, enviados: r.ok };
}
// Exemplos de TESTE pra tela administrativa (Tiago: toda tela nova entra com exemplo visível): 3 vendedores fictícios,
// WhatsApp 81 90000-000x (é o login) · PIN 123456, aparelhos de mentira (nunca recebem push de verdade
// e nunca casam com fornecedor real)
const TESTES = [
  { id: '81900000001', nome: 'TESTE Carlos Menezes', whats: '81900000001', email: 'carlos@teste.com.br', empresas: [{ codFornec: 999001, nome: 'TESTE Somar Distribuidora' }], ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36', disp: 1 },
  { id: '81900000002', nome: 'TESTE Ana Paula Ferreira', whats: '81900000002', email: 'ana@teste.com.br', empresas: [{ codFornec: 999001, nome: 'TESTE Somar Distribuidora' }, { codFornec: 999002, nome: 'TESTE Dislub Bebidas' }], ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1', disp: 2 },
  { id: '81900000003', nome: 'TESTE Rafael Lima', whats: '81900000003', email: 'rafael@teste.com.br', empresas: [{ codFornec: 999003, nome: 'TESTE Asa Branca' }], ua: 'Mozilla/5.0 (Linux; Android 13) SamsungBrowser/26 Chrome/122 Mobile Safari/537.36', disp: 0 }
];
const TESTE_PIN = '123456';
function criarTestes() {
  const agora = Date.now();
  const senha = hashSenha(TESTE_PIN);
  TESTES.forEach((t, k) => { V[t.id] = { id: t.id, nome: t.nome, whats: t.whats, email: t.email, senha, senhaEm: agoraISO(), token: novoToken(), empresas: t.empresas, teste: true, criadoEm: new Date(agora - (k + 3) * 86400000).toISOString(), ultimoAcesso: new Date(agora - k * 3600000 * 5).toISOString(), ultimoUa: t.ua, dispositivos: Array.from({ length: t.disp }, (_, i) => ({ endpoint: 'https://teste.invalido/' + t.id + '/' + i, keys: { p256dh: 'teste', auth: 'teste' }, ua: t.ua, criadoEm: new Date(agora - (k + 2) * 86400000).toISOString(), ultimoEnvio: i === 0 ? new Date(agora - 86400000).toISOString() : null })) }; });
  salvarV(); return { criados: TESTES.length };
}
function removerTestes() { let n = 0; for (const id of Object.keys(V)) if (V[id].teste) { delete V[id]; n++; } salvarV(); return { removidos: n }; }
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
// lista administrativa (Acompanhamento / diagnóstico): quem tem o portal
function listarVendedores() { return Object.values(V).map(visaoPublica).sort((a, b) => String(b.ultimoAcesso || '').localeCompare(String(a.ultimoAcesso || ''))); }

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
    const r = trocarPin(vtDe(req), { pin_atual: b.pin_atual, pin_novo: b.pin_novo });
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
  app.get('/api/portal-admin/estado', (req, res) => res.json({ ...estado(), vendedores_lista: listarVendedores(), avisos: avisosRecentes(40), testes: Object.values(V).filter(v => v.teste).length }));
  app.post('/api/portal-admin/vendedores/:id/pin', (req, res) => { const b = req.body || {}; const r = definirPin(req.params.id, { pin: b.pin }); if (r.erro) return res.status(400).json({ error: r.erro }); res.json(r); });
  app.post('/api/portal-admin/config', (req, res) => res.json(setConfig({ exigeLogin: !!(req.body && req.body.exigeLogin) })));
  app.post('/api/portal-admin/testes', (req, res) => res.json(criarTestes()));
  app.post('/api/portal-admin/testes/remover', (req, res) => res.json(removerTestes()));
  app.post('/api/portal-admin/vendedores/:id/desconectar', (req, res) => { const r = desconectarTodos(req.params.id); if (!r) return res.status(404).json({ error: 'Vendedor não encontrado' }); res.json(r); });
  app.post('/api/portal-admin/cotacoes/:id/avisar', async (req, res) => {
    try {
      const c = deps.cotacao.obter(parseInt(req.params.id)); if (!c) return res.status(404).json({ error: 'cotação não encontrada' });
      res.json(await avisarNovaCotacao(c, { reenvio: true, soNaoAbriram: !!(req.body && req.body.soNaoAbriram), codFornecs: req.body && Array.isArray(req.body.codFornecs) ? req.body.codFornecs.map(Number) : null }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { init, estado, chavePublica, normWhats, mascara, convite, criarConta, entrar, trocarPin, definirPin, hashSenha, confereSenha, pinInvalido, vendedorPorToken, vendedorPorEmail, inscrever, desinscrever, desconectarTodos, enviarPush, testarPush, testarPushVendedor, criarTestes, removerTestes, avisosRecentes, avisarNovaCotacao, lembretesPrazo, avisarPedido, canalDe, resumoCanais, resumoVendedor, listarVendedores, registrarRotas, fornecedorEhDoVendedor, pedidoEhDoVendedor, exigeLogin, setConfig, LEMBRETE_MS, TENT_MAX, TESTE_PIN, DIR };
