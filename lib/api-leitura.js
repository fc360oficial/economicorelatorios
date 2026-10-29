'use strict';
// lib/api-leitura.js — API de LEITURA sobre o nosso Postgres (Tiago, 28/10/2026: "no futuro quero colocar tudo via API").
// Monta em /api/v1/* fora do login do site: autentica por chave (cabeçalho X-Api-Key ou ?chave=), chaves em
// data/api-chaves.json (gitignored) criadas/revogadas em Processos › Espelho do ERP. Só GET, só o que está no banco
// (nada toca o ERP): vendas por dia e por produto, estoque/custo por loja, cadastro, compras (notas e itens), validades,
// documentos dos módulos (doc_json) e os JSONs espelhados (arquivo_json). Limite de 300 chamadas por minuto por chave.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pg = require('./pg');

let ARQ = null, chaves = null; const uso = new Map();   // chave → { min, n, total, ultimo }
const LIMITE_MIN = 300, MAX_LINHAS = 5000;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

function lerChaves() { if (chaves) return chaves; try { chaves = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { chaves = { chaves: [] }; } chaves.chaves = chaves.chaves || []; return chaves; }
function gravarChaves() { fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(chaves, null, 1)); }
const hashChave = c => crypto.createHash('sha256').update(String(c)).digest('hex');
// ── chaves (admin, pela tela) ────────────────────────────────────────────────────────────────────────────────────
function listarChaves() { return lerChaves().chaves.map(c => ({ id: c.id, nome: c.nome, ativa: c.ativa !== false, criadaEm: c.criadaEm, criadaPor: c.criadaPor, prefixo: c.prefixo, uso: uso.get(c.id) ? { total: uso.get(c.id).total, ultimo: uso.get(c.id).ultimo } : null })); }
function criarChave(nome, por) {
  const c = lerChaves(); const segredo = 'eco_' + crypto.randomBytes(24).toString('base64url');
  const reg = { id: crypto.randomBytes(6).toString('hex'), nome: String(nome || 'sem nome').slice(0, 60), hash: hashChave(segredo), prefixo: segredo.slice(0, 8), ativa: true, criadaEm: new Date().toISOString(), criadaPor: por || null };
  c.chaves.push(reg); gravarChaves();
  return { id: reg.id, nome: reg.nome, chave: segredo };   // a chave inteira só aparece agora
}
function revogarChave(id) { const c = lerChaves(); const r = c.chaves.find(x => x.id === id); if (!r) throw erro('chave não encontrada', 404); r.ativa = false; r.revogadaEm = new Date().toISOString(); gravarChaves(); return { ok: true }; }
function erro(msg, status) { return Object.assign(new Error(msg), { status: status || 400 }); }

// ── autenticação + limite ────────────────────────────────────────────────────────────────────────────────────────
function autenticar(req, res, next) {
  const bruto = req.get('x-api-key') || req.query.chave;
  if (!bruto) return res.status(401).json({ error: 'Informe a chave em X-Api-Key' });
  const h = hashChave(bruto); const c = lerChaves().chaves.find(x => x.hash === h);
  if (!c || c.ativa === false) return res.status(401).json({ error: 'Chave inválida ou revogada' });
  const min = Math.floor(Date.now() / 60000); const u = uso.get(c.id) || { min, n: 0, total: 0, ultimo: null };
  if (u.min !== min) { u.min = min; u.n = 0; }
  if (++u.n > LIMITE_MIN) { uso.set(c.id, u); return res.status(429).json({ error: `Limite de ${LIMITE_MIN} chamadas por minuto` }); }
  u.total++; u.ultimo = new Date().toISOString(); uso.set(c.id, u);
  req.apiChave = { id: c.id, nome: c.nome }; next();
}
// ── helpers de parâmetro ─────────────────────────────────────────────────────────────────────────────────────────
const lojasDe = q => { const l = String(q.lojas || q.loja || '').split(',').map(s => parseInt(s, 10)).filter(n => [1, 2, 3, 4, 5, 6, 10].includes(n)); return l.length ? l : [1, 2, 3, 4, 5, 6, 10]; };
const codigosDe = q => { const c = String(q.codigos || q.codigo || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 2000); return c.length ? c : null; };
const dataOu = (v, padrao) => (RE_DATA.test(String(v || '')) ? String(v) : padrao);
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const diasAtras = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const limiteDe = q => Math.min(MAX_LINHAS, Math.max(1, parseInt(q.limit, 10) || 1000));
const offsetDe = q => Math.max(0, parseInt(q.offset, 10) || 0);
const periodo = q => { const de = dataOu(q.de, diasAtras(30)), ate = dataOu(q.ate, hoje()); if (de > ate) throw erro('de > ate'); return { de, ate }; };
const responder = (res, linhas, extra = {}) => res.json({ ok: true, linhas: linhas.length, ...extra, dados: linhas });

