const { normalizedText, messageText, filterMessagesByTime } = require('./common');

const manifest = Object.freeze({
  id: 'badnews',
  label: 'Bad.news 帖子',
  description: '提取并规范化 Bad.news 帖子链接',
  category: 'text',
  categoryLabel: '文本提取',
  icon: 'link',
  accent: 'orange',
  defaultPage: 'badnews',
  pages: ['badnews'],
  capabilities: Object.freeze({
    telegram: true,
    fileInput: true,
    timeRange: true,
    network: false,
    accountAction: false,
    persistentResults: false,
  }),
});

function canonicalBadNewsUrl(value) {
  const match = String(value || '').match(/https?:\/\/(?:www\.)?bad\.news\/t\/(\d+)(?=$|[/?#\s"'<>])/i);
  return match ? `https://bad.news/t/${match[1]}` : '';
}

function extractBadNewsLinks(input, options = {}) {
  const messages = Array.isArray(input)
    ? filterMessagesByTime(input, options)
    : [{ text: normalizedText(input), links: [] }];
  const output = [];
  const seen = new Set();
  for (const message of messages) {
    for (const match of messageText(message).matchAll(/https?:\/\/(?:www\.)?bad\.news\/t\/\d+(?:[/?#][^\s"'<>]*)?/gi)) {
      const url = canonicalBadNewsUrl(match[0]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      output.push(url);
    }
  }
  return output;
}

module.exports = {
  manifest,
  canonicalBadNewsUrl,
  extractBadNewsLinks,
};
