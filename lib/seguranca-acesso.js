// Travas de acesso do servidor (18/11/2026 — levantamento de segurança pedido pelo Tiago).
//
// 1) extensaoEstaticaLivre: js/css/imagem/fonte entram sem login (a tela de login precisa deles), mas NUNCA
//    um endereço de /api/. Antes a liberação olhava só o fim do endereço, então /api/qualquer/coisa/1.js
//    passava sem login em toda rota com parâmetro no fim.
// 2) chamadaLocalDireta: o Caddy (link externo, 443) entrega tudo pro Node vindo de 127.0.0.1, então "veio de
//    localhost" sozinho não prova nada. Chamada de dentro do próprio servidor = localhost E sem cabeçalho de proxy
//    (o Caddy sempre põe X-Forwarded-For, e quem está de fora não consegue tirar).
// 3) autorizaInterno: /deploy, reenviar negativos e congelar-manual. O token antigo (que está no código) só vale
//    em chamada local direta; de fora só com a chave comprida de data/deploy-chave.txt no cabeçalho X-Deploy-Chave.
// 4) criarLimiteLogin: senha errada demais bloqueia por um tempo — por conta+IP, por conta e por IP.
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const EXT_ESTATICAS = new Set(['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'eot', 'map']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CABECALHOS_PROXY = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via'];

/** true = arquivo estático que pode sair sem login. Qualquer coisa de /api (em qualquer caixa, com barra repetida) = false. */
function extensaoEstaticaLivre(caminho) {
  const partes = String(caminho || '').toLowerCase().split('/').filter(Boolean);
  if (!partes.length || partes[0] === 'api') return false;
  const ultimo = partes[partes.length - 1];
  const ponto = ultimo.lastIndexOf('.');
  if (ponto < 0) return false;
  return EXT_ESTATICAS.has(ultimo.slice(ponto + 1));
}

/** true só quando a chamada nasceu no próprio servidor e NÃO passou pelo Caddy nem por outro proxy. */
function chamadaLocalDireta(req) {
  const origem = String((req && req.socket && req.socket.remoteAddress) || '');
  if (!LOOPBACK.has(origem)) return false;
  const h = (req && req.headers) || {};
  return !CABECALHOS_PROXY.some(c => h[c] !== undefined);
}

/**
 * IP de quem chamou, sem deixar o cliente inventar: o X-Forwarded-For só vale quando a conexão veio de localhost
 * (ou seja, do Caddy), e vale o ÚLTIMO endereço da lista — o que o Caddy escreveu, não o que o cliente mandou.
 */
function ipCliente(req) {
  const origem = String((req && req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '');
  if (origem === '127.0.0.1' || origem === '::1') {
    const lista = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map(s => s.trim()).filter(Boolean);
    if (lista.length) return lista[lista.length - 1].replace('::ffff:', '');
  }
  return origem || 'desconhecido';
}

/** Endereço de rede particular (10.x, 172.16–31.x, 192.168.x, fe80:/fc/fd no IPv6): não chega pela internet. */
function redePrivada(ip) {
  const e = String(ip || '').toLowerCase();
  if (e.includes(':')) return e.startsWith('fe8') || e.startsWith('fe9') || e.startsWith('fea') || e.startsWith('feb') || e.startsWith('fc') || e.startsWith('fd');
  const p = e.split('.');
  if (p.length !== 4 || p.some(x => x === '' || !Number.isInteger(Number(x)) || Number(x) < 0 || Number(x) > 255)) return false;
  const a = Number(p[0]), b = Number(p[1]);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * De onde veio a chamada — pra decidir o que abre sem login (telas de TV, lib/acesso-tvs.js).
 *   local    = do próprio servidor, sem proxy                      → confiável
 *   interna  = aparelho da rede ligado direto na porta do Node     → confiável
 *   link     = pelo Caddy (link externo, mesmo acessado de dentro) → NÃO
 *   roteador = o endereço do roteador (acesso de dentro pelo IP público, ou de fora mascarado) → NÃO
 *   proxy    = rede interna mas com cabeçalho de proxy             → NÃO
 *   fora     = IP público ligado direto na porta                   → NÃO
 */
function origemChamada(req, roteadores) {
  const bruto = String((req && req.socket && req.socket.remoteAddress) || '');
  const ip = bruto.replace('::ffff:', '');
  const h = (req && req.headers) || {};
  const viaProxy = CABECALHOS_PROXY.some(c => h[c] !== undefined);
  if (LOOPBACK.has(bruto)) return viaProxy ? { tipo: 'link', confiavel: false, ip: ipCliente(req) } : { tipo: 'local', confiavel: true, ip };
  if ((roteadores || []).includes(ip)) return { tipo: 'roteador', confiavel: false, ip };
  if (redePrivada(ip)) return viaProxy ? { tipo: 'proxy', confiavel: false, ip } : { tipo: 'interna', confiavel: true, ip };
  return { tipo: 'fora', confiavel: false, ip: ip || 'desconhecido' };
}

/** Comparação que não vaza pelo tempo de resposta. Chave esperada curta (< 32) nunca vale. */
function chaveConfere(recebida, esperada) {
  if (typeof recebida !== 'string' || typeof esperada !== 'string' || esperada.length < 32 || !recebida) return false;
  const a = crypto.createHash('sha256').update(recebida).digest();
  const b = crypto.createHash('sha256').update(esperada).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Rotas de manutenção: token antigo só em chamada local direta; de fora, só a chave do arquivo no cabeçalho. */
function autorizaInterno(req, tokenLocal, chaveExterna) {
  if (chamadaLocalDireta(req) && req.query && req.query.token === tokenLocal) return true;
  return chaveConfere(req && req.headers && req.headers['x-deploy-chave'], chaveExterna);
}

/** Lê a chave de deploy; se não existir, cria (64 hex). Erro de disco = null (deploy de fora fica desligado). */
function carregarChaveDeploy(arquivo) {
  try {
    const atual = fs.readFileSync(arquivo, 'utf8').trim();
    if (atual.length >= 32) return atual;
  } catch (e) { /* ainda não existe */ }
  try {
    const nova = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(arquivo, nova + '\n', { flag: 'w' });
    return nova;
  } catch (e) { return null; }
}

/**
 * Segredos que assinam o cookie da sessão (19/11/2026). O primeiro assina os cookies novos; os demais só validam os antigos.
 * O segredo de verdade mora num arquivo fora do git (criado sozinho). O antigo, que ficava escrito no código, continua
 * valendo só até `antigoValeAte` — assim ninguém é deslogado na troca; a sessão dura 8 h, então depois dessa data ele some.
 * Erro de disco = segredo só em memória (reiniciar desloga todo mundo) com aviso no log.
 */
function segredosSessao({ arquivo, antigo, antigoValeAte, agora } = {}) {
  let novo = carregarChaveDeploy(arquivo);
  if (!novo) {
    novo = crypto.randomBytes(32).toString('hex');
    console.warn('[seguranca] não deu pra gravar ' + arquivo + ' — segredo da sessão só em memória');
  }
  const lista = [novo];
  const limite = Date.parse(antigoValeAte);
  const t = agora == null ? Date.now() : agora;
  if (antigo && antigo !== novo && Number.isFinite(limite) && t < limite) lista.push(antigo);
  return lista;
}

/**
 * Limite de tentativas de login, em memória (reiniciar o servidor zera).
 * Três contadores na mesma janela: conta+IP (quem erra a própria senha), conta (ataque vindo de vários IPs)
 * e IP (um IP testando várias contas). Estourou = bloqueio; durante o bloqueio a senha nem é conferida.
 */
function criarLimiteLogin(opc) {
  opc = opc || {};
  const janelaMs = opc.janelaMs || 15 * 60 * 1000;
  const bloqueioMs = opc.bloqueioMs || 15 * 60 * 1000;
  const maximos = { par: opc.maxPorContaIp || 8, conta: opc.maxPorConta || 25, ip: opc.maxPorIp || 40 };
  const maxRegistros = opc.maxRegistros || 20000;
  const reg = new Map();   // chave → { falhas: [instantes], ate: fim do bloqueio }

  const normal = usuario => String(usuario == null ? '' : usuario).toLowerCase().trim().slice(0, 60);
  const chaves = (usuario, ip) => {
    const u = normal(usuario), i = String(ip || 'desconhecido');
    return [['par', 'p|' + u + '|' + i], ['conta', 'c|' + u], ['ip', 'i|' + i]];
  };
  const faxina = agora => {
    if (reg.size < maxRegistros) return;
    for (const [k, v] of reg) {
      const ultima = v.falhas.length ? v.falhas[v.falhas.length - 1] : 0;
      if (v.ate <= agora && agora - ultima > janelaMs) reg.delete(k);
    }
    if (reg.size >= maxRegistros) for (const [k, v] of reg) if (v.ate <= agora) reg.delete(k);   // enxurrada: sobra só quem está bloqueado
  };

  /** Milissegundos que faltam de bloqueio (0 = pode tentar). */
  function bloqueado(usuario, ip, agora) {
    agora = agora || Date.now();
    let falta = 0;
    for (const [, k] of chaves(usuario, ip)) {
      const v = reg.get(k);
      if (v && v.ate > agora) falta = Math.max(falta, v.ate - agora);
    }
    return falta;
  }

  /** Registra uma senha errada. Devolve true quando ESTA falha disparou um bloqueio. */
  function falha(usuario, ip, agora) {
    agora = agora || Date.now();
    faxina(agora);
    let bloqueou = false;
    for (const [tipo, k] of chaves(usuario, ip)) {
      let v = reg.get(k);
      if (!v) { v = { falhas: [], ate: 0 }; reg.set(k, v); }
      v.falhas = v.falhas.filter(t => agora - t < janelaMs);
      v.falhas.push(agora);
      if (v.falhas.length >= maximos[tipo]) { v.ate = agora + bloqueioMs; v.falhas = []; bloqueou = true; }
    }
    return bloqueou;
  }

  /** Login certo: zera só o contador conta+IP (os outros dois continuam valendo contra ataque em andamento). */
  function sucesso(usuario, ip) {
    reg.delete(chaves(usuario, ip)[0][1]);
  }

  return { bloqueado, falha, sucesso, _tamanho: () => reg.size };
}

module.exports = { redePrivada, origemChamada, extensaoEstaticaLivre, chamadaLocalDireta, ipCliente, chaveConfere, autorizaInterno, carregarChaveDeploy, segredosSessao, criarLimiteLogin };
