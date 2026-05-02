import type { PebbleDB } from "../db/client.js";

export interface BudgetUsage {
  day: string;
  model: string;
  calls_used: number;
  calls_limit: number; // 0 = unlimited
  remaining: number; // Infinity when unlimited
  tokens_used: number;
}

export interface BudgetTrackerOpts {
  db: PebbleDB;
  /** Pluggable for tests. */
  now?: () => Date;
}

/**
 * Persistent daily counter, keyed by (UTC day, model name). Survives restarts.
 * `dailyLimit === 0` means unlimited.
 */
export class BudgetTracker {
  constructor(private opts: BudgetTrackerOpts) {}

  private day(): string {
    const d = (this.opts.now ?? (() => new Date()))();
    return d.toISOString().slice(0, 10);
  }

  usage(model: string, dailyLimit: number): BudgetUsage {
    const day = this.day();
    const { calls, tokens } = this.opts.db.getBudgetUsage(day, model);
    return {
      day,
      model,
      calls_used: calls,
      calls_limit: dailyLimit,
      remaining: dailyLimit > 0 ? Math.max(0, dailyLimit - calls) : Infinity,
      tokens_used: tokens,
    };
  }

  /** Throws `BudgetExhausted` when `dailyLimit > 0 && calls_used >= dailyLimit`. */
  ensureAvailable(model: string, dailyLimit: number): void {
    if (dailyLimit <= 0) return;
    const u = this.usage(model, dailyLimit);
    if (u.calls_used >= dailyLimit) {
      throw new BudgetExhausted(model, u);
    }
  }

  charge(model: string, calls: number, tokens = 0): void {
    if (calls <= 0 && tokens <= 0) return;
    this.opts.db.incrementBudget({ day: this.day(), model, calls, tokens });
  }
}

export class BudgetExhausted extends Error {
  readonly usage: BudgetUsage;
  constructor(model: string, usage: BudgetUsage) {
    super(`daily budget exhausted for model ${model}: ${usage.calls_used}/${usage.calls_limit}`);
    this.name = "BudgetExhausted";
    this.usage = usage;
  }
}

// --- Token-bucket rate limiter ------------------------------------------

export interface RateLimiterOpts {
  /** Refill rate (calls per minute). 0 = unlimited / no-op. */
  ratePerMinute: number;
  /** Max burst (bucket capacity). Defaults to `ratePerMinute`. */
  burst?: number;
  now?: () => number;
  /** Sleep callback (ms). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Classic token-bucket. `acquire()` returns when at least one token is
 * available; under contention it waits `Math.ceil(60_000 / ratePerMinute)` ms
 * per missing token. `tryAcquire()` is non-blocking.
 */
export class RateLimiter {
  private tokens: number;
  private capacity: number;
  private last: number;
  private rate: number; // tokens per ms

  constructor(private opts: RateLimiterOpts) {
    const burst = Math.max(1, opts.burst ?? opts.ratePerMinute ?? 1);
    this.capacity = burst;
    this.tokens = burst;
    this.rate = (opts.ratePerMinute || 0) / 60_000;
    this.last = (opts.now ?? Date.now)();
  }

  private refill(): void {
    if (this.rate <= 0) return;
    const now = (this.opts.now ?? Date.now)();
    const elapsed = Math.max(0, now - this.last);
    if (elapsed === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.last = now;
  }

  tryAcquire(): boolean {
    if (this.opts.ratePerMinute <= 0) return true;
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async acquire(): Promise<void> {
    if (this.opts.ratePerMinute <= 0) return;
    while (!this.tryAcquire()) {
      const waitMs = Math.ceil((1 - this.tokens) / this.rate);
      const sleep = this.opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
      await sleep(Math.max(1, waitMs));
    }
  }

  /** Test helper. */
  available(): number {
    this.refill();
    return this.tokens;
  }
}
