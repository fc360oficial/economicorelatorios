// test/disciplinar.test.js — Gestão Disciplinar: fluxo completo dos quatro perfis (gerente → RH → Coordenação → jurídico → gerente → RH),
// devoluções, indeferimento, recusa de assinatura, dupla punição, limite do art. 474, integração com a folha e relatórios.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-disc-teste-'));
process.env.DISCIPLINAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-teste-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const GP = require('../lib/gestao-pessoas');
const D = require('../lib/disciplinar');

const U = {
  ger4: { usuario: 'ger4', nome: 'João Silva', perfil: 'gerente' }, ger5: { usuario: 'ger5', nome: 'Gerente E5', perfil: 'gerente' },
  rh: { usuario: 'rh1', nome: 'Maria RH', perfil: 'gerente' }, rh2: { usuario: 'rh2', nome: 'RH Loja 5', perfil: 'gerente' },
  coord: { usuario: 'coord', nome: 'Coordenação', perfil: 'gerente' }, dir: { usuario: 'dir', nome: 'Diretoria', perfil: 'gerente' },
  jur: { usuario: 'jur', nome: 'Jurídico', perfil: 'gerente' }, admin: { usuario: 'tiago', nome: 'Admin', perfil: 'admin' }, ninguem: { usuario: 'x', nome: 'Sem papel', perfil: 'gerente' },
};
GP.salvarConfig({ designados: [
  { usuario: 'ger4', nome: 'João Silva', papeis: ['gerente'], lojas: [4] }, { usuario: 'ger5', nome: 'Gerente E5', papeis: ['gerente'], lojas: [5] },
  { usuario: 'rh1', nome: 'Maria RH', papeis: ['rh_doc', 'rh_ponto'] }, { usuario: 'rh2', nome: 'RH Loja 5', papeis: ['rh_doc'], lojas: [5] },
  { usuario: 'coord', nome: 'Coordenação', papeis: ['coordenacao'] }, { usuario: 'dir', nome: 'Diretoria', papeis: ['diretoria'] }, { usuario: 'jur', nome: 'Jurídico', papeis: ['juridico'] },
] }, U.admin);

const COLABS = { ativos: [
  { id: 1045, nome: 'Ana Paula Souza', matricula: '1045', cargo: 'Operadora de Caixa', setor: 'Frente de Caixa', loja: 4, ativo: true, status_agora: 'Trabalhando', admissao: '2024-03-01', unidade_id: 77, unidade: 'ATACAREJO COMERCIO DE ALIMENTOS' },
  { id: 2001, nome: 'Carlos Lima', matricula: '2001', cargo: 'Repositor', setor: 'Mercearia', loja: 5, ativo: true, status_agora: 'Trabalhando', admissao: '2023-01-10' },
], desligados: [{ id: 3001, nome: 'Ex Funcionário', matricula: '3001', cargo: 'Repositor', setor: 'Mercearia', loja: 4, ativo: false }] };
const deps = { cpfDe: async id => id === 1045 ? '12345678909' : '', empregadorDe: async id => id === 1045 ? { nome: 'ATACAREJO', razao: 'ATACAREJO COMERCIO DE ALIMENTOS LTDA', cnpj: '12.345.678/0001-90' } : null, colaboradores: async () => COLABS, jornadaPeriodo: async (id, de, ate) => ({ dias: [{ data: de, situacao: 'sem_marcacao', situacaoTxt: 'Sem marcação', marcacoes: [], previsto: null }] }) };
const hoje = D._util.hojeISO(); const amanha = D._util.somaDias(hoje, 1);
const oc = (extra = {}) => ({ colabId: 1045, motivo: 'insubordinacao', medidaSugerida: 'suspensao', data: hoje, hora: '14:00', local: 'Frente de caixa', descricao: 'A colaboradora se recusou a cumprir orientação da supervisão, elevando o tom de voz e deixando o posto sem autorização.', ...extra });
const anexo = n => ({ nome: n, arquivo: 'a'.repeat(32) + '.pdf', tamanho: 10, tipo: 'application/pdf', hash: 'h' });
const erroStatus = st => e => e.status === st;

