// Dashboard novo (21/09/2026, pedido do Tiago): uma tela em 6 segmentos, calculada no servidor e servida por
// /api/dashboard (cache em memória, recalculado em segundo plano a cada 5 min).
//   1 Faturamento   — loja a loja + rede: mês até hoje × mesmo período do ano passado, margem, markup, ticket, cupons
//   2 Comercial     — lojas abaixo da meta (meta gravada em data/dashboard-metas.json ou ano passado + %),
//                     setores (departamentos) com queda de margem (mês atual × mês anterior)
//   3 Abastecimento — curva A em falta (Radar de Pedidos), listas pra pedir hoje/atrasadas, pendências do CD,
//                     pedidos ao fornecedor parados
//   4 Estoque       — excesso (Sortimento), vencimentos próximos (itenscoletorvalidade × estoque), transferências
//   5 Operação      — caixas ativos/parados e cupons da última hora (cupons de hoje); refrigeração sem fonte
//   6 Financeiro    — compromissos dos próximos 7 dias e vencidos (loja20045.contasapagar − baixas); saldo sem fonte
// SOMENTE LEITURA no ERP. Único arquivo gravado: data/dashboard-metas.json.
'use strict';
const fs = require('fs');
const path = require('path');

const METAS = path.join(__dirname, '..', 'data', 'dashboard-metas.json');
const LOJAS = [1, 2, 3, 4, 5, 6];
const NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO', 10: 'CENTRAL/CD' };
const TTL_MS = 5 * 60 * 1000;
const num = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoV = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : iso(v); return String(v).slice(0, 10); };
const pct = (a, b) => b > 0 ? r1(a / b * 100) : null;

let deps = null, cache = null, calculando = null, metas = null;
function lerJson(f, p) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return p; } }
function init(d) { deps = d; metas = lerJson(METAS, { crescimento: 5, lojas: {} });
  // DASHBOARD_DEMO=<arquivo.json> carrega um cache pronto (teste de layout sem ERP)
  if (process.env.DASHBOARD_DEMO) { cache = lerJson(process.env.DASHBOARD_DEMO, null); if (cache) cache.demo = true; } }

// ── metas: { crescimento: 5, lojas: { 'AAAA-MM': { '1': 123456, ... } } }
function getMetas() { return metas; }
function setMetas(p) {
  if (p.crescimento != null && isFinite(+p.crescimento)) metas.crescimento = +p.crescimento;
  if (p.mes && p.lojas && typeof p.lojas === 'object') { const m = metas.lojas[p.mes] = metas.lojas[p.mes] || {}; for (const [ln, v] of Object.entries(p.lojas)) { const n = num(v); if (n > 0) m[ln] = r2(n); else delete m[ln]; } }
  fs.mkdirSync(path.dirname(METAS), { recursive: true }); fs.writeFileSync(METAS, JSON.stringify(metas, null, 2));
  if (cache) { cache.comercial = { ...comercial(cache._fat, cache._grupos), compradores: (cache.comercial || {}).compradores || null }; }
  return metas;
}

async function safe(nome, fn, padrao) { try { return await fn(); } catch (e) { console.error('[DASHBOARD]', nome, e.message); return padrao; } }

