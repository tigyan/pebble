import path from "node:path";
import type { PebbleDB } from "../db/client.js";
import {
  type CommandResult,
  CommandResultSchema,
} from "../types/index.js";
import { runCli } from "../triage/cli-provider.js";
import { extractJsonObject } from "../triage/prompt.js";
import { makeAgentTools } from "./tools.js";

/**
 * The `/do` prefix that switches Pebble from "ingest as a note" to "execute
 * the agent and write the result into the vault". Match is case-insensitive
 * on a trimmed leading slice; the rest of the message is the instruction.
 */
const DO_PREFIX = /^\s*\/do\b[\s:]*/i;

export interface ParsedCommand {
  instruction: string;
}

export function parseDoCommand(text: string): ParsedCommand | null {
  if (!text) return null;
  const m = text.match(DO_PREFIX);
  if (!m) return null;
  const instruction = text.slice(m[0].length).trim();
  if (!instruction) return null;
  return { instruction };
}

export interface CommandCandidate {
  path: string;
  title: string | null;
}

export interface CommandProvider {
  readonly name: string;
  generate(input: {
    instruction: string;
    candidates: CommandCandidate[];
  }): Promise<CommandResult>;
}

/**
 * Heuristic command provider used in tests and as an offline fallback.
 * Picks a target out of «...» / "..." / '...' if present, prefers an existing
 * candidate that matches by title or path, and emits a stub markdown body.
 */
export const mockCommandProvider: CommandProvider = {
  name: "mock",
  async generate({ instruction, candidates }) {
    const quoted =
      instruction.match(/[«„]([^»“]+)[»“]/) ??
      instruction.match(/["“]([^"”]+)["”]/) ??
      instruction.match(/'([^']+)'/);
    const target = quoted?.[1]?.trim() ?? "";
    let action: CommandResult["action"] = "create";
    let target_path = "Inbox/note.md";

    if (target) {
      const lc = target.toLowerCase();
      const hit = candidates.find(
        (c) =>
          (c.title ?? "").toLowerCase().includes(lc) ||
          c.path.toLowerCase().includes(lc),
      );
      if (hit) {
        target_path = hit.path;
        action = "append";
      } else {
        target_path = `Inbox/${slugify(target)}.md`;
        action = "create";
      }
    }

    const result: CommandResult = {
      action,
      target_path,
      markdown: `\n## ${target || "Note"}\n\n${instruction}\n`,
      rationale: "mock command provider — heuristic only",
    };
    return CommandResultSchema.parse(result);
  },
};

/**
 * CLI-backed command provider. Same subscription-mode subprocess flow as the
 * triage CLI providers, but with a command-specific prompt and JSON shape.
 */
export function makeCliCommandProvider(cfg: {
  name: "claude-code" | "codex";
  bin: string;
  args: string[];
  extractText?: (out: string) => string;
  timeoutMs?: number;
}): CommandProvider {
  return {
    name: cfg.name,
    async generate({ instruction, candidates }) {
      const prompt = renderCommandPrompt(instruction, candidates);
      const stdout = await runCli(cfg.bin, cfg.args, prompt, cfg.timeoutMs ?? 90_000);
      const text = cfg.extractText ? cfg.extractText(stdout) : stdout;
      const parsed = extractJsonObject(text);
      return CommandResultSchema.parse(parsed);
    },
  };
}

export function renderCommandPrompt(
  instruction: string,
  candidates: CommandCandidate[],
): string {
  const list = candidates.length
    ? candidates
        .slice(0, 10)
        .map((c) => `- ${c.path}${c.title ? ` — ${c.title}` : ""}`)
        .join("\n")
    : "(no existing notes matched — create a new one)";
  return [
    "You are Pebble's command agent. The user prefixed their message with /do,",
    "which means: pick one note in the vault and write the requested content there.",
    "",
    "Output rules:",
    "- Reply with ONE JSON object and nothing else. No prose. No markdown fences.",
    "- target_path must be vault-relative (e.g. \"Notes/Math.md\"), end with \".md\",",
    "  and contain no \"..\" segments.",
    "- If a candidate matches the user's intent, reuse its exact path and use action=\"append\".",
    "- Otherwise propose a fresh path under \"Inbox/\" or a typed home folder",
    '  (e.g. "Notes/", "Tasks/") and use action="create".',
    "- markdown is the content to write, formatted in Markdown, ready to drop in.",
    "",
    "Schema:",
    "{",
    '  "action": "append" | "create",',
    '  "target_path": string,',
    '  "markdown": string,',
    '  "rationale": string',
    "}",
    "",
    "Existing notes (top FTS hits — pick one if it matches the user's target):",
    list,
    "",
    "User instruction:",
    instruction,
    "",
    "Respond now with only the JSON object.",
  ].join("\n");
}

