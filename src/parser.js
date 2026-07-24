/**
 * MissAV Manager — 番号解析 & URL 生成
 */

/**
 * 从字符串中提取 FC2 数字编号
 */
function extractFC2Number(s) {
  const text = String(s || '').trim().toUpperCase();

  const m1 = text.match(/^FC2[_\-\s]*PPV[_\-\s]*(\d+)$/i);
  if (m1) return m1[1];

  const m2 = text.match(/^FC2[_\-\s]*(\d+)$/i);
  if (m2) return m2[1];

  const m3 = text.match(/FC2[_\-\s]*PPV[_\-\s]*(\d+)/i);
  if (m3) return m3[1];

  const m4 = text.match(/FC2[_\-\s]*(\d+)/i);
  if (m4) return m4[1];

  return '';
}

/**
 * 从 MissAV URL 或任意 slug 中提取番号片段。
 * 支持 /cn/abf-354、/dm89/cn/FC2-4625027、fc2-ppv-4625027-chinese-subtitle。
 */
function extractCodeFromUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  let slug = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      slug = url.pathname.split('/').filter(Boolean).pop() || '';
    }
  } catch {
    slug = raw.split(/[?#]/)[0].split('/').filter(Boolean).pop() || raw;
  }

  slug = decodeURIComponent(slug)
    .replace(/-chinese-subtitle$/i, '')
    .replace(/-uncensored-leak$/i, '')
    .replace(/[_\s]+/g, '-')
    .trim();

  const fc2 = slug.match(/^fc2(?:-?ppv)?-?(\d{4,10})$/i);
  if (fc2) return `FC2-PPV-${fc2[1]}`;

  const normal = slug.match(/^([a-z]{2,8})-?(\d{2,5})$/i);
  if (normal) return `${normal[1].toUpperCase()}-${normal[2]}`;

  return '';
}

/**
 * 标准化番号
 */
function normalizeCode(s) {
  s = String(s || '').trim();

  const shouldExtractFromSlug = /^https?:\/\//i.test(s) || /missav\./i.test(s) || /-(chinese-subtitle|uncensored-leak)$/i.test(s);
  const urlCode = shouldExtractFromSlug ? extractCodeFromUrl(s) : '';
  if (urlCode) return normalizeCode(urlCode);

  s = decodeLooseText(s).toUpperCase().replace(/\s+/g, '');

  // FC2 系列
  if (/^FC2/i.test(s)) {
    const n = extractFC2Number(s);
    if (n) return `FC2-PPV-${n}`;
  }

  // 标准番号: ABF-354, SONE-314, ABF354 等
  const m = s.match(/^([A-Z]{2,8})[-_]?(\d{2,5})$/);
  if (m) return `${m[1]}-${m[2]}`;

  return s;
}

/**
 * 生成用于比较的 key（去除横线，FC2 统一格式）
 */
function codeComparableKey(code) {
  const c = normalizeCode(code);
  if (c.startsWith('FC2-PPV-')) {
    const n = extractFC2Number(c);
    return `FC2PPV${n}`;
  }
  return c.replace(/-/g, '');
}

/**
 * 生成番号的所有变体，用于判断是否为同一部片
 */
function codeVariants(code) {
  const c = normalizeCode(code);
  const variants = new Set([c, c.replace(/-/g, '')]);

  if (c.startsWith('FC2-PPV-')) {
    const n = extractFC2Number(c);
    variants.add(`FC2-${n}`);
    variants.add(`FC2PPV${n}`);
    variants.add(`FC2PPV-${n}`);
    variants.add(`FC2-PPV-${n}`);
  }

  return [...variants];
}

/**
 * 生成 MissAV 候选链接列表
 */
function candidateUrls(code) {
  const c = normalizeCode(code);
  const urls = [];

  if (c.startsWith('FC2-PPV-')) {
    const n = extractFC2Number(c);

    // FC2 候选链接
    urls.push(`https://missav.ai/cn/fc2-ppv-${n}`);
    urls.push(`https://missav.ai/cn/fc2-ppv-${n}-chinese-subtitle`);
    urls.push(`https://missav.ai/cn/fc2-ppv-${n}-uncensored-leak`);
    urls.push(`https://missav.ai/dm96/cn/FC2-${n}`);
    urls.push(`https://missav.ai/dm89/cn/FC2-${n}`);
    urls.push(`https://missav.ai/dm96/cn/FC2-PPV-${n}`);
    urls.push(`https://missav.ai/dm89/cn/FC2-PPV-${n}`);
  } else {
    const lower = c.toLowerCase();

    // 普通番号候选链接
    urls.push(`https://missav.ai/cn/${lower}`);
    urls.push(`https://missav.ai/cn/${lower}-chinese-subtitle`);
    urls.push(`https://missav.ai/cn/${lower}-uncensored-leak`);
    urls.push(`https://missav.ai/dm96/cn/${c}`);
    urls.push(`https://missav.ai/dm89/cn/${c}`);
  }

  return urls;
}

const NOISE_CODE_PREFIXES = new Set([
  'MESSAGE', 'MESSAGES', 'USERPIC', 'MEDIA', 'VIDEO', 'PHOTO', 'AVATAR',
  'PAGINATION', 'DETAILS', 'STATUS', 'TITLE', 'BODY', 'CLASS', 'STYLE',
  'DATE', 'HTML', 'BUTTON', 'INPUT', 'IMAGE', 'THUMB', 'THUMBNAIL',
  'AV', 'TOP', 'BEST', 'FUCK', 'MOODYZ', 'TAMEIKE',
  'ALL', 'PDF', 'TELEGRAM', 'LOGO', 'JOHREN', 'IEOR', 'PROBABILITY',
  'STATISTICS', 'PYTHON', 'OFFICE', 'GITHUB', 'SERIES', 'WEIXIN',
  'RESULT', 'RELATED', 'THREAD', 'XIUREN', 'WXSYNC', 'JAVA', 'LARGE',
  'RJ', 'NO',
]);

const DATE_WORD_PREFIXES = new Set([
  'JAN', 'JANUARY', 'FEB', 'FEBRUARY', 'MAR', 'MARCH', 'APR', 'APRIL',
  'MAY', 'JUN', 'JUNE', 'JUL', 'JULY', 'AUG', 'AUGUST', 'SEP', 'SEPT',
  'SEPTEMBER', 'OCT', 'OCTOBER', 'NOV', 'NOVEMBER', 'DEC', 'DECEMBER',
]);

function isNoiseCodePrefix(code) {
  const m = String(code || '').toUpperCase().match(/^([A-Z]+)-([0-9]+)$/);
  if (!m) return false;
  const prefix = m[1];
  const num = Number(m[2]);
  if (NOISE_CODE_PREFIXES.has(prefix)) return true;
  if (DATE_WORD_PREFIXES.has(prefix) && num >= 1900 && num <= 2099) return true;
  return ['SPRING', 'SUMMER', 'FALL', 'AUTUMN', 'WINTER'].includes(prefix) && num >= 1900 && num <= 2099;
}
function decodeLooseText(text) {
  return String(text || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function isLikelyStandardCode(code) {
  if (/^PPV-\d+/i.test(code)) return false;
  if (isNoiseCodePrefix(code)) return false;
  return /^(FC2-PPV-\d{4,10}|[A-Z]{2,8}-\d{2,5})$/.test(code);
}

function addCode(codes, raw, index = 0) {
  const code = normalizeCode(raw);
  if (isLikelyStandardCode(code)) codes.push({ code, index });
}

const TRUSTED_AV_HOSTS = [
  'missav.ai', '123av.com', 'avbase.net', 'javdb.com', 'javbus.com',
  'javlibrary.com', 'supjav.com', 'njav.tv', 'jable.tv', 'jav.guru',
];

function isTrustedAvHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return TRUSTED_AV_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function extractCodesFromTrustedAvUrl(input) {
  const raw = String(input || '').trim().replace(/[.,;!?]+$/, '');
  if (!/^https?:\/\//i.test(raw)) return [];
  let url;
  try { url = new URL(raw); } catch { return []; }
  if (!isTrustedAvHost(url.hostname)) return [];

  const source = decodeURIComponent(url.pathname);
  const matches = [];
  const fc2Pattern = /(?:^|[^a-z0-9])fc2(?:[\s_-]*ppv)?[\s_-]*(\d{4,10})(?=$|[^0-9])/gi;
  for (const match of source.matchAll(fc2Pattern)) matches.push(`FC2-PPV-${match[1]}`);
  const standardPattern = /(?:^|[^a-z])([a-z]{2,8})[\s_-]+(\d{2,5})(?=$|[^0-9])/gi;
  for (const match of source.matchAll(standardPattern)) {
    const code = normalizeCode(`${match[1]}-${match[2]}`);
    if (isLikelyStandardCode(code)) matches.push(code);
  }
  return [...new Set(matches)];
}

function maskGenericNoise(text) {
  const preserveLength = match => match.replace(/[^\r\n]/g, ' ');
  return String(text || '')
    .replace(/https?:\/\/[^\s"'<>)]*/gi, preserveLength)
    .replace(/<[^>]*>/g, preserveLength);
}

/**
 * 从任意纯文本、HTML、Markdown、Telegram 导出文本中提取番号列表。
 */
function parseCodeList(text) {
  const raw = String(text || '');
  const decoded = decodeLooseText(raw);
  const codes = [];

  // 可信 AV URL 优先；普通网页 URL 和图片路径不参与通用番号匹配。
  const urlPattern = /https?:\/\/[^\s"'<>)]*/gi;
  for (const match of decoded.matchAll(urlPattern)) {
    for (const code of extractCodesFromTrustedAvUrl(match[0])) addCode(codes, code, match.index || 0);
  }

  const visibleText = maskGenericNoise(decoded);

  // FC2 系列：FC2-PPV-1234567、FC2 1234567、FC2_1234567。
  const fc2Pattern = /(^|[^A-Za-z0-9])FC2(?:[\s_-]*PPV)?[\s_-]*(\d{4,10})(?=$|[^A-Za-z0-9])/gi;
  for (const match of visibleText.matchAll(fc2Pattern)) {
    addCode(codes, `FC2-PPV-${match[2]}`, (match.index || 0) + match[1].length);
  }

  // 带分隔符的普通番号：ABF-354、sone_314、ABF 354。
  const separatedPattern = /(^|[^A-Za-z0-9])([A-Za-z]{2,8})[\s_-]+(\d{2,5})(?=$|[^A-Za-z0-9])/g;
  for (const match of visibleText.matchAll(separatedPattern)) {
    addCode(codes, `${match[2]}-${match[3]}`, (match.index || 0) + match[1].length);
  }

  // 无分隔符只接受原文大写前缀，避免 message14298、userpic6、media_video 等 HTML class/id 误判。
  const compactUpperPattern = /(^|[^A-Za-z0-9])([A-Z]{2,8})(\d{2,5})(?=$|[^A-Za-z0-9])/g;
  for (const match of visibleText.matchAll(compactUpperPattern)) {
    addCode(codes, `${match[2]}-${match[3]}`, (match.index || 0) + match[1].length);
  }

  // 去重，保留首次出现顺序
  const seen = new Set();
  return codes
    .sort((a, b) => a.index - b.index)
    .filter(item => {
      const key = codeComparableKey(item.code);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(item => item.code);
}
module.exports = {
  extractFC2Number,
  extractCodeFromUrl,
  extractCodesFromTrustedAvUrl,
  normalizeCode,
  codeComparableKey,
  codeVariants,
  candidateUrls,
  parseCodeList,
};









