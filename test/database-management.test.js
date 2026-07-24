const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const database = require('../src/database');

test('full database reset backs up every business table, clears it, and remains restorable', async t => {
  database.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-full-reset-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await database.init(dir);

  const codeId = database.createCodeRecord('ABF-354', 'https://missav.ai/cn/abf-354', 'ok');
  database.setCodeActressTags(codeId, ['Example Actress']);
  database.setCodeGenreTags(codeId, ['剧情']);
  database.createBookmarkCollection('Legacy');
  database.createBookmarkRecord({ title: 'Legacy ABF-354', url: 'https://missav.ai/cn/abf-354', folder: 'Legacy', code: 'ABF-354' });
  const runId = database.createProcessingRun({
    pipelineVersion: 2,
    name: 'reset fixture',
    items: [{ code: 'ABF-354', itemStatus: 'completed', status: 'ok', url: 'https://missav.ai/cn/abf-354', includeInImport: true }],
  });
  database.upsertSiteLookupCache({
    service: '123av',
    code: 'ABF-354',
    status: 'succeeded',
    url: 'https://123av.com/cn/v/abf-354',
  });
  database.insertRawRow('remote_sync_records', {
    service: 'raindrop',
    code_key: 'ABF354',
    code: 'ABF-354',
    remote_id: '123',
    link: 'https://missav.ai/cn/abf-354',
    collection_id: '9',
    payload_hash: 'a'.repeat(64),
    status: 'succeeded',
    metadata_json: '{"action":"created"}',
  });
  database.recordTelegramImport({
    sourceKey: 'telegram-export:reset-fixture',
    sourceType: 'export_json',
    sourceLabel: 'Reset Fixture Group',
    accountKey: '42',
    chatKey: '-1001',
    messages: [{
      sourceType: 'export_json',
      sourceLabel: 'Reset Fixture Group',
      accountKey: '42',
      chatKey: '-1001',
      messageId: '1',
      messageDate: '2026-07-23T00:00:00Z',
      editedAt: '',
      text: 'ABF-354',
    }],
  });

  const before = database.getDatabaseInventory();
  assert.ok(before.businessRows > 0);
  assert.ok(before.tables.find(table => table.name === 'processing_item_tasks').rowCount >= 4);
  assert.equal(database.getProcessingRun(runId).name, 'reset fixture');
  assert.throws(() => database.resetAllBusinessData({ confirmText: '错误确认' }), /清空全部数据/);

  const reset = database.resetAllBusinessData({ confirmText: '清空全部数据', backupLabel: 'test reset' });
  assert.equal(reset.reset, true);
  assert.equal(reset.after.businessRows, 0);
  assert.ok(fs.existsSync(reset.backup.filePath));
  assert.equal(reset.backup.reason, 'pre_full_reset');
  assert.equal(reset.after.tables.every(table => table.rowCount === 0), true);
  assert.equal(database.getStats().codeCount, 0);

  const firstIdAfterReset = database.createCodeRecord('SONE-314', '', 'historical');
  assert.equal(firstIdAfterReset, 1, 'AUTOINCREMENT sequences should restart after a full reset');
  database.deleteCodeRecord(firstIdAfterReset);

  const restored = database.restoreBackup(reset.backup.fileName);
  assert.equal(restored.restored, true);
  assert.equal(database.findCode('ABF-354').found, true);
  assert.equal(database.getDatabaseInventory().businessRows, before.businessRows);
});

test('advanced table editor validates JSON and supports bulk updates and deletes', async t => {
  database.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-raw-bulk-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await database.init(dir);
  const first = database.createCodeRecord('ABF-354', '', 'historical');
  const second = database.createCodeRecord('SONE-314', '', 'historical');
  const raw = database.getRawTableRows('codes', { limit: 10 });
  const pks = raw.rows.map(row => ({ id: row.id }));
  const updated = database.bulkUpdateRawCells('codes', pks, 'status', 'ok');
  assert.equal(updated.updated, 2);
  assert.equal(database.findCode('ABF-354').status, 'ok');
  assert.equal(database.findCode('SONE-314').status, 'ok');

  database.insertRawRow('site_lookup_cache', {
    service: '123av',
    code_key: 'ABF354',
    code: 'ABF-354',
    status: 'succeeded',
    url: 'https://123av.com/cn/v/abf-354',
    metadata_json: '{"source":"manual"}',
  });
  assert.throws(
    () => database.bulkUpdateRawCells('site_lookup_cache', [{ service: '123av', code_key: 'ABF354' }], 'metadata_json', '{bad json'),
    /有效 JSON/,
  );
  const exported = database.exportRawTableRows('site_lookup_cache');
  assert.equal(exported.rows.length, 1);
  assert.equal(exported.columns.includes('metadata_json'), true);

  const deleted = database.bulkDeleteRawRows('codes', [{ id: first }, { id: second }]);
  assert.equal(deleted.deleted, 2);
  assert.equal(database.getStats().codeCount, 0);
});
