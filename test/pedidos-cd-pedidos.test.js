// test/pedidos-cd-pedidos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

let sql = []; let params = [];
// Pedidos digitados pelo CD no Televendas (central.delivery + delivery_produtos) e situação no painel.
// deliverySeq: fila opcional de listas de candidatos por chamada; itensCD: nPedido → códigos digitados;
// statusPainel: nPedido → Status do painel (4 liberado; undefined = ainda não mandado pro painel).
let deliverySeq = null;
let itensCD = { 6400: ['17896037913143'] };
let statusPainel = { 6400: 4 };
let fornecedorCnpj = null; // CNPJ devolvido por central.fornecedor (null = cadastro sem CNPJ)
let semNota = false; // true = loja ainda não recebeu nota do CD
const fakeQ = async (s, p) => {
  sql.push(s); params.push(p);
  if (s.includes('central.fornecedor')) return fornecedorCnpj ? [{ cnpj: fornecedorCnpj }] : [];
  if (s.includes('FROM central.delivery d')) { if (deliverySeq && deliverySeq.length) return deliverySeq.shift(); return [{ nPedido: '6400', d: '2026-09-15', hora: '10:07:11' }]; }
  if (s.includes('delivery_produtos')) return (itensCD[p[0]] || []).map(cod => ({ cod }));
  if (s.includes('painel_televendas')) { const st = statusPainel[p[0]]; return st === undefined ? [] : [{ statusCD: st, dl: st === 4 ? '2026-09-15' : null, he: '14:10' }]; }
  if (s.includes('conferencia_televendas')) return [{ cod: '17896037913143', cx: 3 }];
  if (s.includes('FROM central.compras c')) return semNota ? [] : [{ cod: '7896037913146', cx: 2, nNota: 4900, d: '2026-09-16' }];
  return [];
};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-'));
cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir });
cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 't' });
cd._setBaseParaTeste({ hoje: '2026-09-14', cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5 } }, un: { '7896037913146': { descricao: 'VINHO', custo: 20, porLoja: {} } }, lead: {} });

test('criarPedidos: 1 por loja, só itens com caixas > 0, recusa produto fora do CD', () => {
  const ps = cd.criarPedidos({ lojas: { 1: [{ codigoCD: '17896037913143', caixas: 3 }], 2: [{ codigoCD: '17896037913143', caixas: 0 }] }, usuario: 'tiago' });
  assert.equal(ps.length, 1);
  assert.equal(ps[0].loja, 1); assert.equal(ps[0].status, 'aberto');
  assert.equal(ps[0].itens[0].unidades, 36); assert.equal(ps[0].totais.custo, 720);
  assert.throws(() => cd.criarPedidos({ lojas: { 1: [{ codigoCD: '999', caixas: 1 }] }, usuario: 't' }), /estoque do CD/);
});


test('verificar: separado pelo painel do CD e recebido pela nota da loja', async () => {
  const r = await cd.verificar();
  const p = cd.listarPedidos()[0];
  assert.equal(p.expedicao.nPedido, '6400');
  assert.equal(p.itens[0].separadas, 3);
  assert.equal(p.itens[0].recebidas, 2);
  assert.equal(p.status, 'recebido_parcial');
  assert.equal(r.verificados, 1);
});

test('criarPedidos: não grava nada se alguma loja tiver produto fora do CD', () => {
  const antes = cd.listarPedidos().length;
  assert.throws(() => cd.criarPedidos({ lojas: { 1: [{ codigoCD: '17896037913143', caixas: 1 }], 2: [{ codigoCD: '999', caixas: 1 }] }, usuario: 't' }), /estoque do CD/);
  assert.equal(cd.listarPedidos().length, antes);
});

test('cancelar', () => {
  const p = cd.listarPedidos()[0];
  cd.cancelarPedido(p.id, 'tiago');
  assert.equal(cd.obterPedido(p.id).status, 'cancelado');
  assert.throws(() => cd.cancelarPedido(p.id, 'tiago'), /cancelado/);
});

test('obterPedido: id inválido/path traversal devolve null', () => {
  assert.equal(cd.obterPedido('../config'), null);
  assert.equal(cd.obterPedido('abc'), null);
});

test('verificar: pedido em trânsito há mais de 30 dias expira', async () => {
  const [p] = cd.criarPedidos({ lojas: { 1: [{ codigoCD: '17896037913143', caixas: 1 }] }, usuario: 'tiago' });
  const arqPed = path.join(dataDir, 'pedidos-cd', `${p.id}.json`);
  const dados = JSON.parse(fs.readFileSync(arqPed, 'utf8'));
  dados.criadoEm = new Date(Date.now() - 40 * 86400000).toISOString();
  fs.writeFileSync(arqPed, JSON.stringify(dados));
  await cd.verificar();
  assert.equal(cd.obterPedido(p.id).status, 'expirado');
});

