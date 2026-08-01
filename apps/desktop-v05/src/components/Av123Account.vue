<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { enqueueChromeFavorites, getChromeBridgeInfo, openAv123AccountWindow, openChromeExtensionFolder, takeChromeResults, updateContentResult, writeTextFile } from "../api";
import { save } from "@tauri-apps/plugin-dialog";
import type { ChromeBridgeInfo, ContentResult } from "../types";
import SpreadsheetTable, { type SpreadsheetColumn } from "./SpreadsheetTable.vue";

const props = defineProps<{ results: ContentResult[] }>();
const mode = ref<"extension" | "internal" | "export">("extension");
const bridge = ref<ChromeBridgeInfo | null>(null);
const running = ref(false);
const done = ref(0);
const total = ref(0);
const status = ref("");
const error = ref("");
const internalIndex = ref(0);
const selected = ref(new Set<number>());
const candidates = computed(() => props.results.filter((item) => item.status === "succeeded" && /^https:\/\/(?:www\.)?123av\.com\/[a-z]{2}\/v\//i.test(item.secondaryValue)));
const operationCandidates = computed(() => selected.value.size ? candidates.value.filter((item) => selected.value.has(item.id)) : candidates.value);
const columns: SpreadsheetColumn[] = [
  { title: "ID", field: "id", width: 76, editable: false, filterable: false }, { title: "番号", field: "primaryValue", width: 180, editable: false },
  { title: "详情链接", field: "secondaryValue", width: 380, editable: false, longText: true }, { title: "状态", field: "status", width: 170, editable: false },
  { title: "错误 / 备注", field: "error", width: 340, editable: false, longText: true },
];
const candidateRows = computed(() => candidates.value as unknown as Array<Record<string, unknown>>);
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function copyPairing() { if (!bridge.value?.available) return; await navigator.clipboard.writeText(bridge.value.pairingCode); status.value = "配对码已复制。"; }
async function waitResult(taskId: number) {
  for (let attempt = 0; attempt < 240; attempt += 1) { const found = await takeChromeResults([taskId]); if (found[String(taskId)]) return found[String(taskId)]; await sleep(500); }
  return { status: "network_error", error: "等待 Chrome 扩展返回超时" };
}
async function persist(item: ContentResult, result: Record<string, unknown>) {
  const nextStatus = String(result.status || "verify_required"); const nextError = String(result.error || "");
  await updateContentResult(item.id, "status", `favorite_${nextStatus}`);
  await updateContentResult(item.id, "error", nextError);
  await updateContentResult(item.id, "metadata_json", { ...item.metadata, favorite: result.metadata || {}, favoriteStatus: nextStatus });
  item.status = `favorite_${nextStatus}`; item.error = nextError;
}
async function runExtension() {
  if (!operationCandidates.value.length || running.value) return;
  if (!bridge.value?.available) { error.value = bridge.value?.error || "Chrome 扩展桥当前不可用"; return; }
  running.value = true; done.value = 0; total.value = operationCandidates.value.length; error.value = "";
  try {
    for (const item of operationCandidates.value) {
      let result: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const [taskId] = await enqueueChromeFavorites([{ code: item.primaryValue, url: item.secondaryValue, workerId: 0 }]);
        result = await waitResult(taskId);
        if (result.status !== "network_error") break;
        status.value = `${item.primaryValue} 遇到访问/网络限制，休息 10 秒后自动续跑（${attempt + 1}/3）`;
        await sleep(10_000);
      }
      await persist(item, result); done.value += 1; status.value = `Chrome 串行收藏：${done.value}/${total.value}。同站始终只有一路。`;
    }
  } catch (reason) { error.value = String(reason); }
  finally { running.value = false; }
}
async function exportTasks() {
  const path = await save({ title: "导出 123AV 收藏任务", defaultPath: `123av-favorites-${Date.now()}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] }); if (!path) return;
  const rows = ["code,url", ...operationCandidates.value.map((item) => `"${item.primaryValue}","${item.secondaryValue}"`)]; await writeTextFile(path, `\uFEFF${rows.join("\r\n")}`); status.value = `已导出 ${operationCandidates.value.length} 条。`;
}
const internalCurrent = computed(() => operationCandidates.value[internalIndex.value] || null);
async function openInternalCurrent() {
  if (!internalCurrent.value) return;
  await openAv123AccountWindow(internalCurrent.value.secondaryValue);
  status.value = `已打开 ${internalCurrent.value.primaryValue}。请在内置账号窗口人工确认收藏后，回到这里标记结果。`;
}
async function finishInternal(statusValue: "succeeded" | "network_error" | "verify_required") {
  const item = internalCurrent.value; if (!item) return;
  await persist(item, { status: statusValue, error: statusValue === "succeeded" ? "" : "内置账号窗口人工标记" });
  internalIndex.value += 1;
  status.value = internalCurrent.value ? `已记录，下一条为 ${internalCurrent.value.primaryValue}` : "内置串行助手已处理完当前队列。";
}
onMounted(async () => { bridge.value = await getChromeBridgeInfo(); if (!bridge.value.available) error.value = bridge.value.error; });
</script>
<template>
  <div v-if="error" class="notice danger">{{ error }}</div><div v-if="status" class="notice info">{{ status }}</div>
  <section class="panel account-modes"><div class="section-heading"><div><span class="section-kicker">账号操作</span><h2>收藏方式</h2></div><strong>{{ candidates.length }} 条可收藏</strong></div>
    <SpreadsheetTable table-id="av123-account-candidates" :rows="candidateRows" :columns="columns" :editable="false" :selected-keys="[...selected]" :total-selected="selected.size" height="300px" empty-text="当前任务没有查询成功、可进入账号操作的 123AV 链接。" @selection-change="selected = new Set($event.map(Number)); internalIndex = 0" @clear-all-selection="selected = new Set(); internalIndex = 0" />
    <div class="mode-grid"><button :class="{ active: mode === 'extension' }" @click="mode = 'extension'"><strong>Chrome 扩展</strong><small>推荐；复用本地 Chrome 登录状态，串行收藏，异常休息 10 秒续跑</small></button><button :class="{ active: mode === 'internal' }" @click="mode = 'internal'"><strong>APP 内串行助手</strong><small>独立账号窗口；每次只打开一条，人工确认后记录结果</small></button><button :class="{ active: mode === 'export' }" @click="mode = 'export'"><strong>仅导出</strong><small>不访问账号，只导出番号和已验证详情链接</small></button></div>
    <div v-if="mode === 'extension'" class="mode-detail"><p>首次使用：打开下方扩展目录，在 Chrome 的“管理扩展程序”中开启开发者模式并“加载已解压的扩展程序”，再把配对码粘贴到扩展。扩展文件由 EXE 自动释放，无需项目源码。</p><p v-if="bridge && !bridge.available" class="field-hint">{{ bridge.error }}</p><div class="code-box">{{ bridge?.available ? bridge.pairingCode : 'Chrome 扩展桥不可用' }}</div><div class="action-row"><button class="quiet-button" :disabled="!bridge?.available" @click="openChromeExtensionFolder">打开扩展目录</button><button class="quiet-button" :disabled="!bridge?.available" @click="copyPairing">复制配对码</button><button class="primary-button" :disabled="running || !candidates.length || !bridge?.available" @click="runExtension">{{ running ? `${done}/${total}` : '开始串行收藏' }}</button></div></div>
    <div v-else-if="mode === 'internal'" class="mode-detail"><p>内置窗口的登录态与 Chrome 分离，应用不会读取 Cookie、密码、Local Storage 或 Session Storage。它严格一次一条：打开当前详情页，你手动点击收藏，再回到此处记录结果；不会和 Chrome 扩展抢任务。</p><p v-if="internalCurrent"><strong>当前 {{ internalIndex + 1 }} / {{ candidates.length }}：{{ internalCurrent.primaryValue }}</strong></p><p v-else>当前可收藏队列已处理完。</p><div class="action-row"><button class="primary-button" :disabled="!internalCurrent" @click="openInternalCurrent">打开当前详情页</button><button class="quiet-button" :disabled="!internalCurrent" @click="finishInternal('succeeded')">已收藏，下一条</button><button class="quiet-button" :disabled="!internalCurrent" @click="finishInternal('verify_required')">待核验，下一条</button><button class="danger-button" :disabled="!internalCurrent" @click="finishInternal('network_error')">网络问题，下一条</button><button class="quiet-button" @click="openAv123AccountWindow('')">仅打开账号窗口</button></div></div>
    <div v-else class="mode-detail"><p>导出适合交给其他脚本、浏览器控制台或人工处理，不会触发任何网站请求。</p><button class="primary-button" :disabled="!candidates.length" @click="exportTasks">导出 CSV</button></div>
  </section>
</template>
