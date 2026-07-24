const test = require('node:test');
const assert = require('node:assert/strict');

const eta = require('../renderer/processing-eta');

test('estimates remaining processing time from recent completed rows', () => {
  assert.equal(eta.averageDuration([1000, 2000, 3000]), 2000);
  assert.equal(eta.estimateRemainingMs({ total: 10, completed: 4, durations: [1000, 2000, 3000] }), 12000);
  assert.equal(eta.estimateRemainingMs({ total: 10, completed: 4, durations: [] }), null);
  assert.equal(eta.estimateRemainingMs({ total: 10, completed: 10, durations: [] }), 0);
  assert.equal(eta.estimateRemainingMs({ total: 10, completed: 4, durations: [2000, 2000], concurrency: 3 }), 4000);
});

test('accounts for a currently slow row and formats ETA labels', () => {
  assert.equal(eta.estimateRemainingMs({
    total: 5,
    completed: 2,
    durations: [2000, 2000],
    currentElapsedMs: 5000,
  }), 9000);
  assert.equal(eta.formatDuration(0), '0 秒');
  assert.equal(eta.formatDuration(65000), '1 分 5 秒');
  assert.equal(eta.formatDuration(7260000), '2 小时 1 分');
});
