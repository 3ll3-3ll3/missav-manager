<script setup lang="ts">
import QRCode from "qrcode";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  callTelegramBot, deleteInputSource, getAppSetting, listInputSources,
  saveInputSource, telegramUserConnect, telegramUserListDialogs,
  telegramUserCancelAuth, telegramUserLogout, telegramUserQrPoll, telegramUserQrStep, telegramUserStartPhone, telegramUserStatus,
  telegramUserSubmitCode, telegramUserSubmitPassword,
} from "../api";
import { telegramBotSessionName, telegramBotSessionToken } from "../telegramBotSession";
import {
  TELEGRAM_READ_POLICIES, telegramReadPolicy,
  telegramReadPolicyLabel, telegramReadStateLabel, withTelegramReadPolicy,
  type TelegramReadPolicy,
} from "../telegramReadPolicy";
import type { SourceInput, SourceRecord, TelegramAuthState, TelegramDialog, ToolKind } from "../types";
import SpreadsheetTable, { type SpreadsheetColumn } from "./SpreadsheetTable.vue";

const tools: Array<{ id: ToolKind; label: string }> = [
  { id: "twitter", label: "推特博主" }, { id: "badnews", label: "Bad.news" },
  { id: "haijiao", label: "海角" }, { id: "missav", label: "MissAV" }, { id: "av123", label: "123AV" },
];
const sources = ref<SourceRecord[]>([]);
const section = ref<"personal" | "bot" | "manual">("personal");
const error = ref("");
const status = ref("");
const search = ref("");
const editing = ref<SourceInput>({ kind: "manual", externalId: "", name: "", sourceType: "file", enabled: true, checkpoint: "", continuation: "", metadata: {}, boundTools: [] });

const apiId = ref(""); const apiHash = ref(""); const phone = ref(""); const code = ref(""); const password = ref("");
const auth = ref<TelegramAuthState>({ status: "disconnected", configured: false, connected: false, accountKey: "", accountLabel: "", hint: "", qrUrl: "", qrExpiresAt: 0 });
const qrDataUrl = ref(""); const personalBusy = ref(false); const dialogs = ref<TelegramDialog[]>([]); const dialogSearch = ref("");
const qrPolling = ref(false); const authStatusPolling = ref(false); const qrClock = ref(Date.now()); let qrTimer: number | undefined; let renderedQrUrl = "";
const selectedDialogs = ref(new Set<string>()); const initialMode = ref<"from_now" | "recent">("from_now");
const historyLimit = ref(2000); const readPolicy = ref<TelegramReadPolicy>("safe_auto");
const selectedSourceIds = ref(new Set<number>());

