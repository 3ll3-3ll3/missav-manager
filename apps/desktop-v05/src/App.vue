<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from "vue";
import HomeView from "./components/HomeView.vue";
import { getAppInfo } from "./api";
import type { AppInfo, ViewName } from "./types";

const MigrationPrototype = defineAsyncComponent(() => import("./components/MigrationPrototype.vue"));
const ToolWorkspace = defineAsyncComponent(() => import("./components/ToolWorkspace.vue"));
const SourcesView = defineAsyncComponent(() => import("./components/SourcesView.vue"));
const SyncCenterView = defineAsyncComponent(() => import("./components/SyncCenterView.vue"));
const LogsView = defineAsyncComponent(() => import("./components/LogsView.vue"));
const SettingsView = defineAsyncComponent(() => import("./components/SettingsView.vue"));
const DataCenterView = defineAsyncComponent(() => import("./components/DataCenterView.vue"));
const TaskCenterView = defineAsyncComponent(() => import("./components/TaskCenterView.vue"));

const currentView = ref<ViewName>("home");
const info = ref<AppInfo | null>(null);
const startupError = ref("");
const requestedRunId = ref<number | null>(null);

const titles: Record<ViewName, string> = {
  home: "工具首页",
  tasks: "处理中心",
  migration: "v0.4.5 迁移检查",
  sources: "Telegram 来源",
  sync: "本地与云端同步",
  data: "统一数据中心",
  logs: "运行日志",
  settings: "设置与备份",
  "tool:twitter": "推特博主",
  "tool:badnews": "Bad.news 帖子",
  "tool:haijiao": "海角帖子",
  "tool:missav": "MissAV",
  "tool:av123": "123AV",
};

const title = computed(() => titles[currentView.value]);

async function refreshInfo() {
  try {
    info.value = await getAppInfo();
    startupError.value = "";
  } catch (error) {
    startupError.value = String(error);
  }
}

function navigate(view: ViewName) {
  currentView.value = view;
  if (!view.startsWith("tool:")) requestedRunId.value = null;
}

function openRun(tool: import("./types").ToolKind, runId: number) { requestedRunId.value = runId; currentView.value = `tool:${tool}`; }

const activeTool = computed(() => currentView.value.startsWith("tool:") ? currentView.value.slice(5) as import("./types").ToolKind : null);

onMounted(refreshInfo);
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <button v-if="currentView !== 'home'" class="quiet-button" @click="navigate('home')">
        ← 工具首页
      </button>
      <div>
        <div class="eyebrow">TG CONTENT TOOLBOX</div>
        <h1>{{ title }}</h1>
      </div>
      <div class="topbar-meta">
      <span class="version-pill">v{{ info?.version ?? "0.5" }}</span>
        <span>独立正式数据库</span>
      </div>
      <nav class="global-nav"><button @click="navigate('home')">工具</button><button @click="navigate('tasks')">处理</button><button @click="navigate('data')">数据</button><button @click="navigate('sources')">来源</button><button @click="navigate('sync')">同步</button><button @click="navigate('logs')">日志</button><button @click="navigate('settings')">设置</button></nav>
    </header>

    <main class="workspace">
      <div v-if="startupError" class="notice danger">
        启动信息读取失败：{{ startupError }}
      </div>
      <HomeView v-if="currentView === 'home'" :info="info" @navigate="navigate" />
      <ToolWorkspace v-else-if="activeTool" :tool="activeTool" :initial-run-id="requestedRunId" />
      <TaskCenterView v-else-if="currentView === 'tasks'" @open-run="openRun" />
      <DataCenterView v-else-if="currentView === 'data'" />
      <MigrationPrototype v-else-if="currentView === 'migration'" />
      <SourcesView v-else-if="currentView === 'sources'" />
      <SyncCenterView v-else-if="currentView === 'sync'" />
      <LogsView v-else-if="currentView === 'logs'" />
      <SettingsView v-else />
    </main>

    <footer class="footer-bar">
      <span>v0.5 工具箱主线 · 每个网站与文本工具独立工作</span>
      <span class="path-text" :title="info?.databasePath">{{ info?.databasePath }}</span>
    </footer>
  </div>
</template>
