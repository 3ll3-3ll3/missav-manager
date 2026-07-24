const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../src/raindropApi');

test('Raindrop sync payload is bounded, normalized, and stable-hashed', () => {
  const payload = api.buildSyncPayload({
    code: 'ABF-354',
    url: 'https://missav.ai/cn/abf-354',
    finalTags: ['Test Actress', '剧情', '剧情', '  '],
  }, 123);
  assert.deepEqual(payload, {
    link: 'https://missav.ai/cn/abf-354',
    title: 'ABF-354',
    tags: ['Test Actress', '剧情'],
    collection: { $id: 123 },
    type: 'video',
  });
  assert.equal(api.payloadHash(payload), api.payloadHash({ ...payload, tags: ['Test Actress', '剧情'] }));
  assert.match(api.payloadHash(payload), /^[a-f0-9]{64}$/);
});

test('Raindrop payload rejects unsafe links and invalid collections', () => {
  assert.throws(() => api.buildSyncPayload({ code: 'ABF-354', url: 'file:///secret' }, -1), /HTTP\/HTTPS/);
  assert.throws(() => api.buildSyncPayload({ code: 'ABF-354', url: 'https://user:pass@example.com' }, -1), /HTTP\/HTTPS/);
  assert.throws(() => api.buildSyncPayload({ code: 'ABF-354', url: 'https://example.com' }, 0), /Collection/);
  assert.throws(() => api.normalizeToken('short'), /令牌格式/);
});

test('Raindrop collections are flattened with parent paths', () => {
  const rows = api.flattenCollections(
    { items: [{ _id: 10, title: 'JAV', count: 4 }] },
    { items: [{ _id: 11, title: 'MissAV', parent: { $id: 10 }, count: 2 }, { _id: 12, title: 'Later', parent: { $id: 11 } }] },
  );
  assert.deepEqual(rows.map(row => [row.id, row.path]), [
    [10, 'JAV'],
    [11, 'JAV / MissAV'],
    [12, 'JAV / MissAV / Later'],
  ]);
});

test('Raindrop automatic routing only accepts the two fixed root collections', () => {
  assert.deepEqual(api.normalizeAutoCollectionNames(['MissAV1', 'missav2', 'MISSAV1']), ['missav1', 'missav2']);
  assert.throws(() => api.normalizeAutoCollectionNames(['other']), /missav1/);
  assert.throws(() => api.normalizeAutoCollectionNames([]), /至少/);
  assert.deepEqual(api.parseCreatedCollection({
    item: { _id: 19, title: 'missav1', count: 0 },
  }, 'missav1'), {
    id: 19,
    title: 'missav1',
    parentId: 0,
    count: 0,
  });
  assert.equal(api.selectMissavCollectionName(['Known Actress', 'New Actress'], ['known actress']), 'missav1');
  assert.equal(api.selectMissavCollectionName(['New Actress'], ['Known Actress']), 'missav2');
  assert.equal(api.selectMissavCollectionName([], ['Known Actress']), 'missav2');
});

test('Raindrop URL-exists response preserves positional mapping', () => {
  const urls = ['https://example.com/a', 'https://example.com/b'];
  assert.deepEqual(api.parseExistsResponse({ ids: [765, null] }, urls), [
    { url: 'https://example.com/a', remoteId: 765 },
    { url: 'https://example.com/b', remoteId: null },
  ]);
  assert.throws(() => api.sanitizeUrls(Array.from({ length: 101 }, (_, i) => `https://example.com/${i}`)), /1-100/);
});

test('Raindrop rate-limit parser understands epoch and retry-after headers', () => {
  const now = 1_700_000_000_000;
  const parsed = api.parseRateLimit({
    'x-ratelimit-limit': '120',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '1700000060',
    'retry-after': '10',
  }, now);
  assert.equal(parsed.limit, 120);
  assert.equal(parsed.remaining, 0);
  assert.equal(parsed.resetAt, now + 60_000);
});
