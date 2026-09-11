const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../lib/pedidos-cd-util');

test('dun14ParaEan13 recalcula o dígito verificador', () => {
  assert.equal(u.dun14ParaEan13('17896037913143'), '7896037913146');
  assert.equal(u.dun14ParaEan13('25601252231168'), '5601252231164');
  assert.equal(u.dun14ParaEan13('7896037913146'), null);
  assert.equal(u.dun14ParaEan13('1789603791314X'), null);
});

test('ean13Valido', () => {
  assert.equal(u.ean13Valido('7896037913146'), true);
  assert.equal(u.ean13Valido('7896037913145'), false);
});

test('emCaixas arredonda pra cima', () => {
  assert.equal(u.emCaixas(0, 12), 0);
  assert.equal(u.emCaixas(1, 12), 1);
  assert.equal(u.emCaixas(24, 12), 2);
  assert.equal(u.emCaixas(25, 12), 3);
  assert.equal(u.emCaixas(10, 0), 0);
});

test('distribuirCdInsuficiente respeita o estoque e prioriza menor cobertura', () => {
  const r = u.distribuirCdInsuficiente({ 1: 3, 2: 2, 3: 4 }, 5, { 1: 10, 2: 1, 3: 5 });
  assert.equal(r.falta, 4);
  assert.equal(Object.values(r.pedidoCx).reduce((a, b) => a + b, 0), 5);
  assert.equal(r.pedidoCx[2], 2);           // menor cobertura, atendida inteira
  assert.ok(r.pedidoCx[3] >= r.pedidoCx[1]); // próxima prioridade
});

test('distribuirCdInsuficiente sem falta devolve igual', () => {
  const r = u.distribuirCdInsuficiente({ 1: 3, 2: 2 }, 10, { 1: 1, 2: 2 });
  assert.deepEqual(r, { pedidoCx: { 1: 3, 2: 2 }, falta: 0 });
});

test('statusRecebimento', () => {
  assert.equal(u.statusRecebimento([{ caixas: 2, recebidas: 2 }, { caixas: 1, recebidas: 1 }]), 'recebido');
  assert.equal(u.statusRecebimento([{ caixas: 2, recebidas: 1 }, { caixas: 1, recebidas: 1 }]), 'recebido_parcial');
  assert.equal(u.statusRecebimento([{ caixas: 2, recebidas: 0 }, { caixas: 1, recebidas: 0 }]), 'aberto');
});

test('mediaLead', () => {
  assert.equal(u.mediaLead([]), null);
  assert.deepEqual(u.mediaLead([{ entrada: '2026-09-01', nota: '2026-09-02' }, { entrada: '2026-09-03', nota: '2026-09-06' }]), { lead_medio: 2, lead_max: 3, n: 2 });
});

test('mediaLead descarta pares com lead negativo ou acima de 30 dias', () => {
  const r = u.mediaLead([
    { entrada: '2026-09-10', nota: '2026-09-01' },  // negativo, descarta
    { entrada: '2026-01-01', nota: '2026-03-01' },  // > 30 dias, descarta
    { entrada: '2026-09-01', nota: '2026-09-03' }   // 2 dias, fica
  ]);
  assert.deepEqual(r, { lead_medio: 2, lead_max: 2, n: 1 });
});

test('distribuirCdInsuficiente com cobertura igual desempata por menor loja', () => {
  const r = u.distribuirCdInsuficiente({ 1: 2, 2: 2 }, 2, { 1: 5, 2: 5 });
  assert.deepEqual(r, { pedidoCx: { 1: 1, 2: 1 }, falta: 2 });
});

test('distribuirCdInsuficiente com estoque fracionário arredonda pra baixo', () => {
  const r = u.distribuirCdInsuficiente({ 1: 3 }, 2.9, { 1: 5 });
  assert.equal(r.pedidoCx[1], 2);
  assert.equal(r.falta, 1);
});

test('distribuirCdInsuficiente trata cobertura ausente como prioridade mais baixa (9999)', () => {
  const r = u.distribuirCdInsuficiente({ 1: 2, 2: 2 }, 2, { 1: 5 });
  assert.deepEqual(r, { pedidoCx: { 1: 2, 2: 0 }, falta: 2 });
});
