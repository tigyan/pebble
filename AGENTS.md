# AGENTS.md — guidance for AI agents working in this repo

This file is the contract any AI agent (Claude Code, Codex, OpenAI Agents,
custom harness) should follow when modifying Pebble. It's deliberately short:
read it once at the start of a session and keep it in mind.

## What Pebble is

iMessage-to-Obsidian AI Vault Aggregator. Inbound messages → adapter →
canonical `IngestPayload` → append-only writes to a Markdown vault + SQLite
mirror → AI triage → agents file/link the result. The vault is authoritative;
SQLite is a regenerable cache.

See `README.md`, `ARCHITECTURE.md`, `ROADMAP.md` for the user-facing picture.

## Stack

- TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- Node 20+, ESM, `tsx` for dev
- Fastify · Zod · better-sqlite3 (FTS5) · gray-matter · commander
- Vitest

## Invariants — DO NOT VIOLATE

1. **Append-only vault writes.** Never overwrite a Markdown body. New content
   goes through `appendFile` or `writeIngestion`. Any non-append edit MUST go
   through `proposePatch` (writes `*.before.md` backup + `*.diff` under
   `_System/patches/`).
2. **Schema is the contract.** Anything crossing a boundary (HTTP payload,
   triage output, agent action) is parsed by a Zod schema in `src/types/`.
   If you add a field, update the schema first.
3. **Vault is authoritative.** SQLite is a cache — never store data only in
   the DB. Recovery story is "delete the .sqlite and re-run `pebble index`".
4. **Provider-agnostic.** iMessage is one adapter among many. Do not hardcode
   provider-specific logic outside `src/adapters/`. The canonical contract is
   `IngestPayload`.
5. **Agents touch the FS only via `AgentTools`.** No `fs.writeFile` directly.
   Every tool call is logged to `_System/agent-actions.jsonl` and the
   `agent_actions` SQLite table. `dryRun` must be honored.
6. **No telemetry.** Pebble sends nothing outbound except to the configured
   AI provider. Do not add analytics, error reporting, or usage pings.
7. **Secrets stay in `.env`.** `PEBBLE_INGEST_SECRET`, API keys, etc. — never
   commit, never log, never echo into Markdown. The `/ingest` token compare
   is constant-time; keep it that way.
8. **Path safety.** Agent-supplied paths are resolved relative to
   `vaultPath` and rejected if they escape it. See `safePath()` in
   `src/agent/tools.ts`.
9. **Settings layer.** User-editable settings live in
   `<vault>/_System/settings.json` and overlay `.env` (file wins). Only fields
   in `EditableSettingsSchema` are settable from the UI — never accept the
   ingest secret or vault path through `/api/settings`.
10. **`rejected` is terminal-ish.** Once an ingestion is `rejected`, filing it
    is a 409. Rejecting a `filed` ingestion is also a 409. Don't quietly
    flip a rejected item back to `raw` without an explicit user action.
11. **Worker is opt-in and settings-driven.** `settings.worker.enabled` gates
    the timer; `auto_file` gates filing (off by default — triage-only is the
    safe default). The worker reads settings on every tick, so config changes
    don't require a restart. `PUT /api/settings` calls `worker.reconfigure()`
    so toggling from the UI is immediate. Tests pass `worker: false` to
    `buildServer` to avoid leaking timers.
12. **Budget is enforced before classify().** Both the worker and
    `runAgentOnce()` consult `BudgetTracker.ensureAvailable(model, limit)`
    *before* each model call and `RateLimiter.acquire()` to throttle. Budget
    counters are persisted to SQLite (`agent_budget(day, model, calls,
    tokens)`) so a restart doesn't reset the daily cap. `daily_call_budget=0`
    and `rate_limit_per_min=0` mean unlimited.

## Where things live

