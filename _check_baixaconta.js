const mysql = require('mysql2/promise');
(async () => {
  try {
    const c = await mysql.createConnection({ host: process.env.DB_HOST || '192.168.2.252', port: 3306, user: 'root', password: '1900', connectTimeout: 15000 });
    const [cols] = await c.execute('DESCRIBE loja20045.contasapagarbaixaconta');
    console.log('COLUNAS contasapagarbaixaconta:', cols.map(x => x.Field).join(','));
    const [r1] = await c.execute('SELECT * FROM loja20045.contasapagarbaixaconta WHERE nReg=283994');
    console.log('BAIXA nReg=283994:', JSON.stringify(r1, null, 2));
    const [r2] = await c.execute('SELECT * FROM loja20045.contasapagarbaixaconta WHERE nReg=284392');
    console.log('BAIXA nReg=284392:', JSON.stringify(r2, null, 2));
    const [maxd] = await c.execute('SELECT MAX(DataPagto) as ultimo, COUNT(*) as total FROM loja20045.contasapagarbaixaconta');
    console.log('RESUMO TABELA:', JSON.stringify(maxd));
    await c.end();
  } catch (e) { console.error('ERRO:', e.message); }
})();
