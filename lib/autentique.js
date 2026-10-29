'use strict';
// lib/autentique.js — integração com a Autentique (assinatura eletrônica) para a Gestão Documental. 29/10/2026 — FASE DE DIAGNÓSTICO:
// configuração da chave, teste de autenticação (query `me`), receptor de webhooks com validação HMAC e as chamadas preparadas
// (criar documento em sandbox, consultar documento, baixar PDF assinado). Nenhum documento real é enviado nesta fase: criar só
// com sandbox=true e só quando a próxima fase ligar o fluxo. Docs: https://docs.autentique.com.br/api (GraphQL, Bearer, 60 req/min).
// Chave e segredo do webhook ficam em data/autentique.json (gitignored); nunca saem inteiros pra tela (só mascarados) nem pro log.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ARQ = path.join(__dirname, '..', 'data', 'autentique.json');
const EVENTOS = path.join(__dirname, '..', 'data', 'gestao-documental', 'autentique', 'eventos.jsonl');
const URL_PADRAO = 'https://api.autentique.com.br/v2/graphql';
const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { return {}; } };
const mascara = t => t ? (t.length > 12 ? t.slice(0, 4) + '…' + t.slice(-4) : '••••') : '';
const erro = (msg, status, extra) => Object.assign(new Error(msg), { status: status || 400 }, extra || {});

function getConfig() {
  const c = ler();
  return { url: c.url || URL_PADRAO, tem_token: !!c.token, token_mascarado: mascara(c.token || ''), tem_segredo: !!c.webhookSecret, segredo_mascarado: mascara(c.webhookSecret || ''), sandbox: c.sandbox !== false,
    atualizadoEm: c.atualizadoEm || null, atualizadoPor: c.atualizadoPor || null, ultimo_teste: c.ultimo_teste || null, conta: c.conta || null };
}
function setConfig(campos, usuario) {
  const c = ler();
  if (typeof campos.url === 'string') c.url = campos.url.trim().replace(/\/+$/, '') || URL_PADRAO;
  if (typeof campos.token === 'string' && campos.token.trim()) c.token = campos.token.trim();
  if (typeof campos.webhookSecret === 'string' && campos.webhookSecret.trim()) c.webhookSecret = campos.webhookSecret.trim();
  if (campos.limparSegredo) delete c.webhookSecret;
  if (campos.sandbox != null) c.sandbox = !!campos.sandbox;
  c.atualizadoEm = new Date().toISOString(); c.atualizadoPor = usuario || null;
  fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(c, null, 2));
  return getConfig();
}

// ── GraphQL ──────────────────────────────────────────────────────────────────
async function gql(query, variables, opts = {}) {
  const c = ler(); if (!c.token) throw erro('Chave da API da Autentique não configurada', 409);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 30000); const t0 = Date.now();
  let r, texto;
  try { r = await fetch(c.url || URL_PADRAO, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token }, body: JSON.stringify({ query, variables: variables || {} }), signal: ctrl.signal }); texto = await r.text(); }
  catch (e) { throw erro(e.name === 'AbortError' ? 'Autentique sem resposta em ' + Math.round((opts.timeoutMs || 30000) / 1000) + ' s' : 'Falha de rede ao chamar a Autentique: ' + e.message, 502); }
  finally { clearTimeout(t); }
  let j = null; try { j = JSON.parse(texto); } catch (e) {}
  if (r.status === 429) throw erro('Autentique: limite de 60 requisições por minuto atingido (429)', 429);
  if (r.status === 401 || (j && j.errors && j.errors.some(x => /not authenticated|unauthorized|unauthenticated/i.test(x.message)))) throw erro('Autentique recusou a chave (não autenticado) — confira a chave da API', 401);
  if (!r.ok) throw erro('Autentique respondeu HTTP ' + r.status + (j && j.message ? ': ' + j.message : ''), 502);
  if (j && j.errors && j.errors.length) throw erro('Autentique: ' + j.errors.map(x => x.message + (x.extensions && x.extensions.validation ? ' ' + JSON.stringify(x.extensions.validation) : '')).join('; '), 502);
  return { data: j ? j.data : null, ms: Date.now() - t0 };
}
// Teste de autenticação: quem é a conta por trás da chave (sem tocar em documento)
async function testar(usuario) {
  const c = ler(); const em = new Date().toISOString();
  const grava = res => { const cc = ler(); cc.ultimo_teste = { em, por: usuario || null, ...res }; if (res.ok) cc.conta = res.conta; fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(cc, null, 2)); return cc.ultimo_teste; };
  if (!c.token) return grava({ ok: false, erro: 'Chave da API não configurada' });
  try {
    const { data, ms } = await gql('query { me { id name email cnpj subscription { has_premium_features documents credits } organization { id uuid name cnpj } } }');
    const me = data && data.me; if (!me) return grava({ ok: false, erro: 'Resposta sem o usuário (me)' });
    return grava({ ok: true, ms, conta: { id: me.id, nome: me.name, email: me.email, organizacao: me.organization ? { id: me.organization.id, nome: me.organization.name, cnpj: me.organization.cnpj } : null, plano: me.subscription ? { premium: !!me.subscription.has_premium_features, documentos: me.subscription.documents, creditos: me.subscription.credits } : null } });
  } catch (e) { return grava({ ok: false, erro: e.message, status: e.status || null }); }
}

