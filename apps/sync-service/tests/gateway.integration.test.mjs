import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

async function setup() {
  const bundled = await build({
    entryPoints: [join(root, "src", "index.mjs")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const worker = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-05-22",
    d1Databases: ["DB"],
    bindings: { SYNC_ADMIN_TOKEN: "integration-admin" },
  });
  const database = await worker.getD1Database("DB");
  const migration = await readFile(join(root, "migrations", "0001_initial.sql"), "utf8");
  for (const statement of migration.split(";").map((item) => item.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
  return worker;
}

async function body(response) {
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

test("配对、幂等 Push/Pull 与来源租约形成完整闭环", async () => {
  const worker = await setup();
  try {
    const pairing = await body(await worker.dispatchFetch("https://sync.test/v1/admin/pairings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sync-admin-token": "integration-admin" },
      body: JSON.stringify({ label: "test-device" }),
    }));
    const device = await body(await worker.dispatchFetch("https://sync.test/v1/devices/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code, nodeId: "windows-test", label: "Windows test" }),
    }));
    assert.match(device.deviceToken, /^tgds_/);
    const headers = { "content-type": "application/json", authorization: "Bearer " + device.deviceToken };
    const operation = {
      schemaVersion: 1,
      operationId: "op-permanent-1",
      nodeId: "windows-test",
      entityType: "permanent_record",
      entityKey: "record:missav:abf-123",
      action: "upsert",
      baseVersion: 0,
      recordVersion: 0,
      occurredAt: "2026-08-23T00:00:00.000Z",
      payload: { tool: "missav", recordKey: "ABF-123", primaryValue: "ABF-123", tags: ["女优A"] },
    };
    const firstPush = await body(await worker.dispatchFetch("https://sync.test/v1/sync/push", {
      method: "POST", headers, body: JSON.stringify({ operations: [operation] }),
    }));
    assert.equal(firstPush.accepted.length, 1);
    assert.equal(firstPush.accepted[0].duplicate, false);

    const duplicatePush = await body(await worker.dispatchFetch("https://sync.test/v1/sync/push", {
      method: "POST", headers, body: JSON.stringify({ operations: [operation] }),
    }));
    assert.equal(duplicatePush.accepted[0].duplicate, true);

    const pulled = await body(await worker.dispatchFetch("https://sync.test/v1/sync/pull?after=0&limit=20", { headers }));
    assert.equal(pulled.operations.length, 1);
    assert.equal(pulled.operations[0].payload.recordKey, "ABF-123");

    const lease = await body(await worker.dispatchFetch("https://sync.test/v1/leases/acquire", {
      method: "POST", headers, body: JSON.stringify({ leaseKey: "telegram:personal-main:-1001" }),
    }));
    assert.equal(lease.acquired, true);
    const renewed = await body(await worker.dispatchFetch("https://sync.test/v1/leases/renew", {
      method: "POST", headers, body: JSON.stringify({ leaseKey: lease.leaseKey, leaseToken: lease.leaseToken }),
    }));
    assert.equal(renewed.renewed, true);
    const released = await body(await worker.dispatchFetch("https://sync.test/v1/leases/release", {
      method: "POST", headers, body: JSON.stringify({ leaseKey: lease.leaseKey, leaseToken: lease.leaseToken }),
    }));
    assert.equal(released.released, true);
  } finally {
    await worker.dispose();
  }
});

test("同步网关拒绝 Secret 载荷和其他节点冒充", async () => {
  const worker = await setup();
  try {
    const pairing = await body(await worker.dispatchFetch("https://sync.test/v1/admin/pairings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sync-admin-token": "integration-admin" },
      body: "{}",
    }));
    const device = await body(await worker.dispatchFetch("https://sync.test/v1/devices/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code, nodeId: "windows-test" }),
    }));
    const response = await worker.dispatchFetch("https://sync.test/v1/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + device.deviceToken },
      body: JSON.stringify({ operations: [{
        schemaVersion: 1, operationId: "bad-op", nodeId: "other-node",
        entityType: "app_setting", entityKey: "setting:telegrambottoken", action: "upsert",
        occurredAt: "2026-08-23T00:00:00.000Z", payload: { key: "telegramBotToken", token: "must-not-pass" },
      }] }),
    });
    assert.equal(response.ok, false);
    const payload = await response.json();
    assert.doesNotMatch(JSON.stringify(payload), /must-not-pass/);
    const embedded = await worker.dispatchFetch("https://sync.test/v1/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + device.deviceToken },
      body: JSON.stringify({ operations: [{
        schemaVersion: 1, operationId: "embedded-secret", nodeId: "windows-test",
        entityType: "permanent_record", entityKey: "record:missav:secret-test", action: "upsert",
        occurredAt: "2026-08-23T00:00:00.000Z",
        payload: { tool: "missav", recordKey: "SECRET-TEST", note: "TELEGRAM_BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyzABCDE" },
      }] }),
    });
    assert.equal(embedded.ok, false);
    const embeddedPayload = await embedded.json();
    assert.doesNotMatch(JSON.stringify(embeddedPayload), /abcdefghijklmnopqrstuvwxyzABCDE/);
  } finally {
    await worker.dispose();
  }
});

test("删除墓碑必须显式恢复，单实体接口返回当前版本", async () => {
  const worker = await setup();
  try {
    const pairing = await body(await worker.dispatchFetch("https://sync.test/v1/admin/pairings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sync-admin-token": "integration-admin" },
      body: "{}",
    }));
    const device = await body(await worker.dispatchFetch("https://sync.test/v1/devices/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code, nodeId: "windows-restore" }),
    }));
    const headers = { "content-type": "application/json", authorization: "Bearer " + device.deviceToken };
    const base = {
      schemaVersion: 1,
      nodeId: "windows-restore",
      entityType: "permanent_record",
      entityKey: "record:missav:abf-123",
      recordVersion: 0,
      occurredAt: "2026-08-23T00:00:00.000Z",
    };
    const create = await body(await worker.dispatchFetch("https://sync.test/v1/sync/push", {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{ ...base, operationId: "restore-create", action: "upsert", baseVersion: 0, payload: { tool: "missav", recordKey: "ABF-123" } }] }),
    }));
    assert.equal(create.accepted[0].recordVersion, 1);
    const remove = await body(await worker.dispatchFetch("https://sync.test/v1/sync/push", {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{ ...base, operationId: "restore-delete", action: "delete", baseVersion: 1, payload: null }] }),
    }));
    assert.equal(remove.accepted[0].recordVersion, 2);

    const ordinary = await body(await worker.dispatchFetch("https://sync.test/v1/sync/push", {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{ ...base, operationId: "restore-ordinary", action: "upsert", baseVersion: 2, payload: { tool: "missav", recordKey: "ABF-123" } }] }),
    }));
    assert.equal(ordinary.rejected[0].reason, "explicit_restore_required");

    const restored = await body(await worker.dispatchFetch("https://sync.test/v1/sync/push", {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{ ...base, operationId: "restore-explicit", action: "upsert", restore: true, baseVersion: 2, payload: { tool: "missav", recordKey: "ABF-123" } }] }),
    }));
    assert.equal(restored.accepted[0].recordVersion, 3);

    const current = await body(await worker.dispatchFetch("https://sync.test/v1/sync/entity?entity_type=permanent_record&entity_key=record%3Amissav%3Aabf-123", { headers }));
    assert.equal(current.entity.recordVersion, 3);
    assert.equal(current.entity.tombstone, false);
  } finally {
    await worker.dispose();
  }
});
