const path = require('path');
const fs = require('fs');

const database = require('./database');
const parser = require('./parser');
const fetcher = require('./fetcher');
const av123 = require('./av123');
const exporter = require('./exporter');
const csvTools = require('./csvTools');
const raindrop = require('./raindrop');
const raindropApi = require('./raindropApi');
const inputExtractor = require('./inputExtractor');
const toolboxFilters = require('./toolboxFilters');
const toolRegistry = require('./tools/registry');

const DATABASE_METHODS = new Set([
  'importFromCSV', 'findCode', 'searchActressTag', 'getOrCreateActressTag',
  'upsertCode', 'persistProcessedCode', 'linkActressCode', 'linkGenreCode',
  'getStats', 'getActressLibrary', 'getCodeLibrary', 'getCodeLibraryPage',
  'getCodeLibraryIds', 'getCodeLibraryByIds', 'getBookmarkLibrary', 'getBookmarkStats',
  'getBookmarkCollections', 'getBookmarkCollectionInfo', 'createBookmarkCollection',
  'renameBookmarkCollection', 'deleteBookmarkCollection', 'getBookmarkScopeInfo',
  'deleteBookmarksByScope', 'importRaindropRecords', 'buildRaindropExport',
  'exportRaindropRecords', 'createBookmarkRecord', 'updateBookmarkRecord',
  'deleteBookmarkRecord', 'analyzeCodeImport', 'importHistoricalCodes',
  'importHistoricalRecords', 'getRaindropImportRows', 'getDuplicateCodeGroups',
  'getHealthReport', 'cleanupOrphanTags', 'cleanupBrokenRelations', 'createBackup',
  'listBackups', 'deleteBackup', 'restoreBackup', 'getBackupDirectory',
  'getDatabaseInventory', 'resetAllBusinessData', 'renameActressTag', 'mergeActressTags',
  'getGenreLibrary', 'createGenreTag', 'renameGenreTag', 'deleteGenreTag',
  'createActressTag', 'deleteActressTag', 'createCodeRecord', 'updateCodeRecord',
  'deleteCodeRecord', 'setCodeActressTags', 'setCodeGenreTags', 'getEditableTables',
  'getRawTableRows', 'updateRawCell', 'bulkUpdateRawCells', 'insertRawRow',
  'deleteRawRow', 'bulkDeleteRawRows', 'exportRawTableRows', 'exportToCSV',
  'createProcessingRun', 'markProcessingRunItemRunning', 'updateProcessingRunItem',
  'completeMissavProcessingRunItem', 'updateProcessingItemTask',
  'completeProcessingItemTaskWithCache', 'getRemoteSyncRecord', 'completeRemoteSyncTask',
  'getTelegramSource', 'upsertTelegramSource', 'getTelegramGroupSources',
  'setTelegramGroupSources', 'recordTelegramImport', 'getTelegramImportHistory',
  'getSiteLookupCache', 'setProcessingRunStatus', 'finishProcessingRun',
  'getRecentRuns', 'getProcessingRun', 'getProcessingRunItem', 'getProcessingRunItems',
  'getResumableProcessingRun', 'renameProcessingRun', 'deleteProcessingRun',
  'setProcessingRunSpeedSettings', 'setProcessingRunOutputDir', 'save',
]);

