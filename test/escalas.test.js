// test/escalas.test.js — Escalas (lib/escalas.js): cobertura, regras de jornada, fluxo e divergências
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-esc-'));
process.env.ESCALAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'escalas-'));
const test = require('node:test'); const assert = require('node:assert/strict');
const GP = require('../lib/gestao-pessoas'); const E = require('../lib/escalas');
const U = { ger1: { usuario: 'g1', nome: 'Gerente Socorro', perfil: 'gerencial' }, ger2: { usuario: 'g2', nome: 'Gerente Muribeca', perfil: 'gerencial' }, rh: { usuario: 'rh', nome: 'RH Ponto', perfil: 'gerente' }, coord: { usuario: 'co', nome: 'Coord', perfil: 'gerente' }, dir: { usuario: 'di', nome: 'Diretoria', perfil: 'gerencial' } };
GP.salvarConfig({ designados: [{ usuario: 'g1', nome: 'G1', papeis: ['gerente'], lojas: [1] }, { usuario: 'g2', nome: 'G2', papeis: ['gerente'], lojas: [2] }, { usuario: 'rh', nome: 'RH', papeis: ['rh_ponto'] }, { usuario: 'co', nome: 'Co', papeis: ['coordenacao'] }, { usuario: 'di', nome: 'Di', papeis: ['diretoria'] }] }, { usuario: 'adm', perfil: 'admin' });
const MES = '2026-11'; const erroStatus = s => e => e.status === s;

test('escala-base do PontoCerto: 2 períodos viram jornada com almoço; dia sem período vira folga fixa', () => {
  const base = E.baseDeEscala({ dias: { 1: [{ entrada: '07:00', saida: '12:00' }, { entrada: '14:00', saida: '17:00' }], 2: [{ entrada: '08:00', saida: '14:20' }], 0: [] } });
  assert.deepEqual(base[1], { entrada: '07:00', saida: '17:00', almoco_ini: '12:00', almoco_fim: '14:00' });
  assert.deepEqual(base[2], { entrada: '08:00', saida: '14:20', almoco_ini: null, almoco_fim: null });
  assert.equal(base[0], null); assert.equal(base[3], null);
});

test('semente demonstrativa de Socorro: 9 pessoas, folgas do prompt, intervalo de 2 h, marcada como demo', () => {
  const e = E.criarDemoSocorro(MES, U.ger1);
  assert.equal(e.demo, true); assert.equal(e.funcionarios.length, 9);
  const dayse = e.funcionarios.find(f => f.nome.startsWith('Dayse')); assert.deepEqual(dayse.folga_fixa, [0, 1]);
  const livia = e.funcionarios.find(f => f.nome.startsWith('Lívia')); assert.deepEqual(livia.folga_fixa, [0], 'segunda a sábado');
  assert.deepEqual(dayse.base[2], { entrada: '07:00', saida: '17:00', almoco_ini: '12:00', almoco_fim: '14:00' });
  assert.throws(() => E.criarDemoSocorro(MES, U.ger1), /mês vazio/);
  const r = E.resolver(e); assert.equal(r[0].dias[MES + '-03'].tipo, 'trabalho'); assert.equal(r[0].dias[MES + '-03'].minutos, 480, '10 h brutas − 2 h de almoço');
});

