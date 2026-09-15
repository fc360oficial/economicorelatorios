const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/precificacao-calc');

test('arred nenhum: 2 casas, pra cima', () => {
  assert.equal(c.arred(3.141, 'nenhum'), 3.15);
  assert.equal(c.arred(3.14, 'nenhum'), 3.14);
  assert.equal(c.arred(0, 'nenhum'), 0);
});

test('arred 9: menor valor >= v com centavos terminados em 9', () => {
  assert.equal(c.arred(3.14, '9'), 3.19);
  assert.equal(c.arred(3.19, '9'), 3.19);
  assert.equal(c.arred(3.191, '9'), 3.29);
  assert.equal(c.arred(3.995, '9'), 4.09);
  assert.equal(c.arred(3.996, '9'), 4.09);
  assert.equal(c.arred(10, '9'), 10.09);
});

test('arred 5: menor valor >= v com centavos terminados em 5', () => {
  assert.equal(c.arred(3.14, '5'), 3.15);
  assert.equal(c.arred(3.15, '5'), 3.15);
  assert.equal(c.arred(3.151, '5'), 3.25);
  assert.equal(c.arred(3.96, '5'), 4.05);
});

test('arred termo inválido cai em nenhum', () => {
  assert.equal(c.arred(3.141, 'x'), 3.15);
});

const P9 = { arredondamento: '9' };
const PN = { arredondamento: 'nenhum' };
const base = { cod: '1', descricao: 'X', curvaA: false, recebida: 10, custo_atual: 10, custo_novo: 11, custo_imposto: 11, margem: 30, preco_atual: 12.99, margem_atacado: null, preco_atacado_atual: null };

test('regra 2: custo subiu → margem de cadastro, preço = custo×(1+margem) arredondado', () => {
  const it = c.calcularItem(base, P9);
  assert.equal(it.regra, 'margem');
  assert.equal(it.status, 'sobe');
  assert.equal(it.preco_calc, 14.3);
  assert.equal(it.preco_sugerido, 14.39);
  assert.equal(it.preco_final, 14.39);
  assert.equal(it.manual, false);
  assert.equal(it.variacao, 0.1);
  assert.equal(it.atacado, null);
});

test('regra 1: custo igual → margem de cadastro (mesmo que o preço atual esteja diferente)', () => {
  const it = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 10 }, P9);
  assert.equal(it.regra, 'margem');
  assert.equal(it.preco_sugerido, 13.09);           // 10×1.3 = 13.00 → 13.09
  assert.equal(it.status, 'sobe');                  // 13.09 > 12.99
  const igual = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 10, preco_atual: 13.09 }, P9);
  assert.equal(igual.status, 'sem_mudanca');        // margem já dá o preço atual
  const desce = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 10, preco_atual: 15.99 }, P9);
  assert.equal(desce.status, 'desce');              // preço atual estava acima da margem: segue a margem
  assert.equal(desce.preco_sugerido, 13.09);
});

test('regra 2: custo subiu mas margem dá preço abaixo do atual → desce (segue a margem)', () => {
  const it = c.calcularItem({ ...base, preco_atual: 19.99 }, P9);
  assert.equal(it.regra, 'margem');
  assert.equal(it.status, 'desce');
  assert.equal(it.preco_sugerido, 14.39);
});

test('regra 3: custo 20% (ou mais) abaixo do atual → preço 10% abaixo do preço atual', () => {
  const it = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 8, preco_atual: 12.99 }, P9);
  assert.equal(it.regra, 'desconto');
  assert.equal(it.status, 'desce');
  assert.equal(it.preco_sugerido, 11.69);           // 12.99×0.9 = 11.691 → 11.69 (já termina em 9)
  const exato = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 8, preco_atual: 12.99 }, PN);
  assert.equal(exato.preco_sugerido, 11.69);
  const limite = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 8.0, preco_atual: 20 }, PN);
  assert.equal(limite.regra, 'desconto');            // exatamente 20% conta
  assert.equal(limite.preco_sugerido, 18);
  const quase = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 8.01, preco_atual: 20 }, PN);
  assert.equal(quase.regra, 'mantem');               // 19,9% não conta
});

test('regra 3: −10% não pode ficar abaixo do custo → piso', () => {
  const it = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 8, preco_atual: 8.5 }, PN);
  assert.equal(it.regra, 'desconto');
  assert.equal(it.piso, true);
  assert.equal(it.preco_sugerido, 8);               // 8.5×0.9 = 7.65 < custo 8 → 8.00
});

test('queda menor que 20% → mantém o preço atual', () => {
  const it = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 9, preco_atual: 12.99 }, P9);
  assert.equal(it.regra, 'mantem');
  assert.equal(it.status, 'mantem');
  assert.equal(it.preco_sugerido, 12.99);
  assert.equal(it.piso, false);
});

