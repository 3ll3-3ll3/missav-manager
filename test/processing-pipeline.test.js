const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const database = require('../src/database');

const TASK_KEYS = ['missavLookup', 'raindropSync', 'av123Lookup', 'av123Favorite'];
const TERMINAL_STATUSES = new Set(['succeeded', 'not_found', 'skipped']);
const EXCEPTION_STATUSES = new Set(['manual', 'network_error', 'failed', 'verify_required']);

async function useTemporaryDatabase(t, prefix) {
  database.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await database.init(dir);
  return dir;
}

async function countPersistedTasks(dir) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(path.join(dir, 'missav_data.db')));
  try {
    const result = db.exec('SELECT COUNT(*) FROM processing_item_tasks');
    return Number(result[0].values[0][0]);
  } finally {
    db.close();
  }
}

async function createLegacyV013Database(dir) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    const statements = [
      `CREATE TABLE actress_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_name TEXT NOT NULL UNIQUE,
        created_at TEXT,
        updated_at TEXT)`,
      `CREATE TABLE codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        best_url TEXT DEFAULT '',
        status TEXT DEFAULT 'ok',
        created_at TEXT)`,
      `CREATE TABLE actress_code_map (
        actress_id INTEGER NOT NULL,
        code_id INTEGER NOT NULL,
        PRIMARY KEY (actress_id, code_id))`,
      `CREATE TABLE genre_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE)`,
      `CREATE TABLE code_genres (
        code_id INTEGER NOT NULL,
        genre_id INTEGER NOT NULL,
        PRIMARY KEY (code_id, genre_id))`,
      `CREATE TABLE processing_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT,
        finished_at TEXT,
        total_codes INTEGER DEFAULT 0,
        new_codes INTEGER DEFAULT 0,
        skipped_codes INTEGER DEFAULT 0,
        not_found_codes INTEGER DEFAULT 0,
        duplicate_codes INTEGER DEFAULT 0,
        name TEXT DEFAULT '',
        source_type TEXT DEFAULT 'manual',
        source_label TEXT DEFAULT '',
        speed_mode TEXT DEFAULT '',
        status TEXT DEFAULT 'completed',
        updated_at TEXT,
        completed_codes INTEGER DEFAULT 0,
        network_error_codes INTEGER DEFAULT 0,
        manual_codes INTEGER DEFAULT 0,
        output_dir TEXT DEFAULT '')`,
      `CREATE TABLE processing_run_items (
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
        updated_at TEXT,
        UNIQUE(run_id, position))`,
    ];
    statements.forEach(statement => db.run(statement));
    db.run(`INSERT INTO processing_runs (
      id, started_at, total_codes, new_codes, name, source_type, source_label,
      speed_mode, status, updated_at, completed_codes, output_dir)
      VALUES (1, '2026-07-21 20:00:00', 2, 2, 'v0.1.3 interrupted batch',
        'file', 'tg-export.txt', 'fast', 'paused', '2026-07-21 20:05:00', 1, 'E:\\Exports')`);
    db.run(`INSERT INTO processing_run_items (
      id, run_id, position, code, item_status, result_status, url,
      actresses_json, genres_json, final_tags_json, include_in_import,
      attempt_count, started_at, finished_at, updated_at)
      VALUES (1, 1, 0, 'ABF-354', 'completed', 'ok',
        'https://missav.ai/cn/abf-354', '["Actress One"]', '["Drama"]',
        '["Actress One","Drama"]', 1, 2, '2026-07-21 20:01:00',
        '2026-07-21 20:02:00', '2026-07-21 20:02:00')`);
    db.run(`INSERT INTO processing_run_items (
      id, run_id, position, code, item_status, result_status, attempt_count, updated_at)
      VALUES (2, 1, 1, 'SONE-314', 'queued', '', 0, '2026-07-21 20:03:00')`);
    fs.writeFileSync(path.join(dir, 'missav_data.db'), Buffer.from(db.export()));
  } finally {
    db.close();
  }
}

function assertFixedTaskKeys(value) {
  assert.deepEqual(Object.keys(value).sort(), [...TASK_KEYS].sort());
}

