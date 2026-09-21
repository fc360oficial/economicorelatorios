// Radar Precificação (21/09/2026, pedido do Tiago): margem e markup produto × loja, curva ABC (quantidade e R$),
// papel do item (sensível / forte / normal / cauda / parado), meta de margem por departamento (referência de mercado,
// editável) e SUGESTÃO de preço com projeção de venda e lucro (elasticidade por papel). Direcionamento pra levar a
// margem das lojas acima da meta (30% s/ venda) sem perder venda nos itens sensíveis.
// SOMENTE LEITURA no ERP. O único estado gravado é em data/:
//   radar-precificacao.json           — cache do cálculo (1×/dia de madrugada ou sob demanda)
//   radar-precificacao-params.json    — metas/regras editadas na tela
//   radar-precificacao-decisoes.json  — preços aceitos/ignorados na tela (saem no CSV pra digitar no ERP)
//
// Definições (as duas aparecem na tela, pra não confundir com o "margem" do cadastro do ERP, que é markup):
//   margem  = (preço − custo) ÷ preço  (sobre a venda)   ← a meta "30%" é nessa
//   markup  = (preço − custo) ÷ custo  (sobre o custo)   ← é o que o ERP chama de margem (itens_margens.MargemVarejo)
//   margem realizada = (venda − custo vendido) ÷ venda, dos cupons dos últimos 90 dias (zcupomitens.Custo)
'use strict';
const fs = require('fs');
const path = require('path');
const { arred } = require('./precificacao-calc');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'radar-precificacao.json');
const PARAMS = path.join(DATA, 'radar-precificacao-params.json');
const DEC = path.join(DATA, 'radar-precificacao-decisoes.json');
const LOJAS = [1, 2, 3, 4, 5, 6];
const NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const DIAS = 90;

// Metas de margem s/ venda por departamento — REFERÊNCIA de mercado (supermercados/atacarejo, Nordeste), ajustável
// na tela. Commodities e KVI (arroz/feijão/óleo/leite/refrigerante) rodam baixo porque o cliente compara preço;
// perecíveis produzidos (padaria), utilidades, festa e bazar carregam a margem.
const METAS_GRUPO_PADRAO = {
  'ACOUGUE': 25, 'PEIXARIA': 32, 'FRIOS/CONG/SORVETE': 30, 'FLV': 35, 'PADARIA': 48, 'SALGADO': 28,
  'ARROZ/FEIJAO/FARIN/ACUC': 18, 'OLEO/MASSAS': 22, 'CAFE/LEITE/CHA/ACHOCOLATADOS': 22, 'BEBIDAS/REFRIG/SUCO/AGUA SABOR': 25,
  'BISC/BOMBONS/DOCES/SALG': 30, 'CONDIMENTOS/ENLATADOS': 32, 'MOSTARDA/MAIONESE/DERIV TOMATE': 30,
  'MATINAIS/ALIM INF/COMP ALIMENT': 28, 'DIET/LIGHT': 32, 'INGREDIENTE FESTA/GRANULADOS': 34, 'SAL/CARVÃO': 40,
  'LIMPEZA': 31, 'HIGIENE': 32, 'PERFUMARIA': 36, 'PETSHOP': 30, 'UTILIDADE DOMESTICA': 42, 'UTILIDADE INFANTIL/CONFECÇÕES': 40,
  'ARTIGO FESTA': 45, 'CALÇADOS': 45, 'CAMPING/FERRAG/AUTOMOTIVO': 40, 'PAPELARIA': 45, 'TABACARIA': 15
};
const PARAMS_PADRAO = {
  metaGeral: 30,                                                     // margem s/ venda alvo da empresa (%)
  metasGrupo: METAS_GRUPO_PADRAO,                                    // por departamento (grupo do ERP)
  ajustePapel: { sensivel: -5, forte: -2, normal: 0, cauda: 4 },     // pontos somados à meta do grupo
  elasticidade: { sensivel: -1.5, forte: -1.0, normal: -0.7, cauda: -0.4 }, // Δ% quantidade por 1% de preço
  maxAumento: { sensivel: 4, forte: 6, normal: 8, cauda: 12 },       // % máximo de aumento numa rodada
  maxReducao: 15,                                                    // % máximo de redução numa rodada
  folgaBaixar: 6,                                                    // só baixa preço (sensível/forte) se a margem passar da meta + isso
  markupMinimo: 5,                                                   // piso: nunca sugerir abaixo de custo + 5%
  terminacao: '9',                                                   // centavo final do preço sugerido
  deltaMinimo: 1.5,                                                  // |Δ| menor que isso = manter
  cortesABC: { A: 0.8, B: 0.95 },
  excluirGrupos: ['USO E CONSUMO', 'TAXA DE ENTREGA']
};

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const num = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const up = s => String(s || '').trim().toUpperCase();

