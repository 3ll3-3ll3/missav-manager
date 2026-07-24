const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const database = require('../src/database');

async function temporaryDatabase(t) {
  database.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-remote-sync-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await database.init(dir);
  return dir;
}

test('Raindrop remote mapping and task completion persist atomically', async t => {
  await temporaryDatabase(t);
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [{
      code: 'ABF-354', itemStatus: 'completed', status: 'ok',
      url: 'https://missav.ai/cn/abf-354', finalTags: ['Test Actress', '剧情'], includeInImport: true,
    }],
  });
  assert.equal(database.getProcessingRun(runId).items[0].tasks.raindropSync.status, 'ready');

  database.completeRemoteSyncTask(runId, 0, {
    status: 'succeeded',
    url: 'https://missav.ai/cn/abf-354',
    metadata: { action: 'created', remoteId: 987 },
  }, {
    code: 'ABF-354',
    remoteId: 987,
    link: 'https://missav.ai/cn/abf-354',
    collectionId: 123,
    payloadHash: 'a'.repeat(64),
    status: 'succeeded',
    metadata: { action: 'created' },
  });

  const task = database.getProcessingRun(runId).items[0].tasks.raindropSync;
  assert.equal(task.status, 'succeeded');
  assert.equal(task.metadata.remoteId, 987);
  assert.deepEqual(database.getRemoteSyncRecord('raindrop', 'abf354'), {
    service: 'raindrop',
    codeKey: 'ABF354',
    code: 'ABF-354',
    remoteId: '987',
    link: 'https://missav.ai/cn/abf-354',
    collectionId: 123,
    payloadHash: 'a'.repeat(64),
    status: 'succeeded',
    metadata: { action: 'created' },
    syncedAt: database.getRemoteSyncRecord('raindrop', 'ABF-354').syncedAt,
    updatedAt: database.getRemoteSyncRecord('raindrop', 'ABF-354').updatedAt,
  });
});

test('interrupted Raindrop side effect is recovered as verify_required', async t => {
  const dir = await temporaryDatabase(t);
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    items: [{ code: 'SONE-314', itemStatus: 'completed', status: 'ok', url: 'https://missav.ai/cn/sone-314', includeInImport: true }],
  });
  database.updateProcessingItemTask(runId, 0, 'raindrop', 'sync', { status: 'running' });
  database.close();
  await database.init(dir);
  const task = database.getProcessingRun(runId).items[0].tasks.raindropSync;
  assert.equal(task.status, 'verify_required');
  assert.match(task.error, /核验远端状态/);
});
