// ═══════════════════════════════════════════════════════════
// Haven: Service Worker for Push Notifications
// Handles incoming push events and notification click actions
// ═══════════════════════════════════════════════════════════

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Haven', body: event.data.text() };
  }

  const title = payload.title || 'Haven';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.svg',
    badge: '/icon-192.svg',
    tag: payload.tag || 'haven-message',       // collapse similar notifications
    renotify: true,                            // alert even if same tag
    data: {
      channelCode: payload.channelCode || null,
      url: payload.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Click notification → focus Haven tab or open it
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/app';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If Haven is already open, focus it and navigate
      for (const client of windowClients) {
        if (client.url.includes('/app')) {
          client.focus();
          // Post the channel code so the app can switch channels
          if (event.notification.data?.channelCode) {
            client.postMessage({
              type: 'push-notification-click',
              channelCode: event.notification.data.channelCode
            });
          }
          return;
        }
      }
      // Otherwise open a new window
      return clients.openWindow(targetUrl);
    })
  );
});

// ── Offline app shell ──────────────────────────────────────
// When the server cannot be reached (laptop off the Wi-Fi, server
// restarting, LAN with no internet and the box down) the app opens from
// this cache instead of the browser's error page, and shows its own
// offline/reconnecting state. Network-first, so nothing changes online.
// Only the static shell is kept: app.html, scripts, styles, fonts, icons,
// translations and the socket.io client script. Never /api, uploads, the
// socket.io transport, other origins, or anything sent with credentials
// in an Authorization header, so nothing one account fetched is ever served
// to another on a shared device. Bump SHELL_CACHE when this logic changes.
const SHELL_CACHE = 'haven-shell-v1';
const SHELL_PATH = /^\/(app|index\.html|app\.html|manifest\.webmanifest|favicon\.svg|icon-\d+\.svg|emoji-keywords\.json|socket\.io\/socket\.io\.js|(js|css|fonts|img|locales|sounds|emoji)\/.+)?$/;

// Keep one copy per path: a new release changes the ?v= on every asset, and
// the old versions would otherwise pile up in the cache for good.
async function putShell(cache, request, response) {
  const url = typeof request === 'string' ? request : request.url;
  const old = await cache.keys(url, { ignoreSearch: true });
  await Promise.all(old.filter(k => k.url !== url).map(k => cache.delete(k)));
  await cache.put(url, response);
}

function isShellRequest(request) {
  if (request.method !== 'GET') return false;
  if (request.headers.has('Authorization')) return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return SHELL_PATH.test(url.pathname);
}

const OFFLINE_PAGE = '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Haven: offline</title>' +
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'font-family:system-ui,sans-serif;background:#1e1f2b;color:#e6e6f0;text-align:center}' +
  'button{margin-top:16px;padding:8px 20px;border:0;border-radius:6px;background:#6b4fdb;color:#fff;font-size:15px;cursor:pointer}</style>' +
  '</head><body><div><h1>Haven is offline</h1><p>The server cannot be reached right now. Trying again automatically.</p>' +
  '<button onclick="location.reload()">Try now</button></div>' +
  '<script>var d=3000;function t(){fetch(location.href,{cache:"no-store"}).then(function(r){if(r.ok)location.reload();else s()}).catch(s)}' +
  'function s(){d=Math.min(d*2,60000);setTimeout(t,d)}setTimeout(t,d)</script></body></html>';

self.addEventListener('install', () => self.skipWaiting());

// The page lists the same-origin files it loaded (performance entries) once
// this worker is in charge, so the shell is complete from the very first
// visit rather than only after a second load. Only shell paths are taken.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache-shell' || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.slice(0, 500).filter(u => {
    try { return isShellRequest(new Request(u)); } catch { return false; }
  });
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => Promise.all(urls.map(u =>
    fetch(u, { credentials: 'same-origin' }).then(r => {
      if (r.ok && r.type === 'basic' && !/no-store/i.test(r.headers.get('Cache-Control') || '')) return putShell(cache, u, r);
    }).catch(() => {})
  ))));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isShellRequest(request)) return; // straight to the network, untouched
  event.respondWith((async () => {
    const cached = async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Asset URLs carry ?v=<version>; an older cached copy beats nothing.
      return await cache.match(request) || await cache.match(request, { ignoreSearch: true });
    };
    try {
      const response = await fetch(request);
      // Behind a reverse proxy a stopped Haven is a 502/503/504, not a
      // network error: open the cached app for that too.
      if (response.status >= 502 && response.status <= 504) return (await cached()) || response;
      if (response.ok && response.type === 'basic' &&
          !/no-store/i.test(response.headers.get('Cache-Control') || '')) {
        const copy = response.clone();
        event.waitUntil(caches.open(SHELL_CACHE).then(c => putShell(c, request, copy)).catch(() => {}));
      }
      return response;
    } catch (err) {
      const hit = await cached();
      if (hit) return hit;
      if (request.mode === 'navigate') {
        return new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      throw err;
    }
  })());
});

// Activate immediately; don't wait for old SW to die
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('haven-shell-') && n !== SHELL_CACHE).map(n => caches.delete(n)));
    await clients.claim();
  })());
});

// A client (another open tab/device) marked the channel read: close any of
// our own push notifications for it so the badge/toast doesn't linger after
// the message has already been seen elsewhere.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'close-channel-notifications' || !event.data.channelCode) return;
  const tag = `haven-${event.data.channelCode}`;
  event.waitUntil(
    self.registration.getNotifications({ tag }).then((notifications) => {
      for (const notification of notifications) notification.close();
    })
  );
});
