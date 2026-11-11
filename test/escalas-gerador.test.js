'use strict';
// Testes do motor do Gerador 5×2 (lib/escalas-gerador.js). Tudo em memória: sem arquivo, sem rede, sem PontoCerto.
// Calendário usado: 01/11/2026 é domingo; 30/11/2026 é segunda (a semana 30/11–06/12 atravessa o mês).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/escalas-gerador');
const { soma, dow, segunda } = G._util;

const J44 = { entrada: '07:00', saida: '17:48', almoco_ini: '11:00', almoco_fim: '13:00' };          // 8h48 × 5 = 44 h (contrato do ponto)
const base44 = () => ({ 0: null, 1: { ...J44 }, 2: { ...J44 }, 3: { ...J44 }, 4: { ...J44 }, 5: { ...J44 }, 6: null });
const func = (id, setor, folga, extra) => ({ id, nome: 'Func ' + id, setor, estabelecimento: 1, categoria: 'COMERCIARIO', folga_fixa: folga, base: base44(), ...extra });
const equipe = () => [func(1, 'CAIXA', 1), func(2, 'CAIXA', 2), func(3, 'CAIXA', 3), func(4, 'CAIXA', 4), func(5, 'CAIXA', 5), func(6, 'CAIXA', 3), func(7, 'REPOSICAO', 2), func(8, 'REPOSICAO', 4), func(9, 'REPOSICAO', 3)];
const COB = { abre: '07:00', fecha: '19:00', entradas: ['07:00', '08:36'], setores: { CAIXA: { min: 2 }, REPOSICAO: { min: 1 } } };
const REGRA_OK = { id: 'CCT-TESTE', estabelecimento: 1, vigencia: { de: '2026-01-01', ate: '2027-12-31' }, validada: true, params: {} };
const NOV = { de: '2026-11-01', ate: '2026-11-30' }, DEZ = { de: '2026-12-01', ate: '2026-12-31' };
const tipos = (p, datas) => datas.map(d => (p.dias[d] || {}).tipo);
const semana = seg => [0, 1, 2, 3, 4, 5, 6].map(i => soma(seg, i));
const maiorSequencia = dias => { let m = 0, r = 0; for (const d of Object.keys(dias).sort()) { if (dias[d].tipo === 'trabalho') { r++; if (r > m) m = r; } else r = 0; } return m; };

test('mês cheio: toda semana completa tem 5 dias de trabalho e 2 folgas, 42 h, intervalo de 2 h e folga fixa respeitada', () => {
  const r = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  assert.strictEqual(r.modo, 'simulacao'); assert.strictEqual(r.proposta.length, 9);
  for (const p of r.proposta) {
    for (const s of p.semanas.filter(x => x.completa)) { assert.strictEqual(s.trabalho, 5, p.nome + ' ' + s.inicio); assert.strictEqual(s.folgas, 2); assert.strictEqual(s.minutos, 42 * 60); }
    for (const [d, x] of Object.entries(p.dias)) {
      if (x.tipo === 'trabalho') { assert.strictEqual(x.minutos, 504); assert.strictEqual(G._util.min(x.almoco_fim) - G._util.min(x.almoco_ini), 120); assert.strictEqual(G._util.min(x.saida) - G._util.min(x.entrada), 504 + 120); }
      if (dow(d) === p.folga_fixa[0]) { assert.strictEqual(x.tipo, 'folga', p.nome + ' trabalhou na folga fixa ' + d); assert.strictEqual(x.folga, 'fixa'); }
    }
    assert.strictEqual(Object.keys(p.dias).length, 30);
  }
  assert.strictEqual(r.indicadores.pct_semanas_5x2, 100);
  assert.strictEqual(r.conflitos.trabalhistas.length, 0, JSON.stringify(r.conflitos.trabalhistas));
});

