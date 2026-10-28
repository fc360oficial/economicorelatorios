// lib/expedicao.js — saída do CD (loja 10) em duas etapas: o pedido do Televendas é a verdade.
// Spec: docs/superpowers/specs/2026-09-29-coletor-cd-expedicao-processo.md
//  - desde 14/10/26 (Tiago) a saída tem DUAS etapas: 1 SEPARAÇÃO DE PEDIDOS (chave 'separacao') → 2 CARREGAMENTO DE
//    CAMINHÃO (chave 'expedicao'). Quem separou NÃO pode carregar o mesmo pedido: a trava é aqui (operador com PIN
//    pessoal, cadastrado na retaguarda), não só na tela.
//  - Separação (Tiago, 14/10 à noite): NÃO é cega. O separador vê a lista do pedido (descrição, quantidade, 4 últimos
//    dígitos do EAN), toca no item e digita a quantidade separada (`separar`, grava o total do item). Bipe de produto
//    que não está no pedido dá erro na hora e não entra. Lote é opcional nessa etapa.
//    Terminei 100 % → 'separada'. Com divergência, o separador manda pro FISCAL DO CD ('aguardando_fiscal'), que na
//    retaguarda libera pro carregamento (status 'separada', carregamento bate com o que foi separado) ou devolve
//    pra separação ('separando', com a observação).
//  - Carregamento: cego, outra pessoa, compara com O QUE A SEPARAÇÃO REGISTROU (não com o pedido) e só fecha 100 %.
//    Avisa NA HORA sem revelar quantidade: 'qtd_diferente' | 'fora_do_pedido' | 'sem_lote'. Lote obrigatório (é o
//    que de fato saiu: alimenta Lotes no CD e o espelho no ERP).
//  - todo "tirar" vira evento tirar_coletagem (pendência "verificar pallet" pro fiscal do CD); lote diferente
//    entre separação e carregamento vira evento lote_divergente (aviso pro fiscal, não trava)
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
// chaves internas ficam 'separacao'/'expedicao' (dados gravados); os nomes que o CD usa são estes (Tiago, 14/10)
const ETAPAS = ['separacao', 'expedicao'];
const ROTULOS = { separacao: 'Separação de Pedidos', expedicao: 'Carregamento de Caminhão', unica: 'Conferência de saída' };
const novaEtapa = (etapa, operador) => ({ etapa, operador: operador ? opPublico(operador) : null, abertoEm: agora().toISOString(), itens: {}, fora: {}, tentativas: 0, fechadoEm: null, fechadoPor: null, bipes_vistos: {} });
const ehLegado = c => !c.etapas;
/** Etapa que recebe bipe agora: a própria conferência no modelo antigo; null quando está 'separada' (carregamento
 *  ainda não aberto), 'aguardando_fiscal' ou 'fechada'. */
function etapaAtual(c) {
  if (ehLegado(c)) return c.status === 'fechada' ? null : c;
  if (c.status === 'separando') return c.etapas.separacao;
  if (c.status === 'expedindo') return c.etapas.expedicao;
  return null;
}
const separador = c => (!ehLegado(c) && c.etapas.separacao.operador) || null;
/** Trava do Tiago (14/10): quem fechou a separação não pode carregar o mesmo pedido. */
function travaOperador(c, operador) {
  const sep = separador(c); if (!sep) return;
  if (!operador) throw erro('Entre com o PIN pessoal pra fazer o carregamento.', 403);
  if (operador.id === sep.id) { const e = erro('Quem separou não pode carregar este pedido. Separado por ' + sep.nome + '. Outra pessoa faz a conferência do caminhão.', 409); e.separadoPor = sep.nome; throw e; }
}
const itensSaida = c => ehLegado(c) ? c.itens : ((c.etapas.expedicao || {}).itens || {});
/** Com o que a etapa compara: separação (e modelo antigo) → o pedido; carregamento → o que a SEPARAÇÃO registrou
 *  (o fiscal pode ter liberado uma separação parcial: o caminhão tem que bater com o pallet, não com o pedido). */
function referencia(c, et) {
  if (ehLegado(c) || et.etapa === 'separacao') return c.pedido;
  const ref = {};
  for (const it of Object.values(c.etapas.separacao.itens || {})) if (it.un > 0.0005) ref[it.cod] = { cod: it.cod, descricao: it.descricao, un: it.un, emb: it.emb };
  return ref;
}
const ean4 = cod => String(cod || '').replace(/[^0-9]/g, '').slice(-4);
const itensPedido = c => Object.values(c.pedido).sort((a, b) => (a.ordem || 0) - (b.ordem || 0));

