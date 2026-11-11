'use strict';
// lib/alertas-preco.js — Alertas de preço pro setor de precificação (Tiago, 11/11/2026).
//
// "Não podemos vender produto negativo: alerta produto abaixo do custo pra Leni, sugere os que estão abaixo da margem.
//  Começa nas lojas-teste (E1 e E2), aumenta a assertividade e, se der certo, passa pras outras lojas."
//
// SÓ LEITURA: nada aqui muda preço. Os dados vêm do espelho no Postgres (cadastro_item, estoque_loja, venda_dia_produto)
// e de uma leitura leve das listas de compra no ERP (c_cotacao_lista / c_cotacao_lista_itens), guardada por 6 h.
//
// Regras da rede (Tiago, 10-11/11/26):
//   - carnes (grupo 45 AÇOUGUE) ficam FORA de tudo;
//   - preço terminado em 7 = REBAIXA (perto de vencer); em 8 = PROMOÇÃO da diretoria → o robô não sugere preço neles,
//     só avisa quando estão abaixo do custo;
//   - produto de ALTO GIRO (os N mais vendidos da loja) nunca recebe sugestão de aumento: só o aviso;
//   - listas de cotação (277 Alimentos, 218 Perfumaria) não recebem sugestão: só o aviso;
//   - todo preço sugerido termina em 9 e sobe no máximo `tetoAumentoPct` de uma vez (margem sobe aos poucos).
//
// O que a Leni responde em cada alerta (corrigido / é promoção / está certo) fica em data/alertas-preco-respostas.json e
// some da lista enquanto preço e custo não mudarem; cada resposta também vai pra data/alertas-preco-log.jsonl, que é
// de onde sai a assertividade.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const F_PARAMS = path.join(DATA, 'alertas-preco-params.json');
const F_RESP = path.join(DATA, 'alertas-preco-respostas.json');
const F_LOG = path.join(DATA, 'alertas-preco-log.jsonl');

const PARAMS_PADRAO = {
  lojas: [1, 2],            // lojas-teste (diretor liberou E1 e E2 em 11/11/26)
  gruposFora: [45, 48, 46, 64], // 45 AÇOUGUE (carnes) · 48 SALGADO (charque: "não mudar") · 46 FLV (hortifrúti: "ainda não") · 64 TAXA DE ENTREGA — Tiago, 11/11/26
  listasCotacao: [277, 218],// chegam pela cotação: sem sugestão de preço
  topGiro: 200,             // os N mais vendidos (nº de vendas, 60 dias) de cada loja = protegidos
  tetoAumentoPct: 10,       // sugestão sobe no máximo isso sobre o preço atual
  pontosAbaixo: 8,          // "abaixo da margem" = margem atual N pontos abaixo da margem da lista/grupo na loja
  pontosQueda: 3,           // "custo subiu" = margem atual N pontos abaixo da que o produto vinha fazendo
  diasCompra: 21,           // ...e a última compra foi há no máximo N dias
  margemMax: 45,            // teto da margem de referência usada na sugestão
  // Meta de margem sobre venda da LOJA (Tiago, 11/11/26: "quero metas ou algo mostrando que vamos evoluir"; sobe aos poucos
  // até o objetivo): partida = margem de outubro/26 na tela Comparativos; meta do mês = partida + passo × nº de meses desde o início.
  // 11/11 (tarde): 0,5 pt por mês era lento ("precisa mais rápido") → escada: 1º mês sobe pouco, depois 1 pt por mês, 30% em março/27.
  // metaEscada = meta de cada mês a partir de metaInicio; acabou a escada, vale o objetivo. Sem escada, usa partida + passo × mês.
  // 11/11 (noite): ainda lento ("podemos apertar mais... vendas de final de ano, podemos bater") → 30% em janeiro/27.
  metaObjetivo: 30, metaPasso: 1.5, metaInicio: '2026-11', metaPartida: { 1: 26.0, 2: 26.0 }, metaEscada: [27, 28.5, 30]
};
const TIPOS = {
  abaixo_custo: { nome: 'Abaixo do custo', grav: 3 },
  custo_subiu: { nome: 'Custo subiu, preço não acompanhou', curto: 'Custo subiu', grav: 2 },
  sem_custo: { nome: 'Sem custo no cadastro', curto: 'Sem custo', grav: 2 },
  abaixo_margem: { nome: 'Abaixo da margem', grav: 1 }
};
const RESPOSTAS = { corrigido: 'Corrigi', promocao: 'É promoção/rebaixa', certo: 'Está certo assim' };
const CICLO_MS = 30 * 60 * 1000, LISTAS_MS = 6 * 60 * 60 * 1000;

