// Ranking de vendedores da CAHU no WhatsApp (02/10/2026, pedido do Tiago: "ranking de vendedores sem mostrar
// valores... tipo uma competição entre eles e isso traga vendas").
//
//   07:30 seg–sáb → mensagem curta pro grupo dos vendedores, SEM VALORES (só posição), três formatos:
//     • dia 1º do mês      → "nova corrida": ranking zerado, todo mundo na largada
//     • última semana      → "reta final": top 3 + quantos dias úteis faltam (seg–sáb)
//     • demais dias        → enxuta: top 3 só com primeiro nome + destaque de ontem (quem mais vendeu)
//
// Ranking = NF-e de venda do CD no mês (central.compras, nLoja 10, VENDA/NF/F), vendedor vem do pedido do
// televendas (central.delivery) — mesmas fontes do bloco Faturamento do Dashboard Distribuidora.
// Quem fala com o WhatsApp é o processo cahu-wpp/ (localhost:3012), o mesmo da tabela de preços.
// SOMENTE LEITURA no ERP. Se o bot estiver fora, só loga — tenta de novo às 07:45.
'use strict';
const fs = require('fs');
const path = require('path');

const LOJA = 10;
const STATE_PATH = process.env.CAHU_RANKING_STATE || path.join(__dirname, '..', 'data', 'cahu-ranking-wpp.json');
const BOT_URL = (process.env.CAHU_WPP_URL || 'http://127.0.0.1:3012').replace(/\/$/, '');
const HORA_ENVIO = '07:30', HORA_RETRY = '07:45';   // meia hora depois da tabela das 07:00, pra não embolar
const RETA_FINAL_DIAS = 6;                          // última semana = restam até 6 dias úteis (seg–sáb) no mês

let deps = null;   // { q }
let state = null;
let timer = null;
let rodando = false;

const num = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isFinite(n) ? n : 0; };
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hojeISO = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const horaLocal = (d = new Date()) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const addDias = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return iso(x); };
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// ── estado em disco ───────────────────────────────────────────────────────────
function estadoVazio() { return { config: { ativo: true }, ultimoEnvio: null, retry: null, log: [] }; }
function carregar() {
  if (state) return state;
  try { state = { ...estadoVazio(), ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; }
  catch { state = estadoVazio(); }
  return state;
}
function salvar() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
}
function logar(tipo, ok, msg) {
  carregar();
  state.log.unshift({ em: new Date().toISOString(), tipo, ok, msg: String(msg || '').slice(0, 300) });
  state.log = state.log.slice(0, 100);
  salvar();
  (ok ? console.log : console.error)(`[CAHU-RANKING] ${tipo}: ${msg}`);
}

// ── texto (puras) ─────────────────────────────────────────────────────────────
// dias úteis que faltam no mês contando hoje, seg–sáb (domingo não conta — é o único dia sem envio/venda)
function diasUteisRestantes(diaISO) {
  const fim = diaISO.slice(0, 8) + pad(new Date(+diaISO.slice(0, 4), +diaISO.slice(5, 7), 0).getDate());
  let n = 0;
  for (let d = diaISO; d <= fim; d = addDias(d, 1)) if (new Date(d + 'T12:00:00').getDay() !== 0) n++;
  return n;
}

const titulo = s => String(s || '').trim().toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
// primeiro nome com inicial maiúscula; se outro vendedor do ranking tem o mesmo primeiro nome, usa dois nomes
function nomeCurto(nome, todos) {
  const t = titulo(nome), primeiro = t.split(' ')[0];
  const repetido = todos.filter(n => titulo(n).split(' ')[0] === primeiro).length > 1;
  return repetido ? t.split(' ').slice(0, 2).join(' ') : primeiro;
}

// ranking: notas do mês somadas por vendedor (sem "Sem vendedor"), maior → menor. Valores NUNCA vão pra mensagem.
function montarRanking(notas) {
  const por = {};
  for (const n of notas) {
    if (!n.vend) continue;
    const a = por[n.vend] || (por[n.vend] = { cod: n.vend, nome: n.vendNome, v: 0, n: 0 });
    a.v += n.v; a.n++;
  }
  return Object.values(por).sort((a, b) => b.v - a.v);
}

