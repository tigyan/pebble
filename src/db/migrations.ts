import type Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/**
 * Versioned migrations. Append-only: never edit a past migration once shipped.
 *
 * Versioning uses `PRAGMA user_version`. The baseline schema in `schema.ts`
 * is always applied first (it's idempotent — every `CREATE` is `IF NOT EXISTS`),
 * then any migration whose `version` is greater than the DB's current
 * `user_version` runs in a single transaction and bumps `user_version`.
 *
 * Adding a migration:
 *   1. Append a `{ version: <next>, name, up }` entry below.
 *   2. Mirror the *additive* part in `schema.ts` / `schema.sql` so a fresh DB
 *      lands on the latest shape directly (skipping migrations).
 *   3. Tests in `tests/unit/migrations.test.ts` check idempotence + replay.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "add_clarifications",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS clarifications (
          id           TEXT PRIMARY KEY,
          created_at   TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'open',
          source_kind  TEXT NOT NULL,
          ingestion_id TEXT,
          sender       TEXT NOT NULL,
          thread_id    TEXT NOT NULL,
          question     TEXT NOT NULL,
          options_json TEXT NOT NULL DEFAULT '[]',
          context_json TEXT NOT NULL DEFAULT '{}',
          answered_at  TEXT,
          answer_text  TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_clarifications_thread_status ON clarifications(thread_id, status);
        CREATE INDEX IF NOT EXISTS ix_clarifications_status        ON clarifications(status);
        CREATE INDEX IF NOT EXISTS ix_clarifications_created_at    ON clarifications(created_at);
      `);
    },
  },
  {
    version: 2,
    name: "clarifications_add_notified_at",
    up(db) {
      // why: outbound notify (Pebble Bridge) needs to be idempotent so a
      // retry doesn't spam the same iMessage thread. We record when (if
      // ever) a question was actually sent.
      const cols = (db.pragma("table_info(clarifications)") as Array<{ name: string }>).map(
        (r) => r.name,
      );
      if (!cols.includes("notified_at")) {
        db.exec(`ALTER TABLE clarifications ADD COLUMN notified_at TEXT`);
      }
    },
  },
];

export function currentSchemaVersion(): number {
  return MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
}

export function getDbVersion(db: Database.Database): number {
  const row = db.pragma("user_version", { simple: true });
  return typeof row === "number" ? row : 0;
}

/**
 * Apply the baseline schema (idempotent) and every pending migration.
 * Returns the version the DB ends up on.
 */
export function runMigrations(db: Database.Database): number {
  // Baseline schema. CREATE … IF NOT EXISTS keeps this safe to call on every
  // open: it's a no-op when the tables already exist.
  db.exec(SCHEMA_SQL);

  let version = getDbVersion(db);
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version <= version) continue;
    const tx = db.transaction(() => {
      m.up(db);
      // user_version takes a literal, not a parameter.
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
    version = m.version;
  }
  return version;
}