function assertStage(run, key, expectedStatuses) {
  const stage = run.stages[key];
  assert.equal(stage.key, key);
  assert.equal(typeof stage.service, 'string');
  assert.equal(typeof stage.action, 'string');

  for (const [status, count] of Object.entries(expectedStatuses)) {
    assert.equal(stage.statusCounts[status] || 0, count, `${key}.${status}`);
  }

  const statusTotal = Object.values(stage.statusCounts).reduce((sum, count) => sum + count, 0);
  const completed = Object.entries(stage.statusCounts)
    .filter(([status]) => TERMINAL_STATUSES.has(status))
    .reduce((sum, [, count]) => sum + count, 0);
  const exceptions = Object.entries(stage.statusCounts)
    .filter(([status]) => EXCEPTION_STATUSES.has(status))
    .reduce((sum, [, count]) => sum + count, 0);

  assert.equal(stage.total, statusTotal, `${key}.total`);
  assert.equal(stage.completed, completed, `${key}.completed`);
  assert.equal(stage.pending, statusTotal - completed, `${key}.pending`);
  assert.equal(stage.exceptions, exceptions, `${key}.exceptions`);
  assert.equal(stage.progress, statusTotal ? Math.round((completed / statusTotal) * 100) : null, `${key}.progress`);
}

function assertPipelineTotals(run) {
  assertFixedTaskKeys(run.stages);
  const stages = Object.values(run.stages);
  const taskCount = stages.reduce((sum, stage) => sum + stage.total, 0);
  const completed = stages.reduce((sum, stage) => sum + stage.completed, 0);
  const pending = stages.reduce((sum, stage) => sum + stage.pending, 0);
  const exceptions = stages.reduce((sum, stage) => sum + stage.exceptions, 0);

  assert.equal(run.pipelineTaskCount, taskCount);
  assert.equal(run.pipelineCompleted, completed);
  assert.equal(run.pipelinePending, pending);
  assert.equal(run.pipelineExceptions, exceptions);
  assert.equal(run.pipelineProgress, taskCount ? Math.round((completed / taskCount) * 100) : null);
}

test('legacy batches remain task-free after the four-stage schema migration', async t => {
  const dir = await useTemporaryDatabase(t, 'missav-manager-pipeline-legacy-');
  const runId = database.createProcessingRun({
    pipelineVersion: 1,
    items: [{ code: 'ABF-354', itemStatus: 'queued' }],
  });

  const run = database.getProcessingRun(runId);
  assert.equal(run.pipelineVersion, 1);
  assert.deepEqual(run.items[0].tasks, {});
  assertFixedTaskKeys(run.stages);
  for (const stage of Object.values(run.stages)) {
    assert.equal(stage.total, 0);
    assert.equal(stage.completed, 0);
    assert.equal(stage.pending, 0);
    assert.equal(stage.exceptions, 0);
    assert.equal(stage.progress, null);
  }
  assert.equal(run.pipelineTaskCount, 0);
  assert.equal(run.pipelineCompleted, 0);
  assert.equal(run.pipelinePending, 0);
  assert.equal(run.pipelineExceptions, 0);
  assert.equal(run.pipelineProgress, null);

  const recent = database.getRecentRuns(5).find(item => item.id === runId);
  assert.equal(recent.pipelineVersion, 1);
  assertPipelineTotals(recent);

  database.close();
  assert.equal(await countPersistedTasks(dir), 0);
});

