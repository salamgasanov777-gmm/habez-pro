// Разбор характеристик из карточек товара: «не менее 0,5 МПа», «3–70 мм»,
// «от +5°C до +30°C», «2 часа», «ДА». На выходе — то, что можно сравнивать
// числами, и обязательно исходная строка: она остаётся главной для человека.
//
// Правило, которое здесь важнее краткости: **не переводим между разными
// физическими величинами**. Миллилитры на м² не становятся килограммами на м²
// (плотность у каждого состава своя), граммы в литры — тоже. Переводим только
// внутри одной величины: г→кг, мл→л, см и м→мм, часы→минуты.

// Каноническая единица и множитель к ней. Ключ — как пишут в карточке.
const UNITS = {
  // масса
  "кг": { unit: "kg", k: 1 }, "г": { unit: "kg", k: 0.001 }, "kg": { unit: "kg", k: 1 },
  // объём
  "л": { unit: "l", k: 1 }, "мл": { unit: "l", k: 0.001 }, "l": { unit: "l", k: 1 },
  "литр": { unit: "l", k: 1 }, "литра": { unit: "l", k: 1 }, "литров": { unit: "l", k: 1 },
  // длина: канон — миллиметры, в них задают толщину слоя
  "мм": { unit: "mm", k: 1 }, "см": { unit: "mm", k: 10 }, "м": { unit: "mm", k: 1000 },
  // давление и прочность
  "мпа": { unit: "MPa", k: 1 }, "mpa": { unit: "MPa", k: 1 },
  "кгс/см²": { unit: "MPa", k: 0.0980665 },
  // расход: масса и объём на площадь — величины разные, каноны тоже разные
  "кг/м²": { unit: "kg/m2", k: 1 }, "г/м²": { unit: "kg/m2", k: 0.001 },
  "л/м²": { unit: "l/m2", k: 1 }, "мл/м²": { unit: "l/m2", k: 0.001 },
  // вода на смесь
  "л/кг": { unit: "l/kg", k: 1 },
  // время: канон — минуты; месяцы и годы в минуты не переводим
  "мин": { unit: "min", k: 1 }, "минут": { unit: "min", k: 1 }, "минуты": { unit: "min", k: 1 },
  "ч": { unit: "min", k: 60 }, "час": { unit: "min", k: 60 }, "часа": { unit: "min", k: 60 },
  "часов": { unit: "min", k: 60 }, "часы": { unit: "min", k: 60 },
  "сут": { unit: "min", k: 1440 }, "суток": { unit: "min", k: 1440 },
  "месяц": { unit: "month", k: 1 }, "месяца": { unit: "month", k: 1 }, "месяцев": { unit: "month", k: 1 },
  "год": { unit: "month", k: 12 }, "года": { unit: "month", k: 12 }, "лет": { unit: "month", k: 12 },
  // прочее
  "°c": { unit: "°C", k: 1 }, "°с": { unit: "°C", k: 1 }, "°": { unit: "°C", k: 1 },
  "%": { unit: "%", k: 1 },
  "циклов": { unit: "cycles", k: 1 }, "цикл": { unit: "cycles", k: 1 }, "циклы": { unit: "cycles", k: 1 },
  "шт": { unit: "pcs", k: 1 }, "штук": { unit: "pcs", k: 1 },
  "м²": { unit: "m2", k: 1 }, "м2": { unit: "m2", k: 1 },
  "кг/м³": { unit: "kg/m3", k: 1 },
};

// Человеческие подписи канонических единиц — для панели.
export const UNIT_LABEL = {
  kg: "кг", l: "л", mm: "мм", MPa: "МПа", "kg/m2": "кг/м²", "l/m2": "л/м²",
  "l/kg": "л/кг", min: "мин", month: "мес.", "°C": "°C", "%": "%",
  cycles: "циклов", pcs: "шт", m2: "м²", "kg/m3": "кг/м³",
};

// «да / нет / возможно» — тоже характеристика, только логическая.
const YES = ["да", "есть", "возможно", "подходит", "да."];
const NO = ["нет", "не подходит", "нет."];

const NUM = "[-+]?\\d+(?:[.,]\\d+)?";
const clean = (s) => String(s ?? "").replace(/ /g, " ").trim();
const toNum = (s) => Number(String(s).replace(",", ".").replace("+", ""));

// Единица измерения ищется с конца строки: «0,3 МПа», «120–130 мл/м²».
function findUnit(text) {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  // Составные («л/1 кг смеси», «л/кг смеси») приводим к простому виду.
  const compact = t
    .replace(/л\s*\/\s*1?\s*кг[^,;]*/g, "л/кг")
    .replace(/\s*\/\s*/g, "/")
    .replace(/м\s*2\b/g, "м²")
    .replace(/м\s*3\b/g, "м³");
  const keys = Object.keys(UNITS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`(?:^|[\\s\\d)])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[\\s.,;)(/])`, "i");
    if (re.test(compact + " ")) return { raw: k, ...UNITS[k] };
  }
  return null;
}

/**
 * Разбирает значение характеристики.
 * Возвращает: { displayValue, valueNum, valueMin, valueMax, valueBool, valueText,
 *               unitRaw, normalizedUnit, comparator, parsed, note }
 * comparator: exact | min | max | range | approx
 * parsed=false — значение осталось текстом: оно сохраняется как есть, и
 * ни одно число из него не выдумывается.
 */
