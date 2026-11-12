'use strict';
// lib/vagas-rotas.js — rotas /api/vagas/* (DP / RH › Vagas e Quadro de Pessoal). Regras em lib/vagas.js.
// O ponto é só LIDO (cadastro e afastamentos). Express 5: sem regex em rota.
module.exports = function montarRotasVagas(app, deps) {
  const V = require('./vagas'); const GP = require('./gestao-pessoas'); const E = require('./escalas'); const pc = deps.pontocerto;
  const D = { colaboradores: () => pc.colaboradores(), afastamentos: (a, b) => pc.afastamentos(a, b) };
  const user = req => req.session && req.session.user;
  const erroRes = (res, e) => { if (!e.status) console.error('[vagas]', e.stack || e.message); res.status(e.status || 500).json({ error: e.message, duplicada: e.duplicada, ressalvas: e.ressalvas, exigeCiencia: e.exigeCiencia }); };
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  // contador do menu: responde sempre (sem sessão ou sem papel = 0), para o menu nunca quebrar
  app.get('/api/vagas/pendencias', async (req, res) => { const u = user(req); if (!u || !V.podeVer(u, null)) return res.json({ n: 0 }); try { res.json(await V.pendencias(u, D)); } catch (e) { res.json({ n: 0 }); } });
  app.use('/api/vagas', (req, res, next) => { const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' }); if (!V.podeVer(u, null)) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', naoDesignado: true }); next(); });

  app.get('/api/vagas/me', ok(req => { const u = user(req); return { usuario: u.usuario, nome: u.nome, papeis: GP.papeisDe(u), ehRH: V.ehRH(u), ehCoord: V.ehCoord(u), veMotivo: V.veMotivo(u), veAuditoria: V.veAuditoria(u), veQuadro: GP.vePainel(u), hoje: V._util.hojeISO(),
    lojas: GP.LOJAS.filter(l => V.podeVer(u, l)).map(n => ({ n, txt: GP.LOJA_TXT[n], rh: V.podeRH(u, n) })), setores: E.SETORES.map(s => ({ id: s, txt: E.SETOR_TXT[s] })),
    movimento: V.MOVIMENTO, aviso: V.AVISO, motivo: V.MOTIVO, reposicao: V.REPOSICAO, status: V.STATUS, cancelamento: V.CANCELAMENTO, alertaDias: V.CFG.alertaDias, esocialPrazoDias: V.CFG.esocialPrazoDias }; }));
  app.get('/api/vagas/painel', ok(req => V.painel(user(req), D)));
  app.get('/api/vagas/quadro', ok(req => V.quadroPessoal(user(req), D)));
  app.get('/api/vagas/escala', ok(req => V.naEscala(user(req), +req.query.loja, String(req.query.de || ''), String(req.query.ate || ''))));
  app.get('/api/vagas/funcionarios', ok(req => V.buscarFuncionarios(user(req), D, { loja: req.query.loja || null, q: req.query.q || '' })));
  app.get('/api/vagas/auditoria', ok(req => V.trilha(user(req), { loja: req.query.loja || null, ref: req.query.ref || null })));
  app.get('/api/vagas/desligamentos', ok(req => V.listarDesligamentos(user(req), D, { loja: req.query.loja || null })));
  app.post('/api/vagas/desligamentos', ok(req => V.registrarDesligamento(user(req), req.body || {}, D)));
  app.get('/api/vagas/desligamentos/:id', ok(req => V.detalheDesligamento(user(req), req.params.id, D)));
  app.post('/api/vagas/desligamentos/:id', ok(req => V.alterarDesligamento(user(req), req.params.id, req.body || {}, D)));
  app.post('/api/vagas/ponto/dispensar', ok(req => V.dispensarPonto(user(req), req.body || {}, D)));
  app.post('/api/vagas/transferencias/dispensar', ok(req => V.dispensarTransferencia(user(req), req.body || {})));
  app.post('/api/vagas/verificar', ok(async req => { if (!V.ehRH(user(req)) && !V.ehCoord(user(req))) throw Object.assign(new Error('Só RH e Coordenação pedem a leitura do ponto'), { status: 403 }); const r = await V.verificar(D); return { ok: true, avisos: r.avisos.length, desligamentosNovos: r.desligamentosNovos }; }));
  app.get('/api/vagas/lista', ok(req => V.listarVagas(user(req), { loja: req.query.loja || null, status: req.query.status || null })));
  app.post('/api/vagas/lista', ok(req => V.abrirVaga(user(req), req.body || {}, D)));
  app.get('/api/vagas/vaga/:id', ok(req => V.detalheVaga(user(req), req.params.id, D)));
  app.post('/api/vagas/vaga/:id', ok(req => V.atualizarVaga(user(req), req.params.id, req.body || {}, D)));

  // Agendador (VAGAS_TICK=0 desliga nos testes e nos servidores de ensaio): de hora em hora lê o cadastro do ponto (desligamentos
  // novos, mudança de unidade, admitidos compatíveis com vaga) e manda os avisos de 7, 15 e 30 dias sem reposição.
  if (process.env.VAGAS_TICK !== '0') {
    const tick = async () => { try { const r = await V.verificar(D); if (r.avisos.length) console.log('[vagas]', r.avisos.length, 'aviso(s):', r.avisos.map(a => a.tipo).join(', ')); } catch (e) { console.error('[vagas] agendador:', e.message); } };
    const t = setInterval(tick, 3600000); if (t.unref) t.unref(); const t0 = setTimeout(tick, 7 * 60 * 1000); if (t0.unref) t0.unref();
  }
};
