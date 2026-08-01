import scriptTemplateRaw from "../assets/missav-browser-script.txt?raw";
import typeBoundaryTagsRaw from "../assets/missav-type-boundary-tags.txt?raw";
import { csvSafe, escapeHtml, safeHttpUrl, sha256Hex } from "./security";
import type { RecordRow } from "./types";

const SYSTEM_TAGS = new Set(["未知女优", "#未知女优", "需要查找", "已存在", "重复输入"]);
const EXPLICIT_TYPE_TAGS = new Set(["教师", "女优", "女優", "演员", "演員", "VR"]);

export function normalizeReferenceTag(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function unique(values: Iterable<unknown>, filterTypes = false) {
  const output: string[] = [];
  const seen = new Set<string>();
  const boundary = new Set(typeBoundaryTagsRaw.split(/\r?\n/).map(normalizeReferenceTag).filter(Boolean));
  for (const value of values) {
    const tag = normalizeReferenceTag(value);
    if (!tag || seen.has(tag) || (filterTypes && (SYSTEM_TAGS.has(tag) || EXPLICIT_TYPE_TAGS.has(tag) || boundary.has(tag)))) continue;
    seen.add(tag);
    output.push(tag);
  }
  return output;
}

export function normalizeReferenceTags(values: Iterable<unknown>) { return unique(values, true); }
export function normalizeBlacklist(values: Iterable<unknown>) { return unique(values); }

export function normalizeScriptCodes(values: Iterable<unknown>) {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    let value = String(raw ?? "").trim().toUpperCase().replace(/[＿_\s]+/g, "-").replace(/-{2,}/g, "-");
    const fc2 = value.match(/^FC2-?(?:PPV-?)?(\d{5,10})$/i);
    if (fc2) value = `FC2-PPV-${fc2[1]}`;
    if (!/^(?:FC2-PPV-\d{5,10}|[A-Z]{2,12}-\d{2,7}(?:-[A-Z0-9]{1,12})?)$/.test(value)) continue;
    const key = value.replaceAll("-", "");
    if (!seen.has(key)) { seen.add(key); output.push(value); }
  }
  return output;
}

