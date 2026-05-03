import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { NoteTypeSchema } from "../types/index.js";
import { VAULT_DIRS } from "../vault/paths.js";

export const TRIAGE_PROVIDERS = [
  "mock",
  "anthropic",
  "openai",
  "claude-code",
  "codex",
] as const;
export const TriageProviderNameSchema = z.enum(TRIAGE_PROVIDERS);
export type TriageProviderName = z.infer<typeof TriageProviderNameSchema>;

export const WorkerSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    interval_ms: z.number().int().min(1000).max(24 * 60 * 60 * 1000).default(60_000),
    auto_file: z.boolean().default(false),
    batch: z.number().int().min(1).max(100).default(5),
  })
  .strict();
export type WorkerSettings = z.infer<typeof WorkerSettingsSchema>;

export const DEFAULT_WORKER_SETTINGS: WorkerSettings = WorkerSettingsSchema.parse({});

export const AgentSettingsSchema = z
  .object({
    /** Daily call cap per model. 0 = unlimited. */
    daily_call_budget: z.number().int().min(0).max(1_000_000).default(0),
    /** Token-bucket refill rate (calls / minute). 0 = unlimited. */
    rate_limit_per_min: z.number().int().min(0).max(10_000).default(0),
    /** Max requests fired in a single burst. Defaults to rate_limit_per_min when set. */
    burst: z.number().int().min(1).max(10_000).default(5),
    /** Optional override of the model name used for budget bookkeeping. */
    triage_model: z.string().min(1).optional(),
  })
  .strict();
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
export const DEFAULT_AGENT_SETTINGS: AgentSettings = AgentSettingsSchema.parse({});

export const INGEST_FILTER_MODES = ["off", "allowlist", "denylist"] as const;
export const IngestFilterModeSchema = z.enum(INGEST_FILTER_MODES);
export type IngestFilterMode = z.infer<typeof IngestFilterModeSchema>;

export const IngestFilterSettingsSchema = z
  .object({
    mode: IngestFilterModeSchema.default("off"),
    /** Sender identifiers (handle / email / phone) — exact match against IngestPayload.sender. */
    senders: z.array(z.string().min(1)).default([]),
    /** Thread IDs (e.g. BlueBubbles chat guid) — exact match against IngestPayload.thread_id. */
    threads: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type IngestFilterSettings = z.infer<typeof IngestFilterSettingsSchema>;
export const DEFAULT_INGEST_FILTER: IngestFilterSettings = IngestFilterSettingsSchema.parse({});

export const EditableSettingsSchema = z
  .object({
    triage_provider: TriageProviderNameSchema.optional(),
    default_folders: z.record(NoteTypeSchema, z.string().min(1)).optional(),
    worker: WorkerSettingsSchema.partial().optional(),
    agent: AgentSettingsSchema.partial().optional(),
    ingest_filter: IngestFilterSettingsSchema.partial().optional(),
  })
  .strict();
export type EditableSettings = z.infer<typeof EditableSettingsSchema>;

export interface SettingsStore {
  /** Current settings, parsed and validated. Empty object if file missing. */
  get(): EditableSettings;
  /** Merge `patch` into current settings, persist atomically, return result. */
  set(patch: EditableSettings): Promise<EditableSettings>;
}

export function settingsFilePath(vaultPath: string): string {
  return path.join(vaultPath, VAULT_DIRS.system, "settings.json");
}

export async function makeSettingsStore(vaultPath: string): Promise<SettingsStore> {
  const file = settingsFilePath(vaultPath);
  let cached: EditableSettings = await readFile(file);

  return {
    get: () => cached,
    async set(patch) {
      const merged = mergeSettings(cached, patch);
      await writeAtomic(file, merged);
      cached = merged;
      return cached;
    },
  };
}

async function readFile(file: string): Promise<EditableSettings> {
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!raw.trim()) return {};
    return EditableSettingsSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeAtomic(file: string, value: EditableSettings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

function mergeSettings(base: EditableSettings, patch: EditableSettings): EditableSettings {
  const out: EditableSettings = { ...base };
  if (patch.triage_provider !== undefined) out.triage_provider = patch.triage_provider;
  if (patch.default_folders !== undefined) {
    out.default_folders = { ...(base.default_folders ?? {}), ...patch.default_folders };
  }
  if (patch.worker !== undefined) {
    out.worker = { ...(base.worker ?? {}), ...patch.worker };
  }
  if (patch.agent !== undefined) {
    out.agent = { ...(base.agent ?? {}), ...patch.agent };
  }
  if (patch.ingest_filter !== undefined) {
    out.ingest_filter = { ...(base.ingest_filter ?? {}), ...patch.ingest_filter };
  }
  return EditableSettingsSchema.parse(out);
}

/** Worker config with all defaults filled in. Convenience for callers. */
export function effectiveWorkerSettings(s: EditableSettings): WorkerSettings {
  const out: WorkerSettings = { ...DEFAULT_WORKER_SETTINGS };
  const patch = s.worker ?? {};
  if (patch.enabled !== undefined) out.enabled = patch.enabled;
  if (patch.interval_ms !== undefined) out.interval_ms = patch.interval_ms;
  if (patch.auto_file !== undefined) out.auto_file = patch.auto_file;
  if (patch.batch !== undefined) out.batch = patch.batch;
  return out;
}

/** Agent config with all defaults filled in. */
export function effectiveAgentSettings(s: EditableSettings): AgentSettings {
  const out: AgentSettings = { ...DEFAULT_AGENT_SETTINGS };
  const patch = s.agent ?? {};
  if (patch.daily_call_budget !== undefined) out.daily_call_budget = patch.daily_call_budget;
  if (patch.rate_limit_per_min !== undefined) out.rate_limit_per_min = patch.rate_limit_per_min;
  if (patch.burst !== undefined) out.burst = patch.burst;
  if (patch.triage_model !== undefined) out.triage_model = patch.triage_model;
  return out;
}

/** Ingest-filter config with all defaults filled in. */
export function effectiveIngestFilter(s: EditableSettings): IngestFilterSettings {
  const out: IngestFilterSettings = {
    mode: DEFAULT_INGEST_FILTER.mode,
    senders: [...DEFAULT_INGEST_FILTER.senders],
    threads: [...DEFAULT_INGEST_FILTER.threads],
  };
  const patch = s.ingest_filter ?? {};
  if (patch.mode !== undefined) out.mode = patch.mode;
  if (patch.senders !== undefined) out.senders = patch.senders;
  if (patch.threads !== undefined) out.threads = patch.threads;
  return out;
}

export type IngestFilterDecision =
  | { allow: true }
  | { allow: false; reason: "denylist" | "not_in_allowlist" };

/**
 * Evaluate whether an `(sender, thread_id)` pair should be ingested under the
 * current filter settings. Pure function; safe to call from server, worker,
 * tests.
 */
export function evaluateIngestFilter(
  filter: IngestFilterSettings,
  sender: string,
  threadId: string,
): IngestFilterDecision {
  if (filter.mode === "off") return { allow: true };
  const matches =
    filter.senders.includes(sender) || filter.threads.includes(threadId);
  if (filter.mode === "allowlist") {
    return matches ? { allow: true } : { allow: false, reason: "not_in_allowlist" };
  }
  // denylist
  return matches ? { allow: false, reason: "denylist" } : { allow: true };
}
