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
// o que as compradoras pediram de fato).
const fs = require('fs');
const path = require('path');

const SOMBRA_DIR = path.join(__dirname, '..', 'data', 'radar-sombra');
// listas já vistas pelo radar: { nReg: primeiraVezISO } — lista que aparece pela 1ª vez fica "LISTA NOVA" por 24 h
const VISTAS_PATH = path.join(__dirname, '..', 'data', 'radar-listas-vistas.json');
const NOVA_HORAS = 24;
const LOJAS = [1, 2, 3, 4, 5, 6];
const DOW = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];
const TETO_PADRAO = 28;
const FRACAO_VALIDADE = 0.6;
// Gatilho da lista (risco ponderado, 11/09/2026): a lista e feita no dia em que os produtos que
// VAO FALTAR (cruzam o ponto de pedido) somam 10% da venda em R$ da lista. Antes era 25% e um
// lider sobrando (84 d) escondia itens zerados. Combinado com o gatilho por produto de curva A.
const FRACAO_VENDA_GATILHO = 0.10;
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
let embPadrao = {}, embManual = {}, embCarregado = false;
function recarregarEmbPadrao() {
  embCarregado = true;
  try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'emb-padrao.json'), 'utf8')); embPadrao = {}; for (const [c, v] of Object.entries(j)) if (v && +v.emb >= 1) embPadrao[c] = { emb: +v.emb, fonte: v.fonte || null }; } catch (e) { embPadrao = {}; }
  try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'unidade-embalagem-overrides.json'), 'utf8')); embManual = {}; for (const [c, v] of Object.entries(j)) { const e = parseFloat(String(v?.embalagem ?? '').replace(',', '.')); if (e >= 1) embManual[c] = e; } } catch (e) { embManual = {}; }
}
function embEfetiva(p, meses) {
  if (p.embFixa >= 1) return p.embFixa;   // Pedidos do CD: un/cx do vínculo, sem olhar histórico de notas
  if (!embCarregado) recarregarEmbPadrao();
  if (embManual[p.cod] >= 1) return embManual[p.cod];
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
    try { console.log('[RADAR] histórico 24 meses em segundo plano…'); const t0 = Date.now(); hist12Cache = await calcularHist12(codes, hoje); salvarHist(); console.log(`[RADAR] hist24 ok em ${Math.round((Date.now() - t0) / 1000)}s`); await recalcular(false); }
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
    try { const xr = await q(`SELECT nNota, DATE_FORMAT(Data,'%Y-%m-%d') data, CNPJdest, LEFT(CNPJemit,8) raiz, Chave FROM central.axml WHERE nMod='55' AND Importado=0 AND Data>=?`, [addDias(hoje, -30)]); for (const x of xr) { const l = cnpjLoja[x.CNPJdest]; if (!l) continue; (xmlPend[`${x.raiz}|${l}`] = xmlPend[`${x.raiz}|${l}`] || []).push({ nNota: x.nNota, data: x.data, chave: x.Chave }); } } catch (e) {}
    for (const c of chunk(abertas.map(a => a.nReg), 3000)) {
      if (!c.length) continue;
      // TotalUnd = quantidade em UNIDADES (quando a sugestão foi digitada em caixa, Qtd fica em volumes e TotalUnd = Qtd × Emb);
      // conferido contra o XML: 99% dos itens são UN nos dois lados e 87% batem exatamente
      const r = await q(`SELECT nPedido, nLoja, CodigoBarra cod, Qtd, Emb, TotalUnd FROM central.pedidocompraproduto WHERE nPedido IN (${c.map(() => '?').join(',')})`, c);
      for (const x of r) {
        const und = num(x.TotalUnd) > 0 ? num(x.TotalUnd) : num(x.Qtd) * (num(x.Emb) > 1 ? num(x.Emb) : 1);
        const k = `${x.cod}|${x.nLoja}`; transito[k] = (transito[k] || 0) + und;
        const ped = infoPed[x.nPedido]; const nfe = ped ? (xmlPend[`${raizForn[ped.CodFornec] || ''}|${x.nLoja}`] || []).filter(n => n.data >= ped.dp) : [];
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
  if (HIST_ATIVO) { if (!hist12Cache) carregarHist(); if (!hist12Cache || dd(hoje, hist12Cache.calculadoEm) >= 1) atualizarHistEmSegundoPlano(codes, hoje); }
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
      porLoja[ln] = { vq: (v ? v.qtd : 0) / dias, vR: (v ? v.valor : 0) / dias, est: Math.max(0, eL), estBruto: eL, transito: tL, transitoDet: transitoDet[`${it.cod}|${ln}`] || [], fonte: '40d', jaVendeu: H[`${it.cod}|${ln}`] ? Object.values(H[`${it.cod}|${ln}`]).some(x => x[0] > 0) : null };
    }
    // LOJA SEM VENDA nos 40 d → média dos 24 meses DESSA loja, só se vendeu em ≥3 meses; teto = média das outras lojas
    { const outras = lojas.map(l => porLoja[l].vq).filter(x => x > 0); const tetoVq = outras.length ? outras.reduce((a, b) => a + b, 0) / outras.length : 0;
      for (const ln of lojas) { const L = porLoja[ln]; if (L.vq > 0) continue; const h = H[`${it.cod}|${ln}`]; if (!h) continue;
        const desde = mk(0, -FALLBACK_JANELA_MESES); const recentes = Object.entries(h).filter(([m, x]) => m >= desde && x[0] > 0); if (recentes.length < FALLBACK_MIN_MESES) continue;
        const meses = recentes.map(([, x]) => x);
        let q24 = 0, v24 = 0; for (const x of meses) { q24 += x[0]; v24 += x[1]; }
        let vqE = q24 / (FALLBACK_JANELA_MESES * 30.5), vRE = v24 / (FALLBACK_JANELA_MESES * 30.5); if (tetoVq > 0 && vqE > tetoVq) { vRE *= tetoVq / vqE; vqE = tetoVq; }
        if (vqE > 0) { L.vq = vqE; L.vR = vRE; L.fonte = '24m'; qtd += vqE * dias; val += vRE * dias; nFallback12++; } } }
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
      validade: num(it.validade), lojas, porLoja, sazonal, fonte12: lojas.filter(l => porLoja[l].fonte === '24m'),
      vq: qtd / dias, vR: val / dias, est: Math.max(0, estQ), estBruto: estQ, transito: tr,
      custo: custo[it.cod] || pm * 0.75, precoMedio: pm
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

// 12 meses de venda por produto/loja/mês (todas as tabelas mensais, filtrando pela data)
async function calcularHist12(codes, hoje) {
  const { q, mesDB } = deps;
  // começa no 1º dia do mês, HIST_MESES meses atrás → só meses INTEIROS (setembro pela metade inflava a comparação do 2º ano)
  const d0 = new Date(hoje + 'T00:00:00Z'); d0.setUTCDate(1); d0.setUTCMonth(d0.getUTCMonth() - HIST_MESES);
  const dIni = iso(d0), dFim = addDias(hoje, -1);
  const mensal = {};
  for (const ln of LOJAS) for (let m = 1; m <= 12; m++) for (const c of chunk(codes, 4000)) {
    const ph = c.map(() => '?').join(',');
    try {
      const r = await q(`SELECT Codigo cod, DATE_FORMAT(Data,'%Y-%m') mes, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) valor FROM \`ln${ln}${mesDB(m)}\`.zcupomitens
                         WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo, mes`, [dIni, dFim, ...c]);
      for (const x of r) { const k = `${x.cod}|${ln}`; (mensal[k] = mensal[k] || {})[x.mes] = [Math.round(num(x.qtd) * 1000) / 1000, Math.round(num(x.valor) * 100) / 100]; }
    } catch (e) {}
  }
  return { calculadoEm: hoje, mensal };
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
    if (!L) { porLoja[ln] = 0; continue; }
    // Loja ZERADA sem venda: loja MARCADA NA LISTA pro produto, estoque zero, nada em trânsito → 1 caixa.
    // Medido em 14/09/2026: 4.655 caixas, e 2.532 delas (54%) iam pra loja que NUNCA vendeu o produto em 24 meses
    // (a marcação L1–L6 da lista é mais larga que o sortimento real). Por isso a caixa só entra se a loja já vendeu
    // o produto alguma vez nos 24 meses; loja que nunca vendeu fica marcada 'nunca_vendeu' (não pede).
    if (L.vq <= 0) { if (L.est + L.transito <= 0 && L.jaVendeu !== false) { porLoja[ln] = emb; total += emb; flag = flag || 'zerado'; } else { porLoja[ln] = 0; if (L.est + L.transito <= 0 && L.jaVendeu === false) flag = flag || 'nunca_vendeu'; } continue; }
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

function politica(teto = TETO_PADRAO, filtroComprador = null, embMeses = EMB_HIST_MESES_PADRAO, usarCurvaA = true) {
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
    // Gatilho por produto de curva A: se um A vai zerar (estoque + trânsito acabam) ANTES do dia
    // previsto da lista, a lista é antecipada pro dia em que esse A cruza o ponto de pedido.
    // Regra "zera antes da lista" (e não só "cruzou o ponto") pra não antecipar lista que já vem logo.
    const fazerEmLista = fazerEm;
    const curvaARisco = [];
    let cAItens = 0;
    for (const p of comVenda) {
      if (!p.curvaA) continue; cAItens++;
      const cob = (p.est + p.transito) / p.vq;
      const zeraAntes = cob < fazerEmLista;
      if (zeraAntes || cob <= P.ponto + MARGEM_PONTO_A) curvaARisco.push({ cod: p.cod, descricao: p.descricao, rank: p.rankA, cobertura_dias: +cob.toFixed(1), venda_dia_valor: +p.vR.toFixed(2), zera_antes: zeraAntes, fazer_em: Math.max(0, Math.round(cob - P.ponto)) });
    }
    curvaARisco.sort((a, b) => a.cobertura_dias - b.cobertura_dias);
    let gatilho = 'lista';
    if (usarCurvaA) {
      const antecipa = curvaARisco.filter(c => c.zera_antes);
      if (antecipa.length) { const fA = Math.min(...antecipa.map(c => c.fazer_em)); if (fA < fazerEm) { fazerEm = fA; gatilho = 'curva_a'; } }
    }
    let pedidoR = 0, pedidoItens = 0, flags = { piso: 0, teto: 0, zerado: 0 };
    for (const p of comVenda) { const r = qtdPedido(p, P, fazerEm, embMeses); if (r.qtd > 0) { pedidoR += r.qtd * p.custo; pedidoItens++; } if (r.flag) flags[r.flag]++; }
    const d = new Date(base.hoje + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + fazerEm);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const cob = vendaR > 0 ? estHoje / (comVenda.reduce((a, p) => a + p.vq * p.custo, 0) || 1) : null;
    Object.assign(row, {
      ponto: +P.ponto.toFixed(1), seguranca: +P.seg.toFixed(1), alvo: +P.alvoLista.toFixed(1), ciclo: +P.ciclo.toFixed(1),
      fazer_em: fazerEm, data: iso(d), dow: DOW[d.getUTCDay()],
      gatilho, fazer_em_lista: fazerEmLista, curva_a_itens: cAItens, curva_a_risco: curvaARisco.slice(0, 12),
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
function itensLista(listaId, teto = TETO_PADRAO, fazerEmOverride = null, embMeses = EMB_HIST_MESES_PADRAO, usarCurvaA = true, paramsPadrao = null) {
  if (!base) return null;
  const L = base.listas[listaId]; if (!L) return null;
  const lead = leadCache?.porLista?.[listaId];
  let P = paramsLista(L, lead, teto);
  if (!P && paramsPadrao) {
    const ponto = Math.max(0, +paramsPadrao.ponto || 0);
    const alvo = Math.max(ponto + 1, +paramsPadrao.alvo || teto);
    P = { lm: ponto, seg: 0, ponto, alvoLista: alvo, ciclo: Math.max(1, alvo - ponto), padrao: true };
  }
  const row = politica(teto, null, embMeses, usarCurvaA).find(r => r.lista === +listaId);
  const fazerEm = fazerEmOverride != null ? fazerEmOverride : (row?.fazer_em ?? 0);
  const fazerEmLista = row?.fazer_em_lista ?? fazerEm;
  const itens = base.prods.filter(p => p.lista === +listaId).map(p => {
    const r = P ? qtdPedido(p, P, fazerEm, embMeses) : { qtd: 0, flag: null, emb: embEfetiva(p, embMeses), porLoja: {} };
    const cob = p.vq > 0 ? (p.est + p.transito) / p.vq : null;
    const embH = embCompra(p.cod, embMeses, L.codFornec || 0);
    // risco_a: produto de curva A que zera antes do dia da lista ou já está no ponto de pedido
    const riscoA = !!(p.curvaA && P && cob != null && (cob < fazerEmLista || cob <= P.ponto + MARGEM_PONTO_A));
    // zera_antes: o produto acaba antes da data em que a lista esta marcada (vale pra qualquer produto, A ou nao)
    const zeraAntes = !!(P && cob != null && p.vq > 0 && cob < fazerEmLista);
    return {
      cod: p.cod, descricao: p.descricao, unid: p.unid, emb: r.emb, emb_cadastro: p.emb, emb_compra: embH, emb_manual: embManual[p.cod] || null, emb_padrao: embPadrao[p.cod] || null, lojas: p.lojas, validade: p.validade || null,
      curva_a: !!p.curvaA, rank_a: p.rankA || null, risco_a: riscoA, zera_antes: zeraAntes, sazonal: p.sazonal || null, fonte12: p.fonte12 || [],
      // bloco_a: vai pro bloco de cima do detalhe = produto A em risco ou com quantidade a pedir; A folgado fica embaixo
      bloco_a: !!(p.curvaA && (riscoA || r.qtd > 0)),
      venda_dia: +p.vq.toFixed(3), venda_dia_valor: +p.vR.toFixed(2), estoque: +p.est.toFixed(2), estoque_bruto: +p.estBruto.toFixed(2), transito: +p.transito.toFixed(2),
      cobertura_dias: cob != null ? +cob.toFixed(1) : null, alvo_dias: r.alvo != null ? +r.alvo.toFixed(1) : null,
      qtd: r.qtd, volumes: r.qtd ? Math.ceil(r.qtd / r.emb) : 0, custo: +p.custo.toFixed(4), total: +(r.qtd * p.custo).toFixed(2), flag: r.flag,
      lojas_qtd: r.porLoja || {},
      lojas_det: Object.fromEntries(p.lojas.map(ln => { const L = p.porLoja[ln]; return [ln, { estoque: +L.est.toFixed(1), estoque_bruto: +L.estBruto.toFixed(1), transito: +L.transito.toFixed(1), transito_det: L.transitoDet || [], venda_dia: +L.vq.toFixed(3), fonte: L.fonte || '40d', ja_vendeu: L.jaVendeu, cobertura_dias: L.vq > 0 ? +((L.est + L.transito) / L.vq).toFixed(1) : null }]; })),
      abaixo_ponto: P ? cob != null && cob <= P.ponto : false
    };
  }).sort((a, b) => b.bloco_a - a.bloco_a || b.risco_a - a.risco_a || (b.qtd > 0) - (a.qtd > 0) || (a.cobertura_dias ?? 1e9) - (b.cobertura_dias ?? 1e9));
  return { lista: L, lead: lead || null, params: P, fazer_em: fazerEm, data: row?.data || null,
           gatilho: row?.gatilho || 'lista', fazer_em_lista: fazerEmLista, curva_a_risco: row?.curva_a_risco || [], curva_a_itens: row?.curva_a_itens || 0,
           itens, total: +itens.reduce((a, i) => a + i.total, 0).toFixed(2), volumes: itens.reduce((a, i) => a + i.volumes, 0) };
}

// Aba "Curva A em risco": produto a produto, independente da lista. Entra quem é curva A e
//   - zera antes do dia previsto da lista, ou já está no ponto de pedido  → comprar (antecipar lista / pedir hoje)
//   - tem loja zerada com venda, mas estoque sobrando em outra loja       → transferir (não é falta de compra)
function curvaARisco(teto = TETO_PADRAO, filtroComprador = null, embMeses = EMB_HIST_MESES_PADRAO, usarCurvaA = true) {
  if (!base) return { resumo: null, itens: [] };
  const rows = politica(teto, filtroComprador, embMeses, usarCurvaA);
  const porLista = Object.fromEntries(rows.map(r => [r.lista, r]));
  const out = [];
  for (const p of base.prods) {
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
    listas: rows.map(r => ({ lista: r.lista, comprador: r.comprador, fazer_em: r.fazer_em, fazer_em_lista: r.fazer_em_lista, gatilho: r.gatilho, pedido_valor: r.pedido_valor, pedido_itens: r.pedido_itens, cobertura_dias: r.cobertura_dias, estoque_hoje: r.estoque_hoje, rupturas: r.rupturas, venda_dia: r.venda_dia })),
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
      salvarBase();
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

// null enquanto o radar não tem base (≈90 s após subir): quem consome precisa saber a diferença
// entre "não há curva A" e "ainda não sei".
function curvaASet() { return base ? new Set((base.prods || []).filter(p => p.curvaA).map(p => String(p.cod))) : null; }

// abrir uma NF-e do XML pela chave (cabeçalho + itens + boletos) — só leitura
async function nfe(chave) {
  const { q } = deps; if (!/^[0-9A-Za-z]{20,44}$/.test(chave || '')) return null;
  const cab = (await q(`SELECT nNota, nSerie, DATE_FORMAT(Data,'%Y-%m-%d') data, CNPJemit, NomeEmit, CNPJdest, NomeDest, ValorNFE, ValorProduto, ValorDesconto, ValorFrete, ValorIPI, ValorICMSsub, Importado, Chave FROM central.axml WHERE Chave=? LIMIT 1`, [chave]))[0];
  if (!cab) return null;
  const itens = await q(`SELECT nItem, CodigoBarras, ocEanTrib, Descricao, Und, Qtd, ValorUnit, ValorTotal, oqTrib, ovUnTrib, ouTrib FROM central.axmlprodutos WHERE nNota=? AND CNPJemit=? ORDER BY nItem`, [cab.nNota, cab.CNPJemit]).catch(() => []);
  const boletos = await q(`SELECT ndup, DATE_FORMAT(dataVencto,'%Y-%m-%d') vencimento, valor FROM central.axmlboletos WHERE chave=? ORDER BY ndup`, [chave]).catch(() => []);
  return { ...cab, itens: itens.map(p => ({ item: p.nItem, cod: String(p.CodigoBarras || '').trim() || String(p.ocEanTrib || '').trim(), descricao: (p.Descricao || '').trim(), und: p.Und, qtd: num(p.Qtd), valorUnit: num(p.ValorUnit), total: num(p.ValorTotal), unidades: num(p.oqTrib) || null, undTrib: p.ouTrib, precoUnit: num(p.ovUnTrib) || null })), boletos: boletos.map(b => ({ dup: b.ndup, vencimento: b.vencimento, valor: num(b.valor) })) };
}
function getEstado() { return { ...estado, hoje: base?.hoje || null, curva_a: base?.curvaA || null, hist12: base?.hist12 || null, janela: base ? { dIni: base.dIni, dFim: base.dFim, dias: base.dias } : null, leadCalculadoEm: leadCache?.calculadoEm || null, teto_padrao: TETO_PADRAO }; }

// agenda: recalcula ao subir (após 10s; enquanto isso vale a base carregada do disco) e todo dia às 05:30
function agendar() {
  setTimeout(() => recalcular(), 10 * 1000);
  setInterval(() => {
    const d = new Date();
    if (d.getHours() === 5 && d.getMinutes() === 30) recalcular();
    if (HIST_ATIVO && d.getHours() === 4 && d.getMinutes() === 30 && base) atualizarHistEmSegundoPlano([...new Set(base.prods.map(p => p.cod))], iso(new Date()));
  }, 60 * 1000);
}

module.exports = { init, agendar, recalcular, recarregarEmbPadrao, calcularHist12, politica, itensLista, curvaARisco, sombra, sombraDetalhe, nfe, atualizarHistEmSegundoPlano, getEstado, curvaASet, TETO_PADRAO,
  // funções puras reaproveitadas por lib/pedidos-cd.js
  paramsLista, alvoProduto, qtdPedido, num, chunk };
