'use strict';
// lib/gestao-pessoas-rotas.js — rotas /api/gp/* da Central de Gestão de Pessoas (DP / RH › Gestão de Pessoas).
// Regras e dados em lib/gestao-pessoas.js. Sessão do sistema + módulo DP / RH + designação na Central:
// quem não está nos designados não passa da entrada (admin do sistema só entra enquanto não há designados, e só
// pra cadastrá-los — TI não ganha competência de aprovação por administrar o sistema).
// Sincronização com o PontoCerto (Pontomais/VR) a cada 30 min, SÓ LEITURA: saldos de banco de horas
// (GET /employees) e ocorrências de ponto (relatórios missing_days/delays/extra_times até ontem).
module.exports = function montarRotasGestaoPessoas(app, deps) {
  const GP = require('./gestao-pessoas');
  const pontocerto = deps.pontocerto;
  const erroRes = (res, e) => { if (!e.status) console.error('[gp]', e.message); res.status(e.status || 500).json({ error: e.message }); };
  const user = req => req.session && req.session.user;
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };

  app.use('/api/gp', (req, res, next) => {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (GP.papeisDe(u).length) return next();
    if (GP.bootstrapPermitido(u) && ['/me', '/config', '/usuarios'].includes(req.path)) return next();
    res.status(403).json({ error: 'Você não está entre os designados da Central de Gestão de Pessoas. Peça à Coordenação Administrativa.', naoDesignado: true });
  });
  const exige = (...papeis) => (req, res, next) => { if (GP.temPapel(user(req), ...papeis)) return next(); res.status(403).json({ error: 'Sem permissão (precisa ser ' + papeis.map(p => GP.PAPEIS[p]).join(' ou ') + ')' }); };

  app.get('/api/gp/me', (req, res) => {
    const u = user(req);
    res.json({ usuario: u.usuario, nome: u.nome, papeis: GP.papeisDe(u), escopo: GP.escopo(u), bootstrap: GP.bootstrapPermitido(u), vePainel: GP.vePainel(u),
      soConsulta: GP.temPapel(u, 'diretoria') && GP.papeisDe(u).length === 1, naoLidas: GP.notificacoes(u, true).length,
      catalogos: { lojas: GP.LOJAS.map(n => ({ n, txt: GP.LOJA_TXT[n] })), papeis: GP.PAPEIS, tipos: GP.TIPOS, status: GP.STATUS_TXT, resultados: GP.RESULTADOS, ocTipos: GP.OC_TIPOS, ocStatus: GP.OC_STATUS,
        docTipos: GP.DOC_TIPOS, docStatus: GP.DOC_STATUS, atStatus: GP.AT_STATUS, situacao: GP.SITUACAO_TXT, acoes: GP.ACAO_TXT } });
  });
  app.get('/api/gp/config', (req, res) => {
    const u = user(req); const c = GP.config();
    const ver = GP.temPapel(u, 'coordenacao') || GP.bootstrapPermitido(u);
    res.json({ limites: c.limites, prazos: c.prazos, ponto: c.ponto, quadro: c.quadro, checklistAdmissional: c.checklistAdmissional, versao: c.versao,
      designados: ver ? c.designados : c.designados.map(d => ({ nome: d.nome, papeis: d.papeis, lojas: d.lojas })), alteracoes: ver ? (c.alteracoes || []).slice(-30).reverse() : [], podeEditar: ver });
  });
  app.put('/api/gp/config', ok(req => { const c = GP.salvarConfig(req.body || {}, user(req)); return { ok: true, versao: c.versao }; }));
  app.get('/api/gp/usuarios', (req, res) => {
    const u = user(req); if (!GP.temPapel(u, 'coordenacao') && !GP.bootstrapPermitido(u)) return res.status(403).json({ error: 'Só a Coordenação designa pessoas' });
    res.json((deps.listarUsuarios ? deps.listarUsuarios() : []).map(x => ({ usuario: x.usuario, nome: x.nome, perfil: x.perfil })));
  });

  // ── sincronização (leitura do PontoCerto) ──
  let rodando = null;
  const ontem = () => GP._util.diaISO(new Date(Date.now() - 86400000));
  async function sincronizar(qual = 'tudo') {
    if (rodando) return rodando;
    rodando = (async () => {
      const r = {};
      if (!pontocerto.getConfig().tem_token) { GP.syncRegistrar('bancoHoras', { ok: false, erro: 'Token do PontoCerto não configurado' }); return { erro: 'Token do PontoCerto não configurado' }; }
      if (qual === 'tudo' || qual === 'bh') {
        try { const c = await pontocerto.colaboradores(); r.bancoHoras = GP.sincronizarBancoHoras(c.ativos); }
        catch (e) { r.bancoHoras = { erro: e.message }; if (!e.status) GP.syncRegistrar('bancoHoras', { ok: false, erro: e.message }); }
      }
      if (qual === 'tudo' || qual === 'ponto') {
        const ate = ontem(); const de = GP._util.diaISO(new Date(Date.now() - GP.config().ponto.diasVarredura * 86400000));
        try { const d = await pontocerto.resumo({ de, ate }); r.ponto = GP.sincronizarPonto(d.listas, { de, ate }); }
        catch (e) { r.ponto = { erro: e.message }; if (!e.status) GP.syncRegistrar('ponto', { ok: false, erro: e.message, de, ate }); }
      }
      try { r.tick = GP.tick(); } catch (e) { r.tick = { erro: e.message }; }
      return r;
    })();
    try { return await rodando; } finally { rodando = null; }
  }
  app.get('/api/gp/sync', (req, res) => res.json({ estado: GP.syncEstado(), rodando: !!rodando, tokenConfigurado: pontocerto.getConfig().tem_token }));
  app.post('/api/gp/sync', exige('ti', 'coordenacao', ...GP.RH), ok(async req => { const q = ['bh', 'ponto'].includes(req.body && req.body.qual) ? req.body.qual : 'tudo'; GP.auditar({ usuario: user(req).usuario, acao: 'sync_manual', qual: q }); return sincronizar(q); }));

  // ── painéis ──
  const colabsVivos = async () => { try { return await Promise.race([pontocerto.colaboradores(), new Promise(r => setTimeout(() => r(null), 4000))]); } catch (e) { return null; } };
  app.get('/api/gp/visao', ok(async req => { const u = user(req); return { indicadores: GP.vePainel(u) ? GP.indicadores(u, await colabsVivos()) : null, fila: GP.minhaFila(u), sync: GP.syncEstado() }; }));
  app.get('/api/gp/indicadores', ok(async req => GP.indicadores(user(req), await colabsVivos())));
  app.get('/api/gp/colaboradores', ok(req => {
    const u = user(req); if (!GP.vePainel(u)) return [];
    const s = GP.ultimoSaldo(); if (!s) return [];
    return Object.entries(s.colabs).filter(([, c]) => GP.veLoja(u, c.loja)).map(([id, c]) => ({ id: +id, nome: c.nome, loja: c.loja, setor: c.setor, cargo: c.cargo, matricula: c.matricula, min: c.min })).sort((a, b) => a.nome.localeCompare(b.nome));
  }));
  app.get('/api/gp/bh', ok(req => GP.painelBancoHoras(user(req))));
  app.get('/api/gp/bh/alertas/:prot', ok(req => GP.alertaBH(req.params.prot, user(req))));
  app.post('/api/gp/bh/alertas/:prot/providencia', ok(req => GP.providenciaAlerta(req.params.prot, user(req), req.body && req.body.texto)));
  app.get('/api/gp/ponto', ok(req => GP.listarOcorrencias(user(req), req.query)));
  app.post('/api/gp/ponto/:id/:acao', ok(req => GP.tratarOcorrencia(req.params.id, user(req), req.params.acao, req.body || {})));
  app.get('/api/gp/quadro', ok(async req => GP.painelQuadro(user(req), await colabsVivos())));
  app.get('/api/gp/alertas', ok(req => GP.centralAlertas(user(req), req.query)));

  // ── solicitações e planos ──
  app.get('/api/gp/solicitacoes', ok(req => GP.listarSols(user(req), req.query).map(s => GP.resumoSol(s, user(req)))));
  app.post('/api/gp/solicitacoes', ok(req => GP.resumoSol(GP.criarSolicitacao(user(req), req.body || {}), user(req))));
  app.get('/api/gp/solicitacoes/:prot', ok(req => GP.detalheSol(req.params.prot, user(req))));
  app.put('/api/gp/solicitacoes/:prot', ok(req => GP.resumoSol(GP.editarSolicitacao(req.params.prot, user(req), req.body && req.body.dados), user(req))));
  app.post('/api/gp/solicitacoes/:prot/:acao', ok(req => GP.resumoSol(GP.executar(req.params.prot, user(req), req.params.acao, req.body || {}), user(req))));

  // ── documentação ──
  app.get('/api/gp/documentos', ok(req => GP.listarDocumentos(user(req), req.query)));
  app.post('/api/gp/documentos', ok(req => GP.salvarDocumento(user(req), req.body || {})));
  app.post('/api/gp/documentos/checklist', ok(req => GP.checklistAdmissional(user(req), req.body && req.body.colab_id, req.body && req.body.prazo)));
  app.get('/api/gp/atendimentos', ok(req => GP.listarAtendimentos(user(req))));
  app.post('/api/gp/atendimentos', ok(req => GP.salvarAtendimento(user(req), req.body || {})));

  // ── relatórios, exportação, auditoria, avisos ──
  app.get('/api/gp/relatorios', ok(req => { GP.relatorioSemanal(user(req)); return GP.relatoriosSalvos(); }));
  app.get('/api/gp/relatorios/semanal', ok(req => GP.relatorioSemanal(user(req), /^\d{4}-\d{2}-\d{2}$/.test(req.query.data || '') ? req.query.data : null)));
  const csv = (cab, linhas) => '﻿' + [cab, ...linhas].map(l => l.map(v => { const s = String(v == null ? '' : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
  const h = GP._util.hhmm; const br = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';
  app.get('/api/gp/exportar/:qual.csv', (req, res) => {
    try {
      const u = user(req); let out;
      if (req.params.qual === 'banco-horas') { const p = GP.painelBancoHoras(u); out = csv(['Unidade', 'Matrícula', 'Funcionário', 'Setor', 'Cargo', 'Saldo', 'Semana anterior', 'Variação', 'Situação', 'Alerta', 'Plano'], (p.linhas || []).map(r => [GP.LOJA_TXT[r.loja] || '', r.matricula, r.nome, r.setor, r.cargo, h(r.min), r.anterior == null ? '' : h(r.anterior), r.variacao == null ? '' : h(r.variacao), GP.SITUACAO_TXT[r.situacao], r.alerta ? r.alerta.protocolo : '', r.plano ? r.plano.protocolo + ' ' + r.plano.statusTxt : ''])); }
      else if (req.params.qual === 'ponto') out = csv(['Protocolo', 'Unidade', 'Funcionário', 'Setor', 'Data', 'Tipo', 'Previsto', 'Registrado', 'Situação', 'Prazo', 'Reincidente'], GP.listarOcorrencias(u, req.query).map(o => [o.id, o.lojaTxt, o.nome, o.setor, br(o.data), o.tipoTxt, o.previsto, o.registrado, o.statusTxt, br(o.prazo), o.reincidente ? 'sim' : '']));
      else if (req.params.qual === 'solicitacoes') out = csv(['Protocolo', 'Tipo', 'Unidade', 'Funcionário', 'Status', 'Solicitante', 'Criada', 'Prazo', 'Resultado'], GP.listarSols(u, req.query).map(s => GP.resumoSol(s, null)).map(s => [s.protocolo, s.tipoTxt, s.lojaTxt, s.colab || '', s.statusTxt, s.autor, br(s.criadoEm), br(s.prazo), s.resultado ? GP.RESULTADOS[s.resultado] : '']));
      else if (req.params.qual === 'alertas') out = csv(['Protocolo', 'Evento', 'Tipo', 'Funcionário', 'Unidade', 'Data', 'Prioridade', 'Responsável', 'Prazo', 'Status', 'Detalhe'], GP.centralAlertas(u, req.query).map(a => [a.protocolo, a.evento, a.tipo, a.colab || '', a.lojaTxt, br(a.data), a.prioridade, a.responsavel, br(a.prazo), a.status, a.detalhe || '']));
      else if (req.params.qual === 'semanal') { const r = GP.relatorioSemanal(u, /^\d{4}-\d{2}-\d{2}$/.test(req.query.data || '') ? req.query.data : null); const L = []; for (const l of r.lojas) { for (const x of l.fora) L.push([l.lojaTxt, 'Fora do limite', x.nome, x.setor, h(x.min), x.anterior == null ? '' : h(x.anterior), x.variacao == null ? '' : h(x.variacao)]); for (const x of l.top_pos) L.push([l.lojaTxt, 'Top 5 positivos', x.nome, x.setor, h(x.min), x.anterior == null ? '' : h(x.anterior), x.variacao == null ? '' : h(x.variacao)]); for (const x of l.top_neg) L.push([l.lojaTxt, 'Top 5 negativos', x.nome, x.setor, h(x.min), x.anterior == null ? '' : h(x.anterior), x.variacao == null ? '' : h(x.variacao)]); } out = csv(['Unidade', 'Grupo', 'Funcionário', 'Setor', 'Saldo', 'Semana anterior', 'Variação'], L); }
      else return res.status(404).json({ error: 'Exportação desconhecida' });
      GP.auditar({ usuario: u.usuario, acao: 'exportar', qual: req.params.qual });
      res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename="gestao-pessoas-' + req.params.qual + '-' + GP._util.diaISO() + '.csv"'); res.set('Cache-Control', 'no-store');
      res.send(out);
    } catch (e) { erroRes(res, e); }
  });
  app.get('/api/gp/auditoria', ok(req => GP.auditoria(user(req), req.query)));
  app.get('/api/gp/notificacoes', ok(req => GP.notificacoes(user(req), req.query.naoLidas === '1')));
  app.post('/api/gp/notificacoes/lidas', ok(req => { GP.marcarLidas(user(req), (req.body && req.body.ids) || []); return { ok: true }; }));

  // ── agendas: prazos a cada 5 min; leitura do PontoCerto 2 min depois de subir e a cada 30 min ──
  const t1 = setInterval(() => { try { GP.tick(); } catch (e) { console.error('[gp] tick:', e.message); } }, 5 * 60 * 1000);
  const t2 = setInterval(() => { sincronizar().catch(e => console.error('[gp] sync:', e.message)); }, 30 * 60 * 1000);
  const t3 = setTimeout(() => { sincronizar().catch(e => console.error('[gp] sync:', e.message)); }, 2 * 60 * 1000);
  for (const t of [t1, t2, t3]) if (t.unref) t.unref();
  return { sincronizar };
};
