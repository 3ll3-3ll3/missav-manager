<script setup lang="ts">
import QRCode from "qrcode";
import { computed, onMounted, ref } from "vue";
import {
  callTelegramBot, createContentRun, deleteInputSource, getAppSetting, listInputSources,
  saveInputSource, setAppSetting, telegramUserConnect, telegramUserListDialogs,
  telegramUserLogout, telegramUserQrStep, telegramUserStartPhone, telegramUserStatus,
  telegramUserSubmitCode, telegramUserSubmitPassword, telegramUserSyncMessages,
} from "../api";
import { processToolInput } from "../processing";
import type { SourceInput, SourceRecord, TelegramAuthState, TelegramDialog, ToolKind } from "../types";

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
const selectedDialogs = ref(new Set<string>()); const personalBindings = ref<ToolKind[]>([]); const initialMode = ref<"from_now" | "recent">("from_now");
const syncStart = ref(""); const syncEnd = ref("");

const botToken = ref(""); const botName = ref(""); const botBusy = ref(false); const discovered = ref<TelegramDialog[]>([]); const selectedBot = ref(new Set<string>()); const botBindings = ref<ToolKind[]>([]);
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

function toggle(set: Set<string>, key: string) { const next = new Set(set); next.has(key) ? next.delete(key) : next.add(key); return next; }
function toggleTools(value: ToolKind[], tool: ToolKind) { const set = new Set(value); set.has(tool) ? set.delete(tool) : set.add(tool); return [...set]; }
function toIso(value: string) { return value ? new Date(value).toISOString() : ""; }
function resetManual() { editing.value = { kind: "manual", externalId: "", name: "", sourceType: "file", enabled: true, checkpoint: "", continuation: "", metadata: {}, boundTools: [] }; }
function edit(item: SourceRecord) { section.value = "manual"; editing.value = { id: item.id, kind: item.kind, externalId: item.externalId, name: item.name, sourceType: item.sourceType, enabled: item.enabled, checkpoint: item.checkpoint, continuation: item.continuation, metadata: item.metadata, boundTools: [...item.boundTools] }; }
function toggleManualTool(tool: ToolKind) { editing.value.boundTools = toggleTools(editing.value.boundTools, tool); }
async function refreshSources() { sources.value = await listInputSources(); }
async function saveManual() { error.value = ""; try { await saveInputSource(editing.value); resetManual(); await refreshSources(); status.value = "来源已保存"; } catch (reason) { error.value = String(reason); } }
async function remove(item: SourceRecord) { if (!confirm(`删除来源“${item.name}”？已退出的群组、频道或无效绑定可在此彻底清理。`)) return; await deleteInputSource(item.id); await refreshSources(); }
async function runtimeProxy() { const settings = await getAppSetting<{ proxyEnabled?: boolean; proxyUrl?: string }>("runtime"); return settings?.proxyEnabled ? String(settings.proxyUrl || "") : ""; }