test('folga rotativa gira de uma semana para a outra e as folgas não ficam coladas quando há alternativa', () => {
  const r = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  for (const p of r.proposta) {
    const rot = Object.entries(p.dias).filter(([, x]) => x.folga === 'rotativa').map(([d]) => dow(d));
    assert.ok(new Set(rot).size >= 2, p.nome + ' ficou sempre com a mesma folga rotativa: ' + rot);
    for (let i = 1; i < rot.length; i++) assert.notStrictEqual(rot[i], rot[i - 1], p.nome + ' repetiu a rotativa em semanas seguidas');
  }
  // única colagem aceitável: quem tem folga fixa na segunda e chega ao domingo obrigatório (não existe alternativa)
  for (const p of r.proposta) for (const d of Object.keys(p.dias)) { const prox = p.dias[soma(d, 1)]; if (p.dias[d].tipo === 'folga' && prox && prox.tipo === 'folga') { assert.strictEqual(p.id, 1, p.nome + ' com folgas coladas em ' + d); assert.strictEqual(dow(d), 0); } }
  assert.ok(r.indicadores.folgas_consecutivas <= 2);
});

test('semana que atravessa o mês: novembro → dezembro mantém o 5×2 e nunca passa de 6 dias seguidos', () => {
  const nov = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  const dez = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: nov.continuidade });
  assert.strictEqual(dez.semanas[0].inicio, '2026-11-30'); assert.strictEqual(dez.semanas[0].cruzaPeriodo, true);
  for (const p of dez.proposta) {
    const n = nov.proposta.find(x => x.id === p.id); const tudo = { ...n.dias, ...p.dias };
    assert.strictEqual(p.dias['2026-11-30'], undefined, 'dezembro não pode regravar o dia 30/11');
    const t = semana('2026-11-30').map(d => tudo[d].tipo);
    assert.strictEqual(t.filter(x => x === 'trabalho').length, 5, p.nome + ': ' + t); assert.strictEqual(t.filter(x => x === 'folga').length, 2);
    assert.ok(maiorSequencia(tudo) <= 6, p.nome + ' com ' + maiorSequencia(tudo) + ' dias seguidos');
    // a última semana de dezembro (28/12–03/01) fica aberta: os dias de janeiro saem só como previsão, fora da proposta
    assert.strictEqual(p.dias['2027-01-01'], undefined); assert.ok(dez.continuidade[p.id].semanaAberta['2027-01-01']);
  }
  assert.strictEqual(dez.conflitos.trabalhistas.length, 0, JSON.stringify(dez.conflitos.trabalhistas));
  assert.ok(!dez.conflitos.operacionais.some(c => c.codigo === 'historico_ausente'));
});

test('sem histórico, a semana que atravessa o mês é sinalizada como conflito operacional (não trabalhista)', () => {
  const dez = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  assert.strictEqual(dez.conflitos.operacionais.filter(c => c.codigo === 'historico_ausente').length, 9);
  assert.ok(!dez.conflitos.trabalhistas.some(c => c.codigo === 'historico_ausente'));
});

test('férias são preservadas: nenhum dia de férias vira trabalho ou folga e a semana parcial fica proporcional', () => {
  const eq = equipe(); eq[0].ausencias = [{ inicio: '2026-11-10', fim: '2026-11-19', tipo: 'ferias' }];
  const r = G.gerar({ ...NOV, funcionarios: eq, regras: [REGRA_OK], cobertura: COB }); const p = r.proposta.find(x => x.id === 1);
  for (let d = '2026-11-10'; d <= '2026-11-19'; d = soma(d, 1)) { assert.strictEqual(p.dias[d].tipo, 'ferias', d); assert.strictEqual(p.dias[d].origem, 'ausencia'); }
  const s1 = p.semanas.find(s => s.inicio === '2026-11-09');   // só a segunda 09/11 disponível, e é a folga fixa
  assert.strictEqual(s1.ausencias, 6); assert.strictEqual(s1.trabalho, 0); assert.strictEqual(s1.folgas, 1);
  const s2 = p.semanas.find(s => s.inicio === '2026-11-16');   // férias de segunda a quinta; sobram sexta, sábado e domingo
  assert.strictEqual(s2.ausencias, 4); assert.strictEqual(s2.folgas, 1); assert.strictEqual(s2.trabalho, 2);
  assert.strictEqual(p.semanas.find(s => s.inicio === '2026-11-23').trabalho, 5);
  assert.strictEqual(r.conflitos.trabalhistas.length, 0, JSON.stringify(r.conflitos.trabalhistas));
});

