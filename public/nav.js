/* ═══════════════════════════════════════════════════════════════
   NAVEGAÇÃO ÚNICA — Econômico Relatórios · Executive Ink
   Injeta a MESMA sidebar em todas as páginas do sistema.
   Uso: <script src="/nav.js" defer></script>
   Rail recolhido (64px, só ícone). Passar o mouse expande por cima
   do conteúdo (nunca empurra); clicar também fixa aberto. Grupos
   (Financeiro, Gestão de Compras...) abrem um acordeão embaixo do
   próprio item, empurrando a lista — igual era antes dessa mudança.
   No mobile (≤820px) vira barra superior fixa, sem rail.
   Ícones da sidebar são próprios (sprite embutido, não usam o
   /icons.svg do design system) pra bater exatamente com o protótipo.
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
        { href: '/pedidos-compra.html',      ic: 'cart',  txt: 'Pedidos de Compra' },
        { href: '/ponta-gondola.html',       ic: 'store', txt: 'Ponta de Gôndola' },
        { href: '/radar-pedidos.html',       ic: 'trend', txt: 'Radar de Pedidos' },
        { href: '/sugestao-compras.html',    ic: 'trend', txt: 'Sugestão de Compras', escolha: [
            { txt: 'Sugestão por Rupturas', desc: 'Escolhe a compradora, mostra as rupturas de cada lista e cria a sugestão a partir delas.', href: '/sugestao-compras.html?tela=rupturas' },
            { txt: 'Sugestão Manual', desc: 'Monitor de Sugestões do ERP: acompanha as sugestões existentes e abre a calculadora por lista.', href: '/sugestao-compras.html?tela=monitor' }
          ] }
      ]},
    { href: '/formacao-de-preco.html', ic: 'trend', txt: 'Precificação' },
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
  + 'html,body{overflow-x:hidden!important}'
  + '#dsnav{position:fixed;top:0;left:0;bottom:0;width:64px;z-index:900;'
  +   'background:var(--crd,#FFFFFF);border-right:1px solid var(--ln,#DADAD6);'
  +   'display:flex;flex-direction:column;padding:14px 12px 12px;overflow:hidden;'
  +   "transition:width .18s ease;font-family:'InterVar','Segoe UI',system-ui,sans-serif}"
  + '#dsnav.pinned,#dsnav:hover{width:236px;overflow:visible;'
  +   'box-shadow:14px 0 34px -10px rgba(10,15,26,.45)}'
  + '#dsnav .dn-top{display:flex;align-items:center;padding:4px 0 14px;'
  +   'border-bottom:1px solid var(--ln,#DADAD6);margin-bottom:10px;flex-shrink:0}'
  /* só a lista de itens rola por dentro — topo (logo) e rodapé (usuário/sair)
     ficam sempre visíveis, mesmo em telas baixas (TV) ou sem scroll por
     toque/mouse disponível, sem depender de rolar até o fim pra deslogar */
  + '#dsnav .dn-rows{flex:1;min-height:0;overflow-y:auto}'
  + '#dsnav .dn-brand{display:flex;align-items:center;text-decoration:none;min-width:0}'
  + '#dsnav .dn-exit-mobile{display:none}'
  + '#dsnav .dn-brand img{height:46px;display:block;transition:height .15s ease;flex-shrink:0}'
  + '#dsnav.pinned .dn-brand img,#dsnav:hover .dn-brand img{height:78px}'
  + '#dsnav.pinned .dn-top,#dsnav:hover .dn-top{justify-content:center}'
  + '#dsnav .dn-sec{font-size:9.5px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;'
  +   'color:var(--ink3,#98A0B3);padding:12px 10px 6px;white-space:nowrap;overflow:hidden;'
  +   'opacity:0;transition:opacity .1s ease}'
  + '#dsnav.pinned .dn-sec,#dsnav:hover .dn-sec{opacity:1}'
  + '#dsnav a.dn-item{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:9px;'
  +   'font-size:12.5px;font-weight:600;color:var(--ink2,#4E5A72);text-decoration:none;'
  +   'transition:background .12s ease;margin-bottom:2px;white-space:nowrap;overflow:hidden}'
  + '#dsnav a.dn-item svg{width:16px;height:16px;stroke:currentColor;stroke-width:1.8;fill:none;'
  +   'stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;color:var(--ink3,#98A0B3)}'
  + '#dsnav a.dn-item:hover{background:var(--wsh,#E4E4E1);color:var(--ink,#0E1626)}'
  + '#dsnav a.dn-item.on{background:var(--amw,#FFF6D9);color:var(--amk,#6B4E00)}'
  + '#dsnav a.dn-item.on svg{color:var(--amk,#6B4E00)}'
  + '#dsnav .lbl{opacity:0;transition:opacity .1s ease}'
  + '#dsnav.pinned .lbl,#dsnav:hover .lbl{opacity:1}'
  + '#dsnav .dn-group{margin-bottom:2px}'
  + '#dsnav .dn-group-hd{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:9px;'
  +   'font-size:12.5px;font-weight:600;color:var(--ink2,#4E5A72);cursor:pointer;user-select:none;'
  +   'transition:background .12s ease;white-space:nowrap;overflow:hidden}'
  + '#dsnav .dn-group-hd svg{width:16px;height:16px;stroke:currentColor;stroke-width:1.8;fill:none;'
  +   'stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;color:var(--ink3,#98A0B3)}'
  + '#dsnav .dn-group-hd:hover{background:var(--wsh,#E4E4E1);color:var(--ink,#0E1626)}'
  + '#dsnav .dn-group-hd:hover svg{color:var(--ink,#0E1626)}'
  + '#dsnav .dn-group-hd.on{background:var(--amw,#FFF6D9);color:var(--amk,#6B4E00)}'
  + '#dsnav .dn-group-hd.on svg{color:var(--amk,#6B4E00)}'
  + '#dsnav .dn-chev{margin-left:auto;width:12px;height:12px;flex-shrink:0;opacity:0;'
  +   'transition:opacity .1s ease,transform .15s ease}'
  + '#dsnav.pinned .dn-chev,#dsnav:hover .dn-chev{opacity:1}'
  + '#dsnav .dn-group.open .dn-chev{transform:rotate(90deg)}'
  /* acordeão — abre embaixo do próprio grupo, empurra os itens seguintes,
     igual era antes desta mudança de rail */
  + '#dsnav .dn-sub{display:none;flex-direction:column;padding-left:16px}'
  + '#dsnav.pinned .dn-group.open .dn-sub,#dsnav:hover .dn-group.open .dn-sub{display:flex}'
  + '#dsnav .dn-sub a{padding:8px 10px;font-size:12px}'
  + '#dsnav .dn-sub a.on{background:var(--amw,#FFF6D9);color:var(--amk,#6B4E00);font-weight:700}'
  + '#dsnav .dn-sub a.on svg{color:var(--amk,#6B4E00)}'
  + '#dsnav .dn-foot{margin-top:auto;flex-shrink:0;border-top:1px solid var(--ln,#DADAD6);padding-top:10px;'
  +   'display:flex;align-items:center;gap:9px}'
  + '#dsnav .dn-ava{width:30px;height:30px;border-radius:50%;background:var(--ink,#0E1626);color:#fff;'
  +   'display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}'
  + '#dsnav .dn-user{flex:1;min-width:0;white-space:nowrap;overflow:hidden;opacity:0;transition:opacity .1s ease}'
  + '#dsnav.pinned .dn-user,#dsnav:hover .dn-user{opacity:1}'
  + '#dsnav .dn-user b{display:block;font-size:12px;color:var(--ink,#0E1626);'
  +   'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '#dsnav .dn-user a{font-size:10.5px;color:var(--neg,#C22F49);font-weight:700;text-decoration:none}'
  + 'body.dsnav-pad{margin-left:64px}'
  /* mobile: barra superior fixa com scroll horizontal — sem rail */
  + '@media(max-width:820px){'
  +   'body.dsnav-pad{margin-left:0;padding-top:96px}'
  +   '#dsnav{width:100%;height:auto;bottom:auto;flex-direction:column;padding:6px 8px;'
  +     'border-right:none;border-bottom:1px solid var(--ln,#DADAD6)}'
  +   '#dsnav .dn-top{border-bottom:none;padding:2px 6px 4px;margin-bottom:0}'
  +   '#dsnav .dn-brand img{height:52px}'
  +   '#dsnav .lbl,#dsnav .dn-chev{opacity:1!important}'
  +   '#dsnav .dn-sec{display:none}'
  +   '#dsnav .dn-rows{display:flex;overflow-x:auto;gap:2px;-webkit-overflow-scrolling:touch;scrollbar-width:none}'+'#dsnav .dn-rows::-webkit-scrollbar{display:none}'
  +   '#dsnav a.dn-item{padding:7px 10px;font-size:11px;flex-shrink:0}'
  +   '#dsnav .dn-group{display:contents}'
  +   '#dsnav .dn-group-hd{display:none}'
  +   '#dsnav .dn-group .dn-sub{display:contents!important}'
  +   '#dsnav .dn-foot{display:none}'
  +   '#dsnav .dn-exit-mobile{display:flex;align-items:center;gap:5px;flex-shrink:0;'
  +     'color:var(--neg,#C22F49);font-size:11px;font-weight:700;text-decoration:none;'
  +     'padding:6px 10px;border-radius:8px;background:var(--negw,#FBEAED)}'
  +   '#dsnav .dn-exit-mobile svg{width:14px;height:14px;stroke:currentColor;stroke-width:1.8;fill:none}'
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

    var html = '<div class="dn-top">'
      + '<a class="dn-brand" id="dn-brand" href="/index.html">'
      + '<img src="/logo-supermercados-transp.png" alt="Econômico Supermercados">'
      + '</a>'
      + '<a class="dn-exit-mobile" href="/api/logout">' + icon('logout') + 'Sair</a>'
      + '</div>'
      + '<div class="dn-rows">';
    ITENS.forEach(function (it) {
      var g = it.grupo ? ' data-grupo="' + it.grupo + '"' : '';
      var esconder = it.grupo === 'admin' ? ' style="display:none"' : '';
      if (it.sec) { html += '<div class="dn-sec"' + g + esconder + '>' + it.sec + '</div>'; return; }
      if (it.sub) {
        var ativoSub = it.sub.some(function (s) { return path === s.href; });
        var aberto = ativoSub;
        html += '<div class="dn-group' + (aberto ? ' open' : '') + '" data-grupo-id="' + it.id + '">'
          + '<div class="dn-group-hd' + (ativoSub ? ' on' : '') + '">'
          +   icon(it.ic) + '<span class="lbl">' + it.txt + '</span>' + icon('chevron-right', 'dn-chev')
          + '</div>'
          + '<div class="dn-sub">'
          + it.sub.map(function (s) {
              var onS = path === s.href ? ' on' : '';
              var esc = s.escolha ? ' data-escolha="' + encodeURIComponent(JSON.stringify({ titulo: s.txt, opcoes: s.escolha })) + '"' : '';
              return '<a class="dn-item' + onS + '" href="' + s.href + '"' + esc + '>' + icon(s.ic) + '<span class="lbl">' + s.txt + '</span></a>';
            }).join('')
          + '</div>'
          + '</div>';
        return;
      }
      var on = path === it.href ? ' on' : '';
      var alvo = it.blank ? ' target="_blank" rel="noopener"' : '';
      html += '<a class="dn-item' + on + '"' + g + esconder + ' href="' + it.href + '"' + alvo + '>' + icon(it.ic) + '<span class="lbl">' + it.txt + '</span></a>';
    });
    html += '</div>'
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

    aside.querySelectorAll('.dn-group-hd').forEach(function (hd) {
      hd.addEventListener('click', function () {
        var grp = hd.closest('.dn-group');
        var estavaAberto = grp.classList.contains('open');
        aside.querySelectorAll('.dn-group.open').forEach(function (g) { g.classList.remove('open'); });
        aside.querySelectorAll('.dn-group-hd.on').forEach(function (h) { h.classList.remove('on'); });
        if (!estavaAberto) { grp.classList.add('open'); hd.classList.add('on'); }
      });
    });

    /* clique em ponto vazio do rail fixa ele aberto (útil em touch, sem
       hover de verdade); clique em link/marca/grupo navega ou abre o
       acordeão normal; clicar fora fecha o rail (não fecha os acordeões
       abertos — só recolhe pra ícone, igual recarregar a página faria). */
    /* item com "escolha": em vez de navegar direto, abre uma janela perguntando
       qual das telas o usuário quer (ex.: Sugestão por Rupturas × Sugestão Manual) */
    aside.addEventListener('click', function (e) {
      var esc = e.target.closest('a[data-escolha]');
      if (esc) {
        e.preventDefault();
        var cfg; try { cfg = JSON.parse(decodeURIComponent(esc.getAttribute('data-escolha'))); } catch (err) { location.href = esc.getAttribute('href'); return; }
        abrirEscolha(cfg);
        return;
      }
      if (e.target.closest('a, .dn-group-hd')) return;
      aside.classList.toggle('pinned');
    });
    function abrirEscolha(cfg) {
      var old = document.getElementById('dn-escolha'); if (old) old.remove();
      if (!document.getElementById('dn-escolha-css')) {
        var st = document.createElement('style'); st.id = 'dn-escolha-css';
        st.textContent = '#dn-escolha{position:fixed;inset:0;z-index:5000;background:rgba(14,22,38,.55);display:flex;align-items:center;justify-content:center;padding:20px}'
          + '#dn-escolha .bx{background:#fff;border-radius:14px;max-width:560px;width:100%;box-shadow:0 20px 60px -20px rgba(0,0,0,.5);overflow:hidden;font-family:InterVar,Inter,"Segoe UI",system-ui,sans-serif;color:#0E1626}'
          + '#dn-escolha .hd{background:#101B33;color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:10px}'
          + '#dn-escolha .hd b{font-size:15px;font-weight:800;letter-spacing:-.2px}#dn-escolha .hd small{display:block;color:#AEB8CE;font-size:11.5px;font-weight:500;margin-top:2px}'
          + '#dn-escolha .x{background:rgba(255,255,255,.12);border:none;color:#fff;border-radius:7px;width:30px;height:30px;font-size:16px;cursor:pointer}'
          + '#dn-escolha .ops{padding:14px;display:grid;gap:10px}'
          + '#dn-escolha .op{display:block;text-decoration:none;color:inherit;border:1px solid #DADAD6;border-radius:11px;padding:13px 16px;transition:border-color .12s,background .12s}'
          + '#dn-escolha .op:hover{border-color:#F5B800;background:#FFF6D9}'
          + '#dn-escolha .op b{display:block;font-size:14px;font-weight:800}#dn-escolha .op span{display:block;font-size:12px;color:#4E5A72;margin-top:3px;line-height:1.4}';
        document.head.appendChild(st);
      }
      var ov = document.createElement('div'); ov.id = 'dn-escolha';
      ov.innerHTML = '<div class="bx"><div class="hd"><div><b>' + cfg.titulo + '</b><small>Qual sugestão você quer usar?</small></div><button class="x" aria-label="Fechar">×</button></div>'
        + '<div class="ops">' + cfg.opcoes.map(function (o) { return '<a class="op" href="' + o.href + '"><b>' + o.txt + '</b>' + (o.desc ? '<span>' + o.desc + '</span>' : '') + '</a>'; }).join('') + '</div></div>';
      ov.addEventListener('click', function (ev) { if (ev.target === ov || ev.target.closest('.x')) ov.remove(); });
      document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); } });
      document.body.appendChild(ov);
    }
    document.addEventListener('click', function (e) {
      if (aside.classList.contains('pinned') && !aside.contains(e.target)) {
        aside.classList.remove('pinned');
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
        aside.querySelectorAll('.dn-item,.dn-sec,.dn-group').forEach(function (el) {
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
