'use strict';
// Gestão de escalas (DP / RH › Escalas), 22/10/2026 — regras e dados.
// Base: "Implementação — módulo de gestão inteligente de escalas" que o Tiago colou em 21/10.
// Reaproveita: papéis/escopo da central de pessoas (lib/gestao-pessoas.js) e a leitura do PontoCerto (lib/pontocerto.js:
// cadastro, escalas contratuais /shifts, marcações e afastamentos). Nada é escrito no PontoCerto.
// Dados em data/escalas/ (JSON, 1 arquivo por loja+mês, igual ao resto da central):
//   config.json                  horário de funcionamento e necessidade mínima por setor de cada loja, feriados, limites
//   <loja>-<AAAA-MM>.json        escala coletiva do mês: funcionários (jornada-base por dia da semana), dias alterados,
//                                status do fluxo, histórico (usuário, data, justificativa, antes/depois) e versões
// Distinção obrigatória: previsto (escala) × registrado (marcações do PontoCerto) × apuração oficial (RH no PontoCerto).
// Nenhum crédito de banco é gerado aqui — domingo/feriado só ficam marcados pra apuração trabalhista.
const fs = require('fs');
const path = require('path');
const GP = require('./gestao-pessoas');

const DIR = process.env.ESCALAS_DIR || path.join(__dirname, '..', 'data', 'escalas');
const P = { config: () => path.join(DIR, 'config.json'), escala: (loja, mes) => path.join(DIR, loja + '-' + mes + '.json') };
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const agoraIso = () => new Date().toISOString();
function gravarJson(arq, obj) { fs.mkdirSync(path.dirname(arq), { recursive: true }); const tmp = arq + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, arq); }
function lerJson(arq, padrao) { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return padrao; } }
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const min = hm => { const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
const hm = m => m == null ? null : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const hhmm = m => (m < 0 ? '-' : '') + Math.floor(Math.abs(m) / 60) + 'h' + String(Math.abs(m) % 60).padStart(2, '0');
const diaISO = (d = new Date()) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const dow = iso => new Date(iso + 'T12:00:00').getDay();
const somaDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return diaISO(d); };
function diasDoMes(mes) { const [a, m] = mes.split('-').map(Number); const n = new Date(a, m, 0).getDate(); const out = []; for (let d = 1; d <= n; d++) out.push(mes + '-' + String(d).padStart(2, '0')); return out; }
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ── Catálogo de setores (nomes do PontoCerto → setor operacional do painel) ──────────────────────────────
const SETORES = ['FRENTE DE CAIXA', 'REPOSICAO', 'ACOUGUE', 'BALCAO', 'PREVENCAO DE PERDAS', 'RECEBIMENTO'];
const SETOR_TXT = { 'FRENTE DE CAIXA': 'Frente de caixa', REPOSICAO: 'Reposição', ACOUGUE: 'Açougue', BALCAO: 'Balcão', 'PREVENCAO DE PERDAS': 'Prevenção de perdas', RECEBIMENTO: 'Recebimento' };
const ALIAS = [[/CAIXA/, 'FRENTE DE CAIXA'], [/REPOSI/, 'REPOSICAO'], [/ACOUG/, 'ACOUGUE'], [/BALC/, 'BALCAO'], [/PREVEN|FISCAL/, 'PREVENCAO DE PERDAS'], [/RECEB|EXPEDI|CONFER/, 'RECEBIMENTO']];
function setorOperacional(setorPontoCerto) { const s = semAcento(setorPontoCerto); for (const [re, k] of ALIAS) if (re.test(s)) return k; return s || 'OUTROS'; }
const setorTxt = s => SETOR_TXT[s] || (s ? s.charAt(0) + s.slice(1).toLowerCase() : '—');

