import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { normalize } from "../adapters/index.js";
import {
  type AttachmentResolver,
  makeBluebubblesAttachmentResolver,
} from "../adapters/bluebubbles-fetch.js";
import type { PebbleConfig } from "../config.js";
import type { PebbleDB } from "../db/client.js";
import { fileOne } from "../filing/executor.js";
import { ingest } from "../ingest/pipeline.js";
import { buildSecretSource } from "../secrets/source.js";
import {
  EditableSettingsSchema,
  effectiveIngestFilter,
  evaluateIngestFilter,
  makeSettingsStore,
  type SettingsStore,
} from "../settings/store.js";
import { agentStatus, runAgentOnce } from "../agent/runner.js";
import {
  DoEchoCache,
  getCommandProvider,
  parseDoCommand,
  runCommand,
} from "../agent/command.js";
import { getEmbeddingProvider } from "../embeddings/provider.js";
import { searchHybrid } from "../embeddings/search.js";
import { getProvider } from "../triage/classifier.js";
import { startWorker, type WorkerHandle } from "../worker/index.js";
import { dashboardHtml } from "./dashboard.js";

export interface ServerDeps {
  config: PebbleConfig;
  db: PebbleDB;
  settings?: SettingsStore;
  /** Disable background worker (tests pass false to keep behaviour deterministic). */
  worker?: boolean;
}

