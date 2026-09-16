const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../lib/pedidos-cd-util');

test('dun14ParaEan13 recalcula o dígito verificador', () => {
  assert.equal(u.dun14ParaEan13('17896037913143'), '7896037913146');
  assert.equal(u.dun14ParaEan13('25601252231168'), '5601252231164');
  assert.equal(u.dun14ParaEan13('7896037913146'), null);
  assert.equal(u.dun14ParaEan13('1789603791314X'), null);
});

test('ean13Valido', () => {
  assert.equal(u.ean13Valido('7896037913146'), true);
  assert.equal(u.ean13Valido('7896037913145'), false);
});

test('emCaixas arredonda pra cima', () => {
  assert.equal(u.emCaixas(0, 12), 0);
  assert.equal(u.emCaixas(1, 12), 1);
  assert.equal(u.emCaixas(24, 12), 2);
  assert.equal(u.emCaixas(25, 12), 3);
  assert.equal(u.emCaixas(10, 0), 0);
});

test('distribuirCdInsuficiente respeita o estoque e prioriza menor cobertura', () => {
  const r = u.distribuirCdInsuficiente({ 1: 3, 2: 2, 3: 4 }, 5, { 1: 10, 2: 1, 3: 5 });
  assert.equal(r.falta, 4);
  assert.equal(Object.values(r.pedidoCx).reduce((a, b) => a + b, 0), 5);
  assert.equal(r.pedidoCx[2], 2);           // menor cobertura, atendida inteira
  assert.ok(r.pedidoCx[3] >= r.pedidoCx[1]); // próxima prioridade
});

test('distribuirCdInsuficiente reparte em rodízio entre todas as lojas que pediram (caso Capricche)', () => {
  const r = u.distribuirCdInsuficiente({ 2: 6, 3: 7, 4: 2, 5: 4 }, 13, { 2: 0, 3: 0.5, 4: 1, 5: 1.2 });
  assert.equal(r.falta, 6);
  assert.deepEqual(r.pedidoCx, { 2: 4, 3: 4, 4: 2, 5: 3 });
});

test('distribuirCdInsuficiente sem falta devolve igual', () => {
  const r = u.distribuirCdInsuficiente({ 1: 3, 2: 2 }, 10, { 1: 1, 2: 2 });
  assert.deepEqual(r, { pedidoCx: { 1: 3, 2: 2 }, falta: 0 });
});

test('statusRecebimento', () => {
  assert.equal(u.statusRecebimento([{ caixas: 2, recebidas: 2 }, { caixas: 1, recebidas: 1 }]), 'recebido');
  assert.equal(u.statusRecebimento([{ caixas: 2, recebidas: 1 }, { caixas: 1, recebidas: 1 }]), 'recebido_parcial');
  assert.equal(u.statusRecebimento([{ caixas: 2, recebidas: 0 }, { caixas: 1, recebidas: 0 }]), 'aberto');
});

test('mediaLead', () => {
  assert.equal(u.mediaLead([]), null);
  assert.deepEqual(u.mediaLead([{ entrada: '2026-09-01', nota: '2026-09-02' }, { entrada: '2026-09-03', nota: '2026-09-06' }]), { lead_medio: 2, lead_max: 3, n: 2 });
});

test('mediaLead descarta pares com lead negativo ou acima de 30 dias', () => {
  const r = u.mediaLead([
    { entrada: '2026-09-10', nota: '2026-09-01' },  // negativo, descarta
    { entrada: '2026-01-01', nota: '2026-03-01' },  // > 30 dias, descarta
    { entrada: '2026-09-01', nota: '2026-09-03' }   // 2 dias, fica
  ]);
  assert.deepEqual(r, { lead_medio: 2, lead_max: 2, n: 1 });
});

test('distribuirCdInsuficiente com cobertura igual desempata por menor loja', () => {
  const r = u.distribuirCdInsuficiente({ 1: 2, 2: 2 }, 2, { 1: 5, 2: 5 });
  assert.deepEqual(r, { pedidoCx: { 1: 1, 2: 1 }, falta: 2 });
});

