'use strict';
// Relatório em PDF do Cadastro Bancário por loja (lib/dados-bancarios-relatorio.js)
const test = require('node:test'), assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rel-'));
process.env.BANCO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banco-rel-'));
const GP = require('../lib/gestao-pessoas');
const DB = require('../lib/dados-bancarios');
const REL = require('../lib/dados-bancarios-relatorio');

GP.salvarConfig({ designados: [{ usuario: 'rh', papeis: ['rh_doc'], lojas: [] }, { usuario: 'rh1', papeis: ['rh_doc'], lojas: [1] }, { usuario: 'coord', papeis: ['coordenacao'], lojas: [] }, { usuario: 'ger', papeis: ['gerente'], lojas: [1] }] }, { usuario: 'admin', perfil: 'admin' });
const U = u => ({ usuario: u, nome: u.toUpperCase() });
const CPF = { 1: '11122233344', 2: '55566677788', 3: '99900011122', 4: '12312312312' };
const col = (id, nome, loja, ativo) => ({ id, nome, loja, cargo: 'OPERADOR DE CAIXA', cpf_fim: '***.***.' + CPF[id].slice(6, 9) + '-' + CPF[id].slice(9), ativo });
const deps = { colaboradores: async () => ({ gerado_em: '2026-11-12T10:00:00.000Z', ativos: [col(1, 'ANA DA SILVA', 1, true), col(2, 'BRUNO SOUZA', 1, true), col(3, 'CARLA LIMA', 2, true)], desligados: [col(4, 'DIEGO ALVES', 2, false)] }), cpfDe: async id => CPF[id] };

test('prepara: Ana com conta Itaú (E1) e Carla com Pix (E2)', async () => {
  await DB.criarVersao(1, { modalidade: 'transferencia', codigoBanco: '341', agencia: '2924', conta: '12345', digito: '6', tipoConta: 'corrente' }, U('rh'), deps, 'manual');
  await DB.criarVersao(3, { modalidade: 'pix', tipoChavePix: 'telefone', chavePix: '81999990000' }, U('rh'), deps, 'manual');
  assert.strictEqual(DB.situacaoFunc(1).cadastral, 'validado');
});

test('DP / RH: CPF e conta completos, agrupados por loja', async () => {
  const R = await REL.dados({}, U('rh'), deps);
  assert.strictEqual(R.completo, true); assert.deepStrictEqual(R.grupos.map(g => g.loja), [1, 2]); assert.strictEqual(R.total, 3);
  const [ana, bruno] = R.grupos[0].linhas;
  assert.strictEqual(ana.cpf, '111.222.333-44'); assert.strictEqual(ana.agencia, '2924'); assert.strictEqual(ana.conta, '12345-6'); assert.match(ana.banco, /ITAÚ \(341\)/);
  assert.strictEqual(bruno.cpf, '555.666.777-88'); assert.strictEqual(bruno.modalidade, ''); assert.strictEqual(bruno.conta, '');
  assert.deepStrictEqual(R.grupos[0].resumo, { total: 2, comConta: 1, semConta: 1, bloqueados: 0 });
  assert.match(R.grupos[1].linhas[0].pix, /Pix \(Telefone\): 81999990000/);
});

test('filtro de loja e de desligados seguem a tela', async () => {
  const so2 = await REL.dados({ loja: '2', inativos: '1' }, U('rh'), deps);
  assert.deepStrictEqual(so2.grupos.map(g => g.loja), [2]); assert.deepStrictEqual(so2.grupos[0].linhas.map(l => l.nome), ['CARLA LIMA', 'DIEGO ALVES']);
  assert.strictEqual(so2.grupos[0].linhas[1].ativo, false); assert.ok(so2.filtrosTxt.includes('incluindo desligados'));
  const validados = await REL.dados({ status: 'validado' }, U('rh'), deps);
  assert.deepStrictEqual(validados.grupos.flatMap(g => g.linhas.map(l => l.nome)), ['ANA DA SILVA', 'CARLA LIMA']);
});

test('RH de uma loja só enxerga a própria loja', async () => {
  const R = await REL.dados({}, U('rh1'), deps);
  assert.deepStrictEqual(R.grupos.map(g => g.loja), [1]);
});

test('Coordenação recebe a via mascarada (sem CPF nem conta completos)', async () => {
  const R = await REL.dados({}, U('coord'), deps); assert.strictEqual(R.completo, false);
  const txt = JSON.stringify(R);
  for (const segredo of ['11122233344', '111.222.333-44', '12345-6', '2924', '81999990000']) assert.ok(!txt.includes(segredo), segredo);
  assert.strictEqual(R.grupos[0].linhas[0].cpf, '***.***.333-44'); assert.match(R.grupos[0].linhas[0].conta, /^••••/);
});

test('gerente não emite o relatório', async () => {
  await assert.rejects(REL.dados({}, U('ger'), deps), /Sem acesso/);
});

test('PDF sai, tem nome de arquivo por loja e registra a emissão na auditoria', async () => {
  const r = await REL.pdf({ loja: '1' }, U('rh'), deps);
  assert.strictEqual(r.buffer.subarray(0, 5).toString('latin1'), '%PDF-'); assert.ok(r.buffer.length > 3000);
  assert.match(r.nomeArquivo, /^dados-bancarios-E1-\d{4}-\d{2}-\d{2}\.pdf$/);
  const todas = await REL.pdf({}, U('coord'), deps); assert.match(todas.nomeArquivo, /^dados-bancarios-todas-as-lojas-\d{4}-\d{2}-\d{2}-mascarado\.pdf$/);
  const ev = DB.historico({ acao: 'exportar_relatorio' }, U('coord'));
  assert.strictEqual(ev.length, 2); assert.ok(ev.some(e => e.usuario === 'rh' && e.loja === 1 && /completo/.test(e.resultado)));
  assert.ok(!JSON.stringify(ev).includes('12345-6'), 'auditoria não guarda dado bancário');
  await assert.rejects(REL.pdf({ q: 'ninguem com esse nome' }, U('rh'), deps), /Nenhum funcionário/);
});
