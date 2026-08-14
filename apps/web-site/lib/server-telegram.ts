import { env } from "cloudflare:workers";
import { getD1 } from "../db";
import { candidateSummary, processMessages, type InputMessage } from "./rules";
import { writeLog } from "./server-audit";
import { ensureSchema, nowIso, saveRun } from "./server-store";
import { csvSafe, redact, safeJson, sha256Hex } from "./security";
import {
  groupTelegramImportMessages,
  telegramBindingAcceptsMessage,
  telegramBotUpdates,
  telegramCandidateHint,
  type TelegramImportMessage,
} from "./telegram";
import type { ToolId } from "./types";

const TOOLS = new Set(["twitter", "badnews", "haijiao", "missav", "av123"]);
export const TELEGRAM_TOOLS = [
  "twitter",
  "badnews",
  "haijiao",
  "missav",
  "av123",
] as const;
export const TELEGRAM_TOOL_LABELS: Record<string, string> = {
  twitter: "推特博主",
  badnews: "Bad.news",
  haijiao: "海角帖子",
  missav: "MissAV",
  av123: "123AV",
};

const BOT_WEBHOOK_CACHE_MS = 5 * 60_000;
const botWebhookCache = new Map<string, number>();
const TELEGRAM_PROCESSED_EMPTY_STATUS = "processed_empty";

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
  return new Set(["message", "edited", "deleted"]).has(
    String(message.eventKind),
  )
    ? (String(message.eventKind) as "message" | "edited" | "deleted")
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

async function ensureConnection(
  connectionId: string,
  kind: "bot" | "personal" | "import",
) {
  const timestamp = nowIso();
  await getD1()
    .prepare(
      `INSERT OR IGNORE INTO telegram_connections
    (connection_id,kind,label,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    )
    .bind(
      connectionId,
      kind,
      kind === "bot"
        ? "Telegram Bot"
        : kind === "personal"
          ? "Telegram 个人账号"
          : "Telegram 官方导入",
      "disconnected",
      timestamp,
      timestamp,
    )
    .run();
  if (kind === "bot") {
    await getD1()
      .prepare(
        "INSERT OR IGNORE INTO telegram_bot_state(connection_id,next_update_offset,last_update_id,lock_until,updated_at) VALUES (?,?,?,?,?)",
      )
      .bind(connectionId, 0, 0, "", timestamp)
      .run();
  }
}

async function prepareSourceRows(
  grouped: Map<string, TelegramImportMessage[]>,
  kind: "telegram_bot" | "telegram_personal" | "telegram_import",
) {
  const timestamp = nowIso();
  const descriptors = [...grouped.entries()].map(([key, group]) => {
    const separator = key.indexOf("\u0000");
    const connectionId = key.slice(0, separator);
    const externalChatId = key.slice(separator + 1).slice(0, 200);
    const first = group[0];
    return {
      connectionId,
      externalChatId,
      externalKey: String(first?.sourceKey || externalChatId).slice(0, 200),
      sourceName: String(first?.sourceName || externalChatId).slice(0, 240),
      chatType: String(first?.chatType || "").slice(0, 40),
      username: String(first?.username || "").slice(0, 160),
      group,
    };
  });
  for (let offset = 0; offset < descriptors.length; offset += 80) {
    const chunk = descriptors.slice(offset, offset + 80);
    await getD1().batch(
      chunk.map((item) =>
        getD1()
          .prepare(
            `INSERT INTO input_sources
      (id,kind,external_key,connection_id,external_chat_id,chat_type,username,access_status,archived,last_sync_at,latest_remote_message_id,incremental_checkpoint_id,sync_cursor_message_id,sync_target_message_id,last_error,name,metadata_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(connection_id,external_chat_id) DO UPDATE SET name=excluded.name,chat_type=excluded.chat_type,username=excluded.username,access_status='accessible',last_error='',updated_at=excluded.updated_at`,
          )
          .bind(
            stableId(
              "tg-source",
              `${item.connectionId}\u0000${item.externalChatId}`,
            ),
            kind,
            item.externalKey,
            item.connectionId,
            item.externalChatId,
            item.chatType,
            item.username,
            "accessible",
            0,
            "",
            "",
            "",
            "",
            "",
            "",
            item.sourceName,
            "{}",
            timestamp,
            timestamp,
          ),
      ),
    );
  }
  const sourceResults: Array<Record<string, unknown>> = [];
  const lookupStatements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < descriptors.length; offset += 40) {
    const chunk = descriptors.slice(offset, offset + 40);
    lookupStatements.push(
      getD1()
        .prepare(
          `SELECT id,connection_id,external_chat_id,archived FROM input_sources WHERE ${chunk.map(() => "(connection_id=? AND external_chat_id=?)").join(" OR ")}`,
        )
        .bind(
          ...chunk.flatMap((item) => [item.connectionId, item.externalChatId]),
        ),
    );
  }
  if (lookupStatements.length) {
    const lookup = await getD1().batch(lookupStatements);
    for (const result of lookup)
      sourceResults.push(
        ...((result.results ?? []) as Array<Record<string, unknown>>),
      );
  }
  const sourceByIdentity = new Map(
    sourceResults.map((row) => [
      `${row.connection_id}\u0000${row.external_chat_id}`,
      row,
    ]),
  );
  const sourceIds = sourceResults.map((row) => String(row.id));
  const bindingResults: Array<Record<string, unknown>> = [];
  const bindingStatements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < sourceIds.length; offset += 80) {
    const chunk = sourceIds.slice(offset, offset + 80);
    bindingStatements.push(
      getD1()
        .prepare(
          `SELECT source_id,tool,history_mode,history_from,bound_at_message_id FROM tool_source_bindings WHERE source_id IN (${chunk.map(() => "?").join(",")}) ORDER BY source_id,tool`,
        )
        .bind(...chunk),
    );
  }
  if (bindingStatements.length) {
    const bindingBatches = await getD1().batch(bindingStatements);
    for (const result of bindingBatches)
      bindingResults.push(
        ...((result.results ?? []) as Array<Record<string, unknown>>),
      );
  }
  const bindingsBySource = new Map<string, DeliveryBinding[]>();
  for (const row of bindingResults) {
    const sourceId = String(row.source_id);
    const bucket = bindingsBySource.get(sourceId) || [];
    if (TOOLS.has(String(row.tool)))
      bucket.push({
        tool: String(row.tool),
        historyMode: String(row.history_mode || "since_now"),
        historyFrom: String(row.history_from || ""),
        boundAtMessageId: String(row.bound_at_message_id || ""),
      });
    bindingsBySource.set(sourceId, bucket);
  }
  if (sourceIds.length) {
    for (let offset = 0; offset < sourceIds.length; offset += 80) {
      const chunk = sourceIds.slice(offset, offset + 80);
      await getD1().batch(
        chunk.map((sourceId) =>
          getD1()
            .prepare(
              "INSERT OR IGNORE INTO telegram_read_states(source_id,policy,safe_read_message_id,last_marked_read_message_id,read_baseline_message_id,updated_at) VALUES (?,?,?,?,?,?)",
            )
            .bind(sourceId, "never", "", "", "", timestamp),
        ),
      );
    }
  }
  return descriptors.map((descriptor) => {
    const row = sourceByIdentity.get(
      `${descriptor.connectionId}\u0000${descriptor.externalChatId}`,
    );
    if (!row) throw new Error("Telegram 来源批量写入后无法读取");
    const source: SourceIdentity = {
      id: String(row.id),
      connectionId: descriptor.connectionId,
      externalChatId: descriptor.externalChatId,
    };
    return {
      source,
      sourceName: descriptor.sourceName,
      group: descriptor.group,
      bindings: Number(row.archived || 0)
        ? []
        : bindingsBySource.get(source.id) || [],
    };
  });
}

async function prefetchExistingTelegramState(
  sourceRows: Array<{ source: SourceIdentity; group: TelegramImportMessage[] }>,
) {
  const pairs = sourceRows.flatMap(({ source, group }) =>
    [
      ...new Set(
        group.map((message) => String(message.messageId)).filter(Boolean),
      ),
    ].map((messageId) => ({ sourceId: source.id, messageId })),
  );
  const messageStatements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < pairs.length; offset += 40) {
    const chunk = pairs.slice(offset, offset + 40);
    messageStatements.push(
      getD1()
        .prepare(
          `SELECT id,source_id,message_id,body,event_kind,content_hash,remote_update_id,remote_deleted_at FROM telegram_messages WHERE ${chunk.map(() => "(source_id=? AND message_id=?)").join(" OR ")}`,
        )
        .bind(...chunk.flatMap((item) => [item.sourceId, item.messageId])),
    );
  }
  const existingMessages = new Map<string, Record<string, unknown>>();
  if (messageStatements.length) {
    const batches = await getD1().batch(messageStatements);
    for (const batch of batches)
      for (const row of batch.results ?? [])
        existingMessages.set(
          `${String(row.source_id)}\u0000${String(row.message_id)}`,
          row as Record<string, unknown>,
        );
  }
  const messageRowIds = [...existingMessages.values()].map((row) =>
    String(row.id),
  );
  const queueStatements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < messageRowIds.length; offset += 80) {
    const chunk = messageRowIds.slice(offset, offset + 80);
    queueStatements.push(
      getD1()
        .prepare(
          `SELECT telegram_message_id,tool FROM telegram_tool_queue WHERE telegram_message_id IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(...chunk),
    );
  }
  const existingQueues = new Set<string>();
  if (queueStatements.length) {
    const batches = await getD1().batch(queueStatements);
    for (const batch of batches)
      for (const row of batch.results ?? [])
        existingQueues.add(
          `${String(row.telegram_message_id)}\u0000${String(row.tool)}`,
        );
  }
  return { existingMessages, existingQueues };
}

