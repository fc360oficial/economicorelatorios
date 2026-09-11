// test/pedidos-cd-sugestao.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');
cd.init({ q: async () => [], mesDB: m => String(m).padStart(2, '0'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-')) });

const cfg = { teto: 28, ciclo: 7, leadPadrao: 2, leadMaxPadrao: 3 };
const lead = { 1: { lead_medio: 2, lead_max: 3, n: 5 }, 2: null };
const vinc = {
  '17896037913143': { codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, status: 'confirmado' },
  '17509546679171': { codigoCD: '17509546679171', unidade: null, unPorCaixa: 72, status: 'pendente' }
};
const base = {
  hoje: '2026-09-14', dias: 40, lead,
  cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5, unPorCaixaCadastro: 12 }, '17509546679171': { descricao: 'CREME DENTAL CX72', estoqueCx: 10, unPorCaixaCadastro: 72 } },
  un: { '7896037913146': { descricao: 'VINHO 750ML', validade: 0, custo: 20, porLoja: { 1: { vq: 6, est: 0 }, 2: { vq: 6, est: 200 } } } }
};

test('repor: quantidade em caixas por loja, loja folgada pede 0', () => {
  const { repor, novos } = cd.calcularSugestao(base, vinc, cfg, {});
  assert.equal(repor.length, 1);
  const r = repor[0];
  assert.equal(r.unidade, '7896037913146');
  assert.equal(r.lojas[2].cx, 0);
  assert.ok(r.lojas[1].cx >= 5);          // alvo 10 d × 6 = 60 un → 5 cx
  assert.equal(r.cdInsuficiente, r.totalCx > 5);
  assert.ok(r.totalCx <= 5);              // nunca acima do estoque do CD
  assert.equal(novos.length, 1);
  assert.equal(novos[0].semVinculo, true);
});

test('novos: 1 caixa por loja limitado ao estoque do CD', () => {
  const b2 = { ...base, cd: { ...base.cd, '17509546679171': { descricao: 'X', estoqueCx: 4, unPorCaixaCadastro: 72 } } };
  const { novos } = cd.calcularSugestao(b2, vinc, cfg, {});
  const n = novos[0];
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(ln => n.lojas[ln].cx), [1, 1, 1, 1, 0, 0]);
});

test('trânsito desconta do pedido', () => {
  const { repor } = cd.calcularSugestao(base, vinc, cfg, { '7896037913146|1': 600 });
  assert.equal(repor[0].lojas[1].cx, 0);
});
