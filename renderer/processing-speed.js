(function initProcessingSpeed(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProcessingSpeed = api;
})(typeof window !== 'undefined' ? window : globalThis, function createProcessingSpeed() {
  const PROFILES = Object.freeze({
    safe: Object.freeze({
      key: 'safe', label: '稳妥', badge: '1×', initialConcurrency: 1, maxConcurrency: 1,
      requestGapMs: 0, rowDelayMs: 900, timeoutMs: 12000, retries: 0,
      adaptive: false, fullSearch: true,
      description: '当前启动站点单路处理并完整检查全部候选；最不容易触发访问限制。',
    }),
    smart: Object.freeze({
      key: 'smart', label: '智能', badge: '推荐', initialConcurrency: 2, maxConcurrency: 3,
      requestGapMs: 220, rowDelayMs: 250, timeoutMs: 12000, retries: 1,
      adaptive: true, rampAfterSuccesses: 8, fullSearch: true,
      description: '当前启动站点从 2 路开始，稳定后升到 3；限流自动降速并重试一次。',
    }),
    fast: Object.freeze({
      key: 'fast', label: '高速', badge: '约 3–5×', initialConcurrency: 4, maxConcurrency: 4,
      requestGapMs: 80, rowDelayMs: 80, timeoutMs: 10000, retries: 0,
      adaptive: false, fullSearch: true,
      description: '当前启动站点独享 4 路并发并完整检查候选；更容易出现临时限流或网络错误。',
    }),
    quick: Object.freeze({
      key: 'quick', label: '极速 6', badge: '6 路', initialConcurrency: 6, maxConcurrency: 6,
      requestGapMs: 30, rowDelayMs: 0, timeoutMs: 8000, retries: 0,
      adaptive: true, rampAfterSuccesses: 0, fullSearch: false,
      description: '当前启动站点独享 6 路并发，只查主地址；遇到网络错误自动短暂降速。',
    }),
    turbo: Object.freeze({
      key: 'turbo', label: '飞速 8', badge: '8 路', initialConcurrency: 8, maxConcurrency: 8,
      requestGapMs: 15, rowDelayMs: 0, timeoutMs: 8000, retries: 0,
      adaptive: true, rampAfterSuccesses: 0, fullSearch: false,
      description: '当前启动站点独享 8 路主地址简查；适合稳定网络环境。',
    }),
    rocket: Object.freeze({
      key: 'rocket', label: '狂飙 12', badge: '12 路', initialConcurrency: 12, maxConcurrency: 12,
      requestGapMs: 8, rowDelayMs: 0, timeoutMs: 7500, retries: 0,
      adaptive: true, rampAfterSuccesses: 0, fullSearch: false,
      description: '当前启动站点独享 12 路主地址简查；吞吐更高，可能开始受网站或本机性能限制。',
    }),
    extreme: Object.freeze({
      key: 'extreme', label: '极限 16', badge: '16 路', initialConcurrency: 16, maxConcurrency: 16,
      requestGapMs: 0, rowDelayMs: 0, timeoutMs: 7000, retries: 0,
      adaptive: true, rampAfterSuccesses: 0, fullSearch: false,
      description: '当前启动站点独享 16 路主地址简查；用于冲刺测试，收益可能递减且更容易触发限制。',
    }),
  });

  // 123AV 的公开查询端点按时间窗口限速，“并发路数”只适合
  // 用来隐藏单个请求的延迟，不能当作发请求的速率。每个档位因此有
  // 独立的目标 RPS，高档位保留更多 worker，但不再瞬间爆发十几个请求。
  const AV123_RATE_PROFILES = Object.freeze({
    safe: Object.freeze({ requestsPerSecond: 1.0, rateWindowMs: 10000, rateWindowLimit: 10, rateLimitCooldownMs: 10500 }),
    smart: Object.freeze({ requestsPerSecond: 2.4, rateWindowMs: 10000, rateWindowLimit: 24, rateLimitCooldownMs: 10500 }),
    fast: Object.freeze({ requestsPerSecond: 3.2, rateWindowMs: 10000, rateWindowLimit: 32, rateLimitCooldownMs: 10500 }),
    quick: Object.freeze({ requestsPerSecond: 3.5, rateWindowMs: 10000, rateWindowLimit: 35, rateLimitCooldownMs: 10500 }),
    turbo: Object.freeze({ requestsPerSecond: 3.7, rateWindowMs: 10000, rateWindowLimit: 37, rateLimitCooldownMs: 10500 }),
    rocket: Object.freeze({ requestsPerSecond: 3.9, rateWindowMs: 10000, rateWindowLimit: 39, rateLimitCooldownMs: 10500 }),
    extreme: Object.freeze({ requestsPerSecond: 4.1, rateWindowMs: 10000, rateWindowLimit: 41, rateLimitCooldownMs: 10500 }),
  });

  const SITE_RATE_CONTROL = Object.freeze({
    missav: Object.freeze({
      minimum: 1,
      adaptiveMinimum: 2,
      maximum: 32,
      defaultCap: 16,
      defaultLearnedRate: 8,
      firstProbeSuccesses: 20,
      postLimitProbeSuccesses: 56,
      firstProbeStableMs: 3500,
      postLimitProbeStableMs: 9000,
      latencyHighWaterMs: 3500,
      congestionCooldownMs: 2200,
    }),
    av123: Object.freeze({
      minimum: 1,
      adaptiveMinimum: 3,
      maximum: 32,
      defaultCap: 16,
      defaultLearnedRate: 5,
      firstProbeSuccesses: 28,
      postLimitProbeSuccesses: 72,
      firstProbeStableMs: 4000,
      postLimitProbeStableMs: 10000,
      latencyHighWaterMs: 4500,
      congestionCooldownMs: 2800,
    }),
  });
  const MISSAV_RATE_CONTROL = SITE_RATE_CONTROL.missav;
  const AV123_RATE_CONTROL = SITE_RATE_CONTROL.av123;

  function normalizeMode(mode) {
    return Object.prototype.hasOwnProperty.call(PROFILES, mode) ? mode : 'smart';
  }

  function getProfile(mode) {
    return PROFILES[normalizeMode(mode)];
  }

  function getSiteProfile(site, mode) {
    const siteKey = site === 'av123' ? 'av123' : 'missav';
    const profile = getProfile(mode);
    if (siteKey !== 'av123') return profile;
    const rate = AV123_RATE_PROFILES[profile.key];
    return Object.freeze({
      ...profile,
      ...rate,
      retries: 0,
      rowDelayMs: 0,
      requestGapMs: Math.ceil(1000 / rate.requestsPerSecond),
    });
  }

  function selectCandidateUrls(urls, mode) {
    const values = Array.isArray(urls) ? urls.filter(Boolean) : [];
    return getProfile(mode).fullSearch ? values : values.slice(0, 1);
  }

  function select123AvDetailCandidateUrls(urls, mode) {
    const values = Array.isArray(urls) ? [...new Set(urls.filter(Boolean))] : [];
    const profile = getProfile(mode);
    // 完整档检查全部已知详情后缀；6路以上的高速档按真实日志概率只查
    // 基础地址和最常见的两个变体，避免不存在的番号产生七次无效请求。
    return profile.fullSearch ? values : values.slice(0, 3);
  }

  function isBackoffAttempt(attempt) {
    return Boolean(attempt && attempt.status === 'network_error');
  }

  function normalize123AvPolicy(policy) {
    if (policy === 'fixed' || policy === 'balanced') return policy;
    return 'staged';
  }

  function normalizeMissavPolicy(policy) {
    if (policy === 'fixed' || policy === 'balanced') return policy;
    return 'stable';
  }

  function normalize123AvRateMode(mode) {
    return normalizeSiteRateMode('av123', mode);
  }

  function normalize123AvRateCap(value) {
    return normalizeSiteRateCap('av123', value);
  }

  function normalize123AvLearnedRate(value) {
    return normalizeSiteLearnedRate('av123', value);
  }

  function get123AvAdaptiveStartRate(cap, learnedRate) {
    return getSiteAdaptiveStartRate('av123', cap, learnedRate);
  }

  function get123AvProbeStep(rate) {
    return getSiteProbeStep('av123', rate);
  }

  function get123AvRateLimitFallback(rate) {
    return getSiteRateLimitFallback('av123', rate);
  }

  function get123AvSessionCeilingAfterLimit(rate) {
    return getSiteSessionCeilingAfterLimit('av123', rate);
  }

  function normalizeRateSite(site) {
    return site === 'av123' ? 'av123' : 'missav';
  }

  function getSiteRateControl(site) {
    return SITE_RATE_CONTROL[normalizeRateSite(site)];
  }

  function normalizeSiteRateMode(_site, mode) {
    return mode === 'fixed' ? 'fixed' : 'adaptive';
  }

  function normalizeSiteRateCap(site, value) {
    const control = getSiteRateControl(site);
    const hasValue = value !== null && value !== undefined && String(value).trim() !== '';
    const numeric = hasValue ? Number(value) : Number.NaN;
    return Math.max(control.minimum, Math.min(control.maximum,
      Number.isFinite(numeric) ? Math.round(numeric * 10) / 10 : control.defaultCap));
  }

  function normalizeSiteLearnedRate(site, value) {
    const control = getSiteRateControl(site);
    const hasValue = value !== null && value !== undefined && String(value).trim() !== '';
    const numeric = hasValue ? Number(value) : Number.NaN;
    return Math.max(control.minimum, Math.min(control.maximum,
      Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : control.defaultLearnedRate));
  }

  function getSiteAdaptiveStartRate(site, cap, learnedRate) {
    const control = getSiteRateControl(site);
    return Math.min(normalizeSiteRateCap(site, cap), Math.max(control.adaptiveMinimum, normalizeSiteLearnedRate(site, learnedRate)));
  }

  function getSiteProbeStep(site, rate) {
    const control = getSiteRateControl(site);
    const current = Math.max(control.minimum, Number(rate) || control.defaultLearnedRate);
    return Number(Math.max(0.5, Math.min(1.5, current * 0.09)).toFixed(2));
  }

  function getSiteRateLimitFallback(site, rate) {
    const control = getSiteRateControl(site);
    const current = Math.max(control.minimum, Number(rate) || control.defaultLearnedRate);
    return Number(Math.max(control.adaptiveMinimum, current * 0.8).toFixed(2));
  }

  function getSiteCongestionFallback(site, rate) {
    const control = getSiteRateControl(site);
    const current = Math.max(control.minimum, Number(rate) || control.defaultLearnedRate);
    return Number(Math.max(control.adaptiveMinimum, current * 0.82).toFixed(2));
  }

  function getSiteSessionCeilingAfterLimit(site, rate) {
    const control = getSiteRateControl(site);
    const current = Math.max(control.minimum, Number(rate) || control.defaultLearnedRate);
    return Number(Math.max(control.adaptiveMinimum, current * 0.9).toFixed(2));
  }

  function percentile(values, ratio) {
    const sorted = (Array.isArray(values) ? values : [])
      .map(Number).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index];
  }

  function summarizeRateHealth(samples, now = Date.now(), windowMs = 15000) {
    const cutoff = Number(now) - Math.max(1000, Number(windowMs) || 15000);
    const recent = (Array.isArray(samples) ? samples : []).filter(sample => Number(sample?.completedAt || 0) >= cutoff);
    const durations = recent.map(sample => Number(sample?.durationMs || 0)).filter(value => value > 0);
    const errors = recent.filter(sample => sample?.networkError === true).length;
    const firstAt = recent.length ? Number(recent[0].completedAt || now) : Number(now);
    const spanMs = Math.max(1000, Number(now) - firstAt);
    return {
      count: recent.length,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      errorRate: recent.length ? errors / recent.length : 0,
      completionRate: recent.length * 1000 / spanMs,
    };
  }

  function shouldBackoffRateHealth(site, health, timeoutMs) {
    const control = getSiteRateControl(site);
    const count = Math.max(0, Number(health?.count || 0));
    if (count < 10) return false;
    const latencyLimit = Math.min(control.latencyHighWaterMs, Math.max(1800, Number(timeoutMs || 7000) * 0.68));
    return Number(health?.errorRate || 0) >= 0.15
      || Number(health?.p95DurationMs || 0) >= latencyLimit;
  }

  function getStagedConcurrencyLevels(mode) {
    const maximum = getProfile(mode).maxConcurrency;
    if (maximum < 6) return [maximum];
    return [...new Set([
      maximum,
      Math.max(2, Math.ceil(maximum / 2)),
      Math.max(2, Math.ceil(maximum / 4)),
    ])];
  }

  function getRuntimePolicy(site, mode, sitePolicy = '') {
    const siteKey = site === 'av123' ? 'av123' : 'missav';
    const profile = getSiteProfile(siteKey, mode);
    const policy = siteKey === 'av123' ? normalize123AvPolicy(sitePolicy) : normalizeMissavPolicy(sitePolicy);
    const highSpeed123Av = siteKey === 'av123' && profile.maxConcurrency >= 6;
    const highSpeedMissav = siteKey === 'missav' && profile.maxConcurrency >= 6;
    const fixed123Av = highSpeed123Av && policy === 'fixed';
    const balanced123Av = highSpeed123Av && policy === 'balanced';
    const staged123Av = highSpeed123Av && policy === 'staged';
    const fixedMissav = highSpeedMissav && policy === 'fixed';
    const balancedMissav = highSpeedMissav && policy === 'balanced';
    const stagedLevels = staged123Av ? getStagedConcurrencyLevels(mode) : [];
    return {
      site: siteKey,
      policy,
      // 分层模式把限流错误留到本轮结束后再收尾。首轮过程中保持用户
      // 选择的并发，避免同一批仍在途的 429 被重复计数并连续降速。
      adaptive: Boolean(profile.adaptive && !fixed123Av && !staged123Av && !fixedMissav),
      minimumConcurrency: balanced123Av || balancedMissav
        ? Math.max(2, Math.ceil(profile.maxConcurrency / 2))
        : staged123Av ? stagedLevels[stagedLevels.length - 1] : 1,
      pauseRequestsOnPenalty: !(balanced123Av || balancedMissav || fixedMissav),
      stagedLevels,
    };
  }

  return {
    PROFILES,
    AV123_RATE_PROFILES,
    SITE_RATE_CONTROL,
    MISSAV_RATE_CONTROL,
    AV123_RATE_CONTROL,
    normalizeMode,
    getProfile,
    getSiteProfile,
    selectCandidateUrls,
    select123AvDetailCandidateUrls,
    isBackoffAttempt,
    normalize123AvPolicy,
    normalizeMissavPolicy,
    normalizeRateSite,
    getSiteRateControl,
    normalizeSiteRateMode,
    normalizeSiteRateCap,
    normalizeSiteLearnedRate,
    getSiteAdaptiveStartRate,
    getSiteProbeStep,
    getSiteRateLimitFallback,
    getSiteCongestionFallback,
    getSiteSessionCeilingAfterLimit,
    summarizeRateHealth,
    shouldBackoffRateHealth,
    normalize123AvRateMode,
    normalize123AvRateCap,
    normalize123AvLearnedRate,
    get123AvAdaptiveStartRate,
    get123AvProbeStep,
    get123AvRateLimitFallback,
    get123AvSessionCeilingAfterLimit,
    getStagedConcurrencyLevels,
    getRuntimePolicy,
  };
});
