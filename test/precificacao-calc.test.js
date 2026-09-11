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

const P9 = { politica: 'por_curva', arredondamento: '9' };
const base = { cod: '1', descricao: 'X', curvaA: false, recebida: 10, custo_atual: 10, custo_novo: 11, custo_imposto: 11.5, margem: 30, preco_atual: 12.99, margem_atacado: null, preco_atacado_atual: null };

test('calcularItem: custo subiu → sobe, preço = custo_imposto×(1+margem) arredondado', () => {
  const it = c.calcularItem(base, P9);
  assert.equal(it.status, 'sobe');
  assert.equal(it.preco_calc, 14.95);
  assert.equal(it.preco_sugerido, 14.99);
  assert.equal(it.preco_final, 14.99);
  assert.equal(it.manual, false);
  assert.equal(it.variacao, 0.15);
  assert.equal(it.margem_se_mantem, 0.1296);
  assert.equal(it.atacado, null);
});

test('calcularItem: sem mudança dentro de 0,5%', () => {
  const it = c.calcularItem({ ...base, custo_imposto: 10.04 }, P9);
  assert.equal(it.status, 'sem_mudanca');
  assert.equal(it.preco_sugerido, 12.99);
});

test('calcularItem: custo caiu — manter / repassar / por_curva', () => {
  const caiu = { ...base, custo_imposto: 8 };
  assert.equal(c.calcularItem(caiu, { politica: 'manter', arredondamento: '9' }).status, 'mantem');
  assert.equal(c.calcularItem(caiu, { politica: 'manter', arredondamento: '9' }).preco_sugerido, 12.99);
  const rep = c.calcularItem(caiu, { politica: 'repassar', arredondamento: '9' });
  assert.equal(rep.status, 'desce');
  assert.equal(rep.preco_sugerido, 10.49);            // 8×1.3 = 10.40 → 10.49
  assert.equal(c.calcularItem(caiu, P9).status, 'mantem');                       // não é curva A
  assert.equal(c.calcularItem({ ...caiu, curvaA: true }, P9).status, 'desce');   // curva A repassa
});

test('calcularItem: sem margem → bloqueado', () => {
  const it = c.calcularItem({ ...base, margem: null }, P9);
  assert.equal(it.status, 'bloqueado');
  assert.equal(it.preco_sugerido, null);
  assert.match(it.motivo, /margem/i);
  const it0 = c.calcularItem({ ...base, margem: 0 }, P9);
  assert.equal(it0.status, 'bloqueado');
});

test('calcularItem: motivo_bloqueio externo vence tudo', () => {
  const it = c.calcularItem({ ...base, motivo_bloqueio: 'não casado no ERP' }, P9);
  assert.equal(it.status, 'bloqueado');
  assert.equal(it.motivo, 'não casado no ERP');
});

test('calcularItem: piso no custo com imposto', () => {
  const it = c.calcularItem({ ...base, margem: 1, custo_imposto: 11.5 }, { politica: 'manter', arredondamento: 'nenhum' });
  // 11.5 × 1.01 = 11.615 → 11.62 ≥ custo: sem piso
  assert.equal(it.piso, false);
  const it2 = c.calcularItem({ ...base, margem: -10 }, { politica: 'manter', arredondamento: 'nenhum' });
  assert.equal(it2.preco_sugerido, 11.5);
  assert.equal(it2.piso, true);
});

test('calcularItem: preço atual 0/null (produto novo) → sobe, margem_se_mantem null', () => {
  const it = c.calcularItem({ ...base, preco_atual: 0, custo_atual: null }, P9);
  assert.equal(it.status, 'sobe');
  assert.equal(it.variacao, null);
  assert.equal(it.margem_se_mantem, null);
  assert.equal(it.preco_sugerido, 14.99);
});

test('calcularItem: L4 com atacado', () => {
  const it = c.calcularItem({ ...base, margem_atacado: 10, preco_atacado_atual: 11.5 }, P9);
  assert.deepEqual(it.atacado, { preco_calc: 12.65, preco_sugerido: 12.69, preco_final: 12.69, piso: false });
  const semAt = c.calcularItem({ ...base, margem_atacado: 0, preco_atacado_atual: 11.5 }, P9);
  assert.equal(semAt.atacado, null);
});
