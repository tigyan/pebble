import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AgentAction,
  ClarificationRequest,
  ClarificationStatus,
  IngestRecord,
  IngestStatus,
  TriageResult,
} from "../types/index.js";
import { getDbVersion, runMigrations } from "./migrations.js";

export interface PebbleDB {
  raw: Database.Database;
  insertIngestion(rec: IngestRecord): void;
  setTriage(id: string, triage: TriageResult, status: IngestStatus): void;
  setStatus(id: string, status: IngestStatus): void;
  getIngestion(id: string): IngestRecord | null;
  getTriage(id: string): TriageResult | null;
  listRecentIngestions(limit?: number): IngestRecord[];
  findByHash(hash: string): IngestRecord | null;
  upsertNote(args: {
    path: string;
    title: string | null;
    tags: string[];
    aliases: string[];
    headings: string[];
    links: string[];
    frontmatter: Record<string, unknown>;
    body: string;
    bodyHash: string;
  }): void;
  searchNotes(query: string, limit?: number): Array<{ path: string; title: string | null; snippet: string }>;
  logAgentAction(action: AgentAction): void;
  upsertEmbedding(args: {
    path: string;
    model: string;
    dim: number;
    vec: Buffer;
    contentHash: string;
  }): void;
  getEmbedding(path: string, model: string): {
    path: string;
    model: string;
    dim: number;
    vec: Buffer;
    contentHash: string;
    indexedAt: string;
  } | null;
  listEmbeddings(model: string): Array<{
    path: string;
    dim: number;
    vec: Buffer;
    contentHash: string;
  }>;
  countEmbeddings(model: string): number;
  getBudgetUsage(day: string, model: string): { calls: number; tokens: number };
  incrementBudget(args: { day: string; model: string; calls: number; tokens: number }): void;
  insertClarification(rec: ClarificationRequest): void;
  getClarification(id: string): ClarificationRequest | null;
  listClarifications(args?: { status?: ClarificationStatus; limit?: number }): ClarificationRequest[];
  /** Most recent `open` clarification for a thread, or null. Used for reply routing. */
  findOpenClarificationByThread(thread_id: string): ClarificationRequest | null;
  resolveClarification(args: {
    id: string;
    answer_text: string;
    answered_at?: string;
    status?: Extract<ClarificationStatus, "answered" | "cancelled">;
  }): boolean;
  /** Stamp `notified_at` once the outbound send succeeded. Idempotent — does nothing if already set. */
  markClarificationNotified(args: { id: string; notified_at?: string }): boolean;
  schemaVersion(): number;
  close(): void;
}

