export const SYNC_SCHEMA_VERSION = 1;
export const MAX_SYNC_BATCH_OPERATIONS = 500;
export const MAX_SYNC_BATCH_BYTES = 4 * 1024 * 1024;

export const SYNC_ENTITY_TYPES = Object.freeze([
  "permanent_record",
  "content_run",
  "content_result",
  "input_source",
  "tool_source_binding",
  "telegram_message",
  "telegram_tool_queue",
  "telegram_read_state",
  "telegram_checkpoint",
  "task_inbox",
  "reference_tag",
  "reference_tag_blacklist",
  "export_blacklist",
  "app_setting",
]);

const ENTITY_TYPE_SET = new Set(SYNC_ENTITY_TYPES);
const ACTION_SET = new Set(["upsert", "delete"]);
const SECRET_KEY = /(?:^|_)(?:api_?hash|token|secret|password|passcode|phone_?code|two_?factor|2fa|session|cookie|authorization)(?:$|_)/i;
const TOOL_SET = new Set(["twitter", "badnews", "haijiao", "missav", "av123"]);
const SYNC_SETTING_KEYS = new Set([
  "missav.referenceTags",
  "missav.referenceTagBlacklist",
  "missav.raindropExportBlacklist",
]);
const QUEUE_STATUS_RANK = Object.freeze({
  pending: 10,
  error: 20,
  ignored: 30,
  processed_empty: 40,
  processed: 50,
  completed: 50,
  remote_deleted: 60,
});

