// Pedidos enviados ao fornecedor (Fase 3 do Radar de Pedidos).
//
// Fluxo definido pelo Tiago (10/09/2026):
//   1. compradora seleciona listas no Radar e clica "Enviar pro fornecedor"
//   2. sistema gera 1 pedido por lista (itens/quantidades do radar, por loja),
//      guarda o ÚLTIMO CUSTO do ERP de cada item e cria um link único (token)
//   3. status: aguardando  → vendedor ainda não abriu o link
//              digitacao   → vendedor abriu o link (primeira abertura)
//              finalizado  → vendedor clicou em Finalizar
//   4. no link o vendedor vê código, descrição, quantidade e preenche PREÇO e
//      OBSERVAÇÃO por item (salva sozinho); ao finalizar, trava
//   5. no pedido finalizado a compradora vê último custo × preço digitado com
//      seta (↑ verde maior, ↓ vermelha menor, = igual)
//
// Persistência: um JSON por pedido em data/pedidos-fornecedor/. NADA é escrito
// no ERP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'data', 'pedidos-fornecedor');
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };

function init() { fs.mkdirSync(DIR, { recursive: true }); }
const arq = id => path.join(DIR, `${id}.json`);
function salvar(p) { fs.writeFileSync(arq(p.id), JSON.stringify(p)); return p; }
function obter(id) { try { return JSON.parse(fs.readFileSync(arq(id), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
function porToken(token) {
  if (!/^[a-f0-9]{32}$/.test(token || '')) return null;
  return listar().find(p => p.token === token) || null;
}
function proximoId() {
  const ids = fs.readdirSync(DIR).map(f => parseInt(f)).filter(n => !isNaN(n));
  return (ids.length ? Math.max(...ids) : 0) + 1;
}

function totais(p) {
  let ultimo = 0, digitado = 0, comPreco = 0;
  for (const i of p.itens) {
    ultimo += i.qtd * (i.ultimo_custo || 0);
    if (i.preco != null) { digitado += i.qtd * i.preco; comPreco++; }
  }
  return { ultimo_custo: +ultimo.toFixed(2), digitado: +digitado.toFixed(2), itens: p.itens.length, com_preco: comPreco };
}

// cria 1 pedido a partir do detalhe do radar (itensLista) + cadastro da lista
function criar({ lista, cadastro, detalhe, teto, embMeses, usuario }) {
  const itens = detalhe.itens.filter(i => i.qtd > 0).map(i => ({
    cod: i.cod, descricao: i.descricao, unid: i.unid, emb: i.emb, qtd: i.qtd, volumes: i.volumes,
    lojas_qtd: i.lojas_qtd || {}, ultimo_custo: i.custo, preco: null, obs: ''
  }));
  const p = {
    id: proximoId(), token: crypto.randomBytes(16).toString('hex'),
    lista: lista.lista, lista_nome: lista.nome, fornecedor: lista.fornecedor, codFornec: lista.codFornec,
    vendedor: cadastro?.vendedor || null, comprador: cadastro?.comprador || null,
    prazo_pagamento: cadastro?.prazo_pagamento || null, pedido_minimo: lista.pedidoMinimo || null,
    status: 'aguardando', criadoEm: new Date().toISOString(), criadoPor: usuario || null,
    abertoEm: null, finalizadoEm: null, parametros: { teto, embMeses, fazer_em: detalhe.fazer_em },
    lojas: [...new Set(itens.flatMap(i => Object.keys(i.lojas_qtd).filter(l => i.lojas_qtd[l] > 0).map(Number)))].sort((a, b) => a - b),
    itens
  };
  p.totais = totais(p);
  return salvar(p);
}

// --- lado do vendedor (público, por token) ---
function abrir(token) {
  const p = porToken(token); if (!p) return null;
  if (p.status === 'aguardando') { p.status = 'digitacao'; p.abertoEm = new Date().toISOString(); salvar(p); }
  return p;
}
function salvarPrecos(token, itens) {
  const p = porToken(token); if (!p) return null;
  if (p.status === 'finalizado') return { erro: 'Pedido já finalizado' };
  const map = new Map((itens || []).map(i => [String(i.cod), i]));
  for (const it of p.itens) {
    const n = map.get(String(it.cod)); if (!n) continue;
    if (n.preco === '' || n.preco == null) it.preco = null;
    else { const v = parseFloat(String(n.preco).replace(',', '.')); if (isFinite(v) && v >= 0) it.preco = +v.toFixed(4); }
    if (typeof n.obs === 'string') it.obs = n.obs.slice(0, 200);
  }
  p.atualizadoEm = new Date().toISOString(); p.totais = totais(p);
  return salvar(p);
}
function finalizar(token, nomeQuemFinalizou) {
  const p = porToken(token); if (!p) return null;
  if (p.status === 'finalizado') return p;
  p.status = 'finalizado'; p.finalizadoEm = new Date().toISOString(); p.finalizadoPor = (nomeQuemFinalizou || '').slice(0, 80) || null;
  p.totais = totais(p);
  return salvar(p);
}
// --- lado da compradora ---
function aprovar(id, usuario) {
  const p = obter(id); if (!p) return null;
  if (p.status !== 'finalizado') return { erro: 'Só pedido finalizado pelo vendedor pode ser aprovado (status atual: ' + p.status + ')' };
  p.status = 'aprovado'; p.aprovadoEm = new Date().toISOString(); p.aprovadoPor = usuario || null;
  return salvar(p);
}
function cancelar(id, usuario, motivo) {
  const p = obter(id); if (!p) return null;
  if (p.status === 'aprovado') return { erro: 'Pedido aprovado não pode ser cancelado por aqui' };
  p.status = 'cancelado'; p.canceladoEm = new Date().toISOString(); p.canceladoPor = usuario || null; p.motivoCancelamento = (motivo || '').slice(0, 200) || null;
  return salvar(p);
}
// sugestão criada pelo sistema (ruptura de entrega) → compradora manda pro vendedor
function enviar(id, usuario) {
  const p = obter(id); if (!p) return null;
  if (p.status !== 'sugestao') return { erro: 'Só sugestão pendente pode ser enviada (status atual: ' + p.status + ')' };
  p.status = 'aguardando'; p.enviadoEm = new Date().toISOString(); p.enviadoPor = usuario || null;
  return salvar(p);
}

// ─────────────────────────────────────────────────────────────
// RECEBIMENTO × RUPTURA DE ENTREGA
// Pra cada pedido APROVADO, procura no ERP a nota do fornecedor em cada loja
// (compras: mesmo CodFornec, mesma loja, recebida depois da aprovação) e
// compara item a item o que entrou (compraprodutos.QtdEntradaEstoque) com o
// que foi pedido. Falta total ou parcial vira uma SUGESTÃO nova, só com as
// faltas, marcada como ruptura de entrega do pedido de origem — fica em
// status "sugestao" até a compradora mandar pro vendedor.
// ─────────────────────────────────────────────────────────────
let qERP = null;
function initERP(q) { qERP = q; }
const JANELA_RECEBIMENTO_DIAS = 30;

async function verificarRecebimentos() {
  if (!qERP) return { verificados: 0 };
  const hoje = new Date();
  let verificados = 0, rupturas = 0;
  for (const p of listar()) {
    if (!['aprovado', 'recebido_parcial'].includes(p.status)) continue;
    const desde = (p.aprovadoEm || p.criadoEm).slice(0, 10);
    const limite = new Date(new Date(desde + 'T00:00:00Z').getTime() + JANELA_RECEBIMENTO_DIAS * 864e5);
    p.recebimento = p.recebimento || {};
    let mudou = false;
    for (const ln of p.lojas) {
      if (p.recebimento[ln]) continue;   // loja já conferida
      let notas;
      try {
        notas = await qERP(`SELECT nCompra, nNota, DATE_FORMAT(DataRecto,'%Y-%m-%d') dr, TotalNota FROM central.compras
                            WHERE CodFornec=? AND nLoja=? AND Movimentacao='COMPRA' AND Status='F' AND DataRecto>=? ORDER BY DataRecto, nCompra LIMIT 5`, [p.codFornec, ln, desde]);
      } catch (e) { console.error('[PEDIDOS] recebimento:', e.message); continue; }
      if (!notas.length) continue;
      // soma todas as notas do fornecedor nessa loja desde a aprovação (pode vir em 2 notas)
      const recebido = {};
      for (const n of notas) {
        const itens = await qERP(`SELECT CodigoBarra cod, SUM(QtdEntradaEstoque) qtd FROM central.compraprodutos WHERE nCompra=? AND nLoja=? GROUP BY CodigoBarra`, [n.nCompra, ln]).catch(() => []);
        for (const it of itens) recebido[it.cod] = (recebido[it.cod] || 0) + (parseFloat(it.qtd) || 0);
      }
      const faltas = [];
      for (const it of p.itens) {
        const pedida = it.lojas_qtd?.[ln] || 0; if (pedida <= 0) continue;
        const rec = recebido[it.cod] || 0;
        it.recebido = it.recebido || {}; it.recebido[ln] = rec;
        if (rec < pedida - 0.001) faltas.push({ it, pedida, rec, falta: pedida - rec });
      }
      p.recebimento[ln] = { notas: notas.map(n => ({ nCompra: n.nCompra, nNota: n.nNota, data: n.dr })), conferidoEm: new Date().toISOString(), faltas: faltas.length, itens_pedidos: p.itens.filter(i => (i.lojas_qtd?.[ln] || 0) > 0).length };
      mudou = true; verificados++;
      if (faltas.length) { criarOuMesclarRuptura(p, ln, faltas); rupturas++; }
    }
    const lojasOk = p.lojas.filter(ln => p.recebimento[ln]);
    if (lojasOk.length === p.lojas.length) {
      p.status = Object.values(p.recebimento).some(r => r.faltas > 0) ? 'recebido_parcial' : 'recebido';
      if (p.status === 'recebido_parcial' && lojasOk.length === p.lojas.length) p.status = 'recebido_parcial';
      p.recebidoEm = p.recebidoEm || new Date().toISOString(); mudou = true;
    } else if (hoje > limite && lojasOk.length) {
      // passou a janela e alguma loja nunca recebeu nota: fecha como parcial
      p.status = 'recebido_parcial'; p.recebidoEm = p.recebidoEm || new Date().toISOString(); mudou = true;
    }
    if (mudou) salvar(p);
  }
  return { verificados, rupturas };
}

function criarOuMesclarRuptura(origem, ln, faltas) {
  // mescla na sugestão de ruptura já existente desse pedido enquanto ela não foi enviada
  let r = listar().find(x => x.origem?.tipo === 'ruptura' && x.origem.pedidoId === origem.id && x.status === 'sugestao');
  if (!r) {
    r = {
      id: proximoId(), token: crypto.randomBytes(16).toString('hex'),
      lista: origem.lista, lista_nome: origem.lista_nome, fornecedor: origem.fornecedor, codFornec: origem.codFornec,
      vendedor: origem.vendedor, comprador: origem.comprador, prazo_pagamento: origem.prazo_pagamento, pedido_minimo: origem.pedido_minimo,
      status: 'sugestao', criadoEm: new Date().toISOString(), criadoPor: 'sistema (ruptura de entrega)',
      abertoEm: null, finalizadoEm: null, parametros: origem.parametros || {},
      origem: { tipo: 'ruptura', pedidoId: origem.id, lojas: [], notas: [] },
      lojas: [], itens: [], alerta_novo: true
    };
  }
  if (!r.origem.lojas.includes(ln)) r.origem.lojas.push(ln);
  for (const n of origem.recebimento[ln].notas) r.origem.notas.push({ loja: ln, ...n });
  if (!r.lojas.includes(ln)) { r.lojas.push(ln); r.lojas.sort((a, b) => a - b); }
  for (const f of faltas) {
    let it = r.itens.find(i => i.cod === f.it.cod);
    if (!it) { it = { cod: f.it.cod, descricao: f.it.descricao, unid: f.it.unid, emb: f.it.emb, qtd: 0, volumes: 0, lojas_qtd: {}, ultimo_custo: f.it.preco != null ? f.it.preco : f.it.ultimo_custo, preco: null, obs: '', ruptura: {} }; r.itens.push(it); }
    const q = Math.ceil(f.falta / (it.emb || 1)) * (it.emb || 1);
    it.lojas_qtd[ln] = q; it.ruptura[ln] = { pedida: f.pedida, recebida: f.rec, tipo: f.rec <= 0 ? 'total' : 'parcial' };
    it.qtd = Object.values(it.lojas_qtd).reduce((s, v) => s + v, 0); it.volumes = Math.ceil(it.qtd / (it.emb || 1));
  }
  r.totais = totais(r); r.alerta_novo = true;
  salvar(r);
  return r;
}
function verAlertas(ids, usuario) {
  for (const id of ids || []) { const p = obter(id); if (p && p.alerta_novo) { p.alerta_novo = false; p.alertaVistoPor = usuario || null; salvar(p); } }
}

// versão pro vendedor: sem custo do ERP (ele não deve ver o que a loja paga hoje)
function visaoVendedor(p) {
  return {
    id: p.id, status: p.status, lista_nome: p.lista_nome, fornecedor: p.fornecedor, criadoEm: p.criadoEm, finalizadoEm: p.finalizadoEm,
    vendedor: p.vendedor ? { nome: p.vendedor.nome || null } : null,
    comprador: p.comprador, prazo_pagamento: p.prazo_pagamento, lojas: p.lojas, lojas_nomes: LOJAS_NOMES,
    itens: p.itens.map(i => ({ cod: i.cod, descricao: i.descricao, unid: i.unid, emb: i.emb, qtd: i.qtd, volumes: i.volumes, lojas_qtd: i.lojas_qtd, preco: i.preco, obs: i.obs }))
  };
}

module.exports = { init, initERP, criar, listar, obter, porToken, abrir, salvarPrecos, finalizar, aprovar, cancelar, enviar, verificarRecebimentos, verAlertas, visaoVendedor, LOJAS_NOMES };
