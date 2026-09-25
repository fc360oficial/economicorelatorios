'use strict';
// PontoCerto — integração do sistema de ponto com o DP / RH (25/09/2026).
// Config em data/pontocerto.json (gitignored): { url, token, auth: 'bearer'|'header'|'query', header, empresa }.
// O token NUNCA volta inteiro pra tela (só os 6 primeiros e 4 últimos caracteres).
const fs = require('fs');
const path = require('path');
const ARQ = path.join(__dirname, '..', 'data', 'pontocerto.json');
const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { return {}; } };
const mascara = t => t ? (t.length > 14 ? t.slice(0, 6) + '…' + t.slice(-4) : '••••') : '';
function getConfig() { const c = ler(); return { url: c.url || '', auth: c.auth || 'bearer', header: c.header || 'Authorization', empresa: c.empresa || '', token_mascarado: mascara(c.token || ''), tem_token: !!c.token, atualizadoEm: c.atualizadoEm || null, ultimo_teste: c.ultimo_teste || null }; }
function setConfig(campos, usuario) {
  const c = ler();
  if (typeof campos.url === 'string') c.url = campos.url.trim().replace(/\/+$/, '');
  if (typeof campos.token === 'string' && campos.token.trim()) c.token = campos.token.trim();
  if (['bearer', 'header', 'query'].includes(campos.auth)) c.auth = campos.auth;
  if (typeof campos.header === 'string' && campos.header.trim()) c.header = campos.header.trim();
  if (typeof campos.empresa === 'string') c.empresa = campos.empresa.trim();
  c.atualizadoEm = new Date().toISOString(); c.atualizadoPor = usuario || null;
  fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(c, null, 2));
  return getConfig();
}
// Chamada de teste: GET <url><caminho> com o token do jeito configurado. Devolve status, tipo e o começo do corpo.
async function testar(caminho, metodo) {
  const c = ler(); if (!c.url || !c.token) return { erro: 'Configure a URL da API e o token primeiro.' };
  let alvo = c.url + (caminho && caminho.startsWith('/') ? caminho : '/' + (caminho || ''));
  const headers = { 'Accept': 'application/json' };
  if ((c.auth || 'bearer') === 'bearer') headers['Authorization'] = 'Bearer ' + c.token;
  else if (c.auth === 'header') headers[c.header || 'Authorization'] = c.token;
  else alvo += (alvo.includes('?') ? '&' : '?') + (c.header || 'token') + '=' + encodeURIComponent(c.token);
  if (c.empresa) headers['X-Empresa'] = c.empresa;
  const t0 = Date.now();
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(alvo, { method: metodo || 'GET', headers, signal: ctl.signal }); clearTimeout(tm);
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch (e) {}
    const res = { ok: r.ok, status: r.status, tipo: r.headers.get('content-type') || '', ms: Date.now() - t0, url: alvo.replace(c.token, '***'), corpo: texto.slice(0, 6000), json_chaves: json && typeof json === 'object' ? Object.keys(Array.isArray(json) ? (json[0] || {}) : json).slice(0, 40) : null, itens: Array.isArray(json) ? json.length : (json && Array.isArray(json.data) ? json.data.length : null) };
    const cfg = ler(); cfg.ultimo_teste = { em: new Date().toISOString(), caminho, status: r.status, ok: r.ok }; fs.writeFileSync(ARQ, JSON.stringify(cfg, null, 2));
    return res;
  } catch (e) { return { erro: e.name === 'AbortError' ? 'Sem resposta em 20 s (URL errada ou bloqueio de rede no servidor)' : e.message, url: alvo.replace(c.token, '***'), ms: Date.now() - t0 }; }
}
module.exports = { getConfig, setConfig, testar };
