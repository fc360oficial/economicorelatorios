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
//   fazer a lista   = dia em que 10% da venda (R$) cruza o ponto de pedido (risco ponderado),
//                     ou dia em que um produto de curva A vai faltar — o que vier primeiro
//   piso do pedido  = consumo de 1 ciclo; teto = (alvo + ciclo) × venda/dia
//   estoque acima do alvo NÃO gera pedido de redução — só "deixa descer".
//
// SOMENTE LEITURA no ERP. O único estado gravado fica em data/radar-sombra/
// (um JSON por dia com o que o sistema pediria — a Fase 0 compara isso com
// o que as compradores(as) pediram de fato).
const fs = require('fs');
const path = require('path');
const { corteAxml } = require('./axml-corte');

const SOMBRA_DIR = path.join(__dirname, '..', 'data', 'radar-sombra');
// listas já vistas pelo radar: { nReg: primeiraVezISO } — lista que aparece pela 1ª vez fica "LISTA NOVA" por 24 h
const VISTAS_PATH = path.join(__dirname, '..', 'data', 'radar-listas-vistas.json');
const NOVA_HORAS = 24;
// itens já vistos em cada lista: { "lista|cod": primeiraVezISO } — item que ENTRA numa lista fica "ITEM NOVO" por 7 dias (Tiago, 01/10/26)
const ITENS_VISTOS_PATH = path.join(__dirname, '..', 'data', 'radar-itens-vistos.json');
const NOVO_ITEM_HORAS = 24 * 7;
const LOJAS = [1, 2, 3, 4, 5, 6];
const DOW = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];
const TETO_PADRAO = 28;
const FRACAO_VALIDADE = 0.6;
// Gatilho da lista (risco ponderado, 11/09/2026): a lista e feita no dia em que os produtos que
// VAO FALTAR (cruzam o ponto de pedido) somam 10% da venda em R$ da lista. Antes era 25% e um
// lider sobrando (84 d) escondia itens zerados. Combinado com o gatilho por produto de curva A.
const FRACAO_VENDA_GATILHO = 0.20;   // Tiago, 24/09: gatilho padrão 20% da venda da lista na loja (era 10% na rede somada)
const LOJAS_RADAR = [1, 2, 3, 4, 5, 6];
const JANELA_VENDA_DIAS = 40;
const JANELA_LEAD_MESES = 12;
const EMB_HIST_MESES_MAX = 36;   // quanto de histórico de embalagem fica em memória (Tiago pediu 36 em 14/09/2026)
const EMB_HIST_MESES_PADRAO = 36; // janela default usada pra decidir a embalagem real
// Curva A = produtos que somam os primeiros 50% da venda em R$ (≈400 produtos no Econômico).
// Um produto A que vai ZERAR antes do dia previsto da lista antecipa a lista (gatilho por produto).
const CURVA_A_FRACAO = 0.5;
const VENDA_MIN_LOJA_ZERADA = 1;
const MARGEM_PONTO_A = 1;        // dias: produto A com cobertura ate ponto+1 ja conta como em risco // un/dia: loja zerada só conta como risco se o produto vende pelo menos isso lá

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
// Caixa padrão descoberta sob demanda (botão "Buscar caixa padrão" na Cotação, lib/emb-padrao.js →
// data/emb-padrao.json) e correção manual da Lista de Compra (data/unidade-embalagem-overrides.json).
// Ordem: vínculo do CD > manual > notas do fornecedor da lista (janela) > padrão descoberto > cadastro.
let embPadrao = {}, embManual = {}, embCarregado = false, embRegras = [];
// Regras de caixa por descrição (data/emb-regras.json, no git): [{ match: regex, emb }]. Ex.: todo FRISCO 18G = 180.
function embRegra(descricao) { const d = String(descricao || '').toUpperCase(); for (const r of embRegras) if (r.re.test(d)) return r.emb; return null; }
function recarregarEmbPadrao() {
  embCarregado = true;
  try { embRegras = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'emb-regras.json'), 'utf8')).filter(r => r && r.match && +r.emb >= 1).map(r => ({ re: new RegExp(r.match, 'i'), emb: +r.emb })); } catch (e) { embRegras = []; }
  try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'emb-padrao.json'), 'utf8')); embPadrao = {}; for (const [c, v] of Object.entries(j)) if (v && +v.emb >= 1) embPadrao[c] = { emb: +v.emb, fonte: v.fonte || null }; } catch (e) { embPadrao = {}; }
  try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'unidade-embalagem-overrides.json'), 'utf8')); embManual = {}; for (const [c, v] of Object.entries(j)) { const e = parseFloat(String(v?.embalagem ?? '').replace(',', '.')); if (e >= 1) embManual[c] = e; } } catch (e) { embManual = {}; }
}
function embEfetiva(p, meses) {
  if (p.embFixa >= 1) return p.embFixa;   // Pedidos do CD: un/cx do vínculo, sem olhar histórico de notas
  if (!embCarregado) recarregarEmbPadrao();
  if (embManual[p.cod] >= 1) return embManual[p.cod];
  const rg = embRegra(p.descricao); if (rg) return rg;
  const h = embCompra(p.cod, meses, base?.listas?.[p.lista]?.codFornec || 0);
  if (h && h >= 1) return h;
  if (meses && embPadrao[p.cod]) return embPadrao[p.cod].emb;
  return p.emb;
}

let deps = null;           // { q, mesDB, getNregsComprador }
let estado = { status: 'vazio', atualizadoEm: null, erro: null, duracaoMs: 0 };
let base = null;           // { hoje, dias, listas:{}, prods:[], transito:{} }
let leadCache = null;      // { calculadoEm, porLista:{} } — pesado, 24h
// Histórico de 12 meses de venda por produto × loja × mês (pesado, 1×/dia). Usado pra:
//   1) loja sem venda nos 40 dias → usa a média dos 12 meses daquela loja (regra do Tiago, 14/09/2026)
//   2) sazonalidade: compara o mês que vem (ano passado) com o mês atual (ano passado) e ajusta a venda/dia
let hist12Cache = null;    // { calculadoEm, mensal: { 'cod|loja': { 'YYYY-MM': { qtd, valor } } } }
// Versão de 2 ANOS (aprovada pelo Tiago em 14/09/2026). A 1ª versão (12 m, mês-a-mês) foi descartada no teste real:
// pegava promoção como se fosse estação (escova dental ×3) e levou HOJE de 39 pra 100 listas.
//   - histórico de 24 meses por produto×loja×mês em CACHE EM DISCO, recalculado 1×/dia (05:30) em segundo plano
//   - SAZONAL: o mês que vem tem que se destacar nos DOIS anos (≥1,5× a média do ano OU ≤0,67×), fator = média dos
//     dois anos de (mês alvo ÷ mês atual), limitado a 0,5–2,0; precisa de ≥30 un no mês-base dos dois anos
//   - LOJA SEM VENDA nos 40 d: média dos últimos 6 meses daquela loja, só se vendeu em ≥3 desses meses (ruptura recente),
//     nunca acima da média das outras lojas. Teste 14/09: com 24 m eram 7.780 loja×produto e HOJE ia a R$ 566 mil.
const HIST_ATIVO = true;
const HIST_MESES = 24;
// Histórico de VIDA (Tiago, 05/10/26: "puxa o histórico total de vida do produto, desde a primeira entrada até hoje; só assim você
// encontra uma maneira de sugerir o item" — vale pra todos os itens): além dos 24 meses, o cache guarda os meses mais antigos de
// cada produto×loja. Mês fechado não muda: é puxado UMA vez (lotes pequenos, a tabela mensal guarda todos os anos) e reaproveitado.
const HIST_VIDA = true, HIST_VIDA_LOTE = 200;
const RUPTURA_FRACAO = 0.25;   // ruptura parcial: venda dos 40 d abaixo de 25% do ritmo de vida da loja → usa o ritmo de vida
const RUPTURA_EST_DIAS = 7;    // ruptura parcial só com a loja quase sem estoque: menos de 7 dias de estoque+trânsito no ritmo de vida (06/10: 8.265 marcados sem essa guarda)
const VIDA_RECENCIA_MESES = 12; // a última venda tem que ter sido nos últimos 12 meses: item parado há mais de um ano é descontinuado, não ruptura (segue a regra normal)
const VIDA_SPAN_MESES = 12;    // os 6 meses com venda usados no ritmo de vida têm que caber em 12 meses corridos: item que vende 1 un a cada 3 meses não é ruptura, é giro baixo (06/10: 1ª rodada marcou 10.469 loja×item)
const HIST_PATH = path.join(__dirname, '..', 'data', 'radar-hist24.json');
const BASE_PATH = path.join(__dirname, '..', 'data', 'radar-base.json');   // último cálculo completo (base + lead), pra subir já pronto depois de um deploy
const SAZONAL_MIN_UN = 30;
const SAZONAL_ALTA = 1.5, SAZONAL_BAIXA = 0.67, SAZONAL_FATOR_MAX = 2.0, SAZONAL_FATOR_MIN = 0.5;
const FALLBACK_MIN_MESES = 3;   // a loja precisa ter vendido o produto em ≥3 dos últimos 6 meses (ruptura recente, não sortimento antigo)
const FALLBACK_JANELA_MESES = 6;
const ym = d => d.toISOString().slice(0, 7);
function carregarHist() { try { hist12Cache = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); } catch (e) { hist12Cache = null; } }
function salvarHist() { try { fs.writeFileSync(HIST_PATH, JSON.stringify(hist12Cache)); } catch (e) { console.error('[RADAR] hist24 salvar:', e.message); } }
let histAtualizando = null;
// recalcula o histórico em segundo plano e, quando termina, refaz a base (lead fica em cache, ~100 s)
function atualizarHistEmSegundoPlano(codes, hoje) {
  if (histAtualizando) return histAtualizando;
  histAtualizando = (async () => {
    try { console.log('[RADAR] histórico 24 meses em segundo plano…'); const t0 = Date.now(); hist12Cache = await calcularHist12(codes, hoje, hist12Cache); salvarHist(); console.log(`[RADAR] hist24 ok em ${Math.round((Date.now() - t0) / 1000)}s`); await recalcular(false); }
    catch (e) { console.error('[RADAR] hist24:', e.message); }
    finally { histAtualizando = null; }
  })();
  return histAtualizando;
}
let recalculando = null;

