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

  // Фотографии: сразу из кеша (быстро и работает без сети), а следом тихо
  // спрашиваем сервер и кладём свежий файл на место старого. Имена снимков
  // при обновлении каталога не меняются («prime.jpg» остаётся «prime.jpg»),
  // поэтому без такой перепроверки телефон показывал бы старую упаковку
  // вечно: он просто не обращался бы к серверу.
  if (/\.(webp|jpg|jpeg|png|svg)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const fresh = fetch(request).then((res) => {
          // Кладём только настоящую картинку. Сервер на неизвестный адрес
          // отдаёт страницу приложения с кодом 200 — без проверки типа она
          // подменила бы фотографию в памяти телефона.
          const isImage = (res.headers.get("content-type") || "").startsWith("image/");
          if (res.ok && res.status === 200 && isImage) {
            const copy = res.clone();
            caches.open(IMAGES).then((c) => c.put(request, copy));
          }
          return res;
        });
        // Есть в памяти — показываем его, обновление идёт фоном к следующему
        // разу. Нет — ждём сеть, как раньше.
        if (!hit) return fresh;
        event.waitUntil(fresh.catch(() => {}));
        return hit;
      })
    );
    return;
  }

  // Оболочка приложения: любая внутренняя ссылка офлайн открывает index.html.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./") || caches.match(new URL(self.registration.scope))));
  }
});
