// Phase 4.2: единая проверка ответа (checks/). Ожидания записаны прямо —
// «PASS» или «FAIL(коды ошибок)», не вычисляются той же логикой:
//   - матрица: у каждой проверки — верный ответ (не ошибка) и неверный
//     (ошибка), в том числе число из вопроса, из фасовки, из прошлой реплики,
//     цитата вопроса, имя конкурента, ссылка, отрицание;
//   - контракт: id, слой, коды, report; находки — только объявленных кодов;
//   - сохранённый вход: после JSON та же проверка, что во время ответа, —
//     и для верного, и для испорченного ответа; без модели, базы и сети.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { apiRoot, prepareAiDb, LEVEL_VALUES, SECRET_REF } from "./helpers/ai-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-answer-checks.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

const { runAnswerChecks } = await import("../src/ai/agent/checks/runner.js");
const { buildCheckInput } = await import("../src/ai/agent/checks/input.js");
const { recheck } = await import("../src/ai/agent/checks/recheck.js");
const { CHECKS } = await import("../src/ai/agent/checks/registry.js");
const { LAYERS } = await import("../src/ai/agent/checks/contract.js");

// Итог словами: PASS или FAIL(коды ошибок по алфавиту). Пометки (info) — отдельно.
const outcome = (r) => {
  const errors = [...new Set(r.findings.filter((f) => f.severity === "error").map((f) => f.code))].sort();
  return errors.length ? `FAIL(${errors.join(",")})` : "PASS";
};
const infos = (r) => [...new Set(r.findings.filter((f) => f.severity === "info").map((f) => f.code))].sort();
const seenCodes = new Map();
const run = (input) => {
  const r = runAnswerChecks(buildCheckInput(input));
  for (const f of r.findings) seenCodes.set(`${f.check}:${f.code}`, f);
  return r;
};

// Данные ответа — записи [E#] (как их собирает bundle.js).
const E = {
  strength: { id: "E1", kind: "observation", productName: "ШОВ", label: "Прочность на сжатие", value: "не менее 3,0 МПа", property: "Прочность на сжатие" },
  pack: { id: "E2", kind: "variant", productName: "ШОВ", label: "Фасовка", value: "мешок 25 кг", variant: "мешок 25 кг", perPallet: 40 },
  compPacks: { id: "E3", kind: "competitor_record", label: "Товар конкурента", value: "Шпаклёвка для швов «Т-Шов»", where: "фасовки: мешок 25 кг, мешок 5 кг" },
  price: { id: "E4", kind: "price", productName: "Т-Шов", label: "цена (розница, за мешок 25 кг)", value: "470,00 ₽", amountMinor: 47000, basis: "за мешок 25 кг", sourceName: "Синтетический прайс" },
  doc: { id: "E5", kind: "document", label: "Паспорт качества", value: "дата документа: 2026-09-05", sourceType: "quality_passport" },
};
const catalog = [
  { id: 1, slug: "shov", name: "Гипсовая шпаклёвка для заделки стыков «ШОВ»", short_name: "ШОВ" },
  { id: 2, slug: "finish", name: "Гипсовая шпаклёвка «ФИНИШ»", short_name: "ФИНИШ" },
  { id: 3, slug: "standart", name: "Штукатурка гипсовая «СТАНДАРТ»", short_name: "СТАНДАРТ" },
];
const registry = [
  { type: "company", id: 1, name: "ТестСмесь", names: ["ТестСмесь"] },
  { type: "product", id: 2, name: "Шпаклёвка для швов «Т-Шов»", names: ["Шпаклёвка для швов «Т-Шов»", "Т-Шов"] },
  { type: "product", id: 3, name: "Шпаклёвка «П-Финиш»", names: ["Шпаклёвка «П-Финиш»", "П-Финиш"] },
];
// Текст данных ответа — как его собирает bundle.js: строки записей [E#] и
// имена, о которых идёт речь (компания, товары конкурентов, пары аналогов).
const contextText = [...Object.values(E).map((e) => `[${e.id}] ${e.label}: ${e.value}`),
  "Компания: ТестСмесь; товары: «Т-Шов», «U-Шов», «П-Клей»; связь «U-Шов» — АКВАЛАЙТ"].join("\n");
