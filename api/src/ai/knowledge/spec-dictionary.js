// Словарь характеристик. Составлен по тому, что реально написано в карточках
// 56 товаров Habez, а не по общим представлениям о стройматериалах: лишние
// ключи вредны — по ним нечего сравнивать, а в панели они шумят.
//
// Ключ (латиницей) — то, по чему сравнивают AI и код. Подпись — то, что видит
// человек. Ожидаемая единица — подсказка для проверки качества: если значение
// пришло в другой величине, это повод посмотреть глазами.

export const SPEC_KEYS = {
  // ── Прочность и сцепление ────────────────────────────────────────────────
  compressive_strength: { label: "Прочность на сжатие", unit: "MPa", group: "Прочность" },
  compressive_strength_28d: { label: "Прочность на сжатие через 28 суток", unit: "MPa", group: "Прочность" },
  flexural_strength: { label: "Прочность на изгиб", unit: "MPa", group: "Прочность" },
  adhesion_strength: { label: "Прочность сцепления (адгезия)", unit: "MPa", group: "Прочность" },
  frost_resistance: { label: "Морозостойкость", unit: "cycles", group: "Стойкость" },
  water_absorption: { label: "Водопоглощение", unit: "%", group: "Стойкость" },

  // ── Работа с раствором ───────────────────────────────────────────────────
  pot_life: { label: "Жизнеспособность раствора", unit: "min", group: "Работа" },
  setting_time: { label: "Время схватывания", unit: "min", group: "Работа" },
  setting_time_start: { label: "Начало схватывания", unit: "min", group: "Работа" },
  open_time: { label: "Открытое время", unit: "min", group: "Работа" },
  adjust_time: { label: "Время корректировки", unit: "min", group: "Работа" },
  drying_time: { label: "Время высыхания", unit: "min", group: "Работа" },
  walk_on_time: { label: "Время хождения", unit: "min", group: "Работа" },
  strength_gain_initial: { label: "Первоначальный набор прочности", unit: "min", group: "Работа" },
  strength_gain_full: { label: "Полный набор прочности", unit: "min", group: "Работа" },
  water_ratio: { label: "Расход воды на смесь", unit: "l/kg", group: "Работа" },
  water_per_bag: { label: "Расход воды на мешок", unit: "l", group: "Работа" },
  water_mix_ratio: { label: "Водно-смесевое соотношение", unit: null, group: "Работа" },

  // ── Нанесение ────────────────────────────────────────────────────────────
  layer_thickness: { label: "Толщина слоя", unit: "mm", group: "Нанесение" },
  layer_thickness_wall: { label: "Толщина слоя для стен", unit: "mm", group: "Нанесение" },
  layer_thickness_floor: { label: "Толщина слоя для пола", unit: "mm", group: "Нанесение" },
  consumption: { label: "Расход", unit: null, group: "Нанесение" },          // кг/м² или л/м²
  consumption_per_mm: { label: "Расход на 1 м² при слое 1 мм", unit: "kg", group: "Нанесение" },
  consumption_per_10mm: { label: "Расход на 1 м² при слое 10 мм", unit: "kg", group: "Нанесение" },
  max_tile_size: { label: "Максимальный размер плитки", unit: null, group: "Нанесение" },
  max_tile_size_wall: { label: "Максимальный размер плитки, стена", unit: null, group: "Нанесение" },
  max_tile_size_floor: { label: "Максимальный размер плитки, пол", unit: null, group: "Нанесение" },
  max_aggregate: { label: "Максимальная крупность наполнителя", unit: "mm", group: "Нанесение" },
  application_area: { label: "Область применения", unit: null, group: "Нанесение" },
  base_temperature: { label: "Температура основания и воздуха", unit: "°C", group: "Условия" },
  service_temperature: { label: "Температура эксплуатации", unit: "°C", group: "Условия" },
  storage_temperature: { label: "Температура хранения", unit: "°C", group: "Условия" },

  // ── Материал и хранение ──────────────────────────────────────────────────
  binder: { label: "Основа (вяжущее)", unit: null, group: "Материал" },
  color: { label: "Цвет", unit: null, group: "Материал" },
  density: { label: "Плотность", unit: "kg/m3", group: "Материал" },
  bulk_density: { label: "Насыпной вес", unit: "kg/m3", group: "Материал" },
  ph: { label: "Водородный показатель pH", unit: null, group: "Материал" },
  execution: { label: "Исполнение", unit: null, group: "Материал" },
  dry_residue: { label: "Сухой остаток", unit: "%", group: "Материал" },
  non_volatile: { label: "Нелетучие вещества", unit: "%", group: "Материал" },
  hiding_power: { label: "Укрывистость", unit: null, group: "Материал" },
  washability: { label: "Смываемость", unit: null, group: "Материал" },
  shelf_life: { label: "Срок хранения", unit: "month", group: "Материал" },

  // ── Листовые материалы и плиты ───────────────────────────────────────────
  sheet_size: { label: "Размер листа", unit: null, group: "Геометрия" },
  profile_section: { label: "Сечение профиля", unit: null, group: "Геометрия" },
  sheet_area: { label: "Площадь листа", unit: "m2", group: "Геометрия" },
  thickness: { label: "Толщина", unit: "mm", group: "Геометрия" },

  // ── Пригодность (логические) ─────────────────────────────────────────────
  suitable_warm_floor: { label: "Тёплый пол", unit: null, group: "Пригодность" },
  suitable_indoor_normal: { label: "Внутри, обычная влажность", unit: null, group: "Пригодность" },
  suitable_indoor_wet: { label: "Внутри, повышенная влажность", unit: null, group: "Пригодность" },
  suitable_facade: { label: "Фасады и наружные поверхности", unit: null, group: "Пригодность" },
  suitable_hard_conditions: { label: "Цоколи, балконы, лестницы", unit: null, group: "Пригодность" },
  suitable_pool: { label: "Чаши бассейнов и фонтанов", unit: null, group: "Пригодность" },
  suitable_insulation: { label: "Армирование фасадных утеплителей", unit: null, group: "Пригодность" },
  suitable_outdoor: { label: "Наружные поверхности", unit: null, group: "Пригодность" },
  suitable_plinth: { label: "Цоколь", unit: null, group: "Пригодность" },
  water_resistant: { label: "Водостойкость", unit: null, group: "Пригодность" },

  // ── Основания ────────────────────────────────────────────────────────────
  base_concrete: { label: "Основание: бетон", unit: null, group: "Основания" },
  base_brick: { label: "Основание: кирпич", unit: null, group: "Основания" },
  base_aerated: { label: "Основание: газо- и пенобетон", unit: null, group: "Основания" },
  base_plastered: { label: "Основание: оштукатуренное", unit: null, group: "Основания" },
  base_cement_plaster: { label: "Основание: цементная штукатурка", unit: null, group: "Основания" },
  base_gypsum_board: { label: "Основание: ГКЛ и ГВЛ", unit: null, group: "Основания" },
  base_gypsum_board_joints: { label: "Основание: швы ГКЛ", unit: null, group: "Основания" },
  base_gypsum_plaster: { label: "Основание: гипсовая штукатурка", unit: null, group: "Основания" },

  // ── Что ляжет поверх (таблицы «Типы покрытий» и «Последующие покрытия») ──
  coating_tile: { label: "Под керамическую плитку", unit: null, group: "Покрытия" },
  coating_decorative_plaster: { label: "Под декоративную штукатурку", unit: null, group: "Покрытия" },
  coating_textured_wallpaper: { label: "Под фактурные обои", unit: null, group: "Покрытия" },
  coating_thin_wallpaper: { label: "Под тонкие обои", unit: null, group: "Покрытия" },
  coating_finish_putty: { label: "Под финишную шпаклёвку", unit: null, group: "Покрытия" },
  coating_textured_paint: { label: "Под фактурную покраску", unit: null, group: "Покрытия" },
  floor_none: { label: "Без покрытия", unit: null, group: "Покрытия" },
  floor_linoleum: { label: "Линолеум", unit: null, group: "Покрытия" },
  floor_carpet: { label: "Ковролин", unit: null, group: "Покрытия" },
  floor_tile: { label: "Керамогранит и плитка", unit: null, group: "Покрытия" },
  floor_stone: { label: "Натуральный камень", unit: null, group: "Покрытия" },
  floor_vinyl: { label: "Кварцвиниловое покрытие", unit: null, group: "Покрытия" },
  floor_parquet: { label: "Паркет", unit: null, group: "Покрытия" },
  floor_laminate: { label: "Ламинат", unit: null, group: "Покрытия" },
};

