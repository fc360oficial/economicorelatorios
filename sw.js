// Cahu360 Process — Service Worker
// Atualiza este número de versão sempre que publicar novos arquivos
var CACHE_NAME = 'cahu360-v37';

var SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

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
        keys
          .filter(function(key) { return key !== CACHE_NAME; })
          .map(function(key) { return caches.delete(key); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Intercepta requisições: cache-first para arquivos locais, network-first para Firebase/CDN
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Deixa o Firebase SDK gerenciar as suas próprias requisições
  if (url.includes('googleapis.com') || url.includes('firestore.googleapis.com') || url.includes('firebaseio.com')) {
    return;
  }

  // Para fontes Google e CDN externos: tenta rede, cai no cache
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

  // Arquivos locais: cache-first (app funciona offline)
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) {
        // Retorna do cache e atualiza em background (stale-while-revalidate)
        fetch(event.request).then(function(resp) {
          if (resp && resp.ok) {
            caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, resp); });
          }
        }).catch(function() {});
        return cached;
      }
      // Não está no cache: busca na rede e guarda
      return fetch(event.request).then(function(resp) {
        if (resp && resp.ok && event.request.method === 'GET') {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return resp;
      }).catch(function() {
        // Fallback final: retorna o index.html para navegação offline
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
