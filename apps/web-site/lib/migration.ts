import { normalizeCode } from "./rules";
import { safeHttpUrl, safeJson } from "./security";
import type { SanitizedImportRecord, ToolId } from "./types";

const TOOLS = new Set(["twitter", "badnews", "haijiao", "missav", "av123"]);

function array(value: unknown) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 500);
  return String(value ?? "").split(/\r?\n|[|,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 500);
}

export type MigrationValidation = { record?: SanitizedImportRecord; reason?: string; normalizedSource: Record<string, unknown> };

export function validateMigrationRecord(raw: Record<string, unknown>): MigrationValidation {
  const normalized = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.trim().toLowerCase().replace(/[_\s-]/g, ""), value]));
  const tool = String(normalized.tool ?? normalized.type ?? "").toLowerCase();
  if (!TOOLS.has(tool)) return { reason: "未知工具", normalizedSource: normalized };
  let primary = String(normalized.primaryvalue ?? normalized.normalizedvalue ?? normalized.primary ?? normalized.value ?? normalized.code ?? normalized.url ?? normalized.recordkey ?? "").trim();
  if (!primary) return { reason: "缺少身份字段", normalizedSource: normalized };
  if (tool === "missav" || tool === "av123") {
    primary = normalizeCode(primary);
    if (!/^(?:FC2-PPV-\d{4,10}|[A-Z]{2,12}-\d{2,7}(?:-[A-Z0-9]{1,12})?)$/.test(primary)) return { reason: "番号格式无效", normalizedSource: normalized };
  }
  const rawUrl = normalized.sourceurl ?? normalized.primaryurl ?? normalized.missavurl ?? normalized.av123url ?? normalized.secondaryvalue ?? "";
  const url = rawUrl ? safeHttpUrl(rawUrl) : "";
  if (rawUrl && !url) return { reason: "不安全 URL", normalizedSource: normalized };
  const created = String(normalized.createdat ?? "").trim();
  if (created && Number.isNaN(new Date(created).getTime())) return { reason: "日期无效", normalizedSource: normalized };
  const key = String(normalized.recordkey ?? normalized.key ?? (tool === "twitter" ? primary.replace(/^@/, "").toLowerCase() : primary.toLowerCase())).trim();
  if (!key) return { reason: "缺少唯一键", normalizedSource: normalized };
  const tags = array(normalized.tags);
  const record: SanitizedImportRecord = {
    tool: tool as ToolId,
    recordKey: key.slice(0, 300),
    primaryValue: primary.slice(0, 1_000),
    secondaryValue: String(normalized.secondaryvalue ?? normalized.secondary ?? normalized.note ?? "").slice(0, 4_000),
    status: String(normalized.status ?? "imported").slice(0, 64),
    tags,
    actressTags: array(normalized.actresstags ?? normalized.actress),
    genreTags: array(normalized.genretags ?? normalized.genre),
    sourceUrl: url,
    missavUrl: tool === "missav" ? url : safeHttpUrl(normalized.missavurl),
    av123Url: tool === "av123" ? url : safeHttpUrl(normalized.av123url),
    metadata: { migration: "sanitized-web-import", sourceRow: normalized.sourcerow ?? null, expectedCase: normalized.expectedcase ?? null, createdAt: created || null },
  };
  JSON.parse(safeJson(record));
  return { record, normalizedSource: normalized };
}

export function canonicalMigrationRecord(record: SanitizedImportRecord) {
  return JSON.stringify({
    tool: record.tool, recordKey: record.recordKey, primaryValue: record.primaryValue, secondaryValue: record.secondaryValue ?? "", status: record.status ?? "",
    tags: record.tags ?? [], actressTags: record.actressTags ?? [], genreTags: record.genreTags ?? [], sourceUrl: record.sourceUrl ?? "", missavUrl: record.missavUrl ?? "", av123Url: record.av123Url ?? "",
  });
}
