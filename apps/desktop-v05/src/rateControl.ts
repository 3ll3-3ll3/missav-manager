export type QuerySite = "missav" | "av123";

export interface RateSnapshot {
  targetRps: number;
  currentRps: number;
  cooldownMs: number;
  rateLimitEvents: number;
  congestionEvents: number;
  lastSignal: string;
  blocked: boolean;
}

interface RateSample {
  at: number;
  durationMs: number;
  failed: boolean;
  statusCode: number;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

export class AdaptiveRateGate {
  private readonly site: QuerySite;
  private readonly targetRps: number;
  private currentRps: number;
  private learnedRps: number;
  private nextRequestAt = 0;
  private pauseUntil = 0;
  private congestionOpenUntil = 0;
  private circuitOpenUntil = 0;
  private lastRateChangeAt = Date.now();
  private successesAtLevel = 0;
  private samples: RateSample[] = [];
  private gate: Promise<void> = Promise.resolve();
  private rateLimitEvents = 0;
  private congestionEvents = 0;
  private lastSignal = "";
  private blocked = false;

  constructor(site: QuerySite, targetRps: number, learnedRps?: number) {
    this.site = site;
    this.targetRps = clamp(Number(targetRps) || 1, 0.2, site === "missav" ? 50 : 30);
    const defaultLearned = site === "missav" ? 8 : 4;
    this.currentRps = Math.min(this.targetRps, clamp(Number(learnedRps) || defaultLearned, 1, this.targetRps));
    this.learnedRps = this.currentRps;
  }

  async acquire(shouldStop?: () => boolean) {
    let release = () => {};
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.gate;
    this.gate = previous.then(() => turn);
    await previous;
    try {
      while (true) {
        if (shouldStop?.()) return false;
        const now = Date.now();
        const waitMs = Math.max(0, this.nextRequestAt - now, this.pauseUntil - now, this.circuitOpenUntil - now);
        if (!waitMs) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 250)));
      }
      if (shouldStop?.()) return false;
      const now = Date.now();
      this.nextRequestAt = Math.max(this.nextRequestAt, now) + Math.ceil(1000 / Math.max(0.2, this.currentRps));
      return true;
    } finally {
      release();
    }
  }

  record(statusCode: number, durationMs: number, error = "") {
    const now = Date.now();
    const text = error.toLowerCase();
    const rateLimited = statusCode === 429 || /too many requests|请求过于频繁/.test(text);
    const congested = statusCode === 403 || statusCode === 408 || statusCode >= 500
      || /timeout|timed out|超时|econnreset|connection reset|cloudflare|challenge|captcha|验证/.test(text);
    const failed = rateLimited || congested || statusCode === 0;
    this.samples.push({ at: now, durationMs: Math.max(0, durationMs), failed, statusCode });
    this.samples = this.samples.filter((sample) => sample.at >= now - 15_000).slice(-100);
    const lastTen = this.samples.slice(-10);
    if (lastTen.length >= 8 && lastTen.filter((sample) => sample.statusCode === 403).length >= 8) {
      this.blocked = true;
      this.pauseUntil = Math.max(this.pauseUntil, now + 5 * 60_000);
      this.lastSignal = "Cloudflare 持续验证";
      return;
    }

    if (rateLimited) {
      if (now >= this.circuitOpenUntil) {
        const cooldown = this.site === "av123" ? 10_500 : 8_000;
        this.currentRps = Math.max(this.site === "av123" ? 1 : 1.5, Number((this.currentRps * 0.8).toFixed(2)));
        this.learnedRps = Math.min(this.learnedRps, this.currentRps);
        this.circuitOpenUntil = now + cooldown;
        this.pauseUntil = Math.max(this.pauseUntil, this.circuitOpenUntil);
        this.rateLimitEvents += 1;
        this.lastSignal = `HTTP ${statusCode || 429} 限流`;
        this.resetLevel(now);
      }
      return;
    }

    const errorRate = this.samples.length
      ? this.samples.filter((sample) => sample.failed).length / this.samples.length
      : 0;
    const healthBackoff = this.samples.length >= 10 && errorRate >= 0.15;
    if ((congested || healthBackoff) && now >= this.congestionOpenUntil) {
      const cooldown = this.site === "missav" ? 2_500 : 2_800;
      this.currentRps = Math.max(this.site === "missav" ? 1.5 : 1, Number((this.currentRps * 0.82).toFixed(2)));
      this.learnedRps = Math.min(this.learnedRps, this.currentRps);
      this.congestionOpenUntil = now + cooldown;
      this.pauseUntil = Math.max(this.pauseUntil, this.congestionOpenUntil);
      this.congestionEvents += 1;
      this.lastSignal = statusCode === 403 ? "HTTP 403 防护" : "网络拥塞";
      this.resetLevel(now);
      return;
    }

    if (!failed) {
      this.successesAtLevel += 1;
      const required = this.rateLimitEvents || this.congestionEvents ? 56 : 20;
      const stableMs = this.rateLimitEvents || this.congestionEvents ? 9_000 : 3_500;
      if (this.successesAtLevel >= required && now - this.lastRateChangeAt >= stableMs && this.currentRps < this.targetRps) {
        const step = clamp(this.currentRps * 0.09, 0.5, 1.5);
        this.learnedRps = this.currentRps;
        this.currentRps = Math.min(this.targetRps, Number((this.currentRps + step).toFixed(2)));
        this.lastSignal = "稳定后逐步提速";
        this.resetLevel(now);
      }
    }
  }

  private resetLevel(now: number) {
    this.successesAtLevel = 0;
    this.lastRateChangeAt = now;
  }

  snapshot(): RateSnapshot {
    const now = Date.now();
    return {
      targetRps: this.targetRps,
      currentRps: this.currentRps,
      cooldownMs: Math.max(0, this.pauseUntil - now, this.circuitOpenUntil - now),
      rateLimitEvents: this.rateLimitEvents,
      congestionEvents: this.congestionEvents,
      lastSignal: this.lastSignal,
      blocked: this.blocked,
    };
  }

  learnedRate() {
    return Math.min(this.targetRps, Math.max(1, this.learnedRps));
  }
}
