import { env } from "cloudflare:workers";
import {
  MAX_SYNC_BATCH_BYTES,
  SYNC_SCHEMA_VERSION,
  canonicalEntityKey,
  canonicalSourceKey,
  normalizeSyncOperation,
  stableStringify,
} from "../../../packages/sync-contract/index.js";
import { getD1 } from "../db";
import { sha256Hex } from "./security";
import {
  CLOUD_SYNC_SCHEMA_STATEMENTS,
  CLOUD_SYNC_SEED_STATEMENTS,
} from "./cloud-sync-schema";
import { ensureSchema, nowIso } from "./server-store";

type JsonObject = Record<string, unknown>;

type DirtyRow = {
  id: number;
  table_name: string;
  row_key: string;
  action: "upsert" | "delete";
  row_json: string;
  changed_at: string;
};

type LocalState = {
  id: string;
  node_id: string;
  encrypted_device_token: string;
  last_pulled_sequence: number;
  preview_json: string;
  preview_expires_at: string;
  last_success_at: string;
  last_error: string;
  created_at: string;
  updated_at: string;
};

type GatewayOperation = {
  schemaVersion: number;
  sequence?: number;
  operationId: string;
  nodeId: string;
  entityType: string;
  entityKey: string;
  action: "upsert" | "delete";
  restore?: boolean;
  baseVersion: number;
  recordVersion?: number;
  occurredAt: string;
  payload: JsonObject | null;
};

type EntityDraft = {
  dirtyIds: number[];
  entityType: string;
  entityKey: string;
  action: "upsert" | "delete";
  payload: JsonObject | null;
  occurredAt: string;
};

const STATE_ID = "site";
const PREVIEW_TTL_MS = 30 * 60_000;
const SAFE_PUSH_BODY_BYTES = Math.min(MAX_SYNC_BATCH_BYTES, 3_500_000);
const SYNC_BATCHES_PER_REQUEST = 20;
const SECRET_FIELD = /(?:^|_)(?:api_?hash|token|secret|password|passcode|phone_?code|two_?factor|2fa|session|cookie|authorization)(?:$|_)/i;
const SETTING_TO_SYNC: Record<string, string> = {
  referenceTags: "missav.referenceTags",
  referenceBlacklist: "missav.referenceTagBlacklist",
  exportBlacklist: "missav.raindropExportBlacklist",
};
const SYNC_TO_SETTING: Record<string, string> = Object.fromEntries(
  Object.entries(SETTING_TO_SYNC).map(([local, remote]) => [remote.toLowerCase(), local]),
);
let cloudSyncSchemaReady: Promise<void> | null = null;

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function integer(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function safeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeValue);
  if (!value || typeof value !== "object") return value;
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value as JsonObject)) {
    if (!SECRET_FIELD.test(key)) output[key] = safeValue(child);
  }
  return output;
}

function sourcePayload(row: JsonObject) {
  const kind = text(row.sourceKind ?? row.kind);
  const localConnectionId = text(row.sourceConnectionId ?? row.connectionId ?? row.connection_id) || "default";
  const externalKey = text(row.sourceExternalKey ?? row.externalKey ?? row.externalChatId ?? row.external_key);
  const sourceKey = canonicalSourceKey({ kind, connectionId: localConnectionId, externalKey });
  const [canonicalKind, connectionId = "default"] = sourceKey.split(":");
  return { sourceKey, kind: canonicalKind, connectionId, externalKey };
}

function localConnectionIdForSource(kind: string, connectionId: string) {
  if (connectionId !== "default") return connectionId;
  if (kind === "telegram_personal") return "telegram-personal";
  if (kind === "telegram_bot") return "telegram-bot";
  return "";
}

function mapDirtyRow(row: DirtyRow): EntityDraft {
  const value = parseJson<JsonObject>(row.row_json, {});
  let entityType = "";
  let payload: JsonObject | null = null;
  switch (row.table_name) {
    case "permanent_records":
      entityType = "permanent_record";
      payload = {
        tool: text(value.tool), recordKey: text(value.recordKey), primaryValue: text(value.primaryValue),
        secondaryValue: text(value.secondaryValue), status: text(value.status),
        tags: parseJson(value.tagsJson, []), actressTags: parseJson(value.actressTagsJson, []),
        genreTags: parseJson(value.genreTagsJson, []), sourceUrl: text(value.sourceUrl),
        missavUrl: text(value.missavUrl), av123Url: text(value.av123Url),
        metadata: safeValue(parseJson(value.metadataJson, {})), createdAt: text(value.createdAt), updatedAt: text(value.updatedAt),
      };
      break;
    case "content_runs":
      entityType = "content_run";
      payload = {
        globalId: text(value.id), tool: text(value.tool), name: text(value.name), inputKind: text(value.inputKind),
        originalInput: text(value.sourceSummary).slice(0, 64 * 1024), originalInputTruncated: text(value.sourceSummary).length > 64 * 1024,
        startAt: text(value.startAt), endAt: text(value.endAt), status: text(value.status),
        stats: safeValue(parseJson(value.statsJson, {})), options: safeValue(parseJson(value.optionsJson, {})),
        totalCount: integer(value.totalCount), resultCount: integer(value.resultCount), errorCount: integer(value.errorCount),
        createdAt: text(value.createdAt), updatedAt: text(value.updatedAt),
      };
      break;
    case "content_results":
      entityType = "content_result";
      payload = {
        runKey: text(value.runId), tool: text(value.tool), resultKey: text(value.resultKey),
        primaryValue: text(value.primaryValue), secondaryValue: text(value.secondaryValue), status: text(value.status),
        tags: parseJson(value.tagsJson, []), error: text(value.errorMessage), source: text(value.source),
        metadata: safeValue(parseJson(value.metadataJson, {})), createdAt: text(value.createdAt), updatedAt: text(value.updatedAt),
      };
      break;
    case "input_sources": {
      entityType = "input_source";
      const source = sourcePayload(value);
      payload = {
        ...source, externalChatId: text(value.externalChatId) || source.externalKey, name: text(value.name),
        sourceType: text(value.chatType) || source.kind, enabled: !integer(value.archived),
        metadata: safeValue({
          ...parseJson<JsonObject>(value.metadataJson, {}), chatType: text(value.chatType), username: text(value.username),
          accessStatus: text(value.accessStatus), archived: Boolean(integer(value.archived)),
          latestRemoteMessageId: text(value.latestRemoteMessageId), syncCursorMessageId: text(value.syncCursorMessageId),
          syncTargetMessageId: text(value.syncTargetMessageId), lastError: text(value.lastError),
        }),
        lastSyncAt: text(value.lastSyncAt), createdAt: text(value.createdAt), updatedAt: text(value.updatedAt),
      };
      break;
    }
    case "input_source_checkpoint": {
      entityType = "telegram_checkpoint";
      const source = sourcePayload(value);
      payload = {
        sourceKey: source.sourceKey,
        checkpoint: text(value.incrementalCheckpointId) || "0",
        continuation: text(value.syncCursorMessageId) || "0",
        latestRemoteMessageId: text(value.latestRemoteMessageId) || "0",
        syncTargetMessageId: text(value.syncTargetMessageId) || "0",
        updatedAt: text(value.updatedAt) || row.changed_at,
      };
      break;
    }
    case "tool_source_bindings": {
      entityType = "tool_source_binding";
      const source = sourcePayload(value);
      payload = {
        sourceKey: source.sourceKey, tool: text(value.tool), historyMode: text(value.historyMode),
        historyLimit: integer(value.historyLimit), historyFrom: text(value.historyFrom),
        boundAtMessageId: text(value.boundAtMessageId), createdAt: text(value.createdAt),
      };
      break;
    }
    case "telegram_messages": {
      entityType = "telegram_message";
      const source = sourcePayload(value);
      payload = {
        sourceKey: source.sourceKey, messageId: text(value.messageId), externalMessageId: text(value.externalMessageId) || text(value.messageId),
        remoteUpdateId: text(value.remoteUpdateId), messageDate: text(value.messageDate), body: text(value.body),
        eventKind: text(value.eventKind) || "message", contentHash: text(value.contentHash),
        remoteEditedAt: text(value.remoteEditedAt), remoteDeletedAt: text(value.remoteDeletedAt), bodyDeletedAt: text(value.bodyDeletedAt),
        createdAt: text(value.createdAt), updatedAt: text(value.updatedAt),
      };
      break;
    }
    case "telegram_tool_queue": {
      entityType = "telegram_tool_queue";
      const source = sourcePayload(value);
      payload = {
        sourceKey: source.sourceKey, messageId: text(value.messageId), tool: text(value.tool), status: text(value.status),
        messageDate: text(value.messageDate), candidateCount: integer(value.candidateCount), candidatePreview: text(value.candidatePreview),
        runKey: text(value.runId), error: text(value.errorMessage), selectedAt: text(value.selectedAt),
        processingAt: text(value.processingAt), processedAt: text(value.processedAt), createdAt: text(value.createdAt), updatedAt: text(value.updatedAt),
      };
      break;
    }
    case "telegram_read_states": {
      entityType = "telegram_read_state";
      const source = sourcePayload(value);
      payload = {
        sourceKey: source.sourceKey, policy: text(value.policy) || "never", safeReadMessageId: text(value.safeReadMessageId) || "0",
        lastMarkedReadMessageId: text(value.lastMarkedReadMessageId) || "0", readBaselineMessageId: text(value.readBaselineMessageId) || "0",
        updatedAt: text(value.updatedAt) || row.changed_at,
      };
      break;
    }
    case "task_inbox": {
      entityType = "task_inbox";
      const runKey = text(value.runId) || text(value.id);
      const source = text(value.sourceExternalKey) ? sourcePayload(value) : null;
      const metadata = safeValue(parseJson<JsonObject>(value.metadataJson, {})) as JsonObject;
      payload = {
        globalId: runKey, runKey, sourceKey: source?.sourceKey || "", tool: text(value.tool), stage: text(value.stage),
        phase: text(value.phase), title: text(value.title), summary: text(metadata.summary ?? metadata.note),
        error: text(metadata.error), metadata, createdAt: text(value.createdAt), updatedAt: text(value.updatedAt),
      };
      break;
    }
    case "app_settings": {
      entityType = "app_setting";
      const key = SETTING_TO_SYNC[text(value.key)];
      if (!key) throw new Error("该设置不允许跨端同步");
      payload = { key, value: parseJson(value.valueJson, []), updatedAt: text(value.updatedAt) };
      break;
    }
    default:
      throw new Error(`未知同步变更表：${row.table_name}`);
  }
  const entityKey = canonicalEntityKey(entityType, payload || mapDeleteIdentity(entityType, value));
  return {
    dirtyIds: [row.id], entityType, entityKey, action: row.action,
    payload: row.action === "delete" ? null : payload,
    occurredAt: text(row.changed_at) || nowIso(),
  };
}

