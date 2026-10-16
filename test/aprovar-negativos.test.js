const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/aprovar-negativos');

const linhas = [
  { cod: '789001', desc: 'A', sys: -1, contado: 0, zero: true },
  { cod: '789002', desc: 'B', sys: -4, contado: 3, zero: false },
  { cod: '789003', desc: 'C', sys: -2, contado: null },
];
const AGORA = new Date(2026, 9, 16, 9, 14, 8); // 16/10/2026 09:14:08

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

test('origemFicha: mesmo texto do ERP, cortado em 25 letras', () => {
  assert.equal(A.origemFicha(4), 'AJUSTE ESTOQUE LOJA 4 (Do');
  assert.equal(A.origemFicha(10), 'AJUSTE ESTOQUE LOJA 10 (D');
  assert.equal(A.origemFicha(1).length, 25);
});

test('passosItem: entrada (saldo sobe) = ajuste Tipo 1 + ficha E + update, igual ao ERP', () => {
  const it = { cod: '7898204100014', desc: 'FEIRA NOVA FARINHA 1KG MANDIOCA', novo: '70' };
  const { passos, dif } = A.passosItem({ it, ln: 4, anterior: '-20', unid: 'UN', aprovador: 'Tiago', agora: AGORA });
  assert.equal(dif, 90);
  assert.equal(passos.length, 3);
  const [aj, fi, up] = passos;
  assert.equal(aj.banco, 'central'); assert.equal(aj.tabela, 'estoque_ajuste'); assert.equal(aj.operacao, 'insert');
  assert.deepEqual(aj.valores, {
    nLoja: 4, Tipo: 1, CodigoBarras: '7898204100014', Descricao: 'FEIRA NOVA FARINHA 1KG MANDIOCA', Qtd: 90, CodMotivo: 37,
    Obs: 'NEGATIVOS - TIAGO', Usuario: 'ECOBOOT', Und: 'UN', DataLan: '2026-10-16', Status: 0, Estoque_Anterior: -20, Estoque_Final: 70, Lote: 0,
  });
  assert.equal(fi.banco, 'fichaproduto'); assert.equal(fi.tabela, 'ficha'); assert.equal(fi.operacao, 'insert');
  assert.deepEqual(fi.valores, {
    CodigoBarras: '7898204100014', SaldoAnterior: -20, Qtd: 90, SaldoAtual: 70, DataAtualizacao: '2026-10-16', DataLancamento: '2026-10-16',
    Tipo: 'E', Origem: 'AJUSTE ESTOQUE LOJA 4 (Do', nRegDoc: { $id: 0 }, Hora: '09:14:08', nLoja: 4, Lote: 0, Fornecedor: '0', nItem: 0, HoraAtualizacao: '0',
  });
  assert.deepEqual(up, { tabela: 'estoquen4', operacao: 'update', where: { CodigoBarra: '7898204100014' }, valores: { Qtd: '70' } });
});

test('passosItem: saída (saldo cai) = Tipo 2 / S com Qtd positiva; sem unidade vira UN; descrição e obs cortadas', () => {
  const it = { cod: '17896009301060', desc: 'X'.repeat(60), novo: '53' };
  const { passos, dif } = A.passosItem({ it, ln: 10, anterior: 105, unid: null, aprovador: 'Fulana de Tal com Nome Muito Comprido Mesmo', agora: AGORA });
  assert.equal(dif, -52);
  assert.equal(passos[0].valores.Tipo, 2); assert.equal(passos[0].valores.Qtd, 52);
  assert.equal(passos[0].valores.Estoque_Anterior, 105); assert.equal(passos[0].valores.Estoque_Final, 53);
  assert.equal(passos[0].valores.Und, 'UN'); assert.equal(passos[0].valores.Descricao.length, 45); assert.equal(passos[0].valores.Obs.length, 45);
  assert.equal(passos[1].valores.Tipo, 'S'); assert.equal(passos[1].valores.Qtd, 52); assert.equal(passos[1].valores.Origem, 'AJUSTE ESTOQUE LOJA 10 (D');
});

