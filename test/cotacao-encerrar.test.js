const test = require('node:test');
const assert = require('node:assert/strict');
const { podeEncerrar, pendentesReais, comparativo, resumo } = require('../lib/cotacao');

// "Pedidos gerados · a encerrar" (Tiago, 27/10/2026: "não tem nenhum pedido para fechar e ainda continua com o status em
// digitação"): cotação com todos os pedidos realizados e nenhum vencedor faltando, mas ainda 'aberta' porque o último
// fornecedor pendente foi zerado (ou marcado "não comprar") depois do último Realizar Pedido. Nada fecha sozinho: a lib só
// diz que pode encerrar; quem encerra é o(a) comprador(a) pela tela (fecharSeCompleta).
const tok = ch => ch.repeat(32);
const base = () => ({
  id: 4, nome: 'Cotação teste', status: 'aberta', criadoEm: '2026-10-26T16:50:29.324Z', lojas: [1, 2],
  itens: [
    { cod: '111', descricao: 'ARROZ', unid: 'UN', emb: 10, qtd: 20, volumes: 2, lojas_qtd: { 1: 10, 2: 10 }, ultimo_custo: 5 },
    { cod: '222', descricao: 'FEIJAO', unid: 'UN', emb: 10, qtd: 20, volumes: 2, lojas_qtd: { 1: 10, 2: 10 }, ultimo_custo: 8 },
  ],
  fornecedores: [
    { codFornec: 10, nome: 'FORN A', status: 'finalizado', token: tok('a'), vendedor: { nome: 'a' }, precos: { '111': { preco: 4 } } },
    { codFornec: 20, nome: 'FORN B', status: 'finalizado', token: tok('b'), vendedor: { nome: 'b' }, precos: { '222': { preco: 7 } } },
  ],
  vencedores: {}, prePedidos: {}, pedidos: [],
});
// A já realizou o pedido (#202); B ainda não
const comPedidoA = c => { c.pedidos = [{ id: 202, codFornec: 10, fornecedor: 'FORN A', itens: 1, total: 80, lojas: [1, 2] }]; c.prePedidos[10] = { status: 'realizado', pedidoId: 202 }; return c; };
const zeraB = c => { c.prePedidos[20] = { lojas_qtd: { '222': { 1: 0, 2: 0 } } }; return c; };

test('nada realizado: não pode encerrar (os 2 vencedores estão pendentes)', () => {
  const c = base();
  assert.equal(pendentesReais(c, comparativo(c)).length, 2);
  assert.equal(podeEncerrar(c), false);
  const r = resumo(c); assert.equal(r.pode_encerrar, false); assert.equal(r.pendentes_reais, 2);
});

test('A realizado e B com quantidade: ainda falta B', () => {
  const c = comPedidoA(base());
  assert.deepEqual(pendentesReais(c, comparativo(c)).map(f => f.codFornec), [20]);
  assert.equal(podeEncerrar(c), false);
  const r = resumo(c); assert.equal(r.pode_encerrar, false); assert.equal(r.pendentes_reais, 1);
});

test('B zerado no pré-pedido depois do último Realizar Pedido: pode encerrar e a cotação segue aberta (ninguém fecha sozinho)', () => {
  const c = zeraB(comPedidoA(base()));
  assert.equal(pendentesReais(c, comparativo(c)).length, 0);
  assert.equal(podeEncerrar(c), true);
  const r = resumo(c); assert.equal(r.pode_encerrar, true); assert.equal(r.pendentes_reais, 0); assert.equal(r.status, 'aberta');
  assert.equal(c.status, 'aberta', 'a lib não muda o status');
});

test('item de B marcado "não comprar": pode encerrar', () => {
  const c = comPedidoA(base()); c.vencedores = { '222': null };
  assert.equal(podeEncerrar(c), true);
  assert.equal(resumo(c).pode_encerrar, true);
});

test('sem nenhum pedido realizado não é "Pedidos gerados", mesmo sem ninguém pendente', () => {
  const c = base(); c.vencedores = { '111': null, '222': null };
  assert.equal(pendentesReais(c, comparativo(c)).length, 0);
  assert.equal(podeEncerrar(c), false);
  assert.equal(resumo(c).pode_encerrar, false);
});

test('cotação fechada ou cancelada nunca fica "a encerrar"', () => {
  for (const st of ['fechada', 'cancelada']) {
    const c = zeraB(comPedidoA(base())); c.status = st;
    assert.equal(podeEncerrar(c), false, st);
    const r = resumo(c); assert.equal(r.pode_encerrar, false, st); assert.equal(r.pendentes_reais, 0, st);
  }
});

test('aceita o comparativo já calculado e dá o mesmo resultado', () => {
  const c = zeraB(comPedidoA(base()));
  const cmp = comparativo(c);
  assert.equal(podeEncerrar(c, cmp), true);
  assert.equal(podeEncerrar(comPedidoA(base()), comparativo(comPedidoA(base()))), false);
});
