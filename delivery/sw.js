// SW exclusivo do delivery — impede interferência do FC360
self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e) { e.respondWith(fetch(e.request)); });
