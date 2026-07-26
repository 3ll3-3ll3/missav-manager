const { codeComparableKey } = require('./parser');
const { normalizeTrustedMissavUrl, parseInputEntries } = require('./inputExtractor');
const raindropApi = require('./raindropApi');

const SYNC_MODES = Object.freeze(['pull', 'push', 'bidirectional']);

function normalizeSyncMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return SYNC_MODES.includes(mode) ? mode : 'push';
}

function normalizeComparableUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    parsed.hash = '';
    if ((parsed.protocol === 'http:' && parsed.port === '80') ||
        (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
    return parsed.href;
  } catch {
    return '';
  }
}

function extractRemoteCode(item = {}) {
  const trustedUrl = normalizeTrustedMissavUrl(item.link || item.url);
  if (!trustedUrl) return '';
  const entries = parseInputEntries(`${trustedUrl}\n${String(item.title || '')}`);
  return entries[0]?.code || '';
}

function remoteItemToPayload(item = {}) {
  return raindropApi.sanitizeSyncPayload({
    link: item.link || item.url,
    title: item.title,
    tags: item.tags,
    excerpt: item.excerpt,
    note: item.note,
    cover: item.cover,
    collectionId: item.collectionId ?? item.collection?.$id ?? -1,
  });
}

function remoteItemHash(item = {}) {
  return raindropApi.payloadHash(remoteItemToPayload(item));
}

function localItemIdentity(item = {}) {
  return {
    codeKey: codeComparableKey(item.code),
    remoteId: String(item.raindropRemoteId || item.remoteRecord?.remoteId || '').trim(),
    urls: [...new Set([
      normalizeComparableUrl(item.url),
      normalizeComparableUrl(item.sourceUrl),
      normalizeComparableUrl(item.remoteRecord?.link),
    ].filter(Boolean))],
  };
}

function classifyMirrorPair({
  mode,
  localHash,
  remoteHash,
  previousLocalHash,
  previousRemoteHash,
  hasMapping,
  bothExist,
} = {}) {
  if (bothExist) return 'exists_both';
  const normalizedMode = normalizeSyncMode(mode);
  if (normalizedMode === 'pull') {
    if (localHash === remoteHash) return hasMapping ? 'skip' : 'link';
    return 'pull_update';
  }
  if (normalizedMode === 'push') {
    if (localHash === remoteHash) return hasMapping ? 'skip' : 'link';
    return 'push_update';
  }
  if (!hasMapping) return localHash === remoteHash ? 'link' : 'conflict';

  const localChanged = Boolean(previousLocalHash) && localHash !== previousLocalHash;
  const remoteChanged = Boolean(previousRemoteHash) && remoteHash !== previousRemoteHash;
  if (localHash === remoteHash) return 'skip';
  if (localChanged && remoteChanged) return 'conflict';
  if (localChanged) return 'push_update';
  if (remoteChanged) return 'pull_update';
  return 'conflict';
}

module.exports = {
  SYNC_MODES,
  normalizeSyncMode,
  normalizeComparableUrl,
  extractRemoteCode,
  remoteItemToPayload,
  remoteItemHash,
  localItemIdentity,
  classifyMirrorPair,
};
