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
const SEG = { de: '2026-11-02', ate: '2026-11-29' };   // quatro semanas inteiras, começando numa segunda (sem semana de transição)
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

test('folga rotativa gira de uma semana para a outra; com a convenção pedindo folgas separadas (não é mais o padrão) elas não ficam coladas quando há alternativa', () => {
  // Etapa 6: o padrão passou a ser o modelo flexível. "Preferir separadas" continua existindo como parâmetro da regra.
  const r = G.gerar({ ...NOV, funcionarios: equipe(), regras: [{ ...REGRA_OK, params: { folgasConsecutivas: 'evitar' } }], cobertura: COB });
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
  // novembro começa num domingo sem histórico da semana: desde a Etapa 3 isso também bloqueia (semana de transição sem dados)
  assert.deepStrictEqual(semRegra.publicacao.bloqueios.map(b => b.codigo), ['motor_em_simulacao', 'regra_nao_validada', 'divergencia_contratual', 'transicao_sem_dados']);
  assert.deepStrictEqual(G.gerar({ ...SEG, funcionarios: equipe(), cobertura: COB }).publicacao.bloqueios.map(b => b.codigo), ['motor_em_simulacao', 'regra_nao_validada', 'divergencia_contratual']);
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
  assert.ok(cods.includes('dias_consecutivos'), cods.join()); assert.ok(cods.includes('folgas_semana_falta'), 'Etapa 4: semana de 7 dias de trabalho = nenhuma folga (antes saía como mais_dias_que_o_previsto)'); assert.ok(cods.includes('carga_semanal'));
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

test('semana da virada com dia já fixo mais longo: os dias gerados encurtam para a semana caber no limite (caso real da E2)', () => {
  const hist = { 4: { dias: { '2026-11-29': { tipo: 'folga' }, '2026-11-30': { tipo: 'trabalho', entrada: '07:00', saida: '19:00', almoco_ini: '12:00', almoco_fim: '13:00' } } } };   // segunda de 11 h no contrato antigo
  const r = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: hist }); const p = r.proposta.find(x => x.id === 4);
  const s = p.semanas[0]; assert.strictEqual(s.inicio, '2026-11-30'); assert.ok(s.minutos <= 44 * 60, s.horas); assert.strictEqual(s.trabalho, 5);
  assert.ok(!r.conflitos.trabalhistas.some(c => c.funcId === 4), JSON.stringify(r.conflitos.trabalhistas.filter(c => c.funcId === 4)));
  assert.ok(r.conflitos.operacionais.some(c => c.codigo === 'jornada_reduzida' && c.funcId === 4)); assert.strictEqual(p.semanas[1].minutos, 42 * 60, 'a semana seguinte volta às 42 h');
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

// ═══ ETAPA 3 ═══════════════════════════════════════════════════════════════════════════════════════════
const M = G._util.min;
const INTERVALO = ['intervalo_ausente', 'intervalo_insuficiente', 'intervalo_excedente', 'intervalo_fora_da_jornada', 'trabalho_continuo', 'intervalo_na_borda', 'pausa_nao_prevista'];
const doIntervalo = (r, id) => r.conflitos.trabalhistas.filter(c => INTERVALO.includes(c.codigo) && (id == null || c.funcId === id));
const trav = (id, data, entrada, saida, ai, af) => ({ [id + '|' + data]: { tipo: 'trabalho', entrada, saida, almoco_ini: ai || null, almoco_fim: af || null, setor: 'CAIXA' } });
const T = (entrada, saida, ai, af) => ({ tipo: 'trabalho', entrada: entrada || '07:00', saida: saida || '17:24', almoco_ini: ai === undefined ? '11:00' : ai, almoco_fim: af === undefined ? '13:00' : af, fonte: 'ponto' });
const F = { tipo: 'folga', fonte: 'ponto' };

// 1. INTERVALOS ────────────────────────────────────────────────────────────────────────────────────────
test('intervalo · jornada regular: o dia gerado nunca passa de 6 h seguidas antes ou depois do intervalo, mesmo escalonando e reparando a cobertura', () => {
  // caso real da Ponte: entrada 08:00 com intervalo contratual às 13:00 — o escalonamento antigo jogava o intervalo para as 15:00 (7 h seguidas)
  const J8 = { entrada: '08:00', saida: '18:48', almoco_ini: '13:00', almoco_fim: '15:00' };
  const eq = equipe().map(f => ({ ...f, base: { 0: null, 1: { ...J8 }, 2: { ...J8 }, 3: { ...J8 }, 4: { ...J8 }, 5: { ...J8 }, 6: null } }));
  for (const [funcionarios, cobertura] of [[equipe(), COB], [eq, { ...COB, entradas: ['07:00', '08:00', '09:00'] }]]) {
    const r = G.gerar({ ...SEG, funcionarios, regras: [REGRA_OK], cobertura }); let dias = 0;
    for (const p of r.proposta) for (const [d, x] of Object.entries(p.dias)) { if (x.tipo !== 'trabalho') continue; dias++;
      const antes = M(x.almoco_ini) - M(x.entrada), depois = M(x.saida) - M(x.almoco_fim);
      assert.ok(antes <= 360 && depois <= 360, p.nome + ' ' + d + ': ' + JSON.stringify(x)); assert.ok(antes >= 120 && depois >= 60, JSON.stringify(x));
      assert.strictEqual(M(x.almoco_fim) - M(x.almoco_ini), 120); }
    assert.ok(dias > 150); assert.deepStrictEqual(doIntervalo(r), []);
    assert.ok(new Set(r.proposta.filter(p => p.setor === 'CAIXA').map(p => (p.dias['2026-11-04'] || {}).almoco_ini).filter(Boolean)).size >= 2, 'o intervalo continua escalonado');
  }
});

test('intervalo · dia já fixo na grade é validado: ausente, insuficiente, excedente, fora da jornada, 7 h seguidas e colado na borda', () => {
  const D = '2026-11-10';   // terça
  const travados = { ...trav(1, D, '07:00', '16:00'),                       // 9 h sem intervalo
    ...trav(3, D, '07:00', '16:30', '11:00', '11:30'),                       // 9 h com 30 min
    ...trav(4, D, '07:00', '18:00', '11:00', '14:00'),                       // intervalo de 3 h
    ...trav(5, D, '07:00', '17:24', '14:00', '16:00'),                       // 7 h seguidas antes do intervalo (o caso da simulação da Ponte)
    ...trav(6, D, '07:00', '14:00', '07:30', '08:30'),                       // intervalo meia hora depois de entrar
    ...trav(7, D, '07:00', '17:24', '06:00', '08:00'),                       // intervalo começa antes da entrada
    ...trav(8, D, '07:00', '17:24', '11:00', '13:00') };                     // regular
  const r = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados });
  const um = id => { const l = doIntervalo(r, id).filter(c => c.ref === D); assert.strictEqual(l.length, 1, id + ': ' + JSON.stringify(l)); return l[0]; };
  assert.strictEqual(um(1).codigo, 'intervalo_ausente'); assert.strictEqual(um(1).gravidade, 'bloqueio'); assert.match(um(1).texto, /9h00.*sem intervalo/);
  assert.strictEqual(um(3).codigo, 'intervalo_insuficiente'); assert.match(um(3).texto, /0h30.*mínimo 1h00/);
  assert.strictEqual(um(4).codigo, 'intervalo_excedente'); assert.match(um(4).texto, /3h00.*máximo 2h00/);
  assert.strictEqual(um(5).codigo, 'trabalho_continuo'); assert.strictEqual(um(5).gravidade, 'bloqueio'); assert.match(um(5).texto, /7h00 seguidas antes do intervalo/);
  assert.strictEqual(um(6).codigo, 'intervalo_na_borda'); assert.strictEqual(um(6).gravidade, 'alerta');
  assert.strictEqual(um(7).codigo, 'intervalo_fora_da_jornada');
  assert.deepStrictEqual(doIntervalo(r, 8), []); assert.deepStrictEqual(doIntervalo(r, 2), []);
  assert.ok(r.publicacao.bloqueios.some(b => b.codigo === 'conflito_trabalhista'));
  // o que já aconteceu antes do período (histórico) não é "validado" como se fosse proposta
  const h = G.gerar({ de: '2026-11-11', ate: '2026-11-29', funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: { 1: { dias: { '2026-11-09': F, '2026-11-10': T('07:00', '16:00', null, null) } } } });
  assert.deepStrictEqual(doIntervalo(h, 1), []);
});

test('intervalo · situações excepcionais: jornada curta, pausa de 15 min e regra convencional diferente da CLT', () => {
  const D = '2026-11-10';
  const travados = { ...trav(1, D, '07:00', '11:00'),                        // 4 h: não exige intervalo
    ...trav(3, D, '07:00', '12:00'),                                         // 5 h sem a pausa de 15 min registrada
    ...trav(4, D, '07:00', '13:15', '10:00', '10:15'),                       // 6 h com 15 min
    ...trav(5, D, '07:00', '16:30', '11:00', '11:30'),                       // 30 min em 9 h: só passa se a convenção permitir
    ...trav(6, D, '07:00', '17:24', '14:00', '16:00') };                     // 7 h seguidas: só passa se a convenção permitir
  const clt = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados });
  assert.deepStrictEqual(doIntervalo(clt, 1), []); assert.deepStrictEqual(doIntervalo(clt, 4), []);
  const pausa = doIntervalo(clt, 3); assert.strictEqual(pausa.length, 1); assert.strictEqual(pausa[0].codigo, 'pausa_nao_prevista'); assert.strictEqual(pausa[0].gravidade, 'alerta');
  assert.strictEqual(doIntervalo(clt, 5)[0].codigo, 'intervalo_insuficiente'); assert.strictEqual(doIntervalo(clt, 6)[0].codigo, 'trabalho_continuo');
  // a regra do funcionário manda: convenção com intervalo mínimo de 30 min e até 7 h seguidas
  const cct = { ...REGRA_OK, id: 'CCT-30', params: { intervalo: { minimoMin: 30, continuoMaxMin: 420 } } };
  const conv = G.gerar({ ...SEG, funcionarios: equipe(), regras: [cct], cobertura: COB, travados });
  assert.deepStrictEqual(doIntervalo(conv, 5), []); assert.deepStrictEqual(doIntervalo(conv, 6), []);
  assert.strictEqual(G.regraPara([cct], equipe()[0], D).params.intervalo.maximoMin, 120, 'o que a regra não informa continua no padrão');
  // regra só da categoria: vale para quem ela alcança, os outros seguem no padrão
  const eq = equipe(); eq[4].categoria = 'ACOUGUEIRO';
  const mista = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK, { ...cct, categoria: 'ACOUGUEIRO' }], cobertura: COB, travados });
  assert.deepStrictEqual(doIntervalo(mista, 5), []); assert.strictEqual(doIntervalo(mista, 6)[0].codigo, 'trabalho_continuo');
  // intervalo planejado de 1 h: os dias gerados saem válidos; planejado abaixo do mínimo da própria regra é acusado em todo dia gerado
  const umaHora = G.gerar({ ...SEG, funcionarios: equipe(), regras: [{ ...REGRA_OK, params: { intervaloMin: 60 } }], cobertura: COB });
  assert.deepStrictEqual(doIntervalo(umaHora), []);
  for (const p of umaHora.proposta) for (const x of Object.values(p.dias)) if (x.tipo === 'trabalho') { assert.strictEqual(M(x.almoco_fim) - M(x.almoco_ini), 60); assert.ok(M(x.almoco_ini) - M(x.entrada) <= 360 && M(x.saida) - M(x.almoco_fim) <= 360, JSON.stringify(x)); }
  const errada = G.gerar({ ...SEG, funcionarios: equipe(), regras: [{ ...REGRA_OK, params: { intervaloMin: 30 } }], cobertura: COB });
  assert.ok(doIntervalo(errada).length > 100); assert.ok(doIntervalo(errada).every(c => c.codigo === 'intervalo_insuficiente'));
});

// 2. SEMANA DE TRANSIÇÃO ───────────────────────────────────────────────────────────────────────────────
const QUI = { de: '2026-11-05', ate: '2026-11-29' };   // começa na quinta: 02, 03 e 04/11 vêm do histórico
const semAnt = () => ({ '2026-10-26': T(), '2026-10-27': T(), '2026-10-28': T(), '2026-10-29': T(), '2026-10-30': T(), '2026-10-31': F, '2026-11-01': F });
const histQui = mapa => { const h = {}; for (const f of equipe()) { const [a, b, c] = mapa[f.id] || [T(), T(), F]; h[f.id] = { dias: { ...semAnt(), '2026-11-02': a, '2026-11-03': b, '2026-11-04': c } }; } return h; };

