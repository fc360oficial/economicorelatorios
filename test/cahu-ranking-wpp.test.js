// test/cahu-ranking-wpp.test.js — ranking de vendedores no WhatsApp: formatos por dia e regras (02/10/2026)
process.env.CAHU_RANKING_STATE = require('path').join(require('os').tmpdir(), 'cahu-ranking-teste-' + process.pid + '.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/cahu-ranking-wpp');

const nota = (d, vend, vendNome, v) => ({ d, vend, vendNome, v });
const NOTAS = [
  nota('2026-10-01', 1, 'KLEBER JUNIOR', 5000), nota('2026-10-01', 1, 'KLEBER JUNIOR', 2588.50),
  nota('2026-10-01', 2, 'ERVERSON SOUZA', 5474.51),
  nota('2026-10-01', 3, 'RODRIGO CAHU', 3142.32),
  nota('2026-10-01', 4, 'CLEBER HERMINIO', 2823.90),
  nota('2026-10-01', 0, 'Sem vendedor', 9999),
];

test('montarRanking soma por vendedor, ignora "Sem vendedor" e ordena do maior pro menor', () => {
  const r = m.montarRanking(NOTAS);
  assert.deepEqual(r.map(x => x.nome), ['KLEBER JUNIOR', 'ERVERSON SOUZA', 'RODRIGO CAHU', 'CLEBER HERMINIO']);
  assert.equal(r[0].v, 7588.5);
  assert.equal(r[0].n, 2);
});

test('texto diário: TODOS os vendedores (medalha no top 3, 4º em diante numerado), primeiro nome, SEM valor', () => {
  const t = m.textoDiario(m.montarRanking(NOTAS), m.destaqueAnterior(NOTAS, '2026-10-02'), '2026-10-02');
  assert.match(t, /🏆 \*02\/10 — Ranking do mês:\*/);
  assert.match(t, /🥇 Kleber\n🥈 Erverson\n🥉 Rodrigo\n4º Cleber/);
  assert.match(t, /Destaque de ontem: Kleber Junior 🔥/);
  assert.match(t, /Bom dia e boas vendas! 💪/);
  assert.doesNotMatch(t, /R\$|\d+,\d{2}/);   // sem valores, nunca
});

test('destaque: na segunda o "ontem" é o sábado (mostra a data em vez de "ontem")', () => {
  const notas = [nota('2026-10-03', 4, 'CLEBER HERMINIO', 100)];   // sábado; dia 05 é segunda
  const d = m.destaqueAnterior(notas, '2026-10-05');
  assert.equal(d.ontem, false);
  assert.match(m.textoDiario(m.montarRanking(notas), d, '2026-10-05'), /Destaque de 03\/10: Cleber Herminio 🔥/);
});

test('nomeCurto desempata primeiro nome repetido usando dois nomes', () => {
  const todos = ['KLEBER JUNIOR', 'KLEBER SILVA', 'ERVERSON SOUZA'];
  assert.equal(m.nomeCurto('KLEBER JUNIOR', todos), 'Kleber Junior');
  assert.equal(m.nomeCurto('ERVERSON SOUZA', todos), 'Erverson');
});

test('dia 1º: mensagem de novo mês com o nome do mês, sem ranking', () => {
  const t = m.textoDoDia('2026-11-01', NOTAS);
  assert.match(t, /🏁 \*NOVO MÊS, NOVA CORRIDA!\*/);
  assert.match(t, /primeira venda de novembro\? 👀/);
  assert.doesNotMatch(t, /🥇/);
});

test('diasUteisRestantes conta seg–sáb incluindo hoje (domingo fora)', () => {
  assert.equal(m.diasUteisRestantes('2026-10-26'), 6);   // seg 26 a sáb 31
  assert.equal(m.diasUteisRestantes('2026-10-31'), 1);   // sábado, último dia
  assert.equal(m.diasUteisRestantes('2026-10-02'), 26);  // mês inteiro pela frente → diário
});

test('última semana: reta final com TODOS os vendedores e dias úteis; 2º colado no líder ganha aviso', () => {
  const notas = [nota('2026-10-20', 1, 'KLEBER JUNIOR', 1000), nota('2026-10-20', 2, 'ERVERSON SOUZA', 900), nota('2026-10-20', 3, 'RODRIGO CAHU', 300), nota('2026-10-20', 4, 'CLEBER HERMINIO', 100)];
  const t = m.textoDoDia('2026-10-26', notas);
  assert.match(t, /⏳ \*RETA FINAL — faltam 6 dias úteis!\*/);
  assert.match(t, /🥈 Erverson Souza — na cola do líder! 👀/);   // 900 ≥ 80% de 1000
  assert.match(t, /4º Cleber Herminio/);                         // do 4º em diante entra numerado
  assert.match(t, /chave de ouro! 🔑/);
  assert.doesNotMatch(t, /R\$/);   // sem valores (os únicos números são os dias úteis do cabeçalho)
});

test('reta final no último dia útil muda o cabeçalho; 2º longe do líder fica sem aviso', () => {
  const notas = [nota('2026-10-20', 1, 'KLEBER JUNIOR', 1000), nota('2026-10-20', 2, 'ERVERSON SOUZA', 500)];
  const t = m.textoDoDia('2026-10-31', notas);
  assert.match(t, /último dia útil do mês!/);
  assert.match(t, /🥈 Erverson Souza\n/);
});

test('mês sem venda ainda (fora do dia 1º): convida a abrir o placar', () => {
  const t = m.textoDoDia('2026-10-02', []);
  assert.match(t, /Ranking do mês ainda zerado. Quem abre o placar hoje\? 👀/);
});

test('ranking só conta notas do mês corrente (setembro fica de fora)', () => {
  const notas = [nota('2026-09-30', 2, 'ERVERSON SOUZA', 99999), nota('2026-10-01', 1, 'KLEBER JUNIOR', 10)];
  const t = m.textoDoDia('2026-10-02', notas);
  assert.match(t, /🥇 Kleber\b/);
  assert.doesNotMatch(t, /🥈/);
});