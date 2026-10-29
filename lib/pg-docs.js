'use strict';
// lib/pg-docs.js — documentos JSON de um módulo guardados no nosso Postgres (tabela doc_json: modulo, tipo, id, conteudo
// jsonb). Primeiro passo da migração "arquivo → banco" (Tiago, 28/10/2026: "no futuro quero colocar tudo via API"):
// o módulo continua com o mapa em memória e o arquivo de sempre, e passa a gravar TAMBÉM aqui; na subida ele junta os
// dois lados ficando com o mais recente (atualizadoEm). Sem Postgres (testes, máquina sem data/pg-economico.json) tudo
// aqui vira no-op e o módulo funciona só com arquivo, como antes.
// Gravação é assíncrona e por fila por documento (nunca duas gravações do mesmo id fora de ordem); erro vira contador
// e log, nunca derruba a rota que chamou.
const pg = require('./pg');

let esquemaPronto = null;
function esquema() {
  if (!esquemaPronto) {
    esquemaPronto = pg.pq(`CREATE TABLE IF NOT EXISTS doc_json (
      modulo text NOT NULL, tipo text NOT NULL, id text NOT NULL, conteudo jsonb NOT NULL,
      atualizado_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (modulo, tipo, id)
    )`).catch(e => { esquemaPronto = null; throw e; });
  }
  return esquemaPronto;
}
function pgDocs(modulo) {
  const fila = new Map();
  let gravados = 0, erros = 0, ultimoErro = null;
  const disponivel = () => pg.disponivel();
  const enfileirar = (k, fn) => {
    const ant = fila.get(k) || Promise.resolve();
    const p = ant.then(() => esquema()).then(fn).then(() => { gravados++; }, e => { erros++; ultimoErro = `${k}: ${e.message}`; console.error(`[PG-DOCS ${modulo}]`, k, e.message); })
      .finally(() => { if (fila.get(k) === p) fila.delete(k); });
    fila.set(k, p); return p;
  };
  // Map id → conteúdo de um tipo (null sem Postgres)
  async function carregar(tipo) {
    if (!disponivel()) return null;
    await esquema();
    const rows = await pg.pq('SELECT id, conteudo FROM doc_json WHERE modulo = $1 AND tipo = $2', [modulo, tipo]);
    return new Map(rows.map(r => [r.id, r.conteudo]));
  }
  function gravar(tipo, id, obj) {
    if (!disponivel()) return Promise.resolve();
    const json = JSON.stringify(obj).replace(/\\u0000/g, '');
    return enfileirar(tipo + '|' + id, () => pg.pq(`INSERT INTO doc_json (modulo, tipo, id, conteudo, atualizado_em) VALUES ($1, $2, $3, $4::jsonb, now())
      ON CONFLICT (modulo, tipo, id) DO UPDATE SET conteudo = EXCLUDED.conteudo, atualizado_em = now()`, [modulo, tipo, String(id), json]));
  }
  function apagar(tipo, id) {
    if (!disponivel()) return Promise.resolve();
    return enfileirar(tipo + '|' + id, () => pg.pq('DELETE FROM doc_json WHERE modulo = $1 AND tipo = $2 AND id = $3', [modulo, tipo, String(id)]));
  }
  const estado = () => ({ modulo, disponivel: disponivel(), gravados, erros, ultimoErro, pendentes: fila.size });
  return { carregar, gravar, apagar, disponivel, estado };
}
module.exports = pgDocs;
