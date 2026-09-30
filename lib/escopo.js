'use strict';
// Escopo do usuário logado: quais LOJAS ele enxerga (e, na fase 2, qual COMPRADORA).
// Fonte única, sem Express. Usado pelo cadastro (server.js), sessão, /api/me e pelas rotas travadas.
// `lojas: null` no cadastro = todas (cadastro antigo). Admin e gerencial ignoram o campo.
// Spec: docs/superpowers/specs/2026-09-30-usuario-lojas-e-comprador-design.md
const LOJAS_VALIDAS = [1, 2, 3, 4, 5, 6, 10];

function lojasDoBody(v) {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map(Number).filter(n => LOJAS_VALIDAS.includes(n)))].sort((a, b) => a - b);
  return out.length ? out : null;
}
function lojasDoUsuario(user) {
  if (!user || user.perfil === 'admin' || user.perfil === 'gerencial') return null;
  return lojasDoBody(user.lojas);
}
function podeLoja(user, loja) {
  const l = lojasDoUsuario(user);
  return !l || l.includes(Number(loja));
}
function erro403(msg) { const e = new Error(msg); e.status = 403; return e; }
/** O que a API deve usar: { loja: uma loja ou null, lojas: lista permitida ou null (=todas) }. */
function resolverLoja(user, pedida) {
  const l = lojasDoUsuario(user);
  const p = pedida ? Number(pedida) : null;
  if (!l) return { loja: p, lojas: null };
  if (p) { if (!l.includes(p)) throw erro403('Sem permissão pra esta loja'); return { loja: p, lojas: [p] }; }
  return l.length === 1 ? { loja: l[0], lojas: l } : { loja: null, lojas: l };
}
function filtrarPorLoja(user, lista, getLoja) {
  const l = lojasDoUsuario(user);
  return l ? lista.filter(x => l.includes(Number(getLoja(x)))) : lista;
}
/** Objeto { loja: ... } só com as lojas permitidas (ex.: nomes das lojas, PINs). */
function filtrarLojasObj(user, obj) {
  const l = lojasDoUsuario(user);
  return l ? Object.fromEntries(Object.entries(obj || {}).filter(([k]) => l.includes(Number(k)))) : obj;
}
module.exports = { filtrarLojasObj, LOJAS_VALIDAS, lojasDoBody, lojasDoUsuario, podeLoja, resolverLoja, filtrarPorLoja, erro403 };
