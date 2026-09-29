// Dashboard novo (21/09/2026, pedido do Tiago): uma tela em 6 segmentos, calculada no servidor e servida por
// /api/dashboard (cache em memória, recalculado em segundo plano a cada 5 min).
//   1 Faturamento   — loja a loja + rede: mês até hoje × mesmo período do ano passado, margem, markup, ticket, cupons;
//                     e o dia de hoje × mesmo dia da semana do ano anterior até a hora atual, com os mesmos indicadores (Tiago 29/09/26)
//   2 Comercial     — lojas abaixo da meta (meta gravada em data/dashboard-metas.json ou ano passado + %),
//                     setores (departamentos) com queda de margem (mês atual × mês anterior)
//   3 Abastecimento — curva A em falta (Radar de Pedidos), listas pra pedir hoje/atrasadas, pendências do CD,
//                     pedidos ao fornecedor parados
//   4 Estoque       — excesso (Sortimento), vencimentos próximos (itenscoletorvalidade × estoque), transferências
//   5 Operação      — checkouts por loja (PDV, operadora que abriu, venda) e movimentação do caixa por operadora
//                     (dinheiro/cartão/PIX/vale, cancelamentos por motivo, sangrias, quebra) — hoje × acumulado do mês
//                     (vendas.relatoriofecl{loja}, zcupomitenscancelados, quebradecaixa, trocosolidario, zcupomitensdesconto)
//   6 Financeiro    — compromissos dos próximos 7 dias e vencidos (loja20045.contasapagar − baixas); saldo sem fonte
// SOMENTE LEITURA no ERP. Único arquivo gravado: data/dashboard-metas.json.
'use strict';
const fs = require('fs');
const path = require('path');

