<script setup lang="ts">
import { open, save } from "@tauri-apps/plugin-dialog";
import { computed, onMounted, ref, watch } from "vue";
import {
  createContentRun, deleteContentResults, deleteContentRun, getContentRun,
  fetchSitePage, getAppSetting, listContentRuns, readInputFiles, renameContentRun, updateContentResult, writeTextFile,
} from "../api";
import { legacyAv123, legacyFetcher } from "../legacyCore";
import { processToolInput, resultText, secondaryResultText } from "../processing";
import type { ContentResult, ResultInput, RunSummary, ToolKind } from "../types";
import RaindropSync from "./RaindropSync.vue";
import Av123Account from "./Av123Account.vue";

const props = defineProps<{ tool: ToolKind }>();

const configs: Record<ToolKind, { title: string; description: string; primary: string; secondary: string }> = {
  twitter: { title: "推特博主", description: "从消息 #标签、@提及与 X/Twitter 链接提取博主主页。", primary: "博主名", secondary: "主页链接" },
  badnews: { title: "Bad.news 帖子", description: "只保留可直接访问的帖子链接，排除官网 App 与无关地址。", primary: "帖子链接", secondary: "" },
  haijiao: { title: "海角帖子", description: "提取海角内容帖直达链接，过滤广告、首页和其他垃圾链接。", primary: "帖子链接", secondary: "" },
  missav: { title: "MissAV", description: "提取并规范番号，保存永久历史；网站查询与 Raindrop 在独立操作区执行。", primary: "番号", secondary: "来源链接" },
  av123: { title: "123AV", description: "提取并规范番号；查询和账号收藏与 MissAV 完全独立。", primary: "番号", secondary: "详情链接" },
};

const config = computed(() => configs[props.tool]);
const tab = ref<"input" | "results" | "raindrop" | "account" | "history">("input");
const pasteText = ref("");
const files = ref<Array<{ name: string; text: string; path?: string; error?: string }>>([]);
const startAt = ref("");
const endAt = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");
const activeRunId = ref<number | null>(null);
const results = ref<ContentResult[]>([]);
const runs = ref<RunSummary[]>([]);
const historySearch = ref("");
const resultSearch = ref("");
const selected = ref(new Set<number>());
const lastSelectedIndex = ref(-1);
const queryRunning = ref(false);
const queryDone = ref(0);
const queryTotal = ref(0);
const queryStartedAt = ref(0);
const queryNow = ref(0);

const visibleResults = computed(() => {
  const needle = resultSearch.value.trim().toLowerCase();
  if (!needle) return results.value;
  return results.value.filter((item) => [item.primaryValue, item.secondaryValue, item.status, item.tags.join(" "), item.error, item.source]
    .some((value) => value.toLowerCase().includes(needle)));
});

const inputKind = computed(() => pasteText.value.trim() && files.value.length ? "paste+files" : files.value.length ? "files" : "paste");
const primaryOutput = computed(() => resultText(props.tool, currentResultInputs()));
const secondaryOutput = computed(() => secondaryResultText(props.tool, currentResultInputs()));
const queryMetrics = computed(() => {
  const elapsed = queryStartedAt.value ? Math.max(.001, (queryNow.value - queryStartedAt.value) / 1000) : 0;
  const rate = queryDone.value && elapsed ? queryDone.value / elapsed : 0;
  const eta = rate ? Math.ceil((queryTotal.value - queryDone.value) / rate) : 0;
  return { rate, eta };
});
const inputDocuments = computed(() => [
  ...(pasteText.value.trim() ? [{ name: "粘贴内容", text: pasteText.value }] : []),
  ...files.value.filter((file) => !file.error).map((file) => ({ name: file.name, text: file.text })),
]);

