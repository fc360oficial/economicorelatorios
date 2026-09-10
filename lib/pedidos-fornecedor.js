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
// versão pro vendedor: sem custo do ERP (ele não deve ver o que a loja paga hoje)
function visaoVendedor(p) {
  return {
    id: p.id, status: p.status, lista_nome: p.lista_nome, fornecedor: p.fornecedor, criadoEm: p.criadoEm, finalizadoEm: p.finalizadoEm,
    comprador: p.comprador, prazo_pagamento: p.prazo_pagamento, lojas: p.lojas, lojas_nomes: LOJAS_NOMES,
    itens: p.itens.map(i => ({ cod: i.cod, descricao: i.descricao, unid: i.unid, emb: i.emb, qtd: i.qtd, volumes: i.volumes, lojas_qtd: i.lojas_qtd, preco: i.preco, obs: i.obs }))
  };
}

module.exports = { init, criar, listar, obter, porToken, abrir, salvarPrecos, finalizar, aprovar, cancelar, visaoVendedor, LOJAS_NOMES };
