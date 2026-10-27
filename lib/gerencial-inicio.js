// Gestão Gerencial › quadros do início (27/10/2026, Tiago: "pegar o layout do Fluxo no mobile e trazer pro gerencial:
// quando ele logasse apareciam os quadrados mostrando desempenho, gestão disciplinar, ponto, avarias, sem giro").
// A tela monta cinco quadros no estilo dos cartões do Fluxo Certo 360. Este módulo entrega só o que as rotas existentes
// não trazem: PONTO (jornada de hoje da loja, a mesma leitura da TV RH/DP em lib/tv-rh.js) e SEM GIRO (cache de
// lib/sem-giro.js). Desempenho e Avarias saem de /api/gestao-gerencial; Gestão Disciplinar, de /api/disciplinar/me.
// Só leitura: nada aqui grava no ERP nem no PontoCerto.
'use strict';

const LOJA_TXT = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão' };
const MAX_PENDENCIAS = 80;   // lista da gaveta do quadro Ponto
const MAX_ITENS = 30;        // lista da gaveta do quadro Sem Giro
const MAX_PESSOAS = 200;     // equipe da loja na tela Ponto
const agoraHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const hojeStr = () => { const h = new Date(); return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`; };

/** Quadro Ponto a partir de tvRh.montar(jornada, { lojas: [loja] }) — função pura. */
/** banco = { [id]: saldo oficial acumulado em minutos } das linhas cruas de pontocerto.jornadaDia (a TV tira o banco de propósito) */
function resumoPonto(m, banco) {
  const B = banco || {};
  const r = (m && m.resumo) || {};
  const pend = ((m && m.pendencias) || []);
  const fora = r.fora || { folga: 0, ferias: 0, afastado: 0 };
  return {
    previstos: r.previstos || 0, chegaram: r.chegaram || 0, atrasos: r.atrasos || 0,
    semMarcacao: pend.filter(p => p.g === 'sem').length,
    aguardando: r.aguardando || 0, apuracao: r.apuracao || 0, emIntervalo: r.emIntervalo || 0, saidas: r.saidas || 0,
    fora: { folga: fora.folga || 0, ferias: fora.ferias || 0, afastado: fora.afastado || 0 },
    pendencias: pend.slice(0, MAX_PENDENCIAS).map(p => ({ g: p.g, nome: p.nome, setor: p.setor || '—', txt: p.txt })),
    // por pessoa (Tiago, 27/10: "clicar no funcionário abrir o horário que teria que bater na entrada, no intervalo e na saída"):
    // as 4 marcações previsto × batido e a situação de cada uma, como a TV RH/DP classifica (tv-rh.linhaTV)
    pessoas: ((m && m.entradas) || []).slice(0, MAX_PESSOAS).map(l => ({ id: l.id, nome: l.nome, setor: l.setor || '—', cargo: l.cargo || '', previsto: l.previsto || null,
      entrada: l.entrada || null, saidaInt: l.saidaInt || null, retornoInt: l.retornoInt || null, saida: l.saida || null, atrasoMin: l.atrasoMin || 0, situacao: l.situacao || null,
      sit: { entrada: l.sitEntrada || null, intervalo: l.sitIntervalo || null, saida: l.sitSaida || null, jornada: l.sitJornada || null }, pendencias: l.pendencias || [], divergencias: l.divergencias || [],
      banco_min: B[l.id] == null ? null : B[l.id] })),
    maisPendencias: Math.max(0, pend.length - MAX_PENDENCIAS)
  };
}

/** Quadro Sem Giro a partir do resumo da loja (semGiro.lojas) e dos itens mais parados (semGiro.consultar) — função pura. */
const FAIXAS = [30, 60, 90, 120];
const itemTela = i => ({ cod: i.cod, descricao: i.descricao, grupo: i.grupo || '', unid: i.unid || '', est: i.est, valor: i.valor, dias: i.dias, faixa: i.faixa, preco: i.preco, abaixoCusto: !!i.abaixoCusto });
/** porFaixa (Tiago, 27/10: "sem giro coloque de 30 dias, de 60 dias"): { 30: [...], 60: [...], 90: [...], 120: [...] } — os mais parados de cada faixa. */
function resumoSemGiro(res, itens, estado, porFaixa) {
  const r = res || {}, f = k => (r[k] || { n: 0, v: 0 }), pf = porFaixa || {};
  return {
    n: r.n || 0, valor: r.valor || 0, abaixoCusto: r.abaixoCusto || 0, decididas: r.decididas || 0,
    faixas: { f30: f('f30'), f60: f('f60'), f90: f('f90'), f120: f('f120') },
    calculadoEm: (estado && estado.calculadoEm) || null, calculando: !!(estado && estado.calculando),
    itens: (itens || []).slice(0, MAX_ITENS).map(itemTela),
    itensFaixa: Object.fromEntries(FAIXAS.map(fx => [fx, (pf[fx] || []).slice(0, MAX_ITENS).map(itemTela)]))
  };
}

/**
 * Dados dos quadros Ponto e Sem Giro da loja (ou da rede, loja = null). Cada bloco falha sozinho ({ erro }) pra tela
 * mostrar os outros. deps: { tvRh (jornadaHoje, montar), semGiro (lojas, consultar), toleranciaMin() }.
 */
async function quadros(loja, deps) {
  const ln = loja ? +loja : null;
  const out = { loja: ln, lojaTxt: ln ? (LOJA_TXT[ln] || 'Loja ' + ln) : 'Rede', hoje: hojeStr(), agora: agoraHM() };
  try {
    const j = await deps.tvRh.jornadaHoje(false);
    let tol = null; try { tol = deps.toleranciaMin ? deps.toleranciaMin() : null; } catch (e) { tol = null; }
    const banco = {}; for (const l of (j && j.linhas) || []) if (l && l.id != null && l.banco_oficial_min != null) banco[l.id] = l.banco_oficial_min;
    out.ponto = resumoPonto(deps.tvRh.montar(j, { lojas: ln ? [ln] : [], setores: [] }, out.agora, tol), banco);
  } catch (e) { out.ponto = { erro: e.message }; }
  try {
    const l = deps.semGiro.lojas({});
    const itens = deps.semGiro.consultar({ loja: ln || 0, ordem: 'valor', limite: MAX_ITENS }).rows;
    const porFaixa = {}; for (const fx of FAIXAS) porFaixa[fx] = deps.semGiro.consultar({ loja: ln || 0, faixa: fx, ordem: 'valor', limite: MAX_ITENS }).rows;
    out.semGiro = resumoSemGiro(ln ? l.lojas[ln] : l.total, itens, l.estado, porFaixa);
  } catch (e) { out.semGiro = { erro: e.message }; }
  return out;
}

module.exports = { quadros, resumoPonto, resumoSemGiro, LOJA_TXT };
