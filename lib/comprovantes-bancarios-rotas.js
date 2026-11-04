'use strict';
// lib/comprovantes-bancarios-rotas.js — rotas /api/comprovantes-bancarios/* (DP / RH › Comprovantes Bancários, 04/11/2026). Devolve o
// catálogo, o diagnóstico e a base real de lib/comprovantes-bancarios.js, que é montada sozinha por lib/comprovantes-bancarios-sync.js
// (Tiago, 04/11: "deixa isso automático"). Permissão = central de pessoas: Coordenação, Financeiro, RH / DP e Diretoria. CPD e demais
// papéis levam 403 aqui no servidor, não só na tela. Único POST: /sync/rodar (Coordenação dispara um ciclo agora). Consultas,
// visualizações e downloads ficam em data/comprovantes-bancarios/auditoria.jsonl. Nada aqui movimenta dinheiro.
const fs = require('fs');
const path = require('path');
const GP = require('./gestao-pessoas');
const CB = require('./comprovantes-bancarios');
const SYNC = require('./comprovantes-bancarios-sync');

function perm(user) {
  const papeis = GP.papeisDe(user);
  const coord = GP.temPapel(user, 'coordenacao'), fin = GP.temPapel(user, 'financeiro'), rh = GP.temPapel(user, ...GP.RH), dir = GP.temPapel(user, 'diretoria');
  return { papeis, coord, fin, rh, dir, ver: coord || fin || rh || dir, perfil: coord ? 'coordenacao' : fin ? 'financeiro' : rh ? 'rh' : dir ? 'diretoria' : null };
}
const PERFIL_TXT = { coordenacao: 'Coordenação', financeiro: 'Financeiro', rh: 'RH / DP', diretoria: 'Diretoria' };
function auditar(u, acao, ref, det) { try { fs.mkdirSync(CB.DIR, { recursive: true }); fs.appendFileSync(path.join(CB.DIR, 'auditoria.jsonl'), JSON.stringify({ em: new Date().toISOString(), quem: u.nome || u.usuario, usuario: u.usuario, perfil: PERFIL_TXT[perm(u).perfil] || perm(u).perfil || '—', acao, ref, det }) + '\n'); } catch (e) { /* auditoria nunca derruba a rota */ } }
const ultimaConsulta = new Map();   // usuário → ms da última consulta registrada (1 registro por usuário a cada 30 min, pra não encher o log)

module.exports = function montarRotasComprovantesBancarios(app, deps) {
  deps = deps || {};
  const user = req => req.session && req.session.user;
  app.use('/api/comprovantes-bancarios', (req, res, next) => {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (!perm(u).ver) { auditar(u, 'Acesso negado', req.path, 'Perfil sem acesso ao módulo'); return res.status(403).json({ error: 'Comprovantes Bancários é restrito a Coordenação, Financeiro, RH / DP e Diretoria.', semAcesso: true }); }
    if (req.method !== 'GET' && !(req.method === 'POST' && req.path === '/sync/rodar')) return res.status(405).json({ error: 'O módulo é alimentado pela sincronização automática; não há importação manual por aqui.' });
    next();
  });
  app.get('/api/comprovantes-bancarios/me', (req, res) => { const u = user(req); res.json({ usuario: u.usuario, nome: u.nome, ...perm(u) }); });
  app.get('/api/comprovantes-bancarios/dados', (req, res) => {
    const u = user(req); const k = u.usuario; const ag = Date.now(); if (!ultimaConsulta.has(k) || ag - ultimaConsulta.get(k) > 30 * 60000) { ultimaConsulta.set(k, ag); auditar(u, 'Consulta', 'módulo', 'Abriu Comprovantes Bancários'); }
    res.set('Cache-Control', 'no-store'); res.json(CB.dados());
  });
  app.get('/api/comprovantes-bancarios/sync', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(SYNC.status()); });
  app.post('/api/comprovantes-bancarios/sync/rodar', async (req, res) => {
    const u = user(req); if (!perm(u).coord) return res.status(403).json({ error: 'Só a Coordenação dispara a sincronização agora; o ciclo automático continua rodando sozinho.' });
    try { auditar(u, 'Importação', 'SYNC', 'Disparou a sincronização manualmente'); const r = await SYNC.sincronizar('manual · ' + u.usuario); res.json({ ok: !r.falha && !r.pulado, ciclo: r, status: SYNC.status() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // PDF de um documento vinculado (comprovante SISPAG / recibo lidos na Auditoria da Folha): o caminho fica no registro; visualização e download auditados
  app.get('/api/comprovantes-bancarios/doc/:id/:idx', (req, res) => {
    const u = user(req); const d = CB.dados(); const x = d.PAGAMENTOS.find(p => p.id === req.params.id) || d.GUIAS.find(g => g.id === req.params.id);
    const doc = x && x.docs && x.docs[+req.params.idx]; if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
    if (!doc.caminho || !fs.existsSync(doc.caminho)) return res.status(404).json({ error: 'Arquivo não disponível no servidor' });
    const download = String(req.query.download) === '1'; auditar(u, download ? 'Download' : 'Visualização', x.id, doc.nome + ' · ' + CB.CLASSE_DOC[doc.classe]);
    res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', (download ? 'attachment' : 'inline') + '; filename="' + String(doc.nome).replace(/["\r\n]/g, '') + '"' + (doc.pagina ? '' : '')); res.sendFile(path.resolve(doc.caminho));
  });
  if (!deps.semSync && process.env.COMPROVANTES_SYNC !== '0') SYNC.iniciar({ q: deps.q, pontocerto: deps.pontocerto });
};
module.exports.perm = perm;
