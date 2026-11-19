'use strict';
// lib/escalas-planilha.js — motor PURO da escala "modelo da planilha" (Tiago, 19/11/2026, a partir da ESCALA LOJA 5.pdf).
// Não lê arquivo, não faz require e não conhece loja nem ponto: recebe o quadro e devolve a escala do PERÍODO pedido.
//
// Regras adotadas na planilha (medidas nela, 57 linhas × 3 semanas):
//   · 5×2 com a semana de DOMINGO a SÁBADO: cinco dias de trabalho, uma FOLGA FIXA (sempre o mesmo dia da semana de cada
//     pessoa, de segunda a sábado) e o descanso do domingo;
//   · quem TRABALHA o domingo ganha uma FOLGA ROTATIVA de segunda a sábado daquela mesma semana (no lugar do domingo);
//   · a rotativa nunca cai no dia da fixa e evita ao máximo ficar colada nela (na planilha: 6 de 77 coladas);
//   · cada função tem um efetivo de domingo (Caixa 8 de 12, Seção 5 de 9…) e as pessoas se revezam nele;
//   · as folgas se espalham pelos dias dentro da função (Caixa: 4 fora por dia) — a rotativa vai para o dia mais vazio;
//   · cada pessoa tem o seu turno (T.1…T.5); no domingo o turno de fechamento vira o turno de domingo (T.3 → T.4).
// Códigos e cores são os da planilha e não mudam: é por eles que a loja lê a escala.

const DSEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const COR_FOLGA = '#07973E';
const TURNOS_PADRAO = {
  'T.1': { entrada: '07:00', saida: '17:24', almoco_ini: '11:00', almoco_fim: '13:00', cor: '#FFE699', domingo: 'T.1' },
  'T.2': { entrada: '08:30', saida: '18:54', almoco_ini: '12:00', almoco_fim: '14:00', cor: '#009DE0', domingo: 'T.1' },
  'T.3': { entrada: '09:36', saida: '20:00', almoco_ini: '13:00', almoco_fim: '15:00', cor: '#80207E', domingo: 'T.4' },
  'T.4': { entrada: '07:36', saida: '18:00', almoco_ini: '13:00', almoco_fim: '15:00', cor: '#FFED00', domingo: 'T.4' },
  'T.5': { entrada: '06:30', saida: '16:54', almoco_ini: '11:00', almoco_fim: '13:00', cor: '#A2C037', domingo: 'T.5' },
};
const PARAMS_PADRAO = { maxDiasSeguidos: 6, maxDomingosSeguidos: 2, maxDias: 92 };
// Peso do dia na escolha da rotativa, em "pessoas a menos": a planilha guarda o sábado (46 de 57 trabalhando) e a sexta (43).
const PESO_DIA_PADRAO = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 2 };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const soma = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = d => new Date(d + 'T12:00:00Z').getUTCDay();
const domingoDe = d => soma(d, -dow(d));
const min = hm => { const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
const liquido = t => { const e = min(t.entrada), s = min(t.saida), a = min(t.almoco_ini), b = min(t.almoco_fim); return e == null || s == null ? 0 : Math.max(0, s - e - (a != null && b != null ? b - a : 0)); };
const hhmm = m => Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
const br = d => d.slice(8) + '/' + d.slice(5, 7);
const erro = msg => Object.assign(new Error(msg), { status: 400 });

/** Efetivo de domingo de uma função quando ninguém informou: metade (arredondada para cima) de quem trabalha domingo. */
const efetivoPadrao = n => Math.ceil(n / 2);

/** Folga fixa sugerida para quem ainda não tem: o dia (seg→sáb) com menos folgas fixas na função. Não depende do período. */
function sugerirFixas(pessoas) {
  const carga = {}; const de = g => carga[g] || (carga[g] = [0, 0, 0, 0, 0, 0, 0]);
  for (const p of pessoas) if (p.folgaFixa) de(p.grupo)[p.folgaFixa]++;
  for (const p of pessoas) {
    if (p.folgaFixa) continue; const c = de(p.grupo); let m = 1; for (let d = 2; d <= 6; d++) if (c[d] < c[m]) m = d;
    p.folgaFixa = m; p.fixaSugerida = true; c[m]++;
  }
}

/**
 * Gera a escala do período.
 * inp = { de, ate, pessoas: [{ id, nome, grupo, turno, folgaFixa (1..6), domingo (false = nunca trabalha domingo),
 *         ausencias: [{ inicio, fim, tipo: 'ferias' | 'afastado' }] }], turnos, efetivoDomingo: { grupo: n }, pesoDia: { 1..6: n },
 *         historico: { id: { 'AAAA-MM-DD': 'T' | 'F' } } (dias ANTES do período: trabalhou / folgou), params }
 */
function gerar(inp) {
  inp = inp || {}; const P = { ...PARAMS_PADRAO, ...(inp.params || {}) };
  const de = inp.de, ate = inp.ate; if (!ISO.test(de || '') || !ISO.test(ate || '') || ate < de) throw erro('Período inválido: informe início e fim');
  const dias = []; for (let d = de; d <= ate; d = soma(d, 1)) { dias.push(d); if (dias.length > P.maxDias) throw erro('Período longo demais: gere até ' + P.maxDias + ' dias por vez'); }
  const turnos = inp.turnos && Object.keys(inp.turnos).length ? inp.turnos : TURNOS_PADRAO; const codigos = Object.keys(turnos);
  const hist = inp.historico || {}; const peso = { ...PESO_DIA_PADRAO, ...(inp.pesoDia || {}) }; const alertas = [];
  const alerta = (nivel, codigo, p, texto, data) => alertas.push({ nivel, codigo, id: p ? p.id : null, nome: p ? p.nome : null, grupo: p ? p.grupo : null, data: data || null, texto });

  const pessoas = (inp.pessoas || []).map((p, i) => ({ id: p.id, nome: p.nome, grupo: p.grupo || 'Sem função', ordem: i, turno: turnos[p.turno] ? p.turno : null, folgaFixa: p.folgaFixa >= 1 && p.folgaFixa <= 6 ? +p.folgaFixa : null,
    domingo: p.domingo !== false, ausencias: (p.ausencias || []).filter(a => a && ISO.test(a.inicio || '') && ISO.test(a.fim || '')), vaga: !!p.vaga, extra: !!p.extra, cel: {}, rot: {}, domTrab: {} }));
  for (const p of pessoas) if (!p.turno) { p.turno = codigos[0]; p.turnoSugerido = true; alerta('alerta', 'sem_turno', p, p.nome + ' está sem turno no cadastro: usei ' + codigos[0] + '. Informe o turno da pessoa.'); }
  const semFixa = pessoas.filter(p => !p.folgaFixa); sugerirFixas(pessoas);
  for (const p of semFixa) alerta('alerta', 'sem_folga_fixa', p, p.nome + ' está sem folga fixa no cadastro: sugeri ' + DSEM[p.folgaFixa] + ' (o dia com menos folgas em ' + p.grupo + '). Grave no cadastro para ela não mudar.');

  const ausente = (p, d) => p.ausencias.find(a => a.inicio <= d && a.fim >= d) || null;
  // o que a pessoa fez num dia já decidido: 'T' trabalhou, 'F' não trabalhou, null = ainda não se sabe
  const feito = (p, d) => { const c = p.cel[d]; if (c) return c.tipo === 'trabalho' ? 'T' : 'F'; const h = (hist[p.id] || {})[d]; return h === 'T' || h === 'F' ? h : null; };

  const semanas = []; for (let s = domingoDe(de); s <= ate; s = soma(s, 7)) semanas.push(s);
  const grupos = [...new Set(pessoas.map(p => p.grupo))];
  const efetivo = {}; for (const g of grupos) { const el = pessoas.filter(p => p.grupo === g && p.domingo).length; const v = (inp.efetivoDomingo || {})[g]; efetivo[g] = Math.max(0, Math.min(el, v == null || v === '' || !(+v >= 0) ? efetivoPadrao(el) : Math.round(+v))); }

  // ── 1) Domingos: quem trabalha em cada um (revezamento dentro da função) ──
  const domAnteriores = (p, s, n) => { const out = []; for (let i = 1; i <= n; i++) { const d = soma(s, -7 * i); out.push(p.domTrab[d] != null ? (p.domTrab[d] ? 'T' : 'F') : feito(p, d)); } return out; };
  let semHistDom = 0;
  for (const s of semanas) {
    if (s < de) {                                                           // semana que já vinha correndo: o domingo é o que aconteceu
      for (const p of pessoas) { const h = (hist[p.id] || {})[s]; if (h === 'T') p.domTrab[s] = true; else if (h === 'F') p.domTrab[s] = false; else { p.domTrab[s] = false; if (p.domingo) semHistDom++; } }
      continue;
    }
    for (const g of grupos) {
      const todos = pessoas.filter(p => p.grupo === g);
      for (const p of todos) p.domTrab[s] = false;
      const cand = todos.filter(p => p.domingo && !ausente(p, s)); const precisa = Math.min(efetivo[g], cand.length);
      if (efetivo[g] > cand.length) alerta('alerta', 'domingo_sem_efetivo', null, g + ': o domingo ' + br(s) + ' pede ' + efetivo[g] + ' e só há ' + cand.length + ' disponível(is).', s);
      const nota = p => { const ant = domAnteriores(p, s, 6); let seguidos = 0; for (const x of ant) { if (x === 'T') seguidos++; else break; } return { p, feitos: ant.filter(x => x === 'T').length, seguidos, ultimo: ant[0] === 'T' ? 1 : 0 }; };
      const fila = cand.map(nota).sort((a, b) => (a.seguidos >= P.maxDomingosSeguidos) - (b.seguidos >= P.maxDomingosSeguidos) || a.feitos - b.feitos || a.ultimo - b.ultimo || a.p.ordem - b.p.ordem);
      // quem já trabalhou o limite de domingos seguidos descansa, mesmo que o domingo fique abaixo do efetivo (fica o alerta)
      const aptos = fila.filter(x => x.seguidos < P.maxDomingosSeguidos); aptos.slice(0, precisa).forEach(x => { x.p.domTrab[s] = true; });
      if (aptos.length < precisa) alerta('alerta', 'domingo_sem_revezamento', null, g + ': o domingo ' + br(s) + ' fica com ' + aptos.length + ' de ' + precisa + ' — ' + fila.filter(x => x.seguidos >= P.maxDomingosSeguidos).map(x => x.p.nome).join(', ') + ' já trabalhou ' + P.maxDomingosSeguidos + ' domingos seguidos e não há quem reveze.', s);
    }
  }
  if (semHistDom) alerta('info', 'semana_em_andamento', null, 'O período começa no meio de uma semana (' + DSEM[dow(de)] + ', ' + br(de) + ') e não há registro do domingo ' + br(domingoDe(de)) + ' para ' + semHistDom + ' pessoa(s): considerei que folgaram nele. Para começar limpo, inicie o período num domingo.');

  // ── 2) Folga fixa, ausências e dias de trabalho; depois a rotativa de quem trabalhou o domingo ──
  const foraNoGrupo = {}; const foraLoja = {};
  const marcaFora = (p, d, n) => { const k = p.grupo + '|' + d; foraNoGrupo[k] = (foraNoGrupo[k] || 0) + n; foraLoja[d] = (foraLoja[d] || 0) + n; };
  const todosDias = []; for (let d = semanas[0]; d <= soma(semanas[semanas.length - 1], 6); d = soma(d, 1)) todosDias.push(d);
  for (const p of pessoas) for (const d of todosDias) {
    if (d < de) continue; const w = dow(d); const a = ausente(p, d);
    if (a) { p.cel[d] = { tipo: a.tipo === 'ferias' ? 'ferias' : 'afastado' }; marcaFora(p, d, 1); }
    else if (w === 0) { if (p.domTrab[d]) p.cel[d] = { tipo: 'trabalho', turno: turnos[p.turno].domingo && turnos[turnos[p.turno].domingo] ? turnos[p.turno].domingo : p.turno }; else { p.cel[d] = { tipo: 'folga', folga: 'domingo' }; marcaFora(p, d, 1); } }
    else if (w === p.folgaFixa) { p.cel[d] = { tipo: 'folga', folga: 'fixa' }; marcaFora(p, d, 1); }
    else p.cel[d] = { tipo: 'trabalho', turno: p.turno };
  }
  const maiorSequencia = (p, ini, fim) => { let run = 0, max = 0; for (let d = soma(ini, -P.maxDiasSeguidos - 1); d <= fim; d = soma(d, 1)) { if (feito(p, d) === 'T') { run++; if (d >= ini && run > max) max = run; } else run = 0; } return max; };
  semanas.forEach((s, si) => {
    const fila = pessoas.filter(p => p.domTrab[s]).sort((a, b) => ((a.ordem + si * 3) % 7) - ((b.ordem + si * 3) % 7) || a.ordem - b.ordem);
    for (const p of fila) {
      const sem = [1, 2, 3, 4, 5, 6].map(i => soma(s, i));
      // semana que já vinha correndo: se a pessoa já folgou fora da fixa antes do início, a rotativa dela já foi dada
      if (s < de && sem.some(d => d < de && dow(d) !== p.folgaFixa && (hist[p.id] || {})[d] === 'F')) continue;
      const livres = sem.filter(d => d >= de && dow(d) !== p.folgaFixa && !ausente(p, d));
      if (!livres.length) continue;                                         // afastada o resto da semana: não há o que compensar
      const proxDom = soma(s, 7); const folgaNoProxDom = p.domTrab[proxDom] === false || (p.domTrab[proxDom] == null && !p.domingo);
      let melhor = null;
      for (const d of livres) {
        const w = dow(d); let custo = 0; const marcas = [];
        if (Math.abs(w - p.folgaFixa) === 1) { custo += 1000; marcas.push('colada'); }
        if (w === 6 && folgaNoProxDom && p.folgaFixa === 1) { custo += 2000; marcas.push('tres_seguidas'); }
        p.cel[d] = { tipo: 'folga', folga: 'rotativa' }; const seq = maiorSequencia(p, s, soma(s, 7)); p.cel[d] = { tipo: 'trabalho', turno: p.turno };
        if (seq > P.maxDiasSeguidos) { custo += 5000; marcas.push('sequencia'); }
        custo += 100 * (foraNoGrupo[p.grupo + '|' + d] || 0) + 4 * (foraLoja[d] || 0) + 100 * (+peso[w] || 0) + (p.ultRot === w ? 8 : 0) + (d > ate ? 1 : 0);
        if (!melhor || custo < melhor.custo) melhor = { d, custo, marcas, seq };
      }
      p.cel[melhor.d] = { tipo: 'folga', folga: 'rotativa', ...(melhor.marcas.includes('colada') ? { colada: true } : {}) }; p.rot[s] = melhor.d; p.ultRot = dow(melhor.d); marcaFora(p, melhor.d, 1);
      if (melhor.d >= de && melhor.d <= ate) {
        if (melhor.marcas.includes('colada')) alerta('info', 'rotativa_colada', p, p.nome + ': a rotativa de ' + br(melhor.d) + ' (' + DSEM[dow(melhor.d)] + ') ficou colada na folga fixa (' + DSEM[p.folgaFixa] + ') — os outros dias da semana estavam ' + (livres.length <= 2 ? 'indisponíveis' : 'piores para ' + p.grupo) + '.', melhor.d);
        if (melhor.marcas.includes('sequencia')) alerta('alerta', 'dias_seguidos', p, p.nome + ': ' + melhor.seq + ' dias seguidos de trabalho na semana de ' + br(s) + ' (limite ' + P.maxDiasSeguidos + ').', melhor.d);
      }
    }
  });

  // ── 3) Saída: só os dias do período, com a conferência de cada semana completa ──
  const cheia = s => s >= de && soma(s, 6) <= ate;
  const linhas = pessoas.map(p => {
    const d = {}; let minutos = 0, domingos = 0;
    for (const x of dias) { const c = p.cel[x]; if (c.tipo === 'trabalho') { const t = turnos[c.turno]; const m = liquido(t); minutos += m; if (dow(x) === 0) domingos++; d[x] = { tipo: 'trabalho', turno: c.turno, entrada: t.entrada, saida: t.saida, almoco_ini: t.almoco_ini || null, almoco_fim: t.almoco_fim || null, minutos: m }; } else d[x] = { ...c, minutos: 0 }; }
    const sems = semanas.map(s => { const ds = [0, 1, 2, 3, 4, 5, 6].map(i => soma(s, i)); const noPer = ds.filter(x => x >= de && x <= ate);
      const trab = noPer.filter(x => p.cel[x].tipo === 'trabalho').length, aus = noPer.filter(x => ['ferias', 'afastado'].includes(p.cel[x].tipo)).length;
      return { inicio: s, fim: soma(s, 6), completa: cheia(s), trabalhados: trab, ausencias: aus, domingo: !!p.domTrab[s], rotativa: p.rot[s] || null, minutos: noPer.reduce((t, x) => t + (d[x].minutos || 0), 0) }; });
    for (const w of sems) if (w.completa && !w.ausencias && w.trabalhados !== 5) alerta('alerta', 'semana_fora_5x2', p, p.nome + ': ' + w.trabalhados + ' dia(s) de trabalho na semana de ' + br(w.inicio) + ' a ' + br(w.fim) + ' (o 5×2 pede 5).', w.inicio);
    return { id: p.id, nome: p.nome, grupo: p.grupo, turno: p.turno, folgaFixa: p.folgaFixa, fixaSugerida: !!p.fixaSugerida, turnoSugerido: !!p.turnoSugerido, domingo: p.domingo, vaga: p.vaga, extra: p.extra, dias: d, semanas: sems, domingosTrabalhados: domingos, minutos, horas: hhmm(minutos) };
  });
  const porDia = {}; for (const x of dias) { const r = { trabalhando: 0, fora: 0, porGrupo: {} }; for (const l of linhas) { const g = r.porGrupo[l.grupo] || (r.porGrupo[l.grupo] = { trabalhando: 0, fora: 0 }); if (l.dias[x].tipo === 'trabalho') { r.trabalhando++; g.trabalhando++; } else { r.fora++; g.fora++; } } porDia[x] = r; }
  const rot = linhas.flatMap(l => Object.entries(l.dias).filter(([, c]) => c.tipo === 'folga' && c.folga === 'rotativa'));
  const sequencia = Math.max(0, ...pessoas.map(p => maiorSequencia(p, de, ate)));
  return { de, ate, dias, semanas: semanas.map(s => ({ inicio: s, fim: soma(s, 6), completa: cheia(s) })), turnos, grupos, efetivoDomingo: efetivo, linhas, porDia, alertas,
    resumo: { pessoas: linhas.length, semanasCompletas: semanas.filter(cheia).length, rotativas: rot.length, coladas: rot.filter(([, c]) => c.colada).length, maiorSequencia: sequencia,
      semanasFora: alertas.filter(a => a.codigo === 'semana_fora_5x2').length, semFolgaFixa: semFixa.length, semTurno: linhas.filter(l => l.turnoSugerido).length } };
}

/** Código do turno da planilha que corresponde a um horário (entrada–saída), ou null. */
function codigoDoHorario(turnos, d) { if (!d || d.tipo !== 'trabalho') return null; if (d.turno && turnos[d.turno]) return d.turno; for (const [k, t] of Object.entries(turnos || {})) if (t.entrada === d.entrada && t.saida === d.saida) return k; return null; }
/** Texto escuro ou claro conforme o fundo (as cores são as da planilha; só a letra se adapta para dar leitura). */
function corTexto(hex) { const m = String(hex || '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i); if (!m) return '#14213D'; const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16)); return (r * 299 + g * 587 + b * 114) / 1000 < 140 ? '#FFFFFF' : '#14213D'; }

module.exports = { DSEM, COR_FOLGA, TURNOS_PADRAO, PARAMS_PADRAO, PESO_DIA_PADRAO, gerar, sugerirFixas, efetivoPadrao, codigoDoHorario, corTexto, _util: { soma, dow, domingoDe, liquido, hhmm, min } };
