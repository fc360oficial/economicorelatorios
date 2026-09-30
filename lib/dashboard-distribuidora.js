// Dashboard Distribuidora (30/09/2026, pedido do Tiago: "dashboard loja e cria outro dashboard distribuidora").
// A CAHU Distribuidora é a loja 10 do ERP (CD). Ela não vende por cupom: vende por NF-e pro cliente (mercadinhos,
// padarias…), a partir do pedido do televendas. Seis blocos, cada um calculado no servidor quando a tela pede,
// com cache de 5 min (mesmo desenho de lib/dashboard.js):
//   1 Faturamento  — NF-e de venda (central.compras, nLoja 10, VENDA/NF/F): hoje × mesmo dia da semana passada,
//                    mês até hoje × mês anterior (mesmo período e completo), margem/markup pelo custo dos itens
//                    da nota (compraprodutos.Custo × Qtd), ticket por nota, por vendedor, forma de pagamento, mês a mês
//   2 Clientes     — quem comprou no mês (cadastro = central.fornecedor com Cliente = 1), novos (1ª compra no mês),
//                    quem sumiu (comprava e está há 30+ dias sem pedir), maiores do mês com curva ABC, por cidade e
//                    por vendedor (carteira). Histórico = central.delivery (pedidos do televendas)
//   3 Televendas   — pedidos (central.delivery): abertos sem NF-e e há quanto tempo, por vendedor, forma de pagamento,
//                    hora do dia, cancelados, produtos mais vendidos (delivery_produtos)
//   4 Estoque      — estoque do CD (estoquen10 × custoloja10), itens da Tabela Retirada (s_tabela_item, cod 1) sem
//                    estoque, cobertura baixa pelo giro dos pedidos, parados 60/90/120 dias, lotes vencendo
//                    (itenscoletorvalidade, loja 10), por grupo
//   5 Expedição    — painel do CD (central.painel_televendas: separação → liberado), tempo entrada → liberação,
//                    pendências de dias anteriores, liberados por dia, entradas em conferência (central.conferencia)
//   6 Financeiro   — boletos a receber (central.registrarboletos, loja 10): vencidos por idade e por cliente, hoje,
//                    esta semana, próximas; e o que o CD paga (contas a pagar Filial 10, via lib/dashboard.js)
// Status dos pedidos (delivery.Status): 0 novo · 1 em andamento · 2/3 faturado (NFe preenchida) · 9 cancelado.
// Status do boleto (registrarboletos.StatusBoleto): 0/1 em aberto · 2 liquidado · 3 cancelado. A liquidação chega pelo
// retorno bancário e atrasa (em 30/09 o último liquidado vencia em 17/09): "vencido" aqui = em aberto no ERP.
// SOMENTE LEITURA no ERP. Não grava nada em disco. ?demo=1 devolve dados de exemplo (TESTE) pra ver o layout.
'use strict';

const LOJA = 10;
const TTL_MS = 5 * 60 * 1000;
const num = v => { const n = parseFloat(String(v ?? '0').replace(/\./g, m => m).replace(',', '.')); return isFinite(n) ? n : 0; };
const numBR = v => { const s = String(v ?? '0').trim(); return num(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); };   // "2.998,80" e "19,08" e "2998.80"
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// texto de uma coluna: DATE_FORMAT em cima de MAX/MIN volta como Buffer no mysql2 (e como {type:'Buffer'} depois de JSON)
const S = v => v == null ? null : Buffer.isBuffer(v) ? v.toString() : (typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) ? Buffer.from(v.data).toString() : v instanceof Date ? (isNaN(v) ? null : iso(v)) : String(v);
const isoV = v => { const s = S(v); return s ? s.slice(0, 10) : null; };
const pct = (a, b) => b > 0 ? r1(a / b * 100) : null;
const addDias = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return iso(x); };
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
const semanaIni = d => { const x = new Date(d + 'T12:00:00'); const dow = x.getDay(); x.setDate(x.getDate() - ((dow + 6) % 7)); return iso(x); };   // segunda
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const forma = s => { const u = String(s || '').toUpperCase(); return /BOLETO/.test(u) ? 'Boleto' : /PIX/.test(u) ? 'PIX' : /CART/.test(u) ? 'Cartão' : /DINHEIRO/.test(u) ? 'Dinheiro' : u ? 'Outros' : 'Não informada'; };
const faturado = p => String(p.nfe || '0') !== '0' && +p.st !== 9;

let deps = null, segCache = {}, segCalc = {}, baseCache = null, baseCalc = null, finBoletos = null;
function init(d) { deps = d; }
async function safe(nome, fn, padrao) { try { return await fn(); } catch (e) { console.error('[DASH-DIST]', nome, e.message); return padrao; } }
const fresco = c => !!c && Date.now() - new Date(c.atualizadoEm).getTime() < TTL_MS;

// ── base compartilhada: notas de venda + custo por nota + pedidos + vendedores dos últimos 2 meses ─────────────────
async function base(hoje) {
  if (fresco(baseCache) && baseCache.hoje === iso(hoje)) return baseCache;
  if (baseCalc) return baseCalc;
  baseCalc = (async () => {
    const q = deps.q, dHoje = iso(hoje), ini = iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1));
    const vend = {};
    for (const v of await q('SELECT nReg cod, NomeVendedor nome FROM central.vendedor_delivery').catch(() => [])) vend[+v.cod] = String(v.nome || '').trim();
    const pedidos = (await q(`SELECT nPedido ped, DATE_FORMAT(Data,'%Y-%m-%d') d, Hora hora, CodCliente cli, Nome nome, CPF cnpj, Total v, Status st, CodVendedor vend, FormaPagto fp, NFe nfe
                              FROM central.delivery WHERE nLoja = ? AND Data BETWEEN ? AND ?`, [LOJA, ini, dHoje]).catch(e => { console.error('[DASH-DIST] pedidos', e.message); return []; }))
      .map(p => ({ ped: +p.ped, d: isoV(p.d), hora: String(p.hora || '').slice(0, 8), cli: +p.cli || 0, nome: String(p.nome || '').trim(), cnpj: String(p.cnpj || '').trim(), v: r2(num(p.v)), st: +p.st, vend: +p.vend || 0, vendNome: vend[+p.vend] || 'Sem vendedor', forma: forma(p.fp), nfe: String(p.nfe || '0').trim() }));
    const porPed = new Map(pedidos.map(p => [p.ped, p]));
    const notas = (await q(`SELECT nCompra nc, nNota nn, DATE_FORMAT(DataLan,'%Y-%m-%d') d, CodFornec cli, NomeFornec nome, CNPJ cnpj, TotalNota v, NumeroPedido ped, Status st, chave
                            FROM central.compras WHERE nLoja = ? AND Movimentacao = 'VENDA' AND Tipo = 'NF' AND Status IN ('F','C') AND DataLan BETWEEN ? AND ?`, [LOJA, ini, dHoje]).catch(e => { console.error('[DASH-DIST] notas', e.message); return []; }))
      .map(n => { const p = porPed.get(+n.ped); return { nc: +n.nc, nn: String(n.nn || ''), d: isoV(n.d), cli: +n.cli || 0, nome: String(n.nome || '').trim(), cnpj: String(n.cnpj || '').trim(), v: r2(num(n.v)), ped: +n.ped || 0, st: String(n.st), chave: String(n.chave || '').trim() || null, custo: null, vend: p ? p.vend : 0, vendNome: p ? p.vendNome : 'Sem vendedor', hora: p ? p.hora : '', forma: p ? p.forma : 'Não informada' }; });
    // custo da venda por nota = Custo × Qtd dos itens (compraprodutos). Mesmo JOIN que o Dashboard Loja usa pro CD (rápido: índice em nCompra)
    const custos = new Map();
    for (const c of await q(`SELECT p.nCompra nc, SUM(CAST(REPLACE(p.Custo,',','.') AS DECIMAL(14,4)) * CAST(REPLACE(p.Qtd,',','.') AS DECIMAL(14,3))) c
                             FROM central.compraprodutos p JOIN central.compras c ON c.nCompra = p.nCompra AND c.nLoja = p.nLoja
                             WHERE p.nLoja = ? AND c.Movimentacao = 'VENDA' AND c.Tipo = 'NF' AND c.Status = 'F' AND c.DataLan BETWEEN ? AND ? AND p.Cancelado = 0 GROUP BY p.nCompra`, [LOJA, ini, dHoje]).catch(e => { console.error('[DASH-DIST] custos', e.message); return []; })) custos.set(+c.nc, num(c.c));
    for (const n of notas) n.custo = custos.has(n.nc) ? r2(custos.get(n.nc)) : null;
    baseCache = { atualizadoEm: new Date().toISOString(), hoje: dHoje, ini, notas, pedidos, vend };
    return baseCache;
  })().finally(() => { baseCalc = null; });
  return baseCalc;
}
// só ~1 em 5 NF-e de venda do CD tem o XML importado em central.axml (é de lá que sai o PDF): o link só aparece quando existe
async function xmlExiste(chaves) {
  const cs = [...new Set(chaves.filter(Boolean))], tem = new Set();
  for (const ch of chunk(cs, 200)) for (const r of await deps.q(`SELECT Chave FROM central.axml WHERE Chave IN (${ch.map(() => '?').join(',')})`, ch).catch(() => [])) tem.add(String(r.Chave).trim());
  return tem;
}
const soma = (arr, f = x => x.v) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const agg = notas => { const v = soma(notas), c = soma(notas, n => n.custo), comC = notas.filter(n => n.custo != null); const vc = soma(comC); return { n: notas.length, v: r2(v), custo: r2(c), margem: pct(vc - c, vc), markup: pct(vc - c, c), ticket: notas.length ? r2(v / notas.length) : 0, clientes: new Set(notas.map(n => n.cli)).size }; };

