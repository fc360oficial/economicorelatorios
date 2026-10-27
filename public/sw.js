// Service worker mínimo — existe pra habilitar "Instalar app" no celular e receber avisos (Web Push).
// Não faz cache (dados são sempre em tempo real), sempre busca da rede.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});

// Avisos (27/10/2026, Gestão Gerencial no celular do gerente — lib/gerencial-push.js): payload { title, body, url, tag }.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Econômico', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || undefined, renotify: !!d.tag,
    vibrate: [100, 50, 100], data: { url: d.url || '/' }
  }));
});
// Toque no aviso: foca uma janela do app já aberta (e leva pra URL do aviso) ou abre uma nova.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    for (const w of ws) { if ('focus' in w) { if (w.navigate) w.navigate(url); return w.focus(); } }
    return self.clients.openWindow(url);
  }));
});
