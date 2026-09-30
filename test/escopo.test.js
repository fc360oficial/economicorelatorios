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
