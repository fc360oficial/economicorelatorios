// Conferência (só leitura) do que uma ordem de ajuste de estoque deixou no ERP: saldo, registro do ajuste e linha da Ficha.
const test = require('node:test'); const assert = require('node:assert/strict');
const { conferir } = require('../lib/conferir-ajuste');

const ordem = extra => ({ id: '20261119-173912-b54c4f', tipo: 'ajuste_estoque', status: 'executada',
  dados: { loja: 1, cod_motivo: 37, usuario_dlinks: 'ECOBOOT', obs: 'NEGATIVOS - TIAGO FREIRE', itens: [{ codigo: '111', qtd: 0, descricao: 'A' }, { codigo: '222', qtd: 0, descricao: 'B' }, { codigo: '333', qtd: 5, descricao: 'C' }, { codigo: '444', qtd: 2, descricao: 'D' }, { codigo: '555', qtd: 1, descricao: 'E' }] },
  resultado: { antes: [{ codigo: '111', qtd: -1 }, { codigo: '222', qtd: -1 }, { codigo: '333', qtd: 5 }, { codigo: '444', qtd: -3 }], nao_gravados: [{ codigo: '555', motivo: 'sem saldo cadastrado nesta loja no Dlinks' }] }, ...extra });
function banco({ semIndice } = {}) {
  const sqls = [];
  const q = async (sql, p) => {
    sqls.push(sql);
    if (/^SELECT CodigoBarra, Qtd FROM central\.estoquen1 /.test(sql)) return [{ CodigoBarra: '111', Qtd: '0' }, { CodigoBarra: '222', Qtd: '-1' }, { CodigoBarra: '333', Qtd: '5' }, { CodigoBarra: '444', Qtd: '2' }];
    if (/FROM central\.estoque_ajuste /.test(sql)) { assert.deepEqual(p.slice(0, 2), [1, '2026-11-19']); return [
      { nReg: 9001, CodigoBarras: '111', Tipo: 1, Qtd: '1.000', Estoque_Anterior: '-1.000', Estoque_Final: '0.000', Usuario: 'ECOBOOT', CodMotivo: 37, Obs: 'NEGATIVOS - TIAGO FREIRE' },
      { nReg: 9002, CodigoBarras: '222', Tipo: 1, Qtd: '1.000', Estoque_Anterior: '-1.000', Estoque_Final: '0.000', Usuario: 'ECOBOOT', CodMotivo: 37, Obs: 'NEGATIVOS - TIAGO FREIRE' },
      { nReg: 8000, CodigoBarras: '444', Tipo: 1, Qtd: '9.000', Estoque_Anterior: '1.000', Estoque_Final: '10.000', Usuario: 'MARIA', CodMotivo: 1, Obs: '' }]; }   // ajuste à mão de outra pessoa: não é o da ordem
    if (/^EXPLAIN SELECT/.test(sql)) return [semIndice ? { key: null, rows: 44800000 } : { key: 'idx_loja_cod', rows: 120 }];
    if (/FROM fichaproduto\.ficha /.test(sql)) { const c = p[1];
      if (c === '111') return [{ CodigoBarras: '111', Tipo: 'E', Qtd: '1.000', SaldoAnterior: '-1.000', SaldoAtual: '0.000', Origem: 'AJUSTE ESTOQUE LOJA 1 (Do', nRegDoc: 9001, Hora: '17:39:12' }];
      if (c === '222') return [{ CodigoBarras: '222', Tipo: 'E', Qtd: '1.000', SaldoAnterior: '-1.000', SaldoAtual: '0.000', Origem: 'AJUSTE ESTOQUE LOJA 1 (Do', nRegDoc: 9002, Hora: '17:39:12' }, { CodigoBarras: '222', Tipo: 'S', Qtd: '1.000', SaldoAnterior: '0.000', SaldoAtual: '-1.000', Origem: 'VENDA PDV 03', nRegDoc: 55123, Hora: '17:48:02' }];
      return []; }
    throw new Error('SQL não esperado: ' + sql);
  };
  return { q, sqls };
}

test('cada produto da ordem: ajuste + Ficha ok, sem movimento, sem registro, não gravado; venda depois do ajuste aparece', async () => {
  const b = banco(); const r = await conferir({ q: b.q, ordem: ordem() });
  assert.equal(r.loja, 1); assert.equal(r.data, '2026-11-19'); assert.equal(r.itens, 5);
  const de = Object.fromEntries(r.linhas.map(l => [l.codigo, l]));
  assert.equal(de['111'].situacao, 'ok'); assert.equal(de['111'].ajuste.nReg, 9001); assert.equal(de['111'].ficha.hora, '17:39:12'); assert.equal(de['111'].saldoMudou, false);
  assert.equal(de['222'].situacao, 'ok'); assert.equal(de['222'].saldoAgora, -1); assert.equal(de['222'].saldoMudou, true, 'vendeu depois do ajuste: o saldo de agora não é mais o contado, e a Ficha do dia mostra a venda');
  assert.equal(de['222'].fichaDoDia.length, 2); assert.equal(de['222'].fichaDoDia[1].origem, 'VENDA PDV 03');
  assert.equal(de['333'].situacao, 'sem_movimento'); assert.match(de['333'].texto, /já era igual ao contado/); assert.equal(de['333'].ajuste, null);
  assert.equal(de['444'].situacao, 'sem_ajuste', 'ajuste de outra pessoa no mesmo dia não conta como o da ordem'); assert.equal(de['555'].situacao, 'nao_gravado');
  assert.deepEqual({ ok: r.ok, semMovimento: r.semMovimento, semAjuste: r.semAjuste, semFicha: r.semFicha, naoGravados: r.naoGravados, saldoMudou: r.saldoMudou }, { ok: 2, semMovimento: 1, semAjuste: 1, semFicha: 0, naoGravados: 1, saldoMudou: 1 });
  assert.ok(b.sqls.every(s => /^(SELECT|EXPLAIN SELECT)/.test(s)), 'só leitura');
});

test('Ficha sem índice não é consultada; registro sem linha na Ficha é apontado; ordem de outro tipo é recusada', async () => {
  const b = banco({ semIndice: true }); const r = await conferir({ q: b.q, ordem: ordem() });
  assert.equal(r.fichaConferidos, 0); assert.match(r.fichaMotivo, /pesada/); assert.equal(r.linhas[0].situacao, 'ficha_nao_conferida');
  assert.ok(!b.sqls.some(s => /^SELECT CodigoBarras, Tipo/.test(s)), 'sem índice, a Ficha (dezenas de milhões de linhas) não é varrida');
  const c = banco(); const q2 = async (sql, p) => (/^SELECT CodigoBarras, Tipo/.test(sql) && p[1] === '111' ? [] : c.q(sql, p));
  const r2 = await conferir({ q: q2, ordem: ordem() }); assert.equal(r2.linhas[0].situacao, 'sem_ficha'); assert.equal(r2.semFicha, 1);
  await assert.rejects(conferir({ q: b.q, ordem: { ...ordem(), tipo: 'preco_venda' } }), /Só ordem de ajuste/);
  await assert.rejects(conferir({ q: b.q, ordem: ordem({ dados: { loja: 99, itens: [{ codigo: '1', qtd: 1 }] } }) }), /loja inválida/);
});