test('v0.1.3 batch migration is idempotent and never backfills pipeline tasks', async t => {
  database.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-pipeline-v013-migration-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await createLegacyV013Database(dir);

  await database.init(dir);
  const first = database.getProcessingRun(1);
  assert.equal(first.pipelineVersion, 1);
  assert.equal(first.name, 'v0.1.3 interrupted batch');
  assert.equal(first.status, 'paused');
  assert.equal(first.total, 2);
  assert.equal(first.new, 2);
  assert.equal(first.completed, 1);
  assert.equal(first.pending, 1);
  assert.equal(first.progress, 50);
  assert.equal(first.pipelineTaskCount, 0);
  assert.equal(first.pipelineProgress, null);
  assert.deepEqual(first.items.map(item => ({
    id: item.id,
    position: item.position,
    code: item.code,
    itemStatus: item.itemStatus,
    status: item.status,
    url: item.url,
    finalTags: item.finalTags,
    includeInImport: item.includeInImport,
    attemptCount: item.attemptCount,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    updatedAt: item.updatedAt,
    tasks: item.tasks,
  })), [
    {
      id: 1,
      position: 0,
      code: 'ABF-354',
      itemStatus: 'completed',
      status: 'ok',
      url: 'https://missav.ai/cn/abf-354',
      finalTags: ['Actress One', 'Drama'],
      includeInImport: true,
      attemptCount: 2,
      startedAt: '2026-07-21 20:01:00',
      finishedAt: '2026-07-21 20:02:00',
      updatedAt: '2026-07-21 20:02:00',
      tasks: {},
    },
    {
      id: 2,
      position: 1,
      code: 'SONE-314',
      itemStatus: 'queued',
      status: 'queued',
      url: '',
      finalTags: [],
      includeInImport: false,
      attemptCount: 0,
      startedAt: '',
      finishedAt: '',
      updatedAt: '2026-07-21 20:03:00',
      tasks: {},
    },
  ]);
  assert.equal(database.getRawTableRows('processing_runs').total, 1);
  assert.equal(database.getRawTableRows('processing_run_items').total, 2);
  assert.equal(database.getRawTableRows('processing_item_tasks').total, 0);

  database.close();
  await database.init(dir);

  const second = database.getProcessingRun(1);
  assert.deepEqual(second, first);
  assert.equal(database.getRawTableRows('processing_runs').total, 1);
  assert.equal(database.getRawTableRows('processing_run_items').total, 2);
  assert.equal(database.getRawTableRows('processing_item_tasks').total, 0);
});

test('dual-pipeline batches create four independent tasks with correct initial states', async t => {
  const dir = await useTemporaryDatabase(t, 'missav-manager-pipeline-initial-');
  database.createCodeRecord('ABF-354', 'https://missav.ai/cn/abf-354', 'ok');

  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [
      {
        code: 'ABF-354',
        status: 'already_exists',
        itemStatus: 'skipped',
        skippedReason: 'Already in permanent history',
      },
      {
        code: 'ABF-354',
        status: 'duplicate_in_input',
        itemStatus: 'duplicate',
        skippedReason: 'Duplicate in this input',
      },
      { code: 'SONE-314', itemStatus: 'queued' },
    ],
  });

  const run = database.getProcessingRun(runId);
  assert.equal(run.pipelineVersion, 2);
  assert.equal(run.items.length, 3);
  run.items.forEach(item => assertFixedTaskKeys(item.tasks));

  assert.deepEqual(
    Object.fromEntries(TASK_KEYS.map(key => [key, run.items[0].tasks[key].status])),
    {
      missavLookup: 'succeeded',
      raindropSync: 'skipped',
      av123Lookup: 'queued',
      av123Favorite: 'blocked',
    },
  );
  assert.deepEqual(
    Object.fromEntries(TASK_KEYS.map(key => [key, run.items[1].tasks[key].status])),
    {
      missavLookup: 'skipped',
      raindropSync: 'skipped',
      av123Lookup: 'skipped',
      av123Favorite: 'skipped',
    },
  );
  assert.deepEqual(
    Object.fromEntries(TASK_KEYS.map(key => [key, run.items[2].tasks[key].status])),
    {
      missavLookup: 'queued',
      raindropSync: 'blocked',
      av123Lookup: 'queued',
      av123Favorite: 'blocked',
    },
  );

  assertStage(run, 'missavLookup', { succeeded: 1, skipped: 1, queued: 1 });
  assertStage(run, 'raindropSync', { skipped: 2, blocked: 1 });
  assertStage(run, 'av123Lookup', { skipped: 1, queued: 2 });
  assertStage(run, 'av123Favorite', { skipped: 1, blocked: 2 });
  assertPipelineTotals(run);
  assert.equal(run.pipelineTaskCount, 12);
  assert.equal(run.pipelineCompleted, 6);
  assert.equal(run.pipelinePending, 6);
  assert.equal(run.pipelineProgress, 50);

  database.close();
  assert.equal(await countPersistedTasks(dir), 12);
});

