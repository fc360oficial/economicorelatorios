// Dashboard Distribuidora: cupom do caixa sem pedido pelo CCF é ligado ao pedido em aberto de mesmo valor (Tiago, 17/11/2026 —
// NFC-e 614 de R$ 2.592,00 era o pedido 8012 do JOAO ALVES DE MENDONÇA e saía como "Venda no caixa (sem pedido)").
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/dashboard-distribuidora');

const ped = (o = {}) => ({ ped: 8012, d: '2026-11-16', hora: '15:40:00', cli: 321, nome: 'JOAO ALVES DE MENDONÇA', cnpj: '', v: 2592, st: 1, vend: 7, vendNome: 'NICOLY CHAGAS', forma: 'Cartão', nfe: '0', ccf: 0, ...o });
const cup = (o = {}) => ({ ccf: 614, d: '2026-11-16', hora: '18:09:00', v: 2592, st: 'F', chave: null, pg: [], ...o });

test('ligarPorValor: 1 pedido em aberto de mesmo valor pra 1 cupom solto → liga', () => {
  const c = cup(), p = ped(), r = D.ligarPorValor([c], [p, ped({ ped: 8013, v: 100 })]);
  assert.equal(r.size, 1); assert.equal(r.get(c), p);
  assert.equal(D.ligarPorValor([cup({ d: '2026-11-18' })], [ped()]).size, 1, 'pedido de 2 dias antes ainda liga');
});
test('ligarPorValor: havendo dúvida não liga', () => {
  assert.equal(D.ligarPorValor([cup()], [ped(), ped({ ped: 8020 })]).size, 0, 'dois pedidos de mesmo valor');
  assert.equal(D.ligarPorValor([cup(), cup({ ccf: 615, hora: '18:20:00' })], [ped()]).size, 0, 'dois cupons de mesmo valor');
  assert.equal(D.ligarPorValor([cup()], [ped({ v: 2592.01 })]).size, 0, 'um centavo de diferença');
});
test('ligarPorValor: pedido depois do cupom, velho demais, cancelado ou já faturado não liga; cupom cancelado também não', () => {
  assert.equal(D.ligarPorValor([cup()], [ped({ hora: '18:30:00' })]).size, 0, 'pedido feito depois do cupom, no mesmo dia');
  assert.equal(D.ligarPorValor([cup()], [ped({ d: '2026-11-17' })]).size, 0, 'pedido do dia seguinte');
  assert.equal(D.ligarPorValor([cup()], [ped({ d: '2026-11-08' })]).size, 0, 'pedido de 8 dias antes');
  assert.equal(D.ligarPorValor([cup()], [ped({ d: '2026-11-09' })]).size, 1, 'pedido de 7 dias antes liga');
  assert.equal(D.ligarPorValor([cup()], [ped({ st: 9 })]).size, 0, 'pedido cancelado');
  assert.equal(D.ligarPorValor([cup()], [ped({ nfe: '6060' })]).size, 0, 'pedido que já virou NF-e');
  assert.equal(D.ligarPorValor([cup()], [ped({ ccf: 600 })]).size, 0, 'pedido que já tem cupom');
  assert.equal(D.ligarPorValor([cup({ st: 'C' })], [ped()]).size, 0, 'cupom cancelado');
});

// ponta a ponta com o ERP simulado: a NFC-e 614 sai do "Sem vendedor" e vai pra vendedora do pedido, marcada "pelo valor"
test('base: cupom 614 passa pra NICOLY com cliente e pedido 8012; o que já ligava pelo CCF segue igual', async () => {
  const linhaCx = (ccf, hora, v, cart) => ({ nReg: ccf, ccf: String(ccf), d: '2026-11-16', hora, pg: v.toFixed(2).replace('.', ','), v, cart, ret: '100', canc: '0', chave: null });
  const pedErp = (ped, hora, cli, nome, v, vend, ccf) => ({ ped, d: '2026-11-16', hora, cli, nome, cnpj: '', v, st: 1, vend, fp: 'CARTAO', nfe: '0', ccf });
  const q = async sql => {
    if (/vendedor_delivery/.test(sql)) return [{ cod: 7, nome: 'NICOLY CHAGAS' }, { cod: 9, nome: 'CARMEM' }];
    if (/FROM central\.delivery WHERE nLoja = \? AND Data BETWEEN/.test(sql)) return [
      pedErp(8012, '15:40:00', 321, 'JOAO ALVES DE MENDONÇA', 2592, 7, 0),     // caixa não puxou: sem CCF
      pedErp(8010, '10:00:00', 55, 'MERCADINHO DA PRAÇA', 480.5, 9, 612),      // ligado pelo CCF, como sempre
      pedErp(8015, '16:00:00', 77, 'PADARIA SOL', 300, 9, 0)];                 // aberto de verdade: nenhum cupom de 300
    if (/relatoriofecl10 WHERE NaoVenda = 0 AND CCF <> '0' AND Data BETWEEN/.test(sql)) return [linhaCx(612, '11:00:00', 480.5, 'POS'), linhaCx(613, '12:00:00', 75, 'DINHEIRO'), linhaCx(614, '18:09:00', 2592, 'POS')];
    return [];
  };
  D.init({ q });
  const hoje = new Date(2026, 10, 17, 12);
  const nic = await D.notasVendedor(7, 'mes', hoje), sem = await D.notasVendedor(0, 'mes', hoje), car = await D.notasVendedor(9, 'mes', hoje);
  assert.equal(nic.total, 2592); assert.equal(nic.notas.length, 1);
  assert.deepEqual({ nn: nic.notas[0].nn, cliente: nic.notas[0].cliente, ped: nic.notas[0].ped, pedValor: nic.notas[0].pedValor }, { nn: '614', cliente: 'JOAO ALVES DE MENDONÇA', ped: 8012, pedValor: true });
  assert.equal(sem.total, 75, 'só a venda de balcão de verdade fica sem vendedor'); assert.equal(sem.notas[0].cliente, 'Venda no caixa (sem pedido)'); assert.equal(sem.notas[0].pedValor, false);
  assert.equal(car.total, 480.5); assert.equal(car.notas[0].ped, 8010); assert.equal(car.notas[0].pedValor, false, 'ligação pelo CCF não leva a marca');
  // o pedido ligado deixa de aparecer como aberto no detalhe do cliente; o 8015 continua aberto
  const joao = await D.notasCliente(321, hoje), sol = await D.notasCliente(77, hoje);
  assert.equal(joao.notas.length, 1); assert.equal(joao.abertos.length, 0); assert.equal(sol.abertos.length, 1);
});
