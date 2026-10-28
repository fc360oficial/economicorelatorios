'use strict';
// lib/espelho-erp.js — Espelho do ERP no nosso Postgres (banco economicogestao). Tiago, 28/10/2026: o ERP (.252, MySQL
// 5.0) estava lento e 18 das 42 consultas rodando eram nossas, somas de mês inteiro de zcupomitens que levam 10 min.
// Regra: no .252 só SELECT, nunca KILL, nunca escrita. Então a gente copia pra cá e as telas leem daqui.
//
// O que copia (fase 1 — vendas):
//   venda_dia_produto  (loja, dia, codigo) → qtd, valor, custo, desconto, itens, cupons   — soma do dia por produto
//   venda_dia_loja     (loja, dia)         → totais do dia + linhas_erp (conferência) + copiado_em
// Como copia: UMA consulta por loja e dia no ERP ("SELECT ... WHERE Data = ? GROUP BY Codigo", índice por data, ~0,1 s),
// nunca mês inteiro. Um dia copiado substitui o anterior inteiro (DELETE + INSERT na mesma transação), então cupom
// cancelado ou reprocessado depois entra na recópia.
//   · hoje: todas as lojas a cada 15 min (7 consultas leves)
//   · madrugada 01:30: recopia os últimos 3 dias (cancelamentos/reprocessamento) e manda aviso se falhou
//   · histórico: 5 anos pra trás, do dia mais recente pro mais antigo, só na janela 20:00–07:00 (ou "Rodar agora"),
//     uma consulta por vez com pausa entre elas; retoma de onde parou depois de reinício
// Lojas: 1..6 e 10 (CD). Bancos do ERP: ln{loja}mes{MM}.zcupomitens, todos os anos dentro do mesmo banco do mês.
//
// Saúde do ERP: SHOW FULL PROCESSLIST (só leitura) resumido — quantas consultas são nossas, as mais longas, trancadas.
const os = require('os');
const pg = require('./pg');

const LOJAS = [1, 2, 3, 4, 5, 6, 10];
const ANOS_HISTORICO = 5;
const JANELA_INI = 20 * 60, JANELA_FIM = 7 * 60;          // minutos do dia: histórico roda das 20:00 às 07:00
const PAUSA_ENTRE_DIAS_MS = 250, LOTE_INSERT = 500;
const HOJE_CADA_MS = 15 * 60 * 1000;
const HORA_MADRUGADA = '01:30', RECOPIAR_DIAS = 3;
const TIMEOUT_ERP_MS = 120000;

let deps = {}, pronto = false, erroEsquema = null;
let feitos = new Set();                                     // "loja|dia" já copiados (carregado do banco no início)
let historico = { rodando: false, forcado: false, pausado: false, porLoja: {}, iniciadoEm: null, ultimoErro: null, loop: null };
let hoje = { ultimaEm: null, ultimoErro: null, ms: null, rodando: false };
let madrugada = { ultimaEm: null, ultimoErro: null, feitaHoje: null };
let copias = [];                                            // últimas 60 cópias (memória) {em, loja, dia, linhas, ms, erro}
let config = { grupo: '', avisar: false };
let saudeCache = { em: 0, dados: null };

// ── datas (sempre local, 'YYYY-MM-DD') ──────────────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
function isoLocal(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hojeLocal() { return isoLocal(new Date()); }
function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); }
function mesDB(iso) { return 'mes' + iso.slice(5, 7); }
function minutosAgora() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function naJanela() { const m = minutosAgora(); return m >= JANELA_INI || m < JANELA_FIM; }
const chave = (loja, dia) => `${loja}|${dia}`;
const dorme = ms => new Promise(r => setTimeout(r, ms));

