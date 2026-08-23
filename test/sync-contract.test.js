const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function contract() {
  return import(pathToFileURL(path.join(__dirname, "..", "packages", "sync-contract", "index.js")).href);
}

function operation(overrides = {}) {
  return {
    schemaVersion: 1,
    operationId: "op-1",
    nodeId: "desktop-a",
    entityType: "telegram_checkpoint",
    entityKey: "checkpoint:telegram_personal:default:-1001",
    action: "upsert",
    baseVersion: 0,
    recordVersion: 0,
    occurredAt: "2026-08-23T08:00:00.000Z",
    payload: { kind: "telegram_user", externalId: "-1001", checkpoint: "100" },
    ...overrides,
  };
}

test("同步实体键在本地与云端使用同一自然键", async () => {
  const { canonicalEntityKey, canonicalSourceKey } = await contract();
  assert.equal(
    canonicalSourceKey({ kind: "telegram_user", connectionId: "personal-main", externalId: "-10001" }),
    canonicalSourceKey({ kind: "telegram_personal", connectionId: "personal-main", externalChatId: "-10001" }),
  );
  assert.equal(
    canonicalSourceKey({ kind: "telegram_user", externalId: "-10001" }),
    canonicalSourceKey({ kind: "telegram_personal", connectionId: "telegram-personal", externalChatId: "-10001" }),
  );
  assert.equal(
    canonicalSourceKey({ sourceKey: "telegram-bot:telegram-bot:-10002" }),
    "telegram_bot:default:-10002",
  );
  assert.equal(
    canonicalEntityKey("telegram_message", { kind: "telegram_user", externalId: "-1001", messageId: 55 }),
    "message:telegram_personal:default:-1001:55",
  );
  assert.equal(
    canonicalEntityKey("permanent_record", { tool: "missav", recordKey: "ABF-123" }),
    "record:missav:abf-123",
  );
});

test("普通设置和敏感设置不能借 app_setting 穿过同步层", async () => {
  const { normalizeSyncOperation } = await contract();
  const base = {
    schemaVersion: 1,
    operationId: "setting-ok",
    nodeId: "desktop-a",
    entityType: "app_setting",
    action: "upsert",
    occurredAt: "2026-08-23T00:00:00.000Z",
    payload: { key: "missav.referenceTags", value: ["女优A"] },
  };
  assert.doesNotThrow(() => normalizeSyncOperation(base));
  assert.throws(
    () => normalizeSyncOperation({ ...base, operationId: "setting-bad", payload: { key: "telegramBotToken", value: "secret" } }),
    /不允许跨端同步/,
  );
});

test("同步批次拒绝 Secret 和重复 operationId", async () => {
  const { validateSyncBatch } = await contract();
  assert.throws(() => validateSyncBatch({ operations: [operation({ payload: { kind: "telegram_user", externalId: "-1001", api_hash: "secret" } })] }), /敏感字段/);
  assert.throws(() => validateSyncBatch({ operations: [operation({ payload: { kind: "telegram_user", externalId: "-1001", note: "TELEGRAM_BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyzABCDE" } })] }), /敏感内容/);
  assert.throws(() => validateSyncBatch({ operations: [operation({ payload: { kind: "telegram_user", externalId: "-1001", note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" } })] }), /敏感内容/);
  assert.doesNotThrow(() => validateSyncBatch({ operations: [operation({ payload: { kind: "telegram_user", externalId: "-1001", note: "普通消息提到了 token 一词，但没有携带凭据" } })] }));
  assert.throws(() => validateSyncBatch({ operations: [operation(), operation()] }), /重复 operationId/);
});

test("检查点冲突只前进不倒退", async () => {
  const { resolveSyncConflict } = await contract();
  const current = operation({ operationId: "old", recordVersion: 3, occurredAt: "2026-08-23T08:01:00.000Z", payload: { kind: "telegram_user", externalId: "-1001", checkpoint: "900", safeReadMessageId: "850" } });
  const incoming = operation({ operationId: "new", nodeId: "cloud-a", baseVersion: 2, payload: { kind: "telegram_user", externalId: "-1001", checkpoint: "800", safeReadMessageId: "880" } });
  const resolved = resolveSyncConflict(current, incoming);
  assert.equal(resolved.decision, "merged");
  assert.equal(resolved.operation.payload.checkpoint, "900");
  assert.equal(resolved.operation.payload.safeReadMessageId, "880");
});

test("删除墓碑不会被普通更新静默复活", async () => {
  const { resolveSyncConflict } = await contract();
  const deleted = operation({ operationId: "delete", entityType: "permanent_record", entityKey: "record:missav:abf-123", action: "delete", payload: null });
  const restore = operation({ operationId: "restore", entityType: "permanent_record", entityKey: "record:missav:abf-123", action: "upsert", payload: { tool: "missav", recordKey: "ABF-123" } });
  assert.equal(resolveSyncConflict(deleted, restore).decision, "conflict");
  assert.equal(resolveSyncConflict(deleted, { ...restore, operationId: "explicit-restore", restore: true }).decision, "incoming");
});

test("stableStringify 对对象键顺序不敏感", async () => {
  const { stableStringify } = await contract();
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
});
