<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { listAppLogs, writeTextFile } from "../api";
import { save } from "@tauri-apps/plugin-dialog";
import type { AppLogEntry } from "../types";
import SpreadsheetTable, { type SpreadsheetColumn } from "./SpreadsheetTable.vue";

const logs = ref<AppLogEntry[]>([]);
const level = ref("");
const search = ref("");
const error = ref("");
const selected = ref(new Set<number>());
const columns: SpreadsheetColumn[] = [
  { title: "ID", field: "id", width: 74, editable: false, filterable: false }, { title: "时间", field: "createdAt", width: 210, editable: false },
  { title: "级别", field: "level", width: 100, editable: false }, { title: "分类", field: "category", width: 160, editable: false },
  { title: "信息", field: "message", width: 430, editable: false, longText: true }, { title: "完整详情", field: "detailsText", width: 520, editable: false, longText: true },
];
async function refresh() { try { logs.value = await listAppLogs(5000, level.value, search.value); } catch (reason) { error.value = String(reason); } }
async function exportLogs() {
  const path = await save({ title: "导出脱敏运行日志", defaultPath: `toolbox-logs-${Date.now()}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (path) await writeTextFile(path, JSON.stringify(logs.value, null, 2));
}
watch([level, search], () => { void refresh(); });
onMounted(refresh);
</script>
<template>
  <section class="page-intro compact"><div><span class="section-kicker">可反馈诊断</span><h2>运行日志</h2><p>网络、同步、数据库和任务异常集中显示；令牌、密码、API Hash 与授权头不会原样写入日志。</p></div><button class="quiet-button" @click="exportLogs">导出日志给 Codex</button></section>
  <div v-if="error" class="notice danger">{{ error }}</div>
  <section class="panel results-workspace"><div class="grid-toolbar"><label>级别<select v-model="level"><option value="">全部</option><option>INFO</option><option>WARN</option><option>ERROR</option></select></label><label class="search-box">自由搜索<input v-model="search" placeholder="分类或信息" /></label><strong>{{ logs.length }} 条</strong><button class="quiet-button small" @click="refresh">刷新</button></div>
    <SpreadsheetTable table-id="app-logs" :rows="logs.map(item => ({ ...item, detailsText: JSON.stringify(item.details, null, 2) }))" :columns="columns" :editable="false" :selected-keys="[...selected]" :total-selected="selected.size" height="min(66vh, 760px)" empty-text="暂无日志。" @selection-change="selected = new Set($event.map(Number))" @clear-all-selection="selected = new Set()" />
  </section>
</template>
