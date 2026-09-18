// Sortimento por LISTA × LOJA (14/09/2026, pedido do Tiago): o que não precisa estar na loja, o que está parado,
// o que tem estoque demais e o que se compra e não vende. Calculado 1×/dia de madrugada, a partir do histórico de
// 24 meses do Radar (data/radar-hist24.json) + estoque/custo/entradas do ERP. Resultado em data/sortimento.json.
// SOMENTE LEITURA no ERP.
//
// Classes (por item × loja marcada na lista; insumos de padaria/açougue ficam fora da avaliação):
//   insumo_producao      — matéria-prima consumida na produção, não passa no caixa
//   marcado_sem_movimento — loja marcada na lista, sem venda nem compra em 24 meses
//   parado               — tem estoque e não vende há 6 meses
//   nao_merece           — vendeu em ≤3 meses dos últimos 12 e menos de 12 un no ano
//   cobertura_excessiva  — estoque cobre mais de 120 dias da venda dos últimos 6 meses
//   compra_e_nao_vende   — entrou no semestre mais de 3× o que vendeu
//   ok
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'sortimento.json');
const HIST = path.join(__dirname, '..', 'data', 'radar-hist24.json');
const LOJAS = [1, 2, 3, 4, 5, 6];
const NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const COB_EXCESSO_DIAS = 120, PARADO_MESES = 6, NAO_MERECE_MESES = 3, NAO_MERECE_UN_ANO = 12;
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const num = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isFinite(n) ? n : 0; };

