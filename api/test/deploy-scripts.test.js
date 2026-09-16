// Этап 1A-5: серверные скрипты из deploy/scripts проверяются без сервера.
// Внешние команды (age, git, npm, systemctl, sudo) подменяются заглушками
// в PATH; sqlite3, tar, curl и сам API — настоящие. Так проверяется логика
// скриптов, а не Linux: что на Ubuntu есть sqlite3/age/rclone — задача DEPLOY.md.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync, symlinkSync, readlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(apiRoot, "..");
const scripts = join(repoRoot, "deploy", "scripts");
const run = promisify(execFile);

// Чистое окружение: переменные HGZ_* с машины разработчика не должны влиять.
const cleanEnv = (extra = {}) => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("HGZ_")) env[k] = v;
  return { ...env, ...extra };
};

// Каталог с заглушками команд; PATH = заглушки + системный.
function stubDir() {
  const dir = mkdtempSync(join(tmpdir(), "hgz-stubs-"));
  const add = (name, body) => { const f = join(dir, name); writeFileSync(f, "#!/bin/bash\n" + body); chmodSync(f, 0o755); };
  return { dir, add, path: `${dir}:${process.env.PATH}` };
}

// age-заглушка: «шифрует» копированием. Только для тестов — проверяется
// логика скриптов (что и куда кладётся), а не криптография.
const AGE_STUB = `
out=""; dec=0; in=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -r|-i) shift 2;; -d) dec=1; shift;; *) in="$1"; shift;; esac; done
if [ "$dec" = 1 ]; then cp "$in" "$out"; else cat > "$out"; fi
`;

// Мигрированная база с товарами и без учётных записей — как на боевом сервере.
let data;
before(() => {
  data = mkdtempSync(join(tmpdir(), "hgz-deploy-data-"));
  mkdirSync(join(data, "uploads", "1"), { recursive: true });
  writeFileSync(join(data, "uploads", "1", "photo.bin"), "x");
  const env = { ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_FILE: join(data, "hgz.db"), UPLOAD_DIR: join(data, "uploads"), PAYMENT_PROVIDER: "none" };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js"], { cwd: apiRoot, env, stdio: "ignore" });
});

