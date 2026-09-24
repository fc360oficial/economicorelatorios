// Sugestão Manual — tela "Consolidação da Lista" (espelho do Dlinks, dentro do Fluxo).
//
// Conta por loja igual à do Dlinks (lista_consolidado_historico.QtdSug):
//   MédiaPeríodo    = QtdVenda ÷ dias   (dias corridos; obs.dias_com_venda → dias com venda)
//   DiasCob         = Estoque ÷ MédiaPeríodo
//   SugestãoSistema = max(0, round(Cobertura × MédiaPeríodo − Estoque − Trânsito))
//   obs.sem_estoque → Estoque = 0 ; !obs.transito → Trânsito = 0
//   obs.com_custo   → "Gerar com Custo (Grupo de Lojas)" do Dlinks (MultLoja=1 no ERP): o pedido nasce com o último custo como
//                     preço e já Fechado, sem passar pelo link do vendedor (no ERP essas sugestões nunca têm StatusWeb=2)
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

let q = null, mesDB = null, transitoDePadrao = () => 0;
function initERP(deps) { q = deps.q; mesDB = deps.mesDB; transitoDePadrao = deps.transitoDe || (() => 0); }

const num = v => { if (v == null) return 0; let s = String(v).trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isNaN(n) ? 0 : n; };
const txt = v => (v == null || String(v).trim() === '0') ? '' : String(v).trim();
function diasEntre(d1, d2) {           // 'dd/mm/aaaa' → dias corridos (mínimo 1)
  const p = s => { const [d, m, a] = String(s).split('/').map(Number); return new Date(a, m - 1, d); };
  try { return Math.max(1, Math.round((p(d2) - p(d1)) / 86400000)); } catch (e) { return 1; }
}

// ABC por loja do Dlinks = central.itens.M{loja} (confirmado com o Dlinks em 17/09/26): 1=A, 2=B, 3=C, qualquer outro = vazio
function abcDoM(v) { const n = Math.round(num(v)); return n === 1 ? 'A' : n === 2 ? 'B' : n === 3 ? 'C' : null; }
const M_COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => 'M' + i);
// linhas de central.itens (CodigoBarra + M1..M10) → { cod: { loja: 'A'|'B'|'C'|null } }
function mapaABC(rows) { const m = {}; for (const r of rows || []) { const c = String(r.CodigoBarra); m[c] = {}; for (const col of M_COLS) if (r[col] !== undefined) m[c][+col.slice(1)] = abcDoM(r[col]); } return m; }

// linhas cruas das 3 tabelas + JSON de ajustes (D-N.json ou null) + mapa ABC (mapaABC) → objeto no formato F-N
// linha de loja onde o item está desativado: sem números, sem digitação (sug_loja fica 0)
function lojaDesativada(ln) { return { loja: ln, desativado: true, sug_sistema: 0, sug_loja: 0, transito: 0 }; }

