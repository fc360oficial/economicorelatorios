'use strict';
// test/escalas-5x2.test.js — serviço do Gerador 5×2 (lib/escalas-5x2.js): simular, aplicar como rascunho, travas de
// publicação, nova versão em escala aprovada, desfazer, analisar, regras, autonomia do RH, auditoria e avisos.
// Pastas temporárias: nada aqui toca data/ nem o PontoCerto.
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-5x2-'));
process.env.ESCALAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'escalas-5x2-'));
const test = require('node:test'); const assert = require('node:assert/strict');
const GP = require('../lib/gestao-pessoas'); const E = require('../lib/escalas'); const S = require('../lib/escalas-5x2');
const U = { ger: { usuario: 'g1', nome: 'Gerente Socorro' }, rh: { usuario: 'rh', nome: 'RH Ponto' }, rh2: { usuario: 'rh2', nome: 'RH Muribeca' }, co: { usuario: 'co', nome: 'Coordenação' }, co2: { usuario: 'co2', nome: 'Coordenação 2' }, di: { usuario: 'di', nome: 'Diretoria' } };
GP.salvarConfig({ designados: [{ usuario: 'g1', nome: 'G1', papeis: ['gerente'], lojas: [1] }, { usuario: 'rh', nome: 'RH', papeis: ['rh_ponto'] }, { usuario: 'rh2', nome: 'RH2', papeis: ['rh_ponto'], lojas: [2] }, { usuario: 'co', nome: 'Co', papeis: ['coordenacao'] }, { usuario: 'co2', nome: 'Co2', papeis: ['coordenacao'] }, { usuario: 'di', nome: 'Di', papeis: ['diretoria'] }] }, { usuario: 'adm', perfil: 'admin' });
const HOJE = '2026-11-11', MES = '2026-12', MESN = '2026-11'; const status = s => e => e.status === s;
// quadro "do ponto": 8 pessoas na loja 1, contrato de 44 h (seg–sex 07:00–17:48 com 2 h de intervalo)
const J = [{ entrada: '07:00', saida: '11:00' }, { entrada: '13:00', saida: '17:48' }];
const escalasPC = new Map([[10, { id: 10, nome: 'SEG-SEX 44H', dias: { 1: J, 2: J, 3: J, 4: J, 5: J } }]]);
const nomes = ['Ana Lima', 'Bruno Sá', 'Carla Reis', 'Davi Melo', 'Eva Rocha', 'Fábio Luz', 'Gil Costa', 'Hugo Paz'];
const colabs = { ativos: nomes.map((n, i) => ({ id: 101 + i, nome: n, loja: 1, setor: i < 5 ? 'CAIXA' : 'REPOSITOR', cargo: i < 5 ? 'Operador de caixa' : 'Repositor', matricula: String(i + 1), turno: 'SEG-SEX 44H', turno_id: 10 })), desligados: [] };
const afast = () => new Map([['ANA LIMA', [{ nome: 'ANA LIMA', inicio: '2026-12-07', fim: '2026-12-16', ferias: true }]]]);
const ctx = extra => ({ colabs, escalasPC, afast: afast(), afastAnt: new Map(), hoje: HOJE, ...extra });
const regraBody = { nome: 'CCT Comerciários (teste)', estabelecimento: 1, vigencia: { de: '2026-01-01', ate: '2027-12-31' }, baseLegal: 'CCT 2026/2027 — cláusula de jornada', params: { metaSemanalMin: 2520, intervaloMin: 120, domingo: { folgaACadaSemanas: 3, tratamento: 'folga compensatória + adicional da CCT' } }, justificativa: 'cadastro inicial da convenção' };

test('simular não grava nada, monta o quadro do ponto e bloqueia a aplicação sem regra validada', () => {
  const s = S.simular(U.rh, 1, MES, ctx());
  assert.equal(s.existe, false); assert.equal(s.de, '2026-12-01'); assert.equal(s.ate, '2026-12-31'); assert.equal(s.resultado.proposta.length, 8);
  assert.equal(E.ler(1, MES), null, 'simular não cria a escala'); assert.deepEqual(fs.readdirSync(process.env.ESCALAS_DIR), [], 'nenhum arquivo gravado');
  assert.equal(s.aplicacao.permitida, false); assert.deepEqual(s.aplicacao.pendencias.map(p => p.codigo), ['regra_nao_validada']);
  assert.equal(s.aplicacao.exigeCiencia, 8, 'todos com 44 h no contrato × 42 h planejadas');
  const ana = s.resultado.proposta.find(p => p.nome === 'Ana Lima'); for (let d = 7; d <= 16; d++) assert.equal(ana.dias['2026-12-' + String(d).padStart(2, '0')].tipo, 'ferias');
  assert.throws(() => S.aplicar(U.rh, 1, MES, ctx(), { justificativa: 'gerar dezembro em 5x2', cienteDivergencias: true }), status(409));
  assert.throws(() => S.simular(U.rh2, 1, MES, ctx()), status(403), 'RH de outra unidade não vê a loja 1');
});

test('mês corrente: só dias futuros (a partir de amanhã); mês encerrado é recusado', () => {
  const s = S.simular(U.rh, 1, MESN, ctx()); assert.equal(s.de, '2026-11-12');
  assert.ok(!s.resultado.proposta.some(p => Object.keys(p.dias).some(d => d <= HOJE)), 'nenhum dia de hoje ou passado na proposta');
  assert.throws(() => S.simular(U.rh, 1, MESN, ctx(), { aPartirDe: '2026-11-05' }), /não pode ser hoje nem dia já passado/);
  assert.throws(() => S.simular(U.rh, 1, '2026-10', ctx()), /Mês já encerrado/);
});

test('regras: RH/Coordenação cadastram, só o RH valida, alterar tira a validação, nada é excluído', () => {
  assert.throws(() => S.salvarRegra(U.ger, regraBody), status(403));
  assert.throws(() => S.salvarRegra(U.co, { ...regraBody, params: { metaSemanalMin: 3000 } }), /fora da faixa/);
  const r = S.salvarRegra(U.co, regraBody); assert.equal(r.validada, false); assert.equal(r.params.metaSemanalMin, 2520); assert.equal(r.params.domingo.tratamento, 'folga compensatória + adicional da CCT');
  assert.throws(() => S.validarRegra(U.co, r.id, 'conferi a cláusula 12 da CCT'), status(403), 'Coordenação não valida');
  assert.throws(() => S.validarRegra(U.rh, r.id, 'ok'), /parecer/);
  const v = S.validarRegra(U.rh, r.id, 'Conferida a cláusula 12 da CCT 2026/2027'); assert.equal(v.validada, true); assert.equal(v.validadaPor, 'rh');
  const alt = S.salvarRegra(U.rh, { ...regraBody, id: r.id, params: { ...regraBody.params, intervaloMin: 90 }, justificativa: 'teste de alteração' }); assert.equal(alt.validada, false, 'alterada volta a depender do RH'); assert.equal(alt.versao, 2);
  S.salvarRegra(U.rh, { ...regraBody, id: r.id, justificativa: 'volta ao texto da CCT' }); S.validarRegra(U.rh, r.id, 'Conferida a cláusula 12 da CCT 2026/2027');
  assert.equal(S.listarRegras().length, 1); assert.equal(typeof S.excluirRegra, 'undefined');
});

let G1;
test('aplicar: exige RH da unidade, justificativa e ciência das divergências; grava como RASCUNHO com antes/depois', () => {
  const s = S.simular(U.rh, 1, MES, ctx()); assert.equal(s.aplicacao.permitida, true, JSON.stringify(s.aplicacao.pendencias));
  assert.equal(S.simular(U.ger, 1, MES, ctx()).aplicacao.pendencias[0].codigo, 'sem_permissao', 'gerente simula mas não aplica');
  assert.throws(() => S.aplicar(U.ger, 1, MES, ctx(), { justificativa: 'gerar dezembro em 5x2', cienteDivergencias: true }), status(403));
  assert.throws(() => S.aplicar(U.rh, 1, MES, ctx(), { justificativa: 'curta', cienteDivergencias: true }), /Justifique/);
  assert.throws(() => S.aplicar(U.rh, 1, MES, ctx(), { justificativa: 'gerar dezembro em 5x2' }), /divergências/);
  assert.throws(() => S.aplicar(U.rh, 1, MES, ctx(), { justificativa: 'gerar dezembro em 5x2', cienteDivergencias: true, assinatura: 'outra' }), /simule de novo/);
  assert.equal(E.ler(1, MES), null, 'tentativas recusadas não criam a escala');
  const r = S.aplicar(U.rh, 1, MES, ctx(), { justificativa: 'gerar dezembro em 5x2', cienteDivergencias: true, assinatura: s.assinatura }); G1 = r.geracao.id;
  const e = E.obter(1, MES); assert.equal(e.status, 'rascunho', 'nunca publica'); assert.equal(r.geracao.novaVersao, false);
  const ger = Object.entries(e.dias).filter(([, v]) => v.origem === 'gerador'); assert.equal(ger.length, r.geracao.dias); assert.ok(ger.every(([, v]) => v.geracao === G1));
  assert.ok(!Object.keys(e.dias).some(k => k.startsWith('101|2026-12-10')), 'férias não viram dia gravado');
  const R = E.resolver(e, afast()); const ana = R.find(f => f.nome === 'Ana Lima'); assert.equal(ana.dias['2026-12-10'].tipo, 'ferias'); assert.equal(ana.dias['2026-12-21'].origem, 'gerador');
  const g = S.geracao(U.rh, G1); assert.equal(g.usuario, 'rh'); assert.equal(g.justificativa, 'gerar dezembro em 5x2'); assert.equal(Object.keys(g.depois).length, r.geracao.dias); assert.ok(Object.values(g.antes).every(v => v === null), 'antes = contratual (sem alteração)');
  assert.equal(g.divergenciasContratuais.length, 8); assert.equal(g.cienteDivergencias, true);
  assert.deepEqual(e.funcionarios.find(f => f.nome === 'Ana Lima').folga_fixa, [6], 'folga fixa usada passa a valer na grade'); assert.deepEqual(e.funcionarios.find(f => f.nome === 'Ana Lima').folga_fixa_contrato, [0, 6]);
  assert.match(e.fluxo.at(-1).texto, /Gerador 5×2/);
});

test('férias lançadas depois no ponto vencem o dia gerado (a grade nunca esconde a ausência)', () => {
  const novo = new Map([['BRUNO SA', [{ nome: 'BRUNO SA', inicio: '2026-12-21', fim: '2026-12-24', ferias: true }]]]);
  const b = E.resolver(E.obter(1, MES), novo).find(f => f.nome === 'Bruno Sá'); assert.equal(b.dias['2026-12-22'].tipo, 'ferias');
});

test('reprocessar: dia ajustado à mão (gerente ou RH) nunca é sobrescrito; os gerados são trocados', () => {
  assert.throws(() => E.editarDia(1, MES, U.rh, { funcId: 102, data: '2026-12-15', tipo: 'trabalho', entrada: '09:00', saida: '19:24', almoco_ini: '13:00', almoco_fim: '15:00' }), /RH exige justificativa/);
  E.editarDia(1, MES, U.rh, { funcId: 102, data: '2026-12-15', tipo: 'trabalho', entrada: '09:00', saida: '19:24', almoco_ini: '13:00', almoco_fim: '15:00', justificativa: 'cobrir o fechamento do caixa' });
  const h = E.obter(1, MES).historico.at(-1); assert.equal(h.peloRH, true); assert.equal(h.usuario, 'rh'); assert.equal(h.depois.entrada, '09:00'); assert.ok(h.antes.entrada);
  const s = S.simular(U.rh, 1, MES, ctx()); assert.equal(s.travados, 1); assert.ok(s.geradosAtuais > 100);
  const r = S.aplicar(U.rh, 1, MES, ctx(), { justificativa: 'reprocessar com o ajuste do dia 15', cienteDivergencias: true });
  const e = E.obter(1, MES); assert.equal(e.dias['102|2026-12-15'].entrada, '09:00'); assert.equal(e.dias['102|2026-12-15'].origem, undefined, 'continua manual');
  assert.ok(Object.values(e.dias).filter(v => v.origem === 'gerador').every(v => v.geracao === r.geracao.id), 'geração anterior foi trocada por inteiro');
  assert.equal(S.listarGeracoes(1, MES).length, 2);
});

test('escala em aprovação não aceita geração; escala APROVADA vira nova versão (a publicada fica guardada)', () => {
  E.mover(1, MES, U.ger, 'enviar');
  assert.equal(S.simular(U.rh, 1, MES, ctx()).aplicacao.pendencias[0].codigo, 'em_aprovacao');
  assert.throws(() => S.aplicar(U.rh, 1, MES, ctx(), { justificativa: 'tentar durante a aprovação', cienteDivergencias: true }), status(409));
  E.mover(1, MES, U.rh, 'validar', 'ok'); E.mover(1, MES, U.co, 'aprovar', 'aprovada');
  const publicada = JSON.stringify(E.obter(1, MES).dias);
  const s = S.simular(U.rh, 1, MES, ctx()); assert.equal(s.aplicacao.novaVersao, true);
  const r = S.aplicar(U.rh, 1, MES, ctx(), { justificativa: 'corrigir escala publicada (nova versão)', cienteDivergencias: true });
  const e = E.obter(1, MES); assert.equal(r.geracao.novaVersao, true); assert.equal(e.status, 'rascunho'); assert.equal(e.versao, 2); assert.equal(e.versoes.length, 1);
  assert.equal(JSON.stringify(e.versoes[0].dias), publicada, 'a versão aprovada fica intacta em versoes[]');
});

test('desfazer: devolve os dias da geração ao que eram; o que foi editado depois fica', () => {
  const ult = S.resumoGeracao(S.listarGeracoes(1, MES)[0]); const antes = S.geracao(U.rh, ult.id).antes;
  E.editarDia(1, MES, U.ger, { funcId: 103, data: '2026-12-18', tipo: 'folga', justificativa: 'troca combinada' });
  assert.throws(() => S.desfazer(U.ger, 1, MES, ult.id, 'desfazer a geração'), status(403));
  const r = S.desfazer(U.rh, 1, MES, ult.id, 'desfazer a geração de teste'); assert.equal(r.mantidos, 1); assert.equal(r.restaurados, ult.dias - 1);
  const e = E.obter(1, MES); assert.equal(e.dias['103|2026-12-18'].tipo, 'folga');
  for (const [k, v] of Object.entries(antes)) if (k !== '103|2026-12-18') assert.deepEqual(e.dias[k], v || undefined, k);
  assert.throws(() => S.desfazer(U.rh, 1, MES, ult.id, 'desfazer a geração de teste'), /já foi desfeita/);
});

