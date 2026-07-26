<script setup lang="ts">
import { computed, ref } from "vue";
import { callRaindrop, createContentRun, getAppSetting, queryPermanentRecords } from "../api";
import { legacyInput } from "../legacyCore";
import type { PermanentRecord, ResultInput } from "../types";

interface Collection { id: number; title: string; parentId: number }
interface RemoteBookmark { id: number; title: string; link: string; tags: string[]; collectionId: number; code: string }
type ActionKind = "pull_new" | "pull_update" | "push_create" | "push_update" | "no_change" | "invalid";
interface SyncAction { kind: ActionKind; code: string; local?: PermanentRecord; remote?: RemoteBookmark; tags: string[]; reason: string }

const token = ref("");
const accountName = ref("");
const collections = ref<Collection[]>([]);
const selectedCollections = ref(new Set<number>());
const targetCollection = ref<number>(-1);
const mode = ref<"pull" | "push" | "both">("both");
const autoRoute = ref(false);
const knownCollection = ref<number>(-1);
const unknownCollection = ref<number>(-1);
const actions = ref<SyncAction[]>([]);
const busy = ref(false);
const progress = ref("");
const error = ref("");
const filter = ref<ActionKind | "all">("all");

const visibleActions = computed(() => filter.value === "all" ? actions.value : actions.value.filter((item) => item.kind === filter.value));
const counts = computed(() => Object.fromEntries(["pull_new", "pull_update", "push_create", "push_update", "no_change", "invalid"].map((key) => [key, actions.value.filter((item) => item.kind === key).length])) as Record<ActionKind, number>);

function parseBody(response: Awaited<ReturnType<typeof callRaindrop>>) {
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(response.body) as Record<string, unknown>; } catch { /* surfaced below */ }
  if (response.statusCode < 200 || response.statusCode >= 300 || body.result === false) {
    throw new Error(`Raindrop HTTP ${response.statusCode}：${String(body.errorMessage || body.error || "请求失败")}`);
  }
  return body;
}

async function request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: Record<string, unknown>) {
  const settings = await getAppSetting<{ proxyEnabled?: boolean; proxyUrl?: string }>("runtime");
  const response = await callRaindrop(method, path, token.value, body, settings?.proxyEnabled ? settings.proxyUrl || "" : "");
  return parseBody(response);
}

