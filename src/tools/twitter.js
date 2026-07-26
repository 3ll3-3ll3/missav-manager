const { normalizedText, messageText, filterMessagesByTime } = require('./common');

const TWITTER_RESERVED_PATHS = new Set([
  'about', 'compose', 'explore', 'hashtag', 'home', 'i', 'intent', 'login',
  'messages', 'notifications', 'search', 'settings', 'share', 'signup',
]);

const manifest = Object.freeze({
  id: 'twitter',
  label: '推特博主',
  description: '从 Telegram 消息或文件中提取博主名和 X 主页链接',
  category: 'text',
  categoryLabel: '文本提取',
  icon: 'at-sign',
  accent: 'blue',
  defaultPage: 'twitter',
  pages: ['twitter'],
  capabilities: Object.freeze({
    telegram: true,
    fileInput: true,
    timeRange: true,
    network: false,
    accountAction: false,
    persistentResults: true,
  }),
});

function validTwitterHandle(value) {
  const handle = String(value || '').trim().replace(/^[@#]/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return '';
  if (TWITTER_RESERVED_PATHS.has(handle.toLowerCase())) return '';
  return handle;
}

function validTwitterHashtag(value, context = {}) {
  const handle = validTwitterHandle(value);
  if (!handle || handle.length < 4) return '';
  const prefix = String(context.text || '').slice(Math.max(0, Number(context.index || 0) - 24), Number(context.index || 0));
  if (/传送门[\s：:→-]*$/u.test(prefix)) return '';
  return handle;
}

function validMentionedTwitterHandle(value) {
  const handle = validTwitterHandle(value);
  if (!handle || /_bot$/i.test(handle)) return '';
  return handle;
}

function extractTwitterProfiles(input, options = {}) {
  const messages = Array.isArray(input)
    ? filterMessagesByTime(input, options)
    : [{ text: normalizedText(input), links: [] }];
  const output = [];
  const seen = new Set();
  const add = value => {
    const handle = validTwitterHandle(value);
    const key = handle.toLowerCase();
    if (!handle || seen.has(key)) return;
    seen.add(key);
    output.push({ name: handle, url: `https://x.com/${handle}` });
  };
  for (const message of messages) {
    const text = messageText(message);
    for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}_])#([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gu)) {
      add(validTwitterHashtag(match[1], { text, index: Number(match.index || 0) + match[0].lastIndexOf('#') }));
    }
    for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}_])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gu)) {
      add(validMentionedTwitterHandle(match[1]));
    }
    for (const match of text.matchAll(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=$|[/?#\s"'<>])/gi)) {
      add(match[1]);
    }
  }
  return output;
}

module.exports = {
  manifest,
  TWITTER_RESERVED_PATHS,
  validTwitterHandle,
  validTwitterHashtag,
  validMentionedTwitterHandle,
  extractTwitterProfiles,
};
