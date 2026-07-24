/**
 * TG 内容工具箱 — 原生 SQLite 本地数据库模块
 *
 * 表结构：
 *   actress_tags (id, tag_name)
 *   codes (id, code, best_url, status, raindrop_title, raindrop_excerpt, raindrop_note, raindrop_folder, raindrop_tags, raindrop_created, raindrop_cover)
 *   actress_code_map (actress_id, code_id)  多对多
 *   genre_tags (id, name)
 *   code_genres (code_id, genre_id)
 *   processing_runs (批次元数据、进度和统计)
 *   processing_run_items (批次内逐条番号、查询结果和恢复状态)
 *   bookmarks (Raindrop 官方字段与可选番号关联)
 *   bookmark_collections (Collection 目录与空文件夹)
 */

const path = require('path');
const fs = require('fs');
const { normalizeCode, codeComparableKey, parseCodeList } = require('./parser');
const { NativeSqliteDatabase } = require('./nativeSqlite');

const DB_FILENAME = 'missav_data.db';
const NATIVE_MIGRATION_MARKER = '.native-sqlite-v3.json';
const SCHEMA_VERSION = 300;
const REQUIRED_BACKUP_TABLES = ['actress_tags', 'codes', 'actress_code_map'];
const RESET_CONFIRMATION_TEXT = '清空全部数据';
const DATABASE_TABLE_CATALOG = Object.freeze([
  { name: 'codes', label: '永久番号库', category: '核心数据', description: '标准番号、MissAV 链接、状态与 Raindrop 补充字段' },
  { name: 'actress_tags', label: '女优 Tag', category: '核心数据', description: '女优标签主表' },
  { name: 'genre_tags', label: '类型 Tag', category: '核心数据', description: '类型标签主表' },
  { name: 'actress_code_map', label: '女优-番号关联', category: '关系数据', description: '女优 Tag 与番号的多对多关系' },
  { name: 'code_genres', label: '番号-类型关联', category: '关系数据', description: '类型 Tag 与番号的多对多关系' },
  { name: 'processing_runs', label: '处理批次', category: '任务历史', description: '批次名称、来源、速度、进度和输出目录' },
  { name: 'processing_run_items', label: '批次逐条结果', category: '任务历史', description: '每个批次中逐条番号的 MissAV 结果与标签快照' },
  { name: 'processing_item_tasks', label: '四阶段任务状态', category: '任务历史', description: 'MissAV、Raindrop、123AV 查询和收藏的独立状态' },
  { name: 'site_lookup_cache', label: '站点查询缓存', category: '缓存与同步', description: '跨批次复用的站点查询结果' },
  { name: 'remote_sync_records', label: '远端同步映射', category: '缓存与同步', description: 'Raindrop 等远端 ID、Collection 与幂等状态' },
  { name: 'telegram_sources', label: 'Telegram 来源', category: 'Telegram', description: '最多 5 个群组的来源、基线与断点' },
  { name: 'telegram_message_refs', label: 'Telegram 消息指纹', category: 'Telegram', description: '消息去重指纹、日期和已提取番号；不保存正文' },
  { name: 'telegram_import_runs', label: 'Telegram 导入历史', category: 'Telegram', description: '每次导入或增量同步的统计与错误摘要' },
  { name: 'av123_account_runs', label: '旧 123AV 账号运行记录', category: '旧版兼容', description: '已弃用版本遗留的账号操作批次记录' },
  { name: 'av123_account_operations', label: '旧 123AV 账号逐条记录', category: '旧版兼容', description: '已弃用版本遗留的逐条账号操作记录' },
  { name: 'bookmarks', label: '旧收藏兼容表', category: '旧版兼容', description: '旧版本保留，不再作为当前产品主数据' },
  { name: 'bookmark_collections', label: '旧 Collection 兼容表', category: '旧版兼容', description: '旧版本保留，不再作为当前产品主数据' },
]);
// Child tables must be cleared before their parents. This list intentionally
// includes compatibility data so a user-requested fresh start is genuinely empty.
const BUSINESS_DATA_TABLES = Object.freeze([
  'processing_item_tasks',
  'processing_run_items',
  'processing_runs',
  'actress_code_map',
  'code_genres',
  'remote_sync_records',
  'site_lookup_cache',
  'telegram_message_refs',
  'telegram_import_runs',
  'telegram_sources',
  'av123_account_operations',
  'av123_account_runs',
  'bookmarks',
  'bookmark_collections',
  'codes',
  'actress_tags',
  'genre_tags',
]);

let DB = null;
let dbPath = '';

// ─── 初始化 ──────────────────────────────────────────
async function init(dbDir) {
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  dbPath = path.join(dbDir, DB_FILENAME);
  const migrationBackup = prepareNativeMigrationBackup(dbDir);
  try {
    DB = new NativeSqliteDatabase(dbPath);
    createTables();
    migrateSchema();
    DB.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    // 旧收藏表仅保留兼容读取；番号记录不再自动生成或维护本地收藏。
    save('FULL');
    completeNativeMigration(dbDir, migrationBackup);
    return {
      loaded: true,
      path: dbPath,
      engine: 'node:sqlite',
      schemaVersion: SCHEMA_VERSION,
      migrationBackup,
    };
  } catch (error) {
    if (DB) {
      try { DB.close(); } catch {}
      DB = null;
    }
    throw error;
  }
}

function save(mode = 'PASSIVE') {
  if (!DB) return;
  DB.checkpoint(mode);
}

function nativeMigrationMarkerPath(dbDir) {
  return path.join(dbDir, NATIVE_MIGRATION_MARKER);
}

