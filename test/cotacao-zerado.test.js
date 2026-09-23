const test = require('node:test');
const assert = require('node:assert/strict');
const { zeradoCotacao } = require('../lib/cotacao');

// Regra só da cotação (Tiago, 23/09/2026): loja marcada na lista + estoque e trânsito zero + sem sugestão → 1 caixa
const item = (over) => ({
  cod: '1', descricao: 'X', emb: 12, custo: 2.5, qtd: 0, volumes: 0, total: 0, flag: null,
  lojas: [1, 2, 3], lojas_qtd: {},
  lojas_det: { 1: { estoque: 0, transito: 0 }, 2: { estoque: 0, transito: 0 }, 3: { estoque: 0, transito: 0 } },
  ...over,
});

test('item sem venda e zerado em todas as lojas marcadas ganha 1 caixa por loja', () => {
  const i = item();
  assert.equal(zeradoCotacao([i]), 1);
  assert.deepEqual(i.lojas_qtd, { 1: 12, 2: 12, 3: 12 });
  assert.equal(i.qtd, 36); assert.equal(i.volumes, 3); assert.equal(i.total, 90);
  assert.equal(i.flag, 'zerado (cotação)'); assert.deepEqual(i.zerado_cotacao, [1, 2, 3]);
});

test('loja com estoque ou trânsito não recebe; loja fora da lista não recebe', () => {
  const i = item({ lojas: [1, 2], lojas_det: { 1: { estoque: 5, transito: 0 }, 2: { estoque: 0, transito: 12 }, 3: { estoque: 0, transito: 0 } } });
  assert.equal(zeradoCotacao([i]), 0);
  assert.deepEqual(i.lojas_qtd, {}); assert.equal(i.qtd, 0); assert.equal(i.flag, null);
});

test('loja que já tem sugestão fica como está; só as zeradas sem sugestão completam (por loja)', () => {
  const i = item({ qtd: 36, volumes: 3, total: 90, flag: 'nunca_vendeu', lojas_qtd: { 2: 36 }, lojas_det: { 1: { estoque: 0, transito: 0 }, 2: { estoque: 0, transito: 0 }, 3: { estoque: 3, transito: 0 } } });
  assert.equal(zeradoCotacao([i]), 1);
  assert.deepEqual(i.lojas_qtd, { 1: 12, 2: 36 });
  assert.equal(i.qtd, 48); assert.equal(i.volumes, 4); assert.equal(i.total, 120);
  assert.equal(i.flag, 'nunca_vendeu · zerado (cotação)'); assert.deepEqual(i.zerado_cotacao, [1]);
});

test('estoque negativo do ERP (tratado como zero) conta como zerado; sem caixa conhecida usa 1 unidade', () => {
  const i = item({ emb: 1, lojas: [1], lojas_det: { 1: { estoque: 0, estoque_bruto: -4, transito: 0 } } });
  assert.equal(zeradoCotacao([i]), 1);
  assert.deepEqual(i.lojas_qtd, { 1: 1 }); assert.equal(i.volumes, 1);
});

test('lista vazia e item sem lojas_det não quebram', () => {
  assert.equal(zeradoCotacao([]), 0);
  assert.equal(zeradoCotacao(undefined), 0);
  const i = item({ lojas_det: undefined });
  assert.equal(zeradoCotacao([i]), 0);
});
