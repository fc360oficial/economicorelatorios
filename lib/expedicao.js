// lib/expedicao.js — conferência CEGA de saída do CD (loja 10): o pedido do Televendas é a verdade.
// Spec: docs/superpowers/specs/2026-09-29-coletor-cd-expedicao-processo.md
//  - desde 14/10/26 a saída tem DUAS etapas cegas em sequência (Tiago): 1 separação (monta o pallet) → 2 expedição
//    (entra no caminhão). As duas comparam com o pedido e só fecham 100 %. Quem separou NÃO pode expedir o mesmo
//    pedido: a trava é aqui (operador com PIN pessoal, cadastrado na retaguarda), não só na tela.
//  - avisa NA HORA (sem revelar a qtd do pedido): 'qtd_diferente' | 'fora_do_pedido' | 'sem_lote'
//  - o pedido nunca muda pelo app: a menos → bipa o certo; a mais / fora → "tirar da coletagem"
//  - todo "tirar" vira evento tirar_coletagem (pendência "verificar pallet" pro fiscal do CD); lote diferente
//    entre separação e expedição vira evento lote_divergente (aviso pro fiscal, não trava)
// Estado em data/expedicao/AAAA-MM-DD.json (um arquivo por dia, id → conferência). Conferência gravada antes de 14/10
// (sem `etapas`) continua no modelo de uma etapa só. Operadores do CD em data/expedicao/operadores.json.
// ERP é espelho (expedicao-erp.js).
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
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

// ── operadores do CD (PIN pessoal) ─────────────────────────────────────────
// data/expedicao/operadores.json = { operadores: [{ id, nome, pin, ativo, criadoEm }], sessoes: { token: { id, em } } }
const ARQ_OPS = () => path.join(DIR, 'operadores.json');
const DIAS_SESSAO = 120;
function lerOps() { try { const j = JSON.parse(fs.readFileSync(ARQ_OPS(), 'utf8')); return { operadores: j.operadores || [], sessoes: j.sessoes || {} }; } catch { return { operadores: [], sessoes: {} }; } }
function gravarOps(o) { const tmp = ARQ_OPS() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o, null, 1)); fs.renameSync(tmp, ARQ_OPS()); }
const opPublico = o => ({ id: o.id, nome: o.nome });
/** Lista pra retaguarda (com PIN: só quem tem sessão da central vê). */
function operadores() { if (!DIR) return []; return lerOps().operadores.slice().sort((a, b) => (b.ativo ? 1 : 0) - (a.ativo ? 1 : 0) || a.nome.localeCompare(b.nome)); }
function temOperadores() { return operadores().some(o => o.ativo); }
/** Cria ou edita um operador. PIN de 4 dígitos, único entre os ativos. */
function salvarOperador({ id, nome, pin, ativo = true }) {
  if (!DIR) throw erro('expedição não iniciada', 500);
  const o = lerOps(); nome = String(nome || '').trim().toUpperCase().slice(0, 20); pin = String(pin || '').trim();
  if (!nome) throw erro('Nome do operador obrigatório');
  if (!/^\d{4}$/.test(pin)) throw erro('PIN pessoal tem que ter 4 dígitos');
  const outro = o.operadores.find(x => x.pin === pin && x.ativo !== false && x.id !== id); if (outro && ativo !== false) throw erro('Este PIN já é de ' + outro.nome);
  let op = id ? o.operadores.find(x => x.id === id) : null;
  if (id && !op) throw erro('Operador não encontrado', 404);
  if (!op) { op = { id: 'op-' + crypto.randomBytes(4).toString('hex'), criadoEm: agora().toISOString() }; o.operadores.push(op); }
  Object.assign(op, { nome, pin, ativo: ativo !== false });
  if (!op.ativo) for (const [t, s] of Object.entries(o.sessoes)) if (s.id === op.id) delete o.sessoes[t];
  gravarOps(o); return { id: op.id, nome: op.nome, pin: op.pin, ativo: op.ativo, criadoEm: op.criadoEm };
}
/** Login por PIN pessoal: devolve { token, operador: { id, nome } } ou null. */
function entrarOperador(pin) {
  if (!DIR) return null;
  const o = lerOps(); const op = o.operadores.find(x => x.ativo !== false && x.pin === String(pin || '').trim()); if (!op) return null;
  const limite = agora().getTime() - DIAS_SESSAO * 864e5;
  for (const [t, s] of Object.entries(o.sessoes)) if (!s.em || new Date(s.em).getTime() < limite) delete o.sessoes[t];
  const token = crypto.randomBytes(16).toString('hex'); o.sessoes[token] = { id: op.id, em: agora().toISOString() }; gravarOps(o);
  return { token, operador: opPublico(op) };
}
function operadorPorToken(token) {
  if (!DIR || !/^[a-f0-9]{32}$/.test(String(token || ''))) return null;
  const o = lerOps(); const s = o.sessoes[token]; if (!s) return null;
  const op = o.operadores.find(x => x.id === s.id && x.ativo !== false); return op ? opPublico(op) : null;
}

