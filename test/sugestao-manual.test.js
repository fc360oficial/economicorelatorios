const test = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../lib/sugestao-manual');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OBS = { sem_estoque: false, transito: false, dias_com_venda: false };

test('calcularLoja: dias corridos, sem trânsito', () => {
  // venda 30 un em 30 dias → 1/dia; cobertura 20 → 20 − estoque 5 = 15
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 4, cobertura: 20, obs: OBS });
  assert.equal(r.media, 1);
  assert.equal(r.dias_cob, 5);
  assert.equal(r.sug_sistema, 15);           // trânsito ignorado (obs.transito=false)
});

test('calcularLoja: considera trânsito quando obs.transito', () => {
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 4, cobertura: 20, obs: { ...OBS, transito: true } });
  assert.equal(r.sug_sistema, 11);
});

test('calcularLoja: não considerar estoque zera o estoque', () => {
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 0, cobertura: 20, obs: { ...OBS, sem_estoque: true } });
  assert.equal(r.sug_sistema, 20);
  assert.equal(r.dias_cob, 0);
});

test('calcularLoja: dias com venda no lugar de dias corridos', () => {
  // 30 un em 12 dias com venda → 2,5/dia; cobertura 10 → 25 − 5 = 20
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 0, cobertura: 10, obs: { ...OBS, dias_com_venda: true } });
  assert.equal(r.media, 2.5);
  assert.equal(r.sug_sistema, 20);
});

test('calcularLoja: sem venda → média 0, dias_cob null, sugestão 0', () => {
  const r = sm.calcularLoja({ qtdVenda: 0, diasVenda: 0, dias: 30, estoque: 8, transito: 0, cobertura: 20, obs: OBS });
  assert.equal(r.media, 0);
  assert.equal(r.dias_cob, null);
  assert.equal(r.sug_sistema, 0);
});

test('calcularLoja: resultado negativo vira 0 e arredonda', () => {
  const r = sm.calcularLoja({ qtdVenda: 10, diasVenda: 5, dias: 30, estoque: 50, transito: 0, cobertura: 20, obs: OBS });
  assert.equal(r.sug_sistema, 0);
  const r2 = sm.calcularLoja({ qtdVenda: 10, diasVenda: 5, dias: 30, estoque: 2, transito: 0, cobertura: 20, obs: OBS });
  assert.equal(r2.sug_sistema, 5);            // 6,667 − 2 = 4,667 → 5
});

test('repartirPorLoja: proporcional à sugestão sistema, última fecha a conta', () => {
  const r = sm.repartirPorLoja(10, [{ loja: 1, sug_sistema: 3 }, { loja: 2, sug_sistema: 6 }, { loja: 3, sug_sistema: 0 }]);
  assert.deepEqual(r, { 1: 3, 2: 7 });        // 3,33→3 ; 6,67→ resto 7 ; loja 3 fica 0 e sai
});

test('repartirPorLoja: sem sugestão sistema divide igual', () => {
  const r = sm.repartirPorLoja(7, [{ loja: 1, sug_sistema: 0 }, { loja: 2, sug_sistema: 0 }, { loja: 3, sug_sistema: 0 }]);
  assert.deepEqual(r, { 1: 2, 2: 2, 3: 3 });
});

test('repartirPorLoja: total 0 ou sem lojas → {}', () => {
  assert.deepEqual(sm.repartirPorLoja(0, [{ loja: 1, sug_sistema: 5 }]), {});
  assert.deepEqual(sm.repartirPorLoja(5, []), {});
});

test('persistência: proximoId sequencial, salvar/obter/listar, D-* fora do listar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugman-'));
  sm._setDir(dir);
  assert.equal(sm.proximoId(), 'F-1');
  assert.equal(sm.proximoId(), 'F-2');
  sm.salvar({ id: 'F-1', origem: 'fluxo', criado_em: '2026-09-15T10:00:00.000Z', itens: [] });
  sm.salvar({ id: 'F-2', origem: 'fluxo', criado_em: '2026-09-15T11:00:00.000Z', itens: [] });
  sm.salvar({ id: 'D-4380', origem: 'dlinks', quantidades: {} });
  assert.equal(sm.obter('F-1').id, 'F-1');
  assert.equal(sm.obter('X-9'), null);
  assert.deepEqual(sm.listar().map(s => s.id), ['F-2', 'F-1']);
});

test('aplicarPatch numa F-N: quantidade por loja, obs, ativo, status', () => {
  const s = { id: 'F-1', origem: 'fluxo', status: 'aberta', pedido_id: null,
    itens: [{ codigo: '789', ativo: true, obs: '', quantidade: 5, lojas: [{ loja: 1, sug_loja: 2 }, { loja: 2, sug_loja: 3 }] }] };
  sm.aplicarPatch(s, { quantidades: { 789: { 1: 4, 2: 0 } }, obs: { 789: 'urgente' }, ativo: { 789: false }, status: 'pedido_gerado', pedido_id: 77 });
  assert.equal(s.itens[0].lojas[0].sug_loja, 4);
  assert.equal(s.itens[0].lojas[1].sug_loja, 0);
  assert.equal(s.itens[0].quantidade, 4);          // soma das lojas
  assert.equal(s.itens[0].obs, 'urgente');
  assert.equal(s.itens[0].ativo, false);
  assert.equal(s.status, 'pedido_gerado');
  assert.equal(s.pedido_id, 77);
});

