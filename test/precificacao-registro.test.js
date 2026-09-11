const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const pr = require('../lib/precificacao');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precif-'));
pr.init({ dir });

// ERP falso: responde pelas 3 consultas (itens/preço, custo, margem)
const qFake = async (sql) => {
  if (/FROM central\.itens /.test(sql)) return [{ CodigoBarra: 'A', P: '12,99', A: '0', CodDesativado: 0 }, { CodigoBarra: 'B', P: '5,00', A: '0', CodDesativado: 0 }];
  if (/FROM central\.custoloja/.test(sql)) return [{ CodigoBarra: 'A', Custo: '10' }, { CodigoBarra: 'B', Custo: '4' }];
  if (/FROM central\.itens_margens/.test(sql)) return [{ CodigoBarra: 'A', MargemVarejo: 30, MargemAtacado: null }];
  return [];
};
pr.initERP(qFake, { curvaASet: () => new Set(['A']) });

const pedido = {
  id: 40, lista: 7, lista_nome: 'LISTA X', fornecedor: 'FORN', teste: true,
  itens: [{ cod: 'A', descricao: 'ARROZ' }, { cod: 'B', descricao: 'FEIJAO' }, { cod: 'C', descricao: 'FALTOU' }],
  xml: { lojas: { 2: {
    status: 'conciliado', conferidoEm: '2026-09-11T10:00:00.000Z',
    notas: [{ chave: 'k1', valorProduto: 200, desconto: 0, frete: 10, ipi: 0, st: 10 }],
    itens: [
      { cod: 'A', descricao: 'ARROZ', recebida: 10, tipo: 'ok', preco_xml: 11 },
      { cod: 'B', descricao: 'FEIJAO', recebida: 5, tipo: 'ok', preco_xml: 4.5, preco_status: 'maior', decisao: { acao: 'recusar' } },
      { cod: 'C', descricao: 'FALTOU', recebida: 0, tipo: 'falta', preco_xml: null }
    ],
    nao_pedidos: [{ cod: 'D', descricao: 'EXTRA', recebida: 2, preco_xml: 3, decisao: { acao: 'aceitar' } }]
  } } }
};

test('criarDeConciliacao monta entradas, rateia impostos e calcula', async () => {
  const reg = await pr.criarDeConciliacao(pedido, 2);
  assert.equal(reg.id, '40-L2'); assert.equal(reg.loja, 2); assert.equal(reg.status, 'a_precificar');
  assert.equal(reg.rateio.fator, 0.1);                 // (10+0+10−0)/200
  const cods = reg.entradas.map(e => e.cod).sort();
  assert.deepEqual(cods, ['A', 'D']);                  // B recusado, C faltou
  const a = reg.itens.find(i => i.cod === 'A');
  assert.equal(a.custo_novo, 11); assert.equal(a.custo_imposto, 12.1); assert.equal(a.custo_atual, 10);
  assert.equal(a.preco_atual, 12.99); assert.equal(a.margem, 30); assert.equal(a.curvaA, true);
  assert.equal(a.status, 'sobe'); assert.equal(a.preco_sugerido, 15.79);   // 12.1×1.3=15.73 → 15.79
  const d = reg.itens.find(i => i.cod === 'D');
  assert.equal(d.status, 'bloqueado'); assert.match(d.motivo, /não casado/);
  assert.equal(reg.resumo.mudam, 1);
});

test('criarDeConciliacao é idempotente', async () => {
  const again = await pr.criarDeConciliacao(pedido, 2);
  assert.equal(again.id, '40-L2');
  assert.equal(pr.listar().length, 1);
});

test('sem valorProduto → rateio indisponível, custo_imposto = custo_novo', async () => {
  const p2 = JSON.parse(JSON.stringify(pedido)); p2.id = 41; p2.xml.lojas[2].notas = [{ chave: 'k2' }];
  const reg = await pr.criarDeConciliacao(p2, 2);
  assert.equal(reg.rateio.disponivel, false);
  assert.equal(reg.itens.find(i => i.cod === 'A').custo_imposto, 11);
});

test('editarItem marca manual e respeita piso', () => {
  const r1 = pr.editarItem('40-L2', 'A', { preco_final: 16.49 }, 'tiago');
  const a = r1.itens.find(i => i.cod === 'A');
  assert.equal(a.preco_final, 16.49); assert.equal(a.manual, true);
  const err = pr.editarItem('40-L2', 'A', { preco_final: 1 }, 'tiago');
  assert.match(err.erro, /abaixo do custo/);
});

test('setParametros recalcula preservando manual', async () => {
  const r = await pr.setParametros('40-L2', { arredondamento: '5' }, 'tiago');
  assert.equal(r.parametros.arredondamento, '5');
  assert.equal(r.itens.find(i => i.cod === 'A').preco_final, 16.49);
});

test('fechar exige resolver bloqueados, aplicar exige precificado', () => {
  assert.match(pr.fechar('40-L2', 'tiago').erro, /bloqueado/);
  const r = pr.fechar('40-L2', 'tiago', { ignorarBloqueados: true });
  assert.equal(r.status, 'precificado');
  assert.match(pr.editarItem('40-L2', 'A', { preco_final: 17 }, 'x').erro, /fechado/);
  assert.equal(pr.aplicar('40-L2', 'tiago').status, 'aplicado');
  assert.equal(pr.reabrir('40-L2', 'tiago').status, 'a_precificar');
  pr.fechar('40-L2', 'tiago', { ignorarBloqueados: true }); pr.aplicar('40-L2', 'tiago');
});

test('verificar lê o ERP e marca divergência', async () => {
  const r = await pr.verificar('40-L2');   // qFake devolve P=12,99 pra A, e o final é 16.49 → divergente
  assert.equal(r.status, 'conferido');
  assert.equal(r.itens.find(i => i.cod === 'A').erp.ok, false);
  assert.equal(r.divergentes, 1);
  const t = await pr.verificarTodos();
  assert.equal(t.verificados, 1);
});
