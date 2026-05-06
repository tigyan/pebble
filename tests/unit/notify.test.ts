import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageClarification } from "../../src/agent/clarify.js";
import { formatQuestion, notifyClarification } from "../../src/agent/notify.js";
import type { AgentContext } from "../../src/agent/tools.js";
import { loadConfig, type PebbleConfig } from "../../src/config.js";
import { openDB, type PebbleDB } from "../../src/db/client.js";
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

function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string, init: RequestInit) =>
    Promise.resolve(impl(url, init))) as unknown as typeof fetch;
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

async function stage() {
  const r = await stageClarification(ctxFor(), {
    source_kind: "ingestion",
    sender: "+15550009999",
    thread_id: "iMessage;-;+15550009999",
    question: "Inbox or Areas/Work?",
    options: ["Inbox", "Areas/Work"],
  });
  return r.request;
}

describe("formatQuestion", () => {
  it("renders options as a numbered list when present", () => {
    const text = formatQuestion({
      id: "x",
      created_at: "t",
      status: "open",
      source_kind: "ingestion",
      ingestion_id: null,
      sender: "self",
      thread_id: "t",
      question: "Pick one:",
      options: ["A", "B"],
      context: {},
      answered_at: null,
      answer_text: null,
      notified_at: null,
    });
    expect(text).toBe("Pick one:\n\n[1] A\n[2] B");
  });

  it("returns just the question when there are no options", () => {
    const text = formatQuestion({
      id: "x",
      created_at: "t",
      status: "open",
      source_kind: "ingestion",
      ingestion_id: null,
      sender: "self",
      thread_id: "t",
      question: "Why?",
      options: [],
      context: {},
      answered_at: null,
      answer_text: null,
      notified_at: null,
    });
    expect(text).toBe("Why?");
  });
});

describe("notifyClarification", () => {
  it("skipped when flag is off", async () => {
    const req = await stage();
    const r = await notifyClarification(
      {
        ctx: ctxFor(),
        config: { enabled: false, bridgeUrl: "http://x", bridgeToken: "t" },
      },
      req,
    );
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("disabled");
    expect(db.getClarification(req.id)!.notified_at).toBeNull();
  });

  it("skipped when bridge config missing", async () => {
    const req = await stage();
    const r = await notifyClarification(
      {
        ctx: ctxFor(),
        config: { enabled: true, bridgeUrl: "", bridgeToken: "" },
      },
      req,
    );
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("no_config");
  });

  it("posts to Bridge, stamps notified_at, audits", async () => {
    const req = await stage();
    let captured: { body: any; auth: string } | null = null;
    const fetchImpl = mockFetch((url, init) => {
      const headers = init.headers as Record<string, string>;
      captured = { body: JSON.parse(init.body as string), auth: headers.authorization! };
      expect(url).toBe("http://127.0.0.1:8989/api/v1/messages/send");
      return new Response(
        JSON.stringify({ ok: true, data: { result: { status: "sent", provider: "applescript", id: "m1", sentAt: "t" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const r = await notifyClarification(
      {
        ctx: ctxFor(),
        config: { enabled: true, bridgeUrl: "http://127.0.0.1:8989", bridgeToken: "tok-abc" },
        fetchImpl,
      },
      req,
    );
    expect(r.status).toBe("sent");
    expect(captured!.auth).toBe("Bearer tok-abc");
    expect(captured!.body).toMatchObject({
      chat_id: "iMessage;-;+15550009999",
      text: "Inbox or Areas/Work?\n\n[1] Inbox\n[2] Areas/Work",
    });
    expect(db.getClarification(req.id)!.notified_at).not.toBeNull();
    const log = await fs.readFile(agentActionsLogPath(vault), "utf8");
    expect(log).toMatch(/"op":"notify"/);
    expect(log).toMatch(/"ok":true/);
  });

  it("idempotent: a second call when notified_at is set is a no-op", async () => {
    const req = await stage();
    const fetchImpl = mockFetch(() =>
      new Response(
        JSON.stringify({ ok: true, data: { result: { status: "sent", provider: "applescript", id: "m1", sentAt: "t" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await notifyClarification(
      { ctx: ctxFor(), config: { enabled: true, bridgeUrl: "http://x", bridgeToken: "t" }, fetchImpl },
      req,
    );
    const stamp = db.getClarification(req.id)!.notified_at;
    expect(stamp).not.toBeNull();

    let calls = 0;
    const fetchImpl2 = mockFetch(() => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const r = await notifyClarification(
      {
        ctx: ctxFor(),
        config: { enabled: true, bridgeUrl: "http://x", bridgeToken: "t" },
        fetchImpl: fetchImpl2,
      },
      db.getClarification(req.id)!,
    );
    expect(r.status).toBe("already_notified");
    expect(calls).toBe(0);
  });

  it("Bridge error is captured, audited, NOT thrown; notified_at stays null", async () => {
    const req = await stage();
    const fetchImpl = mockFetch(() =>
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await notifyClarification(
      {
        ctx: ctxFor(),
        config: { enabled: true, bridgeUrl: "http://x", bridgeToken: "t" },
        fetchImpl,
      },
      req,
    );
    expect(r.status).toBe("error");
    expect(r.reason).toMatch(/RATE_LIMITED/);
    expect(db.getClarification(req.id)!.notified_at).toBeNull();
    const log = await fs.readFile(agentActionsLogPath(vault), "utf8");
    expect(log).toMatch(/"ok":false/);
  });

  it("dry-run: does not call fetch, does not stamp notified_at, audits as dry-run", async () => {
    const req = await stage();
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const r = await notifyClarification(
      {
        ctx: ctxFor({ dryRun: true }),
        config: { enabled: true, bridgeUrl: "http://x", bridgeToken: "t" },
        fetchImpl,
      },
      req,
    );
    expect(r.status).toBe("sent");
    expect(r.reason).toBe("dry-run");
    expect(calls).toBe(0);
    expect(db.getClarification(req.id)!.notified_at).toBeNull();
  });
});
