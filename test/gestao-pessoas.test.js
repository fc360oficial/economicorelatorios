// test/gestao-pessoas.test.js — Central de Gestão de Pessoas: testes obrigatórios do prompt master (seção 14)
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-teste-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const GP = require('../lib/gestao-pessoas');

const U = {
  ger5: { usuario: 'ger5', nome: 'Gerente E5', perfil: 'gerencial' }, ger1: { usuario: 'ger1', nome: 'Gerente E1', perfil: 'gerencial' },
  rhp: { usuario: 'rhp', nome: 'RH Ponto', perfil: 'gerente' }, rha: { usuario: 'rha', nome: 'RH Admissões', perfil: 'gerente' }, rhd: { usuario: 'rhd', nome: 'RH Documentos', perfil: 'gerente' },
  coord: { usuario: 'coord', nome: 'Coordenação', perfil: 'gerente' }, coord2: { usuario: 'coord2', nome: 'Coordenação 2', perfil: 'gerente' },
  dir: { usuario: 'dir', nome: 'Diretoria', perfil: 'gerencial' }, jur: { usuario: 'jur', nome: 'Jurídico', perfil: 'gerente' }, ti: { usuario: 'ti', nome: 'TI', perfil: 'admin' },
  admin: { usuario: 'tiago', nome: 'Admin', perfil: 'admin' }, estranho: { usuario: 'x', nome: 'Sem designação', perfil: 'gerente' },
};
const erroStatus = st => e => e.status === st;

test('bootstrap: sem designados só o admin entra, e só pra designar', () => {
  assert.equal(GP.bootstrapPermitido(U.admin), true);
  assert.equal(GP.bootstrapPermitido(U.estranho), false);
  assert.throws(() => GP.salvarConfig({ limites: { positivoMin: 1, negativoMin: 1 } }, U.admin), erroStatus(403));
  assert.throws(() => GP.salvarConfig({ designados: [{ usuario: 'ger5', papeis: ['gerente'], lojas: [] }, { usuario: 'coord', papeis: ['coordenacao'] }] }, U.admin), /unidade/);
  assert.throws(() => GP.salvarConfig({ designados: [{ usuario: 'dir', papeis: ['diretoria', 'coordenacao'] }] }, U.admin), /Diretoria/);
  GP.salvarConfig({ designados: [
    { usuario: 'ger5', nome: 'Gerente E5', papeis: ['gerente'], lojas: [5] }, { usuario: 'ger1', nome: 'Gerente E1', papeis: ['gerente'], lojas: [1] },
    { usuario: 'rhp', nome: 'RH Ponto', papeis: ['rh_ponto'] }, { usuario: 'rha', nome: 'RH Admissões', papeis: ['rh_adm'] }, { usuario: 'rhd', nome: 'RH Documentos', papeis: ['rh_doc'], lojas: [5] },
    { usuario: 'coord', nome: 'Coordenação', papeis: ['coordenacao'] }, { usuario: 'coord2', nome: 'Coordenação 2', papeis: ['coordenacao', 'rh_ponto'] },
    { usuario: 'dir', nome: 'Diretoria', papeis: ['diretoria'] }, { usuario: 'jur', nome: 'Jurídico', papeis: ['juridico'] }, { usuario: 'ti', nome: 'TI', papeis: ['ti'] },
  ] }, U.admin);
  assert.equal(GP.bootstrapPermitido(U.admin), false, 'admin deixa de entrar depois que há designados');
  assert.deepEqual(GP.papeisDe(U.admin), []);
});

const colab = (id, loja, min, extra) => ({ id, nome: 'Func ' + id, matricula: 'M' + id, loja, setor: 'CAIXA', cargo: 'OPERADOR', banco_horas_min: min, ...(extra || {}) });
const BASE = [colab(1, 5, 601), colab(2, 5, -601), colab(3, 5, 600), colab(4, 5, -600), colab(5, 5, 599), colab(6, 5, -599), colab(7, 1, 900), colab(8, 1, 0)];

test('limites: +10h01 e −10h01 alertam; exatamente ±10h00 ficam "no limite"; ±9h59 regular', () => {
  assert.equal(GP.classificar(601), 'alerta_pos'); assert.equal(GP.classificar(-601), 'alerta_neg');
  assert.equal(GP.classificar(600), 'limite_pos'); assert.equal(GP.classificar(-600), 'limite_neg');
  assert.equal(GP.classificar(599), 'regular'); assert.equal(GP.classificar(-599), 'regular');
  const r = GP.sincronizarBancoHoras(BASE, new Date('2026-10-14T10:00:00'));
  assert.equal(r.novos, 3, 'colab 1 (+601), 2 (−601) e 7 (+900)');
});

