const { normalizedText, messageText, filterMessagesByTime } = require('./common');

const HAIJIAO_POST_CATEGORIES = Object.freeze([
  'hjjd',
  'hjmz',
  'hjyc',
  'hjfn',
  'hjsz',
  'hjrq',
  'hjhj',
]);
const HAIJIAO_CATEGORY_PATTERN = HAIJIAO_POST_CATEGORIES.join('|');

const manifest = Object.freeze({
  id: 'haijiao',
  label: '海角帖子',
  description: '提取并规范化海角内容帖直达链接',
  category: 'text',
  categoryLabel: '文本提取',
  icon: 'waves',
  accent: 'cyan',
  defaultPage: 'haijiao',
  pages: ['haijiao'],
  capabilities: Object.freeze({
    telegram: true,
    fileInput: true,
    timeRange: true,
    network: false,
    accountAction: false,
    persistentResults: true,
  }),
});

function canonicalHaijiaoUrl(value) {
  const match = String(value || '').match(new RegExp(
    `https?:\\/\\/(?:www\\.)?haijiaolove\\.xyz\\/(${HAIJIAO_CATEGORY_PATTERN})\\/(\\d+)\\.html(?=$|[/?#\\s\"'<>])`,
    'i',
  ));
  if (!match) return '';
  return `https://www.haijiaolove.xyz/${match[1].toLowerCase()}/${match[2]}.html`;
}

function extractHaijiaoLinks(input, options = {}) {
  const messages = Array.isArray(input)
    ? filterMessagesByTime(input, options)
    : [{ text: normalizedText(input), links: [] }];
  const output = [];
  const seen = new Set();
  const candidatePattern = new RegExp(
    `https?:\\/\\/(?:www\\.)?haijiaolove\\.xyz\\/(?:${HAIJIAO_CATEGORY_PATTERN})\\/\\d+\\.html(?:[/?#][^\\s\"'<>]*)?`,
    'gi',
  );
  for (const message of messages) {
    for (const match of messageText(message).matchAll(candidatePattern)) {
      const url = canonicalHaijiaoUrl(match[0]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      output.push(url);
    }
  }
  return output;
}

module.exports = {
  manifest,
  HAIJIAO_POST_CATEGORIES,
  canonicalHaijiaoUrl,
  extractHaijiaoLinks,
};
