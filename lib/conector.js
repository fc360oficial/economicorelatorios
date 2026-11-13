// Cliente do Conector (projeto conector-erp, instalado no servidor em 13/11/2026): a ponte por onde as gravações no Dlinks
// vão passar (pedido de compra e preço de venda), no lugar de gravar direto no banco. Por enquanto só consulta a situação;
// o robô continua gravando por escreverERP até o Tiago mandar trocar.
// A senha do robô fica no config do próprio Conector (pasta protegida do Windows) ou em CONECTOR_TOKEN; nunca no repositório.
'use strict';
const fs = require('fs');
const path = require('path');

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

// Chave: data/conector.json { ativo }. Ligada (padrão), os pedidos do ROBÔ gravam pelo Conector; desligada, voltam ao caminho de
// sempre (escreverERP). Não tem "tenta um, se falhar vai no outro": se o Conector recusar, o erro aparece pra quem aprovou.
const F_CHAVE = path.join(__dirname, '..', 'data', 'conector.json');
function ativo() { try { return JSON.parse(fs.readFileSync(F_CHAVE, 'utf8')).ativo !== false; } catch (e) { return true; } }
function setAtivo(v, usuario) { const c = { ativo: !!v, mudadoEm: new Date().toISOString(), mudadoPor: usuario || null }; fs.mkdirSync(path.dirname(F_CHAVE), { recursive: true }); fs.writeFileSync(F_CHAVE, JSON.stringify(c)); return c; }

/** Manda uma ordem. Devolve no formato que as rotas já esperam do escreverERP: { ok, id, ids, erro, status }. */
async function enviar(tipo, chave, aprovadoPor, dados) {
  const t = token(); if (!t.token) return { ok: false, status: 'erro', erro: 'Conector: ' + t.motivo };
  let r, j;
  try {
    r = await fetch(URL_BASE + '/v1/ordens', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.token }, body: JSON.stringify({ tipo, chave, aprovado_por: aprovadoPor || '', dados }), signal: AbortSignal.timeout(60000) });
    j = await r.json();
  } catch (e) { return { ok: false, status: 'erro', erro: 'Conector não respondeu: ' + e.message }; }
  const id = j && j.id ? 'conector:' + j.id : null;
  if (j && j.status === 'executada') return { ok: true, status: 'ok', id, ids: [j.resultado && j.resultado.pedido != null ? j.resultado.pedido : null], ordem: j.id, resultado: j.resultado };
  const motivo = (j && j.resultado && j.resultado.motivo) || (j && j.motivos && j.motivos.join('; ')) || (j && j.erro) || ('resposta ' + r.status);
  return { ok: false, status: j && j.status === 'recusada' ? 'recusado' : 'erro', id, erro: 'Conector: ' + motivo };
}
const pedidoCompra = (chave, aprovadoPor, dados) => enviar('pedido_compra', chave, aprovadoPor, dados);
const precoVenda = (chave, aprovadoPor, dados) => enviar('preco_venda', chave, aprovadoPor, dados);

module.exports = { estado, ativo, setAtivo, enviar, pedidoCompra, precoVenda, URL_BASE };
