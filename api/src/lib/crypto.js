// Пароли, JWT и одноразовые коды — на стандартной библиотеке Node.
// Внешние пакеты для криптографии здесь не дают ничего, кроме рисков.
import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
import { config } from "../config.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

// Шестизначный код без модуля по остатку: он сместил бы распределение.
export function numericCode(len = 6) {
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len)) {
      if (b < 250 && out.length < len) out += b % 10;
    }
  }
  return out;
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

export function signJwt(payload, ttlSec = config.auth.accessTtl) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const head = b64({ alg: "HS256", typ: "JWT" });
  const data = `${head}.${b64(body)}`;
  const sig = createHmac("sha256", config.auth.jwtSecret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyJwt(token) {
  if (!token || token.split(".").length !== 3) return null;
  const [head, body, sig] = token.split(".");
  const expected = createHmac("sha256", config.auth.jwtSecret).update(`${head}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