function applyAuth(next: TelegramAuthState) { auth.value = next; if (next.status === "ready") { qrDataUrl.value = ""; code.value = ""; password.value = ""; } }
async function connectPersonal() { personalBusy.value = true; error.value = ""; try { applyAuth(await telegramUserConnect()); status.value = auth.value.connected ? `已连接 ${auth.value.accountLabel}` : auth.value.hint; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function startPhone() { personalBusy.value = true; error.value = ""; try { applyAuth(await telegramUserStartPhone(Number(apiId.value), apiHash.value, phone.value, await runtimeProxy())); status.value = auth.value.hint; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function submitCode() { personalBusy.value = true; error.value = ""; try { applyAuth(await telegramUserSubmitCode(code.value)); status.value = auth.value.hint || "Telegram 已登录"; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function submitPassword() { personalBusy.value = true; error.value = ""; try { applyAuth(await telegramUserSubmitPassword(password.value)); status.value = auth.value.hint || "Telegram 已登录"; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function qrStep() {
  personalBusy.value = true; error.value = "";
  try {
    const next = await telegramUserQrStep(Number(apiId.value), apiHash.value, await runtimeProxy()); applyAuth(next);
    qrDataUrl.value = next.qrUrl ? await QRCode.toDataURL(next.qrUrl, { width: 208, margin: 1, errorCorrectionLevel: "M" }) : "";
    status.value = next.hint || "二维码已刷新";
  } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; }
}
async function logoutPersonal() { if (!confirm("退出 Telegram 个人账号并删除本机会话？已保存的来源和处理历史不会删除。")) return; personalBusy.value = true; try { applyAuth(await telegramUserLogout()); dialogs.value = []; selectedDialogs.value = new Set(); status.value = "已退出 Telegram 个人账号"; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
async function refreshDialogs() { personalBusy.value = true; error.value = ""; try { dialogs.value = await telegramUserListDialogs(1000); status.value = `已读取 ${dialogs.value.length} 个群组、超级群和频道`; } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; } }
function selectAllDialogs() { selectedDialogs.value = new Set(visibleDialogs.value.map((item) => item.id)); }
function clearDialogs() { selectedDialogs.value = new Set(); }
async function bindPersonal() {
  if (!selectedDialogs.value.size) return; if (!personalBindings.value.length) { error.value = "至少选择一个要接收消息的工具"; return; }
  const chosen = dialogs.value.filter((item) => selectedDialogs.value.has(item.id));
  const existing = new Set(sources.value.filter((item) => item.kind === "telegram_user").map((item) => item.externalId));
  const additions = chosen.filter((item) => !existing.has(item.id));
  if (existing.size + additions.length > 100) { error.value = "个人账号来源上限为 100 个，请先删除不用的来源"; return; }
  for (const item of chosen) {
    await saveInputSource({ kind: "telegram_user", externalId: item.id, name: item.name, sourceType: item.sourceType, enabled: true,
      checkpoint: initialMode.value === "from_now" ? String(item.latestMessageId || "") : "", continuation: "", metadata: { username: item.username, account: auth.value.accountLabel, initialMode: initialMode.value }, boundTools: personalBindings.value });
  }
  await refreshSources(); status.value = `已绑定 ${chosen.length} 个群组/频道；${initialMode.value === "from_now" ? "将从下一条新消息开始" : "首次同步会回拉最近消息"}`;
}
async function syncPersonal() {
  const bound = sources.value.filter((item) => item.kind === "telegram_user" && item.enabled && item.boundTools.length);
  if (!bound.length) { error.value = "没有已启用的个人 API 来源"; return; }
  personalBusy.value = true; error.value = ""; let created = 0; let messages = 0;
  try {
    for (const source of bound) {
      const synced = await telegramUserSyncMessages({ externalId: source.externalId, checkpoint: Number(source.checkpoint || 0), limit: 20_000, start: toIso(syncStart.value), end: toIso(syncEnd.value) });
      messages += synced.messages.length;
      const input = JSON.stringify({ messages: synced.messages.map((item) => ({ date: item.date, text: item.text })) });
      for (const tool of source.boundTools) {
        const processed = processToolInput(tool, [{ name: `Telegram API · ${source.name}`, text: input }], toIso(syncStart.value), toIso(syncEnd.value));
        await createContentRun({ tool, name: `${source.name} 增量 ${new Date().toLocaleString("zh-CN", { hour12: false })}`, inputKind: "telegram_user", originalInput: input, options: { sourceId: source.id, chatId: source.externalId, account: auth.value.accountLabel }, results: processed.results }); created += 1;
      }
      await saveInputSource({ id: source.id, kind: source.kind, externalId: source.externalId, name: source.name, sourceType: source.sourceType, enabled: source.enabled, checkpoint: String(synced.checkpoint || source.checkpoint), continuation: synced.hasMore ? "history_limit_reached" : "", metadata: source.metadata, boundTools: source.boundTools });
    }
    await refreshSources(); status.value = `个人 API 同步完成：${bound.length} 个来源、${messages} 条消息，建立 ${created} 条工具处理历史`;
  } catch (reason) { error.value = String(reason); } finally { personalBusy.value = false; }
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
  const chosen = discovered.value.filter((item) => selectedBot.value.has(item.id)); if (!chosen.length) return; if (!botBindings.value.length) { error.value = "至少选择一个工具"; return; }
  for (const item of chosen) await saveInputSource({ kind: "telegram_bot", externalId: item.id, name: item.name, sourceType: item.sourceType, enabled: true, checkpoint: "", continuation: "", metadata: { bot: botName.value, username: item.username }, boundTools: botBindings.value });
  await refreshSources(); status.value = `已绑定 ${chosen.length} 个 Bot 来源`;
}
async function syncBot() {
  if (!botToken.value.trim()) { error.value = "请输入 Bot Token"; return; }
  botBusy.value = true; error.value = "";
  try {
    let offset = await getAppSetting<number>("telegram.bot.offset") || 0; let total = 0; let created = 0;
    for (let page = 0; page < 20; page += 1) {
      const updates = await botCall("getUpdates", { offset, limit: 100, timeout: 0, allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post"] }) as Array<Record<string, unknown>>;
      if (!updates.length) break;
      const bound = (await listInputSources()).filter((item) => item.kind === "telegram_bot" && item.enabled && item.boundTools.length);
      for (const source of bound) {
        const messages = updates.filter((update) => String(botChat(update)?.id || "") === source.externalId).map((update) => { const message = updateMessage(update) || {}; return { date: new Date(Number(message.date || 0) * 1000).toISOString(), text: botText(message) }; }).filter((message) => message.text.trim());
        if (!messages.length) continue; const input = JSON.stringify({ messages });
        for (const tool of source.boundTools) { const processed = processToolInput(tool, [{ name: `Telegram Bot · ${source.name}`, text: input }]); await createContentRun({ tool, name: `${source.name} Bot 增量 ${new Date().toLocaleString("zh-CN", { hour12: false })}`, inputKind: "telegram_bot", originalInput: input, options: { sourceId: source.id, chatId: source.externalId }, results: processed.results }); created += 1; }
        total += messages.length;
      }
      offset = Math.max(offset, ...updates.map((item) => Number(item.update_id || 0) + 1)); await setAppSetting("telegram.bot.offset", offset);
      if (updates.length < 100) break;
    }
    status.value = `Bot 增量同步完成：${total} 条消息，建立 ${created} 条工具处理历史`;
  } catch (reason) { error.value = String(reason); } finally { botBusy.value = false; }
}

onMounted(async () => { await refreshSources(); try { applyAuth(await telegramUserStatus()); } catch { /* backend unavailable state is shown on first action */ } });
</script>

<template>
  <section class="page-intro compact"><div><span class="section-kicker">Telegram 来源</span><h2>个人账号 API 与 Bot 分开管理</h2><p>个人 API 可读取已加入的群组、超级群和频道；Bot 只接收被加入后收到的更新。一个来源可以同时绑定多个工具，最多 100 个个人 API 来源。</p></div><div class="inline-stat"><strong>{{ sources.length }}</strong><span>已保存来源</span></div></section>
  <div v-if="error" class="notice danger">{{ error }}</div><div v-if="status" class="notice info">{{ status }}</div>
  <section class="panel"><div class="source-tabs"><button :class="{ active: section === 'personal' }" @click="section = 'personal'">个人账号 API</button><button :class="{ active: section === 'bot' }" @click="section = 'bot'">Bot API</button><button :class="{ active: section === 'manual' }" @click="section = 'manual'">手动来源</button></div>

    <div v-if="section === 'personal'" class="source-section">
      <div class="section-heading compact-heading"><div><h3>个人账号登录与群组/频道同步</h3><p>凭据由 Windows 当前用户加密保存；会话仅用于本软件。Clash 使用设置页的代理，混合端口会自动按 SOCKS5 连接 Telegram。</p></div><span class="state-chip" :class="auth.status">{{ auth.connected ? `已连接 · ${auth.accountLabel}` : auth.status }}</span></div>
      <div class="source-fields personal-login"><label>api_id<input v-model="apiId" inputmode="numeric" placeholder="my.telegram.org 的 api_id" /></label><label>api_hash<input v-model="apiHash" type="password" autocomplete="off" placeholder="my.telegram.org 的 api_hash" /></label><div class="action-row"><button class="quiet-button" :disabled="personalBusy" @click="connectPersonal">恢复已保存登录</button><button class="danger-button small" :disabled="personalBusy || !auth.configured" @click="logoutPersonal">退出本机登录</button></div></div>
      <div class="auth-grid"><div class="auth-card"><strong>扫码登录</strong><small>更适合已经在手机 Telegram 登录的账号。</small><div class="action-row"><button class="primary-button" :disabled="personalBusy" @click="qrStep">生成 / 刷新二维码</button><button class="quiet-button" :disabled="personalBusy || !qrDataUrl" @click="qrStep">我已扫码，确认登录</button></div><img v-if="qrDataUrl" class="telegram-qr" :src="qrDataUrl" alt="Telegram 登录二维码" /><p v-if="auth.hint" class="field-hint">{{ auth.hint }}</p></div><div class="auth-card"><strong>手机号登录</strong><small>使用国际格式手机号；验证码通常会发到已登录 Telegram 客户端。</small><label>手机号<input v-model="phone" placeholder="+8613800000000" /></label><button class="primary-button" :disabled="personalBusy" @click="startPhone">发送验证码</button><label v-if="auth.status === 'waiting_code'">验证码<input v-model="code" inputmode="numeric" autocomplete="one-time-code" /><button class="quiet-button" :disabled="personalBusy" @click="submitCode">确认验证码</button></label><label v-if="auth.status === 'waiting_password'">两步验证密码<input v-model="password" type="password" autocomplete="current-password" /><button class="quiet-button" :disabled="personalBusy" @click="submitPassword">确认密码</button></label></div></div>
      <div class="source-toolbar"><div><strong>群组与频道</strong><small>登录后刷新；仅显示群组、超级群和频道，不会把私聊混进来。</small></div><button class="primary-button" :disabled="personalBusy || !auth.connected" @click="refreshDialogs">刷新群组/频道</button><button class="quiet-button" :disabled="personalBusy || !sources.filter(item => item.kind === 'telegram_user' && item.enabled).length" @click="syncPersonal">同步已绑定个人来源</button></div>
      <div v-if="dialogs.length" class="source-picker"><div class="grid-toolbar"><label class="search-box">搜索<input v-model="dialogSearch" placeholder="名称、用户名或类型" /></label><span>已选 {{ selectedPersonalCount }} / {{ dialogs.length }}</span><button class="quiet-button small" @click="selectAllDialogs">全选可见</button><button class="quiet-button small" @click="clearDialogs">清空</button></div><div class="source-choice-list"><label v-for="item in visibleDialogs" :key="item.id" class="source-choice"><input type="checkbox" :checked="selectedDialogs.has(item.id)" @change="selectedDialogs = toggle(selectedDialogs, item.id)" /><span><strong>{{ item.name }}</strong><small>{{ item.sourceType }} · {{ item.username ? '@' + item.username : item.id }} · 最新消息 {{ item.latestMessageId || '-' }}</small></span></label></div><div class="binding-bar"><label>首次绑定<select v-model="initialMode"><option value="from_now">从现在开始（不回拉旧消息）</option><option value="recent">回拉最近消息</option></select></label><div class="tool-checks"><label v-for="tool in tools" :key="tool.id"><input type="checkbox" :checked="personalBindings.includes(tool.id)" @change="personalBindings = toggleTools(personalBindings, tool.id)" />{{ tool.label }}</label></div><button class="primary-button" :disabled="!selectedPersonalCount" @click="bindPersonal">绑定所选 {{ selectedPersonalCount }} 个来源</button></div></div>
      <div class="sync-range"><label>同步起始时间（可选）<input v-model="syncStart" type="datetime-local" /></label><label>同步结束时间（可选）<input v-model="syncEnd" type="datetime-local" /></label><small>留空为常规增量；选择范围时，仍以每个来源的已同步消息 ID 去重。</small></div>
    </div>

    <div v-else-if="section === 'bot'" class="source-section"><div class="section-heading compact-heading"><div><h3>Bot API</h3><p>只读取机器人加入群组或频道之后收到的消息。若要完整读取自己已加入的频道，请使用个人账号 API。</p></div></div><div class="source-fields"><label>Bot Token<input v-model="botToken" type="password" autocomplete="off" placeholder="123456:ABC…" /></label><div class="action-row"><button class="primary-button" :disabled="botBusy || !botToken.trim()" @click="discoverBot">发现群组/频道</button><button class="quiet-button" :disabled="botBusy || !botToken.trim()" @click="syncBot">同步 Bot 更新</button></div></div><div v-if="discovered.length" class="source-picker"><div class="grid-toolbar"><span>已发现 {{ discovered.length }} 个，已选 {{ selectedBotCount }}</span><button class="quiet-button small" @click="selectedBot = new Set(discovered.map(item => item.id))">全选</button><button class="quiet-button small" @click="selectedBot = new Set()">清空</button></div><div class="source-choice-list"><label v-for="item in discovered" :key="item.id" class="source-choice"><input type="checkbox" :checked="selectedBot.has(item.id)" @change="selectedBot = toggle(selectedBot, item.id)" /><span><strong>{{ item.name }}</strong><small>{{ item.sourceType }} · {{ item.username ? '@' + item.username : item.id }}</small></span></label></div><div class="binding-bar"><div class="tool-checks"><label v-for="tool in tools" :key="tool.id"><input type="checkbox" :checked="botBindings.includes(tool.id)" @change="botBindings = toggleTools(botBindings, tool.id)" />{{ tool.label }}</label></div><button class="primary-button" :disabled="!selectedBotCount" @click="bindBot">绑定 Bot 来源</button></div></div></div>

    <div v-else class="source-section"><div class="section-heading compact-heading"><div><h3>手动来源与来源编辑</h3><p>可用于文件夹、导出文件或修正任何已有来源的名称、工具绑定、检查点与启用状态。</p></div></div><div class="form-grid two"><label>名称<input v-model="editing.name" placeholder="来源名称" /></label><label>外部 ID / 路径<input v-model="editing.externalId" placeholder="可选唯一标识" /></label><label>类型<select v-model="editing.sourceType"><option value="file">文件</option><option value="folder">文件夹</option><option value="group">群组</option><option value="supergroup">超级群</option><option value="channel">频道</option></select></label><label>检查点<input v-model="editing.checkpoint" placeholder="可选，用于增量" /></label><label class="checkbox-line"><input v-model="editing.enabled" type="checkbox" />启用来源</label></div><div class="tool-checks"><label v-for="tool in tools" :key="tool.id"><input type="checkbox" :checked="editing.boundTools.includes(tool.id)" @change="toggleManualTool(tool.id)" />{{ tool.label }}</label></div><div class="action-row"><button class="primary-button" @click="saveManual">保存来源</button><button class="quiet-button" @click="resetManual">新建空白来源</button></div></div>
  </section>

  <section class="panel"><div class="section-heading compact-heading"><div><h3>已保存来源</h3><p>来源删除不会影响已经生成的处理历史或永久数据。退出的群组/频道可直接在这里删除。</p></div></div><div class="grid-toolbar"><label class="search-box">搜索<input v-model="search" placeholder="名称、ID、类型或绑定工具" /></label><span>{{ visibleSources.length }} 项</span><button class="quiet-button small" @click="refreshSources">刷新</button></div><div class="saved-source-list"><article v-for="item in visibleSources" :key="item.id" class="saved-source"><div><strong>{{ item.name }}</strong><small>{{ item.kind }} · {{ item.sourceType }} · {{ item.externalId || '无外部 ID' }} · {{ item.enabled ? '已启用' : '已停用' }}</small><small>绑定：{{ item.boundTools.length ? item.boundTools.join('、') : '未绑定' }} · 检查点：{{ item.checkpoint || '-' }}</small></div><div class="action-row"><button class="quiet-button small" @click="edit(item)">编辑</button><button class="danger-button small" @click="remove(item)">删除</button></div></article><div v-if="!visibleSources.length" class="empty-state">暂无保存来源。</div></div></section>
</template>