test('alertas não duplicam a cada sincronização; evolução registrada; encerra quando volta pro limite', () => {
  const r = GP.sincronizarBancoHoras(BASE.map(c => c.id === 1 ? { ...c, banco_horas_min: 650 } : c), new Date('2026-10-21T10:00:00'));
  assert.equal(r.novos, 0); assert.equal(r.atualizados, 1);
  const p = GP.painelBancoHoras(U.coord);
  const a1 = p.linhas.find(l => l.id === 1); assert.ok(a1.alerta); assert.equal(a1.anterior, 601, 'compara com a foto da semana anterior'); assert.equal(a1.variacao, 49);
  const al = GP.alertaBH(a1.alerta.protocolo, U.coord); assert.equal(al.evolucao.length, 2);
  const r2 = GP.sincronizarBancoHoras(BASE.map(c => c.id === 2 ? { ...c, banco_horas_min: -500 } : c.id === 1 ? { ...c, banco_horas_min: 650 } : c), new Date('2026-10-21T10:30:00'));
  assert.equal(r2.encerrados, 1);
});

test('falha de sincronização não mexe nos alertas (lista vazia ou inválida)', () => {
  const antes = JSON.stringify(GP.centralAlertas(U.coord).filter(a => a.evento <= 2));
  assert.throws(() => GP.sincronizarBancoHoras([]), erroStatus(502));
  assert.throws(() => GP.sincronizarBancoHoras([{ id: 1, nome: 'x' }]), erroStatus(502));
  assert.equal(JSON.stringify(GP.centralAlertas(U.coord).filter(a => a.evento <= 2)), antes);
  assert.equal(GP.syncEstado().bancoHoras.ok, false);
  assert.ok(GP.syncEstado().bancoHoras.ultimoOk, 'mantém a data do último sucesso');
});

test('gerente não acessa dados de outras unidades', () => {
  const p5 = GP.painelBancoHoras(U.ger5); assert.ok(p5.linhas.every(l => l.loja === 5));
  const p1 = GP.painelBancoHoras(U.ger1); assert.ok(p1.linhas.every(l => l.loja === 1));
  const al7 = GP.painelBancoHoras(U.coord).linhas.find(l => l.id === 7).alerta.protocolo;
  assert.throws(() => GP.alertaBH(al7, U.ger5), erroStatus(404));
  assert.ok(GP.centralAlertas(U.ger5).every(a => a.loja === 5));
  // não consegue abrir solicitação para funcionário de outra loja (a unidade vem do funcionário)
  assert.throws(() => GP.criarSolicitacao(U.ger5, { tipo: 'plano_bh', dados: { colab_id: 7, justificativa: 'x', medida: 'y', inicio: '2026-10-22', fim: '2026-10-30', horas_planejadas: 4, responsavel_execucao: 'eu' } }), erroStatus(403));
  assert.throws(() => GP.criarSolicitacao(U.ger5, { tipo: 'reposicao', loja: 1, dados: { setor: 'CAIXA', cargo: 'OP', quantidade: 1, motivo: 'x' } }), erroStatus(403));
});

