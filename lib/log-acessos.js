'use strict';
// Log de acessos: quem entrou, quem errou a senha, quem saiu e que página cada usuário abriu.
// Append-only, 1 arquivo por mês em data/log-acessos/AAAA-MM.jsonl (mesmo padrão de
// lib/log-coletor.js / lib/log-precificacao.js). Além do arquivo, guarda em memória a última
// atividade de cada usuário (qualquer chamada autenticada, inclusive API) pra tela "Online agora".
// Tela: Processos > Logs > aba "Log de acessos" (public/log.html). Pedido do Tiago em 16/10/26.
const fs = require('fs');
const path = require('path');
const L = require('./log-erp'); // reaproveita novoId/agoraIso (mesmo formato de id e data)

// 'atividade' = acesso reconstruído de outros registros (quem fez algo no sistema em tal hora),
// usado pra preencher o período anterior a 16/10/26, quando ainda não havia log de acesso.
const TIPOS = ['login', 'login_falha', 'logout', 'pagina', 'atividade'];
const CAMPOS = ['id', 'em', 'tipo', 'usuario', 'nome', 'perfil', 'ip', 'dispositivo', 'pagina', 'msg'];

function arq(dir, quando) { return path.join(dir, String(quando).slice(0, 7) + '.jsonl'); }

/** IP do cliente sem o prefixo IPv6-mapeado (::ffff:192.168.2.50 → 192.168.2.50). */
function ipDe(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = xf || req.socket?.remoteAddress || req.ip || '';
  return String(raw).replace(/^::ffff:/, '') || null;
}