// ── dedup por bipeId (fila offline do coletor reenvia) ─────────────────────
function jaAplicado(et, bipeId) { return bipeId && et.bipes_vistos ? et.bipes_vistos[bipeId] : null; }
function marcarAplicado(et, bipeId, resultado, cod) {
  if (!bipeId) return; et.bipes_vistos = et.bipes_vistos || {}; et.bipes_vistos[bipeId] = { resultado, cod };
  const ks = Object.keys(et.bipes_vistos); if (ks.length > LIMITE_BIPES_VISTOS) for (const k of ks.slice(0, ks.length - LIMITE_BIPES_VISTOS)) delete et.bipes_vistos[k];
}

// ── etapas ──────────────────────────────────────────────────────────────────
const ETAPAS = ['separacao', 'expedicao'];
const novaEtapa = (etapa, operador) => ({ etapa, operador: operador ? opPublico(operador) : null, abertoEm: agora().toISOString(), itens: {}, fora: {}, tentativas: 0, fechadoEm: null, fechadoPor: null, bipes_vistos: {} });
const ehLegado = c => !c.etapas;
/** Etapa que recebe bipe agora: a própria conferência no modelo antigo; null quando está 'separada' (expedição ainda
 *  não aberta) ou 'fechada'. */
function etapaAtual(c) {
  if (ehLegado(c)) return c.status === 'fechada' ? null : c;
  if (c.status === 'separando') return c.etapas.separacao;
  if (c.status === 'expedindo') return c.etapas.expedicao;
  return null;
}
const separador = c => (!ehLegado(c) && c.etapas.separacao.operador) || null;
/** Trava do Tiago (14/10): quem fechou a separação não pode expedir o mesmo pedido. */
function travaOperador(c, operador) {
  const sep = separador(c); if (!sep) return;
  if (!operador) throw erro('Entre com o PIN pessoal pra fazer a expedição.', 403);
  if (operador.id === sep.id) { const e = erro('Quem separou não pode expedir este pedido. Separado por ' + sep.nome + '. Outra pessoa faz a conferência de saída.', 409); e.separadoPor = sep.nome; throw e; }
}
const itensSaida = c => ehLegado(c) ? c.itens : ((c.etapas.expedicao || {}).itens || {});

/** Abre (ou retoma) a conferência de saída de um pedido do Televendas.
 *  itens: [{ cod, descricao, qtd, qtdEmb, und, conversao }] como vêm de delivery_produtos. Conferido no ERP em
 *  29/09/26: `Qtd` JÁ É a quantidade em unidades do código do item (ex.: "4 FD c/27" vem Qtd=108, QtdEmb=0),
 *  então a comparação usa Qtd direto; QtdEmb/Conversao são só informativos (emb sugerida pro bipe).
 *  operador: { id, nome } do PIN pessoal. Retomar pedido 'separada' abre a etapa de expedição (com a trava). */
function abrirPedido({ nPedido, cliente, cnpj, nome, itens, total, operador }) {
  const ex = acharPorPedido(nPedido); if (ex) return retomar(ex, operador);
  const pedido = {};
  for (const i of itens || []) {
    const cod = String(i.cod || '').trim(); if (!cod) continue;
    const un = +(+i.qtd || 0).toFixed(3); const mConv = /c\/\s*(\d+)/i.exec(String(i.conversao || '')); const emb = +i.qtdEmb > 0 ? +i.qtdEmb : (mConv ? +mConv[1] : 1);
    if (pedido[cod]) pedido[cod].un = +(pedido[cod].un + un).toFixed(3);
    else pedido[cod] = { cod, descricao: String(i.descricao || '').trim(), un, emb, und: String(i.und || '').trim() };
  }
  const c = { id: `exp-${hojeStr()}-${LOJA_CD}-${String(nPedido).replace(/\D/g, '')}`, loja: LOJA_CD, nPedido: String(nPedido), cliente: String(cliente || '').slice(0, 45), cnpj: String(cnpj || ''), total: +total || 0,
    nome: String(nome || (operador && operador.nome) || '').toUpperCase().slice(0, 20), status: 'separando', abertoEm: agora().toISOString(), pedido,
    etapas: { separacao: novaEtapa('separacao', operador), expedicao: null }, eventos: [], erp: { nReg: null, erros: [] } };
  return salvar(c);
}
function retomar(c, operador) {
  if (ehLegado(c) || c.status === 'separando') return c;
  if (c.status === 'separada') { travaOperador(c, operador); c.etapas.expedicao = novaEtapa('expedicao', operador); c.status = 'expedindo'; return salvar(c); }
  if (c.status === 'expedindo') { travaOperador(c, operador); return c; }
  return c;
}

