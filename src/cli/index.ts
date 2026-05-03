#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.js";
import { openDB } from "../db/client.js";
import { currentSchemaVersion } from "../db/migrations.js";
import { embedAllNotes } from "../embeddings/runner.js";
import { getEmbeddingProvider } from "../embeddings/provider.js";
import { indexVault } from "../indexer/index.js";
import { ingest } from "../ingest/pipeline.js";
import { runTriage } from "../triage/runner.js";
import { fileAllTriaged } from "../filing/executor.js";
import { manualAdapter } from "../adapters/manual.js";
import { pingBluebubbles } from "../adapters/bluebubbles-fetch.js";
import {
  detectKeychainBackend,
  KEYCHAIN_SERVICE,
} from "../secrets/keychain.js";
import { buildSecretSource } from "../secrets/source.js";
import { buildServer } from "../server/server.js";
import { IngestPayloadSchema } from "../types/index.js";
import { makeAgentTools } from "../agent/tools.js";
import { VAULT_DIRS } from "../vault/paths.js";

const program = new Command();
program
  .name("pebble")
  .description("iMessage → Obsidian AI Vault Aggregator")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize the vault layout and SQLite DB")
  .option("--vault <path>", "Override PEBBLE_VAULT_PATH")
  .action(async (opts) => {
    if (opts.vault) process.env.PEBBLE_VAULT_PATH = opts.vault;
    const cfg = loadConfig();
    for (const d of Object.values(VAULT_DIRS)) {
      await fs.mkdir(path.join(cfg.vaultPath, d), { recursive: true });
    }
    const db = openDB(cfg.dbPath);
    db.close();
    log(`vault initialized at ${cfg.vaultPath}`);
    log(`db:    ${cfg.dbPath}`);
  });

program
  .command("ingest")
  .description("Ingest a single message from the CLI (no webhook needed)")
  .requiredOption("--text <text>", "Message body")
  .option("--sender <sender>", "Sender", "self")
  .option("--thread <thread>", "Thread id", "manual")
  .option("--source <source>", "imessage|sms|shortcut|manual", "manual")
  .action(async (opts) => {
    const cfg = loadConfig();
    const db = openDB(cfg.dbPath);
    try {
      const payload = IngestPayloadSchema.parse(
        manualAdapter.normalize({
          source: opts.source,
          sender: opts.sender,
          thread_id: opts.thread,
          text: opts.text,
          timestamp: new Date().toISOString(),
        }),
      );
      const { record, duplicate, near_duplicate } = await ingest(payload, {
        vaultPath: cfg.vaultPath,
        appendOnly: cfg.appendOnly,
        db,
      });
      log(`ingested ${record.id}`);
      log(`  inbox:  ${record.inbox_path}`);
      log(`  thread: ${record.thread_path}`);
      log(`  person: ${record.person_path}`);
      if (duplicate) log(`  ⚠ exact duplicate of ${duplicate.id}`);
      else if (near_duplicate)
        log(`  ⚠ near-duplicate of ${near_duplicate.id} (jaccard ${near_duplicate.score.toFixed(2)})`);
    } finally {
      db.close();
    }
  });

program
  .command("triage")
  .description("Classify recent raw ingestions into structured triage results")
  .option("--limit <n>", "Max items to triage", "10")
  .option("--file", "Also file each triaged item into its suggested folder")
  .action(async (opts) => {
    const cfg = loadConfig();
    const db = openDB(cfg.dbPath);
    try {
      const out = await runTriage({
        db,
        provider: cfg.triageProvider,
        limit: Number(opts.limit) || 10,
      });
      log(`triaged ${out.length} items via ${cfg.triageProvider}`);
      for (const r of out) {
        log(`  ${r.id} → ${r.triage.type} (${r.triage.urgency}) → ${r.triage.suggested_folder}`);
      }
      if (opts.file) {
        const filed = await fileAllTriaged({ vaultPath: cfg.vaultPath, db, limit: out.length });
        log(`filed ${filed.length} items`);
        for (const f of filed) log(`  ${f.id} → ${f.filed_path}${f.created ? "" : " (existing)"}`);
      }
    } finally {
      db.close();
    }
  });

program
  .command("file")
  .description("File every already-triaged ingestion into its suggested folder")
  .option("--limit <n>", "Max items to file", "50")
  .action(async (opts) => {
    const cfg = loadConfig();
    const db = openDB(cfg.dbPath);
    try {
      const filed = await fileAllTriaged({
        vaultPath: cfg.vaultPath,
        db,
        limit: Number(opts.limit) || 50,
      });
      log(`filed ${filed.length} items`);
      for (const f of filed) log(`  ${f.id} → ${f.filed_path}${f.created ? "" : " (existing)"}`);
    } finally {
      db.close();
    }
  });

