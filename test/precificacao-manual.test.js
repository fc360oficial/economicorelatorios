// Preço alterado na mão (Tiago, 18/11/26): a edição numa linha "mantém" tem que virar sobe/desce e IR pra carga
// (antes o preço digitado ficava só na tela, porque a carga só levava o que a regra tinha marcado como sobe/desce).
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precif-manual-'));
process.env.CONECTOR_USO = 'off'; process.env.PRECIF_REGRA_ROBO = 'off'; process.env.PRECIF_APROVACAO = 'off';
process.env.PRECIF_REGRA_ROBO_ARQ = path.join(dir, 'regra-robo.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const pr = require('../lib/precificacao');
const precifErp = require('../lib/precificacao-erp');
pr.init({ dir: path.join(dir, 'registros') });

// A: custo cai 5% (10 → 9,50) → regra "mantém" o preço de 12,99. B: custo sobe (4 → 4,50), margem 30% → sugere 5,89 (sobe).
const qFake = async sql => {
  if (/FROM central\.itens /.test(sql)) return [{ CodigoBarra: 'A', P: '12,99', A: '0', CodDesativado: 0 }, { CodigoBarra: 'B', P: '5,00', A: '0', CodDesativado: 0 }];
  if (/FROM central\.custoloja/.test(sql)) return [{ CodigoBarra: 'A', Custo: '10' }, { CodigoBarra: 'B', Custo: '4' }];
  if (/FROM central\.itens_margens/.test(sql)) return [{ CodigoBarra: 'A', MargemVarejo: 30, MargemAtacado: null }, { CodigoBarra: 'B', MargemVarejo: 30, MargemAtacado: null }];
  return [];
};
pr.initERP(qFake, { curvaASet: () => new Set() });
const pedido = id => ({ id, lista: 7, lista_nome: 'LISTA ' + id, fornecedor: 'FORN', itens: [{ cod: 'A', descricao: 'ARROZ' }, { cod: 'B', descricao: 'FEIJAO' }],
  xml: { lojas: { 3: { status: 'conciliado', conferidoEm: '2026-11-18T10:00:00.000Z', notas: [{ chave: 'k', valorProduto: 100 }],
    itens: [{ cod: 'A', descricao: 'ARROZ', recebida: 10, tipo: 'ok', preco_xml: 9.5 }, { cod: 'B', descricao: 'FEIJAO', recebida: 10, tipo: 'ok', preco_xml: 4.5 }] } } } });
const escrever = () => { const ops = []; return { ops, lote: async op => { ops.push(op); return { ok: true, status: 'ok', id: 'LOG-' + ops.length, ids: [] }; } }; };
const precoGravado = (e, cod) => { const p = e.ops[0].passos.find(x => x.tabela === 'itens' && x.where.CodigoBarra === cod); return p ? p.valores.P3 : null; };

test('linha "mantém" alterada na mão vira "sobe", entra na contagem e vai pra carga', async () => {
  const reg = await pr.criarDeConciliacao(pedido(81), 3);
  const a0 = reg.itens.find(i => i.cod === 'A');
  assert.equal(a0.status, 'mantem'); assert.equal(a0.preco_final, 12.99); assert.equal(reg.resumo.sobem, 1);
  const r = pr.editarItem('81-L3', 'A', { preco_final: 13.99 }, 'tiago');
  const a = r.itens.find(i => i.cod === 'A');
  assert.equal(a.status, 'sobe'); assert.equal(a.status_regra, 'mantem'); assert.equal(a.manual, true);
  assert.equal(r.resumo.sobem, 2); assert.equal(r.resumo.mantem, 0);
  assert.equal(pr.previaAprovacao('81-L3').mudancas.length, 2);
  pr.fechar('81-L3', 'tiago');
  const e = escrever(), env = await pr.enviarCarga('81-L3', 'tiago', e);
  assert.equal(env.erp_teste.itens, 2); assert.equal(precoGravado(e, 'A'), '13,99'); assert.equal(precoGravado(e, 'B'), '5,89');
});

test('baixar na mão vira "desce"; voltar ao preço atual cancela a mudança; a edição sobrevive ao recalcular', async () => {
  await pr.criarDeConciliacao(pedido(82), 3);
  let r = pr.editarItem('82-L3', 'A', { preco_final: 11.99 }, 'tiago');
  assert.equal(r.itens.find(i => i.cod === 'A').status, 'desce'); assert.equal(r.resumo.descem, 1);
  r = await pr.recalcular('82-L3', { doERP: true });
  const a = r.itens.find(i => i.cod === 'A');
  assert.equal(a.preco_final, 11.99); assert.equal(a.status, 'desce'); assert.equal(a.status_regra, 'mantem');
  r = pr.editarItem('82-L3', 'B', { preco_final: 5 }, 'tiago');     // regra mandava subir pra 5,89; na mão ficou no preço atual
  const b = r.itens.find(i => i.cod === 'B');
  assert.equal(b.status, 'mantem'); assert.equal(b.status_regra, 'sobe'); assert.equal(r.resumo.sobem, 0);
  pr.fechar('82-L3', 'tiago');
  const e = escrever(); await pr.enviarCarga('82-L3', 'tiago', e);
  assert.equal(precoGravado(e, 'A'), '11,99'); assert.equal(precoGravado(e, 'B'), null);
  r = await (async () => { pr.reabrir('82-L3', 'tiago'); return pr.recalcular('82-L3', { doERP: true, descartarManuais: true }); })();
  assert.equal(r.itens.find(i => i.cod === 'A').status, 'mantem'); assert.equal(r.itens.find(i => i.cod === 'A').status_regra, undefined);
});

test('registro editado ANTES desta correção (manual com status "mantém") também vai pra carga', async () => {
  const reg = await pr.criarDeConciliacao(pedido(83), 3);
  const a = reg.itens.find(i => i.cod === 'A'); a.preco_final = 13.49; a.manual = true;   // como a tela gravava até 18/11: sem trocar o status
  pr.salvar(reg);
  assert.equal(pr.obter('83-L3').itens.find(i => i.cod === 'A').status, 'mantem');
  assert.ok(precifErp.itensParaCarga(pr.obter('83-L3')).some(i => i.cod === 'A' && i.preco_novo === 13.49));
  assert.equal(pr.previaAprovacao('83-L3').mudancas.length, 2);
});
