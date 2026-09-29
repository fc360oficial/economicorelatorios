// Expedição do CD (loja 10): conferência cega de saída — spec 2026-09-29-coletor-cd-expedicao-processo.md
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const E = require('../lib/expedicao');

const ITENS = [
  { cod: '7891150097605', descricao: 'OLEO LIZA 900ML', qtd: 4, qtdEmb: 20, und: 'CX' },   // 80 un
  { cod: '17898403781295', descricao: 'ACUCAR PETRIBU 1KG', qtd: 10, qtdEmb: 30, und: 'FD' }, // 300 un
  { cod: '789', descricao: 'ITEM UNITARIO', qtd: 5, qtdEmb: 0, und: 'UN' },              // 5 un
];
function setup(agora = new Date('2026-09-29T10:00:00')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
  E.init({ dir, agora: () => agora, cadastro: async cod => cod === '999' ? { descricao: 'FORA DO PEDIDO' } : null });
  return E.abrirPedido({ nPedido: 6853, cliente: 'SERAFIM SUPERMERCADO', cnpj: '35226657000156', nome: 'carmem', itens: ITENS, total: 5558.22 });
}

test('abrirPedido: id exp-dia-10-nPedido, pedido em unidades (qtd × qtdEmb, 0 = 1), reabrir devolve a mesma', () => {
  const c = setup();
  assert.equal(c.id, 'exp-2026-09-29-10-6853'); assert.equal(c.status, 'bipando'); assert.equal(c.nome, 'CARMEM');
  assert.deepEqual(Object.values(c.pedido).map(p => p.cod + ':' + p.un).sort(), ['17898403781295:300', '789:5', '7891150097605:80']);
  assert.equal(E.abrirPedido({ nPedido: '6853', cliente: 'X', itens: [] }).id, c.id);
  const v = E.visao(c.id); assert.ok(!JSON.stringify(v).includes('"un":80') && !JSON.stringify(v).includes('300'), 'visão não revela qtd do pedido');
});

test('bipar cego: sem lote não soma; ok quando bate; qtd_diferente sem revelar; fora_do_pedido não entra nos itens', async () => {
  const c = setup();
  let r = await E.bipar(c.id, { cod: '7891150097605', quant: 4, emb: 20 });
  assert.equal(r.resultado, 'sem_lote'); assert.equal(E.obter(c.id).itens['7891150097605'], undefined);
  r = await E.bipar(c.id, { cod: '7891150097605', quant: 3, emb: 20, lote: 'l01' });
  assert.equal(r.resultado, 'qtd_diferente'); assert.equal(r.item.estado, 'diferente'); assert.equal(r.item.un, 60); assert.ok(!('pedido' in r.item));
  r = await E.bipar(c.id, { cod: '7891150097605', quant: 1, emb: 20, lote: 'L02' });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.un, 80); assert.deepEqual(r.item.lotes.map(l => l.lote + ':' + l.quant), ['L01:3', 'L02:1']);
  r = await E.bipar(c.id, { cod: '999', quant: 2, emb: 1, lote: 'Z' });
  assert.equal(r.resultado, 'fora_do_pedido'); assert.equal(r.item.descricao, 'FORA DO PEDIDO');
  const v = E.visao(c.id); assert.equal(v.itens.length, 1); assert.equal(v.fora.length, 1); assert.equal(v.fora[0].un, 2);
  // bipeId repetido (fila offline): não soma de novo
  r = await E.bipar(c.id, { cod: '789', quant: 5, emb: 1, lote: 'A', bipeId: 'b1' }); assert.equal(r.resultado, 'ok');
  r = await E.bipar(c.id, { cod: '789', quant: 5, emb: 1, lote: 'A', bipeId: 'b1' }); assert.equal(r.repetido, true); assert.equal(E.obter(c.id).itens['789'].un, 5);
});