async function chooseFiles() {
  const chosen = await open({
    multiple: true,
    directory: false,
    title: `选择${config.value.title}输入文件（可多选）`,
    filters: [{ name: "文本与 Telegram 导出", extensions: ["html", "htm", "json", "txt", "csv", "md", "log"] }],
  });
  const paths = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
  if (!paths.length) return;
  busy.value = true;
  error.value = "";
  try {
    const loaded = await readInputFiles(paths);
    files.value.push(...loaded.map((file) => ({ name: file.name, text: file.text, path: file.path, error: file.error })));
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

function removeFile(index: number) { files.value.splice(index, 1); }

async function processInput() {
  if (!inputDocuments.value.length) { error.value = "请粘贴内容或至少选择一个文件。"; return; }
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const processed = processToolInput(props.tool, inputDocuments.value, startAt.value, endAt.value);
    const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });
    const runId = await createContentRun({
      tool: props.tool,
      name: `${config.value.title} ${timestamp}`,
      inputKind: inputKind.value,
      originalInput: inputDocuments.value.map((item) => `===== ${item.name} =====\n${item.text}`).join("\n\n"),
      startAt: startAt.value,
      endAt: endAt.value,
      options: { files: files.value.map((item) => item.name), parsedMessages: processed.messages.length },
      results: processed.results,
    });
    await loadRun(runId);
    await refreshHistory();
    notice.value = `已保存任务，提取 ${results.value.length.toLocaleString()} 条结果。原始输入、结果和时间范围均已进入永久历史。`;
    tab.value = "results";
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

async function refreshHistory() {
  runs.value = await listContentRuns(props.tool, historySearch.value, 500);
}

async function loadRun(id: number) {
  const detail = await getContentRun(id);
  activeRunId.value = id;
  results.value = detail.results;
  selected.value = new Set();
  tab.value = "results";
}

async function editCell(item: ContentResult, field: "primary_value" | "secondary_value" | "status" | "tags_json" | "error", event: Event) {
  const target = event.target as HTMLInputElement;
  const raw = target.value;
  const value: unknown = field === "tags_json" ? raw.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) : raw;
  try {
    await updateContentResult(item.id, field, value);
    if (field === "primary_value") item.primaryValue = raw;
    else if (field === "secondary_value") item.secondaryValue = raw;
    else if (field === "status") item.status = raw;
    else if (field === "tags_json") item.tags = value as string[];
    else item.error = raw;
  } catch (reason) { error.value = String(reason); }
}

function selectRow(event: MouseEvent, item: ContentResult, index: number) {
  const next = new Set(event.ctrlKey || event.shiftKey ? selected.value : []);
  if (event.shiftKey && lastSelectedIndex.value >= 0) {
    const [start, end] = [lastSelectedIndex.value, index].sort((a, b) => a - b);
    visibleResults.value.slice(start, end + 1).forEach((row) => next.add(row.id));
  } else if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  selected.value = next;
  lastSelectedIndex.value = index;
}

function selectVisible() { selected.value = new Set(visibleResults.value.map((item) => item.id)); }

async function removeSelected() {
  if (!selected.value.size || !confirm(`确定删除选中的 ${selected.value.size} 条结果吗？删除前会自动备份。`)) return;
  await deleteContentResults([...selected.value]);
  results.value = results.value.filter((item) => !selected.value.has(item.id));
  selected.value = new Set();
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function requestWithRetry(url: string, proxy: string) {
  let last: Awaited<ReturnType<typeof fetchSitePage>> | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      last = await fetchSitePage(url, proxy, 20_000);
      if (![408, 425, 429].includes(last.statusCode) && last.statusCode < 500) return last;
      lastError = `HTTP ${last.statusCode}`;
    } catch (reason) { lastError = String(reason); }
    await sleep(900 * (2 ** attempt));
  }
  if (last) return last;
  throw new Error(lastError || "网络请求失败");
}

async function persistQueryResult(item: ContentResult, patch: { status: string; url: string; tags?: string[]; error: string; metadata?: Record<string, unknown> }) {
  await updateContentResult(item.id, "status", patch.status);
  await updateContentResult(item.id, "secondary_value", patch.url);
  await updateContentResult(item.id, "tags_json", patch.tags || []);
  await updateContentResult(item.id, "error", patch.error);
  await updateContentResult(item.id, "metadata_json", patch.metadata || {});
  item.status = patch.status; item.secondaryValue = patch.url; item.tags = patch.tags || []; item.error = patch.error; item.metadata = patch.metadata || {};
}

