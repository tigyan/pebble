# Pebble — iMessage → Obsidian AI Vault Aggregator

Send a message to yourself. It becomes structured knowledge inside an Obsidian vault.
Pebble accepts inbound messages from an iMessage bridge (or any provider via an
adapter), writes them to plain Markdown, mirrors them in a local SQLite index,
and lets AI agents triage, link, and organize the result — without ever
overwriting your notes.

> **Status:** MVP. Webhook ingestion + vault writer + SQLite/FTS5 + heuristic
> triage + agent tool surface + CLI + integration test all green.
> AI providers (Anthropic, OpenAI, Claude Code, Codex) plug in behind a single
> `TriageProvider` interface; only the `mock` heuristic provider ships today.

## Why

iMessage is the lowest-friction capture surface most people already use, but
its content is locked away in proprietary databases. Pebble treats inbound
messages as a stream of structured knowledge events and lets AI agents file
them into a normal Obsidian vault — provider-agnostic, append-only, and
inspectable from your editor at every step.

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# edit PEBBLE_VAULT_PATH and PEBBLE_INGEST_SECRET (≥ 16 chars recommended)

# 3. Initialize vault layout + DB
npm run cli -- init

# 4. Verify
npm run cli -- doctor

# 5. Run the dev server
npm run dev
# → http://127.0.0.1:8787
```

### Send a message

```bash
curl -X POST http://127.0.0.1:8787/ingest \
  -H "content-type: application/json" \
  -H "x-pebble-token: $PEBBLE_INGEST_SECRET" \
  -d '{
    "source": "manual",
    "sender": "self",
    "thread_id": "self",
    "text": "Remind me to renew the domain tomorrow #todo",
    "timestamp": "2026-05-02T09:00:00.000Z"
  }'
```

### Or via the CLI

```bash
npm run cli -- ingest --text "Idea: pebble could auto-summarize threads"
npm run cli -- triage --limit 10 --file    # classify, then file into typed home
npm run cli -- file                          # file all already-triaged items
npm run cli -- index
npm run cli -- search "renew"
npm run cli -- agent --dry-run
```

### Dashboard

```bash
npm run cli -- dashboard       # boots the server and prints the URL
# → http://127.0.0.1:8787/dashboard
```

Open it in your browser, paste your `PEBBLE_INGEST_SECRET` once (the dashboard
keeps it in `localStorage` on that device only), and you get:

- **Inbox** — recent ingestions with status pills (`raw` / `triaged` / `filed`),
  click any row to expand. Buttons trigger triage on demand, file into the
  suggested folder, edit the folder before filing, or re-triage.
- **Search** — vault search backed by SQLite FTS5.
- **Send** — manual capture form that POSTs to `/ingest` (useful when you
  don't have an iMessage bridge wired up yet).

The dashboard is a single static HTML page served from
`src/server/dashboard.ts` — no framework, no CDN, no telemetry.

#### Settings

The **Settings** view writes to `<vault>/_System/settings.json` and overlays
your `.env`. From the UI you can:

- pick the active triage provider (`mock` / `claude-code` / `codex` / reserved
  API slots) — overrides `PEBBLE_TRIAGE_PROVIDER` per-vault;
- set per-type default folders that override `triage.suggested_folder` when
  filing without an explicit folder (e.g. send every `task` to `Tasks/Inbox`).

Vault path and ingest secret stay env-only by design (changing them mid-flight
is too risky and the secret should never round-trip through the UI).

#### Browser bookmarklet

The Settings view also generates a one-click capture bookmarklet for your
bookmarks bar. On any page it grabs the current selection (or the page title +
URL) and opens the dashboard at `#capture=<encoded>`. The dashboard reads the
hash, switches to the **Send** view, and prefills the textarea — no CORS, no
extra API key, just a same-origin POST to `/ingest` that you confirm with one
click.

#### Reject / dismiss

Each row in the inbox now has a **Reject** action that flips the ingestion to
the new `rejected` status (`POST /api/ingestions/:id/reject`). Filing is
blocked once an item is rejected; rejecting an already-filed item is a 409.

## Subscription mode vs API key

