import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentStatus, runAgentOnce } from "../../src/agent/runner.js";
import { loadConfig, type PebbleConfig } from "../../src/config.js";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { makeSettingsStore, type SettingsStore } from "../../src/settings/store.js";
import { makeTempVault, rmRf } from "../helpers.js";

let vault = "";
let db: PebbleDB;
let config: PebbleConfig;
let settings: SettingsStore;

beforeEach(async () => {
  vault = await makeTempVault();
  config = loadConfig({
    PEBBLE_VAULT_PATH: vault,
    PEBBLE_INGEST_SECRET: "this-is-a-test-secret",
    PEBBLE_TRIAGE_PROVIDER: "mock",
  } as NodeJS.ProcessEnv);
  db = openDB(config.dbPath);
  settings = await makeSettingsStore(vault);
});
afterEach(async () => {
  db?.close();
  await rmRf(vault);
});

async function ingestText(text: string) {
  return ingest(
    { source: "manual", sender: "self", thread_id: "self", text, timestamp: new Date().toISOString() },
    { vaultPath: vault, db },
  );
}

describe("runAgentOnce", () => {
  it("triages one raw item and charges the budget", async () => {
    await ingestText("TODO: ship it");
    const r = await runAgentOnce({ config, db, settings });
    expect(r.triaged).toBe(1);
    expect(r.usage?.calls_used).toBe(1);
  });

  it("respects daily_call_budget and reports skipped_budget", async () => {
    await settings.set({ agent: { daily_call_budget: 1 } });
    await ingestText("first");
    await ingestText("second");
    const r = await runAgentOnce({ config, db, settings, limit: 5 });
    expect(r.triaged).toBe(1);
    expect(r.skipped_budget).toBe(1);
    expect(r.usage?.calls_used).toBe(1);
    expect(r.usage?.remaining).toBe(0);
  });

  it("auto-files when autoFile=true", async () => {
    await settings.set({ default_folders: { task: "Custom/Tasks" } });
    const ing = await ingestText("TODO: invoice");
    const r = await runAgentOnce({ config, db, settings, autoFile: true });
    expect(r.filed).toBe(1);
    const rec = db.getIngestion(ing.record.id);
    expect(rec?.status).toBe("filed");
  });

  it("agentStatus returns zero usage on a fresh DB", () => {
    const s = agentStatus({ db, settings, config });
    expect(s.usage.calls_used).toBe(0);
    expect(s.model).toBe("mock");
  });

  it("triage_model overrides the budget bookkeeping key", async () => {
    await settings.set({ agent: { triage_model: "claude-haiku-4-5" } });
    await ingestText("hello");
    const r = await runAgentOnce({ config, db, settings });
    expect(r.usage?.model).toBe("claude-haiku-4-5");
    expect(r.usage?.calls_used).toBe(1);
  });
});
