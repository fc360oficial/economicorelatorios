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

test('visão compacta: toda jornada ganha código; horário novo vira T.6 e fica gravado com o mesmo código e cor', () => {
  const dia = (en, sa, ai, af) => ({ tipo: 'trabalho', entrada: en, saida: sa, almoco_ini: ai || null, almoco_fim: af || null });
  const funcs = () => [{ id: 1, dias: { a: dia('07:00', '17:24', '11:00', '13:00'), b: dia('07:30', '16:30'), c: { tipo: 'folga' } } }, { id: 2, dias: { a: dia('07:30', '16:30'), b: dia('08:00', '18:00', '12:00', '14:00') } }];
  const f1 = funcs(); const r = S.codificar(6, f1);
  assert.equal(f1[0].dias.a.cod, 'T.1'); assert.equal(f1[0].dias.b.cod, 'T.6'); assert.equal(f1[1].dias.a.cod, 'T.6'); assert.equal(f1[1].dias.b.cod, 'T.7'); assert.equal(f1[0].dias.c.cod, undefined);
  const t6 = r.turnos.find(t => t.codigo === 'T.6'); assert.equal(t6.entrada, '07:30'); assert.equal(t6.n, 2); assert.equal(r.turnos.find(t => t.codigo === 'T.1').cor, '#FFE699'); assert.equal(r.corFolga, '#07973E');
  const f2 = funcs().reverse(); const r2 = S.codificar(6, f2);   // outra ordem, outro mês: os códigos e as cores não mudam
  assert.equal(f2[0].dias.b.cod, 'T.7'); assert.equal(f2[1].dias.b.cod, 'T.6'); assert.equal(r2.turnos.find(t => t.codigo === 'T.6').cor, t6.cor); assert.equal(r2.turnos.length, r.turnos.length);
});

test('Gerador 5x2 com turno da planilha: a jornada é exatamente a do turno (domingo = turno de domingo) e a entrada nunca passa de 24 h', () => {
  const G = require('../lib/escalas-gerador'); const T = M.TURNOS_PADRAO; const tf = k => ({ codigo: k, ...T[k], domingo: { codigo: T[k].domingo, ...T[T[k].domingo] } });
  const base = {}; for (let w = 0; w < 7; w++) base[w] = w === 0 ? null : { entrada: '07:30', saida: '16:30', almoco_ini: null, almoco_fim: null };
  const funcs = [1, 2, 3, 4, 5, 6].map(i => ({ id: i, nome: 'P' + i, setor: 'FRENTE DE CAIXA', estabelecimento: 5, folga_fixa: (i % 5) + 1, base, entrada: T[i % 2 ? 'T.3' : 'T.1'].entrada, turnoFixo: tf(i % 2 ? 'T.3' : 'T.1'), restricoes: {}, ausencias: [] }));
  const r = G.gerar({ de: '2026-12-21', ate: '2027-01-17', funcionarios: funcs, regras: [{ id: 'R', validada: true, params: { descansoSemanalMin: 4200, intervaloMin: 120 } }], cobertura: { abre: '07:00', fecha: '20:00', setores: { 'FRENTE DE CAIXA': { min: 1 } }, entradas: [] }, feriados: [] });
  const horarios = new Set(); let dias = 0;
  for (const p of r.proposta) for (const [d, c] of Object.entries(p.dias)) { if (c.tipo !== 'trabalho') continue; dias++; horarios.add(c.entrada + '-' + c.saida + '/' + c.almoco_ini + '-' + c.almoco_fim); assert.ok(c.entrada < '24:00' && c.entrada < c.saida, p.nome + ' ' + d + ' ' + c.entrada);
    const t = funcs.find(f => f.id === p.id).turnoFixo, esperado = new Date(d + 'T12:00:00').getDay() === 0 ? t.domingo : t; assert.equal(c.entrada + '-' + c.saida, esperado.entrada + '-' + esperado.saida, p.nome + ' ' + d); assert.equal(c.almoco_ini, esperado.almoco_ini); }
  assert.ok(dias > 80, 'gerou ' + dias + ' dias'); assert.ok(horarios.size <= 4, 'horários distintos: ' + [...horarios].join(' '));
});

