'use strict';
// lib/escalas-5x2-rotas.js — rotas /api/escalas-5x2/* (DP / RH › Gerador de Escalas 5×2). Regras em lib/escalas-5x2.js.
// Prefixo próprio de propósito: /api/escalas/:loja/:mes (lib/escalas-rotas.js) engoliria /api/escalas/gerador/...
// O PontoCerto só é LIDO (quadro, jornadas contratuais, férias e afastamentos e, desde a Etapa 3, a apuração dos dias já
// passados — relatório work_days — para o histórico real). Express 5: sem regex em parâmetro de rota.
module.exports = function montarRotasEscalas5x2(app, deps) {
  const S = require('./escalas-5x2'); const E = require('./escalas'); const GP = require('./gestao-pessoas'); const M = require('./escalas-gerador'); const pc = deps.pontocerto;
  const user = req => req.session && req.session.user;
  const erroRes = (res, e) => { if (!e.status) console.error('[escalas-5x2]', e.stack || e.message); res.status(e.status || 500).json({ error: e.message, pendencias: e.pendencias, desatualizada: e.desatualizada, exigeCiencia: e.exigeCiencia, semEscala: e.semEscala }); };
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  const falha = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });
  app.use('/api/escalas-5x2', (req, res, next) => { const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' }); if (!GP.vePainel(u)) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', naoDesignado: true }); next(); });
  const lojaOk = v => { const l = +v; if (!GP.LOJAS.includes(l)) throw falha('Unidade inválida'); return l; };
  const mesOk = v => { const m = String(v || ''); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw falha('Mês inválido (AAAA-MM)'); return m; };
  // férias e afastamentos do mês (Map nome → [{inicio, fim, ferias}]); null = PontoCerto indisponível (a proposta não pode ser aplicada)
  async function afastMes(mes, memo) { if (memo && memo.has(mes)) return memo.get(mes); let m = null; try { const l = await pc.afastamentos(mes + '-01', E.diasDoMes(mes).pop()); m = new Map(); for (const a of l) { if (!m.has(a.nome)) m.set(a.nome, []); m.get(a.nome).push(a); } } catch (e) { m = null; } if (memo) memo.set(mes, m); return m; }
  // Histórico real: apuração do ponto (relatório work_days, só leitura) das 4 semanas anteriores à segunda-feira da semana em
  // que a proposta começa, até hoje, e os afastamentos da mesma janela. null = ponto indisponível (os dias passados ficam
  // "não confirmados" e a semana de transição não libera a aplicação). `de` = primeiro dia da proposta.
  async function pontoJanela(de, memo) {
    const k = 'ponto|' + de; if (memo.has(k)) return memo.get(k);
    const hoje = E._util.diaISO(), j = S.janelaHistorico(de), ate = j.ate < hoje ? j.ate : hoje; let r = { ponto: null, afastJanela: null };
    if (j.de > ate) r = { ponto: { de: j.de, ate, linhas: [] }, afastJanela: null };   // janela toda no futuro: só existe o planejado
    else {
      try { const partes = await Promise.all(pc.faixas(j.de, ate).map(([a, b]) => pc.workDays(a, b))); r.ponto = { de: j.de, ate, linhas: partes.flat().map(w => ({ employee_id: w.employee_id, data: w.data, shift_time: w.shift_time, marcacoes: w.marcacoes || [] })) }; } catch (e) { console.error('[escalas-5x2] histórico do ponto indisponível:', e.message); }
      try { const l = await pc.afastamentos(j.de, ate); const m = new Map(); for (const a of l) { if (!m.has(a.nome)) m.set(a.nome, []); m.get(a.nome).push(a); } r.afastJanela = m; } catch (e) {}
    }
    memo.set(k, r); return r;
  }
  async function ctxDe(loja, mes, memo, quadro, de) {
    const [afast, afastAnt] = await Promise.all([afastMes(mes, memo), afastMes(S.mesAnterior(mes), memo)]); let colabs = null, escalasPC = null;
    // com `de` (simular / aplicar / analisar) o quadro do ponto entra sempre: dá a admissão de cada um e a jornada contratual
    // de quem não tem grade no mês anterior
    if (quadro || de || !E.ler(loja, mes)) { try { if (!memo.quadro) memo.quadro = Promise.all([pc.colaboradores(), pc.escalas()]); [colabs, escalasPC] = await memo.quadro; } catch (e) { memo.quadro = null; } }
    const hist = de ? await pontoJanela(de, memo) : { ponto: null, afastJanela: null };
    return { afast, afastAnt, colabs, escalasPC, hoje: E._util.diaISO(), ponto: hist.ponto, afastJanela: hist.afastJanela };
  }
  // primeiro dia da proposta (para saber que janela do ponto ler); período inválido devolve null e quem acusa é o serviço
  const inicioDe = (mes, aPartirDe) => { try { return S.periodo(mes, aPartirDe || null, E._util.diaISO()).de; } catch (e) { return null; } };
  const memoNovo = () => { const m = new Map(); m.quadro = null; return m; };

  app.get('/api/escalas-5x2/me', ok(req => { const u = user(req); const lojas = GP.LOJAS.filter(l => S.podeVer(u, l));
    return { usuario: u.usuario, nome: u.nome, papeis: GP.papeisDe(u), hoje: E._util.diaISO(), lojas: lojas.map(n => ({ n, txt: GP.LOJA_TXT[n], aplica: S.rhDa(u, n) })), podeRegras: S.podeRegras(u), podeValidarRegra: S.podeValidarRegra(u),
      setores: E.SETORES.map(s => ({ id: s, txt: E.SETOR_TXT[s] })), status: E.STATUS_TXT, tipos: E.TIPO_TXT, padrao: M.PARAMS_PADRAO, coresTipo: E.CORES_TIPO, cores: S.CORES, classes: M.CLASSES_TURNO.map(id => ({ id, nome: S.CLASSE_TXT[id], cor: S.CORES[id] })) }; }));

  // Simular: uma, várias ou todas as unidades. Com `detalhe` devolve a proposta inteira; sem, só o resumo de cada unidade.
  app.post('/api/escalas-5x2/simular', ok(async req => {
    const u = user(req); const b = req.body || {}; const mes = mesOk(b.mes); const lojas = [...new Set((Array.isArray(b.lojas) ? b.lojas : [b.lojas]).map(lojaOk))]; if (!lojas.length) throw falha('Escolha ao menos uma unidade');
    const memo = memoNovo(); const out = []; const de0 = inicioDe(mes, b.aPartirDe);
    for (const l of lojas) {
      try { const s = S.simular(u, l, mes, await ctxDe(l, mes, memo, false, de0), { aPartirDe: b.aPartirDe || null }); const r = s.resultado; const t = r.transicao, h = s.historico;
        const base = { loja: s.loja, lojaTxt: s.lojaTxt, mes, de: s.de, ate: s.ate, existe: s.existe, status: s.status, statusTxt: s.statusTxt, versao: s.versao, travados: s.travados, geradosAtuais: s.geradosAtuais, semFolgaFixaRH: s.semFolgaFixaRH, afastamentos: s.afastamentos, assinatura: s.assinatura, aplicacao: s.aplicacao,
          indicadores: r.indicadores, cobertura: r.cobertura.resumo, regrasAplicadas: r.regrasAplicadas, bloqueiosTrabalhistas: r.conflitos.trabalhistas.filter(c => c.gravidade === 'bloqueio').length, geracoes: S.listarGeracoes(l, mes).map(S.resumoGeracao),
          sugestaoInicio: s.sugestaoInicio, pesos: r.pesos, duasFolgas: r.duasFolgas, transicao: { necessaria: t.necessaria, semana: t.semana, inicio: t.inicio, pendentes: t.pendentes, diasPendentes: t.diasPendentes, herdados: t.herdados },
          historico: { ...h, pendentes: h.pendentes.length, semPonto: h.semPonto.length } };
        out.push(b.detalhe ? { ...base, feriados: s.feriados, feriadosNome: s.feriadosNome, proposta: r.proposta, conflitos: r.conflitos, divergenciasContratuais: r.divergenciasContratuais, domingosFeriados: r.domingosFeriados, coberturaDias: r.cobertura.dias, turnos: E.turnosDoMes(r.proposta), classes: s.classes,
          transicao: t, historico: { ...h, pendentes: h.pendentes.slice(0, 400), totalPendentes: h.pendentes.length } } : base);
      } catch (e) { if (!e.status) console.error('[escalas-5x2] simular', l, e.stack || e.message); out.push({ loja: l, lojaTxt: GP.LOJA_TXT[l], mes, erro: e.message }); }
    }
    return { mes, hoje: E._util.diaISO(), unidades: out };
  }));
  app.post('/api/escalas-5x2/:loja/:mes/aplicar', ok(async req => { const l = lojaOk(req.params.loja), m = mesOk(req.params.mes); return S.aplicar(user(req), l, m, await ctxDe(l, m, memoNovo(), false, inicioDe(m, (req.body || {}).aPartirDe)), req.body || {}); }));
  // RH valida o que aconteceu em dia que o ponto não confirma (trabalhou / descansou): fica na auditoria e passa a valer no histórico
  app.post('/api/escalas-5x2/:loja/:mes/historico', ok(async req => { const l = lojaOk(req.params.loja), m = mesOk(req.params.mes); const b = req.body || {}; const { e } = S.escalaDe(l, m, await ctxDe(l, m, memoNovo(), true)); return S.validarHistorico(user(req), l, e.funcionarios, b.itens, b.justificativa); }));
  // RH analisa uma semana com menos folgas do que a regra pede (situação justificada): deixa de ser bloqueio e fica na auditoria
  app.post('/api/escalas-5x2/:loja/:mes/excecao-folga', ok(async req => { const l = lojaOk(req.params.loja), m = mesOk(req.params.mes); const { e } = S.escalaDe(l, m, await ctxDe(l, m, memoNovo(), true)); return S.registrarExcecaoFolga(user(req), l, e.funcionarios, req.body || {}); }));
  app.post('/api/escalas-5x2/:loja/:mes/desfazer', ok(req => { const l = lojaOk(req.params.loja), m = mesOk(req.params.mes); const b = req.body || {}; return S.desfazer(user(req), l, m, b.geracao, b.justificativa); }));
  app.post('/api/escalas-5x2/:loja/:mes/quadro', ok(async req => { const l = lojaOk(req.params.loja), m = mesOk(req.params.mes); return S.sincronizarQuadro(user(req), l, m, await ctxDe(l, m, memoNovo(), true), (req.body || {}).justificativa); }));
  app.get('/api/escalas-5x2/:loja/:mes/analise', ok(async req => { const l = lojaOk(req.params.loja), m = mesOk(req.params.mes); return S.analisar(user(req), l, m, await ctxDe(l, m, memoNovo(), false, m + '-01')); }));
  app.get('/api/escalas-5x2/:loja/:mes/geracoes', ok(req => { const l = lojaOk(req.params.loja), m = mesOk(req.params.mes); if (!S.podeVer(user(req), l)) throw falha('Unidade fora do seu escopo', 403); return S.listarGeracoes(l, m).map(S.resumoGeracao); }));
  app.get('/api/escalas-5x2/geracao/:id', ok(req => S.geracao(user(req), req.params.id)));

  // Regras trabalhistas (nunca são excluídas: alterar tira a validação; encerrar fecha a vigência)
  app.get('/api/escalas-5x2/regras', ok(() => ({ regras: S.listarRegras(), padrao: M.PARAMS_PADRAO })));
  app.post('/api/escalas-5x2/regras', ok(req => S.salvarRegra(user(req), req.body || {})));
  app.post('/api/escalas-5x2/regras/:id/validar', ok(req => S.validarRegra(user(req), req.params.id, (req.body || {}).parecer)));
  app.post('/api/escalas-5x2/regras/:id/encerrar', ok(req => S.encerrarRegra(user(req), req.params.id, (req.body || {}).ate, (req.body || {}).justificativa)));

  // Cadastro do gerador: folga fixa, categoria, setor e restrições por funcionário; entradas permitidas e picos por unidade
  app.get('/api/escalas-5x2/:loja/:mes/cadastro', ok(async req => { const l = lojaOk(req.params.loja), m = mesOk(req.params.mes); const u = user(req); if (!S.podeVer(u, l)) throw falha('Unidade fora do seu escopo', 403);
    const { e, existe } = S.escalaDe(l, m, await ctxDe(l, m, memoNovo())); return { loja: l, lojaTxt: GP.LOJA_TXT[l], mes: m, existe, podeEditar: S.rhDa(u, l), funcionarios: S.cadastroLoja(l, e.funcionarios), setores: [...new Set([...E.SETORES, ...e.funcionarios.map(f => f.setor)])] }; }));
  app.post('/api/escalas-5x2/:loja/:mes/cadastro', ok(async req => { const l = lojaOk(req.params.loja), m = mesOk(req.params.mes); const { e } = S.escalaDe(l, m, await ctxDe(l, m, memoNovo())); const b = req.body || {}; return S.salvarCadastro(user(req), l, e.funcionarios, b.itens, b.justificativa); }));
  app.get('/api/escalas-5x2/cobertura/:loja', ok(req => { const l = lojaOk(req.params.loja); if (!S.podeVer(user(req), l)) throw falha('Unidade fora do seu escopo', 403); return { loja: l, lojaTxt: GP.LOJA_TXT[l], podeEditar: S.podeRegras(user(req)), ...S.coberturaLoja(l) }; }));
  app.post('/api/escalas-5x2/cobertura/:loja', ok(req => { const b = req.body || {}; return S.salvarCobertura(user(req), lojaOk(req.params.loja), b, b.justificativa); }));

  // Auditoria (só leitura; não existe rota de exclusão) e avisos à Coordenação
  app.get('/api/escalas-5x2/auditoria', ok(req => S.trilha(user(req), { loja: req.query.loja || null, mes: req.query.mes || null })));
  app.get('/api/escalas-5x2/avisos', ok(req => S.avisos(user(req), { entregar: true })));
  app.post('/api/escalas-5x2/avisos/vistos', ok(req => S.marcarVistos(user(req), (req.body || {}).ids)));

  // Relatório diário das alterações de rotina para a Coordenação (ESCALAS_5X2_RELATORIO=0 desliga nos mocks/testes)
  if (process.env.ESCALAS_5X2_RELATORIO !== '0') { const t = setInterval(() => { try { const r = S.relatorioDiario(); if (r) console.log('[escalas-5x2] relatório diário enviado:', r.itens, 'alteração(ões) para', r.para.length, 'destinatário(s)'); } catch (e) { console.error('[escalas-5x2] relatório diário', e.message); } }, 10 * 60 * 1000); if (t && t.unref) t.unref(); }
};
