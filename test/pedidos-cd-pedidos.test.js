// test/pedidos-cd-pedidos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

let sql = []; let params = [];
let painelSeq = null; // fila opcional de retornos sucessivos p/ painel_televendas
const fakeQ = async (s, p) => {
  sql.push(s); params.push(p);
  if (s.includes('painel_televendas')) { if (painelSeq && painelSeq.length) return [painelSeq.shift()]; return [{ nPedido: '6400', d: '2026-09-15' }]; }
  if (s.includes('conferencia_televendas')) return [{ cod: '17896037913143', cx: 3 }];
  if (s.includes('FROM central.compras c')) return [{ cod: '7896037913146', cx: 2, nNota: 4900, d: '2026-09-16' }];
  return [];
};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-'));
cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir });
cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 't' });
cd._setBaseParaTeste({ hoje: '2026-09-14', cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5 } }, un: { '7896037913146': { descricao: 'VINHO', custo: 20, porLoja: {} } }, lead: {} });

test('criarPedidos: 1 por loja, só itens com caixas > 0, recusa sem vínculo', () => {
  const ps = cd.criarPedidos({ lojas: { 1: [{ codigoCD: '17896037913143', caixas: 3 }], 2: [{ codigoCD: '17896037913143', caixas: 0 }] }, usuario: 'tiago' });
  assert.equal(ps.length, 1);
  assert.equal(ps[0].loja, 1); assert.equal(ps[0].status, 'aberto');
  assert.equal(ps[0].itens[0].unidades, 36); assert.equal(ps[0].totais.custo, 720);
  assert.throws(() => cd.criarPedidos({ lojas: { 1: [{ codigoCD: '999', caixas: 1 }] }, usuario: 't' }), /vínculo/);
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

test('criarPedidos: não grava nada se alguma loja tiver produto sem vínculo', () => {
  const antes = cd.listarPedidos().length;
  assert.throws(() => cd.criarPedidos({ lojas: { 1: [{ codigoCD: '17896037913143', caixas: 1 }], 2: [{ codigoCD: '999', caixas: 1 }] }, usuario: 't' }), /vínculo/);
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

  painelSeq = [{ nPedido: '7400', d: '2026-09-15' }, { nPedido: '7401', d: '2026-09-16' }];
  sql = []; params = [];
  await cd.verificar();
  painelSeq = null;

  const painelCalls = sql.map((s, i) => ({ s, p: params[i] })).filter(x => x.s.includes('painel_televendas'));
  assert.equal(painelCalls.length, 2);
  assert.ok(!painelCalls[0].p.includes('7400')); // A processado primeiro (mais antigo), sem exclusão ainda
  assert.ok(painelCalls[1].s.includes('NOT IN'));
  assert.ok(painelCalls[1].p.includes('7400')); // B não pode casar com o nPedido já atribuído ao A

  const comprasCalls = sql.map((s, i) => ({ s, p: params[i] })).filter(x => x.s.includes('FROM central.compras c'));
  assert.equal(comprasCalls.length, 2);
  assert.ok(!comprasCalls[0].s.includes('nNota NOT IN'));
  assert.ok(comprasCalls[1].s.includes('nNota NOT IN'));
  assert.ok(comprasCalls[1].p.includes('4900')); // B não pode reusar a nota já registrada pelo A

  assert.equal(cd.obterPedido(pA.id).expedicao.nPedido, '7400');
  assert.equal(cd.obterPedido(pB.id).expedicao.nPedido, '7401');
});
