import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import { embedAllNotes } from "../../src/embeddings/runner.js";
import { makeMockEmbeddingProvider } from "../../src/embeddings/provider.js";
import { searchHybrid } from "../../src/embeddings/search.js";
import { indexVault } from "../../src/indexer/index.js";
import { makeTempVault, rmRf } from "../helpers.js";

let vault = "";
let db: PebbleDB;

beforeEach(async () => {
  vault = await makeTempVault();
  const dbPath = path.join(vault, "_System", "pebble.sqlite");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  db = openDB(dbPath);
});
afterEach(async () => {
  db?.close();
  await rmRf(vault);
});

async function note(rel: string, body: string): Promise<void> {
  const abs = path.join(vault, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf8");
}

describe("hybrid search (FTS + vector)", () => {
  it("falls back to FTS-only when no embeddings exist", async () => {
    await note("Inbox/a.md", "# A\n\nrenew the domain tomorrow");
    await note("Inbox/b.md", "# B\n\ntotally unrelated tokyo trip");
    await indexVault({ vaultPath: vault, db });

    const hits = await searchHybrid({ db, query: "renew domain" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toContain("a.md");
    expect(hits[0]!.vector_score).toBeNull();
    expect(hits[0]!.fts_rank).toBe(0);
  });

  it("blends FTS and vector candidates by RRF", async () => {
    await note(
      "Inbox/exact.md",
      "# Exact term match\n\nThis note literally says renew domain.",
    );
    await note(
      "Inbox/semantic.md",
      "# Reminder about subscriptions\n\nrenew renew renew domain domain domain " +
        "subscription subscription subscription expiration expiration expiration",
    );
    await note("Inbox/unrelated.md", "# Unrelated\n\ngrocery list eggs milk bread");
    await indexVault({ vaultPath: vault, db });

    const provider = makeMockEmbeddingProvider(64);
    await embedAllNotes({ db, provider });

    const hits = await searchHybrid({
      db,
      query: "renew domain",
      embedder: provider,
      vectorWeight: 0.5,
    });
    expect(hits.length).toBeGreaterThan(0);
    // The semantic + lexical winner should rank above the unrelated note.
    const paths = hits.map((h) => h.path);
    const exactIdx = paths.findIndex((p) => p.endsWith("exact.md"));
    const semanticIdx = paths.findIndex((p) => p.endsWith("semantic.md"));
    const unrelatedIdx = paths.findIndex((p) => p.endsWith("unrelated.md"));
    expect(exactIdx).toBeGreaterThanOrEqual(0);
    expect(semanticIdx).toBeGreaterThanOrEqual(0);
    if (unrelatedIdx >= 0) {
      expect(unrelatedIdx).toBeGreaterThan(exactIdx);
    }
    // At least one hit should carry a vector_score (vector pass fired).
    const withVec = hits.filter((h) => h.vector_score !== null);
    expect(withVec.length).toBeGreaterThan(0);
  });

  it("vectorWeight=1 pure vector still returns the most similar note", async () => {
    await note("Inbox/a.md", "# A\n\nrenew the domain tomorrow before it expires");
    await note("Inbox/b.md", "# B\n\ngrocery list eggs milk bread");
    await indexVault({ vaultPath: vault, db });
    const provider = makeMockEmbeddingProvider(64);
    await embedAllNotes({ db, provider });

    const hits = await searchHybrid({
      db,
      query: "renew domain",
      embedder: provider,
      vectorWeight: 1,
    });
    expect(hits[0]!.path).toContain("a.md");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await note(`Inbox/n${i}.md`, `# N${i}\n\ndomain renew note number ${i}`);
    }
    await indexVault({ vaultPath: vault, db });
    const provider = makeMockEmbeddingProvider(32);
    await embedAllNotes({ db, provider });

    const hits = await searchHybrid({ db, query: "domain", embedder: provider, limit: 2 });
    expect(hits.length).toBe(2);
  });
});