test('1 · gerente só abre pra colaborador da própria unidade; desligado não cabe; sem papel = 403', async () => {
  await assert.rejects(D.criar(U.ger5, oc(), deps), erroStatus(403));
  await assert.rejects(D.criar(U.ger4, oc({ colabId: 3001 }), deps), /desligado/);
  await assert.rejects(D.criar(U.rh, oc(), deps), erroStatus(403));
  await assert.rejects(D.criar(U.ninguem, oc(), deps), erroStatus(403));
  await assert.rejects(D.criar(U.ger4, oc({ data: amanha }), deps), /futura/);
  await assert.rejects(D.criar(U.ger4, oc({ descricao: 'curto' }), deps), /Descrição/);
});

let P1;
test('2 · solicitação enviada: protocolo DISC, status Em análise, RH notificado, gerente não altera a original', async () => {
  const s = await D.criar(U.ger4, oc(), deps);
  P1 = s.protocolo; assert.match(P1, /^DISC-\d{4}-0001$/);
  assert.equal(s.status, 'enviado_rh'); assert.equal(s.colaborador.nome, 'Ana Paula Souza'); assert.equal(s.loja, 4);
  assert.ok(GP.notificacoes(U.rh, true).some(n => n.ref === P1));
  assert.equal(GP.notificacoes(U.rh2, true).some(n => n.ref === P1), false, 'RH restrito à loja 5 não recebe aviso da loja 4');
  assert.throws(() => D.editar(P1, U.ger4, { descricao: 'mudando' }), erroStatus(409), 'original bloqueada depois do envio');
  D.complementar(P1, U.ger4, 'Complemento: houve duas testemunhas no setor.'); assert.equal(D.obter(P1).complementos.length, 1);
  assert.deepEqual(D.acoes(U.ger4, D.obter(P1)).sort(), ['anexar', 'cancelar', 'complementar']);
  assert.deepEqual(D.acoes(U.dir, D.obter(P1)), [], 'Diretoria só consulta');
  assert.ok(D.podeVer(U.dir, D.obter(P1)));
  assert.equal(D.podeVer(U.ger5, D.obter(P1)), false, 'isolamento entre lojas');
  assert.equal(D.podeVer(U.rh2, D.obter(P1)), false, 'RH restrito à loja 5 não vê loja 4');
  assert.equal(D.pendencias(U.rh).n, 1); assert.equal(D.pendencias(U.ger4).n, 0);
});

test('3 · dupla punição pelo mesmo fato: bloqueia, salvo fato distinto justificado', async () => {
  await assert.rejects(D.criar(U.ger4, oc(), deps), e => e.status === 409 && e.duplicados[0].protocolo === P1);
  const s2 = await D.criar(U.ger4, oc({ confirmarFatoDistinto: true, justificativaFatoDistinto: 'Segunda ocorrência no turno da noite, outro supervisor.' }), deps);
  assert.equal(s2.fatoDistinto.protocolos[0], P1); D.cancelar(s2.protocolo, U.ger4, 'Aberto por engano no teste.'); assert.equal(D.obter(s2.protocolo).status, 'cancelado');
});

test('4 · RH: esclarecimento ida e volta, art. 474 e limite configurado, deferimento com medida diferente da sugerida', async () => {
  assert.throws(() => D.deferir(P1, U.rh, { medida: 'advertencia' }), erroStatus(409), 'precisa iniciar a análise');
  D.analisar(P1, U.rh); assert.equal(D.obter(P1).status, 'em_analise_rh');
  D.esclarecer(P1, U.rh, 'Havia câmera no local? Anexar imagens se possível.'); assert.equal(D.obter(P1).status, 'aguardando_esclarecimentos');
  assert.equal(D.pendencias(U.ger4).n, 1);
  assert.throws(() => D.deferir(P1, U.rh, { medida: 'advertencia' }), erroStatus(409));
  D.responder(P1, U.ger4, 'Sim, imagens anexadas; o registro bate com o relato.'); assert.equal(D.obter(P1).status, 'em_analise_rh');
  assert.equal(D.obter(P1).esclarecimentos[0].resposta.slice(0, 3), 'Sim');
  const base = { medida: 'suspensao', fundamentos: ['clt_482_h', 'clt_2'], justificativa: 'Após análise dos fatos, evidências e histórico funcional, a conduta configura insubordinação; suspensão curta é proporcional e educativa.', inicio: amanha };
  assert.throws(() => D.deferir(P1, U.rh, { ...base, dias: 31 }), /474/);
  D.salvarConfig({ maxDiasSuspensao: 10 }, U.coord);
  assert.throws(() => D.deferir(P1, U.rh, { ...base, dias: 15 }), /limite configurado/);
  assert.throws(() => D.deferir(P1, U.rh, { ...base, dias: 2, inicio: D._util.somaDias(hoje, -1) }), /passado/);
  assert.throws(() => D.deferir(P1, U.rh, { ...base, fundamentos: [] }), /hipótese legal/);
  assert.throws(() => D.deferir(P1, U.rh2, { ...base, dias: 2 }), erroStatus(403), 'RH de outra loja não decide');
  const s = D.deferir(P1, U.rh, { ...base, dias: 2 });
  assert.equal(s.status, 'deferido_rh'); assert.equal(s.analise.termino, D._util.somaDias(amanha, 1)); assert.equal(s.analise.retorno, D._util.somaDias(amanha, 2)); assert.equal(s.analise.revisaoRecomendada, false);
  assert.throws(() => D.deferir(P1, U.rh, { ...base, dias: 2 }), erroStatus(409), 'clique repetido não decide duas vezes');
});

