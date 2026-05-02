You are a senior full-stack engineer and product architect. Build an MVP for an “iMessage-to-Obsidian AI Vault Aggregator”.

Product goal:
Users can send messages to themselves or to a dedicated iMessage contact. Each message becomes structured knowledge inside an Obsidian vault. AI agents classify, enrich, link, tag, deduplicate, and organize the notes. The system should support future subscription-based agent operation using Claude Code, Codex, or other CLI/API agents.

Core MVP:
1. Accept inbound messages from an iMessage bridge.
   - Start with a generic webhook endpoint:
     POST /ingest
     body: {
       "source": "imessage" | "sms" | "shortcut" | "manual",
       "sender": string,
       "thread_id": string,
       "text": string,
       "attachments": optional array,
       "timestamp": ISO string
     }
   - Do not hardcode one provider. Create adapter interfaces for:
     a) Apple Shortcuts webhook
     b) BlueBubbles webhook
     c) Texting Blue / Sendblue-style webhook
     d) manual local CLI ingestion

2. Store every incoming item safely in an Obsidian vault.
   - Vault is a normal local folder of Markdown files.
   - Use this structure:
     /Inbox/YYYY-MM-DD.md
     /Sources/iMessage/{thread_id}.md
     /People/{normalized_sender}.md
     /_System/ingestion-log.jsonl
     /_System/agent-actions.jsonl
   - Never destroy user content.
   - All writes must be append-only by default.
   - Any destructive change requires a reversible patch file or backup.

3. Convert messages into clean Markdown blocks.
   Each ingested message should include YAML/frontmatter or structured metadata:
   - source
   - sender
   - thread_id
   - received_at
   - status: raw | triaged | filed | linked
   - tags
   - agent_confidence
   - original_text_hash

4. Build an AI triage pipeline.
   For each message, classify:
   - type: idea, task, meeting_note, contact, project_note, reference, question, journal, finance, travel, media, other
   - urgency: none, low, medium, high
   - suggested folder
   - suggested tags
   - suggested backlinks
   - whether it should become a task
   - whether it likely duplicates an existing note
   Output must be JSON matching a Zod schema.

5. Build a vault indexer.
   - Read Markdown files from the vault.
   - Extract titles, headings, tags, aliases, frontmatter, links.
   - Create a lightweight local search index.
   - For MVP use SQLite plus FTS5.
   - Design an embeddings interface, but keep embeddings optional.
   - Future-compatible with local embeddings or API embeddings.

6. Build an agent workspace.
   - Agents should operate through explicit tools, not arbitrary filesystem writes.
   - Implement tools:
     read_note(path)
     append_to_note(path, markdown)
     create_note(path, markdown)
     propose_patch(path, diff)
     search_vault(query)
     list_recent_ingestions()
     mark_ingestion_status(id, status)
   - Log every tool call in /_System/agent-actions.jsonl.
   - Add dry-run mode.

7. Build a small web dashboard.
   - Show recent ingested messages.
   - Show triage status.
   - Let user approve suggested filing.
   - Let user search the vault.
   - Let user configure vault path, ingestion secret, model provider, and default folders.
   - Stack preference: TypeScript, Node.js, Fastify or Next.js, SQLite, Zod.

8. Build a CLI.
   Commands:
   - pebble init
   - pebble ingest --text "..."
   - pebble triage --limit 10
   - pebble index
   - pebble search "..."
   - pebble agent --dry-run
   - pebble doctor

9. Security and privacy:
   - Assume the vault contains private personal knowledge.
   - No telemetry by default.
   - API keys must be stored in .env or OS keychain, never committed.
   - Ingestion endpoint must require a secret token.
   - Attachments should be stored locally and referenced, not blindly uploaded to models.
   - Add a .gitignore that excludes .env, logs with secrets, and local DB if needed.

10. Tests:
   - Unit tests for ingestion parser, Markdown writer, classifier schema, vault indexer.
   - Integration test: webhook payload -> inbox markdown -> triage JSON -> suggested filing.
   - Include sample fixtures.

11. Deliverables:
   - Working repo
   - README with setup instructions
   - .env.example
   - Architecture diagram in Mermaid
   - MVP roadmap
   - Known limitations around iMessage APIs and provider adapters
   - Clear extension points for Claude Code, Codex, OpenAI, Anthropic, local models

Implementation constraints:
- Prefer TypeScript.
- Use strict typing.
- Use Zod for schemas.
- Use SQLite for local state.
- Avoid destructive edits to the vault.
- Keep Obsidian compatibility: plain Markdown files, wikilinks, tags, YAML frontmatter.
- Make the first version provider-agnostic: iMessage is just one adapter.

First task:
Create the repository structure, core TypeScript types, ingestion endpoint, local vault writer, SQLite schema, CLI skeleton, and one working integration test.