let deps = null, cache = null, calculando = null, params = null, decisoes = null, idx = null;

function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); }

function init(d) {
  deps = d;
  params = mesclarParams(lerJson(PARAMS, {}));
  decisoes = lerJson(DEC, {});
  cache = lerJson(OUT, null);
  if (cache) { aplicarRegrasTodas(); indexar(); }
}
function mesclarParams(p) {
  const o = JSON.parse(JSON.stringify(PARAMS_PADRAO));
  for (const k of Object.keys(p || {})) {
    if (k === 'metasGrupo' && p[k] && typeof p[k] === 'object') o[k] = { ...p[k] };   // mapa inteiro: grupo apagado na tela volta pra meta geral
    else if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) Object.assign(o[k], p[k]); else if (p[k] != null) o[k] = p[k];
  }
  return o;
}
function getParams() { return { ...params, padrao: PARAMS_PADRAO }; }
function setParams(p) { params = mesclarParams({ ...params, ...p }); gravarJson(PARAMS, params); if (cache) { aplicarRegrasTodas(); indexar(); } return params; }
function resetParams() { params = mesclarParams({}); gravarJson(PARAMS, params); if (cache) { aplicarRegrasTodas(); indexar(); } return params; }

// meses (banco ln{loja}mes{MM}) que cobrem os últimos `dias` dias, com o recorte de datas de cada um
function mesesUltimos(dias) {
  const hoje = new Date(), ini = new Date(hoje); ini.setDate(ini.getDate() - dias);
  const out = []; const d = new Date(ini.getFullYear(), ini.getMonth(), 1);
  while (d <= hoje) {
    const y = d.getFullYear(), m = d.getMonth() + 1;
    out.push({ mm: String(m).padStart(2, '0'), dIni: iso(new Date(Math.max(d, ini))), dFim: iso(new Date(Math.min(new Date(y, m, 0), hoje))) });
    d.setMonth(d.getMonth() + 1);
  }
  return { meses: out, de: iso(ini), ate: iso(hoje) };
}

