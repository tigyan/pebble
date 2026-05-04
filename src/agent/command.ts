import path from "node:path";
import type { PebbleDB } from "../db/client.js";
import {
  type CommandResult,
  CommandResultSchema,
  type CommandStep,
  CommandStepSchema,
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

export interface ReadView {
  path: string;
  content: string;
}

export interface CommandProvider {
  readonly name: string;
  /**
   * Single-shot terminal generation. Used when no tool-loop step is needed
   * (mock provider, providers that don't support intermediate reads).
   */
  generate(input: {
    instruction: string;
    candidates: CommandCandidate[];
  }): Promise<CommandResult>;
  /**
   * Optional tool-loop step. When present, the runner calls `step()` until
   * the provider returns a write (`CommandResult`); each `read` request is
   * served from the vault (path-checked) and fed back as `reads` next round.
   */
  step?(input: {
    instruction: string;
    candidates: CommandCandidate[];
    reads: ReadView[];
  }): Promise<CommandStep>;
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
    async step({ instruction, candidates, reads }) {
      const prompt = renderCommandStepPrompt(instruction, candidates, reads);
      const stdout = await runCli(cfg.bin, cfg.args, prompt, cfg.timeoutMs ?? 90_000);
      const text = cfg.extractText ? cfg.extractText(stdout) : stdout;
      const parsed = extractJsonObject(text);
      return CommandStepSchema.parse(parsed);
    },
  };
}

/**
 * Tool-loop variant of the command prompt. The model can either request reads
 * of vault notes (to ground the final write in real content) or emit the
 * terminal write. The schema is a discriminated union on `action`.
 */
