import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import { embedAllNotes } from "../../src/embeddings/runner.js";
import {
  bufferToVector,
  cosine,
  getEmbeddingProvider,
  makeMockEmbeddingProvider,
  makeOpenAIEmbeddingProvider,
  vectorToBuffer,
} from "../../src/embeddings/provider.js";
import { indexVault } from "../../src/indexer/index.js";
import { makeTempVault, rmRf } from "../helpers.js";

let vault = "";
let db: PebbleDB;
let dbPath = "";

beforeEach(async () => {
  vault = await makeTempVault();
  dbPath = path.join(vault, "_System", "pebble.sqlite");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  db = openDB(dbPath);
});

afterEach(async () => {
  db?.close();
  await rmRf(vault);
});

async function writeNote(rel: string, body: string): Promise<void> {
  const abs = path.join(vault, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf8");
}

describe("embedding provider — mock", () => {
  it("produces L2-normalized fixed-dim vectors", async () => {
    const p = makeMockEmbeddingProvider(64);
    const [v] = await p.embed(["hello world hello"]);
    expect(v).toBeDefined();
    expect(v!.length).toBe(64);
    let norm = 0;
    for (let i = 0; i < v!.length; i++) norm += v![i]! ** 2;
    expect(norm).toBeCloseTo(1, 5);
  });

  it("similar texts have higher cosine than dissimilar texts", async () => {
    const p = makeMockEmbeddingProvider(256);
    const [a, b, c] = await p.embed([
      "renew the domain tomorrow remind me",
      "renew the domain tomorrow remind",
      "completely unrelated trip itinerary tokyo",
    ]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });

  it("vectorToBuffer/bufferToVector round-trips losslessly", async () => {
    const p = makeMockEmbeddingProvider(32);
    const [v] = await p.embed(["round trip test"]);
    const buf = vectorToBuffer(v!);
    const back = bufferToVector(buf);
    expect(back.length).toBe(v!.length);
    for (let i = 0; i < v!.length; i++) expect(back[i]).toBeCloseTo(v![i]!, 6);
  });
});

describe("embedding provider — openai (with fakeFetch)", () => {
  it("posts to /v1/embeddings and reorders results by index", async () => {
    let captured: { url: string; body: string } | null = null;
    const fakeFetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: String(init?.body ?? "") };
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: new Array(8).fill(0.5) },
            { index: 0, embedding: new Array(8).fill(0.1) },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const p = makeOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      fetchImpl: fakeFetch,
      dim: 8,
    });
    const out = await p.embed(["a", "b"]);
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain("/v1/embeddings");
    expect(JSON.parse(captured!.body).input).toEqual(["a", "b"]);
    expect(out[0]![0]).toBeCloseTo(0.1);
    expect(out[1]![0]).toBeCloseTo(0.5);
  });

  it("rejects without an API key", () => {
    expect(() => makeOpenAIEmbeddingProvider({ apiKey: "" })).toThrowError(
      /requires PEBBLE_OPENAI_API_KEY/,
    );
  });

  it("getEmbeddingProvider('openai') reads PEBBLE_OPENAI_API_KEY from env", () => {
    const p = getEmbeddingProvider("openai", {
      PEBBLE_OPENAI_API_KEY: "sk-x",
    } as NodeJS.ProcessEnv);
    expect(p.name).toBe("openai");
  });

  it("getEmbeddingProvider('mock') ignores env", () => {
    const p = getEmbeddingProvider("mock");
    expect(p.name).toBe("mock");
    expect(p.dim).toBe(128);
  });

  it("getEmbeddingProvider rejects unknown providers", () => {
    expect(() => getEmbeddingProvider("nope")).toThrowError(/unknown embedding provider/);
  });
});

describe("embedAllNotes runner", () => {
  it("embeds each indexed note exactly once when run twice", async () => {
    await writeNote("Inbox/2026-05-02.md", "# Inbox\n\nrenew the domain tomorrow");
    await writeNote("Sources/iMessage/self.md", "# Self\n\nidea: pebble plugin");
    await indexVault({ vaultPath: vault, db });

    const provider = makeMockEmbeddingProvider(64);
    const r1 = await embedAllNotes({ db, provider });
    expect(r1.scanned).toBe(2);
    expect(r1.embedded).toBe(2);
    expect(r1.skipped).toBe(0);
    expect(db.countEmbeddings(provider.model)).toBe(2);

    // Second run: content_hash matches → skip.
    const r2 = await embedAllNotes({ db, provider });
    expect(r2.embedded).toBe(0);
    expect(r2.skipped).toBe(2);
    expect(db.countEmbeddings(provider.model)).toBe(2);
  });

  it("re-embeds when --force is passed", async () => {
    await writeNote("Inbox/x.md", "# x\n\nbody");
    await indexVault({ vaultPath: vault, db });
    const provider = makeMockEmbeddingProvider(32);

    await embedAllNotes({ db, provider });
    const r = await embedAllNotes({ db, provider, force: true });
    expect(r.embedded).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it("writes a vector that matches the provider's dim", async () => {
    await writeNote("Inbox/y.md", "# y\n\nbody body body");
    await indexVault({ vaultPath: vault, db });
    const provider = makeMockEmbeddingProvider(48);

    await embedAllNotes({ db, provider });
    const stored = db.listEmbeddings(provider.model);
    expect(stored.length).toBe(1);
    expect(stored[0]!.dim).toBe(48);
    expect(stored[0]!.vec.byteLength).toBe(48 * 4);
    const back = bufferToVector(stored[0]!.vec);
    expect(back.length).toBe(48);
  });

  it("skips notes with empty body", async () => {
    await writeNote("Inbox/empty.md", "---\ntitle: empty\n---\n\n");
    await indexVault({ vaultPath: vault, db });
    const provider = makeMockEmbeddingProvider(16);

    const r = await embedAllNotes({ db, provider });
    expect(r.embedded).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it("re-embeds when content changes but hash check is per-model", async () => {
    await writeNote("Inbox/z.md", "# z\n\nfirst version");
    await indexVault({ vaultPath: vault, db });
    const p1 = makeMockEmbeddingProvider(32);
    await embedAllNotes({ db, provider: p1 });

    // change the body on disk
    await writeNote("Inbox/z.md", "# z\n\ntotally different content here");

    const r = await embedAllNotes({ db, provider: p1 });
    expect(r.embedded).toBe(1);
    expect(r.skipped).toBe(0);
  });
});
