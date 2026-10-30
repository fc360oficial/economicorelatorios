'use strict';
// lib/autentique.js — integração com a Autentique (assinatura eletrônica) para a Gestão Documental. 29/10/2026 — FASE DE DIAGNÓSTICO:
// configuração da chave, teste de autenticação (query `me`), receptor de webhooks com validação HMAC e as chamadas preparadas
// (criar documento em sandbox, consultar documento, baixar PDF assinado). Nenhum documento real é enviado nesta fase: criar só
// com sandbox=true e só quando a próxima fase ligar o fluxo. Docs: https://docs.autentique.com.br/api (GraphQL, Bearer, 60 req/min).
// Chave e segredo do webhook ficam em data/autentique.json (gitignored); nunca saem inteiros pra tela (só mascarados) nem pro log.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ARQ = path.join(__dirname, '..', 'data', 'autentique.json');
const EVENTOS = path.join(process.env.CGD_DIR || path.join(__dirname, '..', 'data', 'gestao-documental'), 'autentique', 'eventos.jsonl');   // mesma raiz da Gestão Documental (CGD_DIR nos testes)
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

// ── Documentos ───────────────────────────────────────────────────────────────
// Cria o documento com UM signatário. Signatário por e-mail (a Autentique envia o link) ou só por nome (a resposta traz o link e
// nenhum e-mail sai — usado na homologação). `sandbox` vem do config (padrão true); a homologação força true.
async function criarDocumento({ nome, mensagem, pdfBuffer, nomeArquivo, signatario, cpf, sandbox }) {
  const c = ler(); if (!c.token) throw erro('Chave da API da Autentique não configurada', 409);
  const email = signatario && signatario.email ? String(signatario.email).trim() : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw erro('Signatário sem e-mail válido');
  if (!email && !(signatario && String(signatario.nome || '').trim())) throw erro('Signatário sem e-mail válido nem nome');
  if (!pdfBuffer || pdfBuffer.slice(0, 5).toString() !== '%PDF-') throw erro('Arquivo não é um PDF');
  if (pdfBuffer.length > 5 * 1024 * 1024) throw erro('PDF maior que 5 MB (limite do plano atual da Autentique)');
  const emSandbox = sandbox != null ? !!sandbox : c.sandbox !== false;
  const query = 'mutation CriarDocumento($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!, $sandbox: Boolean) { createDocument(document: $document, signers: $signers, file: $file, sandbox: $sandbox) { id name created_at signatures { public_id name email action { name } link { short_link } } } }';
  const signer = email ? { email, action: 'SIGN' } : { name: String(signatario.nome).trim().slice(0, 120), action: 'SIGN' };
  if (cpf) signer.configs = { cpf: String(cpf).replace(/\D/g, '') };
  const variables = { document: { name: String(nome || 'Documento').slice(0, 200), message: String(mensagem || '').slice(0, 1000), refusable: true, configs: { notification_finished: true, notification_signed: true } }, signers: [signer], file: null, sandbox: emSandbox };
  const fd = new FormData(); fd.append('operations', JSON.stringify({ query, variables })); fd.append('map', JSON.stringify({ file: ['variables.file'] })); fd.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), String(nomeArquivo || 'documento.pdf'));
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000); let r, j;
  try { r = await fetch(c.url || URL_PADRAO, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token }, body: fd, signal: ctrl.signal }); j = await r.json().catch(() => null); } catch (e) { throw erro('Falha ao enviar o documento à Autentique: ' + e.message, 502); } finally { clearTimeout(t); }
  if (r.status === 429) throw erro('Autentique: limite de requisições (429)', 429); if (r.status === 401) throw erro('Autentique recusou a chave', 401);
  if (!j || j.errors || !j.data || !j.data.createDocument) throw erro('Autentique: ' + (j && j.errors ? j.errors.map(x => x.message + (x.extensions && x.extensions.validation ? ' ' + JSON.stringify(x.extensions.validation) : '')).join('; ') : 'HTTP ' + r.status), 502);
  return { ...j.data.createDocument, sandbox: emSandbox };
}
const idOk = id => { if (!/^[A-Za-z0-9-]{8,80}$/.test(String(id || ''))) throw erro('Id de documento inválido'); return String(id); };
async function documento(id) {
  const { data } = await gql('query { document(id: "' + idOk(id) + '") { id name created_at files { original signed pades } signatures { public_id name email action { name } link { short_link } viewed { created_at } signed { created_at } rejected { created_at reason } } } }');
  return data && data.document;
}
// PDF assinado: a URL vem da própria Autentique; o Bearer só é enviado se o host for da Autentique (nunca pra host estranho)
async function baixar(url) {
  let u; try { u = new URL(String(url || '')); } catch (e) { throw erro('URL do arquivo assinado inválida'); }
  const localTeste = process.env.AUTENTIQUE_PERMITE_HTTP_LOCAL === '1' && u.hostname === '127.0.0.1';   // só nos testes automatizados
  if (u.protocol !== 'https:' && !localTeste) throw erro('URL do arquivo assinado não é HTTPS');
  const daAutentique = /(^|\.)autentique\.com\.br$/i.test(u.hostname);
  let r = await fetch(u.href);
  if ((r.status === 401 || r.status === 403) && daAutentique) { const c = ler(); r = await fetch(u.href, { headers: { Authorization: 'Bearer ' + c.token } }); }
  if (!r.ok) throw erro('Não consegui baixar o arquivo assinado (HTTP ' + r.status + ')', 502);
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.slice(0, 5).toString() !== '%PDF-') throw erro('O arquivo baixado não é um PDF'); return buf;
}