const PUBLIC_PATHS = new Set(["/health", "/dashboard"]);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const settings = deps.settings ?? (await makeSettingsStore(deps.config.vaultPath));

  const effectiveTriageProvider = (): string =>
    settings.get().triage_provider ?? deps.config.triageProvider;

  // Build per-scheme attachment resolvers from config + secrets. We do this
  // once at boot so the BB password is resolved exactly once and never
  // captured into per-request closures or log lines.
  const resolvers: Record<string, AttachmentResolver> = {};
  if (deps.config.bluebubblesUrl) {
    const secrets = buildSecretSource(process.env);
    const password = secrets.get("PEBBLE_BLUEBUBBLES_PASSWORD") ?? "";
    resolvers["bluebubbles:"] = makeBluebubblesAttachmentResolver({
      url: deps.config.bluebubblesUrl,
      password,
    });
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // why: ?token= is allowed as a fallback for clients that can't set
      // custom headers (e.g. some BlueBubbles Server builds). Mask it
      // before the URL ever reaches a log sink.
      serializers: {
        req(req) {
          const out: Record<string, unknown> = {
            method: req.method,
            url: redactToken(req.url),
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
          if (typeof req.socket?.remotePort === "number") {
            out.remotePort = req.socket.remotePort;
          }
          return out;
        },
      },
    },
    bodyLimit: 5 * 1024 * 1024,
    disableRequestLogging: false,
  });

  // why: `/do` skips the ingestion echo log, so a double-fired command would
  // otherwise burn a second model call. 60s window mirrors the pipeline's.
  const doEchoCache = new DoEchoCache(60_000);

  let worker: WorkerHandle | null = null;
  if (deps.worker !== false) {
    worker = startWorker({
      config: deps.config,
      db: deps.db,
      settings,
      onError: (err) => app.log.error({ err }, "worker tick failed"),
    });
    app.addHook("onClose", async () => worker?.stop());
  }

  // --- Constant-time auth on every authenticated route -------------------
  app.addHook("onRequest", async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split("?")[0]!)) return;
    // why: header is preferred. ?token= is a fallback for senders that
    // can't set custom headers (some BlueBubbles Server builds). The URL
    // is redacted before logging — see the req serializer above.
    const headerToken = (req.headers["x-pebble-token"] ?? "") as string;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const queryToken = typeof q.token === "string" ? q.token : "";
    const got = headerToken || queryToken;
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
      // why: contact-level filter runs *after* normalize so it sees canonical
      // sender/thread_id and works for every adapter without bespoke logic.
      // We re-read settings each request so dashboard edits apply immediately.
      const filter = effectiveIngestFilter(settings.get());
      const decision = evaluateIngestFilter(filter, payload.sender, payload.thread_id);
      if (!decision.allow) {
        req.log.info(
          { sender: payload.sender, thread: payload.thread_id, reason: decision.reason },
          "ingest filtered",
        );
        reply.code(202).send({
          ok: true,
          adapter,
          filtered: true,
          reason: decision.reason,
        });
        return;
      }

      // why: a `/do …` prefix flips this from "save as a note" to "execute
      // and write the result somewhere in the vault". The original message
      // is intentionally NOT mirrored into Inbox — only the agent's writes
      // are persisted, with a full entry in agent-actions.jsonl.
      const cmd = parseDoCommand(payload.text);
      if (cmd) {
        if (doEchoCache.hit(payload.sender, payload.thread_id, payload.text)) {
          req.log.info(
            { sender: payload.sender, thread: payload.thread_id },
            "do command echo suppressed",
          );
          reply.code(202).send({
            ok: true,
            adapter,
            kind: "command",
            skipped: true,
            reason: "echo",
          });
          return;
        }
        try {
          const provider = getCommandProvider(effectiveTriageProvider());
          const result = await runCommand({
            text: payload.text,
            vaultPath: deps.config.vaultPath,
            db: deps.db,
            provider,
          });
          req.log.info(
            {
              sender: payload.sender,
              thread: payload.thread_id,
              provider: provider.name,
              action: result.action,
              path: result.target_path,
            },
            "do command executed",
          );
          reply.code(202).send({
            adapter,
            kind: "command",
            ...result,
          });
        } catch (err) {
          req.log.error({ err }, "do command failed");
          reply.code(500).send({
            ok: false,
            kind: "command",
            error: (err as Error).message,
          });
        }
        return;
      }

      const { record, duplicate, near_duplicate, skipped } = await ingest(payload, {
        vaultPath: deps.config.vaultPath,
        appendOnly: deps.config.appendOnly,
        db: deps.db,
        ...(Object.keys(resolvers).length > 0
          ? { attachmentResolvers: resolvers }
          : {}),
      });
      if (skipped) {
        req.log.info(
          { id: record.id, sender: payload.sender, thread: payload.thread_id },
          "ingest echo suppressed",
        );
      }
      reply.code(202).send({
        ok: true,
        adapter,
        id: record.id,
        duplicate_of: duplicate?.id ?? null,
        near_duplicate_of: near_duplicate,
        ...(skipped ? { skipped: true } : {}),
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
    triage_provider: effectiveTriageProvider(),
    triage_provider_default: deps.config.triageProvider,
    host: deps.config.host,
    port: deps.config.port,
    append_only: deps.config.appendOnly,
  }));

  app.get("/api/settings", async () => ({ settings: settings.get() }));

  app.put("/api/settings", async (req, reply) => {
    const parsed = EditableSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, issues: parsed.error.issues });
    }
    const updated = await settings.set(parsed.data);
    worker?.reconfigure();
    return { ok: true, settings: updated };
  });

  app.get("/api/worker", async () => ({
    worker: worker?.status() ?? { running: false, enabled: false },
    agent: agentStatus({ db: deps.db, settings, config: deps.config }),
  }));

  app.post("/api/worker/run", async (_req, reply) => {
    if (!worker) return reply.code(503).send({ ok: false, error: "worker disabled" });
    try {
      const result = await worker.runOnce();
      return { ok: true, ...result, status: worker.status() };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get("/api/agent", async () => agentStatus({ db: deps.db, settings, config: deps.config }));

  app.post("/api/agent/run", async (req, reply) => {
    const q = (req.body as { limit?: number; auto_file?: boolean } | null) ?? {};
    try {
      const result = await runAgentOnce({
        config: deps.config,
        db: deps.db,
        settings,
        ...(q.limit ? { limit: Math.max(1, Math.min(50, Number(q.limit))) } : {}),
        autoFile: !!q.auto_file,
      });
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: (err as Error).message });
    }
  });

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
      const provider = getProvider(effectiveTriageProvider());
      const triage = await provider.classify(rec);
      deps.db.setTriage(id, triage, "triaged");
      return { ok: true, id, triage };
    } catch (err) {
      req.log.error({ err }, "triage failed");
      return reply.code(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/api/ingestions/:id/reject", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = deps.db.getIngestion(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (rec.status === "filed") {
      return reply
        .code(409)
        .send({ ok: false, error: "already filed — cannot reject" });
    }
    deps.db.setStatus(id, "rejected");
    return { ok: true, id, status: "rejected" };
  });

  const FileBody = z.object({ folder: z.string().min(1).optional() });

  app.post("/api/ingestions/:id/file", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = deps.db.getIngestion(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (rec.status === "rejected") {
      return reply
        .code(409)
        .send({ ok: false, error: "ingestion was rejected — cannot file" });
    }
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
    const defaults = settings.get().default_folders ?? {};
    const folder =
      body.folder ?? defaults[triage.type] ?? triage.suggested_folder;
    const effective = { ...triage, suggested_folder: folder };
    const result = await fileOne({
      vaultPath: deps.config.vaultPath,
      db: deps.db,
      record: rec,
      triage: effective,
    });
    return { ok: true, ...result };
  });

  app.get("/api/search", async (req, reply) => {
    const q = (req.query as { q?: string; hybrid?: string; provider?: string }) ?? {};
    if (!q.q) {
      reply.code(400).send({ error: "missing q" });
      return;
    }
    if (q.hybrid === "true" || q.hybrid === "1") {
      let embedder;
      try {
        embedder = getEmbeddingProvider(q.provider ?? "mock");
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const hits = await searchHybrid({ db: deps.db, query: q.q, embedder, limit: 25 });
      return { hits, mode: "hybrid", model: embedder.model };
    }
    return { hits: deps.db.searchNotes(q.q, 25), mode: "fts" };
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

// why: ?token= can carry the ingest secret for senders that can't set
// custom headers. Strip it from any string that's about to be logged.
function redactToken(url: string): string {
  return url.replace(/([?&])token=[^&]*/g, "$1token=***");
}
