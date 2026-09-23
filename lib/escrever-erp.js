'use strict';
// Única porta de escrita no MySQL de TESTE (.254). Faz SELECT antes, executa em transação,
// SELECT depois e grava tudo em data/log-erp (ver lib/log-erp.js). Nunca escreve no .252.
// Spec: docs/superpowers/specs/2026-09-23-log-mudancas-erp-design.md
const L = require('./log-erp');

const ERP_PRODUCAO = '192.168.2.252';
const LIMITE_PADRAO = 500;

/**
 * criarEscreverERP({ config, criarConexao, dirLog, agora })
 *  - config: { host, port, user, password } do MySQL de teste
 *  - criarConexao: async (config) => conexão mysql2/promise (injetável nos testes)
 *  - dirLog: pasta dos .jsonl
 *  - agora: () => Date (injetável)
 * Retorna: async escreverERP(opcoes) => { ok, status, afetados, id, erro? }
 */
function criarEscreverERP({ config, criarConexao, dirLog, agora = () => new Date() }) {
  return async function escreverERP(op = {}) {
    const inicio = Date.now();
    const entrada = {
      id: L.novoId(agora()), quando: L.agoraIso(agora()),
      usuario: String(op.usuario || '').trim(), servidor: 'teste-254', host: config.host,
      banco: op.banco, tabela: op.tabela, operacao: op.operacao, motivo: String(op.motivo || '').trim(),
      where: op.where || null, valores: op.valores || null, limite: Number(op.limite) > 0 ? Number(op.limite) : LIMITE_PADRAO,
      sql: null, params: null, afetados: null, antes: [], depois: [], colunas_mudadas: [], status: 'ok', erro: null, ms: 0,
    };
    const fim = (status, erro) => {
      entrada.status = status; entrada.erro = erro || null; entrada.ms = Date.now() - inicio;
      L.gravar(dirLog, entrada);
      return { ok: status === 'ok', status, afetados: entrada.afetados, id: entrada.id, erro: entrada.erro };
    };

    // 1. validação (recusa sem abrir conexão)
    if (config.host === ERP_PRODUCAO) return fim('recusado', 'escrita no ERP de produção (192.168.2.252) é proibida; só no MySQL de teste do .254');
    if (!entrada.usuario) return fim('recusado', 'usuário obrigatório');
    if (entrada.motivo.length < 5) return fim('recusado', 'motivo obrigatório (mínimo 5 caracteres)');
    let m;
    try { m = L.montarSql(op); } catch (e) { return fim('recusado', e.message); }
    entrada.sql = m.sql; entrada.params = m.params;

    // 2. conexão
    let conn;
    try { conn = await criarConexao(config); }
    catch (e) { return fim('erro', 'MySQL de teste do .254 não respondeu (' + (e.code || e.message) + ')'); }

    // 3. antes → executa → depois, tudo numa transação
    try {
      await conn.beginTransaction();
      if (m.sqlCount) {
        const [[c]] = await conn.query(m.sqlCount, m.paramsSelect);
        if (c.n > entrada.limite) { await conn.rollback(); return fim('recusado', `afetaria ${c.n} registros, acima do limite de ${entrada.limite}`); }
        const [antes] = await conn.query(m.sqlSelect, m.paramsSelect);
        entrada.antes = antes;
      }
      const [r] = await conn.query(m.sql, m.params);
      entrada.afetados = r.affectedRows ?? null;
      if (op.operacao === 'update') {
        const [depois] = await conn.query(m.sqlSelect, m.paramsSelect);
        entrada.depois = depois;
      } else if (op.operacao === 'insert' && r.insertId) {
        const alvo = '`' + op.banco + '`.`' + op.tabela + '`';
        try {
          const [keys] = await conn.query('SHOW KEYS FROM ' + alvo + " WHERE Key_name = 'PRIMARY'");
          const pk = keys && keys[0] && keys[0].Column_name;
          if (pk && L.nomeValido(pk)) { const [d] = await conn.query('SELECT * FROM ' + alvo + ' WHERE `' + pk + '` = ?', [r.insertId]); entrada.depois = d; }
        } catch (e) { /* sem PK legível: fica sem "depois" */ }
      }
      entrada.colunas_mudadas = L.diff(entrada.antes, entrada.depois);
      await conn.commit();
      return fim('ok');
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      return fim('erro', e.sqlMessage || e.message);
    } finally {
      try { await conn.end(); } catch (_) {}
    }
  };
}

module.exports = { criarEscreverERP, ERP_PRODUCAO, LIMITE_PADRAO };
