'use strict';
// lib/painel-compras.js — Painel Compras 2.0 (TV da sala de compras: 4 compradoras + Rodrigo + 1 pessoa da Prevenção).
// Tiago, 27-28/10/2026: sai o Cronograma Mensal (a rotina vira a do Radar), entram Curva A em risco, Avarias por compradora,
// Ranking de produtos com avaria e Rebaixas em acompanhamento (tela do ERP "Autorização Rebaixa de Preço › Acompanhamento",
// loja a loja). Tudo no padrão visual da TV RH/DP. Demo aprovada: claude.ai/artifact/RFNH1jDsa4RE18GuuzNQmY
//
// Este módulo monta UM payload com os dados das 8 telas, reaproveitando as rotas que os painéis antigos já usavam
// (chamadas internas em 127.0.0.1 com o header de aquecimento) e duas consultas novas no ERP (só leitura):
//   avariaconsumo linha a linha (ranking de produtos) e solicitacaopreco + zcupomitens (rebaixas: vendida desde a
//   solicitação, saldo, média/dia → "vai vender a tempo?").
// Cache de 5 min renovado em segundo plano; a TV lê /api/paineis-publico/compras-dados a cada 60 s sem login.
//
// ACHADO 28/10 (dado real): o Radar marca 174 das 215 listas como "fazer hoje" (24 a 47 por compradora). Isso não é
// lista do dia; é o modo sombra ainda sem calibrar (cobertura alvo / gatilho). Na TV, "Pra fazer hoje" = só as
// URGENTES: lista marcada pra hoje E com ruptura ou curva A em risco. As demais contam como "pode esperar".
const LOJAS = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão' };
const LOJAS_CURTO = { 1: 'E1', 2: 'E2', 3: 'E3', 4: 'E4', 5: 'E5', 6: 'E6' };
// compradoras do ERP (nome completo como vem do Radar / margem-tv) → apelido da TV e cor da etiqueta
const COMPRADORAS = [
  { nome: 'ANA KELLY', apelido: 'Kelly', cor: 'c1' },
  { nome: 'STEPHANNY', apelido: 'Stephanny', cor: 'c2' },
  { nome: 'CRISLANE CECILIA', apelido: 'Crislane', cor: 'c3' },
  { nome: 'PATRICIA PEREIRA', apelido: 'Patricia', cor: 'c4' },
  { nome: 'RODRIGO CAHU', apelido: 'Rodrigo', cor: 'c5' },
];
const CACHE_MS = 5 * 60 * 1000;
const POR_CARD = 5;          // listas urgentes por compradora na Central
const PROXIMOS = 2;          // "próximos dias" por compradora
const AVARIA_META_PCT = 1.5; // acima disso a compradora fica em vermelho (Tiago ainda não definiu meta por setor)

let deps = {}, cache = null, montando = null, timer = null;
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hojeLocal = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const diasEntre = (a, b) => Math.round((b - a) / 86400000);
const compradora = nome => COMPRADORAS.find(c => c.nome === String(nome || '').toUpperCase().trim()) || { nome: nome || '—', apelido: nome ? String(nome).split(' ')[0] : '—', cor: 'c0' };

