import type { IngestionAdapter } from "../types/index.js";

/**
 * BlueBubbles webhook adapter.
 *
 * BlueBubbles sends a JSON envelope like:
 *   {
 *     "type": "new-message",
 *     "data": {
 *       "guid": "...",
 *       "text": "...",
 *       "dateCreated": 1700000000000,
 *       "handle": { "address": "+15551234567" },
 *       "chats": [{ "guid": "iMessage;-;chat...", "displayName": "..." }],
 *       "attachments": [{ "guid": "...", "mimeType": "image/jpeg", "transferName": "..." }]
 *     }
 *   }
 *
 * Reference: https://bluebubbles.app (community webhook plugin).
 */
export const bluebubblesAdapter: IngestionAdapter = {
  name: "bluebubbles",
  matches(_headers, body) {
    if (typeof body !== "object" || body === null) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.type !== "string") return false;
    if (typeof b.data !== "object" || b.data === null) return false;
    const d = b.data as Record<string, unknown>;
    return "guid" in d && ("dateCreated" in d || "text" in d);
  },
  normalize(body) {
    const b = body as { type: string; data: Record<string, any> };
    const d = b.data;
    const handleAddr =
      (d.handle && (d.handle.address as string)) ||
      (d.from && (d.from.address as string)) ||
      "unknown";
    const chat = Array.isArray(d.chats) && d.chats.length ? d.chats[0] : undefined;
    const threadId = chat?.guid ?? d.guid ?? handleAddr;

    const ts =
      typeof d.dateCreated === "number"
        ? new Date(d.dateCreated).toISOString()
        : new Date().toISOString();

    const attachments = Array.isArray(d.attachments)
      ? d.attachments.map((a: any) => ({
          kind: guessKind(a.mimeType),
          uri: a.transferName ?? a.guid ?? "unknown",
          mime: a.mimeType,
          filename: a.transferName,
          bytes: a.totalBytes,
        }))
      : undefined;

    return {
      source: "imessage",
      sender: handleAddr,
      thread_id: String(threadId),
      text: String(d.text ?? ""),
      attachments,
      timestamp: ts,
    };
  },
};

function guessKind(mime: string | undefined): "image" | "audio" | "video" | "file" {
  if (!mime) return "file";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}