async function connect() {
  busy.value = true; error.value = "";
  try {
    const user = await request("GET", "/rest/v1/user");
    const profile = user.user as Record<string, unknown> | undefined;
    accountName.value = String(profile?.fullName || profile?.email || "已连接");
    const [root, children] = await Promise.all([request("GET", "/rest/v1/collections"), request("GET", "/rest/v1/collections/childrens")]);
    const rows = [...((root.items as unknown[]) || []), ...((children.items as unknown[]) || [])] as Array<Record<string, unknown>>;
    collections.value = rows.map((item) => ({
      id: Number(item.$id), title: String(item.title || "未命名"),
      parentId: Number((item.parent as Record<string, unknown> | undefined)?.$id || 0),
    })).filter((item) => Number.isSafeInteger(item.id));
    if (!selectedCollections.value.size && collections.value.length) selectedCollections.value = new Set([collections.value[0].id]);
    if (!collections.value.some((item) => item.id === targetCollection.value)) targetCollection.value = collections.value[0]?.id ?? -1;
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

function toggleCollection(id: number) {
  const next = new Set(selectedCollections.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  selectedCollections.value = next;
}

async function loadRemoteAll(): Promise<RemoteBookmark[]> {
  const output: RemoteBookmark[] = [];
  for (let page = 0; page < 200; page += 1) {
    progress.value = `读取 Raindrop 全局索引：第 ${page + 1} 页，已取 ${output.length} 条`;
    const body = await request("GET", `/rest/v1/raindrops/0?page=${page}&perpage=50&sort=-created`);
    const items = (body.items as Array<Record<string, unknown>> | undefined) || [];
    for (const item of items) {
      const link = String(item.link || "");
      const title = String(item.title || "");
      const entry = legacyInput.parseInputEntries(`${title}\n${link}`)[0];
      output.push({
        id: Number(item._id), title, link, tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        collectionId: Number((item.collection as Record<string, unknown> | undefined)?.$id ?? -1),
        code: entry?.code || "",
      });
    }
    if (items.length < 50) break;
  }
  return output;
}

async function loadLocalAll(): Promise<PermanentRecord[]> {
  const output: PermanentRecord[] = [];
  for (let page = 1; page <= 1000; page += 1) {
    const result = await queryPermanentRecords("missav", page, 500, "");
    output.push(...result.data);
    if (page >= result.lastPage) break;
  }
  return output;
}

function key(value: string) { return value.toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function mergeTags(...groups: string[][]) { return [...new Set(groups.flat().map((tag) => tag.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN")); }
function sameTags(left: string[], right: string[]) { return JSON.stringify(mergeTags(left)) === JSON.stringify(mergeTags(right)); }

async function preview() {
  if (!accountName.value) { error.value = "请先验证 Raindrop 令牌。"; return; }
  if ((mode.value === "pull" || mode.value === "both") && !selectedCollections.value.size) { error.value = "Pull 或双向同步至少选择一个 Collection。"; return; }
  busy.value = true; error.value = ""; actions.value = [];
  try {
    const [remote, local] = await Promise.all([loadRemoteAll(), loadLocalAll()]);
    const remoteByCode = new Map<string, RemoteBookmark>();
    remote.filter((item) => item.code).forEach((item) => { if (!remoteByCode.has(key(item.code))) remoteByCode.set(key(item.code), item); });
    const localByCode = new Map(local.map((item) => [key(item.primaryValue), item]));
    const next: SyncAction[] = [];

    if (mode.value === "pull" || mode.value === "both") {
      for (const remoteItem of remote.filter((item) => selectedCollections.value.has(item.collectionId))) {
        if (!remoteItem.code) { next.push({ kind: "invalid", code: remoteItem.title || remoteItem.link, remote: remoteItem, tags: remoteItem.tags, reason: "远端书签没有可信 MissAV 番号" }); continue; }
        const localItem = localByCode.get(key(remoteItem.code));
        if (!localItem) next.push({ kind: "pull_new", code: remoteItem.code, remote: remoteItem, tags: remoteItem.tags, reason: "Raindrop 有、本地没有：连同全部 Tag 拉入本地" });
        else if (!sameTags(remoteItem.tags, localItem.tags)) next.push({ kind: "pull_update", code: remoteItem.code, remote: remoteItem, local: localItem, tags: mergeTags(remoteItem.tags, localItem.tags), reason: "两端都有但 Tag 不同：合并后更新本地" });
        else next.push({ kind: "no_change", code: remoteItem.code, remote: remoteItem, local: localItem, tags: localItem.tags, reason: "本地和 Raindrop 已都有该番号且资料一致；Collection 位置不参与判断" });
      }
    }
    if (mode.value === "push" || mode.value === "both") {
      for (const localItem of local) {
        const remoteItem = remoteByCode.get(key(localItem.primaryValue));
        if (!remoteItem) next.push({ kind: "push_create", code: localItem.primaryValue, local: localItem, tags: localItem.tags, reason: "本地有、Raindrop 全账号没有：创建书签" });
        else if (!sameTags(localItem.tags, remoteItem.tags)) {
          const existing = next.find((item) => key(item.code) === key(localItem.primaryValue) && item.kind === "pull_update");
          if (existing && mode.value === "both") existing.reason = "两端都有但 Tag 不同：合并后同时更新本地与 Raindrop";
          else next.push({ kind: "push_update", code: localItem.primaryValue, local: localItem, remote: remoteItem, tags: mergeTags(localItem.tags, remoteItem.tags), reason: "两端都有但 Tag 不同：合并后更新 Raindrop；Collection 位置不参与判断" });
        } else if (!next.some((item) => key(item.code) === key(localItem.primaryValue))) next.push({ kind: "no_change", code: localItem.primaryValue, local: localItem, remote: remoteItem, tags: localItem.tags, reason: "本地和 Raindrop 已都有该番号，无需变化" });
      }
    }
    actions.value = next;
    progress.value = `预览完成：本地 ${local.length} 条，Raindrop 全账号 ${remote.length} 条；只执行明确有差异的项目。`;
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

function targetFor(item: SyncAction) {
  if (!autoRoute.value || !item.local) return targetCollection.value;
  const actresses = Array.isArray(item.local.metadata?.actresses) ? item.local.metadata.actresses : item.local.actressTags;
  return actresses.length ? knownCollection.value : unknownCollection.value;
}

function statusTags(item: SyncAction) {
  const status = item.local?.status || "";
  return mergeTags(item.tags, status === "not_found" ? ["未找到"] : [], status === "network_error" ? ["网络错误"] : []);
}

async function executeSync() {
  const pending = actions.value.filter((item) => item.kind !== "no_change" && item.kind !== "invalid");
  if (!pending.length) { progress.value = "没有需要写入的变化。"; return; }
  if (!confirm(`将执行 ${pending.length} 项同步写入。继续吗？`)) return;
  busy.value = true; error.value = "";
  try {
    const pull = pending.filter((item) => item.kind === "pull_new" || item.kind === "pull_update");
    if (pull.length) {
      const results: ResultInput[] = pull.map((item) => ({
        resultKey: key(item.code).toLowerCase(), primaryValue: item.code,
        secondaryValue: item.remote?.link || `https://missav.ai/cn/${item.code.toLowerCase()}`,
        status: item.local?.status || "pulled", tags: item.tags, source: "Raindrop Pull",
        metadata: { ...(item.local?.metadata || {}), raindropRemoteId: item.remote?.id, raindropCollectionId: item.remote?.collectionId, remoteTitle: item.remote?.title },
      }));
      await createContentRun({ tool: "missav", name: `Raindrop Pull ${new Date().toLocaleString("zh-CN", { hour12: false })}`, inputKind: "raindrop_pull", originalInput: JSON.stringify(pull.map((item) => item.remote), null, 2), options: { collections: [...selectedCollections.value] }, results });
    }
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index]; progress.value = `同步写入 ${index + 1}/${pending.length}：${item.code}`;
      if (item.kind === "push_create") {
        const collectionId = targetFor(item);
        if (!Number.isSafeInteger(collectionId)) throw new Error("Push 目标 Collection 无效");
        await request("POST", "/rest/v1/raindrop", { link: item.local?.secondaryValue || `https://missav.ai/cn/${item.code.toLowerCase()}`, title: item.code, tags: statusTags(item), collection: { $id: collectionId } });
      } else if (item.kind === "push_update" || (item.kind === "pull_update" && mode.value === "both")) {
        if (item.remote?.id) await request("PUT", `/rest/v1/raindrop/${item.remote.id}`, { tags: item.tags });
      }
      await new Promise((resolve) => setTimeout(resolve, 230));
    }
    progress.value = `同步完成：执行 ${pending.length} 项；${counts.value.no_change} 项无需变化。`;
    await preview();
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="notice info"><strong>同步边界：</strong>只处理你选定 Collection 中可识别的 MissAV 数据；判断重复时检索 Raindrop 全账号，同一番号已存在就不会因为文件夹不同而重复创建。Pull 会保留远端全部 Tag。</div>
  <div v-if="error" class="notice danger">{{ error }}</div>
  <section class="panel sync-step"><div class="step-title"><span>01</span><h3>连接账号</h3><strong>{{ accountName || "未连接" }}</strong></div><div class="token-row"><input v-model="token" type="password" autocomplete="off" placeholder="粘贴 Raindrop Test Token / OAuth Access Token（仅本次运行使用）" /><button class="primary-button" :disabled="busy || !token.trim()" @click="connect">验证并读取 Collection</button></div></section>
  <section class="panel sync-step"><div class="step-title"><span>02</span><h3>模式与 Collection</h3><strong>已选 {{ selectedCollections.size }}</strong></div>
    <div class="form-grid sync-options"><label>同步模式<select v-model="mode"><option value="pull">Pull：官网 → 本地</option><option value="push">Push：本地 → 官网</option><option value="both">双向：合并两端</option></select></label><label>Push 默认目标<select v-model.number="targetCollection"><option v-for="item in collections" :key="item.id" :value="item.id">{{ item.title }}</option></select></label></div>
    <div class="collection-picker"><button v-for="item in collections" :key="item.id" :class="['collection-chip', { active: selectedCollections.has(item.id) }]" @click="toggleCollection(item.id)"><strong>{{ item.title }}</strong><small>#{{ item.id }}</small></button><div v-if="!collections.length" class="empty-state">连接账号后显示 Collection。</div></div>
    <label class="check-label"><input v-model="autoRoute" type="checkbox" /> Push 时按女优识别结果自动路由</label>
    <div v-if="autoRoute" class="form-grid two route-selects"><label>有已知女优 →<select v-model.number="knownCollection"><option v-for="item in collections" :key="item.id" :value="item.id">{{ item.title }}</option></select></label><label>全新/无女优 →<select v-model.number="unknownCollection"><option v-for="item in collections" :key="item.id" :value="item.id">{{ item.title }}</option></select></label></div>
  </section>
  <section class="panel sync-step"><div class="step-title"><span>03</span><h3>预览并执行</h3><strong>{{ actions.length }} 项</strong></div><div class="action-row"><button class="quiet-button" :disabled="busy || !accountName" @click="preview">{{ busy ? "处理中…" : "生成全局差异预览" }}</button><button class="primary-button" :disabled="busy || !actions.length" @click="executeSync">确认执行同步</button><select v-model="filter" class="compact-select"><option value="all">全部</option><option value="pull_new">Pull 新建</option><option value="pull_update">Pull 更新</option><option value="push_create">Push 新建</option><option value="push_update">Push 更新</option><option value="no_change">无需变化</option><option value="invalid">异常</option></select></div><p class="status-line">{{ progress || "尚未生成预览。预览阶段不会写入任何一端。" }}</p>
    <div class="sync-counts"><button v-for="kind in (['pull_new','pull_update','push_create','push_update','no_change','invalid'] as ActionKind[])" :key="kind" @click="filter = kind"><strong>{{ counts[kind] || 0 }}</strong><span>{{ { pull_new:'Pull 新建',pull_update:'Pull 更新',push_create:'Push 新建',push_update:'Push 更新',no_change:'无需变化',invalid:'异常' }[kind] }}</span></button></div>
    <div class="sync-preview"><table class="editable-table"><thead><tr><th>动作</th><th>番号</th><th>Tag</th><th>原因</th><th>远端 Collection</th></tr></thead><tbody><tr v-for="(item, index) in visibleActions" :key="`${item.kind}-${item.code}-${index}`"><td>{{ item.kind }}</td><td><strong>{{ item.code }}</strong></td><td>{{ item.tags.join(', ') || '-' }}</td><td>{{ item.reason }}</td><td>{{ item.remote?.collectionId ?? '-' }}</td></tr></tbody></table></div>
  </section>
</template>
