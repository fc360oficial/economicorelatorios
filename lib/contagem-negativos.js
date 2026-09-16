// ═══════════════════════════════════════════════════
// Contagem de Negativos — persistência em JSON
// ═══════════════════════════════════════════════════
// Substitui a devolução por foto da folha: o auxiliar digita a contagem
// (Depósito / Loja) no celular, em /contagem.html, e a central acompanha
// em /negativos.html. Um arquivo por dia em data/contagem-negativos/.
//
// Quem cria o dia é o bot negativos-wpp (mesmo repo, processo separado),
// na hora que manda os negativos no grupo — ele chama abrirDia(porLoja).
// Quem grava contagem é o server.js. Só fs/path aqui, de propósito: o bot
// tem node_modules próprio e este módulo precisa rodar nos dois lados.
//
// Nada disto escreve no ERP. A diferença fica pra ajuste manual.

const fs   = require('fs');
const path = require('path');

const DIR         = path.join(__dirname, '..', 'data', 'contagem-negativos');
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'contagem-config.json');
const LOJAS_NOMES = { 1:'CAHU', 2:'MURIBECA', 3:'PONTE', 4:'ATACAREJO', 5:'PORTA LARGA', 6:'JARDIM JORDAO' };

function init() { fs.mkdirSync(DIR, { recursive: true }); config(); }

const arq = data => path.join(DIR, `${data}.json`);
const hojeStr = () => {
  // data local de Brasília, independente do fuso do servidor
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
const agora = () => new Date().toISOString();

function salvar(d) { d.atualizadoEm = agora(); fs.writeFileSync(arq(d.data), JSON.stringify(d)); return d; }
function obter(data) { try { return JSON.parse(fs.readFileSync(arq(data), 'utf8')); } catch (e) { return null; } }
function listarDias() {
  init();
  return fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, -5)).sort().reverse();
}

// ── Config: PIN e token por loja ─────────────────────────────────────────────
// PIN é o que o auxiliar digita uma vez no celular; o token (32 hex) é o que
// o app guarda depois e manda em toda requisição. Gerados na primeira vez e
// mantidos no arquivo — o Tiago pode trocar o PIN editando o JSON.
function config() {
  let c = null;
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  if (!c || !c.lojas) c = { lojas: {} };
  let mudou = false;
  for (const ln of Object.keys(LOJAS_NOMES)) {
    if (!c.lojas[ln]) c.lojas[ln] = {};
    if (!c.lojas[ln].pin)   { c.lojas[ln].pin   = String(1000 + Math.floor(Math.random() * 9000)); mudou = true; }
    if (!c.lojas[ln].token) { c.lojas[ln].token = require('crypto').randomBytes(16).toString('hex'); mudou = true; }
  }
  if (mudou) { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
  return c;
}
function lojaPorPin(ln, pin) {
  const c = config().lojas[ln];
  return c && String(pin) === String(c.pin) ? { loja: +ln, token: c.token } : null;
}
function lojaPorToken(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) return null;
  const c = config();
  const ln = Object.keys(c.lojas).find(k => c.lojas[k].token === token);
  return ln ? +ln : null;
}

// ── Dia ──────────────────────────────────────────────────────────────────────
// porLoja: { 1: [{Codigo, Descricao, Grupo, SubGrupo, Estoque}], ... } (saída
// do buscarNegativos do bot). Se o dia já existe, só acrescenta lojas/itens
// novos — nunca apaga contagem já digitada (o "reenviar" passa por aqui).
function abrirDia(porLoja, data = hojeStr()) {
  init();
  const d = obter(data) || { data, criadoEm: agora(), lojas: {} };
  for (const ln of Object.keys(LOJAS_NOMES)) {
    const itens = (porLoja[ln] || []).map(r => ({
      cod: String(r.Codigo), desc: r.Descricao, grupo: r.Grupo, sub: r.SubGrupo, sys: Number(r.Estoque),
    }));
    if (!itens.length && !d.lojas[ln]) continue;
    if (!d.lojas[ln]) {
      d.lojas[ln] = { nome: LOJAS_NOMES[ln], itens, contagem: {}, status: 'aberta', resp: null, iniciadoEm: null, concluidoEm: null };
    } else {
      const tem = new Set(d.lojas[ln].itens.map(i => i.cod));
      for (const i of itens) if (!tem.has(i.cod)) d.lojas[ln].itens.push(i);
    }
  }
  return salvar(d);
}

// Visão do celular: só a loja dele
function visaoLoja(data, ln) {
  const d = obter(data);
  if (!d || !d.lojas[ln]) return null;
  const l = d.lojas[ln];
  return { data, loja: +ln, nome: l.nome, status: l.status, resp: l.resp, iniciadoEm: l.iniciadoEm, concluidoEm: l.concluidoEm, itens: l.itens, contagem: l.contagem };
}

