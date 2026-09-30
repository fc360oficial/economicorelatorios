const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../lib/escopo');

test('lojasDoBody: só 1..6 e 10, sem repetição; vazio/inválido = null', () => {
  assert.deepEqual(e.lojasDoBody([10, '3', 3, 99, 'x']), [3, 10]);
  assert.equal(e.lojasDoBody([]), null);
  assert.equal(e.lojasDoBody(null), null);
  assert.equal(e.lojasDoBody('10'), null);
});
test('lojasDoUsuario: admin/gerencial/sem campo = null', () => {
  assert.equal(e.lojasDoUsuario({ perfil: 'admin', lojas: [10] }), null);
  assert.equal(e.lojasDoUsuario({ perfil: 'gerencial', lojas: [10] }), null);
  assert.equal(e.lojasDoUsuario({ perfil: 'usuario' }), null);
  assert.deepEqual(e.lojasDoUsuario({ perfil: 'usuario', lojas: [10, 2] }), [2, 10]);
});
test('podeLoja', () => {
  assert.equal(e.podeLoja({ perfil: 'usuario', lojas: [10] }, 10), true);
  assert.equal(e.podeLoja({ perfil: 'usuario', lojas: [10] }, '10'), true);
  assert.equal(e.podeLoja({ perfil: 'usuario', lojas: [10] }, 3), false);
  assert.equal(e.podeLoja({ perfil: 'usuario' }, 3), true);
});
test('resolverLoja: sem restrição devolve o pedido; restrito força a lista', () => {
  const livre = { perfil: 'usuario' }, cd = { perfil: 'usuario', lojas: [10] }, duas = { perfil: 'usuario', lojas: [1, 2] };
  assert.deepEqual(e.resolverLoja(livre, 3), { loja: 3, lojas: null });
  assert.deepEqual(e.resolverLoja(livre, null), { loja: null, lojas: null });
  assert.deepEqual(e.resolverLoja(cd, null), { loja: 10, lojas: [10] });
  assert.deepEqual(e.resolverLoja(cd, 10), { loja: 10, lojas: [10] });
  assert.deepEqual(e.resolverLoja(duas, null), { loja: null, lojas: [1, 2] });
  assert.deepEqual(e.resolverLoja(duas, 2), { loja: 2, lojas: [2] });
  assert.throws(() => e.resolverLoja(cd, 3), err => err.status === 403);
});
test('filtrarPorLoja', () => {
  const lista = [{ loja: 1 }, { loja: 10 }, { loja: 3 }];
  assert.deepEqual(e.filtrarPorLoja({ perfil: 'usuario', lojas: [10] }, lista, x => x.loja), [{ loja: 10 }]);
  assert.equal(e.filtrarPorLoja({ perfil: 'admin' }, lista, x => x.loja), lista);
});

// ── fase 2: compradora ──
test('compradorDoUsuario: só perfil comprador com nome', () => {
  assert.equal(e.compradorDoUsuario({ perfil: 'comprador', comprador_nome: 'ana kelly ' }), 'ANA KELLY');
  assert.equal(e.compradorDoUsuario({ perfil: 'admin', comprador_nome: 'ANA KELLY' }), null);
  assert.equal(e.compradorDoUsuario({ perfil: 'comprador' }), null);
  assert.equal(e.compradorDoUsuario(null), null);
});
test('listasDoUsuario: listas dela, nome que não bate = [] (falha fechada), sem trava = null', () => {
  const nregs = { 'ANA KELLY SILVA': [1, 2], 'PATRICIA PEREIRA': [3] };
  const resolve = n => n === 'ANA KELLY' ? 'ANA KELLY SILVA' : n;
  assert.deepEqual(e.listasDoUsuario({ perfil: 'comprador', comprador_nome: 'ANA KELLY' }, nregs, resolve), [1, 2]);
  assert.deepEqual(e.listasDoUsuario({ perfil: 'comprador', comprador_nome: 'NINGUEM' }, nregs, resolve), []);
  assert.equal(e.listasDoUsuario({ perfil: 'usuario' }, nregs, resolve), null);
});
test('filtrarPorLista e podeLista', () => {
  const u = { perfil: 'comprador', comprador_nome: 'PATRICIA PEREIRA' };
  const nregs = { 'ANA KELLY': [1, 2], 'PATRICIA PEREIRA': [3] };
  const lista = [{ nReg: 1 }, { nReg: 3 }, { nReg: '3' }];
  assert.deepEqual(e.filtrarPorLista(u, nregs, lista, x => x.nReg), [{ nReg: 3 }, { nReg: '3' }]);
  assert.equal(e.filtrarPorLista({ perfil: 'admin' }, nregs, lista, x => x.nReg), lista);
  assert.equal(e.podeLista(u, nregs, 3), true);
  assert.equal(e.podeLista(u, nregs, 1), false);
  assert.equal(e.podeLista({ perfil: 'usuario' }, nregs, 1), true);
});
