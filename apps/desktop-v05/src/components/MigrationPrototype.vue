<script setup lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { ref } from "vue";
import { analyzeLegacyDatabase } from "../api";
import type { MigrationReport } from "../types";

const selectedPath = ref("");
const report = ref<MigrationReport | null>(null);
const busy = ref(false);
const error = ref("");

async function chooseDatabase() {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "选择 v0.4.5 数据库副本（只读检查）",
    filters: [
      { name: "SQLite 数据库", extensions: ["sqlite", "sqlite3", "db"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (typeof selected === "string") {
    selectedPath.value = selected;
    report.value = null;
    error.value = "";
  }
}

async function analyze() {
  if (!selectedPath.value) return;
  busy.value = true;
  error.value = "";
  try {
    report.value = await analyzeLegacyDatabase(selectedPath.value);
  } catch (reason) {
    report.value = null;
    error.value = String(reason);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page-intro compact">
    <div>
      <span class="section-kicker">零写入迁移原型</span>
      <h2>先看懂旧库，再决定迁移什么</h2>
      <p>当前功能只以 SQLite 只读模式打开副本，检查结构和规模；不会执行正式迁移。</p>
    </div>
  </section>

  <div class="notice warning">
    请先复制一份 v0.4.5 数据库再选择。虽然程序强制只读，但副本能进一步隔离误操作风险。
  </div>

  <section class="migration-picker panel">
    <button class="quiet-button" @click="chooseDatabase">选择数据库副本</button>
    <div class="selected-path" :title="selectedPath">
      {{ selectedPath || "尚未选择文件" }}
    </div>
    <button class="primary-button" :disabled="!selectedPath || busy" @click="analyze">
      {{ busy ? "检查中…" : "生成只读报告" }}
    </button>
  </section>

  <div v-if="error" class="notice danger">{{ error }}</div>

  <template v-if="report">
    <section class="report-summary">
      <div><strong>{{ report.integrityCheck }}</strong><span>完整性检查</span></div>
      <div><strong>{{ report.tables.length }}</strong><span>业务表</span></div>
      <div><strong>{{ report.totalRows.toLocaleString() }}</strong><span>合计行数</span></div>
      <div><strong>{{ report.userVersion }}</strong><span>Schema 版本</span></div>
      <div><strong>{{ report.journalMode }}</strong><span>日志模式</span></div>
    </section>

    <section class="panel report-panel">
      <div class="section-heading">
        <div>
          <span class="section-kicker">候选映射</span>
          <h2>旧表会去哪里</h2>
        </div>
      </div>
      <div class="report-table-wrap">
        <table class="report-table">
          <thead>
            <tr><th>旧表</th><th>行数</th><th>v0.5 目标区域</th><th>识别</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="mapping in report.mappings" :key="mapping.sourceTable">
              <td>{{ mapping.sourceTable }}</td>
              <td>{{ mapping.rows.toLocaleString() }}</td>
              <td>{{ mapping.targetArea }}</td>
              <td><span class="state-chip" :class="mapping.recognized ? 'completed' : 'paused'">{{ mapping.recognized ? "是" : "待确认" }}</span></td>
              <td>{{ mapping.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h3>正式迁移前警告</h3>
      <ul class="warning-list">
        <li v-for="warning in report.warnings" :key="warning">{{ warning }}</li>
      </ul>
    </section>
  </template>
</template>
