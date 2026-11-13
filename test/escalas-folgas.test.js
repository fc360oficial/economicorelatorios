'use strict';
// test/escalas-folgas.test.js — controle de folgas do 5×2 (13/11/2026):
//   · lib/escalas-folgas.js, a auditoria INDEPENDENTE que confere a escala final (não usa nenhuma conta do gerador)
//   · a correção do motor (lib/escalas-gerador.js): folga que não encosta na virada da semana, rotativa longe da fixa,
//     reposicionamento com a cobertura real — sem passar por cima de lei, restrição individual nem cobertura mínima
//   · o serviço (lib/escalas-5x2.js): a validação mostrada e a trava de aplicação saem da auditoria
// Pastas temporárias: nada aqui toca data/ nem o PontoCerto.
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-folgas-'));
process.env.ESCALAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'escalas-folgas-'));
process.env.ESCALAS_5X2_RELATORIO = '0';
const test = require('node:test'); const assert = require('node:assert/strict');
const F = require('../lib/escalas-folgas'); const G = require('../lib/escalas-gerador');
const { soma, dow, segunda } = F._util;

// ── montagem da grade "pronta" de uma pessoa: tudo trabalho de `de` a `ate`, com os dias informados por cima ──
const T = (fonte, en, sa) => ({ tipo: 'trabalho', entrada: en || '07:00', saida: sa || '17:24', almoco_ini: '11:00', almoco_fim: '13:00', fonte: fonte || 'gerado' });
const FO = (fonte, extra) => ({ tipo: 'folga', entrada: null, saida: null, fonte: fonte || 'gerado', ...(extra || {}) });
const AUS = tipo => ({ tipo, fonte: 'ausencia' });
function pessoa(id, o) {
  const dias = {}; for (let d = o.de || NOV.de; d <= (o.ate || NOV.ate); d = soma(d, 1)) dias[d] = (o.fixa != null && dow(d) === o.fixa) ? FO() : T();
  for (const [d, x] of Object.entries(o.dias || {})) { if (x === null) delete dias[d]; else dias[d] = x; }
  return { id, nome: 'Pessoa ' + id, setor: o.setor || 'CAIXA', folga_fixa: o.fixa == null ? [] : [o.fixa], duasRotativas: !!o.duasRotativas, sexo: o.sexo || null, restricoes: o.restricoes || {}, params: o.params === undefined ? { domingo: { folgaACadaSemanas: 0 } } : o.params, dom11: !!o.dom11, admissao: o.admissao || null, dias };
}
const NOV = { de: '2026-11-02', ate: '2026-11-29' };   // quatro semanas inteiras (02/11 é segunda-feira)
const DEZ = { de: '2026-12-01', ate: '2026-12-31' };   // 01/12 é terça: a 1ª semana começa em 30/11 e a última termina em 03/01/2027
const aud = (pessoas, extra) => F.auditar({ ...NOV, pessoas, ...(extra || {}) });
const sem = (a, id, seg) => a.pessoas.find(p => p.id === id).semanas.find(s => s.inicio === seg);
const oc = (a, ind) => a.ocorrencias.filter(o => o.indicador === ind);
const sabados = { '2026-11-07': FO(), '2026-11-14': FO(), '2026-11-21': FO(), '2026-11-28': FO() };   // rotativa de sábado nas 4 semanas

test('escala em ordem: uma folga fixa e uma rotativa em cada semana — tudo conferido e nenhuma ocorrência', () => {
  const a = aud([pessoa(1, { fixa: 3, dias: sabados })]); const I = a.indicadores;
  assert.deepEqual([I.semanas, I.duasFolgas, I.fixaRotativa, I.duasRotativas, I.excesso, I.falta, I.pendentesHistorico, I.abertas], [4, 4, 4, 0, 0, 0, 0, 0]);
  assert.deepEqual([I.folgasFixas, I.folgasRotativas, I.sequencias3, I.paresFixaRotativa, I.evitaveis, I.conflitos], [4, 4, 0, 0, 0, 0]); assert.deepEqual(a.ocorrencias, []);
  const s = sem(a, 1, '2026-11-09'); assert.deepEqual([s.situacao, s.folgas, s.fixas, s.rotativas, s.trabalho, s.composicao], ['duas', 2, 1, 1, 5, 'fixa_rotativa']); assert.deepEqual(s.datasFolga, ['2026-11-11', '2026-11-14']);
});

test('1. três folgas dentro da mesma semana: é EXCESSO semanal, com funcionário, semana, datas e motivo', () => {
  // quarta (fixa) + quinta + sexta de folga na semana de 09/11, e o sábado de trabalho
  const a = aud([pessoa(1, { fixa: 3, dias: { ...sabados, '2026-11-12': FO(), '2026-11-13': FO(), '2026-11-14': T() } })]); const I = a.indicadores;
  const s = sem(a, 1, '2026-11-09'); assert.deepEqual([s.situacao, s.folgas, s.fixas, s.rotativas], ['excesso', 3, 1, 2]); assert.deepEqual([I.excesso, I.duasFolgas, I.semanas], [1, 3, 4]);
  const e = oc(a, 'excesso'); assert.equal(e.length, 1); assert.equal(e[0].nome, 'Pessoa 1'); assert.deepEqual(e[0].semana, { inicio: '2026-11-09', fim: '2026-11-15' }); assert.deepEqual(e[0].datas, ['2026-11-11', '2026-11-12', '2026-11-13']); assert.match(e[0].motivo, /3 folgas na semana de 09\/11 a 15\/11 .* admite exatamente 2/);
  // a mesma ocorrência vista como sequência: fica dentro de UMA semana, e é excesso semanal (não simples virada)
  const q = oc(a, 'sequencia'); assert.equal(q.length, 1); assert.deepEqual([q[0].tamanho, q[0].natureza], [3, 'excesso_semanal']); assert.deepEqual([I.sequencias3, I.sequencias3MesmaSemana, I.sequencias3EntreSemanas, I.maiorSequencia], [1, 1, 0, 3]); assert.match(q[0].motivo, /EXCESSO semanal/);
});

