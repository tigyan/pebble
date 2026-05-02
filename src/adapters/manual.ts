import type { IngestionAdapter } from "../types/index.js";

/**
 * Pass-through adapter. Accepts the canonical IngestPayload shape directly.
 * Used by the CLI, by manual curl calls, and as a fallback for any provider
 * that already produces our schema.
 */
export const manualAdapter: IngestionAdapter = {
  name: "manual",
  matches() {
    return true;
  },
  normalize(body) {
    if (typeof body !== "object" || body === null) {
      throw new Error("manual adapter expects a JSON object body");
    }
    const b = body as Record<string, unknown>;
    return {
      source: (b.source as any) ?? "manual",
      sender: String(b.sender ?? "self"),
      thread_id: String(b.thread_id ?? "manual"),
      text: String(b.text ?? ""),
      attachments: (b.attachments as any) ?? undefined,
      timestamp: (b.timestamp as string) ?? new Date().toISOString(),
    };
  },
};
