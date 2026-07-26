<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { listAppLogs, writeTextFile } from "../api";
import { save } from "@tauri-apps/plugin-dialog";
import type { AppLogEntry } from "../types";

const logs = ref<AppLogEntry[]>([]);
const level = ref("");
const search = ref("");
const error = ref("");
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
    <div class="editable-table-wrap"><table class="editable-table log-table"><thead><tr><th>时间</th><th>级别</th><th>分类</th><th>信息</th><th>详情</th></tr></thead><tbody><tr v-for="item in logs" :key="item.id"><td>{{ item.createdAt }}</td><td><span class="state-chip">{{ item.level }}</span></td><td>{{ item.category }}</td><td>{{ item.message }}</td><td>{{ JSON.stringify(item.details) }}</td></tr></tbody></table><div v-if="!logs.length" class="empty-state">暂无日志。</div></div>
  </section>
</template>