test('2. três folgas consecutivas entre duas semanas: cada semana tem as suas duas, e a sequência aparece separada do excesso', () => {
  // sem folga fixa (duas rotativas autorizadas): sábado 07 + domingo 08 numa semana, segunda 09 + quinta 12 na outra
  const dias = { '2026-11-07': FO(), '2026-11-08': FO(), '2026-11-09': FO(), '2026-11-12': FO(), '2026-11-17': FO(), '2026-11-20': FO(), '2026-11-24': FO(), '2026-11-27': FO() };
  const a = aud([pessoa(2, { duasRotativas: true, dias })]); const I = a.indicadores;
  assert.deepEqual([I.semanas, I.duasFolgas, I.duasRotativas, I.excesso, I.falta], [4, 4, 4, 0, 0], 'nenhuma semana com folga a mais ou a menos');
  assert.deepEqual([I.sequencias3, I.sequencias3EntreSemanas, I.sequencias3MesmaSemana, I.pessoasComSequencia], [1, 1, 0, 1]);
  const q = oc(a, 'sequencia')[0]; assert.deepEqual(q.datas, ['2026-11-07', '2026-11-08', '2026-11-09']); assert.equal(q.natureza, 'entre_semanas'); assert.deepEqual(q.semanas, ['2026-11-02', '2026-11-09']); assert.match(q.motivo, /sequência ENTRE semanas: cada semana tem as suas 2 folgas/);
  // evitável: há outro dia da mesma semana para uma das rotativas — e aplicar a alternativa acaba com a sequência
  assert.equal(q.evitavel, true); assert.deepEqual([I.evitaveis, I.evitaveis3, I.evitaveisPares], [1, 1, 0]); assert.equal(oc(a, 'evitavel').length, 1);
  const alt = q.alternativa; assert.equal(segunda(alt.de), segunda(alt.para), 'a folga só muda de dia dentro da mesma semana');
  const b = aud([pessoa(2, { duasRotativas: true, dias: { ...dias, [alt.de]: T(), [alt.para]: FO() } })]); assert.deepEqual([b.indicadores.sequencias3, b.indicadores.duasFolgas, b.indicadores.evitaveis], [0, 4, 0]);
  // NÃO evitável quando a cobertura mínima não deixa: sozinha no setor, qualquer outro dia de folga deixaria o caixa sem ninguém
  const c = aud([pessoa(2, { duasRotativas: true, dias })], { cobertura: { abre: '07:00', fecha: '17:00', setores: { CAIXA: { min: 1 } } } }); const qc = oc(c, 'sequencia')[0];
  assert.equal(qc.evitavel, false); assert.match(qc.motivo, /Sem alternativa válida na semana: a cobertura mínima do setor não deixa a folga ir para/); assert.deepEqual([c.indicadores.evitaveis, c.indicadores.inevitaveis], [0, 1]);
  // NÃO evitável quando o limite de dias seguidos não deixa (regra com no máximo 3 dias seguidos de trabalho)
  const d = aud([pessoa(2, { duasRotativas: true, params: { maxDiasConsecutivos: 3 }, dias: { '2026-11-07': FO(), '2026-11-08': FO(), '2026-11-09': FO(), '2026-11-13': FO(), '2026-11-17': FO(), '2026-11-21': FO(), '2026-11-25': FO(), '2026-11-29': FO(), '2026-11-03': FO() } })]);
  assert.ok(oc(d, 'sequencia').every(x => !x.evitavel || x.alternativa), 'com alternativa só quando ela respeita o limite');
});

test('3. folga fixa e rotativa consecutivas: par acusado à parte (não é sequência de 3), com alternativa quando existe', () => {
  // fixa quarta 11/11 + rotativa quinta 12/11
  const a = aud([pessoa(3, { fixa: 3, dias: { ...sabados, '2026-11-14': T(), '2026-11-12': FO() } })]); const I = a.indicadores;
  assert.deepEqual([I.paresFixaRotativa, I.sequencias3, I.duasFolgas, I.evitaveis, I.evitaveisPares], [1, 0, 4, 1, 1]);
  const p = oc(a, 'fixa_rotativa')[0]; assert.deepEqual(p.datas, ['2026-11-11', '2026-11-12']); assert.match(p.motivo, /Folga rotativa colada na folga fixa: 11\/11 qua \(F\) · 12\/11 qui \(FR\)/); assert.equal(p.evitavel, true); assert.equal(p.alternativa.de, '2026-11-12', 'quem muda é a rotativa — a fixa fica no dia dela');
  assert.ok(!['2026-11-10', '2026-11-12'].includes(p.alternativa.para), 'a alternativa não encosta na fixa de novo');
  // a virada também conta: rotativa no domingo colada na fixa de segunda
  const v = aud([pessoa(4, { fixa: 1, dias: { '2026-11-08': FO(), '2026-11-14': FO(), '2026-11-21': FO(), '2026-11-28': FO(), '2026-11-06': FO() } })]);
  assert.equal(sem(v, 4, '2026-11-02').situacao, 'excesso'); const pv = oc(v, 'fixa_rotativa')[0]; assert.deepEqual(pv.datas, ['2026-11-08', '2026-11-09']); assert.deepEqual(pv.semanas, ['2026-11-02', '2026-11-09']);
  // duas rotativas juntas (modelo flexível, sem folga fixa) continuam válidas e não são ocorrência
  const f = aud([pessoa(5, { duasRotativas: true, dias: { '2026-11-05': FO(), '2026-11-06': FO(), '2026-11-12': FO(), '2026-11-13': FO(), '2026-11-19': FO(), '2026-11-20': FO(), '2026-11-26': FO(), '2026-11-27': FO() } })]);
  assert.deepEqual([f.indicadores.duasFolgas, f.indicadores.paresFixaRotativa, f.indicadores.sequencias3], [4, 0, 0]); assert.deepEqual(f.ocorrencias, []);
});

