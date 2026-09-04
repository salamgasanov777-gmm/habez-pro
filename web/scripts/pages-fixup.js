// Доводка сборки под GitHub Pages.
//
// Pages — это просто файловый сервер: адрес вида /habez-gips/p/akvalayt
// он ищет как файл и не находит. Но на несуществующий путь он отдаёт 404.html,
// не меняя адрес в строке браузера, — поэтому кладём туда копию index.html:
// приложение запускается и само открывает нужную карточку.
import { copyFileSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, process.argv[2] || "dist-standalone");

copyFileSync(resolve(dist, "index.html"), resolve(dist, "404.html"));
// Без этого файла Pages прогоняет сборку через Jekyll и выбрасывает папки,
// начинающиеся с подчёркивания.
writeFileSync(resolve(dist, ".nojekyll"), "");

// Страница на каждый товар. Через 404.html карточка тоже открывается, но
// сервер при этом отвечает «не найдено»: ссылка, отправленная в WhatsApp,
// выглядит битой для мессенджера, а поисковик такую страницу не индексирует.
// Отдельный index.html на каждый адрес снимает и то, и другое.
const shell = readFileSync(resolve(dist, "index.html"));
const routes = ["cart", "compare", "favorites"];

const catalogFile = resolve(dist, "data/catalog.json");
if (existsSync(catalogFile)) {
  const { products } = JSON.parse(readFileSync(catalogFile, "utf8"));
  for (const product of products) routes.push(`p/${product.slug}`);
}

for (const route of routes) {
  const dir = resolve(dist, route);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "index.html"), shell);
}

console.log(`[pages] 404.html, .nojekyll и ${routes.length} страниц созданы в ${dist}`);
