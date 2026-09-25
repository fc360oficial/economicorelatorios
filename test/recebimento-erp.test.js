'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const E = require('../lib/recebimento-erp');
const c = { id: '2026-09-25-3-911217', loja: 3, nome: 'MAYRA', chave: 'K'.padEnd(44, '0'), nNota: '911217', fornecedor: 'M. DIAS BRANCO S.A. INDUSTRIA E COMERCIO DE ALIMENTOS LTDA', codFornec: 540, devolucoes: [{ cod: '222', qtd: 6, origem: 'compras' }] };
const dh = new Date('2026-09-25T08:05:09');
test('passosAbrir: conferencia + chave ligada por $id', () => { const { passos } = E.passosAbrir(c, { dataHora: dh });
  assert.equal(passos.length, 2); assert.equal(passos[0].tabela, 'conferencia'); assert.equal(passos[0].valores.Status, 1); assert.equal(passos[0].valores.HoraEntrada, '08:05:09'); assert.equal(passos[0].valores.NomeFornec.length, 45);
  assert.deepEqual(passos[1].valores.nRegConf, { $id: 0 }); assert.equal(passos[1].valores.Chave.length, 44); });
test('passosItem: insert na 1ª bipagem, update depois; qtd em emb', () => {
  let p = E.passosItem(c, { cod: '7896213007386', quant: 10, emb: 24, validade: '2027-03-28', bipagens: 1 }, 182400).passos[0];
  assert.equal(p.operacao, 'insert'); assert.equal(p.valores.chave, '182400'); assert.equal(p.valores.qtd, 10); assert.equal(p.valores.qtdemb, 24); assert.equal(p.valores.DataValidade, '2027-03-28');
  p = E.passosItem(c, { cod: '7896213007386', quant: 11, emb: 24, validade: null, bipagens: 2 }, 182400).passos[0];
  assert.equal(p.operacao, 'update'); assert.deepEqual(p.where, { chave: '182400', codigobarra: '7896213007386' }); assert.equal(p.valores.DataValidade, '00/00/0000'); });
test('passosLiberar: status 2 + devoluções', () => { const { passos } = E.passosLiberar(c, 182400, { nome: 'JOSE', dataHora: dh });
  assert.equal(passos[0].valores.Status, 2); assert.equal(passos[0].valores.OperadorLiberacao, 'JOSE'); assert.equal(passos[1].tabela, 'conferenciadevolucao'); assert.equal(passos[1].valores.nConf, 182400); assert.equal(passos[1].valores.Qtd, 6); });
