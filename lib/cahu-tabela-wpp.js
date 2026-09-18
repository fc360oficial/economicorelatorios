// Envio automático da Tabela de Preços da CAHU Distribuidora pro grupo dos vendedores (WhatsApp) — 18/09/2026.
//
//   07:00 seg–sáb  → PDF da tabela COMPLETA (sem Delivery) + resumo do que mudou desde a última tabela enviada
//                    (saíram: sem estoque no CD / desativado / fora da tabela; voltaram/novos; preço de → para).
//   09/12/15/18h   → checagem: item da tabela do dia que ZEROU no CD ou MUDOU DE PREÇO desde a última mensagem.
//                    Um aviso por item por dia (estoque) e por item×tabela (preço) — não fica repetindo oscilação.
//
// Quem fala com o WhatsApp é o processo separado cahu-wpp/ (número novo "Central Rede Cahu", só localhost:3011).
// Se ele não estiver rodando (antes do pareamento, ~25/09/2026), tudo roda igual e SÓ NÃO ENVIA — a foto do dia
// é gravada mesmo assim, pra primeira mensagem já sair com histórico. SOMENTE LEITURA no ERP.
const fs = require('fs');
const path = require('path');

const STATE_PATH = process.env.CAHU_WPP_STATE || path.join(__dirname, '..', 'data', 'cahu-tabela-wpp.json');
const BOT_URL = (process.env.CAHU_WPP_URL || 'http://127.0.0.1:3011').replace(/\/$/, '');
const HORA_MANHA = '07:00', HORA_RETRY = '07:15';
const HORAS_CHECAGEM = ['09:00', '12:00', '15:00', '18:00'];
const MAX_ITENS_MSG = 40;   // acima disso a mensagem resume ("e mais N itens, veja o PDF")
const PAUSA_ENTRE_ARQUIVOS_MS = 8000;

let deps = null;   // { q, listarTabelas, carregarTabela, gerarPdf }
let state = null;
let timer = null;
let rodando = false;

const fmtBRL = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hojeISO = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // yyyy-mm-dd
const horaLocal = (d = new Date()) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
function rotuloData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const dia = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).replace('.', '');
  return `${dia} ${d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })}`;
}

// ── estado em disco ───────────────────────────────────────────────────────────
function estadoVazio() {
  return { config: { ativo: true, separadas: false }, fotoManha: null, fotoChecagem: null, avisos: { data: null, itens: {} }, ultimoEnvio: null, retryManha: null, log: [] };
}
function carregar() {
  if (state) return state;
  try { state = { ...estadoVazio(), ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; }
  catch { state = estadoVazio(); }
  return state;
}
function salvar() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
}
function logar(tipo, ok, msg) {
  carregar();
  state.log.unshift({ em: new Date().toISOString(), tipo, ok, msg: String(msg || '').slice(0, 300) });
  state.log = state.log.slice(0, 200);
  salvar();
  (ok ? console.log : console.error)(`[CAHU-WPP] ${tipo}: ${msg}`);
}

// ── foto e comparação (puras) ─────────────────────────────────────────────────
// foto = { em, tabelas:[{cod,label}], itens: { codigobarra: { d: descricao, p: { codTabela: preco } } } }
function tirarFoto(lista, tabelas) {
  const itens = {};
  for (const it of lista) {
    const p = {};
    for (const t of tabelas) if (it[t.cod] != null) p[t.cod] = Number(it[t.cod]);
    itens[it.codigobarra] = { d: it.descricao, p };
  }
  return { em: new Date().toISOString(), tabelas: tabelas.map(t => ({ cod: t.cod, label: t.label })), itens };
}

