// lib/pedidos-cd.js — Pedidos do CD (loja 10 → lojas 1-6)
//
// Vínculo caixa↔unidade, sugestão semanal em caixas com as regras do Radar,
// pedidos em JSON e acompanhamento (separado no CD → chegou na loja).
// ERP só leitura. Spec: docs/superpowers/specs/2026-09-11-pedidos-cd-design.md
const fs = require('fs');
const path = require('path');
const u = require('./pedidos-cd-util');
const radar = require('./radar-pedidos');

const LOJAS = [1, 2, 3, 4, 5, 6];
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const CONFIG_PADRAO = { teto: 28, ciclo: 7, leadPadrao: 2, leadMaxPadrao: 3, fornecedorCD: 2157, clientesLoja: { 1: 828, 2: 899, 3: 1300, 4: 1421, 5: 1684, 6: 1969 } };

let deps = null;      // { q, mesDB }
let DATA = null;      // pasta data/
let VINC_ARQ = null, PED_DIR = null, CFG_ARQ = null;
let vinculos = {};    // codigoCD → vinculo
let config = null;

function init(d) {
  deps = d;
  DATA = d.dataDir || path.join(__dirname, '..', 'data');
  VINC_ARQ = path.join(DATA, 'cd-vinculos.json');
  PED_DIR = path.join(DATA, 'pedidos-cd');
  CFG_ARQ = path.join(PED_DIR, 'config.json');
  fs.mkdirSync(PED_DIR, { recursive: true });
  try { vinculos = JSON.parse(fs.readFileSync(VINC_ARQ, 'utf8')); } catch (e) { vinculos = {}; }
  try { config = { ...CONFIG_PADRAO, ...JSON.parse(fs.readFileSync(CFG_ARQ, 'utf8')) }; } catch (e) { config = { ...CONFIG_PADRAO }; }
}
const agora = () => new Date().toISOString();
function gravarVinculos() { fs.writeFileSync(VINC_ARQ, JSON.stringify(vinculos, null, 1)); }
function getConfig() { return { ...config, clientesLoja: { ...config.clientesLoja } }; }
function salvarConfig(parcial) {
  const c = { ...config };
  if (parcial.teto != null) c.teto = Math.max(3, Math.min(90, +parcial.teto || 28));
  if (parcial.fornecedorCD != null) c.fornecedorCD = +parcial.fornecedorCD || CONFIG_PADRAO.fornecedorCD;
  if (parcial.clientesLoja) c.clientesLoja = { ...c.clientesLoja }, Object.entries(parcial.clientesLoja).forEach(([ln, v]) => { if (LOJAS.includes(+ln)) c.clientesLoja[ln] = +v || 0; });
  config = c; fs.writeFileSync(CFG_ARQ, JSON.stringify(config, null, 1));
  return getConfig();
}
function getVinculos() { return vinculos; }