test('analisar a grade atual: semanas, folgas e cobertura do que está gravado (sem alterar nada)', () => {
  const antes = fs.readFileSync(path.join(process.env.ESCALAS_DIR, '1-' + MES + '.json'), 'utf8');
  const a = S.analisar(U.ger, 1, MES, ctx()); assert.equal(a.pessoas.length, 8); assert.ok(a.indicadores.semanas_completas > 0); assert.equal(a.cobertura.dias.length, 31);
  assert.ok(Array.isArray(a.conflitos.trabalhistas) && Array.isArray(a.conflitos.operacionais)); assert.ok(!a.conflitos.operacionais.some(c => c.codigo === 'sem_folga_fixa'));
  assert.equal(fs.readFileSync(path.join(process.env.ESCALAS_DIR, '1-' + MES + '.json'), 'utf8'), antes);
  // escala contratual pura (seg–sex, 44 h): a análise aponta a carga acima do limite? não — 44 h é o limite; mas nenhuma semana é "42 h"
  E.criarDoPontoCerto(2, MES, { ativos: colabs.ativos.map(c => ({ ...c, id: c.id + 100, loja: 2 })), desligados: [] }, escalasPC, U.rh2);
  const b = S.analisar(U.rh2, 2, MES, ctx()); assert.equal(b.indicadores.media_semanal_min, 44 * 60); assert.equal(b.indicadores.domingos_trabalhados, 0); assert.ok(b.conflitos.operacionais.some(c => c.codigo === 'meta_semanal'));
  assert.throws(() => S.analisar(U.rh, 3, MES, ctx()), e => e.status === 404 && e.semEscala);
});

test('cadastro do RH: folga fixa, restrição e setor entram na geração seguinte; cobertura com entradas e pico', () => {
  const e = E.obter(1, MES);
  assert.throws(() => S.salvarCadastro(U.ger, 1, e.funcionarios, [{ id: 104, folga_fixa: 3 }], 'definir folga'), status(403));
  assert.throws(() => S.salvarCadastro(U.rh, 1, e.funcionarios, [{ id: 999, folga_fixa: 3 }], 'definir folga'), /não está no quadro/);
  const r = S.salvarCadastro(U.rh, 1, e.funcionarios, [{ id: 104, folga_fixa: 3, naoTrabalha: [0], categoria: 'caixa' }, { id: 105, folga_fixa: 2 }], 'folgas fixas definidas pelo RH'); assert.equal(r.alterados, 2);
  assert.equal(S.salvarCadastro(U.rh, 1, e.funcionarios, [{ id: 105, folga_fixa: 2 }], 'repetido').alterados, 0);
  const c = S.cadastroLoja(1, e.funcionarios).find(x => x.id === 104); assert.equal(c.folga_fixa, 3); assert.equal(c.folgaOrigem, 'rh'); assert.equal(c.categoria, 'CAIXA');
  assert.equal(S.cadastroLoja(1, e.funcionarios).find(x => x.id === 106).folgaOrigem, 'contrato');
  const cob = S.salvarCobertura(U.co, 1, { entradas: ['08:36', '07:00'], picos: [{ setor: 'Frente de Caixa', dias: [6], ini: '10:00', fim: '13:00', min: 4 }] }, 'pico de sábado no caixa');
  assert.deepEqual(cob.entradas, ['07:00', '08:36']); assert.equal(cob.setores['FRENTE DE CAIXA'].faixas[0].min, 4);
  assert.throws(() => S.salvarCobertura(U.rh, 1, { entradas: ['25:00'] }, 'x inválido'), /inválidos/);
  const s = S.simular(U.rh, 1, MES, ctx()); const davi = s.resultado.proposta.find(p => p.id === 104);
  for (const [d, x] of Object.entries(davi.dias)) { const w = new Date(d + 'T12:00:00').getDay(); if ((w === 3 || w === 0) && !x.travado) assert.equal(x.tipo, 'folga', d); }
});

test('ajustar o quadro pelo ponto: admitido entra, quem saiu fica marcado (nunca apagado) e não recebe jornada nova', () => {
  const novo = { ativos: [...colabs.ativos.filter(c => c.id !== 108), { id: 109, nome: 'Iara Nova', loja: 1, setor: 'CAIXA', cargo: 'Operador de caixa', matricula: '9', turno: 'SEG-SEX 44H', turno_id: 10 }], desligados: [{ id: 108, nome: 'Hugo Paz', desligamento: '2026-12-10' }] };
  assert.throws(() => S.sincronizarQuadro(U.ger, 1, MES, ctx({ colabs: novo }), 'atualizar quadro'), status(403));
  const r = S.sincronizarQuadro(U.rh, 1, MES, ctx({ colabs: novo }), 'admissão e desligamento de dezembro'); assert.deepEqual(r.adicionados, ['Iara Nova']); assert.deepEqual(r.sairam, ['Hugo Paz']);
  const e = E.obter(1, MES); assert.equal(e.funcionarios.length, 9); assert.equal(e.funcionarios.find(f => f.id === 108).desligamento, '2026-12-10');
  const hugo = S.simular(U.rh, 1, MES, ctx({ colabs: novo })).resultado.proposta.find(p => p.id === 108); assert.ok(hugo.dias['2026-12-09']); assert.equal(hugo.dias['2026-12-11'], undefined);
});

test('auditoria: cadeia de hash íntegra, antes/depois com responsável; adulterar uma linha é detectado', () => {
  const t = S.trilha(U.co, { loja: 1, mes: MES }); assert.equal(t.cadeia.ok, true); assert.ok(t.cadeia.registros >= 8);
  const ap = t.registros.find(r => r.acao === 'gerar_aplicar'); assert.equal(ap.usuario, 'rh'); assert.ok(ap.justificativa); assert.match(ap.detalhe, /dia\(s\) de/);
  const dia = t.registros.find(r => r.origem === 'grade' && /RH/.test(r.acaoTxt)); assert.ok(dia.antes && dia.depois && dia.justificativa);
  assert.ok(t.registros.some(r => r.origem === 'fluxo')); assert.ok(S.trilha(U.co, {}).registros.some(r => r.acao === 'regra_validar'));
  assert.throws(() => S.trilha(U.rh2, { loja: 1 }), status(403));
  assert.deepEqual(Object.keys(S).filter(k => /exclu|apag|remov|limpar/i.test(k)), [], 'o serviço não tem função de exclusão');
  const arq = S.P.aud(); const orig = fs.readFileSync(arq, 'utf8'); fs.writeFileSync(arq, orig.replace('gerar dezembro em 5x2', 'texto adulterado'));
  const q = S.verificarCadeia(); assert.equal(q.ok, false); assert.ok(q.quebradaEm >= 1); fs.writeFileSync(arq, orig); assert.equal(S.verificarCadeia().ok, true);
});

test('avisos à Coordenação: imediato para o que é crítico/relevante, relatório diário do resto, com envio, entrega e visualização', () => {
  const a0 = S.avisos(U.di); const nova = a0.avisos.find(a => /ESCALA APROVADA reaberta/.test(a.texto)); assert.ok(nova, 'geração em escala aprovada avisa na hora'); assert.equal(nova.nivel, 'critico'); assert.equal(nova.tipo, 'imediato');
  assert.deepEqual(nova.destinatarios.map(d => d.usuario).sort(), ['co', 'co2']); assert.ok(nova.destinatarios.every(d => d.enviado && !d.entregue && !d.visto), 'Diretoria consultando não conta como entrega');
  assert.ok(a0.avisos.some(a => a.nivel === 'relevante' && /Gerador 5×2/.test(a.texto)), 'geração em rascunho = relevante'); assert.ok(a0.avisos.some(a => /Regra trabalhista/.test(a.texto)));
  assert.ok(GP.notificacoes(U.co).some(n => /Escalas 5×2/.test(n.texto)), 'também cai no sino da central de pessoas');
  const a1 = S.avisos(U.co, { entregar: true }); assert.ok(a1.nao_vistos > 0); const n1 = a1.avisos.find(a => a.id === nova.id); assert.ok(n1.destinatarios.find(d => d.usuario === 'co').entregue); assert.equal(n1.destinatarios.find(d => d.usuario === 'co2').entregue, null);
  assert.equal(S.marcarVistos(U.co, [nova.id]).marcados, 1); assert.equal(S.marcarVistos(U.co, [nova.id]).marcados, 0); assert.equal(S.marcarVistos(U.rh, [nova.id]).marcados, 0, 'só o destinatário registra visualização');
  const n2 = S.avisos(U.co).avisos.find(a => a.id === nova.id).destinatarios; assert.ok(n2.find(d => d.usuario === 'co').visto); assert.equal(n2.find(d => d.usuario === 'co2').visto, null);
  // edição comum do gerente = rotina → só no relatório diário
  assert.throws(() => E.editarDia(1, MES, U.ger, { funcId: 105, data: '2026-12-29', tipo: 'trabalho', entrada: '07:30', saida: '17:54', almoco_ini: '11:30', almoco_fim: '13:30' }), /exige justificativa/, 'Etapa 4: toda alteração é justificada, inclusive a do gerente');
  E.editarDia(1, MES, U.ger, { funcId: 105, data: '2026-12-29', tipo: 'trabalho', entrada: '07:30', saida: '17:54', almoco_ini: '11:30', almoco_fim: '13:30', justificativa: 'troca de horário combinada' }); S.aposEdicao(U.ger, 1, MES, { funcId: 105, data: '2026-12-29', justificativa: 'troca de horário combinada' }, 'rascunho');
  assert.ok(S.avisos(U.co).pendentes_rotina >= 1); assert.ok(!S.avisos(U.co).avisos.some(a => /alterou Eva Rocha em 29\/12/.test(a.texto)));
  assert.equal(S.relatorioDiario({ agora: new Date('2026-11-11T09:00:00') }), null, 'antes da hora configurada não envia');
  const rel = S.relatorioDiario({ agora: new Date('2026-11-11T18:05:00') }); assert.ok(rel.itens >= 1); assert.deepEqual(rel.para.sort(), ['co', 'co2']);
  assert.equal(S.relatorioDiario({ agora: new Date('2026-11-11T19:00:00') }), null, 'um por dia');
  const d = S.avisos(U.co).avisos.find(a => a.tipo === 'diario'); assert.ok(d.itens.some(i => /alterou Eva Rocha em 29\/12/.test(i.texto))); assert.equal(S.avisos(U.co).pendentes_rotina, 0);
  // RH mexendo em domingo = relevante (imediato); alteração em escala aprovada = crítico
  S.aposEdicao(U.rh, 1, MES, { funcId: 105, data: '2026-12-27', justificativa: 'inventário' }, 'rascunho'); assert.ok(S.avisos(U.co).avisos.some(a => a.nivel === 'relevante' && /\(RH\) alterou Eva Rocha em 27\/12 \(domingo\)/.test(a.texto)));
  S.aposEdicao(U.ger, 1, MES, { funcId: 105, data: '2026-12-29' }, 'aprovada'); assert.ok(S.avisos(U.co).avisos.some(a => a.nivel === 'critico' && /alterou Eva Rocha em 29\/12/.test(a.texto)));
});

// ═══ ETAPA 3 — histórico real do ponto, semana de transição, pesos por dia e intervalo na regra ═══════════
// Loja 3 (Ponte) com quadro próprio, para não depender do que os testes de cima deixaram na loja 1.
// Hoje = quarta 11/11/2026; a proposta do mês corrente começa na quinta 12/11 → semana de transição 09–11/11.
const { soma, dow, min: MIN } = require('../lib/escalas-gerador')._util;
const colabs3 = { ativos: nomes.map((n, i) => ({ id: 301 + i, nome: n + ' Ponte', loja: 3, setor: i < 5 ? 'CAIXA' : 'REPOSITOR', cargo: i < 5 ? 'Operador de caixa' : 'Repositor', matricula: 'P' + i, turno: 'SEG-SEX 44H', turno_id: 10, admissao: '2025-03-01' })), desligados: [] };
const BATIDAS = ['07:00', '11:00', '13:00', '17:48'];
/** Apuração "do ponto" (formato de pontocerto.workDays): seg–sex com 4 marcações, sábado e domingo sem jornada e sem marcação. */
function pontoDe(mud = {}, semLinha = [], de = '2026-10-12', ate = HOJE) {
  const linhas = []; for (const c of colabs3.ativos) { if (semLinha.includes(c.id)) continue; for (let d = de; d <= ate; d = soma(d, 1)) { const util = dow(d) >= 1 && dow(d) <= 5, k = c.id + '|' + d; linhas.push({ employee_id: c.id, data: d, shift_time: util ? '08:48' : '00:00', marcacoes: k in mud ? mud[k] : (util ? BATIDAS : []) }); } }
  return { de, ate, linhas };
}
const ctx3 = (ponto, extra) => ({ colabs: colabs3, escalasPC, afast: new Map(), afastAnt: new Map(), hoje: HOJE, ponto, ...extra });
const MUD = { '301|2026-11-10': [],                                       // Ana: jornada prevista e nenhuma marcação
  '302|2026-11-08': ['06:30', '12:40'],                                   // Bruno: trabalhou no domingo (folga prevista)
  '305|2026-11-10': ['07:05'],                                            // Eva: marcação incompleta
  '306|2026-11-11': [] };                                                 // Fábio: hoje ainda sem marcação (dia em andamento)
const AFAST3 = new Map([['CARLA REIS PONTE', [{ nome: 'CARLA REIS PONTE', inicio: '2026-11-09', fim: '2026-11-10', ferias: false }]]]);