async function calcular() {
  if (calculando) return calculando;
  calculando = (async () => {
    const t0 = Date.now(), q = deps.q;
    console.log('[RADAR-PRECIF] calculando...');
    const itens = await q(`SELECT i.CodigoBarra cod, TRIM(i.Descricao) descricao, i.Unid unid, i.TipoBalanca balanca,
                                  i.P1, i.P2, i.P3, i.P4, i.P5, i.P6, TRIM(g.Descricao) grupo, TRIM(gs.Descricao) subgrupo
                           FROM central.itens i LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
                           LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo WHERE i.CodDesativado = 0 AND i.CodigoBarra IS NOT NULL`);
    const { meses, de, ate } = mesesUltimos(DIAS);
    const d30 = new Date(); d30.setDate(d30.getDate() - 30); const de30 = iso(d30);
    const rows = [];
    for (const ln of LOJAS) {
      const custo = {}, est = {}, mcad = {}, ven = {};
      for (const r of await q(`SELECT CodigoBarra cod, Custo c FROM central.custoloja${ln}`).catch(e => { console.error('[RADAR-PRECIF] custoloja' + ln, e.message); return []; })) custo[r.cod] = num(r.c);
      for (const r of await q(`SELECT CodigoBarra cod, Qtd e FROM central.estoquen${ln}`).catch(e => { console.error('[RADAR-PRECIF] estoquen' + ln, e.message); return []; })) est[r.cod] = num(r.e);
      for (const r of await q(`SELECT CodigoBarra cod, MargemVarejo m FROM central.itens_margens WHERE nLoja=?`, [ln]).catch(() => [])) mcad[r.cod] = r.m != null ? +r.m : null;
      for (const ms of meses) {
        const rs = await q(`SELECT Codigo cod, SUM(QtdNovo) q, SUM(ValorTotalNovo) v, SUM(Custo) c, COUNT(DISTINCT Data) d,
                                   SUM(CASE WHEN Data >= ? THEN QtdNovo ELSE 0 END) q30, SUM(CASE WHEN Data >= ? THEN ValorTotalNovo ELSE 0 END) v30
                            FROM \`ln${ln}mes${ms.mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [de30, de30, ms.dIni, ms.dFim])
          .catch(e => { console.error(`[RADAR-PRECIF] ln${ln}mes${ms.mm}`, e.message); return []; });
        for (const r of rs) { const v = ven[r.cod] || (ven[r.cod] = { q: 0, v: 0, c: 0, d: 0, q30: 0, v30: 0 }); v.q += num(r.q); v.v += num(r.v); v.c += num(r.c); v.d += +r.d || 0; v.q30 += num(r.q30); v.v30 += num(r.v30); }
      }
      const lojaRows = [];
      for (const it of itens) {
        const v = ven[it.cod] || { q: 0, v: 0, c: 0, d: 0, q30: 0, v30: 0 }, e = est[it.cod] || 0;
        if (v.q <= 0 && e === 0) continue;                       // nada vendeu e nada em estoque: não avalia
        lojaRows.push({ loja: ln, cod: it.cod, descricao: it.descricao, unid: it.unid || '', balanca: !!it.balanca, grupo: it.grupo || null, subgrupo: it.subgrupo || null,
          preco: r2(num(it['P' + ln])), custo: r2(custo[it.cod] || 0), est: +e.toFixed(3), margemCad: mcad[it.cod] ?? null,
          q90: +v.q.toFixed(3), v90: r2(v.v), c90: r2(v.c), dias90: v.d, q30: +v.q30.toFixed(3), v30: r2(v.v30) });
      }
      // curva ABC da loja: por R$ e por quantidade (cortes 80/95 acumulados)
      abc(lojaRows, 'v90', 'abcR', 'rankR'); abc(lojaRows, 'q90', 'abcQ', 'rankQ');
      rows.push(...lojaRows);
      console.log(`[RADAR-PRECIF] L${ln}: ${lojaRows.length} itens`);
    }
    cache = { calculadoEm: new Date().toISOString(), de, ate, dias: DIAS, rows };
    aplicarRegrasTodas(); indexar();
    gravarJson(OUT, cache);
    console.log(`[RADAR-PRECIF] ok: ${rows.length} linhas em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  })().finally(() => { calculando = null; });
  return calculando;
}
function abc(rows, campo, alvo, rankAlvo) {
  const c = params.cortesABC || PARAMS_PADRAO.cortesABC;
  const com = rows.filter(r => r[campo] > 0).sort((a, b) => b[campo] - a[campo]);
  const tot = com.reduce((s, r) => s + r[campo], 0); let acc = 0;
  for (const r of rows) { r[alvo] = '-'; r[rankAlvo] = null; }
  com.forEach((r, i) => { acc += r[campo]; r[alvo] = acc / tot <= c.A ? 'A' : acc / tot <= c.B ? 'B' : 'C'; r[rankAlvo] = i + 1; });
}

// ── regras (recalculadas na hora quando os parâmetros mudam; não precisa ir no ERP)
function aplicarRegrasTodas() { for (const r of cache.rows) aplicarRegras(r); }
function aplicarRegras(r) {
  const P = params, excl = new Set((P.excluirGrupos || []).map(up));
  r.excluido = excl.has(up(r.grupo));
  const preco = r.preco, custo = r.custo;
  r.margem = preco > 0 && custo > 0 ? r1((preco - custo) / preco * 100) : null;
  r.markup = preco > 0 && custo > 0 ? r1((preco - custo) / custo * 100) : null;
  r.margemReal = r.v90 > 0 && r.c90 > 0 ? r1((r.v90 - r.c90) / r.v90 * 100) : null;
  r.negativo = r.est < 0; r.parado = r.est > 0 && r.q90 <= 0; r.abaixoCusto = preco > 0 && custo > 0 && preco < custo;
  r.papel = r.q90 <= 0 ? (r.est > 0 ? 'parado' : 'sem_venda') : r.abcQ === 'A' ? 'sensivel' : r.abcR === 'A' ? 'forte' : (r.abcQ === 'B' || r.abcR === 'B') ? 'normal' : 'cauda';
  const metaGrupo = P.metasGrupo[up(r.grupo)] ?? P.metaGeral;
  r.metaGrupo = metaGrupo;
  const aj = P.ajustePapel[r.papel] || 0;
  r.meta = Math.min(70, Math.max(5, metaGrupo + aj));
  r.precoSug = preco; r.delta = 0; r.acao = 'manter'; r.qProj = r.q90; r.vAtual = r2(r.q90 * preco); r.lucroAtual = r2(r.q90 * (preco - custo));
  r.vProj = r.vAtual; r.lucroProj = r.lucroAtual; r.dLucro = 0; r.dVenda = 0; r.margemSug = r.margem;
  if (r.excluido) { r.acao = 'excluido'; return r; }
  if (!(preco > 0) || !(custo > 0)) { r.acao = 'sem_dados'; return r; }
  if (r.papel === 'parado' || r.papel === 'sem_venda') { r.acao = r.abaixoCusto ? 'abaixo_custo' : r.papel; if (r.abaixoCusto) r.precoSug = arred(custo * (1 + P.markupMinimo / 100), P.terminacao); r.delta = r1((r.precoSug / preco - 1) * 100); return r; }
  // acima da meta: só baixa em item sensível/forte (cliente compara) e com folga; normal/cauda acima da meta é lucro, mantém
  if (r.margem >= r.meta && !((r.papel === 'sensivel' || r.papel === 'forte') && r.margem > r.meta + (P.folgaBaixar ?? 6))) return r;
  let alvo = custo / (1 - r.meta / 100);
  const maxUp = P.maxAumento[r.papel] ?? 8;
  if (alvo > preco * (1 + maxUp / 100)) alvo = preco * (1 + maxUp / 100);
  if (alvo < preco * (1 - P.maxReducao / 100)) alvo = preco * (1 - P.maxReducao / 100);
  alvo = Math.max(alvo, custo * (1 + P.markupMinimo / 100));
  let sug = arred(alvo, P.terminacao);
  let delta = (sug / preco - 1) * 100;
  if (Math.abs(delta) < P.deltaMinimo && !r.abaixoCusto) { sug = preco; delta = 0; }
  r.precoSug = sug; r.delta = r1(delta);
  r.acao = r.abaixoCusto ? 'abaixo_custo' : delta > 0 ? 'subir' : delta < 0 ? 'baixar' : 'manter';
  const e = P.elasticidade[r.papel] ?? -0.7;
  r.qProj = +(r.q90 * Math.max(0, 1 + e * delta / 100)).toFixed(3);
  r.vProj = r2(r.qProj * sug); r.lucroProj = r2(r.qProj * (sug - custo));
  r.margemSug = r1((sug - custo) / sug * 100);
  r.dLucro = r2(r.lucroProj - r.lucroAtual); r.dVenda = r2(r.vProj - r.vAtual);
  return r;
}

function indexar() { idx = {}; if (cache) for (const r of cache.rows) (idx[r.cod] || (idx[r.cod] = [])).push(r); }

// decisão da tela: preço aceito (ou ignorado) por loja × produto
function decisao(r) { return decisoes[`${r.loja}|${r.cod}`] || null; }
function setDecisao({ loja, cod, preco, status, usuario, todasLojas }) {
  const lojas = todasLojas ? LOJAS : [+loja];
  const em = new Date().toISOString(); const out = [];
  for (const ln of lojas) {
    const k = `${ln}|${cod}`;
    if (!status) { delete decisoes[k]; continue; }
    decisoes[k] = { preco: status === 'aceita' ? r2(num(preco)) : null, status, usuario: usuario || null, em };
    out.push(k);
  }
  gravarJson(DEC, decisoes);
  return out;
}
function getDecisoes() { return decisoes; }

// projeção com o que já foi aceito na tela (preço da decisão) — usado nos cartões
function projecaoAceitas(rows) {
  let v = 0, l = 0, n = 0;
  for (const r of rows) {
    const d = decisao(r);
    if (!d || d.status !== 'aceita' || !(d.preco > 0) || !(r.custo > 0) || r.q90 <= 0) continue;
    const delta = (d.preco / r.preco - 1) * 100, e = params.elasticidade[r.papel] ?? -0.7;
    const qp = r.q90 * Math.max(0, 1 + e * delta / 100);
    v += qp * d.preco - r.vAtual; l += qp * (d.preco - r.custo) - r.lucroAtual; n++;
  }
  return { n, dVenda: r2(v), dLucro: r2(l) };
}

function filtrar(f) {
  if (!cache) return [];
  const b = (f.busca || '').toLowerCase(), fx = [];
  if (f.loja) fx.push(r => r.loja === +f.loja);
  if (f.grupo) fx.push(r => up(r.grupo) === up(f.grupo));
  if (f.papel) fx.push(r => r.papel === f.papel);
  if (f.abc) fx.push(r => r.abcQ === f.abc || r.abcR === f.abc);
  if (f.acao === 'negativo') fx.push(r => r.negativo);
  else if (f.acao === 'parado') fx.push(r => r.parado);
  else if (f.acao === 'sugestao') fx.push(r => r.acao === 'subir' || r.acao === 'baixar' || r.acao === 'abaixo_custo');
  else if (f.acao === 'aceitas') fx.push(r => (decisao(r) || {}).status === 'aceita');
  else if (f.acao === 'ignoradas') fx.push(r => (decisao(r) || {}).status === 'ignorada');
  else if (f.acao) fx.push(r => r.acao === f.acao);
  if (!f.incluirExcluidos) fx.push(r => !r.excluido);
  if (f.comVenda) fx.push(r => r.q90 > 0);
  if (b) fx.push(r => r.cod.includes(b) || (r.descricao || '').toLowerCase().includes(b) || (r.grupo || '').toLowerCase().includes(b) || (r.subgrupo || '').toLowerCase().includes(b));
  return cache.rows.filter(r => fx.every(fn => fn(r)));
}

// KPIs de um conjunto de linhas (uma loja ou todas)
function resumo(rows) {
  const R = { n: 0, venda90: 0, custo90: 0, vendaTab: 0, lucroTab: 0, vProj: 0, lucroProj: 0, subir: 0, baixar: 0, manter: 0, abaixoCusto: 0, negativos: 0, parados: 0, valorParados: 0, semDados: 0,
              lucroSubir: 0, lucroBaixar: 0, vendaSubir: 0, vendaBaixar: 0 };
  for (const r of rows) {
    if (r.excluido) continue;
    R.n++; R.venda90 += r.v90; R.custo90 += r.c90;
    if (r.negativo) R.negativos++;
    if (r.parado) { R.parados++; R.valorParados += r.est * r.custo; }
    if (r.acao === 'sem_dados') R.semDados++;
    if (!(r.preco > 0) || !(r.custo > 0) || r.q90 <= 0) continue;
    R.vendaTab += r.vAtual; R.lucroTab += r.lucroAtual; R.vProj += r.vProj; R.lucroProj += r.lucroProj;
    if (r.acao === 'subir') { R.subir++; R.lucroSubir += r.lucroProj - r.lucroAtual; R.vendaSubir += r.vProj - r.vAtual; }
    else if (r.acao === 'baixar') { R.baixar++; R.lucroBaixar += r.lucroProj - r.lucroAtual; R.vendaBaixar += r.vProj - r.vAtual; }
    else if (r.acao === 'abaixo_custo') { R.abaixoCusto++; R.lucroSubir += r.lucroProj - r.lucroAtual; R.vendaSubir += r.vProj - r.vAtual; }
    else R.manter++;
  }
  const pct = (a, b) => b > 0 ? r1(a / b * 100) : null;
  R.margemReal = pct(R.venda90 - R.custo90, R.venda90); R.markupReal = pct(R.venda90 - R.custo90, R.custo90);
  R.margemTab = pct(R.lucroTab, R.vendaTab); R.markupTab = pct(R.lucroTab, R.vendaTab - R.lucroTab);
  R.margemProj = pct(R.lucroProj, R.vProj); R.markupProj = pct(R.lucroProj, R.vProj - R.lucroProj);
  R.dVenda = r2(R.vProj - R.vendaTab); R.dLucro = r2(R.lucroProj - R.lucroTab);
  const ac = projecaoAceitas(rows); R.aceitas = ac.n; R.dVendaAceitas = ac.dVenda; R.dLucroAceitas = ac.dLucro;
  R.margemAceitas = pct(R.lucroTab + ac.dLucro, R.vendaTab + ac.dVenda);
  R.meta = params.metaGeral;
  for (const k of ['venda90', 'custo90', 'vendaTab', 'lucroTab', 'vProj', 'lucroProj', 'valorParados', 'lucroSubir', 'lucroBaixar', 'vendaSubir', 'vendaBaixar']) R[k] = r2(R[k]);
  return R;
}
// direcionamento por departamento (grupo)
function grupos(rows) {
  const G = {};
  for (const r of rows) {
    if (r.excluido) continue;
    const k = r.grupo || '(sem grupo)';
    const g = G[k] || (G[k] = { grupo: k, itens: 0, v90: 0, c90: 0, vendaTab: 0, lucroTab: 0, vProj: 0, lucroProj: 0, subir: 0, baixar: 0, abaixoCusto: 0, negativos: 0, parados: 0, meta: params.metasGrupo[up(k)] ?? params.metaGeral });
    g.itens++; g.v90 += r.v90; g.c90 += r.c90;
    if (r.negativo) g.negativos++; if (r.parado) g.parados++;
    if (!(r.preco > 0) || !(r.custo > 0) || r.q90 <= 0) continue;
    g.vendaTab += r.vAtual; g.lucroTab += r.lucroAtual; g.vProj += r.vProj; g.lucroProj += r.lucroProj;
    if (r.acao === 'subir') g.subir++; else if (r.acao === 'baixar') g.baixar++; else if (r.acao === 'abaixo_custo') g.abaixoCusto++;
  }
  const tot = Object.values(G).reduce((s, g) => s + g.v90, 0);
  return Object.values(G).map(g => ({ ...g, share: tot > 0 ? r1(g.v90 / tot * 100) : 0,
    margemReal: g.v90 > 0 ? r1((g.v90 - g.c90) / g.v90 * 100) : null, margemTab: g.vendaTab > 0 ? r1(g.lucroTab / g.vendaTab * 100) : null,
    margemProj: g.vProj > 0 ? r1(g.lucroProj / g.vProj * 100) : null, dLucro: r2(g.lucroProj - g.lucroTab), dVenda: r2(g.vProj - g.vendaTab),
    v90: r2(g.v90), c90: r2(g.c90), vendaTab: r2(g.vendaTab), lucroTab: r2(g.lucroTab), vProj: r2(g.vProj), lucroProj: r2(g.lucroProj) }))
    .map(g => ({ ...g, gap: g.margemReal != null ? r1(g.meta - g.margemReal) : null }))
    .sort((a, b) => b.v90 - a.v90);
}

function produto(cod) { if (!idx) indexar(); return (idx && idx[cod]) ? idx[cod].map(r => ({ ...r, decisao: decisao(r) })) : []; }
function estado() { return { calculadoEm: cache?.calculadoEm || null, de: cache?.de || null, ate: cache?.ate || null, dias: DIAS, linhas: cache?.rows?.length || 0, calculando: !!calculando,
  grupos: cache ? [...new Set(cache.rows.map(r => r.grupo).filter(Boolean))].sort() : [] }; }

const ACAO_PT = { subir: 'Subir preço', baixar: 'Baixar preço', manter: 'Manter', abaixo_custo: 'ABAIXO DO CUSTO', parado: 'Parado (estoque sem venda)', sem_venda: 'Sem venda', sem_dados: 'Sem custo/preço', excluido: 'Fora da análise' };
const PAPEL_PT = { sensivel: 'Sensível (curva A qtd)', forte: 'Forte (curva A R$)', normal: 'Normal (curva B)', cauda: 'Cauda (curva C)', parado: 'Parado', sem_venda: 'Sem venda' };
const csvNum = v => v == null ? '' : String(v).replace('.', ',');
// CSV pra digitar no ERP: aceitas (padrão) ou todas as sugestões da seleção
function csv(rows, soAceitas) {
  const head = 'Loja;Código;Descrição;Grupo;Papel;Curva qtd;Curva R$;Venda 90 d (qtd);Venda 90 d (R$);Custo;Preço atual;Margem atual (%);Markup atual (%);Meta (%);Preço sugerido;Preço aceito;Δ (%);Ação;Estoque;Usuário;Quando';
  const out = [];
  for (const r of rows) {
    const d = decisao(r);
    if (soAceitas && (!d || d.status !== 'aceita')) continue;
    const pn = d && d.status === 'aceita' ? d.preco : r.precoSug;
    out.push(['L' + r.loja + ' ' + NOMES[r.loja], r.cod, r.descricao, r.grupo || '', PAPEL_PT[r.papel] || r.papel, r.abcQ, r.abcR, csvNum(r.q90), csvNum(r.v90), csvNum(r.custo), csvNum(r.preco), csvNum(r.margem), csvNum(r.markup), csvNum(r.meta),
      csvNum(r.precoSug), d && d.status === 'aceita' ? csvNum(d.preco) : '', csvNum(r1((pn / r.preco - 1) * 100)), ACAO_PT[r.acao] || r.acao, csvNum(r.est), d ? d.usuario || '' : '', d ? d.em.slice(0, 16).replace('T', ' ') : '']
      .map(x => String(x ?? '').replace(/;/g, ',')).join(';'));
  }
  return '﻿' + [head].concat(out).join('\r\n');
}

function agendar() {
  const idade = cache ? Date.now() - new Date(cache.calculadoEm).getTime() : Infinity;
  if (idade > 20 * 3600 * 1000) setTimeout(() => calcular().catch(e => console.error('[RADAR-PRECIF]', e.message)), 120 * 1000);
  setInterval(() => { const d = new Date(); if (d.getHours() === 5 && d.getMinutes() === 20) calcular().catch(e => console.error('[RADAR-PRECIF]', e.message)); }, 60 * 1000);
}

module.exports = { init, agendar, calcular, filtrar, resumo, grupos, produto, estado, csv, getParams, setParams, resetParams, setDecisao, getDecisoes, decisao, NOMES, LOJAS, ACAO_PT, PAPEL_PT };
