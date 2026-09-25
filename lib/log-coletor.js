'use strict';
// Eventos do Coletor de Recebimento (celular do conferente), append-only, 1 arquivo por mês
// em data/log-coletor/AAAA-MM.jsonl. Mesmo padrão de lib/log-erp.js, mas registro mais simples
// (sem SQL/antes-depois): quem fez o quê, quando, em qual loja/NF-e.
const fs = require('fs');
const path = require('path');
const L = require('./log-erp'); // reaproveita novoId/agoraIso (mesmo formato de id e data usado no Log ERP)

const TIPOS = ['entrar', 'abrir_nota', 'bipe', 'corrigir', 'terminei', 'chat', 'liberar', 'reconferir', 'erp'];
const CAMPOS = ['id', 'em', 'tipo', 'loja', 'nome', 'nfe', 'chave', 'nReg', 'cod', 'descricao', 'quant', 'emb', 'un', 'validade', 'resultado', 'msg', 'logErpId', 'erro'];

function arq(dir, quando) { return path.join(dir, String(quando).slice(0, 7) + '.jsonl'); }

/** Grava um evento no arquivo do mês (append-only). Lança Error se tipo/loja inválidos. */
function registrar(dir, ev, agora = new Date()) {
  if (!TIPOS.includes(ev.tipo)) throw new Error('tipo inválido: ' + ev.tipo);
  if (!ev.loja) throw new Error('loja obrigatória');
  const e = { id: L.novoId(agora), em: L.agoraIso(agora) };
  for (const k of CAMPOS) if (ev[k] !== undefined && !(k in e)) e[k] = ev[k];
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(arq(dir, e.em), JSON.stringify(e) + '\n');
  return e;
}

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MESES = 24;
/** Meses (AAAA-MM) cobertos pelo período. Datas fora do formato viram erro (o `de`/`ate` vem da
 * query string) e o período é limitado a 24 meses, senão um `de=0001-01-01` varre 24 mil arquivos. */
function meses(de, ate) {
  if (!RE_DIA.test(String(de)) || !RE_DIA.test(String(ate))) throw new Error('data inválida (use AAAA-MM-DD)');
  if (ate < de) throw new Error('período invertido');
  const out = [];
  let d = new Date(de.slice(0, 7) + '-01T00:00:00Z');
  const fim = ate.slice(0, 7);
  for (;;) {
    const m = d.toISOString().slice(0, 7);
    out.push(m);
    if (m >= fim || out.length >= MAX_MESES) break;
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/** Lê o período (datas AAAA-MM-DD, inclusive), filtra e devolve do mais novo pro mais velho (array puro). */
function ler(dir, { de, ate, loja, tipo, nfe, nome, limite = 5000 } = {}) {
  de = de || new Date().toISOString().slice(0, 10);
  ate = ate || de;
  const out = [];
  for (const m of meses(de, ate)) {
    const f = path.join(dir, m + '.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!ln) continue;
      let e; try { e = JSON.parse(ln); } catch { continue; }
      const dia = e.em.slice(0, 10);
      if (dia < de || dia > ate) continue;
      if (loja && +e.loja !== +loja) continue;
      if (tipo && e.tipo !== tipo) continue;
      if (nfe && String(e.nfe || '') !== String(nfe)) continue;
      if (nome && !String(e.nome || '').toUpperCase().includes(String(nome).toUpperCase())) continue;
      out.push(e);
    }
  }
  return out.sort((a, b) => b.em.localeCompare(a.em)).slice(0, limite);
}

function csv(itens) {
  const cab = ['em', 'tipo', 'loja', 'nome', 'nfe', 'cod', 'descricao', 'quant', 'emb', 'un', 'validade', 'resultado', 'msg', 'logErpId', 'erro'];
  // célula começando com = + - @ vira fórmula no Excel (CSV injection): prefixa com apóstrofo.
  const neutro = t => /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
  const esc = v => { if (v == null) return ''; const t = neutro(String(v)); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return '﻿' + cab.join(';') + '\n' + itens.map(e => cab.map(k => esc(e[k])).join(';')).join('\n');
}

module.exports = { registrar, ler, csv, TIPOS };
