<script setup lang="ts">
import { save } from "@tauri-apps/plugin-dialog";
import { computed, onMounted, ref, watch } from "vue";
import {
  callTelegramBot,
  commitTelegramSync,
  createTelegramToolMessage,
  createTelegramMessageRun,
  deleteTelegramToolMessages,
  getAppSetting,
  getTelegramToolMessages,
  knownTelegramMessageIds,
  listInputSources,
  queryTelegramToolMessages,
  recordTelegramLoadSession,
  resolveTelegramToolMessages,
  setAppSetting,
  storeTelegramToolMessages,
  telegramToolCursor,
  telegramToolMessageKeys,
  telegramUserLoadHistory,
  telegramUserMarkRead,
  telegramUserSyncMessages,
  updateTelegramToolMessage,
  updateToolSourceBindings,
  writeTextFile,
  type TelegramQueueQueryInput,
} from "../api";
import { processToolInput } from "../processing";
import { telegramBotSessionToken } from "../telegramBotSession";
import {
  telegramHasPendingRead,
  telegramReadHandledMessageId,
  telegramReadPolicy,
  telegramReadStateLabel,
  telegramSafeReadMessageId,
} from "../telegramReadPolicy";
import type { SourceRecord, TelegramApiMessage, TelegramMessageKey, TelegramToolMessage, TelegramToolMessagePage, ToolKind } from "../types";
import SpreadsheetTable, { type SpreadsheetColumn } from "./SpreadsheetTable.vue";

const props = defineProps<{ tool: ToolKind }>();
const emit = defineEmits<{ runCreated: [runId: number] }>();

const toolNames: Record<ToolKind, string> = { twitter: "推特", badnews: "Bad.news", haijiao: "海角", missav: "MissAV", av123: "123AV" };
const allTelegramSources = ref<SourceRecord[]>([]);
const sources = ref<SourceRecord[]>([]);
const selectedSources = ref(new Set<number>());
const bindingEditorOpen = ref(false);
const bindingSearch = ref("");
const originalBoundSourceIds = ref(new Set<number>());
const draftBoundSourceIds = ref(new Set<number>());
const bindingSaving = ref(false);
const mode = ref<"latest" | "range" | "continue" | "incremental">("latest");
const requestedCount = ref(1000);
const startAt = ref("");
const endAt = ref("");
const loading = ref(false);
const stopRequested = ref(false);
const progress = ref({ source: "", scanned: 0, loaded: 0, requested: 0 });
const error = ref("");
const notice = ref("");
const search = ref("");
const filterStartAt = ref("");
const filterEndAt = ref("");
const status = ref("pending");
const candidateOnly = ref(false);
const page = ref(1);
const pageSize = ref(200);
const queue = ref<TelegramToolMessagePage>({ data: [], page: 1, pageSize: 200, lastPage: 1, total: 0, statusCounts: {} });
const selectedMessages = ref(new Set<string>());
const queueBusy = ref(false);
const incrementalSyncing = ref(false);
const incrementalProgress = ref({ source: "", completed: 0, total: 0, saved: 0 });
const markingReadSources = ref(new Set<number>());
const createMessageOpen = ref(false);
const createMessageSourceId = ref(0);
const createMessageDate = ref("");
const createMessageText = ref("");
const createMessageBusy = ref(false);
const botToken = telegramBotSessionToken;
const botBusy = ref(false);
const botStatus = ref("");
let enriching = false;

const columns: SpreadsheetColumn[] = [
  { title: "来源", field: "sourceName", width: 185, editable: false },
  { title: "时间", field: "messageDate", width: 210, formatter: (cell) => displayDate(String(cell.getValue() || "")) },
  { title: "消息 ID", field: "messageId", width: 110, editable: false, filterable: false },
  { title: "消息正文", field: "text", width: 520, longText: true },
  { title: "候选结果", field: "candidateCountDisplay", width: 110, editable: false },
  { title: "候选预览", field: "candidatePreview", width: 310, editable: false, longText: true },
  { title: "处理状态", field: "statusDisplay", width: 135, editable: false },
  { title: "任务 ID", field: "runId", width: 100, editable: false },
  { title: "错误 / 备注", field: "error", width: 260, editable: false, longText: true },
];

const statusNames: Record<string, string> = {
  pending: "待处理", processed: "已生成结果", processed_empty: "已处理·无结果", ignored: "已忽略", error: "异常",
};
const queueRows = computed(() => queue.value.data.map((row) => ({
  ...row,
  candidateCountDisplay: row.candidateCount < 0 ? "待分析" : row.candidateCount,
  statusDisplay: statusNames[row.status] || row.status,
})));
const allSourceIds = computed(() => sources.value.map((source) => source.id));
const loadableSourceIds = computed(() => sources.value.filter((source) => source.kind === "telegram_user").map((source) => source.id));
const querySourceIds = computed(() => selectedSources.value.size ? [...selectedSources.value] : allSourceIds.value);
const selectedSourceNames = computed(() => sources.value.filter((source) => selectedSources.value.has(source.id)).map((source) => source.name));
const boundBotSources = computed(() => sources.value.filter((source) => source.kind === "telegram_bot"));
const selectedCount = computed(() => selectedMessages.value.size);
const visibleBindingSources = computed(() => {
  const needle = bindingSearch.value.trim().toLowerCase();
  if (!needle) return allTelegramSources.value;
  return allTelegramSources.value.filter((source) =>
    `${source.name} ${source.externalId} ${source.sourceType} ${String(source.metadata.username || "")}`.toLowerCase().includes(needle),
  );
});
const bindingAddedCount = computed(() =>
  [...draftBoundSourceIds.value].filter((id) => !originalBoundSourceIds.value.has(id)).length,
);
const bindingRemovedCount = computed(() =>
  [...originalBoundSourceIds.value].filter((id) => !draftBoundSourceIds.value.has(id)).length,
);
const bindingDirty = computed(() => bindingAddedCount.value > 0 || bindingRemovedCount.value > 0);