const base = { evidence: Object.values(E), contextText, catalog, allowedProductIds: [1], maskNames: ["Шпаклёвка «П-Финиш»", "П-Финиш"] };
const competitor = (over = {}) => ({ competitor: { active: true, pairs: [], prices: [{ id: "E4", amountMinor: 47000 }], sourceText: "testsmes.example", registry, corpus: catalog.map((p) => p.name).join(" "), missingLabels: [], ...over } });

// [название, вход, ожидание, пометки (info)]
const MATRIX = {
  numbers: [
    ["число из источника со ссылкой", { answer: "Прочность ШОВ — не менее 3,0 МПа [E1]." }, "PASS"],
    ["выдуманное число со ссылкой", { answer: "Прочность ШОВ — 5 МПа [E1]." }, "FAIL(UNSUPPORTED_NUMBER)"],
    ["число другой записи (фасовка вместо прочности)", { answer: "Прочность ШОВ — 25 кг [E1]." }, "FAIL(MISMATCHED_NUMBER)"],
    ["число без ссылки, нигде не подтверждённое ссылкой", { answer: "Прочность ШОВ — 3,0 МПа." }, "FAIL(UNCITED_NUMBER)"],
    ["то же число повторено в итоге после строки со ссылкой", { answer: "Прочность — 3,0 МПа [E1].\nИтого: 3,0 МПа." }, "PASS"],
    ["F5: число из фасовок записи конкурента", { answer: "Т-Шов есть в мешках 5 кг [E3]." }, "PASS"],
    ["F5: фасовки, которой нет в записи", { answer: "Т-Шов есть в мешках 7 кг [E3]." }, "FAIL(UNSUPPORTED_NUMBER)"],
    ["число из вопроса опровергнуто", { question: "Правда, что прочность ШОВ 7 МПа?", answer: "Значения 7 МПа в данных нет." }, "PASS", ["ECHOED_NUMBER"]],
    ["число из вопроса подано как данные со ссылкой", { question: "Правда, что прочность ШОВ 7 МПа?", answer: "Да, прочность 7 МПа [E1]." }, "FAIL(UNSUPPORTED_NUMBER)"],
    ["число из прошлой реплики без ссылки — пометка", { historyText: "Прочность Т-Шов — 4,5 МПа.", answer: "Ранее говорилось о 4,5 МПа." }, "PASS", ["HISTORY_NUMBER"]],
    ["число из прошлой реплики со ссылкой — ошибка", { historyText: "Прочность Т-Шов — 4,5 МПа.", answer: "Прочность — 4,5 МПа [E1]." }, "FAIL(UNSUPPORTED_NUMBER)"],
    ["«на 1 кг» — единица расчёта, не значение", { answer: "Цена 470,00 ₽ за мешок 25 кг [E4], то есть на 1 кг меньше." }, "PASS"],
  ],
  citations: [
    ["ссылка на запись этого ответа", { answer: "Фасовка — мешок 25 кг [E2]." }, "PASS"],
    ["ссылка на номер, которого нет", { answer: "Фасовка — мешок 25 кг [E2][E9]." }, "FAIL(INVALID_CITATION)"],
  ],
  products: [
    ["наш товар из данных", { answer: "ШОВ подходит для швов [E1]." }, "PASS"],
    ["наш товар, которого нет в данных", { answer: "Для финишного слоя есть наш ФИНИШ." }, "FAIL(FOREIGN_PRODUCT)"],
    ["F7: товар конкурента «П-Финиш» — не наш «ФИНИШ»", { answer: "П-Финиш — товар конкурента." }, "PASS"],
    ["«стандарт» как обычное слово", { answer: "По стандарту ГОСТ прочность не менее 3,0 МПа [E1]." }, "PASS"],
  ],
  forbidden: [
    ["скрытое от роли значение", { forbidden: [{ value: "1,9 МПа", reference: "lab-protocol-77" }], answer: "Прочность по лаборатории — 1,9 МПа [E1]." }, "FAIL(FORBIDDEN_DATA,UNSUPPORTED_NUMBER)"],
    ["скрытый документ по номеру", { forbidden: [{ value: "1,9 МПа", reference: "lab-protocol-77" }], answer: "См. протокол lab-protocol-77." }, "FAIL(FORBIDDEN_DATA)"],
    ["то же число есть в доступных данных", { forbidden: [{ value: "3,0 МПа", reference: null }], answer: "Прочность — не менее 3,0 МПа [E1]." }, "PASS"],
  ],
  "empty-answer": [
    ["модель ответила", { answer: "Фасовка — мешок 25 кг [E2]." }, "PASS"],
    ["модель не вернула ни слова", { answer: "Модель не вернула ответ.", emptyAnswer: true }, "FAIL(EMPTY_ANSWER)"],
  ],
  dates: [
    ["дата из данных (в другом написании)", { answer: "Паспорт от 05.09.2026 [E5]." }, "PASS"],
    ["дата из вопроса", { question: "Есть документ от 01.02.2025?", answer: "Документа от 01.02.2025 в данных нет." }, "PASS"],
    ["выдуманная дата", { answer: "Паспорт от 01.02.2025 [E5]." }, "FAIL(UNSUPPORTED_DATE)"],
  ],
  "suitability-status": [
    ["«не предназначен» при отказе системы", { allowedProductIds: [1, 3], answer: "СТАНДАРТ для заделки швов не предназначен.", domains: { "suitability-status": { suitability: [{ short: "СТАНДАРТ", status: "NOT_SUPPORTED" }] } } }, "PASS"],
    ["«подходит» вопреки отказу системы", { allowedProductIds: [1, 3], answer: "СТАНДАРТ подходит для заделки швов.", domains: { "suitability-status": { suitability: [{ short: "СТАНДАРТ", status: "NOT_SUPPORTED" }] } } }, "FAIL(SUITABILITY_MISMATCH)"],
    ["«подходит» при подтверждении системы", { answer: "ШОВ подходит для заделки швов [E1].", domains: { "suitability-status": { suitability: [{ short: "ШОВ", status: "SUPPORTED" }] } } }, "PASS"],
  ],
  factory: [
    ["производство с оговоркой при косвенной связи", { answer: "По косвенным данным ШОВ производится на заводе Хабез.", domains: { factory: { relItems: [{ status: "INFERRED", short: "ШОВ" }], docTypesAvailable: [], hasFactory: true } } }, "PASS"],
    ["производство без оговорки при косвенной связи", { answer: "ШОВ производится на заводе Хабез.", domains: { factory: { relItems: [{ status: "INFERRED", short: "ШОВ" }], docTypesAvailable: [], hasFactory: true } } }, "FAIL(FACTORY_MISMATCH)"],
    ["документа нет — так и сказано", { answer: "Сертификата соответствия в данных нет.", domains: { factory: { relItems: [], docTypesAvailable: ["quality_passport"], hasFactory: true } } }, "PASS"],
    ["выдуманный документ", { answer: "На ШОВ есть сертификат соответствия.", domains: { factory: { relItems: [], docTypesAvailable: ["quality_passport"], hasFactory: true } } }, "FAIL(INVENTED_DOCUMENT)"],
  ],
  competitor: [
    ["F16: цитата вопроса — не вердикт", { question: "Сравни ШОВ с Т-Шовом и скажи, какой лучше.", answer: "Вы спрашиваете, что лучше: ШОВ или Т-Шов. Отвечу фактами.", domains: competitor() }, "PASS"],
    ["вердикт от себя", { question: "Сравни ШОВ с Т-Шовом", answer: "Т-Шов лучше.", domains: competitor() }, "FAIL(COMPETITOR_VERDICT)"],
    ["F14: строка о подтверждённой паре", { answer: "Связь «U-Шов» — АКВАЛАЙТ: подтверждено как аналог.", domains: competitor({ pairs: [{ names: ["u-шов"], ours: ["аквалайт"], status: "CONFIRMED", relation: "analog" }, { names: ["u-шов"], ours: ["шов"], status: "INFERRED", relation: null }] }) }, "PASS"],
    ["«аналог» при предположении", { answer: "U-Шов — аналог ШОВ.", domains: competitor({ pairs: [{ names: ["u-шов"], ours: ["шов"], status: "INFERRED", relation: null }] }) }, "FAIL(ANALOGY_OVERCLAIM)"],
    ["F15: позиция источника при противоречии", { allowedProductIds: [1, 3], answer: "Источник указывает П-Клей как аналог СТАНДАРТ.", domains: competitor({ pairs: [{ names: ["п-клей"], ours: ["стандарт"], status: "CONFLICTED", relation: null }] }) }, "PASS"],
    ["F8: метка статуса в кавычках — не компания", { answer: "Статус «Не аналог» подтверждён.", domains: competitor() }, "PASS"],
    ["цена из данных со ссылкой", { answer: "Т-Шов: 470,00 ₽ за мешок 25 кг [E4].", domains: competitor() }, "PASS"],
    ["F9: та же цена в итоговой фразе", { answer: "Т-Шов: 470,00 ₽ за мешок 25 кг [E4].\nЦена (470 ₽) приведена как есть.", domains: competitor() }, "PASS"],
    ["выдуманная цена", { answer: "Т-Шов стоит 999 ₽.", domains: competitor() }, "FAIL(INVENTED_PRICE)"],
    ["цена без ссылки", { answer: "Т-Шов стоит 470 ₽.", domains: competitor() }, "FAIL(UNCITED_PRICE)"],
    ["сайт из данных", { answer: "Сайт ТестСмеси — testsmes.example.", domains: competitor() }, "PASS"],
    ["выдуманный сайт", { answer: "Цены есть на fake-shop.ru.", domains: competitor() }, "FAIL(INVENTED_SOURCE)"],
    ["F2: имя из вопроса в отказе", { question: "Расскажи о ТестСмесь и её фирме «Гипс-Альфа».", answer: "По компании «Гипс-Альфа» в данных информации нет.", domains: competitor() }, "PASS"],
    ["F2: то же имя в утверждении", { question: "Расскажи о ТестСмесь и её фирме «Гипс-Альфа».", answer: "«Гипс-Альфа» выпускает шпаклёвки.", domains: competitor() }, "FAIL(INVENTED_ENTITY)"],
    ["F10: конкурент из прошлой реплики", { historyText: "Цены на «Т-Шов»: 470 ₽", answer: "Эту цену не сравниваю с ценами «Т-Шов».", contextText: "U-Шов", domains: competitor() }, "PASS"],
    ["конкурент не из данных и не из беседы", { answer: "Эту цену не сравниваю с ценами «Т-Шов».", contextText: "U-Шов", domains: competitor() }, "FAIL(INVENTED_ENTITY)"],
    ["F1: «1,0 МПа» — не «0 МПа»", { answer: "Прочность на изгиб: ШОВ — не менее 3,0 МПа [E1]; Т-Шов — нет данных.", domains: competitor({ missingLabels: ["Прочность на изгиб"] }) }, "PASS"],
    ["«нет данных» подано как ноль", { answer: "Прочность на изгиб: у Т-Шов хуже, чем у ШОВ.", domains: competitor({ missingLabels: ["Прочность на изгиб"] }) }, "FAIL(COMPETITOR_VERDICT,MISSING_AS_WORSE)"],
  ],
};

