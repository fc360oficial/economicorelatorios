// test/cahu-tabela-wpp.test.js — comparação de fotos da tabela CAHU + textos do WhatsApp + regra "um aviso por dia" (18/09/2026)
process.env.CAHU_WPP_STATE = require('path').join(require('os').tmpdir(), 'cahu-wpp-teste-' + process.pid + '.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/cahu-tabela-wpp');

const TABELAS = [{ cod: 1, label: 'Tabela Retirada' }, { cod: 4, label: 'Tabela Entrega Boleto 7 Dias' }, { cod: 5, label: 'Tabela Entrega Boleto 14 Dias' }];
const lista = (...itens) => itens.map(([cod, d, p1, p4, p5]) => ({ codigobarra: cod, descricao: d, 1: p1, 4: p4, 5: p5 }));

test('tirarFoto guarda preço por tabela e ignora tabela sem preço', () => {
  const f = m.tirarFoto(lista(['789', 'DIPIRONA', 8.9, 9.2, null]), TABELAS);
  assert.deepEqual(f.itens['789'], { d: 'DIPIRONA', p: { 1: 8.9, 4: 9.2 } });
  assert.equal(f.tabelas.length, 3);
});

test('comparar acha quem saiu, quem entrou e preço que mudou (por tabela, tolerância de centavo)', () => {
  const antes = m.tirarFoto(lista(['A', 'ZERADO', 1, 1, 1], ['B', 'IGUAL', 2, 2, 2], ['C', 'MUDOU', 8.9, 9.2, 9.2]), TABELAS);
  const depois = m.tirarFoto(lista(['B', 'IGUAL', 2, 2, 2.001], ['C', 'MUDOU', 9.4, 9.7, 9.7], ['D', 'NOVO', 5, 5, 5]), TABELAS);
  const d = m.comparar(antes, depois);
  assert.deepEqual(d.sairam, [{ cod: 'A', d: 'ZERADO' }]);
  assert.deepEqual(d.entraram, [{ cod: 'D', d: 'NOVO' }]);
  assert.equal(d.precos.length, 1);
  assert.deepEqual(d.precos[0].mudancas, [{ tab: 1, de: 8.9, para: 9.4 }, { tab: 4, de: 9.2, para: 9.7 }, { tab: 5, de: 9.2, para: 9.7 }]);
});

test('comparar sem foto anterior = nada a avisar', () => {
  const d = m.comparar(null, m.tirarFoto(lista(['A', 'X', 1, 1, 1]), TABELAS));
  assert.deepEqual(d, { sairam: [], entraram: [], precos: [] });
});

test('resumo da manhã separa motivo da saída e agrupa tabelas com o mesmo de→para', () => {
  const diff = {
    sairam: [{ cod: 'A', d: 'SEM ESTOQUE' }, { cod: 'B', d: 'DESATIVADO' }],
    entraram: [{ cod: 'D', d: 'VOLTOU' }],
    precos: [{ cod: 'C', d: 'LOSARTANA', mudancas: [{ tab: 1, de: 8.9, para: 9.4 }, { tab: 4, de: 9.2, para: 9.7 }, { tab: 5, de: 9.2, para: 9.7 }] }],
  };
  const t = m.textoResumoManha(diff, { A: 'estoque', B: 'desativado' }, TABELAS, '2026-09-19T10:00:00.000Z');
  assert.match(t, /Alterações desde sáb 19\/09/);
  assert.match(t, /sem estoque no CD\)\*\n• A SEM ESTOQUE/);
  assert.match(t, /produto desativado\)\*\n• B DESATIVADO/);
  assert.match(t, /Voltaram \/ novos na tabela\*\n• D VOLTOU/);
  assert.match(t, /• C LOSARTANA\n  Retirada: R\$ 8,90 → R\$ 9,40\n  Entrega Boleto 7 Dias \/ Entrega Boleto 14 Dias: R\$ 9,20 → R\$ 9,70/);
});

test('preço igual em todas as tabelas vira "Todas as tabelas"', () => {
  const diff = { sairam: [], entraram: [], precos: [{ cod: 'C', d: 'X', mudancas: TABELAS.map(t => ({ tab: t.cod, de: 1, para: 2 })) }] };
  assert.match(m.textoResumoManha(diff, {}, TABELAS, new Date().toISOString()), /Todas as tabelas: R\$ 1,00 → R\$ 2,00/);
});

