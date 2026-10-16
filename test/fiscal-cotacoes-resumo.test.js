// Painel "Cotações" do Fiscal · Pedidos a receber (16/10/2026): por cotação, quantos pedidos chegaram / faltam, por loja, e
// quem ainda não entregou. Cotação velha (15+ d) sem nota = "provavelmente não vem"; fechar como não entregue tira da aba.
const test = require('node:test');
const assert = require('node:assert/strict');
const fp = require('../lib/fiscal-pedidos');

const hoje = '2026-10-16';
const loja = (st, extra = {}) => ({ status: st || 'aguardando', notas: st && st !== 'aguardando' ? [{ chave: 'CH', nNota: 1, data: '2026-10-10' }] : [], itens: [], problemas: [], ...extra });
function ped(id, cot, aprov, lojas, xml, extra = {}) {
  return { id, status: 'aprovado', fornecedor: 'FORN ' + id, lista_nome: 'L', codFornec: id, lojas, aprovadoEm: aprov + 'T12:00:00.000Z',
    cotacao: { id: cot, nome: 'Cotação COTAÇÃO DE ALIMENTOS ' + cot }, vendedor: { nome: 'V' + id, whats: '8199999000' + id },
    itens: [{ cod: 'A', descricao: 'A', unid: 'UN', emb: 1, qtd: 10, lojas_qtd: Object.fromEntries(lojas.map(l => [l, 5])), preco: 2 }],
    xml: { status: 'parcial', lojas: xml }, ...extra };
}
const totais = () => ({ itens: 1, com_preco: 1, digitado: 10, ultimo_custo: 0 });

test('conta por loja e no total; pendentes só sem nota / a caminho; cotação velha marcada; fechado sai dos abertos', () => {
  const pedidos = [
    ped(1, 3, '2026-10-15', [1, 2], { 1: loja(), 2: loja('conciliado', { aceito: { por: 'JOSE', em: '2026-10-16T10:00:00.000Z', papel: 'fiscal' }, chegou: { em: '2026-10-16', fechada: true } }) }),
    ped(2, 3, '2026-10-15', [1], { 1: loja('consistencia') }),                                   // XML entrou, caminhão não chegou → a caminho
    ped(3, 3, '2026-10-15', [1], { 1: loja('consistencia', { chegou: { em: '2026-10-16', fechada: false, horaEntrada: '2026-10-16 07:00' }, notas: [{ chave: 'CH', nNota: 1, data: '2026-10-16', entrada: { nConferencia: 9 } }] }) }),   // bipada
    ped(4, 1, '2026-09-28', [1], { 1: loja() }),                                                  // cotação velha, 18 d sem nota
    ped(5, 1, '2026-09-28', [1], { 1: loja('consistencia', { faltas: 1, fiscal_liberou: { por: 'JOSE', em: '2026-10-01T10:00:00.000Z', nReg: 1, parcial: true } }) }),   // parcial liberado
    ped(6, 1, '2026-09-28', [1], { 1: loja('aguardando', { nao_entregue: { por: 'JOSE', em: '2026-10-16T11:00:00.000Z' } }) }),   // fechado como não entregue
    ped(7, 2, '2026-10-05', [2], { 2: loja('conciliado', { aceito: { por: 'JOSE', em: '2026-10-10T10:00:00.000Z' } }) }),          // cotação toda entregue → fora
    ped(8, 9, '2026-10-15', [1], { 1: loja() }, { cotacao: null, parametros: { origem: 'radar' }, comprador: { nome: 'BRUNA' } })  // não é cotação
  ];
  const R = fp.resumoCotacoes(() => pedidos, totais, { hoje });
  assert.deepEqual(R.map(c => c.id), [3, 1]);   // mais nova primeiro; a #2 (tudo entregue) não entra
  const c3 = R[0];
  assert.equal(c3.aprovadoEm, '2026-10-15'); assert.equal(c3.dias, 1); assert.equal(c3.velha, false);
  assert.deepEqual([c3.total, c3.entregues, c3.a_entregar, c3.a_caminho, c3.bipada, c3.parcial, c3.abertos], [4, 1, 1, 1, 1, 0, 3]);
  const L1 = c3.lojas.find(l => l.loja === 1), L2 = c3.lojas.find(l => l.loja === 2);
  assert.deepEqual([L1.total, L1.entregues, L1.a_entregar, L1.a_caminho, L1.bipada], [3, 0, 1, 1, 1]);
  assert.deepEqual([L2.total, L2.entregues], [1, 1]);
  assert.deepEqual(L1.pendentes.map(p => [p.pedido, p.situacao]), [[1, 'aguardando_nota'], [2, 'nota_emitida']]);
  assert.match(L1.pendentes[0].texto, /o pedido #1 \(L\) da Loja 1 · CAHU .* ainda não chegou/);
  assert.equal(L1.pendentes[0].vendedor.whats, '81999990001');
  const c1 = R[1];
  assert.equal(c1.dias, 18); assert.equal(c1.velha, true);
  assert.deepEqual([c1.total, c1.entregues, c1.nao_entregues, c1.a_entregar, c1.parcial, c1.abertos], [3, 0, 1, 1, 1, 2]);
  // situação do pedido fechado como não entregue
  const s6 = fp.situacaoLoja(pedidos[5], 1, hoje);
  assert.equal(s6.codigo, 'fechado'); assert.equal(s6.nao_entregue, true); assert.match(s6.texto, /^Não entregue · fechado pelo fiscal 16\/10/);
  assert.equal(fp.pedidosAReceber(() => [pedidos[5]], totais, { hoje }).length, 0);   // sai da aba
  // nota que aparece depois reabre (chave bipada no coletor)
  pedidos[5].xml.lojas[1].bipada = { chaves: [{ chave: 'X', nNota: 2, nConferencia: 5, em: '2026-10-17 08:00' }] };
  assert.equal(fp.situacaoLoja(pedidos[5], 1, '2026-10-17').codigo, 'bipada_sem_xml');
});

test('filtro de loja: só a loja pedida; cotação sem loja no escopo não aparece', () => {
  const pedidos = [ped(1, 3, '2026-10-15', [1, 2], { 1: loja(), 2: loja() }), ped(2, 4, '2026-10-15', [2], { 2: loja() })];
  const R = fp.resumoCotacoes(() => pedidos, totais, { hoje, loja: 1 });
  assert.deepEqual(R.map(c => c.id), [3]);
  assert.deepEqual(R[0].lojas.map(l => l.loja), [1]);
  const R2 = fp.resumoCotacoes(() => pedidos, totais, { hoje, lojas: [2] });
  assert.deepEqual(R2.map(c => [c.id, c.total]), [[4, 1], [3, 1]]);
});
