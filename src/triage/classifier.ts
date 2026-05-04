import {
  type IngestRecord,
  type NoteType,
  type TriageResult,
  TriageResultSchema,
} from "../types/index.js";
import { buildSecretSource, type SecretSource } from "../secrets/source.js";
import {
  makeAnthropicProvider,
  makeCustomProvider,
  makeOpenAIProvider,
} from "./api-provider.js";
import { makeCliProvider } from "./cli-provider.js";

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
 * Provider registry. Subscription-mode CLIs (claude-code, codex) are
 * first-class. API-key providers (anthropic, openai) remain reserved slots
 * and currently throw.
 */
export function getProvider(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  secrets: SecretSource = buildSecretSource(env),
): TriageProvider {
  switch (name) {
    case "mock":
      return mockTriageProvider;

    case "claude-code": {
      const bin = env.PEBBLE_CLAUDE_CODE_BIN || "claude";
      // Headless Claude Code: -p emits a single completion; --output-format
      // json gives us a stable envelope with .result containing the text.
      return makeCliProvider({
        name: "claude-code",
        bin,
        args: ["-p", "--output-format", "json"],
        extractText: (out) => {
          try {
            const env = JSON.parse(out);
            if (env && typeof env === "object" && "result" in env && typeof env.result === "string") {
              return env.result;
            }
          } catch {
            /* fallthrough — treat raw stdout as text */
          }
          return out;
        },
      });
    }

    case "codex": {
      const bin = env.PEBBLE_CODEX_BIN || "codex";
      // why: Codex CLI ≥0.20 dropped `--quiet`; `--color never` keeps ANSI
      // escapes out of stdout so extractJsonObject can find the JSON cleanly.
      // `--skip-git-repo-check` lets the worker run from any cwd.
      return makeCliProvider({
        name: "codex",
        bin,
        args: ["exec", "--color", "never", "--skip-git-repo-check", "-"],
      });
    }

    case "anthropic": {
      const apiKey = secrets.get("PEBBLE_ANTHROPIC_API_KEY") ?? "";
      if (!apiKey) {
        throw new Error(
          "triage provider \"anthropic\" requires PEBBLE_ANTHROPIC_API_KEY. " +
            "Subscription mode (claude-code) is the recommended alternative.",
        );
      }
      const opts: Parameters<typeof makeAnthropicProvider>[0] = { apiKey };
      if (env.PEBBLE_ANTHROPIC_MODEL) opts.model = env.PEBBLE_ANTHROPIC_MODEL;
      if (env.PEBBLE_ANTHROPIC_BASE_URL) opts.baseUrl = env.PEBBLE_ANTHROPIC_BASE_URL;
      return makeAnthropicProvider(opts);
    }

    case "openai": {
      const apiKey = secrets.get("PEBBLE_OPENAI_API_KEY") ?? "";
      if (!apiKey) {
        throw new Error(
          "triage provider \"openai\" requires PEBBLE_OPENAI_API_KEY. " +
            "Subscription mode (codex) is the recommended alternative.",
        );
      }
      const opts: Parameters<typeof makeOpenAIProvider>[0] = { apiKey };
      if (env.PEBBLE_OPENAI_MODEL) opts.model = env.PEBBLE_OPENAI_MODEL;
      if (env.PEBBLE_OPENAI_BASE_URL) opts.baseUrl = env.PEBBLE_OPENAI_BASE_URL;
      return makeOpenAIProvider(opts);
    }

    case "custom": {
      const baseUrl = env.PEBBLE_CUSTOM_BASE_URL ?? "";
      const model = env.PEBBLE_CUSTOM_MODEL ?? "";
      if (!baseUrl) {
        throw new Error(
          'triage provider "custom" requires PEBBLE_CUSTOM_BASE_URL ' +
            "(OpenAI-compatible endpoint, e.g. https://openrouter.ai/api or http://localhost:11434).",
        );
      }
      if (!model) {
        throw new Error(
          'triage provider "custom" requires PEBBLE_CUSTOM_MODEL (free-form model id).',
        );
      }
      const opts: Parameters<typeof makeCustomProvider>[0] = { baseUrl, model };
      const apiKey = secrets.get("PEBBLE_CUSTOM_API_KEY");
      if (apiKey) opts.apiKey = apiKey;
      if (env.PEBBLE_CUSTOM_PATH) opts.path = env.PEBBLE_CUSTOM_PATH;
      // Optional extra headers as JSON, e.g. for OpenRouter attribution.
      if (env.PEBBLE_CUSTOM_HEADERS) {
        try {
          const parsed = JSON.parse(env.PEBBLE_CUSTOM_HEADERS);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            opts.headers = parsed as Record<string, string>;
          }
        } catch {
          throw new Error("PEBBLE_CUSTOM_HEADERS must be a JSON object");
        }
      }
      return makeCustomProvider(opts);
    }

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