let deps = null, params = null, cache = null, calculando = null, listas = { em: 0, nome: {}, de: {} }, timer = null;

const r2 = v => Math.round((+v || 0) * 100) / 100;
const r1 = v => Math.round((+v || 0) * 10) / 10;
const fmt = v => 'R$ ' + (+v || 0).toFixed(2).replace('.', ',');          // texto dos alertas em pt-BR
const fpc = v => String(r1(v)).replace('.', ',') + '%';
const lerJson = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } };
const gravarJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const diasAtras = n => { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d); };
const finalPreco = p => Math.round(p * 100) % 10;
/** Maior preço terminado em 9 centavos que não passa de `v` (12,43 → 12,39; 12,99 → 12,99). */
function terminaEm9(v) { const c = Math.floor(v * 100 + 1e-6); return (Math.floor((c - 9) / 10) * 10 + 9) / 100; }

function mesclar(p) {
  const o = JSON.parse(JSON.stringify(PARAMS_PADRAO));
  if (!p) return o;
  if (p.metaInicio && /^\d{4}-\d{2}$/.test(p.metaInicio)) o.metaInicio = p.metaInicio;
  if (Array.isArray(p.metaEscada)) o.metaEscada = p.metaEscada.map(Number).filter(x => x > 0 && x < 100);
  if (p.metaPartida && typeof p.metaPartida === 'object') for (const k of Object.keys(p.metaPartida)) if (isFinite(+p.metaPartida[k]) && +p.metaPartida[k] > 0) o.metaPartida[+k] = +p.metaPartida[k];
  for (const k of ['topGiro', 'tetoAumentoPct', 'pontosAbaixo', 'pontosQueda', 'diasCompra', 'margemMax', 'metaObjetivo', 'metaPasso']) if (p[k] != null && isFinite(+p[k]) && +p[k] >= 0) o[k] = +p[k];
  for (const k of ['lojas', 'gruposFora', 'listasCotacao']) if (Array.isArray(p[k])) { const a = p[k].map(Number).filter(x => x > 0); if (k !== 'lojas' || a.length) o[k] = a; }
  o.lojas = o.lojas.filter(l => l >= 1 && l <= 6);
  if (!o.lojas.length) o.lojas = PARAMS_PADRAO.lojas.slice();
  return o;
}
function getParams() { return params; }
function setParams(p) { params = mesclar({ ...params, ...p }); gravarJson(F_PARAMS, params); cache = null; return params; }

// ── listas de compra (ERP, só leitura, 1 vez a cada 6 h) ───────────────────────────────────────────────────────────
async function lerListas() {
  if (Date.now() - listas.em < LISTAS_MS && Object.keys(listas.de).length) return listas;
  try {
    const ls = await deps.q('SELECT nReg, TRIM(Nome) nome FROM central.c_cotacao_lista');
    const li = await deps.q('SELECT nCotacao lid, TRIM(Codigobarra) cod FROM central.c_cotacao_lista_itens ORDER BY nCotacao');
    const nome = {}, de = {};
    for (const l of ls) nome[+l.nReg] = String(l.nome || '').trim();
    for (const r of li) { const k = String(r.cod).trim(); if (nome[+r.lid] != null && de[k] == null) de[k] = +r.lid; }
    listas = { em: Date.now(), nome, de };
  } catch (e) { if (!Object.keys(listas.de).length) listas = { em: 0, nome: {}, de: {}, erro: e.message }; else listas.erro = e.message; }
  return listas;
}

// ── cálculo ────────────────────────────────────────────────────────────────────────────────────────────────────────
function chaveResp(a) { return `${a.loja}|${a.cod}|${a.tipo}`; }
function respostaValida(resp, a) { return !!resp && Math.abs((resp.preco || 0) - (a.preco || 0)) < 0.005 && Math.abs((resp.custo || 0) - (a.custo || 0)) < 0.005; }