test('transição · começo no meio da semana: consulta o histórico, preserva os registros, não repete folga e fecha a semana em 5×2', () => {
  const historico = histQui({ 1: [F, T(), T()],      // folga fixa de segunda já gozada: falta 1 folga
    2: [T(), F, F],                                   // as duas folgas da semana já gozadas
    3: [T(), T(), T()],                               // trabalhou os 3 dias (inclusive na folga fixa de quarta): deve 2 folgas
    4: [F, F, T()] });                                // já descansou 2 dias e a folga fixa é quinta: não repete
  const copia = JSON.stringify(historico);
  const r = G.gerar({ ...QUI, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico });
  assert.strictEqual(JSON.stringify(historico), copia, 'o histórico não pode ser alterado');
  assert.strictEqual(r.transicao.necessaria, true); assert.deepStrictEqual(r.transicao.semana, { inicio: '2026-11-02', fim: '2026-11-08' }); assert.strictEqual(r.transicao.pendentes, 0);
  assert.ok(!r.publicacao.bloqueios.some(b => b.codigo === 'transicao_sem_dados')); assert.deepStrictEqual(r.conflitos.trabalhistas, []);
  for (const p of r.proposta) {
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04']) assert.strictEqual(p.dias[d], undefined, 'registro anterior ao início não entra na proposta');
    const s = p.semanas[0]; assert.strictEqual(s.inicio, '2026-11-02'); assert.strictEqual(s.trabalho, 5, p.nome); assert.strictEqual(s.folgas, 2, p.nome);
    const t = r.transicao.funcionarios.find(x => x.funcId === p.id); assert.strictEqual(t.situacao, 'ok'); assert.strictEqual(t.descansos + t.folgasPropostas, 2, p.nome + ': folga duplicada ou faltando'); assert.ok(t.dias.every(x => x.confirmado && x.fonte === 'ponto'));
  }
  const fol = id => ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].filter(d => r.proposta.find(p => p.id === id).dias[d].tipo === 'folga');
  assert.strictEqual(fol(1).length, 1); assert.deepStrictEqual(fol(2), []); assert.strictEqual(fol(3).length, 2);
  assert.deepStrictEqual(fol(4), [], 'já tinha descansado 2 dias: a folga fixa de quinta não se repete');
  assert.ok(r.conflitos.operacionais.some(c => c.codigo === 'folga_fixa_ja_gozada' && c.funcId === 4 && c.ref === '2026-11-05'));
  for (const p of r.proposta) for (const s of p.semanas.slice(1)) { assert.strictEqual(s.trabalho, 5); assert.strictEqual(s.folgas, 2); assert.strictEqual(s.minutos, 2520); }   // depois da transição, 5×2 normal
});

test('transição · sem dados suficientes: dia indefinido, não confirmado ou ausente bloqueia a publicação e não é contado como folga', () => {
  const INDEF = { tipo: 'indefinido', fonte: 'ponto' };
  const historico = histQui({ 1: [T(), INDEF, T()], 2: [{ ...T(), fonte: 'escala', naoConfirmado: true }, F, T()] }); delete historico[3];
  const r = G.gerar({ ...QUI, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico });
  const t = id => r.transicao.funcionarios.find(x => x.funcId === id);
  assert.strictEqual(t(1).situacao, 'dados_insuficientes'); assert.deepStrictEqual(t(1).pendentes, ['2026-11-03']);
  assert.strictEqual(t(1).descansos, 0); assert.strictEqual(t(1).folgasPropostas, 2, 'ausência de marcação não é folga: as duas folgas continuam devidas');
  assert.deepStrictEqual(t(2).pendentes, ['2026-11-02']); assert.deepStrictEqual(t(3).pendentes, ['2026-11-02', '2026-11-03', '2026-11-04']); assert.strictEqual(t(3).dias[0].tipo, 'sem_dado');
  assert.strictEqual(r.transicao.pendentes, 3); assert.strictEqual(r.transicao.diasPendentes, 5);
  const b = r.publicacao.bloqueios.find(x => x.codigo === 'transicao_sem_dados'); assert.ok(b); assert.match(b.texto, /3 funcionário\(s\).*02\/11 a 04\/11/);
  assert.strictEqual(r.conflitos.operacionais.filter(c => c.codigo === 'transicao_dados_insuficientes').length, 3);
  assert.ok(!r.conflitos.trabalhistas.some(c => c.codigo === 'dias_consecutivos'));
  // o indefinido vale como "pode ter trabalhado": com 5 dias seguidos antes (26–30/10 + 02/11) ninguém passa de 6 contando com ele
  const p1 = r.proposta.find(p => p.id === 1); assert.ok(['2026-11-05', '2026-11-06', '2026-11-07'].some(d => p1.dias[d].tipo === 'folga'));
  // o RH valida os dias pendentes (ou o ponto passa a confirmar): o bloqueio some
  const ok = histQui({ 1: [T(), { tipo: 'folga', fonte: 'rh' }, T()], 2: [T(), F, T()] });
  const r2 = G.gerar({ ...QUI, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: ok });
  assert.strictEqual(r2.transicao.pendentes, 0); assert.ok(!r2.publicacao.bloqueios.some(x => x.codigo === 'transicao_sem_dados')); assert.strictEqual(r2.transicao.funcionarios.find(x => x.funcId === 1).folgasPropostas, 1);
  // começando numa segunda não existe semana de transição; dia incerto da semana anterior só vira aviso
  const seg = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: { 1: { dias: { ...semAnt(), '2026-10-31': INDEF } } } });
  assert.strictEqual(seg.transicao.necessaria, false); assert.deepStrictEqual(seg.transicao.funcionarios, []); assert.ok(!seg.publicacao.bloqueios.some(x => x.codigo === 'transicao_sem_dados'));
  assert.ok(seg.conflitos.operacionais.some(c => c.codigo === 'historico_nao_confirmado' && c.funcId === 1));
});

test('transição · valida pelas regras trabalhistas: excesso que já vem do registro anterior é herdado (alerta), a proposta não agrava e nunca passa de 6 dias seguidos', () => {
  // início no domingo 01/11: a semana 26–31/10 já aconteceu. Func 1 trabalhou os 6 dias (52h48); os demais, 5 dias + 1 folga.
  const J = () => T('07:00', '17:48');   // 8h48
  const historico = {}; for (const f of equipe()) { const d = { '2026-10-25': F }; ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'].forEach((x, i) => { d[x] = f.id === 1 || i !== 2 ? J() : F; }); historico[f.id] = { dias: d }; }
  const r = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico });
  const meus = r.conflitos.trabalhistas.filter(c => c.funcId === 1);
  assert.deepStrictEqual(meus.map(c => c.codigo).sort(), ['carga_semanal', 'mais_dias_que_o_previsto']);
  for (const c of meus) { assert.strictEqual(c.herdado, true); assert.strictEqual(c.transicao, true); assert.strictEqual(c.gravidade, 'alerta'); assert.match(c.texto, /já ocorrido antes do início/); }
  assert.strictEqual(r.proposta.find(p => p.id === 1).dias['2026-11-01'].tipo, 'folga', 'com 6 dias já trabalhados o domingo tem que ser descanso');
  assert.strictEqual(r.transicao.funcionarios.find(t => t.funcId === 1).situacao, 'conflito_herdado'); assert.strictEqual(r.transicao.herdados, 1);
  assert.ok(!r.publicacao.bloqueios.some(b => b.codigo === 'conflito_trabalhista'), 'o que é herdado não trava a proposta');
  for (const p of r.proposta) assert.ok(maiorSequencia({ ...historico[p.id].dias, ...p.dias }) <= 6, p.nome);
  // já o excesso causado por dia fixo DENTRO do período continua sendo bloqueio
  const dentro = G.gerar({ ...NOV, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: { ...historico, 1: { dias: { ...historico[2].dias, '2026-10-28': J() } } }, travados: { '1|2026-11-01': { tipo: 'trabalho', entrada: '07:00', saida: '17:24', almoco_ini: '11:00', almoco_fim: '13:00', setor: 'CAIXA' } } });
  assert.ok(dentro.conflitos.trabalhistas.some(c => c.funcId === 1 && c.gravidade === 'bloqueio' && !c.herdado));
  // regra com no máximo 2 dias seguidos: o motor acrescenta folga em vez de entregar semana irregular
  const r2 = G.gerar({ ...SEG, funcionarios: equipe(), regras: [{ ...REGRA_OK, params: { maxDiasConsecutivos: 2 } }], cobertura: COB });
  assert.ok(!r2.conflitos.trabalhistas.some(c => c.codigo === 'dias_consecutivos')); assert.ok(r2.conflitos.operacionais.some(c => c.codigo === 'folga_extra_descanso'));
  for (const p of r2.proposta) assert.ok(maiorSequencia(p.dias) <= 2, p.nome);
});

// 3. PESOS OPERACIONAIS POR DIA ────────────────────────────────────────────────────────────────────────
const rotativasEm = (r, dias, setor) => r.proposta.filter(p => !setor || p.setor === setor).reduce((t, p) => t + Object.entries(p.dias).filter(([d, x]) => x.folga === 'rotativa' && dias.includes(dow(d))).length, 0);

test('pesos por dia · sexta e sábado mais pesados: a folga rotativa prefere os dias de menor movimento, respeitando folga fixa, descanso e 5×2', () => {
  const sem = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  const com = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: { ...COB, pesoDia: { 5: 3, 6: 3 } } });
  assert.deepStrictEqual(sem.pesos.diasPesados, []); assert.deepStrictEqual(com.pesos.diasPesados, [5, 6]);
  const a = rotativasEm(sem, [5, 6]), b = rotativasEm(com, [5, 6]);
  assert.ok(a >= 6, 'sem peso o motor espalha rotativas na sexta e no sábado: ' + a); assert.ok(b <= a * 0.7, 'com peso: ' + b + ' (sem: ' + a + ')'); assert.strictEqual(com.pesos.folgasEmDiaPesado, b);
  assert.deepStrictEqual(com.conflitos.trabalhistas, []); assert.strictEqual(com.indicadores.pct_semanas_5x2, 100);
  for (const p of com.proposta) {
    for (const [d, x] of Object.entries(p.dias)) if (dow(d) === p.folga_fixa[0]) assert.strictEqual(x.folga, 'fixa', p.nome + ' ' + d);   // peso não mexe em folga fixa (a de sexta continua)
    assert.ok(maiorSequencia(p.dias) <= 6); assert.ok(p.domingosFolga >= 1, p.nome + ' sem domingo de folga');
  }
  // distribuição equilibrada: a folga que sobra em dia pesado roda entre as pessoas, não cai sempre na mesma
  assert.ok(com.pesos.maiorPorPessoa <= 2, 'ninguém folga em dia pesado mais de 2 vezes em 4 semanas: ' + JSON.stringify(com.proposta.map(p => p.folgasEmDiaPesado)));
  assert.strictEqual(com.proposta.reduce((t, p) => t + p.folgasEmDiaPesado, 0), b);
  // e o domingo não vira a rotativa de sempre de quem tem folga fixa no meio da semana: dentro do setor, ninguém fica
  // com mais de um domingo de folga à frente do colega (com e sem peso)
  for (const r of [sem, com]) for (const setor of ['CAIXA', 'REPOSICAO']) { const d = r.proposta.filter(p => p.setor === setor).map(p => p.domingosFolga); assert.ok(Math.max(...d) - Math.min(...d) <= 1, setor + ': domingos de folga ' + d); }
});

test('pesos por dia · não são proibição e valem por unidade e por setor (o do setor vence)', () => {
  // todos os dias com peso máximo: continua havendo 2 folgas por semana para todo mundo
  const tudo = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: { ...COB, pesoDia: { 0: 5, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5 } } });
  assert.strictEqual(tudo.indicadores.pct_semanas_5x2, 100); assert.deepStrictEqual(tudo.conflitos.trabalhistas, []);
  // quem só pode folgar em dia pesado folga nele: folga fixa na quarta, restrição de não trabalhar sábado, sábado com peso 5
  const eq = equipe(); eq[2].restricoes = { naoTrabalha: [6] };
  const rest = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK], cobertura: { ...COB, pesoDia: { 5: 5, 6: 5 } } });
  for (const [d, x] of Object.entries(rest.proposta.find(p => p.id === 3).dias)) if (dow(d) === 6) assert.strictEqual(x.tipo, 'folga');
  // peso só do setor CAIXA: a REPOSIÇÃO fica exatamente como sem peso
  const sem = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  const soCaixa = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: { ...COB, setores: { CAIXA: { min: 2, pesoDia: { 5: 4, 6: 4 } }, REPOSICAO: { min: 1 } } } });
  assert.ok(rotativasEm(soCaixa, [5, 6], 'CAIXA') < rotativasEm(sem, [5, 6], 'CAIXA'));
  const dias = r => JSON.stringify(r.proposta.filter(p => p.setor === 'REPOSICAO').map(p => Object.values(p.dias).map(x => x.tipo)));
  assert.strictEqual(dias(soCaixa), dias(sem));
  // peso da unidade com exceção no setor: a REPOSIÇÃO declara sexta e sábado normais e não é afetada
  const excecao = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: { ...COB, pesoDia: { 5: 4, 6: 4 }, setores: { CAIXA: { min: 2 }, REPOSICAO: { min: 1, pesoDia: { 5: 1, 6: 1 } } } } });
  assert.strictEqual(dias(excecao), dias(sem)); assert.strictEqual(rotativasEm(excecao, [5, 6], 'CAIXA'), rotativasEm(soCaixa, [5, 6], 'CAIXA'));
  // cobertura mínima continua na frente do peso: com pico que exige o caixa inteiro no domingo, as rotativas vão para sexta/sábado mesmo pesados
  const apertada = pesoDia => G.gerar({ ...SEG, funcionarios: equipe(), regras: [{ ...REGRA_OK, params: { domingo: { folgaACadaSemanas: 0 } } }], cobertura: { ...COB, pesoDia, setores: { CAIXA: { min: 1, faixas: [0, 1, 2, 3, 4].map(d => ({ dias: [d], ini: '10:00', fim: '13:00', min: 6 })) }, REPOSICAO: { min: 1 } } } });
  const aperto = apertada({ 5: 5, 6: 5 });
  assert.ok(rotativasEm(aperto, [5, 6], 'CAIXA') > 3 * rotativasEm(aperto, [0, 1, 2, 3, 4], 'CAIXA'), 'a cobertura mínima vence o peso do dia');
  assert.strictEqual(rotativasEm(aperto, [5, 6], 'CAIXA'), rotativasEm(apertada({}), [5, 6], 'CAIXA'), 'o peso não tira ninguém do dia em que cabia para um dia que fura o mínimo');
});

