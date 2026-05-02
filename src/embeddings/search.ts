import type { PebbleDB } from "../db/client.js";
import { bufferToVector, cosine, type EmbeddingProvider } from "./provider.js";

export interface HybridHit {
  path: string;
  title: string | null;
  snippet: string;
  fts_rank: number | null;
  vector_score: number | null;
  /** Combined score (0..1). Higher is better. */
  score: number;
}

export interface HybridSearchOpts {
  db: PebbleDB;
  query: string;
  /** Embedding provider to vectorize the query (must match the model used to embed notes). */
  embedder?: EmbeddingProvider;
  /** Final result cap. Default 25. */
  limit?: number;
  /** How many candidates to consider from FTS before rank-fusing. Default 60. */
  ftsCandidates?: number;
  /** How many candidates to consider from the vector side. Default 60. */
  vectorCandidates?: number;
  /** Weight on the vector side in the rank-fusion blend. Default 0.5. */
  vectorWeight?: number;
}

/**
 * Hybrid FTS + vector search using reciprocal-rank fusion.
 *
 * - If `embedder` is omitted or no embeddings exist for that model, falls back
 *   to FTS-only with a vector_score of `null` on each hit.
 * - Otherwise: take top-N from FTS (by rank) and top-N from vector (by cosine),
 *   merge by RRF (1/(k+rank)), weighted by `vectorWeight`.
 */
export async function searchHybrid(opts: HybridSearchOpts): Promise<HybridHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
  const ftsN = Math.max(limit, opts.ftsCandidates ?? 60);
  const vecN = Math.max(limit, opts.vectorCandidates ?? 60);
  const vw = clamp01(opts.vectorWeight ?? 0.5);
  const k = 60; // RRF constant

  const ftsHits = ftsCandidates(opts.db, opts.query, ftsN);

  // No embedder, or no embeddings for this model → FTS-only.
  let vecHits: VectorHit[] = [];
  if (opts.embedder && opts.db.countEmbeddings(opts.embedder.model) > 0) {
    try {
      vecHits = await vectorCandidates(opts.db, opts.embedder, opts.query, vecN);
    } catch {
      vecHits = [];
    }
  }

  if (vecHits.length === 0) {
    return ftsHits.slice(0, limit).map((h, i) => ({
      path: h.path,
      title: h.title,
      snippet: h.snippet,
      fts_rank: i,
      vector_score: null,
      score: 1 / (k + i),
    }));
  }

  const byPath = new Map<string, HybridHit>();
  ftsHits.forEach((h, i) => {
    byPath.set(h.path, {
      path: h.path,
      title: h.title,
      snippet: h.snippet,
      fts_rank: i,
      vector_score: null,
      score: (1 - vw) * (1 / (k + i)),
    });
  });
  vecHits.forEach((h, i) => {
    const existing = byPath.get(h.path);
    const vRRF = vw * (1 / (k + i));
    if (existing) {
      existing.vector_score = h.score;
      existing.score += vRRF;
    } else {
      byPath.set(h.path, {
        path: h.path,
        title: h.title,
        snippet: h.snippet || "",
        fts_rank: null,
        vector_score: h.score,
        score: vRRF,
      });
    }
  });

  return Array.from(byPath.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

interface FtsCandidate {
  path: string;
  title: string | null;
  snippet: string;
}

function ftsCandidates(db: PebbleDB, query: string, n: number): FtsCandidate[] {
  // db.searchNotes already orders by rank; reuse it but bump the limit.
  if (!query.trim()) return [];
  try {
    return db.searchNotes(query, n);
  } catch {
    // FTS5 chokes on bare punctuation; treat as no FTS hits.
    return [];
  }
}

interface VectorHit {
  path: string;
  title: string | null;
  snippet: string;
  score: number;
}

async function vectorCandidates(
  db: PebbleDB,
  embedder: EmbeddingProvider,
  query: string,
  n: number,
): Promise<VectorHit[]> {
  const [qvec] = await embedder.embed([query]);
  if (!qvec) return [];
  const stored = db.listEmbeddings(embedder.model);
  if (stored.length === 0) return [];

  const titles = new Map<string, string | null>(
    (db.raw.prepare(`SELECT path, title FROM notes`).all() as Array<{
      path: string;
      title: string | null;
    }>).map((r) => [r.path, r.title] as const),
  );

  const scored = stored
    .map((s) => {
      if (s.dim !== qvec.length) return { path: s.path, score: -1 };
      const vec = bufferToVector(s.vec);
      return { path: s.path, score: cosine(qvec, vec) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

  return scored.map((s) => ({
    path: s.path,
    title: titles.get(s.path) ?? null,
    snippet: "",
    score: s.score,
  }));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