const planoDados = { colab_id: 1, justificativa: 'Inventário e cobertura de férias', medida: 'Folgas compensatórias às terças', inicio: '2026-10-22', fim: '2026-11-05', horas_planejadas: 8, responsavel_execucao: 'Encarregado' };
let PROT;
test('fluxo completo GERENTE → RH → COORDENAÇÃO → EXECUÇÃO → MONITORAMENTO', () => {
  const s = GP.criarSolicitacao(U.ger5, { tipo: 'plano_bh', dados: planoDados, enviar: true }); PROT = s.protocolo;
  assert.equal(s.status, 'enviado_rh'); assert.equal(s.loja, 5); assert.equal(s.dados.saldo_min, 650, 'saldo vem do servidor');
  assert.throws(() => GP.executar(PROT, U.rha, 'analisar'), erroStatus(403), 'RH de admissões não analisa plano de banco de horas');
  GP.executar(PROT, U.rhp, 'analisar');
  assert.throws(() => GP.executar(PROT, U.rhp, 'validar', {}), /justificativa|parecer/i);
  const v = GP.executar(PROT, U.rhp, 'validar', { texto: 'Saldo conferido; medida compatível com a escala' });
  assert.equal(v.status, 'aguardando_coordenacao');
  assert.ok(v.historico.some(h => h.para === 'validado_rh'), 'status Validado pelo RH fica no histórico');
  const a = GP.executar(PROT, U.coord, 'aprovar', { texto: 'De acordo' }); assert.equal(a.status, 'aprovado'); assert.equal(a.decisao.por, 'coord');
  GP.executar(PROT, U.ger5, 'iniciar', {});
  GP.executar(PROT, U.ger5, 'registrar_execucao', { texto: 'Folga dia 28', horas: 8 });
  assert.throws(() => GP.executar(PROT, U.ger5, 'concluir', { texto: 'ok', resultado: 'cumprido' }), erroStatus(403), 'conclusão é do RH');
  const c = GP.executar(PROT, U.rhp, 'concluir', { texto: 'Conferido no ponto', resultado: 'cumprido' });
  assert.equal(c.status, 'concluido'); assert.ok(c.comparacao && /não prova/.test(c.comparacao.nota));
  const transicoes = c.historico.map(h => h.para);
  for (const st of ['rascunho', 'enviado_rh', 'em_analise_rh', 'validado_rh', 'aguardando_coordenacao', 'aprovado', 'em_execucao', 'concluido']) assert.ok(transicoes.includes(st), 'histórico tem ' + st);
});

test('ninguém aprova a própria solicitação; quem validou no RH não aprova', () => {
  const s = GP.criarSolicitacao(U.coord2, { tipo: 'alteracao_escala', loja: 5, dados: { colab_id: 5, escala_nova: '6x1 manhã', inicio: '2026-11-01', motivo: 'Cobertura' }, enviar: true });
  GP.executar(s.protocolo, U.rhp, 'analisar'); GP.executar(s.protocolo, U.rhp, 'validar', { texto: 'ok' });
  assert.throws(() => GP.executar(s.protocolo, U.coord2, 'aprovar', { texto: 'eu mesmo' }), /própria/);
  const s2 = GP.criarSolicitacao(U.ger5, { tipo: 'alteracao_escala', dados: { colab_id: 6, escala_nova: '6x1 tarde', inicio: '2026-11-01', motivo: 'Cobertura' }, enviar: true });
  GP.executar(s2.protocolo, U.coord2, 'analisar'); GP.executar(s2.protocolo, U.coord2, 'validar', { texto: 'ok técnico' });
  assert.throws(() => GP.executar(s2.protocolo, U.coord2, 'aprovar', { texto: 'ok' }), /segregação/);
  assert.equal(GP.executar(s2.protocolo, U.coord, 'aprovar', { texto: 'ok' }).status, 'aprovado');
});

test('RH não executa aprovação exclusiva da Coordenação; Diretoria não tem nenhuma ação', () => {
  const s = GP.criarSolicitacao(U.ger5, { tipo: 'reposicao', loja: 5, dados: { setor: 'CAIXA', cargo: 'OPERADOR', quantidade: 1, motivo: 'Pedido de demissão' }, enviar: true });
  GP.executar(s.protocolo, U.rha, 'analisar'); GP.executar(s.protocolo, U.rha, 'validar', { texto: 'ok' });
  for (const u of [U.rha, U.rhp, U.rhd]) assert.throws(() => GP.executar(s.protocolo, u, 'aprovar', { texto: 'x' }), erroStatus(403));
  for (const ac of ['aprovar', 'rejeitar', 'ajustes', 'cancelar', 'analisar', 'validar', 'editar'])
    assert.throws(() => GP.executar(s.protocolo, U.dir, ac, { texto: 'x' }), erroStatus(403), 'diretoria: ' + ac);
  assert.deepEqual(GP.acoesSol(U.dir, GP.obterSol(s.protocolo)), []);
  assert.throws(() => GP.criarSolicitacao(U.dir, { tipo: 'reposicao', loja: 5, dados: {} }), erroStatus(403));
  assert.throws(() => GP.salvarConfig({ limites: { positivoMin: 700, negativoMin: 700 } }, U.dir), erroStatus(403));
  assert.throws(() => GP.salvarConfig({ limites: { positivoMin: 700, negativoMin: 700 } }, U.rhp), erroStatus(403));
  assert.ok(GP.indicadores(U.dir).lojas.length >= 2, 'diretoria consulta todas as unidades');
  // gerente não muda status direto: só as transições do papel dele
  assert.throws(() => GP.executar(s.protocolo, U.ger5, 'aprovar', { texto: 'x' }), erroStatus(403));
});

