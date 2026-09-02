const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const http = require('http');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { exec } = require('child_process');
const { parseSaidas, parseSaidasOfx, parseSaidasApi } = require('./lib/extrato-parser');
const { conciliar, addDias, similaridadeNome, normalizarNome, TOLERANCIA_DIAS: TOLERANCIA_CONCILIADOR, chaveSaida, aplicarAvulsos } = require('./lib/conciliador');
const multer = require('multer');
const pontaGondola = require('./lib/ponta-gondola');

// Congela o resultado de meses já fechados de Avaria/Prevenção. Sem isso, um
// NF emitida atrasada (DataEmi de um mês que já passou) mudava o total/% de
// um mês fechado toda vez que a página recarregasse — o relatório de um mês
// que já era passado não deveria mais se mexer. Uma vez calculado, um mês
// fechado (ano-mês anterior ao mês corrente real) nunca mais é recalculado.
const AVARIA_CONGELADO_PATH = path.join(__dirname, 'data', 'avaria-mensal-congelado.json');
function carregarAvariaCongelado() {
  try { return JSON.parse(fs.readFileSync(AVARIA_CONGELADO_PATH, 'utf8')); } catch (e) { return {}; }
}
function salvarAvariaCongelado(obj) {
  fs.mkdirSync(path.dirname(AVARIA_CONGELADO_PATH), { recursive: true });
  fs.writeFileSync(AVARIA_CONGELADO_PATH, JSON.stringify(obj, null, 2));
}
function mesFechado(ano, mes) {
  const hoje = new Date();
  return ano < hoje.getFullYear() || (ano === hoje.getFullYear() && mes < hoje.getMonth() + 1);
}

// Conciliações avulsas (matches manuais com justificativa) — persistidas em
// JSON local, nunca no MySQL do ERP (que é somente leitura).
const AVULSOS_PATH = path.join(__dirname, 'data', 'conciliacoes-avulsas.json');
function carregarAvulsos() {
  try { return JSON.parse(fs.readFileSync(AVULSOS_PATH, 'utf8')); } catch (e) { return []; }
}
function salvarAvulsos(lista) {
  fs.mkdirSync(path.dirname(AVULSOS_PATH), { recursive: true });
  fs.writeFileSync(AVULSOS_PATH, JSON.stringify(lista, null, 2));
}

// Backfill único na subida do servidor: avulsos confirmados antes do Plano
// de Contas e dos campos de encargo (Acrescimo/Multa/Juros/Desconto/
// Devolucao) existirem nesse fluxo ficaram sem esses dados — busca no ERP
// pelo nReg salvo e completa o registro.
async function backfillPlanoAvulsos() {
  try {
    const lista = carregarAvulsos();
    const pendentes = lista.filter(a => a.nReg && (a.planoGrupo == null || a.acrescimo == null));
    if (!pendentes.length) return;
    const plano = await getPlanoContas();
    for (const a of pendentes) {
      const [row] = await q(
        'SELECT PlanoGrupo, PlanoSub, Acrescimo, Multa, Juros, Desconto, Devolucao, ValorBruto FROM loja20045.contasapagar WHERE nReg = ?',
        [a.nReg]
      );
      if (!row) continue;
      a.planoGrupo = row.PlanoGrupo;
      a.planoSub = row.PlanoSub;
      a.planoGrupoNome = plano.grupoMap.get(row.PlanoGrupo) || null;
      a.planoSubNome = plano.subMap.get(`${row.PlanoGrupo}|${row.PlanoSub}`) || null;
      a.acrescimo = Number(row.Acrescimo) || 0;
      a.multa = Number(row.Multa) || 0;
      a.juros = Number(row.Juros) || 0;
      a.desconto = Number(row.Desconto) || 0;
      a.devolucao = Number(row.Devolucao) || 0;
      a.valorBruto = row.ValorBruto != null ? Number(row.ValorBruto) : null;
    }
    salvarAvulsos(lista);
    console.log(`✓ Backfill Plano de Contas/encargos: ${pendentes.length} conciliação(ões) avulsa(s) atualizada(s)`);
  } catch (err) {
    console.error('[BACKFILL-AVULSOS-ERR]', err.message);
  }
}

// Cache do Plano de Contas do ERP (loja20045.planodecontas) — traduz
// PlanoGrupo/PlanoSub em nome legível pro Conciliador. Recarrega a cada 10min.
let planoContasCache = null;
let planoContasCacheEm = 0;
async function getPlanoContas() {
  const agora = Date.now();
  if (planoContasCache && agora - planoContasCacheEm < 10 * 60 * 1000) return planoContasCache;
  const rows = await q('SELECT PlanoGrupo, PlanoSub, Descricao FROM loja20045.planodecontas');
  const subMap = new Map();
  const grupoMap = new Map();
  for (const r of rows) {
    subMap.set(`${r.PlanoGrupo}|${r.PlanoSub}`, r.Descricao?.trim());
    if (r.PlanoSub === 0) grupoMap.set(r.PlanoGrupo, r.Descricao?.trim());
  }
  planoContasCache = { subMap, grupoMap };
  planoContasCacheEm = agora;
  return planoContasCache;
}
function enriquecerComPlanoContas(candidatosRaw, plano) {
  return candidatosRaw.map(c => ({
    ...c,
    planoGrupoNome: plano.grupoMap.get(c.PlanoGrupo) || null,
    planoSubNome: plano.subMap.get(`${c.PlanoGrupo}|${c.PlanoSub}`) || null
  }));
}

const app = express();
// /negativos-agent fica de fora do body-parser global: é proxy puro pro
// processo negativos-agent (porta 4300), e precisa do corpo da requisição
// intacto pra repassar (upload de fotos passa de 10mb — o limite daqui nem
// se aplicaria a ele, viraria só um consumo inútil do stream).
app.use((req, res, next) => {
  if (req.path.startsWith('/negativos-agent')) return next();
  express.json({ limit: '10mb' })(req, res, next);
});

// Versão do processo — muda a cada deploy/restart, usada pra avisar o
// usuário que o app foi atualizado (ver /api/versao).
const APP_VERSAO = String(Date.now());
app.get('/api/versao', (req, res) => res.json({ versao: APP_VERSAO }));

// Atalho curto pra digitar em controle de TV (teclado na tela é lento/chato)
app.get('/tv', (req, res) => res.redirect('/painel-compras.html'));

// ── CACHE EM MEMÓRIA ─────────────────────────────────────
const _cache = new Map();
function withCache(ttlMin) {
  return (req, res, next) => {
    // ?refresh=1 força recálculo (usado pelo botão "Analisar Agora" — clicar
    // de novo deve sempre buscar dado fresco, não só repetir o cache). A
    // chave ignora esse parâmetro pra não fragmentar o cache normal.
    const { refresh, ...restQuery } = req.query;
    const qs = new URLSearchParams(restQuery).toString();
    const key = req.path + (qs ? '?' + qs : '');
    const hit = _cache.get(key);
    if (!refresh && hit && Date.now() < hit.exp) return res.json(hit.data);
    const origJson = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode === 200 && data && !data.error)
        _cache.set(key, { data, exp: Date.now() + ttlMin * 60 * 1000 });
      return origJson(data);
    };
    next();
  };
}

// Carrega usuários do arquivo
const usuariosPath = path.join(__dirname, 'usuarios.json');
let usuarios;
try {
  usuarios = JSON.parse(fs.readFileSync(usuariosPath, 'utf8'));
} catch(e) {
  // Arquivo não existe (primeiro start ou deletado pelo git) — cria com admin padrão
  usuarios = [{ id:1, nome:'Tiago Freire', usuario:'tiago.freire',
    senha_hash:'$2b$10$6.LaA51gwHjaNt32tJRuNuDZy.7E1ordbtVg1mfdk3T67w2aE1Mpa',
    perfil:'admin', comprador_nome:null }];
  fs.writeFileSync(usuariosPath, JSON.stringify(usuarios, null, 2));
}

// Sessão (8 horas)
// Sessão (8 horas) — gravada em disco (não só em memória) pra sobreviver a
// reinício do servidor. Todo deploy reinicia o processo; com sessão só em
// memória isso deslogava todo mundo, inclusive os painéis de TV que ficam
// abertos sem ninguém pra logar de novo na sala.
app.use(session({
  store: new FileStore({
    path: path.join(__dirname, 'data', 'sessions'),
    ttl: 8 * 60 * 60,
    retries: 0,
    logFn: () => {} // a lib loga toda leitura/escrita no console por padrão — silencia
  }),
  secret: 'ec0n0mic0-bi-2026-xK9#mP',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

// Middleware de autenticação (antes do static)
app.use((req, res, next) => {
  const publico = ['/login.html', '/api/login', '/api/logout', '/logo.png', '/deploy', '/api/versao',
    '/api/negativos/reenviar', '/api/pendencias/congelar-manual',
    '/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png',
    '/relatorio-cronograma.html',
    '/precificacao.html', '/compras.html', '/comprador.html', '/supervisao.html',
    '/api/precificacao/margens-criticas', '/api/compras/pedidos-hoje',
    '/diretoria.html', '/api/diretoria/kpis',
    '/api/top-vendidos', '/api/top-mercadologico',
    '/api/compras/verificar-comprador',
    '/api/compras/analise-estoque',
    '/analise-comprador.html',
    '/api/compras/fornec-por-lista',
    '/api/compras/pedidos-mes',
    '/mensal.html',
    '/comparativo-tv.html', '/api/comparativo-tv',
    '/prevencao.html', '/api/pendencias/prevencao', '/api/pendencias/prevencao-consolidado', '/api/pendencias/prevencao-bonif',
    '/api/ruptura/debug-comprador',
    '/api/_diag/tabelas-central',
    '/ruptura-painel.html', '/api/ruptura', '/api/ruptura/comprador-listas',
    '/margem-comprador.html', '/api/margem-tv/comprador',
    '/painel-diretoria.html',
    '/painel-cd.html', '/api/painel-cd',
    '/painel-compras.html', '/tv'];
  if (publico.includes(req.path)) return next();
  // Pré-aquecimento interno (somente localhost)
  if (req.headers['x-internal-warmup'] === 'fc360warmup2026' && req.socket.remoteAddress === '::1') return next();
  const ext = req.path.split('.').pop().toLowerCase();
  if (['js','css','png','jpg','jpeg','gif','svg','ico','woff','woff2','ttf','eot','map'].includes(ext)) return next();
  if (req.session && req.session.user) {
    // Rotas exclusivas de admin
    if ((req.path === '/admin-usuarios.html' || req.path.startsWith('/api/admin/')) &&
        req.session.user.perfil !== 'admin') {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Sem permissão' });
      return res.redirect('/index.html');
    }
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  return res.redirect('/login.html');
});

// Arquivos estáticos (após auth)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ── AUTH ENDPOINTS ──────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ error: 'Preencha usuário e senha.' });
  const user = usuarios.find(u => u.usuario === usuario.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  const ok = await bcrypt.compare(String(senha), user.senha_hash);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  const perfil = user.perfil || 'gerente';
  req.session.user = { id: user.id, nome: user.nome, usuario: user.usuario, perfil, comprador_nome: user.comprador_nome || null, loja_id: user.loja_id || null };
  let redirect = '/index.html';
  res.json({ ok: true, nome: user.nome, perfil, redirect });
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

app.get('/api/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  res.json(req.session.user);
});

// ── ADMIN: CRUD de usuários ──────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.user?.perfil !== 'admin') return res.status(403).json({ error: 'Sem permissão' });
  next();
}
function salvarUsuarios() {
  fs.writeFileSync(usuariosPath, JSON.stringify(usuarios, null, 2));
}

app.get('/api/admin/usuarios', requireAdmin, (req, res) => {
  res.json(usuarios.map(u => ({ id: u.id, nome: u.nome, usuario: u.usuario, perfil: u.perfil || 'gerente', comprador_nome: u.comprador_nome || null, loja_id: u.loja_id || null })));
});

app.post('/api/admin/usuarios', requireAdmin, async (req, res) => {
  const { nome, usuario, senha, perfil, comprador_nome, loja_id } = req.body || {};
  if (!nome || !usuario || !senha || !perfil) return res.status(400).json({ error: 'Campos obrigatórios: nome, usuario, senha, perfil' });
  if (usuarios.find(u => u.usuario === usuario.toLowerCase().trim())) return res.status(400).json({ error: 'Usuário já existe' });
  const hash = await bcrypt.hash(String(senha), 10);
  const novoId = Math.max(...usuarios.map(u => u.id), 0) + 1;
  usuarios.push({ id: novoId, nome: nome.trim(), usuario: usuario.toLowerCase().trim(), senha_hash: hash, perfil, comprador_nome: comprador_nome || null, loja_id: loja_id ? parseInt(loja_id) : null });
  salvarUsuarios();
  res.json({ ok: true, id: novoId });
});

app.put('/api/admin/usuarios/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const idx = usuarios.findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { nome, usuario, senha, perfil, comprador_nome, loja_id } = req.body || {};
  if (nome) usuarios[idx].nome = nome.trim();
  if (usuario) {
    if (usuarios.find(u => u.usuario === usuario.toLowerCase().trim() && u.id !== id)) return res.status(400).json({ error: 'Usuário já existe' });
    usuarios[idx].usuario = usuario.toLowerCase().trim();
  }
  if (senha) usuarios[idx].senha_hash = await bcrypt.hash(String(senha), 10);
  if (perfil) usuarios[idx].perfil = perfil;
  usuarios[idx].comprador_nome = comprador_nome || null;
  usuarios[idx].loja_id = loja_id ? parseInt(loja_id) : null;
  salvarUsuarios();
  res.json({ ok: true });
});

app.delete('/api/admin/usuarios/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: 'Não pode excluir o próprio usuário' });
  const idx = usuarios.findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  usuarios.splice(idx, 1);
  salvarUsuarios();
  res.json({ ok: true });
});

// Host do MySQL configurável via variável de ambiente DB_HOST — permite
// apontar para o banco espelho de outro servidor sem editar código.
// Se DB_HOST não estiver definida, usa o servidor atual (192.168.2.252).
const dbConfig = {
  host: process.env.DB_HOST || '192.168.2.252',
  port: 3306,
  user: 'root',
  password: '1900',
  connectTimeout: 15000
};

// Mapeamento baseado em central.tipo_finalizadora
const pagtoLabels = {
  '01': 'PIX / Débito', '02': 'Crédito', '03': 'Voucher',
  '04': 'POS', '98': 'Dinheiro', '99': 'Outros'
};

async function q(sql, params = []) {
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
  } catch(connErr) {
    console.error('[DB-CONN-ERR]', connErr.code, connErr.errno, connErr.message, connErr.sqlMessage);
    throw new Error(connErr.message || connErr.code || JSON.stringify(connErr));
  }
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } catch(queryErr) {
    console.error('[DB-QUERY-ERR]', queryErr.code, queryErr.message, sql.substring(0,80));
    throw new Error(queryErr.message || queryErr.code || JSON.stringify(queryErr));
  } finally {
    await conn.end().catch(()=>{});
  }
}

function mesDB(mes) {
  return 'mes' + String(mes).padStart(2, '0');
}

function buildUnionSemana(mes, dataInicio, dataFim) {
  const lojas = [1, 2, 3, 4, 5, 6];
  return lojas.map(ln =>
    `SELECT Codigo, Descricao, QtdNovo, ValorTotalNovo FROM \`ln${ln}${mesDB(mes)}\`.zcupomitens WHERE Data BETWEEN '${dataInicio}' AND '${dataFim}' AND IndCancel='N'`
  ).join(' UNION ALL ');
}

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

