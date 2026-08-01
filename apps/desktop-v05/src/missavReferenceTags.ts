import defaultReferenceTagsRaw from "./assets/missav-reference-actress-tags.txt?raw";
import typeBoundaryTagsRaw from "./assets/missav-type-boundary-tags.txt?raw";

export const MISSAV_REFERENCE_TAGS_SETTING = "missav.referenceActressTags";
export const MISSAV_REFERENCE_TAG_BLACKLIST_SETTING = "missav.referenceActressTagBlacklist";
export const MISSAV_RAINDROP_EXPORT_TAG_BLACKLIST_SETTING = "missav.raindropExportActressTagBlacklist";

export interface MissavReferenceTagLibrary {
  tags: string[];
  sourceName: string;
  updatedAt: string;
  bookmarkCount: number;
}

export interface ReferenceTagExtraction {
  tags: string[];
  bookmarkCount: number;
  taggedBookmarkCount: number;
  uniqueSourceTags: number;
  blacklistedTagCount: number;
}

const SYSTEM_TAGS = new Set([
  "未知女优", "#未知女优", "需要查找", "已存在", "重复输入",
]);

const EXPLICIT_TYPE_TAGS = new Set([
  "教师", "女优", "女優", "演员", "演員", "VR",
]);

const TYPE_BOUNDARY_TAGS = new Set(parseLines(typeBoundaryTagsRaw));

function parseLines(value: string): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const line of String(value || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const tag = normalizeReferenceTag(line);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    output.push(tag);
  }
  return output;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function normalizeReferenceTag(value: unknown): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function normalizeReferenceTags(values: Iterable<unknown>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = normalizeReferenceTag(value);
    if (!tag || SYSTEM_TAGS.has(tag) || TYPE_BOUNDARY_TAGS.has(tag) || EXPLICIT_TYPE_TAGS.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    output.push(tag);
  }
  return output;
}

export function referenceTagsFromText(value: string): string[] {
  return normalizeReferenceTags(String(value || "").split(/\r?\n/));
}

export function referenceTagsToText(values: Iterable<unknown>): string {
  return normalizeReferenceTags(values).join("\n");
}

export function normalizeReferenceTagBlacklist(values: Iterable<unknown>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = normalizeReferenceTag(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    output.push(tag);
  }
  return output;
}

export function referenceTagBlacklistFromText(value: string): string[] {
  return normalizeReferenceTagBlacklist(String(value || "").split(/\r?\n/));
}

export function referenceTagBlacklistToText(values: Iterable<unknown>): string {
  return normalizeReferenceTagBlacklist(values).join("\n");
}

export function applyReferenceTagBlacklist(values: Iterable<unknown>, blacklistValues: Iterable<unknown>): string[] {
  const blacklist = new Set(normalizeReferenceTagBlacklist(blacklistValues));
  return normalizeReferenceTags(values).filter((tag) => !blacklist.has(tag));
}

function isTypeBoundary(tag: string): boolean {
  return SYSTEM_TAGS.has(tag) || TYPE_BOUNDARY_TAGS.has(tag) || EXPLICIT_TYPE_TAGS.has(tag);
}

function looksLikeActressTag(tag: string): boolean {
  if (!tag || isTypeBoundary(tag) || /\s/.test(tag) || tag.length > 120) return false;
  if (/https?:|www\.|\.com|\.ai/i.test(tag) || /\d/.test(tag)) return false;
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(tag) || /^[A-Za-z][A-Za-z.'_-]{1,39}$/.test(tag);
}

function extractTagRows(html: string): string[][] {
  const rows: string[][] = [];
  const pattern = /\bTAGS\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const raw = decodeHtmlAttribute(match[1] ?? match[2] ?? "");
    rows.push(raw.split(",").map(normalizeReferenceTag).filter(Boolean));
  }
  return rows;
}

export function extractReferenceActressTagsFromHtml(
  html: string,
  knownTags: Iterable<unknown> = [],
  blacklistValues: Iterable<unknown> = [],
): ReferenceTagExtraction {
  if (!/<!DOCTYPE\s+NETSCAPE-Bookmark-file-1|<A\b/i.test(html)) {
    throw new Error("所选文件不是可识别的书签 HTML。");
  }
  const rows = extractTagRows(html);
  if (!rows.length) throw new Error("HTML 中没有找到带 TAGS 属性的书签记录。");

  const known = new Set(normalizeReferenceTags(knownTags));
  const extracted = new Set<string>();
  const sourceTags = new Set<string>();
  let taggedBookmarkCount = 0;

  for (const tags of rows) {
    if (tags.length) taggedBookmarkCount += 1;
    for (const tag of tags) {
      sourceTags.add(tag);
      if (known.has(tag)) extracted.add(tag);
    }
    for (const tag of tags) {
      if (isTypeBoundary(tag) || !looksLikeActressTag(tag)) break;
      extracted.add(tag);
    }
  }

  const unfilteredTags = normalizeReferenceTags(extracted);
  const tags = applyReferenceTagBlacklist(unfilteredTags, blacklistValues)
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  if (!tags.length) throw new Error("没有从 HTML 中识别出女优 Tag；原参考库未被修改。");
  return {
    tags,
    bookmarkCount: rows.length,
    taggedBookmarkCount,
    uniqueSourceTags: sourceTags.size,
    blacklistedTagCount: unfilteredTags.length - tags.length,
  };
}

export function defaultMissavReferenceTagLibrary(): MissavReferenceTagLibrary {
  return {
    tags: normalizeReferenceTags(parseLines(defaultReferenceTagsRaw)),
    sourceName: "Miss_AV.html（内置参考）",
    updatedAt: "2026-07-28T00:00:00.000Z",
    bookmarkCount: 3680,
  };
}

export function normalizeMissavReferenceTagLibrary(value: unknown): MissavReferenceTagLibrary {
  const fallback = defaultMissavReferenceTagLibrary();
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Partial<MissavReferenceTagLibrary>;
  const tags = normalizeReferenceTags(Array.isArray(raw.tags) ? raw.tags : []);
  if (!tags.length) return fallback;
  return {
    tags,
    sourceName: normalizeReferenceTag(raw.sourceName) || "自定义参考库",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    bookmarkCount: Number.isFinite(raw.bookmarkCount) ? Math.max(0, Math.trunc(Number(raw.bookmarkCount))) : 0,
  };
}
