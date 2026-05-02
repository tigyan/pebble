import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetExhausted, BudgetTracker, RateLimiter } from "../../src/agent/budget.js";
import { openDB, type PebbleDB } from "../../src/db/client.js";
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

describe("BudgetTracker", () => {
  it("returns zeroed usage when no rows exist", () => {
    const t = new BudgetTracker({ db });
    const u = t.usage("mock", 10);
    expect(u.calls_used).toBe(0);
    expect(u.calls_limit).toBe(10);
    expect(u.remaining).toBe(10);
  });

  it("treats limit=0 as unlimited (remaining=Infinity)", () => {
    const t = new BudgetTracker({ db });
    expect(t.usage("mock", 0).remaining).toBe(Infinity);
    t.charge("mock", 100);
    expect(() => t.ensureAvailable("mock", 0)).not.toThrow();
  });

  it("charges accumulate per (day, model)", () => {
    const t = new BudgetTracker({ db });
    t.charge("mock", 3, 100);
    t.charge("mock", 2, 50);
    t.charge("openai", 1, 25);
    expect(t.usage("mock", 0).calls_used).toBe(5);
    expect(t.usage("mock", 0).tokens_used).toBe(150);
    expect(t.usage("openai", 0).calls_used).toBe(1);
  });

  it("ensureAvailable throws BudgetExhausted at the limit", () => {
    const t = new BudgetTracker({ db });
    t.charge("mock", 5);
    expect(() => t.ensureAvailable("mock", 5)).toThrow(BudgetExhausted);
    expect(() => t.ensureAvailable("mock", 6)).not.toThrow();
  });

  it("uses UTC day boundary", () => {
    const noon = new Date("2026-05-02T12:00:00Z");
    const t = new BudgetTracker({ db, now: () => noon });
    t.charge("mock", 1);
    expect(t.usage("mock", 0).day).toBe("2026-05-02");
  });
});

describe("RateLimiter (token bucket)", () => {
  it("rate=0 means unlimited", async () => {
    const rl = new RateLimiter({ ratePerMinute: 0 });
    for (let i = 0; i < 100; i++) expect(rl.tryAcquire()).toBe(true);
    await rl.acquire();
  });

  it("burst caps the initial allotment", () => {
    const rl = new RateLimiter({ ratePerMinute: 60, burst: 3 });
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(false);
  });

  it("refills over time", () => {
    let now = 0;
    const rl = new RateLimiter({ ratePerMinute: 60, burst: 1, now: () => now });
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(false);
    // 60/min = 1/sec → after 1500 ms we have 1.5 tokens (capped at burst=1).
    now = 1500;
    expect(rl.tryAcquire()).toBe(true);
  });

  it("acquire awaits when bucket empty", async () => {
    let now = 0;
    const slept: number[] = [];
    const rl = new RateLimiter({
      ratePerMinute: 60,
      burst: 1,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    expect(rl.tryAcquire()).toBe(true); // consume the only token
    await rl.acquire(); // must wait ~1000 ms
    expect(slept.length).toBeGreaterThan(0);
    expect(slept[0]).toBeGreaterThanOrEqual(900);
    expect(slept[0]).toBeLessThanOrEqual(1100);
  });
});