let deps = null, cache = null, calculando = null, idx = null;
const ALERTA = new Set(['cobertura_excessiva', 'parado', 'nao_merece', 'compra_e_nao_vende']);
let idxAll = null;
function indexar() { idx = {}; idxAll = {}; if (cache) for (const r of cache.rows) { idxAll[`${r.lista}|${r.cod}|${r.loja}`] = r; if (ALERTA.has(r.classe)) idx[`${r.lista}|${r.cod}|${r.loja}`] = { classe: r.classe, cob: r.cob, valorEst: r.valorEst, ultVenda: r.ultVenda }; } }
// linha completa de um item numa loja de uma lista (pra tela de detalhe do alerta)
function item(lista, cod, loja) { if (!idxAll) indexar(); return idxAll ? idxAll[`${lista}|${cod}|${loja}`] || null : null; }
function init(d) { deps = d; try { cache = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { cache = null; } indexar(); }
// alerta do sortimento pra um item numa loja de uma lista (só classes que pedem confirmação no Radar)
function alerta(lista, cod, loja) { if (!idx) indexar(); return idx ? idx[`${lista}|${cod}|${loja}`] || null : null; }

async function calcular() {
  if (calculando) return calculando;
  calculando = (async () => {
    const t0 = Date.now();
    const { q, getNregsComprador } = deps;
    let hist; try { hist = JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch (e) { throw new Error('histórico de 24 meses ainda não existe (o Radar gera de madrugada)'); }
    const H = hist.mensal;
    const hoje = new Date(); const ymOf = d => d.toISOString().slice(0, 7);
    const mesesAtras = n => ymOf(new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - n, 1)));
    const M6 = mesesAtras(PARADO_MESES), M12 = mesesAtras(12);
    const compradorPorLista = {};
    for (const [comp, ids] of Object.entries(getNregsComprador() || {})) for (const id of ids) compradorPorLista[id] = comp;
    const itens = await q(`SELECT i.nCotacao lista, TRIM(l.Nome) nome, TRIM(l.NomeFornec) forn, i.Codigobarra cod, TRIM(it.Descricao) descricao, it.qtdemb emb, i.l1,i.l2,i.l3,i.l4,i.l5,i.l6
                           FROM central.c_cotacao_lista_itens i JOIN central.itens it ON it.CodigoBarra=i.Codigobarra JOIN central.c_cotacao_lista l ON l.nReg=i.nCotacao WHERE it.CodDesativado=0`);
    const cods = [...new Set(itens.map(x => x.cod))];
    // dados do cadastro do produto (Tiago, 18/09): preço de venda P{n}, margem de cadastro (itens_margens), última compra (compraprodutos)
    const est = {}, custo = {}, ent = {}, preco = {}, margem = {}, ultCompra = {};
    const pp = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
    for (const ln of LOJAS) { est[ln] = {}; custo[ln] = {}; preco[ln] = {}; margem[ln] = {}; for (const ch of chunk(cods, 4000)) { const ph = ch.map(() => '?').join(',');
      for (const r of await q(`SELECT CodigoBarra cod, P${ln} p FROM central.itens WHERE CodigoBarra IN (${ph})`, ch).catch(() => [])) preco[ln][r.cod] = pp(r.p);
      for (const r of await q(`SELECT CodigoBarra cod, MargemVarejo m FROM central.itens_margens WHERE nLoja=? AND CodigoBarra IN (${ph})`, [ln, ...ch]).catch(() => [])) margem[ln][r.cod] = r.m != null ? +r.m : null;
      for (const r of await q(`SELECT CodigoBarra cod, Qtd FROM central.estoquen${ln} WHERE CodigoBarra IN (${ph})`, ch).catch(() => [])) est[ln][r.cod] = num(r.Qtd);
      for (const r of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, ch).catch(() => [])) custo[ln][r.cod] = num(r.Custo); } }
    for (const ch of chunk(cods, 4000)) { const ph = ch.map(() => '?').join(',');
      for (const r of await q(`SELECT CodigoBarra cod, nLoja, SUM(QtdEntradaEstoque) q, DATE_FORMAT(MAX(DataEntrada),'%Y-%m-%d') ult, SUM(CASE WHEN DataEntrada>=DATE_SUB(CURDATE(), INTERVAL 6 MONTH) THEN QtdEntradaEstoque ELSE 0 END) q6
                               FROM central.compraprodutos WHERE Movimentacao='COMPRA' AND DataEntrada>=DATE_SUB(CURDATE(), INTERVAL 24 MONTH) AND CodigoBarra IN (${ph}) GROUP BY CodigoBarra, nLoja`, ch).catch(() => [])) ent[`${r.cod}|${r.nLoja}`] = { q: num(r.q), q6: num(r.q6), ult: r.ult }; }
    // preço da última compra por produto×loja (última nota de entrada em 24 m)
    for (const ch of chunk(cods, 2000)) { const ph = ch.map(() => '?').join(',');
      const rows2 = await q(`SELECT cp.*, DATE_FORMAT(cp.DataEntrada,'%Y-%m-%d') dt FROM central.compraprodutos cp
                              JOIN (SELECT CodigoBarra, nLoja, MAX(DataEntrada) dmax FROM central.compraprodutos WHERE Movimentacao='COMPRA' AND DataEntrada>=DATE_SUB(CURDATE(), INTERVAL 24 MONTH) AND CodigoBarra IN (${ph}) GROUP BY CodigoBarra, nLoja) u ON u.CodigoBarra=cp.CodigoBarra AND u.nLoja=cp.nLoja AND u.dmax=cp.DataEntrada
                              WHERE cp.Movimentacao='COMPRA'`, ch).catch(() => []);
      for (const r of rows2) { const k = `${r.CodigoBarra}|${r.nLoja}`; if (ultCompra[k]) continue; let p = null; for (const [c, v] of Object.entries(r)) if (/valor|preco|custo/i.test(c) && !/total|desc|ipi|icms|frete|entrada|estoque/i.test(c) && +v > 0) { p = +v; break; } if (p == null) { const qun = num(r.QtdEntradaEstoque); const vt = Object.entries(r).find(([c, v]) => /total/i.test(c) && +v > 0); if (qun > 0 && vt) p = +(+vt[1] / qun).toFixed(4); } ultCompra[k] = { dt: r.dt, preco: p }; } }
    const rows = [];
    for (const it of itens) for (const ln of LOJAS) {
      if (!it['l' + ln]) continue;
      const h = H[`${it.cod}|${ln}`] || {}; const meses = Object.entries(h).filter(([, x]) => x[0] > 0);
      const v24 = meses.reduce((a, [, x]) => a + x[0], 0), r24 = meses.reduce((a, [, x]) => a + x[1], 0);
      const v12 = meses.filter(([m]) => m >= M12).reduce((a, [, x]) => a + x[0], 0), v6 = meses.filter(([m]) => m >= M6).reduce((a, [, x]) => a + x[0], 0);
      const mesesComVenda12 = meses.filter(([m]) => m >= M12).length;
      const ultVenda = meses.map(([m]) => m).sort().pop() || null;
      const e = est[ln][it.cod] || 0, cu = custo[ln][it.cod] || 0, valorEst = +(Math.max(0, e) * cu).toFixed(2);
      const en = ent[`${it.cod}|${ln}`] || { q: 0, q6: 0, ult: null };
      const vd = v6 / 182.5; const cob = vd > 0 ? Math.round(Math.max(0, e) / vd) : (e > 0 ? 9999 : 0);
      const insumo = /PADARIA|A[CÇ]OUGUE|PRODU[CÇ][AÃ]O/i.test(it.nome) || /^(PADARIA|ACOUGUE|PROD\.?|INSUMO)\b/i.test(it.descricao);
      let classe = 'ok';
      if (insumo) classe = 'insumo_producao';
      else if (v24 === 0 && en.q === 0) classe = 'marcado_sem_movimento';
      else if (e > 0 && v6 === 0) classe = 'parado';
      else if (mesesComVenda12 <= NAO_MERECE_MESES && v12 < NAO_MERECE_UN_ANO) classe = 'nao_merece';
      else if (cob > COB_EXCESSO_DIAS) classe = 'cobertura_excessiva';
      else if (en.q6 > 0 && v6 < en.q6 * 0.3) classe = 'compra_e_nao_vende';
      rows.push({ lista: it.lista, nome: it.nome, forn: it.forn, comprador: compradorPorLista[it.lista] || null, loja: ln, cod: it.cod, descricao: it.descricao, emb: num(it.emb) || 1,
        v24: +v24.toFixed(3), r24: +r24.toFixed(2), v12: +v12.toFixed(3), v6: +v6.toFixed(3), meses12: mesesComVenda12, ultVenda, est: +e.toFixed(3), custo: +cu.toFixed(2), valorEst,
        preco: +(preco[ln][it.cod] || 0).toFixed(2), margemCad: margem[ln][it.cod] ?? null, margemApl: (preco[ln][it.cod] > 0 && cu > 0) ? +(((preco[ln][it.cod] - cu) / preco[ln][it.cod]) * 100).toFixed(1) : null,
        ultCompra: (ultCompra[`${it.cod}|${ln}`] || {}).dt || null, ultCompraPreco: (ultCompra[`${it.cod}|${ln}`] || {}).preco ?? null, ent24: +en.q.toFixed(3), ent6: +en.q6.toFixed(3), ultEnt: en.ult, cob, classe });
    }
    cache = { calculadoEm: new Date().toISOString(), duracaoMs: Date.now() - t0, histDe: hist.calculadoEm, rows };
    fs.writeFileSync(OUT, JSON.stringify(cache)); indexar();
    console.log(`[SORTIMENTO] ok em ${Math.round(cache.duracaoMs / 1000)}s — ${rows.length} itens×loja`);
    return cache;
  })().finally(() => { calculando = null; });
  return calculando;
}