// Подписи из карточек → ключи словаря. Сравнение по строке в нижнем регистре
// без лишних пробелов; список составлен по фактическим подписям в базе.
const MAP = [
  // прочность
  ["прочность не менее", "compressive_strength"],
  ["прочность на сжатие", "compressive_strength"],
  ["прочность на сжатие, не менее", "compressive_strength"],
  ["прочность раствора на сжатие", "compressive_strength"],
  ["прочность на сжатие через 28 суток", "compressive_strength_28d"],
  ["прочность на изгиб", "flexural_strength"],
  ["прочность на изгиб, не менее", "flexural_strength"],
  ["прочность на отрыв", "adhesion_strength"],
  ["прочность на отрыв не менее", "adhesion_strength"],
  ["адгезия (прочность на отрыв)", "adhesion_strength"],
  ["адгезия", "adhesion_strength"],
  ["прочность сцепления раствора с основанием", "adhesion_strength"],
  ["прочность сцепления с основанием", "adhesion_strength"],
  ["морозостойкий, не менее", "frost_resistance"],
  ["морозостойкость", "frost_resistance"],
  ["водопоглощение", "water_absorption"],
  // работа
  ["время жизни раствора", "pot_life"],
  ["жизнеспособность раствора", "pot_life"],
  ["жизнеспособность", "pot_life"],
  ["время схватывания", "setting_time"],
  ["начало схватывания", "setting_time_start"],
  ["начало схватывания, не ранее", "setting_time_start"],
  ["открытое время", "open_time"],
  ["время корректировки плитки", "adjust_time"],
  ["время корректировки", "adjust_time"],
  ["время высыхания", "drying_time"],
  ["время хождения", "walk_on_time"],
  ["первоначальный набор прочности", "strength_gain_initial"],
  ["время полного набора прочности", "strength_gain_full"],
  ["полный набор прочности", "strength_gain_full"],
  ["расход воды", "water_ratio"],
  ["расход воды на 1 кг смеси", "water_ratio"],
  ["расход воды на 1 кг", "water_ratio"],
  ["расход воды на мешок 25 кг", "water_per_bag"],
  ["расход воды на мешок", "water_per_bag"],
  ["водно-смесевое соотношение", "water_mix_ratio"],
  // нанесение
  ["толщина слоя", "layer_thickness"],
  ["рекомендуемая толщина слоя", "layer_thickness"],
  ["для стен, см", "max_tile_size_wall"],
  ["для пола, см", "max_tile_size_floor"],
  ["расход", "consumption"],
  ["расход при однослойном нанесении", "consumption"],
  ["расход на 1 м² при толщине слоя 1 мм", "consumption_per_mm"],
  ["расход на 1 м² при толщине слоя 10 мм", "consumption_per_10mm"],
  ["расход сухой смеси на 1 м² при толщине слоя 10 мм", "consumption_per_10mm"],
  ["максимальная крупность наполнителя", "max_aggregate"],
  ["область применения", "application_area"],
  ["применение", "application_area"],
  ["максимальный размер плитки", "max_tile_size"],
  ["тип плитки", "max_tile_size"],
  ["температура основания", "base_temperature"],
  ["температура основания и окружающей среды", "base_temperature"],
  ["температура эксплуатации", "service_temperature"],
  ["температура хранения", "storage_temperature"],
  // материал
  ["основа", "binder"],
  ["цвет", "color"],
  ["цвет пленки", "color"],
  ["цвет плёнки", "color"],
  ["цвет поверхности", "color"],
  ["плотность", "density"],
  ["насыпной вес", "bulk_density"],
  ["водородный показатель ph", "ph"],
  ["исполнение", "execution"],
  ["сухой остаток", "dry_residue"],
  ["нелетучие вещества", "non_volatile"],
  ["массовая доля нелетучих веществ", "non_volatile"],
  ["укрывистость", "hiding_power"],
  ["смываемость", "washability"],
  ["срок хранения", "shelf_life"],
  // геометрия
  ["размер листа", "sheet_size"],
  ["размер плиты", "sheet_size"],
  ["сечение", "profile_section"],
  ["площадь листа", "sheet_area"],
  ["толщина", "thickness"],
  // пригодность
  ["тёплый пол", "suitable_warm_floor"],
  ["теплый пол", "suitable_warm_floor"],
  ["устройство теплых полов", "suitable_warm_floor"],
  ["устройство тёплых полов", "suitable_warm_floor"],
  ["водостойкий", "water_resistant"],
  ["для чаши бассейнов, фонтанов", "suitable_pool"],
  ["армирование фасадных утеплителей", "suitable_insulation"],
  // основания
  ["бетонное (монолитное, панельное)", "base_concrete"],
  ["кирпичное", "base_brick"],
  ["газо-, пенобетонное и другое сильновпитывающее", "base_aerated"],
  ["оштукатуренное (гипсовое, цементное)", "base_plastered"],
  ["оштукатуренное (цементное)", "base_cement_plaster"],
  ["плиты гвл, гкл", "base_gypsum_board"],
  ["гкл", "base_gypsum_board"],
  ["гкл, гклв, пгп и пгпв", "base_gypsum_board"],
  ["швы гкл", "base_gypsum_board_joints"],
  ["оштукатуренное (гипсовое)", "base_gypsum_plaster"],
  ["гипсовая штукатурка", "base_gypsum_plaster"],
  ["кирпичная кладка", "base_brick"],
  ["бетон, железобетон", "base_concrete"],
  ["ячеистый бетон", "base_aerated"],
  ["цементная, цементно-известковая штукатурка", "base_cement_plaster"],
  // «Область применения» построчно
  ["фасад", "suitable_facade"],
  ["наружные поверхности", "suitable_outdoor"],
  ["цоколь", "suitable_plinth"],
  // «Типы покрытий» и «Последующие покрытия»
  ["под керамическую плитку", "coating_tile"],
  ["под декоративную штукатурку", "coating_decorative_plaster"],
  ["под фактурные обои", "coating_textured_wallpaper"],
  ["под тонкие обои", "coating_thin_wallpaper"],
  ["под финишную шпаклевку", "coating_finish_putty"],
  ["под финишную шпаклёвку", "coating_finish_putty"],
  ["под фактурную покраску", "coating_textured_paint"],
  ["без покрытия", "floor_none"],
  ["линолеум", "floor_linoleum"],
  ["ковролин", "floor_carpet"],
  ["керамогранит или керамическая плитка", "floor_tile"],
  ["натуральный камень", "floor_stone"],
  ["кварцвиниловое покрытие", "floor_vinyl"],
  ["паркет", "floor_parquet"],
  ["ламинат", "floor_laminate"],
];