test('verificar: casa expedição do pedido mais antigo primeiro e não reusa nota', async () => {
  // dataDir isolado pra não herdar expedição/nota de pedidos de testes anteriores
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd2-'));
  cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir: dataDir2 });
  cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 't' });
  cd._setBaseParaTeste({ hoje: '2026-09-14', cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5 } }, un: { '7896037913146': { descricao: 'VINHO', custo: 20, porLoja: {} } }, lead: {} });

  const [pA] = cd.criarPedidos({ lojas: { 1: [{ codigoCD: '17896037913143', caixas: 2 }] }, usuario: 'tiago' });
  const arqA = path.join(dataDir2, 'pedidos-cd', `${pA.id}.json`);
  const dA = JSON.parse(fs.readFileSync(arqA, 'utf8'));
  dA.criadoEm = new Date(Date.now() - 3600000).toISOString(); // A criado 1h antes de B, mas dentro da janela de 30 dias
  fs.writeFileSync(arqA, JSON.stringify(dA));
  const [pB] = cd.criarPedidos({ lojas: { 1: [{ codigoCD: '17896037913143', caixas: 2 }] }, usuario: 'tiago' }); // B mais novo (criadoEm real)

  itensCD = { 7400: ['17896037913143'], 7401: ['17896037913143'] }; statusPainel = { 7400: 4, 7401: 4 };
  deliverySeq = [[{ nPedido: '7400', d: '2026-09-15', hora: '10:00:00' }], [{ nPedido: '7401', d: '2026-09-16', hora: '10:00:00' }]];
  sql = []; params = [];
  await cd.verificar();
  deliverySeq = null;

  const delivCalls = sql.map((s, i) => ({ s, p: params[i] })).filter(x => x.s.includes('FROM central.delivery d'));
  assert.equal(delivCalls.length, 2);
  assert.ok(!delivCalls[0].p.includes('7400')); // A processado primeiro (mais antigo), sem exclusão ainda
  assert.ok(delivCalls[1].s.includes('NOT IN'));
  assert.ok(delivCalls[1].p.includes('7400')); // B não pode casar com o nPedido já atribuído ao A

  const comprasCalls = sql.map((s, i) => ({ s, p: params[i] })).filter(x => x.s.includes('FROM central.compras c'));
  assert.equal(comprasCalls.length, 2);
  assert.ok(!comprasCalls[0].s.includes('nNota NOT IN'));
  assert.ok(comprasCalls[1].s.includes('nNota NOT IN'));
  assert.ok(comprasCalls[1].p.includes('4900')); // B não pode reusar a nota já registrada pelo A

  assert.equal(cd.obterPedido(pA.id).expedicao.nPedido, '7400');
  assert.equal(cd.obterPedido(pB.id).expedicao.nPedido, '7401');
});

test('criarPedidos: caixa sem vínculo vai como produto novo pela caixa, un/cx do cadastro', () => {
  cd._setBaseParaTeste({ hoje: '2026-09-14', cd: { '77900204333763': { descricao: 'SANDALIA IPANEMA INF CX6', estoqueCx: 4, unPorCaixaCadastro: 6 } }, un: {}, lead: {} });
  const [p] = cd.criarPedidos({ lojas: { 3: [{ codigoCD: '77900204333763', caixas: 1 }] }, usuario: 'tiago' });
  const it = p.itens[0];
  assert.equal(it.unidade, null); assert.equal(it.semVinculo, true); assert.equal(it.origem, 'novo');
  assert.equal(it.unPorCaixa, 6); assert.equal(it.unidades, 6); assert.equal(it.descricao, 'SANDALIA IPANEMA INF CX6');
});

test('pedido ganha token e porTokens acha por um ou vários', () => {
  const ps = cd.listarPedidos();
  assert.ok(ps.length >= 2); for (const p of ps) assert.match(p.token, /^[a-f0-9]{32}$/);
  assert.equal(cd.porTokens(ps[0].token).length, 1);
  assert.equal(cd.porTokens(ps[0].token + ',' + ps[1].token).length, 2);
  assert.equal(cd.porTokens('xx').length, 0);
});

test('trânsito: pedido separado conta só o que o CD separou; o que faltou volta pra sugestão', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-tr-'));   // pasta própria: sem pedidos das outras etapas
  cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir });
  cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 't' });
  cd._setBaseParaTeste({ hoje: '2026-09-14', cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5 } }, un: { '7896037913146': { descricao: 'VINHO', custo: 20, porLoja: {} } }, lead: {} });
  const [p] = cd.criarPedidos({ lojas: { 2: [{ codigoCD: '17896037913143', caixas: 5 }] }, usuario: 't' });
  let t = cd.transitoPedidos(); assert.equal(t['7896037913146|2'], 60);          // aberto: 5 cx × 12
  const x = cd.obterPedido(p.id); x.status = 'separado'; x.itens[0].separadas = 3; require('fs').writeFileSync(require('path').join(dataDir, 'pedidos-cd', p.id + '.json'), JSON.stringify(x));
  t = cd.transitoPedidos(); assert.equal(t['7896037913146|2'], 36);              // separado: só 3 cx × 12
  cd.cancelarPedido(p.id, 't');
});

