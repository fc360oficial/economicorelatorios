const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const proxy = require('../lib/fc360-api-proxy');

function subirFalsoUpstream() {
  const visto = [];
  const srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', c => { corpo += c; });
    req.on('end', () => {
      visto.push({ method: req.method, url: req.url, corpo, auth: req.headers.authorization || '' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream': 'fc360' });
      res.end(JSON.stringify({ ok: true, url: req.url, bytes: corpo.length }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, porta: srv.address().port, visto })));
}

test('proxy /fc360-api/* repassa método, caminho, query, headers e corpo intactos (antes do body-parser)', async (t) => {
  const up = await subirFalsoUpstream();
  const app = express();
  proxy.montar(app, { porta: up.porta });
  app.use(express.json({ limit: '1kb' })); // limite minúsculo de propósito: o proxy não pode passar por aqui
  app.get('/outra', (req, res) => res.json({ fora: true }));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  t.after(() => { srv.close(); up.srv.close(); });

  const g = await fetch(base + '/fc360-api/health?x=1', { headers: { Authorization: 'Bearer abc' } });
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('x-upstream'), 'fc360');
  assert.deepEqual(await g.json(), { ok: true, url: '/health?x=1', bytes: 0 });
  assert.equal(up.visto[0].auth, 'Bearer abc');

  const grande = JSON.stringify({ fotos: [{ base64: 'x'.repeat(50000) }] });
  const p = await fetch(base + '/fc360-api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: grande });
  assert.equal(p.status, 200);
  assert.equal((await p.json()).bytes, grande.length, 'corpo de 50 KB passou inteiro, sem o limite de 1 KB do app');
  assert.equal(up.visto[1].method, 'POST');
  assert.equal(up.visto[1].url, '/sync');
  assert.equal(up.visto[1].corpo, grande);

  const raiz = await fetch(base + '/fc360-api');
  assert.equal((await raiz.json()).url, '/');

  const fora = await fetch(base + '/outra');
  assert.deepEqual(await fora.json(), { fora: true }, 'rotas fora do prefixo seguem normais');
});

test('upstream fora do ar responde 502 em JSON', async (t) => {
  const up = await subirFalsoUpstream();
  const porta = up.porta;
  await new Promise(r => up.srv.close(r));
  const app = express();
  proxy.montar(app, { porta });
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const r = await fetch('http://127.0.0.1:' + srv.address().port + '/fc360-api/health');
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /fc360-api não respondeu/);
});

test('manterVivo: sem fc360-api.js não sobe nada; com ele, sobe e reinicia quando o processo sai', async (t) => {
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'fc360-vazio-'));
  assert.equal(proxy.manterVivo({ dir: vazio, log, registrarSinais: false }), null);
  assert.match(logs[0], /não instalada/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc360-fake-'));
  const marca = path.join(dir, 'subidas.txt');
  fs.writeFileSync(path.join(dir, 'fc360-api.js'), `require('fs').appendFileSync(${JSON.stringify(marca)}, 'x'); process.exit(0);`);
  const ctl = proxy.manterVivo({ dir, log, registrarSinais: false, esperaReinicioMs: 150 });
  t.after(() => { ctl.parar(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(vazio, { recursive: true, force: true }); });
  const inicio = Date.now();
  while (Date.now() - inicio < 6000) {
    if (fs.existsSync(marca) && fs.readFileSync(marca, 'utf8').length >= 2) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(fs.readFileSync(marca, 'utf8').length >= 2, 'reiniciou pelo menos uma vez');
  assert.ok(ctl.subidas >= 2);
  assert.ok(fs.existsSync(path.join(dir, 'data', 'api.log')), 'log em data/api.log');
  ctl.parar();
  const subidasAoParar = ctl.subidas;
  await new Promise(r => setTimeout(r, 400));
  assert.equal(ctl.subidas, subidasAoParar, 'depois de parar() não sobe mais');
});

test('FC360_API_EXTERNO=1 desliga o manterVivo', () => {
  const antes = process.env.FC360_API_EXTERNO;
  process.env.FC360_API_EXTERNO = '1';
  try { assert.equal(proxy.manterVivo({ dir: os.tmpdir(), log: () => {}, registrarSinais: false }), null); }
  finally { if (antes === undefined) delete process.env.FC360_API_EXTERNO; else process.env.FC360_API_EXTERNO = antes; }
});
