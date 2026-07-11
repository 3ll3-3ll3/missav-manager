const { contextBridge, ipcRenderer, app } = require('electron');
const path = require('path');

// ─── 加载核心模块 ────────────────────────────────────
const parser = require('./src/parser');
const fetcher = require('./src/fetcher');
const exporter = require('./src/exporter');
const utils = require('./src/utils');
const database = require('./src/database');
const csvTools = require('./src/csvTools');

// ─── 数据库初始化 ────────────────────────────────────
let dbReady = false;
let dbInitError = '';

// 数据库存放在项目目录下的 data 文件夹
const dbDir = path.join(__dirname, 'data');

(async () => {
  try {
    // 确保 data 目录存在
    const fs = require('fs');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    await database.init(dbDir);
    dbReady = true;
    console.log('[Preload] Database initialized successfully at', dbDir);
  } catch (err) {
    dbInitError = err.message;
    console.error('[Preload] Database init failed:', err.message);
  }
})();

// ─── 暴露给渲染进程的安全 API ─────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {
  // ── File Dialogs ──
  openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
  openDirectory: (options) => ipcRenderer.invoke('dialog:openDirectory', options),

  // ── File System ──
  readFile: (filePath, encoding) => ipcRenderer.invoke('fs:readFile', filePath, encoding),
  writeFile: (filePath, content, encoding) => ipcRenderer.invoke('fs:writeFile', filePath, content, encoding),
  createDirectory: (dirPath) => ipcRenderer.invoke('fs:createDirectory', dirPath),
  fileExists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),

  // ── Network ──
  fetchPage: (url, options) => ipcRenderer.invoke('net:fetch', url, options),

  // ── CSV Workbench ──
  csvParse: (text) => csvTools.parseCSV(text),
  csvStringify: (headers, rows) => csvTools.stringifyCSV(headers, rows),
  csvAnalyze: (headers, rows) => csvTools.analyzeCSV(headers, rows),

  // ── Shell ──
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ── App ──
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),

  // ═══════════════════════════════════════════
  //  数据库操作（替代旧 CSV 读写）
  // ═══════════════════════════════════════════

  // 数据库状态
  dbIsReady: () => dbReady,
  dbGetError: () => dbInitError,
  dbGetPath: () => dbDir,

  // 导入 CSV 到数据库（首次迁移用）
  dbImportCSV: (csvText) => database.importFromCSV(csvText),

  // 番号检查（替代 parseTagCollection + findCodeInCollection）
  dbFindCode: (code) => database.findCode(code),

  // 女优 tag 搜索（替代 matchActressTag）
  dbSearchActressTag: (name) => database.searchActressTag(name),
  dbGetOrCreateActressTag: (name) => database.getOrCreateActressTag(name),

  // 写入处理结果
  dbUpsertCode: (code, url, status) => database.upsertCode(code, url, status),
  dbLinkActressCode: (actressId, codeId) => database.linkActressCode(actressId, codeId),
  dbLinkGenreCode: (genreName, codeId) => database.linkGenreCode(genreName, codeId),

  // 统计
  dbGetStats: () => database.getStats(),
  dbGetActressLibrary: (options) => database.getActressLibrary(options),
  dbGetCodeLibrary: (options) => database.getCodeLibrary(options),
  dbGetRaindropImportRows: (options) => database.getRaindropImportRows(options),
  dbGetDuplicateCodeGroups: () => database.getDuplicateCodeGroups(),
  dbGetHealthReport: (options) => database.getHealthReport(options),
  dbCleanupOrphanTags: (kind) => database.cleanupOrphanTags(kind),
  dbCleanupBrokenRelations: () => database.cleanupBrokenRelations(),
  dbCreateBackup: (label, reason) => database.createBackup(label, reason),
  dbListBackups: () => database.listBackups(),
  dbDeleteBackup: (fileName) => database.deleteBackup(fileName),
  dbRestoreBackup: (fileName) => database.restoreBackup(fileName),
  dbGetBackupDirectory: () => database.getBackupDirectory(),
  dbRenameActressTag: (id, newName) => database.renameActressTag(id, newName),
  dbMergeActressTags: (sourceId, targetId) => database.mergeActressTags(sourceId, targetId),
  dbGetGenreLibrary: (options) => database.getGenreLibrary(options),
  dbCreateGenreTag: (name) => database.createGenreTag(name),
  dbRenameGenreTag: (id, newName) => database.renameGenreTag(id, newName),
  dbDeleteGenreTag: (id) => database.deleteGenreTag(id),
  dbCreateActressTag: (name) => database.createActressTag(name),
  dbDeleteActressTag: (id) => database.deleteActressTag(id),
  dbCreateCodeRecord: (code, url, status) => database.createCodeRecord(code, url, status),
  dbUpdateCodeRecord: (id, patch) => database.updateCodeRecord(id, patch),
  dbDeleteCodeRecord: (id) => database.deleteCodeRecord(id),
  dbSetCodeActressTags: (codeId, tagNames) => database.setCodeActressTags(codeId, tagNames),
  dbSetCodeGenreTags: (codeId, genreNames) => database.setCodeGenreTags(codeId, genreNames),
  dbGetEditableTables: () => database.getEditableTables(),
  dbGetRawTableRows: (table, options) => database.getRawTableRows(table, options),
  dbUpdateRawCell: (table, pk, column, value) => database.updateRawCell(table, pk, column, value),
  dbInsertRawRow: (table, row) => database.insertRawRow(table, row),
  dbDeleteRawRow: (table, pk) => database.deleteRawRow(table, pk),
  // 导出 CSV（兼容旧格式）
  dbExportCSV: () => database.exportToCSV(),

  // 处理记录
  dbCreateRun: () => database.createProcessingRun(),
  dbFinishRun: (runId, stats) => database.finishProcessingRun(runId, stats),
  dbGetRecentRuns: (limit) => database.getRecentRuns(limit),

  // ═══════════════════════════════════════════
  //  核心业务函数（不变）
  // ═══════════════════════════════════════════

  // Parser
  normalizeCode: (s) => parser.normalizeCode(s),
  extractFC2Number: (s) => parser.extractFC2Number(s),
  codeComparableKey: (code) => parser.codeComparableKey(code),
  candidateUrls: (code) => parser.candidateUrls(code),
  parseCodeList: (text) => parser.parseCodeList(text),

  // Fetcher (页面解析)
  checkPageStatus: (html, code, url) => fetcher.checkPageStatus(html, code, url),
  extractActressTags: (html) => fetcher.extractActressTags(html),
  extractGenreTags: (html) => fetcher.extractGenreTags(html),

  // Exporter
  buildOutputRow: (code, url, status, actresses, genres, matchedTag, skippedReason, includeInImport) =>
    exporter.buildOutputRow(code, url, status, actresses, genres, matchedTag, skippedReason, includeInImport),
  generateRaindropHTML: (rows) => exporter.generateRaindropHTML(rows),
  generateRaindropCSV: (rows) => exporter.generateRaindropCSV(rows),
  generateReportCSV: (rows) => exporter.generateReportCSV(rows),
  // CSV 导出改为从数据库读取
  generateTagCollectionCSV: () => database.exportToCSV(),
  generateBackupJSON: (rows, collRows, stats) => exporter.generateBackupJSON(rows, collRows, stats),
  isManualVerifyRow: (row) => exporter.isManualVerifyRow(row),
  timePrefixToMinute: () => exporter.timePrefixToMinute(),

  // Constants
  MANUAL_VERIFY_FOLDER: exporter.MANUAL_VERIFY_FOLDER,
  MAIN_FOLDER: exporter.MAIN_FOLDER,
  NEED_CHECK_TAG: exporter.NEED_CHECK_TAG,
  UNKNOWN_ACTRESS_TAG: exporter.UNKNOWN_ACTRESS_TAG,

  // Utils
  sleep: (ms) => utils.sleep(ms),
});
