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

- [ ] Background worker that runs triage + filing on a schedule.
- [ ] Optional embeddings (`note_embeddings` table): local model + API providers behind one interface.
- [ ] Vector + FTS hybrid search.
- [ ] Subscription-aware agent runner: budget per user, model selection, rate limiting.

## Sprint 4 — hardening

- [ ] OS keychain integration for secrets (macOS Keychain, Linux libsecret).
- [ ] Optional cloud sync of `_System/` JSONL logs (encrypted).
- [ ] CI: typecheck + tests + adapter contract tests on every PR.
- [ ] Schema migrations (`drizzle-kit` or hand-rolled).

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
