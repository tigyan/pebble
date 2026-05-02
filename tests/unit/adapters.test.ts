import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { normalize } from "../../src/adapters/index.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

describe("adapters", () => {
  it("bluebubbles webhook → canonical payload", async () => {
    const body = JSON.parse(await fs.readFile(path.join(FIX, "imessage.bluebubbles.json"), "utf8"));
    const { adapter, payload } = normalize({}, body);
    expect(adapter).toBe("bluebubbles");
    expect(payload.source).toBe("imessage");
    expect(payload.sender).toBe("+15551234567");
    expect(payload.thread_id).toBe("iMessage;-;chat123");
    expect(payload.text).toContain("renew the domain");
  });

  it("sendblue webhook → canonical payload", async () => {
    const body = JSON.parse(await fs.readFile(path.join(FIX, "sendblue.json"), "utf8"));
    const { adapter, payload } = normalize({}, body);
    expect(adapter).toBe("sendblue");
    expect(payload.source).toBe("imessage");
    expect(payload.sender).toBe("+15551234567");
    expect(payload.text).toContain("Flight booked");
  });

  it("manual / shortcut JSON falls through to manual or shortcuts adapter", () => {
    const { adapter, payload } = normalize(
      { "user-agent": "Shortcuts/1.0" },
      { source: "shortcut", sender: "self", thread_id: "self", text: "hi" },
    );
    expect(adapter).toBe("shortcuts");
    expect(payload.text).toBe("hi");
  });
});
