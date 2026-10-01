// Habez AI (Phase 4.2): реестр проверок ответа. Порядок — порядок полей
// grounding в ответе API (как до 4.2); проверки друг от друга не зависят.
// Модуль без базы и сети: его читает и повторная проверка (recheck.js).
// Новый домен: своя проверка (контракт — contract.js) и строка здесь.
import { numbersCheck, citationsCheck, productsCheck, emptyAnswerCheck, datesCheck } from "./common.js";
import { forbiddenCheck } from "./policy.js";
import { suitabilityAnswerCheck } from "../intel/suitability.js";
import { factoryAnswerCheck } from "../factory/check.js";
import { competitorAnswerCheck } from "../competitor/check.js";

export const CHECKS = [numbersCheck, citationsCheck, forbiddenCheck, productsCheck,
  suitabilityAnswerCheck, emptyAnswerCheck, factoryAnswerCheck, datesCheck, competitorAnswerCheck];
