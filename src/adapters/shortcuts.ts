import type { IngestionAdapter } from "../types/index.js";

/**
 * Apple Shortcuts → POST JSON adapter.
 *
 * Recommended Shortcut payload (this is what we tell users to build):
 *   {
 *     "source": "imessage" | "shortcut",
 *     "sender": "<contact name or number>",
 *     "thread_id": "<conversation id, fallback to sender>",
 *     "text": "<dictated or typed text>",
 *     "timestamp": "<ISO 8601>"
 *   }
 *
 * Shortcuts also commonly send User-Agent containing "Shortcuts" and may set
 * X-Shortcut-Name. We sniff both as soft signals; payload shape decides.
 */
export const shortcutsAdapter: IngestionAdapter = {
  name: "shortcuts",
  matches(headers, body) {
    const ua = headerValue(headers, "user-agent")?.toLowerCase() ?? "";
    const sn = headerValue(headers, "x-shortcut-name");
    if (ua.includes("shortcuts") || sn) return true;
    if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      if (b.source === "shortcut") return true;
    }
    return false;
  },
  normalize(body) {
    const b = (body ?? {}) as Record<string, unknown>;
    return {
      source: ((b.source as string) ?? "shortcut") as any,
      sender: String(b.sender ?? "self"),
      thread_id: String(b.thread_id ?? b.sender ?? "shortcut"),
      text: String(b.text ?? ""),
      attachments: (b.attachments as any) ?? undefined,
      timestamp: (b.timestamp as string) ?? new Date().toISOString(),
    };
  },
};

function headerValue(
  h: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = h[name] ?? h[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}
