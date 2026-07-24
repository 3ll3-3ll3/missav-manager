const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const database = require('../src/database');

test('persists records and safely creates and restores backups', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-test-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await database.init(dir);
  const codeId = database.createCodeRecord('abf354', 'https://missav.ai/cn/abf-354', 'ok');
  database.setCodeActressTags(codeId, ['Example Actress']);
  assert.equal(database.getBookmarkStats().count, 0, '番号记录不应再自动生成本地收藏');

  const first = database.createBackup('same label');
  const second = database.createBackup('same label');
  assert.notEqual(first.fileName, second.fileName);
  assert.equal(fs.existsSync(first.filePath), true);
  assert.equal(fs.existsSync(second.filePath), true);

  database.updateCodeRecord(codeId, { status: 'not_found' });
  const restored = database.restoreBackup(first.fileName);
  assert.equal(restored.restored, true);
  assert.equal(database.findCode('ABF-354').status, 'ok');

  const SQL = await initSqlJs();
  const unrelated = new SQL.Database();
  unrelated.run('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
  const invalidPath = path.join(database.getBackupDirectory(), 'invalid.db');
  fs.writeFileSync(invalidPath, Buffer.from(unrelated.export()));
  unrelated.close();

  assert.throws(() => database.restoreBackup('invalid.db'), /缺少必要数据表/);
  assert.equal(database.findCode('ABF-354').found, true);

  const comparison = database.analyzeCodeImport(['ABF354', 'SONE-314', 'FC2 4625027']);
  assert.equal(comparison.total, 3);
  assert.equal(comparison.existingCount, 1);
  assert.equal(comparison.newCount, 2);

  const historyImport = database.importHistoricalRecords([
    { code: 'ABF-354' },
    { code: 'SONE-314', url: 'https://missav.ai/cn/sone-314', title: 'Imported title', folder: 'Archive', tags: 'tag-a,tag-b', note: 'Imported note' },
    { code: 'FC2-PPV-4625027' },
  ]);
  assert.deepEqual(historyImport, { imported: 2, existing: 1, total: 3 });
  assert.equal(database.findCode('SONE314').status, 'historical');
  const importedRow = database.getCodeLibrary({ search: 'SONE-314', limit: 10 })[0];
  assert.equal(importedRow.raindrop_title, 'Imported title');
  assert.equal(importedRow.raindrop_folder, 'Archive');
  assert.equal(importedRow.raindrop_note, 'Imported note');

  const raindropImport = database.importRaindropRecords([
    { raindrop_id: 'rd-1', title: 'General bookmark', url: 'https://example.com/page', folder: 'Research / Inbox', tags: 'alpha,beta', created: '2026-07-12T10:00:00.000Z', favorite: true, highlights: 'Important quote' },
    { raindrop_id: 'rd-2', title: 'ABP-721', url: 'https://missav.ai/cn/abp-721', folder: '日本av', tags: 'tag-c' },
    { raindrop_id: 'rd-3', title: 'ABP-721 duplicate collection', url: 'https://missav.ai/cn/abp-721', folder: 'Archive', tags: 'tag-d' },
  ]);
  assert.equal(raindropImport.imported, 3);
  assert.equal(raindropImport.codeLinked, 2);
  const htmlSupplement = database.importRaindropRecords([
    { title: 'ABP-721', url: 'https://missav.ai/cn/abp-721', folder: '日本av', note: 'Primary copy' },
    { title: 'ABP-721 duplicate collection', url: 'https://missav.ai/cn/abp-721', folder: 'Archive', note: 'Archive copy' },
  ]);
  assert.equal(htmlSupplement.updated, 2);
  const duplicateBookmarks = database.getBookmarkLibrary({ search: 'ABP-721', limit: 10 });
  assert.equal(duplicateBookmarks.length, 2);
  assert.equal(duplicateBookmarks.find(row => row.raindrop_folder === '日本av').raindrop_note, 'Primary copy');
  assert.equal(duplicateBookmarks.find(row => row.raindrop_folder === 'Archive').raindrop_note, 'Archive copy');
  assert.equal(database.findCode('ABP721').found, true);
  const bookmark = database.getBookmarkLibrary({ search: 'General bookmark', limit: 10 })[0];
  assert.equal(bookmark.raindrop_folder, 'Research / Inbox');
  assert.equal(bookmark.favorite, true);
  assert.equal(bookmark.highlights, 'Important quote');
  database.updateBookmarkRecord(bookmark.id, { raindrop_note: 'Edited locally' });
  assert.equal(database.getBookmarkLibrary({ search: 'General bookmark', limit: 10 })[0].raindrop_note, 'Edited locally');
  const indexedBookmark = database.getBookmarkLibrary({ search: 'ABP-721', limit: 10 })[0];
  database.updateBookmarkRecord(indexedBookmark.id, { code: '' });
  const unlinkedBookmark = database.getBookmarkLibrary({ search: 'ABP-721', limit: 10 }).find(row => row.id === indexedBookmark.id);
  assert.equal(unlinkedBookmark.code, '');
  assert.equal(unlinkedBookmark.source_code_id, null);
  assert.equal(database.findCode('ABP-721').found, true);
  assert.equal(database.exportRaindropRecords().some(row => row.raindrop_id === 'rd-1'), true);
  assert.equal(database.exportRaindropRecords().filter(row => row.code === 'ABP-721').length, 1);

  database.createBookmarkCollection('Research / Someday');
  assert.equal(database.getBookmarkCollections().some(row => row.path === 'Research / Someday'), true);
  const renamed = database.renameBookmarkCollection('Research', 'Knowledge');
  assert.equal(renamed.movedBookmarks, 1);
  assert.equal(database.getBookmarkLibrary({ search: 'General bookmark', limit: 10 })[0].raindrop_folder, 'Knowledge / Inbox');
  const collectionInfo = database.getBookmarkCollectionInfo('Knowledge');
  assert.equal(collectionInfo.bookmarkCount, 1);
  assert.equal(collectionInfo.childCount, 2);
  database.createBookmarkRecord({ title: 'MEYD-123', url: 'https://missav.ai/cn/meyd-123', folder: 'Disposable', code: 'MEYD-123' });
  assert.equal(database.findCode('MEYD-123').found, true);
  const disposable = database.deleteBookmarkCollection('Disposable');
  assert.equal(disposable.bookmarkCount, 1);
  assert.equal(database.getBookmarkLibrary({ search: 'MEYD-123', limit: 10 }).length, 0);
  assert.equal(database.findCode('MEYD-123').found, true);
  const deleted = database.deleteBookmarkCollection('Knowledge');
  assert.equal(deleted.bookmarkCount, 1);
  assert.equal(database.getBookmarkLibrary({ search: 'General bookmark', limit: 10 }).length, 0);

  const unfiledBefore = database.getBookmarkScopeInfo('__unfiled__').bookmarkCount;
  database.createBookmarkRecord({ title: 'Unfiled bookmark', url: 'https://missav.ai/cn/juq-999', code: 'JUQ-999' });
  assert.equal(database.findCode('JUQ-999').found, true);
  assert.equal(database.getBookmarkScopeInfo('__unfiled__').bookmarkCount, unfiledBefore + 1);
  database.deleteBookmarksByScope('__unfiled__');
  assert.equal(database.getBookmarkScopeInfo('__unfiled__').bookmarkCount, 0);
  assert.equal(database.getBookmarkLibrary({ search: 'Unfiled bookmark', limit: 10 }).length, 0);
  assert.equal(database.findCode('JUQ-999').found, true);

  const allScope = database.getBookmarkScopeInfo('all');
  assert.equal(allScope.bookmarkCount > 0, true);
  assert.equal(allScope.collectionCount > 0, true);
  database.deleteBookmarksByScope('all');
  assert.equal(database.getBookmarkStats().count, 0);
  assert.equal(database.getBookmarkCollections().length, 0);
  assert.equal(database.findCode('ABP-721').found, true);

  database.close();
  await database.init(dir);
  assert.equal(database.getBookmarkStats().count, 0);
  assert.equal(database.findCode('ABP-721').found, true);
});

