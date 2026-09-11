// Conferência XML dos pedidos ao fornecedor (11/09/2026, pedido do Tiago).
//
// Depois que a compradora APROVA um pedido, ele fica "aguardando conferência XML".
// O sistema procura, LOJA A LOJA, as NF-e que o fornecedor emitiu pra cada loja
// (central.axml = cabeçalho, central.axmlprodutos = itens, central.axmlboletos =
// duplicatas/boletos) e compara com o que foi pedido:
//   - quantidade por item (unidades) → conciliado / parcial / falta / veio a mais / não pedido
//   - preço unitário digitado pelo vendedor × preço unitário do XML
//   - financeiro: valor da NF-e × esperado (recebido × preço digitado) e boletos × NF-e
// Cada loja fica: aguardando | conciliado | consistencia. O pedido só fecha quando
// todas as lojas têm nota. Faltas viram sugestão de ruptura (criarOuMesclarRuptura).
//
// Ligações no ERP (descobertas em 11/09/2026):
//   axml.CodFornec vem sempre "0" → fornecedor é achado pelo CNPJ (central.fornecedor.CNPJ),
//   comparando a RAIZ (8 dígitos) porque a indústria fatura por filiais diferentes.
//   axmlprodutos liga com axml por nNota + CNPJemit (o nReg é outro).
//   axmlboletos liga por chave da NF-e. Loja = CNPJdest.
//   Quantidade em unidades = oqTrib (unidade tributável); preço unitário = ovUnTrib.
//
// SOMENTE LEITURA no ERP. Pedidos de TESTE (p.teste=true) leem as notas de
// data/xml-teste/<id>.json em vez do ERP.
const fs = require('fs');
const path = require('path');

const LOJA_CNPJ = { 1: '21425302000181', 2: '30148015000162', 3: '39762002000153', 4: '43358448000194', 5: '51632927000185', 6: '59890722000101' };
const TESTE_DIR = path.join(__dirname, '..', 'data', 'xml-teste');
const JANELA_DIAS = 30;
const TOL_PRECO = 0.005;   // 0,5% de tolerância no preço unitário
const TOL_VALOR = 0.01;    // R$ 0,01 nos totais

let qERP = null;
const cnpjCache = {};
function init(q) { qERP = q; fs.mkdirSync(TESTE_DIR, { recursive: true }); }

const num = v => { let s = String(v ?? '0').trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : 0; };
const addDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function cnpjRaizFornecedor(codFornec) {
  if (cnpjCache[codFornec] !== undefined) return cnpjCache[codFornec];
  let raiz = null;
  try {
    const r = await qERP(`SELECT CNPJ FROM central.fornecedor WHERE CodFornec=? LIMIT 1`, [codFornec]);
    const c = String(r[0]?.CNPJ || '').replace(/\D/g, '');
    raiz = c.length >= 8 ? c.slice(0, 8) : null;
  } catch (e) { console.error('[XML] cnpj fornecedor:', e.message); }
  cnpjCache[codFornec] = raiz;
  return raiz;
}