Pebble is **subscription-first**: by default it drives your already-logged-in
[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) or
[Codex](https://github.com/openai/codex) CLI as a subprocess and uses their
auth — no API key in `.env`, no per-token billing. API-key providers
(`anthropic`, `openai`) are reserved slots and currently throw.

```bash
# .env
PEBBLE_TRIAGE_PROVIDER=claude-code        # or "codex" or "mock"
PEBBLE_CLAUDE_CODE_BIN=/usr/local/bin/claude   # optional, defaults to "claude" on PATH
PEBBLE_CODEX_BIN=/usr/local/bin/codex          # optional, defaults to "codex"
```

How it works under the hood (`src/triage/cli-provider.ts`):

1. Pebble renders a stable triage prompt asking for one JSON object that
   matches `TriageResultSchema`.
2. The prompt is fed to the CLI **via stdin** (no shell quoting, no
   arg-length limits).
3. stdout is parsed (handles `claude --output-format json` envelopes and
   noisy outputs with fenced code blocks).
4. The JSON is re-validated against the Zod schema before anything touches
   the vault — the model never gets to define the shape of your data.

If neither subscription is set up, set `PEBBLE_TRIAGE_PROVIDER=mock` and
Pebble will use a built-in heuristic classifier — useful for development
and offline use.

## Vault layout (Obsidian-compatible)

```
<vault>/
├── Inbox/
│   └── 2026-05-02.md            # daily inbox, append-only
├── Sources/
│   └── iMessage/
│       └── thread-A.md          # one note per thread, with frontmatter
├── People/
│   └── +15551234567.md          # one note per sender, with mention list
└── _System/
    ├── ingestion-log.jsonl      # append-only log of every ingest
    ├── agent-actions.jsonl      # append-only log of every agent tool call
    ├── patches/                 # reversible diffs + backups for non-append edits
    └── pebble.sqlite            # local FTS5 index + agent-action mirror
```

Plain Markdown, YAML frontmatter, `[[wikilinks]]`, `#tags` — Obsidian opens it as-is.

## Provider adapters

Pebble ships with four ingestion adapters; the `/ingest` endpoint auto-detects
which one matches based on headers + body shape:

| Adapter        | What it accepts                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `bluebubbles`  | [BlueBubbles](https://bluebubbles.app) webhook payload (`{ type, data: { guid, text, ... } }`)   |
| `sendblue`     | [Sendblue](https://docs.sendblue.com) / Texting Blue inbound webhook                              |
| `shortcuts`    | Apple Shortcuts → POST JSON (also catches `User-Agent: Shortcuts/*`, `X-Shortcut-Name`)           |
| `manual`       | Canonical `IngestPayload` shape — used by the CLI and as a catch-all fallback                     |

Adding a new adapter is a 30-line file in `src/adapters/`; see `bluebubbles.ts`.

## AI triage

Each message gets a structured triage result that **must** parse against
`TriageResultSchema` (Zod):

```ts
{
  type: "task" | "idea" | "meeting_note" | "contact" | "project_note" |
        "reference" | "question" | "journal" | "finance" | "travel" |
        "media" | "other",
  urgency: "none" | "low" | "medium" | "high",
  suggested_folder: string,
  suggested_tags: string[],
  suggested_backlinks: string[],
  is_task: boolean,
  duplicate_of: string | null,
  agent_confidence: number,         // 0..1
  rationale?: string
}
```

The MVP ships a heuristic `mock` provider (no network, no key). Real providers
plug in behind the `TriageProvider` interface in `src/triage/classifier.ts`:

- `anthropic` — Claude API (Opus/Sonnet/Haiku)
- `openai` — OpenAI / Responses API
- `claude-code` — drives a Claude Code CLI binary as a sub-process agent
- `codex` — drives Codex CLI similarly
- local models — same interface, different transport

Set `PEBBLE_TRIAGE_PROVIDER` in `.env` and add the corresponding API key.

## Agent workspace

Agents do **not** get arbitrary filesystem access. They get a fixed tool surface
(`src/agent/tools.ts`):

```
read_note(path)
append_to_note(path, markdown)
create_note(path, markdown)
propose_patch(path, new_content, reason)   # writes a backup + diff under _System/patches
search_vault(query, limit?)
list_recent_ingestions(limit?)
mark_ingestion_status(id, status)
```

Every tool call is:
1. Validated to keep paths inside the vault.
2. Logged to `_System/agent-actions.jsonl` and to the SQLite `agent_actions` table.
3. Honors `--dry-run` mode (CLI) / `dryRun: true` (programmatic).

## Security & privacy

- The vault is treated as private personal knowledge.
- **No telemetry.** Pebble itself sends nothing outbound except to the provider you configure.
- API keys are loaded from `.env` (never committed) — keychain integration is on the roadmap.
- `/ingest` requires `X-Pebble-Token` matching `PEBBLE_INGEST_SECRET` (constant-time compare).
- Attachments are referenced by URI/local path; large blobs are not auto-sent to models.
- Vault writes are append-only by default; any non-append edit goes through
  `propose_patch`, which writes a `*.before.md` backup and a `*.diff` header file.

## Testing

```bash
npm test
```

Includes unit tests (adapters, writer, triage schema) plus an end-to-end
integration test (`tests/integration/ingest.test.ts`):
**HTTP webhook → inbox markdown → SQLite row → triage JSON → updated status**.

## Configuration reference

See [`.env.example`](./.env.example) for the full list. Required:

- `PEBBLE_VAULT_PATH` — absolute path to your Obsidian vault
- `PEBBLE_INGEST_SECRET` — webhook bearer token (≥ 8 chars enforced)

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full diagram and component
boundaries, and [`ROADMAP.md`](./ROADMAP.md) for what's next and known
limitations around iMessage providers.