async function commitMessages(
  messages: TelegramImportMessage[],
  kind: "telegram_bot" | "telegram_personal" | "telegram_import",
  nextOffset?: number,
  releaseBotLock = true,
) {
  const totalStarted = performance.now();
  await ensureSchema();
  const connectionKind =
    kind === "telegram_bot"
      ? "bot"
      : kind === "telegram_personal"
        ? "personal"
        : "import";
  const defaultConnection =
    kind === "telegram_bot"
      ? "telegram-bot"
      : kind === "telegram_personal"
        ? "telegram-personal"
        : "telegram-import";
  await ensureConnection(defaultConnection, connectionKind);
  const transactionId = crypto.randomUUID();
  const syncRunId = crypto.randomUUID();
  const startedAt = nowIso();
  let inserted = 0;
  let edited = 0;
  let deleted = 0;
  let duplicates = 0;
  let queues = 0;
  const aggregateTasks = new Map<
    string,
    {
      tool: string;
      sourceIds: Set<string>;
      sourceNames: Set<string>;
      pendingCount: number;
    }
  >();
  const grouped = groupTelegramImportMessages(messages, defaultConnection);
  const hashStarted = performance.now();
  const messageHashes = new Map<TelegramImportMessage, string>();
  for (let offset = 0; offset < messages.length; offset += 100) {
    const chunk = messages.slice(offset, offset + 100);
    const hashes = await Promise.all(
      chunk.map((message) => {
        const lifecycle = eventKind(message);
        const body =
          lifecycle === "deleted"
            ? ""
            : String(message.text || "").slice(0, 100_000);
        return sha256Hex(
          safeJson([lifecycle, body, message.editedAt || ""], []),
        );
      }),
    );
    chunk.forEach((message, index) =>
      messageHashes.set(message, hashes[index]),
    );
  }
  const hashMs = performance.now() - hashStarted;
  await getD1()
    .prepare(
      `INSERT INTO telegram_sync_runs
    (id,connection_id,source_id,transport,mode,status,started_at,ended_at,scanned_count,inserted_count,duplicate_count,edited_count,deleted_count,queue_count,has_more,empty_candidate_count,checkpoint_before,checkpoint_after,read_result,error_message,detail_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      syncRunId,
      defaultConnection,
      "",
      kind === "telegram_bot"
        ? "bot_api"
        : kind === "telegram_personal"
          ? "mtproto_request"
          : "official_import",
      "incremental",
      "running",
      startedAt,
      "",
      messages.length,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      "",
      "",
      "not_attempted",
      "",
      safeJson({ sourceCount: grouped.size }, {}),
    )
    .run();
  try {
    const sourceRows = await prepareSourceRows(grouped, kind);
    const prefetched = await prefetchExistingTelegramState(sourceRows);
    const sourceUpdateStatements: D1PreparedStatement[] = [];

    for (const { source, sourceName, group, bindings } of sourceRows) {
      const timestamp = nowIso();
      const existingByMessageId = new Map<string, Record<string, unknown>>();
      for (const message of group) {
        const existing = prefetched.existingMessages.get(
          `${source.id}\u0000${String(message.messageId)}`,
        );
        if (existing)
          existingByMessageId.set(String(message.messageId), existing);
      }
      const existingQueues = prefetched.existingQueues;
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
        const body =
          lifecycle === "deleted"
            ? ""
            : String(message.text || "").slice(0, 100_000);
        // A deletion timestamp can be assigned locally when Telegram only returns a
        // tombstone. It is audit metadata, not part of the remote message identity.
        const hash = messageHashes.get(message) || "";
        const existing = existingByMessageId.get(messageId);
        const legacySame =
          existing &&
          !String(existing.content_hash || "") &&
          String(existing.body || "") === body &&
          String(existing.event_kind || "message") === lifecycle &&
          !String(existing.remote_deleted_at || "");
        if (
          existing &&
          (String(existing.content_hash || "") === hash || legacySame)
        ) {
          duplicates += 1;
          if (legacySame) {
            pendingStatements.push(
              getD1()
                .prepare(
                  "UPDATE telegram_messages SET content_hash=?,remote_update_id=CASE WHEN ?='' THEN remote_update_id ELSE ? END,updated_at=? WHERE id=?",
                )
                .bind(
                  hash,
                  String(message.remoteUpdateId || ""),
                  String(message.remoteUpdateId || "").slice(0, 100),
                  timestamp,
                  existing.id,
                ),
              getD1()
                .prepare(
                  "UPDATE telegram_message_fingerprints SET content_hash=?,event_kind=?,last_remote_update_id=?,updated_at=? WHERE source_id=? AND message_id=?",
                )
                .bind(
                  hash,
                  lifecycle,
                  String(message.remoteUpdateId || "").slice(0, 100),
                  timestamp,
                  source.id,
                  messageId,
                ),
            );
          }
          if (pendingStatements.length >= 70) await flush();
          continue;
        }
        const messageRowId = existing
          ? String(existing.id)
          : crypto.randomUUID();
        const eligibleBindings = bindings.filter((binding) =>
          telegramBindingAcceptsMessage(binding, message),
        );
        const messageStatements: D1PreparedStatement[] = [];
        if (!existing) {
          messageStatements.push(
            getD1()
              .prepare(
                `INSERT INTO telegram_message_fingerprints
              (id,source_id,message_id,content_hash,event_kind,last_remote_update_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
              )
              .bind(
                crypto.randomUUID(),
                source.id,
                messageId,
                hash,
                lifecycle,
                String(message.remoteUpdateId || "").slice(0, 100),
                timestamp,
                timestamp,
              ),
            getD1()
              .prepare(
                `INSERT INTO telegram_messages
              (id,source_id,message_id,connection_id,external_message_id,remote_update_id,message_date,body,event_kind,content_hash,remote_edited_at,remote_deleted_at,body_deleted_at,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                messageRowId,
                source.id,
                messageId,
                source.connectionId,
                messageId,
                String(message.remoteUpdateId || "").slice(0, 100),
                String(message.messageDate || "").slice(0, 40),
                body,
                lifecycle,
                hash,
                String(message.editedAt || "").slice(0, 40),
                lifecycle === "deleted"
                  ? String(message.deletedAt || timestamp).slice(0, 40)
                  : "",
                lifecycle === "deleted" ? timestamp : "",
                timestamp,
                timestamp,
              ),
          );
          inserted += 1;
        } else {
          messageStatements.push(
            getD1()
              .prepare(
                "UPDATE telegram_message_fingerprints SET content_hash=?,event_kind=?,last_remote_update_id=?,updated_at=? WHERE source_id=? AND message_id=?",
              )
              .bind(
                hash,
                lifecycle,
                String(message.remoteUpdateId || "").slice(0, 100),
                timestamp,
                source.id,
                messageId,
              ),
            getD1()
              .prepare(
                `UPDATE telegram_messages SET remote_update_id=?,message_date=CASE WHEN ?='' THEN message_date ELSE ? END,
              body=?,event_kind=?,content_hash=?,remote_edited_at=?,remote_deleted_at=?,body_deleted_at=?,updated_at=? WHERE id=?`,
              )
              .bind(
                String(message.remoteUpdateId || "").slice(0, 100),
                String(message.messageDate || ""),
                String(message.messageDate || "").slice(0, 40),
                body,
                lifecycle,
                hash,
                String(message.editedAt || "").slice(0, 40),
                lifecycle === "deleted"
                  ? String(message.deletedAt || timestamp).slice(0, 40)
                  : "",
                lifecycle === "deleted" ? timestamp : "",
                timestamp,
                messageRowId,
              ),
            getD1()
              .prepare(
                `UPDATE telegram_tool_queue SET status=?,message_date=CASE WHEN ?='' THEN message_date ELSE ? END,candidate_count=CASE WHEN ?='deleted' THEN 0 ELSE candidate_count END,candidate_preview=CASE WHEN ?='deleted' THEN '' ELSE candidate_preview END,run_id='',error_message=?,selected_at='',processing_at='',processed_at='',updated_at=?
              WHERE telegram_message_id=?`,
              )
              .bind(
                lifecycle === "deleted" ? "deleted" : "pending",
                String(message.messageDate || ""),
                String(message.messageDate || "").slice(0, 40),
                lifecycle,
                lifecycle,
                lifecycle === "deleted" ? "Telegram 远端消息已删除" : "",
                timestamp,
                messageRowId,
              ),
          );
        }
        if (lifecycle === "edited" || (existing && lifecycle === "message"))
          edited += 1;
        if (lifecycle === "deleted") deleted += 1;
        for (const binding of eligibleBindings) {
          const queueKey = `${messageRowId}\u0000${binding.tool}`;
          const summary =
            lifecycle === "deleted"
              ? { count: 0, preview: "" }
              : telegramCandidateHint(binding.tool, body);
          if (existingQueues.has(queueKey)) {
            if (existing)
              messageStatements.push(
                getD1()
                  .prepare(
                    "UPDATE telegram_tool_queue SET candidate_count=?,candidate_preview=?,updated_at=? WHERE telegram_message_id=? AND tool=?",
                  )
                  .bind(
                    summary.count,
                    summary.preview.slice(0, 1_000),
                    timestamp,
                    messageRowId,
                    binding.tool,
                  ),
              );
            continue;
          }
          const queueId = crypto.randomUUID();
          messageStatements.push(
            getD1()
              .prepare(
                `INSERT OR IGNORE INTO telegram_tool_queue
              (id,telegram_message_id,tool,status,message_date,candidate_count,candidate_preview,run_id,error_message,selected_at,processing_at,processed_at,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                queueId,
                messageRowId,
                binding.tool,
                lifecycle === "deleted" ? "deleted" : "pending",
                String(message.messageDate || "").slice(0, 40),
                summary.count,
                summary.preview.slice(0, 1_000),
                "",
                lifecycle === "deleted" ? "Telegram 远端消息已删除" : "",
                "",
                "",
                "",
                timestamp,
                timestamp,
              ),
          );
          if (lifecycle !== "deleted") {
            const taskKey = binding.tool;
            const task = aggregateTasks.get(taskKey);
            if (task) {
              task.pendingCount += 1;
              task.sourceIds.add(source.id);
              task.sourceNames.add(sourceName);
            } else
              aggregateTasks.set(taskKey, {
                tool: binding.tool,
                sourceIds: new Set([source.id]),
                sourceNames: new Set([sourceName]),
                pendingCount: 1,
              });
          }
          existingQueues.add(queueKey);
          queues += 1;
        }
        if (
          pendingStatements.length &&
          pendingStatements.length + messageStatements.length > 70
        )
          await flush();
        pendingStatements.push(...messageStatements);
      }
      await flush();
      const numericIds = group
        .map((message) => telegramMessageNumber(message.messageId))
        .filter((value): value is bigint => value !== null);
      const lastId = numericIds.length
        ? String(numericIds.reduce((max, value) => (value > max ? value : max)))
        : String(group.at(-1)?.messageId || "");
      sourceUpdateStatements.push(
        getD1()
          .prepare(
            `UPDATE input_sources SET last_sync_at=?,latest_remote_message_id=CASE
        WHEN ?='' THEN latest_remote_message_id WHEN CAST(latest_remote_message_id AS INTEGER)>CAST(? AS INTEGER) THEN latest_remote_message_id ELSE ? END,
        last_error='',updated_at=? WHERE id=?`,
          )
          .bind(timestamp, lastId, lastId, lastId, timestamp, source.id),
      );
    }

    for (let offset = 0; offset < sourceUpdateStatements.length; offset += 80)
      await getD1().batch(sourceUpdateStatements.slice(offset, offset + 80));

    const timestamp = nowIso();
    const elapsedMs = performance.now() - totalStarted;
    const timings = {
      hashMs: Math.round(hashMs * 100) / 100,
      databaseAndDispatchMs:
        Math.round(Math.max(0, elapsedMs - hashMs) * 100) / 100,
      totalMs: Math.round(elapsedMs * 100) / 100,
    };
    const finalStatements = [
      getD1()
        .prepare(
          `INSERT INTO sync_transactions
        (id,source_kind,status,received_count,inserted_count,duplicate_count,edited_count,deleted_count,queue_count,detail_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          transactionId,
          kind,
          "completed",
          messages.length,
          inserted,
          duplicates,
          edited,
          deleted,
          queues,
          safeJson(
            {
              sourceCount: grouped.size,
              syncRunId,
              timings,
              taskCount: aggregateTasks.size,
            },
            {},
          ),
          timestamp,
          timestamp,
        ),
      getD1()
        .prepare(
          "UPDATE telegram_sync_runs SET status=?,ended_at=?,inserted_count=?,duplicate_count=?,edited_count=?,deleted_count=?,queue_count=?,detail_json=? WHERE id=?",
        )
        .bind(
          "completed",
          timestamp,
          inserted,
          duplicates,
          edited,
          deleted,
          queues,
          safeJson(
            {
              sourceCount: grouped.size,
              tools: [
                ...new Set(
                  sourceRows.flatMap((row) =>
                    row.bindings.map((binding) => binding.tool),
                  ),
                ),
              ],
              timings,
              taskCount: aggregateTasks.size,
            },
            {},
          ),
          syncRunId,
        ),
      getD1()
        .prepare(
          "UPDATE telegram_connections SET status=?,network_status=?,last_success_at=?,last_error='',updated_at=? WHERE connection_id=?",
        )
        .bind(
          kind === "telegram_personal" ? "session_ready" : "connected",
          kind === "telegram_personal" ? "verified_on_demand" : "reachable",
          timestamp,
          timestamp,
          defaultConnection,
        ),
    ];
    for (const task of aggregateTasks.values()) {
      const sourceIds = [...task.sourceIds];
      const sourceNames = [...task.sourceNames];
      finalStatements.push(
        getD1()
          .prepare(
            `INSERT INTO task_inbox(id,tool,stage,phase,title,run_id,record_id,source_id,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            task.tool,
            "pending",
            "received",
            `${TELEGRAM_TOOL_LABELS[task.tool]} · Telegram 同步批次`,
            "",
            "",
            sourceIds.length === 1 ? sourceIds[0] : "",
            safeJson(
              {
                syncRunId,
                sourceIds,
                sourceNames,
                sourceName:
                  sourceNames.length === 1
                    ? sourceNames[0]
                    : `${sourceNames.length} 个来源`,
                sourceCount: sourceIds.length,
                pendingCount: task.pendingCount,
                total: task.pendingCount,
                success: 0,
                empty: 0,
                error: 0,
                summary: `${task.pendingCount} 条新消息待处理`,
                timings,
              },
              {},
            ),
            timestamp,
            timestamp,
          ),
      );
    }
    if (kind === "telegram_bot" && Number.isFinite(nextOffset)) {
      finalStatements.push(
        getD1()
          .prepare(
            "UPDATE telegram_bot_state SET next_update_offset=?,last_update_id=?,lock_until=CASE WHEN ?=1 THEN '' ELSE lock_until END,updated_at=? WHERE connection_id='telegram-bot'",
          )
          .bind(
            Math.max(0, nextOffset || 0),
            Math.max(0, (nextOffset || 1) - 1),
            releaseBotLock ? 1 : 0,
            timestamp,
          ),
      );
    }
    await getD1().batch(finalStatements);
    await writeLog("info", "telegram", "Telegram 消息已安全分发", {
      kind,
      received: messages.length,
      inserted,
      edited,
      deleted,
      duplicates,
      queues,
      transactionId,
    });
    return {
      transactionId,
      syncRunId,
      received: messages.length,
      inserted,
      edited,
      deleted,
      duplicates,
      queues,
      timings,
      taskCount: aggregateTasks.size,
    };
  } catch (error) {
    const timestamp = nowIso();
    try {
      await getD1()
        .prepare(
          "UPDATE telegram_sync_runs SET status='failed',ended_at=?,inserted_count=?,duplicate_count=?,edited_count=?,deleted_count=?,queue_count=?,error_message=? WHERE id=?",
        )
        .bind(
          timestamp,
          inserted,
          duplicates,
          edited,
          deleted,
          queues,
          "Telegram 消息保存或分发失败",
          syncRunId,
        )
        .run();
    } catch {
      // The original failure remains authoritative.
    }
    throw error;
  }
}

