'use strict';
// test/vagas.test.js — Controle de vagas em aberto e quadro de pessoal (lib/vagas.js) e o efeito na escala (lib/escalas.js).
// Pastas temporárias: nada aqui toca data/ nem o ponto. "Hoje" é sempre passado por parâmetro (12/11/2026, quinta-feira).
// Os dez cenários pedidos: 1 reposição necessária · 2 sem reposição · 3 aviso trabalhado · 4 aviso indenizado · 5 transferência
// entre lojas · 6 admissão de substituto · 7 virada do mês · 8 cobertura mínima · 9 cancelamento · 10 retificação de data.
const fs = require('fs'), os = require('os'), path = require('path');
for (const [k, p] of [['GP_DIR', 'gp-vg-'], ['ESCALAS_DIR', 'esc-vg-'], ['VAGAS_DIR', 'vg-']]) process.env[k] = fs.mkdtempSync(path.join(os.tmpdir(), p));
process.env.ESCALAS_5X2_RELATORIO = '0';
const test = require('node:test'); const assert = require('node:assert/strict');
const GP = require('../lib/gestao-pessoas'); const E = require('../lib/escalas'); const V = require('../lib/vagas'); const S5 = require('../lib/escalas-5x2');

const U = { ger: { usuario: 'ger', nome: 'Gerente Socorro' }, rh: { usuario: 'rh', nome: 'Maria RH' }, rh2: { usuario: 'rh2', nome: 'RH Muribeca' }, co: { usuario: 'co', nome: 'Coordenação' }, di: { usuario: 'di', nome: 'Diretoria' }, x: { usuario: 'x', nome: 'Sem papel' }, admin: { usuario: 'adm', nome: 'Admin', perfil: 'admin' } };
GP.salvarConfig({ designados: [{ usuario: 'ger', nome: 'Gerente Socorro', papeis: ['gerente'], lojas: [1] }, { usuario: 'rh', nome: 'Maria RH', papeis: ['rh_ponto', 'rh_doc', 'rh_adm'] }, { usuario: 'rh2', nome: 'RH Muribeca', papeis: ['rh_ponto'], lojas: [2] },
  { usuario: 'co', nome: 'Coordenação', papeis: ['coordenacao'] }, { usuario: 'di', nome: 'Diretoria', papeis: ['diretoria'] }] }, U.admin);
const HOJE = '2026-11-12'; const status = s => e => e.status === s;
// jornada contratual: segunda a sexta, 07:00–17:48 com 2 h de intervalo
const J = [{ entrada: '07:00', saida: '11:00' }, { entrada: '13:00', saida: '17:48' }];
const escalasPC = new Map([[10, { id: 10, nome: 'SEG-SEX 44H', dias: { 1: J, 2: J, 3: J, 4: J, 5: J } }]]);
const c = (id, nome, loja, setor, extra) => ({ id, nome, matricula: String(id), loja, setor, cargo: setor === 'CAIXA' ? 'Operador de caixa' : 'Repositor', turno: 'SEG-SEX 44H', turno_id: 10, ativo: true, clt: true, admissao: '2024-03-01', status_agora: 'Trabalhando', ...extra });
const COLABS = { ativos: [c(101, 'Ana Lima', 1, 'CAIXA'), c(102, 'Bruno Sá', 1, 'CAIXA'), c(103, 'Carla Reis', 1, 'CAIXA'), c(104, 'Davi Melo', 1, 'CAIXA'), c(105, 'Elisa Rocha', 1, 'CAIXA'), c(106, 'Fábio Luz', 1, 'CAIXA'), c(107, 'Gina Costa', 1, 'CAIXA'), c(108, 'Heitor Paz', 1, 'CAIXA'),
  c(109, 'Ivo Dias', 1, 'REPOSITOR'), c(110, 'Joana Neri', 1, 'REPOSITOR'), c(201, 'Karen Souza', 2, 'CAIXA'), c(202, 'Leo Prado', 2, 'CAIXA'), c(203, 'Mara Teles', 2, 'REPOSITOR')],
  desligados: [c(301, 'Zeca Antigo', 1, 'CAIXA', { ativo: false, desligamento: '2026-11-05', status_agora: 'Desligado' }), c(302, 'Velho Demais', 1, 'CAIXA', { ativo: false, desligamento: '2026-06-01', status_agora: 'Desligado' })] };
