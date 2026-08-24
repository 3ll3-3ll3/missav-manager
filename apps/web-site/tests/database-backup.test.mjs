import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { projectFile } from "./helpers/bundle.mjs";

class TestPreparedStatement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new TestPreparedStatement(this.database, this.sql, values); }
  async all() { return { success: true, results: this.database.prepare(this.sql).all(...this.values) }; }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
  executeForBatch() { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
}

class TestD1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new TestPreparedStatement(this.database, sql); }
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

async function applySchema(database) {
  for (const file of [
    "drizzle/0000_fantastic_paper_doll.sql",
    "drizzle/0001_ambitious_bloodscream.sql",
    "drizzle/0002_small_garia.sql",
    "drizzle/0003_glossy_bloodaxe.sql",
    "drizzle/0004_classy_pixie.sql",
  ]) {
    database.exec((await readFile(projectFile(file), "utf8")).replaceAll("--> statement-breakpoint", "\n"));
  }
  database.exec("PRAGMA foreign_keys=ON");
}

async function loadBackupModule(database) {
  globalThis.__DATABASE_BACKUP_TEST_ENV__ = { DB: new TestD1Database(database) };
  const entry = fileURLToPath(projectFile("lib/database-backup.ts"));
  const result = await build({
    entryPoints: [entry], bundle: true, format: "esm", platform: "node", target: "node22", write: false,
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

test("v26 完整备份固定 25 表并保持 Telegram Session 为不透明加密密文", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  const encryptedSession = "v1:ciphertext-only:AAECAwQFBgc=";
  database.prepare("INSERT INTO telegram_accounts(id,status,encrypted_session,account_key,account_label,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("owner", "authorized", encryptedSession, "opaque-account-key", "测试账号", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
  const backupModule = await loadBackupModule(database);
  const backup = await backupModule.createDatabaseBackup();
  const validation = await backupModule.validateDatabaseBackup(backup, globalThis.__DATABASE_BACKUP_TEST_ENV__.DB);
  assert.equal(backup.manifest.tableCount, 25);
  assert.equal(new Set(backup.tables.map((table) => table.name)).size, 25);
  assert.equal(backup.tables.some((table) => table.name.startsWith("cloud_sync_")), false);
  assert.equal(validation.valid, true);
  assert.deepEqual(backup.security, { telegramSession: "opaque-encrypted-ciphertext", decrypted: false, displayed: false });
  assert.equal(backup.tables.find((table) => table.name === "telegram_accounts").rows[0].encrypted_session, encryptedSession);
  const tampered = structuredClone(backup);
  tampered.tables.find((table) => table.name === "telegram_accounts").rows[0].encrypted_session = "changed";
  await assert.rejects(() => backupModule.validateDatabaseBackup(tampered), /SHA-256/);
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__;
  database.close();
});

test("10 万行备份可在临时 D1 完整恢复并通过恢复后 SHA-256 复核", { timeout: 120_000 }, async () => {
  const source = new DatabaseSync(":memory:");
  await applySchema(source);
  source.exec("BEGIN IMMEDIATE");
  const insert = source.prepare("INSERT INTO app_logs(id,level,category,message,detail_json,created_at) VALUES (?,?,?,?,?,?)");
  for (let index = 0; index < 100_000; index += 1) {
    insert.run(`load-${String(index).padStart(6, "0")}`, "info", "backup-load", `synthetic row ${index}`, JSON.stringify({ index }), "2026-08-24T00:00:00.000Z");
  }
  source.exec("COMMIT");
  const sourceModule = await loadBackupModule(source);
  const backup = await sourceModule.createDatabaseBackup();
  assert.equal(backup.manifest.totalRows, 100_000);
  assert.equal(backup.tables.find((table) => table.name === "app_logs").rowCount, 100_000);

  const temporary = new DatabaseSync(":memory:");
  await applySchema(temporary);
  const temporaryModule = await loadBackupModule(temporary);
  await assert.rejects(() => temporaryModule.restoreDatabaseBackup(backup, "wrong"), /RESTORE 25 TABLES/);
  const result = await temporaryModule.restoreDatabaseBackup(backup, temporaryModule.RESTORE_CONFIRMATION);
  assert.deepEqual(result, { restored: true, tableCount: 25, totalRows: 100_000, sha256: backup.manifest.sha256 });
  assert.equal(temporary.prepare("SELECT COUNT(*) AS count FROM app_logs").get().count, 100_000);
  assert.equal(temporary.prepare("SELECT message FROM app_logs WHERE id=?").get("load-099999").message, "synthetic row 99999");
  delete globalThis.__DATABASE_BACKUP_TEST_ENV__;
  source.close();
  temporary.close();
});
