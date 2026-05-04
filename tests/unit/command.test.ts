import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import {
  CommandResultSchema,
  type CommandResult,
  type CommandStep,
} from "../../src/types/index.js";
import {
  type CommandProvider,
  DoEchoCache,
  mockCommandProvider,
  parseDoCommand,
  runCommand,
} from "../../src/agent/command.js";
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

describe("parseDoCommand", () => {
  it("returns null for non-/do text", () => {
    expect(parseDoCommand("hello world")).toBeNull();
    expect(parseDoCommand("")).toBeNull();
    expect(parseDoCommand("do something")).toBeNull();
  });

  it("strips the prefix and trims whitespace", () => {
    expect(parseDoCommand("/do расписать треугольники")).toEqual({
      instruction: "расписать треугольники",
    });
    expect(parseDoCommand("  /do   foo  ")).toEqual({ instruction: "foo" });
  });

  it("is case-insensitive on the prefix", () => {
    expect(parseDoCommand("/DO foo")).toEqual({ instruction: "foo" });
    expect(parseDoCommand("/Do bar")).toEqual({ instruction: "bar" });
  });

  it("accepts /do: as a separator", () => {
    expect(parseDoCommand("/do: write notes")).toEqual({ instruction: "write notes" });
  });

  it("rejects an empty instruction", () => {
    expect(parseDoCommand("/do   ")).toBeNull();
    expect(parseDoCommand("/do")).toBeNull();
  });

  it("does not match /done or other prefixes that start with /do", () => {
    expect(parseDoCommand("/done with this")).toBeNull();
    expect(parseDoCommand("/document foo")).toBeNull();
  });
});

describe("mockCommandProvider", () => {
  it("creates a new note under Inbox/ when no candidate matches", async () => {
    const result = await mockCommandProvider.generate({
      instruction: "Расписать признаки подобия треугольников в заметке «Геометрия»",
      candidates: [],
    });
    expect(result.action).toBe("create");
    expect(result.target_path.startsWith("Inbox/")).toBe(true);
    expect(result.target_path.endsWith(".md")).toBe(true);
    expect(result.markdown.length).toBeGreaterThan(0);
    // Round-trip through the schema to make sure the shape is canonical.
    expect(() => CommandResultSchema.parse(result)).not.toThrow();
  });

  it("appends to a candidate when its title matches the quoted target", async () => {
    const result = await mockCommandProvider.generate({
      instruction: "Допиши в «Учеба» три признака подобия",
      candidates: [{ path: "Notes/Учеба.md", title: "Учеба" }],
    });
    expect(result.action).toBe("append");
    expect(result.target_path).toBe("Notes/Учеба.md");
  });
});

