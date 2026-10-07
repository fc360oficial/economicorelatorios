// Vínculo NF-e × pedido pelos ITENS (29/09/2026). Caso real: cotação gerou 4 pedidos do DIA no mesmo dia;
// a nota dos adoçantes (pedido 16) caiu no pedido 42 (Smirnoff), porque a busca só olhava CNPJ + loja + data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cx = require('../lib/conferencia-xml');

cx.init(async () => []);
const item = (cod, descricao, unidades, preco) => ({ item: 1, cod, descricao, und: 'UN', undTrib: 'UN', qtdCom: unidades, valorUnitCom: preco, unidades, precoUnit: preco, total: +(unidades * preco).toFixed(2), desconto: 0, conversao: 'trib' });
const nota = (nNota, itens) => ({ chave: 'CH' + nNota, nNota, serie: 1, data: '2026-09-29', cnpjEmit: '11111111000101', emitente: 'DIA', valorNFE: +itens.reduce((s, i) => s + i.total, 0).toFixed(2), valorProduto: 0, desconto: 0, frete: 0, ipi: 0, st: 0, importado: false, status: null, itens, boletos: [{ dup: 1, vencimento: '2026-10-13', valor: +itens.reduce((s, i) => s + i.total, 0).toFixed(2) }] });
const pedido = (id, criadoEm, itens, xml) => ({ id, teste: true, status: 'aprovado', codFornec: 83, fornecedor: 'DIA', lojas: [6], criadoEm, aprovadoEm: criadoEm,
  itens: itens.map(([cod, descricao, qtd, preco]) => ({ cod, descricao, emb: 1, qtd, lojas_qtd: { 6: qtd }, preco })), xml });
const gravar = (p, notas) => fs.writeFileSync(path.join(cx.TESTE_DIR, p.id + '.json'), JSON.stringify({ 6: notas }));
const limpar = ids => ids.forEach(id => { try { fs.unlinkSync(path.join(cx.TESTE_DIR, id + '.json')); } catch (e) {} });
async function rodar(pedidos, notas) {
  for (const p of pedidos) gravar(p, notas);            // o "ERP" devolve as mesmas notas pra todo pedido do fornecedor
  const salvos = {}; const rupturas = [];
  await cx.conferirTodos({ listar: () => pedidos.slice().sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)),   // mais novo primeiro, como listar() de verdade
    salvar: p => { salvos[p.id] = p; }, criarOuMesclarRuptura: (p, ln, f) => rupturas.push({ id: p.id, ln, faltas: f.length }) });
  limpar(pedidos.map(p => p.id));
  return { salvos, rupturas };
}

test('nota vai pro pedido que tem os itens dela, não pro pedido mais novo do mesmo fornecedor', async () => {
  const adocantes = pedido(9101, '2026-09-28T18:46:00.000Z', [['7896094906020', 'ADOCYL STEVIA', 36, 6.55], ['7896094914070', 'ADOCYL SUCRALOSE', 12, 6.10]]);
  const smirnoff = pedido(9102, '2026-09-28T21:20:00.000Z', [['7893218003603', 'SMIRNOFF ICE', 24, 5.74]]);
  const n1 = nota(2513636, [item('7896094906020', 'ADOCANTE ADOCYL STEVIA', 36, 6.55), item('7896094914070', 'ADOCANTE ADOCYL SUCRALOSE', 12, 6.10)]);
  const { rupturas } = await rodar([adocantes, smirnoff], [n1]);
  assert.deepEqual(adocantes.xml.lojas[6].notas.map(n => n.nNota), [2513636]);
  assert.equal(adocantes.xml.lojas[6].status, 'conciliado');
  assert.equal(smirnoff.xml.lojas[6].status, 'aguardando');
  assert.deepEqual(smirnoff.xml.lojas[6].notas, []);
  assert.deepEqual(rupturas, []);   // Smirnoff ainda não chegou: não é falta
});

test('nota sem nenhum item de nenhum pedido fica solta (pedido feito direto no Dlinks)', async () => {
  const p = pedido(9103, '2026-09-28T19:33:00.000Z', [['7891000307120', 'NESCAFE', 24, 4.13]]);
  const catchup = nota(2513589, [item('7896102502787', 'QUERO CATCHUP', 20, 3.5), item('7896102503814', 'HEINZ MOLHO', 24, 4.2)]);
  const { rupturas } = await rodar([p], [catchup]);
  assert.equal(p.xml.lojas[6].status, 'aguardando');
  assert.deepEqual(p.xml.lojas[6].notas, []);
  assert.deepEqual(rupturas, []);
});

