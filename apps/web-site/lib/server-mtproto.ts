import { env } from "cloudflare:workers";
import { Api, Logger, TelegramClient } from "teleproto";
import { PromisedWebSockets } from "teleproto/extensions";
import { StringSession } from "teleproto/sessions";
import { getD1 } from "../db";
import { CloudflareTelegramSocket } from "./cloudflare-telegram-socket";
import {
  decryptMtprotoSession,
  describeMtprotoError,
  encryptMtprotoSession,
  classifyMtprotoError,
  createMtprotoTraceId,
  normalizeInternationalPhone,
  normalizeTelegramCode,
  safeMtprotoError,
} from "./mtproto-security";
import { ensureSchema, nowIso } from "./server-store";
import { writeErrorLog, writeLog } from "./server-audit";
import { ingestTelegramMessages } from "./server-telegram";
import { telegramSyncCheckpointPlan, type TelegramImportMessage } from "./telegram";

const OWNER_ID = "owner";
const FLOW_TTL_MS = 10 * 60 * 1000;
const MTPROTO_TRANSPORT = "cloudflare_tcp_with_websocket_fallback";
const TRANSPORT_ATTEMPTS = [
  { name: "cloudflare_tcp", socket: CloudflareTelegramSocket },
  { name: "telegram_websocket", socket: PromisedWebSockets },
] as const;
type FlowRow = {
  mode: "phone" | "qr";
  stage: "waiting_code" | "waiting_password" | "waiting_qr";
  encrypted_session: string;
  challenge_json: string;
  encrypted_challenge: string;
  expires_at: string;
};
type TelegramUser = {
  id?: unknown;
  firstName?: string;
  lastName?: string;
  username?: string;
};

type DynamicClient = TelegramClient & {
  getDialogs?: (options: Record<string, unknown>) => Promise<unknown>;
  getEntity?: (entity: unknown) => Promise<unknown>;
  iterMessages?: (entity: unknown, options: Record<string, unknown>) => AsyncIterable<unknown>;
};

type ClientDiagnostic = {
  level: string;
  message: string;
  error?: ReturnType<typeof describeMtprotoError>;
};

type ConnectedClient = {
  client: TelegramClient;
  session: StringSession;
  transport: string;
  clientLog: ClientDiagnostic[];
};

function dynamicClient(client: TelegramClient) {
  return client as unknown as DynamicClient;
}

function sourceIdFor(externalChatId: string) {
  let hash = 2166136261;
  const value = `telegram-personal\u0000${externalChatId}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `tg-source-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function dialogEntity(dialog: Record<string, unknown>) {
  return (dialog.entity ?? dialog.chat ?? dialog) as Record<string, unknown>;
}

function sourceKind(entity: Record<string, unknown>, dialog: Record<string, unknown>) {
  const className = String(entity.className ?? entity._ ?? "").toLowerCase();
  if (Boolean(entity.broadcast) || className.includes("channel") && !Boolean(entity.megagroup)) return "channel";
  if (Boolean(entity.megagroup) || Boolean(dialog.isChannel)) return "supergroup";
  return "group";
}

function credentials() {
  const apiId = Number(env.TELEGRAM_API_ID || 0);
  const apiHash = String(env.TELEGRAM_API_HASH || "").trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error("请先在 Site Secrets 配置 TELEGRAM_API_ID 和 TELEGRAM_API_HASH");
  }
  return { apiId, apiHash };
}

function encryptionSecret() {
  const secret = String(env.TELEGRAM_SESSION_ENCRYPTION_KEY || "");
  if (secret.length < 32) {
    throw new Error("请先在 Site Secrets 配置至少 32 字符的 TELEGRAM_SESSION_ENCRYPTION_KEY");
  }
  return secret;
}

function expiresAt() {
  return new Date(Date.now() + FLOW_TTL_MS).toISOString();
}

async function parseChallenge(value: string) {
  if (!value) return {};
  try {
    const decrypted = await decryptMtprotoSession(value, encryptionSecret());
    return JSON.parse(decrypted) as { phoneCodeHash?: string; isCodeViaApp?: boolean };
  } catch {
    throw new Error("验证码挑战无法解密，请重新发送验证码");
  }
}

function mtprotoErrorText(error: unknown) {
  const value = error as { errorMessage?: unknown; message?: unknown } | null;
  return [value?.errorMessage, value?.message].filter(Boolean).map(String).join(" ").toUpperCase();
}

function hasMtprotoError(error: unknown, ...codes: string[]) {
  const raw = mtprotoErrorText(error);
  return codes.some((code) => raw.includes(code));
}

function accountSummary(user: TelegramUser) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return {
    accountKey: String(user.id ?? ""),
    accountLabel: (name || (user.username ? `@${user.username}` : "Telegram 账号")).slice(0, 160),
  };
}

async function flowRow() {
  await ensureSchema();
  return getD1()
    .prepare("SELECT mode,stage,encrypted_session,challenge_json,encrypted_challenge,expires_at FROM telegram_auth_flows WHERE id=?")
    .bind(OWNER_ID)
    .first<FlowRow>();
}

async function requireFlow(stages?: FlowRow["stage"][]) {
  const row = await flowRow();
  if (!row) throw new Error("登录流程不存在，请重新开始");
  if (Date.parse(row.expires_at) <= Date.now()) {
    await deleteFlow();
    throw new Error("登录流程已超时，请重新开始");
  }
  if (stages && !stages.includes(row.stage)) throw new Error("当前登录阶段不接受此操作");
  return row;
}