function mapDeleteIdentity(entityType: string, value: JsonObject) {
  if (entityType === "permanent_record") return { tool: value.tool, recordKey: value.recordKey };
  if (entityType === "content_run") return { globalId: value.id };
  if (entityType === "content_result") return { runKey: value.runId, resultKey: value.resultKey };
  if (entityType === "input_source") return sourcePayload(value);
  if (entityType === "tool_source_binding") return { ...sourcePayload(value), tool: value.tool };
  if (entityType === "telegram_message") return { ...sourcePayload(value), messageId: value.messageId };
  if (entityType === "telegram_tool_queue") return { ...sourcePayload(value), messageId: value.messageId, tool: value.tool };
  if (entityType === "telegram_read_state") return sourcePayload(value);
  if (entityType === "telegram_checkpoint") return sourcePayload(value);
  if (entityType === "task_inbox") return { globalId: text(value.runId) || text(value.id) };
  if (entityType === "app_setting") return { key: SETTING_TO_SYNC[text(value.key)] };
  return value;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function credentialKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptCredential(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("tg-toolbox/site-sync-device/v1") },
    await credentialKey(secret),
    new TextEncoder().encode(value),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(cipher))}`;
}

async function decryptCredential(value: string, secret: string) {
  const [version, iv, cipher, extra] = value.split(".");
  if (version !== "v1" || !iv || !cipher || extra) throw new Error("网站同步设备凭据格式无效");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: new TextEncoder().encode("tg-toolbox/site-sync-device/v1") },
      await credentialKey(secret),
      fromBase64Url(cipher),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("网站同步设备凭据无法解密，请检查同步管理员 Secret 是否被更换");
  }
}

function gatewayConfig() {
  const gatewayUrl = text(env.SYNC_GATEWAY_URL).replace(/\/+$/, "");
  const adminToken = text(env.SYNC_ADMIN_TOKEN);
  if (!gatewayUrl || !adminToken) throw new Error("同步网关尚未配置：需要 SYNC_GATEWAY_URL 与 SYNC_ADMIN_TOKEN");
  const parsed = new URL(gatewayUrl);
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) throw new Error("正式同步网关必须使用 HTTPS");
  return { gatewayUrl, adminToken };
}

async function gatewayFetch(path: string, options: RequestInit = {}, timeoutMs = 20_000) {
  const { gatewayUrl } = gatewayConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${gatewayUrl}${path}`, { ...options, cache: "no-store", signal: controller.signal });
    const data = await response.json().catch(() => ({})) as JsonObject;
    if (!response.ok) throw new Error(text(data.error) || `同步网关 HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureLocalState() {
  await ensureCloudSyncSchema();
  const db = getD1();
  let state = await db.prepare("SELECT * FROM cloud_sync_state WHERE id=?").bind(STATE_ID).first<LocalState>();
  if (!state) {
    const timestamp = nowIso();
    const nodeId = `web-${crypto.randomUUID()}`;
    await db.batch([
      db.prepare("INSERT INTO cloud_sync_state(id,node_id,created_at,updated_at) VALUES(?,?,?,?)")
        .bind(STATE_ID, nodeId, timestamp, timestamp),
      ...CLOUD_SYNC_SEED_STATEMENTS.map((statement) => db.prepare(statement)),
    ]);
    state = await db.prepare("SELECT * FROM cloud_sync_state WHERE id=?").bind(STATE_ID).first<LocalState>();
  }
  if (!state) throw new Error("无法初始化网站同步节点");
  return state;
}

async function ensureCloudSyncSchema() {
  if (cloudSyncSchemaReady) return cloudSyncSchemaReady;
  cloudSyncSchemaReady = (async () => {
    await ensureSchema();
    const db = getD1();
    for (let index = 0; index < CLOUD_SYNC_SCHEMA_STATEMENTS.length; index += 40) {
      await db.batch(CLOUD_SYNC_SCHEMA_STATEMENTS.slice(index, index + 40).map((statement) => db.prepare(statement)));
    }
  })().catch((error) => {
    cloudSyncSchemaReady = null;
    throw error;
  });
  return cloudSyncSchemaReady;
}

async function ensureDeviceCredential() {
  const config = gatewayConfig();
  const state = await ensureLocalState();
  if (state.encrypted_device_token) {
    return { state, deviceToken: await decryptCredential(state.encrypted_device_token, config.adminToken) };
  }
  const pairing = await gatewayFetch("/v1/admin/pairings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-sync-admin-token": config.adminToken },
    body: JSON.stringify({ label: "Private Sites Web", ttlSeconds: 120 }),
  });
  const exchanged = await gatewayFetch("/v1/devices/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairing.code, nodeId: state.node_id, label: "Private Sites Web" }),
  });
  const deviceToken = text(exchanged.deviceToken);
  if (!deviceToken) throw new Error("同步网关没有返回设备凭据");
  const encrypted = await encryptCredential(deviceToken, config.adminToken);
  await getD1().prepare(
    "UPDATE cloud_sync_state SET encrypted_device_token=?,updated_at=? WHERE id=?",
  ).bind(encrypted, nowIso(), STATE_ID).run();
  return { state: { ...state, encrypted_device_token: encrypted }, deviceToken };
}

async function deviceFetch(path: string, options: RequestInit = {}, timeoutMs = 30_000) {
  const { deviceToken } = await ensureDeviceCredential();
  return gatewayFetch(path, {
    ...options,
    headers: { ...(options.headers || {}), authorization: `Bearer ${deviceToken}` },
  }, timeoutMs);
}

async function prepareOutbox(limit = 1_000) {
  const state = await ensureLocalState();
  const db = getD1();
  const result = await db.prepare(
    "SELECT id,table_name,row_key,action,row_json,changed_at FROM cloud_sync_dirty WHERE last_error='' ORDER BY id LIMIT ?",
  ).bind(Math.max(1, Math.min(2_000, limit))).all<DirtyRow>();
  const rows = result.results || [];
  const groups = new Map<string, EntityDraft>();
  const failed: Array<{ id: number; error: string }> = [];
  for (const row of rows) {
    try {
      const draft = mapDirtyRow(row);
      const groupKey = `${draft.entityType}\u0000${draft.entityKey}`;
      const current = groups.get(groupKey);
      groups.set(groupKey, current
        ? { ...draft, dirtyIds: [...current.dirtyIds, row.id] }
        : draft);
    } catch (error) {
      failed.push({ id: row.id, error: text(error instanceof Error ? error.message : error).slice(0, 500) });
    }
  }
  const timestamp = nowIso();
  const statements: D1PreparedStatement[] = [];
  const outboxRows: JsonObject[] = [];
  for (const draft of groups.values()) {
    const maxDirty = Math.max(...draft.dirtyIds);
    const operationId = `${state.node_id}:${maxDirty}`.slice(0, 128);
    outboxRows.push({
      operationId, entityType: draft.entityType, entityKey: draft.entityKey, action: draft.action,
      payloadJson: draft.action === "delete" ? "" : stableStringify(draft.payload), occurredAt: draft.occurredAt,
      createdAt: timestamp, updatedAt: timestamp,
    });
  }
  if (outboxRows.length) {
    statements.push(db.prepare(
      `INSERT INTO cloud_sync_outbox(operation_id,entity_type,entity_key,action,restore,base_version,payload_json,occurred_at,status,created_at,updated_at)
       SELECT json_extract(j.value,'$.operationId'),json_extract(j.value,'$.entityType'),json_extract(j.value,'$.entityKey'),
       json_extract(j.value,'$.action'),0,COALESCE((SELECT record_version FROM cloud_sync_entity_versions v
         WHERE v.entity_type=json_extract(j.value,'$.entityType') AND v.entity_key=json_extract(j.value,'$.entityKey')),0),
       json_extract(j.value,'$.payloadJson'),json_extract(j.value,'$.occurredAt'),'pending',
       json_extract(j.value,'$.createdAt'),json_extract(j.value,'$.updatedAt') FROM json_each(?) j WHERE 1
       ON CONFLICT(entity_type,entity_key) DO UPDATE SET operation_id=excluded.operation_id,action=excluded.action,
       restore=0,base_version=excluded.base_version,payload_json=excluded.payload_json,occurred_at=excluded.occurred_at,
       status='pending',attempt_count=0,last_error='',updated_at=excluded.updated_at`,
    ).bind(JSON.stringify(outboxRows)));
    const ids = [...groups.values()].flatMap((draft) => draft.dirtyIds);
    statements.push(db.prepare("DELETE FROM cloud_sync_dirty WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))").bind(JSON.stringify(ids)));
  }
  if (failed.length) {
    statements.push(db.prepare(
      `WITH errors AS (SELECT CAST(json_extract(value,'$.id') AS INTEGER) AS id,json_extract(value,'$.error') AS error FROM json_each(?))
       UPDATE cloud_sync_dirty SET last_error=COALESCE((SELECT error FROM errors WHERE errors.id=cloud_sync_dirty.id),last_error)
       WHERE id IN (SELECT id FROM errors)`,
    ).bind(JSON.stringify(failed)));
  }
  if (statements.length) await db.batch(statements);
  return { scanned: rows.length, prepared: groups.size, failed: failed.length };
}

async function prepareAllOutbox() {
  let prepared = 0;
  let failed = 0;
  for (let page = 0; page < 1_000; page += 1) {
    const result = await prepareOutbox(2_000);
    prepared += result.prepared;
    failed += result.failed;
    if (result.scanned < 2_000 || result.prepared === 0) break;
  }
  return { prepared, failed };
}

async function outboxFingerprint() {
  const row = await getD1().prepare(
    "SELECT COUNT(*) AS count,COALESCE(MAX(updated_at),'') AS updated_at FROM cloud_sync_outbox WHERE status IN ('pending','retry','conflict')",
  ).first<{ count: number; updated_at: string }>();
  return { count: integer(row?.count), updatedAt: text(row?.updated_at) };
}

export async function cloudSyncStatus(options: { testGateway?: boolean } = {}) {
  const db = getD1();
  const state = await ensureLocalState();
  const [dirty, outbox, conflicts] = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM cloud_sync_dirty"),
    db.prepare("SELECT COUNT(*) AS count FROM cloud_sync_outbox WHERE status IN ('pending','retry','conflict')"),
    db.prepare("SELECT COUNT(*) AS count FROM cloud_sync_conflicts WHERE status='open'"),
  ]);
  let gateway: JsonObject = { configured: Boolean(text(env.SYNC_GATEWAY_URL) && text(env.SYNC_ADMIN_TOKEN)), online: false };
  if (options.testGateway && gateway.configured) {
    try {
      gateway = { ...gateway, ...(await gatewayFetch("/health", {}, 8_000)), online: true };
    } catch (error) {
      gateway = { ...gateway, error: text(error instanceof Error ? error.message : error) };
    }
  }
  const preview = parseJson<JsonObject>(state.preview_json, {});
  const conflictRows = await db.prepare(
    "SELECT id,operation_id,entity_type,entity_key,current_version,reason,status,created_at,resolved_at FROM cloud_sync_conflicts ORDER BY created_at DESC LIMIT 100",
  ).all();
  return {
    gateway, nodeId: state.node_id, paired: Boolean(state.encrypted_device_token),
    dirty: integer((dirty.results?.[0] as JsonObject | undefined)?.count),
    pendingUpload: integer((outbox.results?.[0] as JsonObject | undefined)?.count),
    conflicts: integer((conflicts.results?.[0] as JsonObject | undefined)?.count),
    lastPulledSequence: integer(state.last_pulled_sequence), lastSuccessAt: state.last_success_at,
    lastError: state.last_error, preview, previewExpiresAt: state.preview_expires_at,
    conflictRows: conflictRows.results || [],
  };
}

export async function createCloudSyncPreview() {
  await ensureDeviceCredential();
  await prepareAllOutbox();
  const state = await ensureLocalState();
  const fingerprint = await outboxFingerprint();
  const remote = await deviceFetch(`/v1/sync/pull?after=${integer(state.last_pulled_sequence)}&limit=1`);
  const latestSequence = integer(remote.latestSequence);
  const preview = {
    generatedAt: nowIso(), nodeId: state.node_id, pendingUpload: fingerprint.count,
    pendingDownload: Math.max(0, latestSequence - integer(state.last_pulled_sequence)),
    lastPulledSequence: integer(state.last_pulled_sequence), latestSequence,
    outboxUpdatedAt: fingerprint.updatedAt,
  };
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  await getD1().prepare(
    "UPDATE cloud_sync_state SET preview_json=?,preview_expires_at=?,last_error='',updated_at=? WHERE id=?",
  ).bind(JSON.stringify(preview), expiresAt, nowIso(), STATE_ID).run();
  return { ...preview, expiresAt };
}

async function requireFreshPreview() {
  const state = await ensureLocalState();
  const preview = parseJson<JsonObject>(state.preview_json, {});
  if (!text(preview.generatedAt) || !state.preview_expires_at || Date.parse(state.preview_expires_at) <= Date.now()) {
    throw new Error("同步预览不存在或已超过 30 分钟，请重新生成预览");
  }
  await prepareAllOutbox();
  const fingerprint = await outboxFingerprint();
  if (integer(preview.pendingUpload) !== fingerprint.count || text(preview.outboxUpdatedAt) !== fingerprint.updatedAt) {
    throw new Error("预览后网页数据发生变化，请重新生成预览");
  }
  if (integer(preview.lastPulledSequence) !== integer(state.last_pulled_sequence)) {
    throw new Error("预览后下载游标发生变化，请重新生成预览");
  }
  return state;
}

function boundedPushBody(operations: GatewayOperation[]) {
  const prefix = '{"operations":[';
  const suffix = "]}";
  const encoder = new TextEncoder();
  let bytes = encoder.encode(prefix).byteLength + encoder.encode(suffix).byteLength;
  const serialized: string[] = [];
  const selected: GatewayOperation[] = [];
  for (const operation of operations) {
    const item = JSON.stringify(operation);
    const itemBytes = encoder.encode(item).byteLength + (serialized.length ? 1 : 0);
    if (bytes + itemBytes > SAFE_PUSH_BODY_BYTES && !serialized.length) {
      throw new Error(`单条同步数据超过安全上限：${operation.entityKey}`);
    }
    if (bytes + itemBytes > SAFE_PUSH_BODY_BYTES) break;
    serialized.push(item);
    selected.push(operation);
    bytes += itemBytes;
  }
  if (!selected.length) throw new Error("同步分批失败：没有可安全上传的数据");
  return { operations: selected, body: `${prefix}${serialized.join(",")}${suffix}`, bytes };
}

type SyncExecutionOptions = {
  maxPushBatches?: number;
  pushBatchOperations?: number;
  maxPullPages?: number;
};

async function pushAll(options: SyncExecutionOptions = {}) {
  const state = await ensureLocalState();
  const db = getD1();
  const maxBatches = Math.min(500, Math.max(1, integer(options.maxPushBatches) || SYNC_BATCHES_PER_REQUEST));
  const batchOperations = Math.min(200, Math.max(1, integer(options.pushBatchOperations) || 200));
  let acceptedCount = 0;
  let rejectedCount = 0;
  let batches = 0;
  for (; batches < maxBatches; batches += 1) {
    const result = await db.prepare(
      "SELECT * FROM cloud_sync_outbox WHERE status IN ('pending','retry') ORDER BY created_at LIMIT 200",
    ).all<JsonObject>();
    const rows = result.results || [];
    if (!rows.length) break;
    const available = rows.slice(0, batchOperations).map((row) => normalizeSyncOperation({
      schemaVersion: SYNC_SCHEMA_VERSION, operationId: row.operation_id, nodeId: state.node_id,
      entityType: row.entity_type, entityKey: row.entity_key, action: row.action,
      restore: Boolean(integer(row.restore)), baseVersion: integer(row.base_version),
      occurredAt: row.occurred_at, payload: text(row.action) === "delete" ? null : parseJson(row.payload_json, {}),
    }));
    const batch = boundedPushBody(available);
    const selectedRows = rows.slice(0, batch.operations.length);
    const byId = new Map(selectedRows.map((row) => [text(row.operation_id), row]));
    const response = await deviceFetch("/v1/sync/push", {
      method: "POST", headers: { "content-type": "application/json" }, body: batch.body,
    }, 60_000);
    const statements: D1PreparedStatement[] = [];
    for (const accepted of (response.accepted as JsonObject[] | undefined) || []) {
      const row = byId.get(text(accepted.operationId));
      if (!row) continue;
      acceptedCount += 1;
      const payload = text(row.action) === "delete" ? "" : text(row.payload_json);
      statements.push(db.prepare(
        `INSERT INTO cloud_sync_entity_versions(entity_type,entity_key,record_version,tombstone,payload_hash,updated_at)
         VALUES(?,?,?,?,?,?) ON CONFLICT(entity_type,entity_key) DO UPDATE SET record_version=excluded.record_version,
         tombstone=excluded.tombstone,payload_hash=excluded.payload_hash,updated_at=excluded.updated_at`,
      ).bind(row.entity_type, row.entity_key, integer(accepted.recordVersion), text(row.action) === "delete" ? 1 : 0, await sha256Hex(payload), nowIso()));
      statements.push(db.prepare("DELETE FROM cloud_sync_outbox WHERE operation_id=?").bind(row.operation_id));
    }
    for (const rejected of (response.rejected as JsonObject[] | undefined) || []) {
      const row = byId.get(text(rejected.operationId));
      if (!row) continue;
      rejectedCount += 1;
      let remote: JsonObject = {};
      try {
        remote = await deviceFetch(`/v1/sync/entity?entity_type=${encodeURIComponent(text(row.entity_type))}&entity_key=${encodeURIComponent(text(row.entity_key))}`);
      } catch {
        remote = {};
      }
      const conflictId = crypto.randomUUID();
      statements.push(db.prepare(
        "UPDATE cloud_sync_outbox SET status='conflict',attempt_count=attempt_count+1,last_error=?,updated_at=? WHERE operation_id=?",
      ).bind(text(rejected.reason), nowIso(), row.operation_id));
      statements.push(db.prepare(
        `INSERT INTO cloud_sync_conflicts(id,operation_id,entity_type,entity_key,current_version,reason,local_json,remote_json,status,created_at)
         VALUES(?,?,?,?,?,?,?,?, 'open',?)`,
      ).bind(conflictId, row.operation_id, row.entity_type, row.entity_key, integer(rejected.currentVersion), text(rejected.reason), JSON.stringify(row), JSON.stringify(remote.entity || null), nowIso()));
    }
    if (!statements.length) throw new Error("同步网关没有确认本批任何操作，已停止以避免静默循环");
    await db.batch(statements);
  }
  const remainingRow = await db.prepare(
    "SELECT COUNT(*) AS count FROM cloud_sync_outbox WHERE status IN ('pending','retry')",
  ).first<{ count: number }>();
  const remaining = integer(remainingRow?.count);
  return { accepted: acceptedCount, rejected: rejectedCount, batches, remaining, hasMore: remaining > 0 };
}

async function deterministicId(value: string) {
  return `sync-${(await sha256Hex(value)).slice(0, 32)}`;
}

function sourceKeyFromOperation(operation: GatewayOperation) {
  if (operation.payload?.sourceKey) return canonicalSourceKey({ sourceKey: operation.payload.sourceKey });
  if (!["input_source", "tool_source_binding", "telegram_message", "telegram_tool_queue", "telegram_read_state", "telegram_checkpoint"].includes(operation.entityType)) return "";
  const raw = operation.entityKey.replace(/^(?:source|binding|message|queue|read|checkpoint):/, "");
  if (operation.entityType === "tool_source_binding" || operation.entityType === "telegram_message") {
    return raw.split(":").slice(0, -1).join(":");
  }
  if (operation.entityType === "telegram_tool_queue") return raw.split(":").slice(0, -2).join(":");
  return raw;
}

async function resolveSourceIds(operations: GatewayOperation[]) {
  const db = getD1();
  const keys = [...new Set(operations.map(sourceKeyFromOperation).filter(Boolean))];
  const statements = keys.map((key) => {
    const raw = key.split(":");
    const kind = raw.shift() || "";
    const connectionId = raw.shift() || "default";
    const externalKey = raw.join(":");
    return db.prepare("SELECT id FROM input_sources WHERE kind=? AND connection_id=? AND external_key=? LIMIT 1")
      .bind(kind, localConnectionIdForSource(kind, connectionId), externalKey);
  });
  const rows = statements.length ? await db.batch(statements) : [];
  const output = new Map<string, string>();
  for (let index = 0; index < keys.length; index += 1) {
    const existing = text((rows[index]?.results?.[0] as JsonObject | undefined)?.id);
    output.set(keys[index], existing || await deterministicId(`source:${keys[index]}`));
  }
  return output;
}

function operationRank(operation: GatewayOperation) {
  const upsert = ["input_source", "content_run", "permanent_record", "tool_source_binding", "telegram_message", "telegram_checkpoint", "telegram_read_state", "content_result", "telegram_tool_queue", "task_inbox", "app_setting"];
  const rank = upsert.indexOf(operation.entityType);
  return operation.action === "delete" ? 100 - (rank < 0 ? 50 : rank) : (rank < 0 ? 50 : rank);
}

async function applyPulledPage(operations: GatewayOperation[], nextSequence: number) {
  const db = getD1();
  const state = await ensureLocalState();
  const normalized = operations.map((operation) => ({ ...operation, ...normalizeSyncOperation(operation) }));
  const versionChecks = normalized.map((operation) => db.prepare(
    "SELECT record_version FROM cloud_sync_entity_versions WHERE entity_type=? AND entity_key=?",
  ).bind(operation.entityType, operation.entityKey));
  const outboxChecks = normalized.map((operation) => db.prepare(
    "SELECT * FROM cloud_sync_outbox WHERE entity_type=? AND entity_key=? AND status IN ('pending','retry','conflict')",
  ).bind(operation.entityType, operation.entityKey));
  const [versions, outboxes] = await Promise.all([
    versionChecks.length ? db.batch(versionChecks) : Promise.resolve([]),
    outboxChecks.length ? db.batch(outboxChecks) : Promise.resolve([]),
  ]);
  const sourceIds = await resolveSourceIds(normalized);
  const applicable: GatewayOperation[] = [];
  const conflictStatements: D1PreparedStatement[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const operation = normalized[index];
    const localVersion = integer((versions[index]?.results?.[0] as JsonObject | undefined)?.record_version);
    if (localVersion >= integer(operation.recordVersion)) continue;
    const outbox = outboxes[index]?.results?.[0] as JsonObject | undefined;
    if (outbox && operation.nodeId !== state.node_id) {
      conflictStatements.push(db.prepare(
        `INSERT INTO cloud_sync_conflicts(id,operation_id,entity_type,entity_key,current_version,reason,local_json,remote_json,status,created_at)
         VALUES(?,?,?,?,?,'remote_changed_while_local_pending',?,?, 'open',?)`,
      ).bind(crypto.randomUUID(), text(outbox.operation_id), operation.entityType, operation.entityKey, integer(operation.recordVersion), JSON.stringify(outbox), JSON.stringify(operation), nowIso()));
      conflictStatements.push(db.prepare(
        "UPDATE cloud_sync_outbox SET status='conflict',last_error='远端在本地待上传期间发生变化',updated_at=? WHERE operation_id=?",
      ).bind(nowIso(), outbox.operation_id));
      conflictStatements.push(versionStatement(db, operation));
      continue;
    }
    applicable.push(operation);
  }
  applicable.sort((left, right) => operationRank(left) - operationRank(right));
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE cloud_sync_runtime SET suppress_outbox=1 WHERE id=1"),
    ...conflictStatements,
  ];
  for (const operation of applicable) {
    const business = await businessStatement(db, operation, sourceIds);
    if (business) statements.push(business);
    statements.push(versionStatement(db, operation));
  }
  statements.push(db.prepare(
    "UPDATE cloud_sync_state SET last_pulled_sequence=?,last_success_at=?,last_error='',updated_at=? WHERE id=?",
  ).bind(nextSequence, nowIso(), nowIso(), STATE_ID));
  statements.push(db.prepare("UPDATE cloud_sync_runtime SET suppress_outbox=0 WHERE id=1"));
  await db.batch(statements);
  return { applied: applicable.length, conflicts: conflictStatements.length / 3 };
}

function versionStatement(db: D1Database, operation: GatewayOperation) {
  return db.prepare(
    `INSERT INTO cloud_sync_entity_versions(entity_type,entity_key,record_version,tombstone,payload_hash,updated_at)
     VALUES(?,?,?,?,?,?) ON CONFLICT(entity_type,entity_key) DO UPDATE SET record_version=excluded.record_version,
     tombstone=excluded.tombstone,payload_hash=excluded.payload_hash,updated_at=excluded.updated_at`,
  ).bind(operation.entityType, operation.entityKey, integer(operation.recordVersion), operation.action === "delete" ? 1 : 0, "", text(operation.occurredAt) || nowIso());
}

async function businessStatement(db: D1Database, operation: GatewayOperation, sourceIds: Map<string, string>) {
  const payload = operation.payload || {};
  const deleting = operation.action === "delete";
  const timestamp = text(payload.updatedAt) || text(operation.occurredAt) || nowIso();
  switch (operation.entityType) {
    case "permanent_record":
      if (deleting) return db.prepare("DELETE FROM permanent_records WHERE tool=? AND lower(record_key)=lower(?)").bind(text(operation.entityKey.split(":")[1]), operation.entityKey.split(":").slice(2).join(":"));
      return db.prepare(
        `INSERT INTO permanent_records(id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tool,record_key) DO UPDATE SET primary_value=excluded.primary_value,
         secondary_value=excluded.secondary_value,status=excluded.status,tags_json=excluded.tags_json,actress_tags_json=excluded.actress_tags_json,
         genre_tags_json=excluded.genre_tags_json,source_url=excluded.source_url,missav_url=excluded.missav_url,av123_url=excluded.av123_url,
         metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
      ).bind(await deterministicId(operation.entityKey), text(payload.tool), text(payload.recordKey), text(payload.primaryValue), text(payload.secondaryValue), text(payload.status) || "new", JSON.stringify(payload.tags || []), JSON.stringify(payload.actressTags || []), JSON.stringify(payload.genreTags || []), text(payload.sourceUrl), text(payload.missavUrl), text(payload.av123Url), JSON.stringify(safeValue(payload.metadata || {})), text(payload.createdAt) || timestamp, timestamp);
    case "content_run": {
      const runId = text(payload.globalId) || operation.entityKey.replace(/^run:/, "");
      if (deleting) return db.prepare("DELETE FROM content_runs WHERE id=?").bind(runId);
      return db.prepare(
        `INSERT INTO content_runs(id,tool,name,input_kind,start_at,end_at,source_summary,status,stats_json,options_json,total_count,result_count,error_count,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tool=excluded.tool,name=excluded.name,input_kind=excluded.input_kind,
         start_at=excluded.start_at,end_at=excluded.end_at,source_summary=CASE WHEN excluded.source_summary='' THEN content_runs.source_summary ELSE excluded.source_summary END,
         status=excluded.status,stats_json=excluded.stats_json,options_json=excluded.options_json,total_count=excluded.total_count,
         result_count=excluded.result_count,error_count=excluded.error_count,updated_at=excluded.updated_at`,
      ).bind(runId, text(payload.tool), text(payload.name), text(payload.inputKind), text(payload.startAt), text(payload.endAt), text(payload.originalInput).slice(0, 64 * 1024), text(payload.status) || "completed", JSON.stringify(payload.stats || {}), JSON.stringify(safeValue(payload.options || {})), integer(payload.totalCount), integer(payload.resultCount), integer(payload.errorCount), text(payload.createdAt) || timestamp, timestamp);
    }
    case "content_result": {
      const runKey = text(payload.runKey) || operation.entityKey.replace(/^result:/, "").split(":")[0];
      const resultKey = text(payload.resultKey) || operation.entityKey.split(":").slice(2).join(":");
      if (deleting) return db.prepare("DELETE FROM content_results WHERE run_id=? AND lower(result_key)=lower(?)").bind(runKey, resultKey);
      return db.prepare(
        `INSERT INTO content_results(id,run_id,tool,result_key,primary_value,secondary_value,status,error_message,tags_json,source,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,result_key) DO UPDATE SET tool=excluded.tool,primary_value=excluded.primary_value,
         secondary_value=excluded.secondary_value,status=excluded.status,error_message=excluded.error_message,tags_json=excluded.tags_json,
         source=excluded.source,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
      ).bind(await deterministicId(operation.entityKey), runKey, text(payload.tool), resultKey, text(payload.primaryValue), text(payload.secondaryValue), text(payload.status) || "success", text(payload.error), JSON.stringify(payload.tags || []), text(payload.source), JSON.stringify(safeValue(payload.metadata || {})), text(payload.createdAt) || timestamp, timestamp);
    }
    case "input_source": {
      const source = payload.sourceKey ? sourcePayload(payload) : sourcePayload({ sourceKind: operation.entityKey.replace(/^source:/, "").split(":")[0], sourceConnectionId: operation.entityKey.replace(/^source:/, "").split(":")[1], sourceExternalKey: operation.entityKey.replace(/^source:/, "").split(":").slice(2).join(":") });
      const sourceId = sourceIds.get(source.sourceKey) || await deterministicId(operation.entityKey);
      if (deleting) return db.prepare("DELETE FROM input_sources WHERE id=?").bind(sourceId);
      const metadata = safeValue(payload.metadata || {}) as JsonObject;
      return db.prepare(
        `INSERT INTO input_sources(id,kind,external_key,connection_id,external_chat_id,chat_type,username,access_status,archived,last_sync_at,latest_remote_message_id,incremental_checkpoint_id,sync_cursor_message_id,sync_target_message_id,last_error,name,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,external_key) DO UPDATE SET connection_id=excluded.connection_id,
         external_chat_id=excluded.external_chat_id,chat_type=excluded.chat_type,username=excluded.username,access_status=excluded.access_status,
         archived=excluded.archived,last_sync_at=excluded.last_sync_at,latest_remote_message_id=excluded.latest_remote_message_id,
         sync_cursor_message_id=excluded.sync_cursor_message_id,sync_target_message_id=excluded.sync_target_message_id,last_error=excluded.last_error,
         name=excluded.name,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
      ).bind(sourceId, source.kind, source.externalKey, localConnectionIdForSource(source.kind, source.connectionId), text(payload.externalChatId) || source.externalKey, text(metadata.chatType ?? payload.sourceType), text(metadata.username), text(metadata.accessStatus) || "unknown", payload.enabled === false || metadata.archived === true ? 1 : 0, text(payload.lastSyncAt), text(metadata.latestRemoteMessageId), text(payload.incrementalCheckpointId), text(metadata.syncCursorMessageId), text(metadata.syncTargetMessageId), text(metadata.lastError), text(payload.name) || source.externalKey, JSON.stringify(metadata), text(payload.createdAt) || timestamp, timestamp);
    }
    case "tool_source_binding": {
      const sourceKey = text(payload.sourceKey) ? canonicalSourceKey({ sourceKey: payload.sourceKey }) : operation.entityKey.replace(/^binding:/, "").split(":").slice(0, -1).join(":");
      const sourceId = sourceIds.get(sourceKey);
      const tool = text(payload.tool) || operation.entityKey.split(":").at(-1) || "";
      if (!sourceId) return null;
      if (deleting) return db.prepare("DELETE FROM tool_source_bindings WHERE source_id=? AND tool=?").bind(sourceId, tool);
      return db.prepare(
        `INSERT INTO tool_source_bindings(id,source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at)
         VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,tool) DO UPDATE SET history_mode=excluded.history_mode,
         history_limit=excluded.history_limit,history_from=excluded.history_from,bound_at_message_id=excluded.bound_at_message_id`,
      ).bind(await deterministicId(operation.entityKey), sourceId, tool, text(payload.historyMode) || "since_now", integer(payload.historyLimit), text(payload.historyFrom), text(payload.boundAtMessageId), text(payload.createdAt) || timestamp);
    }
    case "telegram_message": {
      const sourceKey = text(payload.sourceKey) ? canonicalSourceKey({ sourceKey: payload.sourceKey }) : operation.entityKey.replace(/^message:/, "").split(":").slice(0, -1).join(":");
      const sourceId = sourceIds.get(sourceKey);
      const messageId = text(payload.messageId) || operation.entityKey.split(":").at(-1) || "";
      if (!sourceId) return null;
      if (deleting) return db.prepare("DELETE FROM telegram_messages WHERE source_id=? AND message_id=?").bind(sourceId, messageId);
      return db.prepare(
        `INSERT INTO telegram_messages(id,source_id,message_id,connection_id,external_message_id,remote_update_id,message_date,body,event_kind,content_hash,remote_edited_at,remote_deleted_at,body_deleted_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,message_id) DO UPDATE SET external_message_id=excluded.external_message_id,
         remote_update_id=excluded.remote_update_id,message_date=excluded.message_date,body=excluded.body,event_kind=excluded.event_kind,
         content_hash=excluded.content_hash,remote_edited_at=excluded.remote_edited_at,remote_deleted_at=excluded.remote_deleted_at,
         body_deleted_at=excluded.body_deleted_at,updated_at=excluded.updated_at`,
      ).bind(await deterministicId(operation.entityKey), sourceId, messageId, localConnectionIdForSource(sourceKey.split(":")[0], sourceKey.split(":")[1] || "default"), text(payload.externalMessageId) || messageId, text(payload.remoteUpdateId), text(payload.messageDate), text(payload.body), text(payload.eventKind) || "message", text(payload.contentHash), text(payload.remoteEditedAt), text(payload.remoteDeletedAt), text(payload.bodyDeletedAt), text(payload.createdAt) || timestamp, timestamp);
    }
    case "telegram_tool_queue": {
      const sourceKey = text(payload.sourceKey) ? canonicalSourceKey({ sourceKey: payload.sourceKey }) : operation.entityKey.replace(/^queue:/, "").split(":").slice(0, -2).join(":");
      const sourceId = sourceIds.get(sourceKey);
      const messageId = text(payload.messageId) || operation.entityKey.split(":").at(-2) || "";
      const tool = text(payload.tool) || operation.entityKey.split(":").at(-1) || "";
      if (!sourceId) return null;
      const messageRow = await db.prepare("SELECT id FROM telegram_messages WHERE source_id=? AND message_id=?").bind(sourceId, messageId).first<{ id: string }>();
      const telegramMessageId = text(messageRow?.id) || await deterministicId(`message:${sourceKey}:${messageId}`);
      if (deleting) return db.prepare("DELETE FROM telegram_tool_queue WHERE telegram_message_id=? AND tool=?").bind(telegramMessageId, tool);
      return db.prepare(
        `INSERT INTO telegram_tool_queue(id,telegram_message_id,tool,status,message_date,candidate_count,candidate_preview,run_id,error_message,selected_at,processing_at,processed_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(telegram_message_id,tool) DO UPDATE SET status=excluded.status,message_date=excluded.message_date,
         candidate_count=excluded.candidate_count,candidate_preview=excluded.candidate_preview,run_id=excluded.run_id,error_message=excluded.error_message,
         selected_at=excluded.selected_at,processing_at=excluded.processing_at,processed_at=excluded.processed_at,updated_at=excluded.updated_at`,
      ).bind(await deterministicId(operation.entityKey), telegramMessageId, tool, text(payload.status) || "pending", text(payload.messageDate), integer(payload.candidateCount), text(payload.candidatePreview), text(payload.runKey), text(payload.error), text(payload.selectedAt), text(payload.processingAt), text(payload.processedAt), text(payload.createdAt) || timestamp, timestamp);
    }
    case "telegram_checkpoint": {
      const sourceKey = text(payload.sourceKey) ? canonicalSourceKey({ sourceKey: payload.sourceKey }) : operation.entityKey.replace(/^checkpoint:/, "");
      const sourceId = sourceIds.get(sourceKey);
      if (!sourceId || deleting) return null;
      return db.prepare(
        `UPDATE input_sources SET incremental_checkpoint_id=CASE WHEN CAST(? AS INTEGER)>CAST(incremental_checkpoint_id AS INTEGER) THEN ? ELSE incremental_checkpoint_id END,
         sync_cursor_message_id=CASE WHEN CAST(? AS INTEGER)>CAST(sync_cursor_message_id AS INTEGER) THEN ? ELSE sync_cursor_message_id END,
         updated_at=? WHERE id=?`,
      ).bind(text(payload.checkpoint), text(payload.checkpoint), text(payload.continuation), text(payload.continuation), timestamp, sourceId);
    }
    case "telegram_read_state": {
      const sourceKey = text(payload.sourceKey) ? canonicalSourceKey({ sourceKey: payload.sourceKey }) : operation.entityKey.replace(/^read:/, "");
      const sourceId = sourceIds.get(sourceKey);
      if (!sourceId) return null;
      if (deleting) return db.prepare("DELETE FROM telegram_read_states WHERE source_id=?").bind(sourceId);
      return db.prepare(
        `INSERT INTO telegram_read_states(source_id,policy,safe_read_message_id,last_marked_read_message_id,read_baseline_message_id,updated_at)
         VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET policy=excluded.policy,
         safe_read_message_id=CASE WHEN CAST(excluded.safe_read_message_id AS INTEGER)>CAST(telegram_read_states.safe_read_message_id AS INTEGER) THEN excluded.safe_read_message_id ELSE telegram_read_states.safe_read_message_id END,
         last_marked_read_message_id=CASE WHEN CAST(excluded.last_marked_read_message_id AS INTEGER)>CAST(telegram_read_states.last_marked_read_message_id AS INTEGER) THEN excluded.last_marked_read_message_id ELSE telegram_read_states.last_marked_read_message_id END,
         read_baseline_message_id=CASE WHEN CAST(excluded.read_baseline_message_id AS INTEGER)>CAST(telegram_read_states.read_baseline_message_id AS INTEGER) THEN excluded.read_baseline_message_id ELSE telegram_read_states.read_baseline_message_id END,updated_at=excluded.updated_at`,
      ).bind(sourceId, text(payload.policy) || "never", text(payload.safeReadMessageId) || "0", text(payload.lastMarkedReadMessageId) || "0", text(payload.readBaselineMessageId) || "0", timestamp);
    }
    case "task_inbox": {
      const globalId = text(payload.globalId) || operation.entityKey.replace(/^task:/, "");
      if (deleting) return db.prepare("DELETE FROM task_inbox WHERE id=? OR run_id=?").bind(globalId, globalId);
      const taskSourceKey = text(payload.sourceKey) ? canonicalSourceKey({ sourceKey: payload.sourceKey }) : "";
      const sourceId = sourceIds.get(taskSourceKey) || "";
      return db.prepare(
        `INSERT INTO task_inbox(id,tool,stage,phase,title,run_id,record_id,source_id,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tool=excluded.tool,stage=excluded.stage,phase=excluded.phase,
         title=excluded.title,run_id=excluded.run_id,source_id=excluded.source_id,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
      ).bind(globalId, text(payload.tool), text(payload.stage), text(payload.phase) || "received", text(payload.title), text(payload.runKey) || globalId, "", sourceId, JSON.stringify(safeValue({ ...(payload.metadata as JsonObject || {}), summary: payload.summary, error: payload.error })), text(payload.createdAt) || timestamp, timestamp);
    }
    case "app_setting": {
      const syncKey = text(payload.key) || operation.entityKey.replace(/^setting:/, "");
      const localKey = SYNC_TO_SETTING[syncKey.toLowerCase()];
      if (!localKey) return null;
      if (deleting) return db.prepare("DELETE FROM app_settings WHERE key=?").bind(localKey);
      return db.prepare(
        "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
      ).bind(localKey, JSON.stringify(payload.value || []), timestamp);
    }
    default:
      return null;
  }
}

async function pullAll(options: SyncExecutionOptions = {}) {
  let state = await ensureLocalState();
  let applied = 0;
  let conflicts = 0;
  let pages = 0;
  let hasMore = false;
  let latestSequence = integer(state.last_pulled_sequence);
  const maxPages = Math.min(500, Math.max(1, integer(options.maxPullPages) || SYNC_BATCHES_PER_REQUEST));
  for (; pages < maxPages; pages += 1) {
    const response = await deviceFetch(`/v1/sync/pull?after=${integer(state.last_pulled_sequence)}&limit=50`, {}, 60_000);
    const operations = ((response.operations as GatewayOperation[] | undefined) || []);
    const next = integer(response.nextSequence);
    if (operations.length) {
      const pageResult = await applyPulledPage(operations, next);
      applied += pageResult.applied;
      conflicts += pageResult.conflicts;
    } else if (next > integer(state.last_pulled_sequence)) {
      await getD1().prepare("UPDATE cloud_sync_state SET last_pulled_sequence=?,updated_at=? WHERE id=?")
        .bind(next, nowIso(), STATE_ID).run();
    }
    state = { ...state, last_pulled_sequence: next };
    hasMore = response.hasMore === true;
    latestSequence = integer(response.latestSequence);
    if (!hasMore) break;
  }
  return {
    applied,
    conflicts,
    pages: Math.min(pages + 1, maxPages),
    lastPulledSequence: integer(state.last_pulled_sequence),
    remaining: Math.max(0, latestSequence - integer(state.last_pulled_sequence)),
    hasMore,
  };
}

export async function executeCloudSync(mode: "push" | "pull" | "both", options: SyncExecutionOptions = {}) {
  const state = await requireFreshPreview();
  const result: JsonObject = { mode };
  try {
    let incomplete = false;
    if (mode === "push" || mode === "both") {
      result.push = await pushAll(options);
      incomplete = (result.push as JsonObject).hasMore === true;
    }
    if (!incomplete && (mode === "pull" || mode === "both")) {
      result.pull = await pullAll(options);
      incomplete = (result.pull as JsonObject).hasMore === true;
    }
    result.incomplete = incomplete;
    result.requiresContinuationPreview = incomplete;
    const completedAt = nowIso();
    await getD1().prepare(
      "UPDATE cloud_sync_state SET preview_json='{}',preview_expires_at='',last_success_at=?,last_error='',updated_at=? WHERE id=?",
    ).bind(incomplete ? state.last_success_at : completedAt, completedAt, STATE_ID).run();
    return result;
  } catch (error) {
    const message = text(error instanceof Error ? error.message : error).slice(0, 800);
    await getD1().prepare("UPDATE cloud_sync_state SET last_error=?,updated_at=? WHERE id=?")
      .bind(message, nowIso(), STATE_ID).run();
    throw error;
  }
}

export async function retryCloudSyncConflicts() {
  const db = getD1();
  const state = await ensureLocalState();
  const timestamp = nowIso();
  const rows = await db.prepare(
    `SELECT c.id,c.current_version,c.remote_json,o.operation_id FROM cloud_sync_conflicts c
     JOIN cloud_sync_outbox o ON o.entity_type=c.entity_type AND o.entity_key=c.entity_key
     WHERE c.status='open' AND o.status='conflict' ORDER BY c.created_at`,
  ).all<JsonObject>();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results || []) {
    const remote = parseJson<JsonObject>(row.remote_json, {});
    const tombstone = remote.tombstone === true || text(remote.action) === "delete";
    statements.push(db.prepare(
      `UPDATE cloud_sync_outbox SET operation_id=?,status='retry',base_version=?,restore=?,last_error='',updated_at=?
       WHERE operation_id=?`,
    ).bind(`${state.node_id}:resolve:${crypto.randomUUID()}`.slice(0, 128), integer(row.current_version), tombstone ? 1 : 0, timestamp, row.operation_id));
    statements.push(db.prepare("UPDATE cloud_sync_conflicts SET status='resolved_local',resolved_at=? WHERE id=?").bind(timestamp, row.id));
  }
  if (statements.length) {
    statements.push(db.prepare("UPDATE cloud_sync_state SET preview_json='{}',preview_expires_at='',updated_at=? WHERE id=?").bind(timestamp, STATE_ID));
    await db.batch(statements);
  }
  return { retried: (rows.results || []).length };
}

function remoteConflictOperation(value: JsonObject): GatewayOperation {
  if (value.entity && typeof value.entity === "object") return remoteConflictOperation(value.entity as JsonObject);
  if (value.action) return value as unknown as GatewayOperation;
  const recordVersion = integer(value.recordVersion);
  const tombstone = value.tombstone === true || integer(value.tombstone) === 1;
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    operationId: text(value.operationId) || `remote-conflict-${crypto.randomUUID()}`,
    nodeId: text(value.originNodeId) || "remote",
    entityType: text(value.entityType),
    entityKey: text(value.entityKey),
    action: tombstone ? "delete" : "upsert",
    baseVersion: Math.max(0, recordVersion - 1),
    recordVersion,
    occurredAt: text(value.updatedAt) || nowIso(),
    payload: tombstone ? null : (value.payload as JsonObject || {}),
  };
}

export async function resolveCloudSyncConflict(id: string, choice: "remote" | "local") {
  await ensureCloudSyncSchema();
  const db = getD1();
  const conflict = await db.prepare("SELECT * FROM cloud_sync_conflicts WHERE id=? AND status='open'").bind(text(id)).first<JsonObject>();
  if (!conflict) throw new Error("同步冲突不存在或已经处理");
  const timestamp = nowIso();
  if (choice === "local") {
    const outbox = await db.prepare(
      "SELECT operation_id FROM cloud_sync_outbox WHERE entity_type=? AND entity_key=?",
    ).bind(conflict.entity_type, conflict.entity_key).first<JsonObject>();
    if (!outbox) throw new Error("本地待上传内容已经不存在，不能选择保留网页");
    const remote = parseJson<JsonObject>(conflict.remote_json, {});
    const remoteEntity = (remote.entity && typeof remote.entity === "object" ? remote.entity : remote) as JsonObject;
    const tombstone = remoteEntity.tombstone === true || text(remoteEntity.action) === "delete";
    const state = await ensureLocalState();
    await db.batch([
      db.prepare(
        `UPDATE cloud_sync_outbox SET operation_id=?,status='retry',base_version=?,restore=?,last_error='',updated_at=?
         WHERE operation_id=?`,
      ).bind(`${state.node_id}:resolve:${crypto.randomUUID()}`.slice(0, 128), integer(conflict.current_version), tombstone ? 1 : 0, timestamp, outbox.operation_id),
      db.prepare("UPDATE cloud_sync_conflicts SET status='resolved_local',resolved_at=? WHERE id=?").bind(timestamp, conflict.id),
      db.prepare("UPDATE cloud_sync_state SET preview_json='{}',preview_expires_at='',updated_at=? WHERE id=?").bind(timestamp, STATE_ID),
    ]);
    return { resolved: true, choice, requiresPreview: true };
  }

  const operation = remoteConflictOperation(parseJson<JsonObject>(conflict.remote_json, {}));
  if (!operation.entityType || !operation.entityKey || !integer(operation.recordVersion)) throw new Error("远端冲突内容不完整，不能安全采用");
  const sourceIds = await resolveSourceIds([operation]);
  const business = await businessStatement(db, operation, sourceIds);
  const statements: D1PreparedStatement[] = [db.prepare("UPDATE cloud_sync_runtime SET suppress_outbox=1 WHERE id=1")];
  if (business) statements.push(business);
  statements.push(
    versionStatement(db, operation),
    db.prepare("DELETE FROM cloud_sync_outbox WHERE entity_type=? AND entity_key=?").bind(operation.entityType, operation.entityKey),
    db.prepare("UPDATE cloud_sync_conflicts SET status='resolved_remote',resolved_at=? WHERE id=?").bind(timestamp, conflict.id),
    db.prepare("UPDATE cloud_sync_state SET preview_json='{}',preview_expires_at='',updated_at=? WHERE id=?").bind(timestamp, STATE_ID),
    db.prepare("UPDATE cloud_sync_runtime SET suppress_outbox=0 WHERE id=1"),
  );
  await db.batch(statements);
  return { resolved: true, choice, requiresPreview: false };
}

export async function acquireCloudTelegramLease(connectionKey: string, sourceKey: string) {
  if (!text(env.SYNC_GATEWAY_URL) || !text(env.SYNC_ADMIN_TOKEN)) return null;
  const leaseKey = `telegram:${text(connectionKey).toLowerCase()}:${text(sourceKey).toLowerCase()}`;
  const acquired = await deviceFetch("/v1/leases/acquire", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseKey, ttlSeconds: 120 }),
  });
  if (!acquired.acquired) throw new Error(`该 Telegram 来源正在由 ${text(acquired.holderNodeId) || "另一端"} 执行`);
  return { leaseKey, leaseToken: text(acquired.leaseToken), expiresAt: text(acquired.expiresAt) };
}

type CloudTelegramLease = { leaseKey: string; leaseToken: string; expiresAt: string };

export async function renewCloudTelegramLease(lease: { leaseKey: string; leaseToken: string }) {
  return deviceFetch("/v1/leases/renew", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...lease, ttlSeconds: 120 }),
  });
}

export async function releaseCloudTelegramLease(lease: { leaseKey: string; leaseToken: string } | null) {
  if (!lease) return;
  try {
    await deviceFetch("/v1/leases/release", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(lease),
    });
  } catch {
    // A lost/expired lease is already safe; never hide the original Telegram result.
  }
}

async function renewTrackedCloudTelegramLease(lease: CloudTelegramLease) {
  const renewed = await renewCloudTelegramLease(lease);
  const expiresAt = text(renewed.expiresAt);
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) throw new Error("同步网关未返回有效的租约到期时间");
  lease.expiresAt = expiresAt;
}

function assertCloudTelegramLeasesActive(leases: CloudTelegramLease[], leaseError: Error | null) {
  if (leaseError) throw new Error(`跨端 Telegram 执行权已失效：${leaseError.message}`);
  const expiring = leases.find((lease) => {
    const expiresAt = Date.parse(lease.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5_000;
  });
  if (expiring) throw new Error(`跨端 Telegram 执行权已失效或即将到期：${expiring.leaseKey}`);
}

export async function withCloudTelegramSourceLeases<T>(
  sourceIds: string[],
  fallbackConnection: "telegram-personal" | "telegram-bot",
  run: (assertActive: () => void) => Promise<T>,
) {
  if (!text(env.SYNC_GATEWAY_URL) || !text(env.SYNC_ADMIN_TOKEN)) return run(() => undefined);
  await ensureCloudSyncSchema();
  if (fallbackConnection === "telegram-bot") {
    const lease = await acquireCloudTelegramLease("bot", "global-offset");
    const leases = lease ? [lease] : [];
    let leaseError: Error | null = null;
    try {
      const timer = setInterval(() => {
        if (!lease) return;
        void renewTrackedCloudTelegramLease(lease)
          .catch((error) => { leaseError = error instanceof Error ? error : new Error(String(error)); });
      }, 30_000);
      const assertActive = () => assertCloudTelegramLeasesActive(leases, leaseError);
      try {
        const result = await run(assertActive);
        assertActive();
        return result;
      } finally {
        clearInterval(timer);
      }
    } finally {
      await releaseCloudTelegramLease(lease);
    }
  }
  const uniqueIds = [...new Set(sourceIds.map(text).filter(Boolean))];
  const db = getD1();
  const rows = uniqueIds.length
    ? await db.batch(uniqueIds.map((id) => db.prepare(
        "SELECT kind,connection_id,external_key,external_chat_id FROM input_sources WHERE id=? LIMIT 1",
      ).bind(id)))
    : [];
  const targets = rows.map((result) => result.results?.[0] as JsonObject | undefined)
    .filter((row): row is JsonObject => Boolean(row))
    .map((row) => {
      const source = sourcePayload(row);
      return { connection: "personal", sourceKey: text(row.external_chat_id) || source.externalKey };
    });
  if (!targets.length) targets.push({ connection: "personal", sourceKey: "global-session" });
  const leases: CloudTelegramLease[] = [];
  let leaseError: Error | null = null;
  try {
    for (const target of targets) {
      const lease = await acquireCloudTelegramLease(target.connection, target.sourceKey);
      if (lease) leases.push(lease);
    }
    const timer = setInterval(() => {
      void Promise.all(leases.map((lease) => renewTrackedCloudTelegramLease(lease)))
        .catch((error) => { leaseError = error instanceof Error ? error : new Error(String(error)); });
    }, 30_000);
    const assertActive = () => assertCloudTelegramLeasesActive(leases, leaseError);
    try {
      const result = await run(assertActive);
      assertActive();
      return result;
    } finally {
      clearInterval(timer);
    }
  } finally {
    await Promise.all(leases.map((lease) => releaseCloudTelegramLease(lease)));
  }
}
