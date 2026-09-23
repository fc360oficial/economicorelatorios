const test = require('node:test');
const assert = require('node:assert/strict');
const radar = require('../lib/radar-pedidos');

// itensLista com opts.ignorarTransito: a loja marcada é calculada como se nada estivesse a caminho (Cotação, 23/09/2026)
function baseFalsa() {
  const porLoja = {
    1: { vq: 10, vR: 50, est: 100, estBruto: 100, transito: 200, transitoDet: [{ sugestao: 61836, data: '2026-08-25', und: 200, nfe: [] }], fonte: '40d', jaVendeu: true },
    2: { vq: 5, vR: 25, est: 0, estBruto: 0, transito: 0, transitoDet: [], fonte: '40d', jaVendeu: true },
  };
  return {
    hoje: '2026-09-23', dIni: '2026-08-14', dFim: '2026-09-22', dias: 40, curvaA: { n: 0 },
    listas: { 277: { lista: 277, nome: 'Cotação', fornecedor: null, codFornec: 0, pedidoMinimo: 0, comprador: null } },
    prods: [{ lista: 277, cod: '7898403782387', descricao: 'BETANIA LEITE', unid: 'UN', emb: 12, validade: 0, lojas: [1, 2], vq: 15, vR: 75, est: 100, estBruto: 100, transito: 200, custo: 4, porLoja, curvaA: false }],
  };
}

test('sem opts: trânsito conta (loja 1 folgada pede 0); com ignorarTransito a loja 1 pede e a loja 2 não muda', () => {
  radar._setBaseParaTeste(baseFalsa());
  const P = { alvo: 28, ponto: 3 };
  const a = radar.itensLista(277, 28, 0, 36, false, P);
  const ia = a.itens[0];
  assert.equal(ia.lojas_qtd[1] || 0, 0, 'loja 1 com 100 + 200 a caminho cobre 28 d × 10/d');
  assert.equal(ia.lojas_det[1].transito, 200); assert.equal(ia.lojas_det[1].transito_ignorado, false);
  const b = radar.itensLista(277, 28, 0, 36, false, P, { ignorarTransito: new Set(['7898403782387|1']) });
  const ib = b.itens[0];
  assert.ok(ib.lojas_qtd[1] > 0, 'sem o trânsito, loja 1 precisa pedir');
  assert.equal(ib.lojas_qtd[1] % 12, 0, 'arredondado na caixa');
  assert.equal(ib.lojas_det[1].transito, 200, 'trânsito original continua visível');
  assert.equal(ib.lojas_det[1].transito_ignorado, true);
  assert.deepEqual(ib.lojas_det[1].transito_det, ia.lojas_det[1].transito_det);
  assert.equal(ib.lojas_qtd[2], ia.lojas_qtd[2], 'loja 2 não muda');
  assert.ok(ib.cobertura_dias < ia.cobertura_dias, 'cobertura cai sem o trânsito');
  const c = radar.itensLista(277, 28, 0, 36, false, P, { ignorarTransito: new Set(['outro|1']) });
  assert.equal(c.itens[0].lojas_qtd[1] || 0, 0, 'chave de outro produto não afeta');
});