// ── esquema ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function criarEsquema() {
  await pg.pq(`CREATE TABLE IF NOT EXISTS venda_dia_produto (
    dia date NOT NULL, loja smallint NOT NULL, codigo varchar(14) NOT NULL,
    qtd numeric(14,3) NOT NULL DEFAULT 0, valor numeric(14,2) NOT NULL DEFAULT 0, custo numeric(14,2) NOT NULL DEFAULT 0,
    desconto numeric(14,2) NOT NULL DEFAULT 0, itens integer NOT NULL DEFAULT 0, cupons integer NOT NULL DEFAULT 0,
    PRIMARY KEY (loja, dia, codigo)
  ) PARTITION BY RANGE (dia)`);
  const anoIni = new Date().getFullYear() - ANOS_HISTORICO - 1, anoFim = new Date().getFullYear() + 1;
  for (let a = anoIni; a <= anoFim; a++) {
    await pg.pq(`CREATE TABLE IF NOT EXISTS venda_dia_produto_${a} PARTITION OF venda_dia_produto FOR VALUES FROM ('${a}-01-01') TO ('${a + 1}-01-01')`);
  }
  await pg.pq(`CREATE INDEX IF NOT EXISTS venda_dia_produto_codigo ON venda_dia_produto (codigo, dia)`);
  await pg.pq(`CREATE TABLE IF NOT EXISTS venda_dia_loja (
    dia date NOT NULL, loja smallint NOT NULL,
    valor numeric(14,2) NOT NULL DEFAULT 0, custo numeric(14,2) NOT NULL DEFAULT 0, qtd numeric(14,3) NOT NULL DEFAULT 0,
    desconto numeric(14,2) NOT NULL DEFAULT 0, itens integer NOT NULL DEFAULT 0, cupons integer NOT NULL DEFAULT 0,
    produtos integer NOT NULL DEFAULT 0, linhas_erp integer NOT NULL DEFAULT 0, ms integer, copiado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (loja, dia)
  )`);
  await pg.pq(`CREATE TABLE IF NOT EXISTS espelho_kv (chave text PRIMARY KEY, valor jsonb NOT NULL, em timestamptz NOT NULL DEFAULT now())`);
  await pg.pq(`CREATE TABLE IF NOT EXISTS espelho_copias (id bigserial PRIMARY KEY, em timestamptz NOT NULL DEFAULT now(), loja smallint, dia date, linhas integer, ms integer, erro text, origem text)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS espelho_copias_em ON espelho_copias (em DESC)`);
}
async function kvLer(c, padrao) { const r = await pg.pq('SELECT valor FROM espelho_kv WHERE chave = $1', [c]); return r.length ? r[0].valor : padrao; }
async function kvGravar(c, v) { await pg.pq('INSERT INTO espelho_kv (chave, valor, em) VALUES ($1, $2, now()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, em = now()', [c, JSON.stringify(v)]); }

