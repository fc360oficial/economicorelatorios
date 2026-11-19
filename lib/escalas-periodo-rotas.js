'use strict';
// lib/escalas-periodo-rotas.js — rotas /api/escalas-periodo/* (DP / RH › Escalas › Gerar por período, modelo da planilha).
// Prefixo próprio porque /api/escalas/:loja/:mes engoliria /api/escalas/periodo/... Regras em lib/escalas-periodo.js (serviço)
// e lib/escalas-planilha.js (motor puro). O ponto só é lido (afastamentos e, se o mês ainda não existe, o quadro).
module.exports = function montarRotasEscalasPeriodo(app, deps) {
  const S = require('./escalas-periodo'); const GP = require('./gestao-pessoas'); const pc = deps.pontocerto;
  const user = req => req.session && req.session.user;
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { if (!e.status) console.error('[escalas-periodo]', e.message); res.status(e.status || 500).json({ error: e.message }); } };
  app.use('/api/escalas-periodo', (req, res, next) => { const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' }); if (!GP.papeisDe(u).length) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', naoDesignado: true }); next(); });
  const lojaOk = req => { const l = +req.params.loja; if (!GP.LOJAS.includes(l)) throw Object.assign(new Error('Loja inválida'), { status: 400 }); if (!S.podeVer(user(req), l)) throw Object.assign(new Error('Loja fora do seu escopo'), { status: 403 }); return l; };
  const ctx = () => ({ pontocerto: pc });

  // faltando contratar: vagas de todas as lojas que o usuário vê (lista de trabalho do RH)
  app.get('/api/escalas-periodo/faltando', ok(req => S.faltando(user(req))));
  // cadastro completo da loja: o quadro vem direto do VR (?vr=novo ignora a leitura guardada e busca de novo)
  app.get('/api/escalas-periodo/:loja/cadastro', ok(req => S.cadastro(user(req), lojaOk(req), { ...ctx(), forcar: req.query.vr === 'novo' })));
  app.post('/api/escalas-periodo/:loja/cadastro', ok(req => S.salvarCadastro(user(req), lojaOk(req), req.body || {})));
  app.post('/api/escalas-periodo/:loja/pessoa', ok(req => S.salvarPessoa(user(req), lojaOk(req), req.body || {}, ctx())));   // turno / folga fixa / função / na escala de UMA pessoa ou vaga
  app.post('/api/escalas-periodo/:loja/dia', ok(req => S.editarDiaTurno(user(req), lojaOk(req), req.body || {}, ctx())));      // troca o turno de um dia (ajuste à mão, auditado)
  app.post('/api/escalas-periodo/:loja/gerar', ok(req => S.gerar(user(req), lojaOk(req), (req.body || {}).de, (req.body || {}).ate, ctx())));
  app.post('/api/escalas-periodo/:loja/aplicar', ok(req => S.aplicar(user(req), lojaOk(req), req.body || {}, ctx())));
  app.get('/api/escalas-periodo/:loja/geracoes', ok(req => S.listarGeracoes(lojaOk(req)).slice(0, 12).map(S.resumoGeracao)));
  // incluir / tirar pessoa ou vaga da escala sem passar pelo ponto (vale para o Gerador 5×2 e para o Gerar por período)
  app.post('/api/escalas-periodo/:loja/previsto', ok(req => S.incluirPrevisto(user(req), lojaOk(req), req.body || {})));
  app.post('/api/escalas-periodo/:loja/previsto/remover', ok(req => S.removerPrevisto(user(req), lojaOk(req), (req.body || {}).id)));
  app.post('/api/escalas-periodo/:loja/desfazer', ok(req => S.desfazer(user(req), lojaOk(req), (req.body || {}).id, (req.body || {}).justificativa)));
};