/** Abre (ou retoma) a conferência de saída de um pedido do Televendas.
 *  itens: [{ cod, descricao, qtd, qtdEmb, und, conversao }] como vêm de delivery_produtos. Conferido no ERP de produção
 *  em 14/10/26 (pedidos 7222/7223, Tiago: "tem pedido com 0 e com 10… verificar tudo antes"): `Qtd` vem NA UNIDADE DA
 *  LINHA (`Und`). Und=UN → Qtd em unidades, código EAN-13 (ex.: ALA 400G Qtd=54, "2 CX c/27"). Und=CX/FD/… → Qtd em
 *  CAIXAS, código DUN-14 da caixa, QtdEmb = unidades por caixa (ex.: PAPEL HIG. FD Qtd=4, QtdEmb=16 → 64 un).
 *  (A nota de 29/09 "Qtd já é em unidades" valia só pra linha em UN.) Aqui tudo vira UNIDADES (`un`) pra comparar;
 *  `qtd`/`und`/`emb` guardam a forma do pedido (4 FD c/16) pra mostrar como na folha de separação.
 *  operador: { id, nome } do PIN pessoal. Retomar pedido 'separada' abre a etapa de carregamento (com a trava). */
function abrirPedido({ nPedido, cliente, cnpj, nome, itens, total, operador }) {
  const ex = acharPorPedido(nPedido); if (ex) return retomar(ex, operador);
  const pedido = {};
  for (const i of itens || []) {
    const cod = String(i.cod || '').trim(); if (!cod) continue;
    const qtd = +(+i.qtd || 0).toFixed(3); const qtdEmb = +i.qtdEmb > 0 ? +i.qtdEmb : 0; const mConv = /c\/\s*(\d+)/i.exec(String(i.conversao || '')); const emb = qtdEmb > 0 ? qtdEmb : (mConv ? +mConv[1] : 1);
    // Qtd é em CAIXAS só quando a linha não é UN E tem QtdEmb > 0 (ex.: FD Qtd 4 QtdEmb 16). Linha FD com QtdEmb 0 e
    // "14 FD c/12" (FREDAO LEITE DE COCO, pedido 7218, Qtd 168) é em UNIDADES: a conversão ali é só informativa.
    const und = String(i.und || '').trim().toUpperCase(); const emCaixa = und !== '' && und !== 'UN' && qtdEmb > 0;
    const un = emCaixa ? +(qtd * emb).toFixed(3) : qtd;
    if (pedido[cod]) { pedido[cod].un = +(pedido[cod].un + un).toFixed(3); pedido[cod].qtd = +(pedido[cod].qtd + qtd).toFixed(3); }
    else pedido[cod] = { cod, descricao: String(i.descricao || '').trim(), un, qtd, emb, qtdEmb, und, emCaixa, ordem: Object.keys(pedido).length };   // ordem = a do pedido (chave numérica sai da ordem no objeto)
  }
  const c = { id: `exp-${hojeStr()}-${LOJA_CD}-${String(nPedido).replace(/\D/g, '')}`, loja: LOJA_CD, nPedido: String(nPedido), cliente: String(cliente || '').slice(0, 45), cnpj: String(cnpj || ''), total: +total || 0,
    nome: String(nome || (operador && operador.nome) || '').toUpperCase().slice(0, 20), status: 'separando', abertoEm: agora().toISOString(), pedido,
    etapas: { separacao: novaEtapa('separacao', operador), expedicao: null }, eventos: [], erp: { nReg: null, erros: [] } };
  return salvar(c);
}
function retomar(c, operador) {
  if (ehLegado(c) || c.status === 'separando' || c.status === 'aguardando_fiscal') return c;
  if (c.status === 'separada') { travaOperador(c, operador); c.etapas.expedicao = novaEtapa('expedicao', operador); c.status = 'expedindo'; return salvar(c); }
  if (c.status === 'expedindo') { travaOperador(c, operador); return c; }
  if (c.status === 'conferida') throw erro('Carregamento conferido 100 %. Aguardando o fiscal do CD liberar a saída na retaguarda.', 409);
  return c;
}

function reavaliar(c, et, it) { const p = referencia(c, et)[it.cod]; it.estado = !p ? 'fora' : Math.abs(it.un - p.un) < 0.001 ? 'ok' : 'diferente'; }
function abrirEtapa(id, operador) {
  const c = obter(id); if (!c) throw erro('Conferência não encontrada', 404); if (c.status === 'fechada') throw erro('Pedido já conferido e fechado', 409);
  if (c.status === 'aguardando_fiscal') throw erro('Separação com divergência: aguardando o fiscal do CD liberar ou devolver.', 409);
  if (c.status === 'conferida') throw erro('Carregamento conferido 100 %: aguardando o fiscal do CD liberar a saída.', 409);
  const et = etapaAtual(c); if (!et) throw erro('Separação fechada. Toque no pedido na lista pra abrir o carregamento.', 409);
  if (et.etapa === 'expedicao') travaOperador(c, operador);
  return { c, et };
}
/** Código bipado → código da referência da etapa (caixa DUN-14 vinculada cai no código da unidade do pedido). */
async function resolverCod(ref, cod, emb, quant) {
  if (!ref[cod] && deps.vinculo) { const v = await deps.vinculo(cod); if (v && v.cod && ref[v.cod]) { if (quant && emb === 1 && +v.emb > 1) emb = +v.emb; cod = v.cod; } }
  return { cod, emb };
}

