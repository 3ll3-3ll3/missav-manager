export type TelegramImportMessage = {
  sourceKey: string;
  sourceName: string;
  messageId: string;
  messageDate: string;
  text: string;
  connectionId?: string;
  chatType?: string;
  username?: string;
  remoteUpdateId?: string;
  eventKind?: "message" | "edited" | "deleted";
  editedAt?: string;
  deletedAt?: string;
};

export type TelegramDeliveryRule = {
  historyMode: string;
  historyFrom: string;
  boundAtMessageId: string;
};

function telegramMessageNumber(value: unknown) {
  const text = String(value ?? "").trim();
  return /^-?\d+$/.test(text) ? BigInt(text) : null;
}

export function telegramBindingAcceptsMessage(
  binding: TelegramDeliveryRule,
  message: Pick<TelegramImportMessage, "messageId" | "messageDate">,
) {
  if (binding.historyMode === "since_now" && binding.boundAtMessageId) {
    const current = telegramMessageNumber(message.messageId);
    const baseline = telegramMessageNumber(binding.boundAtMessageId);
    if (current !== null && baseline !== null) return current > baseline;
    return String(message.messageId) !== binding.boundAtMessageId;
  }
  if (binding.historyMode === "from_date" && binding.historyFrom && message.messageDate) {
    const messageTime = Date.parse(message.messageDate);
    const fromTime = Date.parse(binding.historyFrom);
    if (Number.isFinite(messageTime) && Number.isFinite(fromTime)) return messageTime >= fromTime;
  }
  return true;
}

export function telegramSyncCheckpointPlan(input: {
  mode: "incremental" | "recent" | "range" | "history";
  checkpoint: number;
  latestRemoteMessageId: number;
  messageIds: Array<string | number>;
  hasMore: boolean;
}) {
  const ids = input.messageIds.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const maxId = ids.length ? Math.max(...ids) : input.checkpoint;
  const minId = ids.length ? Math.min(...ids) : 0;
  const nextCheckpoint = input.mode === "incremental"
    ? Math.max(input.checkpoint, maxId)
    : input.checkpoint;
  return {
    maxId,
    minId,
    nextCheckpoint,
    targetId: Math.max(input.latestRemoteMessageId, maxId),
    incrementalCursor: input.mode === "incremental" && input.hasMore ? nextCheckpoint : 0,
    historyCursor: input.mode === "history" ? minId : 0,
  };
}

function telegramDate(value: unknown) {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1_000).toISOString()
    : "";
}

function flatten(value: unknown): string {
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    const label = flatten(item.text ?? item.caption ?? "");
    const href = String(item.href ?? "");
    return href && !label.includes(href) ? `${label} ${href}` : label;
  }
  return String(value ?? "");
}

export function parseTelegramOfficialJson(value: unknown) {
  const output: TelegramImportMessage[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, inherited?: { key: string; name: string }) => {
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    const ownMessages = Array.isArray(object.messages) ? object.messages : null;
    const key = String(object.id ?? inherited?.key ?? "telegram-import");
    const name = String(object.name ?? inherited?.name ?? "Telegram 官方导入").slice(0, 240);
    if (ownMessages) {
      for (const raw of ownMessages) {
        if (!raw || typeof raw !== "object") continue;
        const message = raw as Record<string, unknown>;
        if (String(message.type ?? "message") !== "message") continue;
        const messageId = String(message.id ?? "").trim();
        if (!messageId) continue;
        const fingerprint = `${key}:${messageId}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        output.push({ sourceKey: key, sourceName: name, messageId, messageDate: String(message.date ?? message.date_unixtime ?? ""), text: flatten(message.text ?? message.caption ?? "").trim().slice(0, 100_000), connectionId: "telegram-import", chatType: "import", eventKind: "message" });
      }
    }
    for (const child of Object.values(object)) {
      if (child === ownMessages) continue;
      if (Array.isArray(child)) child.forEach((entry) => visit(entry, { key, name }));
      else if (child && typeof child === "object") visit(child, { key, name });
    }
  };
  visit(value);
  return output;
}

export function telegramBotUpdates(value: unknown) {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const results = Array.isArray(object.result) ? object.result : [];
  const messages: TelegramImportMessage[] = [];
  let nextOffset = 0;
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const update = raw as Record<string, unknown>;
    nextOffset = Math.max(nextOffset, Number(update.update_id ?? 0) + 1);
    const edited = Boolean(update.edited_message ?? update.edited_channel_post);
    const message = (update.message ?? update.channel_post ?? update.edited_message ?? update.edited_channel_post) as Record<string, unknown> | undefined;
    const chat = message?.chat as Record<string, unknown> | undefined;
    if (!message || !chat || message.message_id === undefined) continue;
    const chatType = String(chat.type ?? "");
    if (!["group", "supergroup", "channel"].includes(chatType)) continue;
    const sourceKey = String(chat.id ?? "");
    const sourceName = String(chat.title ?? chat.username ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ?? sourceKey).slice(0, 240);
    const body = [message.text, message.caption].map(flatten).filter(Boolean).join("\n").trim();
    messages.push({
      sourceKey,
      sourceName,
      messageId: String(message.message_id),
      messageDate: telegramDate(message.date),
      text: body.slice(0, 100_000),
      connectionId: "telegram-bot",
      chatType,
      username: String(chat.username ?? ""),
      remoteUpdateId: String(update.update_id ?? ""),
      eventKind: edited ? "edited" : "message",
      editedAt: edited ? telegramDate(message.edit_date) : "",
    });
  }
  return { messages, nextOffset };
}
