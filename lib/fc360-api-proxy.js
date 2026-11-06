// FC360 API (checklist no Postgres) — duas coisas que o Econômico Relatórios faz por ela,
// porque é o único processo com porta pública (Caddy → 3003) e rodando como serviço:
//
//   1. montar(app): proxy puro de /fc360-api/* → 127.0.0.1:3013. Tem que entrar ANTES
//      do body-parser e da sessão: o corpo passa intacto (fotos em base64 de até 30 MB)
//      e a API tem autenticação própria (token do Firebase), não usa a sessão daqui.
//   2. manterVivo(): sobe `node fc360-api.js` em C:\fc360\fc360-api e reinicia se cair,
//      igual ao cahu-wpp (lib/cahu-tabela-wpp.js iniciarBot). Sem precisar de admin nem
//      de tarefa agendada. FC360_API_EXTERNO=1 desliga (quando alguém subir por fora).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORTA_PADRAO = 3013;
const PREFIXO = '/fc360-api';

function montar(app, opts) {
  const porta = (opts && opts.porta) || Number(process.env.FC360_API_PORT) || PORTA_PADRAO;
  app.use(PREFIXO, (req, res) => {
    const caminho = req.originalUrl.slice(PREFIXO.length) || '/';
    const cabecalhos = Object.assign({}, req.headers, { 'x-forwarded-for': req.ip || '', 'x-forwarded-proto': req.protocol || 'https' });
    const up = http.request({ hostname: '127.0.0.1', port: porta, path: caminho, method: req.method, headers: cabecalhos }, r => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', err => {
      if (!res.headersSent) res.status(502).json({ error: 'fc360-api não respondeu: ' + err.message });
      else res.end();
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  });
  return { porta, prefixo: PREFIXO };
}

function manterVivo(opts) {
  opts = opts || {};
  const log = opts.log || ((...a) => console.log('[fc360-api]', ...a));
  if (process.env.FC360_API_EXTERNO === '1') { log('FC360_API_EXTERNO=1 — não sobe o processo'); return null; }
  const dir = opts.dir || process.env.FC360_API_DIR || 'C:\\fc360\\fc360-api';
  const entrada = path.join(dir, 'fc360-api.js');
  if (!fs.existsSync(entrada)) { log('sem', entrada, '— API não instalada neste servidor (modo silencioso)'); return null; }
  const logDir = path.join(dir, 'data');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* já existe */ }
  const { spawn } = require('child_process');
  const esperaReinicio = opts.esperaReinicioMs || 10000;
  const ctl = { filho: null, parando: false, subidas: 0 };
  const subir = () => {
    if (ctl.parando) return;
    const out = fs.openSync(path.join(logDir, 'api.log'), 'a');
    ctl.filho = spawn(process.execPath, [entrada], { cwd: dir, stdio: ['ignore', out, out], windowsHide: true, env: Object.assign({}, process.env, opts.env || {}) });
    ctl.subidas++;
    log(`processo iniciado (pid ${ctl.filho.pid}), log em ${path.join(logDir, 'api.log')}`);
    ctl.filho.on('exit', code => {
      try { fs.closeSync(out); } catch { /* ok */ }
      ctl.filho = null;
      if (ctl.parando) return;
      log(`processo saiu (código ${code}); reinicia em ${esperaReinicio / 1000}s`);
      ctl.timer = setTimeout(subir, esperaReinicio);
      if (ctl.timer.unref) ctl.timer.unref();
    });
  };
  subir();
  ctl.parar = () => { ctl.parando = true; if (ctl.timer) clearTimeout(ctl.timer); if (ctl.filho) { try { ctl.filho.kill(); } catch { /* ok */ } } };
  if (opts.registrarSinais !== false) {
    process.on('exit', ctl.parar);
    process.on('SIGINT', () => { ctl.parar(); process.exit(0); });
    process.on('SIGTERM', () => { ctl.parar(); process.exit(0); });
  }
  return ctl;
}

module.exports = { montar, manterVivo, PREFIXO, PORTA_PADRAO };