// ── 1 FATURAMENTO ──────────────────────────────────────────────────────────────────────────────────────────
async function faturamento(hoje) {
  const q = deps.q, B = await base(hoje), dHoje = B.hoje, ano = hoje.getFullYear(), mes = hoje.getMonth() + 1, dia = hoje.getDate();
  const ultimoDia = new Date(ano, mes, 0).getDate(), dIni = `${ano}-${pad(mes)}-01`;
  const antD = new Date(ano, mes - 2, 1), anoA = antD.getFullYear(), mesA = antD.getMonth() + 1, ultA = new Date(anoA, mesA, 0).getDate();
  const dIniA = `${anoA}-${pad(mesA)}-01`, dFimA = `${anoA}-${pad(mesA)}-${pad(ultA)}`, dMesmoA = `${anoA}-${pad(mesA)}-${pad(Math.min(dia, ultA))}`;
  const semAnt = addDias(dHoje, -7), ontem = addDias(dHoje, -1);
  const F = B.notas.filter(n => n.st === 'F'), mesN = F.filter(n => n.d >= dIni), antN = F.filter(n => n.d >= dIniA && n.d <= dFimA), antMesmo = antN.filter(n => n.d <= dMesmoA);
  // hoje × mesmo dia da semana passada: a NF-e não guarda a hora de emissão, então o dia da semana passada é cortado na hora
  // atual pela hora do PEDIDO do televendas que virou cada nota (mesma ideia do "até a hora do último cupom" do Dashboard Loja)
  const hojeN = mesN.filter(n => n.d === dHoje), hCorte = hoje.toTimeString().slice(0, 8);
  const semAntN = F.filter(n => n.d === semAnt && (!hCorte || !n.hora || n.hora <= hCorte)), ontemN = F.filter(n => n.d === ontem);
  const cancel = B.notas.filter(n => n.st === 'C' && n.d >= dIni);
  const meses = (await q(`SELECT DATE_FORMAT(DataLan,'%Y-%m') m, COUNT(*) n, COALESCE(SUM(TotalNota),0) v FROM central.compras
                          WHERE nLoja = ? AND Movimentacao = 'VENDA' AND Tipo = 'NF' AND Status = 'F' AND DataLan >= ? GROUP BY DATE_FORMAT(DataLan,'%Y-%m') ORDER BY 1`, [LOJA, iso(new Date(ano, mes - 13, 1))]).catch(() => []))
    .map(r => ({ m: S(r.m), n: +r.n, v: r2(num(r.v)) }));
  const porVend = {};
  for (const n of mesN) { const a = porVend[n.vend] || (porVend[n.vend] = { cod: n.vend, nome: n.vendNome, mes: [], hoje: [], ant: [] }); a.mes.push(n); if (n.d === dHoje) a.hoje.push(n); }
  for (const n of antMesmo) { const a = porVend[n.vend] || (porVend[n.vend] = { cod: n.vend, nome: n.vendNome, mes: [], hoje: [], ant: [] }); a.ant.push(n); }
  const totMes = agg(mesN);
  const vendedores = Object.values(porVend).map(a => { const m = agg(a.mes), h = agg(a.hoje), an = agg(a.ant); return { cod: a.cod, nome: a.nome, hoje: h, mes: m, mesAnt: an, pct: pct(m.v, totMes.v), var: an.v > 0 ? r1((m.v / an.v - 1) * 100) : null }; }).sort((a, b) => b.mes.v - a.mes.v);
  const formas = {}; for (const n of mesN) { const f = formas[n.forma] || (formas[n.forma] = { nome: n.forma, n: 0, v: 0 }); f.n++; f.v += n.v; }
  const xml = await xmlExiste(hojeN.map(n => n.chave));
  const notasHoje = hojeN.map(n => ({ nn: n.nn, hora: n.hora, cliente: n.nome, cli: n.cli, vend: n.vendNome, forma: n.forma, v: n.v, custo: n.custo, margem: n.custo != null && n.v > 0 ? pct(n.v - n.custo, n.v) : null, chave: xml.has(n.chave) ? n.chave : null, ped: n.ped })).sort((a, b) => b.v - a.v);
  const H = agg(hojeN), SA = agg(semAntN), A = agg(antMesmo), AC = agg(antN);
  return { mes, ano, dia, ultimoDia, de: dIni, ate: dHoje, mesAnt: { mes: mesA, ano: anoA, ate: dMesmoA, ultimoDia: ultA },
    hoje: { ...H, corte: hCorte ? hCorte.slice(0, 5) : null, semAnt: { data: semAnt, ...SA }, var: SA.v > 0 ? r1((H.v / SA.v - 1) * 100) : null, ontem: agg(ontemN) },
    mesAtual: { ...totMes, projecao: dia > 0 ? r2(totMes.v / dia * ultimoDia) : 0, diaMedio: dia > 0 ? r2(totMes.v / dia) : 0, canceladas: { n: cancel.length, v: r2(soma(cancel)) } },
    mesAnterior: { mesmoPeriodo: A, completo: AC },
    var: A.v > 0 ? r1((totMes.v / A.v - 1) * 100) : null, varCompleto: AC.v > 0 ? r1((totMes.projecao || 0) / AC.v * 100 - 100) : null,
    vendedores, formas: Object.values(formas).map(f => ({ ...f, v: r2(f.v), pct: pct(f.v, totMes.v) })).sort((a, b) => b.v - a.v), meses, notasHoje };
}