// ── 1 FATURAMENTO ──────────────────────────────────────────────────────────────────────────────────────────
async function faturamento(hoje) {
  const q = deps.q, ano = hoje.getFullYear(), mes = hoje.getMonth() + 1, mm = 'mes' + pad(mes), dia = hoje.getDate();
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const dIni = `${ano}-${pad(mes)}-01`, dHoje = iso(hoje);
  const dIniAnt = `${ano - 1}-${pad(mes)}-01`, dHojeAnt = `${ano - 1}-${pad(mes)}-${pad(dia)}`, dFimAnt = `${ano - 1}-${pad(mes)}-${pad(new Date(ano - 1, mes, 0).getDate())}`;
  const ontem = new Date(hoje); ontem.setDate(ontem.getDate() - 1); const dOntem = iso(ontem);
  const semAnt = new Date(hoje); semAnt.setDate(semAnt.getDate() - 364); const dHojeAntSem = iso(semAnt), mmAntSem = 'mes' + pad(semAnt.getMonth() + 1);
  const horaAgora = hoje.toTimeString().slice(0, 8);
  const lojas = [];
  for (const ln of [...LOJAS, 10]) {
    const cd = ln === 10;
    const [a] = await q(`SELECT COALESCE(SUM(ValorTotalNovo),0) v, COALESCE(SUM(Custo),0) c, COUNT(DISTINCT CONCAT(nECF,'-',CCF)) n,
                                COALESCE(SUM(CASE WHEN Data=? THEN ValorTotalNovo END),0) vh, COUNT(DISTINCT CASE WHEN Data=? THEN CONCAT(nECF,'-',CCF) END) nh,
                                COALESCE(SUM(CASE WHEN Data=? THEN ValorTotalNovo END),0) vo
                         FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`, [dHoje, dHoje, dOntem, dIni, dHoje]).catch(() => [{}]);
    const [b] = await q(`SELECT COALESCE(SUM(CASE WHEN Data<=? THEN ValorTotalNovo END),0) v, COALESCE(SUM(CASE WHEN Data<=? THEN Custo END),0) c,
                                COUNT(DISTINCT CASE WHEN Data<=? THEN CONCAT(nECF,'-',CCF) END) n, COALESCE(SUM(ValorTotalNovo),0) vMes, COALESCE(SUM(CASE WHEN Data=? THEN ValorTotalNovo END),0) vhAnt
                         FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`, [dHojeAnt, dHojeAnt, dHojeAnt, dHojeAnt, dIniAnt, dFimAnt]).catch(() => [{}]);
    const [nf] = await q(`SELECT COUNT(*) n, COALESCE(SUM(TotalNota),0) v, COALESCE(SUM(CASE WHEN DataLan=? THEN TotalNota END),0) vh, COUNT(CASE WHEN DataLan=? THEN 1 END) nh
                          FROM central.compras WHERE nLoja=? AND Movimentacao='VENDA' AND Tipo='NF' AND Status='F' AND DataLan BETWEEN ? AND ?`, [dHoje, dHoje, ln, dIni, dHoje]).catch(() => ({}));
    const [nfA] = await q(`SELECT COUNT(*) n, COALESCE(SUM(TotalNota),0) v, COALESCE(SUM(CASE WHEN DataLan=? THEN TotalNota END),0) vh
                          FROM central.compras WHERE nLoja=? AND Movimentacao='VENDA' AND Tipo='NF' AND Status='F' AND DataLan BETWEEN ? AND ?`, [dHojeAntSem, ln, dIniAnt, dHojeAnt]).catch(() => ({}));
    const [hAnt] = cd ? [{}] : await q(`SELECT COALESCE(SUM(ValorTotalNovo),0) v FROM \`ln${ln}${mmAntSem}\`.zcupomitens WHERE Data=? AND Hora<=? AND IndCancel='N'`, [dHojeAntSem, horaAgora]).catch(() => [{}]);
    const nfe = { n: +(nf || {}).n || 0, v: r2(num((nf || {}).v)), vh: r2(num((nf || {}).vh)), nh: +(nf || {}).nh || 0, nAnt: +(nfA || {}).n || 0, vAnt: r2(num((nfA || {}).v)), vhAnt: r2(num((nfA || {}).vh)) };
    nfe.var = nfe.vAnt > 0 ? r1((nfe.v / nfe.vAnt - 1) * 100) : null;
    // CD: custo da venda = Custo × Qtd dos itens das NF-e de saída (compraprodutos), só pra margem/markup
    const [nfc] = cd ? await q(`SELECT COALESCE(SUM(CAST(REPLACE(p.Custo,',','.') AS DECIMAL(14,4)) * CAST(REPLACE(p.Qtd,',','.') AS DECIMAL(14,3))),0) c
                          FROM central.compraprodutos p JOIN central.compras c ON c.nCompra=p.nCompra AND c.nLoja=p.nLoja
                          WHERE p.nLoja=? AND c.Movimentacao='VENDA' AND c.Tipo='NF' AND c.Status='F' AND c.DataLan BETWEEN ? AND ? AND p.Cancelado=0`, [ln, dIni, dHoje]).catch(() => [{}]) : [{}];
    const v = cd ? nfe.v : num(a.v), c = cd ? num((nfc || {}).c) : num(a.c), n = cd ? 0 : (+a.n || 0), vAnt = cd ? nfe.vAnt : num(b.v), cAnt = num(b.c), nAnt = cd ? 0 : (+b.n || 0);
    lojas.push({ loja: ln, nome: cd ? 'CD · CAHU DISTRIBUIDORA' : NOMES[ln], cd, nfe, venda: r2(v), custo: r2(c), cupons: n, ticket: n ? r2(v / n) : 0, margem: pct(v - c, v), markup: pct(v - c, c),
      vendaAnt: r2(vAnt), custoAnt: r2(cAnt), cuponsAnt: nAnt, ticketAnt: nAnt ? r2(vAnt / nAnt) : 0, margemAnt: pct(vAnt - cAnt, vAnt), markupAnt: pct(vAnt - cAnt, cAnt), var: vAnt > 0 ? r1((v / vAnt - 1) * 100) : null,
      varCupons: nAnt > 0 ? r1((n / nAnt - 1) * 100) : null, hoje: cd ? nfe.vh : r2(num(a.vh)), hojeAnt: cd ? nfe.vhAnt : r2(num((hAnt || {}).v)), hojeAntData: dHojeAntSem, hojeAntHora: horaAgora, cuponsHoje: +a.nh || 0, ontem: r2(num(a.vo)), mesAntCompleto: r2(num(b.vMes)),
      projecao: dia > 0 ? r2(v / dia * ultimoDia) : 0 });
    if (cd) { const L = lojas[lojas.length - 1]; L.margemAnt = null; L.markupAnt = null; L.ticket = 0; L.ticketAnt = 0; L.cuponsAnt = 0; L.varCupons = null; }
  }
  const NF = lojas.filter(l => !l.cd).reduce((s, l) => ({ n: s.n + l.nfe.n, v: s.v + l.nfe.v, vh: s.vh + l.nfe.vh, nh: s.nh + l.nfe.nh, vAnt: s.vAnt + l.nfe.vAnt }), { n: 0, v: 0, vh: 0, nh: 0, vAnt: 0 });
  const t = lojas.filter(l => !l.cd).reduce((s, l) => ({ venda: s.venda + l.venda, custo: s.custo + l.custo, cupons: s.cupons + l.cupons, vendaAnt: s.vendaAnt + l.vendaAnt, cuponsAnt: s.cuponsAnt + l.cuponsAnt, hoje: s.hoje + l.hoje, hojeAnt: s.hojeAnt + (l.hojeAnt || 0), cuponsHoje: s.cuponsHoje + l.cuponsHoje, ontem: s.ontem + l.ontem, mesAntCompleto: s.mesAntCompleto + l.mesAntCompleto, projecao: s.projecao + l.projecao, custoAnt: s.custoAnt + l.custoAnt }),
    { venda: 0, custo: 0, cupons: 0, vendaAnt: 0, cuponsAnt: 0, hoje: 0, hojeAnt: 0, cuponsHoje: 0, ontem: 0, mesAntCompleto: 0, projecao: 0, custoAnt: 0 });
  const rede = { loja: 0, nome: 'REDE', venda: r2(t.venda), custo: r2(t.custo), cupons: t.cupons, ticket: t.cupons ? r2(t.venda / t.cupons) : 0, margem: pct(t.venda - t.custo, t.venda), markup: pct(t.venda - t.custo, t.custo),
    vendaAnt: r2(t.vendaAnt), cuponsAnt: t.cuponsAnt, ticketAnt: t.cuponsAnt ? r2(t.vendaAnt / t.cuponsAnt) : 0, margemAnt: pct(t.vendaAnt - t.custoAnt, t.vendaAnt), markupAnt: pct(t.vendaAnt - t.custoAnt, t.custoAnt), var: t.vendaAnt > 0 ? r1((t.venda / t.vendaAnt - 1) * 100) : null,
    varCupons: t.cuponsAnt > 0 ? r1((t.cupons / t.cuponsAnt - 1) * 100) : null, hoje: r2(t.hoje), hojeAnt: r2(t.hojeAnt), cuponsHoje: t.cuponsHoje, ontem: r2(t.ontem), mesAntCompleto: r2(t.mesAntCompleto), projecao: r2(t.projecao),
    nfe: { n: NF.n, v: r2(NF.v), vh: r2(NF.vh), nh: NF.nh, vAnt: r2(NF.vAnt), var: NF.vAnt > 0 ? r1((NF.v / NF.vAnt - 1) * 100) : null } };
  return { mes, ano, dia, ultimoDia, de: dIni, ate: dHoje, anoAnt: ano - 1, lojas, rede };
}