// Desde 03/09/2026 o Televendas grava o CNPJ do cliente (antes era o código 828/899…). A loja precisa casar
// pelos dois: código de cliente (delivery.CodCliente) E CNPJ do cadastro central.fornecedor (delivery.CPF).
test('verificar: casa o pedido do CD pelo código de cliente OU pelo CNPJ do cadastro', async () => {
  const dataDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd3-'));
  cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir: dataDir3 });
  cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 't' });
  cd._setBaseParaTeste({ hoje: '2026-09-14', cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5 } }, un: { '7896037913146': { descricao: 'VINHO', custo: 20, porLoja: {} } }, lead: {} });
  cd.criarPedidos({ lojas: { 5: [{ codigoCD: '17896037913143', caixas: 2 }] }, usuario: 'tiago' });

  fornecedorCnpj = '51632927000185';
  sql = []; params = [];
  await cd.verificar();
  fornecedorCnpj = null;

  const deliv = sql.map((s, i) => ({ s, p: params[i] })).find(x => x.s.includes('FROM central.delivery d'));
  assert.ok(deliv.s.includes('d.CodCliente IN (') && deliv.s.includes('d.CPF IN ('));
  assert.ok(deliv.p.includes(1684));            // código de cliente da L5 PORTA LARGA
  assert.ok(deliv.p.includes('51632927000185')); // CNPJ da L5 no cadastro de fornecedores
});

test('verificar: pedido digitado no CD mas não liberado aparece como "no CD" e continua aberto', async () => {
  const dataDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd4-'));
  cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir: dataDir4 });
  cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 't' });
  cd._setBaseParaTeste({ hoje: '2026-09-14', cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5 } }, un: { '7896037913146': { descricao: 'VINHO', custo: 20, porLoja: {} } }, lead: {} });
  const [p] = cd.criarPedidos({ lojas: { 5: [{ codigoCD: '17896037913143', caixas: 2 }] }, usuario: 'tiago' });

  // 1ª rodada: CD digitou o pedido 6593 (itens batem) e ele está no painel com Status 0 (ainda não liberado)
  itensCD = { 6593: ['17896037913143'] }; statusPainel = { 6593: 0 }; semNota = true;
  deliverySeq = [[{ nPedido: '6593', d: '2026-09-17', hora: '10:07:11' }]];
  await cd.verificar();
  let x = cd.obterPedido(p.id);
  assert.equal(x.status, 'aberto');
  assert.ok(!x.expedicao);
  assert.deepEqual(x.noCD, { nPedido: '6593', statusCD: 0, data: '2026-09-17', hora: '14:10' });

  // 2ª rodada: CD liberou (Status 4) → vira separado e o "no CD" some
  statusPainel = { 6593: 4 }; semNota = true;
  deliverySeq = [[{ nPedido: '6593', d: '2026-09-17', hora: '10:07:11' }]];
  await cd.verificar();
  deliverySeq = null; semNota = false;
  x = cd.obterPedido(p.id);
  assert.equal(x.expedicao.nPedido, '6593');
  assert.equal(x.status, 'separado');
  assert.equal(x.noCD, undefined);
});

// Caso real de 16-17/09/2026: a loja também faz pedidos avulsos ao CD; o primeiro pedido depois da criação
// tinha 1 item que não estava no app e mesmo assim era casado (casamento por data). Agora é pelos itens.
test('verificar: não casa pedido do CD cujos itens não batem com o pedido do app', async () => {
  const dataDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd5-'));
  cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir: dataDir5 });
  cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 't' });
  cd.salvarVinculo({ codigoCD: '17898657832675', unidade: '7898657832678', unPorCaixa: 21, usuario: 't' });
  cd._setBaseParaTeste({ hoje: '2026-09-14', cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5 }, '17898657832675': { descricao: 'CAPRICCHE CX21', estoqueCx: 9 } }, un: { '7896037913146': { descricao: 'VINHO', custo: 20, porLoja: {} }, '7898657832678': { descricao: 'CAPRICCHE', custo: 1.67, porLoja: {} } }, lead: {} });
  const [p] = cd.criarPedidos({ lojas: { 5: [{ codigoCD: '17896037913143', caixas: 2 }, { codigoCD: '17898657832675', caixas: 9 }] }, usuario: 'tiago' });

  // 6574 = pedido avulso de 1 item (liberado), 6593 = o pedido do app (1 item pelo código do CD, outro pela unidade)
  itensCD = { 6574: ['17896005217495'], 6593: ['17896037913143', '7898657832678'] }; statusPainel = { 6574: 4, 6593: 1 }; semNota = true;
  deliverySeq = [[{ nPedido: '6574', d: '2026-09-16', hora: '13:56:05' }, { nPedido: '6593', d: '2026-09-17', hora: '10:07:11' }]];
  await cd.verificar();
  deliverySeq = null; semNota = false;
  const x = cd.obterPedido(p.id);
  assert.equal(x.status, 'aberto');
  assert.ok(!x.expedicao);
  assert.equal(x.noCD.nPedido, '6593');
  assert.equal(x.noCD.statusCD, 1);
});
