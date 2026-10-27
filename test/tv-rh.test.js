// test/tv-rh.test.js — TV do RH (Ponto e Jornada, 26/10/2026): config, classificação das situações pra TV e montagem das telas
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../lib/tv-rh');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-rh-'));
const PV = { folga: false, entrada: '07:00', saidaInt: '11:00', retornoInt: '13:00', saida: '17:00', periodos: 2 };
const linha = (x = {}) => ({ id: 1, nome: 'ANA', loja: 4, setor: 'BALCAO', cargo: 'OPERADOR DE LOJA', situacao: 'em_andamento', previsto: PV, entrada: null, saidaInt: null, retornoInt: null, saida: null, atraso_min: 0, marcacoes: [], ...x });

test('config padrão nasce com token de 32 hex e é persistida', () => {
  m.init({ dataDir: DIR, jornadaDia: async () => ({ linhas: [] }), colaboradores: async () => ({ ativos: [] }) });
  const c = m.getConfig();
  assert.match(c.token, /^[a-f0-9]{32}$/);
  assert.deepEqual(c.lojas, []); assert.equal(c.segundos, 12); assert.equal(c.linhas, 10);
  assert.ok(fs.existsSync(path.join(DIR, 'tv-rh.json')));
});

test('salvarConfig valida limites, lojas, setores e telas', () => {
  const c = m.salvarConfig({ lojas: [4, '1', 99], setores: ['açougue', 'Balcao', ''], segundos: 20, linhas: 8, titulo: 'Ponto', telas: { intervalos: false } }, 'tiago');
  assert.deepEqual(c.lojas, [1, 4]); assert.deepEqual(c.setores, ['ACOUGUE', 'BALCAO']);
  assert.equal(c.segundos, 20); assert.equal(c.linhas, 8); assert.equal(c.titulo, 'Ponto'); assert.equal(c.telas.intervalos, false); assert.equal(c.telas.resumo, true);
  assert.throws(() => m.salvarConfig({ segundos: 2 }), /entre 5 e 60/);
  assert.throws(() => m.salvarConfig({ linhas: 20 }), /entre 6 e 14/);
  assert.throws(() => m.salvarConfig({ lojas: [7] }), /Loja inválida/);
  assert.throws(() => m.salvarConfig({ telas: { resumo: false, entradas: false, intervalos: false, saidas: false, pendencias: false } }), /pelo menos uma tela/);
  const t = m.getConfig().token; const c2 = m.novoToken(); assert.notEqual(c2.token, t); assert.match(c2.token, /^[a-f0-9]{32}$/);
  m.salvarConfig({ lojas: [], setores: [], telas: { intervalos: true } });
});

test('entrada: antes do previsto é "ainda não chegou o horário", depois é "sem marcação" (nunca falta)', () => {
  assert.equal(m.classificar(linha({ situacao: 'aguardando' }), '06:50', 10).entrada.sit, 'aguardando');
  assert.equal(m.classificar(linha({ situacao: 'sem_marcacao' }), '07:05', 10).entrada.sit, 'aguardando');   // dentro da tolerância
  const r = m.classificar(linha({ situacao: 'sem_marcacao' }), '07:20', 10);
  assert.equal(r.entrada.sit, 'sem'); assert.equal(r.entrada.txt, 'Sem marcação'); assert.equal(r.jornada.sit, 'sem'); assert.equal(r.saida, null);
});

test('entrada no horário, atraso só confirmado pela apuração, entrada tardia sem confirmação = em apuração', () => {
  assert.equal(m.classificar(linha({ entrada: '06:58', marcacoes: ['06:58'] }), '09:00', 10).entrada.sit, 'ok');
  assert.equal(m.classificar(linha({ entrada: '07:09', marcacoes: ['07:09'] }), '09:00', 10).entrada.sit, 'ok');   // tolerância
  const cedo = m.classificar(linha({ entrada: '06:10', marcacoes: ['06:10'] }), '09:00', 10);   // 27/10: bateu 50 min antes do previsto = "Antes do horário", não "No horário"
  assert.equal(cedo.entrada.sit, 'adiantado'); assert.equal(cedo.entrada.txt, 'Antes do horário'); assert.ok(cedo.divergencias.some(d => /antes do horário/.test(d)));
  assert.equal(m.classificar(linha({ entrada: '06:51', marcacoes: ['06:51'] }), '09:00', 10).entrada.sit, 'ok', 'dentro da tolerância pra antes também');
  const ap = m.classificar(linha({ entrada: '07:25', marcacoes: ['07:25'] }), '09:00', 10);
  assert.equal(ap.entrada.sit, 'apuracao'); assert.equal(ap.jornada.sit, 'apuracao'); assert.match(ap.divergencias[0], /Entrada 07:25 · previsto 07:00/);
  const at = m.classificar(linha({ situacao: 'atraso', atraso_min: 25, entrada: '07:25', marcacoes: ['07:25'] }), '09:00', 10);
  assert.equal(at.entrada.sit, 'atraso'); assert.equal(at.entrada.txt, 'Atraso confirmado'); assert.equal(at.jornada.sit, 'atraso');
});

