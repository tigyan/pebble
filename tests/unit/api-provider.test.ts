import { describe, expect, it } from "vitest";
import {
  makeAnthropicProvider,
  makeCustomProvider,
  makeOpenAIProvider,
} from "../../src/triage/api-provider.js";
import type { IngestRecord } from "../../src/types/index.js";
import { getProvider } from "../../src/triage/classifier.js";

const VALID_TRIAGE = {
  type: "task",
  urgency: "high",
  suggested_folder: "Tasks",
  suggested_tags: ["type/task"],
  suggested_backlinks: [],
  is_task: true,
  duplicate_of: null,
  agent_confidence: 0.9,
  rationale: "looks like a todo",
};

function makeRecord(text = "TODO: ship MVP"): IngestRecord {
  return {
    id: "abc123",
    source: "manual",
    sender: "self",
    thread_id: "self",
    text,
    attachments: [],
    timestamp: "2026-05-02T09:00:00.000Z",
    received_at: "2026-05-02T09:00:00.000Z",
    status: "raw",
    original_text_hash: "h",
    inbox_path: "/v/Inbox/2026-05-02.md",
    thread_path: "/v/Sources/Manual/self.md",
    person_path: "/v/People/self.md",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("anthropic provider", () => {
  it("posts to /v1/messages and parses TriageResult", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return jsonResponse({
        content: [{ type: "text", text: JSON.stringify(VALID_TRIAGE) }],
      });
    }) as unknown as typeof fetch;

    const provider = makeAnthropicProvider({ apiKey: "k-abc", fetchImpl: fakeFetch });
    const result = await provider.classify(makeRecord());
    expect(result.type).toBe("task");
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k-abc");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(typeof body.messages[0].content).toBe("string");
  });

  it("honors PEBBLE_ANTHROPIC_MODEL override", async () => {
    let captured: { init: RequestInit } | null = null;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      captured = { init };
      return jsonResponse({ content: [{ type: "text", text: JSON.stringify(VALID_TRIAGE) }] });
    }) as unknown as typeof fetch;

    const provider = makeAnthropicProvider({
      apiKey: "k",
      model: "claude-opus-4-7",
      fetchImpl: fakeFetch,
    });
    await provider.classify(makeRecord());
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("claude-opus-4-7");
  });

  it("throws helpfully on non-2xx", async () => {
    const fakeFetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const provider = makeAnthropicProvider({ apiKey: "k", fetchImpl: fakeFetch });
    await expect(provider.classify(makeRecord())).rejects.toThrow(/anthropic HTTP 429/);
  });

  it("strips JSON fences in the model text", async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        content: [
          { type: "text", text: "```json\n" + JSON.stringify(VALID_TRIAGE) + "\n```" },
        ],
      })) as unknown as typeof fetch;
    const provider = makeAnthropicProvider({ apiKey: "k", fetchImpl: fakeFetch });
    const r = await provider.classify(makeRecord());
    expect(r.urgency).toBe("high");
  });

  it("throws if PEBBLE_ANTHROPIC_API_KEY missing via getProvider()", () => {
    expect(() => getProvider("anthropic", {} as NodeJS.ProcessEnv)).toThrow(
      /PEBBLE_ANTHROPIC_API_KEY/,
    );
  });
});

describe("openai provider", () => {
  it("posts to /v1/responses and parses output_text", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return jsonResponse({ output_text: JSON.stringify(VALID_TRIAGE) });
    }) as unknown as typeof fetch;

    const provider = makeOpenAIProvider({ apiKey: "sk-xxx", fetchImpl: fakeFetch });
    const result = await provider.classify(makeRecord());
    expect(result.type).toBe("task");
    expect(captured!.url).toBe("https://api.openai.com/v1/responses");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-xxx");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("gpt-5-mini");
    expect(typeof body.input).toBe("string");
  });

  it("falls back to output[].content[].text shape", async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        output: [
          { content: [{ type: "output_text", text: JSON.stringify(VALID_TRIAGE) }] },
        ],
      })) as unknown as typeof fetch;
    const provider = makeOpenAIProvider({ apiKey: "k", fetchImpl: fakeFetch });
    const r = await provider.classify(makeRecord());
    expect(r.type).toBe("task");
  });

  it("throws if PEBBLE_OPENAI_API_KEY missing via getProvider()", () => {
    expect(() => getProvider("openai", {} as NodeJS.ProcessEnv)).toThrow(
      /PEBBLE_OPENAI_API_KEY/,
    );
  });
});

