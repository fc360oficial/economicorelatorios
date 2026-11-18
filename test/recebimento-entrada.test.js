const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { itensDaNota } = require('../lib/recebimento-entrada');

// NF 340 da Comercial Campos no CD (18/11/26), como está no ERP: o XML traz o Pampulha SEM código de barras e os
// panettones pela unidade; a entrada lançou o Pampulha pelo código interno em CAIXA c/ 20 e os panettones pela caixa.
const XML_340 = [
  { nItem: 1, CodigoBarras: 'SEM GTIN', ocEanTrib: 'SEM GTIN', Descricao: 'QUEIJO RALADO PAMPULHA 20 X 50 G.', Und: 'CX', Qtd: '300.0000', oqTrib: '300.0000' },
  { nItem: 2, CodigoBarras: '7896369617743', ocEanTrib: '7896369617743', Descricao: 'PANETTONE FRUTAS CRISTALIZADAS MARIZA 40', Und: 'UND', Qtd: '1680.0000', oqTrib: '1680.0000' },
  { nItem: 3, CodigoBarras: '7896369617750', ocEanTrib: '7896369617750', Descricao: 'PANETTONE GOTAS CHOCOLATE MARIZA 400G CX', Und: 'UND', Qtd: '840.0000', oqTrib: '840.0000' },
];
const ENTRADA_340 = [
  { Item: 1, CodigoBarra: '7898920160897', Unid: 'CX', Qtd: '300', QtdEmb: '20', QtdEntradaEstoque: '6000', Descricao: 'PAMPULHA QUEIJO RALADO 50G', Cancelado: 0, ocEanTrib: 'SEM GTIN' },
  { Item: 2, CodigoBarra: '27896369617747', Unid: 'CX', Qtd: '140', QtdEmb: '1', QtdEntradaEstoque: '140', Descricao: 'PANETTONE MARIZA 400G FRUTAS CX12', Cancelado: 0, ocEanTrib: '7896369617743' },
  { Item: 3, CodigoBarra: '27896369617754', Unid: 'CX', Qtd: '70', QtdEmb: '1', QtdEntradaEstoque: '70', Descricao: 'PANETTONE MARIZA 400G CHOCOLATE CX12', Cancelado: 0, ocEanTrib: '7896369617750' },
];

test('sem entrada no ERP a nota sai só do XML, igual a antes (linha SEM GTIN fica com o texto, sem un/cx)', () => {
  const its = itensDaNota(XML_340, []);
  assert.deepEqual(its[0], { cod: 'SEM GTIN', ean: null, descricao: 'QUEIJO RALADO PAMPULHA 20 X 50 G.', un: 300, emb: null, decisao: null });
  assert.deepEqual(its[1], { cod: '7896369617743', ean: null, descricao: 'PANETTONE FRUTAS CRISTALIZADAS MARIZA 40', un: 1680, emb: null, decisao: null });
  assert.deepEqual(itensDaNota(XML_340, null), its);
});

test('NF 340: entrada em CAIXA c/ 20 dá código à linha SEM GTIN e ela passa a valer 6.000 un (300 cx × 20)', () => {
  const its = itensDaNota(XML_340, ENTRADA_340);
  const p = its.find(i => i.cod === '7898920160897');
  assert.ok(p, 'a linha sem código de barras ganhou o código interno da entrada');
  assert.equal(p.un, 6000); assert.equal(p.emb, 20); assert.equal(p.cx, true);
  assert.equal(p.descricao, 'PAMPULHA QUEIJO RALADO 50G');
  assert.ok(!its.some(i => i.cod === 'SEM GTIN'));
});

test('NF 340: panettone lançado pela CAIXA na entrada — a linha segue pela unidade (1.680 un), a caixa vira apelido e as un/cx saem de 1.680 ÷ 140', () => {
  const its = itensDaNota(XML_340, ENTRADA_340);
  const f = its.find(i => i.cod === '7896369617743');
  assert.equal(f.un, 1680); assert.equal(f.emb, 12); assert.equal(f.erp, '27896369617747'); assert.ok(!f.cx);
  const c = its.find(i => i.cod === '7896369617750');
  assert.equal(c.un, 840); assert.equal(c.emb, 12); assert.equal(c.erp, '27896369617754');
});

test('entrada "crua" (300 UN, emb 1, como estava antes da correção no ERP) só dá o código à linha; a quantidade do XML não muda', () => {
  const crua = [{ ...ENTRADA_340[0], Unid: 'UN', QtdEmb: '1', QtdEntradaEstoque: '300' }, ENTRADA_340[1], ENTRADA_340[2]];
  const p = itensDaNota(XML_340, crua).find(i => i.cod === '7898920160897');
  assert.equal(p.un, 300); assert.equal(p.emb, null); assert.ok(!p.cx);
});

