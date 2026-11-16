// Carga pelo Conector (16/11/26): quando o Conector recusa a ordem porque um produto não existe no cadastro do Dlinks, esse produto
// fica de fora (marcado em fora_carga) e o resto da lista vai; outro tipo de recusa continua prendendo a lista, com o motivo no registro.
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precif-fora-'));
delete process.env.CONECTOR_USO;
process.env.PRECIF_REGRA_ROBO = 'off';
process.env.PRECIF_REGRA_ROBO_ARQ = path.join(dir, 'regra-robo.json');
delete process.env.PRECIF_APROVACAO;
const test = require('node:test');
const assert = require('node:assert/strict');
const conector = require('../lib/conector');
const pr = require('../lib/precificacao');
pr.init({ dir: path.join(dir, 'registros') });

// Conector falso: nunca fala com o de verdade. `faltam` = códigos que "não existem no cadastro do Dlinks"; `recusa` = outro motivo.
let faltam = new Set(), recusa = null; const ordens = [];
conector.ativo = () => true;
conector.suportaAtacado = async () => true;
conector.precoVenda = async (chave, por, dados) => {
  ordens.push({ chave, por, cods: dados.itens.map(i => i.codigo) });
  if (recusa) return { ok: false, status: 'recusado', id: 'LOG-R' + ordens.length, erro: 'Conector: ' + recusa };
  const f = dados.itens.find(i => faltam.has(i.codigo));
  if (f) return { ok: false, status: 'recusado', id: 'LOG-R' + ordens.length, erro: 'Conector: produto ' + f.codigo + ' não existe no cadastro do Dlinks' };
  return { ok: true, status: 'ok', id: 'LOG-' + ordens.length, ordem: 'ord-' + ordens.length, ids: [null] };
};

const COD = ['789001', '789002', '789003'];
const qFake = async sql => {
  if (/FROM central\.itens /.test(sql)) return COD.map(c => ({ CodigoBarra: c, P: '12,99', A: '0', CodDesativado: 0 }));
  if (/FROM central\.custoloja/.test(sql)) return COD.map(c => ({ CodigoBarra: c, Custo: '10' }));
  if (/FROM central\.itens_margens/.test(sql)) return COD.map(c => ({ CodigoBarra: c, MargemVarejo: 30, MargemAtacado: null }));
  return [];
};
pr.initERP(qFake, { curvaASet: () => new Set() });
const pedido = id => ({ id, lista: 7, lista_nome: 'LISTA ' + id, fornecedor: 'FORN', itens: COD.map(c => ({ cod: c, descricao: 'PROD ' + c })),
  xml: { lojas: { 5: { status: 'conciliado', conferidoEm: '2026-11-16T10:00:00.000Z', notas: [{ chave: 'k', valorProduto: 330 }], itens: COD.map(c => ({ cod: c, descricao: 'PROD ' + c, recebida: 10, tipo: 'ok', preco_xml: 11 })) } } } });

test('produto que não existe no Dlinks fica de fora e o resto da lista vai', async () => {
  faltam = new Set(['789002']); recusa = null; ordens.length = 0;
  await pr.criarDeConciliacao(pedido(71), 5);
  const out = await pr.enviarCargasPendentes({ lote: async () => { throw new Error('não devia usar o caminho antigo'); } }, 'CARGA 09:00');
  assert.ok(out.ids.includes('71-L5')); assert.equal(out.erros, 0);
  assert.equal(ordens.length, 2);                                            // 1ª recusada, 2ª sem o produto que falta
  assert.deepEqual(ordens[1].cods, ['789001', '789003']);
  assert.notEqual(ordens[0].chave, ordens[1].chave);                         // cada tentativa é uma ordem com chave própria
  const r = pr.obter('71-L5');
  assert.equal(r.status, 'aplicado'); assert.equal(r.erp_teste.itens, 2); assert.deepEqual(r.erp_teste.cods, ['789001', '789003']);
  assert.equal(r.fora_carga.length, 1); assert.equal(r.fora_carga[0].cod, '789002'); assert.match(r.fora_carga[0].motivo, /não existe no cadastro/);
  assert.equal(r.ultimo_erro, undefined);
});

test('nenhum produto existe no Dlinks: nada é gravado e a lista fecha com o registro do que ficou de fora', async () => {
  faltam = new Set(COD); recusa = null; ordens.length = 0;
  await pr.criarDeConciliacao(pedido(72), 5);
  const out = await pr.enviarCargasPendentes({ lote: async () => { throw new Error('não devia usar o caminho antigo'); } }, 'CARGA 12:00');
  assert.ok(out.ids.includes('72-L5 (sem mudança)')); assert.equal(out.erros, 0);
  const r = pr.obter('72-L5');
  assert.equal(r.status, 'aplicado'); assert.equal(r.erp_teste, undefined); assert.equal(r.fora_carga.length, 3);
});

test('outro motivo de recusa prende a lista e o motivo fica no registro; some quando a carga passa', async () => {
  faltam = new Set(); recusa = 'preço abaixo do custo no item 789001'; ordens.length = 0;
  await pr.criarDeConciliacao(pedido(73), 5);
  const o1 = await pr.enviarCargasPendentes({ lote: async () => { throw new Error('não devia usar o caminho antigo'); } }, 'CARGA 15:00');
  assert.equal(o1.erros, 1); assert.equal(ordens.length, 1);                 // não fica tentando de novo
  let r = pr.obter('73-L5');
  assert.equal(r.status, 'precificado'); assert.match(r.ultimo_erro.msg, /abaixo do custo/); assert.equal(r.ultimo_erro.por, 'CARGA 15:00');
  recusa = null;
  const o2 = await pr.enviarCargasPendentes({ lote: async () => { throw new Error('não devia usar o caminho antigo'); } }, 'CARGA 09:00');
  assert.ok(o2.ids.includes('73-L5'));
  r = pr.obter('73-L5');
  assert.equal(r.status, 'aplicado'); assert.equal(r.ultimo_erro, undefined); assert.equal(r.fora_carga, undefined);
});
