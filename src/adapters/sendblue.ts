import type { IngestionAdapter } from "../types/index.js";

/**
 * Sendblue / Texting Blue style adapter.
 *
 * Sendblue inbound webhooks look roughly like:
 *   {
 *     "accountEmail": "...",
 *     "content": "<message text>",
 *     "media_url": "https://...",
 *     "is_outbound": false,
 *     "status": "RECEIVED",
 *     "error_code": null,
 *     "error_message": null,
 *     "message_handle": "...",
 *     "date_sent": "2024-01-01T12:00:00.000Z",
 *     "date_updated": "...",
 *     "from_number": "+15551234567",
 *     "number": "+15557654321",
 *     "was_downgraded": false
 *   }
 *
 * Reference: https://docs.sendblue.com.
 */
export const sendblueAdapter: IngestionAdapter = {
  name: "sendblue",
  matches(headers, body) {
    if (typeof body !== "object" || body === null) return false;
    const b = body as Record<string, unknown>;
    const ua = (headers["user-agent"] ?? headers["User-Agent"]) as string | undefined;
    const looksSendblue =
      "from_number" in b && "message_handle" in b && "content" in b;
    return Boolean(looksSendblue || (ua && /sendblue/i.test(ua)));
  },
  normalize(body) {
    const b = body as Record<string, any>;
    const attachments = b.media_url
      ? [{ kind: "file" as const, uri: String(b.media_url) }]
      : undefined;
    return {
      source: "imessage",
      sender: String(b.from_number ?? "unknown"),
      thread_id: String(b.from_number ?? b.message_handle ?? "unknown"),
      text: String(b.content ?? ""),
      attachments,
      timestamp: String(b.date_sent ?? new Date().toISOString()),
    };
  },
};
