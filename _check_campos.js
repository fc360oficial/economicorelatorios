const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({ host:'192.168.2.252', port:3306, user:'root', password:'1900', connectTimeout:15000 });
  try {
    const [cols] = await conn.query(`
      SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA='central' AND TABLE_NAME='conferenciaitens'
      ORDER BY ORDINAL_POSITION
    `);
    console.log('colunas conferenciaitens:', JSON.stringify(cols));

    const [full] = await conn.query(`SELECT * FROM central.conferenciaitens WHERE chave='177491'`);
    console.log('\nlinha completa do item do pedido 177491:', JSON.stringify(full, null, 2));
  } finally { await conn.end(); }
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