/** Bipe cego (carregamento; a separação também aceita, somando). Resposta imediata sem revelar a quantidade. */
async function bipar(id, { cod, quant, emb, lote, nome, bipeId, operador }) {
  const { c, et } = abrirEtapa(id, operador);
  const visto = jaAplicado(et, bipeId); if (visto) { const it = et.itens[visto.cod] || et.fora[visto.cod] || null; return { resultado: visto.resultado, item: it, repetido: true }; }
  cod = String(cod || '').trim(); lote = String(lote || '').trim().toUpperCase().slice(0, 30);
  quant = +quant || 0; emb = +emb || 1;
  if (!cod || !quant) throw erro('código e quantidade obrigatórios');
  if (!lote) return { resultado: 'sem_lote', item: null };               // nada é somado sem lote
  const ref = referencia(c, et);
  ({ cod, emb } = await resolverCod(ref, cod, emb, quant));
  const unFinal = +(quant * emb).toFixed(3);
  const p = ref[cod]; const cad = p ? null : (c.pedido[cod] || (deps.cadastro ? await deps.cadastro(cod) : null));
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
  it.por = por; it.em = agora().toISOString(); reavaliar(c, et, it);
  resultado = it.estado === 'ok' ? 'ok' : 'qtd_diferente';
  marcarAplicado(et, bipeId, resultado, cod); salvar(c); return { resultado, item: it };
}
function addLote(it, lote, quant, un) { const l = it.lotes.find(x => x.lote === lote); if (l) { l.quant = +(l.quant + quant).toFixed(3); l.un = +(l.un + un).toFixed(3); } else it.lotes.push({ lote, quant, un }); }

/** Separação de Pedidos (com lista): acha o produto bipado/tocado no pedido. { item } com o que já foi separado, ou
 *  { fora: true, descricao } quando o produto NÃO está no pedido (erro na hora, nada é gravado). */
async function produto(id, cod, operador) {
  const { c, et } = abrirEtapa(id, operador); if (et.etapa !== 'separacao') throw erro('Só a Separação de Pedidos mostra a lista do pedido', 409);
  cod = String(cod || '').trim(); if (!cod) throw erro('código obrigatório');
  const r = await resolverCod(c.pedido, cod, 1, 1);
  const p = c.pedido[r.cod];
  if (!p) { const cad = deps.cadastro ? await deps.cadastro(cod) : null; return { fora: true, cod, descricao: cad ? cad.descricao : cod }; }
  // bipouCaixa: leu a caixa (DUN-14 vinculada) de uma linha em unidade → cada bipe vale `embBip` unidades
  return { fora: false, item: itemSeparacao(c, et, p, r.emb > 1 ? r.emb : null), bipouCaixa: r.cod !== cod, embBip: r.cod !== cod ? r.emb : 1 };
}
const itemSeparacao = (c, et, p, embCaixa) => { const s = et.itens[p.cod]; return { cod: p.cod, ean4: ean4(p.cod), descricao: p.descricao, un: p.un, qtd: p.qtd != null ? p.qtd : p.un, emCaixa: !!p.emCaixa, emb: embCaixa || p.emb, und: p.und, separado: s ? { un: s.un, quant: s.quant, emb: s.emb, soltas: s.soltas || 0, lotes: s.lotes, estado: s.estado } : null }; };

/** Separação de Pedidos: o separador toca no item e DIGITA a quantidade separada — grava o TOTAL do item (não soma).
 *  quant = caixas (× emb) e `soltas` = unidades avulsas (Tiago, 14/10: "hoje eu posso separar em caixas e em unidades").
 *  Total 0 limpa o item. Lote opcional. Produto fora do pedido → 'fora_do_pedido' sem gravar nada. */
