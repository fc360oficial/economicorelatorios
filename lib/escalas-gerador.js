'use strict';
// lib/escalas-gerador.js — MOTOR do Gerador Inteligente de Escalas 5×2 (Etapa 1, 11/11/2026).
//
// ISOLADO E EM MODO SIMULAÇÃO: função pura. Não lê nem grava arquivo, não chama o PontoCerto/VR, não tem rota e não
// é carregado pelo servidor. Recebe funcionários, jornadas, regras, histórico de folgas e período; devolve uma PROPOSTA
// com conflitos trabalhistas e operacionais separados, divergências contra a jornada contratual, indicadores de
// cobertura e o estado de continuidade para o mês seguinte. `publicacao.liberada` é sempre false nesta etapa.
//
// Entrada de gerar():
//   de, ate            'AAAA-MM-DD' (qualquer período até 100 dias; as semanas são sempre segunda → domingo)
//   funcionarios[]     { id, nome, setor, empresa?, estabelecimento?, categoria?, sexo?, admissao?, desligamento?,
//                        folga_fixa: 0..6 (0 = domingo) | [dia] | null,
//                        base: { 0..6: { entrada, saida, almoco_ini, almoco_fim } | null }   ← jornada contratual (formato do lib/escalas.js)
//                        contratual?: { semanaMin }, entrada?: 'HH:MM' (entrada preferida),
//                        restricoes?: { naoTrabalha: [dia da semana], datasBloqueadas: ['AAAA-MM-DD'], entradaMin, saidaMax },
//                        ausencias?: [{ inicio, fim, tipo: 'ferias' | 'afastado' }] }
//   regras[]           { id, empresa?, estabelecimento?, categoria?, sexo?, vigencia: { de, ate }, validada, params }
//                      vale a regra vigente mais específica; sem regra cadastrada usa PARAMS_PADRAO como "não validada".
//   historico          { [id]: { dias: { data: dia }, ultimaRotativa?, domingosTrabalhadosSeguidos?, diasSeguidos? } }
//                      (é exatamente o `continuidade` devolvido pela geração do período anterior). Cada dia pode trazer
//                      `fonte` ('ponto' | 'escala' | 'rh'), `naoConfirmado: true` (planejado, sem confirmação do ponto) e
//                      `tipo: 'indefinido'` (havia jornada e não há marcação: NÃO é folga nem trabalho até o RH validar).
//                      Na semana de transição (período que começa no meio da semana) dia indefinido / não confirmado /
//                      ausente do histórico bloqueia a publicação; nas contas ele vale como "pode ter trabalhado".
//   travados           { 'id|data': dia } — dias já publicados/ajustados à mão: o motor nunca os altera
//   cobertura          { abre, fecha, setores: { SETOR: { min, faixas: [{ dias: [0..6], ini, fim, min }], entradas?, pesoDia? } }, pesoDia: { 0..6: n },
//                      pesoDia = prioridade operacional do dia (1 = normal; maior = mais movimento), da unidade e, se informado, do
//                      setor (o do setor vence). É PREFERÊNCIA: a folga rotativa evita o dia pesado, mas não fica proibida nele.
//                        entradas?: ['07:00', '08:36'] } — horários de entrada permitidos: quando informados, o motor escolhe por
//                      pessoa e por semana o que mais cobre buracos (o contratual ganha no empate); sem eles usa só o contratual.
//   feriados           ['AAAA-MM-DD'] — a loja abre; o dia só é marcado para documentação/pagamento
const MODO = 'simulacao';
// Parâmetros de fábrica. NÃO são a convenção coletiva: enquanto o RH não cadastrar e validar a regra aplicável, a
// proposta sai marcada como "regra não validada" e a publicação fica bloqueada.
const PARAMS_PADRAO = {
  diasTrabalho: 5, folgasSemana: 2,
  metaSemanalMin: 42 * 60,          // 42 h efetivas (meta da escala; a jornada contratual do ponto não é alterada)
  intervaloMin: 120,                // intervalo diário planejado
  // Intervalo intrajornada (duração e posição). São os números da CLT art. 71 como ponto de partida — a convenção da
  // categoria pode mudar qualquer um deles na regra: acima de 6 h de trabalho, intervalo de 1 h a 2 h; de 4 h a 6 h, pausa
  // de 15 min; ninguém trabalha mais de 6 h seguidas sem intervalo; intervalo não fica colado na entrada nem na saída.
  intervalo: { minimoMin: 60, maximoMin: 120, exigidoAcimaMin: 360, curtoMin: 15, curtoAcimaMin: 240, continuoMaxMin: 360, bordaMin: 60 },
  jornadaMaxDiaMin: 600, semanaMaxMin: 44 * 60, toleranciaMetaMin: 30,
  interjornadaMin: 11 * 60,         // entre duas jornadas
  descansoSemanalMin: 35 * 60,      // folga de 24 h + interjornada de 11 h
  maxDiasConsecutivos: 6,
  folgasConsecutivas: 'evitar',     // 'evitar' | 'indiferente'
  domingo: { folgaACadaSemanas: 3, tratamento: 'conforme_convencao' },   // 3 = no máximo 2 domingos trabalhados seguidos; 0 desliga
  feriado: { tratamento: 'conforme_convencao' },
  entradaPadrao: '07:00', almocoAposMin: 240, escalonarIntervalo: true
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const D = iso => new Date(iso + 'T12:00:00');
const isoDe = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const soma = (iso, n) => { const d = D(iso); d.setDate(d.getDate() + n); return isoDe(d); };
const dow = iso => D(iso).getDay();
const idxSem = iso => (dow(iso) + 6) % 7;                       // 0 = segunda … 6 = domingo
const segunda = iso => soma(iso, -idxSem(iso));
const numDia = iso => Math.round(D(iso).getTime() / 86400000);
const min = t => { const m = String(t == null ? '' : t).match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
const hm = m => m == null ? null : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const hhmm = m => (m < 0 ? '-' : '') + Math.floor(Math.abs(m) / 60) + 'h' + String(Math.abs(m) % 60).padStart(2, '0');
const DIA_TXT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const br = iso => iso.slice(8) + '/' + iso.slice(5, 7);
const liquido = d => !d || d.tipo !== 'trabalho' || min(d.entrada) == null || min(d.saida) == null ? 0
  : Math.max(0, min(d.saida) - min(d.entrada) - (min(d.almoco_ini) != null && min(d.almoco_fim) != null ? min(d.almoco_fim) - min(d.almoco_ini) : 0));
const lista = v => v == null ? [] : Array.isArray(v) ? v : [v];
function combos(arr, k) { if (k <= 0) return [[]]; if (k > arr.length) return []; const out = []; (function rec(ini, at) { if (at.length === k) { out.push(at.slice()); return; } for (let i = ini; i < arr.length; i++) { at.push(arr[i]); rec(i + 1, at); at.pop(); } })(0, []); return out; }

// ── Regras trabalhistas por empresa / estabelecimento / categoria / vigência ─────────────────────────────
const ESCOPO = ['empresa', 'estabelecimento', 'categoria', 'sexo'];
const igual = (a, b) => String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
/** Regra vigente mais específica para o funcionário na data; sem nenhuma, devolve os parâmetros de fábrica (não validados). */
function regraPara(regras, f, data) {
  let melhor = null, pontos = -1;
  for (const r of regras || []) {
    const v = r.vigencia || {}; if ((v.de && data < v.de) || (v.ate && data > v.ate)) continue;
    let p = 0, serve = true;
    for (const c of ESCOPO) { if (r[c] == null || r[c] === '') continue; if (f[c] == null || !igual(r[c], f[c])) { serve = false; break; } p++; }
    if (!serve) continue;
    if (p > pontos || (p === pontos && ((v.de || '') > ((melhor.vigencia || {}).de || '')))) { melhor = r; pontos = p; }
  }
  if (!melhor) return { id: null, padrao: true, validada: false, params: { ...PARAMS_PADRAO, intervalo: { ...PARAMS_PADRAO.intervalo } } };
  const q = melhor.params || {};
  return { id: melhor.id == null ? null : melhor.id, padrao: false, validada: melhor.validada === true, params: { ...PARAMS_PADRAO, ...q, intervalo: { ...PARAMS_PADRAO.intervalo, ...(q.intervalo || {}) }, domingo: { ...PARAMS_PADRAO.domingo, ...(q.domingo || {}) }, feriado: { ...PARAMS_PADRAO.feriado, ...(q.feriado || {}) } } };
}

// ── Cobertura ────────────────────────────────────────────────────────────────────────────────────────────
function normCobertura(c) {
  c = c || {}; const setores = {};
  for (const [s, v] of Object.entries(c.setores || {})) setores[s] = { min: Math.max(0, +(v && v.min != null ? v.min : v) || 0), faixas: ((v && v.faixas) || []).map(x => ({ dias: x.dias || [0, 1, 2, 3, 4, 5, 6], ini: min(x.ini), fim: min(x.fim), min: +x.min || 0 })).filter(x => x.ini != null && x.fim != null) };
  const ents = v => [...new Set(lista(v).map(min).filter(x => x != null))];
  for (const [s, v] of Object.entries(c.setores || {})) { setores[s].entradas = ents(v && v.entradas); setores[s].pesoDia = (v && v.pesoDia) || {}; }
  return { abre: min(c.abre) == null ? min('07:00') : min(c.abre), fecha: min(c.fecha) == null ? min('19:00') : min(c.fecha), setores, pesoDia: c.pesoDia || {}, entradas: ents(c.entradas) };
}
const necessarioEm = (cob, setor, dw, t) => { const s = cob.setores[setor]; if (!s) return 0; let n = s.min; for (const x of s.faixas) if (x.dias.includes(dw) && t >= x.ini && t < x.fim && x.min > n) n = x.min; return n; };
const minimoDoDia = (cob, setor, dw) => { const s = cob.setores[setor]; if (!s) return 0; let n = s.min; for (const x of s.faixas) if (x.dias.includes(dw) && x.min > n) n = x.min; return n; };
// Pessoas necessárias no dia para a folga não abrir buraco: o mínimo do setor em cada "turno" que cabe no horário da loja
// (loja de 12 h com permanência de 10h24 = 2 turnos), ou o pico do dia, o que for maior. É estimativa, não garantia.
const cabecasDoDia = (cob, setor, dw, permanencia) => { const s = cob.setores[setor]; if (!s) return 0; return Math.max(s.min * Math.max(1, Math.ceil((cob.fecha - cob.abre) / Math.max(60, permanencia))), minimoDoDia(cob, setor, dw)); };
const picosDoDia =(cob, setor, dw) => { const s = cob.setores[setor]; return s ? s.faixas.filter(x => x.dias.includes(dw) && x.min > s.min) : []; };
const disponivelEm = (d, t) => { if (!d || d.tipo !== 'trabalho') return false; const e = min(d.entrada), s = min(d.saida); if (e == null || s == null || t < e || t >= s) return false; const ai = min(d.almoco_ini), af = min(d.almoco_fim); return !(ai != null && af != null && t >= ai && t < af); };

// ── Ausências e histórico ────────────────────────────────────────────────────────────────────────────────
function ausenciaEm(f, data) {
  if (f.admissao && data < f.admissao) return 'fora'; if (f.desligamento && data > f.desligamento) return 'fora';
  const a = (f.ausencias || []).find(x => x.inicio <= data && x.fim >= data); return a ? (a.tipo === 'ferias' || a.ferias ? 'ferias' : 'afastado') : null;
}
/** Estado do funcionário na véspera da primeira semana: dias seguidos de trabalho, domingos trabalhados seguidos, última folga rotativa. */
function estadoInicial(h, seg0) {
  h = h || {}; const dias = h.dias || {}; let seguidos = 0, tem = false, ultSaida = null;
  // dia "indefinido" (havia jornada, não há marcação) conta como trabalhado nos limites: é o cenário mais conservador
  const podeTerTrabalhado = x => x.tipo === 'trabalho' || x.tipo === 'indefinido';
  for (let i = 1; i <= 14; i++) { const d = soma(seg0, -i), x = dias[d]; if (!x) break; tem = true; if (!podeTerTrabalhado(x)) break; seguidos++; if (i === 1 && x.tipo === 'trabalho' && min(x.saida) != null) ultSaida = numDia(d) * 1440 + min(x.saida); }
  if (!tem && h.diasSeguidos != null) seguidos = Math.max(0, +h.diasSeguidos || 0);
  let dom = 0, temDom = false;
  for (let i = 0, d = soma(seg0, -1); i < 8; i++, d = soma(d, -7)) { const x = dias[d]; if (!x) break; temDom = true; if (!podeTerTrabalhado(x)) break; dom++; }
  if (!temDom && h.domingosTrabalhadosSeguidos != null) dom = Math.max(0, +h.domingosTrabalhadosSeguidos || 0);
  let rot = h.ultimaRotativa == null ? null : +h.ultimaRotativa;
  for (let i = 1; i <= 7 && h.ultimaRotativa == null; i++) { const d = soma(seg0, -i), x = dias[d]; if (x && x.folga === 'rotativa') { rot = dow(d); break; } }
  const vesp = dias[soma(seg0, -1)];
  let incerto = 0; for (let i = 1; i <= 7; i++) { const x = dias[soma(seg0, -i)]; if (x && (x.tipo === 'indefinido' || x.naoConfirmado)) incerto++; }
  return { seguidos, dom, rot, vespFolga: !!(vesp && vesp.tipo === 'folga'), ultSaida, emSequencia: seguidos > 0 && !!vesp && vesp.tipo === 'trabalho', estourou: false, incerto, pico: 0, domFol: 0 };
}

/**
 * Gera a proposta 5×2 de UMA unidade para o período. Função pura e determinística (mesma entrada = mesma saída).
 */
function gerar(ent) {
  ent = ent || {}; const de = String(ent.de || ''), ate = String(ent.ate || '');
  if (!ISO.test(de) || !ISO.test(ate) || ate < de) throw new Error('Período inválido (de/ate em AAAA-MM-DD)');
  if (numDia(ate) - numDia(de) > 100) throw new Error('Período máximo de 100 dias por geração');
  const funcs = (ent.funcionarios || []).map(f => ({ ...f, setor: f.setor || 'OUTROS' })).sort((a, b) => String(a.setor).localeCompare(String(b.setor)) || String(a.nome || '').localeCompare(String(b.nome || '')) || String(a.id).localeCompare(String(b.id)));
  const ids = new Set(); for (const f of funcs) { if (f.id == null) throw new Error('Funcionário sem id'); if (ids.has(String(f.id))) throw new Error('Funcionário repetido: ' + f.id); ids.add(String(f.id)); }
  const regras = ent.regras || [], hist = ent.historico || {}, travados = ent.travados || {}, cob = normCobertura(ent.cobertura), feriados = new Set(ent.feriados || []);
  // prioridade operacional do dia: a do setor vence a da unidade; sem nenhuma, 1 (normal)
  const peso = (setor, dw) => { const s = cob.setores[setor]; const a = s && s.pesoDia ? +s.pesoDia[dw] : NaN; if (a > 0) return a; const p = +cob.pesoDia[dw]; return p > 0 ? p : 1; };

  const trabalhistas = [], operacionais = []; const vistos = new Set();
  const conflito = (tipo, codigo, gravidade, f, ref, texto, extra) => { const k = tipo + '|' + codigo + '|' + (f ? f.id : '') + '|' + (ref || ''); if (vistos.has(k)) return; vistos.add(k); (tipo === 'trabalhista' ? trabalhistas : operacionais).push({ tipo, codigo, gravidade, funcId: f ? f.id : null, nome: f ? f.nome || '' : null, setor: f ? f.setor : null, ref: ref || null, texto, ...(extra || {}) }); };
  /** Intervalo intrajornada de um dia de trabalho do período (gerado ou já fixo na grade): duração e posição, pela regra do funcionário. */
  function validarIntervalo(f, data, d, p) {
    const I = p.intervalo, en = min(d.entrada), sa = min(d.saida); if (en == null || sa == null || sa <= en) return;
    const ai = min(d.almoco_ini), af = min(d.almoco_fim); const tem = ai != null && af != null && af > ai; const itv = tem ? af - ai : 0, liq = sa - en - itv; const q = (f.nome || f.id) + ': ', em = ' em ' + br(data);
    const exigido = liq > I.exigidoAcimaMin ? I.minimoMin : liq > I.curtoAcimaMin ? I.curtoMin : 0;
    if (!tem) {
      if (liq > I.exigidoAcimaMin) conflito('trabalhista', 'intervalo_ausente', 'bloqueio', f, data, q + 'jornada de ' + hhmm(liq) + em + ' sem intervalo (acima de ' + hhmm(I.exigidoAcimaMin) + ' o intervalo mínimo é de ' + hhmm(I.minimoMin) + ')');
      else if (exigido > 0) conflito('trabalhista', 'pausa_nao_prevista', 'alerta', f, data, q + 'jornada de ' + hhmm(liq) + em + ' sem a pausa de ' + exigido + ' min prevista na escala (confirmar com o RH)');
      return;
    }
    if (ai < en || af > sa) { conflito('trabalhista', 'intervalo_fora_da_jornada', 'bloqueio', f, data, q + 'intervalo ' + hm(ai) + '–' + hm(af) + em + ' fora da jornada ' + hm(en) + '–' + hm(sa)); return; }
    if (itv < exigido) conflito('trabalhista', 'intervalo_insuficiente', 'bloqueio', f, data, q + 'intervalo de ' + hhmm(itv) + em + ' para ' + hhmm(liq) + ' de trabalho (mínimo ' + hhmm(exigido) + ')');
    if (I.maximoMin > 0 && itv > I.maximoMin) conflito('trabalhista', 'intervalo_excedente', 'bloqueio', f, data, q + 'intervalo de ' + hhmm(itv) + em + ' (máximo ' + hhmm(I.maximoMin) + ' sem acordo que autorize mais)');
    const antes = ai - en, depois = sa - af;
    if (Math.max(antes, depois) > I.continuoMaxMin) conflito('trabalhista', 'trabalho_continuo', 'bloqueio', f, data, q + hhmm(Math.max(antes, depois)) + ' seguidas ' + (antes >= depois ? 'antes' : 'depois') + ' do intervalo' + em + ' (máximo ' + hhmm(I.continuoMaxMin) + ' sem pausa)');
    else if (Math.min(antes, depois) < I.bordaMin) conflito('trabalhista', 'intervalo_na_borda', 'alerta', f, data, q + 'intervalo ' + hm(ai) + '–' + hm(af) + em + ' colado ' + (antes < depois ? 'na entrada' : 'na saída') + ' (' + hhmm(Math.min(antes, depois)) + ' de trabalho ' + (antes < depois ? 'antes' : 'depois') + ')');
  }

  const seg0 = segunda(de); const semanas = []; for (let s = seg0; s <= ate; s = soma(s, 7)) semanas.push(s);
  const E = new Map();   // id → { f, st, grade: {data: dia}, semanas: [], regra, regrasUsadas }
  for (const f of funcs) E.set(f.id, { f, st: estadoInicial(hist[f.id] || hist[String(f.id)], seg0), grade: {}, aberta: {}, semanas: [], regras: new Map(), domT: 0, domF: 0, pico: 0, semHist: false, transicao: null });
  const emTransicao = seg0 < de;   // o período começa no meio da semana: os dias anteriores vêm do histórico e não são tocados
  const fora = new Map();      // 'setor|data' → nº de pessoas em folga
  const disp = new Map();      // 'setor|data' → nº de pessoas não ausentes
  const almoco = new Map();    // 'setor|data|inicio' → nº de pessoas no intervalo
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const domingosFeriados = [];

  const slots = []; for (let t = cob.abre; t < cob.fecha; t += 15) slots.push(t);
  const presentes = new Map();   // 'setor|data' → nº de pessoas disponíveis em cada bloco de 15 min (já escaladas)
  const contagem = k => { let a = presentes.get(k); if (!a) { a = slots.map(() => 0); presentes.set(k, a); } return a; };
  const somarPresenca = (setor, data, dia) => { const a = contagem(setor + '|' + data); slots.forEach((t, i) => { if (disponivelEm(dia, t)) a[i]++; }); };
  const entradaContratual = (f, p, b) => { const bases = Object.values(f.base || {}).filter(Boolean); let en = min(f.entrada); if (en == null && b) en = min(b.entrada); if (en == null && bases.length) en = min(bases[0].entrada); return en == null ? min(p.entradaPadrao) : en; };
  const opcoesEntrada = f => { if (min(f.entrada) != null) return []; const perm = lista(f.entradas).map(min).filter(x => x != null); const doSetor = (cob.setores[f.setor] || {}).entradas || []; return perm.length ? perm : doSetor.length ? doSetor : cob.entradas; };
  /** Entrada da semana: entre as permitidas, a que mais cobre blocos abaixo do mínimo nos dias de trabalho (empate = contratual). */
  function escolherEntrada(f, p, datasTrab, ultSaida) {
    if (min(f.entrada) != null || !datasTrab.length) return null;
    const ops0 = opcoesEntrada(f); if (!ops0.length) return null;
    const r = f.restricoes || {}; const dur = Math.round(p.metaSemanalMin / p.diasTrabalho) + Math.max(0, p.intervaloMin);
    const ops = [...new Set([entradaContratual(f, p, (f.base || {})[dow(datasTrab[0])]), ...ops0])];
    let melhor = null, ganho = -1;
    for (const o of ops) {
      if (o + dur >= 1440) continue; if (min(r.entradaMin) != null && o < min(r.entradaMin)) continue; if (min(r.saidaMax) != null && o + dur > min(r.saidaMax)) continue;
      if (ultSaida != null && numDia(datasTrab[0]) * 1440 + o - ultSaida < p.interjornadaMin) continue;
      let g = 0; for (const d of datasTrab) { const a = contagem(f.setor + '|' + d), dw = dow(d); slots.forEach((t, i) => { if (t >= o && t < o + dur && a[i] < necessarioEm(cob, f.setor, dw, t)) g++; }); }
      if (g > ganho) { ganho = g; melhor = o; }
    }
    return melhor;
  }
  /** Inícios possíveis do intervalo: o contratual (ou N h após a entrada) e, com escalonamento, até dois outros turnos de
   *  intervalo. Só entra opção que respeita a posição da regra: nem colado na entrada/saída, nem mais do que o máximo de
   *  horas seguidas antes ou depois (o escalonamento antigo chegava a 7 h seguidas antes do intervalo). */
  function opcoesAlmoco(en, sa, itv, b, p) {
    const I = p.intervalo, antesMin = Math.max(120, I.bordaMin), depoisMin = Math.max(60, I.bordaMin);
    const cabe = x => x != null && x >= en + antesMin && x + itv <= sa - depoisMin && x - en <= I.continuoMaxMin && sa - (x + itv) <= I.continuoMaxMin;
    let ini0 = b ? min(b.almoco_ini) : null; if (!cabe(ini0)) ini0 = en + p.almocoAposMin;
    if (!cabe(ini0)) ini0 = en + Math.max(60, Math.round(((sa - en - itv) / 2) / 15) * 15);   // meio da jornada; se nem assim couber, a verificação do dia acusa
    const ops = [ini0];
    if (p.escalonarIntervalo) for (const dlt of [itv, 60, -60]) { const x = ini0 + dlt; if (dlt && cabe(x) && !ops.includes(x)) ops.push(x); if (ops.length >= 3) break; }
    return ops;
  }
  function horario(f, data, p, b, enSel, minAbs, liqSel) {
    const dw = dow(data); const r = f.restricoes || {};
    let en = enSel != null ? enSel : entradaContratual(f, p, b);
    const liq = liqSel || Math.round(p.metaSemanalMin / p.diasTrabalho), itv = Math.max(0, p.intervaloMin);
    if (min(r.entradaMin) != null && en < min(r.entradaMin)) en = min(r.entradaMin);
    // descanso antes desta jornada (interjornada, ou folga + interjornada): se a entrada contratual do dia não respeita, adia
    let adiada = false; if (minAbs != null && numDia(data) * 1440 + en < minAbs) { en = Math.ceil((minAbs - numDia(data) * 1440) / 5) * 5; adiada = true; conflito('operacional', 'entrada_adiada', 'info', f, data, f.nome + ': entrada de ' + br(data) + ' adiada para ' + hm(en) + ' para respeitar o descanso depois da jornada anterior'); }
    let sa = en + liq + itv;
    if (min(r.saidaMax) != null && sa > min(r.saidaMax)) { en -= sa - min(r.saidaMax); sa = min(r.saidaMax); if (en < 0 || (min(r.entradaMin) != null && en < min(r.entradaMin))) conflito('operacional', 'restricao_horario', 'alerta', f, null, f.nome + ': a jornada de ' + hhmm(liq) + ' + ' + hhmm(itv) + ' de intervalo não cabe entre ' + (r.entradaMin || '00:00') + ' e ' + r.saidaMax + ' (restrição individual)'); en = Math.max(0, en); }
    if (sa >= 1440) { conflito('operacional', 'jornada_vira_o_dia', 'alerta', f, null, f.nome + ': com entrada às ' + hm(en) + ' a jornada passa da meia-noite — o motor ainda não trata turno noturno'); sa = 1439; }
    const dia = { tipo: 'trabalho', entrada: hm(en), saida: hm(sa), almoco_ini: null, almoco_fim: null, setor: f.setor, minutos: liq, origem: 'gerador' }; if (adiada) dia.ajuste = 'descanso';
    if (itv > 0) {
      const ops = opcoesAlmoco(en, sa, itv, b, p);
      const picos = picosDoDia(cob, f.setor, dw); const sobre = x => picos.reduce((t, k) => t + Math.max(0, Math.min(x + itv, k.fim) - Math.max(x, k.ini)), 0);
      let melhor = ops[0], nota = Infinity; for (const o of ops) { const n = (almoco.get(f.setor + '|' + data + '|' + o) || 0) * 1000 + sobre(o); if (n < nota) { nota = n; melhor = o; } }
      inc(almoco, f.setor + '|' + data + '|' + melhor); dia.almoco_ini = hm(melhor); dia.almoco_fim = hm(melhor + itv);
    }
    return dia;
  }

  semanas.forEach((seg, w) => {
    const datas = [0, 1, 2, 3, 4, 5, 6].map(i => soma(seg, i));
    // 1ª passada: monta a semana de cada pessoa com o que já está decidido (histórico, travados, ausências, folga fixa, restrições)
    const plano = new Map();
    for (const f of funcs) {
      const x = E.get(f.id); const regra = regraPara(regras, f, seg < de ? de : seg); const p = regra.params; x.regra = regra; x.regras.set(regra.id == null ? '(padrão)' : String(regra.id), regra);
      const h = (hist[f.id] || hist[String(f.id)] || {}).dias || {}; const r = f.restricoes || {};
      // partida a frio (ninguém com histórico): defasa o contador de domingos dentro do setor para o descanso dominical já
      // nascer distribuído em vez de vencer para todo mundo no mesmo domingo
      if (w === 0 && !hist[f.id] && !hist[String(f.id)]) { const cd = +p.domingo.folgaACadaSemanas || 0; if (cd > 1) x.st.dom = funcs.filter(g => g.setor === f.setor).indexOf(f) % cd; }
      if (w === 0 && !emTransicao && x.st.incerto) conflito('operacional', 'historico_nao_confirmado', 'info', f, null, f.nome + ': ' + x.st.incerto + ' dia(s) da semana anterior sem confirmação no ponto — dias seguidos e descanso dominical calculados pelo cenário mais conservador');
      // Tipos de célula: L livre · T trabalho · F folga · A ausência/fora do quadro · X sem histórico · I indefinido (havia
      // jornada e não há marcação: não é folga nem trabalho até o RH validar; nos limites vale como "pode ter trabalhado")
      const cel = datas.map((data, i) => {
        const c = { data, dw: dow(data), i, kind: 'L', dia: null, fixo: null };
        if (data < de) { const a0 = ausenciaEm(f, data); if (a0 === 'fora') { c.kind = 'A'; c.aus = 'fora'; return c; } const d = h[data]; if (!d) { c.kind = 'X'; x.semHist = true; return c; } c.fixo = 'historico'; c.dia = d; c.kind = d.tipo === 'trabalho' ? 'T' : d.tipo === 'indefinido' ? 'I' : (d.tipo === 'folga' || d.tipo === 'feriado') ? 'F' : 'A'; return c; }
        const a = ausenciaEm(f, data); if (a) { c.kind = 'A'; c.aus = a; if (a !== 'fora') c.dia = { tipo: a, entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: f.setor, minutos: 0, origem: 'ausencia' }; return c; }
        const t = data <= ate ? (travados[f.id + '|' + data]) : null;
        if (t) { c.fixo = 'travado'; c.dia = { ...t, minutos: liquido(t), travado: true }; c.kind = t.tipo === 'trabalho' ? 'T' : (t.tipo === 'folga' || t.tipo === 'feriado') ? 'F' : 'A'; return c; }
        return c;
      });
      if (x.semHist && seg < de) conflito('operacional', 'historico_ausente', 'alerta', f, seg, f.nome + ': sem histórico de ' + br(seg) + ' a ' + br(soma(de, -1)) + ' — a semana que atravessa o mês foi calculada só com os dias do período');
      const util = cel.filter(c => c.kind !== 'A' && c.kind !== 'X');
      const devidas = Math.round(util.length * p.folgasSemana / 7);
      const fixas = lista(f.folga_fixa).map(Number);
      const livres = cel.filter(c => c.kind === 'L');
      const restrita = c => (r.naoTrabalha || []).includes(c.dw) || (r.datasBloqueadas || []).includes(c.data);
      let forcadas = livres.filter(c => fixas.includes(c.dw) || restrita(c));
      // Semana de transição: o descanso já gozado antes do início não se repete — a folga fixa só entra enquanto a semana
      // ainda deve folga (restrição individual continua valendo sempre)
      if (seg < de) {
        let cota = Math.max(0, devidas - cel.filter(c => c.kind === 'F').length - forcadas.filter(restrita).length);
        forcadas = forcadas.filter(c => { if (restrita(c)) return true; if (cota > 0) { cota--; return true; }
          conflito('operacional', 'folga_fixa_ja_gozada', 'info', f, c.data, f.nome + ': a semana de ' + br(seg) + ' já tinha os descansos previstos antes do início da escala — a folga fixa de ' + br(c.data) + ' (' + DIA_TXT[c.dw] + ') não foi repetida'); return false; });
      }
      for (const c of forcadas) c.marca = fixas.includes(c.dw) ? 'fixa' : 'restricao';
      if (!fixas.length) conflito('operacional', 'sem_folga_fixa', 'info', f, null, f.nome + ': sem folga fixa cadastrada — as duas folgas da semana foram distribuídas pelo motor');
      for (const c of cel) { const k = f.setor + '|' + c.data; if (c.kind !== 'A' && c.kind !== 'X') inc(disp, k); if (c.kind === 'F' || forcadas.includes(c)) inc(fora, k); }
      plano.set(f.id, { cel, p, regra, util, devidas, livres, forcadas, jaFolga: cel.filter(c => c.kind === 'F').length, jaTrab: cel.filter(c => c.kind === 'T').length });
    }
    // 2ª passada: escolhe as folgas rotativas (a ordem gira a cada semana para ninguém ficar sempre com a sobra)
    const ordem = funcs.map((f, i) => funcs[(i + w) % funcs.length]);
    for (const f of ordem) {
      const x = E.get(f.id), st = x.st, pl = plano.get(f.id), p = pl.p, cel = pl.cel; const fixas = lista(f.folga_fixa).map(Number);
      const resto = pl.livres.filter(c => !pl.forcadas.includes(c));
      let faltam = Math.max(0, pl.devidas - pl.jaFolga - pl.forcadas.length);
      const cada = +p.domingo.folgaACadaSemanas || 0; const dom = cel[6];
      const domObrig = cada > 0 && st.dom >= cada - 1 && dom.kind === 'L';
      if (domObrig && !pl.forcadas.includes(dom) && faltam === 0 && resto.includes(dom)) { faltam = 1; conflito('operacional', 'folga_extra_domingo', 'info', f, dom.data, f.nome + ': folga extra no domingo ' + br(dom.data) + ' para respeitar o descanso dominical (semana já tinha as folgas previstas)'); }
      faltam = Math.min(faltam, resto.length);
      const tipoEm = (i, set) => set.has(i) ? 'F' : cel[i].kind === 'L' ? 'T' : cel[i].kind;
      const forcIdx = pl.forcadas.map(c => c.i);
      const domFolMin = Math.min(...funcs.filter(g => g.setor === f.setor).map(g => E.get(g.id).st.domFol));
      const escolher = n => { let melhor = null, nota = Infinity;
      for (const cb of combos(resto, n)) {
        const set = new Set([...forcIdx, ...cb.map(c => c.i)]); let s = 0;
        if (domObrig && !set.has(6)) s += 1e6;
        let run = st.seguidos; for (let i = 0; i < 7; i++) { const k = tipoEm(i, set); if (k === 'T' || k === 'I') { run++; if (run > p.maxDiasConsecutivos) s += 1e5; } else run = 0; }
        if (fixas.length) { const prox = Math.min(...fixas.map(d => (d + 6) % 7)); if (run + prox > p.maxDiasConsecutivos) s += 5e4; }
        if (p.folgasConsecutivas === 'evitar') {
          for (let i = 0; i < 6; i++) if (tipoEm(i, set) === 'F' && tipoEm(i + 1, set) === 'F') s += 1000;
          if (st.vespFolga && tipoEm(0, set) === 'F') s += 1000;
          if (set.has(6) && fixas.includes(1)) s += 1000;
        }
        for (const c of cb) {
          if (st.rot != null && c.dw === st.rot) s += 100;
          const k = f.setor + '|' + c.data; const jaFora = fora.get(k) || 0; const sobra = (disp.get(k) || 0) - jaFora - 1; const nec = cabecasDoDia(cob, f.setor, c.dw, Math.round(p.metaSemanalMin / p.diasTrabalho) + Math.max(0, p.intervaloMin));
          if (sobra < nec) s += 500 + 200 * (nec - sobra);
          // prioridade operacional do dia: a rotativa prefere o dia de menor movimento. É custo, não proibição (fica abaixo
          // do custo de furar a cobertura mínima e de colar folgas), e cresce para quem já folgou em dia pesado, para a
          // folga em dia de movimento rodar entre as pessoas em vez de cair sempre na mesma
          const pw = peso(f.setor, c.dw); if (pw > 1) s += 100 * Math.min(4, pw - 1) + 20 * Math.min(4, st.pico);   // no máximo 480: sozinho nunca vence os 700+ de furar a cobertura
          s += 40 * jaFora;
          // domingo: enche a cota da semana (1/N do setor) para o descanso dominical não acumular todo no mesmo domingo
          if (c.i === 6 && !domObrig) { s -= 30 * st.dom; if (cada > 0 && st.dom > 0 && jaFora < Math.ceil((disp.get(k) || 0) / cada)) s -= 80;
            // equilíbrio: quem já folgou mais domingos do que o colega de setor que menos folgou paga para folgar outro (com
            // sexta e sábado pesados o domingo virava a rotativa de sempre de quem tem folga fixa no meio da semana)
            s += 150 * Math.min(3, Math.max(0, st.domFol - domFolMin)); }
          s += ((c.dw - ((st.rot == null ? 0 : st.rot) + 1) + 7) % 7) * 0.01;
        }
        if (s < nota) { nota = s; melhor = cb; }
      }
      return { melhor, nota }; };
      let { melhor, nota } = escolher(faltam);
      // nenhuma combinação com as folgas previstas respeita o limite de dias seguidos (acontece na semana de transição,
      // quando o descanso da semana já foi gozado antes do início): acrescenta folga até respeitar
      for (let extra = 1; nota >= 1e5 && nota < 1e6 && faltam + extra <= resto.length && extra <= 2; extra++) {
        const t = escolher(faltam + extra); if (t.nota >= 1e5) continue;
        melhor = t.melhor; nota = t.nota; conflito('operacional', 'folga_extra_descanso', 'info', f, seg, f.nome + ': ' + extra + ' folga(s) a mais na semana de ' + br(seg) + ' para não passar de ' + p.maxDiasConsecutivos + ' dias seguidos de trabalho'); break;
      }
      for (const c of melhor || []) { c.marca = 'rotativa'; inc(fora, f.setor + '|' + c.data); if (peso(f.setor, c.dw) > 1) { st.pico++; if (c.data >= de && c.data <= ate) x.pico++; } }
      const folgas = new Set([...pl.forcadas, ...(melhor || [])]);
      if (pl.forcadas.length + pl.jaFolga > pl.devidas && pl.forcadas.some(c => c.marca === 'restricao')) conflito('operacional', 'restricao_excede_folgas', 'alerta', f, seg, f.nome + ': as restrições individuais somam mais folgas do que a semana de ' + br(seg) + ' prevê');
      // dias de trabalho e de folga da semana
      const enSel = escolherEntrada(f, p, cel.filter(c => c.kind === 'L' && !folgas.has(c)).map(c => c.data), st.ultSaida);
      // semana com dias já fixos (histórico da virada do mês ou ajuste à mão) mais longos: encurta os dias gerados para a semana caber no limite
      const fixoMin = cel.filter(c => c.kind === 'T' && c.dia).reduce((t, c) => t + liquido(c.dia), 0), nGer = cel.filter(c => c.kind === 'L' && !folgas.has(c)).length, liqPad = Math.round(p.metaSemanalMin / p.diasTrabalho); let liqSel = null;
      if (nGer && fixoMin + nGer * liqPad > p.semanaMaxMin) { liqSel = Math.max(240, Math.floor((p.semanaMaxMin - fixoMin) / nGer / 5) * 5); if (liqSel < liqPad) conflito('operacional', 'jornada_reduzida', 'info', f, seg, f.nome + ': dias gerados da semana de ' + br(seg) + ' com ' + hhmm(liqSel) + ' para a semana caber em ' + hhmm(p.semanaMaxMin) + ' (há dia já fixo mais longo)'); else liqSel = null; }
      let ult = st.ultSaida, seq = st.emSequencia;   // última saída conhecida e se a véspera foi de trabalho
      const saiu = c => { const s = c.dia ? min(c.dia.saida) : null; ult = s == null ? null : numDia(c.data) * 1440 + s; seq = true; };
      for (const c of cel) {
        if (c.kind === 'T') { if (c.fixo === 'travado') somarPresenca(f.setor, c.data, c.dia); saiu(c); continue; }
        if (c.kind !== 'L') { seq = false; if (c.kind === 'X' || c.kind === 'I') ult = null; continue; }
        if (folgas.has(c)) { c.kind = 'F'; seq = false; c.dia = { tipo: 'folga', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: f.setor, minutos: 0, folga: c.marca, origem: 'gerador' }; }
        else { c.kind = 'T'; c.dia = horario(f, c.data, p, (f.base || {})[c.dw], enSel, ult == null ? null : ult + (seq ? p.interjornadaMin : p.descansoSemanalMin), liqSel); somarPresenca(f.setor, c.data, c.dia); saiu(c); }
      }
    }
    // Reparo de cobertura: onde ainda sobra bloco abaixo do mínimo, troca a entrada de UMA pessoa só naquele dia (entre as
    // entradas permitidas), desde que diminua o buraco e mantenha a interjornada com a véspera e o dia seguinte.
    for (const data of datas) {
      if (data < de) continue; const dw = dow(data), i = idxSem(data);
      for (const setor of new Set(funcs.map(f => f.setor))) {
        const a = contagem(setor + '|' + data); const deficit = arr => slots.reduce((t, s, k) => t + Math.max(0, necessarioEm(cob, setor, dw, s) - arr[k]), 0);
        let atual = deficit(a);
        for (let volta = 0; volta < 12 && atual > 0; volta++) {
          let best = null;
          for (const f of funcs) {
            if (f.setor !== setor) continue; const ops0 = opcoesEntrada(f); if (!ops0.length) continue;
            const pl = plano.get(f.id), c = pl.cel[i], st = E.get(f.id).st, r = f.restricoes || {}; if (c.kind !== 'T' || c.fixo || !c.dia || c.dia.origem !== 'gerador') continue;
            const en0 = min(c.dia.entrada), dur = min(c.dia.saida) - en0, dAlm = min(c.dia.almoco_ini) == null ? null : min(c.dia.almoco_ini) - en0, itv = dAlm == null ? 0 : min(c.dia.almoco_fim) - min(c.dia.almoco_ini);
            const ant = i > 0 ? pl.cel[i - 1] : null; const antSaida = ant ? (ant.kind === 'T' && ant.dia && min(ant.dia.saida) != null ? numDia(ant.data) * 1440 + min(ant.dia.saida) : null) : (st.emSequencia ? st.ultSaida : null);
            const prox = i < 6 ? pl.cel[i + 1] : null; const proxEntrada = prox && prox.kind === 'T' && prox.dia && min(prox.dia.entrada) != null ? numDia(prox.data) * 1440 + min(prox.dia.entrada) : null;
            for (const o of new Set([entradaContratual(f, pl.p, (f.base || {})[dw]), ...ops0])) {
              if (o + dur >= 1440) continue; if (o < en0 && !(ant && ant.kind === 'T')) continue;   // depois de folga não antecipa (descanso de 35 h)
              if (min(r.entradaMin) != null && o < min(r.entradaMin)) continue; if (min(r.saidaMax) != null && o + dur > min(r.saidaMax)) continue;
              const ini = numDia(data) * 1440 + o; if (antSaida != null && ini - antSaida < pl.p.interjornadaMin) continue; if (proxEntrada != null && proxEntrada - (ini + dur) < pl.p.interjornadaMin) continue;
              for (const al of dAlm == null ? [null] : opcoesAlmoco(o, o + dur, itv, (f.base || {})[dw], pl.p)) {   // troca de entrada e/ou só do intervalo
                if (o === en0 && al === en0 + dAlm) continue;
                const novo = { ...c.dia, entrada: hm(o), saida: hm(o + dur), almoco_ini: al == null ? null : hm(al), almoco_fim: al == null ? null : hm(al + itv), ajuste: 'cobertura' };
                const arr = a.slice(); slots.forEach((t, k) => { if (disponivelEm(c.dia, t)) arr[k]--; if (disponivelEm(novo, t)) arr[k]++; });
                const dd = deficit(arr); if (dd < atual && (!best || dd < best.dd)) best = { dd, c, novo, arr };
              }
            }
          }
          if (!best) break; best.c.dia = best.novo; best.arr.forEach((v, k) => { a[k] = v; }); atual = best.dd;
        }
      }
    }
    // 3ª passada: verificações trabalhistas dia a dia + contadores de continuidade
    for (const f of funcs) {
      const x = E.get(f.id), st = x.st, pl = plano.get(f.id), p = pl.p, cel = pl.cel, dom = cel[6]; const cada = +p.domingo.folgaACadaSemanas || 0;
      let trab = 0, fol = 0, aus = 0, mins = 0, rotSemana = null;
      for (const c of cel) {
        const d = c.dia; const noPer = c.data >= de && c.data <= ate;   // dias da semana aberta (depois de `ate`) são só previsão
        if (c.kind === 'I') { st.seguidos++; st.estourou = false; st.emSequencia = false; st.ultSaida = null; continue; }   // indefinido: pode ter trabalhado
        if (c.kind === 'T') {
          trab++; mins += d.minutos != null ? d.minutos : liquido(d);
          if (noPer) validarIntervalo(f, c.data, d, p);
          st.seguidos++; if (st.seguidos > p.maxDiasConsecutivos && !st.estourou && noPer) { st.estourou = true; conflito('trabalhista', 'dias_consecutivos', 'bloqueio', f, c.data, f.nome + ': ' + st.seguidos + 'º dia seguido de trabalho em ' + br(c.data) + ' (limite ' + p.maxDiasConsecutivos + ')'); }
          const en = min(d.entrada), sa = min(d.saida);
          if (en != null && st.ultSaida != null && noPer) { const gap = numDia(c.data) * 1440 + en - st.ultSaida; if (st.emSequencia) { if (gap < p.interjornadaMin) conflito('trabalhista', 'interjornada', 'bloqueio', f, c.data, f.nome + ': só ' + hhmm(gap) + ' de descanso antes da entrada de ' + br(c.data) + ' (mínimo ' + hhmm(p.interjornadaMin) + ')'); } else if (gap < p.descansoSemanalMin) conflito('trabalhista', 'descanso_semanal', 'bloqueio', f, c.data, f.nome + ': descanso de ' + hhmm(gap) + ' antes de ' + br(c.data) + ' (mínimo ' + hhmm(p.descansoSemanalMin) + ' com a folga)'); }
          if (noPer && liquido(d) > p.jornadaMaxDiaMin) conflito('trabalhista', 'jornada_diaria', 'bloqueio', f, c.data, f.nome + ': jornada de ' + hhmm(liquido(d)) + ' em ' + br(c.data) + ' (limite ' + hhmm(p.jornadaMaxDiaMin) + ')');
          if (sa != null) st.ultSaida = numDia(c.data) * 1440 + sa; st.emSequencia = true;
          if (c.data >= de && c.data <= ate) { const fer = feriados.has(c.data); if (c.dw === 0 || fer) domingosFeriados.push({ funcId: f.id, nome: f.nome || '', setor: f.setor, data: c.data, tipo: fer ? 'feriado' : 'domingo', minutos: liquido(d), tratamento: fer ? p.feriado.tratamento : p.domingo.tratamento, regraId: pl.regra.id }); }
        } else { if (c.kind === 'F') { fol++; if (d && d.folga === 'rotativa') rotSemana = c.dw; } else if (c.kind === 'A') aus++; if (c.kind !== 'X') { st.seguidos = 0; st.estourou = false; st.emSequencia = false; } else { st.seguidos = 0; st.estourou = false; st.emSequencia = false; st.ultSaida = null; } }
      }
      if (dom.kind === 'T') { st.dom++; if (dom.data >= de && dom.data <= ate) x.domT++; if (cada > 0 && st.dom >= cada && dom.data >= de && dom.data <= ate) conflito('trabalhista', 'domingo_sem_folga', 'bloqueio', f, dom.data, f.nome + ': ' + st.dom + 'º domingo seguido de trabalho em ' + br(dom.data) + ' (a regra pede folga a cada ' + cada + ' semanas)'); }
      else if (dom.kind !== 'X') { st.dom = 0; if (dom.kind === 'F') st.domFol++; if (dom.kind === 'F' && dom.data >= de && dom.data <= ate) x.domF++; }
      st.vespFolga = dom.kind === 'F'; if (rotSemana != null) st.rot = rotSemana;
      const completa = pl.util.length === 7;
      // Semana de transição: o que já passou do limite só com os registros anteriores ao início (ponto/escala) é HERDADO —
      // a proposta não tem como desfazer; fica registrado como alerta para o RH, sem travar a publicação por isso.
      const trans = seg < de; const histT = cel.filter(c => c.fixo === 'historico' && c.kind === 'T'); const histMin = histT.reduce((t, c) => t + liquido(c.dia), 0);
      const herd = sim => trans && sim ? { gravidade: 'alerta', extra: { transicao: true, herdado: true }, sufixo: ' — já ocorrido antes do início da escala (registro anterior, não é da proposta)' } : { gravidade: 'bloqueio', extra: trans ? { transicao: true } : null, sufixo: '' };
      if (trab > p.diasTrabalho) { const h = herd(histT.length > p.diasTrabalho); conflito('trabalhista', 'mais_dias_que_o_previsto', h.gravidade, f, seg, f.nome + ': ' + trab + ' dias de trabalho na semana de ' + br(seg) + ' (escala ' + p.diasTrabalho + '×' + p.folgasSemana + ')' + h.sufixo, h.extra); }
      if (mins > p.semanaMaxMin) { const h = herd(histMin > p.semanaMaxMin); conflito('trabalhista', 'carga_semanal', h.gravidade, f, seg, f.nome + ': ' + hhmm(mins) + ' na semana de ' + br(seg) + ' (limite ' + hhmm(p.semanaMaxMin) + ')' + h.sufixo, h.extra); }
      const fechada = datas[6] <= ate;   // a semana aberta (termina depois de `ate`) mistura dias previstos: fica para a geração do mês seguinte
      const gravSem = trans ? 'info' : 'alerta', extraSem = trans ? { transicao: true } : null;   // semana de transição mistura dias reais e propostos
      if (completa && fechada && trab < p.diasTrabalho) conflito('operacional', 'menos_dias_que_o_previsto', gravSem, f, seg, f.nome + ': só ' + trab + ' dias de trabalho na semana de ' + br(seg), extraSem);
      if (completa && fechada && trab === p.diasTrabalho && Math.abs(mins - p.metaSemanalMin) > p.toleranciaMetaMin) conflito('operacional', 'meta_semanal', gravSem, f, seg, f.nome + ': ' + hhmm(mins) + ' na semana de ' + br(seg) + ' (meta ' + hhmm(p.metaSemanalMin) + ')', extraSem);
      if (trans) {
        const antes = cel.filter(c => c.data < de && c.aus !== 'fora'); const incerta = c => c.kind === 'X' || c.kind === 'I' || !!(c.dia && c.dia.naoConfirmado);
        const pend = antes.filter(incerta); const jaF = antes.filter(c => c.kind === 'F').length;
        x.transicao = { funcId: f.id, nome: f.nome || '', setor: f.setor,
          dias: antes.map(c => ({ data: c.data, tipo: c.kind === 'X' ? 'sem_dado' : c.dia.tipo, fonte: (c.dia && c.dia.fonte) || null, confirmado: !incerta(c) })),
          trabalhados: histT.length, descansos: jaF, ausencias: antes.filter(c => c.kind === 'A').length, pendentes: pend.map(c => c.data),
          folgasDevidas: pl.devidas, folgasPropostas: fol - jaF, diasPropostos: trab - histT.length, minutosAnteriores: histMin, minutosSemana: mins,
          situacao: pend.length ? 'dados_insuficientes' : (histT.length > p.diasTrabalho || histMin > p.semanaMaxMin) ? 'conflito_herdado' : 'ok' };
        if (pend.length) conflito('operacional', 'transicao_dados_insuficientes', 'alerta', f, seg, f.nome + ': sem confirmação do que aconteceu em ' + pend.map(c => br(c.data)).join(', ') + ' (semana de transição) — o RH precisa validar esses dias ou a escala deve começar numa segunda-feira', { transicao: true });
      }
      x.semanas.push({ inicio: seg, fim: datas[6], completa, parcial: !completa, cruzaPeriodo: seg < de || datas[6] > ate, trabalho: trab, folgas: fol, ausencias: aus, minutos: mins, horas: hhmm(mins), regraId: pl.regra.id });
      for (const c of cel) { if (!c.dia) continue; if (c.data >= de && c.data <= ate) x.grade[c.data] = c.dia; else if (c.data > ate) x.aberta[c.data] = c.dia; }
    }
  });

  // ── Cobertura do período (blocos de 15 min entre a abertura e o fechamento) ──
  const setores = [...new Set([...Object.keys(cob.setores), ...funcs.map(f => f.setor)])].sort();
  const cobDias = []; const porSetor = {}; let blocosAbaixo = 0, diasComDeficit = 0;
  for (let d = de; d <= ate; d = soma(d, 1)) {
    const dw = dow(d); const linha = { data: d, dia: DIA_TXT[dw], feriado: feriados.has(d), setores: [] }; let deficit = false;
    for (const s of setores) {
      const pess = funcs.filter(f => f.setor === s).map(f => E.get(f.id).grade[d]).filter(Boolean);
      const r = { setor: s, minimo: minimoDoDia(cob, s, dw), escalados: pess.filter(x => x.tipo === 'trabalho').length, folgas: pess.filter(x => x.tipo === 'folga').length, ausentes: pess.filter(x => x.tipo === 'ferias' || x.tipo === 'afastado').length, blocos_abaixo: 0, pior: null, faixas_abaixo: [] };
      let ini = null;
      slots.forEach((t, i) => {
        const nec = necessarioEm(cob, s, dw, t); const n = pess.filter(x => disponivelEm(x, t)).length; const baixo = nec > 0 && n < nec;
        if (baixo) { r.blocos_abaixo++; if (!r.pior || nec - n > r.pior.necessario - r.pior.disponiveis) r.pior = { hora: hm(t), disponiveis: n, necessario: nec }; if (ini == null) ini = t; }
        if ((!baixo || i === slots.length - 1) && ini != null) { r.faixas_abaixo.push(hm(ini) + '–' + hm(baixo ? t + 15 : t)); ini = null; }
      });
      if (r.blocos_abaixo) { deficit = true; blocosAbaixo += r.blocos_abaixo; const P = porSetor[s] || (porSetor[s] = { setor: s, dias_com_deficit: 0, blocos_abaixo: 0 }); P.dias_com_deficit++; P.blocos_abaixo += r.blocos_abaixo;
        conflito('operacional', 'cobertura_abaixo', 'alerta', null, s + '|' + d, s + ' em ' + br(d) + ' (' + DIA_TXT[dw] + '): abaixo do mínimo em ' + r.faixas_abaixo.join(', ') + ' — pior momento ' + r.pior.hora + ' com ' + r.pior.disponiveis + ' de ' + r.pior.necessario); }
      linha.setores.push(r);
    }
    if (deficit) diasComDeficit++; cobDias.push(linha);
  }

  // ── Divergências entre a jornada contratual (ponto) e a planejada: o RH valida antes de publicar ──
  const divergenciasContratuais = [];
  for (const f of funcs) {
    const x = E.get(f.id), p = x.regra.params; const base = f.base || {}; const dias = [0, 1, 2, 3, 4, 5, 6].map(d => base[d]).filter(Boolean); const itens = [];
    const semContr = f.contratual && f.contratual.semanaMin != null ? +f.contratual.semanaMin : (dias.length ? dias.reduce((t, b) => t + liquido({ tipo: 'trabalho', ...b }), 0) : null);
    if (semContr == null) itens.push({ campo: 'jornada_contratual', contratual: null, planejado: hhmm(p.metaSemanalMin), texto: 'Jornada contratual não informada pelo ponto' });
    else if (semContr !== p.metaSemanalMin) itens.push({ campo: 'carga_semanal', contratual: hhmm(semContr), planejado: hhmm(p.metaSemanalMin), diferencaMin: p.metaSemanalMin - semContr, texto: 'Carga semanal contratual ' + hhmm(semContr) + ' × planejada ' + hhmm(p.metaSemanalMin) });
    if (dias.length && dias.length !== p.diasTrabalho) itens.push({ campo: 'dias_por_semana', contratual: dias.length, planejado: p.diasTrabalho, texto: 'Contrato com ' + dias.length + ' dias por semana × escala de ' + p.diasTrabalho });
    const itvs = [...new Set(dias.map(b => min(b.almoco_ini) != null && min(b.almoco_fim) != null ? min(b.almoco_fim) - min(b.almoco_ini) : 0))];
    if (dias.length && !(itvs.length === 1 && itvs[0] === p.intervaloMin)) itens.push({ campo: 'intervalo', contratual: itvs.map(hhmm).join(' / '), planejado: hhmm(p.intervaloMin), texto: 'Intervalo contratual ' + itvs.map(hhmm).join(' / ') + ' × planejado ' + hhmm(p.intervaloMin) });
    if (dias.length && !base[0] && x.domT > 0) itens.push({ campo: 'domingo', contratual: 'não previsto', planejado: x.domT + ' domingo(s)', texto: 'Domingo não faz parte da jornada contratual e a escala prevê ' + x.domT + ' domingo(s) de trabalho' });
    if (itens.length) divergenciasContratuais.push({ funcId: f.id, nome: f.nome || '', setor: f.setor, validacaoRH: 'pendente', itens });
  }

  // ── Saída ──
  const proposta = funcs.map(f => { const x = E.get(f.id); const minutos = Object.values(x.grade).reduce((t, d) => t + (d.tipo === 'trabalho' ? (d.minutos != null ? d.minutos : liquido(d)) : 0), 0);
    return { id: f.id, nome: f.nome || '', setor: f.setor, folga_fixa: lista(f.folga_fixa), regraId: x.regra.id, dias: x.grade, semanas: x.semanas, minutos, horas: hhmm(minutos), domingosTrabalhados: x.domT, domingosFolga: x.domF, folgasEmDiaPesado: x.pico }; });
  // ── Semana de transição (período que começa no meio da semana) ──
  const transFuncs = emTransicao ? funcs.map(f => E.get(f.id).transicao).filter(Boolean) : [];
  const transPend = transFuncs.filter(t => t.situacao === 'dados_insuficientes');
  const transicao = { necessaria: emTransicao, semana: emTransicao ? { inicio: seg0, fim: soma(seg0, 6) } : null, inicio: de, funcionarios: transFuncs,
    pendentes: transPend.length, diasPendentes: transPend.reduce((t, x) => t + x.pendentes.length, 0), herdados: transFuncs.filter(t => t.situacao === 'conflito_herdado').length };
  const continuidade = {};
  for (const f of funcs) { const x = E.get(f.id); const dias = {}; const h = (hist[f.id] || hist[String(f.id)] || {}).dias || {};
    for (let i = 27; i >= 0; i--) { const d = soma(ate, -i); const v = x.grade[d] || (d < de ? h[d] : null); if (v) dias[d] = v; }
    let seg = 0; for (let d = ate; dias[d] && dias[d].tipo === 'trabalho'; d = soma(d, -1)) seg++;
    continuidade[f.id] = { ate, dias, ultimaRotativa: x.st.rot, domingosTrabalhadosSeguidos: x.st.dom, diasSeguidos: seg, semanaAberta: x.aberta }; }
  const regrasAplicadas = new Map();
  for (const f of funcs) for (const [k, r] of E.get(f.id).regras) { const a = regrasAplicadas.get(k) || { id: r.id, padrao: r.padrao, validada: r.validada, funcionarios: new Set() }; a.funcionarios.add(f.id); regrasAplicadas.set(k, a); }
  const regrasLista = [...regrasAplicadas.values()].map(r => ({ id: r.id, padrao: r.padrao, validada: r.validada, funcionarios: r.funcionarios.size }));
  const bloqueios = [{ codigo: 'motor_em_simulacao', texto: 'O motor só propõe: nada é publicado por ele — a escala segue o fluxo de aprovação (gerente → RH → Coordenação)' }];
  const naoVal = regrasLista.filter(r => !r.validada);
  if (naoVal.length) bloqueios.push({ codigo: 'regra_nao_validada', texto: naoVal.reduce((t, r) => t + r.funcionarios, 0) + ' funcionário(s) sem convenção/regra trabalhista cadastrada e validada pelo RH' + (naoVal.some(r => r.padrao) ? ' (usando parâmetros de fábrica)' : '') });
  const bloq = trabalhistas.filter(c => c.gravidade === 'bloqueio').length;
  if (bloq) bloqueios.push({ codigo: 'conflito_trabalhista', texto: bloq + ' conflito(s) trabalhista(s) impeditivo(s)' });
  if (divergenciasContratuais.length) bloqueios.push({ codigo: 'divergencia_contratual', texto: divergenciasContratuais.length + ' funcionário(s) com jornada planejada diferente da contratual, pendente de validação do RH' });
  if (transPend.length) bloqueios.push({ codigo: 'transicao_sem_dados', texto: transPend.length + ' funcionário(s) sem dados suficientes da semana de transição (' + br(seg0) + ' a ' + br(soma(de, -1)) + ', ' + transicao.diasPendentes + ' dia(s)): não dá para garantir folgas e limites — valide esses dias ou comece a escala numa segunda-feira' });
  const pesados = [0, 1, 2, 3, 4, 5, 6].filter(dw => [...new Set(funcs.map(f => f.setor))].some(s => peso(s, dw) > 1));
  const picoPorPessoa = proposta.map(p => p.folgasEmDiaPesado);
  const semC = proposta.flatMap(p => p.semanas.filter(s => s.completa && !s.ausencias && s.fim <= ate)); const ok52 = semC.filter(s => s.trabalho === 5 && s.folgas === 2).length;
  let consec = 0; for (const p of proposta) for (let d = de; d < ate; d = soma(d, 1)) { const a = p.dias[d], b = p.dias[soma(d, 1)]; if (a && b && a.tipo === 'folga' && b.tipo === 'folga') consec++; }
  return { modo: MODO, simulacao: true, periodo: { de, ate }, semanas: semanas.map(s => ({ inicio: s, fim: soma(s, 6), cruzaPeriodo: s < de || soma(s, 6) > ate })),
    proposta, conflitos: { trabalhistas, operacionais }, divergenciasContratuais, domingosFeriados,
    cobertura: { abre: hm(cob.abre), fecha: hm(cob.fecha), dias: cobDias, resumo: { dias: cobDias.length, dias_com_deficit: diasComDeficit, blocos_abaixo: blocosAbaixo, por_setor: Object.values(porSetor) } },
    continuidade, regrasAplicadas: regrasLista, publicacao: { liberada: false, bloqueios }, transicao,
    pesos: { diasPesados: pesados, folgasEmDiaPesado: picoPorPessoa.reduce((a, b) => a + b, 0), maiorPorPessoa: picoPorPessoa.length ? Math.max(...picoPorPessoa) : 0, menorPorPessoa: picoPorPessoa.length ? Math.min(...picoPorPessoa) : 0 },
    indicadores: { funcionarios: funcs.length, semanas_completas: semC.length, semanas_5x2: ok52, pct_semanas_5x2: semC.length ? +(ok52 / semC.length * 100).toFixed(1) : null, folgas_consecutivas: consec,
      media_semanal_min: semC.length ? Math.round(semC.reduce((t, s) => t + s.minutos, 0) / semC.length) : null, domingos_trabalhados: domingosFeriados.filter(x => x.tipo === 'domingo').length, feriados_trabalhados: domingosFeriados.filter(x => x.tipo === 'feriado').length,
      conflitos_trabalhistas: trabalhistas.length, conflitos_operacionais: operacionais.length, divergencias_contratuais: divergenciasContratuais.length } };
}

/** Geração por uma, várias ou todas as unidades: cada unidade tem os próprios funcionários, cobertura, histórico e travados. */
function gerarUnidades(ent) {
  ent = ent || {}; const unidades = {}; const resumo = [];
  for (const u of ent.unidades || []) {
    const r = gerar({ de: ent.de, ate: ent.ate, regras: ent.regras, feriados: u.feriados || ent.feriados, funcionarios: u.funcionarios, cobertura: u.cobertura, historico: u.historico, travados: u.travados });
    unidades[u.loja] = r; resumo.push({ loja: u.loja, ...r.indicadores, dias_com_deficit: r.cobertura.resumo.dias_com_deficit });
  }
  return { modo: MODO, simulacao: true, periodo: { de: ent.de, ate: ent.ate }, unidades, resumo, publicacao: { liberada: false } };
}

module.exports = { MODO, PARAMS_PADRAO, gerar, gerarUnidades, regraPara, _util: { soma, dow, segunda, min, hm, hhmm, liquido, combos } };
