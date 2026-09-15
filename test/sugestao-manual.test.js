const test = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../lib/sugestao-manual');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

test('persistência: proximoId sequencial, salvar/obter/listar, D-* fora do listar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugman-'));
  sm._setDir(dir);
  assert.equal(sm.proximoId(), 'F-1');
  assert.equal(sm.proximoId(), 'F-2');
  sm.salvar({ id: 'F-1', origem: 'fluxo', criado_em: '2026-09-15T10:00:00.000Z', itens: [] });
  sm.salvar({ id: 'F-2', origem: 'fluxo', criado_em: '2026-09-15T11:00:00.000Z', itens: [] });
  sm.salvar({ id: 'D-4380', origem: 'dlinks', quantidades: {} });
  assert.equal(sm.obter('F-1').id, 'F-1');
  assert.equal(sm.obter('X-9'), null);
  assert.deepEqual(sm.listar().map(s => s.id), ['F-2', 'F-1']);
});

test('aplicarPatch numa F-N: quantidade por loja, obs, ativo, status', () => {
  const s = { id: 'F-1', origem: 'fluxo', status: 'aberta', pedido_id: null,
    itens: [{ codigo: '789', ativo: true, obs: '', quantidade: 5, lojas: [{ loja: 1, sug_loja: 2 }, { loja: 2, sug_loja: 3 }] }] };
  sm.aplicarPatch(s, { quantidades: { 789: { 1: 4, 2: 0 } }, obs: { 789: 'urgente' }, ativo: { 789: false }, status: 'pedido_gerado', pedido_id: 77 });
  assert.equal(s.itens[0].lojas[0].sug_loja, 4);
  assert.equal(s.itens[0].lojas[1].sug_loja, 0);
  assert.equal(s.itens[0].quantidade, 4);          // soma das lojas
  assert.equal(s.itens[0].obs, 'urgente');
  assert.equal(s.itens[0].ativo, false);
  assert.equal(s.status, 'pedido_gerado');
  assert.equal(s.pedido_id, 77);
});

test('aplicarPatch numa D-N guarda só os ajustes', () => {
  const d = { id: 'D-4380', origem: 'dlinks', quantidades: {}, obs: {}, inativos: [], status: 'aberta', pedido_id: null };
  sm.aplicarPatch(d, { quantidades: { 789: { 3: 9 } }, ativo: { 789: false, 555: true }, obs: { 789: 'x' } });
  assert.deepEqual(d.quantidades, { 789: { 3: 9 } });
  assert.deepEqual(d.inativos, ['789']);
  assert.equal(d.obs['789'], 'x');
  sm.aplicarPatch(d, { ativo: { 789: true } });
  assert.deepEqual(d.inativos, []);
});
