const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/log-erp');

test('nomeValido só aceita letras, números e _', () => {
  assert.equal(L.nomeValido('estoquen1'), true);
  assert.equal(L.nomeValido('central'), true);
  assert.equal(L.nomeValido('itens; drop'), false);
  assert.equal(L.nomeValido(''), false);
  assert.equal(L.nomeValido('a.b'), false);
});

test('montarSql update', () => {
  const r = L.montarSql({ banco: 'central', tabela: 'estoquen1', operacao: 'update', where: { CodigoBarra: '789' }, valores: { Qtd: 5 } });
  assert.equal(r.sql, 'UPDATE `central`.`estoquen1` SET `Qtd` = ? WHERE `CodigoBarra` = ?');
  assert.deepEqual(r.params, [5, '789']);
  assert.equal(r.sqlSelect, 'SELECT * FROM `central`.`estoquen1` WHERE `CodigoBarra` = ?');
  assert.deepEqual(r.paramsSelect, ['789']);
});

test('montarSql insert e delete', () => {
  const i = L.montarSql({ banco: 'central', tabela: 't', operacao: 'insert', valores: { a: 1, b: 'x' } });
  assert.equal(i.sql, 'INSERT INTO `central`.`t` (`a`, `b`) VALUES (?, ?)');
  assert.deepEqual(i.params, [1, 'x']);
  assert.equal(i.sqlSelect, null);
  const d = L.montarSql({ banco: 'central', tabela: 't', operacao: 'delete', where: { id: 3, loja: 1 } });
  assert.equal(d.sql, 'DELETE FROM `central`.`t` WHERE `id` = ? AND `loja` = ?');
  assert.deepEqual(d.params, [3, 1]);
});

test('montarSql recusa entrada inválida', () => {
  assert.throws(() => L.montarSql({ banco: 'central', tabela: 't', operacao: 'update', valores: { a: 1 } }), /where/);
  assert.throws(() => L.montarSql({ banco: 'central', tabela: 't', operacao: 'update', where: { id: 1 }, valores: {} }), /valores/);
  assert.throws(() => L.montarSql({ banco: 'central', tabela: 't;', operacao: 'delete', where: { id: 1 } }), /nome/i);
  assert.throws(() => L.montarSql({ banco: 'central', tabela: 't', operacao: 'truncate', where: { id: 1 } }), /operacao/);
  assert.throws(() => L.montarSql({ banco: 'central', tabela: 't', operacao: 'update', where: { 'id x': 1 }, valores: { a: 1 } }), /nome/i);
});

test('diff acha colunas que mudaram', () => {
  const antes = [{ id: 1, Qtd: '3', Nome: 'A' }, { id: 2, Qtd: '1', Nome: 'B' }];
  const depois = [{ id: 1, Qtd: '5', Nome: 'A' }, { id: 2, Qtd: '1', Nome: 'B' }];
  assert.deepEqual(L.diff(antes, depois), ['Qtd']);
  assert.deepEqual(L.diff([], []), []);
});

test('novoId tem data e sufixo', () => {
  const id = L.novoId(new Date(2026, 8, 23, 14, 5, 11));
  assert.match(id, /^20260923-140511-[0-9a-f]{4}$/);
});

test('gravar e ler em pasta temporária, com filtros e linha corrompida', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logerp-'));
  L.gravar(dir, { id: '20260823-100000-aaaa', quando: '2026-08-23T10:00:00-03:00', usuario: 'Tiago', tabela: 'estoquen1', banco: 'central', status: 'ok' });
  L.gravar(dir, { id: '20260923-100000-bbbb', quando: '2026-09-23T10:00:00-03:00', usuario: 'Ana', tabela: 'itens', banco: 'central', status: 'erro' });
  L.gravar(dir, { id: '20260923-110000-cccc', quando: '2026-09-23T11:00:00-03:00', usuario: 'Tiago', tabela: 'estoquen1', banco: 'central', status: 'ok' });
  fs.appendFileSync(path.join(dir, '2026-09.jsonl'), '{corrompida\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08.jsonl', '2026-09.jsonl']);

  const tudo = L.ler(dir, { de: '2026-08-01', ate: '2026-09-30' });
  assert.equal(tudo.itens.length, 3);
  assert.equal(tudo.itens[0].id, '20260923-110000-cccc'); // mais novo primeiro
  assert.equal(tudo.linhas_invalidas, 1);

  assert.equal(L.ler(dir, { de: '2026-09-01', ate: '2026-09-30', tabela: 'estoquen1' }).itens.length, 1);
  assert.equal(L.ler(dir, { de: '2026-08-01', ate: '2026-09-30', usuario: 'Ana' }).itens.length, 1);
  assert.equal(L.ler(dir, { de: '2026-08-01', ate: '2026-09-30', status: 'ok' }).itens.length, 2);
  assert.equal(L.ler(dir, { de: '2026-08-01', ate: '2026-09-30', limite: 1 }).itens.length, 1);
  assert.equal(L.ler(dir, { de: '2026-07-01', ate: '2026-07-31' }).itens.length, 0);

  assert.equal(L.porId(dir, '20260823-100000-aaaa').usuario, 'Tiago');
  assert.equal(L.porId(dir, '20260823-999999-zzzz'), null);
  assert.equal(L.porId(dir, '../x'), null);
});

test('csv com BOM, ; e escape', () => {
  const s = L.csv([{ quando: '2026-09-23T11:00:00-03:00', usuario: 'Tiago', servidor: 'teste-254', banco: 'central', tabela: 'estoquen1', operacao: 'update', afetados: 1, status: 'ok', motivo: 'ajuste; "teste"' }]);
  assert.ok(s.startsWith('﻿'));
  const linhas = s.slice(1).split('\r\n'); // tira o BOM
  assert.equal(linhas[0], 'Data/Hora;Usuário;Servidor;Tabela;Operação;Registros;Status;Motivo');
  assert.equal(linhas[1], '2026-09-23T11:00:00-03:00;Tiago;teste-254;central.estoquen1;update;1;ok;"ajuste; ""teste"""');
});
