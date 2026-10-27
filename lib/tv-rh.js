'use strict';
// lib/tv-rh.js — TV do RH: Ponto e Jornada (Tiago, 26/10/2026). Telão dentro do RH com o ponto do dia, nome a
// nome: resumo, entradas, intervalos, saídas e pendências. Mesmo esquema das TVs do açougue e do televendas
// (link público por token, config relida a cada poucos segundos, página pública em public/tv-rh.html).
// Dados: a MESMA jornada diária da aba DP / RH › Jornada diária (pontocerto.jornadaDia — cadastro + escala +
// marcações + apuração do PontoCerto). Nada é recalculado por fora da apuração oficial: atraso só aparece como
// "confirmado" quando o relatório delays confirma; marcação ausente NUNCA vira falta aqui — vira "Sem marcação",
// "Ainda não chegou o horário" ou "Em apuração", conforme o horário previsto da escala.
// Config em data/tv-rh.json (lojas, setores, segundos, linhas por tela, título, selos, telas ligadas).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOJAS = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão', 10: 'CD · Centro de Distribuição' };
const ETQ = n => +n === 10 ? 'CD' : 'E' + n;
const TELAS = ['resumo', 'entradas', 'intervalos', 'saidas', 'pendencias'];
const ESCALAS = [100, 115, 130, 145];       // tamanho da letra (%): 100 = TV 42"–55"; 130/145 = TV de 32" (Tiago, 27/10)
const PADRAO = { lojas: [], setores: [], segundos: 12, linhas: 10, escala: 100, titulo: 'Ponto e Jornada', rodape: '',
                 selos: ['Pessoas em primeiro lugar', 'Ponto em dia', 'Jornada respeitada'],
                 telas: { resumo: true, entradas: true, intervalos: true, saidas: true, pendencias: true } };
const CACHE_MS = 60 * 1000;                 // payload pronto vale 1 min; depois renova em segundo plano (a TV nunca espera)
const DESATUALIZADO_MS = 30 * 60 * 1000;    // sem conseguir renovar há mais que isso = a TV avisa em vez de mostrar dado velho
const TOL_PADRAO = 10;                      // tolerância de atraso (min) quando a Central de Gestão de Pessoas não informa

// Situações da TV (texto que aparece na tela). Só estas — a TV não inventa estado fora da apuração.
const SIT = { ok: 'No horário', folga_trab: 'Trabalho em folga', adiantado: 'Antes do horário', atraso: 'Atraso confirmado', aguardando: 'Ainda não chegou o horário', intervalo: 'Em intervalo', retornou: 'Retornou',
              jornada: 'Em jornada', encerrada: 'Jornada encerrada', sem: 'Sem marcação', sem_retorno: 'Sem retorno', pendente: 'Saída pendente', apuracao: 'Em apuração' };
const FORA_DO_DIA = { folga: 'Folga', ferias: 'Férias', afastado: 'Afastado' };   // não entram nos previstos do dia

let deps = {}, ARQ = null, config = null;
let cache = null;          // { em, ms, dados, erro }
let renovando = null;      // Promise em andamento (uma renovação por vez)

