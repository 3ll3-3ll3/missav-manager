const { buildTelegramEnvelope } = require('./telegramSource');

const BOT_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,}$/;
const BOT_UPDATE_TYPES = Object.freeze([
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
]);
const GROUP_CHAT_TYPES = new Set(['group', 'supergroup', 'channel']);

function normalizeBotToken(value) {
  const token = String(value || '').trim();
  if (!BOT_TOKEN_PATTERN.test(token)) throw new Error('Bot Token 格式无效，请从 @BotFather 重新复制完整 Token');
  return token;
}

function redactBotSecrets(value, token = '') {
  let text = String(value?.message || value || '');
  if (token) text = text.split(token).join('[REDACTED_BOT_TOKEN]');
  return text
    .replace(/\b\d{5,20}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_BOT_TOKEN]')
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi, 'https://api.telegram.org/bot[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function botAccountKey(user = {}) {
  const id = Number(user?.id);
  return Number.isSafeInteger(id) && id > 0 ? `bot:${id}` : '';
}

function botAccountLabel(user = {}) {
  const username = String(user?.username || '').trim();
  const name = [user?.first_name, user?.last_name].map(value => String(value || '').trim()).filter(Boolean).join(' ');
  if (username && name) return `${name} (@${username})`;
  if (username) return `@${username}`;
  return name || (user?.id ? `Telegram Bot ${user.id}` : 'Telegram Bot');
}

function normalizeTelegramDate(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toISOString();
}