test('intervalo: aguardando, em intervalo, sem retorno (retorno esperado acompanha a saída real) e retornou', () => {
  const e = { entrada: '07:00', marcacoes: ['07:00'] };
  assert.equal(m.classificar(linha(e), '10:30', 10).intervalo.sit, 'aguardando');
  assert.equal(m.classificar(linha(e), '12:00', 10).intervalo.txt, 'Aguardando a saída');
  const semInt = m.classificar(linha(e), '13:30', 10); assert.equal(semInt.intervalo.sit, 'sem'); assert.deepEqual(semInt.pendencias, ['Saída e retorno do intervalo']);
  const i = { entrada: '07:00', saidaInt: '11:30', marcacoes: ['07:00', '11:30'], situacao: 'intervalo' };
  assert.equal(m.classificar(linha(i), '12:00', 10).intervalo.sit, 'intervalo');
  assert.equal(m.classificar(linha(i), '13:05', 10).intervalo.sit, 'intervalo');            // esperado 13:30 (saiu 11:30 + 2 h)
  const sr = m.classificar(linha(i), '13:45', 10); assert.equal(sr.intervalo.sit, 'sem_retorno'); assert.equal(sr.jornada.sit, 'sem_retorno'); assert.deepEqual(sr.pendencias, ['Retorno do intervalo']);
  const ok = m.classificar(linha({ entrada: '07:00', saidaInt: '11:30', retornoInt: '13:35', marcacoes: ['07:00', '11:30', '13:35'] }), '14:00', 10);
  assert.equal(ok.intervalo.sit, 'retornou'); assert.deepEqual(ok.divergencias, []);
  const tarde = m.classificar(linha({ entrada: '07:00', saidaInt: '11:00', retornoInt: '13:25', marcacoes: ['07:00', '11:00', '13:25'] }), '14:00', 10);
  assert.match(tarde.divergencias[0], /Retorno do intervalo 13:25 · esperado 13:00/);
  // sem intervalo na escala: a tela de intervalos não lista
  assert.equal(m.classificar(linha({ ...e, previsto: { folga: false, entrada: '07:00', saidaInt: null, retornoInt: null, saida: '13:00', periodos: 1 } }), '10:00', 10).intervalo, null);
});

test('saída: em jornada, saída pendente depois do previsto, jornada encerrada e saída antes do horário', () => {
  const base = { entrada: '07:00', saidaInt: '11:00', retornoInt: '13:00', marcacoes: ['07:00', '11:00', '13:00'] };
  assert.equal(m.classificar(linha(base), '16:00', 10).saida.sit, 'jornada');
  const p = m.classificar(linha(base), '17:20', 10); assert.equal(p.saida.sit, 'pendente'); assert.equal(p.jornada.sit, 'pendente'); assert.deepEqual(p.pendencias, ['Saída']);
  const f = m.classificar(linha({ ...base, saida: '17:02', marcacoes: [...base.marcacoes, '17:02'], situacao: 'ok' }), '17:30', 10);
  assert.equal(f.saida.sit, 'encerrada'); assert.equal(f.jornada.txt, 'Jornada encerrada'); assert.deepEqual(f.divergencias, []);
  const cedo = m.classificar(linha({ ...base, saida: '16:30', marcacoes: [...base.marcacoes, '16:30'], situacao: 'ok' }), '17:30', 10);
  assert.match(cedo.divergencias[0], /Saída 16:30 · previsto 17:00 · antes/);
  // só 2 marcações numa escala com intervalo: pela escala a 2ª é a saída do intervalo, então a TV mostra "em intervalo"
  // (igual ao PontoCerto) — a saída final não existe e a pendência aparece quando passar o retorno esperado
  const duas = m.classificar(linha({ entrada: '07:00', saidaInt: '17:00', marcacoes: ['07:00', '17:00'], situacao: 'intervalo' }), '17:30', 10);
  assert.equal(duas.saida.sit, 'intervalo'); assert.equal(duas.jornada.sit, 'intervalo');
});

test('folga, férias e afastados ficam fora do dia; escala não informada = em apuração; trabalho em folga vira divergência', () => {
  assert.equal(m.classificar(linha({ situacao: 'folga', previsto: { folga: true, periodos: 0 } }), '10:00', 10).foraDoDia, 'folga');
  assert.equal(m.classificar(linha({ situacao: 'ferias' }), '10:00', 10).jornada.txt, 'Férias');
  const se = m.classificar(linha({ situacao: 'sem_escala', previsto: null }), '10:00', 10); assert.equal(se.entrada.sit, 'apuracao'); assert.equal(se.entrada.txt, 'Escala não informada');
  const ft = m.classificar(linha({ situacao: 'folga_trabalhada', previsto: { folga: true, periodos: 0 }, entrada: '08:00', marcacoes: ['08:00'] }), '10:00', 10);
  assert.equal(ft.entrada.txt, 'Trabalho em folga'); assert.equal(ft.entrada.sit, 'folga_trab'); assert.equal(ft.jornada.sit, 'ok'); assert.deepEqual(ft.divergencias, ['Trabalho em dia de folga']); assert.equal(ft.saida.sit, 'jornada');
});

