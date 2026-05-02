import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeIngestion } from "../../src/vault/writer.js";
import { makeTempVault, rmRf } from "../helpers.js";

let vault = "";

beforeEach(async () => {
  vault = await makeTempVault();
});
afterEach(async () => {
  await rmRf(vault);
});

describe("vault writer", () => {
  it("creates Inbox/Sources/People notes on first message and appends on second", async () => {
    const ts = "2026-05-02T09:00:00.000Z";
    const r1 = await writeIngestion(
      {
        source: "imessage",
        sender: "+15551112222",
        thread_id: "thread-A",
        text: "first message",
        timestamp: ts,
      },
      { vaultPath: vault },
    );

    expect(r1.record.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(r1.wrote.inbox).toBe(path.join(vault, "Inbox", "2026-05-02.md"));
    expect(r1.wrote.thread).toContain(path.join("Sources", "iMessage"));

    const r2 = await writeIngestion(
      {
        source: "imessage",
        sender: "+15551112222",
        thread_id: "thread-A",
        text: "second message",
        timestamp: ts,
      },
      { vaultPath: vault },
    );

    const inbox = await fs.readFile(r2.wrote.inbox, "utf8");
    expect(inbox).toContain("first message");
    expect(inbox).toContain("second message");

    const thread = await fs.readFile(r2.wrote.thread, "utf8");
    expect(thread).toMatch(/^---/); // frontmatter
    expect(thread).toContain("first message");
    expect(thread).toContain("second message");

    const log = await fs.readFile(
      path.join(vault, "_System", "ingestion-log.jsonl"),
      "utf8",
    );
    expect(log.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("never overwrites existing inbox content", async () => {
    const inboxPath = path.join(vault, "Inbox", "2026-05-02.md");
    await fs.mkdir(path.dirname(inboxPath), { recursive: true });
    await fs.writeFile(inboxPath, "# user-authored content\n", "utf8");

    await writeIngestion(
      {
        source: "manual",
        sender: "self",
        thread_id: "self",
        text: "appended message",
        timestamp: "2026-05-02T10:00:00.000Z",
      },
      { vaultPath: vault },
    );

    const inbox = await fs.readFile(inboxPath, "utf8");
    expect(inbox.startsWith("# user-authored content")).toBe(true);
    expect(inbox).toContain("appended message");
  });
});
