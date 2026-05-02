import path from "node:path";
import { z } from "zod";

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
});

export type PebbleConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PebbleConfig {
  const vaultPath = env.PEBBLE_VAULT_PATH ?? "";
  const defaultDb = vaultPath
    ? path.join(vaultPath, "_System", "pebble.sqlite")
    : "";
  return ConfigSchema.parse({
    vaultPath,
    dbPath: env.PEBBLE_DB_PATH || defaultDb,
    ingestSecret: env.PEBBLE_INGEST_SECRET ?? "",
    host: env.PEBBLE_HOST ?? "127.0.0.1",
    port: env.PEBBLE_PORT ?? "8787",
    triageProvider: env.PEBBLE_TRIAGE_PROVIDER ?? "mock",
    appendOnly: (env.PEBBLE_APPEND_ONLY ?? "true") as "true" | "false",
    telemetry: env.PEBBLE_TELEMETRY ?? "off",
  });
}
