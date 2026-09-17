// lib/pedidos-cd.js — Pedidos do CD (loja 10 → lojas 1-6)
//
// Vínculo caixa↔unidade, sugestão semanal em caixas com as regras do Radar,
// pedidos em JSON e acompanhamento (separado no CD → chegou na loja).
// ERP só leitura. Spec: docs/superpowers/specs/2026-09-11-pedidos-cd-design.md
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const u = require('./pedidos-cd-util');
const radar = require('./radar-pedidos');

const LOJAS = [1, 2, 3, 4, 5, 6];
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const CONFIG_PADRAO = { teto: 28, ciclo: 7, leadPadrao: 2, leadMaxPadrao: 3, fornecedorCD: 2157, whatsCD: '', clientesLoja: { 1: 828, 2: 899, 3: 1300, 4: 1421, 5: 1684, 6: 1969 } };

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
  try { vinculos = JSON.parse(fs.readFileSync(VINC_ARQ, 'utf8')); }
  catch (e) { vinculos = {}; if (e.code !== 'ENOENT') console.error('[PEDIDOS-CD] cd-vinculos.json ilegível:', e.message); }
  try { config = { ...CONFIG_PADRAO, ...JSON.parse(fs.readFileSync(CFG_ARQ, 'utf8')) }; }
  catch (e) { config = { ...CONFIG_PADRAO }; if (e.code !== 'ENOENT') console.error('[PEDIDOS-CD] config.json ilegível:', e.message); }
}
const agora = () => new Date().toISOString();
function gravarVinculos() { fs.writeFileSync(VINC_ARQ, JSON.stringify(vinculos, null, 1)); }
function getConfig() { return { ...config, clientesLoja: { ...config.clientesLoja } }; }
function salvarConfig(parcial) {
  const c = { ...config };
  if (parcial.teto != null) {
    const t = +parcial.teto;
    if (!(t >= 3 && t <= 90)) throw new Error('teto inválido (3–90)');
    c.teto = t;
  }
  if (parcial.fornecedorCD != null) {
    const f = +parcial.fornecedorCD;
    if (!(Number.isInteger(f) && f > 0)) throw new Error('fornecedorCD inválido');
    c.fornecedorCD = f;
  }
  if (parcial.whatsCD != null) {
    const w = String(parcial.whatsCD).replace(/\D/g, '');
    if (w && !(w.length >= 10 && w.length <= 13)) throw new Error('WhatsApp do CD inválido (DDD + número)');
    c.whatsCD = w;
  }
  if (parcial.clientesLoja) {
    c.clientesLoja = { ...c.clientesLoja };
    for (const [ln, v] of Object.entries(parcial.clientesLoja)) {
      if (!LOJAS.includes(+ln)) continue;
      const n = +v;
      if (!(Number.isInteger(n) && n > 0)) throw new Error(`cliente da loja ${ln} inválido`);
      c.clientesLoja[ln] = n;
    }
  }
  config = c;
  fs.writeFileSync(CFG_ARQ, JSON.stringify(config, null, 1));
  return getConfig();
}
function getVinculos() { return vinculos; }

