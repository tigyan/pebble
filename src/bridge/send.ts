/**
 * Pebble Bridge outbound send client.
 *
 * Wraps `POST /api/v1/messages/send` on the Bridge (see Bridge `docs/API.md`).
 * Pure HTTP — does not look at settings or DB. Callers compose this with the
 * `outbound_send_enabled` settings flag and any idempotency they need.
 */

export type BridgeSendStatus = "queued" | "sent" | "failed" | "unsupported" | "permission_required";

export interface BridgeSendResult {
  status: BridgeSendStatus;
  provider: "mock" | "applescript" | "shortcuts";
  id?: string;
  queuedAt?: string;
  sentAt?: string;
  error?: { code: string; message: string };
  reason?: string;
}

export interface BridgeSendArgs {
  /** Bridge base URL, e.g. `http://127.0.0.1:8989`. No trailing slash. */
  url: string;
  /** Bearer token from the Bridge pairing flow. */
  token: string;
  /** Provide exactly one of `chat_id` or `handle`. */
  chat_id?: string;
  handle?: string;
  text: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 10s. */
  timeoutMs?: number;
}

export class BridgeSendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "BridgeSendError";
  }
}

export async function sendBridgeMessage(args: BridgeSendArgs): Promise<BridgeSendResult> {
  if (!args.url) throw new BridgeSendError("bridge URL not configured", "NO_URL", 0);
  if (!args.token) throw new BridgeSendError("bridge token not configured", "NO_TOKEN", 0);
  if (!args.text || !args.text.trim()) {
    throw new BridgeSendError("text is required", "INVALID_BODY", 0);
  }
  const exactlyOne = (args.chat_id ? 1 : 0) + (args.handle ? 1 : 0);
  if (exactlyOne !== 1) {
    throw new BridgeSendError(
      "exactly one of chat_id or handle is required",
      "INVALID_BODY",
      0,
    );
  }

  const f = args.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 10_000);

  let res: Response;
  try {
    res = await f(args.url.replace(/\/+$/, "") + "/api/v1/messages/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({
        ...(args.chat_id ? { chat_id: args.chat_id } : {}),
        ...(args.handle ? { handle: args.handle } : {}),
        text: args.text,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new BridgeSendError(
      `bridge request failed: ${(err as Error).message}`,
      "NETWORK",
      0,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let code = "HTTP_" + res.status;
    let msg = res.statusText || code;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) msg = body.error.message;
    } catch {
      // body wasn't JSON; keep the defaults
    }
    throw new BridgeSendError(msg, code, res.status);
  }

  const body = (await res.json()) as { ok?: boolean; data?: { result?: BridgeSendResult } };
  const result = body?.data?.result;
  if (!result || typeof result.status !== "string") {
    throw new BridgeSendError("malformed bridge response", "MALFORMED", res.status);
  }
  return result;
}