// ── cópia de um dia de uma loja ──────────────────────────────────────────────────────────────────────────────────
async function copiarDia(loja, dia, origem) {
  const t0 = Date.now();
  const tabela = `\`ln${loja}${mesDB(dia)}\`.zcupomitens`;
  let linhasErp = 0, rows = [];
  try {
    const [tot] = await deps.q(`SELECT COUNT(*) n FROM ${tabela} WHERE Data = ?`, [dia], { timeoutMs: TIMEOUT_ERP_MS });
    linhasErp = Number(tot && tot.n) || 0;
    if (linhasErp) {
      rows = await deps.q(`SELECT Codigo codigo, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) valor, SUM(Custo) custo,
                                  SUM(COALESCE(TotalDesconto, 0)) desconto, COUNT(*) itens,
                                  COUNT(DISTINCT CONCAT(nECF, '-', CCF, '-', COO)) cupons
                           FROM ${tabela} WHERE Data = ? AND IndCancel = 'N' GROUP BY Codigo`, [dia], { timeoutMs: TIMEOUT_ERP_MS });
    }
  } catch (e) {
    const ms = Date.now() - t0;
    registrarCopia({ loja, dia, linhas: null, ms, erro: e.message, origem });
    throw e;
  }
  const tot = { valor: 0, custo: 0, qtd: 0, desconto: 0, itens: 0, cupons: 0, produtos: rows.length };
  for (const r of rows) { tot.valor += +r.valor || 0; tot.custo += +r.custo || 0; tot.qtd += +r.qtd || 0; tot.desconto += +r.desconto || 0; tot.itens += +r.itens || 0; }
  await pg.tx(async c => {
    await c.query('DELETE FROM venda_dia_produto WHERE loja = $1 AND dia = $2', [loja, dia]);
    for (let i = 0; i < rows.length; i += LOTE_INSERT) {
      const lote = rows.slice(i, i + LOTE_INSERT); const vals = [], ph = [];
      lote.forEach((r, j) => {
        const b = j * 9;
        ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
        vals.push(dia, loja, String(r.codigo).slice(0, 14), +r.qtd || 0, +r.valor || 0, +r.custo || 0, +r.desconto || 0, +r.itens || 0, +r.cupons || 0);
      });
      await c.query(`INSERT INTO venda_dia_produto (dia, loja, codigo, qtd, valor, custo, desconto, itens, cupons) VALUES ${ph.join(',')}
                     ON CONFLICT (loja, dia, codigo) DO UPDATE SET qtd = EXCLUDED.qtd, valor = EXCLUDED.valor, custo = EXCLUDED.custo, desconto = EXCLUDED.desconto, itens = EXCLUDED.itens, cupons = EXCLUDED.cupons`, vals);
    }
    // cupons do dia = cupons distintos da loja (não a soma por produto, que repete o mesmo cupom em vários produtos)
    const ms = Date.now() - t0;
    await c.query(`INSERT INTO venda_dia_loja (dia, loja, valor, custo, qtd, desconto, itens, cupons, produtos, linhas_erp, ms, copiado_em)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
                   ON CONFLICT (loja, dia) DO UPDATE SET valor = EXCLUDED.valor, custo = EXCLUDED.custo, qtd = EXCLUDED.qtd, desconto = EXCLUDED.desconto,
                     itens = EXCLUDED.itens, cupons = EXCLUDED.cupons, produtos = EXCLUDED.produtos, linhas_erp = EXCLUDED.linhas_erp, ms = EXCLUDED.ms, copiado_em = now()`,
      [dia, loja, +tot.valor.toFixed(2), +tot.custo.toFixed(2), +tot.qtd.toFixed(3), +tot.desconto.toFixed(2), tot.itens, 0, tot.produtos, linhasErp, ms]);
  });
  // cupons distintos do dia inteiro: uma consulta a mais só quando o dia tem venda (leve, mesmo índice)
  if (linhasErp) {
    try {
      const [c] = await deps.q(`SELECT COUNT(DISTINCT CONCAT(nECF, '-', CCF, '-', COO)) n FROM ${tabela} WHERE Data = ? AND IndCancel = 'N'`, [dia], { timeoutMs: TIMEOUT_ERP_MS });
      await pg.pq('UPDATE venda_dia_loja SET cupons = $3 WHERE loja = $1 AND dia = $2', [loja, dia, Number(c && c.n) || 0]);
    } catch (e) { /* fica sem cupons; não derruba a cópia */ }
  }
  feitos.add(chave(loja, dia));
  registrarCopia({ loja, dia, linhas: rows.length, ms: Date.now() - t0, erro: null, origem });
  return { loja, dia, linhas: rows.length, linhasErp, ms: Date.now() - t0 };
}
function registrarCopia(c) {
  const reg = { em: new Date().toISOString(), ...c };
  copias.unshift(reg); if (copias.length > 60) copias.length = 60;
  pg.pq('INSERT INTO espelho_copias (loja, dia, linhas, ms, erro, origem) VALUES ($1,$2,$3,$4,$5,$6)', [c.loja, c.dia, c.linhas, c.ms, c.erro ? String(c.erro).slice(0, 300) : null, c.origem || null]).catch(() => {});
}

// ── hoje (a cada 15 min) ─────────────────────────────────────────────────────────────────────────────────────────
async function sincronizarHoje(origem = 'hoje') {
  if (hoje.rodando) return { ok: false, motivo: 'já rodando' };
  hoje.rodando = true; const t0 = Date.now(); const dia = hojeLocal(); const erros = [];
  try {
    for (const loja of LOJAS) { try { await copiarDia(loja, dia, origem); } catch (e) { erros.push(`loja ${loja}: ${e.message}`); } }
    hoje.ultimaEm = new Date().toISOString(); hoje.ms = Date.now() - t0; hoje.ultimoErro = erros.length ? erros.join(' · ') : null;
    return { ok: !erros.length, erros, ms: hoje.ms };
  } finally { hoje.rodando = false; }
}

// ── madrugada: recopia os últimos N dias ─────────────────────────────────────────────────────────────────────────
async function reconferir(dias = RECOPIAR_DIAS, origem = 'madrugada') {
  const erros = []; const h = hojeLocal();
  for (let i = 1; i <= dias; i++) {
    const dia = somaDias(h, -i);
    for (const loja of LOJAS) { try { await copiarDia(loja, dia, origem); await dorme(100); } catch (e) { erros.push(`loja ${loja} ${dia}: ${e.message}`); } }
  }
  madrugada.ultimaEm = new Date().toISOString(); madrugada.ultimoErro = erros.length ? erros.join(' · ') : null;
  if (erros.length) avisar(`⚠️ Espelho do ERP: a recópia da madrugada falhou em ${erros.length} dia(s)/loja(s).\n${erros.slice(0, 5).join('\n')}`).catch(() => {});
  return { ok: !erros.length, erros };
}

