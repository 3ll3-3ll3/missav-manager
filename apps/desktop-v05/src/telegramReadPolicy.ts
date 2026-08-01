export type TelegramReadPolicy = "safe_auto" | "never" | "manual";

export const TELEGRAM_READ_POLICIES: Array<{ value: TelegramReadPolicy; label: string; hint: string }> = [
  { value: "safe_auto", label: "增量安全入库后标已读（推荐）", hint: "只在新消息已原子写入本地后标记；历史回拉永不自动标记。" },
  { value: "never", label: "从不自动标已读", hint: "仅同步和处理本地数据，不修改 Telegram 中的已读位置。" },
  { value: "manual", label: "手动确认后标已读", hint: "安全入库后保留待确认位置，由你在来源表点击标记。" },
];

function metadataNumber(metadata: Record<string, unknown>, key: string): number {
  const value = Number(metadata[key] || 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function telegramReadPolicy(metadata: Record<string, unknown>): TelegramReadPolicy {
  const value = String(metadata.readPolicy || "");
  if (value === "safe_auto" || value === "never" || value === "manual") return value;
  return metadata.markRead === true ? "safe_auto" : "never";
}

export function withTelegramReadPolicy(metadata: Record<string, unknown>, policy: TelegramReadPolicy): Record<string, unknown> {
  return { ...metadata, readPolicy: policy, markRead: policy === "safe_auto" };
}

export function telegramReadPolicyLabel(metadata: Record<string, unknown>): string {
  return TELEGRAM_READ_POLICIES.find((item) => item.value === telegramReadPolicy(metadata))?.label.replace("（推荐）", "") || "未知";
}

export function telegramSafeReadMessageId(metadata: Record<string, unknown>): number {
  return metadataNumber(metadata, "safeReadMessageId");
}

export function telegramLastMarkedReadMessageId(metadata: Record<string, unknown>): number {
  return metadataNumber(metadata, "lastMarkedReadMessageId");
}

export function telegramReadHandledMessageId(metadata: Record<string, unknown>): number {
  return Math.max(metadataNumber(metadata, "readBaselineMessageId"), telegramLastMarkedReadMessageId(metadata));
}

export function telegramHasPendingRead(metadata: Record<string, unknown>): boolean {
  return telegramSafeReadMessageId(metadata) > telegramReadHandledMessageId(metadata);
}

export function telegramReadStateLabel(metadata: Record<string, unknown>): string {
  const state = String(metadata.readState || "");
  if (state === "pending") return `待确认至 ${telegramSafeReadMessageId(metadata) || "-"}`;
  if (state === "marked") return `已标至 ${telegramLastMarkedReadMessageId(metadata) || "-"}`;
  if (state === "disabled") return "不自动标记";
  if (state === "history_skipped") return "历史回拉未标记";
  if (state === "baseline") return `已从 ${metadataNumber(metadata, "readBaselineMessageId") || "-"} 建立增量起点`;
  if (state === "error") return `标记失败：${String(metadata.readError || "未知错误")}`;
  return "尚未同步";
}
