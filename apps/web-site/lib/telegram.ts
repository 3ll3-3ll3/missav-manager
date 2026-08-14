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

const TELEGRAM_BADNEWS_HINT = /https?:\/\/(?:www\.)?bad\.news\/t\/\d+/i;
const TELEGRAM_HAIJIAO_HINT =
  /https?:\/\/(?:www\.)?haijiaolove\.xyz\/(?:hjjd|hjmz|hjyc|hjfn|hjsz|hjrq|hjhj)\/\d+\.html/i;
const TELEGRAM_TWITTER_RESERVED = new Set([
  "about",
  "compose",
  "explore",
  "hashtag",
  "home",
  "i",
  "intent",
  "login",
  "messages",
  "notifications",
  "search",
  "settings",
  "share",
  "signup",
]);
const TELEGRAM_TWITTER_TOPICS = new Set([
  "adult",
  "cosplay",
  "hentai",
  "nude",
  "nsfw",
  "porn",
  "porno",
  "sex",
  "sexy",
  "xxx",
]);
const TELEGRAM_AV_HINT =
  /(?:https?:\/\/(?:[^/]+\.)?(?:missav\.(?:ai|ws)|123av\.com)\/|(?:^|[^A-Za-z0-9])FC2(?:[ _-]*PPV)?[ _-]*\d{4,10}|(?:^|[^A-Za-z0-9])[A-Za-z]{2,8}[ _-]*\d{2,5})/i;

