# Pebble — Roadmap

Backlog of features we'd like to land. Closed sprints (MVP through Sprint 5)
have been pruned — git history has the receipts.

## Recently shipped

- **`/do` commands.** Messages prefixed with `/do …` flip the pipeline from
  "save as a note" to "execute the agent and write the result into the vault".
  Provider-pluggable (`mock` for tests, `claude-code` and `codex` for real
  output), confined inside the vault by `sanitizeTargetPath` + `safePath`,
  and audited via `agent-actions.jsonl`. `Inbox/` is intentionally not
  mirrored for `/do` — only the agent's writes are persisted.
  See `src/agent/command.ts`.
- **Echo suppression for self-chat.** BlueBubbles double-fires
  `new-message` for chat-with-self (outgoing send + iCloud-relay echo).
  `findEchoDuplicate` now suppresses the second arrival on a 60s window
  matched by sender + thread + text + attachment URIs, before any vault
  write. See `src/ingest/pipeline.ts`.
- **Codex CLI ≥0.20 compat.** Dropped the removed `--quiet` flag; replaced
  with `--color never --skip-git-repo-check` so the worker runs from any
  cwd and the JSON extractor isn't fooled by ANSI escapes.
- **Per-contact ingest filter.** `ingest_filter` (off / allowlist / denylist)
  with sender + thread lists, schema-validated overlay, dashboard editor,
  and integration tests.

## Planned / wishlist

### Agent capability

- [ ] **`isFromMe` filter in the BlueBubbles adapter.** Belt-and-braces
      protection against self-chat duplicates: drop payloads where
      `data.isFromMe === true` at the adapter layer, in addition to the
      existing 60s echo suppression in the pipeline. One-line change in
      `src/adapters/bluebubbles.ts`.
- [ ] **Tool-calling loop for `/do`.** Right now `/do` is a single LLM
      call: it picks a target and emits the markdown in one shot. Promote
      it to a loop where the model can call `read_note`, `search_vault`,
      `propose_patch`, etc., so it can read context before writing
      (e.g. "extend the existing list in «Учеба» without duplicates").
      Budget + rate limits already exist in `src/agent/budget.ts`.
- [ ] **`/do` dry-run preview in the dashboard.** Submit a `/do` with
      `?preview=1` to get back the proposed `target_path` + markdown
      without writing, then approve/reject from the UI. Reuses
      `propose_patch` infrastructure.

### Ingestion / dedup

- [ ] **Persistent echo cache for `/do` itself.** Today `/do` skips the
      ingestion log, so the existing echo suppression doesn't catch a
      double-fired `/do`. Either insert a thin "command" row into the DB
      (status=`filed`, body=instruction) or add a small in-memory LRU
      keyed by sender+thread+text.
- [ ] **LLM tiebreaker for near-duplicates.** Score is already surfaced;
      hook into a cheap classifier when Jaccard ∈ [0.6, 0.8] to decide
      "merge / keep both / drop".
- [ ] **Mac Messages.db read-only historical import.** Out-of-MVP fifth
      adapter for backfilling pre-Pebble conversations. Fragile across
      macOS upgrades, so behind an explicit `pebble import messages-db`
      command rather than a webhook.

### UI / DX

- [ ] **Send-tab `/do` autocomplete.** Detect a leading `/` in the
      Send textarea and surface `/do` as a one-tap chip with a hint
      ("Pebble will write the result into a note instead of saving the
      message"). Cuts the discoverability problem.
- [ ] **Patches review pane.** `_System/patches/` already stores reversible
      diffs from `propose_patch`; the dashboard should list pending
      patches with apply / revert buttons rather than requiring a CLI.
- [ ] **Per-thread default folder.** Some senders ("Mom") almost always
      mean Journal; some ("oncall") mean Tasks. Add a thread→folder
      override layered between `default_folders[type]` and the model's
      `suggested_folder`.

### Hardening / ops

- [ ] **Provider-side timeout + retry budget.** Today the CLI provider
      hard-fails on the first non-zero exit. Add a single retry with
      jitter for `claude-code` / `codex` to absorb transient subprocess
      failures, capped by the daily call budget.
- [ ] **`pebble doctor` /do smoke check.** Run a tiny `/do` against the
      mock provider during `doctor` to verify the agent surface is
      writable end-to-end (path sanitization, agent-actions.jsonl,
      vault writability).

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
- **Mac Messages.db scraping** — possible but fragile, breaks on macOS
  upgrades, and is outside the MVP scope. Listed under "Planned" as a
  read-only historical import.

Pebble is deliberately provider-agnostic: each adapter is ~30 lines and the
canonical `IngestPayload` is the single contract.

### AI provider extension points

The MVP ships with a heuristic classifier so the system is useful without
any API key. Slots for real providers (`anthropic`, `openai`, `claude-code`,
`codex`, local) live in `src/triage/classifier.ts` and follow one interface:

```ts
interface TriageProvider {
  name: string;
  classify(record: IngestRecord): Promise<TriageResult>; // must satisfy TriageResultSchema
}
```

`/do` has a parallel interface in `src/agent/command.ts`:

```ts
interface CommandProvider {
  name: string;
  generate(input: { instruction: string; candidates: { path; title }[] }):
    Promise<CommandResult>; // must satisfy CommandResultSchema
}
```

This lets us swap models per-user, per-message-type, or even per-attempt
in a self-consistency loop, without touching the rest of the pipeline.

### Privacy

Anything sent to a model leaves the machine. We default to the local
heuristic provider; an explicit `PEBBLE_TRIAGE_PROVIDER` change is
required to send content to a remote API. Attachments are stored locally
and referenced by path — they are never uploaded automatically.