async function separar(id, { cod, quant, emb, soltas, somar, lote, nome, bipeId, operador }) {
  const { c, et } = abrirEtapa(id, operador); if (et.etapa !== 'separacao') throw erro('Este pedido já está no carregamento', 409);
  const visto = jaAplicado(et, bipeId); if (visto) return { resultado: visto.resultado, item: et.itens[visto.cod] || null, repetido: true };
  cod = String(cod || '').trim(); lote = String(lote || '').trim().toUpperCase().slice(0, 30);
  quant = +quant || 0; emb = +emb || 1; soltas = Math.max(0, +soltas || 0);
  if (!cod) throw erro('código obrigatório');
  ({ cod, emb } = await resolverCod(c.pedido, cod, emb, quant));
  const p = c.pedido[cod];
  if (!p) { const cad = deps.cadastro ? await deps.cadastro(cod) : null; return { resultado: 'fora_do_pedido', item: null, descricao: cad ? cad.descricao : cod }; }
  const por = String(nome || (operador && operador.nome) || c.nome).toUpperCase().slice(0, 20);
  // somar (15/10, bipe repetido soma como nos coletores de mercado): quant/soltas deste bipe entram em cima do que já
  // tinha; a embalagem fica a do pedido quando a linha conta em caixas, senão vira tudo unidade solta.
  if (somar) {
    const a = et.itens[cod]; const embRef = p.emCaixa ? p.emb : 1;
    const totalUn = +((a ? a.un : 0) + quant * emb + soltas).toFixed(3);   // o que já tinha + o que este bipe acrescenta
    if (embRef === 1) { quant = 0; emb = 1; soltas = totalUn; }
    else { emb = embRef; quant = Math.floor(totalUn / embRef + 1e-9); soltas = +(totalUn - quant * embRef).toFixed(3); }
  }
  const unFinal = +(quant * emb + soltas).toFixed(3);
  if (unFinal <= 0) { delete et.itens[cod]; marcarAplicado(et, bipeId, 'limpo', cod); salvar(c); return { resultado: 'limpo', item: null, pedido: p }; }
  const it = et.itens[cod] || (et.itens[cod] = { cod, descricao: p.descricao, un: 0, quant: 0, emb, lotes: [], estado: 'diferente', bipagens: 0 });
  it.bipagens++; it.un = unFinal; it.quant = quant; it.emb = emb; it.soltas = soltas; it.lotes = lote ? [{ lote, quant, un: unFinal }] : [];
  it.por = por; it.em = agora().toISOString(); reavaliar(c, et, it);
  const resultado = it.estado === 'ok' ? 'ok' : 'qtd_diferente';
  marcarAplicado(et, bipeId, resultado, cod); salvar(c); return { resultado, item: it, pedido: p };
}

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
  if (it.un <= 0.0005) { if (fora) delete et.fora[cod]; else delete et.itens[cod]; } else if (!fora) reavaliar(c, et, it);
  const ev = { tipo: 'tirar_coletagem', etapa: ehLegado(c) ? null : et.etapa, em: agora().toISOString(), nome: String(nome || (operador && operador.nome) || c.nome).toUpperCase().slice(0, 20), cod, descricao: it.descricao, fora, lote: lote || null,
    quant: baixaQuant, un: baixaUn, antes, depois: +(antes - baixaUn).toFixed(3), motivo: String(motivo || '').slice(0, 120), verificado: null };
  c.eventos.push(ev); salvar(c); return { evento: ev, item: it.un > 0.0005 ? it : null };
}

/** Lote diferente entre o que a separação montou e o que o carregamento embarcou (mesmo código): aviso pro fiscal, não
 *  trava. Separação sem lote no item (lote é opcional nela) não gera divergência. */
function divergenciasLote(c) {
  const out = []; const sep = c.etapas.separacao.itens, exp = c.etapas.expedicao.itens;
  const mapa = it => Object.fromEntries((it.lotes || []).filter(l => l.un > 0).map(l => [l.lote, l.un]));
  for (const cod of Object.keys(c.pedido)) {
    const a = sep[cod] ? mapa(sep[cod]) : {}, b = exp[cod] ? mapa(exp[cod]) : {};
    if (!Object.keys(a).length) continue;
    const lotes = new Set([...Object.keys(a), ...Object.keys(b)]); let dif = false;
    for (const l of lotes) if (Math.abs((a[l] || 0) - (b[l] || 0)) > 0.001) { dif = true; break; }
    if (dif) out.push({ cod, descricao: (exp[cod] || sep[cod] || c.pedido[cod]).descricao, separacao: Object.entries(a).map(([lote, un]) => ({ lote, un })), expedicao: Object.entries(b).map(([lote, un]) => ({ lote, un })) });
  }
  return out;
}

/** Pendências da etapa contra a sua referência. Na separação (não é cega) vão as quantidades pedido × separado; no
 *  carregamento (cego) só o motivo. */
function pendenciasDe(c, et) {
  const ref = referencia(c, et); const aberta = !ehLegado(c) && et.etapa === 'separacao'; const pendentes = [];
  for (const p of (aberta ? itensPedido(c) : Object.values(ref))) {
    const b = et.itens[p.cod]; const motivo = !b ? 'nao_bipado' : b.estado === 'ok' ? null : (b.un > p.un ? 'a_mais' : 'a_menos'); if (!motivo) continue;
    const x = { cod: p.cod, descricao: p.descricao, motivo }; if (aberta) { x.ean4 = ean4(p.cod); x.pedido = p.un; x.separado = b ? b.un : 0; x.emb = p.emb; }
    pendentes.push(x);
  }
  const fora = Object.values(et.fora).map(f => ({ cod: f.cod, descricao: f.descricao, un: f.un }));
  return { pendentes, fora };
}

/** Terminei: só fecha 100 % contra a referência da etapa. Devolve o que falta quando não fecha.
 *  Separação fechada → 'separada' (pedido volta pra lista como "Carregar"); carregamento fechado → 'fechada'.
 *  Separação com divergência + enviarFiscal → 'aguardando_fiscal': o fiscal do CD decide na retaguarda. */