export function renderCommandStepPrompt(
  instruction: string,
  candidates: CommandCandidate[],
  reads: ReadView[],
): string {
  const list = candidates.length
    ? candidates
        .slice(0, 10)
        .map((c) => `- ${c.path}${c.title ? ` — ${c.title}` : ""}`)
        .join("\n")
    : "(no existing notes matched — create a new one)";
  const readsBlock = reads.length
    ? reads
        .map(
          (r) =>
            `--- BEGIN ${r.path} ---\n${truncate(r.content, 4_000)}\n--- END ${r.path} ---`,
        )
        .join("\n\n")
    : "(no reads yet)";
  return [
    "You are Pebble's command agent for /do. You may read existing notes before",
    "writing, so you can append to the right place without duplicating content.",
    "",
    "Output rules:",
    "- Reply with ONE JSON object and nothing else. No prose. No markdown fences.",
    "- To inspect notes first: {\"action\":\"read\",\"paths\":[\"…\"]} (max 5 paths,",
    "  vault-relative, must end in .md). Use this when reusing/extending an",
    "  existing note to avoid re-writing what's already there.",
    "- To finalize the write: {\"action\":\"append\"|\"create\",\"target_path\":\"…\",",
    "  \"markdown\":\"…\",\"rationale\":\"…\"}.",
    "- target_path must be vault-relative, end with .md, no \"..\" segments.",
    "- Prefer append+existing path over create when a candidate fits.",
    "",
    "Existing notes (top FTS hits):",
    list,
    "",
    "Notes you have already read this turn:",
    readsBlock,
    "",
    "User instruction:",
    instruction,
    "",
    "Respond now with only the JSON object.",
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
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
  /**
   * Max tool-loop iterations before bailing. Each round = one provider call.
   * Default 3 (≤2 read passes + 1 final write). Set 1 to force single-shot.
   */
  maxSteps?: number;
}

export interface CommandRunResult {
  ok: boolean;
  action: CommandResult["action"];
  target_path: string;
  bytes_written: number;
  fell_back?: "create_to_append";
  rationale?: string;
  /** Number of provider calls made (≥1). >1 means the tool loop fired. */
  steps?: number;
  /** Notes the agent read before writing (vault-relative paths). */
  reads?: string[];
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

  const tools = makeAgentTools({
    vaultPath: opts.vaultPath,
    db: opts.db,
    agent: opts.agent ?? `command:${opts.provider.name}`,
    dryRun: opts.dryRun ?? false,
  });

  // why: when the provider implements step(), let it iteratively call read_note
  // before writing. This is the difference between "the model writes blindly"
  // and "the model extends the existing «Учеба» list without duplicates".
  // Falls back to single-shot generate() when step() isn't implemented.
  const maxSteps = Math.max(1, opts.maxSteps ?? 3);
  let result: CommandResult;
  let stepsUsed = 1;
  const readsAcc: ReadView[] = [];
  const readPaths: string[] = [];

  if (opts.provider.step) {
    let terminal: CommandResult | null = null;
    for (let i = 0; i < maxSteps; i++) {
      stepsUsed = i + 1;
      const step: CommandStep = await opts.provider.step({
        instruction: parsed.instruction,
        candidates,
        reads: readsAcc,
      });
      if (step.action !== "read") {
        terminal = step;
        break;
      }
      // Last iteration must produce a write — refuse another read request.
      if (i === maxSteps - 1) {
        throw new Error(`provider exceeded maxSteps=${maxSteps} without writing`);
      }
      for (const rel of step.paths) {
        const safeRel = sanitizeTargetPath(rel);
        if (readPaths.includes(safeRel)) continue;
        try {
          const r = await tools.read_note({ path: safeRel });
          readsAcc.push({ path: safeRel, content: r.content });
          readPaths.push(safeRel);
        } catch (err) {
          // why: a missing path is normal — surface it so the model can pivot.
          readsAcc.push({
            path: safeRel,
            content: `(read failed: ${(err as Error).message})`,
          });
          readPaths.push(safeRel);
        }
      }
    }
    if (!terminal) {
      throw new Error(`provider exceeded maxSteps=${maxSteps} without writing`);
    }
    result = terminal;
  } else {
    result = await opts.provider.generate({
      instruction: parsed.instruction,
      candidates,
    });
  }

  const safe = sanitizeTargetPath(result.target_path);

  const meta = {
    ...(result.rationale ? { rationale: result.rationale } : {}),
    ...(stepsUsed > 1 ? { steps: stepsUsed } : {}),
    ...(readPaths.length > 0 ? { reads: readPaths } : {}),
  };

  if (result.action === "create") {
    try {
      const r = await tools.create_note({ path: safe, markdown: result.markdown });
      return {
        ok: r.created,
        action: "create",
        target_path: safe,
        bytes_written: Buffer.byteLength(result.markdown, "utf8"),
        ...meta,
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
        ...meta,
      };
    }
  }

  const r = await tools.append_to_note({ path: safe, markdown: result.markdown });
  return {
    ok: true,
    action: "append",
    target_path: safe,
    bytes_written: r.bytes_written,
    ...meta,
  };
}

/**
 * In-memory LRU-ish cache for `/do` echo suppression. The ingestion pipeline
 * already drops self-chat double-fires, but `/do` skips the ingestion log
 * entirely (we don't want the raw command sitting in Inbox/), so the existing
 * suppression doesn't see it. This cache catches the same case for commands:
 * if the exact same sender+thread+instruction shows up within the window, the
 * second one is dropped before we burn a model call.
 */
export class DoEchoCache {
  private readonly entries = new Map<string, number>();
  constructor(
    private readonly windowMs: number = 60_000,
    private readonly maxEntries: number = 256,
  ) {}

  /** Returns true if the same key was seen within the window; otherwise records it. */
  hit(sender: string, threadId: string, text: string, now: number = Date.now()): boolean {
    if (this.windowMs <= 0) return false;
    const key = `${sender}\u0000${threadId}\u0000${text}`;
    const prev = this.entries.get(key);
    if (prev !== undefined && now - prev <= this.windowMs) {
      return true;
    }
    this.entries.set(key, now);
    if (this.entries.size > this.maxEntries) this.evict(now);
    return false;
  }

  private evict(now: number): void {
    for (const [k, t] of this.entries) {
      if (now - t > this.windowMs) this.entries.delete(k);
    }
    if (this.entries.size > this.maxEntries) {
      // Drop the oldest insert (Map iteration order is insertion order).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
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