async function saveFlow(input: {
  mode: FlowRow["mode"];
  stage: FlowRow["stage"];
  session: string;
  challenge?: Record<string, unknown>;
}) {
  const timestamp = nowIso();
  const encrypted = await encryptMtprotoSession(input.session, encryptionSecret());
  const encryptedChallenge = input.challenge
    ? await encryptMtprotoSession(JSON.stringify(input.challenge), encryptionSecret())
    : "";
  await getD1()
    .prepare(`INSERT INTO telegram_auth_flows(id,mode,stage,encrypted_session,challenge_json,encrypted_challenge,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,stage=excluded.stage,
      encrypted_session=excluded.encrypted_session,challenge_json=excluded.challenge_json,
      encrypted_challenge=excluded.encrypted_challenge,
      expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
    .bind(OWNER_ID, input.mode, input.stage, encrypted, "{}", encryptedChallenge, expiresAt(), timestamp, timestamp)
    .run();
}

async function deleteFlow() {
  await ensureSchema();
  await getD1().prepare("DELETE FROM telegram_auth_flows WHERE id=?").bind(OWNER_ID).run();
}

async function saveAccount(user: TelegramUser, session: string) {
  const timestamp = nowIso();
  const encrypted = await encryptMtprotoSession(session, encryptionSecret());
  const summary = accountSummary(user);
  await getD1().batch([
    getD1()
      .prepare(`INSERT INTO telegram_accounts(id,status,encrypted_session,account_key,account_label,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
        encrypted_session=excluded.encrypted_session,account_key=excluded.account_key,
        account_label=excluded.account_label,updated_at=excluded.updated_at`)
      .bind(OWNER_ID, "authorized", encrypted, summary.accountKey, summary.accountLabel, timestamp, timestamp),
    getD1().prepare(`INSERT INTO telegram_connections
      (connection_id,kind,label,status,account_key,account_label,username,session_encrypted,network_status,last_connected_at,last_success_at,last_error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET status='session_ready',account_key=excluded.account_key,account_label=excluded.account_label,session_encrypted=excluded.session_encrypted,network_status='verified_on_demand',last_connected_at=excluded.last_connected_at,last_success_at=excluded.last_success_at,last_error='',updated_at=excluded.updated_at`)
      .bind("telegram-personal", "personal", "Telegram 个人账号", "session_ready", summary.accountKey, summary.accountLabel, user.username ? `@${user.username}` : "", encrypted, "verified_on_demand", timestamp, timestamp, "", timestamp, timestamp),
    getD1().prepare("DELETE FROM telegram_auth_flows WHERE id=?").bind(OWNER_ID),
  ]);
  await writeLog("info", "telegram_mtproto", "个人账号登录 Session 已加密保存", { stage: "authorized" });
  return { stage: "authorized" as const, accountLabel: summary.accountLabel };
}

function transportFailure(error: unknown, transport: string) {
  if (error && typeof error === "object") {
    Object.assign(error, { mtprotoTransport: transport });
    return error;
  }
  return Object.assign(new Error(String(error || "MTProto transport failure")), { mtprotoTransport: transport });
}

function failureTransport(error: unknown) {
  const value = error as { mtprotoTransport?: unknown } | null;
  return String(value?.mtprotoTransport || MTPROTO_TRANSPORT);
}

function failurePhase(error: unknown, fallback: string) {
  const value = error as { mtprotoPhase?: unknown } | null;
  return String(value?.mtprotoPhase || fallback);
}

function tagFailurePhase(error: unknown, phase: string) {
  if (error && typeof error === "object") {
    Object.assign(error, { mtprotoPhase: phase });
    return error;
  }
  return Object.assign(new Error(String(error || "MTProto operation failure")), { mtprotoPhase: phase });
}

function attachClientDiagnostics(
  error: unknown,
  connection: Pick<ConnectedClient, "transport" | "clientLog">,
  phase: string,
) {
  const tagged = transportFailure(tagFailurePhase(error, phase), connection.transport);
  if (tagged && typeof tagged === "object") {
    Object.assign(tagged, { mtprotoClientLog: connection.clientLog.slice(-24) });
  }
  return tagged;
}

async function connectedClient(sessionText: string, attempt: typeof TRANSPORT_ATTEMPTS[number]) {
  const session = new StringSession(sessionText);
  const clientLog: ClientDiagnostic[] = [];
  const logger = new Logger("debug" as never);
  logger.handler = ({ level, message, error }) => {
    clientLog.push({
      level: String(level),
      message: String(message).slice(0, 600),
      ...(error === undefined ? {} : { error: describeMtprotoError(error) }),
    });
    if (clientLog.length > 40) clientLog.shift();
  };
  const client = new TelegramClient(session, credentials().apiId, credentials().apiHash, {
    connectionRetries: 2,
    // teleproto consumes an attempt when Telegram asks it to migrate DCs or
    // re-wrap initConnection. One attempt turns recovery into a false failure.
    requestRetries: 5,
    retryDelay: 200,
    autoReconnect: false,
    timeout: 12,
    networkSocket: attempt.socket as typeof PromisedWebSockets,
    keepAliveInterval: 0,
    baseLogger: logger,
    deviceModel: "TG 内容工具箱 Web",
    systemVersion: "Cloudflare Worker",
    appVersion: "0.1.0",
    langCode: "zh",
    systemLangCode: "zh",
  });
  try {
    await client.connect();
    return { client, session, transport: attempt.name, clientLog } satisfies ConnectedClient;
  } catch (error) {
    await disconnect(client);
    throw attachClientDiagnostics(error, { transport: attempt.name, clientLog }, "connect");
  }
}

async function newClient(encryptedSession = "") {
  const sessionText = encryptedSession
    ? await decryptMtprotoSession(encryptedSession, encryptionSecret())
    : "";
  let lastError: unknown;
  const attempted: string[] = [];
  const attemptDiagnostics: Array<Record<string, unknown>> = [];
  for (const attempt of TRANSPORT_ATTEMPTS) {
    attempted.push(attempt.name);
    try {
      return await connectedClient(sessionText, attempt);
    } catch (error) {
      lastError = error;
      const failure = classifyMtprotoError(error);
      const tagged = error as { mtprotoClientLog?: unknown } | null;
      attemptDiagnostics.push({
        transport: attempt.name,
        failureCode: failure.code,
        diagnostic: describeMtprotoError(error),
        clientLog: Array.isArray(tagged?.mtprotoClientLog) ? tagged.mtprotoClientLog : [],
      });
      if (["API_ID_INVALID", "API_ID_PUBLISHED", "SESSION_REVOKED"].includes(failure.code)) throw error;
    }
  }
  const finalError = transportFailure(lastError, attempted.join("->"));
  if (finalError && typeof finalError === "object") {
    Object.assign(finalError, { mtprotoAttempts: attemptDiagnostics });
  }
  throw finalError;
}

async function disconnect(client: TelegramClient) {
  try {
    await client.disconnect();
  } catch {
    // The request is already complete; never leak transport errors into logs.
  }
}

async function authorizedClient() {
  await ensureSchema();
  credentials();
  encryptionSecret();
  const row = await getD1().prepare("SELECT encrypted_session FROM telegram_accounts WHERE id=?").bind(OWNER_ID).first<{ encrypted_session: string }>();
  if (!row) throw new Error("请先在 Telegram 设置中完成个人账号登录");
  const { client, session } = await newClient(row.encrypted_session);
  if (!(await client.checkAuthorization())) {
    await disconnect(client);
    throw new Error("Telegram 登录 Session 已失效，请重新登录");
  }
  return { client, session };
}

function dialogRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.dialogs)) return object.dialogs as Array<Record<string, unknown>>;
  }
  return [];
}

function dialogTitle(entity: Record<string, unknown>, dialog: Record<string, unknown>, fallback: string) {
  return String(entity.title ?? dialog.title ?? dialog.name ?? entity.username ?? fallback).slice(0, 240);
}

function dialogLatestMessageId(dialog: Record<string, unknown>) {
  const message = dialog.message && typeof dialog.message === "object" ? dialog.message as Record<string, unknown> : {};
  const value = String(message.id ?? dialog.topMessage ?? dialog.top_message ?? "").trim();
  return /^\d+$/.test(value) ? value : "";
}

export async function discoverPersonalSources() {
  const { client } = await authorizedClient();
  try {
    const dynamic = dynamicClient(client);
    if (!dynamic.getDialogs) throw new Error("当前 Telegram 客户端不支持会话发现");
    const allRows = dialogRows(await dynamic.getDialogs({ limit: 1_000 }));
    const candidateRows = allRows.filter((dialog) => {
      const entity = dialogEntity(dialog);
      const className = String(entity.className ?? entity._ ?? "").toLowerCase();
      const isGroup = Boolean(dialog.isGroup) || Boolean(dialog.isChannel) || className.includes("chat") || className.includes("channel");
      return isGroup && !(className.includes("user") && !Boolean(entity.bot));
    });
    const rows = candidateRows.slice(0, 100);
    const truncated = candidateRows.length > rows.length;
    const timestamp = nowIso();
    let discovered = 0;
    for (const dialog of rows) {
      const entity = dialogEntity(dialog);
      const externalChatId = String(dialog.id ?? entity.id ?? "").trim();
      if (!externalChatId) continue;
      const id = sourceIdFor(externalChatId);
      const kind = sourceKind(entity, dialog);
      const name = dialogTitle(entity, dialog, externalChatId);
      const username = String(entity.username ?? "").slice(0, 160);
      const latestMessageId = dialogLatestMessageId(dialog);
      const metadata = {
        accessHash: String(entity.accessHash ?? entity.access_hash ?? ""),
        entityClass: String(entity.className ?? entity._ ?? ""),
      };
      await getD1().prepare(`INSERT INTO input_sources
        (id,kind,external_key,connection_id,external_chat_id,chat_type,username,access_status,archived,last_sync_at,latest_remote_message_id,incremental_checkpoint_id,sync_cursor_message_id,sync_target_message_id,last_error,name,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,chat_type=excluded.chat_type,username=excluded.username,access_status='accessible',latest_remote_message_id=CASE WHEN CAST(excluded.latest_remote_message_id AS INTEGER)>CAST(input_sources.latest_remote_message_id AS INTEGER) THEN excluded.latest_remote_message_id ELSE input_sources.latest_remote_message_id END,metadata_json=excluded.metadata_json,last_error='',updated_at=excluded.updated_at`)
        .bind(id, "telegram_personal", externalChatId, "telegram-personal", externalChatId, kind, username, "accessible", 0, "", latestMessageId, latestMessageId, "", "", "", name, JSON.stringify(metadata), timestamp, timestamp).run();
      discovered += 1;
    }
    const finalStatements = [
      getD1().prepare("INSERT OR IGNORE INTO telegram_read_states(source_id,policy,safe_read_message_id,last_marked_read_message_id,read_baseline_message_id,updated_at) SELECT id,'never','','',latest_remote_message_id,? FROM input_sources WHERE connection_id='telegram-personal'").bind(timestamp),
      getD1().prepare("UPDATE telegram_connections SET status='session_ready',network_status='verified_on_demand',last_success_at=?,last_error='',updated_at=? WHERE connection_id='telegram-personal'").bind(timestamp, timestamp),
    ];
    if (!truncated) {
      finalStatements.unshift(
        getD1().prepare("UPDATE input_sources SET access_status='inaccessible',last_error='本次刷新未发现该会话',updated_at=? WHERE connection_id='telegram-personal' AND updated_at<>?").bind(timestamp, timestamp),
      );
    }
    await getD1().batch(finalStatements);
    await writeLog("info", "telegram_mtproto", "个人账号会话库已刷新", { discovered });
    return { discovered, total: candidateRows.length, truncated };
  } catch (error) {
    throw new Error(safeMtprotoError(error));
  } finally {
    await disconnect(client);
  }
}

function messageText(message: Record<string, unknown>) {
  const text = String(message.message ?? message.text ?? message.caption ?? "");
  const links = (Array.isArray(message.entities) ? message.entities : [])
    .filter((entity): entity is Record<string, unknown> => Boolean(entity && typeof entity === "object"))
    .map((entity) => String(entity.url ?? "").trim())
    .filter((url) => /^https?:\/\//i.test(url) && !text.includes(url));
  return [text, ...links].filter(Boolean).join("\n").slice(0, 100_000);
}

async function resolveEntity(client: TelegramClient, source: Record<string, unknown>) {
  const dynamic = dynamicClient(client);
  const username = String(source.username || "").trim();
  const reference = username ? `@${username.replace(/^@/, "")}` : String(source.external_chat_id || "");
  return dynamic.getEntity ? dynamic.getEntity(reference) : reference;
}

async function markReadWithClient(client: TelegramClient, source: Record<string, unknown>, maxId: string) {
  const entity = await resolveEntity(client, source);
  const sourceType = String(source.chat_type || "");
  if (sourceType === "channel" || sourceType === "supergroup") {
    await client.invoke(new Api.channels.ReadHistory({ channel: entity as Api.TypeEntityLike, maxId: Number(maxId) }));
  } else {
    await client.invoke(new Api.messages.ReadHistory({ peer: entity as Api.TypeEntityLike, maxId: Number(maxId) }));
  }
}

export async function syncPersonalSources(input: { sourceIds?: string[]; mode?: "incremental" | "recent" | "range" | "history"; limit?: number; start?: string; end?: string }) {
  const requested = [...new Set((input.sourceIds ?? []).map(String).filter(Boolean))].slice(0, 100);
  if (!requested.length) throw new Error("请先在会话库选择要同步的来源");
  const mode = input.mode || "incremental";
  const limit = Math.min(20_000, Math.max(1, Math.trunc(Number(input.limit) || 200)));
  const startTime = input.start ? Date.parse(input.start) : Number.NaN;
  const endTime = input.end ? Date.parse(input.end) : Number.NaN;
  if (mode === "range" && input.start && !Number.isFinite(startTime)) throw new Error("同步开始时间无效");
  if (mode === "range" && input.end && !Number.isFinite(endTime)) throw new Error("同步结束时间无效");
  if (Number.isFinite(startTime) && Number.isFinite(endTime) && startTime > endTime) throw new Error("同步开始时间不能晚于结束时间");
  const sourceRows = await getD1().prepare(`SELECT s.*,r.policy,r.safe_read_message_id,r.last_marked_read_message_id,r.read_baseline_message_id FROM input_sources s LEFT JOIN telegram_read_states r ON r.source_id=s.id WHERE s.id IN (${requested.map(() => "?").join(",")})`).bind(...requested).all();
  const { client } = await authorizedClient();
  const totals = { scanned: 0, inserted: 0, edited: 0, deleted: 0, duplicates: 0, queues: 0, sources: 0, hasMore: false };
  try {
    const dynamic = dynamicClient(client);
    if (!dynamic.iterMessages) throw new Error("当前 Telegram 客户端不支持历史读取");
    for (const source of (sourceRows.results ?? []) as Array<Record<string, unknown>>) {
      const sourceId = String(source.id);
      const checkpoint = Number(source.incremental_checkpoint_id || 0) || 0;
      const options: Record<string, unknown> = { limit: limit + 1 };
      if (mode === "incremental") {
        options.reverse = true;
        if (checkpoint > 0) options.minId = checkpoint;
      }
      if (mode === "history") {
        const oldest = await getD1().prepare("SELECT MIN(CAST(message_id AS INTEGER)) AS id FROM telegram_messages WHERE source_id=? AND CAST(message_id AS INTEGER)>0").bind(sourceId).first();
        const beforeId = Number(oldest?.id ?? source.sync_cursor_message_id ?? 0) || 0;
        if (beforeId > 0) options.offsetId = beforeId;
      }
      if (mode === "range") {
        if (Number.isFinite(endTime)) options.offsetDate = Math.floor(endTime / 1_000);
      }
      const entity = await resolveEntity(client, source);
      const messages: TelegramImportMessage[] = [];
      let scannedRemote = 0;
      for await (const value of dynamic.iterMessages(entity, options)) {
        scannedRemote += 1;
        const message = (value ?? {}) as Record<string, unknown>;
        const id = String(message.id ?? "");
        if (!id) continue;
        const date = message.date instanceof Date ? message.date.toISOString() : String(message.date ?? "");
        const messageTime = Date.parse(date);
        if (mode === "range" && Number.isFinite(startTime) && Number.isFinite(messageTime) && messageTime < startTime) continue;
        if (mode === "range" && Number.isFinite(endTime) && Number.isFinite(messageTime) && messageTime > endTime) continue;
        if (messages.length >= limit) continue;
        const className = String(message.className ?? message._ ?? "").toLowerCase();
        const isDeleted = className.includes("messageempty");
        const editDate = message.editDate instanceof Date ? message.editDate.toISOString() : String(message.editDate ?? message.edit_date ?? "");
        messages.push({
          sourceKey: String(source.external_chat_id),
          sourceName: String(source.name),
          messageId: id,
          messageDate: date,
          text: messageText(message),
          connectionId: "telegram-personal",
          chatType: String(source.chat_type || ""),
          username: String(source.username || ""),
          eventKind: isDeleted ? "deleted" : editDate ? "edited" : "message",
          editedAt: editDate,
          deletedAt: isDeleted ? nowIso() : "",
        });
      }
      const hasMore = scannedRemote > limit;
      const commit = await ingestTelegramMessages(messages, "telegram_personal");
      totals.scanned += messages.length;
      totals.inserted += commit.inserted;
      totals.edited += commit.edited;
      totals.deleted += commit.deleted;
      totals.duplicates += commit.duplicates;
      totals.queues += commit.queues;
      totals.sources += 1;
      totals.hasMore ||= hasMore;
      const checkpointPlan = telegramSyncCheckpointPlan({
        mode,
        checkpoint,
        latestRemoteMessageId: Number(source.latest_remote_message_id || 0) || 0,
        messageIds: messages.map((message) => message.messageId),
        hasMore,
      });
      const { maxId, minId, nextCheckpoint, targetId } = checkpointPlan;
      const timestamp = nowIso();
      await getD1().batch([
        getD1().prepare(`UPDATE input_sources SET last_sync_at=?,
          incremental_checkpoint_id=CASE WHEN ?='incremental' AND ?>CAST(incremental_checkpoint_id AS INTEGER) THEN CAST(? AS TEXT) ELSE incremental_checkpoint_id END,
          sync_cursor_message_id=CASE WHEN ?='history' AND ?>0 THEN CAST(? AS TEXT) WHEN ?='incremental' AND ?=1 THEN CAST(? AS TEXT) WHEN ?='incremental' THEN '' ELSE sync_cursor_message_id END,
          sync_target_message_id=CASE WHEN ?='incremental' AND ?=1 THEN CAST(? AS TEXT) WHEN ?='incremental' THEN '' ELSE sync_target_message_id END,
          latest_remote_message_id=CASE WHEN ?>CAST(latest_remote_message_id AS INTEGER) THEN CAST(? AS TEXT) ELSE latest_remote_message_id END,
          updated_at=? WHERE id=?`)
          .bind(timestamp, mode, nextCheckpoint, nextCheckpoint, mode, minId, minId, mode, hasMore ? 1 : 0, nextCheckpoint, mode, mode, hasMore ? 1 : 0, targetId, mode, targetId, targetId, timestamp, sourceId),
        getD1().prepare("UPDATE telegram_sync_runs SET source_id=?,mode=?,has_more=?,checkpoint_before=?,checkpoint_after=? WHERE id=?")
          .bind(sourceId, mode, hasMore ? 1 : 0, String(checkpoint), String(nextCheckpoint), commit.syncRunId),
      ]);
      if (mode === "incremental") {
        const safeTarget = Math.max(Number(source.safe_read_message_id || 0) || 0, nextCheckpoint);
        const markedBefore = Number(source.last_marked_read_message_id || 0) || 0;
        await getD1().prepare("UPDATE telegram_read_states SET safe_read_message_id=CASE WHEN ?>CAST(safe_read_message_id AS INTEGER) THEN CAST(? AS TEXT) ELSE safe_read_message_id END,updated_at=? WHERE source_id=?")
          .bind(safeTarget, safeTarget, timestamp, sourceId).run();
        const policy = String(source.policy || "never");
        if (policy === "safe_auto" && safeTarget > markedBefore) {
        try {
            await markReadWithClient(client, source, String(safeTarget));
          } catch {
            await getD1().prepare("UPDATE telegram_sync_runs SET read_result='failed',error_message=? WHERE id=?")
              .bind("Telegram 远端已读失败；本地安全位置已保留，可重试", commit.syncRunId).run();
            throw new Error("Telegram 远端已读失败；消息和安全位置已保存，可在全局设置中重试。");
          }
          try {
            await getD1().prepare("UPDATE telegram_read_states SET last_marked_read_message_id=?,updated_at=? WHERE source_id=?").bind(String(safeTarget), nowIso(), sourceId).run();
          } catch {
            await getD1().prepare("UPDATE telegram_sync_runs SET read_result='external_succeeded_local_state_unknown',error_message=? WHERE id=?")
              .bind("Telegram 远端已读已发生，但本地状态保存失败；请手动核对", commit.syncRunId).run();
            throw new Error("Telegram 远端已读已成功，但本地状态保存失败；请在全局设置中核对已读状态。");
          }
          await getD1().prepare("UPDATE telegram_sync_runs SET read_result='marked' WHERE id=?").bind(commit.syncRunId).run();
        } else {
          const readResult = policy === "never" ? "disabled" : safeTarget > markedBefore ? "pending_manual" : "already_marked";
          await getD1().prepare("UPDATE telegram_sync_runs SET read_result=? WHERE id=?").bind(readResult, commit.syncRunId).run();
        }
      } else {
        await getD1().batch([
          getD1().prepare("UPDATE telegram_read_states SET read_baseline_message_id=CASE WHEN ?>CAST(read_baseline_message_id AS INTEGER) THEN CAST(? AS TEXT) ELSE read_baseline_message_id END,updated_at=? WHERE source_id=?").bind(maxId, maxId, timestamp, sourceId),
          getD1().prepare("UPDATE telegram_sync_runs SET read_result='history_skipped' WHERE id=?").bind(commit.syncRunId),
        ]);
      }
    }
    await writeLog("info", "telegram_mtproto", "个人账号来源同步完成", totals);
    return totals;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes("远端已读")) throw new Error(message);
    throw new Error(safeMtprotoError(error));
  } finally {
    await disconnect(client);
  }
}

export async function markTelegramSourceRead(sourceIdValue: unknown, maxIdValue: unknown) {
  const sourceId = String(sourceIdValue || "");
  if (!sourceId) throw new Error("来源无效");
  const source = await getD1().prepare("SELECT s.*,r.policy,r.safe_read_message_id,r.last_marked_read_message_id FROM input_sources s LEFT JOIN telegram_read_states r ON r.source_id=s.id WHERE s.id=?").bind(sourceId).first<Record<string, unknown>>();
  if (!source) throw new Error("Telegram 来源不存在");
  if (String(source.connection_id || "") !== "telegram-personal") throw new Error("只有个人 API 来源支持远端已读");
  if (String(source.policy || "never") === "never") throw new Error("当前来源策略为 never；请先改为 manual 或 safe_auto");
  const safeId = String(source.safe_read_message_id || "");
  const requestedId = String(maxIdValue || safeId);
  if (!/^\d+$/.test(requestedId) || !/^\d+$/.test(safeId) || BigInt(requestedId) > BigInt(safeId)) throw new Error("只能标记到已完成增量同步的安全位置");
  const maxId = requestedId;
  const { client } = await authorizedClient();
  try {
    await markReadWithClient(client, source, maxId);
    try {
      await getD1().prepare("UPDATE telegram_read_states SET last_marked_read_message_id=?,updated_at=? WHERE source_id=?").bind(maxId, nowIso(), sourceId).run();
    } catch {
      throw new Error("Telegram 远端已读已成功，但本地状态保存失败；外部副作用已经发生。");
    }
    return { sourceId, maxId, readResult: "marked" };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes("远端已读")) throw new Error(message);
    throw new Error(safeMtprotoError(error));
  } finally {
    await disconnect(client);
  }
}

async function safeOperation<T>(
  operation: () => Promise<T>,
  context: { action: string; phase: string; mode?: "phone" | "qr" | "session" },
) {
  const traceId = createMtprotoTraceId();
  const startedAt = Date.now();
  try {
    return await operation();
  } catch (error) {
    const failure = classifyMtprotoError(error);
    const message = failure.message;
    const tagged = error as { mtprotoAttempts?: unknown; mtprotoClientLog?: unknown } | null;
    const detail = {
      traceId,
      action: context.action,
      phase: failurePhase(error, context.phase),
      mode: context.mode || "",
      errorCode: failure.code,
      transport: failureTransport(error),
      elapsedMs: Date.now() - startedAt,
      diagnostic: describeMtprotoError(error),
      attempts: Array.isArray(tagged?.mtprotoAttempts) ? tagged.mtprotoAttempts : [],
      clientLog: Array.isArray(tagged?.mtprotoClientLog) ? tagged.mtprotoClientLog : [],
    };
    const logResult = await writeErrorLog(
      "telegram_mtproto",
      "个人账号登录操作失败",
      detail,
    );
    try {
      const timestamp = nowIso();
      await getD1()
        .prepare("UPDATE telegram_connections SET status='error',network_status='unknown',last_error=?,updated_at=? WHERE connection_id='telegram-personal'")
        .bind(`${message}（错误码：${failure.code}；追踪 ID：${traceId}）`, timestamp)
        .run();
    } catch {
      // The independent app/Worker diagnostic above is already available.
    }
    const loggingNote = logResult.persisted ? "脱敏诊断已写入运行日志" : "应用日志写入失败，脱敏诊断已写入平台日志";
    throw new Error(`${message}（错误码：${failure.code}；追踪 ID：${traceId}；${loggingNote}）`);
  }
}

export async function mtprotoStatus() {
  await ensureSchema();
  const [account, flow] = await getD1().batch([
    getD1().prepare("SELECT status,account_label,updated_at FROM telegram_accounts WHERE id=?").bind(OWNER_ID),
    getD1().prepare("SELECT mode,stage,expires_at FROM telegram_auth_flows WHERE id=?").bind(OWNER_ID),
  ]);
  const accountRow = account.results?.[0];
  const flowValue = flow.results?.[0];
  const expired = flowValue && Date.parse(String(flowValue.expires_at)) <= Date.now();
  if (expired) await deleteFlow();
  const authorized = Boolean(accountRow && String(accountRow.status || "") === "authorized");
  return {
    apiConfigured: Number(env.TELEGRAM_API_ID || 0) > 0 && Boolean(String(env.TELEGRAM_API_HASH || "").trim()),
    encryptionConfigured: String(env.TELEGRAM_SESSION_ENCRYPTION_KEY || "").length >= 32,
    transport: MTPROTO_TRANSPORT,
    executionModel: "request_scoped" as const,
    liveConnection: false,
    authorized,
    accountLabel: accountRow ? String(accountRow.account_label || "Telegram 账号") : "",
    stage: expired ? "idle" : String(flowValue?.stage || (authorized ? "authorized" : "idle")),
    mode: expired ? "" : String(flowValue?.mode || ""),
    expiresAt: expired ? "" : String(flowValue?.expires_at || ""),
  };
}

export async function startPhoneLogin(phoneValue: unknown) {
  await ensureSchema();
  await getD1().prepare("INSERT OR IGNORE INTO telegram_connections(connection_id,kind,label,status,created_at,updated_at) VALUES ('telegram-personal','personal','Telegram 个人账号','disconnected',?,?)").bind(nowIso(), nowIso()).run();
  credentials();
  encryptionSecret();
  const phone = normalizeInternationalPhone(phoneValue);
  await deleteFlow();
  return safeOperation(async () => {
    const connection = await newClient();
    const { client, session } = connection;
    try {
      const sent = await client.sendCode(credentials(), phone);
      if (sent.emailRequired || sent.emailCodeSent) {
        throw new Error("Telegram 要求邮箱验证；当前最小登录测试尚未支持该额外挑战");
      }
      await saveFlow({
        mode: "phone",
        stage: "waiting_code",
        session: session.save(),
        challenge: { phoneCodeHash: sent.phoneCodeHash, isCodeViaApp: sent.isCodeViaApp },
      });
      await writeLog("info", "telegram_mtproto", "个人账号验证码已请求", { stage: "waiting_code", delivery: sent.isCodeViaApp ? "app" : "sms" });
      return { stage: "waiting_code" as const, delivery: sent.isCodeViaApp ? "app" : "sms", expiresAt: expiresAt() };
    } catch (error) {
      throw attachClientDiagnostics(error, connection, "send-code");
    } finally {
      await disconnect(client);
    }
  }, { action: "start-phone", phase: "send-code", mode: "phone" });
}

export async function submitPhoneCode(phoneValue: unknown, codeValue: unknown) {
  const phone = normalizeInternationalPhone(phoneValue);
  const code = normalizeTelegramCode(codeValue);
  const flow = await requireFlow(["waiting_code"]);
  const challenge = await parseChallenge(flow.encrypted_challenge);
  if (!challenge.phoneCodeHash) throw new Error("验证码挑战已损坏，请重新发送");
  return safeOperation(async () => {
    const connection = await newClient(flow.encrypted_session);
    const { client, session } = connection;
    try {
      let result: Api.auth.TypeAuthorization;
      try {
        result = await client.invoke(new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: challenge.phoneCodeHash,
          phoneCode: code,
        }));
      } catch (error) {
        if (hasMtprotoError(error, "SESSION_PASSWORD_NEEDED")) {
          await saveFlow({ mode: flow.mode, stage: "waiting_password", session: session.save() });
          return { stage: "waiting_password" as const };
        }
        throw error;
      }
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new Error("此手机号尚未注册 Telegram；网站不会代为创建账号");
      }
      if (!(result instanceof Api.auth.Authorization)) throw new Error("Telegram 返回了未知登录状态");
      return saveAccount(result.user as TelegramUser, session.save());
    } catch (error) {
      throw attachClientDiagnostics(error, connection, "sign-in-code");
    } finally {
      await disconnect(client);
    }
  }, { action: "submit-code", phase: "sign-in-code", mode: "phone" });
}

export async function submitTwoFactorPassword(passwordValue: unknown) {
  const password = String(passwordValue ?? "");
  if (!password || password.length > 512) throw new Error("请输入两步验证密码");
  const flow = await requireFlow(["waiting_password"]);
  return safeOperation(async () => {
    const connection = await newClient(flow.encrypted_session);
    const { client, session } = connection;
    let passwordError: unknown;
    try {
      const user = await client.signInWithPassword(credentials(), {
        password: async () => password,
        onError: async (error) => {
          passwordError = error;
          return true;
        },
      });
      return saveAccount(user as TelegramUser, session.save());
    } catch (error) {
      throw attachClientDiagnostics(passwordError || error, connection, "sign-in-password");
    } finally {
      await disconnect(client);
    }
  }, { action: "submit-password", phase: "sign-in-password", mode: flow.mode });
}

async function qrStep(encryptedSession = "") {
  const connection = await newClient(encryptedSession);
  const { client, session } = connection;
  try {
    let result = await client.invoke(new Api.auth.ExportLoginToken({
      apiId: credentials().apiId,
      apiHash: credentials().apiHash,
      exceptIds: [],
    }));
    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      await client._switchDC(result.dcId);
      result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
    }
    if (result instanceof Api.auth.LoginTokenSuccess) {
      if (!(result.authorization instanceof Api.auth.Authorization)) throw new Error("Telegram 返回了未知二维码登录状态");
      return saveAccount(result.authorization.user as TelegramUser, session.save());
    }
    if (!(result instanceof Api.auth.LoginToken)) throw new Error("Telegram 返回了未知二维码状态");
    await saveFlow({ mode: "qr", stage: "waiting_qr", session: session.save() });
    const token = Buffer.from(result.token).toString("base64url");
    return {
      stage: "waiting_qr" as const,
      qrUrl: `tg://login?token=${token}`,
      qrExpiresAt: new Date(result.expires * 1000).toISOString(),
    };
  } catch (error) {
    if (hasMtprotoError(error, "SESSION_PASSWORD_NEEDED")) {
      await saveFlow({ mode: "qr", stage: "waiting_password", session: session.save() });
      return { stage: "waiting_password" as const };
    }
    throw attachClientDiagnostics(error, connection, "qr-login-token");
  } finally {
    await disconnect(client);
  }
}

export async function startQrLogin() {
  await ensureSchema();
  await getD1().prepare("INSERT OR IGNORE INTO telegram_connections(connection_id,kind,label,status,created_at,updated_at) VALUES ('telegram-personal','personal','Telegram 个人账号','disconnected',?,?)").bind(nowIso(), nowIso()).run();
  credentials();
  encryptionSecret();
  await deleteFlow();
  return safeOperation(() => qrStep(), { action: "start-qr", phase: "export-login-token", mode: "qr" });
}

export async function pollQrLogin() {
  const flow = await requireFlow(["waiting_qr"]);
  if (flow.mode !== "qr") throw new Error("当前不是二维码登录流程");
  return safeOperation(async () => {
    try {
      return await qrStep(flow.encrypted_session);
    } catch (error) {
      // Telegram login tokens are deliberately short-lived. Recreate the token
      // on the same saved auth key so the browser never gets stuck in a 400 loop.
      if (hasMtprotoError(error, "AUTH_TOKEN_EXPIRED", "AUTH_TOKEN_INVALID", "AUTH_TOKEN_ALREADY_ACCEPTED")) {
        await deleteFlow();
        return qrStep(flow.encrypted_session);
      }
      throw error;
    }
  }, { action: "poll-qr", phase: "import-login-token", mode: "qr" });
}

export async function restoreMtprotoSession() {
  await ensureSchema();
  const row = await getD1()
    .prepare("SELECT encrypted_session FROM telegram_accounts WHERE id=?")
    .bind(OWNER_ID)
    .first<{ encrypted_session: string }>();
  if (!row) throw new Error("网站端没有已保存的 Telegram Session");
  return safeOperation(async () => {
    const connection = await newClient(row.encrypted_session);
    const { client, session } = connection;
    try {
      if (!(await client.checkAuthorization())) throw new Error("AUTH_KEY_UNREGISTERED");
      const user = await client.getMe();
      return saveAccount(user as TelegramUser, session.save());
    } catch (error) {
      throw attachClientDiagnostics(error, connection, "restore-session");
    } finally {
      await disconnect(client);
    }
  }, { action: "restore", phase: "restore-session", mode: "session" });
}

export async function cancelMtprotoLogin() {
  await deleteFlow();
  await writeLog("info", "telegram_mtproto", "个人账号登录流程已取消并解锁", { stage: "idle" });
  return { stage: "idle" as const };
}

export async function logoutMtproto() {
  await ensureSchema();
  const row = await getD1()
    .prepare("SELECT encrypted_session FROM telegram_accounts WHERE id=?")
    .bind(OWNER_ID)
    .first<{ encrypted_session: string }>();
  let remoteLoggedOut = false;
  if (row) {
    try {
      const { client } = await newClient(row.encrypted_session);
      try {
        remoteLoggedOut = await client.logOut();
      } finally {
        await disconnect(client);
      }
    } catch {
      remoteLoggedOut = false;
    }
  }
  await getD1().batch([
    getD1().prepare("DELETE FROM telegram_auth_flows WHERE id=?").bind(OWNER_ID),
    getD1().prepare("DELETE FROM telegram_accounts WHERE id=?").bind(OWNER_ID),
    getD1().prepare("UPDATE telegram_connections SET status='disconnected',session_encrypted='',account_key='',account_label='',username='',network_status='unknown',updated_at=? WHERE connection_id='telegram-personal'").bind(nowIso()),
  ]);
  await writeLog("info", "telegram_mtproto", "网站端个人账号 Session 已删除", { remoteLoggedOut });
  return { stage: "idle" as const, remoteLoggedOut };
}
