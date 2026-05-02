import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PebbleDB } from "../db/client.js";
import {
  type IngestRecord,
  type NoteFrontmatter,
  type TriageResult,
} from "../types/index.js";
import { renderNote } from "../vault/frontmatter.js";
import { normalizeSegment } from "../vault/paths.js";

export interface FilingResult {
  id: string;
  filed_path: string;
  created: boolean;
}

/**
 * File a single triaged ingestion into its typed home.
 *
 * Append-only: creates a NEW note inside `<vault>/<suggested_folder>/` linking
 * back to the source thread. The original Inbox/Sources/People entries are
 * never touched. Idempotent: if the same id is filed twice, we no-op.
 */
export async function fileOne(opts: {
  vaultPath: string;
  db: PebbleDB;
  record: IngestRecord;
  triage: TriageResult;
}): Promise<FilingResult> {
  const { vaultPath, db, record, triage } = opts;

  const folder = sanitizeFolder(triage.suggested_folder);
  const filename = buildFilename(record, triage);
  const dir = path.join(vaultPath, folder);
  const filed_path = path.join(dir, filename);

  await fs.mkdir(dir, { recursive: true });

  let created = false;
  try {
    await fs.access(filed_path);
  } catch {
    // first-time file → create
    const fm: NoteFrontmatter = {
      source: record.source,
      sender: record.sender,
      thread_id: record.thread_id,
      received_at: record.received_at,
      status: "filed",
      tags: mergeTags(triage),
      agent_confidence: triage.agent_confidence,
      original_text_hash: record.original_text_hash,
      ingestion_id: record.id,
    };

    const body = renderBody(record, triage, vaultPath);
    await fs.writeFile(filed_path, renderNote(fm, body), "utf8");
    created = true;
  }

  // Link from the source thread to the new home (append-only).
  const backlinkLine = `\n> Filed as [[${path.relative(vaultPath, filed_path).replace(/\.md$/, "")}]] (${triage.type}/${triage.urgency})\n`;
  await fs.appendFile(record.thread_path, backlinkLine, "utf8");

  // Persist status
  db.setStatus(record.id, "filed");

  return { id: record.id, filed_path, created };
}

/** File every triaged ingestion the DB knows about, oldest first. */
export async function fileAllTriaged(opts: {
  vaultPath: string;
  db: PebbleDB;
  limit?: number;
}): Promise<FilingResult[]> {
  const { vaultPath, db, limit = 50 } = opts;
  const recent = db.listRecentIngestions(limit);
  const triagedFirst = recent.filter((r) => r.status === "triaged").reverse();
  const out: FilingResult[] = [];
  for (const rec of triagedFirst) {
    const triage = db.getTriage(rec.id);
    if (!triage) continue; // status says triaged but no result — skip
    out.push(await fileOne({ vaultPath, db, record: rec, triage }));
  }
  return out;
}

// --- helpers -------------------------------------------------------------

function sanitizeFolder(folder: string): string {
  // Allow nested folders ("Projects/Work") but block path escapes.
  const parts = folder
    .split(/[\\/]+/)
    .map((p) => normalizeSegment(p))
    .filter((p) => p && p !== "." && p !== "..");
  return parts.length ? parts.join(path.sep) : "Inbox";
}

function buildFilename(record: IngestRecord, triage: TriageResult): string {
  const day = record.received_at.slice(0, 10);
  const slug = slugify(deriveTitle(record.text)) || shortHash(record.id);
  return `${day} ${slug} (${record.id}).md`;
}

function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const stop = t.search(/[.!?\n]/);
  return (stop > 0 ? t.slice(0, stop) : t).slice(0, 80);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 8);
}

function mergeTags(triage: TriageResult): string[] {
  const out = new Set<string>([
    `type/${triage.type}`,
    `urgency/${triage.urgency}`,
    "pebble/filed",
  ]);
  for (const t of triage.suggested_tags) out.add(t);
  return Array.from(out);
}

function renderBody(record: IngestRecord, triage: TriageResult, vault: string): string {
  const threadRel = path.relative(vault, record.thread_path).replace(/\.md$/, "");
  const personRel = path.relative(vault, record.person_path).replace(/\.md$/, "");
  const backlinks = triage.suggested_backlinks.length
    ? "\n## Suggested backlinks\n" + triage.suggested_backlinks.map((b) => `- [[${b}]]`).join("\n") + "\n"
    : "";
  const rationale = triage.rationale ? `\n> ${triage.rationale}\n` : "";

  return [
    `# ${deriveTitle(record.text) || `Note from ${record.sender}`}`,
    "",
    `From: [[${personRel}]] · Thread: [[${threadRel}]]`,
    "",
    "## Original message",
    "",
    record.text.trim() || "_(no text)_",
    "",
    rationale,
    backlinks,
  ].join("\n");
}
