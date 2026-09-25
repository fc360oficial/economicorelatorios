'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const LC = require('../lib/log-coletor');
test('registrar grava jsonl por mês e ler filtra por loja/tipo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  const e = LC.registrar(dir, { tipo: 'bipe', loja: 3, nome: 'MAYRA', nfe: '911217', cod: '7896213007386', quant: 10, emb: 24, un: 240, resultado: 'ok' }, new Date('2026-09-25T10:00:00'));
  assert.equal(e.em.slice(0, 10), '2026-09-25'); assert.ok(e.id);
  LC.registrar(dir, { tipo: 'entrar', loja: 1, nome: 'ANA' }, new Date('2026-09-25T10:01:00'));
  assert.ok(fs.existsSync(path.join(dir, '2026-09.jsonl')));
  assert.equal(LC.ler(dir, { de: '2026-09-01', ate: '2026-09-30', loja: 3 }).length, 1);
  assert.equal(LC.ler(dir, { de: '2026-09-01', ate: '2026-09-30', tipo: 'entrar' })[0].nome, 'ANA');
  assert.throws(() => LC.registrar(dir, { tipo: 'xyz', loja: 1, nome: 'A' }), /tipo/);
  assert.match(LC.csv(LC.ler(dir, { de: '2026-09-01', ate: '2026-09-30' })), /tipo;loja;nome/);
});

test('meses: valida o formato das datas, recusa período invertido e para em 24 meses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  assert.throws(() => LC.ler(dir, { de: '2026-9-1', ate: '2026-09-30' }), /data inválida/);
  assert.throws(() => LC.ler(dir, { de: "2026-09-01' OR 1=1", ate: '2026-09-30' }), /data inválida/);
  assert.throws(() => LC.ler(dir, { de: '2026-09-30', ate: '2026-09-01' }), /invertido/);
  // período gigante não varre milhares de arquivos: para no teto de 24 meses
  assert.deepEqual(LC.ler(dir, { de: '1900-01-01', ate: '2026-09-30' }), []);
});

test('csv: célula começando por = + - @ é neutralizada (não vira fórmula no Excel)', () => {
  const linha = LC.csv([{ em: '2026-09-25T10:00:00', tipo: 'chat', loja: 3, nome: 'ANA', msg: '=1+1', descricao: '+CMD', erro: '@x', resultado: '-2' }]);
  assert.ok(linha.includes(";'=1+1"), 'msg neutralizada: ' + linha);
  assert.ok(linha.includes("'+CMD"));
  assert.ok(linha.includes("'@x"));
  assert.ok(linha.includes("'-2"));
});