function terminei(id, { nome, operador, enviarFiscal, motivo } = {}) {
  const c0 = obter(id); if (!c0) throw erro('Conferência não encontrada', 404);
  const etapaNome = ehLegado(c0) ? 'unica' : (etapaAtual(c0) || {}).etapa || null;
  if (c0.status === 'fechada' || c0.status === 'conferida') return { fechou: true, pendentes: [], fora: [], etapa: etapaNome, status: c0.status, proxima: null };
  const { c, et } = abrirEtapa(id, operador);   // mesma instância: o que muda em `et` é salvo com `c`
  const { pendentes, fora } = pendenciasDe(c, et);
  const quando = agora().toISOString(); const quem = String(nome || (operador && operador.nome) || c.nome).toUpperCase().slice(0, 20);
  et.tentativas = (et.tentativas || 0) + 1; et.termineiEm = quando;
  const fechou = pendentes.length === 0 && fora.length === 0;
  let proxima = null, aguardandoFiscal = false;
  if (fechou) {
    et.fechadoEm = quando; et.fechadoPor = quem; if (operador && !et.operador) et.operador = opPublico(operador);
    if (ehLegado(c)) { c.status = 'fechada'; c.fechadoEm = quando; c.fechadoPor = quem; }
    else if (et.etapa === 'expedicao') {
      // Tiago (28/10): carregamento 100 % NÃO fecha sozinho. Fica 'conferida' até o fiscal do CD confrontar pedido ×
      // separado × carregado na retaguarda e liberar a saída (liberarSaida) — só aí fecha e espelha no ERP de teste.
      c.status = 'conferida'; c.conferidaEm = quando; c.conferidaPor = quem; c.avisoCarga = null;
      for (const d of divergenciasLote(c)) c.eventos.push({ tipo: 'lote_divergente', etapa: 'expedicao', em: quando, nome: quem, verificado: null, ...d });
    } else { c.status = 'separada'; proxima = 'expedicao'; }
  } else if (enviarFiscal && !ehLegado(c) && et.etapa === 'separacao') {
    if (fora.length) throw erro('Tire da coletagem o que não é do pedido antes de mandar pro fiscal.', 409);
    c.status = 'aguardando_fiscal'; aguardandoFiscal = true; c.avisoFiscal = null;
    c.liberacao = { pedidoEm: quando, pedidoPor: quem, motivo: String(motivo || '').slice(0, 160), pendentes, decisao: null, decididoPor: null, decididoEm: null, obs: null };
    c.eventos.push({ tipo: 'pedido_fiscal', etapa: 'separacao', em: quando, nome: quem, motivo: c.liberacao.motivo, pendentes: pendentes.length });
  }
  if (ehLegado(c)) c.tentativas = et.tentativas;
  salvar(c); return { fechou, pendentes, fora, etapa: etapaNome, status: c.status, proxima, aguardandoFiscal };
}

/** Fiscal do CD decide a separação com divergência: 'liberar' → separação fechada do jeito que está ('separada', o
 *  carregamento bate com o pallet) · 'devolver' → volta pra 'separando' com a observação pro separador. */
function decidirLiberacao(id, { decisao, nome, obs } = {}) {
  const c = obter(id); if (!c) throw erro('Conferência não encontrada', 404);
  if (c.status !== 'aguardando_fiscal') throw erro('Este pedido não está aguardando o fiscal', 409);
  if (decisao !== 'liberar' && decisao !== 'devolver') throw erro('decisão tem que ser liberar ou devolver');
  const quando = agora().toISOString(); const quem = String(nome || 'FISCAL').toUpperCase().slice(0, 20); obs = String(obs || '').slice(0, 200);
  const et = c.etapas.separacao; const sep = separador(c);
  if (decisao === 'liberar') {
    if (!Object.keys(et.itens).length) throw erro('Nada foi separado: não dá pra liberar um pallet vazio. Devolva pra separação.', 409);
    et.fechadoEm = quando; et.fechadoPor = et.fechadoPor || (sep ? sep.nome : c.nome); c.status = 'separada';
    Object.assign(c.liberacao, { decisao: 'liberada', decididoPor: quem, decididoEm: quando, obs });
  } else {
    c.status = 'separando'; Object.assign(c.liberacao, { decisao: 'devolvida', decididoPor: quem, decididoEm: quando, obs });
    c.avisoFiscal = { obs, nome: quem, em: quando };
  }
  c.eventos.push({ tipo: 'liberacao_fiscal', etapa: 'separacao', em: quando, nome: quem, decisao: c.liberacao.decisao, obs, pendentes: (c.liberacao.pendentes || []).length });
  salvar(c); return { id: c.id, nPedido: c.nPedido, status: c.status, liberacao: c.liberacao };
}

