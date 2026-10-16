'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const LA = require('../lib/log-acessos');

test('registrar grava jsonl por mês; ler filtra por tipo/usuario/ip/pagina; resumo agrupa por usuário', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-'));
  const e = LA.registrar(dir, { tipo: 'login', usuario: 'tiago.freire', nome: 'Tiago Freire', perfil: 'admin', ip: '192.168.2.50', dispositivo: 'Windows · Chrome' }, new Date('2026-10-16T08:00:00'));
  assert.equal(e.em.slice(0, 10), '2026-10-16'); assert.ok(e.id);
  LA.registrar(dir, { tipo: 'pagina', usuario: 'tiago.freire', nome: 'Tiago Freire', perfil: 'admin', ip: '192.168.2.50', pagina: '/log.html' }, new Date('2026-10-16T08:01:00'));
  LA.registrar(dir, { tipo: 'login_falha', usuario: 'ana', ip: '10.0.0.7', msg: 'senha errada' }, new Date('2026-10-16T08:02:00'));
  LA.registrar(dir, { tipo: 'logout', usuario: 'tiago.freire', nome: 'Tiago Freire', ip: '192.168.2.50' }, new Date('2026-10-16T09:00:00'));
  assert.ok(fs.existsSync(path.join(dir, '2026-10.jsonl')));
  const tudo = LA.ler(dir, { de: '2026-10-16', ate: '2026-10-16' });
  assert.equal(tudo.length, 4);
  assert.equal(tudo[0].tipo, 'logout', 'mais novo primeiro');
  assert.equal(LA.ler(dir, { de: '2026-10-16', ate: '2026-10-16', tipo: 'login_falha' })[0].usuario, 'ana');
  assert.equal(LA.ler(dir, { de: '2026-10-16', ate: '2026-10-16', usuario: 'TIAGO' }).length, 3);
  assert.equal(LA.ler(dir, { de: '2026-10-16', ate: '2026-10-16', ip: '10.0.0' }).length, 1);
  assert.equal(LA.ler(dir, { de: '2026-10-16', ate: '2026-10-16', pagina: 'log.html' }).length, 1);
  assert.throws(() => LA.registrar(dir, { tipo: 'xyz', usuario: 'a' }), /tipo/);
  assert.throws(() => LA.registrar(dir, { tipo: 'login' }), /usuario/);

  const r = LA.resumo(tudo);
  assert.equal(r.length, 2);
  const t = r.find(x => x.usuario === 'tiago.freire');
  assert.deepEqual([t.logins, t.falhas, t.paginas], [1, 0, 1]);
  assert.equal(t.primeiro.slice(11, 16), '08:00'); assert.equal(t.ultimo.slice(11, 16), '09:00');
  assert.deepEqual(t.ips, ['192.168.2.50']);
  assert.equal(r.find(x => x.usuario === 'ana').falhas, 1);
  assert.match(LA.csv(tudo), /em;tipo;usuario;nome;perfil;ip;dispositivo;pagina;msg/);
});

test('meses: valida o formato das datas e recusa período invertido', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-'));
  assert.throws(() => LA.ler(dir, { de: '2026-9-1', ate: '2026-09-30' }), /data inválida/);
  assert.throws(() => LA.ler(dir, { de: '2026-09-30', ate: '2026-09-01' }), /invertido/);
  assert.deepEqual(LA.ler(dir, { de: '1900-01-01', ate: '2026-09-30' }), []);
});

test('online: só quem teve atividade na janela; logout tira da lista', () => {
  LA._atividade.clear();
  const t0 = new Date('2026-10-16T10:00:00');
  LA.marcarAtividade({ usuario: 'a', nome: 'Ana', perfil: 'gerente' }, { ip: '1.1.1.1', pagina: '/index.html', desde: '2026-10-16T09:50:00' }, t0);
  LA.marcarAtividade({ usuario: 'b', nome: 'Bia' }, { ip: '2.2.2.2' }, new Date('2026-10-16T09:30:00'));
  const on = LA.online(15, new Date('2026-10-16T10:05:00'));
  assert.deepEqual(on.map(x => x.usuario), ['a']);
  assert.equal(on[0].desde, '2026-10-16T09:50:00');
  assert.equal(on[0].pagina, '/index.html');
  // nova chamada só de API mantém a página anterior e avança a última atividade
  LA.marcarAtividade({ usuario: 'a', nome: 'Ana' }, { ip: '1.1.1.1' }, new Date('2026-10-16T10:10:00'));
  assert.equal(LA.online(15, new Date('2026-10-16T10:10:00'))[0].pagina, '/index.html');
  LA.removerAtividade('a');
  assert.equal(LA.online(15, new Date('2026-10-16T10:10:00')).length, 0);
});

test('ipDe tira o prefixo IPv6-mapeado e prefere x-forwarded-for; dispositivoDe resume o user-agent; paginaDe só aceita .html', () => {
  assert.equal(LA.ipDe({ headers: {}, socket: { remoteAddress: '::ffff:192.168.2.50' } }), '192.168.2.50');
  assert.equal(LA.ipDe({ headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }), '8.8.8.8');
  assert.equal(LA.dispositivoDe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Windows · Edge');
  assert.equal(LA.dispositivoDe('Mozilla/5.0 (Linux; Android 11; Q8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'), 'Android · Chrome');
  assert.equal(LA.dispositivoDe('Mozilla/5.0 (Linux; Android 11; Q8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36'), 'Android · App');
  assert.equal(LA.dispositivoDe('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  assert.equal(LA.dispositivoDe(''), null);
  assert.equal(LA.paginaDe('/'), '/index.html');
  assert.equal(LA.paginaDe('/Log.html'), '/log.html');
  assert.equal(LA.paginaDe('/api/log-acessos'), null);
  assert.equal(LA.paginaDe('/nav.js'), null);
});
