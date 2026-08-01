<script setup lang="ts">
import { open, save } from "@tauri-apps/plugin-dialog";
import { computed, onMounted, ref, watch } from "vue";
import {
  createContentRun, deleteContentResults, deleteContentRun, getContentRun,
  fetchSitePage, getAppSetting, listContentRuns, readInputFiles, recordScriptGeneration, renameContentRun, setAppSetting, updateContentResult, writeTextFile,
} from "../api";
import { legacyAv123 } from "../legacyCore";
import { processToolInput, resultText, secondaryResultText } from "../processing";
import { AdaptiveRateGate, type RateSnapshot } from "../rateControl";
import type { ContentResult, ResultInput, RunSummary, ToolKind } from "../types";
import { defaultMissavScriptTemplate, generateMissavBrowserScript, MISSAV_SCRIPT_TEMPLATE_SETTING } from "../missavScript";
import {
  MISSAV_REFERENCE_TAGS_SETTING, normalizeMissavReferenceTagLibrary,
} from "../missavReferenceTags";
import { loadMissavBlacklistFileValues } from "../missavBlacklistFiles";
import Av123Account from "./Av123Account.vue";
import SpreadsheetTable, { type SpreadsheetColumn } from "./SpreadsheetTable.vue";
import TelegramToolWorkspace from "./TelegramToolWorkspace.vue";

const props = defineProps<{ tool: ToolKind; initialRunId?: number | null }>();

const configs: Record<ToolKind, { title: string; description: string; primary: string; secondary: string }> = {
  twitter: { title: "推特博主", description: "从消息 #标签、@提及与 X/Twitter 链接提取博主主页。", primary: "博主名", secondary: "主页链接" },
  badnews: { title: "Bad.news 帖子", description: "只保留可直接访问的帖子链接，排除官网 App 与无关地址。", primary: "帖子链接", secondary: "" },
  haijiao: { title: "海角帖子", description: "提取海角内容帖直达链接，过滤广告、首页和其他垃圾链接。", primary: "帖子链接", secondary: "" },
  missav: { title: "MissAV", description: "提取并规范番号，保存永久历史；生成完整浏览器脚本后由你手动粘贴运行。", primary: "番号", secondary: "来源链接" },
  av123: { title: "123AV", description: "提取并规范番号；查询和账号收藏与 MissAV 完全独立。", primary: "番号", secondary: "详情链接" },
};

const config = computed(() => configs[props.tool]);
const tab = ref<"input" | "results" | "script" | "account" | "history">("input");
const inputMode = ref<"manual" | "telegram">("manual");
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
const selectedRuns = ref(new Set<number>());
const queryRunning = ref(false);
const queryDone = ref(0);
const queryTotal = ref(0);
const queryStartedAt = ref(0);
const queryNow = ref(0);
const queryPhase = ref("");
const queryStopRequested = ref(false);
const queryRate = ref<RateSnapshot>({ targetRps: 0, currentRps: 0, cooldownMs: 0, rateLimitEvents: 0, congestionEvents: 0, lastSignal: "", blocked: false });
const generatedScript = ref("");
const generatedCodes = ref<string[]>([]);
const generatedTemplateVersion = ref("");
const generatedReferenceTagCount = ref(0);
const generatedReferenceBlacklistTagCount = ref(0);
const generatedExportBlacklistTagCount = ref(0);
const scriptGeneratedAt = ref("");

const resultColumns = computed<SpreadsheetColumn[]>(() => [
  { title: "ID", field: "id", width: 76, editable: false, filterable: false },
  { title: config.value.primary, field: "primaryValue", width: 175 },
  ...(config.value.secondary ? [{ title: config.value.secondary, field: "secondaryValue", width: 310, longText: true } as SpreadsheetColumn] : []),
  { title: "状态", field: "status", width: 145 },
  { title: "标签", field: "tags", width: 280, longText: true },
  { title: "错误 / 备注", field: "error", width: 330, longText: true },
  { title: "来源", field: "source", width: 320, longText: true },
  { title: "元数据", field: "metadata", width: 340, longText: true },
  { title: "更新时间", field: "updatedAt", width: 205, editable: false },
]);
const resultTableRows = computed(() => visibleResults.value.map((item) => ({ ...item, tags: item.tags.join(", "), metadata: JSON.stringify(item.metadata, null, 2) })));
const historyColumns: SpreadsheetColumn[] = [
  { title: "任务 ID", field: "id", width: 90, editable: false, filterable: false }, { title: "任务名称", field: "name", width: 340, editable: false, longText: true },
  { title: "输入方式", field: "inputKind", width: 160, editable: false }, { title: "状态", field: "status", width: 130, editable: false },
  { title: "总数", field: "totalCount", width: 90, editable: false }, { title: "结果", field: "resultCount", width: 90, editable: false },
  { title: "异常", field: "errorCount", width: 90, editable: false }, { title: "创建时间", field: "createdAt", width: 205, editable: false },
  { title: "更新时间", field: "updatedAt", width: 205, editable: false },
];
const historyRows = computed(() => runs.value as unknown as Array<Record<string, unknown>>);

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