test('passosItem: já igual ao contado só atualiza o saldo (nada na Ficha)', () => {
  const { passos, dif } = A.passosItem({ it: { cod: '1', desc: 'A', novo: '5' }, ln: 2, anterior: '5', agora: AGORA });
  assert.equal(dif, 0); assert.equal(passos.length, 1); assert.equal(passos[0].operacao, 'update');
});

test('aprovarLoja: 1 lote por item, usa saldo atual do .254 (ou sys), erro não interrompe', async () => {
  const chamadas = [];
  const escrever = { lote: async op => { chamadas.push(op); const cod = op.passos[op.passos.length - 1].where.CodigoBarra; if (cod === '789002') return { ok: false, status: 'erro', erro: 'boom', id: 'x2' }; return { ok: true, status: 'ok', id: 'id-' + cod }; } };
  const prog = [];
  const { gravar } = A.itensParaGravar(linhas);
  const r = await A.aprovarLoja({ escrever, itens: gravar, usuario: 'Tiago', data: '2026-09-23', ln: 3, nomeLoja: 'PONTE', atual: { 789001: { qtd: '-3', unid: 'KG' } }, agora: () => AGORA, aoProgredir: (n, t) => prog.push(n + '/' + t) });
  assert.equal(r.gravados, 1); assert.equal(r.movimentados, 1); assert.equal(r.semMudanca, 0);
  assert.deepEqual(r.ids, ['id-789001']);
  assert.deepEqual(r.erros, [{ cod: '789002', desc: 'B', erro: 'boom', id: 'x2' }]);
  assert.equal(r.tabela, 'estoquen3'); assert.equal(r.usuarioErp, 'ECOBOOT');
  assert.deepEqual(prog, ['1/2', '2/2']);
  // item 1: saldo atual do .254 (-3) manda, não o sys (-1)
  assert.equal(chamadas[0].passos.length, 3);
  assert.equal(chamadas[0].passos[0].valores.Estoque_Anterior, -3); assert.equal(chamadas[0].passos[0].valores.Qtd, 3); assert.equal(chamadas[0].passos[0].valores.Und, 'KG');
  assert.deepEqual(chamadas[0].passos[2], { tabela: 'estoquen3', operacao: 'update', where: { CodigoBarra: '789001' }, valores: { Qtd: '0' } });
  assert.equal(chamadas[0].motivo, r.motivo); assert.equal(chamadas[0].usuario, 'Tiago'); assert.equal(chamadas[0].banco, 'central');
  // item 2: sem registro em `atual` → anterior = sys (-4), contado 3 → entrada de 7
  assert.equal(chamadas[1].passos[0].valores.Estoque_Anterior, -4); assert.equal(chamadas[1].passos[0].valores.Qtd, 7); assert.equal(chamadas[1].passos[0].valores.Tipo, 1);
});

test('aprovarLoja: exceção do lote vira erro do item; item igual conta como semMudanca', async () => {
  const r = await A.aprovarLoja({ escrever: { lote: async () => { throw new Error('caiu'); } }, itens: A.itensParaGravar(linhas).gravar, usuario: 'T', data: '2026-09-23', ln: 1, nomeLoja: 'CAHU' });
  assert.equal(r.gravados, 0); assert.equal(r.erros.length, 2); assert.match(r.erros[0].erro, /caiu/);
  const r2 = await A.aprovarLoja({ escrever: { lote: async () => ({ ok: true, id: 'k' }) }, itens: [{ cod: '1', desc: 'A', sys: 2, novo: '0' }], usuario: 'T', data: '2026-09-23', ln: 1, nomeLoja: 'CAHU', atual: { 1: { qtd: '0' } } });
  assert.equal(r2.gravados, 1); assert.equal(r2.semMudanca, 1); assert.equal(r2.movimentados, 0);
});
