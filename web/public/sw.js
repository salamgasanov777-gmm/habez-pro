// Офлайн-режим. Прораб на объекте часто без сети — карточки, которые он уже
// открывал, должны открываться и без интернета, как в прежнем каталоге.
const VERSION = "habez-gips-v1";
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const IMAGES = `${VERSION}-img`;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "./manifest.webmanifest", "./data/catalog.json"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // Корзина, заказы и вход всегда идут в сеть: показывать их из кеша нельзя.
  if (/^\/api\/(cart|orders|auth|payments|admin|account)/.test(url.pathname)) return;

  // Каталог: сначала сеть, кеш — запасной вариант. Свежие данные важнее.
  if (url.pathname.startsWith("/api/catalog")) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Фотографии не меняются — отдаём из кеша сразу.
  if (/\.(webp|jpg|jpeg|png|svg)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(IMAGES).then((c) => c.put(request, copy));
        return res;
      }))
    );
    return;
  }

  // Оболочка приложения: любая внутренняя ссылка офлайн открывает index.html.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./") || caches.match(new URL(self.registration.scope))));
  }
});