// produtosCD: [{ codigoCD, unPorCaixa (embalagempadrao_venda ou null), unidadeExiste (EAN-13 do DUN-14 se existe ativo no cadastro, senão null),
//   candidatoDescricao (unidade casada pela descrição, senão null), alternativas ([{cod, descricao}] parecidas pela descrição) }]
function sincronizarVinculos(produtosCD) {
  for (const p of produtosCD) {
    const cod = String(p.codigoCD);
    const atual = vinculos[cod];
    if (atual) { if (p.descricaoCD) atual.descricaoCD = p.descricaoCD; if (p.estoqueCx != null) atual.estoqueCx = p.estoqueCx; atual.estoqueUn = p.estoqueUn ?? null; }
    if (atual && atual.status === 'confirmado') {
      // vínculo 'igual' confirmado pelo sistema acompanha o cadastro (un/cx); se alguém editou na tela, fica o editado
      if (atual.origem === 'igual' && atual.confirmadoPor === 'sistema' && p.unPorCaixa >= 1 && atual.unPorCaixa !== p.unPorCaixa) atual.unPorCaixa = p.unPorCaixa; if (atual.unPorCaixaCadastro !== p.unPorCaixa) { atual.unPorCaixaCadastro = p.unPorCaixa; } continue; }
    if (cod.length <= 13) {
      vinculos[cod] = { codigoCD: cod, unidade: cod, unPorCaixa: p.unPorCaixa >= 1 ? p.unPorCaixa : 1, unPorCaixaCadastro: p.unPorCaixa, origem: 'igual', status: 'confirmado', confirmadoPor: 'sistema', confirmadoEm: agora(), descricaoCD: p.descricaoCD || null, estoqueCx: p.estoqueCx ?? null, estoqueUn: p.estoqueUn ?? null };
      continue;
    }
    // candidato: 1º pelo código de barras (DUN-14 → EAN-13), senão pela descrição (mesmas palavras, ordem diferente)
    const cand = p.unidadeExiste || p.candidatoDescricao || null;
    const origem = p.unidadeExiste ? 'dun14' : (p.candidatoDescricao ? 'descricao' : null);
    // descrição da unidade candidata, pra quem confere saber o que é sem abrir o ERP
    const descricaoCandidato = p.unidadeExiste ? (p.descricaoUnidadeExiste || null) : (((p.alternativas || []).find(a => a.cod === cand) || {}).descricao || null);
    vinculos[cod] = { codigoCD: cod, unidade: null, unPorCaixa: (atual && atual.unPorCaixa) || p.unPorCaixa || null, unPorCaixaCadastro: p.unPorCaixa,
      origem, status: cand ? 'sugerido' : 'pendente', candidato: cand, descricaoCandidato, candidatoDescricao: p.candidatoDescricao || null, alternativas: p.alternativas || [], confirmadoPor: null, confirmadoEm: null, descricaoCD: p.descricaoCD || null, estoqueCx: p.estoqueCx ?? null, estoqueUn: p.estoqueUn ?? null };
  }
  gravarVinculos();
  return vinculos;
}
function salvarVinculo({ codigoCD, unidade, unPorCaixa, usuario }) {
  const cod = String(codigoCD || ''); const un = String(unidade || '').trim(); const upc = Math.round(+unPorCaixa);
  if (!/^\d{1,14}$/.test(cod)) throw new Error('codigoCD inválido');
  if (!un) throw new Error('unidade obrigatória');
  if (!(upc >= 1)) throw new Error('un/cx inválido (mínimo 1)');
  const atual = vinculos[cod] || { codigoCD: cod };
  const origem = cod === un ? 'igual' : (atual.candidato === un ? (atual.origem || 'dun14') : 'manual');
  vinculos[cod] = { ...atual, codigoCD: cod, unidade: un, unPorCaixa: upc, origem, status: 'confirmado', confirmadoPor: usuario || null, confirmadoEm: agora() };
  gravarVinculos();
  return vinculos[cod];
}
function removerVinculo(codigoCD) {
  const cod = String(codigoCD);
  if (!/^\d{1,14}$/.test(cod)) throw new Error('codigoCD inválido');
  const atual = vinculos[cod]; if (!atual) return null;
  vinculos[cod] = { ...atual, unidade: null, origem: atual.candidato ? (atual.candidato === atual.candidatoDescricao ? 'descricao' : 'dun14') : null, status: atual.candidato ? 'sugerido' : 'pendente', confirmadoPor: null, confirmadoEm: null };
  gravarVinculos();
  return vinculos[cod];
}
async function buscarUnidade(texto) {
  // igual ao ERP: "nescau%180" ou "nescau 180" = descrição contendo NESCAU e depois 180; só dígitos = código começando com
  const t = String(texto || '').trim(); if (t.length < 3) return [];
  const termos = t.split(/[%\s]+/).filter(Boolean);
  const cond = [], params = [];
  if (/^\d+$/.test(t)) { cond.push('CodigoBarra LIKE ?'); params.push(t + '%'); }
  if (termos.length) { cond.push('Descricao LIKE ?'); params.push('%' + termos.join('%') + '%'); }
  const rows = await deps.q(`SELECT CodigoBarra cod, TRIM(Descricao) descricao FROM central.itens
    WHERE CodDesativado=0 AND LENGTH(CodigoBarra)<=13 AND (${cond.join(' OR ')}) ORDER BY Descricao LIMIT 40`, params);
  return rows;
}

// ─── coleta do ERP ───────────────────────────────────────────
let estado = { status: 'vazio', atualizadoEm: null, erro: null, duracaoMs: 0 };
let base = null;          // ver montarBase()
let recalculando = null;
const JANELA_VENDA_DIAS = 40;
const JANELA_PEDIDO_DIAS = 30;
const iso = d => d.toISOString().slice(0, 10);
// data/hora LOCAL (o ERP guarda horário local, não UTC) — usado pra "hoje" e pra comparar com criadoEm
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const { num, chunk } = radar;

