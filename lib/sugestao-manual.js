// Sugestão Manual — tela "Consolidação da Lista" (espelho do Dlinks, dentro do Fluxo).
//
// Conta por loja igual à do Dlinks (lista_consolidado_historico.QtdSug):
//   MédiaPeríodo    = QtdVenda ÷ dias   (dias corridos; obs.dias_com_venda → dias com venda)
//   DiasCob         = Estoque ÷ MédiaPeríodo
//   SugestãoSistema = max(0, round(Cobertura × MédiaPeríodo − Estoque − Trânsito))
//   obs.sem_estoque → Estoque = 0 ; !obs.transito → Trânsito = 0
//
// Persistência: um JSON por sugestão em data/sugestoes-manuais/ (F-N = criada
// aqui; D-<nConsolidado> = só os ajustes numa sugestão do Dlinks). NADA é
// escrito no ERP.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'sugestoes-manuais');

function calcularLoja({ qtdVenda, diasVenda, dias, estoque, transito, cobertura, obs }) {
  const o = obs || {};
  const div = o.dias_com_venda ? Math.max(1, diasVenda || 0) : Math.max(1, dias || 0);
  const media = (qtdVenda || 0) / div;
  const est = o.sem_estoque ? 0 : (estoque || 0);
  const tr = o.transito ? (transito || 0) : 0;
  const diasCob = media > 0 ? est / media : null;
  const sug = Math.max(0, Math.round((cobertura || 0) * media - est - tr));
  return { media: +media.toFixed(3), dias_cob: diasCob == null ? null : +diasCob.toFixed(1), sug_sistema: sug };
}

// reparte o total do item pelas lojas proporcional à sugestão sistema (sem sugestão divide
// igual); maior resto — nunca soma mais nem menos que T. Empate no resto: índice menor primeiro.
function repartirPorLoja(total, lojas) {
  const T = Math.max(0, Math.round(total || 0));
  if (T <= 0 || !lojas || !lojas.length) return {};
  const soma = lojas.reduce((a, l) => a + (l.sug_sistema || 0), 0);
  const pesos = lojas.map(l => soma > 0 ? (l.sug_sistema || 0) : 1);
  const pesoSoma = pesos.reduce((a, b) => a + b, 0);
  const raws = pesos.map(p => T * p / pesoSoma);
  const bases = raws.map(r => Math.floor(r));
  const resto = T - bases.reduce((a, b) => a + b, 0);
  const fracs = raws.map((r, i) => ({ i, f: r - bases[i] })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; k < resto; k++) bases[fracs[k].i] += 1;
  const out = {};
  lojas.forEach((l, i) => { if (bases[i] > 0) out[l.loja] = bases[i]; });
  return out;
}

let dir = DIR;
function _setDir(d) { dir = d; fs.mkdirSync(dir, { recursive: true }); }
function init() { fs.mkdirSync(dir, { recursive: true }); }
const arq = id => path.join(dir, `${id}.json`);
const ID_OK = /^[FD]-\d+$/;

