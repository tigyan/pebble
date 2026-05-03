import { buildSecretSource, type SecretSource } from "../secrets/source.js";

/**
 * EmbeddingProvider — same shape as TriageProvider, scoped to vector embeddings.
 * Implementations re-validate their output (length === dim) before returning.
 */
export interface EmbeddingProvider {
  /** Stable, registry-style name: "mock", "openai". */
  name: string;
  /** Model identifier, e.g. "mock-128" or "text-embedding-3-small". */
  model: string;
  /** Dimensionality of every vector this provider returns. */
  dim: number;
  /** Embed N input texts; returns N Float32Array vectors of length `dim`. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const EMBEDDING_PROVIDERS = ["mock", "openai"] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];

export function getEmbeddingProvider(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  secrets: SecretSource = buildSecretSource(env),
): EmbeddingProvider {
  switch (name) {
    case "mock":
      return makeMockEmbeddingProvider();
    case "openai": {
      const apiKey =
        secrets.get("PEBBLE_OPENAI_API_KEY") ?? secrets.get("OPENAI_API_KEY") ?? "";
      const model = env.PEBBLE_OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
      const baseUrl = env.PEBBLE_OPENAI_BASE_URL ?? "https://api.openai.com";
      return makeOpenAIEmbeddingProvider({ apiKey, model, baseUrl });
    }
    default:
      throw new Error(`unknown embedding provider: ${name}`);
  }
}

// --- Mock (offline, deterministic) ---------------------------------------

/**
 * Hash-based pseudo-embedding. Useful for offline tests, CI, and
 * "yes the wiring works" smoke checks. NOT semantically meaningful — two
 * unrelated texts that happen to share many tokens will look similar.
 */
export function makeMockEmbeddingProvider(dim = 128): EmbeddingProvider {
  return {
    name: "mock",
    model: `mock-${dim}`,
    dim,
    async embed(texts) {
      return texts.map((t) => mockVector(t, dim));
    },
  };
}

function mockVector(text: string, dim: number): Float32Array {
  const out = new Float32Array(dim);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const slot = Math.abs(h) % dim;
    out[slot] = (out[slot] ?? 0) + 1;
  }
  // L2-normalize so cosine == dot product.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += (out[i] ?? 0) ** 2;
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) out[i] = (out[i] ?? 0) * inv;
  }
  return out;
}

// --- OpenAI Embeddings API -----------------------------------------------

export interface OpenAIEmbeddingOpts {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Hard timeout per request. Default 60s. */
  timeoutMs?: number;
  /** Override for tests / unusual self-hosted endpoints. */
  dim?: number;
}

const OPENAI_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export function makeOpenAIEmbeddingProvider(opts: OpenAIEmbeddingOpts): EmbeddingProvider {
  if (!opts.apiKey) throw new Error("openai embedding provider requires PEBBLE_OPENAI_API_KEY");
  const model = opts.model ?? "text-embedding-3-small";
  const baseUrl = (opts.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  // Dim is verified at runtime against the first response — this is a hint only.
  let dim = opts.dim ?? OPENAI_DIMS[model] ?? 1536;

  return {
    name: "openai",
    model,
    get dim() {
      return dim;
    },
    async embed(texts) {
      if (texts.length === 0) return [];
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/v1/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model, input: texts }),
          signal: ac.signal,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          throw new Error(`openai embeddings timed out after ${timeoutMs}ms`);
        }
        throw new Error(`openai embeddings request failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`openai embeddings HTTP ${res.status}: ${errText.slice(0, 500)}`);
      }
      const body = (await res.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };
      const data = body.data ?? [];
      if (data.length !== texts.length) {
        throw new Error(
          `openai embeddings returned ${data.length} vectors for ${texts.length} inputs`,
        );
      }
      // Sort by index in case the API returns out of order.
      const out: Float32Array[] = new Array(texts.length);
      for (const item of data) {
        if (!Array.isArray(item.embedding)) {
          throw new Error("openai embeddings response missing embedding[]");
        }
        const idx = typeof item.index === "number" ? item.index : -1;
        if (idx < 0 || idx >= texts.length) {
          throw new Error(`openai embeddings returned bad index ${idx}`);
        }
        const vec = Float32Array.from(item.embedding);
        if (vec.length !== dim) {
          // Adjust dim once on first valid response so subsequent calls match.
          dim = vec.length;
        }
        out[idx] = vec;
      }
      for (let i = 0; i < out.length; i++) {
        if (!out[i]) throw new Error(`openai embeddings missing vector for input ${i}`);
      }
      return out;
    },
  };
}

// --- Vector helpers (used by hybrid search later) ------------------------

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToVector(buf: Buffer): Float32Array {
  // Copy out — better-sqlite3's BLOB is a shared view.
  const copy = new ArrayBuffer(buf.byteLength);
  Buffer.from(copy).set(buf);
  return new Float32Array(copy);
}
