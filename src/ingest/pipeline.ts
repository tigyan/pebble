import type { AttachmentResolver } from "../adapters/bluebubbles-fetch.js";
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
  /**
   * Window in ms for echo/replay suppression (same sender+thread+text+attachments).
   * Default 60_000. Set 0 to disable.
   */
  echoWindowMs?: number;
  /** Override fetch for remote-attachment materialization (tests). */
  fetchImpl?: typeof fetch;
  /** Per-scheme attachment resolvers (e.g. bluebubbles://). */
  attachmentResolvers?: Record<string, AttachmentResolver>;
}

export interface IngestResult {
  record: IngestRecord;
  duplicate: IngestRecord | null;
  /** Set when a near-duplicate (Jaccard ≥ threshold) was found in the recent window. */
  near_duplicate: { id: string; score: number } | null;
  /**
   * True when this payload was an echo of a record already in the DB
   * (same sender/thread/text/attachments within echoWindowMs). The vault
   * was NOT written and `record` references the prior copy.
   */
  skipped?: boolean;
}

/** Persist an inbound message: vault first, then DB mirror. */
export async function ingest(
  payload: IngestPayload,
  opts: IngestPipelineOpts,
): Promise<IngestResult> {
  // why: BlueBubbles fires `new-message` twice for chat-with-self (once for
  // the outgoing send, once for the iCloud-relay echo back to the same Mac).
  // Both events share sender/thread/text/attachments, so we suppress the
  // second arrival within a short window before touching the vault.
  const echoMs = opts.echoWindowMs ?? 60_000;
  if (echoMs > 0) {
    const echo = findEchoDuplicate(opts.db, payload, echoMs);
    if (echo) {
      return { record: echo, duplicate: echo, near_duplicate: null, skipped: true };
    }
  }

  // Copy any remote/external attachments into the vault before we write the
  // markdown so the persisted note references the materialized local copy.
  const attachments = await materializeAttachments(payload.attachments, {
    vaultPath: opts.vaultPath,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.attachmentResolvers ? { resolvers: opts.attachmentResolvers } : {}),
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

function attachmentSig(p: { attachments?: { uri: string }[] | undefined }): string {
  return (p.attachments ?? []).map((a) => a.uri).sort().join("|");
}

function findEchoDuplicate(
  db: PebbleDB,
  payload: IngestPayload,
  windowMs: number,
): IngestRecord | null {
  const now = Date.now();
  const sig = attachmentSig(payload);
  // listRecentIngestions returns DESC by received_at; bail out as soon as
  // we walk past the echo window to keep this O(window).
  for (const r of db.listRecentIngestions(50)) {
    const age = now - new Date(r.received_at).getTime();
    if (age > windowMs) return null;
    if (r.sender !== payload.sender) continue;
    if (r.thread_id !== payload.thread_id) continue;
    if (r.text !== payload.text) continue;
    if (attachmentSig(r) !== sig) continue;
    return r;
  }
  return null;
}
