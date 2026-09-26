// Habez AI — проверка интерфейса в настоящем браузере (Phase 3.1).
//
//   npm run e2e:ai          (из корня: сборка витрины + этот сценарий)
//
// Без новых зависимостей: браузер Chromium (Chrome, Playwright-сборка или
// CHROME_PATH) управляется по протоколу DevTools через встроенный WebSocket.
// Сервер Habez поднимается здесь же на тестовой базе во временной папке,
// «модель» — поддельный Messages API (api/test/helpers/fake-llm.js).
//
// Вход без ручного ввода пароля: администратор — готовой сессией
// (refresh-cookie из тестовой базы), менеджер — через форму входа с
// паролем, который сценарий сам создал в тестовой базе. Рабочая база и
// настоящие учётные записи не используются.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "habez-e2e-"));
const shots = process.env.E2E_SHOTS || join(work, "shots");
mkdirSync(shots, { recursive: true });
if (!existsSync(join(root, "web/dist/index.html"))) {
  console.error("Нет сборки витрины: npm --prefix web run build");
  process.exit(2);
}

// ── Сервер Habez на тестовой базе ──────────────────────────────────────────
const { startFakeLlm } = await import(join(root, "api/test/helpers/fake-llm.js"));
const fake = await startFakeLlm();
Object.assign(process.env, {
  DATABASE_FILE: join(work, "hgz.db"), UPLOAD_DIR: join(work, "uploads"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1",
  AI_PROVIDER: "openrouter", AI_BASE_URL: fake.url, OPENROUTER_API_KEY: "test-key-not-a-secret", AI_TIMEOUT_MS: "8000",
  AI_RATE_STAFF: "1000", AI_RATE_PUBLIC: "1000", AI_PUBLIC_DAILY_MAX: "0",
});
delete process.env.ANTHROPIC_API_KEY;
const { prepareAiDb, LEVEL_VALUES } = await import(join(root, "api/test/helpers/ai-fixture.js"));
await prepareAiDb();
const { insert, run, get } = await import(join(root, "api/src/db/index.js"));
const { hashPassword, randomToken, sha256 } = await import(join(root, "api/src/lib/crypto.js"));
const { config } = await import(join(root, "api/src/config.js"));
const { build } = await import(join(root, "api/src/server.js"));

const managerPassword = randomBytes(15).toString("base64url");
const managerId = insert("users", { tenant_id: 1, email: "e2e-manager@test.habez.local", name: "E2E менеджер", role: "manager", status: "active", password_hash: hashPassword(managerPassword) });
const adminId = insert("users", { tenant_id: 1, email: "e2e-admin@test.habez.local", name: "E2E админ", role: "admin", status: "active" });
// Готовая сессия администратора: как после входа, но без пароля.
const session = (userId) => {
  const token = randomToken(32);
  insert("sessions", { user_id: userId, token_hash: sha256(token), user_agent: "e2e", ip: "127.0.0.1", expires_at: new Date(Date.now() + 3600e3).toISOString() });
  return token;
};

const app = await build();
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${app.server.address().port}`;

// ── Браузер ────────────────────────────────────────────────────────────────
const candidates = [
  process.env.CHROME_PATH,
  join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter(Boolean);
const chromePath = candidates.find((p) => existsSync(p));
if (!chromePath) { console.error("Не найден Chromium: укажите CHROME_PATH"); process.exit(2); }
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsBrowser = await new Promise((ok, fail) => {
  let buf = "";
  chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]); });
  setTimeout(() => fail(new Error("браузер не запустился")), 15000);
});
const port = new URL(wsBrowser).port;
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map();
const listeners = new Set();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) fail(new Error(msg.error.message)); else ok(msg.result);
  } else for (const l of listeners) l(msg);
});
const cdp = (method, params = {}) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Network.enable");
const consoleErrors = [];
listeners.add((m) => {
  if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr.slice(0, 80)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};
async function waitFor(expr, what, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await js(expr); if (v) return v; } catch { /* страница ещё грузится */ }
    await sleep(60);
  }
  throw new Error(`не дождался: ${what}`);
}
async function go(path) {
  const loaded = new Promise((r) => { const l = (m) => { if (m.method === "Page.loadEventFired") { listeners.delete(l); r(); } }; listeners.add(l); });
  await cdp("Page.navigate", { url: base + path });
  await loaded;
}
const viewport = (width, height, mobile = false) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
async function shot(name) {
  const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64"));
}
// Ввод в поле React: через «родной» setter и событие input.
const typeInto = (sel, text) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const clickText = (sel, text) => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!el) return false; el.click(); return true; })()`);
const ask = async (q) => { await typeInto(".ai-compose textarea", q); await waitFor(`!document.querySelector(".ai-compose button[type=submit]")?.disabled`, "кнопка «Отправить»"); await clickText(".ai-compose button", "Отправить"); };
const lastBot = `[...document.querySelectorAll(".ai-msg.bot")].at(-1)`;
const idle = () => waitFor(`!!document.querySelector(".ai-compose button[type=submit]") && ${lastBot}?.dataset.status !== "streaming"`, "ответ завершён", 12000);
const noHorizontalScroll = () => js("document.documentElement.scrollWidth <= window.innerWidth + 1");

