import type { PebbleDB } from "../db/client.js";
import type { IngestPayload, IngestRecord } from "../types/index.js";
import { writeIngestion } from "../vault/writer.js";

export interface IngestPipelineOpts {
  vaultPath: string;
  appendOnly?: boolean;
  db: PebbleDB;
}

export interface IngestResult {
  record: IngestRecord;
  duplicate: IngestRecord | null;
}

/** Persist an inbound message: vault first, then DB mirror. */
export async function ingest(
  payload: IngestPayload,
  opts: IngestPipelineOpts,
): Promise<IngestResult> {
  const { record } = await writeIngestion(payload, {
    vaultPath: opts.vaultPath,
    ...(opts.appendOnly !== undefined ? { appendOnly: opts.appendOnly } : {}),
  });

  const duplicate = opts.db.findByHash(record.original_text_hash);
  opts.db.insertIngestion(record);
  return { record, duplicate };
}
