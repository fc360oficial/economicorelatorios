// Vínculo NF-e × pedido pelos ITENS (29/09/2026). Caso real: cotação gerou 4 pedidos do DIA no mesmo dia;
// a nota dos adoçantes (pedido 16) caiu no pedido 42 (Smirnoff), porque a busca só olhava CNPJ + loja + data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cx = require('../lib/conferencia-xml');

cx.init(async () => []);
const item = (cod, descricao, unidades, preco) => ({ item: 1, cod, descricao, und: 'UN', undTrib: 'UN', qtdCom: unidades, valorUnitCom: preco, unidades, precoUnit: preco, total: +(unidades * preco).toFixed(2), desconto: 0, conversao: 'trib' });
const nota = (nNota, itens) => ({ chave: 'CH' + nNota, nNota, serie: 1, data: '2026-09-29', cnpjEmit: '11111111000101', emitente: 'DIA', valorNFE: +itens.reduce((s, i) => s + i.total, 0).toFixed(2), valorProduto: 0, desconto: 0, frete: 0, ipi: 0, st: 0, importado: false, status: null, itens, boletos: [{ dup: 1, vencimento: '2026-10-13', valor: +itens.reduce((s, i) => s + i.total, 0).toFixed(2) }] });
const pedido = (id, criadoEm, itens, xml) => ({ id, teste: true, status: 'aprovado', codFornec: 83, fornecedor: 'DIA', lojas: [6], criadoEm, aprovadoEm: criadoEm,
  itens: itens.map(([cod, descricao, qtd, preco]) => ({ cod, descricao, emb: 1, qtd, lojas_qtd: { 6: qtd }, preco })), xml });
const gravar = (p, notas) => fs.writeFileSync(path.join(cx.TESTE_DIR, p.id + '.json'), JSON.stringify({ 6: notas }));
const limpar = ids => ids.forEach(id => { try { fs.unlinkSync(path.join(cx.TESTE_DIR, id + '.json')); } catch (e) {} });
async function rodar(pedidos, notas) {
  for (const p of pedidos) gravar(p, notas);            // o "ERP" devolve as mesmas notas pra todo pedido do fornecedor
  const salvos = {}; const rupturas = [];
  await cx.conferirTodos({ listar: () => pedidos.slice().sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)),   // mais novo primeiro, como listar() de verdade
    salvar: p => { salvos[p.id] = p; }, criarOuMesclarRuptura: (p, ln, f) => rupturas.push({ id: p.id, ln, faltas: f.length }) });
  limpar(pedidos.map(p => p.id));
  return { salvos, rupturas };
}

test('nota vai pro pedido que tem os itens dela, não pro pedido mais novo do mesmo fornecedor', async () => {
  const adocantes = pedido(9101, '2026-09-28T18:46:00.000Z', [['7896094906020', 'ADOCYL STEVIA', 36, 6.55], ['7896094914070', 'ADOCYL SUCRALOSE', 12, 6.10]]);
  const smirnoff = pedido(9102, '2026-09-28T21:20:00.000Z', [['7893218003603', 'SMIRNOFF ICE', 24, 5.74]]);
  const n1 = nota(2513636, [item('7896094906020', 'ADOCANTE ADOCYL STEVIA', 36, 6.55), item('7896094914070', 'ADOCANTE ADOCYL SUCRALOSE', 12, 6.10)]);
  const { rupturas } = await rodar([adocantes, smirnoff], [n1]);
  assert.deepEqual(adocantes.xml.lojas[6].notas.map(n => n.nNota), [2513636]);
  assert.equal(adocantes.xml.lojas[6].status, 'conciliado');
  assert.equal(smirnoff.xml.lojas[6].status, 'aguardando');
  assert.deepEqual(smirnoff.xml.lojas[6].notas, []);
  assert.deepEqual(rupturas, []);   // Smirnoff ainda não chegou: não é falta
});

test('nota sem nenhum item de nenhum pedido fica solta (pedido feito direto no Dlinks)', async () => {
  const p = pedido(9103, '2026-09-28T19:33:00.000Z', [['7891000307120', 'NESCAFE', 24, 4.13]]);
  const catchup = nota(2513589, [item('7896102502787', 'QUERO CATCHUP', 20, 3.5), item('7896102503814', 'HEINZ MOLHO', 24, 4.2)]);
  const { rupturas } = await rodar([p], [catchup]);
  assert.equal(p.xml.lojas[6].status, 'aguardando');
  assert.deepEqual(p.xml.lojas[6].notas, []);
  assert.deepEqual(rupturas, []);
});