program
  .command("index")
  .description("(Re)scan the vault into the local SQLite + FTS index")
  .action(async () => {
    const cfg = loadConfig();
    const db = openDB(cfg.dbPath);
    try {
      const r = await indexVault({ vaultPath: cfg.vaultPath, db });
      log(`indexed ${r.indexed}/${r.scanned} files (skipped ${r.skippedHidden} hidden)`);
    } finally {
      db.close();
    }
  });

program
  .command("embed")
  .description("Embed every indexed note with the configured embedding provider")
  .option("--provider <name>", "Embedding provider (mock|openai)", "mock")
  .option("--limit <n>", "Cap notes per run")
  .option("--batch <n>", "Batch size", "16")
  .option("--force", "Re-embed even when content_hash matches")
  .action(async (opts) => {
    const cfg = loadConfig();
    const db = openDB(cfg.dbPath);
    try {
      const provider = getEmbeddingProvider(opts.provider);
      const result = await embedAllNotes({
        db,
        provider,
        force: !!opts.force,
        ...(opts.limit ? { limit: Number(opts.limit) } : {}),
        batchSize: Number(opts.batch) || 16,
      });
      log(
        `embed[${provider.name}/${provider.model} dim=${provider.dim}]: ` +
          `scanned=${result.scanned} embedded=${result.embedded} ` +
          `skipped=${result.skipped} errors=${result.errors}`,
      );
    } finally {
      db.close();
    }
  });

program
  .command("search")
  .description("Search the vault (FTS5 by default; --hybrid blends FTS + vector cosine)")
  .argument("<query...>", "FTS5 query")
  .option("--hybrid", "Use hybrid FTS + vector search (requires `pebble embed` first)")
  .option("--provider <name>", "Embedding provider for --hybrid (mock|openai)", "mock")
  .action(async (queryParts: string[], opts) => {
    const cfg = loadConfig();
    const db = openDB(cfg.dbPath);
    try {
      const query = queryParts.join(" ");
      if (opts.hybrid) {
        const embedder = getEmbeddingProvider(opts.provider);
        const { searchHybrid } = await import("../embeddings/search.js");
        const hits = await searchHybrid({ db, query, embedder, limit: 25 });
        if (!hits.length) {
          log("(no hits)");
          return;
        }
        for (const h of hits) {
          const v = h.vector_score == null ? "—" : h.vector_score.toFixed(3);
          const r = h.fts_rank == null ? "—" : String(h.fts_rank);
          log(`${h.title ?? "(untitled)"} — ${h.path}`);
          log(`    fts_rank=${r} cos=${v} score=${h.score.toFixed(4)}`);
          if (h.snippet) log(`    ${h.snippet}`);
        }
        return;
      }
      const hits = db.searchNotes(query, 25);
      if (!hits.length) {
        log("(no hits)");
        return;
      }
      for (const h of hits) {
        log(`${h.title ?? "(untitled)"} — ${h.path}`);
        log(`    ${h.snippet}`);
      }
    } finally {
      db.close();
    }
  });

program
  .command("agent")
  .description("Run an agent loop over recent ingestions (stub for MVP)")
  .option("--dry-run", "Do not write any changes")
  .action(async (opts) => {
    const cfg = loadConfig();
    const db = openDB(cfg.dbPath);
    try {
      const tools = makeAgentTools({
        vaultPath: cfg.vaultPath,
        db,
        agent: "pebble-cli",
        dryRun: !!opts.dryRun,
      });
      const recent = await tools.list_recent_ingestions({ limit: 5 });
      log(`agent (dry-run=${!!opts.dryRun}) sees ${recent.items.length} recent items`);
      for (const r of recent.items) {
        log(`  ${r.id} [${r.status}] ${r.sender}: ${preview(r.text)}`);
      }
    } finally {
      db.close();
    }
  });

program
  .command("dashboard")
  .description("Start the HTTP server and print the dashboard URL")
  .option("--host <host>", "Override PEBBLE_HOST")
  .option("--port <port>", "Override PEBBLE_PORT")
  .action(async (opts) => {
    if (opts.host) process.env.PEBBLE_HOST = opts.host;
    if (opts.port) process.env.PEBBLE_PORT = opts.port;
    const cfg = loadConfig();
    const db = openDB(cfg.dbPath);
    const app = await buildServer({ config: cfg, db });
    const close = async () => { await app.close(); db.close(); process.exit(0); };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    await app.listen({ host: cfg.host, port: cfg.port });
    log(`pebble dashboard: http://${cfg.host}:${cfg.port}/dashboard`);
    log(`(token: PEBBLE_INGEST_SECRET — same as your ingest secret)`);
  });