test('cobertura por bloco de 15 min: desconta o almoço inteiro; status pela necessidade configurada', () => {
  E.salvarConfig({ lojas: { 1: { abre: '07:00', fecha: '19:00', setores: { 'FRENTE DE CAIXA': 2, REPOSICAO: 1, BALCAO: 1, ACOUGUE: 1, 'PREVENCAO DE PERDAS': 1, RECEBIMENTO: 0 } } } }, U.coord);
  const funcs = E.resolver(E.obter(1, MES)); const cob = E.cobertura(1, MES + '-03', funcs);   // terça: Rogério (reposição) e José Carlos (balcão) de folga
  const caixa = cob.setores.find(s => s.setor === 'FRENTE DE CAIXA');
  assert.equal(caixa.escalados, 3); assert.equal(caixa.blocos.find(b => b.hm === '08:00').status, 'ok', '3 > mín 2');
  assert.equal(caixa.blocos.find(b => b.hm === '12:30').status, 'baixa', 'as 3 almoçam juntas 12–14');
  assert.equal(caixa.blocos.find(b => b.hm === '17:30').status, 'baixa', 'ninguém após as 17h');
  const rep = cob.setores.find(s => s.setor === 'REPOSICAO'); assert.equal(rep.escalados, 1); assert.equal(rep.blocos.find(b => b.hm === '09:00').status, 'min');
  const rec = cob.setores.find(s => s.setor === 'RECEBIMENTO'); assert.equal(rec.blocos[0].status, 'neutro', 'necessidade 0 não alerta');
  const sug = E.sugestoes(cob); assert.ok(sug.some(s => s.setor === 'FRENTE DE CAIXA' && s.tipo === 'almoco'), 'sugere mover almoço');
  assert.ok(sug.every(s => !s.aplicado), 'nada é aplicado');
});

test('regras: jornada > 10 h, intervalo mínimo, interjornada, folga fixa só com justificativa, setor habilitado', () => {
  const e = E.obter(1, MES); const f = e.funcionarios.find(x => x.nome.startsWith('Dayse'));
  const v = (d, novo, j) => E.validarDia(e, f, d, { tipo: 'trabalho', setor: f.setor, ...novo }, j);
  assert.match(v(MES + '-04', { entrada: '07:00', saida: '19:00', almoco_ini: '12:00', almoco_fim: '13:00' }).erros.join(), /limite de 10h00/);
  assert.match(v(MES + '-04', { entrada: '07:00', saida: '15:00', almoco_ini: '12:00', almoco_fim: '12:30' }).erros.join(), /intervalo de pelo menos 1h00/);
  assert.deepEqual(v(MES + '-04', { entrada: '07:00', saida: '13:00', almoco_ini: null, almoco_fim: null }).erros, [], '6 h sem intervalo passa');
  assert.match(v(MES + '-04', { entrada: '02:00', saida: '10:00', almoco_ini: null, almoco_fim: null }).erros.join(), /Descanso entre jornadas/, 'véspera saiu 17:00');
  assert.match(v(MES + '-02', { entrada: '07:00', saida: '17:00', almoco_ini: '12:00', almoco_fim: '14:00' }).erros.join(), /folga fixa/, 'segunda é a folga da Dayse');
  assert.deepEqual(v(MES + '-02', { entrada: '07:00', saida: '17:00', almoco_ini: '12:00', almoco_fim: '14:00' }, 'cobrir férias da Roberta').erros, []);
  const dom = v(MES + '-01', { entrada: '07:00', saida: '13:00', almoco_ini: null, almoco_fim: null }, 'inventário'); assert.ok(dom.avisos.some(a => /Domingo/.test(a)), 'domingo só avisa');
  f.habilitado = ['FRENTE DE CAIXA']; assert.match(v(MES + '-04', { entrada: '07:00', saida: '17:00', almoco_ini: '12:00', almoco_fim: '14:00', setor: 'ACOUGUE' }).erros.join(), /não está habilitado/); f.habilitado = [];
});

test('edição registra antes/depois com usuário e justificativa; só o gerente da loja; diretoria nunca', () => {
  const f = E.obter(1, MES).funcionarios.find(x => x.nome.startsWith('Dayse'));
  assert.throws(() => E.editarDia(1, MES, U.ger2, { funcId: f.id, data: MES + '-04', entrada: '08:00', saida: '18:00', almoco_ini: '12:00', almoco_fim: '14:00' }), erroStatus(403));
  assert.throws(() => E.editarDia(1, MES, U.dir, { funcId: f.id, data: MES + '-04', entrada: '08:00', saida: '18:00', almoco_ini: '12:00', almoco_fim: '14:00' }), erroStatus(403));
  const r = E.editarDia(1, MES, U.ger1, { funcId: f.id, data: MES + '-04', entrada: '08:00', saida: '18:00', almoco_ini: '13:00', almoco_fim: '15:00', justificativa: 'cobrir o fim do dia' });
  assert.equal(r.dia.entrada, '08:00'); assert.equal(r.dia.alterado, true);
  const e = E.obter(1, MES); const h = e.historico.at(-1); assert.equal(h.usuario, 'g1'); assert.equal(h.antes.entrada, '07:00'); assert.equal(h.depois.entrada, '08:00'); assert.equal(h.justificativa, 'cobrir o fim do dia');
  assert.equal(Object.keys(e.dias).length, 1);
  E.editarDia(1, MES, U.ger1, { funcId: f.id, data: MES + '-04', entrada: '07:00', saida: '17:00', almoco_ini: '12:00', almoco_fim: '14:00' });
  assert.equal(Object.keys(E.obter(1, MES).dias).length, 0, 'voltar ao contratual remove a alteração');
});