async function editCell(payload: { row: Record<string, unknown>; field: string; value: unknown; oldValue: unknown }) {
  const item = results.value.find((candidate) => candidate.id === Number(payload.row.id));
  if (!item) return;
  const fieldMap: Record<string, "primary_value" | "secondary_value" | "status" | "tags_json" | "error" | "source" | "metadata_json"> = {
    primaryValue: "primary_value", secondaryValue: "secondary_value", status: "status", tags: "tags_json", error: "error", source: "source", metadata: "metadata_json",
  };
  const field = fieldMap[payload.field];
  if (!field) return;
  const raw = String(payload.value ?? "");
  let value: unknown = field === "tags_json" ? raw.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean) : raw;
  if (field === "metadata_json") {
    try { value = JSON.parse(raw || "{}"); } catch { error.value = "元数据必须是有效 JSON。"; await loadRun(item.runId); return; }
  }
  try {
    await updateContentResult(item.id, field, value);
    if (field === "primary_value") item.primaryValue = raw;
    else if (field === "secondary_value") item.secondaryValue = raw;
    else if (field === "status") item.status = raw;
    else if (field === "tags_json") item.tags = value as string[];
    else if (field === "error") item.error = raw;
    else if (field === "source") item.source = raw;
    else item.metadata = value as Record<string, unknown>;
  } catch (reason) { error.value = String(reason); }
}

function updateSelection(keys: Array<string | number>) { selected.value = new Set(keys.map(Number)); }

async function removeSelected() {
  if (!selected.value.size || !confirm(`确定删除选中的 ${selected.value.size} 条结果吗？删除前会自动备份。`)) return;
  await deleteContentResults([...selected.value]);
  results.value = results.value.filter((item) => !selected.value.has(item.id));
  selected.value = new Set();
}

async function generateScript() {
  if (props.tool !== "missav") return;
  error.value = "";
  try {
    const template = await getAppSetting<string>(MISSAV_SCRIPT_TEMPLATE_SETTING) || defaultMissavScriptTemplate();
    const referenceLibrary = normalizeMissavReferenceTagLibrary(await getAppSetting<unknown>(MISSAV_REFERENCE_TAGS_SETTING));
    const blacklistFiles = await loadMissavBlacklistFileValues();
    const referenceBlacklist = blacklistFiles.reference;
    const exportBlacklist = blacklistFiles.raindropExport;
    const scope = selected.value.size ? results.value.filter((item) => selected.value.has(item.id)) : results.value;
    const generated = generateMissavBrowserScript(template, scope.map((item) => item.primaryValue), referenceLibrary.tags, referenceBlacklist, exportBlacklist);
    generatedScript.value = generated.script; generatedCodes.value = generated.codes; generatedTemplateVersion.value = generated.templateVersion; generatedReferenceTagCount.value = generated.referenceTagCount; generatedReferenceBlacklistTagCount.value = generated.referenceBlacklistCount; generatedExportBlacklistTagCount.value = generated.exportBlacklistCount; scriptGeneratedAt.value = new Date().toISOString();
    await recordScriptGeneration(activeRunId.value, generated.templateVersion, generated.codes.length);
    notice.value = `已生成完整脚本：${generated.codes.length.toLocaleString()} 个番号，${generated.referenceTagCount.toLocaleString()} 个有效参考 Tag，${generated.exportBlacklistCount.toLocaleString()} 个 Raindrop 导出黑名单 Tag。`;
    tab.value = "script";
  } catch (reason) { error.value = String(reason); }
}