// Último dia que tem contagem pra essa loja (normalmente hoje)
function diaAtualDaLoja(ln) {
  for (const data of listarDias()) { const d = obter(data); if (d && d.lojas[ln]) return data; }
  return null;
}

function lancarItem(data, ln, { cod, dep, loja, zero, nome }) {
  const d = obter(data);
  if (!d || !d.lojas[ln]) throw new Error('Contagem não encontrada.');
  const l = d.lojas[ln];
  if (l.status === 'concluida') throw new Error('Contagem já concluída.');
  if (!l.itens.some(i => i.cod === String(cod))) throw new Error('Item não está na lista de hoje.');
  const n = v => (v === null || v === undefined || v === '') ? null : Math.max(0, Math.floor(Number(v)) || 0);
  const reg = zero ? { dep: 0, loja: 0, zero: true } : { dep: n(dep), loja: n(loja), zero: false };
  if (!reg.zero && reg.dep === null && reg.loja === null) delete l.contagem[cod];
  else l.contagem[cod] = { ...reg, em: agora(), por: nome || null };
  if (!l.iniciadoEm) l.iniciadoEm = agora();
  if (nome && !l.resp) l.resp = nome;
  salvar(d);
  return l.contagem[cod] || null;
}

function concluir(data, ln, nome) {
  const d = obter(data);
  if (!d || !d.lojas[ln]) throw new Error('Contagem não encontrada.');
  const l = d.lojas[ln];
  const faltam = l.itens.filter(i => !contado(l.contagem[i.cod])).length;
  if (faltam) throw new Error(`Faltam ${faltam} item(ns). Marque "Não achei" nos que não existem na loja.`);
  l.status = 'concluida'; l.concluidoEm = agora(); if (nome) l.resp = l.resp || nome;
  salvar(d);
  return visaoLoja(data, ln);
}

function reabrir(data, ln) {
  const d = obter(data);
  if (!d || !d.lojas[ln]) throw new Error('Contagem não encontrada.');
  d.lojas[ln].status = 'aberta'; d.lojas[ln].concluidoEm = null;
  salvar(d);
  return visaoLoja(data, ln);
}

const contado = c => !!c && (c.zero || c.dep !== null || c.loja !== null);
const total   = c => !c ? null : (c.zero ? 0 : (c.dep || 0) + (c.loja || 0));

// Visão da central: resumo por loja + itens com diferença
function visaoCentral(data) {
  const d = obter(data);
  if (!d) return null;
  const lojas = Object.keys(LOJAS_NOMES).map(ln => {
    const l = d.lojas[ln];
    if (!l) return { loja: +ln, nome: LOJAS_NOMES[ln], semNegativos: true, itens: 0, contados: 0, zerados: 0, status: 'sem_negativos', resp: null, iniciadoEm: null, concluidoEm: null, linhas: [] };
    const linhas = l.itens.map(i => {
      const c = l.contagem[i.cod]; const t = total(c);
      // ajuste = quanto o ERP precisa subir pra ficar igual ao contado (sys é negativo)
      return { ...i, dep: c ? c.dep : null, loja: c ? c.loja : null, zero: !!(c && c.zero), contado: t, diferenca: t === null ? null : t - i.sys, em: c ? c.em : null, por: c ? c.por : null };
    });
    const contados = linhas.filter(x => x.contado !== null).length;
    let status = l.status;
    if (status !== 'concluida') status = contados ? 'andamento' : 'nao_iniciada';
    return { loja: +ln, nome: l.nome, itens: l.itens.length, contados, zerados: linhas.filter(x => x.zero).length, status, resp: l.resp, iniciadoEm: l.iniciadoEm, concluidoEm: l.concluidoEm,
             diferenca: linhas.reduce((s, x) => s + (x.diferenca || 0), 0), linhas };
  });
  return { data: d.data, criadoEm: d.criadoEm, atualizadoEm: d.atualizadoEm, lojas };
}

function csv(data) {
  const v = visaoCentral(data);
  if (!v) return null;
  const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const out = [['Data', 'Loja', 'Nome Loja', 'Codigo', 'Descricao', 'Grupo', 'SubGrupo', 'Sistema', 'Deposito', 'Loja (area de venda)', 'Contado', 'Diferenca', 'Nao achei', 'Contado por', 'Contado em'].join(';')];
  for (const l of v.lojas) for (const x of l.linhas)
    out.push([v.data, l.loja, l.nome, x.cod, x.desc, x.grupo, x.sub, x.sys, x.dep ?? '', x.loja ?? '', x.contado ?? '', x.diferenca ?? '', x.zero ? 'SIM' : '', x.por ?? '', x.em ? x.em.slice(0, 16).replace('T', ' ') : ''].map(esc).join(';'));
  return '﻿' + out.join('\r\n');
}

module.exports = { init, hojeStr, listarDias, obter, abrirDia, visaoLoja, diaAtualDaLoja, lancarItem, concluir, reabrir, visaoCentral, csv, config, lojaPorPin, lojaPorToken, LOJAS_NOMES };
