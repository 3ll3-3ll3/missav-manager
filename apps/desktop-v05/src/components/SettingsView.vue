<script setup lang="ts">
import { onMounted, ref } from "vue";
import { createDatabaseBackup, getAppSetting, listDatabaseBackups, relocateDatabase, resetDatabaseLocation, restoreDatabaseBackup, setAppSetting } from "../api";
import { open } from "@tauri-apps/plugin-dialog";
import type { BackupInfo } from "../types";

interface Settings { proxyEnabled: boolean; proxyUrl: string; missavConcurrency: number; missavRps: number; av123Concurrency: number; av123Rps: number; autoBackup: boolean }
const settings = ref<Settings>({ proxyEnabled: false, proxyUrl: "http://127.0.0.1:7890", missavConcurrency: 16, missavRps: 12, av123Concurrency: 16, av123Rps: 4, autoBackup: true });
const backups = ref<BackupInfo[]>([]);
const notice = ref("");
const error = ref("");
async function load() { settings.value = { ...settings.value, ...(await getAppSetting<Partial<Settings>>("runtime")) }; backups.value = await listDatabaseBackups(); }
async function saveSettings() { try { await setAppSetting("runtime", settings.value); notice.value = "设置已保存。MissAV 和 123AV 使用完全独立的并发与速率配置。"; } catch (reason) { error.value = String(reason); } }
async function backup() { try { await createDatabaseBackup("manual"); await load(); notice.value = "完整数据库备份已创建。"; } catch (reason) { error.value = String(reason); } }
async function restore(item: BackupInfo) { if (!confirm(`恢复 ${item.name}？当前数据库会先自动备份，恢复后建议重启应用。`)) return; try { await restoreDatabaseBackup(item.path); notice.value = "备份已恢复，请重启应用以确保所有页面刷新。"; } catch (reason) { error.value = String(reason); } }
async function moveDatabase() { const directory = await open({ directory: true, multiple: false, title: "选择新的数据库目录（可选项目文件夹内的 data 目录）" }); if (typeof directory !== "string") return; try { const target = await relocateDatabase(directory); notice.value = `数据库已完整复制到 ${target}。重启应用后正式切换；旧数据库和自动备份仍保留。`; } catch (reason) { error.value = String(reason); } }
async function useDefaultLocation() { if (!confirm("下次启动改回 Windows 应用数据目录？当前自定义数据库不会删除。")) return; await resetDatabaseLocation(); notice.value = "已设置下次启动使用默认目录；当前自定义数据库不会删除。"; }
onMounted(load);
</script>
<template>
  <section class="page-intro compact"><div><span class="section-kicker">集中配置</span><h2>设置、代理与备份</h2><p>代理不再藏在登录表单；两个网站的速度配置完全分开，同一网站内部受控，不同网站之间可并行。</p></div></section>
  <div v-if="error" class="notice danger">{{ error }}</div><div v-if="notice" class="notice info">{{ notice }}</div>
  <section class="settings-grid">
    <article class="panel"><h3>网络代理</h3><label class="check-label"><input v-model="settings.proxyEnabled" type="checkbox" /> 启用 HTTP 代理</label><label class="stack-field">Clash 代理地址<input v-model="settings.proxyUrl" placeholder="http://127.0.0.1:7890" /></label><p class="muted">Clash 通常填写 Mixed Port；默认是 7890。代理只用于应用网络请求，不会修改 Windows 全局代理。</p></article>
    <article class="panel"><h3>MissAV 速度</h3><div class="form-grid two"><label>并发<input v-model.number="settings.missavConcurrency" type="number" min="1" max="32" /></label><label>目标请求/秒<input v-model.number="settings.missavRps" type="number" min="0.2" max="50" step="0.2" /></label></div><p class="muted">网络错误自动重试，异常项在正常队列结束后分层收尾。</p></article>
    <article class="panel"><h3>123AV 速度</h3><div class="form-grid two"><label>查询并发<input v-model.number="settings.av123Concurrency" type="number" min="1" max="32" /></label><label>目标请求/秒<input v-model.number="settings.av123Rps" type="number" min="0.2" max="30" step="0.2" /></label></div><p class="muted">查询采用详情页候选变体，不使用慢搜索页；收藏仍强制同站串行，遇错休息 10 秒续跑。</p></article>
    <article class="panel"><h3>数据库安全与位置</h3><label class="check-label"><input v-model="settings.autoBackup" type="checkbox" /> 删除、批量修改与迁移前自动备份</label><p class="muted">可把数据库复制到项目文件夹下的专用目录。切换只在重启后生效，不删除原数据库。</p><div class="action-row setting-actions"><button class="primary-button" @click="saveSettings">保存全部设置</button><button class="quiet-button" @click="backup">立即备份</button><button class="quiet-button" @click="moveDatabase">更改数据库目录</button><button class="quiet-button" @click="useDefaultLocation">改回默认目录</button></div></article>
  </section>
  <section class="panel backup-panel"><div class="section-heading"><div><span class="section-kicker">可恢复备份</span><h2>数据库备份</h2></div><strong>{{ backups.length }} 份</strong></div><div class="history-list"><article v-for="item in backups" :key="item.path" class="history-row"><div class="history-main"><strong>{{ item.name }}</strong><small>{{ item.modifiedAt }} · {{ (item.bytes / 1024 / 1024).toFixed(1) }} MB</small></div><button class="quiet-button small" @click="restore(item)">恢复</button></article><div v-if="!backups.length" class="empty-state">还没有备份。</div></div></section>
</template>
