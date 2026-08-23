import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { projectFile } from "./helpers/bundle.mjs";

class Prepared {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new Prepared(this.database, this.sql, values); }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values), success: true, meta: {} }; }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { results: [], success: true, meta: { changes: Number(result.changes) } }; }
  executeForBatch() {
    if (/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(this.sql)) return { results: this.database.prepare(this.sql).all(...this.values), success: true, meta: { changes: 0 } };
    const result = this.database.prepare(this.sql).run(...this.values);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

class TestD1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Prepared(this.database, sql); }
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

async function loadCloudSync(env) {
  globalThis.__CLOUD_SYNC_TEST_ENV__ = env;
  const entry = fileURLToPath(projectFile("lib/cloud-sync.ts"));
  const result = await build({
    entryPoints: [entry], bundle: true, format: "esm", platform: "node", target: "node22", write: false,
    plugins: [{
      name: "cloud-sync-test-env",
      setup(api) {
        api.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers", namespace: "test-env" }));
        api.onLoad({ filter: /.*/, namespace: "test-env" }, () => ({ contents: "export const env=globalThis.__CLOUD_SYNC_TEST_ENV__;", loader: "js" }));
        api.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw" }));
        api.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({ contents: `export default ${JSON.stringify(await readFile(args.path, "utf8"))}`, loader: "js" }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${Date.now()}`);
}

async function applyWebMigrations(database) {
  const files = [
    "0000_fantastic_paper_doll.sql", "0001_ambitious_bloodscream.sql", "0002_small_garia.sql",
    "0003_glossy_bloodaxe.sql", "0004_classy_pixie.sql", "0005_workflow_contract.sql", "0006_spicy_omega_sentinel.sql",
  ];
  for (const file of files) {
    const sql = await readFile(projectFile(`drizzle/${file}`), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", "\n"));
  }
}

async function gatewayJson(worker, gatewayEnv, pathName, options = {}) {
  const response = await worker.default.fetch(new Request(`https://sync.test${pathName}`, options), gatewayEnv);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

test("网页 D1 经真实网关完成 Push、Pull 与墓碑删除，且设备凭据不返回浏览器状态", async () => {
  const webSqlite = new DatabaseSync(":memory:");
  await applyWebMigrations(webSqlite);
  const gatewaySqlite = new DatabaseSync(":memory:");
  gatewaySqlite.exec(await readFile(new URL("../../sync-service/migrations/0001_initial.sql", import.meta.url), "utf8"));
  const gatewayWorker = await import(new URL("../../sync-service/src/index.mjs", import.meta.url));
  const adminToken = "integration-admin-token-at-least-32-characters";
  const gatewayEnv = { DB: new TestD1(gatewaySqlite), SYNC_ADMIN_TOKEN: adminToken };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request, options) => {
    const normalized = request instanceof Request ? request : new Request(request, options);
    if (new URL(normalized.url).hostname === "sync.test") return gatewayWorker.default.fetch(normalized, gatewayEnv);
    return originalFetch(request, options);
  };
  try {
    const cloud = await loadCloudSync({ DB: new TestD1(webSqlite), SYNC_GATEWAY_URL: "https://sync.test", SYNC_ADMIN_TOKEN: adminToken });
    const initial = await cloud.cloudSyncStatus();
    assert.equal(initial.paired, false);
    assert.equal("deviceToken" in initial, false);

    const timestamp = "2026-08-23T12:00:00.000Z";
    webSqlite.prepare(
      `INSERT INTO permanent_records(id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("local-record", "missav", "ABF-001", "ABF-001", "", "new", "[]", "[]", "[]", "", "", "", "{}", timestamp, timestamp);
    const preview = await cloud.createCloudSyncPreview();
    assert.equal(preview.pendingUpload, 1);
    const pushed = await cloud.executeCloudSync("push");
    assert.equal(pushed.push.accepted, 1);
    assert.equal(gatewaySqlite.prepare("SELECT COUNT(*) AS count FROM sync_entities WHERE entity_key='record:missav:abf-001'").get().count, 1);

    const pairing = await gatewayJson(gatewayWorker, gatewayEnv, "/v1/admin/pairings", {
      method: "POST", headers: { "content-type": "application/json", "x-sync-admin-token": adminToken }, body: JSON.stringify({ label: "remote-test" }),
    });
    const remote = await gatewayJson(gatewayWorker, gatewayEnv, "/v1/devices/exchange", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing.code, nodeId: "remote-test-node", label: "remote-test" }),
    });
    await cloud.withCloudTelegramSourceLeases([], "telegram-bot", async (assertActive) => {
      assertActive();
      const response = await gatewayWorker.default.fetch(new Request("https://sync.test/v1/leases/acquire", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${remote.deviceToken}` },
        body: JSON.stringify({ leaseKey: "telegram:bot:global-offset", ttlSeconds: 120 }),
      }), gatewayEnv);
      assert.equal(response.status, 409, "另一端不能同时推进同一 Bot offset");
    });
    webSqlite.prepare(
      `INSERT INTO input_sources(id,kind,external_key,name,metadata_json,created_at,updated_at,connection_id,external_chat_id)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run("personal-source", "telegram_personal", "-100123", "测试频道", "{}", timestamp, timestamp, "telegram-personal", "-100123");
    await cloud.withCloudTelegramSourceLeases(["personal-source"], "telegram-personal", async (assertActive) => {
      assertActive();
      const response = await gatewayWorker.default.fetch(new Request("https://sync.test/v1/leases/acquire", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${remote.deviceToken}` },
        body: JSON.stringify({ leaseKey: "telegram:personal:-100123", ttlSeconds: 120 }),
      }), gatewayEnv);
      assert.equal(response.status, 409, "另一端不能同时拉取同一份个人账号来源");
    });
    const sourcePreview = await cloud.createCloudSyncPreview();
    assert.ok(sourcePreview.pendingUpload >= 1);
    await cloud.executeCloudSync("push");
    assert.equal(
      gatewaySqlite.prepare("SELECT COUNT(*) AS count FROM sync_entities WHERE entity_key='source:telegram_personal:default:-100123'").get().count,
      1,
      "网页连接别名必须与桌面 default 来源使用同一自然键",
    );
    const remoteMessagePayload = {
      sourceKey: "telegram_personal:default:-100123",
      messageId: "77",
      externalMessageId: "77",
      messageDate: timestamp,
      body: "跨端来源映射验证",
      eventKind: "message",
      contentHash: "source-map-test",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await gatewayJson(gatewayWorker, gatewayEnv, "/v1/sync/push", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${remote.deviceToken}` },
      body: JSON.stringify({ operations: [{ schemaVersion: 1, operationId: "remote-message-source-map", nodeId: "remote-test-node", entityType: "telegram_message", entityKey: "message:telegram_personal:default:-100123:77", action: "upsert", baseVersion: 0, occurredAt: timestamp, payload: remoteMessagePayload }] }),
    });
    await cloud.createCloudSyncPreview();
    await cloud.executeCloudSync("pull");
    assert.equal(
      webSqlite.prepare("SELECT source_id FROM telegram_messages WHERE message_id='77'").get().source_id,
      "personal-source",
      "Pull 必须复用网页既有来源，不能创建重复来源 ID",
    );
    assert.equal(webSqlite.prepare("SELECT COUNT(*) AS count FROM input_sources WHERE external_key='-100123'").get().count, 1);
    webSqlite.prepare("UPDATE permanent_records SET status='local-change',updated_at=? WHERE record_key='ABF-001'").run("2026-08-23T12:00:30.000Z");
    await cloud.createCloudSyncPreview();
    const remoteAbf = { ...webSqlite.prepare("SELECT primary_value FROM permanent_records WHERE record_key='ABF-001'").get(), ...{
      tool: "missav", recordKey: "ABF-001", primaryValue: "ABF-001", secondaryValue: "", status: "remote-change",
      tags: [], actressTags: [], genreTags: [], sourceUrl: "", missavUrl: "", av123Url: "", metadata: {}, createdAt: timestamp, updatedAt: "2026-08-23T12:00:40.000Z",
    } };
    await gatewayJson(gatewayWorker, gatewayEnv, "/v1/sync/push", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${remote.deviceToken}` },
      body: JSON.stringify({ operations: [{ schemaVersion: 1, operationId: "remote-conflict-1", nodeId: "remote-test-node", entityType: "permanent_record", entityKey: "record:missav:abf-001", action: "upsert", baseVersion: 1, occurredAt: remoteAbf.updatedAt, payload: remoteAbf }] }),
    });
    const conflicted = await cloud.executeCloudSync("push");
    assert.equal(conflicted.push.rejected, 1);
    const conflictStatus = await cloud.cloudSyncStatus();
    assert.equal(conflictStatus.conflicts, 1);
    await cloud.resolveCloudSyncConflict(conflictStatus.conflictRows.find((row) => row.status === "open").id, "remote");
    assert.equal(webSqlite.prepare("SELECT status FROM permanent_records WHERE record_key='ABF-001'").get().status, "remote-change");

    const remotePayload = {
      tool: "missav", recordKey: "SSIS-777", primaryValue: "SSIS-777", secondaryValue: "", status: "new",
      tags: ["远端"], actressTags: [], genreTags: [], sourceUrl: "", missavUrl: "", av123Url: "", metadata: {}, createdAt: timestamp, updatedAt: timestamp,
    };
    await gatewayJson(gatewayWorker, gatewayEnv, "/v1/sync/push", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${remote.deviceToken}` },
      body: JSON.stringify({ operations: [{ schemaVersion: 1, operationId: "remote-upsert-1", nodeId: "remote-test-node", entityType: "permanent_record", entityKey: "record:missav:ssis-777", action: "upsert", baseVersion: 0, occurredAt: timestamp, payload: remotePayload }] }),
    });
    await cloud.createCloudSyncPreview();
    const pulled = await cloud.executeCloudSync("pull");
    assert.equal(pulled.pull.applied, 1);
    assert.equal(webSqlite.prepare("SELECT primary_value FROM permanent_records WHERE tool='missav' AND record_key='SSIS-777'").get().primary_value, "SSIS-777");

    await gatewayJson(gatewayWorker, gatewayEnv, "/v1/sync/push", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${remote.deviceToken}` },
      body: JSON.stringify({ operations: [{ schemaVersion: 1, operationId: "remote-delete-1", nodeId: "remote-test-node", entityType: "permanent_record", entityKey: "record:missav:ssis-777", action: "delete", baseVersion: 1, occurredAt: "2026-08-23T12:01:00.000Z", payload: null }] }),
    });
    await cloud.createCloudSyncPreview();
    await cloud.executeCloudSync("pull");
    assert.equal(webSqlite.prepare("SELECT COUNT(*) AS count FROM permanent_records WHERE record_key='SSIS-777'").get().count, 0);
    assert.equal(webSqlite.prepare("SELECT COUNT(*) AS count FROM cloud_sync_dirty").get().count, 0, "Pull must not echo into outbox");

    const bulkInsert = webSqlite.prepare(
      `INSERT INTO permanent_records(id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    webSqlite.exec("BEGIN");
    for (let index = 0; index < 5_001; index += 1) {
      const code = `BULK-${String(index).padStart(5, "0")}`;
      bulkInsert.run(`bulk-${index}`, "missav", code, code, "", "new", "[]", "[]", "[]", "", "", "", "{}", timestamp, timestamp);
    }
    webSqlite.exec("COMMIT");
    const bulkPreview = await cloud.createCloudSyncPreview();
    assert.equal(bulkPreview.pendingUpload, 5_001);
    assert.equal(webSqlite.prepare("SELECT COUNT(*) AS count FROM cloud_sync_dirty WHERE last_error='' ").get().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("网页 Push 按 UTF-8 请求体切分，任何一批都不超过网关安全上限", async () => {
  const webSqlite = new DatabaseSync(":memory:");
  await applyWebMigrations(webSqlite);
  const gatewaySqlite = new DatabaseSync(":memory:");
  gatewaySqlite.exec(await readFile(new URL("../../sync-service/migrations/0001_initial.sql", import.meta.url), "utf8"));
  const gatewayWorker = await import(new URL("../../sync-service/src/index.mjs", import.meta.url));
  const adminToken = "batch-test-admin-token-at-least-32-characters";
  const gatewayEnv = { DB: new TestD1(gatewaySqlite), SYNC_ADMIN_TOKEN: adminToken };
  const originalFetch = globalThis.fetch;
  const pushBytes = [];
  globalThis.fetch = async (request, options) => {
    const normalized = request instanceof Request ? request : new Request(request, options);
    if (new URL(normalized.url).hostname === "sync.test") {
      if (new URL(normalized.url).pathname === "/v1/sync/push") {
        pushBytes.push((await normalized.clone().arrayBuffer()).byteLength);
      }
      return gatewayWorker.default.fetch(normalized, gatewayEnv);
    }
    return originalFetch(request, options);
  };
  try {
    const cloud = await loadCloudSync({ DB: new TestD1(webSqlite), SYNC_GATEWAY_URL: "https://sync.test", SYNC_ADMIN_TOKEN: adminToken });
    const timestamp = "2026-08-23T13:00:00.000Z";
    const insert = webSqlite.prepare(
      `INSERT INTO permanent_records(id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    webSqlite.exec("BEGIN");
    for (let index = 0; index < 100; index += 1) {
      const code = `LARGE-${String(index).padStart(3, "0")}`;
      insert.run(`large-${index}`, "missav", code, code, "", "new", "[]", "[]", "[]", "", "", "", JSON.stringify({ note: "x".repeat(60_000) }), timestamp, timestamp);
    }
    webSqlite.exec("COMMIT");
    const preview = await cloud.createCloudSyncPreview();
    assert.equal(preview.pendingUpload, 100);
    const result = await cloud.executeCloudSync("push");
    assert.equal(result.push.accepted, 100);
    assert.ok(pushBytes.length > 1, "大批次必须拆为多个请求");
    assert.ok(pushBytes.every((bytes) => bytes <= 3_500_000), `请求体超限：${Math.max(...pushBytes)}`);

    const successBeforeContinuation = (await cloud.cloudSyncStatus()).lastSuccessAt;
    webSqlite.exec("BEGIN");
    for (let index = 0; index < 5; index += 1) {
      const code = `CONTINUE-${index}`;
      insert.run(`continue-${index}`, "missav", code, code, "", "new", "[]", "[]", "[]", "", "", "", "{}", timestamp, timestamp);
    }
    webSqlite.exec("COMMIT");
    await cloud.createCloudSyncPreview();
    const partial = await cloud.executeCloudSync("push", { maxPushBatches: 2, pushBatchOperations: 1 });
    assert.equal(partial.incomplete, true);
    assert.equal(partial.push.accepted, 2);
    assert.equal(partial.push.remaining, 3);
    assert.equal((await cloud.cloudSyncStatus()).lastSuccessAt, successBeforeContinuation, "分段未完成不能冒充完整同步成功");
    let continuation = partial;
    let continuedAccepted = 0;
    while (continuation.incomplete) {
      await cloud.createCloudSyncPreview();
      continuation = await cloud.executeCloudSync("push", { maxPushBatches: 2, pushBatchOperations: 1 });
      continuedAccepted += Number(continuation.push.accepted || 0);
    }
    assert.equal(continuedAccepted, 3);
    assert.equal(webSqlite.prepare("SELECT COUNT(*) AS count FROM cloud_sync_outbox WHERE status IN ('pending','retry')").get().count, 0);
    assert.equal(gatewaySqlite.prepare("SELECT COUNT(*) AS count FROM sync_entities WHERE entity_key LIKE 'record:missav:continue-%'").get().count, 5);
  } finally {
    globalThis.fetch = originalFetch;
    webSqlite.close();
    gatewaySqlite.close();
  }
});

