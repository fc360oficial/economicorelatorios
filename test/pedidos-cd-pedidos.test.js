// test/pedidos-cd-pedidos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

let sql = [];
const fakeQ = async (s, p) => {
  sql.push(s);
  if (s.includes('painel_televendas')) return [{ nPedido: '6400', d: '2026-09-15' }];
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