export function parseSpecValue(raw) {
  const displayValue = clean(raw);
  const base = {
    displayValue, valueNum: null, valueMin: null, valueMax: null, valueBool: null,
    valueText: null, unitRaw: null, normalizedUnit: null, comparator: null,
    parsed: false, note: null,
  };
  if (!displayValue) return { ...base, note: "пустое значение" };

  const low = displayValue.toLowerCase().replace(/ /g, " ").trim();

  // 1. Логические значения из таблиц «Область применения» и «Тип основания».
  if (YES.includes(low)) return { ...base, valueBool: true, comparator: "exact", parsed: true };
  if (NO.includes(low)) return { ...base, valueBool: false, comparator: "exact", parsed: true };

  // 2. Марка морозостойкости: F50 — это 50 циклов, а не «текст F50».
  const frost = low.match(/^f\s*(\d+)$/);
  if (frost) {
    return { ...base, valueNum: Number(frost[1]), normalizedUnit: "cycles", comparator: "min", parsed: true };
  }

  // 3. Приставки, задающие смысл числа.
  let comparator = "exact";
  // «6,5–9,5 (фактически 7,5)» — в скобках уточнение замера; для сравнения
  // берём объявленный диапазон, уточнение остаётся в исходной строке.
  let text = low.replace(/\s*\((?:фактически|факт\.?)[^)]*\)\s*$/, "").trim();
  // Граница слова (\b) с кириллицей не работает — проверяем пробел явно.
  if (/^(не менее|не ранее|минимум)(\s|$)/.test(text)) { comparator = "min"; text = text.replace(/^(не менее|не ранее|минимум)\s*/, ""); }
  else if (/^(не более|не позднее|максимум|до)(\s|$)/.test(text)) { comparator = "max"; text = text.replace(/^(не более|не позднее|максимум|до)\s*/, ""); }
  else if (/^(около|примерно|~)\s*/.test(text)) { comparator = "approx"; text = text.replace(/^(около|примерно|~)\s*/, ""); }

  const unit = findUnit(text);

  // 4. Диапазон: «3–70 мм», «от +5°C до +30°C», «0,6–0,65 л/кг».
  const rangeDash = text.match(new RegExp(`(${NUM})\\s*[–—-]\\s*(${NUM})`));
  const rangeFromTo = text.match(new RegExp(`от\\s*(${NUM})[^\\d-]*?до\\s*(${NUM})`));
  const rangeDots = text.match(new RegExp(`(${NUM})\\s*°?\\s*…\\s*(${NUM})`));
  const range = rangeFromTo || rangeDots || rangeDash;
  if (range) {
    const a = toNum(range[1]), b = toNum(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const k = unit?.k ?? 1;
      return {
        ...base,
        valueMin: round(Math.min(a, b) * k), valueMax: round(Math.max(a, b) * k),
        // Для диапазона одного числа не существует — не выдумываем среднее.
        valueNum: null,
        unitRaw: unit?.raw ?? null, normalizedUnit: unit?.unit ?? null,
        comparator: "range", parsed: !!unit || isTemperature(text),
        note: unit ? null : "единица не распознана",
      };
    }
  }

  // 5. Одно число: «0,3 МПа», «2 часа», «50 циклов».
  const single = text.match(new RegExp(`(${NUM})`));
  if (single) {
    const n = toNum(single[1]);
    // Несколько чисел без диапазона («5 л / 10 л», «ведро 6 кг, 11 кг, 20 кг») —
    // это перечисление фасовок, а не характеристика. В числа не сводим.
    const howMany = (text.match(new RegExp(NUM, "g")) || []).length;
    if (howMany > 1 && !range) {
      return { ...base, valueText: displayValue, comparator: null, parsed: false, note: "несколько значений — нужен разбор человеком" };
    }
    if (Number.isFinite(n) && unit) {
      return {
        ...base, valueNum: round(n * unit.k),
        unitRaw: unit.raw, normalizedUnit: unit.unit, comparator, parsed: true,
      };
    }
    // Число без единицы: сохраняем как есть, но нормализованным не считаем.
    return { ...base, valueText: displayValue, comparator: null, parsed: false, note: "единица не указана" };
  }

  // 6. Всё остальное — текст: цвет, ГОСТ, описание. Это нормально.
  return { ...base, valueText: displayValue, comparator: null, parsed: false, note: "текстовое значение" };
}

const isTemperature = (t) => /°|температур/i.test(t);
// Убираем хвост двоичной арифметики: 0.30000000000000004 → 0.3.
const round = (n) => Math.round(n * 1e6) / 1e6;

// Сравнение двух характеристик. Сравнивать можно только одинаковые
// канонические единицы: «2 МПа» и «2,5 МПа» — да, «2 МПа» и «60 мин» — нет.
export function compareSpecs(a, b) {
  if (!a || !b) return null;
  if (a.normalizedUnit !== b.normalizedUnit) return null;
  const va = a.valueNum ?? a.valueMin;
  const vb = b.valueNum ?? b.valueMin;
  if (va === null || va === undefined || vb === null || vb === undefined) return null;
  return va === vb ? 0 : va < vb ? -1 : 1;
}
