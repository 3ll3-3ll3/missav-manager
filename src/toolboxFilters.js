// Compatibility facade. Tool implementations live in src/tools so future
// filters can be added without growing a shared catch-all module.
const common = require('./tools/common');
const twitter = require('./tools/twitter');
const badnews = require('./tools/badnews');

module.exports = {
  TWITTER_RESERVED_PATHS: twitter.TWITTER_RESERVED_PATHS,
  parseTelegramDate: common.parseTelegramDate,
  normalizeDate: common.normalizeDate,
  filterMessagesByTime: common.filterMessagesByTime,
  messageTimeExtent: common.messageTimeExtent,
  validTwitterHandle: twitter.validTwitterHandle,
  extractTwitterProfiles: twitter.extractTwitterProfiles,
  canonicalBadNewsUrl: badnews.canonicalBadNewsUrl,
  extractBadNewsLinks: badnews.extractBadNewsLinks,
};
