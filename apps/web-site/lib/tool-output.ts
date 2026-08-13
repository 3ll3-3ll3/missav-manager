import type { ToolId, ToolResult } from "./types";

export type ToolOutputField = {
  key: "primary" | "secondary";
  label: string;
  values: string[];
};

const LABELS: Record<ToolId, { primary: string; secondary?: string }> = {
  twitter: { primary: "博主名", secondary: "主页链接" },
  badnews: { primary: "帖子直达链接" },
  haijiao: { primary: "帖子直达链接" },
  missav: { primary: "规范番号", secondary: "可信来源链接" },
  av123: { primary: "规范番号", secondary: "已导入的有效详情链接" },
};

function unique(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validSecondary(tool: ToolId, value: string) {
  if (!value.trim()) return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (tool === "twitter" && (host === "x.com" || host === "twitter.com")) return url.href;
    if (tool === "missav" && (host === "missav.ai" || host.endsWith(".missav.ai") || host === "missav.ws" || host.endsWith(".missav.ws"))) return url.href;
    if (tool === "av123" && (host === "123av.com" || host.endsWith(".123av.com"))) return url.href;
  } catch {
    return "";
  }
  return "";
}

export function toolOutputFields(tool: ToolId, rows: ToolResult[]): ToolOutputField[] {
  const labels = LABELS[tool];
  const fields: ToolOutputField[] = [{
    key: "primary",
    label: labels.primary,
    values: unique(rows.map((row) => String(row.primaryValue || ""))),
  }];
  if (labels.secondary) {
    fields.push({
      key: "secondary",
      label: labels.secondary,
      values: unique(rows.map((row) => validSecondary(tool, String(row.secondaryValue || ""))).filter(Boolean)),
    });
  }
  return fields;
}

export function toolPlainText(tool: ToolId, rows: ToolResult[]) {
  const fields = toolOutputFields(tool, rows);
  if (fields.length === 1) return fields[0].values.join("\r\n");
  return fields.map((field) => `【${field.label}】\r\n${field.values.join("\r\n")}`).join("\r\n\r\n");
}
