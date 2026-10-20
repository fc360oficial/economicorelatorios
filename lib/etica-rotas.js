'use strict';
// lib/etica-rotas.js — Canal de Ética: rotas públicas (portal, sem login) e internas (retaguarda em DP / RH).
// Regras e dados em lib/etica.js. Montado pelo server.js; o tick de prazos roda a cada minuto.
//  Público  : GET /etica, /etica/<E1..E6|CD|ADM>  → portal (public/etica-portal.html)
//             GET /api/etica-publico/config · POST /api/etica-publico/registrar (multipart) · POST /api/etica-publico/consultar
//  Interno  : /api/etica/* — sessão do sistema + designação no canal (lib/etica.js › papeisDe). Admin do sistema
//             só entra enquanto NÃO houver designados (bootstrap), e só pra cadastrar os designados.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function montarRotasEtica(app, deps) {
  const { multer, publicDir } = deps;
  const E = require('./etica');
  const erroRes = (res, e) => res.status(e.status || 500).json({ error: e.message, bloqueio: e.bloqueio || undefined });
  const TIPOS_OK = /^(image\/(jpeg|png|gif|webp|heic)|audio\/(mpeg|mp4|aac|ogg|wav|x-m4a|webm)|video\/(mp4|quicktime|webm)|application\/pdf|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))|text\/plain)$/i;
  const EXT_OK = /\.(jpe?g|png|gif|webp|heic|mp3|m4a|aac|ogg|wav|webm|mp4|mov|pdf|docx?|xlsx|txt)$/i;
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, f, cb) => { const d = path.join(E.DIR, 'anexos', '_tmp'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
      filename: (req, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(f.originalname || '').toLowerCase().slice(0, 8)),
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 5 },
    fileFilter: (req, f, cb) => { if (TIPOS_OK.test(f.mimetype) && EXT_OK.test(f.originalname || '')) return cb(null, true); cb(Object.assign(new Error('Tipo de arquivo não aceito: ' + (f.originalname || f.mimetype)), { status: 400 })); },
  });
  // move os anexos recebidos pra pasta do caso; guarda hash sha256 pra integridade
  function guardarAnexos(prot, files) {
    const out = []; const dir = path.join(E.DIR, 'anexos', prot); fs.mkdirSync(dir, { recursive: true });
    for (const f of files || []) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
      const destino = path.join(dir, f.filename); fs.renameSync(f.path, destino);
      out.push({ nome: String(f.originalname || f.filename).slice(0, 120), arquivo: f.filename, tamanho: f.size, tipo: f.mimetype, hash });
    }
    return out;
  }
  const limparTmp = files => { for (const f of files || []) { try { fs.unlinkSync(f.path); } catch (e) { /* já movido */ } } };
  const uploadSeguro = campo => (req, res, next) => upload.array(campo, 5)(req, res, err => { if (err) return erroRes(res, err.code === 'LIMIT_FILE_SIZE' ? Object.assign(err, { status: 400, message: 'Arquivo maior que 25 MB' }) : err); next(); });

  // ── PÚBLICO ───────────────────────────────────────────────────────────────
  const portal = path.join(publicDir, 'etica-portal.html');
  app.get(['/etica', '/etica/:unid'], (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(portal); });
  app.get('/api/etica-publico/config', (req, res) => {
    const c = E.config();
    res.set('Cache-Control', 'no-store');
    res.json({ unidades: c.unidades.filter(u => u.cod !== 'NI'), categorias: c.categorias.map(x => ({ id: x.id, nome: x.nome })), anexos: { max: 5, mb: 25 } });
  });
  app.post('/api/etica-publico/registrar', uploadSeguro('anexos'), (req, res) => {
    try {
      const b = req.body || {};
      const r = E.registrar({ unidade: b.unidade, categoria: b.categoria, quando: b.quando, local: b.local, descricao: b.descricao, pessoas: b.pessoas, risco: b.risco === '1' || b.risco === 'true' || b.risco === true,
        identificar: b.identificar === '1' || b.identificar === 'true' || b.identificar === true, nome: b.nome, contato: b.contato, anexos: [] });
      const anexos = guardarAnexos(r.protocolo, req.files);
      if (anexos.length) E.anexosDoPortal(r.protocolo, anexos);
      res.json({ ok: true, ...r, anexos: anexos.length });
    } catch (e) { limparTmp(req.files); erroRes(res, e); }
  });
  app.post('/api/etica-publico/consultar', (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(E.consultar(req.body && req.body.protocolo, req.body && req.body.credencial)); }
    catch (e) { erroRes(res, e); }
  });

  // ── INTERNO ───────────────────────────────────────────────────────────────
  const user = req => req.session && req.session.user;
  function exigeDesignado(req, res, next) {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (E.papeisDe(u).length) return next();
    // dentro do app.use('/api/etica') o Express entrega req.path SEM o prefixo ('/me', '/config')
    if (E.bootstrapPermitido(u) && (req.path === '/me' || req.path === '/config')) return next();
    res.status(403).json({ error: 'Você não está entre os designados do Canal de Ética. Peça à Coordenação Administrativa ou ao Revisor independente.', naoDesignado: true });
  }
  app.use('/api/etica', exigeDesignado);
  const exigePapel = (...papeis) => (req, res, next) => { const u = user(req); if (E.temPapel(u, ...papeis) || (E.bootstrapPermitido(u) && papeis.includes('coordenacao'))) return next(); res.status(403).json({ error: 'Sem permissão (precisa ser ' + papeis.map(p => E.PAPEIS[p]).join(' ou ') + ')' }); };

  app.get('/api/etica/me', (req, res) => {
    const u = user(req); const c = E.config();
    res.json({ usuario: u.usuario, nome: u.nome, papeis: E.papeisDe(u), papeisTxt: E.PAPEIS, bootstrap: E.bootstrapPermitido(u), naoLidas: E.notificacoes(u, true).length,
      catalogos: { unidades: c.unidades, categorias: c.categorias, prioridades: E.PRIORIDADES.map(p => ({ id: p, txt: E.PRIORIDADE_TXT[p] })), status: E.STATUS.map(s => ({ id: s, txt: E.STATUS_TXT[s] })), cadeia: c.cadeia, resultados: E.RESULTADOS, desfechos: E.DESFECHOS_OM, etapas: E.ETAPA_TXT } });
  });
  app.get('/api/etica/config', (req, res) => { const c = E.config(); res.json({ ...c, designados: E.temPapel(user(req), 'coordenacao', 'revisor', 'triagem') || E.bootstrapPermitido(user(req)) ? c.designados : c.designados.map(d => ({ usuario: d.usuario, nome: d.nome, papeis: d.papeis })) }); });
  app.put('/api/etica/config', exigePapel('coordenacao', 'revisor'), (req, res) => {
    try { res.json(E.salvarConfig(req.body || {}, user(req).usuario)); } catch (e) { erroRes(res, e); }
  });
  // Cartazes com QR por unidade (20/10). O QR carrega só <urlPublica>/etica/<COD>; a base vem de config.urlPublica
  // (domínio próprio, quando houver) ou do PUBLIC_URL do servidor. Qualquer designado vê; a base só muda via PUT /config.
  const urlBase = () => String(E.config().urlPublica || deps.publicUrl || '').replace(/\/+$/, '');
  const unidadesCartaz = () => E.config().unidades.filter(u => u.cod !== 'NI');
  app.get('/api/etica/cartazes', (req, res) => {
    const base = urlBase();
    res.json({ base, configurada: !!E.config().urlPublica, unidades: unidadesCartaz().map(u => ({ cod: u.cod, nome: u.nome, url: base + '/etica/' + u.cod })), geral: base + '/etica' });
  });
  app.get('/api/etica/qr/:cod.svg', (req, res) => {
    const cod = String(req.params.cod || '').toUpperCase();
    const u = cod === 'GERAL' ? { cod: 'GERAL' } : unidadesCartaz().find(x => x.cod === cod);
    if (!u) return res.status(404).json({ error: 'Unidade desconhecida: ' + cod });
    const alvo = urlBase() + '/etica' + (cod === 'GERAL' ? '' : '/' + cod);
    require('qrcode').toString(alvo, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#101B33', light: '#FFFFFF' } }, (err, svg) => {
      if (err) return erroRes(res, err);
      res.set('Content-Type', 'image/svg+xml'); res.set('Cache-Control', 'no-store'); res.send(svg);
    });
  });
  app.get('/api/etica/usuarios', exigePapel('triagem', 'coordenacao', 'revisor'), (req, res) => {
    // lista de contas do sistema pra escolher designados (sem senha) — vem do server.js via deps.listarUsuarios
    const lista = (deps.listarUsuarios ? deps.listarUsuarios() : []).map(u => ({ usuario: u.usuario, nome: u.nome, perfil: u.perfil }));
    res.json(lista);
  });

  app.get('/api/etica/casos', (req, res) => { try { res.json(E.fila(user(req), req.query.fila || 'ativos')); } catch (e) { erroRes(res, e); } });
  app.get('/api/etica/casos/:prot', (req, res) => { try { res.json(E.detalhe(req.params.prot, user(req))); } catch (e) { erroRes(res, e); } });
  // identidade do denunciante: só com a senha de um administrador do sistema (deps.validarSenhaAdmin → usuário do admin ou null)
  app.post('/api/etica/casos/:prot/identidade', async (req, res) => {
    try {
      const senha = String((req.body && req.body.senha) || '');
      const admin = senha && deps.validarSenhaAdmin ? await deps.validarSenhaAdmin(senha) : null;
      res.json(E.revelarIdentidade(req.params.prot, user(req), admin));
    } catch (e) { erroRes(res, e); }
  });
  const acao = (nome, fn) => app.post('/api/etica/casos/:prot/' + nome, (req, res) => { try { const r = fn(req.params.prot, user(req), req.body || {}, req); res.json({ ok: true, resumo: E.resumo(E.obter(req.params.prot)), ...(r && r.extra ? r.extra : {}) }); } catch (e) { erroRes(res, e); } });
  acao('abrir', (p, u) => E.abrirTriagem(p, u));
  acao('triar', (p, u, b) => E.triar(p, u, b));
  acao('aceitar', (p, u) => E.aceitar(p, u));
  acao('impedimento', (p, u, b) => E.declararImpedimento(p, u, b.motivo));
  acao('redistribuicao', (p, u, b) => E.solicitarRedistribuicao(p, u, b.motivo));
  acao('redistribuir', (p, u, b) => { if (!E.temPapel(u, 'triagem', 'coordenacao')) throw Object.assign(new Error('Só Triagem ou Coordenação redistribuem'), { status: 403 }); return E.redistribuir(p, u, b); });
  acao('providencia', (p, u, b) => E.providencia(p, u, b));
  acao('prorrogar', (p, u, b) => E.solicitarProrrogacao(p, u, b));
  acao('prorrogacao', (p, u, b) => E.decidirProrrogacao(p, u, !!b.aprovar, b.texto));
  acao('validacao', (p, u, b) => E.enviarValidacao(p, u, b));
  acao('validar', (p, u, b) => E.validar(p, u, b));
  acao('reabrir', (p, u, b) => E.reabrir(p, u, b.motivo));
  app.post('/api/etica/casos/:prot/evidencia', uploadSeguro('anexos'), (req, res) => {
    try {
      const u = user(req); const prot = req.params.prot; const caso = E.obter(prot);
      if (!E.podeVer(u, caso)) throw Object.assign(new Error('Sem permissão'), { status: 403 });
      const anexos = guardarAnexos(prot, req.files);
      if (!anexos.length && !(req.body && req.body.descricao)) throw Object.assign(new Error('Envie um arquivo ou descreva a evidência'), { status: 400 });
      if (anexos.length) for (const a of anexos) E.evidencia(prot, u, { ...a, descricao: req.body.descricao });
      else E.evidencia(prot, u, { nome: null, descricao: req.body.descricao });
      res.json({ ok: true, resumo: E.resumo(E.obter(prot)) });
    } catch (e) { limparTmp(req.files); erroRes(res, e); }
  });
  app.get('/api/etica/casos/:prot/anexos/:arquivo', (req, res) => {
    try {
      const u = user(req); const caso = E.obter(req.params.prot);
      if (!E.podeVer(u, caso)) throw Object.assign(new Error('Sem permissão'), { status: 403 });
      const a = (caso.anexos || []).find(x => x.arquivo === req.params.arquivo); if (!a) throw Object.assign(new Error('Anexo não encontrado'), { status: 404 });
      E.auditar({ usuario: u.usuario, acao: 'anexo', protocolo: caso.protocolo, arquivo: a.arquivo });
      res.set('Cache-Control', 'no-store'); res.set('Content-Disposition', 'inline; filename="' + encodeURIComponent(a.nome || a.arquivo) + '"');
      res.type(a.tipo || 'application/octet-stream'); res.sendFile(path.join(E.DIR, 'anexos', caso.protocolo, a.arquivo));
    } catch (e) { erroRes(res, e); }
  });

  app.get('/api/etica/omissoes', exigePapel('coordenacao', 'revisor', 'rh', 'juridico', 'triagem', 'independente', 'investigador'), (req, res) => {
    const u = user(req); const tudo = E.temPapel(u, 'coordenacao', 'revisor');
    res.json(E.omissoes(tudo ? { status: req.query.status || undefined } : { usuario: u.usuario }));
  });
  app.post('/api/etica/omissoes/:id/manifestar', (req, res) => { try { res.json(E.manifestar(req.params.id, user(req), req.body && req.body.texto)); } catch (e) { erroRes(res, e); } });
  app.post('/api/etica/omissoes/:id/decidir', exigePapel('coordenacao', 'revisor'), (req, res) => { try { res.json(E.decidirOmissao(req.params.id, user(req), req.body || {})); } catch (e) { erroRes(res, e); } });

  app.get('/api/etica/painel', (req, res) => { try { res.json(E.painel(req.query, user(req))); } catch (e) { erroRes(res, e); } });
  app.get('/api/etica/notificacoes', (req, res) => res.json(E.notificacoes(user(req), req.query.naoLidas === '1')));
  app.post('/api/etica/notificacoes/lidas', (req, res) => { E.marcarLidas(user(req), (req.body && req.body.ids) || []); res.json({ ok: true }); });
  app.get('/api/etica/auditoria', exigePapel('coordenacao', 'revisor'), (req, res) => res.json(E.auditoria({ mes: req.query.mes, protocolo: req.query.protocolo })));
  app.post('/api/etica/tick', exigePapel('coordenacao', 'revisor'), (req, res) => res.json(E.tick()));

  // tick de prazos: a cada minuto, idempotente (marca o que já avisou/venceu no próprio caso)
  const timer = setInterval(() => { try { E.tick(); } catch (e) { console.error('[etica] tick:', e.message); } }, 60 * 1000);
  if (timer.unref) timer.unref();
  return { tick: () => E.tick() };
};
