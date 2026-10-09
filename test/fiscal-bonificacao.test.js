const test = require('node:test'); const assert = require('node:assert/strict');
const fiscal = require('../lib/fiscal');

// Compra + bonificação na MESMA conferência (o ERP junta as duas NF-e do fornecedor; Bom Leite 09/10/2026,
// conf. 184824). O coletor conta um balde só por código, então a quantidade esperada é a soma — mas cada
// item precisa dizer o que é compra e o que é bonificação, e a margem só olha a parte comprada.
const LOJA = 2, CN = '11111111000111';
const CH_C = 'C'.repeat(44), CH_B = 'B'.repeat(44);
function partes({ bonifPrimeiro = false } = {}) {
  const compra = { nCompra: 101, nNota: '2537087', Serie: '1', nLoja: LOJA, NomeFornec: 'BOM LEITE', CodFornec: 7, TotalNota: '300', Status: 'F', nConferencia: 184824, NumeroPedido: 0, Movimentacao: 'COMPRA', Tipo: 'PNF', chave: CH_C, DataEmissao: '2026-10-08', DataRecto: '2026-10-09', DataLan: '2026-10-09' };
  const bonif = { nCompra: 102, nNota: '2536775', Serie: '1', nLoja: LOJA, NomeFornec: 'BOM LEITE', CodFornec: 7, TotalNota: '153.77', Status: 'F', nConferencia: 184824, NumeroPedido: 0, Movimentacao: 'BONIFICACAO', Tipo: 'PNF', chave: CH_B, DataEmissao: '2026-10-08', DataRecto: '2026-10-09', DataLan: '2026-10-09' };
  const li = (nCompra, nn, mov, cod, qtd, custo, item) => ({ nCompra, nLoja: LOJA, Item: item, CodigoBarra: cod, Unid: 'UN', Qtd: String(qtd), QtdEmb: '1', QtdEntradaEstoque: String(qtd), Preco: String(custo), Custo: String(custo), PrecoVenda: '0', Descricao: cod, Cancelado: 0, ocEanTrib: cod, NNOTA: nn, SERIE: '1', Movimentacao: mov, Bonificacao: mov === 'BONIFICACAO' ? '1' : '0' });
  const itensCompra = [li(101, '2537087', 'COMPRA', 'POLPA', 24, 4.79, 1), li(101, '2537087', 'COMPRA', 'SUCO', 12, 1.83, 2)];
  const itensBonif = [li(102, '2536775', 'BONIFICACAO', 'POLPA', 6, 0, 1), li(102, '2536775', 'BONIFICACAO', 'COALHADA', 6, 0, 2)];
  const col = (cod, qtd) => ({ chave: '184824', codigobarra: cod, emb: 'UN', qtd: String(qtd), qtdemb: '1', status: 1, Reconferir: 0, DataValidade: '2027-01-10' });
  const cad = cod => ({ CodigoBarra: cod, Descricao: 'BOM LEITE ' + cod, qtdemb: '1', Unid: 'UN', TipoBalanca: 'U', P1: '7.99', P2: '7.99', P3: '7.99', P4: '7.99', P5: '7.99', P6: '7.99', custo: '0', UltimoCusto: '0', margem: '35', Validade: '0', CodDesativado: 0 });
  return {
    chaves: [{ nRegConf: 184824, Chave: CH_C, Obs: '0' }, { nRegConf: 184824, Chave: CH_B, Obs: 'BONIFICACAO' }],
    notas: [], prods: [], boletos: [], pedConf: [], pedidos: [], custoAnt: [], custos: {}, fornec: {}, margens: {}, histVal: {},
    compras: bonifPrimeiro ? [bonif, compra] : [compra, bonif],
    notaItens: bonifPrimeiro ? [...itensBonif, ...itensCompra] : [...itensCompra, ...itensBonif],
    coletor: [col('POLPA', 30), col('SUCO', 12), col('COALHADA', 6)],
    cadastro: { POLPA: cad('POLPA'), SUCO: cad('SUCO'), COALHADA: cad('COALHADA') }
  };
}
const conf = { nReg: 184824, nLoja: LOJA, CodFornec: 7, NomeFornec: 'BOM LEITE INDUSTRIAL LTDA', Status: 3, DataEntrada: '2026-10-09', HoraEntrada: '10:10:00' };
const cruzar = o => fiscal.cruzar(conf, partes(o), fiscal.CONFIG_PADRAO, null);
const item = (r, ean) => r.itens.find(i => i.ean === ean);

