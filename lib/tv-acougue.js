'use strict';
// lib/tv-acougue.js — TV do açougue da loja (Tiago, 22-23/10/2026: "quero só que eu escolha os produtos e ele
// buscar preços e promoções"; aba em Processos › TV Açougue). A lista de cortes é escolhida à mão; preço de
// venda vem de central.itens (P{loja}) e o selo OFERTA é o preço com final 8, a mesma regra da tela Promoções.
// Fotos: banco por código em data/tv-acougue/fotos/<cod>.jpg (sobe uma vez, vale pra todas as lojas); o ERP
// não tem foto. Toda quarta-feira a TV abre com a vinheta "Quarta da Carne" (ligável na configuração).
// Config em data/tv-acougue.json. Só leitura no ERP. Link público por token igual à TV Televendas da CAHU.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOJAS = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão' };
const MODOS = ['vitrine', 'destaque', 'grade'];   // vitrine = foto grande + tabela fixa · destaque = um corte em tela cheia · grade = 3 com foto
const TEMAS = ['escuro', 'vermelho'];
const MAX_PRODUTOS = 80;
const GRUPO_ACOUGUE = 45;   // central.grupo "ACOUGUE" (Bovino, Aves, Suíno, Caprino)
const FOTO_MAX_BYTES = 2.5 * 1024 * 1024;

const PADRAO = { loja: 1, modo: 'vitrine', tema: 'escuro', segundos: 12, titulo: 'Açougue', rodape: '', quartaDaCarne: true, produtos: [], apelidos: {} };

let deps = {}, ARQ = null, DIR_FOTOS = null, config = null;
let cache = null;   // { produtos, faltando, semPreco, loja, geradoEm, ms }

const novoTok = () => crypto.randomBytes(16).toString('hex');
const pp = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
const final8 = p => p > 0 && Math.round(p * 100) % 10 === 8;   // igual a coletarPromocoesFinal8 (server.js)
const codOk = c => /^\d{1,14}$/.test(String(c || ''));

