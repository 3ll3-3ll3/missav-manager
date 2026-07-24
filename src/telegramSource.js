const crypto = require('node:crypto');
const path = require('node:path');
const parser = require('./parser');
const toolboxFilters = require('./toolboxFilters');

const SAVED_MESSAGES_PATTERN = /^(?:saved messages|saved_messages|收藏消息|已保存的消息|我的收藏)$/i;
const GROUP_CONTAINER_PATTERN = /(?:group|supergroup|channel)/i;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16) || 0));
}

function stripHtml(value) {
  return decodeHtml(String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeTelegramText(value, links = []) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(item => normalizeTelegramText(item, links)).join('');
  if (typeof value !== 'object') return '';
  const href = String(value.href || value.url || '').trim();
  if (/^https?:\/\//i.test(href)) links.push(href);
  if (value.text !== undefined) return normalizeTelegramText(value.text, links);
  if (value.caption !== undefined) return normalizeTelegramText(value.caption, links);
  if (value.file_name !== undefined) return String(value.file_name || '');
  return '';
}

function normalizeLinks(values) {
  return [...new Set((values || [])
    .map(value => String(value || '').trim())
    .filter(value => /^https?:\/\//i.test(value)))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return toolboxFilters.normalizeDate(value) || text.slice(0, 64);
}

function normalizedFingerprintText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hashContent(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function buildTelegramEnvelope(input = {}) {
  const links = normalizeLinks(input.links);
  const text = String(input.text || '').replace(/\r/g, '').trim();
  const messageDate = normalizeDate(input.messageDate || input.date);
  const editedAt = normalizeDate(input.editedAt || input.editDate);
  const accountKey = String(input.accountKey || '').trim().slice(0, 128);
  const chatKey = String(input.chatKey || 'telegram_export').trim().slice(0, 128) || 'telegram_export';
  const messageId = String(input.messageId ?? input.id ?? '').trim().slice(0, 128);
  const contentHash = hashContent(JSON.stringify({
    text: normalizedFingerprintText(text),
    links,
    date: messageDate,
  }));
  const strongKey = accountKey && messageId ? `telegram:${accountKey}:${chatKey}:${messageId}` : '';
  const dedupeKey = strongKey || `telegram-content:${contentHash}`;
  return {
    sourceType: String(input.sourceType || 'unknown').slice(0, 32),
    accountKey,
    chatKey,
    messageId,
    messageDate,
    editedAt,
    text,
    links,
    contentHash,
    dedupeKey,
    codes: parser.parseCodeList([text, ...links].join('\n')),
    sourceLabel: String(input.sourceLabel || '').slice(0, 260),
  };
}

function jsonMessageText(message) {
  const links = [];
  const chunks = [
    normalizeTelegramText(message?.text, links),
    normalizeTelegramText(message?.caption, links),
    normalizeTelegramText(message?.file, links),
    normalizeTelegramText(message?.file_name, links),
    normalizeTelegramText(message?.media_type, links),
  ].filter(Boolean);
  for (const entity of message?.text_entities || message?.caption_entities || []) {
    const href = String(entity?.href || entity?.url || '').trim();
    if (/^https?:\/\//i.test(href)) links.push(href);
  }
  const rawText = chunks.join('\n');
  const inlineUrls = rawText.match(/https?:\/\/[^\s<>"']+/gi) || [];
  links.push(...inlineUrls);
  return { text: rawText, links: normalizeLinks(links) };
}

function isSavedContainer(container = {}) {
  const type = String(container.type || container.chat_type || '').trim();
  const name = String(container.name || container.title || '').trim();
  return SAVED_MESSAGES_PATTERN.test(type) || SAVED_MESSAGES_PATTERN.test(name);
}

function isGroupContainer(container = {}) {
  const type = String(container.type || container.chat_type || '').trim();
  return GROUP_CONTAINER_PATTERN.test(type);
}

function exportContainerChatKey(container = {}, fallback = '') {
  const id = String(container.id ?? container.chat_id ?? '').trim();
  if (id) return id.slice(0, 128);
  const type = String(container.type || container.chat_type || '').trim();
  const name = String(container.name || container.title || '').trim();
  const stable = [type, name, fallback].filter(Boolean).join(':');
  return `export:${hashContent(stable || 'telegram-group').slice(0, 24)}`;
}

function collectJsonMessageContainers(root) {
  const containers = [];
  const seen = new Set();
  const add = (container, explicit = false) => {
    if (!container || !Array.isArray(container.messages) || seen.has(container)) return;
    seen.add(container);
    containers.push({ container, explicit });
  };
  if (Array.isArray(root?.messages)) add(root, true);
  if (Array.isArray(root?.saved_messages?.messages)) add(root.saved_messages, true);
  if (Array.isArray(root?.chats?.list)) root.chats.list.forEach(container => add(container, false));
  if (Array.isArray(root?.chats)) root.chats.forEach(container => add(container, false));
  return containers;
}

function parseTelegramJson(value, options = {}) {
  const root = typeof value === 'string' ? JSON.parse(value.replace(/^\uFEFF/, '')) : value;
  if (!root || typeof root !== 'object') throw new Error('Telegram JSON 顶层格式无效');
  const accountKey = String(
    options.accountKey
    || root.personal_information?.user_id
    || root.personal_information?.id
    || root.user_id
    || '',
  );
  const containers = collectJsonMessageContainers(root);
  const selected = containers.filter(({ container, explicit }) =>
    options.includeAllChats === true
    || explicit
    || isGroupContainer(container)
    || (options.includeSavedMessages === true && isSavedContainer(container)));
  if (!selected.length && containers.length === 1) selected.push(containers[0]);
  const output = [];
  selected.forEach(({ container }, containerIndex) => {
    const sourceLabel = String(container.name || container.title || options.sourceLabel || 'Telegram JSON');
    const chatKey = String(options.chatKey || exportContainerChatKey(container, sourceLabel));
    (container.messages || []).forEach((message, messageIndex) => {
      if (!message || typeof message !== 'object') return;
      const { text, links } = jsonMessageText(message);
      if (!text && !links.length) return;
      output.push(buildTelegramEnvelope({
        sourceType: 'export_json',
        accountKey,
        chatKey,
        messageId: message.id ?? `${containerIndex + 1}:${messageIndex + 1}`,
        messageDate: message.date_unixtime || message.date,
        editedAt: message.edited_unixtime || message.edited,
        text,
        links,
        sourceLabel,
      }));
    });
  });
  return output;
}

function htmlAttribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`, 'i'));
  return decodeHtml(match?.[1] ?? match?.[2] ?? '');
}

function parseTelegramHtml(html, options = {}) {
  const raw = String(html || '');
  const boundary = /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bmessage\b[^"]*"|'[^']*\bmessage\b[^']*')[^>]*\bid\s*=\s*(?:"message(\d+)"|'message(\d+)')[^>]*>/gi;
  const matches = [...raw.matchAll(boundary)];
  const sourceLabel = String(options.sourceLabel || 'Telegram HTML');
  const chatKey = String(options.chatKey || `export:${hashContent(sourceLabel).slice(0, 24)}`);
  const output = [];
  if (!matches.length) {
    const links = [...raw.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)]
      .map(match => decodeHtml(match[1] || match[2] || ''));
    const text = stripHtml(raw);
    if (text || links.length) {
      output.push(buildTelegramEnvelope({
        sourceType: 'export_html',
        accountKey: options.accountKey || '',
        chatKey,
        messageId: options.fallbackMessageId || hashContent(raw).slice(0, 16),
        text,
        links,
        sourceLabel,
      }));
    }
    return output;
  }
  matches.forEach((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? matches[index + 1].index : raw.length;
    const segment = raw.slice(start, end);
    const links = [...segment.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)]
      .map(linkMatch => decodeHtml(linkMatch[1] || linkMatch[2] || ''));
    const dateTag = segment.match(/<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bdate\b[^"]*"|'[^']*\bdate\b[^']*')[^>]*>/i)?.[0] || '';
    const messageDate = htmlAttribute(dateTag, 'title') || htmlAttribute(dateTag, 'data-time');
    const contentMatch = segment.match(/<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\btext\b[^"]*"|'[^']*\btext\b[^']*')[^>]*>([\s\S]*?)(?=<\/div>)/i);
    const mediaMatch = segment.match(/<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bmedia_wrap\b[^"]*"|'[^']*\bmedia_wrap\b[^']*')[^>]*>([\s\S]*?)(?=<\/div>)/i);
    const text = stripHtml([contentMatch?.[1] || '', mediaMatch?.[1] || ''].join('\n')) || stripHtml(segment);
    output.push(buildTelegramEnvelope({
      sourceType: 'export_html',
      accountKey: options.accountKey || '',
      chatKey,
      messageId: match[1] || match[2] || String(index + 1),
      messageDate,
      text,
      links,
      sourceLabel,
    }));
  });
  return output;
}

function apiMessageText(message) {
  const links = [];
  const text = normalizeTelegramText(message?.message ?? message?.text ?? message?.caption ?? '', links);
  const fileName = message?.file?.name || message?.document?.attributes?.find?.(attribute => attribute?.fileName)?.fileName || '';
  const inlineUrls = String(text).match(/https?:\/\/[^\s<>"']+/gi) || [];
  return { text: [text, fileName].filter(Boolean).join('\n'), links: normalizeLinks([...links, ...inlineUrls]) };
}

function telegramApiMessagesToEnvelopes(messages, options = {}) {
  return (messages || []).map((message, index) => {
    const { text, links } = apiMessageText(message);
    return buildTelegramEnvelope({
      sourceType: 'api',
      accountKey: options.accountKey || '',
      chatKey: options.chatKey || 'telegram_group',
      messageId: message?.id ?? index + 1,
      messageDate: message?.date,
      editedAt: message?.editDate,
      text,
      links,
      sourceLabel: options.sourceLabel || 'Telegram API · 群组',
    });
  }).filter(message => message.text || message.links.length);
}

function mergeTelegramEnvelopes(envelopes) {
  const output = [];
  const strong = new Map();
  const content = new Map();
  for (const envelope of envelopes || []) {
    if (!envelope) continue;
    const strongKey = envelope.accountKey && envelope.messageId
      ? `${envelope.accountKey}:${envelope.chatKey}:${envelope.messageId}`
      : '';
    const strongIndex = strongKey ? strong.get(strongKey) : undefined;
    const existingIndex = strongIndex ?? content.get(envelope.contentHash);
    if (existingIndex !== undefined) {
      const current = output[existingIndex];
      output[existingIndex] = {
        ...current,
        ...envelope,
        sourceType: current.sourceType === envelope.sourceType ? current.sourceType : 'mixed',
        codes: [...new Set([...(current.codes || []), ...(envelope.codes || [])])],
      };
      continue;
    }
    const nextIndex = output.length;
    output.push(envelope);
    if (strongKey) strong.set(strongKey, nextIndex);
    content.set(envelope.contentHash, nextIndex);
  }
  return output;
}

function parseTelegramExportFiles(files, options = {}) {
  const envelopes = [];
  const errors = [];
  for (const file of files || []) {
    const filePath = String(file?.path || file?.name || '');
    const extension = path.extname(filePath).toLowerCase();
    try {
      if (extension === '.json') {
        envelopes.push(...parseTelegramJson(file.content, { ...options, sourceLabel: path.basename(filePath) }));
      } else if (extension === '.html' || extension === '.htm') {
        envelopes.push(...parseTelegramHtml(file.content, { ...options, sourceLabel: path.basename(filePath) }));
      }
    } catch (error) {
      errors.push({ file: path.basename(filePath), error: error.message || String(error) });
    }
  }
  return { messages: mergeTelegramEnvelopes(envelopes), errors };
}

module.exports = {
  SAVED_MESSAGES_PATTERN,
  GROUP_CONTAINER_PATTERN,
  normalizeTelegramText,
  buildTelegramEnvelope,
  parseTelegramJson,
  parseTelegramHtml,
  telegramApiMessagesToEnvelopes,
  mergeTelegramEnvelopes,
  parseTelegramExportFiles,
};
