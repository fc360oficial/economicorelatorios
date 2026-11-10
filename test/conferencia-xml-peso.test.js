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
  r = cx.conferirLoja(pedido([['2', 'QUEIJO FATIADO', 'UN', 1, 36, 10]]), 6, [nota([item('2', 'QUEIJO', 'KG', 18, 13)])], { itensFornec: {} });
  assert.equal(r.itens[0].recebida, 18); assert.equal(r.itens[0].tipo, 'parcial');
  // nota com tributável diferente em UNIDADE (trib): a conversão já veio da nota
  r = cx.conferirLoja(pedido([['3', 'MARGARINA 500G', 'UN', 1, 36, 4.95]]), 6, [nota([item('3', 'MARGARINA', 'CX', 3, 59.4, { undTrib: 'UN', conversao: 'trib', unidades: 36, precoUnit: 4.95 })])], { itensFornec: {} });
  assert.equal(r.itens[0].recebida, 36); assert.equal(r.itens[0].xml[0].conversao, 'trib');
});

// 10/11/2026 (BRF #256 E6, NF-e 7113194): a nota vem em CX com a tributável em KG. 4 CX de calabresa 400 g = 19,2 kg → 48 unidades.
const brf = (cod, descricao, qtdCx, kg, total) => item(cod, descricao, 'CX', qtdCx, +(total / qtdCx).toFixed(2), { undTrib: 'KG', conversao: 'trib', unidades: kg, precoUnit: +(total / kg).toFixed(4), total });
test('tributável em KG e pedido em unidade → kg ÷ gramatura da unidade', () => {
  const p = pedido([
    ['7891515620981', 'SADIA CALABRESA 400G MISTA', 'UN', 12, 48, 10.3],
    ['7891515474126', 'PERDIGAO EMPANADO DE FRANGO 100G', 'UN', 45, 450, 1.46],
    ['7891515546335', 'SADIA BATATA PALITO PRE FRITA 1,050K', 'UN', 10, 10, 15.6],
    ['7891515554224', 'SADIA HAMBURGUER 56G MISTO', 'UN', 36, 72, 0.94],
    ['7891515606824', 'PERDIGAO LINGUICA MISTA COZ DEF 215', 'UN', 21, 21, 6.01],
    ['7891515430153', 'PERDIGAO MORTADELA 400G MISTA', 'UN', 15, 15, 4.76],
    ['7891515435134', 'PERDIGAO APRESUNTADO 200G FATIADO A VACUO', 'UN', 20, 10, 5.4]]);
  const n = nota([
    brf('7891515620981', 'LING. CALABRESA SADIA 400G CX 4,8KG', 4, 19.2, 490.75),
    brf('7891515474126', 'STEAK FGO EMP CONG IWP 100G PD', 10, 45, 656.1),
    brf('7891515546335', 'BATATA PALITO PRE-FRITA CONG SD 1,05KG', 1, 10.5, 155.19),
    brf('7891515554224', 'HAMBURGUER CARNE DE AVES E BOVINA 56G SD', 2, 4.032, 66.89),
    brf('7891515606824', 'LINGUICA MISTA COZ DEF PD PT 0,215KG', 1, 4.515, 126.1),
    brf('7891515430153', 'MORTADELA MISTA PERDIGAO CX 6KG', 1, 6, 71.28),
    brf('7891515435134', 'APRESUNTADO FATIADO 200G VACUO PD', 1, 4, 108)]);
  const r = cx.conferirLoja(p, 6, [n], { itensFornec: {} });
  const de = cod => r.itens.find(i => i.cod === cod);
  for (const c of ['7891515620981', '7891515474126', '7891515546335', '7891515554224', '7891515606824', '7891515430153']) { assert.equal(de(c).recebida, de(c).pedida, c); assert.equal(de(c).tipo, 'ok', c); assert.notEqual(de(c).preco_status, 'maior', c); }
  assert.deepEqual(de('7891515620981').xml[0], { qtdCom: 4, und: 'CX', valorUnitCom: 122.69, unidades: 48, conversao: 'gramatura', fator: 12, qtd_peso: 19.2, gram: 0.4, base: 'kg' });
  assert.equal(de('7891515606824').xml[0].gram, 0.215);   // gramatura só na descrição da nota
  // caixa de 20 pra um pedido de 10: divergência DE VERDADE continua aparecendo
  assert.equal(de('7891515435134').recebida, 20); assert.equal(de('7891515435134').tipo, 'a_mais');
});

test('gramatura não converte produto vendido por quilo nem peso que não fecha em unidade inteira', () => {
  // "KG" solto na descrição = vendido por peso: 26,33 kg são 26,33 kg
  let r = cx.conferirLoja(pedido([['407', 'PERDIGAO COSTELA SUINA KG NA BRASA', 'UN', 10, 20, 23.2]]), 6, [nota([brf('407', 'COSTELA SUI CONG NABRASA PD PVAR', 2, 26.33, 608.49)])], { itensFornec: {} });
  assert.equal(r.itens[0].recebida, 26.33); assert.equal(r.itens[0].xml[0].conversao, 'trib');
  // 5 kg ÷ 0,300 kg = 16,67: não fecha → fica como veio
  r = cx.conferirLoja(pedido([['9', 'NUGGETS 300G', 'UN', 16, 16, 7.4]]), 6, [nota([brf('9', 'NUGGETS', 1, 5, 118)])], { itensFornec: {} });
  assert.equal(r.itens[0].recebida, 5); assert.equal(r.itens[0].xml[0].conversao, 'trib');
  // tributável em UN não passa pela gramatura
  r = cx.conferirLoja(pedido([['8', 'MARGARINA 500G', 'UN', 12, 12, 8.7]]), 6, [nota([item('8', 'MARGARINA', 'CX', 1, 104.4, { undTrib: 'UN', conversao: 'trib', unidades: 12, precoUnit: 8.7 })])], { itensFornec: {} });
  assert.equal(r.itens[0].recebida, 12); assert.equal(r.itens[0].xml[0].conversao, 'trib');
});