function init(d) {
  deps = d || {};
  const dir = deps.dataDir || path.join(__dirname, '..', 'data');
  DIR_FOTOS = path.join(dir, 'tv-acougue', 'fotos');
  fs.mkdirSync(DIR_FOTOS, { recursive: true });
  ARQ = path.join(dir, 'tv-acougue.json');
  cache = null;
  try { config = normalizar(JSON.parse(fs.readFileSync(ARQ, 'utf8')), true); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[TV-ACOUGUE] tv-acougue.json ilegível:', e.message); config = null; }
  if (!config) { config = normalizar({}, true); config.token = novoTok(); gravar(); }
}
function gravar() { fs.writeFileSync(ARQ, JSON.stringify(config, null, 1)); }
function getConfig() { return JSON.parse(JSON.stringify(config)); }
function tokenValido(t) { return !!t && t === config.token; }
function novoToken() { config.token = novoTok(); config.atualizadoEm = new Date().toISOString(); gravar(); return getConfig(); }
function nomeLoja(n) { return LOJAS[n] || `E${n}`; }
// Quarta-feira no horário local do servidor (o 254 está em America/Recife). `forcar` = botão "ver a vinheta agora".
function hojeQuarta(forcar) { return !!(forcar || (config.quartaDaCarne && new Date().getDay() === 3)); }

// Normaliza/valida um parcial em cima do atual (ou dos padrões). Lança Error em português.
function normalizar(parcial, lenient) {
  const base = config || { ...PADRAO, produtos: [], apelidos: {} };
  const p = parcial || {};
  const c = { ...base, produtos: [...(base.produtos || [])], apelidos: { ...(base.apelidos || {}) } };
  const err = msg => { if (lenient) return; throw new Error(msg); };
  if (p.loja !== undefined) { const n = parseInt(p.loja, 10); if (!LOJAS[n]) err('Loja inválida (E1 a E6)'); else c.loja = n; }
  if (p.modo !== undefined) { if (!MODOS.includes(p.modo)) err('Modo inválido (vitrine, destaque ou grade)'); else c.modo = p.modo; }
  if (p.tema !== undefined) { if (!TEMAS.includes(p.tema)) err('Cor inválida (escuro ou vermelho)'); else c.tema = p.tema; }
  if (p.segundos !== undefined) { const n = Number(p.segundos); if (!(n >= 3 && n <= 30)) err('Segundos por tela deve ficar entre 3 e 30'); else c.segundos = Math.round(n); }
  if (typeof p.titulo === 'string') c.titulo = p.titulo.trim().slice(0, 40) || PADRAO.titulo;
  if (typeof p.rodape === 'string') c.rodape = p.rodape.trim().slice(0, 120);
  if (p.quartaDaCarne !== undefined) c.quartaDaCarne = !!p.quartaDaCarne;
  if (p.produtos !== undefined) {
    if (!Array.isArray(p.produtos)) err('Lista de produtos inválida');
    else {
      const vistos = new Set(); const lista = [];
      for (const x of p.produtos) { const cod = String(x && x.cod !== undefined ? x.cod : x).trim(); if (codOk(cod) && !vistos.has(cod)) { vistos.add(cod); lista.push(cod); } }
      if (lista.length > MAX_PRODUTOS) err(`No máximo ${MAX_PRODUTOS} produtos na TV`); else c.produtos = lista;
    }
  }
  if (p.apelidos !== undefined) {
    if (!p.apelidos || typeof p.apelidos !== 'object' || Array.isArray(p.apelidos)) err('Nomes na TV inválidos');
    else { c.apelidos = {}; for (const [cod, nome] of Object.entries(p.apelidos)) { const n = String(nome || '').trim().slice(0, 40); if (codOk(cod) && n) c.apelidos[cod] = n; } }
  }
  if (p.token && /^[a-f0-9]{32}$/.test(p.token)) c.token = p.token;
  if (!LOJAS[c.loja]) c.loja = PADRAO.loja;
  if (!MODOS.includes(c.modo)) c.modo = PADRAO.modo;
  if (!TEMAS.includes(c.tema)) c.tema = PADRAO.tema;
  if (!(c.segundos >= 3 && c.segundos <= 30)) c.segundos = PADRAO.segundos;
  if (typeof c.titulo !== 'string' || !c.titulo) c.titulo = PADRAO.titulo;
  if (typeof c.rodape !== 'string') c.rodape = PADRAO.rodape;
  if (typeof c.quartaDaCarne !== 'boolean') c.quartaDaCarne = PADRAO.quartaDaCarne;
  if (!c.apelidos || typeof c.apelidos !== 'object') c.apelidos = {};
  return c;
}
function salvarConfig(parcial, usuario) {
  const novo = normalizar(parcial, false);
  novo.token = config.token;
  novo.atualizadoEm = new Date().toISOString();
  novo.atualizadoPor = usuario || null;
  config = novo; gravar(); cache = null;   // loja/lista mudam o resultado
  return getConfig();
}

// ── Fotos (banco por código) ────────────────────────────────────────────────
function caminhoFoto(cod) { return codOk(cod) ? path.join(DIR_FOTOS, `${cod}.jpg`) : null; }
function temFoto(cod) { const f = caminhoFoto(cod); return !!f && fs.existsSync(f); }
function versaoFoto(cod) { try { return Math.round(fs.statSync(caminhoFoto(cod)).mtimeMs); } catch (e) { return 0; } }
// dados = data URL (data:image/jpeg;base64,...) ou base64 puro. A tela de configuração já reduz e converte pra JPEG.
function salvarFoto(cod, dados) {
  if (!codOk(cod)) throw new Error('Código inválido');
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/is.exec(String(dados || '').trim());
  const b64 = m ? m[2] : String(dados || '').trim();
  if (!b64) throw new Error('Foto vazia');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 1000) throw new Error('Foto inválida');
  if (buf.length > FOTO_MAX_BYTES) throw new Error('Foto muito grande (máximo 2,5 MB)');
  const jpeg = buf[0] === 0xFF && buf[1] === 0xD8;
  if (!jpeg) throw new Error('A foto precisa ser JPEG (a tela converte sozinha ao escolher o arquivo)');
  fs.writeFileSync(caminhoFoto(cod), buf);
  return { cod, bytes: buf.length, versao: versaoFoto(cod) };
}
function removerFoto(cod) { const f = caminhoFoto(cod); if (f && fs.existsSync(f)) fs.unlinkSync(f); return { cod, removida: true }; }

// ── ERP ────────────────────────────────────────────────────────────────────
const SQL_BASE = `SELECT i.CodigoBarra cod, TRIM(i.Descricao) nome, i.Unid unid, i.TipoBalanca balanca, i.CodDesativado desativado,
                         i.P1, i.P2, i.P3, i.P4, i.P5, i.P6, TRIM(gs.Descricao) subgrupo, TRIM(g.Descricao) grupo, g.CodGrupo codGrupo
                  FROM central.itens i
                  LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
                  LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo`;

function montar(r, loja) {
  const preco = +pp(r['P' + loja]).toFixed(2);
  const balanca = String(r.balanca || '').trim().toUpperCase() === 'P';
  return {
    cod: String(r.cod || '').trim(), nome: String(r.nome || '').trim(),
    unidade: balanca ? 'kg' : (String(r.unid || '').trim().toUpperCase() || 'UN'), balanca,
    preco, promo: final8(preco),
    grupo: r.grupo || null, subgrupo: r.subgrupo || null, acougue: Number(r.codGrupo) === GRUPO_ACOUGUE,
    desativado: Number(r.desativado) !== 0,
  };
}
const comFoto = p => ({ ...p, apelido: (config.apelidos || {})[p.cod] || null, foto: temFoto(p.cod), fotoV: versaoFoto(p.cod) });

