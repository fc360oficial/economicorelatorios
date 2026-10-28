const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const A = require('../lib/ajustes-estoque');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajustes-est-'));
const ger5 = { usuario: 'gerencia.e5', nome: 'Marcos', perfil: 'gerencial', loja_id: 5 };
const adm = { usuario: 'tiago', nome: 'Tiago Freire', perfil: 'admin' };

test('criar: gerente manda a contagem da própria loja; valida quantidade; loja vem do usuário', () => {
  A.init({ dataDir: dir });
  assert.throws(() => A.criar(ger5, { cod: '7891', contado: 1, obs: 'x', manter: 'sim' }), /rebaixa/, 'quer manter → tem que responder a rebaixa (28/10)');
  const r = A.criar(ger5, { loja: 2, cod: '7891', descricao: 'KIT PIZZA', unid: 'UN', estSistema: 50, contado: '30', obs: 'contado no depósito', manter: 'sim', rebaixa: 'nao' });
  assert.equal(r.rebaixa, false); assert.equal(r.rebaixaStatus, null);
  assert.equal(r.loja, 5, 'gerencial ignora a loja do corpo'); assert.equal(r.lojaTxt, 'E5 · Porta Larga');
  assert.equal(r.contado, 30); assert.equal(r.estSistema, 50); assert.equal(r.diferenca, -20); assert.equal(r.status, 'pendente'); assert.equal(r.nome, 'Marcos');
  assert.equal(r.manter, true, 'resposta "deseja manter na loja" guardada (28/10)');
  assert.throws(() => A.criar(ger5, { cod: '1', contado: 'x', obs: 'x', manter: 'sim' }), /quantidade contada/);
  assert.throws(() => A.criar(ger5, { cod: '', contado: 1, obs: 'x', manter: 'sim' }), /sem código/);
  assert.throws(() => A.criar(ger5, { cod: '1', contado: 1, obs: '  ', manter: 'sim' }), /observação/, 'observação obrigatória (28/10)');
  assert.throws(() => A.criar(ger5, { cod: '1', contado: 1, obs: 'x' }), /manter o produto/, 'sim ou não obrigatório (28/10)');
  assert.throws(() => A.criar(ger5, { cod: '1', contado: 1, obs: 'x', manter: 'talvez' }), /manter o produto/);
  assert.throws(() => A.criar({ usuario: 'x', perfil: 'gerencial' }, { cod: '1', contado: 1, obs: 'x', manter: 'sim' }), /sem loja/);
  assert.throws(() => A.criar(adm, { loja: 99, cod: '1', contado: 1, obs: 'x', manter: 'sim' }), /Loja inválida/);
});
test('criar de novo o mesmo produto pendente: atualiza a contagem e guarda o histórico, sem duplicar', () => {
  const r = A.criar(ger5, { cod: '7891', contado: 28, obs: 'recontado', manter: 'nao' });
  assert.equal(A.listar({ status: 'pendente' }).length, 1);
  assert.equal(r.contado, 28); assert.equal(r.historico.length, 1); assert.equal(r.historico[0].contado, 30);
  assert.equal(r.manter, false); assert.equal(r.historico[0].manter, true, 'histórico guarda a resposta anterior');
});
test('daLoja: pedidos recentes da loja por código (gerencial só a própria)', () => {
  A.criar(adm, { loja: 2, cod: '555', contado: 3, estSistema: 9, obs: 'x', manter: false });
  const d = A.daLoja(ger5, 2);
  assert.equal(d.loja, 5); assert.equal(d.itens.length, 1); assert.equal(d.itens[0].cod, '7891');
  assert.equal(A.daLoja(adm, 2).itens[0].cod, '555');
});
test('pendencias/resumo/listar', () => {
  assert.equal(A.pendencias().n, 2);
  const s = A.resumo(); assert.equal(s.pendentes, 2); assert.equal(s.porLoja[5], 1); assert.equal(s.porLoja[2], 1);
  assert.equal(A.listar({ status: 'pendente', loja: 5 }).length, 1);
  assert.equal(A.listar({ status: 'todos' }).length, 2);
});
test('tratar: atualizado na central / recusado com motivo; persiste', () => {
  const id = A.listar({ loja: 5 })[0].id;
  const r = A.tratar(adm, id, { status: 'atualizado' });
  assert.equal(r.status, 'atualizado'); assert.equal(r.tratadoPor, 'Tiago Freire'); assert.ok(r.tratadoEm); assert.equal(r.statusTxt, 'Atualizado na central');
  assert.throws(() => A.tratar(adm, A.listar({ loja: 2 })[0].id, { status: 'recusado' }), /motivo/);
  const rec = A.tratar(adm, A.listar({ loja: 2 })[0].id, { status: 'recusado', obs: 'produto já foi contado ontem' });
  assert.equal(rec.status, 'recusado'); assert.equal(rec.respostaObs, 'produto já foi contado ontem');
  assert.equal(A.pendencias().n, 0);
  assert.throws(() => A.tratar(adm, 'nao-existe', { status: 'atualizado' }), /não encontrado/);
  A.init({ dataDir: dir });
  assert.equal(A.listar({ status: 'atualizado' }).length, 1, 'persistiu no disco');
  assert.equal(A.daLoja(ger5).itens[0].status, 'atualizado', 'celular vê o tratado recente');
});