function reavaliar(c, it) { const p = c.pedido[it.cod]; it.estado = !p ? 'fora' : Math.abs(it.un - p.un) < 0.001 ? 'ok' : 'diferente'; }
function abrirEtapa(id, operador) {
  const c = obter(id); if (!c) throw erro('Conferência não encontrada', 404); if (c.status === 'fechada') throw erro('Pedido já conferido e fechado', 409);
  const et = etapaAtual(c); if (!et) throw erro('Separação fechada. Toque no pedido na lista pra abrir a expedição.', 409);
  if (et.etapa === 'expedicao') travaOperador(c, operador);
  return { c, et };
}

/** Bipe cego. Resposta imediata sem revelar a qtd do pedido. */
async function bipar(id, { cod, quant, emb, lote, nome, bipeId, operador }) {
  const { c, et } = abrirEtapa(id, operador);
  const visto = jaAplicado(et, bipeId); if (visto) { const it = et.itens[visto.cod] || et.fora[visto.cod] || null; return { resultado: visto.resultado, item: it, repetido: true }; }
  cod = String(cod || '').trim(); lote = String(lote || '').trim().toUpperCase().slice(0, 30);
  quant = +quant || 0; emb = +emb || 1;
  if (!cod || !quant) throw erro('código e quantidade obrigatórios');
  if (!lote) return { resultado: 'sem_lote', item: null };               // nada é somado sem lote
  // bipou a caixa (DUN-14) e o pedido está no código da unidade: usa o vínculo caixa → unidade do Pedidos do CD
  if (!c.pedido[cod] && deps.vinculo) { const v = await deps.vinculo(cod); if (v && v.cod && c.pedido[v.cod]) { if (quant && emb === 1 && +v.emb > 1) { emb = +v.emb; } cod = v.cod; } }
  const unFinal = +(quant * emb).toFixed(3);
  const p = c.pedido[cod]; const cad = deps.cadastro ? await deps.cadastro(cod) : null;
  const descricao = p ? p.descricao : (cad ? cad.descricao : cod);
  const por = String(nome || (operador && operador.nome) || c.nome).toUpperCase().slice(0, 20);
  let resultado;
  if (!p) {
    const f = et.fora[cod] || (et.fora[cod] = { cod, descricao, un: 0, quant: 0, emb, lotes: [], estado: 'fora' });
    f.un = +(f.un + unFinal).toFixed(3); f.quant = +(f.quant + quant).toFixed(3); f.emb = emb; addLote(f, lote, quant, unFinal);
    f.por = por; f.em = agora().toISOString(); resultado = 'fora_do_pedido'; marcarAplicado(et, bipeId, resultado, cod); salvar(c); return { resultado, item: f };
  }
  const it = et.itens[cod] || (et.itens[cod] = { cod, descricao, un: 0, quant: 0, emb, lotes: [], estado: 'diferente', bipagens: 0 });
  it.bipagens++; it.un = +(it.un + unFinal).toFixed(3); it.quant = +(it.quant + quant).toFixed(3); it.emb = emb; addLote(it, lote, quant, unFinal);
  it.por = por; it.em = agora().toISOString(); reavaliar(c, it);
  resultado = it.estado === 'ok' ? 'ok' : 'qtd_diferente';
  marcarAplicado(et, bipeId, resultado, cod); salvar(c); return { resultado, item: it };
}
function addLote(it, lote, quant, un) { const l = it.lotes.find(x => x.lote === lote); if (l) { l.quant = +(l.quant + quant).toFixed(3); l.un = +(l.un + un).toFixed(3); } else it.lotes.push({ lote, quant, un }); }

/** "Tirar da coletagem": baixa `quant` (em caixas/emb do item; sem quant = tudo) de um item ou de um fora do pedido.
 *  Sempre grava evento tirar_coletagem — pendência "verificar pallet" pro fiscal do CD. */