function prepareNativeMigrationBackup(dbDir) {
  const markerPath = nativeMigrationMarkerPath(dbDir);
  if (!fs.existsSync(dbPath) || fs.existsSync(markerPath)) return null;
  const backupDir = path.join(dbDir, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const stamp = backupTimestamp();
  let filePath = path.join(backupDir, `missav_data_${stamp}_v0.3.0_native_migration.db`);
  let suffix = 2;
  while (fs.existsSync(filePath)) {
    filePath = path.join(backupDir, `missav_data_${stamp}_v0.3.0_native_migration_${suffix}.db`);
    suffix++;
  }
  fs.copyFileSync(dbPath, filePath);
  return {
    fileName: path.basename(filePath),
    filePath,
    reason: 'pre_native_sqlite_migration',
    createdAt: new Date().toISOString(),
    size: fs.statSync(filePath).size,
  };
}

function completeNativeMigration(dbDir, migrationBackup) {
  const markerPath = nativeMigrationMarkerPath(dbDir);
  const marker = {
    engine: 'node:sqlite',
    schemaVersion: SCHEMA_VERSION,
    completedAt: new Date().toISOString(),
    backup: migrationBackup,
  };
  const tempPath = `${markerPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(marker, null, 2), 'utf8');
  if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
  fs.renameSync(tempPath, markerPath);
}

// ─── 建表 ────────────────────────────────────────────
function createTables() {
  DB.run(`CREATE TABLE IF NOT EXISTS actress_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tag_name TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')))`);

  DB.run(`CREATE TABLE IF NOT EXISTS codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
    best_url TEXT DEFAULT '', status TEXT DEFAULT 'ok',
    raindrop_title TEXT DEFAULT '', raindrop_excerpt TEXT DEFAULT '',
    raindrop_note TEXT DEFAULT '', raindrop_folder TEXT DEFAULT '',
    raindrop_tags TEXT DEFAULT '', raindrop_created TEXT DEFAULT '',
    raindrop_cover TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')))`);

  DB.run(`CREATE TABLE IF NOT EXISTS actress_code_map (
    actress_id INTEGER NOT NULL, code_id INTEGER NOT NULL,
    PRIMARY KEY (actress_id, code_id))`);

  DB.run(`CREATE TABLE IF NOT EXISTS genre_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`);

  DB.run(`CREATE TABLE IF NOT EXISTS code_genres (
    code_id INTEGER NOT NULL, genre_id INTEGER NOT NULL,
    PRIMARY KEY (code_id, genre_id))`);

  createProcessingTables();
  createSiteLookupCacheTable();
  createRemoteSyncTable();
  createTelegramSourceTables();

  createBookmarkTable();
  createBookmarkCollectionTable();

  DB.run(`CREATE INDEX IF NOT EXISTS idx_codes_code ON codes(code)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_actress_tags_name ON actress_tags(tag_name)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_acm_a ON actress_code_map(actress_id)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_acm_c ON actress_code_map(code_id)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_code_genres_code ON code_genres(code_id, genre_id)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_code_genres_genre ON code_genres(genre_id, code_id)`);
}

function migrateSchema() {
  DB.run('BEGIN TRANSACTION');
  try {
    ensureColumn('codes', 'raindrop_title', "TEXT DEFAULT ''");
    ensureColumn('codes', 'raindrop_excerpt', "TEXT DEFAULT ''");
    ensureColumn('codes', 'raindrop_note', "TEXT DEFAULT ''");
    ensureColumn('codes', 'raindrop_folder', "TEXT DEFAULT ''");
    ensureColumn('codes', 'raindrop_tags', "TEXT DEFAULT ''");
    ensureColumn('codes', 'raindrop_created', "TEXT DEFAULT ''");
    ensureColumn('codes', 'raindrop_cover', "TEXT DEFAULT ''");
    ensureColumn('codes', 'created_at', 'TEXT');
    createProcessingTables();
    ensureColumn('processing_runs', 'name', "TEXT DEFAULT ''");
    ensureColumn('processing_runs', 'source_type', "TEXT DEFAULT 'manual'");
    ensureColumn('processing_runs', 'source_label', "TEXT DEFAULT ''");
    ensureColumn('processing_runs', 'speed_mode', "TEXT DEFAULT ''");
    ensureColumn('processing_runs', 'missav_speed_mode', "TEXT DEFAULT ''");
    ensureColumn('processing_runs', 'av123_speed_mode', "TEXT DEFAULT ''");
    ensureColumn('processing_runs', 'missav_speed_policy', "TEXT DEFAULT 'stable'");
    ensureColumn('processing_runs', 'missav_rate_mode', "TEXT DEFAULT 'adaptive'");
    ensureColumn('processing_runs', 'missav_rate_cap', 'REAL DEFAULT 16');
    ensureColumn('processing_runs', 'av123_speed_policy', "TEXT DEFAULT 'staged'");
    ensureColumn('processing_runs', 'av123_rate_mode', "TEXT DEFAULT 'adaptive'");
    ensureColumn('processing_runs', 'av123_rate_cap', 'REAL DEFAULT 16');
    ensureColumn('processing_runs', 'av123_auto_favorite', 'INTEGER DEFAULT 0');
    ensureColumn('processing_runs', 'av123_favorite_concurrency', 'INTEGER DEFAULT 2');
    ensureColumn('processing_runs', 'status', "TEXT DEFAULT 'completed'");
    ensureColumn('processing_runs', 'updated_at', 'TEXT');
    ensureColumn('processing_runs', 'completed_codes', 'INTEGER DEFAULT 0');
    ensureColumn('processing_runs', 'network_error_codes', 'INTEGER DEFAULT 0');
    ensureColumn('processing_runs', 'manual_codes', 'INTEGER DEFAULT 0');
    ensureColumn('processing_runs', 'output_dir', "TEXT DEFAULT ''");
    ensureColumn('processing_runs', 'pipeline_version', 'INTEGER DEFAULT 1');
    ensureColumn('processing_runs', 'tool_kind', "TEXT DEFAULT 'dual'");
    ensureColumn('processing_runs', 'known_actresses_json', "TEXT DEFAULT '[]'");
    createSiteLookupCacheTable();
    createRemoteSyncTable();
    createTelegramSourceTables();
    recoverInterruptedProcessingRuns();
    createBookmarkTable();
    createBookmarkCollectionTable();
    DB.run(`CREATE INDEX IF NOT EXISTS idx_codes_status_created ON codes(status, created_at DESC, id DESC)`);
    DB.run(`CREATE INDEX IF NOT EXISTS idx_codes_created ON codes(created_at DESC, id DESC)`);
    DB.run(`CREATE INDEX IF NOT EXISTS idx_code_genres_code ON code_genres(code_id, genre_id)`);
    DB.run(`CREATE INDEX IF NOT EXISTS idx_code_genres_genre ON code_genres(genre_id, code_id)`);
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
}

function createProcessingTables() {
  DB.run(`CREATE TABLE IF NOT EXISTS processing_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT DEFAULT (datetime('now','localtime')), finished_at TEXT,
    total_codes INTEGER DEFAULT 0, new_codes INTEGER DEFAULT 0,
    skipped_codes INTEGER DEFAULT 0, not_found_codes INTEGER DEFAULT 0,
    duplicate_codes INTEGER DEFAULT 0)`);

  DB.run(`CREATE TABLE IF NOT EXISTS processing_run_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    code_id INTEGER,
    code TEXT NOT NULL,
    item_status TEXT DEFAULT 'queued',
    result_status TEXT DEFAULT '',
    url TEXT DEFAULT '',
    actresses_json TEXT DEFAULT '[]',
    genres_json TEXT DEFAULT '[]',
    final_tags_json TEXT DEFAULT '[]',
    include_in_import INTEGER DEFAULT 0,
    skipped_reason TEXT DEFAULT '',
    error TEXT DEFAULT '',
    attempt_count INTEGER DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(run_id, position))`);
  DB.run(`CREATE TABLE IF NOT EXISTS processing_item_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    run_item_id INTEGER NOT NULL,
    service TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    url TEXT DEFAULT '',
    error TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}',
    attempt_count INTEGER DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(run_item_id, service, action))`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_processing_items_run ON processing_run_items(run_id, position)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_processing_items_status ON processing_run_items(run_id, item_status)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_processing_items_code ON processing_run_items(code)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_processing_tasks_run ON processing_item_tasks(run_id, service, action, status)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_processing_tasks_item ON processing_item_tasks(run_item_id)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_processing_tasks_status ON processing_item_tasks(status, updated_at, id)`);
  DB.run(`CREATE TRIGGER IF NOT EXISTS trg_processing_run_delete_tasks
    BEFORE DELETE ON processing_runs BEGIN
      DELETE FROM processing_item_tasks WHERE run_id = OLD.id;
      DELETE FROM processing_run_items WHERE run_id = OLD.id;
    END`);
  DB.run(`CREATE TRIGGER IF NOT EXISTS trg_processing_item_delete_tasks
    BEFORE DELETE ON processing_run_items BEGIN
      DELETE FROM processing_item_tasks WHERE run_item_id = OLD.id;
    END`);
}

function createSiteLookupCacheTable() {
  DB.run(`CREATE TABLE IF NOT EXISTS site_lookup_cache (
    service TEXT NOT NULL,
    code_key TEXT NOT NULL,
    code TEXT NOT NULL,
    status TEXT NOT NULL,
    url TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}',
    checked_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (service, code_key))`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_site_lookup_cache_status
    ON site_lookup_cache(service, status, checked_at)`);
}

function createRemoteSyncTable() {
  DB.run(`CREATE TABLE IF NOT EXISTS remote_sync_records (
    service TEXT NOT NULL,
    code_key TEXT NOT NULL,
    code TEXT NOT NULL,
    remote_id TEXT DEFAULT '',
    link TEXT DEFAULT '',
    collection_id INTEGER DEFAULT -1,
    payload_hash TEXT DEFAULT '',
    status TEXT DEFAULT 'succeeded',
    metadata_json TEXT DEFAULT '{}',
    synced_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (service, code_key))`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_remote_sync_status
    ON remote_sync_records(service, status, updated_at)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_remote_sync_id
    ON remote_sync_records(service, remote_id)`);
}

function createTelegramSourceTables() {
  DB.run(`CREATE TABLE IF NOT EXISTS telegram_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    account_key TEXT DEFAULT '',
    account_label TEXT DEFAULT '',
    source_label TEXT DEFAULT '',
    chat_key TEXT DEFAULT '',
    chat_type TEXT DEFAULT '',
    is_selected INTEGER DEFAULT 0,
    baseline_message_id INTEGER DEFAULT 0,
    checkpoint_message_id INTEGER DEFAULT 0,
    checkpoint_date TEXT DEFAULT '',
    sync_cursor_message_id INTEGER DEFAULT 0,
    sync_target_message_id INTEGER DEFAULT 0,
    status TEXT DEFAULT 'idle',
    last_error TEXT DEFAULT '',
    last_sync_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')))`);
  ensureColumn('telegram_sources', 'sync_cursor_message_id', 'INTEGER DEFAULT 0');
  ensureColumn('telegram_sources', 'sync_target_message_id', 'INTEGER DEFAULT 0');
  ensureColumn('telegram_sources', 'source_label', "TEXT DEFAULT ''");
  ensureColumn('telegram_sources', 'chat_key', "TEXT DEFAULT ''");
  ensureColumn('telegram_sources', 'chat_type', "TEXT DEFAULT ''");
  ensureColumn('telegram_sources', 'is_selected', 'INTEGER DEFAULT 0');
  ensureColumn('telegram_sources', 'baseline_message_id', 'INTEGER DEFAULT 0');
  DB.run(`CREATE TABLE IF NOT EXISTS telegram_message_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER,
    dedupe_key TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    source_label TEXT DEFAULT '',
    account_key TEXT DEFAULT '',
    chat_key TEXT DEFAULT 'saved_messages',
    message_id TEXT DEFAULT '',
    message_date TEXT DEFAULT '',
    edited_at TEXT DEFAULT '',
    content_hash TEXT NOT NULL,
    codes_json TEXT DEFAULT '[]',
    first_seen_at TEXT DEFAULT (datetime('now','localtime')),
    last_seen_at TEXT DEFAULT (datetime('now','localtime')))`);
  DB.run(`CREATE TABLE IF NOT EXISTS telegram_import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER,
    source_type TEXT NOT NULL,
    source_label TEXT DEFAULT '',
    status TEXT DEFAULT 'completed',
    message_count INTEGER DEFAULT 0,
    new_message_count INTEGER DEFAULT 0,
    duplicate_message_count INTEGER DEFAULT 0,
    updated_message_count INTEGER DEFAULT 0,
    code_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    errors_json TEXT DEFAULT '[]',
    started_at TEXT DEFAULT (datetime('now','localtime')),
    finished_at TEXT DEFAULT (datetime('now','localtime')))`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_telegram_sources_account
    ON telegram_sources(account_key, source_type)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_telegram_sources_selected
    ON telegram_sources(account_key, source_type, is_selected)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_telegram_refs_content
    ON telegram_message_refs(content_hash, message_date)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_telegram_refs_message
    ON telegram_message_refs(account_key, chat_key, message_id)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_telegram_import_runs_source
    ON telegram_import_runs(source_id, started_at)`);
}

function recoverInterruptedProcessingRuns() {
  DB.run(`UPDATE processing_run_items SET item_status = 'queued', started_at = NULL,
    updated_at = datetime('now','localtime') WHERE item_status = 'running'`);
  DB.run(`UPDATE processing_runs SET status = 'paused', updated_at = datetime('now','localtime')
    WHERE status IN ('running', 'stopping') AND finished_at IS NULL`);
  DB.run(`UPDATE processing_item_tasks SET status = 'queued', started_at = NULL, finished_at = NULL,
    error = CASE WHEN TRIM(COALESCE(error, '')) = '' THEN '程序中断，查询任务等待重试' ELSE error END,
    updated_at = datetime('now','localtime')
    WHERE status = 'running' AND action = 'lookup'`);
  DB.run(`UPDATE processing_item_tasks SET status = 'verify_required', finished_at = NULL,
    error = CASE WHEN TRIM(COALESCE(error, '')) = '' THEN '程序中断，重新执行前需核验远端状态' ELSE error END,
    updated_at = datetime('now','localtime')
    WHERE status = 'running' AND action IN ('sync', 'favorite')`);
}

function backupBeforeBookmarkMigration() {
  if (!fs.existsSync(dbPath)) return;
  const hasBookmarks = queryOne(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bookmarks'`);
  if (hasBookmarks) return;
  const dir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const target = path.join(dir, `missav_data_${stamp}_pre_raindrop_migration.db`);
  if (!fs.existsSync(target)) fs.copyFileSync(dbPath, target);
}

function createBookmarkTable() {
  DB.run(`CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raindrop_id TEXT DEFAULT '',
    url TEXT DEFAULT '', title TEXT DEFAULT '', note TEXT DEFAULT '', excerpt TEXT DEFAULT '',
    folder TEXT DEFAULT '', tags TEXT DEFAULT '', created TEXT DEFAULT '', cover TEXT DEFAULT '',
    highlights TEXT DEFAULT '', favorite INTEGER DEFAULT 0, last_modified TEXT DEFAULT '',
    code TEXT DEFAULT '', source_code_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  DB.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_raindrop_id ON bookmarks(raindrop_id) WHERE TRIM(raindrop_id) <> ''`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_code ON bookmarks(code)`);
  DB.run(`DROP INDEX IF EXISTS idx_bookmarks_source_code`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_source_code ON bookmarks(source_code_id)`);
}

function createBookmarkCollectionTable() {
  DB.run(`CREATE TABLE IF NOT EXISTS bookmark_collections (
    path TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
}

function normalizeCollectionPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join(' / ');
}

function collectionDescendantPattern(value) {
  return `${String(value || '').replace(/[\\%_]/g, match => `\\${match}`)} / %`;
}

function ensureBookmarkCollectionPathNoSave(value) {
  const normalized = normalizeCollectionPath(value);
  if (!normalized) return '';
  const parts = normalized.split(' / ');
  for (let index = 1; index <= parts.length; index++) {
    const pathValue = parts.slice(0, index).join(' / ');
    runSQL(`INSERT OR IGNORE INTO bookmark_collections (path) VALUES (?)`, [pathValue]);
  }
  return normalized;
}

function syncBookmarkCollectionPathsNoSave() {
  const rows = readRows(`SELECT id, folder FROM bookmarks`);
  for (const row of rows) {
    const normalized = ensureBookmarkCollectionPathNoSave(row.folder);
    if (normalized !== String(row.folder || '').trim()) runSQL(`UPDATE bookmarks SET folder = ? WHERE id = ?`, [normalized, row.id]);
  }
}

function getBookmarkCollections() {
  syncBookmarkCollectionPathsNoSave();
  const paths = readRows(`SELECT path FROM bookmark_collections ORDER BY path COLLATE NOCASE`).map(row => row.path);
  return paths.map(pathValue => ({ path: pathValue }));
}

function getBookmarkCollectionInfo(value) {
  const pathValue = normalizeCollectionPath(value);
  if (!pathValue) throw new Error('请选择一个 Collection');
  const pattern = collectionDescendantPattern(pathValue);
  return {
    path: pathValue,
    bookmarkCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE folder = ? OR folder LIKE ? ESCAPE '\\'`, [pathValue, pattern]),
    childCount: countQuery(`SELECT COUNT(*) FROM bookmark_collections WHERE path LIKE ? ESCAPE '\\'`, [pattern]),
  };
}

function createBookmarkCollection(value) {
  const pathValue = ensureBookmarkCollectionPathNoSave(value);
  if (!pathValue) throw new Error('请输入 Collection 名称');
  save();
  return { path: pathValue };
}

function renameBookmarkCollection(value, nextValue) {
  const source = normalizeCollectionPath(value);
  const target = normalizeCollectionPath(nextValue);
  if (!source || !target) throw new Error('Collection 名称不能为空');
  if (source === target) return { renamedCollections: 0, movedBookmarks: 0, path: target };
  if (target.startsWith(`${source} / `)) throw new Error('不能把 Collection 移动到自己的子文件夹中');
  const sourcePattern = collectionDescendantPattern(source);
  const sourceRows = readRows(`SELECT path FROM bookmark_collections WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY LENGTH(path) DESC`, [source, sourcePattern]);
  const bookmarkCount = countQuery(`SELECT COUNT(*) FROM bookmarks WHERE folder = ? OR folder LIKE ? ESCAPE '\\'`, [source, sourcePattern]);
  if (!sourceRows.length && !bookmarkCount) throw new Error('Collection 不存在');

  DB.run('BEGIN TRANSACTION');
  try {
    runSQL(`UPDATE bookmarks SET folder = CASE WHEN folder = ? THEN ? ELSE ? || substr(folder, ?) END, updated_at = datetime('now','localtime') WHERE folder = ? OR folder LIKE ? ESCAPE '\\'`, [source, target, target, source.length + 1, source, sourcePattern]);
    runSQL(`DELETE FROM bookmark_collections WHERE path = ? OR path LIKE ? ESCAPE '\\'`, [source, sourcePattern]);
    for (const row of sourceRows) {
      const nextPath = row.path === source ? target : `${target}${row.path.slice(source.length)}`;
      ensureBookmarkCollectionPathNoSave(nextPath);
    }
    ensureBookmarkCollectionPathNoSave(target);
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  save();
  return { renamedCollections: sourceRows.length, movedBookmarks: bookmarkCount, path: target };
}

function deleteBookmarkCollection(value) {
  const info = getBookmarkCollectionInfo(value);
  const pattern = collectionDescendantPattern(info.path);
  DB.run('BEGIN TRANSACTION');
  try {
    runSQL(`DELETE FROM bookmarks WHERE folder = ? OR folder LIKE ? ESCAPE '\\'`, [info.path, pattern]);
    runSQL(`DELETE FROM bookmark_collections WHERE path = ? OR path LIKE ? ESCAPE '\\'`, [info.path, pattern]);
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  save();
  return info;
}

function getBookmarkScopeInfo(scope) {
  const value = String(scope || '');
  if (value === 'all') {
    return {
      scope: value,
      bookmarkCount: countQuery(`SELECT COUNT(*) FROM bookmarks`),
      collectionCount: countQuery(`SELECT COUNT(*) FROM bookmark_collections`),
    };
  }
  if (value === '__unfiled__') {
    return {
      scope: value,
      bookmarkCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(folder, '')) = ''`),
      collectionCount: 0,
    };
  }
  throw new Error('不允许清空该范围');
}

function deleteBookmarksByScope(scope) {
  const info = getBookmarkScopeInfo(scope);
  DB.run('BEGIN TRANSACTION');
  try {
    if (info.scope === 'all') {
      runSQL(`DELETE FROM bookmarks`);
      runSQL(`DELETE FROM bookmark_collections`);
    } else {
      runSQL(`DELETE FROM bookmarks WHERE TRIM(COALESCE(folder, '')) = ''`);
    }
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  save();
  return info;
}

function syncCodeToBookmarkNoSave(codeId) {
  const row = queryOne(`SELECT id, code, best_url, status, raindrop_title, raindrop_excerpt, raindrop_note, raindrop_folder, raindrop_tags, raindrop_created, raindrop_cover, created_at FROM codes WHERE id = ?`, [codeId]);
  if (!row) return null;
  const existing = queryOne(`SELECT id FROM bookmarks WHERE source_code_id = ?`, [row.id]);
  if (existing) {
    runSQL(`UPDATE bookmarks SET
      code = CASE WHEN TRIM(COALESCE(code, '')) = '' THEN ? ELSE code END,
      url = CASE WHEN TRIM(COALESCE(url, '')) = '' THEN ? ELSE url END,
      title = CASE WHEN TRIM(COALESCE(title, '')) = '' THEN ? ELSE title END,
      excerpt = CASE WHEN TRIM(COALESCE(excerpt, '')) = '' THEN ? ELSE excerpt END,
      note = CASE WHEN TRIM(COALESCE(note, '')) = '' THEN ? ELSE note END,
      folder = CASE WHEN TRIM(COALESCE(folder, '')) = '' THEN ? ELSE folder END,
      tags = CASE WHEN TRIM(COALESCE(tags, '')) = '' THEN ? ELSE tags END,
      created = CASE WHEN TRIM(COALESCE(created, '')) = '' THEN ? ELSE created END,
      cover = CASE WHEN TRIM(COALESCE(cover, '')) = '' THEN ? ELSE cover END
      WHERE id = ?`, [row.code, row.best_url || '', row.raindrop_title || row.code, row.raindrop_excerpt || '', row.raindrop_note || '', row.raindrop_folder || '', row.raindrop_tags || '', row.raindrop_created || row.created_at || '', row.raindrop_cover || '', existing.id]);
    return existing.id;
  }

  const byUrl = row.best_url ? queryOne(`SELECT id FROM bookmarks WHERE url = ? LIMIT 1`, [row.best_url]) : null;
  const byCode = queryOne(`SELECT id FROM bookmarks WHERE code <> '' AND REPLACE(code, '-', '') = REPLACE(?, '-', '') LIMIT 1`, [row.code]);
  const match = byUrl || byCode;
  if (match) {
    runSQL(`UPDATE bookmarks SET source_code_id = ?, code = CASE WHEN TRIM(COALESCE(code, '')) = '' THEN ? ELSE code END WHERE id = ?`, [row.id, row.code, match.id]);
    return match.id;
  }

  runSQL(`INSERT INTO bookmarks (url, title, note, excerpt, folder, tags, created, cover, code, source_code_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.best_url || '', row.raindrop_title || row.code, row.raindrop_note || '', row.raindrop_excerpt || '', row.raindrop_folder || '', row.raindrop_tags || '', row.raindrop_created || row.created_at || '', row.raindrop_cover || '', row.code, row.id]);
  return lastInsertId();
}

function migrateLegacyCodesToBookmarks() {
  const rows = readRows(`SELECT id FROM codes ORDER BY id`);
  for (const row of rows) syncCodeToBookmarkNoSave(row.id);
}

function ensureColumn(table, column, definition) {
  const rows = [];
  const stmt = DB.prepare(`PRAGMA table_info(${table})`);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  if (rows.some(row => row.name === column)) return;
  DB.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// ─── 底层辅助 ────────────────────────────────────────

/** 参数化查询：返回单行对象 */
function queryOne(sql, params = []) {
  let stmt;
  try {
    stmt = DB.prepare(sql);
    if (params.length) stmt.bind(params);
    if (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      const obj = {};
      cols.forEach((c, i) => { obj[c] = vals[i]; });
      stmt.free();
      return obj;
    }
    stmt.free();
    return null;
  } catch (e) { if (stmt) try { stmt.free(); } catch {} return null; }
}

/** 参数化查询：返回单个值 */
function queryValue(sql, params = []) {
  let stmt;
  try {
    stmt = DB.prepare(sql);
    if (params.length) stmt.bind(params);
    if (stmt.step()) { const v = stmt.get()[0]; stmt.free(); return v; }
    stmt.free();
    return 0;
  } catch (e) { if (stmt) try { stmt.free(); } catch {} return 0; }
}

/** 参数化写操作 */
function runSQL(sql, params = []) {
  let stmt;
  try {
    stmt = DB.prepare(sql);
    if (params.length) stmt.bind(params);
    stmt.step();
    stmt.free();
  } catch (e) { if (stmt) try { stmt.free(); } catch {} throw e; }
}

/** 获取最近插入的 rowid */
function lastInsertId() {
  return queryValue(`SELECT last_insert_rowid()`);
}

// ═══════════════════════════════════════════════════════
//  女优 Tag
// ═══════════════════════════════════════════════════════

function getOrCreateActressTag(tagName) {
  const id = getOrCreateActressTagNoSave(tagName);
  if (id) save();
  return id;
}

function getOrCreateActressTagNoSave(tagName) {
  const name = (tagName || '').trim();
  if (!name) return null;
  let row = queryOne(`SELECT id FROM actress_tags WHERE tag_name = ?`, [name]);
  if (row) return row.id;
  runSQL(`INSERT INTO actress_tags (tag_name) VALUES (?)`, [name]);
  return lastInsertId();
}

function getAllActressTags() {
  const stmt = DB.prepare(`SELECT id, tag_name FROM actress_tags ORDER BY tag_name`);
  const rows = [];
  while (stmt.step()) {
    const vals = stmt.get();
    rows.push({ id: vals[0], tag_name: vals[1] });
  }
  stmt.free();
  return rows;
}

function searchActressTag(name) {
  const n = (name || '').trim();
  if (!n) return null;
  let row = queryOne(`SELECT id, tag_name FROM actress_tags WHERE tag_name = ?`, [n]);
  if (row) return row;
  // 模糊匹配
  const all = getAllActressTags();
  const nl = n.toLowerCase();
  for (const t of all) {
    const tl = t.tag_name.toLowerCase();
    if (tl.includes(nl) || nl.includes(tl.split('_')[0])) return t;
  }
  return null;
}

// ═══════════════════════════════════════════════════════
//  番号
// ═══════════════════════════════════════════════════════

function generateCodeVariants(code) {
  const c = String(code).trim().toUpperCase();
  const v = [c, c.replace(/-/g, '')];
  if (c.startsWith('FC2-PPV-')) {
    const n = c.replace('FC2-PPV-', '');
    v.push(`FC2-${n}`, `FC2PPV${n}`, `FC2PPV-${n}`);
  }
  return [...new Set(v)];
}

function findCode(code) {
  const variants = generateCodeVariants(code);
  for (const v of variants) {
    const row = queryOne(`SELECT id, code, best_url, status FROM codes WHERE REPLACE(code, '-', '') = REPLACE(?, '-', '')`, [v]);
    if (row) return { found: true, code_id: row.id, code: row.code, url: row.best_url, status: row.status };
  }
  return { found: false };
}

function upsertCode(code, url, status) {
  const existing = findCode(code);
  if (existing.found) {
    runSQL(`UPDATE codes SET best_url = ?, status = ? WHERE id = ?`, [url || existing.url, status || existing.status, existing.code_id]);
    save();
    return existing.code_id;
  }
  runSQL(`INSERT INTO codes (code, best_url, status) VALUES (?, ?, ?)`, [code, url || '', status || 'ok']);
  const id = lastInsertId();
  save();
  return id;
}

// ═══════════════════════════════════════════════════════
//  关联
// ═══════════════════════════════════════════════════════

function upsertCodeNoSave(code, url, status) {
  const existing = findCode(code);
  if (existing.found) {
    runSQL(`UPDATE codes SET best_url = ?, status = ? WHERE id = ?`, [url || existing.url, status || existing.status, existing.code_id]);
    return existing.code_id;
  }
  runSQL(`INSERT INTO codes (code, best_url, status) VALUES (?, ?, ?)`, [code, url || '', status || 'ok']);
  const id = lastInsertId();
  return id;
}

function linkActressCode(actressId, codeId) {
  linkActressCodeNoSave(actressId, codeId);
  save();
}

function linkActressCodeNoSave(actressId, codeId) {
  try { runSQL(`INSERT OR IGNORE INTO actress_code_map (actress_id, code_id) VALUES (?, ?)`, [actressId, codeId]); } catch {}
}

function linkGenreCode(genreName, codeId) {
  linkGenreCodeNoSave(genreName, codeId);
  save();
}

function linkGenreCodeNoSave(genreName, codeId) {
  const name = (genreName || '').trim();
  if (!name) return;
  let row = queryOne(`SELECT id FROM genre_tags WHERE name = ?`, [name]);
  let genreId;
  if (row) { genreId = row.id; }
  else { runSQL(`INSERT INTO genre_tags (name) VALUES (?)`, [name]); genreId = lastInsertId(); }
  try { runSQL(`INSERT OR IGNORE INTO code_genres (code_id, genre_id) VALUES (?, ?)`, [codeId, genreId]); } catch {}
}

function persistProcessedCode(row = {}, options = {}) {
  const status = String(row.status || '').trim();
  if (['already_exists', 'duplicate_in_input', 'processing_stopped'].includes(status)) return null;
  const code = normalizeCode(row.code) || String(row.code || '').trim().toUpperCase();
  if (!code) throw new Error('处理结果番号不能为空');
  let codeId = null;
  DB.run('BEGIN TRANSACTION');
  try {
    codeId = upsertCodeNoSave(code, String(row.url || '').trim(), status || 'ok');
    const actressTags = Array.isArray(row.matchedActressTags) && row.matchedActressTags.length
      ? row.matchedActressTags
      : row.matchedActressTag ? [row.matchedActressTag] : [];
    if (actressTags.length) {
      for (const tag of actressTags) {
        const actressId = getOrCreateActressTagNoSave(tag);
        if (actressId) linkActressCodeNoSave(actressId, codeId);
      }
    } else if (['not_found', 'no_actress_found'].includes(status)) {
      const unknownId = getOrCreateActressTagNoSave('#未知女优');
      if (unknownId) linkActressCodeNoSave(unknownId, codeId);
    }
    for (const genre of (Array.isArray(row.genres) ? row.genres : [])) linkGenreCodeNoSave(genre, codeId);
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  if (options.persist !== false) save();
  return codeId;
}

// ═══════════════════════════════════════════════════════
//  CSV 导入
// ═══════════════════════════════════════════════════════

function importFromCSV(csvText) {
  const lines = String(csvText).split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { imported: 0 };
  const dataLines = lines.slice(1);
  let imported = 0;

  // 不使用事务（逐行 save），避免大事务导致内存问题
  for (const line of dataLines) {
    const cols = parseSimpleCSV(line);
    if (cols.length < 3) continue;
    const tagName = (cols[0] || '').trim();
    if (!tagName) continue;
    const actressId = getOrCreateActressTagNoSave(tagName);
    if (!actressId) continue;
    for (let i = 2; i < cols.length; i++) {
      const code = normalizeCode((cols[i] || '').trim());
      if (!code || code.length < 5) continue;
      const codeId = upsertCodeNoSave(code, '', 'ok');
      linkActressCodeNoSave(actressId, codeId);
      imported++;
    }
  }
  save(); // 最后统一保存
  return { imported, actressTags: getAllActressTags().length };
}

// ═══════════════════════════════════════════════════════
//  CSV 导出
// ═══════════════════════════════════════════════════════

function exportToCSV() {
  const tags = getAllActressTags();
  const rows = [];
  for (const t of tags) {
    const codes = getCodesByActress(t.id);
    rows.push({ tag: t.tag_name, count: codes.length, codes });
  }
  rows.sort((a, b) => {
    const ak = a.tag.startsWith('#') ? `000_${a.tag}` : `100_${a.tag}`;
    const bk = b.tag.startsWith('#') ? `000_${b.tag}` : `100_${b.tag}`;
    return ak.localeCompare(bk, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  });
  const maxCodes = Math.max(0, ...rows.map(r => r.codes.length));
  const header = ['女优tag名字', '收藏数'];
  for (let i = 1; i <= maxCodes; i++) header.push(`番号${i}`);
  const lines = [header.join(',')];
  for (const row of rows) {
    const cells = [csvCell(row.tag), String(row.count)];
    for (let i = 0; i < maxCodes; i++) cells.push(csvCell(row.codes[i] || ''));
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

function csvCell(s) { return `"${String(s ?? '').replace(/"/g, '""')}"`; }

// ═══════════════════════════════════════════════════════
//  查询辅助
// ═══════════════════════════════════════════════════════

function getCodesByActress(actressId) {
  const stmt = DB.prepare(`SELECT c.code FROM codes c JOIN actress_code_map acm ON c.id = acm.code_id WHERE acm.actress_id = ? ORDER BY c.code`);
  stmt.bind([actressId]);
  const codes = [];
  while (stmt.step()) codes.push(stmt.get()[0]);
  stmt.free();
  return codes;
}

function getStats() {
  return {
    actressCount: queryValue(`SELECT COUNT(*) FROM actress_tags`),
    codeCount: queryValue(`SELECT COUNT(*) FROM codes`),
    linkCount: queryValue(`SELECT COUNT(*) FROM actress_code_map`),
    genreCount: queryValue(`SELECT COUNT(*) FROM genre_tags`),
    genreLinkCount: queryValue(`SELECT COUNT(*) FROM code_genres`),
    processingRunCount: queryValue(`SELECT COUNT(*) FROM processing_runs`),
    processingItemCount: queryValue(`SELECT COUNT(*) FROM processing_run_items`),
    processingTaskCount: queryValue(`SELECT COUNT(*) FROM processing_item_tasks`),
    siteCacheCount: queryValue(`SELECT COUNT(*) FROM site_lookup_cache`),
    remoteSyncCount: queryValue(`SELECT COUNT(*) FROM remote_sync_records`),
    telegramSourceCount: queryValue(`SELECT COUNT(*) FROM telegram_sources`),
    telegramMessageCount: queryValue(`SELECT COUNT(*) FROM telegram_message_refs`),
    telegramImportCount: queryValue(`SELECT COUNT(*) FROM telegram_import_runs`),
    bookmarkCount: queryValue(`SELECT COUNT(*) FROM bookmarks`),
    collectionCount: queryValue(`SELECT COUNT(*) FROM bookmark_collections`),
  };
}

// ═══════════════════════════════════════════════════════
//  本地库管理
// ═══════════════════════════════════════════════════════

function readRows(sql, params = []) {
  const stmt = DB.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) {
    const vals = stmt.get();
    const obj = {};
    cols.forEach((c, i) => { obj[c] = vals[i]; });
    rows.push(obj);
  }
  stmt.free();
  return rows;
}

function normalizeLimit(limit, fallback = 200, max = 1000) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function getActressLibrary(options = {}) {
  const search = String(options.search || '').trim();
  const limit = normalizeLimit(options.limit, 200);
  const pattern = `%${search}%`;
  const rows = readRows(`
    SELECT a.id, a.tag_name,
      COUNT(DISTINCT acm.code_id) AS code_count,
      GROUP_CONCAT(c.code, ' | ') AS codes
    FROM actress_tags a
    LEFT JOIN actress_code_map acm ON acm.actress_id = a.id
    LEFT JOIN codes c ON c.id = acm.code_id
    WHERE (? = '' OR a.tag_name LIKE ?)
    GROUP BY a.id, a.tag_name
    ORDER BY CASE WHEN a.tag_name LIKE '#%' THEN 0 ELSE 1 END, a.tag_name
    LIMIT ?`, [search, pattern, limit]);

  return rows.map(row => ({
    id: row.id,
    tag_name: row.tag_name,
    code_count: row.code_count || 0,
    sample_codes: String(row.codes || '').split(' | ').filter(Boolean).slice(0, 12),
  }));
}

function codeLibraryWhere(options = {}) {
  const search = String(options.search || '').trim();
  const statusFilter = String(options.statusFilter || options.status || 'all').trim();
  const clauses = [];
  const params = [];
  if (search) {
    const pattern = `%${search}%`;
    clauses.push(`(
      c.code LIKE ? COLLATE NOCASE OR c.best_url LIKE ? COLLATE NOCASE
      OR c.raindrop_title LIKE ? COLLATE NOCASE OR c.raindrop_excerpt LIKE ? COLLATE NOCASE
      OR c.raindrop_note LIKE ? COLLATE NOCASE OR c.raindrop_folder LIKE ? COLLATE NOCASE
      OR c.raindrop_tags LIKE ? COLLATE NOCASE OR c.raindrop_created LIKE ? COLLATE NOCASE
      OR EXISTS (
        SELECT 1 FROM actress_code_map acm_search
        JOIN actress_tags a_search ON a_search.id = acm_search.actress_id
        WHERE acm_search.code_id = c.id AND a_search.tag_name LIKE ? COLLATE NOCASE
      )
      OR EXISTS (
        SELECT 1 FROM code_genres cg_search
        JOIN genre_tags g_search ON g_search.id = cg_search.genre_id
        WHERE cg_search.code_id = c.id AND g_search.name LIKE ? COLLATE NOCASE
      )
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (statusFilter === 'no_url') clauses.push(`TRIM(COALESCE(c.best_url, '')) = ''`);
  else if (statusFilter === 'no_actress') clauses.push('NOT EXISTS (SELECT 1 FROM actress_code_map acm_filter WHERE acm_filter.code_id = c.id)');
  else if (statusFilter === 'no_genre') clauses.push('NOT EXISTS (SELECT 1 FROM code_genres cg_filter WHERE cg_filter.code_id = c.id)');
  else if (statusFilter !== 'all') {
    clauses.push('c.status = ?');
    params.push(statusFilter);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function codeLibraryOrder(sort = 'recent') {
  if (sort === 'code') return 'c.code COLLATE NOCASE ASC, c.id ASC';
  if (sort === 'status') return 'c.status COLLATE NOCASE ASC, c.code COLLATE NOCASE ASC, c.id ASC';
  return 'c.created_at DESC, c.id DESC';
}

function mapCodeLibraryRow(row) {
  return {
      id: row.id,
      code: row.code,
      best_url: row.best_url || '',
      status: row.status || '',
      created_at: row.created_at || '',
      raindrop_title: row.raindrop_title || '',
      raindrop_excerpt: row.raindrop_excerpt || '',
      raindrop_note: row.raindrop_note || '',
      raindrop_folder: row.raindrop_folder || '',
      raindrop_tags: row.raindrop_tags || '',
      raindrop_created: row.raindrop_created || '',
      raindrop_cover: row.raindrop_cover || '',
      actress_tags: String(row.actress_tags || '').split(',').filter(Boolean),
      genre_tags: String(row.genre_tags || '').split(',').filter(Boolean),
  };
}

function getCodeLibraryPage(options = {}) {
  const pageSize = normalizeLimit(options.pageSize || options.limit, 160, 500);
  const page = Math.max(1, Number(options.page) || 1);
  const offset = (page - 1) * pageSize;
  const where = codeLibraryWhere(options);
  const total = Number(queryValue(`SELECT COUNT(*) FROM codes c ${where.sql}`, where.params) || 0);
  const rows = readRows(`
    SELECT c.id, c.code, c.best_url, c.status, c.raindrop_title, c.raindrop_excerpt, c.raindrop_note, c.raindrop_folder, c.raindrop_tags, c.raindrop_created, c.raindrop_cover, c.created_at,
      GROUP_CONCAT(DISTINCT a.tag_name) AS actress_tags,
      GROUP_CONCAT(DISTINCT g.name) AS genre_tags
    FROM codes c
    LEFT JOIN actress_code_map acm ON acm.code_id = c.id
    LEFT JOIN actress_tags a ON a.id = acm.actress_id
    LEFT JOIN code_genres cg ON cg.code_id = c.id
    LEFT JOIN genre_tags g ON g.id = cg.genre_id
    ${where.sql}
    GROUP BY c.id
    ORDER BY ${codeLibraryOrder(options.sort)}
    LIMIT ? OFFSET ?`, [...where.params, pageSize, offset]).map(mapCodeLibraryRow);
  return {
    rows,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function getCodeLibrary(options = {}) {
  const limit = normalizeLimit(options.limit, 500, 50000);
  return getCodeLibraryPage({ ...options, page: 1, pageSize: limit }).rows;
}

function getCodeLibraryIds(options = {}) {
  const where = codeLibraryWhere(options);
  const limit = normalizeLimit(options.limit, 100000, 200000);
  return readRows(`SELECT c.id FROM codes c ${where.sql} ORDER BY ${codeLibraryOrder(options.sort)} LIMIT ?`,
    [...where.params, limit]).map(row => Number(row.id)).filter(Boolean);
}

function getCodeLibraryByIds(ids = []) {
  const ordered = [...new Set((ids || []).map(Number).filter(Boolean))].slice(0, 200000);
  if (!ordered.length) return [];
  const rows = [];
  for (let offset = 0; offset < ordered.length; offset += 500) {
    const part = ordered.slice(offset, offset + 500);
    const placeholders = part.map(() => '?').join(',');
    rows.push(...readRows(`
      SELECT c.id, c.code, c.best_url, c.status, c.raindrop_title, c.raindrop_excerpt, c.raindrop_note, c.raindrop_folder, c.raindrop_tags, c.raindrop_created, c.raindrop_cover, c.created_at,
        GROUP_CONCAT(DISTINCT a.tag_name) AS actress_tags,
        GROUP_CONCAT(DISTINCT g.name) AS genre_tags
      FROM codes c
      LEFT JOIN actress_code_map acm ON acm.code_id = c.id
      LEFT JOIN actress_tags a ON a.id = acm.actress_id
      LEFT JOIN code_genres cg ON cg.code_id = c.id
      LEFT JOIN genre_tags g ON g.id = cg.genre_id
      WHERE c.id IN (${placeholders})
      GROUP BY c.id`, part).map(mapCodeLibraryRow));
  }
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  return ordered.map(id => byId.get(id)).filter(Boolean);
}

const BOOKMARK_FIELDS = ['raindrop_id', 'url', 'title', 'note', 'excerpt', 'folder', 'tags', 'created', 'cover', 'highlights', 'favorite', 'last_modified', 'code'];

function extractCodeForBookmark(record) {
  const explicit = normalizeCode(record?.code || '');
  if (/^(FC2-PPV-\d{4,10}|[A-Z]{2,12}-\d{2,8})$/.test(explicit)) return explicit;
  const url = String(record?.url || '').trim();
  if (/^https?:\/\/(?:www\.)?missav\./i.test(url)) {
    const fromUrl = parseCodeList(url)[0];
    if (fromUrl) return fromUrl;
  }

  const text = [record?.title, record?.note, record?.excerpt].filter(Boolean).join(' ');
  const candidates = [];
  for (const match of text.matchAll(/FC2(?:[\s_-]*PPV)?[\s_-]*\d{4,10}/gi)) candidates.push(match[0]);
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Z]{2,12}[-_]\d{2,8})(?=$|[^A-Za-z0-9])/g)) candidates.push(match[1]);
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Z]{2,12}\d{2,8})(?=$|[^A-Za-z0-9])/g)) candidates.push(match[1]);
  return parseCodeList(candidates.join(' '))[0] || '';
}

function normalizeBookmarkRecord(record = {}, options = {}) {
  const aliases = {
    url: record.best_url,
    title: record.raindrop_title,
    note: record.raindrop_note,
    excerpt: record.raindrop_excerpt,
    folder: record.raindrop_folder,
    tags: record.raindrop_tags,
    created: record.raindrop_created,
    cover: record.raindrop_cover,
  };
  const next = {};
  for (const field of BOOKMARK_FIELDS) next[field] = String(aliases[field] !== undefined ? aliases[field] : (record[field] ?? '')).trim();
  next.favorite = record.favorite === true || String(record.favorite || '').toLowerCase() === 'true' || Number(record.favorite) === 1 ? 1 : 0;
  next.favorite_present = record.favorite_present === undefined
    ? Object.prototype.hasOwnProperty.call(record, 'favorite')
    : record.favorite_present === true;
  next.folder = normalizeCollectionPath(next.folder);
  next.code = options.inferCode === false ? normalizeCode(next.code) : extractCodeForBookmark({ ...record, code: next.code });
  return next;
}

function findBookmarkMatch(record) {
  if (record.raindrop_id) {
    const byId = queryOne(`SELECT id FROM bookmarks WHERE raindrop_id = ?`, [record.raindrop_id]);
    if (byId) return byId;
    if (record.url) {
      const exactLegacy = queryOne(`SELECT id FROM bookmarks WHERE url = ? AND title = ? AND folder = ? AND TRIM(COALESCE(raindrop_id, '')) = '' LIMIT 1`, [record.url, record.title, record.folder]);
      if (exactLegacy) return exactLegacy;
    }
    if (record.code) {
      const legacyByCode = queryOne(`SELECT id FROM bookmarks WHERE code <> '' AND TRIM(COALESCE(raindrop_id, '')) = '' AND REPLACE(code, '-', '') = REPLACE(?, '-', '') LIMIT 1`, [record.code]);
      if (legacyByCode) return legacyByCode;
    }
    return null;
  }
  if (record.url) {
    const exact = queryOne(`SELECT id FROM bookmarks WHERE url = ? AND title = ? AND folder = ? LIMIT 1`, [record.url, record.title, record.folder]);
    if (exact) return exact;
    if (!record.title && !record.folder) {
      const byUrl = queryOne(`SELECT id FROM bookmarks WHERE url = ? LIMIT 1`, [record.url]);
      if (byUrl) return byUrl;
    }
  }
  if (record.code && !record.url) {
    const byCode = queryOne(`SELECT id FROM bookmarks WHERE code <> '' AND REPLACE(code, '-', '') = REPLACE(?, '-', '') LIMIT 1`, [record.code]);
    if (byCode) return byCode;
  }
  return null;
}

function ensureCodeForBookmarkNoSave(record) {
  if (!record.code) return null;
  const found = findCode(record.code);
  let codeId;
  if (found.found) {
    codeId = found.code_id;
    runSQL(`UPDATE codes SET
      best_url = CASE WHEN TRIM(COALESCE(best_url, '')) = '' THEN ? ELSE best_url END,
      raindrop_title = CASE WHEN TRIM(COALESCE(raindrop_title, '')) = '' THEN ? ELSE raindrop_title END,
      raindrop_excerpt = CASE WHEN TRIM(COALESCE(raindrop_excerpt, '')) = '' THEN ? ELSE raindrop_excerpt END,
      raindrop_note = CASE WHEN TRIM(COALESCE(raindrop_note, '')) = '' THEN ? ELSE raindrop_note END,
      raindrop_folder = CASE WHEN TRIM(COALESCE(raindrop_folder, '')) = '' THEN ? ELSE raindrop_folder END,
      raindrop_tags = CASE WHEN TRIM(COALESCE(raindrop_tags, '')) = '' THEN ? ELSE raindrop_tags END,
      raindrop_created = CASE WHEN TRIM(COALESCE(raindrop_created, '')) = '' THEN ? ELSE raindrop_created END,
      raindrop_cover = CASE WHEN TRIM(COALESCE(raindrop_cover, '')) = '' THEN ? ELSE raindrop_cover END
      WHERE id = ?`, [record.url, record.title, record.excerpt, record.note, record.folder, record.tags, record.created, record.cover, codeId]);
  } else {
    runSQL(`INSERT INTO codes (code, best_url, status, raindrop_title, raindrop_excerpt, raindrop_note, raindrop_folder, raindrop_tags, raindrop_created, raindrop_cover)
      VALUES (?, ?, 'historical', ?, ?, ?, ?, ?, ?, ?)`, [record.code, record.url, record.title, record.excerpt, record.note, record.folder, record.tags, record.created, record.cover]);
    codeId = lastInsertId();
  }
  return codeId;
}

function importRaindropRecords(records, options = {}) {
  const mode = options.mode === 'skip' ? 'skip' : 'merge';
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let codeLinked = 0;
  DB.run('BEGIN TRANSACTION');
  try {
    for (const raw of Array.isArray(records) ? records : []) {
      const record = normalizeBookmarkRecord(raw);
      if (!record.raindrop_id && !record.url && !record.title && !record.code) { skipped++; continue; }
      const match = findBookmarkMatch(record);
      if (match && mode === 'skip') { skipped++; continue; }
      const sourceCodeId = ensureCodeForBookmarkNoSave(record);
      ensureBookmarkCollectionPathNoSave(record.folder);
      if (sourceCodeId) codeLinked++;

      if (match) {
        const current = queryOne(`SELECT * FROM bookmarks WHERE id = ?`, [match.id]) || {};
        const effective = { ...record };
        for (const field of ['raindrop_id', 'url', 'title', 'note', 'excerpt', 'folder', 'tags', 'created', 'cover', 'highlights', 'last_modified', 'code']) {
          if (!String(effective[field] || '').trim()) effective[field] = current[field] || '';
        }
        effective.favorite = record.favorite_present ? record.favorite : Number(current.favorite || 0);
        ensureBookmarkCollectionPathNoSave(effective.folder);
        runSQL(`UPDATE bookmarks SET raindrop_id = ?, url = ?, title = ?, note = ?, excerpt = ?, folder = ?, tags = ?, created = ?, cover = ?, highlights = ?, favorite = ?, last_modified = ?, code = ?, source_code_id = COALESCE(?, source_code_id), updated_at = datetime('now','localtime') WHERE id = ?`, [
          effective.raindrop_id, effective.url, effective.title, effective.note, effective.excerpt, effective.folder, effective.tags, effective.created, effective.cover, effective.highlights, effective.favorite, effective.last_modified, effective.code, sourceCodeId, match.id,
        ]);
        updated++;
      } else {
        runSQL(`INSERT INTO bookmarks (raindrop_id, url, title, note, excerpt, folder, tags, created, cover, highlights, favorite, last_modified, code, source_code_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [record.raindrop_id, record.url, record.title, record.note, record.excerpt, record.folder, record.tags, record.created, record.cover, record.highlights, record.favorite, record.last_modified, record.code, sourceCodeId]);
        imported++;
      }
    }
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  if (imported || updated) save();
  return { total: imported + updated + skipped, imported, updated, skipped, codeLinked };
}

function getBookmarkLibrary(options = {}) {
  const search = String(options.search || '').trim();
  const limit = normalizeLimit(options.limit, 500, 50000);
  const pattern = `%${search}%`;
  return readRows(`
    SELECT b.*, c.status,
      GROUP_CONCAT(DISTINCT a.tag_name) AS actress_tags,
      GROUP_CONCAT(DISTINCT g.name) AS genre_tags
    FROM bookmarks b
    LEFT JOIN codes c ON c.id = b.source_code_id
    LEFT JOIN actress_code_map acm ON acm.code_id = c.id
    LEFT JOIN actress_tags a ON a.id = acm.actress_id
    LEFT JOIN code_genres cg ON cg.code_id = c.id
    LEFT JOIN genre_tags g ON g.id = cg.genre_id
    WHERE (? = '' OR b.title LIKE ? OR b.url LIKE ? OR b.folder LIKE ? OR b.tags LIKE ? OR b.note LIKE ? OR b.excerpt LIKE ? OR b.code LIKE ? OR b.raindrop_id LIKE ? OR a.tag_name LIKE ? OR g.name LIKE ?)
    GROUP BY b.id
    ORDER BY CASE WHEN TRIM(COALESCE(b.created, '')) = '' THEN 1 ELSE 0 END, b.created DESC, b.id DESC
    LIMIT ?`, [search, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, limit]).map(row => ({
      id: row.id,
      bookmark_id: row.id,
      source_code_id: row.source_code_id || null,
      raindrop_id: row.raindrop_id || '',
      code: row.code || '',
      best_url: row.url || '',
      status: row.status || (row.code ? 'historical' : 'bookmark'),
      raindrop_title: row.title || '',
      raindrop_note: row.note || '',
      raindrop_excerpt: row.excerpt || '',
      raindrop_folder: row.folder || '',
      raindrop_tags: row.tags || '',
      raindrop_created: row.created || '',
      raindrop_cover: row.cover || '',
      highlights: row.highlights || '',
      favorite: Boolean(row.favorite),
      last_modified: row.last_modified || '',
      created_at: row.created_at || '',
      updated_at: row.updated_at || '',
      actress_tags: String(row.actress_tags || '').split(',').filter(Boolean),
      genre_tags: String(row.genre_tags || '').split(',').filter(Boolean),
    }));
}

function getBookmarkStats() {
  return {
    count: countQuery(`SELECT COUNT(*) FROM bookmarks`),
    favoriteCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE favorite = 1`),
    highlightCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(highlights, '')) <> ''`),
    collectionCount: countQuery(`SELECT COUNT(DISTINCT folder) FROM bookmarks WHERE TRIM(COALESCE(folder, '')) <> ''`),
    codeCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(code, '')) <> ''`),
    regularCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(code, '')) = ''`),
    unfiledCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(folder, '')) = ''`),
    noUrlCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(url, '')) = ''`),
    invalidUrlCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(url, '')) <> '' AND LOWER(url) NOT LIKE 'http://%' AND LOWER(url) NOT LIKE 'https://%'`),
    noTitleCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(title, '')) = ''`),
    noTagsCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(tags, '')) = ''`),
    noCreatedCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(created, '')) = ''`),
    unlinkedCodeCount: countQuery(`SELECT COUNT(*) FROM bookmarks WHERE TRIM(COALESCE(code, '')) <> '' AND source_code_id IS NULL`),
  };
}