// notas do fornecedor pra uma loja, a partir de uma data (cabeçalho + itens + boletos)
async function buscarNotas(raiz, ln, desde, ate) {
  const cnpjLoja = LOJA_CNPJ[ln]; if (!cnpjLoja || !raiz) return [];
  const cab = await qERP(`SELECT nReg, nNota, nSerie, DATE_FORMAT(Data,'%Y-%m-%d') data, CNPJemit, NomeEmit, ValorNFE, ValorProduto, ValorDesconto, ValorFrete, ValorIPI, ValorICMSsub, Chave, Importado, Status
                          FROM central.axml WHERE CNPJdest=? AND LEFT(CNPJemit,8)=? AND nMod='55' AND Data BETWEEN ? AND ? ORDER BY Data, nReg`, [cnpjLoja, raiz, desde, ate]);
  const notas = [];
  for (const n of cab) {
    const prods = await qERP(`SELECT nItem, CodigoBarras, ocEanTrib, Descricao, Und, Qtd, ValorUnit, ValorTotal, ValorDesconto, oqTrib, ovUnTrib FROM central.axmlprodutos WHERE nNota=? AND CNPJemit=? ORDER BY nItem`, [n.nNota, n.CNPJemit]).catch(() => []);
    const boletos = await qERP(`SELECT ndup, DATE_FORMAT(dataVencto,'%Y-%m-%d') vencimento, valor FROM central.axmlboletos WHERE chave=? ORDER BY ndup`, [n.Chave]).catch(() => []);
    notas.push({
      chave: n.Chave, nNota: n.nNota, serie: n.nSerie, data: n.data, cnpjEmit: n.CNPJemit, emitente: n.NomeEmit,
      valorNFE: num(n.ValorNFE), valorProduto: num(n.ValorProduto), desconto: num(n.ValorDesconto), frete: num(n.ValorFrete), ipi: num(n.ValorIPI), st: num(n.ValorICMSsub),
      importado: +n.Importado === 1, status: n.Status,
      itens: prods.map(p => {
        const qtdCom = num(p.Qtd), unidades = num(p.oqTrib) > 0 ? num(p.oqTrib) : qtdCom;
        const total = num(p.ValorTotal);
        const precoUnit = num(p.ovUnTrib) > 0 ? num(p.ovUnTrib) : (unidades > 0 ? total / unidades : 0);
        const ean = String(p.ocEanTrib || '').trim(); const cod = String(p.CodigoBarras || '').trim();
        return { item: p.nItem, cod: cod && cod !== '0' ? cod : ean, descricao: (p.Descricao || '').trim(), und: p.Und, qtdCom, unidades, precoUnit: +precoUnit.toFixed(4), total, desconto: num(p.ValorDesconto) };
      }),
      boletos: boletos.map(b => ({ dup: b.ndup, vencimento: b.vencimento, valor: num(b.valor) }))
    });
  }
  return notas;
}

// pedidos de teste: notas vêm de um JSON local no formato acima ({ "<loja>": [notas] })
function notasTeste(pedidoId, ln) {
  try { const j = JSON.parse(fs.readFileSync(path.join(TESTE_DIR, `${pedidoId}.json`), 'utf8')); return j[ln] || j[String(ln)] || []; } catch (e) { return []; }
}

