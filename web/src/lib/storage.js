// Всё, что приложение сохраняет в браузере, лежит под своим префиксом.
// Приложение №1 (каталог hgz-catalog) держит ключи вида "hgz-favorites".
// Если оба сайта окажутся на одном домене вроде username.github.io, хранилище
// у них общее — и без разных имён они бы затирали избранное и тему друг друга.
const NS = "habezpro.";

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* приватный режим */ }
  },
  remove(key) {
    try { localStorage.removeItem(NS + key); } catch { /* приватный режим */ }
  },
  session: {
    get(key, fallback = null) {
      try {
        const raw = sessionStorage.getItem(NS + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { sessionStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* приватный режим */ }
    },
  },
};
