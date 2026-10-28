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

// ── 28/10: lembrete de 1 h e resumos das 09:00 e 15:00 ──
test('lembrete: 1 h depois ainda sem marcação manda UM lembrete e depois nada mais no dia', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ger-alertas-l-'));
  A.init({ dataDir: dir });
  const linhas = [L({ id: 1, nome: 'ANA MARIA' })];
  const enviados = [];
  const deps = { jornadaHoje: async () => ({ linhas }), notificarLoja: async (loja, payload) => { enviados.push(payload); return { usuarios: 1, ok: 1 }; }, dia: '2026-10-28' };
  assert.equal((await A.rodar({ ...deps, agora: '07:15' })).avisos, 1);
  assert.match(enviados[0].title, /10 min/); assert.match(enviados[0].body, /sem marcação$/);
  assert.equal((await A.rodar({ ...deps, agora: '07:40' })).lembretes, 0, 'entre 10 min e 1 h: nada');
  const r = await A.rodar({ ...deps, agora: '08:00' });
  assert.equal(r.lembretes, 1); assert.equal(r.avisos, 0);
  assert.equal(enviados[1].title, 'Ponto · E5 · Porta Larga · lembrete de 1 h'); assert.equal(enviados[1].body, 'ANA MARIA · CAIXA · entrada prevista 07:00 · ainda sem marcação há 1 h');
  const r2 = await A.rodar({ ...deps, agora: '08:30' });
  assert.equal(r2.avisos + r2.lembretes, 0, 'depois do lembrete, silêncio');
  assert.equal(enviados.length, 2);
});
test('lembrete: servidor parado às 07:10 e voltou às 08:30 → só o lembrete (não os dois)', () => {
  const pend = A.pendentes([L({ id: 1, nome: 'ANA' })], '08:30');
  const av = A.montarAvisos(pend, new Set(), '2026-10-28');
  assert.equal(av.length, 1); assert.equal(av[0].lembrete, true);
  assert.deepEqual(av[0].chaves, ['2026-10-28:5:1:entrada', '2026-10-28:5:1:entrada:lembrete']);
});
test('montarResumo: previstos, bateram, sem marcação, após o horário, trabalhando na folga', () => {
  const linhas = [
    L({ id: 1, nome: 'ANA MARIA' }),                                                                  // sem marcação
    L({ id: 2, nome: 'BIA SOUZA', entrada: '07:40' }),                                                // após (+40)
    L({ id: 3, nome: 'CARLOS LIMA', entrada: '06:58' }),                                              // ok
    L({ id: 4, nome: 'DANI', situacao: 'folga_trabalhada', previsto: { folga: true }, entrada: '08:00' }),
    L({ id: 5, nome: 'EDU', situacao: 'ferias' }),
    L({ id: 6, nome: 'FÁBIO', loja: 2 }),
    L({ id: 7, nome: 'GIL', previsto: { entrada: '13:00' } })                                         // ainda não era a hora às 09:00
  ];
  const r = A.montarResumo(linhas, 5, '09:00');
  assert.equal(r.previstos, 4); assert.equal(r.bateram, 2); assert.equal(r.semEntrada, 1); assert.equal(r.apos, 1); assert.equal(r.folgaTrab, 1);
  assert.equal(r.payload.title, 'Resumo 09:00 · E5 · Porta Larga');
  assert.equal(r.payload.body, '4 previstos · 2 bateram. Sem marcação (1): ANA MARIA (07:00). Após o horário (1): BIA SOUZA (+40 min). Trabalhando na folga (1): DANI');
  const ok = A.montarResumo([L({ id: 3, nome: 'CARLOS', entrada: '06:58' })], 5, '15:00');
  assert.equal(ok.payload.body, '1 previstos · 1 bateram. Todos no horário');
});
test('resumosPendentes: só na hora (janela de 3 h), uma vez por loja por dia', () => {
  const linhas = [L({ id: 1, nome: 'ANA', entrada: '07:00' }), L({ id: 6, nome: 'FÁBIO', loja: 2, entrada: '07:00' })];
  assert.equal(A.resumosPendentes(linhas, '08:59', new Set(), '2026-10-28').length, 0);
  const r9 = A.resumosPendentes(linhas, '09:03', new Set(), '2026-10-28');
  assert.deepEqual(r9.map(x => [x.loja, x.hora, x.chave]), [[2, '09:00', '2026-10-28:2:resumo:09:00'], [5, '09:00', '2026-10-28:5:resumo:09:00']]);
  assert.equal(A.resumosPendentes(linhas, '09:03', new Set(['2026-10-28:5:resumo:09:00']), '2026-10-28').length, 1, 'E5 já saiu');
  assert.equal(A.resumosPendentes(linhas, '12:30', new Set(), '2026-10-28').length, 0, 'fora da janela: não manda o das 09 à tarde');
  assert.equal(A.resumosPendentes(linhas, '15:10', new Set(), '2026-10-28')[0].hora, '15:00');
});
test('rodar: manda o resumo das 09:00 uma vez e persiste a chave', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ger-alertas-r-'));
  A.init({ dataDir: dir });
  const enviados = [];
  const deps = { jornadaHoje: async () => ({ linhas: [L({ id: 1, nome: 'ANA', entrada: '07:00' })] }), notificarLoja: async (loja, payload) => { enviados.push(payload); return { usuarios: 1, ok: 1 }; }, dia: '2026-10-28' };
  assert.equal((await A.rodar({ ...deps, agora: '09:02' })).resumos, 1);
  assert.equal((await A.rodar({ ...deps, agora: '09:07' })).resumos, 0);
  assert.match(enviados[0].title, /Resumo 09:00/);
  A.init({ dataDir: dir }); assert.ok(A._estado().chaves.includes('2026-10-28:5:resumo:09:00'));
});
