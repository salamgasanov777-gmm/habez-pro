// Phase 4.1: эталон поведения на базе со справочником конкурентов.
import { goldenSuite } from "./helpers/routing-golden-test.js";

goldenSuite("competitors", { competitors: true });