// Compara duas fotos. Preço muda por tabela; "sairam" ainda não tem motivo (vem do ERP em classificarSaidas).
function comparar(anterior, atual) {
  const r = { sairam: [], entraram: [], precos: [] };
  if (!anterior) return r;
  for (const cod of Object.keys(anterior.itens)) {
    if (!atual.itens[cod]) r.sairam.push({ cod, d: anterior.itens[cod].d });
  }
  for (const cod of Object.keys(atual.itens)) {
    const a = atual.itens[cod], b = anterior.itens[cod];
    if (!b) { r.entraram.push({ cod, d: a.d }); continue; }
    const mud = [];
    for (const tab of Object.keys(a.p)) {
      if (b.p[tab] != null && Math.abs(b.p[tab] - a.p[tab]) >= 0.005) mud.push({ tab: Number(tab), de: b.p[tab], para: a.p[tab] });
    }
    if (mud.length) r.precos.push({ cod, d: a.d, mudancas: mud });
  }
  const porNome = (x, y) => x.d.localeCompare(y.d, 'pt-BR');
  r.sairam.sort(porNome); r.entraram.sort(porNome); r.precos.sort(porNome);
  return r;
}

// Agrupa as mudanças de preço de um item: tabelas com o mesmo de→para viram uma linha só.
function linhasPreco(item, tabelas) {
  const nome = cod => (tabelas.find(t => t.cod === cod)?.label || `Tabela ${cod}`).replace(/^Tabela /i, '');
  const grupos = new Map();
  for (const m of item.mudancas) {
    const k = `${m.de}|${m.para}`;
    if (!grupos.has(k)) grupos.set(k, { de: m.de, para: m.para, tabs: [] });
    grupos.get(k).tabs.push(m.tab);
  }
  const todas = grupos.size === 1 && [...grupos.values()][0].tabs.length === tabelas.length;
  return [...grupos.values()].map(g => `  ${todas ? 'Todas as tabelas' : g.tabs.map(nome).join(' / ')}: ${fmtBRL(g.de)} → ${fmtBRL(g.para)}`);
}

function secao(titulo, itens, fmt, resto) {
  if (!itens.length) return [];
  const mostrar = itens.slice(0, Math.max(0, resto.n));
  resto.n -= mostrar.length;
  const linhas = [titulo];
  for (const it of mostrar) linhas.push(...fmt(it));
  if (mostrar.length < itens.length) linhas.push(`  … e mais ${itens.length - mostrar.length} ${itens.length - mostrar.length === 1 ? 'item' : 'itens'}, veja o PDF`);
  linhas.push('');
  return linhas;
}

const MOTIVO_TITULO = {
  estoque: '❌ *Saíram da tabela (sem estoque no CD)*',
  desativado: '🚫 *Saíram da tabela (produto desativado)*',
  tabela: '🚫 *Saíram da tabela (retirados da tabela)*',
};

// Texto do resumo das 07:00. motivos = { cod: 'estoque'|'desativado'|'tabela' }. Retorna null se nada mudou e naoAvisarVazio.
function textoResumoManha(diff, motivos, tabelas, desdeISO) {
  const cab = `📋 *Alterações desde ${rotuloData(desdeISO)}*`;
  const total = diff.sairam.length + diff.entraram.length + diff.precos.length;
  if (!total) return `${cab}\n\nSem alterações de preço ou de itens.`;
  const resto = { n: MAX_ITENS_MSG };
  const linhas = [cab, ''];
  const item = it => [`• ${it.cod} ${it.d}`];
  for (const motivo of ['estoque', 'desativado', 'tabela']) {
    linhas.push(...secao(MOTIVO_TITULO[motivo], diff.sairam.filter(s => (motivos[s.cod] || 'estoque') === motivo), item, resto));
  }
  linhas.push(...secao('✅ *Voltaram / novos na tabela*', diff.entraram, item, resto));
  linhas.push(...secao('💲 *Mudaram de preço*', diff.precos, it => [`• ${it.cod} ${it.d}`, ...linhasPreco(it, tabelas)], resto));
  return linhas.join('\n').trim();
}

