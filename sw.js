// VoterPup service worker: reminders only (no offline caching, so updates are never stale).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'VoterPup', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || ('vp-' + (d.url || '').replace(/[^a-z0-9]/gi, '').slice(-24)),
    data: { url: d.url || '/app.html' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data.url || '/app.html', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    // reuse an open VoterPup tab when we can; if it can't be steered (not controlled yet), open the item in a new one
    for (const w of ws) if (w.url.startsWith(self.location.origin) && 'navigate' in w)
      return w.navigate(url).then((c) => (c || w).focus()).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