test('calcularItem: sem margem → bloqueado', () => {
  const it = c.calcularItem({ ...base, margem: null }, P9);
  assert.equal(it.status, 'bloqueado');
  assert.equal(it.preco_sugerido, null);
  assert.match(it.motivo, /margem/i);
  const it0 = c.calcularItem({ ...base, margem: 0 }, P9);
  assert.equal(it0.status, 'bloqueado');
});

test('calcularItem: motivo_bloqueio externo vence tudo', () => {
  const it = c.calcularItem({ ...base, motivo_bloqueio: 'não casado no ERP' }, P9);
  assert.equal(it.status, 'bloqueado');
  assert.equal(it.motivo, 'não casado no ERP');
});

test('calcularItem: piso no custo quando a margem é baixa/negativa', () => {
  const it = c.calcularItem({ ...base, margem: 1, custo_imposto: 11.5 }, PN);
  assert.equal(it.piso, false);                     // 11.5×1.01 = 11.615 → 11.62 ≥ custo
  const it2 = c.calcularItem({ ...base, margem: -10 }, PN);
  assert.equal(it2.preco_sugerido, 11);
  assert.equal(it2.piso, true);
});

test('calcularItem: preço atual 0/null (produto novo) → margem, sobe, margem_se_mantem null', () => {
  const it = c.calcularItem({ ...base, preco_atual: 0, custo_atual: null }, P9);
  assert.equal(it.regra, 'margem');
  assert.equal(it.status, 'sobe');
  assert.equal(it.variacao, null);
  assert.equal(it.margem_se_mantem, null);
  assert.equal(it.preco_sugerido, 14.39);
});

test('calcularItem: L4 com atacado segue a mesma regra', () => {
  const it = c.calcularItem({ ...base, margem_atacado: 10, preco_atacado_atual: 11.5 }, P9);
  assert.deepEqual(it.atacado, { preco_calc: 12.1, preco_sugerido: 12.19, preco_final: 12.19, piso: false });
  const semAt = c.calcularItem({ ...base, margem_atacado: 0, preco_atacado_atual: 11.5 }, P9);
  assert.equal(semAt.atacado, null);
  const desc = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 7, preco_atual: 12.99, margem_atacado: 10, preco_atacado_atual: 11 }, PN);
  assert.equal(desc.regra, 'desconto');
  assert.equal(desc.atacado.preco_sugerido, 9.9);   // 11×0.9
  const mant = c.calcularItem({ ...base, custo_atual: 10, custo_imposto: 9.5, preco_atual: 12.99, margem_atacado: 10, preco_atacado_atual: 11 }, PN);
  assert.equal(mant.regra, 'mantem');
  assert.equal(mant.atacado.preco_sugerido, 11);
});

test('calcularRegistro: recalcula e preserva edição manual', () => {
  const reg = { parametros: P9, entradas: [base, { ...base, cod: '2', custo_imposto: 8 }], itens: [] };
  c.calcularRegistro(reg);
  assert.equal(reg.itens.length, 2);
  reg.itens[0].preco_final = 15.49; reg.itens[0].manual = true;
  c.calcularRegistro(reg);                       // custo igual → mantém
  assert.equal(reg.itens[0].preco_final, 15.49);
  assert.equal(reg.itens[0].manual, true);
  reg.entradas[0] = { ...base, custo_imposto: 12 };
  c.calcularRegistro(reg);                       // custo mudou → descarta
  assert.equal(reg.itens[0].manual, false);
  assert.equal(reg.itens[0].preco_final, reg.itens[0].preco_sugerido);
  reg.itens[1].preco_final = 9.99; reg.itens[1].manual = true;
  c.calcularRegistro(reg, { descartarManuais: true });
  assert.equal(reg.itens[1].manual, false);
});

test('resumo conta status', () => {
  const r = c.resumo([{ status: 'sobe' }, { status: 'desce' }, { status: 'mantem' }, { status: 'sem_mudanca' }, { status: 'bloqueado' }, { status: 'sobe' }]);
  assert.deepEqual(r, { itens: 6, sobem: 2, descem: 1, mantem: 1, sem_mudanca: 1, bloqueados: 1, mudam: 3, piso: 0 });
});

test('resumo: item mantem com piso conta em mudam e em piso', () => {
  const r = c.resumo([{ status: 'sobe' }, { status: 'mantem' }, { status: 'mantem', piso: true }, { status: 'sem_mudanca' }]);
  assert.equal(r.piso, 1);
  assert.equal(r.mudam, 2);
});

test('piso vale também quando mantém: preço atual abaixo do custo novo', () => {
  const mant = c.calcularItem({ ...base, custo_atual: 15, custo_imposto: 13, preco_atual: 12.99 }, PN);
  assert.equal(mant.regra, 'mantem');      // caiu 13%, menos de 20%
  assert.equal(mant.piso, true);
  assert.ok(mant.preco_sugerido >= 13);
  const at = c.calcularItem({ ...base, custo_atual: 15, custo_imposto: 13, preco_atual: 12.99, margem_atacado: 5, preco_atacado_atual: 12.50 }, PN);
  assert.equal(at.atacado.piso, true);
  assert.ok(at.atacado.preco_sugerido >= 13);
});