test('site-specific batches isolate tasks and freeze the known-actress snapshot', async t => {
  await useTemporaryDatabase(t, 'missav-manager-pipeline-toolbox-');
  const existingCodeId = database.createCodeRecord('ABF-354', 'https://missav.ai/cn/abf-354', 'ok');
  database.setCodeActressTags(existingCodeId, ['Known Actress']);

  const missavRunId = database.createProcessingRun({
    pipelineVersion: 2,
    toolKind: 'missav',
    items: [{ code: 'SONE-314', itemStatus: 'queued' }],
  });
  let run = database.getProcessingRun(missavRunId);
  assert.equal(run.toolKind, 'missav');
  assert.deepEqual(run.knownActresses, ['Known Actress']);
  assert.deepEqual(
    Object.fromEntries(TASK_KEYS.map(key => [key, run.items[0].tasks[key].status])),
    {
      missavLookup: 'queued',
      raindropSync: 'blocked',
      av123Lookup: 'skipped',
      av123Favorite: 'skipped',
    },
  );

  const laterCodeId = database.createCodeRecord('DASS-720', 'https://missav.ai/cn/dass-720', 'ok');
  database.setCodeActressTags(laterCodeId, ['Later Actress']);
  run = database.getProcessingRun(missavRunId);
  assert.deepEqual(run.knownActresses, ['Known Actress']);

  const av123RunId = database.createProcessingRun({
    pipelineVersion: 2,
    toolKind: 'av123',
    items: [{ code: 'START-203', itemStatus: 'queued' }],
  });
  run = database.getProcessingRun(av123RunId);
  assert.equal(run.toolKind, 'av123');
  assert.deepEqual(
    Object.fromEntries(TASK_KEYS.map(key => [key, run.items[0].tasks[key].status])),
    {
      missavLookup: 'skipped',
      raindropSync: 'skipped',
      av123Lookup: 'queued',
      av123Favorite: 'blocked',
    },
  );
});

test('123AV automatic favorite settings persist with the batch and remain independently adjustable', async t => {
  const dir = await useTemporaryDatabase(t, 'missav-manager-auto-favorite-settings-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    av123AutoFavorite: true,
    av123FavoriteConcurrency: 4,
    items: [{ code: 'SONE-314', itemStatus: 'queued' }],
  });

  let run = database.getProcessingRun(runId);
  assert.equal(run.av123AutoFavorite, true);
  assert.equal(run.av123FavoriteConcurrency, 4);

  database.setProcessingRunSpeedSettings(runId, {
    av123AutoFavorite: false,
    av123FavoriteConcurrency: 1,
  });
  run = database.getProcessingRun(runId);
  assert.equal(run.av123AutoFavorite, false);
  assert.equal(run.av123FavoriteConcurrency, 1);

  database.close();
  await database.init(dir);
  run = database.getProcessingRun(runId);
  assert.equal(run.av123AutoFavorite, false);
  assert.equal(run.av123FavoriteConcurrency, 1);
});

test('MissAV completion drives only MissAV and Raindrop while 123AV stays independent', async t => {
  await useTemporaryDatabase(t, 'missav-manager-pipeline-results-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [
      { code: 'SONE-314', itemStatus: 'queued' },
      { code: 'DASS-720', itemStatus: 'queued' },
      { code: 'JUQ-999', itemStatus: 'queued' },
    ],
  });

  const results = [
    {
      code: 'SONE-314',
      status: 'ok',
      url: 'https://missav.ai/cn/sone-314',
      finalTags: ['Actress One', 'Drama'],
      includeInImport: true,
    },
    {
      code: 'DASS-720',
      status: 'not_found',
      includeInImport: false,
    },
    {
      code: 'JUQ-999',
      status: 'network_error',
      error: 'timeout',
      includeInImport: false,
    },
  ];

  results.forEach((result, position) => {
    database.markProcessingRunItemRunning(runId, position);
    database.updateProcessingRunItem(runId, position, result, 'completed');
  });

  const run = database.getProcessingRun(runId);
  assert.deepEqual(
    run.items.map(item => [item.tasks.missavLookup.status, item.tasks.raindropSync.status]),
    [
      ['succeeded', 'ready'],
      ['not_found', 'skipped'],
      ['network_error', 'blocked'],
    ],
  );
  for (const item of run.items) {
    assert.equal(item.tasks.av123Lookup.status, 'queued');
    assert.equal(item.tasks.av123Favorite.status, 'blocked');
  }

  assertStage(run, 'missavLookup', { succeeded: 1, not_found: 1, network_error: 1 });
  assertStage(run, 'raindropSync', { ready: 1, skipped: 1, blocked: 1 });
  assertStage(run, 'av123Lookup', { queued: 3 });
  assertStage(run, 'av123Favorite', { blocked: 3 });
  assertPipelineTotals(run);
  assert.equal(run.pipelineCompleted, 3);
  assert.equal(run.pipelinePending, 9);
  assert.equal(run.pipelineExceptions, 1);
  assert.equal(run.pipelineProgress, 25);

  const recent = database.getRecentRuns(5).find(item => item.id === runId);
  assertPipelineTotals(recent);
  assert.deepEqual(recent.stages, run.stages);
});

