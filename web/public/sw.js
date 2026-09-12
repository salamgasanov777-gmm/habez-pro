// Офлайн-режим. Прораб на объекте часто без сети — карточки, которые он уже
// открывал, должны открываться и без интернета, как в прежнем каталоге.
const VERSION = "habez-gips-v2";
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

// ── Push-уведомления менеджеру ─────────────────────────────────────────
// Сервер прислал сообщение о заказе — показываем его как обычное
// уведомление телефона, даже если приложение закрыто.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Habez Gips", body: event.data?.text() || "" }; }
  const title = data.title || "Habez Gips";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    // Заказы не схлопываются в одно уведомление: каждый — отдельно.
    tag: data.tag || ("hgz-" + Date.now()),
    data: { url: data.url || "./admin" },
    vibrate: [90, 40, 90],
  }));
});

// Нажатие на уведомление открывает нужный раздел панели. Если приложение
// уже открыто — переводим его, а не плодим окна.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./admin", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.navigate(target); return c.focus(); }
      }
      return self.clients.openWindow(target);
    })
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