async function coletarCD() {
  const { q } = deps;
  // itens.qtdemb = embalagem do cadastro do produto (fallback pra un/cx quando não há "Embalagem Vendas")
  const est = await q(`SELECT e.CodigoBarra cod, e.Qtd, TRIM(i.Descricao) descricao, i.qtdemb FROM central.estoquen10 e JOIN central.itens i ON i.CodigoBarra=e.CodigoBarra WHERE e.Qtd>0 AND i.CodDesativado=0`);
  const cods = est.map(r => String(r.cod));
  // un/cx pra TODOS os códigos (caixa 14 dígitos e também unidade 13 dígitos: o CD vende caixa fechada mesmo quando
  // o código é o de unidade — pedido do Tiago: "se tiver em unidade transforme pra caixa, arredonda pra cima")
  // embalagempadrao_venda = tela Televendas > Cadastro de Itens > Itens App. Qtd_venda = un/cx.
  // emb_multipla (o "X" da tela) = 1: o CD estoca em UNIDADES e vende em caixa (ALA 379 un ÷ 27 = 14 cx);
  // = 0: o estoque do CD já está na embalagem de venda (ARROZ EMOÇÕES FD10: 300 = 300 fardos, não 30).
  const emb = {}, embMult = {};
  for (const c of chunk(cods, 2000)) {
    for (const r of await q(`SELECT Codigobarra cod, Qtd_venda qv, emb_multipla em FROM central.embalagempadrao_venda WHERE Codigobarra IN (${c.map(() => '?').join(',')})`, c)) { const v = num(r.qv); if (v >= 1) { emb[String(r.cod)] = v; embMult[String(r.cod)] = r.em == null ? null : num(r.em); } }
  }
  // saco de ração: embalagem = peso (SC20KG com 20) → vende por saco, un/cx 1
  for (const r of est) { const c = String(r.cod); if (emb[c] && u.embalagemEhPeso(r.descricao, emb[c])) emb[c] = 1; }
  const cand = {}, candDesc = {}; const candList = cods.map(c => [c, u.dun14ParaEan13(c)]).filter(x => x[1]);
  for (const c of chunk(candList.map(x => x[1]), 2000)) {
    const rows = await q(`SELECT CodigoBarra cod, TRIM(Descricao) descricao FROM central.itens WHERE CodDesativado=0 AND CodigoBarra IN (${c.map(() => '?').join(',')})`, c);
    const ok = new Map(rows.map(r => [String(r.cod), r.descricao]));
    for (const [cd14, ean] of candList) if (ok.has(ean)) { cand[cd14] = ean; candDesc[cd14] = ok.get(ean); }
  }
  // caixas (14 dígitos) sem candidato pelo código e ainda não confirmadas: tenta casar pela DESCRIÇÃO
  // ("ARROZ BRANCO POP 1KG PC10" ↔ "POP ARROZ 1KG BRANCO"). Carrega as unidades ativas 1x só quando precisa.
  const porDesc = {};
  const semCand = est.filter(r => { const c = String(r.cod); const v = vinculos[c]; return c.length === 14 && !cand[c] && !(v && v.status === 'confirmado'); });
  if (semCand.length) {
    const unidades = (await q(`SELECT CodigoBarra cod, TRIM(Descricao) descricao FROM central.itens WHERE CodDesativado=0 AND LENGTH(CodigoBarra) BETWEEN 8 AND 13`))
      .map(r => ({ cod: String(r.cod), descricao: r.descricao, tokens: u.tokensDescricao(r.descricao) }));
    for (const r of semCand) porDesc[String(r.cod)] = u.casarPorDescricao(r.descricao, unidades);
  }
  // custo do CD (custoloja10) pelo código do CD: é por CAIXA quando o CD conta em caixas (Clorito 19,08/cx),
  // por UNIDADE quando conta em unidades (ALA 2,18/un) — o painel mostra sempre o custo por caixa
  const custoCD = {};
  for (const c of chunk(cods, 2000)) {
    for (const r of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja10 WHERE CodigoBarra IN (${c.map(() => '?').join(',')})`, c)) { const v = num(r.Custo); if (v > 0) custoCD[String(r.cod)] = v; }
  }
  const cd = {};
  for (const r of est) {
    const c = String(r.cod); const qtd = num(r.Qtd); const qtdemb = num(r.qtdemb);
    if (c.length === 14) {
      // código de caixa: estoque do CD já está em caixas
      cd[c] = { descricao: r.descricao, estoqueCx: qtd, estoqueUn: null, unPorCaixaCadastro: emb[c] || null, estoqueEm: 'cx', custoCDcx: custoCD[c] || 0 };
    } else if (emb[c] && embMult[c] === 0) {
      // código de unidade mas SEM o "X" (emb_multipla=0): o CD já conta em fardos/caixas; un/cx só converte pra unidade da loja
      cd[c] = { descricao: r.descricao, estoqueCx: qtd, estoqueUn: null, unPorCaixaCadastro: emb[c], estoqueEm: 'cx', custoCDcx: custoCD[c] || 0 };
    } else {
      // código de unidade com o "X" (ou sem cadastro na Itens App): estoque do CD está em UNIDADES;
      // un/cx vem do cadastro (Itens App, senão qtdemb, senão 1)
      const upc = emb[c] || (qtdemb > 1 ? qtdemb : 1);
      const v = vinculos[c]; const upcUsado = (v && v.status === 'confirmado' && v.unPorCaixa >= 1) ? v.unPorCaixa : upc;
      cd[c] = { descricao: r.descricao, estoqueCx: Math.floor(qtd / upcUsado), estoqueUn: qtd, unPorCaixaCadastro: upc, estoqueEm: 'un', custoCDcx: +((custoCD[c] || 0) * upcUsado).toFixed(2) };
    }
  }
  sincronizarVinculos(cods.map(c => ({ codigoCD: c, unPorCaixa: cd[c].unPorCaixaCadastro, unidadeExiste: cand[c] || null, descricaoUnidadeExiste: candDesc[c] || null, candidatoDescricao: porDesc[c]?.candidato || null, alternativas: porDesc[c]?.alternativas || [], descricaoCD: cd[c].descricao, estoqueCx: cd[c].estoqueCx, estoqueUn: cd[c].estoqueUn })));
  return cd;
}

// histórico mensal de 24 meses que o Radar já calcula de madrugada (data/radar-hist24.json: mensal['cod|loja'] = { 'YYYY-MM': [qtd, valor] })
let hist24Cache = { mtime: 0, mensal: {} };
function hist24() {
  const arq = path.join(DATA, 'radar-hist24.json');
  try { const st = fs.statSync(arq); if (st.mtimeMs !== hist24Cache.mtime) hist24Cache = { mtime: st.mtimeMs, mensal: (JSON.parse(fs.readFileSync(arq, 'utf8')).mensal) || {} }; }
  catch (e) { if (e.code !== 'ENOENT') console.error('[PEDIDOS-CD] radar-hist24.json:', e.message); hist24Cache = { mtime: 0, mensal: {} }; }
  return hist24Cache.mensal;
}
async function coletarUnidades(codigos, hoje) {
  const { q, mesDB } = deps;
  const dFim = addDias(hoje, -1), dIni = addDias(hoje, -JANELA_VENDA_DIAS);
  const meses = new Set(); { const d = new Date(dIni + 'T00:00:00Z'); while (iso(d) <= dFim) { meses.add(d.getUTCMonth() + 1); d.setUTCDate(d.getUTCDate() + 1); } }
  const un = {};
  const avisos = [];
  for (const c of chunk(codigos, 2000)) {
    const ph = c.map(() => '?').join(',');
    for (const r of await q(`SELECT CodigoBarra cod, TRIM(Descricao) descricao, Validar validade FROM central.itens WHERE CodigoBarra IN (${ph})`, c))
      un[String(r.cod)] = { descricao: r.descricao, validade: num(r.validade), custo: 0, porLoja: Object.fromEntries(LOJAS.map(ln => [ln, { vq: 0, est: 0 }])) };
    for (const ln of LOJAS) {
      try { for (const r of await q(`SELECT CodigoBarra cod, Qtd FROM central.estoquen${ln} WHERE CodigoBarra IN (${ph})`, c)) if (un[r.cod]) un[r.cod].porLoja[ln].est = Math.max(0, num(r.Qtd)); }
      catch (e) { avisos.push(`loja ${ln}: ${e.message}`); console.error('[PEDIDOS-CD] loja', ln, e.message); }
      try { for (const r of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, c)) if (un[r.cod] && !un[r.cod].custo && num(r.Custo) > 0) un[r.cod].custo = num(r.Custo); }
      catch (e) { avisos.push(`loja ${ln}: ${e.message}`); console.error('[PEDIDOS-CD] loja', ln, e.message); }
      for (const m of meses) {
        try {
          for (const r of await q(`SELECT Codigo cod, SUM(QtdNovo) qtd FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dIni, dFim, ...c]))
            if (un[r.cod]) un[r.cod].porLoja[ln].vq += num(r.qtd) / JANELA_VENDA_DIAS;
        } catch (e) { avisos.push(`loja ${ln}: ${e.message}`); console.error('[PEDIDOS-CD] loja', ln, e.message); }
      }
    }
  }
  // trânsito de FORNECEDOR: sugestão/pedido de compra em aberto no ERP (Status 0/1, últimos 30 d) — se a compradora
  // já comprou pra loja, o CD não precisa mandar. Mesma regra do Radar (TotalUnd em unidades).
  try {
    const abertas = await q(`SELECT nReg, nLoja, CodFornec, DATE_FORMAT(DataPedido,'%Y-%m-%d') dp FROM central.pedidocompra WHERE nLista>0 AND Status IN (0,1) AND DataPedido>=?`, [addDias(hoje, -30)]);
    if (abertas.length) {
      const infoPed = Object.fromEntries(abertas.map(a => [a.nReg, a]));
      const forns = [...new Set(abertas.map(a => a.CodFornec))]; const nomeForn = {};
      try { for (const f of await q(`SELECT CodFornec, Nome FROM central.fornecedor WHERE CodFornec IN (${forns.map(() => '?').join(',')})`, forns)) nomeForn[f.CodFornec] = f.Nome; } catch (e) {}
      const ids = abertas.map(a => a.nReg);
      for (const c of chunk(codigos, 2000)) {
        for (const c2 of chunk(ids, 2000)) {
          const rows = await q(`SELECT nPedido, nLoja, CodigoBarra cod, Qtd, Emb, TotalUnd FROM central.pedidocompraproduto WHERE nPedido IN (${c2.map(() => '?').join(',')}) AND CodigoBarra IN (${c.map(() => '?').join(',')})`, [...c2, ...c]);
          for (const x of rows) {
            const u1 = un[String(x.cod)]; const L = u1 && u1.porLoja[x.nLoja]; if (!L) continue;
            const und = num(x.TotalUnd) > 0 ? num(x.TotalUnd) : num(x.Qtd) * (num(x.Emb) > 1 ? num(x.Emb) : 1);
            const ped = infoPed[x.nPedido] || {};
            L.transitoForn = (L.transitoForn || 0) + und;
            (L.transitoFornDet = L.transitoFornDet || []).push({ sugestao: x.nPedido, fornecedor: nomeForn[ped.CodFornec] || ('fornecedor ' + ped.CodFornec), codFornec: ped.CodFornec, data: ped.dp || null, un: und });
          }
        }
      }
    }
  } catch (e) { avisos.push('trânsito de fornecedor: ' + e.message); console.error('[PEDIDOS-CD] trânsito fornecedor:', e.message); }
  // produto sem venda nos últimos 40 dias em NENHUMA loja (ficou em falta, ex.: Clorito): usa a média dos meses
  // com venda nos últimos 24 meses, loja a loja, pra não cair como "produto novo" com 1 caixa (decisão do Tiago 16/09/2026)
  const mensal = hist24();
  for (const [cod, u1] of Object.entries(un)) {
    if (LOJAS.some(ln => u1.porLoja[ln].vq > 0)) continue;
    let meses = 0, ultimo = null;
    for (const ln of LOJAS) {
      const m = u.mediaMensal(mensal[`${cod}|${ln}`]);
      if (m.vq > 0) { u1.porLoja[ln].vq = m.vq; meses = Math.max(meses, m.meses); if (!ultimo || m.ultimo > ultimo) ultimo = m.ultimo; }
    }
    if (meses) u1.vendaAntiga = { meses, ultimo };
  }
  return { un, avisos: [...new Set(avisos)] };
}

