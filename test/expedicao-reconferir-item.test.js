// Fiscal do CD manda reconferir SÓ os itens marcados (11/11/26, Tiago, pedido 7906: "cliquei em reconferir, quero que volte
// o que tava antes, e eu selecione só o item que eu quero reconferir"): o resto do que foi bipado continua valendo.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const E = require('../lib/expedicao');

const ITENS = [
  { cod: '7891150097605', descricao: 'OLEO LIZA 900ML', qtd: 80, qtdEmb: 0, und: 'UN', conversao: '4 CX c/20' },
  { cod: '17898403781295', descricao: 'ACUCAR PETRIBU 1KG', qtd: 10, qtdEmb: 30, und: 'FD' },
  { cod: '27896013105897', descricao: 'LAVA ROUPAS LIQ SONHO 3L FRESH CX/4', qtd: 2, qtdEmb: 0, und: 'CX' },
];
const MARIA = { id: 'op-maria', nome: 'MARIA' }, JOAO = { id: 'op-joao', nome: 'JOAO' };
async function ateCarregar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-rci-'));
  E.init({ dir, agora: () => new Date('2026-11-11T17:00:00'), cadastro: async cod => (cod === '999' ? { descricao: 'FORA', qtdemb: 1 } : null), vinculo: async () => null });
  const c = E.abrirPedido({ nPedido: 7906, cliente: 'MERCADINHO', nome: 'lima', itens: ITENS, operador: MARIA });
  await E.separar(c.id, { cod: '7891150097605', quant: 0, emb: 1, soltas: 80, operador: MARIA });
  await E.separar(c.id, { cod: '17898403781295', quant: 10, emb: 30, operador: MARIA });
  await E.separar(c.id, { cod: '27896013105897', quant: 0, emb: 1, soltas: 2, operador: MARIA });
  assert.equal(E.terminei(c.id, { operador: MARIA }).fechou, true);
  E.abrirPedido({ nPedido: 7906, itens: [], operador: JOAO });   // abre o carregamento
  await E.bipar(c.id, { cod: '7891150097605', quant: 4, emb: 20, operador: JOAO });
  await E.bipar(c.id, { cod: '17898403781295', quant: 10, emb: 30, operador: JOAO });
  return c.id;
}

test('carregamento EM ANDAMENTO: reconferir só o item marcado tira só ele (e o bipado fora), o resto continua e o operador é o mesmo', async () => {
  const id = await ateCarregar();
  await E.bipar(id, { cod: '27896013105897', quant: 2, emb: 4, operador: JOAO });   // caixa lida como unidades: 8 em vez de 2
  await E.bipar(id, { cod: '999', quant: 3, emb: 1, operador: JOAO });               // fora da separação
  assert.equal(E.detalhe(id).itens.find(i => i.cod === '999').foraDaSeparacao, true, 'o fiscal enxerga o que foi bipado fora');
  const r = E.liberarSaida(id, { decisao: 'reconferir', nome: 'tiago freire', obs: 'conta de novo', itens: ['27896013105897', '999'] });
  assert.equal(r.status, 'expedindo'); assert.deepEqual(r.saida.itens.map(i => i.cod), ['27896013105897', '999']);
  const c = E.obter(id); const ex = c.etapas.expedicao;
  assert.deepEqual(Object.keys(ex.itens).sort(), ['17898403781295', '7891150097605'], 'os dois certos continuam bipados');
  assert.deepEqual(Object.keys(ex.fora), []); assert.equal(ex.operador.id, JOAO.id);
  const ant = c.carregamentosAnteriores[0]; assert.equal(ant.parcial, true); assert.equal(ant.itens['27896013105897'].un, 8); assert.equal(ant.fora['999'].un, 3);
  const v = E.visao(id, JOAO); assert.equal(v.etapa, 'expedicao'); assert.equal(v.avisoCarga.itens[0].descricao, 'LAVA ROUPAS LIQ SONHO 3L FRESH CX/4'); assert.equal(v.produtos, 2);
  // bipa só o item de novo, certo, e fecha 100 %
  const b = await E.bipar(id, { cod: '27896013105897', quant: 2, emb: 1, operador: JOAO }); assert.equal(b.resultado, 'ok');
  const t = E.terminei(id, { operador: JOAO }); assert.equal(t.fechou, true); assert.equal(E.obter(id).status, 'conferida'); assert.equal(E.obter(id).avisoCarga, null);
});

