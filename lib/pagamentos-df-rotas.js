'use strict';
// lib/pagamentos-df-rotas.js — rotas /api/pagamentos-df/* (Pagamentos de Domingos e Feriados; abas em Termos de Escala).
// Regras em lib/pagamentos-df.js. RH apura/confere, Coordenação aprova, Financeiro processa. PontoCerto só é lido.
module.exports = function montarRotasPagamentosDF(app, deps) {
  const PG = require('./pagamentos-df'); const DB = require('./dados-bancarios'); const GP = require('./gestao-pessoas'); const pc = deps.pontocerto;
  const pcDeps = { colaboradores: () => pc.colaboradores(), cpfDe: id => pc.cpfDe(id), jornadaDia: data => pc.jornadaDia(data, { toleranciaMin: (GP.config().ponto || {}).atrasoMin || 10 }) };
  const user = req => req.session && req.session.user;
  const erroRes = (res, e) => { if (!e.status) console.error('[pagamentos-df]', e.message); res.status(e.status || 500).json({ error: e.message, itens: e.itens }); };
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  const idOk = id => { if (!/^PG-\d{4}-\d{4,6}$/.test(String(id || ''))) throw Object.assign(new Error('Identificador inválido'), { status: 400 }); return id; };
  const keyOk = k => { if (!/^\d{1,12}\|\d{4}-\d{2}-\d{2}$/.test(String(k || ''))) throw Object.assign(new Error('Ocorrência inválida'), { status: 400 }); return k; };

  app.use('/api/pagamentos-df', (req, res, next) => {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (!GP.papeisDe(u).length) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas.', naoDesignado: true });
    if (!PG.perm(u).ver) return res.status(403).json({ error: 'Seu papel não dá acesso aos pagamentos de domingos e feriados.', semAcesso: true });
    next();
  });
  app.get('/api/pagamentos-df/me', ok(req => { const u = user(req); return { usuario: u.usuario, nome: u.nome, ...PG.perm(u), lojas: PG.lojasDe(u).map(n => ({ n, txt: GP.LOJA_TXT[n] })), status: PG.STATUS_TXT, pagStatus: PG.PAG_TXT, divergencias: PG.DIV_TXT, finStatus: PG.FIN_STATUS, valores: PG.valores(), hoje: new Date().toISOString().slice(0, 10) }; }));
  app.get('/api/pagamentos-df/painel', ok(req => PG.painel(req.query, user(req))));
  app.get('/api/pagamentos-df/valores', ok(req => PG.valores()));
  app.put('/api/pagamentos-df/valores', ok(req => PG.salvarValores(req.body || {}, user(req))));
  app.get('/api/pagamentos-df/datas', ok(req => PG.datasDoPeriodo(req.query.de, req.query.ate)));
  app.get('/api/pagamentos-df/funcionarios/:loja', ok(async req => { const l = +req.params.loja; if (!GP.LOJAS.includes(l) || !DB.veLoja(user(req), l)) throw Object.assign(new Error('Unidade inválida ou fora do escopo'), { status: 403 }); const col = await pc.colaboradores(); return col.ativos.filter(c => +c.loja === l).map(c => ({ id: c.id, nome: c.nome, cargo: c.cargo, setor: c.setor })); }));
  app.get('/api/pagamentos-df/relatorios', ok(req => PG.listar(req.query, user(req))));
  app.post('/api/pagamentos-df/relatorios', ok(req => PG.criar(req.body || {}, user(req), pcDeps)));
  app.get('/api/pagamentos-df/relatorios/:id', ok(req => PG.obter(idOk(req.params.id), user(req))));
  app.post('/api/pagamentos-df/relatorios/:id/reapurar', ok(req => PG.reapurar(idOk(req.params.id), user(req), pcDeps)));
  app.post('/api/pagamentos-df/relatorios/:id/itens', ok(req => PG.incluirManual(idOk(req.params.id), req.body || {}, user(req), pcDeps)));
  app.put('/api/pagamentos-df/relatorios/:id/itens/:key', ok(req => PG.editarItem(idOk(req.params.id), keyOk(req.params.key), req.body || {}, user(req))));
  app.post('/api/pagamentos-df/relatorios/:id/itens/:key/pagamento', ok(req => PG.registrarPagamento(idOk(req.params.id), keyOk(req.params.key), req.body || {}, user(req))));
  app.post('/api/pagamentos-df/relatorios/:id/itens/:key/revisar-banco', ok(req => PG.revisarBanco(idOk(req.params.id), keyOk(req.params.key), (req.body || {}).justificativa, user(req))));
  app.post('/api/pagamentos-df/relatorios/:id/atualizar-banco', ok(req => PG.atualizarBancoPendentes(idOk(req.params.id), user(req))));
  app.post('/api/pagamentos-df/relatorios/:id/conciliar', ok(req => require('./pagamentos-conciliacao').conciliar(idOk(req.params.id), user(req), pcDeps)));
  for (const acao of ['enviar', 'aprovar']) app.post('/api/pagamentos-df/relatorios/:id/' + acao, ok(req => PG[acao](idOk(req.params.id), req.body || {}, user(req))));
  for (const acao of ['devolver', 'cancelar']) app.post('/api/pagamentos-df/relatorios/:id/' + acao, ok(req => PG[acao](idOk(req.params.id), (req.body || {}).texto, user(req))));
  app.get('/api/pagamentos-df/relatorios/:id/exportar.pdf', async (req, res) => { try { const b = await PG.pdf(idOk(req.params.id), req.query, user(req), pcDeps); res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', (req.query.download === '1' ? 'attachment' : 'inline') + '; filename="' + req.params.id + (req.query.modo === 'financeiro' ? '-financeiro' : '-gerencial') + '.pdf"'); res.send(b); } catch (e) { erroRes(res, e); } });
  app.get('/api/pagamentos-df/relatorios/:id/exportar.xlsx', async (req, res) => { try { const b = await PG.xlsx(idOk(req.params.id), req.query, user(req), pcDeps); res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.set('Content-Disposition', 'attachment; filename="' + req.params.id + '-financeiro.xlsx"'); res.send(b); } catch (e) { erroRes(res, e); } });
  app.get('/api/pagamentos-df/auditoria', ok(req => PG.historicoAuditoria(req.query, user(req))));
};
