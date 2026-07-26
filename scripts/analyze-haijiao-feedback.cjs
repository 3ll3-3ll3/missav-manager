const fs = require('node:fs');
const path = require('node:path');
const { parseTelegramHtml } = require('../src/telegramSource');
const { extractHaijiaoLinks } = require('../src/tools/haijiao');

const inputDirectory = path.resolve(process.argv[2] || '');
if (!inputDirectory || !fs.existsSync(inputDirectory)) {
  throw new Error('请传入包含 Telegram messages*.html 的目录');
}

const files = fs.readdirSync(inputDirectory)
  .filter(name => /^messages(?:\d+)?\.html$/i.test(name))
  .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
const messages = files.flatMap(name => parseTelegramHtml(
  fs.readFileSync(path.join(inputDirectory, name), 'utf8'),
  { sourceLabel: name },
));
const extractedPosts = extractHaijiaoLinks(messages);
const hosts = new Map();
const paths = new Map();
const validPosts = new Set();
const otherHaijiao = new Map();
const haijiaoCategories = new Map();
const samples = [];
let linkedMessages = 0;

for (const message of messages) {
  const urls = [
    ...(message.links || []),
    ...(String(message.text || '').match(/https?:\/\/[^\s<>"']+/gi) || []),
  ];
  if (urls.length) linkedMessages++;
  for (const raw of urls) {
    try {
      const url = new URL(String(raw).replace(/&amp;/gi, '&'));
      const hostname = url.hostname.toLowerCase();
      hosts.set(hostname, (hosts.get(hostname) || 0) + 1);
      const firstPath = url.pathname.split('/').filter(Boolean)[0] || '/';
      const pathKey = `${hostname}/${firstPath}`;
      paths.set(pathKey, (paths.get(pathKey) || 0) + 1);
      const post = url.pathname.match(/^\/hjsz\/(\d+)\.html\/?$/i);
      if (/(^|\.)haijiaolove\.xyz$/i.test(hostname)) {
        const category = firstPath.toLowerCase();
        const current = haijiaoCategories.get(category) || { occurrences: 0, urls: new Set(), sample: null };
        current.occurrences++;
        current.urls.add(`${url.origin}${url.pathname}`);
        if (!current.sample) {
          current.sample = {
            id: message.messageId,
            text: String(message.text || '').slice(0, 320),
            raw,
          };
        }
        haijiaoCategories.set(category, current);
      }
      if (/(^|\.)haijiaolove\.xyz$/i.test(hostname) && post) {
        validPosts.add(`https://www.haijiaolove.xyz/hjsz/${post[1]}.html`);
        if (samples.length < 20) {
          samples.push({
            id: message.messageId,
            date: message.messageDate,
            text: String(message.text || '').slice(0, 260),
            raw,
          });
        }
      } else if (/haijiao/i.test(hostname)) {
        const key = `${hostname}${url.pathname}`;
        otherHaijiao.set(key, (otherHaijiao.get(key) || 0) + 1);
      }
    } catch {}
  }
}

function topRows(map, limit = 80) {
  return [...map].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit);
}

process.stdout.write(`${JSON.stringify({
  files: files.length,
  messages: messages.length,
  linkedMessages,
  uniqueValidPosts: validPosts.size,
  extractedCanonicalPosts: extractedPosts.length,
  hostCount: hosts.size,
}, null, 2)}\n`);
process.stdout.write(`HOSTS\n${topRows(hosts).map(row => row.join('\t')).join('\n')}\n`);
process.stdout.write(`PATHS\n${topRows(paths).map(row => row.join('\t')).join('\n')}\n`);
process.stdout.write(`HAIJIAO_OTHER\n${topRows(otherHaijiao).map(row => row.join('\t')).join('\n')}\n`);
process.stdout.write(`HAIJIAO_CATEGORIES\n${[...haijiaoCategories]
  .sort((left, right) => right[1].occurrences - left[1].occurrences)
  .map(([category, value]) => JSON.stringify({
    category,
    occurrences: value.occurrences,
    uniqueUrls: value.urls.size,
    sample: value.sample,
  }))
  .join('\n')}\n`);
process.stdout.write(`SAMPLES\n${samples.map(row => JSON.stringify(row)).join('\n')}\n`);
