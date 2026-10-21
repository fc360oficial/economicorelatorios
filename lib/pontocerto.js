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
async function relatorio(nome, report, cacheMs) {
  const k = nome + '|' + JSON.stringify(report); const c = cache.get(k);
  if (c && Date.now() - c.em < (cacheMs || CACHE_MS)) return c.dados;
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
// ── cadastro (GET /employees, paginado) ─────────────────────
// 13/10/2026: o GET /employees traz o que o relatório não traz — data de nascimento, status ao vivo (work_status),
// banco de horas (time_balance, em SEGUNDOS), departamento, líder, e-mail/telefone — e os desligados (active=false)
// com resignation_date (base do turnover). CPF nunca sai inteiro daqui (só os 4 últimos dígitos).
async function listar(caminho) {
  const out = []; const sep = caminho.includes('?') ? '&' : '?';
  for (let pg = 1; pg <= 20; pg++) {
    const j = await chamar(caminho + sep + 'per_page=100&page=' + pg, 'GET', null, 60000);
    const arr = j && typeof j === 'object' ? Object.values(j).find(Array.isArray) : null;
    if (!arr || !arr.length) break;
    out.push(...arr); if (arr.length < 100) break;
  }
  return out;
}
const nomeDe = o => (o && typeof o === 'object') ? (o.name || '') : (o || '');
const cpfFim = s => { const d = String(s || '').replace(/\D/g, ''); return d.length === 11 ? '***.***.' + d.slice(6, 9) + '-' + d.slice(9) : ''; };
function normalizarColab(e, ativo) {
  const equipe = nomeDe(e.team), unidade = nomeDe(e.business_unit);
  const ln = lojaDe(equipe, unidade);
  return { id: e.id, nome: e.name || '', matricula: e.registration_number || '', cpf_fim: cpfFim(e.cpf), loja: ln, etq: ETQ(ln), loja_nome: LOJAS_NOMES[ln] || '',
    setor: setorDe(equipe), departamento: nomeDe(e.department), cargo: nomeDe(e.job_title), equipe, turno: nomeDe(e.shift), turno_id: (e.shift && e.shift.id) || null, turno_flexivel: !!(e.shift && e.shift.flexible), clt: !!e.is_clt,
    admissao: dataISO(e.admission_date), inicio_ponto: dataISO(e.initial_date), criado_no_ponto: e.created_at ? new Date(e.created_at * 1000).toISOString().slice(0, 10) : null, desligamento: dataISO(e.resignation_date), nascimento: dataISO(e.birthdate),
    email: e.email || '', telefone: e.main_phone_number || e.whats_app_number || '', lider: !!e.is_team_leader, nivel: nomeDe(e.hierarchy_level),
    status_agora: ativo ? nomeDe(e.work_status) : 'Desligado', banco_horas_min: Math.round((+e.time_balance || 0) / 60), ativo: !!ativo };
}
async function colaboradores(force) {
  const k = 'colaboradores'; const c = cache.get(k); if (!force && c && Date.now() - c.em < CACHE_MS) return c.dados;
  if (emAndamento.has(k)) return emAndamento.get(k);   // duas telas abrindo juntas = uma busca só (leva ~40 s)
  const p = (async () => {
    const [at, de] = await Promise.all([listar('/employees?active=true'), listar('/employees?active=false')]);
    const dados = { ativos: at.map(e => normalizarColab(e, true)).sort((a, b) => a.loja - b.loja || a.setor.localeCompare(b.setor) || a.nome.localeCompare(b.nome)),
      desligados: de.map(e => normalizarColab(e, false)).sort((a, b) => (b.desligamento || '').localeCompare(a.desligamento || '')), gerado_em: new Date().toISOString() };
    cache.set(k, { em: Date.now(), dados }); return dados;
  })();
  emAndamento.set(k, p);
  try { return await p; } finally { emAndamento.delete(k); }
}
// Afastamentos (relatório) num período longo — usado pra saber quem já gozou férias de cada período aquisitivo
// O Pontomais limita o relatório a 190 dias — fatia em janelas de 180 e junta (sem duplicar o mesmo afastamento).
async function afastamentosLongos(de, ate) {
  const fatias = []; let ini = de;
  while (ini <= ate) { const d = new Date(ini + 'T12:00:00'); d.setDate(d.getDate() + 179); let fim = d.toISOString().slice(0, 10); if (fim > ate) fim = ate; fatias.push([ini, fim]); const n = new Date(fim + 'T12:00:00'); n.setDate(n.getDate() + 1); ini = n.toISOString().slice(0, 10); }
  const partes = await Promise.all(fatias.map(([a, b]) => relatorio('absences', { start_date: a, end_date: b, columns: COLS.absences })));
  const vistos = new Set(), out = [];
  for (const p of partes) for (const x of p.linhas) {
    const k = semAcento(x.employee_name) + '|' + x.start_date + '|' + x.end_date; if (vistos.has(k)) continue; vistos.add(k);
    out.push({ nome: x.employee_name, equipe: x.team_name, inicio: dataISO(x.start_date), fim: dataISO(x.end_date), dias: +x.total_days || 0, tipo: x.absence_type || '', obs: x.observation || '', ferias: /f[eé]rias/i.test(String(x.absence_type || '')) });
  }
  return out;
}
// ── Jornada diária (21/10/2026, aba TESTE TIAGO) ─────────────────────────────
// Descobertas de 21/10 com o token real:
//  · /shifts (159 escalas, 2 páginas): dias[].week_day.id (1=dom..7=sáb) com periods[{enter_time, leave_time}]; só week_index 0
//    (nenhuma escala em ciclo de várias semanas). O cadastro aponta pra escala por employee.shift.id.
//  · POST /reports/work_days: UMA linha por funcionário e dia — employee_id, time_cards[] (marcações originais),
//    shift_time (carga prevista; "00:00" = folga), summary = [intervalo, horas faltantes, horas normais(, ...)],
//    extra_time[] (H.E. 1/2) e time_balance = saldo OFICIAL ACUMULADO do banco até aquele dia (conferido: 252:55 → 252:59
//    com H.E. 02:46 e faltante 02:42). Hoje só vem quem já tem marcação/apuração; os demais entram pelo cadastro.
//  · POST /reports/delays: time_card_expected × time_card_done × delay_time por dia (atraso confirmado pela apuração).
// Tudo leitura; nada é calculado em paralelo à apuração oficial — crédito e débito do dia são os da apuração.
const COLS_WD = 'employee_id,employee_name,registration_number,team_name,date,shift_time,time_cards,summary,time_balance,extra_time';
const hm5 = t => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, '0') + ':' + m[2] : null; };
let escalasMem = null;
/** Map id → { id, nome, dias: { 0..6: periods[] } } — cache de 24 h */
async function escalas(force) {
  if (!force && escalasMem && Date.now() - escalasMem.em < 24 * 3600000) return escalasMem.map;
  const lista = await listar('/shifts');
  const map = new Map();
  for (const s of lista) {
    const dias = {};
    for (const d of s.days || []) { if (d.week_index && d.week_index !== 0) continue; const dow = (d.week_day && d.week_day.id ? d.week_day.id : 1) - 1; dias[dow] = (d.periods || []).map(p => ({ entrada: hm5(p.enter_time), saida: hm5(p.leave_time) })); }
    map.set(s.id, { id: s.id, nome: s.code_name || s.name || '', dias, ciclo: Math.max(0, ...(s.days || []).map(d => d.week_index || 0)) + 1 });
  }
  escalasMem = { em: Date.now(), map }; return map;
}
/** Escala prevista do dia: { folga, entrada, saidaInt, retornoInt, saida, periodos } ou null se a escala é desconhecida */
function previstoDe(escala, dataISO) {
  if (!escala) return null;
  const dow = new Date(dataISO + 'T12:00:00').getDay(); const ps = (escala.dias && escala.dias[dow]) || [];
  if (!ps.length) return { folga: true, entrada: null, saidaInt: null, retornoInt: null, saida: null, periodos: 0 };
  return { folga: false, entrada: ps[0].entrada, saidaInt: ps.length > 1 ? ps[0].saida : null, retornoInt: ps.length > 1 ? ps[1].entrada : null, saida: ps[ps.length - 1].saida, periodos: ps.length };
}
const SITUACAO_JORNADA = { ok: 'No horário', atraso: 'Atraso confirmado', sem_marcacao: 'Sem marcação', em_andamento: 'Em andamento', intervalo: 'Em intervalo', aguardando: 'Aguardando entrada',
  incompleta: 'Marcação incompleta', pendente: 'Apuração pendente', folga: 'Folga', folga_trabalhada: 'Trabalho em folga', ferias: 'Férias', afastado: 'Afastado', sem_escala: 'Escala não informada' };
