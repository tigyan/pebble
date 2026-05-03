# Contributing to Pebble

Thanks for considering a contribution. Pebble is a small, intentionally-tight
codebase: every module is single-purpose, the dependency list is short, and
the vault on disk is treated as user-sacred. Reading
[`AGENTS.md`](./AGENTS.md) before you start is the fastest way to avoid
landing a PR that bounces.

## Ground rules

These are non-negotiable. They're also enforced by tests and code review.

1. **Append-only vault writes.** Never overwrite a Markdown body. Use
   `appendFile` / `writeIngestion` for new content; route any non-append edit
   through `proposePatch` (writes a `*.before.md` backup + `*.diff` under
   `_System/patches/`).
2. **Schema is the contract.** Every cross-boundary value (HTTP payload,
   triage output, agent action) is parsed by a Zod schema in
   `src/types/index.ts`. Update the schema **before** the producer or
   consumer.
3. **Vault is authoritative; SQLite is a cache.** Recovery is "delete
   `pebble.sqlite` and re-run `pebble index`". Don't store data only in the
   DB.
4. **Provider-agnostic.** iMessage is one adapter among many. Provider-specific
   logic lives only inside `src/adapters/<name>.ts`. The canonical contract is
   `IngestPayload`.
5. **Agents touch the FS only via `AgentTools`.** No `fs.writeFile` outside
   that module. Every tool call is logged; `dryRun` must be honored.
6. **No telemetry.** Pebble sends nothing outbound except to the AI provider
   the user explicitly configured. Do not add analytics, error reporting, or
   "phone-home" pings.
7. **Secrets stay in `.env` or the OS keychain.** Read them through
   `SecretSource` (`src/secrets/source.ts`) — never `process.env.X` directly
   outside `src/config.ts`.
8. **Path safety.** `safePath()` in `src/agent/tools.ts` is the only thing
   stopping a malicious agent from writing outside the vault. Don't remove
   or weaken it.
9. **Constant-time token compare.** `safeEqual()` in `src/server/server.ts`
   stays constant-time. Don't replace with `===`.

The full list of invariants is in [`AGENTS.md`](./AGENTS.md).

## Dev environment

```bash
node -v        # ≥ 22
npm install
npm run typecheck
npm test       # 132 tests at the time of writing — should stay 100% green
```

Useful one-shots:

```bash
npm run cli -- doctor                # config + vault + DB sanity check
npm run cli -- ingest --text "..."   # smoke-test the pipeline end-to-end
npm run dev                          # tsx watch HTTP server on :8787
```

## How to plan a change

1. **Find the schema first.** Almost every cross-boundary value is a Zod
   schema in `src/types/index.ts`. If your change adds or modifies a field,
   start there.
2. **Pick the smallest module.** The file map in `AGENTS.md` is load-bearing.
   If you can't tell which file your change belongs in, you may be missing a
   module — ask in the PR description rather than collapsing concerns.
3. **Append, don't overwrite.** Any vault-touching code must go through
   `writeIngestion`, `appendFile`, or `proposePatch`. Bypassing is a bug
   even if a test doesn't catch it.
4. **Honor dry-run.** Any agent-side mutation must check `ctx.dryRun` and
   still call `recordAction`. Tests for new tools should cover both modes.

## Common workflows

### Add a new ingestion provider

1. Create `src/adapters/<name>.ts` exporting an `IngestionAdapter`.
2. Implement `matches(headers, body)` (cheap sniff) and `normalize(body)`
   returning a value that parses against `IngestPayloadSchema`.
3. Register it in `src/adapters/index.ts` **before** `manualAdapter`
   (manual is the catch-all and must remain last).
4. Add a fixture under `tests/fixtures/` and a unit test in
   `tests/unit/adapters.test.ts`. The contract test in
   `tests/unit/adapter-contract.test.ts` will also pick it up.

### Add a new AI triage provider

