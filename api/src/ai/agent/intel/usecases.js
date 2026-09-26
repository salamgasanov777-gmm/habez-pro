// Habez AI Phase 3.3: задачи пользователя → канонические сценарии применения.
//
// Сценарий — внутреннее имя задачи («заделка швов ГКЛ» →
// drywall_joint_treatment) с правилами, по каким данным Habez её можно
// подтвердить. Здесь только сценарии, которые в данных Habez реально
// встречаются (проверено по карточкам и наблюдениям 26.09.2026); задачу,
// для которой данных нет, модель не «додумывает».
//
// Правила сценария:
//   types     — какие разделы каталога вообще кандидаты (гипсокартон не
//               «заделывает швы», это основание);
//   requires  — группы признаков пригодности; в группе — варианты (любой
//               подходит): ключ характеристики со значением ДА или
//               утверждение о назначении в описании/разделах карточки.
//               Все группы — «подтверждено», часть — «частично»;
//   against   — явные данные против (ключ со значением НЕТ);
//   keySpecs  — какие характеристики важны для этой задачи (сравнение).
//
// Текст ищется только в описании и разделах карточки («Область
// применения», «Назначение»), не в таблицах: строка таблицы «Швы ГКЛ — НЕТ»
// — это ключ base_gypsum_board_joints со значением НЕТ, а не назначение.

const DRY_MIXES = /шпакл|штукатур|монтаж|клеи|клей|пол/i;