/**
 * Classifica a jornada de um dia. Jornada incompleta NUNCA vira falta/débito aqui: vira "sem marcação", "incompleta"
 * ou "apuração pendente" para alguém analisar. Atraso só quando a apuração do PontoCerto (relatório delays) confirma.
 */
function classificarJornada({ data, hoje, agoraHM, previsto, marcacoes, atrasoMin, toleranciaMin, statusAgora, shiftTime, apurado, afastamento }) {
  const n = (marcacoes || []).length; const eHoje = data === hoje; const st = String(statusAgora || '');
  if (afastamento === 'ferias' || (eHoje && /f[eé]rias/i.test(st))) return 'ferias';
  if (afastamento === 'afastado' || (eHoje && /afast|licen|atestad|inss|auxilio|aux[ií]lio|maternidade/i.test(st))) return 'afastado';
  const folga = previsto ? previsto.folga : (shiftTime === '00:00');
  if (!previsto && shiftTime == null && !n) return eHoje ? 'sem_escala' : (apurado ? 'sem_escala' : 'pendente');
  if (folga) return n ? 'folga_trabalhada' : 'folga';
  if (n === 0) { if (eHoje && previsto && previsto.entrada && agoraHM < previsto.entrada) return 'aguardando'; if (eHoje && /folga/i.test(st)) return 'folga'; return 'sem_marcacao'; }
  if (atrasoMin > (toleranciaMin == null ? 10 : toleranciaMin)) return 'atraso';
  if (n % 2 === 1) return eHoje ? (/intervalo/i.test(st) ? 'intervalo' : 'em_andamento') : 'incompleta';
  if (eHoje) { if (/intervalo/i.test(st)) return 'intervalo'; const esperadas = previsto ? previsto.periodos * 2 : 4; if (n < esperadas && !/encerrad/i.test(st)) return 'intervalo'; if (/jornada|atrasad/i.test(st) && !(previsto && previsto.saida && agoraHM >= previsto.saida)) return 'em_andamento'; }
  return 'ok';
}
/** Distribui as marcações nas colunas entrada · saída intervalo · retorno · saída, conforme a escala ter intervalo ou não */
function colunasMarcacoes(marcacoes, previsto) {
  const m = marcacoes || []; const comIntervalo = previsto ? previsto.periodos > 1 : m.length >= 3;
  if (!m.length) return { entrada: null, saidaInt: null, retornoInt: null, saida: null };
  if (!comIntervalo) return { entrada: m[0], saidaInt: null, retornoInt: null, saida: m.length >= 2 ? m[m.length - 1] : null };
  return { entrada: m[0], saidaInt: m[1] || null, retornoInt: m[2] || null, saida: m.length >= 4 ? m[m.length - 1] : null };
}
function normalizarWorkDay(r) {
  const s = Array.isArray(r.summary) ? r.summary : []; const ex = Array.isArray(r.extra_time) ? r.extra_time : [];
  const extraMin = ex.reduce((t, x) => t + (x && typeof x.raw_value === 'number' ? Math.round(x.raw_value / 60) : minutos(x && x.value)), 0);
  return { employee_id: r.employee_id, nome: r.employee_name, matricula: r.registration_number || '', equipe: r.team_name || '', data: dataISO(r.date),
    shift_time: r.shift_time == null ? null : (hm5(r.shift_time) || '00:00'), marcacoes: (r.time_cards || []).map(t => hm5(t && (t.value || t.csv_value))).filter(Boolean),
    intervalo: s[0] || null, faltantes: s[1] || null, normais: s[2] || null, extras: hhmm(extraMin), extras_min: extraMin, faltantes_min: minutos(s[1]), saldo_acum_min: minutos(r.time_balance), saldo_acum: r.time_balance || null };
}
async function workDays(de, ate) {
  const hj = hojeISO(); const r = await relatorio('work_days', { start_date: de, end_date: ate, columns: COLS_WD }, ate >= hj ? 5 * 60 * 1000 : undefined);
  return r.linhas.filter(x => x.employee_id).map(normalizarWorkDay);
}
async function atrasos(de, ate) {
  const hj = hojeISO(); const r = await relatorio('delays', { start_date: de, end_date: ate, columns: COLS.delays }, ate >= hj ? 5 * 60 * 1000 : undefined);
  return r.linhas.map(x => ({ nome: x.employee_name, data: dataISO(x.date), previsto: hm5(x.time_card_expected), batido: hm5(x.time_card_done), atraso_min: minutos(x.delay_time) }));
}
/** Marcações brutas (relatório time_cards): Map "NOME|data" → ['06:14', ...]. É a fonte das colunas de marcação; hoje a
 *  apuração (work_days) ainda não tem a maioria das pessoas, mas as marcações já estão aqui. */