// Filtros por coluna (Tiago, 18/09/2026): faixa mín/máx em venda 6 m, venda 12 m, meses c/ venda, estoque, R$ estoque,
// cobertura e entradas 6 m; última venda por mês (de/até, 'AAAA-MM'); 'nunca' = sem venda em 24 m.
const NUM_COLS = { v6: 'v6', v12: 'v12', meses12: 'meses12', est: 'est', valorEst: 'valorEst', cob: 'cob', ent6: 'ent6', custo: 'custo', preco: 'preco', margemCad: 'margemCad', margemApl: 'margemApl' };
function filtrar({ loja, comprador, classe, lista, busca, faixas, ultDe, ultAte }) {
  if (!cache) return [];
  const b = (busca || '').toLowerCase();
  const fx = [];
  for (const [k, campo] of Object.entries(NUM_COLS)) { const r = faixas?.[k] || {}; const mi = parseFloat(r.min), ma = parseFloat(r.max); if (isFinite(mi)) fx.push(x => (x[campo] ?? -Infinity) >= mi); if (isFinite(ma)) fx.push(x => (x[campo] ?? Infinity) <= ma); }
  if (ultDe === 'nunca') fx.push(x => !x.ultVenda);
  else { if (ultDe) fx.push(x => x.ultVenda && x.ultVenda.slice(0, 7) >= ultDe); if (ultAte) fx.push(x => x.ultVenda && x.ultVenda.slice(0, 7) <= ultAte); }
  return cache.rows.filter(r => (!loja || r.loja === +loja) && (!comprador || r.comprador === comprador) && (!classe || r.classe === classe) && (!lista || r.lista === +lista)
    && (!b || r.descricao.toLowerCase().includes(b) || r.cod.includes(b) || (r.nome || '').toLowerCase().includes(b) || (r.forn || '').toLowerCase().includes(b))
    && fx.every(fn => fn(r)));
}
function resumo(rows) {
  const R = { itens: 0, estoque: 0, parado: 0, valorParado: 0, naoMerece: 0, valorNaoMerece: 0, semMov: 0, valorSemMov: 0, cobExc: 0, valorCobExc: 0, compraNaoVende: 0, insumos: 0, porLoja: {}, porClasse: {} };
  for (const r of rows) {
    if (r.classe === 'insumo_producao') { R.insumos++; continue; }
    R.itens++; R.estoque += r.valorEst; R.porClasse[r.classe] = (R.porClasse[r.classe] || 0) + 1;
    const L = R.porLoja[r.loja] || (R.porLoja[r.loja] = { itens: 0, estoque: 0, parado: 0, valorParado: 0, naoMerece: 0, valorNaoMerece: 0, semMov: 0, valorSemMov: 0, cobExc: 0, valorCobExc: 0 });
    L.itens++; L.estoque += r.valorEst;
    if (r.classe === 'parado') { R.parado++; R.valorParado += r.valorEst; L.parado++; L.valorParado += r.valorEst; }
    if (r.classe === 'nao_merece') { R.naoMerece++; R.valorNaoMerece += r.valorEst; L.naoMerece++; L.valorNaoMerece += r.valorEst; }
    if (r.classe === 'marcado_sem_movimento') { R.semMov++; R.valorSemMov += r.valorEst; L.semMov++; L.valorSemMov += r.valorEst; }
    if (r.classe === 'cobertura_excessiva') { R.cobExc++; R.valorCobExc += r.valorEst; L.cobExc++; L.valorCobExc += r.valorEst; }
    if (r.classe === 'compra_e_nao_vende') R.compraNaoVende++;
  }
  return R;
}
function csv(rows) {
  const esc = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const CLASSE_PT = { cobertura_excessiva: 'Cobertura acima de 120 dias', parado: 'Parado', nao_merece: 'Não merece estar na loja', marcado_sem_movimento: 'Marcado sem movimento', compra_e_nao_vende: 'Compra e não vende', ok: 'Normal', insumo_producao: 'Insumo de produção' };
  const head = 'Nº lista;Lista;Fornecedor;Comprador;Loja;Código;Descrição;Embalagem;Venda 24 m (un);Venda 24 m (R$);Venda 12 m (un);Venda 6 m (un);Meses com venda (12 m);Última venda;Estoque;Custo unit.;Preço venda;Margem cadastro (%);Margem aplicada (%);Última compra;Preço última compra;Valor estoque;Entradas 24 m;Entradas 6 m;Última entrada;Cobertura (dias);Classe';
  return '﻿' + [head].concat(rows.map(r => [r.lista, r.nome, r.forn, r.comprador || '', 'L' + r.loja + ' ' + NOMES[r.loja], r.cod, r.descricao, r.emb, r.v24, r.r24, r.v12, r.v6, r.meses12, r.ultVenda || '', r.est, r.custo, r.preco, r.margemCad ?? '', r.margemApl ?? '', r.ultCompra || '', r.ultCompraPreco ?? '', r.valorEst, r.ent24, r.ent6, r.ultEnt || '', r.cob, CLASSE_PT[r.classe] || r.classe].map(esc).join(';'))).join('\r\n');
}
function estado() { return { calculadoEm: cache?.calculadoEm || null, histDe: cache?.histDe || null, itens: cache?.rows?.length || 0, calculando: !!calculando, listas: cache ? [...new Map(cache.rows.map(r => [r.lista, { id: r.lista, nome: r.nome }])).values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')) : [], compradores: cache ? [...new Set(cache.rows.map(r => r.comprador).filter(Boolean))].sort() : [] }; }
// agenda: 05:45 todo dia (o histórico do Radar roda às 04:30) e, ao subir, 4 min depois se não houver cálculo de hoje
function agendar() {
  const hojeStr = () => new Date().toISOString().slice(0, 10);
  // ao subir: tenta 4 min depois; se o histórico do Radar ainda não existir (ele leva ~10 min em segundo plano), tenta de novo a cada 5 min (até 12×)
  let tentativas = 0;
  const tentar = () => { if (cache && cache.calculadoEm.slice(0, 10) === hojeStr()) return; calcular().catch(e => { console.error('[SORTIMENTO]', e.message); if (++tentativas < 12) setTimeout(tentar, 5 * 60 * 1000); }); };
  setTimeout(tentar, 4 * 60 * 1000);
  setInterval(() => { const d = new Date(); if (d.getHours() === 5 && d.getMinutes() === 45) calcular().catch(e => console.error('[SORTIMENTO]', e.message)); }, 60 * 1000);
}
module.exports = { init, agendar, calcular, filtrar, resumo, csv, estado, alerta, item, ALERTA, NOMES };
