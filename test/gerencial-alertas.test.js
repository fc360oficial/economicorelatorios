const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const A = require('../lib/gerencial-alertas');

const L = (o) => ({ id: o.id, nome: o.nome, loja: o.loja || 5, setor: o.setor || 'CAIXA', situacao: o.situacao || 'ok',
  previsto: o.previsto === null ? null : { entrada: '07:00', saidaInt: '11:00', retornoInt: '12:00', saida: '16:20', ...(o.previsto || {}) },
  entrada: o.entrada || null, saidaInt: o.saidaInt || null, retornoInt: o.retornoInt || null, saida: o.saida || null });

test('pendentes: entrada sem marcação só depois de 10 min; quem bateu, folga, férias e sem escala não entram', () => {
  const linhas = [
    L({ id: 1, nome: 'ANA MARIA DA SILVA' }),                                  // 07:00, nada batido
    L({ id: 2, nome: 'BIA', entrada: '07:40' }),                               // bateu (atrasada, mas bateu)
    L({ id: 3, nome: 'CARLOS', previsto: { entrada: '07:30' } }),             // só passa 10 min às 07:40
    L({ id: 4, nome: 'DANI', situacao: 'folga', previsto: { folga: true } }),
    L({ id: 5, nome: 'EDU', situacao: 'ferias' }),
    L({ id: 6, nome: 'FÁBIO', situacao: 'sem_escala', previsto: null })
  ];
  assert.deepEqual(A.pendentes(linhas, '07:09').map(p => p.id), []);
  assert.deepEqual(A.pendentes(linhas, '07:10').map(p => p.id), [1]);
  assert.deepEqual(A.pendentes(linhas, '07:40').map(p => p.id), [1, 3]);
  assert.equal(A.pendentes(linhas, '07:40')[0].tipo, 'entrada');
});
test('pendentes: retorno do intervalo — saiu e não voltou 10 min depois do previsto', () => {
  const linhas = [
    L({ id: 1, nome: 'ANA', entrada: '07:00', saidaInt: '11:02' }),            // não voltou
    L({ id: 2, nome: 'BIA', entrada: '07:00', saidaInt: '11:00', retornoInt: '12:05' }),
    L({ id: 3, nome: 'CARLOS', entrada: '07:00' })                              // nem saiu pro intervalo: não é "sem retorno"
  ];
  assert.deepEqual(A.pendentes(linhas, '12:09').map(p => p.id), []);
  const p = A.pendentes(linhas, '12:10');
  assert.deepEqual(p.map(x => [x.id, x.tipo]), [[1, 'retorno']]);
  assert.equal(p[0].previsto, '12:00');
});
test('pendentes: saída — bateu a entrada, passou 10 min da saída prevista e não bateu a saída (28/10)', () => {
  const linhas = [
    L({ id: 1, nome: 'ANA', entrada: '07:00', saidaInt: '11:00', retornoInt: '12:00' }),            // não bateu a saída
    L({ id: 2, nome: 'BIA', entrada: '07:00', saidaInt: '11:00', retornoInt: '12:00', saida: '16:25' }),
    L({ id: 3, nome: 'CARLOS' })                                                                  // nem entrou: é 'entrada', não 'saida'
  ];
  assert.deepEqual(A.pendentes(linhas, '16:29').map(p => [p.id, p.tipo]), [[3, 'entrada']]);
  assert.deepEqual(A.pendentes(linhas, '16:30').map(p => [p.id, p.tipo]), [[1, 'saida'], [3, 'entrada']]);
  assert.equal(A.pendentes(linhas, '16:30')[0].previsto, '16:20');
  const av = A.montarAvisos([{ loja: 5, id: 1, nome: 'ANA MARIA', setor: 'CAIXA', tipo: 'saida', previsto: '16:20' }], new Set(), '2026-10-28');
  assert.equal(av[0].payload.body, 'ANA MARIA · CAIXA · saída prevista 16:20 e sem marcação');
});
test('montarAvisos: agrupa por loja, pula o que já foi avisado hoje, texto curto com nome e horário', () => {
  const pend = [
    { loja: 5, id: 1, nome: 'ANA MARIA DA SILVA', setor: 'CAIXA', tipo: 'entrada', previsto: '07:00' },
    { loja: 5, id: 2, nome: 'BIA SOUZA', setor: 'PADARIA', tipo: 'entrada', previsto: '06:30' },
    { loja: 5, id: 3, nome: 'CARLOS', setor: 'AÇOUGUE', tipo: 'retorno', previsto: '12:00' },
    { loja: 2, id: 9, nome: 'DANI LIMA', setor: 'CAIXA', tipo: 'entrada', previsto: '07:00' }
  ];
  const av = A.montarAvisos(pend, new Set(['2026-10-27:5:2:entrada']), '2026-10-27');
  assert.equal(av.length, 2);
  const e5 = av.find(a => a.loja === 5), e2 = av.find(a => a.loja === 2);
  assert.deepEqual(e5.chaves, ['2026-10-27:5:1:entrada', '2026-10-27:5:3:retorno']);
  assert.equal(e5.payload.title, 'Ponto · E5 · Porta Larga · 10 min do horário');
  assert.equal(e5.payload.body, 'ANA SILVA · CAIXA · entrada prevista 07:00 e sem marcação. CARLOS · AÇOUGUE · retorno do intervalo previsto 12:00 e sem marcação');
  assert.equal(e5.payload.url, '/gestao-gerencial.html#ponto'); assert.equal(e5.payload.tag, 'ponto-5');
  assert.equal(e2.payload.body, 'DANI LIMA · CAIXA · entrada prevista 07:00 e sem marcação');
  const muitos = A.montarAvisos([pend[0], pend[1], { loja: 5, id: 4, nome: 'EDU', tipo: 'entrada', previsto: '07:00' }], new Set(), '2026-10-27');
  assert.equal(muitos[0].payload.body, '3 sem marcação de entrada: ANA SILVA (07:00), BIA SOUZA (06:30), EDU (07:00)');
});
test('rodar: avisa uma vez por pessoa/momento por dia, persiste, e loja sem gerente inscrito fica pra depois', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ger-alertas-'));
  A.init({ dataDir: dir });
  const linhas = [L({ id: 1, nome: 'ANA' }), L({ id: 2, nome: 'BIA', loja: 2 })];
  const enviados = [];
  const deps = { jornadaHoje: async () => ({ linhas }), notificarLoja: async (loja, payload) => { enviados.push({ loja, payload }); return loja === 5 ? { usuarios: 1, ok: 1 } : { usuarios: 0, ok: 0 }; }, agora: '07:15', dia: '2026-10-27' };
  const r1 = await A.rodar(deps);
  assert.equal(r1.pendentes, 2); assert.equal(r1.avisos, 1); assert.equal(r1.semGerente, 1);
  assert.equal(enviados.length, 2);
  const r2 = await A.rodar({ ...deps, agora: '07:20' });
  assert.equal(r2.avisos, 0, 'loja 5 já avisada'); assert.equal(r2.semGerente, 1, 'loja 2 tenta de novo (ninguém inscrito)');
  assert.equal(enviados.filter(e => e.loja === 5).length, 1);
  A.init({ dataDir: dir });   // relê do disco
  assert.deepEqual(A._estado().chaves, ['2026-10-27:5:1:entrada']);
  const r3 = await A.rodar({ ...deps, dia: '2026-10-28' });
  assert.equal(r3.avisos, 1, 'dia novo zera');
});
