const test = require('node:test');
const assert = require('node:assert/strict');
const fp = require('../lib/fiscal-pedidos');
const F = require('../lib/fiscal');

// Fiscal × Pedidos de Compra (13/10/2026): pedido de cotação = fiscal decide; pedido com compradora = ela decide; aba "Pedidos a receber".
function pedCotacao(extra = {}) {
  return {
    id: 64462, status: 'aprovado', fornecedor: 'BOM LEITE INDUSTRIAL LTDA', lista_nome: 'Laticínios', codFornec: 77, lojas: [2],
    aprovadoEm: '2026-10-06T12:00:00.000Z', aprovadoPor: 'Diretor', parametros: { origem: 'cotacao' }, cotacao: { id: 9, nome: 'Cotação laticínios', entrega: '2026-10-09', obs: 'Polpa só vence longa, acima de 90 d.' },
    comprador: null, vendedor: { nome: 'Carlos', whats: '81999990000' },
    itens: [
      { cod: '7898118392864', descricao: 'FRUTY BOM SUCO 330ML UVA', unid: 'UN', emb: 12, qtd: 12, lojas_qtd: { 2: 12 }, preco: 1.79, ultimo_custo: 1.70, obs: '' },
      { cod: '7898118391263', descricao: 'BOM LEITE COALHADA 140G MORANGO', unid: 'UN', emb: 24, qtd: 12, lojas_qtd: { 2: 12 }, preco: 2.69, ultimo_custo: 2.60, obs: '' }
    ],
    ...extra
  };
}
function xmlLoja(extra = {}) {
  return {
    status: 'consistencia', notas: [{ chave: 'CH1', nNota: 2537087, data: '2026-10-08', entrada: { nCompra: 5, status: 'E', dataRecto: '2026-10-09', nConferencia: 184824 } }],
    chegou: { em: '2026-10-09', notas: 1, de: 1, fechada: false, horaEntrada: '2026-10-09 10:10' },
    itens: [
      { cod: '7898118392864', descricao: 'FRUTY BOM SUCO 330ML UVA', pedida: 12, recebida: 12, tipo: 'ok', preco_digitado: 1.79, preco_xml: 1.83, preco_status: 'maior' },
      { cod: '7898118391263', descricao: 'BOM LEITE COALHADA 140G MORANGO', pedida: 12, recebida: 6, tipo: 'parcial', preco_digitado: 2.69, preco_xml: 2.69, preco_status: 'ok' }
    ],
    nao_pedidos: [{ cod: '7898118392253', descricao: 'BOM LEITE GARRAFA 900G AMEIXA', recebida: 6, preco_xml: 7.39 }],
    faltas: 1, problemas: [{ tipo: 'preco', msg: '1 item com preço diferente' }, { tipo: 'nao_pedido', msg: '1 item na nota que não estava no pedido' }],
    ...extra
  };
}

test('quem decide: cotação (diretor) = fiscal; radar / sugestão / ruptura = compradora', () => {
  assert.equal(fp.quemDecide(pedCotacao()), 'fiscal');
  assert.equal(fp.quemDecide({ parametros: { origem: 'radar' }, comprador: { nome: 'BRUNA' } }), 'compradora');
  assert.equal(fp.quemDecide({ parametros: { origem: 'sugestao-manual' } }), 'compradora');
  assert.equal(fp.quemDecide({ origem: { tipo: 'ruptura' }, cotacao: { id: 1 } }), 'compradora');   // ruptura ganha, como na tela
  assert.equal(fp.quemDecide({ cotacao: { id: 3 } }), 'fiscal');
  assert.equal(fp.obsDe(pedCotacao()).por, 'Diretor');
  assert.equal(fp.obsDe(pedCotacao({ obs_fiscal: 'conferir validade', obs_fiscal_por: 'KELLY' })).por, 'KELLY');
});