// ── 2 CLIENTES ─────────────────────────────────────────────────────────────────────────────────────────────
async function clientes(hoje) {
  const q = deps.q, B = await base(hoje), dHoje = B.hoje, dIni = dHoje.slice(0, 8) + '01', d30 = addDias(dHoje, -30), d90 = addDias(dHoje, -90), d120 = addDias(dHoje, -120), d365 = addDias(dHoje, -365);
  const antD = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1), dIniA = iso(antD), dFimA = iso(new Date(hoje.getFullYear(), hoje.getMonth(), 0));
  // histórico de pedidos faturados (1 ano) e primeira compra de cada cliente (desde sempre)
  const hist = (await q(`SELECT nPedido ped, DATE_FORMAT(Data,'%Y-%m-%d') d, CodCliente cli, Nome nome, Total v, CodVendedor vend FROM central.delivery
                         WHERE nLoja = ? AND Status <> 9 AND NFe <> '0' AND Data BETWEEN ? AND ?`, [LOJA, d365, dHoje]).catch(e => { console.error('[DASH-DIST] hist', e.message); return []; }))
    .map(p => ({ ped: +p.ped, d: isoV(p.d), cli: +p.cli || 0, nome: String(p.nome || '').trim(), v: r2(num(p.v)), vend: +p.vend || 0 }));
  const primeira = new Map();
  for (const r of await q(`SELECT CodCliente cli, DATE_FORMAT(MIN(Data),'%Y-%m-%d') d FROM central.delivery WHERE nLoja = ? AND Status <> 9 AND NFe <> '0' GROUP BY CodCliente`, [LOJA]).catch(() => [])) primeira.set(+r.cli, isoV(r.d));
  const porCli = new Map();
  for (const p of hist) { const c = porCli.get(p.cli) || { cli: p.cli, nome: p.nome, ult: '', n: 0, v: 0, n30: 0, v30: 0, n90: 0, v90: 0, nMes: 0, vMes: 0, nAnt: 0, vAnt: 0, vend: {} }; porCli.set(p.cli, c);
    if (p.d > c.ult) { c.ult = p.d; c.nome = p.nome; } c.n++; c.v += p.v; c.vend[p.vend] = (c.vend[p.vend] || 0) + p.v;
    if (p.d > d30) { c.n30++; c.v30 += p.v; } if (p.d > d90) { c.n90++; c.v90 += p.v; }
    if (p.d >= dIni) { c.nMes++; c.vMes += p.v; } if (p.d >= dIniA && p.d <= dFimA) { c.nAnt++; c.vAnt += p.v; } }
  const cods = [...porCli.keys()].filter(Boolean), cad = new Map();
  for (const ch of chunk(cods, 500)) for (const r of await q(`SELECT CodFornec cod, Nome nome, Cidade cidade, Bairro bairro, Cod_ClienteVendedor vend, limite_compra lim FROM central.fornecedor WHERE CodFornec IN (${ch.map(() => '?').join(',')})`, ch).catch(() => [])) cad.set(+r.cod, { nome: String(r.nome || '').trim(), cidade: String(r.cidade || '').trim().replace(/^\.$/, ''), bairro: String(r.bairro || '').trim(), vend: +r.vend || 0, limite: num(r.lim) });
  const [cc] = await q('SELECT COUNT(*) n FROM central.fornecedor WHERE Cliente = 1 AND CodDesativado = 0').catch(() => [{ n: null }]);
  const vendDe = c => { const cd = cad.get(c.cli); const top = Object.entries(c.vend).sort((a, b) => b[1] - a[1])[0]; const cod = top ? +top[0] : (cd ? cd.vend : 0); return { cod, nome: B.vend[cod] || (cod ? 'Vendedor ' + cod : 'Sem vendedor') }; };
  const info = c => { const cd = cad.get(c.cli) || {}; const vd = vendDe(c); return { cli: c.cli, nome: c.nome || cd.nome || '', cidade: cd.cidade || '', bairro: cd.bairro || '', vend: vd.nome, vendCod: vd.cod, limite: cd.limite || 0 }; };
  // margem do mês por cliente: notas da base (custo dos itens)
  const notasMes = B.notas.filter(n => n.st === 'F' && n.d >= dIni), mCli = {};
  for (const n of notasMes) { const m = mCli[n.cli] || (mCli[n.cli] = { v: 0, c: 0, vc: 0, n: 0 }); m.n++; m.v += n.v; if (n.custo != null) { m.c += n.custo; m.vc += n.v; } }
  const ativosMes = [...porCli.values()].filter(c => c.nMes), totMes = soma(ativosMes, c => c.vMes);
  let acum = 0;
  const top = ativosMes.sort((a, b) => b.vMes - a.vMes).map((c, i) => { acum += c.vMes; const m = mCli[c.cli]; return { ...info(c), rank: i + 1, n: c.nMes, v: r2(c.vMes), vAnt: r2(c.vAnt), ticket: r2(c.vMes / c.nMes), ult: c.ult, margem: m && m.vc > 0 ? pct(m.vc - m.c, m.vc) : null, pct: pct(c.vMes, totMes), acum: pct(acum, totMes), classe: acum / totMes <= 0.8 ? 'A' : acum / totMes <= 0.95 ? 'B' : 'C', nova: (primeira.get(c.cli) || '') >= dIni }; });
  const novos = ativosMes.filter(c => (primeira.get(c.cli) || '') >= dIni).map(c => ({ ...info(c), primeira: primeira.get(c.cli), n: c.nMes, v: r2(c.vMes) })).sort((a, b) => b.v - a.v);
  const sumidos = [...porCli.values()].filter(c => !c.n30 && c.ult >= d120).map(c => ({ ...info(c), ult: c.ult, dias: diasEntre(c.ult, dHoje), n90: c.n90, v90: r2(c.v90), nAno: c.n, vAno: r2(c.v), media: r2(c.v / Math.max(1, c.n)) })).sort((a, b) => b.vAno - a.vAno);
  const ativosAnt = [...porCli.values()].filter(c => c.nAnt), ativos90 = [...porCli.values()].filter(c => c.n90).length;
  const cid = {}; for (const c of ativosMes) { const k = (cad.get(c.cli) || {}).cidade || 'Sem cidade'; const x = cid[k] || (cid[k] = { cidade: k, clientes: 0, n: 0, v: 0 }); x.clientes++; x.n += c.nMes; x.v += c.vMes; }
  const pv = {}; for (const c of [...porCli.values()]) { if (!c.nMes && !c.n90) continue; const vd = vendDe(c); const x = pv[vd.cod] || (pv[vd.cod] = { cod: vd.cod, nome: vd.nome, ativosMes: 0, ativos90: 0, novos: 0, sumidos: 0, v: 0 }); if (c.nMes) { x.ativosMes++; x.v += c.vMes; } if (c.n90) x.ativos90++; if ((primeira.get(c.cli) || '') >= dIni) x.novos++; if (!c.n30 && c.ult >= d120) x.sumidos++; }
  const top10 = top.slice(0, 10).reduce((s, c) => s + c.v, 0);
  return { de: dIni, ate: dHoje, mesAnt: { de: dIniA, ate: dFimA }, cadastro: cc && cc.n != null ? +cc.n : null,
    ativosMes: ativosMes.length, ativosMesAnt: ativosAnt.length, ativos90, novosMes: novos.length, sumidosN: sumidos.length,
    vendaMes: r2(totMes), ticketCliente: ativosMes.length ? r2(totMes / ativosMes.length) : 0, pedidosPorCliente: ativosMes.length ? r1(soma(ativosMes, c => c.nMes) / ativosMes.length) : 0,
    top10Pct: pct(top10, totMes), classes: { A: top.filter(c => c.classe === 'A').length, B: top.filter(c => c.classe === 'B').length, C: top.filter(c => c.classe === 'C').length },
    top: top.slice(0, 60), novos, sumidos: sumidos.slice(0, 60),
    porCidade: Object.values(cid).map(x => ({ ...x, v: r2(x.v), pct: pct(x.v, totMes) })).sort((a, b) => b.v - a.v),
    porVendedor: Object.values(pv).map(x => ({ ...x, v: r2(x.v) })).sort((a, b) => b.v - a.v) };
}
// notas do cliente no período da base (clique no cliente)
async function notasCliente(cli, hoje = new Date()) {
  const B = await base(hoje), ns = B.notas.filter(n => n.cli === +cli).sort((a, b) => b.d.localeCompare(a.d) || b.v - a.v);
  const ps = B.pedidos.filter(p => p.cli === +cli && !faturado(p) && p.st !== 9), xml = await xmlExiste(ns.map(n => n.chave));
  return { cli: +cli, de: B.ini, ate: B.hoje, n: ns.length, total: r2(soma(ns.filter(n => n.st === 'F'))),
    notas: ns.map(n => ({ nn: n.nn, d: n.d, hora: n.hora, v: n.v, custo: n.custo, margem: n.custo != null && n.v > 0 ? pct(n.v - n.custo, n.v) : null, vend: n.vendNome, forma: n.forma, st: n.st, chave: xml.has(n.chave) ? n.chave : null, ped: n.ped })),
    abertos: ps.map(p => ({ ped: p.ped, d: p.d, hora: p.hora, v: p.v, vend: p.vendNome, forma: p.forma, st: p.st })) };
}

