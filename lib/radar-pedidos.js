// Radar de Pedidos — Fase 0 (modo sombra) + Fase 1 (pedidos do dia).
//
// Calcula, pra TODAS as listas de compra, quando cada lista deve ser feita e
// quanto pedir pra manter uma cobertura alvo, a partir de:
//   - lead time real da lista (fechar sugestão → nota entrar no ERP), 12 meses
//   - venda diária e estoque atual dos produtos da lista nas 6 lojas
//   - o que já está pedido e não chegou (sugestões abertas no ERP)
//   - validade de cadastro (não segurar estoque além de 60% dela)
//
// Regras combinadas com o Tiago (10/09/2026):
//   ponto de pedido = lead médio + segurança (lead máx − lead médio, no máximo 1 lead)
//   alvo da lista   = min(teto, ponto + intervalo real entre pedidos)
//   alvo do produto = min(alvo da lista, 60% da validade)
//   fazer a lista   = dia em que 25% da venda (R$) cruza o ponto de pedido
//   piso do pedido  = consumo de 1 ciclo; teto = (alvo + ciclo) × venda/dia
//   estoque acima do alvo NÃO gera pedido de redução — só "deixa descer".
//
// SOMENTE LEITURA no ERP. O único estado gravado fica em data/radar-sombra/
// (um JSON por dia com o que o sistema pediria — a Fase 0 compara isso com
// o que as compradoras pediram de fato).
const fs = require('fs');
const path = require('path');

const SOMBRA_DIR = path.join(__dirname, '..', 'data', 'radar-sombra');
const LOJAS = [1, 2, 3, 4, 5, 6];
const DOW = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];
const TETO_PADRAO = 28;
const FRACAO_VALIDADE = 0.6;
const FRACAO_VENDA_GATILHO = 0.25;
const JANELA_VENDA_DIAS = 40;
const JANELA_LEAD_MESES = 12;
const EMB_HIST_MESES_MAX = 24;   // quanto de histórico de embalagem fica em memória
const EMB_HIST_MESES_PADRAO = 24; // janela default usada pra decidir a embalagem real

// Embalagem real de compra do produto: a mais frequente nas notas de entrada
// dos últimos `meses` meses (empate → maior). null = sem histórico (usa cadastro).
// Prioridade: notas do FORNECEDOR DA LISTA (codFornec); só sem nenhuma dele é que
// olha as notas dos outros fornecedores (o mesmo produto pode vir em caixa de 24
// da indústria e por unidade de um atacadista — o pedido vai pra indústria).
function embCompra(cod, meses, codFornec = 0) {
  if (!meses || !base?.embHist?.[cod]) return null;
  const moda = (filtro) => {
    const cont = {};
    for (const [e, idade, n, cf] of base.embHist[cod]) if (idade < meses && filtro(cf)) cont[e] = (cont[e] || 0) + n;
    let best = null, bestN = 0;
    for (const [e, n] of Object.entries(cont)) { const ee = +e; if (n > bestN || (n === bestN && ee > best)) { best = ee; bestN = n; } }
    return best;
  };
  return (codFornec ? moda(cf => cf === codFornec) : null) ?? moda(() => true);
}
function embEfetiva(p, meses) {
  const h = embCompra(p.cod, meses, base?.listas?.[p.lista]?.codFornec || 0);
  return h && h >= 1 ? h : p.emb;
}

let deps = null;           // { q, mesDB, getNregsComprador }
let estado = { status: 'vazio', atualizadoEm: null, erro: null, duracaoMs: 0 };
let base = null;           // { hoje, dias, listas:{}, prods:[], transito:{} }
let leadCache = null;      // { calculadoEm, porLista:{} } — pesado, 24h
let recalculando = null;

const iso = d => d.toISOString().slice(0, 10);
const addDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const dd = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const num = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isFinite(n) ? n : 0; };
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

function init(d) {
  deps = d;
  fs.mkdirSync(SOMBRA_DIR, { recursive: true });
}

