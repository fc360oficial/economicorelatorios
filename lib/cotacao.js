// Cotação de compra (Gestão de Compras > Cotação).
//
// Fluxo definido pelo Tiago (14/09/2026):
//   1. compradora digita o nº da lista do ERP (ex.: 277 "Cotação de Alimentos") e o sistema monta a
//      sugestão de compra com as regras do Radar (loja a loja, piso/teto, embalagem real); lista sem
//      lead time usa a cobertura e o prazo de entrega digitados na tela
//   2. escolhe os fornecedores concorrentes; cada um recebe um link único (token) pra digitar o
//      preço unitário por item — não vê o custo da loja nem os preços dos outros
//   3. comparativo fornecedor a fornecedor: o menor preço vence por item; a compradora pode trocar
//      o vencedor ou marcar "não comprar"
//   4. fechar a cotação gera 1 pedido por fornecedor vencedor em lib/pedidos-fornecedor (já com os
//      preços, status "finalizado") → tela Pedidos de Compra pra aprovar e conferir igual ao Radar
//
// Persistência: um JSON por cotação em data/cotacoes/. NADA é escrito no ERP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'data', 'cotacoes');
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };

function init() { fs.mkdirSync(DIR, { recursive: true }); }
const arq = id => path.join(DIR, `${id}.json`);
function salvar(c) { c.atualizadoEm = new Date().toISOString(); fs.writeFileSync(arq(c.id), JSON.stringify(c)); return c; }
function obter(id) { try { return JSON.parse(fs.readFileSync(arq(id), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
function proximoId() {
  const ids = fs.readdirSync(DIR).map(f => parseInt(f)).filter(n => !isNaN(n));
  return (ids.length ? Math.max(...ids) : 0) + 1;
}
// token é POR FORNECEDOR (cada convidado tem o seu link)
function porToken(token) {
  if (!/^[a-f0-9]{32}$/.test(token || '')) return null;
  for (const c of listar()) { const f = (c.fornecedores || []).find(x => x.token === token); if (f) return { c, f }; }
  return null;
}
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : null; };
const novoToken = () => crypto.randomBytes(16).toString('hex');

function normFornecedor(f) {
  const cod = parseInt(f.codFornec) || 0;
  const v = f.vendedor || {};
  return {
    codFornec: cod, nome: String(f.nome || '').trim().slice(0, 120) || ('Fornecedor ' + cod),
    vendedor: { nome: String(v.nome || '').trim().slice(0, 80) || null, whats: String(v.whats || '').replace(/\D/g, '').slice(0, 20) || null, email: String(v.email || '').trim().slice(0, 120) || null },
    token: novoToken(), status: 'aguardando', convidadoEm: new Date().toISOString(), enviadoEm: null, abertoEm: null, finalizadoEm: null,
    precos: {}, condicao: null, obs: null
  };
}

// cria a cotação a partir da sugestão (itens com quantidade POR LOJA) + fornecedores convidados
function criar({ nome, lista, lista_nome, comprador, prazo, parametros, itens, fornecedores, usuario }) {
  const its = (itens || []).map(i => {
    const lojas_qtd = {};
    for (const [ln, v] of Object.entries(i.lojas_qtd || {})) { const n = Math.max(0, Math.round(num(v) || 0)); if (n > 0) lojas_qtd[ln] = n; }
    const qtd = Object.values(lojas_qtd).reduce((s, v) => s + v, 0);
    const emb = Math.max(1, Math.round(num(i.emb) || 1));
    return {
      cod: String(i.cod), descricao: i.descricao || '', unid: i.unid || 'UN', emb, qtd, volumes: qtd ? Math.ceil(qtd / emb) : 0, lojas_qtd,
      ultimo_custo: num(i.ultimo_custo) ?? num(i.custo) ?? 0, estoque: num(i.estoque), venda_dia: num(i.venda_dia), cobertura_dias: num(i.cobertura_dias), curva_a: !!i.curva_a
    };
  }).filter(i => i.qtd > 0);
  if (!its.length) throw new Error('Nenhum item com quantidade por loja');
  const seen = new Set();
  const forns = (fornecedores || []).map(normFornecedor).filter(f => { const k = f.codFornec || f.nome.toUpperCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  if (!forns.length) throw new Error('Nenhum fornecedor convidado');
  const c = {
    id: proximoId(), nome: String(nome || '').trim().slice(0, 120) || `Cotação lista ${lista}`,
    lista: parseInt(lista) || null, lista_nome: lista_nome || null, comprador: comprador || null, prazo: prazo || null,
    status: 'aberta', criadoEm: new Date().toISOString(), criadoPor: usuario || null,
    parametros: parametros || {}, itens: its, fornecedores: forns, vencedores: {}, pedidos: [],
    lojas: [...new Set(its.flatMap(i => Object.keys(i.lojas_qtd).map(Number)))].sort((a, b) => a - b)
  };
  c.totais = { itens: its.length, volumes: its.reduce((a, i) => a + i.volumes, 0), ultimo_custo: +its.reduce((a, i) => a + i.qtd * (i.ultimo_custo || 0), 0).toFixed(2) };
  return salvar(c);
}
function adicionarFornecedor(id, f) {
  const c = obter(id); if (!c) return null;
  if (c.status !== 'aberta') return { erro: 'Cotação ' + c.status + ': não aceita mais fornecedores' };
  const nf = normFornecedor(f);
  if (nf.codFornec && c.fornecedores.some(x => x.codFornec === nf.codFornec)) return { erro: 'Fornecedor já convidado' };
  c.fornecedores.push(nf); salvar(c);
  return { c, f: nf };
}
function marcarEnviado(id, codFornec) {
  const c = obter(id); if (!c) return null;
  const f = c.fornecedores.find(x => x.codFornec === parseInt(codFornec) || x.token === codFornec);
  if (f) { f.enviadoEm = new Date().toISOString(); salvar(c); }
  return c;
}

// --- lado do fornecedor (público, por token) ---
function abrir(token) {
  const r = porToken(token); if (!r) return null;
  if (r.c.status === 'aberta' && r.f.status === 'aguardando') { r.f.status = 'digitacao'; r.f.abertoEm = new Date().toISOString(); salvar(r.c); }
  return r;
}
function salvarPrecos(token, itens, extra) {
  const r = porToken(token); if (!r) return null;
  const { c, f } = r;
  if (c.status !== 'aberta') return { erro: 'Cotação ' + c.status + ': não aceita mais preços' };
  if (!['aguardando', 'digitacao'].includes(f.status)) return { erro: 'Proposta já enviada: não aceita mais alteração' };
  const cods = new Set(c.itens.map(i => i.cod));
  for (const n of itens || []) {
    const cod = String(n.cod); if (!cods.has(cod)) continue;
    const v = n.preco === '' || n.preco == null ? null : num(n.preco);
    const obs = typeof n.obs === 'string' ? n.obs.slice(0, 200) : (f.precos[cod]?.obs || '');
    if (v == null) { if (obs) f.precos[cod] = { preco: null, obs }; else delete f.precos[cod]; }
    else if (v >= 0) f.precos[cod] = { preco: +v.toFixed(4), obs };
  }
  if (extra) {
    if (typeof extra.condicao === 'string') f.condicao = extra.condicao.trim().slice(0, 80) || null;
    if (typeof extra.obs === 'string') f.obs = extra.obs.trim().slice(0, 500) || null;
  }
  f.atualizadoEm = new Date().toISOString(); salvar(c);
  return r;
}
function finalizar(token, nome) {
  const r = porToken(token); if (!r) return null;
  const { c, f } = r;
  if (c.status !== 'aberta' || !['aguardando', 'digitacao'].includes(f.status)) return r;
  f.status = 'finalizado'; f.finalizadoEm = new Date().toISOString(); f.finalizadoPor = (nome || '').slice(0, 80) || null;
  salvar(c);
  return r;
}
// versão pro fornecedor: sem custo do ERP e sem os preços dos concorrentes
function visaoVendedor(c, f) {
  return {
    id: c.id, nome: c.nome, status: c.status, prazo: c.prazo, criadoEm: c.criadoEm,
    comprador: c.comprador ? { nome: c.comprador.nome || null, whats: c.comprador.whats || null } : null,
    fornecedor: { nome: f.nome, status: f.status, vendedor: f.vendedor ? { nome: f.vendedor.nome } : null, finalizadoEm: f.finalizadoEm, condicao: f.condicao, obs: f.obs },
    lojas: c.lojas, lojas_nomes: LOJAS_NOMES,
    cotados: c.itens.filter(i => f.precos[i.cod]?.preco != null).length,
    itens: c.itens.map(i => ({ cod: i.cod, descricao: i.descricao, unid: i.unid, emb: i.emb, qtd: i.qtd, volumes: i.volumes, lojas_qtd: i.lojas_qtd, preco: f.precos[i.cod]?.preco ?? null, obs: f.precos[i.cod]?.obs || '' }))
  };
}

// --- comparativo (compradora): menor preço vence por item, salvo escolha manual em c.vencedores
//     c.vencedores[cod]: ausente = automático · null = não comprar · número = codFornec escolhido
function comparativo(c) {
  const forns = c.fornecedores.map(f => ({
    codFornec: f.codFornec, nome: f.nome, status: f.status, vendedor: f.vendedor, condicao: f.condicao, obs: f.obs, token: f.token,
    enviadoEm: f.enviadoEm, abertoEm: f.abertoEm, finalizadoEm: f.finalizadoEm,
    cotados: c.itens.filter(i => f.precos[i.cod]?.preco != null).length,
    total: 0, itens_vencedor: 0, total_vencedor: 0, economia: 0
  }));
  const byCod = Object.fromEntries(forns.map(f => [f.codFornec, f]));
  let ultimoVenc = 0, totalVenc = 0, comPreco = 0, abaixo = 0, acima = 0, semVencedor = 0, naoComprar = 0;
  const escolhas = c.vencedores || {};
  const itens = c.itens.map(i => {
    const precos = {}; let melhor = null;
    for (const f of c.fornecedores) {
      const p = f.precos[i.cod]; if (p?.preco == null) continue;
      precos[f.codFornec] = { preco: p.preco, obs: p.obs || '' };
      byCod[f.codFornec].total += p.preco * i.qtd;
      if (!melhor || p.preco < melhor.preco) melhor = { codFornec: f.codFornec, preco: p.preco };
    }
    const escolha = Object.prototype.hasOwnProperty.call(escolhas, i.cod) ? escolhas[i.cod] : undefined;
    let vencedor = null, manual = false;
    if (escolha === null) naoComprar++;
    else if (escolha != null && precos[escolha]) { vencedor = { codFornec: escolha, preco: precos[escolha].preco }; manual = true; }
    else vencedor = melhor;
    if (Object.keys(precos).length) comPreco++;
    const ultimo = i.ultimo_custo || 0;
    let economia = null;
    if (vencedor) {
      const f = byCod[vencedor.codFornec];
      f.itens_vencedor++; f.total_vencedor += vencedor.preco * i.qtd; totalVenc += vencedor.preco * i.qtd;
      if (ultimo > 0) { ultimoVenc += ultimo * i.qtd; economia = +((ultimo - vencedor.preco) * i.qtd).toFixed(2); f.economia += ultimo - vencedor.preco > 0 ? (ultimo - vencedor.preco) * i.qtd : (ultimo - vencedor.preco) * i.qtd; if (vencedor.preco <= ultimo) abaixo++; else acima++; }
    } else if (escolha !== null) semVencedor++;
    return { ...i, precos, melhor, vencedor, manual, nao_comprar: escolha === null, economia, total_vencedor: vencedor ? +(vencedor.preco * i.qtd).toFixed(2) : null };
  });
  for (const f of forns) { f.total = +f.total.toFixed(2); f.total_vencedor = +f.total_vencedor.toFixed(2); f.economia = +f.economia.toFixed(2); }
  return {
    fornecedores: forns, itens,
    resumo: {
      itens: c.itens.length, com_preco: comPreco, abaixo, acima, sem_vencedor: semVencedor, nao_comprar: naoComprar,
      convidados: forns.length, responderam: forns.filter(f => f.status === 'finalizado').length, abriram: forns.filter(f => f.abertoEm).length,
      total_ultimo_custo: c.totais?.ultimo_custo ?? 0, total_ultimo_vencedores: +ultimoVenc.toFixed(2), total_vencedores: +totalVenc.toFixed(2),
      economia: +(ultimoVenc - totalVenc).toFixed(2), economia_pct: ultimoVenc > 0 ? +(((ultimoVenc - totalVenc) / ultimoVenc) * 100).toFixed(1) : null
    }
  };
}
function definirVencedor(id, cod, codFornec) {
  const c = obter(id); if (!c) return null;
  if (c.status !== 'aberta') return { erro: 'Cotação ' + c.status + ': não dá mais pra mudar o vencedor' };
  cod = String(cod);
  if (!c.itens.some(i => i.cod === cod)) return { erro: 'Item não está na cotação' };
  c.vencedores = c.vencedores || {};
  if (codFornec === undefined || codFornec === 'auto' || codFornec === '') delete c.vencedores[cod];
  else if (codFornec === null || codFornec === 'nao') c.vencedores[cod] = null;
  else { const n = parseInt(codFornec); if (!c.fornecedores.some(f => f.codFornec === n)) return { erro: 'Fornecedor não está na cotação' }; c.vencedores[cod] = n; }
  return salvar(c);
}
// fecha: agrupa os itens por fornecedor vencedor e chama criarPedido(fornecedor, itens, cotacao) pra cada um
async function fechar(id, usuario, criarPedido) {
  const c = obter(id); if (!c) return null;
  if (c.status !== 'aberta') return { erro: 'Cotação já ' + c.status };
  const cmp = comparativo(c);
  const grupos = {};
  for (const it of cmp.itens) {
    if (!it.vencedor) continue;
    (grupos[it.vencedor.codFornec] = grupos[it.vencedor.codFornec] || []).push({ ...it, preco: it.vencedor.preco, obs: it.precos[it.vencedor.codFornec]?.obs || '' });
  }
  if (!Object.keys(grupos).length) return { erro: 'Nenhum item com preço digitado: nada a pedir' };
  const pedidos = [];
  for (const [cod, itens] of Object.entries(grupos)) {
    const f = c.fornecedores.find(x => x.codFornec === +cod);
    pedidos.push(await criarPedido(f, itens, c));
  }
  c.status = 'fechada'; c.fechadaEm = new Date().toISOString(); c.fechadaPor = usuario || null;
  c.pedidos = pedidos; c.resultado = cmp.resumo;
  return salvar(c);
}
function cancelar(id, usuario) {
  const c = obter(id); if (!c) return null;
  if (c.status === 'fechada') return { erro: 'Cotação fechada (pedidos já gerados) não pode ser cancelada' };
  c.status = 'cancelada'; c.canceladaEm = new Date().toISOString(); c.canceladaPor = usuario || null;
  return salvar(c);
}
// linha do Monitor
function resumo(c) {
  const r = comparativo(c).resumo;
  return {
    id: c.id, nome: c.nome, lista: c.lista, lista_nome: c.lista_nome, comprador: c.comprador, prazo: c.prazo, status: c.status,
    criadoEm: c.criadoEm, criadoPor: c.criadoPor, fechadaEm: c.fechadaEm || null, lojas: c.lojas, itens: c.itens.length, totais: c.totais,
    convidados: r.convidados, responderam: r.responderam, abriram: r.abriram, com_preco: r.com_preco,
    total_vencedores: r.total_vencedores, economia: r.economia, economia_pct: r.economia_pct, pedidos: c.pedidos || []
  };
}
// histórico de preço de um produto nas cotações anteriores (quem ganhou e por quanto)
function historicoProduto(cod) {
  cod = String(cod); const out = [];
  for (const c of listar()) {
    const i = c.itens.find(x => x.cod === cod); if (!i) continue;
    const it = comparativo(c).itens.find(x => x.cod === cod);
    const nome = cf => c.fornecedores.find(f => f.codFornec === +cf)?.nome || String(cf);
    out.push({
      cotacao: c.id, nome: c.nome, status: c.status, data: c.fechadaEm || c.criadoEm, qtd: i.qtd, ultimo_custo: i.ultimo_custo,
      vencedor: it.vencedor ? { nome: nome(it.vencedor.codFornec), preco: it.vencedor.preco } : null,
      precos: Object.entries(it.precos).map(([cf, p]) => ({ codFornec: +cf, nome: nome(cf), preco: p.preco }))
    });
  }
  return out;
}

module.exports = { init, criar, obter, listar, porToken, adicionarFornecedor, marcarEnviado, abrir, salvarPrecos, finalizar, visaoVendedor, comparativo, definirVencedor, fechar, cancelar, resumo, historicoProduto, LOJAS_NOMES };
