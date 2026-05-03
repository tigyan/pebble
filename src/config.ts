import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { buildSecretSource, type SecretSource } from "./secrets/source.js";

// why: shells expand `~` before exec; .env / process.env never do — Node
// would treat "~/Obsidian/Vault" as a *relative* path and create a
// literal "~" directory next to the cwd. Resolve it explicitly.
function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const ConfigSchema = z.object({
  vaultPath: z.string().min(1, "PEBBLE_VAULT_PATH is required"),
  dbPath: z.string().min(1),
  ingestSecret: z.string().min(8, "PEBBLE_INGEST_SECRET must be >= 8 chars"),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().nonnegative().max(65535).default(8787),
  triageProvider: z
    .enum(["mock", "anthropic", "openai", "claude-code", "codex"])
    .default("mock"),
  appendOnly: z
    .union([z.literal("true"), z.literal("false")])
    .default("true")
    .transform((v) => v === "true"),
  telemetry: z.enum(["off", "on"]).default("off"),
  secretsSource: z.enum(["env", "keychain", "auto"]).default("env"),
  /**
   * BlueBubbles Server URL — used to fetch attachment binaries that arrive
   * via webhook by reference only. Password is resolved separately via
   * `SecretSource.get("PEBBLE_BLUEBUBBLES_PASSWORD")` so it never enters
   * the parsed config object (and thus never gets logged).
   */
  bluebubblesUrl: z.string().url().or(z.literal("")).default(""),
});

export type PebbleConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  secrets: SecretSource = buildSecretSource(env),
): PebbleConfig {
  const vaultPath = expandHome(env.PEBBLE_VAULT_PATH ?? "");
  const explicitDb = expandHome(env.PEBBLE_DB_PATH ?? "");
  const defaultDb = vaultPath
    ? path.join(vaultPath, "_System", "pebble.sqlite")
    : "";
  return ConfigSchema.parse({
    vaultPath,
    dbPath: explicitDb || defaultDb,
    // ingestSecret is the one core secret resolved via SecretSource so
    // users on PEBBLE_SECRETS_SOURCE=auto get keychain-first lookup.
    // API keys (Anthropic/OpenAI) are read via the same source where they
    // are consumed (see triage/api-provider).
    ingestSecret: secrets.get("PEBBLE_INGEST_SECRET") ?? "",
    host: env.PEBBLE_HOST ?? "127.0.0.1",
    port: env.PEBBLE_PORT ?? "8787",
    triageProvider: env.PEBBLE_TRIAGE_PROVIDER ?? "mock",
    appendOnly: (env.PEBBLE_APPEND_ONLY ?? "true") as "true" | "false",
    telemetry: env.PEBBLE_TELEMETRY ?? "off",
    secretsSource: (env.PEBBLE_SECRETS_SOURCE ?? "env").toLowerCase(),
    bluebubblesUrl: env.PEBBLE_BLUEBUBBLES_URL ?? "",
  });
}
