import {
  SYNC_SCHEMA_VERSION,
  normalizeSyncOperation,
  resolveSyncConflict,
  stableStringify,
  validateSyncBatch,
} from "../../../packages/sync-contract/index.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function isoNow() {
  return new Date().toISOString();
}

function randomHex(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomCode(length = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizePairingCode(value) {
  return String(value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function extractBearer(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  return match ? match[1].trim() : "";
}

export function safeLimit(value, fallback = 200, max = 500) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
}

export function redactError(error) {
  const message = error instanceof Error ? error.message : String(error || "请求失败");
  return message
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:token|secret|api_hash|session|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 800);
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error("请求超过 4 MB"), { status: 413 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw Object.assign(new Error("请求超过 4 MB"), { status: 413 });
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("JSON 无法解析"), { status: 400 });
  }
}

async function requireAdmin(request, env) {
  const expected = String(env.SYNC_ADMIN_TOKEN || "");
  const supplied = request.headers.get("x-sync-admin-token") || "";
  if (!expected || !supplied || supplied !== expected) throw Object.assign(new Error("无权执行同步管理操作"), { status: 401 });
}

async function requireDevice(request, env, scope) {
  const token = extractBearer(request);
  if (!token) throw Object.assign(new Error("缺少设备凭据"), { status: 401 });
  const tokenHash = await sha256(token);
  const device = await env.DB.prepare(
    "SELECT id,node_id,label,status,scopes_json FROM sync_devices WHERE token_hash=?",
  ).bind(tokenHash).first();
  if (!device || device.status !== "active") throw Object.assign(new Error("设备凭据无效或已撤销"), { status: 401 });
  let scopes = [];
  try { scopes = JSON.parse(device.scopes_json || "[]"); } catch { scopes = []; }
  if (scope && !scopes.includes(scope)) throw Object.assign(new Error("设备缺少所需权限"), { status: 403 });
  await env.DB.prepare("UPDATE sync_devices SET last_seen_at=?,updated_at=? WHERE id=?")
    .bind(isoNow(), isoNow(), device.id).run();
  return device;
}

function currentAsOperation(row) {
  return normalizeSyncOperation({
    schemaVersion: SYNC_SCHEMA_VERSION,
    operationId: row.last_operation_id,
    nodeId: row.origin_node_id,
    entityType: row.entity_type,
    entityKey: row.entity_key,
    action: Number(row.tombstone) ? "delete" : "upsert",
    baseVersion: Math.max(0, Number(row.record_version) - 1),
    recordVersion: Number(row.record_version),
    occurredAt: row.updated_at,
    payload: Number(row.tombstone) ? null : JSON.parse(row.payload_json || "{}"),
  });
}

async function latestSequence(env) {
  const row = await env.DB.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM sync_changes").first();
  return Number(row?.sequence || 0);
}

async function createPairing(request, env) {
  await requireAdmin(request, env);
  const body = await readBody(request);
  const code = randomCode();
  const id = `pair_${randomHex(12)}`;
  const createdAt = isoNow();
  const ttlSeconds = Math.max(60, Math.min(900, Number(body.ttlSeconds || 600)));
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sync_pairing_codes(id,code_hash,label,expires_at,created_at) VALUES (?,?,?,?,?)",
  ).bind(id, await sha256(code), String(body.label || "Windows 设备").slice(0, 120), expiresAt, createdAt).run();
  return json({ code, expiresAt });
}

