// test/pedidos-cd-nota.test.js — recebimento pela nota de venda do CD linha a linha (mesmo nº de nota e de item
// na nota de entrada da loja) + vínculo sugerido/divergente aprendido da nota (18/09/2026)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

// pedido: caixa SEM vínculo (sandália) + caixa COM vínculo pra LIMAO, mas a loja deu entrada como MACA
let notaCD = false; let notaFechada = false; let semNotaLoja = false;
let linhas = [
  { nNota: '4990', d: '2026-09-18', item: 29, codLoja: '7900204450027', un: 6, codCD: '77900204348705' },
  { nNota: '4990', d: '2026-09-18', item: 16, codLoja: '7898031170341', un: 24, codCD: '17898031170355' },
  // copos 150 e 180 bipados com o MESMO código na loja: ambíguo, recebe mas não sugere vínculo
  { nNota: '4990', d: '2026-09-18', item: 6, codLoja: '7898505140221', un: 25, codCD: '17898505140211' },
  { nNota: '4990', d: '2026-09-18', item: 7, codLoja: '7898505140221', un: 25, codCD: '17898505140228' },
  // nota avulsa do dia 16 com 1 item só (menos da metade do pedido): não é a entrega deste pedido
  { nNota: '4942', d: '2026-09-16', item: 11, codLoja: '7898031170341', un: 24, codCD: '17898031170355' },
];
const fakeQ = async (s, p) => {
  if (s.includes('central.fornecedor')) return [];
  if (s.includes('FROM central.delivery d')) return [{ nPedido: '6597', d: '2026-09-17', hora: '10:00:00' }];
  if (s.includes('delivery_produtos')) return ['77900204348705', '17898031170355', '17898505140211', '17898505140228'].map(cod => ({ cod }));
  if (s.includes('painel_televendas')) return [{ statusCD: 4, dl: '2026-09-17', he: '14:10' }];
  if (s.includes('conferencia_televendas')) return [{ cod: '77900204348705', cx: 1 }, { cod: '17898031170355', cx: 1 }, { cod: '17898505140211', cx: 1 }, { cod: '17898505140228', cx: 1 }];
  if (s.includes('/*nota-hdr*/')) return p.includes('4990') ? [{ nNota: '4990', st: notaFechada ? 'F' : 'E', nc: 182468, op: 'SUZYCLEA', cst: notaFechada ? 2 : 1, opLoja: 'DAYANE SUB1', opCentral: notaFechada ? 'SUZYCLEA' : null, de: '2026-09-18', he: '11:11:21', dl: notaFechada ? '2026-09-18' : null, hl: notaFechada ? '13:20:56' : null }] : [];
  if (s.includes('/*conf-itens*/')) return [{ chave: 182468, cod: '7900204450027', un: 6, ok: 1, n: 1, val: '2030-09-18' }, { chave: 182468, cod: '7898031170341', un: 24, ok: 1, n: 1, val: '2027-04-25' }];
  if (s.includes('/*nf-cd*/')) return notaCD ? [{ nNota: '5002', d: '2026-09-18', n: 4 }] : [];
  if (semNotaLoja && (s.includes('/*nf-linhas*/') || s.includes('FROM central.compras c'))) return [];
  if (s.includes('/*nf-linhas*/')) return linhas.filter(l => !(s.includes('nNota NOT IN') && p.includes(l.nNota)));
  // por código de unidade: só o que a loja bipou com o MESMO código do vínculo
  if (s.includes('FROM central.compras c')) return linhas.filter(l => p.includes(l.codLoja)).map(l => ({ cod: l.codLoja, un: l.un, nNota: l.nNota, d: l.d }));
  if (s.includes('FROM central.itens')) return [{ cod: '7900204450027', descricao: 'IPANEMA CLASSICA AZ/PR 33A40' }, { cod: '7898031170341', descricao: 'INVICTO LAVA LOUCAS 500ML MACA' }];
  return [];
};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcdn-'));
cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir });
cd.salvarVinculo({ codigoCD: '17898031170355', unidade: '7898031170358', unPorCaixa: 24, usuario: 't' });
cd._setBaseParaTeste({ hoje: '2026-09-16', cd: {
  '77900204348705': { descricao: 'SANDALIA IPANEMA FEM CX6', estoqueCx: 4, unPorCaixaCadastro: 6 },
  '17898031170355': { descricao: 'INVICTO LIMAO CX24', estoqueCx: 4 },
  '17898505140211': { descricao: 'COPO 150ML CX25', estoqueCx: 4, unPorCaixaCadastro: 25 },
  '17898505140228': { descricao: 'COPO 180ML CX25', estoqueCx: 4, unPorCaixaCadastro: 25 },
}, un: { '7898031170358': { descricao: 'INVICTO LIMAO', custo: 1, porLoja: {} } }, lead: {} });

