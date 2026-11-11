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
    data: { url: d.url || '/fornecedor/', rid: d.rid || null },
    vibrate: [120, 60, 120],
    requireInteraction: false
  };
  if (d.tag) { opts.tag = d.tag; opts.renotify = true; }
  // recibo (10/11/26): a notificação apareceu → avisa o servidor; push sem rid (de antes do recibo) só mostra
  e.waitUntil(self.registration.showNotification(d.title || 'Econômico · Portal do Fornecedor', opts).then(function () { return recibo(d.rid, 'recebido'); }));
});

// Recibo de entrega (Tiago, 10/11/26: "a mensagem precisa chegar; saber se chegou"): o servidor só sabia que o Google/Apple aceitou
// a mensagem; agora recebe POST /api/portal/recibo { rid, ev } quando ela aparece ('recebido') e quando o vendedor toca ('abriu').
// Erro de rede é engolido: o aviso nunca depende disso. keepalive deixa o POST terminar se o worker for encerrado antes; navegador
// que recusa keepalive dentro do worker manda sem.
function recibo(rid, ev) {
  if (!rid) return Promise.resolve();
  var req = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rid: rid, ev: ev }) };
  return fetch('/api/portal/recibo', Object.assign({ keepalive: true }, req)).catch(function () { return fetch('/api/portal/recibo', req); }).catch(function () {});
}

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || '/fornecedor/', self.location.origin).href;
  var rid = e.notification.data && e.notification.data.rid;
  var abrir = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (c.url === url && 'focus' in c) return c.focus();
    }
    for (var j = 0; j < cs.length; j++) {
      var w = cs[j];
      if ('navigate' in w && 'focus' in w) return w.navigate(url).then(function (x) { return x && x.focus(); }).catch(function () { return self.clients.openWindow(url); });
    }
    return self.clients.openWindow(url);
  });
  e.waitUntil(Promise.all([abrir, recibo(rid, 'abriu')]));   // recibo 'abriu' junto do foco/abertura da janela (a lógica acima não mudou)
});

// Inscrição renovada pelo navegador: a página refaz a inscrição na próxima abertura (hook.js / index.html).
self.addEventListener('pushsubscriptionchange', function () {});
