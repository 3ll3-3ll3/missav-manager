import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { projectFile } from "./helpers/bundle.mjs";
import { restoreBackupIntoFreshTemporaryD1 } from "./helpers/temporary-d1-restore.mjs";

class TestPreparedStatement {
  constructor(owner, sql, values = []) { this.owner = owner; this.sql = sql; this.values = values; }
  bind(...values) { return new TestPreparedStatement(this.owner, this.sql, values); }
  async all() {
    this.owner.beforeQuery(this.sql);
    return { success: true, results: this.owner.database.prepare(this.sql).all(...this.values) };
  }
  async first() {
    this.owner.beforeQuery(this.sql);
    return this.owner.database.prepare(this.sql).get(...this.values) ?? null;
  }
  async run() {
    this.owner.beforeQuery(this.sql);
    const result = this.owner.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  executeForBatch() {
    this.owner.beforeQuery(this.sql);
    const result = this.owner.database.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class TestD1Database {
  constructor(database, hooks = {}) {
    this.database = database;
    this.hooks = hooks;
    this.queries = [];
    this.writes = 0;
  }
  beforeQuery(sql) {
    this.queries.push(sql);
    if (/^\s*(?:DELETE|INSERT|UPDATE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) this.writes += 1;
    this.hooks.beforeQuery?.(sql, this);
  }
  prepare(sql) { return new TestPreparedStatement(this, sql); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.executeForBatch());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const MIGRATIONS = [
  "drizzle/0000_fantastic_paper_doll.sql",
  "drizzle/0001_ambitious_bloodscream.sql",
  "drizzle/0002_small_garia.sql",
  "drizzle/0003_glossy_bloodaxe.sql",
  "drizzle/0004_classy_pixie.sql",
];

async function applySchema(database) {
  for (const file of MIGRATIONS) {
    database.exec((await readFile(projectFile(file), "utf8")).replaceAll("--> statement-breakpoint", "\n"));
  }
  database.exec("PRAGMA foreign_keys=ON");
}

async function applyMiniflareSchema(database) {
  for (const file of MIGRATIONS) {
    const source = await readFile(projectFile(file), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
  await database.prepare("PRAGMA foreign_keys=ON").run();
}

async function loadBuiltModule(entry, database) {
  globalThis.__DATABASE_BACKUP_TEST_ENV__ = { DB: database };
  const result = await build({
    entryPoints: [fileURLToPath(projectFile(entry))],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    plugins: [{
      name: "cloudflare-test-env",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers", namespace: "test-env" }));
        buildApi.onLoad({ filter: /.*/, namespace: "test-env" }, () => ({ contents: "export const env = globalThis.__DATABASE_BACKUP_TEST_ENV__;", loader: "js" }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${Date.now()}-${Math.random()}`);
}

const loadBackupModule = (database) => loadBuiltModule("lib/database-backup.ts", database);
const loadRouteModule = (database) => loadBuiltModule("app/api/database-backup/route.ts", database);
const asText = (stream) => new Response(stream).text();
const asStream = (text) => new Blob([text]).stream();

function seedEncryptedSession(database) {
  const encryptedSession = "v1:ciphertext-only:AAECAwQFBgc=";
  database.prepare("INSERT INTO telegram_accounts(id,status,encrypted_session,account_key,account_label,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("owner", "authorized", encryptedSession, "opaque-account-key", "测试账号", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
  return encryptedSession;
}

test("页面清单只做轻量统计，完整备份流式校验 25 表并保持 Session 密文", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  const encryptedSession = seedEncryptedSession(database);
  const d1 = new TestD1Database(database);
  const backupModule = await loadBackupModule(d1);

  const inventory = await backupModule.listDatabaseTables();
  assert.equal(inventory.tableCount, 25);
  assert.equal(inventory.totalRows, 1);
  assert.equal(d1.queries.some((sql) => /SELECT \*/i.test(sql)), false);
  assert.equal(d1.writes, 0);

  const text = await asText(backupModule.createDatabaseBackupStream());
  const validation = await backupModule.validateDatabaseBackupStream(asStream(text), d1);
  assert.equal(validation.valid, true);
  assert.equal(validation.tableCount, 25);
  assert.equal(validation.totalRows, 1);
  assert.match(text, new RegExp(encryptedSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /"telegramSession":"opaque-encrypted-ciphertext"/);
  assert.doesNotMatch(text, /cloud_sync_/);

  const tampered = text.replace(encryptedSession, "v1:ciphertext-only:changed");
  await assert.rejects(() => backupModule.validateDatabaseBackupStream(asStream(tampered)), /SHA-256/);
  assert.equal(d1.writes, 0);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__;
  database.close();
});

test("生产导出中途失败不会修改正式库，生产源码不含恢复写入路径", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  database.prepare("INSERT INTO app_logs(id,level,category,message,detail_json,created_at) VALUES (?,?,?,?,?,?)")
    .run("before", "info", "test", "unchanged", "{}", "2026-08-24T00:00:00.000Z");
  let fullReads = 0;
  const d1 = new TestD1Database(database, {
    beforeQuery(sql) {
      if (/SELECT \*/i.test(sql) && ++fullReads === 3) throw new Error("injected read failure");
    },
  });
  const backupModule = await loadBackupModule(d1);
  await assert.rejects(() => asText(backupModule.createDatabaseBackupStream()), /injected read failure/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_logs").get().count, 1);
  assert.equal(database.prepare("SELECT message FROM app_logs WHERE id='before'").get().message, "unchanged");
  assert.equal(d1.writes, 0);

  const [librarySource, routeSource, uiSource] = await Promise.all([
    readFile(projectFile("lib/database-backup.ts"), "utf8"),
    readFile(projectFile("app/api/database-backup/route.ts"), "utf8"),
    readFile(projectFile("app/components/database-backup-center.tsx"), "utf8"),
  ]);
  assert.doesNotMatch(librarySource, /\b(?:DELETE|INSERT|UPDATE|REPLACE)\s+(?:FROM|INTO)?/i);
  assert.doesNotMatch(routeSource, /restoreDatabaseBackup|action\s*===?\s*["']restore/i);
  assert.doesNotMatch(uiSource, /onClick=\{restore\}|恢复全部 25 张表/);
  const route = await loadRouteModule(d1);
  const disabledRestore = await route.POST(new Request("https://private.example/api/database-backup?action=restore", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-ndjson",
      "oai-authenticated-user-email": "owner@example.com",
    },
    body: "{}\n",
  }));
  assert.equal(disabledRestore.status, 400);
  assert.equal(d1.writes, 0);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__;
  database.close();
});

test("备份期间数据变化会使一致性完成标记失效", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  database.prepare("INSERT INTO app_logs(id,level,category,message,detail_json,created_at) VALUES (?,?,?,?,?,?)")
    .run("moving", "info", "test", "first-pass", "{}", "2026-08-24T00:00:00.000Z");
  let appLogScans = 0;
  const d1 = new TestD1Database(database, {
    beforeQuery(sql) {
      if (/SELECT \* FROM "app_logs"/i.test(sql) && ++appLogScans === 2) {
        database.prepare("UPDATE app_logs SET message='changed-during-backup' WHERE id='moving'").run();
      }
    },
  });
  const backupModule = await loadBackupModule(d1);
  const text = await asText(backupModule.createDatabaseBackupStream());
  assert.match(text, /"complete":false/);
  assert.match(text, /source_changed_during_backup/);
  await assert.rejects(() => backupModule.validateDatabaseBackupStream(asStream(text)), /源数据库发生变化/);
  assert.equal(d1.writes, 0);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__;
  database.close();
});

test("未获准用户不能读取清单、下载或校验备份", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  const d1 = new TestD1Database(database);
  const route = await loadRouteModule(d1);
  const inventory = await route.GET(new Request("https://private.example/api/database-backup?action=inventory"));
  const download = await route.GET(new Request("https://private.example/api/database-backup?action=download"));
  const validate = await route.POST(new Request("https://private.example/api/database-backup?action=validate", {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body: "{}\n",
  }));
  assert.equal(inventory.status, 401);
  assert.equal(download.status, 401);
  assert.equal(validate.status, 401);
  assert.equal(d1.queries.length, 0);
  assert.equal(d1.writes, 0);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__;
  database.close();
});

test("备份只允许恢复演练到全新临时 D1", async () => {
  const source = new DatabaseSync(":memory:");
  await applySchema(source);
  const encryptedSession = seedEncryptedSession(source);
  const sourceModule = await loadBackupModule(new TestD1Database(source));
  const text = await asText(sourceModule.createDatabaseBackupStream());

  const temporary = new DatabaseSync(":memory:");
  await applySchema(temporary);
  const temporaryD1 = new TestD1Database(temporary);
  const temporaryModule = await loadBackupModule(temporaryD1);
  const result = await restoreBackupIntoFreshTemporaryD1({ text, db: temporaryD1, backupModule: temporaryModule });
  assert.equal(result.valid, true);
  assert.equal(temporary.prepare("SELECT encrypted_session FROM telegram_accounts WHERE id='owner'").get().encrypted_session, encryptedSession);

  await assert.rejects(
    () => restoreBackupIntoFreshTemporaryD1({ text, db: temporaryD1, backupModule: temporaryModule }),
    /fresh and empty/,
  );
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__;
  source.close();
  temporary.close();
});

test("Miniflare Workers D1 可流式备份并校验 10 万行", { timeout: 180_000 }, async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "00000000-0000-0000-0000-000000000027" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await applyMiniflareSchema(db);
    await db.prepare(`WITH RECURSIVE counter(value) AS (
      SELECT 0 UNION ALL SELECT value + 1 FROM counter WHERE value < 99999
    )
    INSERT INTO app_logs(id,level,category,message,detail_json,created_at)
    SELECT printf('load-%06d', value),'info','miniflare',printf('synthetic row %d', value),printf('{"index":%d}', value),'2026-08-24T00:00:00.000Z'
    FROM counter`).run();
    assert.equal(Number((await db.prepare("SELECT COUNT(*) AS count FROM app_logs").first()).count), 100_000);
    const backupModule = await loadBackupModule(db);
    const validation = await backupModule.validateDatabaseBackupStream(backupModule.createDatabaseBackupStream(), db);
    assert.equal(validation.valid, true);
    assert.equal(validation.totalRows, 100_000);
    assert.equal(validation.tables.find((table) => table.name === "app_logs").rowCount, 100_000);
  } finally {
    delete globalThis.__DATABASE_BACKUP_TEST_ENV__;
    await mf.dispose();
  }
});

test("Windows 中文路径测试帮助器使用 fileURLToPath，不再拼出重复盘符", async () => {
  const helper = await readFile(projectFile("tests/helpers/bundle.mjs"), "utf8");
  assert.match(helper, /fileURLToPath\(new URL\("\.\.\/\.\.\/"/);
  assert.doesNotMatch(helper, /new URL\(import\.meta\.url\)\.pathname/);
});
