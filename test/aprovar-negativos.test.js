const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/aprovar-negativos');

const linhas = [
  { cod: '789001', desc: 'A', sys: -1, contado: 0, zero: true },
  { cod: '789002', desc: 'B', sys: -4, contado: 3, zero: false },
  { cod: '789003', desc: 'C', sys: -2, contado: null },
];

test('itensParaGravar: ignora sem contagem, não achei vira 0, novo é string inteira', () => {
  const r = A.itensParaGravar(linhas);
  assert.equal(r.gravar.length, 2);
  assert.deepEqual(r.gravar[0], { cod: '789001', desc: 'A', sys: -1, contado: 0, novo: '0' });
  assert.equal(r.gravar[1].novo, '3');
  assert.deepEqual(r.semContagem.map(x => x.cod), ['789003']);
});

test('itensParaGravar: somente pendentes', () => {
  const r = A.itensParaGravar(linhas, ['789002']);
  assert.deepEqual(r.gravar.map(x => x.cod), ['789002']);
});

test('itensParaGravar: desmarcados na tela ficam fora', () => {
  const r = A.itensParaGravar(linhas, null, ['789001']);
  assert.deepEqual(r.gravar.map(x => x.cod), ['789002']);
  assert.deepEqual(r.desmarcados.map(x => x.cod), ['789001']);
  assert.deepEqual(r.semContagem.map(x => x.cod), ['789003']);
});

test('motivoAjuste tem data BR, loja e nome', () => {
  assert.equal(A.motivoAjuste('2026-09-23', 3, 'PONTE'), 'Ajuste de negativos — contagem 23/09/2026, loja 3 (PONTE)');
});

test('aprovarLoja: grava em série, erro não interrompe, tabela da loja', async () => {
  const chamadas = [];
  const escrever = async op => { chamadas.push(op); if (op.where.CodigoBarra === '789002') return { ok: false, status: 'erro', erro: 'boom', id: 'x2' }; return { ok: true, status: 'ok', id: 'id-' + op.where.CodigoBarra }; };
  const prog = [];
  const { gravar } = A.itensParaGravar(linhas);
  const r = await A.aprovarLoja({ escrever, itens: gravar, usuario: 'Tiago', data: '2026-09-23', ln: 3, nomeLoja: 'PONTE', aoProgredir: (n, t) => prog.push(n + '/' + t) });
  assert.equal(r.gravados, 1);
  assert.deepEqual(r.ids, ['id-789001']);
  assert.deepEqual(r.erros, [{ cod: '789002', desc: 'B', erro: 'boom', id: 'x2' }]);
  assert.equal(r.tabela, 'estoquen3');
  assert.deepEqual(prog, ['1/2', '2/2']);
  assert.equal(chamadas[0].tabela, 'estoquen3'); assert.equal(chamadas[0].operacao, 'update');
  assert.deepEqual(chamadas[0].valores, { Qtd: '0' }); assert.deepEqual(chamadas[0].where, { CodigoBarra: '789001' });
  assert.equal(chamadas[0].motivo, r.motivo); assert.equal(chamadas[0].usuario, 'Tiago');
});

test('aprovarLoja: exceção do escrever vira erro do item', async () => {
  const r = await A.aprovarLoja({ escrever: async () => { throw new Error('caiu'); }, itens: A.itensParaGravar(linhas).gravar, usuario: 'T', data: '2026-09-23', ln: 1, nomeLoja: 'CAHU' });
  assert.equal(r.gravados, 0); assert.equal(r.erros.length, 2); assert.match(r.erros[0].erro, /caiu/);
});
