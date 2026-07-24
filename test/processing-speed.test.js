const test = require('node:test');
const assert = require('node:assert/strict');

const speed = require('../renderer/processing-speed');

test('provides safe, adaptive, fast and extended quick processing profiles', () => {
  assert.equal(speed.getProfile('safe').maxConcurrency, 1);
  assert.equal(speed.getProfile('smart').adaptive, true);
  assert.equal(speed.getProfile('fast').maxConcurrency, 4);
  assert.equal(speed.getProfile('quick').fullSearch, false);
  assert.equal(speed.getProfile('turbo').maxConcurrency, 8);
  assert.equal(speed.getProfile('rocket').maxConcurrency, 12);
  assert.equal(speed.getProfile('extreme').maxConcurrency, 16);
  assert.equal(speed.normalizeMode('unknown'), 'smart');
  assert.equal(speed.getSiteProfile('missav', 'extreme').requestGapMs, 0);
  assert.equal(speed.getSiteProfile('av123', 'extreme').requestsPerSecond, 4.1);
  assert.equal(speed.getSiteProfile('av123', 'extreme').requestGapMs, 244);
  assert.equal(speed.getSiteProfile('av123', 'safe').rateWindowLimit, 10);
  assert.equal(speed.AV123_RATE_CONTROL.defaultCap, 16);
  assert.equal(speed.AV123_RATE_CONTROL.maximum, 32);
  assert.equal(speed.MISSAV_RATE_CONTROL.defaultLearnedRate, 8);
  assert.equal(speed.MISSAV_RATE_CONTROL.maximum, 32);
});

test('123AV rate controls allow a high cap while keeping adaptive changes bounded', () => {
  assert.equal(speed.normalize123AvRateMode('adaptive'), 'adaptive');
  assert.equal(speed.normalize123AvRateMode('fixed'), 'fixed');
  assert.equal(speed.normalize123AvRateMode('unknown'), 'adaptive');
  assert.equal(speed.normalize123AvRateCap(99), 32);
  assert.equal(speed.normalize123AvRateCap(0), 1);
  assert.equal(speed.normalize123AvRateCap(null), 16);
  assert.equal(speed.normalize123AvLearnedRate(null), 5);
  assert.equal(speed.get123AvAdaptiveStartRate(16, 5), 5);
  assert.equal(speed.get123AvAdaptiveStartRate(16, 1), 3);
  assert.equal(speed.get123AvAdaptiveStartRate(4, 9), 4);
  assert.equal(speed.get123AvProbeStep(5), 0.5);
  assert.equal(speed.get123AvProbeStep(20), 1.5);
  assert.equal(speed.get123AvRateLimitFallback(10), 8);
  assert.equal(speed.get123AvRateLimitFallback(2), 3);
  assert.equal(speed.get123AvSessionCeilingAfterLimit(10), 9);
});

test('MissAV has independent rate controls and latency-aware health backoff', () => {
  assert.equal(speed.normalizeSiteRateMode('missav', 'fixed'), 'fixed');
  assert.equal(speed.normalizeSiteRateCap('missav', 99), 32);
  assert.equal(speed.normalizeSiteRateCap('missav', null), 16);
  assert.equal(speed.normalizeSiteLearnedRate('missav', null), 8);
  assert.equal(speed.getSiteAdaptiveStartRate('missav', 16, 1), 2);
  assert.equal(speed.getSiteCongestionFallback('missav', 10), 8.2);

  const now = Date.now();
  const healthy = speed.summarizeRateHealth(Array.from({ length: 12 }, (_, index) => ({
    completedAt: now - (11 - index) * 100,
    durationMs: 350,
    networkError: false,
  })), now);
  assert.equal(speed.shouldBackoffRateHealth('missav', healthy, 7000), false);

  const slow = speed.summarizeRateHealth(Array.from({ length: 12 }, (_, index) => ({
    completedAt: now - (11 - index) * 250,
    durationMs: index < 10 ? 800 : 5000,
    networkError: false,
  })), now);
  assert.equal(slow.p95DurationMs, 5000);
  assert.equal(speed.shouldBackoffRateHealth('missav', slow, 7000), true);
});

test('simplified high-speed modes reduce the candidate URL set', () => {
  const urls = ['main', 'subtitle', 'leak', 'mirror'];
  assert.deepEqual(speed.selectCandidateUrls(urls, 'smart'), urls);
  assert.deepEqual(speed.selectCandidateUrls(urls, 'fast'), urls);
  assert.deepEqual(speed.selectCandidateUrls(urls, 'quick'), ['main']);
  assert.deepEqual(speed.selectCandidateUrls(urls, 'extreme'), ['main']);
  assert.equal(speed.isBackoffAttempt({ status: 'network_error' }), true);
  assert.equal(speed.isBackoffAttempt({ status: 'not_found' }), false);
  const detailUrls = ['base', 'uncensored-leaked', 'uncensored-leak', 'chinese', 'english', 'uncensored', 'leaked'];
  assert.deepEqual(speed.select123AvDetailCandidateUrls(detailUrls, 'extreme'), detailUrls.slice(0, 3));
  assert.deepEqual(speed.select123AvDetailCandidateUrls(detailUrls, 'smart'), detailUrls);
});

test('123AV high-speed policies keep the primary round full and never collapse to one worker', () => {
  const staged = speed.getRuntimePolicy('av123', 'extreme', 'staged');
  assert.equal(staged.adaptive, false);
  assert.equal(staged.minimumConcurrency, 4);
  assert.equal(staged.pauseRequestsOnPenalty, true);
  assert.deepEqual(staged.stagedLevels, [16, 8, 4]);
  assert.deepEqual(speed.getStagedConcurrencyLevels('rocket'), [12, 6, 3]);
  assert.equal(speed.normalize123AvPolicy('unknown'), 'staged');

  const fixed = speed.getRuntimePolicy('av123', 'extreme', 'fixed');
  assert.equal(fixed.adaptive, false);
  assert.equal(fixed.minimumConcurrency, 1);
  assert.equal(fixed.pauseRequestsOnPenalty, true);

  const balanced = speed.getRuntimePolicy('av123', 'extreme', 'balanced');
  assert.equal(balanced.adaptive, true);
  assert.equal(balanced.minimumConcurrency, 8);
  assert.equal(balanced.pauseRequestsOnPenalty, false);

  const missav = speed.getRuntimePolicy('missav', 'extreme', 'fixed');
  assert.equal(missav.adaptive, false);
  assert.equal(missav.minimumConcurrency, 1);
  assert.equal(missav.pauseRequestsOnPenalty, false);

  const missavBalanced = speed.getRuntimePolicy('missav', 'extreme', 'balanced');
  assert.equal(missavBalanced.adaptive, true);
  assert.equal(missavBalanced.minimumConcurrency, 8);
  assert.equal(missavBalanced.pauseRequestsOnPenalty, false);
  assert.equal(speed.normalizeMissavPolicy('unknown'), 'stable');
});
