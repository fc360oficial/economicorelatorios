const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/modulos');

test('moduloDaRota: página, api, fora do mapa', () => {
  assert.equal(m.moduloDaRota('/dre.html'), 'financeiro');
  assert.equal(m.moduloDaRota('/api/conciliador-cd/resumo'), 'financeiro');
  assert.equal(m.moduloDaRota('/api/comparativo-lojas?mes=1'), 'analise');
  assert.equal(m.moduloDaRota('/sugestao-compras.html'), 'compras');
  assert.equal(m.moduloDaRota('/api/pendencias'), 'processos');
  assert.equal(m.moduloDaRota('/gestao-gerencial.html'), null);
  assert.equal(m.moduloDaRota('/api/admin/usuarios'), null);
  assert.equal(m.moduloDaRota('/api/me'), null);
  assert.equal(m.moduloDaRota('/painel-cd.html'), 'compras');
});

test('modulosDoUsuario: admin, gerencial e sem campo veem tudo', () => {
  const todos = m.MODULOS.map(x => x.id);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'admin', modulos: ['financeiro'] }), todos);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'gerencial', modulos: [] }), todos);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'gerente' }), todos);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'gerente', modulos: ['financeiro', 'xyz'] }), ['financeiro']);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'gerente', modulos: [] }), []);
});

test('podeAcessar e primeiraPagina', () => {
  const fin = { perfil: 'gerente', modulos: ['financeiro'] };
  assert.equal(m.podeAcessar(fin, '/dre.html'), true);
  assert.equal(m.podeAcessar(fin, '/api/pendencias'), false);
  assert.equal(m.podeAcessar(fin, '/hub.html'), true);
  assert.equal(m.primeiraPagina(fin), '/conciliador.html');
  assert.equal(m.primeiraPagina({ perfil: 'gerente', modulos: ['compras', 'analise'] }), '/index.html');
  assert.equal(m.primeiraPagina({ perfil: 'gerente', modulos: [] }), null);
  assert.equal(m.primeiraPagina({ perfil: 'admin' }), '/index.html');
});