test('afastamento no mês inteiro: tudo afastado, sem jornada, sem conflito trabalhista e fora da cobertura', () => {
  const eq = equipe(); eq[6].ausencias = [{ inicio: '2026-10-15', fim: '2026-12-20', tipo: 'afastado' }];
  const r = G.gerar({ ...NOV, funcionarios: eq, regras: [REGRA_OK], cobertura: COB }); const p = r.proposta.find(x => x.id === 7);
  assert.deepStrictEqual([...new Set(Object.values(p.dias).map(x => x.tipo))], ['afastado']); assert.strictEqual(p.minutos, 0);
  assert.ok(!r.conflitos.trabalhistas.some(c => c.funcId === 7));
  assert.strictEqual(r.cobertura.dias[2].setores.find(s => s.setor === 'REPOSICAO').ausentes, 1);
});

test('admissão no meio do mês: dias anteriores não entram na escala', () => {
  const eq = equipe(); eq[1].admissao = '2026-11-18';
  const p = G.gerar({ ...NOV, funcionarios: eq, regras: [REGRA_OK], cobertura: COB }).proposta.find(x => x.id === 2);
  assert.strictEqual(p.dias['2026-11-17'], undefined); assert.ok(p.dias['2026-11-18']);
});

test('domingos: ninguém trabalha mais de 2 domingos seguidos (regra de 3 semanas), inclusive na virada do mês', () => {
  const nov = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  const dez = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: nov.continuidade });
  for (const n of nov.proposta) {
    const tudo = { ...n.dias, ...dez.proposta.find(x => x.id === n.id).dias }; let run = 0, max = 0;
    for (const d of Object.keys(tudo).sort()) { if (dow(d) !== 0) continue; if (tudo[d].tipo === 'trabalho') { run++; max = Math.max(max, run); } else run = 0; }
    assert.ok(max <= 2, n.nome + ' com ' + max + ' domingos seguidos'); assert.ok(n.domingosTrabalhados >= 1, n.nome + ' deveria trabalhar algum domingo (domingo faz parte da semana regular)');
  }
  assert.ok(!nov.conflitos.trabalhistas.some(c => c.codigo === 'domingo_sem_folga'));
  const d = nov.domingosFeriados.filter(x => x.tipo === 'domingo'); assert.strictEqual(d.length, nov.indicadores.domingos_trabalhados); assert.ok(d.length > 0);
  assert.strictEqual(d[0].tratamento, 'conforme_convencao');   // pagamento/compensação não é decidido pelo motor
});

test('histórico de descanso dominical: quem vem de 2 domingos trabalhados folga no primeiro domingo', () => {
  const hist = { 3: { domingosTrabalhadosSeguidos: 2 } };
  const r = G.gerar({ de: '2026-11-02', ate: '2026-11-29', funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: hist });
  assert.strictEqual(r.proposta.find(x => x.id === 3).dias['2026-11-08'].tipo, 'folga');
});

test('regra por categoria: domingo alternado (folga a cada 2 semanas) vale só para quem a regra alcança', () => {
  const eq = equipe(); eq[0].categoria = 'QUINZENAL';
  const regras = [REGRA_OK, { id: 'CCT-QUINZ', estabelecimento: 1, categoria: 'QUINZENAL', vigencia: { de: '2026-01-01' }, validada: true, params: { domingo: { folgaACadaSemanas: 2 } } }];
  const r = G.gerar({ ...NOV, funcionarios: eq, regras, cobertura: COB }); const p = r.proposta.find(x => x.id === 1);
  assert.strictEqual(p.regraId, 'CCT-QUINZ'); assert.strictEqual(r.proposta.find(x => x.id === 2).regraId, 'CCT-TESTE');
  const doms = Object.keys(p.dias).filter(d => dow(d) === 0).sort().map(d => p.dias[d].tipo);
  for (let i = 1; i < doms.length; i++) assert.ok(!(doms[i] === 'trabalho' && doms[i - 1] === 'trabalho'), 'dois domingos seguidos: ' + doms);
});

