const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/listas-por-grupo');

// Divisão por Categoria (23/09/2026): simula "compradora → grupos" em cima das listas do ERP. Só leitura.
function baseFalsa() {
  return L.montarBase({
    listas: [
      { nReg: 1, nome: 'AMBEV', fornecedor: 'AMBEV S.A', CodFornec: 10 },
      { nReg: 2, nome: 'LATICINIO X', fornecedor: 'LATICINIO X LTDA', CodFornec: 20 },
      { nReg: 3, nome: 'SUCOS Y', fornecedor: 'SUCOS Y', CodFornec: 30 },
      { nReg: 4, nome: 'VAZIA', fornecedor: 'NINGUEM', CodFornec: 40 },
    ],
    grupos: [{ CodGrupo: 36, d: 'BEBIDAS/REFRIG/SUCO/AGUA SABOR' }, { CodGrupo: 43, d: 'FRIOS/CONG/SORVETE' }, { CodGrupo: 99, d: 'NOVO GRUPO/QUALQUER' }],
    itens: [
      { lista: 1, cg: 36, n: 100 },
      { lista: 2, cg: 43, n: 60 }, { lista: 2, cg: 36, n: 10 },   // laticínio com 10 bebidas (14%)
      { lista: 3, cg: 36, n: 27 }, { lista: 3, cg: 99, n: 3 },    // sucos: 90% bebidas
    ],
    compradorPorLista: { 1: 'PATRICIA PEREIRA', 2: 'ANA KELLY', 3: 'CRISLANE CECILIA' },
  });
}

test('montarBase: lista sem item fica de fora; grupo sabe quem compra mais hoje', () => {
  const b = baseFalsa();
  assert.deepEqual(b.listas.map(l => l.id), [1, 2, 3]);
  const beb = b.grupos.find(g => g.cg === 36);
  assert.equal(beb.total, 137);
  assert.equal(beb.listas, 3);
  assert.equal(beb.dominante, 'PATRICIA PEREIRA');
  assert.equal(beb.pctDominante, 73);
  assert.equal(beb.rotulo, 'BEBIDAS');
  assert.equal(b.grupos.find(g => g.cg === 99).rotulo, 'NOVO GRUPO');   // sem rótulo curto: 1º pedaço do nome
  assert.deepEqual(b.compradores, ['ANA KELLY', 'CRISLANE CECILIA', 'PATRICIA PEREIRA']);
});

test('relacaoExemplo: grupo vai pra quem já compra a maior parte; grupo pequeno fica fora', () => {
  const ex = L.relacaoExemplo(baseFalsa(), { minPct: 40, minItens: 20 });
  assert.deepEqual(ex, [{ comprador: 'ANA KELLY', grupos: [43] }, { comprador: 'PATRICIA PEREIRA', grupos: [36] }]);
});

test('dividir: Patricia → Bebidas classifica dela / migrar / dividir e nomeia a lista nova', () => {
  const r = L.dividir(baseFalsa(), [{ comprador: 'patricia pereira', grupos: ['36'] }]);
  const p = r.porComprador[0];
  assert.equal(p.comprador, 'PATRICIA PEREIRA');
  assert.equal(p.listasHoje, 1);
  assert.deepEqual(p.listas.map(l => [l.id, l.situacao, l.nomeNovo, l.pct]), [
    [1, 'dela', 'AMBEV', 100],
    [3, 'migrar', 'SUCOS Y', 90],
    [2, 'dividir', 'LATICINIO X · BEBIDAS', 14],
  ]);
  assert.equal(p.itens, 137);
  assert.equal(p.dela, 1); assert.equal(p.migrar, 1); assert.equal(p.dividir, 1);
  assert.equal(r.resumo.listasQueMudam, 2);
  assert.equal(r.resumo.listasNovas, 2);
  assert.equal(r.resumo.itensSemDono, 63);   // 60 frios + 3 do grupo 99
});

test('dividir: quebra por lista mostra cada parte e o que fica sem dona', () => {
  const r = L.dividir(baseFalsa(), [{ comprador: 'PATRICIA PEREIRA', grupos: [36] }, { comprador: 'ANA KELLY', grupos: [43] }]);
  const lat = r.porLista.find(l => l.id === 2);
  assert.deepEqual(lat.partes.map(p => [p.comprador, p.itens, p.pct, p.nomeNovo]), [
    ['ANA KELLY', 60, 86, 'LATICINIO X'],
    ['PATRICIA PEREIRA', 10, 14, 'LATICINIO X · BEBIDAS'],
  ]);
  assert.equal(lat.semDono, 0);
  assert.equal(lat.muda, true);
  assert.equal(r.porLista.find(l => l.id === 1).muda, false);
  assert.equal(r.porLista.find(l => l.id === 3).semDono, 3);
});

test('limparRelacao: um grupo só pode ter uma dona (a primeira que aparecer) e linha sem nome cai', () => {
  const rel = L.limparRelacao([{ comprador: 'A', grupos: [36, 36, 43] }, { comprador: 'B', grupos: [43, 99] }, { comprador: '', grupos: [1] }]);
  assert.deepEqual(rel, [{ comprador: 'A', grupos: [36, 43] }, { comprador: 'B', grupos: [99] }]);
});

test('csv: uma linha por lista da compradora, com BOM e ; pro Excel', () => {
  const r = L.dividir(baseFalsa(), [{ comprador: 'PATRICIA PEREIRA', grupos: [36] }]);
  const linhas = L.csv(r).split('\r\n');
  assert.ok(linhas[0].startsWith('﻿Compradora;'));
  assert.equal(linhas.length, 4);
  assert.equal(linhas[3], 'PATRICIA PEREIRA;BEBIDAS;2;LATICINIO X · BEBIDAS;LATICINIO X LTDA;ANA KELLY;10;70;14;Só a parte do grupo (lista nova)');
});