async function marcacoes(de, ate) {
  const hj = hojeISO(); const r = await relatorio('time_cards', { start_date: de, end_date: ate, columns: 'employee_name,date,time,team_name' }, ate >= hj ? 5 * 60 * 1000 : undefined);
  const m = new Map();
  for (const x of r.linhas) { const t = hm5(x.time); const d = dataISO(x.date); if (!t || !d) continue; const k = semAcento(x.employee_name).trim() + '|' + d; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  for (const v of m.values()) v.sort();
  return m;
}
/** Afastamentos/férias que tocam o período (relatório absences), por nome */
async function afastamentos(de, ate) {
  const r = await relatorio('absences', { start_date: de, end_date: ate, columns: COLS.absences });
  return r.linhas.map(x => ({ nome: semAcento(x.employee_name).trim(), inicio: dataISO(x.start_date), fim: dataISO(x.end_date), tipo: x.absence_type || '', ferias: /f[eé]rias/i.test(String(x.absence_type || '')) })).filter(x => x.inicio && x.fim);
}
const afastamentoEm = (lista, nome, data) => { const a = lista.find(x => x.nome === nome && x.inicio <= data && x.fim >= data); return a ? (a.ferias ? 'ferias' : 'afastado') : null; };
const agoraHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
function montarLinha(c, w, a, escala, data, hoje, tol, marcs, afast) {
  const previsto = previstoDe(escala, data); const marcacoes = (marcs && marcs.length) ? marcs : (w ? w.marcacoes : []);
  const situacao = classificarJornada({ data, hoje, agoraHM: agoraHM(), previsto, marcacoes, atrasoMin: a ? a.atraso_min : 0, toleranciaMin: tol, statusAgora: data === hoje ? c.status_agora : '', shiftTime: w ? w.shift_time : (previsto ? null : undefined), apurado: !!w, afastamento: afast || null });
  return { id: c.id, nome: c.nome, matricula: c.matricula || (w && w.matricula) || '', loja: c.loja, etq: c.etq, setor: c.setor, cargo: c.cargo, turno: c.turno, turno_flexivel: !!c.turno_flexivel, data,
    previsto, escala_nome: escala ? escala.nome : (c.turno || null), ...colunasMarcacoes(marcacoes, previsto), marcacoes, situacao, situacaoTxt: SITUACAO_JORNADA[situacao],
    atraso_min: a ? a.atraso_min : 0, previsto_entrada_apuracao: a ? a.previsto : null, status_agora: data === hoje ? c.status_agora : null,
    apuracao: w ? { intervalo: w.intervalo, faltantes: w.faltantes, faltantes_min: w.faltantes_min, normais: w.normais, extras: w.extras, extras_min: w.extras_min, saldo_acum: w.saldo_acum, saldo_acum_min: w.saldo_acum_min, carga: w.shift_time } : null,
    banco_oficial_min: w ? w.saldo_acum_min : (data === hoje ? c.banco_horas_min : null) };
}
/** Jornada de TODOS os ativos num dia: cadastro + escala + work_days + delays. toleranciaMin = tolerância de atraso. */
async function jornadaDia(data, opts = {}) {
  const hoje = hojeISO(); if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || data > hoje) throw new Error('Data inválida ou futura');
  const t0 = Date.now();
  const [col, esc, wd, dl, mc, af] = await Promise.all([colaboradores(), escalas(), workDays(data, data), atrasos(data, data), marcacoes(data, data), afastamentos(data, data)]);
  const porId = new Map(wd.map(r => [r.employee_id, r])); const atrasoPorNome = new Map(dl.map(r => [semAcento(r.nome).trim(), r]));
  const linhas = [];
  for (const c of col.ativos) {
    if (c.admissao && c.admissao > data) continue;
    const nm = semAcento(c.nome).trim();
    linhas.push(montarLinha(c, porId.get(c.id), atrasoPorNome.get(nm), esc.get(c.turno_id), data, hoje, opts.toleranciaMin, mc.get(nm + '|' + data), afastamentoEm(af, nm, data)));
  }
  return { data, hoje, gerado_em: new Date().toISOString(), ms: Date.now() - t0, cadastro_em: col.gerado_em, linhas, fonte: { work_days: wd.length, delays: dl.length, marcacoes: mc.size, afastamentos: af.length, escalas: esc.size, ativos: col.ativos.length } };
}
/** Jornada de UM funcionário num período (máx. 92 dias): uma linha por dia, inclusive dias sem apuração. */
async function jornadaPeriodo(id, de, ate, opts = {}) {
  const hoje = hojeISO(); if (ate > hoje) ate = hoje; if ((new Date(ate) - new Date(de)) / 86400000 > 92) throw new Error('Período máximo de 92 dias');
  const [col, esc, wd, dl, mc, af] = await Promise.all([colaboradores(), escalas(), workDays(de, ate), atrasos(de, ate), marcacoes(de, ate), afastamentos(de, ate)]);
  const c = col.ativos.find(x => x.id === +id) || col.desligados.find(x => x.id === +id); if (!c) throw Object.assign(new Error('Funcionário não encontrado no PontoCerto'), { status: 404 });
  const nm = semAcento(c.nome).trim(); const porDia = new Map(wd.filter(r => r.employee_id === c.id).map(r => [r.data, r])); const atr = new Map(dl.filter(r => semAcento(r.nome).trim() === nm).map(r => [r.data, r]));
  const escala = esc.get(c.turno_id); const dias = [];
  for (let d = ate; d >= de; d = (x => { const n = new Date(x + 'T12:00:00'); n.setDate(n.getDate() - 1); return n.toISOString().slice(0, 10); })(d)) {
    if (c.admissao && d < c.admissao) break;
    dias.push(montarLinha(c, porDia.get(d), atr.get(d), escala, d, hoje, opts.toleranciaMin, mc.get(nm + '|' + d), afastamentoEm(af, nm, d)));
  }
  return { colaborador: c, de, ate, dias, escala: escala ? { nome: escala.nome, dias: escala.dias, ciclo: escala.ciclo } : null };
}
const limparCache = () => { cache.clear(); escalasMem = null; };
module.exports = { getConfig, setConfig, testar, relatorio, resumo, colaboradores, afastamentosLongos, limparCache, lojaDe, setorDe, LOJAS_NOMES, ETQ, URL_PADRAO,
  escalas, previstoDe, classificarJornada, colunasMarcacoes, normalizarWorkDay, workDays, atrasos, marcacoes, afastamentos, jornadaDia, jornadaPeriodo, SITUACAO_JORNADA };
