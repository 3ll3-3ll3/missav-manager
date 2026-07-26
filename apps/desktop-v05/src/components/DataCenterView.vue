<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { createContentRun, deletePermanentRecords, queryPermanentRecords, updatePermanentRecord, writeTextFile } from "../api";
import { save } from "@tauri-apps/plugin-dialog";
import type { PermanentRecord, ToolKind } from "../types";

const tool = ref<"" | ToolKind>("");
const search = ref("");
const page = ref(1);
const pageSize = ref(200);
const total = ref(0);
const lastPage = ref(1);
const rows = ref<PermanentRecord[]>([]);
const selected = ref(new Set<number>());
const lastIndex = ref(-1);
const busy = ref(false);
const error = ref("");

async function load() {
  busy.value = true; error.value = "";
  try { const result = await queryPermanentRecords(tool.value, page.value, pageSize.value, search.value); rows.value = result.data; total.value = result.total; lastPage.value = result.lastPage; selected.value = new Set(); }
  catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}
function selectRow(event: MouseEvent, item: PermanentRecord, index: number) {
  const next = new Set(event.ctrlKey || event.shiftKey ? selected.value : []);
  if (event.shiftKey && lastIndex.value >= 0) { const [start, end] = [lastIndex.value, index].sort((a, b) => a - b); rows.value.slice(start, end + 1).forEach((row) => next.add(row.id)); }
  else if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
  selected.value = next; lastIndex.value = index;
}
async function edit(item: PermanentRecord, field: string, event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  const value: unknown = field.endsWith("_json") ? raw.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) : raw;
  try { await updatePermanentRecord(item.id, field, value); await load(); } catch (reason) { error.value = String(reason); }
}
async function add() {
  const chosen = (tool.value || prompt("工具：twitter / badnews / haijiao / missav / av123", "missav") || "") as ToolKind;
  if (!["twitter","badnews","haijiao","missav","av123"].includes(chosen)) return;
  const primary = prompt("主值（番号、博主名或链接）")?.trim(); if (!primary) return;
  await createContentRun({ tool: chosen, name: `手动新增 ${new Date().toLocaleString("zh-CN", { hour12: false })}`, inputKind: "manual_crud", originalInput: primary, results: [{ resultKey: primary.toLowerCase(), primaryValue: primary, status: "manual" }] });
  tool.value = chosen; page.value = 1; await load();
}
async function remove() { if (!selected.value.size || !confirm(`删除 ${selected.value.size} 条永久记录？删除前会自动备份。`)) return; await deletePermanentRecords([...selected.value]); await load(); }
function csv(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
async function exportPage() { const path = await save({ title: "导出当前数据页", defaultPath: `data-center-${Date.now()}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] }); if (!path) return; const content = ["tool,key,primary,secondary,status,tags,actresses,genres,source,updated", ...rows.value.map((item) => [item.tool,item.recordKey,item.primaryValue,item.secondaryValue,item.status,item.tags.join(","),item.actressTags.join(","),item.genreTags.join(","),item.sourceUrl,item.updatedAt].map(csv).join(","))].join("\r\n"); await writeTextFile(path, `\uFEFF${content}`); }
const pageLabel = computed(() => `${page.value} / ${lastPage.value}`);
watch([tool, search, pageSize], () => { page.value = 1; void load(); });
onMounted(load);
</script>
<template>
  <section class="page-intro compact"><div><span class="section-kicker">真实业务数据</span><h2>统一数据中心</h2><p>跨工具自由搜索并进行新增、编辑、删除、查询和导出。面向 10 万条以上永久历史，页面始终只加载当前 200 行。</p></div><div class="inline-stat"><strong>{{ total.toLocaleString() }}</strong><span>匹配记录</span></div></section>
  <div v-if="error" class="notice danger">{{ error }}</div>
  <section class="panel results-workspace">
    <div class="grid-toolbar result-tools"><label>工具<select v-model="tool"><option value="">全部</option><option value="twitter">推特</option><option value="badnews">Bad.news</option><option value="haijiao">海角</option><option value="missav">MissAV</option><option value="av123">123AV</option></select></label><label class="search-box">自由搜索<input v-model="search" placeholder="主值、链接、Tag、女优、类型均可" /></label><button class="primary-button small" @click="add">新增</button><button class="danger-button small" :disabled="!selected.size" @click="remove">删除 {{ selected.size || '' }}</button><button class="quiet-button small" @click="exportPage">导出当前页</button></div>
    <div class="editable-table-wrap"><table class="editable-table"><thead><tr><th>选</th><th>工具</th><th>主值</th><th>链接/副值</th><th>状态</th><th>Tag</th><th>女优</th><th>类型</th><th>更新时间</th></tr></thead><tbody><tr v-for="(item,index) in rows" :key="item.id" :class="{ selected: selected.has(item.id) }" @click="selectRow($event,item,index)"><td><input type="checkbox" :checked="selected.has(item.id)" /></td><td>{{ item.tool }}</td><td><input :value="item.primaryValue" @click.stop @change="edit(item,'primary_value',$event)" /></td><td><input :value="item.secondaryValue" @click.stop @change="edit(item,'secondary_value',$event)" /></td><td><input :value="item.status" @click.stop @change="edit(item,'status',$event)" /></td><td><input :value="item.tags.join(', ')" @click.stop @change="edit(item,'tags_json',$event)" /></td><td><input :value="item.actressTags.join(', ')" @click.stop @change="edit(item,'actress_tags_json',$event)" /></td><td><input :value="item.genreTags.join(', ')" @click.stop @change="edit(item,'genre_tags_json',$event)" /></td><td>{{ item.updatedAt }}</td></tr></tbody></table><div v-if="!rows.length && !busy" class="empty-state">没有匹配数据。</div></div>
    <div class="pager"><button class="quiet-button small" :disabled="page <= 1" @click="page -= 1; load()">上一页</button><strong>{{ pageLabel }}</strong><button class="quiet-button small" :disabled="page >= lastPage" @click="page += 1; load()">下一页</button><select v-model.number="pageSize"><option :value="100">100 行</option><option :value="200">200 行</option><option :value="500">500 行</option></select></div>
  </section>
</template>
