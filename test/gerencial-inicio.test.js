const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/gerencial-inicio');

const montado = {
  resumo: { previstos: 12, chegaram: 10, atrasos: 2, emIntervalo: 1, saidas: 0, pendentes: 3, aguardando: 1, apuracao: 0, fora: { folga: 2, ferias: 1, afastado: 0 } },
  pendencias: [
    { g: 'sem', nome: 'ANA', loja: 5, etq: 'E5', setor: 'CAIXA', txt: 'Nenhuma marcação · previsto 07:00' },
    { g: 'sem', nome: 'BIA', loja: 5, etq: 'E5', setor: 'PADARIA', txt: 'Nenhuma marcação · previsto 06:00' },
    { g: 'atraso', nome: 'CARLOS', loja: 5, etq: 'E5', setor: 'AÇOUGUE', txt: '15 min · previsto 07:00, entrou 07:15' }
  ]
};

test('resumoPonto: contadores da loja + sem marcação contado pelas pendências', () => {
  const p = G.resumoPonto(montado);
  assert.equal(p.previstos, 12); assert.equal(p.chegaram, 10); assert.equal(p.atrasos, 2);
  assert.equal(p.semMarcacao, 2, 'duas pessoas sem marcação');
  assert.deepEqual(p.fora, { folga: 2, ferias: 1, afastado: 0 });
  assert.equal(p.pendencias.length, 3); assert.equal(p.pendencias[0].nome, 'ANA'); assert.equal(p.pendencias[0].setor, 'CAIXA');
  assert.equal(p.maisPendencias, 0);
});
test('resumoPonto: sem gente na loja = zeros, sem quebrar', () => {
  const p = G.resumoPonto({ resumo: { previstos: 0, chegaram: 0, atrasos: 0, fora: { folga: 0, ferias: 0, afastado: 0 } }, pendencias: [] });
  assert.equal(p.previstos, 0); assert.equal(p.semMarcacao, 0); assert.deepEqual(p.pendencias, []);
});
test('resumoSemGiro: resumo da loja, faixas e lista limitada', () => {
  const res = { n: 40, valor: 1234.5, f30: { n: 10, v: 100 }, f60: { n: 10, v: 200 }, f90: { n: 10, v: 300 }, f120: { n: 10, v: 634.5 }, decididas: 3, abaixoCusto: 1 };
  const itens = Array.from({ length: 50 }, (_, i) => ({ cod: 'C' + i, descricao: 'ITEM ' + i, grupo: 'G', unid: 'UN', est: 5, valor: 50 - i, dias: 200 - i, faixa: 120, preco: 9.9 }));
  const s = G.resumoSemGiro(res, itens, { calculadoEm: '2026-10-27T03:00:00.000Z', calculando: false });
  assert.equal(s.n, 40); assert.equal(s.valor, 1234.5); assert.equal(s.faixas.f120.n, 10);
  assert.equal(s.itens.length, 30, 'gaveta mostra no máximo 30 itens'); assert.equal(s.itens[0].cod, 'C0');
  assert.equal(s.calculadoEm, '2026-10-27T03:00:00.000Z');
});
test('quadros: Ponto e Sem Giro da loja; cada bloco falha sozinho', async () => {
  const chamadas = [];
  const deps = {
    tvRh: { jornadaHoje: async () => ({ linhas: [] }), montar: (j, cfg) => { chamadas.push(cfg.lojas); return montado; } },
    semGiro: { lojas: () => ({ estado: { calculadoEm: 'x' }, lojas: { 5: { n: 7, valor: 70 } }, total: { n: 99, valor: 990 } }), consultar: q => { chamadas.push([q.loja, q.faixa || 0]); return { rows: q.faixa ? [{ cod: 'F' + q.faixa, descricao: 'FAIXA ' + q.faixa, valor: 5, faixa: q.faixa }] : [{ cod: '1', descricao: 'A', valor: 10 }] }; } },
    toleranciaMin: () => 10
  };
  const r = await G.quadros(5, deps);
  assert.equal(r.loja, 5); assert.equal(r.lojaTxt, 'E5 · Porta Larga');
  assert.deepEqual(chamadas, [[5], [5, 0], [5, 30], [5, 60], [5, 90], [5, 120]], 'jornada e sem giro filtrados pela loja; uma consulta por faixa');
  assert.equal(r.ponto.chegaram, 10); assert.equal(r.semGiro.n, 7); assert.equal(r.semGiro.itens.length, 1);
  assert.deepEqual(Object.keys(r.semGiro.itensFaixa), ['30', '60', '90', '120']); assert.equal(r.semGiro.itensFaixa[60][0].cod, 'F60');

  const rede = await G.quadros(null, deps);
  assert.equal(rede.lojaTxt, 'Rede'); assert.equal(rede.semGiro.n, 99);

  const falha = await G.quadros(5, { ...deps, tvRh: { jornadaHoje: async () => { throw new Error('Sem dados do PontoCerto ainda'); }, montar: () => montado } });
  assert.match(falha.ponto.erro, /PontoCerto/); assert.equal(falha.semGiro.n, 7, 'Sem Giro continua mesmo sem ponto');
});
