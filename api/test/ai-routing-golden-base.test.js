// Phase 4.1: эталон поведения на базе без сведений о конкурентах (как
// рабочая база до ввода конкурентов).
import { goldenSuite } from "./helpers/routing-golden-test.js";

goldenSuite("base", { competitors: false });