test('entrada nunca rebaixa o XML: nota 200 CX = 2.400 un (c/ 12) e entrada 200 UN fica 2.400; entrada 200 CX c/ 12 marca a linha como caixa', () => {
  const xml = [{ nItem: 1, CodigoBarras: '7891000000017', ocEanTrib: '7891000000017', Descricao: 'CAFE 250G', Und: 'CX', Qtd: '200', oqTrib: '2400' }];
  let i = itensDaNota(xml, [{ Item: 1, CodigoBarra: '7891000000017', Unid: 'UN', Qtd: '200', QtdEmb: '1', QtdEntradaEstoque: '200', Cancelado: 0, ocEanTrib: '7891000000017' }])[0];
  assert.equal(i.un, 2400); assert.equal(i.emb, 12); assert.ok(!i.cx);
  i = itensDaNota(xml, [{ Item: 1, CodigoBarra: '7891000000017', Unid: 'CX', Qtd: '200', QtdEmb: '12', QtdEntradaEstoque: '2400', Cancelado: 0, ocEanTrib: '7891000000017' }])[0];
  assert.equal(i.un, 2400); assert.equal(i.emb, 12); assert.equal(i.cx, true);
});

test('linha SEM GTIN só casa com a entrada pelo nº do item E pela quantidade; linha cancelada na entrada não conta; número BR "1.680,00" é lido', () => {
  // item 1 da entrada com outra quantidade: não é a mesma linha → fica como antes
  let its = itensDaNota(XML_340, [{ ...ENTRADA_340[0], Qtd: '77', QtdEntradaEstoque: '1540' }]);
  assert.ok(its.some(i => i.cod === 'SEM GTIN')); assert.ok(!its.some(i => i.cod === '7898920160897'));
  its = itensDaNota(XML_340, [{ ...ENTRADA_340[0], Cancelado: 1 }]);
  assert.ok(its.some(i => i.cod === 'SEM GTIN'));
  // duas linhas sem código de barras: cada uma ganha o código da sua linha da entrada (não empilham mais numa só)
  const xml2 = [XML_340[0], { nItem: 2, CodigoBarras: 'SEM GTIN', ocEanTrib: 'SEM GTIN', Descricao: 'SHAMPOO 350ML', Und: 'UN', Qtd: '24', oqTrib: '24' }];
  its = itensDaNota(xml2, [ENTRADA_340[0], { Item: 2, CodigoBarra: '7890000000024', Unid: 'UN', Qtd: '24,00', QtdEmb: '1', QtdEntradaEstoque: '24,00', Descricao: 'SHAMPOO X 350ML', Cancelado: 0, ocEanTrib: 'SEM GTIN' }]);
  assert.deepEqual(its.map(i => [i.cod, i.un]), [['7898920160897', 6000], ['7890000000024', 24]]);
  const br = itensDaNota([{ nItem: 1, CodigoBarras: '7896369617743', ocEanTrib: '7896369617743', Descricao: 'X', Und: 'UND', Qtd: '1.680,00', oqTrib: '1.680,00' }], [])[0];
  assert.equal(br.un, 1680);
});