// ── 3 TELEVENDAS (pedidos) ─────────────────────────────────────────────────────────────────────────────────
const idadeHoras = (d, hora, agora) => { const t = new Date(d + 'T' + (String(hora || '00:00:00').slice(0, 8).padEnd(8, ':00').slice(0, 8))); return isNaN(t) ? null : r1((agora - t) / 36e5); };
async function televendas(hoje) {
  const q = deps.q, B = await base(hoje), dHoje = B.hoje, dIni = dHoje.slice(0, 8) + '01', agora = new Date();
  const P = B.pedidos, mesP = P.filter(p => p.d >= dIni), hojeP = mesP.filter(p => p.d === dHoje);
  // aberto = sem NF-e e não cancelado. Mais de 7 dias sem faturar quase sempre é pedido abandonado que ninguém cancelou:
  // fica numa lista à parte ("antigos") pra não esconder os de verdade
  const todosAb = P.filter(p => !faturado(p) && p.st !== 9).map(p => ({ ...p, idade: idadeHoras(p.d, p.hora, agora) })).sort((a, b) => a.d.localeCompare(b.d) || a.hora.localeCompare(b.hora));
  const abertos = todosAb.filter(p => (p.idade || 0) <= 24 * 7), antigos = todosAb.filter(p => (p.idade || 0) > 24 * 7);
  const parados = abertos.filter(p => (p.idade || 0) > 24);
  const notaPorPed = new Map(B.notas.filter(n => n.st === 'F').map(n => [n.ped, n]));
  const fatMes = mesP.filter(faturado), cancMes = mesP.filter(p => p.st === 9);
  const mesmoDia = fatMes.filter(p => { const n = notaPorPed.get(p.ped); return n && n.d === p.d; }).length;
  const st = arr => ({ n: arr.length, v: r2(soma(arr)) });
  const pv = {};
  for (const p of mesP) { const x = pv[p.vend] || (pv[p.vend] = { cod: p.vend, nome: p.vendNome, mes: [], hoje: [], fat: [], canc: [], abertos: [] }); x.mes.push(p); if (p.d === dHoje) x.hoje.push(p); if (faturado(p)) x.fat.push(p); else if (p.st === 9) x.canc.push(p); else x.abertos.push(p); }
  const vendedores = Object.values(pv).map(x => ({ cod: x.cod, nome: x.nome, hoje: st(x.hoje), mes: st(x.mes), faturado: st(x.fat), cancelados: st(x.canc), abertos: st(x.abertos), ticket: x.mes.length ? r2(soma(x.mes) / x.mes.length) : 0, clientes: new Set(x.mes.map(p => p.cli)).size })).sort((a, b) => b.mes.v - a.mes.v);
  const formas = {}; for (const p of fatMes) { const f = formas[p.forma] || (formas[p.forma] = { nome: p.forma, n: 0, v: 0 }); f.n++; f.v += p.v; }
  const horas = Array.from({ length: 24 }, (_, h) => ({ h, n: 0, v: 0 })); for (const p of mesP) { const h = parseInt(p.hora.slice(0, 2)); if (h >= 0 && h < 24) { horas[h].n++; horas[h].v += p.v; } }
  const dias = {}; for (const p of mesP) { const x = dias[p.d] || (dias[p.d] = { d: p.d, n: 0, v: 0 }); x.n++; x.v += p.v; }
  // produtos mais vendidos no mês (pedidos faturados) — custo atual do CD pra margem
  const ids = fatMes.map(p => p.ped);
  let produtos = [];
  if (ids.length) {
    const rows = await q(`SELECT p.CodigoBarra cod, MAX(p.Descricao) descricao, SUM(p.Qtd) q, SUM(p.Total) v, COUNT(DISTINCT p.nPedido) ped, MAX(p.Und) und FROM central.delivery_produtos p
                          WHERE p.nPedido IN (${ids.map(() => '?').join(',')}) GROUP BY p.CodigoBarra ORDER BY SUM(p.Total) DESC LIMIT 60`, ids).catch(e => { console.error('[DASH-DIST] produtos', e.message); return []; });
    const cods = rows.map(r => String(r.cod).trim()), custo = new Map();
    if (cods.length) for (const c of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja${LOJA} WHERE CodigoBarra IN (${cods.map(() => '?').join(',')})`, cods).catch(() => [])) custo.set(String(c.cod).trim(), numBR(c.Custo));
    const totV = soma(rows, r => num(r.v));
    produtos = rows.map(r => { const cod = String(r.cod).trim(), qd = num(r.q), v = r2(num(r.v)), cu = custo.get(cod), c = cu != null ? r2(cu * qd) : null; return { cod, descricao: String(r.descricao || '').trim(), und: String(r.und || '').trim(), q: qd, v, ped: +r.ped, custo: c, margem: c != null && v > 0 ? pct(v - c, v) : null, pct: pct(v, totV) }; });
  }
  return { de: dIni, ate: dHoje, hora: agora.toTimeString().slice(0, 5),
    hoje: { ...st(hojeP), faturados: st(hojeP.filter(faturado)), abertos: st(hojeP.filter(p => !faturado(p) && p.st !== 9)), cancelados: st(hojeP.filter(p => p.st === 9)), clientes: new Set(hojeP.map(p => p.cli)).size },
    mes: { ...st(mesP), faturados: st(fatMes), cancelados: st(cancMes), abertos: st(mesP.filter(p => !faturado(p) && p.st !== 9)), ticket: mesP.length ? r2(soma(mesP) / mesP.length) : 0, clientes: new Set(mesP.map(p => p.cli)).size, mesmoDiaPct: pct(mesmoDia, fatMes.length), taxaCancel: pct(cancMes.length, mesP.length), diasComPedido: Object.keys(dias).length },
    abertos: abertos.map(p => ({ ped: p.ped, d: p.d, hora: p.hora, idade: p.idade, cliente: p.nome, cli: p.cli, vend: p.vendNome, forma: p.forma, v: p.v, st: p.st })), parados: parados.length, paradosV: r2(soma(parados)),
    antigos: { n: antigos.length, v: r2(soma(antigos)), itens: antigos.map(p => ({ ped: p.ped, d: p.d, hora: p.hora, idade: p.idade, cliente: p.nome, cli: p.cli, vend: p.vendNome, forma: p.forma, v: p.v, st: p.st })) },
    vendedores, formas: Object.values(formas).map(f => ({ ...f, v: r2(f.v), pct: pct(f.v, soma(fatMes)) })).sort((a, b) => b.v - a.v),
    horas: horas.map(h => ({ ...h, v: r2(h.v) })), porDia: Object.values(dias).map(x => ({ ...x, v: r2(x.v) })).sort((a, b) => a.d.localeCompare(b.d)),
    cancelados: cancMes.sort((a, b) => b.d.localeCompare(a.d) || b.v - a.v).slice(0, 30).map(p => ({ ped: p.ped, d: p.d, hora: p.hora, cliente: p.nome, vend: p.vendNome, v: p.v, forma: p.forma })), produtos };
}

// ── 4 ESTOQUE DO CD ────────────────────────────────────────────────────────────────────────────────────────
const faixaDe = d => d == null ? 120 : d >= 120 ? 120 : d >= 90 ? 90 : d >= 60 ? 60 : 0;
async function estoque(hoje) {
  const q = deps.q, dHoje = iso(hoje), d30 = addDias(dHoje, -30), d120 = addDias(dHoje, -120), d90f = addDias(dHoje, 90);
  const est = new Map();
  for (const r of await q(`SELECT CodigoBarra cod, Qtd FROM central.estoquen${LOJA} WHERE CAST(REPLACE(Qtd, ',', '.') AS DECIMAL(14,3)) > 0`).catch(e => { console.error('[DASH-DIST] estoque', e.message); return []; })) est.set(String(r.cod).trim(), numBR(r.Qtd));
  const tab = new Map();
  for (const r of await q('SELECT codigobarra cod, preco FROM central.s_tabela_item WHERE cod_tabela = 1 AND status_item = 0').catch(() => [])) tab.set(String(r.cod).trim(), num(r.preco));
  const cods = [...new Set([...est.keys(), ...tab.keys()])], custo = new Map(), cad = new Map(), gr = {}, gs = {};
  for (const r of await q('SELECT CodGrupo, TRIM(Descricao) d FROM central.grupo').catch(() => [])) gr[+r.CodGrupo] = String(r.d || '').trim();
  for (const r of await q('SELECT CodSubGrupo, CodGrupo, TRIM(Descricao) d FROM central.gruposub').catch(() => [])) gs[+r.CodSubGrupo] = { sub: String(r.d || '').trim(), grupo: gr[+r.CodGrupo] || '' };
  for (const ch of chunk(cods, 800)) {
    for (const r of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja${LOJA} WHERE CodigoBarra IN (${ch.map(() => '?').join(',')})`, ch).catch(() => [])) custo.set(String(r.cod).trim(), numBR(r.Custo));
    for (const r of await q(`SELECT CodigoBarra cod, TRIM(Descricao) d, CodGrupoSub g, CodDesativado des FROM central.itens WHERE CodigoBarra IN (${ch.map(() => '?').join(',')})`, ch).catch(() => [])) { const g = gs[+r.g] || { sub: '', grupo: '' }; cad.set(String(r.cod).trim(), { descricao: String(r.d || '').trim(), grupo: g.grupo, subgrupo: g.sub, desativado: +r.des !== 0 }); }
  }
  // giro pelos pedidos faturados: última venda e quantidade dos últimos 30 dias (delivery_produtos × delivery)
  const venda = new Map();
  for (const r of await q(`SELECT p.CodigoBarra cod, DATE_FORMAT(MAX(d.Data),'%Y-%m-%d') ult, SUM(CASE WHEN d.Data > ? THEN p.Qtd ELSE 0 END) q30, SUM(CASE WHEN d.Data > ? THEN p.Total ELSE 0 END) v30, COUNT(DISTINCT CASE WHEN d.Data > ? THEN p.nPedido END) ped30
                           FROM central.delivery_produtos p JOIN central.delivery d ON d.nPedido = p.nPedido
                           WHERE d.nLoja = ? AND d.Status <> 9 AND d.NFe <> '0' AND d.Data >= ? AND p.nPedido > 2700 GROUP BY p.CodigoBarra`, [d30, d30, d30, LOJA, d120]).catch(e => { console.error('[DASH-DIST] giro', e.message); return []; })) venda.set(String(r.cod).trim(), { ult: isoV(r.ult), q30: num(r.q30), v30: num(r.v30), ped30: +r.ped30 });
  const lotes = (await q(`SELECT Codigobarra cod, DATE_FORMAT(Data,'%Y-%m-%d') val, Qtd, Lote, Caixa, DATE_FORMAT(dataEntrada,'%Y-%m-%d') ent FROM central.itenscoletorvalidade WHERE nLoja = ? AND Data BETWEEN ? AND ?`, [LOJA, addDias(dHoje, -30), d90f]).catch(() => []))
    .map(r => ({ cod: String(r.cod).trim(), validade: isoV(r.val), qtd: num(r.Qtd), lote: String(r.Lote || '').trim(), caixa: num(r.Caixa), entrada: isoV(r.ent) }));
  const itens = [...est.entries()].map(([cod, e]) => { const c = cad.get(cod) || { descricao: cod, grupo: '', subgrupo: '' }, cu = custo.get(cod) || 0, pr = tab.get(cod) || 0, vd = venda.get(cod) || null, dias = vd && vd.ult ? diasEntre(vd.ult, dHoje) : null;
    return { cod, descricao: c.descricao, grupo: c.grupo || 'Sem grupo', subgrupo: c.subgrupo, est: e, custo: cu, valor: r2(e * cu), preco: pr, valorTab: r2(e * pr), naTabela: tab.has(cod), ult: vd ? vd.ult : null, dias, q30: vd ? vd.q30 : 0, v30: vd ? r2(vd.v30) : 0, ped30: vd ? vd.ped30 : 0, cob: vd && vd.q30 > 0 ? r1(e / (vd.q30 / 30)) : null, faixa: faixaDe(dias) }; });
  const valor = r2(soma(itens, i => i.valor)), valorTab = r2(soma(itens.filter(i => i.naTabela), i => i.valorTab)), custoTab = r2(soma(itens.filter(i => i.naTabela), i => i.valor));
  const rupturas = [...tab.entries()].filter(([cod]) => !est.has(cod)).map(([cod, pr]) => { const c = cad.get(cod) || { descricao: cod, grupo: '' }, vd = venda.get(cod) || null; return { cod, descricao: c.descricao, grupo: c.grupo, preco: pr, ult: vd ? vd.ult : null, q30: vd ? vd.q30 : 0, v30: vd ? r2(vd.v30) : 0, ped30: vd ? vd.ped30 : 0, desativado: !!(cad.get(cod) || {}).desativado }; }).filter(r => !r.desativado).sort((a, b) => b.v30 - a.v30 || b.q30 - a.q30);
  const cobBaixa = itens.filter(i => i.cob != null && i.cob < 10).sort((a, b) => a.cob - b.cob);
  const parados = itens.filter(i => i.faixa >= 60).sort((a, b) => b.valor - a.valor);
  const par = f => { const a = parados.filter(i => i.faixa === f); return { n: a.length, v: r2(soma(a, i => i.valor)) }; };
  const vencendo = lotes.filter(l => est.has(l.cod)).map(l => { const c = cad.get(l.cod) || { descricao: l.cod }; return { ...l, descricao: c.descricao, dias: diasEntre(dHoje, l.validade), est: est.get(l.cod), custo: custo.get(l.cod) || 0 }; }).sort((a, b) => a.validade.localeCompare(b.validade));
  const grupos = {}; for (const i of itens) { const g = grupos[i.grupo] || (grupos[i.grupo] = { grupo: i.grupo, itens: 0, valor: 0, valorTab: 0, parado: 0 }); g.itens++; g.valor += i.valor; g.valorTab += i.valorTab; if (i.faixa >= 60) g.parado += i.valor; }
  return { hoje: dHoje, itens: itens.length, valor, valorTabela: valorTab, margemTabela: pct(valorTab - custoTab, valorTab), tabelaItens: tab.size, tabelaComEstoque: [...tab.keys()].filter(c => est.has(c)).length,
    rupturas: { n: rupturas.length, comVenda30: rupturas.filter(r => r.q30 > 0).length, itens: rupturas.slice(0, 80) },
    cobBaixa: { n: cobBaixa.length, itens: cobBaixa.slice(0, 60) },
    parados: { n: parados.length, v: r2(soma(parados, i => i.valor)), f60: par(60), f90: par(90), f120: par(120), itens: parados.slice(0, 80) },
    vencendo: { n30: vencendo.filter(l => l.dias >= 0 && l.dias <= 30).length, n60: vencendo.filter(l => l.dias > 30 && l.dias <= 60).length, vencidos: vencendo.filter(l => l.dias < 0).length, lotes: vencendo.slice(0, 80) },
    top: itens.filter(i => i.v30 > 0).sort((a, b) => b.v30 - a.v30).slice(0, 15),
    grupos: Object.values(grupos).map(g => ({ ...g, valor: r2(g.valor), valorTab: r2(g.valorTab), parado: r2(g.parado), pct: pct(g.valor, valor) })).sort((a, b) => b.valor - a.valor) };
}

