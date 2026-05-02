# CLAUDE.md — guidance for Claude Code

> **First read [`AGENTS.md`](./AGENTS.md).** It is the source of truth for
> repo-wide invariants (append-only vault, schema-first, provider-agnostic,
> no telemetry, agents-via-tools-only). This file only adds Claude-specific
> workflow notes.

## Quick orientation

- TypeScript ESM project. Strict tsc passes; 9/9 vitest tests pass.
- Entry points: `src/server/index.ts` (HTTP), `src/cli/index.ts` (CLI).
- Vault is authoritative; SQLite at `<vault>/_System/pebble.sqlite` is a cache
  rebuildable with `pebble index`.

## Default commands you can run

```bash
npm run typecheck       # strict tsc --noEmit
npm test                # vitest run (unit + integration)
npm run cli -- doctor   # sanity-check config + vault layout + DB
npm run cli -- ingest --text "..."
npm run dev             # tsx watch HTTP server
```

The integration test at `tests/integration/ingest.test.ts` is the canonical
smoke. After any change to adapters, server, vault writer, DB, or triage,
re-run `npm test` and make sure it still passes.

## How to plan a change

1. **Find the schema first.** Almost every cross-boundary value is a Zod
   schema in `src/types/index.ts`. Update the schema before the producer
   or consumer.
2. **Pick the smallest module.** The layout in `AGENTS.md` is load-bearing —
   don't fold concerns together. If you can't tell which file a change
   belongs in, you may be missing a module.
3. **Append, don't overwrite.** Anything that touches the vault on disk
   must go through `writeIngestion` (new ingest), `appendFile` (append),
   or `proposePatch` (reversible non-append edit). Bypassing this is a bug
   even if the test doesn't catch it.
4. **Honor dry-run.** Any agent-side mutation must check `ctx.dryRun` and
   still call `recordAction`. Tests for new tools should cover both modes.

## When using subagents / tools

- Spawn an `Explore` subagent for codebase questions that span >3 files.
- Use `code-reviewer` after non-trivial code changes (especially in
  `src/vault/writer.ts`, `src/agent/tools.ts`, `src/server/server.ts` —
  the security-sensitive surfaces).
- For build/type errors, the `build-error-resolver` (or
  `typescript-reviewer`) is appropriate; minimal diffs only.
- Don't run destructive shell commands (`rm -rf`, `git reset --hard`,
  force-push) without explicit user confirmation.

## Things specific to this repo

- **Constant-time token compare.** `safeEqual` in `src/server/server.ts`
  must not be replaced with `===`.
- **Path escape check.** `safePath` in `src/agent/tools.ts` is the only
  thing keeping a malicious agent from writing outside the vault. Don't
  remove or weaken it.
- **No `process.env` outside `src/config.ts`.** Tests pass an env object
  to `loadConfig`. Adding ad-hoc `process.env.X` reads anywhere else
  breaks that contract.
- **Schema kept in two places on purpose.** `src/db/schema.ts` (inline
  string used at runtime) and `src/db/schema.sql` (reference copy for
  future migration tooling). Update both.

## Communication style for this user

- Russian or English is fine; the user opened in Russian.
- Be terse. Don't restate diffs. End-of-turn summary: 1–2 sentences.
- Confirm before destructive or shared-state actions; otherwise proceed.

## What to refuse

See the "Things to refuse / push back on" section in `AGENTS.md`. The short
version: don't overwrite vault content, don't drop the DB without consent,
don't auto-upload attachments to models, don't add telemetry.