// margem por departamento: mês atual até hoje × mês anterior (completo), por loja
async function margemGrupos(hoje) {
  const q = deps.q, ano = hoje.getFullYear(), mes = hoje.getMonth() + 1;
  const mAnt = mes === 1 ? 12 : mes - 1, anoAnt = mes === 1 ? ano - 1 : ano;
  const per = [{ k: 'atual', mm: 'mes' + pad(mes), de: `${ano}-${pad(mes)}-01`, ate: iso(hoje) }, { k: 'ant', mm: 'mes' + pad(mAnt), de: `${anoAnt}-${pad(mAnt)}-01`, ate: `${anoAnt}-${pad(mAnt)}-${pad(new Date(anoAnt, mAnt, 0).getDate())}` }];
  const rows = [];
  for (const ln of LOJAS) for (const p of per) {
    const rs = await q(`SELECT TRIM(g.Descricao) grupo, SUM(z.ValorTotalNovo) v, SUM(z.Custo) c FROM \`ln${ln}${p.mm}\`.zcupomitens z
                        JOIN central.itens i ON i.CodigoBarra = z.Codigo LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
                        WHERE z.Data BETWEEN ? AND ? AND z.IndCancel='N' GROUP BY g.Descricao`, [p.de, p.ate]).catch(e => { console.error('[DASHBOARD] grupos', ln, p.k, e.message); return []; });
    for (const r of rs) rows.push({ loja: ln, periodo: p.k, grupo: r.grupo || '(sem grupo)', v: num(r.v), c: num(r.c) });
  }
  return { rows, periodoAtual: per[0], periodoAnt: per[1] };
}

// ── 2 COMERCIAL ────────────────────────────────────────────────────────────────────────────────────────────
function comercial(fat, gr) {
  const chave = `${fat.ano}-${pad(fat.mes)}`, mLojas = (metas.lojas || {})[chave] || {}, cresc = metas.crescimento ?? 5;
  const lojas = fat.lojas.map(l => {
    const meta = mLojas[l.loja] > 0 ? r2(mLojas[l.loja]) : r2(l.mesAntCompleto * (1 + cresc / 100));
    const origem = mLojas[l.loja] > 0 ? 'digitada' : 'ano passado +' + cresc + '%';
    const pctMeta = pct(l.venda, meta), pctProj = pct(l.projecao, meta);
    return { loja: l.loja, nome: l.nome, venda: l.venda, meta, origem, pctMeta, projecao: l.projecao, pctProj, falta: r2(Math.max(0, meta - l.projecao)), abaixo: meta > 0 && l.projecao < meta };
  });
  const metaRede = r2(lojas.reduce((s, l) => s + l.meta, 0));
  const rede = { venda: fat.rede.venda, meta: metaRede, pctMeta: pct(fat.rede.venda, metaRede), projecao: fat.rede.projecao, pctProj: pct(fat.rede.projecao, metaRede), falta: r2(Math.max(0, metaRede - fat.rede.projecao)), abaixo: metaRede > 0 && fat.rede.projecao < metaRede };
  // setores com queda de margem: rede (soma das lojas) e por loja
  const agg = {};
  for (const r of gr.rows) { const k = r.loja + '|' + r.grupo, a = agg[k] || (agg[k] = { loja: r.loja, grupo: r.grupo, vA: 0, cA: 0, vP: 0, cP: 0 }); if (r.periodo === 'atual') { a.vA += r.v; a.cA += r.c; } else { a.vP += r.v; a.cP += r.c; } }
  const porLoja = Object.values(agg).map(a => ({ ...a, margem: pct(a.vA - a.cA, a.vA), margemAnt: pct(a.vP - a.cP, a.vP) })).filter(a => a.vA > 0 && a.vP > 0).map(a => ({ ...a, queda: a.margem != null && a.margemAnt != null ? r1(a.margem - a.margemAnt) : null, vA: r2(a.vA), vP: r2(a.vP), impacto: r2((a.margem - a.margemAnt) / 100 * a.vA) }));
  const redeAgg = {};
  for (const a of Object.values(agg)) { const g = redeAgg[a.grupo] || (redeAgg[a.grupo] = { grupo: a.grupo, vA: 0, cA: 0, vP: 0, cP: 0 }); g.vA += a.vA; g.cA += a.cA; g.vP += a.vP; g.cP += a.cP; }
  const setores = Object.values(redeAgg).map(a => ({ ...a, margem: pct(a.vA - a.cA, a.vA), margemAnt: pct(a.vP - a.cP, a.vP) })).filter(a => a.vA > 0 && a.vP > 0).map(a => ({ ...a, queda: r1(a.margem - a.margemAnt), vA: r2(a.vA), vP: r2(a.vP), impacto: r2((a.margem - a.margemAnt) / 100 * a.vA) })).sort((x, y) => x.impacto - y.impacto);
  return { chave, crescimento: cresc, lojas, rede, setores, setoresPorLoja: porLoja.sort((x, y) => x.impacto - y.impacto), periodoAtual: gr.periodoAtual, periodoAnt: gr.periodoAnt };
}

