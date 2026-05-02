import type { PebbleDB } from "../db/client.js";
import type { TriageResult } from "../types/index.js";
import { getProvider } from "./classifier.js";

export interface TriageRunResult {
  id: string;
  triage: TriageResult;
}

/** Triage all currently-raw ingestions (oldest first), up to `limit`. */
export async function runTriage(opts: {
  db: PebbleDB;
  provider: string;
  limit?: number;
}): Promise<TriageRunResult[]> {
  const provider = getProvider(opts.provider);
  const recent = opts.db.listRecentIngestions(opts.limit ?? 25);
  const raw = recent.filter((r) => r.status === "raw").reverse();
  const results: TriageRunResult[] = [];
  for (const rec of raw) {
    const triage = await provider.classify(rec);
    opts.db.setTriage(rec.id, triage, "triaged");
    results.push({ id: rec.id, triage });
  }
  return results;
}
