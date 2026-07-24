const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const database = require('../src/database');

test('backs up a legacy SQLite file once before native SQLite migration', async t => {
  database.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-toolbox-native-migration-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run('CREATE TABLE actress_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, tag_name TEXT NOT NULL UNIQUE)');
  legacy.run('CREATE TABLE codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, best_url TEXT DEFAULT \'\', status TEXT DEFAULT \'ok\')');
  legacy.run('CREATE TABLE actress_code_map (actress_id INTEGER NOT NULL, code_id INTEGER NOT NULL, PRIMARY KEY (actress_id, code_id))');
  legacy.run('INSERT INTO actress_tags (tag_name) VALUES (?)', ['Legacy Actress']);
  legacy.run('INSERT INTO codes (code, best_url, status) VALUES (?, ?, ?)', ['ABF-354', 'https://missav.ai/cn/abf-354', 'ok']);
  legacy.run('INSERT INTO actress_code_map (actress_id, code_id) VALUES (1, 1)');
  fs.writeFileSync(path.join(dir, 'missav_data.db'), Buffer.from(legacy.export()));
  legacy.close();

  const first = await database.init(dir);
  assert.equal(first.engine, 'node:sqlite');
  assert.equal(first.schemaVersion, 300);
  assert.ok(first.migrationBackup);
  assert.equal(fs.existsSync(first.migrationBackup.filePath), true);
  assert.equal(database.findCode('ABF-354').found, true);
  assert.deepEqual(database.getCodeLibraryByIds([1])[0].actress_tags, ['Legacy Actress']);
  database.close();

  const backupCount = fs.readdirSync(path.join(dir, 'backups')).filter(name => name.endsWith('.db')).length;
  const second = await database.init(dir);
  assert.equal(second.migrationBackup, null);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter(name => name.endsWith('.db')).length, backupCount);
  assert.equal(database.findCode('ABF-354').found, true);
  assert.equal(fs.existsSync(path.join(dir, '.native-sqlite-v3.json')), true);
});

test('supports a 100k-plus code library with bounded server-side pages', async t => {
  database.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-toolbox-100k-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await database.init(dir);

  const total = 100_200;
  const codes = Array.from({ length: total }, (_value, index) => `BENCH-${String(index + 1).padStart(6, '0')}`);
  const startedAt = Date.now();
  const imported = database.importHistoricalCodes(codes);
  const importMs = Date.now() - startedAt;
  assert.deepEqual(imported, { imported: total, existing: 0, total });

  const firstPageStartedAt = Date.now();
  const first = database.getCodeLibraryPage({ page: 1, pageSize: 160, sort: 'recent' });
  const firstPageMs = Date.now() - firstPageStartedAt;
  assert.equal(first.total, total);
  assert.equal(first.rows.length, 160);
  assert.equal(first.pageCount, Math.ceil(total / 160));

  const searchStartedAt = Date.now();
  const searched = database.getCodeLibraryPage({ search: 'BENCH-099999', page: 1, pageSize: 160, sort: 'code' });
  const searchMs = Date.now() - searchStartedAt;
  assert.equal(searched.total, 1);
  assert.equal(searched.rows[0].code, 'BENCH-099999');

  const ids = database.getCodeLibraryIds({ statusFilter: 'historical', limit: 200_000 });
  assert.equal(ids.length, total);
  const selected = database.getCodeLibraryByIds([ids[0], ids[50_000], ids.at(-1)]);
  assert.equal(selected.length, 3);

  t.diagnostic(JSON.stringify({
    rows: total,
    importMs,
    firstPageMs,
    searchMs,
    databaseBytes: fs.statSync(path.join(dir, 'missav_data.db')).size,
  }));
});
