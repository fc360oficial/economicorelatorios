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

test('trânsito de produto sem vínculo fica só no próprio código, não soma nos outros novos', () => {
  const b = { hoje: '2026-09-14', dias: 40, lead: {}, un: {}, cd: {
    '77900204333763': { descricao: 'SANDALIA A CX6', estoqueCx: 10, unPorCaixaCadastro: 6 },
    '67909510420139': { descricao: 'SANDALIA B CX6', estoqueCx: 10, unPorCaixaCadastro: 6 } } };
  const r = cd.calcularSugestao(b, {}, cd.getConfig(), { '77900204333763|1': 12 });
  const a = r.novos.find(i => i.codigoCD === '77900204333763'), bb = r.novos.find(i => i.codigoCD === '67909510420139');
  assert.equal(a.lojas[1].transito, 12); assert.equal(bb.lojas[1].transito, 0);
});

// Tiago, 17/09/2026: produto novo já pedido (6 cx a caminho) era sugerido de novo na semana seguinte
test('novos: loja com trânsito (CD ou fornecedor) não recebe nova caixa até chegar', () => {
  const { novos } = cd.calcularSugestao(base, vinc, cfg, { '17509546679171|1': 72, '17509546679171|3': 72 });
  const n = novos[0];
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(ln => n.lojas[ln].cx), [0, 1, 0, 1, 1, 1]);
  assert.equal(n.lojas[1].transito, 72);
});

// Tiago, 22/09/2026: Fandangos com 1.187 un na L1 e venda zero caía em "produto novo" com 1 cx sem aviso nenhum.
// Mantém a caixa, mas sinaliza o estoque parado pra conferir no ERP/loja (e zerar no ERP se não existir).
test('novos: produto com estoque parado na loja (sem venda) mantém 1 cx e sinaliza a loja', () => {
  const vinc2 = { ...vinc, '17892840825079': { codigoCD: '17892840825079', unidade: '7892840825072', unPorCaixa: 50, status: 'confirmado' } };
  const b2 = { ...base,
    cd: { ...base.cd, '17892840825079': { descricao: 'FANDANGOS CX50', estoqueCx: 23, unPorCaixaCadastro: 50 } },
    un: { ...base.un, '7892840825072': { descricao: 'FANDANGOS 21G', validade: 0, custo: 0.76, porLoja: { 1: { vq: 0, est: 1187 }, 2: { vq: 0, est: 0 } } } } };
  const { novos } = cd.calcularSugestao(b2, vinc2, cfg, {});
  const n = novos.find(i => i.codigoCD === '17892840825079');
  assert.equal(n.origem, 'novo');
  assert.equal(n.lojas[1].cx, 1);
  assert.deepEqual(n.estoqueParado, [{ ln: 1, est: 1187 }]);
  const semEstoque = novos.find(i => i.codigoCD === '17509546679171');
  assert.equal(semEstoque.estoqueParado, null);
});
