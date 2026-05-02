import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AgentAction,
  IngestRecord,
  IngestStatus,
  TriageResult,
} from "../types/index.js";
import { SCHEMA_SQL } from "./schema.js";

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
  close(): void;
}

export function openDB(dbPath: string): PebbleDB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);

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
  };

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
    close() {
      db.close();
    },
  };
}
