const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pf = require('../lib/pedidos-fornecedor');

// "Gerar com Custo (Grupo de Lojas)" do Dlinks: o pedido fecha na hora com o custo como preço, sem link do vendedor.
// Usa um arquivo de fixture próprio em data/pedidos-fornecedor (não mexe no _seq nem em pedidos reais).
const DIR = path.join(__dirname, '..', 'data', 'pedidos-fornecedor');
const ID = 'TESTE-COM-CUSTO';
const ARQ = path.join(DIR, ID + '.json');

function fixture(status) {
  fs.mkdirSync(DIR, { recursive: true });
  const p = {
    id: ID, token: 'ffffffffffffffffffffffffffffffff', lista: 999, lista_nome: 'LISTA TESTE', fornecedor: 'FORN TESTE',
    status, criadoEm: new Date().toISOString(), lojas: [1, 2],
    itens: [
      { cod: '111', descricao: 'A', qtd: 10, lojas_qtd: { 1: 6, 2: 4 }, ultimo_custo: 2.5, preco: null },
      { cod: '222', descricao: 'B', qtd: 3, lojas_qtd: { 1: 3 }, ultimo_custo: 8, preco: null },
      { cod: '333', descricao: 'C sem custo', qtd: 2, lojas_qtd: { 2: 2 }, ultimo_custo: 0, preco: null }
    ]
  };
  fs.writeFileSync(ARQ, JSON.stringify(p));
  return p;
}
const limpar = () => { try { fs.unlinkSync(ARQ); } catch (e) { /* já foi */ } };

test('fecharComCusto: preço da sugestão vira preço do item, fallback no último custo, e o pedido fica finalizado', () => {
  fixture('aguardando');
  try {
    const p = pf.fecharComCusto(ID, { '111': 2.75, '333': '1,20' }, 'Maria');
    assert.equal(p.status, 'finalizado');
    assert.equal(p.com_custo, true);
    assert.match(p.finalizadoPor, /Maria .*com custo/);
    const by = Object.fromEntries(p.itens.map(i => [i.cod, i.preco]));
    assert.equal(by['111'], 2.75);      // preço vindo da sugestão (preco_und)
    assert.equal(by['222'], 8);         // sem preço informado → último custo
    assert.equal(by['333'], 1.2);       // aceita vírgula
    assert.equal(p.totais.com_preco, 3);
    assert.equal(p.totais.digitado, +(10 * 2.75 + 3 * 8 + 2 * 1.2).toFixed(2));
  } finally { limpar(); }
});

test('fecharComCusto: pedido já finalizado/aprovado não é alterado', () => {
  fixture('aprovado');
  try {
    const r = pf.fecharComCusto(ID, { '111': 9 }, 'Maria');
    assert.ok(r.erro);
    const salvo = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    assert.equal(salvo.status, 'aprovado');
    assert.equal(salvo.itens[0].preco, null);
  } finally { limpar(); }
});

test('fecharComCusto: pedido inexistente devolve null', () => {
  assert.equal(pf.fecharComCusto('NAO-EXISTE-XYZ', {}, null), null);
});

// Flag "Usar o último custo · sem vendedor" (Tiago, 13/11/26): marcada no pedido em análise, anula o envio ao vendedor.
test('usarUltimoCusto: pedido em análise fecha com o último custo e pula o vendedor', () => {
  fixture('analise');
  try {
    const p = pf.usarUltimoCusto(ID, true, 'Patricia');
    assert.equal(p.status, 'finalizado');
    assert.equal(p.usar_ultimo_custo.por, 'Patricia');
    assert.equal(p.usar_ultimo_custo.de, 'analise');
    assert.equal(p.enviadoEm, undefined);              // nunca foi enviado ao vendedor
    assert.match(p.finalizadoPor, /Patricia .*último custo/);
    const by = Object.fromEntries(p.itens.map(i => [i.cod, i.preco]));
    assert.equal(by['111'], 2.5);
    assert.equal(by['222'], 8);
    assert.equal(by['333'], null);                     // sem último custo: fica sem preço
    assert.equal(pf.itensSemPreco(p), 1);
    assert.equal(p.totais.digitado, +(10 * 2.5 + 3 * 8).toFixed(2));
    const ap = pf.aprovar(ID, 'Patricia');             // segue o fluxo normal de aprovação
    assert.equal(ap.status, 'aprovado');
  } finally { limpar(); try { fs.unlinkSync(path.join(DIR, ID + '.pdf')); } catch (e) { /* sem pdf */ } }
});

test('usarUltimoCusto: desmarcar volta pra análise, tira os preços da flag e mantém o negociado', () => {
  fixture('analise');
  try {
    pf.negociarPreco(ID, '222', '7,50', 'Patricia');   // negociado antes de marcar
    let p = pf.usarUltimoCusto(ID, true, 'Patricia');
    assert.equal(p.itens.find(i => i.cod === '222').preco, 7.5);                     // negociado não é sobrescrito
    assert.equal(p.itens.find(i => i.cod === '222').negociado.preco_vendedor, 8);    // desfazer a negociação cai no último custo
    p = pf.usarUltimoCusto(ID, false, 'Patricia');
    assert.equal(p.status, 'analise');
    assert.equal(p.usar_ultimo_custo, undefined);
    assert.equal(p.com_custo, undefined);
    assert.equal(p.finalizadoEm, null);
    assert.equal(p.itens.find(i => i.cod === '111').preco, null);
    assert.equal(p.itens.find(i => i.cod === '222').preco, 7.5);
    assert.equal(pf.enviar(ID, 'Patricia').status, 'aguardando');                    // o envio ao vendedor volta a valer
  } finally { limpar(); }
});

test('usarUltimoCusto: só em análise/sugestão; desmarcar só enquanto finalizado pela flag', () => {
  fixture('aguardando');
  try {
    assert.ok(pf.usarUltimoCusto(ID, true, 'Maria').erro);
    assert.ok(pf.usarUltimoCusto(ID, false, 'Maria').erro);
    assert.equal(JSON.parse(fs.readFileSync(ARQ, 'utf8')).status, 'aguardando');
  } finally { limpar(); }
  fixture('sugestao');
  try {
    assert.equal(pf.usarUltimoCusto(ID, true, 'Maria').status, 'finalizado');
    assert.equal(pf.usarUltimoCusto(ID, false, 'Maria').status, 'sugestao');
  } finally { limpar(); }
  assert.equal(pf.usarUltimoCusto('NAO-EXISTE-XYZ', true, null), null);
});
