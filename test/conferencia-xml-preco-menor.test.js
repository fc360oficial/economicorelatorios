// Preço da nota MENOR que o digitado não trava a loja (29/09/2026). Caso real: pedido 17, Betânia 5,60 na nota × 5,70
// digitado, quantidade batendo, loja ficava em "Consistência XML" pra sempre. Preço menor = a favor da rede: concilia,
// o esperado passa a usar o preço da nota, e o item fica marcado como informação (preco_status 'menor').
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cx = require('../lib/conferencia-xml');

cx.init(async () => []);
const item = (cod, descricao, unidades, preco) => ({ item: 1, cod, descricao, und: 'UN', undTrib: 'UN', qtdCom: unidades, valorUnitCom: preco, unidades, precoUnit: preco, total: +(unidades * preco).toFixed(2), desconto: 0, conversao: 'trib' });
const nota = (nNota, itens) => { const v = +itens.reduce((s, i) => s + i.total, 0).toFixed(2); return { chave: 'CH' + nNota, nNota, serie: 1, data: '2026-09-29', cnpjEmit: '11111111000101', emitente: 'BETANIA', valorNFE: v, valorProduto: 0, desconto: 0, frete: 0, ipi: 0, st: 0, importado: false, status: null, itens, boletos: [{ dup: 1, vencimento: '2026-10-27', valor: v }] }; };
const pedido = (id, itens) => ({ id, teste: true, status: 'aprovado', codFornec: 83, fornecedor: 'BETANIA', lojas: [1], criadoEm: '2026-09-28T10:00:00.000Z', aprovadoEm: '2026-09-28T10:00:00.000Z',
  itens: itens.map(([cod, descricao, qtd, preco]) => ({ cod, descricao, emb: 1, qtd, lojas_qtd: { 1: qtd }, preco })) });
async function rodar(p, notas) {
  fs.writeFileSync(path.join(cx.TESTE_DIR, p.id + '.json'), JSON.stringify({ 1: notas }));
  const rupturas = [];
  await cx.conferirTodos({ listar: () => [p], salvar: () => {}, criarOuMesclarRuptura: (pp, ln, f) => rupturas.push(f.length) });
  try { fs.unlinkSync(path.join(cx.TESTE_DIR, p.id + '.json')); } catch (e) {}
  return rupturas;
}

test('preço menor na nota com quantidade batendo concilia a loja e usa o preço da nota no esperado', async () => {
  const p = pedido(9201, [['7898403780918', 'BETANIA LEITE PO 200G', 100, 5.70], ['7896259410133', 'CAMPONESA LEITE PO 200G', 550, 6.15]]);
  const rupturas = await rodar(p, [nota(1682228, [item('7898403780918', 'BETANIA LEITE PO 200G', 100, 5.60), item('7896259410133', 'CAMPONESA LEITE PO 200G', 550, 6.15)])]);
  const L = p.xml.lojas[1];
  assert.equal(L.status, 'conciliado');
  assert.deepEqual(L.problemas, []);
  assert.equal(L.financeiro.esperado, 3942.5);
  assert.equal(L.financeiro.nfe, 3942.5);
  const bet = L.itens.find(i => i.cod === '7898403780918');
  assert.equal(bet.tipo, 'ok');
  assert.equal(bet.preco_status, 'menor');
  assert.equal(bet.preco_xml, 5.6);
  assert.deepEqual(rupturas, []);
});

test('preço MAIOR continua travando a loja em consistência', async () => {
  const p = pedido(9202, [['7898403780918', 'BETANIA LEITE PO 200G', 100, 5.70]]);
  await rodar(p, [nota(1682229, [item('7898403780918', 'BETANIA LEITE PO 200G', 100, 5.90)])]);
  const L = p.xml.lojas[1];
  assert.equal(L.status, 'consistencia');
  assert.deepEqual(L.problemas.map(z => z.tipo), ['preco']);
  assert.equal(L.itens[0].preco_status, 'maior');
});