test('vínculo errado antigo é desfeito quando a nota não tem item do pedido', async () => {
  const errado = { status: 'consistencia', notas: [{ chave: 'CH2513589', nNota: 2513589 }], itens: [{ cod: '7891000307120', pedida: 24, recebida: 0, tipo: 'falta' }], nao_pedidos: [{ cod: '7896102502787' }], problemas: [{ tipo: 'falta' }], ruptura_criada: true };
  const p = pedido(9104, '2026-09-28T19:33:00.000Z', [['7891000307120', 'NESCAFE', 24, 4.13]], { status: 'consistencia', lojas: { 6: errado } });
  p.status = 'recebido_parcial'; p.recebimento = { 6: { notas: [{ nNota: 2513589 }] } };
  const catchup = nota(2513589, [item('7896102502787', 'QUERO CATCHUP', 20, 3.5)]);
  await rodar([p], [catchup]);
  assert.equal(p.xml.lojas[6].status, 'aguardando');
  assert.deepEqual(p.xml.lojas[6].notas, []);
  assert.equal(p.xml.status, 'aguardando');
  assert.equal(p.status, 'aprovado');
  assert.equal(p.recebimento[6], undefined);
});

test('código DUN-14 ou com zero à esquerda no XML casa com o EAN do pedido', async () => {
  const p = pedido(9105, '2026-09-28T19:33:00.000Z', [['7891080150453', 'OLEO SOYA CANOLA', 20, 12.1], ['7891000416266', 'NESCAFE', 24, 4.13]]);
  const n = nota(2513637, [item('17891080150453', 'OLEO DE CANOLA SOYA', 20, 12.1), item('07891000416266', 'NESTLE NESCAFE', 24, 4.13)]);
  await rodar([p], [n]);
  const x = p.xml.lojas[6];
  assert.deepEqual(x.notas.map(n => n.nNota), [2513637]);
  assert.equal(x.status, 'conciliado');
  assert.deepEqual(x.nao_pedidos, []);
  assert.deepEqual(x.itens.map(i => [i.cod, i.recebida, i.tipo]), [['7891080150453', 20, 'ok'], ['7891000416266', 24, 'ok']]);
});

test('DUN-14 de verdade (digito verificador proprio) casa com o EAN do pedido — caso Alpes/Urca Loja 4, 02/10/2026', async () => {
  const p = pedido(9110, '2026-09-29T10:00:00.000Z', [
    ['7896274823833', 'ALPES SABAO BARRA 800G BLUE', 20, 8.00],
    ['7896274806577', 'ALPES SABAO BARRA UNITARIO 150G BLUE', 48, 1.60],
    ['7896056404014', 'URCA AMACIANTE 2L LAVANDA', 6, 6.47],
    ['7896056400047', 'URCA SABAO EM PASTA 500G', 12, 6.99]]);
  const n = nota(66290, [
    item('17896274823830', 'SABAO TB ALPES AZUL 900G 50X180G', 20, 8.00),      // caixa: 1 + base + verificador proprio (0, nao 3)
    item('17896274806574', 'SABAO TB ALPES AZUL UNITARIO 48X150G', 48, 1.60),
    item('17896056404011', 'AMACIANTE URCA LAVANDA LILAS 6X2LT', 6, 6.47),
    item('27896056400041', 'SABAO EM PASTA URCA 12X500G', 12, 6.99)]);        // prefixo 2 (outro nivel de embalagem)
  await rodar([p], [n]);
  const x = p.xml.lojas[6];
  assert.equal(x.status, 'conciliado');
  assert.deepEqual(x.nao_pedidos, []);
  assert.deepEqual(x.itens.map(i => [i.cod, i.recebida, i.tipo]),
    [['7896274823833', 20, 'ok'], ['7896274806577', 48, 'ok'], ['7896056404014', 6, 'ok'], ['7896056400047', 12, 'ok']]);
});

test('menos da metade dos itens da nota no pedido: vincula, mas avisa pra conferir se é este pedido', async () => {
  const p = pedido(9106, '2026-09-28T19:33:00.000Z', [['7896079441119', 'ARROZ NAMORADO', 10, 4.55], ['7891107111927', 'SALADA OLEO CANOLA', 20, 12.1]]);
  const n = nota(2513637, [item('7896079441119', 'ARROZ NAMORADO', 10, 4.55), item('17891080150453', 'OLEO SOYA CANOLA', 20, 12.1), item('17891080150477', 'OLEO SOYA GIRASSOL', 20, 12), item('7891080150456', 'OLEO SOYA MILHO', 20, 13.45), item('07891000416266', 'NESCAFE', 24, 4.13)]);
  await rodar([p], [n]);
  const x = p.xml.lojas[6];
  assert.deepEqual(x.notas.map(n => n.nNota), [2513637]);
  assert.equal(x.afinidade, 20);
  assert.ok(x.problemas.some(pr => pr.tipo === 'afinidade' && /conferir se é este pedido/i.test(pr.msg)), JSON.stringify(x.problemas));
});