test('regras: vale a vigente mais específica; fora da vigência cai nos parâmetros de fábrica, não validados', () => {
  const f = { empresa: 'CAHU', estabelecimento: 1, categoria: 'COMERCIARIO' };
  const regras = [{ id: 'EMP', empresa: 'CAHU', vigencia: { de: '2026-01-01', ate: '2026-12-31' }, validada: true, params: { metaSemanalMin: 2400 } },
    { id: 'EST', empresa: 'CAHU', estabelecimento: 1, vigencia: { de: '2026-06-01', ate: '2026-12-31' }, validada: false, params: { intervaloMin: 60 } },
    { id: 'OUTRA', estabelecimento: 2, vigencia: {}, validada: true }];
  assert.strictEqual(G.regraPara(regras, f, '2026-03-01').id, 'EMP'); assert.strictEqual(G.regraPara(regras, f, '2026-03-01').params.metaSemanalMin, 2400);
  const e = G.regraPara(regras, f, '2026-07-01'); assert.strictEqual(e.id, 'EST'); assert.strictEqual(e.validada, false); assert.strictEqual(e.params.intervaloMin, 60); assert.strictEqual(e.params.metaSemanalMin, 2520);
  const p = G.regraPara(regras, f, '2027-02-01'); assert.strictEqual(p.padrao, true); assert.strictEqual(p.validada, false); assert.strictEqual(p.params.metaSemanalMin, 2520);
});

test('publicação nunca é liberada: simulação, regra não validada, divergência contratual 44 h × 42 h', () => {
  const semRegra = G.gerar({ ...NOV, funcionarios: equipe(), cobertura: COB });
  assert.strictEqual(semRegra.publicacao.liberada, false);
  assert.deepStrictEqual(semRegra.publicacao.bloqueios.map(b => b.codigo), ['motor_em_simulacao', 'regra_nao_validada', 'divergencia_contratual']);
  const comRegra = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  assert.strictEqual(comRegra.publicacao.liberada, false); assert.ok(!comRegra.publicacao.bloqueios.some(b => b.codigo === 'regra_nao_validada'));
  assert.strictEqual(comRegra.divergenciasContratuais.length, 9);
  const d = comRegra.divergenciasContratuais[0]; assert.strictEqual(d.validacaoRH, 'pendente');
  const carga = d.itens.find(i => i.campo === 'carga_semanal'); assert.strictEqual(carga.contratual, '44h00'); assert.strictEqual(carga.planejado, '42h00'); assert.strictEqual(carga.diferencaMin, -120);
  assert.ok(d.itens.some(i => i.campo === 'domingo'), 'domingo fora do contrato precisa aparecer para o RH');
  assert.ok(!d.itens.some(i => i.campo === 'intervalo'));   // contrato já tem 2 h
  const eq = equipe(); for (const d2 of [1, 2, 3, 4, 5]) Object.assign(eq[0].base[d2], { almoco_ini: '11:00', almoco_fim: '12:00' });
  assert.ok(G.gerar({ ...NOV, funcionarios: eq, regras: [REGRA_OK], cobertura: COB }).divergenciasContratuais.find(x => x.funcId === 1).itens.some(i => i.campo === 'intervalo'));
});

test('conflitos separados: falta de cobertura é operacional; excesso de dias seguidos é trabalhista', () => {
  const r = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: { ...COB, setores: { CAIXA: { min: 6 }, REPOSICAO: { min: 1 } } } });
  assert.ok(r.conflitos.operacionais.some(c => c.codigo === 'cobertura_abaixo' && /CAIXA/.test(c.texto)));
  assert.ok(r.conflitos.operacionais.every(c => c.tipo === 'operacional')); assert.ok(r.conflitos.trabalhistas.every(c => c.tipo === 'trabalhista'));
  assert.ok(!r.conflitos.trabalhistas.some(c => c.codigo === 'cobertura_abaixo')); assert.ok(r.cobertura.resumo.dias_com_deficit > 0);
  // dias travados (escala já publicada) forçando 7 dias seguidos na semana de 09/11: o motor não mexe neles e acusa o conflito
  const trav = {}; for (const d of semana('2026-11-09')) trav['1|' + d] = { tipo: 'trabalho', entrada: '07:00', saida: '17:24', almoco_ini: '11:00', almoco_fim: '13:00', setor: 'CAIXA' };
  const t = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: trav });
  const cods = t.conflitos.trabalhistas.filter(c => c.funcId === 1).map(c => c.codigo);
  assert.ok(cods.includes('dias_consecutivos'), cods.join()); assert.ok(cods.includes('mais_dias_que_o_previsto')); assert.ok(cods.includes('carga_semanal'));
  assert.ok(t.publicacao.bloqueios.some(b => b.codigo === 'conflito_trabalhista'));
});