/** Separações aguardando o fiscal do CD (retaguarda), com pedido × separado item a item. */
function aguardandoFiscal(n = 7) {
  const out = [];
  for (const d of dias(n)) for (const c of listarDia(d)) if (c.status === 'aguardando_fiscal') {
    const et = c.etapas.separacao; const sep = separador(c);
    out.push({ id: c.id, nPedido: c.nPedido, cliente: c.cliente, separadoPor: sep ? sep.nome : c.nome, liberacao: c.liberacao,
      itens: itensPedido(c).map(p => itemSeparacao(c, et, p)).map(i => ({ ...i, diferenca: +((i.separado ? i.separado.un : 0) - i.un).toFixed(3) })) });
  }
  return out.sort((a, b) => String(a.liberacao.pedidoEm).localeCompare(String(b.liberacao.pedidoEm)));
}

/** Carregamentos fechados 100 % aguardando o fiscal do CD liberar a saída (Tiago, 28/10: "quando finalizasse tem que
 *  aparecer algo no fiscal pra eu confrontar se bateu mesmo e liberar"). Item a item: pedido × separado × carregado, com
 *  os lotes das duas etapas. Produto carregado fora do pedido não existe aqui (o carregamento só fecha 100 % contra a separação). */
function confronto(c) {
    const es = c.etapas.separacao, ex = c.etapas.expedicao || { itens: {} }; const sep = separador(c);
    const lotesDe = it => (it && it.lotes || []).filter(l => l.un > 0).map(l => ({ lote: l.lote, un: l.un }));
    const itens = itensPedido(c).map(p => { const s = es.itens[p.cod], x = ex.itens[p.cod]; const sUn = s ? s.un : 0, xUn = x ? x.un : 0;
      return { cod: p.cod, ean4: ean4(p.cod), descricao: p.descricao, und: p.und, qtd: p.qtd != null ? p.qtd : p.un, emb: p.emb, pedido: p.un, separado: sUn, carregado: xUn,
        difSeparado: +(sUn - p.un).toFixed(3), difCarregado: +(xUn - sUn).toFixed(3), lotesSep: lotesDe(s), lotesCarga: lotesDe(x),
        loteDiferente: c.eventos.some(e => e.tipo === 'lote_divergente' && e.cod === p.cod) }; });
    // separado a mais do que o pedido (não dá pra acontecer sem o fiscal ter liberado a separação com divergência), fica visível mesmo assim
    for (const s of Object.values(es.itens)) if (!c.pedido[s.cod] && s.un > 0.0005) { const x = ex.itens[s.cod]; itens.push({ cod: s.cod, ean4: ean4(s.cod), descricao: s.descricao, und: '', qtd: 0, emb: s.emb, pedido: 0, separado: s.un, carregado: x ? x.un : 0, difSeparado: s.un, difCarregado: +((x ? x.un : 0) - s.un).toFixed(3), lotesSep: lotesDe(s), lotesCarga: lotesDe(x), loteDiferente: false, foraDoPedido: true }); }
    return { id: c.id, nPedido: c.nPedido, cliente: c.cliente, cnpj: c.cnpj, total: c.total, status: c.status, fechadoEm: c.fechadoEm || null, fechadoPor: c.fechadoPor || null, saida: c.saida || null, espelhadoEm: (c.erp || {}).espelhadoEm || null, separadoPor: sep ? sep.nome : es.fechadoPor || c.nome, carregadoPor: (ex.operador || {}).nome || ex.fechadoPor || c.conferidaPor,
      separacaoFechadaEm: es.fechadoEm, conferidaEm: c.conferidaEm, tentativasSep: es.tentativas || 0, tentativasCarga: ex.tentativas || 0,
      liberacao: c.liberacao ? { decisao: c.liberacao.decisao, decididoPor: c.liberacao.decididoPor, obs: c.liberacao.obs, pendentes: (c.liberacao.pendentes || []).length } : null,
      reconferencias: (c.carregamentosAnteriores || []).length, tirados: c.eventos.filter(e => e.tipo === 'tirar_coletagem').map(e => ({ etapa: e.etapa, cod: e.cod, descricao: e.descricao, un: e.un, motivo: e.motivo, nome: e.nome, em: e.em, verificado: e.verificado })),
      itens, divergencias: itens.filter(i => i.difSeparado !== 0 || i.difCarregado !== 0 || i.loteDiferente).length };
}
function aguardandoSaida(n = 7) {
  const out = [];
  for (const d of dias(n)) for (const c of listarDia(d)) if (c.status === 'conferida') out.push(confronto(c));
  return out.sort((a, b) => String(a.conferidaEm).localeCompare(String(b.conferidaEm)));
}
/** Confronto de qualquer conferência (em andamento, conferida ou fechada) pra linha de "Pedidos na saída" abrir no Fiscal
 *  (Tiago, 28/10: "quando clico não abre nada pra eu ver a bipagem"). Modelo antigo (uma etapa): só o que foi bipado. */