export const USE_CASES = [
  {
    id: "drywall_joint_treatment", label: "заделка швов ГКЛ / ПГП",
    triggers: /(шв[ао]в?|стык[аиов]*|заделк[а-я]*)[^.?]{0,30}(гкл|гипсокартон|гвл|пгп|пазогреб)|(гкл|гипсокартон|пгп)[^.?]{0,20}(шв|стык)/i,
    types: /шпакл|штукатур/i,
    requires: [
      [{ key: "base_gypsum_board_joints", value: true }, { text: /(заделк|шпаклев)[а-я]*[^.]{0,40}(стык|шв)[а-я]*[^.]{0,40}(гкл|гипсокартон|пгп|гвл)/i, label: "назначение: заделка стыков ГКЛ/ПГП" }],
      [{ key: "base_gypsum_board", value: true }],
    ],
    against: [{ key: "base_gypsum_board_joints", value: false }],
    keySpecs: ["adhesion_strength", "compressive_strength", "setting_time", "setting_time_start", "layer_thickness", "max_aggregate", "water_per_bag", "water_ratio"],
  },
  {
    id: "drywall_base", label: "работа по основанию ГКЛ / ГВЛ",
    triggers: /(для|по|на|к)\s+(гкл|гипсокартон[а-я]*|гвл)(?![а-я])/i,
    types: DRY_MIXES,
    requires: [[{ key: "base_gypsum_board", value: true }]],
    against: [{ key: "base_gypsum_board", value: false }],
    keySpecs: ["adhesion_strength", "layer_thickness", "base_gypsum_board"],
  },
  {
    id: "board_bonding", label: "монтаж ПГП / приклеивание ГКЛ",
    triggers: /(монтаж|приклеи|клеить|крепл|кладк)[а-я]*[^.?]{0,30}(гкл|гипсокартон|пгп|пазогреб)/i,
    types: /монтаж|клеи|клей/i,
    requires: [[{ text: /(монтаж|приклеива|кладк|крепл)[а-я]*[^.]{0,50}(гкл|гипсокартон|пгп|пазогреб)/i, label: "назначение: монтаж ПГП / приклеивание ГКЛ" }]],
    against: [],
    keySpecs: ["adhesion_strength", "pot_life", "open_time", "consumption"],
  },
  {
    id: "facade_plastering", label: "фасадные и наружные работы",
    triggers: /фасад|наружн[а-я]* (работ|стен|поверхност)|снаружи|на улиц/i,
    types: /шпакл|штукатур|монтаж|клеи|клей/i,
    requires: [[{ key: "suitable_facade", value: true }, { key: "suitable_outdoor", value: true }]],
    against: [{ key: "suitable_facade", value: false }],
    keySpecs: ["frost_resistance", "adhesion_strength", "compressive_strength", "base_temperature"],
  },
  {
    id: "interior_works", label: "внутренние работы (обычная влажность)",
    triggers: /внутренн[а-я]* работ|внутри помещ|для помещени[йя](?! с повыш)/i,
    types: DRY_MIXES,
    requires: [[{ key: "suitable_indoor_normal", value: true }]],
    against: [{ key: "suitable_indoor_normal", value: false }],
    keySpecs: ["layer_thickness", "base_temperature"],
  },
  {
    id: "wet_rooms", label: "помещения с повышенной влажностью",
    triggers: /влажн|ванн|душев|санузел|кухн[а-я]* с/i,
    types: DRY_MIXES,
    requires: [[{ key: "suitable_indoor_wet", value: true }]],
    against: [{ key: "suitable_indoor_wet", value: false }],
    keySpecs: ["water_absorption", "suitable_indoor_wet"],
  },
  {
    id: "warm_floor", label: "тёплый пол",
    triggers: /т[её]пл[а-я]* пол/i,
    types: /клеи|клей|пол/i,
    requires: [[{ key: "suitable_warm_floor", value: true }]],
    against: [{ key: "suitable_warm_floor", value: false }],
    keySpecs: ["suitable_warm_floor"],
  },
  {
    id: "tile_laying", label: "укладка плитки",
    triggers: /(уклад|клеить|приклеи|клей)[а-я]*[^.?]{0,20}плитк|плиточн|керамогранит/i,
    types: /клеи|клей/i,
    requires: [[{ text: /плитк|керамогранит/i, label: "назначение: укладка плитки" }]],
    against: [],
    keySpecs: ["adhesion_strength", "adjust_time", "open_time", "max_tile_size", "layer_thickness"],
  },
  {
    id: "floor_leveling", label: "выравнивание пола",
    triggers: /(выравн|выровн|стяжк|наливн)[а-я]*[^.?]{0,20}пол|пол[а-я]*[^.?]{0,20}(выравн|выровн)/i,
    types: /пол/i,
    requires: [[{ text: /выравнива|стяжк|наливн|самовыравн|самонивел/i, label: "назначение: выравнивание пола" }]],
    against: [],
    keySpecs: ["compressive_strength", "compressive_strength_28d", "layer_thickness", "walk_on_time"],
  },
  {
    id: "mold_treatment", label: "защита от плесени и грибка",
    triggers: /плесен|грибк|антисепт/i,
    types: /грунт/i,
    requires: [[{ text: /плесен|грибк|антисепт/i, label: "назначение: защита от плесени и грибка" }]],
    against: [],
    keySpecs: ["consumption", "drying_time"],
  },
  {
    id: "priming", label: "грунтование основания",
    triggers: /(грунтов|загрунт)[а-я]*(?![^.?]{0,20}плесен)/i,
    types: /грунт/i,
    requires: [[{ text: /грунт/i, label: "назначение: грунтование" }]],
    against: [],
    keySpecs: ["consumption", "drying_time"],
  },
  {
    id: "waterproofing", label: "гидроизоляция",
    triggers: /гидроизол|от протечек|от воды/i,
    types: /гидроизол/i,
    requires: [[{ text: /гидроизол/i, label: "назначение: гидроизоляция" }]],
    against: [],
    keySpecs: ["consumption", "water_resistant"],
  },
];
export const useCaseById = (id) => USE_CASES.find((u) => u.id === id) || null;

// Слова вида товара в вопросе сужают кандидатов: «какие штукатурки…».
const TYPE_WORDS = [
  [/штукатур/i, /штукатур/i], [/шпакл/i, /шпакл/i], [/клей|клеи|клея/i, /клеи|клей|монтаж/i], [/грунт/i, /грунт/i],
  [/сух[а-я]* смес|смес[ьи]/i, /шпакл|штукатур|монтаж|клеи|клей|пол/i], [/наливн|пол[ыа]?(?![а-я])/i, /пол/i],
];
export function typeFromQuestion(q) {
  const hit = TYPE_WORDS.find(([re]) => re.test(q));
  return hit ? hit[1] : null;
}

// Первый подходящий сценарий. Заделка швов важнее «работы по ГКЛ»
// (оба упоминают ГКЛ), поэтому порядок в списке значим.
export function resolveUseCase(question) {
  const q = String(question || "").toLowerCase().replace(/ё/g, "е");
  return USE_CASES.find((u) => u.triggers.test(q)) || null;
}