test('histórico real do ponto: separa planejado, marcação realizada, folga prevista, descanso identificado e ausência — sem marcação não vira folga', () => {
  const c = ctx3(pontoDe(MUD, [304]), { afastJanela: AFAST3 }); const { e } = S.escalaDe(3, MESN, c);
  assert.deepEqual(S.janelaHistorico('2026-11-12'), { de: '2026-10-12', ate: '2026-11-11' });
  const { hist, resumo } = S.historicoReal(e, '2026-11-12', c); const d = (id, dia) => hist[id].dias[dia];
  // marcação realizada: horário batido, fonte ponto
  assert.deepEqual(d(302, '2026-11-09'), { tipo: 'trabalho', entrada: '07:00', saida: '17:48', almoco_ini: '11:00', almoco_fim: '13:00', setor: 'FRENTE DE CAIXA', fonte: 'ponto' });
  // folga prevista + nenhuma marcação = descanso identificado; folga prevista COM marcação = trabalhou
  assert.deepEqual(d(301, '2026-11-08'), { tipo: 'folga', fonte: 'ponto' });
  assert.equal(d(302, '2026-11-08').tipo, 'trabalho'); assert.equal(d(302, '2026-11-08').emFolgaPrevista, true); assert.equal(d(302, '2026-11-08').entrada, '06:30'); assert.equal(d(302, '2026-11-08').saida, '12:40');
  // jornada prevista e nenhuma marcação: NÃO é folga
  assert.deepEqual(d(301, '2026-11-10'), { tipo: 'indefinido', fonte: 'ponto' });
  // ausência/afastamento do relatório do ponto
  assert.deepEqual(d(303, '2026-11-09'), { tipo: 'afastado', fonte: 'ponto' }); assert.equal(d(303, '2026-11-11').tipo, 'trabalho');
  // quem não tem apuração no ponto: só o planejado, marcado como não confirmado (nos dois sentidos: trabalho e folga)
  assert.equal(d(304, '2026-11-10').tipo, 'trabalho'); assert.equal(d(304, '2026-11-10').naoConfirmado, true); assert.equal(d(304, '2026-11-10').fonte, 'escala'); assert.equal(d(304, '2026-11-08').tipo, 'folga'); assert.equal(d(304, '2026-11-08').naoConfirmado, true);
  // marcação incompleta: trabalhou, com o horário planejado; dia em andamento (hoje sem marcação): vale o planejado, sem pendência
  assert.equal(d(305, '2026-11-10').incompleta, true); assert.equal(d(305, '2026-11-10').saida, '17:48');
  assert.equal(d(306, '2026-11-11').tipo, 'trabalho'); assert.equal(d(306, '2026-11-11').fonte, 'escala'); assert.equal(d(306, '2026-11-11').naoConfirmado, undefined);
  assert.equal(resumo.fonte, 'ponto'); assert.equal(resumo.indefinido, 1); assert.equal(resumo.ausencia, 2); assert.equal(resumo.incompletas, 1); assert.equal(resumo.naoConfirmado, 30, 'os 30 dias passados da janela de quem não marca ponto (hoje fica como planejado)');
  assert.deepEqual(resumo.pendentes.filter(p => p.motivo === 'sem_marcacao').map(p => [p.id, p.data]), [[301, '2026-11-10']]); assert.deepEqual(resumo.semPonto, ['Davi Melo Ponte']);
  assert.ok(resumo.limitacoes.some(t => /não devolve a escala planejada/.test(t))); assert.ok(resumo.limitacoes.some(t => /não foram contados como folga/.test(t))); assert.ok(resumo.limitacoes.some(t => /não marcam ponto/.test(t)));
  assert.equal(E.ler(3, MESN), null, 'ler o histórico não grava nada');
});

test('semana de transição com o ponto: sem dados suficientes não aplica; o indefinido não é contado como folga; a segunda-feira seguinte é sugerida', () => {
  const r3 = S.salvarRegra(U.rh, { ...regraBody, nome: 'CCT Ponte (teste)', estabelecimento: 3 }); S.validarRegra(U.rh, r3.id, 'Conferida a cláusula 12 da CCT 2026/2027');
  const c = () => ctx3(pontoDe(MUD, [304]), { afastJanela: AFAST3 });
  const s = S.simular(U.rh, 3, MESN, c()); const t = s.resultado.transicao; assert.equal(s.de, '2026-11-12');
  assert.equal(t.necessaria, true); assert.deepEqual(t.semana, { inicio: '2026-11-09', fim: '2026-11-15' }); assert.equal(t.pendentes, 2);
  const ana = t.funcionarios.find(x => x.funcId === 301), davi = t.funcionarios.find(x => x.funcId === 304), bruno = t.funcionarios.find(x => x.funcId === 302);
  assert.deepEqual(ana.pendentes, ['2026-11-10']); assert.equal(ana.descansos, 0); assert.equal(ana.folgasPropostas, 2, 'o dia sem marcação não descontou folga');
  assert.deepEqual(davi.pendentes, ['2026-11-09', '2026-11-10']); assert.equal(bruno.situacao, 'ok'); assert.equal(bruno.trabalhados, 3); assert.equal(bruno.folgasPropostas, 2);
  assert.deepEqual(s.aplicacao.pendencias.map(p => p.codigo), ['transicao_sem_dados']); assert.equal(s.aplicacao.permitida, false); assert.equal(s.sugestaoInicio, '2026-11-16');
  assert.match(s.aplicacao.pendencias[0].texto, /2 funcionário\(s\).*próxima segunda: 16\/11/);
  assert.throws(() => S.aplicar(U.rh, 3, MESN, c(), { justificativa: 'gerar novembro em 5x2', cienteDivergencias: true }), status(409)); assert.equal(E.ler(3, MESN), null);
  for (const p of s.resultado.proposta) for (const d of ['2026-11-09', '2026-11-10', '2026-11-11']) assert.equal(p.dias[d], undefined, 'registro do ponto não é regravado pela proposta');
  // começando na segunda-feira não há transição: a mesma base de dados libera a aplicação
  const seg = S.simular(U.rh, 3, MESN, c(), { aPartirDe: '2026-11-16' }); assert.equal(seg.resultado.transicao.necessaria, false); assert.equal(seg.aplicacao.permitida, true, JSON.stringify(seg.aplicacao.pendencias)); assert.equal(seg.sugestaoInicio, null);
  // ponto fora do ar: os dias passados ficam não confirmados → no meio da semana ninguém tem dado suficiente
  const fora = S.simular(U.rh, 3, MESN, ctx3(null)); assert.equal(fora.historico.fonte, 'planejado'); assert.equal(fora.resultado.transicao.pendentes, 8); assert.ok(fora.historico.limitacoes.some(x => /não respondeu/.test(x)));
  assert.ok(fora.aplicacao.pendencias.some(p => p.codigo === 'transicao_sem_dados'));
});

test('RH valida os dias que o ponto não confirma: só o RH da unidade, justificado e auditado; depois disso a folga não duplica e a transição libera', () => {
  const c = () => ctx3(pontoDe(MUD, [304]), { afastJanela: AFAST3 }); const funcs = S.escalaDe(3, MESN, c()).e.funcionarios;
  const itens = [{ id: 301, data: '2026-11-10', tipo: 'descanso' }, { id: 304, data: '2026-11-09', tipo: 'trabalho' }, { id: 304, data: '2026-11-10', tipo: 'trabalho' }];
  assert.throws(() => S.validarHistorico(U.ger, 3, funcs, itens, 'conferido com o gerente da loja', HOJE), status(403));
  assert.throws(() => S.validarHistorico(U.rh2, 3, funcs, itens, 'conferido com o gerente da loja', HOJE), status(403), 'RH de outra unidade');
  assert.throws(() => S.validarHistorico(U.rh, 3, funcs, itens, 'ok', HOJE), /Justifique/);
  assert.throws(() => S.validarHistorico(U.rh, 3, funcs, [{ id: 301, data: HOJE, tipo: 'descanso' }], 'conferido com o gerente da loja', HOJE), /já encerrados/);
  assert.throws(() => S.validarHistorico(U.rh, 3, funcs, [{ id: 999, data: '2026-11-10', tipo: 'descanso' }], 'conferido com o gerente da loja', HOJE), /não está no quadro/);
  assert.throws(() => S.validarHistorico(U.rh, 3, funcs, [{ id: 301, data: '2026-11-10', tipo: 'folga' }], 'conferido com o gerente da loja', HOJE), /trabalhou ou descansou/);
  const antes = S.trilha(U.co, { loja: 3 }).registros.length;
  assert.equal(S.validarHistorico(U.rh, 3, funcs, itens, 'Folga compensatória da Ana e ponto manual do Davi conferidos com o gerente', HOJE).validados, 3);
  const reg = S.trilha(U.co, { loja: 3 }).registros.find(x => x.acao === 'historico_validar'); assert.ok(reg); assert.equal(reg.alteracoes.length, 3); assert.equal(reg.usuario, 'rh'); assert.equal(S.trilha(U.co, { loja: 3 }).registros.length, antes + 1); assert.equal(S.verificarCadeia().ok, true);
  assert.ok(S.avisos(U.co).avisos.some(a => a.nivel === 'relevante' && /validou 3 dia\(s\)/.test(a.texto)));
  const s = S.simular(U.rh, 3, MESN, c()); const t = s.resultado.transicao; assert.equal(t.pendentes, 0); assert.equal(s.aplicacao.permitida, true, JSON.stringify(s.aplicacao.pendencias));
  const ana = t.funcionarios.find(x => x.funcId === 301); assert.equal(ana.descansos, 1); assert.equal(ana.folgasPropostas, 1, 'descanso validado conta: sem folga duplicada'); assert.equal(ana.dias.find(x => x.data === '2026-11-10').fonte, 'rh');
  assert.equal(s.historico.validadoRH, 3); assert.equal(s.historico.indefinido, 0);
  for (const p of s.resultado.proposta) { const sem = p.semanas[0]; if (p.id !== 303) { assert.equal(sem.trabalho, 5, p.nome); assert.equal(sem.folgas, 2, p.nome); } }
  // aplicar continua gravando só RASCUNHO, e a geração guarda a transição e o resumo do histórico usado
  const r = S.aplicar(U.rh, 3, MESN, c(), { justificativa: 'gerar novembro em 5x2 a partir de 12/11', cienteDivergencias: true, assinatura: s.assinatura });
  assert.equal(E.obter(3, MESN).status, 'rascunho'); const g = S.geracao(U.rh, r.geracao.id); assert.equal(g.transicao.necessaria, true); assert.equal(g.historico.fonte, 'ponto'); assert.equal(g.historico.validadoRH, 3);
  assert.ok(!Object.keys(g.depois).some(k => k.split('|')[1] < '2026-11-12'), 'nenhum dia anterior ao início foi gravado');
  // desfazer a validação devolve a pendência
  assert.equal(S.validarHistorico(U.rh, 3, funcs, [{ id: 301, data: '2026-11-10', tipo: null }], 'validação lançada na pessoa errada', HOJE).validados, 1);
  assert.equal(S.historicoReal(S.escalaDe(3, MESN, c()).e, '2026-11-12', c()).resumo.indefinido, 1);
});

test('pesos por dia: configurados por unidade e por setor (1 a 5), auditados, e usados na simulação sem virar proibição', () => {
  const c = () => ctx3(pontoDe()); const rot = s => s.resultado.proposta.reduce((t, p) => t + Object.entries(p.dias).filter(([d, x]) => x.folga === 'rotativa' && [5, 6].includes(dow(d))).length, 0);
  // folga fixa de segunda a quinta (definida pelo RH), para a rotativa poder cair em qualquer dia
  S.salvarCadastro(U.rh, 3, S.escalaDe(3, MES, c()).e.funcionarios, colabs3.ativos.map((x, i) => ({ id: x.id, folga_fixa: 1 + (i % 4) })), 'folgas fixas definidas pelo RH');
  const sem = S.simular(U.rh, 3, MES, c()); assert.deepEqual(sem.resultado.pesos.diasPesados, []); assert.ok(rot(sem) >= 6, 'sem peso há rotativas na sexta e no sábado: ' + rot(sem));
  assert.throws(() => S.salvarCobertura(U.ger, 3, { pesoDia: { 5: 3 } }, 'sexta e sábado de maior movimento'), status(403));
  assert.throws(() => S.salvarCobertura(U.rh, 3, { pesoDia: { 5: 9 } }, 'sexta e sábado de maior movimento'), /de 1 \(normal\) a 5/);
  assert.throws(() => S.salvarCobertura(U.rh, 3, { pesoDia: { 8: 2 } }, 'sexta e sábado de maior movimento'), /Peso do dia inválido/);
  const cob = S.salvarCobertura(U.co, 3, { entradas: ['07:00', '09:00'], picos: [], pesoDia: { 1: 1, 5: 3, 6: 4 }, pesosSetor: { reposição: { 6: 1 } } }, 'sexta e sábado de maior movimento; reposição folga normalmente no sábado');
  assert.deepEqual(cob.pesoDia, { 5: 3, 6: 4 }, 'peso 1 (normal) não é gravado na unidade'); assert.deepEqual(cob.pesosSetor, { REPOSICAO: { 6: 1 } }); assert.deepEqual(cob.setores.REPOSICAO.pesoDia, { 6: 1 });
  const reg = S.trilha(U.co, { loja: 3 }).registros.find(x => x.acao === 'cobertura'); assert.deepEqual(reg.depois.pesoDia, { 5: 3, 6: 4 }); assert.deepEqual(reg.antes.pesoDia, {});
  // chamada antiga (sem os campos de peso) não apaga o que estava gravado
  assert.deepEqual(S.salvarCobertura(U.rh, 3, { entradas: ['07:00', '09:00'], picos: [] }, 'mesmas entradas, sem mexer nos pesos').pesoDia, { 5: 3, 6: 4 });
  const com = S.simular(U.rh, 3, MES, c()); assert.deepEqual(com.resultado.pesos.diasPesados, [5, 6]);
  assert.ok(rot(com) < rot(sem), 'rotativas em sexta/sábado: ' + rot(sem) + ' → ' + rot(com));
  assert.equal(com.resultado.indicadores.pct_semanas_5x2, 100, 'peso não tira folga de ninguém'); assert.equal(com.resultado.conflitos.trabalhistas.filter(x => x.gravidade === 'bloqueio').length, 0);
  assert.equal(com.resultado.pesos.folgasEmDiaPesado, com.resultado.proposta.reduce((t, p) => t + p.folgasEmDiaPesado, 0));
});

test('regra trabalhista: intervalo mínimo, máximo e horas seguidas da convenção são validados, gravados e chegam ao motor', () => {
  const base = { ...regraBody, nome: 'CCT Ponte — intervalo', estabelecimento: 3, vigencia: { de: '2026-11-01', ate: '2027-12-31' } };
  assert.throws(() => S.salvarRegra(U.rh, { ...base, params: { ...regraBody.params, intervalo: { minimoMin: 999 } } }), /intervalo fora da faixa/);
  assert.throws(() => S.salvarRegra(U.rh, { ...base, params: { ...regraBody.params, intervalo: { minimoMin: 180, maximoMin: 120 } } }), /mínimo não pode ser maior/);
  assert.throws(() => S.salvarRegra(U.rh, { ...base, params: { ...regraBody.params, intervaloMin: 30 } }), /precisa ficar entre o mínimo/);
  assert.throws(() => S.salvarRegra(U.rh, { ...base, params: { ...regraBody.params, intervalo: { continuoMaxMin: 240 } } }), /não existe posição de intervalo/);
  const r = S.salvarRegra(U.rh, { ...base, params: { ...regraBody.params, intervaloMin: 60, intervalo: { continuoMaxMin: 300 } } });
  assert.equal(r.params.intervalo.continuoMaxMin, 300); assert.equal(r.params.intervalo.minimoMin, 60, 'o que a convenção não muda fica no padrão'); assert.equal(r.params.intervalo.maximoMin, 120); assert.equal(r.validada, false);
  assert.deepEqual(S.cfg().regras.find(x => x.id === r.id).params.intervalo, { continuoMaxMin: 300 }, 'só o que foi informado é gravado');
  S.validarRegra(U.rh, r.id, 'Conferida a cláusula de intervalo da CCT 2026/2027');
  const s = S.simular(U.rh, 3, MES, ctx3(pontoDe())); assert.ok(s.resultado.regrasAplicadas.some(x => x.id === r.id && x.validada));
  let n = 0; for (const p of s.resultado.proposta) for (const x of Object.values(p.dias)) if (x.tipo === 'trabalho' && x.origem === 'gerador') { n++; assert.equal(MIN(x.almoco_fim) - MIN(x.almoco_ini), 60); assert.ok(MIN(x.almoco_ini) - MIN(x.entrada) <= 300 && MIN(x.saida) - MIN(x.almoco_fim) <= 300, JSON.stringify(x)); }
  assert.ok(n > 100); assert.ok(!s.resultado.conflitos.trabalhistas.some(x => /intervalo|continuo|pausa/.test(x.codigo)));
});

