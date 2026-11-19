'use strict';
// test/escalas-planilha.test.js — Escalas › Gerar por período (19/11/2026), modelo da planilha da Loja 5:
//   · lib/escalas-planilha.js (motor puro): semana de domingo a sábado, folga fixa, rotativa de quem trabalhou o domingo,
//     rotativa longe da fixa, revezamento e efetivo de domingo, limite de dias e de domingos seguidos;
//   · lib/escalas-periodo.js (serviço): cadastro, aplicar como rascunho só de amanhã em diante, dia manual preservado, desfazer.
// Pastas temporárias: nada aqui toca data/ nem o ponto.
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-planilha-'));
process.env.ESCALAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'escalas-planilha-'));
const test = require('node:test'); const assert = require('node:assert/strict');
const M = require('../lib/escalas-planilha');
const { soma, dow } = M._util;

const quadro = () => {
  const p = []; let id = 0; const add = (grupo, turno, fixas, domingo) => fixas.forEach(fx => p.push({ id: ++id, nome: grupo.toUpperCase() + ' ' + id, grupo, turno, folgaFixa: fx, domingo }));
  add('Caixa', 'T.1', [1, 2, 3, 4], true); add('Caixa', 'T.3', [5, 2, 3, 4, 1, 3, 4, 5], true);
  add('Seção', 'T.1', [1, 2, 3, 4, 5], true); add('Padeiro', 'T.5', [1, 2, 3, 4], true); add('Conferente', 'T.4', [6, 6], false);
  return p;
};
const DE = '2026-11-22', ATE = '2026-12-12';   // domingo a sábado, 3 semanas (o período da planilha)

test('motor não tem dependência (é puro)', () => { const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'escalas-planilha.js'), 'utf8'); assert.ok(!/require\(/.test(src)); });

test('toda semana completa fecha em 5 dias de trabalho, com folga fixa no dia da pessoa', () => {
  const r = M.gerar({ de: DE, ate: ATE, pessoas: quadro(), efetivoDomingo: { Caixa: 8, 'Seção': 3, Padeiro: 2 } });
  assert.equal(r.dias.length, 21); assert.equal(r.resumo.semanasCompletas, 3); assert.equal(r.resumo.semanasFora, 0);
  for (const l of r.linhas) {
    for (const s of l.semanas) assert.equal(s.trabalhados, 5, l.nome + ' ' + s.inicio);
    for (const d of r.dias) if (dow(d) === l.folgaFixa) assert.deepEqual([l.dias[d].tipo, l.dias[d].folga], ['folga', 'fixa']);
    assert.equal(l.minutos, 15 * 504);                                     // 15 dias × 8h24 = 42 h por semana
  }
});

test('quem trabalha o domingo ganha UMA rotativa na mesma semana; quem folga o domingo não ganha', () => {
  const r = M.gerar({ de: DE, ate: ATE, pessoas: quadro(), efetivoDomingo: { Caixa: 8, 'Seção': 3, Padeiro: 2 } });
  for (const l of r.linhas) for (const s of l.semanas) {
    const sem = [1, 2, 3, 4, 5, 6].map(i => soma(s.inicio, i)); const rot = sem.filter(d => l.dias[d].folga === 'rotativa');
    if (l.dias[s.inicio].tipo === 'trabalho') { assert.equal(rot.length, 1, l.nome + ' trabalhou ' + s.inicio); assert.notEqual(dow(rot[0]), l.folgaFixa); }
    else { assert.equal(rot.length, 0, l.nome + ' folgou ' + s.inicio); assert.equal(l.dias[s.inicio].folga, 'domingo'); }
  }
});

test('rotativa não cola na folga fixa quando há outro dia, e o efetivo de domingo é respeitado', () => {
  const r = M.gerar({ de: DE, ate: ATE, pessoas: quadro(), efetivoDomingo: { Caixa: 8, 'Seção': 3, Padeiro: 2 } });
  assert.equal(r.resumo.coladas, 0);
  for (const d of r.dias.filter(x => dow(x) === 0)) { assert.equal(r.porDia[d].porGrupo.Caixa.trabalhando, 8); assert.equal(r.porDia[d].porGrupo['Seção'].trabalhando, 3); assert.equal(r.porDia[d].porGrupo.Padeiro.trabalhando, 2); assert.equal(r.porDia[d].porGrupo.Conferente.trabalhando, 0); }
});