test('serviço: quem era linha prevista e entrou no ponto herda turno, folga fixa e função; a escala sai organizada por função', async () => {
  S.salvarCadastro(gerente, 5, { pessoas: [{ id: 101, turno: 'T.1', folgaFixa: 2, domingo: true, grupo: 'Caixa' }, { id: 102, turno: 'T.3', folgaFixa: 4, domingo: true, grupo: 'Seção' }, { extra: true, nome: 'Zeca Novo', grupo: 'Caixa', setor: 'FRENTE DE CAIXA', turno: 'T.2', folgaFixa: 5, domingo: true }] });
  const novo = { id: 777, nome: 'ZECA NOVO', cargo: 'OPERADOR DE LOJA', setor: 'BALCAO', base: {} };
  const tf = S.turnoFixoDe(5, novo); assert.equal(tf.codigo, 'T.2'); assert.equal(tf.folgaFixa, 5); assert.equal(tf.domingo.codigo, 'T.1'); assert.equal(tf.sugerido, false);
  const semCad = S.turnoFixoDe(5, { id: 888, nome: 'OUTRO', base: { 1: { entrada: '09:30', saida: '19:00' } } }); assert.equal(semCad.codigo, 'T.3'); assert.equal(semCad.sugerido, true);
  // 19/11/2026 (Donato/Tiago: "somente esse modelo; replique para todas as lojas e o CD"): unidade sem cadastro gravado também
  // usa os turnos do modelo — o mais parecido com a jornada de contrato (entrada + saída), como sugestão — e sai organizada por função
  const outra = S.turnoFixoDe(6, { id: 901, nome: 'FULANO', base: { 1: { entrada: '09:00', saida: '20:00' } } }); assert.equal(outra.codigo, 'T.3'); assert.equal(outra.sugerido, true); assert.equal(outra.folgaFixa, null); assert.equal(outra.domingo.codigo, 'T.4');   // fecha às 20h: turno de fechamento
  assert.equal(S.turnoFixoDe(6, { id: 903, nome: 'BELTRANA', base: { 1: { entrada: '08:00', saida: '19:00' } } }).codigo, 'T.2');
  assert.equal(S.turnoFixoDe(6, { id: 904, nome: 'CICRANO', base: { 1: { entrada: '07:00', saida: '17:00' } } }).codigo, 'T.1');
  assert.equal(S.turnoFixoDe(10, { id: 902, nome: 'DO CD', base: { 2: { entrada: '06:00', saida: '16:00' } } }).codigo, 'T.5');
  assert.equal(S.turnoFixoDe(6, novo).codigo, 'T.1');                       // sem jornada no ponto: o primeiro turno, ainda como sugestão
  const rede = S.organizar(3, [{ id: 1, nome: 'GIL', cargo: 'GERENTE', setor: 'ADMINISTRATIVO' }, { id: 2, nome: 'ROSA', cargo: 'OPERADOR DE LOJA', setor: 'REPOSICAO' }, { id: 3, nome: 'LIA', cargo: 'OPERAODR DE CAIXA', setor: 'FRENTE DE CAIXA' },
    { id: 4, nome: 'ANA', cargo: 'OPERADORA DE CAIXA', setor: 'FRENTE DE CAIXA' }, { id: 5, nome: 'TOM', cargo: 'MOTORISTA', setor: 'OUTROS' }, { id: 6, nome: 'JOÃO', cargo: 'AÇOUGUEIRO', setor: 'ACOUGUE' }, { id: 7, nome: 'BETO', cargo: 'AUX. DE SERVIÇOS GERAIS', setor: 'OUTROS' }]);
  assert.deepEqual(rede.map(x => x.nome + ':' + x.grupo), ['ANA:Caixa', 'LIA:Caixa', 'ROSA:Operador de Loja', 'JOÃO:Açougue', 'BETO:ASG', 'TOM:Motorista', 'GIL:Gerente']);
  const ord = S.organizar(5, [{ id: 102, nome: 'BIA', cargo: 'X', setor: 'REPOSICAO' }, novo, { id: 101, nome: 'ANA', cargo: 'X', setor: 'FRENTE DE CAIXA' }]);
  assert.deepEqual(ord.map(x => x.nome + ':' + x.grupo), ['ANA:Caixa', 'ZECA NOVO:Caixa', 'BIA:Seção']);
});