async function queryOne(item: ContentResult, proxy: string) {
  const code = item.primaryValue;
  if (props.tool === "missav") {
    const url = item.secondaryValue && /missav\.(?:ai|ws)/i.test(item.secondaryValue) ? item.secondaryValue : `https://missav.ai/cn/${code.toLowerCase()}`;
    try {
      const page = await requestWithRetry(url, proxy);
      const candidate = legacyFetcher.classifyCandidateResponse({ ...page, statusCode: page.statusCode }, code, url);
      const metadata = candidate.html ? legacyFetcher.extractMetadata(candidate.html, code, candidate.url || url) : { status: candidate.status, actresses: [], genres: [] };
      const tags = [...new Set([...metadata.actresses, ...metadata.genres])];
      await persistQueryResult(item, { status: candidate.status, url: candidate.url || url, tags, error: candidate.error || "", metadata: { actresses: metadata.actresses, genres: metadata.genres, statusCode: candidate.statusCode } });
    } catch (reason) { await persistQueryResult(item, { status: "network_error", url, error: String(reason) }); }
    return;
  }
  const attempts: Array<Record<string, unknown>> = [];
  const candidates = legacyAv123.buildDetailCandidateUrls(code, "cn");
  for (const url of candidates) {
    try {
      const page = await requestWithRetry(url, proxy);
      const classified = legacyAv123.classifyResponse({ ...page, statusCode: page.statusCode }, code, url) as { status: string; url: string; error: string; metadata?: Record<string, unknown> };
      attempts.push(classified as unknown as Record<string, unknown>);
      if (classified.status === "succeeded") { await persistQueryResult(item, { status: "succeeded", url: classified.url || url, error: "", metadata: classified.metadata }); return; }
      if (classified.status === "network_error") break;
    } catch (reason) { attempts.push({ status: "network_error", url, error: String(reason) }); break; }
  }
  const network = attempts.find((attempt) => attempt.status === "network_error");
  await persistQueryResult(item, { status: network ? "network_error" : "not_found", url: String(network?.url || ""), error: String(network?.error || ""), metadata: { attempts: attempts.length } });
}

async function runWebsiteQuery(scope: "all" | "selected") {
  if (queryRunning.value || (props.tool !== "missav" && props.tool !== "av123")) return;
  const target = (scope === "selected" && selected.value.size ? results.value.filter((item) => selected.value.has(item.id)) : results.value)
    .filter((item) => ["pending", "network_error", "manual", "need_manual_check"].includes(item.status));
  if (!target.length) { notice.value = "当前范围没有待查询或可重试记录。"; return; }
  const settings = await getAppSetting<{ proxyEnabled?: boolean; proxyUrl?: string; missavConcurrency?: number; missavRps?: number; av123Concurrency?: number; av123Rps?: number }>("runtime") || {};
  const concurrency = Math.max(1, Math.min(32, props.tool === "missav" ? settings.missavConcurrency || 16 : settings.av123Concurrency || 16));
  const rps = Math.max(.2, props.tool === "missav" ? settings.missavRps || 12 : settings.av123Rps || 4);
  const proxy = settings.proxyEnabled ? settings.proxyUrl || "" : "";
  queryRunning.value = true; queryDone.value = 0; queryTotal.value = target.length; queryStartedAt.value = performance.now(); queryNow.value = queryStartedAt.value; error.value = "";
  let cursor = 0; let nextStart = performance.now();
  const take = async () => {
    while (cursor < target.length) {
      const index = cursor++;
      const wait = Math.max(0, nextStart - performance.now());
      nextStart = Math.max(nextStart, performance.now()) + 1000 / rps;
      if (wait) await sleep(wait);
      await queryOne(target[index], proxy);
      queryDone.value += 1; queryNow.value = performance.now();
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(concurrency, target.length) }, take)); notice.value = `${config.value.title} 查询完成：${queryDone.value}/${queryTotal.value}。网络异常可再次按当前选择重跑。`; }
  catch (reason) { error.value = String(reason); }
  finally { queryRunning.value = false; }
}

function currentResultInputs(): ResultInput[] {
  return visibleResults.value.map((item) => ({
    resultKey: item.resultKey, primaryValue: item.primaryValue, secondaryValue: item.secondaryValue,
    status: item.status, tags: item.tags, error: item.error, source: item.source, metadata: item.metadata,
  }));
}

async function copyOutput(secondary = false) {
  const text = secondary ? secondaryResultText(props.tool, currentResultInputs()) : resultText(props.tool, currentResultInputs());
  await navigator.clipboard.writeText(text);
  notice.value = `已复制 ${text ? text.split("\n").length : 0} 行。`;
}

