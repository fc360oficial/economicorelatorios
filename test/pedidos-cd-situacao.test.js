// test/pedidos-cd-situacao.test.js — regra de 29/09/2026: falta do CD é automática, "sumiu" pede resolução
const test = require('node:test');
const assert = require('node:assert/strict');
const { situacaoPedido, diasUteisEntre } = require('../lib/pedidos-cd-util');

const T = new Date('2026-10-02T10:00:00').getTime(); // sexta
const item = (o) => ({ codigoCD: '1', caixas: 6, separadas: 6, recebidas: 6, ...o });
const base = (o) => ({ status: 'separado', criadoEm: '2026-09-28T14:43:38', expedicao: { nPedido: 1, data: '2026-09-29' }, recebimento: null, itens: [], ...o });

test('caso 4: CD separou menos → faltaCD, sem resolver', () => {
  const s = situacaoPedido(base({ itens: [item({ separadas: 2 }), item({ codigoCD: '2' })] }), {}, T);
  assert.equal(s.faltaCD, 4); assert.equal(s.itensFaltaCD, 1); assert.equal(s.sumiu, 0); assert.equal(s.resolver, false);
});
test('caso 6: nota da loja menor que o separado → sumiu, precisa resolver', () => {
  const p = base({ status: 'recebido_parcial', recebimento: { notas: [] }, itens: [item({ recebidas: 5 })] });
  const s = situacaoPedido(p, {}, T);
  assert.equal(s.sumiu, 1); assert.equal(s.itensSumiu, 1); assert.equal(s.faltaCD, 0); assert.equal(s.resolver, true);
  p.resolucao = { motivo: 'bipe' }; assert.equal(situacaoPedido(p, {}, T).resolver, false);
});
test('caso 4+6 juntos: faltou 1 no CD e 1 sumiu', () => {
  const s = situacaoPedido(base({ status: 'recebido_parcial', recebimento: { notas: [] }, itens: [item({ separadas: 5, recebidas: 4 })] }), {}, T);
  assert.equal(s.faltaCD, 1); assert.equal(s.sumiu, 1);
});
test('nota sem expedição registrada: diferença vira falta do CD, não sumiu', () => {
  const s = situacaoPedido(base({ status: 'recebido_parcial', expedicao: null, recebimento: { notas: [] }, itens: [item({ recebidas: 4 })] }), {}, T);
  assert.equal(s.faltaCD, 2); assert.equal(s.sumiu, 0); assert.equal(s.resolver, false);
});
test('caso 7: produto novo sem vínculo que a nota não casou → vinculo, não é sumiu', () => {
  const s = situacaoPedido(base({ status: 'recebido_parcial', recebimento: { notas: [] }, itens: [item({ semVinculo: true, recebidas: 0 })] }), {}, T);
  assert.equal(s.vinculo, 1); assert.equal(s.sumiu, 0); assert.equal(s.resolver, false);
});
test('caso 7 casado pela linha da nota (recebidoComo) conta normal', () => {
  const s = situacaoPedido(base({ status: 'recebido', recebimento: { notas: [] }, itens: [item({ semVinculo: true, recebidoComo: '789', recebidas: 6 })] }), {}, T);
  assert.equal(s.vinculo, 0); assert.equal(s.sumiu, 0);
});
test('caso 10: expirado sem resolução pede resolver', () => {
  assert.equal(situacaoPedido(base({ status: 'expirado', itens: [item()] }), {}, T).resolver, true);
  assert.equal(situacaoPedido(base({ status: 'expirado', resolucao: { motivo: 'outro' }, itens: [item()] }), {}, T).resolver, false);
});
test('caso 11: cancelado não tem nada', () => {
  const s = situacaoPedido(base({ status: 'cancelado', itens: [item({ separadas: 0 })] }), {}, T);
  assert.equal(s.faltaCD, 0); assert.equal(s.resolver, false); assert.equal(s.aviso, null);
});
test('caso 1: aberto sem CD digitar por 1 dia útil → aviso; com noCD não avisa', () => {
  const p = base({ status: 'aberto', expedicao: null, criadoEm: '2026-10-01T14:43:38', itens: [item()] });
  assert.equal(situacaoPedido(p, {}, T).aviso.tipo, 'cd');
  assert.equal(situacaoPedido({ ...p, criadoEm: '2026-10-02T08:00:00' }, {}, T).aviso, null);
  assert.equal(situacaoPedido({ ...p, noCD: { nPedido: 1 } }, {}, T).aviso, null);
  assert.equal(situacaoPedido(p, { prazoCD: 3 }, T).aviso, null);
});
test('caso 5: NF do CD há 2+ dias sem entrada na loja → aviso', () => {
  const p = base({ notaCD: { nNota: 1, data: '2026-09-29' }, itens: [item()] });
  assert.equal(situacaoPedido(p, {}, T).aviso.tipo, 'entrada');
  assert.equal(situacaoPedido({ ...p, notaCD: { nNota: 1, data: '2026-10-01' } }, {}, T).aviso, null);
});
test('caso 10 antes de expirar: liberado há 7+ dias sem nota → aviso', () => {
  const p = base({ expedicao: { nPedido: 1, data: '2026-09-20' }, itens: [item()] });
  assert.equal(situacaoPedido(p, {}, T).aviso.tipo, 'nota');
});
test('dias úteis pula fim de semana', () => {
  assert.equal(diasUteisEntre('2026-10-02T14:00:00', new Date('2026-10-05T09:00:00').getTime()), 1); // sex → seg
  assert.equal(diasUteisEntre('2026-09-28T14:00:00', T), 4);
});
