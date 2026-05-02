# Pebble Architecture

## High-level flow

```mermaid
flowchart LR
    subgraph Sources
      iMessage[iMessage]
      SMS[SMS]
      Shortcut[Apple Shortcut]
      ManualCLI[Manual / CLI]
    end

    subgraph Bridges["Provider bridges"]
      BlueBubbles
      Sendblue
      ShortcutsHTTP["Shortcut → HTTPS"]
    end

    iMessage --> BlueBubbles
    iMessage --> Sendblue
    Shortcut --> ShortcutsHTTP
    SMS --> Sendblue

    BlueBubbles -- POST --> Endpoint
    Sendblue    -- POST --> Endpoint
    ShortcutsHTTP -- POST --> Endpoint
    ManualCLI   -- pebble ingest --> CLI

    Endpoint["/ingest (Fastify, X-Pebble-Token)"] --> Adapter
    CLI[pebble CLI] --> Adapter

    Adapter["Adapter registry\n(bluebubbles · sendblue · shortcuts · manual)"] --> Pipeline

    Pipeline["Ingestion pipeline\n(Zod-validated IngestPayload)"] --> VaultWriter
    Pipeline --> SQLite

    subgraph Vault["Obsidian Vault (Markdown, append-only)"]
      Inbox["Inbox/YYYY-MM-DD.md"]
      Threads["Sources/<provider>/<thread>.md"]
      People["People/<sender>.md"]
      Logs["_System/*.jsonl + patches/"]
    end

    VaultWriter --> Inbox
    VaultWriter --> Threads
    VaultWriter --> People
    VaultWriter --> Logs

    SQLite[("SQLite + FTS5\n_System/pebble.sqlite")]

    Indexer[Vault indexer] --> SQLite
    Indexer --> Vault

    subgraph AI["AI / agents"]
      Triage[Triage classifier\nTriageResult Zod]
      Agent[Agent loop]
    end

    SQLite <--> Triage
    SQLite <--> Agent
    Agent  -->|tools only| AgentTools["Agent tool surface\n(read/append/create/propose_patch/search/...)"]
    AgentTools --> Vault
    AgentTools --> SQLite
```

## Module boundaries

| Module                         | Responsibility                                                          |
| ------------------------------ | ----------------------------------------------------------------------- |
| `src/types`                    | Zod schemas + TS types (the single source of truth)                     |
| `src/config.ts`                | Env → `PebbleConfig` (validated)                                         |
| `src/adapters/*`               | Provider-specific normalizers behind a single `IngestionAdapter`        |
| `src/server/server.ts`         | Fastify HTTP surface: `/health`, `/ingest`, `/recent`, `/search`         |
| `src/ingest/pipeline.ts`       | Vault-write + DB-mirror, deduplication by hash                          |
| `src/vault/writer.ts`          | Append-only writes, daily/thread/person notes, reversible patches       |
| `src/vault/frontmatter.ts`     | YAML frontmatter render/parse (gray-matter)                             |
| `src/vault/paths.ts`           | Vault directory layout + path normalization                              |
| `src/db/{schema.ts,client.ts}` | SQLite schema (FTS5) and typed client                                   |
| `src/indexer/index.ts`         | Walks the vault, populates `notes` + `notes_fts`                         |
| `src/triage/classifier.ts`     | `TriageProvider` interface + `mock` implementation                       |
| `src/triage/runner.ts`         | Batch triage of recent raw ingestions                                    |
| `src/agent/tools.ts`           | Sandboxed tool surface for agents (logs every call)                      |
| `src/cli/index.ts`             | `pebble {init,ingest,triage,index,search,agent,doctor}`                  |

## Append-only & reversibility guarantees

1. The writer creates Markdown files only on first contact; subsequent writes
   are **`fs.appendFile`**.
2. Any non-append edit MUST go through `proposePatch`, which writes:
   - `_System/patches/<id>.before.md` — exact prior bytes (the rollback target).
   - `_System/patches/<id>.diff`     — header + new content + reason.
3. Agents have no general filesystem access; they go through `AgentTools`,
   whose `propose_patch` is the only mutation path that touches existing bodies.
4. Every ingestion is mirrored to `_System/ingestion-log.jsonl` for audit.
5. Every agent tool call is mirrored to `_System/agent-actions.jsonl` *and* to
   the `agent_actions` SQLite table for fast queries.

## Authoritative data

The **vault is authoritative**. SQLite is a regenerable cache (rebuild with
`pebble index`). This keeps Pebble friendly to manual editing in Obsidian.

## Extension points

- **New provider**: drop a file in `src/adapters/` implementing `IngestionAdapter`,
  register it in `src/adapters/index.ts`. The adapter chain runs in order;
  `manual` is the catch-all and must remain last.
- **New AI provider**: implement `TriageProvider` in `src/triage/classifier.ts`,
  return data that parses against `TriageResultSchema`.
- **Subscription-based agent operation** (Claude Code, Codex, etc.): the
  `claude-code` / `codex` provider slots are reserved. Plug a sub-process
  driver into `getProvider()` and let the agent loop call the agent-tools
  surface — they are deliberately RPC-shaped to make CLI-driven agents
  trivial to wire in.
- **Embeddings**: the `notes` table is ready for a sibling `note_embeddings`
  table; the indexer hashes bodies so re-embedding is cheap. Keep the
  embeddings provider behind an interface so local + API options are pluggable.
