<script setup lang="ts">
import { onMounted, ref } from "vue";
import { createDatabaseBackup, getAppSetting, listDatabaseBackups, openMissavBlacklistFolder, readInputFiles, relocateDatabase, resetDatabaseLocation, restoreDatabaseBackup, setAppSetting } from "../api";
import { open } from "@tauri-apps/plugin-dialog";
import type { BackupInfo } from "../types";
import { defaultMissavScriptTemplate, hashTemplate, MISSAV_SCRIPT_TEMPLATE_SETTING, validateMissavScriptTemplate } from "../missavScript";
import {
  applyReferenceTagBlacklist, defaultMissavReferenceTagLibrary, extractReferenceActressTagsFromHtml,
  MISSAV_REFERENCE_TAGS_SETTING,
  normalizeMissavReferenceTagLibrary, referenceTagBlacklistFromText, referenceTagBlacklistToText,
  referenceTagsFromText, referenceTagsToText, type MissavReferenceTagLibrary,
} from "../missavReferenceTags";
import { loadMissavBlacklistFileValues, saveMissavBlacklistFileText } from "../missavBlacklistFiles";

interface Settings { proxyEnabled: boolean; proxyUrl: string; av123Concurrency: number; av123Rps: number; autoBackup: boolean }
const settings = ref<Settings>({ proxyEnabled: false, proxyUrl: "http://127.0.0.1:7890", av123Concurrency: 16, av123Rps: 4, autoBackup: true });
const backups = ref<BackupInfo[]>([]);
const notice = ref("");
const error = ref("");
const templateVersion = ref("");
const templateCharacters = ref(0);
const referenceLibrary = ref<MissavReferenceTagLibrary>(defaultMissavReferenceTagLibrary());
const referenceLibraryRaw = ref<MissavReferenceTagLibrary>(defaultMissavReferenceTagLibrary());
const referenceEditor = ref("");
const referenceBlacklist = ref<string[]>([]);
const referenceBlacklistEditor = ref("");
const raindropExportBlacklist = ref<string[]>([]);
const raindropExportBlacklistEditor = ref("");
const blacklistDirectory = ref("");
const referenceBlacklistPath = ref("");
const raindropExportBlacklistPath = ref("");
async function load() {
  settings.value = { ...settings.value, ...(await getAppSetting<Partial<Settings>>("runtime")) };
  backups.value = await listDatabaseBackups();
  const template = await getAppSetting<string>(MISSAV_SCRIPT_TEMPLATE_SETTING) || defaultMissavScriptTemplate();
  templateVersion.value = hashTemplate(template); templateCharacters.value = template.length;
  const blacklistFiles = await loadMissavBlacklistFileValues();
  referenceBlacklist.value = blacklistFiles.reference;
  raindropExportBlacklist.value = blacklistFiles.raindropExport;
  blacklistDirectory.value = blacklistFiles.snapshot.directory;
  referenceBlacklistPath.value = blacklistFiles.snapshot.referencePath;
  raindropExportBlacklistPath.value = blacklistFiles.snapshot.raindropExportPath;
  const library = normalizeMissavReferenceTagLibrary(await getAppSetting<unknown>(MISSAV_REFERENCE_TAGS_SETTING));
  referenceLibraryRaw.value = library;
  referenceLibrary.value = { ...library, tags: applyReferenceTagBlacklist(library.tags, referenceBlacklist.value) };
  referenceEditor.value = referenceTagsToText(referenceLibraryRaw.value.tags);
  referenceBlacklistEditor.value = referenceTagBlacklistToText(referenceBlacklist.value);
  raindropExportBlacklistEditor.value = referenceTagBlacklistToText(raindropExportBlacklist.value);
}
async function saveSettings() { try { await setAppSetting("runtime", settings.value); notice.value = "设置已保存。MissAV 已改为浏览器脚本，不再使用 APP 查询速率；123AV 查询配置保持独立。"; } catch (reason) { error.value = String(reason); } }
async function backup() { try { await createDatabaseBackup("manual"); await load(); notice.value = "完整数据库备份已创建。"; } catch (reason) { error.value = String(reason); } }
async function restore(item: BackupInfo) { if (!confirm(`恢复 ${item.name}？当前数据库会先自动备份，恢复后建议重启应用。`)) return; try { await restoreDatabaseBackup(item.path); notice.value = "备份已恢复，请重启应用以确保所有页面刷新。"; } catch (reason) { error.value = String(reason); } }
async function moveDatabase() { const directory = await open({ directory: true, multiple: false, title: "选择新的数据库目录（可选项目文件夹内的 data 目录）" }); if (typeof directory !== "string") return; try { const target = await relocateDatabase(directory); notice.value = `数据库已完整复制到 ${target}。重启应用后正式切换；旧数据库和自动备份仍保留。`; } catch (reason) { error.value = String(reason); } }
async function useDefaultLocation() { if (!confirm("下次启动改回 Windows 应用数据目录？当前自定义数据库不会删除。")) return; await resetDatabaseLocation(); notice.value = "已设置下次启动使用默认目录；当前自定义数据库不会删除。"; }
async function importScriptTemplate() { const selected = await open({ multiple: false, directory: false, title: "导入 MissAV 浏览器脚本模板", filters: [{ name: "JavaScript / 文本", extensions: ["js", "txt"] }] }); if (typeof selected !== "string") return; try { const [file] = await readInputFiles([selected]); if (!file || file.error) throw new Error(file?.error || "模板文件读取失败"); const template = validateMissavScriptTemplate(file.text); await setAppSetting(MISSAV_SCRIPT_TEMPLATE_SETTING, template); await load(); notice.value = `模板已导入：${templateVersion.value}`; } catch (reason) { error.value = String(reason); } }
async function restoreScriptTemplate() { if (!confirm("恢复为本次你提供的完整 MissAV 浏览器脚本模板？")) return; const template = defaultMissavScriptTemplate(); await setAppSetting(MISSAV_SCRIPT_TEMPLATE_SETTING, template); await load(); notice.value = `默认模板已恢复：${templateVersion.value}`; }
async function importReferenceHtml() {
  const selected = await open({ multiple: false, directory: false, title: "选择新的参考女优 Tag 书签 HTML", filters: [{ name: "Raindrop / 浏览器书签 HTML", extensions: ["html", "htm"] }] });
  if (typeof selected !== "string") return;
  error.value = ""; notice.value = "";
  try {
    const [file] = await readInputFiles([selected]);
    if (!file || file.error) throw new Error(file?.error || "参考 HTML 读取失败");
    const known = [...defaultMissavReferenceTagLibrary().tags, ...referenceLibraryRaw.value.tags];
    const extracted = extractReferenceActressTagsFromHtml(file.text, known);
    const activeTags = applyReferenceTagBlacklist(extracted.tags, referenceBlacklist.value);
    const blacklistedCount = extracted.tags.length - activeTags.length;
    if (!activeTags.length) throw new Error("当前参考库黑名单会排除新 HTML 中的全部女优 Tag，请先调整黑名单。");
    if (!confirm(`从 ${file.name} 识别出 ${extracted.tags.length.toLocaleString()} 个完整女优 Tag（其中 ${blacklistedCount.toLocaleString()} 个当前被参考库黑名单停用，源书签 ${extracted.bookmarkCount.toLocaleString()} 条）。确定替换当前 ${referenceLibraryRaw.value.tags.length.toLocaleString()} 个完整参考 Tag 吗？`)) return;
    await setAppSetting(MISSAV_REFERENCE_TAGS_SETTING, { tags: extracted.tags, sourceName: file.name, updatedAt: new Date().toISOString(), bookmarkCount: extracted.bookmarkCount });
    await load();
    notice.value = `参考库已替换：${referenceLibrary.value.tags.length.toLocaleString()} 个女优 Tag；脚本下次生成时自动使用。`;
  } catch (reason) { error.value = String(reason); }
}
async function saveReferenceEditor() {
  error.value = ""; notice.value = "";
  try {
    const rawTags = referenceTagsFromText(referenceEditor.value);
    const activeTags = applyReferenceTagBlacklist(rawTags, referenceBlacklist.value);
    if (!rawTags.length) throw new Error("参考女优 Tag 不能为空。请每行填写一个 Tag，或恢复内置参考库。");
    if (!activeTags.length) throw new Error("当前参考库黑名单会停用全部参考女优 Tag，已拒绝保存。");
    const excluded = rawTags.length - activeTags.length;
    if (!confirm(`保存当前编辑的 ${rawTags.length.toLocaleString()} 个完整参考女优 Tag？其中 ${excluded.toLocaleString()} 个由参考库黑名单暂时停用。`)) return;
    await setAppSetting(MISSAV_REFERENCE_TAGS_SETTING, { tags: rawTags, sourceName: "手动编辑", updatedAt: new Date().toISOString(), bookmarkCount: 0 });
    await load(); notice.value = `已保存 ${referenceLibraryRaw.value.tags.length.toLocaleString()} 个完整参考女优 Tag；当前启用 ${referenceLibrary.value.tags.length.toLocaleString()} 个。`;
  } catch (reason) { error.value = String(reason); }
}
async function restoreReferenceLibrary() {
  if (!confirm("恢复为从你提供的 Miss_AV.html 提取出的内置参考女优 Tag？")) return;
  const fallback = defaultMissavReferenceTagLibrary();
  const activeTags = applyReferenceTagBlacklist(fallback.tags, referenceBlacklist.value);
  if (!activeTags.length) { error.value = "当前黑名单会排除全部内置参考 Tag，请先调整黑名单。"; return; }
  await setAppSetting(MISSAV_REFERENCE_TAGS_SETTING, fallback);
  await load(); notice.value = `已恢复内置参考库：${referenceLibrary.value.tags.length.toLocaleString()} 个女优 Tag。`;
}
async function saveReferenceBlacklist() {
  error.value = ""; notice.value = "";
  try {
    const blacklist = referenceTagBlacklistFromText(referenceBlacklistEditor.value);
    const tags = applyReferenceTagBlacklist(referenceLibraryRaw.value.tags, blacklist);
    if (!tags.length) throw new Error("黑名单会排除全部参考女优 Tag，已拒绝保存。");
    const removed = referenceLibraryRaw.value.tags.length - tags.length;
    if (!confirm(`保存 ${blacklist.length.toLocaleString()} 个参考库黑名单 Tag？将立即从当前参考库排除 ${removed.toLocaleString()} 个，但不会阻止影片进入 Raindrop。`)) return;
    await saveMissavBlacklistFileText("reference", referenceBlacklistEditor.value);
    await load(); notice.value = `参考库黑名单已保存：${referenceBlacklist.value.length.toLocaleString()} 个；当前有效参考库 ${referenceLibrary.value.tags.length.toLocaleString()} 个。`;
  } catch (reason) { error.value = String(reason); }
}
async function saveRaindropExportBlacklist() {
  error.value = ""; notice.value = "";
  try {
    const blacklist = referenceTagBlacklistFromText(raindropExportBlacklistEditor.value);
    if (!confirm(`保存 ${blacklist.length.toLocaleString()} 个 Raindrop 导出黑名单 Tag？脚本命中这些人物的记录将不会进入导入 HTML/CSV。`)) return;
    await saveMissavBlacklistFileText("raindrop_export", raindropExportBlacklistEditor.value);
    await load(); notice.value = `Raindrop 导出黑名单已保存：${raindropExportBlacklist.value.length.toLocaleString()} 个。`;
  } catch (reason) { error.value = String(reason); }
}
async function refreshBlacklistFiles() {
  error.value = ""; notice.value = "";
  try { await load(); notice.value = `已重新读取两个 TXT：参考库黑名单 ${referenceBlacklist.value.length.toLocaleString()} 个，Raindrop 导出黑名单 ${raindropExportBlacklist.value.length.toLocaleString()} 个。`; }
  catch (reason) { error.value = String(reason); }
}
async function openBlacklistDirectory() {
  try { await openMissavBlacklistFolder(); }
  catch (reason) { error.value = String(reason); }
}
onMounted(load);
</script>
<template>
  <section class="page-intro compact"><div><span class="section-kicker">集中配置</span><h2>设置、代理与备份</h2><p>代理不再藏在登录表单；MissAV 使用可维护的浏览器脚本模板，123AV 保留独立查询配置。</p></div></section>
  <div v-if="error" class="notice danger">{{ error }}</div><div v-if="notice" class="notice info">{{ notice }}</div>
  <section class="settings-grid">
    <article class="panel"><h3>网络代理</h3><label class="check-label"><input v-model="settings.proxyEnabled" type="checkbox" /> 启用 HTTP 代理</label><label class="stack-field">Clash 代理地址<input v-model="settings.proxyUrl" placeholder="http://127.0.0.1:7890" /></label><p class="muted">Clash 通常填写 Mixed Port；默认是 7890。代理只用于应用网络请求，不会修改 Windows 全局代理。</p></article>
    <article class="panel"><h3>MissAV 浏览器脚本模板</h3><p class="muted">APP 只负责把过滤好的番号写入模板，不再访问 MissAV。模板正文不会出现在日志中。</p><div class="script-template-meta"><strong>{{ templateVersion || '-' }}</strong><span>{{ templateCharacters.toLocaleString() }} 字符</span></div><div class="action-row"><button class="quiet-button" @click="importScriptTemplate">导入新版模板</button><button class="quiet-button" @click="restoreScriptTemplate">恢复默认模板</button></div></article>
    <article class="panel reference-tag-panel"><h3>参考女优 Tag 库与两层黑名单</h3><p class="muted">两层均按完整 Tag 精确匹配，但作用不同：参考库黑名单只临时取消参考命中，不删除完整参考库；Raindrop 导出黑名单会把整条影片从导入文件排除。两个 TXT 是主数据源，APP 每次生成脚本前都会重新读取。</p><div class="blacklist-file-source"><div><strong>TXT 目录</strong><code>{{ blacklistDirectory || '-' }}</code></div><div class="action-row"><button class="quiet-button" @click="refreshBlacklistFiles">重新读取 TXT</button><button class="quiet-button" @click="openBlacklistDirectory">打开文件夹</button></div><small>参考库黑名单：{{ referenceBlacklistPath || '-' }}</small><small>Raindrop 导出黑名单：{{ raindropExportBlacklistPath || '-' }}</small></div><div class="script-template-meta"><strong>{{ referenceLibrary.tags.length.toLocaleString() }} 个有效参考</strong><span>{{ referenceLibraryRaw.tags.length.toLocaleString() }} 个完整参考</span><span>{{ referenceBlacklist.length.toLocaleString() }} 个参考库黑名单</span><span>{{ raindropExportBlacklist.length.toLocaleString() }} 个导出黑名单</span><span>{{ referenceLibrary.sourceName }}</span></div><div class="reference-library-grid"><div><label class="stack-field">完整参考女优 Tag 库（每行一个，黑名单人物仍保留在这里）<textarea v-model="referenceEditor" class="reference-tag-editor" rows="12" spellcheck="false"></textarea></label><div class="action-row"><button class="primary-button" @click="importReferenceHtml">从 HTML 替换参考库</button><button class="quiet-button" @click="saveReferenceEditor">保存参考库修改</button><button class="quiet-button" @click="restoreReferenceLibrary">恢复内置库</button></div></div><div class="blacklist-stack"><div><label class="stack-field">第一层：参考库黑名单<textarea v-model="referenceBlacklistEditor" class="reference-tag-editor blacklist-editor" rows="8" spellcheck="false" placeholder="这些人物不再算参考女优，但影片仍可进入“其他”"></textarea></label><div class="action-row"><button class="quiet-button" @click="saveReferenceBlacklist">保存并写入参考库黑名单 TXT</button></div></div><div><label class="stack-field">第二层：Raindrop 导出黑名单<textarea v-model="raindropExportBlacklistEditor" class="reference-tag-editor export-blacklist-editor" rows="8" spellcheck="false" placeholder="这些人物的影片不会进入 Raindrop 导入文件"></textarea></label><div class="action-row"><button class="danger-button" @click="saveRaindropExportBlacklist">保存并写入导出黑名单 TXT</button></div></div></div></div><p class="muted">你可以关闭 APP 后直接编辑 TXT，也可以在 APP 内修改并保存。从第一层 TXT 删除人物后，她会自动恢复参考资格；第二层命中的记录不会写入 Raindrop HTML/CSV，但仍保留在处理报告和 JSON 备份。</p></article>
    <article class="panel"><h3>123AV 速度</h3><div class="form-grid two"><label>查询并发<input v-model.number="settings.av123Concurrency" type="number" min="1" max="32" /></label><label>目标请求/秒<input v-model.number="settings.av123Rps" type="number" min="0.2" max="30" step="0.2" /></label></div><p class="muted">查询采用详情页候选变体，不使用慢搜索页；收藏仍强制同站串行，遇错休息 10 秒续跑。</p></article>
    <article class="panel"><h3>数据库安全与位置</h3><label class="check-label"><input v-model="settings.autoBackup" type="checkbox" /> 删除、批量修改与迁移前自动备份</label><p class="muted">可把数据库复制到项目文件夹下的专用目录。切换只在重启后生效，不删除原数据库。</p><div class="action-row setting-actions"><button class="primary-button" @click="saveSettings">保存全部设置</button><button class="quiet-button" @click="backup">立即备份</button><button class="quiet-button" @click="moveDatabase">更改数据库目录</button><button class="quiet-button" @click="useDefaultLocation">改回默认目录</button></div></article>
  </section>
  <section class="panel backup-panel"><div class="section-heading"><div><span class="section-kicker">可恢复备份</span><h2>数据库备份</h2></div><strong>{{ backups.length }} 份</strong></div><div class="history-list"><article v-for="item in backups" :key="item.path" class="history-row"><div class="history-main"><strong>{{ item.name }}</strong><small>{{ item.modifiedAt }} · {{ (item.bytes / 1024 / 1024).toFixed(1) }} MB</small></div><button class="quiet-button small" @click="restore(item)">恢复</button></article><div v-if="!backups.length" class="empty-state">还没有备份。</div></div></section>
</template>