function detalhe(id) {
  const c = obter(id); if (!c) return null;
  if (!ehLegado(c)) return confronto(c);
  const itens = itensPedido(c).map(p => { const x = (c.itens || {})[p.cod]; const xUn = x ? x.un : 0; return { cod: p.cod, ean4: ean4(p.cod), descricao: p.descricao, und: p.und, qtd: p.qtd != null ? p.qtd : p.un, emb: p.emb, pedido: p.un, separado: xUn, carregado: xUn, difSeparado: +(xUn - p.un).toFixed(3), difCarregado: 0, lotesSep: [], lotesCarga: (x && x.lotes || []).map(l => ({ lote: l.lote, un: l.un })), loteDiferente: false }; });
  return { id: c.id, nPedido: c.nPedido, cliente: c.cliente, status: c.status, fechadoEm: c.fechadoEm || null, fechadoPor: c.fechadoPor || null, saida: null, espelhadoEm: (c.erp || {}).espelhadoEm || null, separadoPor: c.nome, carregadoPor: c.fechadoPor || c.nome, separacaoFechadaEm: null, conferidaEm: c.fechadoEm || null, tentativasSep: 0, tentativasCarga: c.tentativas || 0, liberacao: null, reconferencias: 0, tirados: [], itens, divergencias: itens.filter(i => i.difSeparado !== 0).length, modeloUnico: true };
}

/** Fiscal do CD decide a saída do carregamento conferido: 'liberar' → 'fechada' (fechadoPor = quem carregou; o espelho
 *  no ERP de teste é feito pela rota) · 'reconferir' → volta pra 'separada' com o carregamento anterior guardado em
 *  carregamentosAnteriores e a observação pro operador (avisoCarga); outra pessoa (ou a mesma, menos quem separou) bipa de novo. */
function liberarSaida(id, { decisao, nome, obs } = {}) {
  const c = obter(id); if (!c) throw erro('Conferência não encontrada', 404);
  if (c.status !== 'conferida') throw erro('Este pedido não está aguardando o fiscal liberar a saída', 409);
  if (decisao !== 'liberar' && decisao !== 'reconferir') throw erro('decisão tem que ser liberar ou reconferir');
  const quando = agora().toISOString(); const quem = String(nome || 'FISCAL').toUpperCase().slice(0, 20); obs = String(obs || '').slice(0, 200);
  const ex = c.etapas.expedicao;
  if (decisao === 'liberar') {
    c.status = 'fechada'; c.fechadoEm = quando; c.fechadoPor = (ex && ex.fechadoPor) || c.conferidaPor || quem;
    c.saida = { decisao: 'liberada', decididoPor: quem, decididoEm: quando, obs };
  } else {
    c.carregamentosAnteriores = (c.carregamentosAnteriores || []).concat([{ ...ex, reconferirEm: quando, reconferirPor: quem, obs }]);
    c.etapas.expedicao = null; c.status = 'separada'; c.conferidaEm = null; c.conferidaPor = null;
    c.saida = { decisao: 'reconferir', decididoPor: quem, decididoEm: quando, obs };
    c.avisoCarga = { obs, nome: quem, em: quando };
    // divergências de lote do carregamento que voltou não valem mais como pendência
    c.eventos = c.eventos.filter(e => !(e.tipo === 'lote_divergente' && !e.verificado));
  }
  c.eventos.push({ tipo: 'liberacao_saida', etapa: 'expedicao', em: quando, nome: quem, decisao: c.saida.decisao, obs });
  salvar(c); return { id: c.id, nPedido: c.nPedido, status: c.status, saida: c.saida };
}

/** Status do NOSSO coletor por pedido, pro Painel CD mostrar por cima da coluna do Dlinks sem mexer no ERP (Tiago, 28/10:
 *  "mostra no painel sem mexer no erp"). Pedido fechado só conta no dia (igual à coluna Liberado do painel). */
const PAINEL_COLETOR = {
  separando: ['sep', 'Separando'], aguardando_fiscal: ['fis', 'Separação no fiscal'], separada: ['sep', 'Separado · falta carregar'],
  expedindo: ['car', 'Carregando'], conferida: ['fis', 'Carregado · fiscal liberar'], fechada: ['ok', 'Saída liberada'] };