test('rebaixa de preço (28/10): gerente pede com preço sugerido; retaguarda aceita com preço novo ou recusa com motivo; pendência separada do estoque', () => {
  const r = A.criar(ger5, { cod: '4242', descricao: 'AZEITE', estSistema: 10, contado: 10, obs: 'encalhado na ponta', manter: 'sim', rebaixa: 'sim', precoSugerido: '19,9'.replace(',', '.'), precoAtual: 32.9, custo: 21.4 });
  assert.equal(r.rebaixa, true); assert.equal(r.rebaixaStatus, 'pendente'); assert.equal(r.rebaixaTxt, 'Rebaixa a decidir'); assert.equal(r.precoSugerido, 19.9); assert.equal(r.precoAtual, 32.9); assert.equal(r.custo, 21.4);
  assert.ok(A.resumo().rebaixas >= 1);
  assert.throws(() => A.tratarRebaixa(adm, r.id, { status: 'aceita' }), /preço novo/);
  assert.throws(() => A.tratarRebaixa(adm, r.id, { status: 'recusada' }), /motivo/);
  assert.throws(() => A.tratarRebaixa(adm, r.id, { status: 'xx', preco: 1 }), /inválida/);
  // estoque tratado mas rebaixa ainda pendente → continua na lista de pendentes da retaguarda
  A.tratar(adm, r.id, { status: 'atualizado' });
  assert.ok(A.listar({ status: 'pendente' }).some(x => x.id === r.id), 'rebaixa a decidir mantém o pedido em pendentes');
  const ok = A.tratarRebaixa(adm, r.id, { status: 'aceita', preco: '24.9' });
  assert.equal(ok.rebaixaStatus, 'aceita'); assert.equal(ok.rebaixaPreco, 24.9); assert.equal(ok.rebaixaPor, 'Tiago Freire'); assert.ok(ok.rebaixaEm);
  assert.ok(!A.listar({ status: 'pendente' }).some(x => x.id === r.id), 'decidida sai dos pendentes');
  const rec = A.tratarRebaixa(adm, r.id, { status: 'recusada', obs: 'margem não permite' });
  assert.equal(rec.rebaixaStatus, 'recusada'); assert.equal(rec.rebaixaPreco, null); assert.equal(rec.rebaixaObs, 'margem não permite');
  // sem pedido de rebaixa não há o que decidir; e quem não quer manter o produto não responde a rebaixa
  const s = A.criar(adm, { loja: 3, cod: '777', contado: 1, obs: 'x', manter: 'nao', rebaixa: 'sim' });
  assert.equal(s.rebaixa, null); assert.throws(() => A.tratarRebaixa(adm, s.id, { status: 'aceita', preco: 5 }), /não tem solicitação/);
});
