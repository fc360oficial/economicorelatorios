// diagnóstico SOMENTE LEITURA: por que ABACAXI UND (2530) tem estoque na loja 10 (CD)
const fs = require('fs'); const mysql = require('mysql2/promise');
const src = fs.readFileSync('server.js', 'utf8');
const m = src.match(/const dbConfig = \{([\s\S]*?)\};/); const cfg = eval('({' + m[1].replace(/process\.env\.DB_HOST \|\| ERP_PRODUCAO/, "'192.168.2.252'") + '})');
(async () => {
  const c = await mysql.createConnection(cfg);
  const q = async (s, p = []) => (await c.query(s, p))[0];
  const cod = '2530';
  console.log('estoquen10:', await q('SELECT * FROM central.estoquen10 WHERE CodigoBarra=?', [cod]));
  console.log('itens:', await q('SELECT CodigoBarra, Descricao, CodDesativado, qtdemb, Pai, unidade, Setor, Grupo FROM central.itens WHERE CodigoBarra=?', [cod]));
  for (const ln of [1, 2, 3, 4, 5, 6]) { const r = await q(`SELECT Qtd FROM central.estoquen${ln} WHERE CodigoBarra=?`, [cod]); console.log('estoque L' + ln + ':', r.length ? r[0].Qtd : '-'); }
  console.log('entradas loja 10 (compras):', await q(`SELECT c.nNota, c.Data, c.Movimentacao, c.CodFornec, cp.Qtd, cp.QtdEmb FROM central.compraprodutos cp JOIN central.compras c ON c.nCompra=cp.nCompra AND c.nLoja=cp.nLoja WHERE cp.nLoja=10 AND cp.CodigoBarra=? ORDER BY c.Data DESC LIMIT 10`, [cod]));
  console.log('vendas do CD (delivery_produtos):', await q(`SELECT COUNT(*) n, SUM(dp.Qtd) qtd, MAX(d.Data) ultima FROM central.delivery_produtos dp JOIN central.delivery d ON d.nReg=dp.nPedido WHERE d.nLoja=10 AND dp.CodigoBarra=?`, [cod]).catch(e => e.message));
  console.log('embalagempadrao_venda:', await q('SELECT * FROM central.embalagempadrao_venda WHERE Codigobarra=?', [cod]));
  const tabs = await q("SHOW TABLES FROM central LIKE 'estoquen10%'"); console.log('tabelas estoquen10*:', tabs.map(t => Object.values(t)[0]));
  console.log('itens com Qtd>0 na loja 10 e código curto (<8 dígitos):', await q('SELECT e.CodigoBarra, e.Qtd, TRIM(i.Descricao) d FROM central.estoquen10 e JOIN central.itens i ON i.CodigoBarra=e.CodigoBarra WHERE e.Qtd>0 AND i.CodDesativado=0 AND LENGTH(e.CodigoBarra)<8 ORDER BY e.Qtd DESC LIMIT 15'));
  await c.end();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
