// Nota de DEVOLUÇÃO não é entrega (16/10/2026, Nordeste Bebidas, pedido 108 Loja 1): o fornecedor emitiu 3 notas pra loja —
// a 53341 (CFOP 5405, venda) e duas contranotas de devolução (CFOP 1411). A conferência somava as três: 96 un pra 36 pedidas,
// "veio a mais". Agora a nota cujos itens são todos de devolução/entrada fica fora da conferência e aparece só informada.
const test = require('node:test');
const assert = require('node:assert/strict');
const cx = require('../lib/conferencia-xml');

test('naoEntrega: CFOP de entrada do emitente (1xxx/2xxx/3xxx) e devolução/retorno; venda, bonificação e compra normal não', () => {
  for (const c of ['1411', '2411', '1202', '3102', '5411', '6202', '5912', '6916']) assert.equal(cx.naoEntrega(c), true, c);
  for (const c of ['5405', '5102', '6102', '5910', '5116', '', null, '54']) assert.equal(cx.naoEntrega(c), false, String(c));
});

const CAB = [
  { nReg: 1, nNota: 53341, nSerie: '1', data: '2026-10-07', CNPJemit: '41844857000256', NomeEmit: 'NORDESTE', ValorNFE: '563,70', ValorProduto: '563,70', ValorDesconto: '0', ValorFrete: '0', ValorIPI: '0', ValorICMSsub: '0', Chave: 'CH53341', Importado: 0, Status: 0 },
  { nReg: 2, nNota: 53677, nSerie: '1', data: '2026-10-09', CNPJemit: '41844857000256', NomeEmit: 'NORDESTE', ValorNFE: '375,80', ValorProduto: '375,80', ValorDesconto: '0', ValorFrete: '0', ValorIPI: '0', ValorICMSsub: '0', Chave: 'CH53677', Importado: 0, Status: 0 },
  { nReg: 3, nNota: 53846, nSerie: '1', data: '2026-10-13', CNPJemit: '41844857000256', NomeEmit: 'NORDESTE', ValorNFE: '563,70', ValorProduto: '563,70', ValorDesconto: '0', ValorFrete: '0', ValorIPI: '0', ValorICMSsub: '0', Chave: 'CH53846', Importado: 0, Status: 0 }
];
const prod = (cfop, qtd, cod, desc, vu) => ({ nItem: 1, CodigoItemFornec: '', CodigoBarras: cod, ocEanTrib: cod, Descricao: desc, Und: 'CX', Qtd: String(qtd), ValorUnit: String(vu), ValorTotal: String(qtd * vu), ValorDesconto: '0', oqTrib: String(qtd * 12), ovUnTrib: String(vu / 12), CFOP: cfop });
const PRODS = {
  53341: [prod('5405', 3, '7898012860537', 'VODKA SLOVA 970ML CX/12', 133), { ...prod('5405', 3, '7898012862371', 'VODKA SLOVA 300ML CX/12', 54.9), nItem: 2 }],
  53677: [prod('1411', 2, '7898012860537', 'VODKA SLOVA 970ML CX/12', 133), { ...prod('1411', 2, '7898012862371', 'VODKA SLOVA 300ML CX/12', 54.9), nItem: 2 }],
  53846: [prod('1411', 3, '7898012860537', 'VODKA SLOVA 970ML CX/12', 133), { ...prod('1411', 3, '7898012862371', 'VODKA SLOVA 300ML CX/12', 54.9), nItem: 2 }]
};
function erp() {
  cx.init(async (sql, params) => {
    if (/MAX\(nReg\)/.test(sql)) return [{ m: 0 }];
    if (/FROM central\.fornecedor/.test(sql)) return [{ CNPJ: '41.844.857/0002-56' }];
    if (/FROM central\.fornecedoritens/.test(sql)) return [];
    if (/FROM central\.axml WHERE/.test(sql)) return CAB;
    if (/axmlprodutos/.test(sql)) return PRODS[params[0]] || [];
    if (/axmlboletos/.test(sql)) return params[0] === 'CH53341' ? [{ ndup: 1, dataVencto: '2026-11-05', vencimento: '2026-11-05', valor: '563,70' }] : [];
    return [];
  });
}
const pedido = () => ({ id: 108, status: 'aprovado', codFornec: 1920, fornecedor: 'NORDESTE COMERCIO E INDUSTRIA DE BEBIDAS', lojas: [1], criadoEm: '2026-10-06T11:53:29.742Z', aprovadoEm: '2026-10-06T11:53:29.742Z',
  cotacao: { id: 2 }, itens: [
    { cod: '7898012860537', descricao: 'SLOVA VODKA 970ML', unid: 'UN', emb: 12, qtd: 36, lojas_qtd: { 1: 36 }, preco: 11.0833 },
    { cod: '7898012862371', descricao: 'SLOVA VODKA 300ML PET', unid: 'UN', emb: 12, qtd: 36, lojas_qtd: { 1: 36 }, preco: 4.575 }
  ] });

