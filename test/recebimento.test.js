const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('../lib/recebimento');
const CAD = { '7896213007386': { cod: '7896213007386', descricao: 'CREAM CRACKER 350G', qtdemb: 24, emb: 'FD', validar: 180 }, '111': { cod: '111', descricao: 'SEM VALIDAR', qtdemb: 1, emb: 'UN', validar: 0 } };
const XML = { itens: [{ cod: '7896213007386', descricao: 'CREAM CRACKER', un: 240 }, { cod: '222', descricao: 'RECUSADO', un: 6, decisao: { acao: 'recusar' } }], naoPedidos: [], status: 'conciliado', pedidoId: 12, ln: 3 };
function setup() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')); R.init({ dir, cadastro: async c => CAD[c] || (c === '222' ? { cod: '222', descricao: 'RECUSADO', qtdemb: 1, emb: 'UN', validar: 0 } : null), xmlLoja: () => XML, agora: () => new Date('2026-09-25T08:00:00') }); return dir; }
test('PIN/token por loja', () => { setup(); const c = R.config(); assert.equal(Object.keys(c.lojas).length, 6); const t = R.lojaPorPin(3, c.lojas[3].pin); assert.equal(t.loja, 3); assert.equal(R.lojaPorToken(t.token).loja, 3); assert.equal(R.lojaPorPin(3, '0000'), null); });
test('abrir + bipar: ok / recusado / bloqueado validade / não cadastrado / não está na nota', async () => {
  setup(); const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '2626'.padEnd(44, '0'), nNota: '911217', fornecedor: 'M DIAS', codFornec: 540 });
  assert.equal(c.status, 'bipando'); assert.equal(c.id, '2026-09-25-3-911217');
  let r = await R.bipar(c.id, { cod: '7896213007386', quant: 10, emb: 24, validade: '2027-03-28', nome: 'MAYRA' });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.un, 240); assert.equal(r.item.estado, 'ok'); assert.equal(r.item.emb_label, 'FD');
  r = await R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2027-03-28' }); assert.equal(r.item.un, 264); assert.equal(r.item.bipagens, 2);
  r = await R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2026-12-01' }); assert.equal(r.resultado, 'bloqueado_validade'); assert.equal(r.item.origem_devolucao, 'coletor');
  r = await R.bipar(c.id, { cod: '222', quant: 6, emb: 1, validade: null }); assert.equal(r.resultado, 'recusado'); assert.equal(r.item.origem_devolucao, 'compras');
  r = await R.bipar(c.id, { cod: '111', quant: 3, emb: 1, validade: null }); assert.equal(r.resultado, 'nao_esta_na_nota');
  r = await R.bipar(c.id, { cod: '999', quant: 1, emb: 1 }); assert.equal(r.resultado, 'nao_cadastrado');
  const v = R.visaoLoja(3, c.id); assert.equal(v.produtos, 3); assert.ok(!('xml' in v)); assert.ok(!JSON.stringify(v).includes('"un":240,"pedida'));
  await R.corrigir(c.id, { cod: '7896213007386', quant: 5, emb: 24, validade: '2027-03-28' }); assert.equal(R.obter(c.id).itens['7896213007386'].un, 120);
});

test('bipar concorrente: duas bipagens simultâneas na mesma nota não se pisam', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  R.init({ dir, cadastro: c => new Promise(resolve => setTimeout(() => resolve(CAD[c] || null), 5)), xmlLoja: () => XML, agora: () => new Date('2026-09-25T08:00:00') });
  const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '2626'.padEnd(44, '0'), nNota: '911218', fornecedor: 'M DIAS', codFornec: 540 });
  await Promise.all([
    R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2027-03-28' }),
    R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2027-03-28' }),
  ]);
  const it = R.obter(c.id).itens['7896213007386'];
  assert.equal(it.bipagens, 2);
  assert.equal(it.un, 48);
});

test('dia corrompido: lerDia/listarDia preserva o arquivo (renomeado) e não perde outras notas na próxima gravação', () => {
  const dir = setup();
  const dia = R.hojeStr();
  const arq = path.join(dir, dia + '.json');
  fs.writeFileSync(arq, '{ isso não é json válido ');
  const vazio = R.listarDia(dia);
  assert.deepEqual(vazio, []);
  const arquivos = fs.readdirSync(dir);
  assert.ok(arquivos.some(f => f.startsWith(dia + '.corrompido-')), 'esperava um arquivo .corrompido- preservando o conteúdo original');
  // depois do corrompido, salvar uma nova nota não deve lançar nem reaproveitar lixo
  const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '2626'.padEnd(44, '0'), nNota: '911219', fornecedor: 'M DIAS', codFornec: 540 });
  assert.equal(R.listarDia(dia).length, 1);
  assert.equal(c.status, 'bipando');
});

test('sem_validade: item com Validar>0 bipado sem data de validade fica sem_validade (não ok)', async () => {
  setup();
  const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '2626'.padEnd(44, '0'), nNota: '911220', fornecedor: 'M DIAS', codFornec: 540 });
  let r = await R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: null });
  assert.equal(r.resultado, 'sem_validade');
  assert.equal(r.item.estado, 'sem_validade');
  assert.equal(r.item.validade, null);
  // uma bipagem/correção seguinte que informa a validade reavalia normalmente
  r = await R.corrigir(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2027-03-28' });
  assert.equal(r.resultado, 'ok');
  assert.equal(r.item.estado, 'ok');
});

test('sem cadastro de validade (Validar=0) só avisa, item continua ok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const xmlComSemValidar = { itens: [{ cod: '111', descricao: 'SEM VALIDAR', un: 3 }], naoPedidos: [], status: 'conciliado', pedidoId: 12, ln: 3 };
  R.init({ dir, cadastro: async c => CAD[c] || null, xmlLoja: () => xmlComSemValidar, agora: () => new Date('2026-09-25T08:00:00') });
  const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '2626'.padEnd(44, '0'), nNota: '911221', fornecedor: 'M DIAS', codFornec: 540 });
  const r = await R.bipar(c.id, { cod: '111', quant: 3, emb: 1, validade: null });
  assert.equal(r.resultado, 'ok');
  assert.equal(r.item.estado, 'ok');
  assert.equal(r.item.aviso, 'sem_cadastro_validade');
});
