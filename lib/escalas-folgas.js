'use strict';
// lib/escalas-folgas.js — AUDITORIA INDEPENDENTE DAS FOLGAS do 5×2 (13/11/2026).
//
// Função pura que confere a ESCALA FINAL, dia a dia, sem usar nenhuma conta do gerador: não lê `regra52`, `validacao`,
// contadores nem conflitos de lib/escalas-gerador.js e não importa aquele arquivo. Recebe só os dias de cada pessoa (o que
// ficou na grade, o que o ponto registrou antes do período e o que já existe do mês seguinte) e as regras configuradas, e
// recalcula tudo:
//   · folgas por semana de segunda a domingo (inclusive a semana que atravessa o mês ou o ano), fixas (F) e rotativas (FR)
//   · semanas com exatamente duas folgas, com folga a mais, com folga a menos, com férias/afastamento, parciais
//   · semanas que não dá para afirmar: sem histórico (dia sem dado / sem confirmação do ponto) e em aberto (terminam depois
//     do período e os dias que faltam ainda são previsão)
//   · sequências de três ou mais dias seguidos de folga — separando a que acontece DENTRO de uma semana (é excesso semanal)
//     da que acontece ENTRE duas semanas (cada semana com as suas duas folgas)
//   · folga rotativa colada na folga fixa
//   · se a sequência era EVITÁVEL: existe outro dia da mesma semana para a folga rotativa que respeita dias seguidos de
//     trabalho, descanso dominical, descansos entre jornadas, restrição individual e cobertura mínima do setor?
//   · conflitos de jornada e de descanso dominical
// Férias, afastamento e dia fora do quadro NUNCA contam como folga da semana.
//
// Entrada de auditar():
//   de, ate        período auditado ('AAAA-MM-DD')
//   pessoas[]      { id, nome, setor, sexo?, folga_fixa: [dia da semana 0..6], duasRotativas?, admissao?, desligamento?, dom11?,
//                    restricoes?: { naoTrabalha: [0..6], datasBloqueadas: [] }, params: { folgasSemana, maxDiasConsecutivos,
//                    interjornadaMin, descansoSemanalMin, domingo: { folgaACadaSemanas }, feriado: { folgado } },
//                    dias: { 'AAAA-MM-DD': { tipo, folga?, entrada?, saida?, almoco_ini?, almoco_fim?, fonte, naoConfirmado? } } }
//                  tipo: trabalho | folga | feriado | ferias | afastado | indefinido (jornada prevista sem marcação)
//                  fonte: historico (antes do período) | gerado | fixo (ajuste à mão / já na grade) | ausencia | grade (dia
//                  real do mês seguinte) | previsto (previsão para depois do período: não é dado final)
//   cobertura      { abre, fecha, setores: { SETOR: { min, faixas: [{ dias, ini, fim, min }] } } }
//   feriados       ['AAAA-MM-DD']
//   excecoes       { 'id|segunda': { motivo } } — semana com menos folgas, analisada pelo RH
const D = iso => new Date(iso + 'T12:00:00');
const isoDe = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const soma = (iso, n) => { const d = D(iso); d.setDate(d.getDate() + n); return isoDe(d); };
const dow = iso => D(iso).getDay();
const segunda = iso => soma(iso, -((dow(iso) + 6) % 7));
const numDia = iso => Math.round(D(iso).getTime() / 86400000);
const min = t => { const m = String(t == null ? '' : t).match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
const br = iso => iso.slice(8) + '/' + iso.slice(5, 7);
const DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const lista = v => v == null ? [] : Array.isArray(v) ? v : [v];
const PADRAO = { folgasSemana: 2, maxDiasConsecutivos: 6, interjornadaMin: 660, descansoSemanalMin: 2100, domingo: { folgaACadaSemanas: 3 }, feriado: { folgado: 'folga' } };
const SITUACAO_TXT = { duas: 'Duas folgas', excesso: 'Folga a mais', falta: 'Folga a menos', excecao: 'Folga a menos com exceção do RH', ausencia: 'Semana com férias ou afastamento', parcial: 'Semana parcial (admissão ou saída)',
  pendente_historico: 'Pendente de histórico', aberta: 'Em aberto (fecha no mês seguinte)', ausente: 'Fora da escala' };

/** Classe do dia para a conta das folgas: T trabalho · F folga · A férias/afastamento · I indefinido · O fora do quadro · X sem dado. */
function classe(p, data, par) {
  if ((p.admissao && data < p.admissao) || (p.desligamento && data > p.desligamento)) return 'O';
  const d = p.dias[data]; if (!d) return 'X';
  if (d.tipo === 'trabalho') return 'T'; if (d.tipo === 'folga') return 'F'; if (d.tipo === 'indefinido') return 'I'; if (d.tipo === 'saiu' || d.tipo === 'fora') return 'O';
  if (d.tipo === 'feriado') return par.feriado && par.feriado.folgado === 'a_parte' ? 'A' : 'F';
  return 'A';
}

function auditar(ent) {
  ent = ent || {}; const de = ent.de, ate = ent.ate; const feriados = new Set(ent.feriados || []); const excecoes = ent.excecoes || {}; const cob = ent.cobertura || { setores: {} };
  const abre = min(cob.abre) == null ? 420 : min(cob.abre), fecha = min(cob.fecha) == null ? 1140 : min(cob.fecha); const slots = []; for (let t = abre; t < fecha; t += 15) slots.push(t);
  const necessario = (setor, dw, t) => { const s = (cob.setores || {})[setor]; if (!s) return 0; let n = +(s.min != null ? s.min : 0) || 0; for (const x of s.faixas || []) { const a = min(x.ini), b = min(x.fim); if ((x.dias || [0, 1, 2, 3, 4, 5, 6]).includes(dw) && a != null && b != null && t >= a && t < b && +x.min > n) n = +x.min; } return n; };
  const presente = (d, t) => { if (!d || d.tipo !== 'trabalho') return false; const e = min(d.entrada), s = min(d.saida); if (e == null || s == null || t < e || t >= s) return false; const ai = min(d.almoco_ini), af = min(d.almoco_fim); return !(ai != null && af != null && t >= ai && t < af); };
  const pessoas = (ent.pessoas || []).map(p => ({ ...p, dias: p.dias || {}, folga_fixa: lista(p.folga_fixa).map(Number), par: { ...PADRAO, ...(p.params || {}), domingo: { ...PADRAO.domingo, ...((p.params || {}).domingo || {}) }, feriado: { ...PADRAO.feriado, ...((p.params || {}).feriado || {}) } } }));
  const porSetor = new Map(); for (const p of pessoas) { if (!porSetor.has(p.setor)) porSetor.set(p.setor, []); porSetor.get(p.setor).push(p); }
  const seg0 = segunda(de); const semanas = []; for (let s = seg0; s <= ate; s = soma(s, 7)) semanas.push(s);
  const ocorrencias = []; const saida = [];
  const ind = { semanas: 0, duasFolgas: 0, fixaRotativa: 0, duasRotativas: 0, excesso: 0, falta: 0, excecao: 0, ausencia: 0, parcial: 0, pendentesHistorico: 0, abertas: 0, sequencias3: 0, sequencias3MesmaSemana: 0, sequencias3EntreSemanas: 0, maiorSequencia: 0,
    paresFixaRotativa: 0, evitaveis: 0, evitaveis3: 0, evitaveisPares: 0, inevitaveis: 0, fixaForaDoDia: 0, folgasFixas: 0, folgasRotativas: 0, conflitos: 0, pessoas: pessoas.length, pessoasComSequencia: 0 };

  for (const p of pessoas) {
    const par = p.par, alvo = +par.folgasSemana || 2; const cl = d => classe(p, d, par); const fixaNoDia = d => p.folga_fixa.includes(dow(d));
    const restrita = d => ((p.restricoes || {}).naoTrabalha || []).includes(dow(d)) || ((p.restricoes || {}).datasBloqueadas || []).includes(d);
    const real = d => { const x = p.dias[d]; return !!x && x.fonte !== 'previsto'; };
    const rotulo = d => fixaNoDia(d) ? 'F' : 'FR';   // fixa = a folga que cai no dia fixo do cadastro; qualquer outra é rotativa
    const descr = d => { const x = p.dias[d] || {}; return { data: d, dia: DIA[dow(d)], folga: cl(d) === 'F' ? rotulo(d) : null, fonte: x.fonte || null, domingo: dow(d) === 0, feriado: feriados.has(d) || x.tipo === 'feriado' }; };
    const modelo = p.duasRotativas ? 'duas_rotativas' : p.folga_fixa.length ? 'fixa_rotativa' : 'sem_modelo';
    const reg = (indicador, s, datas, motivo, extra) => ocorrencias.push({ indicador, funcId: p.id, nome: p.nome || '', setor: p.setor, semana: s ? { inicio: s, fim: soma(s, 6) } : null, datas, motivo, ...(extra || {}) });

    // ── 1. Semana a semana (segunda → domingo) ──
    const sems = [];
    for (const seg of semanas) {
      const datas = [0, 1, 2, 3, 4, 5, 6].map(i => soma(seg, i)); const k = datas.map(cl); const n = c => k.filter(x => x === c).length; const fim = datas[6];
      const dF = datas.filter((d, i) => k[i] === 'F'); const fixas = dF.filter(fixaNoDia).length, rotativas = dF.length - fixas;
      const semDado = datas.filter((d, i) => k[i] === 'X' || k[i] === 'I'), naoConf = datas.filter(d => d < de && p.dias[d] && p.dias[d].naoConfirmado);
      const previstos = datas.filter(d => p.dias[d] && p.dias[d].fonte === 'previsto'); const planejados = datas.filter(d => d < de && p.dias[d] && p.dias[d].planejado && !p.dias[d].naoConfirmado);
      const util = 7 - n('A') - n('O') - n('X'); const devidas = Math.round(util * alvo / 7);
      const folReal = dF.filter(real).length; const histF = dF.filter(d => d < de).length, histT = datas.filter((d, i) => k[i] === 'T' && d < de).length;
      const s = { inicio: seg, fim, folgas: dF.length, fixas, rotativas, trabalho: n('T'), ausencias: n('A'), fora: n('O'), semDado: semDado.length, exigidas: devidas, alvo, cruza: seg < de || fim > ate, datasFolga: dF, dias: datas.map(descr).map((x, i) => ({ ...x, classe: k[i] })), situacao: 'duas', motivo: '' };
      const per = br(seg) + ' a ' + br(fim);
      if (n('A') + n('O') === 7 || n('O') + n('X') === 7) { s.situacao = 'ausente'; s.motivo = n('O') ? 'fora do quadro a semana inteira' : 'férias ou afastamento a semana inteira'; }
      else if (folReal > alvo) { s.situacao = 'excesso'; s.herdado = histF > alvo; s.motivo = folReal + ' folgas na semana de ' + per + ' (' + dF.filter(real).map(br).join(', ') + ') — o 5×2 admite exatamente ' + alvo + (s.herdado ? '; já ocorrido antes do início da escala' : ''); }
      else if (semDado.length || naoConf.length) { s.situacao = 'pendente_historico'; const l = [...new Set([...semDado, ...naoConf])].sort();
        s.motivo = 'Sem dado ou sem confirmação do ponto em ' + l.map(br).join(', ') + ': não dá para afirmar quantas folgas a semana de ' + per + ' teve'; s.pendentes = l; }
      else if (previstos.length) { s.situacao = 'aberta'; s.motivo = 'A semana de ' + per + ' termina depois de ' + br(ate) + ': ' + folReal + ' folga(s) até o fim do período; os dias seguintes (' + previstos.map(br).join(', ') + ') ainda são previsão'; }
      else if (dF.length < devidas) { const exc = excecoes[p.id + '|' + seg];
        s.herdado = seg < de && histT > util - devidas;
        if (exc) { s.situacao = 'excecao'; s.motivo = dF.length + ' folga(s) na semana de ' + per + ' (a regra pede ' + devidas + ') — exceção analisada pelo RH: ' + String(exc.motivo || '').slice(0, 160); }
        else { s.situacao = 'falta'; s.motivo = (dF.length ? 'só ' + dF.length + ' folga' : 'nenhuma folga') + ' na semana de ' + per + ' — o 5×2 exige ' + devidas + (n('A') ? ' nesta semana (há ' + n('A') + ' dia(s) de férias/afastamento, que não contam como folga)' : '') + (s.herdado ? '; já ocorrido antes do início da escala' : ''); } }
      else if (n('A')) { s.situacao = 'ausencia'; s.motivo = dF.length + ' folga(s) e ' + n('A') + ' dia(s) de férias/afastamento na semana de ' + per + ' — as ausências não contam como folga; proporcional aos dias disponíveis, para análise do RH'; }
      else if (n('O')) { s.situacao = 'parcial'; s.motivo = 'Semana de ' + per + ' com ' + n('O') + ' dia(s) fora do quadro (admissão ou saída no meio da semana)'; }
      else { s.composicao = fixas === 1 && rotativas === 1 ? 'fixa_rotativa' : fixas === 0 ? 'duas_rotativas' : 'duas_fixas';
        s.motivo = 'Semana de ' + per + ': ' + dF.map(d => br(d) + ' (' + rotulo(d) + ')').join(' e ') + (planejados.length ? ' — ' + planejados.map(br).join(', ') + ' pelo planejado (ainda não ocorreu)' : '');
        // a folga fixa tem de ficar no dia definido: semana completa de quem tem folga fixa e trabalhou nela
        if (modelo === 'fixa_rotativa' && fixas === 0) { const dFixo = datas.filter(d => fixaNoDia(d)); s.fixaForaDoDia = true; ind.fixaForaDoDia++;
          reg('fixa_fora_do_dia', seg, dFixo, 'Folga fixa (' + p.folga_fixa.map(x => DIA[x]).join(', ') + ') trabalhada em ' + dFixo.map(br).join(', ') + ': as duas folgas da semana ficaram em ' + dF.map(br).join(' e ') + ' — ' + (dFixo.some(d => (p.dias[d] || {}).fonte === 'fixo') ? 'dia alterado na grade' : dFixo.some(d => (p.dias[d] || {}).fonte === 'historico') ? (dFixo.some(d => (p.dias[d] || {}).planejado) ? 'está assim no planejado do mês anterior' : 'já ocorrido') : 'troca feita pelo gerador') + '; a alteração da folga fixa depende de autorização do RH'); } }
      if (s.situacao !== 'ausente') { ind.semanas++; ind.folgasFixas += dF.filter(d => real(d) && fixaNoDia(d)).length; ind.folgasRotativas += dF.filter(d => real(d) && !fixaNoDia(d)).length; }
      if (s.situacao === 'duas') { ind.duasFolgas++; if (s.composicao === 'fixa_rotativa') ind.fixaRotativa++; else if (s.composicao === 'duas_rotativas') ind.duasRotativas++; }
      else if (s.situacao === 'excesso') { ind.excesso++; reg('excesso', seg, dF.filter(real), s.motivo, s.herdado ? { herdado: true } : null); }
      else if (s.situacao === 'falta') { ind.falta++; reg('falta', seg, datas.filter((d, i) => k[i] === 'T'), s.motivo, s.herdado ? { herdado: true } : null); }
      else if (s.situacao === 'excecao') ind.excecao++;
      else if (s.situacao === 'ausencia') ind.ausencia++;
      else if (s.situacao === 'parcial') ind.parcial++;
      else if (s.situacao === 'pendente_historico') { ind.pendentesHistorico++; reg('pendente', seg, s.pendentes, s.motivo); }
      else if (s.situacao === 'aberta') ind.abertas++;
      sems.push(s);
    }

    // ── 2. Sequências de folgas (dias corridos, atravessando semanas, meses e anos) ──
    // só dado real: a previsão para depois do período não entra em sequência
    const conhecidos = Object.keys(p.dias).filter(real).sort(); const ini = conhecidos.length && conhecidos[0] < seg0 ? conhecidos[0] : seg0; const ult = conhecidos.length && conhecidos[conhecidos.length - 1] > ate ? conhecidos[conhecidos.length - 1] : ate;
    const F = d => real(d) && cl(d) === 'F'; const T = d => { const c = real(d) ? cl(d) : null; return c === 'T' || c === 'I'; };
    const corridas = (eFolga, a, b) => { const out = []; let at = null; for (let d = a; d <= b; d = soma(d, 1)) { if (eFolga(d)) { if (!at) at = []; at.push(d); } else if (at) { out.push(at); at = null; } } if (at) out.push(at); return out; };
    // medida da grade de uma pessoa: dias de folga em sequência de 3 ou mais, e pares "rotativa colada na fixa"
    const medir = (eFolga, a, b) => { let n3 = 0, adj = 0; for (const c of corridas(eFolga, a, b)) { if (c.length >= 3) n3 += c.length; for (let i = 1; i < c.length; i++) if (fixaNoDia(c[i - 1]) !== fixaNoDia(c[i])) adj++; } return { n3, adj }; };
    const maiorTrabalho = (eTrab, a, b) => { let m = 0, r = 0; for (let d = a; d <= b; d = soma(d, 1)) { if (eTrab(d)) { r++; if (r > m) m = r; } else r = 0; } return m; };
    // jornada de referência para um dia que deixaria de ser folga: a mais comum da pessoa na semana; sem ela, no período
    const jornadaRef = seg => { const conta = ds => { const m = new Map(); for (const d of ds) { const x = p.dias[d]; if (x && x.tipo === 'trabalho' && x.entrada && x.saida) { const kx = [x.entrada, x.saida, x.almoco_ini || '', x.almoco_fim || ''].join('|'); m.set(kx, (m.get(kx) || 0) + 1); } } const top = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]; if (!top) return null; const [en, sa, ai, af] = top[0].split('|'); return { tipo: 'trabalho', entrada: en, saida: sa, almoco_ini: ai || null, almoco_fim: af || null }; };
      return conta([0, 1, 2, 3, 4, 5, 6].map(i => soma(seg, i))) || conta(Object.keys(p.dias).filter(d => d >= de && d <= ate)); };
    const cada = +par.domingo.folgaACadaSemanas || 0;
    /** Existe outro dia da MESMA semana para a folga rotativa? Devolve { evitavel, alternativa, motivo }. */
    function alternativa(run) {
      const movel = run.filter(d => d >= de && d <= ate && (p.dias[d] || {}).fonte === 'gerado' && !fixaNoDia(d) && !restrita(d) && (p.dias[d] || {}).folga !== 'fixa' && (p.dias[d] || {}).folga !== 'restricao');
      if (!movel.length) { const porque = d => { const x = p.dias[d] || {}; return d < de ? (x.planejado ? 'planejado no mês anterior' : 'já ocorrido') : d > ate ? 'mês seguinte' : fixaNoDia(d) || x.folga === 'fixa' ? 'folga fixa' : restrita(d) ? 'restrição individual' : x.fonte === 'fixo' ? 'ajuste na grade' : x.tipo === 'feriado' ? 'feriado' : 'protegido'; };
        return { evitavel: false, motivo: 'Todos os dias da sequência são protegidos: ' + run.map(d => br(d) + ' (' + porque(d) + ')').join(', ') }; }
      // para julgar a troca, o dia que ainda não tem dado final conta pelo que se sabe dele: a previsão, ou a folga fixa do cadastro
      // (mandar a rotativa para o domingo não adianta se a segunda seguinte é a folga fixa)
      const Fp = d => real(d) ? cl(d) === 'F' : p.dias[d] ? cl(d) === 'F' : (fixaNoDia(d) && !(p.desligamento && d > p.desligamento));
      const a0 = soma(run[0], -14), b0 = soma(run[run.length - 1], 14); const antes = medir(Fp, a0, b0), trabAntes = maiorTrabalho(T, a0, b0); const recusas = { cobertura: new Set(), dias_seguidos: new Set(), domingo: new Set(), descanso: new Set(), sem_melhora: new Set() }; const boas = [];
      for (const m of movel) {
        const seg = segunda(m); const ref = jornadaRef(seg);
        for (let i = 0; i < 7; i++) {
          const t = soma(seg, i); if (t === m || t < de || t > ate) continue; const xt = p.dias[t]; if (!xt || xt.tipo !== 'trabalho' || xt.fonte !== 'gerado') continue;
          const eF = d => d === m ? false : d === t ? true : Fp(d), eT = d => d === m ? true : d === t ? false : T(d);
          // 1. melhora de verdade (menos dias em sequência de 3+; em empate, menos rotativa colada na fixa) e não cria outra
          const dep = medir(eF, a0, b0); if (!(dep.n3 < antes.n3 || (dep.n3 === antes.n3 && dep.adj < antes.adj))) { recusas.sem_melhora.add(t); continue; }
          // 2. dias seguidos de trabalho
          if (maiorTrabalho(eT, a0, b0) > Math.max(par.maxDiasConsecutivos, trabAntes)) { recusas.dias_seguidos.add(t); continue; }
          // 3. descanso dominical: o domingo que deixaria de ser folga não pode estourar o revezamento; no 1×1 o domingo não se mexe
          if (dow(m) === 0 || dow(t) === 0) {
            if (p.dom11) { recusas.domingo.add(t); continue; }
            if (dow(m) === 0) { let seguidos = 1; for (let d = soma(m, -7); eT(d); d = soma(d, -7)) seguidos++; for (let d = soma(m, 7); eT(d); d = soma(d, 7)) seguidos++;
              if ((cada > 0 && seguidos >= cada) || (p.sexo === 'F' && seguidos >= 2)) { recusas.domingo.add(t); continue; } }
          }
          // 4. descansos entre jornadas (interjornada e folga + interjornada) com a jornada de referência no dia que volta a ser trabalho
          if (ref) { const abs = (d, campo) => { const x = d === m ? ref : p.dias[d]; const v = x && x.tipo === 'trabalho' ? min(x[campo]) : null; return v == null ? null : numDia(d) * 1440 + v; }; let ruim = false;
            // cada jornada da semana (e a primeira da seguinte) contra a jornada anterior: coladas = interjornada; só folga no meio = folga + interjornada
            for (let d = seg; d <= soma(seg, 7) && !ruim; d = soma(d, 1)) { if (!eT(d)) continue; const en = abs(d, 'entrada'); if (en == null) continue; let a = soma(d, -1); while (a >= soma(seg, -4) && eF(a)) a = soma(a, -1); if (!eT(a)) continue; const sa = abs(a, 'saida'); if (sa == null) continue;
              if (!(m >= a && m <= d) && !(t >= a && t <= d)) continue;   // só o que a troca mexe
              if (en - sa < (a === soma(d, -1) ? par.interjornadaMin : par.descansoSemanalMin)) ruim = true; }
            if (ruim) { recusas.descanso.add(t); continue; } }
          // 5. cobertura mínima do setor no dia que viraria folga: a pessoa não pode ser a que segura o mínimo em nenhum bloco de 15 min
          const dwT = dow(t); let falta = false, folgaMin = Infinity;
          for (const sl of slots) { if (!presente(xt, sl)) continue; const nec = necessario(p.setor, dwT, sl); if (!nec) continue; let c = 0; for (const q of porSetor.get(p.setor) || []) if (presente(q.dias[t], sl)) c++; if (c - 1 < nec) { falta = true; break; } if (c - 1 - nec < folgaMin) folgaMin = c - 1 - nec; }
          if (falta) { recusas.cobertura.add(t); continue; }
          boas.push({ de: m, para: t, n3: dep.n3, adj: dep.adj, colada: eF(soma(t, -1)) || eF(soma(t, 1)), sobra: folgaMin === Infinity ? 99 : folgaMin });
        }
      }
      if (boas.length) { boas.sort((a, b) => (a.n3 - b.n3) || (a.adj - b.adj) || (+a.colada - +b.colada) || (b.sobra - a.sobra) || a.para.localeCompare(b.para)); const m = boas[0];
        return { evitavel: true, alternativa: { de: m.de, para: m.para }, motivo: 'Evitável: a folga rotativa de ' + br(m.de) + ' (' + DIA[dow(m.de)] + ') cabe em ' + br(m.para) + ' (' + DIA[dow(m.para)] + ') sem ferir dias seguidos, descanso dominical, descansos entre jornadas, restrição individual nem a cobertura mínima do setor' }; }
      const t = []; const l = s => [...s].sort().map(br).join(', ');
      if (recusas.cobertura.size) t.push('a cobertura mínima do setor não deixa a folga ir para ' + l(recusas.cobertura));
      if (recusas.dias_seguidos.size) t.push('passaria do limite de dias seguidos de trabalho (' + l(recusas.dias_seguidos) + ')');
      if (recusas.domingo.size) t.push('feriria o descanso dominical (' + l(recusas.domingo) + ')');
      if (recusas.descanso.size) t.push('feriria o descanso entre jornadas (' + l(recusas.descanso) + ')');
      if (recusas.sem_melhora.size) t.push('nos demais dias a folga continuaria colada em outra (' + l(recusas.sem_melhora) + ')');
      return { evitavel: false, motivo: 'Sem alternativa válida na semana: ' + (t.join('; ') || 'não há dia de trabalho gerado para receber a folga') };
    }
    const seqs = [];
    for (const run of corridas(F, ini, ult)) {
      if (run.length < 2 || run[run.length - 1] < de) continue; const tres = run.length >= 3;   // só o que toca o período auditado
      const colada = run.some((d, i) => i > 0 && fixaNoDia(run[i - 1]) !== fixaNoDia(d));   // há rotativa encostada na fixa
      if (!tres && !colada) continue;   // duas rotativas juntas (modelo flexível) não são ocorrência
      const segs = [...new Set(run.map(segunda))]; const excessoSemanal = segs.some(s => { const w = sems.find(x => x.inicio === s); return w ? w.situacao === 'excesso' : run.filter(d => segunda(d) === s).length > alvo; });
      const alt = alternativa(run);
      const q = { datas: run, tamanho: run.length, dias: run.map(descr), semanas: segs, entreSemanas: segs.length > 1, mesmaSemana: segs.length === 1, excessoSemanal, tipo: tres ? 'sequencia' : 'fixa_rotativa', evitavel: alt.evitavel, alternativa: alt.alternativa || null, motivo: alt.motivo };
      const comp = run.map(d => br(d) + ' ' + DIA[dow(d)].slice(0, 3) + ' (' + rotulo(d) + (d < de ? ((p.dias[d] || {}).planejado ? ', planejado no mês anterior' : ', já ocorrido') : (p.dias[d] || {}).fonte === 'fixo' ? ', ajuste na grade' : '') + ')').join(' · ');
      if (tres) { ind.sequencias3++; if (q.mesmaSemana) ind.sequencias3MesmaSemana++; else ind.sequencias3EntreSemanas++; if (run.length > ind.maiorSequencia) ind.maiorSequencia = run.length;
        q.natureza = excessoSemanal ? 'excesso_semanal' : q.entreSemanas ? 'entre_semanas' : 'mesma_semana';
        reg('sequencia', segs[0], run, run.length + ' dias seguidos de folga: ' + comp + ' — ' + (excessoSemanal ? 'há EXCESSO semanal de folgas (mais de ' + alvo + ' na mesma semana)' : 'sequência ENTRE semanas: cada semana tem as suas ' + alvo + ' folgas, mas elas ficaram encostadas na virada') + '. ' + alt.motivo, { tamanho: run.length, natureza: q.natureza, evitavel: alt.evitavel, alternativa: q.alternativa, semanas: segs }); }
      else { ind.paresFixaRotativa++; reg('fixa_rotativa', segs[0], run, 'Folga rotativa colada na folga fixa: ' + comp + '. ' + alt.motivo, { evitavel: alt.evitavel, alternativa: q.alternativa, semanas: segs }); }
      if (alt.evitavel) { ind.evitaveis++; if (tres) ind.evitaveis3++; else ind.evitaveisPares++; reg('evitavel', segs[0], run, (tres ? run.length + ' dias seguidos de folga' : 'Folga rotativa colada na folga fixa') + ': ' + comp + '. ' + alt.motivo, { tamanho: run.length, alternativa: q.alternativa, semanas: segs }); }
      else if (tres) ind.inevitaveis++;
      seqs.push(q);
    }
    if (seqs.some(q => q.tipo === 'sequencia')) ind.pessoasComSequencia++;

    // ── 3. Conflitos de jornada e de descanso dominical (recalculados da grade) ──
    const conflitos = []; const conf = (codigo, data, texto) => { conflitos.push({ codigo, data, texto }); reg('conflito', segunda(data), [data], texto, { codigo }); };
    const hh = g => Math.floor(g / 60) + 'h' + String(g % 60).padStart(2, '0');
    let seguidos = 0, estourou = false, antT = null, entre = 'nada';   // entre a última jornada e esta: nada | folga | outro (ausência, sem dado)
    for (let d = ini; d <= ult; d = soma(d, 1)) {
      const x = p.dias[d], c = real(d) ? cl(d) : null; const noPer = d >= de && d <= ate;
      if (c === 'T' || c === 'I') { seguidos++; if (seguidos > par.maxDiasConsecutivos && !estourou && noPer) { estourou = true; conf('dias_consecutivos', d, seguidos + 'º dia seguido de trabalho em ' + br(d) + ' (limite ' + par.maxDiasConsecutivos + ')'); } } else { seguidos = 0; estourou = false; }
      if (c === 'T') { const en = min(x.entrada), sa = min(x.saida);
        if (noPer && (en == null || sa == null || sa <= en)) conf('jornada_sem_horario', d, 'Dia de trabalho sem entrada e saída válidas em ' + br(d));
        if (noPer && en != null && antT && antT.saida != null && entre !== 'outro') { const gap = numDia(d) * 1440 + en - antT.saida;
          if (entre === 'nada' && gap < par.interjornadaMin) conf('interjornada', d, 'Só ' + hh(gap) + ' entre a saída de ' + br(antT.data) + ' e a entrada de ' + br(d) + ' (mínimo ' + hh(par.interjornadaMin) + ')');
          else if (entre === 'folga' && gap < par.descansoSemanalMin) conf('descanso_semanal', d, 'Descanso de ' + hh(gap) + ' antes de ' + br(d) + ' (mínimo ' + hh(par.descansoSemanalMin) + ' com a folga)'); }
        antT = { data: d, saida: sa == null ? null : numDia(d) * 1440 + sa }; entre = 'nada';
      } else { entre = c === 'F' && entre !== 'outro' ? 'folga' : 'outro';
        if (c === 'F' && noPer && x && (x.entrada || x.saida)) conf('jornada_em_folga', d, 'Folga com horário de trabalho lançado em ' + br(d) + ' (' + (x.entrada || '?') + '–' + (x.saida || '?') + ')'); }
    }
    let dom = 0;
    for (let d = soma(segunda(ini), 6); d <= ult; d = soma(d, 7)) {
      const c = real(d) ? cl(d) : null; if (c !== 'T' && c !== 'I') { dom = 0; continue; } dom++; if (d < de || d > ate || c !== 'T') continue;
      if (p.sexo === 'F' && dom >= 2) conf('domingo_art386', d, dom + 'º domingo seguido de trabalho em ' + br(d) + ' — art. 386 da CLT (revezamento quinzenal da trabalhadora)');
      else if (cada > 0 && dom >= cada) conf('domingo_sem_folga', d, dom + 'º domingo seguido de trabalho em ' + br(d) + ' (a regra pede folga a cada ' + cada + ' semanas)');
    }
    ind.conflitos += conflitos.length;
    saida.push({ id: p.id, nome: p.nome || '', setor: p.setor, modelo, folga_fixa: p.folga_fixa, semanas: sems, sequencias: seqs, conflitos });
  }
  const ordem = { excesso: 0, falta: 1, sequencia: 2, evitavel: 3, fixa_rotativa: 4, fixa_fora_do_dia: 5, pendente: 6, conflito: 7 };
  ocorrencias.sort((a, b) => (ordem[a.indicador] - ordem[b.indicador]) || String(a.setor).localeCompare(String(b.setor)) || a.nome.localeCompare(b.nome) || String(a.datas[0] || '').localeCompare(String(b.datas[0] || '')));
  return { periodo: { de, ate }, semanas: semanas.map(s => ({ inicio: s, fim: soma(s, 6), cruza: s < de || soma(s, 6) > ate })), indicadores: ind, pessoas: saida, ocorrencias, situacaoTxt: SITUACAO_TXT };
}

