// Entrega DEVOLVIDA (16/10/2026, Aujo #94 Loja 1): a nota 669472 de 07/10 (7 itens, R$ 440,22) voltou inteira pela contranota
// 31451 de 09/10 (CFOP 1202, mesmos itens e valor). Antes a tela mostrava "entregue" + a devolução cinza e Financeiro "bate".
// Agora: contranota cobre tudo → loja 'devolvida' (fecha, sai da aba, não pagar boleto, cotar de novo); cobre parte → abate
// do recebido e vira problema 'devolucao'.
const test = require('node:test');
const assert = require('node:assert/strict');
const cx = require('../lib/conferencia-xml');
const fp = require('../lib/fiscal-pedidos');

const CAB = (lista) => lista.map(([nReg, nNota, data, valor, chave]) => ({ nReg, nNota, nSerie: '1', data, CNPJemit: '10334488000309', NomeEmit: 'AUJO', ValorNFE: valor, ValorProduto: valor, ValorDesconto: '0', ValorFrete: '0', ValorIPI: '0', ValorICMSsub: '0', Chave: chave, Importado: 0, Status: 0 }));
const prod = (nItem, cfop, cod, desc, qtd, vu) => ({ nItem, CodigoItemFornec: '', CodigoBarras: cod, ocEanTrib: cod, Descricao: desc, Und: 'UN', Qtd: String(qtd), ValorUnit: String(vu), ValorTotal: String(qtd * vu), ValorDesconto: '0', oqTrib: String(qtd), ovUnTrib: String(vu), CFOP: cfop });
const ITENS = (cfop, qA, qB) => [prod(1, cfop, '7896055504203', 'ATOL DESINFETANTE 90ML', qA, 4.23), prod(2, cfop, '7896055510068', 'ATOL LAVA LOUCAS COCO', qB, 1.39)];
function erp(cab, prods) {
  cx.init(async (sql, params) => {
    if (/MAX\(nReg\)/.test(sql)) return [{ m: 0 }];
    if (/FROM central\.fornecedor/.test(sql)) return [{ CNPJ: '10334488000309' }];
    if (/FROM central\.fornecedoritens/.test(sql)) return [];
    if (/FROM central\.axml WHERE/.test(sql)) return cab;
    if (/axmlprodutos/.test(sql)) return prods[params[0]] || [];
    if (/axmlboletos/.test(sql)) return params[0] === 'CHV' ? [{ ndup: 1, vencimento: '2026-10-22', valor: '134,88' }] : [];
    return [];
  });
}
const pedido = () => ({ id: 94, status: 'aprovado', codFornec: 523, fornecedor: 'AUJO DISTRIBUIDORA LTDA', lojas: [1], criadoEm: '2026-10-05T18:59:13.783Z', aprovadoEm: '2026-10-05T18:59:13.783Z', cotacao: { id: 2 },
  itens: [{ cod: '7896055504203', descricao: 'ATOL DESINFETANTE 90ML CORDEL FLORES', unid: 'UN', emb: 12, qtd: 24, lojas_qtd: { 1: 24 }, preco: 4.23 },
          { cod: '7896055510068', descricao: 'ATOL LAVA LOUCAS 500ML COCO', unid: 'UN', emb: 12, qtd: 24, lojas_qtd: { 1: 24 }, preco: 1.39 },
          { cod: '7896055503206', descricao: 'ATOL LAVA LOUCAS 500ML LIMAO', unid: 'UN', emb: 12, qtd: 48, lojas_qtd: { 1: 48 }, preco: 1.39 }] });
const rodar = async (p) => { const salvos = []; const rup = []; await cx.conferirTodos({ listar: () => [p], salvar: q => salvos.push(q.id), criarOuMesclarRuptura: () => rup.push(1) }); return { salvos, rup }; };

