// Доводка сборки под GitHub Pages.
//
// Pages — это просто файловый сервер: адрес вида /habez-gips/p/akvalayt
// он ищет как файл и не находит. Но на несуществующий путь он отдаёт 404.html,
// не меняя адрес в строке браузера, — поэтому кладём туда копию index.html:
// приложение запускается и само открывает нужную карточку.
import { copyFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, process.argv[2] || "dist-standalone");

copyFileSync(resolve(dist, "index.html"), resolve(dist, "404.html"));
// Без этого файла Pages прогоняет сборку через Jekyll и выбрасывает папки,
// начинающиеся с подчёркивания.
writeFileSync(resolve(dist, ".nojekyll"), "");

console.log(`[pages] 404.html и .nojekyll добавлены в ${dist}`);
