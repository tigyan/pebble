import { describe, expect, it } from "vitest";
import { mockTriageProvider } from "../../src/triage/classifier.js";
import { TriageResultSchema, type IngestRecord } from "../../src/types/index.js";

function rec(text: string): IngestRecord {
  return {
    id: "x",
    source: "imessage",
    sender: "+1",
    thread_id: "t",
    text,
    timestamp: "2026-05-02T00:00:00.000Z",
    received_at: "2026-05-02T00:00:00.000Z",
    status: "raw",
    original_text_hash: "h",
    inbox_path: "i",
    thread_path: "th",
    person_path: "p",
  };
}

describe("triage classifier", () => {
  it("emits schema-valid output for a task-like message", async () => {
    const out = await mockTriageProvider.classify(rec("TODO: renew domain ASAP"));
    expect(TriageResultSchema.parse(out)).toEqual(out);
    expect(out.type).toBe("task");
    expect(out.urgency).toBe("high");
    expect(out.is_task).toBe(true);
  });

  it("emits schema-valid output for a question", async () => {
    const out = await mockTriageProvider.classify(rec("Should we move to fly.io?"));
    expect(TriageResultSchema.parse(out)).toEqual(out);
    expect(out.type).toBe("question");
  });
});
