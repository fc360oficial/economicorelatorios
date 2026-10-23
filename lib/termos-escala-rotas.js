'use strict';
// lib/termos-escala-rotas.js — rotas /api/termos-escala/* (DP / RH › Termos de Escala). Regras, PDF e arquivos em
// lib/termos-escala.js. Permissão = designação da central de pessoas (RH emite; Coordenação/Diretoria/Jurídico consultam).
// PontoCerto só é lido (cadastro dos ativos + CPF na hora de montar o PDF); nada de ponto, escala ou banco é alterado.
module.exports = function montarRotasTermosEscala(app, deps) {
  const T = require('./termos-escala'); const GP = require('./gestao-pessoas'); const pc = deps.pontocerto;
  const pcDeps = { colaboradores: () => pc.colaboradores(), cpfDe: id => pc.cpfDe(id) };
  const erroRes = (res, e) => { if (!e.status) console.error('[termos-escala]', e.message); res.status(e.status || 500).json({ error: e.message, erros: e.erros, duplicados: e.duplicados }); };
  const user = req => req.session && req.session.user;
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  const idOk = id => { if (!/^TE-\d{4}-\d{4,6}$/.test(String(id || ''))) throw Object.assign(new Error('Identificador inválido'), { status: 400 }); return id; };
  const pdfRes = (res, buf, nome, download) => { res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', (download ? 'attachment' : 'inline') + '; filename="' + nome + '"'); res.send(buf); };

  app.use('/api/termos-escala', (req, res, next) => {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (!GP.papeisDe(u).length) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', naoDesignado: true });
    if (!T.permissoes(u).ver) return res.status(403).json({ error: 'Seu papel não dá acesso aos Termos de Escala (RH / DP, Coordenação, Diretoria e Jurídico).', semAcesso: true });
    next();
  });
  app.get('/api/termos-escala/me', ok(req => { const u = user(req); const p = T.permissoes(u); return { usuario: u.usuario, nome: u.nome, ...p, lojas: GP.LOJAS.filter(l => GP.veLoja(u, l) || GP.temPapel(u, 'financeiro')).map(n => ({ n, txt: GP.LOJA_TXT[n] })), tipos: T.TIPO_TXT, modelo: T.modelo(), hoje: T.hojeISO(), proximoDomingo: T.proximoDomingo() }; }));
  app.get('/api/termos-escala/data/:data', ok(req => T.infoData(req.params.data)));
  // Funcionários ativos da loja no PontoCerto (CPF só mascarado) e quem está apto a receber termo
  app.get('/api/termos-escala/funcionarios/:loja', ok(async req => {
    const u = user(req); if (!T.permissoes(u).emitir) throw Object.assign(new Error('Só o RH / Departamento Pessoal emite termos'), { status: 403 });
    const loja = T.exigeLoja(u, req.params.loja);
    try { return await T.funcionariosDaLoja(loja, pcDeps); }
    catch (e) { GP.auditar({ usuario: u.usuario, acao: 'termo_escala_erro_ponto', erro: e.message }); throw Object.assign(new Error('PontoCerto indisponível agora: ' + e.message), { status: 502 }); }
  }));
  app.post('/api/termos-escala/previa', async (req, res) => { try { const b = req.body || {}; const buf = await T.previaPdf(b, user(req), pcDeps); pdfRes(res, buf, 'previa-termo-escala.pdf', false); } catch (e) { erroRes(res, e); } });
  app.post('/api/termos-escala/previa-modelo', async (req, res) => { try { const buf = await T.previaModelo(req.body || {}, user(req)); pdfRes(res, buf, 'previa-modelo-termo-escala.pdf', false); } catch (e) { erroRes(res, e); } });
  app.post('/api/termos-escala/emitir', ok(req => T.emitir(req.body || {}, user(req), pcDeps)));
  app.get('/api/termos-escala/emissoes', ok(req => T.listar(req.query, user(req))));
  app.get('/api/termos-escala/emissoes/:id', ok(req => T.obter(idOk(req.params.id), user(req))));
  app.get('/api/termos-escala/emissoes/:id/pdf', (req, res) => {
    try {
      const r = T.arquivoPdf(idOk(req.params.id), user(req), String(req.query.reimpressao) === '1');
      res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', (String(req.query.download) === '1' ? 'attachment' : 'inline') + '; filename="' + r.nome + '"');
      res.sendFile(r.caminho);
    } catch (e) { erroRes(res, e); }
  });
  app.post('/api/termos-escala/emissoes/:id/cancelar', ok(req => T.cancelar(idOk(req.params.id), (req.body || {}).motivo, user(req))));
  app.put('/api/termos-escala/config', ok(req => T.salvarModelo(req.body || {}, user(req))));
};
