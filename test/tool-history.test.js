const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const database = require('../src/database');

test('persists, searches, renames, and deletes isolated text-tool history', async t => {
  database.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-tool-history-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await database.init(dir);

  const twitter = database.createToolHistory({
    toolKind: 'twitter',
    name: '推特 7 月批次',
    sourceLabel: '两个绑定频道',
    timeStart: '2026-07-01T10:00',
    timeEnd: '2026-07-01T11:00',
    inputCount: 25,
    items: [
      { primaryText: 'first_user', secondaryText: 'https://x.com/first_user' },
      { primaryText: 'second_user', secondaryText: 'https://x.com/second_user' },
    ],
  });
  const badnews = database.createToolHistory({
    toolKind: 'badnews',
    name: 'Bad.news 快照',
    items: ['https://bad.news/t/123'],
  });

  assert.equal(twitter.resultCount, 2);
  assert.equal(twitter.items[1].primaryText, 'second_user');
  assert.equal(badnews.toolKind, 'badnews');
  assert.equal(database.getToolHistories('twitter').total, 1);
  assert.equal(database.getToolHistories('badnews').total, 1);
  assert.equal(database.getToolHistories('twitter', { search: 'second_user' }).rows[0].id, twitter.id);
  assert.equal(database.getToolHistories('twitter', { search: 'bad.news' }).total, 0);

  assert.equal(database.renameToolHistory(twitter.id, '已复查推特批次'), true);
  assert.equal(database.getToolHistory(twitter.id).name, '已复查推特批次');
  assert.equal(database.getStats().toolHistoryRunCount, 2);
  assert.equal(database.getStats().toolHistoryItemCount, 3);

  const deleted = database.deleteToolHistory(twitter.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.resultCount, 2);
  assert.equal(database.getToolHistory(twitter.id), null);
  assert.equal(database.getStats().toolHistoryItemCount, 1);
  assert.throws(() => database.createToolHistory({
    toolKind: 'missav',
    items: ['ABF-354'],
  }), /批次历史/);
});
