'use strict';
// lib/auditoria-folha-rotas.js — rotas /api/auditoria-folha/* (DP / RH › Auditoria da Folha, 27/10/2026). Regras em
// lib/auditoria-folha.js. Permissão = designação da central de pessoas (Coordenação importa/concilia/encerra; Financeiro e
// RH/DP tratam as divergências do seu setor; Diretoria consulta). PontoCerto e Itaú só são LIDOS.
module.exports = function montarRotasAuditoriaFolha(app, deps) {
  const A = require('./auditoria-folha'); const GP = require('./gestao-pessoas'); const pc = deps.pontocerto; const multer = deps.multer;
  const pcDeps = { colaboradores: () => pc.colaboradores(), cpfDe: id => pc.cpfDe(id) };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const erroRes = (res, e) => { if (!e.status) console.error('[auditoria-folha]', e.message); res.status(e.status || 500).json({ error: e.message }); };
  const user = req => req.session && req.session.user;
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  const compOk = c => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(c || ''))) throw Object.assign(new Error('Competência inválida'), { status: 400 }); return c; };
  const protOk = p => { if (!/^FOL-\d{4}-\d{4,6}$/.test(String(p || ''))) throw Object.assign(new Error('Protocolo inválido'), { status: 400 }); return p; };

  app.use('/api/auditoria-folha', (req, res, next) => {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (!GP.papeisDe(u).length) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', naoDesignado: true });
    if (!A.perm(u).ver) return res.status(403).json({ error: 'Seu papel não dá acesso à Auditoria da Folha (Coordenação, Financeiro, RH / DP e Diretoria).', semAcesso: true });
    next();
  });
  app.get('/api/auditoria-folha/me', ok(req => { const u = user(req); const p = A.perm(u); return { usuario: u.usuario, nome: u.nome, ...p, lojas: A.LOJAS_FOLHA.map(n => ({ n, txt: GP.LOJA_TXT[n] })), tipos: A.TIPO_TXT, setores: A.SETOR_TXT, situacoes: A.SIT_TXT, finais: A.SIT_FINAIS, hoje: A.hojeISO(), competencias: A.listar(u), config: A.config() }; }));
  app.get('/api/auditoria-folha/competencias', ok(req => A.listar(user(req))));
  app.get('/api/auditoria-folha/competencias/:c', ok(req => A.obter(compOk(req.params.c), user(req))));
  app.post('/api/auditoria-folha/competencias/:c/importar/previa', upload.single('arquivo'), ok(async req => { if (!req.file) throw Object.assign(new Error('Envie o PDF (ou .xlsx) no campo "arquivo"'), { status: 400 }); return A.importarPrevia(req.file.buffer, req.file.originalname, String(req.body.tipo || ''), compOk(req.params.c), user(req), pcDeps, req.body.loja); }));
  // confirmar já concilia na hora (Tiago, 27/10: "importa a loja e ele já tem que conciliar"); se o Itaú falhar, a importação fica e a tela avisa
  app.post('/api/auditoria-folha/competencias/:c/importar/confirmar', ok(async req => {
    const u = user(req); const c = compOk(req.params.c); let r = A.importarConfirmar(String((req.body || {}).token || ''), u);
    if (A.perm(u).conciliar && (req.body || {}).conciliar !== false) { try { r = await A.conciliar(c, u, pcDeps); r.autoConciliado = true; } catch (e) { r.erroConciliacao = e.message; } }
    return r;
  }));
  app.post('/api/auditoria-folha/competencias/:c/conciliar', ok(req => A.conciliar(compOk(req.params.c), user(req), pcDeps)));
  app.post('/api/auditoria-folha/competencias/:c/encerrar', ok(req => A.encerrar(compOk(req.params.c), req.body || {}, user(req))));
  app.post('/api/auditoria-folha/competencias/:c/reabrir', ok(req => A.reabrir(compOk(req.params.c), req.body || {}, user(req))));
  app.post('/api/auditoria-folha/competencias/:c/divergencias/:p', ok(req => A.tratar(compOk(req.params.c), protOk(req.params.p), req.body || {}, user(req))));
  app.get('/api/auditoria-folha/competencias/:c/documento/:tipo', (req, res) => {
    try {
      if (!A.DOC_TIPOS[req.params.tipo]) throw Object.assign(new Error('Tipo inválido'), { status: 400 });
      const r = A.arquivoDoc(compOk(req.params.c), req.params.tipo, user(req), req.query.loja);
      res.set('Cache-Control', 'no-store'); res.set('Content-Type', r.pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.set('Content-Disposition', (String(req.query.download) === '1' || !r.pdf ? 'attachment' : 'inline') + '; filename="' + r.nome + '"'); res.sendFile(r.caminho);
    } catch (e) { erroRes(res, e); }
  });
  app.get('/api/auditoria-folha/competencias/:c/relatorio.xlsx', async (req, res) => { try { const buf = await A.xlsxCompetencia(compOk(req.params.c), user(req)); res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.set('Content-Disposition', 'attachment; filename="auditoria-folha-' + req.params.c + '.xlsx"'); res.send(buf); } catch (e) { erroRes(res, e); } });
  app.get('/api/auditoria-folha/competencias/:c/relatorio.pdf', async (req, res) => { try { const buf = await A.pdfCompetencia(compOk(req.params.c), user(req)); res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', (String(req.query.download) === '1' ? 'attachment' : 'inline') + '; filename="auditoria-folha-' + req.params.c + '.pdf"'); res.send(buf); } catch (e) { erroRes(res, e); } });
  app.get('/api/auditoria-folha/auditoria', ok(req => A.auditoria(req.query.competencia ? compOk(req.query.competencia) : null, user(req))));
  app.put('/api/auditoria-folha/config', ok(req => A.salvarConfig(req.body || {}, user(req))));
};