function statusColetorPorPedido(n = 7) {
  const out = {}; if (!DIR) return out; const hoje = hojeStr();
  for (const d of dias(n)) for (const c of listarDia(d)) {
    const st = PAINEL_COLETOR[c.status]; if (!st) continue;
    if (c.status === 'fechada' && String(c.fechadoEm || '').slice(0, 10) !== hoje && d !== hoje) continue;
    const et = ehLegado(c) ? null : etapaAtual(c); const sep = separador(c);
    const quem = c.status === 'fechada' ? ((c.saida || {}).decididoPor || c.fechadoPor) : c.status === 'conferida' ? ((c.etapas.expedicao || {}).operador || {}).nome || c.conferidaPor
      : et ? ((et.operador || {}).nome || c.nome) : c.status === 'separada' ? (sep ? sep.nome : c.nome) : c.status === 'aguardando_fiscal' ? (sep ? sep.nome : c.nome) : c.nome;
    const em = c.fechadoEm || c.conferidaEm || (et && et.abertoEm) || c.abertoEm;
    if (!out[c.nPedido] || String(em) > String(out[c.nPedido].em)) out[c.nPedido] = { status: c.status, cor: st[0], rotulo: st[1], quem: quem || '', em };
  }
  return out;
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

/** Visão pro coletor. Separação de Pedidos leva a lista do pedido (`pedido`: descrição, quantidade, 4 últimos do EAN e
 *  o que já foi separado). Carregamento é cego: nem a quantidade do pedido, nem o que a separação registrou. */
function visao(id, operador) {
  const c = obter(id); if (!c) return null; const et = etapaAtual(c); const itens = et ? Object.values(et.itens) : []; const fora = et ? Object.values(et.fora) : [];
  const sep = separador(c);
  const etapa = ehLegado(c) ? 'unica' : et ? et.etapa : c.status === 'separada' ? 'expedicao' : c.status === 'aguardando_fiscal' ? 'fiscal' : c.status === 'conferida' ? 'conferida' : null;
  const v = { id: c.id, nPedido: c.nPedido, cliente: c.cliente, status: c.status, etapa, avisoCarga: c.avisoCarga || null, saida: c.saida || null,
    separadoPor: sep ? sep.nome : (!ehLegado(c) && c.etapas.separacao.fechadoPor) || null, expedidoPor: (!ehLegado(c) && c.etapas.expedicao && c.etapas.expedicao.fechadoPor) || null,
    souSeparador: !!(sep && operador && sep.id === operador.id),
    produtos_pedido: Object.keys(c.pedido).length, produtos: itens.length, unidades: +itens.reduce((a, i) => a + i.un, 0).toFixed(3),
    itens: itens.map(i => ({ cod: i.cod, descricao: i.descricao, quant: i.quant, emb: i.emb, un: i.un, lotes: i.lotes, estado: i.estado })),
    fora: fora.map(f => ({ cod: f.cod, descricao: f.descricao, quant: f.quant, emb: f.emb, un: f.un, lotes: f.lotes })),
    tirados: c.eventos.filter(e => e.tipo === 'tirar_coletagem' && (!et || ehLegado(c) || e.etapa === et.etapa)).length, tentativas: et ? (et.tentativas || 0) : (c.tentativas || 0),
    liberacao: c.liberacao ? { decisao: c.liberacao.decisao, obs: c.liberacao.obs, motivo: c.liberacao.motivo, pedidoEm: c.liberacao.pedidoEm, decididoPor: c.liberacao.decididoPor } : null,
    avisoFiscal: c.avisoFiscal || null };
  if (etapa === 'separacao' || etapa === 'fiscal') { const es = c.etapas.separacao; v.pedido = itensPedido(c).map(p => itemSeparacao(c, es, p)); v.separados = v.pedido.filter(p => p.separado).length; v.certos = v.pedido.filter(p => p.separado && p.separado.estado === 'ok').length; }
  return v;
}

/** Pendências do fiscal do CD (retaguarda), últimos n dias: "verificar pallet" (tirar_coletagem) e lote divergente. */
function pendenciasVerificacao(n = 7) {
  const out = [];
  for (const d of dias(n)) for (const c of listarDia(d)) c.eventos.forEach((e, idx) => { if (e.tipo === 'tirar_coletagem' || e.tipo === 'lote_divergente') out.push({ id: c.id, idx, nPedido: c.nPedido, cliente: c.cliente, status: c.status, ...e }); });
  return out.sort((a, b) => (a.verificado ? 1 : 0) - (b.verificado ? 1 : 0) || b.em.localeCompare(a.em));
}

/** Saídas por lote (pra tela "Lotes no CD"): o que de fato saiu = itens do CARREGAMENTO das conferências fechadas. */
function saidasPorLote(n = 60) {
  const out = [];
  for (const d of dias(n)) for (const c of listarDia(d)) if (c.status === 'fechada') for (const it of Object.values(itensSaida(c))) for (const l of it.lotes) out.push({ cod: it.cod, descricao: it.descricao, lote: l.lote, un: l.un, quant: l.quant, emb: it.emb, nPedido: c.nPedido, cliente: c.cliente, em: c.fechadoEm });
  return out;
}

module.exports = { init, hojeStr, validarId, obter, salvar, listarDia, acharPorPedido, abrirPedido, bipar, tirar, terminei, verificarPallet, visao, pendenciasVerificacao, saidasPorLote, LOJA_CD,
  etapaAtual, etapasDe, itensSaida, separador, operadores, temOperadores, salvarOperador, entrarOperador, operadorPorToken, ETAPAS, ROTULOS,
  produto, separar, decidirLiberacao, aguardandoFiscal, aguardandoSaida, liberarSaida, detalhe, statusColetorPorPedido, referencia };