test('domingo: turno de fechamento vira o turno de domingo (T.3 → T.4) e os demais ficam', () => {
  const r = M.gerar({ de: DE, ate: ATE, pessoas: quadro() });
  for (const l of r.linhas) for (const d of r.dias) { const c = l.dias[d]; if (c.tipo !== 'trabalho') continue; assert.equal(c.turno, dow(d) === 0 && l.turno === 'T.3' ? 'T.4' : l.turno); }
});

test('revezamento: ninguém passa de 2 domingos seguidos nem de 6 dias seguidos, e os domingos se dividem', () => {
  const r = M.gerar({ de: DE, ate: soma(DE, 55), pessoas: quadro(), efetivoDomingo: { Caixa: 8, 'Seção': 3, Padeiro: 2 } });   // 8 semanas
  assert.ok(r.resumo.maiorSequencia <= 6, 'sequência ' + r.resumo.maiorSequencia);
  const doms = r.dias.filter(d => dow(d) === 0);
  for (const l of r.linhas.filter(x => x.domingo)) { let run = 0; for (const d of doms) { run = l.dias[d].tipo === 'trabalho' ? run + 1 : 0; assert.ok(run <= 2, l.nome + ' 3 domingos seguidos'); } }
  const caixa = r.linhas.filter(l => l.grupo === 'Caixa').map(l => l.domingosTrabalhados); assert.ok(Math.max(...caixa) - Math.min(...caixa) <= 1, 'domingos desiguais: ' + caixa.join(','));
});

test('função com uma pessoa só: descansa depois de 2 domingos seguidos e o domingo descoberto vira alerta', () => {
  const r = M.gerar({ de: DE, ate: ATE, pessoas: [{ id: 1, nome: 'ROSA', grupo: 'CPD', turno: 'T.1', folgaFixa: 6 }], efetivoDomingo: { CPD: 1 } });
  const doms = r.dias.filter(d => dow(d) === 0).map(d => r.linhas[0].dias[d].tipo); assert.deepEqual(doms, ['trabalho', 'trabalho', 'folga']);
  assert.ok(r.alertas.some(a => a.codigo === 'domingo_sem_revezamento'));
});

test('sem folga fixa ou sem turno: o motor sugere (dia mais vazio da função), avisa e a semana continua 5×2', () => {
  const p = quadro(); p[0].folgaFixa = null; p[1].turno = null;
  const r = M.gerar({ de: DE, ate: ATE, pessoas: p });
  assert.equal(r.linhas[0].fixaSugerida, true); assert.ok(r.linhas[0].folgaFixa >= 1 && r.linhas[0].folgaFixa <= 6); assert.equal(r.linhas[1].turnoSugerido, true);
  assert.ok(r.alertas.some(a => a.codigo === 'sem_folga_fixa' && a.id === 1)); assert.ok(r.alertas.some(a => a.codigo === 'sem_turno' && a.id === 2)); assert.equal(r.resumo.semanasFora, 0);
});

test('férias no período: os dias saem como férias e não contam como semana fora do 5×2', () => {
  const p = quadro(); p[0].ausencias = [{ inicio: '2026-11-25', fim: '2026-12-04', tipo: 'ferias' }];
  const r = M.gerar({ de: DE, ate: ATE, pessoas: p });
  assert.equal(r.linhas[0].dias['2026-11-30'].tipo, 'ferias'); assert.equal(r.linhas[0].dias['2026-11-29'].tipo, 'ferias'); assert.equal(r.resumo.semanasFora, 0);
});

test('período que começa no meio da semana usa o que já aconteceu (domingo trabalhado → rotativa nos dias que restam)', () => {
  const p = [{ id: 1, nome: 'ANA', grupo: 'Caixa', turno: 'T.1', folgaFixa: 2 }, { id: 2, nome: 'BIA', grupo: 'Caixa', turno: 'T.1', folgaFixa: 3 }];
  const hist = { 1: { '2026-11-22': 'T', '2026-11-23': 'T', '2026-11-24': 'F' }, 2: { '2026-11-22': 'F', '2026-11-23': 'T', '2026-11-24': 'T' } };
  const r = M.gerar({ de: '2026-11-25', ate: '2026-11-28', pessoas: p, historico: hist });
  const rot = id => r.dias.filter(d => r.linhas[id - 1].dias[d].folga === 'rotativa');
  assert.equal(rot(1).length, 1); assert.notEqual(rot(1)[0], '2026-11-25');   // trabalhou o domingo: compensa, e não colado na fixa de terça
  assert.equal(rot(2).length, 0);                                           // folgou o domingo: só a fixa
  assert.ok(!r.alertas.some(a => a.codigo === 'semana_em_andamento'));
  const r2 = M.gerar({ de: '2026-11-25', ate: '2026-11-28', pessoas: p }); assert.ok(r2.alertas.some(a => a.codigo === 'semana_em_andamento'));
});