test('planos devolvidos voltam ao responsável correto', () => {
  const s = GP.criarSolicitacao(U.ger5, { tipo: 'plano_bh', dados: { ...planoDados, colab_id: 2 }, enviar: true });
  GP.executar(s.protocolo, U.rhp, 'analisar');
  const d = GP.executar(s.protocolo, U.rhp, 'devolver', { texto: 'Falta a origem do saldo negativo' });
  assert.equal(d.status, 'devolvido'); assert.deepEqual(GP.acoesSol(U.ger5, d).sort(), ['cancelar', 'editar', 'enviar']);
  assert.ok(!GP.acoesSol(U.ger1, d).length, 'gerente de outra loja não mexe');
  assert.ok(!GP.acoesSol(U.rhp, d).includes('enviar'));
  GP.executar(s.protocolo, U.ger5, 'enviar'); GP.executar(s.protocolo, U.rhp, 'analisar'); GP.executar(s.protocolo, U.rhp, 'validar', { texto: 'ok' });
  const aj = GP.executar(s.protocolo, U.coord, 'ajustes', { texto: 'Reduza o prazo' });
  assert.equal(aj.status, 'devolvido'); assert.equal(aj.devolvidoPor, 'coordenacao'); assert.ok(GP.acoesSol(U.ger5, aj).includes('enviar'));
  GP.executar(s.protocolo, U.ger5, 'enviar'); GP.executar(s.protocolo, U.rhp, 'analisar'); GP.executar(s.protocolo, U.rhp, 'validar', { texto: 'ok' });
  const dr = GP.executar(s.protocolo, U.coord, 'devolver_rh', { texto: 'Rever horas' });
  assert.equal(dr.status, 'enviado_rh'); assert.ok(GP.acoesSol(U.rhp, dr).includes('analisar')); assert.equal(dr.validadoPor, null);
});

test('Jurídico só vê o que foi encaminhado e dá parecer sem decidir', () => {
  const s = GP.criarSolicitacao(U.ger5, { tipo: 'transferencia', dados: { colab_id: 3, loja_destino: 1, data: '2026-11-10', motivo: 'Pedido do funcionário' }, enviar: true });
  assert.throws(() => GP.criarSolicitacao(U.ger5, { tipo: 'transferencia', dados: { colab_id: 3, loja_destino: 5, data: '2026-11-10', motivo: 'x' } }), /mesma/);
  assert.equal(GP.listarSols(U.jur).some(x => x.protocolo === s.protocolo), false);
  GP.executar(s.protocolo, U.rha, 'analisar'); GP.executar(s.protocolo, U.rha, 'validar', { texto: 'ok' });
  GP.executar(s.protocolo, U.coord, 'juridico', { texto: 'Há impacto contratual na mudança de empregador?' });
  assert.equal(GP.listarSols(U.jur).length, 1);
  GP.executar(s.protocolo, U.jur, 'parecer_juridico', { texto: 'Mesmo grupo; formalizar aditivo' });
  assert.throws(() => GP.executar(s.protocolo, U.jur, 'aprovar', { texto: 'x' }), erroStatus(403));
  assert.equal(GP.obterSol(s.protocolo).status, 'aguardando_coordenacao');
});

test('TI e não designados não veem dados de pessoas', () => {
  assert.throws(() => GP.painelBancoHoras(U.ti), erroStatus(403));
  assert.throws(() => GP.listarOcorrencias(U.ti), erroStatus(403));
  assert.throws(() => GP.painelBancoHoras(U.estranho), erroStatus(403));
  assert.throws(() => GP.criarSolicitacao(U.ti, { tipo: 'reposicao', loja: 5, dados: {} }), erroStatus(403));
  assert.deepEqual(GP.listarSols(U.ti), []);
});

