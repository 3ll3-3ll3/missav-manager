<script setup lang="ts">
import { open, save } from "@tauri-apps/plugin-dialog";
import { computed, onMounted, ref, watch } from "vue";
import {
  createContentRun, deletePermanentRecords, queryPermanentRecordIds, queryPermanentRecords,
  readInputFiles, updatePermanentRecord, updatePermanentRecords, writeTextFile,
} from "../api";
import type { PermanentRecord, ResultInput, ToolKind } from "../types";
import SpreadsheetTable, { type SpreadsheetColumn } from "./SpreadsheetTable.vue";

const tool = ref<"" | ToolKind>("");
const search = ref("");
const page = ref(1);
const pageSize = ref(200);
const total = ref(0);
const lastPage = ref(1);
const rows = ref<PermanentRecord[]>([]);
const selected = ref(new Set<number>());
const busy = ref(false);
const error = ref("");
const notice = ref("");
const addOpen = ref(false);
const addForm = ref({ tool: "missav" as ToolKind, primary: "", secondary: "", status: "manual", tags: "", source: "" });
const bulkField = ref("status");
const bulkValue = ref("");
let searchTimer: number | undefined;

const fieldMap: Record<string, string> = {
  recordKey: "record_key", primaryValue: "primary_value", secondaryValue: "secondary_value", status: "status",
  tags: "tags_json", actressTags: "actress_tags_json", genreTags: "genre_tags_json", sourceUrl: "source_url",
  missavUrl: "missav_url", av123Url: "av123_url", metadata: "metadata_json",
};

const columns: SpreadsheetColumn[] = [
  { title: "ID", field: "id", width: 78, editable: false, filterable: false },
  { title: "工具", field: "tool", width: 100, editable: false },
  { title: "唯一键", field: "recordKey", width: 150 },
  { title: "主值", field: "primaryValue", width: 180 },
  { title: "链接 / 副值", field: "secondaryValue", width: 300, longText: true },
  { title: "状态", field: "status", width: 145 },
  { title: "最终 Tags", field: "tags", width: 260, longText: true },
  { title: "女优 Tags", field: "actressTags", width: 240, longText: true },
  { title: "类型 Tags", field: "genreTags", width: 240, longText: true },
  { title: "来源 URL", field: "sourceUrl", width: 300, longText: true },
  { title: "MissAV URL", field: "missavUrl", width: 300, longText: true },
  { title: "123AV URL", field: "av123Url", width: 300, longText: true },
  { title: "元数据 JSON", field: "metadata", width: 340, longText: true },
  { title: "创建时间", field: "createdAt", width: 205, editable: false },
  { title: "更新时间", field: "updatedAt", width: 205, editable: false },
];

const tableRows = computed(() => rows.value.map((item) => ({
  ...item,
  tags: item.tags.join(", "), actressTags: item.actressTags.join(", "), genreTags: item.genreTags.join(", "),
  metadata: JSON.stringify(item.metadata, null, 2),
})));
const pageLabel = computed(() => `${page.value} / ${lastPage.value}`);

