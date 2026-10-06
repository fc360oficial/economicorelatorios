const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: '192.168.2.252', port: 3306, user: 'root', password: '1900', connectTimeout: 15000
  });

  const [dbs] = await conn.query(`SHOW DATABASES LIKE 'loja%'`);
  console.log('=== BANCOS loja* ===');
  console.log(dbs);

  const [cols] = await conn.query(`SHOW COLUMNS FROM loja20045.contasapagar`);
  console.log('=== COLUNAS loja20045.contasapagar ===');
  console.log(cols.map(c => c.Field + ':' + c.Type).join('\n'));

  const [sample] = await conn.query(`SELECT * FROM loja20045.contasapagar ORDER BY nReg DESC LIMIT 3`);
  console.log('=== AMOSTRA (3 registros mais recentes) ===');
  console.log(JSON.stringify(sample, null, 2));

  const [countMes] = await conn.query(`SELECT COUNT(*) as n, MIN(Vencimento) as minV, MAX(Vencimento) as maxV FROM loja20045.contasapagar WHERE MONTH(Vencimento)=9 AND YEAR(Vencimento)=2026`);
  console.log('=== SETEMBRO 2026 por Vencimento (loja20045) ===', countMes);

  await conn.end();
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