// produtosCD: [{ codigoCD, unPorCaixa (embalagempadrao_venda ou null), unidadeExiste (EAN-13 do DUN-14 se existe ativo no cadastro, senão null) }]
function sincronizarVinculos(produtosCD) {
  for (const p of produtosCD) {
    const cod = String(p.codigoCD);
    const atual = vinculos[cod];
    if (atual && atual.status === 'confirmado') { if (atual.unPorCaixaCadastro !== p.unPorCaixa) { atual.unPorCaixaCadastro = p.unPorCaixa; } continue; }
    if (cod.length <= 13) {
      vinculos[cod] = { codigoCD: cod, unidade: cod, unPorCaixa: 1, unPorCaixaCadastro: p.unPorCaixa, origem: 'igual', status: 'confirmado', confirmadoPor: 'sistema', confirmadoEm: agora() };
      continue;
    }
    const cand = p.unidadeExiste || null;
    vinculos[cod] = { codigoCD: cod, unidade: null, unPorCaixa: (atual && atual.unPorCaixa) || p.unPorCaixa || null, unPorCaixaCadastro: p.unPorCaixa,
      origem: cand ? 'dun14' : null, status: cand ? 'sugerido' : 'pendente', candidato: cand, confirmadoPor: null, confirmadoEm: null };
  }
  gravarVinculos();
  return vinculos;
}
function salvarVinculo({ codigoCD, unidade, unPorCaixa, usuario }) {
  const cod = String(codigoCD || ''); const un = String(unidade || '').trim(); const upc = Math.round(+unPorCaixa);
  if (!cod) throw new Error('codigoCD obrigatório');
  if (!un) throw new Error('unidade obrigatória');
  if (!(upc >= 1)) throw new Error('un/cx inválido (mínimo 1)');
  const atual = vinculos[cod] || { codigoCD: cod };
  const origem = cod === un ? 'igual' : (atual.candidato === un ? 'dun14' : 'manual');
  vinculos[cod] = { ...atual, codigoCD: cod, unidade: un, unPorCaixa: upc, origem, status: 'confirmado', confirmadoPor: usuario || null, confirmadoEm: agora() };
  gravarVinculos();
  return vinculos[cod];
}
function removerVinculo(codigoCD) {
  const cod = String(codigoCD); const atual = vinculos[cod]; if (!atual) return null;
  vinculos[cod] = { ...atual, unidade: null, origem: atual.candidato ? 'dun14' : null, status: atual.candidato ? 'sugerido' : 'pendente', confirmadoPor: null, confirmadoEm: null };
  gravarVinculos();
  return vinculos[cod];
}
async function buscarUnidade(texto) {
  const t = String(texto || '').trim(); if (t.length < 3) return [];
  const rows = await deps.q(`SELECT CodigoBarra cod, TRIM(Descricao) descricao FROM central.itens
    WHERE CodDesativado=0 AND LENGTH(CodigoBarra)<=13 AND (CodigoBarra LIKE ? OR Descricao LIKE ?) ORDER BY Descricao LIMIT 30`, [t + '%', '%' + t + '%']);
  return rows;
}

// ─── coleta do ERP ───────────────────────────────────────────
let estado = { status: 'vazio', atualizadoEm: null, erro: null, duracaoMs: 0 };
let base = null;          // ver montarBase()
let recalculando = null;
const JANELA_VENDA_DIAS = 40;
const iso = d => d.toISOString().slice(0, 10);
const addDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const { num, chunk } = radar;

async function coletarCD() {
  const { q } = deps;
  const est = await q(`SELECT e.CodigoBarra cod, e.Qtd, TRIM(i.Descricao) descricao FROM central.estoquen10 e JOIN central.itens i ON i.CodigoBarra=e.CodigoBarra WHERE e.Qtd>0 AND i.CodDesativado=0`);
  const cods = est.map(r => String(r.cod));
  const emb = {};
  for (const c of chunk(cods.filter(x => x.length === 14), 2000)) {
    for (const r of await q(`SELECT Codigobarra cod, Qtd_venda qv FROM central.embalagempadrao_venda WHERE Codigobarra IN (${c.map(() => '?').join(',')})`, c)) { const v = num(r.qv); if (v >= 1) emb[String(r.cod)] = v; }
  }
  const cand = {}; const candList = cods.map(c => [c, u.dun14ParaEan13(c)]).filter(x => x[1]);
  for (const c of chunk(candList.map(x => x[1]), 2000)) {
    const rows = await q(`SELECT CodigoBarra cod FROM central.itens WHERE CodDesativado=0 AND CodigoBarra IN (${c.map(() => '?').join(',')})`, c);
    const ok = new Set(rows.map(r => String(r.cod)));
    for (const [cd14, ean] of candList) if (ok.has(ean)) cand[cd14] = ean;
  }
  const cd = {};
  for (const r of est) { const c = String(r.cod); cd[c] = { descricao: r.descricao, estoqueCx: num(r.Qtd), unPorCaixaCadastro: c.length === 14 ? (emb[c] || null) : 1 }; }
  sincronizarVinculos(cods.map(c => ({ codigoCD: c, unPorCaixa: cd[c].unPorCaixaCadastro, unidadeExiste: cand[c] || null })));
  return cd;
}

