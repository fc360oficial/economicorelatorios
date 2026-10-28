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
  // 28/10 (Tiago): "Solicitar rebaixa de preço?" só quando ele quer manter o produto; preço sugerido opcional. Quem decide é a
  // retaguarda na tela de Ajustes (tratarRebaixa), separado da decisão do estoque.
  let rebaixa = null; if (manter) { rebaixa = manterDe(b.rebaixa); if (rebaixa == null) throw erro('Responda se quer solicitar rebaixa de preço (sim ou não)'); }
  const precoSugerido = rebaixa && num(b.precoSugerido) > 0 ? Math.round(num(b.precoSugerido) * 100) / 100 : null;
  const precoAtual = num(b.precoAtual) > 0 ? num(b.precoAtual) : null, custo = num(b.custo) > 0 ? num(b.custo) : null;
  const q = quem(user), agora = agoraISO();
  let r = S.itens.find(x => x.status === 'pendente' && +x.loja === loja && x.cod === cod);
  if (r) {
    r.historico = r.historico || []; r.historico.push({ em: r.atualizadoEm || r.criadoEm, contado: r.contado, obs: r.obs, manter: r.manter, rebaixa: r.rebaixa, precoSugerido: r.precoSugerido, por: r.nome });
    Object.assign(r, { contado, estSistema: estSistema != null ? estSistema : r.estSistema, obs, manter, rebaixa, precoSugerido, precoAtual: precoAtual != null ? precoAtual : r.precoAtual, custo: custo != null ? custo : r.custo, atualizadoEm: agora, usuario: q.usuario, nome: q.nome });
    // rebaixa já decidida continua decidida; pedido novo de rebaixa (ou desistência) muda a pendência
    r.rebaixaStatus = rebaixa ? (r.rebaixaStatus && r.rebaixaStatus !== 'pendente' ? r.rebaixaStatus : 'pendente') : null;
    if (r.historico.length > 10) r.historico = r.historico.slice(-10);
  } else {
    r = { id: crypto.randomBytes(6).toString('hex'), loja, lojaTxt: LOJA_TXT[loja], cod, descricao: String(b.descricao || '').trim().slice(0, 120), unid: String(b.unid || '').trim().slice(0, 5),
          grupo: String(b.grupo || '').trim().slice(0, 60), estSistema, contado, obs, manter, rebaixa, precoSugerido, precoAtual, custo, rebaixaStatus: rebaixa ? 'pendente' : null, origem: String(b.origem || 'sem-giro').slice(0, 30),
          status: 'pendente', criadoEm: agora, usuario: q.usuario, nome: q.nome };
    S.itens.unshift(r);
  }
  if (S.itens.length > 5000) S.itens = S.itens.slice(0, 5000);
  salvar();
  return visao(r);
}
const dif = r => (r.estSistema == null || r.contado == null) ? null : Math.round((r.contado - r.estSistema) * 1000) / 1000;
const REBAIXA = { pendente: 'Rebaixa a decidir', aceita: 'Rebaixa aceita', recusada: 'Rebaixa recusada' };
function visao(r) { return { ...r, diferenca: dif(r), statusTxt: STATUS[r.status] || r.status, rebaixaTxt: r.rebaixaStatus ? REBAIXA[r.rebaixaStatus] || r.rebaixaStatus : null }; }
/** Pendente pra retaguarda = estoque ainda não tratado OU rebaixa ainda não decidida. */
const pendente = r => r.status === 'pendente' || r.rebaixaStatus === 'pendente';

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
  return S.itens.filter(r => (st === 'todos' || (st === 'pendente' ? pendente(r) : r.status === st)) && (!ln || +r.loja === ln) && (pendente(r) || new Date(r.tratadoEm || r.rebaixaEm || r.criadoEm).getTime() >= lim)).map(visao);
}
function resumo() {
  const p = S.itens.filter(pendente), hoje = agoraISO().slice(0, 10);
  const porLoja = {}; for (const r of p) porLoja[r.loja] = (porLoja[r.loja] || 0) + 1;
  return { pendentes: p.length, rebaixas: S.itens.filter(r => r.rebaixaStatus === 'pendente').length, hoje: S.itens.filter(r => r.criadoEm.slice(0, 10) === hoje).length, porLoja, lojas: LOJA_TXT };
}
const pendencias = () => ({ n: S.itens.filter(pendente).length });

/** Retaguarda decide a rebaixa (28/10, Tiago: "quem vai decidir vai ser a gente na retaguarda na tela de ajuste"): 'aceita' com o preço
 *  novo (obrigatório), 'recusada' com o motivo, ou 'pendente' pra reabrir. Independente da decisão do estoque (tratar). */
function tratarRebaixa(user, id, b) {
  b = b || {}; const r = S.itens.find(x => x.id === id); if (!r) throw erro('Pedido não encontrado', 404);
  if (!r.rebaixa) throw erro('Esse pedido não tem solicitação de rebaixa');
  const status = String(b.status || ''); if (!['aceita', 'recusada', 'pendente'].includes(status)) throw erro('Situação inválida');
  const preco = num(b.preco);
  if (status === 'aceita' && !(preco > 0)) throw erro('Informe o preço novo da rebaixa');
  if (status === 'recusada' && !String(b.obs || '').trim()) throw erro('Diga o motivo da recusa da rebaixa');
  const q = quem(user);
  r.rebaixaStatus = status; r.rebaixaPreco = status === 'aceita' ? Math.round(preco * 100) / 100 : null;
  r.rebaixaEm = status === 'pendente' ? null : agoraISO(); r.rebaixaPor = status === 'pendente' ? null : q.nome; r.rebaixaObs = String(b.obs || '').trim().slice(0, 300);
  salvar();
  return visao(r);
}

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

module.exports = { init, criar, daLoja, listar, resumo, pendencias, tratar, tratarRebaixa, STATUS, REBAIXA, LOJA_TXT, _estado: () => S };
