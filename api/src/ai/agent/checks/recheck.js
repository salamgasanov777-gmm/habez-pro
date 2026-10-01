// Habez AI (Phase 4.2): повторная проверка сохранённого ответа — по
// сохранённому входу (input.js), без модели, без базы, без сети. Ответ не
// пересоздаётся; можно подставить другой (answer) — например, испорченный,
// чтобы убедиться, что проверка ошибку ловит.
import { runAnswerChecks } from "./runner.js";
import { CHECK_INPUT_VERSION } from "./input.js";

export function recheck(saved, { answer } = {}) {
  if (!saved || saved.version !== CHECK_INPUT_VERSION) throw new Error(`вход проверки: версия ${saved?.version ?? "нет"}, нужна ${CHECK_INPUT_VERSION}`);
  return runAnswerChecks(answer === undefined ? saved : { ...saved, answer: String(answer) });
}
