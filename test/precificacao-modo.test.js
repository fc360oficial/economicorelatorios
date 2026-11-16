// Modo da Formação de Preço (Tiago, 16/11/26: "ajusta essa tela pra ficar automática"): o padrão é AUTOMÁTICO — a carga agendada
// fecha e envia a lista sozinha; com a chave "com aprovação" ligada (setModo(false)) a lista espera; ensaio do robô espera sempre.
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precif-modo-'));
process.env.CONECTOR_USO = 'off';          // grava pelo escrever falso, nunca pelo Conector
process.env.PRECIF_REGRA_ROBO = 'off';     // regra de sempre (a do robô tem teste próprio)
process.env.PRECIF_REGRA_ROBO_ARQ = path.join(dir, 'regra-robo.json');   // a chave do modo fica num arquivo do teste, não no data/ de verdade
delete process.env.PRECIF_APROVACAO;
const test = require('node:test');
const assert = require('node:assert/strict');
const pr = require('../lib/precificacao');
pr.init({ dir: path.join(dir, 'registros') });

const qFake = async sql => {
  if (/FROM central\.itens /.test(sql)) return [{ CodigoBarra: 'A', P: '12,99', A: '0', CodDesativado: 0 }];
  if (/FROM central\.custoloja/.test(sql)) return [{ CodigoBarra: 'A', Custo: '10' }];
  if (/FROM central\.itens_margens/.test(sql)) return [{ CodigoBarra: 'A', MargemVarejo: 30, MargemAtacado: null }];
  return [];
};
pr.initERP(qFake, { curvaASet: () => new Set() });
const pedido = (id, extra) => ({ id, lista: 7, lista_nome: 'LISTA ' + id, fornecedor: 'FORN', itens: [{ cod: 'A', descricao: 'ARROZ' }],
  xml: { lojas: { 3: { status: 'conciliado', conferidoEm: '2026-11-16T10:00:00.000Z', notas: [{ chave: 'k', valorProduto: 110 }], itens: [{ cod: 'A', descricao: 'ARROZ', recebida: 10, tipo: 'ok', preco_xml: 11 }] } } }, ...(extra || {}) });
const escrever = () => { const ops = []; return { ops, lote: async op => { ops.push(op); return { ok: true, status: 'ok', id: 'LOG-' + ops.length, ids: [] }; } }; };

test('padrão é automático: a carga agendada fecha e envia sozinha, sem aprovação', async () => {
  assert.equal(pr.getModo().automatico, true); assert.equal(pr.exigeAprovacao(), false);
  await pr.criarDeConciliacao(pedido(61), 3);
  const e = escrever(), out = await pr.enviarCargasPendentes(e, 'CARGA 09:00');
  assert.deepEqual(out.aguardando, []); assert.ok(out.ids.includes('61-L3'));
  const r = pr.obter('61-L3');
  assert.equal(r.status, 'aplicado'); assert.equal(r.fechadoPor, 'CARGA 09:00'); assert.equal(e.ops.length, 1);
});

test('chave "com aprovação": a lista espera; religando o automático ela vai na carga seguinte', async () => {
  const evs = []; pr.setLog(ev => evs.push(ev));
  try {
    const m = pr.setModo(false, 'Tiago Freire');
    assert.equal(m.automatico, false); assert.equal(m.mudadoPor, 'Tiago Freire'); assert.equal(pr.exigeAprovacao(), true);
    assert.equal(JSON.parse(fs.readFileSync(process.env.PRECIF_REGRA_ROBO_ARQ, 'utf8')).aprovacaoPreco, true);
    assert.equal(evs.filter(x => x.tipo === 'modo').length, 1);
    await pr.criarDeConciliacao(pedido(62), 3);
    const e1 = escrever(), o1 = await pr.enviarCargasPendentes(e1, 'CARGA 12:00');
    assert.deepEqual(o1.aguardando, ['62-L3']); assert.equal(e1.ops.length, 0);
    assert.equal(pr.obter('62-L3').status, 'a_precificar'); assert.ok(pr.obter('62-L3').aguarda_aprovacao);

    assert.equal(pr.setModo(true, 'Tiago Freire').automatico, true);
    assert.equal(pr.getRegraRobo().ativo, true); assert.deepEqual(pr.getRegraRobo().lojas, [1, 2]);   // trocar o modo não mexe na regra do robô
    const e2 = escrever(), o2 = await pr.enviarCargasPendentes(e2, 'CARGA 15:00');
    assert.deepEqual(o2.aguardando, []); assert.ok(o2.ids.includes('62-L3')); assert.equal(e2.ops.length, 1);
    const r = pr.obter('62-L3');
    assert.equal(r.status, 'aplicado'); assert.equal(r.aguarda_aprovacao, undefined);
    assert.equal(r.aprovacao.por, 'CARGA 15:00'); assert.equal(r.aprovacao.automatica, true);   // fica marcado que ninguém aprovou na mão
  } finally { pr.setLog(null); }
});

test('ensaio do robô espera aprovação mesmo no automático', async () => {
  assert.equal(pr.getModo().automatico, true);
  await pr.criarDeConciliacao(pedido(63, { teste: true, ensaio: { lojas: [3] } }), 3);
  const e = escrever(), out = await pr.enviarCargasPendentes(e, 'CARGA 09:00');
  assert.deepEqual(out.aguardando, ['63-L3']); assert.equal(e.ops.length, 0);
  assert.equal(pr.obter('63-L3').status, 'a_precificar');
});
