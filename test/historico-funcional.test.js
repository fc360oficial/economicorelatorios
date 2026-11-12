'use strict';
// test/historico-funcional.test.js — Controle contratual (experiência 30 + 60) e histórico funcional (lib/historico-funcional.js).
// Pastas temporárias: nada aqui toca data/ nem o ponto. "Hoje" é sempre passado por parâmetro (12/11/2026, quinta).
const fs = require('fs'), os = require('os'), path = require('path');
for (const [k, p] of [['GP_DIR', 'gp-hf-'], ['DISCIPLINAR_DIR', 'disc-hf-'], ['CGD_DIR', 'cgd-hf-'], ['HF_DIR', 'hf-']]) process.env[k] = fs.mkdtempSync(path.join(os.tmpdir(), p));
process.env.CGD_SEM_AQUECIMENTO = '1';
const test = require('node:test'); const assert = require('node:assert/strict');
const GP = require('../lib/gestao-pessoas'); const H = require('../lib/historico-funcional'); const DISC = require('../lib/disciplinar');

const U = { ger3: { usuario: 'ger3', nome: 'Gerente Ponte' }, rh: { usuario: 'rh', nome: 'Maria RH' }, rh5: { usuario: 'rh5', nome: 'RH Porta Larga' }, co: { usuario: 'co', nome: 'Coordenação' }, di: { usuario: 'di', nome: 'Diretoria' }, jur: { usuario: 'jur', nome: 'Jurídico' }, x: { usuario: 'x', nome: 'Sem papel' }, admin: { usuario: 'adm', nome: 'Admin', perfil: 'admin' } };
GP.salvarConfig({ designados: [{ usuario: 'ger3', nome: 'Gerente Ponte', papeis: ['gerente'], lojas: [3] }, { usuario: 'rh', nome: 'Maria RH', papeis: ['rh_doc', 'rh_adm', 'rh_ponto'] }, { usuario: 'rh5', nome: 'RH Porta Larga', papeis: ['rh_doc'], lojas: [5] },
  { usuario: 'co', nome: 'Coordenação', papeis: ['coordenacao'] }, { usuario: 'di', nome: 'Diretoria', papeis: ['diretoria'] }, { usuario: 'jur', nome: 'Jurídico', papeis: ['juridico'] }] }, U.admin);
const HOJE = '2026-11-12'; const status = s => e => e.status === s;
const c = (id, nome, loja, admissao, extra) => ({ id, nome, matricula: String(id), cargo: 'Operador de loja', setor: 'Frente de Caixa', loja, ativo: true, clt: true, admissao, status_agora: 'Trabalhando', ...extra });
const COLABS = { ativos: [c(11, 'Nova Um', 3, '2026-11-02'),           // 11º dia de experiência: término inicial 01/12
  c(12, 'Nova Dois', 3, '2026-10-05'),                                    // término inicial 03/11 já passou, sem prorrogação
  c(13, 'Prorrogada Tres', 5, '2026-09-01'),                              // término inicial 30/09; com prorrogação, final 29/11
  c(14, 'Antigo Quatro', 3, '2020-01-10'),                                // fora do período de experiência
  c(15, 'Recente Cinco', 5, '2026-11-09')], desligados: [c(16, 'Saiu Seis', 3, '2026-08-03', { ativo: false, desligamento: '2026-09-01' })] };
let AFAST = [{ nome: 'NOVA UM', inicio: '2026-11-09', fim: '2026-11-10', dias: 2, tipo: 'Atestado médico', obs: 'CID Z00.0 — repouso', ferias: false },
  { nome: 'ANTIGO QUATRO', inicio: '2026-11-02', fim: '2026-11-21', dias: 20, tipo: 'Férias', obs: '', ferias: true }, { nome: 'PESSOA QUE NAO EXISTE', inicio: '2026-11-03', fim: '2026-11-03', dias: 1, tipo: 'Atestado médico', obs: '', ferias: false }];