function montarDeLinhas(cab, itens, hist, ajustes, abcMap) {
  const aj = ajustes || { quantidades: {}, obs: {}, inativos: [], status: 'aberta', pedido_id: null };
  const abcM = abcMap || {};
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
        dias_cob: media > 0 ? +num(h.Cobertura).toFixed(1) : null, sug_sistema: sugSis, transito: num(h.Transito), abc: (abcM[c] && abcM[c][ln]) || null, sug_loja: sugLoja, qtd_loja: Math.round(num(h.QtdLoja)) };
    });
    // loja participante da sugestão sem linha no histórico = item desativado nessa loja (o Dlinks mostra "Item" em vermelho)
    for (const ln of lojas) if (!ls.some(l => l.loja === ln)) ls.push(lojaDesativada(ln));
    ls.sort((a, b) => a.loja - b.loja);
    // Preco/Total em lista_consolidado_itens só existem depois que o fornecedor digita pelo link (ficam 0 antes)
    return { codigo: c, descricao: txt(it.Descricao), und: txt(it.Unid), emb: num(it.QtdEmb) || 1, preco_und: +num(it.Preco).toFixed(2), preco_digitado: +num(it.Preco).toFixed(2),
      obs: (aj.obs && aj.obs[c] != null) ? aj.obs[c] : txt(it.Obs), ativo: !(aj.inativos || []).includes(c),
      quantidade: ls.reduce((a, l) => a + (l.sug_loja || 0), 0), lojas: ls };
  });
  return { id: `D-${cab.nConsolidado}`, origem: 'dlinks', criado_em: cab.Data ? new Date(cab.Data).toISOString() : null, criado_por: null,
    lista: { id: +cab.nLista, nome: txt(cab.NomeFornec), fornecedor: txt(cab.NomeFornec), cnpj: txt(cab.CNPJ) || null, cod_fornec: +cab.CodFornec || null },
    parametros: { data_ini: txt(cab.DataVenda1) || null, data_fim: txt(cab.DataVenda2) || null, dias: diasEntre(cab.DataVenda1, cab.DataVenda2), cobertura: +cab.QtdCobertura || 0, lojas, obs: { sem_estoque: false, transito: true, dias_com_venda: false } },
    status: aj.status || 'aberta', pedido_id: aj.pedido_id || null, status_web: +cab.StatusWeb || 0, desativada_erp: +cab.CodDesativado === 1,
    pm: qtdV > 0 ? +(vlr / qtdV).toFixed(2) : 0, itens: out };
}

const CACHE_D = new Map(); const CACHE_D_MS = 5 * 60 * 1000;   // nConsolidado → { em, s }
async function montarDoERP(nConsolidado, refresh) {
  const n = parseInt(nConsolidado); if (!n) return null;
  const hit = refresh ? null : CACHE_D.get(n);   // refresh = "[F5] Atualizar" na tela: ignora o cache e relê o ERP
  if (hit && Date.now() - hit.em < CACHE_D_MS) { const s = JSON.parse(JSON.stringify(hit.s)); return aplicarAjustesD(s, obter(`D-${n}`)); }
  const [cab] = await q(`SELECT nConsolidado, nLista, CodFornec, NomeFornec, CNPJ, Data, DataVenda1, DataVenda2, QtdCobertura, StatusWeb, CodDesativado FROM central.lista_consolidadas WHERE nConsolidado=?`, [n]);
  if (!cab) return null;
  const [itens, hist, [ped]] = await Promise.all([
    q(`SELECT CodigoBarra, Descricao, Unid, QtdEmb, QTotal, Preco, Ql1, Ql2, Ql3, Ql4, Ql5, Ql6, Ql7, Ql8, Ql9, Ql10, Obs FROM central.lista_consolidado_itens WHERE nConsolidado=? ORDER BY Descricao`, [n]),
    q(`SELECT nLoja, CodigoBarra, DataCompra, Fornecedor, Qtd, Emb, Preco, Total, Custo, PVenda, Transito, SaidaMedia, Cobertura, Estoque, QtdVendas, QtdSug, QtdLoja, QTdCompra, PMV FROM central.lista_consolidado_historico WHERE nConsolidado=?`, [n]),
    q(`SELECT COUNT(*) n FROM central.pedidocompra WHERE nConsolidado=?`, [n])   // "Pedido Gerado" no Dlinks = tem linha em pedidocompra
  ]);
  // ABC por loja = central.itens.M{loja} (o Dlinks não grava na sugestão)
  let abcRows = [];
  if (itens.length) { try { abcRows = await q(`SELECT CodigoBarra, ${M_COLS.join(', ')} FROM central.itens WHERE CodigoBarra IN (${itens.map(() => '?').join(',')})`, itens.map(i => String(i.CodigoBarra))); } catch (e) { console.error('[SUGESTAO-MANUAL] ABC D-' + n + ':', e.message); } }
  // monta SEM os ajustes (pra cachear o que vem do ERP) e aplica os ajustes gravados por cima
  const s = montarDeLinhas(cab, itens, hist, null, mapaABC(abcRows));
  s.pedido_erp = !!(ped && +ped.n > 0);
  // o histórico do Dlinks não guarda última venda / dias de venda / V.A.C: busca no cupom
  try { await preencherUltimaVenda(s); } catch (e) { console.error('[SUGESTAO-MANUAL] última venda D-' + n + ':', e.message); }
  try { await preencherAvarias(s); } catch (e) { console.error('[SUGESTAO-MANUAL] avarias D-' + n + ':', e.message); }
  try { await preencherPromocoes(s); } catch (e) { console.error('[SUGESTAO-MANUAL] promoções D-' + n + ':', e.message); }
  try { await preencherRebaixas(s); } catch (e) { console.error('[SUGESTAO-MANUAL] rebaixas D-' + n + ':', e.message); }
  CACHE_D.set(n, { em: Date.now(), s: JSON.parse(JSON.stringify(s)) });
  return aplicarAjustesD(s, obter(`D-${n}`));
}
// aplica o JSON de ajustes (D-N.json) numa sugestão do Dlinks já montada: quantidades por loja, obs, inativos, status
function aplicarAjustesD(s, aj) {
  if (!aj) return s;
  for (const it of s.itens) {
    const c = String(it.codigo);
    const qs = aj.quantidades && aj.quantidades[c];
    if (qs) { for (const l of it.lojas) if (!l.desativado && qs[l.loja] != null) l.sug_loja = qs[l.loja]; it.quantidade = it.lojas.reduce((a, l) => a + (l.sug_loja || 0), 0); }
    if (aj.obs && aj.obs[c] != null) it.obs = aj.obs[c];
    if ((aj.inativos || []).includes(c)) it.ativo = false;
  }
  s.status = aj.status || s.status; s.pedido_id = aj.pedido_id || null;
  return s;
}