function init(d) {
  deps = d || {};
  clearInterval(timer);
  timer = setInterval(() => montar().catch(e => console.error('[PAINEL-COMPRAS] renovar:', e.message)), CACHE_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => montar().catch(e => console.error('[PAINEL-COMPRAS] 1ª carga:', e.message)), 90 * 1000);   // depois do aquecimento geral
}
async function interno(path, ms = 90000) {
  const r = await fetch((deps.baseUrl || 'http://127.0.0.1:3003') + path, { headers: { 'x-internal-warmup': deps.warmupHeader || 'fc360warmup2026' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
async function tenta(nome, fn) { try { return await fn(); } catch (e) { console.error(`[PAINEL-COMPRAS] ${nome}:`, e.message); return null; } }

// ── 1 · Central de Compras pelo Radar ───────────────────────────────────────────────────────────────────────────
function statusPedido(abertos) {
  // pedidos-fornecedor por lista: o mais recente manda. sugestao/analise = compradora conferindo; aguardando/digitacao =
  // com o vendedor; aprovado/finalizado/recebido = enviado/recebido.
  if (!abertos || !abertos.length) return null;
  const p = [...abertos].sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)))[0];
  const s = p.status;
  if (['aprovado', 'finalizado'].includes(s)) return { st: 'ok', txt: 'Enviado' };
  if (['recebido', 'recebido_parcial'].includes(s)) return { st: 'ok', txt: 'Recebido' };
  if (['sugestao', 'analise'].includes(s)) return { st: 'pendente', txt: 'Em análise' };
  if (['aguardando', 'digitacao'].includes(s)) return { st: 'pendente', txt: 'C/ vendedor' };
  return null;
}
function central(radar, pedidosHoje, curvaA) {
  const lancados = new Set((pedidosHoje && pedidosHoje.concluidos) || []);
  const listas = ((radar && radar.listas) || []).filter(l => l.ok);
  const abertos = (radar && radar.pedidos_abertos) || {};
  const urgente = l => l.fazer_em === 0 && (l.rupturas > 0 || (l.curva_a_risco || []).length > 0);
  const prioridade = l => ((l.curva_a_risco || []).filter(c => c.zera_antes).length * 1000) + (l.curva_a_risco || []).length * 100 + (l.rupturas || 0) * 10 + Math.min(9, l.pedido_valor / 20000);
  const cards = COMPRADORAS.map(c => {
    const minhas = listas.filter(l => String(l.comprador || '').toUpperCase() === c.nome);
    const urg = minhas.filter(urgente).sort((a, b) => prioridade(b) - prioridade(a));
    const linha = l => {
      const sit = lancados.has(l.codFornec) ? { st: 'ok', txt: 'Lançado' } : statusPedido(abertos[l.lista]) || { st: 'apuracao', txt: 'Pendente' };
      const risco = (l.curva_a_risco || []).find(x => x.zera_antes);
      return { lista: l.lista, nome: l.fornecedor || l.nome, valor: r2(l.pedido_valor), rupturas: l.rupturas || 0, curvaA: (l.curva_a_risco || []).length,
        detalhe: risco ? `${risco.descricao} zera em ${risco.cobertura_dias} d` : (l.rupturas ? `${l.rupturas} ruptura${l.rupturas > 1 ? 's' : ''}` : ''), sit, feito: sit.st === 'ok' };
    };
    const hoje = urg.map(linha);
    const feitas = hoje.filter(x => x.feito).length;
    const proximos = minhas.filter(l => l.fazer_em > 0 && l.fazer_em <= 7).sort((a, b) => a.fazer_em - b.fazer_em || prioridade(b) - prioridade(a)).slice(0, PROXIMOS)
      .map(l => ({ lista: l.lista, nome: l.fornecedor || l.nome, quando: `${(l.dow || '').toLowerCase()} ${String(l.data || '').slice(8, 10)}`, curvaA: (l.curva_a_risco || []).length }));
    return { ...c, listasHoje: minhas.filter(l => l.fazer_em === 0).length, urgentes: hoje.length, feitas, pct: hoje.length ? Math.round(feitas * 100 / hoje.length) : null,
      valorUrgente: r2(hoje.reduce((a, x) => a + x.valor, 0)), hoje: hoje.slice(0, POR_CARD), maisHoje: Math.max(0, hoje.length - POR_CARD), proximos };
  });
  const tot = { urgentes: cards.reduce((a, c) => a + c.urgentes, 0), feitas: cards.reduce((a, c) => a + c.feitas, 0), listasHoje: cards.reduce((a, c) => a + c.listasHoje, 0) };
  tot.pct = tot.urgentes ? Math.round(tot.feitas * 100 / tot.urgentes) : null;
  const ranking = cards.filter(c => c.urgentes).sort((a, b) => (b.pct || 0) - (a.pct || 0)).map(c => ({ apelido: c.apelido, pct: c.pct }));
  const alertas = ((curvaA && curvaA.itens) || []).filter(i => i.zera_antes).slice(0, 3)
    .map(i => `${i.descricao} zera em ${i.cobertura_dias} d · ${compradora(i.comprador).apelido} · ${i.lista_nome || ''}`);
  return { cards, tot, ranking, alertas, radarEm: radar && radar.estado ? radar.estado.atualizadoEm : null, teto: radar ? radar.teto : null };
}

// ── 2 · Venda · Margem · Avaria (uma página por compradora) + 3 · Avarias por compradora ───────────────────────
async function margens() {
  const hoje = new Date(); const mes = hoje.getMonth() + 1, ano = hoje.getFullYear();
  const paginas = [];
  for (const c of COMPRADORAS) {
    const m = await tenta('margem ' + c.apelido, () => interno(`/api/margem-tv/comprador?comprador=${encodeURIComponent(c.nome)}&mes=${mes}&ano=${ano}`, 120000));
    if (!m) continue;
    const t = m.totais || {};
    paginas.push({ ...c, totais: { venda: r2(t.venda), msv: t.msv, msc: t.msc, avaria: r2(t.avaria), pctAv: t.venda ? r2(t.avaria * 100 / t.venda) : 0 },
      fornecedores: (m.fornecedores || []).slice(0, 8).map(f => ({ id: f.id, nome: f.nome, venda: r2(f.venda), msv: f.msv, msc: f.msc, avaria: r2(f.avaria), pctAv: f.pct_av })),
      topAvaria: [...(m.fornecedores || [])].sort((a, b) => b.avaria - a.avaria).slice(0, 3).filter(f => f.avaria > 0).map(f => ({ nome: f.nome, avaria: r2(f.avaria) })) });
  }
  const rank = [...paginas].sort((a, b) => b.totais.avaria - a.totais.avaria);
  const totalAvaria = r2(rank.reduce((a, p) => a + p.totais.avaria, 0)), totalVenda = r2(rank.reduce((a, p) => a + p.totais.venda, 0));
  return { mes, ano, paginas, avariaComp: { itens: rank.map(p => ({ apelido: p.apelido, cor: p.cor, nome: p.nome, avaria: p.totais.avaria, venda: p.totais.venda, pctAv: p.totais.pctAv, acima: p.totais.pctAv >= AVARIA_META_PCT, top: p.topAvaria })),
    totalAvaria, totalVenda, pctRede: totalVenda ? r2(totalAvaria * 100 / totalVenda) : 0, meta: AVARIA_META_PCT } };
}

// ── 4 · Rupturas por compradora (lista a lista) ────────────────────────────────────────────────────────────────
function rupturas(rup, porComp) {
  const dona = {};
  for (const [nome, listas] of Object.entries(porComp || {})) for (const l of listas || []) dona[l.id] = nome;
  const linhas = ((rup && rup.ranking_fornec) || []).map(f => ({ lista: f.listaId, nome: f.fornecedor, rupturas: f.rupturas || 0, urgencia: f.urgencia || 0, emRisco: f.em_risco || 0, perda: r2(f.perda || 0),
    lojas: String(f.lojas || '').split(',').map(s => s.trim()).filter(Boolean).map(n => ({ CAHU: 'E1', MURIBECA: 'E2', PONTE: 'E3', ATACAREJO: 'E4', 'PORTA LARGA': 'E5', 'JARDIM JORDÃO': 'E6' })[n] || n),
    comp: compradora(dona[f.listaId]), sit: (f.urgencia || 0) >= 3 ? 'critico' : (f.urgencia || 0) > 0 ? 'atencao' : 'normal' }))
    .filter(l => l.rupturas > 0).sort((a, b) => b.urgencia - a.urgencia || b.rupturas - a.rupturas);
  const r = (rup && rup.resumo) || {};
  return { resumo: { rupturas: r.total_rupturas || 0, urgencia: r.urgencia || 0, emRisco: r.em_risco || 0, listas: linhas.length, perdaDia: r2(r.perdaDia || 0) }, linhas: linhas.slice(0, 45), geradoEm: rup && rup.gerado_em };
}

// ── 5 · Curva A em risco ──────────────────────────────────────────────────────────────────────────────────────
function curvaA(ca, pedidosHoje) {
  const lancados = new Set((pedidosHoje && pedidosHoje.concluidos) || []);
  const itens = ((ca && ca.itens) || []).map(i => {
    const lojasZ = (i.lojas_zeradas || []).map(z => LOJAS_CURTO[z.loja] || z.loja);
    const puxam = Object.entries(i.lojas_det || {}).filter(([, d]) => d.cobertura_dias != null && d.cobertura_dias <= (i.ponto || 0)).map(([l]) => LOJAS_CURTO[l] || l);
    let acao;
    if (i.transito > 0) acao = { st: 'ok', txt: 'Em trânsito' };
    else if (i.acao === 'transferir') acao = { st: 'pendente', txt: 'Transferir ' + (lojasZ.join(' ') || '') };
    else if (i.zera_antes) acao = { st: 'atraso', txt: i.fazer_em === 0 ? 'Pedir hoje' : `Antecipar · lista ${i.dow ? i.dow.toLowerCase() : ''} ${String(i.data || '').slice(8, 10)}` };
    else acao = { st: 'pendente', txt: i.fazer_em === 0 ? 'No ponto · pedir hoje' : `No ponto · lista ${String(i.data || '').slice(8, 10)}/${String(i.data || '').slice(5, 7)}` };
    return { cod: i.cod, descricao: i.descricao, rank: i.rank, comp: compradora(i.comprador), lista: i.lista, listaNome: i.lista_nome, fornecedor: i.fornecedor, cobertura: i.cobertura_dias, zeraAntes: !!i.zera_antes, noPonto: !!i.no_ponto,
      lojas: (lojasZ.length ? lojasZ : puxam).slice(0, 4), zeradas: lojasZ.length, vendaDia: r2(i.venda_dia_valor || 0), transito: i.transito || 0, acao };
  }).sort((a, b) => (b.zeraAntes - a.zeraAntes) || a.cobertura - b.cobertura);
  const r = (ca && ca.resumo) || {};
  return { resumo: { emRisco: r.em_risco || 0, zeram: itens.filter(i => i.zeraAntes).length, noPonto: itens.filter(i => !i.zeraAntes).length, vendaDia: r2(itens.reduce((a, i) => a + i.vendaDia, 0)), transito: itens.filter(i => i.transito > 0).length, comprar: r.comprar || 0, transferir: r.transferir || 0 }, itens: itens.slice(0, 27) };
}

// ── 6 · A Pagar × Venda ───────────────────────────────────────────────────────────────────────────────────────
function pagar(pv) {
  const lojas = ((pv && pv.por_loja) || []).map(l => ({ loja: l.loja, nome: LOJAS[l.loja] || ('Loja ' + l.loja), aPagar: r2(l.a_pagar), venda: r2(l.venda_total), pct: l.pct, faixa: l.pct == null ? '' : l.pct >= 70 ? 'vm' : l.pct > 50 ? 'ama' : '' }));
  const t = (pv && pv.totais) || {};
  const maior = [...lojas].sort((a, b) => (b.pct || 0) - (a.pct || 0))[0], menor = [...lojas].sort((a, b) => (a.pct || 0) - (b.pct || 0))[0];
  return { lojas, rede: t.pct, aPagar: r2(t.a_pagar || 0), venda: r2(t.venda_total || 0), mes: pv && pv.nome_mes, vendaLabel: pv && pv.venda_media_label, maior, menor };
}

// ── 7 · Ranking de produtos com avaria (central.avariaconsumo linha a linha) ───────────────────────────────────
async function avariaProdutos(radar) {
  const q = deps.q; if (!q) return null;
  const h = hojeLocal(); const ini = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-01`; const fim = iso(h);
  const mesAnt = n => { const d = new Date(h.getFullYear(), h.getMonth() - n, 1); const f = new Date(h.getFullYear(), h.getMonth() - n + 1, 0); return [iso(d), iso(f)]; };
  const where = `Tipo=1 AND Status IN (0,3,4) AND DataLan BETWEEN ? AND ?`;
  const [top, setores, lojas, tot] = await Promise.all([
    q(`SELECT CodigoBarras cod, MAX(Descricao) descricao, MAX(Dn1) setor, SUM(Qtd) qtd, MAX(Und) und, SUM(Total) total, GROUP_CONCAT(DISTINCT nLoja ORDER BY nLoja) lojas, MAX(CodFornec) codFornec
         FROM central.avariaconsumo WHERE ${where} GROUP BY CodigoBarras ORDER BY total DESC LIMIT 12`, [ini, fim]),
    q(`SELECT COALESCE(NULLIF(TRIM(Dn1),''),'SEM SETOR') setor, SUM(Total) total FROM central.avariaconsumo WHERE ${where} GROUP BY setor ORDER BY total DESC LIMIT 6`, [ini, fim]),
    q(`SELECT nLoja loja, SUM(Total) total, COUNT(*) n FROM central.avariaconsumo WHERE ${where} GROUP BY nLoja ORDER BY total DESC`, [ini, fim]),
    q(`SELECT SUM(Total) total, SUM(CASE WHEN Status IN (0,3) THEN Total ELSE 0 END) aberto, COUNT(*) n FROM central.avariaconsumo WHERE ${where}`, [ini, fim]),
  ]);
  // crônico = no top 10 dos dois meses anteriores também
  const cronicos = new Set();
  try {
    const [a1, a2] = await Promise.all([mesAnt(1), mesAnt(2)].map(([i, f]) => q(`SELECT CodigoBarras cod FROM central.avariaconsumo WHERE ${where} GROUP BY CodigoBarras ORDER BY SUM(Total) DESC LIMIT 10`, [i, f])));
    const s1 = new Set(a1.map(r => r.cod)), s2 = new Set(a2.map(r => r.cod));
    for (const r of top) if (s1.has(r.cod) && s2.has(r.cod)) cronicos.add(r.cod);
  } catch (e) { console.error('[PAINEL-COMPRAS] avaria crônico:', e.message); }
  const donoForn = {};
  for (const l of (radar && radar.listas) || []) if (l.codFornec && l.comprador && !donoForn[l.codFornec]) donoForn[l.codFornec] = l.comprador;
  const total = num(tot[0] && tot[0].total);
  const itens = top.map((r, i) => ({ pos: i + 1, cod: r.cod, descricao: String(r.descricao || '').trim(), setor: String(r.setor || '').trim(), qtd: r2(num(r.qtd)), und: r.und || '', total: r2(num(r.total)),
    lojas: String(r.lojas && r.lojas.type === 'Buffer' ? Buffer.from(r.lojas.data).toString() : Buffer.isBuffer(r.lojas) ? r.lojas.toString() : (r.lojas || '')).split(',').filter(Boolean).map(n => LOJAS_CURTO[n] || n), comp: donoForn[r.codFornec] ? compradora(donoForn[r.codFornec]) : null, cronico: cronicos.has(r.cod) }));
  return { periodo: { de: ini, ate: fim }, total: r2(total), aberto: r2(num(tot[0] && tot[0].aberto)), lancamentos: tot[0] ? tot[0].n : 0, top10: r2(itens.slice(0, 10).reduce((a, x) => a + x.total, 0)), itens,
    setores: setores.map(s => ({ setor: s.setor, total: r2(num(s.total)), pct: total ? Math.round(num(s.total) * 100 / total) : 0 })),
    lojas: lojas.map(l => ({ loja: l.loja, nome: LOJAS[l.loja] || ('Loja ' + l.loja), total: r2(num(l.total)), n: l.n })) };
}

// ── 8 · Rebaixas em acompanhamento (solicitacaopreco Status=1, validade ainda não vencida) · loja a loja ──────
async function rebaixas() {
  const q = deps.q; if (!q) return null;
  const h = hojeLocal(); const hojeStr = iso(h);
  const rows = await q(`SELECT nLoja loja, CodigoBarra cod, MAX(Descricao) descricao, MAX(PrecoAtual) precoAtual, MAX(PrecoSolicitado) precoSol, MIN(DataSolicitacao) solicitadoEm, SUM(Qtd) qtd, MIN(Validade) validade, MAX(Motivo) motivo, COUNT(*) n
     FROM central.solicitacaopreco WHERE Status=1 AND Validade >= ? AND DataSolicitacao >= DATE_SUB(?, INTERVAL 45 DAY) AND nLoja BETWEEN 1 AND 6
     GROUP BY nLoja, CodigoBarra`, [hojeStr, hojeStr]);
  const porLoja = {};
  for (const r of rows) (porLoja[r.loja] = porLoja[r.loja] || []).push(r);
  const mesDb = d => `mes${String(d.getMonth() + 1).padStart(2, '0')}`;
  const dbs = [mesDb(h), mesDb(new Date(h.getFullYear(), h.getMonth() - 1, 1))];
  const lojas = [];
  for (const loja of [1, 2, 3, 4, 5, 6]) {
    const itens = porLoja[loja] || [];
    const vendas = {};   // cod → [{data, qtd}]
    if (itens.length) {
      const cods = [...new Set(itens.map(i => String(i.cod)))];
      const minData = iso(new Date(Math.min(...itens.map(i => new Date(i.solicitadoEm)))));
      for (const db of dbs) {
        try {
          const vr = await q(`SELECT Codigo cod, Data data, SUM(QtdNovo) qtd FROM \`ln${loja}${db}\`.zcupomitens WHERE IndCancel='N' AND Data >= ? AND Codigo IN (${cods.map(() => '?').join(',')}) GROUP BY Codigo, Data`, [minData, ...cods]);
          for (const v of vr) (vendas[v.cod] = vendas[v.cod] || []).push({ data: iso(new Date(v.data)), qtd: num(v.qtd) });
        } catch (e) { if (!/doesn't exist/.test(e.message)) console.error(`[PAINEL-COMPRAS] rebaixas loja ${loja} ${db}:`, e.message); }
      }
    }
    const linhas = itens.map(i => {
      const sol = new Date(i.solicitadoEm); sol.setHours(0, 0, 0, 0);
      const val = new Date(i.validade); val.setHours(0, 0, 0, 0);
      const diasReais = diasEntre(sol, h); const diasDesde = Math.max(1, diasReais); const diasAte = diasEntre(h, val);
      const vendida = (vendas[String(i.cod)] || []).filter(v => v.data >= iso(sol)).reduce((a, v) => a + v.qtd, 0);
      const qtd = num(i.qtd); const saldo = Math.max(0, qtd - vendida); const medDia = vendida / diasDesde;
      const vendeAte = medDia * Math.max(0, diasAte);
      const preco = num(i.precoSol) > 0 ? num(i.precoSol) : num(i.precoAtual);
      let sit;
      if (saldo <= 0) sit = { st: 'ok', txt: 'Vendeu tudo' };
      else if (diasReais <= 1 && vendida === 0) sit = { st: 'apuracao', txt: 'Rebaixa de ' + (diasReais === 0 ? 'hoje' : 'ontem') + ' · sem venda ainda' };
      else if (medDia <= 0) sit = { st: 'atraso', txt: `Não · sem venda · sobram ${Math.round(saldo)}` };
      else if (vendeAte >= saldo) sit = { st: 'ok', txt: `Sim · zera em ${Math.ceil(saldo / medDia)} d` };
      else if (saldo - vendeAte <= Math.max(2, qtd * 0.1)) sit = { st: 'pendente', txt: `Quase · sobram ${Math.round(saldo - vendeAte)}` };
      else sit = { st: 'atraso', txt: `Não · vende ${Math.round(vendeAte)}, sobram ${Math.round(saldo - vendeAte)}` };
      return { cod: String(i.cod), descricao: String(i.descricao || '').trim(), solicitadoEm: iso(sol), validade: iso(val), diasAte, qtd: r2(qtd), vendida: r2(vendida), saldo: r2(saldo), medDia: r2(medDia), preco: r2(preco), saldoRs: r2(saldo * preco),
        desconto: num(i.precoSol) > 0 && num(i.precoAtual) > 0 ? Math.round((1 - num(i.precoSol) / num(i.precoAtual)) * 100) : null, sit, ruim: sit.st === 'atraso' };   // recém-pedida não conta como ruim
    }).sort((a, b) => (b.ruim - a.ruim) || b.saldoRs - a.saldoRs || a.diasAte - b.diasAte);   // o que tem mais R$ parado e não vai vender primeiro
    lojas.push({ loja, nome: LOJAS[loja], itens: linhas.length, saldoRs: r2(linhas.reduce((a, l) => a + l.saldoRs, 0)), vencem7: linhas.filter(l => l.diasAte <= 7).length, ruins: linhas.filter(l => l.ruim).length, ruinsRs: r2(linhas.filter(l => l.ruim).reduce((a, l) => a + l.saldoRs, 0)), linhas: linhas.slice(0, 9) });
  }
  return { lojas, rede: { itens: lojas.reduce((a, l) => a + l.itens, 0), ruins: lojas.reduce((a, l) => a + l.ruins, 0), semRebaixa: lojas.filter(l => !l.itens).map(l => LOJAS_CURTO[l.loja]) } };
}