test('empate de itens em comum: nota vai pro pedido mais antigo', async () => {
  const velho = pedido(9107, '2026-09-28T10:00:00.000Z', [['7896094906020', 'ADOCYL', 36, 6.55]]);
  const novo = pedido(9108, '2026-09-28T20:00:00.000Z', [['7896094906020', 'ADOCYL', 36, 6.55]]);
  const n = nota(2513640, [item('7896094906020', 'ADOCYL', 36, 6.55)]);
  await rodar([velho, novo], [n]);
  assert.deepEqual(velho.xml.lojas[6].notas.map(n => n.nNota), [2513640]);
  assert.equal(novo.xml.lojas[6].status, 'aguardando');
});

// 07/10/2026 — caso Knorr, Loja 5: a cartela "67891150016868" (CALDO KNORR CARNE CART 114G 1X1) é OUTRO GTIN do produto
// "7891150012363" (KNORR CALDO 114G CARNE). Nenhuma regra de dígito resolve: casa pelo NOME e o(a) comprador(a) confirma.
const os = require('os');
const DEPARA_TESTE = path.join(os.tmpdir(), 'xml-depara-teste-' + process.pid + '.json');
const limparDepara = () => { try { fs.unlinkSync(DEPARA_TESTE); } catch (e) {} };
const knorrPedido = id => pedido(id, '2026-10-06T10:00:00.000Z', [
  ['7891150097582', 'ALA LAVA ROUPAS EM PO 800G LAVANDA', 32, 4.94],
  ['7891150012363', 'KNORR CALDO 114G CARNE', 20, 3.25],
  ['7891150068278', 'MAIZENA CREMOGEMA 180G CHOCOLATE', 48, 4.72]]);
const knorrNota = () => nota(70001, [
  item('7891150097582', 'ALA LAVA ROUPAS PO LAVANDA 800G', 32, 4.94),
  item('67891150016868', 'CALDO KNORR CARNE CART 114G (GRANDE) 1X1', 20, 3.25),
  item('7891150068278', 'MAIZENA CREMOGEMA CHOCOLATE 180G', 48, 4.72)]);

test('código da nota é outro GTIN do mesmo produto: casa pelo nome, marca o vínculo e pede confirmação', async () => {
  cx.init(async () => [], { deparaPath: DEPARA_TESTE }); limparDepara();
  const p = knorrPedido(9120);
  const { rupturas } = await rodar([p], [knorrNota()]);
  const x = p.xml.lojas[6];
  assert.deepEqual(x.nao_pedidos, []);
  const knorr = x.itens.find(i => i.cod === '7891150012363');
  assert.equal(knorr.tipo, 'ok'); assert.equal(knorr.recebida, 20);
  assert.deepEqual(knorr.vinculo, { tipo: 'nome', cod_xml: '67891150016868', descricao_xml: 'CALDO KNORR CARNE CART 114G (GRANDE) 1X1' });
  assert.equal(x.status, 'consistencia');
  assert.deepEqual(x.problemas.map(pr => pr.tipo), ['vinculo_nome']);
  assert.deepEqual(rupturas, []);   // não é falta: não vira sugestão de ruptura
});

test('nome parecido mas sabor/gramatura diferente NÃO casa (Knorr carne × galinha, 800G × 1KG)', () => {
  assert.equal(cx.nomeCasa('KNORR CALDO 114G CARNE', 'CALDO KNORR GALINHA CART 114G 1X1'), false);
  assert.equal(cx.nomeCasa('ALA LAVA ROUPAS EM PO 800G LAVANDA', 'ALA LAVA ROUPAS PO LAVANDA 1KG'), false);
  assert.equal(cx.nomeCasa('MAIZENA CREMOGEMA 380G TRAD', 'MAIZENA CREMOGEMA TRADICIONAL 380G'), true);   // prefixo vale
  assert.equal(cx.nomeCasa('OLEO', 'OLEO SOYA 900ML'), false);   // uma palavra só não basta
});

test('dois itens do pedido que não vieram casam com o mesmo nome: fica em dúvida, não vincula', async () => {
  cx.init(async () => [], { deparaPath: DEPARA_TESTE }); limparDepara();
  const p = pedido(9121, '2026-10-06T10:00:00.000Z', [['7891150012363', 'KNORR CALDO CARNE', 20, 3.25], ['7891150012364', 'KNORR CARNE CALDO 114G', 24, 3.25], ['7891150068278', 'MAIZENA 180G', 48, 4.72]]);
  const n = nota(70002, [item('67891150016868', 'CALDO KNORR CARNE CART 114G 1X1', 12, 3.25), item('7891150068278', 'MAIZENA 180G', 48, 4.72)]);
  await rodar([p], [n]);
  const x = p.xml.lojas[6];
  assert.deepEqual(x.nao_pedidos.map(i => i.cod), ['67891150016868']);
  assert.deepEqual(x.itens.filter(i => i.tipo === 'falta').map(i => i.cod), ['7891150012363', '7891150012364']);
});

