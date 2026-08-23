<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { cloudSyncConflicts, cloudSyncDisconnect, cloudSyncHealth, cloudSyncPair, cloudSyncPreview, cloudSyncResolveConflict, cloudSyncRun, cloudSyncStatus } from "../api";
import type { CloudSyncConflict, CloudSyncPreview, CloudSyncStatus } from "../types";

const emptyStatus = (): CloudSyncStatus => ({
  configured: false,
  nodeId: "",
  gatewayUrl: "",
  gatewayReachable: false,
  latestRemoteSequence: 0,
  lastPulledSequence: 0,
  pendingUploads: 0,
  openConflicts: 0,
  lastPushAt: "",
  lastPullAt: "",
  lastSuccessAt: "",
  lastError: "",
});

const state = ref<CloudSyncStatus>(emptyStatus());
const gatewayUrl = ref("");
const pairingCode = ref("");
const deviceLabel = ref("我的 Windows 电脑");
const busy = ref(false);
const notice = ref("");
const error = ref("");
const preview = ref<CloudSyncPreview | null>(null);
const conflicts = ref<CloudSyncConflict[]>([]);

const remotePending = computed(() => Math.max(0, state.value.latestRemoteSequence - state.value.lastPulledSequence));

function timeLabel(value: string) {
  if (!value) return "尚无";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

async function refresh() {
  error.value = "";
  try {
    state.value = await cloudSyncStatus();
    if (!gatewayUrl.value) gatewayUrl.value = state.value.gatewayUrl;
    conflicts.value = state.value.configured && state.value.openConflicts > 0 ? await cloudSyncConflicts() : [];
  } catch (reason) {
    error.value = String(reason);
  }
}

async function testGateway() {
  busy.value = true; error.value = ""; notice.value = "";
  try {
    const result = await cloudSyncHealth(gatewayUrl.value);
    if (!result.reachable) throw new Error(result.error || "同步网关不可达");
    notice.value = `同步网关连接正常，协议版本 v${result.schemaVersion}。`;
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

async function pairDevice() {
  busy.value = true; error.value = ""; notice.value = "";
  try {
    state.value = await cloudSyncPair({ gatewayUrl: gatewayUrl.value, code: pairingCode.value, label: deviceLabel.value });
    pairingCode.value = "";
    notice.value = "设备配对完成。设备 Token 已由 Windows 当前用户加密保存，不会写入数据库、日志或导出文件。";
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

async function disconnect() {
  if (!confirm("断开这台电脑的云同步？本地业务数据与待上传队列不会删除；云端仍需在设备管理中撤销旧设备。")) return;
  busy.value = true; error.value = ""; notice.value = "";
  try {
    state.value = await cloudSyncDisconnect();
    notice.value = "本机设备凭据已删除；本地数据库未改变。";
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

async function generatePreview() {
  busy.value = true; error.value = ""; notice.value = ""; preview.value = null;
  try {
    preview.value = await cloudSyncPreview();
    notice.value = "预览完成：本地 " + preview.value.localCount.toLocaleString() + " 条，云端 " + preview.value.remoteCount.toLocaleString() + " 条。";
    await refresh();
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

async function run(direction: "push" | "pull" | "both") {
  if (!preview.value) return;
  const label = direction === "push" ? "仅 Push（本地→云端）" : direction === "pull" ? "仅 Pull（云端→本地）" : "双向同步";
  if (!confirm("确认执行“" + label + "”？\n\n软件会先自动备份本地数据库。若预览后任一端数据变化，操作会拒绝并要求重新预览。")) return;
  busy.value = true; error.value = ""; notice.value = "";
  try {
    const report = await cloudSyncRun({ direction, previewId: preview.value.previewId });
    preview.value = null;
    await refresh();
    notice.value = "同步完成：上传 " + report.pushed + "，下载 " + report.pulled + "，删除 " + report.deleted + "，新增冲突 " + report.conflicts + "。";
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

async function resolveConflict(conflict: CloudSyncConflict, decision: "accept_remote" | "keep_local") {
  const label = decision === "accept_remote" ? "采用云端版本" : "保留本地版本并重新上传";
  if (!confirm(`确认对“${conflict.entityKey}”执行“${label}”？\n\n软件会先自动备份本地数据库。`)) return;
  busy.value = true; error.value = ""; notice.value = "";
  try {
    await cloudSyncResolveConflict(conflict.id, decision);
    preview.value = null;
    await refresh();
    notice.value = `冲突已处理：${conflict.entityKey}，${label}。再次同步前需要重新生成预览。`;
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

onMounted(refresh);
</script>

<template>
  <section class="page-intro compact">
    <div><span class="section-kicker">统一数据</span><h2>Windows 与 Work 同步中心</h2><p>本地 SQLite 和云端 D1 各自运行，通过独立网关同步重要业务数据。Telegram Session、Token、API Hash、密码与本地路径永不参与同步。</p></div>
    <span class="state-chip" :class="state.configured ? 'ready' : 'disconnected'">{{ state.configured ? "已配对" : "未配对" }}</span>
  </section>

  <div v-if="error" class="notice danger">{{ error }}</div>
  <div v-if="notice" class="notice info">{{ notice }}</div>

  <section class="sync-metric-grid">
    <article><strong>{{ state.pendingUploads.toLocaleString() }}</strong><span>待上传</span></article>
    <article><strong>{{ remotePending.toLocaleString() }}</strong><span>待下载</span></article>
    <article><strong>{{ state.openConflicts.toLocaleString() }}</strong><span>待处理冲突</span></article>
    <article><strong>{{ timeLabel(state.lastSuccessAt) }}</strong><span>最近成功</span></article>
  </section>

  <section v-if="!state.configured" class="panel sync-step">
    <div class="section-heading compact-heading"><div><span class="section-kicker">01 设备配对</span><h3>用网页端一次性配对码连接</h3><p>先在私人网站“同步中心”生成 10 分钟有效的配对码。本页不需要、也不接受任何网站或 Telegram 密钥。</p></div></div>
    <div class="sync-pair-grid">
      <label>同步网关地址<input v-model.trim="gatewayUrl" autocomplete="url" placeholder="https://你的同步网关.workers.dev" /></label>
      <label>设备名称<input v-model.trim="deviceLabel" maxlength="120" placeholder="我的 Windows 电脑" /></label>
      <label>一次性配对码<input v-model.trim="pairingCode" maxlength="12" autocomplete="one-time-code" placeholder="ABCDE23456" /></label>
    </div>
    <div class="action-row"><button class="quiet-button" :disabled="busy || !gatewayUrl" @click="testGateway">测试连接</button><button class="primary-button" :disabled="busy || !gatewayUrl || !pairingCode" @click="pairDevice">配对这台电脑</button></div>
  </section>

  <template v-else>
    <section class="panel sync-step">
      <div class="section-heading compact-heading"><div><span class="section-kicker">01 当前节点</span><h3>{{ state.nodeId }}</h3><p class="path-text" :title="state.gatewayUrl">{{ state.gatewayUrl }}</p></div><button class="danger-button small" :disabled="busy" @click="disconnect">断开本机</button></div>
      <div class="sync-detail-grid"><span>最后 Push：<strong>{{ timeLabel(state.lastPushAt) }}</strong></span><span>最后 Pull：<strong>{{ timeLabel(state.lastPullAt) }}</strong></span><span>远端序列：<strong>{{ state.latestRemoteSequence }}</strong></span><span>本地游标：<strong>{{ state.lastPulledSequence }}</strong></span></div>
    </section>

    <section class="panel sync-step">
      <div class="section-heading compact-heading"><div><span class="section-kicker">02 首次同步</span><h3>先比较，再决定方向</h3><p>正式数据第一次汇合必须先生成本地/云端数量、重复、差异和冲突预览。预览不会写入任何业务表。</p></div></div>
      <div class="action-row"><button class="primary-button" :disabled="busy" @click="generatePreview">生成差异预览</button></div>
      <div v-if="preview" class="sync-preview-summary">
        <span><strong>{{ preview.localCount }}</strong> 本地</span><span><strong>{{ preview.remoteCount }}</strong> 云端</span><span><strong>{{ preview.sameCount }}</strong> 相同</span><span><strong>{{ preview.localOnlyCount }}</strong> 仅本地</span><span><strong>{{ preview.remoteOnlyCount }}</strong> 仅云端</span><span><strong>{{ preview.differentCount }}</strong> 内容不同</span>
        <p v-for="warning in preview.warnings" :key="warning">{{ warning }}</p>
      </div>
    </section>

    <section class="panel sync-step" :class="{ 'sync-disabled-actions': !preview }">
      <div class="section-heading compact-heading"><div><span class="section-kicker">03 日常操作</span><h3>Push、Pull 与双向同步</h3><p>完成首次差异预览后开放。每批最多 200 条；断网可续传，删除使用墓碑，冲突不会静默覆盖。</p></div></div>
      <div class="action-row"><button :disabled="busy || !preview" @click="run('push')">仅 Push</button><button :disabled="busy || !preview" @click="run('pull')">仅 Pull</button><button class="primary-button" :disabled="busy || !preview" @click="run('both')">双向同步</button></div>
    </section>

    <section class="panel sync-step">
      <div class="section-heading compact-heading"><div><span class="section-kicker">04 冲突处理</span><h3>逐条决定数据方向</h3><p>同一条数据在两端同时变化时不会自动覆盖。采用云端会更新本地；保留本地会按云端最新版本重新排队上传。</p></div><button class="quiet-button small" :disabled="busy" @click="refresh">刷新</button></div>
      <div v-if="!conflicts.length" class="empty-state compact-empty">当前没有待处理冲突。</div>
      <div v-else class="sync-conflict-list">
        <article v-for="conflict in conflicts" :key="conflict.id" class="sync-conflict-item">
          <div><strong>{{ conflict.entityKey }}</strong><span>{{ conflict.entityType }} · {{ conflict.reason }} · {{ timeLabel(conflict.createdAt) }}</span></div>
          <div class="action-row compact-actions"><button :disabled="busy" @click="resolveConflict(conflict, 'accept_remote')">采用云端</button><button class="primary-button" :disabled="busy" @click="resolveConflict(conflict, 'keep_local')">保留本地</button></div>
        </article>
      </div>
    </section>
  </template>

  <section class="notice warning"><strong>安全边界：</strong>每次正式同步都要求 30 分钟内的有效预览并自动备份本地数据库；空云端或空本地库不会在无确认时覆盖另一端。Telegram Bot、个人账号增量、历史回拉与标已读均使用远端执行租约，避免本地和网页同时推进同一来源。</section>
</template>