describe("матрица: у каждой проверки верный ответ проходит, неверный ловится", () => {
  for (const [check, rows] of Object.entries(MATRIX)) {
    for (const [name, input, want, wantInfo = []] of rows) {
      test(`${check}: ${name} → ${want}`, () => {
        const r = run({ ...base, ...input });
        assert.equal(outcome(r), want, JSON.stringify(r.findings));
        assert.deepEqual(infos(r), wantInfo);
        if (want !== "PASS") assert.ok(r.findings.some((f) => f.check === check && f.severity === "error"), `ошибку нашла именно проверка ${check}`);
      });
    }
  }
  test("в матрице у каждой проверки реестра есть и PASS, и FAIL", () => {
    for (const c of CHECKS) {
      const rows = MATRIX[c.id] || [];
      assert.ok(rows.some((x) => x[2] === "PASS") && rows.some((x) => x[2] !== "PASS"), c.id);
    }
  });
});

// F17 (найден и исправлен в 4.2): номер ссылки «[E4]» в тексте данных
// считался числом данных без единицы. Ожидания — прямо, обе стороны.
const { parseAnswer, facts } = await import("../src/ai/agent/checks/text.js");
describe("F17: номер ссылки [E#] — не число", () => {
  test("«[E4]» в ответе и в данных — не число", () => {
    assert.deepEqual(parseAnswer("См. [E4] и [E12], [E1]–[E4], [E2][E3].").whole, []);
    assert.ok(!facts("[E4] Цена: 470,00 ₽").all.has("4"));
  });
  const rows = [
    ["ссылки без чисел — не находки", { answer: "Фасовка — мешок 25 кг [E2][E4]." }, "PASS", []],
    ["[E10], диапазон [E1]–[E4] и ссылки подряд — не числа", { evidence: [...Object.values(E), { id: "E10", kind: "observation", label: "Цвет", value: "белый" }], answer: "Цвет белый [E10]; см. [E1]–[E4], [E2][E3][E4]." }, "PASS", []],
    ["число вплотную к ссылке «[E4]470,00 ₽ … 25 кг» — число остаётся", { answer: "Цена [E4]470,00 ₽ за мешок 25 кг." }, "PASS", []],
    ["«10 МПа» при записи [E10] — выдумано", { evidence: [...Object.values(E), { id: "E10", kind: "observation", label: "Цвет", value: "белый" }], contextText: `${contextText}\n[E10] Цвет: белый`, answer: "Прочность ШОВ — 10 МПа [E1]." }, "FAIL(UNSUPPORTED_NUMBER)", []],
    ["«4 МПа» со ссылкой, 4 есть только как номер [E4] — выдумано", { answer: "Прочность ШОВ — 4 МПа [E1]." }, "FAIL(UNSUPPORTED_NUMBER)", []],
    ["«4 МПа» без ссылки, 4 есть только как номер [E4] — выдумано", { answer: "Прочность ШОВ — 4 МПа." }, "FAIL(UNSUPPORTED_NUMBER)", []],
    ["число из вопроса = номер записи [E2], опровергнуто", { question: "Прочность ШОВ 2 МПа?", answer: "Значения 2 МПа в данных нет." }, "PASS", ["ECHOED_NUMBER"]],
    ["то же с числом, которое номером не бывает, — так же", { question: "Прочность ШОВ 9 МПа?", answer: "Значения 9 МПа в данных нет." }, "PASS", ["ECHOED_NUMBER"]],
    ["число из прошлой реплики = номер записи [E4]", { historyText: "Прочность Т-Шов — 4 МПа.", answer: "Ранее говорилось о 4 МПа." }, "PASS", ["HISTORY_NUMBER"]],
    ["число из вопроса = номер записи подано как данные", { question: "Прочность ШОВ 2 МПа?", answer: "Да, прочность ШОВ 2 МПа [E1]." }, "FAIL(UNSUPPORTED_NUMBER)", []],
    ["настоящее неподтверждённое число", { answer: "Прочность ШОВ — 7,7 МПа [E1]." }, "FAIL(UNSUPPORTED_NUMBER)", []],
    ["скрытое от роли «4 МПа» при записи [E4] — скрытое (номер его не «открывает»)", { forbidden: [{ value: "4 МПа", reference: null }], answer: "По лаборатории — 4 МПа." }, "FAIL(FORBIDDEN_DATA,UNSUPPORTED_NUMBER)", []],
  ];
  for (const [name, input, want, wantInfo] of rows) {
    test(`${name} → ${want}`, () => {
      const r = run({ ...base, ...input });
      assert.equal(outcome(r), want, JSON.stringify(r.findings));
      assert.deepEqual(infos(r), wantInfo);
    });
  }
});