test('4. semana que atravessa dois meses (e dois anos): os dias do mês vizinho entram na conta e na sequência', () => {
  // dezembro/2026, folga fixa na segunda. Novembro (histórico do ponto): domingo 29 e segunda 30 de folga.
  const hist = {}; for (let d = '2026-11-03'; d <= '2026-11-30'; d = soma(d, 1)) hist[d] = { ...T('historico'), fonte: 'historico' }; hist['2026-11-29'] = FO('historico'); hist['2026-11-30'] = FO('historico'); hist['2026-11-23'] = FO('historico'); hist['2026-11-26'] = FO('historico');
  const rot = { '2026-12-01': FO(), '2026-12-10': FO(), '2026-12-17': FO(), '2026-12-24': FO(), '2026-12-31': FO() };
  const base = () => pessoa(6, { ...DEZ, fixa: 1, dias: { ...hist, ...rot } });
  const a = F.auditar({ ...DEZ, pessoas: [base()] }); assert.deepEqual(a.semanas.map(s => s.inicio), ['2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']); assert.deepEqual(a.semanas.map(s => s.cruza), [true, false, false, false, true]);
  // 30/11 (novembro) + 01/12 (dezembro) = duas folgas da MESMA semana
  const s1 = sem(a, 6, '2026-11-30'); assert.deepEqual([s1.situacao, s1.folgas, s1.fixas, s1.rotativas, s1.cruza], ['duas', 2, 1, 1, true]); assert.deepEqual(s1.datasFolga, ['2026-11-30', '2026-12-01']);
  // e a sequência 29/11 · 30/11 · 01/12 atravessa o mês: os dois primeiros dias já ocorreram, a rotativa de 01/12 pode mudar
  const q = oc(a, 'sequencia')[0]; assert.deepEqual(q.datas, ['2026-11-29', '2026-11-30', '2026-12-01']); assert.equal(q.natureza, 'entre_semanas'); assert.match(q.motivo, /29\/11 dom \(FR, já ocorrido\) · 30\/11 seg \(F, já ocorrido\) · 01\/12 ter \(FR\)/); assert.equal(q.evitavel, true); assert.equal(q.alternativa.de, '2026-12-01');
  // a última semana vai até 03/01/2027: sem os dias de janeiro ela NÃO sai como válida — fica "em aberto"
  const s5 = sem(a, 6, '2026-12-28'); assert.equal(s5.situacao, 'pendente_historico', 'sem nenhum dado de janeiro não há o que afirmar'); assert.deepEqual(s5.pendentes, ['2027-01-01', '2027-01-02', '2027-01-03']);
  const prev = base(); for (const d of ['2027-01-01', '2027-01-02', '2027-01-03']) prev.dias[d] = { ...T('previsto') };
  const b = F.auditar({ ...DEZ, pessoas: [prev] }); assert.equal(sem(b, 6, '2026-12-28').situacao, 'aberta'); assert.match(sem(b, 6, '2026-12-28').motivo, /termina depois de 31\/12: 2 folga\(s\) até o fim do período; os dias seguintes \(01\/01, 02\/01, 03\/01\) ainda são previsão/); assert.deepEqual([b.indicadores.abertas, b.indicadores.duasFolgas], [1, 4]);
  // com a grade de janeiro já existente (dado real), a mesma semana de dois anos é conferida inteira
  const jan = base(); for (const d of ['2027-01-01', '2027-01-02', '2027-01-03']) jan.dias[d] = { ...T('grade') };
  const c = F.auditar({ ...DEZ, pessoas: [jan] }); assert.deepEqual([sem(c, 6, '2026-12-28').situacao, sem(c, 6, '2026-12-28').folgas, c.indicadores.duasFolgas, c.indicadores.abertas], ['duas', 2, 5, 0]);
  // três folgas na virada do ano: quinta 31/12 (rotativa) + sexta 01/01 + sábado 02/01 já na grade de janeiro = excesso da semana 28/12–03/01
  const ano = base(); ano.dias['2027-01-01'] = FO('grade'); ano.dias['2027-01-02'] = FO('grade'); ano.dias['2027-01-03'] = T('grade');
  const e = F.auditar({ ...DEZ, pessoas: [ano] }); assert.equal(sem(e, 6, '2026-12-28').situacao, 'excesso'); assert.equal(sem(e, 6, '2026-12-28').folgas, 4); assert.deepEqual(oc(e, 'sequencia').map(x => x.datas).pop(), ['2026-12-31', '2027-01-01', '2027-01-02']);
});

