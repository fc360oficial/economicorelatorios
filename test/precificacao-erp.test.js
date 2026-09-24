const test = require('node:test');
const assert = require('node:assert/strict');
const { montarPassosCarga, itensParaCarga, virg } = require('../lib/precificacao-erp');

const reg = (extra = {}) => ({
  id: '12-L3', pedidoId: 12, loja: 3, lista_nome: 'TRES CORACOES', fornecedor: 'TRES CORACOES ALIMENTOS SA', status: 'precificado',
  itens: [
    { cod: '7896005800010', descricao: 'CAFÉ EXTRA FORTE 500G', status: 'sobe', preco_atual: 17.99, preco_final: 18.99, custo_novo: 15.9 },
    { cod: '7896005800027', descricao: 'CAFÉ TRADICIONAL 500G', status: 'desce', preco_atual: 16.49, preco_final: 14.89, custo_novo: 10.48 },
    { cod: '7896005800034', descricao: 'SEM MUDANÇA', status: 'sem_mudanca', preco_atual: 9.99, preco_final: 9.99, custo_novo: 7 },
    { cod: '7896005800041', descricao: 'MANTÉM', status: 'mantem', preco_atual: 9.99, preco_final: 9.99, custo_novo: 7 },
    { cod: '7896005800058', descricao: 'BLOQUEADO', status: 'bloqueado', preco_atual: null, preco_final: null, custo_novo: 7 },
  ], ...extra,
});
const agora = new Date(2026, 8, 24, 17, 5, 9);

test('só itens que sobem ou descem entram na carga', () => {
  const it = itensParaCarga(reg());
  assert.deepEqual(it.map(i => i.cod), ['7896005800010', '7896005800027']);
});

test('formato do Dlinks: itens com vírgula + logpreco2 por item, na mesma transação', () => {
  const { passos, itens, motivo } = montarPassosCarga({ r: reg(), usuario: 'Tiago', agora });
  assert.equal(itens.length, 2);
  assert.equal(passos.length, 4);
  const [u1, l1] = passos;
  assert.deepEqual(u1, { tabela: 'itens', operacao: 'update', where: { CodigoBarra: '7896005800010' },
    valores: { P3: '18,99', NomeAlteracao: 'TIAGO', DataHoraAlteracao: '24/09/2026 17:05:09' } });
  assert.equal(l1.tabela, 'logpreco2'); assert.equal(l1.operacao, 'insert');
  assert.equal(l1.valores.nLoja, 3); assert.equal(l1.valores.Data, '2026-09-24'); assert.equal(l1.valores.Hora, '17:05:09');
  assert.equal(l1.valores.CodigoBarras, '7896005800010');
  assert.equal(l1.valores.PrecoAnt, '17,99'); assert.equal(l1.valores.PrecoNovo, '18,99');
  assert.equal(l1.valores.PrecoAtacadoAnt, '0,00'); assert.equal(l1.valores.PrecoAtacadoNovo, '0,00');
  assert.equal(l1.valores.custo, '15,90'); assert.equal(l1.valores.Nome, 'F:TIAGO'); assert.equal(l1.valores.origem, 'FLUXO');
  assert.match(l1.valores.Motivo, /Formação de Preço #12 loja 3/); assert.equal(l1.valores.Motivo, motivo);
  assert.equal(passos[2].valores.P3, '14,89');
  assert.equal(passos[3].valores.PrecoNovo, '14,89');
});

test('loja 4: atacado que mudou entra mesmo com varejo sem mudança', () => {
  const r = reg({ id: '12-L4', loja: 4, itens: [
    { cod: '1', descricao: 'X', status: 'sem_mudanca', preco_atual: 9.99, preco_final: 9.99, custo_novo: 7, preco_atacado_atual: 8.5, atacado: { preco_final: 8.99 } },
    { cod: '2', descricao: 'Y', status: 'sobe', preco_atual: 9.99, preco_final: 10.99, custo_novo: 7, preco_atacado_atual: 8.5, atacado: { preco_final: 8.5 } },
  ] });
  const { passos } = montarPassosCarga({ r, usuario: 'leni', agora });
  assert.deepEqual(passos[0].valores, { a4: '8,99', NomeAlteracao: 'LENI', DataHoraAlteracao: '24/09/2026 17:05:09' });
  assert.equal(passos[1].valores.PrecoNovo, '9,99'); assert.equal(passos[1].valores.PrecoAtacadoNovo, '8,99');
  assert.deepEqual(passos[2].valores, { P4: '10,99', NomeAlteracao: 'LENI', DataHoraAlteracao: '24/09/2026 17:05:09' });
  assert.equal(passos[3].valores.PrecoAtacadoNovo, '8,50');
});

test('recusa lista aberta e lista sem item que mude', () => {
  assert.throws(() => montarPassosCarga({ r: reg({ status: 'a_precificar' }), usuario: 'x' }), /fechada/);
  assert.throws(() => montarPassosCarga({ r: reg({ itens: [{ cod: '1', status: 'mantem', preco_atual: 1, preco_final: 1 }] }), usuario: 'x' }), /nenhum item/);
});

test('virg arredonda a 2 casas com vírgula', () => {
  assert.equal(virg(8.4), '8,40'); assert.equal(virg(8.496), '8,50'); assert.equal(virg(null), '0,00');
});