test('dias travados (publicados ou ajustados à mão) nunca são sobrescritos e o resto da semana se ajusta a eles', () => {
  const trav = { '2|2026-11-12': { tipo: 'folga', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: 'CAIXA' }, '2|2026-11-13': { tipo: 'trabalho', entrada: '09:00', saida: '19:24', almoco_ini: '13:00', almoco_fim: '15:00', setor: 'CAIXA' } };
  const copia = JSON.parse(JSON.stringify(trav));
  const r = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: trav }); const p = r.proposta.find(x => x.id === 2);
  assert.strictEqual(p.dias['2026-11-12'].tipo, 'folga'); assert.strictEqual(p.dias['2026-11-12'].travado, true);
  assert.strictEqual(p.dias['2026-11-13'].entrada, '09:00'); assert.strictEqual(p.dias['2026-11-13'].travado, true);
  const s = p.semanas.find(x => x.inicio === '2026-11-09'); assert.strictEqual(s.folgas, 2); assert.strictEqual(s.trabalho, 5);   // quinta travada + folga fixa de terça
  assert.deepStrictEqual(trav, copia);
});

test('restrições individuais: dia da semana e data bloqueados viram folga; horário respeita o limite de saída', () => {
  const eq = equipe(); eq[4].restricoes = { naoTrabalha: [6], saidaMax: '16:00' }; eq[7].restricoes = { datasBloqueadas: ['2026-11-11'] };
  const r = G.gerar({ ...NOV, funcionarios: eq, regras: [REGRA_OK], cobertura: COB }); const p = r.proposta.find(x => x.id === 5);
  for (const [d, x] of Object.entries(p.dias)) { if (dow(d) === 6) assert.strictEqual(x.tipo, 'folga'); if (x.tipo === 'trabalho') assert.ok(G._util.min(x.saida) <= 16 * 60, x.saida); }
  assert.strictEqual(r.proposta.find(x => x.id === 8).dias['2026-11-11'].tipo, 'folga');
});

test('cobertura e pico: o intervalo é escalonado e o reforço de pico aparece como necessidade por faixa', () => {
  const r = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  const dia = '2026-11-04'; const almocos = r.proposta.filter(p => p.setor === 'CAIXA' && p.dias[dia].tipo === 'trabalho').map(p => p.dias[dia].almoco_ini);
  assert.ok(new Set(almocos).size >= 2, 'todo o caixa almoçando junto: ' + almocos);
  const c = r.cobertura.dias.find(x => x.data === dia).setores.find(s => s.setor === 'CAIXA'); assert.strictEqual(c.minimo, 2); assert.strictEqual(c.blocos_abaixo, 0); assert.strictEqual(c.escalados + c.folgas + c.ausentes, 6);
  const pico = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: { ...COB, setores: { CAIXA: { min: 2, faixas: [{ dias: [6], ini: '10:00', fim: '13:00', min: 9 }] }, REPOSICAO: { min: 1 } } } });
  const sab = pico.cobertura.dias.find(x => x.data === '2026-11-07').setores.find(s => s.setor === 'CAIXA');
  assert.strictEqual(sab.minimo, 9); assert.ok(sab.blocos_abaixo > 0); assert.strictEqual(sab.faixas_abaixo[0], '10:00–13:00'); assert.strictEqual(sab.pior.necessario, 9);
  // reforço: com pico no sábado, o motor tira as folgas rotativas do sábado e põe o caixa inteiro para trabalhar
  for (const d of ['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28']) { const s = pico.cobertura.dias.find(x => x.data === d).setores.find(x => x.setor === 'CAIXA'); assert.strictEqual(s.escalados, 6, d); assert.strictEqual(s.folgas, 0, d); }
  assert.ok(pico.conflitos.operacionais.some(c => c.codigo === 'cobertura_abaixo' && c.ref === 'CAIXA|2026-11-07'));
  // intervalo nunca cai fora da janela (2 h depois de entrar, 1 h antes de sair), nem depois do reparo de cobertura
  for (const p of r.proposta) for (const x of Object.values(p.dias)) if (x.tipo === 'trabalho') { assert.ok(G._util.min(x.almoco_ini) - G._util.min(x.entrada) >= 120, JSON.stringify(x)); assert.ok(G._util.min(x.saida) - G._util.min(x.almoco_fim) >= 60, JSON.stringify(x)); }
});