test('restart requeues a running lookup and preserves terminal task states', async t => {
  const dir = await useTemporaryDatabase(t, 'missav-manager-pipeline-recovery-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [{ code: 'SONE-314', itemStatus: 'queued' }],
  });

  database.markProcessingRunItemRunning(runId, 0);
  database.updateProcessingItemTask(runId, 0, 'raindrop', 'sync', { status: 'succeeded' });
  database.updateProcessingItemTask(runId, 0, '123av', 'lookup', { status: 'not_found' });
  database.updateProcessingItemTask(runId, 0, '123av', 'favorite', { status: 'skipped' });

  let run = database.getProcessingRun(runId);
  assert.equal(run.items[0].tasks.missavLookup.status, 'running');
  assert.equal(run.pipelineCompleted, 3);
  assert.equal(run.pipelinePending, 1);

  database.close();
  await database.init(dir);

  run = database.getProcessingRun(runId);
  assert.equal(run.status, 'paused');
  assert.equal(run.items[0].itemStatus, 'queued');
  assert.deepEqual(
    Object.fromEntries(TASK_KEYS.map(key => [key, run.items[0].tasks[key].status])),
    {
      missavLookup: 'queued',
      raindropSync: 'succeeded',
      av123Lookup: 'not_found',
      av123Favorite: 'skipped',
    },
  );
  assertPipelineTotals(run);
  assert.equal(run.pipelineCompleted, 3);
  assert.equal(run.pipelinePending, 1);
  assert.equal(run.pipelineProgress, 75);
});

test('restart requires verification for interrupted sync and favorite side effects', async t => {
  const dir = await useTemporaryDatabase(t, 'missav-manager-pipeline-side-effect-recovery-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [{ code: 'SONE-314', itemStatus: 'queued' }],
  });

  database.markProcessingRunItemRunning(runId, 0);
  database.updateProcessingItemTask(runId, 0, 'raindrop', 'sync', { status: 'running' });
  database.updateProcessingItemTask(runId, 0, '123av', 'lookup', { status: 'running' });
  database.updateProcessingItemTask(runId, 0, '123av', 'favorite', { status: 'running' });

  let run = database.getProcessingRun(runId);
  assert.deepEqual(
    Object.fromEntries(TASK_KEYS.map(key => [key, run.items[0].tasks[key].status])),
    {
      missavLookup: 'running',
      raindropSync: 'running',
      av123Lookup: 'running',
      av123Favorite: 'running',
    },
  );

  database.close();
  await database.init(dir);

  run = database.getProcessingRun(runId);
  assert.equal(run.status, 'paused');
  assert.equal(run.items[0].itemStatus, 'queued');
  assert.deepEqual(
    Object.fromEntries(TASK_KEYS.map(key => [key, run.items[0].tasks[key].status])),
    {
      missavLookup: 'queued',
      raindropSync: 'verify_required',
      av123Lookup: 'queued',
      av123Favorite: 'verify_required',
    },
  );
  assert.equal(run.pipelineCompleted, 0);
  assert.equal(run.pipelinePending, 4);
  assert.equal(run.pipelineExceptions, 2);
  assert.equal(run.pipelineProgress, 0);
});