async function copyScript() {
  if (!generatedScript.value) await generateScript();
  if (!generatedScript.value) return;
  await navigator.clipboard.writeText(generatedScript.value);
  notice.value = `已复制完整脚本（${generatedScript.value.length.toLocaleString()} 字符）。`;
}

async function saveScript() {
  if (!generatedScript.value) await generateScript();
  if (!generatedScript.value) return;
  const path = await save({ title: "保存 MissAV 浏览器脚本", defaultPath: `missav-browser-${Date.now()}.js`, filters: [{ name: "JavaScript", extensions: ["js"] }] });
  if (!path) return;
  await writeTextFile(path, generatedScript.value);
  notice.value = `完整脚本已保存到 ${path}`;
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function refreshRate(gate: AdaptiveRateGate) {
  queryRate.value = gate.snapshot();
  queryNow.value = performance.now();
  if (queryRate.value.blocked && !queryStopRequested.value) {
    queryStopRequested.value = true;
    queryPhase.value = "Cloudflare 持续验证，已自动停止";
    error.value = `${config.value.title} 当前被 Cloudflare 持续要求浏览器验证。软件已停止继续请求，避免把剩余番号全部变成错误；请更换 Clash 节点后重跑异常。`;
  }
}
async function interruptibleSleep(ms: number, gate?: AdaptiveRateGate) {
  const until = Date.now() + ms;
  while (!queryStopRequested.value && Date.now() < until) {
    await sleep(Math.min(250, until - Date.now()));
    if (gate) refreshRate(gate);
  }
}
async function requestWithRetry(url: string, proxy: string, gate: AdaptiveRateGate, retries = 0) {
  let last: Awaited<ReturnType<typeof fetchSitePage>> | null = null;
  let lastError = "";
  for (let attempt = 0; attempt <= retries && !queryStopRequested.value; attempt += 1) {
    const acquired = await gate.acquire(() => queryStopRequested.value);
    if (!acquired || queryStopRequested.value) break;
    const started = performance.now();
    try {
      last = await fetchSitePage(url, proxy, 20_000);
      gate.record(last.statusCode, last.durationMs || performance.now() - started);
      refreshRate(gate);
      if (![403, 408, 425, 429].includes(last.statusCode) && last.statusCode < 500) return last;
      lastError = `HTTP ${last.statusCode}`;
    } catch (reason) {
      lastError = String(reason);
      gate.record(0, performance.now() - started, lastError);
      refreshRate(gate);
    }
    if (attempt < retries) await interruptibleSleep(900 * (2 ** attempt), gate);
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

async function queryOne(item: ContentResult, proxy: string, gate: AdaptiveRateGate) {
  const code = item.primaryValue;
  const attempts: Array<Record<string, unknown>> = [];
  const candidates = legacyAv123.buildDetailCandidateUrls(code, "cn");
  for (const url of candidates) {
    if (queryStopRequested.value) break;
    try {
      const page = await requestWithRetry(url, proxy, gate);
      const classified = legacyAv123.classifyResponse({ ...page, statusCode: page.statusCode }, code, url) as { status: string; url: string; error: string; metadata?: Record<string, unknown> };
      attempts.push(classified as unknown as Record<string, unknown>);
      if (classified.status === "succeeded") { await persistQueryResult(item, { status: "succeeded", url: classified.url || url, error: "", metadata: classified.metadata }); return { status: "succeeded", statusCode: page.statusCode }; }
      if (classified.status === "network_error") break;
    } catch (reason) { attempts.push({ status: "network_error", url, error: String(reason) }); break; }
  }
  const network = attempts.find((attempt) => attempt.status === "network_error");
  const finalStatus = network ? "network_error" : "not_found";
  const statusCode = Number(network?.statusCode || 0);
  await persistQueryResult(item, { status: finalStatus, url: String(network?.url || ""), error: String(network?.error || ""), metadata: { attempts: attempts.length, statusCode } });
  return { status: finalStatus, statusCode };
}

async function runWebsiteQuery(scope: "all" | "selected") {
  if (queryRunning.value || props.tool !== "av123") return;
  const target = (scope === "selected" && selected.value.size ? results.value.filter((item) => selected.value.has(item.id)) : results.value)
    .filter((item) => ["pending", "network_error", "manual", "need_manual_check"].includes(item.status));
  if (!target.length) { notice.value = "当前范围没有待查询或可重试记录。"; return; }
  const settings = await getAppSetting<{ proxyEnabled?: boolean; proxyUrl?: string; av123Concurrency?: number; av123Rps?: number; av123LearnedRps?: number }>("runtime") || {};
  const concurrency = Math.max(1, Math.min(32, settings.av123Concurrency || 16));
  const rps = Math.max(.2, settings.av123Rps || 4);
  const site = "av123";
  const learnedRps = settings.av123LearnedRps;
  const gate = new AdaptiveRateGate(site, rps, learnedRps);
  const proxy = settings.proxyEnabled ? settings.proxyUrl || "" : "";
  queryRunning.value = true; queryStopRequested.value = false; queryDone.value = 0; queryTotal.value = target.length; queryStartedAt.value = performance.now(); queryNow.value = queryStartedAt.value; queryPhase.value = "主轮"; error.value = "";
  refreshRate(gate);
  const processQueue = async (items: ContentResult[], workers: number, countProgress: boolean) => {
    let cursor = 0;
    const take = async () => {
      while (!queryStopRequested.value && cursor < items.length) {
        const index = cursor++;
        await queryOne(items[index], proxy, gate);
        if (countProgress) queryDone.value += 1;
        queryNow.value = performance.now();
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, items.length) }, take));
  };
  try {
    await processQueue(target, concurrency, true);
    const firstPass403 = target.filter((item) => item.status === "network_error" && Number(item.metadata?.statusCode || 0) === 403);
    if (!queryStopRequested.value && firstPass403.length) {
      queryPhase.value = `403 冷却收尾 · ${firstPass403.length} 条`;
      await interruptibleSleep(Math.max(5_000, gate.snapshot().cooldownMs), gate);
      if (!queryStopRequested.value) await processQueue(firstPass403, Math.max(1, Math.ceil(concurrency / 2)), false);
    }
    const remaining = target.filter((item) => item.status === "network_error").length;
    const recovered = firstPass403.filter((item) => item.status !== "network_error").length;
    await setAppSetting("runtime", { ...settings, av123LearnedRps: gate.learnedRate() });
    notice.value = queryStopRequested.value
      ? `${config.value.title} 已安全停止：完成 ${queryDone.value}/${queryTotal.value}。`
      : `${config.value.title} 查询完成：${queryDone.value}/${queryTotal.value}；403 收尾恢复 ${recovered} 条，仍有网络异常 ${remaining} 条。`;
  }
  catch (reason) { error.value = String(reason); }
  finally { queryRunning.value = false; queryPhase.value = ""; }
}

function stopWebsiteQuery() {
  queryStopRequested.value = true;
  queryPhase.value = "正在安全停止";
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

function chosenRun() { return selectedRuns.value.size === 1 ? runs.value.find((run) => selectedRuns.value.has(run.id)) || null : null; }
async function openSelectedRun() { const run = chosenRun(); if (run) await loadRun(run.id); else error.value = "请只选择一个历史任务。"; }
async function openTelegramRun(runId: number) { await loadRun(runId); await refreshHistory(); }
async function renameSelectedRun() { const run = chosenRun(); if (run) await renameRun(run); else error.value = "请只选择一个历史任务。"; }
async function removeSelectedRuns() { const targets = runs.value.filter((run) => selectedRuns.value.has(run.id)); if (!targets.length || !confirm(`删除所选 ${targets.length} 个任务及其结果？每次删除都会保留可恢复备份。`)) return; for (const run of targets) await deleteContentRun(run.id); selectedRuns.value = new Set(); if (activeRunId.value && targets.some((run) => run.id === activeRunId.value)) { activeRunId.value = null; results.value = []; } await refreshHistory(); }

watch(() => props.tool, async () => {
  tab.value = "input"; inputMode.value = "manual"; results.value = []; activeRunId.value = null; error.value = ""; notice.value = "";
  await refreshHistory();
});
watch(historySearch, () => { void refreshHistory(); });
onMounted(refreshHistory);
watch(() => props.initialRunId, (id) => { if (id) void loadRun(id); }, { immediate: true });
</script>

<template>
  <section class="page-intro compact">
    <div><span class="section-kicker">独立内容工具</span><h2>{{ config.title }}</h2><p>{{ config.description }}</p></div>
    <div class="inline-stat"><strong>{{ runs.length }}</strong><span>历史任务</span></div>
  </section>

  <nav class="local-tabs">
    <button :class="{ active: tab === 'input' }" @click="tab = 'input'">1 输入</button>
    <button :class="{ active: tab === 'results' }" @click="tab = 'results'">2 结果</button>
    <button v-if="tool === 'missav'" :class="{ active: tab === 'script' }" @click="tab = 'script'">3 浏览器脚本</button>
    <button v-if="tool === 'av123'" :class="{ active: tab === 'account' }" @click="tab = 'account'">3 账号操作</button>
    <button :class="{ active: tab === 'history' }" @click="tab = 'history'">{{ tool === 'missav' || tool === 'av123' ? 4 : 3 }} 历史</button>
  </nav>
  <div v-if="error" class="notice danger">{{ error }}</div>
  <div v-if="notice" class="notice info">{{ notice }}</div>

  <section v-if="tab === 'input'" class="input-hub">
    <nav class="input-mode-tabs" aria-label="选择输入方式">
      <button :class="{ active: inputMode === 'manual' }" @click="inputMode = 'manual'"><strong>手动 / 文件</strong><span>粘贴文本或多选导出文件</span></button>
      <button :class="{ active: inputMode === 'telegram' }" @click="inputMode = 'telegram'"><strong>Telegram 群组消息</strong><span>加载已绑定群组，多选后直接处理</span></button>
    </nav>

    <section v-if="inputMode === 'manual'" class="panel input-workspace">
      <div class="section-heading compact-heading"><div><span class="section-kicker">输入方式</span><h3>手动粘贴与文件导入</h3><p>适合 Telegram Desktop 导出文件、CSV、TXT 或临时粘贴的内容。</p></div></div>
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

    <TelegramToolWorkspace v-else :tool="tool" @run-created="openTelegramRun" />
  </section>

  <section v-else-if="tab === 'results'" class="panel results-workspace">
    <div class="grid-toolbar result-tools">
      <label class="search-box">自由搜索<input v-model="resultSearch" placeholder="番号、链接、状态、标签、错误、来源均可搜索" /></label>
      <strong>{{ visibleResults.length.toLocaleString() }} / {{ results.length.toLocaleString() }} 条</strong>
      <button class="danger-button small" :disabled="!selected.size" @click="removeSelected">删除 {{ selected.size || "" }}</button>
      <button class="quiet-button small" @click="copyOutput(false)">复制主结果</button>
      <button v-if="tool === 'twitter'" class="quiet-button small" @click="copyOutput(true)">复制链接</button>
      <button class="quiet-button small" @click="exportResults('txt')">TXT</button>
      <button class="quiet-button small" @click="exportResults('csv')">CSV</button>
      <button v-if="tool === 'missav'" class="primary-button small" :disabled="!results.length" @click="generateScript">{{ selected.size ? `生成选中番号脚本 (${selected.size})` : "生成完整浏览器脚本" }}</button>
      <template v-if="tool === 'av123'">
        <button class="primary-button small" :disabled="queryRunning" @click="runWebsiteQuery('all')">{{ queryRunning ? `${queryDone}/${queryTotal}` : `查询 ${config.title}` }}</button>
        <button v-if="queryRunning" class="danger-button small" @click="stopWebsiteQuery">停止查询</button>
        <button class="quiet-button small" :disabled="queryRunning" @click="runWebsiteQuery('selected')">{{ selected.size ? `重跑选中异常 (${selected.size})` : "重跑全部异常" }}</button>
      </template>
    </div>
    <div v-if="queryRunning" class="query-progress"><span :style="{ width: `${queryTotal ? queryDone / queryTotal * 100 : 0}%` }"></span></div>
    <div v-if="queryRunning" class="status-line">
      {{ queryPhase }} · 真实完成 {{ queryMetrics.rate.toFixed(2) }} 条/秒 · 调度 {{ queryRate.currentRps.toFixed(2) }}/{{ queryRate.targetRps.toFixed(2) }} 请求/秒
      <template v-if="queryRate.cooldownMs > 0"> · 防护冷却 {{ Math.ceil(queryRate.cooldownMs / 1000) }} 秒</template>
      <template v-if="queryRate.congestionEvents || queryRate.rateLimitEvents"> · 退速 {{ queryRate.congestionEvents + queryRate.rateLimitEvents }} 次（{{ queryRate.lastSignal }}）</template>
      · 预计剩余 {{ queryMetrics.eta }} 秒 · {{ queryDone }}/{{ queryTotal }}
    </div>
    <details class="plain-output"><summary>纯文本输出（一行一个，可直接全选复制）</summary><div :class="['plain-output-grid', { two: tool === 'twitter' }]"><label>{{ config.primary }}<textarea :value="primaryOutput" readonly rows="8"></textarea></label><label v-if="tool === 'twitter'">{{ config.secondary }}<textarea :value="secondaryOutput" readonly rows="8"></textarea></label></div></details>
    <SpreadsheetTable :table-id="`tool-results-${tool}`" :rows="resultTableRows" :columns="resultColumns" :selected-keys="[...selected]" :total-selected="selected.size" height="min(60vh, 680px)" empty-text="没有结果。先在输入页处理内容，或从历史载入任务。" @selection-change="updateSelection" @clear-all-selection="selected = new Set()" @cell-edited="editCell" @delete-selected="removeSelected" />
  </section>

  <section v-else-if="tab === 'script' && tool === 'missav'" class="panel script-workspace">
    <div class="section-heading compact-heading"><div><span class="section-kicker">替代 APP 查询</span><h3>MissAV 浏览器脚本生成器</h3><p>没有选择记录时写入当前任务的全部有效番号；有选择时只写入所选番号。APP 不再访问 MissAV，也不会自动执行脚本。</p></div><div class="action-row"><button class="primary-button" :disabled="!results.length" @click="generateScript">重新生成</button><button class="quiet-button" :disabled="!generatedScript" @click="copyScript">复制完整脚本</button><button class="quiet-button" :disabled="!generatedScript" @click="saveScript">保存 .js</button></div></div>
    <div class="script-stats"><div><strong>{{ generatedCodes.length.toLocaleString() }}</strong><span>写入番号</span></div><div><strong>{{ generatedReferenceTagCount.toLocaleString() }}</strong><span>有效参考女优 Tag</span></div><div><strong>{{ generatedReferenceBlacklistTagCount.toLocaleString() }}</strong><span>参考库黑名单</span></div><div><strong>{{ generatedExportBlacklistTagCount.toLocaleString() }}</strong><span>Raindrop 导出黑名单</span></div><div><strong>{{ generatedScript.length.toLocaleString() }}</strong><span>脚本字符</span></div><div><strong>{{ generatedTemplateVersion || '-' }}</strong><span>模板版本</span></div><div><strong>{{ scriptGeneratedAt ? new Date(scriptGeneratedAt).toLocaleString('zh-CN', { hour12: false }) : '-' }}</strong><span>生成时间</span></div></div>
    <label class="stack-field">完整可复制脚本<textarea :value="generatedScript" readonly rows="24" placeholder="先载入一个 MissAV 任务，然后点击“重新生成”"></textarea></label>
    <p class="selection-tip">使用方法：复制完整脚本 → 打开 MissAV 任意页面 → F12 → Console → 粘贴并回车。参考库黑名单只影响“是否命中参考女优”；Raindrop 导出黑名单命中后会从导入 HTML/CSV 中彻底排除，但仍写入报告和备份。</p>
  </section>
  <Av123Account v-else-if="tab === 'account' && tool === 'av123'" :results="results" />

  <section v-else class="panel history-workspace">
    <div class="grid-toolbar result-tools"><label class="search-box">搜索历史<input v-model="historySearch" placeholder="按任务名称搜索" /></label><strong>{{ runs.length }} 项</strong><button class="primary-button small" :disabled="selectedRuns.size !== 1" @click="openSelectedRun">载入所选</button><button class="quiet-button small" :disabled="selectedRuns.size !== 1" @click="renameSelectedRun">重命名</button><button class="danger-button small" :disabled="!selectedRuns.size" @click="removeSelectedRuns">删除 {{ selectedRuns.size || '' }}</button></div>
    <SpreadsheetTable :table-id="`tool-history-${tool}`" :rows="historyRows" :columns="historyColumns" :editable="false" :selected-keys="[...selectedRuns]" :total-selected="selectedRuns.size" height="min(62vh, 700px)" empty-text="暂无匹配历史。" @selection-change="selectedRuns = new Set($event.map(Number))" @clear-all-selection="selectedRuns = new Set()" @row-activate="void 0" />
  </section>
</template>