// ═══ ETAPA 4 — cores por turno, regra das duas folgas, reprocessamento e carga horária efetiva ═══════════
const TR = (en = '07:00', sa = '17:24', ai = '11:00', af = '13:00', setor = 'CAIXA') => ({ tipo: 'trabalho', entrada: en, saida: sa, almoco_ini: ai, almoco_fim: af, setor });
const FG = (setor = 'CAIXA') => ({ tipo: 'folga', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor });
const semDe = (r, id, seg) => r.proposta.find(p => p.id === id).semanas.find(s => s.inicio === seg);
const trabDe = (r, id, c) => r.conflitos.trabalhistas.filter(x => x.funcId === id && (!c || x.codigo === c));
const folgasNaSemana = (dias, seg) => semana(seg).filter(d => dias[d] && dias[d].tipo === 'folga').length;

test('cores · classificação do turno sai do funcionamento configurado (unidade e setor), sem horário fixo no código', () => {
  const C = G.classificarTurno; const U = { abre: '07:00', fecha: '19:00' };
  assert.deepStrictEqual(G.CLASSES_TURNO, ['abertura', 'intermediario', 'fechamento', 'especial']);
  assert.strictEqual(C(TR('07:00', '17:24'), U), 'abertura'); assert.strictEqual(C(TR('08:00', '18:24'), U), 'intermediario'); assert.strictEqual(C(TR('08:30', '18:54'), U), 'intermediario');
  assert.strictEqual(C(TR('08:36', '19:00'), U), 'fechamento'); assert.strictEqual(C(TR('09:00', '19:24'), U), 'fechamento');
  assert.strictEqual(C(TR('07:00', '19:00'), U), 'especial', 'da abertura ao fechamento'); assert.strictEqual(C(TR('19:30', '23:00', null, null), U), 'especial', 'fora do funcionamento');
  assert.strictEqual(C(FG(), U), null); assert.strictEqual(C({ tipo: 'ferias' }, U), null);
  // o MESMO horário muda de classificação quando o funcionamento é outro (outra loja, ou setor com horário próprio)
  const V = { abre: '06:00', fecha: '22:00' };
  assert.strictEqual(C(TR('07:00', '17:24'), V), 'intermediario'); assert.strictEqual(C(TR('06:30', '16:54'), V), 'abertura'); assert.strictEqual(C(TR('11:36', '22:00'), V), 'fechamento');
  // limites e horários especiais configurados
  assert.strictEqual(C(TR('08:00', '18:24'), { ...U, aberturaAte: '08:00' }), 'abertura'); assert.strictEqual(C(TR('08:00', '18:24'), { ...U, fechamentoDesde: '18:00' }), 'fechamento');
  assert.strictEqual(C(TR('08:00', '18:24'), { ...U, especiais: ['08:00-18:24'] }), 'especial');
  assert.deepStrictEqual(G.limitesTurno({ abre: '05:00', fecha: '13:00' }), { abre: 300, fecha: 780, aberturaAte: 359, fechamentoDesde: 780, especiais: [] });
});

test('duas folgas · semana completa: exatamente 2 folgas contando F + FR, em toda semana, inclusive na que atravessa o mês', () => {
  const r = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  for (const p of r.proposta) for (const s of p.semanas) {
    assert.strictEqual(s.regra52.situacao, 'ok', p.nome + ' ' + s.inicio); assert.strictEqual(s.regra52.folgas, 2); assert.strictEqual(s.regra52.exigidas, 2);
    assert.strictEqual(s.regra52.fixas, 1); assert.strictEqual(s.regra52.rotativas, 1); assert.strictEqual(folgasNaSemana(p.dias, s.inicio), 2, 'F + FR na grade');
  }
  assert.deepStrictEqual(r.duasFolgas, { semanas: 36, ok: 36, excesso: 0, falta: 0, excecao: 0, analiseRH: 0, herdado: 0, semDados: 0, parcial: 0 });
  assert.ok(!r.conflitos.trabalhistas.some(c => /^folgas_semana/.test(c.codigo)));
  // novembro termina na segunda 30/11: a semana 30/11–06/12 fica aberta e as folgas dela são contadas com os dias previstos de dezembro
  const nov = G.gerar({ de: '2026-11-02', ate: '2026-11-30', funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  for (const p of nov.proposta) { const s = p.semanas.find(x => x.inicio === '2026-11-30'); assert.strictEqual(s.cruzaPeriodo, true); assert.strictEqual(s.regra52.situacao, 'ok'); assert.strictEqual(s.regra52.folgas, 2); assert.strictEqual(s.regra52.noPeriodo + s.regra52.previstas, 2, p.nome); }
  assert.strictEqual(semDe(nov, 1, '2026-11-30').regra52.noPeriodo, 1, 'a folga fixa de segunda cai em 30/11; a outra fica prevista para dezembro');
  // dezembro continua a mesma semana a partir do que novembro deixou: a conta fecha em 2 somando os dois meses
  const dez = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: nov.continuidade });
  for (const p of dez.proposta) { const s = p.semanas[0]; assert.strictEqual(s.inicio, '2026-11-30'); assert.strictEqual(s.regra52.situacao, 'ok', p.nome); assert.strictEqual(s.regra52.folgas, 2);
    assert.strictEqual(folgasNaSemana({ ...nov.proposta.find(x => x.id === p.id).dias, ...p.dias }, '2026-11-30'), 2, p.nome + ': folga duplicada ou faltando na virada do mês'); }
  assert.strictEqual(dez.duasFolgas.excesso + dez.duasFolgas.falta, 0);
  // dia do mês seguinte que JÁ está na grade (travado depois de `ate`) fecha a semana aberta no lugar da previsão
  const comDez = G.gerar({ de: '2026-11-02', ate: '2026-11-30', funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: { '2|2026-12-01': FG(), '2|2026-12-02': FG(), '2|2026-12-03': FG() } });
  assert.strictEqual(semDe(comDez, 2, '2026-11-30').regra52.situacao, 'excesso'); assert.strictEqual(trabDe(comDez, 2, 'folgas_semana_excesso').length, 1);
});

test('duas folgas · três folgas na semana: bloqueio; quando dá, o motor reprocessa e a folga fixa cede em vez de virar a 3ª', () => {
  const base = { ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB };
  // (a) func 3 (folga fixa quarta) com 3 folgas já fixas na semana de 09/11: não há como cumprir → bloqueio e nada de 4ª folga
  const a = G.gerar({ ...base, travados: { '3|2026-11-10': FG(), '3|2026-11-12': FG(), '3|2026-11-14': FG() } });
  assert.strictEqual(semDe(a, 3, '2026-11-09').regra52.situacao, 'excesso'); assert.strictEqual(semDe(a, 3, '2026-11-09').regra52.folgas, 3);
  const ca = trabDe(a, 3, 'folgas_semana_excesso'); assert.strictEqual(ca.length, 1); assert.strictEqual(ca[0].gravidade, 'bloqueio'); assert.strictEqual(ca[0].ref, '2026-11-09'); assert.match(ca[0].texto, /3 folgas \(F \+ FR\) na semana de 09\/11 a 15\/11/);
  assert.strictEqual(a.proposta.find(p => p.id === 3).dias['2026-11-11'].tipo, 'trabalho', 'a folga fixa não entra como 4ª folga');
  assert.strictEqual(a.duasFolgas.excesso, 1); assert.strictEqual(a.duasFolgas.ok, 35); assert.ok(a.publicacao.bloqueios.some(b => b.codigo === 'conflito_trabalhista'), 'escala inválida não é publicável');
  assert.ok(!a.conflitos.operacionais.some(c => c.codigo === 'menos_dias_que_o_previsto' && c.funcId === 3), 'um conflito só por semana');
  // (b) 2 folgas fixas à mão: reprocessa — a folga fixa de quarta vira trabalho e a semana fecha em exatamente 2
  const b = G.gerar({ ...base, travados: { '3|2026-11-10': FG(), '3|2026-11-14': FG() } }); const pb = b.proposta.find(p => p.id === 3);
  assert.strictEqual(semDe(b, 3, '2026-11-09').regra52.situacao, 'ok'); assert.strictEqual(folgasNaSemana(pb.dias, '2026-11-09'), 2); assert.strictEqual(pb.dias['2026-11-11'].tipo, 'trabalho');
  assert.strictEqual(pb.dias['2026-11-10'].travado, true); assert.strictEqual(pb.dias['2026-11-14'].travado, true);
  const av = b.conflitos.operacionais.find(c => c.codigo === 'folga_fixa_substituida' && c.funcId === 3); assert.ok(av); assert.strictEqual(av.ref, '2026-11-11'); assert.strictEqual(av.reprocessado, true);
  assert.deepStrictEqual(trabDe(b, 3), []); assert.strictEqual(b.duasFolgas.ok, 36);
  // (c) 1 folga à mão + a fixa = 2: a rotativa da semana some sozinha
  const c = G.gerar({ ...base, travados: { '3|2026-11-13': FG() } }); const sc = semDe(c, 3, '2026-11-09');
  assert.strictEqual(sc.regra52.folgas, 2); assert.strictEqual(sc.regra52.rotativas, 0); assert.strictEqual(c.proposta.find(p => p.id === 3).dias['2026-11-11'].folga, 'fixa'); assert.deepStrictEqual(trabDe(c, 3), []);
  // (d) exceção do RH nunca libera folga a mais
  const d = G.gerar({ ...base, travados: { '3|2026-11-10': FG(), '3|2026-11-12': FG(), '3|2026-11-14': FG() }, excecoesFolga: { '3|2026-11-09': { motivo: 'pedido do funcionário' } } });
  assert.strictEqual(trabDe(d, 3, 'folgas_semana_excesso')[0].gravidade, 'bloqueio');
  // (e) regra que não fecha com 2 folgas (no máximo 2 dias seguidos): o motor dá o descanso, mas a semana é acusada
  const e = G.gerar({ ...base, regras: [{ ...REGRA_OK, params: { maxDiasConsecutivos: 2 } }] });
  assert.ok(e.duasFolgas.excesso > 0); assert.ok(e.conflitos.trabalhistas.some(x => x.codigo === 'folgas_semana_excesso' && x.gravidade === 'bloqueio'));
});

test('duas folgas · menos de duas: bloqueio, salvo exceção justificada e analisada pelo RH', () => {
  // func 1 (folga fixa segunda) com terça a domingo já fixos como trabalho de 7 h: 42 h na semana, mas só 1 folga
  const trav = {}; for (const d of semana('2026-11-09').slice(1)) trav['1|' + d] = TR('07:00', '15:00', '11:00', '12:00');
  const base = { ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: trav };
  const r = G.gerar(base); const s = semDe(r, 1, '2026-11-09');
  assert.strictEqual(s.regra52.situacao, 'falta'); assert.strictEqual(s.regra52.folgas, 1); assert.strictEqual(s.regra52.exigidas, 2); assert.strictEqual(s.minutos, 42 * 60);
  const meus = trabDe(r, 1); assert.deepStrictEqual(meus.map(c => c.codigo), ['folgas_semana_falta'], JSON.stringify(meus));
  assert.strictEqual(meus[0].gravidade, 'bloqueio'); assert.match(meus[0].texto, /só 1 folga \(F \+ FR\) na semana de 09\/11 a 15\/11 — o 5×2 exige 2/);
  assert.strictEqual(r.duasFolgas.falta, 1); assert.ok(r.publicacao.bloqueios.some(b => b.codigo === 'conflito_trabalhista'));
  // com a exceção analisada pelo RH a semana deixa de bloquear e fica registrada
  const x = G.gerar({ ...base, excecoesFolga: { '1|2026-11-09': { motivo: 'inventário geral; folga compensada na semana seguinte' } } }); const cx = trabDe(x, 1);
  assert.strictEqual(semDe(x, 1, '2026-11-09').regra52.situacao, 'excecao'); assert.match(semDe(x, 1, '2026-11-09').regra52.excecao, /inventário/);
  assert.strictEqual(cx.length, 1); assert.strictEqual(cx[0].gravidade, 'info'); assert.strictEqual(cx[0].excecao, true); assert.match(cx[0].texto, /exceção analisada pelo RH: inventário/);
  assert.strictEqual(x.duasFolgas.excecao, 1); assert.strictEqual(x.duasFolgas.falta, 0); assert.ok(!x.publicacao.bloqueios.some(b => b.codigo === 'conflito_trabalhista'));
  // a exceção vale só para aquela pessoa e aquela semana
  assert.strictEqual(G.gerar({ ...base, excecoesFolga: { '1|2026-11-16': { motivo: 'outra semana' }, '2|2026-11-09': { motivo: 'outra pessoa' } } }).duasFolgas.falta, 1);
  // semana sem nenhuma folga
  const t7 = {}; for (const d of semana('2026-11-16')) t7['4|' + d] = TR('07:00', '13:00', null, null);
  assert.match(trabDe(G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: t7 }), 4, 'folgas_semana_falta')[0].texto, /nenhuma folga/);
});