| Concern                        | File                                          |
| ------------------------------ | --------------------------------------------- |
| Types & Zod schemas            | `src/types/index.ts`                          |
| Config (env → typed config)    | `src/config.ts`                               |
| Provider adapters              | `src/adapters/{bluebubbles,sendblue,shortcuts,manual}.ts` |
| Adapter selection              | `src/adapters/index.ts`                       |
| HTTP server                    | `src/server/{server,index}.ts`                |
| Dashboard HTML (single page)   | `src/server/dashboard.ts`                     |
| Ingestion pipeline             | `src/ingest/pipeline.ts`                      |
| Vault writer (append-only)     | `src/vault/writer.ts`                         |
| Vault paths / frontmatter      | `src/vault/{paths,frontmatter}.ts`            |
| SQLite client + schema         | `src/db/{client,schema}.ts`                   |
| Vault indexer                  | `src/indexer/index.ts`                        |
| Triage classifier (interface)  | `src/triage/classifier.ts`                    |
| Triage prompt + JSON extraction| `src/triage/prompt.ts`                        |
| CLI subprocess provider        | `src/triage/cli-provider.ts`                  |
| API-key providers (Anthropic/OpenAI) | `src/triage/api-provider.ts`            |
| Triage runner (batch)          | `src/triage/runner.ts`                        |
| Near-duplicate detector        | `src/ingest/near-dup.ts`                      |
| Attachment materializer        | `src/ingest/attachments.ts`                   |
| Filing executor (typed-home)   | `src/filing/executor.ts`                      |
| Settings overlay (file → env)  | `src/settings/store.ts`                       |
| Embedding providers + helpers  | `src/embeddings/provider.ts`                  |
| Embedding runner (vault → DB)  | `src/embeddings/runner.ts`                    |
| Hybrid FTS+vector search       | `src/embeddings/search.ts`                    |
| Background worker              | `src/worker/index.ts`                         |
| Agent budget + rate limiter    | `src/agent/budget.ts`                         |
| Agent runner (one-shot)        | `src/agent/runner.ts`                         |
| Agent tools                    | `src/agent/tools.ts`                          |
| CLI                            | `src/cli/index.ts`                            |
| Tests                          | `tests/{unit,integration}/*.test.ts`          |
| Fixtures                       | `tests/fixtures/*.json`                       |

## Common workflows

### Add a new ingestion provider

1. Create `src/adapters/<name>.ts` exporting an `IngestionAdapter`.
2. Implement `matches(headers, body)` (cheap sniff) and `normalize(body)`
   returning a value that parses against `IngestPayloadSchema`.
3. Register it in `src/adapters/index.ts` *before* `manualAdapter`
   (manual is the catch-all and must remain last).
4. Add a fixture under `tests/fixtures/` and a unit test in
   `tests/unit/adapters.test.ts`.

### Add a new AI triage provider

1. Implement `TriageProvider` in `src/triage/classifier.ts`.
2. Wire it into `getProvider(name)`.
3. Output **must** parse against `TriageResultSchema`. Re-parse the model
   output yourself before returning — never trust the model's formatting.
4. Document the env var(s) in `.env.example`.

### Add a new agent tool

1. Add the method to `AgentTools` in `src/agent/tools.ts`.
2. Add the tool name to the `AgentAction.tool` enum in `src/types/index.ts`.
3. Honor `dryRun`. Always call `recordAction` (success and failure).
4. If the tool mutates a file body, route through `proposePatch`.

### Change the SQLite schema

1. Edit `src/db/schema.ts` (the inline `SCHEMA_SQL` string).
2. Edit `src/db/schema.sql` to keep the reference copy in sync.
3. The MVP relies on `CREATE TABLE IF NOT EXISTS` — for breaking changes,
   add a migration step and document the recovery path in `ROADMAP.md`.

## Build / test commands

```bash
npm install
npm run typecheck       # strict tsc, no emit
npm test                # vitest, all suites
npm run build           # tsc → dist/
npm run dev             # tsx watch src/server/index.ts
npm run cli -- <cmd>    # CLI in dev (no build needed)
```

The integration test (`tests/integration/ingest.test.ts`) is the canonical
end-to-end smoke: webhook → markdown → SQLite → triage → status. If you change
any of those layers, that test must still pass.

## Style

- Prefer editing existing files to creating new ones.
- Keep modules small and single-purpose; the layout above is load-bearing.
- No comments that restate the code. Add a `// why:` comment only for
  non-obvious invariants (append-only, constant-time compare, path-escape check).
- No new top-level dependencies without a reason; the dep list is intentionally short.
- Type everything. `any` is a smell; if you need it, leave a comment explaining why.

## Things to refuse / push back on

- "Just overwrite the inbox file" → no. Use `appendFile` or `proposePatch`.
- "Drop and recreate the DB on schema change" → only with explicit user opt-in;
  the vault is authoritative, but agent-action history is too.
- "Send the full message to OpenAI for embeddings by default" → off by default.
  Embeddings are opt-in, and attachments are referenced not auto-uploaded.
- "Add telemetry to count active users" → no. Pebble is a personal-knowledge tool.
