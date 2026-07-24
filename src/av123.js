/**
 * 123AV read-only lookup helpers.
 */

const { normalizeCode, codeComparableKey } = require('./parser');
const { cleanText } = require('./utils');

const BASE_URL = 'https://123av.com';
const DETAIL_SUFFIXES = [
  '-uncensored-leaked',
  '-uncensored-leak',
  '-chinese-subtitle',
  '-english-subtitle',
  '-uncensored',
  '-leaked',
];

function buildSearchUrl(code, locale = 'cn') {
  const normalized = normalizeCode(code);
  const safeLocale = /^[a-z]{2}$/i.test(String(locale || '')) ? String(locale).toLowerCase() : 'cn';
  return `${BASE_URL}/${safeLocale}/search?keyword=${encodeURIComponent(normalized)}`;
}

function buildDetailUrl(code, locale = 'cn') {
  const normalized = normalizeCode(code).toLowerCase();
  const safeLocale = /^[a-z]{2}$/i.test(String(locale || '')) ? String(locale).toLowerCase() : 'cn';
  return `${BASE_URL}/${safeLocale}/v/${encodeURIComponent(normalized)}`;
}

function buildDetailCandidateUrls(code, locale = 'cn') {
  const base = buildDetailUrl(code, locale);
  return [base, ...DETAIL_SUFFIXES.map(suffix => `${base}${suffix}`)];
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => String.fromCodePoint(parseInt(value, 16)));
}

function visibleText(html) {
  return cleanText(decodeHtml(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

function extractCodeTokens(text) {
  const source = String(text || '').toUpperCase();
  const tokens = [];
  const patterns = [
    /(?:^|[^A-Z0-9])(FC2(?:[-_\s]*PPV)?[-_\s]*\d{4,10})(?![A-Z0-9])/g,
    /(?:^|[^A-Z0-9])([A-Z]{2,8}[-_\s]?\d{2,5})(?![A-Z0-9])/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) tokens.push(normalizeCode(match[1]));
  }
  return [...new Set(tokens.filter(Boolean))];
}

function hasExactCodeEvidence(text, code) {
  const target = codeComparableKey(code);
  if (!target) return false;
  return extractCodeTokens(text).some(token => codeComparableKey(token) === target);
}

function extractAttribute(attributes, name) {
  const match = String(attributes || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]).trim() : '';
}

function normalizeDetailUrl(href, baseUrl = BASE_URL) {
  try {
    const parsed = new URL(String(href || ''), baseUrl);
    if (!['123av.com', 'www.123av.com'].includes(parsed.hostname.toLowerCase())) return '';
    if (!/^\/[a-z]{2}\/v\//i.test(parsed.pathname)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

function detailSlug(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
  } catch {
    return '';
  }
}

function candidateScore(url, code) {
  const target = normalizeCode(code).toLowerCase();
  const slug = detailSlug(url);
  if (slug === target) return 3;
  if (DETAIL_SUFFIXES.some(suffix => slug === `${target}${suffix}`)) return 2;
  return 1;
}

function extractExactSearchCandidates(html, code, finalUrl = BASE_URL) {
  const source = String(html || '');
  const candidates = [];
  const seen = new Set();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(source)) !== null) {
    const href = extractAttribute(match[1], 'href');
    if (!href || !/\/v\//i.test(href)) continue;
    const title = visibleText(match[2]);
    if (!title || !hasExactCodeEvidence(title, code)) continue;
    const url = normalizeDetailUrl(href, finalUrl || BASE_URL);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, title, score: candidateScore(url, code) });
  }
  return candidates.sort((left, right) => right.score - left.score || left.url.length - right.url.length);
}

