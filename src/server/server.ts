import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { normalize } from "../adapters/index.js";
import type { PebbleConfig } from "../config.js";
import type { PebbleDB } from "../db/client.js";
import { fileOne } from "../filing/executor.js";
import { ingest } from "../ingest/pipeline.js";
import { getProvider } from "../triage/classifier.js";
import { dashboardHtml } from "./dashboard.js";

export interface ServerDeps {
  config: PebbleConfig;
  db: PebbleDB;
}

const PUBLIC_PATHS = new Set(["/health", "/dashboard"]);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 5 * 1024 * 1024,
    disableRequestLogging: false,
  });

  // --- Constant-time auth on every authenticated route -------------------
  app.addHook("onRequest", async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split("?")[0]!)) return;
    const got = (req.headers["x-pebble-token"] ?? "") as string;
    if (!safeEqual(got, deps.config.ingestSecret)) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({
    ok: true,
    vault: deps.config.vaultPath,
    provider: deps.config.triageProvider,
  }));

  app.get("/dashboard", async (_req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return dashboardHtml();
  });

  // --- Ingestion --------------------------------------------------------
  app.post("/ingest", async (req, reply) => {
    try {
      const { adapter, payload } = normalize(
        req.headers as Record<string, string | string[] | undefined>,
        req.body,
      );
      const { record, duplicate } = await ingest(payload, {
        vaultPath: deps.config.vaultPath,
        appendOnly: deps.config.appendOnly,
        db: deps.db,
      });
      reply.code(202).send({
        ok: true,
        adapter,
        id: record.id,
        duplicate_of: duplicate?.id ?? null,
        wrote: {
          inbox: record.inbox_path,
          thread: record.thread_path,
          person: record.person_path,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ ok: false, error: "invalid_payload", issues: err.issues });
        return;
      }
      req.log.error({ err }, "ingest failed");
      reply.code(500).send({ ok: false, error: (err as Error).message });
    }
  });

  // --- Dashboard JSON API ----------------------------------------------
  app.get("/api/config", async () => ({
    // Sanitized; never echoes the ingest secret or any API key.
    vault_path: deps.config.vaultPath,
    triage_provider: deps.config.triageProvider,
    host: deps.config.host,
    port: deps.config.port,
    append_only: deps.config.appendOnly,
  }));

  app.get("/api/recent", async (req) => {
    const q = (req.query as { limit?: string; status?: string }) ?? {};
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    let items = deps.db.listRecentIngestions(limit);
    if (q.status) items = items.filter((i) => i.status === q.status);
    return {
      items: items.map((i) => ({ ...i, triage: deps.db.getTriage(i.id) })),
    };
  });

  app.get("/api/ingestions/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = deps.db.getIngestion(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    return { ...rec, triage: deps.db.getTriage(id) };
  });

  app.post("/api/ingestions/:id/triage", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = deps.db.getIngestion(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    try {
      const provider = getProvider(deps.config.triageProvider);
      const triage = await provider.classify(rec);
      deps.db.setTriage(id, triage, "triaged");
      return { ok: true, id, triage };
    } catch (err) {
      req.log.error({ err }, "triage failed");
      return reply.code(500).send({ ok: false, error: (err as Error).message });
    }
  });

  const FileBody = z.object({ folder: z.string().min(1).optional() });

  app.post("/api/ingestions/:id/file", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = deps.db.getIngestion(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    const triage = deps.db.getTriage(id);
    if (!triage) {
      return reply
        .code(409)
        .send({ ok: false, error: "no triage result yet — run triage first" });
    }
    let body: z.infer<typeof FileBody>;
    try {
      body = FileBody.parse(req.body ?? {});
    } catch (err) {
      return reply.code(400).send({ ok: false, error: (err as Error).message });
    }
    const effective = body.folder
      ? { ...triage, suggested_folder: body.folder }
      : triage;
    const result = await fileOne({
      vaultPath: deps.config.vaultPath,
      db: deps.db,
      record: rec,
      triage: effective,
    });
    return { ok: true, ...result };
  });

  app.get("/api/search", async (req, reply) => {
    const q = (req.query as { q?: string }) ?? {};
    if (!q.q) {
      reply.code(400).send({ error: "missing q" });
      return;
    }
    return { hits: deps.db.searchNotes(q.q, 25) };
  });

  // Legacy aliases (kept for back-compat with the original CLI examples).
  app.get("/recent", async (req) => {
    const q = (req.query as { limit?: string }) ?? {};
    const limit = Math.min(Number(q.limit ?? 25) || 25, 200);
    return { items: deps.db.listRecentIngestions(limit) };
  });
  app.get("/search", async (req, reply) => {
    const q = (req.query as { q?: string }) ?? {};
    if (!q.q) {
      reply.code(400).send({ error: "missing q" });
      return;
    }
    return { hits: deps.db.searchNotes(q.q, 25) };
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