test('item que veio nas duas notas: quantidade esperada é a soma, mas guarda a parte de cada NF', () => {
  const r = cruzar();
  const p = item(r, 'POLPA');
  assert.equal(p.xml_qtd, 30); assert.equal(p.col_qtd, 30); assert.equal(p.dif_qtd, 0);
  assert.equal(p.xml_qtd_compra, 24); assert.equal(p.xml_qtd_bonif, 6);
  assert.equal(p.bonif_parcial, true); assert.equal(p.bonificacao, false);
  assert.deepEqual(p.por_nota.map(n => [n.nNota, n.mov, n.qtd]), [[2537087, 'compra', 24], [2536775, 'bonif', 6]]);
  assert.ok(!p.flags.some(f => f.nivel === 'erro'), 'não pode inventar falta/sobra: ' + JSON.stringify(p.flags));
});

test('margem do item misto usa o custo da parte COMPRADA, mesmo quando a linha da bonificação vem primeiro', () => {
  for (const bonifPrimeiro of [false, true]) {
    const p = item(cruzar({ bonifPrimeiro }), 'POLPA');
    assert.equal(p.custo_xml, 4.79, 'bonifPrimeiro=' + bonifPrimeiro);
    assert.equal(p.margem, Math.round((7.99 - 4.79) / 7.99 * 10000) / 100);
  }
});

test('item que veio só na bonificação: marcado, sem margem e sem erro', () => {
  const c = item(cruzar(), 'COALHADA');
  assert.equal(c.bonificacao, true); assert.equal(c.bonif_parcial, false);
  assert.equal(c.xml_qtd_compra, 0); assert.equal(c.xml_qtd_bonif, 6);
  assert.equal(c.margem, null);
  assert.ok(!c.flags.some(f => f.nivel === 'erro'));
});

test('item só da compra continua compra normal', () => {
  const s = item(cruzar(), 'SUCO');
  assert.equal(s.bonificacao, false); assert.equal(s.bonif_parcial, false);
  assert.equal(s.xml_qtd_compra, 12); assert.equal(s.xml_qtd_bonif, 0);
  assert.equal(s.por_nota.length, 1);
});

test('cabeçalho: itens por nota e contagem compra × bonificação', () => {
  const r = cruzar();
  assert.equal(r.qtd_itens_xml, 3); assert.equal(r.qtd_itens_compra, 2); assert.equal(r.qtd_itens_bonif, 2);
  const nf = n => r.notas.find(x => x.nNota === n);
  assert.equal(nf(2537087).itens_lancados, 2); assert.equal(nf(2537087).movimentacao, 'COMPRA');
  assert.equal(nf(2536775).itens_lancados, 2); assert.equal(nf(2536775).movimentacao, 'BONIFICACAO');
  assert.equal(r.checks.coletor.nivel, 'ok', r.checks.coletor.msg);
  // a lista mostra o que veio na bonificação (item × quantidade), separado da compra
  assert.deepEqual(r.bonif_itens.map(i => [i.descricao, i.qtd]).sort(), [['BOM LEITE COALHADA', 6], ['BOM LEITE POLPA', 6]].sort());
});

test('nota ainda não lançada: bonificação sai do CFOP 5910 do XML', () => {
  const p = partes(); p.compras = []; p.notaItens = [];
  p.notas = [
    { nReg: 1, nNota: 2537087, nSerie: '1', nMod: '55', Data: '2026-10-08', CNPJemit: CN, NomeEmit: 'BOM LEITE', ValorNFE: '300', ValorProduto: '300', Chave: CH_C, Importado: 1, Status: 0, Leu: 0 },
    { nReg: 2, nNota: 2536775, nSerie: '1', nMod: '55', Data: '2026-10-08', CNPJemit: CN, NomeEmit: 'BOM LEITE', ValorNFE: '153.77', ValorProduto: '153.77', Chave: CH_B, Importado: 1, Status: 0, Leu: 0 }
  ];
  const px = (nn, cod, qtd, v, cfop, i) => ({ nNota: nn, CNPJemit: CN, nItem: i, CodigoItemFornec: cod, CodigoBarras: cod, ocEanTrib: cod, Descricao: cod, Und: 'UN', Qtd: String(qtd), ValorUnit: String(v), ValorTotal: String(qtd * v), oqTrib: String(qtd), ouTrib: 'UN', ovUnTrib: String(v), NCM: '0', CFOP: cfop });
  p.prods = [px(2537087, 'POLPA', 24, 4.79, '5102', 1), px(2537087, 'SUCO', 12, 1.83, '5102', 2), px(2536775, 'POLPA', 6, 4.79, '5910', 1), px(2536775, 'COALHADA', 6, 2.69, '5910', 2)];
  const r = fiscal.cruzar(conf, p, fiscal.CONFIG_PADRAO, null);
  assert.equal(item(r, 'POLPA').bonif_parcial, true); assert.equal(item(r, 'POLPA').xml_qtd, 30);
  assert.equal(item(r, 'COALHADA').bonificacao, true); assert.equal(item(r, 'COALHADA').margem, null);
  assert.equal(item(r, 'SUCO').bonificacao, false);
});