// ── Webhook: HMAC-SHA256 hex do corpo BRUTO (header x-autentique-signature), deduplicação por event.id ──
function validarAssinatura(rawBody, header) {
  const c = ler(); if (!c.webhookSecret) return { ok: false, motivo: 'segredo do webhook não configurado' };
  const esperado = crypto.createHmac('sha256', c.webhookSecret).update(rawBody).digest('hex'); const recebido = String(header || '').replace(/^sha256=/i, '').trim().toLowerCase();
  if (!recebido || recebido.length !== esperado.length || !/^[0-9a-f]+$/.test(recebido)) return { ok: false, motivo: 'assinatura ausente ou com tamanho diferente' };
  const ok = crypto.timingSafeEqual(Buffer.from(esperado, 'hex'), Buffer.from(recebido, 'hex')); return { ok, motivo: ok ? null : 'assinatura não confere' };
}
let vistosMem = null;   // event.id já aceitos (carregado do arquivo de eventos na primeira chamada)
function vistos() { if (!vistosMem) { vistosMem = new Set(); for (const l of eventos(100000)) if (l.assinaturaOk && l.eventoId && !l.duplicado) vistosMem.add(l.eventoId); } return vistosMem; }
function resumoEvento(ev) {
  const e = ev && ev.event ? ev.event : {}; const obj = e.data && (e.data.object || e.data) || {};
  return { webhookId: ev && ev.id || null, eventoId: e.id || null, tipo: e.type || null, criadoEm: e.created_at || null, documentoId: obj.document && obj.document.id || (String(e.type || '').startsWith('document.') ? obj.id : null) || null, assinaturaPublicId: obj.public_id || null,
    sandbox: obj.sandbox != null ? !!obj.sandbox : (obj.document && obj.document.sandbox != null ? !!obj.document.sandbox : null), signedCount: obj.signed_count != null ? obj.signed_count : null, signaturesCount: obj.signatures_count != null ? obj.signatures_count : null, temAssinado: !!(obj.files && obj.files.signed) };
}
// Registra todo POST recebido; `duplicado: true` quando o event.id já foi aceito antes (a Autentique reenvia em 60/120/300 s)
function registrarEvento(ev, extra) {
  fs.mkdirSync(path.dirname(EVENTOS), { recursive: true });
  const r = resumoEvento(ev); const ok = !!(extra && extra.assinaturaOk);
  const duplicado = ok && !!r.eventoId && vistos().has(r.eventoId);
  const linha = { recebidoEm: new Date().toISOString(), ...(extra || {}), ...r, duplicado };
  fs.appendFileSync(EVENTOS, JSON.stringify(linha) + '\n'); if (ok && r.eventoId && !duplicado) vistos().add(r.eventoId); return linha;
}
function eventos(n) { try { return fs.readFileSync(EVENTOS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-(n || 50)).reverse(); } catch (e) { return []; } }
const EVENTOS_UTEIS = ['document.finished', 'signature.accepted', 'signature.rejected', 'signature.viewed', 'signature.delivery_failed', 'document.deleted'];