/** Monta a entrada do auditor a partir do que ficou PRONTO: os dias do período (grade/proposta), o que o ponto registrou
 *  antes e os dias depois do período. Do resultado do gerador só entram os dias — nenhuma conta dele. */
function entrada({ de, ate, funcionarios, dias, historico, depois, paramsDe, dom11De, cobertura, feriados, excecoes, fonteDe }) {
  const ausencia = x => x.origem === 'ausencia' || x.tipo === 'ferias' || x.tipo === 'afastado';
  const pessoas = (funcionarios || []).map(f => { const out = {}; const h = ((historico || {})[f.id] || (historico || {})[String(f.id)] || {}).dias || {};
    for (const [d, x] of Object.entries(h)) if (d < de) out[d] = { ...x, fonte: 'historico' };
    // fonteDe (opcional) decide o que é redistribuível na grade gravada; sem ela, vale a marca do próprio dia
    for (const [d, x] of Object.entries((dias || {})[f.id] || {})) if (d >= de && d <= ate) out[d] = { ...x, fonte: ausencia(x) ? 'ausencia' : fonteDe ? fonteDe(f, d, x) : x.travado ? 'fixo' : x.origem === 'gerador' ? 'gerado' : 'fixo' };
    for (const [d, x] of Object.entries((depois || {})[f.id] || {})) if (d > ate) out[d] = { ...x, fonte: ausencia(x) ? 'ausencia' : x.travado ? 'grade' : 'previsto' };
    return { id: f.id, nome: f.nome, setor: f.setor, sexo: f.sexo || null, folga_fixa: f.duasRotativas ? [] : lista(f.folga_fixa), duasRotativas: !!f.duasRotativas, admissao: f.admissao || null, desligamento: f.desligamento || null, restricoes: f.restricoes || {}, params: paramsDe ? paramsDe(f) : null, dom11: dom11De ? !!dom11De(f) : false, dias: out }; });
  return { de, ate, pessoas, cobertura, feriados, excecoes };
}

module.exports = { auditar, entrada, SITUACAO_TXT, _util: { soma, dow, segunda, br } };
