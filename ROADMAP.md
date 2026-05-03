# Pebble — MVP roadmap

## What ships in MVP (this commit)

- [x] `/ingest` webhook with shared-secret auth (constant-time compare)
- [x] Provider adapters: BlueBubbles, Sendblue/Texting Blue, Apple Shortcuts, manual
- [x] Append-only vault writer (Inbox / Sources / People / _System)
- [x] SQLite mirror with FTS5 full-text search
- [x] Heuristic triage classifier (`mock`) emitting Zod-validated `TriageResult`
- [x] Vault indexer (titles, tags, aliases, headings, wikilinks)
- [x] Agent tool surface (read/append/create/propose_patch/search/list/mark) with dry-run + JSONL audit log
- [x] CLI: `init`, `ingest`, `triage`, `index`, `search`, `agent`, `doctor`
- [x] Integration test: webhook → markdown → SQLite → triage → status

## Sprint 1 — make it daily-useful

- [x] Subscription-mode triage providers (CLI subprocess, login-based auth)
  - [x] `claude-code` CLI driver
  - [x] `codex` CLI driver
  - [x] Schema-validated output extraction (handles JSON envelopes + fenced code)
- [x] Filing executor: take a `TriageResult` and write a typed-home note in the
      suggested folder, append a `[[wikilink]]` from the source thread,
      mark ingestion `filed`.
- [x] API-key triage providers (kept as reserved fallback; subscription mode is primary)
  - [x] Anthropic Messages API (`claude-haiku-4-5` default; `claude-sonnet-4-6`,
        `claude-opus-4-7` selectable via `PEBBLE_ANTHROPIC_MODEL`)
  - [x] OpenAI Responses API (`gpt-5-mini` default, override via
        `PEBBLE_OPENAI_MODEL`)
- [x] Duplicate detection beyond exact-hash: shingled (k=3) Jaccard near-dup
      across the most recent 200 ingestions. (LLM tiebreaker hook deferred to
      Sprint 3 — the score is already surfaced for callers.)
- [x] Attachment ingest: `materializeAttachments` copies remote / data: /
      out-of-vault paths into `_System/attachments/`, rewrites the URI to
      a vault-relative path. Privacy invariant: attachments are still never
      auto-uploaded to model providers.

## Sprint 2 — UI

- [x] Fastify-served dashboard (single-file vanilla HTML/CSS/JS, no framework)
  - [x] Recent ingestions feed with triage status pills
  - [x] Approve / edit suggested filing (folder override on the fly)
  - [x] Vault search box backed by FTS5
  - [x] In-page "Send" form that POSTs to `/ingest`
  - [x] Sanitized `/api/config` (never echoes the ingest secret)
  - [x] Tightened auth: all `/api/*`, `/recent`, `/search` require the token
  - [x] Settings panel for editing triage provider + per-type default folders
        (vault path stays env-only — mid-flight changes are too risky)
- [x] Reject / dismiss action on triage suggestions (`rejected` ingest status).
- [x] Browser bookmarklet that captures the current selection
      (capture-via-hash → opens the dashboard same-origin, prefills the Send view).

## Sprint 3 — agents & embeddings

- [x] Background worker that runs triage + (optional) auto-filing on a
      configurable schedule. Settings-driven (enabled / interval_ms /
      auto_file / batch); status surfaced via `GET /api/worker`; manual
      one-shot via `POST /api/worker/run`. Tests cover triage, auto-file,
      reconfigure, and error capture.
- [x] Optional embeddings (`note_embeddings` table): one interface
      (`EmbeddingProvider`), `mock` (offline, deterministic, hash-based) and
      `openai` (`/v1/embeddings`) implementations. Vectors stored as Float32
      BLOBs keyed by `(path, model)`. CLI: `pebble embed [--provider …]
      [--force] [--limit n]`. Re-embedding is content-hash gated.
- [x] Vector + FTS hybrid search via reciprocal-rank fusion. CLI:
      `pebble search --hybrid <q>`. HTTP: `GET /api/search?q=…&hybrid=true`.
      Falls back to FTS-only when no embeddings exist for the model.