const botToken = telegramBotSessionToken; const botName = telegramBotSessionName; const botBusy = ref(false); const discovered = ref<TelegramDialog[]>([]); const selectedBot = ref(new Set<string>());
const visibleSources = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return !needle ? sources.value : sources.value.filter((item) => `${item.name} ${item.externalId} ${item.kind} ${item.sourceType} ${item.boundTools.join(" ")}`.toLowerCase().includes(needle));
});
const visibleDialogs = computed(() => {
  const needle = dialogSearch.value.trim().toLowerCase();
  return !needle ? dialogs.value : dialogs.value.filter((item) => `${item.name} ${item.username} ${item.sourceType}`.toLowerCase().includes(needle));
});
const selectedPersonalCount = computed(() => selectedDialogs.value.size);
const selectedBotCount = computed(() => selectedBot.value.size);
const manualHistoryLimit = computed({
  get: () => Number(editing.value.metadata.historyLimit || 2000),
  set: (value: number) => { editing.value.metadata = { ...editing.value.metadata, historyLimit: Math.max(1, Math.min(20_000, Number(value) || 2000)) }; },
});
const manualReadPolicy = computed<TelegramReadPolicy>({
  get: () => telegramReadPolicy(editing.value.metadata),
  set: (value) => { editing.value.metadata = withTelegramReadPolicy(editing.value.metadata, value); },
});
const sourceTableRows = computed(() => visibleSources.value.map((item) => ({
  ...item,
  enabledText: item.enabled ? "是" : "否",
  boundToolsText: item.boundTools.join(", "),
  readPolicyText: item.kind === "telegram_user" ? telegramReadPolicyLabel(item.metadata) : "-",
  readStateText: item.kind === "telegram_user" ? telegramReadStateLabel(item.metadata) : "-",
  metadataText: JSON.stringify(item.metadata, null, 2),
})));
const sourceColumns: SpreadsheetColumn[] = [
  { title: "ID", field: "id", width: 72, editable: false, filterable: false },
  { title: "名称", field: "name", width: 200 }, { title: "来源方式", field: "kind", width: 135, editable: false },
  { title: "群组 / 频道 ID", field: "externalId", width: 190 }, { title: "类型", field: "sourceType", width: 120 },
  { title: "启用", field: "enabledText", width: 90 }, { title: "绑定工具", field: "boundToolsText", width: 240, longText: true },
  { title: "检查点", field: "checkpoint", width: 140 }, { title: "继续状态", field: "continuation", width: 180, longText: true },
  { title: "已读策略", field: "readPolicyText", width: 210, editable: false }, { title: "Telegram 已读状态", field: "readStateText", width: 230, editable: false, longText: true },
  { title: "最后同步", field: "lastSyncAt", width: 205, editable: false }, { title: "元数据", field: "metadataText", width: 360, longText: true },
];
const authInProgress = computed(() => personalBusy.value || ["connecting", "authorizing", "waiting_qr", "waiting_code", "waiting_password"].includes(auth.value.status));
const qrSeconds = computed(() => Math.max(0, Math.ceil((auth.value.qrExpiresAt - qrClock.value) / 1000)));
function toggle(set: Set<string>, key: string) { const next = new Set(set); next.has(key) ? next.delete(key) : next.add(key); return next; }
function toggleTools(value: ToolKind[], tool: ToolKind) { const set = new Set(value); set.has(tool) ? set.delete(tool) : set.add(tool); return [...set]; }
function resetManual() { editing.value = { kind: "manual", externalId: "", name: "", sourceType: "file", enabled: true, checkpoint: "", continuation: "", metadata: {}, boundTools: [] }; }
function edit(item: SourceRecord) { section.value = "manual"; editing.value = { id: item.id, kind: item.kind, externalId: item.externalId, name: item.name, sourceType: item.sourceType, enabled: item.enabled, checkpoint: item.checkpoint, continuation: item.continuation, metadata: item.metadata, boundTools: [...item.boundTools] }; }
function toggleManualTool(tool: ToolKind) { editing.value.boundTools = toggleTools(editing.value.boundTools, tool); }
async function refreshSources() { sources.value = await listInputSources(); }
async function saveManual() { error.value = ""; try { await saveInputSource(editing.value); resetManual(); await refreshSources(); status.value = "来源已保存"; } catch (reason) { error.value = String(reason); } }
async function removeSourceRows(keys: Array<string | number>) { const ids = keys.map(Number); if (!ids.length || !confirm(`删除所选 ${ids.length} 个来源？已生成的任务和永久数据不会删除。`)) return; for (const id of ids) await deleteInputSource(id); selectedSourceIds.value = new Set(); await refreshSources(); }
async function editSourceCell(payload: { row: Record<string, unknown>; field: string; value: unknown; oldValue: unknown }) { const item = sources.value.find((source) => source.id === Number(payload.row.id)); if (!item) return; const next: SourceInput = { id: item.id, kind: item.kind, externalId: item.externalId, name: item.name, sourceType: item.sourceType, enabled: item.enabled, checkpoint: item.checkpoint, continuation: item.continuation, metadata: { ...item.metadata }, boundTools: [...item.boundTools] }; try { if (payload.field === "name") next.name = String(payload.value); else if (payload.field === "externalId") next.externalId = String(payload.value); else if (payload.field === "sourceType") next.sourceType = String(payload.value); else if (payload.field === "enabledText") next.enabled = /^(?:1|是|true|启用)$/i.test(String(payload.value).trim()); else if (payload.field === "checkpoint") next.checkpoint = String(payload.value); else if (payload.field === "continuation") next.continuation = String(payload.value); else if (payload.field === "boundToolsText") { const values = String(payload.value).split(/[,，\s]+/).filter(Boolean) as ToolKind[]; if (values.some((tool) => !tools.some((candidate) => candidate.id === tool))) throw new Error("绑定工具只能填写 twitter、badnews、haijiao、missav、av123"); next.boundTools = [...new Set(values)]; } else if (payload.field === "metadataText") next.metadata = JSON.parse(String(payload.value || "{}")); else return; await saveInputSource(next); await refreshSources(); status.value = "来源单元格已保存。"; } catch (reason) { error.value = String(reason); await refreshSources(); } }
async function withUiTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = window.setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}
async function runtimeProxy() {
  const settings = await withUiTimeout(
    getAppSetting<{ proxyEnabled?: boolean; proxyUrl?: string }>("runtime"),
    3_000,
    "读取代理设置超时；界面已自动解锁",
  );
  return settings?.proxyEnabled ? String(settings.proxyUrl || "") : "";
}