test('tirar da coletagem: baixa por lote ou tudo, grava evento com antes/depois, fora do pedido some, item a mais volta a ok', async () => {
  const c = setup();
  await E.bipar(c.id, { cod: '7891150097605', quant: 4, emb: 20, lote: 'L01' });
  await E.bipar(c.id, { cod: '7891150097605', quant: 2, emb: 20, lote: 'L02' });   // 120 un > 80
  assert.equal(E.obter(c.id).itens['7891150097605'].estado, 'diferente');
  let t = E.tirar(c.id, { cod: '7891150097605', quant: 2, lote: 'L02', motivo: 'sobrou', nome: 'jose' });
  assert.equal(t.item.un, 80); assert.equal(t.item.estado, 'ok'); assert.deepEqual(t.item.lotes.map(l => l.lote), ['L01']);
  assert.equal(t.evento.tipo, 'tirar_coletagem'); assert.equal(t.evento.antes, 120); assert.equal(t.evento.depois, 80); assert.equal(t.evento.nome, 'JOSE'); assert.equal(t.evento.verificado, null);
  await E.bipar(c.id, { cod: '999', quant: 1, emb: 1, lote: 'Z' });
  t = E.tirar(c.id, { cod: '999' });
  assert.equal(t.item, null); assert.equal(t.evento.fora, true); assert.equal(Object.keys(E.obter(c.id).fora).length, 0);
  assert.throws(() => E.tirar(c.id, { cod: '789' }), /não bipado/);
  const pend = E.pendenciasVerificacao(1); assert.equal(pend.length, 2); assert.equal(pend[0].nPedido, '6853');
  const ev = E.verificarPallet(c.id, pend[1].idx, 'fiscal'); assert.equal(ev.verificado.nome, 'FISCAL');
  assert.equal(E.pendenciasVerificacao(1).filter(p => !p.verificado).length, 1);
});

test('terminei só fecha 100 %: lista pendentes (sem qtd) e fora; fecha quando tudo bate; saidasPorLote só das fechadas', async () => {
  const c = setup();
  await E.bipar(c.id, { cod: '7891150097605', quant: 4, emb: 20, lote: 'L01' });
  await E.bipar(c.id, { cod: '17898403781295', quant: 9, emb: 30, lote: 'F7' });
  await E.bipar(c.id, { cod: '999', quant: 1, emb: 1, lote: 'Z' });
  let t = E.terminei(c.id);
  assert.equal(t.fechou, false); assert.equal(E.obter(c.id).status, 'bipando');
  assert.deepEqual(t.pendentes.map(p => p.cod + ':' + p.motivo).sort(), ['17898403781295:a_menos', '789:nao_bipado']);
  assert.equal(t.fora.length, 1); assert.ok(!JSON.stringify(t).includes('300'), 'nunca revela a qtd do pedido');
  assert.equal(E.saidasPorLote().length, 0);
  await E.bipar(c.id, { cod: '17898403781295', quant: 1, emb: 30, lote: 'F7' });
  await E.bipar(c.id, { cod: '789', quant: 5, emb: 1, lote: 'U1' });
  t = E.terminei(c.id); assert.equal(t.fechou, false); assert.equal(t.pendentes.length, 0); assert.equal(t.fora.length, 1, 'fora do pedido ainda segura');
  E.tirar(c.id, { cod: '999' });
  t = E.terminei(c.id, { nome: 'carmem' }); assert.equal(t.fechou, true);
  const f = E.obter(c.id); assert.equal(f.status, 'fechada'); assert.equal(f.fechadoPor, 'CARMEM'); assert.equal(f.tentativas, 3);
  await assert.rejects(E.bipar(c.id, { cod: '789', quant: 1, emb: 1, lote: 'U1' }), /fechado/);
  const s = E.saidasPorLote(); assert.equal(s.length, 3); assert.deepEqual(s.find(x => x.lote === 'F7').un, 300);
  assert.equal(E.acharPorPedido(6853), null, 'fechada não é retomada');
});