test('5 · prévia e emissão do PDF; gerente recebe; reemissão gera v2 e preserva v1', async () => {
  const prev = await D.previa(P1, U.rh, {}); assert.equal(prev.slice(0, 5).toString(), '%PDF-');
  const s = await D.emitir(P1, U.rh, { orientacoes: 'Comunicar reservadamente, com uma testemunha.' }, deps);
  assert.equal(s.status, 'documento_encaminhado'); assert.equal(s.documento.versao, 1); assert.equal(s.documento.tipo, 'suspensao');
  assert.equal(s.documento.comCpf, true); assert.equal(s.documento.empregador.cnpj, '12.345.678/0001-90'); assert.equal(JSON.stringify(s).includes('12345678909'), false, 'CPF inteiro nunca fica no JSON');
  assert.equal(s.colaborador.unidadeVr.id, 77);
  assert.ok(fs.existsSync(D.P.pdf(P1, 1))); assert.ok(GP.notificacoes(U.ger4, true).some(n => /disponível para aplicação/.test(n.texto)));
  assert.throws(() => D.arquivoPdf(P1, U.ger5), erroStatus(403));
  assert.equal(D.arquivoPdf(P1, U.ger4).doc.versao, 1);
  const s2 = await D.emitir(P1, U.rh, { motivo: 'Corrigido o setor no cabeçalho.' }); assert.equal(s2.documento.versao, 2); assert.equal(s2.documentos.length, 2); assert.ok(fs.existsSync(D.P.pdf(P1, 1)));
});

test('6 · gerente comunica, anexa assinado; RH devolve (correção) e depois aprova → concluído + pendência de folha (sem duplicar)', async () => {
  assert.throws(() => D.devolverAssinado(P1, U.ger4, [], {}, false), /Envie o documento/);
  D.comunicar(P1, U.ger4, { data: hoje }); assert.equal(D.obter(P1).status, 'aguardando_devolucao_assinada');
  D.devolverAssinado(P1, U.ger4, [anexo('assinado.pdf')], { data: hoje }, false); assert.equal(D.obter(P1).status, 'aguardando_conferencia_rh');
  assert.throws(() => D.conferir(P1, U.rh, false, 'curto', 'nova_digitalizacao'), /Justificativa/);
  D.conferir(P1, U.rh, false, 'Digitalização ilegível na assinatura. Reenviar.', 'nova_digitalizacao'); assert.equal(D.obter(P1).status, 'correcao_documental');
  D.devolverAssinado(P1, U.ger4, [anexo('assinado-2.pdf')], {}, false);
  const s = D.conferir(P1, U.rh, true, 'Conferido, assinatura legível.');
  assert.equal(s.status, 'concluido'); assert.equal(s.aplicacao.dataAplicacao, hoje); assert.ok(s.concluidoEm);
  assert.notEqual(s.aplicacao.dataAplicacao, s.concluidoEm, 'data de aplicação ≠ encerramento administrativo');
  const f = D.folhaListar(U.rh); assert.equal(f.length, 1); assert.equal(f[0].status, 'pendente'); assert.equal(f[0].dias, 2);
  const pt = await D.folhaPonto(P1, U.rh, deps); assert.equal(pt.aindaNaoComecou, true);
  D.folhaConferir(P1, U.rh, { resultado: 'lancado', texto: 'Lançado no fechamento.' }); assert.equal(D.folhaListar(U.rh)[0].status, 'conferido');
  assert.throws(() => D.folhaConferir(P1, U.rh, { texto: 'de novo' }), /Já conferido/);
  const h = D.historicoColaborador(1045, U.ger4); assert.equal(h.penalidades.length, 1); assert.equal(h.penalidades[0].situacao, 'aplicada'); assert.equal(h.administrativas.length, 1, 'cancelado = registro administrativo');
});

