'use strict';
// lib/comprovantes-bancarios-rotas.js — rotas /api/comprovantes-bancarios/* (DP / RH › Comprovantes Bancários, 04/11/2026). Só leitura
// por enquanto: devolve o catálogo, o diagnóstico e a base real de lib/comprovantes-bancarios.js (vazia até a Fase C). Permissão =
// central de pessoas: Coordenação, Financeiro, RH / DP e Diretoria. CPD e demais papéis levam 403 aqui no servidor, não só na tela.
const GP = require('./gestao-pessoas');
const CB = require('./comprovantes-bancarios');

function perm(user) {
  const papeis = GP.papeisDe(user);
  const coord = GP.temPapel(user, 'coordenacao'), fin = GP.temPapel(user, 'financeiro'), rh = GP.temPapel(user, ...GP.RH), dir = GP.temPapel(user, 'diretoria');
  return { papeis, coord, fin, rh, dir, ver: coord || fin || rh || dir, perfil: coord ? 'coordenacao' : fin ? 'financeiro' : rh ? 'rh' : dir ? 'diretoria' : null };
}

module.exports = function montarRotasComprovantesBancarios(app) {
  const user = req => req.session && req.session.user;
  app.use('/api/comprovantes-bancarios', (req, res, next) => {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'Importação e conciliação entram na Fase C: por enquanto o módulo só consulta.' });
    if (!perm(u).ver) return res.status(403).json({ error: 'Comprovantes Bancários é restrito a Coordenação, Financeiro, RH / DP e Diretoria.', semAcesso: true });
    next();
  });
  app.get('/api/comprovantes-bancarios/me', (req, res) => { const u = user(req); res.json({ usuario: u.usuario, nome: u.nome, ...perm(u) }); });
  app.get('/api/comprovantes-bancarios/dados', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(CB.dados()); });
};
module.exports.perm = perm;