test('aplicarPatch numa D-N guarda só os ajustes', () => {
  const d = { id: 'D-4380', origem: 'dlinks', quantidades: {}, obs: {}, inativos: [], status: 'aberta', pedido_id: null };
  sm.aplicarPatch(d, { quantidades: { 789: { 3: 9 } }, ativo: { 789: false, 555: true }, obs: { 789: 'x' } });
  assert.deepEqual(d.quantidades, { 789: { 3: 9 } });
  assert.deepEqual(d.inativos, ['789']);
  assert.equal(d.obs['789'], 'x');
  sm.aplicarPatch(d, { ativo: { 789: true } });
  assert.deepEqual(d.inativos, []);
});

test('salvar: rejeita id inválido', () => {
  assert.throws(() => sm.salvar({ id: '../x' }), /Id inválido/);
});

test('obter/listar ignoram arquivo corrompido', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugman-corrupt-'));
  sm._setDir(dir);
  fs.writeFileSync(path.join(dir, 'F-9.json'), '{not json');
  assert.equal(sm.obter('F-9'), null);
  assert.doesNotThrow(() => sm.listar());
  assert.ok(!sm.listar().map(s => s.id).includes('F-9'));
});

test('montarDeLinhas: monta D-N a partir das linhas do ERP e aplica ajustes', () => {
  const cab = { nConsolidado: 4380, nLista: 444, CodFornec: 1335, NomeFornec: 'PARATY ATACADO', CNPJ: '05476815001056', Data: new Date('2026-09-15T03:00:00Z'), DataVenda1: '15/08/2026', DataVenda2: '15/09/2026', QtdCobertura: 40, StatusWeb: 1, CodDesativado: 0 };
  const itens = [{ CodigoBarra: '789', Descricao: 'CAREFREE 15UN', Unid: 'un', QtdEmb: 1, QTotal: '24.000', Preco: '6.890', Ql1: '10.000', Ql2: '14.000', Ql3: '0.000', Obs: 'x' }];
  const hist = [
    { nLoja: 1, CodigoBarra: '789', DataCompra: '18/11/25', Fornecedor: 'PARATY', Qtd: '6', Emb: '1', Preco: '6,89', Total: '41,32', Custo: '7,80', PVenda: '12,49', Transito: '0', SaidaMedia: '0,31', Cobertura: '12', Estoque: '4', QtdVendas: '10', QtdSug: '9', QtdLoja: '10', PMV: '12,49' },
    { nLoja: 2, CodigoBarra: '789', DataCompra: '13/02/26', Fornecedor: 'PARATY', Qtd: '12', Emb: '1', Preco: '6,85', Total: '82,22', Custo: '7,76', PVenda: '12,49', Transito: '0', SaidaMedia: '0', Cobertura: '0', Estoque: '0', QtdVendas: '0', QtdSug: '0', QtdLoja: '14', PMV: '0' },
  ];
  const s = sm.montarDeLinhas(cab, itens, hist, { id: 'D-4380', origem: 'dlinks', quantidades: { 789: { 2: 20 } }, obs: {}, inativos: [], status: 'aberta', pedido_id: null });
  assert.equal(s.id, 'D-4380');
  assert.equal(s.origem, 'dlinks');
  assert.equal(s.lista.id, 444);
  assert.equal(s.lista.cnpj, '05476815001056');
  assert.equal(s.parametros.dias, 31);
  assert.equal(s.parametros.cobertura, 40);
  assert.deepEqual(s.parametros.lojas, [1, 2]);
  assert.equal(s.status_web, 1);
  const it = s.itens[0];
  assert.equal(it.preco_und, 6.89);
  assert.equal(it.lojas[0].sug_sistema, 9);
  assert.equal(it.lojas[0].sug_loja, 10);          // Ql1 do Dlinks
  assert.equal(it.lojas[1].sug_loja, 20);          // ajuste gravado no Fluxo sobrepõe Ql2
  assert.equal(it.quantidade, 30);
  assert.equal(it.lojas[0].estoque, 4);
  assert.equal(it.lojas[0].pmv, 12.49);
  assert.equal(it.lojas[0].dias_cob, 12);
  assert.equal(it.lojas[0].media, 0.31);
  assert.equal(it.lojas[0].abc, null);
});

test('montarDeLinhas: sem ajustes usa Ql, sem Ql usa QtdSug; inativo vem dos ajustes', () => {
  const cab = { nConsolidado: 1, nLista: 2, CodFornec: 3, NomeFornec: 'F', CNPJ: '0', Data: null, DataVenda1: '01/09/2026', DataVenda2: '11/09/2026', QtdCobertura: 10, StatusWeb: 0, CodDesativado: 0 };
  const itens = [{ CodigoBarra: '1', Descricao: 'A', Unid: 'UN', QtdEmb: 12, QTotal: '0.000', Preco: '0.000', Ql1: '0.000', Obs: '0' }];
  const hist = [{ nLoja: 1, CodigoBarra: '1', DataCompra: '0', Fornecedor: '0', Qtd: '0', Emb: '0', Preco: '0', Total: '0', Custo: '0', PVenda: '0', Transito: '0', SaidaMedia: '1', Cobertura: '3', Estoque: '3', QtdVendas: '10', QtdSug: '7', QtdLoja: '0', PMV: '0' }];
  const s = sm.montarDeLinhas(cab, itens, hist, { id: 'D-1', origem: 'dlinks', quantidades: {}, obs: {}, inativos: ['1'], status: 'aberta', pedido_id: null });
  assert.equal(s.itens[0].lojas[0].sug_loja, 7);
  assert.equal(s.itens[0].quantidade, 7);
  assert.equal(s.itens[0].ativo, false);
  assert.equal(s.itens[0].obs, '');                 // '0' do ERP vira vazio
  assert.equal(s.lista.cnpj, null);
  const s2 = sm.montarDeLinhas(cab, itens, hist, null);
  assert.equal(s2.itens[0].ativo, true);
});