const iso = d => d.toISOString().slice(0, 10);
const addDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const dd = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
// aceita "1234.5", "1234,5" e formato pt-BR "1.000,00" (PedidoMinimo do ERP vem assim)
const num = v => { let s = String(v ?? '0').trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : 0; };
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

function init(d) {
  deps = d;
  fs.mkdirSync(SOMBRA_DIR, { recursive: true });
  carregarBase();
}
// Depois de um deploy o servidor reinicia e o Radar levava minutos calculando; nesse intervalo a Nova Cotação
// não achava a lista ('Radar ainda calculando'). Agora o último cálculo fica em disco e sobe na hora (Tiago, 21/09).
function salvarBase() {
  try { fs.writeFileSync(BASE_PATH, JSON.stringify({ base, leadCache, estado, salvoEm: new Date().toISOString() })); } catch (e) { console.error('[RADAR] salvar base:', e.message); }
}
function carregarBase() {
  try {
    if (!fs.existsSync(BASE_PATH)) return;
    const s = JSON.parse(fs.readFileSync(BASE_PATH, 'utf8'));
    if (!s.base || !s.base.hoje || !Array.isArray(s.base.prods) || dd(iso(new Date()), s.base.hoje) > 3) { console.log('[RADAR] base em disco velha/inválida, ignorada'); return; }
    base = s.base; leadCache = s.leadCache || leadCache;
    estado = { ...(s.estado || {}), status: 'ok', erro: null, deCache: true, salvoEm: s.salvoEm || null };
    console.log('[RADAR] base carregada do disco (' + s.base.hoje + ', ' + s.base.prods.length + ' produtos) — recalcula em seguida');
  } catch (e) { console.error('[RADAR] carregar base:', e.message); }
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
  if (!sugs.length) return { calculadoEm: hoje, porLista: {}, porFornec: {}, porItem: {}, rede: null };

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

  // LEAD DO ITEM (Tiago, 01/10/26: "vai pelo lead da lista e pelo lead do item"): produto a produto, em QUALQUER lista —
  // pedido fechado que tinha o produto (pedidocompraproduto, central + backup) → 1ª entrada desse produto na loja
  // (compraprodutos) até 60 d depois. Intervalo do item = média entre as datas de entrada do produto na mesma loja (12 m).
  // Só produtos que estão em alguma lista de compra (os outros não entram no Radar).
  const prodPed = {};   // nReg → Set(cod)
  for (const c of chunk(nRegs, 3000)) {
    const ph = c.map(() => '?').join(',');
    for (const db of ['central', 'backup_central']) {
      try { for (const x of await q(`SELECT nPedido, CodigoBarra cod FROM ${db}.pedidocompraproduto WHERE nPedido IN (${ph})`, c)) (prodPed[x.nPedido] = prodPed[x.nPedido] || new Set()).add(String(x.cod).trim()); }
      catch (e) { console.error('[RADAR] lead do item (' + db + '):', e.message); }
    }
  }
  const entradas = {};   // cod|loja → [datas de entrada, ordenadas]
  try {
    const codsLista = (await q(`SELECT DISTINCT Codigobarra cod FROM central.c_cotacao_lista_itens`)).map(r => String(r.cod).trim()).filter(Boolean);
    for (const c of chunk(codsLista, 4000)) {
      const er = await q(`SELECT CodigoBarra cod, nLoja, DATE_FORMAT(DataEntrada,'%Y-%m-%d') d FROM central.compraprodutos
                          WHERE Movimentacao='COMPRA' AND DataEntrada>=? AND CodigoBarra IN (${c.map(() => '?').join(',')})
                          GROUP BY CodigoBarra, nLoja, DataEntrada`, [dIni, ...c]);
      for (const x of er) { const k = `${String(x.cod).trim()}|${x.nLoja}`; (entradas[k] = entradas[k] || []).push(x.d); }
    }
    for (const k of Object.keys(entradas)) entradas[k].sort();
  } catch (e) { console.error('[RADAR] entradas por item:', e.message); }

  const porLista = {}, porFornec = {}, porItem = {};
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
    // FORNECEDOR: mesma conta juntando todas as listas dele (lista nova do fornecedor herda o lead das outras)
    const F = porFornec[s.CodFornec] || (porFornec[s.CodFornec] = { leads: [], datas: {}, listas: new Set() });
    if (dt) F.leads.push(Math.max(0, dd(dt, s.dp)));
    (F.datas[s.nLoja] = F.datas[s.nLoja] || new Set()).add(s.dp); F.listas.add(s.nLista);
    // ITEM: 1ª entrada do produto na loja depois do pedido (até 60 d)
    for (const cod of prodPed[s.nReg] || []) {
      const ds = entradas[`${cod}|${s.nLoja}`]; if (!ds) continue;
      const d = ds.find(x => dd(x, s.dp) >= -1 && dd(x, s.dp) <= 60); if (!d) continue;
      (porItem[cod] = porItem[cod] || { leads: [] }).leads.push(Math.max(0, dd(d, s.dp)));
    }
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
  const gapsDe = datas => { const g = []; for (const set of Object.values(datas)) { const ds = [...set].sort(); for (let i = 1; i < ds.length; i++) g.push(dd(ds[i], ds[i - 1])); } return g; };
  const outF = {};
  for (const [cf, F] of Object.entries(porFornec)) { const g = gapsDe(F.datas); outF[cf] = { listas: F.listas.size, entregues: F.leads.length, lead_medio: F.leads.length ? +avg(F.leads).toFixed(1) : null, lead_max: F.leads.length ? Math.max(...F.leads) : null, intervalo: g.length ? +avg(g).toFixed(1) : null }; }
  // item: lead = média (pedido → entrada) do produto; intervalo = média entre entradas do produto na mesma loja (vale mesmo sem pedido ligado)
  const gapsItem = {};
  for (const [k, ds] of Object.entries(entradas)) { const cod = k.split('|')[0]; for (let i = 1; i < ds.length; i++) (gapsItem[cod] = gapsItem[cod] || []).push(dd(ds[i], ds[i - 1])); }
  const outI = {};
  for (const cod of new Set([...Object.keys(porItem), ...Object.keys(gapsItem)])) {
    const I = porItem[cod], g = gapsItem[cod] || [];
    outI[cod] = { entregues: I ? I.leads.length : 0, lead_medio: I && I.leads.length ? +avg(I.leads).toFixed(1) : null, lead_max: I && I.leads.length ? Math.max(...I.leads) : null, intervalo: g.length ? +avg(g).toFixed(1) : null };
  }
  // rede: mediana das listas com histórico — último recurso de lista e fornecedor sem nenhum pedido fechado
  const med = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const vals = Object.values(out);
  const rede = vals.length ? { listas: vals.length, lead_medio: med(vals.map(x => x.lead_medio)), lead_max: med(vals.map(x => x.lead_max)), intervalo: med(vals.map(x => x.intervalo)) } : null;
  console.log(`[RADAR] lead: ${Object.keys(out).length} listas, ${Object.keys(outF).length} fornecedores, ${Object.keys(outI).length} itens com histórico; rede ${rede ? rede.lead_medio + ' d' : '—'}`);
  return { calculadoEm: hoje, porLista: out, porFornec: outF, porItem: outI, rede };
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
  // LISTA NOVA: a 1ª vez que uma lista aparece no cadastro fica marcada por 24 h. Na 1ª execução (arquivo não existe)
  // todas entram como antigas, senão tudo viraria "nova" de uma vez.
  let vistas = null; try { vistas = JSON.parse(fs.readFileSync(VISTAS_PATH, 'utf8')); } catch (e) {}
  const agoraISO = new Date().toISOString(); const primeira = !vistas; vistas = vistas || {}; let mudouVistas = false;
  for (const l of cad) if (!vistas[l.nReg]) { vistas[l.nReg] = primeira ? 'antiga' : agoraISO; mudouVistas = true; }
  if (mudouVistas) { try { fs.writeFileSync(VISTAS_PATH, JSON.stringify(vistas)); } catch (e) { console.error('[RADAR] listas vistas:', e.message); } }
  const novaAte = t => { if (!t || t === 'antiga') return null; const fim = new Date(t).getTime() + NOVA_HORAS * 3600e3; return fim > Date.now() ? new Date(fim).toISOString() : null; };
  for (const l of cad) listas[l.nReg] = { lista: l.nReg, nome: l.nome, fornecedor: l.fornecedor, codFornec: l.CodFornec, pedidoMinimo: num(l.PedidoMinimo), comprador: compradorPorLista[l.nReg] || null, nova_ate: novaAte(vistas[l.nReg]), vista_em: vistas[l.nReg] === 'antiga' ? null : vistas[l.nReg] };

  const itens = await q(`
    SELECT i.nCotacao nLista, i.Codigobarra cod, TRIM(it.Descricao) descricao, TRIM(it.Unid) unid, it.qtdemb emb, it.Validar validade,
           i.l1,i.l2,i.l3,i.l4,i.l5,i.l6
    FROM central.c_cotacao_lista_itens i JOIN central.itens it ON it.CodigoBarra=i.Codigobarra
    WHERE it.CodDesativado=0`);
  const codes = [...new Set(itens.map(r => r.cod))];
  // ITEM NOVO (Tiago, 01/10/26): item que ENTRA numa lista fica marcado por 7 dias. Mesma regra da LISTA NOVA: na 1ª execução
  // (arquivo não existe) todos entram como antigos; item que sai da lista é esquecido (se voltar, conta como novo de novo).
  // Lista nova inteira não marca item a item (ela já leva LISTA NOVA).
  let vistosI = null; try { vistosI = JSON.parse(fs.readFileSync(ITENS_VISTOS_PATH, 'utf8')); } catch (e) {}
  const primeiraI = !vistosI, vistosNovo = {}; let mudouI = primeiraI;
  for (const it of itens) { const k = it.nLista + '|' + it.cod; if (vistosI && vistosI[k]) vistosNovo[k] = vistosI[k]; else { vistosNovo[k] = primeiraI ? 'antiga' : agoraISO; mudouI = true; } }
  if (mudouI || Object.keys(vistosNovo).length !== Object.keys(vistosI || {}).length) { try { fs.writeFileSync(ITENS_VISTOS_PATH, JSON.stringify(vistosNovo)); } catch (e) { console.error('[RADAR] itens vistos:', e.message); } }
  const novoItemAte = (it) => { const t = vistosNovo[it.nLista + '|' + it.cod]; if (!t || t === 'antiga' || vistas[it.nLista] === t) return null; const fim = new Date(t).getTime() + NOVO_ITEM_HORAS * 3600e3; return fim > Date.now() ? new Date(fim).toISOString() : null; };

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

  // estoque do CD (loja 10) por produto — filtro "Tem no CD / Não tem no CD" na barra do detalhe (Tiago, 06/10/26)
  const estCd = {};
  for (const c of chunk(codes, 4000)) { try { for (const r of await q(`SELECT CodigoBarra cod, Qtd FROM central.estoquen10 WHERE CodigoBarra IN (${c.map(() => '?').join(',')})`, c)) estCd[r.cod] = num(r.Qtd); } catch (e) { console.error('[RADAR] estoquen10:', e.message); } }

  // trânsito: sugestões abertas (Status 0/1) dos últimos 30 dias, por produto/loja
  const transito = {}, transitoDet = {};   // cod|loja → unidades ; cod|loja → [{ sugestao, data, nfe:[{nNota,data,chave}] }]
  try {
    const abertas = await q(`SELECT nReg, nLoja, nLista, CodFornec, DATE_FORMAT(DataPedido,'%Y-%m-%d') dp FROM central.pedidocompra WHERE nLista>0 AND Status IN (0,1) AND DataPedido>=?`, [addDias(hoje, -30)]);
    const infoPed = Object.fromEntries(abertas.map(a => [a.nReg, a]));
    // NF-e já emitidas pelo fornecedor (XML no ERP, ainda não importadas) → "a nota que vai chegar"
    const LOJA_CNPJ = { 1: '21425302000181', 2: '30148015000162', 3: '39762002000153', 4: '43358448000194', 5: '51632927000185', 6: '59890722000101' };
    const cnpjLoja = Object.fromEntries(Object.entries(LOJA_CNPJ).map(([l, c]) => [c, +l]));
    const raizForn = {};
    try { const fr = await q(`SELECT CodFornec, CNPJ FROM central.fornecedor WHERE CodFornec IN (${[...new Set(abertas.map(a => a.CodFornec))].map(() => '?').join(',') || '0'})`, [...new Set(abertas.map(a => a.CodFornec))]); for (const f of fr) raizForn[f.CodFornec] = String(f.CNPJ || '').replace(/\D/g, '').slice(0, 8); } catch (e) {}
    const xmlPend = {};   // raiz|loja → [{nNota, data, chave}]
    // corte por nReg: sem ele a axml era varrida inteira e estourava os 20 s em horário de gravação de XML (ver lib/axml-corte.js)
    const corteX = await corteAxml(q, addDias(hoje, -30));
    try { const xr = await q(`SELECT nNota, DATE_FORMAT(Data,'%Y-%m-%d') data, CNPJdest, LEFT(CNPJemit,8) raiz, Chave FROM central.axml WHERE nReg>=? AND nMod='55' AND Importado=0 AND Data>=?`, [corteX, addDias(hoje, -30)]); for (const x of xr) { const l = cnpjLoja[x.CNPJdest]; if (!l) continue; (xmlPend[`${x.raiz}|${l}`] = xmlPend[`${x.raiz}|${l}`] || []).push({ nNota: x.nNota, data: x.data, chave: x.Chave }); } } catch (e) {}
    // NF-e só conta no trânsito do PRODUTO se o XML tem esse produto (Tiago, 23/09/26: "puxar só as notas que têm o produto da
    // sugestão"). Antes entrava toda nota do fornecedor pra loja no período. Códigos que valem: CodigoBarras do XML (às vezes é o
    // código interno do fornecedor), ocEanTrib (EAN tributável) e, se for caixa DUN-14, a unidade EAN-13 correspondente.
    // Se a consulta falhar, prodNfeOk fica false e o comportamento antigo (por fornecedor+loja+data) continua.
    const prodNfe = {}; let prodNfeOk = false;
    try {
      const { dun14ParaEan13 } = require('./pedidos-cd-util');
      const pr = await q(`SELECT x.Chave chave, p.CodigoBarras cb, p.ocEanTrib ean FROM central.axml x JOIN central.axmlprodutos p ON p.nNota=x.nNota AND p.CNPJemit=x.CNPJemit WHERE x.nReg>=? AND x.nMod='55' AND x.Importado=0 AND x.Data>=?`, [corteX, addDias(hoje, -30)]);
      for (const r of pr) { const st = prodNfe[r.chave] || (prodNfe[r.chave] = new Set()); for (const v of [r.cb, r.ean]) { const c = String(v || '').trim(); if (!c) continue; st.add(c); if (c.length === 14) { const u = dun14ParaEan13(c); if (u) st.add(u); } } }
      prodNfeOk = true;
    } catch (e) { console.error('[RADAR] produtos das NF-e pendentes:', e.message); }
    for (const c of chunk(abertas.map(a => a.nReg), 3000)) {
      if (!c.length) continue;
      // TotalUnd = quantidade em UNIDADES (quando a sugestão foi digitada em caixa, Qtd fica em volumes e TotalUnd = Qtd × Emb);
      // conferido contra o XML: 99% dos itens são UN nos dois lados e 87% batem exatamente
      const r = await q(`SELECT nPedido, nLoja, CodigoBarra cod, Qtd, Emb, TotalUnd FROM central.pedidocompraproduto WHERE nPedido IN (${c.map(() => '?').join(',')})`, c);
      for (const x of r) {
        const und = num(x.TotalUnd) > 0 ? num(x.TotalUnd) : num(x.Qtd) * (num(x.Emb) > 1 ? num(x.Emb) : 1);
        const k = `${x.cod}|${x.nLoja}`; transito[k] = (transito[k] || 0) + und;
        const ped = infoPed[x.nPedido]; const nfe = ped ? (xmlPend[`${raizForn[ped.CodFornec] || ''}|${x.nLoja}`] || []).filter(n => n.data >= ped.dp && (!prodNfeOk || (prodNfe[n.chave] && prodNfe[n.chave].has(String(x.cod).trim())))) : [];
        (transitoDet[k] = transitoDet[k] || []).push({ sugestao: x.nPedido, data: ped?.dp || null, und, nfe });
      }
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
  if (HIST_ATIVO) { if (!hist12Cache) carregarHist(); if (!hist12Cache || dd(hoje, hist12Cache.calculadoEm) >= 1) atualizarHistEmSegundoPlano(codes, hoje); }   // a vida entra na rodada diária (madrugada), nunca no deploy em horário comercial: o .252 é produção
  const H = HIST_ATIVO && hist12Cache ? hist12Cache.mensal : {};
  // meses de referência: mês atual e mês que vem, no ano passado (LY) e no retrasado (LY2)
  const dAtual = new Date(hoje + 'T00:00:00Z');
  const mk = (anos, meses) => { const d = new Date(dAtual); d.setUTCFullYear(d.getUTCFullYear() - anos); d.setUTCMonth(d.getUTCMonth() + meses); return ym(d); };
  const mesAtualLY = mk(1, 0), mesProxLY = mk(1, 1), mesAtualLY2 = mk(2, 0), mesProxLY2 = mk(2, 1);
  const H_MESES = new Set(); { const d = new Date(dAtual); d.setUTCDate(1); for (let k = 1; k <= HIST_MESES; k++) { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() - k); H_MESES.add(ym(x)); } }
  let nFallback12 = 0, nSazonal = 0;
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
      porLoja[ln] = { vq: (v ? v.qtd : 0) / dias, vR: (v ? v.valor : 0) / dias, est: Math.max(0, eL), estBruto: eL, transito: tL, transitoDet: transitoDet[`${it.cod}|${ln}`] || [], fonte: '40d', jaVendeu: H[`${it.cod}|${ln}`] ? Object.entries(H[`${it.cod}|${ln}`]).some(([m, x]) => H_MESES.has(m) && x[0] > 0) : null };   // só os 24 meses: vida inteira não vale pra "caixa na loja zerada" (medido 14/09: 54% iam pra loja que nunca vendeu)
    }
    // RUPTURA (Tiago, 05/10/26, vale pra todos os itens): loja sem venda nos 40 d, OU com venda bem abaixo do ritmo de vida dela
    // (< 25%: ex. ATOL em E2 vendeu 3 un em 40 d numa loja que vendia 20/mês e tinha 3 em estoque — venda residual mascarava
    // a ruptura e o Radar achava que 3 un cobriam 40 dias) → usa o ritmo de VIDA da loja (média dos últimos 6 meses em que
    // vendeu, no histórico inteiro). Teto = média das lojas sem ruptura com venda nos 40 d.
    { const vida = {}, rupt = {};
      for (const ln of lojas) { const L = porLoja[ln]; const vd = ritmoVida(H[`${it.cod}|${ln}`], hoje); if (!vd) continue; vida[ln] = vd; if (L.vq <= 0 || (L.vq < RUPTURA_FRACAO * vd.vq && L.est + L.transito < vd.vq * RUPTURA_EST_DIAS)) rupt[ln] = true; }
      const outras = lojas.filter(l => !rupt[l] && porLoja[l].vq > 0).map(l => porLoja[l].vq); const tetoVq = outras.length ? outras.reduce((a, b) => a + b, 0) / outras.length : 0;
      for (const ln of lojas) { if (!rupt[ln]) continue; const L = porLoja[ln], vd = vida[ln];
        let vqE = vd.vq, vRE = vd.vR; if (tetoVq > 0 && vqE > tetoVq) { vRE *= tetoVq / vqE; vqE = tetoVq; }
        if (vqE > L.vq) { qtd += (vqE - L.vq) * dias; val += (vRE - L.vR) * dias; L.vq = vqE; L.vR = vRE; L.fonte = 'vida'; L.vida = { meses: vd.meses, de: vd.de, ate: vd.ate }; nFallback12++; } } }
    // SAZONAL (2 anos): o mês que vem se destaca nos dois anos? fator = média de (alvo ÷ atual) dos dois anos, limitado
    let sazonal = null;
    { const soma = m => { let t = 0; for (const ln of lojas) t += H[`${it.cod}|${ln}`]?.[m]?.[0] || 0; return t; };
      // média mensal dos 12 meses que terminam no mês alvo daquele ano
      // média mensal do ano em volta do mês alvo: ano passado olha 12 meses PRA TRÁS (cabem no histórico);
      // ano retrasado olha 12 meses PRA FRENTE a partir do alvo (os anteriores não existem no histórico de 24 m)
      const mediaMensal = (ate, dir) => { const [y, m] = ate.split('-').map(Number); let t = 0, n = 0; for (let k = 0; k < 12; k++) { const d = new Date(Date.UTC(y, m - 1 + dir * k, 1)); const key = ym(d); if (!H_MESES.has(key)) continue; t += soma(key); n++; } return n >= 10 ? t / n : 0; };
      const a1 = soma(mesAtualLY), p1 = soma(mesProxLY), a2 = soma(mesAtualLY2), p2 = soma(mesProxLY2);
      const m1 = mediaMensal(mesProxLY, -1), m2 = mediaMensal(mesProxLY2, +1);
      if (a1 >= SAZONAL_MIN_UN && a2 >= SAZONAL_MIN_UN && p1 > 0 && p2 > 0 && m1 > 0 && m2 > 0) {
        const r1 = p1 / m1, r2 = p2 / m2;                         // quanto o mês alvo se destaca da média em cada ano
        const alta = r1 >= SAZONAL_ALTA && r2 >= SAZONAL_ALTA, baixa = r1 <= SAZONAL_BAIXA && r2 <= SAZONAL_BAIXA;
        if (alta || baixa) {
          const f = Math.max(SAZONAL_FATOR_MIN, Math.min(SAZONAL_FATOR_MAX, ((p1 / a1) + (p2 / a2)) / 2));
          if (Math.abs(f - 1) >= 0.15) { sazonal = { fator: +f.toFixed(2), tipo: alta ? 'alta' : 'baixa', alvo: mesProxLY.slice(5), anos: [{ ano: mesProxLY.slice(0, 4), atual: a1, alvo: p1, x_media: +r1.toFixed(2) }, { ano: mesProxLY2.slice(0, 4), atual: a2, alvo: p2, x_media: +r2.toFixed(2) }] }; for (const ln of lojas) { porLoja[ln].vq *= f; porLoja[ln].vR *= f; } qtd *= f; val *= f; nSazonal++; }
        }
      } }
    // item na lista sem NENHUMA loja marcada = excluído (mesma regra da tela Lista de Compra); não entra no radar
    if (!lojas.length) continue;
    const pm = qtd > 0 ? val / qtd : 0;
    prods.push({
      lista: it.nLista, cod: it.cod, descricao: it.descricao, unid: it.unid || 'UN', emb: num(it.emb) > 0 ? num(it.emb) : 1,
      validade: num(it.validade), lojas, porLoja, sazonal, fonte12: lojas.filter(l => porLoja[l].fonte === 'vida'),
      vq: qtd / dias, vR: val / dias, est: Math.max(0, estQ), estBruto: estQ, transito: tr, estCd: estCd[it.cod] || 0,
      custo: custo[it.cod] || pm * 0.75, precoMedio: pm,
      novo_ate: novoItemAte(it), visto_em: (t => t && t !== 'antiga' ? t : null)(vistosNovo[it.nLista + '|' + it.cod])
    });
  }
  // Curva A: produtos que, ordenados por venda em R$/dia (todas as lojas), somam os
  // primeiros CURVA_A_FRACAO da venda total das listas. Um produto que aparece em mais de
  // uma lista conta uma vez (pela maior venda). Vira flag no produto (curvaA, rankA).
  const porCod = {};
  for (const p of prods) if (p.vq > 0 && (!porCod[p.cod] || porCod[p.cod] < p.vR)) porCod[p.cod] = p.vR;
  const ordem = Object.entries(porCod).sort((a, b) => b[1] - a[1]);
  const totR = ordem.reduce((a, [, v]) => a + v, 0);
  const curvaA = {}; let acc = 0;
  for (let i = 0; i < ordem.length; i++) { acc += ordem[i][1]; if (acc / totR > CURVA_A_FRACAO) break; curvaA[ordem[i][0]] = i + 1; }
  for (const p of prods) { p.curvaA = !!curvaA[p.cod]; p.rankA = curvaA[p.cod] || null; }
  console.log(`[RADAR] venda: ${nFallback12} loja×produto com média dos últimos 6 meses (ruptura recente), ${nSazonal} produtos sazonais (mês alvo ${mesProxLY.slice(5)}, 2 anos)`);
  return { hoje, dIni, dFim, dias, listas, prods, embHist, hist12: { ativo: HIST_ATIVO, cache: hist12Cache ? hist12Cache.calculadoEm : null, fallback24: nFallback12, sazonal: nSazonal, alvo: mesProxLY.slice(5) }, curvaA: { n: Object.keys(curvaA).length, fracao: CURVA_A_FRACAO, produtos: ordem.length, vendaDia: totR } };
}