function sourceTypeName(value: string) {
  return ({ group: "普通群", supergroup: "超级群", channel: "频道" } as Record<string, string>)[value] || value || "群组 / 频道";
}
function sourceMethodName(source: SourceRecord) {
  return source.kind === "telegram_bot" ? "Bot API" : "个人 API";
}

function displayDate(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
function isoTime(value: string) { return value ? new Date(value).toISOString() : ""; }
function localDateTimeInput(value = new Date()) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function contentHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function messageKey(sourceId: number, messageId: number): TelegramMessageKey { return { sourceId, messageId }; }
function parseKey(value: string): TelegramMessageKey {
  const [sourceId, messageId] = value.split(":").map(Number);
  return messageKey(sourceId, messageId);
}
function candidateFor(source: SourceRecord, message: TelegramApiMessage) {
  const processed = processToolInput(props.tool, [{ name: `Telegram · ${source.name} · #${message.id}`, text: message.text }]);
  return {
    messageId: message.id,
    messageDate: message.date,
    text: message.text,
    contentHash: contentHash(message.text),
    candidateCount: processed.results.length,
    candidatePreview: processed.results.slice(0, 5).map((item) => item.secondaryValue ? `${item.primaryValue} → ${item.secondaryValue}` : item.primaryValue).join("；"),
  };
}
function queryInput(candidate = candidateOnly.value): TelegramQueueQueryInput {
  return {
    tool: props.tool,
    sourceIds: querySourceIds.value,
    status: status.value,
    search: search.value,
    startAt: isoTime(filterStartAt.value),
    endAt: isoTime(filterEndAt.value),
    candidateOnly: candidate,
    page: page.value,
    pageSize: pageSize.value,
  };
}

async function refreshSources() {
  const all = await listInputSources();
  allTelegramSources.value = all.filter((source) => ["telegram_user", "telegram_bot"].includes(source.kind) && source.enabled);
  sources.value = allTelegramSources.value.filter((source) => source.boundTools.includes(props.tool));
  const valid = new Set(loadableSourceIds.value);
  selectedSources.value = new Set([...selectedSources.value].filter((id) => valid.has(id)));
}
function openBindingEditor() {
  const current = new Set(sources.value.map((source) => source.id));
  originalBoundSourceIds.value = new Set(current);
  draftBoundSourceIds.value = new Set(current);
  bindingSearch.value = "";
  bindingEditorOpen.value = true;
}
function closeBindingEditor() {
  if (bindingDirty.value && !confirm("尚未保存当前工具的群组绑定，确定放弃这些修改？")) return;
  bindingEditorOpen.value = false;
}
function toggleDraftBinding(id: number) {
  const next = new Set(draftBoundSourceIds.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  draftBoundSourceIds.value = next;
}
function setVisibleBindings(selected: boolean) {
  const next = new Set(draftBoundSourceIds.value);
  for (const source of visibleBindingSources.value) {
    if (selected) next.add(source.id); else next.delete(source.id);
  }
  draftBoundSourceIds.value = next;
}
async function saveToolBindings() {
  if (!bindingDirty.value) {
    notice.value = `${toolNames[props.tool]} 的群组绑定没有变化。`;
    bindingEditorOpen.value = false;
    return;
  }
  const summary = `将为 ${toolNames[props.tool]} 新增 ${bindingAddedCount.value} 个、移除 ${bindingRemovedCount.value} 个群组绑定。其他工具的绑定不会改变。`;
  if (!confirm(`${summary}\n\n确定保存吗？`)) return;
  bindingSaving.value = true;
  error.value = "";
  try {
    const updates = allTelegramSources.value
      .filter((source) => originalBoundSourceIds.value.has(source.id) !== draftBoundSourceIds.value.has(source.id))
      .map((source) => ({ sourceId: source.id, bound: draftBoundSourceIds.value.has(source.id) }));
    await updateToolSourceBindings(props.tool, updates);
    await refreshSources();
    originalBoundSourceIds.value = new Set(sources.value.map((source) => source.id));
    draftBoundSourceIds.value = new Set(originalBoundSourceIds.value);
    bindingEditorOpen.value = false;
    notice.value = `${summary} 已保存。`;
  } catch (reason) {
    error.value = `保存 ${toolNames[props.tool]} 群组绑定失败：${String(reason)}`;
    await refreshSources();
  } finally {
    bindingSaving.value = false;
  }
}
function otherToolNames(source: SourceRecord) {
  return source.boundTools.filter((tool) => tool !== props.tool).map((tool) => toolNames[tool]).join("、") || "无";
}
function toggleSource(id: number) {
  if (!loadableSourceIds.value.includes(id)) return;
  const next = new Set(selectedSources.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  selectedSources.value = next;
}
function selectAllSources() { selectedSources.value = new Set(loadableSourceIds.value); }
function canMarkRead(source: SourceRecord) {
  return source.kind === "telegram_user" && telegramReadPolicy(source.metadata) !== "never" && telegramHasPendingRead(source.metadata);
}
function markReadLabel(source: SourceRecord) {
  const action = telegramReadPolicy(source.metadata) === "manual" ? "确认并标已读至" : "重试标已读至";
  return `${action} ${telegramSafeReadMessageId(source.metadata)}`;
}

async function markSourceRead(source: SourceRecord) {
  const target = telegramSafeReadMessageId(source.metadata);
  if (!canMarkRead(source) || target <= 0 || markingReadSources.value.has(source.id)) return;
  markingReadSources.value = new Set(markingReadSources.value).add(source.id);
  error.value = "";
  try {
    await telegramUserMarkRead(source.id, target);
    await refreshSources();
    notice.value = `${source.name} 已在 Telegram 标记已读至消息 ${target}。`;
  } catch (reason) {
    error.value = `${source.name} 标记已读失败：${String(reason)}`;
    await refreshSources();
  } finally {
    const next = new Set(markingReadSources.value); next.delete(source.id); markingReadSources.value = next;
  }
}

async function syncIncremental() {
  const selected = sources.value.filter((source) => selectedSources.value.has(source.id) && source.kind === "telegram_user");
  if (!selected.length) { error.value = "请先选择至少一个已绑定的个人 API 群组或频道。"; return; }
  incrementalSyncing.value = true;
  error.value = "";
  notice.value = "";
  incrementalProgress.value = { source: "", completed: 0, total: selected.length, saved: 0 };
  const failures: string[] = [];
  const summaries: string[] = [];
  for (const source of selected) {
    incrementalProgress.value.source = source.name;
    try {
      const checkpoint = Number(source.checkpoint || 0);
      const limit = Math.max(1, Math.min(20_000, Number(source.metadata.historyLimit || 2_000)));
      const historyPull = checkpoint <= 0 && source.metadata.initialMode === "recent";
      const synced = await telegramUserSyncMessages({ externalId: source.externalId, checkpoint, limit, start: "", end: "" });
      const known = new Set(await knownTelegramMessageIds(source.id, synced.messages.map((message) => message.id)));
      const fresh = synced.messages.filter((message) => !known.has(message.id));
      if (fresh.length) {
        await storeTelegramToolMessages({ sourceId: source.id, tool: props.tool, messages: fresh.map((message) => candidateFor(source, message)) });
      }
      const policy = telegramReadPolicy(source.metadata);
      const readState = historyPull ? "history_skipped" : policy === "never" ? "disabled" : "pending";
      const continuation = synced.hasMore ? (historyPull ? "history_limit_reached" : "incremental_backlog_remaining") : "";
      await commitTelegramSync({
        sourceId: source.id,
        checkpoint: String(synced.checkpoint || checkpoint),
        continuation,
        fingerprints: fresh.map((message) => ({ messageId: message.id, messageDate: message.date, contentHash: contentHash(message.text) })),
        runs: [],
        safeReadMessageId: historyPull ? 0 : synced.checkpoint,
        readState,
      });
      const needsRead = !historyPull && synced.checkpoint > telegramReadHandledMessageId(source.metadata);
      let readSummary = historyPull ? "历史回拉未标已读" : policy === "never" ? "未改 Telegram 已读" : !needsRead ? "无新已读位置" : policy === "manual" ? `待你确认至 ${synced.checkpoint}` : `已标至 ${synced.checkpoint}`;
      if (policy === "safe_auto" && needsRead && synced.checkpoint > 0) {
        try { await telegramUserMarkRead(source.id, synced.checkpoint); }
        catch (reason) { readSummary = "已安全入库，自动标已读失败，可在本页重试"; failures.push(`${source.name} 标已读：${String(reason)}`); }
      }
      incrementalProgress.value.saved += fresh.length;
      summaries.push(`${source.name} ${fresh.length} 条（${readSummary}${synced.hasMore ? "，仍有积压" : ""}）`);
    } catch (reason) {
      failures.push(`${source.name}：${String(reason)}`);
    } finally {
      incrementalProgress.value.completed += 1;
    }
  }
  incrementalSyncing.value = false;
  await refreshSources();
  page.value = 1;
  await refreshQueue();
  notice.value = `日常增量同步完成：新增 ${incrementalProgress.value.saved.toLocaleString()} 条。${summaries.join("；")}`;
  if (failures.length) error.value = `以下来源未完全成功：\n${failures.join("\n")}`;
}

async function botCall(method: string, body: Record<string, unknown> = {}) {
  const runtime = await getAppSetting<{ proxyEnabled?: boolean; proxyUrl?: string }>("runtime");
  const proxy = runtime?.proxyEnabled ? String(runtime.proxyUrl || "") : "";
  const response = await callTelegramBot(botToken.value, method, body, proxy);
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(response.body); }
  catch { throw new Error(`Telegram 返回无法解析（HTTP ${response.statusCode}）`); }
  if (response.statusCode !== 200 || payload.ok !== true) throw new Error(String(payload.description || `Telegram HTTP ${response.statusCode}`));
  return payload.result;
}
function botUpdateMessage(update: Record<string, unknown>) {
  return (update.message || update.channel_post || update.edited_message || update.edited_channel_post) as Record<string, unknown> | undefined;
}
function botUpdateChat(update: Record<string, unknown>) {
  return botUpdateMessage(update)?.chat as Record<string, unknown> | undefined;
}
function botMessageText(message: Record<string, unknown>) {
  const entities = Array.isArray(message.entities) ? message.entities : [];
  return [
    String(message.text || message.caption || ""),
    ...entities.filter((entity: Record<string, unknown>) => entity.type === "text_link" && entity.url).map((entity: Record<string, unknown>) => String(entity.url)),
  ].filter(Boolean).join("\n");
}
async function receiveBotUpdates() {
  if (!botToken.value.trim()) { error.value = "请先在这里或 Telegram 来源页输入 Bot Token。"; return; }
  const allBound = allTelegramSources.value.filter((source) => source.kind === "telegram_bot" && source.boundTools.length);
  if (!allBound.length) { error.value = "来源库中没有已绑定到工具的 Bot 群组或频道。"; return; }
  botBusy.value = true;
  error.value = "";
  botStatus.value = "正在接收 Bot 更新…";
  try {
    let offset = await getAppSetting<number>("telegram.bot.offset") || 0;
    let total = 0;
    let queueWrites = 0;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const updates = await botCall("getUpdates", {
        offset, limit: 100, timeout: 0,
        allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post"],
      }) as Array<Record<string, unknown>>;
      if (!updates.length) break;
      for (const source of allBound) {
        const messages = updates
          .filter((update) => String(botUpdateChat(update)?.id || "") === source.externalId)
          .map((update) => {
            const message = botUpdateMessage(update) || {};
            return {
              id: Number(message.message_id || update.update_id || 0),
              date: new Date(Number(message.date || 0) * 1_000).toISOString(),
              text: botMessageText(message),
            };
          })
          .filter((message) => message.id > 0 && message.text.trim());
        if (!messages.length) continue;
        const known = new Set(await knownTelegramMessageIds(source.id, messages.map((message) => message.id)));
        const fresh = messages.filter((message) => !known.has(message.id));
        for (const tool of source.boundTools) {
          await storeTelegramToolMessages({
            sourceId: source.id,
            tool,
            messages: fresh.map((message) => {
              const processed = processToolInput(tool, [{ name: `Telegram Bot · ${source.name} · #${message.id}`, text: message.text }]);
              return {
                messageId: message.id,
                messageDate: message.date,
                text: message.text,
                contentHash: contentHash(message.text),
                candidateCount: processed.results.length,
                candidatePreview: processed.results.slice(0, 5).map((result) => result.secondaryValue ? `${result.primaryValue} → ${result.secondaryValue}` : result.primaryValue).join("；"),
              };
            }),
          });
        }
        queueWrites += fresh.length * source.boundTools.length;
        const checkpoint = String(Math.max(Number(source.checkpoint || 0), ...messages.map((message) => message.id)));
        await commitTelegramSync({
          sourceId: source.id,
          checkpoint,
          continuation: "",
          fingerprints: fresh.map((message) => ({ messageId: message.id, messageDate: message.date, contentHash: contentHash(message.text) })),
          runs: [],
        });
        total += fresh.length;
      }
      let pageComplete = true;
      for (const source of allBound) {
        const relevant = updates
          .filter((update) => String(botUpdateChat(update)?.id || "") === source.externalId)
          .map((update) => Number(botUpdateMessage(update)?.message_id || update.update_id || 0))
          .filter(Boolean);
        if (!relevant.length) continue;
        const known = await knownTelegramMessageIds(source.id, relevant);
        if (known.length !== new Set(relevant).size) { pageComplete = false; break; }
      }
      if (!pageComplete) {
        throw new Error("该页仍有已绑定来源未安全写入，本地未推进 Bot 全局检查点；可直接重试。");
      }
      offset = Math.max(offset, ...updates.map((update) => Number(update.update_id || 0) + 1));
      await setAppSetting("telegram.bot.offset", offset);
      if (updates.length < 100) break;
    }
    await refreshSources();
    page.value = 1;
    await refreshQueue();
    botStatus.value = `Bot 更新接收完成：${total.toLocaleString()} 条新消息，写入 ${queueWrites.toLocaleString()} 个工具队列。`;
    notice.value = botStatus.value;
  } catch (reason) {
    error.value = `接收 Bot 更新失败：${String(reason)}`;
    botStatus.value = "Bot 更新未完全完成，可安全重试。";
  } finally {
    botBusy.value = false;
  }
}

async function enrichUnknown(rows: TelegramToolMessage[]) {
  const unknown = rows.filter((row) => row.candidateCount < 0);
  if (!unknown.length || enriching) return false;
  enriching = true;
  try {
    const grouped = new Map<number, TelegramToolMessage[]>();
    for (const row of unknown) grouped.set(row.sourceId, [...(grouped.get(row.sourceId) || []), row]);
    for (const [sourceId, messages] of grouped) {
      const source = sources.value.find((item) => item.id === sourceId);
      if (!source) continue;
      await storeTelegramToolMessages({
        sourceId, tool: props.tool,
        messages: messages.map((row) => candidateFor(source, { id: row.messageId, date: row.messageDate, text: row.text })),
      });
    }
    return true;
  } finally { enriching = false; }
}

async function refreshQueue() {
  if (!sources.value.length) { queue.value = { data: [], page: 1, pageSize: pageSize.value, lastPage: 1, total: 0, statusCounts: {} }; return; }
  queueBusy.value = true;
  error.value = "";
  try {
    let result = await queryTelegramToolMessages(queryInput(false));
    if (await enrichUnknown(result.data)) result = await queryTelegramToolMessages(queryInput(false));
    queue.value = candidateOnly.value ? await queryTelegramToolMessages(queryInput(true)) : result;
    if (page.value > queue.value.lastPage) { page.value = queue.value.lastPage; queue.value = await queryTelegramToolMessages(queryInput()); }
  } catch (reason) { error.value = String(reason); }
  finally { queueBusy.value = false; }
}

async function loadHistory() {
  const selected = sources.value.filter((source) => selectedSources.value.has(source.id));
  if (!selected.length) { error.value = "请先选择至少一个已绑定的群组或频道。"; return; }
  if (!Number.isFinite(requestedCount.value) || requestedCount.value < 1 || requestedCount.value > 100_000) { error.value = "每个来源的加载条数必须在 1 到 100,000 之间。"; return; }
  if (mode.value === "range" && !startAt.value && !endAt.value) { error.value = "按时间范围加载时，请至少填写开始或结束时间。"; return; }
  loading.value = true; stopRequested.value = false; error.value = ""; notice.value = "";
  progress.value = { source: "", scanned: 0, loaded: 0, requested: requestedCount.value * selected.length };
  let completedSources = 0;
  try {
    for (const source of selected) {
      if (stopRequested.value) break;
      progress.value.source = source.name;
      const cursor = await telegramToolCursor(props.tool, source.id);
      let beforeId = mode.value === "continue" ? cursor.oldestMessageId : 0;
      let afterId = mode.value === "incremental" ? Math.max(cursor.newestMessageId, cursor.sourceCheckpoint) : 0;
      let scanned = 0; let loaded = 0; let hasMore = true; let sourceError = "";
      try {
        while (!stopRequested.value && scanned < requestedCount.value && hasMore) {
          const pageLimit = Math.min(5_000, requestedCount.value - scanned);
          const result = await telegramUserLoadHistory({
            sourceId: source.id, tool: props.tool, limit: pageLimit,
            start: mode.value === "range" ? isoTime(startAt.value) : "",
            end: mode.value === "range" ? isoTime(endAt.value) : "",
            beforeId, afterId,
          });
          if (result.messages.length) {
            await storeTelegramToolMessages({ sourceId: source.id, tool: props.tool, messages: result.messages.map((message) => candidateFor(source, message)) });
          }
          scanned += result.scannedCount; loaded += result.messages.length;
          progress.value.scanned += result.scannedCount; progress.value.loaded += result.messages.length;
          beforeId = result.nextBeforeId; afterId = result.nextAfterId; hasMore = result.hasMore;
          if (!result.scannedCount) break;
        }
        completedSources += 1;
      } catch (reason) { sourceError = String(reason); throw reason; }
      finally {
        await recordTelegramLoadSession({
          tool: props.tool, sourceId: source.id, mode: mode.value, requestedCount: requestedCount.value,
          scannedCount: scanned, loadedCount: loaded, nextBeforeId: beforeId, nextAfterId: afterId,
          status: sourceError ? "error" : stopRequested.value ? "stopped" : "completed", error: sourceError,
        }).catch(() => undefined);
      }
    }
    notice.value = stopRequested.value
      ? `已安全停止。扫描 ${progress.value.scanned.toLocaleString()} 条，保存 ${progress.value.loaded.toLocaleString()} 条非空消息。`
      : `加载完成：${completedSources} 个来源，扫描 ${progress.value.scanned.toLocaleString()} 条，保存 ${progress.value.loaded.toLocaleString()} 条。Telegram 已读状态和日常增量游标均未改变。`;
  } catch (reason) { error.value = String(reason); }
  finally { loading.value = false; page.value = 1; await refreshQueue(); }
}

function updatePageSelection(keys: Array<string | number>) {
  const visible = new Set(queue.value.data.map((row) => row.key));
  const next = new Set([...selectedMessages.value].filter((key) => !visible.has(key)));
  keys.map(String).forEach((key) => next.add(key));
  selectedMessages.value = next;
}
async function selectAllFiltered() {
  const keys = await telegramToolMessageKeys(queryInput());
  selectedMessages.value = new Set(keys);
  notice.value = `已选择当前筛选结果 ${keys.length.toLocaleString()} 条。`;
}
async function selectedRows() {
  if (!selectedMessages.value.size) throw new Error("请先选择消息。");
  if (selectedMessages.value.size > 20_000) throw new Error("单次处理或导出最多 20,000 条；请缩小筛选范围后再选择。");
  return getTelegramToolMessages(props.tool, [...selectedMessages.value].map(parseKey));
}
function openCreateMessage() {
  const preferred = sources.value.find((source) => selectedSources.value.has(source.id)) || sources.value[0];
  if (!preferred) { error.value = "当前工具没有已绑定的 Telegram 来源，无法新增本地消息。"; return; }
  createMessageSourceId.value = preferred.id;
  createMessageDate.value = localDateTimeInput();
  createMessageText.value = "";
  createMessageOpen.value = true;
}
async function saveCreatedMessage() {
  const source = sources.value.find((item) => item.id === createMessageSourceId.value);
  if (!source) { error.value = "请选择一个仍然有效的已绑定来源。"; return; }
  if (!createMessageText.value.trim()) { error.value = "新增消息的正文不能为空。"; return; }
  createMessageBusy.value = true;
  error.value = "";
  try {
    const messageDate = isoTime(createMessageDate.value);
    const candidate = candidateFor(source, { id: -1, date: messageDate, text: createMessageText.value });
    await createTelegramToolMessage({
      tool: props.tool,
      sourceId: source.id,
      messageDate,
      text: createMessageText.value,
      contentHash: contentHash(createMessageText.value),
      candidateCount: candidate.candidateCount,
      candidatePreview: candidate.candidatePreview,
    });
    createMessageOpen.value = false;
    page.value = 1;
    await refreshQueue();
    notice.value = `已在 ${toolNames[props.tool]} 工作表新增 1 条本地消息；不会写回 Telegram。`;
  } catch (reason) { error.value = String(reason); }
  finally { createMessageBusy.value = false; }
}
async function editMessageCell(payload: { row: Record<string, unknown>; field: string; value: unknown; oldValue: unknown }) {
  const sourceId = Number(payload.row.sourceId);
  const messageId = Number(payload.row.messageId);
  error.value = "";
  try {
    if (payload.field === "messageDate") {
      const parsed = new Date(String(payload.value || ""));
      if (Number.isNaN(parsed.getTime())) throw new Error("消息时间格式无效，请输入可识别的日期时间。");
      await updateTelegramToolMessage({ tool: props.tool, sourceId, messageId, field: "messageDate", value: parsed.toISOString() });
      notice.value = "消息时间已保存。";
    } else if (payload.field === "text") {
      const text = String(payload.value || "").trim();
      if (!text) throw new Error("消息正文不能为空。");
      const source = sources.value.find((item) => item.id === sourceId);
    if (!source) throw new Error("消息来源已不存在。");
      const candidate = candidateFor(source, { id: messageId, date: String(payload.row.messageDate || ""), text });
      await updateTelegramToolMessage({
        tool: props.tool,
        sourceId,
        messageId,
        field: "text",
        value: text,
        contentHash: contentHash(text),
        candidateCount: candidate.candidateCount,
        candidatePreview: candidate.candidatePreview,
      });
      notice.value = "消息正文已保存并重新分析；依赖这条正文的工具队列已恢复为待处理。";
    } else return;
  } catch (reason) { error.value = String(reason); }
  finally { await refreshQueue(); }
}
async function deleteSelectedMessages(keys: Array<string | number>) {
  const selected = keys.map(String);
  if (!selected.length) return;
  if (!confirm(`从“${toolNames[props.tool]}”消息工作表删除所选 ${selected.length.toLocaleString()} 条？\n\n不会删除 Telegram 原群消息，也不会删除其他工具中的对应记录。`)) return;
  error.value = "";
  try {
    const changed = await deleteTelegramToolMessages(props.tool, selected.map(parseKey));
    selectedMessages.value = new Set();
    await refreshQueue();
    notice.value = `已从当前工具删除 ${changed.toLocaleString()} 条消息记录。`;
  } catch (reason) { error.value = String(reason); }
}
async function processSelected() {
  error.value = ""; notice.value = "";
  try {
    const rows = await selectedRows();
    const documents = rows.map((row) => ({ name: `Telegram · ${row.sourceName} · #${row.messageId}`, text: row.text }));
    const processed = processToolInput(props.tool, documents);
    const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });
    const keys = rows.map((row) => messageKey(row.sourceId, row.messageId));
    const runId = await createTelegramMessageRun({
      tool: props.tool, keys,
      run: {
        tool: props.tool, name: `${toolNames[props.tool]} · Telegram 所选消息 ${timestamp}`, inputKind: "telegram_workbench",
        originalInput: rows.map((row) => `===== ${row.sourceName} · #${row.messageId} · ${row.messageDate} =====\n${row.text}`).join("\n\n"),
        options: { messageCount: rows.length, sourceIds: [...new Set(rows.map((row) => row.sourceId))], messageKeys: rows.map((row) => row.key) },
        results: processed.results,
      },
    });
    selectedMessages.value = new Set();
    await refreshQueue();
    if (runId > 0) { notice.value = `已处理 ${rows.length.toLocaleString()} 条消息并生成 ${processed.results.length.toLocaleString()} 条结果。`; emit("runCreated", runId); }
    else notice.value = `已处理 ${rows.length.toLocaleString()} 条消息，没有提取到结果；这些消息已标记为“已处理·无结果”。`;
  } catch (reason) { error.value = String(reason); }
}
async function changeSelectedStatus(nextStatus: "pending" | "ignored") {
  if (!selectedMessages.value.size) return;
  try {
    const changed = await resolveTelegramToolMessages({ tool: props.tool, keys: [...selectedMessages.value].map(parseKey), status: nextStatus });
    selectedMessages.value = new Set(); await refreshQueue(); notice.value = `已更新 ${changed.toLocaleString()} 条消息。`;
  } catch (reason) { error.value = String(reason); }
}
function csvCell(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function rawMessageText(rows: TelegramToolMessage[]) {
  return rows.map((row) => row.text.trim()).filter(Boolean).join("\n\n");
}
async function copySelected() {
  try {
    const rows = await selectedRows();
    const content = rawMessageText(rows);
    if (!content) throw new Error("所选消息没有可复制的正文");
    await navigator.clipboard.writeText(content);
    notice.value = `已复制 ${rows.length.toLocaleString()} 条所选消息正文。`;
  } catch (reason) { error.value = String(reason); }
}
async function exportSelected(format: "txt" | "csv") {
  try {
    const rows = await selectedRows();
    const path = await save({ title: "导出 Telegram 所选消息", defaultPath: `${props.tool}-telegram-${Date.now()}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (!path) return;
    const content = format === "txt"
      ? rows.map((row) => `===== ${row.sourceName} · #${row.messageId} · ${row.messageDate} =====\n${row.text}`).join("\n\n")
      : ["source,message_id,date,status,text", ...rows.map((row) => [row.sourceName, row.messageId, row.messageDate, row.status, row.text].map(csvCell).join(","))].join("\r\n");
    await writeTextFile(path, `\uFEFF${content}`); notice.value = `已导出 ${rows.length.toLocaleString()} 条消息。`;
  } catch (reason) { error.value = String(reason); }
}

async function resetAndRefresh() { page.value = 1; selectedMessages.value = new Set(); await refreshQueue(); }
async function changePage(offset: number) { page.value = Math.max(1, Math.min(queue.value.lastPage, page.value + offset)); await refreshQueue(); }

watch(() => props.tool, async () => {
  selectedSources.value = new Set();
  selectedMessages.value = new Set();
  bindingEditorOpen.value = false;
  page.value = 1;
  await refreshSources();
  await refreshQueue();
});
onMounted(async () => { await refreshSources(); await refreshQueue(); });
</script>

<template>
  <section class="telegram-tool-workspace">
    <div v-if="error" class="notice danger">{{ error }}</div>
    <div v-if="notice" class="notice info">{{ notice }}</div>

    <section class="panel telegram-source-panel">
      <div class="section-heading compact-heading">
        <div><span class="section-kicker">01 当前工具群组绑定</span><h3>{{ toolNames[tool] }} · Telegram 来源</h3><p>这里直接管理只属于 {{ toolNames[tool] }} 的群组。修改本工具时，不会覆盖其他工具的绑定。</p></div>
        <div class="action-row"><button class="primary-button small" @click="bindingEditorOpen ? closeBindingEditor() : openBindingEditor()">{{ bindingEditorOpen ? "取消绑定修改" : `管理 ${toolNames[tool]} 绑定` }}</button><button class="quiet-button small" @click="refreshSources">刷新</button></div>
      </div>
      <div v-if="bindingEditorOpen" class="telegram-binding-editor">
        <div class="binding-focus-banner">
          <span>当前只配置</span><strong>{{ toolNames[tool] }}</strong>
          <small>其他四个工具的绑定会原样保留</small>
        </div>
        <div class="grid-toolbar">
          <label class="search-box">搜索群组<input v-model="bindingSearch" placeholder="群组名、频道名、用户名或 ID" /></label>
          <strong>将绑定 {{ draftBoundSourceIds.size }} / {{ allTelegramSources.length }} 个</strong>
          <button class="quiet-button small" :disabled="!visibleBindingSources.length" @click="setVisibleBindings(true)">绑定全部可见</button>
          <button class="quiet-button small" :disabled="!visibleBindingSources.length" @click="setVisibleBindings(false)">清除全部可见</button>
        </div>
        <div v-if="visibleBindingSources.length" class="telegram-binding-list">
          <label v-for="source in visibleBindingSources" :key="source.id" :class="['telegram-binding-row', { selected: draftBoundSourceIds.has(source.id) }]">
            <input type="checkbox" :checked="draftBoundSourceIds.has(source.id)" @change="toggleDraftBinding(source.id)" />
            <span class="telegram-binding-main"><strong>{{ source.name }}</strong><small>{{ sourceMethodName(source) }} · {{ sourceTypeName(source.sourceType) }} · {{ source.metadata.username ? `@${source.metadata.username}` : `ID ${source.externalId}` }}</small></span>
            <span class="binding-state">{{ draftBoundSourceIds.has(source.id) ? `已选给 ${toolNames[tool]}` : "未绑定本工具" }}</span>
            <small class="other-bindings">其他工具：{{ otherToolNames(source) }}</small>
          </label>
        </div>
        <div v-else class="empty-state compact-empty">{{ allTelegramSources.length ? "没有符合搜索条件的群组。" : "尚未保存个人 API 群组/频道，请先到“来源”页面登录并刷新群组。" }}</div>
        <div class="binding-save-bar">
          <span :class="{ changed: bindingDirty }">{{ bindingDirty ? `待保存：新增 ${bindingAddedCount}，移除 ${bindingRemovedCount}` : "没有未保存修改" }}</span>
          <button class="quiet-button" :disabled="bindingSaving" @click="closeBindingEditor">放弃修改</button>
          <button class="primary-button" :disabled="bindingSaving || !bindingDirty" @click="saveToolBindings">{{ bindingSaving ? "保存中…" : `保存 ${toolNames[tool]} 绑定` }}</button>
        </div>
      </div>
      <div v-else-if="sources.length">
        <p class="selection-tip">下方勾选决定本次个人 API 加载/增量同步范围，不会修改绑定。每个来源的 Telegram 已读状态和操作也直接放在这里。</p>
        <div class="action-row telegram-source-select-actions"><button class="quiet-button small" :disabled="!loadableSourceIds.length" @click="selectAllSources">全选个人 API 来源</button><button class="quiet-button small" :disabled="!selectedSources.size" @click="selectedSources = new Set()">清空本次选择</button><span>本次工作已选 {{ selectedSources.size }} / {{ loadableSourceIds.length }}</span></div>
        <div class="telegram-source-grid">
        <div v-for="source in sources" :key="source.id" :title="source.name" :class="['telegram-source-card', { selected: selectedSources.has(source.id) }]">
          <input type="checkbox" :checked="selectedSources.has(source.id)" :disabled="source.kind === 'telegram_bot'" @change="toggleSource(source.id)" />
          <span class="telegram-source-card-body">
            <span class="telegram-source-title"><strong>{{ source.name }}</strong><span class="source-type-badge">{{ sourceTypeName(source.sourceType) }}</span></span>
            <small><span>{{ sourceMethodName(source) }}</span><span>{{ source.kind === "telegram_bot" ? "Bot 更新由连接页统一接收，已缓存消息可在下方处理" : `增量位置 ${source.checkpoint || 0}` }}</span></small>
            <span v-if="source.kind === 'telegram_user'" class="telegram-read-state" :class="{ pending: telegramHasPendingRead(source.metadata) }">{{ telegramReadStateLabel(source.metadata) }}</span>
            <button v-if="canMarkRead(source)" class="quiet-button small source-read-button" :disabled="markingReadSources.has(source.id)" @click="markSourceRead(source)">{{ markingReadSources.has(source.id) ? "标记中…" : markReadLabel(source) }}</button>
          </span>
        </div>
        </div>
      </div>
      <div v-else class="empty-state compact-empty">当前工具还没有绑定个人 API 或 Bot 群组。点击“管理 {{ toolNames[tool] }} 绑定”即可在本页选择。</div>
    </section>

    <section class="panel telegram-load-panel">
      <div class="section-heading compact-heading"><div><span class="section-kicker">02 加载历史</span><h3>选择范围并读取</h3><p>读取结果写入共享本地消息缓存；每个工具的待处理/已处理/忽略状态彼此独立。</p></div></div>
      <div class="form-grid telegram-load-grid">
        <label>加载方式<select v-model="mode"><option value="latest">最近消息</option><option value="range">指定时间范围</option><option value="continue">从本地最早处继续向前</option><option value="incremental">从本地最新处向后增量</option></select></label>
        <label>每个来源最多扫描<input v-model.number="requestedCount" type="number" min="1" max="100000" /></label>
        <label :class="{ muted: mode !== 'range' }">开始时间<input v-model="startAt" type="datetime-local" :disabled="mode !== 'range'" /></label>
        <label :class="{ muted: mode !== 'range' }">结束时间<input v-model="endAt" type="datetime-local" :disabled="mode !== 'range'" /></label>
      </div>
      <div class="action-row">
        <button class="primary-button" :disabled="incrementalSyncing || loading || !selectedSources.size" @click="syncIncremental">{{ incrementalSyncing ? "正在增量同步…" : `日常增量同步 ${selectedSources.size || 0} 个来源` }}</button>
        <button class="primary-button" :disabled="loading || !selectedSources.size" @click="loadHistory">{{ loading ? "正在加载…" : `加载 ${selectedSources.size || 0} 个来源` }}</button>
        <button v-if="loading" class="danger-button" @click="stopRequested = true">安全停止</button>
        <span v-if="selectedSourceNames.length" class="selection-summary">{{ selectedSourceNames.join("、") }}</span>
      </div>
      <div v-if="boundBotSources.length" class="telegram-bot-tool-sync">
        <label>Bot Token<input v-model="botToken" type="password" autocomplete="off" placeholder="只保留在本次 APP 运行内存中" /></label>
        <button class="quiet-button" :disabled="botBusy || !botToken.trim()" @click="receiveBotUpdates">{{ botBusy ? "正在接收 Bot 更新…" : "接收 Bot 更新" }}</button>
        <small>Bot 的 getUpdates 是全局队列；一次接收会安全写入所有已绑定工具，不会只消费当前页面的数据。{{ botStatus }}</small>
      </div>
      <div v-if="incrementalSyncing" class="telegram-load-progress">
        <div class="query-progress"><span :style="{ width: `${incrementalProgress.total ? incrementalProgress.completed / incrementalProgress.total * 100 : 0}%` }"></span></div>
        <p>正在同步：{{ incrementalProgress.source }} · 已完成 {{ incrementalProgress.completed }} / {{ incrementalProgress.total }} · 新增 {{ incrementalProgress.saved.toLocaleString() }} 条</p>
      </div>
      <div v-if="loading" class="telegram-load-progress">
        <div class="query-progress"><span :style="{ width: `${progress.requested ? Math.min(100, progress.scanned / progress.requested * 100) : 0}%` }"></span></div>
        <p>当前：{{ progress.source }} · 已扫描 {{ progress.scanned.toLocaleString() }} · 已保存 {{ progress.loaded.toLocaleString() }} · 安全停止会在当前网络页结束后生效</p>
      </div>
      <p class="selection-tip warning-tip">历史加载、时间范围和手工稀疏选择都不会自动标记 Telegram 已读，也不会推进“日常增量同步”游标，避免跳过未选消息。</p>
    </section>

    <section class="panel telegram-queue-panel">
      <div class="section-heading compact-heading"><div><span class="section-kicker">03 消息工作表</span><h3>筛选、选择并处理</h3><p>单击选择；Ctrl 增减、Shift 连选、Ctrl+A 选择当前筛选结果。选中消息只进入当前 {{ toolNames[tool] }} 工具。</p></div></div>
      <div class="grid-toolbar result-tools telegram-queue-toolbar">
        <label class="search-box">搜索<input v-model="search" placeholder="来源、正文、候选、错误或消息 ID" @keyup.enter="resetAndRefresh" /></label>
        <label>状态<select v-model="status" @change="resetAndRefresh"><option value="">全部</option><option value="pending">待处理</option><option value="processed">已生成结果</option><option value="processed_empty">已处理·无结果</option><option value="ignored">已忽略</option><option value="error">异常</option></select></label>
        <label>筛选开始时间<input v-model="filterStartAt" type="datetime-local" @change="resetAndRefresh" /></label>
        <label>筛选结束时间<input v-model="filterEndAt" type="datetime-local" @change="resetAndRefresh" /></label>
        <label class="checkbox-line"><input v-model="candidateOnly" type="checkbox" @change="resetAndRefresh" />只看有候选结果</label>
        <button class="quiet-button small" :disabled="!filterStartAt && !filterEndAt" @click="filterStartAt = ''; filterEndAt = ''; resetAndRefresh()">清除时间</button>
        <button class="quiet-button small" :disabled="queueBusy" @click="resetAndRefresh">{{ queueBusy ? "刷新中…" : "刷新" }}</button>
        <strong>{{ queue.total.toLocaleString() }} 条</strong>
      </div>
      <div class="telegram-status-strip">
        <button v-for="item in [{k:'pending',n:'待处理'},{k:'processed',n:'有结果'},{k:'processed_empty',n:'无结果'},{k:'ignored',n:'已忽略'},{k:'error',n:'异常'}]" :key="item.k" class="status-chip" @click="status = item.k; resetAndRefresh()"><span>{{ item.n }}</span><strong>{{ (queue.statusCounts[item.k] || 0).toLocaleString() }}</strong></button>
      </div>
      <div class="action-row telegram-message-actions">
        <button class="quiet-button" :disabled="!sources.length" @click="openCreateMessage">新增本地消息</button>
        <button class="primary-button" :disabled="!selectedCount" @click="processSelected">处理所选 {{ selectedCount || '' }}</button>
        <button class="quiet-button" :disabled="!selectedCount" @click="changeSelectedStatus('ignored')">忽略所选</button>
        <button class="quiet-button" :disabled="!selectedCount" @click="changeSelectedStatus('pending')">恢复待处理</button>
        <button class="quiet-button" :disabled="!selectedCount" @click="copySelected">复制所选消息</button>
        <button class="quiet-button" :disabled="!selectedCount" @click="exportSelected('txt')">导出 TXT</button>
        <button class="quiet-button" :disabled="!selectedCount" @click="exportSelected('csv')">导出 CSV</button>
      </div>
      <SpreadsheetTable :table-id="`telegram-tool-queue-${tool}`" :rows="queueRows" :columns="columns" row-key="key" :server-selection="true" :selected-keys="[...selectedMessages]" :total-selected="selectedMessages.size" height="min(58vh, 650px)" empty-text="当前筛选范围没有消息。先选择来源并加载历史。" @selection-change="updatePageSelection" @select-all-filtered="selectAllFiltered" @clear-all-selection="selectedMessages = new Set()" @cell-edited="editMessageCell" @delete-selected="deleteSelectedMessages" />
      <div class="pagination-bar"><button class="quiet-button small" :disabled="page <= 1" @click="changePage(-1)">上一页</button><span>第 {{ queue.page }} / {{ queue.lastPage }} 页 · 每页 {{ queue.pageSize }}</span><button class="quiet-button small" :disabled="page >= queue.lastPage" @click="changePage(1)">下一页</button></div>
    </section>

    <div v-if="createMessageOpen" class="modal-backdrop" @click.self="createMessageOpen = false">
      <section class="record-editor-modal telegram-message-editor">
        <div class="section-heading compact-heading"><div><span class="section-kicker">消息工作表</span><h3>新增本地消息</h3><p>只加入当前 {{ toolNames[tool] }} 工作表，不会发送或写回 Telegram。</p></div><button class="quiet-button small" @click="createMessageOpen = false">关闭</button></div>
        <div class="form-grid two">
          <label>来源<select v-model.number="createMessageSourceId"><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }} · {{ sourceMethodName(source) }}</option></select></label>
          <label>消息时间<input v-model="createMessageDate" type="datetime-local" /></label>
        </div>
        <label class="full-field">消息正文<textarea v-model="createMessageText" rows="12" placeholder="粘贴要交给当前工具处理的消息正文"></textarea></label>
        <div class="action-row"><button class="primary-button" :disabled="createMessageBusy || !createMessageText.trim()" @click="saveCreatedMessage">{{ createMessageBusy ? "保存中…" : "保存并分析" }}</button><button class="quiet-button" @click="createMessageOpen = false">取消</button></div>
      </section>
    </div>
  </section>
</template>