// ── rotas ────────────────────────────────────────────────────────────────────────────────────────────────────────
function montar(app) {
  const r = require('express').Router();
  r.use(autenticar);
  r.get('/', (req, res) => res.json({ ok: true, chave: req.apiChave.nome, endpoints: [
    'GET /api/v1/vendas/dias?lojas=1,2&de=&ate=', 'GET /api/v1/vendas/produtos?lojas=&de=&ate=&codigos=&por_dia=1',
    'GET /api/v1/estoque?lojas=&codigos=', 'GET /api/v1/cadastro/itens?busca=&setor=&grupo=&ativos=1&limit=&offset=',
    'GET /api/v1/compras/notas?lojas=&de=&ate=&campo=datalan|datarecto&movimentacao=', 'GET /api/v1/compras/itens?lojas=&de=&ate=&codigos=',
    'GET /api/v1/validades?loja=10&de=&ate=', 'GET /api/v1/docs/:modulo/:tipo[/:id]', 'GET /api/v1/arquivos?caminho=paineis-tvs/estado.json',
  ], limites: { porMinuto: LIMITE_MIN, maxLinhas: MAX_LINHAS } }));
  const rota = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
  r.get('/vendas/dias', rota(async (req, res) => {
    const { de, ate } = periodo(req.query);
    responder(res, await pg.pq(`SELECT loja, dia::text dia, valor, custo, qtd, itens, cupons, produtos, cancelado, copiado_em FROM venda_dia_loja WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 ORDER BY loja, dia`, [lojasDe(req.query), de, ate]), { de, ate });
  }));
  r.get('/vendas/produtos', rota(async (req, res) => {
    const { de, ate } = periodo(req.query); const cods = codigosDe(req.query); const porDia = req.query.por_dia === '1';
    const p = [lojasDe(req.query), de, ate]; let w = 'loja = ANY($1) AND dia BETWEEN $2 AND $3'; if (cods) { p.push(cods); w += ` AND codigo = ANY($${p.length})`; }
    p.push(limiteDe(req.query), offsetDe(req.query));
    const sql = porDia
      ? `SELECT loja, dia::text dia, codigo, qtd, valor, custo, desconto, itens, cupons FROM venda_dia_produto WHERE ${w} ORDER BY loja, dia, codigo LIMIT $${p.length - 1} OFFSET $${p.length}`
      : `SELECT loja, codigo, SUM(qtd) qtd, SUM(valor) valor, SUM(custo) custo, SUM(desconto) desconto, SUM(itens) itens, SUM(cupons) cupons, MIN(dia)::text primeira, MAX(dia)::text ultima FROM venda_dia_produto WHERE ${w} GROUP BY loja, codigo ORDER BY loja, valor DESC LIMIT $${p.length - 1} OFFSET $${p.length}`;
    responder(res, await pg.pq(sql, p), { de, ate });
  }));
  r.get('/estoque', rota(async (req, res) => {
    const cods = codigosDe(req.query); const p = [lojasDe(req.query)]; let w = 'loja = ANY($1)'; if (cods) { p.push(cods); w += ` AND codigo = ANY($${p.length})`; }
    p.push(limiteDe(req.query), offsetDe(req.query));
    responder(res, await pg.pq(`SELECT loja, codigo, qtd, qtd_virtual, data_estoque::text data_estoque, custo, custo_formacao, ultima_compra::text ultima_compra, nnota, atualizado_em FROM estoque_loja WHERE ${w} ORDER BY loja, codigo LIMIT $${p.length - 1} OFFSET $${p.length}`, p));
  }));
  r.get('/cadastro/itens', rota(async (req, res) => {
    const p = []; const w = [];
    if (req.query.ativos !== '0') w.push('desativado = 0');
    if (req.query.busca) { p.push('%' + String(req.query.busca).toUpperCase() + '%'); w.push(`(UPPER(descricao) LIKE $${p.length} OR codigo LIKE $${p.length})`); }
    if (req.query.setor) { p.push(parseInt(req.query.setor, 10) || 0); w.push(`codsetor = $${p.length}`); }
    if (req.query.grupo) { p.push(parseInt(req.query.grupo, 10) || 0); w.push(`codgrupo = $${p.length}`); }
    const cods = codigosDe(req.query); if (cods) { p.push(cods); w.push(`codigo = ANY($${p.length})`); }
    p.push(limiteDe(req.query), offsetDe(req.query));
    responder(res, await pg.pq(`SELECT codigo, ninterno, descricao, unid, tipobalanca, qtdemb, codsetor, codsubsetor, codmarca, codgrupo, codgruposub, codfornecedor, custo, preco, p1, p2, p3, p4, p5, p6, p10, desativado, abc, familia, categoria, marca, atualizado_em
                                 FROM cadastro_item ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY descricao LIMIT $${p.length - 1} OFFSET $${p.length}`, p));
  }));
  r.get('/compras/notas', rota(async (req, res) => {
    const { de, ate } = periodo(req.query); const campo = req.query.campo === 'datarecto' ? 'datarecto' : 'datalan';
    const p = [lojasDe(req.query), de, ate]; let w = `nloja = ANY($1) AND ${campo} BETWEEN $2 AND $3`;
    if (req.query.movimentacao) { p.push(String(req.query.movimentacao).toUpperCase()); w += ` AND movimentacao = $${p.length}`; }
    p.push(limiteDe(req.query), offsetDe(req.query));
    responder(res, await pg.pq(`SELECT nreg, ncompra, nloja, nnota, serie, modelo, codfornec, nomefornec, cnpj, datalan::text datalan, dataemissao::text dataemissao, datarecto::text datarecto, status, movimentacao, tipo, totalnota, totalprodutos, totaldesconto, chave, numeropedido, nconferencia, nomeoperador
                                 FROM compra_nota WHERE ${w} ORDER BY ${campo}, nloja, ncompra LIMIT $${p.length - 1} OFFSET $${p.length}`, p), { de, ate, campo });
  }));
  r.get('/compras/itens', rota(async (req, res) => {
    const { de, ate } = periodo(req.query); const cods = codigosDe(req.query);
    const p = [lojasDe(req.query), de, ate]; let w = 'nloja = ANY($1) AND dataentrada BETWEEN $2 AND $3'; if (cods) { p.push(cods); w += ` AND codigo = ANY($${p.length})`; }
    if (req.query.movimentacao) { p.push(String(req.query.movimentacao).toUpperCase()); w += ` AND movimentacao = $${p.length}`; }
    p.push(limiteDe(req.query), offsetDe(req.query));
    responder(res, await pg.pq(`SELECT nreg, ncompra, nloja, item, codigo, unid, qtd, qtdemb, qtdentrada, preco, custo, total, precovenda, descricao, dataentrada::text dataentrada, movimentacao, tipo, status, cancelado, bonificacao, nnota, serie, cnpj, nconferencia, cfop
                                 FROM compra_item WHERE ${w} ORDER BY dataentrada, nloja, ncompra, item LIMIT $${p.length - 1} OFFSET $${p.length}`, p), { de, ate });
  }));
  r.get('/validades', rota(async (req, res) => {
    const loja = parseInt(req.query.loja, 10) || 10; const de = dataOu(req.query.de, hoje()), ate = dataOu(req.query.ate, diasAtrasNeg(90));
    const p = [loja, de, ate, limiteDe(req.query), offsetDe(req.query)];
    responder(res, await pg.pq(`SELECT nreg, nloja, codigo, validade::text validade, dataentrada::text dataentrada, ndoc, nserie, ncompra, qtd, lote, caixa FROM validade_item WHERE nloja = $1 AND validade BETWEEN $2 AND $3 ORDER BY validade, nreg LIMIT $4 OFFSET $5`, p), { loja, de, ate });
  }));
  r.get('/docs/:modulo/:tipo', rota(async (req, res) => {
    const p = [req.params.modulo, req.params.tipo, limiteDe(req.query), offsetDe(req.query)];
    responder(res, await pg.pq('SELECT id, conteudo, atualizado_em FROM doc_json WHERE modulo = $1 AND tipo = $2 ORDER BY atualizado_em DESC LIMIT $3 OFFSET $4', p));
  }));
  r.get('/docs/:modulo/:tipo/:id', rota(async (req, res) => {
    const rows = await pg.pq('SELECT id, conteudo, atualizado_em FROM doc_json WHERE modulo = $1 AND tipo = $2 AND id = $3', [req.params.modulo, req.params.tipo, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'não encontrado' });
    res.json({ ok: true, ...rows[0] });
  }));
  r.get('/arquivos', rota(async (req, res) => {
    const c = String(req.query.caminho || ''); if (!c) return responder(res, await pg.pq('SELECT caminho, tamanho, modificado_em FROM arquivo_json WHERE NOT removido ORDER BY caminho LIMIT $1 OFFSET $2', [limiteDe(req.query), offsetDe(req.query)]));
    const rows = await pg.pq('SELECT caminho, conteudo, modificado_em FROM arquivo_json WHERE caminho = $1 AND NOT removido', [c]);
    if (!rows.length) return res.status(404).json({ error: 'não encontrado' });
    res.json({ ok: true, ...rows[0] });
  }));
  app.use('/api/v1', (req, res, next) => { if (!pg.disponivel()) return res.status(503).json({ error: 'banco indisponível' }); next(); }, r);
}
const diasAtrasNeg = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function init(d) { ARQ = path.join((d && d.dataDir) || path.join(__dirname, '..', 'data'), 'api-chaves.json'); }
function status() { return { chaves: listarChaves().length, ativas: listarChaves().filter(c => c.ativa).length, limitePorMinuto: LIMITE_MIN }; }
module.exports = { init, montar, listarChaves, criarChave, revogarChave, status };