function requiredText(value, field, max = 512) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} 不能为空`);
  if (text.length > max) throw new Error(`${field} 过长`);
  return text;
}

function optionalText(value, max = 4096) {
  const text = String(value ?? "").trim();
  if (text.length > max) throw new Error("同步字段过长");
  return text;
}

function normalizedTool(value) {
  const tool = requiredText(value, "tool", 32).toLowerCase();
  if (!TOOL_SET.has(tool)) throw new Error(`未知工具：${tool}`);
  return tool;
}

function normalizedNaturalPart(value, field) {
  return requiredText(value, field, 1024).normalize("NFKC").toLowerCase();
}

export function canonicalSourceKey(payload) {
  if (payload.sourceKey) return normalizedNaturalPart(payload.sourceKey, "sourceKey");
  const rawKind = normalizedNaturalPart(payload.kind ?? payload.sourceKind, "source.kind");
  const kind = rawKind === "telegram_user" ? "telegram_personal" : rawKind === "telegram-bot" ? "telegram_bot" : rawKind;
  const connection = optionalText(payload.connectionId, 256).toLowerCase();
  const external = normalizedNaturalPart(
    payload.externalKey ?? payload.externalId ?? payload.externalChatId,
    "source.externalKey",
  );
  return [kind, connection || "default", external].join(":");
}

function sourceIdentity(payload) {
  return canonicalSourceKey(payload);
}

function messageIdentity(payload) {
  if (payload.messageKey) return normalizedNaturalPart(payload.messageKey, "messageKey");
  const sourceKey = sourceIdentity(payload);
  const messageId = normalizedNaturalPart(
    payload.messageId ?? payload.externalMessageId,
    "messageId",
  );
  return `${sourceKey}:${messageId}`;
}

export function canonicalEntityKey(entityTypeValue, payloadValue) {
  const entityType = requiredText(entityTypeValue, "entityType", 64);
  if (!ENTITY_TYPE_SET.has(entityType)) throw new Error(`未知同步实体：${entityType}`);
  const payload = payloadValue && typeof payloadValue === "object" && !Array.isArray(payloadValue)
    ? payloadValue
    : {};

  switch (entityType) {
    case "permanent_record":
      return `record:${normalizedTool(payload.tool)}:${normalizedNaturalPart(payload.recordKey ?? payload.primaryValue, "recordKey")}`;
    case "content_run":
      return `run:${normalizedNaturalPart(payload.globalId ?? payload.id, "run.globalId")}`;
    case "content_result":
      return `result:${normalizedNaturalPart(payload.runKey ?? payload.runId, "result.runKey")}:${normalizedNaturalPart(payload.resultKey, "resultKey")}`;
    case "input_source":
      return `source:${sourceIdentity(payload)}`;
    case "tool_source_binding":
      return `binding:${sourceIdentity(payload)}:${normalizedTool(payload.tool)}`;
    case "telegram_message":
      return `message:${messageIdentity(payload)}`;
    case "telegram_tool_queue":
      return `queue:${messageIdentity(payload)}:${normalizedTool(payload.tool)}`;
    case "telegram_read_state":
      return `read:${sourceIdentity(payload)}`;
    case "telegram_checkpoint":
      return `checkpoint:${sourceIdentity(payload)}`;
    case "task_inbox":
      return `task:${normalizedNaturalPart(payload.globalId ?? payload.id, "task.globalId")}`;
    case "reference_tag":
      return `reference-tag:${normalizedNaturalPart(payload.value ?? payload.tag, "tag")}`;
    case "reference_tag_blacklist":
      return `reference-blacklist:${normalizedNaturalPart(payload.value ?? payload.tag, "tag")}`;
    case "export_blacklist":
      return `export-blacklist:${normalizedNaturalPart(payload.value ?? payload.tag, "tag")}`;
    case "app_setting":
      return `setting:${normalizedNaturalPart(payload.key, "setting.key")}`;
    default:
      throw new Error(`未知同步实体：${entityType}`);
  }
}

export function stableStringify(value) {
  const seen = new WeakSet();
  function normalize(current) {
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) throw new Error("同步数据不能包含循环引用");
    seen.add(current);
    if (Array.isArray(current)) {
      const output = current.map(normalize);
      seen.delete(current);
      return output;
    }
    const output = {};
    for (const key of Object.keys(current).sort()) {
      const item = current[key];
      if (item !== undefined) output[key] = normalize(item);
    }
    seen.delete(current);
    return output;
  }
  return JSON.stringify(normalize(value));
}

export function assertNoSecrets(value, path = "payload") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`同步数据禁止包含敏感字段：${path}.${key}`);
    assertNoSecrets(item, `${path}.${key}`);
  }
}

export function normalizeSyncOperation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("同步操作格式无效");
  const schemaVersion = Number(input.schemaVersion ?? SYNC_SCHEMA_VERSION);
  if (schemaVersion !== SYNC_SCHEMA_VERSION) throw new Error(`不支持同步协议 v${schemaVersion}`);
  const operationId = requiredText(input.operationId, "operationId", 128);
  const nodeId = requiredText(input.nodeId, "nodeId", 128);
  const entityType = requiredText(input.entityType, "entityType", 64);
  if (!ENTITY_TYPE_SET.has(entityType)) throw new Error(`未知同步实体：${entityType}`);
  const action = requiredText(input.action, "action", 16);
  if (!ACTION_SET.has(action)) throw new Error(`未知同步动作：${action}`);
  const occurredAt = requiredText(input.occurredAt, "occurredAt", 64);
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("occurredAt 必须是 ISO 时间");
  const baseVersion = Math.max(0, Number(input.baseVersion ?? 0) || 0);
  const recordVersion = Math.max(0, Number(input.recordVersion ?? 0) || 0);
  const payload = action === "delete" ? null : input.payload;
  const restore = action === "upsert" && input.restore === true;
  if (action === "upsert" && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
    throw new Error("upsert 必须包含对象 payload");
  }
  assertNoSecrets(payload);
  if (entityType === "app_setting" && !SYNC_SETTING_KEYS.has(String(payload?.key || ""))) {
    throw new Error(`该设置不允许跨端同步：${String(payload?.key || "")}`);
  }
  const entityKey = requiredText(input.entityKey || canonicalEntityKey(entityType, payload), "entityKey", 1536);
  if (action === "upsert" && entityKey !== canonicalEntityKey(entityType, payload)) {
    throw new Error("entityKey 与 payload 不一致");
  }
  return { schemaVersion, operationId, nodeId, entityType, entityKey, action, restore, baseVersion, recordVersion, occurredAt, payload };
}

export function validateSyncBatch(value, options = {}) {
  const maxOperations = Math.min(MAX_SYNC_BATCH_OPERATIONS, Math.max(1, Number(options.maxOperations ?? MAX_SYNC_BATCH_OPERATIONS)));
  const maxBytes = Math.min(MAX_SYNC_BATCH_BYTES, Math.max(1024, Number(options.maxBytes ?? MAX_SYNC_BATCH_BYTES)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("同步批次格式无效");
  const operations = Array.isArray(value.operations) ? value.operations : [];
  if (!operations.length) throw new Error("同步批次为空");
  if (operations.length > maxOperations) throw new Error(`单批最多 ${maxOperations} 条同步操作`);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) throw new Error("同步批次过大");
  const normalized = operations.map(normalizeSyncOperation);
  const ids = new Set();
  for (const operation of normalized) {
    if (ids.has(operation.operationId)) throw new Error(`同步批次包含重复 operationId：${operation.operationId}`);
    ids.add(operation.operationId);
  }
  return { schemaVersion: SYNC_SCHEMA_VERSION, operations: normalized };
}

export function maxCheckpoint(...values) {
  let best = 0n;
  for (const value of values) {
    try {
      const parsed = BigInt(String(value ?? "0").trim() || "0");
      if (parsed > best) best = parsed;
    } catch {
      // Invalid legacy checkpoints are ignored instead of moving backwards.
    }
  }
  return best.toString();
}

function queueStatusRank(value) {
  return QUEUE_STATUS_RANK[String(value ?? "pending")] ?? 0;
}

export function resolveSyncConflict(currentValue, incomingValue) {
  const current = currentValue ? normalizeSyncOperation(currentValue) : null;
  const incoming = normalizeSyncOperation(incomingValue);
  if (!current) return { decision: "incoming", operation: incoming, reason: "missing_current" };
  if (current.entityType !== incoming.entityType || current.entityKey !== incoming.entityKey) {
    throw new Error("不能合并不同实体");
  }
  if (current.action === "delete" && incoming.action !== "delete" && !incoming.restore) {
    return { decision: "conflict", operation: current, reason: "explicit_restore_required" };
  }
  if (current.action === "delete" && incoming.restore) {
    return { decision: "incoming", operation: incoming, reason: "explicit_restore" };
  }
  if (incoming.action === "delete") return { decision: "incoming", operation: incoming, reason: "tombstone_wins" };

  if (incoming.entityType === "telegram_checkpoint" || incoming.entityType === "telegram_read_state") {
    const mergedPayload = { ...current.payload, ...incoming.payload };
    for (const key of ["checkpoint", "incrementalCheckpointId", "safeReadMessageId", "lastMarkedReadMessageId", "readBaselineMessageId"]) {
      if (key in current.payload || key in incoming.payload) mergedPayload[key] = maxCheckpoint(current.payload?.[key], incoming.payload?.[key]);
    }
    return { decision: "merged", operation: { ...incoming, payload: mergedPayload }, reason: "monotonic_checkpoint" };
  }

  if (incoming.entityType === "telegram_tool_queue") {
    const currentRank = queueStatusRank(current.payload?.status);
    const incomingRank = queueStatusRank(incoming.payload?.status);
    if (currentRank > incomingRank) return { decision: "current", operation: current, reason: "queue_state_is_monotonic" };
  }

  const currentTime = Date.parse(current.occurredAt);
  const incomingTime = Date.parse(incoming.occurredAt);
  if (incomingTime > currentTime) return { decision: "incoming", operation: incoming, reason: "newer_timestamp" };
  if (incomingTime < currentTime) return { decision: "current", operation: current, reason: "older_timestamp" };
  if (incoming.nodeId > current.nodeId) return { decision: "incoming", operation: incoming, reason: "node_tiebreak" };
  return { decision: "current", operation: current, reason: "node_tiebreak" };
}

export function partitionOperations(operationsValue, sizeValue = 200) {
  const size = Math.max(1, Math.min(MAX_SYNC_BATCH_OPERATIONS, Number(sizeValue) || 200));
  const operations = operationsValue.map(normalizeSyncOperation);
  const chunks = [];
  for (let index = 0; index < operations.length; index += size) chunks.push(operations.slice(index, index + size));
  return chunks;
}
