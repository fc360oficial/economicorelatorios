// Ajustes de Estoque pedidos pela loja (28/10/2026, Tiago: "no mobile, quando eu clicar no produto do Sem Giro, que apareça pra
// atualizar estoque: o sistema diz 50 e a loja contou 30 — essa atualização tem que chegar pra mim em Processos, numa aba, pra eu
// atualizar na central"). O gerente manda a contagem pelo celular (Gestão Gerencial › Sem Giro); a Coordenação vê em
// Processos › Ajustes de Estoque e, depois de lançar na central (ERP), marca "Atualizado" (ou "Recusado" com o motivo).
// Nada aqui escreve no ERP: o lançamento na central continua manual. Dados em data/ajustes-estoque/ajustes.json.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

let DIR = null, ARQ = null, S = null;
const LOJA_TXT = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão', 10: 'CD' };
const STATUS = { pendente: 'Aguardando a central', atualizado: 'Atualizado na central', recusado: 'Recusado' };
const agoraISO = () => new Date().toISOString();
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : null; };
const erro = (msg, status) => { const e = new Error(msg); e.status = status || 400; return e; };

function init(deps) {
  DIR = (deps && deps.dataDir) || path.join(__dirname, '..', 'data', 'ajustes-estoque');
  ARQ = path.join(DIR, 'ajustes.json');
  try { S = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { S = null; }
  if (!S || !Array.isArray(S.itens)) S = { itens: [] };
}
function salvar() { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(S, null, 1)); }
const quem = u => ({ usuario: String((u && u.usuario) || ''), nome: String((u && u.nome) || (u && u.usuario) || '') });

/** Loja que o usuário pode pedir ajuste: gerencial = a própria; os outros = a que mandarem. */
function lojaDe(user, loja) {
  if (user && user.perfil === 'gerencial') { if (!user.loja_id) throw erro('Usuário gerencial sem loja vinculada', 403); return +user.loja_id; }
  const ln = parseInt(loja, 10); if (!LOJA_TXT[ln]) throw erro('Loja inválida'); return ln;
}

/** 'sim'/'nao'/true/false → true/false; qualquer outra coisa → null (não respondeu). */
function manterDe(v) { if (v === true || v === false) return v; const s = String(v == null ? '' : v).trim().toLowerCase(); return s === 'sim' || s === 'true' || s === '1' ? true : s === 'nao' || s === 'não' || s === 'false' || s === '0' ? false : null; }
/** Pedido novo. Já existe um pendente da mesma loja × produto → vira o mesmo pedido com a contagem nova (sem duplicar). */
function criar(user, b) {
  b = b || {};
  const loja = lojaDe(user, b.loja);
  const cod = String(b.cod || '').trim(); if (!cod) throw erro('Produto sem código');
  const contado = num(b.contado); if (contado == null || contado < 0) throw erro('Informe a quantidade contada (0 ou mais)');
  const estSistema = num(b.estSistema);
  // 28/10 (Tiago): observação obrigatória e a pergunta "Deseja manter esse produto na sua loja?" (sim/não) — vai pra retaguarda
  const obs = String(b.obs || '').trim().slice(0, 300); if (!obs) throw erro('Escreva a observação');
  const manter = manterDe(b.manter); if (manter == null) throw erro('Responda se deseja manter o produto na loja (sim ou não)');
  const q = quem(user), agora = agoraISO();
  let r = S.itens.find(x => x.status === 'pendente' && +x.loja === loja && x.cod === cod);
  if (r) {
    r.historico = r.historico || []; r.historico.push({ em: r.atualizadoEm || r.criadoEm, contado: r.contado, obs: r.obs, manter: r.manter, por: r.nome });
    Object.assign(r, { contado, estSistema: estSistema != null ? estSistema : r.estSistema, obs, manter, atualizadoEm: agora, usuario: q.usuario, nome: q.nome });
    if (r.historico.length > 10) r.historico = r.historico.slice(-10);
  } else {
    r = { id: crypto.randomBytes(6).toString('hex'), loja, lojaTxt: LOJA_TXT[loja], cod, descricao: String(b.descricao || '').trim().slice(0, 120), unid: String(b.unid || '').trim().slice(0, 5),
          grupo: String(b.grupo || '').trim().slice(0, 60), estSistema, contado, obs, manter, origem: String(b.origem || 'sem-giro').slice(0, 30),
          status: 'pendente', criadoEm: agora, usuario: q.usuario, nome: q.nome };
    S.itens.unshift(r);
  }
  if (S.itens.length > 5000) S.itens = S.itens.slice(0, 5000);
  salvar();
  return visao(r);
}
const dif = r => (r.estSistema == null || r.contado == null) ? null : Math.round((r.contado - r.estSistema) * 1000) / 1000;
function visao(r) { return { ...r, diferenca: dif(r), statusTxt: STATUS[r.status] || r.status }; }

/** Pedidos da loja nos últimos `dias` (pro celular marcar os itens já enviados), por código. */
function daLoja(user, loja, dias) {
  const ln = lojaDe(user, loja), lim = Date.now() - (dias || 30) * 864e5;
  const out = {};
  for (const r of S.itens) { if (+r.loja !== ln) continue; if (new Date(r.atualizadoEm || r.criadoEm).getTime() < lim && r.status !== 'pendente') continue; if (!out[r.cod]) out[r.cod] = visao(r); }
  return { loja: ln, itens: Object.values(out) };
}

/** Lista pra Processos: status (pendente|atualizado|recusado|todos), loja, dias (só pros tratados). */
function listar(f) {
  f = f || {}; const st = f.status || 'pendente', ln = parseInt(f.loja, 10) || 0, lim = Date.now() - (parseInt(f.dias, 10) || 30) * 864e5;
  return S.itens.filter(r => (st === 'todos' || r.status === st) && (!ln || +r.loja === ln) && (r.status === 'pendente' || new Date(r.tratadoEm || r.criadoEm).getTime() >= lim)).map(visao);
}
function resumo() {
  const p = S.itens.filter(r => r.status === 'pendente'), hoje = agoraISO().slice(0, 10);
  const porLoja = {}; for (const r of p) porLoja[r.loja] = (porLoja[r.loja] || 0) + 1;
  return { pendentes: p.length, hoje: S.itens.filter(r => r.criadoEm.slice(0, 10) === hoje).length, porLoja, lojas: LOJA_TXT };
}
const pendencias = () => ({ n: S.itens.filter(r => r.status === 'pendente').length });

/** Coordenação marcou: 'atualizado' (lançou na central) ou 'recusado' (com motivo). */
function tratar(user, id, b) {
  b = b || {}; const r = S.itens.find(x => x.id === id); if (!r) throw erro('Pedido não encontrado', 404);
  const status = String(b.status || ''); if (!['atualizado', 'recusado', 'pendente'].includes(status)) throw erro('Situação inválida');
  if (status === 'recusado' && !String(b.obs || '').trim()) throw erro('Diga o motivo da recusa');
  const q = quem(user);
  r.status = status; r.tratadoEm = status === 'pendente' ? null : agoraISO(); r.tratadoPor = status === 'pendente' ? null : q.nome; r.respostaObs = String(b.obs || '').trim().slice(0, 300);
  salvar();
  return visao(r);
}

module.exports = { init, criar, daLoja, listar, resumo, pendencias, tratar, STATUS, LOJA_TXT, _estado: () => S };