1. Implement `TriageProvider` in `src/triage/classifier.ts`.
2. Wire it into `getProvider(name, env, secrets)` — resolve any API key
   through `SecretSource`, never `process.env`.
3. Output **must** parse against `TriageResultSchema`. Re-validate the model
   output yourself before returning — never trust formatting.
4. Document the env var(s) in `.env.example`.

### Add a new agent tool

1. Add the method to `AgentTools` in `src/agent/tools.ts`.
2. Add the tool name to the `AgentAction.tool` enum in `src/types/index.ts`.
3. Honor `dryRun`. Always call `recordAction` (success and failure).
4. If the tool mutates a file body, route through `proposePatch`.

### Change the SQLite schema

1. Edit `src/db/schema.ts` (the inline `SCHEMA_SQL` string) — additive only,
   so a fresh DB lands on the latest shape.
2. Mirror the change in `src/db/schema.sql` (reference copy).
3. Append a `Migration` to `MIGRATIONS` in `src/db/migrations.ts` with the
   next `version` number. Migrations are append-only — **never edit a shipped
   one**.
4. Add a unit test in `tests/unit/migrations.test.ts` covering the migration's
   effect on a pre-migration DB shape.

## Style

- Prefer editing existing files to creating new ones.
- Modules stay small and single-purpose; the file map in `AGENTS.md` is
  load-bearing.
- No comments that restate the code. Add a `// why:` comment only for
  non-obvious invariants (append-only, constant-time compare, path-escape
  check).
- No new top-level dependencies without a reason. The dep list is intentionally
  short.
- Type everything. `any` is a smell; if you need it, leave a comment explaining
  why.

## Tests

- The integration test (`tests/integration/ingest.test.ts`) is the canonical
  end-to-end smoke: webhook → markdown → SQLite → triage → status. If your
  change touches any of those layers, make sure it still passes.
- Add unit tests next to the module's siblings under `tests/unit/`.
- Keep test data in `tests/fixtures/`; never check in real personal data.

## PR expectations

A PR is ready to land when:

- [ ] `npm run typecheck` passes (strict, no `any` slipped in).
- [ ] `npm test` is 100% green.
- [ ] If you touched adapters, the contract test still passes.
- [ ] If you touched the SQLite schema, you added a migration and a test for
      it.
- [ ] If you added an env var or secret, it's documented in `.env.example`
      and resolved through `SecretSource`.
- [ ] If you changed user-visible behavior, the relevant section of
      `README.md` / `ROADMAP.md` is updated.
- [ ] Commit messages are descriptive (look at `git log` for tone).

CI runs `npm ci`, `npm run typecheck`, and `npm test` on Ubuntu / Node 22 on
every push to `main` and every PR.

## What we'll push back on

- "Just overwrite the inbox file" — no. Use `appendFile` or `proposePatch`.
- "Drop and recreate the DB on schema change" — only with explicit user
  opt-in.
- "Send the full message to OpenAI for embeddings by default" — off by
  default. Embeddings are opt-in, attachments are referenced not auto-uploaded.
- "Add telemetry to count active users" — no. Pebble is a personal-knowledge
  tool.

## Reporting bugs / asking questions

Open a GitHub issue with:

- What you ran (`npm run cli -- doctor` output is gold).
- What you expected vs. what you got.
- Relevant lines from `<vault>/_System/ingestion-log.jsonl` or
  `agent-actions.jsonl` if the problem is in the pipeline.
- Whether you're on macOS or Linux, Node version, and whether you're using
  subscription-mode (`claude-code` / `codex`) or API-key mode.

## Security

If you find a security issue, **don't open a public issue.** Email the
maintainer directly (see git history for current contact). Constant-time
token compare, path-escape checks, and the no-auto-upload-attachments
invariant are the most security-sensitive surfaces — flagging anything that
weakens them is especially welcome.

## License

By contributing, you agree your contributions will be licensed under the
[MIT License](./LICENSE).