// ── 5 EXPEDIÇÃO (painel do CD) ─────────────────────────────────────────────────────────────────────────────
const minutos = (h1, h2) => { const a = String(h1 || '').split(':'), b = String(h2 || '').split(':'); if (a.length < 2 || b.length < 2) return null; const m = (+b[0] * 60 + +b[1]) - (+a[0] * 60 + +a[1]); return m >= 0 ? m : null; };
async function expedicao(hoje) {
  const q = deps.q, dHoje = iso(hoje), d30 = addDias(dHoje, -30), agora = new Date();
  const painel = deps.listaExpedicao ? await safe('painel', () => deps.listaExpedicao(), null) : null;
  const conf = deps.listaConferencia ? await safe('conferencia', () => deps.listaConferencia(), null) : null;
  const rows = (await q(`SELECT nPedido ped, NomeFornec nome, Status st, DATE_FORMAT(DataEntrada,'%Y-%m-%d') de, HoraEntrada he, DATE_FORMAT(DataLiberacao,'%Y-%m-%d') dl, HoraLiberacao hl, OperadorCentral op
                         FROM central.painel_televendas WHERE nLoja = ? AND DataEntrada >= ?`, [LOJA, addDias(dHoje, -7)]).catch(() => []))
    .map(r => ({ ped: String(r.ped), nome: String(r.nome || '').trim(), st: +r.st, de: isoV(r.de), he: String(r.he || '').slice(0, 5), dl: isoV(r.dl), hl: String(r.hl || '').slice(0, 5), op: String(r.op || '').trim() }));
  const hojeR = rows.filter(r => r.de === dHoje), libHoje = rows.filter(r => r.st === 4 && r.dl === dHoje);
  const tempos = libHoje.filter(r => r.de === dHoje).map(r => minutos(r.he, r.hl)).filter(m => m != null);
  const tempoMedio = tempos.length ? Math.round(tempos.reduce((s, m) => s + m, 0) / tempos.length) : null;
  const porHora = Array.from({ length: 24 }, (_, h) => ({ h, entrou: 0, liberou: 0 }));
  for (const r of hojeR) { const h = parseInt(r.he.slice(0, 2)); if (h >= 0 && h < 24) porHora[h].entrou++; }
  for (const r of libHoje) { const h = parseInt(r.hl.slice(0, 2)); if (h >= 0 && h < 24) porHora[h].liberou++; }
  const pendAntigos = rows.filter(r => r.st < 4 && r.de < dHoje).map(r => ({ ...r, dias: diasEntre(r.de, dHoje) })).sort((a, b) => a.de.localeCompare(b.de));
  const porDia = (await q(`SELECT DATE_FORMAT(DataLiberacao,'%Y-%m-%d') d, COUNT(*) n FROM central.painel_televendas WHERE nLoja = ? AND Status = 4 AND DataLiberacao BETWEEN ? AND ? GROUP BY DATE_FORMAT(DataLiberacao,'%Y-%m-%d') ORDER BY 1`, [LOJA, d30, dHoje]).catch(() => [])).map(r => ({ d: isoV(r.d), n: +r.n }));
  const diasAnt = porDia.filter(x => x.d < dHoje), mediaDia = diasAnt.length ? r1(diasAnt.reduce((s, x) => s + x.n, 0) / diasAnt.length) : null;
  const ETAPAS = [['separacao', 'Pedido p/ separação'], ['em_separacao', 'Em separação'], ['aguardando_liberacao', 'Aguardando liberação'], ['reconferir', 'Reconferir'], ['liberado', 'Liberado hoje']];
  const ETC = [['conf_pedido', 'Conferência do pedido'], ['conf_coletor', 'No coletor'], ['conferido', 'Conferido'], ['reconferir', 'Reconferir'], ['liberado', 'Liberado hoje']];
  const emAberto = ETAPAS.slice(0, 4).reduce((s, [k]) => s + ((painel && painel.resumo[k]) || 0), 0);
  return { hoje: dHoje, hora: agora.toTimeString().slice(0, 5), etapas: ETAPAS.map(([k, nome]) => ({ k, nome, n: painel ? painel.resumo[k] || 0 : 0, pedidos: painel ? painel.colunas[k] : [] })), reconferirItens: painel ? painel.itensReconferir : [],
    emAberto, entraramHoje: hojeR.length, liberadosHoje: libHoje.length, tempoMedioMin: tempoMedio, tempoMaxMin: tempos.length ? Math.max(...tempos) : null, porHora, pendAntigos, porDia, mediaDia,
    conferencia: conf ? { total: conf.resumo.total, etapas: ETC.map(([k, nome]) => ({ k, nome, n: conf.resumo[k] || 0, notas: conf.colunas[k] })), reconferirItens: conf.itensReconferir } : null };
}