export function extractReferenceActressTagsFromHtml(html: string, knownValues: Iterable<unknown> = [], blacklistValues: Iterable<unknown> = []) {
  if (!/<!DOCTYPE\s+NETSCAPE-Bookmark-file-1|<A\b/i.test(html)) throw new Error("所选文件不是可识别的书签 HTML。");
  const known = new Set(normalizeReferenceTags(knownValues));
  const blacklist = new Set(normalizeBlacklist(blacklistValues));
  const boundary = new Set(typeBoundaryTagsRaw.split(/\r?\n/).map(normalizeReferenceTag).filter(Boolean));
  const rows: string[][] = [];
  for (const match of html.matchAll(/\bTAGS\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = String(match[1] ?? match[2] ?? "").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
    rows.push(raw.split(",").map(normalizeReferenceTag).filter(Boolean));
  }
  if (!rows.length) throw new Error("HTML 中没有找到带 TAGS 属性的书签记录。");
  const extracted = new Set<string>();
  const sourceTags = new Set<string>();
  let taggedBookmarkCount = 0;
  const isBoundary = (tag: string) => SYSTEM_TAGS.has(tag) || EXPLICIT_TYPE_TAGS.has(tag) || boundary.has(tag);
  const looksActress = (tag: string) => Boolean(tag && !isBoundary(tag) && !/\s|\d|https?:|www\.|\.com|\.ai/i.test(tag) && (/[぀-ヿ㐀-鿿]/u.test(tag) || /^[A-Za-z][A-Za-z.'_-]{1,39}$/.test(tag)));
  for (const tags of rows) {
    if (tags.length) taggedBookmarkCount += 1;
    for (const tag of tags) { sourceTags.add(tag); if (known.has(tag)) extracted.add(tag); }
    for (const tag of tags) { if (isBoundary(tag) || !looksActress(tag)) break; extracted.add(tag); }
  }
  const unfiltered = normalizeReferenceTags(extracted);
  const tags = unfiltered.filter((tag) => !blacklist.has(tag)).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  if (!tags.length) throw new Error("没有从 HTML 中识别出女优 Tag；原参考库未被修改。");
  return { tags, bookmarkCount: rows.length, taggedBookmarkCount, uniqueSourceTags: sourceTags.size, blacklistedTagCount: unfiltered.length - tags.length };
}

export async function generateMissavBrowserScript(values: Iterable<unknown>, referenceValues: Iterable<unknown>, referenceBlacklistValues: Iterable<unknown>, exportBlacklistValues: Iterable<unknown>) {
  const codes = normalizeScriptCodes(values);
  if (!codes.length) throw new Error("当前范围没有可写入脚本的有效番号。");
  const allReferences = normalizeReferenceTags(referenceValues);
  const referenceBlacklist = new Set(normalizeBlacklist(referenceBlacklistValues));
  const referenceTags = allReferences.filter((tag) => !referenceBlacklist.has(tag));
  if (!referenceTags.length) throw new Error("参考女优 Tag 库为空，请先导入 Miss_AV.html 或保存参考 Tag。");
  const exportBlacklist = normalizeBlacklist(exportBlacklistValues);
  const codeBlock = `const CODE_TEXT = \`${codes.map((code) => code.replaceAll("`", "\\`").replaceAll("${", "\\${")).join("\n")}\`.trim();`;
  const referenceBlock = `const REFERENCE_ACTRESS_TAGS = ${JSON.stringify(referenceTags, null, 2)};`;
  const exportBlock = `const RAINDROP_EXPORT_BLACKLIST_TAGS = ${JSON.stringify(exportBlacklist, null, 2)};`;
  let script = scriptTemplateRaw.replace(/^\uFEFF/, "").trimEnd();
  if (!/const\s+CODE_TEXT\s*=\s*`[\s\S]*?`\.trim\(\);/.test(script) || !script.includes("(async () =>")) throw new Error("v0.5.13 浏览器脚本模板不完整。");
  script = script.replace(/const\s+CODE_TEXT\s*=\s*`[\s\S]*?`\.trim\(\);/, codeBlock);
  script = script.replace(/const\s+REFERENCE_ACTRESS_TAGS\s*=\s*\[[\s\S]*?\];/, referenceBlock);
  script = script.replace(/const\s+RAINDROP_EXPORT_BLACKLIST_TAGS\s*=\s*\[[\s\S]*?\];/, exportBlock);
  const hash = await sha256Hex(`${scriptTemplateRaw}\n${referenceTags.join("\n")}\n${[...referenceBlacklist].join("\n")}\n${exportBlacklist.join("\n")}`);
  return { codes, script, referenceTags, referenceTagCount: referenceTags.length, referenceBlacklistCount: referenceBlacklist.size, exportBlacklistCount: exportBlacklist.length, templateHash: hash };
}

export type RaindropAudit = { id: string; code: string; included: boolean; reason: string; matchedBlacklist: string[]; url: string };

export function buildRaindropExport(records: RecordRow[], exportBlacklistValues: Iterable<unknown>, format: "csv" | "html") {
  const blacklist = new Map(normalizeBlacklist(exportBlacklistValues).map((tag) => [tag.toLocaleLowerCase(), tag]));
  const audits: RaindropAudit[] = records.map((row) => {
    const matchedBlacklist = [...row.tags, ...row.actressTags].map((tag) => blacklist.get(tag.trim().toLocaleLowerCase())).filter((tag): tag is string => Boolean(tag));
    const fallback = /^\s*(?:FC2-PPV-\d+|[A-Z]{2,12}-\d{2,7})\s*$/.test(row.primaryValue) ? `https://missav.ai/cn/${row.primaryValue.toLowerCase()}` : "";
    const url = safeHttpUrl(row.missavUrl) || (/^https?:\/\/(?:[^/]+\.)?missav\.(?:ai|ws)\//i.test(row.sourceUrl) ? safeHttpUrl(row.sourceUrl) : "") || fallback;
    const reason = matchedBlacklist.length ? `第二层黑名单：${matchedBlacklist.join("、")}` : (!url ? "缺少安全有效链接" : "");
    return { id: row.id, code: row.primaryValue, included: !reason, reason, matchedBlacklist, url };
  });
  const included = records.filter((_, index) => audits[index].included);
  if (format === "html") {
    const links = included.map((row) => {
      const audit = audits.find((item) => item.id === row.id)!;
      return `<DT><A HREF="${escapeHtml(audit.url)}" ADD_DATE="${Math.floor(new Date(row.createdAt).getTime() / 1000) || 0}" TAGS="${escapeHtml([...row.tags, ...row.actressTags, ...row.genreTags].join(","))}">${escapeHtml(row.primaryValue)}</A>`;
    }).join("\n");
    return { content: `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>MissAV Manager</TITLE>\n<H1>MissAV Manager</H1>\n<DL><p>\n${links}\n</DL><p>`, included: included.length, excluded: records.length - included.length, audits };
  }
  const header = ["id", "title", "note", "excerpt", "url", "folder", "tags", "created", "cover", "highlights", "favorite"];
  const rows = included.map((row, index) => {
    const audit = audits.find((item) => item.id === row.id)!;
    return [index + 1, row.primaryValue, row.status, "", audit.url, "MissAV Manager", [...row.tags, ...row.actressTags, ...row.genreTags].join(","), row.createdAt, "", "", "false"].map(csvSafe).join(",");
  });
  return { content: `\uFEFF${[header.map(csvSafe).join(","), ...rows].join("\r\n")}`, included: included.length, excluded: records.length - included.length, audits };
}
