import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { normalize } from "../adapters/index.js";
import type { PebbleConfig } from "../config.js";
import type { PebbleDB } from "../db/client.js";
import { ingest } from "../ingest/pipeline.js";

export interface ServerDeps {
  config: PebbleConfig;
  db: PebbleDB;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 5 * 1024 * 1024,
    disableRequestLogging: false,
  });

  // --- Constant-time auth on every state-changing route ------------------
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.url === "/health") return;
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