describe("runCommand", () => {
  it("creates a vault-local file from a /do request", async () => {
    const stub: CommandProvider = {
      name: "stub",
      async generate(): Promise<CommandResult> {
        return CommandResultSchema.parse({
          action: "create",
          target_path: "Notes/Учеба.md",
          markdown: "# Учеба\n\n- признак 1\n- признак 2\n- признак 3\n",
          rationale: "stub",
        });
      },
    };
    const r = await runCommand({
      text: "/do расписать признаки подобия в «Учеба»",
      vaultPath: vault,
      db,
      provider: stub,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("create");
    expect(r.target_path).toBe("Notes/Учеба.md");
    const written = await fs.readFile(path.join(vault, "Notes", "Учеба.md"), "utf8");
    expect(written).toContain("признак 1");
  });

  it("falls back from create to append when the file already exists", async () => {
    const target = path.join(vault, "Notes", "Учеба.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "# Учеба\n", "utf8");

    const stub: CommandProvider = {
      name: "stub",
      async generate() {
        return CommandResultSchema.parse({
          action: "create",
          target_path: "Notes/Учеба.md",
          markdown: "## Подобие\n- признак 1\n",
        });
      },
    };
    const r = await runCommand({
      text: "/do добавь признаки в «Учеба»",
      vaultPath: vault,
      db,
      provider: stub,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("append");
    expect(r.fell_back).toBe("create_to_append");
    const after = await fs.readFile(target, "utf8");
    expect(after).toContain("# Учеба");
    expect(after).toContain("признак 1");
  });

  it("refuses target_path that escapes the vault", async () => {
    const evil: CommandProvider = {
      name: "evil",
      async generate() {
        return CommandResultSchema.parse({
          action: "create",
          target_path: "../../../etc/passwd.md",
          markdown: "haha",
        });
      },
    };
    await expect(
      runCommand({
        text: "/do escape attempt",
        vaultPath: vault,
        db,
        provider: evil,
      }),
    ).rejects.toThrow(/contains \.\./);
  });

  it("normalizes a missing .md suffix on target_path", async () => {
    const stub: CommandProvider = {
      name: "stub",
      async generate() {
        return CommandResultSchema.parse({
          action: "create",
          target_path: "Notes/Foo",
          markdown: "body\n",
        });
      },
    };
    const r = await runCommand({
      text: "/do anything",
      vaultPath: vault,
      db,
      provider: stub,
    });
    expect(r.target_path).toBe("Notes/Foo.md");
    await fs.access(path.join(vault, "Notes", "Foo.md"));
  });

});

describe("DoEchoCache", () => {
  it("returns false on first hit and true on a repeat within window", () => {
    const cache = new DoEchoCache(60_000);
    expect(cache.hit("alice", "t1", "/do foo", 1_000)).toBe(false);
    expect(cache.hit("alice", "t1", "/do foo", 2_000)).toBe(true);
  });

  it("expires entries past the window", () => {
    const cache = new DoEchoCache(1_000);
    expect(cache.hit("alice", "t1", "/do foo", 0)).toBe(false);
    expect(cache.hit("alice", "t1", "/do foo", 2_000)).toBe(false);
  });

  it("distinguishes sender, thread, and text", () => {
    const cache = new DoEchoCache(60_000);
    expect(cache.hit("alice", "t1", "/do foo", 0)).toBe(false);
    expect(cache.hit("bob", "t1", "/do foo", 0)).toBe(false);
    expect(cache.hit("alice", "t2", "/do foo", 0)).toBe(false);
    expect(cache.hit("alice", "t1", "/do bar", 0)).toBe(false);
  });

  it("disables when windowMs <= 0", () => {
    const cache = new DoEchoCache(0);
    expect(cache.hit("a", "t", "x", 0)).toBe(false);
    expect(cache.hit("a", "t", "x", 1)).toBe(false);
  });
});

describe("runCommand misc", () => {
  it("rejects non-/do text upfront", async () => {
    await expect(
      runCommand({
        text: "just a plain note",
        vaultPath: vault,
        db,
        provider: mockCommandProvider,
      }),
    ).rejects.toThrow(/not a \/do command/);
  });
});

describe("runCommand tool loop", () => {
  it("calls step() iteratively, serves reads, then writes", async () => {
    const target = path.join(vault, "Notes", "Учеба.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "# Учеба\n\n- признак AA\n", "utf8");

    const calls: { reads: string[] }[] = [];
    const provider = {
      name: "loop-stub",
      async generate(): Promise<CommandResult> {
        throw new Error("step() should be used");
      },
      async step({ reads }: { reads: { path: string; content: string }[] }): Promise<CommandStep> {
        calls.push({ reads: reads.map((r) => r.path) });
        if (reads.length === 0) {
          return { action: "read", paths: ["Notes/Учеба.md"] };
        }
        // Saw the existing content; now append without duplicating "AA".
        expect(reads[0]?.content).toContain("признак AA");
        return CommandResultSchema.parse({
          action: "append",
          target_path: "Notes/Учеба.md",
          markdown: "- признак SAS\n- признак SSS\n",
          rationale: "extending existing list",
        });
      },
    };

    const r = await runCommand({
      text: "/do добавь оставшиеся признаки в «Учеба»",
      vaultPath: vault,
      db,
      provider,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("append");
    expect(r.steps).toBe(2);
    expect(r.reads).toEqual(["Notes/Учеба.md"]);
    expect(calls.length).toBe(2);
    expect(calls[0]?.reads).toEqual([]);
    expect(calls[1]?.reads).toEqual(["Notes/Учеба.md"]);
    const after = await fs.readFile(target, "utf8");
    expect(after).toContain("признак AA");
    expect(after).toContain("признак SAS");
  });

  it("throws when the provider only requests reads up to maxSteps", async () => {
    const provider = {
      name: "stuck",
      async generate(): Promise<CommandResult> {
        throw new Error("unused");
      },
      async step(): Promise<CommandStep> {
        return { action: "read", paths: ["Notes/Foo.md"] };
      },
    };
    await expect(
      runCommand({
        text: "/do anything",
        vaultPath: vault,
        db,
        provider,
        maxSteps: 2,
      }),
    ).rejects.toThrow(/exceeded maxSteps/);
  });

  it("surfaces a missing read to the next step rather than crashing", async () => {
    let round = 0;
    const provider = {
      name: "miss",
      async generate(): Promise<CommandResult> {
        throw new Error("unused");
      },
      async step({ reads }: { reads: { path: string; content: string }[] }): Promise<CommandStep> {
        round++;
        if (round === 1) {
          return { action: "read", paths: ["Notes/DoesNotExist.md"] };
        }
        expect(reads[0]?.content).toMatch(/read failed/i);
        return CommandResultSchema.parse({
          action: "create",
          target_path: "Notes/Recovered.md",
          markdown: "fallback body\n",
        });
      },
    };
    const r = await runCommand({
      text: "/do recover",
      vaultPath: vault,
      db,
      provider,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("create");
    expect(r.steps).toBe(2);
  });

  it("falls back to generate() when the provider doesn't implement step()", async () => {
    const provider = {
      name: "no-step",
      async generate() {
        return CommandResultSchema.parse({
          action: "create",
          target_path: "Notes/SingleShot.md",
          markdown: "body\n",
        });
      },
    };
    const r = await runCommand({
      text: "/do legacy provider",
      vaultPath: vault,
      db,
      provider,
    });
    expect(r.ok).toBe(true);
    expect(r.steps).toBeUndefined();
    expect(r.reads).toBeUndefined();
  });
});
