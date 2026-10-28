'use strict';
// lib/espelho-compras.js — Espelho das COMPRAS do ERP no nosso Postgres (Tiago, 28/10/2026, item 1 do "o que falta":
// central.compraprodutos tem 1,76 milhão de linhas e 2 GB; qualquer varredura por período leva de 18 s a 2 min no .252
// e é o que ainda pesava em Análise de Estoque, Fiscal, Lotes do CD, Sortimento, Radar e Cotações).
//
// Regra: no .252 só SELECT. A cópia é por FAIXA DE CHAVE PRIMÁRIA (nReg, auto-incremento): a carga inicial anda de
// 10 mil em 10 mil nRegs (cada faixa é um range na PK, milissegundos no ERP) e retoma de onde parou; depois, a cada
// 15 min, copia as notas recentes (central.compras por DataRecto, que tem índice) e os itens dessas notas (por nCompra,
// que tem índice) — pega nota nova e nota que mudou de status/custo. Duas vezes por dia refaz os últimos 60 dias.
//
// Tabelas: compra_nota (central.compras, 240 mil) e compra_item (central.compraprodutos). Números do ERP vêm como
// texto "2.540,50" → numErp. Datas como texto 'YYYY-MM-DD'.
const pg = require('./pg');

let deps = {};                       // { q, espelho (lib/espelho-erp: emBackup, horaDeHoje, hojeLocal), registrar }
let pronto = false, erro = null;
let carga = { itens: { ate: 0, max: 0, feito: 0, completa: false }, notas: { ate: 0, max: 0, feito: 0, completa: false }, rodando: false, pausada: false, iniciadaEm: null, terminadaEm: null, ultimoErro: null };
let sync = { ultimaEm: null, ultimoErro: null, ms: null, notas: 0, itens: 0, rodando: false };
let recopia = { ultimaEm: null, ultimoErro: null, feitaEm: {} };
const PASSO_ITENS = 10000, PASSO_NOTAS = 20000, LOTE = 400, PAUSA_MS = 300;
const HORAS_RECOPIA = ['07:50', '13:00'], DIAS_SYNC = 7, DIAS_RECOPIA = 60;
const SYNC_CADA_MS = 15 * 60 * 1000;

