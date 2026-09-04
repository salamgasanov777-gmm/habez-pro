#!/bin/sh
# Выкладка приложения №2 (Habez Gips) на GitHub Pages.
#
#   ./deploy.sh            каталог без цен, как сейчас на сайте
#   ./deploy.sh --prices   с ценами из базы (только если они настоящие)
#
# Что делает: выгружает каталог из базы в статический файл, собирает
# автономную версию и заливает её в ветку gh-pages. Исходники живут в main.
set -e
cd "$(dirname "$0")"

REPO_URL="https://github.com/salamgasanov777-gmm/habez-pro.git"
PRICES=""
[ "$1" = "--prices" ] && PRICES="--with-prices"

echo "→ выгружаю каталог из базы"
node api/src/db/export-static.js $PRICES

echo "→ собираю автономную версию"
npm --prefix web run build:standalone

echo "→ заливаю в gh-pages"
cd web/dist-standalone
rm -rf .git
git init -q
git add -A
git -c user.email=noreply@localhost -c user.name=deploy commit -qm "Выкладка $(date '+%Y-%m-%d %H:%M')"
git branch -M gh-pages
git push -qf "$REPO_URL" gh-pages

echo "✓ готово: https://salamgasanov777-gmm.github.io/habez-pro/"
