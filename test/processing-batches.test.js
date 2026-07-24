const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const database = require('../src/database');

test('persists batch items and resumes an interrupted batch without losing permanent history', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-batches-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await database.init(dir);
  database.createCodeRecord('ABF-354', 'https://missav.ai/cn/abf-354', 'ok');

  const runId = database.createProcessingRun({
    name: 'TG 7月21日',
    sourceType: 'file',
    sourceLabel: 'raindrop.csv · 4 条',
    speedMode: 'fast',
    missavSpeedMode: 'fast',
    missavSpeedPolicy: 'balanced',
    missavRateMode: 'adaptive',
    missavRateCap: 20,
    av123SpeedMode: 'extreme',
    av123SpeedPolicy: 'balanced',
    av123RateMode: 'adaptive',
    av123RateCap: 18,
    outputDir: 'E:\\Exports',
    items: [
      { code: 'ABF-354', status: 'already_exists', itemStatus: 'skipped', skippedReason: '已存在于数据库' },
      { code: 'ABF-354', status: 'duplicate_in_input', itemStatus: 'duplicate', skippedReason: '本次输入重复' },
      { code: 'SONE-314', itemStatus: 'queued' },
      { code: 'DASS-720', itemStatus: 'queued' },
    ],
  });

  let batch = database.getProcessingRun(runId);
  assert.equal(batch.name, 'TG 7月21日');
  assert.equal(batch.total, 4);
  assert.equal(batch.new, 2);
  assert.equal(batch.skipped, 1);
  assert.equal(batch.duplicate, 1);
  assert.equal(batch.pending, 2);
  assert.equal(batch.missavSpeedMode, 'fast');
  assert.equal(batch.missavSpeedPolicy, 'balanced');
  assert.equal(batch.missavRateMode, 'adaptive');
  assert.equal(batch.missavRateCap, 20);
  assert.equal(batch.av123SpeedMode, 'extreme');
  assert.equal(batch.av123SpeedPolicy, 'balanced');
  assert.equal(batch.av123RateMode, 'adaptive');
  assert.equal(batch.av123RateCap, 18);
  assert.deepEqual(batch.items.map(item => item.itemStatus), ['skipped', 'duplicate', 'queued', 'queued']);

  database.setProcessingRunSpeedSettings(runId, {
    missavSpeedMode: 'smart',
    missavSpeedPolicy: 'fixed',
    missavRateMode: 'fixed',
    missavRateCap: 28,
    av123SpeedMode: 'rocket',
    av123SpeedPolicy: 'fixed',
    av123RateMode: 'fixed',
    av123RateCap: 22,
  });
  batch = database.getProcessingRun(runId);
  assert.equal(batch.missavSpeedMode, 'smart');
  assert.equal(batch.missavSpeedPolicy, 'fixed');
  assert.equal(batch.missavRateMode, 'fixed');
  assert.equal(batch.missavRateCap, 28);
  assert.equal(batch.av123SpeedMode, 'rocket');
  assert.equal(batch.av123SpeedPolicy, 'fixed');
  assert.equal(batch.av123RateMode, 'fixed');
  assert.equal(batch.av123RateCap, 22);

  database.markProcessingRunItemRunning(runId, 2);
  database.upsertCode('SONE-314', 'https://missav.ai/cn/sone-314', 'ok');
  database.updateProcessingRunItem(runId, 2, {
    code: 'SONE-314',
    status: 'ok',
    url: 'https://missav.ai/cn/sone-314',
    actresses: ['Actress One'],
    genres: ['Drama'],
    finalTags: ['Actress One', 'Drama'],
    includeInImport: true,
    attemptCount: 1,
  }, 'completed');

  batch = database.getProcessingRun(runId);
  assert.equal(batch.completed, 3);
  assert.equal(batch.pending, 1);
  assert.deepEqual(batch.items[2].finalTags, ['Actress One', 'Drama']);
  assert.equal(batch.items[2].codeId, database.findCode('SONE314').code_id);

  // 模拟程序在最后一条运行中退出。重新初始化时应转为暂停和待处理。
  database.markProcessingRunItemRunning(runId, 3);
  database.close();
  await database.init(dir);

  batch = database.getProcessingRun(runId);
  assert.equal(batch.status, 'paused');
  assert.equal(batch.missavSpeedMode, 'smart');
  assert.equal(batch.missavSpeedPolicy, 'fixed');
  assert.equal(batch.missavRateMode, 'fixed');
  assert.equal(batch.missavRateCap, 28);
  assert.equal(batch.av123SpeedMode, 'rocket');
  assert.equal(batch.av123SpeedPolicy, 'fixed');
  assert.equal(batch.pending, 1);
  assert.equal(batch.items[3].itemStatus, 'queued');
  assert.equal(database.getResumableProcessingRun().id, runId);

  database.setProcessingRunStatus(runId, 'running');
  database.markProcessingRunItemRunning(runId, 3);
  database.upsertCode('DASS-720', 'https://missav.ai/cn/dass-720', 'network_error');
  database.updateProcessingRunItem(runId, 3, {
    code: 'DASS-720',
    status: 'network_error',
    url: 'https://missav.ai/cn/dass-720',
    error: 'timeout',
    skippedReason: '网络错误',
    includeInImport: false,
  }, 'completed');
  database.finishProcessingRun(runId, null, 'completed');

  batch = database.getProcessingRun(runId);
  assert.equal(batch.status, 'completed');
  assert.equal(batch.pending, 0);
  assert.equal(batch.networkError, 1);
  assert.equal(database.getResumableProcessingRun(), null);
  assert.equal(database.findCode('ABF-354').found, true);
  assert.equal(database.findCode('SONE-314').status, 'ok');
  assert.equal(database.findCode('DASS-720').status, 'network_error');
});
