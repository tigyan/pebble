import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeCliProvider } from "../../src/triage/cli-provider.js";
import { extractJsonObject } from "../../src/triage/prompt.js";
import type { IngestRecord } from "../../src/types/index.js";

const FIX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FAKE = path.join(FIX_DIR, "fake-cli.mjs");

const sampleRecord: IngestRecord = {
  id: "abc",
  source: "imessage",
  sender: "+1",
  thread_id: "t",
  text: "remind me to renew the domain",
  attachments: [],
  timestamp: "2026-05-02T00:00:00.000Z",
  received_at: "2026-05-02T00:00:00.000Z",
  status: "raw",
  original_text_hash: "h",
  inbox_path: "i",
  thread_path: "th",
  person_path: "p",
};

describe("extractJsonObject", () => {
  it("parses clean JSON", () => {
    const o = extractJsonObject('{"a":1}') as { a: number };
    expect(o.a).toBe(1);
  });
  it("parses JSON inside ```json fences", () => {
    const o = extractJsonObject('Sure!\n```json\n{"a":2}\n```\nThanks.') as { a: number };
    expect(o.a).toBe(2);
  });
  it("walks for the first balanced object when there is leading prose", () => {
    const o = extractJsonObject('blah blah {"a":3,"b":{"c":4}} trailing') as { a: number };
    expect(o.a).toBe(3);
  });
  it("rejects non-JSON output", () => {
    expect(() => extractJsonObject("nope")).toThrow();
  });
});

describe("CLI provider (fake binary)", () => {
  it("plain mode: parses JSON-only stdout", async () => {
    const p = makeCliProvider({
      name: "claude-code",
      bin: process.execPath,
      args: [FAKE],
      env: { PEBBLE_FAKE_MODE: "plain" },
    });
    const r = await p.classify(sampleRecord);
    expect(r.type).toBe("task");
    expect(r.is_task).toBe(true);
  });

  it("wrap mode: parses {result: stringified-json} envelope", async () => {
    const p = makeCliProvider({
      name: "claude-code",
      bin: process.execPath,
      args: [FAKE],
      env: { PEBBLE_FAKE_MODE: "wrap" },
      extractText: (out) => {
        const env = JSON.parse(out);
        return env.result;
      },
    });
    const r = await p.classify(sampleRecord);
    expect(r.suggested_folder).toBe("Tasks");
  });

  it("noisy mode: extracts JSON from a fenced code block", async () => {
    const p = makeCliProvider({
      name: "codex",
      bin: process.execPath,
      args: [FAKE],
      env: { PEBBLE_FAKE_MODE: "noisy" },
    });
    const r = await p.classify(sampleRecord);
    expect(r.urgency).toBe("high");
  });

  it("fail mode: rejects with non-zero exit context", async () => {
    const p = makeCliProvider({
      name: "codex",
      bin: process.execPath,
      args: [FAKE],
      env: { PEBBLE_FAKE_MODE: "fail" },
    });
    await expect(p.classify(sampleRecord)).rejects.toThrow(/exited 2/);
  });

  it("slow mode: rejects after the configured timeout", async () => {
    const p = makeCliProvider({
      name: "codex",
      bin: process.execPath,
      args: [FAKE],
      env: { PEBBLE_FAKE_MODE: "slow" },
      timeoutMs: 200,
    });
    await expect(p.classify(sampleRecord)).rejects.toThrow(/timed out/);
  });
});