test('123AV lookup retry preserves MissAV and Raindrop state and only unlocks favorite on success', async t => {
  await useTemporaryDatabase(t, 'missav-manager-av123-independent-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [{ code: 'SONE-314', itemStatus: 'queued' }],
  });

  database.markProcessingRunItemRunning(runId, 0);
  database.updateProcessingRunItem(runId, 0, {
    code: 'SONE-314',
    status: 'ok',
    url: 'https://missav.ai/cn/sone-314',
    finalTags: ['Example'],
    includeInImport: true,
  }, 'completed');
  database.updateProcessingItemTask(runId, 0, '123av', 'lookup', {
    status: 'network_error',
    url: 'https://123av.com/cn/search?keyword=SONE-314',
    error: 'timeout',
    attemptCount: 1,
  });

  let item = database.getProcessingRun(runId).items[0];
  assert.equal(item.url, 'https://missav.ai/cn/sone-314');
  assert.equal(item.status, 'ok');
  assert.equal(item.tasks.missavLookup.status, 'succeeded');
  assert.equal(item.tasks.raindropSync.status, 'ready');
  assert.equal(item.tasks.av123Lookup.status, 'network_error');
  assert.equal(item.tasks.av123Favorite.status, 'blocked');

  database.updateProcessingItemTask(runId, 0, '123av', 'lookup', { status: 'running', error: '' });
  database.updateProcessingItemTask(runId, 0, '123av', 'lookup', {
    status: 'succeeded',
    url: 'https://123av.com/cn/v/sone-314',
    error: '',
    metadata: { responseKind: 'search', candidateCount: 1 },
    attemptCount: 2,
  });

  item = database.getProcessingRun(runId).items[0];
  assert.equal(item.url, 'https://missav.ai/cn/sone-314');
  assert.equal(item.tasks.missavLookup.status, 'succeeded');
  assert.equal(item.tasks.raindropSync.status, 'ready');
  assert.equal(item.tasks.av123Lookup.status, 'succeeded');
  assert.equal(item.tasks.av123Lookup.url, 'https://123av.com/cn/v/sone-314');
  assert.deepEqual(item.tasks.av123Lookup.metadata, { responseKind: 'search', candidateCount: 1 });
  assert.equal(item.tasks.av123Favorite.status, 'ready');
});

test('123AV favorite states persist independently and preserve MissAV data', async t => {
  await useTemporaryDatabase(t, 'missav-manager-av123-favorite-state-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [{ code: 'SONE-314', itemStatus: 'queued' }],
  });
  database.markProcessingRunItemRunning(runId, 0);
  database.updateProcessingRunItem(runId, 0, {
    code: 'SONE-314',
    status: 'ok',
    url: 'https://missav.ai/cn/sone-314',
    finalTags: ['Example'],
    includeInImport: true,
  }, 'completed');
  database.updateProcessingItemTask(runId, 0, '123av', 'lookup', {
    status: 'succeeded',
    url: 'https://123av.com/cn/v/sone-314',
  });
  database.updateProcessingItemTask(runId, 0, '123av', 'favorite', {
    status: 'not_logged_in',
    url: 'https://123av.com/cn/v/sone-314',
    error: 'account window is signed out',
    attemptCount: 1,
  });

  let run = database.getProcessingRun(runId);
  assert.equal(run.items[0].tasks.av123Favorite.status, 'not_logged_in');
  assert.equal(run.stages.av123Favorite.statusCounts.not_logged_in, 1);
  assert.equal(run.stages.av123Favorite.exceptions, 1);
  assert.equal(run.items[0].url, 'https://missav.ai/cn/sone-314');
  assert.deepEqual(run.items[0].finalTags, ['Example']);

  database.updateProcessingItemTask(runId, 0, '123av', 'favorite', { status: 'running', error: '' });
  database.updateProcessingItemTask(runId, 0, '123av', 'favorite', {
    status: 'succeeded',
    url: 'https://123av.com/cn/v/sone-314',
    metadata: { outcome: 'already_saved', clickAttempted: false },
    attemptCount: 2,
  });
  run = database.getProcessingRun(runId);
  assert.equal(run.items[0].tasks.av123Favorite.status, 'succeeded');
  assert.deepEqual(run.items[0].tasks.av123Favorite.metadata, { outcome: 'already_saved', clickAttempted: false });
  assert.equal(run.items[0].tasks.missavLookup.status, 'succeeded');
  assert.equal(run.items[0].tasks.raindropSync.status, 'ready');
  assert.equal(run.items[0].url, 'https://missav.ai/cn/sone-314');
});

