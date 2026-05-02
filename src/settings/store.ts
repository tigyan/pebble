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

export const EditableSettingsSchema = z
  .object({
    triage_provider: TriageProviderNameSchema.optional(),
    default_folders: z.record(NoteTypeSchema, z.string().min(1)).optional(),
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
  return EditableSettingsSchema.parse(out);
}