// Texto das checagens (09/12/15/18): só o que é novo desde a última mensagem. null = nada a avisar.
function textoChecagem(diff, motivos, tabelas) {
  if (!diff.sairam.length && !diff.precos.length) return null;
  const resto = { n: MAX_ITENS_MSG };
  const linhas = [`⚠️ *Atualização da tabela — ${horaLocal()}*`, ''];
  const item = it => [`• ${it.cod} ${it.d}`];
  linhas.push(...secao('❌ *Zerou no CD (fora da tabela agora)*', diff.sairam.filter(s => (motivos[s.cod] || 'estoque') === 'estoque'), item, resto));
  linhas.push(...secao('🚫 *Saiu da tabela*', diff.sairam.filter(s => (motivos[s.cod] || 'estoque') !== 'estoque'), item, resto));
  linhas.push(...secao('💲 *Mudou de preço*', diff.precos, it => [`• ${it.cod} ${it.d}`, ...linhasPreco(it, tabelas)], resto));
  return linhas.join('\n').trim();
}

// Regra "um aviso por item por dia": tira do diff o que já foi avisado hoje e marca o que vai ser avisado agora.
function filtrarJaAvisados(diff, avisos) {
  const hoje = hojeISO();
  if (avisos.data !== hoje) { avisos.data = hoje; avisos.itens = {}; }
  const marca = cod => (avisos.itens[cod] = avisos.itens[cod] || { estoque: false, preco: {} });
  const sairam = diff.sairam.filter(s => !avisos.itens[s.cod]?.estoque);
  const precos = [];
  for (const p of diff.precos) {
    const mud = p.mudancas.filter(m => !avisos.itens[p.cod]?.preco?.[m.tab]);
    if (mud.length) precos.push({ ...p, mudancas: mud });
  }
  const confirmar = () => {
    for (const s of sairam) marca(s.cod).estoque = true;
    for (const p of precos) for (const m of p.mudancas) marca(p.cod).preco[m.tab] = m.para;
  };
  return { diff: { sairam, entraram: [], precos }, confirmar };
}

// ── ERP: motivo de cada item que sumiu ────────────────────────────────────────
async function classificarSaidas(sairam, tabelas) {
  const motivos = {};
  if (!sairam.length) return motivos;
  const cods = sairam.map(s => s.cod);
  const ph = cods.map(() => '?').join(',');
  const codsTab = tabelas.map(t => t.cod);
  const [est, cad, tab] = await Promise.all([
    deps.q(`SELECT CodigoBarra, Qtd FROM central.estoquen10 WHERE CodigoBarra IN (${ph})`, cods),
    deps.q(`SELECT CodigoBarra, CodDesativado FROM central.itens WHERE CodigoBarra IN (${ph})`, cods),
    deps.q(`SELECT codigobarra, MIN(status_item) AS st FROM central.s_tabela_item WHERE codigobarra IN (${ph}) AND cod_tabela IN (${codsTab.map(() => '?').join(',')}) GROUP BY codigobarra`, [...cods, ...codsTab]),
  ]);
  const estoque = new Map(est.map(r => [r.CodigoBarra, parseFloat(String(r.Qtd).replace(',', '.')) || 0]));
  const desativado = new Set(cad.filter(r => Number(r.CodDesativado) !== 0).map(r => r.CodigoBarra));
  const foraTabela = new Set(tab.filter(r => Number(r.st) !== 0).map(r => r.codigobarra));
  const cadastrados = new Set(cad.map(r => r.CodigoBarra));
  for (const cod of cods) {
    if (desativado.has(cod) || !cadastrados.has(cod)) motivos[cod] = 'desativado';
    else if ((estoque.get(cod) || 0) <= 0) motivos[cod] = 'estoque';
    else motivos[cod] = 'tabela';
  }
  return motivos;
}

// ── bot (processo cahu-wpp, só localhost) ─────────────────────────────────────
async function bot(rota, body) {
  let r;
  try {
    r = await fetch(BOT_URL + rota, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  } catch (e) {
    const err = new Error('bot indisponível (' + (e.cause?.code || e.name || e.message) + ')'); err.botOffline = true; throw err;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j.error || `bot HTTP ${r.status}`); err.botOffline = r.status === 503; throw err; }
  return j;
}
const enviarTexto = texto => bot('/mensagem-grupo', { texto });
const enviarDocumento = (buffer, fileName, caption) => bot('/documento-grupo', { base64: buffer.toString('base64'), fileName, mimetype: 'application/pdf', caption });
async function avisarTiago(texto) { try { await bot('/mensagem-alerta', { texto: `🤖 Tabela CAHU: ${texto}` }); } catch { /* bot fora: fica só no log */ } }

