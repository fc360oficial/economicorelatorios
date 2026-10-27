const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const P = require('../lib/gerencial-push');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ger-push-'));
const enviados = [];
const webpushFalso = {
  generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
  sendNotification: async (sub, corpo, opts) => { enviados.push({ sub, corpo: JSON.parse(corpo), opts }); if (sub.endpoint.includes('sumiu')) { const e = new Error('Gone'); e.statusCode = 410; throw e; } return { statusCode: 201 }; }
};
const ger5 = { usuario: 'gerencia.e5', nome: 'Marcos', perfil: 'gerencial', loja_id: 5 };
const ger2 = { usuario: 'gerencia.e2', nome: 'Ana', perfil: 'gerencial', loja_id: 2 };
const sub = ep => ({ endpoint: 'https://push.exemplo/' + ep, keys: { p256dh: 'p', auth: 'a' } });

test('init: gera e guarda a chave VAPID; estado vazio', () => {
  P.init({ dataDir: dir, webpush: webpushFalso });
  assert.equal(P.chavePublica(), 'PUB');
  assert.ok(fs.existsSync(path.join(dir, 'vapid.json')));
  assert.deepEqual(P.estado().usuarios, 0);
});
test('inscrever: valida a inscrição, não repete endpoint e guarda no máximo 5 aparelhos', () => {
  assert.match(P.inscrever(ger5, { endpoint: 'x' }).erro, /incompleta/);
  assert.deepEqual(P.inscrever(ger5, sub('a'), 'Android'), { ok: true, novo: true, dispositivos: 1 });
  assert.deepEqual(P.inscrever(ger5, sub('a'), 'Android'), { ok: true, novo: false, dispositivos: 1 });
  for (const e of ['b', 'c', 'd', 'e', 'f']) P.inscrever(ger5, sub(e));
  assert.equal(P.dispositivosDe(ger5), 5);
  assert.equal(P.estado().porLoja[5], 1);
  P.init({ dataDir: dir, webpush: webpushFalso });   // relê do disco
  assert.equal(P.dispositivosDe(ger5), 5, 'inscrições persistem');
});
test('notificar: manda pra todos os aparelhos do usuário com a chave VAPID por envio; 410 apaga o aparelho', async () => {
  P.inscrever(ger2, sub('sumiu'));
  P.inscrever(ger2, sub('ok'));
  const r = await P.notificar(ger2, { title: 'T', body: 'B', url: '/x' });
  assert.equal(r.ok, 1); assert.equal(r.falhas, 1); assert.equal(r.removidos, 1);
  assert.equal(P.dispositivosDe(ger2), 1);
  const ultimo = enviados[enviados.length - 1];
  assert.equal(ultimo.opts.vapidDetails.publicKey, 'PUB'); assert.equal(ultimo.corpo.title, 'T'); assert.equal(ultimo.opts.urgency, 'high');
});
test('notificarLoja: só os gerentes inscritos daquela loja', async () => {
  const antes = enviados.length;
  const r = await P.notificarLoja(2, { title: 'Loja 2' });
  assert.equal(r.usuarios, 1); assert.equal(r.ok, 1);
  assert.equal(enviados.length - antes, 1);
  const nada = await P.notificarLoja(3, { title: 'Loja 3' });
  assert.equal(nada.usuarios, 0);
});
test('testar: usuário sem aparelho devolve erro claro; com aparelho manda o aviso de teste', async () => {
  const semApp = await P.testar({ usuario: 'ninguem', nome: 'N' });
  assert.equal(semApp.ok, false); assert.match(semApp.erro, /sem aparelho/);
  const com = await P.testar(ger2);
  assert.equal(com.ok, true); assert.equal(com.enviados, 1);
  assert.match(enviados[enviados.length - 1].corpo.title, /ativadas/);
});
test('desinscrever remove só o endpoint pedido', () => {
  assert.deepEqual(P.desinscrever(ger2, 'https://push.exemplo/ok'), { ok: true, removidos: 1 });
  assert.equal(P.dispositivosDe(ger2), 0);
});
