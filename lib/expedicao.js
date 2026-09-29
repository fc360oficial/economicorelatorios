// lib/expedicao.js — conferência CEGA de saída do CD (loja 10): o pedido do Televendas é a verdade.
// Spec: docs/superpowers/specs/2026-09-29-coletor-cd-expedicao-processo.md
//  - separação continua no papel; o coletor entra uma vez, na saída, e bipa o que vai no caminhão
//  - avisa NA HORA (sem revelar a qtd do pedido): 'qtd_diferente' | 'fora_do_pedido' | 'sem_lote'
//  - o pedido nunca muda pelo app: a menos → bipa o certo; a mais / fora → "tirar da coletagem"
//  - só fecha 100 %: terminei() muda pra 'fechada' apenas quando todo item bate e não há nada fora
//  - todo "tirar" vira evento tirar_coletagem (pendência "verificar pallet" pro fiscal do CD)
// Estado em data/expedicao/AAAA-MM-DD.json (um arquivo por dia, id → conferência). ERP é espelho (expedicao-erp.js).
const fs = require('fs'); const path = require('path');
let DIR, deps = {};
const LOJA_CD = 10;
const LIMITE_BIPES_VISTOS = 500;
const agora = () => (deps.agora ? deps.agora() : new Date());
const diaStr = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const hojeStr = () => diaStr(agora());
const RE_ID = /^exp-\d{4}-\d{2}-\d{2}-10-\d{1,10}$/;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
function validarId(id) { if (!RE_ID.test(String(id || ''))) throw erro('id de expedição inválido'); return String(id); }
const arqDia = data => path.join(DIR, data + '.json');
function init(o) { DIR = o.dir; deps = o; fs.mkdirSync(DIR, { recursive: true }); }
function lerDia(data) {
  if (!RE_DIA.test(String(data || ''))) throw erro('data inválida');
  try { return JSON.parse(fs.readFileSync(arqDia(data), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    try { fs.renameSync(arqDia(data), arqDia(data) + '.corrompido-' + Date.now()); } catch {} return {};
  }
}
function salvar(c) { const dia = c.id.slice(4, 14); const m = lerDia(dia); m[c.id] = c; const tmp = arqDia(dia) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, arqDia(dia)); return c; }
function obter(id) { validarId(id); return lerDia(id.slice(4, 14))[id] || null; }
function listarDia(data) { return Object.values(lerDia(data)); }
function dias(n) { const out = []; for (let i = 0; i < n; i++) out.push(diaStr(new Date(agora().getTime() - i * 864e5))); return out; }
function acharPorPedido(nPedido) { for (const d of dias(4)) { const c = listarDia(d).find(x => String(x.nPedido) === String(nPedido) && x.status !== 'fechada'); if (c) return c; } return null; }

// ── dedup por bipeId (fila offline do coletor reenvia) ─────────────────────
function jaAplicado(c, bipeId) { return bipeId && c.bipes_vistos ? c.bipes_vistos[bipeId] : null; }
function marcarAplicado(c, bipeId, resultado, cod) {
  if (!bipeId) return; c.bipes_vistos = c.bipes_vistos || {}; c.bipes_vistos[bipeId] = { resultado, cod };
  const ks = Object.keys(c.bipes_vistos); if (ks.length > LIMITE_BIPES_VISTOS) for (const k of ks.slice(0, ks.length - LIMITE_BIPES_VISTOS)) delete c.bipes_vistos[k];
}

/** Abre (ou retoma) a conferência de saída de um pedido do Televendas.
 *  itens: [{ cod, descricao, qtd, qtdEmb, und, conversao }] como vêm de delivery_produtos. Conferido no ERP em
 *  29/09/26: `Qtd` JÁ É a quantidade em unidades do código do item (ex.: "4 FD c/27" vem Qtd=108, QtdEmb=0),
 *  então a comparação usa Qtd direto; QtdEmb/Conversao são só informativos (emb sugerida pro bipe). */
function abrirPedido({ nPedido, cliente, cnpj, nome, itens, total }) {
  const ex = acharPorPedido(nPedido); if (ex) return ex;
  const pedido = {};
  for (const i of itens || []) {
    const cod = String(i.cod || '').trim(); if (!cod) continue;
    const un = +(+i.qtd || 0).toFixed(3); const mConv = /c\/\s*(\d+)/i.exec(String(i.conversao || '')); const emb = +i.qtdEmb > 0 ? +i.qtdEmb : (mConv ? +mConv[1] : 1);
    if (pedido[cod]) pedido[cod].un = +(pedido[cod].un + un).toFixed(3);
    else pedido[cod] = { cod, descricao: String(i.descricao || '').trim(), un, emb, und: String(i.und || '').trim() };
  }
  const c = { id: `exp-${hojeStr()}-${LOJA_CD}-${String(nPedido).replace(/\D/g, '')}`, loja: LOJA_CD, nPedido: String(nPedido), cliente: String(cliente || '').slice(0, 45), cnpj: String(cnpj || ''), total: +total || 0,
    nome: String(nome || '').toUpperCase().slice(0, 20), status: 'bipando', abertoEm: agora().toISOString(), pedido, itens: {}, fora: {}, eventos: [], erp: { nReg: null, erros: [] } };
  return salvar(c);
}

function reavaliar(c, it) { const p = c.pedido[it.cod]; it.estado = !p ? 'fora' : Math.abs(it.un - p.un) < 0.001 ? 'ok' : 'diferente'; }

/** Bipe cego. Resposta imediata sem revelar a qtd do pedido. */
async function bipar(id, { cod, quant, emb, lote, nome, bipeId }) {
  const c = obter(id); if (!c) throw erro('Conferência não encontrada', 404); if (c.status === 'fechada') throw erro('Pedido já conferido e fechado', 409);
  const visto = jaAplicado(c, bipeId); if (visto) { const it = c.itens[visto.cod] || c.fora[visto.cod] || null; return { resultado: visto.resultado, item: it, repetido: true }; }
  cod = String(cod || '').trim(); lote = String(lote || '').trim().toUpperCase().slice(0, 30);
  quant = +quant || 0; emb = +emb || 1; const un = +(quant * emb).toFixed(3);
  if (!cod || !quant) throw erro('código e quantidade obrigatórios');
  if (!lote) return { resultado: 'sem_lote', item: null };               // nada é somado sem lote
  // bipou a caixa (DUN-14) e o pedido está no código da unidade: usa o vínculo caixa → unidade do Pedidos do CD
  if (!c.pedido[cod] && deps.vinculo) { const v = await deps.vinculo(cod); if (v && v.cod && c.pedido[v.cod]) { if (quant && emb === 1 && +v.emb > 1) { emb = +v.emb; } cod = v.cod; } }
  const unFinal = +(quant * emb).toFixed(3);
  const p = c.pedido[cod]; const cad = deps.cadastro ? await deps.cadastro(cod) : null;
  const descricao = p ? p.descricao : (cad ? cad.descricao : cod);
  let resultado;
  if (!p) {
    const f = c.fora[cod] || (c.fora[cod] = { cod, descricao, un: 0, quant: 0, emb, lotes: [], estado: 'fora' });
    f.un = +(f.un + unFinal).toFixed(3); f.quant = +(f.quant + quant).toFixed(3); f.emb = emb; addLote(f, lote, quant, unFinal);
    f.por = nome || c.nome; f.em = agora().toISOString(); resultado = 'fora_do_pedido'; marcarAplicado(c, bipeId, resultado, cod); salvar(c); return { resultado, item: f };
  }
  const it = c.itens[cod] || (c.itens[cod] = { cod, descricao, un: 0, quant: 0, emb, lotes: [], estado: 'diferente', bipagens: 0 });
  it.bipagens++; it.un = +(it.un + unFinal).toFixed(3); it.quant = +(it.quant + quant).toFixed(3); it.emb = emb; addLote(it, lote, quant, unFinal);
  it.por = nome || c.nome; it.em = agora().toISOString(); reavaliar(c, it);
  resultado = it.estado === 'ok' ? 'ok' : 'qtd_diferente';
  marcarAplicado(c, bipeId, resultado, cod); salvar(c); return { resultado, item: it };
}
function addLote(it, lote, quant, un) { const l = it.lotes.find(x => x.lote === lote); if (l) { l.quant = +(l.quant + quant).toFixed(3); l.un = +(l.un + un).toFixed(3); } else it.lotes.push({ lote, quant, un }); }

/** "Tirar da coletagem": baixa `quant` (em caixas/emb do item; sem quant = tudo) de um item ou de um fora do pedido.
 *  Sempre grava evento tirar_coletagem — pendência "verificar pallet" pro fiscal do CD. */
function tirar(id, { cod, quant, lote, motivo, nome }) {
  const c = obter(id); if (!c) throw erro('Conferência não encontrada', 404); if (c.status === 'fechada') throw erro('Pedido já fechado', 409);
  cod = String(cod || '').trim(); lote = String(lote || '').trim().toUpperCase();
  const fora = !!c.fora[cod]; const it = fora ? c.fora[cod] : c.itens[cod]; if (!it) throw erro('Item não bipado');
  const q = +quant > 0 ? +quant : null;
  const antes = it.un;
  const alvo = lote ? it.lotes.find(l => l.lote === lote) : null;
  if (lote && !alvo) throw erro('Lote não bipado neste item');
  const baixaQuant = q != null ? Math.min(q, alvo ? alvo.quant : it.quant) : (alvo ? alvo.quant : it.quant);
  const baixaUn = +(baixaQuant * it.emb).toFixed(3);
  if (alvo) { alvo.quant = +(alvo.quant - baixaQuant).toFixed(3); alvo.un = +(alvo.un - baixaUn).toFixed(3); if (alvo.quant <= 0) it.lotes = it.lotes.filter(l => l !== alvo); }
  else if (q == null) it.lotes = [];
  else { let resta = baixaQuant; for (const l of it.lotes) { const b = Math.min(resta, l.quant); l.quant = +(l.quant - b).toFixed(3); l.un = +(l.un - b * it.emb).toFixed(3); resta -= b; if (resta <= 0) break; } it.lotes = it.lotes.filter(l => l.quant > 0); }
  it.quant = +(it.quant - baixaQuant).toFixed(3); it.un = +(it.un - baixaUn).toFixed(3);
  if (it.un <= 0.0005) { if (fora) delete c.fora[cod]; else delete c.itens[cod]; } else if (!fora) reavaliar(c, it);
  const ev = { tipo: 'tirar_coletagem', em: agora().toISOString(), nome: String(nome || c.nome).toUpperCase().slice(0, 20), cod, descricao: it.descricao, fora, lote: lote || null,
    quant: baixaQuant, un: baixaUn, antes, depois: +(antes - baixaUn).toFixed(3), motivo: String(motivo || '').slice(0, 120), verificado: null };
  c.eventos.push(ev); salvar(c); return { evento: ev, item: it.un > 0.0005 ? it : null };
}

/** Terminei: só fecha 100 %. Devolve o que falta (sem quantidade) quando não fecha. */
function terminei(id, { nome } = {}) {
  const c = obter(id); if (!c) throw erro('Conferência não encontrada', 404); if (c.status === 'fechada') return { fechou: true, pendentes: [], fora: [] };
  const pendentes = [];
  for (const p of Object.values(c.pedido)) { const b = c.itens[p.cod]; if (!b) pendentes.push({ cod: p.cod, descricao: p.descricao, motivo: 'nao_bipado' }); else if (b.estado !== 'ok') pendentes.push({ cod: p.cod, descricao: p.descricao, motivo: b.un > p.un ? 'a_mais' : 'a_menos' }); }
  const fora = Object.values(c.fora).map(f => ({ cod: f.cod, descricao: f.descricao, un: f.un }));
  c.tentativas = (c.tentativas || 0) + 1; c.termineiEm = agora().toISOString();
  const fechou = pendentes.length === 0 && fora.length === 0;
  if (fechou) { c.status = 'fechada'; c.fechadoEm = c.termineiEm; c.fechadoPor = String(nome || c.nome).toUpperCase().slice(0, 20); }
  salvar(c); return { fechou, pendentes, fora };
}

function verificarPallet(id, idx, nome) {
  const c = obter(id); if (!c) throw erro('Conferência não encontrada', 404); const ev = c.eventos[idx]; if (!ev || ev.tipo !== 'tirar_coletagem') throw erro('Evento não encontrado', 404);
  if (!ev.verificado) ev.verificado = { nome: String(nome || '').toUpperCase().slice(0, 20), em: agora().toISOString() }; salvar(c); return ev;
}

/** Visão pro coletor: nunca leva a quantidade do pedido. */
function visao(id) {
  const c = obter(id); if (!c) return null; const itens = Object.values(c.itens); const fora = Object.values(c.fora);
  return { id: c.id, nPedido: c.nPedido, cliente: c.cliente, status: c.status, produtos_pedido: Object.keys(c.pedido).length, produtos: itens.length, unidades: +itens.reduce((a, i) => a + i.un, 0).toFixed(3),
    itens: itens.map(i => ({ cod: i.cod, descricao: i.descricao, quant: i.quant, emb: i.emb, un: i.un, lotes: i.lotes, estado: i.estado })),
    fora: fora.map(f => ({ cod: f.cod, descricao: f.descricao, quant: f.quant, emb: f.emb, un: f.un, lotes: f.lotes })),
    tirados: c.eventos.filter(e => e.tipo === 'tirar_coletagem').length, tentativas: c.tentativas || 0 };
}

/** Pendências "verificar pallet" (retaguarda), últimos n dias. */
function pendenciasVerificacao(n = 7) {
  const out = [];
  for (const d of dias(n)) for (const c of listarDia(d)) c.eventos.forEach((e, idx) => { if (e.tipo === 'tirar_coletagem') out.push({ id: c.id, idx, nPedido: c.nPedido, cliente: c.cliente, status: c.status, ...e }); });
  return out.sort((a, b) => (a.verificado ? 1 : 0) - (b.verificado ? 1 : 0) || b.em.localeCompare(a.em));
}

/** Saídas por lote (pra tela "Lotes no CD"): [{cod, descricao, lote, un, nPedido, cliente, em}] das conferências fechadas. */
function saidasPorLote(n = 60) {
  const out = [];
  for (const d of dias(n)) for (const c of listarDia(d)) if (c.status === 'fechada') for (const it of Object.values(c.itens)) for (const l of it.lotes) out.push({ cod: it.cod, descricao: it.descricao, lote: l.lote, un: l.un, quant: l.quant, emb: it.emb, nPedido: c.nPedido, cliente: c.cliente, em: c.fechadoEm });
  return out;
}

module.exports = { init, hojeStr, validarId, obter, salvar, listarDia, acharPorPedido, abrirPedido, bipar, tirar, terminei, verificarPallet, visao, pendenciasVerificacao, saidasPorLote, LOJA_CD };
