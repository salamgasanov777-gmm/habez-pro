// Поддельный Messages API (как у OpenRouter) для тестов: без сети и без
// денег. Отвечает потоком SSE, записывает каждый запрос (что получила
// «модель»: системная подсказка, история, контекст с [E#]) и замечает,
// оборвал ли сервер Habez запрос (кнопка «Стоп»).
//
// Режимы (fake.mode):
//   cite     — строки характеристик из контекста как есть, со ссылками;
//   slow     — то же, но медленно, кусками по 120 мс (для «Стоп»);
//   long     — длинный ответ из многих разделов (обрезан по длине);
//   invent   — выдуманное число, чужая ссылка и число без ссылки;
//   leak     — значение fake.leak со ссылкой (попытка раскрыть скрытое);
//   history  — пересказывает, какую историю беседы получил;
//   error402 / error429 / error500 — ошибка провайдера;
//   tool     — сначала вызывает инструмент fake.toolCall (по умолчанию
//              get_product_specs СТАНДАРТ «прочность сцепления»), потом
//              отвечает строками из результата;
//   tool-loop — каждый ход вызывает один и тот же инструмент (проверка
//              защиты от повторов и лимита); при tool_choice none отвечает.
import { createServer } from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastUser(body) {
  const u = [...(body.messages || [])].reverse().find((m) => m.role === "user");
  return typeof u?.content === "string" ? u.content : "";
}

function citeLines(context) {
  const props = context.split("\n").filter((l) => /^- .*\[E\d+\]/.test(l)).map((l) => l.replace(/ — (одно значение|источники согласны|РАСХОЖДЕНИЕ|НЕРЕШЁННЫЙ).*$/, ""));
  const vars = context.split("\n").filter((l) => /^\s+\[E\d+\] /.test(l)).map((l) => {
    const m = l.match(/\[(E\d+)\] ([^;(]+)/);
    return `- Фасовка: ${m[2].trim()} [${m[1]}]`;
  });
  const cards = context.split("\n").filter((l) => /^\[E\d+\] /.test(l)).map((l) => {
    const m = l.match(/^\[(E\d+)\] ([^:]{1,60})/);
    return `- ${m[2].trim()} [${m[1]}]`;
  });
  return [...vars, ...props, ...cards].slice(0, 14);
}

// Текст всех результатов инструментов в беседе.
function toolResults(body) {
  return (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "tool_result").map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content))).join("\n");
}

function compose(mode, body, fake) {
  const content = lastUser(body);
  const context = (body.messages?.[body.messages.length - 1]?.role === "user" && Array.isArray(body.messages.at(-1).content))
    ? (body.messages.find((m) => typeof m.content === "string" && m.content.startsWith("ДАННЫЕ HABEZ"))?.content || "").split("\nВОПРОС:")[0]
    : content.split("\nВОПРОС:")[0];
  if (mode === "tool" || mode === "tool-loop") {
    const extra = toolResults(body);
    const lines = citeLines(`${extra}\n${context}`);
    return lines.length ? lines.join("\n") : "В данных Habez этого нет.";
  }
  if (mode === "invent") return "- Прочность на сжатие: 9,9 МПа [E1]\n- Подробнее — [E999]\nВремя схватывания — 777 мин.";
  if (mode === "leak") return `- Прочность на изгиб: ${fake.leak} [E1]`;
  if (mode === "history") {
    const hist = (body.messages || []).slice(0, -1);
    const firstUser = hist.find((m) => m.role === "user")?.content || "—";
    return `История: ${hist.length} реплик. Начало беседы: «${firstUser.slice(0, 40)}».`;
  }
  const lines = citeLines(context);
  if (!lines.length) return "В данных Habez этого нет.";
  if (mode === "long") {
    const out = [];
    for (let i = 1; i <= 12; i += 1) out.push(`## Раздел ${i}`, ...lines);
    return out.join("\n");
  }
  if (mode === "slow") return Array.from({ length: 6 }, () => lines.join("\n")).join("\n");
  return lines.join("\n");
}

export async function startFakeLlm() {
  const fake = { mode: "cite", leak: null, requests: [] };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/v1/messages")) { res.writeHead(404).end(); return; }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const mode = fake.mode;
    const rec = { at: Date.now(), headers: req.headers, body, mode, aborted: false, finished: false, chunks: 0 };
    fake.requests.push(rec);
    res.on("close", () => { if (!rec.finished) rec.aborted = true; });
    const fail = { error402: 402, error429: 429, error500: 500 }[mode];
    if (fail) {
      rec.finished = true;
      res.writeHead(fail, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `fake failure ${fail}` } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", { message: { usage: { input_tokens: Math.round(raw.length / 4) } } });
    // Вызов инструмента: первый ход (tool) или каждый ход (tool-loop), пока
    // сервер не запретит вызовы (tool_choice none).
    const hadResult = toolResults(body).length > 0;
    const wantTool = body.tools?.length && body.tool_choice?.type !== "none" && (mode === "tool-loop" || (mode === "tool" && !hadResult));
    if (wantTool) {
      const call = fake.toolCall || { name: "get_product_specs", input: { product: "СТАНДАРТ", specs: ["прочность сцепления"] } };
      rec.toolUse = call;
      send("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${fake.requests.length}`, name: call.name, input: {} } });
      send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } });
      send("message_stop", {});
      rec.finished = true;
      res.end();
      return;
    }
    const text = compose(mode, body, fake);
    // Медленная модель и думает перед первым словом (для проверки подписи
    // «Проверяю источники…» в интерфейсе).
    if (mode === "slow") await sleep(700);
    for (let i = 0; i < text.length; i += 30) {
      if (res.destroyed || rec.aborted) return;
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + 30) } });
      rec.chunks += 1;
      if (mode === "slow") await sleep(120);
    }
    if (res.destroyed || rec.aborted) return;
    send("message_delta", { delta: { stop_reason: mode === "long" ? "max_tokens" : "end_turn" }, usage: { output_tokens: Math.round(text.length / 4) } });
    send("message_stop", {});
    rec.finished = true;
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.last = () => fake.requests[fake.requests.length - 1];
  fake.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return fake;
}
