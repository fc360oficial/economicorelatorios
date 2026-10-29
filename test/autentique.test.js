// test/autentique.test.js — integração Autentique (fase de diagnóstico): config mascarada, teste de autenticação com servidor GraphQL falso
// (chave válida, inválida, 429), validação HMAC do webhook e registro de eventos. Nenhuma chamada sai para a internet.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const AUT = require('../lib/autentique');
const ARQ = path.join(__dirname, '..', 'data', 'autentique.json');
const backup = fs.existsSync(ARQ) ? fs.readFileSync(ARQ) : null;
test.after(() => { if (backup) fs.writeFileSync(ARQ, backup); else { try { fs.unlinkSync(ARQ); } catch (e) {} } });

let modo = 'ok'; const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const auth = req.headers.authorization || '';
    if (modo === '429') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'Too Many Attempts.' })); }
    if (auth !== 'Bearer CHAVE-BOA-1234567890') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ errors: [{ message: 'You are not authenticated anymore.' }], data: null })); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: { me: { id: 'abc', name: 'Econômico RH', email: 'rh@exemplo.com', cnpj: null, subscription: { has_premium_features: true, documents: 10, credits: 90 }, organization: { id: 1, uuid: 'u', name: 'Econômico Supermercados', cnpj: '00.000.000/0001-00' } } } }));
  });
});
let url; test.before(async () => { await new Promise(r => srv.listen(0, '127.0.0.1', r)); url = 'http://127.0.0.1:' + srv.address().port + '/v2/graphql'; }); test.after(() => srv.close());

test('config: chave e segredo nunca saem inteiros; sandbox padrão ligado', () => {
  const c = AUT.setConfig({ url, token: 'CHAVE-BOA-1234567890', webhookSecret: 'segredo-webhook-xyz' }, 'tiago');
  assert.equal(c.tem_token, true); assert.equal(c.token_mascarado, 'CHAV…7890'); assert.ok(!JSON.stringify(c).includes('CHAVE-BOA-1234567890')); assert.ok(!JSON.stringify(c).includes('segredo-webhook-xyz')); assert.equal(c.sandbox, true); assert.equal(c.atualizadoPor, 'tiago');
});
test('testar: chave válida devolve a conta; inválida = não autenticado; 429 = limite', async () => {
  let t = await AUT.testar('tiago'); assert.equal(t.ok, true); assert.equal(t.conta.organizacao.nome, 'Econômico Supermercados'); assert.equal(t.conta.plano.creditos, 90); assert.equal(AUT.getConfig().ultimo_teste.ok, true); assert.equal(AUT.getConfig().conta.nome, 'Econômico RH');
  AUT.setConfig({ token: 'CHAVE-ERRADA-0000000' }); t = await AUT.testar('tiago'); assert.equal(t.ok, false); assert.equal(t.status, 401); assert.match(t.erro, /recusou a chave/);
  modo = '429'; t = await AUT.testar('tiago'); assert.equal(t.ok, false); assert.equal(t.status, 429); modo = 'ok';
  AUT.setConfig({ token: 'CHAVE-BOA-1234567890' });
});
test('sem chave: testar explica; criar documento recusa antes de qualquer chamada', async () => {
  const bk = fs.readFileSync(ARQ); fs.writeFileSync(ARQ, '{}'); const t = await AUT.testar(); assert.equal(t.ok, false); assert.match(t.erro, /não configurada/);
  await assert.rejects(AUT.criarDocumento({ nome: 'x', pdfBuffer: Buffer.from('%PDF-1.4 x'), signatario: { email: 'a@b.co' } }), /não configurada/); fs.writeFileSync(ARQ, bk);
  await assert.rejects(AUT.criarDocumento({ nome: 'x', pdfBuffer: Buffer.from('%PDF-1.4 x'), signatario: { email: 'sem-email' } }), /e-mail válido/);
  await assert.rejects(AUT.criarDocumento({ nome: 'x', pdfBuffer: Buffer.from('nao pdf'), signatario: { email: 'a@b.co' } }), /não é um PDF/);
});
test('webhook: HMAC do corpo bruto; evento guardado com documento, tipo e sandbox; sem segredo = recusa', () => {
  const corpo = JSON.stringify({ id: 'wh1', object: 'webhook', event: { id: 'ev1', object: 'event', type: 'document.finished', created_at: '2026-10-29T10:00:00Z', data: { object: { id: 'doc-123', name: 'Espelho', sandbox: true, signed_count: 1, signatures_count: 1, files: { original: 'https://x/o.pdf', signed: 'https://x/s.pdf' } } } } });
  const ass = crypto.createHmac('sha256', 'segredo-webhook-xyz').update(corpo).digest('hex');
  assert.equal(AUT.validarAssinatura(Buffer.from(corpo), ass).ok, true); assert.equal(AUT.validarAssinatura(Buffer.from(corpo), 'sha256=' + ass).ok, true);
  assert.equal(AUT.validarAssinatura(Buffer.from(corpo), ass.replace(/./, 'f')).ok, false); assert.equal(AUT.validarAssinatura(Buffer.from(corpo + ' '), ass).ok, false); assert.equal(AUT.validarAssinatura(Buffer.from(corpo), '').ok, false);
  const l = AUT.registrarEvento(JSON.parse(corpo), { assinaturaOk: true }); assert.equal(l.tipo, 'document.finished'); assert.equal(l.documentoId, 'doc-123'); assert.equal(l.sandbox, true); assert.equal(l.temAssinado, true); assert.equal(AUT.eventos(5)[0].eventoId, 'ev1');
  AUT.setConfig({ limparSegredo: true }); assert.match(AUT.validarAssinatura(Buffer.from(corpo), ass).motivo, /não configurado/);
});
