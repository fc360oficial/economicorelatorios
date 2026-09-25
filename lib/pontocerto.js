'use strict';
// PontoCerto (API Pontomais) — integração do sistema de ponto com o DP / RH (25/09/2026, Tiago).
// Documentação: https://documenter.getpostman.com/view/4785048/RWMCvVxN ("API de integração" Pontomais).
// Config em data/pontocerto.json (gitignored, só no servidor): { url, token, auth: 'bearer'|'header'|'query', header, empresa }.
// Padrão Pontomais: url https://api.pontomais.com.br/external_api/v1 e token no cabeçalho "access-token".
// O token NUNCA volta inteiro pra tela (só os 6 primeiros e 4 últimos caracteres).
//
// Descobertas (25/09/2026, com o token real): 7 unidades de negócio = CAHU COMERCIO (E1), MURIBECA (E2), PONTE DOS
// CARVALHOS (E3), Y.G.M PRESTADORA (E4 Atacarejo), PORTA LARGA (E5), PQO PRESTACAO (E6 Jardim Jordão) e CAHU
// DISTRIBUIDORA (CD); ~65 equipes no formato SETOR/LOJA (CAIXA/PONTE, REPOSITOR/JARDIMJORDÃO...); 285 colaboradores.
// Relatórios: POST /reports/<nome> com { report: { start_date, end_date, group_by, columns, format:'json' } } →
// { heading, data: [ { 0: {header, data:[linhas], footer, totals}, 1: {...} } ] } (um bloco por equipe, sem nome).
// As linhas trazem todos os campos do relatório, independente de `columns` (que só muda o cabeçalho).
const fs = require('fs');
const path = require('path');
const ARQ = path.join(__dirname, '..', 'data', 'pontocerto.json');
const URL_PADRAO = 'https://api.pontomais.com.br/external_api/v1';
const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { return {}; } };
const mascara = t => t ? (t.length > 14 ? t.slice(0, 6) + '…' + t.slice(-4) : '••••') : '';
function getConfig() {
  const c = ler();
  return { url: c.url || URL_PADRAO, auth: c.auth || 'header', header: c.header || 'access-token', empresa: c.empresa || '',
    token_mascarado: mascara(c.token || ''), tem_token: !!c.token, atualizadoEm: c.atualizadoEm || null, ultimo_teste: c.ultimo_teste || null };
}
function setConfig(campos, usuario) {
  const c = ler();
  if (typeof campos.url === 'string') c.url = campos.url.trim().replace(/\/+$/, '') || URL_PADRAO;
  if (typeof campos.token === 'string' && campos.token.trim()) c.token = campos.token.trim();
  if (['bearer', 'header', 'query'].includes(campos.auth)) c.auth = campos.auth;
  if (typeof campos.header === 'string' && campos.header.trim()) c.header = campos.header.trim();
  if (typeof campos.empresa === 'string') c.empresa = campos.empresa.trim();
  c.atualizadoEm = new Date().toISOString(); c.atualizadoPor = usuario || null;
  fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(c, null, 2));
  cache.clear();
  return getConfig();
}
function montar(caminho, corpo) {
  const c = ler(); if (!c.token) throw new Error('Token do PontoCerto não configurado (tela Departamento Pessoal → Integração).');
  let alvo = (c.url || URL_PADRAO) + (caminho.startsWith('/') ? caminho : '/' + caminho);
  const headers = { 'Accept': 'application/json' };
  if (corpo) headers['Content-Type'] = 'application/json';
  const auth = c.auth || 'header';
  if (auth === 'bearer') headers['Authorization'] = 'Bearer ' + c.token;
  else if (auth === 'header') headers[c.header || 'access-token'] = c.token;
  else alvo += (alvo.includes('?') ? '&' : '?') + (c.header || 'token') + '=' + encodeURIComponent(c.token);
  if (c.empresa) headers['X-Empresa'] = c.empresa;
  return { alvo, headers, token: c.token };
}
async function chamar(caminho, metodo, corpo, timeoutMs) {
  const { alvo, headers } = montar(caminho, corpo);
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeoutMs || 120000);
  try {
    const r = await fetch(alvo, { method: metodo || 'GET', headers, body: corpo ? JSON.stringify(corpo) : undefined, signal: ctl.signal });
    const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch (e) {}
    if (!r.ok) throw new Error('PontoCerto HTTP ' + r.status + ' em ' + caminho + ': ' + texto.slice(0, 200));
    return json;
  } catch (e) { if (e.name === 'AbortError') throw new Error('PontoCerto sem resposta em ' + Math.round((timeoutMs || 120000) / 1000) + ' s (' + caminho + ')'); throw e; }
  finally { clearTimeout(tm); }
}
// Chamada de teste pela tela (admin): GET/POST livre, devolve status, tipo e o começo do corpo
async function testar(caminho, metodo) {
  const c = ler(); if (!c.token) return { erro: 'Configure o token primeiro.' };
  let m; try { m = montar(caminho || '/business_units?per_page=5'); } catch (e) { return { erro: e.message }; }
  const t0 = Date.now();
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 30000);
    const r = await fetch(m.alvo, { method: metodo || 'GET', headers: m.headers, signal: ctl.signal }); clearTimeout(tm);
    const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch (e) {}
    const lista = json && typeof json === 'object' && !Array.isArray(json) ? Object.values(json).find(v => Array.isArray(v)) : (Array.isArray(json) ? json : null);
    const res = { ok: r.ok, status: r.status, tipo: r.headers.get('content-type') || '', ms: Date.now() - t0, url: m.alvo.replace(m.token, '***'), corpo: texto.slice(0, 6000),
      json_chaves: json && typeof json === 'object' ? Object.keys(Array.isArray(json) ? (json[0] || {}) : json).slice(0, 40) : null, itens: lista ? lista.length : null };
    const cfg = ler(); cfg.ultimo_teste = { em: new Date().toISOString(), caminho, status: r.status, ok: r.ok }; fs.writeFileSync(ARQ, JSON.stringify(cfg, null, 2));
    return res;
  } catch (e) { return { erro: e.name === 'AbortError' ? 'Sem resposta em 30 s' : e.message, url: m.alvo.replace(m.token, '***'), ms: Date.now() - t0 }; }
}

