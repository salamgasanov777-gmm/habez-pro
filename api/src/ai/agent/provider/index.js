// Habez AI Agent: поставщик модели. Весь остальной код знает только этот
// интерфейс:
//
//   provider.name, provider.model, provider.capabilities
//   provider.generate({ system, messages, maxTokens, signal, hints }) → { text, stopReason, usage }
//   provider.stream(…)  → async-итератор { type: "text", text } … { type: "done", stopReason, usage }
//
// openrouter / anthropic — Messages API (Anthropic-совместимый вход
// OpenRouter — правило владельца для всех ботов). mock — без сети: тесты
// и проверка без ключа.
import { config } from "../../../config.js";
import { createMessagesProvider } from "./messages.js";
import { createMockProvider } from "./mock.js";

export function getProvider(overrides = {}) {
  const c = { ...config.ai.agent, ...overrides };
  if (c.provider === "mock") return createMockProvider();
  if (c.provider === "openrouter" || c.provider === "anthropic") {
    if (!c.apiKey) throw new Error("не задан ключ провайдера (OPENROUTER_API_KEY или ANTHROPIC_API_KEY)");
    return createMessagesProvider({
      name: c.provider,
      baseUrl: c.provider === "anthropic" && !overrides.baseUrl && c.baseUrl.includes("openrouter") ? "https://api.anthropic.com" : c.baseUrl,
      apiKey: c.apiKey, model: c.model, timeoutMs: c.timeoutMs, maxTokens: c.maxTokens,
    });
  }
  throw new Error(`неизвестный провайдер: ${c.provider}`);
}
