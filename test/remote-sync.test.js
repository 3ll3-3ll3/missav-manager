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

test('permanent code library owns the global Raindrop queue independently of batches', async t => {
  await temporaryDatabase(t);
  const sourceUrl = 'https://missav.ai/dm15/meyd-916-uncensored-leak';
  assert.deepEqual(database.registerInputCodes([{ code: 'MEYD-916', sourceUrl }]), {
    inserted: 1,
    sourceUrlsAdded: 1,
    total: 1,
  });
  const firstSeen = database.findCode('MEYD-916');
  assert.equal(firstSeen.status, 'pending');
  assert.equal(firstSeen.sourceUrl, sourceUrl);

  database.persistProcessedCode({
    code: 'MEYD-916',
    url: sourceUrl,
    status: 'ok',
    actresses: ['测试女优'],
    matchedActressTags: ['测试女优'],
    genres: ['剧情'],
    finalTags: ['测试女优', '剧情'],
    raindropTarget: 'missav2',
    includeInImport: true,
  });
  const pending = database.getGlobalRaindropRows({ scope: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].code, 'MEYD-916');
  assert.equal(pending[0].raindropTarget, 'missav2');
  assert.deepEqual(pending[0].finalTags.sort(), ['剧情', '测试女优'].sort());

  const av123OnlyRun = database.createProcessingRun({
    pipelineVersion: 2,
    toolKind: 'av123',
    items: [{ code: 'MEYD-916', itemStatus: 'queued' }],
  });
  assert.equal(database.getProcessingRun(av123OnlyRun).items[0].tasks.raindropSync.status, 'skipped');

  database.completeGlobalRaindropSync('MEYD-916', {
    status: 'succeeded',
    url: sourceUrl,
    remoteId: 1234,
    collectionId: 88,
    metadata: { collectionLabel: 'missav2' },
  }, {
    remoteId: 1234,
    link: sourceUrl,
    collectionId: 88,
    payloadHash: 'b'.repeat(64),
    status: 'succeeded',
  });
  assert.equal(database.getGlobalRaindropRows({ scope: 'pending' }).length, 0);
  const all = database.getGlobalRaindropRows({ scope: 'all' });
  assert.equal(all.length, 1);
  assert.equal(all[0].raindropStatus, 'succeeded');
  assert.equal(all[0].remoteRecord.remoteId, '1234');
  assert.equal(database.getProcessingRun(av123OnlyRun).items[0].tasks.raindropSync.status, 'skipped');

  database.completeGlobalRaindropSync('MEYD-916', {
    status: 'network_error',
    url: sourceUrl,
    collectionId: 88,
    error: 'temporary network issue',
  });
  const errors = database.getGlobalRaindropRows({ scope: 'errors' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].raindropError, 'temporary network issue');
});

test('Raindrop Pull creates a permanent local record and stores a mirror snapshot', async t => {
  await temporaryDatabase(t);
  const result = database.applyRaindropPullRecord({
    code: 'ABF-354',
    remoteId: 7001,
    link: 'https://missav.ai/dm15/abf-354-uncensored-leak',
    title: 'ABF-354 remote title',
    tags: ['Remote Actress', '剧情'],
    excerpt: 'remote excerpt',
    note: 'remote note',
    cover: 'https://example.com/cover.jpg',
    created: '2026-07-25T00:00:00.000Z',
    collectionId: 81,
    collectionLabel: 'JAV / missav2',
    payloadHash: 'c'.repeat(64),
    remoteHash: 'c'.repeat(64),
    remoteLastUpdate: '2026-07-25T01:00:00.000Z',
  });

  assert.deepEqual(result, {
    codeId: result.codeId,
    code: 'ABF-354',
    created: true,
    remoteId: 7001,
    collectionId: 81,
  });
  const code = database.findCode('ABF-354');
  assert.equal(code.found, true);
  assert.equal(code.status, 'historical');
  assert.equal(code.url, 'https://missav.ai/dm15/abf-354-uncensored-leak');
  assert.equal(code.raindropStatus, 'succeeded');
  assert.equal(code.raindropTarget, 'missav2');
  assert.equal(code.raindropRemoteId, '7001');

  const mirror = database.getRemoteSyncRecord('raindrop', 'ABF-354');
  assert.equal(mirror.remoteId, '7001');
  assert.equal(mirror.collectionId, 81);
  assert.equal(mirror.payloadHash, 'c'.repeat(64));
  assert.equal(mirror.metadata.direction, 'pull');
  assert.equal(mirror.metadata.remoteHash, 'c'.repeat(64));

  const rows = database.getRaindropSyncLocalRows({ scope: 'all' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].finalTags, ['Remote Actress', '剧情']);
  assert.equal(rows[0].eligibleForPush, true);
  const libraryRow = database.getCodeLibraryPage({ page: 1, pageSize: 20 }).rows[0];
  assert.deepEqual(libraryRow.raindrop_tag_list, ['Remote Actress', '剧情']);
  assert.deepEqual(libraryRow.final_tags, ['Remote Actress', '剧情']);
});

