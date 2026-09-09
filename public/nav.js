/* ═══════════════════════════════════════════════════════════════
   NAVEGAÇÃO ÚNICA — Econômico Relatórios · Executive Ink
   Injeta a MESMA sidebar em todas as páginas do sistema.
   Uso: <script src="/nav.js" defer></script>
   Rail recolhido (64px, só ícone) o tempo todo. Em mouse (hover:hover)
   expande sozinho ao passar por cima; em touch, só expande com clique
   — evita abrir "por acidente" ao tocar num item. Nunca empurra o
   conteúdo, só flutua por cima. Grupos (Financeiro, Gestão de
   Compras...) abrem um segundo flyout ao lado, como o Club da Cotação
   — o flyout é posicionado por JS (não fica dentro de .dn-rows, que
   tem scroll vertical e cortaria ele, já que overflow-y:auto força
   overflow-x:auto também).
   No mobile (≤820px) vira barra superior fixa, sem rail/flyout.
   Ícones da sidebar são próprios (não usam /icons.svg do design
   system) — o resto do Design System não muda se um dia trocar o
   traço de um ícone só aqui.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // PWA — permite "Instalar app" no celular/desktop
  if (!document.querySelector('link[rel="manifest"]')) {
    var linkManifest = document.createElement('link');
    linkManifest.rel = 'manifest';
    linkManifest.href = '/manifest.json';
    document.head.appendChild(linkManifest);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  // Avisa o usuário quando detecta que o sistema foi atualizado desde a última visita
  fetch('/api/versao').then(function (r) { return r.json(); }).then(function (d) {
    var anterior = localStorage.getItem('app_versao');
    if (anterior && anterior !== d.versao) {
      var toast = document.createElement('div');
      toast.textContent = '✓ Sistema atualizado — novidades disponíveis';
      toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);' +
        'background:#0E1626;color:#F5B800;font:700 13px Inter,sans-serif;padding:12px 20px;' +
        'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.3);z-index:99999;' +
        'border:1px solid #F5B800;opacity:0;transition:opacity .3s';
      document.body.appendChild(toast);
      requestAnimationFrame(function () { toast.style.opacity = '1'; });
      setTimeout(function () {
        toast.style.opacity = '0';
        setTimeout(function () { toast.remove(); }, 300);
      }, 4500);
    }
    localStorage.setItem('app_versao', d.versao);
  }).catch(function () {});

  var ITENS = [
    { sec: 'Análise' },
    { href: '/index.html',        ic: 'dashboard', txt: 'Dashboard' },
    { href: '/comparativos.html', ic: 'chart',     txt: 'Comparativos' },
    { href: '/consulta.html',     ic: 'search',    txt: 'Consulta de Vendas' },
    { href: '/itens.html',        ic: 'list',      txt: 'Mercadológico' },
    { sec: 'Operação' }, // itens abaixo em ordem alfabética por txt — manter ao adicionar novos
    { id: 'cahu-distribuidora', ic: 'store', txt: 'CAHU Distribuidora', sub: [
        { href: '/cahu-tabela-precos.html', ic: 'download', txt: 'Tabela de Preços' }
      ]},
    { id: 'financeiro', ic: 'bank', txt: 'Financeiro', sub: [
        { href: '/conciliador.html', ic: 'bank', txt: 'Conciliação de Saídas' },
        { href: '/conciliador-entradas.html', ic: 'bank', txt: 'Conciliação de Entradas' },
        { href: '/conciliador-cd.html', ic: 'bank', txt: 'CD' }
      ]},
    { id: 'compras', ic: 'bag', txt: 'Gestão de Compras', sub: [
        { href: '/centro-distribuicao.html', ic: 'cart',  txt: 'Centro Distribuição' },
        { href: '/ruptura.html',             ic: 'trend', txt: 'Gestão de Rupturas' },
        { href: '/fornecedores.html',        ic: 'bag',   txt: 'Lista de Compra' },
        { href: '/ponta-gondola.html',       ic: 'store', txt: 'Ponta de Gôndola' }
      ]},
    { id: 'prevencao', ic: 'shield', txt: 'Prevenção', sub: [
        { href: '/prevencao.html', ic: 'shield', txt: 'Fechamento de Mês' }
      ]},
    { id: 'processos', ic: 'folder', txt: 'Processos', sub: [
        { href: '/pendencias.html', ic: 'alert', txt: 'Pendências' },
        { href: '/negativos.html', ic: 'alert', txt: 'Negativos' }
      ]}
  ];

  // ícones próprios da sidebar (sprite injetado uma vez, ids prefixados "nvic-")
  var ICONS_SVG = '<svg style="display:none">'
    + '<symbol id="nvic-dashboard" viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></symbol>'
    + '<symbol id="nvic-chart" viewBox="0 0 24 24"><polyline points="3,17 9,11 13,15 21,5"/></symbol>'
    + '<symbol id="nvic-search" viewBox="0 0 24 24"><circle cx="10" cy="10" r="6.2"/><line x1="21" y1="21" x2="14.4" y2="14.4"/></symbol>'
    + '<symbol id="nvic-list" viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></symbol>'
    + '<symbol id="nvic-store" viewBox="0 0 24 24"><path d="M4 10 L4 20 L20 20 L20 10"/><path d="M2 10 L12 3 L22 10"/></symbol>'
    + '<symbol id="nvic-bank" viewBox="0 0 24 24"><path d="M3 10 L12 4 L21 10"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="5.5" y1="10" x2="5.5" y2="18"/><line x1="12" y1="10" x2="12" y2="18"/><line x1="18.5" y1="10" x2="18.5" y2="18"/><line x1="3" y1="20" x2="21" y2="20"/></symbol>'
    + '<symbol id="nvic-bag" viewBox="0 0 24 24"><path d="M6 8 H18 L17 20 H7 Z"/><path d="M9 8 a3 3 0 0 1 6 0"/></symbol>'
    + '<symbol id="nvic-shield" viewBox="0 0 24 24"><path d="M12 3 L20 6 V12 C20 17 16.5 20 12 21 C7.5 20 4 17 4 12 V6 Z"/></symbol>'
    + '<symbol id="nvic-folder" viewBox="0 0 24 24"><path d="M3 6 H9 L11 9 H21 V19 H3 Z"/></symbol>'
    + '<symbol id="nvic-download" viewBox="0 0 24 24"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></symbol>'
    + '<symbol id="nvic-cart" viewBox="0 0 24 24"><circle cx="9" cy="20" r="1.6"/><circle cx="17" cy="20" r="1.6"/><path d="M3 4h2l2.5 11.5a1.6 1.6 0 0 0 1.6 1.3h7.6a1.6 1.6 0 0 0 1.6-1.2L20.5 8H6"/></symbol>'
    + '<symbol id="nvic-trend" viewBox="0 0 24 24"><path d="M3 17 9 11l4 4 8-8M21 7v6h-6"/></symbol>'
    + '<symbol id="nvic-alert" viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></symbol>'
    + '<symbol id="nvic-chevron-right" viewBox="0 0 24 24"><polyline points="9,6 15,12 9,18"/></symbol>'
    + '<symbol id="nvic-logout" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></symbol>'
    + '</svg>';

  var css = ''
  + '#dsnav{position:fixed;top:0;left:0;bottom:0;width:64px;z-index:900;'
  +   'background:var(--crd,#FFFFFF);border-right:1px solid var(--ln,#DADAD6);'
  +   'display:flex;flex-direction:column;padding:14px 12px 12px;overflow:hidden;'
  +   "font-family:'InterVar','Segoe UI',system-ui,sans-serif}"
  + '#dsnav .dn-top{display:flex;align-items:center;padding:4px 0 14px;'
  +   'border-bottom:1px solid var(--ln,#DADAD6);margin-bottom:10px;flex-shrink:0}'
  /* só a lista de itens rola por dentro — topo (logo) e rodapé (usuário/sair)
     ficam sempre visíveis, mesmo em telas baixas (TV) ou sem scroll por
     toque/mouse disponível, sem depender de rolar até o fim pra deslogar.
     Os flyouts (.dn-sub) NÃO ficam dentro daqui — ver comentário no topo. */
  + '#dsnav .dn-rows{flex:1;min-height:0;overflow-y:auto}'
  + '#dsnav .dn-brand{display:flex;align-items:center;text-decoration:none;min-width:0}'
  + '#dsnav .dn-exit-mobile{display:none}'
  + '#dsnav .dn-brand img{height:38px;display:block;transition:height .15s ease;flex-shrink:0}'
  + '#dsnav .dn-sec{font-size:9.5px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;'
  +   'color:var(--ink3,#98A0B3);padding:12px 10px 6px;white-space:nowrap}'
  + '#dsnav a.dn-item{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:9px;'
  +   'font-size:12.5px;font-weight:600;color:var(--ink2,#4E5A72);text-decoration:none;'
  +   'transition:background .12s ease;margin-bottom:2px;white-space:nowrap}'
  + '#dsnav a.dn-item svg{width:16px;height:16px;stroke:currentColor;stroke-width:1.8;fill:none;'
  +   'stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;color:var(--ink3,#98A0B3)}'
  + '#dsnav a.dn-item:hover{background:var(--wsh,#E4E4E1);color:var(--ink,#0E1626)}'
  + '#dsnav a.dn-item.on{background:var(--amw,#FFF6D9);color:var(--amk,#6B4E00)}'
  + '#dsnav a.dn-item.on svg{color:var(--amk,#6B4E00)}'
  + '#dsnav .dn-group-hd{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:9px;'
  +   'font-size:12.5px;font-weight:600;color:var(--ink2,#4E5A72);cursor:default;user-select:none;'
  +   'transition:background .12s ease;white-space:nowrap;margin-bottom:2px}'
  + '#dsnav .dn-group-hd svg{width:16px;height:16px;stroke:currentColor;stroke-width:1.8;fill:none;'
  +   'stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;color:var(--ink3,#98A0B3)}'
  + '#dsnav .dn-group-hd .dn-chev{width:12px;height:12px;margin-left:auto;flex-shrink:0}'
  + '#dsnav .dn-group-hd:hover{background:var(--wsh,#E4E4E1);color:var(--ink,#0E1626)}'
  + '#dsnav .dn-group-hd:hover svg{color:var(--ink,#0E1626)}'
  + '#dsnav .dn-group-hd.on{background:var(--amw,#FFF6D9);color:var(--amk,#6B4E00)}'
  + '#dsnav .dn-group-hd.on svg{color:var(--amk,#6B4E00)}'
  /* flyout de 2º nível — filho direto de #dsnav (não de .dn-rows), posição
     "top" calculada via JS quando abre, pra nunca ser cortado pelo scroll */
  + '#dsnav .dn-sub{display:none;flex-direction:column;padding:6px;min-width:210px;'
  +   'position:absolute;left:100%;margin-left:6px;background:var(--crd,#FFFFFF);'
  +   'border:1px solid var(--ln,#DADAD6);border-radius:10px;box-shadow:0 12px 28px -10px rgba(14,22,38,.35);z-index:950}'
  + '#dsnav .dn-sub.show{display:flex}'
  + '#dsnav .dn-sub a{padding:8px 10px;font-size:12.5px;border-radius:7px}'
  + '#dsnav .dn-sub a.on{background:var(--amw,#FFF6D9);color:var(--amk,#6B4E00)}'
  + '#dsnav .dn-sub a.on svg{color:var(--amk,#6B4E00)}'
  + '#dsnav .dn-foot{margin-top:auto;flex-shrink:0;border-top:1px solid var(--ln,#DADAD6);padding-top:10px;'
  +   'display:flex;align-items:center;gap:9px}'
  + '#dsnav .dn-ava{width:30px;height:30px;border-radius:50%;background:var(--ink,#0E1626);color:#fff;'
  +   'display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}'
  + '#dsnav .dn-user{flex:1;min-width:0;white-space:nowrap}'
  + '#dsnav .dn-user b{display:block;font-size:12px;color:var(--ink,#0E1626);'
  +   'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '#dsnav .dn-user a{font-size:10.5px;color:var(--neg,#C22F49);font-weight:700;text-decoration:none}'
  + 'body.dsnav-pad{margin-left:64px}'
  /* mobile: barra superior fixa com scroll horizontal — sem rail/flyout */
  + '@media(max-width:820px){'
  +   'body.dsnav-pad{margin-left:0;padding-top:96px}'
  +   '#dsnav{width:100%;height:auto;bottom:auto;flex-direction:column;padding:6px 8px;'
  +     'border-right:none;border-bottom:1px solid var(--ln,#DADAD6)}'
  +   '#dsnav .dn-top{border-bottom:none;padding:2px 6px 4px;margin-bottom:0}'
  +   '#dsnav .dn-brand img{height:44px}'
  +   '#dsnav .lbl,#dsnav .dn-chev{opacity:1!important}'
  +   '#dsnav .dn-sec{display:none}'
  +   '#dsnav .dn-rows{display:flex;overflow-x:auto;gap:2px;-webkit-overflow-scrolling:touch;scrollbar-width:none}'+'#dsnav .dn-rows::-webkit-scrollbar{display:none}'
  +   '#dsnav a.dn-item{padding:7px 10px;font-size:11px;flex-shrink:0}'
  +   '#dsnav .dn-group-hd{display:none}'
  +   '#dsnav .dn-sub{position:static;display:contents!important;box-shadow:none;border:none;padding:0;margin:0}'
  +   '#dsnav .dn-foot{display:none}'
  +   '#dsnav .dn-exit-mobile{display:flex;align-items:center;gap:5px;flex-shrink:0;'
  +     'color:var(--neg,#C22F49);font-size:11px;font-weight:700;text-decoration:none;'
  +     'padding:6px 10px;border-radius:8px;background:var(--negw,#FBEAED)}'
  +   '#dsnav .dn-exit-mobile svg{width:14px;height:14px;stroke:currentColor;stroke-width:1.8;fill:none}'
  + '}'
  /* ── rail com flyout, desktop (≥821px) ──
     .pinned (clique) funciona em qualquer dispositivo; :hover só entra
     como atalho extra em quem tem mouse de verdade — assim não "abre
     sozinho" ao tocar num item em tablet. Rótulo/chevron usam opacity
     (não display), igual ao protótipo aprovado — sem re-centralizar
     nada, o ícone fica sempre na mesma posição (com padding fixo). */
  + '@media(min-width:821px){'
  +   '#dsnav{transition:width .18s ease}'
  +   '#dsnav .lbl,#dsnav .dn-chev{opacity:0;transition:opacity .1s ease}'
  +   '#dsnav.pinned{width:236px;overflow:visible;box-shadow:14px 0 34px -10px rgba(10,15,26,.45)}'
  +   '#dsnav.pinned .dn-brand img{height:66px}'
  +   '#dsnav.pinned .lbl,#dsnav.pinned .dn-chev{opacity:1}'
  + '}'
  + '@media(min-width:821px) and (hover:hover){'
  +   '#dsnav:hover{width:236px;overflow:visible;box-shadow:14px 0 34px -10px rgba(10,15,26,.45)}'
  +   '#dsnav:hover .dn-brand img{height:66px}'
  +   '#dsnav:hover .lbl,#dsnav:hover .dn-chev{opacity:1}'
  + '}'
  /* ── variante NAVY (teste: ?nav=navy · voltar: ?nav=claro) ── */
  + '#dsnav.navy{background:#101B33;border-right-color:#1D2A46;border-bottom-color:#1D2A46}'
  + '#dsnav.navy .dn-top{border-bottom-color:rgba(255,255,255,.09)}'
  + '#dsnav.navy .dn-brand img{filter:brightness(0) invert(1)}'
  + '#dsnav.navy .dn-sec{color:#6E7B98}'
  + '#dsnav.navy a.dn-item{color:#AEB8CE}'
  + '#dsnav.navy a.dn-item svg{color:#8E9AB5}'
  + '#dsnav.navy a.dn-item:hover{background:rgba(255,255,255,.07);color:#FFFFFF}'
  + '#dsnav.navy a.dn-item:hover svg{color:#FFFFFF}'
  + '#dsnav.navy a.dn-item.on{background:rgba(255,201,51,.16);color:#FFC933}'
  + '#dsnav.navy a.dn-item.on svg{color:#FFC933}'
  + '#dsnav.navy .dn-group-hd{color:#AEB8CE}'
  + '#dsnav.navy .dn-group-hd svg{color:#8E9AB5}'
  + '#dsnav.navy .dn-group-hd:hover{background:rgba(255,255,255,.07);color:#FFFFFF}'
  + '#dsnav.navy .dn-group-hd:hover svg{color:#FFFFFF}'
  + '#dsnav.navy .dn-group-hd.on{background:rgba(255,201,51,.16);color:#FFC933}'
  + '#dsnav.navy .dn-group-hd.on svg{color:#FFC933}'
  + '#dsnav.navy .dn-foot{border-top-color:rgba(255,255,255,.09)}'
  + '#dsnav.navy .dn-ava{background:#FFC933;color:#5C4600}'
  + '#dsnav.navy .dn-user b{color:#FFFFFF}'
  + '#dsnav.navy .dn-user a{color:#FF8296}';

  function icon(id, cls) {
    return '<svg' + (cls ? ' class="' + cls + '"' : '') + '><use href="#nvic-' + id + '"/></svg>';
  }

  function montar() {
    if (!document.getElementById('nvic-sprite-holder')) {
      var holder = document.createElement('div');
      holder.id = 'nvic-sprite-holder';
      holder.innerHTML = ICONS_SVG;
      document.body.appendChild(holder);
    }

    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    var path = location.pathname.replace(/\/$/, '/index.html');
    if (path === '' || path === '/') path = '/index.html';

    var rowsHtml = '';
    var subsHtml = '';
    ITENS.forEach(function (it) {
      var g = it.grupo ? ' data-grupo="' + it.grupo + '"' : '';
      var esconder = it.grupo === 'admin' ? ' style="display:none"' : '';
      if (it.sec) { rowsHtml += '<div class="dn-sec"' + g + esconder + '>' + it.sec + '</div>'; return; }
      if (it.sub) {
        var ativoSub = it.sub.some(function (s) { return path === s.href; });
        rowsHtml += '<div class="dn-group" data-grupo-id="' + it.id + '">'
          + '<div class="dn-group-hd' + (ativoSub ? ' on' : '') + '">'
          +   icon(it.ic) + '<span class="lbl">' + it.txt + '</span>' + icon('chevron-right', 'dn-chev')
          + '</div></div>';
        subsHtml += '<div class="dn-sub" data-for="' + it.id + '">'
          + it.sub.map(function (s) {
              var onS = path === s.href ? ' on' : '';
              return '<a class="dn-item' + onS + '" href="' + s.href + '">' + icon(s.ic) + '<span class="lbl">' + s.txt + '</span></a>';
            }).join('')
          + '</div>';
        return;
      }
      var on = path === it.href ? ' on' : '';
      var alvo = it.blank ? ' target="_blank" rel="noopener"' : '';
      rowsHtml += '<a class="dn-item' + on + '"' + g + esconder + ' href="' + it.href + '"' + alvo + '>' + icon(it.ic) + '<span class="lbl">' + it.txt + '</span></a>';
    });

    var html = '<div class="dn-top">'
      + '<a class="dn-brand" id="dn-brand" href="/index.html">'
      + '<img src="/logo.png" alt="Econômico Relatórios">'
      + '</a>'
      + '<a class="dn-exit-mobile" href="/api/logout">' + icon('logout') + 'Sair</a>'
      + '</div>'
      + '<div class="dn-rows">' + rowsHtml + '</div>'
      + subsHtml
      + '<div class="dn-foot">'
      + '<div class="dn-ava" id="dn-ava">–</div>'
      + '<div class="dn-user"><b id="dn-nome">…</b><a href="/api/logout">Sair da conta</a></div>'
      + '</div>';

    var aside = document.createElement('aside');
    aside.id = 'dsnav';
    aside.innerHTML = html;

    /* tema do menu — NAVY é o padrão (desktop e mobile).
       ?nav=claro na URL volta ao claro para testes; ?nav=navy restaura. */
    try {
      var qp = new URLSearchParams(location.search).get('nav');
      if (qp === 'navy' || qp === 'claro') localStorage.setItem('nav_tema', qp);
      if (localStorage.getItem('nav_tema') !== 'claro') aside.classList.add('navy');
    } catch (e) {
      aside.classList.add('navy');
    }

    document.body.insertAdjacentElement('afterbegin', aside);
    document.body.classList.add('dsnav-pad');

    /* flyout do grupo: posição calculada na hora (funciona mesmo com a
       lista rolada), mouse abre/fecha sozinho; clique fixa (touch). */
    function fecharTodosFlyouts() {
      aside.querySelectorAll('.dn-sub.show').forEach(function (s) { s.classList.remove('show'); });
    }
    aside.querySelectorAll('.dn-group').forEach(function (grp) {
      var hd = grp.querySelector('.dn-group-hd');
      var sub = aside.querySelector('.dn-sub[data-for="' + grp.dataset.grupoId + '"]');
      if (!hd || !sub) return;
      function abrir() {
        var r1 = hd.getBoundingClientRect();
        var r0 = aside.getBoundingClientRect();
        sub.style.top = Math.max(0, r1.top - r0.top) + 'px';
        fecharTodosFlyouts();
        sub.classList.add('show');
      }
      hd.addEventListener('mouseenter', abrir);
      hd.addEventListener('mouseleave', function () { sub.classList.remove('show'); });
      sub.addEventListener('mouseenter', function () { sub.classList.add('show'); });
      sub.addEventListener('mouseleave', function () { sub.classList.remove('show'); });
      hd.addEventListener('click', function (e) {
        e.stopPropagation();
        var jaAberto = sub.classList.contains('show');
        fecharTodosFlyouts();
        if (!jaAberto) { abrir(); aside.classList.add('pinned'); }
      });
    });

    /* clique em qualquer ponto vazio do rail fixa ele aberto — em telas
       sem mouse de verdade (tablet), é a ÚNICA forma de abrir (não expande
       sozinho ao tocar num item). Clique em link/marca navega normal.
       Clicar fora, ou de novo no rail, fecha tudo. */
    aside.addEventListener('click', function (e) {
      if (e.target.closest('a, .dn-group-hd')) return;
      aside.classList.toggle('pinned');
      if (!aside.classList.contains('pinned')) fecharTodosFlyouts();
    });
    document.addEventListener('click', function (e) {
      if (!aside.contains(e.target)) {
        aside.classList.remove('pinned');
        fecharTodosFlyouts();
      }
    });

    fetch('/api/me').then(function (r) { return r.json(); }).then(function (u) {
      if (u && u.nome) {
        document.getElementById('dn-nome').textContent = u.nome;
        var ini = u.nome.trim().split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase();
        document.getElementById('dn-ava').textContent = ini;
      }
      /* perfil gerencial fica travado na própria Gestão Gerencial —
         esconde os itens de navegação e desativa o clique na marca
         (que levaria ao Dashboard, fora do alcance desse perfil) */
      if (u && u.perfil === 'gerencial') {
        aside.querySelectorAll('.dn-item,.dn-sec,.dn-group,.dn-sub').forEach(function (el) {
          el.style.display = 'none';
        });
        var brand = document.getElementById('dn-brand');
        brand.removeAttribute('href');
        brand.style.cursor = 'default';
      }
    }).catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', montar);
  } else {
    montar();
  }
})();
