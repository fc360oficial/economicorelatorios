// Fluxo Certo 360 — Service Worker
// Atualiza este número de versão sempre que publicar novos arquivos
var CACHE_NAME = 'cahu360-v170';

// Arquivos críticos: sempre buscados da rede (nunca do cache)
var NETWORK_FIRST = ['app.js', 'index.html', 'monitor.html'];

var SHELL_ASSETS = [
  './',
  './index.html',
  './app.js?v=169',
  './style.css?v=163',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

// Responde ao postMessage SKIP_WAITING enviado pelo app
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Instala e faz cache dos arquivos do app
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_ASSETS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Ativa e remove caches antigos
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
          .map(function(key) { return caches.delete(key); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Intercepta requisições
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Firebase: não intercepta
  if (url.includes('googleapis.com') || url.includes('firestore.googleapis.com') || url.includes('firebaseio.com')) {
    return;
  }

  // CDN externos: network-first, cai no cache se offline
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') || url.includes('cdn.jsdelivr.net') || url.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      fetch(event.request).then(function(resp) {
        if (resp.ok) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return resp;
      }).catch(function() {
        return caches.match(event.request);
      })
    );
    return;
  }

  // app.js e index.html: SEMPRE network-first
  var urlPath = url.split('?')[0];
  var isNetworkFirst = NETWORK_FIRST.some(function(f) { return urlPath.endsWith(f); });
  if (isNetworkFirst) {
    event.respondWith(
      fetch(event.request).then(function(resp) {
        if (resp && resp.ok) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return resp;
      }).catch(function() {
        // Offline: usa cache como fallback
        return caches.match(event.request);
      })
    );
    return;
  }

  // Demais arquivos locais: cache-first (imagens, css, etc.)
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) {
        fetch(event.request).then(function(resp) {
          if (resp && resp.ok) {
            caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, resp); });
          }
        }).catch(function() {});
        return cached;
      }
      return fetch(event.request).then(function(resp) {
        if (resp && resp.ok && event.request.method === 'GET') {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return resp;
      }).catch(function() {
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
