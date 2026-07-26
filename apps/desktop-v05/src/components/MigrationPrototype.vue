<script setup lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { ref } from "vue";
import { analyzeLegacyDatabase, migrateLegacyDatabase } from "../api";
import type { LegacyMigrationResult, MigrationReport } from "../types";

const selectedPath = ref("");
const report = ref<MigrationReport | null>(null);
const busy = ref(false);
const error = ref("");
const migration = ref<LegacyMigrationResult | null>(null);
const replace = ref(false);

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

async function migrate() {
  if (!selectedPath.value || !report.value || report.value.integrityCheck.toLowerCase() !== "ok") return;
  if (!confirm("正式迁移会先备份 v0.5 数据库，再完整归档旧库所有业务表并映射核心数据。旧库始终只读。继续吗？")) return;
  busy.value = true; error.value = "";
  try { migration.value = await migrateLegacyDatabase(selectedPath.value, replace.value); }
  catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
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
      <span class="section-kicker">只读源 + 可恢复目标</span>
      <h2>检查并正式迁移 v0.4.5</h2>
      <p>旧库全程只读；正式迁移前自动备份 v0.5。所有旧表完整归档，同时把番号、标签、网站状态和 Telegram 来源映射到新数据中心。</p>
    </div>
  </section>

  <div class="notice warning">
    可以直接选择 v0.4.5 数据库，程序用 SQLite 只读模式打开；仍建议先复制一份以便人工留档。
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
    <section class="panel migration-action">
      <h3>正式执行</h3>
      <p class="muted">完整归档保证尚未映射的旧字段也不会丢失；可识别核心数据会立即出现在新数据中心。此操作不修改源数据库。</p>
      <label class="check-label"><input v-model="replace" type="checkbox" /> 已迁移过时，重新归档并覆盖核心映射</label>
      <button class="primary-button" :disabled="busy || report.integrityCheck.toLowerCase() !== 'ok'" @click="migrate">{{ busy ? "迁移中…" : "备份并正式迁移" }}</button>
    </section>
    <section v-if="migration" class="report-summary migration-result">
      <div><strong>{{ migration.archivedTables }}</strong><span>完整归档表</span></div><div><strong>{{ migration.archivedRows.toLocaleString() }}</strong><span>完整归档行</span></div><div><strong>{{ migration.missavRecords }}</strong><span>MissAV 记录</span></div><div><strong>{{ migration.av123Records }}</strong><span>123AV 记录</span></div><div><strong>{{ migration.telegramSources }}</strong><span>Telegram 来源</span></div>
    </section>
  </template>
</template>