export function openDB(dbPath: string): PebbleDB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  runMigrations(db);

  const stmts = {
    insertIngestion: db.prepare(`
      INSERT OR REPLACE INTO ingestions
        (id, source, sender, thread_id, text, attachments_json, timestamp, received_at,
         status, original_text_hash, inbox_path, thread_path, person_path)
      VALUES (@id, @source, @sender, @thread_id, @text, @attachments_json, @timestamp, @received_at,
              @status, @original_text_hash, @inbox_path, @thread_path, @person_path)
    `),
    setTriage: db.prepare(`
      UPDATE ingestions SET triage_json = ?, status = ? WHERE id = ?
    `),
    setStatus: db.prepare(`UPDATE ingestions SET status = ? WHERE id = ?`),
    getTriage: db.prepare(`SELECT triage_json FROM ingestions WHERE id = ?`),
    get: db.prepare(`SELECT * FROM ingestions WHERE id = ?`),
    listRecent: db.prepare(`SELECT * FROM ingestions ORDER BY received_at DESC LIMIT ?`),
    findByHash: db.prepare(`SELECT * FROM ingestions WHERE original_text_hash = ? ORDER BY received_at DESC LIMIT 1`),
    upsertNote: db.prepare(`
      INSERT INTO notes (path, title, tags_json, aliases_json, headings_json, links_json,
                         frontmatter_json, body_hash, indexed_at)
      VALUES (@path, @title, @tags_json, @aliases_json, @headings_json, @links_json,
              @frontmatter_json, @body_hash, @indexed_at)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        tags_json = excluded.tags_json,
        aliases_json = excluded.aliases_json,
        headings_json = excluded.headings_json,
        links_json = excluded.links_json,
        frontmatter_json = excluded.frontmatter_json,
        body_hash = excluded.body_hash,
        indexed_at = excluded.indexed_at
    `),
    deleteFts: db.prepare(`DELETE FROM notes_fts WHERE path = ?`),
    insertFts: db.prepare(`
      INSERT INTO notes_fts (path, title, body, tags) VALUES (?, ?, ?, ?)
    `),
    searchFts: db.prepare(`
      SELECT path, title, snippet(notes_fts, 2, '<mark>', '</mark>', '…', 12) AS snippet
      FROM notes_fts
      WHERE notes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
    insertAgentAction: db.prepare(`
      INSERT INTO agent_actions (ts, agent, tool, args_json, dry_run, ok, error, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    upsertEmbedding: db.prepare(`
      INSERT INTO note_embeddings (path, model, dim, vec_blob, content_hash, indexed_at)
      VALUES (@path, @model, @dim, @vec, @content_hash, @indexed_at)
      ON CONFLICT(path, model) DO UPDATE SET
        dim          = excluded.dim,
        vec_blob     = excluded.vec_blob,
        content_hash = excluded.content_hash,
        indexed_at   = excluded.indexed_at
    `),
    getEmbedding: db.prepare(`
      SELECT path, model, dim, vec_blob, content_hash, indexed_at
      FROM note_embeddings WHERE path = ? AND model = ?
    `),
    listEmbeddings: db.prepare(`
      SELECT path, dim, vec_blob, content_hash
      FROM note_embeddings WHERE model = ?
    `),
    countEmbeddings: db.prepare(`
      SELECT COUNT(*) AS n FROM note_embeddings WHERE model = ?
    `),
    getBudget: db.prepare(`
      SELECT calls, tokens FROM agent_budget WHERE day = ? AND model = ?
    `),
    incrementBudget: db.prepare(`
      INSERT INTO agent_budget (day, model, calls, tokens)
      VALUES (@day, @model, @calls, @tokens)
      ON CONFLICT(day, model) DO UPDATE SET
        calls  = calls  + excluded.calls,
        tokens = tokens + excluded.tokens
    `),
    insertClarification: db.prepare(`
      INSERT INTO clarifications
        (id, created_at, status, source_kind, ingestion_id, sender, thread_id,
         question, options_json, context_json, answered_at, answer_text, notified_at)
      VALUES
        (@id, @created_at, @status, @source_kind, @ingestion_id, @sender, @thread_id,
         @question, @options_json, @context_json, @answered_at, @answer_text, @notified_at)
    `),
    markNotified: db.prepare(`
      UPDATE clarifications SET notified_at = @notified_at
      WHERE id = @id AND notified_at IS NULL
    `),
    getClarification: db.prepare(`SELECT * FROM clarifications WHERE id = ?`),
    listClarificationsByStatus: db.prepare(`
      SELECT * FROM clarifications WHERE status = ? ORDER BY created_at DESC LIMIT ?
    `),
    listClarificationsAll: db.prepare(`
      SELECT * FROM clarifications ORDER BY created_at DESC LIMIT ?
    `),
    findOpenByThread: db.prepare(`
      SELECT * FROM clarifications
      WHERE thread_id = ? AND status = 'open'
      ORDER BY created_at DESC LIMIT 1
    `),
    resolveClarification: db.prepare(`
      UPDATE clarifications
      SET status = @status, answered_at = @answered_at, answer_text = @answer_text
      WHERE id = @id AND status = 'open'
    `),
  };

  function rowToClarification(row: any): ClarificationRequest {
    return {
      id: row.id,
      created_at: row.created_at,
      status: row.status,
      source_kind: row.source_kind,
      ingestion_id: row.ingestion_id ?? null,
      sender: row.sender,
      thread_id: row.thread_id,
      question: row.question,
      options: JSON.parse(row.options_json),
      context: JSON.parse(row.context_json),
      answered_at: row.answered_at ?? null,
      answer_text: row.answer_text ?? null,
      notified_at: row.notified_at ?? null,
    };
  }

  function rowToRecord(row: any): IngestRecord {
    return {
      id: row.id,
      source: row.source,
      sender: row.sender,
      thread_id: row.thread_id,
      text: row.text,
      attachments: JSON.parse(row.attachments_json),
      timestamp: row.timestamp,
      received_at: row.received_at,
      status: row.status,
      original_text_hash: row.original_text_hash,
      inbox_path: row.inbox_path,
      thread_path: row.thread_path,
      person_path: row.person_path,
    };
  }

  return {
    raw: db,
    insertIngestion(rec) {
      stmts.insertIngestion.run({
        id: rec.id,
        source: rec.source,
        sender: rec.sender,
        thread_id: rec.thread_id,
        text: rec.text,
        attachments_json: JSON.stringify(rec.attachments ?? []),
        timestamp: rec.timestamp,
        received_at: rec.received_at,
        status: rec.status,
        original_text_hash: rec.original_text_hash,
        inbox_path: rec.inbox_path,
        thread_path: rec.thread_path,
        person_path: rec.person_path,
      });
    },
    setTriage(id, triage, status) {
      stmts.setTriage.run(JSON.stringify(triage), status, id);
    },
    setStatus(id, status) {
      stmts.setStatus.run(status, id);
    },
    getTriage(id) {
      const row = stmts.getTriage.get(id) as { triage_json: string | null } | undefined;
      if (!row || !row.triage_json) return null;
      return JSON.parse(row.triage_json);
    },
    getIngestion(id) {
      const row = stmts.get.get(id) as any;
      return row ? rowToRecord(row) : null;
    },
    listRecentIngestions(limit = 50) {
      return (stmts.listRecent.all(limit) as any[]).map(rowToRecord);
    },
    findByHash(hash) {
      const row = stmts.findByHash.get(hash) as any;
      return row ? rowToRecord(row) : null;
    },
    upsertNote(n) {
      const tx = db.transaction(() => {
        stmts.upsertNote.run({
          path: n.path,
          title: n.title,
          tags_json: JSON.stringify(n.tags),
          aliases_json: JSON.stringify(n.aliases),
          headings_json: JSON.stringify(n.headings),
          links_json: JSON.stringify(n.links),
          frontmatter_json: JSON.stringify(n.frontmatter),
          body_hash: n.bodyHash,
          indexed_at: new Date().toISOString(),
        });
        stmts.deleteFts.run(n.path);
        stmts.insertFts.run(n.path, n.title ?? "", n.body, n.tags.join(" "));
      });
      tx();
    },
    searchNotes(query, limit = 25) {
      return stmts.searchFts.all(query, limit) as Array<{
        path: string;
        title: string | null;
        snippet: string;
      }>;
    },
    logAgentAction(a) {
      stmts.insertAgentAction.run(
        a.ts,
        a.agent,
        a.tool,
        JSON.stringify(a.args),
        a.dry_run ? 1 : 0,
        a.ok ? 1 : 0,
        a.error ?? null,
        a.result_summary ?? null,
      );
    },
    upsertEmbedding({ path, model, dim, vec, contentHash }) {
      stmts.upsertEmbedding.run({
        path,
        model,
        dim,
        vec,
        content_hash: contentHash,
        indexed_at: new Date().toISOString(),
      });
    },
    getEmbedding(path, model) {
      const row = stmts.getEmbedding.get(path, model) as
        | {
            path: string;
            model: string;
            dim: number;
            vec_blob: Buffer;
            content_hash: string;
            indexed_at: string;
          }
        | undefined;
      if (!row) return null;
      return {
        path: row.path,
        model: row.model,
        dim: row.dim,
        vec: row.vec_blob,
        contentHash: row.content_hash,
        indexedAt: row.indexed_at,
      };
    },
    listEmbeddings(model) {
      return (
        stmts.listEmbeddings.all(model) as Array<{
          path: string;
          dim: number;
          vec_blob: Buffer;
          content_hash: string;
        }>
      ).map((r) => ({
        path: r.path,
        dim: r.dim,
        vec: r.vec_blob,
        contentHash: r.content_hash,
      }));
    },
    countEmbeddings(model) {
      const row = stmts.countEmbeddings.get(model) as { n: number };
      return row.n;
    },
    getBudgetUsage(day, model) {
      const row = stmts.getBudget.get(day, model) as
        | { calls: number; tokens: number }
        | undefined;
      return { calls: row?.calls ?? 0, tokens: row?.tokens ?? 0 };
    },
    incrementBudget({ day, model, calls, tokens }) {
      stmts.incrementBudget.run({ day, model, calls, tokens });
    },
    insertClarification(rec) {
      stmts.insertClarification.run({
        id: rec.id,
        created_at: rec.created_at,
        status: rec.status,
        source_kind: rec.source_kind,
        ingestion_id: rec.ingestion_id,
        sender: rec.sender,
        thread_id: rec.thread_id,
        question: rec.question,
        options_json: JSON.stringify(rec.options ?? []),
        context_json: JSON.stringify(rec.context ?? {}),
        answered_at: rec.answered_at,
        answer_text: rec.answer_text,
        notified_at: rec.notified_at,
      });
    },
    markClarificationNotified({ id, notified_at }) {
      const info = stmts.markNotified.run({
        id,
        notified_at: notified_at ?? new Date().toISOString(),
      });
      return info.changes > 0;
    },
    getClarification(id) {
      const row = stmts.getClarification.get(id) as any;
      return row ? rowToClarification(row) : null;
    },
    listClarifications(args) {
      const limit = args?.limit ?? 50;
      const rows =
        args?.status !== undefined
          ? (stmts.listClarificationsByStatus.all(args.status, limit) as any[])
          : (stmts.listClarificationsAll.all(limit) as any[]);
      return rows.map(rowToClarification);
    },
    findOpenClarificationByThread(thread_id) {
      const row = stmts.findOpenByThread.get(thread_id) as any;
      return row ? rowToClarification(row) : null;
    },
    resolveClarification({ id, answer_text, answered_at, status }) {
      const info = stmts.resolveClarification.run({
        id,
        answer_text,
        answered_at: answered_at ?? new Date().toISOString(),
        status: status ?? "answered",
      });
      return info.changes > 0;
    },
    schemaVersion() {
      return getDbVersion(db);
    },
    close() {
      db.close();
    },
  };
}