let P2;
test('7 · indeferimento → Coordenação devolve → RH insiste → Coordenação pede jurídico → RH encaminha → parecer → RH confirma indeferimento → Coordenação encerra', async () => {
  P2 = (await D.criar(U.ger4, oc({ motivo: 'atrasos_recorrentes', medidaSugerida: 'advertencia', data: D._util.somaDias(hoje, -3), descricao: 'Três atrasos acima de 15 minutos na semana, sem justificativa apresentada.' }), deps)).protocolo;
  D.analisar(P2, U.rh);
  assert.throws(() => D.coordenacao(P2, U.coord, 'devolver_rh', 'ainda não chegou'), erroStatus(409));
  D.indeferir(P2, U.rh, 'Os atrasos não ultrapassam a tolerância contratual e não há orientação anterior registrada.');
  assert.equal(D.obter(P2).status, 'aguardando_coordenacao'); assert.ok(GP.notificacoes(U.coord, true).some(n => n.ref === P2));
  assert.equal(GP.notificacoes(U.ger4, true).some(n => n.ref === P2 && /indefer/i.test(n.texto)), false, 'gerente não é avisado de indeferimento não confirmado');
  D.coordenacao(P2, U.coord, 'devolver_rh', 'Verificar com o ponto se a tolerância foi mesmo respeitada.'); assert.equal(D.obter(P2).status, 'devolvido_rh');
  D.indeferir(P2, U.rh, 'Confirmado pelo ponto: atrasos dentro da tolerância de 10 min do PontoCerto.'); assert.equal(D.obter(P2).indeferimento.rodada, 2);
  D.coordenacao(P2, U.coord, 'solicitar_juridico', 'Consultar o jurídico sobre a tolerância aplicável.'); assert.equal(D.obter(P2).status, 'juridico_solicitado');
  assert.throws(() => D.parecerJuridico(P2, U.jur, 'parecer antes da hora', hoje), erroStatus(409));
  D.encaminharJuridico(P2, U.rh, 'Encaminhado e-mail com o espelho de ponto e a solicitação.'); assert.equal(D.obter(P2).status, 'aguardando_parecer_juridico');
  assert.ok(D.podeVer(U.jur, D.obter(P2)), 'jurídico só vê o que foi encaminhado'); assert.equal(D.podeVer(U.jur, D.obter(P1)), false);
  D.parecerJuridico(P2, U.jur, 'Tolerância de 10 min diários (art. 58 §1º CLT): não cabe medida.', hoje); assert.equal(D.obter(P2).status, 'devolvido_rh');
  D.indeferir(P2, U.rh, 'Mantida a proposta de indeferimento conforme parecer jurídico.');
  const s = D.coordenacao(P2, U.coord, 'confirmar_indeferimento', 'Concordo com o indeferimento. Solicitação encerrada.');
  assert.equal(s.status, 'indeferido_encerrado'); assert.ok(GP.notificacoes(U.ger4, true).some(n => n.ref === P2 && /encerrado/.test(n.texto)));
  const h = D.historicoColaborador(1045, U.rh); assert.equal(h.penalidades.length, 1); assert.equal(h.administrativas.length, 2); assert.equal(h.administrativas[0].situacao, 'nao_convertida');
});