test('5. histórico insuficiente: a semana não é dada como válida — fica pendente, dizendo quais dias faltam', () => {
  // folga fixa na quinta; rotativas em 01/12 e nas segundas; janeiro já na grade. (a) sem nenhum registro de 30/11
  const rot = { '2026-12-01': FO(), '2026-12-07': FO(), '2026-12-14': FO(), '2026-12-21': FO(), '2026-12-28': FO(), '2027-01-01': T('grade'), '2027-01-02': T('grade'), '2027-01-03': T('grade') };
  const a = F.auditar({ ...DEZ, pessoas: [pessoa(7, { ...DEZ, fixa: 4, dias: rot })] });
  const s = sem(a, 7, '2026-11-30'); assert.equal(s.situacao, 'pendente_historico'); assert.deepEqual(s.pendentes, ['2026-11-30']); assert.match(s.motivo, /Sem dado ou sem confirmação do ponto em 30\/11: não dá para afirmar quantas folgas/);
  assert.deepEqual([a.indicadores.pendentesHistorico, a.indicadores.duasFolgas, a.indicadores.semanas], [1, 4, 5]); const o = oc(a, 'pendente')[0]; assert.deepEqual([o.nome, o.semana.inicio, o.datas.join()], ['Pessoa 7', '2026-11-30', '2026-11-30']);
  // (b) planejado sem confirmação do ponto e (c) jornada prevista sem marcação ("indefinido"): também não dá para afirmar
  for (const dia of [{ ...T('historico'), naoConfirmado: true }, { tipo: 'indefinido', fonte: 'historico' }]) {
    const b = F.auditar({ ...DEZ, pessoas: [pessoa(7, { ...DEZ, fixa: 4, dias: { '2026-11-30': dia, '2026-12-01': FO() } })] }); assert.equal(sem(b, 7, '2026-11-30').situacao, 'pendente_historico'); }
  // (d) com o dia confirmado a mesma semana fecha em duas folgas; (e) folga a mais continua sendo excesso mesmo faltando histórico
  const d = F.auditar({ ...DEZ, pessoas: [pessoa(7, { ...DEZ, fixa: 4, dias: { '2026-11-30': T('historico'), '2026-12-01': FO() } })] }); assert.deepEqual([sem(d, 7, '2026-11-30').situacao, sem(d, 7, '2026-11-30').folgas], ['duas', 2]);
  const e = F.auditar({ ...DEZ, pessoas: [pessoa(7, { ...DEZ, fixa: 4, dias: { '2026-12-01': FO(), '2026-12-02': FO() } })] }); assert.equal(sem(e, 7, '2026-11-30').situacao, 'excesso');
});

test('6. funcionário afastado ou de férias: ausência não é folga, não entra em sequência e a semana fica à parte', () => {
  const p = pessoa(8, { duasRotativas: true, dias: { '2026-11-07': FO(), '2026-11-08': FO(),
    '2026-11-09': AUS('ferias'), '2026-11-10': AUS('ferias'), '2026-11-11': AUS('ferias'), '2026-11-12': AUS('ferias'), '2026-11-13': AUS('ferias'), '2026-11-15': FO(),   // semana 2: 5 dias de férias, sábado de trabalho, domingo de folga
    '2026-11-16': AUS('afastado'), '2026-11-17': AUS('afastado'), '2026-11-18': AUS('afastado'), '2026-11-19': AUS('afastado'), '2026-11-20': AUS('afastado'), '2026-11-21': AUS('afastado'), '2026-11-22': AUS('afastado'),   // semana 3 inteira afastada
    '2026-11-23': AUS('ferias'), '2026-11-24': AUS('ferias') } });   // semana 4: dois dias de férias e NENHUMA folga
  const a = aud([p]); const I = a.indicadores;
  const s2 = sem(a, 8, '2026-11-09'); assert.deepEqual([s2.situacao, s2.folgas, s2.ausencias, s2.exigidas, s2.trabalho], ['ausencia', 1, 5, 1, 1]); assert.match(s2.motivo, /1 folga\(s\) e 5 dia\(s\) de férias\/afastamento .* as ausências não contam como folga/);
  assert.equal(sem(a, 8, '2026-11-16').situacao, 'ausente'); assert.equal(sem(a, 8, '2026-11-16').folgas, 0, 'sete dias de afastamento não são sete folgas');
  const s4 = sem(a, 8, '2026-11-23'); assert.deepEqual([s4.situacao, s4.folgas, s4.exigidas], ['falta', 0, 1]); assert.match(s4.motivo, /nenhuma folga na semana de 23\/11 a 29\/11 — o 5×2 exige 1 nesta semana \(há 2 dia\(s\) de férias\/afastamento, que não contam como folga\)/);
  assert.deepEqual([I.semanas, I.duasFolgas, I.ausencia, I.falta, I.excesso], [3, 1, 1, 1, 0], 'a semana inteira de afastamento fica fora da conta');
  // sábado 07 + domingo 08 de folga e férias de segunda a sexta: são 2 dias de folga seguidos, não 7 — férias não viram descanso da sequência
  assert.deepEqual([I.sequencias3, I.maiorSequencia], [0, 0]); assert.equal(oc(a, 'sequencia').length, 0);
});

