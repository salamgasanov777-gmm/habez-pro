// Habez AI: разбор чисел не вешает сервер (находка «NUMERIC PARSER DOS /
// long-digit-chain», 01.10.2026). NUM_UNIT на 2000 цифрах без единицы
// перебирал варианты кубически (10 с, на 4000 — 80 с), а очистка истории
// [ \t]*\[E#\] — квадратично на длинных пробелах. Оба разбирают то, что
// присылает посетитель: вопрос (до 2000 знаков), историю беседы (до 20
// реплик по 8000) и ответ модели.
//
// Здесь: каждый злонамеренный ввод разбирается быстро, а совпадения на
// обычном тексте — ровно те же, что у прежних выражений (они ниже как
// образец; на коротких строках они быстрые).
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { apiRoot, prepareAiDb } from "./helpers/ai-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-numeric-dos.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

const OLD_NUM_UNIT = /(\d+(?:[.,]\d+)?)\s*(?:–|-|—|…|\.\.\.)?\s*(\d+(?:[.,]\d+)?)?\s*(мпа|мм|см|кг\/м³|кг\/м3|кг\/м²|кг\/м2|г\/м²|г\/м2|мл\/м²|мл\/м2|л\/кг|кг|г|мл|л(?:итр(?:а|ов)?)?|мин(?:ут[аы]?)?|ч(?:ас(?:а|ов)?)?|сут(?:ок|ки)?|месяц(?:а|ев)?|мес|м²|м2|м|%|шт|циклов|°c|°)(?![а-яa-z])/giu;
const OLD_HISTORY_REF = /[ \t]*\[E\d+\]/g;

// Злонамеренные строки длиной n.
const BAD = {
  "цифры": (n) => "1".repeat(n),
  "цифры и слово": (n) => "1".repeat(n - 2) + " x",
  "дробь с длинным хвостом": (n) => "1." + "1".repeat(n - 2),
  "число и пробелы": (n) => "1" + " ".repeat(n - 1),
  "число, пробелы, тире, пробелы": (n) => "1" + " ".repeat(n / 2 - 1) + "-" + " ".repeat(n / 2 - 1),
  "цифры через пробел": (n) => "1 ".repeat(n / 2),
  "1,1,1…": (n) => "1,".repeat(n / 2),
  "1-1-1…": (n) => "1-".repeat(n / 2),
  "1.1.1…": (n) => "1.".repeat(n / 2),
  "1...1...": (n) => "1...".repeat(n / 4),
  "число и [E#] подряд": (n) => "1" + "[E1]".repeat(n / 4 - 1),
  "пробелы без [E#]": (n) => "a" + " ".repeat(n - 1),
};
const FAST_MS = 200;
const timed = (fn) => { const t = performance.now(); const out = fn(); return { ms: performance.now() - t, out }; };
const dump = (s, re) => [...s.matchAll(re)].map((m) => [m.index, m[0], m[1], m[2], m[3]]);

// Случайные строки из кусков, на которых NUM_UNIT что-то решает.
const ATOMS = ["0", "1", "2", "5", "9", "12", "1,5", "0.5", "25", ".", ",", "-", "–", "—", "…", "...", ":", " ", "  ", "\n", "\t",
  "мм", "мпа", "МПа", "кг", "г", "л", "литров", "мин", "ч", "часа", "сут", "суток", "мес", "месяц", "м", "м²", "м2", "кг/м³",
  "кг/м2", "г/м²", "мл/м2", "л/кг", "%", "шт", "циклов", "°", "°C", "x", "а", "на ", "[E1]", "[E", "]", "до ", "×", "("];
function* randomStrings(count, seed) {
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  for (let i = 0; i < count; i++) {
    let s = "";
    for (let j = 0, len = 1 + rnd(14); j < len; j++) s += ATOMS[rnd(ATOMS.length)];
    yield s;
  }
}

let NUM_UNIT, checkAnswer, HISTORY_REF, cleanHistory, specs, agent;

before(async () => {
  await prepareAiDb();
  ({ NUM_UNIT } = await import("../src/ai/agent/checks/text.js"));
  ({ checkAnswer } = await import("../src/ai/agent/runtime/context.js"));
  ({ HISTORY_REF, cleanHistory } = await import("../src/ai/agent/runtime/agent.js"));
  specs = await import("../src/ai/agent/retrieval/specs.js");
  agent = await import("../src/ai/agent/runtime/agent.js");
});

