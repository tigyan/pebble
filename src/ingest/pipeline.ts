import type { PebbleDB } from "../db/client.js";
import type { IngestPayload, IngestRecord } from "../types/index.js";
import { writeIngestion } from "../vault/writer.js";
import { materializeAttachments } from "./attachments.js";
import { findNearDuplicate, type NearDupOptions } from "./near-dup.js";

export interface IngestPipelineOpts {
  vaultPath: string;
  appendOnly?: boolean;
  db: PebbleDB;
  /** How many recent ingestions to scan for near-duplicates. Default 200. */
  nearDupWindow?: number;
  /** Pass `null` to disable near-dup detection. Default: enabled with library defaults. */
  nearDup?: NearDupOptions | null;
  /** Override fetch for remote-attachment materialization (tests). */
  fetchImpl?: typeof fetch;
}

export interface IngestResult {
  record: IngestRecord;
  duplicate: IngestRecord | null;
  /** Set when a near-duplicate (Jaccard ≥ threshold) was found in the recent window. */
  near_duplicate: { id: string; score: number } | null;
}

/** Persist an inbound message: vault first, then DB mirror. */
export async function ingest(
  payload: IngestPayload,
  opts: IngestPipelineOpts,
): Promise<IngestResult> {
  // Copy any remote/external attachments into the vault before we write the
  // markdown so the persisted note references the materialized local copy.
  const attachments = await materializeAttachments(payload.attachments, {
    vaultPath: opts.vaultPath,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const materialized: IngestPayload =
    attachments.length > 0 ? { ...payload, attachments } : payload;

  const { record } = await writeIngestion(materialized, {
    vaultPath: opts.vaultPath,
    ...(opts.appendOnly !== undefined ? { appendOnly: opts.appendOnly } : {}),
  });

  // Exact-hash duplicate scan happens before insert so the freshly-written
  // record doesn't mask a prior copy of itself.
  const duplicate = opts.db.findByHash(record.original_text_hash);

  let near: IngestResult["near_duplicate"] = null;
  if (opts.nearDup !== null) {
    const window = opts.db
      .listRecentIngestions(opts.nearDupWindow ?? 200)
      .filter((r) => r.original_text_hash !== record.original_text_hash);
    const hit = findNearDuplicate(record.text, window, opts.nearDup ?? {});
    if (hit) near = { id: hit.candidate.id, score: hit.score };
  }

  opts.db.insertIngestion(record);
  return { record, duplicate, near_duplicate: near };
}
