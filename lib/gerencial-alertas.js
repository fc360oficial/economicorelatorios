// Aviso no celular do gerente quando passa o horário sem marcação (27/10/2026, Tiago: "se passar 10 min do horário ter
// notificação no celular"; 28/10: "pode fazer lembrete de 1 h e resumo das 09 e das 15"). Roda a cada 5 min no server.js em cima
// da MESMA jornada do dia da TV RH/DP (pontocerto.jornadaDia via tv-rh.jornadaHoje) e manda, por loja, um aviso agrupado pelos
// gerentes inscritos (lib/gerencial-push.js notificarLoja):
//   · 10 min depois do previsto sem marcação → aviso ("ANA · CAIXA · entrada prevista 07:00 e sem marcação");
//   · 1 h depois, se continuar sem marcação → UM lembrete ("… ainda sem marcação há 1 h") e depois nada mais naquele dia;
//   · 09:00 e 15:00 → resumo da loja (previstos, bateram, sem marcação, após o horário, trabalhando na folga).
// Vale pra ENTRADA, RETORNO DO INTERVALO (saiu e não voltou) e SAÍDA (bateu a entrada e não bateu a saída). Falta não existe aqui:
// é decisão da apuração do DP. Cada pessoa×momento×nível e cada resumo só vai uma vez por dia (data/gerencial-push/avisos-ponto.json).
'use strict';
const fs = require('fs'), path = require('path');