function applyAuth(next: TelegramAuthState) {
  auth.value = next;
  if (next.status === "ready" || next.status === "disconnected") {
    qrDataUrl.value = ""; renderedQrUrl = ""; code.value = ""; password.value = "";
  }
}
async function applyQrAuth(next: TelegramAuthState) {
  applyAuth(next);
  if (next.qrUrl && next.qrUrl !== renderedQrUrl) {
    qrDataUrl.value = await QRCode.toDataURL(next.qrUrl, { width: 280, margin: 2, errorCorrectionLevel: "M" });
    renderedQrUrl = next.qrUrl;
  }
}
async function refreshPersonalAuth() {
  if (authStatusPolling.value) return;
  authStatusPolling.value = true;
  try {
    const next = await withUiTimeout(telegramUserStatus(), 4_000, "读取 Telegram 登录状态超时");
    await applyQrAuth(next);
    status.value = next.connected ? `已连接 ${next.accountLabel}` : next.hint;
    if (next.status === "error" && next.hint) error.value = next.hint;
  } catch (reason) {
    if (["connecting", "authorizing"].includes(auth.value.status)) error.value = String(reason);
  } finally {
    authStatusPolling.value = false;
  }
}
async function connectPersonal() { personalBusy.value = true; error.value = ""; try { applyAuth(await withUiTimeout(telegramUserConnect(), 5_000, "启动恢复登录超时；界面已自动解锁")); status.value = auth.value.connected ? `已连接 ${auth.value.accountLabel}` : auth.value.hint; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function startPhone() { personalBusy.value = true; error.value = ""; try { applyAuth(await withUiTimeout(telegramUserStartPhone(Number(apiId.value), apiHash.value, phone.value, await runtimeProxy()), 5_000, "启动手机号登录超时；界面已自动解锁")); status.value = auth.value.hint; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function submitCode() { personalBusy.value = true; error.value = ""; try { applyAuth(await telegramUserSubmitCode(code.value)); status.value = auth.value.hint || "Telegram 已登录"; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function submitPassword() { personalBusy.value = true; error.value = ""; try { applyAuth(await telegramUserSubmitPassword(password.value)); status.value = auth.value.hint || "Telegram 已登录"; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function qrStep() {
  personalBusy.value = true; error.value = "";
  try {
    const next = await withUiTimeout(telegramUserQrStep(Number(apiId.value), apiHash.value, await runtimeProxy()), 5_000, "启动二维码登录超时；界面已自动解锁"); await applyQrAuth(next);
    status.value = next.hint || "二维码已刷新";
  } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; }
}
async function pollQr(confirm = false) {
  if (qrPolling.value || auth.value.status !== "waiting_qr") return;
  qrPolling.value = true;
  try {
    const next = await telegramUserQrPoll(confirm); await applyQrAuth(next);
    status.value = next.connected ? `已连接 ${next.accountLabel}` : next.hint;
  } catch (reason) {
    if (confirm) error.value = String(reason);
  } finally { qrPolling.value = false; }
}
async function cancelAuth() {
  personalBusy.value = true;
  try { applyAuth(await telegramUserCancelAuth()); status.value = "已取消当前 Telegram 登录"; }
  catch (reason) { error.value = String(reason); }
  finally { personalBusy.value = false; }
}
async function logoutPersonal() { if (!confirm("退出 Telegram 个人账号并删除本机会话？已保存的来源和处理历史不会删除。")) return; personalBusy.value = true; try { applyAuth(await telegramUserLogout()); dialogs.value = []; selectedDialogs.value = new Set(); status.value = "已退出 Telegram 个人账号"; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function refreshDialogs() { personalBusy.value = true; error.value = ""; try { dialogs.value = await telegramUserListDialogs(1000); status.value = `已读取 ${dialogs.value.length} 个群组、超级群和频道`; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
function selectAllDialogs() { selectedDialogs.value = new Set(visibleDialogs.value.map((item) => item.id)); }
function clearDialogs() { selectedDialogs.value = new Set(); }
async function bindPersonal() {
  if (!selectedDialogs.value.size) return;
  const chosen = dialogs.value.filter((item) => selectedDialogs.value.has(item.id));
  const existing = new Set(sources.value.filter((item) => item.kind === "telegram_user").map((item) => item.externalId));
  const additions = chosen.filter((item) => !existing.has(item.id));
  if (existing.size + additions.length > 100) { error.value = "个人账号来源上限为 100 个，请先删除不用的来源"; return; }
  const additionsCount = chosen.filter((item) => !existing.has(item.id)).length;
  if (!confirm(`确认把所选 ${chosen.length} 个群组/频道保存到来源库？\n\n其中 ${additionsCount} 个是新来源。这里不会绑定任何工具；请进入具体工具的 Telegram 页面选择绑定。`)) return;
  for (const item of chosen) {
    const previous = sources.value.find((source) => source.kind === "telegram_user" && source.externalId === item.id);
    const baseline = !previous && initialMode.value === "from_now" ? Number(item.latestMessageId || 0) : 0;
    const metadata = previous
      ? { ...previous.metadata, username: item.username, account: auth.value.accountLabel }
      : withTelegramReadPolicy({ username: item.username, account: auth.value.accountLabel, initialMode: initialMode.value, historyLimit: historyLimit.value, ...(baseline > 0 ? { readBaselineMessageId: baseline, readState: "baseline" } : {}) }, readPolicy.value);
    await saveInputSource({ id: previous?.id, kind: "telegram_user", externalId: item.id, name: item.name, sourceType: item.sourceType, enabled: true,
      checkpoint: previous?.checkpoint ?? (initialMode.value === "from_now" ? String(item.latestMessageId || "") : ""), continuation: previous?.continuation || "", metadata, boundTools: previous?.boundTools || [] });
  }
  await refreshSources(); status.value = `已保存 ${chosen.length} 个群组/频道（新增 ${additionsCount} 个）；工具绑定请在各工具的 Telegram 页面完成。${initialMode.value === "from_now" ? "新来源将从下一条消息开始" : "新来源可在工具内按范围加载历史"}。`;
}
async function botCall(method: string, body: Record<string, unknown> = {}) {
  const response = await callTelegramBot(botToken.value, method, body, await runtimeProxy());
  let payload: Record<string, unknown> = {}; try { payload = JSON.parse(response.body); } catch { throw new Error(`Telegram 返回无法解析（HTTP ${response.statusCode}）`); }
  if (response.statusCode !== 200 || payload.ok !== true) throw new Error(String(payload.description || `Telegram HTTP ${response.statusCode}`));
  return payload.result;
}
function updateMessage(update: Record<string, unknown>) { return (update.message || update.channel_post || update.edited_message || update.edited_channel_post) as Record<string, unknown> | undefined; }
function botChat(update: Record<string, unknown>) { return updateMessage(update)?.chat as Record<string, unknown> | undefined; }
function botChatName(chat: Record<string, unknown>) { return String(chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.id); }
function botText(message: Record<string, unknown>) { const entities = Array.isArray(message.entities) ? message.entities : []; return [String(message.text || message.caption || ""), ...entities.filter((entity: Record<string, unknown>) => entity.type === "text_link" && entity.url).map((entity: Record<string, unknown>) => String(entity.url))].filter(Boolean).join("\n"); }
async function discoverBot() {
  if (!botToken.value.trim()) return; botBusy.value = true; error.value = "";
  try {
    const me = await botCall("getMe"); botName.value = String((me as Record<string, unknown>).username || (me as Record<string, unknown>).first_name || "Bot");
    const offset = await getAppSetting<number>("telegram.bot.offset") || 0;
    const updates = await botCall("getUpdates", { offset, limit: 100, timeout: 0, allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post"] }) as Array<Record<string, unknown>>;
    const map = new Map<string, TelegramDialog>();
    for (const update of updates) { const chat = botChat(update); if (!chat) continue; const type = String(chat.type || "group"); if (!["group", "supergroup", "channel"].includes(type)) continue; const id = String(chat.id); map.set(id, { id, name: botChatName(chat), sourceType: type, username: String(chat.username || ""), latestMessageId: Number(update.update_id || 0), latestMessageDate: "" }); }
    discovered.value = [...map.values()].sort((a, b) => a.name.localeCompare(b.name)); status.value = `Bot 已发现 ${discovered.value.length} 个群组/频道；Bot 只能读取被加入后收到的更新`;
  } catch (reason) { error.value = String(reason); } finally { botBusy.value = false; }
}
async function bindBot() {
  const chosen = discovered.value.filter((item) => selectedBot.value.has(item.id)); if (!chosen.length) return;
  if (!confirm(`确认把所选 ${chosen.length} 个 Bot 群组/频道保存到来源库？\n\n这里不会绑定工具；请进入具体工具的 Telegram 页面选择绑定。`)) return;
  for (const item of chosen) {
    const previous = sources.value.find((source) => source.kind === "telegram_bot" && source.externalId === item.id);
    await saveInputSource({ id: previous?.id, kind: "telegram_bot", externalId: item.id, name: item.name, sourceType: item.sourceType, enabled: true, checkpoint: previous?.checkpoint || "", continuation: previous?.continuation || "", metadata: { ...(previous?.metadata || {}), bot: botName.value, username: item.username }, boundTools: previous?.boundTools || [] });
  }
  await refreshSources(); status.value = `已保存 ${chosen.length} 个 Bot 来源；工具绑定请在各工具的 Telegram 页面完成。`;
}
onMounted(async () => {
  await refreshSources();
  try { await applyQrAuth(await telegramUserStatus()); } catch { /* backend unavailable state is shown on first action */ }
  qrTimer = window.setInterval(() => {
    qrClock.value = Date.now();
    if (auth.value.status === "waiting_qr") void pollQr(false);
    else if (["connecting", "authorizing"].includes(auth.value.status)) void refreshPersonalAuth();
  }, 1_200);
});
onBeforeUnmount(() => { if (qrTimer) window.clearInterval(qrTimer); });
</script>

<template>
  <section class="page-intro compact"><div><span class="section-kicker">Telegram 来源</span><h2>账号连接与群组来源库</h2><p>这里只负责登录、Bot 连接、发现并保存群组/频道。具体绑定、个人 API 增量同步、历史加载、筛选处理和手动标已读均在每个工具的“Telegram 消息”页面完成。</p></div><div class="inline-stat"><strong>{{ sources.length }}</strong><span>已保存来源</span></div></section>
  <div class="notice info">先在这里把群组/频道保存进来源库，再进入具体工具选择绑定。一个来源可绑定多个工具；来源页不会替你猜目标工具，避免错绑。</div>
  <div v-if="error" class="notice danger">{{ error }}</div><div v-if="status" class="notice info">{{ status }}</div>
  <section class="panel"><div class="source-tabs"><button :class="{ active: section === 'personal' }" @click="section = 'personal'">个人账号 API</button><button :class="{ active: section === 'bot' }" @click="section = 'bot'">Bot API</button><button :class="{ active: section === 'manual' }" @click="section = 'manual'">手动来源</button></div>

    <div v-if="section === 'personal'" class="source-section">
      <div class="section-heading compact-heading"><div><h3>个人账号登录与群组/频道同步</h3><p>凭据由 Windows 当前用户加密保存；会话仅用于本软件。Clash 使用设置页的代理，混合端口会自动按 SOCKS5 连接 Telegram。</p></div><span class="state-chip" :class="auth.status">{{ auth.connected ? `已连接 · ${auth.accountLabel}` : auth.status }}</span></div>
      <div class="source-fields personal-login"><label>api_id<input v-model="apiId" inputmode="numeric" placeholder="my.telegram.org 的 api_id" /></label><label>api_hash<input v-model="apiHash" type="password" autocomplete="off" placeholder="my.telegram.org 的 api_hash" /></label><div class="action-row"><button class="quiet-button" :disabled="authInProgress || !auth.configured" @click="connectPersonal">恢复已保存登录</button><button class="danger-button small" :disabled="authInProgress || !auth.configured" @click="logoutPersonal">退出本机登录</button></div></div>
      <div class="auth-grid"><div class="auth-card"><strong>扫码登录</strong><small>沿用 v0.4.5 的后台授权流程：启动后立即解锁界面，二维码自动刷新，扫码后自动确认。</small><div class="action-row"><button class="primary-button" :disabled="personalBusy || ['connecting', 'authorizing', 'waiting_code', 'waiting_password'].includes(auth.status)" @click="qrStep">{{ auth.status === "waiting_qr" ? "立即刷新二维码" : "生成二维码" }}</button><button class="quiet-button" :disabled="personalBusy || !qrDataUrl" @click="pollQr(true)">我已扫码，立即确认</button><button v-if="['connecting', 'authorizing', 'waiting_qr'].includes(auth.status)" class="danger-button small" @click="cancelAuth">立即取消并解锁</button></div><img v-if="qrDataUrl" class="telegram-qr" :src="qrDataUrl" alt="Telegram 登录二维码" /><p v-if="auth.status === 'waiting_qr'" class="field-hint">{{ qrPolling ? "正在检查扫码结果…" : `等待扫码 · 约 ${qrSeconds} 秒后自动刷新` }}</p><p v-if="auth.hint" class="field-hint">{{ auth.hint }}</p></div><div class="auth-card"><strong>手机号登录</strong><small>使用国际格式手机号；验证码通常会发到已登录 Telegram 客户端。</small><label>手机号<input v-model="phone" :disabled="['connecting', 'authorizing', 'waiting_qr'].includes(auth.status)" placeholder="+8613800000000" /></label><button class="primary-button" :disabled="authInProgress" @click="startPhone">发送验证码</button><label v-if="auth.status === 'waiting_code'">验证码<input v-model="code" inputmode="numeric" autocomplete="one-time-code" /><button class="quiet-button" :disabled="personalBusy" @click="submitCode">确认验证码</button></label><label v-if="auth.status === 'waiting_password'">两步验证密码<input v-model="password" type="password" autocomplete="current-password" /><button class="quiet-button" :disabled="personalBusy" @click="submitPassword">确认密码</button></label><button v-if="auth.status === 'waiting_code' || auth.status === 'waiting_password'" class="danger-button small" :disabled="personalBusy" @click="cancelAuth">取消当前登录</button></div></div>
      <div class="source-toolbar"><div><strong>群组与频道来源库</strong><small>登录后刷新；仅显示群组、超级群和频道，不会把私聊混进来。</small></div><button class="primary-button" :disabled="personalBusy || !auth.connected" @click="refreshDialogs">刷新群组/频道</button></div>
      <div v-if="dialogs.length" class="source-picker"><div class="grid-toolbar"><label class="search-box">搜索<input v-model="dialogSearch" placeholder="名称、用户名或类型" /></label><span>已选 {{ selectedPersonalCount }} / {{ dialogs.length }}</span><button class="quiet-button small" @click="selectAllDialogs">全选可见</button><button class="quiet-button small" @click="clearDialogs">清空</button></div><div class="source-choice-list"><label v-for="item in visibleDialogs" :key="item.id" class="source-choice"><input type="checkbox" :checked="selectedDialogs.has(item.id)" @change="selectedDialogs = toggle(selectedDialogs, item.id)" /><span><strong>{{ item.name }}</strong><small>{{ item.sourceType }} · {{ item.username ? '@' + item.username : item.id }} · 最新消息 {{ item.latestMessageId || '-' }}</small></span></label></div><div class="binding-bar"><label>首次保存策略<select v-model="initialMode"><option value="from_now">从现在开始（不回拉旧消息）</option><option value="recent">允许后续按范围回拉历史</option></select></label><label v-if="initialMode === 'recent'">工具内单次历史上限<input v-model.number="historyLimit" type="number" min="1" max="20000" /></label><label>Telegram 已读策略<select v-model="readPolicy"><option v-for="item in TELEGRAM_READ_POLICIES" :key="item.value" :value="item.value">{{ item.label }}</option></select><small class="field-hint">{{ TELEGRAM_READ_POLICIES.find(item => item.value === readPolicy)?.hint }}</small></label><button class="primary-button" :disabled="!selectedPersonalCount" @click="bindPersonal">保存所选 {{ selectedPersonalCount }} 个到来源库</button></div><div v-if="initialMode === 'recent'" class="notice info compact-notice">历史加载永不会自动标记 Telegram 已读。<span v-if="historyLimit > 2000">单次最多加载 {{ historyLimit.toLocaleString() }} 条，可能耗时较长。</span></div></div>
    </div>

    <div v-else-if="section === 'bot'" class="source-section"><div class="section-heading compact-heading"><div><h3>Bot API 连接</h3><p>只读取机器人加入群组或频道之后收到的消息。这里仅负责连接、发现和保存来源；接收更新、绑定与处理都在具体工具内完成。</p></div></div><div class="source-fields"><label>Bot Token<input v-model="botToken" type="password" autocomplete="off" placeholder="123456:ABC…" /></label><div class="action-row"><button class="primary-button" :disabled="botBusy || !botToken.trim()" @click="discoverBot">发现群组/频道</button></div><small class="field-hint">Token 只在本次 APP 运行内存中共享。进入任一工具的 Telegram 页面后可直接接收 Bot 更新。</small></div><div v-if="discovered.length" class="source-picker"><div class="grid-toolbar"><span>已发现 {{ discovered.length }} 个，已选 {{ selectedBotCount }}</span><button class="quiet-button small" @click="selectedBot = new Set(discovered.map(item => item.id))">全选</button><button class="quiet-button small" @click="selectedBot = new Set()">清空</button></div><div class="source-choice-list"><label v-for="item in discovered" :key="item.id" class="source-choice"><input type="checkbox" :checked="selectedBot.has(item.id)" @change="selectedBot = toggle(selectedBot, item.id)" /><span><strong>{{ item.name }}</strong><small>{{ item.sourceType }} · {{ item.username ? '@' + item.username : item.id }}</small></span></label></div><div class="binding-bar"><button class="primary-button" :disabled="!selectedBotCount" @click="bindBot">保存所选 {{ selectedBotCount }} 个到来源库</button></div></div></div>

    <div v-else class="source-section"><div class="section-heading compact-heading"><div><h3>手动来源与来源编辑</h3><p>可用于文件夹、导出文件或修正任何已有来源的名称、工具绑定、检查点与启用状态。</p></div></div><div class="form-grid two"><label>名称<input v-model="editing.name" placeholder="来源名称" /></label><label>外部 ID / 路径<input v-model="editing.externalId" placeholder="可选唯一标识" /></label><label>类型<select v-model="editing.sourceType"><option value="file">文件</option><option value="folder">文件夹</option><option value="group">群组</option><option value="supergroup">超级群</option><option value="channel">频道</option></select></label><label>检查点<input v-model="editing.checkpoint" placeholder="可选，用于增量" /></label><label v-if="editing.kind === 'telegram_user'">单次历史上限<input v-model.number="manualHistoryLimit" type="number" min="1" max="20000" /></label><label class="checkbox-line"><input v-model="editing.enabled" type="checkbox" />启用来源</label><label v-if="editing.kind === 'telegram_user'">Telegram 已读策略<select v-model="manualReadPolicy"><option v-for="item in TELEGRAM_READ_POLICIES" :key="item.value" :value="item.value">{{ item.label }}</option></select><small class="field-hint">{{ TELEGRAM_READ_POLICIES.find(item => item.value === manualReadPolicy)?.hint }}</small></label></div><div class="tool-checks"><label v-for="tool in tools" :key="tool.id"><input type="checkbox" :checked="editing.boundTools.includes(tool.id)" @change="toggleManualTool(tool.id)" />{{ tool.label }}</label></div><div class="action-row"><button class="primary-button" @click="saveManual">保存来源</button><button class="quiet-button" @click="resetManual">新建空白来源</button></div></div>
  </section>

  <section class="panel source-data-panel">
    <div class="section-heading compact-heading"><div><h3>已保存来源连接</h3><p>这里维护连接层数据；群组绑定、同步和标已读请进入具体工具。表格仍支持单元格编辑、复制与批量删除。</p></div></div>
    <div class="grid-toolbar result-tools"><label class="search-box">搜索<input v-model="search" placeholder="名称、ID、类型或绑定工具" /></label><strong>{{ visibleSources.length }} 项</strong><button class="quiet-button small" @click="refreshSources">刷新</button><button class="quiet-button small" :disabled="selectedSourceIds.size !== 1" @click="edit(sources.find(item => selectedSourceIds.has(item.id))!)">表单编辑</button></div>
    <SpreadsheetTable table-id="telegram-sources" :rows="sourceTableRows" :columns="sourceColumns" :selected-keys="[...selectedSourceIds]" :total-selected="selectedSourceIds.size" height="min(56vh, 650px)" @selection-change="selectedSourceIds = new Set($event.map(Number))" @clear-all-selection="selectedSourceIds = new Set()" @cell-edited="editSourceCell" @delete-selected="removeSourceRows" />
  </section>
</template>
