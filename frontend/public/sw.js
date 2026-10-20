// P7: a minimal service worker so ColdChain installs as an app and its shell opens offline. It caches ONLY the
// static app shell (HTML, JS, CSS, fonts, icons). It never touches /api or /socket.io, so no authenticated data
// is ever stored — the shell holds no user data, and all fridge/alert data is fetched fresh at runtime.
const CACHE = 'coldchain-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add('/'))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// P7: Web Push. The backend sends {title, body, url} for BREACH and 5-min DOOR alerts; show it, and focus or
// open the dashboard when it is clicked. No payload is cached; this never touches /api.
self.addEventListener('push', (event) => {
  let data = { title: 'ColdChain alert', body: '', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.url, // one alert per target replaces the previous, so the screen is not flooded
      data: { url: data.url },
      icon: '/icon.svg',
      badge: '/icon.svg',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => c.url.includes(url) || 'focus' in c);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return; // never cache live data

  if (request.mode === 'navigate') {
    // Network-first for the shell: a fresh index.html when online, the cached one when offline.
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Static assets: cache-first, then network (and remember basic same-origin responses).
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        }),
    ),
  );
});
