const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tvs = require('../lib/acesso-tvs');
const s = require('../lib/seguranca-acesso');

const req = (origem, headers) => ({ socket: { remoteAddress: origem }, headers: headers || {} });
const ROT = ['192.168.2.1'];

test('redePrivada', () => {
  for (const ip of ['192.168.2.10', '10.0.0.5', '172.16.0.1', '172.31.255.254', 'fe80::1%eth0', 'fd12:3456::1']) assert.equal(s.redePrivada(ip), true, ip);
  for (const ip of ['200.1.2.3', '172.32.0.1', '172.15.0.1', '192.169.1.1', '100.102.231.28', '2804:14c::1', '', 'abc', '192.168.2', '192.168.2.999']) assert.equal(s.redePrivada(ip), false, ip);
});

test('origemChamada: só local direto e rede interna direta são confiáveis', () => {
  assert.deepEqual(s.origemChamada(req('127.0.0.1'), ROT), { tipo: 'local', confiavel: true, ip: '127.0.0.1' });
  assert.deepEqual(s.origemChamada(req('::ffff:192.168.2.10'), ROT), { tipo: 'interna', confiavel: true, ip: '192.168.2.10' });
  // pelo Caddy: de fora e também de dentro pelo nome público (chega como o roteador)
  assert.deepEqual(s.origemChamada(req('::1', { 'x-forwarded-for': '201.5.5.5' }), ROT), { tipo: 'link', confiavel: false, ip: '201.5.5.5' });
  assert.deepEqual(s.origemChamada(req('127.0.0.1', { 'x-forwarded-for': '192.168.2.1' }), ROT), { tipo: 'link', confiavel: false, ip: '192.168.2.1' });
  // direto na porta: roteador, IP público, rede interna com proxy
  assert.equal(s.origemChamada(req('192.168.2.1'), ROT).tipo, 'roteador');
  assert.equal(s.origemChamada(req('192.168.2.1'), ROT).confiavel, false);
  assert.deepEqual(s.origemChamada(req('201.5.5.5'), ROT), { tipo: 'fora', confiavel: false, ip: '201.5.5.5' });
  assert.equal(s.origemChamada(req('201.5.5.5', { 'x-forwarded-for': '192.168.2.10' }), ROT).confiavel, false);   // cabeçalho inventado não vale
  assert.equal(s.origemChamada(req('192.168.2.50', { via: '1.1 x' }), ROT).tipo, 'proxy');
  assert.equal(s.origemChamada(req('100.102.231.28'), ROT).tipo, 'fora');
  assert.equal(s.origemChamada({}, ROT).confiavel, false);
});

test('caminhoDeTv: telas e dados de TV sim; batimento, login e o resto não', () => {
  for (const p of ['/painel-compras.html', '/api/diretoria/kpis', '/api/painel-cd', '/tv', '/api/paineis-publico/compras-dados', '/API/Paineis-Publico/fiscal-dados', '/api/paineis-publico/robo-dados/'])
    assert.equal(tvs.caminhoDeTv(p), true, p);
  for (const p of ['/api/paineis-publico/batimento', '/api/paineis-publico/batimento/', '/login.html', '/api/login', '/api/versao', '/coletor-economico.apk', '/api/usuarios', '/index.html', '', '/api/tv-rh-publico/' + 'a'.repeat(32)])
    assert.equal(tvs.caminhoDeTv(p), false, p);
});

test('criarModo: lê o arquivo, cai no padrão quando falta ou está estranho, e relê depois da validade', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvs-'));
  const arq = path.join(dir, 'acesso-tvs.json');
  let t = 0;
  const modo = tvs.criarModo(arq, 'observar', { agora: () => t });
  assert.equal(modo(), 'observar');
  fs.writeFileSync(arq, JSON.stringify({ modo: 'fechar' }));
  assert.equal(modo(), 'observar');   // ainda no cache
  t = 20000;
  assert.equal(modo(), 'fechar');
  fs.writeFileSync(arq, '{"modo":"qualquer"}'); t = 40000;
  assert.equal(modo(), 'observar');
  fs.writeFileSync(arq, 'lixo'); t = 60000;
  assert.equal(tvs.criarModo(arq, 'fechar', { agora: () => t })(), 'fechar');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('criarRegistro: junta por origem+IP+endereço, grava, relê e respeita o teto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvs-'));
  const arq = path.join(dir, 'obs.json');
  let n = 0;
  const agora = () => '2026-11-18T18:00:' + String(n++).padStart(2, '0');
  const r = tvs.criarRegistro({ arquivo: arq, agora });
  assert.equal(r.gravar(), false);   // nada mudou
  r.registrar({ caminho: '/api/painel-cd', ip: '192.168.2.193', origem: 'interna', dispositivo: 'Windows · Chrome' });
  r.registrar({ caminho: '/api/painel-cd', ip: '192.168.2.193', origem: 'interna', dispositivo: 'Windows · Chrome' });
  r.registrar({ caminho: '/api/diretoria/kpis', ip: '201.5.5.5', origem: 'link', dispositivo: 'Android · Chrome', barrado: true });
  const l = r.listar();
  assert.equal(l.length, 2);
  assert.deepEqual([l[0].origem, l[0].vezes, l[0].barradas], ['interna', 2, 0]);
  assert.deepEqual([l[1].origem, l[1].vezes, l[1].barradas], ['link', 1, 1]);
  assert.equal(r.gravar(), true);
  const de_novo = tvs.criarRegistro({ arquivo: arq, agora });
  de_novo.registrar({ caminho: '/api/painel-cd', ip: '192.168.2.193', origem: 'interna' });
  assert.equal(de_novo.listar()[0].vezes, 3);
  assert.equal(de_novo.listar()[0].dispositivo, 'Windows · Chrome');

  const pequeno = tvs.criarRegistro({ maxLinhas: 3, agora });
  for (let i = 0; i < 10; i++) pequeno.registrar({ caminho: '/tv', ip: '9.9.9.' + i, origem: 'fora' });
  assert.equal(pequeno.listar().length, 3);
  assert.equal(pequeno.listar().some(x => x.ip === '9.9.9.9'), true);   // a mais nova fica
  fs.rmSync(dir, { recursive: true, force: true });
});
