#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.js";
import { openDB } from "../db/client.js";
import { indexVault } from "../indexer/index.js";
import { ingest } from "../ingest/pipeline.js";
import { runTriage } from "../triage/runner.js";
import { fileAllTriaged } from "../filing/executor.js";
import { manualAdapter } from "../adapters/manual.js";
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
      const { record, duplicate } = await ingest(payload, {
        vaultPath: cfg.vaultPath,
        appendOnly: cfg.appendOnly,
        db,
      });
      log(`ingested ${record.id}`);
      log(`  inbox:  ${record.inbox_path}`);
      log(`  thread: ${record.thread_path}`);
      log(`  person: ${record.person_path}`);
      if (duplicate) log(`  ⚠ likely duplicate of ${duplicate.id}`);
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
  .command("search")
  .description("Full-text search the vault")
  .argument("<query...>", "FTS5 query")
  .action(async (queryParts: string[]) => {
    const cfg = loadConfig();
    const db = openDB(cfg.dbPath);
    try {
      const hits = db.searchNotes(queryParts.join(" "), 25);
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
      log(`✓ sqlite ${v.v} at ${cfg.dbPath}`);
      db.close();
    } catch (err) {
      issues.push(`db: ${(err as Error).message}`);
    }
    if (cfg.ingestSecret.length < 16) {
      issues.push("ingest secret is short (<16 chars) — generate a stronger token");
    }
    if (issues.length) {
      log("");
      for (const i of issues) log("✗ " + i);
      process.exit(1);
    }
    log("✓ all checks passed");
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
