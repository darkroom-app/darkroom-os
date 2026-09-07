// DARKROOM OS: service worker
//
// Deliberately does NOT cache anything. This file's two jobs are
// (1) satisfy the browser's requirement that an installable PWA have an
// active service worker with a fetch handler, and (2) receive Web Push
// events (Phase 34) and show them as real OS notifications — this is what
// lets a notification reach someone even with no tab/window open at all.
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

// push-notify (the Edge Function) sends { title, body, url } as JSON —
// url is where notificationclick below should land, already resolved
// server-side (e.g. straight to the relevant project) so this stays dumb.
self.addEventListener('push', (event) => {
  let data = { title: 'DARKROOM OS', body: '', url: '/darkroom-app.html' };
  try { data = { ...data, ...event.data.json() }; } catch (e) { /* non-JSON payload — fall back to defaults */ }
  // No explicit icon/badge — Windows already shows its own small app icon
  // next to the title automatically; adding icon/badge here duplicated it
  // as a second, bigger image in the notification body.
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url },
    })
  );
});

// Focuses an already-open app window if there is one (rather than opening
// a duplicate), navigating it to the notification's target first.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/darkroom-app.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