test('vínculo errado antigo é desfeito quando a nota não tem item do pedido', async () => {
  const errado = { status: 'consistencia', notas: [{ chave: 'CH2513589', nNota: 2513589 }], itens: [{ cod: '7891000307120', pedida: 24, recebida: 0, tipo: 'falta' }], nao_pedidos: [{ cod: '7896102502787' }], problemas: [{ tipo: 'falta' }], ruptura_criada: true };
  const p = pedido(9104, '2026-09-28T19:33:00.000Z', [['7891000307120', 'NESCAFE', 24, 4.13]], { status: 'consistencia', lojas: { 6: errado } });
  p.status = 'recebido_parcial'; p.recebimento = { 6: { notas: [{ nNota: 2513589 }] } };
  const catchup = nota(2513589, [item('7896102502787', 'QUERO CATCHUP', 20, 3.5)]);
  await rodar([p], [catchup]);
  assert.equal(p.xml.lojas[6].status, 'aguardando');
  assert.deepEqual(p.xml.lojas[6].notas, []);
  assert.equal(p.xml.status, 'aguardando');
  assert.equal(p.status, 'aprovado');
  assert.equal(p.recebimento[6], undefined);
});

test('código DUN-14 ou com zero à esquerda no XML casa com o EAN do pedido', async () => {
  const p = pedido(9105, '2026-09-28T19:33:00.000Z', [['7891080150453', 'OLEO SOYA CANOLA', 20, 12.1], ['7891000416266', 'NESCAFE', 24, 4.13]]);
  const n = nota(2513637, [item('17891080150453', 'OLEO DE CANOLA SOYA', 20, 12.1), item('07891000416266', 'NESTLE NESCAFE', 24, 4.13)]);
  await rodar([p], [n]);
  const x = p.xml.lojas[6];
  assert.deepEqual(x.notas.map(n => n.nNota), [2513637]);
  assert.equal(x.status, 'conciliado');
  assert.deepEqual(x.nao_pedidos, []);
  assert.deepEqual(x.itens.map(i => [i.cod, i.recebida, i.tipo]), [['7891080150453', 20, 'ok'], ['7891000416266', 24, 'ok']]);
});

test('menos da metade dos itens da nota no pedido: vincula, mas avisa pra conferir se é este pedido', async () => {
  const p = pedido(9106, '2026-09-28T19:33:00.000Z', [['7896079441119', 'ARROZ NAMORADO', 10, 4.55], ['7891107111927', 'SALADA OLEO CANOLA', 20, 12.1]]);
  const n = nota(2513637, [item('7896079441119', 'ARROZ NAMORADO', 10, 4.55), item('17891080150453', 'OLEO SOYA CANOLA', 20, 12.1), item('17891080150477', 'OLEO SOYA GIRASSOL', 20, 12), item('7891080150456', 'OLEO SOYA MILHO', 20, 13.45), item('07891000416266', 'NESCAFE', 24, 4.13)]);
  await rodar([p], [n]);
  const x = p.xml.lojas[6];
  assert.deepEqual(x.notas.map(n => n.nNota), [2513637]);
  assert.equal(x.afinidade, 20);
  assert.ok(x.problemas.some(pr => pr.tipo === 'afinidade' && /conferir se é este pedido/i.test(pr.msg)), JSON.stringify(x.problemas));
});

test('empate de itens em comum: nota vai pro pedido mais antigo', async () => {
  const velho = pedido(9107, '2026-09-28T10:00:00.000Z', [['7896094906020', 'ADOCYL', 36, 6.55]]);
  const novo = pedido(9108, '2026-09-28T20:00:00.000Z', [['7896094906020', 'ADOCYL', 36, 6.55]]);
  const n = nota(2513640, [item('7896094906020', 'ADOCYL', 36, 6.55)]);
  await rodar([velho, novo], [n]);
  assert.deepEqual(velho.xml.lojas[6].notas.map(n => n.nNota), [2513640]);
  assert.equal(novo.xml.lojas[6].status, 'aguardando');
});
