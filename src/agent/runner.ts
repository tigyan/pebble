import type { PebbleConfig } from "../config.js";
import type { PebbleDB } from "../db/client.js";
import { fileOne } from "../filing/executor.js";
import {
  effectiveAgentSettings,
  type AgentSettings,
  type SettingsStore,
} from "../settings/store.js";
import { getProvider } from "../triage/classifier.js";
import { BudgetExhausted, BudgetTracker, RateLimiter } from "./budget.js";

export interface AgentRunOpts {
  config: PebbleConfig;
  db: PebbleDB;
  settings: SettingsStore;
  /** Triage at most this many raw items in one run. Default 1. */
  limit?: number;
  /** When true, also file each triaged item into its typed home. */
  autoFile?: boolean;
  /** Honor settings.agent.daily_call_budget. Default true. */
  enforceBudget?: boolean;
  budget?: BudgetTracker;
  limiter?: RateLimiter;
}

export interface AgentRunResult {
  triaged: number;
  filed: number;
  skipped_budget: number;
  /** Final budget usage snapshot for the model that ran. */
  usage: ReturnType<BudgetTracker["usage"]> | null;
}

/**
 * One-shot agent run: take the next N raw ingestions, classify them with
 * the configured triage provider, optionally file the result. Charges the
 * budget for each successful classification and respects the rate limiter.
 */
export async function runAgentOnce(opts: AgentRunOpts): Promise<AgentRunResult> {
  const settings = opts.settings.get();
  const agentCfg = effectiveAgentSettings(settings);
  const limit = Math.max(1, opts.limit ?? 1);
  const enforceBudget = opts.enforceBudget !== false;

  const providerName = settings.triage_provider ?? opts.config.triageProvider;
  const provider = getProvider(providerName);
  const modelName = agentCfg.triage_model ?? providerName;

  const budget = opts.budget ?? new BudgetTracker({ db: opts.db });
  const limiter =
    opts.limiter ??
    new RateLimiter({
      ratePerMinute: agentCfg.rate_limit_per_min,
      burst: agentCfg.burst,
    });

  const recent = opts.db.listRecentIngestions(Math.max(limit * 4, 25));
  const raw = recent.filter((r) => r.status === "raw").reverse().slice(0, limit);

  let triaged = 0;
  let filed = 0;
  let skipped_budget = 0;

  for (const rec of raw) {
    if (enforceBudget) {
      try {
        budget.ensureAvailable(modelName, agentCfg.daily_call_budget);
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          skipped_budget++;
          break;
        }
        throw err;
      }
    }
    await limiter.acquire();

    const result = await provider.classify(rec);
    opts.db.setTriage(rec.id, result, "triaged");
    if (enforceBudget) budget.charge(modelName, 1);
    triaged++;

    if (opts.autoFile) {
      const defaults = settings.default_folders ?? {};
      const folder = defaults[result.type] ?? result.suggested_folder;
      await fileOne({
        vaultPath: opts.config.vaultPath,
        db: opts.db,
        record: rec,
        triage: { ...result, suggested_folder: folder },
      });
      filed++;
    }
  }

  return {
    triaged,
    filed,
    skipped_budget,
    usage: budget.usage(modelName, agentCfg.daily_call_budget),
  };
}

/** Public read-only snapshot of agent state for /api/agent. */
export function agentStatus(opts: {
  db: PebbleDB;
  settings: SettingsStore;
  config: PebbleConfig;
}): {
  model: string;
  agent: AgentSettings;
  usage: ReturnType<BudgetTracker["usage"]>;
} {
  const settings = opts.settings.get();
  const agentCfg = effectiveAgentSettings(settings);
  const providerName = settings.triage_provider ?? opts.config.triageProvider;
  const modelName = agentCfg.triage_model ?? providerName;
  const usage = new BudgetTracker({ db: opts.db }).usage(
    modelName,
    agentCfg.daily_call_budget,
  );
  return { model: modelName, agent: agentCfg, usage };
}