program
  .command("doctor")
  .description("Sanity-check configuration, vault layout, and DB")
  .action(async () => {
    const issues: string[] = [];
    let cfg;
    try {
      cfg = loadConfig();
    } catch (err) {
      issues.push(`config: ${(err as Error).message}`);
      log("✗ " + issues.join("\n  "));
      process.exit(1);
    }

    try {
      await fs.access(cfg.vaultPath);
      log(`✓ vault exists: ${cfg.vaultPath}`);
    } catch {
      issues.push(`vault path missing: ${cfg.vaultPath} — run \`pebble init\``);
    }
    for (const d of Object.values(VAULT_DIRS)) {
      const p = path.join(cfg.vaultPath, d);
      try {
        await fs.access(p);
      } catch {
        issues.push(`missing dir: ${p}`);
      }
    }
    try {
      const db = openDB(cfg.dbPath);
      const v = db.raw.prepare("SELECT sqlite_version() AS v").get() as { v: string };
      const expected = currentSchemaVersion();
      const actual = db.schemaVersion();
      log(`✓ sqlite ${v.v} at ${cfg.dbPath} (schema v${actual} / latest v${expected})`);
      if (actual !== expected) {
        issues.push(
          `schema version drift: db=${actual}, expected=${expected} — re-open the DB or run \`pebble index\` to apply migrations`,
        );
      }
      db.close();
    } catch (err) {
      issues.push(`db: ${(err as Error).message}`);
    }
    if (cfg.ingestSecret.length < 16) {
      issues.push("ingest secret is short (<16 chars) — generate a stronger token");
    }
    if (cfg.bluebubblesUrl) {
      const password =
        buildSecretSource(process.env).get("PEBBLE_BLUEBUBBLES_PASSWORD") ?? "";
      const r = await pingBluebubbles({ url: cfg.bluebubblesUrl, password });
      if (r.ok) {
        log(`✓ bluebubbles reachable at ${cfg.bluebubblesUrl} (${r.detail})`);
      } else {
        issues.push(
          `bluebubbles: ${cfg.bluebubblesUrl} — ${r.detail}${
            password ? "" : " (no PEBBLE_BLUEBUBBLES_PASSWORD set)"
          }`,
        );
      }
    }
    if (issues.length) {
      log("");
      for (const i of issues) log("✗ " + i);
      process.exit(1);
    }
    log("✓ all checks passed");
  });

const secrets = program
  .command("secrets")
  .description("Manage secrets in the OS keychain (macOS/Linux)");

secrets
  .command("set")
  .description("Store a secret in the OS keychain (read from stdin)")
  .argument("<key>", "Env-var-style key, e.g. PEBBLE_INGEST_SECRET")
  .option("--value <value>", "Pass value on the command line (avoid; prefer stdin)")
  .action(async (key: string, opts: { value?: string }) => {
    const backend = detectKeychainBackend();
    if (!backend.available()) {
      log(`✗ keychain backend "${backend.name}" not available on this system`);
      process.exit(1);
    }
    const value = opts.value ?? (await readStdin());
    if (!value) {
      log("✗ no value provided (pipe via stdin or pass --value)");
      process.exit(1);
    }
    backend.set(KEYCHAIN_SERVICE, key, value);
    log(`✓ stored ${key} in ${backend.name} (service=${KEYCHAIN_SERVICE})`);
  });

secrets
  .command("get")
  .description("Read a secret from the OS keychain (prints to stdout)")
  .argument("<key>", "Env-var-style key, e.g. PEBBLE_INGEST_SECRET")
  .option("--show", "Print the secret value (otherwise only confirms presence)")
  .action((key: string, opts: { show?: boolean }) => {
    const backend = detectKeychainBackend();
    if (!backend.available()) {
      log(`✗ keychain backend "${backend.name}" not available on this system`);
      process.exit(1);
    }
    const v = backend.get(KEYCHAIN_SERVICE, key);
    if (v == null) {
      log(`✗ ${key} not found in ${backend.name}`);
      process.exit(1);
    }
    if (opts.show) {
      // eslint-disable-next-line no-console
      process.stdout.write(v);
    } else {
      log(`✓ ${key} present in ${backend.name} (length=${v.length})`);
    }
  });

secrets
  .command("unset")
  .description("Remove a secret from the OS keychain")
  .argument("<key>", "Env-var-style key, e.g. PEBBLE_INGEST_SECRET")
  .action((key: string) => {
    const backend = detectKeychainBackend();
    if (!backend.available()) {
      log(`✗ keychain backend "${backend.name}" not available on this system`);
      process.exit(1);
    }
    backend.unset(KEYCHAIN_SERVICE, key);
    log(`✓ removed ${key} from ${backend.name}`);
  });

program.parseAsync().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}
function preview(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 60 ? t : t.slice(0, 57) + "…";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}
