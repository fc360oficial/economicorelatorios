'use strict';
// Log de mudanças no MySQL de teste (.254). Parte pura: montagem de SQL com placeholders,
// diff antes/depois e arquivo JSONL por mês em data/log-erp/AAAA-MM.jsonl (append-only).
// Spec: docs/superpowers/specs/2026-09-23-log-mudancas-erp-design.md
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOME = /^[A-Za-z0-9_]+$/;
const OPERACOES = ['update', 'insert', 'delete'];

function nomeValido(s) { return typeof s === 'string' && NOME.test(s); }

function objetoNaoVazio(o) { return o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0; }

function checarNomes(obj, rotulo) {
  for (const k of Object.keys(obj)) if (!nomeValido(k)) throw new Error(`nome de coluna inválido em ${rotulo}: "${k}"`);
}

/** Monta SQL parametrizado. Lança Error com mensagem clara quando a entrada é inválida. */
function montarSql({ banco, tabela, operacao, where, valores }) {
  if (!nomeValido(banco) || !nomeValido(tabela)) throw new Error('nome de banco/tabela inválido (só letras, números e _)');
  if (!OPERACOES.includes(operacao)) throw new Error('operacao deve ser update, insert ou delete');
  const alvo = `\`${banco}\`.\`${tabela}\``;
  if (operacao !== 'insert') {
    if (!objetoNaoVazio(where)) throw new Error('where é obrigatório (pelo menos 1 coluna)');
    checarNomes(where, 'where');
  }
  if (operacao !== 'delete') {
    if (!objetoNaoVazio(valores)) throw new Error('valores é obrigatório (pelo menos 1 coluna)');
    checarNomes(valores, 'valores');
  }
  const whereSql = operacao === 'insert' ? null : Object.keys(where).map(c => `\`${c}\` = ?`).join(' AND ');
  const whereParams = operacao === 'insert' ? [] : Object.values(where);
  let sql, params;
  if (operacao === 'update') {
    sql = `UPDATE ${alvo} SET ${Object.keys(valores).map(c => `\`${c}\` = ?`).join(', ')} WHERE ${whereSql}`;
    params = [...Object.values(valores), ...whereParams];
  } else if (operacao === 'delete') {
    sql = `DELETE FROM ${alvo} WHERE ${whereSql}`;
    params = whereParams;
  } else {
    const cols = Object.keys(valores);
    sql = `INSERT INTO ${alvo} (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    params = Object.values(valores);
  }
  return {
    sql, params,
    sqlSelect: whereSql ? `SELECT * FROM ${alvo} WHERE ${whereSql}` : null,
    paramsSelect: whereParams,
    sqlCount: whereSql ? `SELECT COUNT(*) AS n FROM ${alvo} WHERE ${whereSql}` : null,
  };
}

/** Colunas cujo valor mudou em pelo menos um registro (comparação por posição). */
function diff(antes, depois) {
  const cols = new Set();
  const n = Math.max(antes.length, depois.length);
  for (let i = 0; i < n; i++) {
    const a = antes[i] || {}, d = depois[i] || {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(d)])) if (String(a[k] ?? '') !== String(d[k] ?? '')) cols.add(k);
  }
  return [...cols];
}

const p2 = n => String(n).padStart(2, '0');
function novoId(d = new Date()) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

/** ISO com fuso local (2026-09-23T14:05:11-03:00). */
function agoraIso(d = new Date()) {
  const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${s}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

function arquivoDoMes(dir, quando) { return path.join(dir, String(quando).slice(0, 7) + '.jsonl'); }

/** Acrescenta uma linha JSON ao arquivo do mês. Nunca reescreve. */
function gravar(dir, entrada) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(arquivoDoMes(dir, entrada.quando), JSON.stringify(entrada) + '\n');
  return entrada;
}

function mesesEntre(de, ate) {
  const out = [];
  let [y, m] = de.slice(0, 7).split('-').map(Number);
  const fim = ate.slice(0, 7);
  for (let i = 0; i < 240; i++) {
    const s = `${y}-${p2(m)}`;
    out.push(s);
    if (s >= fim) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function lerArquivo(arq) {
  const itens = []; let invalidas = 0;
  let txt; try { txt = fs.readFileSync(arq, 'utf8'); } catch (e) { return { itens, invalidas }; }
  for (const linha of txt.split('\n')) {
    if (!linha.trim()) continue;
    try { itens.push(JSON.parse(linha)); } catch (e) { invalidas++; }
  }
  return { itens, invalidas };
}

/** Lê o período (datas AAAA-MM-DD, inclusive), filtra e devolve do mais novo pro mais velho. */
function ler(dir, { de, ate, tabela, usuario, status, limite = 5000 } = {}) {
  let itens = [], linhas_invalidas = 0;
  for (const mes of mesesEntre(de, ate)) {
    const r = lerArquivo(path.join(dir, mes + '.jsonl'));
    itens.push(...r.itens); linhas_invalidas += r.invalidas;
  }
  const dIni = de + 'T00:00:00', dFim = ate + 'T23:59:59.999';
  itens = itens.filter(e => {
    const q = String(e.quando || '').slice(0, 23);
    if (q < dIni || q > dFim) return false;
    if (tabela && e.tabela !== tabela) return false;
    if (usuario && e.usuario !== usuario) return false;
    if (status && e.status !== status) return false;
    return true;
  });
  itens.sort((a, b) => (b.quando > a.quando ? 1 : b.quando < a.quando ? -1 : 0));
  return { itens: itens.slice(0, limite), linhas_invalidas, total: itens.length };
}

/** Uma entrada completa pelo id (o id começa pelo mês do arquivo). */
function porId(dir, id) {
  const m = /^(\d{4})(\d{2})\d{2}-\d{6}-[0-9a-f]{4}$/.exec(String(id || ''));
  if (!m) return null;
  return lerArquivo(path.join(dir, `${m[1]}-${m[2]}.jsonl`)).itens.find(e => e.id === id) || null;
}

const cel = v => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function csv(itens) {
  const linhas = ['Data/Hora;Usuário;Servidor;Tabela;Operação;Registros;Status;Motivo'];
  for (const e of itens) linhas.push([e.quando, e.usuario, e.servidor, `${e.banco}.${e.tabela}`, e.operacao, e.afetados ?? '', e.status, e.motivo].map(cel).join(';'));
  return '﻿' + linhas.join('\r\n') + '\r\n';
}

module.exports = { nomeValido, montarSql, diff, novoId, agoraIso, gravar, ler, porId, csv, OPERACOES };