export interface RunCommandOpts {
  text: string;
  vaultPath: string;
  db: PebbleDB;
  provider: CommandProvider;
  /** Audit-log agent identity. Default: `command:<provider.name>`. */
  agent?: string;
  dryRun?: boolean;
}

export interface CommandRunResult {
  ok: boolean;
  action: CommandResult["action"];
  target_path: string;
  bytes_written: number;
  fell_back?: "create_to_append";
  rationale?: string;
}

export async function runCommand(opts: RunCommandOpts): Promise<CommandRunResult> {
  const parsed = parseDoCommand(opts.text);
  if (!parsed) throw new Error("not a /do command");

  // why: feed the model a short candidate list so it can reuse an existing
  // path instead of inventing one. FTS over the instruction text catches
  // both keywords ("учеба") and paraphrases ("studies", "школа"...).
  // FTS5 is brittle on punctuation — fall back to empty candidates on any
  // syntax error rather than failing the whole command.
  let candidates: CommandCandidate[] = [];
  try {
    candidates = opts.db
      .searchNotes(ftsSafeQuery(parsed.instruction), 10)
      .map((h) => ({ path: h.path, title: h.title }));
  } catch {
    candidates = [];
  }

  const result = await opts.provider.generate({
    instruction: parsed.instruction,
    candidates,
  });

  const safe = sanitizeTargetPath(result.target_path);

  const tools = makeAgentTools({
    vaultPath: opts.vaultPath,
    db: opts.db,
    agent: opts.agent ?? `command:${opts.provider.name}`,
    dryRun: opts.dryRun ?? false,
  });

  if (result.action === "create") {
    try {
      const r = await tools.create_note({ path: safe, markdown: result.markdown });
      return {
        ok: r.created,
        action: "create",
        target_path: safe,
        bytes_written: Buffer.byteLength(result.markdown, "utf8"),
        ...(result.rationale ? { rationale: result.rationale } : {}),
      };
    } catch (err) {
      // Falls back to append when the model said "create" but the file is
      // already there — common when the user names an existing note.
      if (!/refusing to overwrite/.test((err as Error).message)) throw err;
      const r = await tools.append_to_note({ path: safe, markdown: result.markdown });
      return {
        ok: true,
        action: "append",
        target_path: safe,
        bytes_written: r.bytes_written,
        fell_back: "create_to_append",
        ...(result.rationale ? { rationale: result.rationale } : {}),
      };
    }
  }

  const r = await tools.append_to_note({ path: safe, markdown: result.markdown });
  return {
    ok: true,
    action: "append",
    target_path: safe,
    bytes_written: r.bytes_written,
    ...(result.rationale ? { rationale: result.rationale } : {}),
  };
}

/**
 * Pre-flight checks on the model-supplied path. The full vault-escape check
 * still happens inside `safePath` when the agent tool runs; we just refuse
 * obviously bad inputs early so the audit log shows a clean reason.
 */
function sanitizeTargetPath(rel: string): string {
  let p = rel.trim().replace(/^\.\/+/, "");
  if (!p) throw new Error("empty target_path");
  if (path.isAbsolute(p)) throw new Error(`absolute target_path refused: ${p}`);
  if (p.split(/[/\\]/).some((seg) => seg === "..")) {
    throw new Error(`target_path contains ..: ${p}`);
  }
  if (!p.toLowerCase().endsWith(".md")) p = `${p}.md`;
  return p;
}

/**
 * FTS5 treats `.`, `:`, `"`, `(` etc. as syntax. Reduce to whitespace-separated
 * words so the query is always parseable. Empty result is fine — the runner
 * just skips the candidate list.
 */
function ftsSafeQuery(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");
}

function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "note";
}

/**
 * Provider registry mirroring `getProvider` in classifier.ts. Subscription
 * CLIs are first-class; the mock is for tests and offline use.
 */
export function getCommandProvider(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): CommandProvider {
  switch (name) {
    case "mock":
      return mockCommandProvider;

    case "claude-code": {
      const bin = env.PEBBLE_CLAUDE_CODE_BIN || "claude";
      return makeCliCommandProvider({
        name: "claude-code",
        bin,
        args: ["-p", "--output-format", "json"],
        extractText: (out) => {
          try {
            const env = JSON.parse(out);
            if (
              env &&
              typeof env === "object" &&
              "result" in env &&
              typeof env.result === "string"
            ) {
              return env.result;
            }
          } catch {
            /* fallthrough */
          }
          return out;
        },
      });
    }

    case "codex": {
      const bin = env.PEBBLE_CODEX_BIN || "codex";
      return makeCliCommandProvider({
        name: "codex",
        bin,
        args: ["exec", "--color", "never", "--skip-git-repo-check", "-"],
      });
    }

    default:
      // why: API-key triage providers don't yet have a /do counterpart.
      // Fall back to mock so the feature is at least functional locally.
      return mockCommandProvider;
  }
}
