const CACHE = 'exp-timer-v9';
const CORE = [
  './',
  './index.html',
  './style.css',
  './main.js',
  './manifest.json',
  './icon.svg'
];
const OPTIONAL = ['https://unpkg.com/nes.css@2.3.0/css/nes.min.css'];
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(CORE);
      await Promise.allSettled(OPTIONAL.map(u => c.add(u)));
    }).then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const req = e.request;
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return r;
      } catch {
        const cached = await caches.match('./index.html');
        if (cached) return cached;
        return new Response('<!doctype html><title>離線</title><h1>離線中</h1><p>請連線後再試。</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }
  e.respondWith(
    caches.match(req).then(res => res || fetch(req).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return r;
    }))
  );
});
