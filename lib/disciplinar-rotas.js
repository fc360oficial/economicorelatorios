'use strict';
// lib/disciplinar-rotas.js — rotas /api/disciplinar/* (DP / RH › Gestão Disciplinar). Regras, PDF e arquivos em lib/disciplinar.js.
// Sessão do sistema + módulo DP / RH + designação na central de pessoas (gerente / RH / coordenação / diretoria / jurídico).
// PontoCerto só é lido (cadastro do colaborador e jornada no período da suspensão). Anexos ficam em data/disciplinar/anexos/<prot>/.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
module.exports = function montarRotasDisciplinar(app, deps) {
  const D = require('./disciplinar'); const GP = require('./gestao-pessoas'); const { multer, pontocerto } = deps;
  const pcDeps = { colaboradores: () => pontocerto.colaboradores(), jornadaPeriodo: (id, de, ate) => pontocerto.jornadaPeriodo(id, de, ate), cpfDe: id => pontocerto.cpfDe(id), empregadorDe: id => pontocerto.empregadorDe(id) };
  const erroRes = (res, e) => { if (!e.status) console.error('[disciplinar]', e.message); res.status(e.status || 500).json({ error: e.message, duplicados: e.duplicados }); };
  const user = req => req.session && req.session.user;
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  const protOk = p => { if (!/^DISC-\d{4}-\d{4,6}$/.test(String(p || ''))) throw Object.assign(new Error('Protocolo inválido'), { status: 400 }); return p; };
  const pdfRes = (res, buf, nome, download) => { res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', (download ? 'attachment' : 'inline') + '; filename="' + nome + '"'); res.send(buf); };

  // ── upload (mesma régua do Canal de Ética: 25 MB, 5 arquivos, tipos conhecidos) ──
  const TIPOS_OK = /^(image\/(jpeg|png|gif|webp|heic)|application\/pdf|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))|text\/plain|audio\/(mpeg|mp4|aac|ogg|x-m4a)|video\/(mp4|quicktime))$/i;
  const EXT_OK = /\.(jpe?g|png|gif|webp|heic|pdf|docx?|xlsx|txt|mp3|m4a|aac|ogg|mp4|mov)$/i;
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, f, cb) => { const d = path.join(D.DIR, 'anexos', '_tmp'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
      filename: (req, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(f.originalname || '').toLowerCase().slice(0, 8)),
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 5 },
    fileFilter: (req, f, cb) => { if (TIPOS_OK.test(f.mimetype) && EXT_OK.test(f.originalname || '')) return cb(null, true); cb(Object.assign(new Error('Tipo de arquivo não aceito: ' + (f.originalname || f.mimetype)), { status: 400 })); },
  });
  function guardarAnexos(prot, files) {
    const out = []; const dir = D.P.anexos(prot); fs.mkdirSync(dir, { recursive: true });
    for (const f of files || []) { const hash = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex'); fs.renameSync(f.path, path.join(dir, f.filename)); out.push({ nome: String(f.originalname || f.filename).slice(0, 120), arquivo: f.filename, tamanho: f.size, tipo: f.mimetype, hash }); }
    return out;
  }
  const limparTmp = files => { for (const f of files || []) { try { fs.unlinkSync(f.path); } catch (e) { /* já movido */ } } };
  const uploadSeguro = (req, res, next) => upload.array('anexos', 5)(req, res, err => { if (err) return erroRes(res, err.code === 'LIMIT_FILE_SIZE' ? Object.assign(err, { status: 400, message: 'Arquivo maior que 25 MB' }) : err); next(); });

  // ── entrada: logado + designado na central de pessoas + papel com acesso ──
  app.get('/api/disciplinar/pendencias', (req, res) => { const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' }); try { res.json(D.pendencias(u)); } catch (e) { res.json({ n: 0 }); } });   // contador do menu: nunca 403 (nav.js chama em toda página)
  app.use('/api/disciplinar', (req, res, next) => {
    const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (!GP.papeisDe(u).length && !D.permissoes(u).gerencial) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', naoDesignado: true });
    if (!D.permissoes(u).ver) return res.status(403).json({ error: 'Seu papel não dá acesso à Gestão Disciplinar (gerente, RH, Coordenação, Diretoria ou Jurídico).', semAcesso: true });
    next();
  });
  app.get('/api/disciplinar/me', ok(req => { const u = user(req); const p = D.permissoes(u); const c = D.config();
    return { usuario: u.usuario, nome: u.nome, ...p, lojas: GP.LOJAS.filter(l => D.veLoja(u, l)).map(n => ({ n, txt: GP.LOJA_TXT[n] })), lojasGerente: D.lojasGerente(u),
      catalogos: { motivos: D.MOTIVOS, medidas: D.MEDIDAS, medidasGerente: D.MEDIDAS_GERENTE, fundamentos: D.FUNDAMENTOS, status: D.STATUS_TXT, finais: D.FINAIS, responsaveis: D.RESP_TXT, anexos: D.ANEXO_CAT, acoes: D.ACAO_TXT },
      limites: { maxDias: c.maxDiasSuspensao, alertaDias: c.alertaDiasSuspensao, prazos: c.prazos }, modeloValidado: !!c.validadoJuridico, hoje: D._util.hojeISO(), naoLidas: GP.notificacoes(u, true).length, pendencias: D.pendencias(u).n }; }));
  app.get('/api/disciplinar/colaboradores', ok(req => D.buscarColaboradores(user(req), req.query.q, req.query.loja, pcDeps)));
  app.get('/api/disciplinar/historico/:colab', ok(req => D.historicoColaborador(req.params.colab, user(req))));
  app.get('/api/disciplinar/painel', ok(req => D.painel(user(req), req.query)));
  app.get('/api/disciplinar/solicitacoes', ok(req => D.listar(user(req), req.query)));
  app.post('/api/disciplinar/solicitacoes', ok(async req => D.resumo(await D.criar(user(req), req.body || {}, pcDeps), user(req))));
  app.get('/api/disciplinar/solicitacoes/:prot', ok(req => D.detalhe(protOk(req.params.prot), user(req))));
  app.put('/api/disciplinar/solicitacoes/:prot', ok(req => D.resumo(D.editar(protOk(req.params.prot), user(req), req.body || {}), user(req))));
  // anexos (evidências do gerente, esclarecimentos, documentos jurídicos, documento assinado / recusa)
  app.post('/api/disciplinar/solicitacoes/:prot/anexos', uploadSeguro, (req, res) => {
    try { const prot = protOk(req.params.prot); const b = req.body || {}; const u = user(req);
      D.obter(prot); const lista = guardarAnexos(prot, req.files);
      const s = b.categoria === 'assinado' ? D.devolverAssinado(prot, u, lista, b, false) : b.categoria === 'recusa' ? D.devolverAssinado(prot, u, lista, b, true) : D.registrarAnexos(prot, u, lista, b.categoria, b.descricao);
      res.json(D.resumo(s, u));
    } catch (e) { limparTmp(req.files); erroRes(res, e); }
  });
  app.get('/api/disciplinar/solicitacoes/:prot/anexos/:arquivo', (req, res) => {
    try { if (!/^[a-f0-9]{32}(\.[a-z0-9]{1,7})?$/i.test(req.params.arquivo)) throw Object.assign(new Error('Anexo inválido'), { status: 400 });
      const a = D.anexo(protOk(req.params.prot), user(req), req.params.arquivo); res.set('Cache-Control', 'no-store'); res.set('Content-Type', a.tipo || 'application/octet-stream'); res.set('Content-Disposition', (String(req.query.download) === '1' ? 'attachment' : 'inline') + '; filename="' + a.nome.replace(/["\\]/g, '') + '"'); res.sendFile(a.caminho);
    } catch (e) { erroRes(res, e); }
  });
  // documento (PDF): prévia (RH, antes de deferir ou antes de emitir) e arquivo definitivo por versão
  app.post('/api/disciplinar/solicitacoes/:prot/previa', async (req, res) => { try { const buf = await D.previa(protOk(req.params.prot), user(req), req.body || {}, pcDeps); pdfRes(res, buf, 'previa-' + req.params.prot + '.pdf', false); } catch (e) { erroRes(res, e); } });
  app.get('/api/disciplinar/solicitacoes/:prot/pdf', (req, res) => {
    try { const r = D.arquivoPdf(protOk(req.params.prot), user(req), req.query.versao); res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', (String(req.query.download) === '1' ? 'attachment' : 'inline') + '; filename="' + r.nome + '"'); res.sendFile(r.caminho); }
    catch (e) { erroRes(res, e); }
  });
  // ações do fluxo — uma rota, transição validada no lib (perfil + status atual); clique repetido = 409
  const ACOES = {
    enviar: (p, u) => D.enviar(p, u), complementar: (p, u, b) => D.complementar(p, u, b.texto), cancelar: (p, u, b) => D.cancelar(p, u, b.motivo),
    analisar: (p, u) => D.analisar(p, u), esclarecer: (p, u, b) => D.esclarecer(p, u, b.texto), responder: (p, u, b) => D.responder(p, u, b.texto),
    deferir: (p, u, b) => D.deferir(p, u, b), indeferir: (p, u, b) => D.indeferir(p, u, b.justificativa),
    confirmar_indeferimento: (p, u, b) => D.coordenacao(p, u, 'confirmar_indeferimento', b.texto), devolver_rh: (p, u, b) => D.coordenacao(p, u, 'devolver_rh', b.texto), solicitar_juridico: (p, u, b) => D.coordenacao(p, u, 'solicitar_juridico', b.texto),
    encaminhar_juridico: (p, u, b) => D.encaminharJuridico(p, u, b.texto), parecer_juridico: (p, u, b) => D.parecerJuridico(p, u, b.texto, b.data),
    emitir: (p, u, b) => D.emitir(p, u, b, pcDeps), reemitir: (p, u, b) => D.emitir(p, u, b, pcDeps), comunicar: (p, u, b) => D.comunicar(p, u, b),
    conferir_aprovar: (p, u, b) => D.conferir(p, u, true, b.texto), conferir_devolver: (p, u, b) => D.conferir(p, u, false, b.texto, b.motivo),
  };
  app.post('/api/disciplinar/solicitacoes/:prot/:acao', ok(async req => { const fn = ACOES[req.params.acao]; if (!fn) throw Object.assign(new Error('Ação desconhecida'), { status: 400 }); const s = await fn(protOk(req.params.prot), user(req), req.body || {}); return D.resumo(s, user(req)); }));
  // DP: pendências de folha das suspensões aplicadas
  app.get('/api/disciplinar/folha', ok(req => D.folhaListar(user(req), req.query)));
  app.get('/api/disciplinar/folha/:prot/ponto', ok(req => D.folhaPonto(protOk(req.params.prot), user(req), pcDeps)));
  app.post('/api/disciplinar/folha/:prot/conferir', ok(req => D.folhaConferir(protOk(req.params.prot), user(req), req.body || {})));
  // relatórios
  app.get('/api/disciplinar/relatorio', ok(req => D.relatorio(user(req), req.query)));
  app.get('/api/disciplinar/relatorio.xlsx', async (req, res) => { try { const buf = await D.relatorioXlsx(user(req), req.query); res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.set('Content-Disposition', 'attachment; filename="gestao-disciplinar.xlsx"'); res.send(Buffer.from(buf)); } catch (e) { erroRes(res, e); } });
  app.get('/api/disciplinar/relatorio.pdf', async (req, res) => { try { const buf = await D.relatorioPdf(user(req), req.query); pdfRes(res, buf, 'gestao-disciplinar.pdf', String(req.query.download) === '1'); } catch (e) { erroRes(res, e); } });
  // configuração (limites, prazos, modelos de texto, validação jurídica)
  app.get('/api/disciplinar/config', ok(req => { if (!D.permissoes(user(req)).configurar && !D.permissoes(user(req)).juridico) throw Object.assign(new Error('Sem acesso à configuração'), { status: 403 }); return D.config(); }));
  app.put('/api/disciplinar/config', ok(req => D.salvarConfig(req.body || {}, user(req))));
  app.get('/api/disciplinar/notificacoes', ok(req => GP.notificacoes(user(req), req.query.naoLidas === '1').filter(n => /^DISC-/.test(n.ref || ''))));
  app.post('/api/disciplinar/notificacoes/lidas', ok(req => { GP.marcarLidas(user(req), (req.body && req.body.ids) || []); return { ok: true }; }));
};