- [x] Subscription-aware agent runner with budgets + rate limiting:
      `src/agent/{budget,runner}.ts`. Persistent daily call budget keyed by
      `(day, model)`, in-memory token-bucket rate limiter. Worker now consults
      both before each tick. Endpoints: `GET /api/agent`, `POST /api/agent/run`.
      Budget snapshot is also surfaced on `GET /api/worker`. Settings expose
      `agent.daily_call_budget`, `agent.rate_limit_per_min`, `agent.burst`,
      `agent.triage_model`.

## Sprint 4 — hardening

- [x] OS keychain integration for secrets (macOS Keychain, Linux libsecret).
      `src/secrets/{keychain,source}.ts` add a `SecretSource` abstraction with
      `env`, `keychain`, and `auto` modes (controlled by
      `PEBBLE_SECRETS_SOURCE`). The macOS backend shells out to `security`
      and the Linux backend to `secret-tool`. `loadConfig` resolves
      `PEBBLE_INGEST_SECRET` via the source; `getProvider` /
      `getEmbeddingProvider` resolve API keys the same way. CLI:
      `pebble secrets set|get|unset <KEY>` (set reads from stdin; get prints
      only with `--show`).
- [ ] Optional cloud sync of `_System/` JSONL logs (encrypted).
- [x] CI: typecheck + tests + adapter contract tests on every PR.
      `.github/workflows/ci.yml` runs on push-to-main and PRs to main:
      `npm ci`, `npm run typecheck`, `npm test` on Ubuntu / Node 22.
      `tests/unit/adapter-contract.test.ts` enforces invariants for every
      registered adapter (unique name, manual-is-last, schema-valid output,
      no cross-fixture false positives).
- [x] Schema migrations (hand-rolled, no extra deps).
      `src/db/migrations.ts` runs the baseline schema (idempotent) plus any
      pending `Migration` entries in a single transaction, tracking version
      via `PRAGMA user_version`. `pebble doctor` surfaces the DB version
      and flags drift. Migrations are append-only — never edit a shipped
      one. v1 ships with zero migrations registered (baseline only).

---

## Known limitations & open questions

### iMessage providers

There is no first-party Apple API for receiving iMessages on a server. Every
viable bridge has tradeoffs:

- **BlueBubbles** — free, OSS, but requires an always-on Mac running the
  BlueBubbles server app. Best for self-hosters.
- **Sendblue / Texting Blue** — paid SaaS that proxies via TestFlight / Apple
  Business Chat. Reliable and easy to set up but costs per-message and
  introduces a third party.
- **Apple Shortcuts → HTTPS** — works on iOS without extra hardware but is
  pull-style: the user (or an Automation) has to *trigger* the Shortcut.
  Best for "send-to-self" flows where the user explicitly captures.
- **Mac Messages.db scraping** — possible but fragile, breaks on macOS upgrades,
  and is outside the MVP scope. We may add it as a fifth adapter for
  read-only historical import.

Pebble is deliberately provider-agnostic: each adapter is ~30 lines and the
canonical `IngestPayload` is the single contract.

### AI provider extension points

The MVP intentionally ships with a heuristic classifier so the system is
useful without any API key. Slots for real providers (`anthropic`, `openai`,
`claude-code`, `codex`, local) live in `src/triage/classifier.ts` and follow
one interface:

```ts
interface TriageProvider {
  name: string;
  classify(record: IngestRecord): Promise<TriageResult>; // must satisfy TriageResultSchema
}
```

This lets us swap models per-user (subscription tier), per-message-type, or
even per-attempt in a self-consistency loop, without touching the rest of the
pipeline.

### Privacy

Anything sent to a model leaves the machine. We default to the local heuristic
provider; an explicit `PEBBLE_TRIAGE_PROVIDER` change is required to send
content to a remote API. Attachments are stored locally and referenced by path —
they are never uploaded automatically.
