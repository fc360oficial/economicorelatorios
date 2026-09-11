const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/precificacao-calc');

test('arred nenhum: 2 casas, pra cima', () => {
  assert.equal(c.arred(3.141, 'nenhum'), 3.15);
  assert.equal(c.arred(3.14, 'nenhum'), 3.14);
  assert.equal(c.arred(0, 'nenhum'), 0);
});

test('arred 9: menor valor >= v com centavos terminados em 9', () => {
  assert.equal(c.arred(3.14, '9'), 3.19);
  assert.equal(c.arred(3.19, '9'), 3.19);
  assert.equal(c.arred(3.191, '9'), 3.29);
  assert.equal(c.arred(3.995, '9'), 4.09);
  assert.equal(c.arred(3.996, '9'), 4.09);
  assert.equal(c.arred(10, '9'), 10.09);
});

test('arred 5: menor valor >= v com centavos terminados em 5', () => {
  assert.equal(c.arred(3.14, '5'), 3.15);
  assert.equal(c.arred(3.15, '5'), 3.15);
  assert.equal(c.arred(3.151, '5'), 3.25);
  assert.equal(c.arred(3.96, '5'), 4.05);
});

test('arred termo inválido cai em nenhum', () => {
  assert.equal(c.arred(3.141, 'x'), 3.15);
});