const ATRASO_MIN = 10;                 // minutos depois do horário previsto → aviso
const LEMBRETE_MIN = 60;               // minutos depois do previsto, ainda sem marcação → lembrete único
const RESUMOS = ['09:00', '15:00'];    // horários do resumo da loja
const JANELA_RESUMO_MIN = 180;         // resumo só sai até 3 h depois do horário (servidor parado não manda o das 09 às 14)
const MAX_NOMES = 8;
const LOJA_TXT = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão', 10: 'CD' };
const FORA = { folga: 1, ferias: 1, afastado: 1, sem_escala: 1 };
const min = hm => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const hojeStr = () => { const h = new Date(); return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`; };
const agoraHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const primeiroNome = n => { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[p.length - 1] : p[0] || ''; };
const lista = (xs, f) => { const n = xs.slice(0, MAX_NOMES).map(f).join(', '); return xs.length > MAX_NOMES ? n + ` e mais ${xs.length - MAX_NOMES}` : n; };

/** Quem passou do horário sem bater (função pura). linhas = pontocerto.jornadaDia(...).linhas; cada item traz `minutos` desde o previsto. */
function pendentes(linhas, agora, tol) {
  const t = tol == null ? ATRASO_MIN : tol, ag = min(agora), out = [];
  if (ag == null) return out;
  const item = (l, tipo, previsto, pm) => ({ loja: +l.loja, id: l.id, nome: l.nome, setor: l.setor || '', tipo, previsto, minutos: ag - pm });
  for (const l of linhas || []) {
    if (!l || FORA[l.situacao]) continue;
    const pv = l.previsto; if (!pv || pv.folga) continue;
    const pe = min(pv.entrada), pri = min(pv.retornoInt), psa = min(pv.saida);
    if (pe != null && min(l.entrada) == null && ag >= pe + t) out.push(item(l, 'entrada', pv.entrada, pe));
    if (pri != null && min(l.saidaInt) != null && min(l.retornoInt) == null && ag >= pri + t) out.push(item(l, 'retorno', pv.retornoInt, pri));
    if (psa != null && min(l.entrada) != null && min(l.saida) == null && ag >= psa + t) out.push(item(l, 'saida', pv.saida, psa));
  }
  return out;
}
const chaveDe = (p, dia, nivel) => `${dia}:${p.loja}:${p.id}:${p.tipo}${nivel ? ':' + nivel : ''}`;
const TIPO_TXT = { entrada: ['entrada prevista', 'sem marcação de entrada'], retorno: ['retorno do intervalo previsto', 'sem retorno do intervalo'], saida: ['saída prevista', 'sem marcação de saída'] };

/** Agrupa por loja o que ainda não foi avisado hoje: aviso (10 min) ou lembrete (1 h, uma vez) — função pura. */
function montarAvisos(pend, enviados, dia, tol) {
  const t = tol == null ? ATRASO_MIN : tol, porLoja = {};
  for (const p of pend) {
    const k1 = chaveDe(p, dia), kL = chaveDe(p, dia, 'lembrete');
    if (p.minutos >= LEMBRETE_MIN) { if (enviados.has(kL)) continue; (porLoja[p.loja] = porLoja[p.loja] || []).push({ ...p, lembrete: true, chaves: enviados.has(k1) ? [kL] : [k1, kL] }); }
    else { if (enviados.has(k1)) continue; (porLoja[p.loja] = porLoja[p.loja] || []).push({ ...p, lembrete: false, chaves: [k1] }); }
  }
  const out = [];
  for (const [loja, ps] of Object.entries(porLoja)) {
    for (const lembrete of [false, true]) {
      const grupo = ps.filter(p => p.lembrete === lembrete); if (!grupo.length) continue;
      const partes = [];
      for (const tipo of ['entrada', 'retorno', 'saida']) {
        const xs = grupo.filter(p => p.tipo === tipo); if (!xs.length) continue;
        const [um, varios] = TIPO_TXT[tipo];
        if (xs.length === 1) partes.push(`${primeiroNome(xs[0].nome)}${xs[0].setor ? ' · ' + xs[0].setor : ''} · ${um} ${xs[0].previsto}${lembrete ? ' · ainda sem marcação há 1 h' : ' e sem marcação'}`);
        else partes.push(`${xs.length} ${varios}${lembrete ? ' há 1 h' : ''}: ${lista(xs, p => `${primeiroNome(p.nome)} (${p.previsto})`)}`);
      }
      out.push({ loja: +loja, lembrete, chaves: grupo.flatMap(p => p.chaves), pessoas: grupo.length,
                 payload: { title: `Ponto · ${LOJA_TXT[loja] || 'Loja ' + loja} · ${lembrete ? 'lembrete de 1 h' : t + ' min do horário'}`, body: partes.join('. '), url: '/gestao-gerencial.html#ponto', tag: 'ponto-' + loja + (lembrete ? '-l' : '') } });
    }
  }
  return out;
}

/** Resumo da loja num horário (função pura): previstos, bateram, sem marcação, após o horário, trabalhando na folga. */
function montarResumo(linhas, loja, hora, tol) {
  const t = tol == null ? ATRASO_MIN : tol, ag = min(hora);
  const ls = (linhas || []).filter(l => l && +l.loja === +loja && !FORA[l.situacao] && l.previsto && !l.previsto.folga);
  const folgaTrab = (linhas || []).filter(l => l && +l.loja === +loja && l.situacao === 'folga_trabalhada' && l.entrada);
  const semEntrada = [], apos = [], semRetorno = [];
  let bateram = 0;
  for (const l of ls) {
    const pe = min(l.previsto.entrada), e = min(l.entrada);
    if (e != null) { bateram++; if (pe != null && e > pe + t) apos.push({ ...l, atraso: e - pe }); }
    else if (pe != null && ag >= pe) semEntrada.push(l);
    const pri = min(l.previsto.retornoInt);
    if (pri != null && min(l.saidaInt) != null && min(l.retornoInt) == null && ag >= pri + t) semRetorno.push(l);
  }
  const partes = [`${ls.length} previstos · ${bateram} bateram`];
  if (semEntrada.length) partes.push(`Sem marcação (${semEntrada.length}): ${lista(semEntrada, l => `${primeiroNome(l.nome)} (${l.previsto.entrada})`)}`);
  if (apos.length) partes.push(`Após o horário (${apos.length}): ${lista(apos, l => `${primeiroNome(l.nome)} (+${l.atraso} min)`)}`);
  if (semRetorno.length) partes.push(`Sem retorno do intervalo (${semRetorno.length}): ${lista(semRetorno, l => primeiroNome(l.nome))}`);
  if (folgaTrab.length) partes.push(`Trabalhando na folga (${folgaTrab.length}): ${lista(folgaTrab, l => primeiroNome(l.nome))}`);
  if (partes.length === 1 && ls.length) partes.push('Todos no horário');
  return { loja: +loja, previstos: ls.length, bateram, semEntrada: semEntrada.length, apos: apos.length, semRetorno: semRetorno.length, folgaTrab: folgaTrab.length,
           payload: { title: `Resumo ${hora} · ${LOJA_TXT[loja] || 'Loja ' + loja}`, body: partes.join('. ').slice(0, 480), url: '/gestao-gerencial.html#ponto', tag: 'resumo-' + loja } };
}
/** Resumos que estão na hora e ainda não saíram hoje (janela de 3 h): [{ hora, loja, chave, payload }] — função pura. */
function resumosPendentes(linhas, agora, enviados, dia, tol) {
  const ag = min(agora), out = [];
  if (ag == null) return out;
  const lojas = [...new Set((linhas || []).filter(l => l && l.loja && !FORA[l.situacao] && l.previsto && !l.previsto.folga).map(l => +l.loja))].sort((a, b) => a - b);
  for (const hora of RESUMOS) {
    const h = min(hora); if (ag < h || ag >= h + JANELA_RESUMO_MIN) continue;
    for (const loja of lojas) {
      const chave = `${dia}:${loja}:resumo:${hora}`; if (enviados.has(chave)) continue;
      const r = montarResumo(linhas, loja, hora, tol); if (!r.previstos) continue;
      out.push({ hora, loja, chave, payload: r.payload });
    }
  }
  return out;
}

// ── estado (o que já foi avisado hoje) ───────────────────────────────────────────────────────────────────
let ARQ = null, estado = { dia: null, chaves: [] };
function init(deps) { ARQ = path.join((deps && deps.dataDir) || path.join(__dirname, '..', 'data', 'gerencial-push'), 'avisos-ponto.json'); try { estado = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { estado = { dia: null, chaves: [] }; } }
function gravar() { try { fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(estado)); } catch (e) { console.error('[gerencial-alertas] gravar:', e.message); } }

/** Uma rodada: avisos de 10 min, lembretes de 1 h e resumos das 09/15. deps: { jornadaHoje, notificarLoja, tol?, agora?, dia? } */
async function rodar(deps) {
  const dia = deps.dia || hojeStr(), agora = deps.agora || agoraHM();
  if (estado.dia !== dia) { estado = { dia, chaves: [] }; }
  const j = await deps.jornadaHoje(), linhas = (j && j.linhas) || [];
  const enviados = new Set(estado.chaves);
  const pend = pendentes(linhas, agora, deps.tol);
  const avisos = montarAvisos(pend, enviados, dia, deps.tol);
  const resumos = resumosPendentes(linhas, agora, enviados, dia, deps.tol);
  const out = { dia, agora, pendentes: pend.length, avisos: 0, lembretes: 0, resumos: 0, enviados: 0, semGerente: 0 };
  const mandar = async (loja, payload, ttl, chaves, campo) => {
    const r = await deps.notificarLoja(loja, payload, ttl);
    // loja sem gerente inscrito: não marca (quando ele instalar o app passa a receber); com aparelho, marca mesmo se o push falhar hoje
    if (!r || !r.usuarios) { out.semGerente++; return; }
    estado.chaves.push(...chaves); out[campo]++; out.enviados += r.ok || 0;
  };
  for (const a of avisos) await mandar(a.loja, a.payload, 3600, a.chaves, a.lembrete ? 'lembretes' : 'avisos');
  for (const r of resumos) await mandar(r.loja, r.payload, 3 * 3600, [r.chave], 'resumos');
  if (out.avisos || out.lembretes || out.resumos) gravar();
  return out;
}

module.exports = { init, rodar, pendentes, montarAvisos, montarResumo, resumosPendentes, ATRASO_MIN, LEMBRETE_MIN, RESUMOS, _estado: () => estado };
