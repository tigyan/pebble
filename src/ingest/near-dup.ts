import type { IngestRecord } from "../types/index.js";

export interface NearDupOptions {
  /** Word-shingle size. Default 3 (3-grams). */
  k?: number;
  /** Jaccard threshold for considering a candidate a near-duplicate. Default 0.6. */
  threshold?: number;
  /** Minimum number of shingles required on either side. Default 3 — short messages
   *  are too noisy for shingled comparison. */
  minShingles?: number;
}

export interface NearDupHit {
  candidate: IngestRecord;
  score: number;
}

/**
 * Find the highest-scoring near-duplicate of `text` among `candidates` using
 * Jaccard similarity over word k-shingles. Returns null if no candidate
 * clears the threshold or the input is too short to compare.
 */
export function findNearDuplicate(
  text: string,
  candidates: IngestRecord[],
  opts: NearDupOptions = {},
): NearDupHit | null {
  const k = opts.k ?? 3;
  const threshold = opts.threshold ?? 0.6;
  const minShingles = opts.minShingles ?? 3;

  const a = shingles(text, k);
  if (a.size < minShingles) return null;

  let best: NearDupHit | null = null;
  for (const cand of candidates) {
    const b = shingles(cand.text, k);
    if (b.size < minShingles) continue;
    const score = jaccard(a, b);
    if (score >= threshold && (!best || score > best.score)) {
      best = { candidate: cand, score };
    }
  }
  return best;
}

/** Word-level k-shingles; lower-cased, alpha-numeric tokenized. Exported for tests. */
export function shingles(text: string, k: number): Set<string> {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[];
  const out = new Set<string>();
  if (tokens.length < k) {
    if (tokens.length > 0) out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + k <= tokens.length; i++) {
    out.add(tokens.slice(i, i + k).join(" "));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}