async function exchangePairing(request, env) {
  const body = await readBody(request);
  const code = normalizePairingCode(body.code);
  if (code.length !== 10) throw Object.assign(new Error("配对码格式无效"), { status: 400 });
  const now = isoNow();
  const pairing = await env.DB.prepare(
    "SELECT id,label,expires_at,used_at FROM sync_pairing_codes WHERE code_hash=?",
  ).bind(await sha256(code)).first();
  if (!pairing || pairing.used_at || pairing.expires_at <= now) throw Object.assign(new Error("配对码无效或已过期"), { status: 400 });

  const claimed = await env.DB.prepare("UPDATE sync_pairing_codes SET used_at=? WHERE id=? AND used_at=''")
    .bind(now, pairing.id).run();
  if (Number(claimed.meta?.changes || 0) !== 1) {
    throw Object.assign(new Error("配对码已经被其他设备使用"), { status: 409 });
  }

  const nodeId = String(body.nodeId || `desktop_${randomHex(12)}`).trim().slice(0, 128);
  const label = String(body.label || pairing.label || "Windows 设备").trim().slice(0, 120);
  const token = `tgds_${randomHex(32)}`;
  const deviceId = `dev_${randomHex(12)}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sync_devices(id,node_id,label,token_hash,created_at,updated_at,last_seen_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET label=excluded.label,token_hash=excluded.token_hash,status='active',updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,revoked_at=''",
    ).bind(deviceId, nodeId, label, await sha256(token), now, now, now),
    env.DB.prepare("INSERT INTO sync_node_cursors(node_id,updated_at) VALUES (?,?) ON CONFLICT(node_id) DO UPDATE SET updated_at=excluded.updated_at").bind(nodeId, now),
  ]);
  return json({ schemaVersion: SYNC_SCHEMA_VERSION, nodeId, deviceToken: token, latestSequence: await latestSequence(env) });
}

async function pushChanges(request, env) {
  const device = await requireDevice(request, env, "sync:write");
  const batch = validateSyncBatch(await readBody(request), { maxOperations: 500, maxBytes: MAX_BODY_BYTES });
  const accepted = [];
  const rejected = [];
  for (const input of batch.operations) {
    if (input.nodeId !== device.node_id) {
      rejected.push({ operationId: input.operationId, reason: "node_id_mismatch" });
      continue;
    }
    const duplicate = await env.DB.prepare("SELECT sequence,record_version FROM sync_changes WHERE operation_id=?")
      .bind(input.operationId).first();
    if (duplicate) {
      accepted.push({ operationId: input.operationId, sequence: Number(duplicate.sequence), recordVersion: Number(duplicate.record_version), duplicate: true });
      continue;
    }

    const currentRow = await env.DB.prepare("SELECT * FROM sync_entities WHERE entity_type=? AND entity_key=?")
      .bind(input.entityType, input.entityKey).first();
    let operation = input;
    const restoringTombstone = currentRow && Number(currentRow.tombstone) === 1 && input.action === "upsert";
    if (currentRow && (Number(currentRow.record_version) !== input.baseVersion || restoringTombstone)) {
      const resolution = resolveSyncConflict(currentAsOperation(currentRow), input);
      if (resolution.decision === "current" || resolution.decision === "conflict") {
        const now = isoNow();
        await env.DB.prepare(
          "INSERT INTO sync_conflicts(operation_id,node_id,entity_type,entity_key,current_version,base_version,reason,current_json,incoming_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).bind(input.operationId, input.nodeId, input.entityType, input.entityKey, Number(currentRow.record_version), input.baseVersion, resolution.reason, stableStringify(currentAsOperation(currentRow)), stableStringify(input), now).run();
        rejected.push({ operationId: input.operationId, reason: resolution.reason, currentVersion: Number(currentRow.record_version) });
        continue;
      }
      operation = resolution.operation;
    }

    const recordVersion = Number(currentRow?.record_version || 0) + 1;
    const acceptedAt = isoNow();
    const tombstone = operation.action === "delete" ? 1 : 0;
    const payloadJson = tombstone ? "" : stableStringify(operation.payload);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sync_entities(entity_type,entity_key,record_version,tombstone,payload_json,origin_node_id,last_operation_id,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(entity_type,entity_key) DO UPDATE SET record_version=excluded.record_version,tombstone=excluded.tombstone,payload_json=excluded.payload_json,origin_node_id=excluded.origin_node_id,last_operation_id=excluded.last_operation_id,updated_at=excluded.updated_at",
      ).bind(operation.entityType, operation.entityKey, recordVersion, tombstone, payloadJson, operation.nodeId, operation.operationId, operation.occurredAt),
      env.DB.prepare(
        "INSERT INTO sync_changes(operation_id,node_id,entity_type,entity_key,action,base_version,record_version,payload_json,occurred_at,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(operation.operationId, operation.nodeId, operation.entityType, operation.entityKey, operation.action, operation.baseVersion, recordVersion, payloadJson, operation.occurredAt, acceptedAt),
    ]);
    const sequenceRow = await env.DB.prepare("SELECT sequence FROM sync_changes WHERE operation_id=?").bind(operation.operationId).first();
    accepted.push({ operationId: operation.operationId, sequence: Number(sequenceRow.sequence), recordVersion, duplicate: false });
  }
  const now = isoNow();
  await env.DB.prepare(
    "INSERT INTO sync_node_cursors(node_id,last_pushed_at,updated_at) VALUES (?,?,?) ON CONFLICT(node_id) DO UPDATE SET last_pushed_at=excluded.last_pushed_at,updated_at=excluded.updated_at",
  ).bind(device.node_id, now, now).run();
  return json({ schemaVersion: SYNC_SCHEMA_VERSION, accepted, rejected, latestSequence: await latestSequence(env) });
}

async function pullChanges(request, env) {
  const device = await requireDevice(request, env, "sync:read");
  const url = new URL(request.url);
  const after = Math.max(0, Number(url.searchParams.get("after") || 0));
  const limit = safeLimit(url.searchParams.get("limit"), 200, 500);
  const result = await env.DB.prepare(
    "SELECT sequence,operation_id,node_id,entity_type,entity_key,action,base_version,record_version,payload_json,occurred_at FROM sync_changes WHERE sequence>? ORDER BY sequence LIMIT ?",
  ).bind(after, limit).all();
  const operations = (result.results || []).map((row) => ({
    schemaVersion: SYNC_SCHEMA_VERSION,
    sequence: Number(row.sequence),
    operationId: row.operation_id,
    nodeId: row.node_id,
    entityType: row.entity_type,
    entityKey: row.entity_key,
    action: row.action,
    baseVersion: Number(row.base_version),
    recordVersion: Number(row.record_version),
    occurredAt: row.occurred_at,
    payload: row.action === "delete" ? null : JSON.parse(row.payload_json || "{}"),
  }));
  const next = operations.length ? operations.at(-1).sequence : after;
  const now = isoNow();
  await env.DB.prepare(
    "INSERT INTO sync_node_cursors(node_id,last_pulled_sequence,last_pulled_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET last_pulled_sequence=CASE WHEN excluded.last_pulled_sequence>sync_node_cursors.last_pulled_sequence THEN excluded.last_pulled_sequence ELSE sync_node_cursors.last_pulled_sequence END,last_pulled_at=excluded.last_pulled_at,updated_at=excluded.updated_at",
  ).bind(device.node_id, next, now, now).run();
  const latest = await latestSequence(env);
  return json({ schemaVersion: SYNC_SCHEMA_VERSION, operations, nextSequence: next, latestSequence: latest, hasMore: next < latest });
}

async function snapshot(request, env) {
  await requireDevice(request, env, "sync:read");
  const url = new URL(request.url);
  const afterKey = url.searchParams.get("after_key") || "";
  const entityType = url.searchParams.get("entity_type") || "";
  const limit = safeLimit(url.searchParams.get("limit"), 200, 500);
  const result = entityType
    ? await env.DB.prepare("SELECT * FROM sync_entities WHERE entity_type=? AND entity_key>? ORDER BY entity_key LIMIT ?").bind(entityType, afterKey, limit).all()
    : await env.DB.prepare("SELECT * FROM sync_entities WHERE entity_key>? ORDER BY entity_key LIMIT ?").bind(afterKey, limit).all();
  const entities = (result.results || []).map((row) => ({
    entityType: row.entity_type,
    entityKey: row.entity_key,
    recordVersion: Number(row.record_version),
    tombstone: Boolean(row.tombstone),
    payload: row.tombstone ? null : JSON.parse(row.payload_json || "{}"),
    originNodeId: row.origin_node_id,
    operationId: row.last_operation_id,
    updatedAt: row.updated_at,
  }));
  return json({ schemaVersion: SYNC_SCHEMA_VERSION, entities, nextKey: entities.at(-1)?.entityKey || afterKey, hasMore: entities.length === limit });
}

async function getEntity(request, env) {
  await requireDevice(request, env, "sync:read");
  const url = new URL(request.url);
  const entityType = String(url.searchParams.get("entity_type") || "").trim();
  const entityKey = String(url.searchParams.get("entity_key") || "").trim();
  if (!entityType || !entityKey) throw Object.assign(new Error("缺少实体类型或实体键"), { status: 400 });
  const row = await env.DB.prepare("SELECT * FROM sync_entities WHERE entity_type=? AND entity_key=?").bind(entityType, entityKey).first();
  if (!row) return json({ entity: null });
  return json({ entity: {
    entityType: row.entity_type,
    entityKey: row.entity_key,
    recordVersion: Number(row.record_version),
    tombstone: Boolean(row.tombstone),
    payload: row.tombstone ? null : JSON.parse(row.payload_json || "{}"),
    originNodeId: row.origin_node_id,
    operationId: row.last_operation_id,
    updatedAt: row.updated_at,
  } });
}

async function acquireLease(request, env) {
  const device = await requireDevice(request, env, "lease");
  const body = await readBody(request);
  const leaseKey = String(body.leaseKey || "").trim().slice(0, 512);
  if (!leaseKey.startsWith("telegram:")) throw Object.assign(new Error("leaseKey 必须属于 Telegram 来源"), { status: 400 });
  const ttlSeconds = Math.max(15, Math.min(120, Number(body.ttlSeconds || 45)));
  const token = `lease_${randomHex(24)}`;
  const now = isoNow();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO sync_leases(lease_key,holder_node_id,lease_token_hash,epoch,expires_at,updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT(lease_key) DO UPDATE SET holder_node_id=excluded.holder_node_id,lease_token_hash=excluded.lease_token_hash,epoch=sync_leases.epoch+1,expires_at=excluded.expires_at,updated_at=excluded.updated_at WHERE sync_leases.expires_at<=excluded.updated_at OR sync_leases.holder_node_id=excluded.holder_node_id",
  ).bind(leaseKey, device.node_id, await sha256(token), expiresAt, now).run();
  if (!result.success || Number(result.meta?.changes || 0) < 1) {
    const holder = await env.DB.prepare("SELECT holder_node_id,expires_at,epoch FROM sync_leases WHERE lease_key=?").bind(leaseKey).first();
    return json({ acquired: false, holderNodeId: holder?.holder_node_id || "", expiresAt: holder?.expires_at || "", epoch: Number(holder?.epoch || 0) }, 409);
  }
  const row = await env.DB.prepare("SELECT epoch FROM sync_leases WHERE lease_key=?").bind(leaseKey).first();
  return json({ acquired: true, leaseKey, leaseToken: token, holderNodeId: device.node_id, expiresAt, epoch: Number(row.epoch) });
}

async function renewLease(request, env) {
  const device = await requireDevice(request, env, "lease");
  const body = await readBody(request);
  const leaseKey = String(body.leaseKey || "").trim();
  const leaseToken = String(body.leaseToken || "");
  const ttlSeconds = Math.max(15, Math.min(120, Number(body.ttlSeconds || 45)));
  const now = isoNow();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const result = await env.DB.prepare(
    "UPDATE sync_leases SET expires_at=?,updated_at=? WHERE lease_key=? AND holder_node_id=? AND lease_token_hash=? AND expires_at>?",
  ).bind(expiresAt, now, leaseKey, device.node_id, await sha256(leaseToken), now).run();
  if (Number(result.meta?.changes || 0) !== 1) throw Object.assign(new Error("执行权已经失效，请重新取得"), { status: 409 });
  return json({ renewed: true, leaseKey, expiresAt });
}

async function releaseLease(request, env) {
  const device = await requireDevice(request, env, "lease");
  const body = await readBody(request);
  const result = await env.DB.prepare("DELETE FROM sync_leases WHERE lease_key=? AND holder_node_id=? AND lease_token_hash=?")
    .bind(String(body.leaseKey || "").trim(), device.node_id, await sha256(String(body.leaseToken || ""))).run();
  return json({ released: Number(result.meta?.changes || 0) === 1 });
}

async function listDevices(request, env) {
  await requireAdmin(request, env);
  const result = await env.DB.prepare("SELECT id,node_id,label,status,created_at,updated_at,last_seen_at,revoked_at FROM sync_devices ORDER BY created_at").all();
  return json({ devices: result.results || [] });
}

async function revokeDevice(request, env, deviceId) {
  await requireAdmin(request, env);
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare("UPDATE sync_devices SET status='revoked',revoked_at=?,updated_at=? WHERE id=?").bind(now, now, deviceId),
    env.DB.prepare("DELETE FROM sync_leases WHERE holder_node_id=(SELECT node_id FROM sync_devices WHERE id=?)").bind(deviceId),
  ]);
  return json({ revoked: true });
}

async function route(request, env) {
  if (!env.DB) throw Object.assign(new Error("D1 数据库未绑定"), { status: 503 });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "GET" && path === "/health") return json({ ok: true, schemaVersion: SYNC_SCHEMA_VERSION });
  if (request.method === "POST" && path === "/v1/admin/pairings") return createPairing(request, env);
  if (request.method === "GET" && path === "/v1/admin/devices") return listDevices(request, env);
  if (request.method === "DELETE" && path.startsWith("/v1/admin/devices/")) return revokeDevice(request, env, decodeURIComponent(path.slice("/v1/admin/devices/".length)));
  if (request.method === "POST" && path === "/v1/devices/exchange") return exchangePairing(request, env);
  if (request.method === "POST" && path === "/v1/sync/push") return pushChanges(request, env);
  if (request.method === "GET" && path === "/v1/sync/pull") return pullChanges(request, env);
  if (request.method === "GET" && path === "/v1/sync/snapshot") return snapshot(request, env);
  if (request.method === "GET" && path === "/v1/sync/entity") return getEntity(request, env);
  if (request.method === "POST" && path === "/v1/leases/acquire") return acquireLease(request, env);
  if (request.method === "POST" && path === "/v1/leases/renew") return renewLease(request, env);
  if (request.method === "POST" && path === "/v1/leases/release") return releaseLease(request, env);
  return json({ error: "接口不存在" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      return json({ error: redactError(error) }, Number(error?.status || 400));
    }
  },
};