test('manages complete bookmark tables and builds the same data shown by export preview', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-complete-db-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await database.init(dir);
  const codeId = database.createCodeRecord('DASS-720', 'https://missav.ai/cn/dass-720', 'ok');
  database.setCodeActressTags(codeId, ['Actress One']);
  database.setCodeGenreTags(codeId, ['Drama']);

  database.createBookmarkRecord({ title: 'DASS-720', url: 'https://missav.ai/cn/dass-720', code: 'DASS-720' });
  const codeBookmark = database.getBookmarkLibrary({ search: 'DASS-720', limit: 10 })[0];
  database.updateBookmarkRecord(codeBookmark.id, {
    title: '', folder: '', tags: '', created: '', note: 'Local note', highlights: 'Local highlight', favorite: true,
  });

  database.importRaindropRecords([{
    raindrop_id: 'favorite-1', title: 'Favorite page', url: 'https://example.com/favorite', folder: 'Web', favorite: true, favorite_present: true,
  }]);
  database.importRaindropRecords([{
    title: 'Favorite page', url: 'https://example.com/favorite', folder: 'Web', note: 'HTML supplement', favorite: false, favorite_present: false,
  }]);
  assert.equal(database.getBookmarkLibrary({ search: 'Favorite page', limit: 10 })[0].favorite, true);

  database.createBookmarkRecord({ title: 'Same URL A', url: 'https://example.com/same', folder: 'A' });
  const distinct = database.importRaindropRecords([{
    raindrop_id: 'same-b', title: 'Same URL B', url: 'https://example.com/same', folder: 'B', favorite: false, favorite_present: true,
  }]);
  assert.equal(distinct.imported, 1);
  assert.equal(database.getBookmarkLibrary({ search: 'https://example.com/same', limit: 10 }).length, 2);

  database.createBookmarkRecord({ title: 'Missing URL' });
  database.createBookmarkRecord({ title: 'Bad URL', url: 'not-a-url' });
  database.createBookmarkRecord({ title: 'Ordinary Article 2026', url: 'https://example.com/article/2026' });
  assert.equal(database.getBookmarkLibrary({ search: 'Ordinary Article 2026', limit: 10 })[0].code, '');

  const exportBundle = database.buildRaindropExport();
  const exportedCode = exportBundle.records.find(row => row.code === 'DASS-720');
  assert.equal(exportedCode.title, 'DASS-720');
  assert.equal(exportedCode.folder, 'MissAV_Import');
  assert.deepEqual(exportedCode.tags.split(','), ['Actress One', 'Drama']);
  assert.equal(exportedCode.note, 'Local note');
  assert.equal(exportedCode.highlights, 'Local highlight');
  assert.equal(exportedCode.favorite, true);
  assert.match(exportedCode.created, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(exportBundle.summary.missingUrl, 1);
  assert.equal(exportBundle.summary.invalidUrl, 1);
  assert.equal(exportBundle.summary.blocked, 2);
  assert.equal(exportBundle.records.some(row => row.title === 'Missing URL'), false);

  assert.equal(database.getBookmarkLibrary({ search: 'Actress One', limit: 10 }).some(row => row.code === 'DASS-720'), true);
  const stats = database.getBookmarkStats();
  assert.equal(stats.count >= 7, true);
  assert.equal(stats.noUrlCount, 1);
  assert.equal(stats.invalidUrlCount, 1);

  const editable = database.getEditableTables().map(row => row.name);
  assert.equal(editable.includes('bookmarks'), true);
  assert.equal(editable.includes('bookmark_collections'), true);
  const rawPage = database.getRawTableRows('bookmarks', { limit: 2, offset: 2 });
  assert.equal(rawPage.rows.length, 2);
  assert.equal(rawPage.total, stats.count);
  assert.equal(rawPage.filteredTotal, stats.count);
  database.updateRawCell('bookmarks', { id: codeBookmark.id }, 'title', 'Edited through full database');
  assert.equal(database.getBookmarkLibrary({ search: 'Edited through full database', limit: 10 }).length, 1);

  const cleared = database.updateBookmarkRecord(codeBookmark.id, { code: '' });
  assert.equal(cleared.sourceCodeId, null);
  assert.equal(database.findCode('DASS-720').found, true);

  const favoriteRow = database.getBookmarkLibrary({ search: 'Favorite page', limit: 10 })[0];
  database.deleteCodeRecord(codeId);
  assert.equal(database.getBookmarkLibrary({ search: 'Favorite page', limit: 10 })[0].id, favoriteRow.id);
});

test('persists one processed MissAV row with all tags in a single durable operation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-processed-row-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await database.init(dir);
  const codeId = database.persistProcessedCode({
    code: 'IPX-999',
    url: 'https://missav.ai/cn/ipx-999',
    status: 'ok',
    matchedActressTags: ['Actress A', 'Actress B'],
    genres: ['剧情', '高清'],
  });
  assert.ok(codeId > 0);
  const row = database.getCodeLibrary({ search: 'IPX-999', limit: 10 })[0];
  assert.deepEqual(row.actress_tags.sort(), ['Actress A', 'Actress B']);
  assert.deepEqual(row.genre_tags.sort(), ['剧情', '高清'].sort());

  database.close();
  await database.init(dir);
  const restored = database.getCodeLibrary({ search: 'IPX-999', limit: 10 })[0];
  assert.deepEqual(restored.actress_tags.sort(), ['Actress A', 'Actress B']);
  assert.deepEqual(restored.genre_tags.sort(), ['剧情', '高清'].sort());
});
