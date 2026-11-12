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
  E.editarDia(1, MES, U.ger, { funcId: 105, data: '2026-12-29', tipo: 'trabalho', entrada: '07:30', saida: '17:54', almoco_ini: '11:30', almoco_fim: '13:30' }); S.aposEdicao(U.ger, 1, MES, { funcId: 105, data: '2026-12-29' }, 'rascunho');
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
