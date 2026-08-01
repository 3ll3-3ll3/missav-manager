import { getD1 } from "../db";
import { buildRaindropExport, extractReferenceActressTagsFromHtml, generateMissavBrowserScript } from "./missav";
import { ensureSchema, getSettings, nowIso } from "./server-store";
import { writeLog } from "./server-audit";
import type { RecordRow, ToolResult } from "./types";

function settingList(settings:Record<string,unknown>,key:string){return Array.isArray(settings[key])?settings[key] as unknown[]:[];}

export async function generateScriptAction(input: Record<string, unknown>) {
  await ensureSchema();
  const settings = await getSettings();
  const codes = Array.isArray(input.codes) ? input.codes : [];
  const generated = await generateMissavBrowserScript(codes, settingList(settings,"referenceTags"), settingList(settings,"referenceBlacklist"), settingList(settings,"exportBlacklist"));
  const id = crypto.randomUUID();
  await getD1().prepare(`INSERT INTO script_generations
    (id,run_id,template_hash,code_count,reference_tag_count,reference_blacklist_count,export_blacklist_count,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(id, String(input.runId ?? "").slice(0, 100), generated.templateHash, generated.codes.length,
      generated.referenceTagCount, generated.referenceBlacklistCount, generated.exportBlacklistCount, nowIso()).run();
  await writeLog("info", "missav-script", "已生成 v0.5.13 完整浏览器脚本", { generationId: id, codeCount: generated.codes.length, templateHash: generated.templateHash });
  return { ...generated, generationId: id };
}

export async function previewReferenceHtml(input: Record<string, unknown>) {
  await ensureSchema();
  const settings = await getSettings();
  return extractReferenceActressTagsFromHtml(String(input.html ?? "").slice(0, 12_000_000), settingList(settings,"referenceTags"), settingList(settings,"referenceBlacklist"));
}

function resultRow(item: ToolResult, index: number): RecordRow {
  const timestamp = nowIso();
  return {
    id: `preview-${index}`, tool: "missav", recordKey: item.resultKey, primaryValue: item.primaryValue,
    secondaryValue: item.secondaryValue ?? "", status: item.status ?? "pending", tags: item.tags ?? [], actressTags: item.actressTags ?? [],
    genreTags: item.genreTags ?? [], sourceUrl: item.source ?? "", missavUrl: item.secondaryValue ?? "", av123Url: "", metadata: item.metadata ?? {},
    createdAt: timestamp, updatedAt: timestamp,
  };
}

export async function exportPreviewResults(input: Record<string, unknown>) {
  await ensureSchema();
  const settings = await getSettings();
  const results = (Array.isArray(input.results) ? input.results : []).slice(0, 100_000) as ToolResult[];
  const format = input.format === "html" ? "html" : "csv";
  return buildRaindropExport(results.map(resultRow), settingList(settings,"exportBlacklist"), format);
}

export async function listScriptGenerations(limit = 50) {
  await ensureSchema();
  const rows = await getD1().prepare("SELECT * FROM script_generations ORDER BY created_at DESC LIMIT ?").bind(Math.min(100, Math.max(1, limit))).all();
  return rows.results ?? [];
}
