const test = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../lib/sugestao-manual');

const OBS = { sem_estoque: false, transito: false, dias_com_venda: false };

test('calcularLoja: dias corridos, sem trânsito', () => {
  // venda 30 un em 30 dias → 1/dia; cobertura 20 → 20 − estoque 5 = 15
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 4, cobertura: 20, obs: OBS });
  assert.equal(r.media, 1);
  assert.equal(r.dias_cob, 5);
  assert.equal(r.sug_sistema, 15);           // trânsito ignorado (obs.transito=false)
});

test('calcularLoja: considera trânsito quando obs.transito', () => {
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 4, cobertura: 20, obs: { ...OBS, transito: true } });
  assert.equal(r.sug_sistema, 11);
});

test('calcularLoja: não considerar estoque zera o estoque', () => {
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 0, cobertura: 20, obs: { ...OBS, sem_estoque: true } });
  assert.equal(r.sug_sistema, 20);
  assert.equal(r.dias_cob, 0);
});

test('calcularLoja: dias com venda no lugar de dias corridos', () => {
  // 30 un em 12 dias com venda → 2,5/dia; cobertura 10 → 25 − 5 = 20
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 0, cobertura: 10, obs: { ...OBS, dias_com_venda: true } });
  assert.equal(r.media, 2.5);
  assert.equal(r.sug_sistema, 20);
});

test('calcularLoja: sem venda → média 0, dias_cob null, sugestão 0', () => {
  const r = sm.calcularLoja({ qtdVenda: 0, diasVenda: 0, dias: 30, estoque: 8, transito: 0, cobertura: 20, obs: OBS });
  assert.equal(r.media, 0);
  assert.equal(r.dias_cob, null);
  assert.equal(r.sug_sistema, 0);
});

test('calcularLoja: resultado negativo vira 0 e arredonda', () => {
  const r = sm.calcularLoja({ qtdVenda: 10, diasVenda: 5, dias: 30, estoque: 50, transito: 0, cobertura: 20, obs: OBS });
  assert.equal(r.sug_sistema, 0);
  const r2 = sm.calcularLoja({ qtdVenda: 10, diasVenda: 5, dias: 30, estoque: 2, transito: 0, cobertura: 20, obs: OBS });
  assert.equal(r2.sug_sistema, 5);            // 6,667 − 2 = 4,667 → 5
});

test('repartirPorLoja: proporcional à sugestão sistema, última fecha a conta', () => {
  const r = sm.repartirPorLoja(10, [{ loja: 1, sug_sistema: 3 }, { loja: 2, sug_sistema: 6 }, { loja: 3, sug_sistema: 0 }]);
  assert.deepEqual(r, { 1: 3, 2: 7 });        // 3,33→3 ; 6,67→ resto 7 ; loja 3 fica 0 e sai
});

test('repartirPorLoja: sem sugestão sistema divide igual', () => {
  const r = sm.repartirPorLoja(7, [{ loja: 1, sug_sistema: 0 }, { loja: 2, sug_sistema: 0 }, { loja: 3, sug_sistema: 0 }]);
  assert.deepEqual(r, { 1: 2, 2: 2, 3: 3 });
});

test('repartirPorLoja: total 0 ou sem lojas → {}', () => {
  assert.deepEqual(sm.repartirPorLoja(0, [{ loja: 1, sug_sistema: 5 }]), {});
  assert.deepEqual(sm.repartirPorLoja(5, []), {});
});
