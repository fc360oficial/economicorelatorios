const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: '192.168.2.252',
    user: 'root',
    password: '1900',
    database: 'central'
  });

  const [[tot]] = await conn.query(
    `SELECT COUNT(*) as total FROM central.itens WHERE CodDesativado = 0`
  );
  const [[preenchido]] = await conn.query(
    `SELECT COUNT(*) as qtd FROM central.itens WHERE CodDesativado = 0 AND UnidadeCompra IS NOT NULL AND TRIM(UnidadeCompra) <> ''`
  );
  const [[difUnid]] = await conn.query(
    `SELECT COUNT(*) as qtd FROM central.itens WHERE CodDesativado = 0 AND UPPER(TRIM(UnidadeCompra)) <> UPPER(TRIM(Unid)) AND TRIM(UnidadeCompra) <> ''`
  );
  const [[embMaior1]] = await conn.query(
    `SELECT COUNT(*) as qtd FROM central.itens WHERE CodDesativado = 0 AND qtdemb > 1`
  );
  console.log({ total: tot.total, unidadeCompraPreenchido: preenchido.qtd, unidadeCompraDiferenteDeUnid: difUnid.qtd, qtdembMaiorQue1: embMaior1.qtd });

  await conn.end();
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
