const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('../lib/recebimento');
const CAD = { '7896213007386': { cod: '7896213007386', descricao: 'CREAM CRACKER 350G', qtdemb: 24, emb: 'FD', validar: 180 }, '111': { cod: '111', descricao: 'SEM VALIDAR', qtdemb: 1, emb: 'UN', validar: 0 } };
const XML = { itens: [{ cod: '7896213007386', descricao: 'CREAM CRACKER', un: 240 }, { cod: '222', descricao: 'RECUSADO', un: 6, decisao: { acao: 'recusar' } }], naoPedidos: [], status: 'conciliado', pedidoId: 12, ln: 3 };
function setup() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')); R.init({ dir, cadastro: async c => CAD[c] || (c === '222' ? { cod: '222', descricao: 'RECUSADO', qtdemb: 1, emb: 'UN', validar: 0 } : null), xmlLoja: () => XML, agora: () => new Date('2026-09-25T08:00:00') }); return dir; }
test('PIN/token por loja', () => { setup(); const c = R.config(); assert.equal(Object.keys(c.lojas).length, 7); assert.ok(c.lojas[10].pin); const t = R.lojaPorPin(3, c.lojas[3].pin); assert.equal(t.loja, 3); assert.equal(R.lojaPorToken(t.token).loja, 3); assert.equal(R.lojaPorPin(3, '0000'), null); });
test('abrir + bipar: ok / recusado / bloqueado validade / não cadastrado / não está na nota', async () => {
  setup(); const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '2626'.padEnd(44, '0'), nNota: '911217', fornecedor: 'M DIAS', codFornec: 540 });
  assert.equal(c.status, 'bipando'); assert.match(c.id, /^2026-09-25-3-[0-9a-f]{10}$/);   // id = dia-loja-hash da chave (I4)
  let r = await R.bipar(c.id, { cod: '7896213007386', quant: 10, emb: 24, validade: '2027-03-28', nome: 'MAYRA' });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.un, 240); assert.equal(r.item.estado, 'ok'); assert.equal(r.item.emb_label, 'FD');
  r = await R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2027-03-28' }); assert.equal(r.item.un, 264); assert.equal(r.item.bipagens, 2);
  r = await R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2026-12-01' }); assert.equal(r.resultado, 'bloqueado_validade'); assert.equal(r.item.origem_devolucao, 'coletor');
  r = await R.bipar(c.id, { cod: '222', quant: 6, emb: 1, validade: null }); assert.equal(r.resultado, 'recusado'); assert.equal(r.item.origem_devolucao, 'compras');
  r = await R.bipar(c.id, { cod: '111', quant: 3, emb: 1, validade: null }); assert.equal(r.resultado, 'nao_esta_na_nota');
  r = await R.bipar(c.id, { cod: '999', quant: 1, emb: 1 }); assert.equal(r.resultado, 'nao_cadastrado');
  const v = R.visaoLoja(3, c.id); assert.equal(v.produtos, 3); assert.ok(!('xml' in v)); assert.ok(!JSON.stringify(v).includes('"un":240,"pedida'));
  // nota_itens (06/10/26): a loja vê o que veio na nota, sem quantidade e sem o recusado pelo comprador
  assert.deepEqual(v.nota_itens, [{ cod: '7896213007386', descricao: 'CREAM CRACKER', bipado: true }]);
  assert.ok(!JSON.stringify(v.nota_itens).includes('"un"'), 'nota_itens nunca leva quantidade');
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

test('sem cadastro de validade (Validar=0): validade continua obrigatória (29/09/26), sem data fica sem_validade', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const xmlComSemValidar = { itens: [{ cod: '111', descricao: 'SEM VALIDAR', un: 3 }], naoPedidos: [], status: 'conciliado', pedidoId: 12, ln: 3 };
  R.init({ dir, cadastro: async c => CAD[c] || null, xmlLoja: () => xmlComSemValidar, agora: () => new Date('2026-09-25T08:00:00') });
  const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '2626'.padEnd(44, '0'), nNota: '911221', fornecedor: 'M DIAS', codFornec: 540 });
  const r = await R.bipar(c.id, { cod: '111', quant: 3, emb: 1, validade: null });
  assert.equal(r.resultado, 'sem_validade');
  assert.equal(r.item.estado, 'sem_validade');
  const r2 = await R.bipar(c.id, { cod: '111', quant: 3, emb: 1, validade: '2027-06-01' });
  assert.equal(r2.resultado, 'ok'); assert.equal(r2.item.aviso, 'sem_cadastro_validade');
});

