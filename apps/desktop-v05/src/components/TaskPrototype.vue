<script setup lang="ts">
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  cancelDemoTask,
  createDemoTask,
  listDemoTasks,
  pauseDemoTask,
  startDemoTask,
} from "../api";
import type { TaskProgress, TaskSummary } from "../types";

const tasks = ref<TaskSummary[]>([]);
const total = ref(400);
const delayMs = ref(25);
const currentItem = ref<Record<number, string>>({});
const message = ref("任务进度逐项写入 SQLite；退出应用后可从最后一项继续。 ");
const busy = ref(false);
let unlisten: UnlistenFn | undefined;

const activeCount = computed(
  () => tasks.value.filter((task) => task.status === "running").length,
);

function replaceTask(task: TaskSummary) {
  const index = tasks.value.findIndex((item) => item.id === task.id);
  if (index >= 0) tasks.value.splice(index, 1, task);
  else tasks.value.unshift(task);
}

async function refresh() {
  try {
    tasks.value = await listDemoTasks();
  } catch (error) {
    message.value = `读取任务失败：${String(error)}`;
  }
}

async function createAndStart() {
  busy.value = true;
  try {
    const taskId = await createDemoTask(total.value, delayMs.value);
    await refresh();
    await startDemoTask(taskId);
    message.value = `任务 #${taskId} 已创建并开始。现在可以测试暂停、继续或直接关闭应用。`;
  } catch (error) {
    message.value = `创建任务失败：${String(error)}`;
  } finally {
    busy.value = false;
  }
}

async function runAction(action: "start" | "pause" | "cancel", task: TaskSummary) {
  try {
    if (action === "start") await startDemoTask(task.id);
    if (action === "pause") await pauseDemoTask(task.id);
    if (action === "cancel") await cancelDemoTask(task.id);
    await refresh();
  } catch (error) {
    message.value = `操作失败：${String(error)}`;
  }
}

function progress(task: TaskSummary) {
  if (!task.total) return 0;
  return Math.min(100, Math.round(((task.completed + task.failed) / task.total) * 100));
}

function statusLabel(status: TaskSummary["status"]) {
  return {
    pending: "等待开始",
    running: "运行中",
    paused: "已暂停",
    completed: "已完成",
    cancelled: "已取消",
  }[status];
}

onMounted(async () => {
  await refresh();
  unlisten = await listen<TaskProgress>("prototype-task-progress", (event) => {
    replaceTask(event.payload.task);
    if (event.payload.currentItem) {
      currentItem.value[event.payload.task.id] = event.payload.currentItem;
    }
  });
});

onBeforeUnmount(() => unlisten?.());
</script>

<template>
  <section class="page-intro compact">
    <div>
      <span class="section-kicker">稳定性原型</span>
      <h2>后台任务不是页面动画，而是可恢复的数据</h2>
      <p>每个项目有独立状态；暂停、意外退出和重新打开不会把整批重新跑一遍。</p>
    </div>
    <div class="inline-stat">
      <strong>{{ activeCount }}</strong>
      <span>正在运行</span>
    </div>
  </section>

  <section class="task-builder panel">
    <label>
      <span>测试项目数</span>
      <input v-model.number="total" type="number" min="1" max="20000" />
    </label>
    <label>
      <span>每项模拟耗时（毫秒）</span>
      <input v-model.number="delayMs" type="number" min="1" max="5000" />
    </label>
    <button class="primary-button" :disabled="busy" @click="createAndStart">
      {{ busy ? "正在创建…" : "新建并开始任务" }}
    </button>
    <button class="quiet-button" @click="refresh">刷新列表</button>
  </section>

  <div class="notice info">{{ message }}</div>

  <section class="task-list">
    <article v-for="task in tasks" :key="task.id" class="task-card">
      <div class="task-card-head">
        <div>
          <span class="task-id">任务 #{{ task.id }}</span>
          <h3>{{ task.kind }}</h3>
        </div>
        <span class="state-chip" :class="task.status">{{ statusLabel(task.status) }}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: progress(task) + '%' }"></div>
      </div>
      <div class="task-metrics">
        <strong>{{ progress(task) }}%</strong>
        <span>{{ task.completed.toLocaleString() }} / {{ task.total.toLocaleString() }}</span>
        <span v-if="task.failed">失败 {{ task.failed }}</span>
        <span v-if="currentItem[task.id]">当前 {{ currentItem[task.id] }}</span>
      </div>
      <p>{{ task.message }}</p>
      <div class="action-row">
        <button
          v-if="task.status === 'pending' || task.status === 'paused'"
          class="primary-button small"
          @click="runAction('start', task)"
        >
          {{ task.status === "paused" ? "继续" : "开始" }}
        </button>
        <button
          v-if="task.status === 'running'"
          class="quiet-button small"
          @click="runAction('pause', task)"
        >暂停</button>
        <button
          v-if="!['completed', 'cancelled'].includes(task.status)"
          class="danger-button small"
          @click="runAction('cancel', task)"
        >取消</button>
      </div>
    </article>
    <div v-if="tasks.length === 0" class="empty-state">还没有任务。创建一批后可测试暂停与恢复。</div>
  </section>
</template>