test('7. folgas em domingos e feriados: contam como folga da semana conforme a regra, e o descanso dominical é conferido', () => {
  const feriados = ['2026-11-15', '2026-11-20'];
  // quarta fixa; domingo 08/11 de folga rotativa; sexta 20/11 feriado FOLGADO lançado na grade
  const dias = { '2026-11-08': FO(), '2026-11-14': FO(), '2026-11-20': { tipo: 'feriado', fonte: 'fixo' }, '2026-11-28': FO() };
  const a = aud([pessoa(9, { fixa: 3, dias })], { feriados }); const s1 = sem(a, 9, '2026-11-02'), s3 = sem(a, 9, '2026-11-16');
  assert.deepEqual([s1.situacao, s1.fixas, s1.rotativas], ['duas', 1, 1]); assert.equal(s1.dias[6].domingo, true); assert.equal(s1.dias[6].folga, 'FR', 'a folga do domingo é a rotativa da semana');
  assert.deepEqual([s3.situacao, s3.folgas, s3.rotativas], ['duas', 2, 1], 'regra padrão: feriado folgado conta como uma das folgas'); assert.equal(s3.dias[4].feriado, true); assert.equal(a.indicadores.duasFolgas, 4);
  // regra "feriado é descanso à parte": deixa de ser folga da semana (a semana fica com uma folga e um dia à parte)
  const b = aud([pessoa(9, { fixa: 3, dias, params: { feriado: { folgado: 'a_parte' } } })], { feriados }); assert.deepEqual([sem(b, 9, '2026-11-16').situacao, sem(b, 9, '2026-11-16').folgas, sem(b, 9, '2026-11-16').ausencias, sem(b, 9, '2026-11-16').exigidas], ['falta', 1, 1, 2], 'o feriado à parte não é folga: a semana ainda deve a segunda folga');
  // folga fixa no domingo: a folga de domingo é a FIXA
  const c = aud([pessoa(10, { fixa: 0, dias: { '2026-11-05': FO(), '2026-11-12': FO(), '2026-11-19': FO(), '2026-11-26': FO() } })]); assert.deepEqual([c.indicadores.duasFolgas, c.indicadores.fixaRotativa, sem(c, 10, '2026-11-02').dias[6].folga], [4, 4, 'F']);
  // descanso dominical: 3 domingos seguidos de trabalho (regra: folga a cada 3 semanas) e, para a trabalhadora, 2 seguidos (art. 386)
  const trab = { '2026-11-03': FO(), '2026-11-06': FO(), '2026-11-10': FO(), '2026-11-13': FO(), '2026-11-17': FO(), '2026-11-20': FO(), '2026-11-24': FO(), '2026-11-27': FO() };
  const DOM3 = { domingo: { folgaACadaSemanas: 3 } };
  const d = aud([pessoa(11, { duasRotativas: true, params: DOM3, dias: trab }), pessoa(12, { duasRotativas: true, sexo: 'F', params: DOM3, dias: trab })]); const cf = id => a => a.ocorrencias.filter(o => o.indicador === 'conflito' && o.funcId === id).map(o => o.codigo + ' ' + o.datas[0]);
  assert.deepEqual(cf(11)(d), ['domingo_sem_folga 2026-11-22', 'domingo_sem_folga 2026-11-29']); assert.deepEqual(cf(12)(d), ['domingo_art386 2026-11-15', 'domingo_art386 2026-11-22', 'domingo_art386 2026-11-29']); assert.equal(d.indicadores.conflitos, 5);
  // a folga de domingo que sustenta o revezamento NÃO é dada como "evitável": sábado (fixa) · domingo 15 (rotativa) · segunda 16 (folga lançada à mão)
  const e = aud([pessoa(13, { fixa: 6, params: DOM3, dias: { '2026-11-04': FO(), '2026-11-15': FO(), '2026-11-16': FO('fixo'), '2026-11-25': FO() } })]); const q = oc(e, 'sequencia')[0];
  assert.deepEqual(q.datas, ['2026-11-14', '2026-11-15', '2026-11-16']); assert.equal(q.evitavel, false); assert.match(q.motivo, /Sem alternativa válida na semana: .*feriria o descanso dominical/);
  // sem o revezamento dominical na regra, a mesma folga de domingo pode ir para outro dia da semana
  const g = aud([pessoa(13, { fixa: 6, params: { domingo: { folgaACadaSemanas: 0 } }, dias: { '2026-11-04': FO(), '2026-11-15': FO(), '2026-11-16': FO('fixo'), '2026-11-25': FO() } })]); assert.equal(oc(g, 'sequencia')[0].evitavel, true); assert.equal(oc(g, 'sequencia')[0].alternativa.de, '2026-11-15');
});

test('jornada: dias seguidos, interjornada, descanso com a folga e folga com horário são conferidos na grade final', () => {
  // 8 dias seguidos de trabalho (02 a 09/11)
  const a = aud([pessoa(14, { duasRotativas: true, dias: { '2026-11-10': FO(), '2026-11-11': FO(), '2026-11-17': FO(), '2026-11-20': FO(), '2026-11-24': FO(), '2026-11-27': FO() } })]);
  assert.deepEqual(oc(a, 'conflito').map(o => o.codigo + ' ' + o.datas[0]), ['dias_consecutivos 2026-11-08']); assert.equal(sem(a, 14, '2026-11-02').situacao, 'falta');
  // sai às 22:00 e entra às 07:00 (9 h); folga com horário lançado; volta da folga com menos de 35 h
  const b = aud([pessoa(15, { fixa: 3, dias: { ...sabados, '2026-11-02': T('gerado', '11:36', '22:00'), '2026-11-07': { ...FO(), entrada: '07:00', saida: '12:00' }, '2026-11-10': T('gerado', '13:36', '23:59'), '2026-11-12': T('gerado', '05:00', '15:24') } })]);
  assert.deepEqual(oc(b, 'conflito').map(o => o.codigo + ' ' + o.datas[0]).sort(), ['descanso_semanal 2026-11-12', 'interjornada 2026-11-03', 'jornada_em_folga 2026-11-07']);
});

// ═══ o motor corrigido ═══
const base44 = () => { const b = {}; for (let d = 1; d <= 6; d++) b[d] = { entrada: '07:00', saida: '16:20', almoco_ini: '11:00', almoco_fim: '13:00' }; b[0] = null; return b; };
const func = (id, setor, folga, extra) => ({ id, nome: 'Func ' + id, setor, estabelecimento: 1, categoria: 'COMERCIARIO', folga_fixa: folga, base: base44(), ...extra });
const REGRA = { id: 'CCT-TESTE', estabelecimento: 1, vigencia: { de: '2026-01-01', ate: '2027-12-31' }, validada: true, params: {} };
const SEM_DOM = { ...REGRA, params: { domingo: { folgaACadaSemanas: 0 } } };
const COB = { abre: '07:00', fecha: '19:00', entradas: ['07:00', '08:36'], setores: { CAIXA: { min: 2 }, REPOSICAO: { min: 1 } } };
/** Audita o resultado do motor só pelos DIAS que ele devolveu (mais o histórico e a semana em aberto). */
function auditarGerado(r, funcs, regras, extra) {
  return F.auditar(F.entrada({ de: r.periodo.de, ate: r.periodo.ate, funcionarios: funcs.map(f => ({ ...f, folga_fixa: f.folga_fixa == null ? [] : [].concat(f.folga_fixa) })), dias: Object.fromEntries(r.proposta.map(p => [p.id, p.dias])), historico: (extra || {}).historico || {},
    depois: Object.fromEntries(Object.entries(r.continuidade).map(([id, c]) => [id, c.semanaAberta || {}])), paramsDe: f => G.regraPara(regras, f, r.periodo.de).params, cobertura: (extra || {}).cobertura || COB }));
}

