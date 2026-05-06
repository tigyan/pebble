import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageClarification, tryResolveClarification } from "../../src/agent/clarify.js";
import { loadConfig, type PebbleConfig } from "../../src/config.js";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import type { AgentContext } from "../../src/agent/tools.js";
import { agentActionsLogPath } from "../../src/vault/paths.js";
import { makeTempVault, rmRf } from "../helpers.js";

let vault = "";
let db: PebbleDB;
let config: PebbleConfig;

function ctxFor(opts?: { dryRun?: boolean }): AgentContext {
  return {
    vaultPath: vault,
    db,
    agent: "librarian-test",
    dryRun: opts?.dryRun ?? false,
  };
}

beforeEach(async () => {
  vault = await makeTempVault();
  config = loadConfig({
    PEBBLE_VAULT_PATH: vault,
    PEBBLE_INGEST_SECRET: "this-is-a-test-secret",
    PEBBLE_TRIAGE_PROVIDER: "mock",
  } as NodeJS.ProcessEnv);
  db = openDB(config.dbPath);
});
afterEach(async () => {
  db?.close();
  await rmRf(vault);
});

describe("stageClarification", () => {
  it("persists a clarification, returns it, and audits the action", async () => {
    const r = await stageClarification(ctxFor(), {
      source_kind: "ingestion",
      ingestion_id: "ing_abc",
      sender: "+15550001",
      thread_id: "iMessage;-;+15550001",
      question: "Filed under Inbox/Triage or Areas/Work?",
      options: ["Inbox", "Areas/Work"],
      context: { kind: "pick_folder", candidates: ["Inbox", "Areas/Work"] },
    });

    expect(r.reused).toBe(false);
    expect(r.request.status).toBe("open");
    expect(r.request.options).toEqual(["Inbox", "Areas/Work"]);

    const fromDb = db.getClarification(r.request.id);
    expect(fromDb).not.toBeNull();
    expect(fromDb!.question).toMatch(/Inbox/);
    expect(fromDb!.context).toMatchObject({ kind: "pick_folder" });

    const log = await fs.readFile(agentActionsLogPath(vault), "utf8");
    expect(log).toMatch(/"tool":"stage_clarification"/);
    expect(log).toMatch(/"ok":true/);
  });

  it("is idempotent per thread: a second open call returns the existing one", async () => {
    const first = await stageClarification(ctxFor(), {
      source_kind: "do_command",
      sender: "self",
      thread_id: "thread-X",
      question: "Append to Today or create a new note?",
      options: ["append", "create"],
    });
    const second = await stageClarification(ctxFor(), {
      source_kind: "do_command",
      sender: "self",
      thread_id: "thread-X",
      question: "Different question, same thread",
    });

    expect(second.reused).toBe(true);
    expect(second.request.id).toBe(first.request.id);
    expect(db.listClarifications({ status: "open" })).toHaveLength(1);
  });

  it("after resolving, a new question on the same thread is staged fresh", async () => {
    const first = await stageClarification(ctxFor(), {
      source_kind: "ingestion",
      sender: "self",
      thread_id: "thread-Y",
      question: "Q1",
    });
    db.resolveClarification({ id: first.request.id, answer_text: "Inbox" });

    const second = await stageClarification(ctxFor(), {
      source_kind: "ingestion",
      sender: "self",
      thread_id: "thread-Y",
      question: "Q2",
    });
    expect(second.reused).toBe(false);
    expect(second.request.id).not.toBe(first.request.id);
  });

  it("tryResolveClarification: matches open question on thread, marks answered, audits", async () => {
    const staged = await stageClarification(ctxFor(), {
      source_kind: "ingestion",
      sender: "self",
      thread_id: "thread-Z",
      question: "Inbox or Areas/Work?",
      options: ["Inbox", "Areas/Work"],
    });

    const r = await tryResolveClarification(ctxFor(), {
      sender: "self",
      thread_id: "thread-Z",
      text: "Areas/Work",
    });
    expect(r).not.toBeNull();
    expect(r!.request.id).toBe(staged.request.id);
    expect(r!.request.status).toBe("answered");
    expect(r!.request.answer_text).toBe("Areas/Work");

    const fromDb = db.getClarification(staged.request.id);
    expect(fromDb!.status).toBe("answered");
    expect(fromDb!.answer_text).toBe("Areas/Work");

    const log = await fs.readFile(agentActionsLogPath(vault), "utf8");
    expect(log).toMatch(/"op":"resolve"/);
  });

  it("tryResolveClarification: returns null when no open question on thread", async () => {
    const r = await tryResolveClarification(ctxFor(), {
      sender: "self",
      thread_id: "thread-empty",
      text: "anything",
    });
    expect(r).toBeNull();
  });

  it("dry-run: returns a request, does not persist, audits with dry_run=true", async () => {
    const r = await stageClarification(ctxFor({ dryRun: true }), {
      source_kind: "ingestion",
      sender: "self",
      thread_id: "thread-dry",
      question: "Anything?",
    });

    expect(r.request.id).toBeTruthy();
    expect(db.getClarification(r.request.id)).toBeNull();
    const log = await fs.readFile(agentActionsLogPath(vault), "utf8");
    expect(log).toMatch(/"dry_run":true/);
    expect(log).toMatch(/"result_summary":"dry-run"/);
  });
});