// Identificadores da loja no painel do Televendas do CD. Até 02/09/2026 o Dlinks gravava em CodFornec o
// código de cliente da loja (828, 899…); desde 03/09/2026 grava o CNPJ (ex.: 51632927000185 = L5).
// Devolve os dois pra casar o histórico e o atual. CNPJ vem do cadastro (central.fornecedor) e fica em cache.
const cnpjCache = {}; // código de cliente → CNPJ (string só dígitos) ou null
async function idsLoja(ln) {
  const cli = config.clientesLoja[ln]; if (!cli) return [];
  if (!(cli in cnpjCache)) {
    try {
      const r = await deps.q(`SELECT CNPJ cnpj FROM central.fornecedor WHERE CodFornec=? LIMIT 1`, [cli]);
      const d = r.length && r[0].cnpj != null ? String(r[0].cnpj).replace(/\D/g, '') : '';
      cnpjCache[cli] = d.length >= 11 ? d : null;
    } catch (e) { console.error('[PEDIDOS-CD] CNPJ do cliente', cli, e.message); return [cli]; } // sem cache: tenta de novo na próxima
  }
  return cnpjCache[cli] ? [cli, cnpjCache[cli]] : [cli];
}

// lead por loja: pedido da loja no painel do CD (DataEntrada) → nota do fornecedor do CD na loja (DataRecto), 6 meses
async function calcularLead(hoje) {
  const { q } = deps; const cfg = config; const lead = {};
  const dIni = addDias(hoje, -180);
  for (const ln of LOJAS) {
    lead[ln] = null;
    try {
      const ids = await idsLoja(ln); if (!ids.length) continue;
      const ped = await q(`SELECT DATE_FORMAT(DataEntrada,'%Y-%m-%d') d FROM central.painel_televendas WHERE nLoja=10 AND CodFornec IN (${ids.map(() => '?').join(',')}) AND DataEntrada>=? ORDER BY DataEntrada`, [...ids, dIni]);
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
  const hoje = isoLocal(new Date());
  const cd = await coletarCD();
  const unidades = [...new Set(Object.values(vinculos).filter(v => v.status === 'confirmado' && v.unidade).map(v => v.unidade))];
  const { un, avisos } = await coletarUnidades(unidades, hoje);
  const lead = await calcularLead(hoje);
  return { hoje, dias: JANELA_VENDA_DIAS, cd, un, lead, avisos };
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
function getEstado() { return { ...estado, hoje: base?.hoje || null, produtosCD: base ? Object.keys(base.cd).length : 0, avisos: base?.avisos || [] }; }

// ─── cálculo (puro em relação ao ERP) ────────────────────────
// transito: { 'unidade|loja': unidades } vindo dos pedidos do CD abertos/separados
// trânsito do produto na loja: soma a chave da unidade e a da caixa (pedido feito antes do vínculo fica gravado pela caixa)
function transitoDe(transito, unidade, cod, ln) { return (unidade ? (transito[`${unidade}|${ln}`] || 0) : 0) + (transito[`${cod}|${ln}`] || 0); }
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
    const item = { codigoCD: cod, descricaoCD: c.descricao, unidade: v?.unidade || null, descricaoUn: null, unPorCaixa: upc, estoqueCDcx: c.estoqueCx, estoqueCDun: c.estoqueUn ?? null, estoqueCDem: c.estoqueEm || 'cx',
      vqTotal: 0, coberturaTotal: null, custoUn: 0, lojas: {}, totalCx: 0, custoTotal: 0, cdInsuficiente: false, faltaCx: 0, origem: 'novo', semVinculo: !(v && v.status === 'confirmado' && v.unidade) };
    const un = item.unidade ? b.un[item.unidade] : null;
    if (un) { item.descricaoUn = un.descricao; item.custoUn = un.custo; item.vqTotal = +LOJAS.reduce((a, ln) => a + (un.porLoja[ln]?.vq || 0), 0).toFixed(3); }
    item.vendaAntiga = (un && un.vendaAntiga) || null;
    item.custoCDcx = c.custoCDcx > 0 ? c.custoCDcx : +((upc || 0) * item.custoUn).toFixed(2);
    item.custoCDun = upc >= 1 && item.custoCDcx > 0 ? +(item.custoCDcx / upc).toFixed(4) : item.custoUn;
    const temVenda = !!un && item.vqTotal > 0 && upc >= 1;
    if (temVenda) {
      item.origem = 'repor';
      const p = { cod: item.unidade, lista: 0, emb: 1, embFixa: upc, validade: un.validade, vq: item.vqTotal, lojas: LOJAS, porLoja: {} };
      for (const ln of LOJAS) p.porLoja[ln] = { vq: un.porLoja[ln]?.vq || 0, est: un.porLoja[ln]?.est || 0, transito: transitoDe(transito, item.unidade, cod, ln) + (un.porLoja[ln]?.transitoForn || 0) };
      const pedidoCx = {}, cobertura = {};
      for (const ln of LOJAS) {
        const P = paramsLoja[ln]; const r = radar.qtdPedido(p, P, 0, 0);
        const L = p.porLoja[ln]; const cob = L.vq > 0 ? (L.est + L.transito) / L.vq : null;
        pedidoCx[ln] = u.emCaixas(r.porLoja[ln] || 0, upc); cobertura[ln] = cob ?? 9999;
        item.lojas[ln] = { cx: pedidoCx[ln], un: 0, vq: +L.vq.toFixed(2), est: L.est, transito: L.transito, transitoCD: transitoDe(transito, item.unidade, cod, ln), transitoForn: un.porLoja[ln]?.transitoForn || 0, transitoFornDet: un.porLoja[ln]?.transitoFornDet || [], cobertura: cob == null ? null : +cob.toFixed(1), zeraAntes: cob != null && cob < P.lm };
      }
      const d = u.distribuirCdInsuficiente(pedidoCx, c.estoqueCx, cobertura);
      for (const ln of LOJAS) { item.lojas[ln].cx = d.pedidoCx[ln]; item.lojas[ln].un = d.pedidoCx[ln] * upc; }
      item.cdInsuficiente = d.falta > 0; item.faltaCx = d.falta;
      item.coberturaTotal = item.vqTotal > 0 ? +(LOJAS.reduce((a, ln) => a + p.porLoja[ln].est + p.porLoja[ln].transito, 0) / item.vqTotal).toFixed(1) : null;
    } else {
      let sobra = Math.floor(c.estoqueCx);
      for (const ln of LOJAS) { const cx = sobra > 0 ? 1 : 0; sobra -= cx; const tCD = transitoDe(transito, item.unidade, cod, ln), tF = un ? (un.porLoja[ln]?.transitoForn || 0) : 0; item.lojas[ln] = { cx, un: upc ? cx * upc : 0, vq: 0, est: un ? (un.porLoja[ln]?.est || 0) : 0, transito: tCD + tF, transitoCD: tCD, transitoForn: tF, transitoFornDet: un ? (un.porLoja[ln]?.transitoFornDet || []) : [], cobertura: null, zeraAntes: false }; }
    }
    item.totalCx = LOJAS.reduce((a, ln) => a + item.lojas[ln].cx, 0);
    item.custoTotal = +(item.totalCx * item.custoCDcx).toFixed(2);
    (item.origem === 'repor' ? repor : novos).push(item);
  }
  repor.sort((a, b2) => (a.coberturaTotal ?? 9999) - (b2.coberturaTotal ?? 9999));
  novos.sort((a, b2) => a.descricaoCD.localeCompare(b2.descricaoCD));
  return { repor, novos, paramsLoja };
}

// ─── pedidos (1 JSON por pedido, 1 pedido por loja) ──────────
const arqPed = id => path.join(PED_DIR, `${parseInt(id, 10)}.json`);
function salvarPedido(p) { fs.writeFileSync(arqPed(p.id), JSON.stringify(p)); return p; }
function obterPedido(id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return null;
  try { return JSON.parse(fs.readFileSync(arqPed(n), 'utf8')); } catch (e) { return null; }
}
// link público pro CD: token de 32 hex por pedido (igual ao link do vendedor); pedidos antigos ganham token ao serem lidos
function garantirToken(p) { if (p && !/^[a-f0-9]{32}$/.test(p.token || '')) { p.token = crypto.randomBytes(16).toString('hex'); salvarPedido(p); } return p; }
function porTokens(str) {
  const toks = String(str || '').split(',').filter(t => /^[a-f0-9]{32}$/.test(t));
  if (!toks.length) return [];
  const todos = listarPedidos();
  return toks.map(t => todos.find(p => p.token === t)).filter(Boolean);
}
function listarPedidos() {
  return fs.readdirSync(PED_DIR).filter(f => /^\d+\.json$/.test(f)).map(f => garantirToken(obterPedido(f.slice(0, -5)))).filter(Boolean).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
function proximoId() { const ids = fs.readdirSync(PED_DIR).map(f => parseInt(f)).filter(n => !isNaN(n)); return (ids.length ? Math.max(...ids) : 0) + 1; }
function totaisPedido(p) {
  return { caixas: p.itens.reduce((a, i) => a + i.caixas, 0), unidades: p.itens.reduce((a, i) => a + i.unidades, 0), custo: +p.itens.reduce((a, i) => a + i.unidades * (i.custoUn || 0), 0).toFixed(2) };
}
function _setBaseParaTeste(b) { base = b; }

function criarPedidos({ lojas, usuario }) {
  if (!base) throw new Error('sugestão ainda não calculada');
  const desconhecidos = [];
  const itensPorLoja = {};
  for (const [lnS, itens] of Object.entries(lojas || {})) {
    const ln = +lnS; if (!LOJAS.includes(ln)) continue;
    const its = [];
    for (const it of itens) {
      const cx = Math.round(+it.caixas || 0); if (cx <= 0) continue;
      const cod = String(it.codigoCD); const v = vinculos[cod]; const c = base.cd[cod];
      if (!c) { desconhecidos.push(cod); continue; }
      if (!v || v.status !== 'confirmado' || !v.unidade || !(v.unPorCaixa >= 1)) {
        // caixa sem vínculo (sem venda nem estoque nas lojas): vai como PRODUTO NOVO pela caixa mesmo — a loja recebe e
        // cadastra/vincula depois. un/cx do cadastro (senão 1); recebimento casa pelo código da caixa.
        const upc = (v && v.unPorCaixa >= 1) ? v.unPorCaixa : (c.unPorCaixaCadastro >= 1 ? c.unPorCaixaCadastro : 1);
        its.push({ codigoCD: cod, unidade: null, semVinculo: true, descricao: c.descricao || cod, unPorCaixa: upc, caixas: cx, unidades: cx * upc, custoUn: c.custoCDcx > 0 ? +(c.custoCDcx / upc).toFixed(4) : 0, origem: 'novo', recebidas: 0, separadas: 0 });
        continue;
      }
      const un = base.un[v.unidade] || {};
      its.push({ codigoCD: v.codigoCD, unidade: v.unidade, descricao: un.descricao || c.descricao || v.codigoCD, unPorCaixa: v.unPorCaixa, caixas: cx, unidades: cx * v.unPorCaixa, custoUn: c.custoCDcx > 0 ? +(c.custoCDcx / v.unPorCaixa).toFixed(4) : (un.custo || 0), origem: (un.porLoja && Object.values(un.porLoja).some(l => l.vq > 0)) ? 'repor' : 'novo', recebidas: 0, separadas: 0 });
    }
    itensPorLoja[ln] = its;
  }
  if (desconhecidos.length) throw new Error('produto não está no estoque do CD: ' + [...new Set(desconhecidos)].join(', '));
  const criados = [];
  for (const [lnS, its] of Object.entries(itensPorLoja)) {
    const ln = +lnS;
    if (!its.length) continue;
    const p = { id: proximoId(), token: crypto.randomBytes(16).toString('hex'), loja: ln, lojaNome: LOJAS_NOMES[ln], status: 'aberto', criadoEm: agora(), criadoPor: usuario || null, itens: its, expedicao: null, recebimento: null };
    p.totais = totaisPedido(p); criados.push(salvarPedido(p));
  }
  return criados;
}
function cancelarPedido(id, usuario) {
  const p = obterPedido(id); if (!p) throw new Error('pedido não encontrado');
  if (p.status === 'cancelado') throw new Error('pedido já cancelado');
  if (p.status === 'recebido') throw new Error('pedido já recebido');
  p.status = 'cancelado'; p.canceladoEm = agora(); p.canceladoPor = usuario || null;
  return salvarPedido(p);
}

// separado: pedido digitado pelo CD no Televendas (central.delivery) casado pelos ITENS com o pedido do app e
// liberado no painel (painel_televendas.Status 4); antes disso fica só informativo em p.noCD (digitado/em separação)
// recebido: nota do fornecedor do CD na loja, casando produto por código de UNIDADE, Qtd em caixas
// Itens do pedido do CD (delivery_produtos) × itens do pedido do app. Casa quando cobre metade do pedido do app
// E metade do que o CD digitou (pedido avulso de 1 item da loja não casa). Código do CD ou da unidade.
async function casamentoPorItens(p, nPedido) {
  const linhas = await deps.q(`SELECT CodigoBarra cod FROM central.delivery_produtos WHERE nPedido=?`, [nPedido]);
  const cods = new Set(linhas.map(x => String(x.cod)));
  const batem = p.itens.filter(i => cods.has(i.codigoCD) || (i.unidade && cods.has(i.unidade))).length;
  return { batem, ok: batem > 0 && batem * 2 >= p.itens.length && batem * 2 >= cods.size };
}

async function verificar() {
  const { q } = deps; const r = { verificados: 0, separados: 0, recebidos: 0 };
  const todos = listarPedidos();
  // nPedidos do painel já usados por outros pedidos do app não podem casar de novo
  const usados = new Set(todos.filter(x => x.expedicao).map(x => x.expedicao.nPedido));
  // notas do fornecedor do CD já atribuídas a outro pedido (por loja) não podem ser reusadas
  const notaOwner = {}; // loja → { nNota: pedidoId }
  for (const x of todos) {
    if (x.recebimento) {
      notaOwner[x.loja] = notaOwner[x.loja] || {};
      for (const n of x.recebimento.notas) notaOwner[x.loja][String(n.nNota)] = x.id;
    }
  }
  // mais antigos primeiro: quando dois pedidos concorrem pela mesma expedição/nota, o mais velho ganha
  const ordenados = todos.slice().sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  for (const p of ordenados) {
    if (!['aberto', 'separado', 'recebido_parcial'].includes(p.status)) continue;
    r.verificados++;
    // trânsito não pode ficar aberto pra sempre: sem recebimento algum depois de 30 dias, expira
    if ((p.status === 'aberto' || p.status === 'separado') && !p.recebimento) {
      const idadeDias = (Date.now() - new Date(p.criadoEm).getTime()) / 86400000;
      if (idadeDias > JANELA_PEDIDO_DIAS) {
        p.status = 'expirado'; p.expiradoEm = agora();
        salvarPedido(p);
        continue;
      }
    }
    const criado = new Date(p.criadoEm);
    const desdeDia = isoLocal(criado);     // dia local, pra granularidade de DATE
    const horaLocal = `${String(criado.getHours()).padStart(2, '0')}:${String(criado.getMinutes()).padStart(2, '0')}`;
    try {
      if (p.expedicao && p.status === 'separado' && !p.recebimento) {
        // expedição casada pela regra antiga (por data) pode ser um pedido avulso da loja: revalida pelos itens
        const { ok } = await casamentoPorItens(p, p.expedicao.nPedido);
        if (!ok) { console.log('[PEDIDOS-CD] pedido', p.id, 'desfaz expedição', p.expedicao.nPedido, '(itens não batem)'); delete p.expedicao; p.status = 'aberto'; for (const i of p.itens) i.separadas = 0; }
      }
      if (!p.expedicao) {
        // Casa o pedido do app com o pedido digitado pelo CD no Televendas (central.delivery, nLoja 10) pelos
        // ITENS, não pela data: a loja também faz pedidos diários avulsos ao CD, e o primeiro pedido depois da
        // criação era outro (16-17/09/2026: casou pedidos de 1 item). delivery.CodCliente = código de cliente,
        // delivery.CPF = CNPJ; delivery_produtos.CodigoBarra = código do CD (14 díg.) ou da unidade.
        const ids = await idsLoja(p.loja);
        const usadosArr = [...usados];
        const excl = usadosArr.length ? ` AND d.nPedido NOT IN (${usadosArr.map(() => '?').join(',')})` : '';
        const idsSql = ids.map(() => '?').join(',');
        const cands = ids.length ? await q(`SELECT d.nPedido, DATE_FORMAT(d.Data,'%Y-%m-%d') d, d.Hora hora FROM central.delivery d WHERE d.nLoja=10 AND (d.CodCliente IN (${idsSql}) OR d.CPF IN (${idsSql})) AND d.Data>=? AND d.Data<=DATE_ADD(?, INTERVAL ${JANELA_PEDIDO_DIAS} DAY)${excl} ORDER BY d.Data, d.Hora`, [...ids, ...ids, desdeDia, desdeDia, ...usadosArr]) : [];
        let melhor = null;
        for (const k of cands) {
          const { batem, ok } = await casamentoPorItens(p, k.nPedido);
          if (!ok) continue;
          if (!melhor || batem > melhor.batem) melhor = { nPedido: String(k.nPedido), data: k.d, hora: k.hora ? String(k.hora).slice(0, 5) : null, batem };
        }
        if (melhor) {
          const pan = await q(`SELECT Status statusCD, DATE_FORMAT(DataLiberacao,'%Y-%m-%d') dl, HoraEntrada he FROM central.painel_televendas WHERE nLoja=10 AND nPedido=? ORDER BY nReg DESC LIMIT 1`, [melhor.nPedido]);
          const statusCD = pan.length ? num(pan[0].statusCD) : null; // null = digitado, ainda não mandado pro painel de separação
          if (statusCD === 4) {
            p.expedicao = { nPedido: melhor.nPedido, data: pan[0].dl || melhor.data };
            delete p.noCD;
            usados.add(p.expedicao.nPedido);
            // conferência do CD: Qtd em caixas, código do CD ou da unidade
            const its = await q(`SELECT Codigobarra cod, SUM(Qtd) cx FROM central.conferencia_televendas WHERE nLoja=10 AND nPedido=? GROUP BY Codigobarra`, [p.expedicao.nPedido]);
            for (const i of p.itens) { const x = its.find(y => String(y.cod) === i.codigoCD || (i.unidade && String(y.cod) === i.unidade)); i.separadas = x ? num(x.cx) : 0; }
            if (p.status === 'aberto') { p.status = 'separado'; r.separados++; }
          } else {
            // digitado (null) → no painel (0) → em separação (1) → conferido (2): informativo, segue 'aberto'
            p.noCD = { nPedido: melhor.nPedido, statusCD, data: melhor.data, hora: (pan.length && pan[0].he) || melhor.hora || null };
          }
        } else delete p.noCD;
      }
      const unids = [...new Set(p.itens.map(i => i.unidade || i.codigoCD))];
      const excluirNotas = Object.entries(notaOwner[p.loja] || {}).filter(([, dono]) => dono !== p.id).map(([nNota]) => nNota);
      const exclNotas = excluirNotas.length ? ` AND c.nNota NOT IN (${excluirNotas.map(() => '?').join(',')})` : '';
      const notas = unids.length ? await q(`SELECT cp.CodigoBarra cod, SUM(cp.Qtd) cx, c.nNota, DATE_FORMAT(c.DataRecto,'%Y-%m-%d') d
        FROM central.compras c JOIN central.compraprodutos cp ON cp.nCompra=c.nCompra AND cp.nLoja=c.nLoja
        WHERE c.nLoja=? AND c.CodFornec=? AND c.Movimentacao='COMPRA' AND c.DataRecto>=? AND c.DataRecto<=DATE_ADD(?, INTERVAL 30 DAY) AND cp.CodigoBarra IN (${unids.map(() => '?').join(',')})${exclNotas}
        GROUP BY cp.CodigoBarra, c.nNota, c.DataRecto`, [p.loja, config.fornecedorCD, desdeDia, desdeDia, ...unids, ...excluirNotas]) : [];
      if (notas.length) {
        const porCod = {}; const nn = new Map();
        for (const n of notas) { porCod[String(n.cod)] = (porCod[String(n.cod)] || 0) + num(n.cx); nn.set(String(n.nNota), n.d); }
        for (const i of p.itens) i.recebidas = (i.unidade && porCod[i.unidade]) || porCod[i.codigoCD] || 0;
        p.recebimento = { notas: [...nn].map(([nNota, data]) => ({ nNota, data })), verificadoEm: agora() };
        notaOwner[p.loja] = notaOwner[p.loja] || {};
        for (const nNota of nn.keys()) notaOwner[p.loja][nNota] = p.id;
        const st = u.statusRecebimento(p.itens);
        if (st !== 'aberto') { if (p.status !== st) r.recebidos++; p.status = st; }
      }
      salvarPedido(p);
    } catch (e) { console.error('[PEDIDOS-CD] verificar pedido', p.id, e.message); }
  }
  return r;
}

function transitoPedidos() {
  const t = {};
  const limite = Date.now() - JANELA_PEDIDO_DIAS * 86400000;
  for (const p of listarPedidos())
    if ((p.status === 'aberto' || p.status === 'separado') && new Date(p.criadoEm).getTime() >= limite)
      // chave pela unidade; item sem vínculo (produto novo) usa o código da caixa — antes caía tudo em "null|loja"
      // pedido já separado: só o que o CD SEPAROU está a caminho; o que faltou na expedição não é trânsito,
      // então a loja segue descoberta e a próxima sugestão pede de novo (Tiago, 16/09/2026)
      for (const i of p.itens) { const k = `${i.unidade || i.codigoCD}|${p.loja}`; const cx = p.status === 'separado' ? Math.min(i.separadas || 0, i.caixas) : i.caixas; t[k] = (t[k] || 0) + cx * (i.unPorCaixa || 0); }
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

module.exports = { coletarCD, porTokens, transitoPedidos, init, getConfig, salvarConfig, getVinculos, sincronizarVinculos, salvarVinculo, removerVinculo, buscarUnidade, LOJAS, LOJAS_NOMES,
  recalcular, getEstado, sugestao, calcularSugestao, agendar,
  criarPedidos, listarPedidos, obterPedido, cancelarPedido, verificar, _setBaseParaTeste };