test('período inválido ou longo demais é recusado', () => {
  assert.throws(() => M.gerar({ de: '2026-12-10', ate: '2026-12-01', pessoas: quadro() }), /Período inválido/);
  assert.throws(() => M.gerar({ de: '2026-01-01', ate: '2026-12-31', pessoas: quadro() }), /longo demais/);
});

test('cores e códigos são os da planilha', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(M.TURNOS_PADRAO).map(([k, t]) => [k, t.cor])), { 'T.1': '#FFE699', 'T.2': '#009DE0', 'T.3': '#80207E', 'T.4': '#FFED00', 'T.5': '#A2C037' });
  assert.equal(M.COR_FOLGA, '#07973E'); assert.equal(M.corTexto('#80207E'), '#FFFFFF'); assert.equal(M.corTexto('#FFE699'), '#14213D');
  assert.equal(M.codigoDoHorario(M.TURNOS_PADRAO, { tipo: 'trabalho', entrada: '09:36', saida: '20:00' }), 'T.3'); assert.equal(M.codigoDoHorario(M.TURNOS_PADRAO, { tipo: 'trabalho', entrada: '07:30', saida: '16:30' }), null);
});

// ── serviço ──────────────────────────────────────────────────────────────────────────────────────────────
const GP = require('../lib/gestao-pessoas'); const E = require('../lib/escalas'); const S = require('../lib/escalas-periodo');
const gerente = { usuario: 'ger5', nome: 'Gerente E5' }, outro = { usuario: 'alguem', nome: 'Sem papel' };
const cfgGP = GP.config(); cfgGP.designados = [{ usuario: 'ger5', nome: 'Gerente E5', papeis: ['gerente'], lojas: [5] }, { usuario: 'alguem', nome: 'Sem papel', papeis: ['diretoria'], lojas: [] }];
fs.writeFileSync(path.join(process.env.GP_DIR, 'config.json'), JSON.stringify(cfgGP)); if (GP.recarregar) GP.recarregar();
const base = () => { const b = {}; for (let w = 0; w < 7; w++) b[w] = w === 0 ? null : { entrada: '07:30', saida: '16:30', almoco_ini: null, almoco_fim: null }; return b; };
const func = (id, nome, setor) => ({ id, nome, matricula: '', cargo: 'OPERADOR DE CAIXA', setor_pc: setor, setor, turno: '', base: base(), folga_fixa: [0], habilitado: [] });
const novoMes = mes => E.salvar({ loja: 5, mes, status: 'rascunho', versao: 1, origem: 'pontocerto', demo: false, criadoEm: new Date().toISOString(), criadoPor: 'teste', funcionarios: [func(101, 'ANA', 'FRENTE DE CAIXA'), func(102, 'BIA', 'FRENTE DE CAIXA'), func(103, 'CAIO', 'FRENTE DE CAIXA'), func(104, 'DUDA', 'FRENTE DE CAIXA')], dias: {}, historico: [], fluxo: [], versoes: [] });
const CTX = { hoje: '2026-11-19', afast: new Map() };

test('serviço: gerente da loja grava o cadastro; quem não é da loja não grava', async () => {
  assert.ok(GP.gerenteDa(gerente, 5));
  novoMes('2026-11'); novoMes('2026-12');
  assert.throws(() => S.salvarCadastro(outro, 5, {}), /Só o gerente/);
  S.salvarCadastro(gerente, 5, { pessoas: [{ id: 101, turno: 'T.1', folgaFixa: 2, domingo: true, grupo: 'Caixa' }, { id: 102, turno: 'T.3', folgaFixa: 4, domingo: true, grupo: 'Caixa' }, { id: 103, turno: 'T.1', folgaFixa: 3, domingo: true, grupo: 'Caixa' }, { id: 104, turno: 'T.3', folgaFixa: 5, domingo: true, grupo: 'Caixa' },
    { extra: true, nome: 'contratar', grupo: 'Caixa', setor: 'FRENTE DE CAIXA', turno: 'T.2', folgaFixa: 1, domingo: true, vaga: true }], efetivoDomingo: { Caixa: 3 } });
  const c = await S.cadastro(gerente, 5, CTX); assert.equal(c.pessoas.length, 5); assert.equal(c.pessoas.filter(p => p.extra && p.vaga).length, 1); assert.equal(c.grupos[0].efetivoDomingo, 3); assert.ok(c.pessoas.every(p => p.cadastrado));
  assert.throws(() => S.salvarCadastro(gerente, 5, { turnos: [{ codigo: 'T.1', entrada: '10:00', saida: '09:00', cor: '#FFE699' }] }), /Horário inválido/);
});

