// Ordem da tabela "o que o robô pediria hoje" no Ensaio do Robô: do mais urgente pro menos (Tiago, 19/11/26).
const test = require('node:test');
const assert = require('node:assert');
const { ordemUrgencia } = require('../lib/robo-ensaio')._interno;

const L = (nome, o) => ({ nome, itens: 10, total: 1000, urg_dia: 0, urg_curva_a: false, urg_cobertura: null, ...o });
const ordem = linhas => [...linhas].sort(ordemUrgencia).map(l => l.nome);

test('"é hoje" vem antes de "antecipar", mesmo com valor menor', () => {
  assert.deepStrictEqual(ordem([
    L('antecipar grande', { urg_dia: 8, total: 20132.57 }),
    L('hoje pequena', { urg_dia: 0, total: 500, urg_cobertura: 30 }),
  ]), ['hoje pequena', 'antecipar grande']);
});

test('entre as de hoje: curva A em risco primeiro, depois o estoque que dura menos', () => {
  assert.deepStrictEqual(ordem([
    L('dura 183,9', { urg_cobertura: 183.9, total: 8005 }),
    L('dura 20,8', { urg_cobertura: 20.8, total: 9507 }),
    L('curva A', { urg_curva_a: true, total: 100 }),
    L('dura 46,2', { urg_cobertura: 46.2, total: 6637 }),
    L('sem cobertura', { total: 99999 }),
  ]), ['curva A', 'dura 20,8', 'dura 46,2', 'dura 183,9', 'sem cobertura']);
});

test('entre as de antecipar: o dia normal mais perto primeiro', () => {
  assert.deepStrictEqual(ordem([
    L('em 8 dias', { urg_dia: 8 }), L('em 2 dias', { urg_dia: 2 }), L('em 5 dias', { urg_dia: 5 }),
  ]), ['em 2 dias', 'em 5 dias', 'em 8 dias']);
});

test('sem dia marcado pelo Radar fica depois; nada a pedir fica por último; empate = valor maior primeiro', () => {
  assert.deepStrictEqual(ordem([
    L('nada a pedir', { itens: 0, total: 0 }),
    L('sem dia', { urg_dia: null }),
    L('antecipar', { urg_dia: 3 }),
    L('hoje B', { urg_cobertura: 10, total: 100 }),
    L('hoje A', { urg_cobertura: 10, total: 900 }),
  ]), ['hoje A', 'hoje B', 'antecipar', 'sem dia', 'nada a pedir']);
});