test('duas folgas · férias e afastamento: ausência não é folga nem vira folga; a semana fica proporcional e vai para análise do RH', () => {
  const eq = equipe();
  eq[0].ausencias = [{ inicio: '2026-11-10', fim: '2026-11-19', tipo: 'ferias' }];        // func 1: férias de terça 10/11 a quinta 19/11
  eq[3].ausencias = [{ inicio: '2026-11-16', fim: '2026-11-22', tipo: 'afastado' }];      // func 4: afastado a semana inteira de 16/11
  eq[6].ausencias = [{ inicio: '2026-11-11', fim: '2026-11-13', tipo: 'afastado' }];      // func 7: atestado de quarta a sexta
  const r = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK], cobertura: COB }); const p1 = r.proposta.find(p => p.id === 1), p4 = r.proposta.find(p => p.id === 4), p7 = r.proposta.find(p => p.id === 7);
  for (let d = '2026-11-10'; d <= '2026-11-19'; d = soma(d, 1)) assert.strictEqual(p1.dias[d].tipo, 'ferias', d);
  for (const d of semana('2026-11-16')) assert.strictEqual(p4.dias[d].tipo, 'afastado'); for (const d of ['2026-11-11', '2026-11-12', '2026-11-13']) assert.strictEqual(p7.dias[d].tipo, 'afastado');
  // férias/afastamento nunca entram na conta das folgas
  for (const p of [p1, p4, p7]) for (const s of p.semanas) { assert.strictEqual(s.trabalho + s.folgas + s.ausencias, 7, p.nome + ' ' + s.inicio); assert.strictEqual(s.regra52.folgas, folgasNaSemana(p.dias, s.inicio)); }
  const a1 = semDe(r, 1, '2026-11-09'), b1 = semDe(r, 1, '2026-11-16');
  assert.strictEqual(a1.ausencias, 6); assert.strictEqual(a1.regra52.situacao, 'analise_rh'); assert.strictEqual(a1.regra52.folgas, 1); assert.strictEqual(a1.regra52.ausencias, 6);
  assert.strictEqual(b1.ausencias, 4); assert.strictEqual(b1.regra52.situacao, 'analise_rh'); assert.strictEqual(b1.regra52.exigidas, 1); assert.strictEqual(b1.regra52.folgas, 1);
  assert.strictEqual(semDe(r, 4, '2026-11-16').regra52.situacao, 'ausente'); assert.strictEqual(semDe(r, 4, '2026-11-16').folgas, 0);
  assert.ok(['analise_rh', 'ok'].includes(semDe(r, 7, '2026-11-09').regra52.situacao)); assert.ok(semDe(r, 7, '2026-11-09').regra52.folgas <= 2);
  // semana proporcional é situação justificada: informa o RH, não bloqueia
  const inf = r.conflitos.operacionais.filter(c => c.codigo === 'folgas_semana_ausencia'); assert.ok(inf.length >= 2); assert.ok(inf.every(c => c.gravidade === 'info' && c.analiseRH === true)); assert.match(inf.find(c => c.funcId === 1 && c.ref === '2026-11-09').texto, /6 dia\(s\) de férias\/afastamento.*análise do RH/);
  assert.ok(!r.conflitos.trabalhistas.some(c => /^folgas_semana/.test(c.codigo)), JSON.stringify(r.conflitos.trabalhistas)); assert.strictEqual(r.duasFolgas.excesso + r.duasFolgas.falta, 0); assert.ok(r.duasFolgas.analiseRH >= 2);
  assert.strictEqual(r.duasFolgas.semanas, 35, 'a semana inteira de afastamento não entra na contagem');
  // as semanas sem ausência continuam com exatamente 2 folgas
  for (const p of r.proposta) for (const s of p.semanas) if (!s.ausencias) { assert.strictEqual(s.regra52.folgas, 2, p.nome + ' ' + s.inicio); assert.strictEqual(s.regra52.situacao, 'ok'); }
  // afastamento de 1 dia + 6 dias trabalhados na mesma semana: aí falta folga de verdade (bloqueio), e o texto cita a ausência
  const eq2 = equipe(); eq2[1].ausencias = [{ inicio: '2026-11-09', fim: '2026-11-09', tipo: 'afastado' }]; const trav = {}; for (const d of semana('2026-11-09').slice(1)) trav['2|' + d] = TR('07:00', '15:00', '11:00', '12:00');
  const f = trabDe(G.gerar({ ...SEG, funcionarios: eq2, regras: [REGRA_OK], cobertura: COB, travados: trav }), 2, 'folgas_semana_falta');
  assert.strictEqual(f.length, 1); assert.strictEqual(f[0].gravidade, 'bloqueio'); assert.match(f[0].texto, /nenhuma folga.*há 1 dia\(s\) de férias\/afastamento/);
});

test('duas folgas · descanso dominical vencido com as folgas já ocupadas: a folga fixa é movida para o domingo, nunca uma 3ª folga', () => {
  // func 1 com duas folgas fixas (segunda e terça) e 2 domingos trabalhados antes do período
  const eq = equipe(); eq[0].folga_fixa = [1, 2]; const historico = { 1: { domingosTrabalhadosSeguidos: 2, diasSeguidos: 0 } };
  const r = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK], cobertura: COB, historico }); const p = r.proposta.find(x => x.id === 1);
  assert.strictEqual(p.dias['2026-11-08'].tipo, 'folga', 'o domingo vencido é descanso'); assert.strictEqual(p.dias['2026-11-02'].folga, 'fixa'); assert.strictEqual(p.dias['2026-11-03'].tipo, 'trabalho', 'a folga fixa de terça foi a movida');
  assert.strictEqual(semDe(r, 1, '2026-11-02').regra52.folgas, 2); assert.strictEqual(semDe(r, 1, '2026-11-02').regra52.situacao, 'ok');
  const m = r.conflitos.operacionais.find(c => c.codigo === 'folga_fixa_movida' && c.funcId === 1); assert.ok(m); assert.strictEqual(m.reprocessado, true); assert.match(m.texto, /03\/11 \(terça\) movida para o domingo 08\/11/);
  assert.deepStrictEqual(trabDe(r, 1), []); assert.ok(!r.conflitos.operacionais.some(c => c.codigo === 'folga_extra_domingo' && c.funcId === 1));
  // se as duas folgas da semana estão em dias travados não há o que mover: o domingo fica de trabalho e a escala é acusada (não publicável)
  const t = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico, travados: { '1|2026-11-04': FG(), '1|2026-11-05': FG() } });
  assert.strictEqual(semDe(t, 1, '2026-11-02').regra52.folgas, 2); assert.strictEqual(trabDe(t, 1, 'domingo_sem_folga').length, 1); assert.ok(t.publicacao.bloqueios.some(b => b.codigo === 'conflito_trabalhista'));
});

test('reprocessamento · a cobertura é verificada antes de redistribuir a folga; sem dia com gente sobrando, o motor avisa', () => {
  // RH pôs o func 2 para trabalhar na folga fixa dele (terça 10/11): as duas folgas da semana são redistribuídas
  const trav = { '2|2026-11-10': TR() }; const semFolga = (r, setor) => r.conflitos.operacionais.filter(c => c.codigo === 'folga_redistribuida_sem_cobertura');
  const ok = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: trav }); const p = ok.proposta.find(x => x.id === 2);
  assert.strictEqual(p.dias['2026-11-10'].travado, true); assert.strictEqual(semDe(ok, 2, '2026-11-09').regra52.folgas, 2); assert.strictEqual(semDe(ok, 2, '2026-11-09').regra52.rotativas, 2);
  assert.deepStrictEqual(semFolga(ok), [], 'havia dia com cobertura sobrando: a redistribuição não abre buraco');
  for (const d of semana('2026-11-09').filter(x => p.dias[x].tipo === 'folga')) assert.ok(ok.proposta.filter(x => x.setor === 'CAIXA' && x.dias[d].tipo === 'trabalho').length >= 4, 'CAIXA mantém as 4 pessoas do dia em ' + d);
  // setor que precisa de todo mundo todos os dias: a folga é redistribuída (é devida), mas fica o alerta de cobertura
  const apertado = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: { ...COB, setores: { CAIXA: { min: 6 }, REPOSICAO: { min: 1 } } }, travados: trav });
  const al = semFolga(apertado).filter(c => c.funcId === 2); assert.strictEqual(al.length, 2); assert.ok(al.every(c => c.gravidade === 'alerta' && c.reprocessado === true)); assert.match(al[0].texto, /folga redistribuída para .* deixa CAIXA com/);
  assert.strictEqual(semDe(apertado, 2, '2026-11-09').regra52.folgas, 2, 'a cobertura nunca tira folga devida');
});

test('carga horária · conta as horas efetivas (permanência − intervalo), valida o limite semanal, o contrato e a condição individual', () => {
  const base = { ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB };
  // func 2 (folga fixa terça): 5 dias fixos de 07:00 às 19:00 com 2 h de intervalo = 10 h efetivas por dia (12 h de permanência)
  const longos = {}; for (const d of ['2026-11-09', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']) longos['2|' + d] = TR('07:00', '19:00', '11:00', '13:00');
  const r = G.gerar({ ...base, travados: longos }); const s = semDe(r, 2, '2026-11-09');
  assert.strictEqual(s.minutos, 50 * 60); assert.strictEqual(s.horas, '50h00'); assert.strictEqual(s.permanenciaMin, 60 * 60); assert.strictEqual(s.intervalosMin, 10 * 60); assert.strictEqual(s.regra52.folgas, 2);
  const c = trabDe(r, 2, 'carga_semanal'); assert.strictEqual(c.length, 1); assert.strictEqual(c[0].gravidade, 'bloqueio'); assert.match(c[0].texto, /50h00 efetivas na semana de 09\/11 \(limite 44h00; permanência 60h00, intervalos 10h00\)/);
  // 5 dias de 07:00–17:48 com 2 h de intervalo: 54 h de permanência, 44 h efetivas → dentro do limite (não se mede por entrada e saída)
  const j44 = {}; for (const d of ['2026-11-16', '2026-11-17', '2026-11-19', '2026-11-20', '2026-11-21']) j44['3|' + d] = TR('07:00', '17:48', '11:00', '13:00');
  const r44 = G.gerar({ ...base, travados: j44 }); const s44 = semDe(r44, 3, '2026-11-16');
  assert.strictEqual(s44.minutos, 44 * 60); assert.strictEqual(s44.permanenciaMin, 54 * 60); assert.deepStrictEqual(trabDe(r44, 3), []);
  // o campo `minutos` que vier errado num dia fixo não é levado em conta: a carga é sempre recalculada
  const errado = G.gerar({ ...base, travados: { '5|2026-11-09': { ...TR('07:00', '19:00', '11:00', '13:00'), minutos: 60 } } });
  assert.strictEqual(errado.proposta.find(p => p.id === 5).dias['2026-11-09'].minutos, 600);
  // contrato de 30 h semanais recebendo a escala de 42 h: bloqueio em toda semana
  const eq = equipe(); eq[8].contratual = { semanaMin: 30 * 60 }; const rc = G.gerar({ ...base, funcionarios: eq }); const cc = trabDe(rc, 9, 'carga_acima_do_contrato');
  assert.strictEqual(cc.length, 4); assert.ok(cc.every(x => x.gravidade === 'bloqueio')); assert.match(cc[0].texto, /42h00 efetivas .* para um contrato de 30h00 semanais/); assert.strictEqual(semDe(rc, 9, '2026-11-02').contratoMin, 1800);
  assert.deepStrictEqual(trabDe(rc, 1, 'carga_acima_do_contrato'), [], 'contrato de 44 h com escala de 42 h está dentro');
  // condição individual: dia já fixo num dia/horário restrito é acusado (o que o motor gera já respeita a restrição)
  const eq2 = equipe(); eq2[4].restricoes = { naoTrabalha: [6], saidaMax: '16:00' };
  const ri = G.gerar({ ...base, funcionarios: eq2, travados: { '5|2026-11-21': TR('09:00', '19:24', '13:00', '15:00') } });
  assert.deepStrictEqual(trabDe(ri, 5).filter(x => /^restricao_/.test(x.codigo)).map(x => [x.codigo, x.gravidade, x.ref]), [['restricao_individual', 'alerta', '2026-11-21'], ['restricao_individual_horario', 'alerta', '2026-11-21']]);
  for (const [d, x] of Object.entries(ri.proposta.find(p => p.id === 5).dias)) if (x.tipo === 'trabalho' && !x.travado) { assert.notStrictEqual(dow(d), 6); assert.ok(G._util.min(x.saida) <= 16 * 60); }
});

// ═══ ETAPA 5 — motor de validação semanal 5×2: semana contínua (segunda → domingo), indicador por funcionário e semana ═══
const nivelDe = (r, id, seg) => semDe(r, id, seg).validacao.nivel;
const itemDe = (r, id, seg, cod) => semDe(r, id, seg).validacao.itens.find(i => i.codigo === cod);
const JAN = { de: '2027-01-01', ate: '2027-01-31' };

test('validação semanal 1 · semana com cinco dias de trabalho e duas folgas: verde, com os sete dias da semana identificados pela segunda-feira', () => {
  const r = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  for (const p of r.proposta) for (const s of p.semanas) {
    assert.strictEqual(s.validacao.nivel, 'verde', p.nome + ' ' + s.inicio + ' ' + JSON.stringify(s.validacao.itens)); assert.ok(s.validacao.itens.every(i => i.gravidade === 'info'));
    assert.strictEqual(dow(s.inicio), 1, 'a semana é identificada pela segunda-feira'); assert.deepStrictEqual(s.dias.map(d => d.data), semana(s.inicio));
    assert.strictEqual(s.dias.filter(d => d.tipo === 'trabalho').length, 5); assert.strictEqual(s.dias.filter(d => d.tipo === 'folga').length, 2); assert.ok(s.dias.every(d => d.origem === 'gerado' && d.noPeriodo));
  }
  assert.deepStrictEqual(r.validacaoSemanal, { semanas: 36, verde: 36, amarelo: 0, vermelho: 0, cinza: 0 });
  // cada conflito sai com a regra violada e a correção sugerida
  for (const cod of ['folgas_semana_excesso', 'folgas_semana_falta', 'interjornada', 'descanso_semanal', 'dias_consecutivos', 'domingo_sem_folga', 'carga_semanal', 'jornada_diaria', 'intervalo_ausente', 'trabalho_continuo', 'restricao_individual', 'folga_fixa_trabalhada']) { assert.ok(G.REGRA_INFO[cod] && G.REGRA_INFO[cod][0] && G.REGRA_INFO[cod][1], cod); }
});

test('validação semanal 2 · semana com três folgas: vermelho (bloqueia a publicação), com os dias envolvidos, a regra violada e a correção sugerida', () => {
  const r = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: { '3|2026-11-10': FG(), '3|2026-11-12': FG(), '3|2026-11-14': FG() } });
  assert.strictEqual(nivelDe(r, 3, '2026-11-09'), 'vermelho'); const i = itemDe(r, 3, '2026-11-09', 'folgas_semana_excesso');
  assert.strictEqual(i.gravidade, 'bloqueio'); assert.strictEqual(i.regra, 'Duas folgas por semana (5×2)'); assert.deepStrictEqual(i.dias, ['2026-11-10', '2026-11-12', '2026-11-14']); assert.match(i.sugestao, /folga não protegida/); assert.ok(!/^Func 3: /.test(i.texto));
  assert.strictEqual(nivelDe(r, 3, '2026-11-02'), 'verde'); assert.strictEqual(nivelDe(r, 3, '2026-11-16'), 'verde', 'só a semana com problema fica vermelha');
  assert.strictEqual(r.validacaoSemanal.vermelho, 1); assert.ok(r.publicacao.bloqueios.some(b => b.codigo === 'conflito_trabalhista'));
});