function csvCell(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
async function exportResults(format: "txt" | "csv") {
  const path = await save({ title: `导出${config.value.title}结果`, defaultPath: `${props.tool}-${Date.now()}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (!path) return;
  const rows = visibleResults.value;
  const content = format === "txt"
    ? resultText(props.tool, currentResultInputs())
    : ["primary,secondary,status,tags,error,source", ...rows.map((item) => [item.primaryValue, item.secondaryValue, item.status, item.tags.join(","), item.error, item.source].map(csvCell).join(","))].join("\r\n");
  await writeTextFile(path, `\uFEFF${content}`);
  notice.value = `已导出 ${rows.length} 条到 ${path}`;
}

async function renameRun(run: RunSummary) {
  const value = prompt("新的任务名称", run.name)?.trim();
  if (!value) return;
  await renameContentRun(run.id, value);
  await refreshHistory();
}

async function removeRun(run: RunSummary) {
  if (!confirm(`确定删除任务“${run.name}”及其结果吗？删除前会自动备份。`)) return;
  await deleteContentRun(run.id);
  if (activeRunId.value === run.id) { activeRunId.value = null; results.value = []; }
  await refreshHistory();
}

watch(() => props.tool, async () => {
  tab.value = "input"; results.value = []; activeRunId.value = null; error.value = ""; notice.value = "";
  await refreshHistory();
});
watch(historySearch, () => { void refreshHistory(); });
onMounted(refreshHistory);
</script>

<template>
  <section class="page-intro compact">
    <div><span class="section-kicker">独立内容工具</span><h2>{{ config.title }}</h2><p>{{ config.description }}</p></div>
    <div class="inline-stat"><strong>{{ runs.length }}</strong><span>历史任务</span></div>
  </section>

  <nav class="local-tabs">
    <button :class="{ active: tab === 'input' }" @click="tab = 'input'">1 输入</button>
    <button :class="{ active: tab === 'results' }" @click="tab = 'results'">2 结果</button>
    <button v-if="tool === 'missav'" :class="{ active: tab === 'raindrop' }" @click="tab = 'raindrop'">3 Raindrop</button>
    <button v-if="tool === 'av123'" :class="{ active: tab === 'account' }" @click="tab = 'account'">3 账号操作</button>
    <button :class="{ active: tab === 'history' }" @click="tab = 'history'">{{ tool === 'missav' || tool === 'av123' ? 4 : 3 }} 历史</button>
  </nav>
  <div v-if="error" class="notice danger">{{ error }}</div>
  <div v-if="notice" class="notice info">{{ notice }}</div>

  <section v-if="tab === 'input'" class="panel input-workspace">
    <div class="form-grid two">
      <label>开始时间（可选，精确到分钟）<input v-model="startAt" type="datetime-local" /></label>
      <label>结束时间（可选，精确到分钟）<input v-model="endAt" type="datetime-local" /></label>
    </div>
    <label class="stack-field">粘贴 TG 消息、文本、CSV 内容或番号<textarea v-model="pasteText" rows="10" placeholder="直接粘贴；也可以留空并选择多个文件"></textarea></label>
    <div class="action-row"><button class="quiet-button" @click="chooseFiles">选择多个文件</button><button class="primary-button" :disabled="busy || !inputDocuments.length" @click="processInput">{{ busy ? "处理中…" : "提取并保存历史" }}</button></div>
    <div v-if="files.length" class="file-list">
      <div v-for="(file, index) in files" :key="`${file.name}-${index}`" :class="['file-row', { failed: file.error }]">
        <span>{{ file.name }}</span><small>{{ file.error || `${file.text.length.toLocaleString()} 字符` }}</small><button class="quiet-button small" @click="removeFile(index)">移除</button>
      </div>
    </div>
  </section>

  <section v-else-if="tab === 'results'" class="panel results-workspace">
    <div class="grid-toolbar result-tools">
      <label class="search-box">自由搜索<input v-model="resultSearch" placeholder="番号、链接、状态、标签、错误、来源均可搜索" /></label>
      <strong>{{ visibleResults.length.toLocaleString() }} / {{ results.length.toLocaleString() }} 条</strong>
      <button class="quiet-button small" @click="selectVisible">全选当前</button>
      <button class="danger-button small" :disabled="!selected.size" @click="removeSelected">删除 {{ selected.size || "" }}</button>
      <button class="quiet-button small" @click="copyOutput(false)">复制主结果</button>
      <button v-if="tool === 'twitter'" class="quiet-button small" @click="copyOutput(true)">复制链接</button>
      <button class="quiet-button small" @click="exportResults('txt')">TXT</button>
      <button class="quiet-button small" @click="exportResults('csv')">CSV</button>
      <template v-if="tool === 'missav' || tool === 'av123'">
        <button class="primary-button small" :disabled="queryRunning" @click="runWebsiteQuery('all')">{{ queryRunning ? `${queryDone}/${queryTotal}` : `查询 ${config.title}` }}</button>
        <button class="quiet-button small" :disabled="queryRunning || !selected.size" @click="runWebsiteQuery('selected')">重跑选中异常</button>
      </template>
    </div>
    <div v-if="queryRunning" class="query-progress"><span :style="{ width: `${queryTotal ? queryDone / queryTotal * 100 : 0}%` }"></span></div>
    <div v-if="queryRunning" class="status-line">真实完成速度 {{ queryMetrics.rate.toFixed(2) }} 条/秒 · 预计剩余 {{ queryMetrics.eta }} 秒 · {{ queryDone }}/{{ queryTotal }}</div>
    <details class="plain-output"><summary>纯文本输出（一行一个，可直接全选复制）</summary><div :class="['plain-output-grid', { two: tool === 'twitter' }]"><label>{{ config.primary }}<textarea :value="primaryOutput" readonly rows="8"></textarea></label><label v-if="tool === 'twitter'">{{ config.secondary }}<textarea :value="secondaryOutput" readonly rows="8"></textarea></label></div></details>
    <div class="editable-table-wrap">
      <table class="editable-table">
        <thead><tr><th>选</th><th>{{ config.primary }}</th><th v-if="config.secondary">{{ config.secondary }}</th><th>状态</th><th>标签</th><th>错误/备注</th><th>来源</th></tr></thead>
        <tbody>
          <tr v-for="(item, index) in visibleResults" :key="item.id" :class="{ selected: selected.has(item.id) }" @click="selectRow($event, item, index)">
            <td><input type="checkbox" :checked="selected.has(item.id)" /></td>
            <td><input :value="item.primaryValue" @click.stop @change="editCell(item, 'primary_value', $event)" /></td>
            <td v-if="config.secondary"><input :value="item.secondaryValue" @click.stop @change="editCell(item, 'secondary_value', $event)" /></td>
            <td><input :value="item.status" @click.stop @change="editCell(item, 'status', $event)" /></td>
            <td><input :value="item.tags.join(', ')" @click.stop @change="editCell(item, 'tags_json', $event)" /></td>
            <td><input :value="item.error" @click.stop @change="editCell(item, 'error', $event)" /></td>
            <td :title="item.source">{{ item.source }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!visibleResults.length" class="empty-state">没有结果。先在“输入”页处理内容，或从“历史”载入任务。</div>
    </div>
    <p class="selection-tip">单击选一行；Ctrl 单击增减选择；Shift 单击连续选择；Ctrl+Shift 可在已有选择上追加范围。</p>
  </section>

  <RaindropSync v-else-if="tab === 'raindrop' && tool === 'missav'" />
  <Av123Account v-else-if="tab === 'account' && tool === 'av123'" :results="results" />

  <section v-else class="panel history-workspace">
    <div class="grid-toolbar"><label class="search-box">搜索历史<input v-model="historySearch" placeholder="按任务名称搜索" /></label><strong>{{ runs.length }} 项</strong></div>
    <div class="history-list">
      <article v-for="run in runs" :key="run.id" class="history-row">
        <button class="history-main" @click="loadRun(run.id)"><strong>{{ run.name }}</strong><small>{{ run.createdAt }} · {{ run.resultCount }} 条 · {{ run.errorCount }} 异常</small></button>
        <button class="quiet-button small" @click="renameRun(run)">改名</button><button class="danger-button small" @click="removeRun(run)">删除</button>
      </article>
      <div v-if="!runs.length" class="empty-state">暂无匹配历史。</div>
    </div>
  </section>
</template>