/** Resumo legível do User-Agent: "Android · Chrome", "Windows · Edge", "iPhone · Safari"... */
function dispositivoDe(ua) {
  ua = String(ua || '');
  if (!ua) return null;
  let so = 'Outro';
  if (/Android/i.test(ua)) so = 'Android';
  else if (/iPhone/i.test(ua)) so = 'iPhone';
  else if (/iPad/i.test(ua)) so = 'iPad';
  else if (/Windows/i.test(ua)) so = 'Windows';
  else if (/Mac OS X/i.test(ua)) so = 'Mac';
  else if (/Linux/i.test(ua)) so = 'Linux';
  let nav = 'Outro';
  if (/Edg\//i.test(ua)) nav = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) nav = 'Opera';
  else if (/SamsungBrowser/i.test(ua)) nav = 'Samsung';
  else if (/Firefox\//i.test(ua)) nav = 'Firefox';
  else if (/Chrome\/|CriOS\//i.test(ua)) nav = 'Chrome';
  else if (/Safari\//i.test(ua)) nav = 'Safari';
  else if (/wv\)|; wv/i.test(ua)) nav = 'App';
  if (/; wv\)|Version\/[\d.]+ Chrome/i.test(ua) && so === 'Android') nav = 'App'; // WebView (APK do coletor)
  return so + ' · ' + nav;
}

/** Grava um evento no arquivo do mês (append-only). Lança Error se o tipo for inválido. */
function registrar(dir, ev, agora = new Date()) {
  if (!TIPOS.includes(ev.tipo)) throw new Error('tipo inválido: ' + ev.tipo);
  if (!ev.usuario) throw new Error('usuario obrigatório');
  const e = { id: L.novoId(agora), em: L.agoraIso(agora) };
  for (const k of CAMPOS) if (ev[k] !== undefined && ev[k] !== null && !(k in e)) e[k] = ev[k];
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(arq(dir, e.em), JSON.stringify(e) + '\n');
  return e;
}

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MESES = 24;
function meses(de, ate) {
  if (!RE_DIA.test(String(de)) || !RE_DIA.test(String(ate))) throw new Error('data inválida (use AAAA-MM-DD)');
  if (ate < de) throw new Error('período invertido');
  const out = [];
  let d = new Date(de.slice(0, 7) + '-01T00:00:00Z');
  const fim = ate.slice(0, 7);
  for (;;) {
    const m = d.toISOString().slice(0, 7);
    out.push(m);
    if (m >= fim || out.length >= MAX_MESES) break;
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/** Lê o período (datas AAAA-MM-DD, inclusive), filtra e devolve do mais novo pro mais velho. */
function ler(dir, { de, ate, tipo, usuario, ip, pagina, limite = 5000 } = {}) {
  de = de || new Date().toISOString().slice(0, 10);
  ate = ate || de;
  const out = [];
  for (const m of meses(de, ate)) {
    const f = path.join(dir, m + '.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!ln) continue;
      let e; try { e = JSON.parse(ln); } catch { continue; }
      const dia = e.em.slice(0, 10);
      if (dia < de || dia > ate) continue;
      if (tipo && e.tipo !== tipo) continue;
      if (usuario && !(String(e.usuario || '') + ' ' + String(e.nome || '')).toUpperCase().includes(String(usuario).toUpperCase())) continue;
      if (ip && !String(e.ip || '').includes(String(ip))) continue;
      if (pagina && !String(e.pagina || '').toUpperCase().includes(String(pagina).toUpperCase())) continue;
      out.push(e);
    }
  }
  return out.sort((a, b) => b.em.localeCompare(a.em)).slice(0, limite);
}

/**
 * Resumo por usuário de um conjunto de eventos (saída do ler): nº de logins, falhas,
 * páginas abertas, primeiro e último acesso, IPs e dispositivos distintos.
 */
function resumo(itens) {
  const por = new Map();
  for (const e of itens) {
    const k = e.usuario;
    let r = por.get(k);
    if (!r) { r = { usuario: k, nome: e.nome || k, perfil: e.perfil || null, logins: 0, falhas: 0, paginas: 0, atividades: 0, primeiro: e.em, ultimo: e.em, ips: new Set(), dispositivos: new Set() }; por.set(k, r); }
    if (e.tipo === 'login') r.logins++;
    else if (e.tipo === 'login_falha') r.falhas++;
    else if (e.tipo === 'pagina') r.paginas++;
    else if (e.tipo === 'atividade') r.atividades++;
    if (e.em < r.primeiro) r.primeiro = e.em;
    if (e.em > r.ultimo) { r.ultimo = e.em; if (e.nome) r.nome = e.nome; if (e.perfil) r.perfil = e.perfil; }
    if (e.ip) r.ips.add(e.ip);
    if (e.dispositivo) r.dispositivos.add(e.dispositivo);
  }
  return [...por.values()]
    .map(r => ({ ...r, ips: [...r.ips], dispositivos: [...r.dispositivos] }))
    .sort((a, b) => b.ultimo.localeCompare(a.ultimo));
}

// ── Atividade em memória ("Online agora") ───────────────────────────────────
// Toda chamada autenticada (página ou API) marca o usuário como ativo. Perde no restart do
// serviço, mas volta a encher em segundos conforme as pessoas usam o sistema.
const atividade = new Map(); // usuario → { usuario, nome, perfil, ip, dispositivo, pagina, desde, ultima }

function marcarAtividade(user, { ip, dispositivo, pagina, desde } = {}, agora = new Date()) {
  if (!user || !user.usuario) return;
  const em = L.agoraIso(agora);
  const a = atividade.get(user.usuario) || { usuario: user.usuario, desde: desde || em };
  a.nome = user.nome || a.nome || user.usuario;
  a.perfil = user.perfil || a.perfil || null;
  if (ip) a.ip = ip;
  if (dispositivo) a.dispositivo = dispositivo;
  if (pagina) a.pagina = pagina;
  if (desde) a.desde = desde;
  a.ultima = em;
  atividade.set(user.usuario, a);
}

function removerAtividade(usuario) { atividade.delete(usuario); }

/** Usuários com atividade nos últimos `minutos` (padrão 15), do mais recente pro mais antigo. */
function online(minutos = 15, agora = new Date()) {
  const corte = L.agoraIso(new Date(agora.getTime() - minutos * 60 * 1000));
  return [...atividade.values()]
    .filter(a => a.ultima >= corte)
    .sort((a, b) => b.ultima.localeCompare(a.ultima));
}

/** Página "humana" pra registrar: só .html (ou a raiz). API, estático e imagens não entram. */
function paginaDe(reqPath) {
  const p = String(reqPath || '');
  if (p === '/' || p === '') return '/index.html';
  if (/^\/[a-z0-9_-]+\.html$/i.test(p)) return p.toLowerCase();
  return null;
}

function csv(itens) {
  const cab = ['em', 'tipo', 'usuario', 'nome', 'perfil', 'ip', 'dispositivo', 'pagina', 'msg'];
  // célula começando com = + - @ vira fórmula no Excel (CSV injection): prefixa com apóstrofo.
  const neutro = t => /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
  const esc = v => { if (v == null) return ''; const t = neutro(String(v)); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return '﻿' + cab.join(';') + '\n' + itens.map(e => cab.map(k => esc(e[k])).join(';')).join('\n');
}

module.exports = { registrar, ler, resumo, csv, TIPOS, ipDe, dispositivoDe, paginaDe, marcarAtividade, removerAtividade, online, _atividade: atividade };