// ── Сценарии ──────────────────────────────────────────────────────────────
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); } catch (e) {
    results.push({ name, ok: false, error: e.message }); console.log(`FAIL ${name}\n     ${e.message}`);
    if (process.env.E2E_DEBUG) {
      const info = await js(`JSON.stringify({ at: location.pathname, bot: ${lastBot}?.dataset.status, botText: ${lastBot}?.textContent.slice(0, 160),
        wide: [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((el) => el.tagName + "." + el.className),
        body: document.body.innerText.slice(0, 200) })`).catch((x) => x.message);
      console.log(`     ${info}`);
    }
    await shot(`fail-${results.length}`).catch(() => {});
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

for (const [label, w, h, mobile] of [["desktop", 1280, 900, false], ["mobile-375", 375, 812, true]]) {
  await viewport(w, h, mobile);
  await cdp("Network.clearBrowserCookies");
  await cdp("Network.setCookie", { name: "hgz_rt", value: session(adminId), url: `${base}/api/auth/`, path: "/api/auth", httpOnly: true });
  fake.mode = "cite";

  await check(`${label}: администратор — «Habez AI» в меню, страница открывается, уровень «все данные»`, async () => {
    await go("/admin");
    await waitFor(`[...document.querySelectorAll(".admin a")].some((a) => a.textContent.includes("Habez AI"))`, "пункт меню");
    await js(`[...document.querySelectorAll(".admin a")].find((a) => a.textContent.includes("Habez AI")).click()`);
    await waitFor(`location.pathname === "/admin/assistant" && !!document.querySelector(".ai-chat")`, "страница Habez AI");
    await waitFor(`document.querySelector(".ai-head .hint")?.textContent.includes("все данные, включая конфиденциальные")`, "уровень доступа");
    assert(await js(`!!document.querySelector(".ai-compose textarea") && document.querySelector(".ai-compose button[type=submit]").disabled`), "поле ввода и неактивная «Отправить» при пустом поле");
    assert(await noHorizontalScroll(), "горизонтальная прокрутка");
    await shot(`${label}-01-empty`);
  });

  await check(`${label}: отправка, поток с «Стоп», блок расхождений, ссылки и источники`, async () => {
    await js(`sessionStorage.clear(), true`);
    await clickText("button", "Новая беседа");
    fake.mode = "slow";
    await ask("Какая прочность на изгиб у ШОВ?");
    await waitFor(`[...document.querySelectorAll(".ai-compose button")].some((b) => b.textContent === "Стоп")`, "кнопка «Стоп» во время потока");
    await waitFor(`${lastBot}?.querySelector(".ai-text")?.textContent.length > 20`, "текст идёт потоком");
    const partial = await js(`${lastBot}.querySelector(".ai-text").textContent.length`);
    await idle();
    assert(await js(`${lastBot}.querySelector(".ai-text").textContent.length`) > partial, "текст дописывался");
    assert(await js(`${lastBot}.querySelectorAll(".ai-ref:not(.static)").length`) > 0, "ссылки [E#] в тексте");
    assert(await js(`${lastBot}.querySelectorAll(".ai-source").length`) > 0, "список источников");
    assert(await js(`${lastBot}.querySelector(".ai-sources").textContent.includes("конфиденциально")`), "пометка «конфиденциально» у источника администратора");
    fake.mode = "cite";
    await ask("Какая прочность ШОВ?");
    await idle();
    assert(await js(`${lastBot}.querySelector(".ai-conflict")?.textContent.includes("Расхождение в данных Habez")`), "блок расхождений");
    assert(await js(`${lastBot}.querySelector(".ai-conflict").textContent.includes("вопрос сверки D4")`), "номер вопроса сверки");
    await shot(`${label}-02-conflict`);
  });

  await check(`${label}: источники — «Ещё», ссылка подсвечивает свой источник, длинные строки не ломают вёрстку`, async () => {
    await ask("Расскажи про ШОВ");
    await idle();
    const before = await js(`${lastBot}.querySelectorAll(".ai-source").length`);
    assert(before === 6, `свёрнуто до 6, а не ${before}`);
    assert(await js(`[...${lastBot}.querySelectorAll(".ai-sources button")].some((b) => b.textContent.startsWith("Ещё"))`), "кнопка «Ещё»");
    await js(`[...${lastBot}.querySelectorAll(".ai-sources button")].find((b) => b.textContent.startsWith("Ещё")).click()`);
    await waitFor(`${lastBot}.querySelectorAll(".ai-source").length > 6`, "список развернулся");
    const lastRef = await js(`[...${lastBot}.querySelectorAll(".ai-text .ai-ref")].at(-1).textContent`);
    await js(`[...${lastBot}.querySelectorAll(".ai-text .ai-ref")].at(-1).click()`);
    await waitFor(`${lastBot}.querySelector(".ai-source.on .ai-ref")?.textContent === ${JSON.stringify(lastRef)}`, "подсвечен источник этой ссылки");
    assert(await noHorizontalScroll(), "горизонтальная прокрутка из-за источников");
    assert(await js(`[...document.querySelectorAll(".ai-source")].every((s) => s.scrollWidth <= s.clientWidth + 1)`), "источник шире своей строки");
    await shot(`${label}-03-sources`);
  });

  await check(`${label}: «Стоп» останавливает ответ и запрос к модели; следующий вопрос работает`, async () => {
    fake.mode = "slow";
    await ask("Какие характеристики у ШОВ?");
    await waitFor(`${lastBot}?.querySelector(".ai-text")?.textContent.length > 10`, "начало ответа");
    await clickText(".ai-compose button", "Стоп");
    await waitFor(`!!document.querySelector(".ai-compose button[type=submit]")`, "кнопка вернулась к «Отправить»");
    assert(await js(`${lastBot}.textContent.includes("Остановлено")`), "пометка «Остановлено»");
    const rec = fake.last();
    for (let i = 0; i < 40 && !rec.aborted; i += 1) await sleep(50);
    assert(rec.aborted && !rec.finished, "запрос к модели оборван");
    fake.mode = "cite";
    await ask("Какие фасовки есть у ГКЛ?");
    await idle();
    assert(await js(`${lastBot}.dataset.status === "done" && ${lastBot}.textContent.includes("лист 9,5 мм")`), "повтор после «Стоп»");
    await shot(`${label}-04-after-stop`);
  });

  await check(`${label}: длинный ответ — целиком, с пометкой об обрезке, без горизонтальной прокрутки`, async () => {
    fake.mode = "long";
    await ask("Какие характеристики у ШОВ?");
    await idle();
    assert(await js(`${lastBot}.querySelector(".ai-text").textContent.length`) > 3000, "длина ответа");
    assert(await js(`${lastBot}.textContent.includes("Ответ обрезан по длине")`), "пометка об обрезке");
    assert(await noHorizontalScroll(), "горизонтальная прокрутка");
    const inputVisible = await js(`(() => { const r = document.querySelector(".ai-compose textarea").getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; })()`);
    assert(inputVisible, "поле ввода видно после длинного ответа");
    await shot(`${label}-05-long`);
  });

  await check(`${label}: ошибка модели — понятный текст и «Повторить»`, async () => {
    fake.mode = "error500";
    await ask("Расскажи про КОРОЕД");
    await waitFor(`${lastBot}?.querySelector(".ai-error")?.textContent.includes("не смог ответить")`, "текст ошибки");
    await shot(`${label}-06-error`);
    fake.mode = "cite";
    await clickText(".ai-error button", "Повторить");
    await idle();
    assert(await js(`${lastBot}.dataset.status === "done"`), "повтор удался");
  });

  await check(`${label}: беседа переживает перезагрузку, «Новая беседа» — чистый лист`, async () => {
    const n = await js(`document.querySelectorAll(".ai-msg").length`);
    await go("/admin/assistant");
    await waitFor(`document.querySelectorAll(".ai-msg").length === ${n}`, "беседа восстановлена");
    await clickText("button", "Новая беседа");
    await waitFor(`!document.querySelector(".ai-msg") && !!document.querySelector(".ai-examples")`, "пустая беседа с примерами");
  });
}

await viewport(1280, 900, false);

await check("менеджер: вход через форму, уровень «витрина и внутренние», конфиденциального нет", async () => {
  await cdp("Network.clearBrowserCookies");
  await go("/login?next=/admin/assistant");
  await waitFor(`!!document.querySelector("input[type=email]")`, "форма входа");
  await typeInto("input[type=email]", "e2e-manager@test.habez.local");
  await typeInto("input[type=password]", managerPassword);
  await js(`document.querySelector("input[type=password]").form.requestSubmit(), true`);
  await waitFor(`location.pathname === "/admin/assistant"`, "после входа — Habez AI");
  await waitFor(`document.querySelector(".ai-head .hint")?.textContent.includes("витрина и внутренние наблюдения")`, "уровень менеджера");
  fake.mode = "cite";
  await ask("Какая прочность на изгиб у ШОВ?");
  await idle();
  const text = await js(`document.querySelector(".ai-log").textContent`);
  assert(!text.includes("конфиденциально") && !text.includes(LEVEL_VALUES.confidential), "конфиденциальное на экране менеджера");
  const input = fake.last().body.messages.at(-1).content;
  assert(!input.includes(LEVEL_VALUES.confidential), "конфиденциальное ушло модели");
});

await check("выход: беседы стёрты из вкладки, панель недоступна", async () => {
  assert(await js(`Object.keys(sessionStorage).some((k) => k.startsWith("habezpro.ai.chat"))`), "беседа сохранялась до выхода");
  await go("/account");
  await waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Выйти")`, "кнопка «Выйти»");
  await clickText("button", "Выйти");
  await waitFor(`location.pathname === "/"`, "ушли на главную");
  assert(await js(`!Object.keys(sessionStorage).some((k) => k.startsWith("habezpro.ai.chat"))`), "беседа осталась после выхода");
  await go("/admin/assistant");
  await waitFor(`location.pathname === "/login"`, "панель без входа ведёт на вход");
});

await check("истечение сессии: понятное «Сессия истекла», не ответ гостя", async () => {
  const prev = config.auth.accessTtl;
  config.auth.accessTtl = 2;
  await cdp("Network.clearBrowserCookies");
  const token = session(managerId);
  await cdp("Network.setCookie", { name: "hgz_rt", value: token, url: `${base}/api/auth/`, path: "/api/auth", httpOnly: true });
  await go("/admin/assistant");
  await waitFor(`!!document.querySelector(".ai-chat")`, "страница");
  config.auth.accessTtl = prev;
  // Срок refresh-сессии истёк (записан, как пишет сервер, — ISO-строкой).
  run("UPDATE sessions SET expires_at=? WHERE user_id=?", new Date(Date.now() - 1000).toISOString(), managerId);
  // Токен действует до конца секунды exp включительно: ждём с запасом.
  await sleep(3600);
  const n = fake.requests.length;
  await ask("Расскажи про ШОВ");
  await waitFor(`${lastBot}?.querySelector(".ai-error")?.textContent.includes("Сессия истекла")`, "сообщение об истёкшей сессии");
  assert(fake.requests.length === n, "модель не вызывалась");
});

await check("витрина /ai: при AI_AGENT_PUBLIC=1 — чат и вкладка на телефоне; при 0 — «недоступен»", async () => {
  await cdp("Network.clearBrowserCookies");
  // Настройки витрины кешируются браузером на минуту — для проверки флага кеш выключаем.
  await cdp("Network.setCacheDisabled", { cacheDisabled: true });
  await viewport(375, 812, true);
  config.ai.agent.public = true;
  await go("/ai");
  await waitFor(`!!document.querySelector(".ai-chat.in-store")`, "чат на витрине");
  await waitFor(`document.querySelector(".ai-head .hint")?.textContent.includes("данные витрины")`, "уровень гостя");
  assert(await js(`[...document.querySelectorAll("a[href='/ai']")].length > 0`), "вкладка Habez AI");
  fake.mode = "cite";
  await ask("Какая прочность ШОВ?");
  await idle();
  assert(await js(`!document.querySelector(".ai-log").textContent.includes("вопрос сверки")`), "гостю — без вопросов сверки");
  assert(await noHorizontalScroll(), "горизонтальная прокрутка на телефоне");
  const composeVisible = await js(`(() => { const r = document.querySelector(".ai-compose").getBoundingClientRect(); const tab = document.querySelector(".tabbar")?.getBoundingClientRect(); return r.bottom <= innerHeight && (!tab || r.bottom <= tab.top + 1); })()`);
  assert(composeVisible, "поле ввода не перекрыто нижней панелью");
  await shot("mobile-375-07-store-ai");
  config.ai.agent.public = false;
  await go("/ai");
  await waitFor(`document.body.textContent.includes("Habez AI пока недоступен")`, "заглушка без флага");
  assert(await js(`[...document.querySelectorAll("a[href='/ai']")].length === 0`), "вкладка без флага");
  config.ai.agent.public = true;
});

await check("ошибок JavaScript на страницах нет", async () => {
  assert(!consoleErrors.length, consoleErrors.join(" | "));
});

// ── Итог ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\nИтог: ${results.length - failed.length} из ${results.length} · снимки: ${shots}`);
ws.close();
chrome.kill();
await app.close();
await fake.close();
if (!process.env.E2E_SHOTS && !failed.length) rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
