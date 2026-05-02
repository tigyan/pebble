import { BudgetExhausted, BudgetTracker, RateLimiter } from "../agent/budget.js";
import type { PebbleConfig } from "../config.js";
import type { PebbleDB } from "../db/client.js";
import { fileOne } from "../filing/executor.js";
import {
  effectiveAgentSettings,
  effectiveWorkerSettings,
  type SettingsStore,
  type WorkerSettings,
} from "../settings/store.js";
import { getProvider } from "../triage/classifier.js";

export interface WorkerStatus {
  running: boolean;
  enabled: boolean;
  interval_ms: number;
  auto_file: boolean;
  batch: number;
  last_tick_at: string | null;
  last_error: string | null;
  triaged_total: number;
  filed_total: number;
  ticks_total: number;
}

export interface WorkerHandle {
  status(): WorkerStatus;
  /** Re-read settings; (re)start or stop the timer if `enabled` flipped or interval changed. */
  reconfigure(): void;
  /** Stop the worker. Idempotent. */
  stop(): void;
  /** Run one pass synchronously (used by /api/worker/run and tests). */
  runOnce(): Promise<{ triaged: number; filed: number }>;
}

export interface WorkerDeps {
  config: PebbleConfig;
  db: PebbleDB;
  settings: SettingsStore;
  /** Pluggable for tests. */
  now?: () => Date;
  /** Pluggable for tests — defaults to setTimeout-based interval. */
  scheduler?: WorkerScheduler;
  /** Logger callback for surfacing errors without coupling to fastify. */
  onError?: (err: unknown) => void;
}

export interface WorkerScheduler {
  start(intervalMs: number, fn: () => void): void;
  stop(): void;
}

export function startWorker(deps: WorkerDeps): WorkerHandle {
  const now = deps.now ?? (() => new Date());
  const scheduler = deps.scheduler ?? defaultScheduler();

  let current: WorkerSettings = effectiveWorkerSettings(deps.settings.get());
  let timerInterval: number | null = null;
  let inFlight = false;
  let lastTickAt: string | null = null;
  let lastError: string | null = null;
  let triagedTotal = 0;
  let filedTotal = 0;
  let ticksTotal = 0;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) return;
    inFlight = true;
    try {
      ticksTotal += 1;
      lastTickAt = now().toISOString();
      const { triaged, filed } = await runOncePass();
      triagedTotal += triaged;
      filedTotal += filed;
      lastError = null;
    } catch (err) {
      lastError = (err as Error).message;
      deps.onError?.(err);
    } finally {
      inFlight = false;
    }
  };

  const runOncePass = async (): Promise<{ triaged: number; filed: number }> => {
    const settings = deps.settings.get();
    const cfg = effectiveWorkerSettings(settings);
    const agentCfg = effectiveAgentSettings(settings);
    current = cfg;

    const providerName = settings.triage_provider ?? deps.config.triageProvider;
    const provider = getProvider(providerName);
    const modelName = agentCfg.triage_model ?? providerName;
    const budget = new BudgetTracker({ db: deps.db });
    const limiter = new RateLimiter({
      ratePerMinute: agentCfg.rate_limit_per_min,
      burst: agentCfg.burst,
    });
    const recent = deps.db.listRecentIngestions(Math.max(cfg.batch * 4, 25));
    const raw = recent.filter((r) => r.status === "raw").reverse().slice(0, cfg.batch);

    let triaged = 0;
    let filed = 0;
    const defaults = settings.default_folders ?? {};

    for (const rec of raw) {
      try {
        budget.ensureAvailable(modelName, agentCfg.daily_call_budget);
      } catch (err) {
        if (err instanceof BudgetExhausted) break;
        throw err;
      }
      await limiter.acquire();
      const result = await provider.classify(rec);
      deps.db.setTriage(rec.id, result, "triaged");
      budget.charge(modelName, 1);
      triaged += 1;

      if (cfg.auto_file) {
        const folder = defaults[result.type] ?? result.suggested_folder;
        const effective = { ...result, suggested_folder: folder };
        await fileOne({
          vaultPath: deps.config.vaultPath,
          db: deps.db,
          record: rec,
          triage: effective,
        });
        filed += 1;
      }
    }
    return { triaged, filed };
  };

  const applyEnabled = (): void => {
    if (stopped) return;
    if (current.enabled && timerInterval !== current.interval_ms) {
      scheduler.stop();
      scheduler.start(current.interval_ms, () => {
        // fire-and-forget; errors are captured inside tick()
        void tick();
      });
      timerInterval = current.interval_ms;
    } else if (!current.enabled && timerInterval !== null) {
      scheduler.stop();
      timerInterval = null;
    }
  };

  applyEnabled();

  return {
    status: () => ({
      running: timerInterval !== null,
      enabled: current.enabled,
      interval_ms: current.interval_ms,
      auto_file: current.auto_file,
      batch: current.batch,
      last_tick_at: lastTickAt,
      last_error: lastError,
      triaged_total: triagedTotal,
      filed_total: filedTotal,
      ticks_total: ticksTotal,
    }),
    reconfigure() {
      if (stopped) return;
      current = effectiveWorkerSettings(deps.settings.get());
      applyEnabled();
    },
    stop() {
      stopped = true;
      scheduler.stop();
      timerInterval = null;
    },
    runOnce: async () => {
      // Bypass the gating; explicit one-shot.
      lastTickAt = now().toISOString();
      ticksTotal += 1;
      try {
        const out = await runOncePass();
        triagedTotal += out.triaged;
        filedTotal += out.filed;
        lastError = null;
        return out;
      } catch (err) {
        lastError = (err as Error).message;
        throw err;
      }
    },
  };
}

function defaultScheduler(): WorkerScheduler {
  let timer: NodeJS.Timeout | null = null;
  return {
    start(intervalMs, fn) {
      if (timer) clearInterval(timer);
      timer = setInterval(fn, intervalMs);
      // Don't keep the event loop alive solely for the worker.
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