test('carregamento FECHADO 100 % (conferida): reconferir só um item reabre o carregamento sem perder o resto; sem itens marcados volta tudo como antes', async () => {
  const id = await ateCarregar();
  await E.bipar(id, { cod: '27896013105897', quant: 2, emb: 1, operador: JOAO });
  assert.equal(E.terminei(id, { operador: JOAO }).fechou, true); assert.equal(E.obter(id).status, 'conferida');
  E.liberarSaida(id, { decisao: 'reconferir', nome: 'fiscal', itens: ['17898403781295'] });
  let c = E.obter(id); assert.equal(c.status, 'expedindo'); assert.equal(c.conferidaEm, null); assert.equal(c.etapas.expedicao.fechadoEm, null);
  assert.deepEqual(Object.keys(c.etapas.expedicao.itens).sort(), ['27896013105897', '7891150097605']);
  assert.throws(() => E.liberarSaida(id, { decisao: 'reconferir', nome: 'fiscal', itens: ['000'] }), /não é deste pedido/);
  assert.equal(Object.keys(E.obter(id).etapas.expedicao.itens).length, 2, 'código desconhecido não mexe em nada');
  // sem marcar nada: comportamento de sempre (tudo pro histórico, volta pra "Carregar")
  E.liberarSaida(id, { decisao: 'reconferir', nome: 'fiscal' });
  c = E.obter(id); assert.equal(c.status, 'separada'); assert.equal(c.etapas.expedicao, null); assert.equal(c.carregamentosAnteriores.length, 2); assert.ok(!c.saida.itens);
});

test('separação EM ANDAMENTO: reconferir só o item marcado limpa só ele e avisa o separador', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-rci-'));
  E.init({ dir, agora: () => new Date('2026-11-11T17:00:00'), cadastro: async () => null, vinculo: async () => null });
  const c = E.abrirPedido({ nPedido: 7907, cliente: 'X', nome: 'lima', itens: ITENS, operador: MARIA });
  await E.separar(c.id, { cod: '7891150097605', quant: 0, emb: 1, soltas: 80, operador: MARIA });
  await E.separar(c.id, { cod: '17898403781295', quant: 9, emb: 30, operador: MARIA });
  const r = E.reconferirSeparacao(c.id, { nome: 'fiscal', itens: ['17898403781295'] });
  assert.equal(r.status, 'separando'); assert.deepEqual(r.avisoFiscal.itens.map(i => i.cod), ['17898403781295']);
  const d = E.obter(c.id); assert.deepEqual(Object.keys(d.etapas.separacao.itens), ['7891150097605']); assert.equal(d.separacoesAnteriores[0].parcial, true);
  const v = E.visao(c.id, MARIA); assert.equal(v.separados, 1); assert.equal(v.avisoFiscal.itens.length, 1);
});

test('Tirar da coletagem: item bipado com Emb diferente em cada bipe sai inteiro, sem sobrar unidade presa (11/11/26, pedido 7906, Sonho 0 x 4 = 9)', async () => {
  const id = await ateCarregar();
  await E.bipar(id, { cod: '27896013105897', quant: 2, emb: 4, operador: JOAO });   // 8 un
  await E.bipar(id, { cod: '27896013105897', quant: 1, emb: 1, operador: JOAO });   // +1 = 9 un, quant 3, Emb do item vira 1
  E.tirar(id, { cod: '27896013105897', operador: JOAO });                           // tira tudo
  assert.ok(!E.obter(id).etapas.expedicao.itens['27896013105897'], 'o item some inteiro');
  const b = await E.bipar(id, { cod: '27896013105897', quant: 2, emb: 1, operador: JOAO }); assert.equal(b.resultado, 'ok'); assert.equal(b.item.un, 2);
  // tirar parte continua baixando quant x Emb
  await E.bipar(id, { cod: '999', quant: 5, emb: 2, operador: JOAO });
  E.tirar(id, { cod: '999', quant: 2, operador: JOAO }); assert.equal(E.obter(id).etapas.expedicao.fora['999'].un, 6);
});