// compara UMA loja de um pedido com as notas achadas
function conferirLoja(p, ln, notas) {
  const rec = {}; // cod → { unidades, total, precos: [] , descricao }
  for (const n of notas) for (const it of n.itens) {
    const r = rec[it.cod] || (rec[it.cod] = { unidades: 0, total: 0, precos: [], descricao: it.descricao });
    r.unidades += it.unidades; r.total += it.total; r.precos.push(it.precoUnit);
  }
  const itens = [], faltas = [];
  let esperado = 0, divPreco = 0;
  for (const it of p.itens) {
    const pedida = it.lojas_qtd?.[ln] || 0; if (pedida <= 0) continue;
    const r = rec[it.cod]; const recebida = r ? r.unidades : 0;
    const precoDig = it.preco != null ? it.preco : null;
    const precoXml = r && r.unidades > 0 ? +(r.total / r.unidades).toFixed(4) : null;
    let tipo = 'ok';
    if (recebida <= 0) tipo = 'falta'; else if (recebida < pedida - 0.001) tipo = 'parcial'; else if (recebida > pedida + 0.001) tipo = 'a_mais';
    let precoStatus = null, precoDif = null, precoPct = null;
    if (precoDig != null && precoXml != null) {
      precoDif = +(precoXml - precoDig).toFixed(4); precoPct = precoDig > 0 ? precoDif / precoDig : 0;
      precoStatus = Math.abs(precoPct) <= TOL_PRECO ? 'ok' : (precoDif > 0 ? 'maior' : 'menor');
      if (precoStatus !== 'ok') divPreco++;
    }
    esperado += recebida * (precoDig != null ? precoDig : (it.ultimo_custo || 0));
    itens.push({ cod: it.cod, descricao: it.descricao, pedida, recebida, dif: +(recebida - pedida).toFixed(3), tipo, preco_digitado: precoDig, preco_xml: precoXml, preco_dif: precoDif, preco_pct: precoPct != null ? +(precoPct * 100).toFixed(2) : null, preco_status: precoStatus });
    if (tipo === 'falta' || tipo === 'parcial') faltas.push({ it, pedida, rec: recebida, falta: pedida - recebida });
  }
  // itens que vieram na nota mas não estavam no pedido
  const pedidos = new Set(p.itens.filter(i => (i.lojas_qtd?.[ln] || 0) > 0).map(i => i.cod));
  const naoPedidos = Object.entries(rec).filter(([cod]) => !pedidos.has(cod)).map(([cod, r]) => ({ cod, descricao: r.descricao, recebida: r.unidades, total: +r.total.toFixed(2), preco_xml: r.unidades > 0 ? +(r.total / r.unidades).toFixed(4) : null }));
  const nfe = +notas.reduce((a, n) => a + n.valorNFE, 0).toFixed(2);
  const bolTotal = +notas.reduce((a, n) => a + n.boletos.reduce((s, b) => s + b.valor, 0), 0).toFixed(2);
  const nBol = notas.reduce((a, n) => a + n.boletos.length, 0);
  const problemas = [];
  if (faltas.length) problemas.push({ tipo: 'falta', msg: faltas.length + (faltas.length > 1 ? ' itens' : ' item') + ' com falta ou parcial' });
  if (itens.some(i => i.tipo === 'a_mais')) problemas.push({ tipo: 'a_mais', msg: itens.filter(i => i.tipo === 'a_mais').length + ' item(ns) veio a mais' });
  if (naoPedidos.length) problemas.push({ tipo: 'nao_pedido', msg: naoPedidos.length + ' item(ns) na nota que não estavam no pedido' });
  if (divPreco) problemas.push({ tipo: 'preco', msg: divPreco + ' item(ns) com preço diferente do digitado' });
  if (!nBol) problemas.push({ tipo: 'sem_boleto', msg: 'nota sem boleto/duplicata no XML' });
  else if (Math.abs(bolTotal - nfe) > TOL_VALOR) problemas.push({ tipo: 'boleto', msg: 'boletos somam ' + bolTotal.toFixed(2) + ' e a NF-e é ' + nfe.toFixed(2) });
  if (esperado > 0 && Math.abs(nfe - esperado) / esperado > TOL_PRECO && !divPreco && !naoPedidos.length) problemas.push({ tipo: 'valor', msg: 'valor da NF-e (' + nfe.toFixed(2) + ') diferente do esperado (' + esperado.toFixed(2) + ')' });
  return {
    status: problemas.length ? 'consistencia' : 'conciliado', conferidoEm: new Date().toISOString(),
    notas: notas.map(n => ({ chave: n.chave, nNota: n.nNota, serie: n.serie, data: n.data, emitente: n.emitente, valorNFE: n.valorNFE, importado: n.importado, itens: n.itens.length, boletos: n.boletos })),
    itens, nao_pedidos: naoPedidos, faltas: faltas.length,
    financeiro: { nfe, esperado: +esperado.toFixed(2), boletos: bolTotal, n_boletos: nBol, vencimentos: notas.flatMap(n => n.boletos.map(b => b.vencimento)).sort() },
    problemas, _faltas: faltas
  };
}