const pad = n => String(n).padStart(2, '0');
const dorme = ms => new Promise(r => setTimeout(r, ms));
// "2.540,50" → 2540.5 · "8,9" → 8.9 · "0.00" → 0 · "" → null
const numErp = v => { if (v == null) return null; let s = String(v).trim(); if (!s) return null; if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : null; };
const intOu = v => { const n = parseInt(v, 10); return isFinite(n) ? n : null; };
const txt = (v, n) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
const dataTxt = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`; const s = String(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && s !== '0000-00-00' ? s : null; };
function hojeLocal() { return deps.espelho ? deps.espelho.hojeLocal() : new Date().toISOString().slice(0, 10); }
function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function podeTocarErp() { return !(deps.espelho && (deps.espelho.emBackup() || !deps.espelho.horaDeHoje())); }

// ── esquema ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function criarEsquema() {
  await pg.pq(`CREATE TABLE IF NOT EXISTS compra_nota (
    nreg bigint PRIMARY KEY, ncompra bigint, nloja smallint, nnota varchar(45), serie varchar(5), modelo varchar(5),
    codfornec bigint, nomefornec varchar(120), cnpj varchar(14), datalan date, dataemissao date, datarecto date, datastatus date,
    status varchar(2), movimentacao varchar(45), tipo varchar(45), totalnota numeric(14,2), totalprodutos numeric(14,2),
    totaldesconto numeric(14,2), totalfrete numeric(14,2), totalipi numeric(14,2), totalicmssub numeric(14,2),
    chave varchar(45), numeropedido bigint, statusconferencia integer, nconferencia bigint, codvendedor integer, cfop varchar(45),
    recebido integer, uf varchar(2), atualizado_em timestamptz NOT NULL DEFAULT now()
  )`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS compra_nota_loja_compra ON compra_nota (nloja, ncompra)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS compra_nota_recto ON compra_nota (datarecto)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS compra_nota_lan ON compra_nota (datalan)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS compra_nota_fornec ON compra_nota (codfornec, datarecto)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS compra_nota_chave ON compra_nota (chave)`);
  await pg.pq(`CREATE TABLE IF NOT EXISTS compra_item (
    nreg bigint PRIMARY KEY, ncompra bigint, nloja smallint, item integer, codigo varchar(14), unid varchar(5),
    qtd numeric(14,3), qtdemb numeric(12,3), qtdentrada numeric(14,3), preco numeric(14,4), custo numeric(14,4), total numeric(14,2),
    precovenda numeric(12,2), descricao varchar(45), dataentrada date, movimentacao varchar(45), tipo varchar(5), status varchar(1),
    cancelado integer, bonificacao numeric(14,2), custobonificado numeric(12,2), qtdbonificado numeric(10,3), valorbonificado numeric(12,2),
    nnota varchar(15), serie varchar(3), cnpj varchar(14), nconferencia bigint, formacaopreco integer, valordesconto numeric(14,2),
    valoripi numeric(14,2), valoricmsst numeric(14,2), cfop varchar(4), cst varchar(3), oceantrib varchar(20), devolvido integer,
    atualizado_em timestamptz NOT NULL DEFAULT now()
  )`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS compra_item_codigo ON compra_item (codigo, dataentrada)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS compra_item_loja_compra ON compra_item (nloja, ncompra)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS compra_item_entrada ON compra_item (dataentrada)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS compra_item_conf ON compra_item (nconferencia)`);
}
async function kvLer(c, padrao) { const r = await pg.pq('SELECT valor FROM espelho_kv WHERE chave = $1', [c]); return r.length ? r[0].valor : padrao; }
async function kvGravar(c, v) { await pg.pq('INSERT INTO espelho_kv (chave, valor, em) VALUES ($1, $2, now()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, em = now()', [c, JSON.stringify(v)]); }
async function salvarCarga() { await kvGravar('compras.carga', { itens: carga.itens, notas: carga.notas, iniciadaEm: carga.iniciadaEm, terminadaEm: carga.terminadaEm }).catch(() => {}); }

// ── colunas ──────────────────────────────────────────────────────────────────────────────────────────────────────
const SEL_NOTA = `nReg, nCompra, nLoja, nNota, Serie, Modelo, CodFornec, NomeFornec, CNPJ, DataLan, DataEmissao, DataRecto, DataStatus, Status, Movimentacao, Tipo,
  TotalNota, TotalProdutos, TotalDesconto, TotalFrete, TotalIPI, TotalICMSSub, chave, NumeroPedido, StatusConferencia, nConferencia, CodVendedor, cfop, Recebido, UF`;
const COLS_NOTA = ['nreg', 'ncompra', 'nloja', 'nnota', 'serie', 'modelo', 'codfornec', 'nomefornec', 'cnpj', 'datalan', 'dataemissao', 'datarecto', 'datastatus', 'status', 'movimentacao', 'tipo',
  'totalnota', 'totalprodutos', 'totaldesconto', 'totalfrete', 'totalipi', 'totalicmssub', 'chave', 'numeropedido', 'statusconferencia', 'nconferencia', 'codvendedor', 'cfop', 'recebido', 'uf'];
const linhaNota = r => [Number(r.nReg), intOu(r.nCompra), intOu(r.nLoja), txt(r.nNota, 45), txt(r.Serie, 5), txt(r.Modelo, 5), intOu(r.CodFornec), txt(r.NomeFornec, 120), txt(r.CNPJ, 14),
  dataTxt(r.DataLan), dataTxt(r.DataEmissao), dataTxt(r.DataRecto), dataTxt(r.DataStatus), txt(r.Status, 2), txt(r.Movimentacao, 45), txt(r.Tipo, 45),
  numErp(r.TotalNota), numErp(r.TotalProdutos), numErp(r.TotalDesconto), numErp(r.TotalFrete), numErp(r.TotalIPI), numErp(r.TotalICMSSub), txt(r.chave, 45), intOu(r.NumeroPedido),
  intOu(r.StatusConferencia), intOu(r.nConferencia), intOu(r.CodVendedor), txt(r.cfop, 45), intOu(r.Recebido), txt(r.UF, 2)];
const SEL_ITEM = `nReg, nCompra, nLoja, Item, CodigoBarra, Unid, Qtd, QtdEmb, QtdEntradaEstoque, Preco, Custo, Total, PrecoVenda, Descricao, DataEntrada, Movimentacao, Tipo, Status,
  Cancelado, Bonificacao, CustoBonificado, QtdBonificado, ValorBonificado, NNOTA, SERIE, CNPJ, nConferencia, FormacaoPreco, ValorDESCONTO, ValorIPI, ValorICMSST, CFOP, CST, ocEanTrib, devolvido`;
const COLS_ITEM = ['nreg', 'ncompra', 'nloja', 'item', 'codigo', 'unid', 'qtd', 'qtdemb', 'qtdentrada', 'preco', 'custo', 'total', 'precovenda', 'descricao', 'dataentrada', 'movimentacao', 'tipo', 'status',
  'cancelado', 'bonificacao', 'custobonificado', 'qtdbonificado', 'valorbonificado', 'nnota', 'serie', 'cnpj', 'nconferencia', 'formacaopreco', 'valordesconto', 'valoripi', 'valoricmsst', 'cfop', 'cst', 'oceantrib', 'devolvido'];
const linhaItem = r => [Number(r.nReg), intOu(r.nCompra), intOu(r.nLoja), intOu(r.Item), txt(r.CodigoBarra, 14), txt(r.Unid, 5), numErp(r.Qtd), numErp(r.QtdEmb), numErp(r.QtdEntradaEstoque), numErp(r.Preco), numErp(r.Custo), numErp(r.Total),
  numErp(r.PrecoVenda), txt(r.Descricao, 45), dataTxt(r.DataEntrada), txt(r.Movimentacao, 45), txt(r.Tipo, 5), txt(r.Status, 1),
  intOu(r.Cancelado), numErp(r.Bonificacao), numErp(r.CustoBonificado), numErp(r.QtdBonificado), numErp(r.ValorBonificado), txt(r.NNOTA, 15), txt(r.SERIE, 3), txt(r.CNPJ, 14), intOu(r.nConferencia), intOu(r.FormacaoPreco),
  numErp(r.ValorDESCONTO), numErp(r.ValorIPI), numErp(r.ValorICMSST), txt(r.CFOP, 4), txt(r.CST, 3), txt(r.ocEanTrib, 20), intOu(r.devolvido)];

async function gravar(tabela, cols, linhas) {
  if (!linhas.length) return 0;
  await pg.tx(async c => {
    for (let i = 0; i < linhas.length; i += LOTE) {
      const lote = linhas.slice(i, i + LOTE); const vals = [], ph = [];
      lote.forEach((v, j) => { const b = j * cols.length; ph.push('(' + v.map((_, k) => `$${b + k + 1}`).join(',') + ',now())'); vals.push(...v); });
      await c.query(`INSERT INTO ${tabela} (${cols.join(',')}, atualizado_em) VALUES ${ph.join(',')}
                     ON CONFLICT (nreg) DO UPDATE SET ${cols.filter(x => x !== 'nreg').map(x => `${x} = EXCLUDED.${x}`).join(', ')}, atualizado_em = now()`, vals);
    }
  });
  return linhas.length;
}
async function copiarNotasFaixa(a, b) { const rows = await deps.q(`SELECT ${SEL_NOTA} FROM central.compras WHERE nReg BETWEEN ? AND ?`, [a, b], { timeoutMs: 120000 }); return gravar('compra_nota', COLS_NOTA, rows.map(linhaNota)); }
async function copiarItensFaixa(a, b) { const rows = await deps.q(`SELECT ${SEL_ITEM} FROM central.compraprodutos WHERE nReg BETWEEN ? AND ?`, [a, b], { timeoutMs: 120000 }); return gravar('compra_item', COLS_ITEM, rows.map(linhaItem)); }
async function copiarItensDasNotas(pares) {
  // pares = [{ncompra, nloja}]; nCompra tem índice no ERP; nCompra repete entre lojas, por isso filtra nLoja junto
  let n = 0;
  for (let i = 0; i < pares.length; i += 300) {
    const ch = pares.slice(i, i + 300); const nc = [...new Set(ch.map(p => p.ncompra))];
    const rows = await deps.q(`SELECT ${SEL_ITEM} FROM central.compraprodutos WHERE nCompra IN (${nc.map(() => '?').join(',')})`, nc, { timeoutMs: 120000 });
    n += await gravar('compra_item', COLS_ITEM, rows.map(linhaItem));
  }
  return n;
}

// ── carga inicial (retomável) ────────────────────────────────────────────────────────────────────────────────────
async function cargaInicial(forcada) {
  if (carga.rodando) return { ok: false, motivo: 'já rodando' };
  carga.rodando = true; carga.pausada = false; carga.iniciadaEm = carga.iniciadaEm || new Date().toISOString();
  try {
    for (const [nome, tabela, passo, fn] of [['notas', 'central.compras', PASSO_NOTAS, copiarNotasFaixa], ['itens', 'central.compraprodutos', PASSO_ITENS, copiarItensFaixa]]) {
      const c = carga[nome];
      if (c.completa) continue;
      if (!c.max) { const [m] = await deps.q(`SELECT MIN(nReg) mn, MAX(nReg) mx FROM ${tabela}`, [], { timeoutMs: 60000 }); c.ate = c.ate || Math.max(0, Number(m.mn) - 1); c.max = Number(m.mx); }
      while (c.ate < c.max) {
        if (carga.pausada) return { ok: false, motivo: 'pausada' };
        if (!forcada && !podeTocarErp()) { await dorme(60000); continue; }
        const a = c.ate + 1, b = Math.min(c.ate + passo, c.max);
        try { c.feito += await fn(a, b); c.ate = b; carga.ultimoErro = null; }
        catch (e) { carga.ultimoErro = `${nome} ${a}-${b}: ${e.message}`; console.error('[ESPELHO-COMPRAS] carga', carga.ultimoErro); await dorme(10000); continue; }
        if ((b / passo) % 5 === 0) await salvarCarga();
        await dorme(PAUSA_MS);
      }
      c.completa = true; await salvarCarga();
      console.log(`[ESPELHO-COMPRAS] carga de ${nome} completa: ${c.feito} linhas (nReg até ${c.max})`);
    }
    carga.terminadaEm = carga.terminadaEm || new Date().toISOString(); await salvarCarga();
    return { ok: true };
  } finally { carga.rodando = false; }
}

// ── sincronização (15 min): notas recentes por DataRecto + itens dessas notas + nReg novos ──────────────────────
async function sincronizar(dias = DIAS_SYNC, origem = 'sync') {
  if (sync.rodando) return { ok: false, motivo: 'já rodando' };
  if (!carga.notas.completa || !carga.itens.completa) return { ok: false, motivo: 'carga inicial ainda não terminou' };
  if (origem !== 'manual' && !podeTocarErp()) return { ok: false, motivo: 'fora do horário / ERP em backup' };
  sync.rodando = true; const t0 = Date.now();
  try {
    const desde = somaDias(hojeLocal(), -dias);
    // 1. notas recentes (DataRecto tem índice) + notas novas por nReg (pega as sem DataRecto)
    const [mx] = await pg.pq('SELECT COALESCE(MAX(nreg), 0) m FROM compra_nota');
    const notas = await deps.q(`SELECT ${SEL_NOTA} FROM central.compras WHERE DataRecto >= ? OR DataLan >= ? OR nReg > ?`, [desde, desde, Number(mx.m)], { timeoutMs: 120000 });
    const nN = await gravar('compra_nota', COLS_NOTA, notas.map(linhaNota));
    // 2. itens dessas notas (por nCompra, com índice) + itens novos por nReg
    const pares = notas.map(r => ({ ncompra: intOu(r.nCompra), nloja: intOu(r.nLoja) })).filter(p => p.ncompra);
    let nI = await copiarItensDasNotas(pares);
    const [mi] = await pg.pq('SELECT COALESCE(MAX(nreg), 0) m FROM compra_item');
    const [mErp] = await deps.q('SELECT MAX(nReg) mx FROM central.compraprodutos', [], { timeoutMs: 30000 });
    if (Number(mErp.mx) > Number(mi.m)) nI += await copiarItensFaixa(Number(mi.m) + 1, Number(mErp.mx));
    sync.ultimaEm = new Date().toISOString(); sync.ms = Date.now() - t0; sync.notas = nN; sync.itens = nI; sync.ultimoErro = null;
    if (deps.registrar) deps.registrar({ loja: null, dia: null, linhas: nN + nI, ms: sync.ms, erro: null, origem: 'compras-' + origem });
    return { ok: true, notas: nN, itens: nI, ms: sync.ms };
  } catch (e) {
    sync.ultimoErro = e.message; if (deps.registrar) deps.registrar({ loja: null, dia: null, linhas: null, ms: Date.now() - t0, erro: e.message, origem: 'compras-' + origem });
    throw e;
  } finally { sync.rodando = false; }
}

// ── leituras pras telas (null = compras ainda não carregadas) ───────────────────────────────────────────────────
function disponivel() { return pronto && carga.notas.completa && carga.itens.completa; }
// Compras por loja e produto no período (DataEntrada), só Movimentacao='COMPRA' por padrão.
async function comprasPeriodo(lojas, dIni, dFim, opt = {}) {
  if (!disponivel()) return null;
  const mov = opt.movimentacao === null ? null : (opt.movimentacao || 'COMPRA');
  const cods = Array.isArray(opt.codigos) ? opt.codigos.map(c => String(c).slice(0, 14)) : null; if (cods && !cods.length) return [];
  const p = [lojas, dIni, dFim]; let w = 'nloja = ANY($1) AND dataentrada BETWEEN $2 AND $3 AND COALESCE(cancelado, 0) = 0';
  if (mov) { p.push(mov); w += ` AND movimentacao = $${p.length}`; }
  if (cods) { p.push(cods); w += ` AND codigo = ANY($${p.length})`; }
  return pg.pq(`SELECT nloja loja, codigo, SUM(qtd) qtd, SUM(qtdentrada) qtdentrada, SUM(total) total, SUM(custo * qtdentrada) custo_total,
                       MAX(dataentrada)::text ultima, MIN(dataentrada)::text primeira, COUNT(*) n, COUNT(DISTINCT ncompra) notas
                FROM compra_item WHERE ${w} GROUP BY nloja, codigo`, p);
}
// Última compra de cada produto (por loja ou geral) com custo, embalagem, fornecedor — pra Cotações/Sortimento/Radar.
async function ultimasCompras(codigos, opt = {}) {
  if (!disponivel()) return null;
  const cods = (codigos || []).map(c => String(c).slice(0, 14)); if (!cods.length) return [];
  const desde = opt.desde || somaDias(hojeLocal(), -(opt.dias || 730));
  const p = [cods, desde]; let w = 'i.codigo = ANY($1) AND i.dataentrada >= $2 AND COALESCE(i.cancelado, 0) = 0 AND i.movimentacao = \'COMPRA\'';
  if (opt.lojas) { p.push(opt.lojas); w += ` AND i.nloja = ANY($${p.length})`; }
  return pg.pq(`SELECT DISTINCT ON (i.codigo${opt.porLoja ? ', i.nloja' : ''}) i.codigo, i.nloja loja, i.dataentrada::text dt, i.qtd, i.qtdemb, i.qtdentrada, i.preco, i.custo, i.total, i.unid, i.nnota, i.ncompra, n.codfornec, n.nomefornec
                FROM compra_item i LEFT JOIN compra_nota n ON n.nloja = i.nloja AND n.ncompra = i.ncompra
                WHERE ${w} ORDER BY i.codigo${opt.porLoja ? ', i.nloja' : ''}, i.dataentrada DESC, i.nreg DESC`, p);
}
// Notas do período (DataRecto por padrão) com filtros simples.
async function notasPeriodo(lojas, dIni, dFim, opt = {}) {
  if (!disponivel()) return null;
  const campo = opt.campoData === 'datalan' ? 'datalan' : 'datarecto';
  const p = [lojas, dIni, dFim]; let w = `nloja = ANY($1) AND ${campo} BETWEEN $2 AND $3`;
  if (opt.movimentacao) { p.push(opt.movimentacao); w += ` AND movimentacao = $${p.length}`; }
  if (opt.tipos) { p.push(opt.tipos); w += ` AND tipo = ANY($${p.length})`; }
  if (opt.status) { p.push(opt.status); w += ` AND status = $${p.length}`; }
  if (opt.codfornec) { p.push(opt.codfornec); w += ` AND codfornec = $${p.length}`; }
  return pg.pq(`SELECT nreg, ncompra, nloja loja, nnota, serie, codfornec, nomefornec, cnpj, datalan::text datalan, dataemissao::text dataemissao, datarecto::text datarecto, status, movimentacao, tipo,
                       totalnota, totalprodutos, totaldesconto, chave, numeropedido, nconferencia
                FROM compra_nota WHERE ${w} ORDER BY ${campo}, nreg`, p);
}

// ── status / ações ───────────────────────────────────────────────────────────────────────────────────────────────
async function status() {
  let banco = null;
  try { banco = (await pg.pq(`SELECT (SELECT COUNT(*) FROM compra_nota) notas, (SELECT COUNT(*) FROM compra_item) itens, (SELECT MIN(dataentrada)::text FROM compra_item) primeira, (SELECT MAX(dataentrada)::text FROM compra_item) ultima,
                                     pg_size_pretty(pg_total_relation_size('compra_item') + pg_total_relation_size('compra_nota')) tamanho`))[0]; } catch (e) {}
  const pct = c => (c.max ? Math.min(100, Math.round((c.ate / c.max) * 100)) : 0);
  return { pronto, erro, disponivel: disponivel(), banco, carga: { ...carga, pctNotas: pct(carga.notas), pctItens: pct(carga.itens) }, sync, recopia, horasRecopia: HORAS_RECOPIA };
}
async function acao(nome) {
  if (!pronto) throw new Error(erro ? 'Espelho de compras sem banco: ' + erro : 'Espelho de compras ainda não iniciou');
  if (nome === 'compras-carga') { cargaInicial(true).catch(e => { carga.ultimoErro = e.message; }); return { ok: true, rodando: true }; }
  if (nome === 'compras-pausar') { carga.pausada = true; return { ok: true }; }
  if (nome === 'compras-sync') return sincronizar(DIAS_SYNC, 'manual');
  if (nome === 'compras-recopiar') return sincronizar(DIAS_RECOPIA, 'manual');
  throw new Error('ação desconhecida');
}

let timers = [];
function init(d) {
  deps = d || {};
  if (!pg.disponivel()) { erro = 'Postgres não configurado'; return; }
  (async () => {
    try {
      await criarEsquema();
      const salvo = await kvLer('compras.carga', null);
      if (salvo) { carga.itens = { ...carga.itens, ...salvo.itens }; carga.notas = { ...carga.notas, ...salvo.notas }; carga.iniciadaEm = salvo.iniciadaEm || null; carga.terminadaEm = salvo.terminadaEm || null; }
      pronto = true;
      console.log(`[ESPELHO-COMPRAS] pronto: notas ${carga.notas.completa ? 'completas' : carga.notas.ate + '/' + carga.notas.max}, itens ${carga.itens.completa ? 'completos' : carga.itens.ate + '/' + carga.itens.max}`);
      // carga inicial continua sozinha no horário comercial (fora do backup); sync a cada 15 min; recópia 60 d nas horas marcadas
      timers.push(setTimeout(() => { if (!(carga.notas.completa && carga.itens.completa) && podeTocarErp()) cargaInicial(false).catch(e => { carga.ultimoErro = e.message; }); }, 2 * 60 * 1000));
      timers.push(setInterval(() => sincronizar().catch(() => {}), SYNC_CADA_MS));
      timers.push(setInterval(() => {
        const dt = new Date(); const hm = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`; const h = hojeLocal();
        if (HORAS_RECOPIA.includes(hm) && recopia.feitaEm[hm] !== h && podeTocarErp()) { recopia.feitaEm[hm] = h; sincronizar(DIAS_RECOPIA, 'recopia').then(() => { recopia.ultimaEm = new Date().toISOString(); recopia.ultimoErro = null; }).catch(e => { recopia.ultimoErro = e.message; }); }
        if (!(carga.notas.completa && carga.itens.completa) && !carga.rodando && !carga.pausada && podeTocarErp()) cargaInicial(false).catch(e => { carga.ultimoErro = e.message; });
      }, 60 * 1000));
      timers.forEach(t => t.unref && t.unref());
    } catch (e) { erro = e.message; console.error('[ESPELHO-COMPRAS] falhou ao iniciar:', e.message); }
  })();
}

module.exports = { init, status, acao, disponivel, comprasPeriodo, ultimasCompras, notasPeriodo, sincronizar, cargaInicial, numErp, _estado: () => ({ pronto, carga, sync }) };
