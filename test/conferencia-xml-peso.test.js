// Nota em KG/L pra pedido em unidade (16/10/2026, Estivas Loja 6, pedido 169): a NF 2478862 trouxe DELICATA MARGARINA 500G como
// 18 KG a R$ 9,90 e o pedido era 36 potes a R$ 4,95. KG era "unitária" → parcial (18 de 36) e preço acima (9,90) FALSOS.
// Evidência pelo preço: 9,90 = 2 × 4,95 → 1 kg = 2 potes → 36 unidades a 4,95.
const test = require('node:test');
const assert = require('node:assert/strict');
const cx = require('../lib/conferencia-xml');

cx.init(async () => []);
const item = (cod, descricao, und, qtdCom, valorUnit, extra = {}) => ({ item: 1, cod, descricao, und, undTrib: und, qtdCom, valorUnitCom: valorUnit, unidades: qtdCom, precoUnit: valorUnit, total: +(qtdCom * valorUnit).toFixed(2), desconto: 0, conversao: 'unitaria', ...extra });
const nota = itens => ({ chave: 'CH1', nNota: 2478862, serie: 1, data: '2026-10-16', cnpjEmit: '08029696000352', emitente: 'ESTIVAS', valorNFE: +itens.reduce((s, i) => s + i.total, 0).toFixed(2), valorProduto: 0, desconto: 0, frete: 0, ipi: 0, st: 0, importado: true, itens, boletos: [{ dup: 1, vencimento: '2026-10-23', valor: +itens.reduce((s, i) => s + i.total, 0).toFixed(2) }] });
const pedido = itens => ({ id: 169, status: 'aprovado', codFornec: 387, lojas: [6], criadoEm: '2026-10-15T19:14:50.282Z', aprovadoEm: '2026-10-15T19:14:50.350Z',
  itens: itens.map(([cod, descricao, unid, emb, qtd, preco]) => ({ cod, descricao, unid, emb, qtd, lojas_qtd: { 6: qtd }, preco })) });

test('nota em KG com preço = 2 × combinado → 2 unidades por kg: quantidade e preço batem', () => {
  const p = pedido([['7894904928989', 'DELICATA MARGARINA 500G', 'UN', 12, 36, 4.95], ['7896259411628', 'CAMPONESA CREME LEITE 200G TP', 'UN', 27, 405, 2.47]]);
  const n = nota([item('7894904928989', 'MARGARINA DELICATA 500G', 'KG', 18, 9.9), item('7896259411628', 'CREME DE LEITE CAMPONESA', 'CX', 15, 66.49, { conversao: 'pendente' })]);
  const r = cx.conferirLoja(p, 6, [n], { itensFornec: {} });
  const m = r.itens.find(i => i.cod === '7894904928989');
  assert.equal(m.recebida, 36); assert.equal(m.tipo, 'ok'); assert.equal(m.preco_xml, 4.95); assert.equal(m.preco_status, 'ok');
  assert.deepEqual(m.xml[0], { qtdCom: 18, und: 'KG', valorUnitCom: 9.9, unidades: 36, conversao: 'peso', fator: 2 });
  assert.equal(r.faltas, 0); assert.equal(r.status, 'conciliado');
});

test('não converte quando o pedido também é em peso, quando o preço não é múltiplo inteiro, ou quando a nota já traz tributável', () => {
  // pedido em KG (carne, hortifruti): 18 kg são 18 kg
  let r = cx.conferirLoja(pedido([['1', 'ALCATRA KG', 'KG', 1, 18, 39.9]]), 6, [nota([item('1', 'ALCATRA', 'KG', 18, 39.9)])], { itensFornec: {} });
  assert.equal(r.itens[0].recebida, 18); assert.equal(r.itens[0].xml[0].conversao, 'unitaria');
  // preço da nota 1,3× o combinado: não é múltiplo → fica como veio (parcial + preço acima, pra alguém olhar)
  r = cx.conferirLoja(pedido([['2', 'QUEIJO 500G', 'UN', 1, 36, 10]]), 6, [nota([item('2', 'QUEIJO', 'KG', 18, 13)])], { itensFornec: {} });
  assert.equal(r.itens[0].recebida, 18); assert.equal(r.itens[0].tipo, 'parcial');
  // nota com tributável diferente (trib): a conversão já veio da nota
  r = cx.conferirLoja(pedido([['3', 'MARGARINA 500G', 'UN', 1, 36, 4.95]]), 6, [nota([item('3', 'MARGARINA', 'KG', 18, 9.9, { conversao: 'trib', unidades: 36, precoUnit: 4.95 })])], { itensFornec: {} });
  assert.equal(r.itens[0].recebida, 36); assert.equal(r.itens[0].xml[0].conversao, 'trib');
});
