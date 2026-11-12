'use strict';
// lib/historico-funcional-rotas.js — rotas /api/historico-funcional/* (DP / RH › Contratos e Histórico Funcional).
// Regras em lib/historico-funcional.js. O ponto é só LIDO (cadastro, afastamentos e faltas); advertências/suspensões vêm da
// Gestão Disciplinar e os documentos, da Gestão Documental — cada uma com as permissões dela. Express 5: sem regex em rota.
module.exports = function montarRotasHistoricoFuncional(app, deps) {
  const H = require('./historico-funcional'); const GP = require('./gestao-pessoas'); const pc = deps.pontocerto;
  const D = { colaboradores: () => pc.colaboradores(), afastamentosLongos: (a, b) => pc.afastamentosLongos(a, b), resumo: o => pc.resumo(o) };
  const user = req => req.session && req.session.user;
  const erroRes = (res, e) => { if (!e.status) console.error('[historico-funcional]', e.stack || e.message); res.status(e.status || 500).json({ error: e.message, duplicada: e.duplicada, atestado: e.atestado }); };
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  // contador do menu: responde sempre (sem sessão ou sem papel = 0), para o menu nunca quebrar
  app.get('/api/historico-funcional/pendencias', async (req, res) => { const u = user(req); if (!u || !H.podeVer(u, null)) return res.json({ n: 0 }); res.json(await H.pendencias(u, D)); });
  app.use('/api/historico-funcional', (req, res, next) => { const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' }); if (!H.podeVer(u, null)) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', naoDesignado: true }); next(); });

  app.get('/api/historico-funcional/me', ok(req => { const u = user(req); return { usuario: u.usuario, nome: u.nome, papeis: GP.papeisDe(u), ehRH: H.ehRH(u), veSensivel: H.veSensivel(u), podeConfig: H.podeConfig(u), veAuditoria: H.veAuditoria(u), hoje: H._util.hojeISO(),
    lojas: GP.LOJAS.filter(l => GP.veLoja(u, l)).map(n => ({ n, txt: GP.LOJA_TXT[n], edita: H.podeEditar(u, n) })), config: H.config(), maxLegal: H.MAX_LEGAL,
    tipos: H.TIPOS, prorrogacao: H.PRORROGACAO, desfechos: H.DESFECHOS, classes: H.CLASSES, tiposOcorrencia: H.TIPOS_OC, situacoesOcorrencia: H.SIT_OC }; }));
  app.get('/api/historico-funcional/painel', ok(req => H.painel(user(req), D)));
  app.get('/api/historico-funcional/contratos', ok(req => H.listarContratos(user(req), D, { loja: req.query.loja || null, q: req.query.q || '', so: req.query.so || null })));
  app.get('/api/historico-funcional/destaques', ok(req => H.destaques(user(req), +req.query.loja, D)));
  app.get('/api/historico-funcional/funcionario/:id', ok(req => H.ficha(user(req), req.params.id, D)));
  app.post('/api/historico-funcional/funcionario/:id/contrato', ok(req => { const b = req.body || {}; return H.alterarContrato(user(req), req.params.id, b.acao, b, D); }));
  app.post('/api/historico-funcional/ocorrencias', ok(req => H.registrarOcorrencia(user(req), req.body || {}, D)));
  app.post('/api/historico-funcional/ocorrencias/:id', ok(req => H.decidirOcorrencia(user(req), req.params.id, req.body || {})));
  app.post('/api/historico-funcional/sincronizar', ok(req => { if (!H.ehRH(user(req))) throw Object.assign(new Error('Só o RH sincroniza com o ponto'), { status: 403 }); return H.sincronizarPonto(D); }));
  app.get('/api/historico-funcional/config', ok(() => H.config()));
  app.post('/api/historico-funcional/config', ok(req => H.salvarConfig(user(req), req.body || {})));
  app.get('/api/historico-funcional/auditoria', ok(req => H.trilha(user(req), { loja: req.query.loja || null })));

  // Agendador (HF_TICK=0 desliga nos testes e nos servidores de ensaio): de hora em hora confere os prazos contratuais
  // (15, 10, 5, 3 e 1 dia antes de cada marco) e, uma vez por dia, puxa afastamentos e faltas do ponto.
  if (process.env.HF_TICK !== '0') {
    let ultimoSync = null;
    const tick = async () => { try { const hoje = H._util.hojeISO(); if (ultimoSync !== hoje && new Date().getHours() >= 6) { ultimoSync = hoje; const r = await H.sincronizarPonto(D); if (r.atestadosNovos) console.log('[historico-funcional] ponto:', r.atestadosNovos, 'afastamento(s) novo(s) e', r.indiciosDias, 'dia(s) sem marcação lidos'); }
      const a = await H.avisarPrazos(D); if (a.length) console.log('[historico-funcional]', a.length, 'aviso(s) de prazo contratual'); } catch (e) { console.error('[historico-funcional] agendador:', e.message); } };
    const t = setInterval(tick, 3600000); if (t.unref) t.unref(); const t0 = setTimeout(tick, 5 * 60 * 1000); if (t0.unref) t0.unref();
  }
};
