const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/pedido-erp');

const p = {
  id: 77, lista: 484, lista_nome: 'DOCES SEMANAL', fornecedor: 'RECIFE DOCES E CARAMELOS', codFornec: 48,
  vendedor: { nome: 'SUENE', whats: '(81) 98705-6602' }, comprador: { nome: 'DONATO' }, prazo_pagamento: 'BOLETO 28DD', pedido_minimo: '400,00',
  status: 'aprovado', aprovadoPor: 'Tiago', lojas: [1, 2],
  itens: [
    { cod: '7898279790387', descricao: 'FINI BALA 100G AROS DE MORANGO DP|12', unid: 'UN', emb: 12, lojas_qtd: { 1: 12, 2: 24 }, ultimo_custo: 4.52, preco: 5.56 },
    { cod: '7898279790400', descricao: 'FINI BALA 100G BEIJOS', unid: 'UN', emb: 12, lojas_qtd: { 1: 0, 2: 12 }, ultimo_custo: 5.30, preco: null },
  ],
};
const forn = { CodFornec: 48, Nome: 'RECIFE DOCES E CARAMELOS', CNPJ: '02.678.694/0002-27', CodPrazo: 3, Celular: '' };

test('itensDaLoja: só itens com quantidade na loja; sem preço usa último custo', () => {
  const l1 = P.itensDaLoja(p, 1);
  assert.equal(l1.length, 1); assert.equal(l1[0].qtd, 12); assert.equal(l1[0].preco, 5.56); assert.equal(l1[0].total, 66.72);
  const l2 = P.itensDaLoja(p, 2);
  assert.equal(l2.length, 2); assert.equal(l2[1].preco, 5.3); assert.equal(l2[1].total, 63.6);
});

test('montarPassosPedido: cabeçalho + itens + envio no formato do Dlinks', () => {
  const r = P.montarPassosPedido({ p, ln: 2, fornecedor: forn, usuario: 'Tiago', hoje: '2026-09-24' });
  assert.equal(r.passos.length, 4);
  const cab = r.passos[0];
  assert.equal(cab.tabela, 'pedidocompra'); assert.equal(cab.operacao, 'insert');
  assert.equal(cab.valores.nLoja, 2); assert.equal(cab.valores.CodFornec, 48); assert.equal(cab.valores.CNPJFornec, '02678694000227');
  assert.equal(cab.valores.Total, 197.04); assert.equal(cab.valores.Status, 1); assert.equal(cab.valores.nLista, 484);
  assert.equal(cab.valores.whats, '81987056602'); assert.equal(cab.valores.CodPrazo, 3); assert.equal(cab.valores.Vendedor, 'SUENE');
  assert.equal(cab.valores.Obs, 'Radar #77'); assert.equal(cab.valores.DataPedido, '2026-09-24'); assert.equal(cab.valores.NomeAutorizacao, 'Tiago');
  const it = r.passos[1];
  assert.equal(it.tabela, 'pedidocompraproduto'); assert.deepEqual(it.valores.nPedido, { $id: 0 });
  assert.equal(it.valores.CodigoBarra, '7898279790387'); assert.equal(it.valores.Qtd, 24); assert.equal(it.valores.ValorUnit, 5.56); assert.equal(it.valores.Total, 133.44); assert.equal(it.valores.nSeq, 1); assert.equal(it.valores.nLoja, 2);
  assert.equal(r.passos[2].valores.nSeq, 2);
  const env = r.passos[3];
  assert.equal(env.tabela, 'pedidocompraenvio'); assert.deepEqual(env.valores, { nPedido: { $id: 0 }, email: 0, whats: 1 });
  assert.equal(r.total, 197.04);
});

test('montarPassosPedido: loja sem item lança', () => {
  assert.throws(() => P.montarPassosPedido({ p, ln: 3, fornecedor: forn, usuario: 'T' }), /sem itens/);
});

test('motivoPedido', () => {
  assert.equal(P.motivoPedido(p, 2), 'Radar: pedido #77 RECIFE DOCES E CARAMELOS → ERP teste, loja 2');
});