test('bipeId repetido (fila offline reenviando): não soma de novo e devolve repetido:true', async () => {
  setup(); const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '2626'.padEnd(44, '0'), nNota: '911219', fornecedor: 'M DIAS', codFornec: 540 });
  const bipeId = 'bipe-1';
  const r1 = await R.bipar(c.id, { cod: '7896213007386', quant: 10, emb: 24, validade: '2027-03-28', bipeId });
  assert.equal(r1.resultado, 'ok'); assert.equal(r1.item.un, 240); assert.equal(r1.item.bipagens, 1); assert.ok(!r1.repetido);
  const r2 = await R.bipar(c.id, { cod: '7896213007386', quant: 10, emb: 24, validade: '2027-03-28', bipeId });
  assert.equal(r2.repetido, true); assert.equal(r2.resultado, 'ok');
  const it = R.obter(c.id).itens['7896213007386'];
  assert.equal(it.bipagens, 1); assert.equal(it.un, 240); assert.equal(it.quant, 10);
  // bipeId novo continua somando normalmente
  const r3 = await R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2027-03-28', bipeId: 'bipe-2' });
  assert.ok(!r3.repetido); assert.equal(r3.item.un, 264); assert.equal(r3.item.bipagens, 2);
  // corrigir também é idempotente pelo bipeId
  const c1 = await R.corrigir(c.id, { cod: '7896213007386', quant: 5, emb: 24, validade: '2027-03-28', bipeId: 'corr-1' });
  assert.ok(!c1.repetido); assert.equal(R.obter(c.id).itens['7896213007386'].un, 120);
  const c2 = await R.corrigir(c.id, { cod: '7896213007386', quant: 5, emb: 24, validade: '2027-03-28', bipeId: 'corr-1' });
  assert.equal(c2.repetido, true); assert.equal(R.obter(c.id).itens['7896213007386'].un, 120);
  // a visão da loja não vaza o controle interno de bipes
  assert.ok(!('bipes_vistos' in R.visaoLoja(3, c.id)));
});

test('lote (loja 10): desde 09/11/26 ninguém exige lote (só validade); lote enviado ainda vira linha por lote', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const xml = { itens: [{ cod: '111', descricao: 'SEM VALIDAR', un: 30 }], naoPedidos: [], status: 'conciliado', pedidoId: 12, ln: 10 };
  R.init({ dir, cadastro: async c => CAD[c] || null, xmlLoja: () => xml, agora: () => new Date('2026-09-29T08:00:00') });
  assert.equal(R.exigeLote(10), false); assert.equal(R.exigeLote(3), false);
  const c = R.abrirNota({ loja: 10, nome: 'CARMEM', chave: '2626'.padEnd(44, '0'), nNota: '77', fornecedor: 'F', codFornec: 1 });
  let r = await R.bipar(c.id, { cod: '111', quant: 10, emb: 1, validade: '2027-03-01' });
  assert.equal(r.resultado, 'ok', 'CD sem lote: ok, só a validade conta'); assert.equal(r.item.estado, 'ok');
  await R.corrigir(c.id, { cod: '111', quant: 10, emb: 1, validade: '2027-03-01', lote: ' l123a ' });
  r = await R.bipar(c.id, { cod: '111', quant: 20, emb: 1, validade: '2027-05-01', lote: 'L124B' });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.un, 30); assert.equal(r.item.validade, '2027-03-01', 'pior validade continua a do item');
  assert.deepEqual(r.item.lotes.map(l => l.lote + ':' + l.un + ':' + l.validade), ['L123A:10:2027-03-01', 'L124B:20:2027-05-01']);
  const v = R.visaoLoja(10, c.id); assert.equal(v.exige_lote, false); assert.equal(v.itens[0].lotes.length, 2);
  // loja 3: sem lote segue ok
  const xml3 = { ...xml, ln: 3 }; R.init({ dir, cadastro: async c => CAD[c] || null, xmlLoja: () => xml3, agora: () => new Date('2026-09-29T08:00:00') });
  const c3 = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '3636'.padEnd(44, '0'), nNota: '78', fornecedor: 'F', codFornec: 1 });
  r = await R.bipar(c3.id, { cod: '111', quant: 30, emb: 1, validade: '2027-03-01' });
  assert.equal(r.resultado, 'ok'); assert.equal(R.visaoLoja(3, c3.id).exige_lote, false);
});

