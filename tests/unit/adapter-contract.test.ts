import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADAPTERS, normalize } from "../../src/adapters/index.js";
import { manualAdapter } from "../../src/adapters/manual.js";
import { IngestPayloadSchema } from "../../src/types/index.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

type Case = {
  adapter: string;
  fixture: string;
  headers?: Record<string, string>;
};

// Each non-manual adapter MUST own at least one fixture here. Add a row
// when you add an adapter; the contract tests below run against every row.
const CASES: Case[] = [
  { adapter: "bluebubbles", fixture: "imessage.bluebubbles.json" },
  { adapter: "sendblue", fixture: "sendblue.json" },
];

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(FIX, name), "utf8"));
}

describe("adapter contract", () => {
  it("every registered adapter has a unique name; manual is the catch-all and is last", () => {
    const names = ADAPTERS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names[names.length - 1]).toBe("manual");
    expect(names.indexOf("manual")).toBe(names.length - 1);
  });

  it("manual adapter matches everything (catch-all invariant)", () => {
    expect(manualAdapter.matches({}, { anything: true })).toBe(true);
    expect(manualAdapter.matches({}, {})).toBe(true);
  });

  for (const c of CASES) {
    describe(`${c.adapter} (${c.fixture})`, () => {
      it("matches its own fixture and produces a schema-valid payload", async () => {
        const body = await loadFixture(c.fixture);
        const { adapter, payload } = normalize(c.headers ?? {}, body);
        expect(adapter).toBe(c.adapter);
        // normalize() already calls .parse(), but assert explicitly for the contract.
        expect(() => IngestPayloadSchema.parse(payload)).not.toThrow();
      });

      it("does not match other adapters' fixtures (no false positives)", async () => {
        const others = CASES.filter((x) => x.adapter !== c.adapter);
        const own = ADAPTERS.find((a) => a.name === c.adapter);
        expect(own).toBeDefined();
        for (const o of others) {
          const body = await loadFixture(o.fixture);
          expect(own!.matches({}, body)).toBe(false);
        }
      });
    });
  }

  it("rejects garbage bodies via the manual fallback (throws on non-object)", () => {
    expect(() => normalize({}, "not-an-object")).toThrow();
    expect(() => normalize({}, null)).toThrow();
  });
});
