import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  type IngestPayload,
  type IngestRecord,
  type NoteFrontmatter,
} from "../types/index.js";
import { renderNote } from "./frontmatter.js";
import {
  VAULT_DIRS,
  agentActionsLogPath,
  inboxPathFor,
  ingestionLogPath,
  personPathFor,
  threadPathFor,
} from "./paths.js";

export interface WriteOptions {
  vaultPath: string;
  /** When true, refuse any in-place rewrite of existing note bodies. Default: true. */
  appendOnly?: boolean;
}

export interface IngestWriteResult {
  record: IngestRecord;
  wrote: { inbox: string; thread: string; person: string; log: string };
}

/**
 * Append a single inbound message to the vault.
 *
 * Guarantees:
 *  - Never overwrites existing markdown bodies.
 *  - Each ingestion is atomically appended to /_System/ingestion-log.jsonl.
 *  - Daily inbox / per-thread / per-person notes are created on first contact
 *    and appended to thereafter.
 */
export async function writeIngestion(
  payload: IngestPayload,
  opts: WriteOptions,
): Promise<IngestWriteResult> {
  const vault = path.resolve(opts.vaultPath);
  await ensureVaultLayout(vault);

  const id = nanoid(12);
  const receivedAt = new Date().toISOString();
  const hash = sha256(payload.text);

  const inboxPath = inboxPathFor(vault, payload.timestamp);
  const threadPath = threadPathFor(vault, payload.source, payload.thread_id);
  const personPath = personPathFor(vault, payload.sender);

  const fm: NoteFrontmatter = {
    source: payload.source,
    sender: payload.sender,
    thread_id: payload.thread_id,
    received_at: receivedAt,
    status: "raw",
    tags: ["pebble/raw", `source/${payload.source}`],
    agent_confidence: null,
    original_text_hash: hash,
    ingestion_id: id,
  };

  const block = formatBlock(id, payload, receivedAt);

  await Promise.all([
    appendOrCreate(inboxPath, () => initialInbox(payload.timestamp), block),
    appendOrCreate(threadPath, () => initialThread(fm, payload), block),
    appendOrCreate(personPath, () => initialPerson(payload.sender), `- [[${path.basename(threadPath, ".md")}]] — ${shortPreview(payload.text)} (${id})\n`),
  ]);

  const record: IngestRecord = {
    ...payload,
    id,
    received_at: receivedAt,
    status: "raw",
    original_text_hash: hash,
    inbox_path: inboxPath,
    thread_path: threadPath,
    person_path: personPath,
  };

  const logPath = ingestionLogPath(vault);
  await fs.appendFile(logPath, JSON.stringify(record) + "\n", "utf8");

  return {
    record,
    wrote: {
      inbox: inboxPath,
      thread: threadPath,
      person: personPath,
      log: logPath,
    },
  };
}

/**
 * A reversible patch. Stored under /_System/patches/<id>.diff alongside a backup
 * of the prior content. Callers MUST go through this for any non-append edit.
 */
export async function proposePatch(
  vault: string,
  filePath: string,
  newContent: string,
  reason: string,
): Promise<{ patchId: string; patchPath: string; backupPath: string }> {
  const id = nanoid(10);
  const patchDir = path.join(vault, VAULT_DIRS.patches);
  await fs.mkdir(patchDir, { recursive: true });

  const prior = await fs.readFile(filePath, "utf8").catch(() => "");
  const backupPath = path.join(patchDir, `${id}.before.md`);
  const patchPath = path.join(patchDir, `${id}.diff`);

  await fs.writeFile(backupPath, prior, "utf8");
  const diff = renderUnifiedDiff(filePath, prior, newContent, reason);
  await fs.writeFile(patchPath, diff, "utf8");
  return { patchId: id, patchPath, backupPath };
}

// --- internals -----------------------------------------------------------

async function ensureVaultLayout(vault: string): Promise<void> {
  await fs.mkdir(vault, { recursive: true });
  for (const dir of Object.values(VAULT_DIRS)) {
    await fs.mkdir(path.join(vault, dir), { recursive: true });
  }
  // Ensure logs exist as zero-byte files so tailing tools don't fail.
  for (const f of [ingestionLogPath(vault), agentActionsLogPath(vault)]) {
    try {
      await fs.access(f);
    } catch {
      await fs.writeFile(f, "", "utf8");
    }
  }
}

async function appendOrCreate(
  filePath: string,
  initial: () => string,
  appendMarkdown: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let exists = true;
  try {
    await fs.access(filePath);
  } catch {
    exists = false;
  }
  if (!exists) {
    await fs.writeFile(filePath, initial(), "utf8");
  }
  await fs.appendFile(filePath, ensureLeadingBlank(appendMarkdown), "utf8");
}

function ensureLeadingBlank(s: string): string {
  return s.startsWith("\n") ? s : "\n" + s;
}

function formatBlock(id: string, p: IngestPayload, receivedAt: string): string {
  const attach =
    p.attachments && p.attachments.length
      ? "\nAttachments:\n" +
        p.attachments
          .map((a) => `- (${a.kind}) ${a.filename ?? a.uri}`)
          .join("\n") +
        "\n"
      : "";
  const text = p.text.trim() || "_(no text)_";
  return [
    `## ${receivedAt} — ${p.sender}`,
    "",
    `> source: \`${p.source}\` · thread: \`${p.thread_id}\` · id: \`${id}\``,
    "",
    text,
    attach,
  ].join("\n");
}

function initialInbox(timestamp: string): string {
  const day = timestamp.slice(0, 10);
  return `---\ntype: inbox\ndate: ${day}\n---\n\n# Inbox — ${day}\n`;
}

function initialThread(fm: NoteFrontmatter, p: IngestPayload): string {
  return renderNote(fm, `# Thread: ${p.thread_id}\n\nSource: ${p.source}\n`);
}

function initialPerson(sender: string): string {
  return `---\ntype: person\nname: ${escapeYaml(sender)}\n---\n\n# ${sender}\n\n## Mentions\n`;
}

function escapeYaml(s: string): string {
  if (/^[a-zA-Z0-9_\-+. @]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function shortPreview(text: string, n = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function renderUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  reason: string,
): string {
  // We do not depend on a diff lib; this is a *header-only* patch that records
  // intent. The backup file stores exact prior bytes, which is what makes the
  // change reversible.
  return [
    `# pebble patch`,
    `# file: ${filePath}`,
    `# reason: ${reason}`,
    `# before-bytes: ${Buffer.byteLength(before, "utf8")}`,
    `# after-bytes:  ${Buffer.byteLength(after, "utf8")}`,
    `--- before`,
    `+++ after`,
    after,
  ].join("\n");
}
