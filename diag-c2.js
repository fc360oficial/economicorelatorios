const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ host: '192.168.2.252', port: 3306, user: 'root', password: '1900' });
  const q = async (s, p) => (await c.query(s, p))[0];
  for (const t of ['conferencia', 'conferenciaitens', 'conferecadastro']) { const cols = await q(`SHOW COLUMNS FROM central.${t}`); console.log(t, ':', cols.map(x => x.Field).join(',')); }
  console.log('conferencia 182209 (L1 4942 fechada):', await q(`SELECT * FROM central.conferencia WHERE nConferencia=182209`));
  console.log('conferencia 182468 (L1 4990 aberta):', await q(`SELECT * FROM central.conferencia WHERE nConferencia=182468`));
  console.log('conferencia 182436 (L2 5003 aberta):', await q(`SELECT * FROM central.conferencia WHERE nConferencia=182436`));
  console.log('itens conf 182209:', await q(`SELECT * FROM central.conferenciaitens WHERE nConferencia=182209 LIMIT 3`));
  console.log('itens conf 182468:', await q(`SELECT * FROM central.conferenciaitens WHERE nConferencia=182468 LIMIT 3`));
  console.log('conferencia por nNota 4990/5003:', await q(`SELECT * FROM central.conferencia WHERE nNota IN ('4990','5003') ORDER BY nConferencia DESC LIMIT 6`).catch(e => e.message));
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