test('buscarNotas marca a nota pelo CFOP: venda = entrega, contranota de devolução = devolucao', async () => {
  erp();
  const N = await cx.buscarNotas('41844857', 1, '2026-10-05', '2026-11-05');
  assert.deepEqual(N.map(n => [n.nNota, n.tipo]), [[53341, 'entrega'], [53677, 'devolucao'], [53846, 'devolucao']]);
  assert.equal(N[0].itens[0].cfop, '5405'); assert.equal(N[1].itens[0].cfop, '1411');
});

test('conferirTodos: só a venda entra na conferência (36 de cada, bate); as devoluções ficam em notas_fora', async () => {
  erp();
  const p = pedido(); const salvos = [];
  await cx.conferirTodos({ listar: () => [p], salvar: q => salvos.push(q.id), criarOuMesclarRuptura: () => {} });
  const x = p.xml.lojas[1];
  assert.deepEqual(x.notas.map(n => n.nNota), [53341]);
  assert.deepEqual(x.itens.map(i => [i.cod, i.recebida, i.tipo]), [['7898012860537', 36, 'ok'], ['7898012862371', 36, 'ok']]);
  assert.equal(x.status, 'conciliado');
  assert.deepEqual(x.notas_fora.map(n => [n.nNota, n.data, n.valorNFE, n.cfops]), [[53677, '2026-10-09', 375.8, ['1411']], [53846, '2026-10-13', 563.7, ['1411']]]);
  assert.deepEqual(salvos, [108]);
});

test('loja sem entrega mas com devolução no período: continua aguardando e informa a nota fora', async () => {
  erp();
  const p = pedido(); p.aprovadoEm = p.criadoEm = '2026-10-08T11:00:00.000Z';   // janela começa em 07/10: a venda de 07/10 ainda entra (desde-1)… então aprova dia 09
  p.aprovadoEm = p.criadoEm = '2026-10-09T11:00:00.000Z';
  const cab = CAB.filter(c => c.nNota !== 53341);
  cx.init(async (sql, params) => {
    if (/MAX\(nReg\)/.test(sql)) return [{ m: 0 }];
    if (/FROM central\.fornecedor/.test(sql)) return [{ CNPJ: '41844857000256' }];
    if (/FROM central\.fornecedoritens/.test(sql)) return [];
    if (/FROM central\.axml WHERE/.test(sql)) return cab;
    if (/axmlprodutos/.test(sql)) return PRODS[params[0]] || [];
    return [];
  });
  const salvos = [];
  await cx.conferirTodos({ listar: () => [p], salvar: q => salvos.push(q.id), criarOuMesclarRuptura: () => {} });
  const x = p.xml.lojas[1];
  assert.equal(x.status, 'aguardando'); assert.equal(x.notas.length, 0);
  assert.deepEqual(x.notas_fora.map(n => n.nNota), [53677, 53846]);
  assert.deepEqual(salvos, [108]);
  // rodada seguinte igual: nada muda, não salva de novo
  salvos.length = 0;
  await cx.conferirTodos({ listar: () => [p], salvar: q => salvos.push(q.id), criarOuMesclarRuptura: () => {} });
  assert.deepEqual(salvos, []);
});