function accessChallengeReason(html) {
  const source = String(html || '').toLowerCase();
  const markers = [
    ['cloudflare_challenge', 'cf-chl-'],
    ['checking_browser', 'checking your browser'],
    ['verify_human', 'verify you are human'],
    ['attention_required', 'attention required! | cloudflare'],
    ['just_a_moment', '<title>just a moment'],
    ['rate_limit', 'too many requests'],
    ['rate_limit', 'rate limit exceeded'],
    ['access_denied', '<title>403 forbidden'],
    ['human_verification_zh', '人机验证'],
    ['rate_limit_zh', '请求过于频繁'],
  ];
  return markers.find(([, marker]) => source.includes(marker))?.[0] || '';
}

function isLoginRequired(html, finalUrl = '') {
  const source = String(html || '').toLowerCase();
  let pathname = '';
  try { pathname = new URL(String(finalUrl || '')).pathname.toLowerCase(); } catch {}
  if (/\/(?:login|signin)(?:\/|$)/.test(pathname)) return true;
  return /<input\b[^>]*type\s*=\s*(["'])password\1/i.test(source) &&
    /<form\b[^>]*(?:login|signin)/i.test(source);
}

function extractDetailEvidence(html, code) {
  const source = String(html || '');
  const evidenceBlocks = [];
  for (const pattern of [
    /<title\b[^>]*>([\s\S]*?)<\/title>/gi,
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi,
    /<dt\b[^>]*>\s*(?:代码|番[號号]|code)\s*<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi,
  ]) {
    let match;
    while ((match = pattern.exec(source)) !== null) evidenceBlocks.push(visibleText(match[1]));
  }
  const exact = evidenceBlocks.find(text => hasExactCodeEvidence(text, code)) || '';
  const hasStructure = /<h1\b/i.test(source) &&
    (/<dt\b/i.test(source) || /\/genres\//i.test(source) || /\/actresses\//i.test(source)) &&
    (/<iframe\b/i.test(source) || /<video\b/i.test(source) || /class\s*=\s*(["'])[^"']*player/i.test(source));
  return { exact, hasStructure };
}

function pageKind(html, finalUrl = '') {
  const source = String(html || '');
  let pathname = '';
  try { pathname = new URL(String(finalUrl || '')).pathname.toLowerCase(); } catch {}
  // 详情页本身也会包含推荐影片的 card__link。URL 已明确位于 /v/ 时必须
  // 优先按详情页解析，否则会把正常详情误判为搜索结果并进行第二次请求。
  if (/\/[a-z]{2}\/v\//.test(pathname)) return 'detail';
  if (/\/search\/?$/.test(pathname)) return 'search';
  if (/<dt\b[^>]*>\s*(?:代码|番[號号]|code)\s*<\/dt>/i.test(source)) return 'detail';
  if (/class\s*=\s*(["'])[^"']*card__link/i.test(source)) return 'search';
  return 'unknown';
}

function retryAfterMs(headers = {}) {
  const value = String(headers['retry-after'] ?? headers['Retry-After'] ?? '').trim();
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.min(120000, Math.max(0, Math.round(Number(value) * 1000)));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(120000, Math.max(0, timestamp - Date.now())) : 0;
}

function classifyResponse(page, code, requestedUrl = '') {
  const response = page || {};
  const statusCode = Number(response.statusCode || 0);
  const finalUrl = String(response.finalUrl || requestedUrl || '');
  const html = String(response.body || '');
  const normalized = normalizeCode(code);
  const retryDelay = retryAfterMs(response.headers || {});

  if (response.error) {
    return { status: 'network_error', url: finalUrl, statusCode, error: String(response.error), metadata: { responseKind: 'network' } };
  }
  if ([403, 408, 425, 429].includes(statusCode) || statusCode >= 500) {
    return { status: 'network_error', url: finalUrl, statusCode, error: `HTTP ${statusCode}`, metadata: { responseKind: 'network', retryAfterMs: retryDelay } };
  }
  if (statusCode === 404 || statusCode === 410) {
    return { status: 'not_found', url: '', statusCode, error: '', metadata: { responseKind: 'not_found' } };
  }
  if (!statusCode || statusCode >= 400) {
    return { status: 'network_error', url: finalUrl, statusCode, error: statusCode ? `HTTP ${statusCode}` : '未取得有效 HTTP 响应', metadata: { responseKind: 'network' } };
  }

  const challenge = accessChallengeReason(html);
  if (challenge) {
    return {
      status: 'network_error',
      url: finalUrl,
      statusCode,
      error: `123AV 触发访问验证、限流或防爬保护（特征：${challenge}）`,
      metadata: { responseKind: 'challenge', challenge },
    };
  }
  if (isLoginRequired(html, finalUrl)) {
    return { status: 'manual', url: finalUrl, statusCode, error: '123AV 要求登录后才能查询', metadata: { responseKind: 'login_required' } };
  }

  const kind = pageKind(html, finalUrl);
  if (kind === 'detail') {
    const evidence = extractDetailEvidence(html, normalized);
    if (evidence.exact && evidence.hasStructure) {
      return {
        status: 'succeeded',
        url: normalizeDetailUrl(finalUrl) || finalUrl,
        statusCode,
        error: '',
        metadata: { responseKind: 'detail', matchedTitle: evidence.exact, candidateCount: 1 },
      };
    }
    if (!evidence.exact) {
      return { status: 'not_found', url: '', statusCode, error: '', metadata: { responseKind: 'detail_mismatch' } };
    }
    return { status: 'manual', url: finalUrl, statusCode, error: '详情页包含番号，但页面结构不足，需人工核验', metadata: { responseKind: 'detail_unverified' } };
  }

  if (kind === 'search') {
    const candidates = extractExactSearchCandidates(html, normalized, finalUrl || BASE_URL);
    if (candidates.length) {
      return {
        status: 'succeeded',
        url: candidates[0].url,
        statusCode,
        error: '',
        metadata: {
          responseKind: 'search',
          matchedTitle: candidates[0].title,
          candidateCount: candidates.length,
          alternateUrls: candidates.slice(1, 5).map(item => item.url),
        },
      };
    }
    return { status: 'not_found', url: '', statusCode, error: '', metadata: { responseKind: 'search', candidateCount: 0 } };
  }

  return {
    status: 'manual',
    url: finalUrl,
    statusCode,
    error: '123AV 返回了无法识别的页面，需人工核验',
    metadata: { responseKind: 'unknown' },
  };
}

async function fetchPage(url, fetchImpl, options = {}) {
  const timeout = Number(options.timeout || 15000);
  let result;
  try {
    result = await fetchImpl(url, { timeout });
  } catch (err) {
    return { statusCode: 0, body: '', finalUrl: url, error: err.message || String(err) };
  }

  let redirects = 0;
  while (result.redirected && redirects < 3) {
    try {
      result = await fetchImpl(result.redirectUrl, { timeout });
      redirects++;
    } catch (err) {
      return { statusCode: 0, body: '', finalUrl: result.redirectUrl || url, error: err.message || String(err) };
    }
  }
  if (result.redirected) {
    return { statusCode: result.statusCode || 0, body: '', finalUrl: result.redirectUrl || url, error: '重定向次数超过限制' };
  }
  return {
    statusCode: result.statusCode || 0,
    body: result.body || '',
    finalUrl: result.finalUrl || url,
    error: result.error || null,
    transport: result.transport || '',
    headers: result.headers || {},
    durationMs: Number(result.durationMs || 0),
    responseBytes: Number(result.responseBytes || 0),
    timedOut: result.timedOut === true,
  };
}

module.exports = {
  BASE_URL,
  DETAIL_SUFFIXES,
  buildSearchUrl,
  buildDetailUrl,
  buildDetailCandidateUrls,
  extractCodeTokens,
  hasExactCodeEvidence,
  extractExactSearchCandidates,
  accessChallengeReason,
  isLoginRequired,
  extractDetailEvidence,
  retryAfterMs,
  classifyResponse,
  fetchPage,
};