// roda em todos os pedidos aprovados; devolve { verificados, rupturas, conciliados, consistencias }
async function conferirTodos({ listar, salvar, criarOuMesclarRuptura }) {
  if (!qERP) return { verificados: 0, rupturas: 0 };
  const hoje = new Date().toISOString().slice(0, 10);
  let verificados = 0, rupturas = 0, conciliados = 0, consistencias = 0;
  const todos = listar();
  // chaves já usadas por outros pedidos (não contar a mesma nota duas vezes)
  const chaveDono = {};
  for (const p of todos) for (const [ln, L] of Object.entries(p.xml?.lojas || {})) for (const n of L.notas || []) chaveDono[n.chave] = p.id;
  for (const p of todos) {
    if (!['aprovado', 'recebido_parcial', 'recebido'].includes(p.status)) continue;
    if (p.xml?.status === 'conciliado') continue;   // fechado
    const desde = (p.aprovadoEm || p.criadoEm).slice(0, 10);
    const ate = addDias(desde, JANELA_DIAS);
    const raiz = p.teste ? null : await cnpjRaizFornecedor(p.codFornec);
    p.xml = p.xml || { status: 'aguardando', lojas: {} };
    p.recebimento = p.recebimento || {};
    let mudou = false;
    for (const ln of p.lojas) {
      const prev = p.xml.lojas[ln];
      if (prev && prev.status === 'conciliado') continue;
      let notas;
      try { notas = p.teste ? notasTeste(p.id, ln) : await buscarNotas(raiz, ln, addDias(desde, -1), ate); }
      catch (e) { console.error('[XML] loja', ln, e.message); continue; }
      notas = notas.filter(n => !chaveDono[n.chave] || chaveDono[n.chave] === p.id);
      if (!notas.length) { if (!prev) { p.xml.lojas[ln] = { status: 'aguardando', notas: [], itens: [], problemas: [] }; mudou = true; } continue; }
      const r = conferirLoja(p, ln, notas);
      for (const n of notas) chaveDono[n.chave] = p.id;
      // marca recebido por item (compatível com a tela antiga) e cria sugestão de ruptura UMA vez por loja
      for (const i of r.itens) { const it = p.itens.find(x => x.cod === i.cod); if (it) { it.recebido = it.recebido || {}; it.recebido[ln] = i.recebida; } }
      const jaCriou = prev?.ruptura_criada;
      p.recebimento[ln] = { notas: r.notas.map(n => ({ nNota: n.nNota, chave: n.chave, data: n.data })), conferidoEm: r.conferidoEm, faltas: r.faltas, itens_pedidos: r.itens.length };
      if (r._faltas.length && !jaCriou && criarOuMesclarRuptura) { try { criarOuMesclarRuptura(p, ln, r._faltas); rupturas++; r.ruptura_criada = true; } catch (e) { console.error('[XML] ruptura:', e.message); } }
      else if (jaCriou) r.ruptura_criada = true;
      delete r._faltas;
      p.xml.lojas[ln] = r; mudou = true; verificados++;
      if (r.status === 'conciliado') conciliados++; else consistencias++;
    }
    const L = p.lojas.map(ln => p.xml.lojas[ln]).filter(Boolean);
    const comNota = L.filter(x => x.status !== 'aguardando');
    const antes = p.xml.status;
    if (comNota.length === p.lojas.length) p.xml.status = L.every(x => x.status === 'conciliado') ? 'conciliado' : 'consistencia';
    else if (hoje > ate && comNota.length) p.xml.status = 'consistencia';   // janela venceu com loja sem nota
    else p.xml.status = comNota.length ? 'parcial' : 'aguardando';
    if (p.xml.status !== antes) mudou = true;
    // status do pedido (mantém os nomes que a tela já usa)
    if (p.xml.status === 'conciliado') { p.status = 'recebido'; p.recebidoEm = p.recebidoEm || new Date().toISOString(); mudou = true; }
    else if (p.xml.status === 'consistencia') { p.status = 'recebido_parcial'; p.recebidoEm = p.recebidoEm || new Date().toISOString(); mudou = true; }
    if (mudou) { p.xml.verificadoEm = new Date().toISOString(); salvar(p); }
  }
  return { verificados, rupturas, conciliados, consistencias };
}

module.exports = { init, conferirTodos, conferirLoja, buscarNotas, LOJA_CNPJ, TESTE_DIR };