test('verificar: recebe pela linha da nota do CD mesmo sem vínculo e aprende o vínculo', async () => {
  const [p] = cd.criarPedidos({ lojas: { 1: [{ codigoCD: '77900204348705', caixas: 1 }, { codigoCD: '17898031170355', caixas: 1 }, { codigoCD: '17898505140211', caixas: 1 }, { codigoCD: '17898505140228', caixas: 1 }] }, usuario: 'tiago' });
  await cd.verificar();
  const r = cd.obterPedido(p.id);
  assert.equal(r.status, 'recebido');
  assert.deepEqual(r.recebimento.notas.map(n => n.nNota), ['4990']);
  const sand = r.itens.find(i => i.codigoCD === '77900204348705');
  assert.equal(sand.recebidas, 1); assert.equal(sand.recebidoComo, '7900204450027');
  const inv = r.itens.find(i => i.codigoCD === '17898031170355');
  assert.equal(inv.recebidas, 1); assert.equal(inv.recebidoComo, '7898031170341');
  assert.equal(r.itens.find(i => i.codigoCD === '17898505140211').recebidas, 1);
  assert.equal(r.itens.find(i => i.codigoCD === '17898505140228').recebidas, 1);

  // conferência da loja: nota aberta, em conferência, 2 itens bipados; conferidas em caixas (6 un / 6 = 1 cx)
  const n = r.recebimento.notas[0];
  assert.equal(n.statusNota, 'E'); assert.equal(n.conferencia.status, 1); assert.equal(n.conferencia.operadorLoja, 'DAYANE SUB1'); assert.equal(n.conferencia.itens, 2);
  assert.equal(sand.conferidas, 1); assert.equal(inv.conferidas, 1); assert.equal(sand.validadeLoja, '2030-09-18'); assert.equal(inv.validadeLoja, '2027-04-25'); assert.equal(r.itens.find(i => i.codigoCD === '17898505140211').conferidas, undefined);
  assert.equal(r.recebimento.fechada, undefined);
  // nota fecha na loja: pedido 'recebido' continua sendo acompanhado e ganha fechada
  notaFechada = true; await cd.verificar(); notaFechada = false;
  const r2 = cd.obterPedido(p.id);
  assert.equal(r2.recebimento.fechada, true); assert.equal(r2.recebimento.notas[0].statusNota, 'F'); assert.equal(r2.recebimento.notas[0].conferencia.operadorCentral, 'SUZYCLEA');
  assert.equal(r2.status, 'finalizado');

  const v = cd.getVinculos();
  // sem vínculo → sugerido pela nota, com descrição da unidade
  assert.equal(v['77900204348705'].status, 'sugerido'); assert.equal(v['77900204348705'].origem, 'nota');
  assert.equal(v['77900204348705'].candidato, '7900204450027'); assert.equal(v['77900204348705'].descricaoCandidato, 'IPANEMA CLASSICA AZ/PR 33A40');
  assert.equal(v['77900204348705'].sugestaoNota.loja, 1);
  // confirmado com outra unidade → continua confirmado, marca divergência
  assert.equal(v['17898031170355'].status, 'confirmado'); assert.equal(v['17898031170355'].unidade, '7898031170358');
  assert.equal(v['17898031170355'].divergenciaNota.unidade, '7898031170341');
  // ambíguo (mesmo código da loja em duas caixas) → sem sugestão
  assert.ok(!v['17898505140211'] || v['17898505140211'].status !== 'sugerido'); assert.ok(!v['17898505140228'] || v['17898505140228'].status !== 'sugerido');
});