/** Linear, allocation-bounded grouping used by every import transport. */
export function groupTelegramImportMessages(
  messages: TelegramImportMessage[],
  defaultConnection: string,
) {
  const grouped = new Map<string, TelegramImportMessage[]>();
  for (const message of messages) {
    const connectionId = message.connectionId || defaultConnection;
    const key = `${connectionId}\u0000${message.sourceKey}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(message);
    else grouped.set(key, [message]);
  }
  return grouped;
}

/**
 * Cheap queue visibility hint only. Sync never runs the full five-tool
 * extraction pipeline; authoritative candidates and previews are written when
 * the user processes the queue row.
 */
export function telegramCandidateHint(tool: string, body: string) {
  const text = String(body || "");
  const likely =
    tool === "badnews"
      ? TELEGRAM_BADNEWS_HINT.test(text)
      : tool === "haijiao"
        ? TELEGRAM_HAIJIAO_HINT.test(text)
        : tool === "twitter"
          ? telegramTwitterCandidateHint(text)
          : TELEGRAM_AV_HINT.test(text);
  return likely
    ? { count: 1, preview: "发现可能候选，等待处理" }
    : { count: 0, preview: "" };
}

export function telegramFloodWaitError(error: unknown) {
  return /FLOOD_WAIT|FLOOD_PREMIUM_WAIT|flood\s*wait|wait of \d+ seconds/i.test(
    String(error instanceof Error ? error.message : error),
  );
}

/**
 * Reuses one authorized MTProto client while reading a small number of
 * sources concurrently. A FloodWait only retries its affected source and
 * permanently reduces the remaining queue to one source at a time.
 */
export async function runAdaptiveTelegramSourceQueue<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  requestedConcurrency = 3,
) {
  const initialConcurrency = Math.max(
    1,
    Math.min(4, Math.trunc(requestedConcurrency) || 3, items.length || 1),
  );
  let concurrency = initialConcurrency;
  let reducedByFlood = false;
  const results = new Array<R>(items.length);
  let offset = 0;
  while (offset < items.length) {
    const indexes = Array.from(
      { length: Math.min(concurrency, items.length - offset) },
      (_, index) => offset + index,
    );
    const settled = await Promise.allSettled(
      indexes.map((index) => worker(items[index], index)),
    );
    const retries: number[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index];
      const itemIndex = indexes[index];
      if (outcome.status === "fulfilled") results[itemIndex] = outcome.value;
      else if (telegramFloodWaitError(outcome.reason)) retries.push(itemIndex);
      else throw outcome.reason;
    }
    if (retries.length) {
      reducedByFlood = true;
      concurrency = 1;
      for (const itemIndex of retries)
        results[itemIndex] = await worker(items[itemIndex], itemIndex);
    }
    offset += indexes.length;
  }
  return {
    results,
    initialConcurrency,
    finalConcurrency: concurrency,
    reducedByFlood,
  };
}

function telegramTwitterCandidateHint(text: string) {
  for (const match of text.matchAll(
    /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=$|[/?#\s"'<>])/gi,
  )) {
    if (!TELEGRAM_TWITTER_RESERVED.has(match[1].toLowerCase())) return true;
  }
  for (const match of text.matchAll(
    /(?:^|[^\p{L}\p{N}_])#([A-Za-z0-9_]{4,15})(?![A-Za-z0-9_])/gu,
  )) {
    const value = match[1].toLowerCase();
    const prefix = text.slice(
      Math.max(0, Number(match.index || 0) - 16),
      Number(match.index || 0),
    );
    if (
      !TELEGRAM_TWITTER_TOPICS.has(value) &&
      !/^(?:adult|nsfw|porn|porno|sex|xxx)\d+$/i.test(value) &&
      !/传送门[\s：:→-]*$/u.test(prefix)
    )
      return true;
  }
  for (const match of text.matchAll(
    /(?:^|[^\p{L}\p{N}_])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gu,
  )) {
    const value = match[1].toLowerCase();
    if (!value.endsWith("_bot") && !TELEGRAM_TWITTER_RESERVED.has(value))
      return true;
  }
  return false;
}

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
  if (
    binding.historyMode === "from_date" &&
    binding.historyFrom &&
    message.messageDate
  ) {
    const messageTime = Date.parse(message.messageDate);
    const fromTime = Date.parse(binding.historyFrom);
    if (Number.isFinite(messageTime) && Number.isFinite(fromTime))
      return messageTime >= fromTime;
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
  const ids = input.messageIds
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const maxId = ids.length ? Math.max(...ids) : input.checkpoint;
  const minId = ids.length ? Math.min(...ids) : 0;
  const nextCheckpoint =
    input.mode === "incremental"
      ? Math.max(input.checkpoint, maxId)
      : input.checkpoint;
  return {
    maxId,
    minId,
    nextCheckpoint,
    targetId: Math.max(input.latestRemoteMessageId, maxId),
    incrementalCursor:
      input.mode === "incremental" && input.hasMore ? nextCheckpoint : 0,
    historyCursor: input.mode === "history" ? minId : 0,
  };
}

export function telegramDate(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric > 1e12 ? numeric : numeric * 1_000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function telegramHttpUrl(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function appendTelegramUrl(
  output: string[],
  seen: Set<string>,
  value: unknown,
) {
  const url = telegramHttpUrl(value);
  if (!url || seen.has(url)) return;
  seen.add(url);
  output.push(url);
}

function entityUrls(value: unknown, output: string[], seen: Set<string>) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    appendTelegramUrl(output, seen, (item as Record<string, unknown>).url);
  }
}

function buttonUrls(value: unknown, output: string[], seen: Set<string>) {
  if (!value || typeof value !== "object") return;
  const markup = value as Record<string, unknown>;
  const rows = Array.isArray(markup.rows)
    ? markup.rows
    : Array.isArray(markup.inline_keyboard)
      ? markup.inline_keyboard
      : [];
  for (const rowValue of rows) {
    const row =
      rowValue && typeof rowValue === "object"
        ? (rowValue as Record<string, unknown>)
        : {};
    const buttons = Array.isArray(row.buttons)
      ? row.buttons
      : Array.isArray(rowValue)
        ? rowValue
        : [];
    for (const button of buttons) {
      if (!button || typeof button !== "object") continue;
      appendTelegramUrl(output, seen, (button as Record<string, unknown>).url);
    }
  }
}

/**
 * Builds the exact text that enters the five tool rules. Telegram can hide a
 * URL behind rich text, an inline button, or a web-page preview; keeping only
 * the visible caption makes a real Bad.news/Haijiao post look empty.
 */
export function telegramMessageText(value: unknown) {
  const message =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const visible = [message.message, message.text, message.caption]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of visible.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    appendTelegramUrl(links, seen, match[0]);
  }
  entityUrls(message.entities, links, seen);
  entityUrls(message.captionEntities ?? message.caption_entities, links, seen);
  buttonUrls(message.replyMarkup ?? message.reply_markup, links, seen);
  const media =
    message.media && typeof message.media === "object"
      ? (message.media as Record<string, unknown>)
      : {};
  const webpage =
    media.webpage ??
    message.webpage ??
    message.webPreview ??
    message.link_preview_options;
  if (webpage && typeof webpage === "object") {
    const page = webpage as Record<string, unknown>;
    appendTelegramUrl(links, seen, page.url);
    appendTelegramUrl(links, seen, page.displayUrl ?? page.display_url);
  }
  const hidden = links.filter((url) => !visible.includes(url));
  return [visible, ...hidden].filter(Boolean).join("\n").slice(0, 100_000);
}

function flatten(value: unknown): string {
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    const label = flatten(item.text ?? item.caption ?? "");
    const href = String(item.href ?? item.url ?? "");
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
    const name = String(
      object.name ?? inherited?.name ?? "Telegram 官方导入",
    ).slice(0, 240);
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
        output.push({
          sourceKey: key,
          sourceName: name,
          messageId,
          messageDate: telegramDate(message.date ?? message.date_unixtime),
          text: telegramMessageText({
            ...message,
            text: flatten(message.text ?? message.caption ?? ""),
          })
            .trim()
            .slice(0, 100_000),
          connectionId: "telegram-import",
          chatType: "import",
          eventKind: "message",
        });
      }
    }
    for (const child of Object.values(object)) {
      if (child === ownMessages) continue;
      if (Array.isArray(child))
        child.forEach((entry) => visit(entry, { key, name }));
      else if (child && typeof child === "object") visit(child, { key, name });
    }
  };
  visit(value);
  return output;
}

export function telegramBotUpdates(value: unknown) {
  const object =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const results = Array.isArray(object.result) ? object.result : [];
  const messages: TelegramImportMessage[] = [];
  let nextOffset = 0;
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const update = raw as Record<string, unknown>;
    nextOffset = Math.max(nextOffset, Number(update.update_id ?? 0) + 1);
    const edited = Boolean(update.edited_message ?? update.edited_channel_post);
    const message = (update.message ??
      update.channel_post ??
      update.edited_message ??
      update.edited_channel_post) as Record<string, unknown> | undefined;
    const chat = message?.chat as Record<string, unknown> | undefined;
    if (!message || !chat || message.message_id === undefined) continue;
    const chatType = String(chat.type ?? "");
    if (!["group", "supergroup", "channel"].includes(chatType)) continue;
    const sourceKey = String(chat.id ?? "");
    const sourceName = String(
      chat.title ??
        chat.username ??
        [chat.first_name, chat.last_name].filter(Boolean).join(" ") ??
        sourceKey,
    ).slice(0, 240);
    const body = telegramMessageText(message);
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