test('validação semanal 3 · semana com apenas uma folga: vermelho; com a exceção analisada pelo RH passa a amarelo (exige conferência)', () => {
  const trav = {}; for (const d of semana('2026-11-09').slice(1)) trav['1|' + d] = TR('07:00', '15:00', '11:00', '12:00');
  const base = { ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: trav };
  const r = G.gerar(base); assert.strictEqual(nivelDe(r, 1, '2026-11-09'), 'vermelho'); const i = itemDe(r, 1, '2026-11-09', 'folgas_semana_falta');
  assert.strictEqual(i.regra, 'Duas folgas por semana (5×2)'); assert.deepStrictEqual(i.dias, semana('2026-11-09').slice(1), 'os seis dias trabalhados'); assert.match(i.sugestao, /folga que falta.*exceção/);
  const x = G.gerar({ ...base, excecoesFolga: { '1|2026-11-09': { motivo: 'inventário geral; folga compensada na semana seguinte' } } });
  assert.strictEqual(nivelDe(x, 1, '2026-11-09'), 'amarelo'); assert.strictEqual(itemDe(x, 1, '2026-11-09', 'folgas_semana_falta').excecao, true); assert.strictEqual(x.validacaoSemanal.vermelho, 0);
});

test('validação semanal 4 · semana atravessando dois meses: os sete dias entram na conta, de onde quer que venham', () => {
  const nov = G.gerar({ de: '2026-11-02', ate: '2026-11-30', funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  for (const p of nov.proposta) { const s = p.semanas.find(x => x.inicio === '2026-11-30'); assert.strictEqual(s.fim, '2026-12-06'); assert.deepStrictEqual(s.dias.map(d => d.data), semana('2026-11-30'));
    assert.deepStrictEqual(s.dias.map(d => d.noPeriodo), [true, false, false, false, false, false, false]); assert.ok(s.dias.slice(1).every(d => d.origem === 'previsto'), 'dezembro ainda não existe: os dias são a previsão do motor');
    assert.strictEqual(s.dias.filter(d => d.tipo === 'folga').length, 2); assert.strictEqual(s.validacao.nivel, 'verde'); }
  const dez = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: nov.continuidade });
  for (const p of dez.proposta) { const s = p.semanas[0]; assert.strictEqual(s.inicio, '2026-11-30', 'em dezembro a mesma semana continua sendo a de 30/11'); assert.strictEqual(s.dias[0].origem, 'historico'); assert.strictEqual(s.dias[0].noPeriodo, false);
    assert.strictEqual(s.regra52.folgas, 2); assert.strictEqual(s.validacao.nivel, 'verde', JSON.stringify(s.validacao.itens)); }
  // três folgas somando os dois meses: uma em 30/11 (registro anterior, preservado) e duas lançadas à mão em dezembro
  const h = JSON.parse(JSON.stringify(nov.continuidade)); h[2].dias['2026-11-30'] = { tipo: 'folga', fonte: 'escala' };
  const tres = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: h, travados: { '2|2026-12-03': FG(), '2|2026-12-05': FG() } });
  assert.strictEqual(nivelDe(tres, 2, '2026-11-30'), 'vermelho'); assert.deepStrictEqual(itemDe(tres, 2, '2026-11-30', 'folgas_semana_excesso').dias, ['2026-11-30', '2026-12-03', '2026-12-05']);
  assert.strictEqual(tres.proposta.find(p => p.id === 2).dias['2026-11-30'], undefined, 'o registro de novembro não é regravado');
});

test('validação semanal 5 · semana atravessando dois anos: 28/12/2026 a 03/01/2027 é uma semana só', () => {
  const dez = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  for (const p of dez.proposta) { const s = p.semanas.find(x => x.inicio === '2026-12-28'); assert.strictEqual(s.fim, '2027-01-03'); assert.deepStrictEqual(s.dias.map(d => d.data), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    assert.strictEqual(s.regra52.folgas, 2); assert.strictEqual(s.regra52.noPeriodo + s.regra52.previstas, 2); assert.strictEqual(s.validacao.nivel, 'verde'); }
  const jan = G.gerar({ ...JAN, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: dez.continuidade });
  assert.strictEqual(jan.semanas[0].inicio, '2026-12-28'); assert.strictEqual(jan.semanas[0].cruzaPeriodo, true);
  for (const p of jan.proposta) { const d = dez.proposta.find(x => x.id === p.id); const tudo = { ...d.dias, ...p.dias }; const s = p.semanas[0];
    assert.strictEqual(s.inicio, '2026-12-28', 'em janeiro a semana continua identificada pela segunda-feira de dezembro'); assert.strictEqual(s.regra52.folgas, 2, p.nome); assert.strictEqual(s.trabalho, 5);
    assert.strictEqual(folgasNaSemana(tudo, '2026-12-28'), 2, p.nome + ': folga duplicada ou faltando na virada do ano'); assert.ok(maiorSequencia(tudo) <= 6, p.nome);
    assert.strictEqual(p.dias['2026-12-31'], undefined, 'janeiro não regrava dezembro'); assert.deepStrictEqual(s.dias.slice(0, 4).map(x => x.origem), ['historico', 'historico', 'historico', 'historico']); }
  assert.strictEqual(jan.conflitos.trabalhistas.length, 0, JSON.stringify(jan.conflitos.trabalhistas));
  // três folgas somando os dois anos: func 2 folgou na terça 29/12 (folga fixa) e ganhou à mão o sábado 02/01 e o domingo 03/01
  assert.strictEqual(dez.proposta.find(p => p.id === 2).dias['2026-12-29'].tipo, 'folga');
  const h = JSON.parse(JSON.stringify(dez.continuidade)); for (const d of ['2026-12-28', '2026-12-30', '2026-12-31']) h[2].dias[d] = TR();
  const tres = G.gerar({ ...JAN, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: h, travados: { '2|2027-01-02': FG(), '2|2027-01-03': FG() } });
  const i = itemDe(tres, 2, '2026-12-28', 'folgas_semana_excesso'); assert.ok(i, JSON.stringify(semDe(tres, 2, '2026-12-28').validacao)); assert.deepStrictEqual(i.dias, ['2026-12-29', '2027-01-02', '2027-01-03']); assert.strictEqual(nivelDe(tres, 2, '2026-12-28'), 'vermelho');
});

test('validação semanal 6 e 7 · funcionário em férias e funcionário afastado: semana excepcional (cinza), sem cobrar o padrão comum dos sete dias', () => {
  const eq = equipe();
  eq[0].ausencias = [{ inicio: '2026-11-10', fim: '2026-11-19', tipo: 'ferias' }];        // 6. férias de 10 a 19/11
  eq[3].ausencias = [{ inicio: '2026-11-16', fim: '2026-11-22', tipo: 'afastado' }];      // 7. afastado a semana inteira
  eq[6].ausencias = [{ inicio: '2026-11-11', fim: '2026-11-13', tipo: 'afastado' }];      // 7. atestado de três dias
  const r = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK], cobertura: COB });
  assert.strictEqual(nivelDe(r, 1, '2026-11-09'), 'cinza'); assert.strictEqual(nivelDe(r, 1, '2026-11-16'), 'cinza'); assert.strictEqual(nivelDe(r, 1, '2026-11-02'), 'verde'); assert.strictEqual(nivelDe(r, 1, '2026-11-23'), 'verde');
  assert.strictEqual(nivelDe(r, 4, '2026-11-16'), 'cinza'); assert.deepStrictEqual(semDe(r, 4, '2026-11-16').validacao.itens, []);
  assert.ok(['cinza', 'verde'].includes(nivelDe(r, 7, '2026-11-09')));
  const s = semDe(r, 1, '2026-11-09'); assert.deepStrictEqual(s.dias.map(d => d.tipo), ['folga', 'ferias', 'ferias', 'ferias', 'ferias', 'ferias', 'ferias']); assert.ok(s.dias.slice(1).every(d => d.origem === 'ausencia'));
  assert.strictEqual(s.regra52.folgas, 1, 'férias não contam como folga'); const i = itemDe(r, 1, '2026-11-09', 'folgas_semana_ausencia'); assert.strictEqual(i.gravidade, 'info'); assert.strictEqual(i.regra, 'Semana com férias ou afastamento');
  assert.strictEqual(r.validacaoSemanal.vermelho, 0); assert.ok(r.validacaoSemanal.cinza >= 3);
  // …mas a semana excepcional não é passe livre: 1 dia de atestado + 6 dias trabalhados continua bloqueando
  const eq2 = equipe(); eq2[1].ausencias = [{ inicio: '2026-11-09', fim: '2026-11-09', tipo: 'afastado' }]; const trav = {}; for (const d of semana('2026-11-09').slice(1)) trav['2|' + d] = TR('07:00', '15:00', '11:00', '12:00');
  assert.strictEqual(nivelDe(G.gerar({ ...SEG, funcionarios: eq2, regras: [REGRA_OK], cobertura: COB, travados: trav }), 2, '2026-11-09'), 'vermelho');
  // admissão no meio da semana: não se aplica a regra comum
  const eq3 = equipe(); eq3[1].admissao = '2026-11-12'; assert.strictEqual(nivelDe(G.gerar({ ...SEG, funcionarios: eq3, regras: [REGRA_OK], cobertura: COB }), 2, '2026-11-09'), 'cinza');
});