test('pausing during 123AV lookup returns the read-only task to queued without reopening MissAV', async t => {
  await useTemporaryDatabase(t, 'missav-manager-av123-pause-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [{ code: 'SONE-314', itemStatus: 'queued' }],
  });
  database.markProcessingRunItemRunning(runId, 0);
  database.updateProcessingRunItem(runId, 0, {
    code: 'SONE-314', status: 'not_found', includeInImport: false,
  }, 'completed');
  database.updateProcessingItemTask(runId, 0, '123av', 'lookup', { status: 'running' });

  database.setProcessingRunStatus(runId, 'paused');
  const run = database.getProcessingRun(runId);
  assert.equal(run.status, 'paused');
  assert.equal(run.items[0].itemStatus, 'completed');
  assert.equal(run.items[0].tasks.missavLookup.status, 'not_found');
  assert.equal(run.items[0].tasks.av123Lookup.status, 'queued');
  assert.equal(run.lookupPending, 1);
  assert.equal(database.getResumableProcessingRun().id, runId);
});

test('deleting a processing run backs it up, removes every batch row, and keeps permanent codes', async t => {
  await useTemporaryDatabase(t, 'missav-manager-pipeline-delete-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [
      { code: 'SONE-314', itemStatus: 'queued' },
      { code: 'DASS-720', itemStatus: 'queued' },
    ],
  });

  assert.equal(database.getRawTableRows('processing_runs').total, 1);
  assert.equal(database.getRawTableRows('processing_run_items').total, 2);
  assert.equal(database.getRawTableRows('processing_item_tasks').total, 8);

  database.completeMissavProcessingRunItem(runId, 0, {
    code: 'SONE-314',
    url: 'https://missav.ai/cn/sone-314',
    status: 'ok',
    actresses: ['Test Actress'],
    genres: ['Drama'],
    finalTags: ['Test Actress', 'Drama'],
    includeInImport: true,
  }, 'completed');
  const deleted = database.deleteProcessingRun(runId);

  assert.equal(deleted.deleted, true);
  assert.equal(deleted.itemCount, 2);
  assert.equal(deleted.taskCount, 8);
  assert.equal(deleted.completedItems, 1);
  assert.equal(deleted.permanentCodeLinks, 1);
  assert.equal(deleted.permanentCodesKept, true);
  assert.equal(fs.existsSync(deleted.backup.filePath), true);
  assert.equal(database.getProcessingRun(runId), null);
  assert.equal(database.getRawTableRows('processing_runs').total, 0);
  assert.equal(database.getRawTableRows('processing_run_items').total, 0);
  assert.equal(database.getRawTableRows('processing_item_tasks').total, 0);
  assert.equal(database.findCode('SONE-314').code, 'SONE-314');
  const health = database.getHealthReport();
  assert.equal(health.summary.orphanProcessingTasks, 0);
  assert.deepEqual(health.issues.orphanProcessingTasks, []);
});

test('processing run creation rolls back every row when a later item is invalid', async t => {
  await useTemporaryDatabase(t, 'missav-manager-pipeline-create-rollback-');

  assert.throws(() => database.createProcessingRun({
    pipelineVersion: 2,
    name: 'Must roll back',
    items: [
      { code: 'SONE-314', itemStatus: 'queued' },
      { code: '   ', itemStatus: 'queued' },
      { code: 'DASS-720', itemStatus: 'queued' },
    ],
  }), /批次明细番号不能为空/);

  assert.equal(database.getRecentRuns(10).length, 0);
  assert.equal(database.getRawTableRows('processing_runs').total, 0);
  assert.equal(database.getRawTableRows('processing_run_items').total, 0);
  assert.equal(database.getRawTableRows('processing_item_tasks').total, 0);
  const health = database.getHealthReport();
  assert.equal(health.summary.orphanProcessingTasks, 0);
  assert.deepEqual(health.issues.orphanProcessingTasks, []);
});