// ── coletor de ponta a ponta com a NF 340 (rotas reais, ERP simulado) ──────────────────────────────────────────────
const montarRotasRecebimento = require('../lib/recebimento-rotas');
const recebimento = require('../lib/recebimento');
function fakeApp() { const routes = {}; const reg = (m, p, ...h) => { routes[m + ' ' + p] = h[h.length - 1]; }; return { app: { get: (p, ...h) => reg('GET', p, ...h), post: (p, ...h) => reg('POST', p, ...h) }, routes }; }
const req = ({ query = {}, body = {}, params = {}, session = {} } = {}) => ({ query, body, params, headers: {}, session });
function res() { const r = { statusCode: 200 }; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; return r; }
const CH = '26261148468783000169550010000003401000011064';
const CAD = {
  '7898920160897': { cod: '7898920160897', descricao: 'PAMPULHA QUEIJO RALADO 50G', qtdemb: 1, emb: 'UN', validar: 90 },
  '7896369617743': { cod: '7896369617743', descricao: 'MARIZA PANETTONE FRUTAS 400G', qtdemb: 1, emb: 'UN', validar: 1 },
  '27896369617747': { cod: '27896369617747', descricao: 'PANETTONE MARIZA 400G FRUTAS CX12', qtdemb: 0, emb: 'UN', validar: 1 },
};
function ambiente(estado) {
  const { app, routes } = fakeApp(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-entrada-'));
  const lotes = [];
  const q = async (sql, params) => {
    if (sql.includes('FROM central.axml WHERE Chave=?')) return [{ Chave: params[0], nNota: '340', CNPJemit: '48468783000169', CNPJdest: '61920643000148', NomeEmit: 'COMERCIAL DE ALIMENTOS CAMPOS LTDA' }];
    if (sql.includes('FROM central.axmlprodutos')) return XML_340;
    if (sql.includes('FROM central.compras WHERE chave=? AND nLoja=?')) { if (estado.erro) throw new Error('ERP fora do ar'); return estado.entrada ? [{ nCompra: 8692, nLoja: 10, Status: 'E' }] : []; }
    if (sql.includes('FROM central.compraprodutos WHERE nCompra=? AND nLoja=?')) return estado.entrada || [];
    if (sql.includes('FROM central.fornecedor')) return [{ cod: 2525, nome: 'COMERCIAL DE ALIMENTOS CAMPOS LTDA' }];
    if (sql.includes('FROM central.itens WHERE CodigoBarra=?')) { const k = CAD[params[0]]; return k ? [{ cod: k.cod, descricao: k.descricao, qtdemb: k.qtdemb, emb: k.emb, validar: k.validar }] : []; }
    return [];
  };
  const api = montarRotasRecebimento(app, { q, path, escreverERP: { lote: async a => { lotes.push(a); return { ok: true, id: 'L', ids: [182394] }; } }, pedidosFornec: { listar: () => [] },
    conferenciaXml: { LOJA_CNPJ: {} }, logColetor: { registrar() {} }, LOG_COLETOR_DIR: dir, __dirname: dir });
  return { routes, lotes, api };
}
const VAL = () => new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);

test('coletor do CD, NF 340 já com a entrada em caixa: o Pampulha está na nota, a lista avisa "caixa c/ 20" e 300 caixas viram 6.000 un; bipe sem embalagem também', async () => {
  const estado = { entrada: ENTRADA_340 }; const { routes, lotes } = ambiente(estado);
  const t = recebimento.config().lojas[10].token;
  await routes['POST /api/recebimento-publico/danfe'](req({ query: { t }, body: { chave: CH, nome: 'LIMA' } }), res());
  let r = res(); await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: CH, nome: 'LIMA' } }), r);
  assert.equal(r.statusCode, 200);
  const ni = r.body.nota_itens.find(n => n.cod === '7898920160897');
  assert.deepEqual(ni, { cod: '7898920160897', descricao: 'PAMPULHA QUEIJO RALADO 50G', emb: 20, cx: true, bipado: false });
  assert.ok(!('un' in ni), 'a quantidade da nota nunca vai pro coletor (conferência cega)');
  const id = r.body.id;
  // cartão novo manda 300 × 20; coletor com a página antiga manda 300 × 1 — o servidor garante as un/cx da linha
  r = res(); await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '7898920160897', quant: 300, emb: 1, validade: VAL(), bipeId: 'b1' } }), r);
  assert.equal(r.body.resultado, 'ok'); assert.equal(r.body.item.un, 6000); assert.equal(r.body.item.emb, 20); assert.equal(r.body.item.cx, true);
  // espelho no ERP de teste: 300 CX × 20 (qtd × qtdemb = 6.000), com o código do produto
  const esp = lotes.map(l => l.passos[0]).find(p => p.tabela === 'conferenciaitens');
  assert.equal(esp.valores.codigobarra, '7898920160897'); assert.equal(esp.valores.qtd, 300); assert.equal(esp.valores.qtdemb, 20); assert.equal(esp.valores.emb, 'CX');
  // panettone bipado pela caixa que a entrada lançou: cai na linha da unidade, 140 cx × 12 = 1.680 un
  r = res(); await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '27896369617747', quant: 140, validade: VAL(), bipeId: 'b2' } }), r);
  assert.equal(r.body.resultado, 'ok'); assert.equal(r.body.item.cod, '7896369617743'); assert.equal(r.body.item.un, 1680); assert.equal(r.body.item.caixa, '27896369617747');
});