function tirar(id, { cod, quant, lote, motivo, nome, operador }) {
  const { c, et } = abrirEtapa(id, operador);
  cod = String(cod || '').trim(); lote = String(lote || '').trim().toUpperCase();
  const fora = !!et.fora[cod]; const it = fora ? et.fora[cod] : et.itens[cod]; if (!it) throw erro('Item não bipado');
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
  if (it.un <= 0.0005) { if (fora) delete et.fora[cod]; else delete et.itens[cod]; } else if (!fora) reavaliar(c, it);
  const ev = { tipo: 'tirar_coletagem', etapa: ehLegado(c) ? null : et.etapa, em: agora().toISOString(), nome: String(nome || (operador && operador.nome) || c.nome).toUpperCase().slice(0, 20), cod, descricao: it.descricao, fora, lote: lote || null,
    quant: baixaQuant, un: baixaUn, antes, depois: +(antes - baixaUn).toFixed(3), motivo: String(motivo || '').slice(0, 120), verificado: null };
  c.eventos.push(ev); salvar(c); return { evento: ev, item: it.un > 0.0005 ? it : null };
}

/** Lote diferente entre o que a separação montou e o que a expedição embarcou (mesmo código): aviso pro fiscal, não trava. */
function divergenciasLote(c) {
  const out = []; const sep = c.etapas.separacao.itens, exp = c.etapas.expedicao.itens;
  const mapa = it => Object.fromEntries((it.lotes || []).filter(l => l.un > 0).map(l => [l.lote, l.un]));
  for (const cod of Object.keys(c.pedido)) {
    const a = sep[cod] ? mapa(sep[cod]) : {}, b = exp[cod] ? mapa(exp[cod]) : {};
    const lotes = new Set([...Object.keys(a), ...Object.keys(b)]); let dif = false;
    for (const l of lotes) if (Math.abs((a[l] || 0) - (b[l] || 0)) > 0.001) { dif = true; break; }
    if (dif) out.push({ cod, descricao: (exp[cod] || sep[cod] || c.pedido[cod]).descricao, separacao: Object.entries(a).map(([lote, un]) => ({ lote, un })), expedicao: Object.entries(b).map(([lote, un]) => ({ lote, un })) });
  }
  return out;
}

/** Terminei: só fecha 100 %. Devolve o que falta (sem quantidade) quando não fecha.
 *  Separação fechada → status 'separada' (pedido volta pra lista como "Expedir"); expedição fechada → 'fechada'. */
function terminei(id, { nome, operador } = {}) {
  const c0 = obter(id); if (!c0) throw erro('Conferência não encontrada', 404);
  const etapaNome = ehLegado(c0) ? 'unica' : (etapaAtual(c0) || {}).etapa || null;
  if (c0.status === 'fechada') return { fechou: true, pendentes: [], fora: [], etapa: etapaNome, status: c0.status, proxima: null };
  const { c, et } = abrirEtapa(id, operador);   // mesma instância: o que muda em `et` é salvo com `c`
  const pendentes = [];
  for (const p of Object.values(c.pedido)) { const b = et.itens[p.cod]; if (!b) pendentes.push({ cod: p.cod, descricao: p.descricao, motivo: 'nao_bipado' }); else if (b.estado !== 'ok') pendentes.push({ cod: p.cod, descricao: p.descricao, motivo: b.un > p.un ? 'a_mais' : 'a_menos' }); }
  const fora = Object.values(et.fora).map(f => ({ cod: f.cod, descricao: f.descricao, un: f.un }));
  const quando = agora().toISOString(); const quem = String(nome || (operador && operador.nome) || c.nome).toUpperCase().slice(0, 20);
  et.tentativas = (et.tentativas || 0) + 1; et.termineiEm = quando;
  const fechou = pendentes.length === 0 && fora.length === 0;
  let proxima = null;
  if (fechou) {
    et.fechadoEm = quando; et.fechadoPor = quem; if (operador && !et.operador) et.operador = opPublico(operador);
    if (ehLegado(c) || et.etapa === 'expedicao') {
      c.status = 'fechada'; c.fechadoEm = quando; c.fechadoPor = quem;
      if (!ehLegado(c)) for (const d of divergenciasLote(c)) c.eventos.push({ tipo: 'lote_divergente', etapa: 'expedicao', em: quando, nome: quem, verificado: null, ...d });
    } else { c.status = 'separada'; proxima = 'expedicao'; }
  }
  if (ehLegado(c)) c.tentativas = et.tentativas;
  salvar(c); return { fechou, pendentes, fora, etapa: etapaNome, status: c.status, proxima };
}

