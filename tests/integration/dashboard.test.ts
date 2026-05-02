import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server/server.js";
import { loadConfig } from "../../src/config.js";
import { openDB, type PebbleDB } from "../../src/db/client.js";
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
  app = await buildServer({ config, db });
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
});
