// DARKROOM OS: service worker
//
// Deliberately does NOT cache anything. This file's only two jobs right
// now are (1) satisfy the browser's requirement that an installable PWA
// have an active service worker with a fetch handler, and (2) be the
// landing spot for push notifications later (receiving a Web Push event
// requires an active service worker regardless of any caching strategy).
//
// darkroom-app.html changes constantly during active development — a
// cache-first (or any caching) strategy is exactly how PWAs famously get
// people stuck looking at a stale version days after a fix shipped. Every
// request here just goes straight to the network, every time, so a user
// always gets whatever's actually deployed. skipWaiting()/clients.claim()
// below mean a newly deployed service worker itself takes over immediately
// on next load too, rather than waiting for every open tab to close first.
//
// If real offline support or caching is ever wanted, it needs a deliberate
// cache-busting strategy (e.g. versioned cache names + a network-first
// fallback) — don't add a naive cache.put() here without one.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
