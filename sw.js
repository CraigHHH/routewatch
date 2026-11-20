/* RouteWatch service worker: keeps the app and the last cam images available offline. */
var SHELL = 'rw-shell-v1';
var CAMS = 'rw-cams-v1';
var FILES = ['./', 'index.html', 'app.js', 'data.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== CAMS; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Cam images: try the network, keep a copy, fall back to the saved copy.
  if (url.hostname === 'www.drivebc.ca' && url.pathname.indexOf('/images/') === 0) {
    var key = url.origin + url.pathname;
    e.respondWith(fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CAMS).then(function (c) { c.put(key, copy); });
      return res;
    }).catch(function () {
      return caches.open(CAMS).then(function (c) { return c.match(key); }).then(function (hit) { return hit || Response.error(); });
    }));
    return;
  }
  // App files: network first so updates show up, saved copy when offline.
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(SHELL).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('index.html'); });
    }));
  }
});
