<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { listInboxTasks, updateInboxTaskStage } from "../api";
import type { InboxTask, ToolKind } from "../types";
import SpreadsheetTable, { type SpreadsheetColumn } from "./SpreadsheetTable.vue";

const emit = defineEmits<{ openRun: [tool: ToolKind, runId: number] }>();
const tasks = ref<InboxTask[]>([]);
const selected = ref(new Set<number>());
const stage = ref("");
const search = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");
let timer: number | undefined;

const stages = [
  { id: "", label: "全部" }, { id: "new", label: "新收到" }, { id: "filtered", label: "已过滤" },
  { id: "website_action", label: "待网站操作" }, { id: "review", label: "待复查" }, { id: "exception", label: "异常" }, { id: "completed", label: "已完成" },
];
const labels = Object.fromEntries(stages.map((item) => [item.id, item.label]));
const columns: SpreadsheetColumn[] = [
  { title: "ID", field: "id", width: 72, editable: false, filterable: false }, { title: "阶段", field: "stage", width: 140 },
  { title: "工具", field: "tool", width: 105, editable: false }, { title: "任务名称", field: "title", width: 300, editable: false, longText: true },
  { title: "来源", field: "sourceName", width: 220, editable: false, longText: true }, { title: "摘要", field: "summary", width: 180, editable: false, longText: true },
  { title: "异常", field: "error", width: 330, editable: false, longText: true }, { title: "运行 ID", field: "runId", width: 100, editable: false },
  { title: "创建时间", field: "createdAt", width: 205, editable: false }, { title: "更新时间", field: "updatedAt", width: 205, editable: false },
];
const visibleTasks = computed(() => stage.value ? tasks.value.filter((item) => item.stage === stage.value) : tasks.value);
const tableRows = computed(() => visibleTasks.value.map((item) => ({ ...item, stage: labels[item.stage] || item.stage })));
const counts = computed(() => Object.fromEntries(stages.slice(1).map((item) => [item.id, tasks.value.filter((task) => task.stage === item.id).length])));

async function load() { busy.value = true; error.value = ""; try { tasks.value = await listInboxTasks("", search.value, 5000); selected.value = new Set(); } catch (reason) { error.value = String(reason); } finally { busy.value = false; } }
function canonicalStage(value: unknown) { const text = String(value).trim(); return stages.find((item) => item.id === text || item.label === text)?.id || text; }
async function editStage(payload: { row: Record<string, unknown>; field: string; value: unknown }) { if (payload.field !== "stage") return; const next = canonicalStage(payload.value); if (!stages.some((item) => item.id === next && item.id)) { error.value = "阶段只能是：新收到、已过滤、待网站操作、待复查、异常、已完成。"; await load(); return; } try { await updateInboxTaskStage(Number(payload.row.id), next); await load(); notice.value = "任务阶段已更新。"; } catch (reason) { error.value = String(reason); await load(); } }
async function setSelectedStage(next: string) { if (!selected.value.size) return; busy.value = true; try { for (const id of selected.value) await updateInboxTaskStage(id, next); await load(); notice.value = `已更新 ${selected.value.size || "所选"} 项。`; } catch (reason) { error.value = String(reason); } finally { busy.value = false; } }
function openSelected() { if (selected.value.size !== 1) { error.value = "请只选择一个任务再打开。"; return; } const item = tasks.value.find((task) => selected.value.has(task.id)); if (item) emit("openRun", item.tool, item.runId); }
watch(search, () => { if (timer) window.clearTimeout(timer); timer = window.setTimeout(load, 250); });
onMounted(load);
</script>

<template>
  <section class="page-intro compact"><div><span class="section-kicker">日常处理入口</span><h2>统一处理中心</h2><p>Telegram 与手动输入生成的任务在这里按阶段排队；数据中心继续负责底层记录，不与日常处理混在一起。</p></div><div class="inline-stat"><strong>{{ tasks.length.toLocaleString() }}</strong><span>当前范围任务</span></div></section>
  <div v-if="error" class="notice danger">{{ error }}</div><div v-if="notice" class="notice info">{{ notice }}</div>
  <section class="panel results-workspace">
    <div class="inbox-stage-tabs"><button v-for="item in stages" :key="item.id" :class="{ active: stage === item.id }" @click="stage = item.id">{{ item.label }}<small v-if="item.id">{{ counts[item.id] || 0 }}</small></button></div>
    <div class="grid-toolbar result-tools"><label class="search-box">搜索任务<input v-model="search" placeholder="任务名、来源、摘要或异常" /></label><strong>{{ busy ? '读取中…' : `${tasks.length} 项` }}</strong><button class="primary-button small" :disabled="selected.size !== 1" @click="openSelected">打开所选任务</button><button class="quiet-button small" :disabled="!selected.size" @click="setSelectedStage('review')">转待复查</button><button class="quiet-button small" :disabled="!selected.size" @click="setSelectedStage('completed')">标记完成</button><button class="quiet-button small" @click="load">刷新</button></div>
    <SpreadsheetTable table-id="task-inbox" :rows="tableRows" :columns="columns" :selected-keys="[...selected]" :total-selected="selected.size" height="min(64vh, 720px)" @selection-change="selected = new Set($event.map(Number))" @clear-all-selection="selected = new Set()" @cell-edited="editStage" />
  </section>
</template>