// ── 2b COMPRADORES (Tiago, 23/09/2026): visão geral por comprador e por lista dele — quanto comprou no mês,
// margem e markup que a lista está deixando na venda, e a avaria da lista. Só leitura, pra decisão rápida.
//   listas/itens: central.c_cotacao_lista + c_cotacao_lista_itens; comprador da lista: NREGS_COMPRADOR (server.js)
//   venda/custo: zcupomitens do mês (6 lojas); compra: compraprodutos COMPRA (Custo × QtdEntradaEstoque, lojas 1-6 e CD)
//   avaria: avariaconsumo Tipo 1 (Status 9 é lixo). Item em 2 listas: rateia meio a meio.
async function compradores(hoje) {
  const q = deps.q, ano = hoje.getFullYear(), mes = hoje.getMonth() + 1, mm = 'mes' + pad(mes);
  const dIni = `${ano}-${pad(mes)}-01`, dHoje = iso(hoje);
  const cad = await q(`SELECT nReg, TRIM(Nome) nome, TRIM(NomeFornec) fornecedor, CodFornec FROM central.c_cotacao_lista`);
  const compPorLista = {};
  for (const [comp, ids] of Object.entries((deps.getNregsComprador && deps.getNregsComprador()) || {})) for (const id of ids) compPorLista[id] = comp;
  const listas = {}; for (const l of cad) listas[+l.nReg] = { lista: +l.nReg, nome: l.nome, fornecedor: l.fornecedor, comprador: compPorLista[+l.nReg] || 'Sem comprador', venda: 0, custo: 0, comprado: 0, avaria: 0, avariaQtd: 0, itens: 0 };
  const itens = await q(`SELECT nCotacao nLista, Codigobarra cod FROM central.c_cotacao_lista_itens`);
  const doItem = {}; for (const i of itens) { const c = String(i.cod || '').trim(); if (!c || !listas[+i.nLista]) continue; (doItem[c] || (doItem[c] = [])).push(+i.nLista); listas[+i.nLista].itens++; }
  const soma = (cod, campo, v) => { const ls = doItem[String(cod || '').trim()]; if (!ls || !v) return; const parte = v / ls.length; for (const id of ls) listas[id][campo] += parte; };
  for (const ln of LOJAS) {
    const rows = await q(`SELECT Codigo cod, SUM(ValorTotalNovo) v, SUM(Custo) c FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [dIni, dHoje]).catch(e => { console.error('[DASHBOARD] compradores venda L' + ln, e.message); return []; });
    for (const r of rows) { soma(r.cod, 'venda', num(r.v)); soma(r.cod, 'custo', num(r.c)); }
  }
  const compras = await q(`SELECT CodigoBarra cod, SUM(CAST(REPLACE(Custo,',','.') AS DECIMAL(14,4)) * CAST(REPLACE(QtdEntradaEstoque,',','.') AS DECIMAL(14,3))) v
                            FROM central.compraprodutos WHERE DataEntrada BETWEEN ? AND ? AND Movimentacao='COMPRA' AND Cancelado=0 AND nLoja IN (1,2,3,4,5,6,10) GROUP BY CodigoBarra`, [dIni, dHoje]).catch(e => { console.error('[DASHBOARD] compradores compras', e.message); return []; });
  for (const r of compras) soma(r.cod, 'comprado', num(r.v));
  const av = await q(`SELECT CodigoBarras cod, SUM(Total) v, SUM(Qtd) qtd FROM central.avariaconsumo WHERE Tipo=1 AND Status<>9 AND DataLan BETWEEN ? AND ? GROUP BY CodigoBarras`, [dIni, dHoje]).catch(e => { console.error('[DASHBOARD] compradores avaria', e.message); return []; });
  for (const r of av) { soma(r.cod, 'avaria', num(r.v)); soma(r.cod, 'avariaQtd', num(r.qtd)); }
  const fecha = o => ({ ...o, venda: r2(o.venda), custo: r2(o.custo), comprado: r2(o.comprado), avaria: r2(o.avaria), avariaQtd: r1(o.avariaQtd), margem: pct(o.venda - o.custo, o.venda), markup: pct(o.venda - o.custo, o.custo), avariaPct: pct(o.avaria, o.venda) });
  const porComp = {};
  for (const l of Object.values(listas)) { if (!l.venda && !l.comprado && !l.avaria) continue; const c = porComp[l.comprador] || (porComp[l.comprador] = { comprador: l.comprador, listas: [], venda: 0, custo: 0, comprado: 0, avaria: 0, avariaQtd: 0 }); c.listas.push(fecha(l)); c.venda += l.venda; c.custo += l.custo; c.comprado += l.comprado; c.avaria += l.avaria; c.avariaQtd += l.avariaQtd; }
  const lista = Object.values(porComp).map(c => ({ ...fecha(c), listas: c.listas.sort((a, b) => b.venda - a.venda), qtdListas: c.listas.length })).sort((a, b) => (a.comprador === 'Sem comprador') - (b.comprador === 'Sem comprador') || b.venda - a.venda);
  const tot = fecha(lista.reduce((s, c) => ({ venda: s.venda + c.venda, custo: s.custo + c.custo, comprado: s.comprado + c.comprado, avaria: s.avaria + c.avaria, avariaQtd: s.avariaQtd + c.avariaQtd }), { venda: 0, custo: 0, comprado: 0, avaria: 0, avariaQtd: 0 }));
  return { de: dIni, ate: dHoje, compradores: lista, total: tot };
}

// ── 3 ABASTECIMENTO ────────────────────────────────────────────────────────────────────────────────────────
function abastecimento() {
  const rp = deps.radarPedidos, out = { curvaA: null, listas: null, cd: null, fornecedores: null };
  if (rp) {
    try { const c = rp.curvaARisco(rp.TETO_PADRAO, null, undefined, true);
      const itens = (c.itens || []).filter(i => (i.lojas_zeradas || []).length || i.acao === 'pedir_hoje' || i.zera_antes).sort((a, b) => (b.lojas_zeradas || []).length - (a.lojas_zeradas || []).length || b.venda_dia_valor - a.venda_dia_valor);
      out.curvaA = { resumo: c.resumo, itens: itens.slice(0, 60).map(i => ({ cod: i.cod, descricao: i.descricao, rank: i.rank, venda_dia_valor: i.venda_dia_valor, estoque: i.estoque, cobertura_dias: i.cobertura_dias, lojas_zeradas: (i.lojas_zeradas || []).map(x => x.loja), lista: i.lista, lista_nome: i.lista_nome, fornecedor: i.fornecedor, comprador: i.comprador, acao: i.acao, fazer_em: i.fazer_em })),
        transferir: (c.itens || []).filter(i => i.acao === 'transferir').slice(0, 60).map(i => ({ cod: i.cod, descricao: i.descricao, lojas_zeradas: (i.lojas_zeradas || []).map(x => x.loja), lojas_com_estoque: Object.keys(i.lojas_det || {}).filter(l => ((i.lojas_det || {})[l] || {}).estoque > 0).map(Number), lojas_det: i.lojas_det, venda_dia_valor: i.venda_dia_valor })) };
    } catch (e) { console.error('[DASHBOARD] curvaA', e.message); }
    try { const ls = rp.politica(rp.TETO_PADRAO, null, undefined, true).filter(l => l.ok);
      const hoje = ls.filter(l => l.fazer_em <= 0), sete = ls.filter(l => l.fazer_em > 0 && l.fazer_em <= 7);
      out.listas = { total: ls.length, pedirHoje: hoje.length, valorHoje: r2(hoje.reduce((s, l) => s + (l.pedido_valor || 0), 0)), proximos7: sete.length, rupturas: ls.reduce((s, l) => s + (l.rupturas || 0), 0),
        itens: hoje.sort((a, b) => a.fazer_em - b.fazer_em || (b.pedido_valor || 0) - (a.pedido_valor || 0)).slice(0, 15).map(l => ({ lista: l.lista, nome: l.nome, fornecedor: l.fornecedor, comprador: l.comprador, fazer_em: l.fazer_em, data: l.data, pedido_valor: l.pedido_valor, rupturas: l.rupturas, gatilho: l.gatilho })) };
    } catch (e) { console.error('[DASHBOARD] listas', e.message); }
  }
  if (deps.pedidosCd) {
    try { const pend = deps.pedidosCd.pendenciasCD(); const itens = Object.entries(pend).map(([k, v]) => ({ loja: +k.split('|')[1], unidade: k.split('|')[0], descricao: v.descricaoCD, faltaCx: v.faltaCx, pedidoId: v.pedidoId, criadoEm: v.criadoEm }));
      const pedidos = deps.pedidosCd.listarPedidos ? deps.pedidosCd.listarPedidos() : [];
      const abertos = pedidos.filter(p => ['aberto', 'separado'].includes(p.status));
      const limite = Date.now() - 3 * 86400000;
      out.cd = { pendencias: itens.length, caixasFaltando: itens.reduce((s, i) => s + i.faltaCx, 0), abertos: abertos.length, atrasados: abertos.filter(p => new Date(p.criadoEm).getTime() < limite).length,
        itens: itens.sort((a, b) => b.faltaCx - a.faltaCx).slice(0, 60), pedidosAtrasados: abertos.filter(p => new Date(p.criadoEm).getTime() < limite).slice(0, 10).map(p => ({ id: p.id, loja: p.loja, status: p.status, criadoEm: p.criadoEm, itens: (p.itens || []).length })) };
    } catch (e) { console.error('[DASHBOARD] cd', e.message); }
  }
  if (deps.pedidosFornecedor) {
    try { const ps = deps.pedidosFornecedor.listar().filter(p => !p.teste);
      const dias = p => Math.floor((Date.now() - new Date(p.aprovadoEm || p.finalizadoEm || p.criadoEm).getTime()) / 86400000);
      const parados = ps.filter(p => (['aguardando', 'digitacao'].includes(p.status) && Math.floor((Date.now() - new Date(p.criadoEm).getTime()) / 86400000) >= 2) || (p.status === 'aprovado' && dias(p) >= 5));
      const valorDe = p => r2((p.itens || []).reduce((s, i) => s + (i.qtd || 0) * (i.preco || i.ultimo_custo || 0), 0));
      out.fornecedores = { total: ps.filter(p => !['recebido', 'cancelado'].includes(p.status)).length, parados: parados.length,
        itens: parados.sort((a, b) => a.criadoEm.localeCompare(b.criadoEm)).slice(0, 60).map(p => ({ id: p.id, lojas: p.lojas || [], fornecedor: p.fornecedor || '', lista: p.lista_nome || p.lista, status: p.status, dias: Math.floor((Date.now() - new Date(p.criadoEm).getTime()) / 86400000), valor: valorDe(p) })) };
    } catch (e) { console.error('[DASHBOARD] fornecedores', e.message); }
  }
  return out;
}

// ── 4 ESTOQUE ──────────────────────────────────────────────────────────────────────────────────────────────
async function estoque(hoje) {
  const q = deps.q, out = { excesso: null, vencimentos: null, transferencias: null };
  if (deps.sortimento) {
    try { const rows = deps.sortimento.filtrar({ escopo: 'todos' }); const R = deps.sortimento.resumo(rows);
      const exc = rows.filter(r => r.classe === 'cobertura_excessiva').sort((a, b) => b.valorEst - a.valorEst);
      out.excesso = { itens: R.cobExc, valor: r2(R.valorCobExc), parados: R.parado, valorParados: r2(R.valorParado), porLoja: R.porLoja, calculadoEm: deps.sortimento.estado().calculadoEm,
        top: exc.slice(0, 90).map(r => ({ loja: r.loja, cod: r.cod, descricao: r.descricao, est: r.est, valorEst: r.valorEst, cob: r.cob, v6: r.v6, lista: r.lista, nome: r.nome })) };
    } catch (e) { console.error('[DASHBOARD] excesso', e.message); }
  }
  try {
    const d30 = new Date(hoje); d30.setDate(d30.getDate() + 30);
    const porLoja = {}, top = []; let n = 0, valor = 0; const buckets = { d7: 0, d15: 0, d30: 0 };
    for (const ln of LOJAS) {
      const rs = await q(`SELECT v.Codigobarra cod, TRIM(i.Descricao) descricao, DATE_FORMAT(MIN(v.Data),'%Y-%m-%d') validade, e.Qtd est, c.Custo custo
                          FROM central.itenscoletorvalidade v JOIN central.itens i ON i.CodigoBarra = v.Codigobarra AND i.CodDesativado = 0
                          JOIN central.estoquen${ln} e ON e.CodigoBarra = v.Codigobarra LEFT JOIN central.custoloja${ln} c ON c.CodigoBarra = v.Codigobarra
                          WHERE v.nLoja = ? AND v.Data BETWEEN ? AND ? AND CAST(REPLACE(e.Qtd, ',', '.') AS DECIMAL(12,3)) > 0 GROUP BY v.Codigobarra`, [ln, iso(hoje), iso(d30)]).catch(e => { console.error('[DASHBOARD] validade', ln, e.message); return []; });
      const L = porLoja[ln] = { itens: 0, valor: 0 };
      for (const r of rs) { const est = num(r.est), cu = num(r.custo), val = r2(est * cu), dias = Math.round((new Date(r.validade) - hoje) / 86400000);
        n++; valor += val; L.itens++; L.valor += val; if (dias <= 7) buckets.d7++; else if (dias <= 15) buckets.d15++; else buckets.d30++;
        top.push({ loja: ln, cod: r.cod, descricao: r.descricao, validade: r.validade, dias, est, custo: cu, valor: val }); }
      L.valor = r2(L.valor);
    }
    out.vencimentos = { itens: n, valor: r2(valor), buckets, porLoja, top: top.sort((a, b) => b.valor - a.valor).slice(0, 90) };
  } catch (e) { console.error('[DASHBOARD] vencimentos', e.message); }
  return out;
}

// ── 5 OPERAÇÃO ─────────────────────────────────────────────────────────────────────────────────────────────
async function operacao(hoje) {
  const q = deps.q, mm = 'mes' + pad(hoje.getMonth() + 1), dHoje = iso(hoje);
  const agora = hoje.getHours() * 60 + hoje.getMinutes(), h1 = new Date(hoje.getTime() - 3600000), hIni = `${pad(h1.getHours())}:${pad(h1.getMinutes())}:00`;
  const aberta = agora >= 7 * 60 && agora <= 21 * 60 + 30, LIMITE_PARADO = 45;
  const lojas = [];
  for (const ln of LOJAS) {
    const rs = await q(`SELECT nECF pdv, COUNT(DISTINCT CCF) cupons, MAX(Hora) ult, MIN(Hora) primeiro, COUNT(DISTINCT CASE WHEN Hora >= ? THEN CCF END) ultHora, MAX(Operador) operador
                        FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data = ? AND IndCancel='N' GROUP BY nECF ORDER BY nECF`, [hIni, dHoje]).catch(() => []);
    const pdvs = rs.map(r => { const [hh, mi] = String(r.ult || '00:00').split(':').map(Number); const min = agora - (hh * 60 + mi); return { pdv: r.pdv, cupons: +r.cupons, ultHora: +r.ultHora, ult: String(r.ult || '').slice(0, 5), primeiro: String(r.primeiro || '').slice(0, 5), operador: r.operador || '', semCupomMin: min, parado: aberta && min > LIMITE_PARADO }; });
    lojas.push({ loja: ln, nome: NOMES[ln], caixasAtivos: pdvs.length, cupons: pdvs.reduce((s, p) => s + p.cupons, 0), ultHora: pdvs.reduce((s, p) => s + p.ultHora, 0), parados: pdvs.filter(p => p.parado).length, pdvs });
  }
  return { hora: `${pad(hoje.getHours())}:${pad(hoje.getMinutes())}`, lojaAberta: aberta, limiteParadoMin: LIMITE_PARADO, lojas, refrigeracao: null, filas: null };
}

// ── 6 FINANCEIRO ───────────────────────────────────────────────────────────────────────────────────────────
// 25/09/26: a versão anterior fazia LEFT JOIN de contasapagar com uma subquery derivada (SUM das baixas por nReg),
// duas vezes (dias + maiores títulos). No MySQL 5.0 do .252 a tabela derivada não ganha índice e as duas tabelas só
// têm PRIMARY (nReg / nInd), então o plano era 41.899 títulos do ano × 145.050 linhas da derivada = minutos, a cada
// abertura da tela e a cada recálculo de 5 min. Agora são consultas planas (~1 s cada) e o "Valor − baixas" (mesma
// fórmula da tela Contas A Pagar do ERP) é feito aqui em memória.
async function financeiro(hoje) {
  const q = deps.q, dHoje = iso(hoje), d7 = new Date(hoje); d7.setDate(d7.getDate() + 7); const dFim = iso(d7);
  const ini = `${hoje.getFullYear()}-01-01`;
  // 1) títulos do ano até daqui a 7 dias (vencidos + próximos), sem join
  const titulos = await q(`SELECT nReg, Filial loja, DATE_FORMAT(DataVencto,'%Y-%m-%d') d, Valor, nDoc doc
                           FROM loja20045.contasapagar WHERE DataVencto BETWEEN ? AND ?`, [ini, dFim]).catch(e => { console.error('[DASHBOARD] a pagar', e.message); return []; });
  // 2) baixas desses títulos (só a faixa de nReg que interessa), agrupadas no banco
  let minReg = Infinity; for (const t of titulos) { const n = +t.nReg; if (n < minReg) minReg = n; }
  const pago = new Map();
  if (titulos.length) {
    const bx = await q(`SELECT nReg, SUM(Valor) pago FROM loja20045.contasapagarbaixaconta WHERE nReg >= ? GROUP BY nReg`, [minReg]).catch(e => { console.error('[DASHBOARD] baixas', e.message); return []; });
    for (const b of bx) pago.set(+b.nReg, num(b.pago));
  }
  // 3) casamento: em aberto = Valor − baixas; só o que ainda deve (> 0,01)
  const porDia = {}, porLoja = {}, linhasMap = {}, abertos7 = []; const vencidos = { n: 0, v: 0 }, hojeT = { n: 0, v: 0 }, sete = { n: 0, v: 0 };
  for (const t of titulos) {
    const v = num(t.Valor) - (pago.get(+t.nReg) || 0); if (v <= 0.01) continue;
    const ln = +t.loja, d = t.d;
    const L = porLoja[ln] = porLoja[ln] || { loja: ln, nome: NOMES[ln] || 'Filial ' + ln, vencidos: 0, hoje: 0, sete: 0, n: 0 };
    const li = linhasMap[ln + '|' + d] || (linhasMap[ln + '|' + d] = { loja: ln, data: d, n: 0, v: 0 }); li.n++; li.v += v;
    if (d < dHoje) { vencidos.n++; vencidos.v += v; L.vencidos += v; L.n++; }
    else { const D = porDia[d] || (porDia[d] = { data: d, n: 0, v: 0 }); D.n++; D.v += v; sete.n++; sete.v += v; L.sete += v; L.n++; if (d === dHoje) { hojeT.n++; hojeT.v += v; L.hoje += v; }
      abertos7.push({ nReg: +t.nReg, loja: ln, doc: t.doc, data: d, valor: r2(v) }); }
  }
  // 4) nome do fornecedor só pros 60 maiores (busca por PRIMARY)
  abertos7.sort((a, b) => b.valor - a.valor); const top = abertos7.slice(0, 60); const nomeFornec = {};
  if (top.length) {
    const rs = await q(`SELECT c.nReg, f.Nome fornecedor, c.Historico hist FROM loja20045.contasapagar c LEFT JOIN central.fornecedor f ON f.CodFornec = c.CodFornec
                        WHERE c.nReg IN (${top.map(() => '?').join(',')})`, top.map(t => t.nReg)).catch(() => []);
    for (const r of rs) nomeFornec[+r.nReg] = r.fornecedor || r.hist || '';
  }
  const dias = []; for (let i = 0; i <= 7; i++) { const d = new Date(hoje); d.setDate(d.getDate() + i); const k = iso(d); dias.push(porDia[k] || { data: k, n: 0, v: 0 }); }
  return { vencidos: { n: vencidos.n, v: r2(vencidos.v) }, hoje: { n: hojeT.n, v: r2(hojeT.v) }, sete: { n: sete.n, v: r2(sete.v) }, dias: dias.map(d => ({ ...d, v: r2(d.v) })),
    porLoja: Object.values(porLoja).map(l => ({ ...l, vencidos: r2(l.vencidos), hoje: r2(l.hoje), sete: r2(l.sete) })).sort((a, b) => a.loja - b.loja),
    maiores: top.map(m => ({ loja: m.loja, fornecedor: nomeFornec[m.nReg] || '', doc: m.doc, data: m.data, valor: m.valor })),
    linhas: Object.values(linhasMap).map(l => ({ ...l, v: r2(l.v) })).sort((a, b) => a.loja - b.loja || (a.data < b.data ? -1 : a.data > b.data ? 1 : 0)), saldo: null };
}

// ── montagem ───────────────────────────────────────────────────────────────────────────────────────────────
async function calcular() {
  if (calculando) return calculando;
  calculando = (async () => {
    const t0 = Date.now(), hoje = new Date();
    const fat = await safe('faturamento', () => faturamento(hoje), null);
    const gr = await safe('grupos', () => margemGrupos(hoje), { rows: [] });
    const novo = { atualizadoEm: new Date().toISOString(), hoje: iso(hoje), _fat: fat, _grupos: gr,
      faturamento: fat, comercial: fat ? { ...comercial(fat, gr), compradores: compradoresAsync(hoje) } : null, abastecimento: abastecimento(),
      estoque: await safe('estoque', () => estoque(hoje), null), operacao: await safe('operacao', () => operacao(hoje), null), financeiro: await safe('financeiro', () => financeiro(hoje), null), ms: 0 };
    novo.ms = Date.now() - t0; cache = novo;
    console.log(`[DASHBOARD] atualizado em ${(novo.ms / 1000).toFixed(0)}s`);
  })().finally(() => { calculando = null; });
  return calculando;
}
// só a parte leve (operação = caixas de hoje) a cada chamada, se o cache tiver mais de 2 min
async function dados() {
  if (!cache) { calcular().catch(e => console.error('[DASHBOARD]', e.message)); return { calculando: true, nomes: NOMES, metas }; }   // 1ª carga: responde já, a tela tenta de novo em 30 s
  else if (!cache.demo && Date.now() - new Date(cache.atualizadoEm).getTime() > TTL_MS && !calculando) calcular().catch(() => {});
  const { _fat, _grupos, ...pub } = cache || {};
  return { ...pub, calculando: !!calculando, nomes: NOMES, metas };
}
// Carregamento por segmento (Tiago, 22/09: "melhor escolher um bloco do que abrir tudo de uma vez e demorar"):
// a tela pede só o bloco clicado. Se o cálculo completo (em segundo plano) já estiver fresco, sai dele; senão
// calcula só aquele bloco, com cache próprio de 5 min.
const SEGS = { faturamento: 1, comercial: 2, abastecimento: 3, estoque: 4, operacao: 5, financeiro: 6 };
let segCache = {}, segCalc = {};
let compCache = null, compCalc = null;
function compradoresAsync(hoje) {
  if (compCache && fresco(compCache)) return compCache.dados;
  if (!compCalc) compCalc = compradores(hoje).then(r => { compCache = { atualizadoEm: new Date().toISOString(), dados: r }; console.log('[DASHBOARD] compradores calculados'); return r; }).catch(e => { console.error('[DASHBOARD] compradores', e.message); return null; }).finally(() => { compCalc = null; });
  return compCache ? compCache.dados : null;
}
const fresco = c => !!c && Date.now() - new Date(c.atualizadoEm).getTime() < TTL_MS;
async function segmento(nome) {
  if (!SEGS[nome]) throw new Error('segmento inválido: ' + nome);
  if (cache && (cache.demo || fresco(cache)) && cache[nome] != null) { const r = { atualizadoEm: cache.atualizadoEm, hoje: cache.hoje, origem: cache.demo ? 'demo' : 'completo' }; r[nome] = cache[nome]; if (nome === 'comercial') r.faturamento = cache.faturamento; return r; }
  if (fresco(segCache[nome])) return segCache[nome];
  if (segCalc[nome]) return segCalc[nome];
  segCalc[nome] = (async () => {
    const hoje = new Date(), t0 = Date.now(), out = {};
    if (nome === 'faturamento') out.faturamento = await faturamento(hoje);
    else if (nome === 'comercial') {
      const fat = fresco(segCache.faturamento) ? segCache.faturamento.faturamento : (cache && fresco(cache) && cache.faturamento) || await faturamento(hoje);
      const gr = await safe('grupos', () => margemGrupos(hoje), { rows: [] });
      out.faturamento = fat; out.comercial = fat ? { ...comercial(fat, gr), compradores: compradoresAsync(hoje) } : null;
      segCache.faturamento = { faturamento: fat, atualizadoEm: new Date().toISOString(), hoje: iso(hoje), origem: 'segmento' };
    }
    else if (nome === 'abastecimento') out.abastecimento = abastecimento();
    else if (nome === 'estoque') out.estoque = await estoque(hoje);
    else if (nome === 'operacao') out.operacao = await operacao(hoje);
    else if (nome === 'financeiro') out.financeiro = await financeiro(hoje);
    const r = { ...out, atualizadoEm: new Date().toISOString(), hoje: iso(hoje), ms: Date.now() - t0, origem: 'segmento' };
    segCache[nome] = r; console.log(`[DASHBOARD] segmento ${nome} em ${(r.ms / 1000).toFixed(1)}s`); return r;
  })().finally(() => { segCalc[nome] = null; });
  return segCalc[nome];
}
// capa: o que já está pronto em cache (não calcula nada)
function resumo() {
  const tem = k => (cache && cache[k] != null) || !!(segCache[k] && segCache[k][k] != null);
  return { pronto: Object.fromEntries(Object.keys(SEGS).map(k => [k, tem(k)])), atualizadoEm: cache ? cache.atualizadoEm : null, calculando: !!calculando, hoje: iso(new Date()), nomes: NOMES, metas };
}
function agendar() { if (cache && cache.demo) return; setTimeout(() => calcular().catch(e => console.error('[DASHBOARD]', e.message)), 20 * 1000); }

module.exports = { init, agendar, calcular, dados, segmento, resumo, getMetas, setMetas, compradores, NOMES };
