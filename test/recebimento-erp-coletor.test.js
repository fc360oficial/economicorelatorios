'use strict';
// Passos do ERP do COLETOR de Recebimento (conferência cega do celular da loja).
// Arquivo separado de test/recebimento-erp.test.js de propósito: aquele cobre o recebimento do
// PEDIDO (montarPassosRecebimento) e é mantido por outra frente — as duas coisas moram no mesmo
// módulo (lib/recebimento-erp.js), mas não se misturam.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/recebimento-erp');

const conf = () => ({
  id: '2026-09-25-3-90619c3af5', loja: 3, nome: 'MAYRA', codFornec: 540,
  fornecedor: 'M DIAS BRANCO SA INDUSTRIA E COMERCIO DE ALIMENTOS FILIAL',
  chave: '2'.repeat(44) + 'XXX', nNota: '911217', devolucoes: [],
});
const dataHora = new Date('2026-09-25T08:07:05');

test('passosAbrir: conferencia (Status 1) + conferenciachave com a chave em 44 caracteres', () => {
  const m = R.passosAbrir(conf(), { dataHora });
  assert.match(m.motivo, /Coletor Econômico .* · abrir/);
  assert.equal(m.passos.length, 2);
  const [cab, chave] = m.passos;
  assert.equal(cab.tabela, 'conferencia'); assert.equal(cab.operacao, 'insert');
  assert.equal(cab.valores.nLoja, 3); assert.equal(cab.valores.CodFornec, 540); assert.equal(cab.valores.Status, 1);
  assert.equal(cab.valores.DataEntrada, '2026-09-25'); assert.equal(cab.valores.HoraEntrada, '08:07:05');
  assert.equal(cab.valores.OperadorLoja, 'MAYRA');
  assert.equal(cab.valores.NomeFornec.length, 45, 'NomeFornec cortado em 45');
  assert.equal(chave.tabela, 'conferenciachave'); assert.equal(chave.operacao, 'insert');
  assert.equal(chave.valores.Chave.length, 44, 'Chave cortada em 44 (coluna do ERP)');
  assert.deepEqual(chave.valores.nRegConf, { $id: 0 }, 'liga no nReg gerado pelo insert anterior');
});

test('passosAbrir: loja/codFornec não numéricos viram 0 (nunca NaN no ERP)', () => {
  const c = conf(); c.loja = 'x'; c.codFornec = undefined;
  const cab = R.passosAbrir(c, { dataHora }).passos[0];
  assert.equal(cab.valores.nLoja, 0); assert.equal(cab.valores.CodFornec, 0);
});

test('passosItem: 1º envio é INSERT, envio seguinte é UPDATE — pela flag espelhado, não por bipagens', () => {
  const c = conf();
  const item = { cod: '7896213007386', descricao: 'CREAM CRACKER', quant: 10, emb: 24, emb_label: 'FD', validade: '2027-03-28', bipagens: 1 };

  const ins = R.passosItem(c, item, 4321).passos[0];
  assert.equal(ins.operacao, 'insert');
  assert.equal(ins.valores.chave, '4321', 'chave da conferenciaitens é o nReg em texto');
  assert.equal(ins.valores.codigobarra, '7896213007386');
  assert.equal(ins.valores.emb, 'FD');
  assert.equal(ins.valores.qtd, 10); assert.equal(ins.valores.qtdemb, 24);
  assert.equal(ins.valores.DataValidade, '2027-03-28');

  item.espelhado = true; item.bipagens = 2;
  const upd = R.passosItem(c, item, 4321).passos[0];
  assert.equal(upd.operacao, 'update');
  assert.deepEqual(upd.where, { chave: '4321', codigobarra: '7896213007386' });

  // corrigir() zera bipagens — o que NÃO pode virar um 2º INSERT na mesma PK (ER_DUP_ENTRY)
  item.bipagens = 0;
  assert.equal(R.passosItem(c, item, 4321).passos[0].operacao, 'update', 'espelhado manda, bipagens não');

  // e um item que nunca chegou no ERP (ficou na fila por falta de nReg) continua INSERT na 2ª bipagem
  const novo = { cod: '111', descricao: 'X', quant: 1, emb: 1, validade: null, bipagens: 3 };
  assert.equal(R.passosItem(c, novo, 4321).passos[0].operacao, 'insert');
});

test('passosItem: sem validade grava NULL (coluna DATE), nunca "00/00/0000"', () => {
  const p = R.passosItem(conf(), { cod: '111', quant: 2, emb: 1, validade: null, bipagens: 1 }, 7).passos[0];
  assert.equal(p.valores.DataValidade, null);
  const p2 = R.passosItem(conf(), { cod: '111', quant: 2, emb: 1, bipagens: 1 }, 7).passos[0];
  assert.equal(p2.valores.DataValidade, null);
});