// destaque = quem mais vendeu no último dia com venda antes de hoje (segunda-feira o "ontem" é o sábado)
function destaqueAnterior(notas, diaISO) {
  const dias = [...new Set(notas.filter(n => n.vend && n.d < diaISO).map(n => n.d))].sort();
  const ult = dias[dias.length - 1];
  if (!ult) return null;
  const rank = montarRanking(notas.filter(n => n.d === ult));
  return rank.length ? { nome: rank[0].nome, d: ult, ontem: ult === addDias(diaISO, -1) } : null;
}

function textoMesNovo(diaISO) {
  const mes = MESES[+diaISO.slice(5, 7) - 1];
  return `🏁 *NOVO MÊS, NOVA CORRIDA!*\n\nRanking zerado — todo mundo no mesmo ponto de largada. Quem fecha a primeira venda de ${mes}? 👀\n\nBom dia, time! 💪`;
}

function textoRetaFinal(ranking, diaISO) {
  const dias = diasUteisRestantes(diaISO);
  const cab = dias <= 1 ? '⏳ *RETA FINAL — último dia útil do mês!*' : `⏳ *RETA FINAL — faltam ${dias} dias úteis!*`;
  const linhas = [cab, ''];
  if (ranking.length) {
    const colado = ranking[1] && ranking[0].v > 0 && ranking[1].v >= ranking[0].v * 0.8;   // 2º a menos de 20% do líder
    linhas.push(`🥇 ${titulo(ranking[0].nome)}`);
    if (ranking[1]) linhas.push(`🥈 ${titulo(ranking[1].nome)}${colado ? ' — na cola do líder! 👀' : ''}`);
    if (ranking[2]) linhas.push(`🥉 ${titulo(ranking[2].nome)}`);
    linhas.push('', 'Ainda dá tempo de virar o jogo.');
  } else linhas.push('Ranking ainda zerado — quem abre o placar? 👀', '');
  linhas.push('Bora fechar o mês com chave de ouro! 🔑');
  return linhas.join('\n');
}

function textoDiario(ranking, destaque, diaISO) {
  const data = `${diaISO.slice(8, 10)}/${diaISO.slice(5, 7)}`;
  const linhas = [];
  if (ranking.length) {
    const nomes = ranking.map(r => r.nome);
    const top = [['🥇', 0], ['🥈', 1], ['🥉', 2]].filter(([, i]) => ranking[i]).map(([m, i]) => `${m} ${nomeCurto(ranking[i].nome, nomes)}`);
    linhas.push(`🏆 *${data} — Ranking do mês:*`, top.join('  '), '');
  } else linhas.push(`🏆 *${data}* — Ranking do mês ainda zerado. Quem abre o placar hoje? 👀`, '');
  if (destaque) linhas.push(`Destaque de ${destaque.ontem ? 'ontem' : destaque.d.slice(8, 10) + '/' + destaque.d.slice(5, 7)}: ${titulo(destaque.nome)} 🔥`);
  linhas.push('Bom dia e boas vendas! 💪');
  return linhas.join('\n');
}

// escolhe o formato pelo dia: 1º do mês → nova corrida · restam ≤ RETA_FINAL_DIAS úteis → reta final · senão diário
function textoDoDia(diaISO, notas) {
  if (diaISO.slice(8, 10) === '01') return textoMesNovo(diaISO);
  const ranking = montarRanking(notas.filter(n => n.d >= diaISO.slice(0, 8) + '01'));
  if (diasUteisRestantes(diaISO) <= RETA_FINAL_DIAS) return textoRetaFinal(ranking, diaISO);
  return textoDiario(ranking, destaqueAnterior(notas, diaISO), diaISO);
}

// ── ERP: notas de venda do mês com vendedor (mesmas fontes do Dashboard Distribuidora) ───────────────────────
async function carregarNotas(diaISO) {
  const q = deps.q, ini = diaISO.slice(0, 8) + '01', iniPed = addDias(ini, -10);   // NF-e do começo do mês pode vir de pedido do fim do anterior
  const vend = {};
  for (const v of await q('SELECT nReg cod, NomeVendedor nome FROM central.vendedor_delivery').catch(() => [])) vend[+v.cod] = String(v.nome || '').trim();
  const porPed = new Map();
  for (const p of await q('SELECT nPedido ped, CodVendedor vend FROM central.delivery WHERE nLoja = ? AND Data BETWEEN ? AND ?', [LOJA, iniPed, diaISO]).catch(() => [])) porPed.set(+p.ped, +p.vend || 0);
  const notas = (await q(`SELECT DATE_FORMAT(DataLan,'%Y-%m-%d') d, TotalNota v, NumeroPedido ped FROM central.compras
                          WHERE nLoja = ? AND Movimentacao = 'VENDA' AND Tipo = 'NF' AND Status = 'F' AND DataLan BETWEEN ? AND ?`, [LOJA, ini, diaISO]))
    .map(n => { const cod = porPed.get(+n.ped) || 0; return { d: String(n.d).slice(0, 10), v: num(n.v), vend: cod, vendNome: vend[cod] || 'Sem vendedor' }; });
  return notas;
}

