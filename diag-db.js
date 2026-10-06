const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ host: '192.168.2.252', port: 3306, user: 'root', password: '1900' });
  const q = async (s, p) => (await c.query(s, p))[0];
  console.log('threads:', await q(`SHOW STATUS LIKE 'Threads_connected'`), await q(`SHOW VARIABLES LIKE 'max_connections'`));
  const pl = await q(`SELECT SUBSTRING_INDEX(Host,':',1) h, COUNT(*) n FROM information_schema.processlist GROUP BY h ORDER BY n DESC LIMIT 6`); console.log('processlist por host:', pl);
  await c.end();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
