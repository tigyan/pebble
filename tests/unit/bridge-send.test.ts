import { describe, expect, it } from "vitest";
import { sendBridgeMessage, BridgeSendError } from "../../src/bridge/send.js";

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string, init: RequestInit) => Promise.resolve(impl(url, init))) as unknown as typeof fetch;
}

describe("sendBridgeMessage", () => {
  it("posts to /api/v1/messages/send with bearer token + json body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = mockFetch((url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ ok: true, data: { result: { status: "sent", provider: "applescript", id: "m1", sentAt: "t" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const r = await sendBridgeMessage({
      url: "http://127.0.0.1:8989/",
      token: "tok",
      chat_id: "iMessage;-;+1",
      text: "hello",
      fetchImpl,
    });
    expect(r.status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8989/api/v1/messages/send");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ chat_id: "iMessage;-;+1", text: "hello" });
  });

  it("rejects when both chat_id and handle are provided", async () => {
    await expect(
      sendBridgeMessage({
        url: "http://x",
        token: "t",
        chat_id: "a",
        handle: "b",
        text: "hi",
        fetchImpl: mockFetch(() => new Response("{}", { status: 200 })),
      }),
    ).rejects.toBeInstanceOf(BridgeSendError);
  });

  it("rejects when neither chat_id nor handle is provided", async () => {
    await expect(
      sendBridgeMessage({
        url: "http://x",
        token: "t",
        text: "hi",
        fetchImpl: mockFetch(() => new Response("{}", { status: 200 })),
      }),
    ).rejects.toBeInstanceOf(BridgeSendError);
  });

  it("propagates Bridge error code on non-2xx", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await sendBridgeMessage({ url: "http://x", token: "t", handle: "+1", text: "hi", fetchImpl });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeSendError);
      const e = err as BridgeSendError;
      expect(e.code).toBe("RATE_LIMITED");
      expect(e.status).toBe(429);
    }
  });

  it("flags malformed responses", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      sendBridgeMessage({ url: "http://x", token: "t", handle: "+1", text: "hi", fetchImpl }),
    ).rejects.toThrow(/malformed/);
  });
});