test('serviço: gerar não grava nada; aplicar grava rascunho só de amanhã em diante, preserva dia manual e pinta a coletiva', async () => {
  const r = await S.gerar(gerente, 5, '2026-11-15', '2026-12-05', CTX); assert.equal(r.linhas.length, 5); assert.equal(Object.keys(E.ler(5, '2026-11').dias).length, 0); assert.equal(S.visual(5).ativo, false);
  const e = E.ler(5, '2026-11'); e.dias['101|2026-11-25'] = { tipo: 'trabalho', entrada: '08:00', saida: '17:00', almoco_ini: null, almoco_fim: null, setor: 'FRENTE DE CAIXA', obs: 'troca' }; E.salvar(e);
  await assert.rejects(S.aplicar(gerente, 5, { de: '2026-11-15', ate: '2026-12-05', justificativa: 'curta' }, CTX), /justificativa/);
  await assert.rejects(S.aplicar(outro, 5, { de: '2026-11-15', ate: '2026-12-05', justificativa: 'escala de dezembro da loja' }, CTX), /Só o gerente/);
  const a = await S.aplicar(gerente, 5, { de: '2026-11-15', ate: '2026-12-05', justificativa: 'escala de dezembro da loja' }, CTX);
  assert.equal(a.aPartirDe, '2026-11-20'); assert.equal(a.preservados, 1); assert.deepEqual(a.meses, ['2026-11', '2026-12']);
  const n = E.ler(5, '2026-11'), d = E.ler(5, '2026-12');
  assert.ok(!Object.keys(n.dias).some(k => k.split('|')[1] <= '2026-11-19'), 'gravou dia passado'); assert.equal(n.dias['101|2026-11-25'].obs, 'troca');
  const dia = n.dias['102|2026-11-23']; assert.equal(dia.origem, 'gerador'); assert.equal(dia.modelo, 'planilha'); assert.ok(dia.tipo === 'folga' || dia.turno === 'T.3');
  assert.ok(n.funcionarios.some(f => f.extra && f.vaga && /^CONTRATAR/.test(f.nome)) && d.funcionarios.some(f => f.extra)); assert.equal(n.status, 'rascunho'); assert.ok(n.fluxo[n.fluxo.length - 1].texto.includes('modelo da planilha'));
  assert.equal(S.visual(5).ativo, true); assert.equal(S.modeloNoMes(5, '2026-12'), true); assert.equal(S.listarGeracoes(5).length, 1);
  // a pessoa prevista entra na grade com os dias dela e não é duplicada numa segunda geração
  const r2 = await S.gerar(gerente, 5, '2026-12-06', '2026-12-12', CTX); assert.equal(r2.linhas.length, 5);
});

test('serviço: desfazer devolve os dias da geração e deixa quieto o que foi mexido depois', async () => {
  const g = S.listarGeracoes(5)[0]; const e = E.ler(5, '2026-12'); const k = Object.keys(e.dias).find(x => x.startsWith('103|')); e.dias[k] = { ...e.dias[k], geracao: null, origem: 'manual' }; E.salvar(e);
  const r = S.desfazer(gerente, 5, g.id, 'gerada com o efetivo errado'); assert.equal(r.ficaram, 1); assert.ok(r.voltou > 50);
  assert.equal(Object.keys(E.ler(5, '2026-12').dias).length, 1); assert.equal(E.ler(5, '2026-11').dias['101|2026-11-25'].obs, 'troca'); assert.equal(Object.keys(E.ler(5, '2026-11').dias).length, 1);
  assert.throws(() => S.desfazer(gerente, 5, g.id, 'de novo, por engano'), /já foi desfeita/);
});