test('8 · recusa de assinatura com testemunhas; "nenhuma medida" encerra sem documento; RH pode trocar suspensão por advertência', async () => {
  const p = (await D.criar(U.ger5, oc({ colabId: 2001, motivo: 'normas_internas', medidaSugerida: 'suspensao', descricao: 'Uso de celular na área de vendas após três orientações verbais registradas.' }), deps)).protocolo;
  D.analisar(p, U.rh2);
  const s = D.deferir(p, U.rh2, { medida: 'advertencia', fundamentos: ['regulamento'], justificativa: 'Primeira ocorrência formal; advertência escrita é proporcional. Alterada a medida sugerida pelo gerente.' });
  assert.equal(s.analise.alterouMedida, true); assert.equal(s.analise.medida, 'advertencia');
  await D.emitir(p, U.rh2, {}); D.comunicar(p, U.ger5, {});
  assert.throws(() => D.devolverAssinado(p, U.ger5, [anexo('recusa.jpg')], {}, true), /testemunhas/);
  D.devolverAssinado(p, U.ger5, [anexo('recusa.jpg')], { testemunhas: 'Pedro Alves (CPF ...), Joana Dias (CPF ...)' }, true);
  assert.equal(D.obter(p).aplicacao.assinado, false); assert.equal(D.obter(p).status, 'aguardando_conferencia_rh');
  D.conferir(p, U.rh2, true, 'Recusa registrada com duas testemunhas.'); assert.equal(D.obter(p).status, 'concluido');
  assert.equal(D.folhaListar(U.rh).length, 1, 'advertência não gera pendência de folha');
  const p3 = (await D.criar(U.ger5, oc({ colabId: 2001, motivo: 'outros', motivoOutro: 'Uniforme incompleto', medidaSugerida: 'advertencia', data: D._util.somaDias(hoje, -1), descricao: 'Compareceu sem o crachá em dois dias seguidos, apesar da orientação.' }), deps)).protocolo;
  D.analisar(p3, U.rh); const s3 = D.deferir(p3, U.rh, { medida: 'nenhuma', justificativa: 'Orientação verbal registrada é suficiente neste momento; sem medida disciplinar.' });
  assert.equal(s3.status, 'concluido'); assert.equal(s3.documento, null);
  const h = D.historicoColaborador(2001, U.rh); assert.equal(h.penalidades.length, 1); assert.equal(h.administrativas.length, 1);
});

test('8b · perfil gerencial (celular) é gerente da loja_id sem designação: abre, responde, vê só a própria loja', async () => {
  const gc = { usuario: 'cel4', nome: 'Gerente Celular E4', perfil: 'gerencial', loja_id: 4 }; const gc5 = { usuario: 'cel5', nome: 'Gerente Celular E5', perfil: 'gerencial', loja_id: 5 };
  assert.equal(D.permissoes(gc).solicitar, true); assert.equal(D.permissoes(gc).gerencial, true); assert.deepEqual(D.lojasGerente(gc), [4]);
  assert.equal(D.permissoes({ usuario: 'semloja', perfil: 'gerencial' }).ver, false);
  await assert.rejects(D.criar(gc, oc({ colabId: 2001 }), deps), erroStatus(403), 'colaborador da loja 5');
  const s = await D.criar(gc, oc({ motivo: 'conduta_inadequada', data: D._util.somaDias(hoje, -9), descricao: 'Discussão com cliente na frente do caixa, com palavras de baixo calão, após orientação anterior.' }), deps);
  assert.equal(s.status, 'enviado_rh'); assert.equal(s.historico[0].papeis[0], 'gerente (celular)');
  assert.ok(D.podeVer(gc, s)); assert.equal(D.podeVer(gc5, s), false); assert.ok(D.podeVer(U.rh, s));
  assert.equal(D.painel(gc).lista.some(x => x.protocolo === s.protocolo), true); assert.equal(D.painel(gc5).lista.some(x => x.protocolo === s.protocolo), false);
  D.analisar(s.protocolo, U.rh); D.esclarecer(s.protocolo, U.rh, 'Havia testemunhas? Informe os nomes.'); assert.equal(D.pendencias(gc).n, 1);
  D.responder(s.protocolo, gc, 'Sim: duas operadoras de caixa presenciaram.'); assert.equal(D.obter(s.protocolo).status, 'em_analise_rh');
  D.cancelar(s.protocolo, U.rh, 'Encerrado no teste do perfil gerencial.');
});

