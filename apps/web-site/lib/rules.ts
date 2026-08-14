import type { ToolId, ToolResult } from "./types";

export type InputDocument = {
  name: string;
  text: string;
  sourceKind?: string;
  sourceName?: string;
  connectionId?: string;
  sourceId?: string;
  messageId?: string;
  messageDate?: string;
  eventKind?: string;
};

export type InputMessage = {
  text: string;
  links: string[];
  messageDate: string;
  sourceType: string;
  source: string;
  sourceKind: string;
  sourceName: string;
  connectionId: string;
  sourceId: string;
  messageId: string;
  eventKind: string;
};

export type ProcessingStats = {
  inputFileCount: number;
  parsedFileCount: number;
  failedFileCount: number;
  parsedMessageCount: number;
  inRangeMessageCount: number;
  candidateCount: number;
  resultCount: number;
  duplicateCount: number;
  ruleExcludedCount: number;
  errorCount: number;
};

export type FileParseOutcome = {
  name: string;
  ok: boolean;
  messageCount: number;
  error: string;
};

export type MessageProcessingOutcome = {
  sourceId: string;
  messageId: string;
  sourceName: string;
  candidateCount: number;
  candidatePreview: string;
  status: "processed" | "processed_empty" | "error";
  error: string;
  resultKeys: string[];
};

export type ProcessingOutput = {
  allMessages: InputMessage[];
  messages: InputMessage[];
  results: ToolResult[];
  stats: ProcessingStats;
  fileOutcomes: FileParseOutcome[];
  messageResults: MessageProcessingOutcome[];
};

type RuleCandidate = {
  resultKey: string;
  primaryValue: string;
  secondaryValue: string;
  originalValue: string;
  canonicalValue: string;
  index: number;
  metadata?: Record<string, unknown>;
};

type RuleScan = {
  candidates: RuleCandidate[];
  discovered: number;
  excluded: number;
};