test('cadastro: turno novo, pessoa fora da escala, troca de turno de uma pessoa e de um dia só (ajuste à mão auditado)', async () => {
  const c0 = await S.cadastro(gerente, 5, CTX); const pessoas = c0.pessoas.map(p => ({ ...p, fora: p.id === 102 }));
  S.salvarCadastro(gerente, 5, { pessoas, turnos: c0.turnos.concat([{ codigo: 'T.6', cor: '#F4B183', entrada: '10:00', saida: '20:24', almoco_ini: '14:00', almoco_fim: '16:00', domingo: 'T.4' }]) });
  const c1 = await S.cadastro(gerente, 5, CTX); assert.ok(c1.turnos.some(t => t.codigo === 'T.6')); assert.equal(c1.pessoas.find(p => p.id === 102).fora, true); assert.equal(S.foraDaEscala(5, { id: 102 }), true);
  assert.ok(c1.quadro.every(q => q.total >= 1) && !c1.quadro.some(q => q.grupo === 'Seção'), 'quem está fora não conta no quadro por função');
  const r = await S.gerar(gerente, 5, '2026-12-13', '2026-12-19', CTX); assert.ok(!r.linhas.some(l => l.id === 102), 'fora da escala não é gerado');
  assert.throws(() => S.salvarCadastro(gerente, 5, { pessoas: c1.pessoas.map(p => ({ ...p, turno: p.id === 101 ? 'T.6' : p.turno })), turnos: c1.turnos.filter(t => t.codigo !== 'T.6') }), /saiu da tabela/);
  await S.salvarPessoa(gerente, 5, { id: 101, turno: 'T.6', folgaFixa: 3 }, CTX); assert.equal(S.turnoFixoDe(5, { id: 101, nome: 'ANA', base: {} }).codigo, 'T.6'); assert.equal(S.turnoFixoDe(5, { id: 101, nome: 'ANA', base: {} }).domingo.codigo, 'T.4');
  await assert.rejects(S.salvarPessoa(outro, 5, { id: 101, turno: 'T.1' }, CTX), /Só o gerente/);
  await assert.rejects(S.editarDiaTurno(gerente, 5, { funcId: 101, data: '2026-12-15', turno: 'T.2', justificativa: '' }, CTX), /justificativa/i);
  await S.editarDiaTurno(gerente, 5, { funcId: 101, data: '2026-12-15', turno: 'T.2', justificativa: 'troca combinada com a gerência' }, CTX);
  const d = E.ler(5, '2026-12').dias['101|2026-12-15']; assert.equal(d.entrada + '-' + d.saida, '08:30-18:54'); assert.notEqual(d.origem, 'gerador'); assert.ok(E.ler(5, '2026-12').historico.some(h => h.data === '2026-12-15' && h.funcId === 101));
  await assert.rejects(S.editarDiaTurno(gerente, 5, { funcId: -9001, data: '2026-12-15', turno: 'T.2', justificativa: 'vaga' }, CTX), /todos os dias/);
});
test('ocupar a vaga: quem é escolhido assume função, turno, folga fixa e os dias da linha CONTRATAR; a vaga sai do "faltando contratar"', async () => {
  for (const mes of ['2026-11', '2026-12']) { const e = E.ler(5, mes); e.funcionarios.push(func(105, 'EVA', 'FRENTE DE CAIXA')); E.salvar(e); }
  S.salvarCadastro(gerente, 5, { pessoas: [{ id: 101, turno: 'T.1', folgaFixa: 2, domingo: true, grupo: 'Caixa' }, { id: 102, turno: 'T.3', folgaFixa: 4, domingo: true, grupo: 'Seção' },
    { extra: true, nome: 'caixa', grupo: 'Caixa', setor: 'FRENTE DE CAIXA', turno: 'T.2', folgaFixa: 1, domingo: true, vaga: true }, { extra: true, nome: 'padeiro', grupo: 'Padeiro', setor: 'PADARIA', turno: 'T.5', folgaFixa: 3, domingo: true, vaga: true },
    { extra: true, nome: 'seção', grupo: 'Seção', setor: 'REPOSICAO', turno: 'T.4', folgaFixa: 6, domingo: true, vaga: true }] });
  await S.aplicar(gerente, 5, { de: '2026-12-06', ate: '2026-12-19', justificativa: 'escala com as três vagas em aberto' }, CTX);
  const vaga = g => S.lojaCfg(5).extras.find(x => x.vaga && x.grupo === g); const vCx = vaga('Caixa'), vPd = vaga('Padeiro'), vSe = vaga('Seção'); assert.ok(vCx && vPd && vSe); assert.equal(S.faltando(gerente).total, 3);
  const dez = () => E.ler(5, '2026-12'); assert.ok(dez().funcionarios.some(f => f.id === vCx.id && /^CONTRATAR/.test(f.nome)));
  // recusas: sem papel, vaga que não existe, ninguém escolhido, pessoa de fora do quadro, escala em aprovação
  await assert.rejects(S.ocuparVaga(outro, 5, { id: vCx.id, funcId: 105 }, CTX), /Só o gerente/);
  await assert.rejects(S.ocuparVaga(gerente, 5, { id: -1, funcId: 105 }, CTX), /Vaga não encontrada/);
  await assert.rejects(S.ocuparVaga(gerente, 5, { id: vCx.id }, CTX), /Escolha o funcionário/);
  await assert.rejects(S.ocuparVaga(gerente, 5, { id: vCx.id, funcId: 999 }, CTX), /não está no quadro/);
  dez().status = 'enviada_rh'; await assert.rejects(S.ocuparVaga(gerente, 5, { id: vCx.id, funcId: 105 }, CTX), /em aprovação/); dez().status = 'rascunho'; assert.ok(vaga('Caixa'), 'recusa não mexe no cadastro');
  // 1) pessoa do ponto sem posição: assume a vaga inteira e a linha CONTRATAR some
  const diaV = JSON.parse(JSON.stringify(dez().dias[vCx.id + '|2026-12-08']));
  const r1 = await S.ocuparVaga(gerente, 5, { id: vCx.id, funcId: 105, abrirVaga: true }, CTX); assert.equal(r1.nome, 'EVA'); assert.equal(r1.grupo, 'Caixa'); assert.ok(r1.dias >= 10); assert.equal(r1.abriuVaga, null, 'quem não tinha posição não deixa vaga');
  assert.deepEqual(S.lojaCfg(5).pessoas[105], { turno: 'T.2', folgaFixa: 1, domingo: true, grupo: 'Caixa', ordem: vCx.ordem }); assert.equal(vaga('Caixa'), undefined); assert.equal(S.faltando(gerente).total, 2);
  assert.deepEqual(dez().dias['105|2026-12-08'], diaV); assert.ok(!dez().funcionarios.some(f => f.id === vCx.id)); assert.ok(!Object.keys(dez().dias).some(k => k.startsWith(vCx.id + '|')));
  assert.ok(dez().fluxo[dez().fluxo.length - 1].texto.includes('EVA passou a ocupar a vaga de Caixa')); assert.equal(S.turnoFixoDe(5, { id: 105, nome: 'EVA', base: {} }).codigo, 'T.2');
  // 2) pessoa que já tinha posição, abrindo vaga no lugar: as duas linhas trocam os dias e a vaga passa a ser a da função antiga
  { const e = dez(); e.dias['101|2026-12-15'] = { tipo: 'folga', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: 'FRENTE DE CAIXA', obs: 'consulta', origem: 'manual' }; E.salvar(e); }
  const antP = JSON.parse(JSON.stringify(dez().dias['101|2026-12-09'])), antV = JSON.parse(JSON.stringify(dez().dias[vPd.id + '|2026-12-09']));
  const r2 = await S.ocuparVaga(gerente, 5, { id: vPd.id, funcId: 101, abrirVaga: true }, CTX); assert.equal(r2.abriuVaga, 'Caixa'); assert.equal(r2.preservados, 1);
  assert.equal(S.lojaCfg(5).pessoas[101].grupo, 'Padeiro'); assert.equal(S.lojaCfg(5).pessoas[101].turno, 'T.5'); assert.equal(S.lojaCfg(5).pessoas[101].folgaFixa, 3);
  const nova = S.lojaCfg(5).extras.find(x => x.id === vPd.id); assert.deepEqual([nova.vaga, nova.grupo, nova.turno, nova.folgaFixa, nova.nome], [true, 'Caixa', 'T.1', 2, 'CAIXA']); assert.equal(S.faltando(gerente).total, 2);
  assert.deepEqual(dez().dias['101|2026-12-09'], antV); assert.deepEqual(dez().dias[vPd.id + '|2026-12-09'], antP); assert.equal(dez().dias['101|2026-12-15'].obs, 'consulta'); assert.equal(dez().funcionarios.find(f => f.id === vPd.id).nome, 'CONTRATAR · CAIXA');
  // 3) quem ainda não está no ponto: a linha deixa de ser vaga e leva o nome
  const r3 = await S.ocuparVaga(gerente, 5, { id: vSe.id, nome: 'joão da silva' }, CTX); assert.equal(r3.nome, 'JOÃO DA SILVA');
  const lin = S.lojaCfg(5).extras.find(x => x.id === vSe.id); assert.equal(lin.vaga, false); assert.equal(lin.nome, 'JOÃO DA SILVA'); assert.equal(lin.turno, 'T.4');
  const row = dez().funcionarios.find(f => f.id === vSe.id); assert.equal(row.nome, 'JOÃO DA SILVA'); assert.equal(row.vaga, false); assert.ok(dez().dias[vSe.id + '|2026-12-09']); assert.equal(S.faltando(gerente).total, 1);
  await assert.rejects(S.ocuparVaga(gerente, 5, { id: vSe.id, funcId: 102 }, CTX), /Vaga não encontrada/);
});

