const test = require('node:test');
const assert = require('node:assert/strict');
const { expandirFornecedor } = require('../lib/cotacao');

// Empresa com vários vendedores → um concorrente por vendedor (Tiago, 23/09/2026)
const dia = { codFornec: 1234, nome: 'DIA DISTRIBUIDORA', vendedor: { nome: 'Ana', whats: '81911111111', email: 'ana@dia.com' },
  vendedores: [{ nome: 'Bruno', whats: '81922222222', email: '' }, { nome: '', whats: '81933333333', email: '' }, { nome: '', whats: '', email: '' }],
  faturamento_minimo: 600, condicao: 'Boleto 28 dias', prazo_entrega: 3 };

test('3 vendedores viram 3 concorrentes com chave, token e nome próprios e o mesmo código do ERP', () => {
  const r = expandirFornecedor(dia);
  assert.equal(r.length, 3, 'vendedor vazio não entra');
  assert.deepEqual(r.map(f => f.codFornec), [1234, 1234000001, 1234000002]);
  assert.ok(r.every(f => f.codFornecErp === 1234));
  assert.deepEqual(r.map(f => f.nome), ['DIA DISTRIBUIDORA · Ana', 'DIA DISTRIBUIDORA · Bruno', 'DIA DISTRIBUIDORA · 81933333333']);
  assert.deepEqual(r.map(f => f.vendedor.whats), ['81911111111', '81922222222', '81933333333']);
  assert.ok(r.every(f => f.vendedores.length === 0));
  assert.equal(new Set(r.map(f => f.token)).size, 3, 'tokens distintos');
  assert.ok(r.every(f => f.faturamento_minimo === 600 && f.condicao_padrao === 'Boleto 28 dias' && f.prazo_entrega === 3));
});

test('1 vendedor só: continua um concorrente, nome sem sufixo, codFornecErp igual ao código', () => {
  const r = expandirFornecedor({ codFornec: 77, nome: 'ATACADAO', vendedor: { nome: 'Sérgio', whats: '81900000000' }, vendedores: [] });
  assert.equal(r.length, 1); assert.equal(r[0].codFornec, 77); assert.equal(r[0].codFornecErp, 77); assert.equal(r[0].nome, 'ATACADAO');
});

test('sem código do ERP (legado): extras ficam com codFornec 0 e nomes distintos', () => {
  const r = expandirFornecedor({ codFornec: 0, nome: 'BRF BRASIL', vendedor: { nome: 'altemir' }, vendedores: [{ nome: 'joana' }] });
  assert.deepEqual(r.map(f => f.codFornec), [0, 0]);
  assert.deepEqual(r.map(f => f.nome), ['BRF BRASIL · altemir', 'BRF BRASIL · joana']);
});