function proximoId() {
  const seqArq = path.join(dir, '_seq.json');
  let n = 0; try { n = JSON.parse(fs.readFileSync(seqArq, 'utf8')).n || 0; } catch (e) {}
  n += 1; fs.writeFileSync(seqArq, JSON.stringify({ n }));
  return `F-${n}`;
}
function salvar(s) { if (!ID_OK.test(s.id || '')) throw new Error('Id inválido'); s.atualizado_em = new Date().toISOString(); const f = arq(s.id); fs.writeFileSync(f + '.tmp', JSON.stringify(s)); fs.renameSync(f + '.tmp', f); return s; }
function obter(id) { if (!ID_OK.test(id || '')) return null; try { return JSON.parse(fs.readFileSync(arq(id), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(dir).filter(f => /^F-\d+\.json$/.test(f)).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
}

// patch = { quantidades:{cod:{loja:qtd}}, obs:{cod:texto}, ativo:{cod:bool}, status, pedido_id }
function aplicarPatch(s, patch) {
  const p = patch || {};
  const qtd = v => Math.max(0, Math.round(parseFloat(v) || 0));
  if (s.origem === 'fluxo') {
    for (const it of s.itens || []) {
      const c = String(it.codigo);
      const qs = p.quantidades && p.quantidades[c];
      if (qs) { for (const l of it.lojas) if (qs[l.loja] != null && !l.desativado) l.sug_loja = qtd(qs[l.loja]); it.quantidade = it.lojas.reduce((a, l) => a + (l.sug_loja || 0), 0); }
      if (p.obs && p.obs[c] != null) it.obs = String(p.obs[c]).slice(0, 200);
      if (p.ativo && p.ativo[c] != null) it.ativo = !!p.ativo[c];
    }
  } else {
    s.quantidades = s.quantidades || {}; s.obs = s.obs || {}; s.inativos = s.inativos || [];
    for (const [c, qs] of Object.entries(p.quantidades || {})) { s.quantidades[c] = s.quantidades[c] || {}; for (const [l, v] of Object.entries(qs || {})) s.quantidades[c][l] = qtd(v); }
    for (const [c, t] of Object.entries(p.obs || {})) s.obs[c] = String(t).slice(0, 200);
    for (const [c, a] of Object.entries(p.ativo || {})) { const i = s.inativos.indexOf(String(c)); if (!a && i < 0) s.inativos.push(String(c)); if (a && i >= 0) s.inativos.splice(i, 1); }
  }
  if (['aberta', 'pedido_gerado', 'desativada'].includes(p.status)) s.status = p.status;
  if (p.pedido_id != null) s.pedido_id = p.pedido_id;
  return s;
}

let q = null, mesDB = null, transitoDePadrao = () => 0, curvaASet = () => null;
function initERP(deps) { q = deps.q; mesDB = deps.mesDB; transitoDePadrao = deps.transitoDe || (() => 0); curvaASet = deps.curvaASet || (() => null); }

const num = v => { if (v == null) return 0; let s = String(v).trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isNaN(n) ? 0 : n; };
const txt = v => (v == null || String(v).trim() === '0') ? '' : String(v).trim();
function diasEntre(d1, d2) {           // 'dd/mm/aaaa' → dias corridos (mínimo 1)
  const p = s => { const [d, m, a] = String(s).split('/').map(Number); return new Date(a, m - 1, d); };
  try { return Math.max(1, Math.round((p(d2) - p(d1)) / 86400000)); } catch (e) { return 1; }
}

// linhas cruas das 3 tabelas + JSON de ajustes (D-N.json ou null) → objeto no formato F-N
// linha de loja onde o item está desativado: sem números, sem digitação (sug_loja fica 0)
function lojaDesativada(ln) { return { loja: ln, desativado: true, sug_sistema: 0, sug_loja: 0, transito: 0 }; }

function montarDeLinhas(cab, itens, hist, ajustes) {
  const aj = ajustes || { quantidades: {}, obs: {}, inativos: [], status: 'aberta', pedido_id: null };
  const porItem = {};
  for (const h of hist) (porItem[String(h.CodigoBarra)] = porItem[String(h.CodigoBarra)] || []).push(h);
  const lojas = [...new Set(hist.map(h => +h.nLoja))].sort((a, b) => a - b);
  let vlr = 0, qtdV = 0;
  const out = itens.map(it => {
    const c = String(it.CodigoBarra);
    const hs = (porItem[c] || []).sort((a, b) => a.nLoja - b.nLoja);
    const ls = hs.map(h => {
      const ln = +h.nLoja;
      const ajq = aj.quantidades && aj.quantidades[c] && aj.quantidades[c][ln];
      // QTdCompra = "Pedido Compra" do Dlinks (quantidade editada por loja; nasce igual a QtdSug). Ql{loja} não é usado pelo Dlinks (fica 0).
      const sugSis = Math.round(num(h.QtdSug));
      const sugLoja = ajq != null ? ajq : Math.round(num(h.QTdCompra));
      const media = num(h.SaidaMedia);
      vlr += num(h.PMV) * num(h.QtdVendas); qtdV += num(h.QtdVendas);
      return { loja: ln, ultima_compra: txt(h.DataCompra) || null, ultima_venda: null, fornecedor: txt(h.Fornecedor) || null, un: txt(it.Unid) || null,
        emb: num(h.Emb) || null, qtd_compra: num(h.Qtd), preco_compra: num(h.Preco), total_compra: num(h.Total), custo: num(h.Custo), preco_atual: num(h.PVenda),
        estoque: num(h.Estoque), pmv: num(h.PMV), qtd_venda: num(h.QtdVendas), dias_venda: null, media: +media.toFixed(3),
        dias_cob: media > 0 ? +num(h.Cobertura).toFixed(1) : null, sug_sistema: sugSis, transito: num(h.Transito), abc: null, sug_loja: sugLoja, qtd_loja: Math.round(num(h.QtdLoja)) };
    });
    // loja participante da sugestão sem linha no histórico = item desativado nessa loja (o Dlinks mostra "Item" em vermelho)
    for (const ln of lojas) if (!ls.some(l => l.loja === ln)) ls.push(lojaDesativada(ln));
    ls.sort((a, b) => a.loja - b.loja);
    return { codigo: c, descricao: txt(it.Descricao), und: txt(it.Unid), emb: num(it.QtdEmb) || 1, preco_und: +num(it.Preco).toFixed(2),
      obs: (aj.obs && aj.obs[c] != null) ? aj.obs[c] : txt(it.Obs), ativo: !(aj.inativos || []).includes(c),
      quantidade: ls.reduce((a, l) => a + (l.sug_loja || 0), 0), lojas: ls };
  });
  return { id: `D-${cab.nConsolidado}`, origem: 'dlinks', criado_em: cab.Data ? new Date(cab.Data).toISOString() : null, criado_por: null,
    lista: { id: +cab.nLista, nome: txt(cab.NomeFornec), fornecedor: txt(cab.NomeFornec), cnpj: txt(cab.CNPJ) || null, cod_fornec: +cab.CodFornec || null },
    parametros: { data_ini: txt(cab.DataVenda1) || null, data_fim: txt(cab.DataVenda2) || null, dias: diasEntre(cab.DataVenda1, cab.DataVenda2), cobertura: +cab.QtdCobertura || 0, lojas, obs: { sem_estoque: false, transito: true, dias_com_venda: false } },
    status: aj.status || 'aberta', pedido_id: aj.pedido_id || null, status_web: +cab.StatusWeb || 0, desativada_erp: +cab.CodDesativado === 1,
    pm: qtdV > 0 ? +(vlr / qtdV).toFixed(2) : 0, itens: out };
}

async function montarDoERP(nConsolidado) {
  const n = parseInt(nConsolidado); if (!n) return null;
  const [cab] = await q(`SELECT nConsolidado, nLista, CodFornec, NomeFornec, CNPJ, Data, DataVenda1, DataVenda2, QtdCobertura, StatusWeb, CodDesativado FROM central.lista_consolidadas WHERE nConsolidado=?`, [n]);
  if (!cab) return null;
  const [itens, hist] = await Promise.all([
    q(`SELECT CodigoBarra, Descricao, Unid, QtdEmb, QTotal, Preco, Ql1, Ql2, Ql3, Ql4, Ql5, Ql6, Ql7, Ql8, Ql9, Ql10, Obs FROM central.lista_consolidado_itens WHERE nConsolidado=? ORDER BY Descricao`, [n]),
    q(`SELECT nLoja, CodigoBarra, DataCompra, Fornecedor, Qtd, Emb, Preco, Total, Custo, PVenda, Transito, SaidaMedia, Cobertura, Estoque, QtdVendas, QtdSug, QtdLoja, QTdCompra, PMV FROM central.lista_consolidado_historico WHERE nConsolidado=?`, [n])
  ]);
  const s = montarDeLinhas(cab, itens, hist, obter(`D-${n}`));
  // o histórico do Dlinks não guarda a última venda: busca no cupom (período de venda da sugestão até hoje)
  try { await preencherUltimaVenda(s); } catch (e) { console.error('[SUGESTAO-MANUAL] última venda D-' + n + ':', e.message); }
  return s;
}

// 'dd/mm/aaaa' → 'aaaa-mm-dd' (null se inválida)
function isoDe(br) { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(br || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }

// última data de venda por loja/produto em ln{loja}mesNN.zcupomitens, do início do período de venda até hoje
async function preencherUltimaVenda(s) {
  const dIni = isoDe(s.parametros.data_ini); if (!dIni || !mesDB) return;
  const hoje = new Date(); const dFim = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  const cods = s.itens.map(i => i.codigo); if (!cods.length) return;
  const ph = cods.map(() => '?').join(',');
  const fmt = d => d ? new Date(d).toLocaleDateString('pt-BR') : null;
  for (const ln of s.parametros.lojas) {
    const ult = {};
    for (const m of mesesDoPeriodo(dIni, dFim)) {
      try {
        const rows = await q(`SELECT Codigo, MAX(Data) ultima FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dIni, dFim, ...cods]);
        for (const r of rows) { const d = fmt(r.ultima); if (d) ult[String(r.Codigo)] = d; }   // meses em ordem: o último mês com venda prevalece
      } catch (e) { console.error('[SUGESTAO-MANUAL] última venda mes ' + m + ' loja ' + ln + ':', e.message); }
    }
    for (const it of s.itens) { const l = it.lojas.find(x => x.loja === ln); if (l && !l.desativado && ult[it.codigo]) l.ultima_venda = ult[it.codigo]; }
  }
}

// base = [{ codigo, descricao, und, emb, lojas:[1,2,..] }]
// porLoja[ln][cod] = { estoque, qtdVenda, valorVenda, diasVenda, ultimaVenda, custo, ultimaCompra, precoAtual, transito }
// params = { dias, cobertura, obs, curvaA: Set|null } → { pm, itens }
function montarItens(base, porLoja, params) {
  const { dias, cobertura, obs } = params; const curvaA = params.curvaA || null;
  // ABC: A = curva A do Radar; senão B até 80% acumulado da venda R$ da lista, C o resto
  const vendaR = {}; let totalR = 0;
  for (const b of base) { let v = 0; for (const ln of b.lojas) v += (porLoja[ln] && porLoja[ln][b.codigo] ? porLoja[ln][b.codigo].valorVenda : 0) || 0; vendaR[b.codigo] = v; totalR += v; }
  const abc = {}; let acum = 0;
  for (const c of Object.keys(vendaR).sort((a, b) => vendaR[b] - vendaR[a])) {
    if (curvaA && curvaA.has(String(c))) { abc[c] = 'A'; continue; }
    if (vendaR[c] <= 0 || totalR <= 0) { abc[c] = 'C'; continue; }
    abc[c] = acum / totalR < 0.8 ? 'B' : 'C'; acum += vendaR[c];   // entra em B enquanto o acumulado ANTES dele < 80%
  }
  let vlr = 0, qtdV = 0;
  const itens = base.map(b => {
    const ls = b.lojas.map(ln => {
      const d = (porLoja[ln] && porLoja[ln][b.codigo]) || { estoque: 0, qtdVenda: 0, valorVenda: 0, diasVenda: 0, ultimaVenda: null, custo: 0, ultimaCompra: null, precoAtual: 0, transito: 0 };
      const c = calcularLoja({ qtdVenda: d.qtdVenda, diasVenda: d.diasVenda, dias, estoque: d.estoque, transito: d.transito, cobertura, obs });
      vlr += d.valorVenda || 0; qtdV += d.qtdVenda || 0;
      return { loja: ln, ultima_compra: d.ultimaCompra || null, ultima_venda: d.ultimaVenda || null, fornecedor: null, un: b.und || null, emb: b.emb || null,
        qtd_compra: null, preco_compra: null, total_compra: null, custo: +(d.custo || 0).toFixed(4), preco_atual: +(d.precoAtual || 0).toFixed(2),
        estoque: +(d.estoque || 0).toFixed(2), pmv: d.qtdVenda > 0 ? +(d.valorVenda / d.qtdVenda).toFixed(2) : 0, qtd_venda: +(d.qtdVenda || 0).toFixed(2), dias_venda: d.diasVenda || 0,
        media: c.media, dias_cob: c.dias_cob, sug_sistema: c.sug_sistema, transito: +(d.transito || 0).toFixed(2), abc: abc[b.codigo] || 'C', sug_loja: c.sug_sistema, qtd_loja: null };
    });
    for (const ln of (params.lojas || [])) if (!ls.some(l => l.loja === ln)) ls.push(lojaDesativada(ln));
    ls.sort((a, b) => a.loja - b.loja);
    const custoMax = Math.max(0, ...ls.map(l => l.custo || 0));
    return { codigo: String(b.codigo), descricao: b.descricao, und: b.und, emb: b.emb || 1, preco_und: +custoMax.toFixed(2), obs: '', ativo: true,
      quantidade: ls.reduce((a, l) => a + l.sug_loja, 0), lojas: ls };
  });
  return { pm: qtdV > 0 ? +(vlr / qtdV).toFixed(2) : 0, itens };
}

// meses (1-12) que o período [dIni, dFim] cruza, no formato usado pelos bancos ln{loja}mesNN (independe de ano)
function mesesDoPeriodo(dIni, dFim) {
  const a = new Date(dIni + 'T00:00:00'), b = new Date(dFim + 'T00:00:00');
  if (!(a <= b)) return [];
  const out = [];
  for (let d = new Date(a.getFullYear(), a.getMonth(), 1); d <= b; d.setMonth(d.getMonth() + 1)) out.push(d.getMonth() + 1);
  return out;
}

async function lerBaseERP(listaId, lojas, dIni, dFim, transitoDe) {
  const buscarTransito = transitoDe || transitoDePadrao;
  const [lista] = await q(`SELECT Nome, NomeFornec, CodFornec FROM central.c_cotacao_lista WHERE nReg=?`, [listaId]);
  if (!lista) throw new Error('Lista não encontrada');
  const rows = await q(`SELECT i.Codigobarra, TRIM(it.Descricao) descricao, it.Unid, it.qtdemb, i.l1,i.l2,i.l3,i.l4,i.l5,i.l6, it.P1,it.P2,it.P3,it.P4,it.P5,it.P6
    FROM central.c_cotacao_lista_itens i INNER JOIN central.itens it ON it.CodigoBarra=i.Codigobarra WHERE i.nCotacao=? AND it.CodDesativado=0 ORDER BY it.Descricao`, [listaId]);
  const base = rows.map(r => ({ codigo: String(r.Codigobarra), descricao: r.descricao, und: r.Unid, emb: parseInt(r.qtdemb) || 1,
    lojas: lojas.filter(ln => parseInt(r['l' + ln]) === 1), precos: Object.fromEntries(lojas.map(ln => [ln, num(r['P' + ln])])) })).filter(b => b.lojas.length);
  if (!base.length) throw new Error('Lista sem produtos nas lojas escolhidas');
  const cods = base.map(b => b.codigo); const ph = cods.map(() => '?').join(',');
  const porLoja = {};
  const fmt = d => d ? new Date(d).toLocaleDateString('pt-BR') : null;
  for (const ln of lojas) {
    porLoja[ln] = {};
    for (const b of base) porLoja[ln][b.codigo] = { estoque: 0, qtdVenda: 0, valorVenda: 0, diasVenda: 0, ultimaVenda: null, custo: 0, ultimaCompra: null, precoAtual: b.precos[ln] || 0, transito: buscarTransito(b.codigo, ln) || 0 };
    try { for (const r of await q(`SELECT CodigoBarra, Qtd FROM central.estoquen${ln} WHERE CodigoBarra IN (${ph})`, cods)) if (porLoja[ln][r.CodigoBarra]) porLoja[ln][r.CodigoBarra].estoque = num(r.Qtd); } catch (e) { console.error('[SUGESTAO-MANUAL] estoque loja ' + ln + ':', e.message); }
    try { for (const r of await q(`SELECT CodigoBarra, Custo, UltimaCompra FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, cods)) if (porLoja[ln][r.CodigoBarra]) { porLoja[ln][r.CodigoBarra].custo = num(r.Custo); porLoja[ln][r.CodigoBarra].ultimaCompra = fmt(r.UltimaCompra); } } catch (e) { console.error('[SUGESTAO-MANUAL] custo loja ' + ln + ':', e.message); }
    for (const m of mesesDoPeriodo(dIni, dFim)) {
      try {
        const vr = await q(`SELECT Codigo, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) valor, COUNT(DISTINCT Data) dias, MAX(Data) ultima FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dIni, dFim, ...cods]);
        for (const r of vr) { const d = porLoja[ln][r.Codigo]; if (!d) continue; d.qtdVenda += num(r.qtd); d.valorVenda += num(r.valor); d.diasVenda += parseInt(r.dias) || 0; const u = fmt(r.ultima); if (u) d.ultimaVenda = u; }
      } catch (e) { console.error('[SUGESTAO-MANUAL] venda mes ' + m + ' loja ' + ln + ':', e.message); }
    }
  }
  return { lista, base, porLoja };
}

async function calcularNova({ listaId, data_ini, data_fim, cobertura, lojas, obs, usuario, transitoDe }) {
  const ls = (lojas || []).map(n => parseInt(n)).filter(n => n >= 1 && n <= 6);
  if (!ls.length) throw new Error('Escolha ao menos uma loja');
  const dias = Math.max(1, Math.round((new Date(data_fim) - new Date(data_ini)) / 86400000));
  const o = { sem_estoque: !!(obs && obs.sem_estoque), transito: !!(obs && obs.transito), dias_com_venda: !!(obs && obs.dias_com_venda) };
  const { lista, base, porLoja } = await lerBaseERP(listaId, ls, data_ini, data_fim, transitoDe);
  const { pm, itens } = montarItens(base, porLoja, { dias, cobertura: +cobertura || 20, obs: o, curvaA: curvaASet(), lojas: ls });
  const s = { id: proximoId(), origem: 'fluxo', criado_em: new Date().toISOString(), criado_por: usuario || null,
    lista: { id: +listaId, nome: (lista.Nome || '').trim(), fornecedor: (lista.NomeFornec || '').trim(), cnpj: null, cod_fornec: lista.CodFornec || null },
    parametros: { data_ini, data_fim, dias, cobertura: +cobertura || 20, lojas: ls, obs: o }, status: 'aberta', pedido_id: null, pm, itens };
  return salvar(s);
}

async function recalcular(id, transitoDe) {
  const s = obter(id); if (!s || s.origem !== 'fluxo') return null;
  const p = s.parametros;
  const { base, porLoja } = await lerBaseERP(s.lista.id, p.lojas, p.data_ini, p.data_fim, transitoDe);
  const { pm, itens } = montarItens(base, porLoja, { dias: p.dias, cobertura: p.cobertura, obs: p.obs, curvaA: curvaASet(), lojas: p.lojas });
  s.pm = pm; s.itens = itens; s.recalculado_em = new Date().toISOString();
  return salvar(s);
}

module.exports = { DIR, _setDir, init, proximoId, salvar, obter, listar, aplicarPatch, calcularLoja, repartirPorLoja, initERP, montarDeLinhas, montarDoERP, montarItens, mesesDoPeriodo, calcularNova, recalcular, num };