const TWITTER_RESERVED = new Set([
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
const TWITTER_TOPIC_TAGS = new Set([
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
const HAIJIAO_CATEGORIES = [
  "hjjd",
  "hjmz",
  "hjyc",
  "hjfn",
  "hjsz",
  "hjrq",
  "hjhj",
] as const;
const HAIJIAO_CATEGORY_PATTERN = HAIJIAO_CATEGORIES.join("|");
const NOISE_PREFIXES = new Set([
  "MESSAGE",
  "MESSAGES",
  "USERPIC",
  "MEDIA",
  "VIDEO",
  "PHOTO",
  "AVATAR",
  "PAGINATION",
  "DETAILS",
  "STATUS",
  "TITLE",
  "BODY",
  "CLASS",
  "STYLE",
  "DATE",
  "HTML",
  "BUTTON",
  "INPUT",
  "IMAGE",
  "THUMB",
  "THUMBNAIL",
  "AV",
  "TOP",
  "BEST",
  "FUCK",
  "MOODYZ",
  "TAMEIKE",
  "ALL",
  "PDF",
  "TELEGRAM",
  "LOGO",
  "JOHREN",
  "IEOR",
  "PROBABILITY",
  "STATISTICS",
  "PYTHON",
  "OFFICE",
  "GITHUB",
  "SERIES",
  "WEIXIN",
  "RESULT",
  "RELATED",
  "THREAD",
  "XIUREN",
  "WXSYNC",
  "JAVA",
  "LARGE",
  "RJ",
  "NO",
  "PRO",
  "YOUPORN",
  "TV",
]);
const DATE_PREFIXES = new Set([
  "JAN",
  "JANUARY",
  "FEB",
  "FEBRUARY",
  "MAR",
  "MARCH",
  "APR",
  "APRIL",
  "MAY",
  "JUN",
  "JUNE",
  "JUL",
  "JULY",
  "AUG",
  "AUGUST",
  "SEP",
  "SEPT",
  "SEPTEMBER",
  "OCT",
  "OCTOBER",
  "NOV",
  "NOVEMBER",
  "DEC",
  "DECEMBER",
]);
const TRUSTED_AV_HOSTS = [
  "missav.ai",
  "missav.ws",
  "123av.com",
  "avbase.net",
  "javdb.com",
  "javbus.com",
  "javlibrary.com",
  "supjav.com",
  "njav.tv",
  "jable.tv",
  "jav.guru",
];
const URL_PATTERN = /https?:\/\/[^\s"'<>)]*/gi;
const TWITTER_HASH_PATTERN =
  /(?:^|[^\p{L}\p{N}_])#([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gu;
const TWITTER_MENTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gu;
const TWITTER_URL_PATTERN =
  /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=$|[/?#\s"'<>])/gi;
const BADNEWS_PATTERN =
  /https?:\/\/(?:www\.)?bad\.news\/t\/\d+(?:[/?#][^\s"'<>]*)?/gi;
const HAIJIAO_PATTERN = new RegExp(
  `https?:\\/\\/(?:www\\.)?haijiaolove\\.xyz\\/(?:${HAIJIAO_CATEGORY_PATTERN})\\/\\d+\\.html(?:[/?#][^\\s"'<>]*)?`,
  "gi",
);
const FC2_PATTERN =
  /(^|[^A-Za-z0-9])FC2(?:[ \t_-]*PPV)?[ \t_-]*(\d{4,10})(?=$|[^A-Za-z0-9])/gi;
const SEPARATED_CODE_PATTERN =
  /(^|[^A-Za-z0-9])([A-Za-z]{2,8})[ \t_-]+(\d{2,5})(?=$|[^A-Za-z0-9])/g;
const COMPACT_CODE_PATTERN =
  /(^|[^A-Za-z0-9])([A-Z]{2,8})(\d{2,5})(?=$|[^A-Za-z0-9])/g;

function decodeLooseText(text: string) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function stripHtml(value: string) {
  return decodeLooseText(
    String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlAttribute(tag: string, name: string) {
  const match = String(tag || "").match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  return decodeLooseText(match?.[1] ?? match?.[2] ?? "");
}

function uniqueLinks(values: string[]) {
  const seen = new Set<string>();
  return values
    .map((value) => String(value || "").trim())
    .filter((value) => {
      if (!/^https?:\/\//i.test(value) || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function baseMessage(
  document: InputDocument,
  values: Partial<InputMessage>,
): InputMessage {
  const sourceType = String(
    values.sourceType || document.sourceKind || "manual",
  );
  const sourceName = String(
    values.sourceName || document.sourceName || document.name || "手动输入",
  );
  return {
    text: String(values.text || ""),
    links: uniqueLinks(values.links || []),
    messageDate: String(values.messageDate || document.messageDate || ""),
    sourceType,
    source: sourceName,
    sourceKind: String(values.sourceKind || document.sourceKind || sourceType),
    sourceName,
    connectionId: String(values.connectionId || document.connectionId || ""),
    sourceId: String(values.sourceId || document.sourceId || ""),
    messageId: String(values.messageId || document.messageId || ""),
    eventKind: String(values.eventKind || document.eventKind || "message"),
  };
}

function flattenTelegramText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(flattenTelegramText).join("");
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return flattenTelegramText(
    record.text ?? record.caption ?? record.file_name ?? "",
  );
}

function collectRichLinks(
  value: unknown,
  output: string[],
  seen = new Set<unknown>(),
) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRichLinks(item, output, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["href", "url", "displayUrl", "display_url"]) {
    const candidate = String(record[key] || "").trim();
    if (/^https?:\/\//i.test(candidate)) output.push(candidate);
  }
  for (const child of Object.values(record))
    collectRichLinks(child, output, seen);
}

function collectJsonMessages(
  value: unknown,
  document: InputDocument,
  output: InputMessage[],
  seen = new Set<unknown>(),
) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.messages)) {
    for (const item of object.messages) {
      if (!item || typeof item !== "object") continue;
      const message = item as Record<string, unknown>;
      const text = [
        flattenTelegramText(message.text),
        flattenTelegramText(message.caption),
      ]
        .filter(Boolean)
        .join("\n");
      const links: string[] = [...text.matchAll(URL_PATTERN)].map(
        (match) => match[0],
      );
      collectRichLinks(message, links);
      const eventKind = String(message.type || "message")
        .toLowerCase()
        .includes("service")
        ? "service"
        : String(message.event_kind || "message");
      if (eventKind === "service") continue;
      output.push(
        baseMessage(document, {
          text,
          links,
          messageDate: String(message.date ?? message.date_unixtime ?? ""),
          sourceType: "export_json",
          sourceKind: "export_json",
          messageId: String(message.id ?? ""),
          eventKind,
        }),
      );
    }
  }
  for (const child of Object.values(object))
    if (child !== object.messages)
      collectJsonMessages(child, document, output, seen);
}

function parseHtmlMessages(
  raw: string,
  document: InputDocument,
): InputMessage[] {
  const boundary =
    /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bmessage\b[^"]*"|'[^']*\bmessage\b[^']*')[^>]*\bid\s*=\s*(?:"message(-?\d+)"|'message(-?\d+)')[^>]*>/gi;
  const matches = [...raw.matchAll(boundary)];
  if (!matches.length) return [];
  const output: InputMessage[] = [];
  matches.forEach((match, index) => {
    if (
      /\bclass\s*=\s*(?:"[^"]*\bservice\b[^"]*"|'[^']*\bservice\b[^']*')/i.test(
        match[0],
      )
    )
      return;
    const start = match.index || 0;
    const end =
      index + 1 < matches.length ? matches[index + 1].index : raw.length;
    const segment = raw.slice(start, end);
    const links = [
      ...segment.matchAll(
        /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi,
      ),
    ].map((item) => decodeLooseText(item[1] || item[2] || ""));
    const dateTag =
      segment.match(
        /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bdate\b[^"]*"|'[^']*\bdate\b[^']*')[^>]*>/i,
      )?.[0] || "";
    const textMatch = segment.match(
      /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\btext\b[^"]*"|'[^']*\btext\b[^']*')[^>]*>([\s\S]*?)(?=<\/div>)/i,
    );
    output.push(
      baseMessage(document, {
        text: stripHtml(textMatch?.[1] || segment),
        links,
        messageDate:
          htmlAttribute(dateTag, "title") ||
          htmlAttribute(dateTag, "data-time"),
        sourceType: "export_html",
        sourceKind: "export_html",
        messageId: match[1] || match[2] || String(index + 1),
      }),
    );
  });
  return output;
}

export function parseDocument(document: InputDocument): InputMessage[] {
  const text = String(document.text || "").replace(/^\uFEFF/, "");
  const trimmed = text.trim();
  if (!trimmed) return [];
  const isJsonFile = /\.json$/i.test(document.name);
  if (isJsonFile || /^\s*[\[{]/.test(trimmed)) {
    try {
      const output: InputMessage[] = [];
      collectJsonMessages(JSON.parse(trimmed), document, output);
      if (output.length) return output;
      if (isJsonFile) throw new Error("JSON 中没有可识别的 messages[] 消息");
    } catch (error) {
      if (isJsonFile)
        throw new Error(
          error instanceof Error ? error.message : "JSON 解析失败",
        );
    }
  }
  if (/<html[\s>]|class=["'][^"']*message/i.test(trimmed)) {
    const messages = parseHtmlMessages(text, document);
    if (messages.length) return messages;
  }
  const sourceType =
    document.sourceKind ||
    (/\.(?:txt|html?|md|csv|log)$/i.test(document.name)
      ? "manual_file"
      : "manual");
  return [
    baseMessage(document, {
      text,
      links: [...text.matchAll(URL_PATTERN)].map((match) => match[0]),
      sourceType,
      sourceKind: sourceType,
    }),
  ];
}

export function parseTelegramDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{9,16}$/.test(text)) {
    const numeric = Number(text);
    const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const telegram = text.match(
    /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+UTC([+-])(\d{2}):?(\d{2})$/i,
  );
  if (telegram) {
    const [
      ,
      day,
      month,
      year,
      hour,
      minute,
      second = "0",
      sign,
      offsetHour,
      offsetMinute,
    ] = telegram;
    const offset =
      (Number(offsetHour) * 60 + Number(offsetMinute)) *
      (sign === "+" ? 1 : -1);
    const date = new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ) -
        offset * 60_000,
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function filterByTime(messages: InputMessage[], start = "", end = "") {
  const startDate = start ? new Date(start) : null;
  const endDate = end ? new Date(end) : null;
  if (startDate && Number.isNaN(startDate.getTime()))
    throw new Error("开始时间无效");
  if (endDate && Number.isNaN(endDate.getTime()))
    throw new Error("结束时间无效");
  if (endDate && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(end))
    endDate.setSeconds(59, 999);
  if (startDate && endDate && startDate > endDate)
    throw new Error("开始时间不能晚于结束时间");
  return messages.filter((message) => {
    const date = parseTelegramDate(message.messageDate);
    if (!date)
      return !(
        (startDate || endDate) &&
        /^(?:export_|api|bot_|telegram)/i.test(message.sourceType)
      );
    return !(startDate && date < startDate) && !(endDate && date > endDate);
  });
}

function messageText(message: InputMessage) {
  const text = String(message.text || "");
  return [text, ...message.links.filter((link) => !text.includes(link))]
    .filter(Boolean)
    .join("\n");
}

function messageIdentity(message: InputMessage) {
  const source =
    message.sourceId || `${message.sourceKind}:${message.sourceName}`;
  return [source, message.messageId || message.messageDate || "undated"]
    .filter(Boolean)
    .join(":");
}

function validHandle(value: string) {
  const handle = String(value || "")
    .trim()
    .replace(/^[@#]/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) &&
    !TWITTER_RESERVED.has(handle.toLowerCase())
    ? handle
    : "";
}

function twitterScan(message: InputMessage): RuleScan {
  const text = messageText(message);
  const candidates: RuleCandidate[] = [];
  let discovered = 0;
  let excluded = 0;
  const add = (
    value: string,
    original: string,
    index: number,
    kind: string,
  ) => {
    discovered += 1;
    const handle = validHandle(value);
    if (!handle) {
      excluded += 1;
      return;
    }
    candidates.push({
      resultKey: handle.toLowerCase(),
      primaryValue: handle,
      secondaryValue: `https://x.com/${handle}`,
      originalValue: original,
      canonicalValue: handle,
      index,
      metadata: { candidateKind: kind, profileUrl: `https://x.com/${handle}` },
    });
  };
  for (const match of text.matchAll(TWITTER_HASH_PATTERN)) {
    const index = Number(match.index || 0) + match[0].lastIndexOf("#");
    const prefix = text.slice(Math.max(0, index - 24), index);
    discovered += 1;
    const handle = validHandle(match[1]);
    const topic = handle.toLowerCase();
    if (
      !handle ||
      handle.length < 4 ||
      TWITTER_TOPIC_TAGS.has(topic) ||
      /^(?:adult|nsfw|porn|porno|sex|xxx)\d+$/i.test(topic) ||
      /传送门[\s：:→-]*$/u.test(prefix)
    ) {
      excluded += 1;
      continue;
    }
    candidates.push({
      resultKey: handle.toLowerCase(),
      primaryValue: handle,
      secondaryValue: `https://x.com/${handle}`,
      originalValue: `#${match[1]}`,
      canonicalValue: handle,
      index,
      metadata: {
        candidateKind: "hashtag",
        profileUrl: `https://x.com/${handle}`,
      },
    });
  }
  for (const match of text.matchAll(TWITTER_MENTION_PATTERN)) {
    if (/_bot$/i.test(match[1])) {
      discovered += 1;
      excluded += 1;
      continue;
    }
    add(
      match[1],
      `@${match[1]}`,
      Number(match.index || 0) + match[0].lastIndexOf("@"),
      "mention",
    );
  }
  for (const match of text.matchAll(TWITTER_URL_PATTERN))
    add(match[1], match[0], Number(match.index || 0), "profile_url");
  return {
    candidates: candidates.sort((a, b) => a.index - b.index),
    discovered,
    excluded,
  };
}

function canonicalBadNewsUrl(value: string) {
  const match = String(value || "").match(
    /https?:\/\/(?:www\.)?bad\.news\/t\/(\d+)(?=$|[/?#\s"'<>])/i,
  );
  return match ? `https://bad.news/t/${match[1]}` : "";
}

function canonicalHaijiaoUrl(value: string) {
  const match = String(value || "").match(
    new RegExp(
      `https?:\\/\\/(?:www\\.)?haijiaolove\\.xyz\\/(${HAIJIAO_CATEGORY_PATTERN})\\/(\\d+)\\.html(?=$|[/?#\\s"'<>])`,
      "i",
    ),
  );
  if (!match) return "";
  return `https://www.haijiaolove.xyz/${match[1].toLowerCase()}/${match[2]}.html`;
}

function linkScan(
  message: InputMessage,
  tool: "badnews" | "haijiao",
): RuleScan {
  const text = messageText(message);
  const candidates: RuleCandidate[] = [];
  const allUrls = [...text.matchAll(URL_PATTERN)];
  const pattern = tool === "badnews" ? BADNEWS_PATTERN : HAIJIAO_PATTERN;
  for (const match of text.matchAll(pattern)) {
    const canonical =
      tool === "badnews"
        ? canonicalBadNewsUrl(match[0])
        : canonicalHaijiaoUrl(match[0]);
    if (!canonical) continue;
    const metadata: Record<string, unknown> = { url: canonical };
    if (tool === "haijiao") {
      const parts = canonical.match(/\/([^/]+)\/(\d+)\.html$/);
      metadata.category = parts?.[1] || "";
      metadata.postId = parts?.[2] || "";
    }
    candidates.push({
      resultKey: canonical,
      primaryValue: canonical,
      secondaryValue: "",
      originalValue: match[0],
      canonicalValue: canonical,
      index: Number(match.index || 0),
      metadata,
    });
  }
  return {
    candidates: candidates.sort((a, b) => a.index - b.index),
    discovered: allUrls.length,
    excluded: Math.max(0, allUrls.length - candidates.length),
  };
}

export function normalizeCode(value: string) {
  let text = String(value || "").trim();
  if (
    /^https?:\/\//i.test(text) ||
    /-(chinese-subtitle|uncensored-leak(?:ed)?)$/i.test(text)
  ) {
    const fromUrl = extractCodeFromUrl(text);
    if (fromUrl) return fromUrl;
  }
  text = decodeLooseText(text).toUpperCase().replace(/\s+/g, "");
  const fc2 = text.match(/^FC2[_-]?(?:PPV[_-]?)?(\d{4,10})$/i);
  if (fc2) return `FC2-PPV-${fc2[1]}`;
  const normal = text.match(/^([A-Z]{2,8})[-_]?(\d{2,5})$/);
  return normal ? `${normal[1]}-${normal[2]}` : text;
}

function extractCodeFromUrl(input: string) {
  let slug = String(input || "").trim();
  try {
    slug = new URL(slug).pathname.split("/").filter(Boolean).at(-1) || "";
  } catch {
    slug = slug.split(/[?#]/)[0].split("/").filter(Boolean).at(-1) || slug;
  }
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* keep raw slug */
  }
  slug = slug
    .replace(/-chinese-subtitle$/i, "")
    .replace(/-uncensored-leak(?:ed)?$/i, "")
    .replace(/[_\s]+/g, "-")
    .trim();
  const fc2 = slug.match(/^fc2(?:-?ppv)?-?(\d{4,10})$/i);
  if (fc2) return `FC2-PPV-${fc2[1]}`;
  const normal = slug.match(/^(?:\d{1,4})?([a-z]{2,8})-?(\d{2,5})$/i);
  return normal ? `${normal[1].toUpperCase()}-${normal[2]}` : "";
}

function codeKey(code: string) {
  return normalizeCode(code).replace(/-/g, "").toLowerCase();
}

function isNoiseCode(code: string) {
  const match = code.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return false;
  const prefix = match[1];
  const number = Number(match[2]);
  if (NOISE_PREFIXES.has(prefix)) return true;
  if (DATE_PREFIXES.has(prefix) && number >= 1900 && number <= 2099)
    return true;
  return (
    ["SPRING", "SUMMER", "FALL", "AUTUMN", "WINTER"].includes(prefix) &&
    number >= 1900 &&
    number <= 2099
  );
}

function isCode(code: string, trusted = false) {
  if (!/^(FC2-PPV-\d{4,10}|[A-Z]{2,8}-\d{2,5})$/.test(code)) return false;
  return trusted || (!/^PPV-/.test(code) && !isNoiseCode(code));
}

function trustedHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return TRUSTED_AV_HOSTS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function codesFromTrustedUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.replace(/[.,;!?，。；！？]+$/, ""));
  } catch {
    return [] as string[];
  }
  if (!trustedHost(url.hostname)) return [];
  const output: string[] = [];
  const exact = extractCodeFromUrl(url.href);
  if (isCode(exact, true)) output.push(exact);
  let source = url.pathname;
  try {
    source = decodeURIComponent(source);
  } catch {
    /* keep encoded path */
  }
  for (const match of source.matchAll(
    /(?:^|[^a-z0-9])fc2(?:[\s_-]*ppv)?[\s_-]*(\d{4,10})(?=$|[^0-9])/gi,
  ))
    output.push(`FC2-PPV-${match[1]}`);
  for (const match of source.matchAll(
    /(?:^|[^a-z])([a-z]{2,8})[\s_-]+(\d{2,5})(?=$|[^0-9])/gi,
  )) {
    const code = normalizeCode(`${match[1]}-${match[2]}`);
    if (isCode(code)) output.push(code);
  }
  return [...new Set(output)];
}

function trustedSiteUrl(value: string, tool: ToolId) {
  try {
    const url = new URL(value.replace(/[.,;!?，。；！？]+$/, ""));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const domains =
      tool === "av123" ? ["123av.com"] : ["missav.ai", "missav.ws"];
    if (
      !domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
    )
      return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function maskNoise(text: string) {
  const blank = (match: string) => match.replace(/[^\r\n]/g, " ");
  return text
    .replace(URL_PATTERN, blank)
    .replace(/<[^>]*>/g, blank)
    .replace(/\b\d{1,5}\s*[×x]\s*\d{1,5}\b/gi, blank)
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:bytes?|[kmgt]i?b)\b/gi, blank)
    .replace(/\bview\s+results\s+page\b/gi, blank)
    .replace(/\b(?:powered\s+by\s+)?whos\.tv\b/gi, blank)
    .replace(/\bmissav\s+daily\b/gi, blank)
    .replace(/\buncensored[\s_-]+leak(?:ed)?\b/gi, blank)
    .replace(/@\s*[a-z][a-z0-9_]{1,31}/gi, blank)
    .replace(/\b[a-z][a-z0-9_]{1,31}\s+\d{1,2}\s*(?:岁|years?\s+old)/gi, blank)
    .replace(
      /\b[a-z][a-z0-9_]{1,31}\s+\d{1,3}\s*(?:秒|分钟|小时|小時|天)前/gi,
      blank,
    );
}

function avScan(message: InputMessage, tool: "missav" | "av123"): RuleScan {
  const text = messageText(message);
  const decoded = decodeLooseText(text);
  const candidates: RuleCandidate[] = [];
  let discovered = 0;
  let excluded = 0;
  const add = (
    rawCode: string,
    original: string,
    index: number,
    trusted: boolean,
    sourceUrl = "",
  ) => {
    discovered += 1;
    const code = normalizeCode(rawCode);
    if (!isCode(code, trusted)) {
      excluded += 1;
      return;
    }
    candidates.push({
      resultKey: codeKey(code),
      primaryValue: code,
      secondaryValue: sourceUrl,
      originalValue: original,
      canonicalValue: code,
      index,
      metadata: {
        normalization: /^FC2/.test(code)
          ? "fc2"
          : trusted
            ? "trusted_url"
            : "visible_text",
        trustedUrl: sourceUrl,
      },
    });
  };
  for (const match of decoded.matchAll(URL_PATTERN)) {
    const codes = codesFromTrustedUrl(match[0]);
    if (!codes.length) continue;
    const exactSource = trustedSiteUrl(match[0], tool);
    for (const code of codes)
      add(code, match[0], Number(match.index || 0), true, exactSource);
  }
  const visible = maskNoise(decoded);
  for (const match of visible.matchAll(FC2_PATTERN))
    add(
      `FC2-PPV-${match[2]}`,
      match[0].slice(match[1].length).trim(),
      (match.index || 0) + match[1].length,
      false,
    );
  for (const match of visible.matchAll(SEPARATED_CODE_PATTERN))
    add(
      `${match[2]}-${match[3]}`,
      match[0].slice(match[1].length).trim(),
      (match.index || 0) + match[1].length,
      false,
    );
  for (const match of visible.matchAll(COMPACT_CODE_PATTERN))
    add(
      `${match[2]}-${match[3]}`,
      match[0].slice(match[1].length).trim(),
      (match.index || 0) + match[1].length,
      false,
    );
  candidates.sort((a, b) => a.index - b.index);
  return { candidates, discovered, excluded };
}

function scanMessage(tool: ToolId, message: InputMessage): RuleScan {
  if (tool === "twitter") return twitterScan(message);
  if (tool === "badnews" || tool === "haijiao") return linkScan(message, tool);
  return avScan(message, tool);
}

function resultFromCandidate(
  tool: ToolId,
  candidate: RuleCandidate,
  message: InputMessage,
): ToolResult {
  const status =
    tool === "av123" ? "task_ready" : tool === "missav" ? "pending" : "success";
  return {
    resultKey: candidate.resultKey,
    primaryValue: candidate.primaryValue,
    secondaryValue: candidate.secondaryValue,
    status,
    tags: [],
    source: message.sourceName,
    metadata: {
      ...(candidate.metadata || {}),
      sourceKind: message.sourceKind,
      sourceName: message.sourceName,
      connectionId: message.connectionId,
      sourceId: message.sourceId,
      messageId: message.messageId,
      messageDate: message.messageDate,
      originalValue: candidate.originalValue,
      canonicalValue: candidate.canonicalValue,
      sourceCount: 1,
      sourceIdentity: messageIdentity(message),
      additionalSourceIds: [],
    },
  };
}

export function processMessages(
  tool: ToolId,
  messages: InputMessage[],
): Omit<ProcessingOutput, "allMessages" | "messages" | "fileOutcomes"> & {
  results: ToolResult[];
} {
  const unique = new Map<string, ToolResult>();
  const messageResults: MessageProcessingOutcome[] = [];
  let candidateCount = 0;
  let duplicateCount = 0;
  let ruleExcludedCount = 0;
  let errorCount = 0;
  for (const message of messages) {
    try {
      const scan = scanMessage(tool, message);
      candidateCount += scan.discovered;
      ruleExcludedCount += scan.excluded;
      const messageKeys: string[] = [];
      for (const candidate of scan.candidates) {
        const key = candidate.resultKey.toLowerCase();
        messageKeys.push(key);
        const existing = unique.get(key);
        if (!existing) {
          unique.set(key, resultFromCandidate(tool, candidate, message));
          continue;
        }
        duplicateCount += 1;
        const metadata = existing.metadata || {};
        const additional = Array.isArray(metadata.additionalSourceIds)
          ? metadata.additionalSourceIds.map(String)
          : [];
        const identity = messageIdentity(message);
        const firstIdentity = String(metadata.sourceIdentity || "");
        const isAdditionalSource =
          Boolean(identity) &&
          identity !== firstIdentity &&
          !additional.includes(identity);
        if (isAdditionalSource) additional.push(identity);
        existing.metadata = {
          ...metadata,
          sourceCount:
            Number(metadata.sourceCount || 1) + (isAdditionalSource ? 1 : 0),
          additionalSourceIds: additional.slice(0, 100),
        };
      }
      const preview = scan.candidates
        .slice(0, 5)
        .map((item) =>
          item.secondaryValue
            ? `${item.primaryValue} → ${item.secondaryValue}`
            : item.primaryValue,
        )
        .join("；");
      messageResults.push({
        sourceId: message.sourceId,
        messageId: message.messageId,
        sourceName: message.sourceName,
        candidateCount: scan.candidates.length,
        candidatePreview: preview,
        status: scan.candidates.length ? "processed" : "processed_empty",
        error: "",
        resultKeys: [...new Set(messageKeys)],
      });
    } catch (error) {
      errorCount += 1;
      messageResults.push({
        sourceId: message.sourceId,
        messageId: message.messageId,
        sourceName: message.sourceName,
        candidateCount: 0,
        candidatePreview: "",
        status: "error",
        error: error instanceof Error ? error.message : "规则处理失败",
        resultKeys: [],
      });
    }
  }
  const results = [...unique.values()];
  return {
    results,
    stats: {
      inputFileCount: 0,
      parsedFileCount: 0,
      failedFileCount: 0,
      parsedMessageCount: messages.length,
      inRangeMessageCount: messages.length,
      candidateCount,
      resultCount: results.length,
      duplicateCount,
      ruleExcludedCount,
      errorCount,
    },
    messageResults,
  };
}

export function processDocuments(
  tool: ToolId,
  documents: InputDocument[],
  start = "",
  end = "",
): ProcessingOutput {
  const allMessages: InputMessage[] = [];
  const fileOutcomes: FileParseOutcome[] = [];
  for (const document of documents) {
    try {
      const parsed = parseDocument(document);
      allMessages.push(...parsed);
      fileOutcomes.push({
        name: document.name,
        ok: true,
        messageCount: parsed.length,
        error: "",
      });
    } catch (error) {
      fileOutcomes.push({
        name: document.name,
        ok: false,
        messageCount: 0,
        error: error instanceof Error ? error.message : "文件解析失败",
      });
    }
  }
  const messages = filterByTime(allMessages, start, end);
  const processed = processMessages(tool, messages);
  const fileDocuments = documents.filter(
    (document) => document.name !== "粘贴文本",
  );
  const failedFileNames = new Set(
    fileOutcomes.filter((item) => !item.ok).map((item) => item.name),
  );
  const parsedFileCount = fileDocuments.filter(
    (document) => !failedFileNames.has(document.name),
  ).length;
  return {
    allMessages,
    messages,
    results: processed.results,
    messageResults: processed.messageResults,
    fileOutcomes,
    stats: {
      ...processed.stats,
      inputFileCount: fileDocuments.length,
      parsedFileCount,
      failedFileCount: fileDocuments.length - parsedFileCount,
      parsedMessageCount: allMessages.length,
      inRangeMessageCount: messages.length,
    },
  };
}

export function parseCodeList(input: string) {
  const message = baseMessage(
    { name: "手动文本", text: input },
    {
      text: input,
      links: [...String(input || "").matchAll(URL_PATTERN)].map(
        (match) => match[0],
      ),
      sourceType: "manual",
    },
  );
  const scan = avScan(message, "missav");
  const seen = new Set<string>();
  return scan.candidates
    .filter((candidate) => {
      if (seen.has(candidate.resultKey)) return false;
      seen.add(candidate.resultKey);
      return true;
    })
    .map((candidate) => candidate.primaryValue);
}

export function candidateSummary(
  tool: ToolId,
  text: string,
  sourceName = "Telegram",
) {
  const message = baseMessage(
    { name: sourceName, text, sourceKind: "telegram" },
    {
      text,
      links: [...String(text || "").matchAll(URL_PATTERN)].map(
        (match) => match[0],
      ),
      sourceType: "telegram",
    },
  );
  const scan = scanMessage(tool, message);
  return {
    count: scan.candidates.length,
    preview: scan.candidates
      .slice(0, 5)
      .map((item) =>
        item.secondaryValue
          ? `${item.primaryValue} → ${item.secondaryValue}`
          : item.primaryValue,
      )
      .join("；"),
  };
}

export function parseList(text: string) {
  return [
    ...new Set(
      String(text || "")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n|[,，]/)
        .map((value) => value.trim().slice(0, 120))
        .filter(Boolean),
    ),
  ];
}

export function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  row.push(value.replace(/\r$/, ""));
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