// ── histórico (5 anos pra trás, do mais recente pro mais antigo) ─────────────────────────────────────────────────
function limiteHistorico() { const d = new Date(); d.setFullYear(d.getFullYear() - ANOS_HISTORICO); return isoLocal(d); }
function montarPlano() {
  const ontem = somaDias(hojeLocal(), -1), limite = limiteHistorico();
  let total = 0; const d0 = new Date(limite + 'T12:00:00'), d1 = new Date(ontem + 'T12:00:00');
  total = Math.round((d1 - d0) / 86400000) + 1;
  for (const loja of LOJAS) {
    const p = historico.porLoja[loja] || (historico.porLoja[loja] = { proximo: ontem, feito: 0, total, erros: 0, ultimoErro: null, terminou: false });
    p.total = total; p.limite = limite;
    // conta o que já está no banco (retoma de onde parou)
    let feito = 0; for (let d = ontem; d >= limite; d = somaDias(d, -1)) if (feitos.has(chave(loja, d))) feito++;
    p.feito = feito; p.terminou = feito >= total;
  }
}
function proximoDiaPendente(loja) {
  const p = historico.porLoja[loja]; if (!p || p.terminou) return null;
  let d = p.proximo || somaDias(hojeLocal(), -1);
  while (d >= p.limite && feitos.has(chave(loja, d))) d = somaDias(d, -1);
  if (d < p.limite) { p.terminou = true; return null; }
  p.proximo = d; return d;
}
async function loopHistorico() {
  if (historico.rodando) return;
  historico.rodando = true; historico.iniciadoEm = historico.iniciadoEm || new Date().toISOString();
  try {
    while (!historico.pausado) {
      if (!historico.forcado && !naJanela()) { await dorme(60000); continue; }
      // roda as lojas em rodízio: um dia de cada, pra todas avançarem juntas (a tela Fornecedores usa mês atual de cada loja)
      let fezAlgo = false;
      for (const loja of LOJAS) {
        if (historico.pausado) break;
        const dia = proximoDiaPendente(loja); if (!dia) continue;
        fezAlgo = true; const p = historico.porLoja[loja];
        try { await copiarDia(loja, dia, 'historico'); p.feito++; p.ultimoErro = null; }
        catch (e) { p.erros++; p.ultimoErro = `${dia}: ${e.message}`; historico.ultimoErro = `loja ${loja} ${dia}: ${e.message}`; await dorme(5000); }
        await dorme(PAUSA_ENTRE_DIAS_MS);
      }
      if (!fezAlgo) { historico.terminadoEm = new Date().toISOString(); break; }
      if (Math.random() < 0.02) await kvGravar('historico', { porLoja: historico.porLoja, em: new Date().toISOString() }).catch(() => {});
    }
  } finally { historico.rodando = false; historico.forcado = false; }
}

// ── leitura pras telas ───────────────────────────────────────────────────────────────────────────────────────────
// Tem todos os dias de dIni..min(dFim, hoje) copiados pra cada loja? Se sim, devolve as somas do período por produto no
// mesmo formato que a tela Fornecedores já usava do ERP ({Codigo, qtd, valor, custo_total}); senão null (cai pro ERP).
async function vendaPeriodoProduto(lojas, dIni, dFim) {
  if (!pronto) return null;
  const h = hojeLocal(); const fim = dFim > h ? h : dFim; if (fim < dIni) return null;
  const nDias = Math.round((new Date(fim + 'T12:00:00') - new Date(dIni + 'T12:00:00')) / 86400000) + 1;
  const cont = await pg.pq('SELECT loja, COUNT(*) n FROM venda_dia_loja WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 GROUP BY loja', [lojas, dIni, fim]);
  for (const loja of lojas) { const c = cont.find(x => +x.loja === +loja); if (!c || Number(c.n) < nDias) return null; }
  const rows = await pg.pq(`SELECT loja, codigo "Codigo", SUM(qtd) qtd, SUM(valor) valor, SUM(custo) custo_total
                            FROM venda_dia_produto WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 GROUP BY loja, codigo`, [lojas, dIni, fim]);
  const porLoja = {}; for (const loja of lojas) porLoja[loja] = [];
  for (const r of rows) porLoja[r.loja].push({ Codigo: r.Codigo, qtd: r.qtd, valor: r.valor, custo_total: r.custo_total });
  return porLoja;
}
function cobertura(lojas, dIni, dFim) {
  // só memória (feitos): quantos dias do período cada loja tem
  const h = hojeLocal(); const fim = dFim > h ? h : dFim; const out = {};
  for (const loja of lojas) { let n = 0, tot = 0; for (let d = dIni; d <= fim; d = somaDias(d, 1)) { tot++; if (feitos.has(chave(loja, d))) n++; } out[loja] = { dias: n, total: tot }; }
  return out;
}