// Data local (sem timezone UTC) — evita bug de virar dia às 21h no Brasil
function localDate(d) {
  const dt = d || new Date();
  const y  = dt.getFullYear();
  const m  = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Último dia real do mês — evita '2026-06-31' (data inválida) que retorna NULL no MySQL
function dFimMes(ano, mes) {
  const ultimo = new Date(ano, mes, 0).getDate();
  return `${ano}-${String(mes).padStart(2,'0')}-${String(ultimo).padStart(2,'0')}`;
}

// KPIs resumo — aceita ?loja=1..6 e ?mes=1..12
app.get('/api/kpis', withCache(60), async (req, res) => {
  try {
    const hoje = new Date();
    const ano  = hoje.getFullYear();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;

    const anoAnt  = ano - 1;
    const mm      = mesDB(mesSel);
    const mmAnt   = mesDB(mesSel);
    const lojas   = lojaSel ? [lojaSel] : [1,2,3,4,5,6];

    const diaHoje = String(hoje.getDate()).padStart(2,'0');
    const mesStr  = String(mesSel).padStart(2,'0');

    const dIni        = `${ano}-${mesStr}-01`;
    const dFim        = dFimMes(ano, mesSel);
    const dIniAnt     = `${anoAnt}-${mesStr}-01`;
    const dFimAntHoje = `${anoAnt}-${mesStr}-${diaHoje}`;  // mesmo dia do ano passado
    const dFimAntMes  = dFimMes(anoAnt, mesSel);           // mês completo ano passado

    // Faturamento + custo + cupons mês atual
    let atual = 0, custoAtual = 0, totalCupons = 0;
    for (const ln of lojas) {
      try {
        const [r] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda, COALESCE(SUM(Custo),0) as custo, COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIni, dFim]
        );
        atual        += parseFloat(r.venda || 0);
        custoAtual   += parseFloat(r.custo || 0);
        totalCupons  += parseInt(r.cupons || 0);
      } catch(_) {}
    }

    // Ano anterior: mesmo mês até mesmo dia + mês completo
    let antAteDia = 0, antMesTotal = 0;
    for (const ln of lojas) {
      try {
        const [r1] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda FROM \`ln${ln}${mmAnt}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIniAnt, dFimAntHoje]
        );
        antAteDia += parseFloat(r1.venda || 0);
        const [r2] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda FROM \`ln${ln}${mmAnt}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIniAnt, dFimAntMes]
        );
        antMesTotal += parseFloat(r2.venda || 0);
      } catch(_) {}
    }

    // Produtos únicos vendidos na semana
    const dataFim    = fmtDate(hoje);
    const inicioSem  = new Date(hoje); inicioSem.setDate(hoje.getDate() - 6);
    const dataInicio = fmtDate(inicioSem);
    let prodSemana = { total: 0 };
    try {
      const union = lojas.map(ln =>
        `SELECT Codigo FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN '${dataInicio}' AND '${dataFim}' AND IndCancel='N'`
      ).join(' UNION ALL ');
      [prodSemana] = await q(`SELECT COUNT(DISTINCT Codigo) as total FROM (${union}) t`);
    } catch(_) {}

    const variacaoAno = antAteDia > 0 ? (((atual - antAteDia) / antAteDia) * 100).toFixed(1) : 0;
    const lucroAtual  = atual - custoAtual;
    const margemSC    = custoAtual > 0 ? +(lucroAtual / custoAtual * 100).toFixed(2) : 0;
    const margemSV    = atual > 0      ? +(lucroAtual / atual      * 100).toFixed(2) : 0;

    const ticketMedio = totalCupons > 0 ? +(atual / totalCupons).toFixed(2) : 0;

    res.json({
      faturamento_mes: +atual.toFixed(2),
      fat_ano_ant_ate_dia: +antAteDia.toFixed(2),
      fat_ano_ant_mes_total: +antMesTotal.toFixed(2),
      variacao_percentual: parseFloat(variacaoAno),
      ticket_medio: ticketMedio,
      total_cupons: totalCupons,
      margem_sc: margemSC,
      margem_sv: margemSV,
      mes: mesSel,
      ano_ant: anoAnt,
      dia_ate: diaHoje,
      loja: lojaSel || 'todas'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KPIs por loja — painel diretoria
app.get('/api/diretoria/kpis', withCache(30), async (req, res) => {
  try {
    const hoje   = new Date();
    const ano    = hoje.getFullYear();
    const mes    = hoje.getMonth() + 1;
    const anoAnt = ano - 1;
    const mm     = mesDB(mes);
    const diaHoje = String(hoje.getDate()).padStart(2,'0');
    const mesStr  = String(mes).padStart(2,'0');
    const dIni        = `${ano}-${mesStr}-01`;
    const dFim        = dFimMes(ano, mes);
    const dIniAnt     = `${anoAnt}-${mesStr}-01`;
    const dFimAntHoje = `${anoAnt}-${mesStr}-${diaHoje}`;

    const lojas = await Promise.all([1,2,3,4,5,6].map(async ln => {
      try {
        const [r] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda, COALESCE(SUM(Custo),0) as custo,
                  COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons
           FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIni, dFim]
        );
        const [r1] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda
           FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIniAnt, dFimAntHoje]
        );
        const venda  = parseFloat(r.venda  || 0);
        const custo  = parseFloat(r.custo  || 0);
        const cupons = parseInt(r.cupons   || 0);
        const antAteDia = parseFloat(r1.venda || 0);
        const variacao  = antAteDia > 0 ? +((venda - antAteDia) / antAteDia * 100).toFixed(1) : 0;
        const msv    = venda  > 0 ? +((venda - custo) / venda * 100).toFixed(1) : 0;
        const ticket = cupons > 0 ? +(venda / cupons).toFixed(2) : 0;
        return { loja: ln, faturamento: +venda.toFixed(2), fat_ant_ate_dia: +antAteDia.toFixed(2), variacao, msv, ticket, cupons };
      } catch(e) {
        return { loja: ln, faturamento: 0, fat_ant_ate_dia: 0, variacao: 0, msv: 0, ticket: 0, cupons: 0 };
      }
    }));

    res.json({ lojas, mes, dia_ate: diaHoje, ano_ant: anoAnt });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 1. Produtos mais vendidos essa semana
app.get('/api/produtos-semana', async (req, res) => {
  try {
    const hoje   = new Date();
    const mes    = hoje.getMonth() + 1;
    const dataFim   = fmtDate(hoje);
    const inicio    = new Date(hoje); inicio.setDate(hoje.getDate() - 6);
    const dataInicio = fmtDate(inicio);
    const mm     = mesDB(mes);
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas  = lojaSel ? [lojaSel] : [1,2,3,4,5,6];

    const mapa = {};
    for (const ln of lojas) {
      const db = 'ln' + ln + mm;
      try {
        const rows = await q(
          'SELECT Codigo, TRIM(Descricao) as desc_, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as val FROM `' + db + '`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel=\'N\' GROUP BY Codigo, Descricao',
          [dataInicio, dataFim]
        );
        for (const r of rows) {
          const k = r.Codigo;
          if (!mapa[k]) mapa[k] = { codigobarras: k, descricao: r.desc_?.trim(), total_semana: 0, total_valor: 0 };
          mapa[k].total_semana += parseFloat(r.qtd || 0);
          mapa[k].total_valor  += parseFloat(r.val || 0);
        }
      } catch (e) {}
    }

    const codigos = Object.keys(mapa);
    if (codigos.length > 0) {
      const ph = codigos.map(() => '?').join(',');
      const itensRows = await q(`SELECT CodigoBarra, Descricao FROM central.itens WHERE CodigoBarra IN (${ph})`, codigos);
      for (const r of itensRows) {
        if (mapa[r.CodigoBarra]) mapa[r.CodigoBarra].descricao = r.Descricao?.trim() || mapa[r.CodigoBarra].descricao;
      }
    }

    res.json(Object.values(mapa).sort((a,b) => b.total_semana - a.total_semana).slice(0,15));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Faturamento mensal do ano
app.get('/api/faturamento-mensal', withCache(240), async (req, res) => {
  try {
    const ano     = new Date().getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    let sql = 'SELECT Mes, SUM(Total) as total FROM dashboard.vendas WHERE Ano=?';
    const params = [ano];
    if (lojaSel) { sql += ' AND nLoja=?'; params.push(lojaSel); }
    sql += ' GROUP BY Mes ORDER BY Mes';
    const rows = await q(sql, params);
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    res.json(rows.map(r => ({ mes: meses[r.Mes - 1], total: parseFloat(r.total) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Top 10 mais vendidos por loja e mês
app.get('/api/top-vendidos', withCache(120), async (req, res) => {
  try {
    const hoje   = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas   = lojaSel ? [lojaSel] : [1,2,3,4,5,6];
    const mm      = mesDB(mesSel);
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const ultimoDia = new Date(anoSel, mesSel, 0).getDate();
    const dFim    = `${anoSel}-${String(mesSel).padStart(2,'0')}-${String(ultimoDia).padStart(2,'0')}`;

    let union;
    if (lojaSel) {
      union = `SELECT Codigo, Descricao, QtdNovo, ValorTotalNovo FROM \`ln${lojaSel}${mm}\`.zcupomitens WHERE IndCancel='N' AND Data BETWEEN '${dIni}' AND '${dFim}'`;
    } else {
      const partes = await Promise.all(lojas.map(async ln => {
        const d = `ln${ln}${mm}`;
        try {
          const [t] = await q(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='zcupomitens'`, [d]);
          return t ? `SELECT Codigo, Descricao, QtdNovo, ValorTotalNovo FROM \`${d}\`.zcupomitens WHERE IndCancel='N' AND Data BETWEEN '${dIni}' AND '${dFim}'` : null;
        } catch(e) { return null; }
      }));
      const validas = partes.filter(Boolean);
      if (!validas.length) return res.json([]);
      union = validas.join(' UNION ALL ');
    }

    const rows = await q(
      `SELECT Codigo, TRIM(Descricao) as descricao,
              SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as faturamento
       FROM (${union}) t
       GROUP BY Codigo, Descricao
       ORDER BY qtd DESC
       LIMIT 10`
    );
    if (rows.length) {
      const ph = rows.map(() => '?').join(',');
      const itens = await q(`SELECT CodigoBarra, Descricao FROM central.itens WHERE CodigoBarra IN (${ph})`, rows.map(r => r.Codigo));
      const itensMap = {};
      for (const i of itens) itensMap[i.CodigoBarra] = i.Descricao?.trim();
      res.json(rows.map(r => ({
        descricao: itensMap[r.Codigo] || r.descricao,
        qtd: parseFloat(r.qtd),
        faturamento: parseFloat(r.faturamento)
      })));
    } else {
      res.json([]);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top mercadológico por mês
app.get('/api/top-mercadologico', withCache(240), async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const anoSel  = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas   = lojaSel ? [lojaSel] : [1,2,3,4,5,6];
    const mm      = mesDB(mesSel);
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const ultimoDia = new Date(anoSel, mesSel, 0).getDate();
    const dFim    = `${anoSel}-${String(mesSel).padStart(2,'0')}-${String(ultimoDia).padStart(2,'0')}`;

    // Vendas do mês por produto
    let vendasMap = {};
    for (const ln of lojas) {
      try {
        const rows = await q(`SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor
          FROM \`ln${ln}${mm}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [dIni, dFim]);
        for (const r of rows) {
          if (!vendasMap[r.Codigo]) vendasMap[r.Codigo] = { qtd: 0, valor: 0 };
          vendasMap[r.Codigo].qtd   += parseFloat(r.qtd);
          vendasMap[r.Codigo].valor += parseFloat(r.valor);
        }
      } catch(e) {}
    }

    // Itens com mercadológico nível 1 (grupo)
    const itens = await q(`
      SELECT i.CodigoBarra, g.CodGrupo,
             g.Descricao as merc_desc
      FROM central.itens i
      INNER JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub AND gs.CodDesativado = 0
      INNER JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
      WHERE i.CodDesativado = 0 AND i.CodGrupoSub > 0
    `);

    // Agrupa por mercadológico nível 1
    const mMap = {};
    for (const it of itens) {
      const v = vendasMap[it.CodigoBarra];
      if (!v) continue;
      const key = it.CodGrupo;
      if (!mMap[key]) mMap[key] = { descricao: it.merc_desc?.trim(), qtd: 0, valor: 0 };
      mMap[key].qtd   += v.qtd;
      mMap[key].valor += v.valor;
    }

    const result = Object.values(mMap)
      .filter(r => r.qtd > 0)
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 15)
      .map(r => ({
        descricao: r.descricao,
        qtd:       +r.qtd.toFixed(0),
        valor:     +r.valor.toFixed(2)
      }));

    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 4. Vendas por forma de pagamento
app.get('/api/formas-pagamento', async (req, res) => {
  try {
    const hoje    = new Date();
    const ano     = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : null;
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    let sql = 'SELECT TipoPagto, SUM(Total) as total FROM dashboard.tipovendas WHERE Ano=?';
    const params = [ano];
    if (mesSel)  { sql += ' AND Mes=?';   params.push(mesSel); }
    if (lojaSel) { sql += ' AND nLoja=?'; params.push(lojaSel); }
    sql += ' GROUP BY TipoPagto ORDER BY total DESC';
    const rows = await q(sql, params);
    res.json(rows.map(r => ({
      tipo: pagtoLabels[r.TipoPagto] || `Tipo ${r.TipoPagto}`,
      total: parseFloat(r.total)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Consulta dinâmica por loja/período
app.get('/api/consulta', async (req, res) => {
  try {
    const { loja, inicio, fim, ordenar = 'qtd', top = 20, produto = '', grupo = '', subgrupo = '' } = req.query;

    if (!loja || !inicio || !fim) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios: loja, inicio, fim' });
    }

    const dataInicio = inicio;
    const dataFim = fim;
    const limite = Math.min(parseInt(top) || 20, 100);
    const ordem = ordenar === 'valor' ? 'total_valor DESC' : 'total_qtd DESC';

    // Descobre quais bancos mes01-mes12 precisam ser consultados
    const d1 = new Date(dataInicio + 'T12:00:00');
    const d2 = new Date(dataFim + 'T12:00:00');
    const mesesNeeded = new Set();
    const cur = new Date(d1.getFullYear(), d1.getMonth(), 1);
    while (cur <= d2) {
      mesesNeeded.add(String(cur.getMonth() + 1).padStart(2, '0'));
      cur.setMonth(cur.getMonth() + 1);
    }

    const lojas = loja === 'todas' ? [1, 2, 3, 4, 5, 6] : [parseInt(loja)];

    // Se há filtro de produto e/ou de mercadológico (grupo/subgrupo), busca os
    // códigos de barra correspondentes no cadastro central — os dois filtros
    // combinam com AND quando usados juntos (ex: "leite" dentro de "Laticínios").
    let nomesCompletos = {};
    let codigosProduto = null;
    if (produto) {
      const itensCad = await q(
        'SELECT CodigoBarra, Descricao FROM central.itens WHERE Descricao LIKE ? OR CodigoBarra LIKE ?',
        ['%' + produto + '%', '%' + produto + '%']
      );
      codigosProduto = itensCad.map(r => r.CodigoBarra);
      itensCad.forEach(r => { nomesCompletos[r.CodigoBarra] = r.Descricao?.trim(); });
    }

    let codigosMerc = null;
    if (subgrupo || grupo) {
      const where = subgrupo ? 'i.CodGrupoSub = ?' : 'gs.CodGrupo = ?';
      const itensMerc = await q(`
        SELECT i.CodigoBarra, i.Descricao FROM central.itens i
        LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
        WHERE ${where}
      `, [parseInt(subgrupo || grupo)]);
      codigosMerc = itensMerc.map(r => r.CodigoBarra);
      itensMerc.forEach(r => { if (!nomesCompletos[r.CodigoBarra]) nomesCompletos[r.CodigoBarra] = r.Descricao?.trim(); });
    }

    let codigosFiltro = null;
    if (codigosProduto && codigosMerc) codigosFiltro = codigosProduto.filter(c => codigosMerc.includes(c));
    else if (codigosProduto) codigosFiltro = codigosProduto;
    else if (codigosMerc) codigosFiltro = codigosMerc;

    if (codigosFiltro && !codigosFiltro.length) {
      return res.json({ total_produtos: 0, total_faturamento: 0, total_itens: 0, modo_todas: loja === 'todas', data: [] });
    }

    const modoTodas = loja === 'todas';
    const mapa = {};
    for (const mm of mesesNeeded) {
      for (const ln of lojas) {
        const db = 'ln' + ln + 'mes' + mm;
        try {
          let filtroNome = '';
          let params = [dataInicio, dataFim];
          if (codigosFiltro) {
            filtroNome = ' AND Codigo IN (' + codigosFiltro.map(() => '?').join(',') + ')';
            params = [dataInicio, dataFim, ...codigosFiltro];
          }
          const rows = await q(
            'SELECT Codigo, TRIM(Descricao) as desc_, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as val, COUNT(DISTINCT CCF) as cupons FROM `' + db + '`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel=\'N\'' + filtroNome + ' GROUP BY Codigo, Descricao',
            params
          );
          for (const r of rows) {
            const k = r.Codigo;
            const nomeCompleto = nomesCompletos[k] || r.desc_?.trim();
            if (!mapa[k]) mapa[k] = { codigo: k, produto: nomeCompleto, total_qtd: 0, total_valor: 0, cupons: 0,
              lojas: {1:0,2:0,3:0,4:0,5:0,6:0}, valor_lojas: {1:0,2:0,3:0,4:0,5:0,6:0} };
            const qtd = parseFloat(r.qtd || 0);
            const val = parseFloat(r.val || 0);
            mapa[k].total_qtd += qtd;
            mapa[k].total_valor += val;
            mapa[k].cupons += parseInt(r.cupons || 0);
            if (modoTodas) {
              mapa[k].lojas[ln] = (mapa[k].lojas[ln] || 0) + qtd;
              mapa[k].valor_lojas[ln] = (mapa[k].valor_lojas[ln] || 0) + val;
            }
          }
        } catch (e) { /* banco não existe para esse período */ }
      }
    }

    // Enrich all product descriptions with NF-e names from central.itens
    const todoscodigos = Object.keys(mapa);
    if (todoscodigos.length > 0 && !codigosFiltro) {
      const ph = todoscodigos.map(() => '?').join(',');
      const itensEnrich = await q(`SELECT CodigoBarra, Descricao FROM central.itens WHERE CodigoBarra IN (${ph})`, todoscodigos);
      for (const it of itensEnrich) {
        if (mapa[it.CodigoBarra]) mapa[it.CodigoBarra].produto = it.Descricao?.trim() || mapa[it.CodigoBarra].produto;
      }
    }

    const result = Object.values(mapa)
      .map(r => {
        const base = {
          ...r,
          total_qtd: parseFloat(r.total_qtd.toFixed(3)),
          total_valor: parseFloat(r.total_valor.toFixed(2)),
          ticket_medio: r.cupons > 0 ? parseFloat((r.total_valor / r.cupons).toFixed(2)) : 0
        };
        if (modoTodas) {
          base.lojas = Object.fromEntries(Object.entries(r.lojas).map(([k,v]) => [k, parseFloat(v.toFixed(3))]));
          base.valor_lojas = Object.fromEntries(Object.entries(r.valor_lojas).map(([k,v]) => [k, parseFloat(v.toFixed(2))]));
        } else {
          delete base.lojas;
          delete base.valor_lojas;
        }
        return base;
      })
      .sort((a, b) => ordenar === 'valor' ? b.total_valor - a.total_valor : b.total_qtd - a.total_qtd)
      .slice(0, limite);

    res.json({
      total_produtos: result.length,
      total_faturamento: parseFloat(result.reduce((s, r) => s + r.total_valor, 0).toFixed(2)),
      total_itens: parseFloat(result.reduce((s, r) => s + r.total_qtd, 0).toFixed(0)),
      modo_todas: modoTodas,
      data: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grupos e subgrupos para popular dropdowns
app.get('/api/grupos', async (req, res) => {
  try {
    const grupos = await q(`
      SELECT g.CodGrupo, g.Descricao as grupo,
             gs.CodSubGrupo, gs.Descricao as subgrupo,
             COUNT(i.nInterno) as total,
             SUM(CASE WHEN i.CodDesativado=0 THEN 1 ELSE 0 END) as ativos
      FROM central.grupo g
      LEFT JOIN central.gruposub gs ON gs.CodGrupo = g.CodGrupo
      LEFT JOIN central.itens i ON i.CodGrupoSub = gs.CodSubGrupo
      WHERE g.CodGrupo NOT IN (1,59,61,63,66,65,67)
      GROUP BY g.CodGrupo, gs.CodSubGrupo
      HAVING total > 0
      ORDER BY g.Descricao, gs.Descricao
    `);
    // Monta hierarquia
    const mapa = {};
    for (const r of grupos) {
      if (!mapa[r.CodGrupo]) mapa[r.CodGrupo] = { id: r.CodGrupo, nome: r.grupo, subs: [] };
      if (r.CodSubGrupo) {
        mapa[r.CodGrupo].subs.push({ id: r.CodSubGrupo, nome: r.subgrupo, total: r.total, ativos: r.ativos });
      }
    }
    res.json(Object.values(mapa));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function parsePreco(v) { return v && v !== '0' ? parseFloat(String(v).replace(',', '.')) : 0; }

// Consulta de itens por grupo/subgrupo
app.get('/api/itens', async (req, res) => {
  try {
    const { grupo, subgrupo, ativo, busca, loja = '1', pagina = 1, limite = 50 } = req.query;
    const ln = parseInt(loja) || 1;
    const offset = (parseInt(pagina) - 1) * parseInt(limite);

    let where = [];
    let params = [];

    if (subgrupo) { where.push('i.CodGrupoSub = ?'); params.push(parseInt(subgrupo)); }
    else if (grupo) { where.push('g.CodGrupo = ?'); params.push(parseInt(grupo)); }

    if (ativo === '1') { where.push('i.CodDesativado = 0'); }
    else if (ativo === '0') { where.push('i.CodDesativado = 1'); }

    if (busca) { where.push('i.Descricao LIKE ?'); params.push('%' + busca + '%'); }

    const filtro = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [total] = await q(`
      SELECT COUNT(*) as cnt
      FROM central.itens i
      LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
      LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
      ${filtro}
    `, params);

    // Modo todas as lojas
    if (loja === 'todas') {
      const rows = await q(`
        SELECT
          i.nInterno, i.CodigoBarra, i.Descricao,
          i.CodDesativado, i.Unid, i.Marca,
          i.P1, i.P2, i.P3, i.P4, i.P5, i.P6,
          e1.Qtd as est1, e2.Qtd as est2, e3.Qtd as est3,
          e4.Qtd as est4, e5.Qtd as est5, e6.Qtd as est6,
          cj1.Custo as custo1, cj2.Custo as custo2, cj3.Custo as custo3,
          cj4.Custo as custo4, cj5.Custo as custo5, cj6.Custo as custo6,
          gs.Descricao as subgrupo, g.Descricao as grupo
        FROM central.itens i
        LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
        LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
        LEFT JOIN central.estoquen1 e1 ON e1.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen2 e2 ON e2.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen3 e3 ON e3.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen4 e4 ON e4.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen5 e5 ON e5.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen6 e6 ON e6.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja1 cj1 ON cj1.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja2 cj2 ON cj2.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja3 cj3 ON cj3.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja4 cj4 ON cj4.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja5 cj5 ON cj5.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja6 cj6 ON cj6.CodigoBarra = i.CodigoBarra
        ${filtro}
        ORDER BY i.Descricao
        LIMIT ? OFFSET ?
      `, [...params, parseInt(limite), offset]);

      return res.json({
        total: total.cnt,
        pagina: parseInt(pagina),
        paginas: Math.ceil(total.cnt / parseInt(limite)),
        loja: 'todas',
        data: rows.map(r => {
          const lojas = [1,2,3,4,5,6].map(n => {
            const preco = parsePreco(r['P'+n]);
            const custo = parsePreco(r['custo'+n]);
            const margem = custo > 0 ? parseFloat(((preco - custo) / custo * 100).toFixed(2)) : 0;
            return { preco, custo, margem, estoque: parseFloat(r['est'+n] || 0) };
          });
          return {
            codigo: r.nInterno, codigoBarra: r.CodigoBarra,
            descricao: r.Descricao?.trim(), lojas,
            ativo: r.CodDesativado === 0, unidade: r.Unid?.trim(),
            marca: r.Marca?.trim(), subgrupo: r.subgrupo?.trim(), grupo: r.grupo?.trim()
          };
        })
      });
    }

    const rows = await q(`
      SELECT
        i.nInterno, i.CodigoBarra, i.Descricao, i.Abreviacao,
        i.CodDesativado, i.Unid, i.Marca,
        i.P${ln} as preco_loja,
        e.Qtd as estoque_qtd,
        cj.Custo as custo_compra,
        cj.UltimaCompra as ultima_compra,
        gs.Descricao as subgrupo, g.Descricao as grupo
      FROM central.itens i
      LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
      LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
      LEFT JOIN central.estoquen${ln} e ON e.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.custoloja${ln} cj ON cj.CodigoBarra = i.CodigoBarra
      ${filtro}
      ORDER BY i.Descricao
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limite), offset]);

    res.json({
      total: total.cnt,
      pagina: parseInt(pagina),
      paginas: Math.ceil(total.cnt / parseInt(limite)),
      loja: ln,
      data: rows.map(r => {
        const preco = parsePreco(r.preco_loja);
        const custo = parsePreco(r.custo_compra);
        const margem = custo > 0 ? parseFloat(((preco - custo) / custo * 100).toFixed(2)) : 0;
        return {
          codigo: r.nInterno,
          codigoBarra: r.CodigoBarra,
          descricao: r.Descricao?.trim(),
          preco,
          custo,
          ultimaCompra: r.ultima_compra ? new Date(r.ultima_compra).toLocaleDateString('pt-BR') : null,
          estoque: parseFloat(r.estoque_qtd || 0),
          ativo: r.CodDesativado === 0,
          unidade: r.Unid?.trim(),
          marca: r.Marca?.trim(),
          margem,
          subgrupo: r.subgrupo?.trim(),
          grupo: r.grupo?.trim()
        };
      })
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Faturamento por loja e por mês (para gráfico no dashboard)
app.get('/api/faturamento-lojas', async (req, res) => {
  try {
    const ano = new Date().getFullYear();
    const rows = await q(
      'SELECT nLoja, Mes, SUM(Total) as total FROM dashboard.vendas WHERE Ano=? GROUP BY nLoja, Mes ORDER BY nLoja, Mes',
      [ano]
    );
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const lojas = [1,2,3,4,5,6];
    const porMes = {};
    for (const r of rows) {
      const m = meses[r.Mes - 1];
      if (!porMes[m]) porMes[m] = {};
      porMes[m][r.nLoja] = parseFloat(r.total);
    }
    const mesesComDados = [...new Set(rows.map(r => meses[r.Mes - 1]))];
    res.json({ meses: mesesComDados, lojas, dados: porMes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MÓDULO FORNECEDORES
// ═══════════════════════════════════════════════════

// Cache compartilhado de fornecedoritens (independe de loja)
let _fornecItensCache = null, _fornecItensCacheTs = 0;
async function getFornecItens() {
  if (_fornecItensCache && Date.now() - _fornecItensCacheTs < 15 * 60 * 1000) return _fornecItensCache;
  _fornecItensCache = await q(`
    SELECT fi.CodFornecedor, fi.CodigoBarra
    FROM central.fornecedoritens fi
    INNER JOIN central.itens it ON it.CodigoBarra = fi.CodigoBarra AND it.CodDesativado = 0
    WHERE fi.Backup = 0
  `).catch(() => []);
  _fornecItensCacheTs = Date.now();
  return _fornecItensCache;
}

// Resumo geral por fornecedor (deve vir ANTES de /:id)
const _resumoCache = {}, _resumoCacheTs = {};
const RESUMO_TTL = 30 * 60 * 1000;

app.get('/api/fornecedores/resumo', async (req, res) => {
  try {
    const hoje = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const busca   = req.query.busca || '';
    const compradorSel = req.query.comprador || '';
    const mm       = mesDB(mesSel);
    const dIni     = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim     = dFimMes(anoSel, mesSel);

    // Cache por loja+mes+ano (quando não há busca/comprador)
    const cacheKey = `${lojaSel}-${mesSel}-${anoSel}`;
    if (!busca && !compradorSel && _resumoCache[cacheKey] && (Date.now() - _resumoCacheTs[cacheKey]) < RESUMO_TTL) {
      return res.json(_resumoCache[cacheKey]);
    }

    // Todas as queries em paralelo
    let wf = 'WHERE CodDesativado=0', pf = [];
    if (busca) { wf += ' AND (Nome LIKE ? OR NomeCompleto LIKE ?)'; pf.push(`%${busca}%`, `%${busca}%`); }

    const [vendasRows, fornecItensRaw, custoLojaRows, avariaRows, avariaStatusRows, compradorRows, fornecs] = await Promise.all([
      q(`SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor, SUM(Custo) as custo_total
         FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [dIni, dFim]).catch(() => []),
      getFornecItens(),
      q(`SELECT CodigoBarra, Custo FROM central.custoloja${lojaSel} WHERE Custo > 0`).catch(() => []),
      q(`SELECT a.CodFornec, SUM(a.Total) as total, COUNT(*) as qtd
         FROM central.avariaconsumo a
         INNER JOIN central.fornecedoritens fi ON fi.CodigoBarra = a.CodigoBarras AND fi.CodFornecedor = a.CodFornec AND fi.Backup = 0
         WHERE a.nLoja=? AND a.DataLan BETWEEN ? AND ? AND a.CodFornec>0
         GROUP BY a.CodFornec`, [lojaSel, dIni, dFim]).catch(() => []),
      q(`SELECT SUM(CASE WHEN Status=0 THEN Total ELSE 0 END) as em_aberto,
                SUM(CASE WHEN Status=2 THEN Total ELSE 0 END) as em_tramite,
                SUM(CASE WHEN Status IN (3,4) THEN Total ELSE 0 END) as ja_emitido,
                SUM(Total) as total_geral
         FROM central.avariaconsumo WHERE nLoja=? AND DataLan BETWEEN ? AND ?`,
        [lojaSel, dIni, dFim]).catch(() => [{}]),
      (async () => {
        const allNRegs = Object.values(NREGS_COMPRADOR).flat();
        if (!allNRegs.length) return [];
        const ph = allNRegs.map(() => '?').join(',');
        return q(`SELECT nReg, CodFornec FROM central.c_cotacao_lista WHERE nReg IN (${ph})`, allNRegs).catch(() => []);
      })(),
      q(`SELECT CodFornec, Nome, NomeCompleto FROM central.fornecedor ${wf}`, pf).catch(() => [])
    ]);

    // Monta prodRows: fornecItens + custo da loja em memória
    const custoLojaMap = {};
    for (const r of custoLojaRows) custoLojaMap[r.CodigoBarra] = parseFloat(r.Custo) || 0;
    const prodRows = fornecItensRaw.map(fi => ({ CodFornecedor: fi.CodFornecedor, CodigoBarra: fi.CodigoBarra, Custo: custoLojaMap[fi.CodigoBarra] || 0 }));

    // Processa vendas
    let vendasMap = {}, totalLojaReal = 0, totalCustoLoja = 0;
    for (const r of vendasRows) {
      const v = parseFloat(r.valor), ct = parseFloat(r.custo_total || 0);
      vendasMap[r.Codigo] = { qtd: parseFloat(r.qtd), valor: v, custo: ct };
      totalLojaReal += v; totalCustoLoja += ct;
    }

    // Avaria
    const avariaMap = {};
    for (const r of avariaRows) avariaMap[r.CodFornec] = { total: parseFloat(r.total), qtd: parseInt(r.qtd) };
    const avSt = avariaStatusRows[0] || {};
    const avariaBreakdown = {
      em_aberto:  +parseFloat(avSt.em_aberto  || 0).toFixed(2),
      em_tramite: +parseFloat(avSt.em_tramite || 0).toFixed(2),
      ja_emitido: +parseFloat(avSt.ja_emitido || 0).toFixed(2),
      total:      +parseFloat(avSt.total_geral || 0).toFixed(2)
    };

    // Agrupa por fornecedor em memória
    const codsComFornec = new Set(prodRows.map(p => p.CodigoBarra));
    const totalComFornec = [...codsComFornec].reduce((s, cod) => s + (vendasMap[cod]?.valor || 0), 0);
    const margemReal = totalLojaReal > 0 ? +((totalLojaReal - totalCustoLoja) / totalLojaReal * 100).toFixed(2) : 0;

    let totalLucroReal = 0;
    for (const cod of codsComFornec) {
      const v = vendasMap[cod];
      if (v && v.valor > 0) totalLucroReal += v.valor - v.custo;
    }

    const fMap = {};
    for (const p of prodRows) {
      const fid = p.CodFornecedor;
      const v   = vendasMap[p.CodigoBarra] || { qtd: 0, valor: 0 };
      const cst = parsePreco(p.Custo);
      const cstTot = v.qtd * cst;
      if (!fMap[fid]) fMap[fid] = { venda: 0, custo: 0, lucro: 0, ativos: 0, comVenda: 0 };
      fMap[fid].ativos++;
      if (v.valor > 0) {
        fMap[fid].venda  += v.valor;
        fMap[fid].custo  += cstTot;
        fMap[fid].lucro  += v.valor - cstTot;
        fMap[fid].comVenda++;
      }
    }

    const _listaToComp = {};
    for (const [comp, nRegs] of Object.entries(NREGS_COMPRADOR)) {
      for (const nReg of nRegs) _listaToComp[nReg] = comp;
    }
    const compradorMap = {};
    for (const r of compradorRows) {
      const comp = _listaToComp[r.nReg];
      if (comp) compradorMap[r.CodFornec] = comp;
    }
    const todosCompradores = Object.keys(NREGS_COMPRADOR).sort();

    let result = fornecs
      .filter(f => fMap[f.CodFornec] || avariaMap[f.CodFornec])
      .map(f => {
        const m  = fMap[f.CodFornec]  || { venda: 0, custo: 0, lucro: 0, ativos: 0, comVenda: 0 };
        const av = avariaMap[f.CodFornec] || { total: 0, qtd: 0 };
        return {
          id:         f.CodFornec,
          nome:       (f.Nome || f.NomeCompleto || '').trim(),
          comprador:  compradorMap[f.CodFornec] || '',
          venda:      +m.venda.toFixed(2),
          custo:      +m.custo.toFixed(2),
          lucro:      +m.lucro.toFixed(2),
          msv:        m.venda > 0  ? +(m.lucro / m.venda  * 100).toFixed(2) : 0,
          msc:        m.custo > 0  ? +(m.lucro / m.custo  * 100).toFixed(2) : 0,
          avaria:     +av.total.toFixed(2),
          qtd_avaria: av.qtd,
          ativos:     m.ativos,
          com_venda:  m.comVenda,
          pct_av:     m.venda > 0  ? +(av.total / m.venda * 100).toFixed(2) : 0
        };
      })
      .sort((a, b) => b.venda - a.venda);

    if (compradorSel) {
      result = result.filter(r => r.comprador && r.comprador.split(', ').includes(compradorSel));
    }

    const margemFornec = totalComFornec > 0 ? +(totalLucroReal / totalComFornec * 100).toFixed(2) : 0;
    const payload = { total_loja: +totalLojaReal.toFixed(2), total_com_fornecedor: +totalComFornec.toFixed(2), total_lucro_real: +totalLucroReal.toFixed(2), margem_loja: margemReal, margem_fornec: margemFornec, avaria_breakdown: avariaBreakdown, fornecedores: result, compradores: todosCompradores };
    if (!busca && !compradorSel) { _resumoCache[cacheKey] = payload; _resumoCacheTs[cacheKey] = Date.now(); }
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Compras por comprador — fonte de verdade: NREGS_COMPRADOR (Excel), não o ERP
app.get('/api/fornecedores/compras-resumo', async (req, res) => {
  try {
    const loja = parseInt(req.query.loja) || 1;
    const mes  = parseInt(req.query.mes)  || new Date().getMonth() + 1;
    const ano  = parseInt(req.query.ano)  || new Date().getFullYear();

    // Todas as listas do Excel (sem filtro de loja — o Excel define comprador, não a loja)
    const allExcelNRegs = Object.values(NREGS_COMPRADOR).flat();
    const excelPh = allExcelNRegs.map(() => '?').join(',');

    const [comprasRows, listasRows, vendaRows, dashComprasRows, diasRows] = await Promise.all([
      q(`SELECT c.CodFornec, c.NomeFornec as fornecedor_nome,
               COUNT(*) as qtd_nfs, SUM(c.TotalNota) as total
         FROM central.compras c
         WHERE c.nLoja = ? AND MONTH(c.DataRecto) = ? AND YEAR(c.DataRecto) = ?
           AND c.Movimentacao = 'COMPRA' AND c.Tipo = 'PNF' AND c.Status = 'F'
           AND c.CodFornec > 0
         GROUP BY c.CodFornec, c.NomeFornec
         ORDER BY total DESC`, [loja, mes, ano]),
      q(`SELECT nReg as lista_id, CodFornec FROM central.c_cotacao_lista WHERE nReg IN (${excelPh})`, allExcelNRegs),
      q(`SELECT COALESCE(SUM(Total), 0) as total FROM dashboard.vendas WHERE nLoja=? AND Mes=? AND Ano=?`, [loja, mes, ano]),
      q(`SELECT COALESCE(SUM(Total), 0) as total FROM dashboard.compras WHERE nLoja=? AND Mes=? AND Ano=?`, [loja, mes, ano]),
      q(`SELECT DATE(DataRecto) as dia, SUM(TotalNota) as total
         FROM central.compras
         WHERE nLoja=? AND MONTH(DataRecto)=? AND YEAR(DataRecto)=?
           AND Movimentacao='COMPRA' AND Tipo='PNF' AND Status='F' AND CodFornec > 0
         GROUP BY DATE(DataRecto) ORDER BY dia ASC`, [loja, mes, ano])
    ]);

    // Mapa invertido lista → comprador (via Excel)
    const listaToComp = {};
    for (const [comp, nRegs] of Object.entries(NREGS_COMPRADOR)) {
      for (const nReg of nRegs) listaToComp[nReg] = comp;
    }

    // Por codFornec: qual comprador + quais listas desse comprador
    const codFornecToComp = {};
    const fornecListaByComp = {};
    const fornecTemLista = {};

    for (const l of listasRows) {
      const comp = listaToComp[l.lista_id];
      fornecTemLista[l.CodFornec] = true; // tem lista em qualquer comprador
      if (comp) {
        codFornecToComp[l.CodFornec] = comp;
        if (!fornecListaByComp[l.CodFornec]) fornecListaByComp[l.CodFornec] = {};
        if (!fornecListaByComp[l.CodFornec][comp]) fornecListaByComp[l.CodFornec][comp] = new Set();
        fornecListaByComp[l.CodFornec][comp].add(l.lista_id);
      }
    }

    // Agrupar por comprador
    const porComprador = {};
    let totalGeral = 0;
    for (const r of comprasRows) {
      const comp = codFornecToComp[r.CodFornec] || 'SEM COMPRADOR';
      const tot  = parseFloat(r.total || 0);
      totalGeral += tot;
      if (!porComprador[comp]) porComprador[comp] = { comprador: comp, total: 0, fornecedores: [] };
      porComprador[comp].total += tot;
      const listasComp = (fornecListaByComp[r.CodFornec] && fornecListaByComp[r.CodFornec][comp])
        ? [...fornecListaByComp[r.CodFornec][comp]]
        : [];
      porComprador[comp].fornecedores.push({
        id: r.CodFornec,
        nome: (r.fornecedor_nome || '').trim(),
        total: +tot.toFixed(2),
        qtd_nfs: parseInt(r.qtd_nfs),
        listas: listasComp,
        temLista: fornecTemLista[r.CodFornec] || false
      });
    }

    const lista = Object.values(porComprador)
      .map(c => ({ ...c, total: +c.total.toFixed(2), pct: totalGeral > 0 ? +(c.total / totalGeral * 100).toFixed(1) : 0 }))
      .sort((a, b) => {
        if (a.comprador === 'SEM COMPRADOR') return 1;
        if (b.comprador === 'SEM COMPRADOR') return -1;
        return b.total - a.total;
      });

    const totalVenda = parseFloat(vendaRows[0]?.total || 0);

    // Calcular até que data o dashboard.compras (e dashboard.vendas) foi sincronizado
    const dashComprasTotal = parseFloat(dashComprasRows[0]?.total || 0);
    let ultimaSincData = null;
    let acumulado = 0;
    for (const dia of diasRows) {
      acumulado += parseFloat(dia.total || 0);
      if (acumulado <= dashComprasTotal + 5) { // tolerância de R$5 para arredondamento
        ultimaSincData = dia.dia;
      } else break;
    }
    let vendaHorasAtraso = null;
    if (ultimaSincData) {
      const fimDia = new Date(ultimaSincData);
      fimDia.setHours(23, 59, 59, 999);
      vendaHorasAtraso = Math.floor((Date.now() - fimDia.getTime()) / 3600000);
    }

    res.json({ total: +totalGeral.toFixed(2), total_venda: +totalVenda.toFixed(2), venda_horas_atraso: vendaHorasAtraso, ultima_sinc: ultimaSincData, por_comprador: lista });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Produtos de um fornecedor via NFs reais de entrada (axmlprodutos)
app.get('/api/fornecedores/compras-produtos', async (req, res) => {
  try {
    const codFornec = parseInt(req.query.codFornec);
    const loja = parseInt(req.query.loja) || 1;
    const mes  = parseInt(req.query.mes)  || new Date().getMonth() + 1;
    const ano  = parseInt(req.query.ano)  || new Date().getFullYear();
    if (!codFornec) return res.json({ produtos: [], nfs: 0 });

    // Busca itens via axmlprodutos, ligado por CNPJ+nNota+Serie da compras
    const itens = await q(`
      SELECT ap.CodigoBarras, ap.Descricao, ap.Und,
             SUM(ap.Qtd) as Qtd,
             SUM(CAST(REPLACE(ap.ValorTotal,',','.') AS DECIMAL(12,2))) as Total,
             COUNT(DISTINCT c.nReg) as qtd_nfs
      FROM central.compras c
      INNER JOIN central.axmlprodutos ap
        ON ap.CNPJemit = c.CNPJ
        AND ap.nNota   = CAST(c.nNota AS DECIMAL(12,0))
        AND ap.nSerie  = c.Serie
      WHERE c.CodFornec = ? AND c.nLoja = ?
        AND MONTH(c.DataRecto) = ? AND YEAR(c.DataRecto) = ?
        AND c.Movimentacao = 'COMPRA' AND c.Tipo = 'PNF' AND c.Status = 'F'
      GROUP BY ap.CodigoBarras, ap.Descricao, ap.Und
      ORDER BY ap.Descricao
    `, [codFornec, loja, mes, ano]);

    // Lista das NFs do período para exibir ao clicar
    const nfsList = await q(`
      SELECT nNota, Serie, DataRecto, TotalNota FROM central.compras
      WHERE CodFornec = ? AND nLoja = ? AND MONTH(DataRecto) = ? AND YEAR(DataRecto) = ?
        AND Movimentacao = 'COMPRA' AND Tipo = 'PNF' AND Status = 'F'
      ORDER BY DataRecto DESC
    `, [codFornec, loja, mes, ano]);

    const produtos = itens.map(p => ({
      CodigoBarra: p.CodigoBarras,
      Descricao: (p.Descricao || '').trim(),
      Qtd: +parseFloat(p.Qtd || 0).toFixed(3),
      Total: +parseFloat(p.Total || 0).toFixed(2),
      Unid: p.Und || ''
    }));

    res.json({ produtos, nfs: nfsList.length, nfsList });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cache de itens mercadológico (muda raramente)
let _itensCache = null, _itensCacheTs = 0;
async function getItensGrupo() {
  if (_itensCache && Date.now() - _itensCacheTs < 10*60*1000) return _itensCache;
  _itensCache = await q(`SELECT i.CodigoBarra, g.CodGrupo, g.Descricao as grupo_nome
     FROM central.itens i
     INNER JOIN central.gruposub gs ON gs.CodSubGrupo=i.CodGrupoSub AND gs.CodDesativado=0
     INNER JOIN central.grupo g ON g.CodGrupo=gs.CodGrupo
     WHERE i.CodDesativado=0 AND i.CodGrupoSub>0`).catch(()=>[]);
  _itensCacheTs = Date.now();
  return _itensCache;
}

// Comparativo TV: dados combinados (diário + mercadológico) para uma loja — mês atual
app.get('/api/comparativo-tv', withCache(120), async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = hoje.getMonth() + 1;
    const diaAtual= hoje.getDate();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const mm      = mesDB(mesSel);

    const mesesNomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const [diasRows, prod25p, prod26, itens, ...mensalRows] = await Promise.all([
      q(`SELECT DAY(Data) as dia, YEAR(Data) as ano, SUM(ValorTotalNovo) as valor
         FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE MONTH(Data)=? AND YEAR(Data) IN (2025,2026) AND IndCancel='N'
         GROUP BY dia, ano ORDER BY dia`, [mesSel]).catch(()=>[]),
      q(`SELECT Codigo, SUM(ValorTotalNovo) as valor FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE YEAR(Data)=2025 AND MONTH(Data)=? AND DAY(Data)<=? AND IndCancel='N' GROUP BY Codigo`, [mesSel, diaAtual]).catch(()=>[]),
      q(`SELECT Codigo, SUM(ValorTotalNovo) as valor FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE YEAR(Data)=2026 AND MONTH(Data)=? AND IndCancel='N' GROUP BY Codigo`, [mesSel]).catch(()=>[]),
      getItensGrupo(),
      ...[1,2,3,4,5,6,7,8,9,10,11,12].map(m =>
        q(`SELECT YEAR(Data) as ano, SUM(ValorTotalNovo) as valor
           FROM \`ln${lojaSel}mes${String(m).padStart(2,'0')}\`.zcupomitens
           WHERE YEAR(Data) IN (2025,2026) AND IndCancel='N' GROUP BY ano`, []).catch(()=>[])
      )
    ]);

    // Diário
    const v25d = {}, v26d = {};
    for (const r of diasRows) {
      if (r.ano==2025) v25d[r.dia] = parseFloat(r.valor);
      if (r.ano==2026) v26d[r.dia] = parseFloat(r.valor);
    }
    const ultimoDia = new Date(2026, mesSel, 0).getDate();
    const dias = [];
    for (let d=1; d<=ultimoDia; d++) {
      const a=v25d[d]||0, b=v26d[d]||0;
      if (a>0||b>0) dias.push({ dia:d, v2025:+a.toFixed(2), v2026:+b.toFixed(2),
        var: a>0?+((b-a)/a*100).toFixed(1):null });
    }
    const tot25  = dias.reduce((s,d)=>s+d.v2025,0);
    const tot26  = dias.reduce((s,d)=>s+d.v2026,0);
    const tot25p = dias.filter(d=>d.dia<=diaAtual).reduce((s,d)=>s+d.v2025,0);

    // Mercadológico por grupo (2025 até dia atual vs 2026 até hoje)
    const pv25={}, pv26={};
    for (const r of prod25p) pv25[r.Codigo]=parseFloat(r.valor);
    for (const r of prod26) pv26[r.Codigo]=parseFloat(r.valor);
    const gMap={};
    for (const it of itens) {
      const a=pv25[it.CodigoBarra]||0, b=pv26[it.CodigoBarra]||0;
      if (!a&&!b) continue;
      const k=it.CodGrupo;
      if (!gMap[k]) gMap[k]={ nome:it.grupo_nome?.trim()||'—', v2025:0, v2026:0 };
      gMap[k].v2025+=a; gMap[k].v2026+=b;
    }
    const grupos = Object.values(gMap)
      .filter(g=>g.v2025>0||g.v2026>0)
      .map(g=>({ nome:g.nome, v2025:+g.v2025.toFixed(2), v2026:+g.v2026.toFixed(2),
        var:g.v2025>0?+((g.v2026-g.v2025)/g.v2025*100).toFixed(1):null }))
      .sort((a,b)=>b.v2026-a.v2026||b.v2025-a.v2025);

    // Mensal
    const mensal = mensalRows.map((rows, i) => {
      let v25=0, v26=0;
      for (const r of rows) { if(r.ano==2025) v25=parseFloat(r.valor); if(r.ano==2026) v26=parseFloat(r.valor); }
      return { mes:i+1, nome:mesesNomes[i], v2025:+v25.toFixed(2), v2026:+v26.toFixed(2),
        var: v25>0?+((v26-v25)/v25*100).toFixed(1):null };
    });

    res.json({ loja:lojaSel, mes:mesSel, dia_atual:diaAtual,
      total2025:+tot25.toFixed(2), total2026:+tot26.toFixed(2),
      total2025_periodo:+tot25p.toFixed(2),
      var_pct: tot25>0?+((tot26-tot25)/tot25*100).toFixed(1):null,
      var_periodo: tot25p>0?+((tot26-tot25p)/tot25p*100).toFixed(1):null,
      dias, grupos, mensal });
  } catch(err) { console.error('[comparativo-tv]', err); res.status(500).json({ error: err.message }); }
});

// Comparativo diário: vendas dia-a-dia 2025 vs 2026 para o mês selecionado
app.get('/api/comparativo-diario', withCache(60), async (req, res) => {
  try {
    const hoje   = new Date();
    const mesSel = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const lojaSel= req.query.loja ? parseInt(req.query.loja) : 1;
    const mm     = mesDB(mesSel);

    const rows = await q(`
      SELECT DAY(Data) as dia, YEAR(Data) as ano,
             SUM(ValorTotalNovo) as valor,
             COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons
      FROM \`ln${lojaSel}${mm}\`.zcupomitens
      WHERE MONTH(Data)=? AND YEAR(Data) IN (2025,2026) AND IndCancel='N'
      GROUP BY dia, ano ORDER BY dia, ano
    `, [mesSel]).catch(() => []);

    const v25 = {}, v26 = {}, c25 = {}, c26 = {};
    for (const r of rows) {
      if (r.ano == 2025) { v25[r.dia] = parseFloat(r.valor); c25[r.dia] = parseInt(r.cupons); }
      if (r.ano == 2026) { v26[r.dia] = parseFloat(r.valor); c26[r.dia] = parseInt(r.cupons); }
    }

    const ultimoDia = new Date(2026, mesSel, 0).getDate();
    const dias = [];
    for (let d = 1; d <= ultimoDia; d++) {
      const a = v25[d] || 0, b = v26[d] || 0;
      dias.push({ dia: d, v2025: +a.toFixed(2), v2026: +b.toFixed(2),
        c2025: c25[d] || 0, c2026: c26[d] || 0,
        var: a > 0 ? +((b - a) / a * 100).toFixed(1) : null });
    }

    const tot25 = dias.reduce((s,d) => s + d.v2025, 0);
    const tot26 = dias.reduce((s,d) => s + d.v2026, 0);
    res.json({ dias, total2025: +tot25.toFixed(2), total2026: +tot26.toFixed(2),
      var_pct: tot25 > 0 ? +((tot26 - tot25) / tot25 * 100).toFixed(1) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Comparativo por mercadológico (grupo + subgrupo): 2025 vs 2026 para loja+mês
app.get('/api/comparativo-mercadologico', withCache(240), async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const mm      = mesDB(mesSel);

    const [rows25, rows26, itens] = await Promise.all([
      q(`SELECT Codigo, SUM(ValorTotalNovo) as valor FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE YEAR(Data)=2025 AND MONTH(Data)=? AND IndCancel='N' GROUP BY Codigo`, [mesSel]).catch(()=>[]),
      q(`SELECT Codigo, SUM(ValorTotalNovo) as valor FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE YEAR(Data)=2026 AND MONTH(Data)=? AND IndCancel='N' GROUP BY Codigo`, [mesSel]).catch(()=>[]),
      q(`SELECT i.CodigoBarra, i.CodGrupoSub, gs.Descricao as sub_nome,
                g.CodGrupo, g.Descricao as grupo_nome,
                i.CodGrupoMarca, gm.Descricao as merc_nome
         FROM central.itens i
         INNER JOIN central.gruposub gs ON gs.CodSubGrupo=i.CodGrupoSub AND gs.CodDesativado=0
         INNER JOIN central.grupo g ON g.CodGrupo=gs.CodGrupo
         LEFT JOIN central.grupomarca gm ON gm.CodMarca=i.CodGrupoMarca
         WHERE i.CodDesativado=0 AND i.CodGrupoSub>0`).catch(()=>[])
    ]);

    const v25 = {}, v26 = {};
    for (const r of rows25) v25[r.Codigo] = parseFloat(r.valor);
    for (const r of rows26) v26[r.Codigo] = parseFloat(r.valor);

    // Agrupa por grupo → subgrupo → mercadológico
    const gMap = {};
    for (const it of itens) {
      const a = v25[it.CodigoBarra] || 0, b = v26[it.CodigoBarra] || 0;
      if (!a && !b) continue;
      const gk = it.CodGrupo, sk = it.CodGrupoSub, mk = it.CodGrupoMarca || 0;
      if (!gMap[gk]) gMap[gk] = { nome: it.grupo_nome?.trim()||'—', v2025:0, v2026:0, subs:{} };
      gMap[gk].v2025 += a; gMap[gk].v2026 += b;
      if (!gMap[gk].subs[sk]) gMap[gk].subs[sk] = { nome: it.sub_nome?.trim()||'—', v2025:0, v2026:0, mercs:{} };
      gMap[gk].subs[sk].v2025 += a; gMap[gk].subs[sk].v2026 += b;
      if (!gMap[gk].subs[sk].mercs[mk]) gMap[gk].subs[sk].mercs[mk] = { nome: it.merc_nome?.trim()||'Sem mercadológico', v2025:0, v2026:0 };
      gMap[gk].subs[sk].mercs[mk].v2025 += a; gMap[gk].subs[sk].mercs[mk].v2026 += b;
    }

    const sort26 = (a,b) => b.v2026-a.v2026 || b.v2025-a.v2025;
    const mkVar  = m => m.v2025>0 ? +((m.v2026-m.v2025)/m.v2025*100).toFixed(1) : null;

    const grupos = Object.values(gMap)
      .filter(g => g.v2025>0 || g.v2026>0)
      .map(g => ({
        nome: g.nome,
        v2025: +g.v2025.toFixed(2), v2026: +g.v2026.toFixed(2), var: mkVar(g),
        subs: Object.values(g.subs)
          .filter(s => s.v2025>0 || s.v2026>0)
          .map(s => ({
            nome: s.nome,
            v2025: +s.v2025.toFixed(2), v2026: +s.v2026.toFixed(2), var: mkVar(s),
            mercs: Object.values(s.mercs)
              .filter(m => m.v2025>0 || m.v2026>0)
              .map(m => ({ nome:m.nome, v2025:+m.v2025.toFixed(2), v2026:+m.v2026.toFixed(2), var:mkVar(m) }))
              .sort(sort26)
          }))
          .sort(sort26)
      }))
      .sort(sort26);

    const tot25 = grupos.reduce((s,g)=>s+g.v2025, 0);
    const tot26 = grupos.reduce((s,g)=>s+g.v2026, 0);
    res.json({ grupos, total2025: +tot25.toFixed(2), total2026: +tot26.toFixed(2),
      var_pct: tot25>0 ? +((tot26-tot25)/tot25*100).toFixed(1) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GESTÃO GERENCIAL ──────────────────────────────────────────
app.get('/api/gestao-gerencial', withCache(10), async (req, res) => {
  try {
    const hoje    = new Date();
    const ano     = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const mes     = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas   = lojaSel ? [lojaSel] : [1,2,3,4,5,6];
    const anoAnt  = ano - 1;
    const mm      = mesDB(mes);
    const mesStr  = String(mes).padStart(2,'0');
    const ehMesAtual = (ano === hoje.getFullYear() && mes === hoje.getMonth() + 1);
    const diaCorte   = ehMesAtual ? String(hoje.getDate()).padStart(2,'0') : String(new Date(ano,mes,0).getDate()).padStart(2,'0');
    const dIni       = `${ano}-${mesStr}-01`;
    const dFimAtual  = `${ano}-${mesStr}-${diaCorte}`;
    const dIniAnt    = `${anoAnt}-${mesStr}-01`;
    const dFimAnt    = `${anoAnt}-${mesStr}-${diaCorte}`;

    // Vendas por Codigo — atual e ano anterior até mesmo dia
    const vAtual = {}, vAnt = {};
    await Promise.all(lojas.map(async ln => {
      const [rA, rB] = await Promise.all([
        q(`SELECT Codigo, SUM(ValorTotalNovo) v FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [dIni, dFimAtual]).catch(()=>[]),
        q(`SELECT Codigo, SUM(ValorTotalNovo) v FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [dIniAnt, dFimAnt]).catch(()=>[])
      ]);
      for (const r of rA) vAtual[r.Codigo] = (vAtual[r.Codigo]||0) + parseFloat(r.v||0);
      for (const r of rB) vAnt[r.Codigo]   = (vAnt[r.Codigo]  ||0) + parseFloat(r.v||0);
    }));

    const totalAtual = Object.values(vAtual).reduce((s,v)=>s+v,0);
    const totalAnt   = Object.values(vAnt).reduce((s,v)=>s+v,0);
    const meta       = +(totalAnt * 1.05).toFixed(2);
    const cresc      = totalAnt > 0 ? +((totalAtual-totalAnt)/totalAnt*100).toFixed(1) : 0;
    const pctMeta    = meta > 0 ? +(totalAtual/meta*100).toFixed(1) : 0;
    const faltaMeta  = +(Math.max(meta-totalAtual,0)).toFixed(2);

    // Avaria do período
    const avParams  = lojaSel ? [dIni, dFimAtual, lojaSel] : [dIni, dFimAtual];
    const avWhere   = lojaSel ? 'AND nLoja=?' : '';
    const avRows    = await q(`SELECT CodigoBarras, SUM(Total) v FROM central.avariaconsumo WHERE DataLan BETWEEN ? AND ? AND Status IN (0,2) ${avWhere} GROUP BY CodigoBarras`, avParams).catch(()=>[]);
    const avAntRows = await q(`SELECT COALESCE(SUM(Total),0) v FROM central.avariaconsumo WHERE DataLan BETWEEN ? AND ? AND Status IN (0,2) ${avWhere}`, lojaSel ? [dIniAnt, dFimAnt, lojaSel] : [dIniAnt, dFimAnt]).catch(()=>[{}]);
    const avPorCod  = {};
    for (const r of avRows) avPorCod[r.CodigoBarras] = (avPorCod[r.CodigoBarras]||0) + parseFloat(r.v||0);
    const totalAvaria    = Object.values(avPorCod).reduce((s,v)=>s+v,0);
    const totalAvariaAnt = parseFloat(avAntRows[0]?.v||0);

    // Venda do dia — até o mesmo horário em ambos os anos
    const dHoje    = `${ano}-${mesStr}-${diaCorte}`;
    const dHojeAnt = `${anoAnt}-${mesStr}-${diaCorte}`;
    const horaAtual = String(hoje.getHours()).padStart(2,'0')+':'+String(hoje.getMinutes()).padStart(2,'0')+':59';
    let vDia=0, vDiaAnt=0;
    await Promise.all(lojas.map(async ln => {
      const [[rA],[rB]] = await Promise.all([
        q(`SELECT SUM(ValorTotalNovo) v FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data=? AND Hora<=? AND IndCancel='N'`,[dHoje,horaAtual]).catch(()=>[{v:0}]),
        q(`SELECT SUM(ValorTotalNovo) v FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data=? AND Hora<=? AND IndCancel='N'`,[dHojeAnt,horaAtual]).catch(()=>[{v:0}])
      ]);
      vDia+=parseFloat(rA?.v||0); vDiaAnt+=parseFloat(rB?.v||0);
    }));
    const vDiaCrsc = vDiaAnt>0?+((vDia-vDiaAnt)/vDiaAnt*100).toFixed(1):0;

    // Items → grupo
    const itens = await q(
      `SELECT i.CodigoBarra, g.CodGrupo, g.Descricao as gNome
       FROM central.itens i
       INNER JOIN central.gruposub gs ON gs.CodSubGrupo=i.CodGrupoSub AND gs.CodDesativado=0
       INNER JOIN central.grupo g ON g.CodGrupo=gs.CodGrupo
       WHERE i.CodDesativado=0 AND i.CodGrupoSub>0`
    ).catch(()=>[]);

    // Venda por grupo
    const gV = {};
    for (const it of itens) {
      const a=vAtual[it.CodigoBarra]||0, b=vAnt[it.CodigoBarra]||0;
      if (!a && !b) continue;
      if (!gV[it.CodGrupo]) gV[it.CodGrupo]={nome:it.gNome?.trim()||'—',a:0,b:0};
      gV[it.CodGrupo].a+=a; gV[it.CodGrupo].b+=b;
    }
    const grupos = Object.values(gV).filter(g=>g.a||g.b).map(g=>({
      nome:g.nome, venda_atual:+g.a.toFixed(2), venda_ant:+g.b.toFixed(2),
      dif_r:+(g.a-g.b).toFixed(2),
      dif_pct:g.b>0?+((g.a-g.b)/g.b*100).toFixed(1):null,
      participacao:totalAtual>0?+(g.a/totalAtual*100).toFixed(1):0
    })).sort((a,b)=>b.venda_atual-a.venda_atual);

    // Avaria por grupo
    const gA = {};
    for (const it of itens) {
      const av=avPorCod[it.CodigoBarra]||0; if(!av) continue;
      if (!gA[it.CodGrupo]) gA[it.CodGrupo]={nome:it.gNome?.trim()||'—',av:0};
      gA[it.CodGrupo].av+=av;
    }
    const totAv = Object.values(gA).reduce((s,g)=>s+g.av,0);
    const gruposAvaria = Object.values(gA).filter(g=>g.av>0).map(g=>({
      nome:g.nome, avaria:+g.av.toFixed(2),
      pct_venda:totalAtual>0?+(g.av/totalAtual*100).toFixed(2):0,
      participacao:totAv>0?+(g.av/totAv*100).toFixed(1):0
    })).sort((a,b)=>b.avaria-a.avaria);

    // Ticket médio por mês (Jan → mês selecionado), respeitando filtro de loja
    const lojasTicket = lojaSel ? [lojaSel] : [1,2,3,4,5,6];
    const ticketMeses = await Promise.all(
      Array.from({length: mes}, (_, i) => i + 1).map(async m => {
        const mmM = mesDB(m);
        const msStr = String(m).padStart(2,'0');
        const ehAtual = (m === mes && ehMesAtual);
        const corte    = ehAtual ? diaCorte : String(new Date(ano,m,0).getDate()).padStart(2,'0');
        const corteAnt = ehAtual ? diaCorte : String(new Date(anoAnt,m,0).getDate()).padStart(2,'0');
        const dI=`${ano}-${msStr}-01`,    dF=`${ano}-${msStr}-${corte}`;
        const dIA=`${anoAnt}-${msStr}-01`, dFA=`${anoAnt}-${msStr}-${corteAnt}`;
        let cupons=0, venda=0, cuponsAnt=0, vendaAnt=0;
        await Promise.all(lojasTicket.map(async ln => {
          const [[rA],[rB]] = await Promise.all([
            q(`SELECT COUNT(DISTINCT CONCAT(nECF,'-',CCF)) cupons, SUM(ValorTotalNovo) venda FROM \`ln${ln}${mmM}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,[dI,dF]).catch(()=>[{cupons:0,venda:0}]),
            q(`SELECT COUNT(DISTINCT CONCAT(nECF,'-',CCF)) cupons, SUM(ValorTotalNovo) venda FROM \`ln${ln}${mmM}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,[dIA,dFA]).catch(()=>[{cupons:0,venda:0}])
          ]);
          cupons+=parseInt(rA?.cupons||0); venda+=parseFloat(rA?.venda||0);
          cuponsAnt+=parseInt(rB?.cupons||0); vendaAnt+=parseFloat(rB?.venda||0);
        }));
        const ticket=cupons>0?+(venda/cupons).toFixed(2):0;
        const ticketAnt=cuponsAnt>0?+(vendaAnt/cuponsAnt).toFixed(2):0;
        return { mes:m, venda:+venda.toFixed(2), venda_ant:+vendaAnt.toFixed(2),
                 cupons, ticket, cupons_ant:cuponsAnt, ticket_ant:ticketAnt,
                 dif_pct:ticketAnt>0?+((ticket-ticketAnt)/ticketAnt*100).toFixed(1):null };
      })
    );

    // Venda por loja no período (sempre todas as 6)
    const vendaLojas = await Promise.all([1,2,3,4,5,6].map(async ln => {
      const [[rA],[rB]] = await Promise.all([
        q(`SELECT SUM(ValorTotalNovo) venda FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,[dIni,dFimAtual]).catch(()=>[{venda:0}]),
        q(`SELECT SUM(ValorTotalNovo) venda FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,[dIniAnt,dFimAnt]).catch(()=>[{venda:0}])
      ]);
      return { loja:ln, venda:+(parseFloat(rA?.venda||0)).toFixed(2), venda_ant:+(parseFloat(rB?.venda||0)).toFixed(2) };
    }));

    res.json({
      kpis:{ venda_atual:+totalAtual.toFixed(2), venda_ant:+totalAnt.toFixed(2), crescimento:cresc,
             meta, pct_meta:pctMeta, falta_meta:faltaMeta,
             avaria:+totalAvaria.toFixed(2), avaria_ant:+totalAvariaAnt.toFixed(2),
             avaria_pct:totalAtual>0?+(totalAvaria/totalAtual*100).toFixed(2):0 },
      venda_dia:{ atual:+vDia.toFixed(2), ant:+vDiaAnt.toFixed(2), crescimento:vDiaCrsc, dia:diaCorte },
      grupos, grupos_avaria:gruposAvaria, ticket_meses:ticketMeses, venda_lojas:vendaLojas,
      meta_info:{ dia_corte:diaCorte, mes, ano, ano_ant:anoAnt, loja:lojaSel||'todas' }
    });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// Top 10 produtos por faturamento e quantidade
app.get('/api/top-produtos', withCache(15), async (req, res) => {
  try {
    const hoje = new Date();
    const ano = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const mes = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas = lojaSel ? [lojaSel] : [1,2,3,4,5,6];
    const mm = mesDB(mes);
    const mesStr = String(mes).padStart(2,'0');
    const ehMesAtual = (ano === hoje.getFullYear() && mes === hoje.getMonth() + 1);
    const diaCorte = ehMesAtual ? String(hoje.getDate()).padStart(2,'0') : String(new Date(ano,mes,0).getDate()).padStart(2,'0');
    const dIni = `${ano}-${mesStr}-01`;
    const dFim = `${ano}-${mesStr}-${diaCorte}`;

    const vendaMap = {}, qtdMap = {}, descMap = {};
    await Promise.all(lojas.map(async ln => {
      const rows = await q(
        `SELECT Codigo, Descricao, SUM(ValorTotalNovo) as v, SUM(Qtd) as qtd
         FROM \`ln${ln}${mm}\`.zcupomitens
         WHERE Data BETWEEN ? AND ? AND IndCancel='N'
         GROUP BY Codigo, Descricao`,
        [dIni, dFim]
      ).catch(() => []);
      for (const r of rows) {
        const vv = parseFloat(r.v || 0);
        const qq = parseFloat(r.qtd || 0);
        vendaMap[r.Codigo] = (vendaMap[r.Codigo] || 0) + vv;
        qtdMap[r.Codigo]   = (qtdMap[r.Codigo]   || 0) + qq;
        if (!descMap[r.Codigo]) descMap[r.Codigo] = (r.Descricao || r.Codigo).trim();
      }
    }));

    const totalVenda = Object.values(vendaMap).reduce((s,v)=>s+v,0);
    const totalQtd   = Object.values(qtdMap).reduce((s,v)=>s+v,0);

    const topVenda = Object.entries(vendaMap)
      .map(([cod, v]) => ({ cod, desc: descMap[cod], v: +v.toFixed(2) }))
      .sort((a, b) => b.v - a.v).slice(0, 10);

    const topQtd = Object.entries(qtdMap)
      .map(([cod, q2]) => ({ cod, desc: descMap[cod], qtd: +q2.toFixed(0) }))
      .sort((a, b) => b.qtd - a.qtd).slice(0, 10);

    res.json({ top_venda: topVenda, top_qtd: topQtd, total_venda: +totalVenda.toFixed(2), total_qtd: +totalQtd.toFixed(0), meta: { mes, ano, loja: lojaSel || 'todas' } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Comparativo por lojas: todas as 6 lojas 2025 vs 2026 para um mês
app.get('/api/comparativo-lojas', withCache(120), async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const mm      = mesDB(mesSel);
    const lojas   = [1,2,3,4,5,6];

    const results = await Promise.all(lojas.map(ln =>
      q(`SELECT YEAR(Data) as ano, SUM(ValorTotalNovo) as valor,
                COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons
         FROM \`ln${ln}${mm}\`.zcupomitens
         WHERE MONTH(Data)=? AND YEAR(Data) IN (2025,2026) AND IndCancel='N'
         GROUP BY ano`, [mesSel]).catch(()=>[])
    ));

    const data = results.map((rows, i) => {
      let v25=0, v26=0, c25=0, c26=0;
      for (const r of rows) {
        if (r.ano==2025) { v25=parseFloat(r.valor); c25=parseInt(r.cupons); }
        if (r.ano==2026) { v26=parseFloat(r.valor); c26=parseInt(r.cupons); }
      }
      return { loja: i+1, v2025: +v25.toFixed(2), v2026: +v26.toFixed(2),
        c2025: c25, c2026: c26, var: v25>0 ? +((v26-v25)/v25*100).toFixed(1) : null };
    });

    const tot25 = data.reduce((s,d)=>s+d.v2025, 0);
    const tot26 = data.reduce((s,d)=>s+d.v2026, 0);
    res.json({ lojas: data, total2025: +tot25.toFixed(2), total2026: +tot26.toFixed(2),
      var_pct: tot25>0 ? +((tot26-tot25)/tot25*100).toFixed(1) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Margem sobre venda por loja e por mês — 2025 vs 2026
app.get('/api/margem-lojas', withCache(60), async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 0; // 0 = rede toda
    const lojas   = [1,2,3,4,5,6];
    const NOMES   = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // Para o mês atual: limitar 2025 ao mesmo dia para comparação justa
    const diaHoje  = hoje.getDate();
    const mesHoje  = hoje.getMonth() + 1;

    // Por mês (Jan–Dez): sequencial para não sobrecarregar o MySQL
    const porMes = [];
    for (let m = 1; m <= 12; m++) {
      const mm2 = String(m).padStart(2,'0');
      const lojasFiltro = lojaSel > 0 ? [lojaSel] : lojas;
      let v25=0,c25=0,v26=0,c26=0;
      // mês corrente: limita ambos os anos ao mesmo dia (comparação justa)
      const diaFiltro = m === mesHoje ? ` AND DAY(Data) <= ${diaHoje}` : '';
      await Promise.all(lojasFiltro.map(async ln => {
        try {
          const rows = await q(
            `SELECT YEAR(Data) as ano, SUM(ValorTotalNovo) as venda, COALESCE(SUM(Custo),0) as custo
             FROM \`ln${ln}mes${mm2}\`.zcupomitens
             WHERE YEAR(Data) IN (2025,2026) AND IndCancel='N'${diaFiltro} GROUP BY ano`);
          for (const r of rows) {
            const v=parseFloat(r.venda||0),c=parseFloat(r.custo||0);
            if(r.ano==2025){v25+=v;c25+=c;}else{v26+=v;c26+=c;}
          }
        } catch(_){}
      }));
      porMes.push({
        mes: m, nome: NOMES[m-1],
        parcial: m === mesHoje, // indica que é mês corrente (até diaHoje)
        venda2025:+v25.toFixed(2), custo2025:+c25.toFixed(2),
        msv2025: v25>0 ? +((v25-c25)/v25*100).toFixed(2) : null,
        venda2026:+v26.toFixed(2), custo2026:+c26.toFixed(2),
        msv2026: v26>0 ? +((v26-c26)/v26*100).toFixed(2) : null,
      });
    }

    // Por loja (mês selecionado) — 6 queries em paralelo é OK
    const mm = String(mesSel).padStart(2,'0');
    const diaFiltroLoja = mesSel === mesHoje ? ` AND DAY(Data) <= ${diaHoje}` : '';
    const porLoja = await Promise.all(lojas.map(async ln => {
      let v25=0,c25=0,v26=0,c26=0;
      try {
        const rows = await q(
          `SELECT YEAR(Data) as ano, SUM(ValorTotalNovo) as venda, COALESCE(SUM(Custo),0) as custo
           FROM \`ln${ln}mes${mm}\`.zcupomitens
           WHERE YEAR(Data) IN (2025,2026) AND IndCancel='N'${diaFiltroLoja} GROUP BY ano`);
        for (const r of rows) {
          const v=parseFloat(r.venda||0),c=parseFloat(r.custo||0);
          if(r.ano==2025){v25+=v;c25+=c;}else{v26+=v;c26+=c;}
        }
      } catch(_){}
      return {
        loja: ln,
        venda2025:+v25.toFixed(2), custo2025:+c25.toFixed(2),
        msv2025: v25>0 ? +((v25-c25)/v25*100).toFixed(2) : null,
        venda2026:+v26.toFixed(2), custo2026:+c26.toFixed(2),
        msv2026: v26>0 ? +((v26-c26)/v26*100).toFixed(2) : null,
      };
    }));

    const tv25=porLoja.reduce((s,l)=>s+l.venda2025,0);
    const tc25=porLoja.reduce((s,l)=>s+l.custo2025,0);
    const tv26=porLoja.reduce((s,l)=>s+l.venda2026,0);
    const tc26=porLoja.reduce((s,l)=>s+l.custo2026,0);

    res.json({
      por_mes: porMes, por_loja: porLoja,
      totais: {
        venda2025:+tv25.toFixed(2), custo2025:+tc25.toFixed(2), msv2025: tv25>0?+((tv25-tc25)/tv25*100).toFixed(2):null,
        venda2026:+tv26.toFixed(2), custo2026:+tc26.toFixed(2), msv2026: tv26>0?+((tv26-tc26)/tv26*100).toFixed(2):null,
      },
      mes: mesSel, loja: lojaSel,
      diaHoje, mesHoje
    });
  } catch(err){ res.status(500).json({error: err.message}); }
});

// ── COMPRA x VENDA por loja ────────────────────────────────────────────────
// Venda = NFC-e (zcupomitens) + NF-e saída (central.compras Tipo=NF Movimentacao=VENDA)
// Compra = central.compras Tipo=NF Movimentacao=COMPRA
app.get('/api/compra-venda', withCache(30), async (req, res) => {
  try {
    const hoje   = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const diaHoje = hoje.getDate();
    const mesHoje = hoje.getMonth() + 1;
    const lojas  = [1,2,3,4,5,6];
    const mm     = String(mesSel).padStart(2,'0');
    const diaFiltroV = mesSel === mesHoje ? ` AND DAY(Data) <= ${diaHoje}` : '';
    const diaFiltroC = mesSel === mesHoje ? ` AND DAY(DataLan) <= ${diaHoje}` : '';
    const NOMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // NFC-e por loja (6 queries em paralelo)
    const nfceMap = {};
    await Promise.all(lojas.map(async ln => {
      try {
        const [r] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda
           FROM \`ln${ln}mes${mm}\`.zcupomitens
           WHERE YEAR(Data)=2026 AND IndCancel='N'${diaFiltroV}`);
        nfceMap[ln] = parseFloat(r?.venda || 0);
      } catch(_) { nfceMap[ln] = 0; }
    }));

    // Compra por loja: DataRecto (recebimento) + Tipo='PNF' + Status='F' = igual ao ERP "com NF"
    // Venda NF-e: DataLan + Tipo='NF'
    const compraRows = await q(
      `SELECT nLoja, COALESCE(SUM(TotalNota),0) as total
       FROM central.compras
       WHERE MONTH(DataRecto)=? AND YEAR(DataRecto)=2026
         AND nLoja IN (1,2,3,4,5,6)
         AND Movimentacao='COMPRA' AND Tipo='PNF' AND Status='F'${diaFiltroC.replace('DataLan','DataRecto')}
       GROUP BY nLoja`,
      [mesSel]
    );
    const nfeVendaRows = await q(
      `SELECT nLoja, COALESCE(SUM(TotalNota),0) as total
       FROM central.compras
       WHERE MONTH(DataLan)=? AND YEAR(DataLan)=2026
         AND nLoja IN (1,2,3,4,5,6)
         AND Movimentacao='VENDA' AND Tipo='NF'${diaFiltroC}
       GROUP BY nLoja`,
      [mesSel]
    );
    const cvRows = [
      ...compraRows.map(r => ({ ...r, Movimentacao: 'COMPRA' })),
      ...nfeVendaRows.map(r => ({ ...r, Movimentacao: 'VENDA' })),
    ];
    const nfeVendaMap = {}, compraMap = {};
    for (const r of cvRows) {
      const v = parseFloat(r.total || 0);
      if (r.Movimentacao === 'VENDA')  nfeVendaMap[r.nLoja] = v;
      if (r.Movimentacao === 'COMPRA') compraMap[r.nLoja]   = v;
    }

    const por_loja = lojas.map(ln => {
      const nfce   = nfceMap[ln]    || 0;
      const nfe    = nfeVendaMap[ln] || 0;
      const compra = compraMap[ln]  || 0;
      const total  = nfce + nfe;
      return {
        loja: ln,
        venda_nfce:  +nfce.toFixed(2),
        venda_nfe:   +nfe.toFixed(2),
        venda_total: +total.toFixed(2),
        compra:      +compra.toFixed(2),
        cv: total > 0 ? +((compra / total) * 100).toFixed(2) : null,
      };
    });

    const tnfce   = por_loja.reduce((s,l)=>s+l.venda_nfce,0);
    const tnfe    = por_loja.reduce((s,l)=>s+l.venda_nfe,0);
    const ttotal  = por_loja.reduce((s,l)=>s+l.venda_total,0);
    const tcompra = por_loja.reduce((s,l)=>s+l.compra,0);

    res.json({
      por_loja,
      totais: {
        venda_nfce:  +tnfce.toFixed(2),
        venda_nfe:   +tnfe.toFixed(2),
        venda_total: +ttotal.toFixed(2),
        compra:      +tcompra.toFixed(2),
        cv: ttotal > 0 ? +((tcompra / ttotal) * 100).toFixed(2) : null,
      },
      mes: mesSel,
      nome_mes: NOMES[mesSel - 1],
      diaHoje, mesHoje,
      parcial: mesSel === mesHoje,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

const _mensalCache = {}, _mensalCacheTs = {};

// Comparativo mensal: todos os meses do ano 2025 vs 2026
app.get('/api/comparativo-mensal', withCache(240), async (req, res) => {
  try {
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const cacheKey = String(lojaSel);
    if (_mensalCache[cacheKey] && (Date.now() - _mensalCacheTs[cacheKey]) < RESUMO_TTL) {
      return res.json(_mensalCache[cacheKey]);
    }

    const meses = ['01','02','03','04','05','06','07','08','09','10','11','12'];
    const results = await Promise.all(meses.map(mm =>
      q(`SELECT YEAR(Data) as ano, SUM(ValorTotalNovo) as valor,
                COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons
         FROM \`ln${lojaSel}mes${mm}\`.zcupomitens
         WHERE YEAR(Data) IN (2025,2026) AND IndCancel='N'
         GROUP BY ano`, []).catch(() => [])
    ));

    const mesesNomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const data = results.map((rows, i) => {
      let v25=0, v26=0, c25=0, c26=0;
      for (const r of rows) {
        if (r.ano == 2025) { v25 = parseFloat(r.valor); c25 = parseInt(r.cupons); }
        if (r.ano == 2026) { v26 = parseFloat(r.valor); c26 = parseInt(r.cupons); }
      }
      return { mes: i+1, nome: mesesNomes[i],
        v2025: +v25.toFixed(2), v2026: +v26.toFixed(2),
        c2025: c25, c2026: c26,
        var: v25 > 0 ? +((v26-v25)/v25*100).toFixed(1) : null };
    });

    const tot25 = data.reduce((s,d)=>s+d.v2025,0);
    const tot26 = data.reduce((s,d)=>s+d.v2026,0);
    const payload = { meses: data, total2025: +tot25.toFixed(2), total2026: +tot26.toFixed(2),
      var_pct: tot25>0 ? +((tot26-tot25)/tot25*100).toFixed(1) : null };
    _mensalCache[cacheKey] = payload; _mensalCacheTs[cacheKey] = Date.now();
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Produtos vendidos sem fornecedor cadastrado
app.get('/api/sem-fornecedor', async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const anoSel  = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const mm      = mesDB(mesSel);
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim    = dFimMes(anoSel, mesSel);

    const rows = await q(`
      SELECT z.Codigo, it.Descricao, it.Unid,
             SUM(z.ValorTotalNovo) as valor, SUM(z.QtdNovo) as qtd
      FROM \`ln${lojaSel}${mm}\`.zcupomitens z
      LEFT JOIN central.itens it ON it.CodigoBarra = z.Codigo
      WHERE z.Data BETWEEN ? AND ? AND z.IndCancel = 'N'
        AND z.Codigo NOT IN (
          SELECT DISTINCT CodigoBarra FROM central.fornecedoritens WHERE Backup = 0
        )
      GROUP BY z.Codigo, it.Descricao, it.Unid
      ORDER BY valor DESC
    `, [dIni, dFim]);

    res.json(rows.map(r => ({
      codigo:    r.Codigo,
      descricao: (r.Descricao || '').trim() || '(sem descrição)',
      unid:      r.Unid || '',
      valor:     +parseFloat(r.valor || 0).toFixed(2),
      qtd:       Math.round(parseFloat(r.qtd || 0))
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Produtos de um fornecedor numa loja+mês
app.get('/api/fornecedores/:id/produtos', async (req, res) => {
  try {
    const id      = parseInt(req.params.id);
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const anoSel  = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const listaSel = req.query.lista ? parseInt(req.query.lista) : null;
    const mm      = mesDB(mesSel);
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim    = dFimMes(anoSel, mesSel);

    const prods = await q(`
      SELECT fi.CodigoBarra, it.Descricao, it.Unid,
             c.Custo, c.UltimaCompra,
             e.Qtd as estoque
      FROM central.fornecedoritens fi
      INNER JOIN central.itens it ON it.CodigoBarra = fi.CodigoBarra AND it.CodDesativado = 0
      LEFT JOIN central.custoloja${lojaSel} c  ON c.CodigoBarra = fi.CodigoBarra
      LEFT JOIN central.estoquen${lojaSel}  e  ON e.CodigoBarra = fi.CodigoBarra
      ${listaSel ? 'INNER JOIN central.c_cotacao_lista_itens cli ON cli.Codigobarra = fi.CodigoBarra AND cli.nCotacao = ?' : ''}
      WHERE fi.CodFornecedor = ? AND fi.Backup = 0
    `, listaSel ? [listaSel, id] : [id]);

    if (!prods.length) return res.json([]);

    // deduplica por CodigoBarra (fornecedoritens pode ter múltiplos nRegs por produto)
    const seenCod = new Set();
    const prodsUniq = prods.filter(p => seenCod.has(p.CodigoBarra) ? false : seenCod.add(p.CodigoBarra));

    const codigos = [...seenCod];
    const ph = codigos.map(() => '?').join(',');
    let vendasMap = {};
    try {
      const rows = await q(`
        SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor
        FROM \`ln${lojaSel}${mm}\`.zcupomitens
        WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph})
        GROUP BY Codigo
      `, [dIni, dFim, ...codigos]);
      for (const r of rows) vendasMap[r.Codigo] = { qtd: parseFloat(r.qtd), valor: parseFloat(r.valor) };
    } catch (e) {}

    res.json(prodsUniq.map(p => {
      const v   = vendasMap[p.CodigoBarra] || { qtd: 0, valor: 0 };
      const cst = parsePreco(p.Custo);
      const cstTot = v.qtd * cst;
      const lucro  = v.valor - cstTot;
      return {
        codigo:       p.CodigoBarra,
        descricao:    p.Descricao?.trim(),
        unidade:      p.Unid?.trim(),
        estoque:      parseFloat(p.estoque || 0),
        qtd_vendida:  +v.qtd.toFixed(3),
        venda:        +v.valor.toFixed(2),
        custo_unit:   +cst.toFixed(4),
        custo_total:  +cstTot.toFixed(2),
        lucro:        +lucro.toFixed(2),
        msv:          v.valor > 0 ? +(lucro / v.valor * 100).toFixed(2) : null,
        ultima_compra: p.UltimaCompra ? new Date(p.UltimaCompra).toLocaleDateString('pt-BR') : null,
        tem_venda:    v.valor > 0
      };
    }).sort((a, b) => b.venda - a.venda));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Avarias de um fornecedor
app.get('/api/fornecedores/:id/avarias', async (req, res) => {
  try {
    const id      = parseInt(req.params.id);
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const anoSel  = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const listaSel = req.query.lista ? parseInt(req.query.lista) : null;
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim    = dFimMes(anoSel, mesSel);

    const rows = await q(`
      SELECT a.CodigoBarras, a.Descricao, SUM(a.Qtd) as qtd, SUM(a.Total) as total,
             MAX(a.DataLan) as ultima
      FROM central.avariaconsumo a
      INNER JOIN central.fornecedoritens fi ON fi.CodigoBarra = a.CodigoBarras AND fi.CodFornecedor = a.CodFornec AND fi.Backup = 0
      ${listaSel ? 'INNER JOIN central.c_cotacao_lista_itens cli ON cli.Codigobarra = a.CodigoBarras AND cli.nCotacao = ?' : ''}
      WHERE a.nLoja=? AND a.CodFornec=? AND a.DataLan BETWEEN ? AND ?
      GROUP BY a.CodigoBarras, a.Descricao
      ORDER BY total DESC
    `, listaSel ? [listaSel, lojaSel, id, dIni, dFim] : [lojaSel, id, dIni, dFim]);

    // Enrich with NF-e descriptions from central.itens
    const avCodigos = [...new Set(rows.map(r => r.CodigoBarras))];
    if (avCodigos.length > 0) {
      const ph = avCodigos.map(() => '?').join(',');
      const itensRows = await q(`SELECT CodigoBarra, Descricao FROM central.itens WHERE CodigoBarra IN (${ph})`, avCodigos);
      const itensMap = {};
      for (const r of itensRows) itensMap[r.CodigoBarra] = r.Descricao?.trim();
      for (const r of rows) { if (itensMap[r.CodigoBarras]) r.Descricao = itensMap[r.CodigoBarras]; }
    }

    const totalAvaria = rows.reduce((s, r) => s + parseFloat(r.total), 0);

    // Venda do fornecedor para calcular %
    let vendaFornec = 0;
    try {
      const mm   = mesDB(mesSel);
      const prods = listaSel
        ? await q(`SELECT DISTINCT fi.CodigoBarra FROM central.fornecedoritens fi INNER JOIN central.c_cotacao_lista_itens cli ON cli.Codigobarra = fi.CodigoBarra AND cli.nCotacao = ? WHERE fi.CodFornecedor=? AND fi.Backup=0`, [listaSel, id])
        : await q(`SELECT DISTINCT CodigoBarra FROM central.fornecedoritens WHERE CodFornecedor=? AND Backup=0`, [id]);
      if (prods.length) {
        const ph = prods.map(() => '?').join(',');
        const [vr] = await q(`
          SELECT SUM(ValorTotalNovo) as v FROM \`ln${lojaSel}${mm}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph})
        `, [dIni, dFim, ...prods.map(p => p.CodigoBarra)]);
        vendaFornec = parseFloat(vr?.v || 0);
      }
    } catch (e) {}

    res.json({
      total:       +totalAvaria.toFixed(2),
      qtd_prods:   rows.length,
      pct_venda:   vendaFornec > 0 ? +(totalAvaria / vendaFornec * 100).toFixed(2) : 0,
      ultima:      rows.length ? new Date(Math.max(...rows.map(r => new Date(r.ultima)))).toLocaleDateString('pt-BR') : null,
      produtos:    rows.map(r => ({
        codigo:    r.CodigoBarras,
        descricao: r.Descricao?.trim(),
        qtd:       +parseFloat(r.qtd).toFixed(3),
        total:     +parseFloat(r.total).toFixed(2),
        ultima:    r.ultima ? new Date(r.ultima).toLocaleDateString('pt-BR') : null
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Comparativo do fornecedor em todas as lojas
app.get('/api/fornecedores/:id/lojas', async (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const hoje   = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const mm     = mesDB(mesSel);
    const dIni   = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim   = dFimMes(anoSel, mesSel);

    const prods = await q(`SELECT DISTINCT CodigoBarra FROM central.fornecedoritens WHERE CodFornecedor=? AND Backup=0`, [id]);
    const codigos = prods.map(p => p.CodigoBarra);
    if (!codigos.length) return res.json([]);
    const ph = codigos.map(() => '?').join(',');

    const result = [];
    for (const ln of [1,2,3,4,5,6]) {
      let venda = 0, avaria = 0, custo = 0, qtd = 0;
      try {
        const [vr] = await q(`
          SELECT SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as v
          FROM \`ln${ln}${mm}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph})
        `, [dIni, dFim, ...codigos]);
        venda = parseFloat(vr?.v || 0);
        qtd   = parseFloat(vr?.qtd || 0);
      } catch (e) {}
      try {
        const [ar] = await q(`SELECT SUM(Total) v FROM central.avariaconsumo WHERE nLoja=? AND CodFornec=? AND DataLan BETWEEN ? AND ?`, [ln, id, dIni, dFim]);
        avaria = parseFloat(ar?.v || 0);
      } catch (e) {}
      try {
        const custoRows = await q(`SELECT CodigoBarra, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph}) AND Custo>0`, codigos);
        // We need qtd per barcode to compute custo total accurately - approximate with equal distribution
        const custoMap = {};
        for (const r of custoRows) custoMap[r.CodigoBarra] = parsePreco(r.Custo);
        // Get individual qtds
        let vendasLn = {};
        try {
          const vrs = await q(`SELECT Codigo, SUM(QtdNovo) as q FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dIni, dFim, ...codigos]);
          for (const r of vrs) vendasLn[r.Codigo] = parseFloat(r.q);
        } catch (e) {}
        for (const [cod, c] of Object.entries(custoMap)) {
          custo += (vendasLn[cod] || 0) * c;
        }
      } catch (e) {}
      const lucro = venda - custo;
      result.push({
        loja:   ln,
        venda:  +venda.toFixed(2),
        avaria: +avaria.toFixed(2),
        lucro:  +lucro.toFixed(2),
        msv:    venda > 0 ? +(lucro / venda * 100).toFixed(2) : 0,
        pct_av: venda > 0 ? +(avaria / venda * 100).toFixed(2) : 0
      });
    }

    const maxVenda  = Math.max(...result.map(r => r.venda));
    const maxMsv    = Math.max(...result.filter(r => r.venda > 0).map(r => r.msv), -Infinity);
    const minAvaria = Math.min(...result.filter(r => r.avaria > 0).map(r => r.avaria), Infinity);

    res.json(result.map(r => ({
      ...r,
      badge_venda:  r.venda  === maxVenda  && maxVenda  > 0,
      badge_msv:    r.msv    === maxMsv    && maxMsv    > -Infinity,
      badge_avaria: r.avaria === minAvaria && minAvaria < Infinity && minAvaria > 0
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// FIM MÓDULO FORNECEDORES
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// MÓDULO PENDÊNCIAS DE CADASTRO
// ═══════════════════════════════════════════════════

// Itens ativos que não estão em nenhuma lista de compra
app.get('/api/pendencias/sem-lista', async (req, res) => {
  try {
    const busca = req.query.busca || '';
    const grupo = req.query.grupo ? parseInt(req.query.grupo) : null;
    let where = 'WHERE i.CodDesativado=0 AND i.P1 > 0 AND i.CodigoBarra NOT IN (SELECT DISTINCT Codigobarra FROM central.c_cotacao_lista_itens)';
    const params = [];
    if (grupo) { where += ' AND i.CodGrupo=?'; params.push(grupo); }
    if (busca) { where += ' AND (i.Descricao LIKE ? OR i.CodigoBarra LIKE ?)'; params.push(`%${busca}%`, `%${busca}%`); }
    const rows = await q(`
      SELECT i.CodigoBarra, i.Descricao, i.Unid,
             i.CodGrupo, g.Descricao as grupo,
             i.CodGrupoSub, gs.Descricao as subgrupo,
             i.CodGrupoMarca, gm.Descricao as mercadologico
      FROM central.itens i
      LEFT JOIN central.grupo g ON g.CodGrupo=i.CodGrupo
      LEFT JOIN central.gruposub gs ON gs.CodSubGrupo=i.CodGrupoSub
      LEFT JOIN central.grupomarca gm ON gm.CodMarca=i.CodGrupoMarca
      ${where}
      ORDER BY g.Descricao, gs.Descricao, i.Descricao
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Itens ativos sem mercadológico (CodGrupoMarca=0 ou CodGrupoSub=0)
app.get('/api/pendencias/sem-mercadologico', async (req, res) => {
  try {
    const busca = req.query.busca || '';
    let where = 'WHERE i.CodDesativado=0 AND i.P1 > 0 AND (i.CodGrupoMarca=0 OR i.CodGrupoMarca IS NULL OR i.CodGrupoSub=0 OR i.CodGrupoSub IS NULL)';
    const params = [];
    if (busca) { where += ' AND (i.Descricao LIKE ? OR i.CodigoBarra LIKE ?)'; params.push(`%${busca}%`, `%${busca}%`); }
    const rows = await q(`
      SELECT i.CodigoBarra, i.Descricao, i.Unid,
             i.CodGrupo, g.Descricao as grupo,
             i.CodGrupoSub, gs.Descricao as subgrupo,
             i.CodGrupoMarca, gm.Descricao as mercadologico,
             CASE WHEN (i.CodGrupoSub=0 OR i.CodGrupoSub IS NULL) THEN 1 ELSE 0 END as sem_subgrupo,
             CASE WHEN (i.CodGrupoMarca=0 OR i.CodGrupoMarca IS NULL) THEN 1 ELSE 0 END as sem_merc
      FROM central.itens i
      LEFT JOIN central.grupo g ON g.CodGrupo=i.CodGrupo
      LEFT JOIN central.gruposub gs ON gs.CodSubGrupo=i.CodGrupoSub
      LEFT JOIN central.grupomarca gm ON gm.CodMarca=i.CodGrupoMarca
      ${where}
      ORDER BY g.Descricao, i.Descricao
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lista de grupos para filtro
app.get('/api/grupos', async (req, res) => {
  try {
    const rows = await q('SELECT CodGrupo, Descricao FROM central.grupo WHERE CodDesativado=0 ORDER BY Descricao');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PREVENÇÃO (avarias em aberto / em trâmite) ──
const SETOR_MAP = (() => {
  const ACOUGUE = [3,9,15,16,18,19,20,21,22,23,24,25,26,30,34,36,37,40,41,42,44,45,46,48,50,51,52,53,54,55,56,57,58,59,61,63,67,68,69,70,77];
  const PADARIA = [1,4,5,7,10,29,35,65,66];
  const HORTI   = [6,17,47,62];
  const m = {};
  ACOUGUE.forEach(id => m[id] = 'AÇOUGUE');
  PADARIA.forEach(id => m[id] = 'PADARIA');
  HORTI.forEach(id   => m[id] = 'HORTFRUTI');
  return m;
})();
function getSetor(codMotivo) { return SETOR_MAP[codMotivo] || 'LOJA'; }

app.get('/api/pendencias/prevencao', withCache(60), async (req, res) => {
  try {
    const loja = parseInt(req.query.loja) || 1;
    const hoje = new Date();
    const mesSel = req.query.mes || `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;
    const [ano, mes] = mesSel.split('-').map(Number);
    const dIni = `${ano}-${String(mes).padStart(2,'0')}-01`;
    const dFim = dFimMes(ano, mes);
    const mm = mesDB(mes);

    // Mês fechado (já passou) e já congelado antes: usa o valor salvo direto,
    // sem consultar o banco de novo — é isso que trava o relatório de um mês
    // que já fechou, mesmo que o ERP receba NF emitida com atraso depois.
    const avariaCongeladoResumo = carregarAvariaCongelado();
    const chaveResumo = `resumo-${loja}-${mesSel}`;
    let emitido, aberto, tramite, valorVenda, bonificacoes, saldoAvaria, avariasFinal, pctTotal, pctFiltrada,
      porSetor, abertoFornec, tramiteFornec, abertoItens, tramiteItens;

    if (mesFechado(ano, mes) && avariaCongeladoResumo[chaveResumo]) {
      ({ emitido, aberto, tramite, valorVenda, bonificacoes, saldoAvaria, avariasFinal, pctTotal, pctFiltrada,
        porSetor, abertoFornec, tramiteFornec, abertoItens, tramiteItens } = avariaCongeladoResumo[chaveResumo]);
    } else {
      const pedidosEmitidos = await q(`SELECT DISTINCT a.nPedido
           FROM central.avariaconsumo a
           WHERE a.nLoja=? AND a.Status=4 AND a.Tipo=1 AND a.NF > 0 AND a.DataEmi BETWEEN ? AND ?`, [loja, dIni, dFim]);
      const pedIds = pedidosEmitidos.map(r => r.nPedido);

      const [emitidoRows, allAbertoTramite, vendasRows, bonifRows] = await Promise.all([
        pedIds.length ? q(`SELECT a.CodMotivo, a.Status, a.Total, a.CodFornec, a.CodigoBarras, a.Descricao,
                a.Qtd, a.Valor, a.Und, a.Usuario, a.DataLan, a.DataEmi,
                f.NomeCompleto as fornecedor
         FROM central.avariaconsumo a
         LEFT JOIN central.fornecedor f ON f.CodFornec=a.CodFornec
         WHERE a.nLoja=? AND a.Tipo=1 AND a.nPedido IN (?) AND a.Status=4 AND a.NF > 0 AND a.DataEmi BETWEEN ? AND ?
         ORDER BY a.Total DESC`, [loja, pedIds, dIni, dFim]) : Promise.resolve([]),
        q(`SELECT a.CodMotivo, a.Status, a.Total, a.CodFornec, a.CodigoBarras, a.Descricao,
                a.Qtd, a.Valor, a.Und, a.Usuario, a.DataLan, a.nPedido,
                f.NomeCompleto as fornecedor
         FROM central.avariaconsumo a
         LEFT JOIN central.fornecedor f ON f.CodFornec=a.CodFornec
         WHERE a.nLoja=? AND a.Status IN (0,3) AND a.DataLan BETWEEN ? AND ?
         ORDER BY a.Status, a.Total DESC`, [loja, dIni, dFim]),
        q(`SELECT SUM(ValorTotalNovo) as total FROM \`ln${loja}${mm}\`.zcupomitens
         WHERE Data BETWEEN ? AND ? AND IndCancel='N'`, [dIni, dFim]).catch(() => [{ total: 0 }]),
        q(`SELECT SUM(ValorTotal) as total FROM central.bonificacao_averbacao
         WHERE nLoja=? AND DataEntrada BETWEEN ? AND ?`, [loja, dIni, dFim]).catch(() => [{ total: 0 }])
      ]);

      valorVenda = parseFloat(vendasRows[0]?.total || 0);
      bonificacoes = parseFloat(bonifRows[0]?.total || 0);

      emitido = 0; aberto = 0; tramite = 0;
      porSetor = { AÇOUGUE: 0, HORTFRUTI: 0, PADARIA: 0 };
      abertoFornec = {}; tramiteFornec = {};
      abertoItens = []; tramiteItens = [];

      for (const r of emitidoRows) {
        const tot = parseFloat(r.Total);
        emitido += tot;
        if (r.Status === 4) {
          const fn = (r.fornecedor || '').toUpperCase();
          const setor = fn.includes('HORTI') ? 'HORTFRUTI'
            : (fn.includes('AÇOUGUE') || fn.includes('ACOUGUE')) ? 'AÇOUGUE'
            : fn.includes('PADARIA') ? 'PADARIA' : 'LOJA';
          porSetor[setor] = (porSetor[setor] || 0) + tot;
        }
      }

      for (const r of allAbertoTramite) {
        const tot = parseFloat(r.Total);
        if (r.Status === 0) {
          aberto += tot;
          const fn = r.fornecedor || 'SEM FORNECEDOR';
          if (!abertoFornec[fn]) abertoFornec[fn] = { total: 0, qtd: 0 };
          abertoFornec[fn].total += tot;
          abertoFornec[fn].qtd++;
          abertoItens.push(r);
        } else if (r.Status === 3) {
          tramite += tot;
          const fn = r.fornecedor || 'SEM FORNECEDOR';
          if (!tramiteFornec[fn]) tramiteFornec[fn] = { total: 0, qtd: 0 };
          tramiteFornec[fn].total += tot;
          tramiteFornec[fn].qtd++;
          tramiteItens.push(r);
        }
      }

      saldoAvaria = emitido - porSetor.AÇOUGUE - porSetor.HORTFRUTI - porSetor.PADARIA;
      avariasFinal = saldoAvaria - bonificacoes;
      pctTotal = valorVenda > 0 ? +(emitido / valorVenda * 100).toFixed(2) : 0;
      pctFiltrada = valorVenda > 0 ? +(avariasFinal / valorVenda * 100).toFixed(2) : 0;

      if (mesFechado(ano, mes)) {
        avariaCongeladoResumo[chaveResumo] = { emitido, aberto, tramite, valorVenda, bonificacoes, saldoAvaria,
          avariasFinal, pctTotal, pctFiltrada, porSetor, abertoFornec, tramiteFornec, abertoItens, tramiteItens };
        salvarAvariaCongelado(avariaCongeladoResumo);
      }
    }

    // Contador corrente de tudo em aberto/trâmite na loja (não é do mês
    // selecionado, é "hoje") — sempre ao vivo, nunca congela.
    const totalGeralRows = await q(`SELECT Status, SUM(Total) as total FROM central.avariaconsumo
         WHERE nLoja=? AND Status IN (0,3) GROUP BY Status`, [loja]);

    // Bonifs salvos para meses históricos desta loja
    const bonifHistRows = await q(`SELECT mes, valor FROM central.prevencao_bonif WHERE nLoja=? AND mes LIKE ?`, [loja, `${ano}-%`]).catch(() => []);
    const bonifHistMap = {};
    for (const r of bonifHistRows) bonifHistMap[r.mes] = parseFloat(r.valor || 0);

    // Comparativo mensal — Jan/Fev/Mai fixos do ERP, Mar/Abr vazios, Jun+ do banco
    const pctFixoLoja = {
      1: {1:1.28,2:1.82,5:1.65}, 2: {1:1.08,2:0.85,5:1.13}, 3: {1:0.71,2:0.93,5:0.84},
      4: {1:0.49,2:1.01,5:0.77}, 5: {1:0.57,2:0.65,5:0.86}, 6: {1:0.30,2:0.53,5:0.58}
    };
    const fixos = pctFixoLoja[loja] || {};
    const mensal = [];
    const avariaCongelado = carregarAvariaCongelado();
    let congeladoMudou = false;
    for (let i = 5; i >= 0; i--) {
      const dt = new Date(ano, mes - 1 - i, 1);
      const mAno = dt.getFullYear(), mMes = dt.getMonth() + 1;
      const mesKey = `${mAno}-${String(mMes).padStart(2,'0')}`;
      if (mMes === 3 || mMes === 4) { mensal.push({ mes: mesKey, emitido: 0, vendas: 0, pct: 0 }); continue; }
      if (fixos[mMes] !== undefined) { mensal.push({ mes: mesKey, emitido: 0, vendas: 0, pct: fixos[mMes] }); continue; }
      const congeladoKey = `${loja}-${mesKey}`;
      if (mesFechado(mAno, mMes) && avariaCongelado[congeladoKey]) {
        mensal.push({ mes: mesKey, ...avariaCongelado[congeladoKey] });
        continue;
      }
      const mIni = `${mAno}-${String(mMes).padStart(2,'0')}-01`;
      const mFim = dFimMes(mAno, mMes);
      const mDB = mesDB(mMes);
      try {
        const mPeds = await q(`SELECT DISTINCT nPedido FROM central.avariaconsumo
          WHERE nLoja=? AND Status=4 AND Tipo=1 AND NF > 0 AND DataEmi BETWEEN ? AND ?`, [loja, mIni, mFim]);
        const mPedIds = mPeds.map(r => r.nPedido);
        const [mEmitRows, mAT, mVd] = await Promise.all([
          mPedIds.length ? q(`SELECT a.Status, a.Total, f.NomeCompleto as fornecedor
            FROM central.avariaconsumo a LEFT JOIN central.fornecedor f ON f.CodFornec=a.CodFornec
            WHERE a.nLoja=? AND a.Tipo=1 AND a.nPedido IN (?) AND a.Status=4 AND a.NF > 0 AND a.DataEmi BETWEEN ? AND ?`, [loja, mPedIds, mIni, mFim]) : [],
          q(`SELECT Status, Total FROM central.avariaconsumo
            WHERE nLoja=? AND Status IN (0,3) AND DataLan BETWEEN ? AND ?`, [loja, mIni, mFim]),
          q(`SELECT SUM(ValorTotalNovo) as t FROM \`ln${loja}${mDB}\`.zcupomitens
            WHERE Data BETWEEN ? AND ? AND IndCancel='N'`, [mIni, mFim]).catch(() => [{ t: 0 }])
        ]);
        let mEmit = 0, mAberto = 0, mTramite = 0;
        const mSetor = { AÇOUGUE: 0, HORTFRUTI: 0, PADARIA: 0 };
        for (const r of mEmitRows) {
          mEmit += parseFloat(r.Total);
          const fn = (r.fornecedor || '').toUpperCase();
          const st = fn.includes('HORTI') ? 'HORTFRUTI'
            : (fn.includes('AÇOUGUE') || fn.includes('ACOUGUE')) ? 'AÇOUGUE'
            : fn.includes('PADARIA') ? 'PADARIA' : null;
          if (st) mSetor[st] += parseFloat(r.Total);
        }
        for (const r of mAT) {
          if (r.Status === 0) mAberto += parseFloat(r.Total);
          else if (r.Status === 3) mTramite += parseFloat(r.Total);
        }
        const mSaldo = mEmit - mSetor.AÇOUGUE - mSetor.HORTFRUTI - mSetor.PADARIA;
        const mBonif = bonifHistMap[mesKey] || 0;
        const mAvMes = (mSaldo - mBonif) + mAberto + mTramite;
        const vdT = parseFloat(mVd[0]?.t || 0);
        const mResultado = { emitido: mAvMes, vendas: vdT, pct: vdT > 0 ? +(mAvMes / vdT * 100).toFixed(2) : 0 };
        mensal.push({ mes: mesKey, ...mResultado });
        if (mesFechado(mAno, mMes)) { avariaCongelado[congeladoKey] = mResultado; congeladoMudou = true; }
      } catch { mensal.push({ mes: mesKey, emitido: 0, vendas: 0, pct: 0 }); }
    }
    if (congeladoMudou) salvarAvariaCongelado(avariaCongelado);

    const toArr = obj => Object.entries(obj).map(([nome, d]) => ({ nome, ...d })).sort((a, b) => b.total - a.total);

    let totalGeralAberto = 0, totalGeralTramite = 0;
    for (const r of totalGeralRows) {
      if (r.Status === 0) totalGeralAberto = parseFloat(r.total);
      else if (r.Status === 3) totalGeralTramite = parseFloat(r.total);
    }

    res.json({
      resumo: { emitido, aberto, tramite, valorVenda, bonificacoes, saldoAvaria, avariasFinal, pctTotal, pctFiltrada,
        totalGeralAberto, totalGeralTramite },
      porSetor,
      abertoFornec: toArr(abertoFornec),
      tramiteFornec: toArr(tramiteFornec),
      abertoItens, tramiteItens,
      mensal
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pendencias/prevencao-consolidado', withCache(60), async (req, res) => {
  try {
    const hoje = new Date();
    const mesSel = req.query.mes || `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;
    const [anoSel, mesNum] = mesSel.split('-').map(Number);
    const LOJAS = {1:'CAHU',2:'MURIBECA',3:'PONTE',4:'ATACAREJO',5:'PORTA LARGA',6:'JARDIM JD JORDÃO'};

    async function processLoja(loja, bonifMap = {}) {
      const dIni = `${anoSel}-${String(mesNum).padStart(2,'0')}-01`;
      const dFim = dFimMes(anoSel, mesNum);
      const mm = mesDB(mesNum);

      const avariaCongeladoCons = carregarAvariaCongelado();
      const chaveConsolidado = `consolidado-${loja}-${mesSel}`;
      if (mesFechado(anoSel, mesNum) && avariaCongeladoCons[chaveConsolidado]) {
        return { loja, nome: LOJAS[loja], ...avariaCongeladoCons[chaveConsolidado] };
      }

      const pedidosEmitidos = await q(`SELECT DISTINCT nPedido FROM central.avariaconsumo
        WHERE nLoja=? AND Status=4 AND Tipo=1 AND NF > 0 AND DataEmi BETWEEN ? AND ?`, [loja, dIni, dFim]);
      const pedIds = pedidosEmitidos.map(r => r.nPedido);

      const [emitidoRows, allAT, vendasRows, bonifRows, avBrutaRows] = await Promise.all([
        pedIds.length ? q(`SELECT a.Status, a.Total, f.NomeCompleto as fornecedor
          FROM central.avariaconsumo a LEFT JOIN central.fornecedor f ON f.CodFornec=a.CodFornec
          WHERE a.nLoja=? AND a.Tipo=1 AND a.nPedido IN (?) AND a.Status=4 AND a.NF > 0 AND a.DataEmi BETWEEN ? AND ?`, [loja, pedIds, dIni, dFim]) : [],
        q(`SELECT Status, Total FROM central.avariaconsumo
          WHERE nLoja=? AND Status IN (0,3) AND DataLan BETWEEN ? AND ?`, [loja, dIni, dFim]),
        q(`SELECT SUM(ValorTotalNovo) as total FROM \`ln${loja}${mm}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N'`, [dIni, dFim]).catch(() => [{ total: 0 }]),
        q(`SELECT SUM(ValorTotal) as total FROM central.bonificacao_averbacao
          WHERE nLoja=? AND DataEntrada BETWEEN ? AND ?`, [loja, dIni, dFim]).catch(() => [{ total: 0 }]),
        q(`SELECT SUM(Total) as total FROM central.avariaconsumo
          WHERE nLoja=? AND Status=4 AND DataEmi BETWEEN ? AND ?`, [loja, dIni, dFim]).catch(() => [{ total: 0 }])
      ]);

      const valorVenda = parseFloat(vendasRows[0]?.total || 0);
      const bonif = parseFloat(bonifRows[0]?.total || 0);
      const avBruta = parseFloat(avBrutaRows[0]?.total || 0);
      let emitido = 0, aberto = 0, tramite = 0;
      const porSetor = { AÇOUGUE: 0, HORTFRUTI: 0, PADARIA: 0 };

      for (const r of emitidoRows) {
        emitido += parseFloat(r.Total);
        if (r.Status === 4) {
          const fn = (r.fornecedor || '').toUpperCase();
          const setor = fn.includes('HORTI') ? 'HORTFRUTI'
            : (fn.includes('AÇOUGUE') || fn.includes('ACOUGUE')) ? 'AÇOUGUE'
            : fn.includes('PADARIA') ? 'PADARIA' : 'LOJA';
          porSetor[setor] = (porSetor[setor] || 0) + parseFloat(r.Total);
        }
      }

      for (const r of allAT) {
        if (r.Status === 0) aberto += parseFloat(r.Total);
        else if (r.Status === 3) tramite += parseFloat(r.Total);
      }

      const saldo = emitido - porSetor.AÇOUGUE - porSetor.HORTFRUTI - porSetor.PADARIA;
      // avMes inicial = aberto + tramite + saldo (sem bonif — JS ajusta via input)
      const avMesInicial = aberto + tramite + saldo;

      // Jan/Fev/Mai fixos do ERP, Mar/Abr vazios, Jun+ calcula do banco
      const pctFixo = {
        1: {1:1.28,2:1.08,3:0.71,4:0.49,5:0.57,6:0.30},
        2: {1:1.82,2:0.85,3:0.93,4:1.01,5:0.65,6:0.53},
        5: {1:1.65,2:1.13,3:0.84,4:0.77,5:0.86,6:0.58}
      };
      const mensal = [];
      for (let m = 1; m <= mesNum; m++) {
        if (m === 3 || m === 4) { mensal.push({ mes: m, pct: 0 }); continue; }
        // Mês atual: usa fórmula nova (aberto + trâmite + saldo, bonif deduzido pelo JS)
        if (m === mesNum) {
          mensal.push({ mes: m, pct: valorVenda > 0 ? +(avMesInicial / valorVenda * 100).toFixed(2) : 0 });
          continue;
        }
        if (pctFixo[m]) {
          mensal.push({ mes: m, pct: pctFixo[m][loja] || 0 });
          continue;
        }
        const mMesKey = `${anoSel}-${String(m).padStart(2,'0')}`;
        const mChaveCongelado = `mes-${loja}-${mMesKey}`;
        if (mesFechado(anoSel, m) && avariaCongeladoCons[mChaveCongelado]) {
          mensal.push({ mes: m, pct: avariaCongeladoCons[mChaveCongelado].pctMes || 0 });
          continue;
        }
        const mIni = `${anoSel}-${String(m).padStart(2,'0')}-01`;
        const mFim = dFimMes(anoSel, m);
        const mDB = mesDB(m);
        try {
          const mPeds = await q(`SELECT DISTINCT nPedido FROM central.avariaconsumo
            WHERE nLoja=? AND Status=4 AND Tipo=1 AND NF > 0 AND DataEmi BETWEEN ? AND ?`, [loja, mIni, mFim]);
          const mPedIds = mPeds.map(r => r.nPedido);
          const [mEmitRows, mAT, mVd] = await Promise.all([
            mPedIds.length ? q(`SELECT a.Status, a.Total, f.NomeCompleto as fornecedor
              FROM central.avariaconsumo a LEFT JOIN central.fornecedor f ON f.CodFornec=a.CodFornec
              WHERE a.nLoja=? AND a.Tipo=1 AND a.nPedido IN (?) AND a.Status=4 AND a.NF > 0 AND a.DataEmi BETWEEN ? AND ?`, [loja, mPedIds, mIni, mFim]) : [],
            q(`SELECT Status, Total FROM central.avariaconsumo
              WHERE nLoja=? AND Status IN (0,3) AND DataLan BETWEEN ? AND ?`, [loja, mIni, mFim]),
            q(`SELECT SUM(ValorTotalNovo) as t FROM \`ln${loja}${mDB}\`.zcupomitens
              WHERE Data BETWEEN ? AND ? AND IndCancel='N'`, [mIni, mFim]).catch(() => [{ t: 0 }])
          ]);
          let mEmit = 0, mAberto = 0, mTramite = 0;
          const mSetor = { AÇOUGUE: 0, HORTFRUTI: 0, PADARIA: 0 };
          for (const r of mEmitRows) {
            mEmit += parseFloat(r.Total);
            const fn = (r.fornecedor || '').toUpperCase();
            const st = fn.includes('HORTI') ? 'HORTFRUTI'
              : (fn.includes('AÇOUGUE') || fn.includes('ACOUGUE')) ? 'AÇOUGUE'
              : fn.includes('PADARIA') ? 'PADARIA' : null;
            if (st) mSetor[st] += parseFloat(r.Total);
          }
          for (const r of mAT) {
            if (r.Status === 0) mAberto += parseFloat(r.Total);
            else if (r.Status === 3) mTramite += parseFloat(r.Total);
          }
          const mSaldo = mEmit - mSetor.AÇOUGUE - mSetor.HORTFRUTI - mSetor.PADARIA;
          const mMesStr = `${anoSel}-${String(m).padStart(2,'0')}`;
          const mBonif = bonifMap[`${loja}-${mMesStr}`] || 0;
          const mAvMes = (mSaldo - mBonif) + mAberto + mTramite;
          const vdT = parseFloat(mVd[0]?.t || 0);
          const mPct = vdT > 0 ? +(mAvMes / vdT * 100).toFixed(2) : 0;
          mensal.push({ mes: m, pct: mPct });
          if (mesFechado(anoSel, m) && !avariaCongeladoCons[mChaveCongelado]) {
            avariaCongeladoCons[mChaveCongelado] = { venda: vdT, avBruta: mEmit, avMes: mAvMes,
              acougue: mSetor.AÇOUGUE, horti: mSetor.HORTFRUTI, padaria: mSetor.PADARIA,
              saldo: mSaldo, bonif: mBonif, aberto: mAberto, tramite: mTramite, mensal: [], pctMes: mPct };
            salvarAvariaCongelado(avariaCongeladoCons);
          }
        } catch { mensal.push({ mes: m, pct: 0 }); }
      }

      const resultadoLoja = {
        venda: valorVenda, avBruta, avMes: avMesInicial,
        acougue: porSetor.AÇOUGUE, horti: porSetor.HORTFRUTI, padaria: porSetor.PADARIA,
        saldo, bonif, aberto, tramite, mensal,
        pctMes: valorVenda > 0 ? +(avMesInicial / valorVenda * 100).toFixed(2) : 0
      };
      if (mesFechado(anoSel, mesNum)) {
        avariaCongeladoCons[chaveConsolidado] = resultadoLoja;
        salvarAvariaCongelado(avariaCongeladoCons);
      }
      return { loja, nome: LOJAS[loja], ...resultadoLoja };
    }

    // Bonifs salvos pelo usuário (para aplicar nos meses históricos)
    const bonifSavedRows = await q(`SELECT nLoja, mes, valor FROM central.prevencao_bonif WHERE mes LIKE ?`, [`${anoSel}-%`]).catch(() => []);
    const bonifMap = {};
    for (const r of bonifSavedRows) bonifMap[`${r.nLoja}-${r.mes}`] = parseFloat(r.valor || 0);

    const lojas = await Promise.all([1,2,3,4,5,6].map(l => processLoja(l, bonifMap)));
    res.json({ lojas, ano: anoSel, mesAtual: mesNum });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pendencias/prevencao-bonif', async (req, res) => {
  try {
    const { loja, mes, valor } = req.body;
    await q(`INSERT INTO central.prevencao_bonif (nLoja, mes, valor) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE valor=VALUES(valor)`, [parseInt(loja), mes, parseFloat(valor) || 0]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pendencias/prevencao-bonif', async (req, res) => {
  try {
    const mes = req.query.mes;
    const loja = req.query.loja;
    if (loja) {
      const rows = await q(`SELECT valor FROM central.prevencao_bonif WHERE nLoja=? AND mes=?`, [loja, mes]);
      res.json({ valor: parseFloat(rows[0]?.valor || 0) });
    } else {
      const rows = await q(`SELECT nLoja, valor FROM central.prevencao_bonif WHERE mes=?`, [mes]);
      const result = {};
      for (const r of rows) result[r.nLoja] = parseFloat(r.valor);
      res.json(result);
    }
  } catch (err) { res.json({}); }
});

// ═══════════════════════════════════════════════════
// FIM MÓDULO PENDÊNCIAS
// ═══════════════════════════════════════════════════

// Resumo de margens de todas as listas (deve vir ANTES de /:id)
app.get('/api/listas-compra/margem-resumo', async (req, res) => {
  try {
    const hoje = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas = lojaSel ? [lojaSel] : [1,2,3,4,5,6];
    const mm = mesDB(mesSel);
    const dataInicio = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dataFim = dFimMes(anoSel, mesSel);

    // Todos os itens de todas as listas (mapa barcode -> [lista_ids])
    const todosItens = await q(`SELECT nCotacao as lista_id, Codigobarra FROM central.c_cotacao_lista_itens`);
    const barcodeToListas = {};
    for (const item of todosItens) {
      if (!barcodeToListas[item.Codigobarra]) barcodeToListas[item.Codigobarra] = [];
      barcodeToListas[item.Codigobarra].push(item.lista_id);
    }
    const barcodesSet = new Set(Object.keys(barcodeToListas));

    // Vendas do mês: query simples sem filtro de código (mais rápido), filtra em memória
    const vendas = {};
    for (const ln of lojas) {
      const db = `ln${ln}${mm}`;
      try {
        const rows = await q(`
          SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor
          FROM \`${db}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N'
          GROUP BY Codigo
        `, [dataInicio, dataFim]);
        for (const r of rows) {
          if (!barcodesSet.has(r.Codigo)) continue;
          if (!vendas[r.Codigo]) vendas[r.Codigo] = { qtd: 0, valor: 0 };
          vendas[r.Codigo].qtd += parseFloat(r.qtd || 0);
          vendas[r.Codigo].valor += parseFloat(r.valor || 0);
        }
      } catch (e) {}
    }

    // Custo atual de cada produto (custoloja é pequeno, sem filtro)
    const custos = {};
    for (const ln of lojas) {
      try {
        const rows = await q(`SELECT CodigoBarra, Custo FROM central.custoloja${ln} WHERE Custo > 0`);
        for (const r of rows) {
          if (barcodesSet.has(r.CodigoBarra) && !custos[r.CodigoBarra]) {
            custos[r.CodigoBarra] = parseFloat(r.Custo);
          }
        }
      } catch (e) {}
    }

    // Acumula margem por lista
    const listaMargens = {};
    for (const [barcode, listaIds] of Object.entries(barcodeToListas)) {
      const v = vendas[barcode];
      if (!v || v.valor <= 0) continue;
      const custo = custos[barcode] || 0;
      if (custo <= 0) continue;
      const custoTotal = v.qtd * custo;
      const lucro = v.valor - custoTotal;
      for (const listaId of listaIds) {
        if (!listaMargens[listaId]) listaMargens[listaId] = { fat: 0, custo_total: 0, lucro: 0, prods: 0 };
        listaMargens[listaId].fat += v.valor;
        listaMargens[listaId].custo_total += custoTotal;
        listaMargens[listaId].lucro += lucro;
        listaMargens[listaId].prods++;
      }
    }

    const result = {};
    for (const [listaId, m] of Object.entries(listaMargens)) {
      result[parseInt(listaId)] = {
        msv: m.fat > 0 ? parseFloat((m.lucro / m.fat * 100).toFixed(2)) : 0,
        msc: m.custo_total > 0 ? parseFloat((m.lucro / m.custo_total * 100).toFixed(2)) : 0,
        faturamento: parseFloat(m.fat.toFixed(2)),
        lucro: parseFloat(m.lucro.toFixed(2)),
        produtos_vendidos: m.prods
      };
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Margem produto a produto de uma lista
app.get('/api/listas-compra/:id/margem', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const hoje = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;

    const [lista] = await q('SELECT * FROM central.c_cotacao_lista WHERE nReg = ?', [id]);
    if (!lista) return res.status(404).json({ error: 'Lista não encontrada' });

    const lojasLista = lojaSel ? [lojaSel] : [1,2,3,4,5,6].filter(n => lista['l'+n] == 1);
    const lojas = lojasLista.length ? lojasLista : [1,2,3,4,5,6];
    const mm = mesDB(mesSel);
    const dataInicio = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dataFim = dFimMes(anoSel, mesSel);

    const itens = await q(`
      SELECT i.Codigobarra, ci.Descricao, ci.Unid, i.QtdEmb
      FROM central.c_cotacao_lista_itens i
      INNER JOIN central.itens ci ON ci.CodigoBarra = i.Codigobarra AND ci.CodDesativado = 0
      WHERE i.nCotacao = ?
      ORDER BY i.Posicao, ci.Descricao
    `, [id]);
    if (!itens.length) return res.json({ produtos: [], resumo: {} });

    const codigos = [...new Set(itens.map(i => i.Codigobarra))];
    const ph = codigos.map(() => '?').join(',');

    const vendas = {};
    for (const ln of lojas) {
      const db = `ln${ln}${mm}`;
      try {
        const rows = await q(`
          SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor
          FROM \`${db}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph})
          GROUP BY Codigo
        `, [dataInicio, dataFim, ...codigos]);
        for (const r of rows) {
          if (!vendas[r.Codigo]) vendas[r.Codigo] = { qtd: 0, valor: 0 };
          vendas[r.Codigo].qtd += parseFloat(r.qtd || 0);
          vendas[r.Codigo].valor += parseFloat(r.valor || 0);
        }
      } catch (e) {}
    }

    const custos = {};
    for (const ln of lojas) {
      try {
        const rows = await q(`SELECT CodigoBarra, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph}) AND Custo > 0`, codigos);
        for (const r of rows) { if (!custos[r.CodigoBarra]) custos[r.CodigoBarra] = parseFloat(r.Custo); }
      } catch (e) {}
    }

    let totalFat = 0, totalCusto = 0, totalLucro = 0, comVenda = 0;
    const produtos = itens.map(item => {
      const v = vendas[item.Codigobarra] || { qtd: 0, valor: 0 };
      const custo = custos[item.Codigobarra] || 0;
      const custoTotal = v.qtd * custo;
      const lucro = v.valor - custoTotal;
      if (v.valor > 0) { totalFat += v.valor; totalCusto += custoTotal; totalLucro += lucro; comVenda++; }
      return {
        codigo: item.Codigobarra,
        descricao: item.Descricao?.trim(),
        unidade: item.Unid?.trim(),
        qtd_vendida: parseFloat(v.qtd.toFixed(3)),
        faturamento: parseFloat(v.valor.toFixed(2)),
        custo_unit: parseFloat(custo.toFixed(4)),
        custo_total: parseFloat(custoTotal.toFixed(2)),
        lucro: parseFloat(lucro.toFixed(2)),
        msv: v.valor > 0 ? parseFloat((lucro / v.valor * 100).toFixed(2)) : null,
        msc: custoTotal > 0 ? parseFloat((lucro / custoTotal * 100).toFixed(2)) : null,
        tem_venda: v.valor > 0
      };
    });

    res.json({
      produtos,
      resumo: {
        faturamento: parseFloat(totalFat.toFixed(2)),
        custo_total: parseFloat(totalCusto.toFixed(2)),
        lucro: parseFloat(totalLucro.toFixed(2)),
        msv: totalFat > 0 ? parseFloat((totalLucro / totalFat * 100).toFixed(2)) : 0,
        msc: totalCusto > 0 ? parseFloat((totalLucro / totalCusto * 100).toFixed(2)) : 0,
        produtos_com_venda: comVenda,
        total_produtos: itens.length
      },
      mes: mesSel, ano: anoSel
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Listas de compra cadastradas
app.get('/api/listas-compra', async (req, res) => {
  try {
    const { busca, comprador } = req.query;

    let where = [];
    let params = [];

    if (busca) {
      where.push('(l.Nome LIKE ? OR l.NomeFornec LIKE ? OR l.Obs LIKE ?)');
      params.push('%' + busca + '%', '%' + busca + '%', '%' + busca + '%');
    }

    const filtro = where.length ? 'WHERE ' + where.join(' AND ') : '';

    let sql = `
      SELECT l.nReg, l.Nome, l.NomeFornec, l.CodFornec, l.OperadorLista, l.Obs,
             l.l1, l.l2, l.l3, l.l4, l.l5, l.l6,
             COUNT(DISTINCT i.nReg) as total_itens
      FROM central.c_cotacao_lista l
      LEFT JOIN central.c_cotacao_lista_itens i ON i.nCotacao = l.nReg
      ${filtro}
      GROUP BY l.nReg
      ORDER BY l.Nome
    `;

    const rows = await q(sql, params);

    // Comprador via NREGS_COMPRADOR (Excel)
    const _nRegToComp = {};
    for (const [comp, nRegs] of Object.entries(NREGS_COMPRADOR)) {
      for (const nReg of nRegs) _nRegToComp[nReg] = comp;
    }

    let listasMapped = rows.map(r => ({
      id: r.nReg,
      nome: r.Nome?.trim(),
      fornecedor: r.NomeFornec?.trim(),
      codFornec: r.CodFornec,
      operador: r.OperadorLista && r.OperadorLista !== '0' ? r.OperadorLista : null,
      obs: r.Obs?.trim(),
      total_itens: r.total_itens,
      compradores: _nRegToComp[r.nReg] || null,
      lojas: [1,2,3,4,5,6].filter(n => r['l'+n] == 1)
    }));

    if (comprador) {
      listasMapped = listasMapped.filter(l => l.compradores && l.compradores.toUpperCase().includes(comprador.toUpperCase()));
    }

    res.json({
      listas: listasMapped,
      compradores: Object.keys(NREGS_COMPRADOR).sort()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Itens de uma lista específica
app.get('/api/listas-compra/:id/itens', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { loja } = req.query;

    let where = 'WHERE i.nCotacao = ?';
    let params = [id];

    if (loja && loja !== 'todas') {
      where += ` AND i.l${parseInt(loja)} = 1`;
    }

    const itens = await q(`
      SELECT i.nReg, i.Codigobarra, it.Descricao, it.Unid, i.QtdEmb, i.Posicao,
             i.l1, i.l2, i.l3, i.l4, i.l5, i.l6,
             ci.Custo as custo_atual
      FROM central.c_cotacao_lista_itens i
      INNER JOIN central.itens it ON it.CodigoBarra = i.Codigobarra AND it.CodDesativado = 0
      LEFT JOIN central.custoloja1 ci ON ci.CodigoBarra = i.Codigobarra
      ${where}
      ORDER BY i.Posicao, it.Descricao
    `, params);

    res.json(itens.map(r => ({
      codigo: r.Codigobarra,
      descricao: r.Descricao?.trim(),
      unidade: r.Unid?.trim(),
      embalagem: r.QtdEmb,
      posicao: r.Posicao,
      custo: parseFloat(r.custo_atual || 0),
      lojas: [1,2,3,4,5,6].filter(n => r['l'+n] == 1)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MÓDULO COMPRAS — PAINEL OPERACIONAL
// ═══════════════════════════════════════════════════

// Fornecedores com pedido colocado hoje (ou em data específica ?data=YYYY-MM-DD)
app.get('/api/compras/pedidos-hoje', async (req, res) => {
  try {
    const hoje = req.query.data || localDate();
    const rows = await q(`
      SELECT
        CodFornec,
        Nome                          AS nome,
        COUNT(DISTINCT nLoja)         AS qtd_lojas,
        COUNT(*)                      AS qtd_pedidos,
        SUM(Total)                    AS total_R,
        MAX(DataLan)                  AS ultima_hora
      FROM central.pedidocompra
      WHERE DATE(DataLan) = ?
      GROUP BY CodFornec, Nome
      ORDER BY total_R DESC
    `, [hoje]);

    const concluidos = new Set(rows.map(r => parseInt(r.CodFornec)));

    res.json({
      data: hoje,
      total_pedidos: rows.length,
      concluidos: [...concluidos],
      detalhe: rows.map(r => ({
        codFornec:   parseInt(r.CodFornec),
        nome:        (r.nome || '').trim(),
        qtd_lojas:   parseInt(r.qtd_lojas),
        qtd_pedidos: parseInt(r.qtd_pedidos),
        total:       parseFloat((r.total_R || 0)).toFixed(2)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Busca CodFornec real e NomeFornec a partir de nRegs de lista de compra
app.get('/api/compras/fornec-por-lista', async (req, res) => {
  try {
    const { listas } = req.query;
    if (!listas) return res.json({});
    const nRegs = String(listas).split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n > 0);
    if (!nRegs.length) return res.json({});
    const ph = nRegs.map(() => '?').join(',');
    const rows = await q(
      `SELECT nReg, CodFornec, NomeFornec FROM central.c_cotacao_lista WHERE nReg IN (${ph})`,
      nRegs
    );
    const map = {};
    for (const r of rows) {
      map[String(r.nReg)] = { codFornec: r.CodFornec, nomeFornec: (r.NomeFornec||'').trim() };
    }
    res.json(map);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Verificação de pedidos da semana de Fátima ──
app.get('/api/compras/verificar-comprador', async (req, res) => {
  try {
    // cod = nReg da lista de compra (não CodFornec)
    const cronFatima = {
      SEG: [344,310,312,314,311,342,303,380,309,482,538,461,313,355,534,537],
      TER: [347,415,332,341,417],
      QUA: [419,457,555,543,394],
      QUI: [573,574,572],
      SEX: [277],
    };

    // Listas da FATIMA via NREGS_COMPRADOR (Excel)
    const todosNRegs = [...new Set([...Object.values(cronFatima).flat(), ...(NREGS_COMPRADOR.FATIMA || [])])];
    const phN = todosNRegs.map(() => '?').join(',');

    // Passo 2: traduz nReg → CodFornec real
    const listas = await q(
      `SELECT nReg, CodFornec, NomeFornec FROM central.c_cotacao_lista WHERE nReg IN (${phN})`,
      todosNRegs
    );
    const listaMap = {};
    for (const l of listas) {
      listaMap[l.nReg] = { codFornec: l.CodFornec, nomeFornec: (l.NomeFornec||'').trim() };
    }

    const codsFornec = [...new Set(listas.map(l => l.CodFornec).filter(Boolean))];
    if (!codsFornec.length) {
      return res.json({ comprador: 'FATIMA', semana: Object.fromEntries(
        Object.entries(cronFatima).map(([dia, cods]) => [dia, cods.map(cod => ({
          cod, codFornec: null, nome: listaMap[cod]?.nomeFornec || `Lista ${cod}`,
          status: 'PENDENTE', pedidos: []
        }))])
      )});
    }

    // Passo 3: busca pedidos usando CodFornec real (últimos 10 dias)
    const phF = codsFornec.map(() => '?').join(',');
    const pedidos = await q(`
      SELECT DATE(DataLan) AS data, CodFornec, Nome AS nome_fornec,
             COUNT(*) AS qtd, SUM(Total) AS total
      FROM central.pedidocompra
      WHERE DATE(DataLan) >= DATE_SUB(CURDATE(), INTERVAL 10 DAY)
        AND CodFornec IN (${phF})
      GROUP BY DATE(DataLan), CodFornec, Nome
      ORDER BY data DESC
    `, codsFornec);

    // Indexa por CodFornec
    const mapa = {};
    for (const p of pedidos) {
      const k = String(p.CodFornec);
      if (!mapa[k]) mapa[k] = { nome: (p.nome_fornec||'').trim(), pedidos: [] };
      mapa[k].pedidos.push({
        data: String(p.data).slice(0,10),
        qtd: p.qtd,
        total: parseFloat(p.total||0).toFixed(2),
      });
    }

    // Monta resultado por dia
    const resultado = {};
    for (const [dia, nRegs] of Object.entries(cronFatima)) {
      resultado[dia] = nRegs.map(nReg => {
        const info = listaMap[nReg];
        const codFornec = info?.codFornec;
        const pedidoInfo = codFornec ? mapa[String(codFornec)] : null;
        return {
          cod: nReg,
          codFornec: codFornec || null,
          nome: pedidoInfo?.nome || info?.nomeFornec || `Lista ${nReg}`,
          status: pedidoInfo ? 'CONCLUIDO' : 'PENDENTE',
          pedidos: pedidoInfo?.pedidos || [],
        };
      });
    }

    res.json({ comprador: 'FATIMA', semana: resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pedidos do mês agrupados por data e CodFornec
app.get('/api/compras/pedidos-mes', async (req, res) => {
  try {
    const hoje = new Date();
    const mes = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const ano = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const rows = await q(`
      SELECT DATE(DataLan) AS data, CodFornec
      FROM central.pedidocompra
      WHERE YEAR(DataLan) = ? AND MONTH(DataLan) = ?
      GROUP BY DATE(DataLan), CodFornec
      ORDER BY data
    `, [ano, mes]);
    const mapa = {};
    for (const r of rows) {
      const k = String(r.data).slice(0,10);
      if (!mapa[k]) mapa[k] = [];
      mapa[k].push(parseInt(r.CodFornec));
    }
    res.json({ mes, ano, pedidos: mapa });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MÓDULO PRECIFICAÇÃO — MARGENS CRÍTICAS
// ═══════════════════════════════════════════════════

app.get('/api/precificacao/margens-criticas', async (req, res) => {
  try {
    const hoje = localDate();
    const mes  = new Date().getMonth() + 1;
    const mm   = mesDB(mes);
    const result = {};
    for (const ln of [1,2,3,4,5,6]) {
      try {
        const rows = await q(`
          SELECT z.Codigo,
                 TRIM(COALESCE(i.Descricao, z.Descricao)) as descricao,
                 SUM(z.ValorTotalNovo) / NULLIF(SUM(z.QtdNovo), 0) as preco,
                 SUM(z.Custo)          / NULLIF(SUM(z.QtdNovo), 0) as custo
          FROM \`ln${ln}${mm}\`.zcupomitens z
          INNER JOIN central.itens i ON i.CodigoBarra = z.Codigo AND i.CodDesativado = 0
          WHERE z.Data = ? AND z.IndCancel = 'N'
          GROUP BY z.Codigo, i.Descricao, z.Descricao
          HAVING custo > 0
        `, [hoje]);
        result[ln] = rows
          .map(r => {
            const preco = parsePreco(r.preco);
            const custo = parsePreco(r.custo);
            const margem = custo > 0 ? +((preco - custo) / custo * 100).toFixed(1) : -999;
            return { codigo: r.Codigo, descricao: r.descricao, preco, custo, margem };
          })
          .filter(r => r.margem < 20)
          .sort((a, b) => a.margem - b.margem);
      } catch(e) { result[ln] = []; }
    }
    // Margem geral e por loja
    let totalVenda = 0, totalCusto = 0;
    const porLoja = {};
    for (const ln of [1,2,3,4,5,6]) {
      try {
        const [r] = await q(`
          SELECT SUM(ValorTotalNovo) as venda, SUM(Custo) as custo
          FROM \`ln${ln}${mm}\`.zcupomitens
          WHERE Data = ? AND IndCancel = 'N'
        `, [hoje]);
        const v = parseFloat(r?.venda || 0);
        const c = parseFloat(r?.custo  || 0);
        totalVenda += v;
        totalCusto += c;
        porLoja[ln] = { msc: c > 0 ? +((v - c) / c * 100).toFixed(1) : 0, msv: v > 0 ? +((v - c) / v * 100).toFixed(1) : 0, venda: +v.toFixed(2), custo: +c.toFixed(2) };
      } catch(e) { porLoja[ln] = { msc: 0, msv: 0, venda: 0, custo: 0 }; }
    }
    result.resumo = {
      margemMSC: totalCusto > 0 ? +((totalVenda - totalCusto) / totalCusto * 100).toFixed(1) : 0,
      margemMSV: totalVenda > 0 ? +((totalVenda - totalCusto) / totalVenda * 100).toFixed(1) : 0,
      totalVenda: +totalVenda.toFixed(2),
      totalCusto: +totalCusto.toFixed(2),
      porLoja
    };
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MÓDULO COMPRAS — ANÁLISE DE ESTOQUE POR COMPRADOR
// Tudo separado por loja (ruptura/excesso/giro por loja)
// Variação de custo: soma das 6 lojas (preço único de compra)
// ═══════════════════════════════════════════════════

const NREGS_COMPRADOR = {
  FATIMA: [303,309,310,311,312,313,314,332,342,344,347,350,355,380,394,415,417,419,457,461,482,534,537,538,543,555,572],
  KELLY: [218,316,318,320,322,325,326,327,328,334,336,337,338,345,346,351,356,358,366,370,372,382,398,403,404,413,421,422,423,424,428,429,430,431,440,442,449,456,473,480,483,487,499,529,557,561,563,584],
  STHEPHANNY: [279,293,319,361,365,371,373,377,379,388,399,405,406,408,409,411,412,414,416,418,444,445,446,458,469,470,485,496,500,501,505,508,516,519,530,531,540,541,544,564,570,578,579,580,583],
  CRISLANE: [191,307,308,323,324,331,335,339,340,352,364,369,374,375,381,420,424,436,437,478,488,495,504,514,535,554,556,559,582,586],
  PATRICIA: [295,296,317,329,368,376,391,392,395,396,397,400,401,407,410,427,433,434,439,441,447,450,454,455,459,462,465,467,476,484,486,493,494,497,502,507,521,550,551,552,560,565],
};

let _analiseCache = {}, _analiseCacheTs = {};
const ANALISE_TTL = 10 * 60 * 1000;

app.get('/api/compras/analise-estoque', async (req, res) => {
  try {
    const comp = (req.query.comprador || 'FATIMA')
      .normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase();
    const nRegs = NREGS_COMPRADOR[comp];
    const vazio = { lojas:{}, variacaoCusto:[], totalProdutos:0, geradoEm:'' };
    if (!nRegs) return res.json(vazio);

    const now = Date.now();
    if (_analiseCache[comp] && (now - _analiseCacheTs[comp]) < ANALISE_TTL)
      return res.json(_analiseCache[comp]);

    // 1. Produtos diretamente dos itens das listas (só o que está nas listas)
    const phN = nRegs.map(() => '?').join(',');
    const prods = await q(`
      SELECT DISTINCT i.Codigobarra as CodigoBarra, TRIM(it.Descricao) as descricao
      FROM central.c_cotacao_lista_itens i
      INNER JOIN central.itens it ON it.CodigoBarra = i.Codigobarra AND it.CodDesativado = 0
      WHERE i.nCotacao IN (${phN})
    `, nRegs);
    if (!prods.length) return res.json(vazio);

    const codigos = [...new Set(prods.map(p => p.CodigoBarra))];
    const descMap = Object.fromEntries(prods.map(p => [p.CodigoBarra, p.descricao]));
    const phC = codigos.map(() => '?').join(',');

    // 3. Estoque por loja (separado)
    const estRows = await q(`
      SELECT i.CodigoBarra,
        GREATEST(0,COALESCE(e1.Qtd,0)) as q1, GREATEST(0,COALESCE(e2.Qtd,0)) as q2,
        GREATEST(0,COALESCE(e3.Qtd,0)) as q3, GREATEST(0,COALESCE(e4.Qtd,0)) as q4,
        GREATEST(0,COALESCE(e5.Qtd,0)) as q5, GREATEST(0,COALESCE(e6.Qtd,0)) as q6
      FROM (SELECT CodigoBarra FROM central.itens WHERE CodigoBarra IN (${phC})) i
      LEFT JOIN central.estoquen1 e1 ON e1.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen2 e2 ON e2.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen3 e3 ON e3.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen4 e4 ON e4.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen5 e5 ON e5.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen6 e6 ON e6.CodigoBarra = i.CodigoBarra
    `, codigos);
    // estoqueMap[cod][ln] = qty
    const estoqueMap = {};
    for (const r of estRows) {
      estoqueMap[r.CodigoBarra] = {
        '1':parseFloat(r.q1||0),'2':parseFloat(r.q2||0),'3':parseFloat(r.q3||0),
        '4':parseFloat(r.q4||0),'5':parseFloat(r.q5||0),'6':parseFloat(r.q6||0),
      };
    }

    // 4. Vendas por loja × período (3 meses para cobrir 60 dias)
    const hojeD = new Date();
    const ini60 = localDate(new Date(hojeD - 60*86400000));
    const ini30 = localDate(new Date(hojeD - 30*86400000));
    const meses = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(hojeD.getFullYear(), hojeD.getMonth()-i, 1);
      meses.push({ ano: d.getFullYear(), mes: d.getMonth()+1 });
    }

    // vendasMap[ln][cod] = { qtd30, qtd30ant, custoAtual, custoAnt, ultimaVenda }
    const vendasMap = {};
    for (const ln of ['1','2','3','4','5','6']) vendasMap[ln] = {};

    await Promise.all([1,2,3,4,5,6].map(async (ln) => {
      const key = String(ln);
      for (const { ano, mes } of meses) {
        const mm = mesDB(mes);
        try {
          const rows = await q(`
            SELECT Codigo,
              SUM(CASE WHEN Data >= ? THEN QtdNovo ELSE 0 END) as qtd30,
              SUM(CASE WHEN Data >= ? AND Data < ? THEN QtdNovo ELSE 0 END) as qtd30ant,
              SUM(CASE WHEN Data >= ? THEN Custo  ELSE 0 END) as custoAtual,
              SUM(CASE WHEN Data >= ? AND Data < ? THEN Custo  ELSE 0 END) as custoAnt,
              MAX(Data) as ultima_venda
            FROM \`ln${ln}${mm}\`.zcupomitens
            WHERE IndCancel='N' AND Data >= ? AND Codigo IN (${phC})
            GROUP BY Codigo
          `, [ini30, ini60, ini30, ini30, ini60, ini30, ini60, ...codigos]);
          for (const r of rows) {
            const k = r.Codigo;
            if (!vendasMap[key][k]) vendasMap[key][k] = { qtd30:0, qtd30ant:0, custoAtual:0, custoAnt:0, ultimaVenda:null };
            vendasMap[key][k].qtd30     += parseFloat(r.qtd30||0);
            vendasMap[key][k].qtd30ant  += parseFloat(r.qtd30ant||0);
            vendasMap[key][k].custoAtual+= parseFloat(r.custoAtual||0);
            vendasMap[key][k].custoAnt  += parseFloat(r.custoAnt||0);
            const uv = r.ultima_venda ? String(r.ultima_venda).slice(0,10) : null;
            if (uv && (!vendasMap[key][k].ultimaVenda || uv > vendasMap[key][k].ultimaVenda))
              vendasMap[key][k].ultimaVenda = uv;
          }
        } catch(_) {}
      }
    }));

    // Filtrar produtos sem nenhuma atividade (sem estoque e sem vendas em 60 dias)
    const codAtivos = codigos.filter(cod => {
      const estoqueTotal = Object.values(estoqueMap[cod] || {}).reduce((s,v) => s+v, 0);
      const vendasTotal  = ['1','2','3','4','5','6'].reduce((s,ln) => {
        const v = vendasMap[ln][cod]; return s + (v ? v.qtd30 + v.qtd30ant : 0);
      }, 0);
      return estoqueTotal > 0 || vendasTotal > 0;
    });

    // 5. Classificar por loja
    const lojas = {};
    for (const ln of ['1','2','3','4','5','6']) {
      lojas[ln] = { ruptura:[], excesso:[], semVenda:[], topVendidos:[], quedaGiro:[] };
    }
    const variacaoCusto = [];

    for (const cod of codAtivos) {
      const descricao = descMap[cod] || cod;

      // Variação de custo — soma das 6 lojas (preço de compra é único)
      let totQtd30=0, totQtd30ant=0, totCustoAtual=0, totCustoAnt=0;
      for (const ln of ['1','2','3','4','5','6']) {
        const v = vendasMap[ln][cod];
        if (!v) continue;
        totQtd30     += v.qtd30;
        totQtd30ant  += v.qtd30ant;
        totCustoAtual+= v.custoAtual;
        totCustoAnt  += v.custoAnt;
      }
      if (totQtd30 > 0 && totQtd30ant > 0 && totCustoAnt > 0) {
        const cu = totCustoAtual/totQtd30, ca = totCustoAnt/totQtd30ant;
        const varPct = ((cu-ca)/ca)*100;
        if (varPct > 5) variacaoCusto.push({ codigo:cod, descricao,
          custoAtual:+cu.toFixed(4), custoAnt:+ca.toFixed(4), varPct:+varPct.toFixed(1) });
      }

      // Por loja
      for (const ln of ['1','2','3','4','5','6']) {
        const estoque = estoqueMap[cod]?.[ln] || 0;
        const v = vendasMap[ln][cod];
        const qtd30    = v ? v.qtd30    : 0;
        const qtd30ant = v ? v.qtd30ant : 0;
        const ultimaVenda = v ? v.ultimaVenda : null;
        const mediaDiaria = qtd30 / 30;
        const diasCobertura = mediaDiaria > 0.001
          ? Math.round(estoque / mediaDiaria) : (estoque > 0 ? 9999 : 0);
        const diasSemVenda = ultimaVenda
          ? Math.round((hojeD - new Date(ultimaVenda+'T12:00:00')) / 86400000) : 999;

        if (diasSemVenda >= 60 && estoque > 0)
          lojas[ln].semVenda.push({ codigo:cod, descricao, estoque:+estoque.toFixed(2), diasSemVenda, ultimaVenda });

        if (mediaDiaria > 0.001 && diasCobertura < 40) {
          const urgencia = diasCobertura < 10 ? 'critico' : diasCobertura < 20 ? 'alto' : 'medio';
          lojas[ln].ruptura.push({ codigo:cod, descricao, estoque:+estoque.toFixed(2), mediaDiaria:+mediaDiaria.toFixed(2), diasCobertura, urgencia });
        }

        if (mediaDiaria > 0.001 && diasCobertura > 80)
          lojas[ln].excesso.push({ codigo:cod, descricao, estoque:+estoque.toFixed(2), mediaDiaria:+mediaDiaria.toFixed(2), diasCobertura });

        if (qtd30 > 0)
          lojas[ln].topVendidos.push({ codigo:cod, descricao, qtd30:+qtd30.toFixed(0), mediaDiaria:+mediaDiaria.toFixed(2) });

        if (qtd30ant > 0 && qtd30 < qtd30ant * 0.7)
          lojas[ln].quedaGiro.push({ codigo:cod, descricao,
            qtd30:+qtd30.toFixed(0), qtd30ant:+qtd30ant.toFixed(0),
            quedaPct:+(((qtd30ant-qtd30)/qtd30ant)*100).toFixed(1) });
      }
    }

    // Ordenar e limitar por loja
    for (const ln of ['1','2','3','4','5','6']) {
      lojas[ln].ruptura.sort((a,b)    => (a.estoque === 0 ? 0 : 1) - (b.estoque === 0 ? 0 : 1) || b.mediaDiaria - a.mediaDiaria);
      lojas[ln].excesso.sort((a,b)    => b.diasCobertura - a.diasCobertura);
      lojas[ln].semVenda.sort((a,b)   => b.diasSemVenda  - a.diasSemVenda);
      lojas[ln].topVendidos.sort((a,b)=> b.qtd30 - a.qtd30);
      lojas[ln].quedaGiro.sort((a,b)  => b.quedaPct - a.quedaPct);
      lojas[ln].ruptura    = lojas[ln].ruptura.slice(0,20);
      lojas[ln].excesso    = lojas[ln].excesso.slice(0,20);
      lojas[ln].semVenda   = lojas[ln].semVenda.slice(0,10);
      lojas[ln].topVendidos= lojas[ln].topVendidos.slice(0,10);
      lojas[ln].quedaGiro  = lojas[ln].quedaGiro.slice(0,10);
    }
    variacaoCusto.sort((a,b) => b.varPct - a.varPct);

    const result = {
      lojas,
      variacaoCusto: variacaoCusto.slice(0,10),
      totalProdutos: codAtivos.length,
      geradoEm: new Date().toISOString()
    };
    _analiseCache[comp] = result;
    _analiseCacheTs[comp] = now;
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MÓDULO COMPRAS — CENTRO DE DISTRIBUIÇÃO (loja 10)
// Estoque do CD x giro de 30 dias das lojas 1-6 —
// sugere quanto cada loja deve pedir do CD e alerta
// quando o próprio CD precisa comprar do fornecedor.
// ═══════════════════════════════════════════════════

const LOJAS_CD_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };

// Ajustes manuais de sugestão de pedido (chave "codigo|loja" → quantidade em
// unidades) — sobrepõe tanto o cálculo por giro quanto a distribuição padrão
// de produto sem histórico. Fica em JSON local (mesmo padrão de
// CD_NOTAS_AVULSAS_PATH), nunca no MySQL.
const CD_PEDIDO_OVERRIDES_PATH = path.join(__dirname, 'data', 'cd-pedido-overrides.json');
function carregarCdPedidoOverrides() {
  try { return JSON.parse(fs.readFileSync(CD_PEDIDO_OVERRIDES_PATH, 'utf8')); } catch (e) { return {}; }
}
function salvarCdPedidoOverrides(overrides) {
  fs.mkdirSync(path.dirname(CD_PEDIDO_OVERRIDES_PATH), { recursive: true });
  fs.writeFileSync(CD_PEDIDO_OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

app.post('/api/compras/centro-distribuicao/ajustar', (req, res) => {
  const { codigo, loja, quantidade, remover } = req.body || {};
  if (!codigo || !loja) return res.status(400).json({ error: 'Informe codigo e loja.' });
  const overrides = carregarCdPedidoOverrides();
  const key = `${codigo}|${loja}`;
  if (remover) {
    delete overrides[key];
  } else {
    const qtd = Math.round(Number(quantidade));
    if (!Number.isFinite(qtd) || qtd < 0) return res.status(400).json({ error: 'Quantidade inválida.' });
    overrides[key] = qtd;
  }
  salvarCdPedidoOverrides(overrides);
  _cache.delete('/api/compras/centro-distribuicao'); // reflete o ajuste no próximo "Analisar Agora" sem esperar o TTL
  res.json({ ok: true });
});

app.get('/api/compras/centro-distribuicao', withCache(10), async (req, res) => {
  try {
    const vazio = {
      produtos: [],
      resumo: { totalProdutos: 0, precisamReposicao: 0, criticos: 0, totalUnidadesFaltando: 0 },
      geradoEm: new Date().toISOString()
    };

    // 1. Universo de produtos — só o que o CD (loja 10) tem em estoque positivo agora.
    // Mais estreito e muito mais rápido do que partir de todas as listas de cotação
    // (que trazia produtos que o CD nunca chegou a estocar); também é o critério certo
    // pro negócio: essa aba distribui o que já está no CD, não planeja compra nova.
    const estCD = await q(`SELECT CodigoBarra, Qtd FROM central.estoquen10 WHERE Qtd > 0`, [])
      .catch(() => []);
    if (!estCD.length) return res.json(vazio);

    const overrides = carregarCdPedidoOverrides();
    const codigosCD = estCD.map(r => r.CodigoBarra);
    const phCD = codigosCD.map(() => '?').join(',');

    // No CD, código de barras com 14 dígitos é caixa/fardo, não unidade (regra do
    // Tiago) — o giro das lojas é sempre em unidade, então sem converter, comparar
    // "100 caixas" com "giro de 5 unidades/dia" dá uma cobertura completamente errada.
    // central.embalagempadrao_venda (cadastro "Embalagem Vendas" do ERP) guarda, pelo
    // próprio código de 14 dígitos, quantas unidades cada caixa tem (Qtd_venda).
    const codigosCaixa = codigosCD.filter(c => String(c).length === 14);
    let fatorCaixaMap = {};
    if (codigosCaixa.length) {
      const phCx = codigosCaixa.map(() => '?').join(',');
      const embRows = await q(`
        SELECT Codigobarra, Qtd_venda FROM central.embalagempadrao_venda
        WHERE Codigobarra IN (${phCx})
      `, codigosCaixa).catch(() => []);
      fatorCaixaMap = Object.fromEntries(embRows.map(r => [r.Codigobarra, parseFloat(r.Qtd_venda) || 0]));
    }

    // estoqueCDMap guarda sempre unidades — para código de caixa, já converte aqui
    // (estoqueEmCaixas × unidades por caixa). Quando o cadastro de embalagem não tem
    // esse código, não dá pra converter com segurança: marca conversaoDesconhecida e
    // mantém o valor bruto (mesmo comportamento de antes) só pra não sumir da tela.
    const estoqueCDMap = {};
    const medidoEmCaixaMap = {};
    const conversaoDesconhecidaMap = {};
    const estoqueCDCaixasMap = {};
    const unidadesPorCaixaMap = {};
    for (const r of estCD) {
      const cod = r.CodigoBarra;
      const qtd = parseFloat(r.Qtd) || 0;
      if (String(cod).length === 14) {
        medidoEmCaixaMap[cod] = true;
        estoqueCDCaixasMap[cod] = qtd;
        const fator = fatorCaixaMap[cod];
        if (fator > 0) {
          unidadesPorCaixaMap[cod] = fator;
          estoqueCDMap[cod] = qtd * fator;
        } else {
          conversaoDesconhecidaMap[cod] = true;
          estoqueCDMap[cod] = qtd; // sem fator confiável — não inventa conversão
        }
      } else {
        estoqueCDMap[cod] = qtd;
      }
    }

    // Descrição + filtro de produto ativo (CodDesativado=0) — descarta código de barras
    // do estoque que não corresponde a um item ativo cadastrado.
    const descRows = await q(`
      SELECT CodigoBarra, TRIM(Descricao) as descricao
      FROM central.itens WHERE CodDesativado = 0 AND CodigoBarra IN (${phCD})
    `, codigosCD).catch(() => []);
    if (!descRows.length) return res.json(vazio);

    const descMap = Object.fromEntries(descRows.map(r => [r.CodigoBarra, r.descricao || r.CodigoBarra]));
    const codigos = descRows.map(r => r.CodigoBarra);
    const phC = codigos.map(() => '?').join(',');

    // 2. Estoque nas lojas 1-6 (o do CD já temos em estoqueCDMap)
    const LOJAS = [1, 2, 3, 4, 5, 6];
    const estoqueQs = LOJAS.map(n =>
      q(`SELECT CodigoBarra, Qtd FROM central.estoquen${n} WHERE CodigoBarra IN (${phC})`, codigos).catch(() => [])
    );
    const estoqueArr = await Promise.all(estoqueQs);
    const estoqueMap = {}; // estoqueMap[cod][loja] = qtd
    estoqueArr.forEach((rows, idx) => {
      const ln = LOJAS[idx];
      for (const r of rows) {
        if (!estoqueMap[r.CodigoBarra]) estoqueMap[r.CodigoBarra] = {};
        estoqueMap[r.CodigoBarra][ln] = parseFloat(r.Qtd) || 0;
      }
    });

    // 3. Vendas dos últimos 30 dias por loja (1-6) — janela de 2 meses pra cobrir virada de mês
    const hojeD = new Date();
    const ini30 = localDate(new Date(hojeD - 30 * 86400000));
    const meses = [0, 1].map(i => mesDB(new Date(hojeD.getFullYear(), hojeD.getMonth() - i, 1).getMonth() + 1));

    const vendasMap = {}; // vendasMap[loja][cod] = qtd30
    for (const ln of LOJAS) vendasMap[ln] = {};
    await Promise.all(LOJAS.map(async (ln) => {
      for (const mm of meses) {
        try {
          const rows = await q(`
            SELECT Codigo, SUM(QtdNovo) as qtd30
            FROM \`ln${ln}${mm}\`.zcupomitens
            WHERE IndCancel='N' AND Data >= ? AND Codigo IN (${phC})
            GROUP BY Codigo
          `, [ini30, ...codigos]);
          for (const r of rows) {
            vendasMap[ln][r.Codigo] = (vendasMap[ln][r.Codigo] || 0) + (parseFloat(r.qtd30) || 0);
          }
        } catch (_) {}
      }
    }));

    // 4. Montar um registro por produto — todo produto aqui já tem estoque
    // positivo no CD (filtrado no passo 1), não precisa de checagem extra.
    const produtos = [];
    for (const cod of codigos) {
      const estoqueCD = estoqueCDMap[cod] || 0;
      // Giro/estoque de loja é sempre em unidade — o pedido calculado também sai em
      // unidade. Mas se o CD só entrega esse produto em caixa fechada, a loja não
      // pode pedir "150 unidades": arredonda pra cima em nº de caixas (fatorCaixa),
      // sempre cobrindo pelo menos a necessidade calculada.
      const fatorCaixa = unidadesPorCaixaMap[cod] || null;
      let totalSugerido = 0;
      let giroDiarioTotalCD = 0;
      const lojasOut = [];

      for (const ln of LOJAS) {
        const estoqueLoja = estoqueMap[cod]?.[ln] || 0;
        const qtd30 = vendasMap[ln][cod] || 0;
        const giroDiario = qtd30 / 30;
        const diasCobertura = giroDiario > 0.001
          ? estoqueLoja / giroDiario
          : (estoqueLoja > 0 ? 9999 : 0);
        const sugestaoPedido = (giroDiario > 0.001 && diasCobertura < 30)
          ? Math.max(0, Math.round(giroDiario * 30 - estoqueLoja))
          : 0;
        const sugestaoPedidoCaixas = (fatorCaixa && sugestaoPedido > 0)
          ? Math.ceil(sugestaoPedido / fatorCaixa)
          : null;

        totalSugerido += sugestaoPedido;
        giroDiarioTotalCD += giroDiario;
        lojasOut.push({
          loja: ln, nome: LOJAS_CD_NOMES[ln],
          estoque: +estoqueLoja.toFixed(2),
          giroDiario: +giroDiario.toFixed(2),
          diasCobertura: diasCobertura === 9999 ? 9999 : +diasCobertura.toFixed(1),
          sugestaoPedido, sugestaoPedidoCaixas
        });
      }

      // Universo já garante estoqueCD > 0 (filtrado no passo 1), então sem giro
      // a cobertura é sempre "infinita" — não existe o caso estoqueCD <= 0 aqui.
      // Isso também é o sinal de "produto sem histórico de venda": nenhuma das
      // 6 lojas vendeu nos últimos 30 dias, então não tem giro pra calcular
      // sugestão nenhuma — típico de produto novo que acabou de chegar no CD.
      const semHistorico = giroDiarioTotalCD <= 0.001;
      const diasCoberturaCD = semHistorico ? 9999 : estoqueCD / giroDiarioTotalCD;
      const status = diasCoberturaCD < 10 ? 'critico'
        : diasCoberturaCD < 20 ? 'alto'
        : diasCoberturaCD < 30 ? 'medio' : 'ok';

      // Sem histórico: não tem giro pra calcular nada, então a sugestão vira
      // uma distribuição igual do estoque do CD entre as 6 lojas (um "pedido
      // de teste" pra loja começar a vender o produto novo). Se o item é de
      // caixa, distribui em caixas fechadas, não fração de caixa.
      if (semHistorico) {
        if (fatorCaixa) {
          const caixasPorLoja = Math.floor((estoqueCDCaixasMap[cod] || 0) / 6);
          for (const l of lojasOut) {
            l.sugestaoPedido = caixasPorLoja * fatorCaixa;
            l.sugestaoPedidoCaixas = caixasPorLoja > 0 ? caixasPorLoja : null;
          }
        } else {
          const unidadesPorLoja = Math.floor(estoqueCD / 6);
          for (const l of lojasOut) { l.sugestaoPedido = unidadesPorLoja; l.sugestaoPedidoCaixas = null; }
        }
      }

      // Ajuste manual (se existir) sempre vence — tanto o cálculo por giro
      // quanto a distribuição de produto sem histórico.
      for (const l of lojasOut) {
        const key = `${cod}|${l.loja}`;
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          l.sugestaoPedido = overrides[key];
          l.sugestaoPedidoCaixas = (fatorCaixa && l.sugestaoPedido > 0) ? Math.ceil(l.sugestaoPedido / fatorCaixa) : null;
          l.ajustadoManualmente = true;
        } else {
          l.ajustadoManualmente = false;
        }
      }

      // Recalcula os totais do produto a partir do valor final de cada loja
      // (já com distribuição de produto novo e ajustes manuais aplicados).
      totalSugerido = lojasOut.reduce((s, l) => s + l.sugestaoPedido, 0);
      // Arredondado pra inteiro — não faz sentido sugerir fração de unidade.
      const faltaComprar = Math.max(0, Math.round(totalSugerido - estoqueCD));
      const faltaComprarCaixas = (fatorCaixa && faltaComprar > 0)
        ? Math.ceil(faltaComprar / fatorCaixa)
        : null;
      const totalSugeridoCaixas = (fatorCaixa && totalSugerido > 0)
        ? Math.ceil(totalSugerido / fatorCaixa)
        : null;

      produtos.push({
        codigo: cod, descricao: descMap[cod] || cod,
        estoqueCD: +estoqueCD.toFixed(2),
        diasCoberturaCD: diasCoberturaCD === 9999 ? 9999 : +diasCoberturaCD.toFixed(1),
        status, semHistorico, totalSugerido, totalSugeridoCaixas, faltaComprar, faltaComprarCaixas,
        medidoEmCaixa: !!medidoEmCaixaMap[cod],
        conversaoDesconhecida: !!conversaoDesconhecidaMap[cod],
        estoqueCDCaixas: medidoEmCaixaMap[cod] ? +estoqueCDCaixasMap[cod].toFixed(2) : null,
        unidadesPorCaixa: fatorCaixa,
        lojas: lojasOut
      });
    }

    produtos.sort((a, b) => a.diasCoberturaCD - b.diasCoberturaCD);

    const resumo = {
      totalProdutos: produtos.length,
      precisamReposicao: produtos.filter(p => p.totalSugerido > 0).length,
      criticos: produtos.filter(p => p.status === 'critico').length,
      totalUnidadesFaltando: produtos.reduce((s, p) => s + p.faltaComprar, 0)
    };

    res.json({ produtos, resumo, geradoEm: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// PAINEL TV — CD (loja 10): Expedição (saídas, painel_televendas)
// e Conferência (entradas, conferencia), só loja 10.
//
// Expedição — Status mapeia direto pras 5 colunas (confirmado pelo Tiago,
// é a mesma query que o painel legado do sistema usa):
// 0 Pedido p/ Separação · 1 Pedido em Separação · 2 Aguardando Liberação ·
// 3 Reconferir · 4 Pedido Liberado.
//
// Conferência — painel legado tem colunas diferentes (Conf. Pedido /
// Conf. Coletor / Conferido / Reconferir / Liberado) e usa OUTRO conjunto de
// códigos de Status, diferente da Expedição. Mapeamento confirmado cruzando
// pedidos reais da tela física (monitor "Documentos Fiscais") contra o banco:
// Status=5 → Conf. Pedido (178198/178223, sem OperadorCentral ainda),
// Status=3 → Conf. Coletor, Status=4 → Reconferir (178197, confirmado com
// print da tela mostrando ">>Reconferir<<"), Status=2 → Conferido/Liberado
// (o Status sozinho não separa os dois — quem separa é DataLiberacao
// preenchida = liberado, vazia = só conferido; confirmado com 178257).
// Status 0/1 são raros (poucos registros no histórico) e sempre aparecem já
// com DataLiberacao preenchida — tratados como o par conferido/liberado.
// ═══════════════════════════════════════════════════

const COLUNAS_EXPEDICAO = ['separacao', 'em_separacao', 'aguardando_liberacao', 'reconferir', 'liberado'];
const STATUS_EXPEDICAO = { 0: 'separacao', 1: 'em_separacao', 2: 'aguardando_liberacao', 3: 'reconferir', 4: 'liberado' };

const COLUNAS_CONFERENCIA = ['conf_pedido', 'conf_coletor', 'conferido', 'reconferir', 'liberado'];
function statusConferencia(row) {
  if (row.Status === 5) return 'conf_pedido';
  if (row.Status === 3) return 'conf_coletor';
  if (row.Status === 4) return 'reconferir';
  return row.DataLiberacao ? 'liberado' : 'conferido';
}

async function montarListaExpedicao() {
  // Pedido pendente (Status<4) fica visível enquanto não for liberado, mesmo
  // que tenha entrado em dia anterior (senão pedido travado, tipo o 00807,
  // some do painel mesmo continuando pendente de verdade). Limita a 7 dias
  // pra não voltar a puxar lixo antigo abandonado (teve caso de 2021).
  // "Liberado" sempre fica restrito a hoje, senão cresceria pra sempre.
  const rows = await q(`
    SELECT nReg, nPedido as pedido, NomeFornec as nome, Status, HoraEntrada
    FROM central.painel_televendas
    WHERE nLoja = 10 AND (
      (Status < 4 AND DataEntrada >= CURDATE() - INTERVAL 7 DAY)
      OR (Status = 4 AND DataLiberacao = CURDATE())
    )
    ORDER BY HoraEntrada DESC
  `, []).catch(() => []);

  const colunas = { separacao: [], em_separacao: [], aguardando_liberacao: [], reconferir: [], liberado: [] };
  for (const r of rows) {
    const status = STATUS_EXPEDICAO[r.Status] || 'separacao';
    colunas[status].push({ pedido: String(r.pedido), nome: r.nome || 'N/I' });
  }
  const resumo = { total: rows.length };
  for (const c of COLUNAS_EXPEDICAO) resumo[c] = colunas[c].length;

  // Itens dos pedidos que estão na coluna Reconferir, agrupados por pedido —
  // mesma lógica da Conferência. A tabela de itens da Expedição é
  // central.conferencia_televendas (chave por nLoja+nPedido, não por nReg
  // do cabeçalho). O campo Status_Conferencia dela fica sempre 0 (não é um
  // flag individual usável), então — igual na Conferência — mostra todos os
  // itens do pedido quando ele está marcado pra reconferir.
  let itensReconferir = [];
  const pedidosReconferir = colunas.reconferir.map(r => r.pedido);
  if (pedidosReconferir.length) {
    const ph = pedidosReconferir.map(() => '?').join(',');
    const itensRows = await q(`
      SELECT DISTINCT nPedido, Codigobarra FROM central.conferencia_televendas
      WHERE nLoja = 10 AND nPedido IN (${ph})
    `, pedidosReconferir).catch(() => []);
    if (itensRows.length) {
      const barras = [...new Set(itensRows.map(r => r.Codigobarra))];
      const phB = barras.map(() => '?').join(',');
      const descRows = await q(`
        SELECT CodigoBarra, TRIM(Descricao) as descricao FROM central.itens WHERE CodigoBarra IN (${phB})
      `, barras).catch(() => []);
      const descMap = Object.fromEntries(descRows.map(r => [r.CodigoBarra, r.descricao]));

      const porPedido = new Map();
      for (const r of itensRows) {
        const desc = descMap[r.Codigobarra];
        if (!desc) continue;
        const pedido = String(r.nPedido);
        if (!porPedido.has(pedido)) porPedido.set(pedido, []);
        porPedido.get(pedido).push(desc);
      }
      itensReconferir = [...porPedido.entries()].map(([pedido, itens]) => ({ pedido, itens }));
    }
  }

  return { resumo, colunas, itensReconferir };
}

async function montarListaConferencia() {
  // Mesmo raciocínio da Expedição: pedido ainda não liberado fica visível até
  // 7 dias atrás (pega travado real, tipo pedido de 1-2 dias), sem voltar a
  // puxar lixo antigo abandonado. "Liberado" fica restrito a hoje.
  const rows = await q(`
    SELECT nReg, NomeFornec as nome, Status, HoraEntrada, DataLiberacao
    FROM central.conferencia
    WHERE nLoja = 10 AND (
      (DataLiberacao IS NULL AND DataEntrada >= CURDATE() - INTERVAL 7 DAY)
      OR (DataLiberacao = CURDATE())
    )
    ORDER BY HoraEntrada DESC
  `, []).catch(() => []);

  const colunas = { conf_pedido: [], conf_coletor: [], conferido: [], reconferir: [], liberado: [] };
  for (const r of rows) {
    const status = statusConferencia(r);
    colunas[status].push({ pedido: String(r.nReg), nome: r.nome || 'N/I' });
  }
  const resumo = { total: rows.length };
  for (const c of COLUNAS_CONFERENCIA) resumo[c] = colunas[c].length;

  // Itens pra reconferir, agrupados por pedido (pode ter 2 conferentes com 2
  // notas em reconferência ao mesmo tempo — o painel mostra o número do
  // pedido na frente e cicla um pedido inteiro antes de ir pro próximo, não
  // mistura os itens dos dois). Quando a NOTA inteira está marcada pra
  // reconferência (Status=3 no cabeçalho), todos os itens dela entram —
  // não só os que tiverem a flag Reconferir=1 individual (confirmado com o
  // Tiago: às vezes a nota é marcada sem nenhum item individual flagado).
  // conferenciaitens.chave é o próprio nReg do pedido em texto (confirmado
  // direto no banco, sem tabela ponte). "Name" desse item vem sempre "0"
  // (campo não usado nesse fluxo), então busca a descrição de verdade em
  // central.itens pelo código de barra. Só pedido + descrição saem pro
  // painel — sem código de barra, sem quantidade (pedido explícito do Tiago).
  let itensReconferir = [];
  const nRegsReconferir = colunas.reconferir.map(r => r.pedido);
  if (nRegsReconferir.length) {
    const ph = nRegsReconferir.map(() => '?').join(',');
    const itensRows = await q(`
      SELECT DISTINCT chave, codigobarra FROM central.conferenciaitens
      WHERE chave IN (${ph})
    `, nRegsReconferir).catch(() => []);
    if (itensRows.length) {
      const barras = [...new Set(itensRows.map(r => r.codigobarra))];
      const phB = barras.map(() => '?').join(',');
      const descRows = await q(`
        SELECT CodigoBarra, TRIM(Descricao) as descricao FROM central.itens WHERE CodigoBarra IN (${phB})
      `, barras).catch(() => []);
      const descMap = Object.fromEntries(descRows.map(r => [r.CodigoBarra, r.descricao]));

      const porPedido = new Map(); // Map preserva a ordem de inserção mesmo com chave numérica
      for (const r of itensRows) {
        const desc = descMap[r.codigobarra];
        if (!desc) continue;
        if (!porPedido.has(r.chave)) porPedido.set(r.chave, []);
        porPedido.get(r.chave).push(desc);
      }
      itensReconferir = [...porPedido.entries()].map(([pedido, itens]) => ({ pedido, itens }));
    }
  }

  return { resumo, colunas, itensReconferir };
}

app.get('/api/painel-cd', withCache(1), async (req, res) => {
  try {
    const [expedicao, conferencia] = await Promise.all([
      montarListaExpedicao(),
      montarListaConferencia()
    ]);
    res.json({ expedicao, conferencia, geradoEm: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/deploy', (req, res) => {
  if (req.query.token !== 'fc360deploy2026') return res.status(403).send('Proibido');
  const gitPaths = [
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\bin\\git.exe',
    'git'
  ];
  const fs2 = require('fs');
  const git = gitPaths.find(p => p === 'git' || fs2.existsSync(p)) || 'git';
  // npm install roda ANTES do restart, com o servidor antigo ainda no ar, e só
  // reinicia se der tudo certo — se o código novo usar uma dependência nova e
  // o npm install falhar (ou o git der problema), o servidor NÃO reinicia e
  // continua rodando a versão anterior (que funciona), em vez de trocar pra
  // um código que vai quebrar ao carregar. Aconteceu de verdade uma vez sem
  // essa trava: deploy trocou o código, reiniciou, e caiu porque faltava
  // instalar um pacote novo — ninguém percebeu até o site sair do ar.
  const cmd = `"${git}" fetch origin && "${git}" reset --hard origin/main && npm install --omit=dev`;
  exec(cmd, { cwd: __dirname, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
    const out = (stdout || '') + (stderr || '') + (err ? '\nERRO: ' + err.message : '');
    console.log('[DEPLOY]', out);
    if (err) {
      res.status(500).send('<pre>' + out + '\n\nFALHOU — servidor NÃO foi reiniciado, continua rodando a versão anterior.</pre>');
      return;
    }
    res.send('<pre>' + out + '\n\nReiniciando servidor...</pre>');
    setTimeout(() => process.exit(0), 1000);
  });
});

// Retransmite o gatilho de reenvio manual pro processo negativos-wpp
// (roda separado, escutando só em localhost:3010) — permite disparar o
// reenvio do relatório de estoque negativo sem precisar de comando via
// WhatsApp, usando o mesmo domínio público já existente do deploy.
app.get('/api/negativos/reenviar', async (req, res) => {
  if (req.query.token !== 'fc360deploy2026') return res.status(403).send('Proibido');
  try {
    const r = await fetch('http://127.0.0.1:3010/reenviar-negativos');
    const texto = await r.text();
    res.status(r.status).type('json').send(texto);
  } catch (err) {
    res.status(502).json({ error: 'negativos-wpp não respondeu (serviço fora do ar?): ' + err.message });
  }
});

// Mesmo gatilho acima, mas pro botão da aba Negativos (public/negativos.html)
// — usa a sessão logada em vez do token de deploy, que não devia ficar
// exposto no front-end.
app.post('/api/negativos/reenviar-ui', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Não autenticado.' });
  try {
    const r = await fetch('http://127.0.0.1:3010/reenviar-negativos');
    const texto = await r.text();
    res.status(r.status).type('json').send(texto);
  } catch (err) {
    res.status(502).json({ error: 'negativos-wpp não respondeu (serviço fora do ar?): ' + err.message });
  }
});

// Proxy autenticado pro negativos-agent (processo separado, porta 4300 só em
// localhost) — a aba Negativos embeda esse app via iframe em /negativos-agent/.
// Fica atrás da sessão do Econômico Relatórios porque o negativos-agent em si
// não tem login próprio.
app.use('/negativos-agent', (req, res) => {
  if (!req.session.user) return res.status(401).send('Não autenticado.');
  const upstreamPath = req.originalUrl.replace(/^\/negativos-agent/, '') || '/';
  const proxyReq = http.request({
    hostname: '127.0.0.1', port: 4300,
    path: upstreamPath, method: req.method, headers: req.headers,
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', err => {
    if (!res.headersSent) res.status(502).send('negativos-agent não respondeu: ' + err.message);
  });
  req.pipe(proxyReq);
});

// Injeta manualmente um valor congelado de Avaria/Prevenção pra um mês
// fechado — usado quando o Tiago quer travar um mês num valor específico
// (ex: bater com um print/relatório que ele já validou), sem depender do
// recálculo automático. Body: { chave, dados }.
app.post('/api/pendencias/congelar-manual', (req, res) => {
  if (req.query.token !== 'fc360deploy2026') return res.status(403).send('Proibido');
  try {
    const { chave, dados } = req.body || {};
    if (!chave || !dados) return res.status(400).json({ error: 'Informe chave e dados.' });
    const congelado = carregarAvariaCongelado();
    congelado[chave] = dados;
    salvarAvariaCongelado(congelado);
    res.json({ ok: true, chave });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── IA RUPTURAS ─────────────────────────────────────────
app.get('/api/ruptura/debug-comprador', async (req, res) => {
  try {
    const nome = req.query.nome || 'ANA KELLY';
    const nomeUp = nome.normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase();
    const listIds = NREGS_COMPRADOR[nomeUp] || [];
    let itensCount = 0;
    let prodsCount = 0;
    if (listIds.length) {
      const ph = listIds.map(() => '?').join(',');
      const itens = await q(`SELECT COUNT(*) as c FROM central.c_cotacao_lista_itens WHERE nCotacao IN (${ph})`, listIds).catch(() => [{ c: -1 }]);
      itensCount = itens[0]?.c ?? 0;
      const prods = await q(`SELECT COUNT(DISTINCT i.nInterno) as c FROM central.c_cotacao_lista_itens cli JOIN central.itens i ON i.CodigoBarra = cli.Codigobarra AND i.CodDesativado = 0 WHERE cli.nCotacao IN (${ph})`, listIds).catch(() => [{ c: -1 }]);
      prodsCount = prods[0]?.c ?? 0;
    }
    res.json({ nome, listaRows, listIds, itensCount, prodsCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ruptura/compradores', withCache(60), async (req, res) => {
  try {
    res.json(Object.keys(NREGS_COMPRADOR).sort());
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Margem TV — todas as lojas somadas por comprador
app.get('/api/margem-tv/comprador', withCache(5), async (req, res) => {
  try {
    const hoje = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const comp   = (req.query.comprador || '').normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase();
    const nRegs  = NREGS_COMPRADOR[comp];
    if (!nRegs || !nRegs.length) return res.status(400).json({ error: 'Comprador inválido' });

    const mm   = mesDB(mesSel);
    const dIni = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim = dFimMes(anoSel, mesSel);
    const phN  = nRegs.map(() => '?').join(',');

    // 1. CodFornec de cada lista do comprador
    const listaRows = await q(
      `SELECT nReg, codFornec FROM central.c_cotacao_lista WHERE nReg IN (${phN})`, nRegs
    ).catch(() => []);
    const nRegFornecMap = {};
    for (const r of listaRows) nRegFornecMap[r.nReg] = r.codFornec;
    const codFornecs = [...new Set(Object.values(nRegFornecMap))].filter(Boolean);
    if (!codFornecs.length) return res.json({ comprador: comp, totais:{}, fornecedores:[] });

    // 2. Nome dos fornecedores
    const phF = codFornecs.map(() => '?').join(',');
    const fornecRows = await q(
      `SELECT CodFornec, Nome, NomeCompleto FROM central.fornecedor WHERE CodFornec IN (${phF})`, codFornecs
    ).catch(() => []);
    const fornecNome = {};
    for (const f of fornecRows) fornecNome[f.CodFornec] = (f.Nome || f.NomeCompleto || '').trim();

    // 3. Produtos das listas (dedupado)
    const prodRows = await q(
      `SELECT DISTINCT i.Codigobarra as cod, i.nCotacao as nReg
       FROM central.c_cotacao_lista_itens i
       INNER JOIN central.itens it ON it.CodigoBarra = i.Codigobarra AND it.CodDesativado = 0
       WHERE i.nCotacao IN (${phN})`, nRegs
    ).catch(() => []);

    // cod → codFornec
    const codToFornec = {};
    for (const p of prodRows) {
      const cf = nRegFornecMap[p.nReg];
      if (cf) codToFornec[p.cod] = cf;
    }
    const codigos = Object.keys(codToFornec);
    if (!codigos.length) return res.json({ comprador: comp, totais:{}, fornecedores:[] });
    const phC = codigos.map(() => '?').join(',');

    // 4. Vendas UNION ALL 6 lojas (usa Custo da zcupomitens = custo real de venda)
    const unionParts = [1,2,3,4,5,6].map(() =>
      `SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor, SUM(Custo) as custo
       FROM \`ln?${mm}\`.zcupomitens
       WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${phC})
       GROUP BY Codigo`
    );
    // substitui ln? pelos números
    const vendasSQL = `SELECT Codigo, SUM(qtd) as qtd, SUM(valor) as valor, SUM(custo) as custo
      FROM (${[1,2,3,4,5,6].map(ln =>
        `SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor, SUM(Custo) as custo
         FROM \`ln${ln}${mm}\`.zcupomitens
         WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${phC})
         GROUP BY Codigo`
      ).join(' UNION ALL ')}) t GROUP BY Codigo`;

    const vendaParams = [];
    for (let i = 0; i < 6; i++) vendaParams.push(dIni, dFim, ...codigos);

    // 5. Avarias filtradas pelos produtos deste comprador — SEM filtro de data
    //    porque avaria em aberto/tramite é acumulada (pode ser de meses anteriores)
    const [vendasRows, avariaRows] = await Promise.all([
      q(vendasSQL, vendaParams).catch(() => []),
      q(`SELECT CodFornec, SUM(Total) as total
         FROM central.avariaconsumo
         WHERE CodigoBarras IN (${phC}) AND CodFornec > 0
           AND Status IN (0,2)
         GROUP BY CodFornec`, [...codigos]).catch(() => [])
    ]);

    // Monta maps
    const vendasMap = {};
    for (const r of vendasRows) vendasMap[r.Codigo] = { valor: parseFloat(r.valor), custo: parseFloat(r.custo || 0) };
    const avariaMap = {};
    for (const r of avariaRows) avariaMap[r.CodFornec] = parseFloat(r.total || 0);

    // Agrega por fornecedor
    const fMap = {};
    for (const cod of codigos) {
      const cf = codToFornec[cod];
      const v  = vendasMap[cod] || { valor:0, custo:0 };
      if (!fMap[cf]) fMap[cf] = { venda:0, custo:0, lucro:0 };
      fMap[cf].venda += v.valor;
      fMap[cf].custo += v.custo;
      fMap[cf].lucro += v.valor - v.custo;
    }

    const result = codFornecs
      .filter(cf => fMap[cf] && fMap[cf].venda > 0)
      .map(cf => {
        const m  = fMap[cf];
        const av = avariaMap[cf] || 0;
        return {
          id:     cf,
          nome:   fornecNome[cf] || `Fornec ${cf}`,
          venda:  +m.venda.toFixed(2),
          custo:  +m.custo.toFixed(2),
          lucro:  +m.lucro.toFixed(2),
          msv:    m.venda > 0 ? +(m.lucro/m.venda*100).toFixed(2) : 0,
          msc:    m.custo > 0 ? +(m.lucro/m.custo*100).toFixed(2) : 0,
          avaria: +av.toFixed(2),
          pct_av: m.venda > 0 ? +(av/m.venda*100).toFixed(2) : 0
        };
      })
      .sort((a,b) => b.venda - a.venda);

    const tv = result.reduce((s,r)=>s+r.venda,0);
    const tl = result.reduce((s,r)=>s+r.lucro,0);
    const tc = result.reduce((s,r)=>s+r.custo,0);
    const ta = result.reduce((s,r)=>s+r.avaria,0);
    res.json({
      comprador: comp, mes: mesSel, ano: anoSel,
      totais: {
        venda:  +tv.toFixed(2), lucro: +tl.toFixed(2), custo: +tc.toFixed(2),
        msv:    tv > 0 ? +(tl/tv*100).toFixed(2) : 0,
        msc:    tc > 0 ? +(tl/tc*100).toFixed(2) : 0,
        avaria: +ta.toFixed(2)
      },
      fornecedores: result
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ruptura/comprador-listas', withCache(60), async (req, res) => {
  const result = {};
  for (const [nome, nRegs] of Object.entries(NREGS_COMPRADOR)) result[nome] = nRegs;
  res.json(result);
});

// Distribuição por loja dos produtos de uma lista de compra
app.get('/api/ruptura/lista-lojas', async (req, res) => {
  const listaId = parseInt(req.query.listaId);
  if (!listaId) return res.status(400).json({ error: 'listaId obrigatório' });
  try {
    // Todos os produtos da lista
    const itens = await q(
      `SELECT li.Codigobarra, i.Descricao
       FROM central.c_cotacao_lista_itens li
       LEFT JOIN central.itens i ON i.CodigoBarra = li.Codigobarra AND i.CodDesativado = 0
       WHERE li.nCotacao = ?
       ORDER BY i.Descricao`,
      [listaId]
    );
    if (!itens.length) return res.json({ total: 0, lojas: {} });

    const barcodes = itens.map(r => r.Codigobarra);
    const placeholders = barcodes.map(() => '?').join(',');

    // Consulta paralela nas 6 lojas
    const estoques = await Promise.all([1,2,3,4,5,6].map(ln =>
      q(`SELECT CodigoBarra, Qtd FROM central.estoquen${ln}
         WHERE CodigoBarra IN (${placeholders})`, barcodes)
    ));

    const NOMES = { 1:'CAHU', 2:'MURIBECA', 3:'PONTE', 4:'ATACAREJO', 5:'PORTA LARGA', 6:'JARDIM JORDAO' };
    const lojas = {};
    for (let i = 0; i < 6; i++) {
      const ln = i + 1;
      const mapa = {};
      estoques[i].forEach(r => { mapa[r.CodigoBarra] = parseFloat(r.Qtd) || 0; });
      const comEstoque    = barcodes.filter(cb => (mapa[cb] || 0) > 0).length;
      const semEstoque    = barcodes.filter(cb => (mapa[cb] || 0) === 0).length;
      const negativos     = barcodes.filter(cb => (mapa[cb] || 0) < 0).length;
      const naoEncontrado = barcodes.filter(cb => mapa[cb] === undefined).length;
      lojas[ln] = { nome: NOMES[ln], comEstoque, semEstoque, negativos, naoEncontrado, total: barcodes.length };
    }

    // Detalhe produto a produto por loja
    const detalhe = itens.map(item => {
      const row = { codigo: item.Codigobarra, produto: item.Descricao || item.Codigobarra };
      for (let i = 0; i < 6; i++) {
        const ln = i + 1;
        const mapa = {};
        estoques[i].forEach(r => { mapa[r.CodigoBarra] = parseFloat(r.Qtd); });
        const qtd = mapa[item.Codigobarra];
        row['l'+ln] = qtd === undefined ? null : qtd;
      }
      return row;
    });

    res.json({ total: barcodes.length, lojas, detalhe });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ruptura', withCache(10), async (req, res) => {
  try {
    const hoje = new Date();
    const mes = hoje.getMonth() + 1;
    const mesPrev = mes === 1 ? 12 : mes - 1;
    const mm = mesDB(mes);
    const mmPrev = mesDB(mesPrev);
    const DIAS = 30;
    const dIni = new Date(hoje.getTime() - DIAS * 86400000);
    const dIniStr = dIni.toISOString().slice(0, 10);
    const hojStr = hoje.toISOString().slice(0, 10);
    const lojaFiltro = req.query.loja ? parseInt(req.query.loja) : null;
    const compradorFiltro = req.query.comprador || null;
    const LOJAS_ALL = [1, 2, 3, 4, 5, 6];
    const LOJAS = lojaFiltro ? [lojaFiltro] : LOJAS_ALL;
    const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
    const MIN_COB = 10;  // mínimo ideal de cobertura em dias
    const MAX_COB = 50;  // máximo ideal (acima = excesso de estoque)
    const LEAD = 3;      // lead time para alerta sem pedido

    // Passo 1: produtos + estoque
    // Com comprador: listas via NREGS_COMPRADOR (Excel)
    // Sem comprador: todos os itens de todas as listas ativas
    let prods;
    if (compradorFiltro) {
      const compKey = compradorFiltro.normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase();
      const listIds = NREGS_COMPRADOR[compKey] || [];
      if (!listIds.length) {
        return res.json({
          resumo: { total_rupturas: 0, em_risco: 0, sem_pedido: 0, excesso: 0, alertas: 0, perdaDia: 0, perdaSemana: 0 },
          rupturas: [], em_risco: [], sem_pedido: [], excesso: [], alertas: [], plano: [], lojas: [], previsao: {},
          resumo_texto: `Nenhuma lista encontrada para o comprador ${compradorFiltro}.`
        });
      }
      const phL = listIds.map(() => '?').join(',');
      prods = await q(`
        SELECT DISTINCT i.nInterno, i.CodigoBarra, i.Descricao,
               cli.nCotacao as listaId, l.CodFornec as codFornec,
               COALESCE(NULLIF(TRIM(l.NomeFornec),''), NULLIF(TRIM(l.Nome),''), 'N/I') as fornecedor
        FROM central.c_cotacao_lista_itens cli
        JOIN central.itens i ON i.CodigoBarra = cli.Codigobarra AND i.CodDesativado = 0
        LEFT JOIN central.c_cotacao_lista l ON l.nReg = cli.nCotacao
        WHERE cli.nCotacao IN (${phL})
      `, listIds).catch(e => { throw new Error('PRODS_QUERY:' + e.message); });
    } else {
      prods = await q(`
        SELECT DISTINCT i.nInterno, i.CodigoBarra, i.Descricao,
               cli.nCotacao as listaId, l.CodFornec as codFornec,
               COALESCE(NULLIF(TRIM(l.NomeFornec),''), NULLIF(TRIM(l.Nome),''), 'N/I') as fornecedor
        FROM central.c_cotacao_lista_itens cli
        JOIN central.itens i ON i.CodigoBarra = cli.Codigobarra AND i.CodDesativado = 0
        LEFT JOIN central.c_cotacao_lista l ON l.nReg = cli.nCotacao
      `, []).catch(() => []);
    }

    if (!prods.length) return res.json({
      resumo: { total_rupturas: 0, em_risco: 0, sem_pedido: 0, excesso: 0, alertas: 0, perdaDia: 0, perdaSemana: 0 },
      rupturas: [], em_risco: [], sem_pedido: [], excesso: [], alertas: [], plano: [], lojas: [], previsao: {},
      resumo_texto: 'Nenhum produto encontrado na lista de compras.'
    });

    // Busca estoque por loja em paralelo (separado para evitar timeout)
    const barcodes = [...new Set(prods.map(p => p.CodigoBarra).filter(Boolean))];
    if (barcodes.length) {
      const phB = barcodes.map(() => '?').join(',');
      const estoqueQs = [1,2,3,4,5,6].map(n =>
        q(`SELECT CodigoBarra, Qtd FROM central.estoquen${n} WHERE CodigoBarra IN (${phB})`, barcodes).catch(() => [])
      );
      const estoqueArr = await Promise.all(estoqueQs);
      const estoqueMap = {};
      estoqueArr.forEach((rows, idx) => {
        const lojaNum = idx + 1;
        for (const r of rows) {
          if (!estoqueMap[r.CodigoBarra]) estoqueMap[r.CodigoBarra] = {};
          estoqueMap[r.CodigoBarra][lojaNum] = parseFloat(r.Qtd) || 0;
        }
      });
      for (const p of prods) {
        const em = estoqueMap[p.CodigoBarra] || {};
        p.est1 = em[1] || 0; p.est2 = em[2] || 0; p.est3 = em[3] || 0;
        p.est4 = em[4] || 0; p.est5 = em[5] || 0; p.est6 = em[6] || 0;
      }
    }

    // Passo 2: vendas dos 30 dias para esses produtos, por loja
    const salesMap = {};
    const salesQs = LOJAS.flatMap(l => [
      q(`SELECT Codigo, ${l} as l, SUM(QtdNovo) as qt, SUM(ValorTotalNovo) as vl
         FROM \`ln${l}${mm}\`.zcupomitens
         WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (?)
         GROUP BY Codigo`, [dIniStr, hojStr, barcodes]).catch(() => []),
      q(`SELECT Codigo, ${l} as l, SUM(QtdNovo) as qt, SUM(ValorTotalNovo) as vl
         FROM \`ln${l}${mmPrev}\`.zcupomitens
         WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (?)
         GROUP BY Codigo`, [dIniStr, hojStr, barcodes]).catch(() => [])
    ]);
    const salesArr = await Promise.all(salesQs);
    for (const rows of salesArr) {
      for (const r of rows) {
        const ean = r.Codigo; const loja = Number(r.l);
        if (!salesMap[ean]) salesMap[ean] = {};
        if (!salesMap[ean][loja]) salesMap[ean][loja] = { qt: 0, vl: 0 };
        salesMap[ean][loja].qt += parseFloat(r.qt) || 0;
        salesMap[ean][loja].vl += parseFloat(r.vl) || 0;
      }
    }

    const rupturas = [], emRisco = [], semPedido = [], excesso = [], alertas = [];

    for (const prod of prods) {
      const ean = prod.CodigoBarra;
      const saleProd = salesMap[ean] || {};
      for (const loja of LOJAS) {
        const sale = saleProd[loja];
        const estoque = parseFloat(prod[`est${loja}`]) || 0;
        const qt = sale ? parseFloat(sale.qt) || 0 : 0;
        const vl = sale ? parseFloat(sale.vl) || 0 : 0;
        if (qt <= 0 && estoque >= 0) continue; // sem venda e sem problema de estoque
        const vmd = qt / DIAS;
        const vmd_valor = vl / DIAS;
        const cobertura = vmd > 0 ? Math.max(0, estoque) / vmd : (estoque > 0 ? 999 : 0);

        const item = {
          loja, lj: LOJAS_NOMES[loja], nInterno: prod.nInterno, ean,
          produto: prod.Descricao, fornecedor: prod.fornecedor || 'N/I',
          listaId: prod.listaId, codFornec: prod.codFornec || 0,
          estoque: +estoque.toFixed(2), vmd: +vmd.toFixed(3),
          vmd_valor: +vmd_valor.toFixed(2), cobertura: +cobertura.toFixed(1)
        };

        if (estoque <= 0 && qt > 0) {
          rupturas.push({ ...item, risco: 'RUPTURA', cobertura: 0 });
        } else if (cobertura < MIN_COB) {
          if (cobertura <= 1)       emRisco.push({ ...item, risco: 'CRITICO' });
          else if (cobertura <= 3)  emRisco.push({ ...item, risco: 'ALTO' });
          else if (cobertura <= 7)  emRisco.push({ ...item, risco: 'MEDIO' });
          else                      emRisco.push({ ...item, risco: 'BAIXO' }); // 7-10 dias
        } else if (cobertura > MAX_COB && cobertura < 999) {
          excesso.push({ ...item, risco: 'EXCESSO' });
        }

        if (cobertura > 0 && cobertura <= LEAD && qt > 0) {
          semPedido.push({ ...item, motivo: `${cobertura.toFixed(1)}d de cobertura` });
          alertas.push({ tipo: 'SEM_PEDIDO', ...item, msg: `${prod.Descricao} (${LOJAS_NOMES[loja]}): ${cobertura.toFixed(1)}d restantes` });
        }
        if (estoque < 0) alertas.push({ tipo: 'NEGATIVO', ...item, msg: `Estoque negativo: ${prod.Descricao} (${LOJAS_NOMES[loja]}): ${estoque}` });
      }
    }

    rupturas.sort((a, b) => b.vmd_valor - a.vmd_valor);
    emRisco.sort((a, b) => a.cobertura - b.cobertura);
    semPedido.sort((a, b) => a.cobertura - b.cobertura);
    excesso.sort((a, b) => b.cobertura - a.cobertura);

    const perdaDia = rupturas.reduce((s, r) => s + r.vmd_valor, 0);

    // Ranking por fornecedor/lista
    const fornecMap = {};
    const addFornec = (arr, tipo) => {
      for (const r of arr) {
        const key = r.listaId || 0;
        if (!fornecMap[key]) fornecMap[key] = { listaId: key, fornecedor: r.fornecedor || 'N/I', codFornec: r.codFornec || 0, rupturas: 0, em_risco: 0, urgencia: 0, excesso: 0, perda: 0, lojas: new Set() };
        fornecMap[key][tipo]++;
        fornecMap[key].lojas.add(r.lj);
        if (tipo === 'rupturas') fornecMap[key].perda += r.vmd_valor || 0;
      }
    };
    addFornec(rupturas, 'rupturas');
    addFornec(emRisco.filter(x => ['CRITICO','ALTO'].includes(x.risco)), 'urgencia');
    addFornec(emRisco.filter(x => ['MEDIO','BAIXO'].includes(x.risco)), 'em_risco');
    addFornec(excesso, 'excesso');
    const rankingFornec = Object.values(fornecMap)
      .map(f => ({ ...f, lojas: [...f.lojas].join(', '), score: f.rupturas * 10 + f.urgencia * 5 + f.em_risco * 2 + f.excesso }))
      .sort((a, b) => b.score - a.score);
    const lojasMap = {};
    for (const loja of LOJAS) lojasMap[loja] = { loja, nome: LOJAS_NOMES[loja], rupturas: 0, em_risco: 0, excesso: 0, perda: 0 };
    for (const r of rupturas)  { lojasMap[r.loja].rupturas++;  lojasMap[r.loja].perda += r.vmd_valor; }
    for (const r of emRisco)     lojasMap[r.loja].em_risco++;
    for (const r of excesso)     lojasMap[r.loja].excesso++;

    const plano = [];
    for (const p of semPedido.slice(0, 5))  plano.push({ prioridade: 1, tipo: 'COMPRA',     acao: `Emitir pedido: ${p.produto} → ${p.lj} (${p.cobertura}d restantes, VMD R$ ${p.vmd_valor.toFixed(2)})` });
    for (const r of rupturas.slice(0, 5))   plano.push({ prioridade: 2, tipo: 'RUPTURA',    acao: `Ruptura urgente: ${r.produto} → ${r.lj} (perdendo R$ ${r.vmd_valor.toFixed(2)}/dia)` });
    for (const a of alertas.filter(x => x.tipo === 'NEGATIVO').slice(0, 3)) plano.push({ prioridade: 3, tipo: 'INVENTARIO', acao: `Inventário: ${a.produto} → ${a.lj} (estoque negativo)` });

    const nCritico = emRisco.filter(x => ['CRITICO','ALTO'].includes(x.risco)).length;
    const txt = `${prods.length} produto(s) monitorados da lista de compras. ` +
      `${rupturas.length} em ruptura (estoque zerado com vendas ativas). ` +
      `${emRisco.length} abaixo do mínimo de ${MIN_COB} dias de cobertura. ` +
      `${excesso.length} com excesso (acima de ${MAX_COB} dias). ` +
      `Perda estimada por ruptura: R$ ${perdaDia.toLocaleString('pt-BR',{minimumFractionDigits:2})}/dia. ` +
      `${nCritico > 0 ? `${nCritico} produto(s) em risco crítico/alto (≤ 3 dias).` : 'Nenhum produto em risco crítico.'} ` +
      `Faixa ideal de cobertura: ${MIN_COB} a ${MAX_COB} dias (VMD 30 dias).`;

    res.json({
      gerado_em: new Date().toISOString(),
      loja_filtro: lojaFiltro,
      min_cob: MIN_COB, max_cob: MAX_COB,
      resumo: { total_rupturas: rupturas.length, urgencia: nCritico, em_risco: emRisco.length - nCritico, sem_pedido: semPedido.length, excesso: excesso.length, alertas: alertas.length, perdaDia, perdaSemana: perdaDia * 7 },
      resumo_texto: txt,
      rupturas: rupturas.slice(0, 300),
      em_risco: emRisco.slice(0, 300),
      sem_pedido: semPedido.slice(0, 100),
      excesso: excesso.slice(0, 200),
      alertas: alertas.slice(0, 100),
      plano,
      lojas: Object.values(lojasMap).sort((a, b) => b.perda - a.perda),
      ranking_fornec: rankingFornec.slice(0, 50),
      previsao: {
        hoje: rupturas.length,
        amanha: emRisco.filter(x => x.risco === 'CRITICO').length,
        tres_dias: emRisco.filter(x => ['CRITICO','ALTO'].includes(x.risco)).length,
        sete_dias: emRisco.filter(x => ['CRITICO','ALTO','MEDIO'].includes(x.risco)).length,
        quinze_dias: emRisco.length
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

q(`CREATE TABLE IF NOT EXISTS central.prevencao_bonif (
  nLoja INT NOT NULL, mes VARCHAR(7) NOT NULL, valor DECIMAL(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (nLoja, mes)) ENGINE=InnoDB`).catch(() => {});


app.get('/api/_diag/tabelas-central', async (req, res) => {
  if (req.query.token !== 'diag2026') return res.status(403).end();
  const t = (req.query.describe || '').replace(/[^a-z0-9_]/gi, '');
  if (t) {
    const cols = await q(`DESCRIBE central.\`${t}\``).catch(e => [{err:e.message}]);
    const sample = await q(`SELECT * FROM central.\`${t}\` LIMIT 1`).catch(() => []);
    return res.json({ cols, sample });
  }
  if (req.query.sql) {
    const rows = await q(req.query.sql).catch(e => [{err:e.message}]);
    return res.json(rows);
  }
  res.json({ ok: 1 });
});

// ── CONCILIADOR BANCÁRIO ─────────────────────────────────
// Cruza as saídas de um extrato bancário (TXT colado pelo usuário) com os
// títulos de contas a pagar do ERP. Ver lib/conciliador.js pra detalhes de
// como o casamento (Valor + DataVencto) e os status são decididos.
async function processarConciliacao(saidas, loja) {
  const datas = saidas.map(s => s.data).sort();
  const dIni = addDias(datas[0], -TOLERANCIA_CONCILIADOR);
  const dFim = addDias(datas[datas.length - 1], TOLERANCIA_CONCILIADOR);

  // Cada loja tem conta bancária própria — o extrato de uma loja só pode
  // estar pagando títulos daquela mesma Filial no ERP, então restringe
  // aqui pra não casar por coincidência de valor com título de outra loja.
  const candidatosRaw = await q(`
    SELECT a.nReg, a.Valor, a.Devedor, DATE_FORMAT(a.DataVencto,'%Y-%m-%d') as DataVencto,
           a.CodFornec, a.Historico, a.Filial, a.PlanoGrupo, a.PlanoSub,
           a.Acrescimo, a.Multa, a.Juros, a.Desconto, a.Devolucao, a.ValorBruto, f.Nome, f.NomeCompleto
    FROM loja20045.contasapagar a
    LEFT JOIN central.fornecedor f ON f.CodFornec = a.CodFornec
    WHERE a.DataVencto BETWEEN ? AND ? AND a.Filial = ?
  `, [dIni, dFim, loja]);
  const candidatos = enriquecerComPlanoContas(candidatosRaw, await getPlanoContas());

  const itens = aplicarAvulsos(conciliar(saidas, candidatos), carregarAvulsos());
  const resumo = { conciliado: 0, conciliado_avulso: 0, pago_sem_baixa: 0, divergencia: 0, revisar: 0, nao_encontrado: 0, fora_escopo: 0 };
  let totalValor = 0;
  for (const it of itens) { resumo[it.status]++; totalValor += it.valor; }

  return { loja, total: itens.length, totalValor: +totalValor.toFixed(2), resumo, itens };
}

app.post('/api/conciliador/processar', async (req, res) => {
  try {
    const texto = (req.body && req.body.texto) || '';
    const loja = parseInt(req.body && req.body.loja);
    if (!texto.trim()) return res.status(400).json({ error: 'Cole o extrato antes de processar.' });
    if (!loja || loja < 1 || loja > 6) return res.status(400).json({ error: 'Selecione a loja desse extrato antes de processar — cada loja tem conta bancária própria, e o casamento é feito só contra os títulos dessa filial.' });

    const ehOfx = /<OFX>|<STMTTRN>/i.test(texto);
    const saidas = ehOfx ? parseSaidasOfx(texto) : parseSaidas(texto);
    if (!saidas.length) return res.status(400).json({ error: ehOfx ? 'Nenhuma saída encontrada no OFX.' : 'Nenhuma saída encontrada no texto colado. Confira o formato (data;histórico;valor;).' });

    res.json(await processarConciliacao(saidas, loja));
  } catch (err) {
    console.error('[CONCILIADOR-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao processar conciliação.' });
  }
});

// Mesma conciliação acima, mas a origem do extrato é a API oficial do Itaú
// (lib/itau-extrato.js) em vez de texto colado — só disponível pras contas
// já liberadas pelo banco (hoje: cahu, muribeca — ver data/itau/config.json).
// A loja (Filial do ERP) continua escolhida manualmente pelo usuário, igual
// ao fluxo de colar texto — não existe hoje um mapeamento automático
// confiável de conta bancária pra número de Filial no ERP.
app.post('/api/conciliador/processar-api', async (req, res) => {
  if (!req.session.user || req.session.user.perfil !== 'admin') return res.status(403).json({ error: 'Só admin.' });
  try {
    const itauExtrato = require('./lib/itau-extrato');
    const conta = req.body && req.body.conta;
    const loja = parseInt(req.body && req.body.loja);
    if (!conta) return res.status(400).json({ error: 'Informe a conta (ex: cahu, muribeca).' });
    if (!loja || loja < 1 || loja > 6) return res.status(400).json({ error: 'Selecione a loja desse extrato antes de processar — cada loja tem conta bancária própria, e o casamento é feito só contra os títulos dessa filial.' });

    const dataFim = (req.body && req.body.fim) || new Date().toISOString().slice(0, 10);
    const dataIni = (req.body && req.body.inicio) || addDias(dataFim, -60);
    const resultado = await itauExtrato.buscarExtrato({ conta, dataInicio: dataIni, dataFim });
    const saidas = parseSaidasApi(resultado);
    if (!saidas.length) return res.status(400).json({ error: `Nenhuma saída encontrada no extrato da API entre ${dataIni} e ${dataFim}.` });

    res.json(await processarConciliacao(saidas, loja));
  } catch (err) {
    console.error('[CONCILIADOR-API-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao importar extrato via API do Itaú.' });
  }
});

// Busca títulos do ERP com valor PRÓXIMO (não exato) do valor da saída —
// usado quando o boleto foi pago com juros/multa e por isso não bate valor
// exato com nenhum título (o motor automático só faz match exato).
app.post('/api/conciliador/buscar-proximos', async (req, res) => {
  try {
    const { valor, data, loja } = req.body || {};
    if (!valor || !data) return res.status(400).json({ error: 'Informe valor e data da saída.' });
    if (!loja || loja < 1 || loja > 6) return res.status(400).json({ error: 'Loja inválida.' });
    const TOL_VALOR = 15;
    const dIni = addDias(data, -TOLERANCIA_CONCILIADOR);
    const dFim = addDias(data, TOLERANCIA_CONCILIADOR);

    const candidatos = await q(`
      SELECT a.nReg, a.Valor, a.Devedor, DATE_FORMAT(a.DataVencto,'%Y-%m-%d') as DataVencto,
             a.CodFornec, a.Historico, a.Filial, a.PlanoGrupo, a.PlanoSub,
             a.Acrescimo, a.Multa, a.Juros, a.Desconto, a.Devolucao, a.ValorBruto, f.Nome, f.NomeCompleto
      FROM loja20045.contasapagar a
      LEFT JOIN central.fornecedor f ON f.CodFornec = a.CodFornec
      WHERE a.DataVencto BETWEEN ? AND ? AND a.Filial = ? AND ABS(a.Valor - ?) <= ?
      ORDER BY ABS(a.Valor - ?) ASC
      LIMIT 25
    `, [dIni, dFim, loja, valor, TOL_VALOR, valor]);
    const plano = await getPlanoContas();

    res.json({
      candidatos: candidatos.map(c => ({
        nReg: c.nReg,
        fornecedor: c.NomeCompleto || c.Nome || '(sem cadastro)',
        codFornec: c.CodFornec,
        valor: Number(c.Valor),
        devedor: Number(c.Devedor),
        dataVencto: c.DataVencto,
        historico: c.Historico,
        filial: c.Filial,
        planoGrupo: c.PlanoGrupo,
        planoSub: c.PlanoSub,
        planoGrupoNome: plano.grupoMap.get(c.PlanoGrupo) || null,
        planoSubNome: plano.subMap.get(`${c.PlanoGrupo}|${c.PlanoSub}`) || null,
        acrescimo: Number(c.Acrescimo) || 0,
        multa: Number(c.Multa) || 0,
        juros: Number(c.Juros) || 0,
        desconto: Number(c.Desconto) || 0,
        devolucao: Number(c.Devolucao) || 0,
        valorBruto: c.ValorBruto != null ? Number(c.ValorBruto) : null,
        diferenca: +(Number(c.Valor) - Number(valor)).toFixed(2)
      }))
    });
  } catch (err) {
    console.error('[CONCILIADOR-PROXIMOS-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao buscar títulos próximos.' });
  }
});

// Confirma um match manual (avulso) com justificativa — persiste em JSON
// local (nunca no MySQL do ERP) pra sobreviver a reprocessar o extrato.
app.post('/api/conciliador/confirmar-avulso', (req, res) => {
  try {
    const { saida, escolha, justificativa } = req.body || {};
    if (!saida || !escolha || !justificativa || !justificativa.trim()) {
      return res.status(400).json({ error: 'Informe a saída, o título escolhido e a justificativa.' });
    }
    const lista = carregarAvulsos();
    const chave = chaveSaida(saida);
    const registro = {
      chave,
      data: saida.data,
      valorSaida: saida.valor,
      historicoSaida: saida.historico,
      favorecidoSaida: saida.favorecido,
      nReg: escolha.nReg,
      fornecedor: escolha.fornecedor,
      codFornec: escolha.codFornec,
      valorErp: escolha.valor,
      dataVencto: escolha.dataVencto,
      historicoErp: escolha.historico,
      filial: escolha.filial,
      planoGrupo: escolha.planoGrupo,
      planoSub: escolha.planoSub,
      planoGrupoNome: escolha.planoGrupoNome,
      planoSubNome: escolha.planoSubNome,
      acrescimo: escolha.acrescimo,
      multa: escolha.multa,
      juros: escolha.juros,
      desconto: escolha.desconto,
      devolucao: escolha.devolucao,
      valorBruto: escolha.valorBruto,
      justificativa: justificativa.trim(),
      confirmadoEm: new Date().toISOString(),
      confirmadoPor: (req.session && req.session.user && req.session.user.nome) || 'desconhecido'
    };
    const idx = lista.findIndex(a => a.chave === chave);
    if (idx >= 0) lista[idx] = registro; else lista.push(registro);
    salvarAvulsos(lista);
    res.json({ ok: true });
  } catch (err) {
    console.error('[CONCILIADOR-AVULSO-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao salvar conciliação avulsa.' });
  }
});

// ── CONCILIADOR CD — SAÍDAS POR DESTINATÁRIO ────────────
// O CD tem conta bancária própria (sem títulos no ERP das lojas pra cruzar),
// então aqui não há casamento com contasapagar — só organiza as saídas do
// extrato (mesmo parser do Conciliador, ver lib/extrato-parser.js) agrupando
// por favorecido, com total e quantidade de lançamentos por pessoa/empresa.
//
// Opcionalmente cruza cada saída com a Entrada de Notas (NFe recebida) de
// uma loja específica — central.compras, Status='F' (fechada) — casando por
// Valor exato dentro de uma janela de data (a nota costuma entrar bem antes
// do boleto ser pago, por isso a janela é assimétrica: bastante tempo antes
// da saída, pouco depois). Valor sozinho casa por coincidência demais num
// universo de milhares de notas de fornecedores diferentes (ex: um SISPAG de
// R$60 pra uma pessoa física "casando" com uma nota de R$60 de uma
// distribuidora de combustível) — por isso também exige similaridade mínima
// entre o favorecido do banco e o fornecedor da nota (mesma função de nome
// usada no Conciliador de loja). Quando mais de uma nota passa no corte de
// similaridade com o mesmo valor, todas ficam expostas como candidatas — a
// de maior similaridade (e, empatando, a mais próxima da data) vira o match
// sugerido, sem esconder a ambiguidade do usuário.
const SIMILARIDADE_MINIMA_NOTA = 0.34;

// similaridadeNome sozinha deixa passar coincidências por sufixo genérico de
// razão social (ex: "W E SPEEDFIBRA LTDA" x "OLINDA COMERCIO DE ALIMENTOS
// LTDA" batem em 0.5 só por causa de "LTDA") — então também exige pelo menos
// uma palavra específica em comum, fora desses termos genéricos.
const TOKENS_GENERICOS_RAZAO_SOCIAL = new Set([
  'LTDA', 'LTD', 'SA', 'EIRELI', 'ME', 'EPP', 'MEI', 'COM', 'COMERCIO',
  'COMERCIAL', 'IMPORTACAO', 'EXPORTACAO', 'INDUSTRIA', 'INDUSTRIAL',
  'ALIMENTOS', 'ALIMENTICIOS', 'DISTRIBUIDORA', 'DISTRIBUICAO'
]);

function temTokenEspecificoComum(a, b) {
  const ta = new Set(normalizarNome(a).split(' ').filter(t => t.length > 2 && !TOKENS_GENERICOS_RAZAO_SOCIAL.has(t)));
  const tb = new Set(normalizarNome(b).split(' ').filter(t => t.length > 2 && !TOKENS_GENERICOS_RAZAO_SOCIAL.has(t)));
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

function diasEntre(a, b) {
  return Math.round(Math.abs(new Date(a) - new Date(b)) / 86400000);
}

async function casarComEntradaNotas(saidas, lojaRecebimento) {
  if (!lojaRecebimento) return saidas;
  const datas = saidas.map(s => s.data).sort();
  const dIni = addDias(datas[0], -60);
  const dFim = addDias(datas[datas.length - 1], 5);

  // DataRecto = quando a mercadoria/nota entrou de fato no ERP (recebimento),
  // diferente de DataEmissao (data que o fornecedor emitiu a NFe — pode ser
  // uns dias antes). Casa pela data de recebimento (mais perto de quando o
  // pagamento sai), mas mostra as duas pro Tiago.
  const candidatos = await q(
    `SELECT nCompra, nNota, NomeFornec, TotalNota, chave, CNPJ,
            DATE_FORMAT(DataRecto,'%Y-%m-%d') as DataRecebimento,
            DATE_FORMAT(DataEmissao,'%Y-%m-%d') as DataEmissao
     FROM central.compras
     WHERE nLoja = ? AND Status = 'F' AND DataRecto BETWEEN ? AND ?`,
    [lojaRecebimento, dIni, dFim]
  );

  const porValor = new Map();
  for (const c of candidatos) {
    const key = Number(c.TotalNota).toFixed(2);
    if (!porValor.has(key)) porValor.set(key, []);
    porValor.get(key).push(c);
  }

  // Valor redondo (R$1.000,00 etc.) colide com dezenas de fornecedores sem
  // relação nenhuma (achado testando: um SISPAG de supermercado "casando"
  // com nota de posto de combustível só pela coincidência do valor) — então
  // só assume um match "por valor" quando ele é o único candidato dentro de
  // uma janela curta e plausível. Se tiver mais de um concorrendo, é ruído
  // demais pra apontar um "melhor palpite": melhor dizer que não é confiável
  // do que arriscar um fornecedor errado.
  const JANELA_VALOR_SOZINHO_DIAS = 20;

  function montarNota(x, confianca) {
    return { nCompra: x.c.nCompra, nNota: x.c.nNota, fornecedor: x.c.NomeFornec, dataEmissao: x.c.DataEmissao, dataRecebimento: x.c.DataRecebimento, chave: x.c.chave, confianca };
  }
  function soDigitos(v) { return (v || '').replace(/\D/g, ''); }

  return saidas.map(s => {
    // Uma só avaliação por candidata: nome (similaridade + token
    // específico) e CNPJ (quando o memo do banco trouxe um documento) —
    // CNPJ batendo já basta pra confirmar sozinho, mesmo se o nome não
    // bater bem (razão social pode vir abreviada/diferente no banco).
    const docSaida = s.tipoDocumento === 'CNPJ' ? soDigitos(s.documento) : '';
    const poolBruto = (porValor.get(s.valor.toFixed(2)) || []).map(c => {
      const sim = similaridadeNome(s.favorecido, c.NomeFornec);
      const cnpjBate = !!docSaida && docSaida === soDigitos(c.CNPJ);
      const nomeConfere = cnpjBate || (sim >= SIMILARIDADE_MINIMA_NOTA && temTokenEspecificoComum(s.favorecido, c.NomeFornec));
      return { c, sim, cnpjBate, nomeConfere, dias: diasEntre(s.data, c.DataRecebimento) };
    });

    const comNome = poolBruto.filter(x => x.nomeConfere).sort((a, b) => (b.cnpjBate - a.cnpjBate) || (b.sim - a.sim) || (a.dias - b.dias));

    // CNPJ batendo em exatamente uma candidata resolve sozinho, mesmo se
    // o nome deixou mais de uma passar no corte de similaridade — CNPJ é
    // prova definitiva, não precisa de escolha manual nesse caso.
    const cnpjUnico = comNome.filter(x => x.cnpjBate);
    if (cnpjUnico.length === 1) {
      return { ...s, nota: montarNota(cnpjUnico[0], 'nome'), notaCandidatos: [] };
    }
    if (comNome.length === 1) {
      return { ...s, nota: montarNota(comNome[0], 'nome'), notaCandidatos: [] };
    }
    if (comNome.length > 1) {
      // Mais de uma nota do mesmo fornecedor com o valor idêntico — não
      // escolhe pela data mais próxima sozinho, deixa o Tiago decidir (ele
      // pediu: "fica na dúvida qual é a nota certa").
      return { ...s, nota: null, notaCandidatos: comNome.map(x => montarNota(x, 'nome')) };
    }

    const proximos = poolBruto.filter(x => x.dias <= JANELA_VALOR_SOZINHO_DIAS).sort((a, b) => a.dias - b.dias);
    if (proximos.length === 1) {
      return { ...s, nota: montarNota(proximos[0], 'valor'), notaCandidatos: [] };
    }
    if (poolBruto.length) {
      // Ambíguo: não escolhe por conta própria — expõe todas as candidatas
      // (ordenadas pela mais próxima da data) pro Tiago escolher manualmente
      // qual é a nota certa (ver /api/conciliador-cd/confirmar-nota).
      const ordenadas = [...poolBruto].sort((a, b) => a.dias - b.dias);
      return { ...s, nota: null, notaCandidatos: ordenadas.map(x => montarNota(x, 'valor')) };
    }
    return { ...s, nota: null, notaCandidatos: [] };
  });
}

// Notas confirmadas manualmente pelo Tiago quando o valor bate em mais de
// uma nota (ver casarComEntradaNotas) — persistidas em JSON local, mesmo
// padrão de conciliacoes-avulsas.json, pra sobreviver a reprocessar o
// extrato. Uma vez confirmada, a nota vira confiança 'manual' (pintada de
// verde igual 'nome') e nunca mais volta a ficar ambígua nesse item.
const CD_NOTAS_AVULSAS_PATH = path.join(__dirname, 'data', 'cd-notas-avulsas.json');
function carregarCdNotasAvulsas() {
  try { return JSON.parse(fs.readFileSync(CD_NOTAS_AVULSAS_PATH, 'utf8')); } catch (e) { return []; }
}
function salvarCdNotasAvulsas(lista) {
  fs.mkdirSync(path.dirname(CD_NOTAS_AVULSAS_PATH), { recursive: true });
  fs.writeFileSync(CD_NOTAS_AVULSAS_PATH, JSON.stringify(lista, null, 2));
}
async function aplicarCdNotasAvulsas(saidas) {
  const avulsos = carregarCdNotasAvulsas();
  if (!avulsos.length) return saidas;

  // Sempre reconfere a chave pelo nCompra (não só quando falta) — evita
  // ficar com uma chaveNfe desatualizada/errada presa no JSON (ex: avulso
  // salvo antes desse campo existir direito, ou qualquer inconsistência
  // passada) fazendo "ver nota" dar XML não encontrado à toa.
  const comNCompra = avulsos.filter(a => a.nCompra);
  if (comNCompra.length) {
    const nCompras = [...new Set(comNCompra.map(a => a.nCompra))];
    const rows = await q(`SELECT nCompra, chave FROM central.compras WHERE nCompra IN (?)`, [nCompras]).catch(() => []);
    const chavePorCompra = new Map(rows.map(r => [r.nCompra, r.chave]));
    let mudou = false;
    for (const a of comNCompra) {
      const chave = chavePorCompra.get(a.nCompra);
      if (chave && chave !== a.chaveNfe) { a.chaveNfe = chave; mudou = true; }
    }
    if (mudou) salvarCdNotasAvulsas(avulsos);
  }

  const porChave = new Map(avulsos.map(a => [a.chave, a]));
  return saidas.map(s => {
    const av = porChave.get(chaveSaida(s));
    if (!av) return s;
    if (av.semNota) {
      // Tiago revisou e confirmou que nenhuma nota candidata é essa saída —
      // fica travado em "Não encontrada", não volta a mostrar as candidatas
      // ambíguas de novo a cada reprocessamento.
      return { ...s, nota: null, notaCandidatos: [], semNotaConfirmado: true };
    }
    return {
      ...s,
      nota: { nCompra: av.nCompra, nNota: av.nNota, fornecedor: av.fornecedor, dataEmissao: av.dataEmissao, dataRecebimento: av.dataRecebimento, chave: av.chaveNfe, confianca: 'manual' },
      notaCandidatos: []
    };
  });
}

app.post('/api/conciliador-cd/processar', async (req, res) => {
  try {
    const texto = (req.body && req.body.texto) || '';
    const lojaRecebimento = parseInt(req.body && req.body.lojaRecebimento) || null;
    if (!texto.trim()) return res.status(400).json({ error: 'Cole ou importe o extrato antes de processar.' });

    const ehOfx = /<OFX>|<STMTTRN>/i.test(texto);
    let saidas = ehOfx ? parseSaidasOfx(texto) : parseSaidas(texto);
    if (!saidas.length) return res.status(400).json({ error: ehOfx ? 'Nenhuma saída encontrada no OFX.' : 'Nenhuma saída encontrada no texto colado. Confira o formato (data;histórico;valor;).' });

    if (lojaRecebimento) saidas = await aplicarCdNotasAvulsas(await casarComEntradaNotas(saidas, lojaRecebimento));

    const porFavorecido = new Map();
    let totalValor = 0;
    for (const s of saidas) {
      const chave = s.favorecido || '(sem identificação)';
      if (!porFavorecido.has(chave)) porFavorecido.set(chave, { favorecido: chave, total: 0, qtde: 0 });
      const g = porFavorecido.get(chave);
      g.total += s.valor;
      g.qtde++;
      totalValor += s.valor;
    }
    const totais = [...porFavorecido.values()]
      .map(g => ({ ...g, total: +g.total.toFixed(2) }))
      .sort((a, b) => b.total - a.total);

    res.json({ total: saidas.length, totalValor: +totalValor.toFixed(2), itens: saidas, totais, lojaRecebimento });
  } catch (err) {
    console.error('[CONCILIADOR-CD-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao processar extrato do CD.' });
  }
});

// Confirma manualmente qual nota (dentre as candidatas ambíguas de mesmo
// valor) é a certa pra uma saída do CD — ver aplicarCdNotasAvulsas.
app.post('/api/conciliador-cd/confirmar-nota', (req, res) => {
  try {
    const { saida, escolha, semNota } = req.body || {};
    if (!saida || (!escolha && !semNota)) return res.status(400).json({ error: 'Informe a saída e a nota escolhida (ou semNota pra marcar como não encontrada).' });
    const lista = carregarCdNotasAvulsas();
    const chave = chaveSaida(saida);
    const registro = semNota ? {
      chave,
      dataSaida: saida.data, valorSaida: saida.valor, favorecidoSaida: saida.favorecido,
      semNota: true,
      confirmadoEm: new Date().toISOString(),
      confirmadoPor: (req.session && req.session.user && req.session.user.nome) || 'desconhecido'
    } : {
      chave,
      dataSaida: saida.data, valorSaida: saida.valor, favorecidoSaida: saida.favorecido,
      nCompra: escolha.nCompra, nNota: escolha.nNota, fornecedor: escolha.fornecedor, dataEmissao: escolha.dataEmissao, dataRecebimento: escolha.dataRecebimento,
      chaveNfe: escolha.chave,
      confirmadoEm: new Date().toISOString(),
      confirmadoPor: (req.session && req.session.user && req.session.user.nome) || 'desconhecido'
    };
    const idx = lista.findIndex(a => a.chave === chave);
    if (idx >= 0) lista[idx] = registro; else lista.push(registro);
    salvarCdNotasAvulsas(lista);
    res.json({ ok: true });
  } catch (err) {
    console.error('[CONCILIADOR-CD-AVULSO-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao confirmar nota.' });
  }
});

// Detalhe de uma NFe pelo XML autorizado (central.arquivoxml, indexado pela
// chave de acesso de 44 dígitos que já vem em central.compras.chave) — sem
// dependência de lib de XML, extrai só os campos que interessam por regex
// (schema da NFe é fixo/conhecido). Não é um DANFE oficial pixel-perfect,
// mas mostra os dados reais da nota autorizada pela SEFAZ (itens, valores,
// emitente/destinatário, duplicatas, protocolo de autorização).
function tagXml(bloco, nome) {
  const m = bloco.match(new RegExp(`<${nome}>([^<]*)</${nome}>`));
  return m ? m[1] : '';
}
function blocoXml(xml, nome) {
  const m = xml.match(new RegExp(`<${nome}[^>]*>([\\s\\S]*?)<\\/${nome}>`));
  return m ? m[1] : '';
}
function extrairNotaXml(xmlCompleto) {
  const inf = blocoXml(xmlCompleto, 'infNFe') || xmlCompleto;
  const ide = blocoXml(inf, 'ide');
  const emit = blocoXml(inf, 'emit');
  const dest = blocoXml(inf, 'dest');
  const total = blocoXml(inf, 'ICMSTot');
  const prot = blocoXml(xmlCompleto, 'protNFe');

  const itens = [...inf.matchAll(/<det nItem="(\d+)">([\s\S]*?)<\/det>/g)].map(m => {
    const prod = blocoXml(m[2], 'prod');
    return {
      item: m[1], codigo: tagXml(prod, 'cProd'), descricao: tagXml(prod, 'xProd'),
      qtd: tagXml(prod, 'qCom'), unidade: tagXml(prod, 'uCom'),
      valorUnit: tagXml(prod, 'vUnCom'), valorTotal: tagXml(prod, 'vProd')
    };
  });

  const duplicatas = [...inf.matchAll(/<dup>([\s\S]*?)<\/dup>/g)].map(m => ({
    numero: tagXml(m[1], 'nDup'), vencimento: tagXml(m[1], 'dVenc'), valor: tagXml(m[1], 'vDup')
  }));

  return {
    numero: tagXml(ide, 'nNF'), serie: tagXml(ide, 'serie'), dataEmissao: tagXml(ide, 'dhEmi'),
    naturezaOperacao: tagXml(ide, 'natOp'),
    emitente: { nome: tagXml(emit, 'xNome'), fantasia: tagXml(emit, 'xFant'), cnpj: tagXml(emit, 'CNPJ'), ie: tagXml(emit, 'IE') },
    destinatario: { nome: tagXml(dest, 'xNome'), cnpj: tagXml(dest, 'CNPJ') },
    itens,
    valorProdutos: tagXml(total, 'vProd'),
    desconto: tagXml(total, 'vDesc'),
    frete: tagXml(total, 'vFrete'),
    outrasDespesas: tagXml(total, 'vOutro'),
    valorTotal: tagXml(total, 'vNF'),
    duplicatas,
    protocolo: { numero: tagXml(prot, 'nProt'), dataRecebimento: tagXml(prot, 'dhRecbto'), status: tagXml(prot, 'xMotivo'), chave: tagXml(prot, 'chNFe') }
  };
}

app.get('/api/conciliador-cd/nota-detalhe', async (req, res) => {
  try {
    const chave = (req.query.chave || '').replace(/[^0-9]/g, '');
    if (chave.length !== 44) return res.status(400).json({ error: 'Chave de acesso inválida.' });
    const [rows, compraRows] = await Promise.all([
      q('SELECT xml FROM central.arquivoxml WHERE chave = ?', [chave]),
      // NomeConferente costuma vir "0" (não confiável) — quem processou o
      // recebimento de fato é NomeOperador; DataConferencia/HoraConferencia
      // é quando a conferência da mercadoria foi fechada. Isso não é parte
      // do XML fiscal, é dado operacional interno do ERP.
      q(`SELECT NomeOperador, DATE_FORMAT(DataConferencia,'%Y-%m-%d') as DataConferencia, HoraConferencia, Movimentacao
         FROM central.compras WHERE chave = ? LIMIT 1`, [chave]).catch(() => [])
    ]);
    if (!rows.length || !rows[0].xml) return res.status(404).json({ error: 'XML da nota não encontrado no ERP.' });
    const detalhe = extrairNotaXml(rows[0].xml);
    const c = compraRows[0];
    if (c) {
      detalhe.recebimento = { operador: c.NomeOperador || null, data: c.DataConferencia || null, hora: c.HoraConferencia || null };
      detalhe.movimentacao = c.Movimentacao || null;
    }
    res.json(detalhe);
  } catch (err) {
    console.error('[CD-NOTA-DETALHE-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao buscar detalhe da nota.' });
  }
});

// ── API DE EXTRATO DO ITAÚ ───────────────────────────────────────────
// Teste manual da integração direta com o Itaú (ver lib/itau-extrato.js).
// Só admin, porque toca em credencial bancária real. Suporta múltiplas
// contas (uma por loja/CNPJ) via ?conta=cahu|muribeca — cada uma com seu
// próprio certificado + ClientID em data/itau/config.json.
app.get('/api/itau/extrato-teste', async (req, res) => {
  if (!req.session.user || req.session.user.perfil !== 'admin') return res.status(403).json({ error: 'Só admin.' });
  try {
    const itauExtrato = require('./lib/itau-extrato');
    const conta = req.query.conta;
    if (!conta) return res.status(400).json({ error: 'Informe ?conta= (opções: ' + itauExtrato.contasConfiguradas().join(', ') + ')' });
    const dataFim = req.query.fim || new Date().toISOString().slice(0, 10);
    const dataIni = req.query.inicio || addDias(dataFim, -30);
    const resultado = await itauExtrato.buscarExtrato({ conta, dataInicio: dataIni, dataFim: dataFim });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONTROLE DE PONTA DE GÔNDOLA ────────────────────────────────────
// Digitaliza o painel físico da sala de compras: quem negocia, qual
// fornecedor ocupa a ponta, vigência do acordo e o contrato assinado.
const uploadContrato = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(pontaGondola.CONTRATOS_DIR, { recursive: true });
      cb(null, pontaGondola.CONTRATOS_DIR);
    },
    filename: (req, file, cb) => cb(null, `ponta-${req.params.id}-${Date.now()}.pdf`)
  }),
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// Autocomplete de fornecedor pro Controle de Ponta de Gôndola — busca no
// cadastro do ERP pra trazer a razão social certa (ex: digitar "sao braz"
// já mostra "SAO BRAZ CIA IND DE ALIMENTOS").
app.get('/api/fornecedores/buscar', async (req, res) => {
  try {
    const termo = (req.query.q || '').trim();
    if (termo.length < 2) return res.json([]);
    const rows = await q(
      'SELECT CodFornec, Nome, NomeCompleto FROM central.fornecedor WHERE Nome LIKE ? OR NomeCompleto LIKE ? ORDER BY NomeCompleto LIMIT 15',
      [`%${termo}%`, `%${termo}%`]
    );
    res.json(rows.map(r => ({ codFornec: r.CodFornec, nome: r.NomeCompleto || r.Nome })));
  } catch (err) {
    console.error('[FORNECEDORES-BUSCA-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao buscar fornecedor.' });
  }
});

app.get('/api/pontas-gondola', (req, res) => {
  const lista = pontaGondola.comPlano(pontaGondola.carregarPontas());
  res.json({ lojas: pontaGondola.LOJAS, pontas: lista });
});

app.delete('/api/pontas-gondola/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const lista = pontaGondola.carregarPontas();
  const idx = lista.findIndex(p => p.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Ponta não encontrada.' });
  lista.splice(idx, 1);
  pontaGondola.salvarPontas(lista);
  res.json({ ok: true });
});

app.post('/api/pontas-gondola/loja/:loja/adicionar', (req, res) => {
  const loja = parseInt(req.params.loja);
  if (!pontaGondola.LOJAS[loja]) return res.status(400).json({ error: 'Loja inválida.' });
  const lista = pontaGondola.carregarPontas();
  const maiorId = lista.reduce((m, p) => Math.max(m, p.id), 0);
  const maiorNumero = lista.filter(p => p.loja === loja).reduce((m, p) => Math.max(m, p.numero), 0);
  const nova = {
    id: maiorId + 1, loja, numero: maiorNumero + 1,
    comprador: null, fornecedor: null, inicio: null, fim: null, valor: null,
    contratoArquivo: null, contratoEnviadoEm: null, contratoEnviadoPor: null,
    atualizadoEm: null, atualizadoPor: null
  };
  lista.push(nova);
  pontaGondola.salvarPontas(lista);
  res.json({ ok: true, ponta: nova });
});

app.post('/api/pontas-gondola/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { comprador, fornecedor, inicio, fim, valor } = req.body || {};
  const lista = pontaGondola.carregarPontas();
  const ponta = lista.find(p => p.id === id);
  if (!ponta) return res.status(404).json({ error: 'Ponta não encontrada.' });
  ponta.comprador = comprador || null;
  ponta.fornecedor = fornecedor || null;
  ponta.inicio = inicio || null;
  ponta.fim = fim || null;
  ponta.valor = (valor !== '' && valor != null) ? +parseFloat(valor).toFixed(2) : null;
  ponta.atualizadoEm = new Date().toISOString();
  ponta.atualizadoPor = (req.session && req.session.user && req.session.user.nome) || 'desconhecido';
  pontaGondola.salvarPontas(lista);
  res.json({ ok: true, ponta });
});

app.get('/api/pontas-gondola/:id/modelo.pdf', (req, res) => {
  const id = parseInt(req.params.id);
  const ponta = pontaGondola.carregarPontas().find(p => p.id === id);
  if (!ponta) return res.status(404).json({ error: 'Ponta não encontrada.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="contrato-ponta-${ponta.loja}-${ponta.numero}.pdf"`);
  pontaGondola.gerarModeloPdf(ponta, res);
});

app.post('/api/pontas-gondola/:id/contrato', uploadContrato.single('contrato'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'Envie um arquivo PDF.' });
    const lista = pontaGondola.carregarPontas();
    const ponta = lista.find(p => p.id === id);
    if (!ponta) return res.status(404).json({ error: 'Ponta não encontrada.' });
    if (ponta.contratoArquivo) {
      fs.unlink(path.join(pontaGondola.CONTRATOS_DIR, ponta.contratoArquivo), () => {});
    }
    ponta.contratoArquivo = req.file.filename;
    ponta.contratoEnviadoEm = new Date().toISOString();
    ponta.contratoEnviadoPor = (req.session && req.session.user && req.session.user.nome) || 'desconhecido';
    pontaGondola.salvarPontas(lista);
    res.json({ ok: true, ponta });
  } catch (err) {
    console.error('[PONTA-GONDOLA-UPLOAD-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao enviar contrato.' });
  }
});

app.get('/api/pontas-gondola/:id/contrato', (req, res) => {
  const id = parseInt(req.params.id);
  const ponta = pontaGondola.carregarPontas().find(p => p.id === id);
  if (!ponta || !ponta.contratoArquivo) return res.status(404).json({ error: 'Sem contrato enviado pra essa ponta.' });
  res.sendFile(path.join(pontaGondola.CONTRATOS_DIR, ponta.contratoArquivo));
});

// Keepalive: garante que o processo não saia mesmo sem conexões ativas
setInterval(() => {}, 30000);

const server = app.listen(3003, '0.0.0.0', () => {
  console.log('✓ Dashboard rodando em http://localhost:3003');
  backfillPlanoAvulsos();
  const ipLocal = Object.values(require('os').networkInterfaces())
    .flat().find(i => i.family === 'IPv4' && !i.internal)?.address;
  if (ipLocal) console.log(`✓ Rede local: http://${ipLocal}:3003`);
  setTimeout(() => {
    const http = require('http');
    http.get('http://127.0.0.1:3003/api/ruptura', res => {
      res.resume();
      console.log('✓ Cache ruptura pré-aquecido');
    }).on('error', () => {});
    // Pré-aquecer resumo de fornecedores para todas as lojas
    const hoje = new Date();
    const mes = hoje.getMonth() + 1;
    const ano = hoje.getFullYear();
    [1,2,3,4,5,6].forEach((ln, i) => {
      setTimeout(() => {
        http.get({
          host: '127.0.0.1', port: 3003,
          path: `/api/fornecedores/resumo?loja=${ln}&mes=${mes}&ano=${ano}`,
          headers: { 'x-internal-warmup': 'fc360warmup2026' }
        }, r => {
          r.resume();
          console.log(`✓ Cache fornecedores loja ${ln} pré-aquecido`);
        }).on('error', () => {});
      }, i * 2000); // 2s entre cada loja
    });
  }, 3000);
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('[PORTA] 3003 em uso, aguardando 5s...');
    setTimeout(() => server.listen(3003, '0.0.0.0'), 5000);
  } else {
    console.error('[SERVER ERROR]', err.message);
  }
});

process.on('uncaughtException', err => {
  console.error('uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
