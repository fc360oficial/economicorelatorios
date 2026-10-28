// Aviso no celular do gerente quando passa o horário sem marcação (27/10/2026, Tiago: "se passar 10 min do horário ter
// notificação no celular"). Roda a cada 5 min no server.js em cima da MESMA jornada do dia da TV RH/DP (pontocerto.jornadaDia
// via tv-rh.jornadaHoje) e manda, por loja, um aviso agrupado pelos gerentes inscritos (lib/gerencial-push.js notificarLoja):
// entrada prevista 07:00 e nada batido até 07:10 → "ANA (CAIXA) · entrada 07:00". Vale pra ENTRADA e pro RETORNO DO INTERVALO
// (saiu pro intervalo e não voltou) e pra SAÍDA (28/10, Tiago: "10 min seja na saída ou seja na entrada": bateu a entrada, passou
// 10 min da saída prevista e não bateu a saída).
// Cada pessoa×momento só é avisada uma vez por dia (data/gerencial-push/avisos-ponto.json). Só leitura do PontoCerto.
'use strict';
const fs = require('fs'), path = require('path');

const ATRASO_MIN = 10;                 // minutos depois do horário previsto
const LOJA_TXT = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão', 10: 'CD' };
const FORA = { folga: 1, ferias: 1, afastado: 1, sem_escala: 1 };
const min = hm => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const hojeStr = () => { const h = new Date(); return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`; };
const agoraHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const primeiroNome = n => { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[p.length - 1] : p[0] || ''; };

/** Quem passou do horário sem bater (função pura). linhas = pontocerto.jornadaDia(...).linhas */
function pendentes(linhas, agora, tol) {
  const t = tol == null ? ATRASO_MIN : tol, ag = min(agora), out = [];
  if (ag == null) return out;
  for (const l of linhas || []) {
    if (!l || FORA[l.situacao]) continue;
    const pv = l.previsto; if (!pv || pv.folga) continue;
    const pe = min(pv.entrada), pri = min(pv.retornoInt);
    if (pe != null && min(l.entrada) == null && ag >= pe + t) out.push({ loja: +l.loja, id: l.id, nome: l.nome, setor: l.setor || '', tipo: 'entrada', previsto: pv.entrada });
    if (pri != null && min(l.saidaInt) != null && min(l.retornoInt) == null && ag >= pri + t) out.push({ loja: +l.loja, id: l.id, nome: l.nome, setor: l.setor || '', tipo: 'retorno', previsto: pv.retornoInt });
    const psa = min(pv.saida);
    if (psa != null && min(l.entrada) != null && min(l.saida) == null && ag >= psa + t) out.push({ loja: +l.loja, id: l.id, nome: l.nome, setor: l.setor || '', tipo: 'saida', previsto: pv.saida });
  }
  return out;
}
const chaveDe = (p, dia) => `${dia}:${p.loja}:${p.id}:${p.tipo}`;

/** Agrupa por loja o que ainda não foi avisado hoje e monta o texto do aviso (função pura). */
function montarAvisos(pend, enviados, dia, tol) {
  const t = tol == null ? ATRASO_MIN : tol, porLoja = {};
  for (const p of pend) { const k = chaveDe(p, dia); if (enviados.has(k)) continue; (porLoja[p.loja] = porLoja[p.loja] || []).push({ ...p, chave: k }); }
  return Object.entries(porLoja).map(([loja, ps]) => {
    const ent = ps.filter(p => p.tipo === 'entrada'), ret = ps.filter(p => p.tipo === 'retorno'), sai = ps.filter(p => p.tipo === 'saida');
    const nomes = xs => xs.map(p => `${primeiroNome(p.nome)} (${p.previsto})`).join(', ');
    const partes = [];
    if (ent.length) partes.push(ent.length === 1 ? `${primeiroNome(ent[0].nome)}${ent[0].setor ? ' · ' + ent[0].setor : ''} · entrada prevista ${ent[0].previsto} e sem marcação` : `${ent.length} sem marcação de entrada: ${nomes(ent)}`);
    if (ret.length) partes.push(ret.length === 1 ? `${primeiroNome(ret[0].nome)}${ret[0].setor ? ' · ' + ret[0].setor : ''} · retorno do intervalo previsto ${ret[0].previsto} e sem marcação` : `${ret.length} sem retorno do intervalo: ${nomes(ret)}`);
    if (sai.length) partes.push(sai.length === 1 ? `${primeiroNome(sai[0].nome)}${sai[0].setor ? ' · ' + sai[0].setor : ''} · saída prevista ${sai[0].previsto} e sem marcação` : `${sai.length} sem marcação de saída: ${nomes(sai)}`);
    return { loja: +loja, chaves: ps.map(p => p.chave), pessoas: ps.length,
             payload: { title: `Ponto · ${LOJA_TXT[loja] || 'Loja ' + loja} · ${t} min do horário`, body: partes.join('. '), url: '/gestao-gerencial.html#ponto', tag: 'ponto-' + loja } };
  });
}

// ── estado (o que já foi avisado hoje) ───────────────────────────────────────────────────────────────────
let ARQ = null, estado = { dia: null, chaves: [] };
function init(deps) { ARQ = path.join((deps && deps.dataDir) || path.join(__dirname, '..', 'data', 'gerencial-push'), 'avisos-ponto.json'); try { estado = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { estado = { dia: null, chaves: [] }; } }
function gravar() { try { fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(estado)); } catch (e) { console.error('[gerencial-alertas] gravar:', e.message); } }

/** Uma rodada: lê a jornada do dia, acha quem passou do horário, avisa os gerentes das lojas. deps: { jornadaHoje, notificarLoja, tol?, agora?, dia? } */
async function rodar(deps) {
  const dia = deps.dia || hojeStr(), agora = deps.agora || agoraHM();
  if (estado.dia !== dia) { estado = { dia, chaves: [] }; }
  const j = await deps.jornadaHoje();
  const pend = pendentes((j && j.linhas) || [], agora, deps.tol);
  const avisos = montarAvisos(pend, new Set(estado.chaves), dia, deps.tol);
  const out = { dia, agora, pendentes: pend.length, avisos: 0, enviados: 0, semGerente: 0 };
  for (const a of avisos) {
    const r = await deps.notificarLoja(a.loja, a.payload, 3600);
    // loja sem gerente inscrito: não marca como avisado (quando ele instalar o app passa a receber); com aparelho, marca mesmo se o push falhar hoje
    if (!r || !r.usuarios) { out.semGerente++; continue; }
    estado.chaves.push(...a.chaves); out.avisos++; out.enviados += r.ok || 0;
  }
  if (out.avisos) gravar();
  return out;
}

module.exports = { init, rodar, pendentes, montarAvisos, ATRASO_MIN, _estado: () => estado };