test('motor: a folga não encosta mais na virada da semana — nenhuma sequência de 3 ou mais em dois meses seguidos, com e sem folga fixa', () => {
  const funcs = [func(1, 'CAIXA', 1), func(2, 'CAIXA', 2), func(3, 'CAIXA', 3), func(4, 'CAIXA', 4), func(5, 'CAIXA', 5), func(6, 'CAIXA', 6), func(7, 'CAIXA', null, { duasRotativas: true }), func(8, 'CAIXA', null),
    func(9, 'REPOSICAO', 2), func(10, 'REPOSICAO', 4), func(11, 'REPOSICAO', 6), func(12, 'REPOSICAO', null, { duasRotativas: true }), func(13, 'GERENCIA', 6), func(14, 'GERENCIA', 6)];
  const NOV30 = { de: '2026-11-02', ate: '2026-11-30' };   // até a segunda 30/11: dezembro recebe a semana 30/11–06/12 já começada
  const nov = G.gerar({ ...NOV30, funcionarios: funcs, regras: [REGRA], cobertura: COB }); const dez = G.gerar({ ...DEZ, funcionarios: funcs, regras: [REGRA], cobertura: COB, historico: nov.continuidade });
  for (const [r, hist] of [[nov, {}], [dez, nov.continuidade]]) { const a = auditarGerado(r, funcs, [REGRA], { historico: hist }); const I = a.indicadores;
    assert.deepEqual([I.sequencias3, I.evitaveis, I.excesso, I.falta, I.fixaForaDoDia, I.pendentesHistorico], [0, 0, 0, 0, 0, 0], r.periodo.de + ': ' + JSON.stringify(a.ocorrencias.filter(o => o.indicador !== 'fixa_rotativa').slice(0, 3)));
    assert.equal(I.duasFolgas + I.abertas, I.semanas, 'toda semana fechada tem exatamente duas folgas'); assert.deepEqual(r.conflitos.trabalhistas.filter(c => c.gravidade === 'bloqueio'), []);
    // a conta do gerador e a da auditoria batem semana a semana
    for (const p of r.proposta) for (const s of p.semanas) { const w = a.pessoas.find(x => x.id === p.id).semanas.find(x => x.inicio === s.inicio); assert.equal(w.folgas, s.regra52.folgas, p.nome + ' ' + s.inicio); }
    // a folga fixa ficou sempre no dia definido
    for (const p of r.proposta) for (const [d, x] of Object.entries(p.dias)) if (p.folga_fixa.includes(dow(d))) assert.deepEqual([x.tipo, x.folga], ['folga', 'fixa'], p.nome + ' ' + d); }
  // quem não tem folga fixa era o caso típico (domingo + segunda + terça): agora, no máximo dois dias seguidos em todo o bimestre
  for (const id of [7, 8, 12]) { const tudo = { ...nov.proposta.find(p => p.id === id).dias, ...dez.proposta.find(p => p.id === id).dias }; let run = 0, maior = 0; for (const d of Object.keys(tudo).sort()) { run = tudo[d].tipo === 'folga' ? run + 1 : 0; maior = Math.max(maior, run); } assert.ok(maior <= 2, 'func ' + id + ': ' + maior + ' folgas seguidas'); }
});

test('motor: a vizinhança vem do histórico — quem folgou sábado e domingo antes do início não recebe a folga na segunda', () => {
  const f = [func(1, 'GERENCIA', null, { duasRotativas: true })]; const h = { 1: { dias: { '2026-10-30': { tipo: 'trabalho', entrada: '07:00', saida: '17:24' }, '2026-10-31': { tipo: 'folga' }, '2026-11-01': { tipo: 'folga' } } } };
  const r = G.gerar({ ...NOV, funcionarios: f, regras: [SEM_DOM], historico: h }); const d = r.proposta[0].dias;
  assert.equal(d['2026-11-02'].tipo, 'trabalho', 'segunda 02/11 de trabalho: sábado 31/10 e domingo 01/11 já foram de folga'); const a = auditarGerado(r, f, [SEM_DOM], { historico: h, cobertura: {} }); assert.deepEqual([a.indicadores.sequencias3, a.indicadores.duasFolgas], [0, 4]);
  // e a folga fixa de segunda ao lado do descanso dominical obrigatório: o par é inevitável (lei + folga fixa) e a terça fica de trabalho
  const g = [func(2, 'GERENCIA', 1)]; const rg = G.gerar({ ...NOV, funcionarios: g, regras: [{ ...REGRA, params: { domingo: { folgaACadaSemanas: 1 } } }] }); const ag = auditarGerado(rg, g, [{ ...REGRA, params: { domingo: { folgaACadaSemanas: 1 } } }], { cobertura: {} });
  assert.deepEqual([ag.indicadores.sequencias3, ag.indicadores.evitaveis], [0, 0]); assert.ok(ag.indicadores.paresFixaRotativa >= 3, 'domingo (descanso dominical) + segunda (fixa): colado, mas sem alternativa'); assert.match(oc(ag, 'fixa_rotativa')[0].motivo, /Sem alternativa válida|protegidos/);
  for (const d2 of ['2026-11-10', '2026-11-17', '2026-11-24']) assert.equal(rg.proposta[0].dias[d2].tipo, 'trabalho');
});