function entityLinks(text, entities) {
  const source = String(text || '');
  const links = [];
  for (const entity of Array.isArray(entities) ? entities : []) {
    const explicit = String(entity?.url || '').trim();
    if (/^https?:\/\//i.test(explicit)) links.push(explicit);
    if (String(entity?.type || '') === 'url') {
      const offset = Math.max(0, Number(entity?.offset) || 0);
      const length = Math.max(0, Number(entity?.length) || 0);
      const inline = source.slice(offset, offset + length).trim();
      if (/^https?:\/\//i.test(inline)) links.push(inline);
    }
  }
  links.push(...(source.match(/https?:\/\/[^\s<>"']+/gi) || []));
  return [...new Set(links)];
}

function updateMessage(update = {}) {
  for (const type of BOT_UPDATE_TYPES) {
    if (update?.[type]) return { type, message: update[type] };
  }
  return null;
}

function chatSummary(chat = {}, message = {}) {
  const chatKey = String(chat?.id ?? '').trim();
  const chatType = String(chat?.type || '').trim().toLowerCase();
  if (!chatKey || !GROUP_CHAT_TYPES.has(chatType)) return null;
  const username = String(chat?.username || '').trim();
  const title = String(
    chat?.title
    || [chat?.first_name, chat?.last_name].map(value => String(value || '').trim()).filter(Boolean).join(' ')
    || (username ? `@${username}` : `Telegram ${chatKey}`),
  ).trim().slice(0, 260);
  return {
    chatKey,
    chatType,
    title,
    username,
    latestMessageId: Math.max(0, Number(message?.message_id) || 0),
    latestMessageDate: normalizeTelegramDate(message?.date),
  };
}

function mergeGroupSummary(target, next) {
  if (!target) return next;
  if (Number(next.latestMessageId || 0) >= Number(target.latestMessageId || 0)) {
    return { ...target, ...next };
  }
  return {
    ...target,
    title: next.title || target.title,
    username: next.username || target.username,
    chatType: next.chatType || target.chatType,
  };
}

function parseBotUpdates(updates, options = {}) {
  const accountKey = String(options.accountKey || '').trim();
  const groups = new Map();
  const groupedMessages = new Map();
  let lastUpdateId = Math.max(0, Number(options.previousUpdateId) || 0);

  for (const update of Array.isArray(updates) ? updates : []) {
    const updateId = Math.max(0, Number(update?.update_id) || 0);
    lastUpdateId = Math.max(lastUpdateId, updateId);
    const entry = updateMessage(update);
    if (!entry) continue;
    const message = entry.message || {};
    const group = chatSummary(message.chat, message);
    if (!group) continue;
    groups.set(group.chatKey, mergeGroupSummary(groups.get(group.chatKey), group));

    const text = String(message.text ?? message.caption ?? '').trim();
    const fileName = String(
      message.document?.file_name
      || message.video?.file_name
      || message.audio?.file_name
      || message.animation?.file_name
      || '',
    ).trim();
    const links = [
      ...entityLinks(message.text, message.entities),
      ...entityLinks(message.caption, message.caption_entities),
    ];
    if (!text && !fileName && !links.length) continue;
    const envelope = buildTelegramEnvelope({
      sourceType: 'bot_api',
      accountKey,
      chatKey: group.chatKey,
      messageId: message.message_id,
      messageDate: message.date,
      editedAt: message.edit_date,
      text: [text, fileName].filter(Boolean).join('\n'),
      links,
      sourceLabel: `Telegram Bot · ${group.title}`,
    });
    const rows = groupedMessages.get(group.chatKey) || [];
    rows.push(envelope);
    groupedMessages.set(group.chatKey, rows);
  }

  return {
    updateCount: Array.isArray(updates) ? updates.length : 0,
    lastUpdateId,
    nextOffset: lastUpdateId > 0 ? lastUpdateId + 1 : 0,
    groups: [...groups.values()].sort((left, right) => left.title.localeCompare(right.title)),
    messageGroups: [...groups.values()].map(group => ({
      ...group,
      messages: groupedMessages.get(group.chatKey) || [],
    })),
  };
}

class TelegramBotService {
  constructor(options = {}) {
    this.readSecret = options.readSecret || (() => null);
    this.writeSecret = options.writeSecret || (() => {});
    this.clearSecret = options.clearSecret || (() => {});
    this.request = options.request || (async () => { throw new Error('Telegram Bot API 传输未配置'); });
    this.log = options.log || (() => {});
    this.secret = null;
    this.connected = false;
    this.lastError = '';
  }

  safeLog(level, event, data = {}) {
    const token = this.secret?.token || '';
    const safe = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (/token|secret|body|payload/i.test(key)) continue;
      safe[key] = typeof value === 'string' ? redactBotSecrets(value, token) : value;
    }
    this.log(level, event, safe);
  }

  loadSecret() {
    if (this.secret?.token) return this.secret;
    const stored = this.readSecret();
    if (!stored?.token) return null;
    this.secret = {
      token: normalizeBotToken(stored.token),
      botId: String(stored.botId || ''),
      username: String(stored.username || ''),
      accountKey: String(stored.accountKey || ''),
      accountLabel: String(stored.accountLabel || ''),
    };
    return this.secret;
  }

  status() {
    let configured = false;
    let stored = this.secret;
    try {
      stored = this.loadSecret();
      configured = Boolean(stored?.token);
    } catch (error) {
      this.lastError = redactBotSecrets(error);
    }
    return {
      status: this.connected ? 'ready' : this.lastError ? 'error' : 'disconnected',
      configured,
      connected: this.connected,
      accountKey: String(stored?.accountKey || ''),
      accountLabel: String(stored?.accountLabel || ''),
      username: String(stored?.username || ''),
      error: this.lastError,
    };
  }

  async connect(tokenOverride = '') {
    const stored = tokenOverride ? null : this.loadSecret();
    const token = normalizeBotToken(tokenOverride || stored?.token || '');
    try {
      const user = await this.request('getMe', {}, token);
      if (!user?.is_bot || !botAccountKey(user)) throw new Error('Telegram 返回的账号不是有效机器人');
      this.secret = {
        token,
        botId: String(user.id),
        username: String(user.username || ''),
        accountKey: botAccountKey(user),
        accountLabel: botAccountLabel(user),
      };
      this.writeSecret(this.secret);
      this.connected = true;
      this.lastError = '';
      this.safeLog('info', 'telegram_bot_connected', {
        accountKey: this.secret.accountKey,
        accountLabel: this.secret.accountLabel,
      });
      return this.status();
    } catch (error) {
      this.connected = false;
      this.lastError = redactBotSecrets(error, token);
      this.safeLog('error', 'telegram_bot_connect_failed', { error: this.lastError });
      throw new Error(this.lastError || 'Telegram 机器人连接失败');
    }
  }

  async connectStored() {
    return this.connect('');
  }

  clear() {
    this.clearSecret();
    this.secret = null;
    this.connected = false;
    this.lastError = '';
    this.safeLog('info', 'telegram_bot_secret_cleared');
    return this.status();
  }

  async ensureConnected() {
    if (this.connected && this.secret?.token) return this.secret;
    await this.connectStored();
    return this.secret;
  }

  async getUpdates(options = {}) {
    const secret = await this.ensureConnected();
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 100));
    try {
      const updates = await this.request('getUpdates', {
        ...(offset > 0 ? { offset } : {}),
        limit,
        timeout: 0,
        allowed_updates: BOT_UPDATE_TYPES,
      }, secret.token);
      const parsed = parseBotUpdates(updates, {
        accountKey: secret.accountKey,
        previousUpdateId: offset > 0 ? offset - 1 : 0,
      });
      this.lastError = '';
      this.safeLog('info', options.discovery ? 'telegram_bot_groups_discovered' : 'telegram_bot_updates_fetched', {
        accountKey: secret.accountKey,
        offset,
        updateCount: parsed.updateCount,
        groupCount: parsed.groups.length,
        lastUpdateId: parsed.lastUpdateId,
      });
      return {
        ...parsed,
        accountKey: secret.accountKey,
        accountLabel: secret.accountLabel,
      };
    } catch (error) {
      this.lastError = redactBotSecrets(error, secret.token);
      this.safeLog('error', 'telegram_bot_updates_failed', {
        accountKey: secret.accountKey,
        offset,
        error: this.lastError,
      });
      throw new Error(this.lastError || 'Telegram 机器人消息读取失败');
    }
  }
}

module.exports = {
  BOT_UPDATE_TYPES,
  normalizeBotToken,
  redactBotSecrets,
  botAccountKey,
  botAccountLabel,
  parseBotUpdates,
  TelegramBotService,
};
