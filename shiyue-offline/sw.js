const version = 'd7a13c563e042e75';
const prefix = `shiyue:${new URL(self.registration.scope).pathname}:`;
const active = prefix + version;
const paths = ["./app.mjs","./model.mjs","./library.mjs","./offline-store.mjs","./style.css","./shelf.svg","./manifest.webmanifest","./icon-192.png","./icon-512.png","./index.html"];
const start = new URL('./', self.registration.scope).href;
const index = new URL('./index.html', start).href;
const assets = new Set(paths.map((path) => new URL(path, start).href));
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(active).then((cache) => cache.addAll(paths.map((path) => new Request(new URL(path, start), { cache: 'reload' })))));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith(prefix) && name !== active).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate' && [start, index].includes(url.origin + url.pathname)) {
    event.respondWith(caches.open(active).then((cache) => cache.match(index)).then((page) => page || fetch(event.request)));
  } else if (assets.has(url.href)) {
    event.respondWith(caches.open(active).then((cache) => cache.match(url.href)).then((asset) => asset || fetch(event.request)));
  }
});