const LISTAS = {
  faltas: [{ loja: 5, nome: 'Func 1', setor: 'CAIXA', data: '2026-10-20', abonada: false, turno: '07:00-15:20' }, { loja: 5, nome: 'Func 2', setor: 'CAIXA', data: '2026-10-20', abonada: true }],
  atrasos: [{ loja: 5, nome: 'Func 3', setor: 'CAIXA', data: '2026-10-20', previsto: '07:00', batido: '07:40', atraso: '0:40' }],
  extras: [{ loja: 5, nome: 'Func 5', setor: 'CAIXA', data: '2026-10-20', normais: '7:20', extras: '1:00' }, { loja: 1, nome: 'Func 7', setor: 'CAIXA', data: '2026-10-20', normais: '7:20', extras: '3:10' }],
};
test('ponto: marcação ausente abre ocorrência; abonada e HE pequena não; não duplica; falha não abre nada', () => {
  const r = GP.sincronizarPonto(LISTAS, { de: '2026-10-14', ate: '2026-10-20' }, new Date('2026-10-21T10:00:00'));
  assert.equal(r.novas, 3, 'falta não abonada, atraso e HE de 3h10');
  assert.equal(GP.sincronizarPonto(LISTAS, {}, new Date('2026-10-21T10:30:00')).novas, 0, 'sem duplicar');
  assert.throws(() => GP.sincronizarPonto(null), erroStatus(502));
  assert.throws(() => GP.sincronizarPonto({ faltas: [] }), erroStatus(502));
  const oc = GP.listarOcorrencias(U.ger5, { situacao: 'abertas' });
  assert.equal(oc.length, 2, 'gerente E5 só vê as da E5');
  const falta = oc.find(o => o.tipo === 'sem_marcacao'); assert.equal(falta.colab_id, 1); assert.ok(falta.acoes.includes('justificar'));
  assert.ok(!falta.acoes.includes('regularizar'), 'gerente não regulariza');
  assert.throws(() => GP.tratarOcorrencia(falta.id, U.ger1, 'justificar', { texto: 'x' }), erroStatus(404));
  GP.tratarOcorrencia(falta.id, U.ger5, 'justificar', { texto: 'Relógio da loja parado de manhã' });
  assert.throws(() => GP.tratarOcorrencia(falta.id, U.ger5, 'regularizar', { texto: 'x' }), erroStatus(403));
  const reg = GP.tratarOcorrencia(falta.id, U.rhp, 'regularizar', { texto: 'Confirmada falha do REP; ajuste manual feito no PontoCerto pelo RH' });
  assert.equal(reg.status, 'regularizada'); assert.equal(reg.historico.length, 2);
});

test('ponto: falha coletiva vira UMA ocorrência da unidade; atraso dentro da tolerância e folga trabalhada', () => {
  // E5 tem 6 ativos na foto (colabs 1–6): 5 sem marcação no mesmo dia = 83% → falha de registro, não 5 faltas
  const faltas = [1, 2, 3, 4, 5].map(i => ({ loja: 5, nome: 'Func ' + i, setor: 'CAIXA', data: '2026-10-21', abonada: false }));
  const r = GP.sincronizarPonto({ faltas, atrasos: [{ loja: 5, nome: 'Func 6', data: '2026-10-21', previsto: '07:00', batido: '07:09', atraso: '0:09' }],
    extras: [{ loja: 5, nome: 'Func 4', data: '2026-10-21', normais: '00:00', extras: '8:10' }] }, { de: '2026-10-21', ate: '2026-10-21' }, new Date('2026-10-22T10:00:00'));
  assert.equal(r.novas, 2, '1 falha coletiva + 1 trabalho em folga; atraso de 9 min fica na tolerância');
  const oc = GP.listarOcorrencias(U.coord, { situacao: 'abertas' }).filter(o => o.data === '2026-10-21');
  const col = oc.find(o => o.tipo === 'falha_coletiva'); assert.ok(col); assert.equal(col.responsavel, 'RH · Controle de Ponto'); assert.match(col.registrado, /5 de 6/);
  assert.equal(oc.filter(o => o.tipo === 'sem_marcacao').length, 0, 'ninguém leva falta individual');
  assert.ok(oc.some(o => o.tipo === 'trabalho_folga'));
  // dados anteriores ao início do monitoramento não abrem nada
  assert.equal(GP.sincronizarPonto({ faltas: [{ loja: 5, nome: 'Func 1', data: '2026-09-01', abonada: false }], atrasos: [], extras: [] }, {}, new Date('2026-10-22T11:00:00')).novas, 0);
});

