/**
 * MissAV Manager — SQLite 本地数据库模块 (sql.js)
 *
 * 表结构：
 *   actress_tags (id, tag_name)
 *   codes (id, code, best_url, status, raindrop_title, raindrop_excerpt, raindrop_note, raindrop_folder, raindrop_tags, raindrop_created, raindrop_cover)
 *   actress_code_map (actress_id, code_id)  多对多
 *   genre_tags (id, name)
 *   code_genres (code_id, genre_id)
 *   processing_runs (id, started_at, finished_at, total, new, skipped, not_found, duplicate)
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { normalizeCode, codeComparableKey } = require('./parser');

const DB_FILENAME = 'missav_data.db';

let DB = null;
let SQL = null;
let dbPath = '';

// ─── 初始化 ──────────────────────────────────────────
async function init(dbDir) {
  SQL = await initSqlJs();
  dbPath = path.join(dbDir, DB_FILENAME);

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    DB = new SQL.Database(buffer);
  } else {
    DB = new SQL.Database();
    createTables();
  }
  migrateSchema();
  save();
  return { loaded: true, path: dbPath };
}

function save() {
  if (!DB) return;
  const data = DB.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
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

  DB.run(`CREATE TABLE IF NOT EXISTS processing_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT DEFAULT (datetime('now','localtime')), finished_at TEXT,
    total_codes INTEGER DEFAULT 0, new_codes INTEGER DEFAULT 0,
    skipped_codes INTEGER DEFAULT 0, not_found_codes INTEGER DEFAULT 0,
    duplicate_codes INTEGER DEFAULT 0)`);

  DB.run(`CREATE INDEX IF NOT EXISTS idx_codes_code ON codes(code)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_actress_tags_name ON actress_tags(tag_name)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_acm_a ON actress_code_map(actress_id)`);
  DB.run(`CREATE INDEX IF NOT EXISTS idx_acm_c ON actress_code_map(code_id)`);
}

function migrateSchema() {
  ensureColumn('codes', 'raindrop_title', "TEXT DEFAULT ''");
  ensureColumn('codes', 'raindrop_excerpt', "TEXT DEFAULT ''");
  ensureColumn('codes', 'raindrop_note', "TEXT DEFAULT ''");
  ensureColumn('codes', 'raindrop_folder', "TEXT DEFAULT ''");
  ensureColumn('codes', 'raindrop_tags', "TEXT DEFAULT ''");
  ensureColumn('codes', 'raindrop_created', "TEXT DEFAULT ''");
  ensureColumn('codes', 'raindrop_cover', "TEXT DEFAULT ''");
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
  return lastInsertId();
}

function linkActressCode(actressId, codeId) {
  linkActressCodeNoSave(actressId, codeId);
  save();
}

function linkActressCodeNoSave(actressId, codeId) {
  try { runSQL(`INSERT OR IGNORE INTO actress_code_map (actress_id, code_id) VALUES (?, ?)`, [actressId, codeId]); } catch {}
}

function linkGenreCode(genreName, codeId) {
  const name = (genreName || '').trim();
  if (!name) return;
  let row = queryOne(`SELECT id FROM genre_tags WHERE name = ?`, [name]);
  let genreId;
  if (row) { genreId = row.id; }
  else { runSQL(`INSERT INTO genre_tags (name) VALUES (?)`, [name]); genreId = lastInsertId(); }
  try { runSQL(`INSERT OR IGNORE INTO code_genres (code_id, genre_id) VALUES (?, ?)`, [codeId, genreId]); } catch {}
  save();
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

function getCodeLibrary(options = {}) {
  const search = String(options.search || '').trim();
  const limit = normalizeLimit(options.limit, 300);
  const pattern = `%${search}%`;
  return readRows(`
    SELECT c.id, c.code, c.best_url, c.status, c.raindrop_title, c.raindrop_excerpt, c.raindrop_note, c.raindrop_folder, c.raindrop_tags, c.raindrop_created, c.raindrop_cover, c.created_at,
      GROUP_CONCAT(DISTINCT a.tag_name) AS actress_tags,
      GROUP_CONCAT(DISTINCT g.name) AS genre_tags
    FROM codes c
    LEFT JOIN actress_code_map acm ON acm.code_id = c.id
    LEFT JOIN actress_tags a ON a.id = acm.actress_id
    LEFT JOIN code_genres cg ON cg.code_id = c.id
    LEFT JOIN genre_tags g ON g.id = cg.genre_id
    WHERE (? = '' OR c.code LIKE ? OR c.best_url LIKE ? OR c.raindrop_title LIKE ? OR c.raindrop_excerpt LIKE ? OR c.raindrop_note LIKE ? OR c.raindrop_folder LIKE ? OR c.raindrop_tags LIKE ? OR c.raindrop_created LIKE ? OR a.tag_name LIKE ? OR g.name LIKE ?)
    GROUP BY c.id
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ?`, [search, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, limit]).map(row => ({
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
    }));
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
    editable: ['code', 'best_url', 'status', 'raindrop_title', 'raindrop_excerpt', 'raindrop_note', 'raindrop_folder', 'raindrop_tags', 'raindrop_created', 'raindrop_cover'],
    insertable: ['code', 'best_url', 'status', 'raindrop_title', 'raindrop_excerpt', 'raindrop_note', 'raindrop_folder', 'raindrop_tags', 'raindrop_created', 'raindrop_cover'],
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
    label: '处理记录',
    pk: ['id'],
    editable: ['started_at', 'finished_at', 'total_codes', 'new_codes', 'skipped_codes', 'not_found_codes', 'duplicate_codes'],
    insertable: ['started_at', 'finished_at', 'total_codes', 'new_codes', 'skipped_codes', 'not_found_codes', 'duplicate_codes'],
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
  return next;
}

function getRawTableRows(table, options = {}) {
  const cfg = getRawTableConfig(table);
  const columns = getTableColumns(cfg.name);
  const limit = normalizeLimit(options.limit, 300, 2000);
  const search = String(options.search || '').trim();
  const params = [];
  let where = '';

  if (search) {
    const pattern = `%${search}%`;
    where = `WHERE ${columns.map(col => `CAST(${quoteIdent(col)} AS TEXT) LIKE ?`).join(' OR ')}`;
    for (let i = 0; i < columns.length; i++) params.push(pattern);
  }

  const sql = `SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(cfg.name)} ${where} ORDER BY ${cfg.order} LIMIT ?`;
  const rows = readRows(sql, [...params, limit]);
  return {
    table: cfg.name,
    label: cfg.label,
    columns,
    pk: cfg.pk,
    editable: cfg.editable,
    insertable: cfg.insertable,
    rows,
  };
}

function updateRawCell(table, pk, column, value) {
  const cfg = getRawTableConfig(table);
  const col = String(column || '').trim();
  if (!cfg.editable.includes(col)) throw new Error('该字段不允许直接编辑');
  const key = parsePk(pk, cfg);
  const next = validateRawValue(cfg.name, col, value, key.obj);
  const setSql = cfg.name === 'actress_tags' && col === 'tag_name'
    ? `${quoteIdent(col)} = ?, updated_at = datetime('now','localtime')`
    : `${quoteIdent(col)} = ?`;
  runSQL(`UPDATE ${quoteIdent(cfg.name)} SET ${setSql} WHERE ${key.where}`, [next, ...key.values]);
  save();
  return true;
}

function insertRawRow(table, row = {}) {
  const cfg = getRawTableConfig(table);
  const data = row || {};

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

  throw new Error('该数据表暂不支持新增');
}

function deleteRawRow(table, pk) {
  const cfg = getRawTableConfig(table);
  const key = parsePk(pk, cfg);

  if (cfg.name === 'codes') return deleteCodeRecord(key.obj.id);
  if (cfg.name === 'actress_tags') return deleteActressTag(key.obj.id);
  if (cfg.name === 'genre_tags') return deleteGenreTag(key.obj.id);

  runSQL(`DELETE FROM ${quoteIdent(cfg.name)} WHERE ${key.where}`, key.values);
  save();
  return true;
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
function createProcessingRun() {
  runSQL(`INSERT INTO processing_runs (started_at) VALUES (datetime('now','localtime'))`);
  return lastInsertId();
}

function finishProcessingRun(runId, stats) {
  runSQL(`UPDATE processing_runs SET finished_at = datetime('now','localtime'),
    total_codes = ?, new_codes = ?, skipped_codes = ?, not_found_codes = ?, duplicate_codes = ?
    WHERE id = ?`,
    [stats.total || 0, stats.new || 0, stats.exists || 0, stats.notFound || 0, stats.duplicate || 0, runId]);
  save();
}

function getRecentRuns(limit = 20) {
  const stmt = DB.prepare(`SELECT id, started_at, finished_at, total_codes, new_codes, skipped_codes, not_found_codes, duplicate_codes FROM processing_runs ORDER BY id DESC LIMIT ?`);
  stmt.bind([limit]);
  const runs = [];
  while (stmt.step()) {
    const v = stmt.get();
    runs.push({ id: v[0], started_at: v[1], finished_at: v[2], total: v[3], new: v[4], skipped: v[5], notFound: v[6], duplicate: v[7] });
  }
  stmt.free();
  return runs;
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
  save();
  const dir = ensureBackupDir();
  const safeLabel = cleanBackupLabel(label) || String(reason || 'manual').replace(/[^a-z0-9_-]/gi, '_') || 'backup';
  const fileName = `missav_data_${backupTimestamp()}_${safeLabel}.db`;
  const filePath = path.join(dir, fileName);
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
  if (!SQL) throw new Error('数据库引擎未初始化');
  const filePath = resolveBackupPath(nameOrPath);
  const before = createBackup('restore_before', 'pre_restore');
  const buffer = fs.readFileSync(filePath);
  let nextDb = null;
  try {
    nextDb = new SQL.Database(buffer);
    const check = nextDb.exec(`SELECT name FROM sqlite_master WHERE type='table' LIMIT 1`);
    if (!Array.isArray(check)) throw new Error('备份文件校验失败');
  } catch (err) {
    if (nextDb) try { nextDb.close(); } catch {}
    throw new Error('无法读取该备份：' + err.message);
  }

  if (DB) try { DB.close(); } catch {}
  DB = nextDb;
  save();
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
  findCode, upsertCode,
  linkActressCode, linkGenreCode,
  importFromCSV, exportToCSV,
  getStats, getActressLibrary, getCodeLibrary, getDuplicateCodeGroups, getRaindropImportRows, renameActressTag, mergeActressTags,
  getHealthReport, cleanupOrphanTags, cleanupBrokenRelations,
  createBackup, listBackups, deleteBackup, restoreBackup, getBackupDirectory,
  getGenreLibrary, createGenreTag, renameGenreTag, deleteGenreTag,
  createCodeRecord, updateCodeRecord, deleteCodeRecord, setCodeActressTags, setCodeGenreTags,
  createActressTag, deleteActressTag,
  getEditableTables, getRawTableRows, updateRawCell, insertRawRow, deleteRawRow,
  createProcessingRun, finishProcessingRun, getRecentRuns,
  generateCodeVariants,
};