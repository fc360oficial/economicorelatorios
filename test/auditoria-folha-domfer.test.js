'use strict';
const test = require('node:test'), assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
// tudo em pastas temporárias: a simulação não pode tocar em dado real nem gravar nada
for (const [k, p] of [['GP_DIR', 'gp'], ['AUDITORIA_FOLHA_DIR', 'af'], ['PAGDF_DIR', 'pg'], ['TERMOS_DIR', 'te'], ['ESCALAS_DIR', 'es'], ['BANCO_DIR', 'bk']]) process.env[k] = fs.mkdtempSync(path.join(os.tmpdir(), p + '-'));
process.env.AUDITORIA_FOLHA_ROBO = '0';
const GP = require('../lib/gestao-pessoas');
GP.salvarConfig({ designados: [{ usuario: 'coord', papeis: ['coordenacao'], lojas: [] }, { usuario: 'cpd', papeis: ['cpd'], lojas: [1] }] }, { usuario: 'admin', perfil: 'admin' });
const item = (id, nome, data, v, pass, pago, ref) => ({ key: id + '|' + data, funcId: id, nome, cpf_fim: '***.***.100-0' + (id % 10), loja: 1, lojaTxt: 'E1 · Socorro', cargo: 'OPERADOR DE LOJA', data, tipo: 'domingo', nomeFeriado: null, ponto: { situacao: 'completa', marcacoes: ['07:00', '13:00'] }, termo: { id: 'TE-2026-0001', em: '2026-10-23T10:00:00.000Z' }, valorTrabalho: v, passagem: { aplica: pass, valor: 9 }, origemValor: 'tabela', funcaoTabela: 'Operador de Loja', divergencias: [], selecionado: true, pagamento: pago ? { status: 'pago', data: '2026-10-26', extratoRef: ref, transacao: 'SISPAG SALARIOS', obs: 'lote' } : { status: 'pendente' } });
const rel = (id, status, datas, itens) => ({ id, status, lojas: [1], lojasTxt: ['E1'], datas, itens, previsaoPagamento: { data: '2026-10-26' }, aprovacao: { em: '2026-10-26T12:00:00.000Z' }, fluxo: [], exportacoes: [], revisoes: [], conciliacao: null });
const LOTE = 'cahu|2026-10-26|436.00|34';
fs.writeFileSync(path.join(process.env.PAGDF_DIR, 'relatorios.json'), JSON.stringify([
  rel('PG-2026-0001', 'pago', ['2026-10-25'], [item(1, 'Ana Exemplo', '2026-10-25', 55, true, true, LOTE), item(2, 'Beto Exemplo', '2026-10-25', 55, true, true, LOTE), item(3, 'Caio Exemplo', '2026-10-25', 55, true, true, LOTE), item(4, 'Dora Exemplo', '2026-10-25', 55, true, true, LOTE), item(5, 'Edu Exemplo', '2026-10-25', 55, true, true, LOTE), item(6, 'Flor Exemplo', '2026-10-25', 55, true, true, LOTE), item(7, 'Gil Exemplo', '2026-10-25', 52, false, true, LOTE)]),
  rel('PG-2026-0002', 'encaminhado_financeiro', ['2026-10-04'], [item(1, 'Ana Exemplo', '2026-10-04', 55, true, false), item(2, 'Beto Exemplo', '2026-10-04', 55, true, false), item(3, 'Caio Exemplo', '2026-10-04', 55, true, false), item(4, 'Dora Exemplo', '2026-10-04', 55, true, false), item(5, 'Edu Exemplo', '2026-10-04', 55, true, false), item(6, 'Flor Exemplo', '2026-10-04', 55, true, false)]),
  rel('PG-2026-0003', 'encaminhado_financeiro', ['2026-10-11'], [item(1, 'Ana Exemplo', '2026-10-11', 55, true, false), item(2, 'Beto Exemplo', '2026-10-11', 55, true, false), item(3, 'Caio Exemplo', '2026-10-11', 55, true, false), item(4, 'Dora Exemplo', '2026-10-11', 55, true, false), item(5, 'Edu Exemplo', '2026-10-11', 55, true, false), item(6, 'Flor Exemplo', '2026-10-11', 55, true, false)]),
  rel('PG-2026-0009', 'cancelado', ['2026-10-18'], [item(1, 'Ana Exemplo', '2026-10-18', 55, true, false)]),
]));
fs.mkdirSync(path.join(process.env.AUDITORIA_FOLHA_DIR, 'competencias'), { recursive: true });
const lote = (ref, data, valor, n) => ({ ref, data, valor, favorecido: null, historico: 'SISPAG SALARIOS (lote com ' + n + ' lançamento(s))', categoria: 'salario', conta: 'cahu', loja: 1, lojaTxt: 'E1 · Socorro', documento: null, janela: 'adiantamento', lote: true, lancamentosNoLote: n });
fs.writeFileSync(path.join(process.env.AUDITORIA_FOLHA_DIR, 'competencias', '2026-10.json'), JSON.stringify({ competencia: '2026-10', criadaEm: '2026-11-04T00:00:00.000Z', documentos: { adiantamento: { lojas: { 1: {} } }, folha: null }, funcionarios: Array.from({ length: 11 }, (_, k) => ({ key: 'f' + k, nome: 'F' + k, loja: 1, adiantamento: { previsto: 100, pago: 100, situacao: 'lote' } })), naoIdentificados: [lote('cahu|2026-10-13|384.00|1', '2026-10-13', 384, 6), lote('cahu|2026-10-14|544.00|2', '2026-10-14', 544, 8), lote('cahu|2026-10-30|11557.80|3', '2026-10-30', 11557.8, 11), lote('cahu|2026-10-20|400.00|4', '2026-10-20', 400, 6)], divergencias: [], conciliacao: { em: '2026-11-04T12:00:00.000Z', periodo: { de: '2026-10-10', ate: '2026-11-04' }, janelas: {}, lojas: [] }, evolucao: [], historico: [], encerramento: null, seq: 0, importacoes: [] }));
const DF = require('../lib/auditoria-folha-domfer');
const coord = { usuario: 'coord', nome: 'Coordenação Teste', perfil: 'usuario' };

