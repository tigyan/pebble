import type { IngestRecord } from "../types/index.js";

/**
 * Stable, model-agnostic triage prompt. Asks the model to emit ONE JSON
 * object matching TriageResultSchema and nothing else. We re-validate with
 * Zod after parsing — never trust the model's formatting.
 */
export function renderTriagePrompt(record: IngestRecord): string {
  const message = record.text.trim() || "(no text)";
  const attachments = (record.attachments ?? [])
    .map((a) => `- ${a.kind}: ${a.filename ?? a.uri}${a.mime ? ` (${a.mime})` : ""}`)
    .join("\n");

  return [
    "You are Pebble, a triage classifier for a personal Obsidian knowledge vault.",
    "Classify ONE inbound message into a structured TriageResult.",
    "",
    "Output rules:",
    "- Reply with ONE JSON object and nothing else. No prose. No markdown fences.",
    "- All fields are required unless explicitly nullable.",
    "- Confidence is a number between 0.0 and 1.0.",
    "",
    "Schema:",
    "{",
    '  "type": "idea" | "task" | "meeting_note" | "contact" | "project_note" | "reference" | "question" | "journal" | "finance" | "travel" | "media" | "other",',
    '  "urgency": "none" | "low" | "medium" | "high",',
    '  "suggested_folder": string,',
    '  "suggested_tags": string[],',
    '  "suggested_backlinks": string[],',
    '  "is_task": boolean,',
    '  "duplicate_of": string | null,',
    '  "agent_confidence": number,',
    '  "rationale": string',
    "}",
    "",
    "Message:",
    `- source: ${record.source}`,
    `- sender: ${record.sender}`,
    `- thread_id: ${record.thread_id}`,
    `- received_at: ${record.received_at}`,
    attachments ? `- attachments:\n${attachments}` : "",
    "",
    "Text:",
    message,
    "",
    "Respond now with only the JSON object.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Extract the first balanced JSON object from a string. Models occasionally
 * wrap their answer in commentary or fences despite instructions; we cope.
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty model output");

  // Fast path: clean JSON.
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fallthrough */
    }
  }

  // Strip ```json ... ``` fences if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fallthrough */
    }
  }

  // Walk for the first balanced { ... }.
  const start = trimmed.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model output");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const slice = trimmed.slice(start, i + 1);
        return JSON.parse(slice);
      }
    }
  }
  throw new Error("unbalanced JSON in model output");
}
