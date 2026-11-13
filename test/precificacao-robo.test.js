// Regra do robô na Formação de Preço (só lojas do robô): não baixa, não sobe alto giro, não mexe em final 7/8, teto de aumento,
// produto sem preço vai pra conferência. As outras lojas (sem regra_robo) seguem a regra de sempre.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const calc = require('../lib/precificacao-calc');
const SEMPRE = { arredondamento: '9' }, ROBO = { arredondamento: '9', regra_robo: true, teto_aumento_pct: 10 };
const item = (e, P) => calc.calcularItem({ cod: 'x', ...e }, P);

test('não baixa preço sozinho', () => {
  const e = { custo_atual: 6.5, custo_imposto: 6.5, margem: 30, preco_atual: 8.99 };
  assert.equal(item(e, SEMPRE).preco_final, 8.49);
  const r = item(e, ROBO); assert.equal(r.preco_final, 8.99); assert.equal(r.status, 'mantem'); assert.equal(r.robo.seria, 8.49);
});
test('alto giro não sobe; sem alto giro sobe', () => {
  const e = { custo_atual: 8, custo_imposto: 8.6, margem: 20, preco_atual: 9.99 };
  assert.equal(item({ ...e, alto_giro: true }, ROBO).preco_final, 9.99);
  assert.equal(item(e, ROBO).preco_final, 10.39);
});
test('final 7 e final 8 não se mexe', () => {
  for (const p of [7.98, 7.97]) { const r = item({ custo_atual: 6.5, custo_imposto: 6.5, margem: 30, preco_atual: p }, ROBO); assert.equal(r.preco_final, p); assert.equal(r.status, 'mantem'); }
});
test('teto de aumento: sobe no máximo 10% por alteração, terminando em 9', () => {
  const r = item({ custo_atual: 21.36, custo_imposto: 32.25, margem: 65, preco_atual: 44.79 }, ROBO);
  assert.equal(r.preco_final, 49.19); assert.equal(r.status, 'sobe'); assert.equal(r.robo.seria, 53.29);
  assert.equal(item({ custo_atual: 3.28, custo_imposto: 3.72, margem: 66, preco_atual: 5.99 }, ROBO).preco_final, 6.19);   // dentro do teto: não corta
  assert.equal(item({ custo_atual: 21.36, custo_imposto: 32.25, margem: 65, preco_atual: 44.79 }, { ...ROBO, teto_aumento_pct: 0 }).preco_final, 53.29);   // teto 0 = sem teto
});
test('teto nunca deixa o preço abaixo do custo novo', () => {
  const r = item({ custo_atual: 8, custo_imposto: 11.5, margem: 30, preco_atual: 9.99 }, ROBO);
  assert.ok(r.preco_final >= 11.5, 'preço ' + r.preco_final);
});
test('produto sem preço de venda: robô não cria preço', () => {
  const e = { custo_atual: 0, custo_imposto: 19.39, margem: 65, preco_atual: 0 };
  assert.equal(item(e, SEMPRE).preco_final, 31.99);
  const r = item(e, ROBO); assert.equal(r.status, 'bloqueado'); assert.equal(r.preco_final, null); assert.match(r.motivo, /sem preço de venda/);
});
