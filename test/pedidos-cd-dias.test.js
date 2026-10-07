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
  assert.deepEqual(cd.getConfig().diasPedido, [1, 4]);
  cd.salvarConfig({ diasPedido: [4, 1, 1] });
  assert.deepEqual(cd.getConfig().diasPedido, [1, 4]);
  assert.throws(() => cd.salvarConfig({ diasPedido: [] }), /pelo menos um dia/);
  assert.throws(() => cd.salvarConfig({ diasPedido: [9] }), /pelo menos um dia/);
});
