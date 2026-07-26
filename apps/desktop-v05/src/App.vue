<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from "vue";
import HomeView from "./components/HomeView.vue";
import { getPrototypeInfo } from "./api";
import type { PrototypeInfo, ViewName } from "./types";

const DataGridPrototype = defineAsyncComponent(() => import("./components/DataGridPrototype.vue"));
const TaskPrototype = defineAsyncComponent(() => import("./components/TaskPrototype.vue"));
const MigrationPrototype = defineAsyncComponent(() => import("./components/MigrationPrototype.vue"));

const currentView = ref<ViewName>("home");
const info = ref<PrototypeInfo | null>(null);
const startupError = ref("");

const titles: Record<ViewName, string> = {
  home: "工具首页",
  grid: "统一数据表",
  tasks: "可靠任务中心",
  migration: "v0.4.5 迁移检查",
};

const title = computed(() => titles[currentView.value]);

async function refreshInfo() {
  try {
    info.value = await getPrototypeInfo();
    startupError.value = "";
  } catch (error) {
    startupError.value = String(error);
  }
}

function navigate(view: ViewName) {
  currentView.value = view;
}

onMounted(refreshInfo);
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <button v-if="currentView !== 'home'" class="quiet-button" @click="navigate('home')">
        ← 工具首页
      </button>
      <div>
        <div class="eyebrow">TG CONTENT TOOLBOX NEXT</div>
        <h1>{{ title }}</h1>
      </div>
      <div class="topbar-meta">
        <span class="version-pill">v{{ info?.version ?? "0.5 alpha" }}</span>
        <span>独立原型库</span>
      </div>
    </header>

    <main class="workspace">
      <div v-if="startupError" class="notice danger">
        启动信息读取失败：{{ startupError }}
      </div>
      <div v-if="info?.recoveredTasks" class="notice warning">
        检测到 {{ info.recoveredTasks }} 个上次中断的任务或项目，已安全恢复为暂停状态。
      </div>

      <HomeView v-if="currentView === 'home'" :info="info" @navigate="navigate" />
      <DataGridPrototype
        v-else-if="currentView === 'grid'"
        @records-changed="refreshInfo"
      />
      <TaskPrototype v-else-if="currentView === 'tasks'" />
      <MigrationPrototype v-else />
    </main>

    <footer class="footer-bar">
      <span>v0.5 重构阶段 0：结构与技术验证</span>
      <span class="path-text" :title="info?.databasePath">{{ info?.databasePath }}</span>
    </footer>
  </div>
</template>