test('Raindrop Pull links remote tags that already exist in the local actress and genre dictionaries', async t => {
  await temporaryDatabase(t);
  database.createActressTag('Remote Actress');
  database.createGenreTag('剧情');
  database.applyRaindropPullRecord({
    code: 'IPX-777',
    remoteId: 7010,
    link: 'https://missav.ai/cn/ipx-777',
    title: 'IPX-777',
    tags: ['Remote Actress', '剧情', 'Remote Custom'],
    collectionId: 81,
    collectionLabel: 'JAV / missav2',
    payloadHash: 'e'.repeat(64),
    remoteHash: 'e'.repeat(64),
  });

  const row = database.getCodeLibraryPage({ page: 1, pageSize: 20 }).rows[0];
  assert.deepEqual(row.actress_tags, ['Remote Actress']);
  assert.deepEqual(row.genre_tags, ['剧情']);
  assert.deepEqual(row.raindrop_tag_list, ['Remote Actress', '剧情', 'Remote Custom']);
  assert.deepEqual(row.final_tags, ['Remote Actress', '剧情', 'Remote Custom']);
});

test('Raindrop Pull updates mirror fields and winning link without replacing tag relations', async t => {
  await temporaryDatabase(t);
  database.persistProcessedCode({
    code: 'SONE-314',
    url: 'https://missav.ai/cn/sone-314',
    status: 'ok',
    matchedActressTags: ['Local Actress'],
    genres: ['Local Genre'],
    finalTags: ['Local Actress', 'Local Genre'],
    includeInImport: true,
  });
  database.applyRaindropPullRecord({
    code: 'SONE-314',
    remoteId: 7002,
    link: 'https://missav.ai/dm15/sone-314-uncensored-leak',
    title: 'Remote title',
    tags: ['Remote Tag'],
    collectionId: 82,
    collectionLabel: 'Selected',
    payloadHash: 'd'.repeat(64),
    remoteHash: 'd'.repeat(64),
  });

  const code = database.findCode('SONE-314');
  assert.equal(code.status, 'ok');
  assert.equal(code.url, 'https://missav.ai/dm15/sone-314-uncensored-leak');
  const rows = database.getRaindropSyncLocalRows({ scope: 'all' });
  assert.deepEqual(rows[0].actresses, ['Local Actress']);
  assert.deepEqual(rows[0].genres, ['Local Genre']);
  assert.deepEqual(rows[0].finalTags, ['Remote Tag']);
  assert.equal(rows[0].remoteRecord.remoteId, '7002');
});

test('Raindrop Pull rejects a remote link whose code differs from the local identity', async t => {
  await temporaryDatabase(t);
  assert.throws(() => database.applyRaindropPullRecord({
    code: 'ABF-354',
    remoteId: 7003,
    link: 'https://missav.ai/cn/ipx-777',
    collectionId: 81,
  }), /番号.*不一致/);
  assert.equal(database.findCode('ABF-354').found, false);
  assert.equal(database.findCode('IPX-777').found, false);
});