// ── 6 FINANCEIRO (boletos a receber + o que o CD paga) ─────────────────────────────────────────────────────
async function financeiro(hoje) {
  const q = deps.q, dHoje = iso(hoje), semIni = semanaIni(dHoje), semFim = addDias(semIni, 6), proxIni = addDias(semIni, 7), dIni = dHoje.slice(0, 8) + '01';
  const abertos = (await q(`SELECT nReg id, nNota nn, Parcela p, Total_Parcela tp, DATE_FORMAT(Data_Emit,'%Y-%m-%d') emis, DATE_FORMAT(Data_Vencto,'%Y-%m-%d') venc, Valor_Boleto v, Nome_Pagador nome, CNPJ_Pagador cnpj, Cidade_Pagador cidade, StatusBoleto st, NomeBanco banco
                            FROM central.registrarboletos WHERE nLoja = ? AND StatusBoleto IN (0, 1) AND Data_Vencto >= ?`, [LOJA, addDias(dHoje, -400)]).catch(e => { console.error('[DASH-DIST] boletos', e.message); return []; }))
    .map(b => ({ id: +b.id, nn: String(b.nn || ''), parcela: +b.p || 1, parcelas: +b.tp || 1, emis: isoV(b.emis), venc: isoV(b.venc), v: r2(num(b.v)), nome: String(b.nome || '').trim(), cnpj: String(b.cnpj || '').trim(), cidade: String(b.cidade || '').trim(), st: +b.st, banco: String(b.banco || '').trim(), dias: diasEntre(b.venc, dHoje) }));
  finBoletos = abertos;
  const [liq] = await q(`SELECT COUNT(*) n, COALESCE(SUM(Valor_Boleto),0) v, DATE_FORMAT(MAX(Data_Vencto),'%Y-%m-%d') ult FROM central.registrarboletos WHERE nLoja = ? AND StatusBoleto = 2 AND Data_Vencto >= ?`, [LOJA, dIni]).catch(() => [{}]);
  const [emit] = await q(`SELECT COUNT(*) n, COALESCE(SUM(Valor_Boleto),0) v FROM central.registrarboletos WHERE nLoja = ? AND StatusBoleto <> 3 AND Data_Emit >= ?`, [LOJA, dIni]).catch(() => [{}]);
  const [ultLiq] = await q(`SELECT DATE_FORMAT(MAX(Data_Vencto),'%Y-%m-%d') d FROM central.registrarboletos WHERE nLoja = ? AND StatusBoleto = 2`, [LOJA]).catch(() => [{}]);
  const tot = arr => ({ n: arr.length, v: r2(soma(arr)) });
  const venc = abertos.filter(b => b.venc < dHoje), hojeB = abertos.filter(b => b.venc === dHoje), sem = abertos.filter(b => b.venc >= dHoje && b.venc <= semFim), prox = abertos.filter(b => b.venc >= proxIni);
  const aging = [[1, 7, 'até 7 dias'], [8, 30, '8 a 30 dias'], [31, 60, '31 a 60 dias'], [61, 9999, 'mais de 60 dias']].map(([a, b, rotulo]) => ({ rotulo, de: a, ate: b, ...tot(venc.filter(x => x.dias >= a && x.dias <= b)) }));
  const porCli = {}; for (const b of venc) { const c = porCli[b.cnpj] || (porCli[b.cnpj] = { cnpj: b.cnpj, nome: b.nome, cidade: b.cidade, n: 0, v: 0, maisAntigo: b.venc, dias: b.dias }); c.n++; c.v += b.v; if (b.venc < c.maisAntigo) { c.maisAntigo = b.venc; c.dias = b.dias; } }
  const devedores = Object.values(porCli).map(c => ({ ...c, v: r2(c.v) })).sort((a, b) => b.v - a.v);
  const dias = []; for (let i = 0; i < 7; i++) { const d = addDias(semIni, i); dias.push({ d, ...tot(abertos.filter(b => b.venc === d)), passado: d < dHoje, ehHoje: d === dHoje }); }
  const sems = []; for (let w = 1; w <= 8; w++) { const a = addDias(semIni, 7 * w), b = addDias(a, 6); sems.push({ a, b, ...tot(abertos.filter(x => x.venc >= a && x.venc <= b)) }); }
  const fim8 = addDias(semIni, 7 * 8 + 6), depois = tot(abertos.filter(x => x.venc > fim8));
  const porVenc = {}; for (const b of abertos) { const x = porVenc[b.venc] || (porVenc[b.venc] = { venc: b.venc, n: 0, v: 0 }); x.n++; x.v += b.v; }
  // o que o CD paga: contas a pagar da Filial 10 (mesma fonte do Dashboard Loja)
  let pagar = null;
  if (deps.dashboard) { const f = await safe('a pagar', () => deps.dashboard.segmento('financeiro'), null); const F = f && f.financeiro;
    if (F && F.linhas) { const L = F.linhas.filter(r => r.loja === LOJA), C = (F.categorias || []).filter(r => r.loja === LOJA), s = pred => L.reduce((a, r) => pred(r) ? { n: a.n + r.n, v: r2(a.v + r.v) } : a, { n: 0, v: 0 });
      const fds = F.hoje < F.semIni, diaRef = fds ? F.semIni : F.hoje;
      pagar = { hoje: F.hoje, semIni: F.semIni, semFim: F.semFim, proxIni: F.proxIni, diaRef, fds, vencidos: s(r => r.pag < F.hoje), hojeP: s(r => r.pag === diaRef), semana: s(r => r.pag >= F.hoje && r.pag <= F.semFim), proximas: s(r => r.pag >= F.proxIni), linhas: L, categorias: C, grupos: F.grupos || {} }; } }
  return { hoje: dHoje, semIni, semFim, proxIni, ultLiq: isoV((ultLiq || {}).d),
    abertos: tot(abertos), vencidos: { ...tot(venc), clientes: devedores.length }, hojeR: tot(hojeB), semana: tot(sem), proximas: tot(prox), aging, devedores: devedores.slice(0, 40),
    dias, semanas: sems, depois, porVenc: Object.values(porVenc).map(x => ({ ...x, v: r2(x.v) })).sort((a, b) => a.venc.localeCompare(b.venc)),
    liquidadosMes: { n: +(liq || {}).n || 0, v: r2(num((liq || {}).v)), ate: isoV((liq || {}).ult) }, emitidosMes: { n: +(emit || {}).n || 0, v: r2(num((emit || {}).v)) }, pagar };
}
// boletos em aberto filtrados (clique nas linhas do Financeiro)
async function boletos({ cnpj = '', vencIni = '', vencFim = '', situacao = '' } = {}) {
  if (!finBoletos) await financeiro(new Date());
  const dHoje = iso(new Date());
  let sel = finBoletos.filter(b => (!cnpj || b.cnpj === cnpj) && (!vencIni || b.venc >= vencIni) && (!vencFim || b.venc <= vencFim));
  if (situacao === 'vencidos') sel = sel.filter(b => b.venc < dHoje);
  sel = sel.sort((a, b) => a.venc.localeCompare(b.venc) || b.v - a.v);
  return { n: sel.length, total: r2(soma(sel)), boletos: sel };
}

// ── montagem / cache por bloco ─────────────────────────────────────────────────────────────────────────────
const SEGS = { faturamento, clientes, televendas, estoque, expedicao, financeiro };
async function segmento(nome) {
  if (!SEGS[nome]) throw new Error('bloco inválido: ' + nome);
  if (fresco(segCache[nome])) return segCache[nome];
  if (segCalc[nome]) return segCalc[nome];
  segCalc[nome] = (async () => {
    const hoje = new Date(), t0 = Date.now(), out = {};
    out[nome] = await SEGS[nome](hoje);
    const r = { ...out, atualizadoEm: new Date().toISOString(), hoje: iso(hoje), ms: Date.now() - t0 };
    segCache[nome] = r; console.log(`[DASH-DIST] ${nome} em ${(r.ms / 1000).toFixed(1)}s`); return r;
  })().finally(() => { segCalc[nome] = null; });
  return segCalc[nome];
}
function resumo() {
  return { pronto: Object.fromEntries(Object.keys(SEGS).map(k => [k, !!(segCache[k] && segCache[k][k] != null)])), atualizadoEm: Object.values(segCache).map(c => c.atualizadoEm).sort().pop() || null, calculando: Object.values(segCalc).some(Boolean), hoje: iso(new Date()) };
}
async function calcular() { segCache = {}; baseCache = null; for (const k of Object.keys(SEGS)) await safe(k, () => segmento(k), null); }
function agendar() { setTimeout(() => calcular().catch(e => console.error('[DASH-DIST]', e.message)), 40 * 1000); }

