-- Pebble local state. Authoritative data lives in the vault; this DB is a cache
-- for fast querying and an append-only log of agent actions.
--
-- This file is a reference mirror of `src/db/schema.ts` (the inline string used
-- at runtime). Versioned migrations live in `src/db/migrations.ts` and are
-- tracked via `PRAGMA user_version`. When you change the baseline here, also
-- mirror it in schema.ts and append a migration so existing DBs catch up.

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
    path        TEXT PRIMARY KEY,
    title       TEXT,
    tags_json   TEXT NOT NULL DEFAULT '[]',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    headings_json TEXT NOT NULL DEFAULT '[]',
    links_json  TEXT NOT NULL DEFAULT '[]',
    frontmatter_json TEXT NOT NULL DEFAULT '{}',
    body_hash   TEXT NOT NULL,
    indexed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_notes_title ON notes(title);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path UNINDEXED,
    title,
    body,
    tags
);

CREATE TABLE IF NOT EXISTS agent_actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    agent       TEXT NOT NULL,
    tool        TEXT NOT NULL,
    args_json   TEXT NOT NULL,
    dry_run     INTEGER NOT NULL DEFAULT 0,
    ok          INTEGER NOT NULL,
    error       TEXT,
    summary     TEXT
);

CREATE INDEX IF NOT EXISTS ix_agent_actions_ts ON agent_actions(ts);

-- Vector embeddings keyed by (note path, model). One row per note per model.
-- Re-embedding with a new model adds a row instead of replacing the old one,
-- so multi-model setups don't fight. content_hash lets the embedder skip
-- already-embedded notes whose body hasn't changed.
CREATE TABLE IF NOT EXISTS note_embeddings (
    path         TEXT NOT NULL,
    model        TEXT NOT NULL,
    dim          INTEGER NOT NULL,
    vec_blob     BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    indexed_at   TEXT NOT NULL,
    PRIMARY KEY (path, model)
);

CREATE INDEX IF NOT EXISTS ix_note_embeddings_model ON note_embeddings(model);

-- Daily counters per (day, model). Survives restarts so a crash mid-day
-- doesn't reset the budget. Unlimited budgets bypass these rows entirely.
CREATE TABLE IF NOT EXISTS agent_budget (
    day    TEXT NOT NULL,
    model  TEXT NOT NULL,
    calls  INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, model)
);

-- Open questions the Librarian agent is asking the user (typically via iMessage).
-- Resolution: an inbound message in the same thread_id while status='open' is
-- routed to the clarification handler instead of being filed as a new ingestion.
CREATE TABLE IF NOT EXISTS clarifications (
    id           TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    source_kind  TEXT NOT NULL,             -- 'do_command' | 'ingestion'
    ingestion_id TEXT,                      -- nullable; ties back to a raw item
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
