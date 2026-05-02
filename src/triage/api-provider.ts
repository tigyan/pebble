import {
  type IngestRecord,
  type TriageResult,
  TriageResultSchema,
} from "../types/index.js";
import type { TriageProvider } from "./classifier.js";
import { extractJsonObject, renderTriagePrompt } from "./prompt.js";

export interface ApiProviderConfig {
  name: "anthropic" | "openai";
  /** Build a fetch request from a fully-rendered prompt. */
  buildRequest(prompt: string): { url: string; init: RequestInit };
  /** Pull the assistant's text out of the provider's JSON envelope. */
  extractText(body: unknown): string;
  /** Optional override for tests. */
  fetchImpl?: typeof fetch;
  /** Hard timeout. Default 60s. */
  timeoutMs?: number;
}

export function makeApiProvider(cfg: ApiProviderConfig): TriageProvider {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 60_000;

  return {
    name: cfg.name,
    async classify(record: IngestRecord): Promise<TriageResult> {
      const prompt = renderTriagePrompt(record);
      const { url, init } = cfg.buildRequest(prompt);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, signal: ac.signal });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          throw new Error(`${cfg.name} request timed out after ${timeoutMs}ms`);
        }
        throw new Error(`${cfg.name} request failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`${cfg.name} HTTP ${res.status}: ${errText.slice(0, 500)}`);
      }
      const body = (await res.json()) as unknown;
      const text = cfg.extractText(body);
      const parsed = extractJsonObject(text);
      return TriageResultSchema.parse(parsed);
    },
  };
}

// --- Anthropic Messages API ----------------------------------------------

export interface AnthropicProviderOpts {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function makeAnthropicProvider(opts: AnthropicProviderOpts): TriageProvider {
  if (!opts.apiKey) throw new Error("anthropic provider requires PEBBLE_ANTHROPIC_API_KEY");
  const model = opts.model ?? "claude-haiku-4-5";
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");

  return makeApiProvider({
    name: "anthropic",
    fetchImpl: opts.fetchImpl ?? fetch,
    buildRequest(prompt) {
      return {
        url: `${baseUrl}/v1/messages`,
        init: {
          method: "POST",
          headers: {
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
          }),
        },
      };
    },
    extractText(body) {
      const env = body as { content?: Array<{ type?: string; text?: string }> };
      const parts = env.content ?? [];
      const text = parts
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim();
      if (!text) throw new Error("anthropic response had no text content");
      return text;
    },
  });
}

// --- OpenAI Responses API ------------------------------------------------

export interface OpenAIProviderOpts {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function makeOpenAIProvider(opts: OpenAIProviderOpts): TriageProvider {
  if (!opts.apiKey) throw new Error("openai provider requires PEBBLE_OPENAI_API_KEY");
  const model = opts.model ?? "gpt-5-mini";
  const baseUrl = (opts.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");

  return makeApiProvider({
    name: "openai",
    fetchImpl: opts.fetchImpl ?? fetch,
    buildRequest(prompt) {
      return {
        url: `${baseUrl}/v1/responses`,
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: prompt,
          }),
        },
      };
    },
    extractText(body) {
      const env = body as {
        output_text?: string;
        output?: Array<{
          content?: Array<{ type?: string; text?: string }>;
        }>;
      };
      // Responses API conveniences a top-level output_text aggregation.
      if (typeof env.output_text === "string" && env.output_text.trim()) {
        return env.output_text.trim();
      }
      const parts = (env.output ?? []).flatMap((o) => o.content ?? []);
      const text = parts
        .filter((p) => p && (p.type === "output_text" || p.type === "text") && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim();
      if (!text) throw new Error("openai response had no text content");
      return text;
    },
  });
}
