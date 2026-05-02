import { describe, expect, it } from "vitest";
import { findNearDuplicate, jaccard, shingles } from "../../src/ingest/near-dup.js";
import type { IngestRecord } from "../../src/types/index.js";

function rec(id: string, text: string): IngestRecord {
  return {
    id,
    source: "manual",
    sender: "self",
    thread_id: "self",
    text,
    attachments: [],
    timestamp: "2026-05-02T09:00:00.000Z",
    received_at: "2026-05-02T09:00:00.000Z",
    status: "raw",
    original_text_hash: id,
    inbox_path: "",
    thread_path: "",
    person_path: "",
  };
}

describe("shingles + jaccard", () => {
  it("produces overlapping word k-shingles", () => {
    const s = shingles("the quick brown fox jumps", 3);
    expect(s.size).toBe(3);
    expect(s.has("the quick brown")).toBe(true);
    expect(s.has("quick brown fox")).toBe(true);
    expect(s.has("brown fox jumps")).toBe(true);
  });

  it("is case-insensitive and ignores punctuation", () => {
    const a = shingles("Hello, world! Hello.", 2);
    const b = shingles("hello world hello", 2);
    expect(jaccard(a, b)).toBe(1);
  });

  it("falls back to a single-token shingle when text is shorter than k", () => {
    const s = shingles("hi", 3);
    expect(s.size).toBe(1);
    expect(s.has("hi")).toBe(true);
  });

  it("jaccard of disjoint sets is 0", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
});

describe("findNearDuplicate", () => {
  it("returns the highest-scoring candidate above threshold", () => {
    const candidates = [
      rec("c1", "buy milk and eggs from the corner store"),
      rec("c2", "renew the domain name before it expires"),
      rec("c3", "remember to buy milk eggs and bread"),
    ];
    const hit = findNearDuplicate(
      "remember to buy milk and eggs from the store",
      candidates,
      { k: 2, threshold: 0.3 },
    );
    expect(hit).not.toBeNull();
    // c1 shares "buy milk", "milk and", "and eggs", "from the", "the store"
    // → it should beat c3 which only shares "buy milk".
    expect(hit!.candidate.id).toBe("c1");
    expect(hit!.score).toBeGreaterThan(0.3);
  });

  it("returns null when no candidate clears the threshold", () => {
    const hit = findNearDuplicate(
      "totally unrelated content about astronomy and stars",
      [rec("c1", "buy milk and eggs at the store")],
      { k: 3, threshold: 0.6 },
    );
    expect(hit).toBeNull();
  });

  it("skips messages too short for k-shingle comparison", () => {
    // input "hi" has 0 valid 3-shingles, so we can't compare
    const hit = findNearDuplicate("hi", [rec("c1", "the quick brown fox jumps over")], {
      k: 3,
      threshold: 0.5,
    });
    expect(hit).toBeNull();
  });

  it("respects custom minShingles to suppress noisy short-text matches", () => {
    const hit = findNearDuplicate(
      "buy milk", // produces 1 fallback shingle
      [rec("c1", "buy milk")],
      { k: 3, threshold: 0.1, minShingles: 5 },
    );
    expect(hit).toBeNull();
  });
});