test('MissAV completion persists permanent tags and the run item with one final database export', async t => {
  const dir = await useTemporaryDatabase(t, 'missav-manager-pipeline-complete-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    status: 'paused',
    items: [{ code: 'IPX-999', itemStatus: 'queued' }],
  });
  database.markProcessingRunItemRunning(runId, 0, { persist: false });
  database.completeMissavProcessingRunItem(runId, 0, {
    code: 'IPX-999',
    status: 'ok',
    url: 'https://missav.ai/cn/ipx-999',
    matchedActressTags: ['Actress A'],
    genres: ['剧情', '高清'],
    finalTags: ['Actress A', '剧情', '高清'],
    includeInImport: true,
  }, 'completed');

  database.close();
  await database.init(dir);
  const run = database.getProcessingRun(runId);
  assert.equal(run.items[0].tasks.missavLookup.status, 'succeeded');
  assert.equal(run.items[0].tasks.raindropSync.status, 'ready');
  assert.deepEqual(run.items[0].finalTags, ['Actress A', '剧情', '高清']);
  const code = database.getCodeLibrary({ search: 'IPX-999', limit: 10 })[0];
  assert.deepEqual(code.actress_tags, ['Actress A']);
  assert.deepEqual(code.genre_tags.sort(), ['剧情', '高清'].sort());
});

test('123AV lookup cache is committed with the task and survives batch deletion', async t => {
  const dir = await useTemporaryDatabase(t, 'missav-manager-123av-cache-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    status: 'paused',
    items: [{ code: 'ABF-356', itemStatus: 'queued' }],
  });

  const completed = database.completeProcessingItemTaskWithCache(runId, 0, '123av', 'lookup', {
    status: 'succeeded',
    url: 'https://123av.com/cn/v/abf-356',
    metadata: { responseKind: 'detail', lookupRoute: 'detail', statusCode: 200 },
    attemptCount: 1,
  }, {
    service: '123av',
    code: 'ABF-356',
    status: 'succeeded',
    url: 'https://123av.com/cn/v/abf-356',
    metadata: { responseKind: 'detail', lookupRoute: 'detail', statusCode: 200 },
  });
  assert.equal(completed.tasks.av123Lookup.status, 'succeeded');
  assert.equal(completed.tasks.av123Favorite.status, 'ready');
  assert.equal(database.getSiteLookupCache('123av', 'abf356').url, 'https://123av.com/cn/v/abf-356');

  database.close();
  await database.init(dir);
  assert.equal(database.getSiteLookupCache('123av', 'ABF-356').metadata.lookupRoute, 'detail');
  database.deleteProcessingRun(runId, { createBackup: false });
  assert.equal(database.getSiteLookupCache('123av', 'ABF-356').status, 'succeeded');
});

test('123AV task updates can be checkpointed in batches without partial cache state', async t => {
  const dir = await useTemporaryDatabase(t, 'missav-manager-123av-checkpoint-');
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [{ code: 'IPTD-543', itemStatus: 'queued' }],
  });
  database.completeProcessingItemTaskWithCache(runId, 0, '123av', 'lookup', {
    status: 'succeeded',
    url: 'https://123av.com/cn/v/iptd-543-uncensored-leaked',
    metadata: { responseKind: 'search', lookupRoute: 'search_fallback' },
    attemptCount: 2,
    persist: false,
  }, {
    service: '123av',
    code: 'IPTD-543',
    status: 'succeeded',
    url: 'https://123av.com/cn/v/iptd-543-uncensored-leaked',
    metadata: { responseKind: 'search', lookupRoute: 'search_fallback' },
  });

  const SQL = await initSqlJs();
  const readDisk = () => new SQL.Database(fs.readFileSync(path.join(dir, 'missav_data.db')));
  let disk = readDisk();
  assert.equal(disk.exec(`SELECT status FROM processing_item_tasks WHERE run_id = ${runId} AND service = '123av' AND action = 'lookup'`)[0].values[0][0], 'queued');
  assert.equal(disk.exec('SELECT COUNT(*) FROM site_lookup_cache')[0].values[0][0], 0);
  disk.close();

  database.save();
  disk = readDisk();
  assert.equal(disk.exec(`SELECT status FROM processing_item_tasks WHERE run_id = ${runId} AND service = '123av' AND action = 'lookup'`)[0].values[0][0], 'succeeded');
  assert.equal(disk.exec('SELECT COUNT(*) FROM site_lookup_cache')[0].values[0][0], 1);
  disk.close();
});
