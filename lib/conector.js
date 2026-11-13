// Cliente do Conector (projeto conector-erp, instalado no servidor em 13/11/2026): a ponte por onde as gravações no Dlinks
// vão passar (pedido de compra e preço de venda), no lugar de gravar direto no banco. Por enquanto só consulta a situação;
// o robô continua gravando por escreverERP até o Tiago mandar trocar.
// A senha do robô fica no config do próprio Conector (pasta protegida do Windows) ou em CONECTOR_TOKEN; nunca no repositório.
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./log-erp');
const DIR_LOG = path.join(__dirname, '..', 'data', 'log-erp');   // o mesmo Log de Processos › Log

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
function ativo() { if (process.env.CONECTOR_USO === 'off') return false;   // testes do caminho de sempre
  try { return JSON.parse(fs.readFileSync(F_CHAVE, 'utf8')).ativo !== false; } catch (e) { return true; } }
function setAtivo(v, usuario) { const c = { ativo: !!v, mudadoEm: new Date().toISOString(), mudadoPor: usuario || null }; fs.mkdirSync(path.dirname(F_CHAVE), { recursive: true }); fs.writeFileSync(F_CHAVE, JSON.stringify(c)); return c; }

/** Manda uma ordem. Devolve no formato que as rotas já esperam do escreverERP: { ok, id, ids, erro, status }. */
async function enviar(tipo, chave, aprovadoPor, dados) {
  const inicio = Date.now(), r = await enviarSemLog(tipo, chave, aprovadoPor, dados);
  // toda ordem (executada, recusada ou com erro) fica em Processos › Log, igual às gravações do caminho antigo
  try {
    const itens = (dados && dados.itens) || [], res = r.resultado || {};
    const e = { id: L.novoId(), quando: L.agoraIso(), usuario: String(aprovadoPor || '').trim(), servidor: 'conector', host: 'conector',
      banco: 'conector', tabela: tipo, operacao: 'ordem', motivo: String((dados && (dados.motivo || dados.obs)) || ('Conector: ' + tipo)).slice(0, 200) + ' · loja ' + (dados && dados.loja),
      where: { chave, ordem: r.ordem || null }, valores: tipo === 'preco_venda' ? { loja: dados.loja, itens: itens.length } : { loja: dados.loja, fornecedor: dados.fornecedor && dados.fornecedor.codigo, itens: itens.length },
      limite: itens.length, sql: null, params: null, afetados: r.ok ? itens.length : 0,
      antes: tipo === 'preco_venda' ? (res.antes || []).map(a => ({ CodigoBarra: a.codigo, preco: a.preco })) : [],
      depois: !r.ok ? [] : tipo === 'preco_venda' ? itens.map(i => ({ CodigoBarra: i.codigo, preco: String(Number(i.preco).toFixed(2)).replace('.', ',') })) : [{ pedido: res.pedido, total: res.total, itens: res.itens }],
      colunas_mudadas: r.ok && tipo === 'preco_venda' ? ['preco'] : [], status: r.ok ? 'ok' : r.status, erro: r.ok ? null : r.erro, ms: Date.now() - inicio, ordem_conector: r.ordem || null };
    L.gravar(DIR_LOG, e); r.id = e.id;   // o "Log nº" que as telas mostram passa a ser o do Log de Processos; a ordem do Conector vai junto em r.ordem
  } catch (e) { console.error('[CONECTOR] não gravou no Log:', e.message); }
  return r;
}
async function enviarSemLog(tipo, chave, aprovadoPor, dados) {
  const t = token(); if (!t.token) return { ok: false, status: 'erro', erro: 'Conector: ' + t.motivo };
  let r, j;
  try {
    r = await fetch(URL_BASE + '/v1/ordens', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.token }, body: JSON.stringify({ tipo, chave, aprovado_por: aprovadoPor || '', dados }), signal: AbortSignal.timeout(60000) });
    j = await r.json();
  } catch (e) { return { ok: false, status: 'erro', erro: 'Conector não respondeu: ' + e.message }; }
  const id = j && j.id ? 'conector:' + j.id : null;
  if (j && j.status === 'executada') return { ok: true, status: 'ok', id, ids: [j.resultado && j.resultado.pedido != null ? j.resultado.pedido : null], ordem: j.id, resultado: j.resultado };
  const motivo = (j && j.resultado && j.resultado.motivo) || (j && j.motivos && j.motivos.join('; ')) || (j && j.erro) || ('resposta ' + r.status);
  return { ok: false, status: j && j.status === 'recusada' ? 'recusado' : 'erro', id, ordem: (j && j.id) || null, erro: 'Conector: ' + motivo };
}
// ── tela Processos › Conector: ordens que passaram por ele, detalhe e desfazer ──
async function chamar(rota, corpo) {
  const t = token(); if (!t.token) throw new Error('Conector: ' + t.motivo);
  const r = await fetch(URL_BASE + rota, { method: corpo === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.token }, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || j.error || ('Conector respondeu ' + r.status));
  return j;
}
const ordens = (limite = 200) => chamar('/v1/ordens?limite=' + Math.max(1, Math.min(500, +limite || 200)));
const ordem = id => chamar('/v1/ordens/' + encodeURIComponent(String(id).replace(/[^0-9a-f-]/g, '')));
/** Desfaz uma ordem executada. Fica em Processos › Log com quem pediu. */
async function desfazer(id, usuario) {
  const inicio = Date.now(); let r = null, erro = null;
  try { r = await chamar('/v1/ordens/' + encodeURIComponent(String(id).replace(/[^0-9a-f-]/g, '')) + '/desfazer', { por: usuario || '' }); } catch (e) { erro = e.message; }
  try {
    L.gravar(DIR_LOG, { id: L.novoId(), quando: L.agoraIso(), usuario: String(usuario || '').trim(), servidor: 'conector', host: 'conector', banco: 'conector', tabela: (r && r.tipo) || 'ordem', operacao: 'desfazer',
      motivo: 'Conector: ordem ' + id + ' desfeita', where: { ordem: id }, valores: null, limite: 0, sql: null, params: null, afetados: r ? r.itens || 0 : 0, antes: [], depois: [], colunas_mudadas: [],
      status: erro ? 'erro' : 'ok', erro, ms: Date.now() - inicio, ordem_conector: id });
  } catch (e) { console.error('[CONECTOR] não gravou no Log:', e.message); }
  if (erro) throw new Error(erro);
  return r;
}
let atacadoCache = { em: 0, ok: false };
/** O Conector instalado grava preço de atacado? (0.4.0 em diante). Guarda a resposta 1 min. */
async function suportaAtacado() {
  if (Date.now() - atacadoCache.em < 60000) return atacadoCache.ok;
  let ok = false;
  try { const r = await fetch(URL_BASE + '/v1/saude', { signal: AbortSignal.timeout(5000) }); const j = await r.json(); const v = String(j.versao || '0').split('.').map(Number); ok = v[0] > 0 || (v[0] === 0 && v[1] >= 4); } catch (e) { ok = false; }
  atacadoCache = { em: Date.now(), ok }; return ok;
}
const pedidoCompra = (chave, aprovadoPor, dados) => enviar('pedido_compra', chave, aprovadoPor, dados);
const precoVenda = (chave, aprovadoPor, dados) => enviar('preco_venda', chave, aprovadoPor, dados);

module.exports = { suportaAtacado, estado, ativo, setAtivo, enviar, pedidoCompra, precoVenda, ordens, ordem, desfazer, URL_BASE };
