const test = require('node:test');
const assert = require('node:assert/strict');
const radar = require('../lib/radar-pedidos');

test('exporta as funções puras', () => {
  for (const f of ['paramsLista', 'alvoProduto', 'qtdPedido', 'num', 'chunk']) assert.equal(typeof radar[f], 'function', f);
});

test('paramsLista com ciclo fixo 7 e teto 28', () => {
  const P = radar.paramsLista({}, { lead_medio: 2, lead_max: 3, intervalo: 7 }, 28);
  assert.deepEqual(P, { lm: 2, seg: 1, ponto: 3, alvoLista: 10, ciclo: 7 });
});

test('qtdPedido usa embFixa (un/cx) e devolve múltiplos de caixa por loja', () => {
  const P = radar.paramsLista({}, { lead_medio: 2, lead_max: 3, intervalo: 7 }, 28);
  const p = { cod: 'X', lista: 0, emb: 1, embFixa: 12, validade: 0, vq: 10, lojas: [1, 2],
    porLoja: { 1: { vq: 10, est: 0, transito: 0 }, 2: { vq: 10, est: 500, transito: 0 } } };
  const r = radar.qtdPedido(p, P, 0, 0);
  assert.equal(r.emb, 12);
  assert.equal(r.porLoja[1] % 12, 0);
  assert.ok(r.porLoja[1] >= 96);       // alvo 10 d × 10 un/d = 100 → 108 (9 cx)
  assert.equal(r.porLoja[2], 0);        // loja 2 sobrando
});