// ─────────────────────────────────────────────────────────────
// 1) LEAD TIME POR LISTA (12 meses, central + backup_central)
// ─────────────────────────────────────────────────────────────
async function calcularLead() {
  const { q } = deps;
  const hoje = iso(new Date());
  const dIni = addDias(hoje, -JANELA_LEAD_MESES * 30);

  const sugs = await q(`
    SELECT nReg, nLoja, CodFornec, DATE_FORMAT(DataPedido,'%Y-%m-%d') dp, DATE_FORMAT(DataEntrega,'%Y-%m-%d') de, Status, nLista
      FROM central.pedidocompra WHERE nLista>0 AND DataPedido>=? AND Status IN (2,4,7)
    UNION ALL
    SELECT nReg, nLoja, CodFornec, DATE_FORMAT(DataPedido,'%Y-%m-%d'), DATE_FORMAT(DataEntrega,'%Y-%m-%d'), Status, nLista
      FROM backup_central.pedidocompra WHERE nLista>0 AND DataPedido>=? AND Status IN (2,4,7)`, [dIni, dIni]);
  if (!sugs.length) return { calculadoEm: hoje, porLista: {} };

  // nota ligada pela conferência: pedidoitensconferidos.nPedido = pedidocompra.nReg
  const nRegs = sugs.map(s => s.nReg);
  const pares = [];
  for (const c of chunk(nRegs, 3000)) {
    const r = await q(`SELECT DISTINCT nPedido, nNota FROM central.pedidoitensconferidos WHERE nPedido IN (${c.map(() => '?').join(',')})`, c);
    pares.push(...r);
  }
  const notasPorReg = {};
  for (const p of pares) (notasPorReg[p.nPedido] = notasPorReg[p.nPedido] || []).push(String(p.nNota));
  const nNotas = [...new Set(pares.map(p => String(p.nNota)))];
  const notaKey = {}; // nNota|CodFornec|nLoja -> menor DataRecto
  for (const c of chunk(nNotas, 3000)) {
    const r = await q(`SELECT nNota, CodFornec, nLoja, DATE_FORMAT(MIN(DataRecto),'%Y-%m-%d') dr FROM central.compras
                       WHERE Movimentacao='COMPRA' AND nNota IN (${c.map(() => '?').join(',')}) GROUP BY nNota, CodFornec, nLoja`, c);
    for (const x of r) notaKey[`${x.nNota}|${x.CodFornec}|${x.nLoja}`] = x.dr;
  }
  // fallback: primeira nota do fornecedor na loja em até 45 dias
  const notasFornec = {};
  const nf = await q(`SELECT CodFornec, nLoja, DATE_FORMAT(DataRecto,'%Y-%m-%d') dr FROM central.compras
                      WHERE Movimentacao='COMPRA' AND Status='F' AND DataRecto>=? ORDER BY DataRecto`, [dIni]);
  for (const x of nf) (notasFornec[`${x.CodFornec}|${x.nLoja}`] = notasFornec[`${x.CodFornec}|${x.nLoja}`] || []).push(x.dr);

  const porLista = {};
  for (const s of sugs) {
    let dt = null;
    for (const n of notasPorReg[s.nReg] || []) {
      const d = notaKey[`${n}|${s.CodFornec}|${s.nLoja}`];
      if (d && dd(d, s.dp) >= -1 && dd(d, s.dp) <= 60 && (!dt || d < dt)) dt = d;
    }
    if (!dt) dt = (notasFornec[`${s.CodFornec}|${s.nLoja}`] || []).find(d => d >= s.dp && dd(d, s.dp) <= 45) || null;
    const L = porLista[s.nLista] || (porLista[s.nLista] = { leads: [], prometido: [], datas: {} });
    if (dt) L.leads.push(Math.max(0, dd(dt, s.dp)));
    if (s.de) L.prometido.push(Math.max(0, dd(s.de, s.dp)));
    (L.datas[s.nLoja] = L.datas[s.nLoja] || new Set()).add(s.dp);
  }
  const out = {};
  for (const [nLista, L] of Object.entries(porLista)) {
    const gaps = [];
    for (const set of Object.values(L.datas)) { const ds = [...set].sort(); for (let i = 1; i < ds.length; i++) gaps.push(dd(ds[i], ds[i - 1])); }
    out[nLista] = {
      sugestoes: Object.values(L.datas).reduce((a, s) => a + s.size, 0),
      entregues: L.leads.length,
      lead_medio: L.leads.length ? +avg(L.leads).toFixed(1) : null,
      lead_max: L.leads.length ? Math.max(...L.leads) : null,
      prometido: L.prometido.length ? +avg(L.prometido).toFixed(1) : null,
      intervalo: gaps.length ? +avg(gaps).toFixed(1) : null,
      ultimo: Object.values(L.datas).flatMap(s => [...s]).sort().pop() || null
    };
  }
  return { calculadoEm: hoje, porLista: out };
}

