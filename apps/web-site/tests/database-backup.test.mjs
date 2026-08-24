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
  async all() { this.owner.beforeQuery(this.sql); return { success: true, results: this.owner.database.prepare(this.sql).all(...this.values) }; }
  async first() { this.owner.beforeQuery(this.sql); return this.owner.database.prepare(this.sql).get(...this.values) ?? null; }
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

class TestD1Session {
  constructor(owner) { this.owner = owner; this.seenVersion = null; }
  get database() { return this.owner.database; }
  beforeQuery(sql) { this.owner.beforeQuery(sql); this.seenVersion = this.owner.version; }
  prepare(sql) { return new TestPreparedStatement(this, sql); }
  getBookmark() { return this.seenVersion === null ? null : `bookmark-${String(this.seenVersion).padStart(8, "0")}`; }
}

class TestD1Database {
  constructor(database, hooks = {}, queryLimit = 40) {
    this.database = database; this.hooks = hooks; this.queryLimit = queryLimit;
    this.queries = []; this.writes = 0; this.version = 0;
    this.invocationQueries = 0; this.maxInvocationQueries = 0;
  }
  beginInvocation() { this.invocationQueries = 0; }
  bumpBookmark() { this.version += 1; }
  beforeQuery(sql) {
    this.invocationQueries += 1;
    this.maxInvocationQueries = Math.max(this.maxInvocationQueries, this.invocationQueries);
    if (this.invocationQueries > this.queryLimit) throw new Error(`D1 query budget exceeded: ${this.invocationQueries} > ${this.queryLimit}`);
    this.queries.push(sql);
    if (/^\s*(?:DELETE|INSERT|UPDATE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) this.writes += 1;
    this.hooks.beforeQuery?.(sql, this);
  }
  prepare(sql) { return new TestPreparedStatement(this, sql); }
  withSession() { return new TestD1Session(this); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.executeForBatch());
      this.database.exec("COMMIT"); return results;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

class CountingStatement {
  constructor(owner, statement) { this.owner = owner; this.statement = statement; }
  bind(...values) { return new CountingStatement(this.owner, this.statement.bind(...values)); }
  async all() { this.owner.count(); return this.statement.all(); }
  async first(column) { this.owner.count(); return this.statement.first(column); }
  async run() { this.owner.count(); return this.statement.run(); }
}

class CountingSession {
  constructor(owner, session) { this.owner = owner; this.session = session; }
  prepare(sql) { return new CountingStatement(this.owner, this.session.prepare(sql)); }
  getBookmark() { return this.session.getBookmark(); }
}

class CountingD1 {
  constructor(database, queryLimit = 40) {
    this.database = database; this.queryLimit = queryLimit;
    this.invocationQueries = 0; this.maxInvocationQueries = 0;
  }
  beginInvocation() { this.invocationQueries = 0; }
  count() {
    this.invocationQueries += 1;
    this.maxInvocationQueries = Math.max(this.maxInvocationQueries, this.invocationQueries);
    if (this.invocationQueries > this.queryLimit) throw new Error(`D1 query budget exceeded: ${this.invocationQueries} > ${this.queryLimit}`);
  }
  prepare(sql) { return new CountingStatement(this, this.database.prepare(sql)); }
  withSession(constraint) { return new CountingSession(this, this.database.withSession(constraint)); }
}

const MIGRATIONS = [
  "drizzle/0000_fantastic_paper_doll.sql", "drizzle/0001_ambitious_bloodscream.sql",
  "drizzle/0002_small_garia.sql", "drizzle/0003_glossy_bloodaxe.sql", "drizzle/0004_classy_pixie.sql",
];

async function applySchema(database) {
  for (const file of MIGRATIONS) database.exec((await readFile(projectFile(file), "utf8")).replaceAll("--> statement-breakpoint", "\n"));
  database.exec("PRAGMA foreign_keys=ON");
}

async function applyMiniflareSchema(database) {
  for (const file of MIGRATIONS) {
    const source = await readFile(projectFile(file), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await database.prepare(statement).run();
  }
  await database.prepare("PRAGMA foreign_keys=ON").run();
}

async function loadBuiltModule(entry, database) {
  globalThis.__DATABASE_BACKUP_TEST_ENV__ = { DB: database };
  const result = await build({
    entryPoints: [fileURLToPath(projectFile(entry))], bundle: true, format: "esm", platform: "node", target: "node22", write: false,
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
const loadFormatModule = () => loadBuiltModule("lib/database-backup-format.ts", {});
const loadRouteModule = (database) => loadBuiltModule("app/api/database-backup/route.ts", database);
const asStream = (text) => new Blob([text]).stream();

function seedEncryptedSession(database) {
  const encryptedSession = "v1:ciphertext-only:AAECAwQFBgc=";
  database.prepare("INSERT INTO telegram_accounts(id,status,encrypted_session,account_key,account_label,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("owner", "authorized", encryptedSession, "opaque-account-key", "测试账号", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
  return encryptedSession;
}

async function buildBackupByRequests(backupModule, formatModule, database, onPage) {
  database.beginInvocation();
  const inventory = await backupModule.listDatabaseTables();
  assert.equal(database.invocationQueries, 2);
  const records = [backupModule.createBackupHeader(inventory, "2026-08-24T00:00:00.000Z")];
  const manifests = [];
  let pageRequests = 0;
  let bookmark = inventory.bookmark;
  for (const phase of ["export", "verify"]) {
    for (let tableIndex = 0; tableIndex < inventory.tables.length; tableIndex += 1) {
      const table = inventory.tables[tableIndex];
      let cursor = null; let pageIndex = 0; let rowCount = 0;
      let digest = formatModule.DATABASE_BACKUP_INITIAL_DIGEST;
      if (phase === "export") records.push({ type: "table", name: table.name, columns: table.columns, primaryKey: table.primaryKey });
      for (;;) {
        database.beginInvocation();
        await onPage?.({ phase, table, pageIndex, database });
        const page = await backupModule.readDatabaseBackupPage({ table: table.name, cursor, bookmark });
        pageRequests += 1;
        assert.ok(database.invocationQueries <= 40);
        assert.equal(page.queryCount, 2);
        assert.equal(page.consistent, true);
        assert.ok(page.bookmark >= bookmark);
        bookmark = page.bookmark;
        assert.ok(page.rowCount <= formatModule.DATABASE_BACKUP_PAGE_MAX_ROWS);
        if (page.rows.length) {
          digest = await formatModule.nextBackupDigest(digest, pageIndex, page.rows);
          rowCount += page.rows.length;
          if (phase === "export") records.push({ type: "page", table: table.name, index: pageIndex, rows: page.rows });
          pageIndex += 1;
        }
        cursor = page.nextCursor;
        if (page.done) break;
      }
      if (phase === "export") {
        assert.equal(rowCount, table.rowCount);
        const manifest = { name: table.name, rowCount, sha256: digest, primaryKey: table.primaryKey };
        manifests.push(manifest); records.push({ type: "table_end", ...manifest });
      } else {
        assert.equal(rowCount, manifests[tableIndex].rowCount);
        assert.equal(digest, manifests[tableIndex].sha256);
      }
    }
  }
  database.beginInvocation();
  const final = await backupModule.finalizeDatabaseBackup(bookmark);
  assert.equal(final.queryCount, 1);
  assert.equal(final.consistent, true);
  records.push(await backupModule.createBackupFooter(manifests, inventory.bookmark, final.endBookmark, true));
  return { inventory, manifests, pageRequests, text: `${records.map(JSON.stringify).join("\n")}\n` };
}

test("清单合并为 2 次查询，分页备份保持 Session 密文且每请求最多 2 次查询", async () => {
  const sqlite = new DatabaseSync(":memory:"); await applySchema(sqlite);
  const encryptedSession = seedEncryptedSession(sqlite);
  const d1 = new TestD1Database(sqlite);
  const backupModule = await loadBackupModule(d1); const formatModule = await loadFormatModule();
  const result = await buildBackupByRequests(backupModule, formatModule, d1);
  assert.equal(result.inventory.tableCount, 25); assert.equal(result.inventory.totalRows, 1);
  assert.equal(d1.maxInvocationQueries, 2); assert.equal(d1.writes, 0);
  assert.match(result.text, new RegExp(encryptedSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.text, /"telegramSession":"opaque-encrypted-ciphertext"/);
  assert.doesNotMatch(result.text, /cloud_sync_/);
  d1.beginInvocation();
  const validation = await backupModule.validateDatabaseBackupStream(asStream(result.text), d1);
  assert.equal(validation.valid, true); assert.equal(validation.queryCount, 1);
  const tampered = result.text.replace(encryptedSession, "v1:ciphertext-only:changed");
  await assert.rejects(() => backupModule.validateDatabaseBackupStream(asStream(tampered)), /SHA-256/);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__; sqlite.close();
});

test("超过 40 次 D1 查询的单次 invocation 被测试替身强制终止", async () => {
  const sqlite = new DatabaseSync(":memory:"); const d1 = new TestD1Database(sqlite, {}, 40);
  d1.beginInvocation();
  for (let index = 0; index < 40; index += 1) await d1.prepare("SELECT 1").first();
  await assert.rejects(() => d1.prepare("SELECT 1").first(), /query budget exceeded: 41 > 40/);
  sqlite.close();
});

test("非安全 HTTP 预览没有 Web Crypto 时仍可计算标准 SHA-256", async () => {
  const formatModule = await loadFormatModule();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    assert.equal(
      await formatModule.backupSha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
});

test("生产读取中途失败零写入，旧单请求下载与恢复 API 均禁用", async () => {
  const sqlite = new DatabaseSync(":memory:"); await applySchema(sqlite);
  sqlite.prepare("INSERT INTO app_logs(id,level,category,message,detail_json,created_at) VALUES (?,?,?,?,?,?)")
    .run("before", "info", "test", "unchanged", "{}", "2026-08-24T00:00:00.000Z");
  const d1 = new TestD1Database(sqlite, { beforeQuery(sql) { if (/WITH candidates/i.test(sql)) throw new Error("injected read failure"); } });
  const route = await loadRouteModule(d1);
  d1.beginInvocation();
  const failed = await route.POST(new Request("https://private.example/api/database-backup?action=page", {
    method: "POST", headers: { "Content-Type": "application/json", "oai-authenticated-user-email": "owner@example.com" },
    body: JSON.stringify({ table: "app_logs", cursor: null, bookmark: "bookmark-00000000" }),
  }));
  assert.equal(failed.status, 400);
  assert.equal(sqlite.prepare("SELECT message FROM app_logs WHERE id='before'").get().message, "unchanged");
  assert.equal(d1.writes, 0);
  const [librarySource, routeSource] = await Promise.all([
    readFile(projectFile("lib/database-backup.ts"), "utf8"), readFile(projectFile("app/api/database-backup/route.ts"), "utf8"),
  ]);
  assert.doesNotMatch(librarySource, /\b(?:DELETE|INSERT|UPDATE|REPLACE)\s+(?:FROM|INTO)?/i);
  assert.doesNotMatch(routeSource, /action\s*===?\s*["']restore|createDatabaseBackupStream/i);
  const oldDownload = await route.GET(new Request("https://private.example/api/database-backup?action=download", { headers: { "oai-authenticated-user-email": "owner@example.com" } }));
  assert.equal(oldDownload.status, 400);
  const restore = await route.POST(new Request("https://private.example/api/database-backup?action=restore", {
    method: "POST", headers: { "Content-Type": "application/json", "oai-authenticated-user-email": "owner@example.com" }, body: "{}",
  }));
  assert.equal(restore.status, 400); assert.equal(d1.writes, 0);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__; sqlite.close();
});

test("跨请求期间表数据变化会由第二遍 SHA-256 明确判定无效", async () => {
  const sqlite = new DatabaseSync(":memory:"); await applySchema(sqlite);
  sqlite.prepare("INSERT INTO app_logs(id,level,category,message,detail_json,created_at) VALUES (?,?,?,?,?,?)")
    .run("moving", "info", "test", "first", "{}", "2026-08-24T00:00:00.000Z");
  const d1 = new TestD1Database(sqlite); const backupModule = await loadBackupModule(d1); const formatModule = await loadFormatModule();
  d1.beginInvocation(); const inventory = await backupModule.listDatabaseTables();
  d1.beginInvocation();
  const first = await backupModule.readDatabaseBackupPage({ table: "app_logs", cursor: null, bookmark: inventory.bookmark });
  const firstDigest = await formatModule.nextBackupDigest(formatModule.DATABASE_BACKUP_INITIAL_DIGEST, 0, first.rows);
  sqlite.prepare("UPDATE app_logs SET message='changed' WHERE id='moving'").run(); d1.bumpBookmark();
  d1.beginInvocation();
  const second = await backupModule.readDatabaseBackupPage({ table: "app_logs", cursor: null, bookmark: first.bookmark });
  const secondDigest = await formatModule.nextBackupDigest(formatModule.DATABASE_BACKUP_INITIAL_DIGEST, 0, second.rows);
  assert.equal(second.consistent, true); assert.notEqual(secondDigest, firstDigest); assert.ok(second.bookmark > first.bookmark); assert.equal(d1.writes, 0);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__; sqlite.close();
});

test("UTF-8 字节与行数共同限制分页且不使用 OFFSET", async () => {
  const sqlite = new DatabaseSync(":memory:"); await applySchema(sqlite);
  const insert = sqlite.prepare("INSERT INTO app_logs(id,level,category,message,detail_json,created_at) VALUES (?,?,?,?,?,?)");
  for (let index = 0; index < 180; index += 1) insert.run(`wide-${String(index).padStart(4, "0")}`, "info", "bytes", "中".repeat(2_000), "{}", "2026-08-24T00:00:00.000Z");
  const d1 = new TestD1Database(sqlite); const backupModule = await loadBackupModule(d1);
  d1.beginInvocation(); const inventory = await backupModule.listDatabaseTables();
  d1.beginInvocation(); const page = await backupModule.readDatabaseBackupPage({ table: "app_logs", cursor: null, bookmark: inventory.bookmark });
  assert.equal(page.done, false); assert.ok(page.rowCount < 180); assert.ok(page.utf8Bytes <= 512 * 1024);
  assert.equal(d1.queries.some((sql) => /\bOFFSET\b/i.test(sql)), false); assert.equal(d1.invocationQueries, 2);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__; sqlite.close();
});

test("未获准用户不能读取清单、分页、完成探针或校验备份", async () => {
  const sqlite = new DatabaseSync(":memory:"); await applySchema(sqlite);
  const d1 = new TestD1Database(sqlite); const route = await loadRouteModule(d1);
  const responses = [
    await route.GET(new Request("https://private.example/api/database-backup?action=inventory")),
    await route.POST(new Request("https://private.example/api/database-backup?action=page", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
    await route.POST(new Request("https://private.example/api/database-backup?action=finalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
    await route.POST(new Request("https://private.example/api/database-backup?action=validate", { method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body: "{}\n" })),
  ];
  assert.deepEqual(responses.map((response) => response.status), [401, 401, 401, 401]);
  assert.equal(d1.queries.length, 0); assert.equal(d1.writes, 0);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__; sqlite.close();
});

test("完整文件只允许恢复演练到全新临时 D1", async () => {
  const source = new DatabaseSync(":memory:"); await applySchema(source); const encryptedSession = seedEncryptedSession(source);
  const sourceD1 = new TestD1Database(source); const sourceModule = await loadBackupModule(sourceD1); const formatModule = await loadFormatModule();
  const { text } = await buildBackupByRequests(sourceModule, formatModule, sourceD1);
  const temporary = new DatabaseSync(":memory:"); await applySchema(temporary);
  const temporaryD1 = new TestD1Database(temporary, {}, 500); const temporaryModule = await loadBackupModule(temporaryD1);
  const result = await restoreBackupIntoFreshTemporaryD1({ text, db: temporaryD1, backupModule: temporaryModule });
  assert.equal(result.valid, true);
  assert.equal(temporary.prepare("SELECT encrypted_session FROM telegram_accounts WHERE id='owner'").get().encrypted_session, encryptedSession);
  await assert.rejects(() => restoreBackupIntoFreshTemporaryD1({ text, db: temporaryD1, backupModule: temporaryModule }), /fresh and empty/);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__; source.close(); temporary.close();
});

test("v30 分块计算不修改旧 job.sequence，原子提交代码同时写 jobs 与 chunks", async () => {
  const storageModule = await loadBuiltModule("lib/database-backup-indexeddb.ts", {});
  const checkpoint = { sequence: 9 };
  const batch = storageModule.makeBackupChunks(checkpoint.sequence, [
    { type: "page", table: "app_logs", index: 0, rows: [{ id: "once" }] },
    { type: "table_end", name: "app_logs", rowCount: 1, sha256: "digest" },
  ]);
  assert.equal(checkpoint.sequence, 9);
  assert.equal(batch.nextSequence, 11);
  assert.deepEqual(batch.chunks.map((chunk) => chunk.sequence), [9, 10]);
  assert.ok(batch.utf8Bytes > 0);

  const source = await readFile(projectFile("lib/database-backup-indexeddb.ts"), "utf8");
  assert.doesNotMatch(source, /job\.sequence\+\+|sequence\s*\+=/);
  assert.match(source, /database\.transaction\(\["jobs", "chunks"\], "readwrite"\)/);
  assert.match(source, /objectStore\("jobs"\)\.put\(nextJob\)/);
  assert.match(source, /objectStore\("chunks"\)\.put\(chunk\)/);
  assert.match(source, /QuotaExceededError/);
  assert.match(source, /InvalidStateError/);
});

test("真实 Chromium IndexedDB 回归脚本覆盖四类事务失败、分页重试与 footer 原子完成", async () => {
  const source = await readFile(projectFile("tests/database-backup-indexeddb-browser.mjs"), "utf8");
  for (const fault of ["quota", "abort", "close", "error"]) assert.match(source, new RegExp(`\\"${fault}\\"`));
  assert.match(source, /inventory network request must succeed before forced transaction failure/);
  assert.match(source, /retry must persist the page exactly once/);
  assert.match(source, /footer transaction failure must not display a durable complete job/);
  assert.match(source, /final checkpoint must retain all 25 table manifests/);
  assert.match(source, /stored chunks must be contiguous through footer/);
  assert.match(source, /models a page refresh/);
});

test("Miniflare Workers D1 的 10 万行必须由数百个受限请求完成", { timeout: 240_000 }, async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "00000000-0000-0000-0000-000000000029" } });
  try {
    const raw = await mf.getD1Database("DB"); await applyMiniflareSchema(raw);
    await raw.prepare(`WITH RECURSIVE counter(value) AS (
      SELECT 0 UNION ALL SELECT value + 1 FROM counter WHERE value < 99999
    ) INSERT INTO app_logs(id,level,category,message,detail_json,created_at)
      SELECT printf('load-%06d', value),'info','miniflare',printf('synthetic row %d', value),printf('{"index":%d}', value),'2026-08-24T00:00:00.000Z' FROM counter`).run();
    assert.equal(Number((await raw.prepare("SELECT COUNT(*) AS count FROM app_logs").first()).count), 100_000);
    const d1 = new CountingD1(raw, 40); const backupModule = await loadBackupModule(d1); const formatModule = await loadFormatModule();
    const result = await buildBackupByRequests(backupModule, formatModule, d1);
    assert.equal(result.pageRequests, 448);
    assert.equal(result.pageRequests + 2, 450);
    assert.equal(d1.maxInvocationQueries, 2);
    d1.beginInvocation(); const validation = await backupModule.validateDatabaseBackupStream(asStream(result.text), d1);
    assert.equal(validation.totalRows, 100_000); assert.equal(validation.queryCount, 1);
  } finally { delete globalThis.__DATABASE_BACKUP_TEST_ENV__; await mf.dispose(); }
});

test("Windows 中文路径测试帮助器使用 fileURLToPath，不再拼出重复盘符", async () => {
  const helper = await readFile(projectFile("tests/helpers/bundle.mjs"), "utf8");
  assert.match(helper, /fileURLToPath\(new URL\("\.\.\/\.\.\/"/);
  assert.doesNotMatch(helper, /new URL\(import\.meta\.url\)\.pathname/);
});