test('comprador(a) confirma o vínculo: de-para gravado, loja reconferida na hora e concilia; vale pro próximo pedido', async () => {
  cx.init(async () => [], { deparaPath: DEPARA_TESTE }); limparDepara();
  const p = knorrPedido(9122);
  await rodar([p], [knorrNota()]);
  assert.equal(p.xml.lojas[6].status, 'consistencia');
  gravar(p, [knorrNota()]);
  cx.vincularCod('67891150016868', '7891150012363', { por: 'Tiago' });
  const r = await cx.reconferirLoja(p, 6, {});
  limpar([p.id]);
  assert.equal(r.status, 'conciliado');
  assert.deepEqual(r.problemas, []);
  assert.equal(r.itens.find(i => i.cod === '7891150012363').vinculo.tipo, 'depara');
  assert.equal(p.xml.status, 'conciliado'); assert.equal(p.status, 'recebido');
  // próximo pedido do mesmo produto já nasce conciliado, sem pedir confirmação
  const p2 = knorrPedido(9123);
  await rodar([p2], [knorrNota()]);
  assert.equal(p2.xml.lojas[6].status, 'conciliado');
  assert.equal(p2.xml.lojas[6].itens.find(i => i.cod === '7891150012363').vinculo.tipo, 'depara');
});

test('comprador(a) diz que NÃO é o item: bloqueia o nome e o item volta a "não pedido" / "falta"', async () => {
  cx.init(async () => [], { deparaPath: DEPARA_TESTE }); limparDepara();
  const p = knorrPedido(9124);
  await rodar([p], [knorrNota()]);
  gravar(p, [knorrNota()]);
  cx.vincularCod('67891150016868', null, { por: 'Tiago' });
  const r = await cx.reconferirLoja(p, 6, {});
  limpar([p.id]); limparDepara();
  assert.deepEqual(r.nao_pedidos.map(i => i.cod), ['67891150016868']);
  assert.equal(r.itens.find(i => i.cod === '7891150012363').tipo, 'falta');
  assert.equal(r.itens.find(i => i.cod === '7891150012363').vinculo, undefined);
});

// 07/10/2026 — visto no .252: o XML traz o código de item do fornecedor (cProd = "11084") e central.fornecedoritens
// (CodFornecedor 405 União, CodigoFornec 11084 → 7891150012363) já liga ao produto. É cadastro do ERP: casa direto.
test('código de item do fornecedor (cProd) casa pelo cadastro central.fornecedoritens, sem pedir confirmação', async () => {
  const qERP = async (sql, params) => /fornecedoritens/.test(sql) && params[0] === 405 ? [{ cf: '11084', cb: '7891150012363' }, { cf: '0407', cb: '7894000010014' }] : [];
  cx.init(qERP, { deparaPath: DEPARA_TESTE }); limparDepara();
  const p = knorrPedido(9130); p.codFornec = 405;
  const n = knorrNota(); n.itens[1].codFornec = '11084';
  const { rupturas } = await rodar([p], [n]);
  const x = p.xml.lojas[6];
  assert.equal(x.status, 'conciliado');
  assert.deepEqual(x.problemas, []);
  assert.deepEqual(x.nao_pedidos, []);
  const knorr = x.itens.find(i => i.cod === '7891150012363');
  assert.equal(knorr.tipo, 'ok'); assert.equal(knorr.recebida, 20);
  assert.deepEqual(knorr.vinculo, { tipo: 'fornecedor', cod_xml: '67891150016868', descricao_xml: 'CALDO KNORR CARNE CART 114G (GRANDE) 1X1', cod_fornec: '11084' });
  assert.deepEqual(rupturas, []);
  cx.init(async () => [], { deparaPath: DEPARA_TESTE });
});

test('cProd que no cadastro aponta pra produto FORA do pedido não casa (cai pro nome)', async () => {
  const qERP = async (sql, params) => /fornecedoritens/.test(sql) ? [{ cf: '11084', cb: '7891098000156' }] : [];   // Leão chá, outro fornecedor
  cx.init(qERP, { deparaPath: DEPARA_TESTE }); limparDepara();
  const p = knorrPedido(9131); p.codFornec = 405;
  const n = knorrNota(); n.itens[1].codFornec = '11084';
  await rodar([p], [n]);
  const knorr = p.xml.lojas[6].itens.find(i => i.cod === '7891150012363');
  assert.equal(knorr.vinculo.tipo, 'nome');
  assert.equal(p.xml.lojas[6].status, 'consistencia');
  cx.init(async () => [], { deparaPath: DEPARA_TESTE }); limparDepara();
});
