const test = require('node:test');
const assert = require('node:assert/strict');

const account = require('../src/av123Account');

function snapshot(overrides = {}) {
  return {
    url: 'https://123av.com/cn/v/abf-356',
    accountLabel: '2307402078',
    heading: 'ABF-356 — Example title',
    detailCode: 'ABF-356',
    saveState: 'save',
    loggedOut: false,
    challenge: false,
    ...overrides,
  };
}

test('123AV account detail URL validation is strict', () => {
  assert.equal(account.validateDetailUrl('https://123av.com/cn/v/abf-356#part'), 'https://123av.com/cn/v/abf-356');
  assert.throws(() => account.validateDetailUrl('http://123av.com/cn/v/abf-356'), /HTTPS/);
  assert.throws(() => account.validateDetailUrl('https://example.com/cn/v/abf-356'), /123AV/);
  assert.throws(() => account.validateDetailUrl('https://123av.com/cn/search?keyword=ABF-356'), /详情页/);
});

test('visible account and save state distinguish ready, saved, login, and challenge pages', () => {
  assert.equal(account.classifyAccountSnapshot(snapshot(), 'ABF-356').status, 'ready');
  assert.equal(account.classifyAccountSnapshot(snapshot({ saveState: 'saved' }), 'ABF-356').status, 'already_saved');
  assert.equal(account.classifyAccountSnapshot(snapshot({ accountLabel: '', loggedOut: true }), 'ABF-356').status, 'not_logged_in');
  const challenge = account.classifyAccountSnapshot(snapshot({ challenge: true }), 'ABF-356');
  assert.equal(challenge.status, 'manual');
  assert.equal(challenge.requiresUserAction, true);
  assert.equal(account.classifyAccountSnapshot(snapshot({ heading: 'FLAV-356', detailCode: 'FLAV-356' }), 'ABF-356').status, 'manual');
});

test('Cloudflare Error 1015 is a retryable rate limit instead of a login or captcha prompt', () => {
  const result = account.classifyAccountSnapshot(snapshot({
    accountLabel: '',
    rateLimited: true,
    challenge: true,
  }), 'ABF-356');
  assert.equal(result.status, 'network_error');
  assert.equal(result.requiresUserAction, false);
  assert.equal(result.metadata.responseKind, 'rate_limited');
  assert.equal(result.metadata.retryAfterMs, 120000);
});

test('visible account wins over stale hidden login-form evidence', () => {
  const result = account.classifyAccountSnapshot(snapshot({ loggedOut: true }), 'ABF-356');
  assert.equal(result.status, 'ready');
  assert.equal(result.metadata.accountLabel, '2307402078');
});

test('already-saved items are idempotent and never clicked', async () => {
  let clicks = 0;
  const result = await account.runFavoriteAction({
    navigate: async () => {},
    inspect: async () => snapshot({ saveState: 'saved' }),
    clickSave: async () => { clicks++; return true; },
    sleep: async () => {},
  }, { code: 'ABF-356', url: 'https://123av.com/cn/v/abf-356' });

  assert.equal(result.status, 'already_saved');
  assert.equal(result.metadata.clickAttempted, false);
  assert.equal(clicks, 0);
});

test('favorite action clicks once and only succeeds after visible saved confirmation', async () => {
  const snapshots = [snapshot(), snapshot({ saveState: 'save' }), snapshot({ saveState: 'saved' })];
  let clicks = 0;
  const result = await account.runFavoriteAction({
    navigate: async () => {},
    inspect: async () => snapshots.shift(),
    clickSave: async () => { clicks++; return true; },
    sleep: async () => {},
  }, {
    code: 'ABF-356',
    url: 'https://123av.com/cn/v/abf-356',
    pollDelayMs: 0,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.metadata.clickAttempted, true);
  assert.equal(clicks, 1);
});

test('verify-only leaves unsaved item ready without clicking', async () => {
  let clicks = 0;
  const result = await account.runFavoriteAction({
    navigate: async () => {},
    inspect: async () => snapshot(),
    clickSave: async () => { clicks++; return true; },
    sleep: async () => {},
  }, {
    code: 'ABF-356',
    url: 'https://123av.com/cn/v/abf-356',
    verifyOnly: true,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.metadata.responseKind, 'verified_not_saved');
  assert.equal(clicks, 0);
});

test('post-click uncertainty always requires remote verification', async () => {
  let inspections = 0;
  const result = await account.runFavoriteAction({
    navigate: async () => {},
    inspect: async () => {
      inspections++;
      if (inspections === 1) return snapshot();
      throw new Error('renderer disappeared');
    },
    clickSave: async () => true,
    sleep: async () => {},
  }, {
    code: 'ABF-356',
    url: 'https://123av.com/cn/v/abf-356',
  });

  assert.equal(result.status, 'verify_required');
  assert.equal(result.metadata.clickAttempted, true);
});

test('post-click confirmation uses a short first pass before deferring to the next round', async () => {
  let inspections = 0;
  let sleeps = 0;
  const result = await account.runFavoriteAction({
    navigate: async () => {},
    inspect: async () => {
      inspections++;
      return snapshot({ saveState: 'save' });
    },
    clickSave: async () => true,
    sleep: async () => { sleeps++; },
  }, {
    code: 'ABF-356',
    url: 'https://123av.com/cn/v/abf-356',
  });

  assert.equal(result.status, 'verify_required');
  assert.equal(result.metadata.responseKind, 'post_click_timeout');
  assert.equal(result.metadata.confirmationPolls, 4);
  assert.equal(result.metadata.confirmationWaitMs, 1600);
  assert.equal(inspections, 5, '首次检查一次，点击后只快速检查四次');
  assert.equal(sleeps, 4);
});

test('account metadata contains no page body, cookie, storage, or password data', () => {
  const result = account.classifyAccountSnapshot(snapshot({ bodyText: 'secret', password: 'secret' }), 'ABF-356');
  const serialized = JSON.stringify(result).toLowerCase();
  assert.doesNotMatch(serialized, /secret|cookie|localstorage|sessionstorage|password/);
});
