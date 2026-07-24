function normalizedText(value) {
  return String(value || '').replace(/\r/g, '');
}

function messageText(message = {}) {
  return [
    normalizedText(message.text),
    ...(Array.isArray(message.links) ? message.links.map(normalizedText) : []),
  ].filter(Boolean).join('\n');
}

function parseTelegramDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = String(value || '').trim();
  if (!text) return null;
  const telegram = text.match(
    /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+UTC([+-])(\d{2}):?(\d{2})$/i,
  );
  if (telegram) {
    const [, day, month, year, hour, minute, second = '0', sign, offsetHour, offsetMinute] = telegram;
    const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * (sign === '+' ? 1 : -1);
    const utc = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ) - offset * 60 * 1000;
    const date = new Date(utc);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeDate(value) {
  const date = parseTelegramDate(value);
  return date ? date.toISOString() : '';
}

function localMinuteBoundary(value, end = false) {
  const text = String(value || '').trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  if (end && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) {
    date.setSeconds(59, 999);
  }
  return date;
}

function filterMessagesByTime(messages, range = {}) {
  const start = localMinuteBoundary(range.start);
  const end = localMinuteBoundary(range.end, true);
  return (messages || []).filter(message => {
    const rawDate = message?.messageDate || message?.date || '';
    const date = parseTelegramDate(rawDate);
    if (!date) {
      const telegramSource = /^(?:export_|api|bot_|telegram)/i.test(String(message?.sourceType || ''));
      return !(telegramSource && (start || end));
    }
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  });
}

function messageTimeExtent(messages) {
  const dates = (messages || [])
    .map(message => parseTelegramDate(message?.messageDate || message?.date))
    .filter(Boolean)
    .sort((left, right) => left - right);
  return {
    start: dates[0]?.toISOString() || '',
    end: dates.at(-1)?.toISOString() || '',
    dated: dates.length,
    total: Array.isArray(messages) ? messages.length : 0,
  };
}

module.exports = {
  normalizedText,
  messageText,
  parseTelegramDate,
  normalizeDate,
  filterMessagesByTime,
  messageTimeExtent,
};