test('sem mudança: mensagem curta dizendo que não mudou nada (não fica mudo)', () => {
  const t = m.textoResumoManha({ sairam: [], entraram: [], precos: [] }, {}, TABELAS, new Date().toISOString());
  assert.match(t, /Sem alterações de preço ou de itens/);
});

test('mais de 40 itens resume com "e mais N itens"', () => {
  const sairam = Array.from({ length: 55 }, (_, i) => ({ cod: 'C' + i, d: 'ITEM ' + i }));
  const t = m.textoResumoManha({ sairam, entraram: [], precos: [] }, {}, TABELAS, new Date().toISOString());
  assert.equal((t.match(/^• /gm) || []).length, 40);
  assert.match(t, /e mais 15 itens, veja o PDF/);
});

test('checagem: null sem novidade; itens novos/voltaram não entram (só de manhã)', () => {
  assert.equal(m.textoChecagem({ sairam: [], entraram: [{ cod: 'D', d: 'V' }], precos: [] }, {}, TABELAS), null);
  const t = m.textoChecagem({ sairam: [{ cod: 'A', d: 'ZEROU' }], entraram: [], precos: [{ cod: 'C', d: 'P', mudancas: [{ tab: 1, de: 1, para: 2 }] }] }, { A: 'estoque' }, TABELAS);
  assert.match(t, /Zerou no CD.*\n• A ZEROU/);
  assert.match(t, /Mudou de preço\*\n• C P\n  Retirada: R\$ 1,00 → R\$ 2,00/);
});

test('um aviso por item por dia: repetição no mesmo dia é filtrada, dia novo zera', () => {
  const avisos = { data: null, itens: {} };
  const diff = { sairam: [{ cod: 'A', d: 'A' }], entraram: [], precos: [{ cod: 'C', d: 'C', mudancas: [{ tab: 1, de: 1, para: 2 }, { tab: 4, de: 1, para: 2 }] }] };
  const r1 = m.filtrarJaAvisados(diff, avisos);
  assert.equal(r1.diff.sairam.length, 1); assert.equal(r1.diff.precos[0].mudancas.length, 2);
  r1.confirmar();
  // mesmo item de novo (oscilou): não avisa; só tabela 5 (ainda não avisada) passa
  const diff2 = { sairam: [{ cod: 'A', d: 'A' }], entraram: [], precos: [{ cod: 'C', d: 'C', mudancas: [{ tab: 1, de: 2, para: 3 }, { tab: 5, de: 1, para: 2 }] }] };
  const r2 = m.filtrarJaAvisados(diff2, avisos);
  assert.equal(r2.diff.sairam.length, 0);
  assert.deepEqual(r2.diff.precos[0].mudancas, [{ tab: 5, de: 1, para: 2 }]);
  // dia virou: tudo volta a valer
  avisos.data = '2000-01-01';
  const r3 = m.filtrarJaAvisados(diff, avisos);
  assert.equal(r3.diff.sairam.length, 1); assert.equal(r3.diff.precos[0].mudancas.length, 2);
});

test('classificarSaidas: desativado > sem estoque > retirado da tabela', async () => {
  m.init({ q: async (sql, p) => {
    if (sql.includes('estoquen10')) return [{ CodigoBarra: 'A', Qtd: '0' }, { CodigoBarra: 'B', Qtd: '5' }, { CodigoBarra: 'C', Qtd: '3' }];
    if (sql.includes('central.itens')) return [{ CodigoBarra: 'A', CodDesativado: 0 }, { CodigoBarra: 'B', CodDesativado: 0 }, { CodigoBarra: 'C', CodDesativado: 1 }];
    if (sql.includes('s_tabela_item')) return [{ codigobarra: 'A', st: 0 }, { codigobarra: 'B', st: 1 }, { codigobarra: 'C', st: 0 }];
    return [];
  } });
  const mot = await m.classificarSaidas([{ cod: 'A' }, { cod: 'B' }, { cod: 'C' }, { cod: 'X' }], TABELAS);
  assert.deepEqual(mot, { A: 'estoque', B: 'tabela', C: 'desativado', X: 'desativado' });
});