// ── Homologação: UM documento de teste, funcionário fictício, PDF fictício, sandbox forçado; nada vai pro prontuário ──
const HOMOLOG = () => path.join(path.dirname(EVENTOS), 'homologacao'); const HOMOLOG_IDX = () => path.join(HOMOLOG(), 'testes.json');
const FICTICIO = { nome: 'FUNCIONÁRIO FICTÍCIO DE TESTE', cpf: '000.000.000-00', unidade: 'Unidade de Teste (homologação)', empresa: 'Econômico Supermercados — HOMOLOGAÇÃO' };
const testes = () => { try { return JSON.parse(fs.readFileSync(HOMOLOG_IDX(), 'utf8')); } catch (e) { return []; } };
const gravarTestes = l => { fs.mkdirSync(HOMOLOG(), { recursive: true }); fs.writeFileSync(HOMOLOG_IDX(), JSON.stringify(l, null, 1)); };
function pdfFicticio() {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => { const doc = new PDFDocument({ size: 'A4', margins: { top: 50, left: 50, right: 50, bottom: 50 } }); const ch = []; doc.on('data', x => ch.push(x)); doc.on('end', () => resolve(Buffer.concat(ch))); doc.on('error', reject);
    doc.rect(50, 50, 495, 34).fill('#C22F49'); doc.font('Helvetica-Bold').fontSize(14).fillColor('#FFFFFF').text('DOCUMENTO DE TESTE — SEM VALOR — HOMOLOGAÇÃO', 60, 61, { width: 475, align: 'center' });
    doc.fillColor('#101B33').fontSize(13).text('ESPELHO DE REGISTROS DE PONTO (FICTÍCIO)', 50, 110); doc.font('Helvetica').fontSize(10).fillColor('#0E1626').text('Competência: 00/0000 · gerado ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' }), 50, 130);
    doc.text('Empregador: ' + FICTICIO.empresa, 50, 156); doc.text('Funcionário: ' + FICTICIO.nome + '   ·   CPF: ' + FICTICIO.cpf, 50, 172); doc.text('Unidade: ' + FICTICIO.unidade, 50, 188);
    let y = 216; doc.rect(50, y, 495, 16).fill('#101B33'); doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF'); ['Data', 'Dia', '1ª Entrada', '1ª Saída', '2ª Entrada', '2ª Saída'].forEach((t, i) => doc.text(t, 56 + i * 82, y + 5)); y += 16;
    doc.font('Helvetica').fontSize(8).fillColor('#0E1626'); for (let d = 1; d <= 5; d++) { ['0' + d + '/00', ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'][d - 1], '08:00', '12:00', '13:00', '17:00'].forEach((t, i) => doc.text(t, 56 + i * 82, y + 4)); y += 15; }
    doc.fontSize(9).fillColor('#4E5A72').text('Este arquivo foi gerado automaticamente para validar a integração com a Autentique (criação do documento, assinatura, webhook e recuperação do PDF assinado). Não contém dados de nenhum funcionário real.', 50, y + 20, { width: 495 });
    doc.end(); });
}
async function criarTesteHomologacao({ email, por }) {
  const c = ler(); if (!c.token) throw erro('Chave da API não configurada', 409); if (!c.webhookSecret) throw erro('Configure o segredo do webhook antes do teste', 409);
  const L = testes(); if (L.some(t => !['concluido', 'falhou', 'recusado'].includes(t.status) && Date.now() - new Date(t.criadoEm) < 24 * 3600000)) throw erro('Já existe um teste de homologação em andamento — conclua ou verifique o anterior (sem disparos em lote)', 409);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) throw erro('E-mail de teste inválido');
  const pdf = await pdfFicticio();
  const r = await criarDocumento({ nome: 'TESTE DE HOMOLOGAÇÃO — documento fictício', mensagem: 'Documento de teste da integração Econômico × Autentique. Sem valor. Não contém dados reais.', pdfBuffer: pdf, nomeArquivo: 'teste-homologacao.pdf', signatario: email ? { email: String(email).trim() } : { nome: 'Funcionário Fictício de Teste' }, sandbox: true });
  const sig = (r.signatures || []).find(s => s.action && s.action.name === 'SIGN') || (r.signatures || [])[0] || {};
  const t = { documentoId: r.id, criadoEm: new Date().toISOString(), por: por || null, sandbox: r.sandbox, modo: email ? 'email' : 'link', email: email ? String(email).trim() : null, link: sig.link && sig.link.short_link || null, publicId: sig.public_id || null, status: 'aguardando_assinatura', eventos: [], pdfAssinado: null, verificadoEm: null, erro: null };
  L.push(t); gravarTestes(L); return t;
}
function atualizarTeste(documentoId, fn) { const L = testes(); const t = L.find(x => x.documentoId === documentoId); if (!t) return null; fn(t); gravarTestes(L); return t; }
// Consulta o documento pela API e, se concluído, baixa e guarda o PDF assinado (serve de reserva se o webhook não chegar)
async function verificarTeste(documentoId) {
  idOk(documentoId); if (!testes().some(x => x.documentoId === documentoId)) throw erro('Teste não encontrado', 404);
  const d = await documento(documentoId); if (!d) return atualizarTeste(documentoId, t => { t.verificadoEm = new Date().toISOString(); t.erro = 'Documento não encontrado na Autentique (sandbox expira em alguns dias)'; });
  const s = (d.signatures || []).find(x => x.action && x.action.name === 'SIGN') || {};
  const status = s.rejected ? 'recusado' : d.files && d.files.signed && s.signed ? 'assinado' : s.viewed ? 'visualizado' : 'aguardando_assinatura';
  let pdf = null, err = null;
  if (status === 'assinado') { try { const buf = await baixar(d.files.signed); fs.mkdirSync(HOMOLOG(), { recursive: true }); const f = path.join(HOMOLOG(), documentoId + '-assinado.pdf'); fs.writeFileSync(f, buf); pdf = { arquivo: path.basename(f), tamanho: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), baixadoEm: new Date().toISOString() }; } catch (e) { err = e.message; } }
  return atualizarTeste(documentoId, t => { t.verificadoEm = new Date().toISOString(); t.status = pdf ? 'concluido' : status; if (pdf) t.pdfAssinado = pdf; t.erro = err; });
}
// Processa um evento já validado e não duplicado: só mexe em testes de homologação nesta fase
async function processarEvento(linha) {
  if (!linha || !linha.assinaturaOk || linha.duplicado || !linha.documentoId) return null;
  const t = testes().find(x => x.documentoId === linha.documentoId); if (!t) return null;
  atualizarTeste(linha.documentoId, x => { x.eventos.push({ tipo: linha.tipo, eventoId: linha.eventoId, em: linha.recebidoEm }); if (linha.tipo === 'signature.viewed' && x.status === 'aguardando_assinatura') x.status = 'visualizado'; if (linha.tipo === 'signature.rejected') x.status = 'recusado'; if (linha.tipo === 'signature.accepted' && x.status !== 'concluido') x.status = 'assinado'; });
  if (linha.tipo === 'document.finished' || linha.tipo === 'signature.accepted') return verificarTeste(linha.documentoId);
  return null;
}
function arquivoTeste(documentoId) { idOk(documentoId); const t = testes().find(x => x.documentoId === documentoId); if (!t || !t.pdfAssinado) throw erro('PDF assinado ainda não recuperado', 404); return path.join(HOMOLOG(), t.pdfAssinado.arquivo); }
function _resetCache() { vistosMem = null; }

module.exports = { getConfig, setConfig, testar, gql, criarDocumento, documento, baixar, validarAssinatura, registrarEvento, eventos, processarEvento, EVENTOS_UTEIS, URL_PADRAO,
  testes, criarTesteHomologacao, verificarTeste, arquivoTeste, pdfFicticio, FICTICIO, _resetCache };