function verificarPallet(id, idx, nome) {
  const c = obter(id); if (!c) throw erro('Conferência não encontrada', 404); const ev = c.eventos[idx]; if (!ev || (ev.tipo !== 'tirar_coletagem' && ev.tipo !== 'lote_divergente')) throw erro('Evento não encontrado', 404);
  if (!ev.verificado) ev.verificado = { nome: String(nome || '').toUpperCase().slice(0, 20), em: agora().toISOString() }; salvar(c); return ev;
}

const resumoEtapa = et => et ? { operador: et.operador, abertoEm: et.abertoEm, fechadoEm: et.fechadoEm, fechadoPor: et.fechadoPor, tentativas: et.tentativas || 0, produtos: Object.keys(et.itens || {}).length } : null;
/** Quem fez cada etapa (retaguarda e coletor). Modelo antigo: tudo numa etapa 'unica'. */
function etapasDe(c) {
  if (ehLegado(c)) return { modelo: 'unica', separacao: null, expedicao: { operador: null, abertoEm: c.abertoEm, fechadoEm: c.fechadoEm || null, fechadoPor: c.fechadoPor || null, tentativas: c.tentativas || 0, produtos: Object.keys(c.itens || {}).length } };
  return { modelo: 'duas', separacao: resumoEtapa(c.etapas.separacao), expedicao: resumoEtapa(c.etapas.expedicao) };
}

/** Visão pro coletor: nunca leva a quantidade do pedido, nem o que a OUTRA etapa bipou. */
function visao(id, operador) {
  const c = obter(id); if (!c) return null; const et = etapaAtual(c); const itens = et ? Object.values(et.itens) : []; const fora = et ? Object.values(et.fora) : [];
  const sep = separador(c);
  return { id: c.id, nPedido: c.nPedido, cliente: c.cliente, status: c.status, etapa: ehLegado(c) ? 'unica' : (et ? et.etapa : (c.status === 'separada' ? 'expedicao' : null)),
    separadoPor: sep ? sep.nome : (!ehLegado(c) && c.etapas.separacao.fechadoPor) || null, expedidoPor: (!ehLegado(c) && c.etapas.expedicao && c.etapas.expedicao.fechadoPor) || null,
    souSeparador: !!(sep && operador && sep.id === operador.id),
    produtos_pedido: Object.keys(c.pedido).length, produtos: itens.length, unidades: +itens.reduce((a, i) => a + i.un, 0).toFixed(3),
    itens: itens.map(i => ({ cod: i.cod, descricao: i.descricao, quant: i.quant, emb: i.emb, un: i.un, lotes: i.lotes, estado: i.estado })),
    fora: fora.map(f => ({ cod: f.cod, descricao: f.descricao, quant: f.quant, emb: f.emb, un: f.un, lotes: f.lotes })),
    tirados: c.eventos.filter(e => e.tipo === 'tirar_coletagem' && (!et || ehLegado(c) || e.etapa === et.etapa)).length, tentativas: et ? (et.tentativas || 0) : (c.tentativas || 0) };
}

/** Pendências do fiscal do CD (retaguarda), últimos n dias: "verificar pallet" (tirar_coletagem) e lote divergente. */
function pendenciasVerificacao(n = 7) {
  const out = [];
  for (const d of dias(n)) for (const c of listarDia(d)) c.eventos.forEach((e, idx) => { if (e.tipo === 'tirar_coletagem' || e.tipo === 'lote_divergente') out.push({ id: c.id, idx, nPedido: c.nPedido, cliente: c.cliente, status: c.status, ...e }); });
  return out.sort((a, b) => (a.verificado ? 1 : 0) - (b.verificado ? 1 : 0) || b.em.localeCompare(a.em));
}

/** Saídas por lote (pra tela "Lotes no CD"): o que de fato saiu = itens da EXPEDIÇÃO das conferências fechadas. */
function saidasPorLote(n = 60) {
  const out = [];
  for (const d of dias(n)) for (const c of listarDia(d)) if (c.status === 'fechada') for (const it of Object.values(itensSaida(c))) for (const l of it.lotes) out.push({ cod: it.cod, descricao: it.descricao, lote: l.lote, un: l.un, quant: l.quant, emb: it.emb, nPedido: c.nPedido, cliente: c.cliente, em: c.fechadoEm });
  return out;
}

module.exports = { init, hojeStr, validarId, obter, salvar, listarDia, acharPorPedido, abrirPedido, bipar, tirar, terminei, verificarPallet, visao, pendenciasVerificacao, saidasPorLote, LOJA_CD,
  etapaAtual, etapasDe, itensSaida, separador, operadores, temOperadores, salvarOperador, entrarOperador, operadorPorToken, ETAPAS };