test('montar: filtra loja/setor, resume, ordena pelo previsto e lista as pendências por grupo', () => {
  const j = { linhas: [
    linha({ id: 1, nome: 'CARLOS', loja: 4, entrada: '07:02', saidaInt: '11:00', retornoInt: '13:00', marcacoes: ['07:02', '11:00', '13:00'] }),
    linha({ id: 2, nome: 'ANA', loja: 4, situacao: 'sem_marcacao' }),
    linha({ id: 3, nome: 'BIA', loja: 4, situacao: 'atraso', atraso_min: 20, entrada: '07:20', saidaInt: '11:05', retornoInt: '13:00', marcacoes: ['07:20', '11:05', '13:00'] }),
    linha({ id: 4, nome: 'DUDA', loja: 4, setor: 'ACOUGUE', previsto: { ...PV, entrada: '06:30' }, entrada: '06:30', saidaInt: '11:00', marcacoes: ['06:30', '11:00'] }),
    linha({ id: 5, nome: 'EVA', loja: 2, entrada: '07:00', marcacoes: ['07:00'] }),
    linha({ id: 6, nome: 'FLAVIO', loja: 4, situacao: 'folga', previsto: { folga: true, periodos: 0 } }),
  ] };
  const cfg = { lojas: [4], setores: [] };
  const r = m.montar(j, cfg, '13:30', 10);
  assert.deepEqual(r.resumo, { previstos: 4, chegaram: 3, atrasos: 1, emIntervalo: 1, saidas: 0, pendentes: 2, aguardando: 0, apuracao: 0, fora: { folga: 1, ferias: 0, afastado: 0 } });
  assert.deepEqual(r.entradas.map(l => l.nome), ['DUDA', 'ANA', 'BIA', 'CARLOS']);
  assert.deepEqual(r.intervalos.map(l => l.nome), ['BIA', 'CARLOS', 'DUDA']);   // quem já entrou e tem intervalo, na ordem do intervalo previsto (todos 11:00) e nome
  assert.deepEqual(r.saidas.map(l => l.nome), ['BIA', 'CARLOS', 'DUDA']);
  assert.deepEqual(r.pendencias.map(p => p.g + ':' + p.nome), ['sem:ANA', 'atraso:BIA', 'retorno:DUDA']);
  assert.deepEqual(r.lojas, [4]);
  assert.deepEqual(r.resumoLojas[4], r.resumo);   // uma loja só: resumo da loja = resumo da rede
  assert.equal(m.montar(j, { lojas: [], setores: ['ACOUGUE'] }, '13:30', 10).resumo.previstos, 1);
  // 27/10: resumo POR LOJA e pendência sabe a loja (a TV monta um bloco de telas por loja)
  const t = m.montar(j, { lojas: [], setores: [] }, '13:30', 10);
  assert.deepEqual(t.lojas, [2, 4]); assert.equal(t.resumo.previstos, 5);
  // EVA (loja 2) entrou 07:00 e às 13:30 não marcou o intervalo → 1 pendente na loja 2
  assert.deepEqual(t.resumoLojas[2], { previstos: 1, chegaram: 1, atrasos: 0, emIntervalo: 0, saidas: 0, pendentes: 1, aguardando: 0, apuracao: 0, fora: { folga: 0, ferias: 0, afastado: 0 } });
  assert.equal(t.resumoLojas[4].previstos, 4); assert.equal(t.resumoLojas[4].fora.folga, 1);
  assert.ok(t.pendencias.every(p => p.loja === 4));
  const l = r.entradas[0]; assert.equal(l.matricula, undefined); assert.equal(l.banco_oficial_min, undefined);   // nada além do necessário sai pra TV
});

test('payloadTV usa a jornada de hoje, renova em segundo plano e guarda o último resultado quando o PontoCerto falha', async () => {
  let n = 0;
  m.init({ dataDir: DIR, cacheMs: 0, toleranciaMin: () => 10, colaboradores: async () => ({ ativos: [] }),
    jornadaDia: async () => { n++; if (n === 2) throw new Error('PontoCerto fora'); return { linhas: [linha({ nome: 'ANA', entrada: '07:00', marcacoes: ['07:00'] })] }; } });
  const p = await m.payloadTV();
  assert.equal(p.resumo.previstos, 1); assert.equal(p.config.token, undefined); assert.equal(p.desatualizado, false); assert.equal(p.lojasTxt, 'Todas as lojas');
  await new Promise(r => setTimeout(r, 5));
  const p2 = await m.payloadTV();   // cache vencido (cacheMs 0) → devolve o que tem e renova por trás (a renovação falha e fica registrada)
  assert.equal(p2.resumo.previstos, 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(m.totais().erro, 'PontoCerto fora');
  const p3 = await m.payloadTV(); assert.equal(p3.resumo.previstos, 1);
});