test('fluxo gerente → RH → Coordenação; devolução volta pro gerente; alteração após aprovação reabre proposta', () => {
  assert.deepEqual(E.acoes(U.ger1, E.obter(1, MES)).sort(), ['editar', 'enviar']);
  assert.deepEqual(E.acoes(U.dir, E.obter(1, MES)), []);
  assert.throws(() => E.mover(1, MES, U.rh, 'validar', 'x'), erroStatus(403), 'RH não valida rascunho');
  E.mover(1, MES, U.ger1, 'enviar');
  assert.throws(() => E.editarDia(1, MES, U.ger1, { funcId: -1, data: MES + '-04', entrada: '08:00', saida: '18:00', almoco_ini: '12:00', almoco_fim: '14:00' }), /em aprovação/);
  assert.throws(() => E.mover(1, MES, U.coord, 'aprovar', 'x'), erroStatus(403), 'Coordenação só depois do RH');
  E.mover(1, MES, U.rh, 'devolver', 'Intervalos sobrepostos no caixa');
  assert.equal(E.obter(1, MES).status, 'devolvida'); assert.ok(E.acoes(U.ger1, E.obter(1, MES)).includes('enviar'));
  E.mover(1, MES, U.ger1, 'enviar'); E.mover(1, MES, U.rh, 'validar', 'ok'); E.mover(1, MES, U.coord, 'aprovar', 'aprovada');
  const e = E.obter(1, MES); assert.equal(e.status, 'aprovada'); assert.equal(e.fluxo.length, 5);
  E.editarDia(1, MES, U.ger1, { funcId: -1, data: MES + '-05', entrada: '08:00', saida: '18:00', almoco_ini: '12:00', almoco_fim: '14:00', justificativa: 'troca' });
  const e2 = E.obter(1, MES); assert.equal(e2.status, 'rascunho'); assert.equal(e2.versao, 2); assert.equal(e2.versoes.length, 1, 'versão aprovada guardada');
});

test('divergência escala × ponto: entrada fora da tolerância, trabalho em folga, sem marcação em dia passado', () => {
  const funcs = E.resolver(E.obter(1, MES)); const dayse = funcs.find(f => f.nome.startsWith('Dayse'));
  const j = [{ id: dayse.id, marcacoes: ['07:25', '12:00', '14:00', '17:02'], entrada: '07:25', saidaInt: '12:00', retornoInt: '14:00', saida: '17:02' }];
  const d = E.divergencias(E.obter(1, MES), MES + '-03', [dayse], j, '2026-12-01');
  assert.equal(d.length, 1); assert.deepEqual(d[0].itens.map(i => i.tipo), ['entrada']);
  const folga = E.divergencias(E.obter(1, MES), MES + '-02', [dayse], [{ id: dayse.id, marcacoes: ['08:00', '12:00'] }], '2026-12-01'); assert.equal(folga[0].itens[0].tipo, 'trabalho_em_folga');
  const sem = E.divergencias(E.obter(1, MES), MES + '-03', [dayse], [{ id: dayse.id, marcacoes: [] }], '2026-12-01'); assert.equal(sem[0].itens[0].tipo, 'sem_marcacao'); assert.match(sem[0].itens[0].texto, /não é falta automática/);
  assert.equal(E.divergencias(E.obter(1, MES), MES + '-03', [dayse], [{ id: dayse.id, marcacoes: [] }], MES + '-03').length, 0, 'hoje sem marcação ainda não é divergência');
});
