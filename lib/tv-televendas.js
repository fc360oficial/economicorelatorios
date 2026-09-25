'use strict';
// lib/tv-televendas.js — TV do televendas da CAHU Distribuidora (25/09/2026).
// Painel em loop com os produtos da Tabela Retirada (cod_tabela = 1) que têm
// estoque no CD, foto vinda do catálogo do app CAHU Delivery, e uma tela do
// lançamento do app a cada N slides. Config em data/tv-televendas.json, editada
// na aba "TV Televendas" do Centro de Distribuição. Só leitura no ERP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATALOGO_URL = 'https://cahudelivery.duckdns.org/v1/produtos';
const CATALOGO_TENANT = 'cahu';
const MODOS = ['individual', 'grade', 'misto'];
const TEMAS = ['escuro', 'amarelo'];
const POR_PAGINA = 8;

const APP_PADRAO = {
  titulo: 'Vem aí o app CAHU Delivery',
  frase: 'Peça pelo celular a qualquer hora, veja preço e estoque na hora e acompanhe a entrega ou a retirada.',
  chamadas: ['Tabela na palma da mão', 'Pedido em 2 minutos', 'Android e iPhone'],
  qrUrl: '',
};
const PADRAO = { modo: 'individual', tema: 'escuro', segundos: 6, appCada: 5, soComFoto: true, destaques: [], app: APP_PADRAO };

let deps = {}, ARQ = null, config = null;
let cache = null;        // { produtos, geradoEm, ms }
let catalogoCache = null; // último catálogo do app que deu certo

const novoTok = () => crypto.randomBytes(16).toString('hex');

