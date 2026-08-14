import { redact } from "./security";

const ENCRYPTION_CONTEXT = new TextEncoder().encode("missav-manager/telegram-session/v1");

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

async function encryptionKey(secret: string) {
  if (secret.trim().length < 32) {
    throw new Error("TELEGRAM_SESSION_ENCRYPTION_KEY 必须至少 32 个字符");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptMtprotoSession(session: string, secret: string) {
  if (!session) throw new Error("Telegram Session 为空，拒绝保存");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ENCRYPTION_CONTEXT },
    await encryptionKey(secret),
    new TextEncoder().encode(session),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(cipher))}`;
}

export async function decryptMtprotoSession(payload: string, secret: string) {
  const [version, iv, cipher, extra] = payload.split(".");
  if (version !== "v1" || !iv || !cipher || extra) throw new Error("网站端 Telegram Session 格式无效");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: ENCRYPTION_CONTEXT },
      await encryptionKey(secret),
      fromBase64Url(cipher),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("网站端 Telegram Session 无法解密；请确认加密 Secret 未被更换");
  }
}

export function normalizeInternationalPhone(value: unknown) {
  const compact = String(value ?? "").replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) {
    throw new Error("手机号必须是国际格式，例如 +6591234567");
  }
  return compact;
}

export function normalizeTelegramCode(value: unknown) {
  const code = String(value ?? "").replace(/[\s-]/g, "");
  if (!/^\d{4,8}$/.test(code)) throw new Error("验证码格式无效");
  return code;
}

export type SafeMtprotoFailure = { code: string; message: string };

export function createMtprotoTraceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...bytes].map((part) => part.toString(16).padStart(2, "0")).join("");
  // Prefix every short group with a letter so phone-number redaction can never
  // mistake an operational trace identifier for a phone number.
  return `tg-r${hex.slice(0, 4)}-s${hex.slice(4, 8)}-t${hex.slice(8, 12)}-u${hex.slice(12, 16)}`;
}

export type SafeMtprotoDiagnostic = {
  name: string;
  constructor: string;
  code: string;
  errorMessage: string;
  message: string;
  cause: {
    name: string;
    constructor: string;
    code: string;
    message: string;
  } | null;
  stack: string[];
};

function diagnosticText(value: unknown, max = 1_200) {
  return redact(value).replace(/[\r\n]+/g, " ").slice(0, max);
}

export function describeMtprotoError(error: unknown): SafeMtprotoDiagnostic {
  const value = error as {
    name?: unknown;
    code?: unknown;
    errorMessage?: unknown;
    message?: unknown;
    stack?: unknown;
    constructor?: { name?: unknown };
    cause?: {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      constructor?: { name?: unknown };
    };
  } | null;
  const cause = value?.cause;
  return {
    name: diagnosticText(value?.name, 120),
    constructor: diagnosticText(value?.constructor?.name, 120),
    code: diagnosticText(value?.code, 160),
    errorMessage: diagnosticText(value?.errorMessage),
    message: diagnosticText(value?.message ?? error),
    cause: cause ? {
      name: diagnosticText(cause.name, 120),
      constructor: diagnosticText(cause.constructor?.name, 120),
      code: diagnosticText(cause.code, 160),
      message: diagnosticText(cause.message),
    } : null,
    stack: String(value?.stack ?? "")
      .split("\n")
      .slice(0, 5)
      .map((line) => diagnosticText(line, 500))
      .filter(Boolean),
  };
}

function rawMtprotoError(error: unknown) {
  const value = error as {
    errorMessage?: unknown;
    message?: unknown;
    code?: unknown;
    name?: unknown;
    cause?: { message?: unknown; code?: unknown; name?: unknown };
  } | null;
  return [
    value?.errorMessage,
    value?.message,
    value?.code,
    value?.name,
    value?.cause?.message,
    value?.cause?.code,
    value?.cause?.name,
  ].filter(Boolean).map(String).join(" ").toUpperCase();
}

export function classifyMtprotoError(error: unknown): SafeMtprotoFailure {
  const raw = rawMtprotoError(error);
  if (raw.includes("TELEGRAM_SESSION_BUSY")) return { code: "TELEGRAM_SESSION_BUSY", message: "上一项 Telegram 个人账号操作仍在安全收尾，请稍后重试；系统已阻止重复连接" };
  if (
    raw.includes("AUTH_KEY_DUPLICATED") ||
    raw.includes("CONCURRENT USAGE OF THE CURRENT SESSION") ||
    raw.includes("CURRENT SESSION WAS INVALIDATED BY THE SERVER")
  )
    return {
      code: "SESSION_CONCURRENT_INVALIDATED",
      message:
        "Telegram 检测到同一 Session 被重复连接，当前 Session 已失效。请到全局 Telegram 中心重新登录一次",
    };
  if (raw.includes("AUTH_TOKEN_EXPIRED") || raw.includes("AUTH_TOKEN_INVALID") || raw.includes("AUTH_TOKEN_ALREADY_ACCEPTED")) return { code: "QR_TOKEN_EXPIRED", message: "二维码已失效，请重新生成" };
  if (raw.includes("PHONE_CODE_INVALID")) return { code: "PHONE_CODE_INVALID", message: "验证码不正确，请重试" };
  if (raw.includes("PHONE_CODE_EXPIRED")) return { code: "PHONE_CODE_EXPIRED", message: "验证码已过期，请重新发送" };
  if (raw.includes("PHONE_CODE_EMPTY") || raw.includes("PHONE_CODE_HASH_EMPTY")) return { code: "PHONE_CHALLENGE_EXPIRED", message: "验证码挑战已失效，请重新发送" };
  if (raw.includes("PHONE_NUMBER_INVALID")) return { code: "PHONE_NUMBER_INVALID", message: "Telegram 拒绝了该手机号格式" };
  if (raw.includes("PHONE_NUMBER_BANNED")) return { code: "PHONE_NUMBER_BANNED", message: "该手机号无法用于 Telegram 登录" };
  if (raw.includes("PHONE_NUMBER_UNOCCUPIED")) return { code: "PHONE_NUMBER_UNOCCUPIED", message: "该手机号尚未注册 Telegram" };
  if (raw.includes("PHONE_CODE_FLOOD") || raw.includes("PHONE_NUMBER_FLOOD")) return { code: "PHONE_FLOOD", message: "该手机号请求过于频繁，请稍后再试" };
  if (raw.includes("SESSION_PASSWORD_NEEDED")) return { code: "PASSWORD_NEEDED", message: "该账号已开启两步验证，请输入密码" };
  if (raw.includes("PASSWORD_HASH_INVALID") || raw.includes("AUTH_USER_CANCEL")) return { code: "PASSWORD_INVALID", message: "两步验证密码不正确" };
  if (raw.includes("AUTH_KEY_UNREGISTERED") || raw.includes("SESSION_REVOKED")) return { code: "SESSION_REVOKED", message: "登录 Session 已失效，请重新登录" };
  if (raw.includes("AUTH_RESTART")) return { code: "AUTH_RESTART", message: "Telegram 登录状态已重置，请重新开始" };
  if (raw.includes("API_ID_PUBLISHED_FLOOD")) return { code: "API_ID_PUBLISHED", message: "该 Telegram API ID 已被公开并被 Telegram 停用，请在 my.telegram.org 创建新的应用凭据" };
  if (raw.includes("API_ID_INVALID") || raw.includes("APIIDINVALIDERROR") || raw.includes("CONNECTIONAPIIDINVALIDERROR")) return { code: "API_ID_INVALID", message: "TELEGRAM_API_ID 或 TELEGRAM_API_HASH 无效" };
  if (raw.includes("FLOOD_WAIT")) {
    const seconds = raw.match(/FLOOD_WAIT[_ ]?(\d+)/)?.[1];
    return { code: "FLOOD_WAIT", message: seconds ? `Telegram 限流，请在 ${seconds} 秒后重试` : "Telegram 暂时限流，请稍后重试" };
  }
  if (raw.includes("MTPROTO_WEBSOCKET_UNAVAILABLE") || raw.includes("NO WEBSOCKET IMPLEMENTATION")) return { code: "WS_UNAVAILABLE", message: "当前运行环境没有可用的 Telegram WebSocket 通道" };
  if (raw.includes("WEBSOCKET CONNECTION") || raw.includes("WEBSOCKET WAS CLOSED")) return { code: "WS_CONNECT_FAILED", message: "Telegram WebSocket 通道连接失败，请稍后重试" };
  if (raw.includes("CLOUDFLARE TCP") || raw.includes("DIRECT TCP") || raw.includes("PROXY REQUEST FAILED")) return { code: "TCP_CONNECT_FAILED", message: "Telegram 原生 TCP 通道连接失败，WebSocket 回退也未能完成握手" };
  if (raw.includes("BAD_AUTH_KEY_BUFFER") || raw.includes("SECURITY ERROR")) return { code: "AUTH_HANDSHAKE_FAILED", message: "Telegram MTProto 鉴权握手失败，请取消后重新开始登录" };
  if (raw.includes("CANCELED") || raw.includes("CANCELLED")) return { code: "REQUEST_CANCELLED", message: "Telegram 登录请求在完成握手前被中止，请保持页面打开后重试" };
  if (raw.includes("REQUEST WAS UNSUCCESSFUL")) return { code: "MTPROTO_RETRY_EXHAUSTED", message: "Telegram 在切换数据中心或初始化连接后仍未完成请求" };
  if (raw.includes("TIMEOUT") || raw.includes("ETIMEDOUT")) return { code: "NETWORK_TIMEOUT", message: "连接 Telegram 超时，请稍后重试" };
  if (raw.includes("ECONN") || raw.includes("SOCKET")) return { code: "NETWORK_CONNECT_FAILED", message: "连接 Telegram 失败，请稍后重试" };
  return { code: "UNKNOWN_LOGIN_FAILURE", message: "Telegram 登录请求失败" };
}

export function safeMtprotoError(error: unknown) {
  return classifyMtprotoError(error).message;
}