test('entrada corrigida no ERP com a conferência aberta (300 UN → 300 CX c/ 20): item contado 300 × 1 sai de "não está na nota", NÃO é multiplicado sozinho, cai no recontar e a correção fecha em 6.000', async () => {
  const estado = { entrada: null }; const { routes, api } = ambiente(estado);
  const t = recebimento.config().lojas[10].token;
  await routes['POST /api/recebimento-publico/danfe'](req({ query: { t }, body: { chave: CH, nome: 'LIMA' } }), res());
  let r = res(); await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: CH, nome: 'LIMA' } }), r);
  const id = r.body.id;
  // sem entrada: a linha é "SEM GTIN" e o produto bipado cai fora da nota, em unidades (foi o que aconteceu às 17:51)
  r = res(); await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '7898920160897', quant: 300, emb: 1, validade: VAL(), bipeId: 'a1' } }), r);
  assert.equal(r.body.resultado, 'nao_esta_na_nota'); assert.equal(r.body.item.un, 300);
  // o fiscal corrige a entrada no ERP; passa o cache de 1 min da entrada
  estado.entrada = ENTRADA_340; if (api && api.entradaLimpar) api.entradaLimpar();
  await new Promise(ok => setTimeout(ok, 5));
  r = res(); await routes['POST /api/recebimento-publico/terminei'](req({ query: { t }, body: { id } }), r);
  let c = recebimento.obter(id);
  assert.equal(c.itens['7898920160897'].estado, 'ok', 'agora está na nota');
  assert.equal(c.itens['7898920160897'].un, 300, 'a contagem do conferente não é mexida pelo sistema');
  assert.equal(r.body.bateu, false);
  assert.ok(r.body.recontar.some(x => x.cod === '7898920160897' && x.motivo === 'recontar'));
  assert.ok(!r.body.recontar.some(x => x.motivo === 'nao_esta_na_nota'));
  // o conferente abre o item (cartão "Caixas (c/ 20)") e grava 300
  r = res(); await routes['POST /api/recebimento-publico/corrigir'](req({ query: { t }, body: { id, cod: '7898920160897', quant: 300, emb: 20, validade: VAL(), bipeId: 'a2' } }), r);
  assert.equal(r.body.item.un, 6000); assert.equal(r.body.item.cx, true);
  assert.equal(r.body.visao.itens.find(i => i.cod === '7898920160897').cx, true);
});

test('soluço do ERP na leitura da entrada não desfaz a lista da conferência aberta; entrada que some de verdade (lançamento apagado) volta pro XML', async () => {
  const estado = { entrada: ENTRADA_340 }; const { routes, api } = ambiente(estado);
  const t = recebimento.config().lojas[10].token; const CH2 = CH.slice(0, 43) + '5';
  await routes['POST /api/recebimento-publico/danfe'](req({ query: { t }, body: { chave: CH2, nome: 'LIMA' } }), res());
  let r = res(); await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: CH2, nome: 'LIMA' } }), r);
  const id = r.body.id;
  r = res(); await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '7898920160897', quant: 300, emb: 20, validade: VAL(), bipeId: 'e1' } }), r);
  assert.equal(r.body.item.un, 6000);
  const lista = () => recebimento.obter(id).xml_itens.map(i => i.cod).join(',');
  const antes = lista();
  estado.erro = true; api.entradaLimpar();
  r = res(); await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '7898920160897', quant: 1, emb: 20, validade: VAL(), bipeId: 'e2' } }), r);
  assert.equal(r.body.resultado, 'ok'); assert.equal(r.body.item.un, 6020); assert.equal(lista(), antes);
  estado.erro = false; estado.entrada = null; api.entradaLimpar();
  r = res(); await routes['POST /api/recebimento-publico/terminei'](req({ query: { t }, body: { id } }), r);
  assert.match(lista(), /SEM GTIN/);
  assert.equal(recebimento.obter(id).itens['7898920160897'].estado, 'nao_esta_na_nota');
});

test('regra da caixa continua só no CD: numa loja a mesma entrada em caixa não muda o cartão nem força embalagem', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-entrada-loja-'));
  recebimento.init({ dir, cadastro: async cod => CAD[cod] || null, xmlLoja: () => null });
  const itens = itensDaNota(XML_340, ENTRADA_340);
  const c = recebimento.abrirNota({ loja: 3, nome: 'ANA', chave: '9'.repeat(44), nNota: '340', fornecedor: 'X', codFornec: 1, xmlItens: itens });
  const v = recebimento.visaoLoja(3, c.id);
  assert.deepEqual(v.nota_itens.find(n => n.cod === '7898920160897'), { cod: '7898920160897', descricao: 'PAMPULHA QUEIJO RALADO 50G', bipado: false });
  const r = await recebimento.bipar(c.id, { cod: '7898920160897', quant: 300, emb: 1, validade: VAL() });
  assert.equal(r.item.un, 300); assert.ok(!r.item.cx);
});
