import type { IngestPayload, IngestionAdapter } from "../types/index.js";

/**
 * Pebble Bridge adapter.
 *
 * Pebble Bridge (sibling repo at `~/Projects/Pebble Bridge`, see
 * `docs/DEPLOY-PEBBLE-BRIDGE.md`) exposes an SSE stream `GET /api/v1/events`
 * that emits envelopes shaped:
 *
 *   {
 *     "type": "message.created",
 *     "timestamp": "<ISO>",
 *     "data": {
 *       "message_id": "...",
 *       "chat_id": "iMessage;-;+1555...",
 *       "service": "iMessage" | "SMS" | "unknown",
 *       "sender": "+1555..." | null,
 *       "text": "...",
 *       "timestamp": "<ISO>",
 *       "is_from_me": false,
 *       "attachments": []
 *     }
 *   }
 *
 * The companion forwarder script (scripts/forward-to-pebble.ts in the Bridge
 * repo) subscribes to that SSE stream and POSTs each event to Pebble's
 * `/ingest` as-is. This adapter recognizes that envelope.
 */
export const pebbleBridgeAdapter: IngestionAdapter = {
  name: "pebble-bridge",
  matches(_headers, body) {
    if (typeof body !== "object" || body === null) return false;
    const b = body as Record<string, unknown>;
    if (b.type !== "message.created") return false;
    if (typeof b.data !== "object" || b.data === null) return false;
    const d = b.data as Record<string, unknown>;
    return "message_id" in d && "is_from_me" in d;
  },
  normalize(body): IngestPayload {
    const b = body as { timestamp?: string; data: Record<string, any> };
    const d = b.data;

    const service = typeof d.service === "string" ? d.service : "unknown";
    const source = service === "SMS" ? "sms" : "imessage";

    const sender =
      (typeof d.sender === "string" && d.sender) ||
      (d.is_from_me === true ? "me" : "unknown");

    const threadId =
      (typeof d.chat_id === "string" && d.chat_id) ||
      (typeof d.message_id === "string" && d.message_id) ||
      sender;

    const ts =
      (typeof d.timestamp === "string" && d.timestamp) ||
      (typeof b.timestamp === "string" && b.timestamp) ||
      new Date().toISOString();

    return {
      source,
      sender,
      thread_id: threadId,
      text: typeof d.text === "string" ? d.text : "",
      timestamp: ts,
    };
  },
};
