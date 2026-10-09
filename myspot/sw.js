// Memspots service worker: makes the web app installable. No caching, so updates are never stale.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
