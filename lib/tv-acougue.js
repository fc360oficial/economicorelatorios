'use strict';
// lib/tv-acougue.js — TV do açougue da loja (Tiago, 22-23/10/2026: "quero só que eu escolha os produtos e ele
// buscar preços e promoções"; aba em Processos › TV Açougue). A lista de cortes é escolhida à mão; preço de
// venda vem de central.itens (P{loja}) e o selo OFERTA é o preço com final 8, a mesma regra da tela Promoções.
// Fotos: banco por código em data/tv-acougue/fotos/<cod>.jpg (sobe uma vez, vale pra todas as lojas); o ERP
// não tem foto. Toda quarta-feira a TV abre com a vinheta "Quarta da Carne" (ligável na configuração).
// 24/10/2026 (briefing "modernização do telão"): três modelos no mesmo loop — tabela (vitrine), oferta do dia
// em tela cheia (frase por corte) e publicidade de marcas parceiras (logo, foto, validade, frequência; preço do
// ERP por cima), tempo por modelo e trava contra preço velho (cache do ERP parado > 30 min = TV esconde preços).
// Config em data/tv-acougue.json. Só leitura no ERP. Link público por token igual à TV Televendas da CAHU.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOJAS = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão' };
const MODOS = ['vitrine', 'destaque', 'grade'];   // vitrine = foto grande + tabela fixa · destaque = um corte em tela cheia · grade = 3 com foto
const TEMAS = ['escuro', 'vermelho'];
const MAX_PRODUTOS = 80, MAX_PATROCINIOS = 20;
const GRUPO_ACOUGUE = 45;   // central.grupo "ACOUGUE" (Bovino, Aves, Suíno, Caprino)
const FOTO_MAX_BYTES = 2.5 * 1024 * 1024;
const DESATUALIZADO_MS = 30 * 60 * 1000;   // cache do ERP mais velho que isso (ERP fora) = preço pode estar velho → TV não mostra

const PADRAO = { loja: 1, modo: 'vitrine', tema: 'escuro', segundos: 12, segundosOferta: 12, segundosPatrocinio: 12, ofertaCada: 4, patrocinioCada: 4,
                 titulo: 'Açougue', rodape: '', quartaDaCarne: true, selos: ['Carne de qualidade', 'Frescor garantido', 'Mais sabor para sua família'],
                 produtos: [], apelidos: {}, frases: {}, patrocinios: [] };

let deps = {}, ARQ = null, DIR_FOTOS = null, DIR_PAT = null, config = null;
let cache = null;   // { porCod, produtos, faltando, semPreco, loja, geradoEm, ms }

