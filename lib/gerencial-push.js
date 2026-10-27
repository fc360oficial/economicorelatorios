// Avisos no celular do gerente — Web Push (27/10/2026, Tiago: "forçar o gerente instalar o app no celular e ativar as
// notificações"). A Gestão Gerencial, aberta pelo app instalado, inscreve o aparelho aqui; o servidor manda avisos por
// usuário (notificar) ou por loja (notificarLoja: todo gerente inscrito daquela loja).
// Chave VAPID própria em data/gerencial-push/vapid.json, passada EM CADA ENVIO (vapidDetails) pra não trocar a chave global
// do web-push que o portal do fornecedor configura (lib/portal-fornecedor.js). Inscrições em data/gerencial-push/inscricoes.json.
// web-push em try/catch: sem o pacote, tudo continua funcionando, só sem avisos.
'use strict';
const fs = require('fs'), path = require('path');

let DIR = null, webpush = null, webpushErro = null, vapid = null, S = null, contato = 'rh@economico.com.br';
const MAX_APARELHOS = 5;
const TTL_PADRAO = 6 * 3600;
const agoraISO = () => new Date().toISOString();
const arq = n => path.join(DIR, n);
const lerJson = (n, padrao) => { try { return JSON.parse(fs.readFileSync(arq(n), 'utf8')); } catch (e) { return padrao; } };
const gravarJson = (n, obj) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(arq(n), JSON.stringify(obj, null, 1)); };
const salvar = () => gravarJson('inscricoes.json', S);
const log = (...a) => console.log('[gerencial-push]', ...a);

function init(deps) {
  deps = deps || {};
  DIR = deps.dataDir || path.join(__dirname, '..', 'data', 'gerencial-push');
  if (deps.contato) contato = deps.contato;
  try { webpush = deps.webpush || require('web-push'); webpushErro = null; }
  catch (e) { webpush = null; webpushErro = 'pacote web-push não instalado (npm install): ' + e.message; log(webpushErro); }
  vapid = lerJson('vapid.json', null);
  if (webpush && !(vapid && vapid.publicKey && vapid.privateKey)) { vapid = webpush.generateVAPIDKeys(); vapid.criadoEm = agoraISO(); gravarJson('vapid.json', vapid); log('chave VAPID gerada'); }
  S = lerJson('inscricoes.json', null); if (!S || typeof S !== 'object') S = {}; if (!S.usuarios) S.usuarios = {};
}
const chavePublica = () => (vapid && vapid.publicKey) || null;
const idDe = u => String((u && (u.usuario || u.id)) || '').toLowerCase().trim();
function registroDe(user, criar) {
  const id = idDe(user); if (!id) return null;
  let r = S.usuarios[id];
  if (!r && criar) r = S.usuarios[id] = { usuario: id, dispositivos: [] };
  if (r) { r.nome = user.nome || r.nome || id; r.perfil = user.perfil || r.perfil || null; r.loja = user.loja_id ? +user.loja_id : (r.loja || null); }
  return r || null;
}
function estado() {
  const us = Object.values(S.usuarios);
  return { webpush: !!webpush, erro: webpushErro, vapid: !!vapid, usuarios: us.length, dispositivos: us.reduce((s, u) => s + (u.dispositivos || []).length, 0),
           porLoja: us.reduce((m, u) => { if (u.loja && (u.dispositivos || []).length) m[u.loja] = (m[u.loja] || 0) + 1; return m; }, {}) };
}
function dispositivosDe(user) { const r = registroDe(user, false); return r ? (r.dispositivos || []).length : 0; }

// ── inscrição por aparelho (uma por endpoint; guarda os 5 últimos por usuário) ────────────────────────────
function inscrever(user, sub, ua) {
  const r = registroDe(user, true); if (!r) return { erro: 'Usuário sem identificação' };
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { erro: 'Inscrição de push incompleta' };
  const novo = !r.dispositivos.some(d => d.endpoint === sub.endpoint);
  r.dispositivos = r.dispositivos.filter(d => d.endpoint !== sub.endpoint);
  r.dispositivos.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, expirationTime: sub.expirationTime || null, ua: String(ua || '').slice(0, 200), criadoEm: agoraISO() });
  if (r.dispositivos.length > MAX_APARELHOS) r.dispositivos = r.dispositivos.slice(-MAX_APARELHOS);
  r.ultimaInscricao = agoraISO(); salvar();
  return { ok: true, novo, dispositivos: r.dispositivos.length };
}
function desinscrever(user, endpoint) {
  const r = registroDe(user, false); if (!r) return { ok: true, removidos: 0 };
  const n = r.dispositivos.length; r.dispositivos = r.dispositivos.filter(d => d.endpoint !== endpoint); salvar();
  return { ok: true, removidos: n - r.dispositivos.length };
}

// ── envio: payload { title, body, url, tag }; aparelho que sumiu (404/410) é apagado ──────────────────────
async function enviarPara(r, payload, ttl) {
  if (!webpush) return { ok: 0, falhas: 0, removidos: 0, erro: webpushErro || 'push indisponível' };
  if (!vapid) return { ok: 0, falhas: 0, removidos: 0, erro: 'sem chave VAPID' };
  const corpo = JSON.stringify(payload); let ok = 0, falhas = 0, removidos = 0; const erros = [];
  const opts = { TTL: ttl || TTL_PADRAO, urgency: 'high', vapidDetails: { subject: 'mailto:' + contato, publicKey: vapid.publicKey, privateKey: vapid.privateKey } };
  for (const d of (r.dispositivos || []).slice()) {
    try { await webpush.sendNotification({ endpoint: d.endpoint, keys: d.keys }, corpo, opts); ok++; d.ultimoEnvio = agoraISO(); }
    catch (e) {
      falhas++; erros.push((e.statusCode || '') + ' ' + (e.body || e.message || '').slice(0, 120));
      if (e.statusCode === 404 || e.statusCode === 410) { r.dispositivos = r.dispositivos.filter(x => x.endpoint !== d.endpoint); removidos++; }
    }
  }
  if (ok || removidos) salvar();
  return { ok, falhas, removidos, erro: erros.length ? erros.join(' · ') : null };
}
async function notificar(user, payload, ttl) {
  const r = registroDe(user, false); if (!r || !(r.dispositivos || []).length) return { ok: 0, falhas: 0, removidos: 0, erro: 'usuário sem aparelho inscrito' };
  return enviarPara(r, payload, ttl);
}
/** Avisa todo gerente inscrito da loja (perfil gerencial com loja_id = loja). */
async function notificarLoja(loja, payload, ttl) {
  const out = { usuarios: 0, ok: 0, falhas: 0, removidos: 0 };
  for (const r of Object.values(S.usuarios)) {
    if (+r.loja !== +loja || !(r.dispositivos || []).length) continue;
    const x = await enviarPara(r, payload, ttl); out.usuarios++; out.ok += x.ok; out.falhas += x.falhas; out.removidos += x.removidos;
  }
  return out;
}
async function testar(user) {
  const r = await notificar(user, { title: 'Notificações ativadas ✓', body: 'Os avisos da Gestão Gerencial vão chegar aqui no seu celular.', url: '/gestao-gerencial.html', tag: 'teste' }, 600);
  return { ...r, ok: r.ok > 0, enviados: r.ok };
}

module.exports = { init, estado, chavePublica, inscrever, desinscrever, dispositivosDe, notificar, notificarLoja, testar };
