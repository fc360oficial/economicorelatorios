/* auto-ajuste.js — a tabela cabe em QUALQUER monitor (Tiago, 13/11/26: "tem que ser em qualquer monitor esse ajuste automático").
   As faixas @media (1699/1399/1199) apertam por LARGURA DE JANELA e só foram conferidas em 1920/1600/1366/1280: num monitor de
   1440 px a tela caía na faixa "de 1600" e a última coluna ficava cortada. Aqui o ajuste é pela MEDIDA REAL: se a tabela ficou
   mais larga que a caixa dela, encolhe a tabela inteira (zoom) exatamente o que falta. Não muda a estrutura nem tira coluna, e
   continua valendo quando entra coluna nova, quando o navegador está com zoom ou quando o Windows está em 125 %.
   Uso: <script src="/auto-ajuste.js" defer></script>. Vale pra toda .table-wrap da página (a tabela é o primeiro filho).
   Piso de 70 %: abaixo disso a letra fica ilegível e a caixa volta a rolar de lado (último recurso). */
(function () {
  var SEL = '.table-wrap', PISO = 0.7;
  var largura = new WeakMap();   // última largura de cada caixa: só refaz a medida cheia quando ela muda
  function ajustarUma(w, refazer) {
    var t = w.firstElementChild;
    if (!t || t.tagName !== 'TABLE') return;
    if (refazer && t.style.zoom) t.style.zoom = '';          // caixa mudou de largura: mede de novo do tamanho cheio
    var z = parseFloat(t.style.zoom) || 1;
    for (var i = 0; i < 6; i++) {
      var cabe = w.clientWidth, usa = w.scrollWidth;
      if (!cabe || usa <= cabe) break;
      z = Math.max(PISO, Math.floor(z * (cabe / usa) * 1000 - 1) / 1000);
      t.style.zoom = z;
      if (z <= PISO) break;
    }
  }
  // o tamanho da tabela mudou (selo que apareceu depois, fonte que carregou, detalhe aberto): confere se ainda cabe.
  // a caixa mudou de LARGURA (janela, zoom do navegador, menu lateral): mede tudo de novo, pode até voltar a crescer.
  var ro = window.ResizeObserver ? new ResizeObserver(function (es) {
    for (var i = 0; i < es.length; i++) {
      var el = es[i].target;
      if (el.tagName === 'TABLE') { if (el.parentElement && el.parentElement.matches(SEL)) ajustarUma(el.parentElement, false); continue; }
      var l = el.clientWidth, antes = largura.get(el);
      largura.set(el, l);
      if (antes !== undefined && antes !== l) ajustarUma(el, true);
    }
  }) : null;
  function ajustar(refazer) {
    var ws = document.querySelectorAll(SEL);
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i], t = w.firstElementChild;
      ajustarUma(w, refazer);
      if (ro) { if (!largura.has(w)) { largura.set(w, w.clientWidth); ro.observe(w); } if (t && t.tagName === 'TABLE') ro.observe(t); }
    }
  }
  window.autoAjuste = ajustar;
  function ligar() {
    ajustar(true);
    // tabela redesenhada (innerHTML novo) nasce sem zoom: mede e ajusta antes de pintar, sem piscar
    new MutationObserver(function () { ajustar(false); }).observe(document.body, { childList: true, subtree: true });
    if (!ro) window.addEventListener('resize', function () { ajustar(true); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { ajustar(true); });
    window.addEventListener('load', function () { ajustar(true); });
  }
  if (document.body) ligar(); else document.addEventListener('DOMContentLoaded', ligar);
})();