test('pendenciasLoja: preço acima, item não pedido e a mais pedem decisão; parcial/falta não; decidido sai da pendência', () => {
  const x = xmlLoja();
  let r = fp.pendenciasLoja(x);
  assert.equal(r.total, 2); assert.equal(r.pendentes.length, 2); assert.equal(r.decididas, 0);
  assert.deepEqual(r.pendentes.map(i => i.motivo).sort(), ['nao_pedido', 'preco']);
  x.itens[0].decisao = { acao: 'aceitar', por: 'JOSE', em: '2026-10-09T13:12:00.000Z', papel: 'fiscal' };
  r = fp.pendenciasLoja(x);
  assert.equal(r.pendentes.length, 1); assert.equal(r.decididas, 1); assert.equal(r.pendentes[0].cod, '7898118392253');
  x.itens.push({ cod: 'X', descricao: 'A MAIS', pedida: 10, recebida: 16, tipo: 'a_mais', preco_status: 'ok' });
  assert.equal(fp.pendenciasLoja(x).pendentes.length, 2);
  assert.equal(fp.pendenciasLoja({ ...x, status: 'conciliado' }).pendentes.length, 0);   // loja fechada: nada pendente
  assert.equal(fp.pendenciasLoja(null).total, 0);
});

test('entrega prevista: data da cotação; senão aprovação + prazo do vendedor; sem prazo = null', () => {
  assert.equal(fp.entregaPrevista(pedCotacao()), '2026-10-09');
  assert.equal(fp.entregaPrevista({ aprovadoEm: '2026-10-06T12:00:00.000Z', prazo_entrega: 3 }), '2026-10-09');
  assert.equal(fp.entregaPrevista({ aprovadoEm: '2026-10-06T12:00:00.000Z', prazo_entrega: null }), null);
});

test('situação da loja: aguardando nota (atrasado), nota bipada com conferência e pendências, liberado parcial, fechado', () => {
  const hoje = '2026-10-10';
  let s = fp.situacaoLoja(pedCotacao(), 2, hoje);
  assert.equal(s.codigo, 'aguardando_nota'); assert.equal(s.atraso, 1); assert.equal(s.nConferencia, null);
  s = fp.situacaoLoja(pedCotacao({ xml: { status: 'consistencia', lojas: { 2: xmlLoja() } } }), 2, hoje);
  assert.equal(s.codigo, 'nota_bipada'); assert.equal(s.nConferencia, 184824); assert.equal(s.pendentes, 2); assert.equal(s.texto, 'Nota bipada na loja 09/10 10:10');
  assert.match(s.sub, /conferência 184824 · 2 divergência\(s\) pra decidir/);
  s = fp.situacaoLoja(pedCotacao({ xml: { status: 'consistencia', lojas: { 2: xmlLoja({ chegou: null }) } } }), 2, hoje);
  assert.equal(s.codigo, 'nota_emitida');
  // fiscal liberou com falta → continua na aba como parcial
  s = fp.situacaoLoja(pedCotacao({ xml: { status: 'consistencia', lojas: { 2: xmlLoja({ fiscal_liberou: { por: 'JOSE', em: '2026-10-09T14:00:00.000Z', nReg: 184824, parcial: true } }) } } }), 2, hoje);
  assert.equal(s.codigo, 'liberado'); assert.match(s.texto, /^Liberado pelo fiscal 09\/10/); assert.equal(s.faltas, 1);
  // fechado pelo fiscal ("não vem mais") → sai
  s = fp.situacaoLoja(pedCotacao({ xml: { status: 'conciliado', lojas: { 2: xmlLoja({ status: 'conciliado', aceito: { por: 'JOSE', em: '2026-10-09T15:00:00.000Z', papel: 'fiscal' }, fiscal_fechou: { por: 'JOSE' } }) } } }), 2, hoje);
  assert.equal(s.codigo, 'fechado');
  // tudo veio e a loja fechou → sai
  s = fp.situacaoLoja(pedCotacao({ xml: { status: 'conciliado', lojas: { 2: xmlLoja({ status: 'conciliado', faltas: 0, chegou: { em: '2026-10-09', fechada: true } }) } } }), 2, hoje);
  assert.equal(s.codigo, 'fechado');
});

