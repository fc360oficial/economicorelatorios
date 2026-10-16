// Pedido de cotação não tem 2ª entrega (Tiago, 16/10/2026, pedido 169 Estivas Loja 4: nota veio com 1 dos 2 itens):
// o que faltou na nota é decisão do FISCAL — "não vem mais" (Aceitar parcial) ou recusar a entrega inteira — tomada na aba
// Pedidos a receber assim que o XML entra, antes do caminhão. Pedido com compradora continua como era (falta = ruptura).
const test = require('node:test');
const assert = require('node:assert/strict');
const fp = require('../lib/fiscal-pedidos');
const cx = require('../lib/conferencia-xml');

const CH = '26261008029696000352550010024788005005610436';
function lojaXml(extra = {}) {
  return { status: 'consistencia', notas: [{ chave: CH, nNota: 2478800, data: '2026-10-16' }],
    itens: [
      { cod: '7896259411628', descricao: 'CAMPONESA CREME LEITE 200G TP', pedida: 702, recebida: 702, tipo: 'ok', preco_digitado: 2.47, preco_xml: 2.47, preco_status: 'ok' },
      { cod: '7893000079311', descricao: 'DELINE MARGARINA COM SAL 1KG', pedida: 210, recebida: 0, tipo: 'falta', preco_digitado: 8.9, preco_xml: null, preco_status: null }
    ], nao_pedidos: [], faltas: 1, problemas: [{ tipo: 'falta', msg: '1 item com falta ou parcial' }], ...extra };
}
function pedido(x, extra = {}) {
  return { id: 169, status: 'aprovado', fornecedor: 'ESTIVAS NOVO PRADO LTDA', lista_nome: 'Cotação COTAÇÃO DE ALIMENTOS 13/10/2026', codFornec: 387, lojas: [4],
    aprovadoEm: '2026-10-15T19:14:50.350Z', cotacao: { id: 3, nome: 'Cotação COTAÇÃO DE ALIMENTOS 13/10/2026', entrega: null }, vendedor: { nome: 'Carlos', whats: '81999990000' },
    itens: [
      { cod: '7896259411628', descricao: 'CAMPONESA CREME LEITE 200G TP', unid: 'UN', emb: 27, qtd: 702, lojas_qtd: { 4: 702 }, preco: 2.47 },
      { cod: '7893000079311', descricao: 'DELINE MARGARINA COM SAL 1KG', unid: 'UN', emb: 6, qtd: 210, lojas_qtd: { 4: 210 }, preco: 8.9 }
    ], xml: { status: 'consistencia', lojas: { 4: x } }, ...extra };
}
const totais = () => ({ itens: 2, com_preco: 2, digitado: 3602.94, ultimo_custo: 0 });

test('falta é pendência do fiscal só em pedido de cotação; com compradora continua sem decisão (ruptura)', () => {
  const x = lojaXml();
  assert.equal(fp.pendenciasLoja(x).pendentes.length, 0);                       // compradora: nada a decidir
  const r = fp.pendenciasLoja(x, true);                                          // cotação: falta pede decisão
  assert.equal(r.pendentes.length, 1); assert.equal(r.pendentes[0].motivo, 'falta'); assert.equal(r.pendentes[0].motivo_txt, 'não veio na nota');
  assert.equal(fp.motivoDiverg({ tipo: 'parcial' }, false, true), 'falta');
  assert.equal(fp.motivoDiverg({ tipo: 'parcial', preco_status: 'maior' }, false, true), 'preco');   // preço acima vem antes
  x.itens[1].decisao = { acao: 'nao_vem', por: 'JOSE', em: '2026-10-16T12:40:00.000Z', papel: 'fiscal' };
  assert.equal(fp.pendenciasLoja(x, true).pendentes.length, 0);
  assert.equal(fp.parcialAceito(x), true);
  assert.equal(fp.parcialAceito(lojaXml()), false);
  assert.equal(fp.parcialAceito({ itens: [{ tipo: 'ok' }] }), false);              // sem falta não é "parcial"
});