async function calcular() {
  if (calculando) return calculando;
  calculando = (async () => {
    const t0 = Date.now(), pq = deps.pq, erros = [];
    const L = await lerListas(); if (L.erro) erros.push('listas de compra: ' + L.erro);
    const fora = new Set(params.gruposFora), cotacao = new Set(params.listasCotacao);
    const hoje = isoLocal(new Date()), d60 = diasAtras(60), d30 = diasAtras(30), dCompra = diasAtras(params.diasCompra);
    const cad = await pq(`SELECT TRIM(i.codigo) cod, TRIM(i.descricao) d, i.codgrupo cg, TRIM(g.descricao) grupo, i.p1, i.p2, i.p3, i.p4, i.p5, i.p6
                          FROM cadastro_item i LEFT JOIN cadastro_grupo g ON g.codgrupo = i.codgrupo WHERE i.desativado = 0`);
    const item = {}; for (const r of cad) item[r.cod] = r;
    const alertas = [], porLoja = {};
    for (const ln of params.lojas) {
      const est = await pq(`SELECT TRIM(codigo) cod, custo, qtd, to_char(ultima_compra, 'YYYY-MM-DD') uc FROM estoque_loja WHERE loja = $1`, [ln]);
      const E = {}; for (const r of est) E[r.cod] = { custo: +r.custo || 0, qtd: +r.qtd || 0, uc: r.uc || null };
      const v = await pq(`SELECT TRIM(codigo) cod,
                                 SUM(CASE WHEN custo > 0 THEN valor ELSE 0 END) v, SUM(CASE WHEN custo > 0 THEN custo ELSE 0 END) c, SUM(itens) n,
                                 SUM(CASE WHEN dia >= $3 THEN qtd ELSE 0 END) q30, SUM(CASE WHEN dia >= $3 THEN valor ELSE 0 END) v30
                          FROM venda_dia_produto WHERE loja = $1 AND dia BETWEEN $2 AND $4 GROUP BY 1`, [ln, d60, d30, hoje]);
      const V = {}; for (const r of v) V[r.cod] = { v: +r.v || 0, c: +r.c || 0, n: +r.n || 0, q30: +r.q30 || 0, v30: +r.v30 || 0 };
      // alto giro: os N com mais vendas (nº de cupons-item) em 60 dias, fora carnes
      const giro = new Set(Object.keys(V).filter(k => item[k] && !fora.has(+item[k].cg)).sort((a, b) => V[b].n - V[a].n).slice(0, params.topGiro));
      // margem de referência na loja: da lista de compra; sem lista, do grupo
      const ref = {};
      for (const k of Object.keys(V)) { const it = item[k]; if (!it || !(V[k].v > 0)) continue; const kk = L.de[k] ? 'L' + L.de[k] : 'G' + it.cg; const t = ref[kk] = ref[kk] || { v: 0, c: 0 }; t.v += V[k].v; t.c += V[k].c; }
      const res = porLoja[ln] = { loja: ln, produtos: 0, protegidos: giro.size, promocao: 0, rebaixa: 0 };
      const cods = new Set([...Object.keys(V), ...Object.keys(E).filter(k => E[k].qtd > 0)]);
      for (const cod of cods) {
        const it = item[cod]; if (!it || fora.has(+it.cg)) continue;
        const p = +it['p' + ln] || 0; if (!(p > 0)) continue;
        const e = E[cod] || { custo: 0, qtd: 0, uc: null }, vv = V[cod] || { v: 0, c: 0, n: 0, q30: 0, v30: 0 };
        if (!(vv.q30 > 0) && !(e.qtd > 0)) continue;
        res.produtos++;
        const fim = finalPreco(p), promo = fim === 8, rebaixa = fim === 7;
        if (promo) res.promocao++; if (rebaixa) res.rebaixa++;
        const lid = L.de[cod] || 0, ehCotacao = cotacao.has(lid), protegido = giro.has(cod);
        const base = { loja: ln, cod, desc: it.d || '', grupo: it.grupo || '', lista: lid ? `${lid} ${L.nome[lid] || ''}`.trim() : '', listaId: lid || null,
          preco: r2(p), custo: r2(e.custo), estoque: r2(e.qtd), qtd30: r2(vv.q30), venda30: r2(vv.v30), ultCompra: e.uc,
          condicao: rebaixa ? 'rebaixa' : promo ? 'promocao' : 'normal', protegido, cotacao: ehCotacao };
        if (!(e.custo > 0)) {
          if (vv.q30 > 0 || e.qtd > 0) alertas.push({ ...base, tipo: 'sem_custo', txt: 'Produto ativo sem custo no cadastro da loja' + (vv.v30 > 0 ? ` · vendeu ${fmt(vv.v30)} em 30 dias` : '') });
          continue;
        }
        const m = (p - e.custo) / p * 100, k = lid ? 'L' + lid : 'G' + it.cg, R = ref[k];
        const mRef = R && R.v >= 300 ? (R.v - R.c) / R.v * 100 : null, mProd = vv.v >= 50 ? (vv.v - vv.c) / vv.v * 100 : null;
        const outros = [1, 2, 3, 4, 5, 6].filter(x => x !== ln).map(x => +it['p' + x] || 0).filter(x => x > 0);
        const maxRede = outros.length ? Math.max(...outros) : 0;
        base.margem = r1(m); base.margemRef = mRef == null ? null : r1(mRef); base.margemVinha = mProd == null ? null : r1(mProd); base.precoRede = r2(maxRede);
        // preço sugerido: só em preço normal, fora de cotação e de alto giro
        const podeSugerir = !promo && !rebaixa && !ehCotacao && !protegido;
        const sugerir = alvoMargem => {
          if (!podeSugerir || alvoMargem == null) return null;
          let alvo = e.custo / (1 - Math.min(alvoMargem, params.margemMax) / 100);
          alvo = Math.min(alvo, p * (1 + params.tetoAumentoPct / 100));
          if (maxRede > p) alvo = Math.min(alvo, maxRede);
          const s = terminaEm9(alvo);
          return s > p + 0.009 ? r2(s) : null;
        };
        const porque = promo ? 'preço de promoção (final 8)' : rebaixa ? 'preço de rebaixa (final 7)' : ehCotacao ? 'lista de cotação' : protegido ? 'alto giro: não sobe preço, negociar custo' : null;
        if (p < e.custo) {
          const s = podeSugerir ? (() => { const x = terminaEm9(Math.max(e.custo * 1.05, e.custo / (1 - Math.min(mRef == null ? 20 : mRef, params.margemMax) / 100))); return x > p ? r2(x) : null; })() : null;
          alertas.push({ ...base, tipo: 'abaixo_custo', sugerido: s, nota: porque,
            perdaMes: r2((e.custo - p) * vv.q30), txt: `Preço ${fmt(p)} abaixo do custo ${fmt(e.custo)}` + (vv.q30 > 0 ? ` · perde ${fmt((e.custo - p) * vv.q30)} por mês nesse ritmo` : '') });
          continue;
        }
        if (promo || rebaixa) continue;   // promoção e rebaixa acima do custo: decisão comercial, sem alerta
        if (e.uc && e.uc >= dCompra && mProd != null && m < mProd - params.pontosQueda) {
          const s = sugerir(mProd);
          alertas.push({ ...base, tipo: 'custo_subiu', sugerido: s, nota: porque, ganhoMes: s ? r2((s - p) * vv.q30) : 0,
            txt: `Comprou em ${e.uc.slice(8, 10)}/${e.uc.slice(5, 7)} e a margem caiu de ${fpc(mProd)} pra ${fpc(m)}` });
          continue;
        }
        if (podeSugerir && mRef != null && m < mRef - params.pontosAbaixo && vv.q30 > 0) {
          const s = sugerir(mRef);
          if (s && s >= p * 1.03) alertas.push({ ...base, tipo: 'abaixo_margem', sugerido: s, nota: null, ganhoMes: r2((s - p) * vv.q30),
            txt: `Margem ${fpc(m)} contra ${fpc(mRef)} ${lid ? 'da lista' : 'do grupo'} nesta loja` });
        }
      }
    }
    for (const a of alertas) a.grav = TIPOS[a.tipo].grav;
    alertas.sort((a, b) => b.grav - a.grav || (b.perdaMes || b.ganhoMes || b.venda30 || 0) - (a.perdaMes || a.ganhoMes || a.venda30 || 0));
    cache = { calculadoEm: new Date().toISOString(), ms: Date.now() - t0, lojas: params.lojas.slice(), porLoja, alertas, erros };
    console.log(`[ALERTAS-PRECO] ${alertas.length} alertas em ${cache.ms} ms (lojas ${params.lojas.join(',')})${erros.length ? ' · ' + erros.join('; ') : ''}`);
    return cache;
  })().finally(() => { calculando = null; });
  return calculando;
}