async function load(resetSelection = false) {
  busy.value = true; error.value = "";
  try {
    const result = await queryPermanentRecords(tool.value, page.value, pageSize.value, search.value);
    rows.value = result.data; total.value = result.total; lastPage.value = result.lastPage;
    if (page.value > result.lastPage) { page.value = result.lastPage; return await load(resetSelection); }
    if (resetSelection) selected.value = new Set();
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

function updatePageSelection(keys: Array<string | number>) {
  const pageIds = new Set(rows.value.map((item) => item.id));
  const next = new Set([...selected.value].filter((id) => !pageIds.has(id)));
  keys.forEach((key) => next.add(Number(key)));
  selected.value = next;
}

async function selectAllFiltered() {
  busy.value = true;
  try {
    const ids = await queryPermanentRecordIds(tool.value, search.value);
    selected.value = new Set(ids);
    notice.value = `已选择当前筛选范围的 ${ids.length.toLocaleString()} 条记录。`;
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

function parseList(value: unknown) {
  return String(value ?? "").split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean);
}

async function editCell(payload: { row: Record<string, unknown>; field: string; value: unknown; oldValue: unknown }) {
  const field = fieldMap[payload.field];
  if (!field) return;
  let value: unknown = payload.value;
  if (["tags", "actressTags", "genreTags"].includes(payload.field)) value = parseList(value);
  if (payload.field === "metadata") {
    try { value = JSON.parse(String(value || "{}")); }
    catch { error.value = "元数据必须是有效 JSON，修改未保存。"; await load(); return; }
  }
  try { await updatePermanentRecord(Number(payload.row.id), field, value); notice.value = "单元格已保存，修改前备份已创建。"; await load(); }
  catch (reason) { error.value = String(reason); await load(); }
}

async function addRecord() {
  const primary = addForm.value.primary.trim();
  if (!primary) { error.value = "主值不能为空。"; return; }
  const key = primary.toLowerCase().replace(/[\s_-]+/g, "");
  const result: ResultInput = {
    resultKey: key, primaryValue: primary, secondaryValue: addForm.value.secondary.trim(), status: addForm.value.status.trim() || "manual",
    tags: parseList(addForm.value.tags), source: addForm.value.source.trim(), metadata: { createdFrom: "data-center" },
  };
  try {
    await createContentRun({ tool: addForm.value.tool, name: `数据中心新增 ${new Date().toLocaleString("zh-CN", { hour12: false })}`, inputKind: "manual_crud", originalInput: primary, results: [result] });
    tool.value = addForm.value.tool; addOpen.value = false; addForm.value = { tool: addForm.value.tool, primary: "", secondary: "", status: "manual", tags: "", source: "" };
    page.value = 1; await load(true); notice.value = "记录已新增。";
  } catch (reason) { error.value = String(reason); }
}

async function duplicateSelected() {
  if (selected.value.size !== 1) { error.value = "复制行前请只选择一条记录。"; return; }
  const source = rows.value.find((item) => selected.value.has(item.id));
  if (!source) { error.value = "要复制的记录不在当前页，请先翻到该记录所在页。"; return; }
  addForm.value = { tool: source.tool, primary: `${source.primaryValue}-副本`, secondary: source.secondaryValue, status: source.status, tags: source.tags.join(", "), source: source.sourceUrl };
  addOpen.value = true;
}

async function remove(keys: Array<string | number> = [...selected.value]) {
  const ids = keys.map(Number);
  if (!ids.length || !confirm(`删除 ${ids.length.toLocaleString()} 条永久记录？系统只创建一份操作前备份。`)) return;
  busy.value = true;
  try { const changed = await deletePermanentRecords(ids.map(Number)); selected.value = new Set(); await load(); notice.value = `已删除 ${changed.toLocaleString()} 条。`; }
  catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

async function applyBulkEdit() {
  if (!selected.value.size) { error.value = "请先选择记录。"; return; }
  const field = bulkField.value;
  let value: unknown = bulkValue.value;
  if (field.endsWith("_json") && field !== "metadata_json") value = parseList(value);
  if (field === "metadata_json") {
    try { value = JSON.parse(bulkValue.value || "{}"); } catch { error.value = "批量元数据必须是有效 JSON。"; return; }
  }
  if (!confirm(`把 ${selected.value.size.toLocaleString()} 条记录的该字段统一修改？`)) return;
  busy.value = true;
  try { const changed = await updatePermanentRecords([...selected.value], field, value); await load(); notice.value = `已批量修改 ${changed.toLocaleString()} 条，只创建一份操作前备份。`; }
  catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

function csv(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function parseCsv(text: string) { const rows: string[][] = []; let row: string[] = []; let value = ""; let quoted = false; for (let index = 0; index < text.length; index += 1) { const character = text[index]; if (quoted) { if (character === '"' && text[index + 1] === '"') { value += '"'; index += 1; } else if (character === '"') quoted = false; else value += character; } else if (character === '"') quoted = true; else if (character === ',') { row.push(value); value = ""; } else if (character === '\n') { row.push(value.replace(/\r$/, "")); if (row.some((cell) => cell.length)) rows.push(row); row = []; value = ""; } else value += character; } row.push(value.replace(/\r$/, "")); if (row.some((cell) => cell.length)) rows.push(row); return rows; }
async function importCsv() { const chosen = await open({ multiple: true, directory: false, title: "导入数据中心 CSV（可多选）", filters: [{ name: "CSV", extensions: ["csv"] }] }); const paths = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : []; if (!paths.length) return; busy.value = true; error.value = ""; try { const files = await readInputFiles(paths); let imported = 0; for (const file of files) { if (file.error) { error.value += `${file.name}：${file.error}\n`; continue; } const parsed = parseCsv(file.text.replace(/^\uFEFF/, "")); const header = (parsed.shift() || []).map((cell) => cell.trim().toLowerCase()); const position = (names: string[]) => names.map((name) => header.indexOf(name)).find((index) => index >= 0) ?? -1; const indexes = { tool: position(["tool","工具"]), key: position(["key","record_key","唯一键"]), primary: position(["primary","primary_value","主值","番号"]), secondary: position(["secondary","secondary_value","链接","副值"]), status: position(["status","状态"]), tags: position(["tags","tag","标签"]), source: position(["source","source_url","来源"]) }; if (indexes.primary < 0) { error.value += `${file.name}：缺少 primary/主值列\n`; continue; } const byTool = new Map<ToolKind, ResultInput[]>(); for (const cells of parsed) { const chosenTool = (indexes.tool >= 0 ? cells[indexes.tool] : tool.value || "missav") as ToolKind; if (!["twitter","badnews","haijiao","missav","av123"].includes(chosenTool)) continue; const primary = String(cells[indexes.primary] || "").trim(); if (!primary) continue; const result: ResultInput = { resultKey: String(indexes.key >= 0 ? cells[indexes.key] : primary).toLowerCase().replace(/[\s_-]+/g, ""), primaryValue: primary, secondaryValue: indexes.secondary >= 0 ? String(cells[indexes.secondary] || "") : "", status: indexes.status >= 0 ? String(cells[indexes.status] || "manual") : "manual", tags: indexes.tags >= 0 ? parseList(cells[indexes.tags]) : [], source: indexes.source >= 0 ? String(cells[indexes.source] || file.name) : file.name, metadata: { importedFrom: file.name } }; const list = byTool.get(chosenTool) || []; list.push(result); byTool.set(chosenTool, list); } for (const [chosenTool, results] of byTool) { if (!results.length) continue; await createContentRun({ tool: chosenTool, name: `CSV 导入 ${file.name} ${new Date().toLocaleString("zh-CN", { hour12: false })}`, inputKind: "csv_import", originalInput: "", options: { file: file.name, rows: results.length }, results }); imported += results.length; } } page.value = 1; await load(true); notice.value = `CSV 导入完成：${imported.toLocaleString()} 条。重复唯一键按数据库规则更新。`; } catch (reason) { error.value = String(reason); } finally { busy.value = false; } }
function exportLine(item: PermanentRecord) {
  return [item.id,item.tool,item.recordKey,item.primaryValue,item.secondaryValue,item.status,item.tags.join(","),item.actressTags.join(","),item.genreTags.join(","),item.sourceUrl,item.missavUrl,item.av123Url,JSON.stringify(item.metadata),item.createdAt,item.updatedAt].map(csv).join(",");
}

async function exportData(scope: "page" | "filtered") {
  const path = await save({ title: scope === "page" ? "导出当前页" : "导出全部筛选结果", defaultPath: `data-center-${scope}-${Date.now()}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (!path) return;
  busy.value = true;
  try {
    let exportRows = rows.value;
    if (scope === "filtered") {
      exportRows = [];
      const first = await queryPermanentRecords(tool.value, 1, 500, search.value); exportRows.push(...first.data);
      for (let current = 2; current <= first.lastPage; current += 1) exportRows.push(...(await queryPermanentRecords(tool.value, current, 500, search.value)).data);
    }
    const header = "id,tool,key,primary,secondary,status,tags,actresses,genres,source,missav_url,av123_url,metadata,created,updated";
    await writeTextFile(path, `\uFEFF${[header, ...exportRows.map(exportLine)].join("\r\n")}`);
    notice.value = `已导出 ${exportRows.length.toLocaleString()} 条到 ${path}`;
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

watch([tool, pageSize], () => { page.value = 1; void load(true); });
watch(search, () => {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { page.value = 1; void load(true); }, 260);
});
onMounted(load);
</script>

<template>
  <section class="page-intro compact"><div><span class="section-kicker">电子表格式数据管理</span><h2>统一数据中心</h2><p>完整字段、右侧详情、跨页选择、批量编辑、复制 TSV 与全范围 CSV。面向 10 万条以上数据，正文不再被无入口地截断。</p></div><div class="inline-stat"><strong>{{ total.toLocaleString() }}</strong><span>匹配记录</span></div></section>
  <div v-if="error" class="notice danger">{{ error }}</div><div v-if="notice" class="notice info">{{ notice }}</div>
  <section class="panel results-workspace">
    <div class="grid-toolbar result-tools">
      <label>工具<select v-model="tool"><option value="">全部</option><option value="twitter">推特</option><option value="badnews">Bad.news</option><option value="haijiao">海角</option><option value="missav">MissAV</option><option value="av123">123AV</option></select></label>
      <label class="search-box">数据库全文搜索<input v-model="search" placeholder="主值、链接、Tag、女优、类型均可" /></label>
      <button class="primary-button small" @click="addOpen = true">新增</button><button class="quiet-button small" :disabled="selected.size !== 1" @click="duplicateSelected">复制行</button><button class="quiet-button small" @click="importCsv">导入 CSV</button>
      <button class="quiet-button small" @click="load()">刷新</button><button class="quiet-button small" @click="exportData('page')">导出当前页</button><button class="quiet-button small" @click="exportData('filtered')">导出筛选结果</button>
    </div>
    <div class="bulk-editor"><label>批量字段<select v-model="bulkField"><option value="status">状态</option><option value="secondary_value">链接 / 副值</option><option value="tags_json">最终 Tags</option><option value="actress_tags_json">女优 Tags</option><option value="genre_tags_json">类型 Tags</option><option value="source_url">来源 URL</option><option value="missav_url">MissAV URL</option><option value="av123_url">123AV URL</option><option value="metadata_json">元数据 JSON</option></select></label><label class="search-box">统一修改为<input v-model="bulkValue" placeholder="Tags 用逗号分隔，JSON 字段填写完整 JSON" /></label><button class="quiet-button small" :disabled="!selected.size" @click="applyBulkEdit">批量修改 {{ selected.size || '' }}</button></div>
    <SpreadsheetTable table-id="data-center-permanent" :rows="tableRows" :columns="columns" :selected-keys="[...selected]" :total-selected="selected.size" server-selection height="min(62vh, 720px)" @selection-change="updatePageSelection" @select-all-filtered="selectAllFiltered" @clear-all-selection="selected = new Set()" @cell-edited="editCell" @delete-selected="remove" />
    <div class="pager"><button class="quiet-button small" :disabled="page <= 1 || busy" @click="page -= 1; load()">上一页</button><strong>{{ pageLabel }}</strong><button class="quiet-button small" :disabled="page >= lastPage || busy" @click="page += 1; load()">下一页</button><select v-model.number="pageSize"><option :value="100">100 行</option><option :value="200">200 行</option><option :value="500">500 行</option></select><span>{{ busy ? "读取中…" : `共 ${total.toLocaleString()} 条` }}</span></div>
  </section>

  <div v-if="addOpen" class="modal-backdrop" @click.self="addOpen = false"><section class="record-editor-modal"><div class="section-heading compact-heading"><div><span class="section-kicker">完整字段表单</span><h3>新增 / 复制记录</h3></div><button class="quiet-button small" @click="addOpen = false">关闭</button></div><div class="form-grid two"><label>工具<select v-model="addForm.tool"><option value="twitter">推特</option><option value="badnews">Bad.news</option><option value="haijiao">海角</option><option value="missav">MissAV</option><option value="av123">123AV</option></select></label><label>状态<input v-model="addForm.status" /></label><label>主值<input v-model="addForm.primary" /></label><label>链接 / 副值<input v-model="addForm.secondary" /></label><label>Tags<input v-model="addForm.tags" placeholder="逗号分隔" /></label><label>来源<input v-model="addForm.source" /></label></div><div class="action-row"><button class="primary-button" @click="addRecord">保存记录</button><button class="quiet-button" @click="addOpen = false">取消</button></div></section></div>
</template>
