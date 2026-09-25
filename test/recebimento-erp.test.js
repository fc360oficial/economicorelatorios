const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/recebimento-erp');

const xmlLoja = {
  status: 'conciliado',
  notas: [{ nNota: 627396, serie: '0', data: '2026-09-23' }],
  itens: [
    { cod: '7896005800027', descricao: '3 CORACOES CAFE ALMOFADA 250G TRADICIONAL', pedida: 20, recebida: 20, preco_digitado: 12.37, preco_xml: 12.3675, xml: [{ und: 'CX' }] },
    { cod: '7896005801512', descricao: 'EXTRAFORTE', pedida: 20, recebida: 12, preco_digitado: 12.37, preco_xml: 12.37, xml: [] },
  ],
};

test('status 2 quando tudo veio, 7 quando faltou', () => {
  assert.equal(R.statusRecebimento({ itens: [{ pedida: 5, recebida: 5 }] }, 0), 2);
  assert.equal(R.statusRecebimento({ itens: [{ pedida: 5, recebida: 3 }] }, 0), 7);
  assert.equal(R.statusRecebimento({ itens: [{ pedida: 5, recebida: 5 }] }, 1), 7);
});

test('montarPassosRecebimento: cabeçalho + faturada + conferência por item, números com vírgula', () => {
  const r = R.montarPassosRecebimento({ nRegTeste: 63407, xmlLoja, faltas: 0 });
  assert.equal(r.status, 7); assert.equal(r.itens, 2); assert.equal(r.nNota, 627396);
  assert.equal(r.passos.length, 1 + 2 * 2);
  assert.deepEqual(r.passos[0], { tabela: 'pedidocompra', operacao: 'update', where: { nReg: 63407 }, valores: { Status: 7, RecebidoVendedor: 1 } });
  assert.deepEqual(r.passos[1], { tabela: 'pedidocompraproduto', operacao: 'update', where: { nPedido: 63407, CodigoBarra: '7896005800027' }, valores: { QtdFaturada: 20 } });
  const c = r.passos[2];
  assert.equal(c.tabela, 'pedidoitensconferidos'); assert.equal(c.operacao, 'insert');
  assert.equal(c.valores.nPedido, 63407); assert.equal(c.valores.nNota, '627396'); assert.equal(c.valores.Serie, '0'); assert.equal(c.valores.nItem, 1);
  assert.equal(c.valores.UndXml, 'CX'); assert.equal(c.valores.QtdPed, '20'); assert.equal(c.valores.QtdXml, '20');
  assert.equal(c.valores.PrecoPed, '12,37'); assert.equal(c.valores.PrecoXml, '12,37'); assert.equal(c.valores.TotalPed, '247,40'); assert.equal(c.valores.TotalXml, '247,35'); assert.equal(c.valores.Diferenca, '0,05');
  assert.equal(r.passos[4].valores.nItem, 2); assert.equal(r.passos[4].valores.QtdXml, '12'); assert.equal(r.passos[4].valores.UndXml, 'UN');
  assert.equal(r.passos[3].valores.QtdFaturada, 12);
});

test('sem itens ou sem nReg lança', () => {
  assert.throws(() => R.montarPassosRecebimento({ nRegTeste: 0, xmlLoja }), /sem número/);
  assert.throws(() => R.montarPassosRecebimento({ nRegTeste: 1, xmlLoja: { itens: [] } }), /sem itens/);
});

test('motivoRecebimento', () => {
  assert.equal(R.motivoRecebimento({ id: 12, fornecedor: 'TRES CORACOES ALIMENTOS SA' }, 2, 627396), 'Radar: recebimento do pedido #12 TRES CORACOES ALIMENTOS SA → ERP teste, loja 2, NF 627396');
});
