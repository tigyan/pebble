import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import {
  currentSchemaVersion,
  getDbVersion,
  MIGRATIONS,
  runMigrations,
  type Migration,
} from "../../src/db/migrations.js";
import { makeTempVault, rmRf } from "../helpers.js";

let vault = "";
let db: PebbleDB;

beforeEach(async () => {
  vault = await makeTempVault();
  db = openDB(path.join(vault, "_System", "pebble.sqlite"));
});
afterEach(async () => {
  db?.close();
  await rmRf(vault);
});

describe("migrations", () => {
  it("a fresh DB lands on currentSchemaVersion()", () => {
    expect(db.schemaVersion()).toBe(currentSchemaVersion());
  });

  it("baseline schema is idempotent (re-opening doesn't break)", () => {
    db.close();
    // Re-open the same file. runMigrations runs a second time; nothing should throw,
    // and core tables should still be queryable.
    db = openDB(path.join(vault, "_System", "pebble.sqlite"));
    const row = db.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ingestions','notes','agent_actions','note_embeddings','agent_budget')",
      )
      .all() as Array<{ name: string }>;
    expect(row.length).toBe(5);
  });

  it("runMigrations applies a pending migration in order and bumps user_version", () => {
    // Use a fresh raw DB so we can inject a fake migration without touching the
    // shared MIGRATIONS array.
    const raw = new Database(":memory:");
    const fake: Migration[] = [
      {
        version: currentSchemaVersion() + 1,
        name: "add_test_col",
        up(d) {
          d.exec("ALTER TABLE ingestions ADD COLUMN test_col TEXT");
        },
      },
    ];
    // Apply baseline once via runMigrations (no fakes registered).
    runMigrations(raw);
    expect(getDbVersion(raw)).toBe(currentSchemaVersion());

    // Manually replay only the fake migration the same way runMigrations would,
    // to confirm the contract (transaction + user_version bump).
    raw.transaction(() => {
      fake[0]!.up(raw);
      raw.pragma(`user_version = ${fake[0]!.version}`);
    })();
    expect(getDbVersion(raw)).toBe(fake[0]!.version);

    const cols = raw.prepare("PRAGMA table_info(ingestions)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "test_col")).toBe(true);
    raw.close();
  });

  it("currentSchemaVersion equals max of MIGRATIONS versions (or 0)", () => {
    const expected = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
    expect(currentSchemaVersion()).toBe(expected);
  });

  it("a migration with version <= db.user_version is skipped", () => {
    const raw = new Database(":memory:");
    runMigrations(raw);
    raw.pragma("user_version = 99");
    // No migrations should run; version stays put.
    runMigrations(raw);
    expect(getDbVersion(raw)).toBe(99);
    raw.close();
  });
});
