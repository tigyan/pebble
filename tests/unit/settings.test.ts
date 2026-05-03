import { describe, expect, it } from "vitest";
import {
  DEFAULT_INGEST_FILTER,
  effectiveIngestFilter,
  evaluateIngestFilter,
  IngestFilterSettingsSchema,
} from "../../src/settings/store.js";

describe("IngestFilterSettingsSchema", () => {
  it("defaults to mode=off with empty allow/deny lists", () => {
    expect(DEFAULT_INGEST_FILTER).toEqual({
      mode: "off",
      senders: [],
      threads: [],
    });
  });

  it("rejects unknown modes", () => {
    expect(() =>
      IngestFilterSettingsSchema.parse({ mode: "weird", senders: [], threads: [] }),
    ).toThrow();
  });

  it("rejects empty-string entries in lists (z.string().min(1))", () => {
    expect(() =>
      IngestFilterSettingsSchema.parse({ mode: "allowlist", senders: [""], threads: [] }),
    ).toThrow();
  });
});

describe("effectiveIngestFilter", () => {
  it("returns full defaults when no overlay is set", () => {
    expect(effectiveIngestFilter({})).toEqual(DEFAULT_INGEST_FILTER);
  });

  it("merges partial overlay over defaults", () => {
    const eff = effectiveIngestFilter({
      ingest_filter: { mode: "allowlist", senders: ["+1234"] },
    });
    expect(eff.mode).toBe("allowlist");
    expect(eff.senders).toEqual(["+1234"]);
    expect(eff.threads).toEqual([]);
  });
});

describe("evaluateIngestFilter", () => {
  it("mode=off allows everything regardless of lists", () => {
    expect(
      evaluateIngestFilter(
        { mode: "off", senders: ["nope"], threads: ["nope"] },
        "anyone",
        "any-thread",
      ),
    ).toEqual({ allow: true });
  });

  describe("allowlist", () => {
    it("allows when sender matches", () => {
      expect(
        evaluateIngestFilter(
          { mode: "allowlist", senders: ["+15550001111"], threads: [] },
          "+15550001111",
          "iMessage;-;+15550001111",
        ),
      ).toEqual({ allow: true });
    });

    it("allows when thread matches even if sender does not", () => {
      expect(
        evaluateIngestFilter(
          { mode: "allowlist", senders: [], threads: ["chat-guid-123"] },
          "stranger",
          "chat-guid-123",
        ),
      ).toEqual({ allow: true });
    });

    it("rejects with reason=not_in_allowlist when nothing matches", () => {
      expect(
        evaluateIngestFilter(
          { mode: "allowlist", senders: ["+1"], threads: ["t1"] },
          "+2",
          "t2",
        ),
      ).toEqual({ allow: false, reason: "not_in_allowlist" });
    });

    it("rejects everything when allowlist is empty (documented footgun)", () => {
      expect(
        evaluateIngestFilter(
          { mode: "allowlist", senders: [], threads: [] },
          "anyone",
          "any-thread",
        ),
      ).toEqual({ allow: false, reason: "not_in_allowlist" });
    });
  });

  describe("denylist", () => {
    it("rejects with reason=denylist when sender matches", () => {
      expect(
        evaluateIngestFilter(
          { mode: "denylist", senders: ["spammer"], threads: [] },
          "spammer",
          "any-thread",
        ),
      ).toEqual({ allow: false, reason: "denylist" });
    });

    it("rejects when thread matches", () => {
      expect(
        evaluateIngestFilter(
          { mode: "denylist", senders: [], threads: ["bad-thread"] },
          "ok",
          "bad-thread",
        ),
      ).toEqual({ allow: false, reason: "denylist" });
    });

    it("allows when nothing matches", () => {
      expect(
        evaluateIngestFilter(
          { mode: "denylist", senders: ["spammer"], threads: ["bad"] },
          "friend",
          "good-thread",
        ),
      ).toEqual({ allow: true });
    });

    it("allows everything when denylist is empty", () => {
      expect(
        evaluateIngestFilter(
          { mode: "denylist", senders: [], threads: [] },
          "anyone",
          "any-thread",
        ),
      ).toEqual({ allow: true });
    });
  });
});
