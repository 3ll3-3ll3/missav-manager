const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/;

export function text(value: unknown, max = 4_000) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

export function csvSafe(value: unknown) {
  const raw = String(value ?? "").replace(/\u0000/g, "");
  const guarded = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replaceAll('"', '""')}"`;
}

export function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] || char);
}

export function safeHttpUrl(value: unknown) {
  const raw = text(value, 4_000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return "";
  }
}

export function redact(value: unknown) {
  return String(value ?? "")
    .replace(/tg:\/\/login\?token=[A-Za-z0-9_+=/%-]+/gi, "tg://login?token=[REDACTED]")
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/gi, "bot[REDACTED]")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[TELEGRAM_TOKEN_REDACTED]")
    .replace(/((?:api[_ -]?id|api[_ -]?hash|auth[_ -]?key|phone[_ -]?code[_ -]?hash|token|password|session|验证码|两步验证密码)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[REDACTED]")
    .replace(/\+?\d[\d -]{7,}\d/g, "[PHONE_REDACTED]")
    .slice(0, 8_000);
}

export function safeJson(value: unknown, fallback: unknown = {}) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