// ─────────────────────────────────────────────────────────────
// 2) BASE: produtos das listas, venda, estoque, custo, trânsito
// ─────────────────────────────────────────────────────────────
async function coletarBase() {
  const { q, mesDB } = deps;
  const hojeD = new Date();
  const hoje = iso(hojeD);
  const dFim = addDias(hoje, -1);
  const dIni = addDias(hoje, -JANELA_VENDA_DIAS);
  const meses = new Set(); { const d = new Date(dIni + 'T00:00:00Z'); while (iso(d) <= dFim) { meses.add(d.getUTCMonth() + 1); d.setUTCDate(d.getUTCDate() + 1); } }

  const cad = await q(`SELECT nReg, TRIM(Nome) nome, TRIM(NomeFornec) fornecedor, CodFornec, PedidoMinimo, email, whats FROM central.c_cotacao_lista`);
  const listas = {};
  const compradorPorLista = {};
  for (const [comp, ids] of Object.entries(deps.getNregsComprador() || {})) for (const id of ids) compradorPorLista[id] = comp;
  for (const l of cad) listas[l.nReg] = { lista: l.nReg, nome: l.nome, fornecedor: l.fornecedor, codFornec: l.CodFornec, pedidoMinimo: num(l.PedidoMinimo), comprador: compradorPorLista[l.nReg] || null };

  const itens = await q(`
    SELECT i.nCotacao nLista, i.Codigobarra cod, TRIM(it.Descricao) descricao, TRIM(it.Unid) unid, it.qtdemb emb, it.Validar validade,
           i.l1,i.l2,i.l3,i.l4,i.l5,i.l6
    FROM central.c_cotacao_lista_itens i JOIN central.itens it ON it.CodigoBarra=i.Codigobarra
    WHERE it.CodDesativado=0`);
  const codes = [...new Set(itens.map(r => r.cod))];

  const est = {}, venda = {}, custo = {};
  for (const ln of LOJAS) {
    est[ln] = {}; venda[ln] = {};
    for (const c of chunk(codes, 4000)) {
      const ph = c.map(() => '?').join(',');
      try { for (const r of await q(`SELECT CodigoBarra cod, Qtd FROM central.estoquen${ln} WHERE CodigoBarra IN (${ph})`, c)) est[ln][r.cod] = num(r.Qtd); } catch (e) {}
      try { for (const r of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, c)) { const v = num(r.Custo); if (v > 0 && !custo[r.cod]) custo[r.cod] = v; } } catch (e) {}
      for (const m of meses) {
        try {
          const vr = await q(`SELECT Codigo cod, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) valor FROM \`ln${ln}${mesDB(m)}\`.zcupomitens
                              WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dIni, dFim, ...c]);
          for (const r of vr) { const v = venda[ln][r.cod] || (venda[ln][r.cod] = { qtd: 0, valor: 0 }); v.qtd += num(r.qtd); v.valor += num(r.valor); }
        } catch (e) {}
      }
    }
  }

  // trânsito: sugestões abertas (Status 0/1) dos últimos 30 dias, por produto/loja
  const transito = {};
  try {
    const abertas = await q(`SELECT nReg, nLoja, nLista FROM central.pedidocompra WHERE nLista>0 AND Status IN (0,1) AND DataPedido>=?`, [addDias(hoje, -30)]);
    for (const c of chunk(abertas.map(a => a.nReg), 3000)) {
      if (!c.length) continue;
      const r = await q(`SELECT nPedido, nLoja, CodigoBarra cod, Qtd FROM central.pedidocompraproduto WHERE nPedido IN (${c.map(() => '?').join(',')})`, c);
      for (const x of r) transito[`${x.cod}|${x.nLoja}`] = (transito[`${x.cod}|${x.nLoja}`] || 0) + num(x.Qtd);
    }
  } catch (e) { console.error('[RADAR] trânsito:', e.message); }

  // embalagem REAL de compra: como o produto veio nas notas de entrada (compraprodutos.QtdEmb),
  // guardada por idade em meses pra tela escolher a janela (ex: últimos 12 meses)
  const embHist = {};
  try {
    const dEmb = addDias(hoje, -EMB_HIST_MESES_MAX * 30);
    for (const c of chunk(codes, 4000)) {
      // junta com compras pra saber DE QUAL FORNECEDOR veio cada nota: o mesmo produto pode
      // vir em caixa de 24 do fornecedor da lista e por unidade de um atacadista
      const r = await q(`SELECT cp.CodigoBarra cod, cp.QtdEmb emb, TIMESTAMPDIFF(MONTH, cp.DataEntrada, CURDATE()) idade, c.CodFornec, COUNT(*) n
                         FROM central.compraprodutos cp
                         LEFT JOIN central.compras c ON c.nCompra = cp.nCompra AND c.nLoja = cp.nLoja
                         WHERE cp.DataEntrada >= ? AND cp.Movimentacao='COMPRA' AND cp.QtdEmb > 0 AND cp.CodigoBarra IN (${c.map(() => '?').join(',')})
                         GROUP BY cp.CodigoBarra, cp.QtdEmb, idade, c.CodFornec`, [dEmb, ...c]);
      for (const x of r) { const e = num(x.emb); if (e >= 1) (embHist[x.cod] = embHist[x.cod] || []).push([e, +x.idade || 0, +x.n, +x.CodFornec || 0]); }
    }
  } catch (e) { console.error('[RADAR] embalagem histórica:', e.message); }

  const dias = JANELA_VENDA_DIAS;
  const prods = [];
  for (const it of itens) {
    if (!listas[it.nLista]) continue;
    let qtd = 0, val = 0, estQ = 0, tr = 0;
    const lojas = [], porLoja = {};
    for (const ln of LOJAS) {
      if (!it['l' + ln]) continue;
      lojas.push(ln);
      const v = venda[ln][it.cod]; const eL = est[ln][it.cod] || 0; const tL = transito[`${it.cod}|${ln}`] || 0;
      if (v) { qtd += v.qtd; val += v.valor; }
      estQ += eL; tr += tL;
      // por loja: o Dlinks gera a sugestão loja a loja, então a quantidade também é calculada por loja
      porLoja[ln] = { vq: (v ? v.qtd : 0) / dias, vR: (v ? v.valor : 0) / dias, est: Math.max(0, eL), estBruto: eL, transito: tL };
    }
    const pm = qtd > 0 ? val / qtd : 0;
    prods.push({
      lista: it.nLista, cod: it.cod, descricao: it.descricao, unid: it.unid || 'UN', emb: num(it.emb) > 0 ? num(it.emb) : 1,
      validade: num(it.validade), lojas, porLoja,
      vq: qtd / dias, vR: val / dias, est: Math.max(0, estQ), estBruto: estQ, transito: tr,
      custo: custo[it.cod] || pm * 0.75, precoMedio: pm
    });
  }
  return { hoje, dIni, dFim, dias, listas, prods, embHist };
}

// ─────────────────────────────────────────────────────────────
// 3) POLÍTICA (puro, roda em cima da base em memória)
// ─────────────────────────────────────────────────────────────
function paramsLista(L, lead, teto) {
  if (!lead || lead.lead_medio == null) return null;
  const lm = lead.lead_medio, seg = Math.min(Math.max(0, (lead.lead_max ?? lm) - lm), lm);
  const ponto = lm + seg;
  // teto limita o alvo, mas o alvo nunca fica abaixo do ponto de pedido:
  // lista de lead longo (ponto > teto) precisa cobrir pelo menos a entrega.
  const alvoLista = Math.max(ponto + 1, Math.min(teto, lead.intervalo != null ? ponto + lead.intervalo : teto));
  return { lm, seg, ponto, alvoLista, ciclo: Math.max(1, alvoLista - ponto) };
}
function alvoProduto(p, P) {
  return p.validade > 0 ? Math.min(P.alvoLista, Math.max(P.ponto + 1, p.validade * FRACAO_VALIDADE)) : P.alvoLista;
}
function qtdPedido(p, P, fazerEm, embMeses = EMB_HIST_MESES_PADRAO) {
  const emb = embEfetiva(p, embMeses);
  const porLoja = {};
  if (p.vq <= 0) return { qtd: 0, flag: null, emb, porLoja };
  const alvo = alvoProduto(p, P);
  // calculado LOJA A LOJA (o Dlinks gera a sugestão por loja); o total é a soma das lojas
  let total = 0, flag = null;
  for (const ln of p.lojas) {
    const L = p.porLoja[ln];
    if (!L || L.vq <= 0) { porLoja[ln] = 0; continue; }
    const disponivelNoDia = Math.max(0, L.est + L.transito - L.vq * fazerEm);
    let falta = alvo * L.vq - disponivelNoDia;
    if (falta <= 0) { porLoja[ln] = 0; continue; }
    const piso = P.ciclo * L.vq;               // nunca menos que 1 ciclo de consumo
    if (falta < piso) { falta = piso; flag = flag || 'piso'; }
    const tetoQ = (alvo + P.ciclo) * L.vq;     // nunca mais que alvo + ciclo
    if (falta > tetoQ) { falta = tetoQ; flag = 'teto'; }
    // arredonda pra cima na embalagem REAL de compra (histórico das notas), não na do cadastro:
    // se o produto sempre veio em caixa de 24, "faltam 2" vira 1 caixa de 24
    const q = Math.ceil(falta / emb) * emb;
    porLoja[ln] = q; total += q;
  }
  return { qtd: total, flag: total > 0 ? flag : null, alvo, emb, porLoja };
}

function politica(teto = TETO_PADRAO, filtroComprador = null, embMeses = EMB_HIST_MESES_PADRAO) {
  if (!base) return [];
  const byL = {};
  for (const p of base.prods) (byL[p.lista] = byL[p.lista] || []).push(p);
  const out = [];
  for (const L of Object.values(base.listas)) {
    if (filtroComprador && L.comprador !== filtroComprador) continue;
    const lead = leadCache?.porLista?.[L.lista];
    const ps = (byL[L.lista] || []);
    const comVenda = ps.filter(p => p.vq > 0);
    const P = paramsLista(L, lead, teto);
    const row = { ...L, produtos: ps.length, com_venda: comVenda.length, lead: lead || null, ok: !!(P && comVenda.length) };
    if (!row.ok) { row.motivo = !lead ? 'sem histórico de lead' : (!comVenda.length ? 'sem venda no período' : 'sem lead'); out.push(row); continue; }
    let vendaR = 0, estHoje = 0, estAlvo = 0, valW = 0, rupt = 0;
    const dias = [];
    for (const p of comVenda) {
      const alvo = alvoProduto(p, P);
      vendaR += p.vR; estHoje += p.est * p.custo; estAlvo += alvo * p.vq * p.custo; valW += (p.validade || 0) * p.vR;
      if (p.est <= 0) rupt++;
      dias.push([(p.est + p.transito) / p.vq - P.ponto, p.vR]);
    }
    dias.sort((a, b) => a[0] - b[0]);
    let acc = 0, fazerEm = dias[dias.length - 1][0];
    for (const [d, w] of dias) { acc += w; if (acc >= vendaR * FRACAO_VENDA_GATILHO) { fazerEm = d; break; } }
    fazerEm = Math.max(0, Math.round(fazerEm));
    let pedidoR = 0, pedidoItens = 0, flags = { piso: 0, teto: 0 };
    for (const p of comVenda) { const r = qtdPedido(p, P, fazerEm, embMeses); if (r.qtd > 0) { pedidoR += r.qtd * p.custo; pedidoItens++; } if (r.flag) flags[r.flag]++; }
    const d = new Date(base.hoje + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + fazerEm);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const cob = vendaR > 0 ? estHoje / (comVenda.reduce((a, p) => a + p.vq * p.custo, 0) || 1) : null;
    Object.assign(row, {
      ponto: +P.ponto.toFixed(1), seguranca: +P.seg.toFixed(1), alvo: +P.alvoLista.toFixed(1), ciclo: +P.ciclo.toFixed(1),
      fazer_em: fazerEm, data: iso(d), dow: DOW[d.getUTCDay()],
      venda_dia: +vendaR.toFixed(2), estoque_hoje: +estHoje.toFixed(2), estoque_alvo: +estAlvo.toFixed(2), diferenca: +(estAlvo - estHoje).toFixed(2),
      cobertura_dias: cob != null ? +cob.toFixed(1) : null,
      pedido_valor: +pedidoR.toFixed(2), pedido_itens: pedidoItens, flags,
      abaixo_minimo: L.pedidoMinimo > 0 && pedidoR > 0 && pedidoR < L.pedidoMinimo,
      validade_media: vendaR > 0 ? Math.round(valW / vendaR) : null,
      perecivel: vendaR > 0 && (valW / vendaR) * FRACAO_VALIDADE < teto,
      rupturas: rupt
    });
    out.push(row);
  }
  return out;
}

function itensLista(listaId, teto = TETO_PADRAO, fazerEmOverride = null, embMeses = EMB_HIST_MESES_PADRAO) {
  if (!base) return null;
  const L = base.listas[listaId]; if (!L) return null;
  const lead = leadCache?.porLista?.[listaId];
  const P = paramsLista(L, lead, teto);
  const row = fazerEmOverride == null ? politica(teto, null, embMeses).find(r => r.lista === +listaId) : null;
  const fazerEm = fazerEmOverride != null ? fazerEmOverride : (row?.fazer_em ?? 0);
  const itens = base.prods.filter(p => p.lista === +listaId).map(p => {
    const r = P ? qtdPedido(p, P, fazerEm, embMeses) : { qtd: 0, flag: null, emb: embEfetiva(p, embMeses), porLoja: {} };
    const cob = p.vq > 0 ? (p.est + p.transito) / p.vq : null;
    const embH = embCompra(p.cod, embMeses, L.codFornec || 0);
    return {
      cod: p.cod, descricao: p.descricao, unid: p.unid, emb: r.emb, emb_cadastro: p.emb, emb_compra: embH, lojas: p.lojas, validade: p.validade || null,
      venda_dia: +p.vq.toFixed(3), venda_dia_valor: +p.vR.toFixed(2), estoque: +p.est.toFixed(2), estoque_bruto: +p.estBruto.toFixed(2), transito: +p.transito.toFixed(2),
      cobertura_dias: cob != null ? +cob.toFixed(1) : null, alvo_dias: r.alvo != null ? +r.alvo.toFixed(1) : null,
      qtd: r.qtd, volumes: r.qtd ? Math.ceil(r.qtd / r.emb) : 0, custo: +p.custo.toFixed(4), total: +(r.qtd * p.custo).toFixed(2), flag: r.flag,
      lojas_qtd: r.porLoja || {},
      lojas_det: Object.fromEntries(p.lojas.map(ln => { const L = p.porLoja[ln]; return [ln, { estoque: +L.est.toFixed(1), transito: +L.transito.toFixed(1), venda_dia: +L.vq.toFixed(3), cobertura_dias: L.vq > 0 ? +((L.est + L.transito) / L.vq).toFixed(1) : null }]; })),
      abaixo_ponto: P ? cob != null && cob <= P.ponto : false
    };
  }).sort((a, b) => (b.qtd > 0) - (a.qtd > 0) || (a.cobertura_dias ?? 1e9) - (b.cobertura_dias ?? 1e9));
  return { lista: L, lead: lead || null, params: P, fazer_em: fazerEm, data: row?.data || null, itens,
           total: +itens.reduce((a, i) => a + i.total, 0).toFixed(2), volumes: itens.reduce((a, i) => a + i.volumes, 0) };
}

// ─────────────────────────────────────────────────────────────
// 4) RECÁLCULO + SNAPSHOT DIÁRIO (modo sombra)
// ─────────────────────────────────────────────────────────────
function salvarSnapshot() {
  if (!base) return;
  const rows = politica(TETO_PADRAO).filter(r => r.ok);
  const porComprador = {};
  for (const r of rows) {
    const c = porComprador[r.comprador || 'SEM COMPRADOR'] || (porComprador[r.comprador || 'SEM COMPRADOR'] = { listas: 0, venda_dia: 0, estoque_hoje: 0, estoque_alvo: 0, rupturas: 0, pedir_hoje: 0 });
    c.listas++; c.venda_dia += r.venda_dia; c.estoque_hoje += r.estoque_hoje; c.estoque_alvo += r.estoque_alvo; c.rupturas += r.rupturas; if (r.fazer_em === 0) c.pedir_hoje++;
  }
  // quantidades por produto que o sistema pediria HOJE em cada lista (fazerEm=0),
  // pra comparar depois produto a produto com o que a compradora pediu no ERP
  const itens = {};
  for (const r of rows) {
    const det = itensLista(r.lista, TETO_PADRAO, 0);
    if (!det) continue;
    const arr = det.itens.filter(i => i.qtd > 0).map(i => [i.cod, i.qtd, i.custo, +i.estoque.toFixed(1), i.cobertura_dias]);
    if (arr.length) itens[r.lista] = arr;
  }
  const snap = {
    dia: base.hoje, teto: TETO_PADRAO, geradoEm: new Date().toISOString(),
    porComprador,
    listas: rows.map(r => ({ lista: r.lista, comprador: r.comprador, fazer_em: r.fazer_em, pedido_valor: r.pedido_valor, pedido_itens: r.pedido_itens, cobertura_dias: r.cobertura_dias, estoque_hoje: r.estoque_hoje, rupturas: r.rupturas, venda_dia: r.venda_dia })),
    itens
  };
  fs.writeFileSync(path.join(SOMBRA_DIR, `${base.hoje}.json`), JSON.stringify(snap));
}

// Detalhe do modo sombra: produto a produto, compradora (ERP) × sistema (snapshot do dia)
async function sombraDetalhe(dia, listaId) {
  const { q } = deps;
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(path.join(SOMBRA_DIR, `${dia}.json`), 'utf8')); } catch (e) {}
  const sistemaArr = snap?.itens?.[listaId] || [];
  const sistema = {};
  for (const [cod, qtd, custo, est, cob] of sistemaArr) sistema[cod] = { qtd, custo, estoque: est, cobertura: cob };
  const real = await q(`
    SELECT pp.CodigoBarra cod, TRIM(pp.Descricao) descricao, SUM(pp.Qtd) qtd, AVG(pp.ValorUnit) valorUnit, SUM(pp.Total) total,
           GROUP_CONCAT(DISTINCT p.nLoja ORDER BY p.nLoja) lojas, MAX(pp.Emb) emb
    FROM central.pedidocompra p JOIN central.pedidocompraproduto pp ON pp.nPedido = p.nReg
    WHERE p.nLista = ? AND DATE(p.DataPedido) = ? AND p.Status <> 8
    GROUP BY pp.CodigoBarra, pp.Descricao`, [listaId, dia]);
  const nomes = {};
  for (const p of (base?.prods || [])) if (p.lista === +listaId) nomes[p.cod] = p;
  const codes = new Set([...Object.keys(sistema), ...real.map(r => r.cod)]);
  const linhas = [];
  for (const cod of codes) {
    const r = real.find(x => x.cod === cod);
    const s = sistema[cod];
    const info = nomes[cod];
    const qc = r ? num(r.qtd) : 0, qs = s ? s.qtd : 0;
    const custo = s ? s.custo : (info ? info.custo : (r ? num(r.valorUnit) : 0));
    linhas.push({
      cod, descricao: info?.descricao || r?.descricao || cod, unid: info?.unid || '', emb: info?.emb || (r ? num(r.emb) : null),
      compradora_qtd: qc, compradora_total: r ? num(r.total) : 0, compradora_lojas: r ? String(r.lojas) : '',
      sistema_qtd: qs, sistema_total: +(qs * custo).toFixed(2),
      estoque: s ? s.estoque : (info ? +info.est.toFixed(1) : null), cobertura: s ? s.cobertura : (info && info.vq > 0 ? +((info.est + info.transito) / info.vq).toFixed(1) : null),
      venda_dia: info ? +info.vq.toFixed(2) : null,
      diff: qc - qs, caso: qc && qs ? 'ambos' : (qc ? 'so_compradora' : 'so_sistema')
    });
  }
  linhas.sort((a, b) => (b.compradora_total + b.sistema_total) - (a.compradora_total + a.sistema_total));
  return {
    dia, lista: base?.listas?.[listaId] || { lista: +listaId }, tem_snapshot: !!snap, tem_itens_sistema: sistemaArr.length > 0 || !!snap?.itens,
    totais: { compradora: +linhas.reduce((a, l) => a + l.compradora_total, 0).toFixed(2), sistema: +linhas.reduce((a, l) => a + l.sistema_total, 0).toFixed(2),
              itens_compradora: linhas.filter(l => l.compradora_qtd > 0).length, itens_sistema: linhas.filter(l => l.sistema_qtd > 0).length, ambos: linhas.filter(l => l.caso === 'ambos').length },
    linhas
  };
}

async function recalcular(forcarLead = false) {
  if (recalculando) return recalculando;
  recalculando = (async () => {
    const t0 = Date.now();
    estado = { ...estado, status: 'calculando', erro: null };
    try {
      if (forcarLead || !leadCache || dd(iso(new Date()), leadCache.calculadoEm) >= 1) {
        console.log('[RADAR] calculando lead time por lista…');
        leadCache = await calcularLead();
      }
      console.log('[RADAR] coletando venda/estoque/trânsito…');
      base = await coletarBase();
      salvarSnapshot();
      estado = { status: 'ok', atualizadoEm: new Date().toISOString(), erro: null, duracaoMs: Date.now() - t0, listas: Object.keys(base.listas).length, produtos: base.prods.length, leadListas: Object.keys(leadCache.porLista).length };
      console.log(`[RADAR] ok em ${Math.round(estado.duracaoMs / 1000)}s — ${estado.produtos} produtos, ${estado.leadListas} listas com lead`);
    } catch (e) {
      estado = { ...estado, status: base ? 'ok' : 'erro', erro: e.message, duracaoMs: Date.now() - t0 };
      console.error('[RADAR-ERR]', e.message);
    } finally { recalculando = null; }
  })();
  return recalculando;
}

// Sombra: o que o sistema pediria (snapshots) × o que foi pedido de fato no ERP
async function sombra(dias = 30) {
  const { q } = deps;
  const hoje = iso(new Date());
  const dIni = addDias(hoje, -dias);
  const snaps = fs.readdirSync(SOMBRA_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) >= dIni).sort()
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(SOMBRA_DIR, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean);
  const reais = await q(`
    SELECT DATE_FORMAT(DataPedido,'%Y-%m-%d') dia, nLista, COUNT(*) lojas, SUM(Total) total, MAX(Status) status
    FROM central.pedidocompra WHERE nLista>0 AND DataPedido>=? AND Status<>8 GROUP BY dia, nLista`, [dIni]);
  const realMap = {};
  for (const r of reais) realMap[`${r.dia}|${r.nLista}`] = { lojas: r.lojas, total: num(r.total), status: r.status };
  const nomes = base ? base.listas : {};
  const linhas = [];
  for (const s of snaps) {
    for (const l of s.listas) {
      const real = realMap[`${s.dia}|${l.lista}`];
      if (l.fazer_em !== 0 && !real) continue;   // só dias em que alguém (sistema ou compradora) agiu
      linhas.push({ dia: s.dia, lista: l.lista, nome: nomes[l.lista]?.nome || String(l.lista), comprador: l.comprador,
        sistema: l.fazer_em === 0 ? l.pedido_valor : 0, sistema_itens: l.fazer_em === 0 ? l.pedido_itens : 0,
        real: real ? real.total : 0, real_lojas: real ? real.lojas : 0, cobertura: l.cobertura_dias, rupturas: l.rupturas,
        caso: l.fazer_em === 0 && real ? 'ambos' : (l.fazer_em === 0 ? 'so_sistema' : 'so_compradora') });
    }
  }
  const tendencia = snaps.map(s => ({ dia: s.dia, porComprador: s.porComprador }));
  return { dias, snapshots: snaps.length, linhas, tendencia };
}

function getEstado() { return { ...estado, hoje: base?.hoje || null, janela: base ? { dIni: base.dIni, dFim: base.dFim, dias: base.dias } : null, leadCalculadoEm: leadCache?.calculadoEm || null, teto_padrao: TETO_PADRAO }; }

// agenda: recalcula ao subir (após 90s) e todo dia às 05:30
function agendar() {
  setTimeout(() => recalcular(), 90 * 1000);
  setInterval(() => {
    const d = new Date();
    if (d.getHours() === 5 && d.getMinutes() === 30) recalcular();
  }, 60 * 1000);
}

module.exports = { init, agendar, recalcular, politica, itensLista, sombra, sombraDetalhe, getEstado, TETO_PADRAO };