describe("custom provider", () => {
  it("posts to /v1/chat/completions and parses choices[0].message.content", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(VALID_TRIAGE) } }],
      });
    }) as unknown as typeof fetch;

    const provider = makeCustomProvider({
      baseUrl: "https://openrouter.ai/api",
      model: "meta-llama/llama-3.3-70b-instruct:free",
      apiKey: "sk-or-xyz",
      fetchImpl: fakeFetch,
    });
    const result = await provider.classify(makeRecord());
    expect(result.type).toBe("task");
    expect(captured!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-or-xyz");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("meta-llama/llama-3.3-70b-instruct:free");
    expect(body.messages[0].role).toBe("user");
    expect(typeof body.messages[0].content).toBe("string");
  });

  it("omits Authorization when apiKey is empty (local Ollama-style)", async () => {
    let captured: { init: RequestInit } | null = null;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      captured = { init };
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(VALID_TRIAGE) } }],
      });
    }) as unknown as typeof fetch;

    const provider = makeCustomProvider({
      baseUrl: "http://localhost:11434",
      model: "llama3.2",
      fetchImpl: fakeFetch,
    });
    await provider.classify(makeRecord());
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("trims trailing slash on baseUrl and respects custom path", async () => {
    let captured: { url: string } | null = null;
    const fakeFetch = (async (url: string) => {
      captured = { url };
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(VALID_TRIAGE) } }],
      });
    }) as unknown as typeof fetch;

    const provider = makeCustomProvider({
      baseUrl: "http://localhost:1234/",
      model: "any",
      path: "/v1/chat/completions",
      fetchImpl: fakeFetch,
    });
    await provider.classify(makeRecord());
    expect(captured!.url).toBe("http://localhost:1234/v1/chat/completions");
  });

  it("supports array-shaped message.content", async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: [{ type: "text", text: JSON.stringify(VALID_TRIAGE) }],
            },
          },
        ],
      })) as unknown as typeof fetch;

    const provider = makeCustomProvider({
      baseUrl: "https://x",
      model: "m",
      fetchImpl: fakeFetch,
    });
    const r = await provider.classify(makeRecord());
    expect(r.type).toBe("task");
  });

  it("merges user-supplied extra headers", async () => {
    let captured: { init: RequestInit } | null = null;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      captured = { init };
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(VALID_TRIAGE) } }],
      });
    }) as unknown as typeof fetch;

    const provider = makeCustomProvider({
      baseUrl: "https://openrouter.ai/api",
      model: "m",
      apiKey: "k",
      headers: { "HTTP-Referer": "https://pebble.local", "X-Title": "Pebble" },
      fetchImpl: fakeFetch,
    });
    await provider.classify(makeRecord());
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://pebble.local");
    expect(headers["X-Title"]).toBe("Pebble");
    expect(headers.authorization).toBe("Bearer k");
  });

  it("throws helpfully on non-2xx", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 502 })) as unknown as typeof fetch;
    const provider = makeCustomProvider({
      baseUrl: "https://x",
      model: "m",
      fetchImpl: fakeFetch,
    });
    await expect(provider.classify(makeRecord())).rejects.toThrow(/custom HTTP 502/);
  });

  it("getProvider('custom') requires PEBBLE_CUSTOM_BASE_URL", () => {
    expect(() => getProvider("custom", {} as NodeJS.ProcessEnv)).toThrow(
      /PEBBLE_CUSTOM_BASE_URL/,
    );
  });

  it("getProvider('custom') requires PEBBLE_CUSTOM_MODEL", () => {
    expect(() =>
      getProvider("custom", {
        PEBBLE_CUSTOM_BASE_URL: "https://x",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/PEBBLE_CUSTOM_MODEL/);
  });

  it("getProvider('custom') wires base url, model, key, and headers", async () => {
    const env = {
      PEBBLE_CUSTOM_BASE_URL: "https://openrouter.ai/api",
      PEBBLE_CUSTOM_MODEL: "z-ai/glm-4.6:free",
      PEBBLE_CUSTOM_API_KEY: "sk-or-test",
      PEBBLE_CUSTOM_HEADERS: JSON.stringify({ "X-Title": "Pebble" }),
    } as unknown as NodeJS.ProcessEnv;
    const p = getProvider("custom", env);
    expect(p.name).toBe("custom");
  });

  it("getProvider('custom') rejects malformed PEBBLE_CUSTOM_HEADERS", () => {
    const env = {
      PEBBLE_CUSTOM_BASE_URL: "https://x",
      PEBBLE_CUSTOM_MODEL: "m",
      PEBBLE_CUSTOM_HEADERS: "not-json",
    } as unknown as NodeJS.ProcessEnv;
    expect(() => getProvider("custom", env)).toThrow(/PEBBLE_CUSTOM_HEADERS/);
  });
});