// ── relatórios ──────────────────────────────────────────────
const cache = new Map();   // chave → { em, dados }
const CACHE_MS = 20 * 60 * 1000;
const emAndamento = new Map(); // chave → Promise (evita disparar o mesmo relatório 2x)
async function relatorio(nome, report) {
  const k = nome + '|' + JSON.stringify(report); const c = cache.get(k);
  if (c && Date.now() - c.em < CACHE_MS) return c.dados;
  if (emAndamento.has(k)) return emAndamento.get(k);
  const p = (async () => {
    const j = await chamar('/reports/' + nome, 'POST', { report: { group_by: 'team', row_filters: '', format: 'json', ...report } }, 180000);
    const grupos = j && j.data && j.data[0] ? Object.values(j.data[0]) : [];
    const linhas = []; for (const g of grupos) for (const r of (g.data || [])) linhas.push(r);
    const dados = { linhas, heading: j && j.heading || null, totais: grupos.map(g => g.totals).filter(Boolean), rodapes: grupos.map(g => g.footer).filter(Boolean) };
    cache.set(k, { em: Date.now(), dados }); if (cache.size > 80) cache.delete(cache.keys().next().value);
    return dados;
  })();
  emAndamento.set(k, p);
  try { return await p; } finally { emAndamento.delete(k); }
}
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO', 10: 'CD · DISTRIBUIDORA', 0: 'SEM LOJA' };
const ETQ = n => +n === 10 ? 'CD' : +n === 0 ? '—' : 'E' + n;
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
// Loja pelo sufixo da equipe (CAIXA/PONTE, REPOSITOR/JARDIMJORDÃO...); senão pela unidade de negócio
function lojaDe(equipe, unidade) {
  const e = semAcento(equipe).replace(/\s+/g, ''), u = semAcento(unidade);
  const suf = e.includes('/') ? e.slice(e.lastIndexOf('/') + 1) : '';
  if (suf) {
    if (suf === 'CAHU') return 1; if (/^MURIBECA/.test(suf)) return 2; if (/^PONTE/.test(suf)) return 3; if (/^ATACARE/.test(suf)) return 4;
    if (/^PORTALARGA/.test(suf)) return 5; if (/^JARDIMJORD/.test(suf)) return 6; if (suf === 'CD') return 10;
  }
  if (/^MURIBECA/.test(e)) return 2; if (/CENTRODEDISTRIBUI/.test(e)) return 10;
  const u2 = u.replace(/\s+/g, '');
  if (/CAHUCOMERCIO/.test(u2)) return 1; if (/MURIBECA/.test(u2)) return 2; if (/PONTE/.test(u2)) return 3; if (/Y\.?G\.?M/.test(u2)) return 4;
  if (/PORTALARGA/.test(u2)) return 5; if (/PQO/.test(u2)) return 6; if (/DISTRIBUIDORA/.test(u2)) return 10;
  return 0;
}
const setorDe = equipe => { const t = String(equipe || '').trim(); const s = t.includes('/') ? t.slice(0, t.indexOf('/')) : t; return semAcento(s).replace(/\s+GERAL$/, '').trim() || '—'; };
const minutos = s => { const m = String(s || '').match(/^(-?)(\d+):(\d{2})/); if (!m) return 0; const v = (+m[2]) * 60 + (+m[3]); return m[1] ? -v : v; };
const hhmm = min => { const s = min < 0 ? '-' : '', a = Math.abs(Math.round(min)); return s + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0'); };
const dataISO = s => { const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const COLS = {
  employees: 'id,business_unit,name,registration_number,job_title,team,shift,is_clt,admission_date,resignation_date',
  missing_days: 'name,registration_number,job_title,team,shift,date,missing_type,missing_motive',
  delays: 'employee_name,team_name,date,shift,time_card_done',
  extra_times: 'employee_name,registration_number,team_name,date,regular_time,extra_time,motive',
  absences: 'employee_name,team_name,start_date,end_date,observation,absence_type,total_days',
  period_summaries: 'employee_name,registration_number,shift_time,summary,extra_time,total_time'
};

// Resumo do DP no período: quadro, faltas, atrasos, horas extras, horas faltantes e afastados — por loja (E1..E6, CD)
async function resumo({ de, ate }) {
  const k = 'resumo|' + de + '|' + ate; const c = cache.get(k); if (c && Date.now() - c.em < CACHE_MS) return c.dados;
  const t0 = Date.now();
  const [emp, faltas, atrasos, extras, afast, jornada] = await Promise.all([
    relatorio('employees', { group_by: '', columns: COLS.employees }),
    relatorio('missing_days', { start_date: de, end_date: ate, columns: COLS.missing_days }),
    relatorio('delays', { start_date: de, end_date: ate, columns: COLS.delays }),
    relatorio('extra_times', { start_date: de, end_date: ate, columns: COLS.extra_times }),
    relatorio('absences', { start_date: de, end_date: ate, columns: COLS.absences }),
    relatorio('period_summaries', { start_date: de, end_date: ate, columns: COLS.period_summaries })
  ]);
  const lojas = {};
  const L = ln => lojas[ln] || (lojas[ln] = { loja: +ln, etq: ETQ(ln), nome: LOJAS_NOMES[ln] || ('Loja ' + ln), colaboradores: 0, clt: 0, admissoes_periodo: 0, setores: {},
    faltas: 0, faltas_abonadas: 0, faltas_pessoas: new Set(), atrasos: 0, atraso_min: 0, atrasos_pessoas: new Set(), extras_min: 0, extras_pessoas: new Set(),
    previstas_min: 0, faltantes_min: 0, trabalhadas_min: 0, afastados: 0, ferias: 0 });
  const equipeLoja = {}, nomeLoja = {}, nomeInfo = {};
  const colaboradores = [];
  for (const e of emp.linhas) {
    const ln = lojaDe(e.team, e.business_unit); const eq = String(e.team || '').trim(); const nm = semAcento(e.name).trim();
    equipeLoja[eq] = ln; nomeLoja[nm] = ln; nomeInfo[nm] = { setor: setorDe(e.team), cargo: e.job_title || '' };
    if (e.resignation_date) continue;
    const l = L(ln); l.colaboradores++; if (/^s/i.test(String(e.is_clt || ''))) l.clt++;
    const setor = setorDe(e.team); l.setores[setor] = (l.setores[setor] || 0) + 1;
    const adm = dataISO(e.admission_date); if (adm && adm >= de && adm <= ate) l.admissoes_periodo++;
    colaboradores.push({ loja: ln, nome: e.name, setor, cargo: e.job_title || '', equipe: eq, turno: e.shift || '', clt: /^s/i.test(String(e.is_clt || '')), admissao: adm });
  }
  const lojaEq = (eq, nome) => { const t = String(eq || '').trim(); if (t && equipeLoja[t] != null) return equipeLoja[t]; const n = semAcento(nome).trim(); if (nomeLoja[n] != null) return nomeLoja[n]; return lojaDe(t, ''); };
  const info = nome => nomeInfo[semAcento(nome).trim()] || { setor: '—', cargo: '' };
  const listas = { faltas: [], atrasos: [], extras: [], afastados: [] };
  for (const r of faltas.linhas) {
    const ln = lojaEq(r.team, r.name); const l = L(ln); const abonada = /^s/i.test(String(r.missing_type || ''));
    l.faltas++; if (abonada) l.faltas_abonadas++; l.faltas_pessoas.add(semAcento(r.name));
    listas.faltas.push({ loja: ln, nome: r.name, setor: setorDe(r.team), cargo: r.job_title || '', turno: r.shift || '', data: dataISO(r.date), abonada, motivo: r.missing_motive || '' });
  }
  for (const r of atrasos.linhas) {
    const ln = lojaEq(r.team_name, r.employee_name); const l = L(ln); l.atrasos++; l.atraso_min += minutos(r.delay_time); l.atrasos_pessoas.add(semAcento(r.employee_name));
    listas.atrasos.push({ loja: ln, nome: r.employee_name, setor: setorDe(r.team_name), cargo: info(r.employee_name).cargo, turno: r.shift || '', data: dataISO(r.date), previsto: r.time_card_expected || '', batido: r.time_card_done || '', atraso: r.delay_time || '' });
  }
  for (const r of extras.linhas) {
    const m = minutos(r.extra_time); if (m <= 0) continue;
    const ln = lojaEq(r.team_name, r.employee_name); const l = L(ln); l.extras_min += m; l.extras_pessoas.add(semAcento(r.employee_name));
    listas.extras.push({ loja: ln, nome: r.employee_name, setor: setorDe(r.team_name), cargo: info(r.employee_name).cargo, data: dataISO(r.date), normais: r.regular_time || '', extras: r.extra_time || '', motivo: r.motive || '' });
  }
  const hj = hojeISO();
  for (const r of afast.linhas) {
    const ln = lojaEq(r.team_name, r.employee_name); const l = L(ln); const ini = dataISO(r.start_date), fim = dataISO(r.end_date);
    const ativo = !!(ini && fim && ini <= hj && fim >= hj); const ferias = /f[eé]rias/i.test(String(r.absence_type || ''));
    if (ativo) { l.afastados++; if (ferias) l.ferias++; }
    listas.afastados.push({ loja: ln, nome: r.employee_name, setor: setorDe(r.team_name), cargo: info(r.employee_name).cargo, inicio: ini, fim, dias: r.total_days, tipo: r.absence_type || '', obs: r.observation || '', ativo, ferias });
  }
  for (const r of jornada.linhas) {
    if (/^TOTA/i.test(String(r.registration_number || '')) && !r.employee_name) continue;
    const ln = lojaEq(r.team_name || r.team, r.employee_name); const l = L(ln); const s = Array.isArray(r.summary) ? r.summary : [];
    l.previstas_min += minutos(r.shift_time); l.faltantes_min += minutos(s[1]); l.trabalhadas_min += minutos(r.total_time);
  }
  const ordem = [1, 2, 3, 4, 5, 6, 10, 0];
  const fecha = l => ({ ...l, faltas_pessoas: l.faltas_pessoas.size, atrasos_pessoas: l.atrasos_pessoas.size, extras_pessoas: l.extras_pessoas.size,
    extras: hhmm(l.extras_min), atraso: hhmm(l.atraso_min), faltantes: hhmm(l.faltantes_min), previstas: hhmm(l.previstas_min), trabalhadas: hhmm(l.trabalhadas_min),
    faltantes_pct: l.previstas_min > 0 ? +(l.faltantes_min / l.previstas_min * 100).toFixed(1) : null,
    setores: Object.entries(l.setores).sort((a, b) => b[1] - a[1]).map(([setor, n]) => ({ setor, n })) });
  const porLoja = ordem.filter(ln => lojas[ln] && (lojas[ln].colaboradores || ln !== 0)).map(ln => fecha(lojas[ln]));
  const CAMPOS = ['colaboradores', 'clt', 'admissoes_periodo', 'faltas', 'faltas_abonadas', 'faltas_pessoas', 'atrasos', 'atraso_min', 'atrasos_pessoas', 'extras_min', 'extras_pessoas', 'previstas_min', 'faltantes_min', 'trabalhadas_min', 'afastados', 'ferias'];
  const soma = {}; for (const c of CAMPOS) soma[c] = porLoja.reduce((s, l) => s + (l[c] || 0), 0);
  const tot = { ...soma, extras: hhmm(soma.extras_min), atraso: hhmm(soma.atraso_min), faltantes: hhmm(soma.faltantes_min), previstas: hhmm(soma.previstas_min), trabalhadas: hhmm(soma.trabalhadas_min),
    faltantes_pct: soma.previstas_min > 0 ? +(soma.faltantes_min / soma.previstas_min * 100).toFixed(1) : null };
  const porNome = (a, b) => String(a.nome).localeCompare(String(b.nome));
  const dados = { de, ate, hoje: hj, gerado_em: new Date().toISOString(), ms: Date.now() - t0, lojas: porLoja, total: tot,
    listas: {
      colaboradores: colaboradores.sort((a, b) => a.loja - b.loja || a.setor.localeCompare(b.setor) || porNome(a, b)),
      faltas: listas.faltas.sort((a, b) => (b.data || '').localeCompare(a.data || '') || porNome(a, b)),
      atrasos: listas.atrasos.sort((a, b) => (b.data || '').localeCompare(a.data || '') || minutos(b.atraso) - minutos(a.atraso)),
      extras: listas.extras.sort((a, b) => minutos(b.extras) - minutos(a.extras)),
      afastados: listas.afastados.sort((a, b) => (b.ativo - a.ativo) || (a.fim || '').localeCompare(b.fim || '') || porNome(a, b))
    },
    fonte: { colaboradores: emp.linhas.length, faltas: faltas.linhas.length, atrasos: atrasos.linhas.length, extras: extras.linhas.length, afastamentos: afast.linhas.length, jornada: jornada.linhas.length, heading: jornada.heading } };
  cache.set(k, { em: Date.now(), dados });
  return dados;
}
const limparCache = () => { cache.clear(); };
module.exports = { getConfig, setConfig, testar, relatorio, resumo, limparCache, lojaDe, setorDe, LOJAS_NOMES, ETQ, URL_PADRAO };