// ── backup.sh ────────────────────────────────────────────────────────────
test("backup.sh без получателя age падает понятно и ничего не создаёт", () => {
  const dest = mkdtempSync(join(tmpdir(), "hgz-backups-"));
  const r = spawnSync("bash", [join(scripts, "backup.sh"), "daily"], {
    encoding: "utf8",
    env: cleanEnv({ DATABASE_FILE: join(data, "hgz.db"), HGZ_BACKUP_DIR: dest, HGZ_BACKUP_ENV: join(dest, "нет-такого-файла"), HGZ_ENV_FILE: join(dest, "нет") }),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HGZ_BACKUP_AGE_RECIPIENT/);
  assert.equal(readdirSync(dest).filter((f) => !f.startsWith("нет")).length, 0, "каталог копий не тронут");
});

test("backup.sh при ручном запуске читает backup.env и делает копию", () => {
  const stubs = stubDir();
  stubs.add("age", AGE_STUB);
  const dest = mkdtempSync(join(tmpdir(), "hgz-backups-"));
  const envFile = join(dest, "backup.env");
  writeFileSync(envFile, "# настройки\nHGZ_BACKUP_AGE_RECIPIENT=\"age1testrecipient\"\nHGZ_BACKUP_KEEP_DAILY=3\nPATH=/должно/быть/проигнорировано\n");
  const hgzEnv = join(dest, "hgz.env");
  writeFileSync(hgzEnv, "JWT_SECRET=super-secret-value\n");
  const r = spawnSync("bash", [join(scripts, "backup.sh"), "daily"], {
    encoding: "utf8",
    env: cleanEnv({ PATH: stubs.path, DATABASE_FILE: join(data, "hgz.db"), HGZ_BACKUP_DIR: dest, HGZ_BACKUP_ENV: envFile, HGZ_ENV_FILE: hgzEnv }),
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const daily = readdirSync(join(dest, "daily")).filter((f) => f.endsWith(".tar.age"));
  assert.equal(daily.length, 1, "одна daily-копия");
  // Заглушка age не шифрует — внутри обычный tar: база, манифест, загрузки, окружение.
  const list = execFileSync("tar", ["-tf", join(dest, "daily", daily[0])], { encoding: "utf8" });
  for (const f of ["hgz.db", "MANIFEST", "uploads.tar", "hgz.env"]) assert.ok(list.includes(f), `в архиве есть ${f}`);
  // Ничего секретного в выводе: ни получателя, ни содержимого hgz.env.
  assert.ok(!(r.stdout + r.stderr).includes("age1testrecipient"));
  assert.ok(!(r.stdout + r.stderr).includes("super-secret-value"));
  assert.ok(!existsSync(join(dest, "tmp", "work.")), "временный каталог убран");
  assert.equal(readdirSync(join(dest, "tmp")).length, 0, "tmp пуст");
});

test("backup.sh: переменная из окружения важнее файла", () => {
  const stubs = stubDir();
  stubs.add("age", AGE_STUB);
  const dest = mkdtempSync(join(tmpdir(), "hgz-backups-"));
  const envFile = join(dest, "backup.env");
  writeFileSync(envFile, "HGZ_BACKUP_AGE_RECIPIENT=age1fromfile\nHGZ_BACKUP_DIR=/куда/не/надо\n");
  const r = spawnSync("bash", [join(scripts, "backup.sh"), "manual"], {
    encoding: "utf8",
    env: cleanEnv({ PATH: stubs.path, DATABASE_FILE: join(data, "hgz.db"), HGZ_BACKUP_DIR: dest, HGZ_BACKUP_ENV: envFile, HGZ_ENV_FILE: join(dest, "нет") }),
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readdirSync(join(dest, "manual")).length, 1, "копия легла в HGZ_BACKUP_DIR из окружения, не из файла");
});

// ── restore-test.sh ──────────────────────────────────────────────────────
test("restore-test.sh поднимает API на копии и после себя ничего не оставляет", async () => {
  const stubs = stubDir();
  stubs.add("age", AGE_STUB);
  const dest = mkdtempSync(join(tmpdir(), "hgz-backups-"));
  const bk = spawnSync("bash", [join(scripts, "backup.sh"), "daily"], {
    encoding: "utf8",
    env: cleanEnv({ PATH: stubs.path, DATABASE_FILE: join(data, "hgz.db"), HGZ_BACKUP_DIR: dest, HGZ_BACKUP_AGE_RECIPIENT: "age1x", HGZ_BACKUP_ENV: join(dest, "нет"), HGZ_ENV_FILE: join(dest, "нет") }),
  });
  assert.equal(bk.status, 0, bk.stderr);
  const identity = join(dest, "identity.txt");
  writeFileSync(identity, "AGE-SECRET-KEY-TEST\n");
  const port = 4300 + Math.floor(Math.random() * 500);
  const r = spawnSync("bash", [join(scripts, "restore-test.sh")], {
    encoding: "utf8", timeout: 60_000,
    env: cleanEnv({ PATH: stubs.path, HGZ_BACKUP_DIR: dest, HGZ_RESTORE_IDENTITY: identity, HGZ_APP_DIR: repoRoot, HGZ_RESTORE_PORT: String(port) }),
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /восстанавливается: товаров \d+/);
  // Процесс на порту убит именно node (exec в subshell), а не оболочка вокруг него.
  await new Promise((res) => setTimeout(res, 700));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`), "после теста порт свободен");
  assert.equal(readdirSync("/tmp").filter((f) => f.startsWith("hgz-restore.")).length, 0, "временных каталогов не осталось");
});

// ── smoke.sh ─────────────────────────────────────────────────────────────
test("smoke.sh: редирект http→https принимает 301 и 308, остальное — ошибка", async () => {
  for (const [code, want] of [[308, "OK"], [301, "OK"], [302, "FAIL"], [200, "FAIL"]]) {
    const srv = createServer((req, res) => { res.writeHead(code, { location: "https://example.invalid/" }); res.end(); });
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const out = await run("bash", [join(scripts, "smoke.sh"), base], { encoding: "utf8", env: cleanEnv() }).catch((e) => e);
    srv.close();
    const line = String(out.stdout).split("\n").find((l) => l.includes("http→https"));
    assert.ok(line, "строка проверки редиректа есть");
    assert.ok(line.startsWith(want), `${code}: ожидали ${want}, получили «${line}»`);
    assert.ok(line.includes(`→ ${code}`), line);
  }
});

// ── deploy.sh ────────────────────────────────────────────────────────────
// Сбой миграции: релиз не выпускается, служба возвращается в исходное состояние.
function deployWithFailingMigration({ active }) {
  const stubs = stubDir();
  const root = mkdtempSync(join(tmpdir(), "hgz-srv-"));
  const log = join(root, "systemctl.log");
  const state = join(root, "systemctl.state");
  writeFileSync(state, active ? "active" : "inactive");
  writeFileSync(log, "");
  // Заглушки: git создаёт «релиз», npm проваливает migrate, systemctl ведёт журнал и состояние.
  stubs.add("git", 'dest="${@: -1}"; mkdir -p "$dest/api" "$dest/web" "$dest/deploy/scripts"; printf "#!/bin/bash\\n" > "$dest/deploy/scripts/x.sh"\n');
  stubs.add("npm", 'case "$*" in *"run migrate"*) echo "migration exploded" >&2; exit 1;; esac; exit 0\n');
  stubs.add("chown", "exit 0\n");
  stubs.add("sudo", 'while [ "$1" = "-u" ]; do shift 2; done; exec "$@"\n');
  stubs.add("node", 'case "$*" in *--check*) echo 1;; esac; exit 0\n');
  stubs.add("systemctl", `echo "$*" >> "${log}"
case "$1" in
  is-active) s="$(cat "${state}")"; echo "$s"; [ "$s" = active ] && exit 0 || exit 3 ;;
  stop) echo inactive > "${state}" ;;
  start|restart) echo active > "${state}" ;;
esac
exit 0
`);
  // Копия deploy.sh рядом с заглушкой backup.sh (deploy.sh зовёт соседний файл).
  const here = join(root, "scripts");
  mkdirSync(here);
  copyFileSync(join(scripts, "deploy.sh"), join(here, "deploy.sh"));
  writeFileSync(join(here, "backup.sh"), `#!/bin/bash\necho "backup $1" >> "${log}"\n`);
  chmodSync(join(here, "backup.sh"), 0o755);
  const envFile = join(root, "hgz.env");
  writeFileSync(envFile, "NODE_ENV=production\n");
  // Текущий релиз уже есть — на него смотрит current.
  const oldRelease = join(root, "releases", "20260101-0000-v0");
  mkdirSync(oldRelease, { recursive: true });
  symlinkSync(oldRelease, join(root, "current"));
  const r = spawnSync("bash", [join(here, "deploy.sh"), "v9.9.9"], {
    encoding: "utf8",
    env: cleanEnv({ PATH: stubs.path, HGZ_ROOT: root, HGZ_ENV_FILE: envFile, HGZ_REPO: "stub", HGZ_USER: "hgz" }),
  });
  return { r, root, log: readFileSync(log, "utf8"), state: readFileSync(state, "utf8").trim(), oldRelease };
}

test("deploy.sh: упавшая миграция — служба запущена снова, current не переключён, код ошибки", () => {
  const { r, root, log, state, oldRelease } = deployWithFailingMigration({ active: true });
  assert.notEqual(r.status, 0, "ошибка миграции = ошибка обновления");
  assert.match(r.stderr, /миграция не выполнена/);
  assert.match(r.stderr, /База НЕ откачена/);
  const calls = log.trim().split("\n");
  assert.equal(calls[0], "backup manual", "копия снята до опасных шагов");
  assert.ok(calls.indexOf("stop hgz") < calls.indexOf("start hgz"), "stop, затем start");
  assert.equal(state, "active", "служба снова работает");
  assert.ok(!calls.includes("restart hgz"), "новый релиз не запускался");
  assert.equal(readlinkSync(join(root, "current")), oldRelease, "current смотрит на прежний релиз");
});

test("deploy.sh: если служба до обновления не работала, после сбоя миграции её не запускают", () => {
  const { r, log, state } = deployWithFailingMigration({ active: false });
  assert.notEqual(r.status, 0);
  const calls = log.trim().split("\n");
  assert.ok(!calls.includes("start hgz") && !calls.includes("restart hgz"), "запуска не было");
  assert.equal(state, "inactive");
  assert.match(r.stderr, /не запускаю/);
});