function updateBookmarkRecord(id, patch = {}) {
  const bookmarkId = Number(id);
  if (!bookmarkId || !queryOne(`SELECT id FROM bookmarks WHERE id = ?`, [bookmarkId])) throw new Error('收藏记录不存在');
  const current = queryOne(`SELECT * FROM bookmarks WHERE id = ?`, [bookmarkId]);
  const hasExplicitCode = Object.prototype.hasOwnProperty.call(patch, 'code');
  const next = normalizeBookmarkRecord({ ...current, ...patch }, { inferCode: !hasExplicitCode || Boolean(String(patch.code || '').trim()) });
  const sourceCodeId = ensureCodeForBookmarkNoSave(next);
  ensureBookmarkCollectionPathNoSave(next.folder);
  runSQL(`UPDATE bookmarks SET raindrop_id = ?, url = ?, title = ?, note = ?, excerpt = ?, folder = ?, tags = ?, created = ?, cover = ?, highlights = ?, favorite = ?, last_modified = ?, code = ?, source_code_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [next.raindrop_id, next.url, next.title, next.note, next.excerpt, next.folder, next.tags, next.created, next.cover, next.highlights, next.favorite, next.last_modified, next.code, sourceCodeId, bookmarkId]);
  save();
  return { updated: true, sourceCodeId: sourceCodeId || null };
}

function createBookmarkRecord(record = {}) {
  const normalized = normalizeBookmarkRecord(record);
  if (!normalized.url && !normalized.title && !normalized.code) throw new Error('Title 和 Link 至少填写一项');
  const match = findBookmarkMatch(normalized);
  if (match) {
    updateBookmarkRecord(match.id, normalized);
    return { id: match.id, imported: 0, updated: 1 };
  }
  const sourceCodeId = ensureCodeForBookmarkNoSave(normalized);
  ensureBookmarkCollectionPathNoSave(normalized.folder);
  runSQL(`INSERT INTO bookmarks (raindrop_id, url, title, note, excerpt, folder, tags, created, cover, highlights, favorite, last_modified, code, source_code_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [normalized.raindrop_id, normalized.url, normalized.title, normalized.note, normalized.excerpt, normalized.folder, normalized.tags, normalized.created, normalized.cover, normalized.highlights, normalized.favorite, normalized.last_modified, normalized.code, sourceCodeId]);
  const id = lastInsertId();
  save();
  return { id, imported: 1, updated: 0 };
}

function deleteBookmarkRecord(id) {
  const bookmarkId = Number(id);
  if (!bookmarkId) throw new Error('收藏记录不存在');
  runSQL(`DELETE FROM bookmarks WHERE id = ?`, [bookmarkId]);
  save();
  return true;
}

function buildRaindropExport(options = {}) {
  const search = String(options.search || '').trim();
  const rows = getBookmarkLibrary({ search, limit: 50000 });
  const records = [];
  const blocked = [];

  for (const row of rows) {
    const url = String(row.best_url || '').trim();
    const isHttpUrl = /^https?:\/\//i.test(url);
    const finalTags = buildFinalTagsForDbRow({
      raindrop_tags: row.raindrop_tags,
      actress_tags: (row.actress_tags || []).join(','),
      genre_tags: (row.genre_tags || []).join(','),
      status: row.status,
    });
    const title = String(row.raindrop_title || '').trim() || row.code || url || 'Untitled';
    const folder = String(row.raindrop_folder || '').trim()
      || (row.code ? (row.status === 'not_found' ? '需要手动核验' : 'MissAV_Import') : '');
    const record = {
      bookmark_id: row.id,
      source_code_id: row.source_code_id,
      raindrop_id: row.raindrop_id,
      title,
      note: row.raindrop_note,
      excerpt: row.raindrop_excerpt,
      url,
      folder,
      tags: finalTags.join(','),
      created: toRaindropCreated(row.raindrop_created || row.created_at),
      cover: row.raindrop_cover,
      highlights: row.highlights,
      favorite: row.favorite,
      last_modified: row.last_modified,
      code: row.code,
      status: row.status,
    };
    if (!url || !isHttpUrl) {
      blocked.push({ ...record, reason: !url ? 'missing_url' : 'invalid_url' });
      continue;
    }
    records.push(record);
  }

  return {
    records,
    blocked,
    summary: {
      total: rows.length,
      exported: records.length,
      blocked: blocked.length,
      missingUrl: blocked.filter(row => row.reason === 'missing_url').length,
      invalidUrl: blocked.filter(row => row.reason === 'invalid_url').length,
    },
  };
}

function exportRaindropRecords(options = {}) {
  return buildRaindropExport(options).records;
}

function analyzeCodeImport(codes) {
  const existingRows = readRows(`SELECT id, code, best_url, status FROM codes`);
  const existingByKey = new Map();
  for (const row of existingRows) {
    const key = codeComparableKey(row.code);
    if (key && !existingByKey.has(key)) existingByKey.set(key, row);
  }

  const seen = new Set();
  const rows = [];
  for (const value of Array.isArray(codes) ? codes : []) {
    const code = normalizeCode(value);
    const key = codeComparableKey(code);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const existing = existingByKey.get(key) || null;
    const status = existing?.status || '';
    rows.push({
      code,
      key,
      classification: !existing ? 'new' : status === 'ok' || status === 'historical' ? 'existing' : 'review',
      existing: existing ? {
        id: existing.id,
        code: existing.code,
        url: existing.best_url || '',
        status,
      } : null,
    });
  }

  return {
    rows,
    total: rows.length,
    newCount: rows.filter(row => row.classification === 'new').length,
    existingCount: rows.filter(row => row.classification === 'existing').length,
    reviewCount: rows.filter(row => row.classification === 'review').length,
  };
}

function importHistoricalCodes(codes) {
  return importHistoricalRecords((Array.isArray(codes) ? codes : []).map(code => ({ code })));
}

function importHistoricalRecords(records) {
  const source = Array.isArray(records) ? records : [];
  const analysis = analyzeCodeImport(source.map(row => row?.code));
  const recordByKey = new Map();
  for (const record of source) {
    const code = normalizeCode(record?.code);
    const key = codeComparableKey(code);
    if (key && !recordByKey.has(key)) recordByKey.set(key, { ...record, code });
  }
  let imported = 0;
  const insert = DB.prepare(`INSERT INTO codes (
    code, best_url, status, raindrop_title, raindrop_excerpt, raindrop_note,
    raindrop_folder, raindrop_tags, raindrop_created, raindrop_cover
  ) VALUES (?, ?, 'historical', ?, ?, ?, ?, ?, ?, ?)`);
  DB.run('BEGIN TRANSACTION');
  try {
    for (const row of analysis.rows) {
      if (row.classification !== 'new') continue;
      const record = recordByKey.get(row.key) || {};
      insert.bind([
        row.code,
        String(record.url || '').trim(),
        String(record.title || '').trim(),
        String(record.excerpt || '').trim(),
        String(record.note || '').trim(),
        String(record.folder || '').trim(),
        String(record.tags || '').trim(),
        String(record.created || '').trim(),
        String(record.cover || '').trim(),
      ]);
      insert.step();
      imported++;
    }
    DB.run('COMMIT');
  } catch (error) {
    try { DB.run('ROLLBACK'); } catch {}
    throw error;
  } finally {
    insert.free();
  }
  if (imported) save();
  return {
    imported,
    existing: analysis.total - imported,
    total: analysis.total,
  };
}

function splitStoredTags(value) {
  return String(value || '').split(/[\n,，|、;；]+/).map(x => x.trim()).filter(Boolean);
}

function uniqueList(items) {
  const result = [];
  for (const item of items || []) {
    const value = String(item || '').trim();
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

function buildFinalTagsForDbRow(row) {
  const explicitTags = splitStoredTags(row.raindrop_tags);
  if (explicitTags.length) return uniqueList(explicitTags);

  const actresses = String(row.actress_tags || '').split(',').filter(Boolean);
  const genres = String(row.genre_tags || '').split(',').filter(Boolean);
  const tags = [];
  if (actresses.length) tags.push(...actresses);
  else if (['not_found', 'no_actress_found', 'need_manual_check'].includes(row.status)) tags.push('#未知女优');
  if (row.status !== 'not_found') tags.push(...genres);
  if (row.status === 'not_found') tags.push('需要查找');
  return uniqueList(tags);
}

function toRaindropCreated(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return `${text}:00+08:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text)) return `${text}+08:00`;
  if (/T\d{2}:\d{2}/.test(text)) return text;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]}T${match[2]}+08:00` : text;
}

function getRaindropImportRows(options = {}) {
  const includeNoUrl = options.includeNoUrl === true;
  const rows = readRows(`
    SELECT c.id, c.code, c.best_url, c.status,
      c.raindrop_title, c.raindrop_excerpt, c.raindrop_note, c.raindrop_folder, c.raindrop_tags, c.raindrop_created, c.raindrop_cover,
      GROUP_CONCAT(DISTINCT a.tag_name) AS actress_tags,
      GROUP_CONCAT(DISTINCT g.name) AS genre_tags
    FROM codes c
    LEFT JOIN actress_code_map acm ON acm.code_id = c.id
    LEFT JOIN actress_tags a ON a.id = acm.actress_id
    LEFT JOIN code_genres cg ON cg.code_id = c.id
    LEFT JOIN genre_tags g ON g.id = cg.genre_id
    GROUP BY c.id
    ORDER BY c.created_at DESC, c.id DESC`);

  return rows
    .filter(row => includeNoUrl || String(row.best_url || '').trim())
    .map(row => ({
      id: row.id,
      code: row.code,
      url: row.best_url || '',
      status: row.status || 'ok',
      title: row.raindrop_title || row.code,
      excerpt: row.raindrop_excerpt || '',
      note: row.raindrop_note || '',
      folder: row.raindrop_folder || (row.status === 'not_found' ? '需要手动核验' : 'MissAV_Import'),
      cover: row.raindrop_cover || '',
      created: toRaindropCreated(row.raindrop_created || row.created_at),
      customTags: splitStoredTags(row.raindrop_tags),
      actresses: String(row.actress_tags || '').split(',').filter(Boolean),
      genres: String(row.genre_tags || '').split(',').filter(Boolean),
      finalTags: buildFinalTagsForDbRow(row),
      includeInImport: includeNoUrl || Boolean(String(row.best_url || '').trim()),
      skippedReason: '',
      error: '',
    }));
}
function getDuplicateCodeGroups() {
  const rows = readRows(`SELECT id, code, best_url, status FROM codes ORDER BY code`);
  const groups = new Map();
  for (const row of rows) {
    const normalized = normalizeCode(row.code);
    const key = codeComparableKey(normalized);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      id: row.id,
      code: row.code,
      normalized,
      best_url: row.best_url || '',
      status: row.status || '',
    });
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ key, items }))
    .slice(0, 200);
}