// 'dd/mm/aaaa' → 'aaaa-mm-dd' (null se inválida)
function isoDe(br) { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(br || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }

// última data de venda por loja/produto em ln{loja}mesNN.zcupomitens, do início do período de venda até hoje
// aceita 'dd/mm/aaaa' (Dlinks) ou 'aaaa-mm-dd' (F-N)
const isoQualquer = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : isoDe(d);

// Cor "Avarias" do Dlinks: o produto tem avaria EM ABERTO (central.avariaconsumo, Status 0/2 = ainda sem nota emitida)
// DO FORNECEDOR DA SUGESTÃO, lançada (DataLan) em loja da sugestão dentro do período de vendas.
// Batido na 4380 (17/09/26): das 7 avarias do período só a do Johnsons (Status 0, CodFornec 1335) fica amarela no Dlinks;
// as fechadas com nota (Status 4) e as de outro fornecedor (Loreal, 828) não. Marca it.avaria = { lojas, qtd, total } e l.avaria por loja.
async function preencherAvarias(s) {
  const dIni = isoQualquer(s.parametros.data_ini), dFim = isoQualquer(s.parametros.data_fim);
  if (!dIni || !dFim || !q) return;
  const cods = s.itens.map(i => i.codigo); const lojas = s.parametros.lojas || [];
  const fornec = parseInt(s.lista && s.lista.cod_fornec) || 0;
  if (!cods.length || !lojas.length) return;
  const rows = await q(`SELECT nLoja, CodigoBarras, SUM(Qtd) qtd, SUM(Total) total, COUNT(*) n FROM central.avariaconsumo
    WHERE nLoja IN (${lojas.map(() => '?').join(',')}) AND DataLan BETWEEN ? AND ? AND CodigoBarras IN (${cods.map(() => '?').join(',')})
      AND Status IN (0,2)${fornec ? ' AND CodFornec=?' : ''}
    GROUP BY nLoja, CodigoBarras`, [...lojas, dIni, dFim, ...cods, ...(fornec ? [fornec] : [])]);
  const m = {};
  for (const r of rows) { const c = String(r.CodigoBarras); (m[c] = m[c] || {})[+r.nLoja] = { qtd: +num(r.qtd).toFixed(2), total: +num(r.total).toFixed(2), n: parseInt(r.n) || 0 }; }
  for (const it of s.itens) {
    const a = m[it.codigo]; it.avaria = null;
    for (const l of it.lojas) l.avaria = (a && a[l.loja]) || null;
    if (a) { const ls = Object.keys(a).map(Number).sort((x, y) => x - y); it.avaria = { lojas: ls, qtd: +ls.reduce((t, ln) => t + a[ln].qtd, 0).toFixed(2), total: +ls.reduce((t, ln) => t + a[ln].total, 0).toFixed(2) }; }
  }
}

// Cor "Promoção" do Dlinks: o produto esteve numa promoção (central.promocao_produtos × promocao_capa, datas da capa)
// que cruza o período de vendas. capa.nloja = 0 vale pra todas as lojas; > 0 só conta se a loja participa da sugestão.
// (a tabela central.promocao é rotativa/vigente e fica vazia pra períodos passados — não serve aqui.)
// Marca it.promocao = { n, promos:[{ nome, ini, fim, preco, loja }] }.
async function preencherPromocoes(s) {
  const dIni = isoQualquer(s.parametros.data_ini), dFim = isoQualquer(s.parametros.data_fim);
  if (!dIni || !dFim || !q) return;
  const cods = s.itens.map(i => i.codigo); const lojas = (s.parametros.lojas || []).map(Number);
  if (!cods.length) return;
  const rows = await q(`SELECT pp.codigobarra cod, c.descricao nome, c.data_inicio ini, c.data_fim fim, c.nloja loja, MIN(pp.preco_promo) preco
    FROM central.promocao_produtos pp INNER JOIN central.promocao_capa c ON c.nreg = pp.nreg_promo
    WHERE pp.codigobarra IN (${cods.map(() => '?').join(',')}) AND c.data_fim >= ? AND c.data_inicio <= ?
    GROUP BY pp.codigobarra, c.nreg, c.descricao, c.data_inicio, c.data_fim, c.nloja ORDER BY c.data_inicio`, [...cods, dIni, dFim]);
  const fmt = d => d ? new Date(d).toLocaleDateString('pt-BR') : null;
  const m = {};
  for (const r of rows) {
    const loja = parseInt(r.loja) || 0;
    if (loja > 0 && lojas.length && !lojas.includes(loja)) continue;
    (m[String(r.cod)] = m[String(r.cod)] || []).push({ nome: String(r.nome || '').trim(), ini: fmt(r.ini), fim: fmt(r.fim), preco: +num(r.preco).toFixed(2), loja: loja || null });
  }
  for (const it of s.itens) it.promocao = m[it.codigo] ? { n: m[it.codigo].length, promos: m[it.codigo] } : null;
}

// Cor "Rebaixa de Preço" do Dlinks (regra do Tiago 17/09): central.promocaodatacritica com status IN (1,2),
// lançada (DataLan) em loja da sugestão dentro do período de vendas. Marca it.rebaixa = { n, lojas, itens:[{loja, de, para, qtd, validade}] } e l.rebaixa por loja.
async function preencherRebaixas(s) {
  const dIni = isoQualquer(s.parametros.data_ini), dFim = isoQualquer(s.parametros.data_fim);
  if (!dIni || !dFim || !q) return;
  const cods = s.itens.map(i => i.codigo); const lojas = s.parametros.lojas || [];
  if (!cods.length || !lojas.length) return;
  const rows = await q(`SELECT nLoja, Codigobarra cod, PrecoAtual de, preco para, Qtd qtd, Validade validade, DataLan lan FROM central.promocaodatacritica
    WHERE nLoja IN (${lojas.map(() => '?').join(',')}) AND status IN (1,2) AND DataLan BETWEEN ? AND ? AND Codigobarra IN (${cods.map(() => '?').join(',')}) ORDER BY DataLan`, [...lojas, dIni, dFim, ...cods]);
  const fmt = d => d ? new Date(d).toLocaleDateString('pt-BR') : null;
  const m = {};
  for (const r of rows) (m[String(r.cod)] = m[String(r.cod)] || []).push({ loja: +r.nLoja, de: +num(r.de).toFixed(2), para: +num(r.para).toFixed(2), qtd: +num(r.qtd).toFixed(2), validade: fmt(r.validade), data: fmt(r.lan) });
  for (const it of s.itens) {
    const a = m[it.codigo] || null;
    for (const l of it.lojas) l.rebaixa = a ? (a.filter(x => x.loja === l.loja)[0] || null) : null;
    it.rebaixa = a ? { n: a.length, lojas: [...new Set(a.map(x => x.loja))].sort((x, y) => x - y), itens: a } : null;
  }
}

async function preencherUltimaVenda(s) {
  const dIni = isoDe(s.parametros.data_ini); if (!dIni || !mesDB) return;
  const hoje = new Date(); const dFim = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  const cods = s.itens.map(i => i.codigo); if (!cods.length) return;
  const ph = cods.map(() => '?').join(',');
  const fmt = d => d ? new Date(d).toLocaleDateString('pt-BR') : null;
  for (const ln of s.parametros.lojas) {
    const ult = {}, diasV = {};
    // período de venda da sugestão (dias com venda = "Dias de Venda" do Dlinks); última venda vai até hoje
    const dFimPer = isoDe(s.parametros.data_fim) || dFim;
    const meses = [...new Set(mesesDoPeriodo(dIni, dFim))];
    const porMes = await Promise.all(meses.map(m => q(`SELECT Codigo, MAX(Data) ultima, COUNT(DISTINCT CASE WHEN Data <= ? THEN Data END) dias FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dFimPer, dIni, dFim, ...cods])
      .catch(e => { console.error('[SUGESTAO-MANUAL] última venda mes ' + m + ' loja ' + ln + ':', e.message); return []; })));
    for (const rows of porMes) for (const r of rows) { const d = fmt(r.ultima); if (d) ult[String(r.Codigo)] = d; diasV[String(r.Codigo)] = (diasV[String(r.Codigo)] || 0) + (parseInt(r.dias) || 0); }   // meses em ordem: o último mês com venda prevalece
    // sem venda no período: procura a última venda mês a mês pra trás (até 12 meses, limite dos bancos rotativos), igual ao Dlinks
    const jaMes = new Set(meses); const d0 = new Date(dIni + 'T00:00:00'); let faltam = cods.filter(c => !ult[c]);
    for (let k = 1; k <= 12 && faltam.length; k++) {
      const dm = new Date(d0.getFullYear(), d0.getMonth() - k, 1); const m = dm.getMonth() + 1; if (jaMes.has(m)) break; jaMes.add(m);
      const fimMes = `${dm.getFullYear()}-${String(m).padStart(2, '0')}-${new Date(dm.getFullYear(), m, 0).getDate()}`;
      const iniMes = `${dm.getFullYear()}-${String(m).padStart(2, '0')}-01`;
      const ph2 = faltam.map(() => '?').join(',');
      try {
        const rows = await q(`SELECT Codigo, MAX(Data) ultima FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph2}) GROUP BY Codigo`, [iniMes, fimMes, ...faltam]);
        for (const r of rows) { const d = fmt(r.ultima); if (d) ult[String(r.Codigo)] = d; }
      } catch (e) { console.error('[SUGESTAO-MANUAL] última venda (antes do período) mes ' + m + ' loja ' + ln + ':', e.message); }
      faltam = faltam.filter(c => !ult[c]);
    }
    for (const it of s.itens) { const l = it.lojas.find(x => x.loja === ln); if (!l || l.desativado) continue; if (ult[it.codigo]) l.ultima_venda = ult[it.codigo]; l.dias_venda = diasV[it.codigo] || 0; }
  }
  await preencherVAC(s, dFim);
}

// V.A.C = venda após a última compra (confirmado na 4380: lojas 1/3/4/6 batem com o Dlinks contando do dia seguinte à compra).
// Os bancos de venda são mensais e rotativos (12 meses), então compras mais antigas que isso ficam limitadas a 12 meses.
async function preencherVAC(s, dFim) {
  if (!mesDB) return;
  const hoje = new Date(dFim + 'T00:00:00'); const limite = new Date(hoje); limite.setMonth(limite.getMonth() - 12);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (const ln of s.parametros.lojas) {
    // por produto: dia seguinte à última compra (ou o limite de 12 meses, o que for mais recente)
    const inicio = {};
    for (const it of s.itens) { const l = it.lojas.find(x => x.loja === ln); if (!l || l.desativado) continue; const d0 = isoDe(l.ultima_compra); if (!d0) continue; const d = new Date(d0 + 'T00:00:00'); d.setDate(d.getDate() + 1); inicio[it.codigo] = iso(d < limite ? limite : d); }
    const cods = Object.keys(inicio); if (!cods.length) continue;
    const minIni = cods.map(c => inicio[c]).sort()[0];
    const vac = {};
    const ph = cods.map(() => '?').join(',');
    const caso = 'CASE Codigo ' + cods.map(() => 'WHEN ? THEN ?').join(' ') + ' END';
    const casoParams = cods.flatMap(c => [c, inicio[c]]);
    const meses = [...new Set(mesesDoPeriodo(minIni, dFim))];   // cada banco mensal só uma vez (rotativo de 12 meses)
    const porMes = await Promise.all(meses.map(m => q(`SELECT Codigo, SUM(QtdNovo) q FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) AND Data >= ${caso} GROUP BY Codigo`, [minIni, dFim, ...cods, ...casoParams])
      .catch(e => { console.error('[SUGESTAO-MANUAL] VAC mes ' + m + ' loja ' + ln + ':', e.message); return []; })));
    for (const rows of porMes) for (const r of rows) vac[String(r.Codigo)] = (vac[String(r.Codigo)] || 0) + num(r.q);
    for (const it of s.itens) { const l = it.lojas.find(x => x.loja === ln); if (l && !l.desativado && inicio[it.codigo] != null) l.vac = Math.round(vac[it.codigo] || 0); }
  }
}

// base = [{ codigo, descricao, und, emb, lojas:[1,2,..] }]
// porLoja[ln][cod] = { estoque, qtdVenda, valorVenda, diasVenda, ultimaVenda, custo, ultimaCompra, precoAtual, transito }
// base[].abc = { loja: 'A'|'B'|'C'|null } vindo de central.itens.M{loja} (mesma curva que o Dlinks mostra)
// params = { dias, cobertura, obs, lojas } → { pm, itens }
function montarItens(base, porLoja, params) {
  const { dias, cobertura, obs } = params;
  let vlr = 0, qtdV = 0;
  const itens = base.map(b => {
    const ls = b.lojas.map(ln => {
      const d = (porLoja[ln] && porLoja[ln][b.codigo]) || { estoque: 0, qtdVenda: 0, valorVenda: 0, diasVenda: 0, ultimaVenda: null, custo: 0, ultimaCompra: null, precoAtual: 0, transito: 0 };
      const c = calcularLoja({ qtdVenda: d.qtdVenda, diasVenda: d.diasVenda, dias, estoque: d.estoque, transito: d.transito, cobertura, obs });
      vlr += d.valorVenda || 0; qtdV += d.qtdVenda || 0;
      return { loja: ln, ultima_compra: d.ultimaCompra || null, ultima_venda: d.ultimaVenda || null, fornecedor: null, un: b.und || null, emb: b.emb || null,
        qtd_compra: null, preco_compra: null, total_compra: null, custo: +(d.custo || 0).toFixed(4), preco_atual: +(d.precoAtual || 0).toFixed(2),
        estoque: +(d.estoque || 0).toFixed(2), pmv: d.qtdVenda > 0 ? +(d.valorVenda / d.qtdVenda).toFixed(2) : 0, qtd_venda: +(d.qtdVenda || 0).toFixed(2), dias_venda: d.diasVenda || 0,
        media: c.media, dias_cob: c.dias_cob, sug_sistema: c.sug_sistema, transito: +(d.transito || 0).toFixed(2), abc: (b.abc && b.abc[ln]) || null, sug_loja: c.sug_sistema, qtd_loja: null };
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
  const rows = await q(`SELECT i.Codigobarra, TRIM(it.Descricao) descricao, it.Unid, it.qtdemb, i.l1,i.l2,i.l3,i.l4,i.l5,i.l6, it.P1,it.P2,it.P3,it.P4,it.P5,it.P6, it.M1,it.M2,it.M3,it.M4,it.M5,it.M6,it.M7,it.M8,it.M9,it.M10
    FROM central.c_cotacao_lista_itens i INNER JOIN central.itens it ON it.CodigoBarra=i.Codigobarra WHERE i.nCotacao=? AND it.CodDesativado=0 ORDER BY it.Descricao`, [listaId]);
  const base = rows.map(r => ({ codigo: String(r.Codigobarra), descricao: r.descricao, und: r.Unid, emb: parseInt(r.qtdemb) || 1,
    lojas: lojas.filter(ln => parseInt(r['l' + ln]) === 1), precos: Object.fromEntries(lojas.map(ln => [ln, num(r['P' + ln])])), abc: Object.fromEntries(lojas.map(ln => [ln, abcDoM(r['M' + ln])])) })).filter(b => b.lojas.length);
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
  const o = { sem_estoque: !!(obs && obs.sem_estoque), transito: !!(obs && obs.transito), dias_com_venda: !!(obs && obs.dias_com_venda), com_custo: !!(obs && obs.com_custo) };
  const { lista, base, porLoja } = await lerBaseERP(listaId, ls, data_ini, data_fim, transitoDe);
  const { pm, itens } = montarItens(base, porLoja, { dias, cobertura: +cobertura || 20, obs: o, lojas: ls });
  const s = { id: proximoId(), origem: 'fluxo', criado_em: new Date().toISOString(), criado_por: usuario || null,
    lista: { id: +listaId, nome: (lista.Nome || '').trim(), fornecedor: (lista.NomeFornec || '').trim(), cnpj: null, cod_fornec: lista.CodFornec || null },
    parametros: { data_ini, data_fim, dias, cobertura: +cobertura || 20, lojas: ls, obs: o }, status: 'aberta', pedido_id: null, pm, itens };
  try { await preencherAvarias(s); } catch (e) { console.error('[SUGESTAO-MANUAL] avarias ' + s.id + ':', e.message); }
  try { await preencherPromocoes(s); } catch (e) { console.error('[SUGESTAO-MANUAL] promoções ' + s.id + ':', e.message); }
  try { await preencherRebaixas(s); } catch (e) { console.error('[SUGESTAO-MANUAL] rebaixas ' + s.id + ':', e.message); }
  return salvar(s);
}

async function recalcular(id, transitoDe) {
  const s = obter(id); if (!s || s.origem !== 'fluxo') return null;
  const p = s.parametros;
  const { base, porLoja } = await lerBaseERP(s.lista.id, p.lojas, p.data_ini, p.data_fim, transitoDe);
  const { pm, itens } = montarItens(base, porLoja, { dias: p.dias, cobertura: p.cobertura, obs: p.obs, lojas: p.lojas });
  s.pm = pm; s.itens = itens; s.recalculado_em = new Date().toISOString();
  try { await preencherAvarias(s); } catch (e) { console.error('[SUGESTAO-MANUAL] avarias ' + s.id + ':', e.message); }
  try { await preencherPromocoes(s); } catch (e) { console.error('[SUGESTAO-MANUAL] promoções ' + s.id + ':', e.message); }
  try { await preencherRebaixas(s); } catch (e) { console.error('[SUGESTAO-MANUAL] rebaixas ' + s.id + ':', e.message); }
  return salvar(s);
}

module.exports = { DIR, _setDir, init, proximoId, salvar, obter, listar, aplicarPatch, calcularLoja, repartirPorLoja, initERP, montarDeLinhas, montarDoERP, montarItens, mapaABC, abcDoM, preencherAvarias, preencherPromocoes, preencherRebaixas, mesesDoPeriodo, calcularNova, recalcular, num };
