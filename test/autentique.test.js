// test/autentique.test.js — integração Autentique: config mascarada, autenticação (servidor GraphQL falso), HMAC do corpo bruto,
// deduplicação por event.id, homologação completa (criar documento sandbox → webhook → consulta → PDF assinado recuperado) e travas
// (um teste por vez, sandbox forçado, PDF fictício). Nenhuma chamada sai para a internet; dados em pasta temporária.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
process.env.CGD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cgd-aut-teste-'));
process.env.AUTENTIQUE_PERMITE_HTTP_LOCAL = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const AUT = require('../lib/autentique');
const ARQ = path.join(__dirname, '..', 'data', 'autentique.json');
const backup = fs.existsSync(ARQ) ? fs.readFileSync(ARQ) : null;
test.after(() => { if (backup) fs.writeFileSync(ARQ, backup); else { try { fs.unlinkSync(ARQ); } catch (e) {} } });

// servidor que imita a Autentique: me, createDocument (multipart), document(id), PDF assinado
let modo = 'ok', ultimoCreate = null; const docs = new Map(); let base;
const PDF_ASSINADO = Buffer.from('%PDF-1.4\n% assinado pela autentique (falso)\n' + 'x'.repeat(200) + '\n%%EOF');
const srv = http.createServer((req, res) => {
  const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => {
    const b = Buffer.concat(ch); const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/signed.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(PDF_ASSINADO); }
    if (modo === '429') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'Too Many Attempts.' })); }
    if ((req.headers.authorization || '') !== 'Bearer CHAVE-BOA-1234567890') return json({ errors: [{ message: 'You are not authenticated anymore.' }], data: null });
    if (/multipart\/form-data/.test(req.headers['content-type'] || '')) {
      const txt = b.toString('latin1'); const ops = JSON.parse(b.toString('utf8').match(/name="operations"\r\n\r\n([\s\S]*?)\r\n--/)[1]); ultimoCreate = { ops, temPdf: txt.includes('%PDF-') };
      const id = 'doc-' + crypto.randomBytes(6).toString('hex'); docs.set(id, { assinado: false, visto: false });
      return json({ data: { createDocument: { id, name: ops.variables.document.name, created_at: '2026-10-30', signatures: [{ public_id: 'pub-1', name: 'Funcionário Fictício de Teste', email: null, action: { name: 'SIGN' }, link: { short_link: 'https://assina.ae/teste' } }] } } });
    }
    const q = JSON.parse(b.toString()).query;
    if (/\bme\b/.test(q)) return json({ data: { me: { id: 'abc', name: 'Econômico RH', email: 'rh@exemplo.com', cnpj: null, subscription: { has_premium_features: false, documents: 10, credits: 5 }, organization: { id: 1, uuid: 'u', name: 'Econômico Supermercados', cnpj: '00.000.000/0001-00' } } } });
    const m = q.match(/document\(id: "([^"]+)"\)/); if (m) { const d = docs.get(m[1]); if (!d) return json({ data: { document: null } }); return json({ data: { document: { id: m[1], name: 'teste', created_at: '2026-10-30', files: { original: base + '/o.pdf', signed: d.assinado ? base + '/signed.pdf' : null, pades: null }, signatures: [{ public_id: 'pub-1', name: 'x', email: null, action: { name: 'SIGN' }, link: null, viewed: d.visto ? { created_at: 'x' } : null, signed: d.assinado ? { created_at: 'x' } : null, rejected: null }] } } }); }
    json({ data: null });
  });
});
test.before(async () => { await new Promise(r => srv.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + srv.address().port; }); test.after(() => srv.close());
const assinar = corpo => crypto.createHmac('sha256', 'segredo-webhook-xyz').update(corpo).digest('hex');
const evento = (id, tipo, docId) => JSON.stringify({ id: 'wh1', object: 'webhook', event: { id, object: 'event', type: tipo, created_at: '2026-10-30T10:00:00Z', data: { object: tipo.startsWith('document.') ? { id: docId, sandbox: true, files: { signed: 'x' } } : { public_id: 'pub-1', document: { id: docId, sandbox: true } } } } });
// imita a rota do server.js: valida, registra, processa se não duplicado
async function receber(corpo, assinatura) { const v = AUT.validarAssinatura(Buffer.from(corpo), assinatura); const l = AUT.registrarEvento(JSON.parse(corpo), { assinaturaOk: v.ok, motivo: v.motivo }); if (v.ok && !l.duplicado) await AUT.processarEvento(l); return { v, l }; }

test('1 · config: chave e segredo nunca saem inteiros; sandbox padrão ligado', () => {
  const c = AUT.setConfig({ url: base + '/v2/graphql', token: 'CHAVE-BOA-1234567890', webhookSecret: 'segredo-webhook-xyz' }, 'tiago');
  assert.equal(c.token_mascarado, 'CHAV…7890'); assert.ok(!JSON.stringify(c).includes('CHAVE-BOA-1234567890')); assert.ok(!JSON.stringify(c).includes('segredo-webhook-xyz')); assert.equal(c.sandbox, true);
});
test('2 · autenticação: válida devolve a conta; inválida = 401; 429 = limite', async () => {
  let t = await AUT.testar('tiago'); assert.equal(t.ok, true); assert.equal(t.conta.organizacao.nome, 'Econômico Supermercados');
  AUT.setConfig({ token: 'CHAVE-ERRADA-0000000' }); t = await AUT.testar(); assert.equal(t.ok, false); assert.equal(t.status, 401);
  modo = '429'; t = await AUT.testar(); assert.equal(t.status, 429); modo = 'ok'; AUT.setConfig({ token: 'CHAVE-BOA-1234567890' });
});
test('3 · HMAC: hex do corpo BRUTO; um byte diferente, assinatura errada, vazia ou não-hex = recusa', () => {
  const corpo = evento('ev-a', 'document.updated', 'doc-x'); const ass = assinar(corpo);
  assert.equal(AUT.validarAssinatura(Buffer.from(corpo), ass).ok, true); assert.equal(AUT.validarAssinatura(Buffer.from(corpo), ass.toUpperCase()).ok, true); assert.equal(AUT.validarAssinatura(Buffer.from(corpo), 'sha256=' + ass).ok, true);
  assert.equal(AUT.validarAssinatura(Buffer.from(corpo + ' '), ass).ok, false); assert.equal(AUT.validarAssinatura(Buffer.from(JSON.stringify(JSON.parse(corpo), null, 2)), ass).ok, false);   // re-serializar quebra: tem que ser o corpo original
  assert.equal(AUT.validarAssinatura(Buffer.from(corpo), ass.replace(/^./, c => c === 'f' ? 'e' : 'f')).ok, false); assert.equal(AUT.validarAssinatura(Buffer.from(corpo), '').ok, false); assert.equal(AUT.validarAssinatura(Buffer.from(corpo), 'z'.repeat(64)).ok, false);
});
test('4 · deduplicação: mesmo event.id reenviado não é processado de novo, inclusive depois de reiniciar', () => {
  const corpo = evento('ev-dup', 'signature.viewed', 'doc-y'); const ass = assinar(corpo);
  const a = AUT.registrarEvento(JSON.parse(corpo), { assinaturaOk: true }); const b = AUT.registrarEvento(JSON.parse(corpo), { assinaturaOk: true });
  assert.equal(a.duplicado, false); assert.equal(b.duplicado, true);
  AUT._resetCache(); const c = AUT.registrarEvento(JSON.parse(corpo), { assinaturaOk: true }); assert.equal(c.duplicado, true);   // relido do arquivo
  const ruim = AUT.registrarEvento(JSON.parse(evento('ev-ruim', 'signature.viewed', 'doc-y')), { assinaturaOk: false }); assert.equal(ruim.duplicado, false);
  const ok2 = AUT.registrarEvento(JSON.parse(evento('ev-ruim', 'signature.viewed', 'doc-y')), { assinaturaOk: true }); assert.equal(ok2.duplicado, false);   // evento recusado não "queima" o id
});
test('5 · homologação completa: documento sandbox com PDF fictício → webhooks → consulta → PDF assinado recuperado; um teste por vez', async () => {
  const t = await AUT.criarTesteHomologacao({ por: 'tiago' });
  assert.equal(t.sandbox, true); assert.equal(t.modo, 'link'); assert.equal(t.link, 'https://assina.ae/teste'); assert.equal(t.status, 'aguardando_assinatura');
  const v = ultimoCreate.ops.variables; assert.equal(v.sandbox, true); assert.equal(v.signers.length, 1); assert.equal(v.signers[0].name, 'Funcionário Fictício de Teste'); assert.equal(v.signers[0].email, undefined); assert.ok(ultimoCreate.temPdf); assert.match(v.document.name, /TESTE DE HOMOLOGAÇÃO/);
  await assert.rejects(AUT.criarTesteHomologacao({ por: 'tiago' }), /em andamento/);   // sem lote
  const txt = (await AUT.pdfFicticio()).toString('latin1'); assert.ok(!/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(txt.replace('000.000.000-00', '')));   // nenhum CPF real no PDF de teste
  // assinatura visualizada
  docs.get(t.documentoId).visto = true; await receber(evento('ev-1', 'signature.viewed', t.documentoId), assinar(evento('ev-1', 'signature.viewed', t.documentoId)));
  assert.equal(AUT.testes().find(x => x.documentoId === t.documentoId).status, 'visualizado');
  // assinado + document.finished → baixa o PDF assinado
  docs.get(t.documentoId).assinado = true; const fin = evento('ev-2', 'document.finished', t.documentoId); await receber(fin, assinar(fin));
  let x = AUT.testes().find(y => y.documentoId === t.documentoId); assert.equal(x.status, 'concluido'); assert.equal(x.pdfAssinado.tamanho, PDF_ASSINADO.length); assert.equal(x.eventos.length, 2);
  assert.equal(fs.readFileSync(AUT.arquivoTeste(t.documentoId)).slice(0, 5).toString(), '%PDF-');
  // reenvio do mesmo document.finished: não reprocessa
  const r = await receber(fin, assinar(fin)); assert.equal(r.l.duplicado, true); x = AUT.testes().find(y => y.documentoId === t.documentoId); assert.equal(x.eventos.length, 2);
  // webhook com assinatura errada não mexe no teste
  await receber(evento('ev-3', 'signature.rejected', t.documentoId), 'f'.repeat(64)); assert.equal(AUT.testes().find(y => y.documentoId === t.documentoId).status, 'concluido');
  // concluído → um novo teste pode ser criado (por e-mail de teste)
  const t2 = await AUT.criarTesteHomologacao({ email: 'rh.teste@exemplo.com', por: 'tiago' }); assert.equal(t2.modo, 'email'); assert.equal(ultimoCreate.ops.variables.signers[0].email, 'rh.teste@exemplo.com'); assert.equal(ultimoCreate.ops.variables.sandbox, true);
  // verificação manual (reserva se o webhook não chegar)
  docs.get(t2.documentoId).assinado = true; const v2 = await AUT.verificarTeste(t2.documentoId); assert.equal(v2.status, 'concluido');
});
test('6 · travas: sem segredo não cria teste; e-mail inválido; PDF > 5 MB; download só HTTPS fora do teste', async () => {
  await assert.rejects(AUT.criarTesteHomologacao({ email: 'nao-e-email' }), /inválido/);
  AUT.setConfig({ limparSegredo: true }); await assert.rejects(AUT.criarTesteHomologacao({}), /segredo do webhook/); AUT.setConfig({ webhookSecret: 'segredo-webhook-xyz' });
  await assert.rejects(AUT.criarDocumento({ nome: 'x', pdfBuffer: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5 * 1024 * 1024)]), signatario: { nome: 'x' } }), /5 MB/);
  process.env.AUTENTIQUE_PERMITE_HTTP_LOCAL = '0'; await assert.rejects(AUT.baixar(base + '/signed.pdf'), /não é HTTPS/); process.env.AUTENTIQUE_PERMITE_HTTP_LOCAL = '1';
});
