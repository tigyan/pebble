import fs from "node:fs/promises";
import path from "node:path";
import type { PebbleDB } from "../db/client.js";
import {
  type AgentAction,
  AgentActionSchema,
  type IngestRecord,
  type IngestStatus,
} from "../types/index.js";
import { agentActionsLogPath } from "../vault/paths.js";
import { proposePatch } from "../vault/writer.js";

export interface AgentContext {
  vaultPath: string;
  db: PebbleDB;
  agent: string;
  dryRun: boolean;
}

export interface AgentTools {
  read_note(args: { path: string }): Promise<{ content: string }>;
  append_to_note(args: { path: string; markdown: string }): Promise<{ bytes_written: number }>;
  create_note(args: { path: string; markdown: string }): Promise<{ created: boolean }>;
  propose_patch(args: { path: string; new_content: string; reason: string }): Promise<{
    patch_id: string;
    patch_path: string;
    backup_path: string;
  }>;
  search_vault(args: { query: string; limit?: number }): Promise<{
    hits: Array<{ path: string; title: string | null; snippet: string }>;
  }>;
  list_recent_ingestions(args: { limit?: number }): Promise<{ items: IngestRecord[] }>;
  mark_ingestion_status(args: { id: string; status: IngestStatus }): Promise<{ ok: boolean }>;
}

/**
 * The only filesystem surface agents are allowed to use. All paths are
 * resolved relative to the vault root and refused if they escape it.
 */
export function makeAgentTools(ctx: AgentContext): AgentTools {
  const safe = (rel: string) => safePath(ctx.vaultPath, rel);
  const log = (action: AgentAction) => recordAction(ctx, action);

  return {
    async read_note({ path: rel }) {
      const abs = safe(rel);
      try {
        const content = await fs.readFile(abs, "utf8");
        await log(actionFor(ctx, "read_note", { path: rel }, true, `${content.length} bytes`));
        return { content };
      } catch (err) {
        await log(actionFor(ctx, "read_note", { path: rel }, false, undefined, (err as Error).message));
        throw err;
      }
    },

    async append_to_note({ path: rel, markdown }) {
      const abs = safe(rel);
      if (ctx.dryRun) {
        await log(actionFor(ctx, "append_to_note", { path: rel, len: markdown.length }, true, "dry-run"));
        return { bytes_written: 0 };
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const block = markdown.endsWith("\n") ? markdown : markdown + "\n";
      await fs.appendFile(abs, "\n" + block, "utf8");
      const bytes = Buffer.byteLength(block, "utf8") + 1;
      await log(actionFor(ctx, "append_to_note", { path: rel, len: markdown.length }, true, `${bytes} bytes`));
      return { bytes_written: bytes };
    },

    async create_note({ path: rel, markdown }) {
      const abs = safe(rel);
      try {
        await fs.access(abs);
        await log(
          actionFor(ctx, "create_note", { path: rel }, false, undefined, "exists"),
        );
        throw new Error(`refusing to overwrite existing note: ${rel}`);
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
      if (ctx.dryRun) {
        await log(actionFor(ctx, "create_note", { path: rel, len: markdown.length }, true, "dry-run"));
        return { created: false };
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, markdown, "utf8");
      await log(actionFor(ctx, "create_note", { path: rel, len: markdown.length }, true, "created"));
      return { created: true };
    },

    async propose_patch({ path: rel, new_content, reason }) {
      const abs = safe(rel);
      if (ctx.dryRun) {
        await log(actionFor(ctx, "propose_patch", { path: rel, reason }, true, "dry-run"));
        return { patch_id: "dry-run", patch_path: "", backup_path: "" };
      }
      const r = await proposePatch(ctx.vaultPath, abs, new_content, reason);
      await log(actionFor(ctx, "propose_patch", { path: rel, reason, patch_id: r.patchId }, true, "patch staged"));
      return { patch_id: r.patchId, patch_path: r.patchPath, backup_path: r.backupPath };
    },

    async search_vault({ query, limit }) {
      const hits = ctx.db.searchNotes(query, limit ?? 25);
      await log(actionFor(ctx, "search_vault", { query, limit: limit ?? 25 }, true, `${hits.length} hits`));
      return { hits };
    },

    async list_recent_ingestions({ limit }) {
      const items = ctx.db.listRecentIngestions(limit ?? 25);
      await log(actionFor(ctx, "list_recent_ingestions", { limit: limit ?? 25 }, true, `${items.length} items`));
      return { items };
    },

    async mark_ingestion_status({ id, status }) {
      const rec = ctx.db.getIngestion(id);
      if (!rec) {
        await log(actionFor(ctx, "mark_ingestion_status", { id, status }, false, undefined, "not found"));
        return { ok: false };
      }
      if (ctx.dryRun) {
        await log(actionFor(ctx, "mark_ingestion_status", { id, status }, true, "dry-run"));
        return { ok: true };
      }
      ctx.db.setStatus(id, status);
      await log(actionFor(ctx, "mark_ingestion_status", { id, status }, true, "updated"));
      return { ok: true };
    },
  };
}

function safePath(vault: string, rel: string): string {
  const abs = path.resolve(vault, rel);
  const root = path.resolve(vault) + path.sep;
  if (!(abs + path.sep).startsWith(root)) {
    throw new Error(`path escapes vault: ${rel}`);
  }
  return abs;
}

function actionFor(
  ctx: AgentContext,
  tool: AgentAction["tool"],
  args: Record<string, unknown>,
  ok: boolean,
  summary?: string,
  error?: string,
): AgentAction {
  return AgentActionSchema.parse({
    ts: new Date().toISOString(),
    agent: ctx.agent,
    tool,
    args,
    dry_run: ctx.dryRun,
    ok,
    ...(error !== undefined ? { error } : {}),
    ...(summary !== undefined ? { result_summary: summary } : {}),
  });
}

async function recordAction(ctx: AgentContext, action: AgentAction): Promise<void> {
  ctx.db.logAgentAction(action);
  const logPath = agentActionsLogPath(ctx.vaultPath);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(action) + "\n", "utf8");
}
