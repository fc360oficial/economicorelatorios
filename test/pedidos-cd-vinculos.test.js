// test/pedidos-cd-vinculos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-'));
cd.init({ q: async () => [], mesDB: m => String(m).padStart(2, '0'), dataDir: dir });

test('config default e salvar parcial', () => {
  assert.equal(cd.getConfig().teto, 28);
  assert.equal(cd.getConfig().clientesLoja[1], 828);
  cd.salvarConfig({ teto: 21 });
  assert.equal(cd.getConfig().teto, 21);
  assert.equal(cd.getConfig().ciclo, 7);
});

test('salvarConfig rejeita entrada inválida', () => {
  assert.throws(() => cd.salvarConfig({ teto: 'x' }), /teto/);
  assert.throws(() => cd.salvarConfig({ clientesLoja: { 1: 0 } }), /loja 1/);
});

test('sincronizarVinculos: igual, dun14 sugerido, pendente; não sobrescreve confirmado', () => {
  const v = cd.sincronizarVinculos([
    { codigoCD: '7897395040727', unPorCaixa: null, unidadeExiste: null },
    { codigoCD: '17896037913143', unPorCaixa: 12, unidadeExiste: '7896037913146' },
    { codigoCD: '17509546679171', unPorCaixa: 72, unidadeExiste: null }
  ]);
  assert.equal(v['7897395040727'].status, 'confirmado'); assert.equal(v['7897395040727'].origem, 'igual'); assert.equal(v['7897395040727'].unPorCaixa, 1);
  assert.equal(v['17896037913143'].status, 'sugerido'); assert.equal(v['17896037913143'].candidato, '7896037913146'); assert.equal(v['17896037913143'].unPorCaixa, 12);
  assert.equal(v['17509546679171'].status, 'pendente');
  cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 'tiago' });
  const v2 = cd.sincronizarVinculos([{ codigoCD: '17896037913143', unPorCaixa: 24, unidadeExiste: '7896037913146' }]);
  assert.equal(v2['17896037913143'].status, 'confirmado');
  assert.equal(v2['17896037913143'].unPorCaixa, 12);   // manual vence o cadastro
  assert.equal(v2['17896037913143'].origem, 'dun14');   // candidato aceito mantém a origem
});

test('salvarVinculo valida', () => {
  assert.throws(() => cd.salvarVinculo({ codigoCD: '1', unidade: '', unPorCaixa: 12 }), /unidade/);
  assert.throws(() => cd.salvarVinculo({ codigoCD: '1', unidade: '2', unPorCaixa: 0 }), /un\/cx/);
  cd.salvarVinculo({ codigoCD: '17509546679171', unidade: '7509546679174', unPorCaixa: 72, usuario: 'tiago' });
  assert.equal(cd.getVinculos()['17509546679171'].origem, 'manual');
  cd.removerVinculo('17509546679171');
  assert.equal(cd.getVinculos()['17509546679171'].status, 'pendente');
  assert.equal(cd.getVinculos()['17509546679171'].unidade, null);
});

test('salvarVinculo/removerVinculo rejeitam codigoCD malicioso (path traversal)', () => {
  assert.throws(() => cd.salvarVinculo({ codigoCD: '__proto__', unidade: '1', unPorCaixa: 1 }), /codigoCD/);
  assert.throws(() => cd.removerVinculo('../../etc/passwd'), /codigoCD/);
});