async function garantir() { if (!cache) await calcular(); return cache; }

/** Alertas em aberto (sem resposta válida) + os respondidos, com o resumo por loja e tipo. */
async function consultar(opt = {}) {
  const c = await garantir(); const resp = lerJson(F_RESP, {});
  const abertos = [], respondidos = [];
  for (const a of c.alertas) {
    if (opt.loja && a.loja !== +opt.loja) continue;
    const r = resp[chaveResp(a)];
    if (respostaValida(r, a)) respondidos.push({ ...a, resposta: r }); else abertos.push(a);
  }
  const resumo = {};
  for (const ln of c.lojas) resumo[ln] = { ...(c.porLoja[ln] || { loja: ln }), abertos: 0, porTipo: Object.fromEntries(Object.keys(TIPOS).map(t => [t, 0])), perdaMes: 0, ganhoMes: 0 };
  for (const a of abertos) { const s = resumo[a.loja]; if (!s) continue; s.abertos++; s.porTipo[a.tipo]++; s.perdaMes = r2(s.perdaMes + (a.perdaMes || 0)); s.ganhoMes = r2(s.ganhoMes + (a.ganhoMes || 0)); }
  return { calculadoEm: c.calculadoEm, calculando: !!calculando, lojas: c.lojas, resumo, abertos, respondidos: opt.respondidos ? respondidos : undefined, nRespondidos: respondidos.length,
    tipos: TIPOS, respostas: RESPOSTAS, params, erros: c.erros, assertividade: assertividade(), metas: await metas().catch(() => null) };
}

