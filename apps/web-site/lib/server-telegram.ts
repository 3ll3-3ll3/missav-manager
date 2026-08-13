import { env } from "cloudflare:workers";
import { getD1 } from "../db";
import { processDocuments } from "./rules";
import { writeLog } from "./server-audit";
import { ensureSchema, nowIso, saveRun } from "./server-store";
import { csvSafe, redact, safeJson, sha256Hex } from "./security";
import { telegramBindingAcceptsMessage, telegramBotUpdates, type TelegramImportMessage } from "./telegram";
import type { ToolId } from "./types";

const TOOLS = new Set(["twitter", "badnews", "haijiao", "missav", "av123"]);
export const TELEGRAM_TOOLS = ["twitter", "badnews", "haijiao", "missav", "av123"] as const;
export const TELEGRAM_TOOL_LABELS: Record<string, string> = {
  twitter: "推特博主",
  badnews: "Bad.news",
  haijiao: "海角帖子",
  missav: "MissAV",
  av123: "123AV",
};

type SourceIdentity = {
  id: string;
  connectionId: string;
  externalChatId: string;
};

type DeliveryBinding = {
  tool: string;
  historyMode: string;
  historyFrom: string;
  boundAtMessageId: string;
};

function telegramMessageNumber(value: unknown) {
  const text = String(value ?? "").trim();
  return /^-?\d+$/.test(text) ? BigInt(text) : null;
}

function eventKind(message: TelegramImportMessage) {
  return new Set(["message", "edited", "deleted"]).has(String(message.eventKind))
    ? String(message.eventKind) as "message" | "edited" | "deleted"
    : "message";
}

