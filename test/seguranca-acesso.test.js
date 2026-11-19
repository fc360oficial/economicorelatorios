const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../lib/seguranca-acesso');

const req = (origem, headers, query) => ({ socket: { remoteAddress: origem }, headers: headers || {}, query: query || {} });

test('extensaoEstaticaLivre: arquivo estático passa, /api nunca', () => {
  assert.equal(s.extensaoEstaticaLivre('/nav.js'), true);
  assert.equal(s.extensaoEstaticaLivre('/design-system.css'), true);
  assert.equal(s.extensaoEstaticaLivre('/img/Logo.PNG'), true);
  assert.equal(s.extensaoEstaticaLivre('/fornecedor/sw.js'), true);
  assert.equal(s.extensaoEstaticaLivre('/api/radar-precificacao/produto/1.js'), false);
  assert.equal(s.extensaoEstaticaLivre('/API/dashboard/seg/x.css'), false);
  assert.equal(s.extensaoEstaticaLivre('//api/log-erp/1.png'), false);
  assert.equal(s.extensaoEstaticaLivre('/api/etica/qr/E1.svg'), false);
  assert.equal(s.extensaoEstaticaLivre('/index.html'), false);
  assert.equal(s.extensaoEstaticaLivre('/data/usuarios.json'), false);
  assert.equal(s.extensaoEstaticaLivre('/pasta.js/arquivo'), false);
  assert.equal(s.extensaoEstaticaLivre('/'), false);
  assert.equal(s.extensaoEstaticaLivre(''), false);
});

test('chamadaLocalDireta: localhost sem proxy = sim; pelo Caddy ou de outra máquina = não', () => {
  assert.equal(s.chamadaLocalDireta(req('127.0.0.1')), true);
  assert.equal(s.chamadaLocalDireta(req('::1')), true);
  assert.equal(s.chamadaLocalDireta(req('::ffff:127.0.0.1')), true);
  assert.equal(s.chamadaLocalDireta(req('127.0.0.1', { 'x-forwarded-for': '200.1.2.3' })), false);
  assert.equal(s.chamadaLocalDireta(req('::1', { 'x-forwarded-proto': 'https' })), false);
  assert.equal(s.chamadaLocalDireta(req('127.0.0.1', { via: '1.1 Caddy' })), false);
  assert.equal(s.chamadaLocalDireta(req('192.168.2.10')), false);
  assert.equal(s.chamadaLocalDireta(req('200.1.2.3')), false);
  assert.equal(s.chamadaLocalDireta({}), false);
});

test('ipCliente: X-Forwarded-For só vale vindo do Caddy, e vale o último da lista', () => {
  assert.equal(s.ipCliente(req('127.0.0.1', { 'x-forwarded-for': '200.1.2.3' })), '200.1.2.3');
  assert.equal(s.ipCliente(req('::1', { 'x-forwarded-for': '9.9.9.9, 200.1.2.3' })), '200.1.2.3');
  assert.equal(s.ipCliente(req('201.5.5.5', { 'x-forwarded-for': '9.9.9.9' })), '201.5.5.5');
  assert.equal(s.ipCliente(req('::ffff:192.168.2.61')), '192.168.2.61');
  assert.equal(s.ipCliente(req('127.0.0.1')), '127.0.0.1');
});

test('autorizaInterno: token antigo só local direto; de fora só a chave comprida no cabeçalho', () => {
  const chave = 'a'.repeat(64);
  assert.equal(s.autorizaInterno(req('127.0.0.1', {}, { token: 'tok' }), 'tok', chave), true);
  assert.equal(s.autorizaInterno(req('127.0.0.1', {}, { token: 'errado' }), 'tok', chave), false);
  assert.equal(s.autorizaInterno(req('127.0.0.1', { 'x-forwarded-for': '200.1.2.3' }, { token: 'tok' }), 'tok', chave), false);
  assert.equal(s.autorizaInterno(req('192.168.2.82', {}, { token: 'tok' }), 'tok', chave), false);
  assert.equal(s.autorizaInterno(req('127.0.0.1', { 'x-forwarded-for': '200.1.2.3', 'x-deploy-chave': chave }), 'tok', chave), true);
  assert.equal(s.autorizaInterno(req('192.168.2.82', { 'x-deploy-chave': chave }), 'tok', chave), true);
  assert.equal(s.autorizaInterno(req('192.168.2.82', { 'x-deploy-chave': 'a'.repeat(63) }), 'tok', chave), false);
  assert.equal(s.autorizaInterno(req('192.168.2.82', { 'x-deploy-chave': 'tok' }), 'tok', 'tok'), false);   // chave curta nunca vale
  assert.equal(s.autorizaInterno(req('192.168.2.82', { 'x-deploy-chave': '' }), 'tok', null), false);
  assert.equal(s.autorizaInterno(req('192.168.2.82', {}), 'tok', null), false);
});