function renameActressTag(id, newName) {
  const tagId = Number(id);
  const name = String(newName || '').trim();
  if (!tagId || !name) throw new Error('tag id 或新名称为空');
  const existing = queryOne(`SELECT id FROM actress_tags WHERE tag_name = ? AND id <> ?`, [name, tagId]);
  if (existing) throw new Error('目标 tag 名称已存在，请改用合并');
  runSQL(`UPDATE actress_tags SET tag_name = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [name, tagId]);
  save();
  return true;
}

function mergeActressTags(sourceId, targetId) {
  const source = Number(sourceId);
  const target = Number(targetId);
  if (!source || !target || source === target) throw new Error('请选择两个不同的 tag');
  const s = queryOne(`SELECT id FROM actress_tags WHERE id = ?`, [source]);
  const t = queryOne(`SELECT id FROM actress_tags WHERE id = ?`, [target]);
  if (!s || !t) throw new Error('tag 不存在');

  const codeIds = readRows(`SELECT code_id FROM actress_code_map WHERE actress_id = ?`, [source]);
  for (const row of codeIds) {
    linkActressCodeNoSave(target, row.code_id);
  }
  runSQL(`DELETE FROM actress_code_map WHERE actress_id = ?`, [source]);
  runSQL(`DELETE FROM actress_tags WHERE id = ?`, [source]);
  save();
  return true;
}
// ═══════════════════════════════════════════════════════
//  处理记录
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  数据库工作台编辑
// ═══════════════════════════════════════════════════════

const RAW_TABLES = {
  bookmarks: {
    label: '收藏主表',
    pk: ['id'],
    editable: ['raindrop_id', 'url', 'title', 'note', 'excerpt', 'folder', 'tags', 'created', 'cover', 'highlights', 'favorite', 'last_modified', 'code'],
    insertable: ['raindrop_id', 'url', 'title', 'note', 'excerpt', 'folder', 'tags', 'created', 'cover', 'highlights', 'favorite', 'last_modified', 'code'],
    order: 'id DESC',
  },
  bookmark_collections: {
    label: 'Collection 目录',
    pk: ['path'],
    editable: ['path'],
    insertable: ['path'],
    order: 'path ASC',
  },
  actress_tags: {
    label: '女优 Tag',
    pk: ['id'],
    editable: ['tag_name'],
    insertable: ['tag_name'],
    order: 'id DESC',
  },
  codes: {
    label: '番号库',
    pk: ['id'],
    columns: ['id', 'code', 'best_url', 'status', 'created_at'],
    editable: ['code', 'best_url', 'status'],
    insertable: ['code', 'best_url', 'status'],
    order: 'id DESC',
  },
  actress_code_map: {
    label: '女优-番号关联',
    pk: ['actress_id', 'code_id'],
    editable: [],
    insertable: ['actress_id', 'code_id'],
    order: 'actress_id DESC, code_id DESC',
  },
  genre_tags: {
    label: '类型 Tag',
    pk: ['id'],
    editable: ['name'],
    insertable: ['name'],
    order: 'id DESC',
  },
  code_genres: {
    label: '番号-类型关联',
    pk: ['code_id', 'genre_id'],
    editable: [],
    insertable: ['code_id', 'genre_id'],
    order: 'code_id DESC, genre_id DESC',
  },
  processing_runs: {
    label: '处理批次',
    pk: ['id'],
    columns: ['id', 'name', 'tool_kind', 'known_actresses_json', 'pipeline_version', 'status', 'source_type', 'source_label', 'speed_mode', 'missav_speed_mode', 'av123_speed_mode', 'missav_speed_policy', 'missav_rate_mode', 'missav_rate_cap', 'av123_speed_policy', 'av123_rate_mode', 'av123_rate_cap', 'av123_auto_favorite', 'av123_favorite_concurrency', 'started_at', 'finished_at', 'total_codes', 'completed_codes', 'network_error_codes', 'manual_codes', 'output_dir'],
    editable: ['name', 'source_label', 'output_dir', 'known_actresses_json'],
    insertable: ['started_at', 'finished_at', 'total_codes', 'new_codes', 'skipped_codes', 'not_found_codes', 'duplicate_codes'],
    order: 'id DESC',
  },
  processing_run_items: {
    label: '批次逐条结果',
    pk: ['id'],
    columns: ['id', 'run_id', 'position', 'code_id', 'code', 'item_status', 'result_status', 'url', 'actresses_json', 'genres_json', 'final_tags_json', 'include_in_import', 'skipped_reason', 'error', 'attempt_count', 'started_at', 'finished_at', 'updated_at'],
    editable: ['result_status', 'url', 'actresses_json', 'genres_json', 'final_tags_json', 'include_in_import', 'skipped_reason', 'error'],
    insertable: [],
    order: 'id DESC',
  },
  processing_item_tasks: {
    label: '四阶段任务状态',
    pk: ['id'],
    columns: ['id', 'run_id', 'run_item_id', 'service', 'action', 'status', 'url', 'error', 'metadata_json', 'attempt_count', 'started_at', 'finished_at', 'updated_at'],
    editable: ['url', 'error', 'metadata_json'],
    insertable: [],
    order: 'id DESC',
  },
  site_lookup_cache: {
    label: '站点查询缓存',
    pk: ['service', 'code_key'],
    columns: ['service', 'code_key', 'code', 'status', 'url', 'metadata_json', 'checked_at'],
    editable: ['code', 'status', 'url', 'metadata_json', 'checked_at'],
    insertable: ['service', 'code_key', 'code', 'status', 'url', 'metadata_json', 'checked_at'],
    order: 'checked_at DESC, service ASC, code_key ASC',
  },
  remote_sync_records: {
    label: '远端同步映射',
    pk: ['service', 'code_key'],
    columns: ['service', 'code_key', 'code', 'remote_id', 'link', 'collection_id', 'payload_hash', 'status', 'metadata_json', 'synced_at', 'updated_at'],
    editable: ['code', 'remote_id', 'link', 'collection_id', 'payload_hash', 'status', 'metadata_json', 'synced_at', 'updated_at'],
    insertable: ['service', 'code_key', 'code', 'remote_id', 'link', 'collection_id', 'payload_hash', 'status', 'metadata_json', 'synced_at', 'updated_at'],
    order: 'updated_at DESC, service ASC, code_key ASC',
  },
  telegram_sources: {
    label: 'Telegram 来源',
    pk: ['id'],
    columns: ['id', 'source_key', 'source_type', 'account_key', 'account_label', 'source_label', 'chat_key', 'chat_type', 'is_selected', 'baseline_message_id', 'checkpoint_message_id', 'checkpoint_date', 'sync_cursor_message_id', 'sync_target_message_id', 'status', 'last_error', 'last_sync_at', 'created_at', 'updated_at'],
    editable: ['account_label', 'source_label', 'is_selected', 'status', 'last_error'],
    insertable: [],
    order: 'id DESC',
  },
  telegram_message_refs: {
    label: 'Telegram 消息指纹',
    pk: ['id'],
    columns: ['id', 'source_id', 'dedupe_key', 'source_type', 'source_label', 'account_key', 'chat_key', 'message_id', 'message_date', 'edited_at', 'content_hash', 'codes_json', 'first_seen_at', 'last_seen_at'],
    editable: ['source_label', 'message_date', 'edited_at', 'codes_json'],
    insertable: [],
    order: 'id DESC',
  },
  telegram_import_runs: {
    label: 'Telegram 导入历史',
    pk: ['id'],
    columns: ['id', 'source_id', 'source_type', 'source_label', 'status', 'message_count', 'new_message_count', 'duplicate_message_count', 'updated_message_count', 'code_count', 'error_count', 'errors_json', 'started_at', 'finished_at'],
    editable: ['source_label', 'status', 'errors_json'],
    insertable: [],
    order: 'id DESC',
  },
};

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function getRawTableConfig(table) {
  const name = String(table || '').trim();
  const cfg = RAW_TABLES[name];
  if (!cfg) throw new Error('不允许访问该数据表');
  return { name, ...cfg };
}

function getEditableTables() {
  return Object.entries(RAW_TABLES).map(([name, cfg]) => ({
    name,
    label: cfg.label,
    pk: cfg.pk,
    editable: cfg.editable,
    insertable: cfg.insertable,
    ...(DATABASE_TABLE_CATALOG.find(table => table.name === name) || {}),
  }));
}

function getTableColumns(table) {
  return readRows(`PRAGMA table_info(${quoteIdent(table)})`).map(row => row.name);
}

function parseNameList(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,，|、;；]+/);
  const result = [];
  for (const item of items) {
    const name = String(item || '').trim();
    if (name && !result.includes(name)) result.push(name);
  }
  return result;
}

function parsePk(pk, cfg) {
  let obj = pk || {};
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { obj = {}; }
  }
  const where = [];
  const values = [];
  for (const col of cfg.pk) {
    if (obj[col] === undefined || obj[col] === null || obj[col] === '') throw new Error('缺少主键字段：' + col);
    where.push(`${quoteIdent(col)} = ?`);
    values.push(obj[col]);
  }
  return { where: where.join(' AND '), values, obj };
}

function ensureCodeExists(codeId) {
  const id = Number(codeId);
  if (!id || !queryOne(`SELECT id FROM codes WHERE id = ?`, [id])) throw new Error('番号记录不存在');
  return id;
}

function ensureActressExists(actressId) {
  const id = Number(actressId);
  if (!id || !queryOne(`SELECT id FROM actress_tags WHERE id = ?`, [id])) throw new Error('女优 tag 不存在');
  return id;
}

function ensureGenreExists(genreId) {
  const id = Number(genreId);
  if (!id || !queryOne(`SELECT id FROM genre_tags WHERE id = ?`, [id])) throw new Error('类型 tag 不存在');
  return id;
}

function normalizeCounter(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function validateRawValue(table, column, value, pkObj = {}) {
  let next = value == null ? '' : String(value).trim();

  if (table === 'codes') {
    if (column === 'code') {
      next = normalizeCode(next);
      if (!next) throw new Error('番号不能为空');
      const duplicate = queryOne(`SELECT id FROM codes WHERE REPLACE(code, '-', '') = REPLACE(?, '-', '') AND id <> ?`, [next, Number(pkObj.id || 0)]);
      if (duplicate) throw new Error('该番号已存在');
    }
    if (column === 'status') next = next || 'ok';
    return next;
  }

  if (table === 'actress_tags' && column === 'tag_name') {
    if (!next) throw new Error('女优 tag 不能为空');
    const duplicate = queryOne(`SELECT id FROM actress_tags WHERE tag_name = ? AND id <> ?`, [next, Number(pkObj.id || 0)]);
    if (duplicate) throw new Error('该女优 tag 已存在');
    return next;
  }

  if (table === 'genre_tags' && column === 'name') {
    if (!next) throw new Error('类型 tag 不能为空');
    const duplicate = queryOne(`SELECT id FROM genre_tags WHERE name = ? AND id <> ?`, [next, Number(pkObj.id || 0)]);
    if (duplicate) throw new Error('该类型 tag 已存在');
    return next;
  }

  if (table === 'processing_runs' && /_codes$/.test(column)) return normalizeCounter(next);
  if (['actresses_json', 'genres_json', 'final_tags_json', 'metadata_json', 'codes_json', 'errors_json'].includes(column)) {
    const fallback = column === 'metadata_json' ? '{}' : '[]';
    next = next || fallback;
    try {
      JSON.parse(next);
    } catch {
      throw new Error(`${column} 必须是有效 JSON`);
    }
    return next;
  }
  if (column === 'is_selected' || column === 'include_in_import') return ['1', 'true', 'yes', '是'].includes(next.toLowerCase()) ? 1 : 0;
  if (column === 'collection_id') {
    const number = Number(next);
    if (!Number.isFinite(number)) throw new Error('collection_id 必须是数字');
    return Math.trunc(number);
  }
  return next;
}

function getRawTableRows(table, options = {}) {
  const cfg = getRawTableConfig(table);
  const tableColumns = getTableColumns(cfg.name);
  const columns = (cfg.columns || tableColumns).filter(column => tableColumns.includes(column));
  const limit = normalizeLimit(options.limit, 300, 2000);
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const search = String(options.search || '').trim();
  const params = [];
  let where = '';

  if (search) {
    const pattern = `%${search}%`;
    where = `WHERE ${columns.map(col => `CAST(${quoteIdent(col)} AS TEXT) LIKE ?`).join(' OR ')}`;
    for (let i = 0; i < columns.length; i++) params.push(pattern);
  }

  const total = countQuery(`SELECT COUNT(*) FROM ${quoteIdent(cfg.name)}`);
  const filteredTotal = search
    ? countQuery(`SELECT COUNT(*) FROM ${quoteIdent(cfg.name)} ${where}`, params)
    : total;
  const sql = `SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(cfg.name)} ${where} ORDER BY ${cfg.order} LIMIT ? OFFSET ?`;
  const rows = readRows(sql, [...params, limit, offset]);
  return {
    table: cfg.name,
    label: cfg.label,
    columns,
    pk: cfg.pk,
    editable: cfg.editable,
    insertable: cfg.insertable,
    rows,
    total,
    filteredTotal,
    limit,
    offset,
  };
}

function updateRawCell(table, pk, column, value) {
  const cfg = getRawTableConfig(table);
  const col = String(column || '').trim();
  if (!cfg.editable.includes(col)) throw new Error('该字段不允许直接编辑');
  const key = parsePk(pk, cfg);

  if (cfg.name === 'bookmarks') {
    updateBookmarkRecord(key.obj.id, { [col]: value });
    return true;
  }
  if (cfg.name === 'bookmark_collections' && col === 'path') {
    renameBookmarkCollection(key.obj.path, value);
    return true;
  }

  const next = validateRawValue(cfg.name, col, value, key.obj);
  const setSql = cfg.name === 'actress_tags' && col === 'tag_name'
    ? `${quoteIdent(col)} = ?, updated_at = datetime('now','localtime')`
    : `${quoteIdent(col)} = ?`;
  runSQL(`UPDATE ${quoteIdent(cfg.name)} SET ${setSql} WHERE ${key.where}`, [next, ...key.values]);
  save();
  return true;
}

function bulkUpdateRawCells(table, pks, column, value) {
  const cfg = getRawTableConfig(table);
  const keys = Array.isArray(pks) ? pks.slice(0, 5000) : [];
  const col = String(column || '').trim();
  if (!keys.length) throw new Error('请先选择要修改的记录');
  if (!cfg.editable.includes(col)) throw new Error('该字段不允许批量编辑');
  if (['bookmarks', 'bookmark_collections'].includes(cfg.name)) throw new Error('旧兼容表不支持批量直接编辑');

  DB.run('BEGIN TRANSACTION');
  try {
    for (const pk of keys) {
      const key = parsePk(pk, cfg);
      const next = validateRawValue(cfg.name, col, value, key.obj);
      const setSql = cfg.name === 'actress_tags' && col === 'tag_name'
        ? `${quoteIdent(col)} = ?, updated_at = datetime('now','localtime')`
        : `${quoteIdent(col)} = ?`;
      runSQL(`UPDATE ${quoteIdent(cfg.name)} SET ${setSql} WHERE ${key.where}`, [next, ...key.values]);
    }
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  save();
  return { updated: keys.length, table: cfg.name, column: col };
}

function insertRawRow(table, row = {}) {
  const cfg = getRawTableConfig(table);
  const data = row || {};

  if (cfg.name === 'bookmarks') return createBookmarkRecord(data);
  if (cfg.name === 'bookmark_collections') return createBookmarkCollection(data.path);
  if (cfg.name === 'codes') return createCodeRecord(data.code, data.best_url, data.status);
  if (cfg.name === 'actress_tags') return createActressTag(data.tag_name);
  if (cfg.name === 'genre_tags') return createGenreTag(data.name);

  if (cfg.name === 'actress_code_map') {
    const actressId = ensureActressExists(data.actress_id);
    const codeId = ensureCodeExists(data.code_id);
    linkActressCodeNoSave(actressId, codeId);
    save();
    return true;
  }

  if (cfg.name === 'code_genres') {
    const codeId = ensureCodeExists(data.code_id);
    const genreId = ensureGenreExists(data.genre_id);
    runSQL(`INSERT OR IGNORE INTO code_genres (code_id, genre_id) VALUES (?, ?)`, [codeId, genreId]);
    save();
    return true;
  }

  if (cfg.name === 'processing_runs') {
    runSQL(`INSERT INTO processing_runs (started_at, finished_at, total_codes, new_codes, skipped_codes, not_found_codes, duplicate_codes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      String(data.started_at || '').trim() || null,
      String(data.finished_at || '').trim() || null,
      normalizeCounter(data.total_codes),
      normalizeCounter(data.new_codes),
      normalizeCounter(data.skipped_codes),
      normalizeCounter(data.not_found_codes),
      normalizeCounter(data.duplicate_codes),
    ]);
    const id = lastInsertId();
    save();
    return id;
  }

  if (cfg.name === 'site_lookup_cache') {
    const service = String(data.service || '').trim();
    const codeKey = String(data.code_key || '').trim();
    if (!service || !codeKey) throw new Error('service 和 code_key 不能为空');
    runSQL(`INSERT INTO site_lookup_cache (service, code_key, code, status, url, metadata_json, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), datetime('now','localtime')))`, [
      service,
      codeKey,
      String(data.code || '').trim(),
      String(data.status || 'not_found').trim() || 'not_found',
      String(data.url || '').trim(),
      validateRawValue(cfg.name, 'metadata_json', data.metadata_json),
      String(data.checked_at || '').trim(),
    ]);
    save();
    return true;
  }

  if (cfg.name === 'remote_sync_records') {
    const service = String(data.service || '').trim();
    const codeKey = String(data.code_key || '').trim();
    if (!service || !codeKey) throw new Error('service 和 code_key 不能为空');
    runSQL(`INSERT INTO remote_sync_records
      (service, code_key, code, remote_id, link, collection_id, payload_hash, status, metadata_json, synced_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), datetime('now','localtime')), COALESCE(NULLIF(?, ''), datetime('now','localtime')))`, [
      service,
      codeKey,
      String(data.code || '').trim(),
      String(data.remote_id || '').trim(),
      String(data.link || '').trim(),
      validateRawValue(cfg.name, 'collection_id', data.collection_id || -1),
      String(data.payload_hash || '').trim(),
      String(data.status || 'succeeded').trim() || 'succeeded',
      validateRawValue(cfg.name, 'metadata_json', data.metadata_json),
      String(data.synced_at || '').trim(),
      String(data.updated_at || '').trim(),
    ]);
    save();
    return true;
  }

  throw new Error('该数据表暂不支持新增');
}

function deleteRawRow(table, pk) {
  const cfg = getRawTableConfig(table);
  const key = parsePk(pk, cfg);

  if (cfg.name === 'bookmarks') return deleteBookmarkRecord(key.obj.id);
  if (cfg.name === 'bookmark_collections') return deleteBookmarkCollection(key.obj.path);
  if (cfg.name === 'codes') return deleteCodeRecord(key.obj.id);
  if (cfg.name === 'actress_tags') return deleteActressTag(key.obj.id);
  if (cfg.name === 'genre_tags') return deleteGenreTag(key.obj.id);
  if (cfg.name === 'processing_runs') return deleteProcessingRun(key.obj.id, { createBackup: false }).deleted;

  runSQL(`DELETE FROM ${quoteIdent(cfg.name)} WHERE ${key.where}`, key.values);
  save();
  return true;
}

