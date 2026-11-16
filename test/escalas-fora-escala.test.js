'use strict';
// test/escalas-fora-escala.test.js — Gerador 5×2 › Regras e cadastro (16/11/2026): funcionário que NÃO compõe a escala da unidade
// (leitura sobreposta: nada é apagado e religar devolve tudo) e vaga em aberto para a posição de quem saiu da escala.
// Pastas temporárias: nada aqui toca data/ nem o ponto.
const fs = require('fs'), os = require('os'), path = require('path');
for (const [k, p] of [['GP_DIR', 'gp-fe-'], ['ESCALAS_DIR', 'esc-fe-'], ['VAGAS_DIR', 'vg-fe-']]) process.env[k] = fs.mkdtempSync(path.join(os.tmpdir(), p));
process.env.ESCALAS_5X2_RELATORIO = '0';
const test = require('node:test'); const assert = require('node:assert/strict');
const GP = require('../lib/gestao-pessoas'); const E = require('../lib/escalas'); const S = require('../lib/escalas-5x2'); const V = require('../lib/vagas');

const U = { ger: { usuario: 'ger', nome: 'Gerente Socorro' }, rh: { usuario: 'rh', nome: 'Maria RH' }, rh2: { usuario: 'rh2', nome: 'RH Muribeca' }, co: { usuario: 'co', nome: 'Coordenação' }, admin: { usuario: 'adm', nome: 'Admin', perfil: 'admin' } };
GP.salvarConfig({ designados: [{ usuario: 'ger', nome: 'Gerente Socorro', papeis: ['gerente'], lojas: [1] }, { usuario: 'rh', nome: 'Maria RH', papeis: ['rh_ponto', 'rh_doc', 'rh_adm'] }, { usuario: 'rh2', nome: 'RH Muribeca', papeis: ['rh_ponto'], lojas: [2] }, { usuario: 'co', nome: 'Coordenação', papeis: ['coordenacao'] }] }, U.admin);
const HOJE = '2026-11-12', MES = '2026-12', NOV = '2026-11'; const status = s => e => e.status === s;
const J = [{ entrada: '07:00', saida: '11:00' }, { entrada: '13:00', saida: '17:48' }];
const escalasPC = new Map([[10, { id: 10, nome: 'SEG-SEX 44H', dias: { 1: J, 2: J, 3: J, 4: J, 5: J } }]]);
const nomes = ['Ana Lima', 'Bruno Sá', 'Carla Reis', 'Davi Melo', 'Eva Rocha', 'Fábio Luz', 'Gil Costa', 'Hugo Paz'];
const colabs = { ativos: nomes.map((n, i) => ({ id: 101 + i, nome: n, loja: 1, setor: i < 5 ? 'CAIXA' : 'REPOSITOR', cargo: i < 5 ? 'Operador de caixa' : 'Repositor', matricula: String(i + 1), turno: 'SEG-SEX 44H', turno_id: 10, ativo: true })), desligados: [] };
const ctx = extra => ({ colabs, escalasPC, afast: new Map(), afastAnt: new Map(), hoje: HOJE, ...extra });
const deps = { colaboradores: async () => colabs, afastamentos: async () => [] };
const funcs = mes => S.escalaDe(1, mes, ctx()).e.funcionarios;
const cad = mes => S.cadastroLoja(1, funcs(mes), colabs);
const fora = (itens, just, mes) => S.salvarCadastro(U.rh, 1, funcs(mes || MES), itens, just || 'ajuste do quadro da escala', HOJE);
const dia = (mes, id, data) => { const e = E.ler(1, mes); return E.diaDe(e, e.funcionarios.find(f => f.id === id), data, null).tipo; };
const aud = () => fs.readFileSync(S.P.aud(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('fora da escala sem escala no mês: a pessoa some da proposta, da cobertura e das contagens; os demais seguem', () => {
  const antes = S.simular(U.rh, 1, MES, ctx()); assert.equal(antes.resultado.proposta.length, 8); assert.deepEqual(antes.foraEscala, []);
  assert.equal(cad(MES).every(f => f.foraEscala === null), true);
  const r = fora([{ id: 108, foraEscala: { desde: '2026-12-01', motivo: 'Gerência / cargo sem escala' } }], 'Hugo é encarregado e não entra na escala 5x2');
  assert.deepEqual([r.alterados, r.foraEscala, r.voltaram], [1, 1, 0]);
  const s = S.simular(U.rh, 1, MES, ctx()); assert.equal(s.resultado.proposta.length, 7); assert.equal(s.resultado.proposta.some(p => p.id === 108), false);
  assert.deepEqual(s.foraEscala.map(x => [x.id, x.desde, x.motivo, x.todoPeriodo]), [[108, '2026-12-01', 'Gerência / cargo sem escala', true]]);
  assert.equal(s.resultado.indicadores.funcionarios, 7); assert.equal(s.semFolgaFixaRH, 7, 'quem está fora não entra na conta de folga fixa');
  assert.notEqual(s.assinatura, antes.assinatura, 'a proposta mudou: a simulação antiga não serve para aplicar');
  const c = cad(MES).find(f => f.id === 108); assert.equal(c.foraEscala.desde, '2026-12-01'); assert.equal(c.foraEscala.por, 'Maria RH');
  assert.equal(S.avancadas(U.rh, 1, funcs(MES), colabs).dominical.semSexo, 7, 'fora da escala não conta como "sem o sexo informado"');
  const a = aud().filter(x => x.acao === 'cadastro').pop(); assert.deepEqual(a.foraEscala, [{ id: 108, nome: 'Hugo Paz', desde: '2026-12-01', motivo: 'Gerência / cargo sem escala' }]);
  assert.match(S.trilha(U.rh, { loja: 1 }).registros.find(x => x.seq === a.seq).detalhe, /fora da escala: Hugo Paz desde 01\/12\/2026/);
});

test('validações e permissões: data, motivo, só o RH Ponto da unidade; a marcação vale só para a unidade em que foi feita', () => {
  assert.throws(() => fora([{ id: 107, foraEscala: { desde: '', motivo: 'Outro motivo' } }]), /a partir de que dia/);
  assert.throws(() => fora([{ id: 107, foraEscala: { desde: '2026-12-01', motivo: '' } }]), /Informe o motivo/);
  assert.throws(() => fora([{ id: 107, foraEscala: { desde: '2029-01-01', motivo: 'Afastamento longo' } }]), /fora do alcance/);
  assert.throws(() => S.salvarCadastro(U.ger, 1, funcs(MES), [{ id: 107, foraEscala: { desde: '2026-12-01', motivo: 'Afastamento longo' } }], 'tentativa do gerente', HOJE), status(403));
  assert.throws(() => S.salvarCadastro(U.rh2, 1, funcs(MES), [{ id: 107, foraEscala: { desde: '2026-12-01', motivo: 'Afastamento longo' } }], 'RH de outra unidade', HOJE), status(403));
  assert.equal(cad(MES).find(f => f.id === 107).foraEscala, null, 'nada foi gravado nas tentativas recusadas');
  assert.equal(S.foraDe(2, 108), null, 'a marcação da loja 1 não vale na loja 2'); assert.equal(S.foraDe(1, 108).desde, '2026-12-01');
  // repetir a mesma marcação não gera alteração
  assert.equal(fora([{ id: 108, foraEscala: { desde: '2026-12-01', motivo: 'Gerência / cargo sem escala' } }]).alterados, 0);
});

test('escala que já existe: a partir da data os dias viram "fora do quadro", a linha some do mês seguinte e nada é apagado', () => {
  E.criarDoPontoCerto(1, NOV, colabs, escalasPC, U.rh); E.criarDoPontoCerto(1, MES, colabs, escalasPC, U.rh);
  E.editarDia(1, NOV, U.rh, { funcId: 106, data: '2026-11-25', tipo: 'folga', justificativa: 'troca de folga combinada' }, null);
  assert.equal(dia(NOV, 106, '2026-11-20'), 'trabalho'); assert.equal(dia(NOV, 106, '2026-11-25'), 'folga');
  const r = fora([{ id: 106, foraEscala: { desde: '2026-11-23', motivo: 'Afastamento longo (INSS, licença)' } }], 'Fábio entrou em benefício do INSS', NOV); assert.equal(r.foraEscala, 1);
  assert.equal(dia(NOV, 106, '2026-11-20'), 'trabalho', 'antes da data fica como estava'); assert.equal(dia(NOV, 106, '2026-11-23'), 'saiu'); assert.equal(dia(NOV, 106, '2026-11-25'), 'saiu');
  const nov = E.resolver(E.ler(1, NOV)).find(f => f.id === 106); assert.equal(nov.saiu_em, '2026-11-22'); assert.deepEqual(nov.fora_escala, { desde: '2026-11-23', motivo: 'Afastamento longo (INSS, licença)' }); assert.equal(nov.fora_do_mes, undefined);
  const dez = E.resolver(E.ler(1, MES)); assert.equal(dez.find(f => f.id === 106).fora_do_mes, true, 'dezembro inteiro fora: não é linha da grade'); assert.equal(dez.find(f => f.id === 108).fora_do_mes, true); assert.equal(dez.find(f => f.id === 101).fora_do_mes, undefined);
  assert.ok(E.ler(1, NOV).dias['106|2026-11-25'], 'o dia ajustado à mão continua no arquivo'); assert.equal(E.ler(1, MES).funcionarios.some(f => f.id === 106), true, 'a pessoa continua no arquivo da escala');
  // cobertura: quem está fora não é presença nem ausência do setor
  const cob = E.cobertura(1, '2026-11-24', E.resolver(E.ler(1, NOV))); assert.equal(cob.setores.find(s => s.setor === 'REPOSICAO').pessoas.some(p => p.id === 106), false);
  // o fluxo das escalas alcançadas registra a mudança; editar um dia depois da data é recusado com a explicação
  assert.match(E.ler(1, NOV).fluxo.pop().texto, /fora da escala — Fábio Luz a partir de 23\/11\/2026 \(Afastamento longo/); assert.match(E.ler(1, MES).fluxo.pop().texto, /fora da escala — Fábio Luz/);
  assert.throws(() => E.editarDia(1, NOV, U.rh, { funcId: 106, data: '2026-11-26', tipo: 'folga', justificativa: 'tentativa de editar' }, null), /fora da escala desde 23\/11\/2026 por decisão do RH/);
  // o motor de novembro (de amanhã em diante) ainda escala a pessoa até a véspera e depois a trata como fora, não como folga
  const s = S.simular(U.rh, 1, NOV, ctx()); const p = s.resultado.proposta.find(x => x.id === 106); assert.ok(p, 'entra na proposta: ainda compõe a escala no início do período');
  assert.equal(Object.keys(p.dias).some(d => d >= '2026-11-23' && ['trabalho', 'folga'].includes(p.dias[d].tipo)), false, 'nenhuma jornada nem folga depois da data');
  assert.deepEqual(s.foraEscala.find(x => x.id === 106).todoPeriodo, false);
  // dezembro: nem aparece
  assert.equal(S.simular(U.rh, 1, MES, ctx()).resultado.proposta.some(x => x.id === 106 || x.id === 108), false);
  assert.equal(S.analisar(U.rh, 1, MES, ctx()).pessoas.some(x => x.id === 106 || x.id === 108), false, 'a validação da grade também ignora quem está fora');
});

test('voltar a compor a escala devolve tudo o que estava na grade e fica na auditoria', () => {
  const r = fora([{ id: 106, foraEscala: null }], 'benefício negado, Fábio retorna', NOV); assert.deepEqual([r.alterados, r.foraEscala, r.voltaram], [1, 0, 1]);
  assert.equal(dia(NOV, 106, '2026-11-24'), 'trabalho'); assert.equal(dia(NOV, 106, '2026-11-25'), 'folga', 'o ajuste manual reaparece');
  assert.equal(E.resolver(E.ler(1, MES)).find(f => f.id === 106).fora_do_mes, undefined); assert.equal(S.foraDe(1, 106), null);
  assert.equal(S.simular(U.rh, 1, MES, ctx()).resultado.proposta.some(x => x.id === 106), true);
  assert.deepEqual(aud().filter(x => x.acao === 'cadastro').pop().voltaramEscala, [{ id: 106, nome: 'Fábio Luz', desde: '2026-11-23' }]);
  assert.match(E.ler(1, NOV).fluxo.pop().texto, /voltam a compor a escala — Fábio Luz/);
  assert.equal(fora([{ id: 106, foraEscala: null }]).alterados, 0, 'religar quem já está na escala não muda nada');
  assert.equal(S.verificarCadeia().ok, true);
});

test('vaga em aberto para a posição de quem está fora da escala: herda setor e turno, não duplica e aparece na grade', async () => {
  const r = await V.abrirVaga(U.rh, { loja: 1, funcId: 108, desde: '2026-12-01', justificativa: 'Hugo fora da escala: posição precisa de reposição' }, deps, HOJE);
  const v = r.vaga; assert.equal(v.id, 'VG-2026-0001'); assert.deepEqual([v.loja, v.setor, v.setorEscala, v.cargo, v.desde, v.tipo, v.origem], [1, 'REPOSITOR', 'REPOSICAO', 'Repositor', '2026-12-01', 'reposicao', 'manual']);
  assert.deepEqual(v.ocupanteAnterior, { funcId: 108, nome: 'Hugo Paz', matricula: '8' }); assert.equal(v.turnoRef.texto, '07:00–17:48');
  assert.equal(v.status, 'aguardando_autorizacao', 'sem quadro autorizado definido, a reposição aguarda a Coordenação');
  assert.match(v.historico[0].texto, /Posição de Hugo Paz, que está fora da escala da unidade \(sem desligamento registrado\)/);
  await assert.rejects(V.abrirVaga(U.rh, { loja: 1, funcId: 108, desde: '2026-12-01', justificativa: 'de novo, por engano' }, deps, HOJE), e => e.status === 409 && e.duplicada === 'VG-2026-0001');
  await assert.rejects(V.abrirVaga(U.rh2, { loja: 1, funcId: 107, justificativa: 'RH de outra unidade' }, deps, HOJE), status(403));
  await assert.rejects(V.abrirVaga(U.rh, { loja: 1, funcId: 999, justificativa: 'funcionário inexistente' }, deps, HOJE), status(404));
  const g = V.naEscala(U.rh, 1, '2026-12-01', '2026-12-31', HOJE); assert.deepEqual(g.map(x => [x.id, x.setor, x.desde, x.ocupanteAnterior]), [['VG-2026-0001', 'REPOSICAO', '2026-12-01', 'Hugo Paz']]);
  assert.equal(V.naEscala(U.rh, 1, '2026-11-01', '2026-11-30', HOJE).length, 0, 'a vaga só aparece a partir do dia em que a posição fica vaga');
  // vaga avulsa (posição sem ocupante), como a tela abre: setor operacional + cargo
  const m = await V.abrirVaga(U.rh, { loja: 1, setor: 'FRENTE DE CAIXA', cargo: 'Operador de caixa', tipo: 'ampliacao', desde: '2026-12-01', entrada: '13:00', saida: '21:20', justificativa: 'reforço do turno de fechamento' }, deps, HOJE);
  assert.deepEqual([m.vaga.setorEscala, m.vaga.tipo, m.vaga.turnoRef.texto, m.vaga.ocupanteAnterior], ['FRENTE DE CAIXA', 'ampliacao', '13:00–21:20', null]);
  assert.equal(V.listarVagas(U.rh, { loja: 1, status: 'abertas' }, HOJE).length, 2);
  // quem ainda não está em nenhuma escala gravada: o turno de referência vem da jornada contratual do ponto, não do nome do turno
  colabs.ativos.push({ id: 109, nome: 'Íris Nova', loja: 1, setor: 'CAIXA', cargo: 'Operador de caixa', matricula: '9', turno: 'IRIS NOVA SOCORRO', turno_id: 10, ativo: true });
  const n = await V.abrirVaga(U.rh, { loja: 1, funcId: 109, desde: '2026-12-01', justificativa: 'posição da Íris fica em aberto' }, { ...deps, escalas: async () => escalasPC }, HOJE);
  assert.deepEqual([n.vaga.turnoRef.texto, n.vaga.turnoRef.origem, n.vaga.setorEscala], ['07:00–17:48', 'contrato', 'FRENTE DE CAIXA']);
  // a pessoa segue ativa: nenhuma saída foi registrada e nada mudou no limite dela além do "fora da escala"
  assert.equal(E.limitesNaEscala(E.ler(1, MES), E.ler(1, MES).funcionarios.find(f => f.id === 108)).foraEscala.desde, '2026-12-01');
});
