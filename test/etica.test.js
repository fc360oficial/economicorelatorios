// test/etica.test.js — Canal de Ética: cenários obrigatórios do prompt mestre (seção 12) e do doc. V1.0 (seção 15)
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.ETICA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'etica-teste-'));
process.env.ETICA_KEY = 'chave-de-teste';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/etica');

const U = {
  tri: { usuario: 'tri', nome: 'Triagem', perfil: 'gerente' }, rh: { usuario: 'rh1', nome: 'RH Sede', perfil: 'gerente' }, rh2: { usuario: 'rh2', nome: 'RH Loja', perfil: 'gerente' },
  jur: { usuario: 'jur', nome: 'Jurídico', perfil: 'gerente' }, coord: { usuario: 'coord', nome: 'Coordenação', perfil: 'gerente' }, rev: { usuario: 'rev', nome: 'Revisor', perfil: 'gerente' },
  ind: { usuario: 'ind', nome: 'Independente', perfil: 'gerente' }, gerente: { usuario: 'ger.e5', nome: 'Gerente E5', perfil: 'gerencial' }, admin: { usuario: 'tiago', nome: 'Admin', perfil: 'admin' },
};
E.salvarConfig({ designados: [
  { usuario: 'tri', nome: 'Triagem', papeis: ['triagem'] }, { usuario: 'rh1', nome: 'RH Sede', papeis: ['rh'] }, { usuario: 'rh2', nome: 'RH Loja', papeis: ['rh'] },
  { usuario: 'jur', nome: 'Jurídico', papeis: ['juridico'] }, { usuario: 'coord', nome: 'Coordenação', papeis: ['coordenacao'] }, { usuario: 'rev', nome: 'Revisor', papeis: ['revisor'] },
  { usuario: 'ind', nome: 'Independente', papeis: ['independente'] }, { usuario: 'ger.e5', nome: 'Gerente E5', papeis: ['rh'] },
], calendario: { diasUteis: [0, 1, 2, 3, 4, 5, 6], feriados: [], horaInicio: 8, horaFim: 18 } }, 'teste');

const relato = (extra = {}) => ({ unidade: 'E5', categoria: 'assedio_moral', quando: 'semana passada', local: 'depósito', descricao: 'Encarregado humilha a equipe na frente de clientes e ameaça cortar horas.', pessoas: 'encarregado', ...extra });
const depois = (iso, horas) => new Date(new Date(iso).getTime() + horas * 3600000);