test('escalonamento por prazo vencido, vencimento de execução e relatório de sexta', () => {
  const t = GP.tick(new Date('2026-10-30T09:00:00'));   // sexta
  assert.ok(t.escalonadas >= 1, 'atraso sem justificativa escalona');
  assert.equal(t.relatorio, '2026-10-30');
  const t2 = GP.tick(new Date('2026-10-30T09:05:00')); assert.equal(t2.relatorio, null, 'não congela duas vezes'); assert.equal(t2.escalonadas, 0, 'não escalona de novo pelo mesmo motivo');
  const rel = GP.relatorioSemanal(U.ger5, '2026-10-30'); assert.ok(rel.lojas.every(l => l.loja === 5));
  const l5 = rel.lojas[0]; assert.ok(l5.top_pos.length <= 5 && l5.top_neg.length <= 5); assert.ok(l5.fora.some(x => x.id === 1));
  // plano aprovado com conclusão prevista no passado vence
  const s = GP.criarSolicitacao(U.ger5, { tipo: 'plano_bh', dados: { ...planoDados, colab_id: 1, inicio: '2026-10-22', fim: '2026-10-25' }, enviar: true });
  GP.executar(s.protocolo, U.rhp, 'analisar'); GP.executar(s.protocolo, U.rhp, 'validar', { texto: 'ok' }); GP.executar(s.protocolo, U.coord, 'aprovar', { texto: 'ok' });
  GP.tick(new Date('2026-10-31T09:00:00'));
  assert.equal(GP.obterSol(s.protocolo).status, 'vencido');
  assert.ok(GP.centralAlertas(U.coord).some(a => a.evento === 8 && a.protocolo === s.protocolo));
});

test('central de alertas: plano não enviado, quadro abaixo do autorizado (sem virar vaga), documento', () => {
  GP.salvarConfig({ quadro: { '5|CAIXA': 10 } }, U.coord);
  const al = GP.centralAlertas(U.coord, {}, new Date('2026-10-31T10:00:00'));
  assert.ok(al.some(a => a.evento === 11 && a.loja === 5));
  assert.ok(al.some(a => a.evento === 5 && a.colab === 'Func 7'), 'alerta da E1 sem plano depois da sexta');
  assert.throws(() => GP.salvarDocumento(U.ger5, { colab_id: 1, tipo: 'Assinatura', descricao: 'Aditivo' }), erroStatus(403));
  assert.throws(() => GP.salvarDocumento(U.rhd, { colab_id: 7, tipo: 'Assinatura', descricao: 'Aditivo' }), erroStatus(403), 'RH doc da E5 não mexe na E1');
  GP.salvarDocumento(U.rhd, { colab_id: 1, tipo: 'Assinatura', descricao: 'Aditivo de escala', prazo: '2026-10-25' });
  assert.ok(GP.centralAlertas(U.ger5).some(a => a.evento === 9));
  assert.equal(GP.checklistAdmissional(U.rhd, 1).criados, GP.config().checklistAdmissional.length);
  assert.equal(GP.checklistAdmissional(U.rhd, 1).criados, 0, 'checklist não duplica');
  const q = GP.painelQuadro(U.coord, null); assert.match(q.nota, /não é vaga aprovada/);
});

test('decisões registradas na auditoria; gerente vê só a trilha do que enxerga', () => {
  const mes = new Date().toISOString().slice(0, 7);
  const tudo = GP.auditoria(U.coord, { mes });
  assert.ok(tudo.some(e => e.acao === 'sol_aprovar' && e.ref === PROT));
  assert.ok(tudo.some(e => e.acao === 'config'));
  const ger = GP.auditoria(U.ger1, { mes });
  assert.ok(ger.every(e => e.ref), 'gerente não vê mudanças de configuração');
  assert.ok(!ger.some(e => e.ref === PROT), 'nem a trilha de solicitação de outra unidade');
  assert.throws(() => GP.auditoria(U.ti, { mes }), erroStatus(403));
});

test('notificações vão para os responsáveis certos', () => {
  const n5 = GP.notificacoes(U.ger5); const n1 = GP.notificacoes(U.ger1);
  assert.ok(n5.some(n => /APROVADA/.test(n.texto)), 'gerente recebe a decisão da própria solicitação');
  assert.ok(!n1.some(n => /E5/.test(n.texto)), 'gerente da E1 não recebe aviso da E5');
  assert.ok(GP.notificacoes(U.coord).some(n => /aguarda decisão/.test(n.texto)));
  GP.marcarLidas(U.ger5, ['*']); assert.equal(GP.notificacoes(U.ger5, true).length, 0);
});