test('motor: a preferência por folgas separadas não passa por cima da cobertura mínima, e a auditoria explica por quê', () => {
  // setor de 2: A folga fixa segunda, B folga fixa quinta; de quarta a domingo o setor precisa dos dois o dia inteiro
  const dupla = [func(1, 'BALCAO', 1), func(2, 'BALCAO', 4)]; const pico = { abre: '07:00', fecha: '19:00', setores: { BALCAO: { min: 0, faixas: [3, 4, 5, 6, 0].map(d => ({ dias: [d], ini: '07:00', fim: '19:00', min: 2 })) } } };
  const r = G.gerar({ ...NOV, funcionarios: dupla, regras: [SEM_DOM], cobertura: pico }); const pa = r.proposta.find(p => p.id === 1);
  for (const sg of ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']) assert.deepEqual([pa.dias[sg].folga, pa.dias[soma(sg, 1)].folga], ['fixa', 'rotativa'], 'a rotativa de A fica na terça, colada na fixa: é o único dia em que o setor não fica descoberto');
  const a = auditarGerado(r, dupla, [SEM_DOM], { cobertura: pico }); const pares = oc(a, 'fixa_rotativa').filter(o => o.funcId === 1);
  assert.equal(pares.length, 4); for (const p of pares) { assert.equal(p.evitavel, false); assert.match(p.motivo, /cobertura mínima do setor não deixa a folga ir para/); } assert.equal(a.indicadores.evitaveis, 0);
});

test('motor: reposicionamento — quando a estimativa de cobertura segurou a folga colada e a cobertura real permite, a rotativa muda de dia', () => {
  // setor com mínimo de 1 pessoa das 09:00 às 16:00. A e B abrem (07:00); C e D fecham (08:36). B só trabalha segunda e terça
  // (restrição individual), então de quarta a domingo A é o único da abertura: o motor evita deixar o turno sem ninguém e
  // encosta a rotativa de A na folga fixa de segunda. Com a semana montada, C e D cobrem das 09:00 às 16:00 — a folga pode sair de lá.
  const cob = { abre: '07:00', fecha: '19:00', setores: { PADARIA: { min: 0, faixas: [{ dias: [0, 1, 2, 3, 4, 5, 6], ini: '09:00', fim: '16:00', min: 1 }] } } };
  const fs4 = [func(1, 'PADARIA', 1, { entrada: '07:00' }), func(2, 'PADARIA', null, { entrada: '07:00', duasRotativas: true, restricoes: { naoTrabalha: [3, 4, 5, 6, 0] } }), func(3, 'PADARIA', 2, { entrada: '08:36' }), func(4, 'PADARIA', 2, { entrada: '08:36', duasRotativas: false, folga_fixa: 4 })];
  const r = G.gerar({ ...NOV, funcionarios: fs4, regras: [SEM_DOM], cobertura: cob }); const pa = r.proposta.find(p => p.id === 1); const rep = r.conflitos.operacionais.filter(c => c.codigo === 'folga_reposicionada' && c.funcId === 1);
  assert.ok(rep.length >= 1, 'houve reposicionamento: ' + JSON.stringify(Object.entries(pa.dias).filter(([, x]) => x.tipo === 'folga').map(([d, x]) => d.slice(5) + x.folga))); assert.equal(r.distribuicaoFolgas.reposicionadas, r.conflitos.operacionais.filter(c => c.codigo === 'folga_reposicionada').length);
  assert.match(rep[0].texto, /folga rotativa de \d\d\/\d\d \(terça\) passou para \d\d\/\d\d .* para não ficar colada na folga fixa — cobertura do setor e descansos conferidos/);
  for (const c of rep) { const [de, para] = c.dias; assert.equal(pa.dias[de].tipo, 'trabalho'); assert.deepEqual([pa.dias[para].tipo, pa.dias[para].folga, pa.dias[para].reposicionada], ['folga', 'rotativa', de]); assert.equal(segunda(de), segunda(para));
    // o dia que virou folga não ficou abaixo do mínimo; o dia que voltou a ser trabalho tem jornada completa e intervalo
    assert.equal(r.cobertura.dias.find(x => x.data === para).setores.find(s => s.setor === 'PADARIA').blocos_abaixo, 0); assert.ok(pa.dias[de].entrada && pa.dias[de].almoco_ini); }
  // a semana de A continua com exatamente duas folgas, a fixa no dia dela, e sem conflito trabalhista novo
  for (const s of pa.semanas) assert.deepEqual([s.regra52.folgas, s.regra52.fixas, s.regra52.rotativas, s.trabalho], [2, 1, 1, 5]); assert.deepEqual(r.conflitos.trabalhistas.filter(c => c.funcId === 1), []);
  const a = auditarGerado(r, fs4, [SEM_DOM], { cobertura: cob }); assert.equal(a.ocorrencias.filter(o => o.funcId === 1 && o.indicador === 'evitavel').length, 0);
});

test('motor: a preferência nova não tira da trabalhadora o domingo de descanso (art. 386), mesmo com o 1×1 desligado', () => {
  const eq = [func(1, 'GERENCIA', 6, { sexo: 'F' }), func(2, 'GERENCIA', 1, { sexo: 'F' }), func(3, 'GERENCIA', null, { sexo: 'F', duasRotativas: true }), func(4, 'GERENCIA', 3, { sexo: 'M' })];
  const nov = G.gerar({ de: '2026-11-02', ate: '2026-11-30', funcionarios: eq, regras: [REGRA], dominicalFeminino: { ativo: false } }); const dez = G.gerar({ ...DEZ, funcionarios: eq, regras: [REGRA], historico: nov.continuidade, dominicalFeminino: { ativo: false } });
  for (const r of [nov, dez]) assert.deepEqual(r.conflitos.trabalhistas.filter(c => c.codigo === 'domingo_art386'), [], 'nenhuma trabalhadora com dois domingos seguidos de trabalho');
  const a = auditarGerado(dez, eq, [REGRA], { historico: nov.continuidade, cobertura: {} }); assert.deepEqual([a.indicadores.sequencias3, a.indicadores.conflitos], [0, 0]);
});

// ═══ o serviço: a validação mostrada e a trava de aplicação saem da auditoria ═══
test('serviço: simular devolve a auditoria independente, a semana que termina em janeiro deixa de sair como "válida" e a conta bate com a do gerador', () => {
  const GP = require('../lib/gestao-pessoas'); const S = require('../lib/escalas-5x2'); const E = require('../lib/escalas');
  GP.salvarConfig({ designados: [{ usuario: 'rh', nome: 'RH', papeis: ['rh_ponto'] }, { usuario: 'co', nome: 'Co', papeis: ['coordenacao'] }] }, { usuario: 'adm', perfil: 'admin' }); const rh = { usuario: 'rh', nome: 'RH Ponto' };
  const J = [{ entrada: '07:00', saida: '11:00' }, { entrada: '13:00', saida: '17:48' }]; const escalasPC = new Map([[10, { id: 10, nome: 'SEG-SEX 44H', dias: { 1: J, 2: J, 3: J, 4: J, 5: J } }]]);
  const nomes = ['Ana Lima', 'Bruno Sá', 'Carla Reis', 'Davi Melo', 'Eva Rocha', 'Fábio Luz', 'Gil Costa', 'Hugo Paz'];
  const colabs = { ativos: nomes.map((n, i) => ({ id: 101 + i, nome: n, loja: 1, setor: i < 5 ? 'CAIXA' : 'REPOSITOR', cargo: 'x', matricula: String(i + 1), turno: 'SEG-SEX 44H', turno_id: 10 })), desligados: [] };
  const ctx = { colabs, escalasPC, afast: new Map([['ANA LIMA', [{ nome: 'ANA LIMA', inicio: '2026-12-07', fim: '2026-12-16', ferias: true }]]]), afastAnt: new Map(), hoje: '2026-11-11' };
  const s = S.simular(rh, 1, '2026-12', ctx); const I = s.folgas.indicadores, r = s.resultado;
  assert.deepEqual(fs.readdirSync(process.env.ESCALAS_DIR), [], 'continua em simulação: nada gravado');
  assert.deepEqual(s.folgas.divergencias, [], 'a conta do gerador e a da auditoria batem'); assert.deepEqual([I.pessoas, I.semanas, I.excesso, I.falta, I.sequencias3, I.evitaveis], [8, 39, 0, 0, 0, 0], 'a semana inteira de férias da Ana fica fora da conta');
  assert.deepEqual([I.abertas, I.ausencia, I.duasFolgas], [8, 1, 30], '8 semanas terminam em 03/01 (em aberto) e 1 tem parte das férias da Ana');
  assert.ok(!s.aplicacao.pendencias.some(p => /^auditoria/.test(p.codigo)));
  // a última semana de cada pessoa: antes saía "verde/válida" só com a previsão do gerador; agora é cinza, com o motivo
  for (const p of r.proposta) { const u = p.semanas[p.semanas.length - 1]; assert.equal(u.inicio, '2026-12-28'); assert.equal(u.validacao.nivel, 'cinza'); const it = u.validacao.itens.find(i => i.codigo === 'auditoria_aberta'); assert.ok(it && it.auditoria); assert.match(it.texto, /termina depois de 31\/12/); assert.equal(s.folgas.semanas[p.id]['2026-12-28'].situacao, 'aberta'); }
  assert.deepEqual(r.validacaoSemanal, { semanas: 40, verde: 30, amarelo: 0, vermelho: 0, cinza: 10 });
  // cada semana da auditoria traz as datas das folgas (é o que a tela lista ao clicar no indicador)
  const w = s.folgas.semanas[102]['2026-12-07']; assert.deepEqual([w.situacao, w.folgas, w.datas.length], ['duas', 2, 2]);
  // a grade gravada passa pela mesma conferência: aplicada a geração, uma folga lançada à mão que fecha 3 dias seguidos aparece em Validar
  S.salvarRegra(rh, { nome: 'CCT teste', estabelecimento: 1, vigencia: { de: '2026-01-01' }, baseLegal: 'x', params: { metaSemanalMin: 2520, intervaloMin: 120 }, justificativa: 'cadastro inicial' }); S.validarRegra(rh, S.listarRegras()[0].id, 'conferido com a convenção coletiva');
  S.aplicar(rh, 1, '2026-12', ctx, { justificativa: 'gerar dezembro em 5x2', cienteDivergencias: true }); const e = E.ler(1, '2026-12'); assert.equal(e.status, 'rascunho');
  const A0 = S.analisar(rh, 1, '2026-12', ctx); assert.deepEqual([A0.folgas.indicadores.excesso, A0.folgas.indicadores.sequencias3, A0.folgas.divergencias.length], [0, 0, 0]);
  // Bruno: acha duas folgas coladas dele e lança a terceira à mão no dia seguinte (ou no anterior)
  const bruno = A0.pessoas.find(p => p.nome === 'Bruno Sá'); const fol = Object.keys(e.dias).filter(k => k.startsWith('102|') && e.dias[k].tipo === 'folga').map(k => k.slice(4)).sort(); const alvo = fol.map(d => soma(d, 1)).find(d => d <= '2026-12-27' && !fol.includes(d) && fol.includes(soma(d, -1)) && (fol.includes(soma(d, -2)) || fol.includes(soma(d, 1))));
  const novo = alvo || soma(fol[2], 1); e.dias['102|' + novo] = { tipo: 'folga', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: 'FRENTE DE CAIXA', obs: '', origem: 'manual' }; if (!alvo) e.dias['102|' + soma(fol[2], -1)] = { ...e.dias['102|' + novo] }; E.salvar(e);
  const A1 = S.analisar(rh, 1, '2026-12', ctx); assert.ok(A1.folgas.indicadores.excesso >= 1, 'a folga a mais aparece na conferência'); assert.ok(A1.folgas.indicadores.sequencias3 >= 1);
  const q = A1.folgas.ocorrencias.find(o => o.indicador === 'sequencia' && o.funcId === 102); assert.ok(q && q.datas.includes(novo)); assert.match(q.motivo, /ajuste na grade/); assert.equal(bruno.nome, q.nome);
  assert.equal(S.portaPublicacao(1, '2026-12', ctx).liberada, false, 'escala com folga a mais não é publicável');
});