export async function telegramStatus() {
  await ensureSchema();
  const [
    connections,
    sources,
    bindings,
    syncs,
    syncRuns,
    readStates,
    botState,
  ] = await getD1().batch([
    getD1().prepare(
      "SELECT connection_id,kind,label,status,account_key,account_label,username,network_status,last_connected_at,last_success_at,last_error,created_at,updated_at FROM telegram_connections ORDER BY kind,connection_id",
    ),
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
    getD1().prepare(
      "SELECT * FROM telegram_sync_runs ORDER BY started_at DESC LIMIT 50",
    ),
    getD1().prepare("SELECT * FROM telegram_read_states ORDER BY source_id"),
    getD1().prepare(
      "SELECT next_update_offset,last_update_id,lock_until,webhook_status,last_checked_at,updated_at FROM telegram_bot_state WHERE connection_id='telegram-bot'",
    ),
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

export async function telegramConnectionStatus() {
  await ensureSchema();
  const [connections, botState] = await getD1().batch([
    getD1().prepare(
      "SELECT connection_id,kind,label,status,account_key,account_label,username,network_status,last_connected_at,last_success_at,last_error,created_at,updated_at FROM telegram_connections ORDER BY kind,connection_id",
    ),
    getD1().prepare(
      "SELECT next_update_offset,last_update_id,lock_until,webhook_status,last_checked_at,updated_at FROM telegram_bot_state WHERE connection_id='telegram-bot'",
    ),
  ]);
  return {
    configured: Boolean(token()),
    connections: connections.results ?? [],
    botState: botState.results?.[0] ?? null,
    executionModel: "request_scoped" as const,
  };
}

export async function telegramSourcesStatus(
  input: {
    page?: number;
    pageSize?: number;
    search?: string;
    chatType?: string;
    accessStatus?: string;
    includeArchived?: boolean;
  } = {},
) {
  await ensureSchema();
  const page = Math.max(1, Math.trunc(Number(input.page) || 1));
  const pageSize = Math.min(
    200,
    Math.max(20, Math.trunc(Number(input.pageSize) || 100)),
  );
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input.search?.trim()) {
    const like = `%${input.search.trim().slice(0, 160)}%`;
    clauses.push(
      "(s.name LIKE ? OR s.username LIKE ? OR s.external_chat_id LIKE ? OR s.connection_id LIKE ?)",
    );
    values.push(like, like, like, like);
  }
  if (input.chatType) {
    clauses.push("s.chat_type=?");
    values.push(String(input.chatType).slice(0, 40));
  }
  if (input.accessStatus) {
    clauses.push("s.access_status=?");
    values.push(String(input.accessStatus).slice(0, 40));
  }
  if (!input.includeArchived) clauses.push("s.archived=0");
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const [count, sources, readStates] = await getD1().batch([
    getD1()
      .prepare(`SELECT COUNT(*) AS count FROM input_sources s${where}`)
      .bind(...values),
    getD1()
      .prepare(
        `SELECT s.*,
      (SELECT COUNT(*) FROM telegram_messages m WHERE m.source_id=s.id) AS message_count,
      (SELECT COUNT(*) FROM telegram_tool_queue q JOIN telegram_messages qm ON qm.id=q.telegram_message_id WHERE qm.source_id=s.id AND q.status='pending') AS pending_count
      FROM input_sources s${where} ORDER BY s.updated_at DESC,s.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...values, pageSize, (page - 1) * pageSize),
    getD1().prepare("SELECT * FROM telegram_read_states ORDER BY source_id"),
  ]);
  return {
    sources: sources.results ?? [],
    readStates: readStates.results ?? [],
    total: Number(count.results?.[0]?.count ?? 0),
    page,
    pageSize,
  };
}

export async function telegramBindingsStatus() {
  await ensureSchema();
  const bindings = await getD1()
    .prepare(
      "SELECT source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at FROM tool_source_bindings ORDER BY source_id,tool",
    )
    .all();
  return { bindings: bindings.results ?? [] };
}

export async function telegramSyncStatus() {
  await ensureSchema();
  const [syncs, syncRuns] = await getD1().batch([
    getD1().prepare(
      "SELECT * FROM sync_transactions ORDER BY created_at DESC LIMIT 10",
    ),
    getD1().prepare(
      "SELECT * FROM telegram_sync_runs ORDER BY started_at DESC LIMIT 50",
    ),
  ]);
  return {
    syncs: syncs.results ?? [],
    syncRuns: syncRuns.results ?? [],
  };
}

export async function telegramToolStatus(toolValue: string) {
  await ensureSchema();
  const tool = cleanTool(toolValue);
  const [sources, bindings] = await getD1().batch([
    getD1()
      .prepare(
        `SELECT s.*,
      (SELECT COUNT(*) FROM telegram_messages m WHERE m.source_id=s.id) AS message_count,
      (SELECT COUNT(*) FROM telegram_tool_queue q JOIN telegram_messages qm ON qm.id=q.telegram_message_id WHERE qm.source_id=s.id AND q.tool=? AND q.status='pending') AS pending_count
      FROM input_sources s JOIN tool_source_bindings b ON b.source_id=s.id AND b.tool=?
      WHERE s.archived=0 ORDER BY s.updated_at DESC`,
      )
      .bind(tool, tool),
    getD1()
      .prepare(
        "SELECT source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at FROM tool_source_bindings WHERE tool=? ORDER BY source_id",
      )
      .bind(tool),
  ]);
  return {
    sources: sources.results ?? [],
    bindings: bindings.results ?? [],
    boundSourceIds: (bindings.results ?? []).map((row) =>
      String(row.source_id),
    ),
    executionModel: "request_scoped" as const,
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

async function telegramBotApi(
  secret: string,
  method: string,
  query: Record<string, string> = {},
) {
  const params = new URLSearchParams(query);
  const suffix = params.size ? `?${params}` : "";
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/bot${secret}/${method}${suffix}`,
      { method: "GET" },
    );
  } catch (error) {
    await writeLog("error", "telegram", "Telegram Bot 网络请求失败", {
      method,
      error: redact(error),
    });
    throw new Error(
      "无法连接 Telegram Bot API；请稍后重试并检查 Site Secret。",
    );
  }
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || !payload || payload.ok !== true) {
    const description = String(payload?.description || "");
    const conflict =
      response.status === 409 ||
      /conflict|webhook|getupdates/i.test(description);
    if (conflict) {
      botWebhookCache.clear();
      throw new Error(
        "Bot 存在 webhook / getUpdates 冲突；请先在原服务停止 webhook，再由全局连接中心接收更新。",
      );
    }
    if (response.status === 401)
      throw new Error(
        "Telegram Bot Token 无效，请在 Site Secrets 更新后重试。",
      );
    await writeLog("error", "telegram", "Telegram Bot API 返回失败", {
      method,
      status: response.status,
      description: redact(description),
    });
    throw new Error("Telegram Bot API 暂时不可用。");
  }
  return payload;
}

async function verifyTelegramBotWebhook(secret: string, force = false) {
  const fingerprint = stableId("token", secret);
  const cachedUntil = botWebhookCache.get(fingerprint) || 0;
  if (!force && cachedUntil > Date.now())
    return { webhookStatus: "clear" as const, cached: true };
  const payload = await telegramBotApi(secret, "getWebhookInfo");
  const result =
    payload.result && typeof payload.result === "object"
      ? (payload.result as Record<string, unknown>)
      : {};
  const conflict = Boolean(String(result.url || "").trim());
  const timestamp = nowIso();
  await getD1().batch([
    getD1()
      .prepare(
        "UPDATE telegram_bot_state SET webhook_status=?,last_checked_at=?,updated_at=? WHERE connection_id='telegram-bot'",
      )
      .bind(conflict ? "conflict" : "clear", timestamp, timestamp),
    getD1()
      .prepare(
        "UPDATE telegram_connections SET status=?,network_status=?,last_error=?,updated_at=? WHERE connection_id='telegram-bot'",
      )
      .bind(
        conflict ? "error" : "ready",
        conflict ? "conflict" : "verified_on_demand",
        conflict ? "Bot 当前配置了 webhook，不能同时使用 getUpdates" : "",
        timestamp,
      ),
  ]);
  if (conflict)
    throw new Error(
      "Bot 当前仍配置 webhook；为避免重复或互斥消费，本网站不会调用 getUpdates。请先在原服务取消 webhook。",
    );
  botWebhookCache.clear();
  botWebhookCache.set(fingerprint, Date.now() + BOT_WEBHOOK_CACHE_MS);
  return { webhookStatus: "clear" as const, cached: false };
}

export async function checkTelegramBotConnection() {
  await ensureSchema();
  const secret = token();
  if (!secret)
    throw new Error(
      "Telegram Bot 尚未配置；请先在 Site Secrets 设置 TELEGRAM_BOT_TOKEN。",
    );
  await ensureConnection("telegram-bot", "bot");
  const mePayload = await telegramBotApi(secret, "getMe");
  await verifyTelegramBotWebhook(secret, true);
  const me =
    mePayload.result && typeof mePayload.result === "object"
      ? (mePayload.result as Record<string, unknown>)
      : {};
  const label = String(me.username || me.first_name || "Telegram Bot").slice(
    0,
    160,
  );
  const timestamp = nowIso();
  await getD1()
    .prepare(
      "UPDATE telegram_connections SET label=?,status='ready',network_status='verified_on_demand',last_success_at=?,last_error='',updated_at=? WHERE connection_id='telegram-bot'",
    )
    .bind(
      label.startsWith("@") || !me.username ? label : `@${label}`,
      timestamp,
      timestamp,
    )
    .run();
  return {
    configured: true,
    identity: me.username ? `@${String(me.username).slice(0, 120)}` : label,
    webhookStatus: "clear" as const,
  };
}

export type BotSyncProgress = {
  phase: string;
  label: string;
  page: number;
  pages: number;
  received: number;
  inserted: number;
};

export async function pullTelegramBot(
  onProgress?: (progress: BotSyncProgress) => void,
) {
  await ensureSchema();
  const secret = token();
  if (!secret)
    throw new Error(
      "Telegram Bot 尚未配置；请先在 Site Secrets 设置 TELEGRAM_BOT_TOKEN。",
    );
  await ensureConnection("telegram-bot", "bot");
  const lockUntil = new Date(Date.now() + 90_000).toISOString();
  const lock = await getD1()
    .prepare(
      "UPDATE telegram_bot_state SET lock_until=? WHERE connection_id='telegram-bot' AND (lock_until='' OR lock_until<?)",
    )
    .bind(lockUntil, nowIso())
    .run();
  if (Number(lock.meta?.changes ?? 0) !== 1)
    throw new Error("已有一次 Bot 全局同步正在进行，请稍后查看同步记录。");
  let webhook: { webhookStatus: "clear"; cached?: boolean };
  try {
    webhook = await verifyTelegramBotWebhook(secret);
  } catch (error) {
    await getD1()
      .prepare(
        "UPDATE telegram_bot_state SET lock_until='',updated_at=? WHERE connection_id='telegram-bot'",
      )
      .bind(nowIso())
      .run();
    throw error;
  }
  const row = await getD1()
    .prepare(
      "SELECT next_update_offset AS offset FROM telegram_bot_state WHERE connection_id='telegram-bot'",
    )
    .first();
  let offset = Math.max(0, Number(row?.offset ?? 0) || 0);
  const totals = {
    received: 0,
    remoteUpdates: 0,
    inserted: 0,
    edited: 0,
    deleted: 0,
    duplicates: 0,
    queues: 0,
    taskCount: 0,
  };
  let pages = 0;
  let remoteMs = 0;
  let localMs = 0;
  let hashMs = 0;
  let databaseMs = 0;
  let hasMore = false;
  const deadline = Date.now() + 12_000;
  try {
    for (let page = 1; page <= 10; page += 1) {
      onProgress?.({
        phase: "pulling",
        label: `正在拉取 Bot 第 ${page} 页`,
        page,
        pages,
        received: totals.remoteUpdates,
        inserted: totals.inserted,
      });
      const remoteStarted = performance.now();
      const payload = await telegramBotApi(secret, "getUpdates", {
        offset: String(offset),
        limit: "100",
        timeout: "0",
        allowed_updates: JSON.stringify([
          "message",
          "channel_post",
          "edited_message",
          "edited_channel_post",
        ]),
      });
      remoteMs += performance.now() - remoteStarted;
      pages = page;
      const rawCount = Array.isArray(payload.result)
        ? payload.result.length
        : 0;
      totals.remoteUpdates += rawCount;
      const parsed = telegramBotUpdates(payload);
      const nextOffset = parsed.nextOffset || offset;
      const capped = page >= 10 || Date.now() >= deadline;
      hasMore = rawCount === 100;
      const releaseLock = !hasMore || capped;
      const commit = await commitMessages(
        parsed.messages,
        "telegram_bot",
        nextOffset,
        releaseLock,
      );
      totals.received += commit.received;
      totals.inserted += commit.inserted;
      totals.edited += commit.edited;
      totals.deleted += commit.deleted;
      totals.duplicates += commit.duplicates;
      totals.queues += commit.queues;
      totals.taskCount += commit.taskCount;
      localMs += Number(commit.timings?.totalMs || 0);
      hashMs += Number(commit.timings?.hashMs || 0);
      databaseMs += Number(commit.timings?.databaseAndDispatchMs || 0);
      offset = nextOffset;
      onProgress?.({
        phase: "page_completed",
        label: `Bot 第 ${page} 页已提交 offset`,
        page,
        pages,
        received: totals.remoteUpdates,
        inserted: totals.inserted,
      });
      if (!hasMore || capped || nextOffset <= 0) break;
    }
    return {
      ...totals,
      pages,
      hasMore,
      nextOffset: offset,
      webhookCheck: webhook.cached ? "cached" : "fresh",
      timings: {
        remoteMs: Math.round(remoteMs * 100) / 100,
        localMs: Math.round(localMs * 100) / 100,
        hashMs: Math.round(hashMs * 100) / 100,
        databaseMs: Math.round(databaseMs * 100) / 100,
        totalMs: Math.round((remoteMs + localMs) * 100) / 100,
      },
    };
  } catch (error) {
    const timestamp = nowIso();
    await getD1().batch([
      getD1()
        .prepare(
          "UPDATE telegram_bot_state SET lock_until='',updated_at=? WHERE connection_id='telegram-bot'",
        )
        .bind(timestamp),
      getD1()
        .prepare(
          "UPDATE telegram_connections SET status='error',last_error=?,updated_at=? WHERE connection_id='telegram-bot'",
        )
        .bind(
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Telegram Bot API 暂时不可用",
          timestamp,
        ),
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
      connectionId: String(message.connectionId || "telegram-import").slice(
        0,
        80,
      ),
      chatType: String(message.chatType || "").slice(0, 40),
      username: String(message.username || "").slice(0, 160),
      remoteUpdateId: String(message.remoteUpdateId || "").slice(0, 100),
      eventKind: eventKind(message),
      editedAt: String(message.editedAt || "").slice(0, 40),
      deletedAt: String(message.deletedAt || "").slice(0, 40),
    }))
    .filter((message) => message.sourceKey && message.messageId);
  // One upload maps to one recoverable sync run. commitMessages performs
  // bounded hashing/query/write chunks internally instead of replaying the
  // full schema/source/binding lifecycle for every ten messages.
  return commitMessages(safe, "telegram_import");
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
  let queued = 0;
  while (true) {
    const rows = await getD1()
      .prepare(
        "SELECT id,message_id,message_date FROM telegram_messages WHERE source_id=? AND id>? ORDER BY id LIMIT 80",
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
    const existingQueueIds = new Set(
      (existing.results ?? []).map((row: Record<string, unknown>) =>
        String(row.telegram_message_id),
      ),
    );
    const missing = chunk.filter(
      (row: Record<string, unknown>) => !existingQueueIds.has(String(row.id)),
    );
    if (missing.length) {
      queued += missing.length;
      await getD1().batch(
        missing.map((row: Record<string, unknown>) => {
          return getD1()
            .prepare(
              `INSERT OR IGNORE INTO telegram_tool_queue(id,telegram_message_id,tool,status,message_date,candidate_count,candidate_preview,run_id,error_message,selected_at,processing_at,processed_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              crypto.randomUUID(),
              row.id,
              tool,
              "pending",
              String(row.message_date || "").slice(0, 40),
              -1,
              "",
              "",
              "",
              "",
              "",
              "",
              timestamp,
              timestamp,
            );
        }),
      );
    }
    cursor = String(chunk.at(-1)?.id ?? "");
    if (chunk.length < 80) break;
  }
  if (queued)
    await getD1()
      .prepare(
        `INSERT INTO task_inbox(id,tool,stage,phase,title,run_id,record_id,source_id,metadata_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        crypto.randomUUID(),
        tool,
        "pending",
        "received",
        `${TELEGRAM_TOOL_LABELS[tool]} · 新绑定来源`,
        "",
        "",
        sourceId,
        safeJson(
          {
            sourceId,
            pendingCount: queued,
            total: queued,
            success: 0,
            empty: 0,
            error: 0,
            summary: `${queued} 条缓存消息已进入工具队列`,
          },
          {},
        ),
        timestamp,
        timestamp,
      )
      .run();
  return { enabled: true, snapshotId, queued };
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
    historyMode: String(
      change.historyMode || "since_now",
    ) as TelegramBindingChange["historyMode"],
    historyLimit: Math.min(
      20_000,
      Math.max(0, Math.trunc(Number(change.historyLimit) || 0)),
    ),
    historyFrom: String(change.historyFrom || "").slice(0, 40),
  }));
  if (!safeChanges.length)
    return { added: 0, removed: 0, unchanged: 0, queued: 0 };
  if (
    safeChanges.some(
      (change) =>
        !change.sourceId || !HISTORY_MODES.has(String(change.historyMode)),
    )
  )
    throw new Error("Telegram 绑定参数无效");
  const sourceIds = [...new Set(safeChanges.map((change) => change.sourceId))];
  const sources = await getD1()
    .prepare(
      `SELECT id,latest_remote_message_id FROM input_sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`,
    )
    .bind(...sourceIds)
    .all();
  const sourceSet = new Set(
    (sources.results ?? []).map((row) => String(row.id)),
  );
  if (sourceSet.size !== sourceIds.length)
    throw new Error("绑定来源不存在，请先刷新全局会话库");
  const current = await getD1()
    .prepare(
      `SELECT source_id,tool FROM tool_source_bindings WHERE (${sourceIds.map(() => "source_id=?").join(" OR ")})`,
    )
    .bind(...sourceIds)
    .all();
  const currentSet = new Set(
    (current.results ?? []).map((row) => `${row.source_id}\u0000${row.tool}`),
  );
  const snapshotId = await createTelegramSnapshot(
    "修改 Telegram 工具绑定前自动恢复点",
  );
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  let queued = 0;
  const statements: D1PreparedStatement[] = [];
  const timestamp = nowIso();
  for (const change of safeChanges) {
    const pair = `${change.sourceId}\u0000${change.tool}`;
    const wasBound = currentSet.has(pair);
    if (change.enabled) {
      if (wasBound) unchanged += 1;
      else added += 1;
      const boundAt =
        change.historyMode === "since_now"
          ? String(
              (sources.results ?? []).find(
                (row) => String(row.id) === change.sourceId,
              )?.latest_remote_message_id ?? "",
            )
          : "";
      statements.push(
        getD1()
          .prepare(
            `INSERT INTO tool_source_bindings(id,source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_id,tool) DO UPDATE SET history_mode=excluded.history_mode,history_limit=excluded.history_limit,history_from=excluded.history_from,bound_at_message_id=excluded.bound_at_message_id`,
          )
          .bind(
            crypto.randomUUID(),
            change.sourceId,
            change.tool,
            change.historyMode,
            change.historyLimit,
            change.historyFrom,
            boundAt,
            timestamp,
          ),
      );
      if (change.historyMode !== "since_now") {
        const conditions = ["m.source_id=?"];
        const values: unknown[] = [change.sourceId];
        if (change.historyMode === "recent") {
          conditions.push("1=1");
        }
        if (change.historyMode === "from_date" && change.historyFrom) {
          conditions.push("m.message_date>=?");
          values.push(change.historyFrom);
        }
        const limit =
          change.historyMode === "recent"
            ? Math.min(change.historyLimit || 100, 20_000)
            : 20_000;
        statements.push(
          getD1()
            .prepare(
              `INSERT OR IGNORE INTO telegram_tool_queue(id,telegram_message_id,tool,status,message_date,candidate_count,candidate_preview,run_id,error_message,selected_at,processing_at,processed_at,created_at,updated_at)
          SELECT 'tgq-' || lower(hex(randomblob(16))),m.id,?,'pending',m.message_date,-1,'','','','','','',?,? FROM telegram_messages m WHERE ${conditions.join(" AND ")} ORDER BY m.message_date DESC,m.id DESC LIMIT ?`,
            )
            .bind(change.tool, ...values, timestamp, timestamp, limit),
        );
        queued += limit;
      }
    } else {
      if (wasBound) removed += 1;
      else unchanged += 1;
      statements.push(
        getD1()
          .prepare(
            "DELETE FROM tool_source_bindings WHERE source_id=? AND tool=?",
          )
          .bind(change.sourceId, change.tool),
      );
    }
  }
  await getD1().batch(statements);
  await writeLog("info", "telegram", "Telegram 工具绑定已事务提交", {
    added,
    removed,
    unchanged,
    queued,
  });
  return { added, removed, unchanged, queued, snapshotId };
}

export async function updateTelegramSource(input: {
  sourceId: string;
  archived?: boolean;
  accessStatus?: string;
  readPolicy?: string;
}) {
  await ensureSchema();
  const sourceId = String(input.sourceId || "");
  if (!sourceId) throw new Error("缺少 Telegram 会话");
  const policy = input.readPolicy === undefined ? "" : String(input.readPolicy);
  if (
    input.readPolicy !== undefined &&
    !new Set(["safe_auto", "never", "manual"]).has(policy)
  )
    throw new Error("已读策略无效");
  const snapshotId = await createTelegramSnapshot(
    "修改 Telegram 来源设置前自动恢复点",
  );
  const timestamp = nowIso();
  const statements = [
    getD1()
      .prepare(
        "UPDATE input_sources SET archived=COALESCE(?,archived),access_status=COALESCE(?,access_status),updated_at=? WHERE id=?",
      )
      .bind(
        input.archived === undefined ? null : input.archived ? 1 : 0,
        input.accessStatus ? String(input.accessStatus).slice(0, 40) : null,
        timestamp,
        sourceId,
      ),
  ];
  if (input.readPolicy !== undefined) {
    statements.push(
      getD1()
        .prepare(
          "INSERT INTO telegram_read_states(source_id,policy,safe_read_message_id,last_marked_read_message_id,read_baseline_message_id,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at",
        )
        .bind(sourceId, policy, "", "", "", timestamp),
    );
  }
  await getD1().batch(statements);
  return {
    sourceId,
    archived:
      input.archived === undefined ? undefined : Boolean(input.archived),
    readPolicy: input.readPolicy === undefined ? undefined : policy,
    snapshotId,
  };
}

export async function deleteTelegramBotConnection() {
  await ensureSchema();
  const snapshotId = await createTelegramSnapshot(
    "删除 Telegram Bot 连接前自动恢复点",
  );
  const timestamp = nowIso();
  await getD1().batch([
    getD1()
      .prepare(
        "UPDATE input_sources SET access_status='unavailable',last_error='Bot 全局连接已删除',updated_at=? WHERE connection_id='telegram-bot'",
      )
      .bind(timestamp),
    getD1().prepare(
      "DELETE FROM telegram_bot_state WHERE connection_id='telegram-bot'",
    ),
    getD1().prepare(
      "DELETE FROM telegram_connections WHERE connection_id='telegram-bot'",
    ),
  ]);
  await writeLog(
    "info",
    "telegram",
    "Telegram Bot 全局连接记录已删除，来源历史保留",
    {},
  );
  return {
    connectionId: "telegram-bot",
    deleted: true,
    historyPreserved: true,
    snapshotId,
  };
}

export async function telegramMigrationPreview() {
  await ensureSchema();
  const [sources, bindings, messages, queues, accounts, offsets] =
    await getD1().batch([
      getD1().prepare(
        "SELECT COUNT(*) AS count FROM input_sources WHERE connection_id='' OR connection_id LIKE 'legacy-%'",
      ),
      getD1().prepare("SELECT COUNT(*) AS count FROM tool_source_bindings"),
      getD1().prepare("SELECT COUNT(*) AS count FROM telegram_messages"),
      getD1().prepare("SELECT COUNT(*) AS count FROM telegram_tool_queue"),
      getD1().prepare("SELECT COUNT(*) AS count FROM telegram_accounts"),
      getD1().prepare(
        "SELECT COUNT(*) AS count FROM app_settings WHERE key='telegramBotOffset'",
      ),
    ]);
  const counts = Object.fromEntries(
    [
      "legacySources",
      "bindings",
      "messages",
      "queues",
      "legacyAccounts",
      "legacyBotOffsets",
    ].map((key, index) => [
      key,
      Number(
        [sources, bindings, messages, queues, accounts, offsets][index]
          .results?.[0]?.count ?? 0,
      ),
    ]),
  );
  const warnings = [
    counts.legacySources
      ? "仍存在旧来源身份字段，将按 connection_id + external_chat_id 归一化"
      : "没有发现需要改写身份的旧来源",
    counts.legacyBotOffsets
      ? "发现旧版 Bot offset，应用迁移前会复制到全局 Bot 游标"
      : "没有发现分散 Bot offset",
    "不会删除消息正文、历史结果、工具绑定或队列状态",
  ];
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  await getD1()
    .prepare(
      "INSERT INTO telegram_migration_runs(id,status,snapshot_id,counts_json,warnings_json,created_at,applied_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      "preview",
      "",
      safeJson(counts, {}),
      safeJson(warnings, []),
      timestamp,
      "",
    )
    .run();
  return { migrationId: id, counts, warnings };
}

export async function createTelegramSnapshot(reason: string) {
  const snapshotId = crypto.randomUUID();
  const timestamp = nowIso();
  const tables = [
    "telegram_connections",
    "telegram_bot_state",
    "input_sources",
    "tool_source_bindings",
    "telegram_messages",
    "telegram_message_fingerprints",
    "telegram_tool_queue",
    "telegram_read_states",
    "telegram_sync_runs",
    "telegram_accounts",
    "telegram_auth_flows",
  ];
  const items: Array<{ key: string; value: string }> = [];
  for (const table of tables) {
    const rows = await getD1().prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows.results ?? [])
      items.push({
        key: `${table}:${String((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).connection_id ?? (row as Record<string, unknown>).source_id ?? crypto.randomUUID())}`,
        value: safeJson(row, {}),
      });
  }
  await getD1()
    .prepare(
      "INSERT INTO data_snapshots(id,reason,entity,item_count,status,created_at,restored_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      snapshotId,
      reason,
      "telegram_migration",
      items.length,
      "writing",
      timestamp,
      "",
    )
    .run();
  try {
    for (let offset = 0; offset < items.length; offset += 50) {
      const chunk = items.slice(offset, offset + 50);
      await getD1().batch(
        chunk.map((item) =>
          getD1()
            .prepare(
              "INSERT INTO data_snapshot_items(snapshot_id,entity_key,previous_json) VALUES (?,?,?)",
            )
            .bind(snapshotId, item.key, item.value),
        ),
      );
    }
    await getD1()
      .prepare("UPDATE data_snapshots SET status='ready' WHERE id=?")
      .bind(snapshotId)
      .run();
  } catch (error) {
    await getD1()
      .prepare("UPDATE data_snapshots SET status='error' WHERE id=?")
      .bind(snapshotId)
      .run();
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
    queueRows.push(
      ...((result.results ?? []) as Array<Record<string, unknown>>),
    );
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
    messageRows.push(
      ...((result.results ?? []) as Array<Record<string, unknown>>),
    );
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
      items
        .slice(offset, offset + 50)
        .map((item) =>
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

export async function applyTelegramMigration(input: {
  migrationId: string;
  confirm?: boolean;
}) {
  if (!input.confirm) throw new Error("迁移是高影响操作，请先在预览后明确确认");
  await ensureSchema();
  const migrationId = String(input.migrationId || "");
  const snapshotId =
    await createTelegramSnapshot("Telegram 三层架构迁移前快照");
  const timestamp = nowIso();
  await getD1().batch([
    getD1()
      .prepare(
        "UPDATE input_sources SET connection_id=CASE WHEN connection_id='' THEN CASE WHEN kind='telegram_bot' THEN 'telegram-bot' WHEN kind='telegram_personal' THEN 'telegram-personal' ELSE 'legacy-' || kind END ELSE connection_id END,external_chat_id=CASE WHEN external_chat_id='' THEN external_key ELSE external_chat_id END,updated_at=?",
      )
      .bind(timestamp),
    getD1()
      .prepare(
        "UPDATE telegram_messages SET connection_id=COALESCE(NULLIF(connection_id,''),(SELECT connection_id FROM input_sources WHERE input_sources.id=telegram_messages.source_id)),external_message_id=COALESCE(NULLIF(external_message_id,''),message_id),updated_at=?",
      )
      .bind(timestamp),
    getD1()
      .prepare(
        "INSERT OR IGNORE INTO telegram_read_states(source_id,policy,safe_read_message_id,last_marked_read_message_id,read_baseline_message_id,updated_at) SELECT id,'never','','','',? FROM input_sources",
      )
      .bind(timestamp),
    getD1()
      .prepare(
        "INSERT OR IGNORE INTO telegram_connections(connection_id,kind,label,status,created_at,updated_at) VALUES ('telegram-bot','bot','Telegram Bot','disconnected',?,?)",
      )
      .bind(timestamp, timestamp),
    getD1()
      .prepare(
        "UPDATE telegram_migration_runs SET status='applied',snapshot_id=?,applied_at=? WHERE id=?",
      )
      .bind(snapshotId, timestamp, migrationId),
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
  const cachedCount = Number(row.candidate_count ?? -1);
  if (cachedCount >= 0)
    return { count: cachedCount, preview: String(row.candidate_preview || "") };
  const body = String(row.body ?? "").trim();
  return body
    ? candidateSummary(tool, body, String(row.source_name || "Telegram"))
    : { count: 0, preview: "" };
}

function telegramQueueRowHasCandidate(tool: ToolId, row: TelegramQueueRow) {
  return telegramQueueCandidates(tool, row).count > 0;
}

function withTelegramCandidates(
  tool: ToolId,
  row: TelegramQueueRow,
  resolved?: ReturnType<typeof telegramQueueCandidates>,
) {
  const candidates = resolved ?? telegramQueueCandidates(tool, row);
  return {
    ...row,
    candidate_count: candidates.count,
    candidate_preview: candidates.preview,
  };
}

function telegramQueueRowIsVisible(
  tool: ToolId,
  row: TelegramQueueRow,
  options: { includeCleaned?: boolean; includeNoise?: boolean },
) {
  const body = String(row.body ?? "");
  if (
    !options.includeCleaned &&
    (String(row.body_deleted_at ?? "") || !body.trim())
  )
    return false;
  return options.includeNoise || telegramQueueRowHasCandidate(tool, row);
}

function queueFilter(input: QueueFilters) {
  const tool = cleanTool(input.tool);
  const clauses = [
    "q.tool=?",
    "EXISTS (SELECT 1 FROM tool_source_bindings auth_binding WHERE auth_binding.source_id=m.source_id AND auth_binding.tool=q.tool)",
  ];
  const values: unknown[] = [tool];
  const sourceIds = [
    ...new Set((input.sourceIds ?? []).map(String).filter(Boolean)),
  ].slice(0, 100);
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
    clauses.push("q.message_date>=?");
    values.push(String(input.start).slice(0, 40));
  }
  if (input.end) {
    clauses.push("q.message_date<=?");
    values.push(String(input.end).slice(0, 40));
  }
  if (!input.includeCleaned) {
    clauses.push(
      "COALESCE(m.body_deleted_at,'')='' AND LENGTH(TRIM(COALESCE(m.body,'')))>0",
    );
  }
  if (!input.includeNoise) {
    clauses.push(
      `(q.candidate_count>0 OR (q.candidate_count<0 AND ${candidateHintClause(tool)}))`,
    );
  }
  return {
    tool,
    where: ` WHERE ${clauses.join(" AND ")}`,
    values,
    from: " FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id JOIN input_sources s ON s.id=m.source_id",
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
    messageDate: "q.message_date",
    source: "s.name",
    status: "q.status",
    messageId: "m.message_id",
  };
  const sort =
    sortFields[String(input.sort || "messageDate")] || "q.message_date";
  const direction = input.direction === "asc" ? "ASC" : "DESC";
  const select = `SELECT q.*,m.message_id,m.message_date,m.body,m.event_kind,m.remote_edited_at,m.remote_deleted_at,m.body_deleted_at,s.id AS source_id,s.name AS source_name${from}${where}`;
  const unknown = input.includeNoise
    ? 0
    : Number(
        (
          await getD1()
            .prepare(
              `SELECT COUNT(*) AS count${from}${where} AND q.candidate_count<0`,
            )
            .bind(...values)
            .first()
        )?.count ?? 0,
      );
  if (input.includeNoise || unknown === 0) {
    const [count, rows] = await getD1().batch([
      getD1()
        .prepare(`SELECT COUNT(*) AS count${from}${where}`)
        .bind(...values),
      getD1()
        .prepare(
          `${select} ORDER BY ${sort} ${direction},q.id ${direction} LIMIT ? OFFSET ?`,
        )
        .bind(...values, pageSize, (page - 1) * pageSize),
    ]);
    return {
      rows: (rows.results ?? []).map((row) =>
        withTelegramCandidates(tool, row as TelegramQueueRow),
      ),
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
  const candidateUpdates: D1PreparedStatement[] = [];
  while (true) {
    const result = await getD1()
      .prepare(
        `${select} ORDER BY ${sort} ${direction},q.id ${direction} LIMIT ? OFFSET ?`,
      )
      .bind(...values, scanSize, offset)
      .all();
    const chunk = (result.results ?? []) as TelegramQueueRow[];
    for (const row of chunk) {
      hinted += 1;
      const body = String(row.body ?? "");
      if (
        !input.includeCleaned &&
        (String(row.body_deleted_at ?? "") || !body.trim())
      )
        continue;
      const candidates = telegramQueueCandidates(tool, row);
      if (Number(row.candidate_count ?? -1) < 0)
        candidateUpdates.push(
          getD1()
            .prepare(
              "UPDATE telegram_tool_queue SET candidate_count=?,candidate_preview=?,updated_at=? WHERE id=? AND candidate_count<0",
            )
            .bind(
              candidates.count,
              candidates.preview.slice(0, 1_000),
              nowIso(),
              row.id,
            ),
        );
      if (!candidates.count) continue;
      if (total >= pageStart && rows.length < pageSize)
        rows.push(withTelegramCandidates(tool, row, candidates));
      total += 1;
    }
    if (chunk.length < scanSize) break;
    offset += chunk.length;
  }
  for (
    let updateOffset = 0;
    updateOffset < candidateUpdates.length;
    updateOffset += 80
  )
    await getD1().batch(
      candidateUpdates.slice(updateOffset, updateOffset + 80),
    );
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
           JOIN input_sources s ON s.id=m.source_id
           WHERE q.tool=? AND q.id IN (${chunk.map(() => "?").join(",")}) AND EXISTS (SELECT 1 FROM tool_source_bindings b WHERE b.source_id=m.source_id AND b.tool=q.tool)`,
        )
        .bind(tool, ...chunk)
        .all();
      for (const row of rows.results ?? []) {
        if (telegramQueueRowIsVisible(tool, row as TelegramQueueRow, input))
          allowed.add(String(row.id));
      }
    }
    if (allowed.size !== requested.length)
      throw new Error(
        "所选消息已被清理、没有当前工具可用结果，或绑定已变化，请刷新后重试",
      );
    return requested;
  }
  const query = queueFilter(input);
  const excluded = new Set((input.excludeIds ?? []).map(String));
  const ids: string[] = [];
  let cursor = "";
  while (true) {
    const cursorSql = `${query.where} AND q.id>?`;
    const rows = await getD1()
      .prepare(
        `SELECT q.id,m.message_id,m.body,m.body_deleted_at,s.name AS source_name${query.from}${cursorSql} ORDER BY q.id LIMIT 5000`,
      )
      .bind(...query.values, cursor)
      .all();
    const resultRows = (rows.results ?? []) as TelegramQueueRow[];
    const chunk = resultRows.map((row) => String(row.id));
    ids.push(
      ...resultRows
        .filter((row) => telegramQueueRowIsVisible(query.tool, row, input))
        .map((row) => String(row.id))
        .filter((id) => !excluded.has(id)),
    );
    if (chunk.length < 5000) break;
    cursor = chunk.at(-1) || "";
  }
  if (ids.length > 100_000)
    throw new Error(
      "当前 Telegram 操作范围超过 100,000 条，请先增加状态、关键词或时间筛选。 ",
    );
  return ids;
}

export async function processTelegramQueue(input: {
  tool: string;
  queueIds: string[];
  deleteBody?: boolean;
  onProgress?: (progress: {
    phase:
      | "preparing"
      | "processing"
      | "saving"
      | "updating"
      | "cleaning"
      | "completed";
    label: string;
    current: number;
    total: number;
    resultCount: number;
  }) => void;
}) {
  const totalStarted = performance.now();
  await ensureSchema();
  const tool = cleanTool(input.tool);
  const ids = [...new Set((input.queueIds ?? []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error("请先选择 Telegram 消息");
  if (ids.length > 100_000)
    throw new Error("单次 Telegram 处理最多 100,000 条，请缩小筛选范围。 ");
  const readStarted = performance.now();
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `SELECT q.id,q.telegram_message_id,q.status,m.source_id,m.connection_id,m.body,m.event_kind,m.remote_deleted_at,m.message_id,m.message_date,s.name AS source_name
      FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id JOIN input_sources s ON s.id=m.source_id
      WHERE q.tool=? AND q.id IN (${chunk.map(() => "?").join(",")}) AND EXISTS (SELECT 1 FROM tool_source_bindings b WHERE b.source_id=m.source_id AND b.tool=q.tool)`,
      )
      .bind(tool, ...chunk)
      .all();
    rows.push(...((result.results ?? []) as Array<Record<string, unknown>>));
  }
  if (rows.length !== ids.length)
    throw new Error(
      "所选 Telegram 消息不属于当前工具或绑定已变化，请刷新后重试",
    );
  if (
    rows.some(
      (row) =>
        String(row.status) === "deleted" || String(row.remote_deleted_at || ""),
    )
  ) {
    throw new Error(
      "所选范围包含 Telegram 远端已删除消息；请取消选择后再处理。",
    );
  }
  const emitProgress = (
    phase:
      | "preparing"
      | "processing"
      | "saving"
      | "updating"
      | "cleaning"
      | "completed",
    label: string,
    current: number,
    resultCount: number,
  ) =>
    input.onProgress?.({
      phase,
      label,
      current,
      total: rows.length,
      resultCount,
    });
  emitProgress("preparing", "正在建立操作前恢复点", 0, 0);
  const snapshotId = await createTelegramQueueSnapshot(
    rows.map((row) => String(row.id)),
    `处理 ${tool} Telegram 队列前自动恢复点`,
  );
  const readAndSnapshotMs = performance.now() - readStarted;
  const processingTimestamp = nowIso();
  for (let offset = 0; offset < rows.length; offset += 80) {
    const chunk = rows.slice(offset, offset + 80);
    await getD1().batch(
      chunk.map((row) =>
        getD1()
          .prepare(
            "UPDATE telegram_tool_queue SET status='processing',processing_at=?,error_message='',updated_at=? WHERE id=?",
          )
          .bind(processingTimestamp, processingTimestamp, row.id),
      ),
    );
  }
  emitProgress("processing", "正在按当前工具规则处理消息", 0, 0);
  const ruleStarted = performance.now();
  const messages: InputMessage[] = rows.map((row) => ({
    text: String(row.body || ""),
    links: [],
    messageDate: String(row.message_date || ""),
    sourceType: "telegram_api",
    source: String(row.source_name || "Telegram"),
    sourceKind: "telegram_api",
    sourceName: String(row.source_name || "Telegram"),
    connectionId: String(row.connection_id || ""),
    sourceId: String(row.source_id || ""),
    messageId: String(row.message_id || ""),
    eventKind: String(row.event_kind || "message"),
  }));
  const processed = processMessages(tool, messages);
  const ruleMs = performance.now() - ruleStarted;
  const uniqueResults = processed.results;
  let resultCount = uniqueResults.length;
  emitProgress("processing", "当前工具规则处理完成", rows.length, resultCount);
  emitProgress(
    "saving",
    uniqueResults.length ? "正在保存结果与处理历史" : "正在记录空结果状态",
    rows.length,
    resultCount,
  );
  const saveStarted = performance.now();
  let runId = "";
  try {
    const saved = await saveRun({
      tool,
      name: `Telegram · ${new Date().toLocaleString("zh-CN")}`,
      inputKind: "telegram_queue",
      sourceSummary: `${rows.length} 条所选消息；${new Set(rows.map((row) => String(row.source_id))).size} 个来源`,
      stats: processed.stats,
      options: {
        queueIds: ids.slice(0, 1_000),
        queueSelectionCount: ids.length,
        ruleMs,
      },
      results: uniqueResults,
    });
    runId = saved.runId;
    resultCount = saved.resultCount;
  } catch (error) {
    const failedAt = nowIso();
    for (let offset = 0; offset < rows.length; offset += 80) {
      const chunk = rows.slice(offset, offset + 80);
      await getD1().batch(
        chunk.map((row) =>
          getD1()
            .prepare(
              "UPDATE telegram_tool_queue SET status='error',error_message=?,processing_at='',updated_at=? WHERE id=?",
            )
            .bind("结果保存失败，可单独重跑", failedAt, row.id),
        ),
      );
    }
    throw error;
  }
  const saveMs = performance.now() - saveStarted;
  const timestamp = nowIso();
  emitProgress("updating", "正在更新消息处理状态", rows.length, resultCount);
  const outcomeByMessage = new Map(
    processed.messageResults.map((outcome) => [
      `${outcome.sourceId}\u0000${outcome.messageId}`,
      outcome,
    ]),
  );
  const updateStarted = performance.now();
  for (let offset = 0; offset < rows.length; offset += 80) {
    const chunk = rows.slice(offset, offset + 80);
    await getD1().batch(
      chunk.map((row) => {
        const outcome = outcomeByMessage.get(
          `${String(row.source_id)}\u0000${String(row.message_id)}`,
        );
        const status =
          outcome?.status === "processed_empty"
            ? TELEGRAM_PROCESSED_EMPTY_STATUS
            : outcome?.status || "error";
        return getD1()
          .prepare(
            "UPDATE telegram_tool_queue SET status=?,candidate_count=?,candidate_preview=?,run_id=?,error_message=?,processing_at='',processed_at=?,updated_at=? WHERE id=?",
          )
          .bind(
            status,
            outcome?.candidateCount || 0,
            String(outcome?.candidatePreview || "").slice(0, 1_000),
            runId,
            String(outcome?.error || "").slice(0, 1_000),
            timestamp,
            timestamp,
            row.id,
          );
      }),
    );
  }
  if (input.deleteBody !== false) {
    emitProgress(
      "cleaning",
      "正在执行原始正文清理策略",
      rows.length,
      resultCount,
    );
    const messageIds = [
      ...new Set(rows.map((row) => String(row.telegram_message_id))),
    ];
    for (let offset = 0; offset < messageIds.length; offset += 80) {
      const chunk = messageIds.slice(offset, offset + 80);
      await getD1()
        .prepare(
          `UPDATE telegram_messages SET body='',body_deleted_at=?,updated_at=?
        WHERE id IN (${chunk.map(() => "?").join(",")})
        AND NOT EXISTS (SELECT 1 FROM telegram_tool_queue remaining WHERE remaining.telegram_message_id=telegram_messages.id AND remaining.status IN ('pending','processing','error'))`,
        )
        .bind(timestamp, timestamp, ...chunk)
        .run();
    }
  }
  const updateAndCleanupMs = performance.now() - updateStarted;
  const totalMs = performance.now() - totalStarted;
  const timings = {
    readAndSnapshotMs,
    ruleMs,
    saveMs,
    updateAndCleanupMs,
    totalMs,
  };
  const speed = totalMs > 0 ? rows.length / (totalMs / 1_000) : 0;
  await getD1()
    .prepare(
      `UPDATE task_inbox SET metadata_json=json_set(metadata_json,'$.actualSpeed',?,'$.etaSeconds',0,'$.lastActivityAt',?,'$.timings',json(?),'$.summary',?),updated_at=? WHERE run_id=?`,
    )
    .bind(
      speed,
      timestamp,
      safeJson(timings, {}),
      `${rows.length} 条消息，${resultCount} 条规范结果`,
      timestamp,
      runId,
    )
    .run();
  await writeLog("info", "telegram", "已处理所选 Telegram 消息", {
    tool,
    selected: rows.length,
    resultCount,
    runId,
    timings,
  });
  emitProgress(
    "completed",
    "处理完成，结果已送入结果面板",
    rows.length,
    resultCount,
  );
  return {
    selected: rows.length,
    resultCount,
    runId,
    snapshotId,
    results: uniqueResults,
    stats: processed.stats,
    timings,
    speed,
  };
}

export async function updateTelegramQueue(
  ids: string[],
  status: "pending" | "ignored",
) {
  if (!new Set(["pending", "ignored"]).has(status))
    throw new Error("消息状态无效");
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (unique.length > 100_000)
    throw new Error("单次 Telegram 状态修改最多 100,000 条，请缩小筛选范围。 ");
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
  if (unique.length > 100_000)
    throw new Error("单次 Telegram 原文导出最多 100,000 条，请缩小筛选范围。 ");
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `SELECT q.id,q.status,m.message_id,m.message_date,m.body,s.name AS source_name FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id JOIN input_sources s ON s.id=m.source_id WHERE EXISTS (SELECT 1 FROM tool_source_bindings b WHERE b.source_id=m.source_id AND b.tool=q.tool) AND q.id IN (${chunk.map(() => "?").join(",")})`,
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
