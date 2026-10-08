// test/pedidos-cd-dias.test.js — dias de pedido (segunda e quinta, 07/10/2026) e ciclo pelo intervalo até o próximo
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../lib/pedidos-cd-util');

test('proximoDiaPedido: hoje se for dia de pedido, senão o próximo; cicloPedido = intervalo até o seguinte', () => {
  // 2026-10-05 é segunda, 2026-10-08 quinta
  assert.equal(u.proximoDiaPedido('2026-10-05', [1, 4]), '2026-10-05');
  assert.equal(u.proximoDiaPedido('2026-10-06', [1, 4]), '2026-10-08');
  assert.equal(u.proximoDiaPedido('2026-10-09', [1, 4]), '2026-10-12');
  assert.equal(u.cicloPedido('2026-10-05', [1, 4]), 3); // seg → qui
  assert.equal(u.cicloPedido('2026-10-08', [1, 4]), 4); // qui → seg
  assert.equal(u.cicloPedido('2026-10-07', [1, 4]), 4); // quarta: próximo pedido é quinta, ciclo até segunda
  // só segunda = comportamento antigo (7 dias, próxima segunda)
  assert.equal(u.cicloPedido('2026-10-07', [1]), 7);
  assert.equal(u.proximoDiaPedido('2026-10-07', [1]), '2026-10-12');
  assert.equal(u.cicloPedido('2026-10-07', []), 7);
});

test('salvarConfig: diasPedido validado, deduplicado e ordenado', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const cd = require('../lib/pedidos-cd');
  cd.init({ q: async () => [], mesDB: m => String(m).padStart(2, '0'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pcdd-')) });
  assert.deepEqual(cd.getConfig().diasPedido, [1]);   // só segunda (Tiago, 08/10/2026)
  cd.salvarConfig({ diasPedido: [4, 1, 1] });
  assert.deepEqual(cd.getConfig().diasPedido, [1, 4]);
  assert.throws(() => cd.salvarConfig({ diasPedido: [] }), /pelo menos um dia/);
  assert.throws(() => cd.salvarConfig({ diasPedido: [9] }), /pelo menos um dia/);
});

test('cobertura alvo: alvo da loja = cobertura (lead e segurança já dentro), limitado ao teto e nunca abaixo de ponto+1', () => {
  const cd = require('../lib/pedidos-cd');
  const base = { hoje: '2026-10-08', dias: 40, lead: { 1: { lead_medio: 0.6, lead_max: 5, n: 10 } }, cd: {}, un: {}, avisos: [] };
  const cfg = { teto: 28, ciclo: 4, cobertura: 10, leadPadrao: 2, leadMaxPadrao: 3 };
  const { paramsLoja } = cd.calcularSugestao(base, {}, cfg, {});
  assert.equal(paramsLoja[1].alvoLista, 10);          // ponto 1.2 + intervalo 8.8
  assert.equal(paramsLoja[2].alvoLista, 10);          // loja sem lead: padrão 2/3 → ponto 3, alvo 10
  const semCob = cd.calcularSugestao(base, {}, { ...cfg, cobertura: null }, {}).paramsLoja;
  assert.equal(semCob[1].alvoLista, 5.2);             // sem cobertura: ponto + ciclo (regra de 07/10)
  const t = cd.calcularSugestao(base, {}, { ...cfg, cobertura: 40 }, {}).paramsLoja;
  assert.equal(t[1].alvoLista, 28);                   // teto segura
  assert.throws(() => cd.salvarConfig({ cobertura: 1 }), /cobertura alvo/);
});
