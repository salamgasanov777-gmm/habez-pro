// Habez AI Phase 3.4: вопросы о заводах и документах — правилами, без модели.
//
//   factory_lookup     «Где находится завод?», «Есть ли сведения о производителе?»,
//                      «Какая мощность завода?»
//   factory_products   «Что производит Habez?», «Какие краски выпускает завод?»,
//                      «Какие ещё товары выпускает этот завод?»
//   factory_documents  «Какие документы есть у ШОВ?», «Есть ли паспорт на ШОВ?»,
//                      «Какой документ подтверждает прочность ШОВ?»,
//                      «Какие источники используются?»
//   product_factory    «Где производится ШОВ?», «Где его производят?»,
//                      «Что здесь прямое доказательство, а что вывод?»
//   factory_profile    «Расскажи про завод», «Что известно о заводе Habez?»
//
// Возвращает намерение и уточнения (вид документа, товарная группа,
// «ещё», вопрос о правилах при расхождении) или null.
import { groupFromQuestion } from "./model.js";

const DOCS = /документ|паспорт[а-я]* (качеств|на |у |к |по )|паспорт[а-я]*\s*$|есть ли паспорт|этикетк|маркировочн|сертификат|декларац|протокол[а-я]* испыт|(?:^|[^а-я])ту(?![а-я])|техническ[а-я]* услови/;
const SOURCES = /как(ие|им|ой) источник|источник[а-я]* (данных|информации|сведений)|(на чем|на чём) основан|какие данные (есть|используются)/;
const LEVELS = /прям[а-я]* доказательств|что (здесь |из этого |тут )?(вывод|предположени|косвенн)|косвенн[а-я]* (связ|признак|доказ)|inference|вывод[а-я]*,? а что/;
const WHERE_MADE = /где (его |ее |её |их |он |она |они )?(производ|выпуска|изготавлива|делают|сделан)|кто (его |ее |её |их )?(производит|выпускает|изготавливает|делает)|на как(ом|ой|их) (завод|площадк|производств)|как(ой|ие) завод[а-я]* (производ|выпуска|изготавл|его|ее|их)|производител|изготовител|чье производство|чьего производства|место производ|производится|производятся|выпускается|изготавливается/;
const PRODUCTS_OF = /что (еще |ещё )?(производит|выпускает|делает|изготавливает)|как(ие|ую|ой|их) (еще |ещё |другие |другую |другой )?([а-я]+ )?(товар|продукц|смес|краск|вид|групп|издели|материал|грунтовк|кле|шпакл|штукатур|плит|лист|гипсокартон)[а-я]*[^?]*(выпуска|производ|изготавл|относ|связан|есть у|входят|ассортимент)|ассортимент|товарн[а-я]* групп|(что|какие товары) (есть )?в каталоге завод/;
const PROFILE = /(расскажи|что известно|что ты знаешь|информаци[яю]|сведения|опиши)[^?]*(о |об |про )?(завод|производител|изготовител|фабрик|habez|хабез)/;
const LOOKUP = /где (находится|расположен)|адрес|местоположен|как называется|какие (есть )?заводы|сколько заводов|есть ли (сведения|данные|информация) о (производител|завод|изготовител)|площад[ьи] завод|мощност|численност|сколько (работник|сотрудник|человек)|производительност|год основани|когда основан/;
const FACTORY = /завод|фабрик|площадк|производител|изготовител/;
const CONFLICT = /конфликт|противореч|расхожд|не совпада|разн[а-я]* (дат|редакц|верси)/;

// Вид документа из вопроса.
const DOC_TYPE_WORDS = [
  [/паспорт/, "quality_passport"], [/этикетк/, "label"], [/маркировочн/, "marking_card"], [/письм|технолог/, "factory_technologist"],
  [/прайс/, "price_list"], [/сайт/, "factory_site"], [/каталог/, "factory_catalog"], [/карточк/, "product_card"],
];
export function docTypesFromQuestion(q) {
  return DOC_TYPE_WORDS.filter(([re]) => re.test(q)).map(([, t]) => t);
}

// q — вопрос в нижнем регистре; products — товары из вопроса или беседы;
// state — состояние беседы.
export function factoryIntent(q, { products = [], productsFromQuestion = false, state = {}, useCase = null, specKeys = [] } = {}) {
  const mentionsFactory = FACTORY.test(q);
  const thisFactory = /(этот|этого|этом|тот|того|том|данн[а-я]*) (завод|производител|площадк)/.test(q);
  const extra = { group: groupFromQuestion(q), docTypes: docTypesFromQuestion(q), more: /(^|\s)(еще|ещё|другие|другую|остальн)/.test(q), conflictPolicy: false, levels: false };
  // «Откуда значение прочности ШОВ?» — происхождение значения (3.2), не документы.
  const provenanceOfValue = /откуда|кто (дал|указал|прислал)/.test(q) && specKeys.length && !/документ/.test(q);
  if (DOCS.test(q) && !provenanceOfValue) return { intent: "factory_documents", ...extra, conflictPolicy: CONFLICT.test(q) };
  if (SOURCES.test(q) && !specKeys.length) return { intent: "factory_documents", ...extra, overview: true };
  // «Что здесь прямое доказательство, а что вывод?» — о текущем товаре,
  // иначе — о заводе.
  if (LEVELS.test(q)) return { intent: products.length ? "product_factory" : "factory_profile", ...extra, levels: true };
  if (PRODUCTS_OF.test(q) && (mentionsFactory || thisFactory || /habez|хабез|ассортимент|товарн[а-я]* групп/.test(q) || (!productsFromQuestion && !useCase))) return { intent: "factory_products", ...extra };
  if (WHERE_MADE.test(q) && products.length) return { intent: "product_factory", ...extra };
  if (PROFILE.test(q) && !(productsFromQuestion && /производител|изготовител/.test(q))) return { intent: "factory_profile", ...extra };
  if (WHERE_MADE.test(q) && !products.length) return { intent: "factory_lookup", ...extra };
  if (LOOKUP.test(q) && (mentionsFactory || thisFactory || !products.length)) return { intent: "factory_lookup", ...extra, asked: askedAttribute(q) };
  if (mentionsFactory && !products.length && !useCase && !specKeys.length) return { intent: "factory_lookup", ...extra, asked: askedAttribute(q) };
  return null;
}

// О каком свойстве завода спросили (для «нет данных» без модели).
export function askedAttribute(q) {
  if (/площад/.test(q)) return "площадь";
  if (/мощност/.test(q)) return "производственная мощность";
  if (/численност|сколько (работник|сотрудник|человек)/.test(q)) return "численность работников";
  if (/производительност/.test(q)) return "производительность";
  if (/год основани|когда основан/.test(q)) return "год основания";
  if (/где (находится|расположен)|адрес|местоположен/.test(q)) return "location";
  return null;
}
