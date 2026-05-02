#!/usr/bin/env node
// Minimal fake "subscription CLI" used by tests in place of `claude`/`codex`.
// Reads a prompt from stdin and emits a TriageResult-shaped JSON on stdout.
//
// Modes (selected via PEBBLE_FAKE_MODE):
//   plain  — emit the JSON directly (default)
//   wrap   — emit { "result": "<JSON string>" } (mimics `claude -p --output-format json`)
//   noisy  — wrap the JSON in chat-y prose with a fenced code block
//   fail   — exit non-zero with a stderr message
//   slow   — sleep longer than the caller's timeout, then exit
//   echo   — emit the prompt back unchanged (for prompt-rendering tests)

import { setTimeout as delay } from "node:timers/promises";

const mode = process.env.PEBBLE_FAKE_MODE ?? "plain";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", main);

async function main() {
  if (mode === "fail") {
    process.stderr.write("fake-cli: simulated failure\n");
    process.exit(2);
  }
  if (mode === "slow") {
    await delay(5_000);
    process.exit(0);
  }
  if (mode === "echo") {
    process.stdout.write(stdin);
    return;
  }

  const result = {
    type: "task",
    urgency: "high",
    suggested_folder: "Tasks",
    suggested_tags: ["type/task", "from/fake-cli"],
    suggested_backlinks: [],
    is_task: true,
    duplicate_of: null,
    agent_confidence: 0.9,
    rationale: "fake-cli test fixture",
  };

  if (mode === "wrap") {
    process.stdout.write(JSON.stringify({ result: JSON.stringify(result) }));
    return;
  }
  if (mode === "noisy") {
    process.stdout.write(
      "Sure! Here's the triage result:\n\n```json\n" +
        JSON.stringify(result, null, 2) +
        "\n```\nLet me know if you need anything else.",
    );
    return;
  }
  process.stdout.write(JSON.stringify(result));
}