test('caixa sem vínculo e com qtdemb 1 nos dois cadastros: un/cx vem da própria nota (11/11/26, CD NF 643671)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const cad = {
    '37896224803107': { cod: '37896224803107', descricao: 'ACHOC PO 3 CORACOES 200G SACHE CX12', qtdemb: 1, emb: 'CX', validar: 0 },
    '7896224803106': { cod: '7896224803106', descricao: '3 CORACOES CHOCOLATTO ACHOC PO 200G SACHE', qtdemb: 1, emb: 'CX', validar: 180 },
  };
  R.init({ dir, cadastro: async c => cad[c] || null, xmlLoja: () => null, vinculo: async () => null, agora: () => new Date('2026-11-11T08:00:00') });
  const chave = '6436'.padEnd(44, '0');
  // conferência antiga: aberta sem as un/cx da nota; reabrir completa
  let c = R.abrirNota({ loja: 10, nome: 'ALVES', chave, nNota: '643671', fornecedor: 'TRES CORACOES', codFornec: 1499, xmlItens: [{ cod: '7896224803106', ean: null, descricao: 'CHOCOLATTO', un: 2400, decisao: null }] });
  c = R.abrirNota({ loja: 10, nome: 'ALVES', chave, nNota: '643671', fornecedor: 'TRES CORACOES', codFornec: 1499, xmlItens: [{ cod: '7896224803106', ean: null, descricao: 'CHOCOLATTO', un: 2400, emb: 12, decisao: null }] });
  assert.equal(R.obter(c.id).xml_itens[0].emb, 12);
  const r = await R.bipar(c.id, { cod: '37896224803107', quant: 200, emb: 1, validade: '2027-10-15' });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.cod, '7896224803106'); assert.equal(r.item.emb, 12); assert.equal(r.item.un, 2400);
  assert.equal(R.terminei(c.id).bateu, true);
  assert.deepEqual(R.devolucoes(R.obter(c.id)), []);
});