test('1 · registro anônimo gera protocolo aleatório e credencial; identidade não é gravada', () => {
  const r = E.registrar(relato());
  assert.match(r.protocolo, /^ETC-\d{4}-[A-Z2-9]{5}$/);
  assert.match(r.credencial, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const c = E.obter(r.protocolo);
  assert.equal(c.anonimo, true); assert.equal(c.status, 'recebida'); assert.equal(c.prioridade, 'alta');
  assert.ok(!fs.existsSync(E.P.ident(r.protocolo)));
  assert.ok(c.credencial.hash && !JSON.stringify(c).includes(r.credencial.replace(/-/g, '')), 'credencial não fica em claro');
});

test('2 · registro identificado guarda a identidade separada e cifrada; só triagem/coordenação/responsável leem', () => {
  const r = E.registrar(relato({ identificar: true, nome: 'Maria', contato: '81 9...' }));
  const bruto = JSON.parse(fs.readFileSync(E.P.ident(r.protocolo), 'utf8'));
  assert.ok(bruto.dados && !bruto.claro, 'cifrado com ETICA_KEY');
  assert.deepEqual(E.detalhe(r.protocolo, U.tri).identificacao, { nome: 'Maria', contato: '81 9...' });
  assert.deepEqual(E.detalhe(r.protocolo, U.rev).identificacao, { restrito: true });
});

test('3/4 · consulta segura: credencial certa mostra só o autorizado; errada falha; 5 erros bloqueiam', () => {
  const r = E.registrar(relato());
  const v = E.consultar(r.protocolo.toLowerCase(), r.credencial);
  assert.equal(v.etapa, 'Recebida'); assert.equal(v.relato, undefined); assert.equal(v.responsavel, undefined);
  assert.ok(v.eventos.length === 1 && !JSON.stringify(v).includes('humilha'));
  assert.throws(() => E.consultar(r.protocolo, 'AAAA-BBBB-CCCC'), e => e.status === 401);
  for (let i = 0; i < 4; i++) assert.throws(() => E.consultar(r.protocolo, 'AAAA-BBBB-CCCC'));
  assert.throws(() => E.consultar(r.protocolo, r.credencial), e => e.status === 429, 'bloqueado mesmo com a credencial certa');
});

test('5/6/9 · triagem classifica, bloqueia pessoa envolvida e encaminha ao RH com prazos', () => {
  const r = E.registrar(relato());
  E.abrirTriagem(r.protocolo, U.tri);
  assert.throws(() => E.triar(r.protocolo, U.tri, { justificativa: 'curta' }), /Justificativa/);
  // gerente da E5 é citado como envolvido (tem conta no sistema) → não pode receber o caso
  assert.throws(() => E.triar(r.protocolo, U.tri, { justificativa: 'Relato com testemunhas. Gerente envolvido.', envolvidos: [{ nome: 'Gerente E5', usuario: 'ger.e5' }], instancia: 'rh', responsavel: { usuario: 'ger.e5', nome: 'Gerente E5' } }),
    e => e.status === 409 && e.bloqueio === 'impedido');
  assert.ok(E.eventos(r.protocolo).some(e => e.tipo === 'bloqueio'), 'tentativa bloqueada fica no histórico');
  const c = E.triar(r.protocolo, U.tri, { justificativa: 'Relato com testemunhas. Gerente envolvido.', prioridade: 'alta', envolvidos: [{ nome: 'Gerente E5', usuario: 'ger.e5' }], instancia: 'rh', responsavel: { usuario: 'rh1', nome: 'RH Sede' }, medidaProtetiva: 'separar escalas' });
  assert.equal(c.status, 'aguardando_aceite'); assert.equal(c.instancia, 'rh'); assert.equal(c.responsavel.usuario, 'rh1');
  assert.ok(c.prazos.triagem.cumpridoEm && c.prazos.aceite.venceEm && c.prazos.investigacao.venceEm);
  assert.equal(Math.round((new Date(c.prazos.aceite.venceEm) - new Date(c.responsavel.desde)) / 36e5), 8, 'Alta: aceite em 8 h corridas');
  assert.equal(E.podeVer(U.gerente, c), false, 'envolvido não vê o caso nem com papel de RH');
  assert.ok(E.notificacoes(U.rh).some(n => n.tipo === 'atribuida'), 'responsável é notificado');
});

test('12/14 · aceite, providência e permissões por caso', () => {
  const r = E.registrar(relato({ categoria: 'fraude', unidade: 'E4' }));
  E.triar(r.protocolo, U.tri, { justificativa: 'Desvio recorrente no depósito.', instancia: 'rh', responsavel: { usuario: 'rh1', nome: 'RH Sede' } });
  assert.throws(() => E.aceitar(r.protocolo, U.rh2), e => e.status === 403, 'outro RH não aceita o caso do colega');
  assert.throws(() => E.providencia(r.protocolo, U.rh, { descricao: 'antes do aceite' }), e => e.status === 409);
  E.aceitar(r.protocolo, U.rh);
  const c = E.providencia(r.protocolo, U.rh, { tipo: 'Coleta de documento', descricao: 'Pedido relatório de quebras e câmeras 4 e 7', visibilidade: 'etapa' });
  assert.ok(c.prazos.providencia.cumpridoEm);
  assert.equal(E.podeVer(U.jur, c), false, 'Jurídico não vê caso que está no RH');
  assert.throws(() => E.detalhe(r.protocolo, U.jur), e => e.status === 403);
  assert.ok(E.auditoria({ protocolo: r.protocolo }).some(a => a.acao === 'acesso_negado'));
  const v = E.consultar(r.protocolo, r.credencial);
  assert.ok(v.eventos.some(e => /providência/.test(e.texto)) && !JSON.stringify(v).includes('câmeras'), 'denunciante vê a etapa, não o conteúdo');
});

test('7/8/10/11/13 · vencimento automático escalona RH → Jurídico → Coordenação → Independente, sem voltar, e abre OM separada', () => {
  const r = E.registrar(relato({ categoria: 'fraude', unidade: 'E2' }));
  E.triar(r.protocolo, U.tri, { justificativa: 'Desvio recorrente no depósito da E2.', instancia: 'rh', responsavel: { usuario: 'rh1', nome: 'RH Sede' } });
  let c = E.obter(r.protocolo);
  // avisos antes do vencimento (50%, 80%) — o tick varre todos os casos do teste, então conta só os deste protocolo
  const avisosDeste = () => E.notificacoes(U.rh).filter(n => n.tipo === 'aviso_prazo' && n.protocolo === r.protocolo).length;
  E.tick(depois(c.responsavel.desde, 4.5)); assert.equal(avisosDeste(), 1);
  E.tick(depois(c.responsavel.desde, 6.6)); assert.equal(avisosDeste(), 2);
  E.tick(depois(c.responsavel.desde, 6.7)); assert.equal(avisosDeste(), 2, 'não repete o aviso do mesmo marco');
  // aceite vence em 8 h → Jurídico
  const t = E.tick(depois(c.responsavel.desde, 8.1)); assert.ok(t.vencidos >= 1);
  c = E.obter(r.protocolo);
  assert.equal(c.instancia, 'juridico'); assert.equal(c.responsavel.usuario, 'jur'); assert.equal(c.status, 'aguardando_aceite'); assert.equal(c.escalonamentos, 1);
  assert.equal(c.historicoResponsaveis[0].usuario, 'rh1', 'histórico do responsável anterior preservado');
  assert.ok(c.prazos.aceite.vencidoEm === null && c.prazos.aceite.venceEm > c.historicoResponsaveis[0].ate, 'novo prazo de aceite pro substituto');
  const oms = E.omissoes().filter(o => o.protocolo === r.protocolo);
  assert.equal(oms.length, 1); assert.equal(oms[0].responsavel.usuario, 'rh1'); assert.equal(oms[0].status, 'aguardando_manifestacao'); assert.match(oms[0].id, /^OM-\d{4}-\d{3}$/);
  assert.ok(E.notificacoes(U.jur).some(n => n.tipo === 'escalonado') && E.notificacoes(U.coord).some(n => n.tipo === 'escalonado'));
  // Jurídico também deixa vencer → Coordenação
  E.tick(depois(c.responsavel.desde, 8.1)); c = E.obter(r.protocolo);
  assert.equal(c.instancia, 'coordenacao'); assert.equal(c.responsavel.usuario, 'coord');
  // Coordenação deixa vencer → Autoridade independente
  E.tick(depois(c.responsavel.desde, 8.1)); c = E.obter(r.protocolo);
  assert.equal(c.instancia, 'independente'); assert.equal(c.responsavel.usuario, 'ind');
  // Independente deixa vencer → não circula de volta ao RH
  E.tick(depois(c.responsavel.desde, 8.1)); c = E.obter(r.protocolo);
  assert.equal(c.instancia, 'independente'); assert.equal(c.responsavel.usuario, 'ind');
  assert.ok(E.eventos(r.protocolo).some(e => e.tipo === 'escalonamento_esgotado'));
  assert.equal(E.omissoes().filter(o => o.protocolo === r.protocolo).length, 4, 'uma avaliação por vencimento');
  // manifestação e decisão da omissão: o avaliado não decide; a decisão não sanciona automaticamente
  const om = oms[0];
  assert.throws(() => E.manifestar(om.id, U.jur, 'não fui eu'), e => e.status === 403);
  E.manifestar(om.id, U.rh, 'Estava de férias sem substituto cadastrado.');
  assert.throws(() => E.decidirOmissao(om.id, U.rh, { desfecho: 'sem_falha', texto: 'me absolvo aqui mesmo' }), e => e.status === 403);
  const d = E.decidirOmissao(om.id, U.coord, { desfecho: 'melhoria', medida: 'cadastrar substituto de férias', texto: 'Justificativa acolhida; falha de processo.' });
  assert.equal(d.status, 'decidida'); assert.equal(d.decisao.desfecho, 'melhoria');
});

test('escalonamento não entrega o caso a quem está impedido na instância seguinte', () => {
  const r = E.registrar(relato({ categoria: 'conflito', unidade: 'ADM' }));
  E.triar(r.protocolo, U.tri, { justificativa: 'Envolve o jurídico da empresa.', prioridade: 'alta', envolvidos: [{ nome: 'Jurídico', usuario: 'jur' }], instancia: 'rh', responsavel: { usuario: 'rh1', nome: 'RH Sede' } });
  const c0 = E.obter(r.protocolo);
  E.tick(depois(c0.responsavel.desde, 8.1));
  const c = E.obter(r.protocolo);
  assert.equal(c.instancia, 'juridico'); assert.equal(c.responsavel, null, 'sem substituto sem conflito → fica pra designar');
  assert.equal(c.redistribuir.motivo, 'escalonamento_sem_substituto');
  assert.throws(() => E.redistribuir(r.protocolo, U.coord, { instancia: 'juridico', responsavel: { usuario: 'jur' }, motivo: 'tentando mesmo assim' }), e => e.status === 409);
  const c2 = E.redistribuir(r.protocolo, U.coord, { instancia: 'coordenacao', responsavel: { usuario: 'coord', nome: 'Coordenação' }, motivo: 'Jurídico impedido; coordenação assume' });
  assert.equal(c2.responsavel.usuario, 'coord');
});

test('impedimento declarado, redistribuição, prorrogação fundamentada e validação por revisor distinto', () => {
  const r = E.registrar(relato({ categoria: 'discriminacao', unidade: 'E1' }));
  E.triar(r.protocolo, U.tri, { justificativa: 'Relato consistente com testemunhas.', instancia: 'rh', responsavel: { usuario: 'rh1', nome: 'RH Sede' } });
  E.declararImpedimento(r.protocolo, U.rh, 'Sou parente da pessoa citada');
  let c = E.obter(r.protocolo); assert.equal(c.responsavel, null); assert.ok(c.impedidos.includes('rh1'));
  assert.throws(() => E.redistribuir(r.protocolo, U.tri, { instancia: 'rh', responsavel: { usuario: 'rh1' }, motivo: 'de volta pro mesmo' }), e => e.status === 409);
  c = E.redistribuir(r.protocolo, U.tri, { instancia: 'rh', responsavel: { usuario: 'rh2', nome: 'RH Loja' }, motivo: 'RH Sede impedido' });
  E.aceitar(r.protocolo, U.rh2);
  E.providencia(r.protocolo, U.rh2, { descricao: 'Entrevistas marcadas' });
  const ate = new Date(Date.now() + 10 * 86400000).toISOString();
  E.solicitarProrrogacao(r.protocolo, U.rh2, { etapa: 'investigacao', ate, motivo: 'Aguardando laudo externo solicitado' });
  assert.throws(() => E.decidirProrrogacao(r.protocolo, U.rh2, true, 'eu mesmo'), e => e.status === 403);
  c = E.decidirProrrogacao(r.protocolo, U.coord, true, 'Fundamento aceito');
  assert.equal(c.prazos.investigacao.venceEm, ate);
  assert.ok(E.consultar(r.protocolo, r.credencial).eventos.some(e => /prorrogado/.test(e.texto)));
  E.enviarValidacao(r.protocolo, U.rh2, { conclusao: 'Fatos confirmados por três testemunhas e registros de ponto.', resultado: 'procedente' });
  c = E.obter(r.protocolo); assert.equal(c.status, 'aguardando_validacao'); assert.ok(c.prazos.validacao.venceEm);
  assert.throws(() => E.validar(r.protocolo, U.coord, { aprovado: true, resultado: 'procedente', texto: 'coordenação não valida' }), e => e.status === 403);
  c = E.validar(r.protocolo, U.rev, { aprovado: false, texto: 'Falta ouvir a pessoa citada' });
  assert.equal(c.status, 'em_apuracao');
  E.enviarValidacao(r.protocolo, U.rh2, { conclusao: 'Pessoa citada ouvida; fatos mantidos.', resultado: 'procedente' });
  c = E.validar(r.protocolo, U.rev, { aprovado: true, resultado: 'procedente', texto: 'Conclusão fundamentada.', comunicado: 'Medidas administrativas foram adotadas.' });
  assert.equal(c.status, 'concluida');
  const v = E.consultar(r.protocolo, r.credencial);
  assert.equal(v.resultado.texto, 'Procedente'); assert.equal(v.etapa, 'Concluída'); assert.ok(!JSON.stringify(v).includes('testemunhas'));
  assert.throws(() => E.reabrir(r.protocolo, U.rh2, 'quero reabrir'), e => e.status === 403);
  assert.equal(E.reabrir(r.protocolo, U.coord, 'Fato novo apresentado pela Direção').status, 'em_apuracao');
});

test('15 · histórico append-only com cadeia de hash detecta adulteração', () => {
  const r = E.registrar(relato());
  E.abrirTriagem(r.protocolo, U.tri);
  assert.deepEqual(E.verificarCadeia(r.protocolo), { ok: true, total: 2 });
  const arq = E.P.eventos(r.protocolo);
  const linhas = fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  linhas[0].texto = 'texto trocado'; fs.writeFileSync(arq, linhas.map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(E.verificarCadeia(r.protocolo).ok, false);
});

test('16 · quem não é designado não passa; admin do sistema não entra sozinho (só bootstrap sem designados)', () => {
  assert.deepEqual(E.papeisDe(U.admin), []);
  assert.equal(E.bootstrapPermitido(U.admin), false, 'já há designados');
  const r = E.registrar(relato());
  assert.throws(() => E.detalhe(r.protocolo, U.admin), e => e.status === 403);
  assert.equal(E.fila(U.admin, 'ativos').length, 0);
});

test('painel mascara unidade com menos de 3 casos pra quem não é coordenação/revisor', () => {
  const p1 = E.painel({}, U.rh); const p2 = E.painel({}, U.coord);
  assert.ok(p1.porUnidade.some(u => u.recebidas === '<3'));
  assert.ok(p2.porUnidade.every(u => typeof u.recebidas === 'number'));
  assert.ok(p2.kpis.recebidas >= 7 && p2.kpis.escalonamentos >= 4);
});

test('prazos: dias úteis respeitam calendário (seg–sáb e feriados) e horas corridas não', () => {
  E.salvarConfig({ calendario: { diasUteis: [1, 2, 3, 4, 5, 6], feriados: ['2026-10-20'], horaInicio: 8, horaFim: 18 } }, 'teste');
  const sab = new Date('2026-10-17T10:00:00'); // sábado
  assert.equal(E.somarPrazo(sab, { du: 1 }).toISOString(), new Date('2026-10-19T10:00:00').toISOString(), 'pula o domingo');
  assert.equal(E.somarPrazo(sab, { du: 2 }).toISOString(), new Date('2026-10-21T10:00:00').toISOString(), 'pula domingo e feriado de 20/10');
  assert.equal(E.somarPrazo(sab, { h: 4 }).toISOString(), new Date('2026-10-17T14:00:00').toISOString());
  assert.equal(E.textoRegra({ du: 1 }), '1 dia útil'); assert.equal(E.textoRegra({ du: 20 }), '20 dias úteis'); assert.equal(E.textoRegra({ h: 4 }), '4 h corridas');
  assert.throws(() => E.salvarConfig({ cadeia: [{ id: 'rh' }, { id: 'juridico' }] }), /independente/);
  E.salvarConfig({ calendario: { diasUteis: [0, 1, 2, 3, 4, 5, 6], feriados: [], horaInicio: 8, horaFim: 18 } }, 'teste');
});
