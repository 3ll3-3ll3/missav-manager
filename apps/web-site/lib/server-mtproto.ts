import { env } from "cloudflare:workers";
import { Api, Logger, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { getD1 } from "../db";
import {
  decryptMtprotoSession,
  encryptMtprotoSession,
  normalizeInternationalPhone,
  normalizeTelegramCode,
  safeMtprotoError,
} from "./mtproto-security";
import { ensureSchema, nowIso } from "./server-store";
import { writeLog } from "./server-audit";
import { ingestTelegramMessages } from "./server-telegram";
import type { TelegramImportMessage } from "./telegram";

const OWNER_ID = "owner";
const FLOW_TTL_MS = 10 * 60 * 1000;
type FlowRow = {
  mode: "phone" | "qr";
  stage: "waiting_code" | "waiting_password" | "waiting_qr";
  encrypted_session: string;
  challenge_json: string;
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

function parseChallenge(value: string) {
  try {
    return JSON.parse(value) as { phoneCodeHash?: string; isCodeViaApp?: boolean };
  } catch {
    return {};
  }
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
    .prepare("SELECT mode,stage,encrypted_session,challenge_json,expires_at FROM telegram_auth_flows WHERE id=?")
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
  await getD1()
    .prepare(`INSERT INTO telegram_auth_flows(id,mode,stage,encrypted_session,challenge_json,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,stage=excluded.stage,
      encrypted_session=excluded.encrypted_session,challenge_json=excluded.challenge_json,
      expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
    .bind(OWNER_ID, input.mode, input.stage, encrypted, JSON.stringify(input.challenge ?? {}), expiresAt(), timestamp, timestamp)
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
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET status='connected',account_key=excluded.account_key,account_label=excluded.account_label,session_encrypted=excluded.session_encrypted,network_status='reachable',last_connected_at=excluded.last_connected_at,last_success_at=excluded.last_success_at,last_error='',updated_at=excluded.updated_at`)
      .bind("telegram-personal", "personal", "Telegram 个人账号", "connected", summary.accountKey, summary.accountLabel, user.username ? `@${user.username}` : "", encrypted, "reachable", timestamp, timestamp, "", timestamp, timestamp),
    getD1().prepare("DELETE FROM telegram_auth_flows WHERE id=?").bind(OWNER_ID),
  ]);
  await writeLog("info", "telegram_mtproto", "个人账号登录 Session 已加密保存", { stage: "authorized" });
  return { stage: "authorized" as const, accountLabel: summary.accountLabel };
}