test('pedidosAReceber: uma linha por pedido × loja, só lojas permitidas, fechado e sem nota há 45+ dias somem', () => {
  const totaisLoja = (p, ln) => ({ ultimo_custo: 10, digitado: 12, itens: p.itens.filter(i => (i.lojas_qtd?.[ln] || 0) > 0).length, com_preco: 2 });
  const radar = { id: 64481, status: 'aprovado', fornecedor: 'AMBEV', codFornec: 5, lojas: [2, 3], aprovadoEm: '2026-10-08T10:00:00.000Z', parametros: { origem: 'radar' }, comprador: { nome: 'BRUNA' }, prazo_entrega: 2,
    itens: [{ cod: 'A', descricao: 'BRAHMA', qtd: 2, lojas_qtd: { 2: 1, 3: 1 }, preco: 2.98 }], avisos_fiscal: [{ loja: 2, por: 'JOSE', em: '2026-10-10T10:52:00.000Z' }] };
  const velho = { id: 1, status: 'aprovado', fornecedor: 'VELHO', lojas: [2], aprovadoEm: '2026-08-01T10:00:00.000Z', parametros: { origem: 'radar' }, itens: [{ cod: 'V', qtd: 1, lojas_qtd: { 2: 1 } }] };
  const fechado = pedCotacao({ id: 2, status: 'recebido', xml: { status: 'conciliado', lojas: { 2: xmlLoja({ status: 'conciliado', faltas: 0, chegou: { em: '2026-10-09', fechada: true } }) } } });
  const teste = pedCotacao({ id: 3, teste: true });
  // parcial (faltou item, loja fechada): fica só no pedido de cotação (o fiscal fecha); no pedido com compradora é ela quem fecha
  const parcialCot = pedCotacao({ id: 4, status: 'recebido_parcial', xml: { status: 'consistencia', lojas: { 2: xmlLoja({ chegou: { em: '2026-10-09', fechada: true }, fiscal_liberou: { por: 'JOSE', em: '2026-10-09T14:00:00.000Z', parcial: true } }) } } });
  const parcialRadar = { ...radar, id: 5, lojas: [2], status: 'recebido_parcial', xml: { status: 'consistencia', lojas: { 2: xmlLoja({ chegou: { em: '2026-10-09', fechada: true } }) } } };
  const parcialVelho = pedCotacao({ id: 6, aprovadoEm: '2026-09-01T12:00:00.000Z', cotacao: null, parametros: { origem: 'cotacao' }, status: 'recebido_parcial', xml: { status: 'consistencia', lojas: { 2: xmlLoja({ chegou: { em: '2026-09-03', fechada: true } }) } } });
  const listar = () => [pedCotacao({ xml: { status: 'consistencia', lojas: { 2: xmlLoja() } } }), radar, velho, fechado, teste, parcialCot, parcialRadar, parcialVelho];
  const rows = fp.pedidosAReceber(listar, totaisLoja, { lojas: [2], hoje: '2026-10-10' });
  assert.deepEqual(rows.map(r => r.key), ['64462-2', '4-2', '64481-2']);   // nota bipada, parcial da cotação, aguardando; loja 3 fora do escopo; velho/fechado/teste/parcial da compradora/parcial velho fora
  assert.equal(rows[1].situacao, 'liberado'); assert.equal(rows[1].faltas, 1);
  const c = rows[0];
  assert.equal(c.quem_decide, 'fiscal'); assert.equal(c.origem, 'cotacao'); assert.equal(c.obs.por, 'Diretor'); assert.equal(c.situacao, 'nota_bipada'); assert.equal(c.nConferencia, 184824);
  assert.equal(c.itens, 2); assert.equal(c.itens_vieram, 2); assert.equal(c.valor, 12); assert.equal(c.entrega_prevista, '2026-10-09');
  assert.equal(c.itens_lista[0].preco_status, 'maior'); assert.equal(c.itens_lista[1].tipo, 'parcial');
  const r = rows[2];
  assert.equal(r.quem_decide, 'compradora'); assert.equal(r.comprador, 'BRUNA'); assert.equal(r.situacao, 'aguardando_nota'); assert.equal(r.entrega_prevista, '2026-10-10'); assert.equal(r.atraso, 0); assert.equal(r.avisos_fiscal, 1);
  assert.equal(fp.pedidosAReceber(listar, totaisLoja, { lojas: null, loja: 3, hoje: '2026-10-10' }).length, 1);
  assert.match(fp.textoCobranca(c), /pedido #64462 \(Laticínios\) da Loja 2 · MURIBECA/);
  assert.match(fp.textoAvisoCompradora(radar, 2, 184831, [{ descricao: 'BRAHMA', motivo_txt: 'preço acima do combinado' }]), /Olá BRUNA.*pedido #64481.*conferência 184831/s);
});

test('pedidoAppPorCod (lib/fiscal): quem decide e o que precisa de decisão por item', () => {
  const p = pedCotacao({ xml: { status: 'consistencia', lojas: { 2: xmlLoja() } } });
  F.init(async () => [], { pedidos: () => [p] });
  const r = F.pedidoAppPorCod(77, 2, ['CH1']);
  assert.deepEqual(r.ids, [64462]);
  assert.equal(r.pedidos[0].quem_decide, 'fiscal'); assert.equal(r.pedidos[0].pendentes, 2); assert.equal(r.pedidos[0].obs.por, 'Diretor');
  assert.equal(r.map['7898118392864'].motivo, 'preco'); assert.equal(r.map['7898118392864'].precisa_decisao, true);
  assert.equal(r.map['7898118391263'].motivo, null); assert.equal(r.map['7898118391263'].precisa_decisao, false);
  assert.equal(r.map['7898118392253'].nao_pedido, true); assert.equal(r.map['7898118392253'].motivo, 'nao_pedido');
});

// cruzar() com uma nota do XML (não lançada) e o pedido de cotação ligado pela chave: erro até decidir, trava do Liberar, e depois de decidir vira info
function partes(prods) {
  return { chaves: [{ nRegConf: 184824, Chave: 'CH1', Obs: '0' }], notas: [{ nReg: 1, nNota: 2537087, nSerie: '1', nMod: '55', Data: '2026-10-08', CNPJdest: '', CNPJemit: 'E1', NomeEmit: 'BOM LEITE', ValorNFE: '100', ValorProduto: '100', Chave: 'CH1', Importado: 1, Status: 0 }],
    prods, boletos: [], coletor: prods.map(p => ({ chave: '184824', codigobarra: p.CodigoBarras, emb: 'UN', qtd: p.Qtd, qtdemb: '1', status: 1, Reconferir: 0, DataValidade: null })), compras: [], notaItens: [], pedConf: [], pedidos: [],
    cadastro: Object.fromEntries(prods.map(p => [p.CodigoBarras, { CodigoBarra: p.CodigoBarras, Descricao: p.Descricao, qtdemb: '1', Unid: 'UN', TipoBalanca: 'U', P2: '19.90', Validade: 0, CodDesativado: 0 }])), margens: {}, histVal: {}, custoAnt: [], custos: { 2: {} }, fornec: {} };
}
const prod = (ean, desc, qtd, preco) => ({ nNota: 2537087, CNPJemit: 'E1', nItem: 1, CodigoItemFornec: 'F1', CodigoBarras: ean, ocEanTrib: ean, Descricao: desc, Und: 'UN', Qtd: String(qtd), ValorUnit: String(preco), ValorTotal: String(qtd * preco), oqTrib: String(qtd), ouTrib: 'UN', ovUnTrib: String(preco), NCM: '0', CFOP: '5102' });
const conf = { nReg: 184824, nLoja: 2, CodFornec: 77, NomeFornec: 'BOM LEITE INDUSTRIAL LTDA', Status: 3, DataEntrada: '2026-10-09', HoraEntrada: '10:10:00', OperadorLoja: 'BRUNA', Obs: '0' };
const cfg = { ...F.CONFIG_PADRAO };

test('cruzar: divergências do pedido de cotação viram erro com decisão do fiscal pendente e travam o Liberar', () => {
  const p = pedCotacao({ xml: { status: 'consistencia', lojas: { 2: xmlLoja() } } });
  F.init(async () => [], { pedidos: () => [p] });
  const r = F.cruzar(conf, partes([prod('7898118392864', 'FRUTY BOM SUCO 330ML UVA', 12, 1.83), prod('7898118391263', 'BOM LEITE COALHADA 140G MORANGO', 6, 2.69), prod('7898118392253', 'BOM LEITE GARRAFA 900G AMEIXA', 6, 7.39)]), cfg, null);
  assert.equal(r.pedido_app.quem_decide, 'fiscal'); assert.equal(r.pedido_app.pendentes.length, 2);
  assert.deepEqual(r.pedido_app.pendentes.map(x => x.motivo).sort(), ['nao_pedido', 'preco']);
  assert.equal(r.checks.pedido.nivel, 'erro'); assert.match(r.checks.pedido.msg, /2 divergência\(s\) aguardando decisão do fiscal/);
  const suco = r.itens.find(i => i.ean === '7898118392864'), ameixa = r.itens.find(i => i.ean === '7898118392253'), coalhada = r.itens.find(i => i.ean === '7898118391263');
  assert.ok(suco.flags.some(f => f.tipo === 'preco_pedido' && f.nivel === 'erro')); assert.equal(suco.ped_app.precisa_decisao, true);
  assert.ok(ameixa.flags.some(f => f.tipo === 'nao_pedido' && f.nivel === 'erro')); assert.match(ameixa.flags.find(f => f.tipo === 'nao_pedido').msg, /Não está no pedido #64462 \(veio 6 UN a R\$ 7,39\)/);
  assert.equal(coalhada.ped_app.precisa_decisao, false); assert.ok(!coalhada.flags.some(f => f.nivel === 'erro'));
  assert.equal(r.situacao, 'excecao');
  assert.equal(r.pedidos_compra[0].quem_decide, 'fiscal'); assert.equal(r.pedidos_compra[0].obs_fiscal_por, 'Diretor'); assert.equal(r.obs_compradora_por, 'Diretor');
});

test('cruzar: depois que o fiscal decide, o erro vira "Liberado/Recusado por" e o pedido deixa de travar', () => {
  const x = xmlLoja();
  x.itens[0].decisao = { acao: 'aceitar', por: 'JOSE', em: '2026-10-09T13:12:00.000Z', papel: 'fiscal' };
  x.nao_pedidos[0].decisao = { acao: 'recusar', por: 'JOSE', em: '2026-10-09T13:13:00.000Z', papel: 'fiscal' };
  const p = pedCotacao({ xml: { status: 'consistencia', lojas: { 2: x } } });
  F.init(async () => [], { pedidos: () => [p] });
  const r = F.cruzar(conf, partes([prod('7898118392864', 'FRUTY BOM SUCO 330ML UVA', 12, 1.83), prod('7898118391263', 'BOM LEITE COALHADA 140G MORANGO', 6, 2.69), prod('7898118392253', 'BOM LEITE GARRAFA 900G AMEIXA', 6, 7.39)]), cfg, null);
  assert.equal(r.pedido_app.pendentes.length, 0); assert.equal(r.pedido_app.decididas, 2);
  const suco = r.itens.find(i => i.ean === '7898118392864'), ameixa = r.itens.find(i => i.ean === '7898118392253');
  assert.ok(!suco.flags.some(f => f.nivel === 'erro')); assert.equal(suco.flags.find(f => f.tipo === 'xml_decisao').msg, 'Liberado por JOSE em 09/10 (preço)');
  assert.ok(!ameixa.flags.some(f => f.nivel === 'erro')); assert.match(ameixa.flags.find(f => f.tipo === 'xml_decisao').msg, /^Recusado por JOSE em 09\/10 \(item não pedido\) — devolver/);
  // a coalhada veio parcial (6 de 12): não trava, fica como aviso de quantidade ≠ pedido
  assert.equal(r.checks.pedido.nivel, 'aviso'); assert.match(r.checks.pedido.msg, /2 divergência\(s\) decidida\(s\), 1 item\(ns\) com quantidade ≠ pedido/);
  assert.equal(r.situacao, 'pronto');
});

test('cruzar: pedido do radar com compradora — a pendência é dela e o Liberar fica travado do mesmo jeito', () => {
  const x = xmlLoja();
  const p = pedCotacao({ parametros: { origem: 'radar' }, cotacao: null, comprador: { nome: 'BRUNA' }, xml: { status: 'consistencia', lojas: { 2: x } } });
  F.init(async () => [], { pedidos: () => [p] });
  const r = F.cruzar(conf, partes([prod('7898118392864', 'FRUTY BOM SUCO 330ML UVA', 12, 1.83)]), cfg, null);
  assert.equal(r.pedido_app.quem_decide, 'compradora'); assert.equal(r.pedido_app.comprador, 'BRUNA');
  assert.equal(r.pedido_app.pendentes.length, 1);
  assert.match(r.checks.pedido.msg, /aguardando decisão da compradora BRUNA em Pedidos de Compra/);
});