// ── saúde do ERP (SHOW FULL PROCESSLIST, só leitura) ─────────────────────────────────────────────────────────────
async function saudeErp() {
  if (saudeCache.dados && Date.now() - saudeCache.em < 20000) return saudeCache.dados;
  const nos = os.hostname().toLowerCase();
  const lista = await deps.q('SHOW FULL PROCESSLIST', [], { timeoutMs: 15000 });
  const hostDe = p => String(p.Host || '').split(':')[0];
  const ativas = lista.filter(p => p.Command !== 'Sleep' && !/PROCESSLIST/i.test(String(p.Info || '')));
  const nossas = ativas.filter(p => hostDe(p).toLowerCase() === nos);
  const porHost = {}; for (const p of lista) { const h = hostDe(p); porHost[h] = porHost[h] || { conexoes: 0, ativas: 0 }; porHost[h].conexoes++; if (p.Command !== 'Sleep') porHost[h].ativas++; }
  const resumoLinha = p => ({ host: hostDe(p), nossa: hostDe(p).toLowerCase() === nos, db: p.db, seg: Number(p.Time) || 0, estado: p.State || '', sql: String(p.Info || '').replace(/\s+/g, ' ').slice(0, 160) });
  const dados = {
    em: new Date().toISOString(), nos: os.hostname(),
    conexoes: lista.length, ativas: ativas.length, nossasAtivas: nossas.length, nossasConexoes: lista.filter(p => hostDe(p).toLowerCase() === nos).length,
    trancadas: ativas.filter(p => /locked/i.test(String(p.State || ''))).map(resumoLinha),
    maisLongas: ativas.slice().sort((a, b) => (Number(b.Time) || 0) - (Number(a.Time) || 0)).slice(0, 8).map(resumoLinha),
    nossasMaisLongas: nossas.slice().sort((a, b) => (Number(b.Time) || 0) - (Number(a.Time) || 0)).slice(0, 6).map(resumoLinha),
    porHost: Object.entries(porHost).map(([host, v]) => ({ host, nossa: host.toLowerCase() === nos, ...v })).sort((a, b) => b.ativas - a.ativas || b.conexoes - a.conexoes).slice(0, 12),
  };
  saudeCache = { em: Date.now(), dados };
  return dados;
}

// ── avisos ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function avisar(texto) {
  if (!config.avisar || !deps.enviarWpp) return false;
  try { await deps.enviarWpp({ grupo: config.grupo || undefined, texto }); return true; }
  catch (e) { console.error('[ESPELHO] aviso WhatsApp falhou:', e.message); return false; }
}

// ── status pra tela ──────────────────────────────────────────────────────────────────────────────────────────────
async function status() {
  let banco = null, erroBanco = null, tamanhos = null;
  try {
    banco = await pg.testar();
    tamanhos = (await pg.pq(`SELECT (SELECT COUNT(*) FROM venda_dia_loja) dias, (SELECT COUNT(*) FROM venda_dia_produto) linhas,
                                    (SELECT MIN(dia) FROM venda_dia_loja) primeiro, (SELECT MAX(dia) FROM venda_dia_loja) ultimo,
                                    (SELECT pg_size_pretty(COALESCE(SUM(pg_total_relation_size(inhrelid)), 0)) FROM pg_inherits WHERE inhparent = 'venda_dia_produto'::regclass) tam_produto`))[0];
  } catch (e) { erroBanco = e.message; }
  let hojePorLoja = [];
  try { hojePorLoja = await pg.pq(`SELECT loja, valor, cupons, produtos, linhas_erp, to_char(copiado_em, 'HH24:MI') copiado FROM venda_dia_loja WHERE dia = $1 ORDER BY loja`, [hojeLocal()]); } catch (e) {}
  const porLoja = {}; for (const loja of LOJAS) { const p = historico.porLoja[loja]; porLoja[loja] = p ? { feito: p.feito, total: p.total, proximo: p.terminou ? null : p.proximo, erros: p.erros, ultimoErro: p.ultimoErro, terminou: p.terminou } : null; }
  const feitoTot = Object.values(porLoja).reduce((s, p) => s + (p ? p.feito : 0), 0), totalTot = Object.values(porLoja).reduce((s, p) => s + (p ? p.total : 0), 0);
  return {
    pronto, erroEsquema, banco, erroBanco, tamanhos, lojas: LOJAS, anos: ANOS_HISTORICO, janela: '20:00–07:00',
    hoje: { ...hoje, dia: hojeLocal(), porLoja: hojePorLoja },
    madrugada, historico: { rodando: historico.rodando, forcado: historico.forcado, pausado: historico.pausado, naJanela: naJanela(), iniciadoEm: historico.iniciadoEm, terminadoEm: historico.terminadoEm || null, ultimoErro: historico.ultimoErro, feito: feitoTot, total: totalTot, limite: limiteHistorico(), porLoja },
    copias: copias.slice(0, 40), config,
  };
}

