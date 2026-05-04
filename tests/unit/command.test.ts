import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import {
  CommandResultSchema,
  type CommandResult,
} from "../../src/types/index.js";
import {
  type CommandProvider,
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

  it("throws on non-/do text", async () => {
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
