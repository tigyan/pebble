import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server/server.js";
import { loadConfig } from "../../src/config.js";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import { settingsFilePath } from "../../src/settings/store.js";
import { makeTempVault, rmRf } from "../helpers.js";

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

const auth = { "x-pebble-token": SECRET };

async function ingest(text: string) {
  const res = await app.inject({
    method: "POST",
    url: "/ingest",
    headers: auth,
    payload: { source: "manual", sender: "self", thread_id: "self", text },
  });
  return res.json() as { id: string };
}

describe("dashboard API", () => {
  it("auth-gates everything except /health and /dashboard", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/dashboard" })).statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: "/api/recent" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/search?q=x" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/recent" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/search?q=x" })).statusCode).toBe(401);
  });

  it("/dashboard returns the HTML shell", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("<title>Pebble</title>");
    expect(res.body).toContain("X-Pebble-Token");
  });

  it("/api/config never echoes the ingest secret", async () => {
    const res = await app.inject({ method: "GET", url: "/api/config", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toContain(SECRET);
    const json = res.json() as Record<string, unknown>;
    expect(json.vault_path).toBe(vault);
    expect(json.triage_provider).toBe("mock");
  });

  it("/api/recent attaches triage results when present", async () => {
    const a = await ingest("TODO: renew domain ASAP");
    await ingest("just a thought");

    // Trigger triage on the first via the API.
    const t = await app.inject({
      method: "POST",
      url: `/api/ingestions/${a.id}/triage`,
      headers: auth,
    });
    expect(t.statusCode).toBe(200);
    expect((t.json() as { triage: { type: string } }).triage.type).toBe("task");

    const recent = await app.inject({ method: "GET", url: "/api/recent?limit=10", headers: auth });
    const items = (recent.json() as { items: any[] }).items;
    expect(items.length).toBe(2);
    const triaged = items.find((i) => i.id === a.id);
    expect(triaged.triage).not.toBeNull();
    expect(triaged.triage.type).toBe("task");
  });

  it("POST /api/ingestions/:id/file honors a folder override and back-links the thread", async () => {
    const r = await ingest("TODO: ship MVP");
    await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/triage`,
      headers: auth,
    });

    const filed = await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/file`,
      headers: auth,
      payload: { folder: "Projects/Pebble" },
    });
    expect(filed.statusCode).toBe(200);
    const body = filed.json() as { filed_path: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.filed_path).toContain(path.join("Projects", "Pebble") + path.sep);

    // Re-fetch to confirm status moved to filed.
    const after = await app.inject({
      method: "GET",
      url: `/api/ingestions/${r.id}`,
      headers: auth,
    });
    expect((after.json() as { status: string }).status).toBe("filed");
  });

  it("rejects file before triage with 409", async () => {
    const r = await ingest("nothing triaged yet");
    const res = await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/file`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it("/dashboard exposes Settings view, Reject button, and bookmarklet helper", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Settings");
    expect(res.body).toContain("Reject");
    expect(res.body).toContain("buildBookmarklet");
    expect(res.body).toContain("consumeCaptureHash");
    expect(res.body).toContain("#capture=");
  });

  it("PUT /api/settings persists to <vault>/_System/settings.json and overlays /api/config", async () => {
    // baseline
    const before = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ settings: {} });

    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth,
      payload: { triage_provider: "mock", default_folders: { task: "Tasks/Inbox" } },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as { settings: { triage_provider: string; default_folders: Record<string, string> } };
    expect(body.settings.triage_provider).toBe("mock");
    expect(body.settings.default_folders.task).toBe("Tasks/Inbox");

    // round-trip via file
    const onDisk = JSON.parse(await fs.readFile(settingsFilePath(vault), "utf8"));
    expect(onDisk.triage_provider).toBe("mock");
    expect(onDisk.default_folders.task).toBe("Tasks/Inbox");

    // overlay reflected in /api/config
    const cfg = await app.inject({ method: "GET", url: "/api/config", headers: auth });
    expect((cfg.json() as { triage_provider: string }).triage_provider).toBe("mock");
  });

  it("PUT /api/settings rejects unknown provider with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth,
      payload: { triage_provider: "totally-fake-llm" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("default_folders setting overrides suggested_folder when filing without explicit folder", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth,
      payload: { default_folders: { task: "Custom/Tasks" } },
    });
    const r = await ingest("TODO: settle invoice");
    await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/triage`,
      headers: auth,
    });
    const filed = await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/file`,
      headers: auth,
      payload: {},
    });
    expect(filed.statusCode).toBe(200);
    const body = filed.json() as { filed_path: string };
    expect(body.filed_path).toContain(path.join("Custom", "Tasks") + path.sep);
  });

  it("POST /api/ingestions/:id/reject moves status to rejected", async () => {
    const r = await ingest("not interesting");
    const res = await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/reject`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("rejected");

    const after = await app.inject({
      method: "GET",
      url: `/api/ingestions/${r.id}`,
      headers: auth,
    });
    expect((after.json() as { status: string }).status).toBe("rejected");
  });

  it("rejects filing a rejected ingestion with 409", async () => {
    const r = await ingest("dismiss me");
    await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/triage`,
      headers: auth,
    });
    await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/reject`,
      headers: auth,
    });
    const filed = await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/file`,
      headers: auth,
      payload: {},
    });
    expect(filed.statusCode).toBe(409);
  });

  it("rejects rejecting an already-filed ingestion with 409", async () => {
    const r = await ingest("TODO: lock this one");
    await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/triage`,
      headers: auth,
    });
    await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/file`,
      headers: auth,
      payload: { folder: "Tasks" },
    });
    const reject = await app.inject({
      method: "POST",
      url: `/api/ingestions/${r.id}/reject`,
      headers: auth,
    });
    expect(reject.statusCode).toBe(409);
  });

  describe("clarifications API", () => {
    it("lists open questions and answers them", async () => {
      const { stageClarification } = await import("../../src/agent/clarify.js");
      const staged = await stageClarification(
        { vaultPath: vault, db, agent: "librarian-test", dryRun: false },
        {
          source_kind: "ingestion",
          sender: "self",
          thread_id: "thread-dash",
          question: "Inbox or Areas/Work?",
          options: ["Inbox", "Areas/Work"],
        },
      );

      const list = await app.inject({
        method: "GET",
        url: "/api/clarifications?status=open",
        headers: auth,
      });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { items: Array<{ id: string }> };
      expect(body.items.map((i) => i.id)).toContain(staged.request.id);

      const answer = await app.inject({
        method: "POST",
        url: `/api/clarifications/${staged.request.id}/answer`,
        headers: { ...auth, "content-type": "application/json" },
        payload: { answer_text: "Areas/Work" },
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({ ok: true, answer_text: "Areas/Work" });

      const fromDb = db.getClarification(staged.request.id);
      expect(fromDb!.status).toBe("answered");
      expect(fromDb!.answer_text).toBe("Areas/Work");

      const repeat = await app.inject({
        method: "POST",
        url: `/api/clarifications/${staged.request.id}/answer`,
        headers: { ...auth, "content-type": "application/json" },
        payload: { answer_text: "again" },
      });
      expect(repeat.statusCode).toBe(409);
    });

    it("404 on unknown id, 400 on empty body", async () => {
      const nf = await app.inject({
        method: "POST",
        url: "/api/clarifications/does-not-exist/answer",
        headers: { ...auth, "content-type": "application/json" },
        payload: { answer_text: "x" },
      });
      expect(nf.statusCode).toBe(404);

      const { stageClarification } = await import("../../src/agent/clarify.js");
      const s = await stageClarification(
        { vaultPath: vault, db, agent: "librarian-test", dryRun: false },
        { source_kind: "ingestion", sender: "self", thread_id: "thread-empty", question: "?" },
      );
      const empty = await app.inject({
        method: "POST",
        url: `/api/clarifications/${s.request.id}/answer`,
        headers: { ...auth, "content-type": "application/json" },
        payload: { answer_text: "" },
      });
      expect(empty.statusCode).toBe(400);
    });
  });
});