test("Pull 后续分页网络失败时保留断点但不提前更新最近成功时间", async () => {
  const webSqlite = new DatabaseSync(":memory:");
  await applyWebMigrations(webSqlite);
  const gatewaySqlite = new DatabaseSync(":memory:");
  gatewaySqlite.exec(await readFile(new URL("../../sync-service/migrations/0001_initial.sql", import.meta.url), "utf8"));
  const gatewayWorker = await import(new URL("../../sync-service/src/index.mjs", import.meta.url));
  const adminToken = "pull-failure-admin-token-at-least-32-characters";
  const gatewayEnv = { DB: new TestD1(gatewaySqlite), SYNC_ADMIN_TOKEN: adminToken };
  const pairing = await gatewayJson(gatewayWorker, gatewayEnv, "/v1/admin/pairings", {
    method: "POST", headers: { "content-type": "application/json", "x-sync-admin-token": adminToken }, body: JSON.stringify({ label: "pull-failure-remote" }),
  });
  const remote = await gatewayJson(gatewayWorker, gatewayEnv, "/v1/devices/exchange", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing.code, nodeId: "pull-failure-node", label: "pull-failure-remote" }),
  });
  const timestamp = "2026-08-23T14:00:00.000Z";
  const operations = Array.from({ length: 51 }, (_, index) => {
    const code = `REMOTE-${String(index).padStart(3, "0")}`;
    return {
      schemaVersion: 1,
      operationId: `pull-failure-${index}`,
      nodeId: "pull-failure-node",
      entityType: "permanent_record",
      entityKey: `record:missav:${code.toLowerCase()}`,
      action: "upsert",
      baseVersion: 0,
      occurredAt: timestamp,
      payload: {
        tool: "missav", recordKey: code, primaryValue: code, secondaryValue: "", status: "new",
        tags: [], actressTags: [], genreTags: [], sourceUrl: "", missavUrl: "", av123Url: "", metadata: {}, createdAt: timestamp, updatedAt: timestamp,
      },
    };
  });
  await gatewayJson(gatewayWorker, gatewayEnv, "/v1/sync/push", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${remote.deviceToken}` }, body: JSON.stringify({ operations }),
  });

  const originalFetch = globalThis.fetch;
  let pullPages = 0;
  globalThis.fetch = async (request, options) => {
    const normalized = request instanceof Request ? request : new Request(request, options);
    const url = new URL(normalized.url);
    if (url.hostname === "sync.test") {
      if (url.pathname === "/v1/sync/pull" && url.searchParams.get("limit") === "50") {
        pullPages += 1;
        if (pullPages === 2) throw new Error("synthetic second pull page failure");
      }
      return gatewayWorker.default.fetch(normalized, gatewayEnv);
    }
    return originalFetch(request, options);
  };
  try {
    const cloud = await loadCloudSync({ DB: new TestD1(webSqlite), SYNC_GATEWAY_URL: "https://sync.test", SYNC_ADMIN_TOKEN: adminToken });
    await cloud.createCloudSyncPreview();
    const baselineSuccess = "2026-08-20T00:00:00.000Z";
    webSqlite.prepare("UPDATE cloud_sync_state SET last_success_at=? WHERE id='site'").run(baselineSuccess);
    await assert.rejects(() => cloud.executeCloudSync("pull"), /synthetic second pull page failure/);
    const status = await cloud.cloudSyncStatus();
    assert.equal(pullPages, 2);
    assert.equal(status.lastSuccessAt, baselineSuccess, "Pull 整体失败不能把第一页写成最近成功时间");
    assert.equal(status.lastPulledSequence, 50, "已完整落库的第一页必须保留断点");
    assert.equal(webSqlite.prepare("SELECT COUNT(*) AS count FROM permanent_records WHERE record_key LIKE 'REMOTE-%'").get().count, 50);
    assert.match(status.lastError, /synthetic second pull page failure/);
  } finally {
    globalThis.fetch = originalFetch;
    webSqlite.close();
    gatewaySqlite.close();
  }
});
