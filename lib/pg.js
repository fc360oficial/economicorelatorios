'use strict';
// lib/pg.js — conexão com o NOSSO banco (PostgreSQL 16 no 254, banco economicogestao). Criado em 28/10/2026 (Tiago:
// "se eu criar meu banco de dados isso vai melhorar?" → sim: o ERP vira só fonte, as telas leem daqui).
//
// Configuração em data/pg-economico.json (gitignored, some em máquina nova — igual ao data/pontocerto.json):
//   { "host": "127.0.0.1", "port": 5432, "database": "economicogestao", "user": "economicogestao", "password": "..." }
// ou pela env PG_ECONOMICO_URL (postgres://user:senha@host:5432/banco). Sem nenhum dos dois, `disponivel()` é false e
// quem usa o espelho cai pro ERP como antes.
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// DATE vem como texto 'YYYY-MM-DD' (não Date em fuso local, que vira "véspera 21:00" no Brasil); NUMERIC vira número.
types.setTypeParser(1082, v => v);
types.setTypeParser(1700, v => (v == null ? null : parseFloat(v)));
types.setTypeParser(20, v => (v == null ? null : Number(v)));   // BIGINT (count(*))

let cfg = null, pool = null, tentouLer = false;
function lerConfig() {
  tentouLer = true;
  if (process.env.PG_ECONOMICO_URL) { cfg = { connectionString: process.env.PG_ECONOMICO_URL }; return cfg; }
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'pg-economico.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[PG] pg-economico.json ilegível:', e.message); cfg = null; }
  return cfg;
}
function disponivel() { if (!tentouLer) lerConfig(); return !!cfg; }
function getPool() {
  if (pool) return pool;
  if (!disponivel()) return null;
  pool = new Pool({ ...cfg, max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, statement_timeout: 120000 });
  pool.on('error', e => console.error('[PG] conexão ociosa caiu:', e.message));
  return pool;
}
async function pq(sql, params = []) {
  const p = getPool();
  if (!p) throw new Error('Postgres não configurado (data/pg-economico.json)');
  const r = await p.query(sql, params);
  return r.rows;
}
// Transação: fn recebe o client (c.query) e tudo dentro vira um COMMIT só.
async function tx(fn) {
  const p = getPool();
  if (!p) throw new Error('Postgres não configurado (data/pg-economico.json)');
  const c = await p.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
async function testar() {
  const r = await pq('SELECT current_database() banco, current_user usuario, version() versao, pg_size_pretty(pg_database_size(current_database())) tamanho');
  return r[0];
}
module.exports = { pq, tx, getPool, disponivel, testar };
