import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server/server.js";
import { loadConfig } from "../../src/config.js";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import { runTriage } from "../../src/triage/runner.js";
import { fileAllTriaged } from "../../src/filing/executor.js";
import { makeTempVault, rmRf } from "../helpers.js";
import { fileURLToPath } from "node:url";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SECRET = "this-is-a-test-secret-token";

let vault = "";
let db: PebbleDB;
let app: FastifyInstance;

beforeEach(async () => {
  vault = await makeTempVault();
  const env = {
    PEBBLE_VAULT_PATH: vault,
    PEBBLE_INGEST_SECRET: SECRET,
    PEBBLE_TRIAGE_PROVIDER: "mock",
    PEBBLE_HOST: "127.0.0.1",
    PEBBLE_PORT: "0",
  } as NodeJS.ProcessEnv;
  const config = loadConfig(env);
  db = openDB(config.dbPath);
  app = await buildServer({ config, db, worker: false });
});

afterEach(async () => {
  await app?.close();
  db?.close();
  await rmRf(vault);
});

describe("integration: webhook → inbox → triage → suggested filing", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { source: "manual", sender: "self", thread_id: "t", text: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the secret via ?token= query param (header-less senders)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/ingest?token=${encodeURIComponent(SECRET)}`,
      headers: { "content-type": "application/json" },
      payload: { source: "manual", sender: "self", thread_id: "t", text: "via query" },
    });
    expect(res.statusCode).toBe(202);
  });

  it("rejects an incorrect ?token= query param", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest?token=wrong",
      headers: { "content-type": "application/json" },
      payload: { source: "manual", sender: "self", thread_id: "t", text: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("ingests a BlueBubbles iMessage payload, writes Markdown, then triages it", async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX, "imessage.bluebubbles.json"), "utf8"),
    );

    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "x-pebble-token": SECRET, "content-type": "application/json" },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const json = res.json() as {
      ok: boolean;
      adapter: string;
      id: string;
      wrote: { inbox: string; thread: string; person: string };
    };
    expect(json.ok).toBe(true);
    expect(json.adapter).toBe("bluebubbles");

    // The vault should now contain Markdown for this message.
    const inbox = await fs.readFile(json.wrote.inbox, "utf8");
    expect(inbox).toContain("renew the domain");
    const thread = await fs.readFile(json.wrote.thread, "utf8");
    expect(thread).toMatch(/^---/);
    expect(thread).toContain("renew the domain");
    const person = await fs.readFile(json.wrote.person, "utf8");
    expect(person).toContain("Mentions");

    // Ingestion log mirrored on disk.
    const logPath = path.join(vault, "_System", "ingestion-log.jsonl");
    const log = await fs.readFile(logPath, "utf8");
    const entries = log.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(json.id);

    // Triage produces schema-valid output and updates DB.
    const triaged = await runTriage({ db, provider: "mock", limit: 5 });
    expect(triaged).toHaveLength(1);
    expect(triaged[0]!.id).toBe(json.id);
    expect(triaged[0]!.triage.type).toBe("task");
    expect(triaged[0]!.triage.suggested_folder).toBe("Tasks");

    const after = db.getIngestion(json.id);
    expect(after?.status).toBe("triaged");
    const persistedTriage = db.getTriage(json.id);
    expect(persistedTriage?.is_task).toBe(true);

    // Filing executor: triaged → filed, with backlink to the thread.
    const filed = await fileAllTriaged({ vaultPath: vault, db });
    expect(filed).toHaveLength(1);
    expect(filed[0]!.id).toBe(json.id);
    expect(filed[0]!.filed_path.startsWith(path.join(vault, "Tasks"))).toBe(true);

    const filedNote = await fs.readFile(filed[0]!.filed_path, "utf8");
    expect(filedNote).toContain("renew the domain");
    expect(filedNote).toMatch(/^---/);

    const threadAfter = await fs.readFile(json.wrote.thread, "utf8");
    expect(threadAfter).toMatch(/Filed as \[\[Tasks\//);

    expect(db.getIngestion(json.id)?.status).toBe("filed");
  });

  it("flags a near-duplicate via Jaccard shingles even when the hash differs", async () => {
    const auth = { "x-pebble-token": SECRET };

    // First ingestion lays down the original.
    const first = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: auth,
      payload: {
        source: "manual",
        sender: "self",
        thread_id: "t",
        text: "remember to renew the domain name before it expires next week",
      },
    });
    expect(first.statusCode).toBe(202);
    const firstId = (first.json() as { id: string }).id;

    // Second ingestion: same idea, slightly reworded → different SHA-256 but
    // high shingle overlap.
    const second = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: auth,
      payload: {
        source: "manual",
        sender: "self",
        thread_id: "t",
        text: "renew the domain name before it expires next week!!",
      },
    });
    expect(second.statusCode).toBe(202);
    const body = second.json() as {
      duplicate_of: string | null;
      near_duplicate_of: { id: string; score: number } | null;
    };
    expect(body.duplicate_of).toBeNull(); // hashes differ
    expect(body.near_duplicate_of).not.toBeNull();
    expect(body.near_duplicate_of!.id).toBe(firstId);
    expect(body.near_duplicate_of!.score).toBeGreaterThanOrEqual(0.6);
  });

  describe("/do command", () => {
    const auth = { "x-pebble-token": SECRET };

    it("creates a note from a /do request and skips the Inbox mirror", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: auth,
        payload: {
          source: "manual",
          sender: "self",
          thread_id: "t-do",
          text: "/do Расписать признаки подобия в «Учеба»",
        },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as {
        kind?: string;
        action?: string;
        target_path?: string;
        ok?: boolean;
      };
      expect(body.kind).toBe("command");
      expect(body.action).toBe("create");
      expect(body.target_path).toMatch(/\.md$/);

      const written = await fs.readFile(path.join(vault, body.target_path!), "utf8");
      expect(written.length).toBeGreaterThan(0);

      // /do is NOT mirrored into the ingestion log — only the agent's writes.
      const logPath = path.join(vault, "_System", "ingestion-log.jsonl");
      const log = await fs.readFile(logPath, "utf8").catch(() => "");
      const ingestionEntries = log.split("\n").filter(Boolean);
      expect(ingestionEntries).toHaveLength(0);

      // Agent action log captures the create.
      const actionsLog = await fs.readFile(
        path.join(vault, "_System", "agent-actions.jsonl"),
        "utf8",
      );
      const actions = actionsLog.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(actions.some((a) => a.tool === "create_note" && a.ok === true)).toBe(true);
    });

    it("appends to an existing note when /do is sent twice with the same target", async () => {
      const send = (text: string) =>
        app.inject({
          method: "POST",
          url: "/ingest",
          headers: auth,
          payload: { source: "manual", sender: "self", thread_id: "t-do", text },
        });

      const first = await send("/do добавь признак 1 в «Учеба»");
      expect(first.statusCode).toBe(202);
      const firstBody = first.json() as { target_path: string; action: string };
      expect(firstBody.action).toBe("create");

      const second = await send("/do добавь признак 2 в «Учеба»");
      expect(second.statusCode).toBe(202);
      const secondBody = second.json() as {
        target_path: string;
        action: string;
        fell_back?: string;
      };
      expect(secondBody.target_path).toBe(firstBody.target_path);
      expect(secondBody.action).toBe("append");
      expect(secondBody.fell_back).toBe("create_to_append");

      const written = await fs.readFile(path.join(vault, firstBody.target_path), "utf8");
      expect(written).toContain("признак 1");
      expect(written).toContain("признак 2");
    });

    it("contains a path-traversal target inside the vault", async () => {
      // why: defense-in-depth. Even if the model tries to escape (here via the
      // quoted name), slugify + sanitizeTargetPath + safePath together must
      // keep the write inside the vault root.
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: auth,
        payload: {
          source: "manual",
          sender: "self",
          thread_id: "t-do",
          text: '/do записать в «../../../etc/passwd»',
        },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { target_path: string; kind?: string };
      expect(body.kind).toBe("command");
      expect(body.target_path).not.toMatch(/\.\./);
      const abs = path.resolve(vault, body.target_path);
      expect(abs.startsWith(path.resolve(vault) + path.sep)).toBe(true);
    });
  });

  it("routes an inbound message to an open clarification on the same thread", async () => {
    const { stageClarification } = await import("../../src/agent/clarify.js");
    const staged = await stageClarification(
      { vaultPath: vault, db, agent: "librarian-test", dryRun: false },
      {
        source_kind: "ingestion",
        sender: "+15550009999",
        thread_id: "iMessage;-;+15550009999",
        question: "Inbox or Areas/Work?",
        options: ["Inbox", "Areas/Work"],
      },
    );

    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "x-pebble-token": SECRET },
      payload: {
        source: "manual",
        sender: "+15550009999",
        thread_id: "iMessage;-;+15550009999",
        text: "Areas/Work",
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      ok: true,
      kind: "clarification_reply",
      clarification_id: staged.request.id,
    });

    const fromDb = db.getClarification(staged.request.id);
    expect(fromDb!.status).toBe("answered");
    expect(fromDb!.answer_text).toBe("Areas/Work");

    // No vault ingestion was written for the reply.
    const logPath = path.join(vault, "_System", "ingestion-log.jsonl");
    const exists = await fs
      .stat(logPath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const log = await fs.readFile(logPath, "utf8");
      const entries = log.split("\n").filter(Boolean);
      expect(entries).toHaveLength(0);
    }
  });

  it("suppresses an echo (same sender/thread/text within window) without re-writing", async () => {
    const auth = { "x-pebble-token": SECRET };
    const payload = {
      source: "imessage",
      sender: "+15550001111",
      thread_id: "iMessage;-;+15550001111",
      text: "hello echo",
    };

    const first = await app.inject({ method: "POST", url: "/ingest", headers: auth, payload });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as { id: string; skipped?: boolean };
    expect(firstBody.skipped).toBeUndefined();

    const second = await app.inject({ method: "POST", url: "/ingest", headers: auth, payload });
    expect(second.statusCode).toBe(202);
    const secondBody = second.json() as {
      id: string;
      skipped?: boolean;
      duplicate_of: string | null;
    };
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.duplicate_of).toBe(firstBody.id);

    // Vault-side: only one entry made it into the ingestion log.
    const logPath = path.join(vault, "_System", "ingestion-log.jsonl");
    const log = await fs.readFile(logPath, "utf8");
    const entries = log.split("\n").filter(Boolean);
    expect(entries).toHaveLength(1);
  });

  describe("ingest_filter", () => {
    const auth = { "x-pebble-token": SECRET };

    async function putSettings(body: unknown) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { ...auth, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    }

    async function postIngest(sender: string, threadId: string, text = "hi") {
      return app.inject({
        method: "POST",
        url: "/ingest",
        headers: auth,
        payload: { source: "manual", sender, thread_id: threadId, text },
      });
    }

    it("allowlist: blocks non-listed sender with reason=not_in_allowlist", async () => {
      await putSettings({
        ingest_filter: { mode: "allowlist", senders: ["+1friend"], threads: [] },
      });
      const res = await postIngest("+2stranger", "t-stranger");
      expect(res.statusCode).toBe(202);
      const body = res.json() as { filtered?: boolean; reason?: string; id?: string };
      expect(body.filtered).toBe(true);
      expect(body.reason).toBe("not_in_allowlist");
      expect(body.id).toBeUndefined();
    });

    it("allowlist: lets a matching sender through and writes to the vault", async () => {
      await putSettings({
        ingest_filter: { mode: "allowlist", senders: ["+1friend"], threads: [] },
      });
      const res = await postIngest("+1friend", "t-friend", "hello from friend");
      expect(res.statusCode).toBe(202);
      const body = res.json() as { ok: boolean; id?: string; filtered?: boolean };
      expect(body.filtered).toBeUndefined();
      expect(body.id).toBeDefined();
    });

    it("denylist: blocks listed thread_id with reason=denylist", async () => {
      await putSettings({
        ingest_filter: { mode: "denylist", senders: [], threads: ["bad-thread"] },
      });
      const res = await postIngest("anyone", "bad-thread");
      expect(res.statusCode).toBe(202);
      const body = res.json() as { filtered?: boolean; reason?: string };
      expect(body.filtered).toBe(true);
      expect(body.reason).toBe("denylist");
    });

    it("denylist: lets unrelated senders through", async () => {
      await putSettings({
        ingest_filter: { mode: "denylist", senders: ["spam"], threads: [] },
      });
      const res = await postIngest("friend", "t-good", "ok");
      expect(res.statusCode).toBe(202);
      const body = res.json() as { id?: string; filtered?: boolean };
      expect(body.filtered).toBeUndefined();
      expect(body.id).toBeDefined();
    });

    it("PUT /api/settings rejects an unknown filter mode", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { ...auth, "content-type": "application/json" },
        payload: { ingest_filter: { mode: "weird" } },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