test('distribuirCdInsuficiente com estoque fracionário arredonda pra baixo', () => {
  const r = u.distribuirCdInsuficiente({ 1: 3 }, 2.9, { 1: 5 });
  assert.equal(r.pedidoCx[1], 2);
  assert.equal(r.falta, 1);
});

test('distribuirCdInsuficiente trata cobertura ausente como prioridade mais baixa (9999)', () => {
  const r = u.distribuirCdInsuficiente({ 1: 2, 2: 2 }, 2, { 1: 5 });
  assert.deepEqual(r, { pedidoCx: { 1: 1, 2: 1 }, falta: 2 }); // rodízio: loja sem cobertura entra depois, mas entra
});

test('casarPorDescricao: mesmas palavras em outra ordem, embalagem ignorada, abreviação por prefixo', () => {
  const un = [
    { cod: '7896006711100', descricao: 'POP ARROZ 1KG BRANCO' },
    { cod: '7896070224018', descricao: 'SAMAN ARROZ 1KG BRANCO' },
    { cod: '7896006714019', descricao: 'POP ARROZ 1KG PARBOILIZADO' },
    { cod: '7509546667638', descricao: 'SORRISO CR DENTAL 120G TRIPLA LIMPEZA COMPLET' }
  ];
  assert.equal(u.casarPorDescricao('ARROZ BRANCO POP 1KG PC10', un).candidato, '7896006711100');
  assert.equal(u.casarPorDescricao('ARROZ PARB POP 1KG PC10', un).candidato, '7896006714019');
  assert.equal(u.casarPorDescricao('CR DENTAL SORRISO TRIPLA LIMP COMP 120G CX72', un).candidato, '7509546667638');
  assert.deepEqual(u.tokensDescricao('CREME LEITE BETANIA 200G TP CX/27'), ['CREME', 'LEITE', 'BETANIA', '200G', 'TP']);
  assert.deepEqual(u.tokensDescricao('POUCH WHISKAS CARNE ADULTO 85G CX/40'), ['POUCH', 'WHISKAS', 'CARNE', 'ADULTO', '85G']);
});

test('casarPorDescricao: empate não vira candidato, só alternativas; sem parecido não sugere', () => {
  const un = [
    { cod: '7896029046609', descricao: 'WHISKAS POUCH ADULTO 85G CARNE' },
    { cod: '7896029046623', descricao: 'WHISKAS POUCH CASTRADOS 85G CARNE' },
    { cod: '7896029047101', descricao: 'WHISKAS POUCH FILHOTE 85G CARNE' }
  ];
  const r = u.casarPorDescricao('POUCH WHISKAS CARNE 85G CX40', un);
  assert.equal(r.candidato, null);
  assert.equal(r.alternativas.length, 3);
  assert.equal(u.casarPorDescricao('ENERGETICO POWER BUSTER MELANCIA 2L PC6', un).candidato, null);
  assert.equal(u.casarPorDescricao('ENERGETICO POWER BUSTER MELANCIA 2L PC6', un).alternativas.length, 0);
  // caixa com só uma palavra útil não casa com nada
  assert.equal(u.casarPorDescricao('SANDALIA CX6', [{ cod: '1', descricao: 'SANDALIA' }]).candidato, null);
});

test('casarPorDescricao: unidade com 1 palavra a mais ainda é candidato; com mais que isso, não', () => {
  const un = [{ cod: '7898031174677', descricao: 'BEM TE VI LAVA ROUPAS EM PO 400G PERF DA NATU' }];
  assert.equal(u.casarPorDescricao('LAVA ROUPAS EM PO BEM TE VI PERF NAT FD CX27', un).candidato, null); // 2 extras (400G, DA)
  assert.equal(u.casarPorDescricao('LAVA ROUPAS EM PO BEM TE VI 400G PERF DA NAT CX27', un).candidato, '7898031174677');
});
