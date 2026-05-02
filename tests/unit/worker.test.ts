import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type PebbleConfig } from "../../src/config.js";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { makeSettingsStore, type SettingsStore } from "../../src/settings/store.js";
import { startWorker, type WorkerScheduler } from "../../src/worker/index.js";
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

function fakeScheduler(): WorkerScheduler & { fire(): void; running(): boolean } {
  let cb: (() => void) | null = null;
  return {
    start(_intervalMs, fn) {
      cb = fn;
    },
    stop() {
      cb = null;
    },
    fire() {
      cb?.();
    },
    running: () => cb !== null,
  };
}

async function ingestText(text: string) {
  return ingest(
    { source: "manual", sender: "self", thread_id: "self", text, timestamp: new Date().toISOString() },
    { vaultPath: vault, db },
  );
}

describe("background worker", () => {
  it("starts disabled by default; status reflects defaults", () => {
    const w = startWorker({ config, db, settings });
    const s = w.status();
    expect(s.enabled).toBe(false);
    expect(s.running).toBe(false);
    expect(s.interval_ms).toBe(60_000);
    expect(s.batch).toBe(5);
    w.stop();
  });

  it("triages raw ingestions on tick when enabled", async () => {
    await settings.set({ worker: { enabled: true, interval_ms: 1000, batch: 10 } });
    await ingestText("TODO: ship MVP");
    await ingestText("idea: pebble plugin");

    const sched = fakeScheduler();
    const w = startWorker({ config, db, settings, scheduler: sched });
    expect(sched.running()).toBe(true);

    sched.fire();
    // give the async tick a microtask to complete
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const s = w.status();
    expect(s.triaged_total).toBe(2);
    expect(s.filed_total).toBe(0);
    w.stop();
  });

  it("auto-files when settings.worker.auto_file is true", async () => {
    await settings.set({
      worker: { enabled: true, interval_ms: 1000, auto_file: true, batch: 5 },
    });
    await ingestText("TODO: renew domain");

    const w = startWorker({ config, db, settings });
    const out = await w.runOnce();
    expect(out.triaged).toBe(1);
    expect(out.filed).toBe(1);
    w.stop();
  });

  it("respects default_folders setting when auto-filing", async () => {
    await settings.set({
      worker: { enabled: true, auto_file: true, batch: 5 },
      default_folders: { task: "Custom/Tasks" },
    });
    const r = await ingestText("TODO: invoice");

    const w = startWorker({ config, db, settings });
    await w.runOnce();
    const rec = db.getIngestion(r.record.id);
    expect(rec?.status).toBe("filed");
    w.stop();
  });

  it("reconfigure picks up settings changes", async () => {
    const sched = fakeScheduler();
    const w = startWorker({ config, db, settings, scheduler: sched });
    expect(sched.running()).toBe(false);

    await settings.set({ worker: { enabled: true, interval_ms: 2000 } });
    w.reconfigure();
    expect(sched.running()).toBe(true);
    expect(w.status().enabled).toBe(true);

    await settings.set({ worker: { enabled: false } });
    w.reconfigure();
    expect(sched.running()).toBe(false);
    w.stop();
  });

  it("captures errors without killing the worker", async () => {
    await settings.set({ worker: { enabled: true } });
    const sched = fakeScheduler();
    const errors: unknown[] = [];

    // Force getProvider to throw by setting an invalid provider via env-fallback;
    // settings.triage_provider is constrained, so override config at the source.
    const w = startWorker({
      config: { ...config, triageProvider: "not-a-real-provider" as never },
      db,
      settings,
      scheduler: sched,
      onError: (e) => errors.push(e),
    });
    await ingestText("anything");

    sched.fire();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(errors.length).toBeGreaterThan(0);
    expect(w.status().last_error).not.toBeNull();
    w.stop();
  });
});
