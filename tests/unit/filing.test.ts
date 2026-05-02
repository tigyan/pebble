import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDB, type PebbleDB } from "../../src/db/client.js";
import { fileOne, fileAllTriaged } from "../../src/filing/executor.js";
import { writeIngestion } from "../../src/vault/writer.js";
import type { TriageResult } from "../../src/types/index.js";
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

const triage: TriageResult = {
  type: "task",
  urgency: "high",
  suggested_folder: "Tasks",
  suggested_tags: ["type/task"],
  suggested_backlinks: ["Projects/Pebble"],
  is_task: true,
  duplicate_of: null,
  agent_confidence: 0.9,
  rationale: "TODO-like",
};

describe("filing executor", () => {
  it("creates a typed-home note in the suggested folder and back-links the thread", async () => {
    const { record } = await writeIngestion(
      {
        source: "imessage",
        sender: "+15551112222",
        thread_id: "thread-A",
        text: "Renew the domain ASAP",
        timestamp: "2026-05-02T09:00:00.000Z",
      },
      { vaultPath: vault },
    );
    db.insertIngestion(record);
    db.setTriage(record.id, triage, "triaged");

    const r = await fileOne({ vaultPath: vault, db, record, triage });
    expect(r.created).toBe(true);
    expect(r.filed_path.startsWith(path.join(vault, "Tasks"))).toBe(true);

    const filed = await fs.readFile(r.filed_path, "utf8");
    expect(filed).toMatch(/^---/); // frontmatter
    expect(filed).toContain("Renew the domain ASAP");
    expect(filed).toMatch(/From: \[\[/);
    expect(filed).toMatch(/Thread: \[\[/);
    expect(filed).toContain("[[Projects/Pebble]]");

    const thread = await fs.readFile(record.thread_path, "utf8");
    expect(thread).toMatch(/Filed as \[\[Tasks\//);

    expect(db.getIngestion(record.id)?.status).toBe("filed");
  });

  it("is idempotent on re-file", async () => {
    const { record } = await writeIngestion(
      {
        source: "manual",
        sender: "self",
        thread_id: "self",
        text: "Call vet",
        timestamp: "2026-05-02T10:00:00.000Z",
      },
      { vaultPath: vault },
    );
    db.insertIngestion(record);
    db.setTriage(record.id, triage, "triaged");

    const r1 = await fileOne({ vaultPath: vault, db, record, triage });
    const r2 = await fileOne({ vaultPath: vault, db, record, triage });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.filed_path).toBe(r1.filed_path);
  });

  it("fileAllTriaged processes only triaged items", async () => {
    const { record: a } = await writeIngestion(
      {
        source: "manual",
        sender: "self",
        thread_id: "t1",
        text: "todo: ship MVP",
        timestamp: "2026-05-02T09:00:00.000Z",
      },
      { vaultPath: vault },
    );
    const { record: b } = await writeIngestion(
      {
        source: "manual",
        sender: "self",
        thread_id: "t2",
        text: "raw note, not triaged yet",
        timestamp: "2026-05-02T09:01:00.000Z",
      },
      { vaultPath: vault },
    );
    db.insertIngestion(a);
    db.insertIngestion(b);
    db.setTriage(a.id, triage, "triaged"); // only a is triaged

    const filed = await fileAllTriaged({ vaultPath: vault, db });
    expect(filed.map((f) => f.id)).toEqual([a.id]);
    expect(db.getIngestion(a.id)?.status).toBe("filed");
    expect(db.getIngestion(b.id)?.status).toBe("raw");
  });

  it("blocks path-escape via suggested_folder", async () => {
    const { record } = await writeIngestion(
      {
        source: "manual",
        sender: "self",
        thread_id: "t",
        text: "x",
        timestamp: "2026-05-02T09:00:00.000Z",
      },
      { vaultPath: vault },
    );
    db.insertIngestion(record);
    const evil: TriageResult = { ...triage, suggested_folder: "../../../etc/Tasks" };
    const r = await fileOne({ vaultPath: vault, db, record, triage: evil });
    expect(r.filed_path.startsWith(path.resolve(vault) + path.sep)).toBe(true);
  });
});
