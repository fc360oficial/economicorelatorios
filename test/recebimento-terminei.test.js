const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('../lib/recebimento');
const CAD = { '7896213007386': { cod: '7896213007386', descricao: 'CREAM CRACKER 350G', qtdemb: 24, emb: 'FD', validar: 180 }, '111': { cod: '111', descricao: 'SEM VALIDAR', qtdemb: 1, emb: 'UN', validar: 0 } };
const XML = { itens: [{ cod: '7896213007386', descricao: 'CREAM CRACKER', un: 240 }, { cod: '333', descricao: 'FALTA', un: 12 }, { cod: '222', un: 6, decisao: { acao: 'recusar' } }], naoPedidos: [], status: 'conciliado', pedidoId: 12, ln: 3 };
function setup() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')); R.init({ dir, cadastro: async c => CAD[c] || (c === '222' ? { cod: '222', descricao: 'RECUSADO', qtdemb: 1, emb: 'UN', validar: 0 } : null), xmlLoja: () => XML, agora: () => new Date('2026-09-25T08:00:00') }); return dir; }

test('terminei: recontagem sem revelar qtd; falta e recusa viram devolução; chat libera validade', async () => {
  setup(); const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: 'K', nNota: '1', fornecedor: 'F', codFornec: 1 });
  await R.bipar(c.id, { cod: '7896213007386', quant: 8, emb: 24, validade: '2027-03-28' });   // 192 ≠ 240
  await R.bipar(c.id, { cod: '222', quant: 6, emb: 1 });                                       // recusado pela compradora
  let t = R.terminei(c.id); assert.equal(t.bateu, false); assert.deepEqual(t.recontar.map(r => r.motivo).sort(), ['nao_bipado', 'recontar']);
  assert.ok(!JSON.stringify(t).includes('240')); assert.equal(R.obter(c.id).status, 'recontando'); assert.equal(t.podeEnviar, true);
  await R.corrigir(c.id, { cod: '7896213007386', quant: 10, emb: 24, validade: '2027-03-28' });
  t = R.terminei(c.id); assert.equal(t.bateu, false); assert.equal(t.recontar.length, 1); // falta o 333
  R.enviarAssimMesmo(c.id); assert.equal(R.obter(c.id).status, 'terminada');
  const dev = R.devolucoes(R.obter(c.id)); assert.deepEqual(dev.map(d => d.origem + ':' + d.cod + ':' + d.qtd).sort(), ['compras:222:6', 'falta:333:12']);
  R.mensagem(c.id, { de: 'loja', nome: 'MAYRA', motivo: 'validade', cod: '7896213007386' });
  R.mensagem(c.id, { de: 'central', nome: 'JOSE', acao: 'liberar_validade', cod: '7896213007386' });
  assert.equal(R.obter(c.id).mensagens.length, 2);
  const lib = R.liberar(c.id, { nome: 'JOSE' }); assert.equal(lib.status, 'liberada'); assert.equal(lib.devolucoes.length, 2);
  assert.throws(() => R.terminei(c.id), /liberada/);
});

test('devolução coletor (validade curta e avaria via chat); terminei não recobra item em avaria; reconferir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const xmlUmItem = { itens: [{ cod: '7896213007386', descricao: 'CREAM CRACKER', un: 240 }], naoPedidos: [], status: 'conciliado', pedidoId: 13, ln: 3 };
  R.init({ dir, cadastro: async c => CAD[c] || null, xmlLoja: () => xmlUmItem, agora: () => new Date('2026-09-25T08:00:00') });
  const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: 'K3', nNota: '3', fornecedor: 'F', codFornec: 1 });

  const r = await R.bipar(c.id, { cod: '7896213007386', quant: 10, emb: 24, validade: '2026-10-01' }); // bate 240 mas validade curta
  assert.equal(r.resultado, 'bloqueado_validade');
  let t = R.terminei(c.id); assert.equal(t.bateu, true); assert.equal(R.obter(c.id).status, 'terminada');
  let dev = R.devolucoes(R.obter(c.id));
  let coletor = dev.find(d => d.cod === '7896213007386' && d.origem === 'coletor');
  assert.ok(coletor); assert.ok(coletor.motivo.includes('2026-10-01'));

  R.mensagem(c.id, { de: 'central', nome: 'JOSE', acao: 'devolver', cod: '7896213007386' });
  assert.equal(R.obter(c.id).itens['7896213007386'].estado, 'avaria');
  dev = R.devolucoes(R.obter(c.id));
  coletor = dev.find(d => d.cod === '7896213007386' && d.origem === 'coletor');
  assert.ok(coletor); assert.equal(coletor.motivo, 'avaria');

  t = R.terminei(c.id); assert.equal(t.bateu, true); assert.equal(t.recontar.length, 0); // item em avaria não volta pra recontagem

  const rec = R.reconferir(c.id, { nome: 'CENTRAL' });
  assert.equal(rec.status, 'bipando'); assert.equal(rec.recontagens, 0);
  const ultima = rec.mensagens[rec.mensagens.length - 1];
  assert.equal(ultima.de, 'central'); assert.equal(ultima.acao, 'aguarde');

  R.terminei(c.id); R.liberar(c.id, { nome: 'JOSE' });
  assert.equal(R.obter(c.id).status, 'liberada');
  assert.throws(() => R.reconferir(c.id, { nome: 'JOSE' }), /liberada/);
});