function responder({ loja, cod, tipo, resp }, usuario) {
  if (!RESPOSTAS[resp]) throw new Error('Resposta inválida');
  if (!TIPOS[tipo]) throw new Error('Tipo de alerta inválido');
  const a = cache && cache.alertas.find(x => x.loja === +loja && x.cod === String(cod) && x.tipo === tipo);
  if (!a) throw new Error('Alerta não encontrado (recarregue a tela)');
  const todas = lerJson(F_RESP, {});
  const reg = { resp, por: usuario || null, em: new Date().toISOString(), preco: a.preco, custo: a.custo };
  todas[chaveResp(a)] = reg; gravarJson(F_RESP, todas);
  try { fs.appendFileSync(F_LOG, JSON.stringify({ ...reg, loja: a.loja, cod: a.cod, desc: a.desc, tipo, condicao: a.condicao, sugerido: a.sugerido || null, margem: a.margem }) + '\n'); } catch (e) {}
  return { ok: true };
}
function desfazer({ loja, cod, tipo }, usuario) {
  const todas = lerJson(F_RESP, {}); const k = `${+loja}|${cod}|${tipo}`;
  if (!todas[k]) return { ok: true };
  delete todas[k]; gravarJson(F_RESP, todas);
  try { fs.appendFileSync(F_LOG, JSON.stringify({ resp: 'desfeito', por: usuario || null, em: new Date().toISOString(), loja: +loja, cod, tipo }) + '\n'); } catch (e) {}
  return { ok: true };
}
/** De tudo o que já foi respondido: quanto era alerta "de verdade" (corrigido) × descartado (promoção / está certo). */
function assertividade() {
  const out = { total: 0, corrigido: 0, promocao: 0, certo: 0, pct: null };
  let txt = ''; try { txt = fs.readFileSync(F_LOG, 'utf8'); } catch (e) { return out; }
  for (const l of txt.split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (out[r.resp] != null && r.resp !== 'total') { out[r.resp]++; out.total++; } } catch (e) {} }
  out.pct = out.total ? Math.round(out.corrigido / out.total * 100) : null;
  return out;
}

