'use strict';
// Única porta de escrita no MySQL de TESTE (.254). Faz SELECT antes, executa em transação,
// SELECT depois e grava tudo em data/log-erp (ver lib/log-erp.js). Nunca escreve no .252.
// Spec: docs/superpowers/specs/2026-09-23-log-mudancas-erp-design.md
//
// Duas formas:
//  - escreverERP({ usuario, motivo, banco, tabela, operacao, where, valores, limite })  → 1 comando
//  - escreverERP.lote({ usuario, motivo, banco, passos: [{ tabela, operacao, where, valores }], limite })
//      → vários comandos numa transação só (ex.: cabeçalho do pedido + itens + envio). Um passo pode
//        usar o id gerado por um passo anterior com { $id: <índice do passo> } em valores/where.
//        Regra do Tiago: só insert/update/delete (nunca DROP/TRUNCATE/ALTER), sempre com WHERE.
const L = require('./log-erp');

const ERP_PRODUCAO = '192.168.2.252';
const LIMITE_PADRAO = 500;

function criarEscreverERP({ config, criarConexao, dirLog, agora = () => new Date() }) {
  function novaEntrada(op) {
    return {
      id: L.novoId(agora()), quando: L.agoraIso(agora()),
      usuario: String(op.usuario || '').trim(), servidor: 'teste-254', host: config.host,
      banco: op.banco, tabela: op.tabela, operacao: op.operacao, motivo: String(op.motivo || '').trim(),
      where: op.where || null, valores: op.valores || null, limite: Number(op.limite) > 0 ? Number(op.limite) : LIMITE_PADRAO,
      sql: null, params: null, afetados: null, antes: [], depois: [], colunas_mudadas: [], status: 'ok', erro: null, ms: 0,
    };
  }
  function fechar(entrada, inicio, status, erro) {
    entrada.status = status; entrada.erro = erro || null; entrada.ms = Date.now() - inicio;
    L.gravar(dirLog, entrada);
    return { ok: status === 'ok', status, afetados: entrada.afetados, id: entrada.id, erro: entrada.erro, ids: entrada.ids_gerados || null };
  }
  function validarBase(entrada) {
    if (config.host === ERP_PRODUCAO) return 'escrita no ERP de produção (192.168.2.252) é proibida; só no MySQL de teste do .254';
    if (!entrada.usuario) return 'usuário obrigatório';
    if (entrada.motivo.length < 5) return 'motivo obrigatório (mínimo 5 caracteres)';
    return null;
  }
  async function conectar() {
    try { return { conn: await criarConexao(config) }; }
    catch (e) { return { erro: 'MySQL de teste do .254 não respondeu (' + (e.code || e.message) + ')' }; }
  }

  // ── 1 comando ──────────────────────────────────────────────────────────────
  async function escreverERP(op = {}) {
    const inicio = Date.now();
    const entrada = novaEntrada(op);
    const fim = (s, e) => fechar(entrada, inicio, s, e);

    const inval = validarBase(entrada); if (inval) return fim('recusado', inval);
    let m;
    try { m = L.montarSql(op); } catch (e) { return fim('recusado', e.message); }
    entrada.sql = m.sql; entrada.params = m.params;

    const cx = await conectar(); if (cx.erro) return fim('erro', cx.erro);
    const conn = cx.conn;
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
        entrada.ids_gerados = [r.insertId];
        const d = await lerPorPk(conn, op.banco, op.tabela, r.insertId); if (d) entrada.depois = d;
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
  }

  async function lerPorPk(conn, banco, tabela, id) {
    const alvo = '`' + banco + '`.`' + tabela + '`';
    try {
      const [keys] = await conn.query('SHOW KEYS FROM ' + alvo + " WHERE Key_name = 'PRIMARY'");
      const pk = keys && keys[0] && keys[0].Column_name;
      if (pk && L.nomeValido(pk)) { const [d] = await conn.query('SELECT * FROM ' + alvo + ' WHERE `' + pk + '` = ?', [id]); return d; }
    } catch (e) { /* sem PK legível */ }
    return null;
  }

  // ── lote (vários comandos, 1 transação, 1 entrada no Log) ──────────────────
  const resolver = (obj, ids) => {
    if (!obj) return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && '$id' in v) {
        const id = ids[v.$id];
        if (id === undefined || id === null) throw new Error(`passo referencia { $id: ${v.$id} } mas esse passo não gerou id`);
        out[k] = id;
      } else out[k] = v;
    }
    return out;
  };

  escreverERP.lote = async function escreverLoteERP(op = {}) {
    const inicio = Date.now();
    const passos = Array.isArray(op.passos) ? op.passos : [];
    const entrada = novaEntrada({ ...op, tabela: [...new Set(passos.map(p => p.tabela))].join(', '), operacao: 'lote', where: null, valores: null });
    entrada.passos = passos.map(p => ({ tabela: p.tabela, operacao: p.operacao, where: p.where || null, valores: p.valores || null }));
    entrada.sql = []; entrada.params = []; entrada.ids_gerados = []; entrada.afetados = 0;
    const fim = (s, e) => fechar(entrada, inicio, s, e);

    const inval = validarBase(entrada); if (inval) return fim('recusado', inval);
    if (!passos.length) return fim('recusado', 'lote sem passos');
    if (passos.length > 2000) return fim('recusado', 'lote com mais de 2000 passos');
    // valida a forma de todos os passos antes de abrir conexão (sem resolver $id ainda)
    for (let i = 0; i < passos.length; i++) {
      const p = passos[i];
      try { L.montarSql({ banco: op.banco, tabela: p.tabela, operacao: p.operacao, where: p.where, valores: p.valores }); }
      catch (e) { return fim('recusado', `passo ${i} (${p.tabela}): ${e.message}`); }
      for (const src of [p.where, p.valores]) for (const v of Object.values(src || {})) {
        if (v && typeof v === 'object' && '$id' in v && !(Number.isInteger(v.$id) && v.$id >= 0 && v.$id < i)) return fim('recusado', `passo ${i}: { $id: ${v.$id} } precisa apontar pra um passo anterior`);
      }
    }

    const cx = await conectar(); if (cx.erro) return fim('erro', cx.erro);
    const conn = cx.conn;
    const ids = [];
    try {
      await conn.beginTransaction();
      for (let i = 0; i < passos.length; i++) {
        const p = passos[i];
        const m = L.montarSql({ banco: op.banco, tabela: p.tabela, operacao: p.operacao, where: resolver(p.where, ids), valores: resolver(p.valores, ids) });
        entrada.sql.push(m.sql); entrada.params.push(m.params);
        if (m.sqlCount) {
          const [[c]] = await conn.query(m.sqlCount, m.paramsSelect);
          if (c.n > entrada.limite) { await conn.rollback(); return fim('recusado', `passo ${i} (${p.tabela}) afetaria ${c.n} registros, acima do limite de ${entrada.limite}`); }
          const [antes] = await conn.query(m.sqlSelect, m.paramsSelect);
          for (const r of antes) entrada.antes.push({ _passo: i, _tabela: p.tabela, ...r });
        }
        const [r] = await conn.query(m.sql, m.params);
        entrada.afetados += r.affectedRows || 0;
        ids[i] = p.operacao === 'insert' ? (r.insertId || null) : null;
        if (p.operacao === 'update') {
          const [depois] = await conn.query(m.sqlSelect, m.paramsSelect);
          for (const d of depois) entrada.depois.push({ _passo: i, _tabela: p.tabela, ...d });
        } else if (p.operacao === 'insert' && r.insertId) {
          const d = await lerPorPk(conn, op.banco, p.tabela, r.insertId);
          for (const x of d || [{}]) entrada.depois.push({ _passo: i, _tabela: p.tabela, ...x });
        }
      }
      entrada.ids_gerados = ids;
      await conn.commit();
      return fim('ok');
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      entrada.ids_gerados = [];
      return fim('erro', e.sqlMessage || e.message);
    } finally {
      try { await conn.end(); } catch (_) {}
    }
  };

  return escreverERP;
}

module.exports = { criarEscreverERP, ERP_PRODUCAO, LIMITE_PADRAO };