async function statusBot() {
  try { const r = await fetch(BOT_URL + '/status', { signal: AbortSignal.timeout(3000) }); return await r.json(); }
  catch { return { online: false, conectado: false }; }
}

// ── rotinas ───────────────────────────────────────────────────────────────────
async function carregarAtual() {
  const todas = await deps.listarTabelas();
  const tabelas = todas.filter(t => !t.somenteSeparado);
  const lista = await deps.carregarTabela(tabelas);
  if (!lista.length) throw new Error('tabela veio vazia do ERP — envio cancelado pra não mandar PDF em branco');
  return { todas, tabelas, lista, foto: tirarFoto(lista, tabelas) };
}

async function rotinaManha({ manual = false } = {}) {
  if (rodando) throw new Error('já tem uma rotina rodando');
  rodando = true;
  const s = carregar();
  const tipo = manual ? 'manha-manual' : 'manha';
  try {
    const { todas, tabelas, lista, foto } = await carregarAtual();
    const diff = comparar(s.fotoManha, foto);
    const motivos = await classificarSaidas(diff.sairam, tabelas);
    const resumo = s.fotoManha ? textoResumoManha(diff, motivos, tabelas, s.fotoManha.em) : null;

    // foto do dia é gravada SEMPRE (mesmo sem bot): é o histórico pra comparação de amanhã
    const fotoAnterior = s.fotoManha;
    s.fotoManha = foto; s.fotoChecagem = foto; s.avisos = { data: hojeISO(), itens: {} }; s.retryManha = null;
    salvar();

    if (!s.config.ativo) { logar(tipo, true, `pausado (config.ativo=false): foto gravada, ${lista.length} itens, nada enviado`); return { enviado: false, itens: lista.length, resumo }; }

    const hoje = new Date(), dataStr = hoje.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }), dataNome = hojeISO(hoje);
    const pdf = await deps.gerarPdf(tabelas, null, lista);
    await enviarDocumento(pdf, `Tabela_Precos_CAHU_${dataNome}.pdf`, `*TABELA DE PREÇOS — ${dataStr}*\n${lista.length} produtos com estoque no CD`);
    if (s.config.separadas) {
      for (const t of todas.filter(x => !x.somenteSeparado)) {
        await new Promise(r => setTimeout(r, PAUSA_ENTRE_ARQUIVOS_MS));
        const listaT = await deps.carregarTabela([t]);
        const pdfT = await deps.gerarPdf([t], t, listaT);
        await enviarDocumento(pdfT, `${t.label.replace(/[^A-Za-z0-9]+/g, '_')}_CAHU_${dataNome}.pdf`, `*${t.label.toUpperCase()} — ${dataStr}*`);
      }
    }
    if (resumo) { await new Promise(r => setTimeout(r, 4000)); await enviarTexto(resumo); }
    s.ultimoEnvio = new Date().toISOString(); salvar();
    logar(tipo, true, `tabela enviada: ${lista.length} itens; alterações: -${diff.sairam.length} +${diff.entraram.length} $${diff.precos.length}${fotoAnterior ? '' : ' (primeira foto, sem resumo)'}`);
    return { enviado: true, itens: lista.length, resumo };
  } catch (e) {
    if (e.botOffline) { logar(tipo, true, `bot WhatsApp fora do ar: foto gravada, nada enviado (${e.message})`); return { enviado: false, motivo: e.message }; }
    if (!manual && !s.retryManha) { s.retryManha = hojeISO(); salvar(); logar(tipo, false, `${e.message} — tenta de novo às ${HORA_RETRY}`); }
    else { logar(tipo, false, e.message); await avisarTiago(`falhou o envio das ${HORA_MANHA}: ${e.message}`); }
    throw e;
  } finally { rodando = false; }
}

