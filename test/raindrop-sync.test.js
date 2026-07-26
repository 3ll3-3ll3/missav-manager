const test = require('node:test');
const assert = require('node:assert/strict');

const sync = require('../src/raindropSync');

test('Raindrop sync mode and remote identity are normalized safely', () => {
  assert.equal(sync.normalizeSyncMode('PULL'), 'pull');
  assert.equal(sync.normalizeSyncMode('bidirectional'), 'bidirectional');
  assert.equal(sync.normalizeSyncMode('unknown'), 'push');
  assert.equal(sync.extractRemoteCode({
    link: 'https://missav.ai/dm15/abf-354-uncensored-leak',
    title: 'ABF-354',
  }), 'ABF-354');
  assert.equal(sync.extractRemoteCode({
    link: 'https://example.com/abf-354',
    title: 'ABF-354',
  }), '');
  assert.deepEqual(sync.localItemIdentity({
    code: 'abf-354',
    url: 'https://missav.ai/cn/abf-354#player',
    sourceUrl: 'https://missav.ai/cn/abf-354',
    remoteRecord: { remoteId: 91, link: 'https://missav.ai/cn/abf-354' },
  }), {
    codeKey: 'ABF354',
    remoteId: '91',
    urls: ['https://missav.ai/cn/abf-354'],
  });
});

test('Raindrop bidirectional comparison uses the last shared snapshot', () => {
  const base = 'a'.repeat(64);
  const localChanged = 'b'.repeat(64);
  const remoteChanged = 'c'.repeat(64);

  assert.equal(sync.classifyMirrorPair({
    mode: 'bidirectional',
    localHash: localChanged,
    remoteHash: remoteChanged,
    bothExist: true,
  }), 'exists_both');
  assert.equal(sync.classifyMirrorPair({
    mode: 'pull', localHash: localChanged, remoteHash: base, hasMapping: true,
  }), 'pull_update');
  assert.equal(sync.classifyMirrorPair({
    mode: 'pull', localHash: base, remoteHash: base, hasMapping: true,
  }), 'skip');
  assert.equal(sync.classifyMirrorPair({
    mode: 'pull', localHash: base, remoteHash: base, hasMapping: false,
  }), 'link');
  assert.equal(sync.classifyMirrorPair({
    mode: 'push', localHash: base, remoteHash: remoteChanged, hasMapping: true,
  }), 'push_update');
  assert.equal(sync.classifyMirrorPair({
    mode: 'bidirectional',
    localHash: localChanged,
    remoteHash: base,
    previousLocalHash: base,
    previousRemoteHash: base,
    hasMapping: true,
  }), 'push_update');
  assert.equal(sync.classifyMirrorPair({
    mode: 'bidirectional',
    localHash: base,
    remoteHash: remoteChanged,
    previousLocalHash: base,
    previousRemoteHash: base,
    hasMapping: true,
  }), 'pull_update');
  assert.equal(sync.classifyMirrorPair({
    mode: 'bidirectional',
    localHash: localChanged,
    remoteHash: remoteChanged,
    previousLocalHash: base,
    previousRemoteHash: base,
    hasMapping: true,
  }), 'conflict');
  assert.equal(sync.classifyMirrorPair({
    mode: 'bidirectional',
    localHash: base,
    remoteHash: base,
    previousLocalHash: base,
    previousRemoteHash: base,
    hasMapping: true,
  }), 'skip');
  assert.equal(sync.classifyMirrorPair({
    mode: 'bidirectional',
    localHash: base,
    remoteHash: base,
    hasMapping: false,
  }), 'link');
});
