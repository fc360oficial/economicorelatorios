// test/pedidos-cd-nfe.test.js — CD corta mais da metade dos itens (sem estoque) e a ligação exata pedido do
// Televendas ↔ NF (delivery.NFe) ↔ entrada na loja, com o valor da nota (07/10/2026: L1/L2/L3/L5 de 05/10 ficaram
// "aguardando CD" com a NF já lançada na loja; 6962 da L5 nunca passou pelo painel)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

// 25 produtos no CD, todos vinculados à mesma unidade (código do CD = 1 + unidade)
const UNS = Array.from({ length: 25 }, (_, i) => String(7890000000000 + i));
const CDS = UNS.map(u => '1' + u);
let itensCD = {};          // nPedido → códigos digitados pelo CD
let nfe = {};              // nPedido → nº da NF emitida ('0' = ainda não)
let painel = {};           // nPedido → status no painel
let notaLoja = null;       // { nNota, cods, st, tot } entrada na loja
const fakeQ = async (s, p) => {
  if (s.includes('central.fornecedor')) return [];
  if (s.includes('FROM central.delivery d')) return Object.keys(itensCD).map(n => ({ nPedido: n, d: '2026-10-05', hora: '18:02:35' }));
  if (s.includes('FROM central.delivery WHERE')) return [{ nfe: nfe[p[0]] || '0' }];
  if (s.includes('delivery_produtos')) return (itensCD[p[0]] || []).map(cod => ({ cod }));
  if (s.includes('painel_televendas')) return painel[p[0]] == null ? [] : [{ statusCD: painel[p[0]], dl: '2026-10-06', he: '10:34' }];
  if (s.includes('conferencia_televendas')) return (itensCD[p[0]] || []).map(cod => ({ cod, cx: 1 }));
  if (s.includes('/*nf-cd-exata*/')) return [{ nNota: p[0], d: '2026-10-06', tot: '1667.18' }];
  if (s.includes('/*nf-cd*/')) return [];
  if (s.includes('/*nota-hdr*/')) return notaLoja && p.includes(notaLoja.nNota) ? [{ nNota: notaLoja.nNota, st: notaLoja.st, tot: notaLoja.tot, nc: 0, op: 'JOSE', cst: null }] : [];
  if (s.includes('/*nf-linhas*/')) return [];
  if (s.includes('FROM central.compras c')) return notaLoja ? notaLoja.cods.filter(c => p.includes(c)).map(cod => ({ cod, un: 27, tot: 60, nNota: notaLoja.nNota, d: '2026-10-06' })) : [];
  return [];
};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcdnfe-'));
cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir });
const base = { cd: {}, un: {}, lead: {}, hoje: '2026-10-05' };
UNS.forEach((u, i) => { cd.salvarVinculo({ codigoCD: CDS[i], unidade: u, unPorCaixa: 27, usuario: 't' }); base.cd[CDS[i]] = { descricao: 'PROD ' + i + ' CX27', estoqueCx: 9 }; base.un[u] = { descricao: 'PROD ' + i, custo: 2.2222, porLoja: {} }; });
cd._setBaseParaTeste(base);

test('avulso da loja (3 itens, todos no pedido) não casa; CD que digitou 10 de 25 itens (100 % do digitado) casa', async () => {
  const [p] = cd.criarPedidos({ lojas: { 1: CDS.map(c => ({ codigoCD: c, caixas: 1 })) }, usuario: 'tiago' });
  itensCD = { 7001: CDS.slice(0, 3) }; painel = { 7001: 4 };
  await cd.verificar();
  assert.equal(cd.obterPedido(p.id).status, 'aberto'); assert.ok(!cd.obterPedido(p.id).expedicao);
  // o CD digita o pedido de verdade com só 10 itens (sem estoque dos outros 15), libera no painel
  itensCD = { 7001: CDS.slice(0, 3), 7002: CDS.slice(0, 10) }; painel = { 7001: 4, 7002: 4 };
  await cd.verificar();
  const r = cd.obterPedido(p.id);
  assert.equal(r.status, 'separado'); assert.equal(r.expedicao.nPedido, '7002'); assert.equal(r.expedicao.nfe, undefined);
  assert.equal(r.itens.filter(i => i.separadas === 1).length, 10);
  // CD emite a NF 5331 pro 7002: notaCD exata (sem cobertura de metade), com o valor da nota
  nfe = { 7002: '5331' };
  await cd.verificar();
  const r2 = cd.obterPedido(p.id);
  assert.equal(r2.expedicao.nfe, '5331'); assert.deepEqual(r2.notaCD, { nNota: '5331', data: '2026-10-06', valor: 1667.18 });
  // loja dá entrada na 5331 (10 itens = menos da metade do pedido): vale porque é a nota deste pedido
  notaLoja = { nNota: '5331', cods: UNS.slice(0, 10), st: 'F', tot: '1667.18' };
  await cd.verificar();
  const r3 = cd.obterPedido(p.id);
  assert.equal(r3.status, 'recebido_parcial'); assert.deepEqual(r3.recebimento.notas.map(n => n.nNota), ['5331']);
  assert.equal(r3.recebimento.notas[0].valor, 1667.18); assert.equal(r3.recebimento.notas[0].statusNota, 'F');
  assert.equal(r3.itens.filter(i => i.recebidas === 1).length, 10);
});

test('pedido do Televendas que nunca entrou no painel mas já tem NF emitida conta como expedição', async () => {
  itensCD = { 7003: CDS.slice(0, 12) }; painel = {}; nfe = { 7003: '5312' }; notaLoja = null;
  const [p] = cd.criarPedidos({ lojas: { 5: CDS.slice(0, 20).map(c => ({ codigoCD: c, caixas: 1 })) }, usuario: 'tiago' });
  await cd.verificar();
  const r = cd.obterPedido(p.id);
  assert.equal(r.status, 'separado'); assert.equal(r.expedicao.nPedido, '7003'); assert.equal(r.expedicao.nfe, '5312');
  assert.equal(r.notaCD.nNota, '5312');
});