let AFAST = [];
const deps = { colaboradores: async () => COLABS, afastamentos: async () => AFAST };
const colab = id => COLABS.ativos.find(x => x.id === id);
// mínimos de cobertura: caixa 2, reposição 2 (com as duas pessoas do setor a reposição fica exatamente no mínimo)
E.salvarConfig({ lojas: { 1: { abre: '07:00', fecha: '19:00', setores: { 'FRENTE DE CAIXA': 2, REPOSICAO: 2 } }, 2: { abre: '07:00', fecha: '19:00', setores: { 'FRENTE DE CAIXA': 1, REPOSICAO: 1 } } } }, U.co);
for (const [l, m] of [[1, '2026-11'], [1, '2026-12'], [2, '2026-11']]) E.criarDoPontoCerto(l, m, COLABS, escalasPC, U.rh);
const dia = (loja, id, data) => { const e = E.ler(loja, data.slice(0, 7)); return E.diaDe(e, e.funcionarios.find(f => f.id === id), data, null).tipo; };
const linhas = () => fs.readFileSync(V.P.aud(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const ultima = acao => linhas().filter(r => r.acao === acao).pop();
const sai = (id, extra) => ({ funcId: id, movimento: 'desligamento', dataDesligamento: '2026-11-13', avisoPrevio: 'nao_se_aplica', motivo: 'pedido_demissao', reposicao: 'necessaria', justificativa: 'pedido de demissão entregue no RH', ...extra });
const tipos = r => r.avisos.map(a => a.tipo);
const notas = (u, re) => GP.notificacoes(u).filter(n => re.test(n.texto));

test('o que o ponto mostra fica "a confirmar": sem a confirmação do RH nada sai da escala e nenhuma vaga é aberta', async () => {
  assert.equal(E.setorOperacional('CAIXA'), 'FRENTE DE CAIXA'); assert.equal(E.setorOperacional('REPOSITOR'), 'REPOSICAO');
  const r = await V.verificar(deps, { hoje: HOJE }); assert.equal(r.primeira, true);
  // primeira leitura: UM resumo para o RH (não uma rajada), só com os desligamentos dos últimos 30 dias
  assert.equal(r.avisos.length, 1); assert.equal(r.avisos[0].acervo, true); assert.deepEqual(r.avisos[0].funcs, [301]); assert.equal(r.avisos[0].para.includes('co'), false, 'a confirmação é do RH');
  const p = await V.painel(U.rh, deps, HOJE); assert.deepEqual(p.aConfirmar.map(x => [x.funcId, x.desligamento, x.confirma]), [[301, '2026-11-05', true]]); assert.equal(p.vagas.length, 0);
  assert.equal(p.aConfirmar[0].acervo, true); assert.equal((await V.pendencias(U.rh, deps, HOJE)).n, 0, 'o que já estava no ponto quando o módulo entrou fica no painel, não no contador do menu'); assert.equal((await V.pendencias(U.x, deps, HOJE)).n, 0);
  // desligamento que aparece DEPOIS: aviso individual para o RH da unidade e entra no contador; o RH pode dispensar o que não vai tratar
  COLABS.desligados.push(c(303, 'Baixa de Cadastro', 1, 'CAIXA', { ativo: false, desligamento: '2026-11-11', status_agora: 'Desligado' }));
  const n2 = await V.verificar(deps, { hoje: HOJE }); assert.deepEqual(n2.avisos.map(a => a.tipo), ['desligamento_ponto']); assert.match(n2.avisos[0].texto, /O ponto registrou o desligamento de Baixa de Cadastro \(E1 · Socorro\) em 11\/11\/2026/); assert.equal(n2.avisos[0].para.includes('co'), false);
  assert.equal((await V.pendencias(U.rh, deps, HOJE)).n, 1);
  await assert.rejects(V.dispensarPonto(U.ger, { funcIds: [303], justificativa: 'cadastro duplicado' }, deps, HOJE), status(403)); await assert.rejects(V.dispensarPonto(U.rh, { funcIds: [303] }, deps, HOJE), /Justificativa obrigatória/);
  assert.deepEqual(await V.dispensarPonto(U.rh, { funcIds: [303], justificativa: 'cadastro duplicado no ponto: nunca trabalhou' }, deps, HOJE), { ok: true, dispensados: 1 }); assert.equal((await V.pendencias(U.rh, deps, HOJE)).n, 0);
  assert.deepEqual((await V.painel(U.rh, deps, HOJE)).aConfirmar.map(x => x.funcId), [301]); assert.deepEqual(ultima('ponto_dispensar').dispensados.map(x => x.funcId), [303]); assert.equal(V.listarVagas(U.rh, {}, HOJE).length, 0, 'dispensar não abre vaga nem tira ninguém da escala');
  assert.equal((await V.painel(U.ger, deps, HOJE)).aConfirmar[0].confirma, false, 'o gerente vê, não confirma');
  assert.deepEqual((await V.verificar(deps, { hoje: HOJE })).avisos, [], 'ler de novo não repete aviso');
  // o RH confirma com os dados que o ponto não tem; data diferente da do ponto é aceita (o lançamento do RH é a fonte) e sinalizada
  const z = await V.registrarDesligamento(U.rh, sai(301, { dataDesligamento: '2026-11-04', motivo: 'sem_justa_causa', avisoPrevio: 'indenizado', ultimoDiaTrabalhado: '2026-10-05', reposicao: 'posicao_extinta', justificativa: 'conferido com o TRCT' }), deps, HOJE);
  assert.equal(z.desligamento.origem, 'ponto'); assert.equal(z.vaga, null); assert.deepEqual(z.desligamento.ponto.divergencias.map(d => d.codigo), ['data_diferente']); assert.match(z.alertasPonto[0], /no ponto \(05\/11\/2026\) é diferente da registrada pelo RH \(04\/11\/2026\)/);
  assert.equal((await V.painel(U.rh, deps, HOJE)).aConfirmar.length, 0); assert.equal((await V.painel(U.rh, deps, HOJE)).divergencias.length, 1);
  const z2 = await V.alterarDesligamento(U.rh, z.desligamento.id, { acao: 'retificar', dataDesligamento: '2026-11-05', justificativa: 'data correta é a do TRCT: 05/11' }, deps, HOJE); assert.deepEqual(z2.desligamento.ponto.divergencias, []);
});

test('1 · desligamento com reposição necessária: abre a vaga, tira a pessoa da escala no dia seguinte ao último dia e avisa RH e Coordenação', async () => {
  // quem confirma é o RH da unidade, sempre com justificativa e com os dados que distinguem contrato × último dia trabalhado
  await assert.rejects(V.registrarDesligamento(U.ger, sai(101), deps, HOJE), status(403)); await assert.rejects(V.registrarDesligamento(U.rh2, sai(101), deps, HOJE), status(403)); await assert.rejects(V.registrarDesligamento(U.co, sai(101), deps, HOJE), status(403));
  await assert.rejects(V.registrarDesligamento(U.rh, sai(101, { justificativa: '' }), deps, HOJE), /Justificativa obrigatória/); await assert.rejects(V.registrarDesligamento(U.rh, sai(101, { avisoPrevio: '' }), deps, HOJE), /aviso prévio/);
  await assert.rejects(V.registrarDesligamento(U.rh, sai(101, { reposicao: '' }), deps, HOJE), /precisa de reposição ou foi extinta/); await assert.rejects(V.registrarDesligamento(U.rh, sai(999), deps, HOJE), status(404));
  assert.equal(E.cobertura(1, '2026-11-16', E.resolver(E.ler(1, '2026-11'))).setores.find(s => s.setor === 'FRENTE DE CAIXA').escalados, 8);
  const r = await V.registrarDesligamento(U.rh, sai(101), deps, HOJE); const d = r.desligamento, v = r.vaga;
  assert.match(d.id, /^DSL-2026-\d{4}$/); assert.deepEqual([d.loja, d.setor, d.setorEscala, d.cargo, d.dataDesligamento, d.ultimoDiaTrabalhado, d.indisponivelDesde, d.status, d.origem], [1, 'CAIXA', 'FRENTE DE CAIXA', 'Operador de caixa', '2026-11-13', '2026-11-13', '2026-11-14', 'confirmado', 'lancamento_rh']);
  assert.deepEqual(d.pontoNoRegistro, { situacao: 'ativo', desligamento: null, loja: 1 }, 'validação de status: o que o ponto dizia na hora');
  // sem quadro autorizado definido para o setor, a posição não está "autorizada": a vaga nasce aguardando a Coordenação
  assert.equal(v.id, 'VG-2026-0001'); assert.deepEqual([v.status, v.loja, v.setor, v.cargo, v.abertaEm, v.desde, v.origem, v.desligamentoId], ['aguardando_autorizacao', 1, 'CAIXA', 'Operador de caixa', HOJE, '2026-11-14', 'desligamento', d.id]);
  assert.deepEqual(v.ocupanteAnterior, { funcId: 101, nome: 'Ana Lima', matricula: '101' }); assert.deepEqual([v.turnoRef.texto, v.turnoRef.origem, v.turnoRef.classe], ['07:00–17:48', 'escala', 'abertura']); assert.equal(v.quadro.autorizado, null);
  assert.deepEqual(tipos(r), ['vaga_aberta']); assert.deepEqual(r.avisos[0].para.slice().sort(), ['co', 'rh']); assert.equal(notas(U.co, /VAGA EM ABERTO VG-2026-0001 · E1 · Socorro · Frente de caixa · Operador de caixa: saída de Ana Lima, posição vaga a partir de 14\/11\/2026/i).length, 1);
  // escala: trabalha até o último dia; depois não é presença, nem folga, nem ausência — e nada foi apagado do arquivo
  assert.equal(dia(1, 101, '2026-11-13'), 'trabalho'); assert.equal(dia(1, 101, '2026-11-14'), 'saiu'); assert.equal(dia(1, 101, '2026-11-16'), 'saiu'); assert.equal(E.ler(1, '2026-11').funcionarios.some(f => f.id === 101), true);
  const cob = E.cobertura(1, '2026-11-16', E.resolver(E.ler(1, '2026-11'))).setores.find(s => s.setor === 'FRENTE DE CAIXA'); assert.equal(cob.escalados, 7); assert.equal(cob.pessoas.some(p => p.id === 101), false);
  assert.throws(() => E.editarDia(1, '2026-11', U.rh, { funcId: 101, data: '2026-11-17', tipo: 'folga', justificativa: 'tentativa' }, null), e => e.status === 409 && /saiu da unidade: o último dia na escala é 13\/11\/2026/.test(e.message));
  // a vaga aparece na grade como linha própria (fora de `funcionarios`): não é pessoa, não tem jornada, não entra na cobertura
  const g = V.naEscala(U.ger, 1, '2026-11-01', '2026-11-30', HOJE); assert.deepEqual(g.map(x => [x.id, x.rotulo, x.setor, x.cargo, x.turno, x.desde, x.ate, x.statusTxt]), [['VG-2026-0001', 'VAGA EM ABERTO', 'FRENTE DE CAIXA', 'Operador de caixa', '07:00–17:48', '2026-11-14', null, 'Aguardando autorização']]);
  assert.equal(E.resolver(E.ler(1, '2026-11')).some(f => String(f.id).startsWith('VG')), false); assert.throws(() => V.naEscala(U.rh2, 1, '2026-11-01', '2026-11-30', HOJE), status(403));
  await assert.rejects(V.registrarDesligamento(U.rh, sai(101), deps, HOJE), e => e.status === 409 && e.duplicada === d.id);
  // andamento: recrutamento só depois da autorização; a Coordenação autoriza e acompanha, sem mexer no dado contratual
  await assert.rejects(V.atualizarVaga(U.rh, v.id, { acao: 'status', status: 'em_recrutamento' }, deps, HOJE), e => e.status === 409 && /ainda não foi autorizada/.test(e.message));
  await assert.rejects(V.atualizarVaga(U.rh, v.id, { acao: 'autorizar' }, deps, HOJE), e => e.status === 403 && /quadro autorizado deste setor não está definido/.test(e.message));
  await assert.rejects(V.atualizarVaga(U.rh, v.id, { acao: 'autorizar', protocolo: 'GP-2026-9999', justificativa: 'aprovada' }, deps, HOJE), status(404));
  await assert.rejects(V.atualizarVaga(U.ger, v.id, { acao: 'observacao', texto: 'preciso da reposição' }, deps, HOJE), status(403)); await assert.rejects(V.atualizarVaga(U.co, v.id, { acao: 'autorizar' }, deps, HOJE), /justificativa da autorização/);
  const a = await V.atualizarVaga(U.co, v.id, { acao: 'autorizar', justificativa: 'reposição aprovada na reunião de 12/11' }, deps, HOJE); assert.deepEqual([a.vaga.status, a.vaga.autorizacao.base, a.vaga.autorizacao.por.usuario], ['reposicao_autorizada', 'coordenacao', 'co']);
  await assert.rejects(V.atualizarVaga(U.co, v.id, { acao: 'status', status: 'em_recrutamento' }, deps, HOJE), status(403)); await assert.rejects(V.alterarDesligamento(U.co, d.id, { acao: 'retificar', dataDesligamento: '2026-11-20', justificativa: 'mudar a data' }, deps, HOJE), status(403));
  await assert.rejects(V.atualizarVaga(U.rh, v.id, { acao: 'status', status: 'preenchida' }, deps, HOJE), /só é preenchida pelo vínculo/);
  const s = await V.atualizarVaga(U.rh, v.id, { acao: 'status', status: 'em_recrutamento', observacao: 'anúncio publicado; 3 currículos' }, deps, HOJE); assert.equal(s.vaga.status, 'em_recrutamento'); assert.equal(s.vaga.observacoes[0].texto, 'anúncio publicado; 3 currículos');
  await V.atualizarVaga(U.co, v.id, { acao: 'observacao', texto: 'priorizar: fim de ano' }, deps, HOJE); assert.equal((await V.detalheVaga(U.co, v.id, deps, HOJE)).observacoes.length, 2);
  // LGPD: o gerente vê que a pessoa saiu e as datas; o motivo fica com RH, Coordenação, Diretoria e Jurídico
  const dg = await V.detalheDesligamento(U.ger, d.id, deps, HOJE); assert.deepEqual([dg.motivo, dg.motivoTxt, dg.dataDesligamento, dg.auditoria], [null, null, '2026-11-13', null]); assert.equal((await V.detalheDesligamento(U.co, d.id, deps, HOJE)).motivoTxt, 'Pedido de demissão');
  const au = ultima('desligamento_confirmar'); assert.deepEqual([au.usuario, au.funcionario, au.justificativa, au.depois.vaga, au.depois.ultimoDiaTrabalhado], ['rh', 'Ana Lima', 'pedido de demissão entregue no RH', 'VG-2026-0001', '2026-11-13']); assert.equal(ultima('vaga_abrir').desligamento, d.id);
});

test('2 · desligamento sem reposição: posição extinta não abre vaga; com o quadro autorizado definido, o sistema confere se a posição ainda cabe', async () => {
  const r = await V.registrarDesligamento(U.rh, sai(102, { reposicao: 'posicao_extinta', motivo: 'sem_justa_causa', avisoPrevio: 'indenizado', ultimoDiaTrabalhado: '2026-11-12', dataDesligamento: '2026-12-15' }), deps, HOJE);
  assert.equal(r.vaga, null); assert.equal(r.semVaga.motivo, 'posicao_extinta'); assert.deepEqual(r.avisos, []); assert.equal(dia(1, 102, '2026-11-13'), 'saiu'); assert.equal(V.listarVagas(U.rh, {}, HOJE).length, 1);
  // quadro autorizado do caixa = 6 (definido pela Coordenação na Gestão de Pessoas). Saem Ana e Bruno; com a saída da Carla ficam
  // 5 ativos + 1 vaga já aberta = 6: a posição dela não cabe mais no quadro → nenhuma vaga automática
  GP.salvarConfig({ quadro: { '1|CAIXA': 6 } }, U.co);
  const k = await V.registrarDesligamento(U.rh, sai(103), deps, HOJE); assert.equal(k.vaga, null); assert.deepEqual([k.semVaga.motivo, k.semVaga.autorizado, k.semVaga.efetivo, k.semVaga.vagasAbertas], ['quadro_completo', 6, 5, 1]); assert.match(k.semVaga.texto, /nenhuma vaga foi aberta automaticamente/);
  assert.deepEqual((await V.painel(U.rh, deps, HOJE)).semVaga.map(x => x.nome), ['Carla Reis']);
  // o RH pode abrir a vaga à mão: fica aguardando a Coordenação, que aqui decide extinguir a posição
  await assert.rejects(V.abrirVaga(U.ger, { desligamentoId: k.desligamento.id, justificativa: 'preciso repor' }, deps, HOJE), status(403));
  const m = await V.abrirVaga(U.rh, { desligamentoId: k.desligamento.id, justificativa: 'a loja pede a reposição para dezembro' }, deps, HOJE); assert.deepEqual([m.vaga.id, m.vaga.status, m.vaga.origem, m.vaga.ocupanteAnterior.nome], ['VG-2026-0002', 'aguardando_autorizacao', 'manual', 'Carla Reis']);
  await assert.rejects(V.abrirVaga(U.rh, { desligamentoId: k.desligamento.id, justificativa: 'de novo' }, deps, HOJE), e => e.status === 409 && e.duplicada === 'VG-2026-0002');
  await assert.rejects(V.atualizarVaga(U.co, m.vaga.id, { acao: 'cancelar', motivo: 'posicao_extinta' }, deps, HOJE), /Justificativa obrigatória/);
  const x = await V.atualizarVaga(U.co, m.vaga.id, { acao: 'cancelar', motivo: 'posicao_extinta', justificativa: 'caixa 8 será desativado em dezembro' }, deps, HOJE);
  assert.deepEqual([x.vaga.status, x.vaga.cancelamento.motivo, x.vaga.cancelamento.por.usuario, x.vaga.encerradaEm], ['cancelada', 'posicao_extinta', 'co', HOJE]); assert.deepEqual(tipos(x), ['vaga_cancelada']); assert.deepEqual(x.avisos[0].para.slice().sort(), ['co', 'rh']);
  assert.equal((await V.detalheDesligamento(U.rh, k.desligamento.id, deps, HOJE)).reposicao, 'posicao_extinta'); await assert.rejects(V.atualizarVaga(U.rh, m.vaga.id, { acao: 'status', status: 'aberta' }, deps, HOJE), status(409));
  assert.deepEqual(V.naEscala(U.rh, 1, '2026-11-01', '2026-11-30', HOJE).map(g => g.id), ['VG-2026-0001'], 'vaga cancelada não aparece na grade');
});

test('3 · aviso prévio trabalhado: a pessoa segue na escala até o fim do aviso; a vaga já existe, mas a posição só fica vaga depois', async () => {
  const r = await V.registrarDesligamento(U.rh, sai(104, { motivo: 'sem_justa_causa', avisoPrevio: 'trabalhado', dataDesligamento: '2026-12-10', justificativa: 'aviso prévio assinado em 10/11' }), deps, HOJE);
  assert.deepEqual([r.desligamento.avisoPrevio, r.desligamento.dataDesligamento, r.desligamento.ultimoDiaTrabalhado, r.desligamento.indisponivelDesde], ['trabalhado', '2026-12-10', '2026-12-10', '2026-12-11']);
  // 4 ativos + 1 vaga de 6 autorizados: a posição cabe no quadro → nasce "Aberta" e o próprio RH registra a autorização pelo quadro
  assert.deepEqual([r.vaga.id, r.vaga.status, r.vaga.desde, r.vaga.futura, r.vaga.diasAberta, r.vaga.quadro.dentro], ['VG-2026-0003', 'aberta', '2026-12-11', true, 0, true]);
  assert.equal(dia(1, 104, '2026-11-16'), 'trabalho'); assert.equal(dia(1, 104, '2026-12-10'), 'trabalho'); assert.equal(dia(1, 104, '2026-12-11'), 'saiu');
  assert.deepEqual(V.naEscala(U.rh, 1, '2026-11-01', '2026-11-30', HOJE).map(g => g.id), ['VG-2026-0001'], 'em novembro a posição ainda está ocupada'); assert.deepEqual(V.naEscala(U.rh, 1, '2026-12-01', '2026-12-31', HOJE).map(g => [g.id, g.desde]), [['VG-2026-0001', '2026-11-14'], ['VG-2026-0003', '2026-12-11']]);
  const a = await V.atualizarVaga(U.rh, r.vaga.id, { acao: 'autorizar' }, deps, HOJE); assert.deepEqual([a.vaga.status, a.vaga.autorizacao.base], ['reposicao_autorizada', 'quadro']);
  // quadro de pessoal: quem está cumprindo aviso ainda é ativo no ponto, mas já não conta no efetivo; férias não é déficit de quadro
  COLABS.ativos.find(x => x.id === 108).status_agora = 'Férias';
  const Q = await V.quadroPessoal(U.co, deps, HOJE); const cx = Q.linhas.find(l => l.loja === 1 && l.setor === 'CAIXA');
  assert.deepEqual([cx.autorizado, cx.ativos, cx.saidasConfirmadas, cx.efetivo, cx.deficitQuadro, cx.ausenciaTemporaria, cx.vagasAbertas, cx.emRecrutamento, cx.preenchidas, cx.canceladas], [6, 8, 4, 4, 2, 1, 1, 1, 0, 1]);
  assert.equal(Q.linhas.find(l => l.loja === 2 && l.setor === 'CAIXA').deficitQuadro, null, 'sem quadro autorizado definido não há déficit a afirmar'); assert.equal(Q.unidades.find(u => u.loja === 1).vagasAbertas, 1);
  COLABS.ativos.find(x => x.id === 108).status_agora = 'Trabalhando'; await assert.rejects(V.quadroPessoal(U.x, deps, HOJE), status(403));
});

test('4 · aviso prévio indenizado: sai da escala no dia seguinte ao último dia trabalhado, embora o contrato termine depois', async () => {
  await assert.rejects(V.registrarDesligamento(U.rh, sai(105, { avisoPrevio: 'indenizado', dataDesligamento: '2026-12-12' }), deps, HOJE), /Aviso prévio indenizado: informe o último dia efetivamente trabalhado/);
  await assert.rejects(V.registrarDesligamento(U.rh, sai(105, { avisoPrevio: 'indenizado', dataDesligamento: '2026-12-12', ultimoDiaTrabalhado: '2026-12-13' }), deps, HOJE), /não pode ser depois da data do desligamento contratual/);
  await assert.rejects(V.registrarDesligamento(U.rh, sai(105, { dataDesligamento: '2024-01-01' }), deps, HOJE), /anterior à admissão/);
  const r = await V.registrarDesligamento(U.rh, sai(105, { motivo: 'sem_justa_causa', avisoPrevio: 'indenizado', dataDesligamento: '2026-12-12', ultimoDiaTrabalhado: HOJE, justificativa: 'dispensa comunicada hoje, aviso indenizado' }), deps, HOJE);
  assert.deepEqual([r.desligamento.dataDesligamento, r.desligamento.ultimoDiaTrabalhado, r.desligamento.indisponivelDesde, r.vaga.id, r.vaga.desde, r.vaga.status], ['2026-12-12', HOJE, '2026-11-13', 'VG-2026-0004', '2026-11-13', 'aberta']);
  assert.equal(dia(1, 105, HOJE), 'trabalho'); assert.equal(dia(1, 105, '2026-11-13'), 'saiu'); assert.equal(dia(1, 105, '2026-12-01'), 'saiu');
  // validação de status com o ponto: enquanto o contrato não termina não há divergência; depois da data, o ponto ainda ativo é apontado
  assert.deepEqual((await V.detalheDesligamento(U.rh, r.desligamento.id, deps, HOJE)).ponto.divergencias, []); assert.deepEqual((await V.detalheDesligamento(U.rh, r.desligamento.id, deps, '2026-12-15')).ponto.divergencias.map(x => x.codigo), ['ativo_no_ponto']);
  // S-2299: só referência do processo, com registro manual do envio (não há acesso ao eSocial)
  const e0 = (await V.detalheDesligamento(U.rh, r.desligamento.id, deps, '2026-12-15')).esocial; assert.deepEqual([e0.evento, e0.registrado, e0.prazoReferencia, e0.atrasado], ['S-2299', false, '2026-12-22', false]); assert.match(e0.nota, /não acessa o eSocial/);
  assert.equal((await V.detalheDesligamento(U.rh, r.desligamento.id, deps, '2026-12-23')).esocial.atrasado, true); await assert.rejects(V.alterarDesligamento(U.co, r.desligamento.id, { acao: 'esocial', enviadoEm: '2026-12-14', justificativa: 'enviado' }, deps, HOJE), status(403));
  const e1 = await V.alterarDesligamento(U.rh, r.desligamento.id, { acao: 'esocial', enviadoEm: '2026-12-14', recibo: '1.2.0000000012345', justificativa: 'recibo informado pela contabilidade' }, deps, '2026-12-15'); assert.deepEqual([e1.desligamento.esocial.registrado, e1.desligamento.esocial.recibo, e1.desligamento.esocial.registradoPor.usuario], [true, '1.2.0000000012345', 'rh']);
});

test('5 · transferência entre lojas: sem perda de quadro não abre vaga; com perda na origem abre; o ponto só sinaliza a mudança de unidade', async () => {
  const tr = (id, extra) => ({ funcId: id, movimento: 'transferencia', lojaDestino: 1, dataTransferencia: '2026-11-16', justificativa: 'transferência aprovada pela Coordenação', ...extra });
  await assert.rejects(V.registrarDesligamento(U.ger, tr(202), deps, HOJE), status(403)); await assert.rejects(V.registrarDesligamento(U.rh2, tr(202, { lojaDestino: 2 }), deps, HOJE), /informe a unidade de ORIGEM|mesma unidade/); await assert.rejects(V.registrarDesligamento(U.rh2, tr(202, { dataTransferencia: '' }), deps, HOJE), /data da transferência/);
  const r = await V.registrarDesligamento(U.rh2, tr(202), deps, HOJE);   // RH que atende a unidade de ORIGEM
  assert.deepEqual([r.desligamento.movimento, r.desligamento.loja, r.desligamento.lojaDestino, r.desligamento.ultimoDiaTrabalhado, r.desligamento.dataDesligamento, r.desligamento.reposicao, r.desligamento.esocial], ['transferencia', 2, 1, '2026-11-15', null, 'sem_perda', null]);
  assert.equal(r.vaga, null); assert.equal(r.semVaga.motivo, 'sem_perda'); assert.deepEqual(r.avisos, []); assert.equal(dia(2, 202, '2026-11-13'), 'trabalho'); assert.equal(dia(2, 202, '2026-11-16'), 'saiu');
  await assert.rejects(V.alterarDesligamento(U.rh2, r.desligamento.id, { acao: 'esocial', enviadoEm: '2026-11-16', justificativa: 'enviado' }, deps, HOJE), /não se aplica a transferência/);
  // transferência COM perda de quadro na origem (decisão explícita do RH): abre a vaga na unidade de origem
  const m = await V.registrarDesligamento(U.rh, tr(203, { reposicao: 'necessaria' }), deps, HOJE); assert.deepEqual([m.vaga.id, m.vaga.loja, m.vaga.setor, m.vaga.origem, m.vaga.status, m.vaga.desde], ['VG-2026-0005', 2, 'REPOSITOR', 'transferencia', 'aguardando_autorizacao', '2026-11-16']);
  // o ponto passa a mostrar Leo e Karen na loja 1: a rotina detecta a mudança de unidade e pede a confirmação do RH (Karen ainda não tem registro)
  colab(202).loja = 1; colab(201).loja = 1; const v = await V.verificar(deps, { hoje: '2026-11-16' }); const tp = v.avisos.filter(a => a.tipo === 'transferencia_ponto');
  assert.equal(tp.length, 1); assert.match(tp[0].texto, /Karen Souza em E1 · Socorro \(antes: E2 · Muribeca\)/); assert.equal(tp[0].para.includes('co'), false);
  const L = await V.listarDesligamentos(U.rh, deps, {}, '2026-11-16'); assert.deepEqual(L.transferencias.map(t => [t.funcId, t.de, t.para]), [[201, 2, 1]]); assert.deepEqual((await V.detalheDesligamento(U.rh, r.desligamento.id, deps, '2026-11-16')).ponto.divergencias, []);
  await assert.rejects(V.registrarDesligamento(U.rh, tr(201), deps, '2026-11-16'), /informe a unidade de ORIGEM/);
  const kk = await V.registrarDesligamento(U.rh, tr(201, { lojaOrigem: 2 }), deps, '2026-11-16'); assert.deepEqual([kk.desligamento.loja, kk.desligamento.lojaDestino, kk.vaga], [2, 1, null]);
  assert.deepEqual((await V.listarDesligamentos(U.rh, deps, {}, '2026-11-16')).transferencias, []);
  // enquanto o ponto não é atualizado, a divergência fica apontada (Mara segue na loja 2 no ponto depois da data)
  assert.deepEqual((await V.detalheDesligamento(U.rh, m.desligamento.id, deps, '2026-11-17')).ponto.divergencias.map(x => x.codigo), ['ponto_nao_atualizado']);
});

test('6 · admissão de substituto: o sistema sugere, o RH vincula e a vaga só encerra com a confirmação do RH; o histórico de quem saiu fica', async () => {
  const H6 = '2026-11-16'; COLABS.ativos.push(c(111, 'Nilo Novo', 1, 'CAIXA', { admissao: '2026-11-16' }));
  const cand = (await V.detalheVaga(U.rh, 'VG-2026-0001', deps, H6)).candidatos; assert.deepEqual(cand.map(x => [x.funcId, x.origem, x.pontos]), [[201, 'transferencia', 3], [202, 'transferencia', 3], [111, 'admissao', 3]]);
  assert.deepEqual(cand[2].compat, { unidade: true, setor: true, cargo: true }); assert.equal(cand[2].inicioSugerido, '2026-11-16');
  const ver = await V.verificar(deps, { hoje: H6 }); const cs = ver.avisos.filter(a => a.tipo === 'candidato' && a.vaga === 'VG-2026-0001'); assert.deepEqual(cs.map(a => a.funcId).sort(), [111, 201, 202]); assert.equal(cs[0].para.includes('co'), false); assert.match(cs.find(a => a.funcId === 111).texto, /Nilo Novo \(admitido em 16\/11\/2026, Operador de caixa\) é compatível com a vaga VG-2026-0001/);
  assert.equal((await V.verificar(deps, { hoje: H6 })).avisos.filter(a => a.tipo === 'candidato').length, 0, 'a sugestão não se repete');
  await assert.rejects(V.atualizarVaga(U.ger, 'VG-2026-0001', { acao: 'vincular', funcId: 111 }, deps, H6), status(403)); await assert.rejects(V.atualizarVaga(U.rh, 'VG-2026-0001', { acao: 'vincular', funcId: 101 }, deps, H6), /é quem ocupava a posição/);
  // compatibilidade: outro setor e outro cargo só entram com a ciência declarada do RH
  await assert.rejects(V.atualizarVaga(U.rh, 'VG-2026-0001', { acao: 'vincular', funcId: 110, inicio: H6 }, deps, H6), e => e.status === 409 && e.exigeCiencia === true && e.ressalvas.length === 2);
  await assert.rejects(V.atualizarVaga(U.rh, 'VG-2026-0004', { acao: 'vincular', funcId: 111 }, deps, H6), e => e.status === 409 && /ainda não foi autorizada/.test(e.message));
  const vi = await V.atualizarVaga(U.rh, 'VG-2026-0001', { acao: 'vincular', funcId: 111 }, deps, H6); assert.deepEqual([vi.vaga.status, vi.vaga.substituto.nome, vi.vaga.substituto.inicio, vi.vaga.substituto.origem, vi.vaga.encerradaEm], ['contratacao_em_andamento', 'Nilo Novo', '2026-11-16', 'admissao', null]);
  assert.deepEqual(vi.avisos, []); assert.equal(V.naEscala(U.rh, 1, '2026-11-01', '2026-11-30', H6).find(g => g.id === 'VG-2026-0001').ate, null, 'vinculado não é preenchido: a vaga continua aberta na grade');
  assert.equal((await V.pendencias(U.rh, deps, H6)).n >= 1, true);
  // a Coordenação autoriza a outra vaga; o mesmo admitido não ocupa duas
  await V.atualizarVaga(U.co, 'VG-2026-0004', { acao: 'autorizar', justificativa: 'reposição da Elisa aprovada' }, deps, H6);
  await assert.rejects(V.atualizarVaga(U.rh, 'VG-2026-0004', { acao: 'vincular', funcId: 111 }, deps, H6), e => e.status === 409 && e.duplicada === 'VG-2026-0001');
  await assert.rejects(V.atualizarVaga(U.co, 'VG-2026-0001', { acao: 'preencher' }, deps, H6), status(403));
  const pr = await V.atualizarVaga(U.rh, 'VG-2026-0001', { acao: 'preencher', justificativa: 'contrato assinado e exame admissional ok' }, deps, H6);
  assert.deepEqual([pr.vaga.status, pr.vaga.encerradaEm, pr.vaga.substituto.confirmadoPor.usuario, pr.vaga.diasAberta], ['preenchida', H6, 'rh', 2]); assert.deepEqual(tipos(pr), ['vaga_preenchida']); assert.deepEqual(pr.avisos[0].para.slice().sort(), ['co', 'rh']); assert.match(pr.avisos[0].texto, /Nilo Novo assume a posição em 16\/11\/2026 \(era de Ana Lima\)/);
  assert.deepEqual(pr.escala, [{ mes: '2026-11', existe: true, naEscala: false }]); assert.match(pr.orientacao, /Inclua Nilo Novo no quadro da escala/);
  // a linha da vaga termina na véspera do início; ao entrar no quadro da escala, o substituto só conta a partir do início
  assert.deepEqual(V.naEscala(U.rh, 1, '2026-11-01', '2026-11-30', H6).filter(g => g.id === 'VG-2026-0001').map(g => [g.desde, g.ate, g.statusTxt, g.substituto.nome]), [['2026-11-14', '2026-11-15', 'Preenchida', 'Nilo Novo']]);
  assert.deepEqual(V.naEscala(U.rh, 1, '2026-12-01', '2026-12-31', H6).map(g => g.id), ['VG-2026-0004', 'VG-2026-0003'], 'a vaga preenchida em novembro não aparece em dezembro');
  const e = E.obter(1, '2026-11'); e.funcionarios.push(E.funcsDoPontoCerto(1, COLABS, escalasPC).find(f => f.id === 111)); E.salvar(e);
  assert.equal(dia(1, 111, '2026-11-13'), 'saiu'); assert.equal(dia(1, 111, '2026-11-16'), 'trabalho');
  // movimentação interna (a Joana já era da unidade, na reposição): entra com ciência e não é tratada como admissão; com substituto vinculado o andamento só segue por confirmar ou desfazer
  const vj = await V.atualizarVaga(U.rh, 'VG-2026-0004', { acao: 'vincular', funcId: 110, inicio: '2026-11-17', ciente: true }, deps, H6); assert.deepEqual([vj.vaga.substituto.origem, vj.vaga.substituto.setorAnterior, vj.vaga.substituto.ressalvas.length], ['interno', 'REPOSITOR', 2]); assert.deepEqual(vj.vaga.pode.status, []);
  await assert.rejects(V.atualizarVaga(U.rh, 'VG-2026-0004', { acao: 'status', status: 'em_recrutamento' }, deps, H6), e => e.status === 409 && /desfaça o vínculo/.test(e.message)); await V.atualizarVaga(U.rh, 'VG-2026-0004', { acao: 'desvincular', justificativa: 'a Joana fica na reposição' }, deps, H6);
  // transferido preenche a vaga da Elisa (o ponto já o mostra na loja 1)
  const vt = await V.atualizarVaga(U.rh, 'VG-2026-0004', { acao: 'vincular', funcId: 202, inicio: '2026-11-16' }, deps, H6); assert.equal(vt.vaga.substituto.origem, 'transferencia');
  const d1 = await V.atualizarVaga(U.rh, 'VG-2026-0004', { acao: 'desvincular', justificativa: 'conferindo a data de início' }, deps, H6); assert.deepEqual([d1.vaga.status, d1.vaga.substituto], ['em_recrutamento', null]);
  await V.atualizarVaga(U.rh, 'VG-2026-0004', { acao: 'vincular', funcId: 202, inicio: '2026-11-16' }, deps, H6); assert.equal((await V.atualizarVaga(U.rh, 'VG-2026-0004', { acao: 'preencher' }, deps, H6)).vaga.status, 'preenchida');
  // nada de quem saiu foi apagado: registro, histórico, escala gravada e a ligação da vaga com o ocupante anterior
  const ana = (await V.listarDesligamentos(U.rh, deps, {}, H6)).registros.find(x => x.funcId === 101); assert.deepEqual([ana.status, ana.vaga.status, ana.historico.length >= 1], ['confirmado', 'preenchida', true]);
  const v1 = await V.detalheVaga(U.rh, 'VG-2026-0001', deps, H6); assert.equal(v1.ocupanteAnterior.nome, 'Ana Lima'); assert.deepEqual(v1.historico.map(x => x.acao), ['aberta', 'autorizada', 'status', 'observacao', 'vinculado', 'preenchida']); assert.equal(E.ler(1, '2026-11').funcionarios.some(f => f.id === 101), true);
  await assert.rejects(V.atualizarVaga(U.rh, 'VG-2026-0001', { acao: 'cancelar', motivo: 'outro', justificativa: 'engano' }, deps, H6), status(409));
});

test('7 · vaga aberta na virada do mês: a pessoa fecha novembro, a vaga começa em 1º de dezembro e a semana que cruza o mês é uma só', async () => {
  GP.salvarConfig({ quadro: { '1|CAIXA': 8 } }, U.co);
  const r = await V.registrarDesligamento(U.rh, sai(106, { dataDesligamento: '2026-11-30' }), deps, HOJE);
  assert.deepEqual([r.vaga.id, r.vaga.status, r.vaga.desde, r.vaga.futura], ['VG-2026-0006', 'aberta', '2026-12-01', true]);
  assert.equal(dia(1, 106, '2026-11-30'), 'trabalho'); assert.equal(dia(1, 106, '2026-12-01'), 'saiu');
  assert.equal(V.naEscala(U.rh, 1, '2026-11-01', '2026-11-30', HOJE).some(g => g.id === 'VG-2026-0006'), false); assert.deepEqual(V.naEscala(U.rh, 1, '2026-12-01', '2026-12-31', HOJE).filter(g => g.id === 'VG-2026-0006').map(g => [g.desde, g.ate, g.dias]), [['2026-12-01', null, 0]]);
  // dezembro inteiro fora: a linha da pessoa é marcada para a grade não desenhar; o arquivo da escala continua com ela
  const dez = E.resolver(E.ler(1, '2026-12')); assert.equal(dez.find(f => f.id === 106).fora_do_mes, true); assert.equal(dez.find(f => f.id === 106).minutos_mes, 0); assert.equal(dez.find(f => f.id === 104).fora_do_mes, undefined);
  assert.equal(E.limitesNaEscala(E.ler(1, '2026-12'), E.ler(1, '2026-12').funcionarios.find(f => f.id === 106)).fim, '2026-11-30');
  // o Gerador 5×2 recebe a mesma data: na semana de 30/11 a 06/12 a pessoa trabalha a segunda e depois está fora (não é folga)
  const s = S5.simular(U.rh, 1, '2026-12', { colabs: COLABS, escalasPC, afast: new Map(), afastAnt: new Map(), hoje: HOJE }); const p = s.resultado.proposta.find(x => x.id === 106);
  assert.equal(Object.values(p.dias).some(d => d.tipo === 'trabalho' || d.tipo === 'folga'), false, 'nenhum dia de dezembro é gerado para quem saiu em 30/11');
  // dias de vaga contam a partir do dia em que a posição fica vaga, também na virada do ano
  assert.equal(V.listarVagas(U.rh, {}, '2027-01-02').find(v => v.id === 'VG-2026-0006').diasAberta, 32);
});

test('8 · vaga que compromete a cobertura mínima: avisa na hora e separa o que falta por vaga do que falta por ausência temporária', async () => {
  const r = await V.registrarDesligamento(U.rh, sai(109), deps, HOJE);   // reposição: mínimo 2, ficam Joana e a vaga
  assert.deepEqual(tipos(r), ['vaga_aberta', 'vaga_cobertura']); assert.match(r.avisos[1].texto, /VG-2026-0007 · E1 · Socorro · Reposição · Repositor COMPROMETE a cobertura mínima: 180 faixa\(s\) de 15 min abaixo do mínimo em 5 dia\(s\) de 14\/11\/2026 a 20\/11\/2026/); assert.deepEqual(r.avisos[1].para.slice().sort(), ['co', 'rh']);
  const dv = await V.detalheVaga(U.rh, r.vaga.id, deps, HOJE); assert.deepEqual([dv.cobertura.compromete, dv.cobertura.blocos, dv.cobertura.dias.length, dv.cobertura.diasAvaliados], [true, 180, 5, 7]); assert.deepEqual(dv.cobertura.porTurno, { abertura: 20, intermediario: 160, fechamento: 0 });
  // a vaga não é presença: o setor passa a ter 1 escalado, e a linha da vaga não existe em `funcionarios`
  const rp = E.cobertura(1, '2026-11-16', E.resolver(E.ler(1, '2026-11'))).setores.find(s => s.setor === 'REPOSICAO'); assert.deepEqual([rp.escalados, rp.pessoas.length, rp.blocos[0].disponiveis, rp.blocos[0].status], [1, 1, 1, 'baixa']);
  assert.equal(E.resumoLoja(1, '2026-11-16', E.resolver(E.ler(1, '2026-11')), 600, 0).total, 6, 'quem saiu não entra no total da unidade no dia (11 na grade − 5 fora)');
  // vaga do caixa (mínimo 2 com 5 pessoas) não compromete: sem aviso de cobertura
  assert.equal((await V.detalheVaga(U.rh, 'VG-2026-0003', deps, HOJE)).cobertura.compromete, false);
  // indicador por turno: Joana de férias em 16 e 17/11 — a mesma faixa aparece por vaga E por ausência, contadas em separado
  AFAST = [{ nome: 'JOANA NERI', inicio: '2026-11-16', fim: '2026-11-17', ferias: true, tipo: 'Férias' }];
  const Q = await V.quadroPessoal(U.rh, deps, HOJE); const lin = Q.linhas.find(l => l.loja === 1 && l.setor === 'REPOSITOR'); assert.deepEqual(Q.cobertura, { de: HOJE, ate: '2026-11-18' });
  assert.deepEqual(lin.cobertura.porVaga, { abertura: 12, intermediario: 96, fechamento: 0 }); assert.deepEqual(lin.cobertura.porAusencia, { abertura: 8, intermediario: 64, fechamento: 0 }); assert.equal(lin.cobertura.abaixo.abertura >= 12, true);
  assert.deepEqual([lin.vagasAbertas, lin.efetivo, lin.autorizado, lin.deficitQuadro], [1, 1, null, null]); AFAST = [];
  // sem mínimo cadastrado para o setor não há o que afirmar: a vaga fica "não avaliável", nunca "sem impacto"
  E.salvarConfig({ lojas: { 2: { setores: { 'FRENTE DE CAIXA': 1, REPOSICAO: 0 } } } }, U.co); const c5 = (await V.detalheVaga(U.rh, 'VG-2026-0005', deps, HOJE)).cobertura; assert.deepEqual([c5.avaliavel, c5.semMinimo, c5.compromete], [false, true, false]);
  assert.deepEqual((await V.verificar(deps, { hoje: HOJE })).avisos.filter(a => a.tipo === 'vaga_cobertura'), [], 'o aviso de cobertura não se repete');
});

test('9 · cancelamento de desligamento: a pessoa volta para a escala, a vaga é cancelada com aviso e o registro fica guardado', async () => {
  const r = await V.registrarDesligamento(U.rh, sai(107, { dataDesligamento: '2026-11-18' }), deps, HOJE); assert.equal(r.vaga.id, 'VG-2026-0008'); assert.equal(dia(1, 107, '2026-11-19'), 'saiu');
  await assert.rejects(V.alterarDesligamento(U.co, r.desligamento.id, { acao: 'cancelar', justificativa: 'desistiu' }, deps, HOJE), status(403)); await assert.rejects(V.alterarDesligamento(U.rh, r.desligamento.id, { acao: 'cancelar' }, deps, HOJE), /Justificativa obrigatória/);
  const x = await V.alterarDesligamento(U.rh, r.desligamento.id, { acao: 'cancelar', justificativa: 'funcionária reconsiderou o pedido de demissão' }, deps, HOJE);
  assert.deepEqual([x.desligamento.status, x.desligamento.statusTxt, x.vaga.status, x.vaga.cancelamento.motivo, x.vaga.encerradaEm], ['cancelado', 'Cancelado', 'cancelada', 'desligamento_cancelado', HOJE]); assert.deepEqual(tipos(x), ['vaga_cancelada']); assert.match(x.avisos[0].texto, /Vaga CANCELADA VG-2026-0008.*o desligamento de Gina Costa foi cancelado pelo RH/);
  assert.equal(dia(1, 107, '2026-11-19'), 'trabalho', 'voltou a contar na escala'); assert.equal(V.naEscala(U.rh, 1, '2026-11-01', '2026-11-30', HOJE).some(g => g.id === 'VG-2026-0008'), false);
  // nada é apagado: o registro continua na lista, com a trilha; e não aceita mais alteração
  const reg = (await V.listarDesligamentos(U.rh, deps, {}, HOJE)).registros.find(d => d.id === r.desligamento.id); assert.deepEqual(reg.historico.map(hh => hh.acao), ['confirmado', 'cancelado']); assert.equal(reg.canceladoPor.usuario, 'rh');
  await assert.rejects(V.alterarDesligamento(U.rh, r.desligamento.id, { acao: 'retificar', dataDesligamento: '2026-11-20', justificativa: 'mudar' }, deps, HOJE), status(409));
  assert.equal((await V.buscarFuncionarios(U.rh, deps, { q: 'gina' }, HOJE))[0].registro, null, 'sem saída ativa: um novo desligamento pode ser registrado depois');
  const au = ultima('desligamento_cancelar'); assert.deepEqual([au.antes.status, au.depois.status, au.vaga.status, au.justificativa], ['confirmado', 'cancelado', 'cancelada', 'funcionária reconsiderou o pedido de demissão']);
  // cancelamento depois de a vaga ter sido preenchida: a vaga NÃO é desfeita sozinha — fica marcada para o RH revisar o quadro
  const ana = (await V.listarDesligamentos(U.rh, deps, {}, HOJE)).registros.find(d => d.funcId === 101); const y = await V.alterarDesligamento(U.rh, ana.id, { acao: 'cancelar', justificativa: 'reintegração determinada' }, deps, '2026-11-17');
  assert.deepEqual([y.vaga.status, !!y.vaga.revisar], ['preenchida', true]); assert.deepEqual(tipos(y), ['vaga_revisar']); assert.equal(dia(1, 101, '2026-11-16'), 'trabalho'); assert.deepEqual((await V.painel(U.rh, deps, '2026-11-17')).revisar.map(v => v.id), ['VG-2026-0001']);
});

test('10 · retificação da data de desligamento: escala e vaga acompanham, os avisos de prazo são rearmados e fica o antes e o depois', async () => {
  const r = await V.registrarDesligamento(U.rh, sai(108, { dataDesligamento: '2026-11-20' }), deps, HOJE); assert.deepEqual([r.vaga.id, r.vaga.desde], ['VG-2026-0009', '2026-11-21']); assert.equal(dia(1, 108, '2026-11-23'), 'saiu');
  const a1 = (await V.verificar(deps, { hoje: '2026-11-28' })).avisos.filter(a => a.tipo === 'dias' && a.vaga === 'VG-2026-0009'); assert.deepEqual(a1.map(a => [a.marco, a.dias]), [[7, 7]]); assert.deepEqual(a1[0].para.slice().sort(), ['co', 'rh']); assert.match(a1[0].texto, /há 7 dia\(s\) SEM REPOSIÇÃO \(marco de 7 dias\) · Aberta — ainda sem autorização/);
  await assert.rejects(V.alterarDesligamento(U.co, r.desligamento.id, { acao: 'retificar', dataDesligamento: '2026-11-25', justificativa: 'data errada' }, deps, '2026-11-28'), status(403));
  await assert.rejects(V.alterarDesligamento(U.rh, r.desligamento.id, { acao: 'retificar', dataDesligamento: '2026-11-25', ultimoDiaTrabalhado: '2026-11-26', justificativa: 'data errada' }, deps, '2026-11-28'), /não pode ser depois/);
  await assert.rejects(V.alterarDesligamento(U.rh, r.desligamento.id, { acao: 'retificar', justificativa: 'sem mudança' }, deps, '2026-11-28'), /Nada foi alterado/);
  const t = await V.alterarDesligamento(U.rh, r.desligamento.id, { acao: 'retificar', dataDesligamento: '2026-11-25', ultimoDiaTrabalhado: '2026-11-25', justificativa: 'TRCT assinado com data de 25/11' }, deps, '2026-11-28');
  assert.deepEqual([t.desligamento.dataDesligamento, t.desligamento.ultimoDiaTrabalhado, t.desligamento.indisponivelDesde, t.vaga.desde, t.vaga.diasAberta], ['2026-11-25', '2026-11-25', '2026-11-26', '2026-11-26', 2]);
  assert.equal(dia(1, 108, '2026-11-23'), 'trabalho'); assert.equal(dia(1, 108, '2026-11-25'), 'trabalho'); assert.equal(dia(1, 108, '2026-11-26'), 'saiu');
  const au = ultima('desligamento_retificar'); assert.deepEqual([au.usuario, au.antes.dataDesligamento, au.depois.dataDesligamento, au.antes.ultimoDiaTrabalhado, au.depois.ultimoDiaTrabalhado, au.vaga, au.justificativa], ['rh', '2026-11-20', '2026-11-25', '2026-11-20', '2026-11-25', 'VG-2026-0009', 'TRCT assinado com data de 25/11']);
  assert.deepEqual(t.desligamento.historico.map(hh => hh.acao), ['confirmado', 'retificado']); assert.equal(t.vaga.historico.slice(-1)[0].acao, 'data_retificada');
  // o marco de 7 dias já tinha saído pela data errada: com a retificação ele volta a valer na data certa (03/12)
  assert.equal((await V.verificar(deps, { hoje: '2026-11-28' })).avisos.some(a => a.tipo === 'dias' && a.vaga === 'VG-2026-0009'), false);
  assert.deepEqual((await V.verificar(deps, { hoje: '2026-12-03' })).avisos.filter(a => a.tipo === 'dias' && a.vaga === 'VG-2026-0009').map(a => a.marco), [7]);
  // só o aviso prévio também se retifica (indenizado: o último dia trabalhado vem antes da data contratual)
  const t2 = await V.alterarDesligamento(U.rh, r.desligamento.id, { acao: 'retificar', avisoPrevio: 'indenizado', ultimoDiaTrabalhado: '2026-11-24', justificativa: 'aviso foi indenizado; último dia 24/11' }, deps, '2026-12-03'); assert.deepEqual([t2.desligamento.avisoPrevio, t2.vaga.desde], ['indenizado', '2026-11-25']);
});

test('avisos de prazo (7, 15 e 30 dias sem reposição), contador, permissões e auditoria que só acrescenta', async () => {
  // vaga da reposição (posição vaga desde 14/11): 7 dias saiu em 28/11 e 15 dias em 03/12 nas rotinas acima; em 14/12, o de 30 — uma vez só
  const al = JSON.parse(fs.readFileSync(V.P.alertas(), 'utf8')); assert.equal(!!al['VG-2026-0007|dias|15'], true); assert.equal(!!al['VG-2026-0007|dias|30'], false);
  const v30 = (await V.verificar(deps, { hoje: '2026-12-14' })).avisos.filter(a => a.tipo === 'dias' && a.vaga === 'VG-2026-0007'); assert.deepEqual(v30.map(a => [a.marco, a.dias]), [[30, 30]]);
  assert.equal((await V.verificar(deps, { hoje: '2026-12-14' })).avisos.filter(a => a.tipo === 'dias').length, 0);
  // vaga do aviso trabalhado (vaga desde 11/12): rotina parada por um mês manda só o marco mais alto, não três avisos
  const pulo = (await V.verificar(deps, { hoje: '2027-01-12' })).avisos.filter(a => a.tipo === 'dias' && a.vaga === 'VG-2026-0003'); assert.deepEqual(pulo.map(a => [a.marco, a.dias]), [[30, 32]]);
  const al2 = JSON.parse(fs.readFileSync(V.P.alertas(), 'utf8')); assert.equal(al2['VG-2026-0003|dias|7'].absorvido, 30); assert.equal(al2['VG-2026-0003|dias|15'].absorvido, 30);
  // vaga encerrada não gera aviso de prazo
  assert.equal(Object.keys(al2).some(k => k.startsWith('VG-2026-0002|dias') || k.startsWith('VG-2026-0008|dias')), false);
  // painel e contador
  const p = await V.painel(U.co, deps, '2026-12-14'); assert.deepEqual(p.vagas.map(v => v.id).sort(), ['VG-2026-0003', 'VG-2026-0005', 'VG-2026-0006', 'VG-2026-0007', 'VG-2026-0009']);
  assert.deepEqual([p.kpis.preenchidas90, p.kpis.canceladas90, p.kpis.maisDe30, p.kpis.comprometemCobertura >= 1], [2, 2, 1, true]); assert.equal((await V.pendencias(U.co, deps, '2026-12-14')).n, p.kpis.aguardandoAutorizacao);
  assert.equal((await V.painel(U.ger, deps, '2026-12-14')).vagas.every(v => v.loja === 1), true, 'gerente só vê a própria unidade'); await assert.rejects(V.painel(U.x, deps, HOJE), status(403));
  assert.deepEqual(V.listarVagas(U.rh2, {}, HOJE).map(v => v.id), ['VG-2026-0005']);
  // auditoria: cadeia íntegra, cada evento com responsável, data/hora e justificativa; ninguém foi apagado
  assert.deepEqual(V.verificarCadeia().ok, true); const L = linhas(); assert.equal(L.every(r => r.usuario && r.em && r.acao && r.hash), true);
  assert.equal(L.filter(r => /^desligamento_|^vaga_cancelar|^vaga_preencher|^vaga_autorizar/.test(r.acao)).every(r => (r.justificativa || '').length >= 5 || (r.acao === 'vaga_autorizar' && r.depois.autorizacao === 'quadro') || r.acao === 'vaga_preencher'), true);
  assert.throws(() => V.trilha(U.ger), status(403)); const T = V.trilha(U.co, { ref: 'VG-2026-0001' }); assert.equal(T.cadeia.ok, true); assert.deepEqual(T.registros.map(r => r.acao).reverse(), ['vaga_abrir', 'vaga_autorizar', 'vaga_status', 'vaga_observacao', 'vaga_vincular', 'vaga_preencher']);
  // preenchimento por movimentação interna: quem já era da unidade NÃO perde os dias anteriores na escala, e a posição antiga não vira vaga sozinha
  await V.atualizarVaga(U.co, 'VG-2026-0009', { acao: 'autorizar', justificativa: 'reposição do Heitor aprovada' }, deps, '2026-12-14'); await V.atualizarVaga(U.rh, 'VG-2026-0009', { acao: 'vincular', funcId: 110, inicio: '2026-12-15', ciente: true }, deps, '2026-12-14');
  const pj = await V.atualizarVaga(U.rh, 'VG-2026-0009', { acao: 'preencher' }, deps, '2026-12-14'); assert.equal(pj.vaga.substituto.origem, 'interno'); assert.match(pj.orientacao, /já era da unidade \(movimentação interna\).*\(REPOSITOR\) não vira vaga automaticamente/);
  assert.equal(dia(1, 110, '2026-11-13'), 'trabalho'); assert.equal(dia(1, 110, '2026-12-01'), 'trabalho'); assert.equal(E.limitesNaEscala(E.ler(1, '2026-12'), E.ler(1, '2026-12').funcionarios.find(f => f.id === 110)), null); assert.equal(E.limitesNaEscala(E.ler(1, '2026-11'), E.ler(1, '2026-11').funcionarios.find(f => f.id === 111)).inicio, '2026-11-16', 'o admitido, sim, só conta a partir do início');
  fs.appendFileSync(V.P.aud(), JSON.stringify({ seq: 999, acao: 'forjado', ant: 'x', hash: 'y' }) + '\n'); assert.equal(V.verificarCadeia().ok, false, 'linha adulterada quebra a cadeia');
  assert.equal((await V.listarDesligamentos(U.rh, deps, {}, HOJE)).registros.length, 13, 'os 13 movimentos lançados continuam todos lá, inclusive o cancelado'); assert.equal(E.ler(1, '2026-11').funcionarios.length, 11);
});