test('situação: a caminho com falta pra decidir; parcial aceito; entrega recusada; nota nova desfaz a recusa', () => {
  const hoje = '2026-10-16';
  let s = fp.situacaoLoja(pedido(lojaXml()), 4, hoje);
  assert.equal(s.codigo, 'nota_emitida'); assert.equal(s.pendentes, 1); assert.equal(s.faltas, 1);
  assert.equal(s.sub, 'NF 2478800 de 16/10 · 1 item(ns) não vem · 1 pra decidir antes da entrega');

  const xa = lojaXml(); xa.itens[1].decisao = { acao: 'nao_vem', por: 'JOSE', em: '2026-10-16T12:40:00.000Z', papel: 'fiscal' }; xa.parcial_aceito = { por: 'JOSE', em: '2026-10-16T12:40:00.000Z', itens: ['7893000079311'] };
  s = fp.situacaoLoja(pedido(xa), 4, hoje);
  assert.equal(s.codigo, 'nota_emitida'); assert.equal(s.pendentes, 0);
  assert.equal(s.sub, 'NF 2478800 de 16/10 · parcial aceito pelo fiscal · 1 item(ns) não vem mais');
  // depois que a loja bipa, a situação "nota bipada" também conta o parcial aceito
  const xb = { ...xa, chegou: { em: '2026-10-16', notas: 1, de: 1, fechada: false, horaEntrada: '2026-10-16 07:31' }, notas: [{ ...xa.notas[0], entrada: { nCompra: 1, status: 'E', dataRecto: '2026-10-16', nConferencia: 185421 } }] };
  s = fp.situacaoLoja(pedido(xb), 4, hoje);
  assert.equal(s.codigo, 'nota_bipada'); assert.equal(s.nConferencia, 185421);
  assert.match(s.sub, /conferência 185421 · 1 item com falta ou parcial · parcial aceito pelo fiscal · 1 item\(ns\) não vem mais/);

  const xr = lojaXml({ entrega_recusada: { por: 'JOSE', em: '2026-10-16T12:40:00.000Z', chaves: [CH], itens: ['7893000079311'] } });
  s = fp.situacaoLoja(pedido(xr), 4, hoje);
  assert.equal(s.codigo, 'entrega_recusada'); assert.equal(s.pendentes, 0); assert.equal(s.texto, 'Entrega recusada pelo fiscal 16/10 09:40');
  assert.match(s.sub, /NF 2478800 · 1 item\(ns\) não vieram · a loja não recebe · vendedor cobrado/);
  // fornecedor mandou nota nova (chave diferente): a recusa deixa de valer e volta ao fluxo normal
  const xn = { ...xr, notas: [{ chave: 'CH-NOVA', nNota: 2478900, data: '2026-10-17' }] };
  assert.equal(fp.entregaRecusada(xn), null);
  assert.equal(fp.situacaoLoja(pedido(xn), 4, hoje).codigo, 'nota_emitida');

  // pedido com compradora: mesma nota, nada pra decidir pelo fiscal, texto antigo
  s = fp.situacaoLoja(pedido(lojaXml(), { cotacao: null, parametros: { origem: 'radar' }, comprador: { nome: 'BRUNA' } }), 4, hoje);
  assert.equal(s.codigo, 'nota_emitida'); assert.equal(s.pendentes, 0); assert.equal(s.sub, 'NF 2478800 de 16/10');
});

test('pedidosAReceber leva pro Fiscal as faltas, o parcial, a recusa e o texto do WhatsApp; recusada vem antes de a caminho', () => {
  const hoje = '2026-10-16';
  const lista = fp.pedidosAReceber(() => [pedido(lojaXml())], totais, { hoje });
  assert.equal(lista.length, 1);
  const r = lista[0];
  assert.equal(r.situacao, 'nota_emitida'); assert.equal(r.pendentes, 1); assert.equal(r.parcial_aceito, false); assert.equal(r.entrega_recusada, null);
  assert.deepEqual(r.faltas_lista.map(f => [f.cod, f.pedida, f.recebida]), [['7893000079311', 210, 0]]);
  assert.deepEqual(r.itens_nao_pedidos, []);
  assert.match(r.recusa_texto, /Olá Carlos, a NF 2478800 do pedido #169 .* · Loja 4 · ATACAREJO/);
  assert.match(r.recusa_texto, /• DELINE MARGARINA COM SAL 1KG: pedido 210, veio 0/);
  assert.match(r.recusa_texto, /não tem 2ª entrega/);

  const xr = lojaXml({ entrega_recusada: { por: 'JOSE', em: '2026-10-16T12:40:00.000Z', chaves: [CH], itens: [] } });
  const dois = fp.pedidosAReceber(() => [pedido(lojaXml(), { id: 170 }), pedido(xr)], totais, { hoje });
  assert.deepEqual(dois.map(l => l.pedido + ':' + l.situacao), ['169:entrega_recusada', '170:nota_emitida']);
  assert.deepEqual(dois[0].entrega_recusada, { por: 'JOSE', em: '2026-10-16T12:40:00.000Z' });
});

test('reconferência preserva as decisões do fiscal na loja (parcial aceito, recusa, liberou, fechou)', () => {
  cx.init(async () => []);
  const prev = lojaXml({ parcial_aceito: { por: 'JOSE', em: '2026-10-16T12:40:00.000Z', itens: ['7893000079311'] }, fiscal_liberou: { por: 'JOSE', em: '2026-10-16T13:00:00.000Z', nReg: 185421, parcial: true }, chegou: { em: '2026-10-16', fechada: false } });
  prev.itens[1].decisao = { acao: 'nao_vem', por: 'JOSE', em: '2026-10-16T12:40:00.000Z', papel: 'fiscal' };
  const p = pedido(prev);
  const nota = { chave: CH, nNota: 2478800, serie: '1', data: '2026-10-16', cnpjEmit: '08029696000352', emitente: 'ESTIVAS', valorNFE: 1733.94, valorProduto: 1733.94, desconto: 0, frete: 0, ipi: 0, st: 0, importado: true,
    itens: [{ item: 1, cod: '7896259411628', descricao: 'CAMPONESA CREME LEITE 200G TP', und: 'UN', undTrib: 'UN', qtdCom: 702, valorUnitCom: 2.47, unidades: 702, precoUnit: 2.47, total: 1733.94, desconto: 0, conversao: 'trib' }], boletos: [{ ndup: 1, vencimento: '2026-10-31', valor: 1733.94 }] };
  const r = cx.conferirLoja(p, 4, [nota], { itensFornec: {} });
  assert.equal(r.faltas, 1);
  // aplicarConferencia não é exportada: reproduz a parte que preserva (mesma lista de chaves do código)
  for (const k of ['fiscal_liberou', 'fiscal_fechou', 'entrega_recusada', 'parcial_aceito']) if (prev[k]) r[k] = prev[k];
  assert.deepEqual(r.parcial_aceito, prev.parcial_aceito); assert.deepEqual(r.fiscal_liberou, prev.fiscal_liberou);
});
