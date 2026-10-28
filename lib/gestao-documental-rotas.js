'use strict';
// lib/gestao-documental-rotas.js — rotas /api/gestao-documental/* (DP / RH › Gestão Documental, etapa 02). Regras em lib/gestao-documental.js.
// Entrada: sessão do sistema + módulo DP / RH + designação na central de pessoas (cpd / RH / coordenação / diretoria) ou admin.
// Upload: 1 arquivo (envio, reenvio, importação, substituição) ou até 50 (lote), 25 MB cada, só PDF/JPG/PNG/WEBP — o lib ainda
// confere os primeiros bytes. Arquivo é servido só por aqui (sem pasta pública), com nosniff e sem cache.
// Autorização da Coordenação exige a senha da PRÓPRIA conta logada (bcrypt via deps.validarSenha); a senha não passa pelo lib,
// não é gravada e 5 erros seguidos bloqueiam o usuário por 15 min.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
module.exports = function montarRotasGestaoDocumental(app, deps) {
  const D = require('./gestao-documental'); const GP = require('./gestao-pessoas'); const { multer, pontocerto, validarSenha } = deps;
  const pcDeps = { colaboradores: () => pontocerto.colaboradores() };
  // o cadastro do PontoCerto leva ~40 s frio e tem cache de 20 min: aquece ao abrir a tela e a cada 15 min, pra ficha, envio e
  // importação não travarem o usuário (28/10/2026, importar levou 37 s em produção)
  const aquecer = () => { try { Promise.resolve(pontocerto.colaboradores()).catch(() => {}); } catch (e) { /* sem token = nada a aquecer */ } };
  if (!process.env.CGD_SEM_AQUECIMENTO) setInterval(aquecer, 15 * 60 * 1000).unref();
  const erroRes = (res, e) => { if (!e.status) console.error('[gestao-documental]', e.message); res.status(e.status || 500).json({ error: e.message, duplicadoDe: e.duplicadoDe }); };
  const user = req => req.session && req.session.user ? { ...req.session.user, ip: req.ip } : null;
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  const protOk = (p, pref) => { if (!new RegExp('^' + (pref || 'CGD') + '-\\d{4}-\\d{4,7}$').test(String(p || ''))) throw Object.assign(new Error('Protocolo inválido'), { status: 400 }); return p; };
  const limparTmp = files => { for (const f of [].concat(files || [])) { try { if (f && f.path) fs.unlinkSync(f.path); } catch (e) { /* já movido */ } } };

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, f, cb) => { const d = path.join(D.DIR, 'arquivos', '_tmp'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
      filename: (req, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(f.originalname || '').toLowerCase().slice(0, 6)),
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 50 },
    fileFilter: (req, f, cb) => { if (/^(application\/pdf|image\/(jpeg|png|webp))$/i.test(f.mimetype) && /\.(pdf|jpe?g|png|webp)$/i.test(f.originalname || '')) return cb(null, true); cb(Object.assign(new Error('Tipo de arquivo não aceito: ' + (f.originalname || f.mimetype) + '. Só PDF, JPG, PNG ou WEBP.'), { status: 400 })); },
  });
  const up1 = (req, res, next) => upload.single('arquivo')(req, res, err => { if (err) return erroRes(res, err.code === 'LIMIT_FILE_SIZE' ? Object.assign(err, { status: 400, message: 'Arquivo maior que 25 MB' }) : err); next(); });
  const upN = (req, res, next) => upload.array('arquivos', 50)(req, res, err => { if (err) return erroRes(res, err.code === 'LIMIT_FILE_SIZE' ? Object.assign(err, { status: 400, message: 'Arquivo maior que 25 MB' }) : err); next(); });
  const comArquivo = fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { limparTmp(req.file || req.files); erroRes(res, e); } };

  // contador do menu: nunca 403 (nav.js chama em toda página)
  app.get('/api/gestao-documental/pendencias', (req, res) => { const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' }); try { res.json(D.pendencias(u)); } catch (e) { res.json({ n: 0 }); } });
  app.use('/api/gestao-documental', (req, res, next) => {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    const p = D.permissoes(u);
    if (!p.ver) return res.status(403).json({ error: GP.papeisDe(u).length ? 'Seu papel não dá acesso à Gestão Documental (CPD da unidade, RH, Coordenação ou Diretoria).' : 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', semAcesso: true });
    next();
  });
  app.get('/api/gestao-documental/me', ok(req => { const u = user(req); const p = D.permissoes(u); const c = D.config(); aquecer();
    return { usuario: u.usuario, nome: u.nome, ver: p.ver, cpd: p.cpd, rh: p.rh, coord: p.coord, dir: p.dir, admin: p.admin, importar: p.importar, autorizar: p.autorizar, config: p.config, papeis: p.papeis, lojasCpd: p.lojasCpd,
      lojas: p.lojas.map(n => ({ n, txt: GP.LOJA_TXT[n] })), catalogos: { categorias: D.CATEGORIAS, status: D.STATUS_TXT, origens: D.ORIGEM_TXT, origensDetalhe: D.ORIGEM_DET_TXT, solStatus: D.SOL_STATUS_TXT, autOp: D.AUT_OP_TXT, autStatus: D.AUT_STATUS_TXT, acoes: D.ACAO_TXT, papeis: GP.PAPEIS },
      config: { prazoRhDias: c.prazoRhDias, prazoCpdDias: c.prazoCpdDias, maxMb: c.maxMb, retencaoAnos: c.retencaoAnos, avisarWhatsapp: c.avisarWhatsapp }, hoje: D._util.hojeISO(), pendencias: D.pendencias(u).n, naoLidas: GP.notificacoes(u, true).length }; }));
  app.get('/api/gestao-documental/colaboradores', ok(req => D.buscarColaboradores(user(req), req.query.q, req.query.loja, pcDeps, String(req.query.desligados) === '1')));
  app.get('/api/gestao-documental/painel', ok(req => D.painel(user(req), req.query)));
  app.get('/api/gestao-documental/documentos', ok(req => D.listar(user(req), req.query)));
  app.get('/api/gestao-documental/fila', ok(req => D.fila(user(req))));
  app.get('/api/gestao-documental/prontuarios', ok(req => D.prontuarios(user(req), req.query, pcDeps)));
  app.get('/api/gestao-documental/prontuarios/:colab', ok(req => D.prontuario(req.params.colab, user(req), pcDeps)));
  // envio pelo CPD · reenvio após correção · importação histórica (RH) · substituição autorizada
  app.post('/api/gestao-documental/documentos', up1, comArquivo(async req => D.resumo(await D.enviar(user(req), req.body || {}, req.file, pcDeps), user(req))));
  app.post('/api/gestao-documental/documentos/:prot/reenvio', up1, comArquivo(async req => D.resumo(D.reenviar(protOk(req.params.prot), user(req), req.body || {}, req.file), user(req))));
  app.post('/api/gestao-documental/importar', up1, comArquivo(async req => D.resumo(await D.importar(user(req), req.body || {}, req.file, pcDeps), user(req))));
  app.post('/api/gestao-documental/importar-lote', upN, comArquivo(async req => { let itens; try { itens = JSON.parse(req.body.itens || '[]'); } catch (e) { throw Object.assign(new Error('Lista de itens inválida'), { status: 400 }); } return D.importarLote(user(req), itens, req.files, pcDeps); }));
  app.post('/api/gestao-documental/documentos/:prot/substituir', up1, comArquivo(async req => D.resumo(D.substituir(protOk(req.params.prot), user(req), req.body || {}, req.file), user(req))));
  app.get('/api/gestao-documental/documentos/:prot', ok(req => D.detalhe(protOk(req.params.prot), user(req))));
  // conferência do RH — transição validada no lib (papel + unidade + status atual); clique repetido = 409
  const ACOES = { analisar: (p, u) => D.analisar(p, u), validar: (p, u, b) => D.validar(p, u, b), corrigir: (p, u, b) => D.corrigir(p, u, b), rejeitar: (p, u, b) => D.rejeitar(p, u, b) };
  app.post('/api/gestao-documental/documentos/:prot/:acao', ok(req => { const fn = ACOES[req.params.acao]; if (!fn) throw Object.assign(new Error('Ação desconhecida'), { status: 404 }); return D.resumo(fn(protOk(req.params.prot), user(req), req.body || {}), user(req)); }));
  // arquivo: só pela rota autenticada; inline pra pré-visualizar (PDF/imagem), ?download=1 baixa; nosniff impede o navegador de "adivinhar" outro tipo
  app.get('/api/gestao-documental/arquivo/:prot', (req, res) => {
    try { const a = D.arquivo(protOk(req.params.prot), user(req), req.query.v);
      res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'"); res.set('Content-Type', a.tipo || 'application/octet-stream');
      res.set('Content-Disposition', (String(req.query.download) === '1' ? 'attachment' : 'inline') + '; filename="' + a.nome.replace(/["\\]/g, '') + '"'); res.sendFile(a.caminho);
    } catch (e) { erroRes(res, e); }
  });
  // solicitações do RH às unidades
  app.get('/api/gestao-documental/solicitacoes', ok(req => D.listarSolicitacoes(user(req), req.query)));
  app.post('/api/gestao-documental/solicitacoes', ok(req => D.criarSolicitacao(user(req), req.body || {}, pcDeps)));
  app.post('/api/gestao-documental/solicitacoes/:prot/cancelar', ok(req => D.cancelarSolicitacao(protOk(req.params.prot, 'SOL'), user(req), (req.body || {}).motivo)));
  // autorizações: RH pede · Coordenação decide com a senha da própria conta (reautenticação)
  app.get('/api/gestao-documental/autorizacoes', ok(req => D.listarAutorizacoes(user(req), req.query)));
  app.post('/api/gestao-documental/autorizacoes', ok(req => D.solicitarAutorizacao(user(req), req.body || {})));
  const falhas = new Map();   // usuario → { n, ate }
  app.post('/api/gestao-documental/autorizacoes/:prot/decidir', async (req, res) => {
    try {
      const u = user(req); const b = req.body || {}; const f = falhas.get(u.usuario);
      if (f && f.ate > Date.now()) throw Object.assign(new Error('Muitas tentativas de senha — aguarde ' + Math.ceil((f.ate - Date.now()) / 60000) + ' min'), { status: 429 });
      if (!D.permissoes(u).autorizar) throw Object.assign(new Error('Só a Coordenação Administrativa decide autorizações'), { status: 403 });
      const senhaOk = !!b.senha && await validarSenha(u.usuario, String(b.senha)); b.senha = undefined;
      if (!senhaOk) { const n = ((f && f.ate > Date.now() - 900000 ? f.n : 0) || 0) + 1; falhas.set(u.usuario, { n, ate: n >= 5 ? Date.now() + 900000 : 0 }); throw Object.assign(new Error('Senha não confere' + (n >= 5 ? ' — bloqueado por 15 min' : ' (' + (5 - n) + ' tentativa(s) restante(s))')), { status: 401 }); }
      falhas.delete(u.usuario);
      res.json(D.decidirAutorizacao(protOk(req.params.prot, 'AUT'), u, { decisao: b.decisao, texto: b.texto }, true));
    } catch (e) { erroRes(res, e); }
  });
  app.get('/api/gestao-documental/auditoria', ok(req => D.auditoria(user(req), req.query)));
  app.get('/api/gestao-documental/config', ok(req => { if (!D.permissoes(user(req)).config) throw Object.assign(new Error('Só a Coordenação'), { status: 403 }); return D.config(); }));

  // ── Central de Ponto (etapa 03, 28/10/2026): espelhos da VR/Pontomais por competência — regras em lib/gestao-documental-ponto.js ──
  const PT = require('./gestao-documental-ponto');
  // cpfDe/empregadorDe: CPF inteiro e razão social + CNPJ da unidade empregadora (VR) só pra montar o PDF do espelho — nunca vão pra listagem
  const ptDeps = { colaboradores: () => pontocerto.colaboradores(), jornadaPeriodo: (id, de, ate) => pontocerto.jornadaPeriodo(id, de, ate), cpfDe: id => pontocerto.cpfDe(id), empregadorDe: id => pontocerto.empregadorDe(id) };
  const compDe = req => { const c = String((req.query && req.query.competencia) || (req.body && req.body.competencia) || PT.compAtual()); if (!PT.compOk(c)) throw Object.assign(new Error('Competência inválida'), { status: 400 }); return c; };
  app.get('/api/gestao-documental/ponto/painel', ok(req => PT.painel(user(req), compDe(req), ptDeps)));
  app.get('/api/gestao-documental/ponto/funcionarios', ok(req => PT.listar(user(req), compDe(req), req.query)));
  app.get('/api/gestao-documental/ponto/divergencias', ok(req => PT.divergencias(user(req), compDe(req), req.query)));
  app.get('/api/gestao-documental/ponto/fechamentos', ok(req => PT.fechamentos(user(req))));
  app.get('/api/gestao-documental/ponto/sync', ok(req => PT.statusSync()));
  app.post('/api/gestao-documental/ponto/sync', ok(req => PT.sincronizar(user(req), compDe(req), { loja: (req.body || {}).loja }, ptDeps)));
  app.post('/api/gestao-documental/ponto/fechamentos/confirmar', ok(req => PT.confirmarFechamento(user(req), compDe(req), req.body || {})));
  app.post('/api/gestao-documental/ponto/conferir-lote', ok(req => PT.conferirLote(user(req), compDe(req), (req.body || {}).ids)));
  app.post('/api/gestao-documental/ponto/preparar-assinatura', ok(req => PT.prepararAssinatura(user(req), compDe(req), (req.body || {}).ids, ptDeps)));
  app.get('/api/gestao-documental/ponto/espelho/:colab', ok(req => PT.espelho(user(req), compDe(req), req.params.colab)));
  app.post('/api/gestao-documental/ponto/espelho/:colab/conferir', ok(req => PT.conferir(user(req), compDe(req), req.params.colab, req.body || {})));
  app.post('/api/gestao-documental/ponto/espelho/:colab/arquivar', ok(req => PT.arquivar(user(req), compDe(req), req.params.colab, ptDeps)));
  app.get('/api/gestao-documental/ponto/espelho/:colab/pdf', async (req, res) => {
    try { const r = await PT.pdf(user(req), compDe(req), req.params.colab, ptDeps); res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', (String(req.query.download) === '1' ? 'attachment' : 'inline') + '; filename="' + r.nome + '"'); res.send(r.buffer); }
    catch (e) { erroRes(res, e); }
  });
  // sincronização automática diária às 06:15: competência atual e, até o dia 10, a anterior (usuário de sistema; roda como RH)
  if (!process.env.CGD_SEM_AQUECIMENTO) {
    const SISTEMA = { usuario: 'sistema', nome: 'Sincronização automática', perfil: 'admin' }; let ultimoDia = null;
    setInterval(() => { try { const ag = new Date(); const hoje = ag.toISOString().slice(0, 10); if (ag.getHours() !== 6 || ag.getMinutes() < 15 || ultimoDia === hoje) return; ultimoDia = hoje;
      const atual = PT.compAtual(); const comps = ag.getDate() <= 10 ? [PT.compAnterior(atual), atual] : [atual];
      (async () => { for (const c of comps) { try { await PT.sincronizar(SISTEMA, c, { automatica: true, aguardar: true }, ptDeps); } catch (e) { console.error('[ponto] sync automática', c, e.message); } } })();
    } catch (e) { console.error('[ponto] agendador', e.message); } }, 60 * 1000).unref();
  }
  app.put('/api/gestao-documental/config', ok(req => D.salvarConfig(user(req), req.body || {})));
};