test('sincronizarVinculos preserva a sugestão vinda da nota; confirmar pela sugestão fica com origem nota', () => {
  cd.sincronizarVinculos([{ codigoCD: '77900204348705', unPorCaixa: 6, unidadeExiste: null, candidatoDescricao: null, alternativas: [], descricaoCD: 'SANDALIA' }]);
  const v = cd.getVinculos()['77900204348705'];
  assert.equal(v.status, 'sugerido'); assert.equal(v.candidato, '7900204450027'); assert.equal(v.origem, 'nota');
  const c = cd.salvarVinculo({ codigoCD: '77900204348705', unidade: '7900204450027', unPorCaixa: 6, usuario: 't' });
  assert.equal(c.status, 'confirmado'); assert.equal(c.origem, 'nota');
  // vínculo confirmado igual ao que a loja bipou: divergência some na próxima verificação
});

test('divergência some quando o vínculo passa a bater com a nota', async () => {
  cd.salvarVinculo({ codigoCD: '17898031170355', unidade: '7898031170341', unPorCaixa: 24, usuario: 't' });
  linhas = linhas.filter(l => l.item === 16 && l.nNota === '4990');
  const [p] = cd.criarPedidos({ lojas: { 2: [{ codigoCD: '17898031170355', caixas: 1 }] }, usuario: 'tiago' });
  await cd.verificar();
  assert.equal(cd.obterPedido(p.id).status, 'recebido');
  assert.equal(cd.getVinculos()['17898031170355'].divergenciaNota, undefined);
});

test('nota de venda emitida pelo CD aparece como notaCD enquanto a loja não dá entrada', async () => {
  notaCD = true; linhas = [];
  const [p] = cd.criarPedidos({ lojas: { 3: [{ codigoCD: '17898031170355', caixas: 1 }] }, usuario: 'tiago' });
  await cd.verificar();
  const r = cd.obterPedido(p.id);
  assert.deepEqual(r.notaCD, { nNota: '5002', data: '2026-09-18' });
  notaCD = false;
});

test('nota apagada na loja: recebimento é desfeito e o pedido volta pra separado; nota nova recasa', async () => {
  linhas = [{ nNota: '4990', d: '2026-09-18', item: 16, codLoja: '7898031170341', un: 24, codCD: '17898031170355' }];
  const [p] = cd.criarPedidos({ lojas: { 4: [{ codigoCD: '17898031170355', caixas: 1 }] }, usuario: 'tiago' });
  await cd.verificar();
  assert.equal(cd.obterPedido(p.id).status, 'recebido');
  semNotaLoja = true; await cd.verificar(); semNotaLoja = false;
  const r = cd.obterPedido(p.id);
  assert.equal(r.status, 'aberto'); /* sem expedição casada neste mock (nPedido 6597 já usado) → aberto; com expedição seria separado */ assert.equal(r.recebimento, undefined); assert.equal(r.itens[0].recebidas, 0); assert.equal(r.itens[0].conferidas, undefined);
  linhas = [{ nNota: '5010', d: '2026-09-18', item: 3, codLoja: '7898031170341', un: 24, codCD: '17898031170355' }];
  await cd.verificar();
  const r2 = cd.obterPedido(p.id);
  assert.equal(r2.status, 'recebido'); assert.deepEqual(r2.recebimento.notas.map(n => n.nNota), ['5010']);
});