test('caixa (DUN-14) bipada numa nota que traz a unidade: vira o item da unidade com as un/cx (07/11/26, CD nota 305)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const cad = {
    '17898962794057': { cod: '17898962794057', descricao: 'PAPEL HIG MAX PURE NEUTRO C4 30M FD16', qtdemb: 1, emb: 'UN', validar: 0 },
    '7898962794050': { cod: '7898962794050', descricao: 'MAX PURE PAPEL HIGIENICO FD C4 30M NEUTRO', qtdemb: 16, emb: 'FD', validar: 365 },
    '17896213007383': { cod: '17896213007383', descricao: 'CREAM CRACKER CX', qtdemb: 1, emb: 'UN', validar: 0 },
    '17890000000004': { cod: '17890000000004', descricao: 'CAIXA DE OUTRA COISA', qtdemb: 1, emb: 'UN', validar: 0 },
  };
  const xml = { itens: [{ cod: '7898962794050', descricao: 'PAPEL HIG', un: 3104 }, { cod: '7896213007386', descricao: 'CREAM CRACKER', un: 240 }], naoPedidos: [], status: 'conciliado', ln: 10 };
  const vinc = { '17898962794057': { cod: '7898962794050', emb: 16 } };
  R.init({ dir, cadastro: async c => cad[c] || CAD[c] || null, xmlLoja: () => xml, vinculo: async c => vinc[c] || null, agora: () => new Date('2026-11-07T08:00:00') });
  const c = R.abrirNota({ loja: 10, nome: 'ALVES', chave: '3057'.padEnd(44, '0'), nNota: '305', fornecedor: 'MAX PURE', codFornec: 9 });
  // pelo vínculo do Pedidos do CD: 194 fardos bipados pela caixa; o coletor mandou emb 1 (cadastro da caixa)
  let r = await R.bipar(c.id, { cod: '17898962794057', quant: 194, emb: 1, validade: '2027-11-10', lote: '1' });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.cod, '7898962794050'); assert.equal(r.item.emb, 16); assert.equal(r.item.un, 3104);
  assert.equal(r.item.caixa, '17898962794057'); assert.equal(r.item.emb_label, 'FD');
  assert.ok(!R.obter(c.id).itens['17898962794057'], 'não cria item pelo código da caixa');
  assert.equal(R.visaoLoja(10, c.id).nota_itens.find(n => n.cod === '7898962794050').bipado, true);
  // sem vínculo: a conta DUN-14 → EAN-13 acha a unidade na nota e usa as un/cx do cadastro da unidade (24)
  r = await R.bipar(c.id, { cod: '17896213007383', quant: 10, emb: 1, validade: '2027-11-28', lote: 'A' });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.cod, '7896213007386'); assert.equal(r.item.emb, 24); assert.equal(r.item.un, 240);
  // embalagem digitada pelo conferente (diferente de 1) é respeitada
  r = await R.bipar(c.id, { cod: '17896213007383', quant: 1, emb: 12, validade: '2027-11-28', lote: 'A' });
  assert.equal(r.item.emb, 12); assert.equal(r.item.un, 252);
  // caixa de produto que NÃO está na nota continua 'nao_esta_na_nota' pelo próprio código, em unidades
  r = await R.bipar(c.id, { cod: '17890000000004', quant: 1, emb: 1, validade: '2027-01-01', lote: 'B' });
  assert.equal(r.resultado, 'nao_esta_na_nota'); assert.equal(r.item.cod, '17890000000004'); assert.equal(r.item.emb, 1);
  // terminei: a unidade da nota bate (3104) e o cream cracker sobrou 12 → recontar só ele + a caixa fora da nota
  const t = R.terminei(c.id);
  assert.deepEqual(t.recontar.map(x => x.cod + ':' + x.motivo).sort(), ['17890000000004:nao_esta_na_nota', '7896213007386:recontar']);
});

test('regra da caixa é SÓ do CD (Tiago, 11/11/26): na loja a caixa bipada fica pelo próprio código, em unidades, e a visão não fala em caixa', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const cad = {
    '17898962794057': { cod: '17898962794057', descricao: 'PAPEL HIG MAX PURE NEUTRO C4 30M FD16', qtdemb: 1, emb: 'UN', validar: 0 },
    '7898962794050': { cod: '7898962794050', descricao: 'MAX PURE PAPEL HIGIENICO FD C4 30M NEUTRO', qtdemb: 16, emb: 'FD', validar: 365 },
  };
  const xml = { itens: [{ cod: '7898962794050', descricao: 'PAPEL HIG', un: 160, emb: 16 }], naoPedidos: [], status: 'conciliado', ln: 3 };
  R.init({ dir, cadastro: async c => cad[c] || CAD[c] || null, xmlLoja: () => xml, vinculo: async c => (c === '17898962794057' ? { cod: '7898962794050', emb: 16 } : null), agora: () => new Date('2026-11-11T08:00:00') });
  assert.equal(R.regraCaixa(10), true); assert.equal(R.regraCaixa(3), false);
  const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '3058'.padEnd(44, '0'), nNota: '306', fornecedor: 'MAX PURE', codFornec: 9 });
  const r = await R.bipar(c.id, { cod: '17898962794057', quant: 10, emb: 1, validade: '2027-11-10' });
  assert.equal(r.resultado, 'nao_esta_na_nota'); assert.equal(r.item.cod, '17898962794057'); assert.equal(r.item.un, 10); assert.ok(!r.item.caixa);
  const v = R.visaoLoja(3, c.id);
  assert.equal(v.regra_caixa, false); assert.ok(!('emb' in v.nota_itens[0]), 'loja não recebe a dica "vem em caixa"');
  // a unidade segue normal na loja
  const u = await R.bipar(c.id, { cod: '7898962794050', quant: 10, emb: 16, validade: '2028-06-30' });
  assert.equal(u.resultado, 'ok'); assert.equal(u.item.un, 160);
});
