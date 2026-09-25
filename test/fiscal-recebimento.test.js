const test = require('node:test'); const assert = require('node:assert/strict');
const fiscal = require('../lib/fiscal');

// Mescla do Coletor Econômico (lib/recebimento.js) na linha do Fiscal: funções puras, sem ERP.
// `row` é o que cruzar() devolve (só os campos usados); `conf` é uma conferência nossa.
function row(extra = {}) {
  return {
    nReg: 1234, loja: 3, notas: [{ nNota: 4501 }],
    itens: [
      { ean: '789', descricao: 'ARROZ 5KG', xml_qtd: 10, col_qtd: 10 },
      { ean: '456', descricao: 'FEIJAO 1KG', xml_qtd: 4, col_qtd: 4 }
    ],
    checks: { xml: { nivel: 'ok', msg: '1 NF-e com XML' }, pedido: { nivel: 'ok', msg: 'Pedido bate com a nota' } },
    situacao: 'pronto', veredito: 'ok', ...extra
  };
}
function conf(extra = {}) {
  return {
    id: '2026-09-25-3-4501', loja: 3, nNota: '4501', nome: 'MAYRA', status: 'terminada', recontagens: 1,
    itens: {
      '789': { cod: '789', descricao: 'ARROZ 5KG', quant: 10, emb: 1, emb_label: 'UN', un: 10, validade: '2027-01-10', estado: 'ok' },
      '456': { cod: '456', descricao: 'FEIJAO 1KG', quant: 1, emb: 4, emb_label: 'FD', un: 4, validade: null, estado: 'ok' }
    },
    erp: { nReg: 1234, erros: [], ultimoLogId: 'LOG9' }, ...extra
  };
}

test('mesclarEconomico anexa a conferência nossa e mantém pronto quando pedido, XML e físico batem', () => {
  const r = fiscal.mesclarEconomico(row(), conf(), []);
  assert.equal(r.economico.id, '2026-09-25-3-4501');
  assert.equal(r.economico.status, 'terminada');
  assert.equal(r.economico.recontagens, 1);
  assert.equal(r.economico.erp.nReg, 1234);
  assert.equal(r.economico.erp.erros, 0);
  assert.equal(r.economico.erp.ultimoLogId, 'LOG9');
  assert.equal(r.economico.itens.length, 2);
  assert.deepEqual(r.economico.itens.find(i => i.cod === '456'), { cod: '456', descricao: 'FEIJAO 1KG', quant: 1, emb: 4, emb_label: 'FD', un: 4, validade: null, estado: 'ok', aviso: null });
  assert.equal(r.checks.fisico.nivel, 'ok');
  assert.equal(r.situacao, 'pronto');
  assert.deepEqual(r.economico.motivos, []);
});

test('conferência física com falta e sobra vira excecao com os motivos', () => {
  const c = conf();
  c.itens['789'].un = 8;                                                         // faltaram 2 na nota de 10
  c.itens['999'] = { cod: '999', descricao: 'SABAO', quant: 3, emb: 1, un: 3, estado: 'nao_esta_na_nota' };  // não está na nota
  const r = fiscal.mesclarEconomico(row(), c, []);
  assert.equal(r.checks.fisico.nivel, 'erro');
  assert.equal(r.situacao, 'excecao');
  assert.equal(r.veredito, 'divergente');
  const difs = r.economico.fisico.diferencas;
  assert.equal(difs.length, 2);
  assert.deepEqual(difs.find(d => d.cod === '789'), { cod: '789', descricao: 'ARROZ 5KG', nota: 10, fisico: 8, dif: -2, tipo: 'falta' });
  assert.equal(difs.find(d => d.cod === '999').tipo, 'nao_na_nota');
  assert.ok(r.economico.motivos.some(m => /Conferência física/.test(m)));
});

test('item recusado pelo(a) comprador(a) (origem compras) não conta como diferença de contagem', () => {
  const c = conf();
  delete c.itens['456'];   // o comprador recusou: a loja nem bipou
  const dev = [{ cod: '456', descricao: 'FEIJAO 1KG', qtd: 4, origem: 'compras', motivo: 'recusado pelo(a) comprador(a) na conferência XML' }];
  const r = fiscal.mesclarEconomico(row(), c, dev);
  assert.equal(r.checks.fisico.nivel, 'ok');
  assert.equal(r.situacao, 'pronto');
  assert.equal(r.economico.devolucoes.length, 1);
  assert.equal(r.economico.devolucoes[0].origem, 'compras');
});

test('conferência ainda aberta (bipando/recontando) fica pendente, nunca pronto', () => {
  for (const st of ['bipando', 'recontando']) {
    const r = fiscal.mesclarEconomico(row(), conf({ status: st }), []);
    assert.equal(r.checks.fisico.nivel, 'pendente', st);
    assert.equal(r.situacao, 'em_contagem', st);
    assert.deepEqual(r.economico.fisico.diferencas, []);
  }
});

test('erro de pedido ou de XML mantém a linha em excecao e entra nos motivos', () => {
  const comPedidoRuim = row({ checks: { xml: { nivel: 'ok', msg: 'ok' }, pedido: { nivel: 'erro', msg: '1 item(ns) com preço acima do pedido' } } });
  const r = fiscal.mesclarEconomico(comPedidoRuim, conf(), []);
  assert.equal(r.situacao, 'excecao');
  assert.ok(r.economico.motivos.some(m => /Pedido de compra/.test(m)));
  const comXmlRuim = row({ checks: { xml: { nivel: 'erro', msg: '1 nota(s) sem XML no ERP' }, pedido: { nivel: 'ok', msg: 'ok' } } });
  const r2 = fiscal.mesclarEconomico(comXmlRuim, conf(), []);
  assert.equal(r2.situacao, 'excecao');
  assert.ok(r2.economico.motivos.some(m => /XML da NF-e/.test(m)));
});

test('situação já decidida (liberado/bloqueado/cancelado/reconferir) não é sobrescrita pelo físico', () => {
  for (const sit of ['liberado', 'bloqueado', 'cancelado', 'reconferir']) {
    const c = conf(); c.itens['789'].un = 1;   // físico divergente de propósito
    const r = fiscal.mesclarEconomico(row({ situacao: sit }), c, []);
    assert.equal(r.situacao, sit);
    assert.equal(r.checks.fisico.nivel, 'erro');
  }
});

test('nota ainda sem itens pra comparar: físico pendente, sem diferenças inventadas', () => {
  const r = fiscal.mesclarEconomico(row({ itens: [] }), conf(), []);
  assert.equal(r.checks.fisico.nivel, 'pendente');
  assert.match(r.checks.fisico.msg, /sem itens/);
});

test('conferenciaFisica conta os erros de gravação no ERP e o último erro', () => {
  const c = conf({ erp: { nReg: null, erros: [{ em: 'x', tipo: 'liberar', erro: 'fora do ar' }], ultimoLogId: null } });
  const r = fiscal.mesclarEconomico(row(), c, []);
  assert.equal(r.economico.erp.nReg, null);
  assert.equal(r.economico.erp.erros, 1);
  assert.equal(r.economico.erp.ultimo_erro, 'fora do ar');
});

test('sem conferência nossa a linha volta intacta', () => {
  const r0 = row();
  const r = fiscal.mesclarEconomico(r0, null, []);
  assert.equal(r, r0);
  assert.ok(!('economico' in r));
  assert.ok(!('fisico' in r.checks));
});
