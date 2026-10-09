#!/usr/bin/env node
// Consulta SOMENTE LEITURA no MySQL do ERP de produção (192.168.2.252), pra diagnóstico pelo Claude Code.
// Tiago, 09/10/2026: liberou leitura fixa (regra de permissão no settings.json aponta pra este arquivo).
// A senha NÃO fica aqui: vem da variável de ambiente ERP_PASS (usuário ERP_USER, padrão root).
//
//   node scripts/erp-select.js "SELECT ... LIMIT 50"
//   node scripts/erp-select.js --file consulta.sql          (um ou mais SELECT separados por ;)
//   node scripts/erp-select.js --host 127.0.0.1 "SELECT ..." (ERP de teste)
//
// Recusa qualquer coisa que não seja SELECT/SHOW/DESCRIBE/EXPLAIN (mesma trava do server.js) e
// limita a 500 linhas por consulta pra não despejar tabela inteira no terminal.
const fs = require('fs');
const path = require('path');
const mysql = require(path.join(__dirname, '..', 'node_modules', 'mysql2', 'promise'));

const args = process.argv.slice(2);
let host = '192.168.2.252', file = null, sqls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host') host = args[++i];
  else if (args[i] === '--file') file = args[++i];
  else sqls.push(args[i]);
}
if (file) sqls.push(...fs.readFileSync(file, 'utf8').split(/;\s*(?:\r?\n|$)/));
sqls = sqls.map(s => s.trim()).filter(Boolean);
if (!sqls.length) { console.error('uso: node scripts/erp-select.js "SELECT ..." | --file x.sql [--host ip]'); process.exit(2); }
if (!process.env.ERP_PASS) { console.error('ERP_PASS não definida (senha do MySQL do ERP) — defina no bloco "env" do settings.json do Claude Code ou no ambiente.'); process.exit(2); }

const SO_LEITURA = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
const PROIBIDO = /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|LOCK|CALL|LOAD|SET|INTO\s+(OUTFILE|DUMPFILE))\b/i;
for (const s of sqls) {
  if (!SO_LEITURA.test(s) || PROIBIDO.test(s)) { console.error('RECUSADO (só leitura): ' + s.slice(0, 120)); process.exit(3); }
}

(async () => {
  const c = await mysql.createConnection({ host, port: 3306, user: process.env.ERP_USER || 'root', password: process.env.ERP_PASS, connectTimeout: 15000, multipleStatements: false });
  try {
    for (const s of sqls) {
      const sql = /\bLIMIT\b/i.test(s) ? s : s.replace(/;?\s*$/, '') + ' LIMIT 500';
      const t0 = Date.now();
      const [rows] = await c.query(sql);
      console.log('-- ' + sql.replace(/\s+/g, ' ').slice(0, 200) + '  (' + rows.length + ' linhas, ' + (Date.now() - t0) + ' ms)');
      if (rows.length) console.log(JSON.stringify(rows, (k, v) => v instanceof Date ? v.toISOString().slice(0, 19) : v, 1));
    }
  } finally { await c.end().catch(() => {}); }
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1); });