// ── Preparado para a próxima fase (não chamado por nenhuma tela ainda) ───────
// Cria o documento com UM signatário (e-mail) e o PDF; `sandbox` forçado pelo config (padrão true) — documento de teste não consome crédito nem envia pra valer.
async function criarDocumento({ nome, mensagem, pdfBuffer, nomeArquivo, signatario, cpf, sandbox }) {
  const c = ler(); if (!c.token) throw erro('Chave da API da Autentique não configurada', 409);
  if (!signatario || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signatario.email || '')) throw erro('Signatário sem e-mail válido');
  if (!pdfBuffer || pdfBuffer.slice(0, 5).toString() !== '%PDF-') throw erro('Arquivo não é um PDF');
  const emSandbox = sandbox != null ? !!sandbox : c.sandbox !== false;
  const query = 'mutation CriarDocumento($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!, $sandbox: Boolean) { createDocument(document: $document, signers: $signers, file: $file, sandbox: $sandbox) { id name created_at signatures { public_id name email action { name } link { short_link } } } }';
  const variables = { document: { name: String(nome || 'Documento').slice(0, 200), message: String(mensagem || '').slice(0, 1000), refusable: true, configs: { notification_finished: true, notification_signed: true } }, signers: [{ email: signatario.email, name: signatario.nome || undefined, action: 'SIGN', configs: cpf ? { cpf: String(cpf).replace(/\D/g, '') } : undefined }], file: null, sandbox: emSandbox };
  const fd = new FormData(); fd.append('operations', JSON.stringify({ query, variables })); fd.append('map', JSON.stringify({ file: ['variables.file'] })); fd.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), String(nomeArquivo || 'documento.pdf'));
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000); let r, j;
  try { r = await fetch(c.url || URL_PADRAO, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token }, body: fd, signal: ctrl.signal }); j = await r.json().catch(() => null); } catch (e) { throw erro('Falha ao enviar o documento à Autentique: ' + e.message, 502); } finally { clearTimeout(t); }
  if (r.status === 429) throw erro('Autentique: limite de requisições (429)', 429); if (r.status === 401) throw erro('Autentique recusou a chave', 401);
  if (!j || j.errors) throw erro('Autentique: ' + (j && j.errors ? j.errors.map(x => x.message).join('; ') : 'HTTP ' + r.status), 502);
  return { ...j.data.createDocument, sandbox: emSandbox };
}
async function documento(id) {
  const { data } = await gql('query($id: UUID!) { document(id: $id) { id name created_at files { original signed pades } signatures { public_id name email action { name } link { short_link } viewed { created_at } signed { created_at } rejected { created_at reason } email_events { sent opened delivered refused reason } } } }', { id });
  return data && data.document;
}
async function baixar(url) {
  if (!/^https:\/\//.test(String(url || ''))) throw erro('URL do arquivo assinado inválida');
  const r = await fetch(url); if (!r.ok) throw erro('Não consegui baixar o arquivo assinado (HTTP ' + r.status + ')', 502);
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.slice(0, 5).toString() !== '%PDF-') throw erro('O arquivo baixado não é um PDF'); return buf;
}

// ── Webhook: valida HMAC-SHA256 do corpo bruto (header X-Autentique-Signature) e guarda o evento; o processamento é da próxima fase ──
function validarAssinatura(rawBody, header) {
  const c = ler(); if (!c.webhookSecret) return { ok: false, motivo: 'segredo do webhook não configurado' };
  const esperado = crypto.createHmac('sha256', c.webhookSecret).update(rawBody).digest('hex'); const recebido = String(header || '').replace(/^sha256=/i, '').trim();
  if (!recebido || recebido.length !== esperado.length) return { ok: false, motivo: 'assinatura ausente ou com tamanho diferente' };
  return { ok: crypto.timingSafeEqual(Buffer.from(esperado, 'hex'), Buffer.from(recebido, 'hex')), motivo: 'assinatura não confere' };
}
function registrarEvento(ev, extra) {
  fs.mkdirSync(path.dirname(EVENTOS), { recursive: true });
  const e = ev && ev.event ? ev.event : {}; const obj = e.data && (e.data.object || e.data) || {};
  const linha = { recebidoEm: new Date().toISOString(), ...(extra || {}), webhookId: ev && ev.id || null, eventoId: e.id || null, tipo: e.type || null, criadoEm: e.created_at || null, documentoId: obj.document && obj.document.id || obj.id || null, assinaturaPublicId: obj.public_id || null, sandbox: obj.sandbox != null ? !!obj.sandbox : (obj.document && obj.document.sandbox != null ? !!obj.document.sandbox : null), signedCount: obj.signed_count != null ? obj.signed_count : null, signaturesCount: obj.signatures_count != null ? obj.signatures_count : null, temAssinado: !!(obj.files && obj.files.signed) };
  fs.appendFileSync(EVENTOS, JSON.stringify(linha) + '\n'); return linha;
}
function eventos(n) { try { return fs.readFileSync(EVENTOS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-(n || 50)).reverse(); } catch (e) { return []; } }
const EVENTOS_UTEIS = ['document.finished', 'signature.accepted', 'signature.rejected', 'signature.viewed', 'signature.delivery_failed', 'document.deleted'];

module.exports = { getConfig, setConfig, testar, gql, criarDocumento, documento, baixar, validarAssinatura, registrarEvento, eventos, EVENTOS_UTEIS, URL_PADRAO };