// Ritmo de VIDA de uma loja (Tiago, 05/10/26): média dos últimos 6 meses EM QUE O PRODUTO VENDEU nessa loja, olhando o histórico
// inteiro (do mês mais recente pro mais antigo, sem o mês atual), só se vendeu em ≥3 meses. É o ritmo "quando tinha estoque":
// mês sem venda (ruptura) não entra na média. Devolve { vq, vR, meses, de, ate } ou null.
function ritmoVida(h, hoje) {
  if (!h) return null;
  const mesAtual = String(hoje).slice(0, 7);
  const meses = Object.keys(h).filter(m => m < mesAtual && h[m] && h[m][0] > 0).sort().reverse().slice(0, FALLBACK_JANELA_MESES);
  if (meses.length < FALLBACK_MIN_MESES) return null;
  const [ya, ma] = meses[0].split('-').map(Number), [yd, md] = meses[meses.length - 1].split('-').map(Number);
  if ((ya - yd) * 12 + (ma - md) + 1 > VIDA_SPAN_MESES) return null;   // meses com venda espalhados demais = giro baixo, não ruptura
  const [yh, mh] = mesAtual.split('-').map(Number); if ((yh - ya) * 12 + (mh - ma) > VIDA_RECENCIA_MESES) return null;   // parado há mais de 12 meses = descontinuado
  let qtd = 0, val = 0; for (const m of meses) { qtd += h[m][0]; val += h[m][1]; }
  const vq = qtd / (meses.length * 30.5), vR = val / (meses.length * 30.5);
  return vq > 0 ? { vq, vR, meses: meses.length, de: meses[meses.length - 1], ate: meses[0] } : null;
}
// 12 meses de venda por produto/loja/mês (todas as tabelas mensais, filtrando pela data)
async function calcularHist12(codes, hoje, anterior) {
  const { q, mesDB } = deps;
  // começa no 1º dia do mês, HIST_MESES meses atrás → só meses INTEIROS (setembro pela metade inflava a comparação do 2º ano)
  const d0 = new Date(hoje + 'T00:00:00Z'); d0.setUTCDate(1); d0.setUTCMonth(d0.getUTCMonth() - HIST_MESES);
  const dIni = iso(d0), dFim = addDias(hoje, -1);
  const mensal = {};
  const guarda = (ln, r) => { for (const x of r) { const k = `${x.cod}|${ln}`; (mensal[k] = mensal[k] || {})[x.mes] = [Math.round(num(x.qtd) * 1000) / 1000, Math.round(num(x.valor) * 100) / 100]; } };
  for (const ln of LOJAS) for (let m = 1; m <= 12; m++) for (const c of chunk(codes, 4000)) {
    const ph = c.map(() => '?').join(',');
    try {
      guarda(ln, await q(`SELECT Codigo cod, DATE_FORMAT(Data,'%Y-%m') mes, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) valor FROM \`ln${ln}${mesDB(m)}\`.zcupomitens
                         WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo, mes`, [dIni, dFim, ...c]));
    } catch (e) {}
  }
  // VIDA (Tiago, 05/10): meses anteriores a dIni não mudam → vêm do cache anterior; código que ainda não tem a vida puxada
  // (novo na lista, ou 1ª rodada) é buscado em lotes pequenos, com Data < dIni. Lote que estoura o timeout é dividido ao meio;
  // se ainda falhar, fica pra próxima rodada (o resto do cache segue valendo).
  const mesIni = dIni.slice(0, 7), vidaCodes = new Set((anterior && anterior.vidaCodes) || []);
  if (anterior && anterior.mensal) for (const [k, meses] of Object.entries(anterior.mensal)) { if (!vidaCodes.has(k.split('|')[0])) continue; for (const [m, v] of Object.entries(meses)) if (m < mesIni) (mensal[k] = mensal[k] || {})[m] = v; }
  if (HIST_VIDA) {
    const falta = codes.map(String).filter(c => !vidaCodes.has(c)); let falhas = 0;
    const pausa = deps.pausaVida != null ? deps.pausaVida : 250;   // ms entre consultas: a vida roda na madrugada e não pode pesar no .252
    const lote = async (c) => {
      for (const ln of LOJAS) for (let m = 1; m <= 12; m++) {
        const ph = c.map(() => '?').join(',');
        if (pausa) await new Promise(r => setTimeout(r, pausa));
        try { guarda(ln, await q(`SELECT Codigo cod, DATE_FORMAT(Data,'%Y-%m') mes, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) valor FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data < ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo, mes`, [dIni, ...c])); }
        catch (e) { if (c.length > 25) { const h = Math.ceil(c.length / 2); return (await lote(c.slice(0, h))) && (await lote(c.slice(h))); } falhas++; return false; }
      }
      for (const x of c) vidaCodes.add(x); return true;
    };
    if (falta.length) { const t0 = Date.now(); for (const c of chunk(falta, HIST_VIDA_LOTE)) await lote(c); console.log(`[RADAR] vida: ${falta.length} produto(s) puxados em ${Math.round((Date.now() - t0) / 1000)}s${falhas ? ' · ' + falhas + ' lote(s) ficaram pra próxima rodada' : ''}`); }
  }
  return { calculadoEm: hoje, mensal, vidaCodes: [...vidaCodes] };
}

