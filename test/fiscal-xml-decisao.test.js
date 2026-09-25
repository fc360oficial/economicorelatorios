const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/fiscal');

const pedido = {
  id: 12, status: 'aprovado', codFornec: 1499, lojas: [4],
  itens: [{ cod: '7896005805114', unid: 'DIS' }],
  xml: { lojas: { 4: {
    status: 'consistencia', notas: [{ chave: 'CH1' }],
    itens: [{ cod: '7896005805114', pedida: 4, recebida: 16, tipo: 'a_mais', preco_digitado: 17.6, preco_xml: 17.6, decisao: { acao: 'aceitar', por: 'Tiago Freire', em: '2026-09-25T11:30:00.000Z' } }],
    nao_pedidos: [{ cod: '7896045112135', recebida: 18, preco_xml: 0.66, decisao: { acao: 'recusar', por: 'Donato', em: '2026-09-25T12:00:00.000Z' } }],
    aceito: { por: 'Tiago Freire', em: '2026-09-25T12:10:00.000Z', motivo: 'fornecedor vai mandar nota de devolução' },
  } } },
};

test('pedidoAppPorCod leva a decisão de cada item e o aceite da loja', () => {
  F.init(async () => [], { pedidos: () => [pedido] });
  const r = F.pedidoAppPorCod(1499, 4, ['CH1']);
  assert.deepEqual(r.ids, [12]);
  assert.equal(r.map['7896005805114'].decisao.por, 'Tiago Freire');
  assert.equal(r.map['7896045112135'].decisao.acao, 'recusar');
  assert.equal(r.aceitos.length, 1); assert.equal(r.aceitos[0].por, 'Tiago Freire'); assert.equal(r.aceitos[0].pedido, 12);
});

test('flagDecisao: texto de liberado / recusado', () => {
  const a = F.flagDecisao({ decisao: { acao: 'aceitar', por: 'Tiago Freire', em: '2026-09-25T11:30:00.000Z' }, tipo: 'a_mais' });
  assert.equal(a.nivel, 'info'); assert.equal(a.tipo, 'xml_decisao');
  assert.equal(a.msg, 'Liberado por Tiago Freire em 25/09 (item a mais)');
  const r = F.flagDecisao({ decisao: { acao: 'recusar', por: 'Donato', em: '2026-09-25T12:00:00.000Z' }, nao_pedido: true });
  assert.equal(r.msg, 'Recusado por Donato em 25/09 (item não pedido) — devolver');
  assert.equal(F.flagDecisao({ decisao: { acao: 'aceitar', por: null, em: '2026-09-25T11:30:00.000Z' }, tipo: 'preco' }).msg, 'Liberado em 25/09 (preço)');
  assert.equal(F.flagDecisao({}), null);
});