async function newClient(encryptedSession = "") {
  const sessionText = encryptedSession
    ? await decryptMtprotoSession(encryptedSession, encryptionSecret())
    : "";
  const session = new StringSession(sessionText);
  const logger = new Logger("none" as never);
  const client = new TelegramClient(session, credentials().apiId, credentials().apiHash, {
    connectionRetries: 1,
    requestRetries: 1,
    autoReconnect: false,
    timeout: 12,
    baseLogger: logger,
    deviceModel: "MissAV Manager Web",
    systemVersion: "Cloudflare Worker",
    appVersion: "0.1.0",
    langCode: "zh",
    systemLangCode: "zh",
  });
  await client.connect();
  return { client, session };
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

export async function discoverPersonalSources() {
  const { client } = await authorizedClient();
  try {
    const dynamic = dynamicClient(client);
    if (!dynamic.getDialogs) throw new Error("当前 Telegram 客户端不支持会话发现");
    const rows = dialogRows(await dynamic.getDialogs({ limit: 1_000 }));
    const timestamp = nowIso();
    const statements: D1PreparedStatement[] = [];
    let discovered = 0;
    for (const dialog of rows) {
      const entity = dialogEntity(dialog);
      const className = String(entity.className ?? entity._ ?? "").toLowerCase();
      const isGroup = Boolean(dialog.isGroup) || Boolean(dialog.isChannel) || className.includes("chat") || className.includes("channel");
      const isPrivateUser = className.includes("user") && !Boolean(entity.bot);
      if (!isGroup || isPrivateUser) continue;
      const externalChatId = String(dialog.id ?? entity.id ?? "").trim();
      if (!externalChatId) continue;
      const id = sourceIdFor(externalChatId);
      const kind = sourceKind(entity, dialog);
      const name = dialogTitle(entity, dialog, externalChatId);
      const username = String(entity.username ?? "").slice(0, 160);
      const metadata = {
        accessHash: String(entity.accessHash ?? entity.access_hash ?? ""),
        entityClass: String(entity.className ?? entity._ ?? ""),
      };
      statements.push(getD1().prepare(`INSERT INTO input_sources
        (id,kind,external_key,connection_id,external_chat_id,chat_type,username,access_status,archived,last_sync_at,latest_remote_message_id,incremental_checkpoint_id,last_error,name,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,chat_type=excluded.chat_type,username=excluded.username,access_status='accessible',metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
        .bind(id, "telegram_personal", externalChatId, "telegram-personal", externalChatId, kind, username, "accessible", 0, "", "", "", "", name, JSON.stringify(metadata), timestamp, timestamp));
      statements.push(getD1().prepare("INSERT OR IGNORE INTO telegram_read_states(source_id,policy,safe_read_message_id,last_marked_read_message_id,read_baseline_message_id,updated_at) VALUES (?,?,?,?,?,?)").bind(id, "never", "", "", "", timestamp));
      discovered += 1;
    }
    if (statements.length) await getD1().batch(statements);
    await getD1().prepare("UPDATE telegram_connections SET status='connected',network_status='reachable',last_success_at=?,last_error='',updated_at=? WHERE connection_id='telegram-personal'").bind(timestamp, timestamp).run();
    await writeLog("info", "telegram_mtproto", "个人账号会话库已刷新", { discovered });
    return { discovered, total: rows.length };
  } catch (error) {
    throw new Error(safeMtprotoError(error));
  } finally {
    await disconnect(client);
  }
}

function messageText(message: Record<string, unknown>) {
  return String(message.message ?? message.text ?? message.caption ?? "").slice(0, 100_000);
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
  const sourceRows = await getD1().prepare(`SELECT s.*,r.policy,r.safe_read_message_id,r.last_marked_read_message_id,r.read_baseline_message_id FROM input_sources s LEFT JOIN telegram_read_states r ON r.source_id=s.id WHERE s.id IN (${requested.map(() => "?").join(",")})`).bind(...requested).all();
  const { client } = await authorizedClient();
  const totals = { scanned: 0, inserted: 0, duplicates: 0, queues: 0, sources: 0 };
  try {
    const dynamic = dynamicClient(client);
    if (!dynamic.iterMessages) throw new Error("当前 Telegram 客户端不支持历史读取");
    for (const source of (sourceRows.results ?? []) as Array<Record<string, unknown>>) {
      const sourceId = String(source.id);
      const checkpoint = Number(source.incremental_checkpoint_id || 0) || 0;
      const options: Record<string, unknown> = { limit, reverse: true };
      if (mode === "incremental" && checkpoint > 0) options.minId = checkpoint;
      if (mode === "range") {
        if (input.start) options.offsetDate = new Date(input.start).getTime() / 1_000;
        if (input.end) options.maxDate = new Date(input.end).getTime() / 1_000;
      }
      const entity = await resolveEntity(client, source);
      const messages: TelegramImportMessage[] = [];
      for await (const value of dynamic.iterMessages(entity, options)) {
        const message = (value ?? {}) as Record<string, unknown>;
        const id = String(message.id ?? "");
        if (!id) continue;
        const date = message.date instanceof Date ? message.date.toISOString() : String(message.date ?? "");
        messages.push({ sourceKey: String(source.external_chat_id), sourceName: String(source.name), messageId: id, messageDate: date, text: messageText(message), connectionId: "telegram-personal", chatType: String(source.chat_type || ""), username: String(source.username || "") });
      }
      const commit = await ingestTelegramMessages(messages, "telegram_personal");
      totals.scanned += messages.length;
      totals.inserted += commit.inserted;
      totals.duplicates += commit.duplicates;
      totals.queues += commit.queues;
      totals.sources += 1;
      const maxId = messages.map((message) => Number(message.messageId)).filter(Number.isFinite).sort((a, b) => b - a)[0] || checkpoint;
      const timestamp = nowIso();
      await getD1().batch([
        getD1().prepare("UPDATE input_sources SET last_sync_at=?,incremental_checkpoint_id=CASE WHEN ?='' THEN incremental_checkpoint_id ELSE ? END,latest_remote_message_id=CASE WHEN ?='' THEN latest_remote_message_id ELSE ? END,updated_at=? WHERE id=?").bind(timestamp, String(maxId || ""), String(maxId || ""), String(maxId || ""), String(maxId || ""), timestamp, sourceId),
        getD1().prepare("UPDATE telegram_sync_runs SET source_id=?,mode=?,checkpoint_before=?,checkpoint_after=? WHERE id=?").bind(sourceId, mode, String(checkpoint), String(maxId || checkpoint), commit.syncRunId),
      ]);
      if (mode === "incremental" && String(source.policy || "never") === "safe_auto" && maxId > 0 && messages.length > 0) {
        let readResult = "marked";
        try {
          await markReadWithClient(client, source, String(maxId));
          await getD1().prepare("UPDATE telegram_read_states SET safe_read_message_id=?,last_marked_read_message_id=?,updated_at=? WHERE source_id=?").bind(String(maxId), String(maxId), nowIso(), sourceId).run();
        } catch {
          readResult = "external_succeeded_local_state_unknown";
          await getD1().prepare("UPDATE telegram_sync_runs SET read_result=?,error_message=? WHERE id=?").bind(readResult, "Telegram 远端已读结果已发生，但本地状态保存失败；请手动核对", commit.syncRunId).run();
          throw new Error("Telegram 远端已读可能已成功，但本地状态保存失败；请在全局设置中核对已读状态。");
        }
        await getD1().prepare("UPDATE telegram_sync_runs SET read_result=? WHERE id=?").bind(readResult, commit.syncRunId).run();
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
  const maxId = String(maxIdValue || "");
  if (!sourceId || !/^\d+$/.test(maxId)) throw new Error("来源和 max_id 无效");
  const source = await getD1().prepare("SELECT * FROM input_sources WHERE id=?").bind(sourceId).first<Record<string, unknown>>();
  if (!source) throw new Error("Telegram 来源不存在");
  if (String(source.connection_id || "") !== "telegram-personal") throw new Error("只有个人 API 来源支持远端已读");
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

async function safeOperation<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(safeMtprotoError(error));
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
  return {
    apiConfigured: Number(env.TELEGRAM_API_ID || 0) > 0 && Boolean(String(env.TELEGRAM_API_HASH || "").trim()),
    encryptionConfigured: String(env.TELEGRAM_SESSION_ENCRYPTION_KEY || "").length >= 32,
    authorized: Boolean(accountRow),
    accountLabel: accountRow ? String(accountRow.account_label || "Telegram 账号") : "",
    stage: expired ? "idle" : String(flowValue?.stage || (accountRow ? "authorized" : "idle")),
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
    const { client, session } = await newClient();
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
    } finally {
      await disconnect(client);
    }
  });
}

export async function submitPhoneCode(phoneValue: unknown, codeValue: unknown) {
  const phone = normalizeInternationalPhone(phoneValue);
  const code = normalizeTelegramCode(codeValue);
  const flow = await requireFlow(["waiting_code"]);
  const challenge = parseChallenge(flow.challenge_json);
  if (!challenge.phoneCodeHash) throw new Error("验证码挑战已损坏，请重新发送");
  return safeOperation(async () => {
    const { client, session } = await newClient(flow.encrypted_session);
    try {
      let result: Api.auth.TypeAuthorization;
      try {
        result = await client.invoke(new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: challenge.phoneCodeHash,
          phoneCode: code,
        }));
      } catch (error) {
        if (String((error as { errorMessage?: unknown }).errorMessage || "").includes("SESSION_PASSWORD_NEEDED")) {
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
    } finally {
      await disconnect(client);
    }
  });
}

export async function submitTwoFactorPassword(passwordValue: unknown) {
  const password = String(passwordValue ?? "");
  if (!password || password.length > 512) throw new Error("请输入两步验证密码");
  const flow = await requireFlow(["waiting_password"]);
  return safeOperation(async () => {
    const { client, session } = await newClient(flow.encrypted_session);
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
      throw passwordError || error;
    } finally {
      await disconnect(client);
    }
  });
}

async function qrStep(encryptedSession = "") {
  const { client, session } = await newClient(encryptedSession);
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
    if (String((error as { errorMessage?: unknown }).errorMessage || "").includes("SESSION_PASSWORD_NEEDED")) {
      await saveFlow({ mode: "qr", stage: "waiting_password", session: session.save() });
      return { stage: "waiting_password" as const };
    }
    throw error;
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
  return safeOperation(() => qrStep());
}

export async function pollQrLogin() {
  const flow = await requireFlow(["waiting_qr"]);
  if (flow.mode !== "qr") throw new Error("当前不是二维码登录流程");
  return safeOperation(() => qrStep(flow.encrypted_session));
}

export async function restoreMtprotoSession() {
  await ensureSchema();
  const row = await getD1()
    .prepare("SELECT encrypted_session FROM telegram_accounts WHERE id=?")
    .bind(OWNER_ID)
    .first<{ encrypted_session: string }>();
  if (!row) throw new Error("网站端没有已保存的 Telegram Session");
  return safeOperation(async () => {
    const { client, session } = await newClient(row.encrypted_session);
    try {
      if (!(await client.checkAuthorization())) throw new Error("AUTH_KEY_UNREGISTERED");
      const user = await client.getMe();
      return saveAccount(user as TelegramUser, session.save());
    } finally {
      await disconnect(client);
    }
  });
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
