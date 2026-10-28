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
//   · 07:40: recopia os últimos 3 dias (cancelamentos/reprocessamento) e manda aviso se falhou
//   · histórico: 5 anos pra trás, do dia mais recente pro mais antigo, só na janela 07:30–19:30 (ou "Rodar agora"),
//     uma consulta por vez com pausa entre elas; retoma de onde parou depois de reinício
// Lojas: 1..6 e 10 (CD). Bancos do ERP: ln{loja}mes{MM}.zcupomitens, todos os anos dentro do mesmo banco do mês.
//
// Saúde do ERP: SHOW FULL PROCESSLIST (só leitura) resumido — quantas consultas são nossas, as mais longas, trancadas.
const os = require('os');
const pg = require('./pg');

const LOJAS = [1, 2, 3, 4, 5, 6, 10];
const ANOS_HISTORICO = 5;
// Tiago, 28/10 à tarde: "à noite não pode carregar porque o .252 para pra backup; o que podemos fazer hoje vamos fazendo
// hoje". Então o histórico roda de DIA, no horário comercial, mais devagar (uma consulta de ~0,1 s a cada 0,4 s), e
// nada toca o ERP de madrugada: a recópia dos últimos dias é às 07:40 e a cópia de hoje só entre 06:00 e 23:45.
const JANELA_INI = 7 * 60 + 30, JANELA_FIM = 19 * 60 + 30;   // minutos do dia: histórico roda das 07:30 às 19:30
const JANELA_TXT = '07:30–19:30';
const PAUSA_ENTRE_DIAS_MS = 400, LOTE_INSERT = 500;
const HOJE_CADA_MS = 15 * 60 * 1000, HOJE_INI = 6 * 60, HOJE_FIM = 23 * 60 + 45;
const HORA_MADRUGADA = '07:40', RECOPIAR_DIAS = 3;
const TIMEOUT_ERP_MS = 120000;

let deps = {}, pronto = false, erroEsquema = null;
let feitos = new Set();                                     // "loja|dia" já copiados (carregado do banco no início)
let historico = { rodando: false, forcado: false, pausado: false, porLoja: {}, iniciadoEm: null, ultimoErro: null, loop: null };
let hoje = { ultimaEm: null, ultimoErro: null, ms: null, rodando: false };
let madrugada = { ultimaEm: null, ultimoErro: null, feitaHoje: null };
let copias = [];                                            // últimas 60 cópias (memória) {em, loja, dia, linhas, ms, erro}
// backupIni/backupFim (Tiago, 28/10: "vamos tentar fazer todo backup até as 23 horas ou 23:59"): janela em que o .252
// está em backup. Nenhum robô nosso toca o ERP nela, e qualquer consulta nossa desiste em 15 s (server.js q()).
let config = { grupo: '', avisar: false, backupIni: '22:00', backupFim: '23:59' };
const hhmmOk = h => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || ''));
const hhmmMin = h => { const [a, b] = String(h).split(':').map(Number); return a * 60 + b; };
function emBackup(d) {
  if (!hhmmOk(config.backupIni) || !hhmmOk(config.backupFim)) return false;
  const m = d ? d.getHours() * 60 + d.getMinutes() : minutosAgora();
  const i = hhmmMin(config.backupIni), f = hhmmMin(config.backupFim);
  return i <= f ? (m >= i && m <= f) : (m >= i || m <= f);   // vira a meia-noite se fim < início
}
let saudeCache = { em: 0, dados: null };