// ── bot (processo cahu-wpp, só localhost) ─────────────────────────────────────
async function enviarTexto(texto) {
  let r;
  try {
    r = await fetch(BOT_URL + '/mensagem-grupo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto }), signal: AbortSignal.timeout(90000) });
  } catch (e) {
    const err = new Error('bot indisponível (' + (e.cause?.code || e.name || e.message) + ')'); err.botOffline = true; throw err;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j.error || `bot HTTP ${r.status}`); err.botOffline = r.status === 503; throw err; }
}

// ── rotina ────────────────────────────────────────────────────────────────────
async function rotinaRanking({ manual = false } = {}) {
  if (rodando) throw new Error('já tem um envio rodando');
  rodando = true;
  const s = carregar();
  const tipo = manual ? 'ranking-manual' : 'ranking';
  try {
    const dia = hojeISO();
    const notas = await carregarNotas(dia);
    const texto = textoDoDia(dia, notas);
    s.retry = null; salvar();
    if (!s.config.ativo) { logar(tipo, true, 'pausado (config.ativo=false): nada enviado'); return { enviado: false, texto }; }
    await enviarTexto(texto);
    s.ultimoEnvio = new Date().toISOString(); salvar();
    logar(tipo, true, `ranking enviado (${notas.filter(n => n.vend).length} notas no mês)`);
    return { enviado: true, texto };
  } catch (e) {
    if (e.botOffline) { logar(tipo, true, `bot WhatsApp fora do ar, nada enviado (${e.message})`); return { enviado: false, motivo: e.message }; }
    if (!manual && !s.retry) { s.retry = hojeISO(); salvar(); logar(tipo, false, `${e.message} — tenta de novo às ${HORA_RETRY}`); }
    else logar(tipo, false, e.message);
    throw e;
  } finally { rodando = false; }
}

// ── agenda (seg–sáb, horário de Brasília) ─────────────────────────────────────
let ultimaChave = null;
function tick() {
  const agora = new Date();
  const dow = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getDay();
  if (dow === 0) return;
  const hm = horaLocal(agora), chave = `${hojeISO(agora)} ${hm}`;
  if (chave === ultimaChave) return;
  const s = carregar();
  if (hm !== HORA_ENVIO && !(hm === HORA_RETRY && s.retry === hojeISO(agora))) return;
  ultimaChave = chave;
  rotinaRanking().catch(() => {});
}
function agendar() {
  if (timer) return;
  carregar();
  timer = setInterval(tick, 20 * 1000);
  console.log(`[CAHU-RANKING] agenda ativa: seg–sáb ${HORA_ENVIO} ranking de vendedores (bot em ${BOT_URL})`);
}

function estado() {
  const s = carregar();
  return { config: s.config, ultimoEnvio: s.ultimoEnvio, retry: s.retry, horario: { envio: HORA_ENVIO, retry: HORA_RETRY, dias: 'seg–sáb' }, log: s.log.slice(0, 30) };
}
function salvarConfig(cfg) {
  const s = carregar();
  if (typeof cfg.ativo === 'boolean') s.config.ativo = cfg.ativo;
  salvar(); logar('config', true, JSON.stringify(s.config));
  return s.config;
}
// prévia sem enviar: texto que sairia hoje (pro Tiago conferir antes de ligar)
async function previa() { const dia = hojeISO(); return { dia, texto: textoDoDia(dia, await carregarNotas(dia)) }; }

function init(d) { deps = d; carregar(); }

module.exports = { init, agendar, rotinaRanking, estado, salvarConfig, previa,
  // puras, pra teste
  montarRanking, destaqueAnterior, textoDiario, textoMesNovo, textoRetaFinal, textoDoDia, diasUteisRestantes, nomeCurto, STATE_PATH };