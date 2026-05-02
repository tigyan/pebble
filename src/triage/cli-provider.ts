import { spawn } from "node:child_process";
import {
  type IngestRecord,
  type TriageResult,
  TriageResultSchema,
} from "../types/index.js";
import { extractJsonObject, renderTriagePrompt } from "./prompt.js";
import type { TriageProvider } from "./classifier.js";

export interface CliProviderConfig {
  /** Provider identity for logs / errors. */
  name: "claude-code" | "codex";
  /** Path to the CLI binary (or a name resolvable on PATH). */
  bin: string;
  /** CLI args. The prompt is fed via stdin to avoid arg-length and quoting issues. */
  args: string[];
  /** Optional: pull the assistant's text from a wrapper format (e.g. JSON envelope). */
  extractText?: (stdout: string) => string;
  /** Hard timeout for the subprocess. Defaults to 90s. */
  timeoutMs?: number;
  /** Extra env to merge into child process. */
  env?: Record<string, string>;
}

/**
 * Wrap a logged-in CLI tool (Claude Code, Codex) as a TriageProvider. The
 * user's subscription auth lives in the CLI; Pebble does not see API keys.
 */
export function makeCliProvider(cfg: CliProviderConfig): TriageProvider {
  const timeoutMs = cfg.timeoutMs ?? 90_000;

  return {
    name: cfg.name,
    async classify(record: IngestRecord): Promise<TriageResult> {
      const prompt = renderTriagePrompt(record);
      const stdout = await runCli(cfg.bin, cfg.args, prompt, timeoutMs, cfg.env);
      const text = cfg.extractText ? cfg.extractText(stdout) : stdout;
      const parsed = extractJsonObject(text);
      return TriageResultSchema.parse(parsed);
    },
  };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(
  bin: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(extraEnv ?? {}) },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${bin}: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
        return;
      }
      const result: RunResult = { code: code ?? -1, stdout, stderr };
      if (result.code !== 0) {
        reject(
          new Error(
            `${bin} exited ${result.code}: ${stderr.slice(0, 500) || "(no stderr)"}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });

    child.stdin.end(stdin, "utf8");
  });
}