async function checagem({ manual = false } = {}) {
  if (rodando) throw new Error('já tem uma rotina rodando');
  rodando = true;
  const s = carregar();
  const tipo = manual ? 'checagem-manual' : 'checagem';
  try {
    if (!s.fotoChecagem) { logar(tipo, true, 'sem foto de referência ainda (roda a tabela das 07:00 primeiro)'); return { enviado: false }; }
    const { tabelas, foto } = await carregarAtual();
    const bruto = comparar(s.fotoChecagem, foto);
    const { diff, confirmar } = filtrarJaAvisados(bruto, s.avisos);
    const motivos = await classificarSaidas(diff.sairam, tabelas);
    const texto = textoChecagem(diff, motivos, tabelas);
    if (!texto) { s.fotoChecagem = foto; salvar(); logar(tipo, true, 'sem novidade'); return { enviado: false, texto: null }; }
    if (!s.config.ativo) { s.fotoChecagem = foto; confirmar(); salvar(); logar(tipo, true, `pausado: ${diff.sairam.length} zerados / ${diff.precos.length} preços, nada enviado`); return { enviado: false, texto }; }
    await enviarTexto(texto);
    s.fotoChecagem = foto; confirmar(); s.ultimoEnvio = new Date().toISOString(); salvar();
    logar(tipo, true, `aviso enviado: ${diff.sairam.length} zerados / ${diff.precos.length} preços`);
    return { enviado: true, texto };
  } catch (e) {
    if (e.botOffline) { logar(tipo, true, `bot fora do ar, nada enviado (${e.message})`); return { enviado: false, motivo: e.message }; }
    logar(tipo, false, e.message);
    if (!manual) await avisarTiago(`falhou a checagem das ${horaLocal()}: ${e.message}`);
    throw e;
  } finally { rodando = false; }
}

// ── agenda (seg–sáb, horário de Brasília) ─────────────────────────────────────
let ultimaChave = null;
function tick() {
  const agora = new Date();
  const dow = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getDay(); // 0=dom
  if (dow === 0) return;
  const hm = horaLocal(agora), chave = `${hojeISO(agora)} ${hm}`;
  if (chave === ultimaChave) return;
  const s = carregar();
  let fn = null;
  if (hm === HORA_MANHA) fn = rotinaManha;
  else if (hm === HORA_RETRY && s.retryManha === hojeISO(agora)) fn = rotinaManha;
  else if (HORAS_CHECAGEM.includes(hm)) fn = checagem;
  if (!fn) return;
  ultimaChave = chave;
  fn().catch(() => {});
}
function agendar() {
  if (timer) return;
  carregar();
  timer = setInterval(tick, 20 * 1000);
  console.log(`[CAHU-WPP] agenda ativa: seg–sáb ${HORA_MANHA} tabela + ${HORAS_CHECAGEM.join('/')} checagens (bot em ${BOT_URL})`);
}

async function estado() {
  const s = carregar();
  return {
    config: s.config, ultimoEnvio: s.ultimoEnvio, retryManha: s.retryManha,
    fotoManha: s.fotoManha ? { em: s.fotoManha.em, itens: Object.keys(s.fotoManha.itens).length } : null,
    fotoChecagem: s.fotoChecagem ? { em: s.fotoChecagem.em } : null,
    avisosHoje: s.avisos.data === hojeISO() ? Object.keys(s.avisos.itens).length : 0,
    horarios: { manha: HORA_MANHA, checagens: HORAS_CHECAGEM, dias: 'seg–sáb' },
    bot: await statusBot(), log: s.log.slice(0, 30),
  };
}
function salvarConfig(cfg) {
  const s = carregar();
  if (typeof cfg.ativo === 'boolean') s.config.ativo = cfg.ativo;
  if (typeof cfg.separadas === 'boolean') s.config.separadas = cfg.separadas;
  salvar(); logar('config', true, JSON.stringify(s.config));
  return s.config;
}

function init(d) { deps = d; carregar(); }

module.exports = { init, agendar, rotinaManha, checagem, estado, salvarConfig,
  // puras, pra teste
  tirarFoto, comparar, textoResumoManha, textoChecagem, filtrarJaAvisados, classificarSaidas, STATE_PATH };
