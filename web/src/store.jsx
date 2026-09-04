// Общее состояние приложения: настройки витрины, тема, вход, корзина,
// избранное, всплывающие сообщения. Внешний менеджер состояния тут лишний —
// данных немного, а каждая лишняя библиотека утяжеляет загрузку на телефоне.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as api from "./lib/api.js";
import { store } from "./lib/storage.js";

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

const FAV_KEY = "favorites";
const THEME_KEY = "theme";

function readFavorites() {
  return new Set(store.get(FAV_KEY, []));
}

export function AppProvider({ children }) {
  const [meta, setMeta] = useState(null);
  const [user, setUser] = useState(null);
  const [cart, setCart] = useState({ items: [], count: 0, subtotal: 0, hasOnRequest: false });
  const [favorites, setFavorites] = useState(readFavorites);
  const [theme, setTheme] = useState(() => store.get(THEME_KEY, "system"));
  const [toasts, setToasts] = useState([]);
  const [ready, setReady] = useState(false);
  const toastId = useRef(0);

  const toast = useCallback((text, kind = "ok") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);

  // Тема применяется к documentElement и к цвету строки состояния телефона.
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && system.matches);
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    };
    apply();
    system.addEventListener("change", apply);
    if (theme === "system") store.remove(THEME_KEY);
    else store.set(THEME_KEY, theme);
    return () => system.removeEventListener("change", apply);
  }, [theme]);

  // Первый заход: настройки витрины, корзина и — если сессия жива — профиль.
  useEffect(() => {
    (async () => {
      const [metaRes, cartRes] = await Promise.allSettled([
        api.get("/api/catalog/meta"),
        api.get("/api/cart"),
      ]);
      if (metaRes.status === "fulfilled") setMeta(metaRes.value);
      if (cartRes.status === "fulfilled") setCart(cartRes.value);

      // В автономной сборке личного кабинета нет — сессию не проверяем.
      if (api.STANDALONE) { setReady(true); return; }

      try {
        const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          api.setToken(data.accessToken);
          setUser(data.user);
          // Звёздочки, поставленные до регистрации, переносим на аккаунт.
          const local = [...readFavorites()];
          if (local.length) await api.post("/api/account/favorites/merge", { ids: local });
        }
      } catch { /* гость — обычное состояние, не ошибка */ }
      setReady(true);
    })();
  }, []);

  const value = useMemo(() => ({
    meta, user, cart, favorites, theme, toasts, ready,
    setTheme, toast,

    async login(payload, endpoint = "/api/auth/login") {
      const data = await api.post(endpoint, payload);
      api.setToken(data.accessToken);
      setUser(data.user);
      const local = [...readFavorites()];
      if (local.length) await api.post("/api/account/favorites/merge", { ids: local });
      setCart(await api.get("/api/cart"));
      return data.user;
    },

    async logout() {
      await api.post("/api/auth/logout").catch(() => {});
      api.setToken(null);
      setUser(null);
      setCart(await api.get("/api/cart").catch(() => ({ items: [], count: 0, subtotal: 0 })));
    },

    async addToCart(variantId, qty = 1) {
      setCart(await api.post("/api/cart/items", { variantId, qty }));
      toast("Добавлено в корзину");
    },
    async setQty(itemId, qty) { setCart(await api.patch(`/api/cart/items/${itemId}`, { qty })); },
    async removeItem(itemId) { setCart(await api.del(`/api/cart/items/${itemId}`)); },
    async clearCart() { setCart(await api.del("/api/cart")); },
    async reloadCart() { setCart(await api.get("/api/cart")); },

    // Избранное работает и без входа: в браузере — сразу, на сервере — если вошёл.
    toggleFavorite(productId) {
      setFavorites((prev) => {
        const next = new Set(prev);
        next.has(productId) ? next.delete(productId) : next.add(productId);
        localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
        return next;
      });
      if (user) api.put(`/api/account/favorites/${productId}`).catch(() => {});
    },
    isFavorite: (id) => favorites.has(id),
  }), [meta, user, cart, favorites, theme, toasts, ready, toast]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
