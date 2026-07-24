(function initProcessingEta(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProcessingEta = api;
})(typeof window !== 'undefined' ? window : globalThis, function createProcessingEta() {
  function validDurations(values) {
    return (values || [])
      .map(Number)
      .filter(value => Number.isFinite(value) && value > 0)
      .slice(-20);
  }

  function averageDuration(values) {
    const durations = validDurations(values);
    if (!durations.length) return null;
    return durations.reduce((sum, value) => sum + value, 0) / durations.length;
  }

  function estimateRemainingMs(options = {}) {
    const total = Math.max(0, Number(options.total) || 0);
    const completed = Math.min(total, Math.max(0, Number(options.completed) || 0));
    const remaining = Math.max(0, total - completed);
    if (remaining === 0) return 0;

    const averageMs = averageDuration(options.durations);
    if (!averageMs) return null;

    const currentElapsedMs = Math.max(0, Number(options.currentElapsedMs) || 0);
    const concurrency = Math.max(1, Number(options.concurrency) || 1);
    const parallelEstimate = (averageMs * remaining) / concurrency;
    return parallelEstimate + Math.max(0, currentElapsedMs - averageMs);
  }

  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '计算中…';
    if (value === 0) return '0 秒';

    const seconds = Math.max(1, Math.ceil(value / 1000));
    if (seconds < 60) return `${seconds} 秒`;

    const minutes = Math.floor(seconds / 60);
    const restSeconds = seconds % 60;
    if (minutes < 60) return restSeconds ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分钟`;

    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;

    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
  }

  function formatFinishTime(timestamp, nowTimestamp = Date.now()) {
    const target = new Date(Number(timestamp));
    const now = new Date(Number(nowTimestamp));
    if (!Number.isFinite(target.getTime()) || !Number.isFinite(now.getTime())) return '计算中…';

    const pad = value => String(value).padStart(2, '0');
    const clock = `${pad(target.getHours())}:${pad(target.getMinutes())}`;
    const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayDiff = Math.round((targetDay - today) / 86400000);
    if (dayDiff === 0) return `今天 ${clock}`;
    if (dayDiff === 1) return `明天 ${clock}`;
    return `${pad(target.getMonth() + 1)}-${pad(target.getDate())} ${clock}`;
  }

  return {
    averageDuration,
    estimateRemainingMs,
    formatDuration,
    formatFinishTime,
  };
});
