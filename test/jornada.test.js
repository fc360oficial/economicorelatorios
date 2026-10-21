// test/jornada.test.js — Jornada diária (lib/pontocerto.js, aba TESTE TIAGO 21/10/2026): regras puras, sem chamar a API
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../lib/pontocerto');

const escala = { id: 1, nome: 'T1', dias: { 1: [{ entrada: '08:00', saida: '12:00' }, { entrada: '13:00', saida: '17:00' }], 2: [{ entrada: '07:00', saida: '15:20' }], 0: [] } };
const SEG = '2026-10-19', TER = '2026-10-20', DOM = '2026-10-18';
const cls = o => pc.classificarJornada({ hoje: '2026-10-21', agoraHM: '10:00', toleranciaMin: 10, atrasoMin: 0, marcacoes: [], statusAgora: '', ...o });

test('escala prevista: intervalo, sem intervalo, folga e escala desconhecida', () => {
  assert.deepEqual(pc.previstoDe(escala, SEG), { folga: false, entrada: '08:00', saidaInt: '12:00', retornoInt: '13:00', saida: '17:00', periodos: 2 });
  assert.deepEqual(pc.previstoDe(escala, TER), { folga: false, entrada: '07:00', saidaInt: null, retornoInt: null, saida: '15:20', periodos: 1 });
  assert.equal(pc.previstoDe(escala, DOM).folga, true);
  assert.equal(pc.previstoDe(null, SEG), null);
});

test('marcações caem nas colunas certas conforme a escala', () => {
  const p2 = pc.previstoDe(escala, SEG), p1 = pc.previstoDe(escala, TER);
  assert.deepEqual(pc.colunasMarcacoes(['08:02', '12:01', '13:05', '17:10'], p2), { entrada: '08:02', saidaInt: '12:01', retornoInt: '13:05', saida: '17:10' });
  assert.deepEqual(pc.colunasMarcacoes(['08:02', '12:01'], p2), { entrada: '08:02', saidaInt: '12:01', retornoInt: null, saida: null }, 'com intervalo previsto, 2ª marcação é saída pro intervalo, não saída');
  assert.deepEqual(pc.colunasMarcacoes(['07:00', '15:25'], p1), { entrada: '07:00', saidaInt: null, retornoInt: null, saida: '15:25' });
});

test('jornada incompleta não vira falta: sem marcação, incompleta, apuração pendente', () => {
  const p = pc.previstoDe(escala, SEG);
  assert.equal(cls({ data: SEG, previsto: p, marcacoes: [], apurado: true }), 'sem_marcacao');
  assert.equal(cls({ data: SEG, previsto: p, marcacoes: ['08:00', '12:00', '13:00'], apurado: true }), 'incompleta');
  assert.equal(cls({ data: SEG, previsto: null, shiftTime: undefined, apurado: false }), 'pendente', 'sem escala e sem apuração = pendente');
  assert.equal(cls({ data: SEG, previsto: null, shiftTime: undefined, apurado: true }), 'sem_escala');
});

test('atraso só quando a apuração confirma acima da tolerância; folga trabalhada; férias/afastado só ao vivo', () => {
  const p = pc.previstoDe(escala, SEG); const m = ['08:09', '12:00', '13:00', '17:00'];
  assert.equal(cls({ data: SEG, previsto: p, marcacoes: m, atrasoMin: 9, apurado: true }), 'ok');
  assert.equal(cls({ data: SEG, previsto: p, marcacoes: m, atrasoMin: 11, apurado: true }), 'atraso');
  assert.equal(cls({ data: DOM, previsto: pc.previstoDe(escala, DOM), marcacoes: ['08:00', '12:00'], apurado: true }), 'folga_trabalhada');
  assert.equal(cls({ data: DOM, previsto: pc.previstoDe(escala, DOM), marcacoes: [], apurado: true }), 'folga');
  assert.equal(cls({ data: '2026-10-21', previsto: p, statusAgora: 'De férias' }), 'ferias');
  assert.equal(cls({ data: SEG, previsto: p, marcacoes: m, statusAgora: 'De férias', apurado: true }), 'ok', 'status ao vivo não classifica dia passado');
  assert.equal(cls({ data: SEG, previsto: p, marcacoes: [], afastamento: 'ferias', apurado: true }), 'ferias', 'férias de dia passado vêm do relatório de afastamentos');
  assert.equal(cls({ data: SEG, previsto: p, marcacoes: [], afastamento: 'afastado', apurado: true }), 'afastado');
});

test('hoje: aguardando entrada, em andamento, intervalo', () => {
  const p = pc.previstoDe(escala, SEG);
  assert.equal(cls({ data: '2026-10-21', agoraHM: '07:30', previsto: p, marcacoes: [] }), 'aguardando');
  assert.equal(cls({ data: '2026-10-21', agoraHM: '10:00', previsto: p, marcacoes: [], statusAgora: 'Ausente' }), 'sem_marcacao');
  assert.equal(cls({ data: '2026-10-21', previsto: p, marcacoes: ['08:01'], statusAgora: 'Em jornada' }), 'em_andamento');
  assert.equal(cls({ data: '2026-10-21', agoraHM: '12:30', previsto: p, marcacoes: ['08:01', '12:02'], statusAgora: 'Intervalo' }), 'intervalo');
  assert.equal(cls({ data: '2026-10-21', agoraHM: '18:00', previsto: p, marcacoes: ['08:01', '12:02', '13:00', '17:05'], statusAgora: 'Expediente encerrado' }), 'ok');
});

test('work_days normalizado: marcações, apuração e saldo oficial acumulado', () => {
  const r = pc.normalizarWorkDay({ employee_id: 7, employee_name: 'X', team_name: 'CAIXA/PONTE', date: 'Ter, 20/10/2026', shift_time: '09:00', time_balance: '252:59',
    time_cards: [{ value: '06:14' }, { value: '11:08' }, { value: '12:00' }, { value: '16:10' }], summary: ['00:52', '02:42', '06:18'], extra_time: [{ value: '02:46', raw_value: 9960 }, { value: '00:00', raw_value: 0 }] });
  assert.equal(r.data, '2026-10-20'); assert.deepEqual(r.marcacoes, ['06:14', '11:08', '12:00', '16:10']);
  assert.equal(r.intervalo, '00:52'); assert.equal(r.faltantes, '02:42'); assert.equal(r.normais, '06:18'); assert.equal(r.extras, '2:46'); assert.equal(r.extras_min, 166);
  assert.equal(r.saldo_acum_min, 252 * 60 + 59);
});
