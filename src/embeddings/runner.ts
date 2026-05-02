import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { PebbleDB } from "../db/client.js";
import { parseNote } from "../vault/frontmatter.js";
import { type EmbeddingProvider, vectorToBuffer } from "./provider.js";

export interface EmbedRunResult {
  scanned: number;
  embedded: number;
  skipped: number;
  errors: number;
}

export interface EmbedRunOpts {
  db: PebbleDB;
  provider: EmbeddingProvider;
  /** Re-embed even if content_hash matches (default false). */
  force?: boolean;
  /** Cap on embedded notes per run. Default: unlimited. */
  limit?: number;
  /** Batch size sent to the provider per request. Default 16. */
  batchSize?: number;
  /** Include note title in the embedded text (default true). */
  includeTitle?: boolean;
}

/**
 * Embed every note already in the SQLite `notes` table using the configured
 * provider. Skips notes whose body hash hasn't changed since the last embed
 * for the same model. Vault is authoritative — bodies are re-read from disk
 * before embedding so we never embed stale content.
 */
export async function embedAllNotes(opts: EmbedRunOpts): Promise<EmbedRunResult> {
  const { db, provider } = opts;
  const force = !!opts.force;
  const includeTitle = opts.includeTitle ?? true;
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 16, 256));
  const cap = opts.limit ?? Infinity;

  const rows = db.raw
    .prepare(`SELECT path, title FROM notes`)
    .all() as Array<{ path: string; title: string | null }>;

  let scanned = 0;
  let embedded = 0;
  let skipped = 0;
  let errors = 0;

  // Build a queue of (path, prepared text, content_hash). Skip up front when
  // content_hash already matches a row for this model and !force.
  const queue: Array<{ path: string; text: string; hash: string }> = [];
  for (const row of rows) {
    if (embedded + queue.length >= cap) break;
    scanned++;
    let text: string;
    let hash: string;
    try {
      const raw = await fs.readFile(row.path, "utf8");
      const { content } = parseNote(raw);
      const body = content.trim();
      if (!body) {
        skipped++;
        continue;
      }
      text = includeTitle && row.title ? `${row.title}\n\n${body}` : body;
      hash = sha256(`${provider.model}\n${text}`);
    } catch {
      errors++;
      continue;
    }

    if (!force) {
      const existing = db.getEmbedding(row.path, provider.model);
      if (existing && existing.contentHash === hash && existing.dim === provider.dim) {
        skipped++;
        continue;
      }
    }
    queue.push({ path: row.path, text, hash });
  }

  // Embed in batches.
  for (let i = 0; i < queue.length; i += batchSize) {
    const batch = queue.slice(i, i + batchSize);
    let vecs: Float32Array[];
    try {
      vecs = await provider.embed(batch.map((b) => b.text));
    } catch {
      errors += batch.length;
      continue;
    }
    if (vecs.length !== batch.length) {
      errors += batch.length;
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j]!;
      const vec = vecs[j]!;
      if (vec.length !== provider.dim) {
        errors++;
        continue;
      }
      db.upsertEmbedding({
        path: item.path,
        model: provider.model,
        dim: provider.dim,
        vec: vectorToBuffer(vec),
        contentHash: item.hash,
      });
      embedded++;
    }
  }

  return { scanned, embedded, skipped, errors };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