const FALTAS = [{ loja: 3, nome: 'Nova Um', data: '2026-11-09', abonada: false, motivo: '' }, { loja: 3, nome: 'Nova Um', data: '2026-11-06', abonada: false, motivo: '' }, { loja: 3, nome: 'Antigo Quatro', data: '2026-10-30', abonada: true, motivo: 'Abono do gerente' }];
const deps = { colaboradores: async () => COLABS, afastamentosLongos: async () => AFAST, resumo: async () => ({ listas: { faltas: FALTAS } }), cpfDe: async () => '', empregadorDe: async () => null, jornadaPeriodo: async () => ({ dias: [] }) };
const ultima = acao => fs.readFileSync(H.P.aud(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.acao === acao).pop();
const contrato = async (u, id, hoje) => (await H.ficha(u, id, deps, hoje || HOJE)).contrato;

test('contrato de experiência: 30 dias + prorrogação de 60 (até 90), calculado pelas datas e sem presumir prorrogação', async () => {
  assert.deepEqual([H.config().diasIniciais, H.config().diasProrrogacao, H.config().maxTotalDias, H.config().alertaDias], [30, 60, 90, [15, 10, 5, 3, 1]]);
  const k = await contrato(U.rh, 11);
  assert.equal(k.tipo, 'experiencia'); assert.equal(k.presumido, true); assert.equal(k.admissao, '2026-11-02'); assert.equal(k.admissaoOrigem, 'ponto');
  assert.equal(k.terminoInicial, '2026-12-01', 'admissão + 30 dias − 1'); assert.equal(k.finalComProrrogacao, '2027-01-30', '90º dia'); assert.equal(H._util.diasEntre('2026-11-02', '2027-01-30') + 1, 90);
  assert.equal(k.prorrogacao.situacao, 'pendente'); assert.equal(k.finalPrevisto, '2026-12-01', 'sem prorrogação formalizada o contrato termina no término inicial');
  assert.equal(k.situacao.codigo, 'experiencia_inicial'); assert.deepEqual(k.situacao.marco, { tipo: 'termino_inicial', tipoTxt: 'término do período inicial', data: '2026-12-01', dias: 19 }); assert.equal(k.situacao.risco, false);
  assert.deepEqual(k.pendencias.map(p => p.codigo), ['a_confirmar', 'prorrogacao_pendente']);
  assert.deepEqual((await H.painel(U.rh, deps, HOJE)).aConfirmar.map(x => x.id).sort(), [11, 12, 13, 15], 'quem entrou há pouco e ainda não teve o contrato conferido pelo RH');
  // quem entrou há muito tempo não entra no controle; desligado sem registro também não vira pendência
  assert.equal((await contrato(U.rh, 14)).situacao.codigo, 'fora'); assert.equal((await contrato(U.rh, 14)).pendencias.length, 0);
  // passou do término inicial sem prorrogação formalizada: NÃO impede o trabalho, sinaliza o risco de prazo indeterminado
  const v = await contrato(U.rh, 12); assert.equal(v.terminoInicial, '2026-11-03'); assert.equal(v.situacao.codigo, 'vencido_inicial'); assert.equal(v.situacao.risco, true); assert.equal(v.situacao.marco.dias, -9);
  assert.match(v.situacao.riscoTxt, /registre a prorrogação \(se foi formalizada, com a data e o documento\) ou o desfecho.*tende ao prazo indeterminado \(CLT arts\. 445 e 451\)/);
  // prazos padrão: configuráveis, nunca acima de 90 dias (art. 445, parágrafo único); só RH e Coordenação; auditado
  assert.throws(() => H.salvarConfig(U.ger3, { diasIniciais: 45, diasProrrogacao: 45, justificativa: 'mudar padrão' }), status(403));
  assert.throws(() => H.salvarConfig(U.co, { diasIniciais: 45, diasProrrogacao: 60, justificativa: 'mudar padrão' }), /não pode passar de 90 dias/); assert.throws(() => H.salvarConfig(U.co, { diasIniciais: 45, diasProrrogacao: 45 }), /Justifique/);
  assert.deepEqual([H.salvarConfig(U.co, { diasIniciais: 45, diasProrrogacao: 45, justificativa: 'teste do padrão 45 + 45' }).diasIniciais, (await contrato(U.rh, 11)).terminoInicial], [45, '2026-12-16']);
  assert.deepEqual([ultima('config').antes.diasIniciais, ultima('config').depois.diasIniciais, ultima('config').usuario], [30, 45, 'co']);
  H.salvarConfig(U.co, { diasIniciais: 30, diasProrrogacao: 60, justificativa: 'volta ao padrão 30 + 60' }); assert.equal((await contrato(U.rh, 11)).terminoInicial, '2026-12-01');
  // contrato ainda não conferido pelo RH e já passado do prazo: o texto diz que falta o REGISTRO, sem afirmar que não houve prorrogação
  const pres = await contrato(U.rh, 13); assert.equal(pres.situacao.texto, 'Término inicial passado, sem registro de prorrogação no sistema'); assert.match(pres.situacao.riscoTxt, /o sistema ainda não tem o registro deste contrato/);
  // primeira execução dos avisos (o módulo acabou de entrar no ar): o que já está vencido é acervo — sai UM resumo, não um aviso por contrato
  const ac = await H.avisarPrazos(deps, HOJE); assert.equal(ac.length, 1); assert.equal(ac[0].acervo, true); assert.deepEqual(ac[0].vencidos.slice().sort(), [12, 13]); assert.deepEqual(ac[0].proximos, []); assert.deepEqual(ac[0].para.slice().sort(), ['co', 'rh', 'rh5']);
  assert.equal(GP.notificacoes(U.co).filter(n => /entrou no ar: 2 contrato\(s\) de experiência já passaram do término inicial/.test(n.texto)).length, 1); assert.equal(GP.notificacoes(U.co).some(n => /VENCEU/.test(n.texto)), false);
  assert.deepEqual(await H.avisarPrazos(deps, HOJE), [], 'depois da primeira carga cada contrato segue a régua normal');
  assert.equal((await H.pendencias(U.rh, deps, HOJE)).n, 0, 'o acervo ainda não conferido fica no painel, não no contador do menu');
});

test('prorrogação: pendente até o RH formalizar com data e documento; uma única prorrogação; tudo com usuário, justificativa, antes e depois', async () => {
  const conf = { tipo: 'experiencia', justificativa: 'contrato de experiência conferido com a ficha de admissão' };
  await assert.rejects(H.alterarContrato(U.ger3, 13, 'confirmar', conf, deps, HOJE), status(403)); await assert.rejects(H.alterarContrato(U.rh5, 11, 'confirmar', conf, deps, HOJE), status(403), 'RH de outra unidade');
  await assert.rejects(H.alterarContrato(U.rh5, 13, 'confirmar', { tipo: 'experiencia' }, deps, HOJE), /Justificativa obrigatória/); await assert.rejects(H.alterarContrato(U.rh5, 13, 'confirmar', { ...conf, diasIniciais: 60, diasProrrogacao: 60 }, deps, HOJE), /90 dias/);
  let r = await H.alterarContrato(U.rh5, 13, 'confirmar', conf, deps, HOJE); assert.equal(r.contrato.presumido, false); assert.equal(r.contrato.confirmado, true); assert.equal(r.contrato.terminoInicial, '2026-09-30');
  assert.equal(r.contrato.situacao.codigo, 'vencido_inicial', 'sem prorrogação registrada o sistema não presume que houve');
  // formalizar exige data e documento
  await assert.rejects(H.alterarContrato(U.rh5, 13, 'prorrogacao', { situacao: 'formalizada', justificativa: 'termo assinado' }, deps, HOJE), /data em que a prorrogação foi formalizada/);
  await assert.rejects(H.alterarContrato(U.rh5, 13, 'prorrogacao', { situacao: 'formalizada', formalizadaEm: '2026-09-28', justificativa: 'termo assinado' }, deps, HOJE), /documento da prorrogação/);
  r = await H.alterarContrato(U.rh5, 13, 'prorrogacao', { situacao: 'formalizada', formalizadaEm: '2026-09-28', documento: { referencia: 'Termo de prorrogação assinado em 28/09/2026 (pasta 02 do prontuário)' }, justificativa: 'termo de prorrogação assinado pela funcionária' }, deps, HOJE);
  assert.equal(r.nota, null); assert.equal(r.contrato.prorrogacao.situacao, 'formalizada'); assert.equal(r.contrato.prorrogacao.foraDoPrazo, false); assert.equal(r.contrato.finalPrevisto, '2026-11-29'); assert.equal(r.contrato.situacao.codigo, 'prorrogado');
  assert.deepEqual(r.contrato.situacao.marco, { tipo: 'final', tipoTxt: 'término final do contrato', data: '2026-11-29', dias: 17 }); assert.deepEqual(r.contrato.pendencias.map(p => p.codigo), ['esocial_prorrogacao']);
  const a = ultima('contrato_prorrogacao'); assert.equal(a.usuario, 'rh5'); assert.equal(a.funcionario, 'Prorrogada Tres'); assert.equal(a.loja, 5); assert.ok(!isNaN(Date.parse(a.em))); assert.match(a.justificativa, /termo de prorrogação assinado/);
  assert.equal(a.antes.prorrogacao.situacao, 'pendente'); assert.equal(a.antes.finalPrevisto, '2026-09-30'); assert.equal(a.depois.prorrogacao.situacao, 'formalizada'); assert.equal(a.depois.finalPrevisto, '2026-11-29');
  assert.equal(r.contrato.historico.length, 2); assert.equal(r.contrato.historico[1].auditoria, a.seq);
  // uma única prorrogação (art. 451) e prazos travados depois de formalizada
  await assert.rejects(H.alterarContrato(U.rh5, 13, 'prorrogacao', { situacao: 'formalizada', formalizadaEm: '2026-11-10', documento: { referencia: 'segundo termo' }, justificativa: 'segunda prorrogação' }, deps, HOJE), /uma única prorrogação/);
  await assert.rejects(H.alterarContrato(U.rh5, 13, 'confirmar', { ...conf, diasIniciais: 45, diasProrrogacao: 45 }, deps, HOJE), /já foi formalizada/);
  // eSocial: sem integração — o RH confirma o envio à mão e a pendência sai
  r = await H.alterarContrato(U.rh5, 13, 'esocial', { evento: 'prorrogacao', informadoEm: '2026-09-29', recibo: '1.2.0000000000001', justificativa: 'evento de alteração contratual transmitido pela contabilidade' }, deps, HOJE); assert.deepEqual(r.contrato.pendencias, []);
  // responsáveis pela decisão e pela documentação
  r = await H.alterarContrato(U.rh5, 13, 'responsaveis', { decisao: 'Gerente da loja', documentacao: 'rh5', justificativa: 'definição dos responsáveis' }, deps, HOJE); assert.deepEqual(r.contrato.responsaveis, { decisao: 'Gerente da loja', documentacao: 'rh5' });
  // formalização DEPOIS do término inicial é aceita (o RH tem autonomia), mas fica marcada como risco
  r = await H.alterarContrato(U.rh, 12, 'prorrogacao', { situacao: 'formalizada', formalizadaEm: '2026-11-10', documento: { protocolo: 'CGD-2026-00012' }, justificativa: 'termo assinado com atraso' }, deps, HOJE);
  assert.match(r.nota, /depois do término inicial \(03\/11\/2026\).*validar com o jurídico/); assert.equal(r.contrato.prorrogacao.foraDoPrazo, true); assert.deepEqual(r.contrato.prorrogacao.documento, { tipo: 'cgd', protocolo: 'CGD-2026-00012' }); assert.ok(r.contrato.pendencias.some(p => p.codigo === 'prorrogacao_fora_do_prazo'));
  assert.ok(GP.notificacoes(U.co).some(n => /Nova Dois.*prorrogação formalizada.*validar com o jurídico/.test(n.texto)), 'a Coordenação é avisada da decisão');
  // "não realizada" e funcionário ainda ativo depois do término: risco sinalizado, trabalho não impedido
  await H.alterarContrato(U.rh5, 15, 'prorrogacao', { situacao: 'nao_realizada', justificativa: 'gerência decidiu não prorrogar' }, deps, HOJE);
  const depois = await contrato(U.rh5, 15, '2026-12-12'); assert.equal(depois.situacao.codigo, 'vencido_inicial'); assert.match(depois.situacao.riscoTxt, /com a prorrogação não realizada e o funcionário segue ativo/);
  // desfecho registrado encerra o controle (e o alerta)
  const d = await H.alterarContrato(U.rh5, 15, 'desfecho', { tipo: 'encerrado', data: '2026-12-08', justificativa: 'desligamento no término do contrato' }, deps, '2026-12-12'); assert.equal(d.contrato.situacao.codigo, 'encerrado'); assert.equal(d.contrato.situacao.risco, false);
  // ajuste do término (afastamento etc.) só com validação jurídica declarada
  await assert.rejects(H.alterarContrato(U.rh, 11, 'ajustar', { marco: 'inicial', novaData: '2026-12-03', justificativa: 'afastamento de 2 dias na experiência' }, deps, HOJE), /validada juridicamente/);
  const aj = await H.alterarContrato(U.rh, 11, 'ajustar', { marco: 'inicial', novaData: '2026-12-03', validacaoJuridica: true, justificativa: 'afastamento de 2 dias suspendeu a contagem, conforme parecer' }, deps, HOJE);
  assert.equal(aj.contrato.terminoInicial, '2026-12-03'); assert.equal(aj.contrato.finalComProrrogacao, '2027-02-01'); assert.equal(ultima('contrato_ajustar').antes.terminoInicial, '2026-12-01');
  await H.alterarContrato(U.rh, 11, 'ajustar', { marco: 'inicial', novaData: null, validacaoJuridica: true, justificativa: 'ajuste desfeito: parecer revisto' }, deps, HOJE); assert.equal((await contrato(U.rh, 11)).terminoInicial, '2026-12-01');
});

test('alertas em 15, 10, 5, 3 e 1 dia antes dos dois marcos; RH sempre, Coordenação na reta final; aberto até a providência', async () => {
  const para = (r, id) => r.filter(x => x.id === id);
  // Nova Um (11): término inicial em 01/12
  assert.deepEqual(para(await H.avisarPrazos(deps, '2026-11-15'), 11), [], '16 dias antes ainda não avisa');
  let a = para(await H.avisarPrazos(deps, '2026-11-16'), 11); assert.deepEqual(a.map(x => [x.marco, x.limite, x.dias]), [['termino_inicial', 15, 15]]); assert.deepEqual(a[0].para.sort(), ['rh'], '15 dias: só o RH que atende a loja');
  assert.deepEqual(para(await H.avisarPrazos(deps, '2026-11-17'), 11), [], 'cada limite avisa uma vez só');
  a = para(await H.avisarPrazos(deps, '2026-11-21'), 11); assert.equal(a[0].limite, 10); assert.deepEqual(a[0].para.sort(), ['rh']);
  a = para(await H.avisarPrazos(deps, '2026-11-26'), 11); assert.equal(a[0].limite, 5); assert.deepEqual(a[0].para.sort(), ['co', 'rh'], 'a partir de 5 dias a Coordenação também');
  assert.equal(para(await H.avisarPrazos(deps, '2026-11-28'), 11)[0].limite, 3); assert.equal(para(await H.avisarPrazos(deps, '2026-11-30'), 11)[0].limite, 1); assert.deepEqual(para(await H.avisarPrazos(deps, '2026-12-01'), 11), []);
  assert.ok(GP.notificacoes(U.rh).some(n => /Nova Um \(E3\): em 15 dia\(s\) vence o término do período inicial \(01\/12\/2026\) — prorrogação pendente/.test(n.texto)));
  assert.equal(GP.notificacoes(U.ger3).some(n => /Nova Um/.test(n.texto)), false, 'gerente não recebe os avisos de contrato');
  // passou do marco sem providência: avisa uma vez como vencido e o alerta continua aberto no painel
  a = para(await H.avisarPrazos(deps, '2026-12-02'), 11); assert.equal(a[0].vencido, true); assert.deepEqual(a[0].para.sort(), ['co', 'rh']); assert.deepEqual(para(await H.avisarPrazos(deps, '2026-12-03'), 11), []);
  assert.ok((await H.painel(U.rh, deps, '2026-12-20')).vencidos.some(x => x.id === 11), 'continua aberto 18 dias depois');
  // quem só é visto perto do prazo recebe um aviso só (o do limite da vez), sem rajada
  COLABS.ativos.push(c(17, 'Tardia Sete', 3, '2026-11-20'));   // término inicial em 19/12, vista pela primeira vez a 4 dias do prazo
  const tarde = para(await H.avisarPrazos(deps, '2026-12-15'), 17); assert.deepEqual(tarde.map(x => [x.marco, x.limite, x.dias]), [['termino_inicial', 5, 4]]); assert.deepEqual(para(await H.avisarPrazos(deps, '2026-12-15'), 17), []);
  assert.deepEqual(para(await H.avisarPrazos(deps, '2026-12-16'), 17).map(x => x.limite), [3]); COLABS.ativos.pop();
  // o segundo marco (término final do contrato prorrogado, 29/11 para a Prorrogada Tres) também foi avisado, na mesma régua
  const av13 = fs.readFileSync(H.P.aud(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.acao === 'aviso_prazo' && r.funcId === 13);
  assert.deepEqual(av13.filter(r => !r.vencido).map(r => [r.marco.tipo, r.limite]), [['final', 15], ['final', 10], ['final', 3], ['final', 1]], 'nas datas deste teste o agendador só rodou a 3 dias do prazo: o aviso de 5 foi pulado, sem rajada'); assert.equal(av13.filter(r => r.vencido).length, 1, 'e uma vez como vencido, depois de 29/11 sem desfecho');
  // providência registrada (efetivação) fecha o alerta: some do painel e não avisa mais
  await H.alterarContrato(U.rh, 11, 'desfecho', { tipo: 'efetivado', data: '2026-12-02', justificativa: 'efetivado por decisão da gerência' }, deps, '2026-12-20');
  assert.equal((await H.painel(U.rh, deps, '2026-12-20')).vencidos.some(x => x.id === 11), false); assert.deepEqual(para(await H.avisarPrazos(deps, '2026-12-21'), 11), []);
  assert.equal(ultima('aviso_prazo').usuario, 'sistema');
  await H.alterarContrato(U.rh, 11, 'desfecho', { desfazer: true, justificativa: 'desfecho lançado na pessoa errada (teste)' }, deps, HOJE); assert.equal((await contrato(U.rh, 11)).desfecho, null);
});

test('ocorrências do ponto: atestado entra uma vez só; dia sem marcação é indício (só vira falta quando o RH analisa); atestado apresentado nunca vira falta injustificada sozinho', async () => {
  const r = await H.sincronizarPonto(deps, { hoje: HOJE });
  assert.deepEqual([r.atestadosNovos, r.indiciosDias, r.indiciosAbonados, r.naoIdentificados.length], [1, 2, 1, 1]); assert.equal(r.naoIdentificados[0].nome, 'PESSOA QUE NAO EXISTE', 'nome que não casa com o cadastro não vira ocorrência de ninguém');
  const r2 = await H.sincronizarPonto(deps, { hoje: HOJE }); assert.deepEqual([r2.atestadosNovos, r2.atestadosAtualizados], [0, 0], 'sincronizar de novo não duplica');
  const at = H.ocorrenciasDe(11).find(o => o.tipo === 'atestado'); assert.match(at.id, /^OC-2026-\d{5}$/);
  assert.deepEqual([at.data, at.fim, at.dias, at.classificacao, at.situacao, at.origem, at.sensivel], ['2026-11-09', '2026-11-10', 2, 'atestado_medico', 'pendente_validacao', 'ponto', true]); assert.equal(H.ocorrenciasDe(14).some(o => o.tipo === 'atestado'), false, 'férias não são atestado');
  // o afastamento foi estendido no ponto: a MESMA ocorrência é atualizada, com trilha
  AFAST = AFAST.map(a => a.nome === 'NOVA UM' ? { ...a, fim: '2026-11-11', dias: 3 } : a); const r3 = await H.sincronizarPonto(deps, { hoje: HOJE }); assert.deepEqual([r3.atestadosNovos, r3.atestadosAtualizados], [0, 1]);
  const at2 = H.ocorrenciasDe(11).find(o => o.tipo === 'atestado'); assert.equal(at2.id, at.id); assert.equal(at2.fim, '2026-11-11'); assert.equal(at2.dias, 3); assert.equal(at2.historico.slice(-1)[0].acao, 'atualizada_pelo_ponto');
  // "falta" no relatório do ponto é dia sem marcação: NÃO vira ocorrência sozinha — fica como indício, com o atestado do período anotado
  assert.equal(H.ocorrenciasDe(11).filter(o => o.tipo === 'falta').length, 0); assert.equal(H.ocorrenciasDe(14).length, 0);
  assert.deepEqual(H.indiciosDe(11), [{ data: '2026-11-09', abonada: false, motivo: null, atestado: at.id }, { data: '2026-11-06', abonada: false, motivo: null, atestado: null }]);
  assert.deepEqual(H.indiciosDe(14), [{ data: '2026-10-30', abonada: true, motivo: 'Abono do gerente', atestado: null }]);
  // quem analisa é o RH da unidade, sempre com justificativa; com atestado no dia, "injustificada" exige a declaração de análise
  const falta = (extra) => ({ funcId: 11, tipo: 'falta', data: '2026-11-09', classificacao: 'justificada', justificativa: 'coberta pelo atestado de 09 a 11/11', ...extra });
  await assert.rejects(H.registrarOcorrencia(U.ger3, falta(), deps, HOJE), status(403)); await assert.rejects(H.registrarOcorrencia(U.rh5, falta(), deps, HOJE), status(403)); await assert.rejects(H.registrarOcorrencia(U.rh, falta({ justificativa: '' }), deps, HOJE), /Justificativa obrigatória/);
  await assert.rejects(H.registrarOcorrencia(U.rh, falta({ classificacao: 'injustificada', justificativa: 'não aceito' }), deps, HOJE), e => e.status === 409 && e.atestado === at.id && /não é lançada como injustificada/.test(e.message));
  const f9 = await H.registrarOcorrencia(U.rh, falta(), deps, HOJE); assert.deepEqual([f9.classificacao, f9.situacao, f9.origem, f9.atestado, f9.responsavel.usuario], ['justificada', 'analisada', 'ponto', at.id, 'rh']); assert.match(f9.id, /^OC-2026-\d{5}$/); assert.notEqual(f9.id, at.id, 'identificação única');
  // dia sem atestado: fica pendente de análise até o RH decidir — nenhuma falta nasce injustificada
  const f6 = await H.registrarOcorrencia(U.rh, { funcId: 11, tipo: 'falta', data: '2026-11-06', justificativa: 'aguardando a justificativa do funcionário' }, deps, HOJE); assert.deepEqual([f6.classificacao, f6.situacao, f6.origem, f6.detalhe.abonadaNoPonto], ['pendente', 'pendente_analise', 'ponto', false]);
  assert.deepEqual(H.indiciosDe(11), [], 'dia analisado sai da lista de indícios');
  assert.throws(() => H.decidirOcorrencia(U.ger3, f6.id, { acao: 'classificar', classificacao: 'injustificada', justificativa: 'sem justificativa' }), status(403)); assert.throws(() => H.decidirOcorrencia(U.rh, f6.id, { acao: 'classificar', classificacao: 'injustificada' }), /Justificativa obrigatória/);
  const i = H.decidirOcorrencia(U.rh, f6.id, { acao: 'classificar', classificacao: 'injustificada', justificativa: 'sem justificativa apresentada em 5 dias' }); assert.deepEqual([i.classificacao, i.situacao], ['injustificada', 'analisada']);
  const ad = ultima('ocorrencia_classificar'); assert.deepEqual([ad.antes.classificacao, ad.depois.classificacao, ad.usuario, ad.funcionario], ['pendente', 'injustificada', 'rh', 'Nova Um']);
  // reclassificar para injustificada uma falta com atestado também exige a declaração
  assert.throws(() => H.decidirOcorrencia(U.rh, f9.id, { acao: 'classificar', classificacao: 'injustificada', justificativa: 'atestado recusado' }), e => e.status === 409 && e.atestado === at.id && /declarar que analisou o atestado/.test(e.message));
  const v = H.decidirOcorrencia(U.rh, at.id, { acao: 'validar', documento: { protocolo: 'CGD-2026-00031' }, justificativa: 'atestado original conferido' }); assert.deepEqual([v.situacao, v.documento.protocolo], ['validado', 'CGD-2026-00031']);
  // ficha separa as faltas em justificadas, injustificadas e pendentes (e mostra os indícios ainda não analisados)
  const F = (await H.ficha(U.rh, 11, deps, HOJE)).faltas; assert.deepEqual([F.justificadas.length, F.injustificadas.length, F.pendentes.length, F.indicios.length], [1, 1, 0, 0]); assert.equal((await H.ficha(U.rh, 14, deps, HOJE)).faltas.indicios.length, 1);
  // sem duplicidade: o mesmo dia não é lançado duas vezes, nem um atestado sobre outro
  await assert.rejects(H.registrarOcorrencia(U.rh, { funcId: 11, tipo: 'falta', data: '2026-11-06', justificativa: 'falta informada pelo gerente' }, deps, HOJE), e => e.status === 409 && e.duplicada === f6.id);
  await assert.rejects(H.registrarOcorrencia(U.rh, { funcId: 11, tipo: 'atestado', data: '2026-11-10', fim: '2026-11-12', justificativa: 'atestado entregue no RH' }, deps, HOJE), e => e.status === 409 && /Já existe atestado/.test(e.message));
  await assert.rejects(H.registrarOcorrencia(U.rh, { funcId: 11, tipo: 'advertencia', data: '2026-11-05', justificativa: 'advertência verbal' }, deps, HOJE), /Gestão Disciplinar/);
  await assert.rejects(H.registrarOcorrencia(U.ger3, { funcId: 14, tipo: 'atestado', data: '2026-11-04', justificativa: 'atestado entregue' }, deps, HOJE), status(403));
  // lançamento manual quando o ponto não tem o registro
  const m = await H.registrarOcorrencia(U.rh, { funcId: 14, tipo: 'atestado', data: '2026-11-04', fim: '2026-11-04', classificacao: 'acompanhamento', obs: 'acompanhou o filho em consulta', documento: { referencia: 'declaração de comparecimento' }, justificativa: 'declaração entregue no RH; o ponto não tinha o registro' }, deps, HOJE);
  assert.deepEqual([m.origem, m.situacao, m.classificacao, m.sensivel], ['manual', 'validado', 'acompanhamento', true]);
  // cancelar (lançamento errado) não apaga: a ocorrência fica, cancelada, com a trilha
  const cx = H.decidirOcorrencia(U.rh, m.id, { acao: 'cancelar', justificativa: 'lançada no funcionário errado' }); assert.equal(cx.situacao, 'cancelada'); assert.equal(H.ocorrenciasDe(14).some(o => o.id === m.id), true); assert.throws(() => H.decidirOcorrencia(U.rh, m.id, { acao: 'validar', justificativa: 'reabrir' }), /cancelada/);
});

test('LGPD: motivo do afastamento e documento médico só para RH e Jurídico; os demais veem o período e a situação', async () => {
  for (const u of [U.rh, U.jur]) { const a = (await H.ficha(u, 11, deps, HOJE)).atestados[0]; assert.equal(a.restrito, false); assert.equal(a.detalhe.obs, 'CID Z00.0 — repouso'); assert.equal(a.classificacaoTxt, 'Atestado médico'); assert.equal(a.documento.protocolo, 'CGD-2026-00031'); }
  for (const u of [U.ger3, U.co, U.di]) { const f = await H.ficha(u, 11, deps, HOJE); const a = f.atestados[0]; assert.equal(f.veSensivel, false); assert.equal(a.restrito, true); assert.equal(a.detalhe, null); assert.equal(a.classificacaoTxt, 'Afastamento (detalhe restrito)'); assert.deepEqual(a.documento, { restrito: true });
    assert.deepEqual([a.data, a.fim, a.dias, a.situacaoTxt], ['2026-11-09', '2026-11-11', 3, 'Validado'], 'o período e a situação continuam visíveis: é o que a escala precisa'); assert.ok(!JSON.stringify(f).includes('CID'), 'nenhum trecho da ficha vaza o detalhe médico para ' + u.usuario); }
  assert.ok(!JSON.stringify(await H.painel(U.ger3, deps, HOJE)).includes('CID')); assert.ok(!JSON.stringify(await H.painel(U.co, deps, HOJE)).includes('CID'));
  // escopo por unidade e por papel
  await assert.rejects(H.ficha(U.ger3, 13, deps, HOJE), status(403), 'gerente não vê funcionário de outra loja'); await assert.rejects(H.ficha(U.x, 11, deps, HOJE), status(403)); await assert.rejects(H.ficha(U.rh5, 11, deps, HOJE), status(403), 'RH de outra unidade');
  await assert.rejects(H.painel(U.x, deps, HOJE), status(403)); assert.throws(() => H.trilha(U.ger3), status(403)); assert.equal((await H.ficha(U.ger3, 11, deps, HOJE)).auditoria, null, 'a aba Auditoria não é do gerente');
  assert.equal((await H.ficha(U.ger3, 11, deps, HOJE)).podeEditar, false); assert.equal((await H.ficha(U.rh, 11, deps, HOJE)).podeEditar, true);
});

test('ficha individual: contrato, atestados, advertências e suspensões (da Gestão Disciplinar), faltas, documentos (da Gestão Documental) e auditoria', async () => {
  const cdeps = { ...deps, colaboradores: async () => COLABS };
  const sus = await DISC.lancarAntigo(U.rh, { colabId: 14, medida: 'suspensao', dias: 1, dataOcorrencia: '2025-03-10', dataAplicacao: '2025-03-12', motivo: 'falta_injustificada', descricao: 'Falta injustificada em 10/03/2025, conforme registro arquivado no DP.', assinado: true }, cdeps);
  const adv = await DISC.lancarAntigo(U.rh, { colabId: 14, medida: 'advertencia', dataOcorrencia: '2025-06-02', dataAplicacao: '2025-06-03', motivo: 'insubordinacao', descricao: 'Recusa em cumprir orientação da supervisão no dia 02/06/2025, registrada pelo gerente.', assinado: true }, cdeps);
  const f = await H.ficha(U.rh, 14, deps, HOJE);
  assert.deepEqual(Object.keys(f).filter(k => ['contrato', 'atestados', 'advertencias', 'suspensoes', 'faltas', 'documentos', 'auditoria'].includes(k)).sort(), ['advertencias', 'atestados', 'auditoria', 'contrato', 'documentos', 'faltas', 'suspensoes']);
  assert.deepEqual(f.advertencias.map(x => [x.id, x.origem, x.medida]), [[adv.protocolo, 'disciplinar', 'advertencia']]); assert.deepEqual(f.suspensoes.map(x => [x.id, x.origem, x.dias]), [[sus.protocolo, 'disciplinar', 1]]);
  assert.equal(f.suspensoes[0].situacao, 'aplicada'); assert.equal(f.suspensoes[0].dataOcorrencia, '2025-03-10'); assert.equal(f.disciplinarErro, null);
  // nada é copiado: a medida continua existindo só na Gestão Disciplinar (identificação = o protocolo de lá)
  assert.equal(H.ocorrenciasDe(14).some(o => /advert|suspens/.test(o.tipo)), false); assert.equal(DISC.historicoColaborador(14, U.rh).penalidades.length, 2);
  // documentos: o prontuário da Gestão Documental, com as permissões dela
  assert.equal(f.documentosErro, null); assert.equal(f.documentos.total, 0); assert.ok(f.documentos.pastas.some(p => /Admiss/.test(p.nome))); assert.ok(f.documentos.pastas.some(p => p.sensivel));
  const g = await H.ficha(U.ger3, 14, deps, HOJE); assert.ok(g.documentos || g.documentosErro, 'quem não tem acesso ao prontuário recebe o aviso, não um erro da ficha inteira');
  // auditoria da pessoa: só o que é dela, com antes e depois
  const a11 = (await H.ficha(U.rh, 11, deps, HOJE)).auditoria; assert.ok(a11.length >= 6); assert.ok(a11.every(x => x.acaoTxt && x.hash.length === 12)); assert.ok(a11.some(x => x.acao === 'ocorrencia_classificar' && x.antes && x.depois)); assert.ok(a11.some(x => x.acao === 'contrato_ajustar'));
  assert.equal(f.auditoria.some(x => x.acao === 'contrato_ajustar'), false, 'a trilha de um não aparece na ficha do outro');
  // afastamento dentro da experiência é sinalizado para análise jurídica — o término não muda sozinho
  const k = (await H.ficha(U.rh, 11, deps, HOJE)).contrato; assert.ok(k.pendencias.some(p => p.codigo === 'afastamento_na_experiencia' && /1 afastamento\(s\) dentro do período de experiência \(3 dia\(s\)\)/.test(p.texto))); assert.equal(k.terminoInicial, '2026-12-01');
});

test('painel de alertas e destaque na escala', async () => {
  const p = await H.painel(U.rh, deps, '2026-11-20');
  assert.deepEqual(Object.keys(p.resumo).sort(), ['aConfirmar', 'atestadosPendentes', 'disciplinares', 'faltasPendentes', 'impactoEscala', 'prorrogacoesPendentes', 'proximos', 'vencidos']);
  assert.deepEqual(p.proximos.map(x => [x.id, x.marco.tipo, x.marco.dias]), [[13, 'final', 9], [11, 'termino_inicial', 11]]); assert.deepEqual(p.prorrogacoesPendentes.map(x => x.id), [11]);
  assert.deepEqual(p.vencidos.map(x => x.id), [], 'Nova Dois teve a prorrogação formalizada (com atraso): não está mais vencida');
  assert.deepEqual(p.aConfirmar, [], 'todos os contratos de experiência em aberto já passaram pelo RH nos testes de cima');
  assert.equal(p.atestadosPendentes.length, 0); assert.equal(p.faltasPendentes.length, 0); assert.deepEqual(p.indiciosPonto, { dias: 0, pessoas: 0, top: [] }, 'os dois dias sem marcação já foram analisados; o abonado no ponto não conta'); assert.equal(p.disciplinares.length, 0, 'as medidas de 2025 estão fora da janela de 90 dias');
  assert.ok(p.impactoEscala.some(x => x.tipo === 'contrato' && x.id === 13 && /término final do contrato em 29\/11\/2026/.test(x.texto)));
  // afastamento em curso entra no que impacta a escala; o detalhe médico não vai junto
  const q = await H.painel(U.ger3, deps, '2026-11-10'); assert.ok(q.impactoEscala.some(x => x.tipo === 'afastamento' && x.id === 11 && x.ate === '2026-11-11')); assert.equal(q.proximos.some(x => x.id === 13), false, 'gerente só vê a loja dele');
  assert.ok((await H.pendencias(U.rh, deps, '2026-11-20')).n >= 1); assert.deepEqual(await H.pendencias(U.x, deps, HOJE), { n: 0 }, 'o contador do menu nunca dá erro');
  // selo na escala: quem está em experiência e quantos dias faltam (a cor do turno não é tocada)
  const d = await H.destaques(U.ger3, 3, deps, HOJE); assert.deepEqual(Object.keys(d).sort(), ['11', '12']);
  assert.deepEqual([d[11].rotulo, d[11].nivel], ['EXP 19d', 'ok']); assert.match(d[11].titulo, /término do período inicial em 01\/12\/2026 \(faltam 19 dia\(s\)\).*prorrogação pendente/);
  assert.equal(d[12].rotulo, 'EXP 51d', 'prorrogado: o marco passa a ser o término final (02/01/2027)'); assert.deepEqual(await H.destaques(U.ger3, 5, deps, HOJE), {}, 'loja fora do escopo não devolve nada'); assert.deepEqual(await H.destaques(U.x, 3, deps, HOJE), {});
  const venc = await H.destaques(U.rh, 3, deps, '2026-12-20'); assert.deepEqual([venc[11].rotulo, venc[11].nivel], ['EXP vencido', 'critico']);
  // lista de contratos com filtro
  const l = await H.listarContratos(U.rh, deps, { so: 'experiencia' }, HOJE); assert.deepEqual(l.map(x => x.pessoa.id).sort(), [11, 12, 13]); assert.equal((await H.listarContratos(U.rh, deps, { q: 'antigo' }, HOJE))[0].situacao.codigo, 'fora');
});

test('auditoria: trilha encadeada, só de acréscimo, com usuário, data e hora, ação, justificativa, antes e depois', () => {
  const t = H.trilha(U.co); assert.equal(t.cadeia.ok, true); assert.ok(t.total >= 20);
  for (const r of t.registros.filter(x => /^contrato_|^ocorrencia_|^config$/.test(x.acao))) { assert.ok(r.usuario && r.nome && !isNaN(Date.parse(r.em)) && r.acaoTxt, JSON.stringify(r)); assert.ok(r.justificativa && r.justificativa.length >= 5, r.acao); assert.ok(r.depois !== null || r.acao === 'ocorrencia_lancar' || r.antes !== null); }
  assert.deepEqual(Object.keys(H).filter(k => /exclu|apag|remov|limpar/i.test(k)), [], 'o serviço não tem função de exclusão');
  const orig = fs.readFileSync(H.P.aud(), 'utf8'); fs.writeFileSync(H.P.aud(), orig.replace('efetivado por decisão da gerência', 'texto adulterado')); assert.equal(H.verificarCadeia().ok, false); fs.writeFileSync(H.P.aud(), orig); assert.equal(H.verificarCadeia().ok, true);
});
