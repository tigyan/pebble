import {
  type IngestRecord,
  type NoteType,
  type TriageResult,
  TriageResultSchema,
} from "../types/index.js";

export interface TriageProvider {
  readonly name: string;
  classify(record: IngestRecord): Promise<TriageResult>;
}

/** Heuristic classifier — no network, no API key. Good enough to bootstrap. */
export const mockTriageProvider: TriageProvider = {
  name: "mock",
  async classify(record) {
    const text = record.text.toLowerCase().trim();
    const type = guessType(text);
    const urgency = guessUrgency(text);
    const tags = guessTags(text, type);
    const isTask = type === "task" || /\b(todo|remind|need to|must)\b/.test(text);

    const result: TriageResult = {
      type,
      urgency,
      suggested_folder: folderFor(type),
      suggested_tags: tags,
      suggested_backlinks: [],
      is_task: isTask,
      duplicate_of: null,
      agent_confidence: 0.55,
      rationale: "heuristic mock classifier",
    };
    return TriageResultSchema.parse(result);
  },
};

/**
 * Provider registry. Real LLM-backed providers (Anthropic, OpenAI, Claude Code,
 * Codex) plug in here. They MUST return data that parses against TriageResultSchema.
 */
export function getProvider(name: string): TriageProvider {
  switch (name) {
    case "mock":
      return mockTriageProvider;
    case "anthropic":
    case "openai":
    case "claude-code":
    case "codex":
      // TODO: real implementations. Until wired, fail loudly so users notice.
      throw new Error(
        `triage provider "${name}" not yet implemented — set PEBBLE_TRIAGE_PROVIDER=mock for now`,
      );
    default:
      throw new Error(`unknown triage provider: ${name}`);
  }
}

function guessType(text: string): NoteType {
  if (!text) return "other";
  if (/\b(todo|task|do this|remind)\b/.test(text)) return "task";
  if (/\b(meeting|standup|1:1|agenda)\b/.test(text)) return "meeting_note";
  if (/\b(idea|what if|maybe we should)\b/.test(text)) return "idea";
  if (/\b(\$|usd|eur|invoice|paid|paypal|stripe)\b/i.test(text)) return "finance";
  if (/\b(flight|hotel|booking|trip|airbnb)\b/i.test(text)) return "travel";
  if (/^https?:\/\//.test(text) || /\bsee:\s*https?:/.test(text)) return "reference";
  if (/\?$/.test(text.trim())) return "question";
  if (/\b(today i|felt|mood)\b/.test(text)) return "journal";
  return "other";
}

function guessUrgency(text: string): TriageResult["urgency"] {
  if (/\b(asap|urgent|now|immediately|today)\b/.test(text)) return "high";
  if (/\b(soon|tomorrow|this week)\b/.test(text)) return "medium";
  if (text.length > 0) return "low";
  return "none";
}

function guessTags(text: string, type: NoteType): string[] {
  const tags = new Set<string>([`type/${type}`]);
  for (const m of text.matchAll(/#([a-z0-9_\-/]+)/gi)) {
    tags.add(m[1]!);
  }
  return Array.from(tags);
}

function folderFor(type: NoteType): string {
  switch (type) {
    case "task":
      return "Tasks";
    case "meeting_note":
      return "Meetings";
    case "idea":
      return "Ideas";
    case "project_note":
      return "Projects";
    case "reference":
      return "Reference";
    case "finance":
      return "Finance";
    case "travel":
      return "Travel";
    case "media":
      return "Media";
    case "journal":
      return "Journal";
    case "contact":
      return "People";
    case "question":
      return "Questions";
    default:
      return "Inbox";
  }
}