function init(d) {
  deps = d || {};
  const dir = deps.dataDir || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  ARQ = path.join(dir, 'tv-televendas.json');
  cache = null;
  try { config = normalizar(JSON.parse(fs.readFileSync(ARQ, 'utf8')), true); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[TV-TELEVENDAS] tv-televendas.json ilegível:', e.message); config = null; }
  if (!config) { config = normalizar({}, true); config.token = novoTok(); gravar(); }
}
function gravar() { fs.writeFileSync(ARQ, JSON.stringify(config, null, 1)); }
function getConfig() { return JSON.parse(JSON.stringify(config)); }
function tokenValido(t) { return !!t && t === config.token; }
function novoToken() { config.token = novoTok(); config.atualizadoEm = new Date().toISOString(); gravar(); return getConfig(); }

// Normaliza/valida um parcial em cima do atual (ou dos padrões). Lança Error em português.
function normalizar(parcial, lenient) {
  const base = config || { ...PADRAO, app: { ...APP_PADRAO } };
  const p = parcial || {};
  const c = { ...base, app: { ...base.app } };
  const err = msg => { if (lenient) return; throw new Error(msg); };
  if (p.modo !== undefined) { if (!MODOS.includes(p.modo)) err('Modo inválido (individual, grade ou misto)'); else c.modo = p.modo; }
  if (p.tema !== undefined) { if (!TEMAS.includes(p.tema)) err('Cor inválida (escuro ou amarelo)'); else c.tema = p.tema; }
  if (p.segundos !== undefined) { const n = Number(p.segundos); if (!(n >= 3 && n <= 30)) err('Segundos por slide deve ficar entre 3 e 30'); else c.segundos = Math.round(n); }
  if (p.appCada !== undefined) { const n = Number(p.appCada); if (!(n >= 2 && n <= 20)) err('"Tela do app a cada" deve ficar entre 2 e 20'); else c.appCada = Math.round(n); }
  if (p.soComFoto !== undefined) c.soComFoto = !!p.soComFoto;
  if (p.destaques !== undefined) c.destaques = (Array.isArray(p.destaques) ? p.destaques : []).map(x => String(x).trim()).filter(x => /^\d+$/.test(x));
  if (p.app) {
    for (const k of ['titulo', 'frase']) if (typeof p.app[k] === 'string') c.app[k] = p.app[k].trim().slice(0, 120) || APP_PADRAO[k];
    if (Array.isArray(p.app.chamadas)) { const ch = p.app.chamadas.map(x => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 3); if (ch.length) c.app.chamadas = ch; }
    if (typeof p.app.qrUrl === 'string') { const u = p.app.qrUrl.trim(); if (u && !/^https:\/\//i.test(u)) err('O link do QR code precisa começar com https://'); else c.app.qrUrl = u; }
  }
  if (p.token && /^[a-f0-9]{32}$/.test(p.token)) c.token = p.token;
  if (!MODOS.includes(c.modo)) c.modo = PADRAO.modo;
  if (!TEMAS.includes(c.tema)) c.tema = PADRAO.tema;
  return c;
}
function salvarConfig(parcial, usuario) {
  const novo = normalizar(parcial, false);
  novo.token = config.token;
  novo.atualizadoEm = new Date().toISOString();
  novo.atualizadoPor = usuario || null;
  config = novo; gravar(); cache = null;   // destaques/soComFoto mudam o resultado
  return getConfig();
}

// ── Catálogo do app (fotos, categoria, embalagem) ───────────────────────────
// fetchPagina(n) → array de produtos da API pública do CAHU Delivery (20 por página).
async function baixarCatalogo(fetchPagina) {
  const mapa = new Map();
  for (let pag = 1; pag <= 60; pag++) {
    const lista = await fetchPagina(pag);
    if (!Array.isArray(lista) || !lista.length) break;
    for (const p of lista) {
      const item = { nome: p.nome, categoria: p.categoria || null, unidade: p.unidade_venda || null, qtdEmbalagem: Math.max(1, Math.round(Number(p.qtd_por_embalagem) || 1)), imagem: (p.imagens && p.imagens[0] && p.imagens[0].url) || null };
      if (p.ean) mapa.set(String(p.ean), item);
      if (p.sku) mapa.set(String(p.sku), item);
    }
    if (lista.length < 20) break;
  }
  return mapa;
}
async function fetchPaginaApp(pag) {
  const r = await fetch(`${CATALOGO_URL}?limit=20&pagina=${pag}`, { headers: { 'X-Tenant': CATALOGO_TENANT }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('catálogo do app respondeu ' + r.status);
  return (await r.json()).dados || [];
}

// ── Cruzamento ERP × catálogo ───────────────────────────────────────────────
function cruzar(erp, catalogo, cfg) {
  const dest = new Set((cfg.destaques || []).map(String));
  const out = [];
  for (const r of erp) {
    if (!(Number(r.Qtd) > 0)) continue;
    const ean = String(r.codigobarra);
    const c = catalogo.get(ean) || null;
    const imagem = c && c.imagem ? c.imagem : null;
    if (cfg.soComFoto && !imagem) continue;
    const descr = String(r.descricao || '').trim();
    // Unidade e embalagem: manda o cadastro do ERP (itens.Unid / itens.qtdemb). O catálogo do
    // app marca tudo como CX (sync do Dlinks), então só serve de fallback quando o ERP não tem.
    // UN = vende por unidade: sem a linha "sai a R$ X a unidade".
    const unidErp = String(r.Unid || '').trim().toUpperCase();
    const unidade = unidErp || (c && c.unidade ? String(c.unidade).toUpperCase() : (/\bCX\s*\d*$/i.test(descr) ? 'CX' : ''));
    const embErp = Math.round(Number(r.qtdemb) || 0);
    const qtdEmbalagem = unidade === 'UN' ? 1 : (embErp > 1 ? embErp : (c ? c.qtdEmbalagem : 1));
    out.push({
      ean, nome: descr, preco: Number(r.preco) || 0,
      unidade, qtdEmbalagem,
      categoria: c ? c.categoria : null, imagem, destaque: dest.has(ean),
    });
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

const SQL_RETIRADA = `
  SELECT s.codigobarra, s.descricao, s.preco, e.Qtd, i.Unid, i.qtdemb
  FROM central.s_tabela_item s
  JOIN central.itens i ON i.CodigoBarra = s.codigobarra
  JOIN central.estoquen10 e ON e.CodigoBarra = s.codigobarra
  WHERE s.cod_tabela = 1 AND s.status_item = 0 AND i.CodDesativado = 0 AND e.Qtd > 0`;

// Produtos prontos pra TV. Cache de 10 min; se o ERP falhar devolve o último
// resultado; se o catálogo do app falhar usa o último catálogo (ou nenhum).
async function carregarProdutos(forcar) {
  const ttl = deps.cacheMs !== undefined ? deps.cacheMs : 10 * 60 * 1000;
  if (!forcar && cache && Date.now() - cache.ms < ttl) return cache.produtos;
  let erp;
  try { erp = await deps.q(SQL_RETIRADA, []); }
  catch (e) {
    if (cache) { console.error('[TV-TELEVENDAS] ERP falhou, usando cache:', e.message); return cache.produtos; }
    throw e;
  }
  try { catalogoCache = await (deps.fetchCatalogo ? deps.fetchCatalogo() : baixarCatalogo(fetchPaginaApp)); }
  catch (e) { console.error('[TV-TELEVENDAS] catálogo do app falhou' + (catalogoCache ? ', usando o último' : ', TV vai sem fotos') + ':', e.message); }
  const produtos = cruzar(erp, catalogoCache || new Map(), config);
  cache = { produtos, erp, geradoEm: new Date().toISOString(), ms: Date.now(), totalErp: erp.length, comFoto: cruzar(erp, catalogoCache || new Map(), { ...config, soComFoto: true }).length };
  return produtos;
}
function totais() { return cache ? { erp: cache.totalErp, comFoto: cache.comFoto, exibidos: cache.produtos.length, geradoEm: cache.geradoEm } : null; }
async function buscarProdutos(termo) {
  const t = String(termo || '').trim().toLowerCase();
  const todos = cruzar(await erpBruto(), catalogoCache || new Map(), { ...config, soComFoto: false });
  return (t ? todos.filter(p => p.nome.toLowerCase().includes(t) || p.ean.includes(t)) : todos).slice(0, 30);
}
async function erpBruto() { await carregarProdutos(false); return cache && cache.erp ? cache.erp : deps.q(SQL_RETIRADA, []); }

// ── Sequência de slides (também copiada em public/tv-televendas.html) ───────
function montarSequencia(produtos, cfg) {
  const seq = []; let n = 0; const cada = Math.max(2, Number(cfg.appCada) || 5);
  const app = () => seq.push({ t: 'app' });
  const conta = () => { if (++n % cada === 0) app(); };
  if (cfg.modo === 'individual') {
    produtos.forEach(p => { seq.push({ t: 'prod', item: p }); conta(); });
  } else {
    const dest = cfg.modo === 'misto' ? produtos.filter(p => p.destaque) : [];
    const paginas = Math.ceil(produtos.length / POR_PAGINA); let d = 0;
    for (let k = 0; k < paginas; k++) {
      seq.push({ t: 'grade', itens: produtos.slice(k * POR_PAGINA, (k + 1) * POR_PAGINA), pagina: k + 1, paginas }); conta();
      if (dest.length && (k + 1) % 2 === 0) { seq.push({ t: 'destaque', item: dest[d++ % dest.length] }); conta(); }
    }
  }
  if (!seq.length) app();
  return seq;
}

module.exports = { init, getConfig, salvarConfig, novoToken, tokenValido, baixarCatalogo, cruzar, carregarProdutos, buscarProdutos, totais, montarSequencia, MODOS, TEMAS };