describe("NUM_UNIT: длинные цепочки разбираются быстро", () => {
  for (const [name, gen] of Object.entries(BAD)) {
    test(`${name}: 2000, 4000, 8000 знаков — меньше ${FAST_MS} мс`, () => {
      for (const n of [2000, 4000, 8000]) {
        const { ms } = timed(() => [...gen(n).matchAll(NUM_UNIT)]);
        assert.ok(ms < FAST_MS, `${name}, ${n} знаков: ${ms.toFixed(0)} мс`);
      }
    });
  }

  test("checkAnswer: вопрос 2000, история 20 × 8000 и ответ 8000 знаков — меньше 200 мс", () => {
    const evidence = [{ id: "E1", value: "1,4 МПа", property: "прочность сцепления" }];
    for (const [name, gen] of Object.entries(BAD)) {
      const historyText = Array.from({ length: 20 }, () => gen(8000)).join("\n");
      const { ms, out } = timed(() => checkAnswer(`${gen(8000)}\nОтвет 999 мм [E1].`, evidence, { question: gen(2000), historyText }));
      assert.ok(ms < FAST_MS, `${name}: ${ms.toFixed(0)} мс`);
      assert.ok(out.unsupported.includes("999 мм"), `${name}: проверка дошла до конца ответа`);
    }
  });
});

describe("NUM_UNIT: совпадения те же, что у прежнего выражения", () => {
  test("60 000 случайных строк: позиция, текст и все группы совпадают", () => {
    let withMatches = 0;
    for (const s of randomStrings(60000, 1)) {
      const old = dump(s, OLD_NUM_UNIT);
      if (old.length) withMatches++;
      assert.deepEqual(dump(s, NUM_UNIT), old, JSON.stringify(s));
    }
    assert.ok(withMatches > 15000, `строк с числами: ${withMatches}`);
  });

  test("обычные записи: диапазоны, дроби, пробелы, единицы", () => {
    for (const s of ["0,3 МПа", "120–130 мл/м²", "от 2 до 50 мм", "5 - 7 л", "1...2 ч", "25 кг/м³ 3 °C", "за 1 мешок 25 кг", "F50 циклов 50",
      "слой 2  –  3 мм", "4607012345678 шт", "1,5,2,5 мм", "1,23,5 мм", "5м23мм", "100%", "28 суток", "9,5 мм / 12,5 мм", "63 шт (9,5 мм)"]) {
      assert.deepEqual(dump(s, NUM_UNIT), dump(s, OLD_NUM_UNIT), s);
    }
  });
});

describe("Очистка истории [E#]", () => {
  test("10 реплик по 8000 пробелов — меньше 200 мс", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "a" + " ".repeat(7999) }));
    const { ms } = timed(() => cleanHistory(history, 1e9));
    assert.ok(ms < FAST_MS, `${ms.toFixed(0)} мс`);
  });

  test("замена та же, что у прежнего выражения", () => {
    for (const s of randomStrings(60000, 5)) assert.equal(s.replace(HISTORY_REF, ""), s.replace(OLD_HISTORY_REF, ""), JSON.stringify(s));
    assert.equal("ШОВ — 1,4 МПа [E1] [E2]\tи 5 мм\t[E3].".replace(HISTORY_REF, ""), "ШОВ — 1,4 МПа\tи 5 мм.");
  });
});

describe("retrieval/specs.js: числа в вопросе", () => {
  test("parseConditions, resolveSpecs, matchVariant, variantSizesIn — меньше 200 мс на 2000 знаков", () => {
    const variants = [{ unit: "мешок 25 кг", pack_size: 25, pack_unit: "кг" }, { unit: "мешок 5 кг", pack_size: 5, pack_unit: "кг" }];
    const prefixes = ["", "слой ", "при ", "толщина слоя ", "через ", "температура "];
    for (const [name, gen] of Object.entries(BAD)) for (const p of prefixes) {
      const q = (p + gen(2000)).slice(0, 2000);
      for (const [fn, run] of [["parseConditions", () => specs.parseConditions(q)], ["resolveSpecs", () => specs.resolveSpecs(q)],
        ["matchVariant", () => specs.matchVariant(q, variants)], ["variantSizesIn", () => specs.variantSizesIn(q)]]) {
        const { ms } = timed(run);
        assert.ok(ms < FAST_MS, `${fn}, «${p}» + ${name}: ${ms.toFixed(0)} мс`);
      }
    }
  });
});

describe("Весь путь запроса (вопрос → ответ модели → проверка)", () => {
  const saying = (text) => ({ name: "scripted", model: "scripted", capabilities: { streaming: true, tools: false, maxOutputTokens: 4000 },
    async* stream() { yield { type: "text", text }; yield { type: "done", stopReason: "end_turn", usage: {} }; } });

  // Запас на медленную машину: до исправления здесь были секунды и минуты.
  test("гость и сотрудник: злонамеренные история и ответ — меньше 1 с, ответ проверен", async () => {
    for (const scope of ["public", "staff"]) for (const [name, gen] of Object.entries(BAD)) {
      const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: gen(8000) }));
      const question = `Какая прочность у ШОВ? ${gen(1900)}`.slice(0, 2000);
      const t = performance.now();
      const r = await agent.runAgent({ tenantId: 1, scope, question, history, provider: saying(`${gen(8000)}\nОтвет 999 мм [E1].`) });
      const ms = performance.now() - t;
      assert.ok(ms < 1000, `${scope}, ${name}: ${ms.toFixed(0)} мс`);
      assert.ok(r.grounding.unsupported.includes("999 мм"), `${scope}, ${name}: ответ модели проверен`);
    }
  });
});
