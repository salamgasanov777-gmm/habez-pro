// Единственная точка обращения к данным. Приложение собирается в двух режимах:
// с сервером (заказы, оплата, панель) и автономно (витрина, заявка, офлайн).
// Разница спрятана здесь — страницы одинаковые в обоих случаях. Access-токен живёт в памяти
// вкладки, а не в localStorage: так его не достанет чужой скрипт. Долгий
// refresh-токен лежит в httpOnly-cookie, JavaScript до него не дотягивается.
import { handleLocal } from "./standalone.js";

// Флаг ставится при сборке: VITE_STANDALONE=1 npm run build
export const STANDALONE = import.meta.env.VITE_STANDALONE === "1";

let accessToken = null;
let refreshing = null;

export const setToken = (t) => { accessToken = t; };
export const getToken = () => accessToken;

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || "Ошибка сети");
    this.status = status;
    this.code = payload?.error?.code;
    this.fields = payload?.error?.fields || [];
  }
}
export { ApiError };

async function raw(path, { method = "GET", body, headers = {}, signal } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "include",
    signal,
    headers: {
      ...(body instanceof FormData ? {} : body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  return res;
}

export async function api(path, options = {}) {
  if (STANDALONE) {
    try {
      return await handleLocal(path, options);
    } catch (e) {
      throw new ApiError(e.status || 500, { error: { message: e.message } });
    }
  }

  let res = await raw(path, options);

  // Токен живёт 15 минут. Истёк — молча обновляем и повторяем запрос один раз,
  // чтобы человек не видел случайных выкидываний из аккаунта.
  if (res.status === 401 && !options._retried && !path.startsWith("/api/auth/")) {
    refreshing = refreshing || fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .finally(() => { refreshing = null; });
    const data = await refreshing;
    if (data?.accessToken) {
      setToken(data.accessToken);
      res = await raw(path, { ...options, _retried: true });
    }
  }

  if (res.status === 204) return null;
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

export const get = (path, options) => api(path, options);
export const post = (path, body, options) => api(path, { ...options, method: "POST", body });
export const patch = (path, body) => api(path, { method: "PATCH", body });
export const put = (path, body) => api(path, { method: "PUT", body });
export const del = (path, body) => api(path, { method: "DELETE", body });

export const qs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