function bulkDeleteRawRows(table, pks) {
  const cfg = getRawTableConfig(table);
  const keys = Array.isArray(pks) ? pks.slice(0, 5000) : [];
  if (!keys.length) throw new Error('请先选择要删除的记录');
  if (['bookmarks', 'bookmark_collections'].includes(cfg.name)) throw new Error('旧兼容表不支持批量直接删除');

  DB.run('BEGIN TRANSACTION');
  try {
    for (const pk of keys) {
      const key = parsePk(pk, cfg);
      if (cfg.name === 'codes') {
        const codeId = Number(key.obj.id);
        runSQL(`UPDATE bookmarks SET source_code_id = NULL WHERE source_code_id = ?`, [codeId]);
        runSQL(`DELETE FROM actress_code_map WHERE code_id = ?`, [codeId]);
        runSQL(`DELETE FROM code_genres WHERE code_id = ?`, [codeId]);
      } else if (cfg.name === 'actress_tags') {
        runSQL(`DELETE FROM actress_code_map WHERE actress_id = ?`, [Number(key.obj.id)]);
      } else if (cfg.name === 'genre_tags') {
        runSQL(`DELETE FROM code_genres WHERE genre_id = ?`, [Number(key.obj.id)]);
      }
      runSQL(`DELETE FROM ${quoteIdent(cfg.name)} WHERE ${key.where}`, key.values);
    }
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  save();
  return { deleted: keys.length, table: cfg.name };
}

function exportRawTableRows(table, options = {}) {
  const cfg = getRawTableConfig(table);
  const tableColumns = getTableColumns(cfg.name);
  const columns = (cfg.columns || tableColumns).filter(column => tableColumns.includes(column));
  const search = String(options.search || '').trim();
  const params = [];
  let where = '';
  if (search) {
    const pattern = `%${search}%`;
    where = `WHERE ${columns.map(col => `CAST(${quoteIdent(col)} AS TEXT) LIKE ?`).join(' OR ')}`;
    for (let index = 0; index < columns.length; index++) params.push(pattern);
  }
  const rows = readRows(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(cfg.name)} ${where} ORDER BY ${cfg.order} LIMIT 100000`, params);
  return { table: cfg.name, label: cfg.label, columns, rows, truncated: rows.length >= 100000 };
}

function createCodeRecord(code, url = '', status = 'ok') {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error('番号不能为空');
  const duplicate = queryOne(`SELECT id FROM codes WHERE REPLACE(code, '-', '') = REPLACE(?, '-', '')`, [normalized]);
  if (duplicate) throw new Error('该番号已存在');
  runSQL(`INSERT INTO codes (code, best_url, status) VALUES (?, ?, ?)`, [normalized, String(url || '').trim(), String(status || 'ok').trim() || 'ok']);
  const id = lastInsertId();
  save();
  return id;
}

function updateCodeRecord(id, patch = {}) {
  const codeId = ensureCodeExists(id);
  const updates = [];
  const params = [];
  if (Object.prototype.hasOwnProperty.call(patch, 'code')) {
    const next = validateRawValue('codes', 'code', patch.code, { id: codeId });
    updates.push(`code = ?`);
    params.push(next);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'best_url')) {
    updates.push(`best_url = ?`);
    params.push(String(patch.best_url || '').trim());
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    updates.push(`status = ?`);
    params.push(String(patch.status || 'ok').trim() || 'ok');
  }
  for (const field of ['raindrop_title', 'raindrop_excerpt', 'raindrop_note', 'raindrop_folder', 'raindrop_tags', 'raindrop_created', 'raindrop_cover']) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      updates.push(`${field} = ?`);
      params.push(String(patch[field] || '').trim());
    }
  }
  if (updates.length) {
    runSQL(`UPDATE codes SET ${updates.join(', ')} WHERE id = ?`, [...params, codeId]);
    save();
  }
  return true;
}

function deleteCodeRecord(id) {
  const codeId = ensureCodeExists(id);
  runSQL(`UPDATE bookmarks SET source_code_id = NULL WHERE source_code_id = ?`, [codeId]);
  runSQL(`DELETE FROM actress_code_map WHERE code_id = ?`, [codeId]);
  runSQL(`DELETE FROM code_genres WHERE code_id = ?`, [codeId]);
  runSQL(`DELETE FROM codes WHERE id = ?`, [codeId]);
  save();
  return true;
}

function setCodeActressTags(codeId, tagNames) {
  const id = ensureCodeExists(codeId);
  const names = parseNameList(tagNames);
  runSQL(`DELETE FROM actress_code_map WHERE code_id = ?`, [id]);
  for (const name of names) {
    const actressId = getOrCreateActressTagNoSave(name);
    if (actressId) linkActressCodeNoSave(actressId, id);
  }
  save();
  return true;
}

function getOrCreateGenreNoSave(genreName) {
  const name = String(genreName || '').trim();
  if (!name) return null;
  const row = queryOne(`SELECT id FROM genre_tags WHERE name = ?`, [name]);
  if (row) return row.id;
  runSQL(`INSERT INTO genre_tags (name) VALUES (?)`, [name]);
  return lastInsertId();
}

function setCodeGenreTags(codeId, genreNames) {
  const id = ensureCodeExists(codeId);
  const names = parseNameList(genreNames);
  runSQL(`DELETE FROM code_genres WHERE code_id = ?`, [id]);
  for (const name of names) {
    const genreId = getOrCreateGenreNoSave(name);
    if (genreId) runSQL(`INSERT OR IGNORE INTO code_genres (code_id, genre_id) VALUES (?, ?)`, [id, genreId]);
  }
  save();
  return true;
}

function createActressTag(tagName) {
  const name = String(tagName || '').trim();
  if (!name) throw new Error('女优 tag 不能为空');
  const duplicate = queryOne(`SELECT id FROM actress_tags WHERE tag_name = ?`, [name]);
  if (duplicate) throw new Error('该女优 tag 已存在');
  runSQL(`INSERT INTO actress_tags (tag_name) VALUES (?)`, [name]);
  const id = lastInsertId();
  save();
  return id;
}

function deleteActressTag(id) {
  const tagId = ensureActressExists(id);
  runSQL(`DELETE FROM actress_code_map WHERE actress_id = ?`, [tagId]);
  runSQL(`DELETE FROM actress_tags WHERE id = ?`, [tagId]);
  save();
  return true;
}

function getGenreLibrary(options = {}) {
  const search = String(options.search || '').trim();
  const limit = normalizeLimit(options.limit, 300);
  const pattern = `%${search}%`;
  const rows = readRows(`
    SELECT g.id, g.name,
      COUNT(DISTINCT cg.code_id) AS code_count,
      GROUP_CONCAT(c.code, ' | ') AS codes
    FROM genre_tags g
    LEFT JOIN code_genres cg ON cg.genre_id = g.id
    LEFT JOIN codes c ON c.id = cg.code_id
    WHERE (? = '' OR g.name LIKE ? OR c.code LIKE ?)
    GROUP BY g.id, g.name
    ORDER BY g.name
    LIMIT ?`, [search, pattern, pattern, limit]);

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    code_count: row.code_count || 0,
    sample_codes: String(row.codes || '').split(' | ').filter(Boolean).slice(0, 12),
  }));
}

function createGenreTag(name) {
  const tag = String(name || '').trim();
  if (!tag) throw new Error('类型 tag 不能为空');
  const duplicate = queryOne(`SELECT id FROM genre_tags WHERE name = ?`, [tag]);
  if (duplicate) throw new Error('该类型 tag 已存在');
  runSQL(`INSERT INTO genre_tags (name) VALUES (?)`, [tag]);
  const id = lastInsertId();
  save();
  return id;
}

function renameGenreTag(id, newName) {
  const genreId = ensureGenreExists(id);
  const name = String(newName || '').trim();
  if (!name) throw new Error('类型 tag 不能为空');
  const duplicate = queryOne(`SELECT id FROM genre_tags WHERE name = ? AND id <> ?`, [name, genreId]);
  if (duplicate) throw new Error('该类型 tag 已存在');
  runSQL(`UPDATE genre_tags SET name = ? WHERE id = ?`, [name, genreId]);
  save();
  return true;
}

function deleteGenreTag(id) {
  const genreId = ensureGenreExists(id);
  runSQL(`DELETE FROM code_genres WHERE genre_id = ?`, [genreId]);
  runSQL(`DELETE FROM genre_tags WHERE id = ?`, [genreId]);
  save();
  return true;
}
// ═══════════════════════════════════════════════════════
//  数据健康检查
// ═══════════════════════════════════════════════════════

function countQuery(sql, params = []) {
  return Number(queryValue(sql, params) || 0);
}

function getHealthReport(options = {}) {
  const limit = normalizeLimit(options.limit, 120, 500);
  const duplicateGroups = getDuplicateCodeGroups();

  const issues = {
    noUrl: readRows(`SELECT id, code, best_url, status, created_at FROM codes
      WHERE TRIM(COALESCE(best_url, '')) = ''
      ORDER BY id DESC LIMIT ?`, [limit]),
    badUrl: readRows(`SELECT id, code, best_url, status, created_at FROM codes
      WHERE TRIM(COALESCE(best_url, '')) <> ''
        AND best_url NOT LIKE 'http://%'
        AND best_url NOT LIKE 'https://%'
      ORDER BY id DESC LIMIT ?`, [limit]),
    noActress: readRows(`SELECT c.id, c.code, c.best_url, c.status, c.created_at
      FROM codes c
      LEFT JOIN actress_code_map acm ON acm.code_id = c.id
      GROUP BY c.id
      HAVING COUNT(acm.actress_id) = 0
      ORDER BY c.id DESC LIMIT ?`, [limit]),
    noGenre: readRows(`SELECT c.id, c.code, c.best_url, c.status, c.created_at
      FROM codes c
      LEFT JOIN code_genres cg ON cg.code_id = c.id
      GROUP BY c.id
      HAVING COUNT(cg.genre_id) = 0
      ORDER BY c.id DESC LIMIT ?`, [limit]),
    manualStatus: readRows(`SELECT id, code, best_url, status, created_at FROM codes
      WHERE status IN ('need_manual_check', 'no_actress_found', 'page_ok_play_unknown', 'network_error')
      ORDER BY id DESC LIMIT ?`, [limit]),
    notFound: readRows(`SELECT id, code, best_url, status, created_at FROM codes
      WHERE status = 'not_found'
      ORDER BY id DESC LIMIT ?`, [limit]),
    statusConflict: readRows(`SELECT id, code, best_url, status, created_at FROM codes
      WHERE (status = 'ok' AND TRIM(COALESCE(best_url, '')) = '')
         OR (status = 'not_found' AND TRIM(COALESCE(best_url, '')) <> '')
      ORDER BY id DESC LIMIT ?`, [limit]),
    orphanActresses: readRows(`SELECT a.id, a.tag_name, COUNT(acm.code_id) AS code_count
      FROM actress_tags a
      LEFT JOIN actress_code_map acm ON acm.actress_id = a.id
      GROUP BY a.id
      HAVING COUNT(acm.code_id) = 0
      ORDER BY a.id DESC LIMIT ?`, [limit]),
    orphanGenres: readRows(`SELECT g.id, g.name, COUNT(cg.code_id) AS code_count
      FROM genre_tags g
      LEFT JOIN code_genres cg ON cg.genre_id = g.id
      GROUP BY g.id
      HAVING COUNT(cg.code_id) = 0
      ORDER BY g.id DESC LIMIT ?`, [limit]),
    brokenActressLinks: readRows(`SELECT acm.actress_id, acm.code_id
      FROM actress_code_map acm
      LEFT JOIN actress_tags a ON a.id = acm.actress_id
      LEFT JOIN codes c ON c.id = acm.code_id
      WHERE a.id IS NULL OR c.id IS NULL
      ORDER BY acm.actress_id DESC, acm.code_id DESC LIMIT ?`, [limit]),
    brokenGenreLinks: readRows(`SELECT cg.code_id, cg.genre_id
      FROM code_genres cg
      LEFT JOIN genre_tags g ON g.id = cg.genre_id
      LEFT JOIN codes c ON c.id = cg.code_id
      WHERE g.id IS NULL OR c.id IS NULL
      ORDER BY cg.code_id DESC, cg.genre_id DESC LIMIT ?`, [limit]),
    orphanProcessingTasks: readRows(`SELECT t.id, t.run_id, t.run_item_id, t.service, t.action, t.status
      FROM processing_item_tasks t
      LEFT JOIN processing_runs r ON r.id = t.run_id
      LEFT JOIN processing_run_items i ON i.id = t.run_item_id
      WHERE r.id IS NULL OR i.id IS NULL OR i.run_id <> t.run_id
      ORDER BY t.id DESC LIMIT ?`, [limit]),
    duplicates: duplicateGroups.slice(0, limit),
  };

  const summary = {
    noUrl: countQuery(`SELECT COUNT(*) FROM codes WHERE TRIM(COALESCE(best_url, '')) = ''`),
    badUrl: countQuery(`SELECT COUNT(*) FROM codes WHERE TRIM(COALESCE(best_url, '')) <> '' AND best_url NOT LIKE 'http://%' AND best_url NOT LIKE 'https://%'`),
    noActress: countQuery(`SELECT COUNT(*) FROM (SELECT c.id FROM codes c LEFT JOIN actress_code_map acm ON acm.code_id = c.id GROUP BY c.id HAVING COUNT(acm.actress_id) = 0)`),
    noGenre: countQuery(`SELECT COUNT(*) FROM (SELECT c.id FROM codes c LEFT JOIN code_genres cg ON cg.code_id = c.id GROUP BY c.id HAVING COUNT(cg.genre_id) = 0)`),
    manualStatus: countQuery(`SELECT COUNT(*) FROM codes WHERE status IN ('need_manual_check', 'no_actress_found', 'page_ok_play_unknown', 'network_error')`),
    notFound: countQuery(`SELECT COUNT(*) FROM codes WHERE status = 'not_found'`),
    statusConflict: countQuery(`SELECT COUNT(*) FROM codes WHERE (status = 'ok' AND TRIM(COALESCE(best_url, '')) = '') OR (status = 'not_found' AND TRIM(COALESCE(best_url, '')) <> '')`),
    orphanActresses: countQuery(`SELECT COUNT(*) FROM (SELECT a.id FROM actress_tags a LEFT JOIN actress_code_map acm ON acm.actress_id = a.id GROUP BY a.id HAVING COUNT(acm.code_id) = 0)`),
    orphanGenres: countQuery(`SELECT COUNT(*) FROM (SELECT g.id FROM genre_tags g LEFT JOIN code_genres cg ON cg.genre_id = g.id GROUP BY g.id HAVING COUNT(cg.code_id) = 0)`),
    brokenActressLinks: countQuery(`SELECT COUNT(*) FROM actress_code_map acm LEFT JOIN actress_tags a ON a.id = acm.actress_id LEFT JOIN codes c ON c.id = acm.code_id WHERE a.id IS NULL OR c.id IS NULL`),
    brokenGenreLinks: countQuery(`SELECT COUNT(*) FROM code_genres cg LEFT JOIN genre_tags g ON g.id = cg.genre_id LEFT JOIN codes c ON c.id = cg.code_id WHERE g.id IS NULL OR c.id IS NULL`),
    orphanProcessingTasks: countQuery(`SELECT COUNT(*) FROM processing_item_tasks t
      LEFT JOIN processing_runs r ON r.id = t.run_id
      LEFT JOIN processing_run_items i ON i.id = t.run_item_id
      WHERE r.id IS NULL OR i.id IS NULL OR i.run_id <> t.run_id`),
    duplicateGroups: duplicateGroups.length,
    duplicateItems: duplicateGroups.reduce((sum, group) => sum + group.items.length, 0),
  };

  return {
    generatedAt: new Date().toISOString(),
    limit,
    stats: getStats(),
    summary,
    issues,
  };
}

function cleanupOrphanTags(kind = 'all') {
  const mode = String(kind || 'all');
  let actressDeleted = 0;
  let genreDeleted = 0;

  if (mode === 'all' || mode === 'actress') {
    actressDeleted = countQuery(`SELECT COUNT(*) FROM actress_tags a WHERE NOT EXISTS (SELECT 1 FROM actress_code_map acm WHERE acm.actress_id = a.id)`);
    runSQL(`DELETE FROM actress_tags WHERE id IN (
      SELECT a.id FROM actress_tags a
      LEFT JOIN actress_code_map acm ON acm.actress_id = a.id
      GROUP BY a.id
      HAVING COUNT(acm.code_id) = 0
    )`);
  }

  if (mode === 'all' || mode === 'genre') {
    genreDeleted = countQuery(`SELECT COUNT(*) FROM genre_tags g WHERE NOT EXISTS (SELECT 1 FROM code_genres cg WHERE cg.genre_id = g.id)`);
    runSQL(`DELETE FROM genre_tags WHERE id IN (
      SELECT g.id FROM genre_tags g
      LEFT JOIN code_genres cg ON cg.genre_id = g.id
      GROUP BY g.id
      HAVING COUNT(cg.code_id) = 0
    )`);
  }

  save();
  return { actressDeleted, genreDeleted };
}

function cleanupBrokenRelations() {
  const actressDeleted = countQuery(`SELECT COUNT(*) FROM actress_code_map acm LEFT JOIN actress_tags a ON a.id = acm.actress_id LEFT JOIN codes c ON c.id = acm.code_id WHERE a.id IS NULL OR c.id IS NULL`);
  const genreDeleted = countQuery(`SELECT COUNT(*) FROM code_genres cg LEFT JOIN genre_tags g ON g.id = cg.genre_id LEFT JOIN codes c ON c.id = cg.code_id WHERE g.id IS NULL OR c.id IS NULL`);
  runSQL(`DELETE FROM actress_code_map WHERE actress_id NOT IN (SELECT id FROM actress_tags) OR code_id NOT IN (SELECT id FROM codes)`);
  runSQL(`DELETE FROM code_genres WHERE genre_id NOT IN (SELECT id FROM genre_tags) OR code_id NOT IN (SELECT id FROM codes)`);
  save();
  return { actressDeleted, genreDeleted };
}
const PROCESSING_RUN_STATUSES = new Set(['running', 'paused', 'completed', 'failed']);
const PROCESSING_ITEM_STATUSES = new Set(['queued', 'running', 'completed', 'skipped', 'duplicate']);
const PROCESSING_TASK_STATUSES = new Set(['queued', 'running', 'succeeded', 'ready', 'not_found', 'network_error', 'manual', 'not_logged_in', 'blocked', 'skipped', 'failed', 'verify_required']);
const PROCESSING_TASK_DONE_STATUSES = new Set(['succeeded', 'not_found', 'skipped']);
const PROCESSING_TASK_EXCEPTION_STATUSES = new Set(['network_error', 'manual', 'not_logged_in', 'failed', 'verify_required']);
const PIPELINE_TASK_DEFINITIONS = [
  { key: 'missavLookup', service: 'missav', action: 'lookup' },
  { key: 'raindropSync', service: 'raindrop', action: 'sync' },
  { key: 'av123Lookup', service: '123av', action: 'lookup' },
  { key: 'av123Favorite', service: '123av', action: 'favorite' },
];

function jsonList(value) {
  const list = Array.isArray(value) ? value : [];
  return JSON.stringify([...new Set(list.map(item => String(item || '').trim()).filter(Boolean))]);
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function jsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  try { return JSON.stringify(value); } catch { return '{}'; }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pipelineTaskDefinition(service, action) {
  return PIPELINE_TASK_DEFINITIONS.find(item => item.service === String(service || '') && item.action === String(action || '')) || null;
}

function initialMissavTaskStatus(item) {
  if (item.item_status === 'duplicate' || item.result_status === 'duplicate_in_input') return 'skipped';
  if (item.item_status === 'queued' || item.item_status === 'running') return item.item_status;
  if (item.result_status === 'already_exists') return 'succeeded';
  if (item.result_status === 'not_found') return 'not_found';
  if (item.result_status === 'network_error') return 'network_error';
  if (['need_manual_check', 'page_ok_play_unknown'].includes(item.result_status)) return 'manual';
  if (['ok', 'no_actress_found'].includes(item.result_status)) return 'succeeded';
  return item.item_status === 'skipped' ? 'skipped' : 'failed';
}

function initialRaindropTaskStatus(item) {
  if (item.item_status === 'duplicate' || item.result_status === 'duplicate_in_input') return 'skipped';
  if (item.result_status === 'already_exists') return 'skipped';
  if (item.result_status === 'not_found') return 'skipped';
  if (item.include_in_import && ['ok', 'no_actress_found', 'need_manual_check', 'page_ok_play_unknown'].includes(item.result_status)) return 'ready';
  return 'blocked';
}

function insertProcessingTaskNoSave(runId, itemId, service, action, status, values = {}) {
  const definition = pipelineTaskDefinition(service, action);
  if (!definition) throw new Error('不支持的处理任务');
  const nextStatus = PROCESSING_TASK_STATUSES.has(status) ? status : 'queued';
  const isFinished = PROCESSING_TASK_DONE_STATUSES.has(nextStatus) || PROCESSING_TASK_EXCEPTION_STATUSES.has(nextStatus);
  runSQL(`INSERT OR IGNORE INTO processing_item_tasks (
    run_id, run_item_id, service, action, status, url, error, metadata_json, attempt_count,
    started_at, finished_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`, [
    Number(runId),
    Number(itemId),
    definition.service,
    definition.action,
    nextStatus,
    String(values.url || '').trim(),
    String(values.error || '').trim(),
    jsonObject(values.metadata),
    normalizeCounter(values.attemptCount),
    nextStatus === 'running' ? String(values.startedAt || '').trim() || null : null,
    isFinished
      ? String(values.finishedAt || '').trim() || null
      : null,
  ]);
  if (isFinished && !String(values.finishedAt || '').trim()) {
    runSQL(`UPDATE processing_item_tasks SET finished_at = COALESCE(finished_at, datetime('now','localtime'))
      WHERE run_item_id = ? AND service = ? AND action = ?`, [Number(itemId), definition.service, definition.action]);
  }
}

function normalizeProcessingToolKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return ['missav', 'av123', 'dual'].includes(kind) ? kind : 'dual';
}

function initializeDualPipelineTasks(runId) {
  const run = queryOne(`SELECT id, pipeline_version, tool_kind FROM processing_runs WHERE id = ?`, [Number(runId)]);
  if (!run || normalizeCounter(run.pipeline_version) < 2) return 0;
  const toolKind = normalizeProcessingToolKind(run.tool_kind);
  const items = readRows(`SELECT * FROM processing_run_items WHERE run_id = ? ORDER BY position`, [Number(runId)]);
  for (const item of items) {
    const duplicate = item.item_status === 'duplicate' || item.result_status === 'duplicate_in_input';
    const missavStatus = toolKind === 'av123' ? 'skipped' : initialMissavTaskStatus(item);
    const raindropStatus = toolKind === 'av123' ? 'skipped' : initialRaindropTaskStatus(item);
    const av123Status = toolKind === 'missav' || duplicate ? 'skipped' : 'queued';
    const favoriteStatus = toolKind === 'missav' || duplicate ? 'skipped' : 'blocked';
    insertProcessingTaskNoSave(run.id, item.id, 'missav', 'lookup', missavStatus, {
      url: item.url,
      error: item.error,
      attemptCount: item.attempt_count,
      metadata: item.result_status === 'already_exists' ? { source: 'permanent_history' } : {},
    });
    insertProcessingTaskNoSave(run.id, item.id, 'raindrop', 'sync', raindropStatus);
    insertProcessingTaskNoSave(run.id, item.id, '123av', 'lookup', av123Status);
    insertProcessingTaskNoSave(run.id, item.id, '123av', 'favorite', favoriteStatus);
  }
  return items.length * PIPELINE_TASK_DEFINITIONS.length;
}

function inferProcessingItemStatus(item = {}) {
  const explicit = String(item.itemStatus || item.item_status || '').trim();
  if (PROCESSING_ITEM_STATUSES.has(explicit)) return explicit;
  const resultStatus = String(item.status || item.result_status || '').trim();
  if (resultStatus === 'already_exists') return 'skipped';
  if (resultStatus === 'duplicate_in_input') return 'duplicate';
  return resultStatus && resultStatus !== 'queued' && resultStatus !== 'running' ? 'completed' : 'queued';
}

function insertProcessingRunItem(runId, position, item = {}) {
  const code = normalizeCode(item.code) || String(item.code || '').trim().toUpperCase();
  if (!code) throw new Error('批次明细番号不能为空');
  const itemStatus = inferProcessingItemStatus(item);
  const resultStatus = ['queued', 'running'].includes(itemStatus) ? '' : String(item.status || item.result_status || '').trim();
  const found = findCode(code);
  runSQL(`INSERT INTO processing_run_items (
    run_id, position, code_id, code, item_status, result_status, url,
    actresses_json, genres_json, final_tags_json, include_in_import,
    skipped_reason, error, attempt_count, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    runId,
    position,
    found.found ? found.code_id : null,
    code,
    itemStatus,
    resultStatus,
    String(item.url || '').trim(),
    jsonList(item.actresses),
    jsonList(item.genres),
    jsonList(item.finalTags || item.final_tags),
    item.includeInImport ? 1 : 0,
    String(item.skippedReason || item.skipped_reason || '').trim(),
    String(item.error || '').trim(),
    normalizeCounter(item.attemptCount || item.attempt_count),
    itemStatus === 'running' ? String(item.started_at || '').trim() || null : null,
    ['completed', 'skipped', 'duplicate'].includes(itemStatus) ? String(item.finished_at || '').trim() || null : null,
  ]);
}

function recalculateProcessingRun(runId, fallbackStats = null) {
  const id = Number(runId);
  if (!id) throw new Error('批次 ID 无效');
  const run = queryOne(`SELECT * FROM processing_runs WHERE id = ?`, [id]);
  if (!run) throw new Error('处理批次不存在');
  const itemCount = countQuery(`SELECT COUNT(*) FROM processing_run_items WHERE run_id = ?`, [id]);
  const stats = fallbackStats || {};
  const total = itemCount || normalizeCounter(stats.total ?? run.total_codes);
  const skipped = itemCount
    ? countQuery(`SELECT COUNT(*) FROM processing_run_items WHERE run_id = ? AND item_status = 'skipped'`, [id])
    : normalizeCounter(stats.exists ?? run.skipped_codes);
  const duplicate = itemCount
    ? countQuery(`SELECT COUNT(*) FROM processing_run_items WHERE run_id = ? AND item_status = 'duplicate'`, [id])
    : normalizeCounter(stats.duplicate ?? run.duplicate_codes);
  const completed = itemCount
    ? countQuery(`SELECT COUNT(*) FROM processing_run_items WHERE run_id = ? AND item_status IN ('completed','skipped','duplicate')`, [id])
    : normalizeCounter(run.completed_codes || (run.status === 'completed' ? total : 0));
  const notFound = itemCount
    ? countQuery(`SELECT COUNT(*) FROM processing_run_items WHERE run_id = ? AND result_status = 'not_found'`, [id])
    : normalizeCounter(stats.notFound ?? run.not_found_codes);
  const networkError = itemCount
    ? countQuery(`SELECT COUNT(*) FROM processing_run_items WHERE run_id = ? AND result_status = 'network_error'`, [id])
    : normalizeCounter(run.network_error_codes);
  const manual = itemCount
    ? countQuery(`SELECT COUNT(*) FROM processing_run_items WHERE run_id = ? AND result_status IN ('need_manual_check','no_actress_found','page_ok_play_unknown')`, [id])
    : normalizeCounter(run.manual_codes);
  const newCodes = itemCount
    ? Math.max(0, total - skipped - duplicate)
    : normalizeCounter(stats.new ?? run.new_codes);
  runSQL(`UPDATE processing_runs SET total_codes = ?, new_codes = ?, skipped_codes = ?,
    not_found_codes = ?, duplicate_codes = ?, completed_codes = ?, network_error_codes = ?,
    manual_codes = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
  [total, newCodes, skipped, notFound, duplicate, completed, networkError, manual, id]);
  return { total, new: newCodes, skipped, notFound, duplicate, completed, networkError, manual, pending: Math.max(0, total - completed) };
}

function createProcessingRun(options = {}) {
  const config = options && typeof options === 'object' ? options : {};
  const stats = config.stats || {};
  const status = PROCESSING_RUN_STATUSES.has(config.status) ? config.status : 'running';
  const pipelineVersion = Math.max(1, normalizeCounter(config.pipelineVersion || config.pipeline_version || 1));
  let id = null;
  DB.run('BEGIN TRANSACTION');
  try {
    const legacySpeedMode = String(config.speedMode || config.speed_mode || '').trim();
    const missavSpeedMode = String(config.missavSpeedMode || config.missav_speed_mode || legacySpeedMode).trim();
    const av123SpeedMode = String(config.av123SpeedMode || config.av123_speed_mode || legacySpeedMode).trim();
    const requestedMissavPolicy = String(config.missavSpeedPolicy || config.missav_speed_policy || 'stable').trim();
    const missavSpeedPolicy = ['stable', 'balanced', 'fixed'].includes(requestedMissavPolicy) ? requestedMissavPolicy : 'stable';
    const requestedMissavRateMode = String(config.missavRateMode || config.missav_rate_mode || 'adaptive').trim();
    const missavRateMode = requestedMissavRateMode === 'fixed' ? 'fixed' : 'adaptive';
    const missavRateCap = Math.max(1, Math.min(32, Number(config.missavRateCap ?? config.missav_rate_cap) || 16));
    const requested123AvPolicy = String(config.av123SpeedPolicy || config.av123_speed_policy || 'staged').trim();
    const av123SpeedPolicy = ['staged', 'balanced', 'fixed'].includes(requested123AvPolicy) ? requested123AvPolicy : 'staged';
    const requested123AvRateMode = String(config.av123RateMode || config.av123_rate_mode || 'adaptive').trim();
    const av123RateMode = requested123AvRateMode === 'fixed' ? 'fixed' : 'adaptive';
    const av123RateCap = Math.max(1, Math.min(32, Number(config.av123RateCap ?? config.av123_rate_cap) || 16));
    const av123AutoFavorite = config.av123AutoFavorite === true || Number(config.av123_auto_favorite) === 1 ? 1 : 0;
    const av123FavoriteConcurrency = Math.max(1, Math.min(4, Number(config.av123FavoriteConcurrency ?? config.av123_favorite_concurrency) || 2));
    const toolKind = normalizeProcessingToolKind(config.toolKind || config.tool_kind);
    const knownActresses = Array.isArray(config.knownActresses || config.known_actresses)
      ? config.knownActresses || config.known_actresses
      : readRows(`SELECT tag_name FROM actress_tags ORDER BY id`).map(row => row.tag_name);
    runSQL(`INSERT INTO processing_runs (
      name, source_type, source_label, speed_mode, missav_speed_mode, av123_speed_mode, missav_speed_policy, missav_rate_mode, missav_rate_cap, av123_speed_policy, av123_rate_mode, av123_rate_cap, av123_auto_favorite, av123_favorite_concurrency,
      status, output_dir, pipeline_version, tool_kind, known_actresses_json, started_at,
      total_codes, new_codes, skipped_codes, not_found_codes, duplicate_codes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?, ?, ?, ?, ?, datetime('now','localtime'))`, [
      String(config.name || '').trim(),
      String(config.sourceType || config.source_type || 'manual').trim() || 'manual',
      String(config.sourceLabel || config.source_label || '').trim(),
      legacySpeedMode || missavSpeedMode,
      missavSpeedMode,
      av123SpeedMode,
      missavSpeedPolicy,
      missavRateMode,
      missavRateCap,
      av123SpeedPolicy,
      av123RateMode,
      av123RateCap,
      av123AutoFavorite,
      av123FavoriteConcurrency,
      status,
      String(config.outputDir || config.output_dir || '').trim(),
      pipelineVersion,
      toolKind,
      jsonList(knownActresses),
      normalizeCounter(stats.total),
      normalizeCounter(stats.new),
      normalizeCounter(stats.exists ?? stats.skipped),
      normalizeCounter(stats.notFound),
      normalizeCounter(stats.duplicate),
    ]);
    id = lastInsertId();
    if (!String(config.name || '').trim()) runSQL(`UPDATE processing_runs SET name = ? WHERE id = ?`, [`批次 #${id}`, id]);
    const items = Array.isArray(config.items) ? config.items : [];
    items.forEach((item, position) => insertProcessingRunItem(id, position, item));
    initializeDualPipelineTasks(id);
    recalculateProcessingRun(id, stats);
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  save();
  return id;
}

function updateProcessingTaskNoSave(runItemId, service, action, patch = {}) {
  const definition = pipelineTaskDefinition(service, action);
  if (!definition) throw new Error('不支持的处理任务');
  const existing = queryOne(`SELECT * FROM processing_item_tasks
    WHERE run_item_id = ? AND service = ? AND action = ?`, [Number(runItemId), definition.service, definition.action]);
  if (!existing) return false;
  const requestedStatus = String(patch.status || '').trim();
  const nextStatus = PROCESSING_TASK_STATUSES.has(requestedStatus) ? requestedStatus : existing.status;
  const isFinished = PROCESSING_TASK_DONE_STATUSES.has(nextStatus) || PROCESSING_TASK_EXCEPTION_STATUSES.has(nextStatus);
  const isUnstarted = ['queued', 'ready', 'blocked'].includes(nextStatus);
  const nextUrl = patch.url === undefined ? existing.url : String(patch.url || '').trim();
  const nextError = patch.error === undefined ? existing.error : String(patch.error || '').trim();
  const nextMetadata = patch.metadata === undefined ? existing.metadata_json : jsonObject(patch.metadata);
  const nextAttempts = patch.attemptCount === undefined ? normalizeCounter(existing.attempt_count) : normalizeCounter(patch.attemptCount);
  runSQL(`UPDATE processing_item_tasks SET status = ?, url = ?, error = ?, metadata_json = ?,
    attempt_count = ?,
    started_at = CASE
      WHEN ? = 'running' THEN datetime('now','localtime')
      WHEN ? THEN NULL
      ELSE started_at END,
    finished_at = CASE WHEN ? THEN datetime('now','localtime') WHEN ? THEN NULL ELSE finished_at END,
    updated_at = datetime('now','localtime') WHERE id = ?`, [
    nextStatus,
    nextUrl,
    nextError,
    nextMetadata,
    nextAttempts,
    nextStatus,
    isUnstarted ? 1 : 0,
    isFinished ? 1 : 0,
    (isUnstarted || nextStatus === 'running') ? 1 : 0,
    existing.id,
  ]);
  return true;
}

function normalizeLookupCacheService(value) {
  const service = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(service) ? service : '';
}

function siteLookupCacheIdentity(service, code) {
  const safeService = normalizeLookupCacheService(service);
  const normalized = normalizeCode(code);
  const codeKey = codeComparableKey(normalized);
  if (!safeService || !normalized || !codeKey) return null;
  return { service: safeService, code: normalized, codeKey };
}

function getSiteLookupCache(service, code) {
  const identity = siteLookupCacheIdentity(service, code);
  if (!identity) return null;
  const row = queryOne(`SELECT service, code_key, code, status, url, metadata_json, checked_at
    FROM site_lookup_cache WHERE service = ? AND code_key = ?`, [identity.service, identity.codeKey]);
  if (!row) return null;
  return {
    service: String(row.service || ''),
    codeKey: String(row.code_key || ''),
    code: String(row.code || ''),
    status: String(row.status || ''),
    url: String(row.url || ''),
    metadata: parseJsonObject(row.metadata_json),
    checkedAt: String(row.checked_at || ''),
  };
}

function upsertSiteLookupCacheNoSave(entry = {}) {
  const identity = siteLookupCacheIdentity(entry.service, entry.code);
  const status = String(entry.status || '').trim();
  if (!identity || !['succeeded', 'not_found'].includes(status)) return false;
  runSQL(`INSERT INTO site_lookup_cache
    (service, code_key, code, status, url, metadata_json, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(service, code_key) DO UPDATE SET
      code = excluded.code,
      status = excluded.status,
      url = excluded.url,
      metadata_json = excluded.metadata_json,
      checked_at = excluded.checked_at`, [
    identity.service,
    identity.codeKey,
    identity.code,
    status,
    String(entry.url || '').trim(),
    jsonObject(entry.metadata),
  ]);
  return true;
}

function upsertSiteLookupCache(entry = {}) {
  const changed = upsertSiteLookupCacheNoSave(entry);
  if (changed) save();
  return changed ? getSiteLookupCache(entry.service, entry.code) : null;
}

function getRemoteSyncRecord(service, code) {
  const identity = siteLookupCacheIdentity(service, code);
  if (!identity) return null;
  const row = queryOne(`SELECT service, code_key, code, remote_id, link, collection_id,
    payload_hash, status, metadata_json, synced_at, updated_at
    FROM remote_sync_records WHERE service = ? AND code_key = ?`, [identity.service, identity.codeKey]);
  if (!row) return null;
  return {
    service: String(row.service || ''),
    codeKey: String(row.code_key || ''),
    code: String(row.code || ''),
    remoteId: String(row.remote_id || ''),
    link: String(row.link || ''),
    collectionId: Number(row.collection_id),
    payloadHash: String(row.payload_hash || ''),
    status: String(row.status || ''),
    metadata: parseJsonObject(row.metadata_json),
    syncedAt: String(row.synced_at || ''),
    updatedAt: String(row.updated_at || ''),
  };
}

function upsertRemoteSyncRecordNoSave(entry = {}) {
  const identity = siteLookupCacheIdentity(entry.service, entry.code);
  if (!identity) throw new Error('远端同步记录缺少有效的服务或番号');
  const remoteId = String(entry.remoteId || '').trim();
  const link = String(entry.link || '').trim();
  const payloadHash = String(entry.payloadHash || '').trim();
  const status = String(entry.status || 'succeeded').trim() || 'succeeded';
  const collectionId = Number.isSafeInteger(Number(entry.collectionId)) ? Number(entry.collectionId) : -1;
  runSQL(`INSERT INTO remote_sync_records
    (service, code_key, code, remote_id, link, collection_id, payload_hash, status, metadata_json, synced_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(service, code_key) DO UPDATE SET
      code = excluded.code,
      remote_id = excluded.remote_id,
      link = excluded.link,
      collection_id = excluded.collection_id,
      payload_hash = excluded.payload_hash,
      status = excluded.status,
      metadata_json = excluded.metadata_json,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at`, [
    identity.service,
    identity.codeKey,
    identity.code,
    remoteId,
    link,
    collectionId,
    payloadHash,
    status,
    jsonObject(entry.metadata),
  ]);
  return true;
}

function completeRemoteSyncTask(runId, position, patch = {}, record = null) {
  const item = queryOne(`SELECT id FROM processing_run_items WHERE run_id = ? AND position = ?`, [Number(runId), Number(position)]);
  if (!item) throw new Error('批次明细不存在');
  DB.run('BEGIN TRANSACTION');
  try {
    if (!updateProcessingTaskNoSave(item.id, 'raindrop', 'sync', patch)) throw new Error('该批次没有 Raindrop 同步任务');
    if (record) upsertRemoteSyncRecordNoSave({ ...record, service: 'raindrop' });
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  if (patch.persist !== false) save();
  return getProcessingRunItem(runId, position);
}

function telegramSourceSummary(row) {
  if (!row) return null;
  return {
    id: Number(row.id || 0),
    sourceKey: String(row.source_key || ''),
    sourceType: String(row.source_type || ''),
    accountKey: String(row.account_key || ''),
    accountLabel: String(row.account_label || ''),
    sourceLabel: String(row.source_label || ''),
    chatKey: String(row.chat_key || ''),
    chatType: String(row.chat_type || ''),
    isSelected: Boolean(row.is_selected),
    baselineMessageId: Number(row.baseline_message_id || 0),
    checkpointMessageId: Number(row.checkpoint_message_id || 0),
    checkpointDate: String(row.checkpoint_date || ''),
    syncCursorMessageId: Number(row.sync_cursor_message_id || 0),
    syncTargetMessageId: Number(row.sync_target_message_id || 0),
    status: String(row.status || 'idle'),
    lastError: String(row.last_error || ''),
    lastSyncAt: String(row.last_sync_at || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  };
}

function getTelegramSource(sourceKey) {
  const key = String(sourceKey || '').trim();
  if (!key) return null;
  return telegramSourceSummary(queryOne(`SELECT * FROM telegram_sources WHERE source_key = ?`, [key]));
}

function upsertTelegramSourceNoSave(options = {}) {
  const sourceKey = String(options.sourceKey || options.source_key || '').trim().slice(0, 260);
  if (!sourceKey) throw new Error('Telegram 来源缺少 sourceKey');
  const sourceType = String(options.sourceType || options.source_type || 'export').trim().slice(0, 32) || 'export';
  const checkpointMessageId = Math.max(0, Number(options.checkpointMessageId ?? options.checkpoint_message_id) || 0);
  const syncCursorMessageId = Math.max(0, Number(options.syncCursorMessageId ?? options.sync_cursor_message_id) || 0);
  const syncTargetMessageId = Math.max(0, Number(options.syncTargetMessageId ?? options.sync_target_message_id) || 0);
  const existing = queryOne(`SELECT * FROM telegram_sources WHERE source_key = ?`, [sourceKey]);
  const sourceLabel = options.sourceLabel !== undefined || options.source_label !== undefined
    ? String(options.sourceLabel ?? options.source_label ?? '').trim().slice(0, 260)
    : String(existing?.source_label || '');
  const chatKey = options.chatKey !== undefined || options.chat_key !== undefined
    ? String(options.chatKey ?? options.chat_key ?? '').trim().slice(0, 128)
    : String(existing?.chat_key || '');
  const chatType = options.chatType !== undefined || options.chat_type !== undefined
    ? String(options.chatType ?? options.chat_type ?? '').trim().slice(0, 32)
    : String(existing?.chat_type || '');
  const isSelected = options.isSelected !== undefined || options.is_selected !== undefined
    ? Number(Boolean(options.isSelected ?? options.is_selected))
    : Number(Boolean(existing?.is_selected));
  const baselineMessageId = options.baselineMessageId !== undefined || options.baseline_message_id !== undefined
    ? Math.max(0, Number(options.baselineMessageId ?? options.baseline_message_id) || 0)
    : Math.max(0, Number(existing?.baseline_message_id) || 0);
  runSQL(`INSERT INTO telegram_sources
    (source_key, source_type, account_key, account_label, source_label, chat_key, chat_type,
     is_selected, baseline_message_id, checkpoint_message_id, checkpoint_date,
     sync_cursor_message_id, sync_target_message_id, status, last_error, last_sync_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(source_key) DO UPDATE SET
      source_type = excluded.source_type,
      account_key = CASE WHEN excluded.account_key <> '' THEN excluded.account_key ELSE telegram_sources.account_key END,
      account_label = CASE WHEN excluded.account_label <> '' THEN excluded.account_label ELSE telegram_sources.account_label END,
      source_label = CASE WHEN excluded.source_label <> '' THEN excluded.source_label ELSE telegram_sources.source_label END,
      chat_key = CASE WHEN excluded.chat_key <> '' THEN excluded.chat_key ELSE telegram_sources.chat_key END,
      chat_type = CASE WHEN excluded.chat_type <> '' THEN excluded.chat_type ELSE telegram_sources.chat_type END,
      is_selected = excluded.is_selected,
      baseline_message_id = CASE
        WHEN telegram_sources.baseline_message_id > 0 THEN telegram_sources.baseline_message_id
        ELSE excluded.baseline_message_id END,
      checkpoint_message_id = MAX(telegram_sources.checkpoint_message_id, excluded.checkpoint_message_id),
      checkpoint_date = CASE WHEN excluded.checkpoint_date <> '' THEN excluded.checkpoint_date ELSE telegram_sources.checkpoint_date END,
      sync_cursor_message_id = excluded.sync_cursor_message_id,
      sync_target_message_id = excluded.sync_target_message_id,
      status = excluded.status,
      last_error = excluded.last_error,
      last_sync_at = excluded.last_sync_at,
      updated_at = excluded.updated_at`, [
    sourceKey,
    sourceType,
    String(options.accountKey || options.account_key || '').trim().slice(0, 128),
    String(options.accountLabel || options.account_label || '').trim().slice(0, 260),
    sourceLabel,
    chatKey,
    chatType,
    isSelected,
    baselineMessageId,
    checkpointMessageId,
    String(options.checkpointDate || options.checkpoint_date || '').trim().slice(0, 64),
    syncCursorMessageId,
    syncTargetMessageId,
    String(options.status || 'idle').trim().slice(0, 32) || 'idle',
    String(options.lastError || options.last_error || '').trim().slice(0, 1000),
    String(options.lastSyncAt || options.last_sync_at || '').trim().slice(0, 64) || null,
  ]);
  return queryOne(`SELECT * FROM telegram_sources WHERE source_key = ?`, [sourceKey]);
}

function upsertTelegramSource(options = {}) {
  const row = upsertTelegramSourceNoSave(options);
  save();
  return telegramSourceSummary(row);
}

function normalizeTelegramGroupSourceType(value) {
  return String(value || '') === 'bot_group' ? 'bot_group' : 'api_group';
}

function telegramGroupSourceKey(accountKey, chatKey, sourceType = 'api_group') {
  const prefix = normalizeTelegramGroupSourceType(sourceType) === 'bot_group' ? 'telegram-bot' : 'telegram-api';
  return `${prefix}:${String(accountKey || '').trim()}:group:${String(chatKey || '').trim()}`;
}

function getTelegramGroupSources(accountKey, selectedOnly = true, sourceType = 'api_group') {
  const key = String(accountKey || '').trim();
  if (!key) return [];
  const normalizedSourceType = normalizeTelegramGroupSourceType(sourceType);
  const rows = readRows(`SELECT * FROM telegram_sources
    WHERE account_key = ? AND source_type = ?
      ${selectedOnly === false ? '' : 'AND is_selected = 1'}
    ORDER BY is_selected DESC, source_label COLLATE NOCASE, id`, [key, normalizedSourceType]);
  return rows.map(telegramSourceSummary);
}

function setTelegramGroupSources(options = {}) {
  const accountKey = String(options.accountKey || '').trim().slice(0, 128);
  const accountLabel = String(options.accountLabel || '').trim().slice(0, 260);
  const sourceType = normalizeTelegramGroupSourceType(options.sourceType);
  if (!accountKey) throw new Error('请先连接 Telegram 账号');
  const unique = new Map();
  for (const group of Array.isArray(options.groups) ? options.groups : []) {
    const chatKey = String(group?.chatKey || '').trim().slice(0, 128);
    if (!chatKey || unique.has(chatKey)) continue;
    unique.set(chatKey, {
      chatKey,
      title: String(group?.title || `Telegram ${chatKey}`).trim().slice(0, 260),
      chatType: String(group?.chatType || 'group').trim().slice(0, 32),
      latestMessageId: Math.max(0, Number(group?.latestMessageId) || 0),
      latestMessageDate: String(group?.latestMessageDate || '').trim().slice(0, 64),
    });
  }
  const groups = [...unique.values()];
  if (groups.length > 5) throw new Error('Telegram 增量来源最多只能选择 5 个群组');

  DB.run('BEGIN TRANSACTION');
  try {
    runSQL(`UPDATE telegram_sources SET is_selected = 0, updated_at = datetime('now','localtime')
      WHERE account_key = ? AND source_type = ?`, [accountKey, sourceType]);
    for (const group of groups) {
      const sourceKey = telegramGroupSourceKey(accountKey, group.chatKey, sourceType);
      const existing = queryOne(`SELECT * FROM telegram_sources WHERE source_key = ?`, [sourceKey]);
      const baselineMessageId = existing
        ? Math.max(0, Number(existing.baseline_message_id) || 0)
        : group.latestMessageId;
      const checkpointMessageId = existing
        ? Math.max(0, Number(existing.checkpoint_message_id) || 0)
        : group.latestMessageId;
      upsertTelegramSourceNoSave({
        sourceKey,
        sourceType,
        accountKey,
        accountLabel,
        sourceLabel: group.title,
        chatKey: group.chatKey,
        chatType: group.chatType,
        isSelected: true,
        baselineMessageId,
        checkpointMessageId,
        checkpointDate: existing?.checkpoint_date || group.latestMessageDate,
        syncCursorMessageId: Number(existing?.sync_cursor_message_id || 0),
        syncTargetMessageId: Number(existing?.sync_target_message_id || 0),
        status: existing?.status || 'ready',
        lastError: existing?.last_error || '',
        lastSyncAt: existing?.last_sync_at || '',
      });
    }
    DB.run('COMMIT');
  } catch (error) {
    try { DB.run('ROLLBACK'); } catch {}
    throw error;
  }
  save();
  return getTelegramGroupSources(accountKey, true, sourceType);
}

function recordTelegramImport(options = {}) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const errors = Array.isArray(options.errors) ? options.errors : [];
  const sourceType = String(options.sourceType || 'export').trim().slice(0, 32) || 'export';
  const sourceLabel = String(options.sourceLabel || '').trim().slice(0, 260);
  const checkpointComplete = options.checkpointComplete !== false;
  const sourceStatus = errors.length ? 'warning' : checkpointComplete ? 'ready' : 'partial';
  const allCodes = new Set();
  const acceptedCodes = new Set();
  let newMessages = 0;
  let duplicateMessages = 0;
  let updatedMessages = 0;
  let importRunId = 0;
  let sourceRow = null;
  DB.run('BEGIN TRANSACTION');
  try {
    sourceRow = upsertTelegramSourceNoSave({
      ...options,
      sourceType,
      status: sourceStatus,
      lastError: errors.map(error => String(error?.error || error || '')).filter(Boolean).join('; ').slice(0, 1000),
      lastSyncAt: new Date().toISOString(),
    });
    for (const message of messages) {
      const dedupeKey = String(message?.dedupeKey || '').trim().slice(0, 300);
      const contentHash = String(message?.contentHash || '').trim().slice(0, 128);
      if (!dedupeKey || !contentHash) continue;
      const codes = Array.isArray(message.codes) ? message.codes.map(code => String(code || '').trim()).filter(Boolean) : [];
      codes.forEach(code => allCodes.add(code));
      const existing = queryOne(`SELECT * FROM telegram_message_refs
        WHERE dedupe_key = ? OR content_hash = ?
        ORDER BY CASE WHEN dedupe_key = ? THEN 0 ELSE 1 END, id LIMIT 1`, [dedupeKey, contentHash, dedupeKey]);
      if (!existing) {
        runSQL(`INSERT INTO telegram_message_refs
          (source_id, dedupe_key, source_type, source_label, account_key, chat_key, message_id, message_date, edited_at, content_hash, codes_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          sourceRow.id,
          dedupeKey,
          String(message.sourceType || sourceType).slice(0, 32),
          String(message.sourceLabel || sourceLabel).slice(0, 260),
          String(message.accountKey || '').slice(0, 128),
          String(message.chatKey || 'telegram_export').slice(0, 128),
          String(message.messageId || '').slice(0, 128),
          String(message.messageDate || '').slice(0, 64),
          String(message.editedAt || '').slice(0, 64),
          contentHash,
          jsonList(codes),
        ]);
        codes.forEach(code => acceptedCodes.add(code));
        newMessages++;
        continue;
      }
      if (String(existing.content_hash || '') === contentHash) duplicateMessages++;
      else {
        codes.forEach(code => acceptedCodes.add(code));
        updatedMessages++;
      }
      const preferredDedupeKey = String(message.accountKey || '').trim() && String(message.messageId || '').trim()
        ? dedupeKey
        : String(existing.dedupe_key || dedupeKey);
      runSQL(`UPDATE telegram_message_refs SET
        source_id = ?, dedupe_key = ?, source_type = ?, source_label = ?,
        account_key = CASE WHEN ? <> '' THEN ? ELSE account_key END,
        chat_key = ?, message_id = CASE WHEN ? <> '' THEN ? ELSE message_id END,
        message_date = CASE WHEN ? <> '' THEN ? ELSE message_date END,
        edited_at = CASE WHEN ? <> '' THEN ? ELSE edited_at END,
        content_hash = ?, codes_json = ?, last_seen_at = datetime('now','localtime')
        WHERE id = ?`, [
        sourceRow.id,
        preferredDedupeKey,
        String(message.sourceType || sourceType).slice(0, 32),
        String(message.sourceLabel || sourceLabel).slice(0, 260),
        String(message.accountKey || '').slice(0, 128),
        String(message.accountKey || '').slice(0, 128),
        String(message.chatKey || 'telegram_export').slice(0, 128),
        String(message.messageId || '').slice(0, 128),
        String(message.messageId || '').slice(0, 128),
        String(message.messageDate || '').slice(0, 64),
        String(message.messageDate || '').slice(0, 64),
        String(message.editedAt || '').slice(0, 64),
        String(message.editedAt || '').slice(0, 64),
        contentHash,
        jsonList(codes),
        existing.id,
      ]);
    }
    const numericIds = messages
      .map(message => Number(message?.messageId))
      .filter(value => Number.isSafeInteger(value) && value > 0);
    const checkpointMessageId = checkpointComplete
      ? Math.max(
        Number(sourceRow.checkpoint_message_id || 0),
        Number(options.checkpointMessageId || 0),
        numericIds.length ? Math.max(...numericIds) : 0,
      )
      : Math.max(Number(sourceRow.checkpoint_message_id || 0), Number(options.checkpointMessageId || 0));
    const checkpointDate = checkpointComplete
      ? String(options.checkpointDate || messages[0]?.messageDate || '').slice(0, 64)
      : String(sourceRow.checkpoint_date || '').slice(0, 64);
    runSQL(`UPDATE telegram_sources SET checkpoint_message_id = ?, checkpoint_date = ?,
      sync_cursor_message_id = ?, sync_target_message_id = ?,
      status = ?, last_error = ?, last_sync_at = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [
      checkpointMessageId,
      checkpointDate,
      checkpointComplete ? 0 : Math.max(0, Number(options.syncCursorMessageId) || 0),
      checkpointComplete ? 0 : Math.max(0, Number(options.syncTargetMessageId) || 0),
      sourceStatus,
      errors.map(error => String(error?.error || error || '')).filter(Boolean).join('; ').slice(0, 1000),
      new Date().toISOString(),
      sourceRow.id,
    ]);
    runSQL(`INSERT INTO telegram_import_runs
      (source_id, source_type, source_label, status, message_count, new_message_count,
       duplicate_message_count, updated_message_count, code_count, error_count, errors_json, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`, [
      sourceRow.id,
      sourceType,
      sourceLabel,
      errors.length ? 'warning' : checkpointComplete ? 'completed' : 'partial',
      messages.length,
      newMessages,
      duplicateMessages,
      updatedMessages,
      acceptedCodes.size,
      errors.length,
      JSON.stringify(errors.slice(0, 100)),
    ]);
    importRunId = lastInsertId();
    DB.run('COMMIT');
  } catch (error) {
    try { DB.run('ROLLBACK'); } catch {}
    throw error;
  }
  save();
  return {
    importRunId,
    source: getTelegramSource(options.sourceKey),
    messageCount: messages.length,
    newMessageCount: newMessages,
    duplicateMessageCount: duplicateMessages,
    updatedMessageCount: updatedMessages,
    codeCount: acceptedCodes.size,
    codes: [...acceptedCodes],
    observedCodeCount: allCodes.size,
    observedCodes: [...allCodes],
    errorCount: errors.length,
    checkpointComplete,
  };
}

function getTelegramImportHistory(limit = 50) {
  return readRows(`SELECT r.*, s.source_key, s.account_label
    FROM telegram_import_runs r
    LEFT JOIN telegram_sources s ON s.id = r.source_id
    ORDER BY r.id DESC LIMIT ?`, [Math.max(1, Math.min(500, Number(limit) || 50))]).map(row => ({
    id: Number(row.id || 0),
    sourceKey: String(row.source_key || ''),
    sourceType: String(row.source_type || ''),
    sourceLabel: String(row.source_label || ''),
    accountLabel: String(row.account_label || ''),
    status: String(row.status || ''),
    messageCount: Number(row.message_count || 0),
    newMessageCount: Number(row.new_message_count || 0),
    duplicateMessageCount: Number(row.duplicate_message_count || 0),
    updatedMessageCount: Number(row.updated_message_count || 0),
    codeCount: Number(row.code_count || 0),
    errorCount: Number(row.error_count || 0),
    errors: (() => {
      try {
        const parsed = JSON.parse(String(row.errors_json || '[]'));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
    startedAt: String(row.started_at || ''),
    finishedAt: String(row.finished_at || ''),
  }));
}

function persistProcessingItemTask(runId, position, service, action, patch = {}, cacheEntry = null) {
  const item = queryOne(`SELECT id FROM processing_run_items WHERE run_id = ? AND position = ?`, [Number(runId), Number(position)]);
  if (!item) throw new Error('批次明细不存在');
  DB.run('BEGIN TRANSACTION');
  try {
    if (!updateProcessingTaskNoSave(item.id, service, action, patch)) throw new Error('该批次没有对应的处理任务');
    updateDependentTaskAfterLookupNoSave(item.id, service, action, patch.status);
    if (cacheEntry) upsertSiteLookupCacheNoSave(cacheEntry);
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  if (patch.persist !== false) save();
  return getProcessingRunItem(runId, position);
}

function updateProcessingItemTask(runId, position, service, action, patch = {}) {
  return persistProcessingItemTask(runId, position, service, action, patch);
}

function completeProcessingItemTaskWithCache(runId, position, service, action, patch = {}, cacheEntry = null) {
  return persistProcessingItemTask(runId, position, service, action, patch, cacheEntry);
}

function updateDependentTaskAfterLookupNoSave(runItemId, service, action, status) {
  if (String(action || '') !== 'lookup') return;
  const nextStatus = String(status || '');
  const dependency = String(service || '') === 'missav'
    ? { service: 'raindrop', action: 'sync' }
    : String(service || '') === '123av'
      ? { service: '123av', action: 'favorite' }
      : null;
  if (!dependency) return;
  const downstream = queryOne(`SELECT status FROM processing_item_tasks
    WHERE run_item_id = ? AND service = ? AND action = ?`, [Number(runItemId), dependency.service, dependency.action]);
  if (!downstream || downstream.status === 'succeeded' || downstream.status === 'verify_required') return;
  if (nextStatus === 'succeeded') {
    updateProcessingTaskNoSave(runItemId, dependency.service, dependency.action, { status: 'ready', error: '' });
  } else if (['not_found', 'skipped'].includes(nextStatus)) {
    updateProcessingTaskNoSave(runItemId, dependency.service, dependency.action, { status: 'skipped', error: '' });
  } else if (nextStatus) {
    updateProcessingTaskNoSave(runItemId, dependency.service, dependency.action, { status: 'blocked' });
  }
}

function markProcessingRunItemRunning(runId, position, options = {}) {
  const item = queryOne(`SELECT id FROM processing_run_items WHERE run_id = ? AND position = ?`, [Number(runId), Number(position)]);
  if (!item) throw new Error('批次明细不存在');
  DB.run('BEGIN TRANSACTION');
  try {
    runSQL(`UPDATE processing_run_items SET item_status = 'running', started_at = datetime('now','localtime'),
      finished_at = NULL, updated_at = datetime('now','localtime') WHERE run_id = ? AND position = ?`,
    [Number(runId), Number(position)]);
    runSQL(`UPDATE processing_runs SET status = 'running', finished_at = NULL,
      updated_at = datetime('now','localtime') WHERE id = ?`, [Number(runId)]);
    updateProcessingTaskNoSave(item.id, 'missav', 'lookup', { status: 'running', error: '' });
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  if (options.persist !== false) save();
  return true;
}

function updateProcessingRunItem(runId, position, row = {}, itemStatus = '', options = {}) {
  const id = Number(runId);
  const pos = Number(position);
  const existing = queryOne(`SELECT id, code FROM processing_run_items WHERE run_id = ? AND position = ?`, [id, pos]);
  if (!existing) throw new Error('批次明细不存在');
  const nextStatus = PROCESSING_ITEM_STATUSES.has(itemStatus) ? itemStatus : inferProcessingItemStatus(row);
  const code = normalizeCode(row.code || existing.code) || existing.code;
  const found = findCode(code);
  const resultStatus = ['queued', 'running'].includes(nextStatus) ? '' : String(row.status || row.result_status || '').trim();
  const taskShape = {
    item_status: nextStatus,
    result_status: resultStatus,
    include_in_import: row.includeInImport ? 1 : 0,
  };
  let stats;
  DB.run('BEGIN TRANSACTION');
  try {
    runSQL(`UPDATE processing_run_items SET code_id = ?, code = ?, item_status = ?, result_status = ?,
      url = ?, actresses_json = ?, genres_json = ?, final_tags_json = ?, include_in_import = ?,
      skipped_reason = ?, error = ?, attempt_count = ?,
      started_at = CASE WHEN ? = 'queued' THEN NULL ELSE COALESCE(started_at, datetime('now','localtime')) END,
      finished_at = CASE WHEN ? IN ('completed','skipped','duplicate') THEN datetime('now','localtime') ELSE NULL END,
      updated_at = datetime('now','localtime') WHERE run_id = ? AND position = ?`, [
      found.found ? found.code_id : null,
      code,
      nextStatus,
      resultStatus,
      nextStatus === 'queued' ? '' : String(row.url || '').trim(),
      nextStatus === 'queued' ? '[]' : jsonList(row.actresses),
      nextStatus === 'queued' ? '[]' : jsonList(row.genres),
      nextStatus === 'queued' ? '[]' : jsonList(row.finalTags || row.final_tags),
      nextStatus === 'queued' ? 0 : (row.includeInImport ? 1 : 0),
      nextStatus === 'queued' ? '' : String(row.skippedReason || row.skipped_reason || '').trim(),
      nextStatus === 'queued' ? '' : String(row.error || '').trim(),
      normalizeCounter(row.attemptCount || row.attempt_count),
      nextStatus,
      nextStatus,
      id,
      pos,
    ]);
    updateProcessingTaskNoSave(existing.id, 'missav', 'lookup', {
      status: initialMissavTaskStatus(taskShape),
      url: nextStatus === 'queued' ? '' : String(row.url || '').trim(),
      error: nextStatus === 'queued' ? '' : String(row.error || '').trim(),
      attemptCount: row.attemptCount || row.attempt_count,
      metadata: { resultStatus },
    });
    updateProcessingTaskNoSave(existing.id, 'raindrop', 'sync', {
      status: initialRaindropTaskStatus(taskShape),
      error: resultStatus === 'network_error' ? '等待 MissAV 网络重试' : '',
      metadata: { missavStatus: resultStatus },
    });
    stats = recalculateProcessingRun(id);
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  if (options.persist !== false) save();
  return { ...stats, item: getProcessingRunItem(id, pos) };
}

function completeMissavProcessingRunItem(runId, position, row = {}, itemStatus = '') {
  // MissAV 永久番号/Tags 与批次结果放在同一事务中提交，再执行一次 WAL 检查点。
  // 若批次写回失败，行为与旧版一致：已抓到的永久番号信息仍可保留，批次项可安全重试。
  persistProcessedCode(row, { persist: false });
  const result = updateProcessingRunItem(runId, position, row, itemStatus, { persist: false });
  save();
  return result;
}

function setProcessingRunStatus(runId, status, fallbackStats = null) {
  const id = Number(runId);
  const nextStatus = PROCESSING_RUN_STATUSES.has(status) ? status : 'paused';
  let stats;
  DB.run('BEGIN TRANSACTION');
  try {
    if (nextStatus === 'paused') {
      runSQL(`UPDATE processing_run_items SET item_status = 'queued', started_at = NULL,
        updated_at = datetime('now','localtime') WHERE run_id = ? AND item_status = 'running'`, [id]);
      runSQL(`UPDATE processing_item_tasks SET status = 'queued', started_at = NULL, finished_at = NULL,
        updated_at = datetime('now','localtime') WHERE run_id = ? AND action = 'lookup' AND status = 'running'`, [id]);
    }
    stats = recalculateProcessingRun(id, fallbackStats);
    runSQL(`UPDATE processing_runs SET status = ?,
      finished_at = CASE WHEN ? IN ('completed','failed') THEN datetime('now','localtime') ELSE NULL END,
      updated_at = datetime('now','localtime') WHERE id = ?`, [nextStatus, nextStatus, id]);
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  save();
  return { ...stats, status: nextStatus };
}

function finishProcessingRun(runId, stats, status = 'completed') {
  return setProcessingRunStatus(runId, status, stats);
}

function processingRunItemToRow(row) {
  const itemStatus = String(row.item_status || 'queued');
  const resultStatus = String(row.result_status || '');
  return {
    id: row.id,
    runId: row.run_id,
    position: row.position,
    codeId: row.code_id,
    code: row.code,
    itemStatus,
    status: resultStatus || itemStatus,
    url: row.url || '',
    actresses: parseJsonList(row.actresses_json),
    genres: parseJsonList(row.genres_json),
    finalTags: parseJsonList(row.final_tags_json),
    includeInImport: Boolean(row.include_in_import),
    skippedReason: row.skipped_reason || (itemStatus === 'queued' ? '等待继续处理' : ''),
    error: row.error || '',
    attemptCount: normalizeCounter(row.attempt_count),
    startedAt: row.started_at || '',
    finishedAt: row.finished_at || '',
    updatedAt: row.updated_at || '',
  };
}

function processingTaskToRow(row) {
  const definition = pipelineTaskDefinition(row.service, row.action);
  return {
    id: row.id,
    runId: row.run_id,
    runItemId: row.run_item_id,
    key: definition?.key || `${row.service}:${row.action}`,
    service: row.service,
    action: row.action,
    status: PROCESSING_TASK_STATUSES.has(row.status) ? row.status : 'failed',
    url: row.url || '',
    error: row.error || '',
    metadata: parseJsonObject(row.metadata_json),
    attemptCount: normalizeCounter(row.attempt_count),
    startedAt: row.started_at || '',
    finishedAt: row.finished_at || '',
    updatedAt: row.updated_at || '',
  };
}

function attachProcessingTasks(items, taskRows) {
  const tasksByItem = new Map();
  for (const rawTask of taskRows) {
    const task = processingTaskToRow(rawTask);
    if (!tasksByItem.has(task.runItemId)) tasksByItem.set(task.runItemId, {});
    tasksByItem.get(task.runItemId)[task.key] = task;
  }
  return items.map(item => ({ ...item, tasks: tasksByItem.get(item.id) || {} }));
}

function getProcessingRunItem(runId, position) {
  const rawItem = queryOne(`SELECT * FROM processing_run_items WHERE run_id = ? AND position = ?`, [Number(runId), Number(position)]);
  if (!rawItem) return null;
  const tasks = readRows(`SELECT * FROM processing_item_tasks WHERE run_item_id = ? ORDER BY id`, [rawItem.id]);
  return attachProcessingTasks([processingRunItemToRow(rawItem)], tasks)[0];
}

function getProcessingRunItems(runId) {
  const id = Number(runId);
  const items = readRows(`SELECT * FROM processing_run_items WHERE run_id = ? ORDER BY position`, [id])
    .map(processingRunItemToRow);
  if (!items.length) return [];
  const tasks = readRows(`SELECT * FROM processing_item_tasks WHERE run_id = ? ORDER BY run_item_id, id`, [id]);
  return attachProcessingTasks(items, tasks);
}

function emptyProcessingStage(definition) {
  const statusCounts = {};
  for (const status of PROCESSING_TASK_STATUSES) statusCounts[status] = 0;
  return {
    ...definition,
    total: 0,
    statusCounts,
    completed: 0,
    pending: 0,
    exceptions: 0,
    running: 0,
    progress: null,
  };
}

function summarizeProcessingTaskRows(rows = []) {
  const stages = Object.fromEntries(PIPELINE_TASK_DEFINITIONS.map(definition => [definition.key, emptyProcessingStage(definition)]));
  for (const row of rows) {
    const definition = pipelineTaskDefinition(row.service, row.action);
    if (!definition) continue;
    const stage = stages[definition.key];
    const status = PROCESSING_TASK_STATUSES.has(row.status) ? row.status : 'failed';
    stage.total++;
    stage.statusCounts[status]++;
  }
  let total = 0;
  let completed = 0;
  let exceptions = 0;
  let running = 0;
  for (const stage of Object.values(stages)) {
    stage.completed = [...PROCESSING_TASK_DONE_STATUSES].reduce((sum, status) => sum + stage.statusCounts[status], 0);
    stage.exceptions = [...PROCESSING_TASK_EXCEPTION_STATUSES].reduce((sum, status) => sum + stage.statusCounts[status], 0);
    stage.pending = Math.max(0, stage.total - stage.completed);
    stage.running = stage.statusCounts.running;
    stage.progress = stage.total ? Math.round((stage.completed / stage.total) * 100) : null;
    total += stage.total;
    completed += stage.completed;
    exceptions += stage.exceptions;
    running += stage.running;
  }
  const pending = Math.max(0, total - completed);
  return {
    stages,
    total,
    completed,
    pending,
    exceptions,
    running,
    progress: total ? Math.round((completed / total) * 100) : null,
    state: running ? 'active' : exceptions ? 'attention' : pending ? 'pending' : total ? 'completed' : 'empty',
  };
}

function processingTaskSummaryMap(runIds) {
  const ids = [...new Set((runIds || []).map(Number).filter(Number.isInteger))];
  const grouped = new Map(ids.map(id => [id, []]));
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = readRows(`SELECT run_id, service, action, status FROM processing_item_tasks
    WHERE run_id IN (${placeholders})`, ids);
  for (const row of rows) {
    if (!grouped.has(row.run_id)) grouped.set(row.run_id, []);
    grouped.get(row.run_id).push(row);
  }
  return new Map([...grouped.entries()].map(([id, tasks]) => [id, summarizeProcessingTaskRows(tasks)]));
}

function processingRunSummary(row, taskSummary = summarizeProcessingTaskRows()) {
  const total = normalizeCounter(row.total_codes);
  const itemCount = normalizeCounter(row.item_count);
  const completed = itemCount
    ? normalizeCounter(row.completed_codes)
    : (row.status === 'completed' ? total : normalizeCounter(row.completed_codes));
  const pending = itemCount ? normalizeCounter(row.pending_items) : Math.max(0, total - completed);
  const pipelineVersion = Math.max(1, normalizeCounter(row.pipeline_version || 1));
  const pipelineState = pipelineVersion === 1 && taskSummary.total === 0 ? 'legacy' : taskSummary.state;
  const lookupPending = taskSummary.total
    ? ['missavLookup', 'av123Lookup'].reduce((sum, key) => {
      const stage = taskSummary.stages[key];
      return sum + normalizeCounter(stage?.statusCounts?.queued) + normalizeCounter(stage?.statusCounts?.running);
    }, 0)
    : pending;
  const legacySpeedMode = String(row.speed_mode || '');
  return {
    id: row.id,
    name: row.name || `批次 #${row.id}`,
    sourceType: row.source_type || 'manual',
    sourceLabel: row.source_label || '',
    toolKind: normalizeProcessingToolKind(row.tool_kind),
    knownActresses: parseJsonList(row.known_actresses_json),
    speedMode: legacySpeedMode,
    missavSpeedMode: row.missav_speed_mode || legacySpeedMode,
    av123SpeedMode: row.av123_speed_mode || legacySpeedMode,
    missavSpeedPolicy: ['stable', 'balanced', 'fixed'].includes(row.missav_speed_policy) ? row.missav_speed_policy : 'stable',
    missavRateMode: row.missav_rate_mode === 'fixed' ? 'fixed' : 'adaptive',
    missavRateCap: Math.max(1, Math.min(32, Number(row.missav_rate_cap) || 16)),
    av123SpeedPolicy: ['staged', 'balanced', 'fixed'].includes(row.av123_speed_policy) ? row.av123_speed_policy : 'staged',
    av123RateMode: row.av123_rate_mode === 'fixed' ? 'fixed' : 'adaptive',
    av123RateCap: Math.max(1, Math.min(32, Number(row.av123_rate_cap) || 16)),
    av123AutoFavorite: Number(row.av123_auto_favorite || 0) === 1,
    av123FavoriteConcurrency: Math.max(1, Math.min(4, Number(row.av123_favorite_concurrency) || 2)),
    status: row.status || 'completed',
    pipelineVersion,
    pipelineState,
    outputDir: row.output_dir || '',
    started_at: row.started_at || '',
    finished_at: row.finished_at || '',
    updatedAt: row.updated_at || '',
    total,
    new: normalizeCounter(row.new_codes),
    skipped: normalizeCounter(row.skipped_codes),
    notFound: normalizeCounter(row.not_found_codes),
    duplicate: normalizeCounter(row.duplicate_codes),
    completed,
    networkError: normalizeCounter(row.network_error_codes),
    manual: normalizeCounter(row.manual_codes),
    pending,
    lookupPending,
    progress: total ? Math.round((completed / total) * 100) : 100,
    itemCount,
    stages: taskSummary.stages,
    pipelineTaskCount: taskSummary.total,
    pipelineCompleted: taskSummary.completed,
    pipelinePending: taskSummary.pending,
    pipelineExceptions: taskSummary.exceptions,
    pipelineProgress: taskSummary.progress,
  };
}

function getProcessingRun(runId) {
  const row = queryOne(`SELECT r.*,
    (SELECT COUNT(*) FROM processing_run_items i WHERE i.run_id = r.id) AS item_count,
    (SELECT COUNT(*) FROM processing_run_items i WHERE i.run_id = r.id AND i.item_status IN ('queued','running')) AS pending_items
    FROM processing_runs r WHERE r.id = ?`, [Number(runId)]);
  if (!row) return null;
  const taskSummary = processingTaskSummaryMap([row.id]).get(row.id);
  return { ...processingRunSummary(row, taskSummary), items: getProcessingRunItems(row.id) };
}

function getRecentRuns(limit = 20) {
  const safeLimit = normalizeLimit(limit, 20, 500);
  const rows = readRows(`SELECT r.*,
    (SELECT COUNT(*) FROM processing_run_items i WHERE i.run_id = r.id) AS item_count,
    (SELECT COUNT(*) FROM processing_run_items i WHERE i.run_id = r.id AND i.item_status IN ('queued','running')) AS pending_items
    FROM processing_runs r ORDER BY r.id DESC LIMIT ?`, [safeLimit]);
  const summaries = processingTaskSummaryMap(rows.map(row => row.id));
  return rows.map(row => processingRunSummary(row, summaries.get(row.id)));
}

function getResumableProcessingRun() {
  const row = queryOne(`SELECT r.*,
    (SELECT COUNT(*) FROM processing_run_items i WHERE i.run_id = r.id) AS item_count,
    (SELECT COUNT(*) FROM processing_run_items i WHERE i.run_id = r.id AND i.item_status IN ('queued','running')) AS pending_items
    FROM processing_runs r
    WHERE r.status IN ('paused','running')
      AND (
        EXISTS (SELECT 1 FROM processing_run_items i WHERE i.run_id = r.id AND i.item_status IN ('queued','running'))
        OR EXISTS (SELECT 1 FROM processing_item_tasks t
          WHERE t.run_id = r.id AND t.action = 'lookup' AND t.status IN ('queued','running'))
      )
    ORDER BY r.id DESC LIMIT 1`);
  if (!row) return null;
  return processingRunSummary(row, processingTaskSummaryMap([row.id]).get(row.id));
}

function renameProcessingRun(runId, name) {
  const next = String(name || '').trim();
  if (!next) throw new Error('批次名称不能为空');
  if (!queryOne(`SELECT id FROM processing_runs WHERE id = ?`, [Number(runId)])) throw new Error('处理批次不存在');
  runSQL(`UPDATE processing_runs SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [next, Number(runId)]);
  save();
  return true;
}

function setProcessingRunSpeedSettings(runId, settings = {}) {
  const id = Number(runId);
  if (!queryOne(`SELECT id FROM processing_runs WHERE id = ?`, [id])) throw new Error('处理批次不存在');
  const missavSpeedMode = String(settings.missavSpeedMode || settings.missav_speed_mode || '').trim().slice(0, 24);
  const av123SpeedMode = String(settings.av123SpeedMode || settings.av123_speed_mode || '').trim().slice(0, 24);
  const requestedMissavPolicy = String(settings.missavSpeedPolicy || settings.missav_speed_policy || 'stable');
  const missavSpeedPolicy = ['stable', 'balanced', 'fixed'].includes(requestedMissavPolicy) ? requestedMissavPolicy : 'stable';
  const requestedMissavRateMode = String(settings.missavRateMode || settings.missav_rate_mode || 'adaptive');
  const missavRateMode = requestedMissavRateMode === 'fixed' ? 'fixed' : 'adaptive';
  const missavRateCap = Math.max(1, Math.min(32, Number(settings.missavRateCap ?? settings.missav_rate_cap) || 16));
  const requested123AvPolicy = String(settings.av123SpeedPolicy || settings.av123_speed_policy || 'staged');
  const av123SpeedPolicy = ['staged', 'balanced', 'fixed'].includes(requested123AvPolicy) ? requested123AvPolicy : 'staged';
  const requested123AvRateMode = String(settings.av123RateMode || settings.av123_rate_mode || 'adaptive');
  const av123RateMode = requested123AvRateMode === 'fixed' ? 'fixed' : 'adaptive';
  const av123RateCap = Math.max(1, Math.min(32, Number(settings.av123RateCap ?? settings.av123_rate_cap) || 16));
  const av123AutoFavorite = settings.av123AutoFavorite === true || Number(settings.av123_auto_favorite) === 1 ? 1 : 0;
  const av123FavoriteConcurrency = Math.max(1, Math.min(4, Number(settings.av123FavoriteConcurrency ?? settings.av123_favorite_concurrency) || 2));
  runSQL(`UPDATE processing_runs SET speed_mode = ?, missav_speed_mode = ?, av123_speed_mode = ?,
    missav_speed_policy = ?, missav_rate_mode = ?, missav_rate_cap = ?, av123_speed_policy = ?, av123_rate_mode = ?, av123_rate_cap = ?,
    av123_auto_favorite = ?, av123_favorite_concurrency = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
  [missavSpeedMode, missavSpeedMode, av123SpeedMode, missavSpeedPolicy, missavRateMode, missavRateCap, av123SpeedPolicy, av123RateMode, av123RateCap, av123AutoFavorite, av123FavoriteConcurrency, id]);
  save();
  return true;
}

function deleteProcessingRun(runId, options = {}) {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('批次 ID 无效');
  const run = queryOne(`SELECT id, name, status, output_dir FROM processing_runs WHERE id = ?`, [id]);
  if (!run) return { deleted: false, runId: id, reason: 'not_found' };

  const itemCount = countQuery(`SELECT COUNT(*) FROM processing_run_items WHERE run_id = ?`, [id]);
  const taskCount = countQuery(`SELECT COUNT(*) FROM processing_item_tasks WHERE run_id = ?`, [id]);
  const completedItems = countQuery(`SELECT COUNT(*) FROM processing_run_items
    WHERE run_id = ? AND item_status IN ('completed','skipped','duplicate')`, [id]);
  const permanentCodeLinks = countQuery(`SELECT COUNT(DISTINCT code_id) FROM processing_run_items
    WHERE run_id = ? AND code_id IS NOT NULL`, [id]);
  const backup = options.createBackup === false
    ? null
    : createBackup(`before_delete_run_${id}`, 'pre_delete_processing_run');

  DB.run('BEGIN TRANSACTION');
  try {
    runSQL(`DELETE FROM processing_item_tasks WHERE run_id = ?`, [id]);
    runSQL(`DELETE FROM processing_run_items WHERE run_id = ?`, [id]);
    runSQL(`DELETE FROM processing_runs WHERE id = ?`, [id]);
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }
  save();
  return {
    deleted: true,
    runId: id,
    name: String(run.name || `批次 #${id}`),
    status: String(run.status || ''),
    outputDir: String(run.output_dir || ''),
    itemCount,
    taskCount,
    completedItems,
    permanentCodeLinks,
    permanentCodesKept: true,
    exportedFilesKept: true,
    backup,
  };
}

function setProcessingRunOutputDir(runId, outputDir) {
  if (!queryOne(`SELECT id FROM processing_runs WHERE id = ?`, [Number(runId)])) throw new Error('处理批次不存在');
  runSQL(`UPDATE processing_runs SET output_dir = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    [String(outputDir || '').trim(), Number(runId)]);
  save();
  return true;
}

// ═══════════════════════════════════════════════════════
//  CSV 解析
// ═══════════════════════════════════════════════════════

function parseSimpleCSV(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') { if (line[i + 1] === '"') { current += '"'; i++; } else inQuotes = false; }
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current); current = ''; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  备份与恢复
// ═══════════════════════════════════════════════════════

function ensureBackupDir() {
  if (!dbPath) throw new Error('数据库尚未初始化');
  const dir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupTimestamp(date = new Date()) {
  const pad2 = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function cleanBackupLabel(label) {
  return String(label || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48);
}

function resolveBackupPath(nameOrPath) {
  const dir = ensureBackupDir();
  const base = path.basename(String(nameOrPath || ''));
  if (!base || !base.toLowerCase().endsWith('.db')) throw new Error('备份文件名无效');
  const resolved = path.resolve(dir, base);
  const root = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(root)) throw new Error('备份路径越界');
  if (!fs.existsSync(resolved)) throw new Error('备份文件不存在');
  return resolved;
}

function backupMetaPath(filePath) {
  return `${filePath}.json`;
}

function readBackupMeta(filePath) {
  const stat = fs.statSync(filePath);
  const fallback = {
    fileName: path.basename(filePath),
    filePath,
    label: '',
    reason: 'unknown',
    createdAt: stat.mtime.toISOString(),
    size: stat.size,
    stats: null,
  };
  const metaPath = backupMetaPath(filePath);
  if (!fs.existsSync(metaPath)) return fallback;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return { ...fallback, ...meta, fileName: path.basename(filePath), filePath, size: stat.size };
  } catch {
    return fallback;
  }
}

function createBackup(label = '', reason = 'manual') {
  if (!DB) throw new Error('数据库未就绪');
  save('FULL');
  const dir = ensureBackupDir();
  const safeLabel = cleanBackupLabel(label) || String(reason || 'manual').replace(/[^a-z0-9_-]/gi, '_') || 'backup';
  const baseName = `missav_data_${backupTimestamp()}_${safeLabel}`;
  let fileName = `${baseName}.db`;
  let filePath = path.join(dir, fileName);
  let suffix = 2;
  while (fs.existsSync(filePath)) {
    fileName = `${baseName}_${suffix}.db`;
    filePath = path.join(dir, fileName);
    suffix++;
  }
  fs.copyFileSync(dbPath, filePath);
  const stat = fs.statSync(filePath);
  const meta = {
    fileName,
    filePath,
    label: String(label || '').trim(),
    reason: String(reason || 'manual'),
    createdAt: new Date().toISOString(),
    size: stat.size,
    stats: getStats(),
  };
  fs.writeFileSync(backupMetaPath(filePath), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function getDatabaseInventory() {
  if (!DB) throw new Error('数据库未就绪');
  const catalogByName = new Map(DATABASE_TABLE_CATALOG.map(table => [table.name, table]));
  const userTableNames = readRows(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(row => row.name);
  const tables = userTableNames.map(name => {
    const table = catalogByName.get(name) || {
      name,
      label: `历史/未知表 ${name}`,
      category: '旧版兼容',
      description: '当前版本不再使用，但全库归零时仍会清空其数据',
    };
    const exists = true;
    return {
      ...table,
      exists,
      rowCount: exists ? countQuery(`SELECT COUNT(*) FROM ${quoteIdent(table.name)}`) : 0,
      editable: RAW_TABLES[table.name]?.editable || [],
      insertable: RAW_TABLES[table.name]?.insertable || [],
    };
  });
  return {
    path: dbPath,
    totalRows: tables.reduce((sum, table) => sum + Number(table.rowCount || 0), 0),
    businessRows: tables.reduce((sum, table) => sum + Number(table.rowCount || 0), 0),
    tables,
  };
}

function resetAllBusinessData(options = {}) {
  if (!DB) throw new Error('数据库未就绪');
  if (String(options.confirmText || '') !== RESET_CONFIRMATION_TEXT) {
    throw new Error(`请输入“${RESET_CONFIRMATION_TEXT}”确认`);
  }

  const before = getDatabaseInventory();
  const backup = createBackup(options.backupLabel || '正式启用前完整备份', 'pre_full_reset');
  const actualTables = before.tables.map(table => table.name);
  const orderedTables = [
    ...BUSINESS_DATA_TABLES.filter(table => actualTables.includes(table)),
    ...actualTables.filter(table => !BUSINESS_DATA_TABLES.includes(table)),
  ];
  DB.run('BEGIN TRANSACTION');
  try {
    for (const table of orderedTables) DB.run(`DELETE FROM ${quoteIdent(table)}`);
    const hasSequence = queryOne(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`);
    if (hasSequence) {
      const placeholders = orderedTables.map(() => '?').join(',');
      if (placeholders) runSQL(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`, orderedTables);
    }
    DB.run('COMMIT');
  } catch (err) {
    try { DB.run('ROLLBACK'); } catch {}
    throw err;
  }

  try { DB.run('VACUUM'); } catch {}
  save();
  const integrity = queryValue('PRAGMA integrity_check');
  if (integrity !== 'ok') throw new Error(`清空后数据库完整性检查失败：${integrity || 'unknown'}`);
  const after = getDatabaseInventory();
  return {
    reset: true,
    backup,
    before,
    after,
    preserved: ['数据库结构', '备份文件', '外观设置', 'Windows 安全存储中的账号令牌与会话'],
  };
}

function listBackups() {
  const dir = ensureBackupDir();
  return fs.readdirSync(dir)
    .filter(name => name.toLowerCase().endsWith('.db'))
    .map(name => readBackupMeta(path.join(dir, name)))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function deleteBackup(nameOrPath) {
  const filePath = resolveBackupPath(nameOrPath);
  const metaPath = backupMetaPath(filePath);
  fs.unlinkSync(filePath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  return true;
}

function restoreBackup(nameOrPath) {
  if (!DB || !dbPath) throw new Error('数据库引擎未初始化');
  const filePath = resolveBackupPath(nameOrPath);
  const before = createBackup('restore_before', 'pre_restore');
  let validationDb = null;
  try {
    validationDb = new NativeSqliteDatabase(filePath, { readOnly: true });
    const integrityRow = validationDb.db.prepare('PRAGMA integrity_check').get();
    const integrityValue = integrityRow ? Object.values(integrityRow)[0] : '';
    if (integrityValue !== 'ok') throw new Error('数据库完整性检查失败');

    const tableRows = validationDb.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const tableNames = new Set(tableRows.map(row => row.name));
    const missingTables = REQUIRED_BACKUP_TABLES.filter(name => !tableNames.has(name));
    if (missingTables.length) throw new Error(`缺少必要数据表：${missingTables.join(', ')}`);
  } catch (err) {
    throw new Error('无法读取该备份：' + err.message);
  } finally {
    if (validationDb) try { validationDb.close(); } catch {}
  }

  const tempPath = `${dbPath}.restore.tmp`;
  const displacedPath = `${dbPath}.restore.previous`;
  try {
    save('FULL');
    DB.close();
    DB = null;
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${dbPath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    fs.copyFileSync(filePath, tempPath);
    if (fs.existsSync(displacedPath)) fs.unlinkSync(displacedPath);
    fs.renameSync(dbPath, displacedPath);
    fs.renameSync(tempPath, dbPath);
    DB = new NativeSqliteDatabase(dbPath);
    createTables();
    migrateSchema();
    DB.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    save('FULL');
    if (fs.existsSync(displacedPath)) fs.unlinkSync(displacedPath);
  } catch (error) {
    if (DB) {
      try { DB.close(); } catch {}
      DB = null;
    }
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    if (fs.existsSync(displacedPath)) {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      fs.renameSync(displacedPath, dbPath);
    }
    DB = new NativeSqliteDatabase(dbPath);
    throw new Error(`恢复失败，已回到恢复前数据库：${error.message}`);
  }
  return { restored: true, backup: readBackupMeta(filePath), preRestoreBackup: before, stats: getStats() };
}

function getBackupDirectory() {
  return ensureBackupDir();
}
function close() {
  if (DB) { save(); DB.close(); DB = null; }
}

module.exports = {
  init, save, close,
  getOrCreateActressTag, getAllActressTags, searchActressTag, getCodesByActress,
  findCode, upsertCode, persistProcessedCode,
  linkActressCode, linkGenreCode,
  importFromCSV, exportToCSV,
  getStats, getActressLibrary, getCodeLibrary, getCodeLibraryPage, getCodeLibraryIds, getCodeLibraryByIds, analyzeCodeImport, importHistoricalCodes, importHistoricalRecords, getDuplicateCodeGroups, getRaindropImportRows, renameActressTag, mergeActressTags,
  getBookmarkLibrary, getBookmarkStats, getBookmarkCollections, getBookmarkCollectionInfo, createBookmarkCollection, renameBookmarkCollection, deleteBookmarkCollection, getBookmarkScopeInfo, deleteBookmarksByScope, importRaindropRecords, buildRaindropExport, exportRaindropRecords, createBookmarkRecord, updateBookmarkRecord, deleteBookmarkRecord,
  getHealthReport, cleanupOrphanTags, cleanupBrokenRelations,
  createBackup, listBackups, deleteBackup, restoreBackup, getBackupDirectory, getDatabaseInventory, resetAllBusinessData,
  getGenreLibrary, createGenreTag, renameGenreTag, deleteGenreTag,
  createCodeRecord, updateCodeRecord, deleteCodeRecord, setCodeActressTags, setCodeGenreTags,
  createActressTag, deleteActressTag,
  getEditableTables, getRawTableRows, updateRawCell, bulkUpdateRawCells, insertRawRow, deleteRawRow, bulkDeleteRawRows, exportRawTableRows,
  createProcessingRun, markProcessingRunItemRunning, updateProcessingRunItem, completeMissavProcessingRunItem,
  updateProcessingItemTask, completeProcessingItemTaskWithCache,
  getSiteLookupCache, upsertSiteLookupCache,
  getRemoteSyncRecord, completeRemoteSyncTask,
  getTelegramSource, upsertTelegramSource, getTelegramGroupSources, setTelegramGroupSources,
  recordTelegramImport, getTelegramImportHistory,
  setProcessingRunStatus, finishProcessingRun, getRecentRuns, getProcessingRun,
  getProcessingRunItem, getProcessingRunItems, getResumableProcessingRun, renameProcessingRun, deleteProcessingRun, setProcessingRunSpeedSettings, setProcessingRunOutputDir,
  generateCodeVariants,
};