/** Resumo enxuto pra TV da sala de precificação. */
// Meta da loja: margem sobre venda do mês (mesma conta da tela Comparativos: venda_dia_loja, custo + custo estimado da venda
// sem custo) contra a partida, a meta do mês e o objetivo. Cada ponto de margem vale 1% da venda projetada do mês.
let metasCache = { em: 0, v: null };
async function metas() {
  if (metasCache.v && Date.now() - metasCache.em < 10 * 60 * 1000) return metasCache.v;
  const h = new Date(), ano = h.getFullYear(), mes = h.getMonth() + 1, mm = String(mes).padStart(2, '0');
  const dIni = `${ano}-${mm}-01`, dHoje = isoLocal(h), diasMes = new Date(ano, mes, 0).getDate(), diaHoje = h.getDate();
  const [ai, mi] = params.metaInicio.split('-').map(Number); const nMes = Math.max(1, (ano - ai) * 12 + (mes - mi) + 1);
  const corr = {}; try { for (const l of fs.readFileSync(F_LOG, 'utf8').split('\n')) { if (!l) continue; const r = JSON.parse(l); if (r.resp === 'corrigido' && String(r.em).slice(0, 7) === `${ano}-${mm}`) corr[r.loja] = (corr[r.loja] || 0) + 1; } } catch (e) {}
  const out = {};
  const rows = await deps.pq(`SELECT loja, SUM(valor) v, SUM(custo + COALESCE(custo_est, 0)) c, COUNT(*) dias FROM venda_dia_loja WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 GROUP BY loja`, [params.lojas, dIni, dHoje]);
  for (const ln of params.lojas) {
    const r = rows.find(x => +x.loja === ln) || { v: 0, c: 0 }; const v = +r.v || 0, c = +r.c || 0;
    const partida = params.metaPartida[ln] || null, atual = v > 0 ? (v - c) / v * 100 : null;
    const escada = params.metaEscada || [];
    const metaMes = escada.length ? (nMes <= escada.length ? escada[nMes - 1] : params.metaObjetivo) : partida == null ? null : Math.min(params.metaObjetivo, partida + params.metaPasso * nMes);
    const proj = diaHoje > 0 ? v / diaHoje * diasMes : 0;
    out[ln] = { loja: ln, mes: `${mm}/${ano}`, dia: diaHoje, vendaMes: r2(v), vendaProjetada: r2(proj), margem: atual == null ? null : r2(atual), partida, metaMes: metaMes == null ? null : r2(metaMes), objetivo: params.metaObjetivo,
      evolucao: atual == null || partida == null ? null : r2(atual - partida), faltaMetaPts: atual == null || metaMes == null ? null : r2(metaMes - atual),
      faltaMetaReais: atual == null || metaMes == null ? null : r2((metaMes - atual) / 100 * proj), faltaObjetivoReais: atual == null ? null : r2((params.metaObjetivo - atual) / 100 * proj), corrigidosMes: corr[ln] || 0 };
  }
  metasCache = { em: Date.now(), v: out };
  return out;
}

async function painel() {
  const c = await consultar();
  const topo = t => c.abertos.filter(a => a.tipo === t).slice(0, 12).map(a => ({ loja: a.loja, desc: a.desc, preco: a.preco, custo: a.custo, sugerido: a.sugerido || null, margem: a.margem == null ? null : a.margem, condicao: a.condicao, txt: a.txt, perdaMes: a.perdaMes || 0, ganhoMes: a.ganhoMes || 0 }));
  // por loja (Tiago, 11/11: "o painel dela quebrar por lojas E1 e E2"): os mais urgentes de cada tipo em cada loja
  const porLoja = {};
  for (const ln of c.lojas) { porLoja[ln] = {}; for (const t of Object.keys(TIPOS)) porLoja[ln][t] = c.abertos.filter(a => a.loja === ln && a.tipo === t).slice(0, 12).map(a => ({ loja: a.loja, desc: a.desc, preco: a.preco, custo: a.custo, sugerido: a.sugerido || null, margem: a.margem == null ? null : a.margem, condicao: a.condicao, protegido: !!a.protegido, perdaMes: a.perdaMes || 0, ganhoMes: a.ganhoMes || 0, qtd30: a.qtd30 || 0 })); }
  const mt = await metas().catch(() => null);
  return { calculadoEm: c.calculadoEm, lojas: c.lojas, resumo: c.resumo, tipos: TIPOS, assertividade: c.assertividade, porLoja, metas: mt,
    abaixo_custo: topo('abaixo_custo'), custo_subiu: topo('custo_subiu'), abaixo_margem: topo('abaixo_margem'), sem_custo: topo('sem_custo') };
}

function estado() { return { calculadoEm: cache ? cache.calculadoEm : null, calculando: !!calculando, alertas: cache ? cache.alertas.length : 0, erros: cache ? cache.erros : [] }; }

function init(d) {
  deps = d; params = mesclar(lerJson(F_PARAMS, null));
  if (timer) clearInterval(timer);
  const roda = () => { const h = new Date().getHours(); if (h >= 7 && h < 20) calcular().catch(e => console.error('[ALERTAS-PRECO]', e.message)); };
  const t = setTimeout(() => calcular().catch(e => console.error('[ALERTAS-PRECO] 1ª carga:', e.message)), 150 * 1000); if (t.unref) t.unref();
  timer = setInterval(roda, CICLO_MS); if (timer.unref) timer.unref();
}

module.exports = { init, calcular, consultar, responder, desfazer, painel, metas, estado, getParams, setParams, assertividade, terminaEm9, TIPOS, RESPOSTAS, PARAMS_PADRAO };