test('mover funcionário: muda de função/setor ou de loja; a posição que fica vira vaga a contratar, fica em aberto ou não é mantida', async () => {
  const cg = GP.config(); cg.designados.push({ usuario: 'coord', nome: 'Coordenação', papeis: ['coordenacao'], lojas: [] }); fs.writeFileSync(path.join(process.env.GP_DIR, 'config.json'), JSON.stringify(cg)); if (GP.recarregar) GP.recarregar();
  const coord = { usuario: 'coord', nome: 'Coordenação' }; assert.ok(S.podeCadastrar(coord, 6) && !S.podeCadastrar(gerente, 6));
  const c0 = await S.cadastro(gerente, 5, CTX); const bia = c0.pessoas.find(p => p.id === 102); assert.deepEqual([bia.grupo, bia.turno, bia.folgaFixa], ['Seção', 'T.3', 4]);
  // recusas: sem papel, sem dizer o que fica no lugar, nada mudou, loja de destino onde quem pede não cadastra
  await assert.rejects(S.moverPessoa(outro, 5, { id: 102, grupo: 'Caixa', turno: 'T.1', folgaFixa: 2, noLugar: 'vaga' }, CTX), /Só o gerente/);
  await assert.rejects(S.moverPessoa(gerente, 5, { id: 102, grupo: 'Caixa', turno: 'T.1', folgaFixa: 2 }, CTX), /posição que fica/);
  await assert.rejects(S.moverPessoa(gerente, 5, { id: 102, grupo: 'Seção', turno: 'T.3', folgaFixa: 4, noLugar: 'vaga' }, CTX), /Nada mudou/);
  await assert.rejects(S.moverPessoa(gerente, 5, { id: 102, paraLoja: 6, grupo: 'Caixa', turno: 'T.1', folgaFixa: 2, noLugar: 'vaga' }, CTX), /não altera o cadastro da escala/);
  await assert.rejects(S.moverPessoa(gerente, 5, { id: 999, grupo: 'Caixa', turno: 'T.1', folgaFixa: 2, noLugar: 'vaga' }, CTX), /não está no quadro/);
  // 1) mesma loja, outro setor, deixando a posição EM ABERTO: não entra no "faltando contratar", mas a linha fica na escala
  const antes = S.faltando(gerente);
  const r1 = await S.moverPessoa(gerente, 5, { id: 102, grupo: 'Caixa', setor: 'BALCAO', turno: 'T.1', folgaFixa: 2, noLugar: 'aberto' }, CTX); assert.equal(r1.noLugar, 'aberto'); assert.equal(r1.outraLoja, false); assert.ok(r1.gradesSalvas.includes('2026-12'), 'avisa que a escala salva não mudou');
  const p102 = S.lojaCfg(5).pessoas[102]; assert.deepEqual([p102.grupo, p102.turno, p102.folgaFixa, p102.setor], ['Caixa', 'T.1', 2, 'BALCAO']); assert.equal(S.setorDe(5, { id: 102 }), 'BALCAO');
  const ab = S.lojaCfg(5).extras.find(x => x.id === r1.vaga); assert.deepEqual([ab.vaga, ab.aberto, ab.grupo, ab.turno, ab.folgaFixa], [true, true, 'Seção', 'T.3', 4]); assert.equal(S.rotuloLinha(ab), 'EM ABERTO · SEÇÃO');
  const f1 = S.faltando(gerente); assert.equal(f1.total, antes.total); assert.equal(f1.emAberto, antes.emAberto + 1); assert.ok(f1.lojas[0].itens.some(i => i.id === r1.vaga && i.aberto));
  assert.ok(S.previstas(5, E.ler(5, '2026-12').funcionarios).some(x => x.nomeNaEscala === 'EM ABERTO · SEÇÃO'));
  // salvar o cadastro pela tela não perde o setor da escala nem o "em aberto"; trocar o tipo para "a contratar" passa a contar
  const c1 = await S.cadastro(gerente, 5, CTX); assert.equal(c1.pessoas.find(p => p.id === 102).setorNaEscala, true); assert.equal(c1.pessoas.find(p => p.id === r1.vaga).aberto, true);
  S.salvarCadastro(gerente, 5, { pessoas: c1.pessoas }); assert.equal(S.lojaCfg(5).pessoas[102].setor, 'BALCAO'); assert.equal(S.lojaCfg(5).extras.find(x => x.id === r1.vaga).aberto, true);
  S.salvarCadastro(gerente, 5, { pessoas: c1.pessoas.map(p => (p.id === r1.vaga ? { ...p, aberto: false } : p)) }); assert.equal(S.lojaCfg(5).extras.find(x => x.id === r1.vaga).aberto, undefined); assert.equal(S.faltando(gerente).total, antes.total + 1);
  // 2) outra loja, abrindo vaga a contratar: sai da escala daqui (transferido) e entra na de lá como linha com o nome
  const tot = S.faltando(coord).total;
  const r2 = await S.moverPessoa(coord, 5, { id: 103, paraLoja: 6, grupo: 'Caixa', setor: 'FRENTE DE CAIXA', turno: 'T.3', folgaFixa: 5, noLugar: 'vaga' }, CTX); assert.equal(r2.outraLoja, true); assert.equal(r2.para.loja, 6);
  const p103 = S.lojaCfg(5).pessoas[103]; assert.equal(p103.fora, true); assert.equal(p103.transferido.para, 6); assert.equal(S.foraDaEscala(5, { id: 103 }), true);
  const vg = S.lojaCfg(5).extras.find(x => x.id === r2.vaga); assert.deepEqual([vg.vaga, vg.aberto, vg.grupo], [true, undefined, 'Caixa']); assert.equal(S.faltando(coord).total, tot + 1);
  const la = S.lojaCfg(6).extras.find(x => x.funcId === 103); assert.deepEqual([la.nome, la.grupo, la.turno, la.folgaFixa, la.vaga, la.deLoja], ['CAIO', 'Caixa', 'T.3', 5, false, 5]);
  assert.equal(S.turnoFixoDe(6, { id: 103, nome: 'CAIO', base: {} }).codigo, 'T.3', 'quando o VR mostrar a pessoa na loja nova, a linha é dela pelo nome');
  const c2 = await S.cadastro(coord, 5, CTX); assert.equal(c2.pessoas.find(p => p.id === 103).transferido.para, 6); assert.ok(!(await S.gerar(coord, 5, '2026-12-20', '2026-12-26', CTX).catch(() => ({ linhas: [] }))).linhas.some(l => l.id === 103));
  await assert.rejects(S.moverPessoa(coord, 5, { id: 103, paraLoja: 6, grupo: 'Caixa', turno: 'T.3', folgaFixa: 5, noLugar: 'nada' }, CTX), /já está na escala/);
  // 3) "não manter a posição": só a pessoa muda
  const nEx = S.lojaCfg(5).extras.length; const r3 = await S.moverPessoa(gerente, 5, { id: 104, grupo: 'Seção', turno: 'T.4', folgaFixa: 6, noLugar: 'nada' }, CTX); assert.equal(r3.vaga, null); assert.equal(S.lojaCfg(5).extras.length, nEx); assert.equal(S.lojaCfg(5).pessoas[104].grupo, 'Seção');
  // 4) ocupar uma vaga deixando EM ABERTO a posição de quem ocupou
  const r4 = await S.ocuparVaga(gerente, 5, { id: r2.vaga, funcId: 104, noLugar: 'aberto' }, CTX); assert.equal(r4.noLugar, 'aberto'); const tr = S.lojaCfg(5).extras.find(x => x.id === r2.vaga); assert.deepEqual([tr.vaga, tr.aberto, tr.grupo, tr.turno], [true, true, 'Seção', 'T.4']);
});