// F18 (найден повторной проверкой ответов 3.5: S11 реплика 2, A3; исправлен
// в 4.2): число, которое есть в данных, повторённое без ссылки — из вопроса
// или в заголовке над записями со ссылками, — считалось «без ссылки».
describe("F18: повтор числа из вопроса или из записи, на которую есть ссылка", () => {
  // Данные без «25 кг»: только мешок 5 кг.
  const five = { evidence: [E.strength, { ...E.compPacks, where: "фасовки: мешок 5 кг" }], contextText: "[E1] Прочность на сжатие: не менее 3,0 МПа\n[E3] Товар конкурента: Шпаклёвка для швов «Т-Шов»; фасовки: мешок 5 кг", catalog, allowedProductIds: [1] };
  const rows = [
    ["A: «мешок 25 кг» из вопроса, повторено с отрицанием — пометка", { ...base, question: "Сколько стоит Т-Шов, если брать мешками по 25 кг?", answer: "Цены за мешок 25 кг в цену за килограмм не пересчитываются." }, "PASS", ["ECHOED_NUMBER"]],
    ["B: «за мешок 25 кг» — заголовок над ценой со ссылкой на запись с этой основой", { ...base, answer: "Розница, за мешок 25 кг:\n- 470,00 ₽ [E4]" }, "PASS"],
    ["B: значение процитировано со ссылкой", { ...base, answer: "Т-Шов: 470,00 ₽ за мешок 25 кг [E4]." }, "PASS"],
    ["C1: в строке ссылка на запись без 25 кг, 25 кг — в другой записи", { ...base, answer: "Прочность ШОВ: 25 кг [E1]." }, "FAIL(MISMATCHED_NUMBER)"],
    ["C2: 25 кг из записи о цене Т-Шов, на которую ответ ссылается по другому поводу", { ...base, answer: "Цена Т-Шов — 470,00 ₽ [E4].\nШОВ фасуется по 25 кг." }, "FAIL(UNCITED_NUMBER)"],
    ["C3: заголовок с 25 кг над строкой со ссылкой на запись без 25 кг (25 кг есть в других записях)", { ...base, answer: "Мешок 25 кг:\n- прочность не менее 3,0 МПа [E1]" }, "FAIL(UNCITED_NUMBER)"],
    ["D1: 25 кг из вопроса и есть в данных, но утверждается без ссылки", { ...base, question: "Есть ли ШОВ в мешках по 25 кг?", answer: "ШОВ фасуется по 25 кг." }, "FAIL(UNCITED_NUMBER)"],
    ["D2: 25 кг в прошлой реплике и в данных, утверждается без ссылки", { ...base, historyText: "Т-Шов продаётся по 25 кг.", answer: "ШОВ — мешок 25 кг." }, "FAIL(UNCITED_NUMBER)"],
    ["«25 кг» есть в данных, но ответ ни на что не ссылается и в вопросе нет", { ...base, answer: "ШОВ фасуется в мешки по 25 кг." }, "FAIL(UNCITED_NUMBER)"],
    ["«25 кг» со ссылкой на запись без 25 кг (в данных только 5 кг)", { ...five, answer: "Т-Шов продаётся в мешках 25 кг [E3]." }, "FAIL(UNSUPPORTED_NUMBER)"],
    ["«25 кг» без ссылки, в данных только 5 кг", { ...five, answer: "Т-Шов продаётся в мешках 25 кг." }, "FAIL(UNSUPPORTED_NUMBER)"],
    ["заголовок над нерелевантной записью: «25 кг», а запись со ссылкой — про 5 кг", { ...five, answer: "Мешок 25 кг:\n- фасовка [E3]" }, "FAIL(UNSUPPORTED_NUMBER)"],
  ];
  for (const [name, input, want, wantInfo = []] of rows) {
    test(`${name} → ${want}`, () => {
      const r = run(input);
      assert.equal(outcome(r), want, JSON.stringify(r.findings));
      assert.deepEqual(infos(r), wantInfo);
    });
  }
});