// Длинные подписи «Область применения» — по началу строки: в карточках они
// записаны с уточнениями в скобках, полностью совпадать не будут.
const PREFIX_MAP = [
  ["внутренние помещения с нормальным", "suitable_indoor_normal"],
  ["внутренние помещения с повышенным", "suitable_indoor_wet"],
  ["фасады и другие наружные", "suitable_facade"],
  ["сложные поверхности", "suitable_hard_conditions"],
];

// Эти подписи намеренно не переносятся: фасовки, вес и количество в упаковке
// уже живут в таблице variants (pack_size, pack_unit, weight_kg, per_pallet).
// Второй раз те же данные заводить нельзя — разойдутся.
export const SKIPPED_LABELS = new Map([
  ["упаковка", "фасовки хранятся в variants"],
  ["объём", "фасовки хранятся в variants"],
  ["объем", "фасовки хранятся в variants"],
  ["в упаковке", "фасовки хранятся в variants"],
  ["вес", "вес хранится в variants.weight_kg"],
  ["масса", "вес хранится в variants.weight_kg"],
  ["фасовка", "фасовки хранятся в variants"],
  ["количество на поддоне", "хранится в variants.per_pallet"],
  ["листов на паллете", "хранится в variants.per_pallet"],
  ["плит на поддоне", "хранится в variants.per_pallet"],
  ["мешков на поддоне", "хранится в variants.per_pallet"],
]);