// ─────────────────────────────────────────────────────────────
// 3) POLÍTICA (puro, roda em cima da base em memória)
// ─────────────────────────────────────────────────────────────
function paramsLista(L, lead, teto, fonte = 'lista') {
  if (!lead || lead.lead_medio == null) return null;
  const lm = lead.lead_medio, seg = Math.min(Math.max(0, (lead.lead_max ?? lm) - lm), lm);
  const ponto = lm + seg;
  // teto limita o alvo, mas o alvo nunca fica abaixo do ponto de pedido:
  // lista de lead longo (ponto > teto) precisa cobrir pelo menos a entrega.
  const alvoLista = Math.max(ponto + 1, Math.min(teto, lead.intervalo != null ? ponto + lead.intervalo : teto));
  return { lm, seg, ponto, alvoLista, ciclo: Math.max(1, alvoLista - ponto), fonte };
}
// Lista SEM lead próprio (Tiago, 01/10/26: "vai pelo lead da lista e pelo lead do item; se não conseguir pela lista, faz pelo
// item, vendo todo o histórico de entrada/saída/venda"): lead do PRODUTO (pedido → entrada, em qualquer lista) → lead do
// FORNECEDOR (outras listas dele) → mediana da REDE. O intervalo (ciclo) vem do próprio produto quando ele tem entradas no
// período. cod = null dá os parâmetros da lista (fornecedor → rede), usados nos itens sem histórico próprio.
function paramsFallback(L, cod, teto) {
  const li = cod != null ? leadCache?.porItem?.[String(cod)] : null, lf = leadCache?.porFornec?.[L?.codFornec], lr = leadCache?.rede;
  const src = [li, lf, lr].find(x => x && x.lead_medio != null); if (!src) return null;
  const fonte = src === li ? 'item' : src === lf ? 'fornecedor' : 'rede';
  const intervalo = li && li.intervalo != null ? li.intervalo : (src.intervalo ?? lf?.intervalo ?? lr?.intervalo ?? null);
  return paramsLista(L, { lead_medio: src.lead_medio, lead_max: src.lead_max, intervalo }, teto, fonte);
}
function alvoProduto(p, P) {
  return p.validade > 0 ? Math.min(P.alvoLista, Math.max(P.ponto + 1, p.validade * FRACAO_VALIDADE)) : P.alvoLista;
}
function qtdPedido(p, P, fazerEm, embMeses = EMB_HIST_MESES_PADRAO) {
  const emb = embEfetiva(p, embMeses);
  const porLoja = {};
  const alvo = P ? alvoProduto(p, P) : null;
  // calculado LOJA A LOJA (o Dlinks gera a sugestão por loja); o total é a soma das lojas
  let total = 0, flag = null;
  for (const ln of p.lojas) {
    const L = p.porLoja[ln];
    if (!L) { porLoja[ln] = 0; continue; }
    // Loja ZERADA sem venda: loja MARCADA NA LISTA pro produto, estoque zero, nada em trânsito → 1 caixa.
    // Medido em 14/09/2026: 4.655 caixas, e 2.532 delas (54%) iam pra loja que NUNCA vendeu o produto em 24 meses
    // (a marcação L1–L6 da lista é mais larga que o sortimento real). Por isso a caixa só entra se a loja já vendeu
    // o produto alguma vez nos 24 meses; loja que nunca vendeu fica marcada 'nunca_vendeu' (não pede).
    // Tiago, 01/10/26: "não pode ter estoque zero ou negativo e não ter sugestão, senão causa ruptura em loja" → loja zerada
    // (estoque ≤ 0 e nada em trânsito) recebe 1 caixa SEMPRE, com ou sem lead. Única exceção, a combinada em 14/09: estoque
    // exatamente zero numa loja que nunca vendeu o produto em 24 m e que não é ITEM NOVO na lista (sortimento largo demais).
    // Estoque NEGATIVO (vendeu sem estoque) e item novo entram mesmo assim.
    const zerada = L.est + L.transito <= 0;
    if (L.vq <= 0 || !P) {
      if (zerada && (L.estBruto < 0 || p.novo_ate || L.jaVendeu !== false || L.vq > 0)) { porLoja[ln] = emb; total += emb; flag = flag || 'zerado'; }
      else { porLoja[ln] = 0; if (zerada && L.jaVendeu === false) flag = flag || 'nunca_vendeu'; }
      continue;
    }
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

// Filtro por LOJA (Tiago, 24/09): o Radar inteiro (listas, quantidades, cobertura, curva A) visto por uma loja só.
// Cada produto vira uma "projeção" com os números daquela loja (venda/dia, estoque, trânsito) e só ela marcada;
// a conta (ponto, alvo, piso/teto, embalagem) é a mesma. Produto não marcado pra loja sai. Combina com comprador.
// loja pode ser 1 loja (3), várias ("1,2" ou [1,2]) ou nada (todas). Tiago, 24/09: "sugestão loja 1 e 2 junto, ou 3 e 6".
function lojasSet(loja) {
  const arr = Array.isArray(loja) ? loja : String(loja == null ? '' : loja).split(',');
  const set = [...new Set(arr.map(x => parseInt(x)).filter(n => LOJAS_RADAR.includes(n)))].sort((a, b) => a - b);
  return set.length && set.length < LOJAS_RADAR.length ? set : [];   // vazio = todas
}
// Estoque e trânsito por loja de uma lista de códigos (Pedidos de Compra mostra "est · trâns" embaixo da caixinha de cada
// loja, igual à Cotação — Tiago, 06/10/26). Vem da base do Radar (recalculada de madrugada e a cada deploy); produto em mais
// de uma lista tem o mesmo estoque, vale o primeiro. est = estoque líquido (negativo vira 0), transito = sugestões abertas no ERP.
function estoqueLojas(cods) {
  const out = {}; if (!base || !Array.isArray(base.prods)) return out;
  const quer = new Set((cods || []).map(String));
  for (const p of base.prods) {
    const c = String(p.cod); if (!quer.has(c) || out[c]) continue;
    const lojas = {}; let est = 0, tr = 0, vq = 0;
    for (const ln of p.lojas || []) { const L = p.porLoja && p.porLoja[ln]; if (!L) continue; const e = +(+L.est || 0).toFixed(1), t = +(+L.transito || 0).toFixed(1); lojas[ln] = { estoque: e, transito: t, venda_dia: +(+L.vq || 0).toFixed(3) }; est += e; tr += t; vq += +L.vq || 0; }
    // cobertura = (estoque + trânsito) ÷ venda/dia somando as lojas, mesma conta do Radar
    out[c] = { lojas, estoque: +est.toFixed(1), transito: +tr.toFixed(1), venda_dia: +vq.toFixed(3), cobertura_dias: vq > 0 ? +((est + tr) / vq).toFixed(1) : null };
  }
  return out;
}
function projetarLoja(prods, loja) {
  const set = lojasSet(loja); if (!set.length) return prods;
  const out = [];
  for (const p of prods) {
    const lns = p.lojas.filter(ln => set.includes(ln) && p.porLoja && p.porLoja[ln]); if (!lns.length) continue;
    const porLoja = {}; let vq = 0, vR = 0, est = 0, estB = 0, tr = 0;
    for (const ln of lns) { const L = p.porLoja[ln]; porLoja[ln] = L; vq += L.vq; vR += L.vR; est += L.est; estB += L.estBruto; tr += L.transito; }
    out.push({ ...p, lojas: lns, porLoja, vq, vR, est, estBruto: estB, transito: tr, fonte12: (p.fonte12 || []).filter(l => lns.includes(l)) });
  }
  return out;
}
// gatilho (Tiago, 24/09): fração da venda da lista, NA LOJA, que precisa estar no ponto de pedido pra lista cair pra
// hoje (padrão 20%). É sempre avaliado loja a loja; na visão "Todas" cada lista assume o dia da loja mais apertada
// (lojas_puxam diz quais) e a quantidade continua saindo loja a loja, cada uma até o alvo.
function politica(teto = TETO_PADRAO, filtroComprador = null, embMeses = EMB_HIST_MESES_PADRAO, usarCurvaA = true, loja = null, gatilho = null, _semLojas = false) {
  if (!base) return [];
  const FRACAO = gatilho > 0 && gatilho <= 1 ? gatilho : FRACAO_VENDA_GATILHO;
  // visão "Todas": primeiro o dia de cada loja (com o mesmo gatilho), depois a rede assume o menor
  const porLojaDia = {};
  const setL = lojasSet(loja), lojasDia = setL.length ? setL : LOJAS_RADAR;   // 1 loja: nada a combinar; 2+ ou todas: dia de cada uma, a mais apertada manda
  if (lojasDia.length > 1 && !_semLojas) {
    for (const ln of lojasDia) for (const r of politica(teto, filtroComprador, embMeses, usarCurvaA, ln, FRACAO, true)) { if (!r.ok) continue; (porLojaDia[r.lista] = porLojaDia[r.lista] || {})[ln] = r.fazer_em; }
  }
  const byL = {};
  for (const p of projetarLoja(base.prods, loja)) (byL[p.lista] = byL[p.lista] || []).push(p);
  const out = [];
  for (const L of Object.values(base.listas)) {
    if (filtroComprador && L.comprador !== filtroComprador) continue;
    const lead = leadCache?.porLista?.[L.lista];
    const ps = (byL[L.lista] || []);
    const comVenda = ps.filter(p => p.vq > 0);
    // lead da lista; sem histórico → fornecedor → rede (Tiago, 01/10/26). PP(p): item com lead próprio usa o dele quando a lista não tem.
    const P = paramsLista(L, lead, teto) || paramsFallback(L, null, teto);
    const PP = p => (P && P.fonte !== 'lista' && leadCache?.porItem?.[p.cod]?.lead_medio != null) ? paramsFallback(L, p.cod, teto) : P;
    // produto sem venda mas com loja zerada que deve receber 1 caixa (estoque negativo, item novo ou loja que já vendeu em 24 m)
    const zerados = ps.filter(p => p.vq <= 0 && p.lojas.some(ln => { const Lj = p.porLoja[ln]; return Lj && Lj.est + Lj.transito <= 0 && (Lj.estBruto < 0 || p.novo_ate || Lj.jaVendeu !== false); }));
    const row = { ...L, produtos: ps.length, com_venda: comVenda.length, lead: lead || null, lead_fonte: P ? P.fonte : null, itens_novos: ps.filter(p => p.novo_ate).length, zerados_sem_venda: zerados.length, ok: !!(P && (comVenda.length || zerados.length)) };
    // Trânsito da lista: o que já foi pedido no ERP (sugestão aberta, Status 0/1, últimos 30 d) e ainda não entrou — coluna "Trânsito"
    // da tabela (Tiago, 29/09/26: "sinalizar se a lista existe produtos em trânsito"). Conta todo produto da lista, com ou sem venda,
    // e vale também pra lista sem lead (row.ok=false). Valor a custo; "nfe" = produto×loja com NF-e já emitida pelo fornecedor.
    { let und = 0, val = 0, itens = 0, nfe = 0; const lojas = new Set();
      for (const p of ps) { if (!(p.transito > 0)) continue; itens++; und += p.transito; val += p.transito * (p.custo || 0);
        for (const ln of p.lojas) { const Lj = p.porLoja[ln]; if (Lj && Lj.transito > 0) { lojas.add(+ln); if ((Lj.transitoDet || []).some(d => d.nfe && d.nfe.length)) nfe++; } } }
      Object.assign(row, { transito_valor: +val.toFixed(2), transito_itens: itens, transito_und: Math.round(und), transito_lojas: [...lojas].sort((a, b) => a - b), transito_nfe: nfe }); }
    if (!row.ok) { row.motivo = !P ? 'sem lead (lista, fornecedor e rede)' : 'sem venda no período'; out.push(row); continue; }
    let vendaR = 0, estHoje = 0, estAlvo = 0, valW = 0, rupt = 0;
    const dias = [];
    for (const p of comVenda) {
      const alvo = alvoProduto(p, PP(p));
      vendaR += p.vR; estHoje += p.est * p.custo; estAlvo += alvo * p.vq * p.custo; valW += (p.validade || 0) * p.vR;
      if (p.est <= 0) rupt++;
      dias.push([(p.est + p.transito) / p.vq - PP(p).ponto, p.vR]);
    }
    dias.sort((a, b) => a[0] - b[0]);
    let acc = 0, fazerEm = dias.length ? dias[dias.length - 1][0] : 0;   // só zerados sem venda: hoje
    for (const [d, w] of dias) { acc += w; if (acc >= vendaR * FRACAO) { fazerEm = d; break; } }
    fazerEm = Math.max(0, Math.round(fazerEm));
    // "Todas": a loja mais apertada manda no dia (a soma das lojas escondia a falta de uma delas)
    let lojasPuxam = [], fazerEmLojas = null;
    if (porLojaDia[L.lista]) { fazerEmLojas = porLojaDia[L.lista]; const min = Math.min(...Object.values(fazerEmLojas)); if (min < fazerEm) fazerEm = min; lojasPuxam = Object.keys(fazerEmLojas).filter(ln => fazerEmLojas[ln] === min).map(Number); }
    // Gatilho por produto de curva A: se um A vai zerar (estoque + trânsito acabam) ANTES do dia
    // previsto da lista, a lista é antecipada pro dia em que esse A cruza o ponto de pedido.
    // Regra "zera antes da lista" (e não só "cruzou o ponto") pra não antecipar lista que já vem logo.
    const fazerEmLista = fazerEm;   // já com a loja mais apertada aplicada
    const curvaARisco = [];
    let cAItens = 0;
    for (const p of comVenda) {
      if (!p.curvaA) continue; cAItens++;
      const cob = (p.est + p.transito) / p.vq;
      const zeraAntes = cob < fazerEmLista;
      if (zeraAntes || cob <= PP(p).ponto + MARGEM_PONTO_A) curvaARisco.push({ cod: p.cod, descricao: p.descricao, rank: p.rankA, cobertura_dias: +cob.toFixed(1), venda_dia_valor: +p.vR.toFixed(2), zera_antes: zeraAntes, fazer_em: Math.max(0, Math.round(cob - P.ponto)) });
    }
    curvaARisco.sort((a, b) => a.cobertura_dias - b.cobertura_dias);
    let gatilho = 'lista';
    if (usarCurvaA) {
      const antecipa = curvaARisco.filter(c => c.zera_antes);
      if (antecipa.length) { const fA = Math.min(...antecipa.map(c => c.fazer_em)); if (fA < fazerEm) { fazerEm = fA; gatilho = 'curva_a'; } }
    }
    let pedidoR = 0, pedidoItens = 0, flags = { piso: 0, teto: 0, zerado: 0, nunca_vendeu: 0 };
    for (const p of [...comVenda, ...zerados]) { const r = qtdPedido(p, PP(p), fazerEm, embMeses); if (r.qtd > 0) { pedidoR += r.qtd * p.custo; pedidoItens++; } if (r.flag) flags[r.flag] = (flags[r.flag] || 0) + 1; }
    const d = new Date(base.hoje + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + fazerEm);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const cob = vendaR > 0 ? estHoje / (comVenda.reduce((a, p) => a + p.vq * p.custo, 0) || 1) : null;
    Object.assign(row, {
      ponto: +P.ponto.toFixed(1), seguranca: +P.seg.toFixed(1), alvo: +P.alvoLista.toFixed(1), ciclo: +P.ciclo.toFixed(1), lead_itens: comVenda.filter(p => PP(p).fonte === 'item').length,
      fazer_em: fazerEm, data: iso(d), dow: DOW[d.getUTCDay()],
      gatilho, fazer_em_lista: fazerEmLista, curva_a_itens: cAItens, curva_a_risco: curvaARisco.slice(0, 12),
      lojas_puxam: lojasPuxam, fazer_em_lojas: fazerEmLojas, fracao_gatilho: FRACAO,
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

// paramsPadrao (Cotação, 14/09/2026): lista SEM lead time (ex.: #277 "Cotação de Alimentos", 12 atacadistas,
// nunca marca ganhador no ERP) receberia qtd 0. A tela de Cotação passa { alvo: cobertura em dias, ponto: prazo
// de entrega em dias } e a conta segue idêntica ao Radar (loja a loja, piso/teto, embalagem real). Lista COM lead
// ignora o padrão e usa o lead real.
// opts.ignorarTransito: Set de "cod|loja" cujo trânsito NÃO deve contar (Cotação, Tiago 23/09/26: "quando marco que não, ele não
// considera o trânsito"). A quantidade e a cobertura dessas lojas saem como se nada estivesse a caminho; o trânsito
// original continua no retorno (transito / transito_det) com transito_ignorado=true, pra tela mostrar riscado.
function itensLista(listaId, teto = TETO_PADRAO, fazerEmOverride = null, embMeses = EMB_HIST_MESES_PADRAO, usarCurvaA = true, paramsPadrao = null, opts = null) {
  if (!base) return null;
  const L = base.listas[listaId]; if (!L) return null;
  const lead = leadCache?.porLista?.[listaId];
  let P = paramsLista(L, lead, teto);
  // Sugestão SEMI-AUTOMÁTICA (Tiago, 06/10/26: "escolher fornecedor e quantos dias de lead eu quero; traz a estrutura do Radar
  // só que com o lead escolhido por mim"): opts.lead = lead em dias (ponto de pedido, sem segurança); alvo = lead + intervalo
  // da lista (teto), ou opts.alvo se o(a) comprador(a) informar a cobertura. Marca params.manual pra tela e pro pedido.
  if (opts && opts.lead > 0) {
    const lm = +opts.lead, alvoAuto = Math.max(lm + 1, Math.min(teto, lead && lead.intervalo != null ? lm + lead.intervalo : teto));
    const alvo = opts.alvo > lm ? +opts.alvo : alvoAuto;
    P = { lm, seg: 0, ponto: lm, alvoLista: alvo, ciclo: Math.max(1, alvo - lm), manual: true, lead_manual: lm, alvo_manual: opts.alvo > lm ? +opts.alvo : null };
  }
  if (!P && paramsPadrao) {
    const ponto = Math.max(0, +paramsPadrao.ponto || 0);
    const alvo = Math.max(ponto + 1, +paramsPadrao.alvo || teto);
    P = { lm: ponto, seg: 0, ponto, alvoLista: alvo, ciclo: Math.max(1, alvo - ponto), padrao: true, fonte: 'padrao' };
  }
  if (!P) P = paramsFallback(L, null, teto);   // fornecedor → rede (Tiago, 01/10/26)
  const PP = p => (P && P.fonte !== 'lista' && P.fonte !== 'padrao' && leadCache?.porItem?.[p.cod]?.lead_medio != null) ? paramsFallback(L, p.cod, teto) : P;
  const loja = opts && opts.loja ? opts.loja : null, gatilho = opts && opts.gatilho > 0 ? +opts.gatilho : null;
  const row = politica(teto, null, embMeses, usarCurvaA, loja, gatilho).find(r => r.lista === +listaId);
  const fazerEm = fazerEmOverride != null ? fazerEmOverride : (row?.fazer_em ?? 0);
  const fazerEmLista = row?.fazer_em_lista ?? fazerEm;
  const ign = opts && opts.ignorarTransito && opts.ignorarTransito.size ? opts.ignorarTransito : null;
  const itens = projetarLoja(base.prods, loja).filter(p => p.lista === +listaId).map(p0 => {
    let p = p0;
    if (ign) { const lojasIgn = p0.lojas.filter(ln => ign.has(p0.cod + '|' + ln) && p0.porLoja[ln] && p0.porLoja[ln].transito > 0);
      if (lojasIgn.length) { const porLoja = { ...p0.porLoja }; let tr = 0; for (const ln of p0.lojas) { const L = porLoja[ln]; if (!L) continue; if (lojasIgn.includes(ln)) porLoja[ln] = { ...L, transito: 0, transitoIgnorado: true, transitoOriginal: L.transito, transitoDetOriginal: L.transitoDet || [] }; tr += porLoja[ln].transito; } p = { ...p0, porLoja, transito: tr }; } }
    const Pp = PP(p); const r = qtdPedido(p, Pp, fazerEm, embMeses);   // sem lead nenhum, qtdPedido ainda dá 1 caixa à loja zerada
    const cob = p.vq > 0 ? (p.est + p.transito) / p.vq : null;
    const embH = embCompra(p.cod, embMeses, L.codFornec || 0);
    // risco_a: produto de curva A que zera antes do dia da lista ou já está no ponto de pedido
    const riscoA = !!(p.curvaA && Pp && cob != null && (cob < fazerEmLista || cob <= Pp.ponto + MARGEM_PONTO_A));
    // zera_antes: o produto acaba antes da data em que a lista esta marcada (vale pra qualquer produto, A ou nao)
    const zeraAntes = !!(Pp && cob != null && p.vq > 0 && cob < fazerEmLista);
    return {
      cod: p.cod, descricao: p.descricao, unid: p.unid, emb: r.emb, emb_cadastro: p.emb, emb_compra: embH, emb_manual: embManual[p.cod] || null, emb_padrao: embPadrao[p.cod] || null, lojas: p.lojas, validade: p.validade || null,
      curva_a: !!p.curvaA, rank_a: p.rankA || null, risco_a: riscoA, zera_antes: zeraAntes, sazonal: p.sazonal || null, fonte12: p.fonte12 || [],
      // bloco_a: vai pro bloco de cima do detalhe = produto A em risco ou com quantidade a pedir; A folgado fica embaixo
      bloco_a: !!(p.curvaA && (riscoA || r.qtd > 0)),
      venda_dia: +p.vq.toFixed(3), venda_dia_valor: +p.vR.toFixed(2), estoque: +p.est.toFixed(2), estoque_bruto: +p.estBruto.toFixed(2), transito: +p.transito.toFixed(2), estoque_cd: p.estCd == null ? null : +(+p.estCd).toFixed(2),
      cobertura_dias: cob != null ? +cob.toFixed(1) : null, alvo_dias: r.alvo != null ? +r.alvo.toFixed(1) : null, ponto_dias: Pp ? +Pp.ponto.toFixed(1) : null, lead_fonte: Pp ? Pp.fonte : null,
      novo_ate: p.novo_ate || null, visto_em: p.visto_em || null,
      qtd: r.qtd, volumes: r.qtd ? Math.ceil(r.qtd / r.emb) : 0, custo: +p.custo.toFixed(4), total: +(r.qtd * p.custo).toFixed(2), flag: r.flag,
      lojas_qtd: r.porLoja || {},
      lojas_det: Object.fromEntries(p.lojas.map(ln => { const L = p.porLoja[ln]; return [ln, { estoque: +L.est.toFixed(1), estoque_bruto: +L.estBruto.toFixed(1), transito: +(L.transitoIgnorado ? L.transitoOriginal : L.transito).toFixed(1), transito_det: (L.transitoIgnorado ? L.transitoDetOriginal : L.transitoDet) || [], transito_ignorado: !!L.transitoIgnorado, venda_dia: +L.vq.toFixed(3), fonte: L.fonte || '40d', ja_vendeu: L.jaVendeu, cobertura_dias: L.vq > 0 ? +((L.est + L.transito) / L.vq).toFixed(1) : null }]; })),
      abaixo_ponto: Pp ? cob != null && cob <= Pp.ponto : false
    };
  }).sort((a, b) => b.bloco_a - a.bloco_a || b.risco_a - a.risco_a || (b.qtd > 0) - (a.qtd > 0) || (a.cobertura_dias ?? 1e9) - (b.cobertura_dias ?? 1e9));
  return { lista: L, lead: lead || null, params: P, lead_fonte: P ? P.fonte : null, fazer_em: fazerEm, data: row?.data || null,
           gatilho: row?.gatilho || 'lista', fazer_em_lista: fazerEmLista, curva_a_risco: row?.curva_a_risco || [], curva_a_itens: row?.curva_a_itens || 0,
           itens, total: +itens.reduce((a, i) => a + i.total, 0).toFixed(2), volumes: itens.reduce((a, i) => a + i.volumes, 0) };
}

// Aba "Curva A em risco": produto a produto, independente da lista. Entra quem é curva A e
//   - zera antes do dia previsto da lista, ou já está no ponto de pedido  → comprar (antecipar lista / pedir hoje)
//   - tem loja zerada com venda, mas estoque sobrando em outra loja       → transferir (não é falta de compra)
function curvaARisco(teto = TETO_PADRAO, filtroComprador = null, embMeses = EMB_HIST_MESES_PADRAO, usarCurvaA = true, loja = null, gatilho = null) {
  if (!base) return { resumo: null, itens: [] };
  const rows = politica(teto, filtroComprador, embMeses, usarCurvaA, loja, gatilho);
  const prodsVista = projetarLoja(base.prods, loja);
  const porLista = Object.fromEntries(rows.map(r => [r.lista, r]));
  const out = [];
  for (const p of prodsVista) {
    if (!p.curvaA || p.vq <= 0) continue;
    const r = porLista[p.lista]; if (!r || !r.ok) continue;
    const cob = (p.est + p.transito) / p.vq;
    const zeraAntes = cob < r.fazer_em_lista, noPonto = cob <= r.ponto + MARGEM_PONTO_A;
    const lojasZeradas = p.lojas.filter(ln => { const L = p.porLoja[ln]; return L && L.vq >= VENDA_MIN_LOJA_ZERADA && L.est + L.transito <= 0; })
      .map(ln => ({ loja: ln, venda_dia: +p.porLoja[ln].vq.toFixed(2) }));
    const lojasComEstoque = p.lojas.filter(ln => { const L = p.porLoja[ln]; return L && L.est > 0; }).length;
    if (!zeraAntes && !noPonto && !lojasZeradas.length) continue;
    let acao;
    if (zeraAntes || noPonto) acao = r.fazer_em === 0 ? 'pedir_hoje' : (r.gatilho === 'curva_a' ? 'antecipada' : 'antecipar');
    else acao = lojasComEstoque ? 'transferir' : 'antecipar';
    out.push({
      cod: p.cod, descricao: p.descricao, unid: p.unid, rank: p.rankA, curva_a_total: base.curvaA.n,
      venda_dia: +p.vq.toFixed(2), venda_dia_valor: +p.vR.toFixed(2), estoque: +p.est.toFixed(0), transito: +p.transito.toFixed(0),
      cobertura_dias: +cob.toFixed(1), ponto: r.ponto, zera_antes: zeraAntes, no_ponto: noPonto,
      lojas: p.lojas, lojas_zeradas: lojasZeradas, lojas_com_estoque: lojasComEstoque,
      lojas_det: Object.fromEntries(p.lojas.map(ln => { const L = p.porLoja[ln]; return [ln, { estoque: +L.est.toFixed(0), transito: +L.transito.toFixed(0), venda_dia: +L.vq.toFixed(2), cobertura_dias: L.vq > 0 ? +((L.est + L.transito) / L.vq).toFixed(1) : null }]; })),
      lista: r.lista, lista_nome: r.nome, fornecedor: r.fornecedor, comprador: r.comprador,
      fazer_em: r.fazer_em, data: r.data, fazer_em_lista: r.fazer_em_lista, gatilho: r.gatilho, acao
    });
  }
  const ordem = { pedir_hoje: 0, antecipada: 1, antecipar: 2, transferir: 3 };
  out.sort((a, b) => ordem[a.acao] - ordem[b.acao] || a.cobertura_dias - b.cobertura_dias || b.venda_dia_valor - a.venda_dia_valor);
  const resumo = { curva_a: base.curvaA, em_risco: out.length, comprar: out.filter(i => i.acao !== 'transferir').length, transferir: out.filter(i => i.acao === 'transferir').length,
                   listas_antecipadas: rows.filter(r => r.ok && r.gatilho === 'curva_a').length, hoje: out.filter(i => i.acao === 'pedir_hoje').length };
  return { resumo, itens: out };
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
  // pra comparar depois produto a produto com o que o(a) comprador(a) pediu no ERP
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
    listas: rows.map(r => ({ lista: r.lista, comprador: r.comprador, fazer_em: r.fazer_em, fazer_em_lista: r.fazer_em_lista, gatilho: r.gatilho, pedido_valor: r.pedido_valor, pedido_itens: r.pedido_itens, cobertura_dias: r.cobertura_dias, estoque_hoje: r.estoque_hoje, rupturas: r.rupturas, venda_dia: r.venda_dia })),
    itens
  };
  fs.writeFileSync(path.join(SOMBRA_DIR, `${base.hoje}.json`), JSON.stringify(snap));
}

// Detalhe do modo sombra: produto a produto, comprador(a) (ERP) × sistema (snapshot do dia)
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
    // Tiago, 09/10/26 ("vê o porquê da demora de carregar; revisa pra não acontecer mais"): com base na memória (do disco ou do
    // cálculo anterior) o Radar continua 'ok' e serve o último cálculo enquanto recalcula — só o primeiro cálculo da vida fica
    // 'calculando'. Antes, a cada reinício (deploy) e a cada recálculo (05:30, lista mudou no ERP, botão) a tela trocava a tabela
    // pelo spinner por 1 a 3 min. A tela agora só mostra "atualizando…" e troca os dados sozinha quando terminar.
    estado = { ...estado, status: base ? 'ok' : 'calculando', erro: null, recalculando: true, recalculandoDesde: new Date().toISOString() };
    try {
      if (forcarLead || !leadCache || !leadCache.porItem || dd(iso(new Date()), leadCache.calculadoEm) >= 1) {
        console.log('[RADAR] calculando lead time por lista…');
        leadCache = await calcularLead();
      }
      console.log('[RADAR] coletando venda/estoque/trânsito…');
      base = await coletarBase();
      salvarSnapshot();
      estado = { status: 'ok', recalculando: false, atualizadoEm: new Date().toISOString(), erro: null, duracaoMs: Date.now() - t0, listas: Object.keys(base.listas).length, produtos: base.prods.length, leadListas: Object.keys(leadCache.porLista).length, leadFornec: Object.keys(leadCache.porFornec || {}).length, leadItens: Object.keys(leadCache.porItem || {}).length, leadRede: leadCache.rede || null };
      salvarBase();
      console.log(`[RADAR] ok em ${Math.round(estado.duracaoMs / 1000)}s — ${estado.produtos} produtos, ${estado.leadListas} listas com lead`);
    } catch (e) {
      estado = { ...estado, status: base ? 'ok' : 'erro', erro: e.message, duracaoMs: Date.now() - t0, recalculando: false };
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
      if (l.fazer_em !== 0 && !real) continue;   // só dias em que alguém (sistema ou comprador(a)) agiu
      linhas.push({ dia: s.dia, lista: l.lista, nome: nomes[l.lista]?.nome || String(l.lista), comprador: l.comprador,
        sistema: l.fazer_em === 0 ? l.pedido_valor : 0, sistema_itens: l.fazer_em === 0 ? l.pedido_itens : 0,
        real: real ? real.total : 0, real_lojas: real ? real.lojas : 0, cobertura: l.cobertura_dias, rupturas: l.rupturas,
        caso: l.fazer_em === 0 && real ? 'ambos' : (l.fazer_em === 0 ? 'so_sistema' : 'so_compradora') });
    }
  }
  const tendencia = snaps.map(s => ({ dia: s.dia, porComprador: s.porComprador }));
  return { dias, snapshots: snaps.length, linhas, tendencia };
}

// null enquanto o radar não tem base (≈90 s após subir): quem consome precisa saber a diferença
// entre "não há curva A" e "ainda não sei".
function curvaASet() { return base ? new Set((base.prods || []).filter(p => p.curvaA).map(p => String(p.cod))) : null; }

// abrir uma NF-e do XML pela chave (cabeçalho + itens + boletos) — só leitura
// Tipo da operação pelo CFOP do item (CFOP do XML é o do EMITENTE: 5xxx dentro do estado, 6xxx de fora).
// Pra loja o que importa é: é compra normal, é bonificação (não paga), é devolução, é transferência ou outra coisa.
function tipoCfop(cfop) {
  const c = String(cfop || ''); if (c.length !== 4) return 'Sem CFOP';
  const f = c.slice(1);   // tira o 1º dígito (5/6 saída do fornecedor; 1/2 se algum XML vier na visão de entrada)
  if (f === '910') return 'Bonificação';
  if (f === '911') return 'Amostra grátis';
  if (f === '912' || f === '913' || f === '914' || f === '915' || f === '916') return 'Demonstração / retorno';
  if (f === '202' || f === '201' || f === '410' || f === '411' || f === '412' || f === '413') return 'Devolução';
  if (f === '152' || f === '151' || f === '408' || f === '409' || f === '155' || f === '156') return 'Transferência';
  if (f === '117' || f === '118' || f === '119' || f === '922' || f === '116') return 'Venda p/ entrega futura';
  if (f === '949' || f === '927' || f === '929') return 'Outra saída';
  if (/^(10[1-9]|11[0-9]|12[0-9]|40[1-9])$/.test(f)) return 'Compra';   // 101/102/103/104/105/106/109/110 e 401/403/405 (com ST) = venda normal do fornecedor
  return 'CFOP ' + c;
}
async function nfe(chave) {
  const { q } = deps; if (!/^[0-9A-Za-z]{20,44}$/.test(chave || '')) return null;
  const cab = (await q(`SELECT nNota, nSerie, DATE_FORMAT(Data,'%Y-%m-%d') data, CNPJemit, NomeEmit, CNPJdest, NomeDest, ValorNFE, ValorProduto, ValorDesconto, ValorFrete, ValorIPI, ValorICMSsub, Importado, Chave FROM central.axml WHERE Chave=? LIMIT 1`, [chave]))[0];
  if (!cab) return null;
  const itens = await q(`SELECT nItem, CodigoBarras, ocEanTrib, Descricao, Und, Qtd, ValorUnit, ValorTotal, oqTrib, ovUnTrib, ouTrib, CFOP FROM central.axmlprodutos WHERE nNota=? AND CNPJemit=? ORDER BY nItem`, [cab.nNota, cab.CNPJemit]).catch(() => []);
  const boletos = await q(`SELECT ndup, DATE_FORMAT(dataVencto,'%Y-%m-%d') vencimento, valor FROM central.axmlboletos WHERE chave=? ORDER BY ndup`, [chave]).catch(() => []);
  // valores do cabeçalho vêm como texto com vírgula no ERP ("1.427,85") → número, senão a tela mostra "R$ NaN"
  for (const k of ['ValorNFE', 'ValorProduto', 'ValorDesconto', 'ValorFrete', 'ValorIPI', 'ValorICMSsub']) cab[k] = num(cab[k]);
  const its = itens.map(p => { const cfop = String(p.CFOP || '').replace(/\D/g, '').slice(0, 4); return { item: p.nItem, cod: String(p.CodigoBarras || '').trim() || String(p.ocEanTrib || '').trim(), descricao: (p.Descricao || '').trim(), und: p.Und, qtd: num(p.Qtd), valorUnit: num(p.ValorUnit), total: num(p.ValorTotal), unidades: num(p.oqTrib) || null, undTrib: p.ouTrib, precoUnit: num(p.ovUnTrib) || null, cfop, operacao: tipoCfop(cfop) }; });
  // resumo da operação: um tipo por CFOP presente, com quantos itens e quanto em R$ (nota mista mostra "compra + bonificação")
  const porTipo = {};
  for (const i of its) { const t = porTipo[i.operacao] = porTipo[i.operacao] || { tipo: i.operacao, itens: 0, valor: 0, cfops: new Set() }; t.itens++; t.valor += i.total; t.cfops.add(i.cfop); }
  const operacoes = Object.values(porTipo).sort((a, b) => b.valor - a.valor).map(t => ({ ...t, valor: Math.round(t.valor * 100) / 100, cfops: [...t.cfops].filter(Boolean).sort() }));
  return { ...cab, operacao: operacoes.map(t => t.tipo).join(' + ') || null, operacoes, itens: its, boletos: boletos.map(b => ({ dup: b.ndup, vencimento: b.vencimento, valor: num(b.valor) })) };
}
function getEstado() { return { ...estado, hoje: base?.hoje || null, curva_a: base?.curvaA || null, hist12: base?.hist12 || null, janela: base ? { dIni: base.dIni, dFim: base.dFim, dias: base.dias } : null, leadCalculadoEm: leadCache?.calculadoEm || null, teto_padrao: TETO_PADRAO }; }

// agenda: recalcula ao subir (após 10s; enquanto isso vale a base carregada do disco) e todo dia às 05:30
// Lista de compras mudou no ERP (item trocou de lista, entrou, saiu) → o Radar recalcula sozinho em até 10 min.
// (Tiago, 23/09/2026: moveu o café Santa Clara de lista e o Radar seguia com a lista velha até o dia seguinte.)
let listasFp = null;
// Assinatura da tabela de itens das listas: qtd de linhas, listas, códigos E marcação de lojas (l1..l6) — ativar/desativar
// um item na lista do ERP só muda as lojas, e antes (até 23/09/2026) isso passava batido até o recálculo das 05:30.
async function fingerprintListas() {
  try { const [r] = await deps.q(`SELECT COUNT(*) n, COALESCE(SUM(nCotacao),0) s, COALESCE(SUM(CAST(Codigobarra AS UNSIGNED) % 9973),0) h, COALESCE(SUM(l1+l2+l3+l4+l5+l6),0) f FROM central.c_cotacao_lista_itens`); return [r.n, r.s, r.h, r.f].join('|'); }
  catch (e) { return null; }
}
function agendar() {
  setTimeout(() => recalcular(), 10 * 1000);
  setInterval(() => {
    const d = new Date();
    if (d.getHours() === 5 && d.getMinutes() === 30) recalcular();
    if (d.getMinutes() % 10 === 0 && base && !recalculando) fingerprintListas().then(fp => { if (fp && listasFp && fp !== listasFp) { console.log('[RADAR] listas de compra mudaram no ERP → recalculando'); recalcular(); } if (fp) listasFp = fp; });
    if (HIST_ATIVO && d.getHours() === 4 && d.getMinutes() === 30 && base) atualizarHistEmSegundoPlano([...new Set(base.prods.map(p => p.cod))], iso(new Date()));
  }, 60 * 1000);
}

module.exports = { estoqueLojas, ritmoVida, init, agendar, recalcular, recarregarEmbPadrao, calcularHist12, politica, itensLista, curvaARisco, projetarLoja, lojasSet, sombra, sombraDetalhe, nfe, atualizarHistEmSegundoPlano, getEstado, curvaASet, TETO_PADRAO,
  // funções puras reaproveitadas por lib/pedidos-cd.js
  paramsLista, paramsFallback, alvoProduto, qtdPedido, num, chunk,
  _setBaseParaTeste: b => { base = b; }, _setLeadParaTeste: l => { leadCache = l; } };