const METAS = path.join(__dirname, '..', 'data', 'dashboard-metas.json');
const PARADO_ARQ = path.join(__dirname, '..', 'data', 'dashboard-estoque.json');   // estoque por loja / parado (1× por dia)
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
let finGrupos = null, finGruposEm = 0;   // nomes dos grupos do plano de contas (loja20045.planodecontas, PlanoSub 0)
function lerJson(f, p) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return p; } }
function init(d) { deps = d; metas = lerJson(METAS, { crescimento: 5, lojas: {} }); parado = lerJson(PARADO_ARQ, null);
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
                                COALESCE(SUM(CASE WHEN Data=? THEN Custo END),0) ch, COALESCE(SUM(CASE WHEN Data=? THEN ValorTotalNovo END),0) vo,
                                MAX(CASE WHEN Data=? THEN Hora END) hmax
                         FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`, [dHoje, dHoje, dHoje, dOntem, dHoje, dIni, dHoje]).catch(() => [{}]);
    const [b] = await q(`SELECT COALESCE(SUM(CASE WHEN Data<=? THEN ValorTotalNovo END),0) v, COALESCE(SUM(CASE WHEN Data<=? THEN Custo END),0) c,
                                COUNT(DISTINCT CASE WHEN Data<=? THEN CONCAT(nECF,'-',CCF) END) n, COALESCE(SUM(ValorTotalNovo),0) vMes, COALESCE(SUM(CASE WHEN Data=? THEN ValorTotalNovo END),0) vhAnt
                         FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`, [dHojeAnt, dHojeAnt, dHojeAnt, dHojeAnt, dIniAnt, dFimAnt]).catch(() => [{}]);
    const [nf] = await q(`SELECT COUNT(*) n, COALESCE(SUM(TotalNota),0) v, COALESCE(SUM(CASE WHEN DataLan=? THEN TotalNota END),0) vh, COUNT(CASE WHEN DataLan=? THEN 1 END) nh
                          FROM central.compras WHERE nLoja=? AND Movimentacao='VENDA' AND Tipo='NF' AND Status='F' AND DataLan BETWEEN ? AND ?`, [dHoje, dHoje, ln, dIni, dHoje]).catch(() => ({}));
    const [nfA] = await q(`SELECT COUNT(*) n, COALESCE(SUM(TotalNota),0) v, COALESCE(SUM(CASE WHEN DataLan=? THEN TotalNota END),0) vh
                          FROM central.compras WHERE nLoja=? AND Movimentacao='VENDA' AND Tipo='NF' AND Status='F' AND DataLan BETWEEN ? AND ?`, [dHojeAntSem, ln, dIniAnt, dHojeAnt]).catch(() => ({}));
    // hoje × mesmo dia da semana do ano anterior (364 dias atrás): venda, custo e cupons. Corte na hora do ÚLTIMO cupom de hoje que já
    // chegou na central (os cupons das lojas sincronizam com horas de atraso: em 29/09 às 13:04 a E4 só tinha cupom até 08:42), não no relógio
    const hCorte = a.hmax ? String(a.hmax).slice(0, 8) : horaAgora;
    const [hAnt] = cd ? [{}] : await q(`SELECT COALESCE(SUM(ValorTotalNovo),0) v, COALESCE(SUM(Custo),0) c, COUNT(DISTINCT CONCAT(nECF,'-',CCF)) n FROM \`ln${ln}${mmAntSem}\`.zcupomitens WHERE Data=? AND Hora<=? AND IndCancel='N'`, [dHojeAntSem, hCorte]).catch(() => [{}]);
    const nfe = { n: +(nf || {}).n || 0, v: r2(num((nf || {}).v)), vh: r2(num((nf || {}).vh)), nh: +(nf || {}).nh || 0, nAnt: +(nfA || {}).n || 0, vAnt: r2(num((nfA || {}).v)), vhAnt: r2(num((nfA || {}).vh)) };
    nfe.var = nfe.vAnt > 0 ? r1((nfe.v / nfe.vAnt - 1) * 100) : null;
    // CD: custo da venda = Custo × Qtd dos itens das NF-e de saída (compraprodutos), só pra margem/markup
    const [nfc] = cd ? await q(`SELECT COALESCE(SUM(CAST(REPLACE(p.Custo,',','.') AS DECIMAL(14,4)) * CAST(REPLACE(p.Qtd,',','.') AS DECIMAL(14,3))),0) c,
                                 COALESCE(SUM(CASE WHEN c.DataLan=? THEN CAST(REPLACE(p.Custo,',','.') AS DECIMAL(14,4)) * CAST(REPLACE(p.Qtd,',','.') AS DECIMAL(14,3)) END),0) ch
                          FROM central.compraprodutos p JOIN central.compras c ON c.nCompra=p.nCompra AND c.nLoja=p.nLoja
                          WHERE p.nLoja=? AND c.Movimentacao='VENDA' AND c.Tipo='NF' AND c.Status='F' AND c.DataLan BETWEEN ? AND ? AND p.Cancelado=0`, [dHoje, ln, dIni, dHoje]).catch(() => [{}]) : [{}];
    const v = cd ? nfe.v : num(a.v), c = cd ? num((nfc || {}).c) : num(a.c), n = cd ? 0 : (+a.n || 0), vAnt = cd ? nfe.vAnt : num(b.v), cAnt = num(b.c), nAnt = cd ? 0 : (+b.n || 0);
    // dia: venda, custo e cupons de hoje × mesmo dia da semana do ano anterior até a hora atual (CD: só NF-e, sem cupom; sem custo do dia do ano anterior)
    const vh = cd ? nfe.vh : num(a.vh), ch = cd ? num((nfc || {}).ch) : num(a.ch), nh = cd ? 0 : (+a.nh || 0);
    const vhA = cd ? nfe.vhAnt : num((hAnt || {}).v), chA = cd ? 0 : num((hAnt || {}).c), nhA = cd ? 0 : (+(hAnt || {}).n || 0);
    lojas.push({ loja: ln, nome: cd ? 'CD · CAHU DISTRIBUIDORA' : NOMES[ln], cd, nfe, venda: r2(v), custo: r2(c), cupons: n, ticket: n ? r2(v / n) : 0, margem: pct(v - c, v), markup: pct(v - c, c),
      vendaAnt: r2(vAnt), custoAnt: r2(cAnt), cuponsAnt: nAnt, ticketAnt: nAnt ? r2(vAnt / nAnt) : 0, margemAnt: pct(vAnt - cAnt, vAnt), markupAnt: pct(vAnt - cAnt, cAnt), var: vAnt > 0 ? r1((v / vAnt - 1) * 100) : null,
      varCupons: nAnt > 0 ? r1((n / nAnt - 1) * 100) : null, hoje: r2(vh), hojeAnt: r2(vhA), hojeAntData: dHojeAntSem, hojeAntHora: cd ? null : hCorte, cuponsHoje: nh, ontem: r2(num(a.vo)), mesAntCompleto: r2(num(b.vMes)),
      custoHoje: r2(ch), ticketHoje: nh ? r2(vh / nh) : 0, margemHoje: pct(vh - ch, vh), markupHoje: pct(vh - ch, ch), varHoje: vhA > 0 ? r1((vh / vhA - 1) * 100) : null,
      custoHojeAnt: r2(chA), cuponsHojeAnt: nhA, ticketHojeAnt: nhA ? r2(vhA / nhA) : 0, margemHojeAnt: cd ? null : pct(vhA - chA, vhA), markupHojeAnt: cd ? null : pct(vhA - chA, chA), varCuponsHoje: nhA > 0 ? r1((nh / nhA - 1) * 100) : null,
      projecao: dia > 0 ? r2(v / dia * ultimoDia) : 0 });
    if (cd) { const L = lojas[lojas.length - 1]; L.margemAnt = null; L.markupAnt = null; L.ticket = 0; L.ticketAnt = 0; L.cuponsAnt = 0; L.varCupons = null; }
  }
  const NF = lojas.filter(l => !l.cd).reduce((s, l) => ({ n: s.n + l.nfe.n, v: s.v + l.nfe.v, vh: s.vh + l.nfe.vh, nh: s.nh + l.nfe.nh, vAnt: s.vAnt + l.nfe.vAnt }), { n: 0, v: 0, vh: 0, nh: 0, vAnt: 0 });
  const t = lojas.filter(l => !l.cd).reduce((s, l) => ({ venda: s.venda + l.venda, custo: s.custo + l.custo, cupons: s.cupons + l.cupons, vendaAnt: s.vendaAnt + l.vendaAnt, cuponsAnt: s.cuponsAnt + l.cuponsAnt, hoje: s.hoje + l.hoje, hojeAnt: s.hojeAnt + (l.hojeAnt || 0), cuponsHoje: s.cuponsHoje + l.cuponsHoje, ontem: s.ontem + l.ontem, mesAntCompleto: s.mesAntCompleto + l.mesAntCompleto, projecao: s.projecao + l.projecao, custoAnt: s.custoAnt + l.custoAnt,
    custoHoje: s.custoHoje + (l.custoHoje || 0), custoHojeAnt: s.custoHojeAnt + (l.custoHojeAnt || 0), cuponsHojeAnt: s.cuponsHojeAnt + (l.cuponsHojeAnt || 0) }),
    { venda: 0, custo: 0, cupons: 0, vendaAnt: 0, cuponsAnt: 0, hoje: 0, hojeAnt: 0, cuponsHoje: 0, ontem: 0, mesAntCompleto: 0, projecao: 0, custoAnt: 0, custoHoje: 0, custoHojeAnt: 0, cuponsHojeAnt: 0 });
  const rede = { loja: 0, nome: 'REDE', venda: r2(t.venda), custo: r2(t.custo), cupons: t.cupons, ticket: t.cupons ? r2(t.venda / t.cupons) : 0, margem: pct(t.venda - t.custo, t.venda), markup: pct(t.venda - t.custo, t.custo),
    vendaAnt: r2(t.vendaAnt), cuponsAnt: t.cuponsAnt, ticketAnt: t.cuponsAnt ? r2(t.vendaAnt / t.cuponsAnt) : 0, margemAnt: pct(t.vendaAnt - t.custoAnt, t.vendaAnt), markupAnt: pct(t.vendaAnt - t.custoAnt, t.custoAnt), var: t.vendaAnt > 0 ? r1((t.venda / t.vendaAnt - 1) * 100) : null,
    varCupons: t.cuponsAnt > 0 ? r1((t.cupons / t.cuponsAnt - 1) * 100) : null, hoje: r2(t.hoje), hojeAnt: r2(t.hojeAnt), cuponsHoje: t.cuponsHoje, ontem: r2(t.ontem), mesAntCompleto: r2(t.mesAntCompleto), projecao: r2(t.projecao),
    custoHoje: r2(t.custoHoje), ticketHoje: t.cuponsHoje ? r2(t.hoje / t.cuponsHoje) : 0, margemHoje: pct(t.hoje - t.custoHoje, t.hoje), markupHoje: pct(t.hoje - t.custoHoje, t.custoHoje), varHoje: t.hojeAnt > 0 ? r1((t.hoje / t.hojeAnt - 1) * 100) : null,
    custoHojeAnt: r2(t.custoHojeAnt), cuponsHojeAnt: t.cuponsHojeAnt, ticketHojeAnt: t.cuponsHojeAnt ? r2(t.hojeAnt / t.cuponsHojeAnt) : 0, margemHojeAnt: pct(t.hojeAnt - t.custoHojeAnt, t.hojeAnt), markupHojeAnt: pct(t.hojeAnt - t.custoHojeAnt, t.custoHojeAnt), varCuponsHoje: t.cuponsHojeAnt > 0 ? r1((t.cuponsHoje / t.cuponsHojeAnt - 1) * 100) : null,
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

// ── 4b ESTOQUE POR LOJA E PARADO ───────────────────────────────────────────────────────────────────────────
// Tiago, 29/09/26: "quanto eu tenho de estoque em cada loja e em todas as lojas, quanto tem de estoque parado (sem venda)
// em cada loja nos prazos de 60 / 90 / 120 ou mais dias".
// Estoque = estoquen{loja}.Qtd > 0 × custoloja{loja}.Custo (a custo, só item ativo; Qtd e Custo são texto com vírgula).
// Parado = sem venda no caixa: última venda = MAX(Data) em zcupomitens dos bancos mensais ln{loja}mes{MM} do mês atual e dos
// 4 anteriores (o banco do mês guarda mais de um ano → filtro pela data; Data e Codigo têm índice, ~0,3 s por mês × loja).
// Faixas: 60–89, 90–119 e 120 ou mais dias (quem não vendeu nada na janela de 5 meses cai em 120+). O CD (loja 10) não vende
// no caixa (sai por transferência), então mostra só o estoque. Calculado 1× por dia (ao subir, se o de disco não é de hoje,
// e às 06:10), guardado em data/dashboard-estoque.json; detalhe por loja sai da memória. Só leitura no ERP.
const LOJAS_EST = [1, 2, 3, 4, 5, 6, 10], FAIXAS = [60, 90, 120];
let parado = null, paradoCalc = null;
const faixaDe = dias => dias == null || dias >= 120 ? 120 : dias >= 90 ? 90 : dias >= 60 ? 60 : 0;
// Uso e consumo / insumo de produção não passa no caixa, então nunca "vende": fica FORA do parado e aparece em coluna própria
// (visto no dado real de 29/09: em E5 o "parado 120+" era R$ 2,07 mi, quase tudo saco de embalagem, bandeja e farinha 25 kg da
// padaria). Regra: grupo/subgrupo do mercadológico (USO E CONSUMO, PADARIA > MAT PRIMA/EMBALAGEM/INSUMOS, ATIVO IMOBILIZADO…)
// ou descrição de insumo (carcaça/traseiro/dianteiro resfriado do açougue, "PADARIA …", "INSUMO …").
const CONSUMO_RE = /USO E CONSUMO|CONSUMO|USO INTERNO|MAT(ERIAL)? ?(DE )?(EMBALAGEM|ESCRIT|LIMPEZA|EXPEDIENTE)|MAT ?PRIMA|MATERIA.PRIMA|INSUMO|EMBALAGE|ATIVO IMOBILIZADO|\bLUVAS\b|UNIFORME|\bEPI\b/i;
const INSUMO_DESC_RE = /^(PADARIA|ACOUGUE|A[CÇ]OUGUE|PROD\.?|INSUMO|CONSUMO|USO INTERNO|MAT\.? ?(DE )?(CONSUMO|LIMPEZA|ESCRIT))\b|RESFRIAD[AO]\b.*\b(TRASEIRO|DIANTEIRO)\b|\bCARCA[CÇ]A\b|\bQUARTO (TRASEIRO|DIANTEIRO)\b/i;
async function calcularParado() {
  if (paradoCalc) return paradoCalc;
  paradoCalc = (async () => {
    const q = deps.q, hoje = new Date(), dHoje = iso(hoje), t0 = Date.now(), lojas = {};
    const janelaDe = iso(new Date(hoje.getFullYear(), hoje.getMonth() - 4, 1)), janelaDias = Math.round((hoje - new Date(janelaDe + 'T12:00:00')) / 864e5);   // 1º dia do 4º mês anterior: ≥ 120 dias
    // Cadastro (item ativo → descrição, grupo e subgrupo) uma vez só, em memória. Por loja: varredura de estoquen{loja} (Qtd > 0)
    // e custo por IN de códigos (índice), como o Sortimento faz — o JOIN estoquen × custoloja levava ~50 s nas lojas grandes
    // (medido em 29/09 na E5: 9.414 itens), acima do timeout de 20 s do q().
    const cad = new Map();
    {
      const gs = {}, gr = {};
      for (const r of await q('SELECT CodGrupo, TRIM(Descricao) d FROM central.grupo').catch(() => [])) gr[+r.CodGrupo] = String(r.d || '').trim();
      for (const r of await q('SELECT CodSubGrupo, CodGrupo, TRIM(Descricao) d FROM central.gruposub').catch(() => [])) gs[+r.CodSubGrupo] = { sub: String(r.d || '').trim(), grupo: gr[+r.CodGrupo] || '' };
      for (const r of await q('SELECT CodigoBarra cod, TRIM(Descricao) d, CodGrupoSub g FROM central.itens WHERE CodDesativado = 0').catch(e => { console.error('[DASHBOARD] estoque cadastro', e.message); return []; })) {
        const g = gs[+r.g] || { sub: '', grupo: '' }; cad.set(String(r.cod).trim(), { descricao: String(r.d || '').trim(), grupo: g.grupo, subgrupo: g.sub });
      }
    }
    if (!cad.size) throw new Error('cadastro de itens vazio: estoque por loja não calculado');
    const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
    for (const ln of LOJAS_EST) {
      const est0 = await q(`SELECT CodigoBarra cod, Qtd est FROM central.estoquen${ln} WHERE CAST(REPLACE(Qtd, ',', '.') AS DECIMAL(14,3)) > 0`).catch(e => { console.error('[DASHBOARD] estoque', ln, e.message); return null; });
      if (!est0) { lojas[ln] = { erro: true, semVenda: true, itens: [] }; continue; }
      const rs = est0.map(r => { const cod = String(r.cod).trim(), c = cad.get(cod); return c ? { cod, est: r.est, custo: null, descricao: c.descricao, grupo: c.grupo, subgrupo: c.subgrupo } : null; }).filter(Boolean);   // só item ativo do cadastro
      const custo = new Map();
      for (const ch of chunk(rs.map(r => r.cod), 4000)) for (const r of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ch.map(() => '?').join(',')})`, ch).catch(e => { console.error('[DASHBOARD] custo', ln, e.message); return []; })) custo.set(String(r.cod).trim(), r.Custo);
      for (const r of rs) r.custo = custo.get(r.cod) ?? null;
      const ult = new Map(); let cupons = 0;
      if (ln !== 10) for (let k = 0; k < 5; k++) {   // mês atual e os 4 anteriores: cobre 120 dias ou mais
        const d = new Date(hoje.getFullYear(), hoje.getMonth() - k, 1), y = d.getFullYear(), m = pad(d.getMonth() + 1);
        const dIni = `${y}-${m}-01`, dFim = k === 0 ? dHoje : `${y}-${m}-${pad(new Date(y, d.getMonth() + 1, 0).getDate())}`;
        const cs = await q(`SELECT Codigo cod, DATE_FORMAT(MAX(Data),'%Y-%m-%d') d FROM \`ln${ln}mes${m}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [dIni, dFim])
          .catch(e => { console.error('[DASHBOARD] cupons', ln, m, e.message); return []; });
        cupons += cs.length;
        for (const c of cs) { const cod = String(c.cod).trim(); if (!ult.has(cod) || ult.get(cod) < c.d) ult.set(cod, c.d); }
      }
      const semVenda = !cupons;
      const itens = rs.map(r => { const cod = String(r.cod).trim(), descricao = String(r.descricao || '').trim(), grupo = String(r.grupo || '').trim(), subgrupo = String(r.subgrupo || '').trim(), est = num(r.est), custo = num(r.custo), uv = ult.get(cod) || null;
        const dias = uv ? Math.round((hoje - new Date(uv + 'T12:00:00')) / 864e5) : null;
        const consumo = CONSUMO_RE.test(grupo) || CONSUMO_RE.test(subgrupo) || INSUMO_DESC_RE.test(descricao);
        return { cod, descricao, grupo, subgrupo, consumo, est, custo, valor: r2(est * custo), ultVenda: uv, dias, faixa: semVenda || consumo ? null : faixaDe(dias) }; });
      lojas[ln] = { semVenda, itens };
    }
    parado = { calculadoEm: new Date().toISOString(), hoje: dHoje, janelaDe, janelaDias, ms: Date.now() - t0, lojas };
    try { fs.mkdirSync(path.dirname(PARADO_ARQ), { recursive: true }); fs.writeFileSync(PARADO_ARQ, JSON.stringify(parado)); } catch (e) { console.error('[DASHBOARD] gravar estoque', e.message); }
    console.log(`[DASHBOARD] estoque por loja em ${(parado.ms / 1000).toFixed(0)}s`);
    return parado;
  })().finally(() => { paradoCalc = null; });
  return paradoCalc;
}
// resumo pra tela: por loja e rede — itens com estoque, R$ a custo e parado por faixa (itens e R$)
function resumoParado() {
  if (!parado) { if (deps && !paradoCalc) calcularParado().catch(e => console.error('[DASHBOARD] estoque', e.message)); return { calculadoEm: null, calculando: true, faixas: FAIXAS, lojas: [], rede: null }; }
  const z = () => ({ n: 0, v: 0 }), soma = (a, i) => { a.n++; a.v += i.valor; }, fecha = o => { for (const k of ['f60', 'f90', 'f120', 'parado', 'consumo']) o[k].v = r2(o[k].v); o.valor = r2(o.valor); return o; };
  const lojas = [], rede = { loja: 0, itens: 0, valor: 0, f60: z(), f90: z(), f120: z(), parado: z(), consumo: z() };
  for (const ln of LOJAS_EST) {
    const L = parado.lojas[ln]; if (!L) continue;
    const r = { loja: ln, erro: !!L.erro, semVenda: !!L.semVenda, itens: L.itens.length, valor: 0, f60: z(), f90: z(), f120: z(), parado: z(), consumo: z() };
    for (const i of L.itens) { r.valor += i.valor; if (i.consumo) soma(r.consumo, i); else if (i.faixa) { soma(r['f' + i.faixa], i); soma(r.parado, i); } }
    lojas.push(fecha(r)); rede.itens += r.itens; rede.valor += r.valor; for (const k of ['f60', 'f90', 'f120', 'parado', 'consumo']) { rede[k].n += r[k].n; rede[k].v += r[k].v; }
  }
  return { calculadoEm: parado.calculadoEm, hoje: parado.hoje, calculando: !!paradoCalc, faixas: FAIXAS, lojas, rede: fecha(rede) };
}
// detalhe: produtos parados de uma loja numa faixa (60 = 60–89 d, 90 = 90–119 d, 120 = 120 ou mais, 0 = todas as faixas;
// 'consumo' = uso e consumo / insumos, que ficam fora do parado), maior valor primeiro
function paradosDetalhe({ loja = 0, faixa = 0, limite = 300 } = {}) {
  const L = parado && parado.lojas[loja]; if (!L) return { loja, faixa, calculadoEm: parado ? parado.calculadoEm : null, n: 0, total: 0, itens: [] };
  const sel = L.itens.filter(i => faixa === 'consumo' ? i.consumo : (i.faixa && (!faixa || i.faixa === faixa))).sort((a, b) => b.valor - a.valor || a.descricao.localeCompare(b.descricao, 'pt-BR'));
  const tot = pred => { const s = L.itens.filter(pred); return { n: s.length, v: r2(s.reduce((a, i) => a + i.valor, 0)) }; };
  return { loja, faixa, calculadoEm: parado.calculadoEm, hoje: parado.hoje, janelaDe: parado.janelaDe || null, janelaDias: parado.janelaDias || 120, semVenda: !!L.semVenda,
    resumo: { parado: tot(i => !!i.faixa), consumo: tot(i => i.consumo) }, n: sel.length, total: r2(sel.reduce((s, i) => s + i.valor, 0)), itens: sel.slice(0, limite) };
}

// ── 4 ESTOQUE ──────────────────────────────────────────────────────────────────────────────────────────────
async function estoque(hoje) {
  const q = deps.q, out = { parado: null, excesso: null, vencimentos: null, transferencias: null };
  try { out.parado = resumoParado(); } catch (e) { console.error('[DASHBOARD] parado', e.message); }
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
// 29/09/26 (Tiago): "operação dos checkouts" — venda por checkout de cada loja (número do PDV e a operadora que abriu
// o caixa), com HOJE à esquerda e o ACUMULADO DO MÊS à direita; embaixo, a movimentação do caixa de cada operadora
// (dinheiro, cartão, PIX, vale, cancelamentos por motivo, sangrias, troco solidário, descontos, quebra de caixa, NFC-e)
// no mesmo desenho hoje × mês. Fontes (só leitura), todas no .252:
//   vendas.relatoriofecl{loja} — uma linha por FINALIZADORA de cada cupom: Data, Hora, Valor ("1.050,00" com vírgula),
//     Tipo1/Tipo2 + Cartao (99/99 DINHEIRO · 01 TEF débito, PIX e vale · 02 crédito · 03 voucher · 04 POS · 91 TROCA),
//     TEF_TipoProduto, nECF (PDV), nMov (movimento = turno do caixa), Operador, CCF, IndCancel '1' = cupom cancelado,
//     NaoVenda 1 = operação sem venda (Tipo1 77 = SANGRIA, bate com vendas.conciliacaosangria; 98/66 = recebimento
//     de conta). A soma das finalizadoras fecha com ValorTotalNovo de zcupomitens (E3 28/09: R$ 42.806,03 · 987 cupons
//     nas duas). Índice (Data, nECF). TotalPago/TotalTroco vêm com ponto, Valor/Troco com vírgula.
//   vendas.zcupomitenscancelados — item cancelado com Motivo ("003 - Desistência", "004 - Erro Operador(a)", "001 -
//     Cartão não autorizado", "011 - Teste do equipamento"…), Gerente que autorizou, Operador, nMov. Índice (Data, nLoja, nECF).
//   vendas.quebradecaixa — diferença do fechamento de cada movimento (negativo = faltou dinheiro, positivo = sobrou).
//   vendas.trocosolidario — troco doado (arredondamento), por operadora e movimento.
//   vendas.zcupomitensdesconto — desconto dado no PDV (nPdv, Hora, GERENTE; sem operadora nem movimento) → casado com
//     o movimento do PDV naquele dia pelo horário.
//   central.fechamento_pdv, central.relatoriofec e supermercado.* estão vazios ou são só do teste — não servem.
const brl = v => { const s = String(v ?? '0').trim(); return num(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); };
const FORMAS = ['dinheiro', 'debito', 'credito', 'pix', 'vale', 'pos', 'troca', 'outros'];
const OP_IGNORAR = new Set(['', '0', 'AVULSO']);
const nomeOp = op => String(op || '').trim().toUpperCase().replace(/^d+s*-s*/, '');   // "370 - DANIELY" → DANIELY
const minutosH = h => { const [hh, mi] = String(h || '0:0').split(':').map(Number); return (hh || 0) * 60 + (mi || 0); };
// classe de uma linha do relatoriofec (finalizadora ou operação sem venda)
function classeFin(r) {
  if (+r.nv) return r.t1 === '77' ? 'sangria' : (r.t1 === '98' && r.t2 === '66') ? 'recebimento' : 'naoVenda';
  if (String(r.ic) === '1') return 'cupomCanc';
  const c = String(r.cart || '').toUpperCase(), tp = String(r.tp || '').toUpperCase();
  if ((r.t1 === '99' || r.t1 === '98') && (r.t2 === '99' || r.t2 === '98')) return 'dinheiro';
  if (c.includes('PIX') || tp === 'CARTEIRADIGITAL') return 'pix';
  if (r.t1 === '03' || tp.startsWith('VOUCHER') || /SODEXO|TICKET|ALELO|\bVR\b|VALE ?CARD|POLICARD|NUTRICASH|PLUXEE|GREEN ?CARD|BEN ?VISA|FLASH|CAJU|IFOOD|VOUCHER|ALIMENT|REFEI/.test(c)) return 'vale';
  if (r.t1 === '01') return 'debito';
  if (r.t1 === '02') return 'credito';
  if (r.t1 === '04') return 'pos';
  if (r.t1 === '91') return 'troca';
  return 'outros';   // convênio 90, cheque 88, entrega, troco solidário 00…
}
const NV_KEYS = ['cancel', 'cupomCanc', 'sangria', 'recebimento', 'trocoSol', 'desconto'];
function accNovo() {
  const a = { cupons: 0, venda: 0, motivos: {}, quebra: { n: 0, v: 0, falta: 0, sobra: 0 }, nfce: 0, h0: null, h1: null, dias: new Set(), movs: new Set() };
  for (const f of FORMAS) a[f] = 0; for (const k of NV_KEYS) a[k] = { n: 0, v: 0 }; return a;
}
const addNV = (a, b) => { a.n += b.n || 0; a.v += b.v || 0; };
function accSoma(a, b) {
  a.cupons += b.cupons; a.venda += b.venda; for (const f of FORMAS) a[f] += b[f];
  for (const k of NV_KEYS) addNV(a[k], b[k]);
  for (const [m, x] of Object.entries(b.motivos)) addNV(a.motivos[m] || (a.motivos[m] = { n: 0, v: 0 }), x);
  a.quebra.n += b.quebra.n; a.quebra.v += b.quebra.v; a.quebra.falta += b.quebra.falta; a.quebra.sobra += b.quebra.sobra; a.nfce += b.nfce;
  if (b.h0 && (!a.h0 || b.h0 < a.h0)) a.h0 = b.h0; if (b.h1 && (!a.h1 || b.h1 > a.h1)) a.h1 = b.h1;
  b.dias.forEach(d => a.dias.add(d)); b.movs.forEach(m => a.movs.add(m));
  return a;
}
function accPub(a) {
  const o = { cupons: a.cupons, venda: r2(a.venda), ticket: a.cupons ? r2(a.venda / a.cupons) : null, nfce: a.nfce, dias: a.dias.size, movs: a.movs.size, h0: a.h0 ? a.h0.slice(0, 5) : null, h1: a.h1 ? a.h1.slice(0, 5) : null };
  for (const f of FORMAS) o[f] = r2(a[f]);
  for (const k of NV_KEYS) o[k] = { n: a[k].n, v: r2(a[k].v) };
  o.quebra = { n: a.quebra.n, v: r2(a.quebra.v), falta: r2(a.quebra.falta), sobra: r2(a.quebra.sobra) };
  o.motivos = Object.entries(a.motivos).map(([nome, x]) => ({ nome, n: x.n, v: r2(x.v) })).sort((x, y) => y.n - x.n);
  return o;
}
async function operacao(hoje) {
  const q = deps.q, dHoje = iso(hoje), dIni = dHoje.slice(0, 8) + '01';
  const agora = hoje.getHours() * 60 + hoje.getMinutes();
  const aberta = agora >= 7 * 60 && agora <= 21 * 60 + 30, LIMITE_PARADO = 45;
  const VAL = "CAST(REPLACE(REPLACE(Valor,'.',''),',','.') AS DECIMAL(12,2))";
  const porLoja = async ln => {
    const t = `vendas.relatoriofecl${ln}`;
    const [fin, cab] = await Promise.all([
      q(`SELECT nECF pdv, nMov mov, Operador op, DATE_FORMAT(Data,'%Y-%m-%d') d, Tipo1 t1, Tipo2 t2, LEFT(Cartao,40) cart, TEF_TipoProduto tp, NaoVenda nv, IndCancel ic, COUNT(*) n, SUM(${VAL}) v
           FROM ${t} WHERE Data BETWEEN ? AND ? GROUP BY 1,2,3,4,5,6,7,8,9,10`, [dIni, dHoje]),
      q(`SELECT nECF pdv, nMov mov, Operador op, DATE_FORMAT(Data,'%Y-%m-%d') d,
                COUNT(DISTINCT CASE WHEN NaoVenda=0 AND IndCancel='0' THEN CCF END) cup,
                COUNT(DISTINCT CASE WHEN NaoVenda=0 AND IndCancel='1' THEN CCF END) cupCanc,
                COUNT(DISTINCT CASE WHEN NaoVenda=0 AND IndCancel='0' AND CodRet<>'100' THEN CCF END) nfce,
                MIN(Hora) h0, MAX(CASE WHEN NaoVenda=0 AND IndCancel='0' THEN Hora END) h1
           FROM ${t} WHERE Data BETWEEN ? AND ? GROUP BY 1,2,3,4`, [dIni, dHoje])]);
    return { ln, fin, cab };
  };
  const [lojasRs, canc, quebra, troco, desc] = await Promise.all([
    Promise.all(LOJAS.map(ln => porLoja(ln).catch(e => { console.error('[DASHBOARD] operacao loja', ln, e.message); return { ln, fin: [], cab: [], erro: e.message }; }))),
    q(`SELECT nLoja loja, nECF pdv, nMov mov, Operador op, DATE_FORMAT(Data,'%Y-%m-%d') d, Motivo motivo, COUNT(*) n, SUM(CAST(REPLACE(REPLACE(ValorTotal,'.',''),',','.') AS DECIMAL(12,2))) v
        FROM vendas.zcupomitenscancelados WHERE Data BETWEEN ? AND ? AND nLoja BETWEEN 1 AND 6 GROUP BY 1,2,3,4,5,6`, [dIni, dHoje]).catch(e => { console.error('[DASHBOARD] operacao cancelados', e.message); return []; }),
    q(`SELECT nLoja loja, nPDV pdv, Mov mov, DATE_FORMAT(Data,'%Y-%m-%d') d, CAST(Quebra AS DECIMAL(12,2)) v FROM vendas.quebradecaixa WHERE Data BETWEEN ? AND ? AND nLoja BETWEEN 1 AND 6`, [dIni, dHoje]).catch(e => { console.error('[DASHBOARD] operacao quebra', e.message); return []; }),
    q(`SELECT nLoja loja, nPdv pdv, nMov mov, DATE_FORMAT(Data,'%Y-%m-%d') d, COUNT(*) n, SUM(CAST(Valor AS DECIMAL(12,2))) v FROM vendas.trocosolidario WHERE Data BETWEEN ? AND ? AND nLoja BETWEEN 1 AND 6 GROUP BY 1,2,3,4`, [dIni, dHoje]).catch(e => { console.error('[DASHBOARD] operacao troco', e.message); return []; }),
    q(`SELECT nLoja loja, nPdv pdv, DATE_FORMAT(Data,'%Y-%m-%d') d, Hora h, DescontoUnd*Qtd v FROM vendas.zcupomitensdesconto WHERE Data BETWEEN ? AND ? AND nLoja BETWEEN 1 AND 6`, [dIni, dHoje]).catch(e => { console.error('[DASHBOARD] operacao descontos', e.message); return []; }),
  ]);
  const lojas = [];
  for (const { ln, fin, cab, erro } of lojasRs) {
    const movs = new Map();   // "pdv-mov" → { pdv, mov, ops: {nome: peso}, dia: {d: {h0,h1}}, hoje: acc, mes: acc }
    const mv = (pdv, mov, op) => {
      const k = pdv + '-' + mov; let m = movs.get(k);
      if (!m) { m = { pdv: +pdv, mov: +mov, ops: {}, dia: {}, hoje: accNovo(), mes: accNovo() }; movs.set(k, m); }
      const o = nomeOp(op); if (op != null && !OP_IGNORAR.has(o) && !(o in m.ops)) m.ops[o] = 0;
      return m;
    };
    const nos = (m, d) => d === dHoje ? [m.hoje, m.mes] : [m.mes];   // acumuladores que recebem a linha
    for (const r of cab) {
      const m = mv(r.pdv, r.mov, r.op), op = nomeOp(r.op);
      if (!OP_IGNORAR.has(op)) m.ops[op] += (+r.cup || 0) + 0.001;   // 0.001: operadora que só fez sangria/cancelamento também conta
      const w = m.dia[r.d] || (m.dia[r.d] = { h0: null, h1: null }); if (r.h0 && (!w.h0 || r.h0 < w.h0)) w.h0 = r.h0; if (r.h1 && (!w.h1 || r.h1 > w.h1)) w.h1 = r.h1;
      for (const a of nos(m, r.d)) { a.cupons += +r.cup || 0; a.cupomCanc.n += +r.cupCanc || 0; a.nfce += +r.nfce || 0; if (+r.cup) a.dias.add(r.d); a.movs.add(m.mov); if (r.h0 && (!a.h0 || r.h0 < a.h0)) a.h0 = r.h0; if (r.h1 && (!a.h1 || r.h1 > a.h1)) a.h1 = r.h1; }
    }
    for (const r of fin) {
      const m = mv(r.pdv, r.mov, r.op), c = classeFin(r), v = num(r.v), n = +r.n || 0;
      for (const a of nos(m, r.d)) {
        if (c === 'sangria' || c === 'recebimento') { a[c].n += n; a[c].v += v; }
        else if (c === 'naoVenda') continue;
        else if (c === 'cupomCanc') a.cupomCanc.v += v;
        else { a.venda += v; a[c] += v; }
      }
    }
    const extras = (rows, fn) => { for (const r of rows) if (+r.loja === ln) { const m = mv(r.pdv, r.mov, r.op); for (const a of nos(m, r.d)) fn(a, r); } };
    extras(canc, (a, r) => { const n = +r.n || 0, v = num(r.v), nome = String(r.motivo || '').replace(/^\d+\s*-\s*/, '').trim() || 'Sem motivo'; a.cancel.n += n; a.cancel.v += v; const x = a.motivos[nome] || (a.motivos[nome] = { n: 0, v: 0 }); x.n += n; x.v += v; });
    extras(quebra, (a, r) => { const v = num(r.v); a.quebra.n++; a.quebra.v += v; if (v < 0) a.quebra.falta += -v; else a.quebra.sobra += v; });
    extras(troco, (a, r) => { a.trocoSol.n += +r.n || 0; a.trocoSol.v += num(r.v); });
    // descontos: sem movimento nem operadora na tabela → movimento do mesmo PDV no dia cujo horário cobre a Hora (ou o mais perto)
    const porPdv = {}; for (const m of movs.values()) (porPdv[m.pdv] = porPdv[m.pdv] || []).push(m);
    for (const r of desc) {
      if (+r.loja !== ln) continue;
      const cand = (porPdv[+r.pdv] || []).filter(m => m.dia[r.d]); if (!cand.length) continue;
      const h = String(r.h || ''), hm = minutosH(h);
      const m = cand.find(x => x.dia[r.d].h0 && x.dia[r.d].h1 && h >= x.dia[r.d].h0 && h <= x.dia[r.d].h1)
        || cand.slice().sort((x, y) => { const dx = Math.min(Math.abs(hm - minutosH(x.dia[r.d].h0)), Math.abs(hm - minutosH(x.dia[r.d].h1 || x.dia[r.d].h0))), dy = Math.min(Math.abs(hm - minutosH(y.dia[r.d].h0)), Math.abs(hm - minutosH(y.dia[r.d].h1 || y.dia[r.d].h0))); return dx - dy; })[0];
      for (const a of nos(m, r.d)) { a.desconto.n++; a.desconto.v += num(r.v); }
    }
    const lista = [...movs.values()];
    for (const m of lista) { const ops = Object.entries(m.ops).sort((x, y) => y[1] - x[1]); m.operador = ops.length ? ops[0][0] : '—'; }
    // checkouts de hoje: um por movimento com qualquer atividade hoje (cupom, sangria, cancelamento)
    const hojeMovs = lista.filter(m => m.hoje.cupons || m.hoje.sangria.n || m.hoje.cancel.n || m.hoje.h0);
    const fechados = new Set(quebra.filter(r => +r.loja === ln && r.d === dHoje).map(r => r.pdv + '-' + r.mov));
    // loja sem sincronizar: a replicação loja → central (vendas.relatoriofecl*) às vezes para; aí TODOS os caixas ficam
    // "parados" no mesmo horário. Se o último cupom da loja tem mais de LIMITE min e ≥70% dos caixas pararam até 30 min
    // dele, o problema é a sincronização, não o caixa — a tela avisa em vez de marcar parado. (E4 29/09: tudo em 10:17–10:39)
    const ults = hojeMovs.map(m => minutosH(m.hoje.h1 || m.hoje.h0)).filter(x => x > 0), ultMax = ults.length ? Math.max(...ults) : 0;
    const semSync = aberta && ults.length >= 2 && agora - ultMax > LIMITE_PARADO && ults.filter(x => ultMax - x <= 30).length >= 0.7 * ults.length ? pad(Math.floor(ultMax / 60)) + ':' + pad(ultMax % 60) : null;
    // turno anterior do mesmo PDV (a operadora trocou / reabriu o caixa): já encerrou, não é "parado" — só o último turno
    // de cada PDV pode estar ativo ou parado
    const ultimoTurno = {}; for (const m of hojeMovs) { const h0 = m.hoje.h0 || ''; if (!ultimoTurno[m.pdv] || h0 > (ultimoTurno[m.pdv].hoje.h0 || '')) ultimoTurno[m.pdv] = m; }
    const checkoutsHoje = hojeMovs.map(m => {
      const a = accPub(m.hoje), min = agora - minutosH(m.hoje.h1 || m.hoje.h0), fechado = fechados.has(m.pdv + '-' + m.mov) || ultimoTurno[m.pdv] !== m;
      const status = fechado ? 'fechado' : !aberta ? 'fora' : min > LIMITE_PARADO ? (semSync ? 'sync' : 'parado') : 'ativo';
      return { pdv: m.pdv, mov: m.mov, operador: m.operador, abertura: a.h0, ultimo: a.h1, cupons: a.cupons, venda: a.venda, ticket: a.ticket, sangria: a.sangria, cancel: a.cancel, quebra: a.quebra, semCupomMin: min, fechado, parado: status === 'parado', status };
    }).sort((x, y) => x.pdv - y.pdv || ((x.abertura || '') < (y.abertura || '') ? -1 : 1));
    // checkouts no mês: um por PDV, somando os movimentos
    const porPdvMes = new Map();
    for (const m of lista) { const p = porPdvMes.get(m.pdv) || { pdv: m.pdv, acc: accNovo(), ops: {} }; accSoma(p.acc, m.mes); for (const [o, n] of Object.entries(m.ops)) p.ops[o] = (p.ops[o] || 0) + n; porPdvMes.set(m.pdv, p); }
    const checkoutsMes = [...porPdvMes.values()].map(p => { const a = accPub(p.acc); return { pdv: p.pdv, dias: a.dias, movs: a.movs, cupons: a.cupons, venda: a.venda, ticket: a.ticket, sangria: a.sangria, cancel: a.cancel, quebra: a.quebra, operadoras: Object.entries(p.ops).sort((x, y) => y[1] - x[1]).map(x => x[0]) }; }).sort((x, y) => x.pdv - y.pdv);
    // operadoras: hoje (só quem abriu caixa hoje) × mês
    const porOp = new Map();
    for (const m of lista) {
      const o = porOp.get(m.operador) || { nome: m.operador, hoje: accNovo(), mes: accNovo(), pdvsHoje: new Set(), pdvs: new Set() };
      accSoma(o.mes, m.mes); o.pdvs.add(m.pdv); if (hojeMovs.includes(m)) { accSoma(o.hoje, m.hoje); o.pdvsHoje.add(m.pdv); } porOp.set(m.operador, o);
    }
    const operadoras = [...porOp.values()].map(o => ({ nome: o.nome, pdvsHoje: [...o.pdvsHoje].sort((a, b) => a - b), pdvs: [...o.pdvs].sort((a, b) => a - b), hoje: o.pdvsHoje.size ? accPub(o.hoje) : null, mes: accPub(o.mes) }))
      .sort((x, y) => ((y.hoje ? 1 : 0) - (x.hoje ? 1 : 0)) || ((y.hoje ? y.hoje.venda : y.mes.venda) - (x.hoje ? x.hoje.venda : x.mes.venda)));
    const tH = accNovo(), tM = accNovo(); hojeMovs.forEach(m => accSoma(tH, m.hoje)); lista.forEach(m => accSoma(tM, m.mes));
    lojas.push({ loja: ln, nome: NOMES[ln], erro: erro || null,
      hoje: { ...accPub(tH), semSync, caixas: Object.keys(ultimoTurno).length, turnos: hojeMovs.length, ativos: checkoutsHoje.filter(c => c.status === 'ativo').length, parados: checkoutsHoje.filter(c => c.parado).length, fechados: checkoutsHoje.filter(c => c.fechado).length, checkouts: checkoutsHoje },
      mes: { ...accPub(tM), checkouts: checkoutsMes }, operadoras });
  }
  return { hora: `${pad(hoje.getHours())}:${pad(hoje.getMinutes())}`, hoje: dHoje, mesIni: dIni, lojaAberta: aberta, limiteParadoMin: LIMITE_PARADO, lojas };
}

// ── 6 FINANCEIRO ───────────────────────────────────────────────────────────────────────────────────────────
// 25/09/26: a versão anterior fazia LEFT JOIN de contasapagar com uma subquery derivada (SUM das baixas por nReg),
// duas vezes. No MySQL 5.0 do .252 a tabela derivada não ganha índice e as duas tabelas só têm PRIMARY (nReg / nInd),
// então o plano era 41.899 títulos do ano × 145.050 linhas da derivada = minutos, a cada abertura da tela e a cada
// recálculo de 5 min. Agora são consultas planas (~1 s cada) e o "Valor − baixas" (mesma fórmula da tela Contas A
// Pagar do ERP, validada ao centavo) é feito aqui em memória.
// 25/09/26 (Tiago): a tela mostra pelo DIA EM QUE A LOJA PAGA, não pelo vencimento: boleto que vence sábado, domingo
// ou segunda é pago na segunda; de terça a sexta é pago no próprio dia. Cada linha sai com venc (vencimento) e pag
// (dia de pagamento); a tela monta hoje / esta semana / semanas seguintes a partir das linhas. Só leitura.
const addDias = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return iso(x); };
const diaSem = d => new Date(d + 'T12:00:00').getDay();                        // 0 dom … 6 sáb
const diaPagto = venc => { const w = diaSem(venc); return w === 6 ? addDias(venc, 2) : w === 0 ? addDias(venc, 1) : venc; };
// segunda-feira da semana de pagamento em foco: seg–sex = a própria semana; sáb/dom = a que começa na próxima segunda
const semanaIni = d => { const w = diaSem(d); return w === 0 ? addDias(d, 1) : w === 6 ? addDias(d, 2) : addDias(d, 1 - w); };
// Títulos individuais em aberto (todos, inclusive vencidos) ficam na memória a cada cálculo do bloco, pra a tela abrir o
// detalhe de uma loja num dia de pagamento (Tiago, 28/09/26: "clicar na linha da loja abre os fornecedores: data,
// fornecedor, documento e valor"). O nome do fornecedor só é buscado na hora do clique, por nReg (PRIMARY), e fica
// guardado pros cliques seguintes. Só leitura.
let finTitulos = null; const finNomes = new Map();
// Nome do fornecedor + NF-e de cada título, por nReg (PRIMARY), guardado em finNomes pros cliques seguintes.
// 29/09/26 (Tiago: "quando eu clicar no fornecedor abrir o pdf da nota"): o título aponta pra nota lançada por
// contasapagar.nPar2 = central.compras.nCompra NA MESMA LOJA (nCompra repete entre lojas). Título manual (aluguel,
// internet, serviço) também tem nPar2 pequeno que bate por acaso com uma compra qualquer, então só vale se o nº da
// nota e o fornecedor conferem; aí a chave (44 dígitos) abre a DANFE gerada do XML (central.axml). Medido em 29/09:
// 5.841 dos 6.855 títulos set–dez/26 têm nota assim, e 100% delas estão no axml. Só leitura.
const nDocNorm = s => String(s || '').trim().replace(/^0+(?=\d)/, '');
async function infoTitulos(nRegs) {
  for (let i = 0; i < nRegs.length; i += 200) {
    const lote = nRegs.slice(i, i + 200);
    const rs = await deps.q('SELECT c.nReg, c.nPar2, c.Filial, c.nDoc, c.CodFornec, f.Nome fornecedor, c.Historico hist FROM loja20045.contasapagar c LEFT JOIN central.fornecedor f ON f.CodFornec = c.CodFornec WHERE c.nReg IN (' + lote.map(() => '?').join(',') + ')', lote)
      .catch(e => { console.error('[DASHBOARD] nomes', e.message); return []; });
    const pars = [...new Set(rs.map(r => +r.nPar2 || 0).filter(n => n > 0))], compras = {};
    if (pars.length) {
      const cs = await deps.q('SELECT nCompra, nLoja, nNota, CodFornec, chave FROM central.compras WHERE nCompra IN (' + pars.map(() => '?').join(',') + ')', pars)   // índice idx_central_compras (nCompra, nNota, nLoja)
        .catch(e => { console.error('[DASHBOARD] notas', e.message); return []; });
      for (const c of cs) compras[+c.nCompra + '|' + +c.nLoja] = c;
    }
    for (const r of rs) {
      const c = compras[(+r.nPar2 || 0) + '|' + +r.Filial], chave = String((c && c.chave) || '').trim();
      const ok = !!c && nDocNorm(c.nNota) === nDocNorm(r.nDoc) && +c.CodFornec === +r.CodFornec && /^\d{44}$/.test(chave);
      finNomes.set(+r.nReg, { fornecedor: String(r.fornecedor || '').trim(), hist: String(r.hist || '').trim(), chave: ok ? chave : null, nota: ok ? String(c.nNota).trim() : null });
    }
    for (const n of lote) if (!finNomes.has(n)) finNomes.set(n, { fornecedor: '', hist: '', chave: null, nota: null });
  }
}
// pagIni/pagFim (Tiago, 28/09): títulos de um PERÍODO de pagamento (ex.: a semana toda) — usado pelo clique na loja em "Esta semana"
async function titulosFinanceiro({ loja = 0, pag = '', venc = '', pagIni = '', pagFim = '', ord = '' } = {}) {
  if (!finTitulos) await financeiro(new Date());
  const sel = (finTitulos || []).filter(t => (!loja || t.loja === loja) && (!pag || t.pag === pag) && (!venc || t.venc === venc) && (!pagIni || (t.pag >= pagIni && t.pag <= (pagFim || pagIni))));
  await infoTitulos([...new Set(sel.filter(t => !finNomes.has(t.nReg)).map(t => t.nReg))]);
  // Ordem: lista de UM dia = maior valor primeiro; lista de um PERÍODO (vencidos, semana toda, próxima em diante) = por data de
  // VENCIMENTO e, dentro da data, maior valor primeiro (Tiago, 29/09/26, duas vezes: "aqui deixa em ordem de data e por valor" —
  // a segunda olhando a segunda-feira, que junta sáb + dom + seg: ordenar só pelo dia de pagamento misturava os vencimentos).
  // Como o dia de pagamento nunca diminui quando o vencimento cresce, ordenar por vencimento já deixa os dias de pagamento em ordem.
  const porDia = ord === 'venc' || ord === 'data' || (!pag && !venc && !!pagIni);
  const titulos = sel.map(t => { const nm = finNomes.get(t.nReg) || {}; return { ...t, fornecedor: nm.fornecedor || nm.hist || '', chave: nm.chave || null, nota: nm.nota || null }; }).sort(porDia ? (a, b) => a.venc.localeCompare(b.venc) || b.valor - a.valor : (a, b) => b.valor - a.valor || a.venc.localeCompare(b.venc));
  return { loja, pag, venc, pagIni, pagFim, n: titulos.length, total: r2(titulos.reduce((s, t) => s + t.valor, 0)), titulos };
}
async function financeiro(hoje) {
  const q = deps.q, dHoje = iso(hoje), ini = `${hoje.getFullYear()}-01-01`, limite = addDias(dHoje, 365);
  const semIni = semanaIni(dHoje), semFim = addDias(semIni, 4), proxIni = addDias(semIni, 7), proxFim = addDias(semIni, 11);
  // 1) títulos do ano em diante (vencidos + tudo que está por vir), sem join
  const titulos = await q(`SELECT nReg, Filial loja, DATE_FORMAT(DataVencto,'%Y-%m-%d') d, Valor, nDoc doc, PlanoGrupo grp
                           FROM loja20045.contasapagar WHERE DataVencto >= ?`, [ini]).catch(e => { console.error('[DASHBOARD] a pagar', e.message); return []; });
  // nomes dos grupos do plano de contas (Tiago, 29/09: separar boleto de fornecedor das outras operações, com nome)
  if (!finGrupos || Date.now() - finGruposEm > 6 * 3600 * 1000) {
    const gs = await q('SELECT PlanoGrupo g, Descricao nome FROM loja20045.planodecontas WHERE PlanoSub = 0').catch(() => []);
    if (gs.length) { finGrupos = {}; for (const g of gs) finGrupos[+g.g] = String(g.nome || '').trim(); finGruposEm = Date.now(); }
    else if (!finGrupos) finGrupos = {};
  }
  // 2) baixas desses títulos (só a faixa de nReg que interessa), agrupadas no banco
  let minReg = Infinity; for (const t of titulos) { const n = +t.nReg; if (t.d <= limite && n < minReg) minReg = n; }   // ignora os de data absurda (nReg antigo)
  const pago = new Map();
  if (titulos.length) {
    const bx = await q(`SELECT nReg, SUM(Valor) pago FROM loja20045.contasapagarbaixaconta WHERE nReg >= ? GROUP BY nReg`, [minReg]).catch(e => { console.error('[DASHBOARD] baixas', e.message); return []; });
    for (const b of bx) pago.set(+b.nReg, num(b.pago));
  }
  // 3) casamento: em aberto = Valor − baixas; só o que ainda deve (> 0,01), agrupado por loja × vencimento
  const linhasMap = {}, catsMap = {}, candidatos = [], todos = [], alem = { n: 0, v: 0 }, vencidos = { n: 0, v: 0 }, pagarHoje = { n: 0, v: 0 }, semana = { n: 0, v: 0 }, proxima = { n: 0, v: 0 };
  for (const t of titulos) {
    const v = num(t.Valor) - (pago.get(+t.nReg) || 0); if (v <= 0.01) continue;
    const ln = +t.loja, venc = t.d;
    if (venc > limite) { alem.n++; alem.v += v; continue; }          // data provavelmente errada no ERP (ex.: ano 4202)
    const pag = diaPagto(venc), key = ln + '|' + venc;
    const li = linhasMap[key] || (linhasMap[key] = { loja: ln, venc, pag, n: 0, v: 0 }); li.n++; li.v += v;
    const grp = +t.grp || 0, ck = grp + '|' + key;
    const ci = catsMap[ck] || (catsMap[ck] = { grupo: grp, loja: ln, venc, pag, n: 0, v: 0 }); ci.n++; ci.v += v;
    todos.push({ nReg: +t.nReg, loja: ln, doc: t.doc, venc, pag, valor: r2(v) });
    if (pag < dHoje) { vencidos.n++; vencidos.v += v; }
    else {
      if (pag === dHoje) { pagarHoje.n++; pagarHoje.v += v; }
      if (pag <= semFim) { semana.n++; semana.v += v; } else if (pag <= proxFim) { proxima.n++; proxima.v += v; }
      if (pag <= proxFim) candidatos.push({ nReg: +t.nReg, loja: ln, doc: t.doc, venc, pag, valor: r2(v) });
    }
  }
  // 4) nome do fornecedor só pros 40 maiores de hoje até o fim da próxima semana (busca por PRIMARY)
  candidatos.sort((a, b) => b.valor - a.valor); const top = candidatos.slice(0, 40);
  await infoTitulos(top.map(t => t.nReg).filter(n => !finNomes.has(n)));
  finTitulos = todos;
  const tot = o => ({ n: o.n, v: r2(o.v) });
  return { hoje: dHoje, semIni, semFim, proxIni, proxFim, regra: 'sáb, dom e seg pagam na segunda · ter a sex pagam no próprio dia',
    vencidos: tot(vencidos), pagarHoje: tot(pagarHoje), semana: tot(semana), proxima: tot(proxima), alem: tot(alem),
    linhas: Object.values(linhasMap).map(l => ({ ...l, v: r2(l.v) })).sort((a, b) => a.loja - b.loja || (a.venc < b.venc ? -1 : a.venc > b.venc ? 1 : 0)),
    // por grupo do plano de contas × loja × vencimento (grupo 4 = FORNECEDOR = boleto de nota; os outros são folha, impostos, energia…)
    categorias: Object.values(catsMap).map(l => ({ ...l, v: r2(l.v) })),
    grupos: finGrupos || {},
    maiores: top.map(m => { const nm = finNomes.get(m.nReg) || {}; return { loja: m.loja, fornecedor: nm.fornecedor || nm.hist || '', doc: m.doc, venc: m.venc, pag: m.pag, valor: m.valor, chave: nm.chave || null, nota: nm.nota || null }; }), saldo: null };
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
function agendar() { if (cache && cache.demo) return; setTimeout(() => calcular().catch(e => console.error('[DASHBOARD]', e.message)), 20 * 1000);
  // estoque por loja / parado: 1× por dia — ao subir (se o de disco não é de hoje) e às 06:10
  setTimeout(() => { if (!parado || parado.hoje !== iso(new Date())) calcularParado().catch(e => console.error('[DASHBOARD] estoque', e.message)); }, 90 * 1000);
  setInterval(() => { const d = new Date(); if (d.getHours() === 6 && d.getMinutes() === 10) calcularParado().catch(e => console.error('[DASHBOARD] estoque', e.message)); }, 60 * 1000);
}

module.exports = { init, agendar, calcular, dados, segmento, resumo, getMetas, setMetas, compradores, titulosFinanceiro, operacao, calcularParado, paradosDetalhe, NOMES };
