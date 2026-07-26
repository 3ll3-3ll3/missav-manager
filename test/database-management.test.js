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
  const historyId = database.createToolHistory({
    toolKind: 'twitter',
    name: 'Reset Twitter History',
    sourceLabel: 'Reset Fixture Group',
    timeStart: '2026-07-23T00:00:00Z',
    timeEnd: '2026-07-23T01:00:00Z',
    inputCount: 1,
    items: [{
      primaryText: 'example_user',
      secondaryText: 'https://x.com/example_user',
    }],
  }).id;

  const before = database.getDatabaseInventory();
  assert.ok(before.businessRows > 0);
  assert.ok(before.tables.find(table => table.name === 'processing_item_tasks').rowCount >= 4);
  assert.equal(before.tables.find(table => table.name === 'tool_history_runs').rowCount, 1);
  assert.equal(before.tables.find(table => table.name === 'tool_history_items').rowCount, 1);
  assert.equal(database.getProcessingRun(runId).name, 'reset fixture');
  assert.equal(database.getToolHistory(historyId).name, 'Reset Twitter History');
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
  assert.equal(database.getToolHistory(historyId).items[0].primaryText, 'example_user');
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

test('advanced table editor provides guarded CRUD for task history and Telegram tables', async t => {
  database.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-raw-complete-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await database.init(dir);

  const publicTables = database.getEditableTables()
    .filter(table => !['bookmarks', 'bookmark_collections'].includes(table.name));
  assert.equal(publicTables.every(table => table.insertable.length > 0), true);

  const runId = database.insertRawRow('processing_runs', {
    name: '手动维护批次',
    tool_kind: 'missav',
    status: 'paused',
    known_actresses_json: '[]',
    total_codes: '1',
  });
  const itemId = database.insertRawRow('processing_run_items', {
    run_id: String(runId),
    position: '0',
    code: 'ABF-354',
    item_status: 'queued',
    actresses_json: '[]',
    genres_json: '[]',
    final_tags_json: '[]',
  });
  const taskId = database.insertRawRow('processing_item_tasks', {
    run_id: String(runId),
    run_item_id: String(itemId),
    service: 'missav',
    action: 'lookup',
    status: 'queued',
    metadata_json: '{}',
  });
  database.updateRawCell('processing_run_items', { id: itemId }, 'error', '人工备注');
  database.updateRawCell('processing_item_tasks', { id: taskId }, 'status', 'succeeded');
  assert.equal(database.getRawTableRows('processing_run_items', { search: '人工备注' }).rows.length, 1);
  assert.throws(() => database.insertRawRow('processing_item_tasks', {
    run_id: String(runId + 999),
    run_item_id: String(itemId),
    service: 'missav',
    action: 'lookup',
  }), /处理批次不存在/);

  const historyId = database.insertRawRow('tool_history_runs', {
    tool_kind: 'twitter',
    name: '手动历史',
    metadata_json: '{}',
  });
  const historyItemId = database.insertRawRow('tool_history_items', {
    history_id: String(historyId),
    position: '0',
    primary_text: 'example_user',
    secondary_text: 'https://x.com/example_user',
    metadata_json: '{}',
  });
  assert.equal(database.getRawTableRows('tool_history_items', { search: 'example_user' }).rows.length, 1);

  const sourceId = database.insertRawRow('telegram_sources', {
    source_key: 'manual:test-source',
    source_type: 'manual',
    source_label: '测试频道',
    is_selected: '1',
  });
  const messageId = database.insertRawRow('telegram_message_refs', {
    source_id: String(sourceId),
    dedupe_key: 'manual:test-message',
    source_type: 'manual',
    content_hash: 'abc123',
    codes_json: '["ABF-354"]',
  });
  const importId = database.insertRawRow('telegram_import_runs', {
    source_id: String(sourceId),
    source_type: 'manual',
    source_label: '测试频道',
    status: 'completed',
    errors_json: '[]',
  });
  database.updateRawCell('telegram_sources', { id: sourceId }, 'source_label', '已修改频道');
  assert.equal(database.getRawTableRows('telegram_sources', { search: '已修改频道' }).rows.length, 1);

  database.deleteRawRow('telegram_import_runs', { id: importId });
  database.deleteRawRow('telegram_message_refs', { id: messageId });
  database.deleteRawRow('telegram_sources', { id: sourceId });
  database.deleteRawRow('tool_history_items', { id: historyItemId });
  database.deleteRawRow('tool_history_runs', { id: historyId });
  database.deleteRawRow('processing_item_tasks', { id: taskId });
  database.deleteRawRow('processing_run_items', { id: itemId });
  database.deleteRawRow('processing_runs', { id: runId });
  assert.equal(database.getRawTableRows('processing_runs').total, 0);
  assert.equal(database.getRawTableRows('tool_history_runs').total, 0);
  assert.equal(database.getRawTableRows('telegram_sources').total, 0);
});