test('validação semanal 8 · alteração manual protegida: o dia fixo nunca é mexido, aparece como fixo na semana e o que ele causa é acusado', () => {
  // RH pôs o func 2 para trabalhar na terça 10/11 (a folga fixa dele) e deu folga na quinta 12/11
  const trav = { '2|2026-11-10': TR('09:00', '19:24', '13:00', '15:00'), '2|2026-11-12': FG() }; const copia = JSON.stringify(trav);
  const r = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: trav }); const p = r.proposta.find(x => x.id === 2), s = semDe(r, 2, '2026-11-09');
  assert.strictEqual(JSON.stringify(trav), copia); assert.strictEqual(p.dias['2026-11-10'].entrada, '09:00'); assert.strictEqual(p.dias['2026-11-10'].travado, true); assert.strictEqual(p.dias['2026-11-12'].tipo, 'folga'); assert.strictEqual(p.dias['2026-11-12'].travado, true);
  assert.deepStrictEqual(s.dias.filter(d => d.origem === 'fixo').map(d => d.data), ['2026-11-10', '2026-11-12']); assert.strictEqual(s.regra52.folgas, 2, 'a semana fecha em volta dos dias fixos');
  // folga fixa × rotativa: trabalhar na folga fixa pede conferência (amarelo), não bloqueia
  const i = itemDe(r, 2, '2026-11-09', 'folga_fixa_trabalhada'); assert.strictEqual(i.gravidade, 'alerta'); assert.strictEqual(i.regra, 'Folga fixa × folga rotativa'); assert.deepStrictEqual(i.dias, ['2026-11-10']);
  assert.strictEqual(s.validacao.nivel, 'amarelo'); assert.strictEqual(r.validacaoSemanal.vermelho, 0);
  // rotativa colada na fixa é só aviso (não muda a cor)
  const colada = G.gerar({ ...SEG, funcionarios: [func(1, 'CAIXA', 1)], regras: [REGRA_OK], cobertura: { abre: '07:00', fecha: '19:00', setores: {} }, travados: {} });
  for (const c of colada.conflitos.operacionais.filter(x => x.codigo === 'folga_rotativa_colada')) { assert.strictEqual(c.gravidade, 'info'); assert.strictEqual(c.dias.length, 2); }
});

test('validações adicionais · cobertura por setor e TURNO, e feriado folgado conforme a regra', () => {
  // CAIXA com mínimo de 6 (todo mundo) o dia inteiro: falta gente na abertura, no meio e no fechamento
  const turnos = { unidade: { abre: '07:00', fecha: '19:00' }, setores: { REPOSICAO: { abre: '07:00', fecha: '15:00' } } };
  const r = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: { ...COB, setores: { CAIXA: { min: 6 }, REPOSICAO: { min: 1 } } }, turnos });
  const c = r.conflitos.operacionais.find(x => x.codigo === 'cobertura_abaixo' && /^CAIXA\|/.test(x.ref)); assert.strictEqual(c.regra, 'Cobertura mínima por setor e turno'); assert.ok(c.turnos.includes('fechamento')); assert.match(c.texto, /turno\(s\): /);
  const dia = r.cobertura.dias[0].setores.find(x => x.setor === 'CAIXA'); assert.strictEqual(dia.porTurno.abertura + dia.porTurno.intermediario + dia.porTurno.fechamento + dia.porTurno.especial, dia.escalados);
  assert.ok(r.cobertura.resumo.por_turno.fechamento > 0); assert.deepStrictEqual(Object.keys(r.cobertura.resumo.por_turno), ['abertura', 'intermediario', 'fechamento']);
  // o setor com funcionamento próprio (07–15) classifica os turnos pelo horário dele
  const rep = r.cobertura.dias[0].setores.find(x => x.setor === 'REPOSICAO'); assert.strictEqual(rep.porTurno.intermediario, 0, 'quem sai depois das 15:00 fecha a Reposição'); assert.ok(rep.porTurno.fechamento + rep.porTurno.especial === rep.escalados);
  // feriado folgado lançado na grade: pela regra, conta como folga da semana (padrão) ou é descanso à parte
  const fer = { '4|2026-11-20': { tipo: 'feriado', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: 'CAIXA' } };
  const conta = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: fer }); assert.strictEqual(semDe(conta, 4, '2026-11-16').regra52.folgas, 2); assert.strictEqual(semDe(conta, 4, '2026-11-16').trabalho, 5);
  const aParte = G.gerar({ ...SEG, funcionarios: equipe(), regras: [{ ...REGRA_OK, params: { feriado: { folgado: 'a_parte' } } }], cobertura: COB, travados: fer }); const s = semDe(aParte, 4, '2026-11-16');
  assert.strictEqual(s.ausencias, 1); assert.strictEqual(s.regra52.folgas + s.trabalho, 6); assert.strictEqual(s.validacao.nivel, 'cinza', 'semana com feriado folgado à parte é excepcional'); assert.ok(!aParte.conflitos.trabalhistas.some(x => x.funcId === 4));
});

// ═══ ETAPA 6 — modelo flexível de folgas: juntas ou separadas, uma fixa + uma rotativa ou duas rotativas (quando autorizado) ═══
const SEM_DOM = { ...REGRA_OK, params: { domingo: { folgaACadaSemanas: 0 } } };   // sem revezamento dominical, para isolar a escolha da rotativa
const consec = (r, id) => r.proposta.find(p => p.id === id).semanas.filter(s => s.regra52.consecutivas).length;

test('modelo flexível · folgas consecutivas: duas folgas juntas na mesma semana são válidas, sem dia de trabalho entre elas', () => {
  // func 3 (folga fixa quarta) ganha à mão a quinta 12/11; func 5 (folga fixa sexta) ganha o sábado 07/11
  const r = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: { '3|2026-11-12': FG(), '5|2026-11-07': FG() } });
  for (const [id, sg, dias] of [[3, '2026-11-09', ['2026-11-11', '2026-11-12']], [5, '2026-11-02', ['2026-11-06', '2026-11-07']]]) { const s = semDe(r, id, sg), p = r.proposta.find(x => x.id === id);
    assert.deepStrictEqual(semana(sg).filter(d => p.dias[d].tipo === 'folga'), dias, 'folga fixa + folga colada nela'); assert.strictEqual(s.regra52.folgas, 2); assert.strictEqual(s.regra52.consecutivas, true); assert.strictEqual(s.trabalho, 5);
    assert.strictEqual(s.regra52.situacao, 'ok'); assert.strictEqual(s.validacao.nivel, 'verde', JSON.stringify(s.validacao.itens)); assert.deepStrictEqual(trabDe(r, id), []); }
  assert.ok(!r.conflitos.operacionais.some(c => c.codigo === 'folga_rotativa_colada'), 'no modelo flexível folga colada não é nem aviso'); assert.strictEqual(r.validacaoSemanal.vermelho, 0);
  // o próprio motor passa a usar as duas formas: o que decide é a melhor solução válida
  const g = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB }); const D = g.distribuicaoFolgas;
  assert.strictEqual(D.semanas, 36); assert.ok(D.consecutivas > 0, 'há semanas com folgas juntas'); assert.ok(D.separadas > 0, 'e semanas com folgas separadas'); assert.strictEqual(D.consecutivas + D.separadas, 36); assert.strictEqual(D.fixaRotativa, 36);
  assert.deepStrictEqual(g.validacaoSemanal, { semanas: 36, verde: 36, amarelo: 0, vermelho: 0, cinza: 0 }); assert.deepStrictEqual(g.conflitos.trabalhistas, []);
  for (const p of g.proposta) { assert.ok(maiorSequencia(p.dias) <= 6); for (const s of p.semanas) assert.strictEqual(s.regra52.folgas, 2); }
  // folga no domingo de uma semana e na segunda da outra (duas semanas diferentes): também é válido
  const viz = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: { '1|2026-11-08': FG() } });
  assert.strictEqual(viz.proposta.find(p => p.id === 1).dias['2026-11-09'].folga, 'fixa'); assert.strictEqual(semDe(viz, 1, '2026-11-02').regra52.folgas, 2); assert.strictEqual(semDe(viz, 1, '2026-11-09').regra52.folgas, 2); assert.deepStrictEqual(trabDe(viz, 1), []);
  // "preferir separadas" continua disponível na regra, como preferência da convenção — nunca como obrigação
  const ev = G.gerar({ ...SEG, funcionarios: equipe(), regras: [{ ...REGRA_OK, params: { folgasConsecutivas: 'evitar' } }], cobertura: COB }); assert.strictEqual(ev.distribuicaoFolgas.consecutivas, 0);
  assert.strictEqual(G.PARAMS_PADRAO.folgasConsecutivas, 'livre');
});

test('modelo flexível · folgas separadas, três folgas e apenas uma folga: a conta continua sendo exatamente duas (F + FR)', () => {
  const g = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  const sep = g.proposta.flatMap(p => p.semanas.filter(s => !s.regra52.consecutivas)); assert.ok(sep.length > 0); for (const s of sep) { assert.strictEqual(s.regra52.folgas, 2); assert.strictEqual(s.trabalho, 5); assert.strictEqual(s.validacao.nivel, 'verde'); }
  // três folgas, duas delas juntas: bloqueio
  const tres = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: { '3|2026-11-12': FG(), '3|2026-11-13': FG(), '3|2026-11-15': FG() } });
  assert.strictEqual(semDe(tres, 3, '2026-11-09').regra52.folgas, 3); assert.strictEqual(nivelDe(tres, 3, '2026-11-09'), 'vermelho'); assert.strictEqual(itemDe(tres, 3, '2026-11-09', 'folgas_semana_excesso').gravidade, 'bloqueio');
  assert.strictEqual(tres.proposta.find(p => p.id === 3).dias['2026-11-11'].tipo, 'trabalho', 'a folga fixa não entra como 4ª folga');
  // apenas uma folga: bloqueio
  const trav = {}; for (const d of semana('2026-11-09').slice(1)) trav['1|' + d] = TR('07:00', '15:00', '11:00', '12:00');
  const uma = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, travados: trav });
  assert.strictEqual(semDe(uma, 1, '2026-11-09').regra52.folgas, 1); assert.strictEqual(nivelDe(uma, 1, '2026-11-09'), 'vermelho'); assert.strictEqual(itemDe(uma, 1, '2026-11-09', 'folgas_semana_falta').gravidade, 'bloqueio');
});

test('modelo flexível · virada de mês e de ano: folgas juntas que atravessam a virada contam na mesma semana', () => {
  // 30/11 (segunda) e 01/12 (terça) de folga: a mesma semana, em dois meses
  const nov = G.gerar({ de: '2026-11-02', ate: '2026-11-30', funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB });
  const h = JSON.parse(JSON.stringify(nov.continuidade)); h[4].dias['2026-11-30'] = { tipo: 'folga', fonte: 'escala' };
  const dez = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: h, travados: { '4|2026-12-01': FG() } }); const s = semDe(dez, 4, '2026-11-30');
  assert.deepStrictEqual(s.dias.filter(d => d.tipo === 'folga').map(d => d.data), ['2026-11-30', '2026-12-01']); assert.strictEqual(s.regra52.consecutivas, true); assert.strictEqual(s.regra52.folgas, 2); assert.strictEqual(s.trabalho, 5); assert.strictEqual(s.regra52.situacao, 'ok');
  assert.ok(!dez.conflitos.trabalhistas.some(c => c.funcId === 4 && /^folgas_semana/.test(c.codigo))); assert.strictEqual(dez.proposta.find(p => p.id === 4).dias['2026-12-03'].tipo, 'trabalho', 'a folga fixa de quinta cedeu: a semana já tinha as duas');
  // 31/12/2026 (quinta) e 01/01/2027 (sexta) de folga: a mesma semana, em dois anos
  const d26 = G.gerar({ ...DEZ, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB }); const h2 = JSON.parse(JSON.stringify(d26.continuidade));
  for (const d of ['2026-12-28', '2026-12-29', '2026-12-30']) h2[1].dias[d] = TR(); h2[1].dias['2026-12-31'] = { tipo: 'folga', fonte: 'escala' };
  const jan = G.gerar({ ...JAN, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: h2, travados: { '1|2027-01-01': FG() } }); const sj = semDe(jan, 1, '2026-12-28');
  assert.strictEqual(sj.fim, '2027-01-03'); assert.deepStrictEqual(sj.dias.filter(d => d.tipo === 'folga').map(d => d.data), ['2026-12-31', '2027-01-01']); assert.strictEqual(sj.regra52.consecutivas, true); assert.strictEqual(sj.regra52.folgas, 2); assert.strictEqual(sj.trabalho, 5);
  assert.ok(!jan.conflitos.trabalhistas.some(c => c.funcId === 1 && /^folgas_semana/.test(c.codigo)), JSON.stringify(jan.conflitos.trabalhistas.filter(c => c.funcId === 1)));
  // e o sábado 02/01 + domingo 03/01 juntos, para quem trabalhou a semana inteira de dezembro
  for (const d of ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31']) h2[2].dias[d] = TR();
  const fds = G.gerar({ ...JAN, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB, historico: h2, travados: { '2|2027-01-01': TR(), '2|2027-01-02': FG(), '2|2027-01-03': FG() } }); const sf = semDe(fds, 2, '2026-12-28');
  assert.strictEqual(sf.regra52.folgas, 2); assert.strictEqual(sf.regra52.consecutivas, true); assert.strictEqual(sf.trabalho, 5); assert.strictEqual(sf.regra52.situacao, 'ok');
});