const novoTok = () => crypto.randomBytes(16).toString('hex');
const novoId = () => crypto.randomBytes(4).toString('hex');
const pp = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
const final8 = p => p > 0 && Math.round(p * 100) % 10 === 8;   // igual a coletarPromocoesFinal8 (server.js)
const codOk = c => /^\d{1,14}$/.test(String(c || ''));
const idOk = i => /^[a-f0-9]{8}$/.test(String(i || ''));
const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
function hojeStr() { const h = new Date(); return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`; }   // data local, não UTC

function init(d) {
  deps = d || {};
  const dir = deps.dataDir || path.join(__dirname, '..', 'data');
  DIR_FOTOS = path.join(dir, 'tv-acougue', 'fotos');
  DIR_PAT = path.join(dir, 'tv-acougue', 'patrocinios');
  fs.mkdirSync(DIR_FOTOS, { recursive: true }); fs.mkdirSync(DIR_PAT, { recursive: true });
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

const segOk = (n, padrao) => { const v = Number(n); return v >= 3 && v <= 30 ? Math.round(v) : padrao; };
function normalizarPatrocinio(p, lenient, err) {
  const o = {};
  o.id = idOk(p.id) ? p.id : novoId();
  o.marca = String(p.marca || '').trim().slice(0, 40);
  o.titulo = String(p.titulo || '').trim().slice(0, 50);
  o.frase = String(p.frase || '').trim().slice(0, 120);
  o.cod = codOk(p.cod) ? String(p.cod).trim() : '';
  o.inicio = dataOk(p.inicio) ? p.inicio : '';
  o.fim = dataOk(p.fim) ? p.fim : '';
  if (o.inicio && o.fim && o.fim < o.inicio) err(`Marca "${o.marca || o.id}": a data final é antes da inicial`);
  o.ativo = p.ativo === undefined ? true : !!p.ativo;
  if (!o.marca) err('Cada marca parceira precisa de um nome');
  return o;
}
// Normaliza/valida um parcial em cima do atual (ou dos padrões). Lança Error em português.
function normalizar(parcial, lenient) {
  const base = config || { ...PADRAO, produtos: [], apelidos: {}, frases: {}, patrocinios: [] };
  const p = parcial || {};
  const c = { ...base, produtos: [...(base.produtos || [])], apelidos: { ...(base.apelidos || {}) }, frases: { ...(base.frases || {}) }, patrocinios: [...(base.patrocinios || [])] };
  const err = msg => { if (lenient) return; throw new Error(msg); };
  if (p.loja !== undefined) { const n = parseInt(p.loja, 10); if (!LOJAS[n]) err('Loja inválida (E1 a E6)'); else c.loja = n; }
  if (p.modo !== undefined) { if (!MODOS.includes(p.modo)) err('Modo inválido (vitrine, destaque ou grade)'); else c.modo = p.modo; }
  if (p.tema !== undefined) { if (!TEMAS.includes(p.tema)) err('Cor inválida (escuro ou vermelho)'); else c.tema = p.tema; }
  for (const k of ['segundos', 'segundosOferta', 'segundosPatrocinio']) if (p[k] !== undefined) { const n = Number(p[k]); if (!(n >= 3 && n <= 30)) err('Segundos por tela deve ficar entre 3 e 30'); else c[k] = Math.round(n); }
  if (p.ofertaCada !== undefined) { const n = Number(p.ofertaCada); if (!(n >= 0 && n <= 12)) err('"Oferta do dia a cada" deve ficar entre 0 (desligado) e 12'); else c.ofertaCada = Math.round(n); }
  if (p.patrocinioCada !== undefined) { const n = Number(p.patrocinioCada); if (!(n >= 2 && n <= 12)) err('"Marca parceira a cada" deve ficar entre 2 e 12'); else c.patrocinioCada = Math.round(n); }
  if (typeof p.titulo === 'string') c.titulo = p.titulo.trim().slice(0, 40) || PADRAO.titulo;
  if (typeof p.rodape === 'string') c.rodape = p.rodape.trim().slice(0, 120);
  if (p.quartaDaCarne !== undefined) c.quartaDaCarne = !!p.quartaDaCarne;
  if (p.selos !== undefined) { if (!Array.isArray(p.selos)) err('Selos inválidos'); else c.selos = p.selos.map(x => String(x || '').trim().slice(0, 32)).slice(0, 3); }
  if (p.produtos !== undefined) {
    if (!Array.isArray(p.produtos)) err('Lista de produtos inválida');
    else {
      const vistos = new Set(); const lista = [];
      for (const x of p.produtos) { const cod = String(x && x.cod !== undefined ? x.cod : x).trim(); if (codOk(cod) && !vistos.has(cod)) { vistos.add(cod); lista.push(cod); } }
      if (lista.length > MAX_PRODUTOS) err(`No máximo ${MAX_PRODUTOS} produtos na TV`); else c.produtos = lista;
    }
  }
  for (const [campo, max, rotulo] of [['apelidos', 40, 'Nomes na TV'], ['frases', 90, 'Frases']]) {
    if (p[campo] === undefined) continue;
    if (!p[campo] || typeof p[campo] !== 'object' || Array.isArray(p[campo])) { err(`${rotulo} inválidos`); continue; }
    c[campo] = {}; for (const [cod, v] of Object.entries(p[campo])) { const n = String(v || '').trim().slice(0, max); if (codOk(cod) && n) c[campo][cod] = n; }
  }
  if (p.patrocinios !== undefined) {
    if (!Array.isArray(p.patrocinios)) err('Lista de marcas parceiras inválida');
    else {
      const lista = []; const ids = new Set();
      for (const x of p.patrocinios) { if (!x || typeof x !== 'object') continue; const o = normalizarPatrocinio(x, lenient, err); if (ids.has(o.id)) o.id = novoId(); ids.add(o.id); if (o.marca) lista.push(o); }
      if (lista.length > MAX_PATROCINIOS) err(`No máximo ${MAX_PATROCINIOS} marcas parceiras`); else c.patrocinios = lista;
    }
  }
  if (p.token && /^[a-f0-9]{32}$/.test(p.token)) c.token = p.token;
  if (!LOJAS[c.loja]) c.loja = PADRAO.loja;
  if (!MODOS.includes(c.modo)) c.modo = PADRAO.modo;
  if (!TEMAS.includes(c.tema)) c.tema = PADRAO.tema;
  c.segundos = segOk(c.segundos, PADRAO.segundos); c.segundosOferta = segOk(c.segundosOferta, PADRAO.segundosOferta); c.segundosPatrocinio = segOk(c.segundosPatrocinio, PADRAO.segundosPatrocinio);
  if (!(c.ofertaCada >= 0 && c.ofertaCada <= 12)) c.ofertaCada = PADRAO.ofertaCada;
  if (!(c.patrocinioCada >= 2 && c.patrocinioCada <= 12)) c.patrocinioCada = PADRAO.patrocinioCada;
  if (typeof c.titulo !== 'string' || !c.titulo) c.titulo = PADRAO.titulo;
  if (typeof c.rodape !== 'string') c.rodape = PADRAO.rodape;
  if (typeof c.quartaDaCarne !== 'boolean') c.quartaDaCarne = PADRAO.quartaDaCarne;
  if (!Array.isArray(c.selos)) c.selos = [...PADRAO.selos];
  for (const k of ['apelidos', 'frases']) if (!c[k] || typeof c[k] !== 'object') c[k] = {};
  if (!Array.isArray(c.patrocinios)) c.patrocinios = [];
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
function decodificar(dados, { png } = {}) {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/is.exec(String(dados || '').trim());
  const b64 = m ? m[2] : String(dados || '').trim();
  if (!b64) throw new Error('Imagem vazia');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 500) throw new Error('Imagem inválida');
  if (buf.length > FOTO_MAX_BYTES) throw new Error('Imagem muito grande (máximo 2,5 MB)');
  const jpeg = buf[0] === 0xFF && buf[1] === 0xD8;
  const ehPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  if (jpeg) return { buf, ext: 'jpg' };
  if (png && ehPng) return { buf, ext: 'png' };
  throw new Error(png ? 'A imagem precisa ser JPEG ou PNG' : 'A foto precisa ser JPEG (a tela converte sozinha ao escolher o arquivo)');
}
// dados = data URL (data:image/jpeg;base64,...) ou base64 puro. A tela de configuração já reduz e converte pra JPEG.
function salvarFoto(cod, dados) {
  if (!codOk(cod)) throw new Error('Código inválido');
  const { buf } = decodificar(dados);
  fs.writeFileSync(caminhoFoto(cod), buf);
  return { cod, bytes: buf.length, versao: versaoFoto(cod) };
}
function removerFoto(cod) { const f = caminhoFoto(cod); if (f && fs.existsSync(f)) fs.unlinkSync(f); return { cod, removida: true }; }

// ── Arquivos das marcas parceiras: <id>-logo.(png|jpg) e <id>-foto.jpg ──────
function arquivoPatrocinio(id, tipo) {
  if (!idOk(id) || !['logo', 'foto'].includes(tipo)) return null;
  for (const ext of (tipo === 'logo' ? ['png', 'jpg'] : ['jpg'])) { const f = path.join(DIR_PAT, `${id}-${tipo}.${ext}`); if (fs.existsSync(f)) return f; }
  return null;
}
function versaoArquivo(f) { try { return Math.round(fs.statSync(f).mtimeMs); } catch (e) { return 0; } }
function salvarArquivoPatrocinio(id, tipo, dados) {
  if (!idOk(id)) throw new Error('Marca inválida');
  if (!['logo', 'foto'].includes(tipo)) throw new Error('Tipo inválido (logo ou foto)');
  const { buf, ext } = decodificar(dados, { png: tipo === 'logo' });
  removerArquivoPatrocinio(id, tipo);
  const f = path.join(DIR_PAT, `${id}-${tipo}.${ext}`);
  fs.writeFileSync(f, buf);
  return { id, tipo, bytes: buf.length, versao: versaoArquivo(f) };
}
function removerArquivoPatrocinio(id, tipo) { let f; while ((f = arquivoPatrocinio(id, tipo))) fs.unlinkSync(f); return { id, tipo, removido: true }; }

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
const comFoto = p => ({ ...p, apelido: (config.apelidos || {})[p.cod] || null, frase: (config.frases || {})[p.cod] || null, foto: temFoto(p.cod), fotoV: versaoFoto(p.cod) });
const codsPatrocinios = () => (config.patrocinios || []).map(p => p.cod).filter(codOk);

// Produtos escolhidos, na ordem da lista, com preço da loja configurada (mais o preço dos produtos das marcas
// parceiras). Cache de 5 min; se o ERP falhar devolve o último resultado, sem renovar o carimbo de hora — passado
// DESATUALIZADO_MS a TV para de mostrar preço. Item sem preço (ou desativado/inexistente) sai da TV e vai pros avisos.
async function carregarProdutos(forcar) {
  const ttl = deps.cacheMs !== undefined ? deps.cacheMs : 5 * 60 * 1000;
  if (!forcar && cache && cache.loja === config.loja && Date.now() - cache.ms < ttl) return cache.produtos.map(comFoto);
  const cods = config.produtos || [];
  const todos = [...new Set([...cods, ...codsPatrocinios()])];
  let rows = [];
  if (todos.length) {
    try { rows = await deps.q(`${SQL_BASE} WHERE i.CodigoBarra IN (${todos.map(() => '?').join(',')})`, todos); }
    catch (e) {
      if (cache) { console.error('[TV-ACOUGUE] ERP falhou, usando cache:', e.message); cache.erroErp = e.message; return cache.produtos.map(comFoto); }
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
  cache = { porCod, produtos, faltando, semPreco, loja: config.loja, geradoEm: new Date().toISOString(), ms: Date.now(), erroErp: null };
  return produtos.map(comFoto);
}
const desatualizado = () => !cache || Date.now() - cache.ms > DESATUALIZADO_MS;
function totais() {
  if (!cache) return null;
  const ps = cache.produtos;
  return { selecionados: (config.produtos || []).length, exibidos: ps.length, ofertas: ps.filter(p => p.promo).length, semFoto: ps.filter(p => !temFoto(p.cod)).length,
           semPreco: cache.semPreco, faltando: cache.faltando, loja: cache.loja, lojaNome: nomeLoja(cache.loja), geradoEm: cache.geradoEm, erroErp: cache.erroErp || null, desatualizado: desatualizado() };
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

// ── Marcas parceiras ────────────────────────────────────────────────────────
function situacaoPatrocinio(p, hoje) {
  if (!p.ativo) return 'inativa';
  if (p.inicio && p.inicio > hoje) return 'agendada';
  if (p.fim && p.fim < hoje) return 'expirada';
  return 'vigente';
}
function produtoDoPatrocinio(p) {
  if (!p.cod || !cache) return null;
  const x = cache.porCod.get(p.cod);
  if (!x || x.desativado) return null;
  return { cod: x.cod, nome: (config.apelidos || {})[x.cod] || x.nome, preco: x.preco, unidade: x.unidade, promo: x.promo, foto: temFoto(x.cod), fotoV: versaoFoto(x.cod) };
}
function patrocinioInfo(p, hoje) {
  const logo = arquivoPatrocinio(p.id, 'logo'), foto = arquivoPatrocinio(p.id, 'foto');
  return { ...p, situacao: situacaoPatrocinio(p, hoje), produto: produtoDoPatrocinio(p), logo: logo ? path.extname(logo).slice(1) : null, logoV: logo ? versaoArquivo(logo) : 0, foto: !!foto, fotoV: foto ? versaoArquivo(foto) : 0 };
}
// Lista pra tela de configuração (todas, com situação) — chama depois de carregarProdutos.
function listarPatrocinios() { const hoje = hojeStr(); return (config.patrocinios || []).map(p => patrocinioInfo(p, hoje)); }

// Resposta da API pública da TV (sem token nem quem alterou).
async function payloadTV(opts) {
  const produtos = await carregarProdutos(false);
  const { token, atualizadoPor, produtos: _p, apelidos: _a, frases: _f, patrocinios: _pt, ...cfg } = getConfig();
  const hoje = hojeStr();
  const patrocinios = (config.patrocinios || []).filter(p => situacaoPatrocinio(p, hoje) === 'vigente').map(p => {
    const i = patrocinioInfo(p, hoje);
    return { id: i.id, marca: i.marca, titulo: i.titulo, frase: i.frase, fim: i.fim || null, produto: i.produto, logo: i.logo, logoV: i.logoV, foto: i.foto, fotoV: i.fotoV };
  });
  return { config: cfg, loja: { n: config.loja, nome: nomeLoja(config.loja) }, hojeQuarta: hojeQuarta(opts && opts.forcarQuarta), hoje,
           produtos: produtos.map(p => ({ cod: p.cod, nome: p.apelido || p.nome, nomeErp: p.nome, frase: p.frase, unidade: p.unidade, balanca: p.balanca, preco: p.preco, promo: p.promo, subgrupo: p.subgrupo, foto: p.foto, fotoV: p.fotoV })),
           patrocinios, dadosEm: cache ? cache.geradoEm : null, desatualizado: desatualizado(), erroErp: cache ? cache.erroErp || null : null };
}

module.exports = { init, getConfig, salvarConfig, novoToken, tokenValido, carregarProdutos, buscarProdutos, listarEscolhidos, listarPatrocinios, payloadTV, totais, hojeQuarta,
                   salvarFoto, removerFoto, temFoto, caminhoFoto, salvarArquivoPatrocinio, removerArquivoPatrocinio, arquivoPatrocinio,
                   nomeLoja, LOJAS, MODOS, TEMAS, MAX_PRODUTOS, MAX_PATROCINIOS, _final8: final8, _situacao: situacaoPatrocinio };
