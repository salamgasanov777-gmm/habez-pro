// Messages API (POST /v1/messages) через fetch с потоковой выдачей (SSE).
// Без SDK: правило проекта — без новых зависимостей. Ключ передаётся только
// в заголовке запроса и никуда не пишется.
//
// События потока: message_start, content_block_start, content_block_delta
// (text_delta — текст ответа; input_json_delta — аргументы вызова
// инструмента; остальные дельты, например thinking, не показываются),
// content_block_stop, message_delta (stop_reason, usage), message_stop,
// error, ping.
//
// Инструменты (Phase 3.2): tools передаются как есть (Anthropic Messages
// API, так же принимает OpenRouter). Законченный вызов отдаётся событием
// { type: "tool_use", id, name, input }; в «done» — content: все блоки
// ответа (текст и вызовы), чтобы следующий ход беседы их повторил.

export function parseSseChunk(buffer) {
  // Возвращает { events, rest }: полные события и хвост без конца.
  const events = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop();
  for (const part of parts) {
    let event = "message";
    const data = [];
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    try { events.push({ event, data: JSON.parse(data.join("\n")) }); } catch { /* неполный JSON — пропускаем */ }
  }
  return { events, rest };
}

export function createMessagesProvider({ name, baseUrl, apiKey, model, timeoutMs = 90000, maxTokens: maxOut = 4000, fetchImpl = globalThis.fetch }) {
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": apiKey,
    // OpenRouter принимает ключ и так, и в Authorization.
    ...(name === "openrouter" ? { authorization: `Bearer ${apiKey}` } : {}),
  };

  async function* stream({ system, messages, maxTokens = 4000, signal, tools, toolChoice }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("превышено время ожидания модели")), timeoutMs);
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: "POST", headers, signal: ctrl.signal,
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, stream: true,
          ...(tools?.length ? { tools, ...(toolChoice ? { tool_choice: { type: toolChoice } } : {}) } : {}) }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        let msg = body.slice(0, 300);
        try { msg = JSON.parse(body)?.error?.message || msg; } catch { /* текст как есть */ }
        const err = new Error(`провайдер ответил ${res.status}: ${msg}`);
        err.status = res.status;
        throw err;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let stopReason = null;
      let usage = {};
      const blocks = []; // блоки ответа по индексу: { type: "text", text } | { type: "tool_use", id, name, json }
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buf);
        buf = rest;
        for (const { event, data } of events) {
          // «Стоп» между кусками одного сетевого пакета: дальше не отдаём.
          if (ctrl.signal.aborted) throw ctrl.signal.reason ?? new Error("остановлено");
          const type = data.type || event;
          if (type === "content_block_start") {
            const b = data.content_block || {};
            blocks[data.index ?? blocks.length] = b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, json: "" } : { type: "text", text: "" };
          } else if (type === "content_block_delta" && data.delta?.type === "text_delta") {
            const b = blocks[data.index ?? 0] ??= { type: "text", text: "" };
            if (b.type === "text") b.text += data.delta.text;
            yield { type: "text", text: data.delta.text };
          } else if (type === "content_block_delta" && data.delta?.type === "input_json_delta") {
            const b = blocks[data.index ?? 0];
            if (b?.type === "tool_use") b.json += data.delta.partial_json || "";
          } else if (type === "content_block_stop") {
            const b = blocks[data.index ?? 0];
            if (b?.type === "tool_use") {
              let input = {};
              try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = { _invalid: true }; }
              b.input = input;
              yield { type: "tool_use", id: b.id, name: b.name, input };
            }
          }
          else if (type === "message_start") usage = { ...usage, ...(data.message?.usage || {}) };
          else if (type === "message_delta") { stopReason = data.delta?.stop_reason ?? stopReason; usage = { ...usage, ...(data.usage || {}) }; }
          else if (type === "error") throw new Error(`ошибка провайдера: ${data.error?.message || "неизвестная"}`);
        }
      }
      const content = blocks.filter(Boolean).map((b) => (b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} } : { type: "text", text: b.text })).filter((b) => b.type !== "text" || b.text);
      yield { type: "done", stopReason, usage, content };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function generate(args) {
    let text = "";
    let last = null;
    for await (const ev of stream(args)) {
      if (ev.type === "text") text += ev.text;
      else last = ev;
    }
    return { text, stopReason: last?.stopReason ?? null, usage: last?.usage ?? {} };
  }

  return { name, model, capabilities: { streaming: true, tools: true, maxOutputTokens: maxOut }, stream, generate };
}
