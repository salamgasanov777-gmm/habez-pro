// Habez AI Phase 3.3: пригодность товара для сценария — правилами, без
// модели. Модель потом только объясняет готовый результат.
//
//   SUPPORTED           — выполнены все группы признаков сценария;
//   PARTIALLY_SUPPORTED — выполнена часть групп;
//   NOT_SUPPORTED       — есть явные данные против (ключ со значением НЕТ);
//   INSUFFICIENT_DATA   — признаков нет ни за, ни против;
//   CONFLICTED          — по нужному признаку спор, или данные есть и за, и
//                         против.
// INSUFFICIENT_DATA не превращается в NOT_SUPPORTED, частичное — не в
// подтверждённое.
//
// Скрытые данные: пригодность считается только по ВИДИМЫМ роли значениям.
// Конфиденциальное наблюдение не делает ответ гостю или сотруднику ни
// «подходит», ни «спорно» (для гостя канал — карточка витрины).
import { parseSpecValue } from "../../knowledge/units.js";
import { specLabel } from "../retrieval/specs.js";

export const STATUSES = ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT_DATA", "CONFLICTED"];
export const STATUS_LABEL = {
  SUPPORTED: "подтверждено данными", PARTIALLY_SUPPORTED: "подтверждено частично", NOT_SUPPORTED: "по данным не подходит",
  INSUFFICIENT_DATA: "данных недостаточно", CONFLICTED: "данные противоречат",
};

const low = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
// Разделы карточки, в которых говорится о назначении и порядке работ
// (хранение, гарантия, меры безопасности — не про пригодность).
const PURPOSE_SECTION = (title) => !/хранен|транспорт|гарант|безопасн|предосторож|утилиз/i.test(title || "");

const boolOf = (display) => parseSpecValue(String(display ?? "")).valueBool;
const visibleValues = (prop) => prop.values.filter((v) => !v.hidden);
// Спор по видимым значениям: разные видимые значения или открытый вопрос
// сверки. Скрытое (конфиденциальное) значение спора не создаёт.
const disputed = (prop) => (prop.items?.length > 0) || new Set(visibleValues(prop).map((v) => low(v.display))).size > 1;

function snippet(text, re) {
  const s = String(text || "");
  const m = low(s).match(re);
  if (!m) return null;
  const at = m.index;
  const from = Math.max(0, s.lastIndexOf(".", at) + 1);
  const to = s.indexOf(".", at + m[0].length);
  return s.slice(from, to === -1 ? Math.min(s.length, at + 200) : to + 1).trim().slice(0, 240);
}

// product — результат get_product (summary, sections); sp — get_product_specs.
export function evaluateSuitability({ product, sp, useCase }) {
  const props = sp?.properties || [];
  const texts = [{ where: "summary", title: "описание", text: product.summary },
    ...(product.sections || []).filter((s) => PURPOSE_SECTION(s.title)).map((s) => ({ where: "section", title: s.title, text: s.text }))];
  const supporting = [];
  const against = [];
  const conflicting = [];
  const missing = [];
  let satisfied = 0;
  const groupOk = [];

  const byKey = (key) => props.filter((p) => p.key === key && !p.variant);
  for (const group of useCase.requires) {
    let ok = false;
    for (const rule of group) {
      if (rule.key) {
        for (const prop of byKey(rule.key)) {
          if (disputed(prop)) { conflicting.push({ kind: "prop", prop, text: `${prop.label}: ${visibleValues(prop).map((v) => v.display).join(" / ")}` }); continue; }
          const v = visibleValues(prop)[0];
          if (v && boolOf(v.display) === rule.value) { supporting.push({ kind: "prop", prop, text: `${prop.label}: ${v.display}` }); ok = true; }
        }
      } else if (rule.text) {
        for (const t of texts) {
          const sn = snippet(t.text, rule.text);
          if (sn) { supporting.push({ kind: "text", where: t.where, title: t.title, text: sn, label: rule.label }); ok = true; break; }
        }
      }
    }
    groupOk.push(ok);
    if (ok) satisfied += 1;
    else missing.push(group.map((r) => r.label || `${specLabel(r.key)}: ${r.value ? "ДА" : "НЕТ"}`).join(" или "));
  }
  // Данные против относятся к группе (по умолчанию — первой, главной).
  // Спор — только если та же группа подтверждена: «швы ГКЛ — НЕТ» при
  // «основание ГКЛ — ДА» — это «не подходит», а не спор.
  let againstSameGroup = false;
  for (const rule of useCase.against || []) {
    for (const prop of byKey(rule.key)) {
      if (disputed(prop)) continue;
      const v = visibleValues(prop)[0];
      if (v && boolOf(v.display) === rule.value) {
        against.push({ kind: "prop", prop, text: `${prop.label}: ${v.display}` });
        if (groupOk[rule.group ?? 0]) againstSameGroup = true;
      }
    }
  }

  let status;
  if (against.length) status = againstSameGroup ? "CONFLICTED" : "NOT_SUPPORTED";
  else if (conflicting.length) status = "CONFLICTED";
  else if (satisfied === useCase.requires.length) status = "SUPPORTED";
  else if (satisfied > 0) status = "PARTIALLY_SUPPORTED";
  else status = "INSUFFICIENT_DATA";

  const reason = {
    SUPPORTED: `в данных есть все нужные признаки для «${useCase.label}»`,
    PARTIALLY_SUPPORTED: `часть признаков для «${useCase.label}» есть, но не все (нет: ${missing.join("; ")})`,
    NOT_SUPPORTED: `в данных прямо указано: ${against.map((a) => a.text).join("; ")}`,
    INSUFFICIENT_DATA: `в данных нет признаков ни за, ни против (${missing.join("; ")})`,
    CONFLICTED: againstSameGroup ? `данные противоречат: ${[...supporting, ...against].map((a) => a.text).join(" / ")}` : `по нужному признаку расхождение: ${conflicting.map((c) => c.text).join("; ")}`,
  }[status];
  return { status, supporting, against, conflicting, missing, reason };
}

// Модель не должна называть «подходит» товар, который система оценила
// иначе. Строка ответа с именем товара и утверждением «подходит /
// рекомендую / лучший» без оговорки — расхождение со статусом.
const POSITIVE = /(^|[^а-я])(подходит|подойд[её]т|рекоменду|лучш|идеальн|оптимальн)/i;
const HEDGE = /не подход|не подойд|частичн|недостаточн|не подтвержд|противореч|нет данных|не указан|не рекоменду|по данным не|нельзя|не предназнач|не относ/i;
export function suitabilityMismatch(answer, suitability = []) {
  const lines = String(answer || "").split(/\n+/);
  const out = [];
  for (const s of suitability) {
    if (s.status === "SUPPORTED") continue;
    const name = low(s.short);
    if (!name || name.length < 2) continue;
    // Смотрим часть фразы с именем товара: в «подходит только ШОВ, СТАНДАРТ
    // не предназначен» «подходит» — про ШОВ.
    const bad = lines.some((l) => low(l).split(/[,;()]/).some((c) => c.includes(name) && POSITIVE.test(c) && !HEDGE.test(c)));
    if (bad) out.push(s.short);
  }
  return out;
}