function stableId(prefix: string, value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function token() {
  return String(
    (env as unknown as Record<string, unknown>).TELEGRAM_BOT_TOKEN ?? "",
  ).trim();
}

function cleanTool(value: unknown) {
  const tool = String(value ?? "");
  if (!TOOLS.has(tool)) throw new Error("未知工具");
  return tool as ToolId;
}

async function sourceFor(
  kind: string,
  externalKey: string,
  name: string,
  metadata: Partial<TelegramImportMessage> = {},
): Promise<SourceIdentity> {
  const connectionId = String(metadata.connectionId || (kind === "telegram_bot" ? "telegram-bot" : kind === "telegram_personal" ? "telegram-personal" : "telegram-import"));
  const externalChatId = String(externalKey).slice(0, 200);
  const existing = await getD1()
    .prepare("SELECT id FROM input_sources WHERE connection_id=? AND external_chat_id=? LIMIT 1")
    .bind(connectionId, externalChatId)
    .first();
  const timestamp = nowIso();
  if (existing) {
    await getD1()
      .prepare("UPDATE input_sources SET name=?,chat_type=?,username=?,access_status='accessible',last_error='',updated_at=? WHERE id=?")
      .bind(name.slice(0, 240), String(metadata.chatType || "").slice(0, 40), String(metadata.username || "").slice(0, 160), timestamp, existing.id)
      .run();
    return { id: String(existing.id), connectionId, externalChatId };
  }
  const id = stableId("tg-source", `${connectionId}\u0000${externalChatId}`);
  await getD1()
    .prepare(
      "INSERT OR IGNORE INTO input_sources(id,kind,external_key,connection_id,external_chat_id,chat_type,username,access_status,archived,last_sync_at,latest_remote_message_id,incremental_checkpoint_id,last_error,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      kind,
      externalKey.slice(0, 200),
      connectionId,
      externalChatId,
      String(metadata.chatType || "").slice(0, 40),
      String(metadata.username || "").slice(0, 160),
      "accessible",
      0,
      "",
      "",
      "",
      "",
      name.slice(0, 240),
      "{}",
      timestamp,
      timestamp,
    )
    .run();
  return { id, connectionId, externalChatId };
}

async function ensureConnection(connectionId: string, kind: "bot" | "personal" | "import") {
  const timestamp = nowIso();
  await getD1().prepare(`INSERT OR IGNORE INTO telegram_connections
    (connection_id,kind,label,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .bind(connectionId, kind, kind === "bot" ? "Telegram Bot" : kind === "personal" ? "Telegram 个人账号" : "Telegram 官方导入", "disconnected", timestamp, timestamp)
    .run();
  if (kind === "bot") {
    await getD1().prepare("INSERT OR IGNORE INTO telegram_bot_state(connection_id,next_update_offset,last_update_id,lock_until,updated_at) VALUES (?,?,?,?,?)")
      .bind(connectionId, 0, 0, "", timestamp).run();
  }
}

async function commitMessages(
  messages: TelegramImportMessage[],
  kind: "telegram_bot" | "telegram_personal" | "telegram_import",
  nextOffset?: number,
) {
  await ensureSchema();
  const connectionKind = kind === "telegram_bot" ? "bot" : kind === "telegram_personal" ? "personal" : "import";
  const defaultConnection = kind === "telegram_bot" ? "telegram-bot" : kind === "telegram_personal" ? "telegram-personal" : "telegram-import";
  await ensureConnection(defaultConnection, connectionKind);
  const transactionId = crypto.randomUUID();
  const syncRunId = crypto.randomUUID();
  const startedAt = nowIso();
  let inserted = 0;
  let edited = 0;
  let deleted = 0;
  let duplicates = 0;
  let queues = 0;
  const grouped = new Map<string, TelegramImportMessage[]>();
  for (const message of messages) {
    const connectionId = message.connectionId || defaultConnection;
    const key = `${connectionId}\u0000${message.sourceKey}`;
    grouped.set(key, [...(grouped.get(key) ?? []), message]);
  }
  await getD1().prepare(`INSERT INTO telegram_sync_runs
    (id,connection_id,source_id,transport,mode,status,started_at,ended_at,scanned_count,inserted_count,duplicate_count,edited_count,deleted_count,queue_count,has_more,empty_candidate_count,checkpoint_before,checkpoint_after,read_result,error_message,detail_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(syncRunId, defaultConnection, "", kind === "telegram_bot" ? "bot_api" : kind === "telegram_personal" ? "mtproto_request" : "official_import", "incremental", "running", startedAt, "", messages.length, 0, 0, 0, 0, 0, 0, 0, "", "", "not_attempted", "", safeJson({ sourceCount: grouped.size }, {}))
    .run();
  try {
    const sourceRows: Array<{ source: SourceIdentity; sourceName: string; group: TelegramImportMessage[]; bindings: DeliveryBinding[] }> = [];
    for (const [key, group] of grouped) {
      const [, externalKey] = key.split("\u0000");
      const first = group[0];
      const sourceName = first?.sourceName || externalKey;
      const source = await sourceFor(kind, externalKey, sourceName, first);
      const bindingRows = await getD1().prepare(`SELECT b.tool,b.history_mode,b.history_from,b.bound_at_message_id
        FROM tool_source_bindings b JOIN input_sources s ON s.id=b.source_id
        WHERE b.source_id=? AND s.archived=0 ORDER BY b.tool`).bind(source.id).all();
      const bindings = (bindingRows.results ?? []).map((row) => ({
        tool: String(row.tool),
        historyMode: String(row.history_mode || "since_now"),
        historyFrom: String(row.history_from || ""),
        boundAtMessageId: String(row.bound_at_message_id || ""),
      })).filter((binding) => TOOLS.has(binding.tool));
      sourceRows.push({ source, sourceName, group, bindings });
    }

    for (const { source, sourceName, group, bindings } of sourceRows) {
      const timestamp = nowIso();
      await getD1().prepare("INSERT OR IGNORE INTO telegram_read_states(source_id,policy,safe_read_message_id,last_marked_read_message_id,read_baseline_message_id,updated_at) VALUES (?,?,?,?,?,?)")
        .bind(source.id, "never", "", "", "", timestamp).run();
      const ids = [...new Set(group.map((message) => String(message.messageId)).filter(Boolean))];
      const existingByMessageId = new Map<string, Record<string, unknown>>();
      for (let offset = 0; offset < ids.length; offset += 80) {
        const chunk = ids.slice(offset, offset + 80);
        const rows = await getD1().prepare(`SELECT id,message_id,body,event_kind,content_hash,remote_update_id,remote_deleted_at
          FROM telegram_messages WHERE source_id=? AND message_id IN (${chunk.map(() => "?").join(",")})`)
          .bind(source.id, ...chunk).all();
        for (const row of rows.results ?? []) existingByMessageId.set(String(row.message_id), row as Record<string, unknown>);
      }
      const existingRowIds = [...existingByMessageId.values()].map((row) => String(row.id));
      const existingQueues = new Set<string>();
      for (let offset = 0; offset < existingRowIds.length; offset += 80) {
        const chunk = existingRowIds.slice(offset, offset + 80);
        const rows = await getD1().prepare(`SELECT telegram_message_id,tool FROM telegram_tool_queue
          WHERE telegram_message_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
        for (const row of rows.results ?? []) existingQueues.add(`${String(row.telegram_message_id)}\u0000${String(row.tool)}`);
      }
      let pendingStatements: D1PreparedStatement[] = [];
      const flush = async () => {
        if (!pendingStatements.length) return;
        await getD1().batch(pendingStatements);
        pendingStatements = [];
      };
      for (const message of group) {
        const messageId = String(message.messageId).slice(0, 100);
        if (!messageId) continue;
        const lifecycle = eventKind(message);
        const body = lifecycle === "deleted" ? "" : String(message.text || "").slice(0, 100_000);
        // A deletion timestamp can be assigned locally when Telegram only returns a
        // tombstone. It is audit metadata, not part of the remote message identity.
        const hash = await sha256Hex(safeJson([lifecycle, body, message.editedAt || ""], []));
        const existing = existingByMessageId.get(messageId);
        const legacySame = existing && !String(existing.content_hash || "")
          && String(existing.body || "") === body
          && String(existing.event_kind || "message") === lifecycle
          && !String(existing.remote_deleted_at || "");
        if (existing && (String(existing.content_hash || "") === hash || legacySame)) {
          duplicates += 1;
          if (legacySame) {
            pendingStatements.push(
              getD1().prepare("UPDATE telegram_messages SET content_hash=?,remote_update_id=CASE WHEN ?='' THEN remote_update_id ELSE ? END,updated_at=? WHERE id=?")
                .bind(hash, String(message.remoteUpdateId || ""), String(message.remoteUpdateId || "").slice(0, 100), timestamp, existing.id),
              getD1().prepare("UPDATE telegram_message_fingerprints SET content_hash=?,event_kind=?,last_remote_update_id=?,updated_at=? WHERE source_id=? AND message_id=?")
                .bind(hash, lifecycle, String(message.remoteUpdateId || "").slice(0, 100), timestamp, source.id, messageId),
            );
          }
          if (pendingStatements.length >= 70) await flush();
          continue;
        }
        const messageRowId = existing ? String(existing.id) : crypto.randomUUID();
        const eligibleBindings = bindings.filter((binding) => telegramBindingAcceptsMessage(binding, message));
        const messageStatements: D1PreparedStatement[] = [];
        if (!existing) {
          messageStatements.push(
            getD1().prepare(`INSERT INTO telegram_message_fingerprints
              (id,source_id,message_id,content_hash,event_kind,last_remote_update_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
              .bind(crypto.randomUUID(), source.id, messageId, hash, lifecycle, String(message.remoteUpdateId || "").slice(0, 100), timestamp, timestamp),
            getD1().prepare(`INSERT INTO telegram_messages
              (id,source_id,message_id,connection_id,external_message_id,remote_update_id,message_date,body,event_kind,content_hash,remote_edited_at,remote_deleted_at,body_deleted_at,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .bind(messageRowId, source.id, messageId, source.connectionId, messageId, String(message.remoteUpdateId || "").slice(0, 100), String(message.messageDate || "").slice(0, 40), body, lifecycle, hash, String(message.editedAt || "").slice(0, 40), lifecycle === "deleted" ? String(message.deletedAt || timestamp).slice(0, 40) : "", lifecycle === "deleted" ? timestamp : "", timestamp, timestamp),
          );
          inserted += 1;
        } else {
          messageStatements.push(
            getD1().prepare("UPDATE telegram_message_fingerprints SET content_hash=?,event_kind=?,last_remote_update_id=?,updated_at=? WHERE source_id=? AND message_id=?")
              .bind(hash, lifecycle, String(message.remoteUpdateId || "").slice(0, 100), timestamp, source.id, messageId),
            getD1().prepare(`UPDATE telegram_messages SET remote_update_id=?,message_date=CASE WHEN ?='' THEN message_date ELSE ? END,
              body=?,event_kind=?,content_hash=?,remote_edited_at=?,remote_deleted_at=?,body_deleted_at=?,updated_at=? WHERE id=?`)
              .bind(String(message.remoteUpdateId || "").slice(0, 100), String(message.messageDate || ""), String(message.messageDate || "").slice(0, 40), body, lifecycle, hash, String(message.editedAt || "").slice(0, 40), lifecycle === "deleted" ? String(message.deletedAt || timestamp).slice(0, 40) : "", lifecycle === "deleted" ? timestamp : "", timestamp, messageRowId),
            getD1().prepare(`UPDATE telegram_tool_queue SET status=?,candidate_count=0,run_id='',error_message=?,selected_at='',processing_at='',processed_at='',updated_at=?
              WHERE telegram_message_id=?`)
              .bind(lifecycle === "deleted" ? "deleted" : "pending", lifecycle === "deleted" ? "Telegram 远端消息已删除" : "", timestamp, messageRowId),
          );
        }
        if (lifecycle === "edited" || existing && lifecycle === "message") edited += 1;
        if (lifecycle === "deleted") deleted += 1;
        for (const binding of eligibleBindings) {
          const queueKey = `${messageRowId}\u0000${binding.tool}`;
          if (existingQueues.has(queueKey)) continue;
          const queueId = crypto.randomUUID();
          messageStatements.push(
            getD1().prepare(`INSERT INTO telegram_tool_queue
              (id,telegram_message_id,tool,status,candidate_count,run_id,error_message,selected_at,processing_at,processed_at,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
              .bind(queueId, messageRowId, binding.tool, lifecycle === "deleted" ? "deleted" : "pending", 0, "", lifecycle === "deleted" ? "Telegram 远端消息已删除" : "", "", "", "", timestamp, timestamp),
          );
          if (lifecycle !== "deleted") {
            messageStatements.push(getD1().prepare(`INSERT INTO task_inbox
              (id,tool,stage,title,run_id,record_id,source_id,metadata_json,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .bind(crypto.randomUUID(), binding.tool, "new", `${sourceName} · 消息 ${messageId}`, "", queueId, source.id, safeJson({ messageId, sourceId: source.id }, {}), timestamp, timestamp));
          }
          existingQueues.add(queueKey);
          queues += 1;
        }
        if (pendingStatements.length && pendingStatements.length + messageStatements.length > 70) await flush();
        pendingStatements.push(...messageStatements);
      }
      await flush();
      const numericIds = group.map((message) => telegramMessageNumber(message.messageId)).filter((value): value is bigint => value !== null);
      const lastId = numericIds.length ? String(numericIds.reduce((max, value) => value > max ? value : max)) : String(group.at(-1)?.messageId || "");
      await getD1().prepare(`UPDATE input_sources SET last_sync_at=?,latest_remote_message_id=CASE
        WHEN ?='' THEN latest_remote_message_id WHEN CAST(latest_remote_message_id AS INTEGER)>CAST(? AS INTEGER) THEN latest_remote_message_id ELSE ? END,
        last_error='',updated_at=? WHERE id=?`).bind(timestamp, lastId, lastId, lastId, timestamp, source.id).run();
    }

    const timestamp = nowIso();
    const finalStatements = [
      getD1().prepare(`INSERT INTO sync_transactions
        (id,source_kind,status,received_count,inserted_count,duplicate_count,edited_count,deleted_count,queue_count,detail_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(transactionId, kind, "completed", messages.length, inserted, duplicates, edited, deleted, queues, safeJson({ sourceCount: grouped.size, syncRunId }, {}), timestamp, timestamp),
      getD1().prepare("UPDATE telegram_sync_runs SET status=?,ended_at=?,inserted_count=?,duplicate_count=?,edited_count=?,deleted_count=?,queue_count=?,detail_json=? WHERE id=?")
        .bind("completed", timestamp, inserted, duplicates, edited, deleted, queues, safeJson({ sourceCount: grouped.size, tools: [...new Set(sourceRows.flatMap((row) => row.bindings.map((binding) => binding.tool)))] }, {}), syncRunId),
      getD1().prepare("UPDATE telegram_connections SET status=?,network_status=?,last_success_at=?,last_error='',updated_at=? WHERE connection_id=?")
        .bind(kind === "telegram_personal" ? "session_ready" : "connected", kind === "telegram_personal" ? "verified_on_demand" : "reachable", timestamp, timestamp, defaultConnection),
    ];
    if (kind === "telegram_bot" && Number.isFinite(nextOffset)) {
      finalStatements.push(getD1().prepare("UPDATE telegram_bot_state SET next_update_offset=?,last_update_id=?,lock_until='',updated_at=? WHERE connection_id='telegram-bot'")
        .bind(Math.max(0, nextOffset || 0), Math.max(0, (nextOffset || 1) - 1), timestamp));
    }
    await getD1().batch(finalStatements);
    await writeLog("info", "telegram", "Telegram 消息已安全分发", { kind, received: messages.length, inserted, edited, deleted, duplicates, queues, transactionId });
    return { transactionId, syncRunId, received: messages.length, inserted, edited, deleted, duplicates, queues };
  } catch (error) {
    const timestamp = nowIso();
    try {
      await getD1().prepare("UPDATE telegram_sync_runs SET status='failed',ended_at=?,inserted_count=?,duplicate_count=?,edited_count=?,deleted_count=?,queue_count=?,error_message=? WHERE id=?")
        .bind(timestamp, inserted, duplicates, edited, deleted, queues, "Telegram 消息保存或分发失败", syncRunId).run();
    } catch {
      // The original failure remains authoritative.
    }
    throw error;
  }
}

export async function telegramStatus() {
  await ensureSchema();
  const [connections, sources, bindings, syncs, syncRuns, readStates, botState] = await getD1().batch([
    getD1().prepare("SELECT connection_id,kind,label,status,account_key,account_label,username,network_status,last_connected_at,last_success_at,last_error,created_at,updated_at FROM telegram_connections ORDER BY kind,connection_id"),
    getD1()
      .prepare(`SELECT s.*,COUNT(DISTINCT m.id) AS message_count,COUNT(DISTINCT CASE WHEN q.status='pending' THEN q.id END) AS pending_count
        FROM input_sources s LEFT JOIN telegram_messages m ON m.source_id=s.id
        LEFT JOIN telegram_tool_queue q ON q.telegram_message_id=m.id
      GROUP BY s.id ORDER BY s.updated_at DESC`),
    getD1().prepare(
      "SELECT source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at FROM tool_source_bindings ORDER BY source_id,tool",
    ),
    getD1().prepare(
      "SELECT * FROM sync_transactions ORDER BY created_at DESC LIMIT 10",
    ),
    getD1().prepare("SELECT * FROM telegram_sync_runs ORDER BY started_at DESC LIMIT 50"),
    getD1().prepare("SELECT * FROM telegram_read_states ORDER BY source_id"),
    getD1().prepare("SELECT next_update_offset,last_update_id,lock_until,webhook_status,last_checked_at,updated_at FROM telegram_bot_state WHERE connection_id='telegram-bot'"),
  ]);
  return {
    configured: Boolean(token()),
    connections: connections.results ?? [],
    sources: sources.results ?? [],
    bindings: bindings.results ?? [],
    syncs: syncs.results ?? [],
    syncRuns: syncRuns.results ?? [],
    readStates: readStates.results ?? [],
    botState: botState.results?.[0] ?? null,
    executionModel: "request_scoped",
  };
}

export async function resolveBoundToolSyncSources(input: {
  tool: string;
  sourceIds: string[];
}) {
  await ensureSchema();
  const tool = cleanTool(input.tool);
  const sourceIds = [
    ...new Set((input.sourceIds ?? []).map(String).filter(Boolean)),
  ].slice(0, 100);
  if (!sourceIds.length) throw new Error("请先选择本次要同步的已绑定来源");
  const rows = await getD1()
    .prepare(
      `SELECT s.id,s.name,s.connection_id,s.access_status,s.archived
       FROM input_sources s
       JOIN tool_source_bindings b ON b.source_id=s.id AND b.tool=?
       WHERE s.id IN (${sourceIds.map(() => "?").join(",")})`,
    )
    .bind(tool, ...sourceIds)
    .all();
  const bound = (rows.results ?? []) as Array<Record<string, unknown>>;
  const boundIds = new Set(bound.map((row) => String(row.id)));
  const rejected = sourceIds.filter((id) => !boundIds.has(id));
  if (rejected.length) {
    throw new Error("本次选择包含未绑定到当前工具的来源，请刷新绑定后重试");
  }
  if (bound.some((row) => Number(row.archived || 0) === 1)) {
    throw new Error("本次选择包含已停用来源，请先在全局会话库重新启用");
  }
  return {
    tool,
    sourceIds,
    personalSourceIds: bound
      .filter((row) => String(row.connection_id) === "telegram-personal")
      .map((row) => String(row.id)),
    botSourceIds: bound
      .filter((row) => String(row.connection_id) === "telegram-bot")
      .map((row) => String(row.id)),
    cachedSourceIds: bound
      .filter(
        (row) =>
          !["telegram-personal", "telegram-bot"].includes(
            String(row.connection_id),
          ),
      )
      .map((row) => String(row.id)),
  };
}

async function telegramBotApi(secret: string, method: string, query: Record<string, string> = {}) {
  const params = new URLSearchParams(query);
  const suffix = params.size ? `?${params}` : "";
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${secret}/${method}${suffix}`, { method: "GET" });
  } catch (error) {
    await writeLog("error", "telegram", "Telegram Bot 网络请求失败", { method, error: redact(error) });
    throw new Error("无法连接 Telegram Bot API；请稍后重试并检查 Site Secret。");
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload || payload.ok !== true) {
    const description = String(payload?.description || "");
    const conflict = response.status === 409 || /conflict|webhook|getupdates/i.test(description);
    if (conflict) throw new Error("Bot 存在 webhook / getUpdates 冲突；请先在原服务停止 webhook，再由全局连接中心接收更新。");
    if (response.status === 401) throw new Error("Telegram Bot Token 无效，请在 Site Secrets 更新后重试。");
    await writeLog("error", "telegram", "Telegram Bot API 返回失败", { method, status: response.status, description: redact(description) });
    throw new Error("Telegram Bot API 暂时不可用。");
  }
  return payload;
}

async function verifyTelegramBotWebhook(secret: string) {
  const payload = await telegramBotApi(secret, "getWebhookInfo");
  const result = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
  const conflict = Boolean(String(result.url || "").trim());
  const timestamp = nowIso();
  await getD1().batch([
    getD1().prepare("UPDATE telegram_bot_state SET webhook_status=?,last_checked_at=?,updated_at=? WHERE connection_id='telegram-bot'")
      .bind(conflict ? "conflict" : "clear", timestamp, timestamp),
    getD1().prepare("UPDATE telegram_connections SET status=?,network_status=?,last_error=?,updated_at=? WHERE connection_id='telegram-bot'")
      .bind(conflict ? "error" : "ready", conflict ? "conflict" : "verified_on_demand", conflict ? "Bot 当前配置了 webhook，不能同时使用 getUpdates" : "", timestamp),
  ]);
  if (conflict) throw new Error("Bot 当前仍配置 webhook；为避免重复或互斥消费，本网站不会调用 getUpdates。请先在原服务取消 webhook。");
  return { webhookStatus: "clear" as const };
}

export async function checkTelegramBotConnection() {
  await ensureSchema();
  const secret = token();
  if (!secret) throw new Error("Telegram Bot 尚未配置；请先在 Site Secrets 设置 TELEGRAM_BOT_TOKEN。");
  await ensureConnection("telegram-bot", "bot");
  const mePayload = await telegramBotApi(secret, "getMe");
  await verifyTelegramBotWebhook(secret);
  const me = mePayload.result && typeof mePayload.result === "object" ? mePayload.result as Record<string, unknown> : {};
  const label = String(me.username || me.first_name || "Telegram Bot").slice(0, 160);
  const timestamp = nowIso();
  await getD1().prepare("UPDATE telegram_connections SET label=?,status='ready',network_status='verified_on_demand',last_success_at=?,last_error='',updated_at=? WHERE connection_id='telegram-bot'")
    .bind(label.startsWith("@") || !me.username ? label : `@${label}`, timestamp, timestamp).run();
  return { configured: true, identity: me.username ? `@${String(me.username).slice(0, 120)}` : label, webhookStatus: "clear" as const };
}

export async function pullTelegramBot() {
  await ensureSchema();
  const secret = token();
  if (!secret)
    throw new Error(
      "Telegram Bot 尚未配置；请先在 Site Secrets 设置 TELEGRAM_BOT_TOKEN。",
    );
  await ensureConnection("telegram-bot", "bot");
  const lockUntil = new Date(Date.now() + 90_000).toISOString();
  const lock = await getD1().prepare("UPDATE telegram_bot_state SET lock_until=? WHERE connection_id='telegram-bot' AND (lock_until='' OR lock_until<?)")
    .bind(lockUntil, nowIso()).run();
  if (Number(lock.meta?.changes ?? 0) !== 1) throw new Error("已有一次 Bot 全局同步正在进行，请稍后查看同步记录。");
  try {
    await verifyTelegramBotWebhook(secret);
  } catch (error) {
    await getD1().prepare("UPDATE telegram_bot_state SET lock_until='',updated_at=? WHERE connection_id='telegram-bot'").bind(nowIso()).run();
    throw error;
  }
  const row = await getD1().prepare("SELECT next_update_offset AS offset FROM telegram_bot_state WHERE connection_id='telegram-bot'").first();
  const offset = Math.max(0, Number(row?.offset ?? 0) || 0);
  let payload: Record<string, unknown>;
  try {
    payload = await telegramBotApi(secret, "getUpdates", {
      offset: String(offset),
      limit: "100",
      timeout: "0",
      allowed_updates: JSON.stringify(["message", "channel_post", "edited_message", "edited_channel_post"]),
    });
  } catch (error) {
    const timestamp = nowIso();
    await getD1().batch([
      getD1().prepare("UPDATE telegram_bot_state SET lock_until='',updated_at=? WHERE connection_id='telegram-bot'").bind(timestamp),
      getD1().prepare("UPDATE telegram_connections SET status='error',last_error=?,updated_at=? WHERE connection_id='telegram-bot'").bind(error instanceof Error ? error.message.slice(0, 500) : "Telegram Bot API 暂时不可用", timestamp),
    ]);
    throw error;
  }
  const parsed = telegramBotUpdates(payload);
  try {
    return await commitMessages(parsed.messages, "telegram_bot", parsed.nextOffset || offset);
  } catch (error) {
    const timestamp = nowIso();
    await getD1().batch([
      getD1().prepare("UPDATE telegram_bot_state SET lock_until='',updated_at=? WHERE connection_id='telegram-bot'").bind(timestamp),
      getD1().prepare("UPDATE telegram_connections SET status='error',last_error=?,updated_at=? WHERE connection_id='telegram-bot'").bind("Telegram 消息保存或分发失败", timestamp),
    ]);
    throw error;
  }
}

export async function importTelegramMessages(
  messages: TelegramImportMessage[],
) {
  const safe = messages
    .slice(0, 100_000)
    .map((message) => ({
      sourceKey: String(message.sourceKey).slice(0, 200),
      sourceName: String(message.sourceName).slice(0, 240),
      messageId: String(message.messageId).slice(0, 100),
      messageDate: String(message.messageDate).slice(0, 40),
      text: String(message.text).slice(0, 100_000),
      connectionId: String(message.connectionId || "telegram-import").slice(0, 80),
      chatType: String(message.chatType || "").slice(0, 40),
      username: String(message.username || "").slice(0, 160),
      remoteUpdateId: String(message.remoteUpdateId || "").slice(0, 100),
      eventKind: eventKind(message),
      editedAt: String(message.editedAt || "").slice(0, 40),
      deletedAt: String(message.deletedAt || "").slice(0, 40),
    }))
    .filter((message) => message.sourceKey && message.messageId);
  let totals = { received: 0, inserted: 0, edited: 0, deleted: 0, duplicates: 0, queues: 0 };
  for (let offset = 0; offset < safe.length; offset += 10) {
    const result = await commitMessages(
      safe.slice(offset, offset + 10),
      "telegram_import",
    );
    totals = {
      received: totals.received + result.received,
      inserted: totals.inserted + result.inserted,
      edited: totals.edited + result.edited,
      deleted: totals.deleted + result.deleted,
      duplicates: totals.duplicates + result.duplicates,
      queues: totals.queues + result.queues,
    };
  }
  return totals;
}

export async function ingestTelegramMessages(
  messages: TelegramImportMessage[],
  transport: "telegram_personal" | "telegram_import" = "telegram_personal",
) {
  return commitMessages(messages, transport);
}

export async function bindTelegramSource(input: {
  sourceId: string;
  tool: string;
  enabled: boolean;
}) {
  await ensureSchema();
  const tool = cleanTool(input.tool);
  const sourceId = String(input.sourceId || "");
  const timestamp = nowIso();
  if (!sourceId) throw new Error("缺少 Telegram 来源");
  const snapshotId = await createTelegramSnapshot(
    `修改 ${tool} Telegram 来源绑定前自动恢复点`,
  );
  if (!input.enabled) {
    await getD1()
      .prepare("DELETE FROM tool_source_bindings WHERE source_id=? AND tool=?")
      .bind(sourceId, tool)
      .run();
    return { enabled: false, snapshotId };
  }
  await getD1()
    .prepare(
      "INSERT OR IGNORE INTO tool_source_bindings(id,source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(crypto.randomUUID(), sourceId, tool, "cached", 0, "", "", timestamp)
    .run();
  let cursor = "";
  while (true) {
    const rows = await getD1()
      .prepare(
        "SELECT id,message_id FROM telegram_messages WHERE source_id=? AND id>? ORDER BY id LIMIT 80",
      )
      .bind(sourceId, cursor)
      .all();
    const chunk = rows.results ?? [];
    if (!chunk.length) break;
    const existing = await getD1()
      .prepare(
        `SELECT telegram_message_id FROM telegram_tool_queue WHERE tool=? AND telegram_message_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(tool, ...chunk.map((row: Record<string, unknown>) => row.id))
      .all();
    const queued = new Set(
      (existing.results ?? []).map((row: Record<string, unknown>) =>
        String(row.telegram_message_id),
      ),
    );
    const missing = chunk.filter(
      (row: Record<string, unknown>) => !queued.has(String(row.id)),
    );
    if (missing.length)
      await getD1().batch(
        missing.flatMap((row: Record<string, unknown>) => {
          const queueId = crypto.randomUUID();
          return [
            getD1()
              .prepare(
                `INSERT INTO telegram_tool_queue(id,telegram_message_id,tool,status,candidate_count,run_id,error_message,selected_at,processing_at,processed_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                queueId,
                row.id,
                tool,
                "pending",
                0,
                "",
                "",
                "",
                "",
                "",
                timestamp,
                timestamp,
              ),
            getD1()
              .prepare(
                `INSERT INTO task_inbox(id,tool,stage,title,run_id,record_id,source_id,metadata_json,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                crypto.randomUUID(),
                tool,
                "new",
                `Telegram 消息 ${String(row.message_id)}`,
                "",
                queueId,
                sourceId,
                "{}",
                timestamp,
                timestamp,
              ),
          ];
        }),
      );
    cursor = String(chunk.at(-1)?.id ?? "");
    if (chunk.length < 80) break;
  }
  return { enabled: true, snapshotId };
}

const HISTORY_MODES = new Set(["since_now", "cached", "recent", "from_date"]);

export type TelegramBindingChange = {
  sourceId: string;
  tool: string;
  enabled: boolean;
  historyMode?: "since_now" | "cached" | "recent" | "from_date";
  historyLimit?: number;
  historyFrom?: string;
};

export async function saveTelegramBindings(changes: TelegramBindingChange[]) {
  await ensureSchema();
  const safeChanges = changes.slice(0, 1_000).map((change) => ({
    sourceId: String(change.sourceId || ""),
    tool: cleanTool(change.tool),
    enabled: Boolean(change.enabled),
    historyMode: String(change.historyMode || "since_now") as TelegramBindingChange["historyMode"],
    historyLimit: Math.min(20_000, Math.max(0, Math.trunc(Number(change.historyLimit) || 0))),
    historyFrom: String(change.historyFrom || "").slice(0, 40),
  }));
  if (!safeChanges.length) return { added: 0, removed: 0, unchanged: 0, queued: 0 };
  if (safeChanges.some((change) => !change.sourceId || !HISTORY_MODES.has(String(change.historyMode)))) throw new Error("Telegram 绑定参数无效");
  const sourceIds = [...new Set(safeChanges.map((change) => change.sourceId))];
  const sources = await getD1().prepare(`SELECT id,latest_remote_message_id FROM input_sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`).bind(...sourceIds).all();
  const sourceSet = new Set((sources.results ?? []).map((row) => String(row.id)));
  if (sourceSet.size !== sourceIds.length) throw new Error("绑定来源不存在，请先刷新全局会话库");
  const current = await getD1().prepare(`SELECT source_id,tool FROM tool_source_bindings WHERE (${sourceIds.map(() => "source_id=?").join(" OR ")})`).bind(...sourceIds).all();
  const currentSet = new Set((current.results ?? []).map((row) => `${row.source_id}\u0000${row.tool}`));
  const snapshotId = await createTelegramSnapshot(
    "修改 Telegram 工具绑定前自动恢复点",
  );
  let added = 0; let removed = 0; let unchanged = 0; let queued = 0;
  const statements: D1PreparedStatement[] = [];
  const timestamp = nowIso();
  for (const change of safeChanges) {
    const pair = `${change.sourceId}\u0000${change.tool}`;
    const wasBound = currentSet.has(pair);
    if (change.enabled) {
      if (wasBound) unchanged += 1; else added += 1;
      const boundAt = change.historyMode === "since_now" ? String((sources.results ?? []).find((row) => String(row.id) === change.sourceId)?.latest_remote_message_id ?? "") : "";
      statements.push(getD1().prepare(`INSERT INTO tool_source_bindings(id,source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_id,tool) DO UPDATE SET history_mode=excluded.history_mode,history_limit=excluded.history_limit,history_from=excluded.history_from,bound_at_message_id=excluded.bound_at_message_id`)
        .bind(crypto.randomUUID(), change.sourceId, change.tool, change.historyMode, change.historyLimit, change.historyFrom, boundAt, timestamp));
      if (change.historyMode !== "since_now") {
        const conditions = ["m.source_id=?"];
        const values: unknown[] = [change.sourceId];
        if (change.historyMode === "recent") { conditions.push("1=1"); }
        if (change.historyMode === "from_date" && change.historyFrom) { conditions.push("m.message_date>=?"); values.push(change.historyFrom); }
        const limit = change.historyMode === "recent" ? Math.min(change.historyLimit || 100, 20_000) : 20_000;
        statements.push(getD1().prepare(`INSERT OR IGNORE INTO telegram_tool_queue(id,telegram_message_id,tool,status,candidate_count,run_id,error_message,selected_at,processing_at,processed_at,created_at,updated_at)
          SELECT 'tgq-' || lower(hex(randomblob(16))),m.id,?,'pending',0,'','','','','',?,? FROM telegram_messages m WHERE ${conditions.join(" AND ")} ORDER BY m.message_date DESC,m.id DESC LIMIT ?`)
          .bind(change.tool, ...values, timestamp, timestamp, limit));
        queued += limit;
      }
    } else {
      if (wasBound) removed += 1; else unchanged += 1;
      statements.push(getD1().prepare("DELETE FROM tool_source_bindings WHERE source_id=? AND tool=?").bind(change.sourceId, change.tool));
    }
  }
  await getD1().batch(statements);
  await writeLog("info", "telegram", "Telegram 工具绑定已事务提交", { added, removed, unchanged, queued });
  return { added, removed, unchanged, queued, snapshotId };
}

export async function updateTelegramSource(input: { sourceId: string; archived?: boolean; accessStatus?: string; readPolicy?: string }) {
  await ensureSchema();
  const sourceId = String(input.sourceId || "");
  if (!sourceId) throw new Error("缺少 Telegram 会话");
  const policy = input.readPolicy === undefined ? "" : String(input.readPolicy);
  if (input.readPolicy !== undefined && !new Set(["safe_auto", "never", "manual"]).has(policy)) throw new Error("已读策略无效");
  const snapshotId = await createTelegramSnapshot(
    "修改 Telegram 来源设置前自动恢复点",
  );
  const timestamp = nowIso();
  const statements = [
    getD1().prepare("UPDATE input_sources SET archived=COALESCE(?,archived),access_status=COALESCE(?,access_status),updated_at=? WHERE id=?")
      .bind(input.archived === undefined ? null : (input.archived ? 1 : 0), input.accessStatus ? String(input.accessStatus).slice(0, 40) : null, timestamp, sourceId),
  ];
  if (input.readPolicy !== undefined) {
    statements.push(getD1().prepare("INSERT INTO telegram_read_states(source_id,policy,safe_read_message_id,last_marked_read_message_id,read_baseline_message_id,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at")
      .bind(sourceId, policy, "", "", "", timestamp));
  }
  await getD1().batch(statements);
  return { sourceId, archived: input.archived === undefined ? undefined : Boolean(input.archived), readPolicy: input.readPolicy === undefined ? undefined : policy, snapshotId };
}

export async function deleteTelegramBotConnection() {
  await ensureSchema();
  const snapshotId = await createTelegramSnapshot(
    "删除 Telegram Bot 连接前自动恢复点",
  );
  const timestamp = nowIso();
  await getD1().batch([
    getD1().prepare("UPDATE input_sources SET access_status='unavailable',last_error='Bot 全局连接已删除',updated_at=? WHERE connection_id='telegram-bot'").bind(timestamp),
    getD1().prepare("DELETE FROM telegram_bot_state WHERE connection_id='telegram-bot'"),
    getD1().prepare("DELETE FROM telegram_connections WHERE connection_id='telegram-bot'"),
  ]);
  await writeLog("info", "telegram", "Telegram Bot 全局连接记录已删除，来源历史保留", {});
  return { connectionId: "telegram-bot", deleted: true, historyPreserved: true, snapshotId };
}

export async function telegramMigrationPreview() {
  await ensureSchema();
  const [sources, bindings, messages, queues, accounts, offsets] = await getD1().batch([
    getD1().prepare("SELECT COUNT(*) AS count FROM input_sources WHERE connection_id='' OR connection_id LIKE 'legacy-%'"),
    getD1().prepare("SELECT COUNT(*) AS count FROM tool_source_bindings"),
    getD1().prepare("SELECT COUNT(*) AS count FROM telegram_messages"),
    getD1().prepare("SELECT COUNT(*) AS count FROM telegram_tool_queue"),
    getD1().prepare("SELECT COUNT(*) AS count FROM telegram_accounts"),
    getD1().prepare("SELECT COUNT(*) AS count FROM app_settings WHERE key='telegramBotOffset'"),
  ]);
  const counts = Object.fromEntries(["legacySources", "bindings", "messages", "queues", "legacyAccounts", "legacyBotOffsets"].map((key, index) => [key, Number([sources, bindings, messages, queues, accounts, offsets][index].results?.[0]?.count ?? 0)]));
  const warnings = [
    counts.legacySources ? "仍存在旧来源身份字段，将按 connection_id + external_chat_id 归一化" : "没有发现需要改写身份的旧来源",
    counts.legacyBotOffsets ? "发现旧版 Bot offset，应用迁移前会复制到全局 Bot 游标" : "没有发现分散 Bot offset",
    "不会删除消息正文、历史结果、工具绑定或队列状态",
  ];
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  await getD1().prepare("INSERT INTO telegram_migration_runs(id,status,snapshot_id,counts_json,warnings_json,created_at,applied_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, "preview", "", safeJson(counts, {}), safeJson(warnings, []), timestamp, "").run();
  return { migrationId: id, counts, warnings };
}

export async function createTelegramSnapshot(reason: string) {
  const snapshotId = crypto.randomUUID();
  const timestamp = nowIso();
  const tables = ["telegram_connections", "telegram_bot_state", "input_sources", "tool_source_bindings", "telegram_messages", "telegram_message_fingerprints", "telegram_tool_queue", "telegram_read_states", "telegram_sync_runs", "telegram_accounts", "telegram_auth_flows"];
  const items: Array<{ key: string; value: string }> = [];
  for (const table of tables) {
    const rows = await getD1().prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows.results ?? []) items.push({ key: `${table}:${String((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).connection_id ?? (row as Record<string, unknown>).source_id ?? crypto.randomUUID())}`, value: safeJson(row, {}) });
  }
  await getD1().prepare("INSERT INTO data_snapshots(id,reason,entity,item_count,status,created_at,restored_at) VALUES (?,?,?,?,?,?,?)").bind(snapshotId, reason, "telegram_migration", items.length, "writing", timestamp, "").run();
  try {
    for (let offset = 0; offset < items.length; offset += 50) {
      const chunk = items.slice(offset, offset + 50);
      await getD1().batch(chunk.map((item) => getD1().prepare("INSERT INTO data_snapshot_items(snapshot_id,entity_key,previous_json) VALUES (?,?,?)").bind(snapshotId, item.key, item.value)));
    }
    await getD1().prepare("UPDATE data_snapshots SET status='ready' WHERE id=?").bind(snapshotId).run();
  } catch (error) {
    await getD1().prepare("UPDATE data_snapshots SET status='error' WHERE id=?").bind(snapshotId).run();
    throw error;
  }
  return snapshotId;
}

async function createTelegramQueueSnapshot(ids: string[], reason: string) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  const snapshotId = crypto.randomUUID();
  const timestamp = nowIso();
  const queueRows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `SELECT * FROM telegram_tool_queue WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all();
    queueRows.push(...((result.results ?? []) as Array<Record<string, unknown>>));
  }
  const messageIds = [
    ...new Set(queueRows.map((row) => String(row.telegram_message_id))),
  ];
  const messageRows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < messageIds.length; offset += 80) {
    const chunk = messageIds.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `SELECT * FROM telegram_messages WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all();
    messageRows.push(...((result.results ?? []) as Array<Record<string, unknown>>));
  }
  const items = [
    ...messageRows.map((row) => ({
      key: `telegram_messages:${String(row.id)}`,
      row,
    })),
    ...queueRows.map((row) => ({
      key: `telegram_tool_queue:${String(row.id)}`,
      row,
    })),
  ];
  await getD1()
    .prepare(
      "INSERT INTO data_snapshots(id,reason,entity,item_count,status,created_at,restored_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      snapshotId,
      reason.slice(0, 240),
      "telegram_queue",
      items.length,
      "ready",
      timestamp,
      "",
    )
    .run();
  for (let offset = 0; offset < items.length; offset += 50) {
    await getD1().batch(
      items.slice(offset, offset + 50).map((item) =>
        getD1()
          .prepare(
            "INSERT INTO data_snapshot_items(snapshot_id,entity_key,previous_json) VALUES (?,?,?)",
          )
          .bind(snapshotId, item.key, safeJson(item.row, {})),
      ),
    );
  }
  return snapshotId;
}

export async function applyTelegramMigration(input: { migrationId: string; confirm?: boolean }) {
  if (!input.confirm) throw new Error("迁移是高影响操作，请先在预览后明确确认");
  await ensureSchema();
  const migrationId = String(input.migrationId || "");
  const snapshotId = await createTelegramSnapshot("Telegram 三层架构迁移前快照");
  const timestamp = nowIso();
  await getD1().batch([
    getD1().prepare("UPDATE input_sources SET connection_id=CASE WHEN connection_id='' THEN CASE WHEN kind='telegram_bot' THEN 'telegram-bot' WHEN kind='telegram_personal' THEN 'telegram-personal' ELSE 'legacy-' || kind END ELSE connection_id END,external_chat_id=CASE WHEN external_chat_id='' THEN external_key ELSE external_chat_id END,updated_at=?").bind(timestamp),
    getD1().prepare("UPDATE telegram_messages SET connection_id=COALESCE(NULLIF(connection_id,''),(SELECT connection_id FROM input_sources WHERE input_sources.id=telegram_messages.source_id)),external_message_id=COALESCE(NULLIF(external_message_id,''),message_id),updated_at=?").bind(timestamp),
    getD1().prepare("INSERT OR IGNORE INTO telegram_read_states(source_id,policy,safe_read_message_id,last_marked_read_message_id,read_baseline_message_id,updated_at) SELECT id,'never','','','',? FROM input_sources").bind(timestamp),
    getD1().prepare("INSERT OR IGNORE INTO telegram_connections(connection_id,kind,label,status,created_at,updated_at) VALUES ('telegram-bot','bot','Telegram Bot','disconnected',?,?)").bind(timestamp, timestamp),
    getD1().prepare("UPDATE telegram_migration_runs SET status='applied',snapshot_id=?,applied_at=? WHERE id=?").bind(snapshotId, timestamp, migrationId),
  ]);
  return { migrationId, snapshotId, status: "applied" };
}

type QueueFilters = {
  tool: string;
  status?: string;
  search?: string;
  start?: string;
  end?: string;
  sourceIds?: string[];
  includeCleaned?: boolean;
  includeNoise?: boolean;
};

type TelegramQueueRow = Record<string, unknown>;

function candidateHintClause(tool: ToolId) {
  if (tool === "badnews") return "LOWER(m.body) LIKE '%bad.news/t/%'";
  if (tool === "haijiao") {
    return `(${["hjjd", "hjmz", "hjyc", "hjfn", "hjsz", "hjrq", "hjhj"]
      .map((category) => `LOWER(m.body) LIKE '%haijiaolove.xyz/${category}/%'`)
      .join(" OR ")})`;
  }
  if (tool === "twitter") {
    return "(m.body LIKE '%#%' OR m.body LIKE '%@%' OR LOWER(m.body) LIKE '%x.com/%' OR LOWER(m.body) LIKE '%twitter.com/%')";
  }
  return "(UPPER(m.body) GLOB '*[A-Z][A-Z]*[0-9]*' OR LOWER(m.body) LIKE '%missav.%' OR LOWER(m.body) LIKE '%123av.com/%')";
}

function telegramQueueCandidates(tool: ToolId, row: TelegramQueueRow) {
  const body = String(row.body ?? "").trim();
  if (!body) return [];
  return processDocuments(tool, [{
    name: `${String(row.source_name || "Telegram")}#${String(row.message_id || "")}`,
    text: body,
  }]).results;
}

function telegramQueueRowHasCandidate(tool: ToolId, row: TelegramQueueRow) {
  return telegramQueueCandidates(tool, row).length > 0;
}

function withTelegramCandidates(tool: ToolId, row: TelegramQueueRow, resolved?: ReturnType<typeof telegramQueueCandidates>) {
  const candidates = resolved ?? telegramQueueCandidates(tool, row);
  return {
    ...row,
    candidate_count: candidates.length,
    candidate_preview: candidates.slice(0, 5).map((item) =>
      item.secondaryValue
        ? `${item.primaryValue} → ${item.secondaryValue}`
        : item.primaryValue,
    ).join("；"),
  };
}

function telegramQueueRowIsVisible(
  tool: ToolId,
  row: TelegramQueueRow,
  options: { includeCleaned?: boolean; includeNoise?: boolean },
) {
  const body = String(row.body ?? "");
  if (!options.includeCleaned && (String(row.body_deleted_at ?? "") || !body.trim())) return false;
  return options.includeNoise || telegramQueueRowHasCandidate(tool, row);
}

function queueFilter(input: QueueFilters) {
  const tool = cleanTool(input.tool);
  const clauses = ["q.tool=?"];
  const values: unknown[] = [tool];
  const sourceIds = [...new Set((input.sourceIds ?? []).map(String).filter(Boolean))].slice(0, 100);
  if (sourceIds.length) {
    clauses.push(`m.source_id IN (${sourceIds.map(() => "?").join(",")})`);
    values.push(...sourceIds);
  }
  if (input.status) {
    clauses.push("q.status=?");
    values.push(String(input.status).slice(0, 32));
  }
  if (input.search?.trim()) {
    clauses.push("(m.body LIKE ? OR s.name LIKE ? OR m.message_id LIKE ?)");
    const like = `%${input.search.trim().slice(0, 160)}%`;
    values.push(like, like, like);
  }
  if (input.start) {
    clauses.push("m.message_date>=?");
    values.push(String(input.start).slice(0, 40));
  }
  if (input.end) {
    clauses.push("m.message_date<=?");
    values.push(String(input.end).slice(0, 40));
  }
  if (!input.includeCleaned) {
    clauses.push("COALESCE(m.body_deleted_at,'')='' AND LENGTH(TRIM(COALESCE(m.body,'')))>0");
  }
  if (!input.includeNoise) {
    clauses.push(candidateHintClause(tool));
  }
  return {
    tool,
    where: ` WHERE ${clauses.join(" AND ")}`,
    values,
    from: " FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id JOIN input_sources s ON s.id=m.source_id JOIN tool_source_bindings b ON b.source_id=m.source_id AND b.tool=q.tool",
  };
}

export async function listTelegramQueue(input: {
  tool: string;
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  start?: string;
  end?: string;
  sourceIds?: string[];
  includeCleaned?: boolean;
  includeNoise?: boolean;
  sort?: string;
  direction?: "asc" | "desc";
}) {
  await ensureSchema();
  const page = Math.max(1, Math.trunc(Number(input.page) || 1));
  const pageSize = Math.min(
    200,
    Math.max(20, Math.trunc(Number(input.pageSize) || 50)),
  );
  const { tool, where, from, values } = queueFilter(input);
  const sortFields: Record<string, string> = {
    messageDate: "m.message_date",
    source: "s.name",
    status: "q.status",
    messageId: "m.message_id",
  };
  const sort = sortFields[String(input.sort || "messageDate")] || "m.message_date";
  const direction = input.direction === "asc" ? "ASC" : "DESC";
  const select = `SELECT q.*,m.message_id,m.message_date,m.body,m.event_kind,m.remote_edited_at,m.remote_deleted_at,m.body_deleted_at,s.id AS source_id,s.name AS source_name${from}${where}`;
  if (input.includeNoise) {
    const [count, rows] = await getD1().batch([
      getD1().prepare(`SELECT COUNT(*) AS count${from}${where}`).bind(...values),
      getD1().prepare(`${select} ORDER BY ${sort} ${direction},m.id ${direction} LIMIT ? OFFSET ?`)
        .bind(...values, pageSize, (page - 1) * pageSize),
    ]);
    return {
      rows: (rows.results ?? []).map((row) => withTelegramCandidates(tool, row as TelegramQueueRow)),
      total: Number(count.results?.[0]?.count ?? 0),
      hiddenNoiseCount: 0,
      page,
      pageSize,
    };
  }

  const rows: TelegramQueueRow[] = [];
  const pageStart = (page - 1) * pageSize;
  let total = 0;
  let hinted = 0;
  let offset = 0;
  const scanSize = 500;
  while (true) {
    const result = await getD1()
      .prepare(`${select} ORDER BY ${sort} ${direction},m.id ${direction} LIMIT ? OFFSET ?`)
      .bind(...values, scanSize, offset)
      .all();
    const chunk = (result.results ?? []) as TelegramQueueRow[];
    for (const row of chunk) {
      hinted += 1;
      const body = String(row.body ?? "");
      if (!input.includeCleaned && (String(row.body_deleted_at ?? "") || !body.trim())) continue;
      const candidates = telegramQueueCandidates(tool, row);
      if (!candidates.length) continue;
      if (total >= pageStart && rows.length < pageSize) rows.push(withTelegramCandidates(tool, row, candidates));
      total += 1;
    }
    if (chunk.length < scanSize) break;
    offset += chunk.length;
  }
  return {
    rows,
    total,
    hiddenNoiseCount: Math.max(0, hinted - total),
    page,
    pageSize,
  };
}

export async function resolveTelegramQueueSelection(input: {
  tool: string;
  mode?: "ids" | "all";
  queueIds?: string[];
  excludeIds?: string[];
  status?: string;
  search?: string;
  start?: string;
  end?: string;
  sourceIds?: string[];
  includeCleaned?: boolean;
  includeNoise?: boolean;
}) {
  if (input.mode !== "all") {
    const requested = [
      ...new Set((input.queueIds ?? []).map(String).filter(Boolean)),
    ];
    const tool = cleanTool(input.tool);
    const allowed = new Set<string>();
    for (let offset = 0; offset < requested.length; offset += 80) {
      const chunk = requested.slice(offset, offset + 80);
      const rows = await getD1()
        .prepare(
          `SELECT q.id,m.message_id,m.body,m.body_deleted_at,s.name AS source_name FROM telegram_tool_queue q
           JOIN telegram_messages m ON m.id=q.telegram_message_id
           JOIN tool_source_bindings b ON b.source_id=m.source_id AND b.tool=q.tool
           JOIN input_sources s ON s.id=m.source_id
           WHERE q.tool=? AND q.id IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(tool, ...chunk)
        .all();
      for (const row of rows.results ?? []) {
        if (telegramQueueRowIsVisible(tool, row as TelegramQueueRow, input)) allowed.add(String(row.id));
      }
    }
    if (allowed.size !== requested.length)
      throw new Error("所选消息已被清理、没有当前工具可用结果，或绑定已变化，请刷新后重试");
    return requested;
  }
  const query = queueFilter(input);
  const excluded = new Set((input.excludeIds ?? []).map(String));
  const ids: string[] = [];
  let cursor = "";
  while (true) {
    const cursorSql = `${query.where} AND q.id>?`;
    const rows = await getD1()
      .prepare(`SELECT q.id,m.message_id,m.body,m.body_deleted_at,s.name AS source_name${query.from}${cursorSql} ORDER BY q.id LIMIT 5000`)
      .bind(...query.values, cursor)
      .all();
    const resultRows = (rows.results ?? []) as TelegramQueueRow[];
    const chunk = resultRows.map((row) => String(row.id));
    ids.push(...resultRows
      .filter((row) => telegramQueueRowIsVisible(query.tool, row, input))
      .map((row) => String(row.id))
      .filter((id) => !excluded.has(id)));
    if (chunk.length < 5000) break;
    cursor = chunk.at(-1) || "";
  }
  if (ids.length > 10_000)
    throw new Error(
      "当前 Telegram 操作范围超过 10,000 条，请先增加状态、关键词或时间筛选。 ",
    );
  return ids;
}

export async function processTelegramQueue(input: {
  tool: string;
  queueIds: string[];
  deleteBody?: boolean;
  onProgress?: (progress: {
    phase: "preparing" | "processing" | "saving" | "updating" | "cleaning" | "completed";
    label: string;
    current: number;
    total: number;
    resultCount: number;
  }) => void;
}) {
  await ensureSchema();
  const tool = cleanTool(input.tool);
  const ids = [...new Set((input.queueIds ?? []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error("请先选择 Telegram 消息");
  if (ids.length > 10_000)
    throw new Error("单次 Telegram 处理最多 10,000 条，请缩小筛选范围。 ");
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `SELECT q.id,q.telegram_message_id,q.status,m.body,m.remote_deleted_at,m.message_id,m.message_date,s.name AS source_name
      FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id JOIN input_sources s ON s.id=m.source_id JOIN tool_source_bindings b ON b.source_id=m.source_id AND b.tool=q.tool
      WHERE q.tool=? AND q.id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(tool, ...chunk)
      .all();
    rows.push(...((result.results ?? []) as Array<Record<string, unknown>>));
  }
  if (rows.length !== ids.length)
    throw new Error("所选 Telegram 消息不属于当前工具或绑定已变化，请刷新后重试");
  if (rows.some((row) => String(row.status) === "deleted" || String(row.remote_deleted_at || ""))) {
    throw new Error("所选范围包含 Telegram 远端已删除消息；请取消选择后再处理。");
  }
  const emitProgress = (
    phase: "preparing" | "processing" | "saving" | "updating" | "cleaning" | "completed",
    label: string,
    current: number,
    resultCount: number,
  ) => input.onProgress?.({ phase, label, current, total: rows.length, resultCount });
  emitProgress("preparing", "正在建立操作前恢复点", 0, 0);
  const snapshotId = await createTelegramQueueSnapshot(
    rows.map((row) => String(row.id)),
    `处理 ${tool} Telegram 队列前自动恢复点`,
  );
  const allResults = [];
  const counts = new Map<string, number>();
  const progressStep = Math.max(1, Math.ceil(rows.length / 100));
  emitProgress("processing", "正在按当前工具规则处理消息", 0, 0);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const output = processDocuments(tool, [
      {
        name: `${String(row.source_name)}#${String(row.message_id)}`,
        text: String(row.body ?? ""),
      },
    ]);
    counts.set(String(row.id), output.results.length);
    allResults.push(...output.results);
    if ((index + 1) % progressStep === 0 || index === rows.length - 1) {
      emitProgress("processing", "正在按当前工具规则处理消息", index + 1, allResults.length);
    }
  }
  const uniqueResults = [...new Map(
    allResults.map((item) => [String(item.resultKey).toLowerCase(), item]),
  ).values()];
  let runId = "";
  let resultCount = uniqueResults.length;
  emitProgress("saving", uniqueResults.length ? "正在保存结果与处理历史" : "正在记录空结果状态", rows.length, resultCount);
  if (uniqueResults.length) {
    const saved = await saveRun({
      tool,
      name: `Telegram · ${new Date().toLocaleString("zh-CN")}`,
      inputKind: "telegram_queue",
      sourceSummary: `${rows.length} 条所选消息`,
      results: uniqueResults,
    });
    runId = saved.runId;
    resultCount = saved.resultCount;
  }
  const timestamp = nowIso();
  emitProgress("updating", "正在更新消息处理状态", rows.length, resultCount);
  await getD1().batch(
    rows.map((row) => {
      const count = counts.get(String(row.id)) ?? 0;
      return getD1()
        .prepare(
          "UPDATE telegram_tool_queue SET status=?,candidate_count=?,run_id=?,processed_at=?,updated_at=? WHERE id=?",
        )
        .bind(
          count ? "processed" : "processed_empty",
          count,
          runId,
          timestamp,
          timestamp,
          row.id,
        );
    }),
  );
  if (input.deleteBody !== false) {
    emitProgress("cleaning", "正在执行原始正文清理策略", rows.length, resultCount);
    for (const messageId of new Set(
      rows.map((row) => String(row.telegram_message_id)),
    )) {
      const pending = await getD1()
        .prepare(
          "SELECT COUNT(*) AS count FROM telegram_tool_queue WHERE telegram_message_id=? AND status IN ('pending','error')",
        )
        .bind(messageId)
        .first();
      if (Number(pending?.count ?? 0) === 0)
        await getD1()
          .prepare(
            "UPDATE telegram_messages SET body='',body_deleted_at=?,updated_at=? WHERE id=?",
          )
          .bind(timestamp, timestamp, messageId)
          .run();
    }
  }
  await writeLog("info", "telegram", "已处理所选 Telegram 消息", {
    tool,
    selected: rows.length,
    resultCount,
    runId,
  });
  emitProgress("completed", "处理完成，结果已送入结果面板", rows.length, resultCount);
  return { selected: rows.length, resultCount, runId, snapshotId, results: uniqueResults };
}

export async function updateTelegramQueue(
  ids: string[],
  status: "pending" | "ignored",
) {
  if (!new Set(["pending", "ignored"]).has(status))
    throw new Error("消息状态无效");
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (unique.length > 10_000)
    throw new Error("单次 Telegram 状态修改最多 10,000 条，请缩小筛选范围。 ");
  const snapshotId = unique.length
    ? await createTelegramQueueSnapshot(
        unique,
        `${status === "ignored" ? "忽略" : "恢复"} Telegram 队列前自动恢复点`,
      )
    : "";
  let changed = 0;
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `UPDATE telegram_tool_queue SET status=?,updated_at=? WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(status, nowIso(), ...chunk)
      .run();
    changed += Number(result.meta?.changes ?? 0);
  }
  return { changed, snapshotId };
}

export async function exportTelegramQueue(
  ids: string[],
  format: "txt" | "csv",
) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (unique.length > 10_000)
    throw new Error("单次 Telegram 原文导出最多 10,000 条，请缩小筛选范围。 ");
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `SELECT q.id,q.status,m.message_id,m.message_date,m.body,s.name AS source_name FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id JOIN input_sources s ON s.id=m.source_id JOIN tool_source_bindings b ON b.source_id=m.source_id AND b.tool=q.tool WHERE q.id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all();
    rows.push(...((result.results ?? []) as Array<Record<string, unknown>>));
  }
  const order = new Map(unique.map((id, index) => [id, index]));
  rows.sort(
    (a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0),
  );
  if (format === "txt")
    return rows.map((row) => String(row.body ?? "")).join("\r\n\r\n");
  return `\uFEFF${[["message_id", "date", "source", "status", "body"].map(csvSafe).join(","), ...rows.map((row) => [row.message_id, row.message_date, row.source_name, row.status, row.body].map(csvSafe).join(","))].join("\r\n")}`;
}