async function coletarUnidades(codigos, hoje) {
  const { q, mesDB } = deps;
  const dFim = addDias(hoje, -1), dIni = addDias(hoje, -JANELA_VENDA_DIAS);
  const meses = new Set(); { const d = new Date(dIni + 'T00:00:00Z'); while (iso(d) <= dFim) { meses.add(d.getUTCMonth() + 1); d.setUTCDate(d.getUTCDate() + 1); } }
  const un = {};
  for (const c of chunk(codigos, 2000)) {
    const ph = c.map(() => '?').join(',');
    for (const r of await q(`SELECT CodigoBarra cod, TRIM(Descricao) descricao, Validar validade FROM central.itens WHERE CodigoBarra IN (${ph})`, c))
      un[String(r.cod)] = { descricao: r.descricao, validade: num(r.validade), custo: 0, porLoja: Object.fromEntries(LOJAS.map(ln => [ln, { vq: 0, est: 0 }])) };
    for (const ln of LOJAS) {
      try { for (const r of await q(`SELECT CodigoBarra cod, Qtd FROM central.estoquen${ln} WHERE CodigoBarra IN (${ph})`, c)) if (un[r.cod]) un[r.cod].porLoja[ln].est = Math.max(0, num(r.Qtd)); } catch (e) {}
      try { for (const r of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, c)) if (un[r.cod] && !un[r.cod].custo && num(r.Custo) > 0) un[r.cod].custo = num(r.Custo); } catch (e) {}
      for (const m of meses) {
        try {
          for (const r of await q(`SELECT Codigo cod, SUM(QtdNovo) qtd FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dIni, dFim, ...c]))
            if (un[r.cod]) un[r.cod].porLoja[ln].vq += num(r.qtd) / JANELA_VENDA_DIAS;
        } catch (e) {}
      }
    }
  }
  return un;
}

// lead por loja: pedido da loja no painel do CD (DataEntrada) → nota do fornecedor do CD na loja (DataRecto), 6 meses
async function calcularLead(hoje) {
  const { q } = deps; const cfg = config; const lead = {};
  const dIni = addDias(hoje, -180);
  for (const ln of LOJAS) {
    lead[ln] = null;
    try {
      const cli = cfg.clientesLoja[ln]; if (!cli) continue;
      const ped = await q(`SELECT DATE_FORMAT(DataEntrada,'%Y-%m-%d') d FROM central.painel_televendas WHERE nLoja=10 AND CodFornec=? AND DataEntrada>=? ORDER BY DataEntrada`, [cli, dIni]);
      const notas = await q(`SELECT DISTINCT DATE_FORMAT(DataRecto,'%Y-%m-%d') d FROM central.compras WHERE nLoja=? AND CodFornec=? AND Movimentacao='COMPRA' AND DataRecto>=? ORDER BY DataRecto`, [ln, cfg.fornecedorCD, dIni]);
      const nd = notas.map(x => x.d);
      const pares = [];
      for (const p of ped) { const n = nd.find(x => x >= p.d); if (n) pares.push({ entrada: p.d, nota: n }); }
      lead[ln] = u.mediaLead(pares);
    } catch (e) { console.error('[PEDIDOS-CD] lead loja', ln, e.message); }
  }
  return lead;
}

async function montarBase() {
  const hoje = iso(new Date());
  const cd = await coletarCD();
  const unidades = [...new Set(Object.values(vinculos).filter(v => v.status === 'confirmado' && v.unidade).map(v => v.unidade))];
  const un = await coletarUnidades(unidades, hoje);
  const lead = await calcularLead(hoje);
  return { hoje, dias: JANELA_VENDA_DIAS, cd, un, lead };
}

async function recalcular() {
  if (recalculando) return recalculando;
  recalculando = (async () => {
    const t0 = Date.now(); estado = { ...estado, status: 'calculando' };
    try { base = await montarBase(); estado = { status: 'ok', atualizadoEm: agora(), erro: null, duracaoMs: Date.now() - t0 }; }
    catch (e) { estado = { ...estado, status: base ? 'ok' : 'erro', erro: e.message, duracaoMs: Date.now() - t0 }; console.error('[PEDIDOS-CD] recalcular:', e.message); }
    finally { recalculando = null; }
    return estado;
  })();
  return recalculando;
}
function getEstado() { return { ...estado, hoje: base?.hoje || null, produtosCD: base ? Object.keys(base.cd).length : 0 }; }

// ─── cálculo (puro em relação ao ERP) ────────────────────────
// transito: { 'unidade|loja': unidades } vindo dos pedidos do CD abertos/separados
function calcularSugestao(b, vinc, cfg, transito) {
  const paramsLoja = {};
  for (const ln of LOJAS) {
    const L = b.lead?.[ln];
    const lead = L ? { lead_medio: L.lead_medio, lead_max: L.lead_max, intervalo: cfg.ciclo } : { lead_medio: cfg.leadPadrao, lead_max: cfg.leadMaxPadrao, intervalo: cfg.ciclo };
    paramsLoja[ln] = radar.paramsLista({}, lead, cfg.teto);
  }
  const repor = [], novos = [];
  for (const [cod, c] of Object.entries(b.cd)) {
    const v = vinc[cod];
    const upc = (v && v.unPorCaixa) || c.unPorCaixaCadastro || null;
    const item = { codigoCD: cod, descricaoCD: c.descricao, unidade: v?.unidade || null, descricaoUn: null, unPorCaixa: upc, estoqueCDcx: c.estoqueCx,
      vqTotal: 0, coberturaTotal: null, custoUn: 0, lojas: {}, totalCx: 0, custoTotal: 0, cdInsuficiente: false, faltaCx: 0, origem: 'novo', semVinculo: !(v && v.status === 'confirmado' && v.unidade) };
    const un = item.unidade ? b.un[item.unidade] : null;
    if (un) { item.descricaoUn = un.descricao; item.custoUn = un.custo; item.vqTotal = +LOJAS.reduce((a, ln) => a + (un.porLoja[ln]?.vq || 0), 0).toFixed(3); }
    const temVenda = !!un && item.vqTotal > 0 && upc >= 1;
    if (temVenda) {
      item.origem = 'repor';
      const p = { cod: item.unidade, lista: 0, emb: 1, embFixa: upc, validade: un.validade, vq: item.vqTotal, lojas: LOJAS, porLoja: {} };
      for (const ln of LOJAS) p.porLoja[ln] = { vq: un.porLoja[ln]?.vq || 0, est: un.porLoja[ln]?.est || 0, transito: transito[`${item.unidade}|${ln}`] || 0 };
      const pedidoCx = {}, cobertura = {};
      for (const ln of LOJAS) {
        const P = paramsLoja[ln]; const r = radar.qtdPedido(p, P, 0, 0);
        const L = p.porLoja[ln]; const cob = L.vq > 0 ? (L.est + L.transito) / L.vq : null;
        pedidoCx[ln] = u.emCaixas(r.porLoja[ln] || 0, upc); cobertura[ln] = cob ?? 9999;
        item.lojas[ln] = { cx: pedidoCx[ln], un: 0, vq: +L.vq.toFixed(2), est: L.est, transito: L.transito, cobertura: cob == null ? null : +cob.toFixed(1), zeraAntes: cob != null && cob < P.lm };
      }
      const d = u.distribuirCdInsuficiente(pedidoCx, c.estoqueCx, cobertura);
      for (const ln of LOJAS) { item.lojas[ln].cx = d.pedidoCx[ln]; item.lojas[ln].un = d.pedidoCx[ln] * upc; }
      item.cdInsuficiente = d.falta > 0; item.faltaCx = d.falta;
      item.coberturaTotal = item.vqTotal > 0 ? +(LOJAS.reduce((a, ln) => a + p.porLoja[ln].est + p.porLoja[ln].transito, 0) / item.vqTotal).toFixed(1) : null;
    } else {
      let sobra = Math.floor(c.estoqueCx);
      for (const ln of LOJAS) { const cx = sobra > 0 ? 1 : 0; sobra -= cx; item.lojas[ln] = { cx, un: upc ? cx * upc : 0, vq: 0, est: un ? (un.porLoja[ln]?.est || 0) : 0, transito: transito[`${item.unidade}|${ln}`] || 0, cobertura: null, zeraAntes: false }; }
    }
    item.totalCx = LOJAS.reduce((a, ln) => a + item.lojas[ln].cx, 0);
    item.custoTotal = +(item.totalCx * (upc || 0) * item.custoUn).toFixed(2);
    (item.origem === 'repor' ? repor : novos).push(item);
  }
  repor.sort((a, b2) => (a.coberturaTotal ?? 9999) - (b2.coberturaTotal ?? 9999));
  novos.sort((a, b2) => a.descricaoCD.localeCompare(b2.descricaoCD));
  return { repor, novos, paramsLoja };
}

function listarPedidos() { return []; }

function transitoPedidos() {
  const t = {};
  for (const p of listarPedidos()) if (p.status === 'aberto' || p.status === 'separado') for (const i of p.itens) t[`${i.unidade}|${p.loja}`] = (t[`${i.unidade}|${p.loja}`] || 0) + i.unidades;
  return t;
}
function sugestao(teto) {
  if (!base) return { repor: [], novos: [], resumo: null, regras: null, estado: getEstado() };
  const cfg = { ...config, teto: teto || config.teto };
  const { repor, novos, paramsLoja } = calcularSugestao(base, vinculos, cfg, transitoPedidos());
  const resumo = { repor: repor.length, novos: novos.length, semVinculo: novos.filter(n => n.semVinculo).length, cdInsuficiente: repor.filter(r => r.cdInsuficiente).length,
    caixas: repor.concat(novos).reduce((a, r) => a + r.totalCx, 0), custo: +repor.concat(novos).reduce((a, r) => a + r.custoTotal, 0).toFixed(2), proximaSegunda: proximaSegunda(base.hoje) };
  const regras = { teto: cfg.teto, ciclo: cfg.ciclo, fracaoValidade: 0.6, lojas: Object.fromEntries(LOJAS.map(ln => [ln, { nome: LOJAS_NOMES[ln], lead: base.lead[ln], ...paramsLoja[ln] }])) };
  return { repor, novos, resumo, regras, estado: getEstado() };
}
function proximaSegunda(hoje) { const d = new Date(hoje + 'T00:00:00Z'); const dow = d.getUTCDay(); return addDias(hoje, dow === 1 ? 0 : (8 - dow) % 7); }

let timer = null;
function agendar() {
  setTimeout(() => recalcular(), 90 * 1000);
  const prox = () => { const n = new Date(); const t = new Date(n); t.setHours(5, 30, 0, 0); if (t <= n) t.setDate(t.getDate() + 1); return t - n; };
  const tick = () => { recalcular(); timer = setTimeout(tick, prox()); };
  timer = setTimeout(tick, prox());
}

module.exports = { init, getConfig, salvarConfig, getVinculos, sincronizarVinculos, salvarVinculo, removerVinculo, buscarUnidade, LOJAS, LOJAS_NOMES,
  recalcular, getEstado, sugestao, calcularSugestao, agendar };
