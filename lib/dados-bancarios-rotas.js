'use strict';
// lib/dados-bancarios-rotas.js — rotas /api/dados-bancarios/* (Cadastro Bancário; abas em Termos de Escala). Regras em
// lib/dados-bancarios.js. Permissão = designação da central de pessoas; o PontoCerto só é lido (cadastro + CPF no servidor).
module.exports = function montarRotasDadosBancarios(app, deps) {
  const DB = require('./dados-bancarios'); const GP = require('./gestao-pessoas'); const pc = deps.pontocerto;
  const pcDeps = { colaboradores: () => pc.colaboradores(), cpfDe: id => pc.cpfDe(id) };
  const user = req => req.session && req.session.user;
  const erroRes = (res, e) => { if (!e.status) console.error('[dados-bancarios]', e.message); res.status(e.status || 500).json({ error: e.message, erros: e.erros, exigeConfirmacao: e.exigeConfirmacao }); };
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  const idOk = (id, pref) => { if (!new RegExp('^' + pref + '-\\d{4,6}$').test(String(id || ''))) throw Object.assign(new Error('Identificador inválido'), { status: 400 }); return id; };
  const funcIdOk = id => { if (!/^\d{1,12}$/.test(String(id || ''))) throw Object.assign(new Error('Funcionário inválido'), { status: 400 }); return String(id); };
  const upload = deps.multer({ storage: deps.multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

  app.use('/api/dados-bancarios', (req, res, next) => {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (!GP.papeisDe(u).length) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', naoDesignado: true });
    if (!DB.perm(u).ver) return res.status(403).json({ error: 'Seu papel não dá acesso ao cadastro bancário (RH / DP, Financeiro, Coordenação ou Diretoria).', semAcesso: true });
    next();
  });
  app.get('/api/dados-bancarios/me', ok(req => { const u = user(req); return { usuario: u.usuario, nome: u.nome, ...DB.perm(u), lojas: DB.lojasDe(u).map(n => ({ n, txt: GP.LOJA_TXT[n] })), catalogos: { bancos: DB.BANCOS, tipoConta: DB.TIPO_CONTA, tipoPix: DB.TIPO_PIX, modalidade: DB.MODALIDADE, status: DB.STATUS_TXT, alertas: DB.ALERTA_TXT }, config: DB.config() }; }));
  app.get('/api/dados-bancarios/painel', ok(req => DB.painel(req.query, user(req), pcDeps)));
  app.get('/api/dados-bancarios/funcionarios', ok(req => DB.listarFuncionarios(req.query, user(req), pcDeps)));
  app.get('/api/dados-bancarios/funcionarios/:id', ok(req => DB.ficha(funcIdOk(req.params.id), user(req), pcDeps)));
  app.post('/api/dados-bancarios/funcionarios/:id/contas', ok(async req => { const v = await DB.criarVersao(funcIdOk(req.params.id), req.body || {}, user(req), pcDeps, 'manual'); return DB.versaoVisivel(v, user(req)); }));
  app.post('/api/dados-bancarios/funcionarios/:id/bloquear', ok(async req => { const f = await DB.colabDe(pcDeps, funcIdOk(req.params.id)); if (!f) throw Object.assign(new Error('Funcionário não encontrado'), { status: 404 }); return DB.bloquear(f.id, (req.body || {}).motivo, user(req), { func: f }); }));
  app.post('/api/dados-bancarios/contas/:id/corrigir', ok(async req => DB.versaoVisivel(await DB.corrigir(idOk(req.params.id, 'CB'), req.body || {}, user(req), pcDeps), user(req))));
  app.post('/api/dados-bancarios/contas/:id/cancelar', ok(req => DB.versaoVisivel(DB.cancelarSolicitacao(idOk(req.params.id, 'CB'), (req.body || {}).motivo, user(req)), user(req))));
  app.post('/api/dados-bancarios/contas/:id/validar', ok(req => DB.versaoVisivel(DB.validar(idOk(req.params.id, 'CB'), req.body || {}, user(req)), user(req))));
  app.post('/api/dados-bancarios/contas/validar-lote', ok(req => DB.validarLote((req.body || {}).ids, req.body || {}, user(req))));
  app.get('/api/dados-bancarios/pendentes', ok(req => DB.pendentes(user(req))));
  app.get('/api/dados-bancarios/historico', ok(req => DB.historico(req.query, user(req))));
  app.get('/api/dados-bancarios/alertas', ok(req => DB.listarAlertas(req.query, user(req))));
  app.post('/api/dados-bancarios/alertas/:id/observacao', ok(req => DB.observarAlerta(idOk(req.params.id, 'AL'), (req.body || {}).texto, user(req))));
  app.post('/api/dados-bancarios/alertas/:id/encerrar', ok(req => DB.encerrarAlerta(idOk(req.params.id, 'AL'), (req.body || {}).justificativa, user(req))));
  app.post('/api/dados-bancarios/alertas/:id/liberar', ok(req => DB.liberar(idOk(req.params.id, 'AL'), req.body || {}, user(req))));
  app.put('/api/dados-bancarios/config', ok(req => DB.salvarConfig(req.body || {}, user(req))));
  // importação: modelo → prévia (planilha em memória, 30 min) → confirmação só dos válidos
  app.get('/api/dados-bancarios/importar/modelo.xlsx', async (req, res) => { try { if (!DB.perm(user(req)).importar) throw Object.assign(new Error('Só o DP / RH importa'), { status: 403 }); const b = await DB.modeloXlsx(); res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.set('Content-Disposition', 'attachment; filename="modelo-dados-bancarios.xlsx"'); res.send(b); } catch (e) { erroRes(res, e); } });
  app.post('/api/dados-bancarios/importar/previa', upload.single('planilha'), ok(async req => { if (!req.file) throw Object.assign(new Error('Envie o arquivo .xlsx ou .pdf no campo "planilha"'), { status: 400 }); return DB.importarPrevia(req.file.buffer, req.file.originalname, user(req), pcDeps); }));
  app.post('/api/dados-bancarios/importar/confirmar', ok(req => DB.importarConfirmar((req.body || {}).token, (req.body || {}).linhas, user(req), pcDeps)));
  app.get('/api/dados-bancarios/importacoes', ok(req => { if (!DB.perm(user(req)).ver) throw Object.assign(new Error('Sem acesso'), { status: 403 }); return DB.importacoes().slice().reverse().slice(0, 200); }));
};