test('8c · registros antigos: só RH e administrador lançam; entram como penalidade aplicada marcada como manual; admin não designado só vê esses', async () => {
  const ant = { colabId: 2001, medida: 'suspensao', dias: 1, dataOcorrencia: '2025-03-10', dataAplicacao: '2025-03-12', motivo: 'falta_injustificada', descricao: 'Falta injustificada em 10/03/2025, conforme advertência arquivada no DP.', assinado: true };
  await assert.rejects(D.lancarAntigo(U.ger5, ant, deps), erroStatus(403)); await assert.rejects(D.lancarAntigo(U.coord, ant, deps), erroStatus(403)); await assert.rejects(D.lancarAntigo(U.dir, ant, deps), erroStatus(403));
  await assert.rejects(D.lancarAntigo(U.admin, { ...ant, dataAplicacao: '2025-03-01' }, deps), /anterior/); await assert.rejects(D.lancarAntigo(U.admin, { ...ant, dias: 31 }, deps), /474/);
  const s = await D.lancarAntigo(U.admin, ant, deps);
  assert.equal(s.status, 'concluido'); assert.equal(s.origem, 'manual'); assert.equal(s.analise.termino, '2025-03-12'); assert.equal(s.analise.retorno, '2025-03-13'); assert.equal(s.historico[0].papeis[0], 'administrador');
  const h = D.historicoColaborador(2001, U.rh); assert.equal(h.penalidades.length, 2); assert.equal(h.penalidades.find(x => x.protocolo === s.protocolo).origem, 'manual');
  assert.ok(D.podeVer(U.ger5, s), 'gerente da loja vê no histórico'); assert.ok(D.podeVer(U.admin, s)); assert.equal(D.podeVer(U.admin, D.obter(P1)), false, 'admin não designado não vê protocolo do fluxo');
  assert.equal(D.folhaListar(U.rh).length, 1, 'registro antigo não gera pendência de folha');
  assert.equal(D.listarAntigos(U.rh).length, 1); assert.throws(() => D.listarAntigos(U.coord), erroStatus(403));
  assert.deepEqual(D.acoes(U.admin, s).sort(), ['anexar', 'cancelar']); assert.deepEqual(D.acoes(U.ger5, s), []);
  D.registrarAnexos(s.protocolo, U.rh, [anexo('advertencia-2025.pdf')], 'antigo', 'Digitalizado do arquivo'); assert.equal(D.obter(s.protocolo).anexos[0].categoria, 'antigo');
  const s2 = await D.lancarAntigo(U.rh, { ...ant, colabId: 1045, medida: 'advertencia', dataOcorrencia: '2024-11-02', dataAplicacao: '2024-11-02', motivo: 'atrasos_recorrentes', descricao: 'Atrasos reiterados em outubro/2024.' }, deps);
  D.cancelar(s2.protocolo, U.rh, 'Lançado no funcionário errado.'); assert.equal(D.obter(s2.protocolo).status, 'cancelado');
  assert.equal(D.historicoColaborador(1045, U.rh).penalidades.length, 1);
});

test('9 · painel, listagem com escopo, relatórios (xlsx/pdf) e configuração', async () => {
  const pg = D.painel(U.ger4); assert.equal(pg.lista.length, 5, 'P1, P2, o cancelado, o do celular e o registro antigo cancelado'); assert.equal(pg.indicadores.concluidos, 1); assert.equal(pg.indicadores.indeferidos, 1);
  assert.equal(D.painel(U.ger5).lista.length, 3); assert.equal(D.painel(U.coord).lista.length, 8); assert.equal(D.painel(U.rh2).lista.length, 4, 'RH vê todos os registros antigos');
  assert.equal(D.listar(U.coord, { status: 'concluido' }).length, 4); assert.equal(D.listar(U.coord, { q: 'ana paula' }).length, 5); assert.equal(D.listar(U.coord, { medida: 'advertencia' }).length, 3);
  assert.throws(() => D.relatorio(U.ger4), erroStatus(403));
  const r = D.relatorio(U.dir); assert.equal(r.totais.solicitacoes, 8); assert.equal(r.totais.suspensoes, 2); assert.equal(r.totais.advertencias, 1); assert.equal(r.totais.indeferimentos, 1); assert.equal(r.totais.juridico, 1); assert.ok(r.totais.tempoMedioAnaliseHoras >= 0);
  assert.equal(r.porLoja.find(l => l.loja === 4).total, 5);
  const x = await D.relatorioXlsx(U.coord, {}); assert.ok(x.byteLength > 1000); const pdf = await D.relatorioPdf(U.coord, {}); assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  assert.throws(() => D.salvarConfig({ maxDiasSuspensao: 45 }, U.coord), /474/);
  assert.throws(() => D.salvarConfig({ validadoJuridico: true }, U.rh), erroStatus(403));
  D.salvarConfig({ advertencia: { titulo: 'ADVERTÊNCIA DISCIPLINAR' } }, U.rh); assert.equal(D.config().validadoJuridico, false);
  D.salvarConfig({ validadoJuridico: true }, U.jur); assert.equal(D.config().validadoJuridico, true); assert.equal(D.config().validadoPor, 'jur');
  const d = D.detalhe(P1, U.ger4); assert.equal(d.historicoColaborador.administrativas.length, 4); assert.ok(d.historico.length >= 10);
  assert.equal(D.avisarPrazos(), 0);
});