test('lote já casado por Pagamentos Dom/Feriados conta como financeiro, nunca como individual', () => {
  const s = DF.simular('2026-10', coord); const l = s.lotes.find(x => x.ref === LOTE);
  assert.ok(l && l.origem === 'pagamentos_df'); assert.strictEqual(l.situacao, 'financeiro'); assert.strictEqual(l.lancamentos, 7);
  assert.strictEqual(s.bloco.conciliadoIndividual, 0); assert.strictEqual(s.indicadores.pctIndividual, 0); assert.strictEqual(s.bloco.aguardandoDetalhamento, 436);
  assert.ok(s.itens.filter(i => i.lote === LOTE).every(i => i.situacao === 'conciliado_lote'));
});
test('dois relatórios com a mesma quantidade e valor = ambíguo; valor diferente = divergente; folha provável; cancelado fora', () => {
  const s = DF.simular('2026-10', coord); const by = ref => s.lotes.find(x => x.ref.startsWith(ref));
  assert.strictEqual(by('cahu|2026-10-13').situacao, 'ambiguo');            // 0002 e 0003 fecham 6 × 64 = 384
  assert.strictEqual(by('cahu|2026-10-20').situacao, 'divergente'); assert.strictEqual(by('cahu|2026-10-20').diferencas[0].tipo, 'valor_superior');
  assert.strictEqual(by('cahu|2026-10-14').situacao, 'sem_candidato');
  assert.strictEqual(by('cahu|2026-10-30').situacao, 'folha_provavel');
  assert.ok(!s.relatorios.some(r => r.id === 'PG-2026-0009'));
  assert.strictEqual(s.bloco.identificado, 436); assert.strictEqual(s.bloco.autorizado, r2(436 + 384 + 384));
});
test('registro único: cada item aparece uma vez, com termo e protocolo', () => {
  const s = DF.simular('2026-10', coord); const ps = s.itens.map(i => i.protocolo); assert.strictEqual(new Set(ps).size, ps.length); assert.strictEqual(s.itens.length, 19);
  assert.ok(s.itens.every(i => i.termo && i.termo.id === 'TE-2026-0001' && /^\*\*\*/.test(i.cpf)));
});
test('CPD não enxerga; nada é gravado', () => {
  assert.throws(() => DF.simular('2026-10', { usuario: 'cpd', nome: 'CPD', perfil: 'usuario' }), /Sem acesso/);
  const antes = fs.readFileSync(path.join(process.env.PAGDF_DIR, 'relatorios.json'), 'utf8'); DF.simular('2026-10', coord);
  assert.strictEqual(fs.readFileSync(path.join(process.env.PAGDF_DIR, 'relatorios.json'), 'utf8'), antes); assert.deepStrictEqual(fs.readdirSync(path.join(process.env.AUDITORIA_FOLHA_DIR, 'competencias')), ['2026-10.json']);
});
function r2(n) { return Math.round(n * 100) / 100; }