describe("контракт проверки", () => {
  test("у каждой проверки: id, слой, коды с важностью, run и report; id не повторяются", () => {
    for (const c of CHECKS) {
      assert.equal(typeof c.id, "string");
      assert.ok(LAYERS.includes(c.layer), `${c.id}: слой ${c.layer}`);
      assert.ok(Object.keys(c.codes).length > 0 && Object.values(c.codes).every((s) => ["error", "info"].includes(s)), c.id);
      assert.equal(typeof c.run, "function");
      assert.equal(typeof c.report, "function");
      for (const m of ["collect", "applies"]) assert.ok(c[m] === undefined || typeof c[m] === "function", `${c.id}.${m}`);
    }
    assert.equal(new Set(CHECKS.map((c) => c.id)).size, CHECKS.length);
    // Каждый слой представлен: общие, доменные, политика.
    for (const layer of LAYERS) assert.ok(CHECKS.some((c) => c.layer === layer), layer);
  });
  test("находки — только объявленных кодов своей проверки, с важностью из объявления", () => {
    // Каждый объявленный код хоть раз получен в матрице.
    for (const c of CHECKS) for (const code of Object.keys(c.codes)) assert.ok(seenCodes.has(`${c.id}:${code}`), `${c.id}:${code} не встречается в матрице`);
    for (const [, f] of seenCodes) {
      const c = CHECKS.find((x) => x.id === f.check);
      assert.ok(c.codes[f.code], `${f.check}: ${f.code} не объявлен`);
      assert.equal(f.severity, c.codes[f.code]);
      assert.equal(f.layer, c.layer);
    }
  });
  test("готовый ответ сервера не проверяется: находок нет, поля пустые", () => {
    const r = run({ ...base, answer: "Прочность 99 МПа [E9].", fixed: true });
    assert.deepEqual([outcome(r), r.findings, r.citations], ["PASS", [], []]);
    assert.deepEqual(r.grounding, { grounded: true, unsupported: [], mismatched: [], uncited: [], echoed: [], invalidCitations: [], forbidden: 0, foreignProducts: [], fromHistory: [],
      statusMismatch: [], emptyAnswer: false, factoryMismatch: [], inventedDocuments: [], unsupportedDates: [] });
  });
  test("доменная проверка не о своём ответе — ни находок, ни своих полей", () => {
    const r = run({ ...base, answer: "Т-Шов лучше.", domains: { competitor: { active: false } } });
    assert.equal(outcome(r), "PASS");
    assert.ok(!("competitor" in r.grounding) && !r.results.some((x) => x.id === "competitor"));
  });
  test("проверка не меняет вход и не зависит от порядка запусков", () => {
    const input = buildCheckInput({ ...base, answer: "Прочность 5 МПа [E1].", domains: competitor() });
    const before = JSON.stringify(input);
    const a = runAnswerChecks(input);
    runAnswerChecks({ ...input, answer: "Другой ответ без чисел." });
    const b = runAnswerChecks(input);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(a.grounding, b.grounding);
    assert.deepEqual(a.findings, b.findings);
  });
  test("находка числа — со строкой ответа", () => {
    const r = run({ ...base, answer: "Фасовка — мешок 25 кг [E2].\nПрочность — 5 МПа [E1]." });
    assert.deepEqual(r.findings.map((f) => [f.code, f.text, f.line]), [["UNSUPPORTED_NUMBER", "5 МПа", 2]]);
  });
});