const MODULES = Object.freeze({
  parser: {
    module: parser,
    methods: new Set(['normalizeCode', 'extractFC2Number', 'codeComparableKey', 'candidateUrls']),
  },
  input: {
    module: inputExtractor,
    methods: new Set(['parseInputCodeList']),
  },
  fetcher: {
    module: fetcher,
    methods: new Set([
      'checkPageStatus', 'classifyCandidateResponse', 'resolveCandidateAttempts',
      'shouldStopCandidateSearch', 'extractActressTags', 'extractGenreTags',
    ]),
  },
  av123: {
    module: av123,
    methods: new Set([
      'buildSearchUrl', 'buildDetailUrl', 'buildDetailCandidateUrls', 'classifyResponse',
    ]),
  },
  exporter: {
    module: exporter,
    methods: new Set([
      'buildOutputRow', 'generateRaindropHTML', 'generateRaindropCSV',
      'generateReportCSV', 'buildTagExportGroups', 'generateTagExportIndexCSV',
      'generateBackupJSON', 'isManualVerifyRow', 'timePrefixToMinute',
    ]),
  },
  csv: {
    module: csvTools,
    methods: new Set(['parseCSV', 'stringifyCSV', 'analyzeCSV']),
  },
  raindrop: {
    module: raindrop,
    methods: new Set(['parseRaindropCSV', 'parseRaindropHTML', 'generateRaindropCSV', 'generateRaindropHTML']),
  },
  raindropApi: {
    module: raindropApi,
    methods: new Set(['buildSyncPayload', 'payloadHash', 'selectMissavCollectionName']),
  },
  toolbox: {
    module: toolboxFilters,
    methods: new Set([
      'extractTwitterProfiles', 'extractBadNewsLinks', 'filterMessagesByTime', 'messageTimeExtent',
    ]),
  },
  tools: {
    module: toolRegistry,
    methods: new Set(['listTools', 'getTool', 'groupTools']),
  },
});

let ready = false;
let errorMessage = '';
let databasePath = '';
let initResult = null;

function migrateLegacyData(targetDir, applicationDir) {
  const legacyDir = path.join(applicationDir, 'data');
  const legacyDb = path.join(legacyDir, 'missav_data.db');
  const targetDb = path.join(targetDir, 'missav_data.db');
  if (!fs.existsSync(legacyDb) || fs.existsSync(targetDb)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(legacyDb, targetDb);
  const legacyBackups = path.join(legacyDir, 'backups');
  const targetBackups = path.join(targetDir, 'backups');
  if (fs.existsSync(legacyBackups) && !fs.existsSync(targetBackups)) {
    fs.cpSync(legacyBackups, targetBackups, { recursive: true });
  }
}

async function init(options = {}) {
  const dbDir = path.resolve(String(options.dbDir || ''));
  if (!dbDir) throw new Error('数据库目录不能为空');
  try {
    migrateLegacyData(dbDir, path.resolve(String(options.applicationDir || process.cwd())));
    initResult = await database.init(dbDir);
    databasePath = initResult.path;
    ready = true;
    errorMessage = '';
    return status();
  } catch (error) {
    ready = false;
    errorMessage = error.message || String(error);
    throw error;
  }
}

function status() {
  return {
    ready,
    error: errorMessage,
    path: databasePath,
    engine: initResult?.engine || '',
    schemaVersion: Number(initResult?.schemaVersion || 0),
    migrationBackup: initResult?.migrationBackup || null,
  };
}

function call(scope, method, args = []) {
  const values = Array.isArray(args) ? args : [];
  if (scope === 'database') {
    if (!ready) throw new Error(errorMessage || '数据库尚未初始化');
    if (!DATABASE_METHODS.has(method) || typeof database[method] !== 'function') {
      throw new Error(`不允许的数据库操作：${method}`);
    }
    return database[method](...values);
  }
  if (scope === 'meta') {
    if (method === 'databaseStatus') return status();
    if (method === 'exporterConstants') {
      return {
        MANUAL_VERIFY_FOLDER: exporter.MANUAL_VERIFY_FOLDER,
        MAIN_FOLDER: exporter.MAIN_FOLDER,
        NEED_CHECK_TAG: exporter.NEED_CHECK_TAG,
        UNKNOWN_ACTRESS_TAG: exporter.UNKNOWN_ACTRESS_TAG,
      };
    }
    throw new Error(`不允许的元数据操作：${method}`);
  }
  const target = MODULES[scope];
  if (!target || !target.methods.has(method) || typeof target.module[method] !== 'function') {
    throw new Error(`不允许的核心操作：${scope}.${method}`);
  }
  return target.module[method](...values);
}

function close() {
  database.close();
  ready = false;
}

module.exports = {
  init,
  status,
  call,
  close,
  DATABASE_METHODS,
};