// ── datas (sempre local, 'YYYY-MM-DD') ──────────────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
function isoLocal(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hojeLocal() { return isoLocal(new Date()); }
function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); }
function mesDB(iso) { return 'mes' + iso.slice(5, 7); }
function minutosAgora() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function naJanela() { const m = minutosAgora(); return m >= JANELA_INI && m < JANELA_FIM && !emBackup(); }
function horaDeHoje() { const m = minutosAgora(); return m >= HOJE_INI && m < HOJE_FIM; }
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
  // Fase 5 (28/10 à tarde): nome do produto visto na venda (Top Produtos, Consulta etc. mostram descrição sem ir ao ERP)
  // e cadastro de itens/grupos/setores/marcas copiado 1×/dia (filtros por setor/grupo/fornecedor/preço sem o .252).
  await pg.pq(`CREATE TABLE IF NOT EXISTS produto_nome (codigo varchar(14) PRIMARY KEY, descricao varchar(60) NOT NULL, visto_em date NOT NULL)`);
  await pg.pq(`CREATE TABLE IF NOT EXISTS cadastro_item (
    codigo varchar(19) PRIMARY KEY, ninterno integer, descricao varchar(60), abreviacao varchar(30), unid varchar(5), tipobalanca varchar(1),
    qtdemb numeric(10,4), codsetor integer, codsubsetor integer, codmarca integer, codgrupo integer, codgruposub integer, codfornecedor integer,
    custo numeric(12,2), ultimocusto numeric(12,2), preco numeric(12,2),
    p1 numeric(12,2), p2 numeric(12,2), p3 numeric(12,2), p4 numeric(12,2), p5 numeric(12,2), p6 numeric(12,2), p10 numeric(12,2),
    l1 smallint, l2 smallint, l3 smallint, l4 smallint, l5 smallint, l6 smallint, l10 smallint,
    desativado smallint NOT NULL DEFAULT 0, abc varchar(1), familia varchar(45), categoria varchar(45), marca varchar(40),
    atualizado_em timestamptz NOT NULL DEFAULT now()
  )`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS cadastro_item_setor ON cadastro_item (codsetor)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS cadastro_item_grupo ON cadastro_item (codgrupo, codgruposub)`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS cadastro_item_fornec ON cadastro_item (codfornecedor)`);
  await pg.pq(`CREATE TABLE IF NOT EXISTS cadastro_setor (codsetor integer PRIMARY KEY, setor varchar(60), ativo smallint)`);
  await pg.pq(`CREATE TABLE IF NOT EXISTS cadastro_grupo (codgrupo integer PRIMARY KEY, descricao varchar(60), desativado smallint)`);
  await pg.pq(`CREATE TABLE IF NOT EXISTS cadastro_gruposub (codsubgrupo integer PRIMARY KEY, codgrupo integer, descricao varchar(60), desativado smallint)`);
  await pg.pq(`CREATE TABLE IF NOT EXISTS cadastro_marca (codmarca integer PRIMARY KEY, descricao varchar(60), desativado smallint)`);
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
      rows = await deps.q(`SELECT Codigo codigo, MAX(Descricao) descricao, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) valor, SUM(Custo) custo,
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
    // nome do produto como saiu no cupom: só atualiza se este dia é mais recente que o último visto
    for (let i = 0; i < rows.length; i += LOTE_INSERT) {
      const lote = rows.slice(i, i + LOTE_INSERT).filter(r => r.descricao); if (!lote.length) continue;
      const vals = [], ph = [];
      lote.forEach((r, j) => { const b = j * 3; ph.push(`($${b + 1},$${b + 2},$${b + 3})`); vals.push(String(r.codigo).slice(0, 14), String(r.descricao).trim().slice(0, 60), dia); });
      await c.query(`INSERT INTO produto_nome (codigo, descricao, visto_em) VALUES ${ph.join(',')}
                     ON CONFLICT (codigo) DO UPDATE SET descricao = EXCLUDED.descricao, visto_em = EXCLUDED.visto_em WHERE produto_nome.visto_em < EXCLUDED.visto_em`, vals);
    }
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
  if (origem !== 'manual' && !horaDeHoje()) return { ok: false, motivo: 'fora do horário' };
  if (origem !== 'manual' && emBackup()) return { ok: false, motivo: `ERP em backup (${config.backupIni}–${config.backupFim})` };
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
  if (erros.length) avisar(`⚠️ Espelho do ERP: a recópia das 07:40 falhou em ${erros.length} dia(s)/loja(s).\n${erros.slice(0, 5).join('\n')}`).catch(() => {});
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
// Base de tudo: o espelho cobre dIni..min(dFim, hoje) pra TODAS as lojas pedidas? Se sim, soma por loja e produto
// (opcionalmente só pros `codigos` pedidos) e devolve linhas {loja, codigo, qtd, valor, custo}; senão null (a tela cai
// pro ERP como antes). Período que começa antes do que o espelho tem → null.
async function temCobertura(lojas, dIni, fim) {
  const nDias = Math.round((new Date(fim + 'T12:00:00') - new Date(dIni + 'T12:00:00')) / 86400000) + 1;
  if (nDias <= 0) return false;
  const cont = await pg.pq('SELECT loja, COUNT(*) n FROM venda_dia_loja WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 GROUP BY loja', [lojas, dIni, fim]);
  for (const loja of lojas) { const c = cont.find(x => +x.loja === +loja); if (!c || Number(c.n) < nDias) return false; }
  return true;
}
async function vendaPeriodo(lojas, dIni, dFim, opt = {}) {
  if (!pronto || !lojas.length) return null;
  const h = hojeLocal(); const fim = dFim > h ? h : dFim; if (fim < dIni) return null;
  if (!(await temCobertura(lojas, dIni, fim))) return null;
  const codigos = Array.isArray(opt.codigos) ? opt.codigos.map(c => String(c).slice(0, 14)) : null;
  if (codigos && !codigos.length) return [];
  return pg.pq(`SELECT loja, codigo, SUM(qtd) qtd, SUM(valor) valor, SUM(custo) custo
                FROM venda_dia_produto WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 ${codigos ? 'AND codigo = ANY($4)' : ''}
                GROUP BY loja, codigo`, codigos ? [lojas, dIni, fim, codigos] : [lojas, dIni, fim]);
}
// Formato que a tela Fornecedores já usava do ERP: { [loja]: [{Codigo, qtd, valor, custo_total}] }
async function vendaPeriodoProduto(lojas, dIni, dFim) {
  const rows = await vendaPeriodo(lojas, dIni, dFim);
  if (!rows) return null;
  const porLoja = {}; for (const loja of lojas) porLoja[loja] = [];
  for (const r of rows) porLoja[r.loja].push({ Codigo: r.codigo, qtd: r.qtd, valor: r.valor, custo_total: r.custo });
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

// ── cadastro (central.itens + setor/grupo/subgrupo/marca), 1× por dia às 07:45 e sob demanda ─────────────────────
const HORA_CADASTRO = '07:45';
let cadastro = { ultimaEm: null, ultimoErro: null, itens: 0, ms: null, rodando: false, feitoHoje: null };
const numBr = v => { if (v == null || v === '') return null; const n = parseFloat(String(v).trim().replace(',', '.')); return isFinite(n) ? n : null; };   // varchar do ERP vem "4,99"
const intOu = v => { const n = parseInt(v, 10); return isFinite(n) ? n : null; };
async function copiarCadastro(origem = 'cadastro') {
  if (cadastro.rodando) return { ok: false, motivo: 'já rodando' };
  cadastro.rodando = true; const t0 = Date.now();
  try {
    const itens = await deps.q(`SELECT nInterno, CodigoBarra, Descricao, Abreviacao, Unid, TipoBalanca, qtdemb, codsetor, CodSubSetor, CodMarca, CodGrupo, CodGrupoSub,
                                       CodFornecedor, custo, UltimoCusto, Preco, P1, P2, P3, P4, P5, P6, P10, L1, L2, L3, L4, L5, L6, L10, CodDesativado, ABC, Familia, Categoria, Marca
                                FROM central.itens`, [], { timeoutMs: 180000 });
    const [setores, grupos, subs, marcas] = await Promise.all([
      deps.q('SELECT CodSetor, Setor, CodAtivo FROM central.setor', [], { timeoutMs: 60000 }).catch(() => []),
      deps.q('SELECT CodGrupo, Descricao, CodDesativado FROM central.grupo', [], { timeoutMs: 60000 }).catch(() => []),
      deps.q('SELECT CodSubGrupo, CodGrupo, Descricao, CodDesativado FROM central.gruposub', [], { timeoutMs: 60000 }).catch(() => []),
      deps.q('SELECT CodMarca, Descricao, CodDesativado FROM central.marca', [], { timeoutMs: 60000 }).catch(() => []),
    ]);
    const COLS = ['codigo', 'ninterno', 'descricao', 'abreviacao', 'unid', 'tipobalanca', 'qtdemb', 'codsetor', 'codsubsetor', 'codmarca', 'codgrupo', 'codgruposub', 'codfornecedor',
      'custo', 'ultimocusto', 'preco', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p10', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l10', 'desativado', 'abc', 'familia', 'categoria', 'marca'];
    const linha = r => [String(r.CodigoBarra || '').trim().slice(0, 19), intOu(r.nInterno), String(r.Descricao || '').trim().slice(0, 60), String(r.Abreviacao || '').trim().slice(0, 30) || null,
      String(r.Unid || '').trim().slice(0, 5) || null, String(r.TipoBalanca || '').slice(0, 1) || null, numBr(r.qtdemb), intOu(r.codsetor), intOu(r.CodSubSetor), intOu(r.CodMarca), intOu(r.CodGrupo), intOu(r.CodGrupoSub),
      intOu(r.CodFornecedor), numBr(r.custo), numBr(r.UltimoCusto), numBr(r.Preco), numBr(r.P1), numBr(r.P2), numBr(r.P3), numBr(r.P4), numBr(r.P5), numBr(r.P6), numBr(r.P10),
      intOu(r.L1), intOu(r.L2), intOu(r.L3), intOu(r.L4), intOu(r.L5), intOu(r.L6), intOu(r.L10), intOu(r.CodDesativado) || 0, String(r.ABC || '').slice(0, 1) || null,
      String(r.Familia || '').trim().slice(0, 45) || null, String(r.Categoria || '').trim().slice(0, 45) || null, String(r.Marca || '').trim().slice(0, 40) || null];
    // central.itens tem código de barras repetido (linha de backup/duplicada): fica a ativa e, em empate, o nInterno maior
    const porCodigo = new Map();
    for (const r of itens) {
      const k = String(r.CodigoBarra || '').trim(); if (!k) continue;
      const a = porCodigo.get(k);
      if (!a || (intOu(r.CodDesativado) || 0) < (intOu(a.CodDesativado) || 0) || ((intOu(r.CodDesativado) || 0) === (intOu(a.CodDesativado) || 0) && (intOu(r.nInterno) || 0) > (intOu(a.nInterno) || 0))) porCodigo.set(k, r);
    }
    const validos = [...porCodigo.values()];
    // marca de tempo ANTES da transação: dentro dela now() é a hora do BEGIN, e as linhas gravadas ficam > marca
    const marca = new Date();
    await dorme(20);
    await pg.tx(async c => {
      const agora = marca;
      for (let i = 0; i < validos.length; i += 300) {
        const lote = validos.slice(i, i + 300); const vals = [], ph = [];
        lote.forEach((r, j) => { const v = linha(r); const b = j * COLS.length; ph.push('(' + v.map((_, k) => `$${b + k + 1}`).join(',') + ',now())'); vals.push(...v); });
        await c.query(`INSERT INTO cadastro_item (${COLS.join(',')}, atualizado_em) VALUES ${ph.join(',')}
                       ON CONFLICT (codigo) DO UPDATE SET ${COLS.filter(x => x !== 'codigo').map(x => `${x} = EXCLUDED.${x}`).join(', ')}, atualizado_em = now()`, vals);
      }
      // item que sumiu do ERP (apagado): marca como desativado, não apaga (histórico de venda aponta pra ele)
      await c.query('UPDATE cadastro_item SET desativado = 9 WHERE atualizado_em < $1 AND desativado <> 9', [agora]);
      for (const s of setores) await c.query('INSERT INTO cadastro_setor (codsetor, setor, ativo) VALUES ($1,$2,$3) ON CONFLICT (codsetor) DO UPDATE SET setor = EXCLUDED.setor, ativo = EXCLUDED.ativo', [intOu(s.CodSetor), String(s.Setor || '').trim().slice(0, 60), intOu(s.CodAtivo)]);
      for (const g of grupos) await c.query('INSERT INTO cadastro_grupo (codgrupo, descricao, desativado) VALUES ($1,$2,$3) ON CONFLICT (codgrupo) DO UPDATE SET descricao = EXCLUDED.descricao, desativado = EXCLUDED.desativado', [intOu(g.CodGrupo), String(g.Descricao || '').trim().slice(0, 60), intOu(g.CodDesativado)]);
      for (const g of subs) await c.query('INSERT INTO cadastro_gruposub (codsubgrupo, codgrupo, descricao, desativado) VALUES ($1,$2,$3,$4) ON CONFLICT (codsubgrupo) DO UPDATE SET codgrupo = EXCLUDED.codgrupo, descricao = EXCLUDED.descricao, desativado = EXCLUDED.desativado', [intOu(g.CodSubGrupo), intOu(g.CodGrupo), String(g.Descricao || '').trim().slice(0, 60), intOu(g.CodDesativado)]);
      for (const m of marcas) await c.query('INSERT INTO cadastro_marca (codmarca, descricao, desativado) VALUES ($1,$2,$3) ON CONFLICT (codmarca) DO UPDATE SET descricao = EXCLUDED.descricao, desativado = EXCLUDED.desativado', [intOu(m.CodMarca), String(m.Descricao || '').trim().slice(0, 60), intOu(m.CodDesativado)]);
    });
    cadastro.ultimaEm = new Date().toISOString(); cadastro.ultimoErro = null; cadastro.itens = validos.length; cadastro.ms = Date.now() - t0;
    registrarCopia({ loja: null, dia: null, linhas: validos.length, ms: cadastro.ms, erro: null, origem });
    console.log(`[ESPELHO] cadastro copiado: ${validos.length} itens, ${setores.length} setores, ${grupos.length} grupos, ${subs.length} subgrupos, ${marcas.length} marcas em ${cadastro.ms} ms`);
    return { ok: true, itens: validos.length, ms: cadastro.ms };
  } catch (e) {
    cadastro.ultimoErro = e.message; registrarCopia({ loja: null, dia: null, linhas: null, ms: Date.now() - t0, erro: e.message, origem });
    throw e;
  } finally { cadastro.rodando = false; }
}

// ── leituras prontas pras telas (todas devolvem null quando o espelho não cobre o período) ───────────────────────
// Totais por loja no período: venda, custo, qtd, itens, cupons (cupom é por dia, então somar os dias é exato), dias.
async function totaisPeriodo(lojas, dIni, dFim) {
  if (!pronto || !lojas.length) return null;
  const h = hojeLocal(); const fim = dFim > h ? h : dFim; if (fim < dIni) return null;
  if (!(await temCobertura(lojas, dIni, fim))) return null;
  return pg.pq(`SELECT loja, SUM(valor) valor, SUM(custo) custo, SUM(qtd) qtd, SUM(itens) itens, SUM(cupons) cupons, COUNT(*) dias
                FROM venda_dia_loja WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 GROUP BY loja ORDER BY loja`, [lojas, dIni, fim]);
}
// Por loja e dia: valor, custo, cupons, itens.
async function vendaPorDia(lojas, dIni, dFim) {
  if (!pronto || !lojas.length) return null;
  const h = hojeLocal(); const fim = dFim > h ? h : dFim; if (fim < dIni) return null;
  if (!(await temCobertura(lojas, dIni, fim))) return null;
  return pg.pq(`SELECT loja, to_char(dia, 'YYYY-MM-DD') dia, valor, custo, qtd, itens, cupons FROM venda_dia_loja
                WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 ORDER BY loja, dia`, [lojas, dIni, fim]);
}
// Última venda (dia) de cada produto por loja no período.
async function ultimaVenda(lojas, codigos, dIni, dFim) {
  if (!pronto || !lojas.length) return null;
  const h = hojeLocal(); const fim = dFim > h ? h : dFim; if (fim < dIni) return null;
  if (!(await temCobertura(lojas, dIni, fim))) return null;
  const cods = (codigos || []).map(c => String(c).slice(0, 14)); if (!cods.length) return [];
  return pg.pq(`SELECT loja, codigo, to_char(MAX(dia), 'YYYY-MM-DD') ultima FROM venda_dia_produto
                WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 AND codigo = ANY($4) GROUP BY loja, codigo`, [lojas, dIni, fim, cods]);
}
// Descrição dos produtos: cadastro primeiro, senão o nome visto no cupom. { codigo: descricao }
async function nomesProdutos(codigos) {
  const cods = [...new Set((codigos || []).map(c => String(c).slice(0, 19)))]; if (!cods.length || !pronto) return {};
  const out = {};
  const a = await pg.pq('SELECT codigo, descricao FROM produto_nome WHERE codigo = ANY($1)', [cods]).catch(() => []);
  for (const r of a) out[r.codigo] = r.descricao;
  const b = await pg.pq('SELECT codigo, descricao FROM cadastro_item WHERE codigo = ANY($1)', [cods]).catch(() => []);
  for (const r of b) if (r.descricao) out[r.codigo] = r.descricao;
  return out;
}
// Mesmo mês em vários anos (comparativos): por loja, ano e dia do mês → valor, custo, cupons. Só anos cobertos inteiros
// (até hoje no ano atual); ano sem cobertura fica de fora do resultado (quem chama decide se cai pro ERP).
async function mesmoMesAnos(lojas, mes, anos) {
  if (!pronto || !lojas.length) return null;
  const out = {}; const h = hojeLocal();
  for (const ano of anos) {
    const dIni = `${ano}-${pad(mes)}-01`; const ultimo = new Date(ano, mes, 0).getDate(); let dFim = `${ano}-${pad(mes)}-${pad(ultimo)}`;
    if (dIni > h) continue; if (dFim > h) dFim = h;
    if (!(await temCobertura(lojas, dIni, dFim))) continue;
    out[ano] = await pg.pq(`SELECT loja, EXTRACT(DAY FROM dia)::int dia, valor, custo, cupons, itens FROM venda_dia_loja WHERE loja = ANY($1) AND dia BETWEEN $2 AND $3 ORDER BY loja, dia`, [lojas, dIni, dFim]);
  }
  return out;
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
  let hojePorLoja = [], cad = null;
  try { hojePorLoja = await pg.pq(`SELECT loja, valor, cupons, produtos, linhas_erp, to_char(copiado_em, 'HH24:MI') copiado FROM venda_dia_loja WHERE dia = $1 ORDER BY loja`, [hojeLocal()]); } catch (e) {}
  try { cad = (await pg.pq(`SELECT (SELECT COUNT(*) FROM cadastro_item) itens, (SELECT COUNT(*) FROM cadastro_item WHERE desativado = 0) ativos, (SELECT COUNT(*) FROM produto_nome) nomes, (SELECT MAX(atualizado_em) FROM cadastro_item) em`))[0]; } catch (e) {}
  const porLoja = {}; for (const loja of LOJAS) { const p = historico.porLoja[loja]; porLoja[loja] = p ? { feito: p.feito, total: p.total, proximo: p.terminou ? null : p.proximo, erros: p.erros, ultimoErro: p.ultimoErro, terminou: p.terminou } : null; }
  const feitoTot = Object.values(porLoja).reduce((s, p) => s + (p ? p.feito : 0), 0), totalTot = Object.values(porLoja).reduce((s, p) => s + (p ? p.total : 0), 0);
  return {
    pronto, erroEsquema, banco, erroBanco, tamanhos, lojas: LOJAS, anos: ANOS_HISTORICO, janela: JANELA_TXT, emBackup: emBackup(),
    hoje: { ...hoje, dia: hojeLocal(), porLoja: hojePorLoja },
    madrugada, historico: { rodando: historico.rodando, forcado: historico.forcado, pausado: historico.pausado, naJanela: naJanela(), iniciadoEm: historico.iniciadoEm, terminadoEm: historico.terminadoEm || null, ultimoErro: historico.ultimoErro, feito: feitoTot, total: totalTot, limite: limiteHistorico(), porLoja },
    copias: copias.slice(0, 40), config,
    cadastro: { ...cadastro, banco: cad },
  };
}

// ── ações da tela ────────────────────────────────────────────────────────────────────────────────────────────────
async function acao(nome) {
  if (!pronto) throw new Error(erroEsquema ? 'Espelho sem banco: ' + erroEsquema : 'Espelho ainda não iniciou');
  if (nome === 'hoje') return sincronizarHoje('manual');
  if (nome === 'reconferir') return reconferir(RECOPIAR_DIAS, 'manual');
  if (nome === 'cadastro') return copiarCadastro('manual');
  if (nome === 'historico') { historico.pausado = false; historico.forcado = true; montarPlano(); loopHistorico().catch(e => { historico.ultimoErro = e.message; }); return { ok: true, rodando: true }; }
  if (nome === 'pausar') { historico.pausado = true; return { ok: true }; }
  if (nome === 'retomar') { historico.pausado = false; montarPlano(); loopHistorico().catch(e => { historico.ultimoErro = e.message; }); return { ok: true }; }
  throw new Error('ação desconhecida');
}
async function salvarConfig(p) {
  if (p.grupo != null) config.grupo = String(p.grupo).slice(0, 80);
  if (p.avisar != null) config.avisar = !!p.avisar;
  if (p.backupIni != null) { if (!hhmmOk(p.backupIni)) throw new Error('início do backup inválido (HH:MM)'); config.backupIni = p.backupIni; }
  if (p.backupFim != null) { if (!hhmmOk(p.backupFim)) throw new Error('fim do backup inválido (HH:MM)'); config.backupFim = p.backupFim; }
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
      // cadastro: se ainda não existe no banco, copia 3 min depois da subida (fora do backup); depois só às 07:45
      timers.push(setTimeout(async () => {
        try { const [c] = await pg.pq('SELECT COUNT(*) n FROM cadastro_item'); if (!Number(c.n) && horaDeHoje() && !emBackup()) await copiarCadastro('inicial'); } catch (e) { console.error('[ESPELHO] cadastro inicial:', e.message); }
      }, 3 * 60 * 1000));
      // recópia das 07:40 + histórico na janela comercial (checa a cada minuto)
      timers.push(setInterval(() => {
        const d = new Date(); const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`; const h = hojeLocal();
        if (hm === HORA_MADRUGADA && madrugada.feitaHoje !== h) { madrugada.feitaHoje = h; reconferir().catch(e => { madrugada.ultimoErro = e.message; }); }
        if (hm === HORA_CADASTRO && cadastro.feitoHoje !== h && !emBackup()) { cadastro.feitoHoje = h; copiarCadastro().catch(() => {}); }
        const pend = LOJAS.some(l => historico.porLoja[l] && !historico.porLoja[l].terminou);
        if (pend && naJanela() && !historico.rodando && !historico.pausado) loopHistorico().catch(e => { historico.ultimoErro = e.message; });
      }, 60 * 1000));
      timers.forEach(t => t.unref && t.unref());
    } catch (e) { erroEsquema = e.message; console.error('[ESPELHO] falhou ao iniciar:', e.message); }
  })();
}

module.exports = { init, status, acao, salvarConfig, saudeErp, emBackup, vendaPeriodo, vendaPeriodoProduto, temCobertura, cobertura, totaisPeriodo, vendaPorDia, ultimaVenda, nomesProdutos, mesmoMesAnos,
  copiarDia, copiarCadastro, sincronizarHoje, reconferir, LOJAS, hojeLocal, horaDeHoje, registrarCopia, pronto: () => pronto, pq: (...a) => pg.pq(...a), _estado: () => ({ pronto, feitos: feitos.size, historico, hoje, cadastro }) };