test('contranota com os mesmos itens e quantidades → loja devolvida: fecha, sai da aba, sem ruptura, conta no painel', async () => {
  erp(CAB([[1, 669472, '2026-10-07', '134,88', 'CHV'], [2, 31451, '2026-10-09', '134,88', 'CHD']]), { 669472: ITENS('5102', 24, 24), 31451: ITENS('1202', 24, 24) });
  const p = pedido(); const { rup } = await rodar(p);
  const x = p.xml.lojas[1];
  assert.equal(x.status, 'devolvida'); assert.deepEqual(x.notas.map(n => n.nNota), [669472]);
  assert.equal(x.devolvida.total, true); assert.equal(x.devolvida.em, '2026-10-09'); assert.deepEqual(x.devolvida.notas.map(n => n.nNota), [31451]);
  assert.deepEqual(x.itens.map(i => [i.cod, i.recebida, i.tipo]), [['7896055504203', 24, 'ok'], ['7896055510068', 24, 'ok'], ['7896055503206', 0, 'falta']]);
  assert.equal(rup.length, 0);   // entrega devolvida não vira sugestão de ruptura
  const s = fp.situacaoLoja(p, 1, '2026-10-16');
  assert.equal(s.codigo, 'fechado'); assert.equal(s.devolvida, true); assert.equal(s.texto, 'Entrega devolvida 09/10');
  assert.match(s.sub, /NF 669472 devolvida pela NF 31451 · nada ficou na loja · não pagar o boleto/);
  const tot = () => ({ itens: 3, com_preco: 3, digitado: 201.6, ultimo_custo: 0 });
  assert.equal(fp.pedidosAReceber(() => [p], tot, { hoje: '2026-10-16' }).length, 0);
  const R = fp.resumoCotacoes(() => [p], tot, { hoje: '2026-10-16' });
  assert.equal(R.length, 0);   // cotação sem pedido aberto some do painel
  assert.equal(fp.pendenciasLoja(x, true).pendentes.length, 0);
});

test('devolução de parte: abate do recebido, vira problema "devolução parcial" e a loja continua aberta', async () => {
  erp(CAB([[1, 669472, '2026-10-07', '134,88', 'CHV'], [2, 31451, '2026-10-09', '33,72', 'CHD']]), { 669472: ITENS('5102', 24, 24), 31451: [prod(1, '1202', '7896055510068', 'ATOL LAVA LOUCAS COCO', 12, 1.39)] });
  const p = pedido(); await rodar(p);
  const x = p.xml.lojas[1];
  assert.equal(x.status, 'consistencia'); assert.equal(x.devolvida.total, false); assert.deepEqual(x.devolvida.itens, { 7896055510068: 12 });
  const coco = x.itens.find(i => i.cod === '7896055510068');
  assert.equal(coco.recebida, 12); assert.equal(coco.tipo, 'parcial');
  assert.ok(x.problemas.some(z => z.tipo === 'devolucao' && /1 item\(ns\) devolvido\(s\) em parte/.test(z.msg)));
  assert.equal(fp.situacaoLoja(p, 1, '2026-10-16').codigo, 'nota_emitida');
});

test('devolução de outra compra (itens que não vieram nesta entrega) não fecha nem abate: só fica informada', async () => {
  erp(CAB([[1, 669472, '2026-10-07', '134,88', 'CHV'], [2, 31451, '2026-10-09', '10,00', 'CHD']]), { 669472: ITENS('5102', 24, 24), 31451: [prod(1, '1202', '7890000000000', 'OUTRO PRODUTO', 10, 1)] });
  const p = pedido(); await rodar(p);
  const x = p.xml.lojas[1];
  assert.equal(x.status, 'consistencia'); assert.equal(x.devolvida, undefined);
  assert.deepEqual(x.itens.map(i => i.recebida), [24, 24, 0]);
  assert.ok(!x.problemas.some(z => z.tipo === 'devolucao'));
  assert.deepEqual(x.notas_fora.map(n => n.nNota), [31451]);
});