// Штрихкоды и коды маркировки — идентификаторы фасовки (variants.barcode),
// а не характеристика: сравнивать по ним нечего.
const SKIP_PREFIX = ["штрихкод", "код ntin", "код gtin", "gtin", "ntin", "артикул"];

const norm = (s) => String(s || "").toLowerCase().replace(/ /g, " ").replace(/\s+/g, " ").trim().replace(/[:.]$/, "");
const EXACT = new Map(MAP.map(([label, key]) => [norm(label), key]));

/** Подпись из карточки → ключ словаря. null — соответствия нет. */
export function keyForLabel(label) {
  const n = norm(label);
  if (!n) return null;
  if (SKIPPED_LABELS.has(n) || SKIP_PREFIX.some((p) => n.startsWith(p))) return null;
  const exact = EXACT.get(n);
  if (exact) return exact;
  for (const [prefix, key] of PREFIX_MAP) if (n.startsWith(prefix)) return key;
  return null;
}

export const skipReason = (label) => {
  const n = norm(label);
  if (SKIPPED_LABELS.has(n)) return SKIPPED_LABELS.get(n);
  if (SKIP_PREFIX.some((p) => n.startsWith(p))) return "идентификатор фасовки (variants.barcode)";
  return null;
};
export const specMeta = (key) => SPEC_KEYS[key] || null;
