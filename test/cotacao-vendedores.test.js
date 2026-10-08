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

// Preço zero não é preço (Tiago, 28/09/26): vendedor digitou "0,00" e ganhava o item de graça
test('preço zero gravado não concorre nem vence; conta como não cotado', () => {
  const { comparativo } = require('../lib/cotacao');
  const c = { id: 1, status: 'aberta', itens: [{ cod: '789', descricao: 'MUCILON 180G', qtd: 216, emb: 12, ultimo_custo: 5.77 }],
    fornecedores: [
      { codFornec: 1, nome: 'DPC', status: 'finalizado', precos: { '789': { preco: 0, obs: '' } } },
      { codFornec: 2, nome: 'NESTLE', status: 'finalizado', precos: { '789': { preco: 5.57, obs: '' } } }] };
  const cmp = comparativo(c), it = cmp.itens[0];
  assert.equal(it.vencedor.codFornec, 2); assert.equal(it.vencedor.preco, 5.57);
  assert.deepEqual(Object.keys(it.precos), ['2']);
  assert.equal(cmp.fornecedores.find(f => f.codFornec === 1).cotados, 0);
  assert.equal(cmp.fornecedores.find(f => f.codFornec === 2).cotados, 1);
});

// Preço negociado pelo(a) comprador(a) (Tiago, 28/09/26): vale no lugar do digitado, o do vendedor fica guardado
test('preço negociado entra no comparativo no lugar do digitado e pode virar o vencedor', () => {
  const { comparativo } = require('../lib/cotacao');
  const c = { id: 2, status: 'aberta', itens: [{ cod: '111', descricao: 'ITEM', qtd: 10, emb: 1, ultimo_custo: 6, lojas_qtd: { '1': 10 } }],   // total é por loja desde 05/10/26 (vencedor por loja)
    fornecedores: [
      { codFornec: 1, nome: 'A', status: 'finalizado', precos: { '111': { preco: 5.05 } } },
      { codFornec: 2, nome: 'B', status: 'finalizado', precos: { '111': { preco: 5.5 } } }],
    negociados: { '111': { 2: { preco: 4.9, por: 'Tiago', em: '2026-09-28T15:00:00.000Z' } } } };
  const it = comparativo(c).itens[0];
  assert.equal(it.vencedor.codFornec, 2); assert.equal(it.vencedor.preco, 4.9);
  assert.equal(it.precos[2].negociado, true); assert.equal(it.precos[2].preco_vendedor, 5.5);
  assert.equal(it.precos[1].negociado, false); assert.equal(it.precos[1].preco_vendedor, 5.05);
  assert.equal(it.total_vencedor, 49);
});
