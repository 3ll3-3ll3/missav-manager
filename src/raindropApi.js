const crypto = require('node:crypto');

const API_BASE = 'https://api.raindrop.io/rest/v1';
const MAX_URL_CHECK = 100;
const AUTO_COLLECTION_NAMES = Object.freeze(['missav1', 'missav2']);

function normalizeToken(value) {
  const token = String(value || '').trim();
  if (token.length < 16 || token.length > 2048 || /[\r\n]/.test(token)) {
    throw new Error('Raindrop 访问令牌格式无效');
  }
  return token;
}

function normalizeHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('同步链接格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('同步链接必须是安全的 HTTP/HTTPS 地址');
  }
  return parsed.href;
}

function normalizeCollectionId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id === 0 || id < -1) throw new Error('Raindrop Collection 无效');
  return id;
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maxLength);
}

function normalizeTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[,;，；\n]+/);
  return [...new Set(source
    .map(tag => cleanText(tag, 256))
    .filter(Boolean))]
    .slice(0, 100);
}

function sanitizeSyncPayload(value = {}) {
  const link = normalizeHttpUrl(value.link || value.url);
  const title = cleanText(value.title, 1000) || link;
  const payload = {
    link,
    title,
    tags: normalizeTags(value.tags),
    collection: { $id: normalizeCollectionId(value.collectionId ?? value.collection?.$id ?? -1) },
    type: 'video',
  };
  const excerpt = cleanText(value.excerpt, 10000);
  const note = cleanText(value.note, 10000);
  const cover = cleanText(value.cover, 4096);
  if (excerpt) payload.excerpt = excerpt;
  if (note) payload.note = note;
  if (cover) payload.cover = normalizeHttpUrl(cover);
  return payload;
}

function buildSyncPayload(item = {}, collectionId = -1) {
  const code = cleanText(item.code, 1000);
  return sanitizeSyncPayload({
    link: item.url,
    title: cleanText(item.title, 1000) || code,
    excerpt: cleanText(item.excerpt, 10000),
    note: cleanText(item.note, 10000),
    cover: cleanText(item.cover, 4096),
    tags: item.finalTags || item.tags || [],
    collectionId,
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(sanitizeSyncPayload(payload)))).digest('hex');
}

function normalizeCollectionRows(value) {
  return Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : [];
}

function flattenCollections(rootResponse, childResponse) {
  const rows = [...normalizeCollectionRows(rootResponse), ...normalizeCollectionRows(childResponse)];
  const nodes = new Map();
  for (const row of rows) {
    const id = Number(row?._id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    nodes.set(id, {
      id,
      title: cleanText(row.title, 1000) || `Collection ${id}`,
      parentId: Number(row.parent?.$id) > 0 ? Number(row.parent.$id) : 0,
      count: Math.max(0, Number(row.count) || 0),
    });
  }
  function pathFor(node, seen = new Set()) {
    if (!node || seen.has(node.id)) return node?.title || '';
    seen.add(node.id);
    const parent = nodes.get(node.parentId);
    return parent ? `${pathFor(parent, seen)} / ${node.title}` : node.title;
  }
  return [...nodes.values()]
    .map(node => ({ ...node, path: pathFor(node) }))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
}

function normalizeAutoCollectionNames(value) {
  const requested = Array.isArray(value) ? value : [];
  const allowed = new Map(AUTO_COLLECTION_NAMES.map(name => [name.toLowerCase(), name]));
  const normalized = [];
  for (const raw of requested) {
    const key = cleanText(raw, 64).toLowerCase();
    if (!allowed.has(key)) throw new Error('只允许自动创建 missav1 与 missav2 Collection');
    const name = allowed.get(key);
    if (!normalized.includes(name)) normalized.push(name);
  }
  if (!normalized.length) throw new Error('至少需要一个自动分流 Collection');
  return normalized;
}

function parseCreatedCollection(response, expectedTitle = '') {
  const row = response?.item || response?.collection || response || {};
  const id = Number(row?._id ?? row?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Raindrop 返回结果缺少 Collection ID');
  return {
    id,
    title: cleanText(row.title, 1000) || cleanText(expectedTitle, 1000) || `Collection ${id}`,
    parentId: Number(row.parent?.$id) > 0 ? Number(row.parent.$id) : 0,
    count: Math.max(0, Number(row.count) || 0),
  };
}

function selectMissavCollectionName(actresses, knownActresses) {
  const known = new Set((Array.isArray(knownActresses) ? knownActresses : [])
    .map(value => cleanText(value, 1000).toLocaleLowerCase())
    .filter(Boolean));
  const hasKnown = (Array.isArray(actresses) ? actresses : [])
    .some(value => known.has(cleanText(value, 1000).toLocaleLowerCase()));
  return hasKnown ? 'missav1' : 'missav2';
}

function sanitizeUrls(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_URL_CHECK) {
    throw new Error(`每次只能核对 1-${MAX_URL_CHECK} 个链接`);
  }
  return value.map(normalizeHttpUrl);
}

function parseExistsResponse(response, urls) {
  const ids = Array.isArray(response?.ids) ? response.ids : [];
  return sanitizeUrls(urls).map((url, index) => {
    const raw = ids[index];
    const id = Number(raw?._id ?? raw);
    return { url, remoteId: Number.isSafeInteger(id) && id > 0 ? id : null };
  });
}

function parseRateLimit(headers, now = Date.now()) {
  const read = name => {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    return headers[name] ?? headers[name.toLowerCase()] ?? '';
  };
  const limit = Number(read('x-ratelimit-limit')) || 0;
  const remaining = Number(read('x-ratelimit-remaining'));
  const retryAfter = Number(read('retry-after'));
  const rawReset = Number(read('x-ratelimit-reset'));
  let resetAt = 0;
  if (rawReset > 0) resetAt = rawReset > 1e12 ? rawReset : rawReset > 1e9 ? rawReset * 1000 : now + rawReset * 1000;
  if (retryAfter > 0) resetAt = Math.max(resetAt, now + retryAfter * 1000);
  return {
    limit,
    remaining: Number.isFinite(remaining) ? Math.max(0, remaining) : null,
    resetAt,
  };
}

function safeApiError(statusCode, body) {
  const message = cleanText(body?.errorMessage || body?.message || '', 240);
  if (statusCode === 401 || statusCode === 403) return 'Raindrop 授权已失效，请重新保存访问令牌';
  if (statusCode === 429) return 'Raindrop 请求达到速率上限，已等待后重试';
  return message ? `Raindrop API ${statusCode}: ${message}` : `Raindrop API 请求失败（HTTP ${statusCode || 0}）`;
}

module.exports = {
  API_BASE,
  MAX_URL_CHECK,
  AUTO_COLLECTION_NAMES,
  normalizeToken,
  normalizeHttpUrl,
  normalizeCollectionId,
  normalizeTags,
  sanitizeSyncPayload,
  buildSyncPayload,
  payloadHash,
  flattenCollections,
  normalizeAutoCollectionNames,
  parseCreatedCollection,
  selectMissavCollectionName,
  sanitizeUrls,
  parseExistsResponse,
  parseRateLimit,
  safeApiError,
};
