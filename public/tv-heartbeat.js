// tv-heartbeat.js — batimento das telas de TV pra Processos › Painéis e TVs (27/10/2026).
// Uso: <script src="/tv-heartbeat.js" data-painel="televendas|compras|rh|acougue" [data-so="/tv-rh/"] defer></script>
// A cada 30 s manda POST /api/paineis-publico/batimento com um id fixo do aparelho (localStorage), o slide atual
// (a página define window.tvSlideAtual = () => 'texto'), a resolução e a data da página. Sem login: a TV não tem sessão.
// Nada aqui pode derrubar a TV: tudo em try/catch e sem await no fluxo da página.
(function () {
  var sc = document.currentScript; if (!sc) return;
  var PAINEL = sc.getAttribute('data-painel'); var SO = sc.getAttribute('data-so');
  if (!PAINEL) return;
  if (SO && location.pathname.indexOf(SO) !== 0) return;   // ex.: tv-rh.html aberto como /painel-rh.html (logado, no PC) não é TV
  var CHAVE = 'fc360.telaId';
  function novoId() { var a = new Uint8Array(8); (window.crypto || window.msCrypto).getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  var ID = null;
  try { ID = localStorage.getItem(CHAVE); if (!/^[a-f0-9]{8,32}$/.test(ID || '')) { ID = novoId(); localStorage.setItem(CHAVE, ID); } } catch (e) { ID = ID || novoId(); }
  var ABRIU = Date.now();
  function slide() { try { return typeof window.tvSlideAtual === 'function' ? String(window.tvSlideAtual() || '').slice(0, 120) : ''; } catch (e) { return ''; } }
  function enviar() {
    try {
      var corpo = JSON.stringify({ id: ID, painel: PAINEL, slide: slide(), tela: screen.width + 'x' + screen.height, versao: document.lastModified, url: location.pathname.slice(0, 120), ua: navigator.userAgent.slice(0, 160), ligadaHa: Math.round((Date.now() - ABRIU) / 1000) });
      fetch('/api/paineis-publico/batimento', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo, cache: 'no-store', keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  enviar();
  setInterval(enviar, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) enviar(); });
  window.tvBatimento = { id: ID, enviar: enviar };
})();
