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

For a real iMessage source you have two recommended options:

- **Pebble Bridge** (local-first, single-user, no cloud relay) — a sibling
  repo at `~/Projects/Pebble Bridge`. Run the bridge on your Mac, then start
  its bundled forwarder (`scripts/forward-to-pebble.ts`) to stream
  `message.created` events into Pebble's `/ingest`. The matching
  `pebble-bridge` adapter is already wired in. See
  [`docs/DEPLOY-PEBBLE-BRIDGE.md`](./docs/DEPLOY-PEBBLE-BRIDGE.md).
- **BlueBubbles Server** (Mac → tunnel → Pebble) — works well if you already
  run BlueBubbles or want the broader ecosystem. End-to-end recipe in
  [`docs/DEPLOY-BLUEBUBBLES.md`](./docs/DEPLOY-BLUEBUBBLES.md).

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
npm run cli -- embed                         # vectorize every indexed note
npm run cli -- search "renew"
npm run cli -- search --hybrid "renew"      # FTS + cosine, rank-fused
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

#### Background worker

The Settings view also has a **Background worker** section. Toggle it on and
the server periodically (default every 60 s, configurable) takes the next
batch of `raw` ingestions, runs them through the active triage provider, and
optionally files the result into its typed home (off by default). Status
surfaces via `GET /api/worker` and you can also force a one-shot run with
`POST /api/worker/run`. Settings changes apply immediately — no restart.

#### Agent budgets

Below that, **Agent budgets** caps how many model calls Pebble can make in
a single UTC day per model, plus an in-memory token-bucket rate limit
(`rate_limit_per_min`, with a `burst` parameter). Both the worker and
`POST /api/agent/run` enforce them; counters live in `agent_budget(day,
model, …)` so the cap survives restarts. Set either to `0` for unlimited.
Status (`{ model, used, limit, remaining }`) is exposed via `GET /api/agent`
and is also embedded in `GET /api/worker`.

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
auth — no API key in `.env`, no per-token billing.

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

API-key mode is also available as a fallback for headless deployments where
no subscription CLI is logged in:

```bash
# .env
PEBBLE_TRIAGE_PROVIDER=anthropic
PEBBLE_ANTHROPIC_API_KEY=sk-ant-...
PEBBLE_ANTHROPIC_MODEL=claude-haiku-4-5   # or claude-sonnet-4-6, claude-opus-4-7

# or
PEBBLE_TRIAGE_PROVIDER=openai
PEBBLE_OPENAI_API_KEY=sk-...
PEBBLE_OPENAI_MODEL=gpt-5-mini
```

Both API providers re-validate the model output through `TriageResultSchema`
before anything touches the vault, just like the CLI subprocess providers.

If neither subscription nor API key is set up, set `PEBBLE_TRIAGE_PROVIDER=mock`
and Pebble will use a built-in heuristic classifier — useful for development
and offline use.

## Duplicate detection

Inbound messages get two layers of dedup, both surfaced on the `/ingest`
response so the dashboard / CLI can warn:

- `duplicate_of` — exact SHA-256 hash match against the original text.
- `near_duplicate_of` — `{ id, score }` from word-shingle (k=3) Jaccard
  similarity scanned against the most recent 200 ingestions. Threshold
  defaults to 0.6.

Pure heuristic — no model call required. The score is exposed so future
agents can use an LLM tiebreaker on the borderline band.

## Attachments

Whenever a payload arrives with `attachments[]` whose URIs are remote
(`http(s)://`), inline (`data:`), or absolute paths outside the vault,
Pebble copies them into `<vault>/_System/attachments/<id>-<filename>` and
rewrites the URI to a vault-relative path **before** anything is written
to Markdown. Filenames are sanitized; size is capped at 32 MiB per file.

Already-vault-internal paths and URI schemes Pebble doesn't recognize are
left untouched. **Attachments are never auto-uploaded to model providers** —
they are referenced by path only. This is a hard invariant.

For BlueBubbles specifically, the webhook only carries metadata (guid,
mime, filename) — not bytes. When `PEBBLE_BLUEBUBBLES_URL` and the
companion password (`PEBBLE_BLUEBUBBLES_PASSWORD`, ideally via the
keychain) are set, Pebble fetches the binary at ingest time through the
BB Server's `/api/v1/attachment/<guid>/download` endpoint and materializes
it under `_System/attachments/`. If the URL is unset, attachment URIs
land as `bluebubbles://attachment/<guid>` placeholders that can be
resolved later — the markdown stays valid in either case.

## Embeddings & hybrid search

Pebble can vectorize every note in the vault and blend lexical (FTS5) and
semantic (cosine over note embeddings) hits via reciprocal-rank fusion.

```bash
npm run cli -- embed                       # uses the mock provider (offline)
npm run cli -- embed --provider openai     # uses PEBBLE_OPENAI_EMBEDDING_MODEL
npm run cli -- search --hybrid "renew"    # rank-fuses FTS + vector
```

```bash
curl -H "x-pebble-token: $PEBBLE_INGEST_SECRET" \
  "http://127.0.0.1:8787/api/search?q=renew&hybrid=true&provider=mock"
```

Vectors are stored in `note_embeddings(path, model, dim, vec_blob, …)` with
a content-hash gate so re-running `pebble embed` is a no-op when nothing
changed. Re-embedding with a different model adds a row instead of replacing
— multi-model setups don't fight. Hybrid search transparently falls back to
FTS-only when no embeddings exist for the requested model.

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

Pebble ships with five ingestion adapters; the `/ingest` endpoint auto-detects
which one matches based on headers + body shape:

| Adapter         | What it accepts                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `pebble-bridge` | [Pebble Bridge](./docs/DEPLOY-PEBBLE-BRIDGE.md) `message.created` envelopes (local-first)        |
| `bluebubbles`   | [BlueBubbles](https://bluebubbles.app) webhook payload (`{ type, data: { guid, text, ... } }`)   |
| `sendblue`      | [Sendblue](https://docs.sendblue.com) / Texting Blue inbound webhook                              |
| `shortcuts`     | Apple Shortcuts → POST JSON (also catches `User-Agent: Shortcuts/*`, `X-Shortcut-Name`)           |
| `manual`        | Canonical `IngestPayload` shape — used by the CLI and as a catch-all fallback                     |

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
- Secrets resolve through `SecretSource` (`src/secrets/source.ts`).
  `PEBBLE_SECRETS_SOURCE` controls precedence: `env` (default) reads only
  `.env` / `process.env`; `keychain` reads only the OS keychain
  (macOS Keychain via `security`, Linux libsecret via `secret-tool`);
  `auto` tries the keychain first and falls back to env. Seed values with
  `pebble secrets set <KEY>` (reads stdin so the value never appears on
  the command line). `pebble secrets get <KEY>` confirms presence; pass
  `--show` to print the value. Service name is `pebble`; account is the
  env-var key (e.g. `PEBBLE_INGEST_SECRET`, `PEBBLE_ANTHROPIC_API_KEY`).
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

`npm run cli` and `npm run dev` auto-load `.env` from the repo root via
Node's native `--env-file-if-exists` flag (Node ≥ 22). For one-off invocations
you can also do `node --env-file=.env --import tsx src/cli/index.ts <cmd>`.

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full diagram and component
boundaries, and [`ROADMAP.md`](./ROADMAP.md) for what's next and known
limitations around iMessage providers.
