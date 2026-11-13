// Cliente do Conector (projeto conector-erp, instalado no servidor em 13/11/2026): a ponte por onde as gravações no Dlinks
// vão passar (pedido de compra e preço de venda), no lugar de gravar direto no banco. Por enquanto só consulta a situação;
// o robô continua gravando por escreverERP até o Tiago mandar trocar.
// A senha do robô fica no config do próprio Conector (pasta protegida do Windows) ou em CONECTOR_TOKEN; nunca no repositório.
'use strict';
const fs = require('fs');

const URL_BASE = (process.env.CONECTOR_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const CONFIG = process.env.CONECTOR_CONFIG || 'C:\\ProgramData\\Conector\\config.json';

function token() {
  if (process.env.CONECTOR_TOKEN) return { token: process.env.CONECTOR_TOKEN, origem: 'variável de ambiente' };
  try { const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); const t = (c.tokens || [])[0]; if (t && t.token) return { token: t.token, origem: 'config do Conector' }; return { token: null, motivo: 'config do Conector sem senha' }; }
  catch (e) { return { token: null, motivo: e.code === 'EPERM' || e.code === 'EACCES' ? 'sem permissão pra ler o config do Conector' : e.code === 'ENOENT' ? 'Conector não instalado neste servidor' : e.message }; }
}

/** Situação do Conector, sem expor a senha: está no ar? grava onde? o sistema consegue se autenticar nele? */
async function estado() {
  const out = { url: URL_BASE, no_ar: false, saude: null, senha: false, senha_motivo: null, autenticado: false };
  try { const r = await fetch(URL_BASE + '/v1/saude', { signal: AbortSignal.timeout(5000) }); out.saude = await r.json(); out.no_ar = r.ok; }
  catch (e) { out.erro = 'Conector não respondeu: ' + e.message; return out; }
  const t = token(); out.senha = !!t.token; out.senha_motivo = t.token ? t.origem : t.motivo;
  if (t.token) { try { const r = await fetch(URL_BASE + '/v1/ordens?limite=1', { headers: { Authorization: 'Bearer ' + t.token }, signal: AbortSignal.timeout(5000) }); out.autenticado = r.ok; } catch (e) { out.autenticado = false; } }
  return out;
}

module.exports = { estado, URL_BASE };