const novoTok = () => crypto.randomBytes(16).toString('hex');
const hojeStr = () => { const h = new Date(); return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`; };
const agoraHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const min = hm => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

function init(d) {
  deps = d || {};
  const dir = deps.dataDir || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  ARQ = path.join(dir, 'tv-rh.json');
  cache = null; renovando = null;
  try { config = normalizar(JSON.parse(fs.readFileSync(ARQ, 'utf8')), true); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[TV-RH] tv-rh.json ilegível:', e.message); config = null; }
  if (!config) { config = normalizar({}, true); config.token = novoTok(); gravar(); }
}
function gravar() { fs.writeFileSync(ARQ, JSON.stringify(config, null, 1)); }
function getConfig() { return JSON.parse(JSON.stringify(config)); }
function tokenValido(t) { return !!t && t === config.token; }
function novoToken() { config.token = novoTok(); config.atualizadoEm = new Date().toISOString(); gravar(); return getConfig(); }

// Normaliza/valida um parcial em cima do atual (ou dos padrões). Lança Error em português (lenient = só corrige).
function normalizar(parcial, lenient) {
  const base = config || { ...PADRAO, lojas: [], setores: [], selos: [...PADRAO.selos], telas: { ...PADRAO.telas } };
  const p = parcial || {};
  const c = { ...base, lojas: [...(base.lojas || [])], setores: [...(base.setores || [])], selos: [...(base.selos || [])], telas: { ...(base.telas || {}) } };
  const err = msg => { if (lenient) return; throw new Error(msg); };
  if (p.lojas !== undefined) {
    if (!Array.isArray(p.lojas)) err('Lista de lojas inválida');
    else { const l = [...new Set(p.lojas.map(x => parseInt(x, 10)).filter(n => LOJAS[n]))]; if (p.lojas.length && !l.length) err('Loja inválida (E1 a E6 ou CD)'); else c.lojas = l.sort((a, b) => a - b); }
  }
  if (p.setores !== undefined) {
    if (!Array.isArray(p.setores)) err('Lista de setores inválida');
    else c.setores = [...new Set(p.setores.map(s => semAcento(s).slice(0, 30)).filter(Boolean))].slice(0, 40);
  }
  if (p.segundos !== undefined) { const n = Number(p.segundos); if (!(n >= 5 && n <= 60)) err('Segundos por tela deve ficar entre 5 e 60'); else c.segundos = Math.round(n); }
  if (p.linhas !== undefined) { const n = Number(p.linhas); if (!(n >= 6 && n <= 14)) err('Funcionários por tela deve ficar entre 6 e 14'); else c.linhas = Math.round(n); }
  if (p.escala !== undefined) { const n = Number(p.escala); if (!ESCALAS.includes(n)) err('Tamanho da letra inválido'); else c.escala = n; }
  if (typeof p.titulo === 'string') c.titulo = p.titulo.trim().slice(0, 40) || PADRAO.titulo;
  if (typeof p.rodape === 'string') c.rodape = p.rodape.trim().slice(0, 120);
  if (p.selos !== undefined) { if (!Array.isArray(p.selos)) err('Selos inválidos'); else c.selos = p.selos.map(x => String(x || '').trim().slice(0, 32)).slice(0, 3); }
  if (p.telas !== undefined) {
    if (!p.telas || typeof p.telas !== 'object') err('Telas inválidas');
    else { for (const t of TELAS) if (p.telas[t] !== undefined) c.telas[t] = !!p.telas[t]; if (!TELAS.some(t => c.telas[t])) err('Ligue pelo menos uma tela'); }
  }
  if (p.token && /^[a-f0-9]{32}$/.test(p.token)) c.token = p.token;
  if (!Array.isArray(c.lojas)) c.lojas = []; c.lojas = c.lojas.filter(n => LOJAS[n]);
  if (!Array.isArray(c.setores)) c.setores = [];
  if (!(c.segundos >= 5 && c.segundos <= 60)) c.segundos = PADRAO.segundos;
  if (!(c.linhas >= 6 && c.linhas <= 14)) c.linhas = PADRAO.linhas;
  if (!ESCALAS.includes(c.escala)) c.escala = PADRAO.escala;
  if (typeof c.titulo !== 'string' || !c.titulo) c.titulo = PADRAO.titulo;
  if (typeof c.rodape !== 'string') c.rodape = '';
  if (!Array.isArray(c.selos)) c.selos = [...PADRAO.selos];
  for (const t of TELAS) if (typeof c.telas[t] !== 'boolean') c.telas[t] = PADRAO.telas[t];
  if (!TELAS.some(t => c.telas[t])) c.telas = { ...PADRAO.telas };
  return c;
}
function salvarConfig(parcial, usuario) {
  const novo = normalizar(parcial, false);
  novo.token = config.token; novo.atualizadoEm = new Date().toISOString(); novo.atualizadoPor = usuario || null;
  config = novo; gravar();
  return getConfig();
}

// ── Classificação pra TV (pura; testada em test/tv-rh.test.js) ───────────────────────────────────────────
// Recebe uma linha de pontocerto.jornadaDia (situacao, previsto, entrada, saidaInt, retornoInt, saida, atraso_min,
// marcacoes) e a hora atual; devolve as situações de entrada, intervalo, saída e da jornada, mais pendências e
// divergências em texto. Regras:
//  · "Atraso confirmado" só quando a apuração (relatório delays) confirmou — é a situação 'atraso' da jornada.
//  · Entrada depois do previsto + tolerância ainda sem confirmação = "Em apuração" (não é atraso até a apuração dizer).
//  · Sem marcação de entrada: antes do previsto (+ tolerância) = "Ainda não chegou o horário"; depois = "Sem marcação".
//  · Intervalo: retorno esperado = previsto, ou a saída real + duração prevista quando saiu depois do previsto.
//  · Saída: antes do previsto (+ tolerância) sem marcação = "Em jornada"; depois = "Saída pendente".
function classificar(l, agora, tol) {
  const t = tol == null ? TOL_PADRAO : tol; const ag = min(agora);
  const s = l.situacao; const pv = l.previsto || null; const folga = !!(pv && pv.folga);
  const e = min(l.entrada), si = min(l.saidaInt), ri = min(l.retornoInt), sa = min(l.saida);
  const pe = pv && !folga ? min(pv.entrada) : null, psi = pv && !folga ? min(pv.saidaInt) : null, pri = pv && !folga ? min(pv.retornoInt) : null, psa = pv && !folga ? min(pv.saida) : null;
  const comIntervalo = psi != null && pri != null;
  const out = { entrada: null, intervalo: null, saida: null, jornada: null, pendencias: [], divergencias: [] };
  const sit = (k, txt) => ({ sit: k, txt: txt || SIT[k] });
  if (FORA_DO_DIA[s]) { out.foraDoDia = s; out.jornada = { sit: s, txt: FORA_DO_DIA[s] }; return out; }
  // entrada
  if (e == null) {
    if (s === 'sem_escala') out.entrada = sit('apuracao', 'Escala não informada');
    else if (pe != null && ag < pe + t) out.entrada = sit('aguardando');
    else out.entrada = sit('sem');
  } else if (s === 'atraso') out.entrada = sit('atraso');
  else if (pe != null && e > pe + t) { out.entrada = sit('apuracao'); out.divergencias.push(`Entrada ${l.entrada} · previsto ${pv.entrada} · aguardando a apuração`); }
  // 27/10 (Tiago: "previsto 09 horas e bateu 08 e deu no horário, por quê?"): bater ANTES do previsto além da tolerância não é "No horário"
  else if (pe != null && e < pe - t && s !== 'folga_trabalhada') { out.entrada = sit('adiantado'); out.divergencias.push(`Entrada ${l.entrada} · previsto ${pv.entrada} · antes do horário`); }
  else out.entrada = sit(s === 'folga_trabalhada' ? 'folga_trab' : 'ok');   // 27/10: "Trabalho em folga" com cor própria na TV (não é "No horário")
  if (s === 'folga_trabalhada') out.divergencias.push('Trabalho em dia de folga');
  if (s === 'atraso') out.divergencias.push(`Atraso de ${l.atraso_min} min · previsto ${(pv && pv.entrada) || l.previsto_entrada_apuracao || '—'}, entrou ${l.entrada}`);
  // intervalo (só quem tem intervalo na escala e já entrou)
  if (comIntervalo && e != null) {
    const dur = pri - psi; const esperado = si != null ? Math.max(pri, si + dur) : pri;
    if (si == null) {
      if (sa != null) { out.intervalo = sit('sem'); out.pendencias.push('Saída e retorno do intervalo'); }
      else if (ag < pri + t) out.intervalo = sit('aguardando', ag < psi + t ? 'Ainda não chegou o horário' : 'Aguardando a saída');
      else { out.intervalo = sit('sem'); out.pendencias.push('Saída e retorno do intervalo'); }
    } else if (ri == null) {
      if (sa != null) { out.intervalo = sit('sem', 'Sem retorno'); out.pendencias.push('Retorno do intervalo'); }
      else if (ag <= esperado + t) out.intervalo = sit('intervalo');
      else { out.intervalo = sit('sem_retorno'); out.pendencias.push('Retorno do intervalo'); }
    } else {
      out.intervalo = sit('retornou');
      if (ri > esperado + t) out.divergencias.push(`Retorno do intervalo ${l.retornoInt} · esperado ${String(Math.floor(esperado / 60)).padStart(2, '0')}:${String(esperado % 60).padStart(2, '0')}`);
    }
    out.intervalo.esperado = esperado;
  }
  // saída
  if (e == null) out.saida = null;
  else if (sa != null) {
    out.saida = sit('encerrada');
    if (psa != null && sa < psa - t) out.divergencias.push(`Saída ${l.saida} · previsto ${pv.saida} · antes do horário`);
  } else if (out.intervalo && (out.intervalo.sit === 'intervalo' || out.intervalo.sit === 'sem_retorno')) out.saida = sit(out.intervalo.sit === 'intervalo' ? 'intervalo' : 'jornada', out.intervalo.sit === 'intervalo' ? undefined : 'Em jornada · sem retorno');
  else if (psa == null || ag <= psa + t) out.saida = sit('jornada');
  else { out.saida = sit('pendente'); out.pendencias.push('Saída'); }
  // jornada (resumo e pendências)
  const en = out.entrada.sit, it = out.intervalo ? out.intervalo.sit : null, sd = out.saida ? out.saida.sit : null;
  if (en === 'atraso') out.jornada = sit('atraso');
  else if (en === 'sem') out.jornada = sit('sem');
  else if (en === 'aguardando') out.jornada = sit('aguardando');
  else if (en === 'apuracao') out.jornada = sit('apuracao', out.entrada.txt);
  else if (it === 'intervalo') out.jornada = sit('intervalo');
  else if (it === 'sem_retorno') out.jornada = sit('sem_retorno');
  else if (sd === 'encerrada') out.jornada = sit('encerrada');
  else if (sd === 'pendente') out.jornada = sit('pendente');
  else if (s === 'pendente' || s === 'incompleta') out.jornada = sit('apuracao');
  else out.jornada = sit('ok', 'Em jornada');
  return out;
}

// Linha enxuta pra TV: sem matrícula, CPF, telefone ou banco de horas — só nome, loja/setor/cargo, horários e situações.
function linhaTV(l, agora, tol) {
  const c = classificar(l, agora, tol); const pv = l.previsto && !l.previsto.folga ? l.previsto : null;
  return { id: l.id, nome: l.nome, loja: +l.loja, etq: ETQ(l.loja), setor: l.setor || '—', cargo: l.cargo || '',
           previsto: pv ? { entrada: pv.entrada, saidaInt: pv.saidaInt, retornoInt: pv.retornoInt, saida: pv.saida } : null,
           entrada: l.entrada || null, saidaInt: l.saidaInt || null, retornoInt: l.retornoInt || null, saida: l.saida || null,
           atrasoMin: l.atraso_min || 0, situacao: l.situacao, foraDoDia: c.foraDoDia || null,
           sitEntrada: c.entrada, sitIntervalo: c.intervalo, sitSaida: c.saida, sitJornada: c.jornada, pendencias: c.pendencias, divergencias: c.divergencias };
}
const porLoja = cfg => l => !cfg.lojas.length || cfg.lojas.includes(+l.loja);
const porSetor = cfg => l => !cfg.setores.length || cfg.setores.includes(semAcento(l.setor));

// Monta o conteúdo da TV a partir da jornada do dia (função pura, usada pelo payload e pelos testes).
function montar(jornada, cfg, agora, tol) {
  const todas = jornada.linhas.filter(porLoja(cfg)).filter(porSetor(cfg)).map(l => linhaTV(l, agora, tol));
  const fora = { folga: 0, ferias: 0, afastado: 0 };
  const linhas = [];
  for (const l of todas) { if (l.foraDoDia) fora[l.foraDoDia]++; else linhas.push(l); }
  const ordem = (a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR');
  const hm = x => x == null ? 9999 : x;
  const entradas = linhas.slice().sort((a, b) => hm(min(a.previsto && a.previsto.entrada)) - hm(min(b.previsto && b.previsto.entrada)) || ordem(a, b));
  const intervalos = linhas.filter(l => l.sitIntervalo).sort((a, b) => hm(min(a.previsto && a.previsto.saidaInt)) - hm(min(b.previsto && b.previsto.saidaInt)) || ordem(a, b));
  const saidas = linhas.filter(l => l.sitSaida).sort((a, b) => hm(min(a.previsto && a.previsto.saida)) - hm(min(b.previsto && b.previsto.saida)) || ordem(a, b));
  // resumo da rede e um por loja (27/10: Tiago, "cada slide tem que trazer por loja")
  const resumoDe = (ls, f) => { const n = k => ls.filter(l => l.sitJornada.sit === k).length; return {
    previstos: ls.length, chegaram: ls.filter(l => l.entrada).length, atrasos: n('atraso'),
    emIntervalo: ls.filter(l => l.sitIntervalo && (l.sitIntervalo.sit === 'intervalo' || l.sitIntervalo.sit === 'sem_retorno')).length,
    saidas: ls.filter(l => l.saida).length, pendentes: ls.filter(l => l.pendencias.length || l.sitEntrada.sit === 'sem').length,
    aguardando: n('aguardando'), apuracao: ls.filter(l => l.sitJornada.sit === 'apuracao').length, fora: f }; };
  const resumo = resumoDe(linhas, fora);
  const lojas = [...new Set(linhas.map(l => l.loja))].sort((a, b) => a - b);
  const resumoLojas = {};
  for (const lj of lojas) {
    const f = { folga: 0, ferias: 0, afastado: 0 }; for (const l of todas) if (l.foraDoDia && l.loja === lj) f[l.foraDoDia]++;
    resumoLojas[lj] = resumoDe(linhas.filter(l => l.loja === lj), f);
  }
  // pendências e divergências: uma lista única, por grupo, na ordem em que o RH precisa agir
  const pend = [];
  for (const l of linhas.slice().sort(ordem)) {
    const it = (g, txt) => pend.push({ g, nome: l.nome, loja: l.loja, etq: l.etq, setor: l.setor, txt });
    if (l.sitEntrada.sit === 'sem') it('sem', `Nenhuma marcação · previsto ${l.previsto ? l.previsto.entrada : '—'}`);
    if (l.sitEntrada.sit === 'atraso') it('atraso', `${l.atrasoMin} min · previsto ${l.previsto ? l.previsto.entrada : '—'}, entrou ${l.entrada}`);
    if (l.sitIntervalo && (l.sitIntervalo.sit === 'sem_retorno' || (l.sitIntervalo.sit === 'sem' && l.saidaInt && !l.retornoInt))) it('retorno', `Saiu ${l.saidaInt} · retorno previsto ${l.previsto ? l.previsto.retornoInt : '—'}`);
    if (l.sitSaida && l.sitSaida.sit === 'pendente') it('saida', `Previsto ${l.previsto ? l.previsto.saida : '—'} · sem marcação de saída`);
    for (const d of l.divergencias) if (!/^Atraso de /.test(d)) it('div', d);
  }
  const ORD = { sem: 0, atraso: 1, retorno: 2, saida: 3, div: 4 };
  pend.sort((a, b) => ORD[a.g] - ORD[b.g] || ordem(a, b));
  return { resumo, resumoLojas, entradas, intervalos, saidas, pendencias: pend, lojas };
}

// ── Dados: jornada do dia (cache curto, renovação em segundo plano) ───────────────────────────────────────
async function renovar() {
  if (renovando) return renovando;
  renovando = (async () => {
    const t0 = Date.now();
    try {
      const j = await deps.jornadaDia(hojeStr());
      cache = { em: Date.now(), ms: Date.now() - t0, dados: j, erro: null };
    } catch (e) {
      console.error('[TV-RH] jornada do dia:', e.message);
      if (cache) cache.erro = e.message; else cache = { em: 0, ms: Date.now() - t0, dados: null, erro: e.message };
    } finally { renovando = null; }
  })();
  return renovando;
}
async function jornadaHoje(forcar) {
  const ttl = deps.cacheMs !== undefined ? deps.cacheMs : CACHE_MS;
  if (forcar || !cache || !cache.dados) await renovar();
  else if (Date.now() - cache.em > ttl) renovar();   // devolve o que tem e renova por trás
  if (!cache || !cache.dados) throw new Error(cache && cache.erro ? cache.erro : 'Sem dados do PontoCerto ainda');
  return cache.dados;
}
const desatualizado = () => !cache || !cache.dados || Date.now() - cache.em > DESATUALIZADO_MS;
const tolerancia = () => { try { const t = deps.toleranciaMin ? deps.toleranciaMin() : null; return t == null ? TOL_PADRAO : +t; } catch (e) { return TOL_PADRAO; } };

// Resposta da API pública da TV (sem token nem quem alterou).
async function payloadTV() {
  const j = await jornadaHoje(false);
  const { token, atualizadoPor, ...cfg } = getConfig();
  const agora = agoraHM();
  const m = montar(j, config, agora, tolerancia());
  return { config: cfg, hoje: hojeStr(), agora, lojasNomes: LOJAS, lojasTxt: config.lojas.length ? config.lojas.map(ETQ).join(' · ') : 'Todas as lojas',
           ...m, dadosEm: cache ? new Date(cache.em).toISOString() : null, desatualizado: desatualizado(), erro: cache ? cache.erro || null : null, situacoes: SIT };
}
// Totais pra tela de configuração (não dispara leitura do PontoCerto se ainda não houve).
function totais() {
  if (!cache || !cache.dados) return cache ? { erro: cache.erro, previstos: 0 } : null;
  const m = montar(cache.dados, config, agoraHM(), tolerancia());
  return { ...m.resumo, lojas: m.lojas, telas: { entradas: m.entradas.length, intervalos: m.intervalos.length, saidas: m.saidas.length, pendencias: m.pendencias.length },
           geradoEm: new Date(cache.em).toISOString(), ms: cache.ms, erro: cache.erro || null, desatualizado: desatualizado() };
}
// Setores existentes no cadastro (pra tela de configuração escolher), por loja.
async function setoresDisponiveis() {
  const col = await deps.colaboradores();
  const m = new Map();
  for (const c of col.ativos || []) { const s = semAcento(c.setor); if (!s || s === '—') continue; if (!m.has(s)) m.set(s, new Set()); m.get(s).add(+c.loja); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([setor, lojas]) => ({ setor, lojas: [...lojas].sort((a, b) => a - b) }));
}

module.exports = { init, getConfig, salvarConfig, novoToken, tokenValido, payloadTV, totais, setoresDisponiveis, jornadaHoje, LOJAS, TELAS, SIT,
                   classificar, montar, linhaTV, _normalizar: normalizar };
