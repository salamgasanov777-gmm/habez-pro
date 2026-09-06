#!/bin/sh
# Копия базы приложения №2 (Habez Gips).
#
# В базе живут товары, цены, заказы и учётные записи. Сама она в репозиторий
# не попадает, поэтому единственная защита — эти копии.
#
#   ./scripts/backup-db.sh                                  копия в iCloud Drive
#   HGZ_BACKUP_DIR=/Volumes/Флешка ./scripts/backup-db.sh    копия куда укажете
#
# Копия снимается через VACUUM INTO: она согласованная, даже если сервер
# в этот момент работает и пишет в базу. Простое копирование файла так не умеет.
set -e
cd "$(dirname "$0")/.."

db="api/var/hgz.db"
dest="${HGZ_BACKUP_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Habez Gips — копии базы}"
keep=30

[ -f "$db" ] || { echo "нет базы: $db"; exit 1; }
mkdir -p "$dest"

file="$dest/hgz-$(date '+%Y-%m-%d_%H-%M').db"
/usr/bin/sqlite3 "$db" "VACUUM INTO '$file'"

# Копия, которая не открывается, бесполезна — проверяем сразу.
check=$(/usr/bin/sqlite3 "$file" "PRAGMA integrity_check" 2>&1)
[ "$check" = "ok" ] || { echo "копия повреждена: $check"; rm -f "$file"; exit 1; }
products=$(/usr/bin/sqlite3 "$file" "SELECT COUNT(*) FROM products")
orders=$(/usr/bin/sqlite3 "$file" "SELECT COUNT(*) FROM orders")

# Оставляем последние копии, остальные удаляем.
ls -1t "$dest"/hgz-*.db 2>/dev/null | tail -n +$((keep + 1)) | while read -r old; do rm -f "$old"; done

total=$(ls -1 "$dest"/hgz-*.db 2>/dev/null | wc -l | tr -d ' ')
echo "✓ копия: $file"
echo "  товаров $products, заказов $orders, копий в папке $total"