test('carregarChaveDeploy: cria uma vez e depois devolve a mesma', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seg-'));
  const arq = path.join(dir, 'deploy-chave.txt');
  const a = s.carregarChaveDeploy(arq);
  assert.equal(a.length, 64);
  assert.equal(s.carregarChaveDeploy(arq), a);
  assert.equal(s.carregarChaveDeploy(path.join(dir, 'nao-existe', 'x.txt')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('segredos da sessão: o novo vem do arquivo e assina; o antigo só vale até a data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seg-'));
  const arq = path.join(dir, 'sessao-segredo.txt');
  const limite = '2026-11-21T03:00:00-03:00';
  const antes = s.segredosSessao({ arquivo: arq, antigo: 'velho', antigoValeAte: limite, agora: Date.parse('2026-11-19T10:00:00-03:00') });
  assert.equal(antes.length, 2);
  assert.equal(antes[0].length, 64);
  assert.equal(antes[1], 'velho');
  const depois = s.segredosSessao({ arquivo: arq, antigo: 'velho', antigoValeAte: limite, agora: Date.parse('2026-11-21T03:00:01-03:00') });
  assert.deepEqual(depois, [antes[0]]);                       // mesmo segredo do arquivo, sem o antigo
  assert.equal(s.segredosSessao({ arquivo: arq, antigoValeAte: limite, agora: 0 }).length, 1);   // sem antigo
  assert.equal(s.segredosSessao({ arquivo: arq, antigo: 'velho', antigoValeAte: 'data ruim', agora: 0 }).length, 1);
  const semDisco = s.segredosSessao({ arquivo: path.join(dir, 'nao-existe', 'x.txt'), antigo: 'velho', antigoValeAte: limite, agora: 0 });
  assert.equal(semDisco[0].length, 64);                       // disco falhou: segredo em memória, nunca vazio
  assert.notEqual(semDisco[0], antes[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('limite de login: 8 erros na mesma conta+IP bloqueiam; outra conta e outro IP seguem livres', () => {
  const l = s.criarLimiteLogin();
  const t0 = 1000000;
  for (let i = 0; i < 7; i++) assert.equal(l.falha('Maria ', '1.1.1.1', t0 + i), false);
  assert.equal(l.bloqueado('maria', '1.1.1.1', t0 + 10), 0);
  assert.equal(l.falha('maria', '1.1.1.1', t0 + 20), true);
  assert.ok(l.bloqueado('MARIA', '1.1.1.1', t0 + 30) > 14 * 60 * 1000);
  assert.equal(l.bloqueado('maria', '2.2.2.2', t0 + 30), 0);
  assert.equal(l.bloqueado('jose', '1.1.1.1', t0 + 30), 0);
  assert.equal(l.bloqueado('maria', '1.1.1.1', t0 + 20 + 15 * 60 * 1000), 0);   // passou o tempo
});

test('limite de login: erro antigo sai da janela; login certo zera a conta+IP', () => {
  const l = s.criarLimiteLogin();
  for (let i = 0; i < 7; i++) l.falha('ana', '1.1.1.1', 1000 + i);
  assert.equal(l.falha('ana', '1.1.1.1', 1000 + 16 * 60 * 1000), false);   // os 7 primeiros já venceram
  const m = s.criarLimiteLogin();
  for (let i = 0; i < 7; i++) m.falha('ana', '1.1.1.1', 1000 + i);
  m.sucesso('ana', '1.1.1.1');
  assert.equal(m.falha('ana', '1.1.1.1', 2000), false);
  assert.equal(m.bloqueado('ana', '1.1.1.1', 2001), 0);
});

test('limite de login: conta atacada de vários IPs e IP testando várias contas', () => {
  const l = s.criarLimiteLogin();
  let disparou = false;
  for (let i = 0; i < 25; i++) disparou = l.falha('tiago', '10.0.0.' + i, 5000 + i);
  assert.equal(disparou, true);
  assert.ok(l.bloqueado('tiago', '99.99.99.99', 6000) > 0);   // IP novo também fica de fora
  assert.equal(l.bloqueado('donato', '99.99.99.99', 6000), 0);

  const m = s.criarLimiteLogin();
  for (let i = 0; i < 40; i++) disparou = m.falha('conta' + i, '7.7.7.7', 5000 + i);
  assert.equal(disparou, true);
  assert.ok(m.bloqueado('qualquer', '7.7.7.7', 6000) > 0);
  assert.equal(m.bloqueado('qualquer', '8.8.8.8', 6000), 0);
});

test('limite de login: enxurrada de nomes não cresce sem fim', () => {
  const l = s.criarLimiteLogin({ maxRegistros: 300, maxPorIp: 1000000 });
  for (let i = 0; i < 2000; i++) l.falha('x' + i, 'ip' + i, 1000 + i * 20 * 60 * 1000);
  assert.ok(l._tamanho() < 700);
});
