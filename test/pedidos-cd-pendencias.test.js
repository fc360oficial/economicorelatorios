// test/pedidos-cd-pendencias.test.js — item que faltou numa nota já fechada na loja vira pendência sinalizada
// no pedido seguinte (Tiago, 21/09/2026: L3 fechou a nota com 4 cx faltando, o próximo pedido tem que sugerir)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

const fakeQ = async () => [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-pend-'));
cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir });
cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 't' });
cd._setBaseParaTeste({ hoje: '2026-09-21', cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 20 } }, un: { '7896037913146': { descricao: 'VINHO', custo: 20, porLoja: {} } }, lead: {} });

function fecharComFalta(p, { caixas, recebidas }) {
  const arq = path.join(dataDir, 'pedidos-cd', `${p.id}.json`);
  const d = JSON.parse(fs.readFileSync(arq, 'utf8'));
  d.status = 'recebido_parcial';
  d.itens[0].caixas = caixas; d.itens[0].recebidas = recebidas;
  d.recebimento = { notas: [{ nNota: 5002, statusNota: 'F' }], fechada: true, fechadaEm: new Date().toISOString() };
  fs.writeFileSync(arq, JSON.stringify(d));
  return d;
}

test('pendenciasCD: nota fechada com caixas faltando entra como pendência', () => {
  const [p] = cd.criarPedidos({ lojas: { 3: [{ codigoCD: '17896037913143', caixas: 10 }] }, usuario: 'tiago' });
  fecharComFalta(p, { caixas: 10, recebidas: 6 });
  const pend = cd.pendenciasCD();
  const k = '7896037913146|3';
  assert.ok(pend[k]);
  assert.equal(pend[k].faltaCx, 4);
  assert.equal(pend[k].pedidoId, p.id);
});

test('pendenciasCD: nota fechada sem falta não entra', () => {
  const [p] = cd.criarPedidos({ lojas: { 4: [{ codigoCD: '17896037913143', caixas: 5 }] }, usuario: 'tiago' });
  fecharComFalta(p, { caixas: 5, recebidas: 5 });
  assert.equal(cd.pendenciasCD()['7896037913146|4'], undefined);
});

test('pendenciasCD: um pedido mais novo da mesma loja/produto já em trânsito cancela a pendência antiga', () => {
  const [p1] = cd.criarPedidos({ lojas: { 5: [{ codigoCD: '17896037913143', caixas: 10 }] }, usuario: 'tiago' });
  fecharComFalta(p1, { caixas: 10, recebidas: 6 });
  assert.ok(cd.pendenciasCD()['7896037913146|5']);
  cd.criarPedidos({ lojas: { 5: [{ codigoCD: '17896037913143', caixas: 4 }] }, usuario: 'tiago' }); // novo pedido, ainda 'aberto'
  assert.equal(cd.pendenciasCD()['7896037913146|5'], undefined);
});

test('calcularSugestao: pendência aparece em item.lojas[loja].pendenciaAnterior', () => {
  const base = { hoje: '2026-09-21', dias: 40, lead: {}, cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 20, unPorCaixaCadastro: 12 } }, un: { '7896037913146': { descricao: 'VINHO', validade: 0, custo: 20, porLoja: { 3: { vq: 0, est: 0 } } } } };
  const vinc = { '17896037913143': { codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, status: 'confirmado' } };
  const cfg = { teto: 28, ciclo: 7, leadPadrao: 2, leadMaxPadrao: 3 };
  const pend = { '7896037913146|3': { faltaCx: 4, pedidoId: '99', criadoEm: new Date().toISOString(), descricaoCD: 'VINHO CX12' } };
  const { repor, novos } = cd.calcularSugestao(base, vinc, cfg, {}, pend);
  const item = repor.concat(novos)[0];
  assert.deepEqual(item.lojas[3].pendenciaAnterior, pend['7896037913146|3']);
  assert.equal(item.lojas[4].pendenciaAnterior, null);
});
