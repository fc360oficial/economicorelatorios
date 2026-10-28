const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const A = require('../lib/ajustes-estoque');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajustes-est-'));
const ger5 = { usuario: 'gerencia.e5', nome: 'Marcos', perfil: 'gerencial', loja_id: 5 };
const adm = { usuario: 'tiago', nome: 'Tiago Freire', perfil: 'admin' };

test('criar: gerente manda a contagem da própria loja; valida quantidade; loja vem do usuário', () => {
  A.init({ dataDir: dir });
  const r = A.criar(ger5, { loja: 2, cod: '7891', descricao: 'KIT PIZZA', unid: 'UN', estSistema: 50, contado: '30', obs: 'contado no depósito' });
  assert.equal(r.loja, 5, 'gerencial ignora a loja do corpo'); assert.equal(r.lojaTxt, 'E5 · Porta Larga');
  assert.equal(r.contado, 30); assert.equal(r.estSistema, 50); assert.equal(r.diferenca, -20); assert.equal(r.status, 'pendente'); assert.equal(r.nome, 'Marcos');
  assert.throws(() => A.criar(ger5, { cod: '1', contado: 'x' }), /quantidade contada/);
  assert.throws(() => A.criar(ger5, { cod: '', contado: 1 }), /sem código/);
  assert.throws(() => A.criar({ usuario: 'x', perfil: 'gerencial' }, { cod: '1', contado: 1 }), /sem loja/);
  assert.throws(() => A.criar(adm, { loja: 99, cod: '1', contado: 1 }), /Loja inválida/);
});
test('criar de novo o mesmo produto pendente: atualiza a contagem e guarda o histórico, sem duplicar', () => {
  const r = A.criar(ger5, { cod: '7891', contado: 28, obs: 'recontado' });
  assert.equal(A.listar({ status: 'pendente' }).length, 1);
  assert.equal(r.contado, 28); assert.equal(r.historico.length, 1); assert.equal(r.historico[0].contado, 30);
});
test('daLoja: pedidos recentes da loja por código (gerencial só a própria)', () => {
  A.criar(adm, { loja: 2, cod: '555', contado: 3, estSistema: 9 });
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
