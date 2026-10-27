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
// ── Compradora: usuário perfil 'comprador' com comprador_nome só enxerga as LISTAS dela ──
// nregsComprador = { 'NOME NO ERP': [nReg da lista, ...] } (NREGS_COMPRADOR do server.js);
// resolve = resolveComprador (apelido do cadastro → nome completo do ERP).
function compradorDoUsuario(user) {
  return user && user.perfil === 'comprador' && user.comprador_nome ? String(user.comprador_nome).trim().toUpperCase() : null;
}
/** Ids das listas da compradora (null = sem trava). Nome que não bate com o ERP = [] — nunca tudo aberto. */
function listasDoUsuario(user, nregsComprador, resolve = n => n) {
  const nome = compradorDoUsuario(user);
  if (!nome) return null;
  return (nregsComprador || {})[resolve(nome)] || [];
}
function podeLista(user, nregsComprador, nReg, resolve) {
  const l = listasDoUsuario(user, nregsComprador, resolve);
  return !l || l.map(Number).includes(Number(nReg));
}
function filtrarPorLista(user, nregsComprador, lista, getNReg, resolve) {
  const l = listasDoUsuario(user, nregsComprador, resolve);
  if (!l) return lista;
  const set = new Set(l.map(Number));
  return lista.filter(x => set.has(Number(getNReg(x))));
}
// Perfil gerencial (gerente de loja, 22/10/26, Tiago): só a Gestão Gerencial e só da própria loja.
// Lista do que pode (o resto é bloqueado); antes a trava era só na tela e /index.html abria direto.
const GERENCIAL_LIVRE = ['/gestao-gerencial.html', '/api/me', '/api/versao', '/api/logout', '/gestao-disciplinar.html'];
// Gestão Disciplinar (27/10/26): o gerente abre solicitação pelo celular; a trava por loja é do próprio módulo (lib/disciplinar.js, loja_id)
const GERENCIAL_PREFIXO = ['/api/disciplinar/'];
// /inicio (27/10/26): quadros Ponto e Sem Giro da loja na tela de entrada do gerente (lib/gerencial-inicio.js)
const GERENCIAL_POR_LOJA = ['/api/gestao-gerencial', '/api/gestao-gerencial/inicio', '/api/top-produtos'];
/** Motivo do bloqueio pro perfil gerencial, ou null se pode. Outros perfis: sempre null. */
function bloqueioGerencial(user, path, query) {
  if (!user || user.perfil !== 'gerencial') return null;
  if (GERENCIAL_LIVRE.includes(path) || GERENCIAL_PREFIXO.some(p => String(path).startsWith(p))) return null;
  if (!GERENCIAL_POR_LOJA.includes(path)) return 'Perfil gerencial só acessa a Gestão Gerencial';
  const loja = Number(user.loja_id);
  if (!loja) return 'Usuário gerencial sem loja vinculada';
  return String((query || {}).loja) === String(loja) ? null : 'Sem permissão pra esta loja';
}
module.exports = { bloqueioGerencial, compradorDoUsuario, listasDoUsuario, podeLista, filtrarPorLista, filtrarLojasObj, LOJAS_VALIDAS, lojasDoBody, lojasDoUsuario, podeLoja, resolverLoja, filtrarPorLoja, erro403 };