test('passosItem: quantidades vão numéricas e o código de barras é cortado em 14', () => {
  const p = R.passosItem(conf(), { cod: '1'.repeat(20), quant: '3,5'.replace(',', '.'), emb: '12', validade: null, bipagens: 1 }, 7).passos[0];
  assert.equal(p.valores.codigobarra.length, 14);
  assert.equal(typeof p.valores.qtd, 'number'); assert.equal(p.valores.qtd, 3.5);
  assert.equal(typeof p.valores.qtdemb, 'number'); assert.equal(p.valores.qtdemb, 12);
  // sem emb_label, emb 1 = UN e qualquer outra = CX
  assert.equal(R.passosItem(conf(), { cod: '1', quant: 1, emb: 1, bipagens: 1 }, 7).passos[0].valores.emb, 'UN');
  assert.equal(R.passosItem(conf(), { cod: '1', quant: 1, emb: 6, bipagens: 1 }, 7).passos[0].valores.emb, 'CX');
});

test('passosStatus: 3 (conferido) carimba data/hora; 5 (reconferir) só troca o Status', () => {
  const m3 = R.passosStatus(conf(), 4321, 3, { dataHora });
  assert.equal(m3.passos.length, 1);
  assert.equal(m3.passos[0].tabela, 'conferencia'); assert.equal(m3.passos[0].operacao, 'update');
  assert.deepEqual(m3.passos[0].where, { nReg: 4321 });
  assert.equal(m3.passos[0].valores.Status, 3);
  assert.equal(m3.passos[0].valores.DataConferido, '2026-09-25');
  assert.equal(m3.passos[0].valores.HoraConferido, '08:07:05');

  const m5 = R.passosStatus(conf(), 4321, 5, { dataHora });
  assert.deepEqual(m5.passos[0].valores, { Status: 5 });
});

test('passosLiberar: Status 2 + 1 insert em conferenciadevolucao por devolução', () => {
  const c = conf();
  c.devolucoes = [
    { cod: '7896213007386', descricao: 'CREAM CRACKER', qtd: 240, origem: 'coletor', motivo: 'validade curta (2026-10-01)' },
    { cod: '333', descricao: 'FALTA', qtd: 12, origem: 'falta', motivo: 'na nota, não veio' },
  ];
  const m = R.passosLiberar(c, 4321, { nome: 'JOSE DA SILVA', dataHora });
  assert.equal(m.passos.length, 3);
  const [cab, d1, d2] = m.passos;
  assert.equal(cab.tabela, 'conferencia'); assert.deepEqual(cab.where, { nReg: 4321 });
  assert.equal(cab.valores.Status, 2);
  assert.equal(cab.valores.DataLiberacao, '2026-09-25'); assert.equal(cab.valores.HoraLiberacao, '08:07:05');
  assert.equal(cab.valores.OperadorCentral, 'JOSE DA SILVA');
  for (const d of [d1, d2]) { assert.equal(d.tabela, 'conferenciadevolucao'); assert.equal(d.operacao, 'insert'); assert.equal(d.valores.nConf, 4321); }
  assert.equal(d1.valores.CodigoBarra, '7896213007386'); assert.equal(d1.valores.Qtd, 240);
  assert.equal(d2.valores.CodigoBarra, '333'); assert.equal(d2.valores.Qtd, 12);
});

test('passosLiberar: sem devolução, um passo só (nenhum insert vazio)', () => {
  const m = R.passosLiberar(conf(), 4321, { nome: 'JOSE', dataHora });
  assert.equal(m.passos.length, 1);
  const semCampo = R.passosLiberar({ ...conf(), devolucoes: undefined }, 4321, { nome: 'JOSE', dataHora });
  assert.equal(semCampo.passos.length, 1);
});

test('todos os passos do coletor só tocam as 4 tabelas conferencia* e nunca apagam nada', () => {
  const c = conf();
  c.devolucoes = [{ cod: '1', qtd: 1, origem: 'falta', motivo: 'x' }];
  const passos = [].concat(
    R.passosAbrir(c, { dataHora }).passos,
    R.passosItem(c, { cod: '1', quant: 1, emb: 1, bipagens: 1 }, 1).passos,
    R.passosStatus(c, 1, 3, { dataHora }).passos,
    R.passosLiberar(c, 1, { nome: 'J', dataHora }).passos,
  );
  const tabelas = new Set(passos.map(p => p.tabela));
  assert.deepEqual([...tabelas].sort(), ['conferencia', 'conferenciachave', 'conferenciadevolucao', 'conferenciaitens']);
  for (const p of passos) assert.ok(['insert', 'update'].includes(p.operacao), 'só insert/update: ' + p.operacao);
});
