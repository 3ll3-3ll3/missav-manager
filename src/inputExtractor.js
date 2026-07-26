/**
 * Input-aware code extraction.
 * Raindrop CSV is parsed by columns so IDs, timestamps, covers and unrelated URLs
 * never enter the generic JAV code matcher.
 */
const parser = require('./parser');
const csvTools = require('./csvTools');

const JAV_FOLDER_PATTERN = /(?:日本\s*av|missav|123av|\bjav\b|番号)/i;

function uniqueCodes(values) {
  const seen = new Set();
  return (values || []).filter(code => {
    const key = parser.codeComparableKey(code);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTrustedMissavUrl(value) {
  const raw = String(value || '').trim().replace(/[.,;!?，。；！？]+$/, '');
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const trustedHosts = ['missav.ai', 'missav.ws'];
    if (!trustedHosts.some(domain => host === domain || host.endsWith(`.${domain}`))) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

function entriesFromCodesAndUrls(codes, urlPairs = []) {
  const sourceByKey = new Map();
  for (const pair of urlPairs) {
    const sourceUrl = normalizeTrustedMissavUrl(pair?.url);
    if (!sourceUrl) continue;
    const values = Array.isArray(pair?.codes) ? pair.codes : parser.extractCodesFromTrustedAvUrl(sourceUrl);
    for (const code of values) {
      const key = parser.codeComparableKey(code);
      if (key && !sourceByKey.has(key)) sourceByKey.set(key, sourceUrl);
    }
  }
  return uniqueCodes(codes).map(code => ({
    code,
    sourceUrl: sourceByKey.get(parser.codeComparableKey(code)) || '',
  }));
}

function isRaindropCsv(parsed) {
  const headers = new Set((parsed?.headers || []).map(header => String(header || '').trim().toLowerCase()));
  return ['title', 'url', 'folder', 'tags', 'created', 'cover'].every(header => headers.has(header));
}

function titleIsEssentiallyCode(title, code) {
  const normalizedTitle = String(title || '').trim().replace(/[【】[\]()]/g, '').replace(/\s*#\d+\s*$/, '').trim();
  if (!normalizedTitle) return false;
  const only = parser.parseCodeList(normalizedTitle);
  if (only.length !== 1 || parser.codeComparableKey(only[0]) !== parser.codeComparableKey(code)) return false;
  const codePattern = String(code).replace('-', '[\\s_-]*');
  return new RegExp(`^${codePattern}$`, 'i').test(normalizedTitle);
}

function parseRaindropCsvCodes(parsed) {
  const indexByName = new Map(parsed.headers.map((header, index) => [String(header || '').trim().toLowerCase(), index]));
  const at = (row, name) => String(row[indexByName.get(name)] || '');
  const output = [];

  for (const row of parsed.rows || []) {
    const title = at(row, 'title');
    const url = at(row, 'url');
    const folder = at(row, 'folder');
    const trustedUrlCodes = parser.extractCodesFromTrustedAvUrl(url);
    // Raindrop 的 excerpt 常含网站促销、年份和产品版本；番号只从标题与可信 AV URL 取证。
    const contextualCodes = parser.parseCodeList(title);
    output.push(...trustedUrlCodes);

    const trustedContext = JAV_FOLDER_PATTERN.test(folder) || trustedUrlCodes.length > 0;
    for (const code of contextualCodes) {
      if (trustedContext || titleIsEssentiallyCode(title, code)) output.push(code);
    }
  }
  return uniqueCodes(output);
}

function parseRaindropCsvEntries(parsed) {
  const indexByName = new Map(parsed.headers.map((header, index) => [String(header || '').trim().toLowerCase(), index]));
  const urlIndex = indexByName.get('url');
  const urls = [];
  for (const row of parsed.rows || []) {
    const url = String(row[urlIndex] || '');
    const sourceUrl = normalizeTrustedMissavUrl(url);
    if (sourceUrl) urls.push({ url: sourceUrl, codes: parser.extractCodesFromTrustedAvUrl(sourceUrl) });
  }
  return entriesFromCodesAndUrls(parseRaindropCsvCodes(parsed), urls);
}

function parseInputEntries(text) {
  const raw = String(text || '');
  const firstLine = raw.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].toLowerCase();
  if (firstLine.includes('title') && firstLine.includes('url') && firstLine.includes('folder') && firstLine.includes('cover')) {
    try {
      const parsed = csvTools.parseCSV(raw);
      if (isRaindropCsv(parsed)) return parseRaindropCsvEntries(parsed);
    } catch {}
  }
  const urlPairs = [];
  for (const match of raw.matchAll(/https?:\/\/[^\s"'<>)]*/gi)) {
    const sourceUrl = normalizeTrustedMissavUrl(match[0]);
    if (sourceUrl) urlPairs.push({ url: sourceUrl, codes: parser.extractCodesFromTrustedAvUrl(sourceUrl) });
  }
  return entriesFromCodesAndUrls(parser.parseCodeList(raw), urlPairs);
}

function parseInputCodeList(text) {
  return parseInputEntries(text).map(entry => entry.code);
}

module.exports = {
  JAV_FOLDER_PATTERN,
  isRaindropCsv,
  normalizeTrustedMissavUrl,
  parseRaindropCsvCodes,
  parseRaindropCsvEntries,
  parseInputEntries,
  parseInputCodeList,
};
