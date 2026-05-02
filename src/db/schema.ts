/**
 * SQL schema as a string so we don't have to copy a .sql file at build time.
 * Mirror of src/db/schema.sql for reference / future migration tooling.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ingestions (
    id                  TEXT PRIMARY KEY,
    source              TEXT NOT NULL,
    sender              TEXT NOT NULL,
    thread_id           TEXT NOT NULL,
    text                TEXT NOT NULL,
    attachments_json    TEXT NOT NULL DEFAULT '[]',
    timestamp           TEXT NOT NULL,
    received_at         TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'raw',
    original_text_hash  TEXT NOT NULL,
    inbox_path          TEXT NOT NULL,
    thread_path         TEXT NOT NULL,
    person_path         TEXT NOT NULL,
    triage_json         TEXT
);

CREATE INDEX IF NOT EXISTS ix_ingestions_status      ON ingestions(status);
CREATE INDEX IF NOT EXISTS ix_ingestions_thread      ON ingestions(thread_id);
CREATE INDEX IF NOT EXISTS ix_ingestions_received_at ON ingestions(received_at);
CREATE INDEX IF NOT EXISTS ix_ingestions_hash        ON ingestions(original_text_hash);

CREATE TABLE IF NOT EXISTS notes (
    path             TEXT PRIMARY KEY,
    title            TEXT,
    tags_json        TEXT NOT NULL DEFAULT '[]',
    aliases_json     TEXT NOT NULL DEFAULT '[]',
    headings_json    TEXT NOT NULL DEFAULT '[]',
    links_json       TEXT NOT NULL DEFAULT '[]',
    frontmatter_json TEXT NOT NULL DEFAULT '{}',
    body_hash        TEXT NOT NULL,
    indexed_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_notes_title ON notes(title);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path UNINDEXED,
    title,
    body,
    tags
);

CREATE TABLE IF NOT EXISTS agent_actions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    agent     TEXT NOT NULL,
    tool      TEXT NOT NULL,
    args_json TEXT NOT NULL,
    dry_run   INTEGER NOT NULL DEFAULT 0,
    ok        INTEGER NOT NULL,
    error     TEXT,
    summary   TEXT
);

CREATE INDEX IF NOT EXISTS ix_agent_actions_ts ON agent_actions(ts);
`;