// ── Config ───────────────────────────────────────────────────────────────────────────────────────────────
let cfgMem = null;
function lojaPadrao() { return { abre: '07:00', fecha: '19:00', setores: { 'FRENTE DE CAIXA': { min: 2 }, REPOSICAO: { min: 1 }, ACOUGUE: { min: 1 }, BALCAO: { min: 1 }, 'PREVENCAO DE PERDAS': { min: 1 }, RECEBIMENTO: { min: 0 } } }; }
function configPadrao() {
  const lojas = {}; for (const n of GP.LOJAS) lojas[n] = lojaPadrao();
  return { lojas, feriados: [], tolerancias: { marcacaoMin: 10 },
    // limites usados na validação da escala (configuráveis pelo RH/Coordenação conforme acordo coletivo)
    limites: { jornadaMaxMin: 600, intervaloMinMin: 60, jornadaComIntervaloMin: 360, interjornadaMin: 660, semanaMaxMin: 2640 }, versao: 1, alteracoes: [] };
}
function config() { if (cfgMem) return cfgMem; const c = lerJson(P.config(), null); const pad = configPadrao(); cfgMem = c ? { ...pad, ...c, lojas: { ...pad.lojas, ...(c.lojas || {}) }, limites: { ...pad.limites, ...(c.limites || {}) }, tolerancias: { ...pad.tolerancias, ...(c.tolerancias || {}) } } : pad; return cfgMem; }
function salvarConfig(mud, user) {
  if (!GP.temPapel(user, 'coordenacao') && !GP.temPapel(user, ...GP.RH)) throw erro('Só RH e Coordenação alteram a configuração das escalas', 403);
  const c = config(); mud = mud || {};
  if (mud.lojas) for (const [ln, l] of Object.entries(mud.lojas)) {
    if (!GP.LOJAS.includes(+ln)) throw erro('Loja inválida: ' + ln);
    const atual = c.lojas[ln] || lojaPadrao(); const novo = { ...atual };
    if (l.abre) { if (min(l.abre) == null) throw erro('Horário de abertura inválido'); novo.abre = l.abre; }
    if (l.fecha) { if (min(l.fecha) == null || min(l.fecha) <= min(novo.abre)) throw erro('Horário de fechamento inválido'); novo.fecha = l.fecha; }
    if (l.setores) { novo.setores = {}; for (const [s, v] of Object.entries(l.setores)) { const n = Math.round(+(v && v.min != null ? v.min : v)); if (!(n >= 0)) throw erro('Necessidade inválida em ' + s); novo.setores[semAcento(s)] = { min: n }; } }
    c.lojas[ln] = novo;
  }
  if (mud.feriados) { if (!Array.isArray(mud.feriados) || mud.feriados.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw erro('Feriados inválidos'); c.feriados = [...new Set(mud.feriados)].sort(); }
  if (mud.limites) { for (const [k, v] of Object.entries(mud.limites)) { if (!(k in c.limites) || !(+v >= 0)) throw erro('Limite inválido: ' + k); c.limites[k] = Math.round(+v); } }
  if (mud.tolerancias && mud.tolerancias.marcacaoMin != null) c.tolerancias.marcacaoMin = Math.max(0, Math.round(+mud.tolerancias.marcacaoMin));
  c.versao = (c.versao || 1) + 1; c.alteracoes = (c.alteracoes || []).concat([{ em: agoraIso(), por: user.usuario, campos: Object.keys(mud) }]).slice(-200);
  gravarJson(P.config(), c); cfgMem = c; GP.auditar({ usuario: user.usuario, acao: 'escalas_config', campos: Object.keys(mud) });
  return c;
}
const feriado = d => config().feriados.includes(d);

// ── Escala do mês ────────────────────────────────────────────────────────────────────────────────────────
const mem = new Map();
function ler(loja, mes) { const k = loja + '|' + mes; if (mem.has(k)) return mem.get(k); const e = lerJson(P.escala(loja, mes), null); if (e) mem.set(k, e); return e; }
function salvar(e) { e.atualizadoEm = agoraIso(); gravarJson(P.escala(e.loja, e.mes), e); mem.set(e.loja + '|' + e.mes, e); return e; }
function listar() { try { return fs.readdirSync(DIR).filter(f => /^\d+-\d{4}-\d{2}\.json$/.test(f)).map(f => { const [l, a, m] = f.replace('.json', '').split('-'); return { loja: +l, mes: a + '-' + m }; }); } catch (e) { return []; } }
/** jornada-base por dia da semana a partir da escala contratual do PontoCerto ({0..6: periods[]}) */
function baseDeEscala(escalaPC) {
  const base = {};
  for (let d = 0; d < 7; d++) {
    const ps = (escalaPC && escalaPC.dias && escalaPC.dias[d]) || [];
    base[d] = !ps.length ? null : ps.length === 1 ? { entrada: ps[0].entrada, saida: ps[0].saida, almoco_ini: null, almoco_fim: null } : { entrada: ps[0].entrada, saida: ps[ps.length - 1].saida, almoco_ini: ps[0].saida, almoco_fim: ps[1].entrada };
  }
  return base;
}
const folgasDe = base => [0, 1, 2, 3, 4, 5, 6].filter(d => !base[d]);
/**
 * Cria a escala do mês a partir do PontoCerto (cadastro + /shifts). `colabs` e `escalasPC` vêm de lib/pontocerto.js
 * (injetados pelas rotas pra este módulo ficar testável sem rede).
 */
function criarDoPontoCerto(loja, mes, colabs, escalasPC, user) {
  const funcs = colabs.ativos.filter(c => +c.loja === +loja).map(c => { const base = baseDeEscala(escalasPC.get(c.turno_id)); return { id: c.id, nome: c.nome, matricula: c.matricula || '', cargo: c.cargo || '', setor_pc: c.setor || '', setor: setorOperacional(c.setor), turno: c.turno || '', base, folga_fixa: folgasDe(base), habilitado: [] }; })
    .sort((a, b) => a.setor.localeCompare(b.setor) || a.nome.localeCompare(b.nome));
  const e = { loja: +loja, mes, status: 'rascunho', versao: 1, origem: 'pontocerto', demo: false, criadoEm: agoraIso(), criadoPor: user ? user.usuario : 'sistema', funcionarios: funcs, dias: {}, historico: [], fluxo: [], versoes: [] };
  return salvar(e);
}
/** Semente demonstrativa da Loja 1 (Socorro) do prompt — só entra num mês ainda sem escala e fica marcada como demo */
const DEMO_SOCORRO = [['Dayse', 'FRENTE DE CAIXA', 1], ['Roberta', 'FRENTE DE CAIXA', 4], ['Milene', 'FRENTE DE CAIXA', 3], ['Antônio', 'REPOSICAO', 3], ['Rogério', 'REPOSICAO', 2], ['José Carlos', 'BALCAO', 2], ['Alex', 'ACOUGUE', 4], ['Lívia', 'PREVENCAO DE PERDAS', null], ['Eduardo', 'RECEBIMENTO', null]];
function criarDemoSocorro(mes, user) {
  if (ler(1, mes)) throw erro('Já existe escala de Socorro em ' + mes + '; a semente demonstrativa só entra em mês vazio');
  const jornada = { entrada: '07:00', saida: '17:00', almoco_ini: '12:00', almoco_fim: '14:00' };   // escala-base: integral com 2 h de intervalo
  const funcs = DEMO_SOCORRO.map(([nome, setor, folga], i) => { const base = {}; for (let d = 0; d < 7; d++) base[d] = d === 0 || d === folga ? null : { ...jornada }; return { id: -(i + 1), nome: nome + ' (demo)', matricula: '', cargo: setorTxt(setor), setor_pc: setor, setor, turno: 'Demonstrativo', base, folga_fixa: folgasDe(base), habilitado: [] }; });
  return salvar({ loja: 1, mes, status: 'rascunho', versao: 1, origem: 'demo', demo: true, criadoEm: agoraIso(), criadoPor: user ? user.usuario : 'sistema', funcionarios: funcs, dias: {}, historico: [], fluxo: [], versoes: [] });
}

// ── Resolução de um dia (previsto) ───────────────────────────────────────────────────────────────────────
const TIPO_TXT = { trabalho: 'Trabalho', folga: 'Folga', ferias: 'Férias', afastado: 'Afastado', feriado: 'Feriado' };
/** afast = Map nome→[{inicio,fim,ferias}] (pontocerto.afastamentos) opcional */
function diaDe(e, f, data, afast) {
  const ov = e.dias[f.id + '|' + data];
  if (ov) return { ...ov, alterado: true };
  const a = afast && afast.get(semAcento(f.nome)); const af = a && a.find(x => x.inicio <= data && x.fim >= data);
  if (af) return { tipo: af.ferias ? 'ferias' : 'afastado', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: f.setor };
  if (feriado(data)) return { tipo: 'feriado', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: f.setor };
  const b = f.base[dow(data)];
  return b ? { tipo: 'trabalho', ...b, setor: f.setor } : { tipo: 'folga', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: f.setor };
}
const horasDia = d => d.tipo !== 'trabalho' || min(d.entrada) == null || min(d.saida) == null ? 0 : Math.max(0, min(d.saida) - min(d.entrada) - (min(d.almoco_ini) != null && min(d.almoco_fim) != null ? min(d.almoco_fim) - min(d.almoco_ini) : 0));
function resolver(e, afast) {
  const dias = diasDoMes(e.mes);
  return e.funcionarios.map(f => { const porDia = {}; let total = 0; for (const d of dias) { const x = diaDe(e, f, d, afast); x.minutos = horasDia(x); total += x.minutos; porDia[d] = x; }
    return { ...f, dias: porDia, minutos_mes: total, horas_mes: hhmm(total) }; });
}

// ── Cobertura por setor em blocos de 15 min ──────────────────────────────────────────────────────────────
function slots(loja) { const l = config().lojas[loja] || lojaPadrao(); const out = []; for (let t = min(l.abre); t < min(l.fecha); t += 15) out.push(t); return out; }
function estadoEm(d, t) {
  if (d.tipo !== 'trabalho') return d.tipo;
  const e = min(d.entrada), s = min(d.saida); if (e == null || s == null || t < e || t >= s) return 'fora';
  const ai = min(d.almoco_ini), af = min(d.almoco_fim); if (ai != null && af != null && t >= ai && t < af) return 'almoco';
  return 'disponivel';
}
/** cobertura de uma loja num dia: por setor, por bloco; funcs = resolver(e) (ou lista de {nome, setor, dias[data]}) */
function cobertura(loja, data, funcs, cfgLoja) {
  const L = cfgLoja || config().lojas[loja] || lojaPadrao(); const ss = slots(loja);
  const setores = {}; const add = s => setores[s] || (setores[s] = { setor: s, nome: setorTxt(s), min: (L.setores[s] || {}).min || 0, blocos: ss.map(t => ({ t, hm: hm(t), disponiveis: 0, almoco: 0, fora: 0, pessoas: [] })), pessoas: [] });
  for (const s of Object.keys(L.setores)) add(s);
  for (const f of funcs) {
    const d = f.dias[data]; if (!d) continue; const s = d.setor || f.setor; const S = add(s);
    S.pessoas.push({ id: f.id, nome: f.nome, tipo: d.tipo, entrada: d.entrada, saida: d.saida, almoco_ini: d.almoco_ini, almoco_fim: d.almoco_fim, alterado: !!d.alterado, estados: ss.map(t => estadoEm(d, t)) });
    if (d.tipo !== 'trabalho') continue;
    S.blocos.forEach((b, i) => { const st = estadoEm(d, b.t); if (st === 'disponivel') { b.disponiveis++; b.pessoas.push(f.nome); } else if (st === 'almoco') b.almoco++; else b.fora++; });
  }
  for (const S of Object.values(setores)) {
    for (const b of S.blocos) b.status = S.min === 0 ? 'neutro' : b.disponiveis > S.min ? 'ok' : b.disponiveis === S.min ? 'min' : 'baixa';
    S.blocos_baixa = S.blocos.filter(b => b.status === 'baixa').length; S.blocos_min = S.blocos.filter(b => b.status === 'min').length;
    S.escalados = S.pessoas.filter(p => p.tipo === 'trabalho').length; S.folga = S.pessoas.filter(p => p.tipo === 'folga').length;
  }
  const ordem = s => { const i = SETORES.indexOf(s); return i < 0 ? 99 : i; };
  return { loja: +loja, data, abre: L.abre, fecha: L.fecha, slots: ss.map(hm), setores: Object.values(setores).sort((a, b) => ordem(a.setor) - ordem(b.setor) || a.setor.localeCompare(b.setor)) };
}
/** Sugestões (nunca aplicadas): mover almoço de quem cobre um buraco, ou apoio de setor com sobra/habilitado */
function sugestoes(cob) {
  const out = [];
  for (const S of cob.setores) {
    if (!S.blocos_baixa) continue;
    const faixas = []; let ini = null; S.blocos.forEach((b, i) => { if (b.status === 'baixa') { if (ini == null) ini = i; } else if (ini != null) { faixas.push([ini, i - 1]); ini = null; } }); if (ini != null) faixas.push([ini, S.blocos.length - 1]);
    for (const [a, b] of faixas) {
      const de = S.blocos[a].hm, ate = hm(S.blocos[b].t + 15);
      // 1) alguém do setor está em almoço justamente nessa faixa
      const emAlmoco = S.pessoas.filter(p => p.tipo === 'trabalho' && p.estados.slice(a, b + 1).includes('almoco'));
      for (const p of emAlmoco) {
        const dur = min(p.almoco_fim) - min(p.almoco_ini); const antes = min(p.almoco_ini) - dur, depois = min(S.blocos[b].t) + 15;
        const cabe = x => x >= min(p.entrada) && x + dur <= min(p.saida);
        const opc = [cabe(antes) ? hm(antes) + '–' + hm(antes + dur) : null, cabe(depois) ? hm(depois) + '–' + hm(depois + dur) : null].filter(Boolean);
        if (opc.length) out.push({ setor: S.setor, setorTxt: S.nome, faixa: de + '–' + ate, tipo: 'almoco', texto: 'Mover o almoço de ' + p.nome + ' (' + p.almoco_ini + '–' + p.almoco_fim + ') para ' + opc.join(' ou '), funcId: p.id });
      }
      // 2) apoio: pessoa de outro setor com cobertura acima do mínimo em toda a faixa (habilitada, se o cadastro disser)
      for (const O of cob.setores) {
        if (O.setor === S.setor) continue;
        const sobra = O.blocos.slice(a, b + 1).every(x => x.disponiveis > O.min + 0); if (!sobra) continue;
        const cand = O.pessoas.find(p => p.tipo === 'trabalho' && p.estados.slice(a, b + 1).every(x => x === 'disponivel') && (!p.habilitado || !p.habilitado.length || p.habilitado.includes(S.setor)));
        if (cand) out.push({ setor: S.setor, setorTxt: S.nome, faixa: de + '–' + ate, tipo: 'apoio', texto: 'Apoio de ' + cand.nome + ' (' + O.nome + ', com sobra nessa faixa) em ' + S.nome, funcId: cand.id, deSetor: O.setor });
      }
      if (!emAlmoco.length && !out.some(x => x.setor === S.setor && x.faixa === de + '–' + ate)) out.push({ setor: S.setor, setorTxt: S.nome, faixa: de + '–' + ate, tipo: 'sem_opcao', texto: 'Sem cobertura em ' + S.nome + ' das ' + de + ' às ' + ate + ': não há almoço a remanejar nem sobra em outro setor; avaliar ajuste de jornada ou contratação pela central.' });
    }
  }
  return out.slice(0, 40);
}

// ── Validação de um dia editado ──────────────────────────────────────────────────────────────────────────
function validarDia(e, f, data, novo, justificativa, afast) {
  const L = config().limites; const erros = [], avisos = [];
  if (!TIPO_TXT[novo.tipo]) erros.push('Tipo inválido');
  if (novo.tipo === 'trabalho') {
    const en = min(novo.entrada), sa = min(novo.saida); if (en == null || sa == null || sa <= en) erros.push('Entrada e saída obrigatórias (saída depois da entrada)');
    const ai = min(novo.almoco_ini), af = min(novo.almoco_fim); const temAlm = ai != null && af != null;
    if ((ai != null) !== (af != null)) erros.push('Informe início e fim do almoço');
    if (temAlm && !(ai >= en && af <= sa && af > ai)) erros.push('Almoço precisa ficar dentro da jornada');
    const bruto = en != null && sa != null ? sa - en : 0; const alm = temAlm ? af - ai : 0; const liq = bruto - alm;
    if (bruto > L.jornadaComIntervaloMin && alm < L.intervaloMinMin) erros.push('Jornada acima de ' + hhmm(L.jornadaComIntervaloMin) + ' exige intervalo de pelo menos ' + hhmm(L.intervaloMinMin));
    if (liq > L.jornadaMaxMin) erros.push('Jornada de ' + hhmm(liq) + ' passa do limite de ' + hhmm(L.jornadaMaxMin));
    // interjornada: 11 h entre a saída da véspera e esta entrada, e entre esta saída e a entrada do dia seguinte
    const ant = diaDe(e, f, somaDias(data, -1), afast), prox = diaDe(e, f, somaDias(data, 1), afast);
    if (ant.tipo === 'trabalho' && min(ant.saida) != null && en != null && (24 * 60 - min(ant.saida)) + en < L.interjornadaMin) erros.push('Descanso entre jornadas menor que ' + hhmm(L.interjornadaMin) + ' (saída de ' + somaDias(data, -1).slice(8) + ' às ' + ant.saida + ')');
    if (prox.tipo === 'trabalho' && min(prox.entrada) != null && sa != null && (24 * 60 - sa) + min(prox.entrada) < L.interjornadaMin) erros.push('Descanso entre jornadas menor que ' + hhmm(L.interjornadaMin) + ' (entrada de ' + somaDias(data, 1).slice(8) + ' às ' + prox.entrada + ')');
    if (f.folga_fixa.includes(dow(data)) && !txt(justificativa)) erros.push('Este é o dia de folga fixa de ' + f.nome + ': só com justificativa');
    if (dow(data) === 0 || feriado(data)) avisos.push('Domingo/feriado: fica registrado para a apuração trabalhista; nenhum crédito de banco é gerado automaticamente');
    // carga semanal (segunda a domingo)
    const d0 = somaDias(data, -((dow(data) + 6) % 7)); let sem = 0; for (let i = 0; i < 7; i++) { const d = somaDias(d0, i); sem += d === data ? liq : horasDia(diaDe(e, f, d, afast)); }
    if (sem > L.semanaMaxMin) avisos.push('Semana com ' + hhmm(sem) + ' (limite configurado ' + hhmm(L.semanaMaxMin) + ')');
    if (novo.setor && novo.setor !== f.setor && f.habilitado && f.habilitado.length && !f.habilitado.includes(novo.setor)) erros.push(f.nome + ' não está habilitado para ' + setorTxt(novo.setor));
  } else if (novo.tipo === 'folga' && !f.folga_fixa.includes(dow(data)) && f.base[dow(data)] && !txt(justificativa)) erros.push('Folga fora do dia fixo: só com justificativa');
  return { erros, avisos };
}

// ── Permissões e fluxo ───────────────────────────────────────────────────────────────────────────────────
const STATUS_TXT = { rascunho: 'Rascunho do gerente', enviada_rh: 'Enviada ao RH', validada_rh: 'Validada pelo RH · aguardando Coordenação', aprovada: 'Aprovada', devolvida: 'Devolvida para ajustes' };
const podeVer = (user, loja) => GP.vePainel(user) && GP.veLoja(user, loja);
const podeEditar = (user, e) => !GP.temPapel(user, 'diretoria') && GP.gerenteDa(user, e.loja) && ['rascunho', 'devolvida', 'aprovada'].includes(e.status);
function acoes(user, e) {
  const a = []; if (!podeVer(user, e.loja) || (GP.temPapel(user, 'diretoria') && GP.papeisDe(user).length === 1)) return a;
  if (GP.gerenteDa(user, e.loja) && ['rascunho', 'devolvida'].includes(e.status)) a.push('enviar');
  if (GP.rhDa(user, e.loja, 'rh_ponto') && e.status === 'enviada_rh') a.push('validar', 'devolver');
  if (GP.temPapel(user, 'coordenacao') && e.status === 'validada_rh') a.push('aprovar', 'devolver');
  if (podeEditar(user, e)) a.push('editar');
  return a;
}
function editarDia(loja, mes, user, body, afast) {
  const e = obter(loja, mes); if (!podeEditar(user, e)) throw erro(e.status === 'enviada_rh' || e.status === 'validada_rh' ? 'Escala em aprovação: peça devolução para editar' : 'Só o gerente da unidade edita a escala', 403);
  const f = e.funcionarios.find(x => +x.id === +body.funcId); if (!f) throw erro('Funcionário não está nesta escala', 404);
  const data = String(body.data || ''); if (!data.startsWith(e.mes + '-') || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw erro('Data fora do mês da escala');
  const novo = { tipo: body.tipo || 'trabalho', entrada: body.entrada || null, saida: body.saida || null, almoco_ini: body.almoco_ini || null, almoco_fim: body.almoco_fim || null, setor: body.setor ? semAcento(body.setor) : f.setor, obs: txt(body.obs, 200) };
  if (novo.tipo !== 'trabalho') { novo.entrada = novo.saida = novo.almoco_ini = novo.almoco_fim = null; }
  const v = validarDia(e, f, data, novo, body.justificativa, afast); if (v.erros.length) throw Object.assign(erro(v.erros.join(' · ')), { erros: v.erros });
  const k = f.id + '|' + data; const salvo = e.dias[k]; delete e.dias[k];
  const padrao = diaDe(e, f, data, afast);                                   // o que vale sem alteração (contratual/feriado/férias)
  const antes = salvo ? { ...salvo } : { ...padrao }; delete antes.alterado;
  const chave = x => JSON.stringify({ tipo: x.tipo, entrada: x.entrada, saida: x.saida, almoco_ini: x.almoco_ini, almoco_fim: x.almoco_fim, setor: x.setor });
  const semMudanca = chave(padrao) === chave(novo);                          // voltou ao contratual: não fica alteração pendurada
  if (!semMudanca) e.dias[k] = novo;
  if (e.status === 'aprovada') { e.versoes.push({ versao: e.versao, status: 'aprovada', em: e.aprovadaEm || e.atualizadoEm, dias: JSON.parse(JSON.stringify(e.dias)) }); e.status = 'rascunho'; e.versao++; e.fluxo.push({ em: agoraIso(), usuario: user.usuario, nome: user.nome, de: 'aprovada', para: 'rascunho', texto: 'Alteração após aprovação: volta para proposta do gerente' }); }
  e.historico.push({ em: agoraIso(), usuario: user.usuario, nome: user.nome, acao: semMudanca ? 'restaurar' : 'alterar', funcId: f.id, funcionario: f.nome, data, antes, depois: semMudanca ? antes : novo, justificativa: txt(body.justificativa, 500), versao: e.versao });
  salvar(e); GP.auditar({ usuario: user.usuario, acao: 'escala_alterar', ref: 'ESC-' + e.loja + '-' + e.mes, funcId: f.id, data });
  return { ok: true, avisos: v.avisos, dia: diaDe(e, f, data, afast) };
}
function mover(loja, mes, user, acao, texto) {
  const e = obter(loja, mes); if (!acoes(user, e).includes(acao)) throw erro('Ação não permitida para você nesta escala (' + STATUS_TXT[e.status] + ')', 403);
  const t = txt(texto, 1000); if (acao !== 'enviar' && !t) throw erro('Registre o parecer/justificativa');
  const de = e.status; e.status = { enviar: 'enviada_rh', validar: 'validada_rh', aprovar: 'aprovada', devolver: 'devolvida' }[acao];
  if (acao === 'aprovar') { e.aprovadaEm = agoraIso(); e.aprovadaPor = user.usuario; }
  e.fluxo.push({ em: agoraIso(), usuario: user.usuario, nome: user.nome, papeis: GP.papeisDe(user), de, para: e.status, texto: t || null });
  salvar(e); GP.auditar({ usuario: user.usuario, acao: 'escala_' + acao, ref: 'ESC-' + e.loja + '-' + e.mes, de, para: e.status });
  const destino = acao === 'enviar' ? ['rh_ponto'] : acao === 'validar' ? ['coordenacao'] : ['gerente'];
  GP.notificar(GP.config().designados.filter(d => d.papeis.some(p => destino.includes(p)) && (p => p === 'coordenacao' || !d.lojas.length || d.lojas.includes(e.loja))(destino[0])).map(d => d.usuario), 'Escala ' + GP.LOJA_TXT[e.loja] + ' ' + e.mes + ': ' + STATUS_TXT[e.status] + '.', { aba: 'escalas', loja: e.loja, mes: e.mes });
  return e;
}
function obter(loja, mes) { const e = ler(loja, mes); if (!e) throw erro('Ainda não há escala de ' + (GP.LOJA_TXT[loja] || loja) + ' em ' + mes, 404); return e; }

// ── Divergência escala × ponto (marcações do PontoCerto) ────────────────────────────────────────────────
/** jornada = linhas de pontocerto.jornadaDia(data) (marcacoes, entrada, saidaInt, retornoInt, saida) */
function divergencias(e, data, funcs, jornada, hoje) {
  const tol = config().tolerancias.marcacaoMin; const porId = new Map((jornada || []).map(l => [l.id, l])); const out = [];
  const dif = (prev, reg) => prev && reg ? Math.abs(min(reg) - min(prev)) : null;
  for (const f of funcs) {
    const d = f.dias[data]; const j = porId.get(f.id); if (!d || !j) continue; const m = j.marcacoes || [];
    const itens = [];
    if (d.tipo === 'trabalho') {
      if (!m.length) { if (data < hoje) itens.push({ tipo: 'sem_marcacao', texto: 'Escalado ' + d.entrada + '–' + d.saida + ' e sem marcação (analisar: não é falta automática)' }); }
      else {
        const de = dif(d.entrada, j.entrada); if (de != null && de > tol) itens.push({ tipo: 'entrada', texto: 'Entrada prevista ' + d.entrada + ', registrada ' + j.entrada });
        const ds = dif(d.saida, j.saida); if (ds != null && ds > tol) itens.push({ tipo: 'saida', texto: 'Saída prevista ' + d.saida + ', registrada ' + j.saida });
        if (d.almoco_ini && j.saidaInt) { const di = dif(d.almoco_ini, j.saidaInt), dr = dif(d.almoco_fim, j.retornoInt); if ((di != null && di > tol) || (dr != null && dr > tol)) itens.push({ tipo: 'intervalo', texto: 'Intervalo previsto ' + d.almoco_ini + '–' + d.almoco_fim + ', registrado ' + j.saidaInt + '–' + (j.retornoInt || '…') }); }
      }
    } else if (['folga', 'feriado'].includes(d.tipo) && m.length) itens.push({ tipo: 'trabalho_em_folga', texto: TIPO_TXT[d.tipo] + ' programada e ' + m.length + ' marcação(ões): ' + m.join(' · ') });
    if (itens.length) out.push({ id: f.id, nome: f.nome, setor: f.setor, previsto: d, registrado: m, apuracao: j.apuracao || null, itens });
  }
  return out;
}

// ── Painel da coordenação ────────────────────────────────────────────────────────────────────────────────
function resumoLoja(loja, data, funcs, agoraMin, alertasBH) {
  const cob = cobertura(loja, data, funcs); const n = f => funcs.filter(x => x.dias[data] && x.dias[data].tipo === f).length;
  const emIntervalo = funcs.filter(f => f.dias[data] && estadoEm(f.dias[data], agoraMin) === 'almoco').length;
  const disponiveisAgora = funcs.filter(f => f.dias[data] && estadoEm(f.dias[data], agoraMin) === 'disponivel').length;
  return { loja: +loja, lojaTxt: GP.LOJA_TXT[loja], total: funcs.length, escalados: n('trabalho'), folga: n('folga'), ferias: n('ferias') + n('afastado'), em_intervalo: emIntervalo, disponiveis_agora: disponiveisAgora,
    setores: cob.setores.map(s => ({ setor: s.setor, nome: s.nome, min: s.min, escalados: s.escalados, blocos_baixa: s.blocos_baixa, blocos_min: s.blocos_min })), blocos_baixa: cob.setores.reduce((t, s) => t + s.blocos_baixa, 0), alertas_bh: alertasBH || 0 };
}
function recarregar() { cfgMem = null; mem.clear(); }
module.exports = { DIR, SETORES, SETOR_TXT, TIPO_TXT, STATUS_TXT, setorOperacional, setorTxt, config, salvarConfig, feriado, diasDoMes, ler, listar, obter, salvar, criarDoPontoCerto, criarDemoSocorro, baseDeEscala,
  diaDe, horasDia, resolver, slots, estadoEm, cobertura, sugestoes, validarDia, podeVer, podeEditar, acoes, editarDia, mover, divergencias, resumoLoja, recarregar, _util: { min, hm, hhmm, dow, somaDias, diaISO } };