test('contrato com entrada diferente por dia (caso real da E2): a entrada do dia seguinte é adiada e a interjornada de 11 h fica de pé', () => {
  const eq = equipe(); eq[2].base[4] = { entrada: '09:30', saida: '19:30', almoco_ini: '13:00', almoco_fim: '15:00' }; for (const d of [1, 2, 5, 6]) eq[2].base[d] = { entrada: '06:40', saida: '16:40', almoco_ini: '11:00', almoco_fim: '13:00' };
  const r = G.gerar({ ...NOV, funcionarios: eq, regras: [REGRA_OK], cobertura: { abre: '07:00', fecha: '19:00', setores: { CAIXA: { min: 1 } } } }); const p = r.proposta.find(x => x.id === 3);
  assert.ok(!r.conflitos.trabalhistas.some(c => c.funcId === 3), JSON.stringify(r.conflitos.trabalhistas));
  const dias = Object.keys(p.dias).sort(); let adiadas = 0;
  for (let i = 1; i < dias.length; i++) { const a = p.dias[dias[i - 1]], b = p.dias[dias[i]]; if (a.tipo !== 'trabalho' || b.tipo !== 'trabalho') continue; assert.ok(1440 - G._util.min(a.saida) + G._util.min(b.entrada) >= 660, dias[i] + ' ' + a.saida + ' → ' + b.entrada); if (b.ajuste === 'descanso') adiadas++; }
  assert.ok(adiadas > 0); assert.ok(r.conflitos.operacionais.some(c => c.codigo === 'entrada_adiada' && c.funcId === 3));
});

test('várias unidades de uma vez: cada loja com o próprio quadro, cobertura e resultado', () => {
  const l2 = equipe().slice(0, 4).map(f => ({ ...f, id: 200 + f.id, estabelecimento: 2 }));
  const r = G.gerarUnidades({ ...NOV, regras: [REGRA_OK], unidades: [{ loja: 1, funcionarios: equipe(), cobertura: COB }, { loja: 2, funcionarios: l2, cobertura: COB }] });
  assert.deepStrictEqual(Object.keys(r.unidades), ['1', '2']); assert.strictEqual(r.unidades[1].proposta.length, 9); assert.strictEqual(r.unidades[2].proposta.length, 4);
  assert.ok(r.unidades[2].publicacao.bloqueios.some(b => b.codigo === 'regra_nao_validada'));   // a regra de teste só alcança o estabelecimento 1
  assert.strictEqual(r.publicacao.liberada, false);
});

test('motor isolado: determinístico, não altera a entrada e não usa arquivo, rede nem os módulos do sistema', () => {
  const ent = { ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: { 1: { domingosTrabalhadosSeguidos: 1 } } }; const antes = JSON.stringify(ent);
  const a = G.gerar(ent), b = G.gerar(ent);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b)); assert.strictEqual(JSON.stringify(ent), antes);
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'escalas-gerador.js'), 'utf8');
  assert.ok(!/require\(/.test(fonte), 'o motor não pode carregar nenhum módulo'); assert.ok(!/fetch\(|writeFile|appendFile/.test(fonte));
  assert.throws(() => G.gerar({ de: '2026-11-30', ate: '2026-11-01', funcionarios: [] }), /Período inválido/);
  assert.strictEqual(segunda('2026-11-11'), '2026-11-09');
});