// ── montagem ──────────────────────────────────────────────────────────────────────────────────────────────────
async function montar() {
  if (montando) return montando;
  montando = (async () => {
    const t0 = Date.now();
    const [radar, pedidosHoje, ca, rup, porComp, pv] = await Promise.all([
      tenta('radar', () => interno('/api/radar-pedidos', 150000)), tenta('pedidos-hoje', () => interno('/api/compras/pedidos-hoje')),
      tenta('curva-a', () => interno('/api/radar-pedidos/curva-a')), tenta('ruptura', () => interno('/api/ruptura', 150000)),
      tenta('comprador-listas', () => interno('/api/ruptura/comprador-listas?detalhe=1')), tenta('pagar-venda', () => interno('/api/pagar-venda')),
    ]);
    const [mg, avProd, reb] = await Promise.all([tenta('margens', margens), tenta('avaria-produtos', () => avariaProdutos(radar)), tenta('rebaixas', rebaixas)]);
    const novo = {
      geradoEm: new Date().toISOString(), duracaoMs: Date.now() - t0, compradoras: COMPRADORAS, lojas: LOJAS,
      central: radar ? central(radar, pedidosHoje, ca) : null,
      margem: mg ? { mes: mg.mes, ano: mg.ano, paginas: mg.paginas } : null,
      avariaComp: mg ? mg.avariaComp : null,
      rupturas: rup ? rupturas(rup, porComp) : null,
      curvaA: ca ? curvaA(ca, pedidosHoje) : null,
      pagar: pv ? pagar(pv) : null,
      avariaProd: avProd, rebaixas: reb,
      fontes: { radar: radar && radar.estado ? radar.estado.atualizadoEm : null, ruptura: rup && rup.gerado_em, pedidosHoje: pedidosHoje && pedidosHoje.data },
    };
    // tela sem dado novo mantém o que tinha (ERP fora, rota lenta): nunca apaga uma tela por erro de um minuto
    if (cache) for (const k of ['central', 'margem', 'avariaComp', 'rupturas', 'curvaA', 'pagar', 'avariaProd', 'rebaixas']) if (novo[k] == null && cache[k] != null) { novo[k] = cache[k]; novo[k + 'Velho'] = true; }
    cache = novo;
    console.log(`[PAINEL-COMPRAS] payload montado em ${Math.round(novo.duracaoMs / 1000)} s`);
    return cache;
  })().finally(() => { montando = null; });
  return montando;
}
async function dados() {
  if (cache) { if (Date.now() - new Date(cache.geradoEm).getTime() > CACHE_MS * 1.5) montar().catch(() => {}); return cache; }
  return montar();
}
function estado() { return { cache: !!cache, geradoEm: cache ? cache.geradoEm : null, montando: !!montando }; }

module.exports = { init, dados, montar, estado, COMPRADORAS, LOJAS };
