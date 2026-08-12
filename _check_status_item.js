const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({ host:'192.168.2.252', port:3306, user:'root', password:'1900', connectTimeout:15000 });
  try {
    const [dist] = await conn.query(`
      SELECT status, Reconferir, COUNT(*) c FROM central.conferenciaitens
      GROUP BY status, Reconferir ORDER BY status, Reconferir
    `);
    console.log('distribuicao status x Reconferir (todo o historico):', JSON.stringify(dist));

    // pedidos recentes que tenham item com Reconferir=1, ver status deles
    const [comFlag] = await conn.query(`
      SELECT chave, codigobarra, status, Reconferir FROM central.conferenciaitens
      WHERE Reconferir=1 ORDER BY chave DESC LIMIT 15
    `);
    console.log('\nitens com Reconferir=1 recentes:', JSON.stringify(comFlag));
  } finally { await conn.end(); }
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