// Produtos escolhidos, na ordem da lista, com preço da loja configurada. Cache de 5 min; se o ERP falhar devolve
// o último resultado. Item sem preço (ou desativado/inexistente) sai da TV e vai pros avisos da configuração.
async function carregarProdutos(forcar) {
  const ttl = deps.cacheMs !== undefined ? deps.cacheMs : 5 * 60 * 1000;
  if (!forcar && cache && cache.loja === config.loja && Date.now() - cache.ms < ttl) return cache.produtos.map(comFoto);
  const cods = config.produtos || [];
  let rows = [];
  if (cods.length) {
    try { rows = await deps.q(`${SQL_BASE} WHERE i.CodigoBarra IN (${cods.map(() => '?').join(',')})`, cods); }
    catch (e) {
      if (cache) { console.error('[TV-ACOUGUE] ERP falhou, usando cache:', e.message); return cache.produtos.map(comFoto); }
      throw e;
    }
  }
  const porCod = new Map(rows.map(r => [String(r.cod).trim(), montar(r, config.loja)]));
  const produtos = [], faltando = [], semPreco = [];
  for (const cod of cods) {
    const p = porCod.get(cod);
    if (!p || p.desativado) { faltando.push(cod); continue; }
    if (!(p.preco > 0)) { semPreco.push({ cod, nome: p.nome }); continue; }
    produtos.push(p);
  }
  cache = { produtos, faltando, semPreco, loja: config.loja, geradoEm: new Date().toISOString(), ms: Date.now() };
  return produtos.map(comFoto);
}
function totais() {
  if (!cache) return null;
  const ps = cache.produtos;
  return { selecionados: (config.produtos || []).length, exibidos: ps.length, ofertas: ps.filter(p => p.promo).length, semFoto: ps.filter(p => !temFoto(p.cod)).length,
           semPreco: cache.semPreco, faltando: cache.faltando, loja: cache.loja, lojaNome: nomeLoja(cache.loja), geradoEm: cache.geradoEm };
}
// Busca pra tela de configuração: nome (todas as palavras) ou código; itens do grupo Açougue primeiro.
async function buscarProdutos(termo) {
  const t = String(termo || '').trim();
  if (t.length < 2) return [];
  const where = ['i.CodDesativado = 0']; const params = [];
  if (/^\d+$/.test(t)) { where.push('i.CodigoBarra LIKE ?'); params.push(t + '%'); }
  else for (const w of t.split(/\s+/).filter(Boolean).slice(0, 5)) { where.push('i.Descricao LIKE ?'); params.push('%' + w + '%'); }
  const rows = await deps.q(`${SQL_BASE} WHERE ${where.join(' AND ')} ORDER BY (g.CodGrupo = ${GRUPO_ACOUGUE}) DESC, i.Descricao LIMIT 40`, params);
  const na = new Set(config.produtos || []);
  return rows.map(r => comFoto(montar(r, config.loja))).map(p => ({ ...p, naTV: na.has(p.cod) }));
}
// Dados dos itens escolhidos pra tela de configuração (inclui os sem preço/desativados, pra mostrar o aviso).
async function listarEscolhidos() {
  await carregarProdutos(false);
  const cods = config.produtos || [];
  if (!cods.length) return [];
  const rows = await deps.q(`${SQL_BASE} WHERE i.CodigoBarra IN (${cods.map(() => '?').join(',')})`, cods).catch(() => []);
  const porCod = new Map(rows.map(r => [String(r.cod).trim(), montar(r, config.loja)]));
  return cods.map(cod => comFoto(porCod.get(cod) || { cod, nome: null, preco: 0, promo: false, unidade: 'UN', desativado: true, subgrupo: null }));
}
// Resposta da API pública da TV (sem token nem quem alterou).
async function payloadTV(opts) {
  const produtos = await carregarProdutos(false);
  const { token, atualizadoPor, produtos: _p, apelidos: _a, ...cfg } = getConfig();
  return { config: cfg, loja: { n: config.loja, nome: nomeLoja(config.loja) }, hojeQuarta: hojeQuarta(opts && opts.forcarQuarta),
           produtos: produtos.map(p => ({ cod: p.cod, nome: p.apelido || p.nome, nomeErp: p.nome, unidade: p.unidade, balanca: p.balanca, preco: p.preco, promo: p.promo, subgrupo: p.subgrupo, foto: p.foto, fotoV: p.fotoV })),
           geradoEm: (totais() || {}).geradoEm || null };
}

module.exports = { init, getConfig, salvarConfig, novoToken, tokenValido, carregarProdutos, buscarProdutos, listarEscolhidos, payloadTV, totais, hojeQuarta,
                   salvarFoto, removerFoto, temFoto, caminhoFoto, nomeLoja, LOJAS, MODOS, TEMAS, MAX_PRODUTOS, _final8: final8 };
