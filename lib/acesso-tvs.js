// Telas de TV e os dados delas (18/11/2026 — levantamento de segurança pedido pelo Tiago).
//
// Estas páginas e APIs nasceram "públicas" pra TV abrir sem login. O efeito colateral: pelo link externo qualquer pessoa
// lia margem, estoque, pedidos e indicadores da diretoria sem senha. A regra nova: sem login só abre quem está NA REDE
// INTERNA, ligado direto no servidor (http://192.168.2.254:3003/...) — é assim que as TVs já acessam. Pelo link externo,
// só logado. Quem decide "rede interna" é seguranca-acesso.origemChamada.
//
// Vai ao ar em dois passos (Tiago: nunca fechar sem mostrar quem usa):
//   modo "observar" — nada muda; só anota em data/acessos-tvs-observados.json quem abriu sem login e de onde;
//   modo "fechar"   — de fora e sem login cai na tela de login (API responde 401) e a tentativa fica anotada.
// O modo fica em data/acesso-tvs.json ({"modo":"fechar"}); sem o arquivo vale o padrão passado em criarModo.
'use strict';
const fs = require('fs');

const CAMINHOS = new Set([
  '/relatorio-cronograma.html',
  '/precificacao.html', '/compras.html', '/comprador.html', '/supervisao.html',
  '/api/precificacao/margens-criticas', '/api/compras/pedidos-hoje',
  '/diretoria.html', '/api/diretoria/kpis',
  '/api/top-vendidos', '/api/top-mercadologico',
  '/api/compras/analise-estoque',
  '/analise-comprador.html',
  '/api/compras/fornec-por-lista',
  '/api/compras/pedidos-mes',
  '/mensal.html',
  '/comparativo-tv.html', '/api/comparativo-tv',
  '/prevencao.html', '/api/pendencias/prevencao', '/api/pendencias/prevencao-consolidado', '/api/pendencias/prevencao-bonif',
  '/api/ruptura/debug-comprador',
  '/ruptura-painel.html', '/api/ruptura', '/api/ruptura/comprador-listas',
  '/margem-comprador.html', '/api/margem-tv/comprador',
  '/painel-diretoria.html',
  '/painel-cd.html', '/api/painel-cd',
  '/painel-compras.html', '/tv', '/painel-fiscal.html', '/painel-precificacao.html', '/painel-robo.html', '/painel-robo-3d.html',
]);
const PREFIXO_PAINEIS = '/api/paineis-publico/';
// O batimento (sinal de vida) continua aberto: as TVs de token das lojas mandam de fora, e ele não entrega dado nenhum.
const BATIMENTO = '/api/paineis-publico/batimento';

/** true = tela de TV ou dado de TV: sem login, só da rede interna. */
function caminhoDeTv(caminho) {
  const p = String(caminho || '');
  if (CAMINHOS.has(p)) return true;
  let m = p.toLowerCase();
  while (m.length > 1 && m.endsWith('/')) m = m.slice(0, -1);
  return m.startsWith(PREFIXO_PAINEIS) && m !== BATIMENTO;
}

/** Devolve uma função que lê o modo do arquivo (relê no máximo a cada 15 s — trocar o modo não pede reinício). */
function criarModo(arquivo, padrao, opc) {
  opc = opc || {};
  const validadeMs = opc.validadeMs == null ? 15000 : opc.validadeMs;
  const agora = opc.agora || Date.now;
  const base = padrao === 'fechar' ? 'fechar' : 'observar';
  let lidoEm = -Infinity, valor = base;
  return function modo() {
    const t = agora();
    if (t - lidoEm < validadeMs) return valor;
    lidoEm = t;
    try {
      const m = JSON.parse(fs.readFileSync(arquivo, 'utf8')).modo;
      valor = m === 'fechar' || m === 'observar' ? m : base;
    } catch (e) { valor = base; }
    return valor;
  };
}

/**
 * Anotação de quem abriu tela/dado de TV sem login: uma linha por origem + IP + endereço, com contagem.
 * Fica em memória e vai pro arquivo quando gravar() é chamado (o servidor chama a cada minuto e ao sair).
 */
function criarRegistro(opc) {
  opc = opc || {};
  const arquivo = opc.arquivo || null;
  const maxLinhas = opc.maxLinhas || 3000;
  const agora = opc.agora || (() => new Date().toISOString());
  const linhas = new Map();
  let mudou = false;
  if (arquivo) {
    try { for (const l of JSON.parse(fs.readFileSync(arquivo, 'utf8')).linhas || []) if (l && l.origem && l.caminho) linhas.set(l.origem + '|' + l.ip + '|' + l.caminho, l); } catch (e) { /* primeira vez */ }
  }

  function registrar(r) {
    const origem = String(r.origem || '?'), ip = String(r.ip || '?').slice(0, 45), caminho = String(r.caminho || '').slice(0, 120);
    const k = origem + '|' + ip + '|' + caminho;
    const t = agora();
    let l = linhas.get(k);
    if (!l) {
      if (linhas.size >= maxLinhas) {   // cheio: sai a linha parada há mais tempo
        let velha = null;
        for (const [kk, v] of linhas) if (!velha || v.ultimo < velha[1].ultimo) velha = [kk, v];
        if (velha) linhas.delete(velha[0]);
      }
      l = { origem, ip, caminho, vezes: 0, barradas: 0, primeiro: t, ultimo: t, dispositivo: null };
      linhas.set(k, l);
    }
    l.vezes++;
    if (r.barrado) l.barradas++;
    l.ultimo = t;
    if (r.dispositivo) l.dispositivo = String(r.dispositivo).slice(0, 60);
    mudou = true;
  }
  const listar = () => [...linhas.values()].sort((a, b) => (a.origem + a.ip + a.caminho < b.origem + b.ip + b.caminho ? -1 : 1));
  function gravar() {
    if (!arquivo || !mudou) return false;
    try { fs.writeFileSync(arquivo, JSON.stringify({ atualizado: agora(), linhas: listar() }, null, 1)); mudou = false; return true; } catch (e) { return false; }
  }
  return { registrar, listar, gravar };
}

module.exports = { caminhoDeTv, criarModo, criarRegistro, CAMINHOS };
