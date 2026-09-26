// Поставщик без сети: для тестов и для проверки без ключа. Собирает ответ
// строго из переданных свойств (hints.properties), ничего не добавляя, —
// так тесты проверяют весь путь данных, не тратя денег на модель.
export function createMockProvider() {
  function compose({ hints }) {
    const props = hints?.properties || [];
    const lines = [];
    for (const n of hints?.unknown || []) lines.push(`Товара «${n}» в каталоге Habez нет, данных о нём тоже нет.`);
    for (const f of hints?.found || []) lines.push(`Подходит по данным каталога: ${f.name} [${f.ref}]`);
    for (const v of hints?.variants || []) lines.push(`${v.product}, фасовка: ${v.unit} [${v.ref}]`);
    for (const l of hints?.lines || []) lines.push(l);
    if (!props.length && !lines.length) return "В данных Habez по этому вопросу ничего не найдено.";
    for (const p of props) {
      const cond = p.conditionText ? ` (${p.conditionText})` : "";
      const vals = p.values.filter((v) => !v.hidden).map((v) => `${v.display} ${v.refs.map((r) => `[${r}]`).join("")}`);
      if (p.status === "conflict" || p.status === "unresolved") {
        lines.push(`Расхождение в данных — ${p.product}, ${p.label}${cond}: ${vals.join(" / ")}. Система не выбирает одно значение как окончательное.`);
      } else if (vals.length) {
        lines.push(`${p.product}, ${p.label}${cond}: ${vals.join(" / ")}`);
      }
    }
    return lines.join("\n");
  }
  async function* stream(args) {
    const text = compose(args);
    for (let i = 0; i < text.length; i += 40) yield { type: "text", text: text.slice(i, i + 40) };
    yield { type: "done", stopReason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
  }
  return {
    name: "mock", model: "mock", capabilities: { streaming: true, tools: false, maxOutputTokens: 4000 },
    stream, generate: async (args) => ({ text: compose(args), stopReason: "end_turn", usage: {} }),
  };
}