// ── dados de exemplo (TESTE) pra olhar o layout sem ERP: ?demo=1 ──────────────────────────────────────────
function demo(nome) {
  const hoje = new Date(), dHoje = iso(hoje), dIni = dHoje.slice(0, 8) + '01', dia = hoje.getDate(), ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
  let s = 7; const rnd = (a, b) => { s = (s * 9301 + 49297) % 233280; return a + (b - a) * (s / 233280); };
  const V = ['RODRIGO CAHU', 'ANDREYZIO GONÇALVES', 'KLEBER JUNIOR', 'JAIRO BORGES', 'ERVERSON SOUZA', 'SERGIO LINS'];
  const C = ['MERCADINHO BOM PREÇO (TESTE)', 'SUPERMERCADO LEVE MAIS (TESTE)', 'PADARIA CONCEIÇÃO (TESTE)', 'MERCEARIA SÃO JOSÉ (TESTE)', 'J.S BOMBONS (TESTE)', 'ATACADINHO DA VILA (TESTE)', 'MINI MERCADO ESPERANÇA (TESTE)', 'ESTIVAS IRMÃOS COSTA (TESTE)', 'PANIFICADORA DOIS IRMÃOS (TESTE)', 'MERCADO CENTRAL (TESTE)', 'DISTRIBUIDORA NORDESTE (TESTE)', 'SUPERMIX VARIEDADES (TESTE)'];
  const CID = ['RECIFE', 'JABOATÃO', 'OLINDA', 'PAULISTA', 'CABO', 'CAMARAGIBE'];
  const P = ['AÇÚCAR CRISTAL 1KG FD30 (TESTE)', 'ÓLEO DE SOJA 900ML CX20 (TESTE)', 'ARROZ TIPO 1 1KG FD30 (TESTE)', 'MARGARINA 500G CX12 (TESTE)', 'LEITE UHT 1L CX12 (TESTE)', 'ÁGUA SANITÁRIA 1L CX12 (TESTE)', 'CAFÉ 250G CX20 (TESTE)', 'FEIJÃO CARIOCA 1KG FD30 (TESTE)', 'MACARRÃO 500G FD20 (TESTE)', 'BISCOITO CREAM CRACKER CX20 (TESTE)', 'DETERGENTE 500ML CX24 (TESTE)', 'REFRIGERANTE 2L FD6 (TESTE)'];
  const G = ['MERCEARIA', 'BEBIDAS', 'LIMPEZA', 'HIGIENE', 'FRIOS'];
  const ag = (n, v, c) => ({ n, v: r2(v), custo: r2(c), margem: pct(v - c, v), markup: pct(v - c, c), ticket: n ? r2(v / n) : 0, clientes: Math.round(n * 0.7) });
  const vend = (i, k) => { const n = Math.round(rnd(20, 90) * k), v = n * rnd(2200, 3600), c = v * rnd(0.82, 0.9); return ag(n, v, c); };
  if (nome === 'faturamento') {
    const vs = V.map((nome, i) => { const m = vend(i, 1), h = vend(i, 0.06), a = vend(i, 0.95); return { cod: i + 1, nome, hoje: h, mes: m, mesAnt: a, pct: 0, var: r1((m.v / a.v - 1) * 100) }; }); const tv = soma(vs, x => x.mes.v); vs.forEach(x => { x.pct = pct(x.mes.v, tv); });
    const M = vs.reduce((s, x) => ({ n: s.n + x.mes.n, v: s.v + x.mes.v, c: s.c + x.mes.custo }), { n: 0, v: 0, c: 0 }), H = vs.reduce((s, x) => ({ n: s.n + x.hoje.n, v: s.v + x.hoje.v, c: s.c + x.hoje.custo }), { n: 0, v: 0, c: 0 }), A = vs.reduce((s, x) => ({ n: s.n + x.mesAnt.n, v: s.v + x.mesAnt.v, c: s.c + x.mesAnt.custo }), { n: 0, v: 0, c: 0 });
    const meses = []; for (let k = 5; k >= 0; k--) { const d = new Date(hoje.getFullYear(), hoje.getMonth() - k, 1); meses.push({ m: iso(d).slice(0, 7), n: Math.round(rnd(380, 500)), v: r2(rnd(1.6e6, 2.2e6)) }); } meses[meses.length - 1] = { ...meses[meses.length - 1], n: M.n, v: r2(M.v) };
    return { mes: hoje.getMonth() + 1, ano: hoje.getFullYear(), dia, ultimoDia, de: dIni, ate: dHoje, mesAnt: { mes: ((hoje.getMonth() + 11) % 12) + 1, ano: hoje.getFullYear(), ate: dHoje, ultimoDia: 30 },
      hoje: { ...ag(H.n, H.v, H.c), semAnt: { data: addDias(dHoje, -7), ...ag(H.n - 3, H.v * 0.91, H.c * 0.9) }, var: 9.9, ontem: ag(H.n + 4, H.v * 1.1, H.c * 1.08) },
      mesAtual: { ...ag(M.n, M.v, M.c), projecao: r2(M.v / dia * ultimoDia), diaMedio: r2(M.v / dia), canceladas: { n: 6, v: 18420.5 } }, mesAnterior: { mesmoPeriodo: ag(A.n, A.v, A.c), completo: ag(Math.round(A.n * 1.08), A.v * 1.08, A.c * 1.08) }, var: r1((M.v / A.v - 1) * 100), varCompleto: null,
      vendedores: vs, formas: [{ nome: 'Boleto', n: Math.round(M.n * 0.88), v: r2(M.v * 0.9), pct: 90 }, { nome: 'Cartão', n: Math.round(M.n * 0.08), v: r2(M.v * 0.07), pct: 7 }, { nome: 'PIX', n: Math.round(M.n * 0.04), v: r2(M.v * 0.03), pct: 3 }], meses,
      notasHoje: C.slice(0, 9).map((c, i) => { const v = r2(rnd(900, 6800)), cu = r2(v * rnd(0.8, 0.9)); return { nn: String(5240 + i), hora: pad(8 + i) + ':' + pad(Math.round(rnd(0, 59))) + ':00', cliente: c, cli: 2000 + i, vend: V[i % V.length], v, custo: cu, margem: pct(v - cu, v), chave: null, ped: 6900 + i }; }) };
  }
  if (nome === 'clientes') {
    const tot = 1.9e6; let acum = 0;
    const top = C.map((nome, i) => { const v = r2(tot * (0.16 - i * 0.011)); acum += v; return { cli: 2000 + i, nome, cidade: CID[i % CID.length], bairro: 'CENTRO', vend: V[i % V.length], vendCod: i % V.length + 1, limite: 100000, rank: i + 1, n: Math.round(rnd(2, 9)), v, vAnt: r2(v * rnd(0.7, 1.3)), ticket: r2(v / 4), ult: addDias(dHoje, -Math.round(rnd(0, 9))), margem: r1(rnd(9, 19)), pct: pct(v, tot), acum: pct(acum, tot), classe: acum / tot <= 0.8 ? 'A' : acum / tot <= 0.95 ? 'B' : 'C', nova: i === 4 }; });
    return { de: dIni, ate: dHoje, mesAnt: { de: '', ate: '' }, cadastro: 467, ativosMes: 152, ativosMesAnt: 147, ativos90: 231, novosMes: 7, sumidosN: 23, vendaMes: tot, ticketCliente: r2(tot / 152), pedidosPorCliente: 3.2, top10Pct: 38.5, classes: { A: 41, B: 47, C: 64 }, top,
      novos: C.slice(4, 9).map((nome, i) => ({ cli: 2100 + i, nome, cidade: CID[i], bairro: 'PIEDADE', vend: V[i], primeira: addDias(dHoje, -Math.round(rnd(1, dia))), n: Math.round(rnd(1, 3)), v: r2(rnd(800, 9000)) })),
      sumidos: C.slice(2, 11).map((nome, i) => { const ult = addDias(dHoje, -Math.round(rnd(31, 110))); return { cli: 2200 + i, nome, cidade: CID[i % 6], bairro: 'VÁRZEA', vend: V[i % V.length], ult, dias: diasEntre(ult, dHoje), n90: Math.round(rnd(1, 6)), v90: r2(rnd(2000, 30000)), nAno: Math.round(rnd(4, 30)), vAno: r2(rnd(9000, 120000)), media: r2(rnd(1200, 5000)) }; }),
      porCidade: CID.map((cidade, i) => ({ cidade, clientes: Math.round(rnd(8, 60)), n: Math.round(rnd(20, 200)), v: r2(tot * (0.35 - i * 0.05)), pct: r1(35 - i * 5) })),
      porVendedor: V.map((nome, i) => ({ cod: i + 1, nome, ativosMes: Math.round(rnd(15, 40)), ativos90: Math.round(rnd(30, 60)), novos: Math.round(rnd(0, 3)), sumidos: Math.round(rnd(1, 7)), v: r2(tot / 6 * rnd(0.6, 1.4)) })) };
  }
  if (nome === 'televendas') {
    const st = (n, v) => ({ n, v: r2(v) });
    return { de: dIni, ate: dHoje, hora: hoje.toTimeString().slice(0, 5), hoje: { ...st(23, 61200), faturados: st(14, 39800), abertos: st(8, 19900), cancelados: st(1, 1500), clientes: 21 },
      mes: { ...st(561, 1.53e6), faturados: st(489, 1.39e6), cancelados: st(32, 113500), abertos: st(40, 91000), ticket: 2727, clientes: 152, mesmoDiaPct: 81.3, taxaCancel: 5.7, diasComPedido: dia },
      abertos: C.slice(0, 8).map((c, i) => ({ ped: 6890 + i, d: i < 3 ? addDias(dHoje, -1) : dHoje, hora: pad(7 + i) + ':' + pad(Math.round(rnd(0, 59))) + ':00', idade: i < 3 ? r1(rnd(24, 40)) : r1(rnd(0.5, 6)), cliente: c, cli: 2000 + i, vend: V[i % V.length], forma: i % 4 === 3 ? 'PIX' : 'Boleto', v: r2(rnd(600, 5200)), st: i % 2 })), parados: 3, paradosV: 4515.1,
      antigos: { n: 2, v: 3100.4, itens: C.slice(9, 11).map((c, i) => ({ ped: 6700 + i, d: addDias(dHoje, -12 - i), hora: '15:10:00', idade: (12 + i) * 24, cliente: c, cli: 2300 + i, vend: V[i], forma: 'Boleto', v: 1550.2, st: 1 })) },
      vendedores: V.map((nome, i) => ({ cod: i + 1, nome, hoje: st(Math.round(rnd(1, 6)), rnd(2000, 15000)), mes: st(Math.round(rnd(50, 130)), rnd(150000, 380000)), faturado: st(Math.round(rnd(45, 120)), rnd(140000, 350000)), cancelados: st(Math.round(rnd(1, 9)), rnd(2000, 20000)), abertos: st(Math.round(rnd(1, 9)), rnd(2000, 20000)), ticket: r2(rnd(2200, 3300)), clientes: Math.round(rnd(18, 45)) })).sort((a, b) => b.mes.v - a.mes.v),
      formas: [{ nome: 'Boleto', n: 440, v: 1.25e6, pct: 90 }, { nome: 'Cartão', n: 38, v: 98000, pct: 7 }, { nome: 'PIX', n: 11, v: 42000, pct: 3 }],
      horas: Array.from({ length: 24 }, (_, h) => ({ h, n: h >= 7 && h <= 18 ? Math.round(rnd(5, 70) * (h === 9 || h === 15 ? 1.6 : 1)) : 0, v: 0 })), porDia: [],
      cancelados: C.slice(3, 9).map((c, i) => ({ ped: 6800 + i, d: addDias(dHoje, -i), hora: '15:0' + i + ':00', cliente: c, vend: V[i % V.length], v: r2(rnd(400, 5300)), forma: 'Boleto' })),
      produtos: P.map((descricao, i) => { const v = r2(rnd(20000, 90000) * (1 - i * 0.05)), c = r2(v * rnd(0.8, 0.9)); return { cod: '789' + String(1000 + i), descricao, und: 'CX', q: Math.round(rnd(200, 3000)), v, ped: Math.round(rnd(30, 200)), custo: c, margem: pct(v - c, v), pct: r1(v / 9e5 * 100) }; }).sort((a, b) => b.v - a.v) };
  }
  if (nome === 'estoque') {
    const it = P.map((descricao, i) => { const est = Math.round(rnd(20, 900)), custo = r2(rnd(30, 140)), preco = r2(custo * rnd(1.08, 1.25)), q30 = i < 8 ? Math.round(rnd(0, 700)) : 0, dias = i < 8 ? Math.round(rnd(0, 20)) : Math.round(rnd(60, 200)); return { cod: '789' + String(1000 + i), descricao, grupo: G[i % G.length], subgrupo: '', est, custo, valor: r2(est * custo), preco, valorTab: r2(est * preco), naTabela: true, ult: addDias(dHoje, -dias), dias, q30, v30: r2(q30 * preco), ped30: Math.round(q30 / 8), cob: q30 ? r1(est / (q30 / 30)) : null, faixa: faixaDe(dias) }; });
    const parados = it.filter(i => i.faixa >= 60), par = f => { const a = parados.filter(i => i.faixa === f); return { n: a.length, v: r2(soma(a, i => i.valor)) }; };
    return { hoje: dHoje, itens: 190, valor: 3.31e6, valorTabela: 3.72e6, margemTabela: 11.1, tabelaItens: 443, tabelaComEstoque: 176,
      rupturas: { n: 267, comVenda30: 41, itens: P.slice(0, 10).map((descricao, i) => ({ cod: '790' + String(1000 + i), descricao, grupo: G[i % G.length], preco: r2(rnd(30, 140)), ult: addDias(dHoje, -Math.round(rnd(1, 40))), q30: Math.round(rnd(0, 400)), v30: r2(rnd(0, 30000)), ped30: Math.round(rnd(0, 40)) })).sort((a, b) => b.v30 - a.v30) },
      cobBaixa: { n: 9, itens: it.filter(i => i.cob != null).sort((a, b) => a.cob - b.cob).slice(0, 9) },
      parados: { n: parados.length, v: r2(soma(parados, i => i.valor)), f60: par(60), f90: par(90), f120: par(120), itens: parados },
      vencendo: { n30: 4, n60: 5, vencidos: 1, lotes: P.slice(0, 10).map((descricao, i) => { const dias = Math.round(rnd(-5, 85)); return { cod: '789' + String(1000 + i), descricao, validade: addDias(dHoje, dias), dias, qtd: Math.round(rnd(20, 400)), lote: 'L' + (2600 + i), caixa: 12, entrada: addDias(dHoje, -Math.round(rnd(10, 90))), est: Math.round(rnd(20, 900)), custo: r2(rnd(30, 140)) }; }).sort((a, b) => a.dias - b.dias) },
      top: it.filter(i => i.v30 > 0).sort((a, b) => b.v30 - a.v30),
      grupos: G.map((grupo, i) => ({ grupo, itens: Math.round(rnd(10, 60)), valor: r2(1.2e6 * (1 - i * 0.18)), valorTab: r2(1.35e6 * (1 - i * 0.18)), parado: r2(rnd(20000, 200000)), pct: r1(36 - i * 6.5) })) };
  }
  if (nome === 'expedicao') {
    const ped = (n, k) => Array.from({ length: n }, (_, i) => ({ pedido: String(6850 + k * 10 + i), nome: C[(i + k) % C.length] }));
    return { hoje: dHoje, hora: hoje.toTimeString().slice(0, 5), etapas: [['separacao', 'Pedido p/ separação', 4], ['em_separacao', 'Em separação', 6], ['aguardando_liberacao', 'Aguardando liberação', 2], ['reconferir', 'Reconferir', 1], ['liberado', 'Liberado hoje', 27]].map(([k, nome, n], i) => ({ k, nome, n, pedidos: ped(Math.min(n, 8), i) })),
      reconferirItens: [{ pedido: '6881', itens: ['AÇÚCAR CRISTAL 1KG FD30 (TESTE)', 'ÓLEO DE SOJA 900ML CX20 (TESTE)'] }], emAberto: 13, entraramHoje: 40, liberadosHoje: 27, tempoMedioMin: 94, tempoMaxMin: 260,
      porHora: Array.from({ length: 24 }, (_, h) => ({ h, entrou: h >= 7 && h <= 17 ? Math.round(rnd(0, 8)) : 0, liberou: h >= 8 && h <= 18 ? Math.round(rnd(0, 6)) : 0 })),
      pendAntigos: [{ ped: '6811', nome: C[1], st: 1, de: addDias(dHoje, -2), he: '16:40', dl: null, hl: '', op: '', dias: 2 }, { ped: '6839', nome: C[5], st: 2, de: addDias(dHoje, -1), he: '17:55', dl: null, hl: '', op: '', dias: 1 }],
      porDia: Array.from({ length: 22 }, (_, i) => ({ d: addDias(dHoje, -21 + i), n: Math.round(rnd(5, 45)) })), mediaDia: 24.3,
      conferencia: { total: 9, etapas: [['conf_pedido', 'Conferência do pedido', 2], ['conf_coletor', 'No coletor', 3], ['conferido', 'Conferido', 1], ['reconferir', 'Reconferir', 0], ['liberado', 'Liberado hoje', 3]].map(([k, nome, n]) => ({ k, nome, n, notas: Array.from({ length: n }, (_, i) => ({ pedido: String(183600 + i), nome: ['PEPSICO (TESTE)', 'AMBEV (TESTE)', 'NESTLÉ (TESTE)'][i % 3] })) })), reconferirItens: [] } };
  }
  if (nome === 'financeiro') {
    const semIni = semanaIni(dHoje), tot = (n, v) => ({ n, v: r2(v) });
    const bol = (i, dias) => ({ id: 4000 + i, nn: String(5000 + i), parcela: 1, parcelas: 2, emis: addDias(dHoje, -dias - 14), venc: addDias(dHoje, -dias), v: r2(rnd(400, 6000)), nome: C[i % C.length], cnpj: '0000000000' + pad(i), cidade: CID[i % 6], st: 1, banco: 'ITAÚ', dias });
    finBoletos = Array.from({ length: 60 }, (_, i) => bol(i, Math.round(rnd(-40, 70))));
    const venc = finBoletos.filter(b => b.dias > 0), porCli = {}; for (const b of venc) { const c = porCli[b.cnpj] || (porCli[b.cnpj] = { cnpj: b.cnpj, nome: b.nome, cidade: b.cidade, n: 0, v: 0, maisAntigo: b.venc, dias: b.dias }); c.n++; c.v += b.v; if (b.dias > c.dias) { c.dias = b.dias; c.maisAntigo = b.venc; } }
    const dias = []; for (let i = 0; i < 7; i++) { const d = addDias(semIni, i), a = finBoletos.filter(b => b.venc === d); dias.push({ d, n: a.length, v: r2(soma(a)), passado: d < dHoje, ehHoje: d === dHoje }); }
    const sems = []; for (let w = 1; w <= 8; w++) { const a = addDias(semIni, 7 * w), b = addDias(a, 6), s2 = finBoletos.filter(x => x.venc >= a && x.venc <= b); sems.push({ a, b, n: s2.length, v: r2(soma(s2)) }); }
    return { hoje: dHoje, semIni, semFim: addDias(semIni, 6), proxIni: addDias(semIni, 7), ultLiq: addDias(dHoje, -13), abertos: tot(finBoletos.length, soma(finBoletos)), vencidos: { ...tot(venc.length, soma(venc)), clientes: Object.keys(porCli).length }, hojeR: tot(3, 8420.5), semana: tot(48, 131000), proximas: tot(280, 520000),
      aging: [[1, 7, 'até 7 dias'], [8, 30, '8 a 30 dias'], [31, 60, '31 a 60 dias'], [61, 9999, 'mais de 60 dias']].map(([a, b, rotulo]) => { const x = venc.filter(z => z.dias >= a && z.dias <= b); return { rotulo, de: a, ate: b, n: x.length, v: r2(soma(x)) }; }),
      devedores: Object.values(porCli).map(c => ({ ...c, v: r2(c.v) })).sort((a, b) => b.v - a.v), dias, semanas: sems, depois: tot(12, 24000), porVenc: [], liquidadosMes: { n: 90, v: 367344.36, ate: addDias(dHoje, -13) }, emitidosMes: { n: 590, v: 1.53e6 },
      pagar: { hoje: dHoje, semIni, semFim: addDias(semIni, 4), proxIni: addDias(semIni, 7), diaRef: dHoje, fds: false, vencidos: tot(2, 6100), hojeP: tot(11, 120096.63), semana: tot(35, 410000), proximas: tot(140, 1.9e6), linhas: [], categorias: [{ grupo: 4, loja: 10, venc: dHoje, pag: dHoje, n: 9, v: 98000 }, { grupo: 12, loja: 10, venc: dHoje, pag: dHoje, n: 2, v: 22096.63 }, { grupo: 4, loja: 10, venc: addDias(dHoje, 2), pag: addDias(dHoje, 2), n: 20, v: 260000 }, { grupo: 1, loja: 10, venc: addDias(dHoje, 3), pag: addDias(dHoje, 3), n: 4, v: 30000 }, { grupo: 4, loja: 10, venc: addDias(dHoje, 9), pag: addDias(dHoje, 9), n: 100, v: 1.5e6 }, { grupo: 8, loja: 10, venc: addDias(dHoje, 12), pag: addDias(dHoje, 12), n: 40, v: 400000 }], grupos: {} } };
  }
  throw new Error('bloco inválido: ' + nome);
}

module.exports = { init, agendar, calcular, segmento, resumo, demo, notasCliente, boletos, LOJA };