test('modelo flexível · férias e afastamentos: preservados e fora da conta, com as folgas da semana juntas ou separadas', () => {
  const eq = equipe();
  eq[2].ausencias = [{ inicio: '2026-11-09', fim: '2026-11-10', tipo: 'ferias' }];        // func 3: férias na segunda e na terça
  eq[4].ausencias = [{ inicio: '2026-11-16', fim: '2026-11-22', tipo: 'afastado' }];      // func 5: afastado a semana inteira
  const r = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK], cobertura: COB, travados: { '3|2026-11-12': FG() } }); const p = r.proposta.find(x => x.id === 3), s = semDe(r, 3, '2026-11-09');
  assert.deepStrictEqual(semana('2026-11-09').map(d => p.dias[d].tipo).slice(0, 4), ['ferias', 'ferias', 'folga', 'folga'], 'férias, depois a folga fixa de quarta e a folga de quinta juntas');
  assert.strictEqual(s.ausencias, 2); assert.strictEqual(s.regra52.folgas, 2); assert.strictEqual(s.regra52.consecutivas, true); assert.strictEqual(s.trabalho, 3); assert.strictEqual(s.validacao.nivel, 'cinza', 'semana com férias é excepcional');
  assert.strictEqual(nivelDe(r, 5, '2026-11-16'), 'cinza'); assert.strictEqual(semDe(r, 5, '2026-11-16').regra52.folgas, 0); for (const d of semana('2026-11-16')) assert.strictEqual(r.proposta.find(x => x.id === 5).dias[d].tipo, 'afastado');
  assert.ok(!r.conflitos.trabalhistas.some(c => /^folgas_semana/.test(c.codigo)), JSON.stringify(r.conflitos.trabalhistas)); assert.strictEqual(r.validacaoSemanal.vermelho, 0);
});

test('modelo flexível · conflitos operacionais: o motor junta as folgas quando isso preserva a cobertura; a lei e a folga fixa vêm antes de qualquer critério operacional', () => {
  // setor de 2 pessoas: A folga fixa segunda, B folga fixa quinta; de quarta a domingo o setor precisa dos dois o dia inteiro
  const dupla = () => [func(1, 'BALCAO', 1), func(2, 'BALCAO', 4)]; const pico = { abre: '07:00', fecha: '19:00', setores: { BALCAO: { min: 0, faixas: [3, 4, 5, 6, 0].map(d => ({ dias: [d], ini: '07:00', fim: '19:00', min: 2 })) } } };
  const flex = G.gerar({ ...SEG, funcionarios: dupla(), regras: [SEM_DOM], cobertura: pico }); const sep = G.gerar({ ...SEG, funcionarios: dupla(), regras: [{ ...SEM_DOM, params: { ...SEM_DOM.params, folgasConsecutivas: 'evitar' } }], cobertura: pico });
  // flexível: a rotativa de A vai para a terça, colada na folga fixa de segunda — o único dia em que o setor não fica descoberto
  const pa = flex.proposta.find(p => p.id === 1); for (const sg of ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']) { assert.deepStrictEqual(semana(sg).filter(d => pa.dias[d].tipo === 'folga'), [sg, soma(sg, 1)], 'segunda (fixa) + terça (rotativa)'); assert.strictEqual(pa.dias[soma(sg, 1)].folga, 'rotativa'); }
  assert.strictEqual(consec(flex, 1), 4); assert.deepStrictEqual(flex.conflitos.trabalhistas, []); assert.strictEqual(flex.validacaoSemanal.verde, 8);
  // com a preferência antiga (separadas) a rotativa de A saía da terça e abria buraco num dia de pico
  assert.strictEqual(consec(sep, 1), 0); assert.ok(flex.cobertura.resumo.blocos_abaixo < sep.cobertura.resumo.blocos_abaixo, 'flexível: ' + flex.cobertura.resumo.blocos_abaixo + ' blocos abaixo do mínimo; separadas: ' + sep.cobertura.resumo.blocos_abaixo);
  // 3. folga fixa cadastrada vem antes da cobertura: a quinta de B é dia de pico e continua sendo a folga dele
  for (const [d, x] of Object.entries(flex.proposta.find(p => p.id === 2).dias)) if (dow(d) === 4) assert.strictEqual(x.folga, 'fixa');
  // 1. obrigação legal vem antes de tudo: com o domingo como dia de maior movimento (peso 5) e pico de cobertura, o descanso
  // dominical da regra continua sendo dado, e ninguém passa de 6 dias seguidos
  const legal = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: { ...COB, pesoDia: { 0: 5 }, setores: { CAIXA: { min: 2, faixas: [{ dias: [0], ini: '07:00', fim: '19:00', min: 6 }] }, REPOSICAO: { min: 1 } } } });
  assert.deepStrictEqual(legal.conflitos.trabalhistas, [], JSON.stringify(legal.conflitos.trabalhistas)); for (const p of legal.proposta) { assert.ok(p.domingosFolga >= 1, p.nome + ' sem domingo de folga'); assert.ok(maiorSequencia(p.dias) <= 6); }
  assert.ok(legal.conflitos.operacionais.some(c => c.codigo === 'cobertura_abaixo'), 'o que cede é a cobertura, e fica acusado');
  // 4. cobertura por turno: dois abridores e um fechador no setor — os dois da abertura não folgam no mesmo dia
  const turno = [func(1, 'ACOUGUE', null, { duasRotativas: true }), func(2, 'ACOUGUE', null, { duasRotativas: true }), func(3, 'ACOUGUE', null, { duasRotativas: true, entrada: '08:36' })];
  const rt = G.gerar({ ...SEG, funcionarios: turno, regras: [SEM_DOM], cobertura: { abre: '07:00', fecha: '19:00', setores: { ACOUGUE: { min: 1 } } } });
  for (let d = SEG.de; d <= SEG.ate; d = soma(d, 1)) assert.ok(!(rt.proposta[0].dias[d].tipo === 'folga' && rt.proposta[1].dias[d].tipo === 'folga'), 'os dois da abertura de folga em ' + d);
});

test('modelo flexível · duas folgas rotativas só com autorização no cadastro; sem folga fixa e sem autorização fica pendente de conferência', () => {
  const eq = equipe(); eq[0].duasRotativas = true;                 // func 1: autorizado (a folga fixa de segunda deixa de valer)
  eq[6].folga_fixa = null;                                         // func 7: sem folga fixa e sem autorização
  const r = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK], cobertura: COB }); const p1 = r.proposta.find(p => p.id === 1), p7 = r.proposta.find(p => p.id === 7);
  assert.strictEqual(p1.folgaModelo, 'duas_rotativas'); assert.deepStrictEqual(p1.folga_fixa, []); assert.strictEqual(p7.folgaModelo, 'indefinido'); assert.strictEqual(r.proposta.find(p => p.id === 2).folgaModelo, 'fixa_rotativa');
  for (const p of [p1, p7]) for (const s of p.semanas) { assert.strictEqual(s.regra52.folgas, 2); assert.strictEqual(s.regra52.rotativas, 2); assert.strictEqual(s.regra52.fixas, 0); assert.strictEqual(s.validacao.nivel, 'verde'); }
  assert.ok(Object.values(p1.dias).filter(x => x.tipo === 'folga').every(x => x.folga === 'rotativa')); assert.ok(new Set(Object.entries(p1.dias).filter(([, x]) => x.tipo === 'folga').map(([d]) => dow(d))).size >= 3, 'as rotativas rodam entre os dias');
  const av = r.conflitos.operacionais.filter(c => c.codigo === 'sem_folga_fixa'); assert.deepStrictEqual(av.map(c => c.funcId), [7], 'só quem não tem folga fixa NEM autorização'); assert.strictEqual(av[0].gravidade, 'alerta'); assert.strictEqual(av[0].regra, 'Modelo de folga do funcionário'); assert.match(av[0].sugestao, /autorizar as duas folgas rotativas/);
  assert.strictEqual(r.distribuicaoFolgas.pessoasDuasRotativas, 1); assert.strictEqual(r.distribuicaoFolgas.pessoasSemModelo, 1); assert.strictEqual(r.distribuicaoFolgas.duasRotativas, 8); assert.strictEqual(r.distribuicaoFolgas.fixaRotativa, 28);
  assert.deepStrictEqual(r.conflitos.trabalhistas, []); for (const p of r.proposta) assert.ok(maiorSequencia(p.dias) <= 6);
});

test('modelo flexível · menos alteração na escala existente: entre soluções equivalentes a folga fica onde já estava; critério de cima continua vencendo', () => {
  const um = () => [func(1, 'CAIXA', 1)]; const livre = { abre: '07:00', fecha: '19:00', setores: {} }; const ent = { ...SEG, funcionarios: um(), regras: [SEM_DOM], cobertura: livre };
  const a = G.gerar(ent); const rotDe = (r, sg) => semana(sg).find(d => r.proposta[0].dias[d].folga === 'rotativa'); assert.strictEqual(a.alteracoes, null, 'sem escala anterior não há o que comparar');
  // a mesma escala como "existente": a proposta não mexe em nada
  const igual = {}; for (const [d, x] of Object.entries(a.proposta[0].dias)) igual['1|' + d] = x; const b = G.gerar({ ...ent, atual: igual });
  assert.deepStrictEqual(b.proposta[0].dias, a.proposta[0].dias); assert.strictEqual(b.alteracoes.mudam, 0); assert.strictEqual(b.alteracoes.folgasMovidas, 0); assert.strictEqual(b.alteracoes.folgasMantidas, 8); assert.strictEqual(b.alteracoes.pessoas, 0);
  // escala existente com a rotativa da 1ª semana em outro dia igualmente bom: o motor repete o dia em vez de trocar
  const outro = ['2026-11-04', '2026-11-05', '2026-11-06'].find(d => d !== rotDe(a, '2026-11-02')); const ex = { ...igual, ['1|' + rotDe(a, '2026-11-02')]: TR(), ['1|' + outro]: { ...FG(), folga: 'rotativa' } };
  const c = G.gerar({ ...ent, atual: ex }); assert.strictEqual(rotDe(c, '2026-11-02'), outro, 'a folga ficou onde já estava'); assert.ok(c.alteracoes.folgasMantidas >= 5);
  // …mas não segura a folga num dia pior para a cobertura: aqui a escala existente tem a rotativa de A no sábado (pico)
  const dupla = [func(1, 'BALCAO', 1), func(2, 'BALCAO', 4)]; const pico = { abre: '07:00', fecha: '19:00', setores: { BALCAO: { min: 0, faixas: [3, 4, 5, 6, 0].map(d => ({ dias: [d], ini: '07:00', fim: '19:00', min: 2 })) } } };
  const d = G.gerar({ ...SEG, funcionarios: dupla, regras: [SEM_DOM], cobertura: pico, atual: { '1|2026-11-07': { ...FG('BALCAO'), folga: 'rotativa' }, '1|2026-11-03': TR('07:00', '17:24', '11:00', '13:00', 'BALCAO') } });
  assert.strictEqual(d.proposta[0].dias['2026-11-03'].folga, 'rotativa'); assert.strictEqual(d.proposta[0].dias['2026-11-07'].tipo, 'trabalho'); assert.strictEqual(d.alteracoes.folgasMovidas, 1);
});

// ═══ ETAPA 7 — revezamento dominical feminino 1×1 (art. 386 da CLT) e verificação legal independente ═══════
// Mulheres: 1, 2, 4, 6 (CAIXA) e 7, 9 (REPOSICAO). Homens: 3, 5 (CAIXA) e 8 (REPOSICAO).
const comSexo = () => { const eq = equipe(); ['F', 'F', 'M', 'F', 'M', 'F', 'F', 'M', 'F'].forEach((s, i) => { eq[i].sexo = s; }); return eq; };
const MULHERES = [1, 2, 4, 6, 7, 9], HOMENS = [3, 5, 8];
const domingos = dias => Object.keys(dias).filter(d => dow(d) === 0).sort().map(d => dias[d].tipo === 'trabalho' ? 'T' : dias[d].tipo === 'folga' ? 'F' : 'A').join('');
const ATIVO = { dominicalFeminino: { ativo: true } }, INATIVO = { dominicalFeminino: { ativo: false } };

test('dominical feminino · ativado: as trabalhadoras alternam um domingo trabalhado e um de descanso; o domingo de descanso é uma das duas folgas e a outra continua flexível', () => {
  const r = G.gerar({ ...SEG, funcionarios: comSexo(), regras: [REGRA_OK], cobertura: COB, ...ATIVO });
  for (const id of MULHERES) { const p = r.proposta.find(x => x.id === id); assert.strictEqual(p.sexo, 'F'); assert.strictEqual(p.dominical1x1, true);
    assert.ok(['TFTF', 'FTFT'].includes(domingos(p.dias)), p.nome + ': domingos ' + domingos(p.dias)); assert.strictEqual(p.domingosTrabalhados, 2); assert.strictEqual(p.domingosFolga, 2);
    for (const s of p.semanas) { assert.strictEqual(s.regra52.folgas, 2, p.nome + ' ' + s.inicio); assert.strictEqual(s.trabalho, 5); assert.strictEqual(s.validacao.nivel, 'verde');
      if (p.dias[s.fim].tipo === 'folga') { const outra = semana(s.inicio).slice(0, 6).filter(d => p.dias[d].tipo === 'folga'); assert.strictEqual(outra.length, 1, 'o domingo de descanso conta como uma das duas folgas'); assert.strictEqual(p.dias[outra[0]].folga, 'fixa', 'a outra é a folga fixa dela'); } }
    assert.ok(maiorSequencia(p.dias) <= 6); }
  // quem tem duas folgas rotativas: no domingo de descanso a segunda folga cai em qualquer dia (flexível)
  const eq = comSexo(); eq[0].duasRotativas = true; const flex = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK], cobertura: COB, ...ATIVO }).proposta.find(p => p.id === 1);
  assert.ok(['TFTF', 'FTFT'].includes(domingos(flex.dias))); for (const s of flex.semanas) assert.strictEqual(s.regra52.folgas, 2); assert.ok(new Set(Object.entries(flex.dias).filter(([d, x]) => x.tipo === 'folga' && dow(d) !== 0).map(([d]) => dow(d))).size >= 2);
  // os homens seguem o revezamento geral da regra (aqui, folga no domingo a cada 3 semanas)
  for (const id of HOMENS) { const p = r.proposta.find(x => x.id === id); assert.strictEqual(p.sexo, 'M'); assert.strictEqual(p.dominical1x1, false); assert.ok(!/TTT/.test(domingos(p.dias)), p.nome + ' ' + domingos(p.dias)); }
  assert.deepStrictEqual(r.conflitos.trabalhistas, [], JSON.stringify(r.conflitos.trabalhistas)); assert.strictEqual(r.validacaoSemanal.vermelho, 0);
  assert.deepStrictEqual({ ...r.dominicalFeminino, semSexoIds: undefined }, { ativo: true, mulheres: 6, homens: 3, semSexo: 0, semSexoIds: undefined, alternando: 6, violacoes: 0 });
  // a cobertura é revalidada com a escala alternada: em cada domingo metade das trabalhadoras do Caixa está de folga, e o que faltar sai acusado
  for (const d of ['2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']) { const fora = [1, 2, 4, 6].filter(id => r.proposta.find(p => p.id === id).dias[d].tipo === 'folga').length; assert.strictEqual(fora, 2, 'trabalhadoras do Caixa de folga em ' + d);
    const c = r.cobertura.dias.find(x => x.data === d).setores.find(x => x.setor === 'CAIXA'); assert.strictEqual(c.escalados + c.folgas, 6); }
});