// Повторная проверка: модули без базы, модели и сети.
const IMPORT = /(?:from|import)\s*\(?\s*"([^"]+)"/g;
function graph(entry) {
  const seen = new Set();
  const external = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (m[1].startsWith(".")) { const f = resolve(dirname(file), m[1]); if (existsSync(f)) walk(f); } else external.add(m[1]);
    }
  };
  walk(entry);
  return { files: [...seen].map((f) => f.slice(apiRoot.length + 1)), external: [...external] };
}

describe("повторная проверка сохранённого ответа", () => {
  for (const entry of ["src/ai/agent/checks/recheck.js", "src/ai/agent/eval/recheck.js"]) {
    test(`${entry}: не тянет базу, модель, инструменты, сеть`, () => {
      const g = graph(resolve(apiRoot, entry));
      for (const f of g.files) assert.ok(!/\/db\/|config\.js$|\/provider\/|\/tools\/|agent\.js$|routes\.js$/.test(f), f);
      for (const x of g.external) assert.ok(!/^(node:)?(http|https|net|dns|child_process|sqlite)$|undici|openai|anthropic/.test(x), x);
      assert.ok(!g.files.some((f) => readFileSync(resolve(apiRoot, f), "utf8").includes("fetch(")), "fetch");
    });
  }

  test("старая версия входа не принимается молча", () => {
    assert.throws(() => recheck({ version: 0, answer: "x" }), /версия/);
  });

  // Ответы ассистента на тестовой базе (подставная модель): вход проверки
  // сохраняется (JSON) и проверяется снова — итог тот же, что во время ответа.
  // Испорченный ответ — ошибка, и та же, что дала бы проверка во время ответа.
  describe("на ответах ассистента (тестовая база)", async () => {
    await prepareAiDb();
    await (await import("./helpers/competitor-fixture.js")).seedCompetitors();
    const { runAgent } = await import("../src/ai/agent/runtime/agent.js");
    const { get } = await import("../src/db/index.js");
    const mock = (await import("../src/ai/agent/provider/mock.js")).createMockProvider();
    const saying = (text) => ({ name: "scripted", model: "scripted", capabilities: { streaming: true, tools: false, maxOutputTokens: 4000 },
      async* stream() { yield { type: "text", text }; yield { type: "done", stopReason: "end_turn", usage: {} }; } });
    const ask = (question, scope = "staff", provider = mock, history = []) => runAgent({ tenantId: 1, scope, question, history, provider });
    const saved = (r) => JSON.parse(JSON.stringify(r.checkInput));

    // [вопрос, роль, порча ответа, ожидаемый код ошибки]
    const CASES = [
      ["Какая прочность ШОВ?", "staff", (a) => `${a}\nПрочность — 99 МПа [E1].`, "UNSUPPORTED_NUMBER"],
      ["Какая прочность ШОВ?", "public", (a) => `${a}\nСм. [E999].`, "INVALID_CITATION"],
      ["Какая прочность ШОВ?", "staff", (a) => `${a}\nПо лаборатории — ${LEVEL_VALUES.confidential}, протокол ${SECRET_REF}.`, "FORBIDDEN_DATA"],
      ["Сравни ШОВ с Т-Шовом", "staff", (a) => `${a}\nТ-Шов лучше и надёжнее.`, "COMPETITOR_VERDICT"],
      ["Сколько стоит Т-Шов?", "staff", (a) => `${a}\nУ дилера — 999 ₽.`, "INVENTED_PRICE"],
      ["Что известно о компании ТестСмесь?", "staff", (a) => `${a}\nПодробнее на fake-shop.ru.`, "INVENTED_SOURCE"],
      ["Какие документы есть у ШОВ?", "staff", (a) => `${a}\nЕсть также протокол испытаний.`, "INVENTED_DOCUMENT"],
      ["Где производится ШОВ?", "staff", (a) => `${a}\nДокумент от 01.02.2031.`, "UNSUPPORTED_DATE"],
      ["Какая прочность ШОВ?", "staff", (a) => `${a}\nДля финиша есть наш ФОРА.`, "FOREIGN_PRODUCT"],
      ["Сравни ШОВ и СТАНДАРТ для заделки швов ГКЛ", "staff", (a) => `${a}\nСТАНДАРТ подходит для заделки швов ГКЛ.`, "SUITABILITY_MISMATCH"],
      ["U-Шов идентичен ШОВ?", "staff", (a) => `${a}\nДа, U-Шов полностью идентичен ШОВ.`, "ANALOGY_OVERCLAIM"],
      ["Что известно о компании ТестСмесь?", "staff", (a) => `${a}\nЕё дочерняя фирма — «Мега-Смесь».`, "INVENTED_ENTITY"],
      ["Сравни ШОВ с Т-Шовом", "staff", (a) => `${a}\nПрочность на изгиб у Т-Шов равна нулю.`, "MISSING_AS_WORSE"],
    ];
    for (const [q, scope, spoil, code] of CASES) {
      test(`${scope}: «${q}» — сохранённый вход проверяется так же; порча → ${code}`, async () => {
        const before = get("SELECT total_changes() AS n").n;
        const r = await ask(q, scope);
        const s = saved(r);
        assert.equal(s.fixed, false, "ответ дала модель — его проверяют");
        const again = recheck(s);
        assert.deepEqual(again.grounding, r.grounding, "итог после сохранения — как во время ответа");
        assert.deepEqual(again.findings, r.verdict.findings);
        assert.equal(again.passed, r.verdict.passed);
        assert.deepEqual(again.citations.map((e) => e.id), r.citations.filter((c) => s.answer.includes(`[${c.id}]`)).map((c) => c.id));
        // Порча: ошибка ловится и совпадает с проверкой во время ответа.
        const bad = spoil(r.answer);
        const re = recheck(s, { answer: bad });
        assert.ok(re.findings.some((f) => f.code === code && f.severity === "error"), `${code}: ${JSON.stringify(re.findings)}`);
        assert.equal(re.passed, false);
        const live = await ask(q, scope, saying(bad));
        assert.deepEqual(re.grounding, live.grounding, "повторная проверка = проверка во время ответа");
        assert.equal(get("SELECT total_changes() AS n").n, before, "ничего не записано");
      });
    }

    test("администратору тот же «скрытый» ответ — не нарушение (видит по роли)", async () => {
      const r = await ask("Какая прочность ШОВ?", "admin");
      const re = recheck(saved(r), { answer: `${r.answer}\nПо лаборатории — ${LEVEL_VALUES.confidential}.` });
      assert.ok(!re.findings.some((f) => f.code === "FORBIDDEN_DATA"));
    });

    test("беседа: число из прошлого ответа — пометка, не ошибка", async () => {
      const r = await ask("Какая прочность ШОВ?", "staff", mock, [{ role: "user", content: "А у Т-Шов?" }, { role: "assistant", content: "У Т-Шов — 4,5 МПа." }]);
      const re = recheck(saved(r), { answer: "Ранее упоминалось 4,5 МПа." });
      assert.deepEqual([re.passed, re.findings.map((f) => f.code)], [true, ["HISTORY_NUMBER"]]);
    });

    test("готовый ответ сервера (уточнение) сохраняется как fixed и не проверяется", async () => {
      const r = await ask("Сравни", "staff");
      const s = saved(r);
      assert.equal(s.fixed, true);
      assert.equal(recheck(s, { answer: "Прочность 99 МПа." }).passed, true);
    });
  });
});