// ═══ ETAPA 4 — cores por turno, regra das duas folgas com trava de publicação, auditoria de cada alteração ═══
// Loja 5 (Porta Larga) com quadro próprio; dezembro/2026 inteiro é futuro (hoje = 11/11): 01/12 é terça, então a semana
// 30/11–06/12 atravessa o mês e entra pela transição (30/11 = planejado do contrato).
const colabs5 = { ativos: nomes.map((n, i) => ({ id: 501 + i, nome: n + ' Porta', loja: 5, setor: i < 5 ? 'CAIXA' : 'REPOSITOR', cargo: i < 5 ? 'Operador de caixa' : 'Repositor', matricula: 'L' + i, turno: 'SEG-SEX 44H', turno_id: 10, admissao: '2025-03-01' })), desligados: [] };
const ctx5 = extra => ({ colabs: colabs5, escalasPC, afast: new Map(), afastAnt: new Map(), hoje: HOJE, ponto: null, ...extra });
const semanaDe = seg => [0, 1, 2, 3, 4, 5, 6].map(i => soma(seg, i));
const ultimaAud = acao => fs.readFileSync(S.P.aud(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.acao === acao).pop();
const diaNaGrade = (id, d) => { const e = E.ler(5, MES); return E.diaDe(e, e.funcionarios.find(f => f.id === id), d, null); };

test('turnos e cores: classificação configurável por unidade e por setor, legenda com cores e horários, auditada', () => {
  const t0 = S.turnosLoja(5); assert.equal(t0.unidade.abre, '07:00'); assert.equal(t0.unidade.fecha, '19:00'); assert.equal(t0.unidade.aberturaAte, '07:59'); assert.equal(t0.unidade.fechamentoDesde, '19:00'); assert.deepEqual(t0.setores, {});
  assert.deepEqual(t0.classes.map(c => [c.id, c.nome]), [['abertura', 'Abertura'], ['intermediario', 'Intermediário'], ['fechamento', 'Fechamento'], ['especial', 'Turno especial']]);
  assert.equal(new Set(Object.values(S.CORES)).size, Object.keys(S.CORES).length, 'cada classificação tem a própria cor (férias ≠ afastamento, F ≠ FR)');
  const corpo = { entradas: ['07:00', '08:36'], picos: [], turnos: { aberturaAte: '08:00', especiais: '0600-1200, 12:00–18:00' }, turnosSetor: { 'reposição': { abre: '05:00', fecha: '14:00' }, CAIXA: {} } };
  assert.throws(() => S.salvarCobertura(U.ger, 5, corpo, 'classificação dos turnos'), status(403));
  assert.throws(() => S.salvarCobertura(U.co, 5, { ...corpo, turnos: { aberturaAte: '20:00' } }, 'classificação dos turnos'), /dentro do funcionamento/);
  assert.throws(() => S.salvarCobertura(U.co, 5, { ...corpo, turnos: { especiais: 'manhã' } }, 'classificação dos turnos'), /Horários especiais inválidos/);
  assert.throws(() => S.salvarCobertura(U.co, 5, { ...corpo, turnosSetor: { PADARIA: { abre: '14:00', fecha: '05:00' } } }, 'classificação dos turnos'), /Funcionamento inválido/);
  const c = S.salvarCobertura(U.co, 5, corpo, 'classificação dos turnos da Porta Larga'); const T = c.turnos;
  assert.equal(T.unidade.aberturaAte, '08:00'); assert.deepEqual(T.unidade.especiais, ['06:00-12:00', '12:00-18:00']); assert.deepEqual(Object.keys(T.setores), ['REPOSICAO'], 'setor sem nada informado não é gravado');
  assert.deepEqual({ ...T.setores.REPOSICAO, proprio: undefined }, { abre: '05:00', fecha: '14:00', aberturaAte: '05:59', fechamentoDesde: '14:00', especiais: ['06:00-12:00', '12:00-18:00'], proprio: undefined });
  const aud = ultimaAud('cobertura'); assert.deepEqual(aud.depois.turnos, { aberturaAte: '08:00', especiais: ['06:00-12:00', '12:00-18:00'] }); assert.deepEqual(aud.antes.turnos, {}); assert.equal(aud.usuario, 'co');
  // chamada antiga (sem os campos de turno) não apaga o que estava gravado
  assert.equal(S.salvarCobertura(U.co, 5, { entradas: ['07:00', '08:36'], picos: [] }, 'só as entradas').turnos.unidade.aberturaAte, '08:00');
  // pintar: a classificação sai do funcionamento do setor do dia; a legenda traz cor, regra e os horários de cada classe
  const d = (en, sa) => ({ tipo: 'trabalho', entrada: en, saida: sa, almoco_ini: null, almoco_fim: null });
  const funcs = [{ setor: 'FRENTE DE CAIXA', dias: { a: d('07:00', '17:24'), b: d('08:00', '18:24'), c: d('08:30', '18:54'), d: d('09:00', '19:24'), e: d('06:00', '12:00'), f: { tipo: 'folga' }, g: { tipo: 'ferias' } } },
    { setor: 'REPOSICAO', dias: { a: d('05:00', '13:00'), b: d('07:00', '17:24'), c: d('06:30', '13:30') } }];
  const L = S.pintar(5, funcs);
  assert.deepEqual(Object.values(funcs[0].dias).map(x => x.classe), ['abertura', 'abertura', 'intermediario', 'fechamento', 'especial', undefined, undefined]);
  assert.deepEqual(Object.values(funcs[1].dias).map(x => x.classe), ['abertura', 'fechamento', 'intermediario'], 'na Reposição (05–14) o turno das 07:00 às 17:24 é fechamento');
  assert.deepEqual(L.classes.map(x => [x.id, x.cor, x.dias]), [['abertura', S.CORES.abertura, 3], ['intermediario', S.CORES.intermediario, 2], ['fechamento', S.CORES.fechamento, 2], ['especial', S.CORES.especial, 1]]);
  assert.deepEqual(L.classes[0].horarios, ['0500-1300', '0700-1724', '0800-1824']); assert.match(L.classes[0].regra, /entrada até 08:00/); assert.match(L.classes[3].regra, /06:00–12:00/);
  assert.deepEqual(L.funcionamento, { abre: '07:00', fecha: '19:00' }); assert.equal(L.setoresProprios[0].setor, 'REPOSICAO');
  // a proposta do gerador já sai pintada, e pintar não muda a assinatura da simulação
  const r5 = S.salvarRegra(U.rh, { ...regraBody, nome: 'CCT Porta Larga (teste)', estabelecimento: 5 }); S.validarRegra(U.rh, r5.id, 'Conferida a cláusula 12 da CCT 2026/2027');
  const s = S.simular(U.rh, 5, MES, ctx5()); let n = 0;
  for (const p of s.resultado.proposta) for (const x of Object.values(p.dias)) { if (x.tipo === 'trabalho') { n++; assert.ok(['abertura', 'intermediario', 'fechamento', 'especial'].includes(x.classe), JSON.stringify(x)); } else assert.equal(x.classe, undefined); }
  assert.ok(n > 100); assert.equal(s.classes.classes.reduce((t, x) => t + x.dias, 0), n);
  S.salvarCobertura(U.co, 5, { ...corpo, turnos: {} }, 'volta ao padrão do funcionamento'); assert.equal(S.simular(U.rh, 5, MES, ctx5()).assinatura, s.assinatura);
});

test('duas folgas no serviço: a geração fecha em 2 por semana; 3ª folga à mão é auditada, avisa a Coordenação, trava a publicação e o gerador reprocessa', () => {
  const funcs = S.escalaDe(5, MES, ctx5()).e.funcionarios;
  S.salvarCadastro(U.rh, 5, funcs, [{ id: 501, folga_fixa: 1 }], 'folga fixa da Ana definida pelo RH (segunda)');
  const s = S.simular(U.rh, 5, MES, ctx5()); assert.equal(s.aplicacao.permitida, true, JSON.stringify(s.aplicacao.pendencias));
  assert.equal(s.duasFolgas.excesso + s.duasFolgas.falta, 0); assert.equal(s.duasFolgas.ok, s.duasFolgas.semanas);
  for (const p of s.resultado.proposta) for (const w of p.semanas) { assert.equal(w.regra52.folgas, 2, p.nome + ' ' + w.inicio); assert.equal(w.regra52.situacao, 'ok'); }
  // a semana 28/12–03/01 atravessa para janeiro: as folgas que caem em janeiro entram como previstas e a conta fecha em 2
  for (const p of s.resultado.proposta) { const w = p.semanas.find(x => x.inicio === '2026-12-28'); assert.equal(w.regra52.noPeriodo + w.regra52.previstas, 2, p.nome); }
  const g = S.aplicar(U.rh, 5, MES, ctx5(), { justificativa: 'dezembro em 5x2 na Porta Larga', cienteDivergencias: true, assinatura: s.assinatura });
  const ap = ultimaAud('gerar_aplicar'); assert.equal(ap.validacao.ok, true); assert.equal(ap.validacao.duasFolgas.ok, s.duasFolgas.semanas); assert.match(ap.validacao.resumo, /semanas com as duas folgas/); assert.equal(S.geracao(U.rh, g.geracao.id).duasFolgas.excesso, 0);
  const p0 = S.portaPublicacao(5, MES, ctx5()); assert.equal(p0.aplicavel, true); assert.equal(p0.liberada, true, JSON.stringify(p0.bloqueios)); assert.equal(p0.desde, '2026-11-30');
  // RH dá uma folga a mais ao Bruno (502) na semana de 14/12: a semana fica com 3 folgas
  const alvo = semanaDe('2026-12-14').find(d => diaNaGrade(502, d).tipo === 'trabalho'); const corpo = { funcId: 502, data: alvo, tipo: 'folga', justificativa: 'pedido do funcionário, sem troca combinada' };
  const antesDia = diaNaGrade(502, alvo); const ed = E.editarDia(5, MES, U.rh, corpo, new Map()); assert.equal(ed.ok, true, 'a autonomia do RH continua: a alteração é gravada');
  const pos = S.aposEdicao(U.rh, 5, MES, corpo, 'rascunho', new Map());
  assert.equal(pos.validacao.ok, false); assert.equal(pos.validacao.situacao, 'excesso'); assert.equal(pos.validacao.folgas, 3); assert.equal(pos.validacao.exigidas, 2); assert.deepEqual(pos.validacao.semana, { inicio: '2026-12-14', fim: '2026-12-20' });
  assert.equal(pos.validacao.bloqueios[0].codigo, 'folgas_semana_excesso'); assert.match(pos.validacao.resumo, /3 folga\(s\) \(F \+ FR\).*INVÁLIDA/); assert.equal(pos.nivel, 'relevante');
  // auditoria encadeada com tudo o que a alteração precisa registrar
  const a = ultimaAud('dia_alterar'); assert.equal(a.seq, pos.auditoria);
  assert.equal(a.funcionario, 'Bruno Sá Porta'); assert.equal(a.funcId, 502); assert.equal(a.loja, 5); assert.equal(a.setor, 'FRENTE DE CAIXA'); assert.deepEqual(a.semana, { inicio: '2026-12-14', fim: '2026-12-20' }); assert.equal(a.data, alvo);
  assert.equal(a.antes.tipo, 'trabalho'); assert.equal(a.antes.entrada, antesDia.entrada); assert.equal(a.depois.tipo, 'folga'); assert.equal(a.usuario, 'rh'); assert.equal(a.nome, 'RH Ponto'); assert.ok(!isNaN(Date.parse(a.em)));
  assert.equal(a.justificativa, corpo.justificativa); assert.equal(a.peloRH, true); assert.equal(a.validacao.ok, false); assert.equal(a.validacao.folgas, 3); assert.equal(a.validacao.bloqueios[0].codigo, 'folgas_semana_excesso'); assert.equal(S.verificarCadeia().ok, true);
  const tr = S.trilha(U.co, { loja: 5, mes: MES }).registros; const linha = tr.find(x => x.acao === 'dia_alterar'); assert.equal(linha.funcionario, 'Bruno Sá Porta'); assert.equal(linha.setor, 'FRENTE DE CAIXA'); assert.match(linha.detalhe, /semana 14\/12 a 20\/12.*validação: 3 folga/);
  assert.equal(tr.filter(x => x.origem === 'grade').length, 0, 'a alteração aparece uma vez só na trilha (a da cadeia)'); assert.equal(E.ler(5, MES).historico.slice(-1)[0].auditoria, a.seq);
  // impacto operacional relevante = aviso imediato à Coordenação
  assert.ok(S.avisos(U.co).avisos.some(x => x.nivel === 'relevante' && x.tipo === 'imediato' && /alterou Bruno Sá Porta.*SEMANA INVÁLIDA: 3 folgas/.test(x.texto)));
  // escala inválida não é validada nem aprovada, e a tentativa fica registrada
  const p1 = S.portaPublicacao(5, MES, ctx5()); assert.equal(p1.liberada, false); assert.equal(p1.folgas, 1); assert.equal(p1.duasFolgas.excesso, 1);
  assert.throws(() => S.exigirPublicavel(U.co, 5, MES, ctx5(), 'aprovar'), e => e.status === 409 && /não pode ser aprovada.*regra das duas folgas.*3 folgas/.test(e.message) && e.bloqueios.length === p1.bloqueios.length);
  const pb = ultimaAud('publicacao_bloqueada'); assert.equal(pb.tentativa, 'aprovar'); assert.equal(pb.usuario, 'co'); assert.equal(pb.folgas, 1);
  // reprocessamento: simular de novo respeita a folga dada à mão e tira a rotativa da semana — volta a ter exatamente 2
  const s2 = S.simular(U.rh, 5, MES, ctx5()); const w2 = s2.resultado.proposta.find(p => p.id === 502).semanas.find(x => x.inicio === '2026-12-14');
  assert.equal(w2.regra52.folgas, 2); assert.equal(s2.resultado.proposta.find(p => p.id === 502).dias[alvo].travado, true); assert.equal(s2.duasFolgas.excesso, 0); assert.equal(s2.aplicacao.permitida, true, JSON.stringify(s2.aplicacao.pendencias));
  S.aplicar(U.rh, 5, MES, ctx5(), { justificativa: 'reprocessamento depois da folga do Bruno', cienteDivergencias: true, assinatura: s2.assinatura });
  assert.equal(diaNaGrade(502, alvo).tipo, 'folga', 'o dia ajustado à mão não foi sobrescrito'); assert.equal(semanaDe('2026-12-14').filter(d => diaNaGrade(502, d).tipo === 'folga').length, 2);
  assert.equal(S.portaPublicacao(5, MES, ctx5()).liberada, true); assert.equal(S.exigirPublicavel(U.co, 5, MES, ctx5(), 'aprovar').liberada, true);
  // escala que nunca passou pelo gerador não entra na trava (continua como sempre foi)
  assert.equal(S.portaPublicacao(6, MES, ctx5()).aplicavel, false);
});

test('duas folgas no serviço: menos de duas trava a publicação até o RH da unidade analisar a exceção (justificada e auditada)', () => {
  // Ana (501, folga fixa segunda): numa semana em que a rotativa dela não é domingo, o RH troca a rotativa por 2 h de trabalho
  const seg = ['2026-12-07', '2026-12-14', '2026-12-21'].find(sg => semanaDe(sg).slice(1, 6).some(d => diaNaGrade(501, d).tipo === 'folga')); assert.ok(seg, 'há semana com rotativa em dia útil');
  const dia = semanaDe(seg).slice(1, 6).find(d => diaNaGrade(501, d).tipo === 'folga'); const corpo = { funcId: 501, data: dia, tipo: 'trabalho', entrada: '08:00', saida: '10:00', justificativa: 'reunião de inventário, 2 horas' };
  E.editarDia(5, MES, U.rh, corpo, new Map()); const pos = S.aposEdicao(U.rh, 5, MES, corpo, 'rascunho', new Map());
  assert.equal(pos.validacao.situacao, 'falta'); assert.equal(pos.validacao.folgas, 1); assert.equal(pos.validacao.ok, false); assert.equal(pos.validacao.horas, '44h00', '5 × 8h24 + 2h00: a carga é a efetiva');
  assert.deepEqual(pos.validacao.bloqueios.map(b => b.codigo), ['folgas_semana_falta']); assert.equal(S.portaPublicacao(5, MES, ctx5()).liberada, false);
  const funcs = E.ler(5, MES).funcionarios; const exc = { funcId: 501, semana: dia, justificativa: 'Inventário anual; folga compensada na semana seguinte, combinado com a funcionária' };
  assert.throws(() => S.registrarExcecaoFolga(U.ger, 5, funcs, exc), status(403)); assert.throws(() => S.registrarExcecaoFolga(U.rh2, 5, funcs, exc), status(403), 'RH de outra unidade');
  assert.throws(() => S.registrarExcecaoFolga(U.rh, 5, funcs, { ...exc, justificativa: 'ok' }), /mínimo de 10/); assert.throws(() => S.registrarExcecaoFolga(U.rh, 5, funcs, { ...exc, funcId: 999 }), /não está no quadro/);
  assert.deepEqual(S.registrarExcecaoFolga(U.rh, 5, funcs, exc).semana, { inicio: seg, fim: soma(seg, 6) });
  const a = ultimaAud('folga_excecao'); assert.equal(a.funcionario, 'Ana Lima Porta'); assert.equal(a.setor, 'FRENTE DE CAIXA'); assert.deepEqual(a.semana, { inicio: seg, fim: soma(seg, 6) }); assert.equal(a.antes, null); assert.match(a.depois.motivo, /Inventário anual/); assert.equal(a.usuario, 'rh');
  assert.ok(S.avisos(U.co).avisos.some(x => x.nivel === 'relevante' && /registrou exceção à regra das duas folgas para Ana Lima Porta/.test(x.texto)));
  const v = S.validacaoDaSemana(5, MES, 501, dia, ctx5()); assert.equal(v.situacao, 'excecao'); assert.equal(v.ok, true, JSON.stringify(v.bloqueios)); assert.equal(v.folgas, 1);
  const an = S.analisar(U.co, 5, MES, ctx5()); assert.equal(an.duasFolgas.excecao, 1); assert.equal(an.duasFolgas.falta, 0); assert.equal(an.publicacao.liberada, true); assert.equal(an.publicacao.aplicavel, true);
  assert.ok(an.conflitos.trabalhistas.some(c => c.codigo === 'folgas_semana_falta' && c.gravidade === 'info' && c.excecao)); assert.equal(an.podeExcecao, false, 'Coordenação consulta; quem analisa a exceção é o RH da unidade'); assert.equal(S.analisar(U.rh, 5, MES, ctx5()).podeExcecao, true);
  // retirar a exceção devolve o bloqueio
  assert.equal(S.registrarExcecaoFolga(U.rh, 5, funcs, { ...exc, remover: true, justificativa: 'folga compensatória não foi concedida' }).removida, true);
  assert.equal(S.portaPublicacao(5, MES, ctx5()).liberada, false); assert.equal(ultimaAud('folga_excecao').depois, null);
  S.registrarExcecaoFolga(U.rh, 5, funcs, exc); assert.equal(S.portaPublicacao(5, MES, ctx5()).liberada, true);
});

test('férias e afastamento no serviço: preservados na proposta, fora da conta das folgas, semana proporcional para análise do RH — e a carga é a efetiva', () => {
  const afast = new Map([['CARLA REIS PORTA', [{ nome: 'CARLA REIS PORTA', inicio: '2026-12-07', fim: '2026-12-16', ferias: true }]], ['DAVI MELO PORTA', [{ nome: 'DAVI MELO PORTA', inicio: '2026-12-21', fim: '2026-12-27', ferias: false }]]]);
  const s = S.simular(U.rh, 5, MES, ctx5({ afast })); const carla = s.resultado.proposta.find(p => p.id === 503), davi = s.resultado.proposta.find(p => p.id === 504);
  for (let d = '2026-12-07'; d <= '2026-12-16'; d = soma(d, 1)) assert.equal(carla.dias[d].tipo, 'ferias', d); for (const d of semanaDe('2026-12-21')) assert.equal(davi.dias[d].tipo, 'afastado', d);
  const w = (p, sg) => p.semanas.find(x => x.inicio === sg);
  assert.equal(w(carla, '2026-12-07').regra52.situacao, 'ausente'); assert.equal(w(carla, '2026-12-07').folgas, 0, 'semana inteira de férias: nenhuma folga contada');
  assert.equal(w(carla, '2026-12-14').ausencias, 3); assert.ok(['analise_rh', 'ok'].includes(w(carla, '2026-12-14').regra52.situacao)); assert.ok(w(carla, '2026-12-14').regra52.folgas >= w(carla, '2026-12-14').regra52.exigidas);
  assert.equal(w(davi, '2026-12-21').regra52.situacao, 'ausente');
  for (const p of s.resultado.proposta) for (const x of p.semanas) assert.equal(x.trabalho + x.folgas + x.ausencias + x.regra52.incertos, 7, p.nome + ' ' + x.inicio);
  assert.equal(s.duasFolgas.excesso + s.duasFolgas.falta, 0); assert.ok(!s.aplicacao.pendencias.some(p => p.codigo === 'duas_folgas' || p.codigo === 'conflito_trabalhista'), JSON.stringify(s.aplicacao.pendencias));
  if (w(carla, '2026-12-14').regra52.situacao === 'analise_rh') assert.ok(s.resultado.conflitos.operacionais.some(c => c.codigo === 'folgas_semana_ausencia' && c.funcId === 503 && c.analiseRH));
  // carga horária: 5 dias de 8h24 = 42h00 efetivas; a permanência (com as 2 h de intervalo) é 52h00
  const sem = w(s.resultado.proposta.find(p => p.id === 505), '2026-12-07'); assert.equal(sem.minutos, 2520); assert.equal(sem.permanenciaMin, 3120); assert.equal(sem.intervalosMin, 600); assert.equal(sem.contratoMin, 2640);
  // validar a grade que está gravada com as férias lançadas depois: a ausência vence o dia gerado e não é contada como folga
  const an = S.analisar(U.rh, 5, MES, ctx5({ afast })); const pc = an.pessoas.find(p => p.id === 503);
  assert.equal(pc.semanas.find(x => x.inicio === '2026-12-07').regra52.situacao, 'ausente'); for (const x of pc.semanas) assert.equal(x.trabalho + x.folgas + x.ausencias + x.regra52.incertos, 7);
  assert.equal(an.proximoMes, null, 'janeiro ainda não tem grade: a semana 28/12–03/01 fecha pela previsão');
});

// ═══ ETAPA 5 — motor de validação semanal: correção sugerida, semanas vizinhas, virada de mês e de ano ═══
// Lojas 4 (Atacarejo) e 6 (Jardim Jordão) com quadro próprio; dezembro/2026 é todo futuro (hoje = 11/11).
const quadro = (loja, base, suf) => ({ ativos: nomes.map((n, i) => ({ id: base + 1 + i, nome: n + ' ' + suf, loja, setor: i < 5 ? 'CAIXA' : 'REPOSITOR', cargo: i < 5 ? 'Operador de caixa' : 'Repositor', matricula: suf[0] + i, turno: 'SEG-SEX 44H', turno_id: 10, admissao: '2025-03-01' })), desligados: [] });
const colabs4 = quadro(4, 400, 'Atacarejo'), colabs6 = quadro(6, 600, 'Jordão');
const ctx4 = extra => ({ colabs: colabs4, escalasPC, afast: new Map(), afastAnt: new Map(), hoje: HOJE, ponto: null, ...extra });
const ctx6 = extra => ({ colabs: colabs6, escalasPC, afast: new Map(), afastAnt: new Map(), hoje: HOJE, ponto: null, ...extra });
/** Põe a geração de dezembro na loja e devolve o id (regra validada da unidade incluída). */
function gerarDezembro(loja, ctx, nome) {
  const r = S.salvarRegra(U.rh, { ...regraBody, nome, estabelecimento: loja }); S.validarRegra(U.rh, r.id, 'Conferida a cláusula 12 da CCT 2026/2027');
  const s = S.simular(U.rh, loja, MES, ctx()); assert.equal(s.aplicacao.permitida, true, JSON.stringify(s.aplicacao.pendencias));
  return S.aplicar(U.rh, loja, MES, ctx(), { justificativa: 'dezembro em 5x2 (' + nome + ')', cienteDivergencias: true, assinatura: s.assinatura }).geracao.id;
}
/** Escreve dias na grade como se fossem do gerador (origem 'gerador') ou ajuste manual (sem origem): 'T' trabalho, 'F' folga fixa, 'R' rotativa, 'M' folga à mão, 'm' trabalho curto à mão. */
function montar(loja, id, seg, letras, gid) {
  const e = E.ler(loja, MES); const f = e.funcionarios.find(x => x.id === id);
  [...letras].forEach((l, i) => { const d = soma(seg, i), k = id + '|' + d; if (d.slice(0, 7) !== MES) return;
    const g = { setor: f.setor, obs: '', origem: 'gerador', geracao: gid }, vazio = { entrada: null, saida: null, almoco_ini: null, almoco_fim: null };
    e.dias[k] = l === 'T' ? { tipo: 'trabalho', entrada: '07:00', saida: '17:24', almoco_ini: '11:00', almoco_fim: '13:00', ...g } : l === 'F' ? { tipo: 'folga', ...vazio, ...g, folga: 'fixa' } : l === 'R' ? { tipo: 'folga', ...vazio, ...g, folga: 'rotativa' }
      : l === 'M' ? { tipo: 'folga', ...vazio, setor: f.setor, obs: 'ajuste do RH' } : { tipo: 'trabalho', entrada: '08:00', saida: '10:00', almoco_ini: null, almoco_fim: null, setor: f.setor, obs: 'ajuste do RH' }; });
  E.salvar(e);
}
const arquivo = loja => fs.readFileSync(path.join(process.env.ESCALAS_DIR, loja + '-' + MES + '.json'), 'utf8').replace(/"atualizadoEm":"[^"]+"/, '');
let GID4 = null;

test('correção sugerida · 2. três folgas e 8. alteração manual protegida: o motor preserva o ajuste do RH, testa as outras folgas sem gravar, propõe a de menor impacto e audita ao aplicar', () => {
  GID4 = gerarDezembro(4, ctx4, 'CCT Atacarejo (teste)');
  // Bruno (402): semana de 14/12 com folga à mão na quarta + folga fixa no sábado + rotativa no domingo; a seguinte tem só o domingo de folga
  montar(4, 402, '2026-12-14', 'TTMTTFR', GID4); montar(4, 402, '2026-12-21', 'TTTTTTR', GID4);
  const antes = arquivo(4); const c = S.sugerirCorrecao(U.co, 4, MES, 402, '2026-12-16', ctx4());
  assert.equal(arquivo(4), antes, 'sugerir não grava nada'); assert.deepEqual(c.semana, { inicio: '2026-12-14', fim: '2026-12-20' }); assert.equal(c.situacao, 'excesso'); assert.equal(c.nivel, 'vermelho'); assert.equal(c.folgas, 3); assert.equal(c.exigidas, 2);
  assert.equal(c.itens.find(i => i.codigo === 'folgas_semana_excesso').regra, 'Duas folgas por semana (5×2)'); assert.deepEqual(c.itens.find(i => i.codigo === 'folgas_semana_excesso').dias, ['2026-12-16', '2026-12-19', '2026-12-20']);
  // 1 e 2: quais folgas podem ser redistribuídas — a manual é protegida
  const cand = d => c.candidatos.find(x => x.data === d); assert.deepEqual(c.candidatos.map(x => x.data), ['2026-12-16', '2026-12-19', '2026-12-20']);
  assert.equal(cand('2026-12-16').protegido, true); assert.equal(cand('2026-12-16').viavel, false); assert.match(cand('2026-12-16').motivos[0], /ajuste manual \(preservado\)/); assert.equal(c.dias.find(d => d.data === '2026-12-16').protegido, 'ajuste manual (preservado)');
  // 10: tirar a folga do domingo emendaria com os seis dias da semana seguinte → descartada
  assert.equal(cand('2026-12-20').viavel, false); assert.ok(cand('2026-12-20').motivos.some(m => /criaria bloqueio na semana seguinte \(21\/12\)/.test(m)), JSON.stringify(cand('2026-12-20').motivos)); assert.ok(cand('2026-12-20').novosBloqueios.some(b => b.codigo === 'dias_consecutivos' && b.semana === '2026-12-21'));
  // 5 e 6: a opção segura é o sábado; a semana corrigida e as vizinhas são revalidadas
  assert.equal(cand('2026-12-19').viavel, true); assert.deepEqual(cand('2026-12-19').motivos, []); assert.equal(cand('2026-12-19').de, 'F'); assert.equal(cand('2026-12-19').para, '07:00–17:24');
  assert.deepEqual(c.sugestao.passos.map(p => [p.data, p.de, p.para]), [['2026-12-19', 'F', '07:00–17:24']]); assert.match(c.sugestao.resumo, /19\/12 \(sábado\): F → 07:00–17:24/);
  assert.deepEqual(c.sugestao.validacao.semana, { nivel: 'amarelo', folgas: 2, horas: '42h00', bloqueios: 0 }); assert.deepEqual(c.sugestao.validacao.adjacentes.map(a => a.inicio), ['2026-12-07', '2026-12-21']);
  assert.equal(c.podeAplicar, false, 'Coordenação vê a sugestão; quem aplica é o RH da unidade'); assert.equal(S.sugerirCorrecao(U.rh, 4, MES, 402, '2026-12-14', ctx4()).podeAplicar, true);
  // aplicar: só o RH Ponto da unidade, e só o que o servidor recalcular
  assert.throws(() => S.aplicarCorrecao(U.ger, 4, MES, ctx4(), { funcId: 402, semana: '2026-12-14' }), status(403)); assert.throws(() => S.aplicarCorrecao(U.rh2, 4, MES, ctx4(), { funcId: 402, semana: '2026-12-14' }), status(403));
  assert.throws(() => S.aplicarCorrecao(U.rh, 4, MES, ctx4(), { funcId: 402, semana: '2026-12-14', datas: ['2026-12-20'] }), e => e.status === 409 && e.desatualizada === true); assert.equal(arquivo(4), antes);
  const r = S.aplicarCorrecao(U.rh, 4, MES, ctx4(), { funcId: 402, semana: '2026-12-14', datas: ['2026-12-19'], justificativa: 'combinado com o funcionário' });
  assert.deepEqual(r.passos, [{ data: '2026-12-19', de: 'F', para: '07:00–17:24' }]); assert.equal(r.validacao.ok, true); assert.equal(r.validacao.folgas, 2);
  const e = E.ler(4, MES); const novo = e.dias['402|2026-12-19']; assert.equal(novo.tipo, 'trabalho'); assert.equal(novo.entrada, '07:00'); assert.equal(novo.origem, 'gerador', 'dia corrigido pelo motor não vira "ajuste à mão"'); assert.equal(novo.geracao, GID4);
  assert.equal(novo.correcao.processo, S.PROCESSO); assert.equal(novo.correcao.por, 'rh'); assert.equal(e.dias['402|2026-12-16'].tipo, 'folga', 'o ajuste manual do RH foi preservado'); assert.equal(e.dias['402|2026-12-16'].origem, undefined); assert.equal(e.dias['402|2026-12-20'].folga, 'rotativa');
  // 7: auditoria com antes e depois, usuário e processo, data/hora, justificativa e resultado da validação
  const a = ultimaAud('correcao_folgas'); assert.equal(a.seq, r.auditoria); assert.equal(a.processo, 'Motor de validação semanal 5×2'); assert.equal(a.usuario, 'rh'); assert.equal(a.confirmadoPor, 'rh'); assert.ok(!isNaN(Date.parse(a.em)));
  assert.equal(a.funcionario, 'Bruno Sá Atacarejo'); assert.equal(a.setor, 'FRENTE DE CAIXA'); assert.deepEqual(a.semana, { inicio: '2026-12-14', fim: '2026-12-20' });
  assert.equal(a.alteracoes.length, 1); assert.equal(a.alteracoes[0].antes.tipo, 'folga'); assert.equal(a.alteracoes[0].antes.folga, 'fixa'); assert.equal(a.alteracoes[0].depois.tipo, 'trabalho'); assert.equal(a.alteracoes[0].data, '2026-12-19');
  assert.match(a.justificativa, /semana de 14\/12 a 20\/12 com 3 folga\(s\) \(a regra pede 2\).*19\/12 \(sábado\): F → 07:00–17:24.*Observação do RH: combinado com o funcionário/); assert.equal(a.validacao.ok, true); assert.equal(a.validacao.adjacentes.length, 2); assert.equal(S.verificarCadeia().ok, true);
  const linha = S.trilha(U.co, { loja: 4, mes: MES }).registros.find(x => x.acao === 'correcao_folgas'); assert.match(linha.detalhe, /Bruno Sá Atacarejo.*semana 14\/12 a 20\/12.*processo: Motor de validação semanal 5×2.*confirmada por rh/); assert.equal(linha.alteracoes.length, 1);
  assert.equal(e.historico.slice(-1)[0].acao, 'correcao'); assert.equal(e.historico.slice(-1)[0].auditoria, a.seq);
  assert.ok(S.avisos(U.co).avisos.some(x => x.nivel === 'relevante' && x.tipo === 'imediato' && /aplicou a correção do motor de validação para Bruno Sá Atacarejo/.test(x.texto)));
  // a semana corrigida não tem mais o que corrigir
  const d = S.sugerirCorrecao(U.rh, 4, MES, 402, '2026-12-14', ctx4()); assert.equal(d.situacao, 'ok'); assert.equal(d.sugestao, null); assert.match(d.motivoSemSugestao, /folga a mais ou a menos/);
  assert.throws(() => S.aplicarCorrecao(U.rh, 4, MES, ctx4(), { funcId: 402, semana: '2026-12-14' }), e => e.status === 409 && /Não há correção segura/.test(e.message));
});

test('correção sugerida · 10. quando a única folga livre criaria conflito na semana seguinte, ou todas estão protegidas, o motor não propõe nada', () => {
  // Carla (403): quarta e sábado de folga à mão (protegidas) + rotativa no domingo; semana seguinte com seis dias de trabalho
  montar(4, 403, '2026-12-14', 'TTMTTMR', GID4); montar(4, 403, '2026-12-21', 'TTTTTTR', GID4); const antes = arquivo(4);
  const c = S.sugerirCorrecao(U.rh, 4, MES, 403, '2026-12-14', ctx4()); assert.equal(c.situacao, 'excesso'); assert.equal(c.sugestao, null); assert.match(c.motivoSemSugestao, /Nenhuma opção é segura.*decisão fica com o RH/);
  assert.deepEqual(c.candidatos.map(x => [x.data, x.viavel, !!x.protegido]), [['2026-12-16', false, true], ['2026-12-19', false, true], ['2026-12-20', false, false]]);
  assert.ok(c.candidatos[2].motivos.some(m => /semana seguinte \(21\/12\).*dia seguido de trabalho/.test(m)), JSON.stringify(c.candidatos[2].motivos));
  assert.throws(() => S.aplicarCorrecao(U.rh, 4, MES, ctx4(), { funcId: 403, semana: '2026-12-14' }), e => e.status === 409 && /Não há correção segura/.test(e.message)); assert.equal(arquivo(4), antes, 'nenhuma folga foi convertida em trabalho');
  // Davi (404): as três folgas da semana são ajustes do RH
  montar(4, 404, '2026-12-14', 'TMTMTTM', GID4); const t = S.sugerirCorrecao(U.rh, 4, MES, 404, '2026-12-14', ctx4());
  assert.equal(t.sugestao, null); assert.ok(t.candidatos.every(x => x.protegido && !x.viavel)); assert.match(t.motivoSemSugestao, /estão protegidos/);
  // a semana continua vermelha e a escala, não publicável
  assert.equal(S.portaPublicacao(4, MES, ctx4()).liberada, false);
});

test('correção sugerida · 3. uma folga só e 9. redistribuição que compromete a cobertura: a folga que falta não é dada no dia em que o setor fica descoberto', () => {
  const gid = gerarDezembro(6, ctx6, 'CCT Jardim Jordão (teste)'); const setor = E.ler(6, MES).funcionarios.find(f => f.id === 606).setor; assert.equal(setor, 'REPOSICAO');
  // Fábio (606, Reposição): só o sábado de folga na semana de 14/12; a quarta é um ajuste do RH (2 h de trabalho)
  montar(6, 606, '2026-12-14', 'TTmTTFT', gid);
  // a Reposição precisa dos 3 o dia inteiro: qualquer folga nova tira gente de onde já falta
  E.salvarConfig({ lojas: { 6: { setores: { 'FRENTE DE CAIXA': { min: 2 }, REPOSICAO: { min: 3 } } } } }, U.co); const antes = arquivo(6);
  const c = S.sugerirCorrecao(U.rh, 6, MES, 606, '2026-12-14', ctx6()); assert.equal(c.situacao, 'falta'); assert.equal(c.nivel, 'vermelho'); assert.equal(c.folgas, 1);
  assert.deepEqual(c.itens.find(i => i.codigo === 'folgas_semana_falta').dias, ['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18', '2026-12-20']);
  // não existe correção segura: o que o motor oferece é a opção de MENOR perda, com ressalva, que só vale com a ciência do RH
  assert.equal(c.sugestao.exigeCiencia, true); assert.equal(c.sugestao.passos.length, 1); assert.match(c.sugestao.ressalvas[0], /compromete a cobertura: Reposição perderia mais \d+ min de pessoa abaixo do mínimo/);
  const livres = c.candidatos.filter(x => !x.protegido); assert.deepEqual(livres.map(x => x.data), ['2026-12-14', '2026-12-15', '2026-12-17', '2026-12-18', '2026-12-20']); assert.equal(c.candidatos.find(x => x.data === '2026-12-16').protegido, true);
  for (const x of livres) { assert.equal(x.viavel, false); assert.ok(x.ressalvas.some(m => /compromete a cobertura: Reposição perderia mais \d+ min de pessoa abaixo do mínimo/.test(m)), x.data + ' ' + JSON.stringify(x)); assert.ok(x.cobertura.depoisMin > x.cobertura.antesMin); }
  const perda = x => x.cobertura.depoisMin - x.cobertura.antesMin; const escolhido = livres.find(x => x.data === c.sugestao.passos[0].data); assert.equal(perda(escolhido), Math.min(...livres.map(perda)), 'a proposta com ressalva é a que menos descobre o setor');
  assert.throws(() => S.aplicarCorrecao(U.rh, 6, MES, ctx6(), { funcId: 606, semana: '2026-12-14' }), e => e.status === 409 && e.exigeCiencia === 1 && /reduz a cobertura do setor/.test(e.message)); assert.equal(arquivo(6), antes, 'sem a ciência do RH nada é gravado');
  // quando o setor não fica descoberto (aqui, sem mínimo configurado) a correção é segura: o motor propõe a folga e a semana fecha em duas
  E.salvarConfig({ lojas: { 6: { setores: { 'FRENTE DE CAIXA': { min: 2 }, REPOSICAO: { min: 0 } } } } }, U.co);
  const d = S.sugerirCorrecao(U.rh, 6, MES, 606, '2026-12-14', ctx6()); assert.equal(d.sugestao.exigeCiencia, false); assert.deepEqual(d.sugestao.ressalvas, []); assert.equal(d.sugestao.passos.length, 1); assert.equal(d.sugestao.passos[0].para, 'FR'); assert.notEqual(d.sugestao.passos[0].data, '2026-12-16');
  assert.equal(d.sugestao.validacao.semana.folgas, 2); assert.equal(d.sugestao.validacao.semana.bloqueios, 0); assert.equal(d.sugestao.passos[0].cobertura.depoisMin, d.sugestao.passos[0].cobertura.antesMin, 'a folga proposta não aumenta o que falta de cobertura');
  const r = S.aplicarCorrecao(U.rh, 6, MES, ctx6(), { funcId: 606, semana: '2026-12-14' }); assert.equal(r.validacao.folgas, 2); assert.equal(r.validacao.ok, true);
  const e = E.ler(6, MES); assert.equal(e.dias['606|' + r.passos[0].data].folga, 'rotativa'); assert.equal(e.dias['606|2026-12-16'].entrada, '08:00', 'o ajuste do RH foi preservado'); assert.equal(ultimaAud('correcao_folgas').alteracoes[0].depois.tipo, 'folga'); assert.equal(ultimaAud('correcao_folgas').cienteCobertura, false);
  // com a ciência expressa do RH a opção de menor perda é aplicada, e a ressalva vai para a auditoria e para a Coordenação
  E.salvarConfig({ lojas: { 6: { setores: { 'FRENTE DE CAIXA': { min: 2 }, REPOSICAO: { min: 3 } } } } }, U.co); montar(6, 607, '2026-12-14', 'TTmTTFT', gid);
  const rc = S.aplicarCorrecao(U.rh, 6, MES, ctx6(), { funcId: 607, semana: '2026-12-14', cienteCobertura: true }); assert.equal(rc.validacao.folgas, 2);
  const ac = ultimaAud('correcao_folgas'); assert.equal(ac.cienteCobertura, true); assert.match(ac.ressalvas[0], /compromete a cobertura/); assert.match(ac.justificativa, /Aplicada com ressalva de cobertura, com a ciência do RH/); assert.ok(ac.cobertura[0].depoisMin > ac.cobertura[0].antesMin);
  assert.ok(S.avisos(U.co).avisos.some(x => x.nivel === 'relevante' && /REDUZ A COBERTURA/.test(x.texto)));
});

test('semanas vizinhas · alteração no domingo que estoura a semana seguinte é acusada, auditada e avisada à Coordenação', () => {
  // Eva (405): domingo 13/12 de folga rotativa e a semana de 14/12 com seis dias de trabalho
  montar(4, 405, '2026-12-07', 'TTTTTFR', GID4); montar(4, 405, '2026-12-14', 'TTTTTTR', GID4);
  const corpo = { funcId: 405, data: '2026-12-13', tipo: 'trabalho', entrada: '07:00', saida: '17:24', almoco_ini: '11:00', almoco_fim: '13:00', justificativa: 'cobrir falta no domingo' };
  E.editarDia(4, MES, U.rh, corpo, new Map()); const pos = S.aposEdicao(U.rh, 4, MES, corpo, 'rascunho', new Map());
  const viz = pos.validacao.adjacentes.find(a => a.inicio === '2026-12-14'); assert.ok(viz.novos.some(n => n.codigo === 'dias_consecutivos'), JSON.stringify(viz)); assert.equal(viz.nivel, 'vermelho');
  assert.deepEqual(pos.validacao.adjacentes.map(a => a.inicio), ['2026-11-30', '2026-12-14']); assert.deepEqual(pos.validacao.adjacentes[0].novos, []); assert.equal(pos.nivel, 'relevante');
  const a = ultimaAud('dia_alterar'); assert.ok(a.validacao.adjacentes.find(x => x.inicio === '2026-12-14').novos.length > 0); assert.equal(a.validacao.nivel, 'vermelho');
  assert.ok(S.avisos(U.co).avisos.some(x => x.nivel === 'relevante' && /alterou Eva Rocha Atacarejo em 13\/12 \(domingo\).*AFETOU A SEMANA DE 14\/12/.test(x.texto)));
});

test('semana contínua no serviço · 4. dois meses e 5. dois anos: 28/12/2026 a 03/01/2027 é a mesma semana vista de dezembro ou de janeiro', () => {
  // sem a grade de janeiro, a semana fecha pela previsão do motor
  const a0 = S.analiseBase(4, MES, ctx4()); assert.equal(a0.proximoMes, null); const hugo0 = a0.r.proposta.find(p => p.id === 408).semanas.find(s => s.inicio === '2026-12-28');
  assert.equal(hugo0.fim, '2027-01-03'); assert.deepEqual(hugo0.dias.slice(4).map(d => d.origem), ['previsto', 'previsto', 'previsto']); assert.equal(hugo0.regra52.folgas, 2);
  // nasce a grade de janeiro (jornada do contrato: sexta de trabalho, sábado e domingo de folga): os dias dela passam a fechar a semana
  E.criarDoPontoCerto(4, '2027-01', colabs4, escalasPC, U.rh); const a = S.analiseBase(4, MES, ctx4()); assert.equal(a.proximoMes, '2027-01');
  const jan = S.analiseBase(4, '2027-01', ctx4());
  for (const id of [406, 407, 408]) { const s = a.r.proposta.find(p => p.id === id).semanas.find(x => x.inicio === '2026-12-28'); const dezFolgas = ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31'].filter(d => E.diaDe(E.ler(4, MES), E.ler(4, MES).funcionarios.find(f => f.id === id), d, null).tipo === 'folga');
    assert.deepEqual(s.dias.map(d => d.data), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']); assert.deepEqual(s.dias.slice(4).map(d => [d.tipo, d.origem]), [['trabalho', 'fixo'], ['folga', 'fixo'], ['folga', 'fixo']]);
    assert.equal(s.regra52.folgas, dezFolgas.length + 2, 'as folgas de dezembro e de janeiro são somadas');
    // vista de janeiro, a semana é a mesma (identificada pela segunda 28/12) e a conta é a mesma
    const sj = jan.r.proposta.find(p => p.id === id).semanas[0]; assert.equal(sj.inicio, '2026-12-28'); assert.equal(sj.fim, '2027-01-03'); assert.equal(sj.regra52.folgas, s.regra52.folgas, 'dezembro e janeiro enxergam a mesma semana'); assert.deepEqual(sj.dias.map(d => d.tipo), s.dias.map(d => d.tipo));
    if (dezFolgas.length) { assert.equal(s.validacao.nivel, 'vermelho'); assert.deepEqual(s.validacao.itens.find(i => i.codigo === 'folgas_semana_excesso').dias, [...dezFolgas, '2027-01-02', '2027-01-03']);
      // a correção vista de dezembro só mexe em dezembro: os dias de janeiro pertencem à outra escala
      const c = S.sugerirCorrecao(U.rh, 4, MES, id, '2026-12-28', ctx4()); for (const d of ['2027-01-02', '2027-01-03']) { assert.equal(c.candidatos.find(x => x.data === d).protegido, true); assert.match(c.candidatos.find(x => x.data === d).motivos[0], /pertence a outro mês/); }
      if (c.sugestao) assert.ok(c.sugestao.passos.every(p => p.data.startsWith('2026-12'))); }
  }
  // a validação de uma alteração feita em janeiro olha a semana inteira, com os dias de dezembro
  const v = S.validacaoDaSemana(4, '2027-01', 408, '2027-01-02', ctx4()); assert.deepEqual(v.semana, { inicio: '2026-12-28', fim: '2027-01-03' }); assert.equal(v.folgas, a.r.proposta.find(p => p.id === 408).semanas.find(x => x.inicio === '2026-12-28').regra52.folgas);
});

// ═══ ETAPA 6 — modelo flexível de folgas no serviço: autorização de duas rotativas, folgas juntas pelo RH, menos alteração ═══
// Loja 2 (Muribeca) com quadro próprio; U.rh2 é o RH Ponto só dessa unidade.
const colabs2 = quadro(2, 200, 'Muribeca'); const ctx2 = extra => ({ colabs: colabs2, escalasPC, afast: new Map(), afastAnt: new Map(), hoje: HOJE, ponto: null, ...extra });
const diaDe2 = (id, d) => { const e = E.ler(2, MES); return E.diaDe(e, e.funcionarios.find(f => f.id === id), d, null); };

test('modelo flexível · duas folgas rotativas só com autorização do RH no cadastro; a regra nasce flexível e "preferir separadas" é opção da convenção', () => {
  const funcs = S.escalaDe(2, MES, ctx2()).e.funcionarios;
  assert.throws(() => S.salvarCadastro(U.ger, 2, funcs, [{ id: 201, duasRotativas: true }], 'autorizar duas rotativas'), status(403));
  assert.equal(S.cadastroLoja(2, funcs).find(f => f.id === 201).duasRotativas, false); assert.equal(S.cadastroLoja(2, funcs).find(f => f.id === 201).folgaOrigem, 'contrato');
  S.salvarCadastro(U.rh2, 2, funcs, [{ id: 201, duasRotativas: true }], 'Ana autorizada a ter as duas folgas rotativas (acordo individual)');
  const c = S.cadastroLoja(2, funcs).find(f => f.id === 201); assert.equal(c.duasRotativas, true); assert.equal(c.folga_fixa, null); assert.equal(c.folgaOrigem, 'duas_rotativas');
  const a = ultimaAud('cadastro'); assert.equal(a.usuario, 'rh2'); assert.equal(a.alteracoes[0].depois.duasRotativas, true); assert.ok(!a.alteracoes[0].antes.duasRotativas); assert.match(a.justificativa, /acordo individual/);
  // definir uma folga fixa depois tira a autorização (um modelo ou o outro)
  S.salvarCadastro(U.rh2, 2, funcs, [{ id: 202, duasRotativas: true }], 'teste do modelo'); S.salvarCadastro(U.rh2, 2, funcs, [{ id: 202, folga_fixa: 3 }], 'Bruno volta a ter folga fixa na quarta');
  const b = S.cadastroLoja(2, funcs).find(f => f.id === 202); assert.equal(b.duasRotativas, false); assert.equal(b.folga_fixa, 3); assert.equal(b.folgaOrigem, 'rh');
  // regra: o padrão é flexível; "preferir separadas" só se a convenção pedir
  const r = S.salvarRegra(U.rh, { ...regraBody, nome: 'CCT Muribeca (teste)', estabelecimento: 2 }); assert.equal(S.listarRegras().find(x => x.id === r.id).params.folgasConsecutivas, 'livre'); S.validarRegra(U.rh, r.id, 'Conferida a cláusula 12 da CCT 2026/2027');
  const sepr = S.salvarRegra(U.rh, { ...regraBody, nome: 'CCT com folgas separadas (teste)', estabelecimento: 2, categoria: 'CATEGORIA QUE NINGUEM TEM', params: { ...regraBody.params, folgasConsecutivas: 'evitar' } }); assert.equal(S.listarRegras().find(x => x.id === sepr.id).params.folgasConsecutivas, 'evitar');
  // simulação: Ana com duas rotativas, os demais com fixa + rotativa; juntas ou separadas, toda semana fecha em duas
  const s = S.simular(U.rh2, 2, MES, ctx2()); assert.equal(s.aplicacao.permitida, true, JSON.stringify(s.aplicacao.pendencias)); const ana = s.resultado.proposta.find(p => p.id === 201);
  assert.equal(ana.folgaModelo, 'duas_rotativas'); for (const w of ana.semanas.filter(x => x.inicio >= '2026-12-07' && x.fim <= '2026-12-27')) { assert.equal(w.regra52.rotativas, 2); assert.equal(w.regra52.fixas, 0); }
  assert.ok(!s.resultado.conflitos.operacionais.some(x => x.codigo === 'sem_folga_fixa'), 'quem tem autorização não fica pendente'); assert.equal(s.distribuicaoFolgas.pessoasDuasRotativas, 1); assert.equal(s.distribuicaoFolgas.pessoasSemModelo, 0);
  assert.equal(s.distribuicaoFolgas.consecutivas + s.distribuicaoFolgas.separadas, s.distribuicaoFolgas.semanas); assert.equal(s.duasFolgas.excesso + s.duasFolgas.falta, 0); assert.equal(s.resultado.validacaoSemanal.vermelho, 0); assert.equal(s.alteracoes, null);
  for (const p of s.resultado.proposta) for (const w of p.semanas) assert.equal(w.regra52.folgas, 2, p.nome + ' ' + w.inicio);
  S.aplicar(U.rh2, 2, MES, ctx2(), { justificativa: 'dezembro em 5x2 no modelo flexível', cienteDivergencias: true, assinatura: s.assinatura });
  assert.deepEqual(E.ler(2, MES).funcionarios.find(f => f.id === 201).folga_fixa, [], 'na grade, Ana fica sem folga fixa'); assert.deepEqual(E.ler(2, MES).funcionarios.find(f => f.id === 202).folga_fixa, [3]);
  const ap = ultimaAud('gerar_aplicar'); assert.equal(ap.distribuicaoFolgas.pessoasDuasRotativas, 1); assert.equal(ap.alteracoes, null); assert.equal(S.portaPublicacao(2, MES, ctx2()).liberada, true);
});

test('modelo flexível · o RH junta as duas folgas da semana e a escala continua válida; simular de novo mexe o mínimo na escala existente', () => {
  // simular de novo logo depois de aplicar: nada muda (a proposta repete a escala que já existe)
  const s0 = S.simular(U.rh2, 2, MES, ctx2()); assert.equal(s0.alteracoes.mudam, 0); assert.equal(s0.alteracoes.folgasMovidas, 0); assert.ok(s0.alteracoes.folgasMantidas > 50); assert.equal(s0.alteracoes.pessoas, 0);
  // Carla (203, folga fixa no sábado): o RH leva a rotativa da semana de 14/12 para a sexta 18/12, colada no sábado
  const sem = semanaDe('2026-12-14'); const rot = sem.find(d => diaDe2(203, d).tipo === 'folga' && diaDe2(203, d).folga === 'rotativa'); assert.ok(rot && rot !== '2026-12-18' && rot !== '2026-12-20', 'rotativa de Carla em dia útil: ' + rot);
  const ref = diaDe2(203, sem.find(d => diaDe2(203, d).tipo === 'trabalho'));
  const e1 = { funcId: 203, data: '2026-12-18', tipo: 'folga', justificativa: 'troca pedida pela funcionária: folga na sexta' }; E.editarDia(2, MES, U.rh2, e1, new Map()); const p1 = S.aposEdicao(U.rh2, 2, MES, e1, 'rascunho', new Map());
  assert.equal(p1.validacao.folgas, 3); assert.equal(p1.validacao.ok, false, 'no meio da troca a semana fica com três folgas: a alteração é gravada e acusada');
  const e2 = { funcId: 203, data: rot, tipo: 'trabalho', entrada: ref.entrada, saida: ref.saida, almoco_ini: ref.almoco_ini, almoco_fim: ref.almoco_fim, justificativa: 'troca pedida pela funcionária: trabalha no dia da rotativa' }; E.editarDia(2, MES, U.rh2, e2, new Map()); const p2 = S.aposEdicao(U.rh2, 2, MES, e2, 'rascunho', new Map());
  assert.equal(p2.validacao.ok, true, JSON.stringify(p2.validacao.bloqueios)); assert.equal(p2.validacao.folgas, 2); assert.equal(p2.validacao.situacao, 'ok'); assert.notEqual(p2.validacao.nivel, 'vermelho');
  const w = S.analiseBase(2, MES, ctx2()).r.proposta.find(p => p.id === 203).semanas.find(x => x.inicio === '2026-12-14');
  assert.deepEqual(w.dias.filter(d => d.tipo === 'folga').map(d => d.data), ['2026-12-18', '2026-12-19'], 'sexta e sábado juntas'); assert.equal(w.regra52.consecutivas, true); assert.equal(w.trabalho, 5); assert.ok(!w.validacao.itens.some(i => i.gravidade === 'bloqueio'));
  assert.equal(S.portaPublicacao(2, MES, ctx2()).liberada, true, 'folgas juntas não bloqueiam a publicação'); assert.equal(ultimaAud('dia_alterar').validacao.ok, true); assert.equal(ultimaAud('dia_alterar').usuario, 'rh2');
  // simular de novo: os dois dias ajustados à mão ficam como estão e o resto da escala quase não muda — nada muda no outro setor
  const s1 = S.simular(U.rh2, 2, MES, ctx2()); const carla = s1.resultado.proposta.find(p => p.id === 203);
  assert.equal(carla.dias['2026-12-18'].travado, true); assert.equal(carla.dias['2026-12-18'].tipo, 'folga'); assert.equal(carla.dias[rot].travado, true); assert.equal(carla.semanas.find(x => x.inicio === '2026-12-14').regra52.folgas, 2);
  assert.ok(s1.alteracoes.comparados > 200); assert.ok(s1.alteracoes.mudam <= s1.alteracoes.comparados * 0.1, 'mudam ' + s1.alteracoes.mudam + ' de ' + s1.alteracoes.comparados + ' dias');
  for (const p of s1.resultado.proposta.filter(x => x.setor === 'REPOSICAO')) for (const [d, x] of Object.entries(p.dias)) assert.equal(x.tipo, diaDe2(p.id, d).tipo, p.nome + ' ' + d + ': o outro setor não tem motivo para mudar');
  assert.equal(s1.duasFolgas.excesso + s1.duasFolgas.falta, 0); assert.equal(s1.aplicacao.permitida, true, JSON.stringify(s1.aplicacao.pendencias));
});

// ═══ ETAPA 7 — revezamento dominical feminino 1×1: configuração avançada por unidade, informação legal e auditoria ═══
// Loja 10 (CD). No "ponto": 1001–1004 mulheres, 1005–1007 homens, 1008 sem o sexo preenchido.
const colabs10 = quadro(10, 1000, 'CD'); colabs10.ativos.forEach((c, i) => { c.sexo = i < 4 ? 'F' : i < 7 ? 'M' : null; });
const ctx10 = extra => ({ colabs: colabs10, escalasPC, afast: new Map(), afastAnt: new Map(), hoje: HOJE, ponto: null, ...extra });
const DOMS_DEZ = ['2026-12-06', '2026-12-13', '2026-12-20', '2026-12-27'];
const seqDom = p => DOMS_DEZ.map(d => p.dias[d].tipo === 'trabalho' ? 'T' : p.dias[d].tipo === 'folga' ? 'F' : 'A').join('');

test('dominical feminino · configuração avançada: desligada por padrão, texto legal sempre disponível, só usuário autorizado altera, tudo auditado', () => {
  const funcs = S.escalaDe(10, MES, ctx10()).e.funcionarios; assert.equal(funcs.find(f => f.id === 1001).sexo, 'F', 'o sexo vem do cadastro do ponto quando existe'); assert.equal(funcs.find(f => f.id === 1008).sexo, null);
  // desligada por padrão; a informação legal vem com a regra desligada, para quem só consulta também
  assert.deepEqual(S.dominicalLoja(10), { ativo: false, por: null, porNome: null, em: null, justificativa: null });
  const v = S.avancadas(U.di, 10, funcs, colabs10); const D = v.dominical; assert.equal(v.podeAlterar, false, 'Diretoria só consulta'); assert.equal(D.ativo, false);
  assert.equal(D.nome, 'Revezamento dominical feminino — 1×1'); assert.equal(D.titulo, 'Fundamentação legal — Art. 386 da CLT');
  assert.equal(D.citacao, 'Havendo trabalho aos domingos, será organizada uma escala de revezamento quinzenal, que favoreça o repouso dominical.');
  assert.equal(D.origem, 'Decreto-Lei nº 5.452/1943 — Consolidação das Leis do Trabalho, art. 386, na seção de proteção ao trabalho da mulher.');
  assert.equal(D.aplicacao, 'o revezamento quinzenal é operacionalizado por alternância entre um domingo trabalhado e outro de descanso, observadas as demais normas aplicáveis.');
  assert.equal(D.importante, 'desativar esta opção não afasta a obrigação de cumprir a legislação trabalhista.'); assert.equal(D.linkTxt, 'Consultar legislação oficial'); assert.equal(D.link, 'https://www.planalto.gov.br/ccivil_03/decreto-lei/del5452compilado.htm');
  assert.deepEqual([D.mulheres, D.homens, D.semSexo], [4, 3, 1]); assert.equal(S.avancadas(U.co, 10, funcs, colabs10).podeAlterar, true); assert.equal(S.avancadas(U.rh, 10, funcs, colabs10).podeAlterar, true);
  assert.throws(() => S.avancadas(U.ger, 10, funcs, colabs10), status(403), 'gerente de outra loja não vê a unidade');
  // só RH Ponto da unidade ou Coordenação; sempre com justificativa
  const liga = { ativo: true, justificativa: 'Coordenação decidiu aplicar o revezamento quinzenal às trabalhadoras do CD' };
  assert.throws(() => S.salvarDominical(U.di, 10, funcs, colabs10, liga), status(403)); assert.throws(() => S.salvarDominical(U.rh2, 10, funcs, colabs10, liga), status(403), 'RH de outra unidade'); assert.throws(() => S.salvarDominical(U.ger, 10, funcs, colabs10, liga), status(403));
  assert.throws(() => S.salvarDominical(U.rh, 10, funcs, colabs10, { ativo: 'sim', justificativa: liga.justificativa }), /ativada ou desativada/); assert.throws(() => S.salvarDominical(U.rh, 10, funcs, colabs10, { ativo: true, justificativa: 'ok' }), /mínimo de 10/);
  assert.throws(() => S.salvarDominical(U.rh, 10, funcs, colabs10, { ativo: false, justificativa: 'desligar o que já está desligado' }), status(409)); assert.equal(S.dominicalLoja(10).ativo, false);
  // desligada: o gerador não impõe o 1×1, a verificação do art. 386 continua e a proposta em desacordo não é aplicada
  const r10 = S.salvarRegra(U.rh, { ...regraBody, nome: 'CCT CD (teste)', estabelecimento: 10 }); S.validarRegra(U.rh, r10.id, 'Conferida a cláusula 12 da CCT 2026/2027');
  const s0 = S.simular(U.rh, 10, MES, ctx10()); assert.equal(s0.dominical.ativo, false); assert.equal(s0.dominical.alternando, 0); assert.equal(s0.dominical.mulheres, 4); assert.equal(s0.dominical.semSexo, 1);
  assert.ok(s0.dominical.violacoes > 0, 'pela regra geral alguma trabalhadora fica com dois domingos seguidos'); assert.ok(s0.resultado.conflitos.trabalhistas.filter(c => c.codigo === 'domingo_art386').every(c => c.gravidade === 'bloqueio' && c.funcId <= 1004));
  assert.ok(s0.aplicacao.pendencias.some(p => p.codigo === 'domingo_art386' && /ative o revezamento dominical feminino 1×1/.test(p.texto))); assert.equal(s0.aplicacao.permitida, false);
  assert.ok(s0.resultado.conflitos.operacionais.some(c => c.codigo === 'sexo_nao_informado' && /1 funcionário\(s\) sem o sexo informado \(Hugo Paz CD\)/.test(c.texto)));
  assert.throws(() => S.aplicar(U.rh, 10, MES, ctx10(), { justificativa: 'dezembro em 5x2 no CD', cienteDivergencias: true }), status(409)); assert.equal(E.ler(10, MES), null);
  // ativação: fica na auditoria com usuário, data e hora, unidade, antes/depois e quem a regra alcança; a Coordenação é avisada
  const r = S.salvarDominical(U.rh, 10, funcs, colabs10, liga); assert.equal(r.dominical.ativo, true); assert.equal(r.dominical.por, 'rh'); assert.equal(r.dominical.citacao, D.citacao); assert.deepEqual(r.escalas, [], 'nenhuma escala em aberto para regravar');
  const a = ultimaAud('dominical_feminino'); assert.equal(a.seq, r.auditoria); assert.equal(a.usuario, 'rh'); assert.equal(a.nome, 'RH Ponto'); assert.ok(!isNaN(Date.parse(a.em))); assert.equal(a.loja, 10); assert.equal(a.antes.ativo, false); assert.equal(a.depois.ativo, true);
  assert.deepEqual(a.alcance, { mulheres: 4, homens: 3, semSexo: 1 }); assert.equal(a.justificativa, liga.justificativa); assert.match(a.alteracoesNasEscalas, /Nenhum dia é regravado ao ativar/); assert.equal(S.verificarCadeia().ok, true);
  assert.equal(S.dominicalLoja(10).ativo, true); assert.equal(S.dominicalLoja(1).ativo, false, 'o interruptor é por unidade'); assert.equal(S.dominicalLoja(2).ativo, false);
  assert.ok(S.avisos(U.co).avisos.some(x => x.nivel === 'relevante' && x.tipo === 'imediato' && /ATIVOU o revezamento dominical feminino 1×1 \(4 trabalhadora\(s\) identificada\(s\), 1 funcionário\(s\) sem o sexo informado\)/.test(x.texto)));
  assert.match(S.trilha(U.co, { loja: 10 }).registros.find(x => x.acao === 'dominical_feminino').detalhe, /ATIVADO · 4 trabalhadora\(s\), 1 sem o sexo informado · nenhuma escala em aberto/);
});

test('dominical feminino · ativado: sexo informado pelo RH, alternância 1×1 em dezembro (com a semana que vem de novembro) e aplicação auditada', () => {
  // com a regra ativa, quem não tem o sexo informado trava a aplicação até o RH informar
  const s1 = S.simular(U.rh, 10, MES, ctx10()); assert.equal(s1.dominical.ativo, true); assert.equal(s1.dominical.alternando, 4); assert.deepEqual(s1.dominical.semSexoIds, [1008]);
  assert.ok(s1.aplicacao.pendencias.some(p => p.codigo === 'sexo_nao_informado')); assert.equal(s1.aplicacao.permitida, false);
  const funcs = S.escalaDe(10, MES, ctx10()).e.funcionarios;
  assert.throws(() => S.salvarCadastro(U.rh, 10, funcs, [{ id: 1008, sexo: 'X' }], 'sexo informado pelo RH'), /Sexo inválido/);
  S.salvarCadastro(U.rh, 10, funcs, [{ id: 1008, sexo: 'F' }], 'Hugo Paz CD: cadastro conferido com a ficha de admissão');
  const cad = S.cadastroLoja(10, funcs, colabs10); assert.deepEqual([cad.find(f => f.id === 1008).sexo, cad.find(f => f.id === 1008).sexoOrigem], ['F', 'rh']); assert.deepEqual([cad.find(f => f.id === 1001).sexo, cad.find(f => f.id === 1001).sexoOrigem], ['F', 'ponto']);
  assert.deepEqual([cad.find(f => f.id === 1005).sexo, cad.find(f => f.id === 1005).sexoOrigem], ['M', 'ponto']); assert.equal(ultimaAud('cadastro').alteracoes[0].depois.sexo, 'F');
  const s = S.simular(U.rh, 10, MES, ctx10()); assert.equal(s.aplicacao.permitida, true, JSON.stringify(s.aplicacao.pendencias)); assert.deepEqual([s.dominical.mulheres, s.dominical.semSexo, s.dominical.alternando, s.dominical.violacoes], [5, 0, 5, 0]);
  const mulheres = [1001, 1002, 1003, 1004, 1008].map(id => s.resultado.proposta.find(p => p.id === id));
  for (const p of mulheres) { assert.ok(['TFTF', 'FTFT'].includes(seqDom(p)), p.nome + ': ' + seqDom(p)); for (const w of p.semanas) { assert.equal(w.regra52.folgas, 2, p.nome + ' ' + w.inicio); assert.notEqual(w.validacao.nivel, 'vermelho'); } }
  // a semana 30/11–06/12 atravessa o mês: 29/11 (novembro) foi descanso para todas; metade trabalha em 06/12 e metade começa pelo descanso
  for (const d of DOMS_DEZ) assert.equal([1001, 1002, 1003, 1004].filter(id => s.resultado.proposta.find(p => p.id === id).dias[d].tipo === 'folga').length, 2, 'trabalhadoras do Caixa de folga em ' + d);
  assert.equal(mulheres[0].semanas[0].inicio, '2026-11-30'); assert.ok(!s.resultado.conflitos.trabalhistas.some(c => c.codigo === 'domingo_art386'));
  for (const p of s.resultado.proposta.filter(x => x.sexo === 'M')) assert.equal(p.dominical1x1, false);
  const g = S.aplicar(U.rh, 10, MES, ctx10(), { justificativa: 'dezembro em 5x2 no CD com revezamento dominical feminino', cienteDivergencias: true, assinatura: s.assinatura });
  const ap = ultimaAud('gerar_aplicar'); assert.deepEqual(ap.dominicalFeminino, { ativo: true, mulheres: 5, alternando: 5, semSexo: 0 }); assert.equal(ap.ref, g.geracao.id); assert.equal(S.portaPublicacao(10, MES, ctx10()).liberada, true);
  assert.equal(S.analisar(U.co, 10, MES, ctx10()).dominical.violacoes, 0);
});

test('dominical feminino · desativado: a desativação é auditada com a situação das escalas, o 1×1 deixa de ser imposto e a verificação legal continua bloqueando', () => {
  const funcs = E.ler(10, MES).funcionarios; const antes = fs.readFileSync(path.join(process.env.ESCALAS_DIR, '10-' + MES + '.json'), 'utf8');
  const r = S.salvarDominical(U.co, 10, funcs, colabs10, { ativo: false, justificativa: 'Decisão da Coordenação: o RH passa a montar o domingo manualmente' });
  assert.equal(r.dominical.ativo, false); assert.equal(fs.readFileSync(path.join(process.env.ESCALAS_DIR, '10-' + MES + '.json'), 'utf8'), antes, 'desativar não regrava nenhum dia da escala');
  const a = ultimaAud('dominical_feminino'); assert.equal(a.usuario, 'co'); assert.equal(a.antes.ativo, true); assert.equal(a.antes.por, 'rh'); assert.equal(a.depois.ativo, false); assert.equal(a.loja, 10);
  assert.deepEqual(a.escalas.map(x => [x.mes, x.violacoesArt386]), [[MES, 0]], 'retrato da escala em aberto: a que já está alternada continua de acordo'); assert.ok(a.escalas[0].diasDoGerador > 100); assert.match(a.alteracoesNasEscalas, /ao desativar/);
  assert.ok(S.avisos(U.co).avisos.some(x => /DESATIVOU o revezamento dominical feminino 1×1/.test(x.texto))); assert.match(S.trilha(U.co, { loja: 10 }).registros.find(x => x.acao === 'dominical_feminino').detalhe, /DESATIVADO.*12\/2026 \(sem pendência dominical\)/);
  // o texto legal continua disponível com a regra desligada
  assert.equal(S.avancadas(U.co, 10, funcs, colabs10).dominical.importante, 'desativar esta opção não afasta a obrigação de cumprir a legislação trabalhista.');
  // a escala que já está de acordo continua publicável; a verificação não depende do interruptor
  assert.equal(S.portaPublicacao(10, MES, ctx10()).liberada, true);
  // o RH põe a Ana (1001) para trabalhar num domingo de descanso que vem logo depois de um domingo trabalhado: bloqueio pelo art. 386
  const ana = E.ler(10, MES).funcionarios.find(f => f.id === 1001); const dia = d => E.diaDe(E.ler(10, MES), ana, d, null); const i = DOMS_DEZ.findIndex((d, k) => k > 0 && dia(d).tipo === 'folga' && dia(DOMS_DEZ[k - 1]).tipo === 'trabalho'); assert.ok(i > 0);
  const ref = dia(DOMS_DEZ[i - 1]); const corpo = { funcId: 1001, data: DOMS_DEZ[i], tipo: 'trabalho', entrada: ref.entrada, saida: ref.saida, almoco_ini: ref.almoco_ini, almoco_fim: ref.almoco_fim, justificativa: 'cobrir o domingo' };
  E.editarDia(10, MES, U.rh, corpo, new Map()); const pos = S.aposEdicao(U.rh, 10, MES, corpo, 'rascunho', new Map());
  assert.equal(pos.validacao.ok, false); assert.ok(pos.validacao.bloqueios.some(b => b.codigo === 'domingo_art386' && /art\. 386 da CLT/.test(b.texto)), JSON.stringify(pos.validacao.bloqueios)); assert.equal(pos.nivel, 'relevante');
  const p = S.portaPublicacao(10, MES, ctx10()); assert.equal(p.liberada, false); assert.ok(p.bloqueios.some(c => c.codigo === 'domingo_art386' && c.funcId === 1001));
  assert.throws(() => S.exigirPublicavel(U.co, 10, MES, ctx10(), 'aprovar'), e => e.status === 409 && /não pode ser aprovada/.test(e.message)); assert.ok(S.analisar(U.co, 10, MES, ctx10()).dominical.violacoes >= 1, 'o domingo alterado (e o seguinte, se também for de trabalho) ficam acusados');
  // e, desativada, o gerador não reorganiza os domingos das demais para o 1×1
  const s = S.simular(U.rh, 10, MES, ctx10()); assert.equal(s.dominical.ativo, false); assert.equal(s.dominical.alternando, 0); assert.ok(s.resultado.proposta.every(x => x.dominical1x1 === false));
});