test('dominical feminino · o ciclo 1×1 continua entre meses e anos (novembro → dezembro → janeiro), pelo histórico', () => {
  const base = { funcionarios: comSexo(), regras: [REGRA_OK], cobertura: COB, ...ATIVO };
  const nov = G.gerar({ de: '2026-11-02', ate: '2026-11-30', ...base }); const dez = G.gerar({ ...DEZ, ...base, historico: nov.continuidade }); const jan = G.gerar({ ...JAN, ...base, historico: dez.continuidade });
  for (const id of MULHERES) { const tudo = { ...nov.proposta.find(p => p.id === id).dias, ...dez.proposta.find(p => p.id === id).dias, ...jan.proposta.find(p => p.id === id).dias }; const seq = domingos(tudo);
    assert.strictEqual(seq.length, 13, '8/11 a 31/01'); assert.ok(/^(TF)+T?$|^(FT)+F?$/.test(seq), 'func ' + id + ': ' + seq);
    assert.notStrictEqual(tudo['2026-11-29'].tipo, tudo['2026-12-06'].tipo, 'virada de mês'); assert.notStrictEqual(tudo['2026-12-27'].tipo, tudo['2027-01-03'].tipo, 'virada de ano'); }
  for (const r of [nov, dez, jan]) { assert.deepStrictEqual(r.conflitos.trabalhistas, [], JSON.stringify(r.conflitos.trabalhistas)); assert.strictEqual(r.dominicalFeminino.violacoes, 0); }
  // o histórico é o que manda: quem trabalhou no último domingo de novembro (registro real) descansa em 06/12, mesmo sem a geração anterior
  const h = {}; for (const f of comSexo()) h[f.id] = { dias: { '2026-11-29': f.id === 1 ? TR() : FG(), '2026-11-28': FG() } };
  const d2 = G.gerar({ ...DEZ, ...base, historico: h });
  assert.strictEqual(d2.proposta.find(p => p.id === 1).dias['2026-12-06'].tipo, 'folga', 'trabalhou em 29/11: descansa em 06/12');
  // as demais vinham de descanso em 29/11: para não ficarem todas no mesmo domingo, metade de cada setor começa pelo descanso
  // (dois domingos de folga seguidos não ferem a lei) e o ciclo segue defasado. No Caixa (4 trabalhadoras) descansam 2 em 06/12:
  // a que trabalhou em 29/11 e mais uma; na Reposição (2), uma
  assert.strictEqual([1, 2, 4, 6].filter(id => d2.proposta.find(p => p.id === id).dias['2026-12-06'].tipo === 'folga').length, 2); for (const id of MULHERES) assert.ok(['TFTF', 'FTFT'].includes(domingos(d2.proposta.find(p => p.id === id).dias)), 'func ' + id);
  const rep = [7, 9].map(id => domingos(d2.proposta.find(p => p.id === id).dias)); assert.deepStrictEqual(rep.slice().sort(), ['FTFT', 'TFTF'], 'Reposição: ' + rep);
  assert.deepStrictEqual(d2.conflitos.trabalhistas, [], JSON.stringify(d2.conflitos.trabalhistas));
});

test('dominical feminino · desativado: o gerador não impõe o 1×1, mas a verificação do art. 386 continua e bloqueia a publicação', () => {
  const r = G.gerar({ ...SEG, funcionarios: comSexo(), regras: [REGRA_OK], cobertura: COB, ...INATIVO });
  assert.strictEqual(r.dominicalFeminino.ativo, false); assert.strictEqual(r.dominicalFeminino.alternando, 0); assert.ok(r.proposta.every(p => p.dominical1x1 === false));
  // sem o padrão automático as trabalhadoras seguem o revezamento geral (até 2 domingos seguidos de trabalho)…
  const comDois = MULHERES.filter(id => /TT/.test(domingos(r.proposta.find(p => p.id === id).dias))); assert.ok(comDois.length > 0, 'alguma trabalhadora ficou com dois domingos seguidos');
  // …e cada ocorrência é acusada como bloqueio, só para as mulheres
  const v = r.conflitos.trabalhistas.filter(c => c.codigo === 'domingo_art386'); assert.ok(v.length >= comDois.length); assert.strictEqual(r.dominicalFeminino.violacoes, v.length);
  for (const c of v) { assert.ok(MULHERES.includes(c.funcId)); assert.strictEqual(c.gravidade, 'bloqueio'); assert.match(c.texto, /2º domingo seguido de trabalho.*art\. 386 da CLT/); assert.strictEqual(c.regra, 'Revezamento dominical quinzenal — art. 386 da CLT (trabalho da mulher)'); assert.match(c.sugestao, /Revezamento dominical feminino — 1×1/);
    assert.strictEqual(dow(c.ref), 0); assert.deepStrictEqual(c.dias, [soma(c.ref, -7), c.ref]); assert.strictEqual(nivelDe(r, c.funcId, segunda(c.ref)), 'vermelho'); }
  assert.ok(!r.conflitos.trabalhistas.some(c => HOMENS.includes(c.funcId)), 'homem com dois domingos seguidos está dentro da regra geral'); assert.ok(HOMENS.some(id => /TT/.test(domingos(r.proposta.find(p => p.id === id).dias))));
  assert.ok(r.publicacao.bloqueios.some(b => b.codigo === 'conflito_trabalhista'), 'escala em desacordo não é publicável');
  // ativar resolve as mesmas pessoas, sem mexer em mais nada da entrada
  assert.strictEqual(G.gerar({ ...SEG, funcionarios: comSexo(), regras: [REGRA_OK], cobertura: COB, ...ATIVO }).dominicalFeminino.violacoes, 0);
});

test('dominical feminino · validação na semana que atravessa o mês e respeito aos períodos protegidos', () => {
  const base = { ...DEZ, funcionarios: comSexo(), regras: [REGRA_OK], cobertura: COB };
  // func 2 trabalhou no domingo 29/11 (registro de novembro) e está fixa para trabalhar no domingo 06/12: semana 30/11–06/12
  const h = { 2: { dias: { '2026-11-28': FG(), '2026-11-29': TR() } } }; const trav = { '2|2026-12-06': TR() };
  for (const modo of [ATIVO, INATIVO]) { const r = G.gerar({ ...base, ...modo, historico: h, travados: trav }); const c = r.conflitos.trabalhistas.filter(x => x.funcId === 2 && x.codigo === 'domingo_art386' && x.ref === '2026-12-06');
    assert.strictEqual(c.length, 1, 'com a regra ' + (modo.dominicalFeminino.ativo ? 'ativada' : 'desativada')); assert.strictEqual(c[0].ref, '2026-12-06'); assert.deepStrictEqual(c[0].dias, ['2026-11-29', '2026-12-06'], 'o domingo anterior é de outro mês');
    assert.match(c[0].texto, /06\/12 \(o anterior foi 29\/11\)/); assert.strictEqual(semDe(r, 2, '2026-11-30').validacao.nivel, 'vermelho'); assert.strictEqual(r.proposta.find(p => p.id === 2).dias['2026-12-06'].travado, true, 'o dia fixo não é mexido: fica acusado'); }
  // sem o dia fixo, com a regra ativa o gerador dá o descanso em 06/12; desativada, a verificação continua valendo para o que ele gerar
  const livre = G.gerar({ ...base, ...ATIVO, historico: h }); assert.strictEqual(livre.proposta.find(p => p.id === 2).dias['2026-12-06'].tipo, 'folga'); assert.strictEqual(livre.dominicalFeminino.violacoes, 0);
  // férias e folga fixa são respeitadas: func 4 (folga fixa quinta) em férias de 09 a 15/11 — o domingo das férias não é trabalho nem folga, e o ciclo recomeça depois
  const eq = comSexo(); eq[3].ausencias = [{ inicio: '2026-11-09', fim: '2026-11-15', tipo: 'ferias' }]; const f = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK], cobertura: COB, ...ATIVO }); const p4 = f.proposta.find(p => p.id === 4);
  assert.strictEqual(p4.dias['2026-11-15'].tipo, 'ferias'); assert.ok(!/TT/.test(domingos(p4.dias)), domingos(p4.dias)); for (const [d, x] of Object.entries(p4.dias)) if (dow(d) === 4 && x.tipo !== 'ferias') assert.strictEqual(x.folga, 'fixa');
  assert.deepStrictEqual(f.conflitos.trabalhistas, [], JSON.stringify(f.conflitos.trabalhistas));
  // folga dada à mão num domingo é preservada e conta no ciclo: o domingo seguinte é de trabalho
  const m = G.gerar({ ...SEG, funcionarios: comSexo(), regras: [REGRA_OK], cobertura: COB, ...ATIVO, travados: { '6|2026-11-08': FG(), '6|2026-11-15': TR() } }); const p6 = m.proposta.find(p => p.id === 6);
  assert.strictEqual(p6.dias['2026-11-08'].travado, true); assert.strictEqual(p6.dias['2026-11-22'].tipo, 'folga', 'trabalhou em 15/11: descansa em 22/11'); assert.deepStrictEqual(m.conflitos.trabalhistas.filter(c => c.funcId === 6), []);
});

test('dominical feminino · sem o sexo informado ninguém é presumido: a pessoa fica fora da regra e isso sai acusado', () => {
  const eq = comSexo(); delete eq[0].sexo; eq[1].sexo = null; eq[2].sexo = 'Feminino'; eq[4].sexo = 'masculino';
  const r = G.gerar({ ...SEG, funcionarios: eq, regras: [REGRA_OK], cobertura: COB, ...ATIVO }); const D = r.dominicalFeminino;
  assert.strictEqual(D.semSexo, 2); assert.deepStrictEqual(D.semSexoIds, [1, 2]); assert.strictEqual(D.mulheres, 5); assert.strictEqual(D.homens, 2); assert.strictEqual(D.alternando, 5);
  assert.strictEqual(r.proposta.find(p => p.id === 1).sexo, null); assert.strictEqual(r.proposta.find(p => p.id === 1).dominical1x1, false); assert.strictEqual(r.proposta.find(p => p.id === 3).sexo, 'F'); assert.strictEqual(r.proposta.find(p => p.id === 3).dominical1x1, true);
  const a = r.conflitos.operacionais.filter(c => c.codigo === 'sexo_nao_informado'); assert.strictEqual(a.length, 1); assert.strictEqual(a[0].gravidade, 'alerta'); assert.strictEqual(a[0].funcId, null); assert.match(a[0].texto, /2 funcionário\(s\) sem o sexo informado \(Func 1, Func 2\).*art\. 386/);
  assert.ok(!r.conflitos.trabalhistas.some(c => c.codigo === 'domingo_art386' && [1, 2].includes(c.funcId)), 'sem o dado não há verificação — nem acusação inventada');
  // chamada antiga (sem a configuração): o motor não acusa nada sobre sexo e não aplica o 1×1
  const antigo = G.gerar({ ...SEG, funcionarios: equipe(), regras: [REGRA_OK], cobertura: COB }); assert.ok(!antigo.conflitos.operacionais.some(c => c.codigo === 'sexo_nao_informado')); assert.strictEqual(antigo.dominicalFeminino.ativo, false); assert.strictEqual(antigo.dominicalFeminino.semSexo, 9);
  // a partida a frio (sem histórico) não gera acusação: só conta domingo que consta de fato
  const frio = G.gerar({ ...SEG, funcionarios: comSexo(), regras: [REGRA_OK], cobertura: COB, ...INATIVO }); for (const c of frio.conflitos.trabalhistas.filter(x => x.codigo === 'domingo_art386')) assert.notStrictEqual(c.ref, '2026-11-08', 'no primeiro domingo do período não existe domingo anterior registrado');
});
