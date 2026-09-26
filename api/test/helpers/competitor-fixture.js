// Синтетические сведения о конкурентах для тестов 3.5. Названий настоящих
// компаний, марок и цен здесь нет и быть не должно: «ТестСмесь»,
// «Пример-Гипс», «Марка-Т», «Марка-U» и т. п. — выдуманы.
// Вызывать после prepareAiDb() (нужны товары и разделы тестовой базы).
export async function seedCompetitors() {
  const { get, insert } = await import("../../src/db/index.js");
  const C = await import("../../src/ai/competitors/index.js");
  const adminId = get("SELECT id FROM users WHERE tenant_id=1 AND role IN ('admin','owner') ORDER BY id LIMIT 1")?.id
    ?? insert("users", { tenant_id: 1, email: "seed-admin@test.habez.local", name: "seed admin", role: "admin", status: "active" });
  const admin = { tenantId: 1, role: "admin", actorId: adminId };
  const cat = (slug) => get("SELECT category_id FROM products WHERE slug=?", slug)?.category_id ?? null;
  const pid = (slug) => get("SELECT id FROM products WHERE slug=?", slug)?.id;

  const s1 = insert("ai_sources", { tenant_id: 1, source_type: "manufacturer_site", name: "Синтетический сайт ТестСмеси", url: "https://testsmes.example", trust_base: 50 });
  const s2 = insert("ai_sources", { tenant_id: 1, source_type: "price_list", name: "Синтетический прайс ДилерТеста", trust_base: 50 });
  const s3 = insert("ai_sources", { tenant_id: 1, source_type: "document", name: "Синтетическая таблица аналогов", trust_base: 50 });

  const r1 = C.createRegion(admin, { name: "Тестовый край" });
  const r2 = C.createRegion(admin, { name: "Пробная область" });
  const ts = C.createCompany(admin, { name: "ТестСмесь", kind: "manufacturer", competitorStatus: "competitor", website: "https://testsmes.example", hqRegionId: r1.id });
  const pg = C.createCompany(admin, { name: "Пример-Гипс", kind: "manufacturer", competitorStatus: "competitor" });
  const dealer = C.createCompany(admin, { name: "ДилерТест", kind: "dealer", competitorStatus: "not_competitor" });
  const secret = C.createCompany(admin, { name: "Секрет-Групп", kind: "manufacturer", competitorStatus: "competitor", accessLevel: "confidential" });
  const bT = C.createBrand(admin, { companyId: ts.id, name: "Марка-Т" });
  const bU = C.createBrand(admin, { companyId: ts.id, name: "Марка-U" });
  const bP = C.createBrand(admin, { companyId: pg.id, name: "Марка-П" });

  const tShov = C.createCompetitorProduct(admin, { companyId: ts.id, brandId: bT.id, categoryId: cat("shov"), name: "Шпаклёвка для швов «Т-Шов»", shortName: "Т-Шов" });
  const uShov = C.createCompetitorProduct(admin, { companyId: ts.id, brandId: bU.id, categoryId: cat("shov"), name: "Шпаклёвка для швов «U-Шов»", shortName: "U-Шов" });
  const tStart = C.createCompetitorProduct(admin, { companyId: ts.id, brandId: bT.id, categoryId: cat("koroed"), name: "Штукатурка «Т-Старт»", shortName: "Т-Старт" });
  const tGrunt = C.createCompetitorProduct(admin, { companyId: ts.id, brandId: bT.id, categoryId: cat("antipleseni"), name: "Грунт «Т-Грунт»", shortName: "Т-Грунт" });
  const pFinish = C.createCompetitorProduct(admin, { companyId: pg.id, brandId: bP.id, categoryId: cat("shov"), name: "Шпаклёвка «П-Финиш»", shortName: "П-Финиш" });
  const pKlei = C.createCompetitorProduct(admin, { companyId: pg.id, brandId: bP.id, categoryId: cat("standart"), name: "Плиточный клей «П-Клей»", shortName: "П-Клей" });
  const sMix = C.createCompetitorProduct(admin, { companyId: secret.id, categoryId: cat("shov"), name: "Смесь «С-Смесь»", shortName: "С-Смесь", accessLevel: "confidential" });

  const pack25 = C.createPack(admin, { competitorProductId: tShov.id, unitLabel: "мешок 25 кг", packSize: 25, packUnit: "кг", weightKg: 25, barcode: "4600000000017" });
  C.createPack(admin, { competitorProductId: tShov.id, unitLabel: "мешок 5 кг", packSize: 5, packUnit: "кг", weightKg: 5 });

  const obs = (p, specKey, originalValue, sourceId, extra = {}) => C.createObservation(admin, { competitorProductId: p.id, specKey, originalValue, sourceType: "technical_document", sourceId, ...extra });
  obs(tShov, "adhesion_strength", "не менее 0,5 МПа", s1, { providedAt: "2026-05-01", statementType: "declared" });
  obs(tShov, "adhesion_strength", "0,6 МПа", s3, { providedAt: "2026-08-01", statementType: "declared" });
  obs(tShov, "setting_time", "60 мин", s1);
  obs(tShov, "compressive_strength", "3 МПа", s1, { conditions: { age_days: 28 }, conditionText: "в возрасте 28 сут" });
  obs(uShov, "adhesion_strength", "0,4 МПа", s1);
  obs(tGrunt, "consumption", "0,15 л/м²", s1);

  const price = (p, amountMinor, observedAt, extra = {}) => C.createPrice(admin, { competitorProductId: p.id, amountMinor, currency: "RUB", priceKind: "retail", priceBasis: "за мешок 25 кг",
    basisUnit: "pack", basisQty: 25, sourceId: s2, observedAt, regionId: r1.id, sellerCompanyId: dealer.id, ...extra });
  price(tShov, 45000, "2026-08-01", { packId: pack25.id });
  price(tShov, 47000, "2026-09-01", { packId: pack25.id });
  price(tShov, 1800, "2026-09-01", { priceBasis: "за кг", basisUnit: "kg", basisQty: null });
  price(tShov, 39000, "2026-09-01", { packId: pack25.id, priceKind: "dealer", accessLevel: "confidential" });
  price(tShov, 46000, "2026-09-01", { packId: pack25.id, regionId: r2.id });
  price(uShov, 42000, "2026-09-01");

  const analog = (ours, p, relation, basis, extra = {}) => C.createAnalog(admin, { productId: pid(ours), competitorProductId: p.id, relation, basis, ...extra });
  analog("shov", tShov, "analog", "explicit_source_statement", { sourceId: s3, sourceReference: "строка 12" });
  analog("akvalayt", uShov, "analog", "user_decision", { note: "сотрудник сверил назначение и основание" });
  analog("antipleseni", tGrunt, "partial_analog", "user_decision", { note: "тот же вид грунтовки", differences: "нет противогрибковой добавки, другое назначение" });
  analog("koroed", tStart, "not_analog", "user_decision", { note: "другое назначение" });
  analog("standart", pKlei, "analog", "explicit_source_statement", { sourceId: s3 });
  analog("standart", pKlei, "not_analog", "user_decision", { note: "по классу клея не аналог" });
  analog("shov", sMix, "analog", "user_decision", { note: "внутренняя оценка", accessLevel: "confidential" });

  // Вторая компания-арендатор со своим конкурентом — для изоляции.
  const t2 = insert("tenants", { slug: "tenant-two", name: "Другая компания" });
  const admin2 = { tenantId: t2, role: "admin", actorId: insert("users", { tenant_id: t2, email: "seed-admin2@test.habez.local", name: "seed admin 2", role: "admin", status: "active" }) };
  const foreign = C.createCompany(admin2, { name: "ЧужаяСмесь", kind: "manufacturer", competitorStatus: "competitor" });
  C.createCompetitorProduct(admin2, { companyId: foreign.id, name: "Смесь «Ч-Шов»", shortName: "Ч-Шов" });

  return { sources: { s1, s2, s3 }, regions: { r1, r2 }, companies: { ts, pg, dealer, secret, foreign }, brands: { bT, bU, bP },
    products: { tShov, uShov, tStart, tGrunt, pFinish, pKlei, sMix }, pack25, t2 };
}