// ── ações da tela ────────────────────────────────────────────────────────────────────────────────────────────────
async function acao(nome) {
  if (!pronto) throw new Error(erroEsquema ? 'Espelho sem banco: ' + erroEsquema : 'Espelho ainda não iniciou');
  if (nome === 'hoje') return sincronizarHoje('manual');
  if (nome === 'reconferir') return reconferir(RECOPIAR_DIAS, 'manual');
  if (nome === 'historico') { historico.pausado = false; historico.forcado = true; montarPlano(); loopHistorico().catch(e => { historico.ultimoErro = e.message; }); return { ok: true, rodando: true }; }
  if (nome === 'pausar') { historico.pausado = true; return { ok: true }; }
  if (nome === 'retomar') { historico.pausado = false; montarPlano(); loopHistorico().catch(e => { historico.ultimoErro = e.message; }); return { ok: true }; }
  throw new Error('ação desconhecida');
}
async function salvarConfig(p) {
  if (p.grupo != null) config.grupo = String(p.grupo).slice(0, 80);
  if (p.avisar != null) config.avisar = !!p.avisar;
  await kvGravar('config', config).catch(() => {});
  return config;
}

// ── início ───────────────────────────────────────────────────────────────────────────────────────────────────────
let timers = [];
function init(d) {
  deps = d || {};
  if (!pg.disponivel()) { erroEsquema = 'data/pg-economico.json não existe nesta máquina'; console.log('[ESPELHO] Postgres não configurado; telas seguem no ERP'); return; }
  (async () => {
    try {
      await criarEsquema();
      config = { ...config, ...(await kvLer('config', {})) };
      const dias = await pg.pq('SELECT loja, dia FROM venda_dia_loja');
      feitos = new Set(dias.map(r => chave(r.loja, r.dia)));
      const salvo = await kvLer('historico', null); if (salvo && salvo.porLoja) historico.porLoja = salvo.porLoja;
      montarPlano();
      pronto = true;
      console.log(`[ESPELHO] pronto: ${feitos.size} dias copiados; histórico ${Object.values(historico.porLoja).reduce((s, p) => s + p.feito, 0)}/${Object.values(historico.porLoja).reduce((s, p) => s + p.total, 0)} dias`);
      // hoje: já na subida (90 s depois, pra não brigar com a partida) e a cada 15 min
      timers.push(setTimeout(() => sincronizarHoje().catch(() => {}), 90 * 1000));
      timers.push(setInterval(() => sincronizarHoje().catch(() => {}), HOJE_CADA_MS));
      // madrugada 01:30 + histórico na janela (checa a cada minuto)
      timers.push(setInterval(() => {
        const d = new Date(); const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`; const h = hojeLocal();
        if (hm === HORA_MADRUGADA && madrugada.feitaHoje !== h) { madrugada.feitaHoje = h; reconferir().catch(e => { madrugada.ultimoErro = e.message; }); }
        const pend = LOJAS.some(l => historico.porLoja[l] && !historico.porLoja[l].terminou);
        if (pend && naJanela() && !historico.rodando && !historico.pausado) loopHistorico().catch(e => { historico.ultimoErro = e.message; });
      }, 60 * 1000));
      timers.forEach(t => t.unref && t.unref());
    } catch (e) { erroEsquema = e.message; console.error('[ESPELHO] falhou ao iniciar:', e.message); }
  })();
}

module.exports = { init, status, acao, salvarConfig, saudeErp, vendaPeriodoProduto, cobertura, copiarDia, sincronizarHoje, reconferir, LOJAS, hojeLocal, _estado: () => ({ pronto, feitos: feitos.size, historico, hoje }) };
