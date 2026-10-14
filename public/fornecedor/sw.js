// Service worker do Portal do Fornecedor (escopo /fornecedor/). Só recebe os avisos (Web Push) e abre a página certa
// ao tocar. De propósito NÃO guarda página em cache: a cotação do vendedor precisa estar sempre atual (o sw.js da raiz,
// do Econômico Relatórios, tem escopo "/" e não controla este caminho porque este escopo é mais específico).
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Econômico · Portal do Fornecedor', body: e.data ? e.data.text() : '' }; }
  var opts = {
    body: d.body || '',
    icon: '/icon-192.png?v=2',
    badge: '/icon-192.png?v=2',
    data: { url: d.url || '/fornecedor/' },
    vibrate: [120, 60, 120],
    requireInteraction: false
  };
  if (d.tag) { opts.tag = d.tag; opts.renotify = true; }
  e.waitUntil(self.registration.showNotification(d.title || 'Econômico · Portal do Fornecedor', opts));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || '/fornecedor/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (c.url === url && 'focus' in c) return c.focus();
    }
    for (var j = 0; j < cs.length; j++) {
      var w = cs[j];
      if ('navigate' in w && 'focus' in w) return w.navigate(url).then(function (x) { return x && x.focus(); }).catch(function () { return self.clients.openWindow(url); });
    }
    return self.clients.openWindow(url);
  }));
});

// Inscrição renovada pelo navegador: a página refaz a inscrição na próxima abertura (hook.js / index.html).
self.addEventListener('pushsubscriptionchange', function () {});
