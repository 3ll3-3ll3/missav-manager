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

function parseInputCodeList(text) {
  const raw = String(text || '');
  const firstLine = raw.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].toLowerCase();
  if (firstLine.includes('title') && firstLine.includes('url') && firstLine.includes('folder') && firstLine.includes('cover')) {
    try {
      const parsed = csvTools.parseCSV(raw);
      if (isRaindropCsv(parsed)) return parseRaindropCsvCodes(parsed);
    } catch {}
  }
  return parser.parseCodeList(raw);
}

module.exports = { JAV_FOLDER_PATTERN, isRaindropCsv, parseRaindropCsvCodes, parseInputCodeList };
