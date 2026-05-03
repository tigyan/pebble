import { describe, expect, it } from "vitest";
import { normalize } from "../../src/adapters/index.js";
import {
  bluebubblesUri,
  makeBluebubblesAttachmentResolver,
  parseBluebubblesUri,
  pingBluebubbles,
} from "../../src/adapters/bluebubbles-fetch.js";

describe("bluebubbles URI helpers", () => {
  it("round-trips a guid", () => {
    expect(parseBluebubblesUri(bluebubblesUri("abc-123"))?.guid).toBe("abc-123");
  });
  it("URL-encodes special characters", () => {
    const u = bluebubblesUri("imessage;-;chat@host");
    expect(u).toContain("imessage%3B-%3Bchat%40host");
    expect(parseBluebubblesUri(u)?.guid).toBe("imessage;-;chat@host");
  });
  it("rejects non-bb URIs", () => {
    expect(parseBluebubblesUri("https://example.com/x")).toBeNull();
    expect(parseBluebubblesUri("bluebubbles://attachment/")).toBeNull();
  });
});

describe("bluebubbles adapter — attachments use bluebubbles:// URIs", () => {
  it("encodes guid into the canonical scheme and drops attachments without a guid", () => {
    const body = {
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "with photo",
        dateCreated: 1700000000000,
        handle: { address: "+15550001234" },
        chats: [{ guid: "iMessage;-;chat-x", displayName: "x" }],
        attachments: [
          {
            guid: "att-abc",
            mimeType: "image/jpeg",
            transferName: "photo.jpg",
            totalBytes: 12345,
          },
          { mimeType: "image/png" }, // no guid → must be filtered
        ],
      },
    };
    const { payload } = normalize({}, body);
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments![0]!.uri).toBe("bluebubbles://attachment/att-abc");
    expect(payload.attachments![0]!.filename).toBe("photo.jpg");
    expect(payload.attachments![0]!.kind).toBe("image");
  });
});

describe("makeBluebubblesAttachmentResolver", () => {
  it("hits /api/v1/attachment/<guid>/download with password as a query param", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    const resolver = makeBluebubblesAttachmentResolver(
      { url: "http://localhost:1234", password: "s3cret" },
      fakeFetch,
    );
    const out = await resolver("bluebubbles://attachment/att-abc");
    expect(out.data.length).toBe(4);
    expect(out.mime).toBe("image/jpeg");
    expect(calls[0]).toBe(
      "http://localhost:1234/api/v1/attachment/att-abc/download?password=s3cret",
    );
  });

  it("URL-encodes guids with reserved characters", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as unknown as typeof fetch;
    const resolver = makeBluebubblesAttachmentResolver(
      { url: "http://localhost:1234", password: "" },
      fakeFetch,
    );
    await resolver("bluebubbles://attachment/" + encodeURIComponent("a/b@c"));
    expect(calls[0]).toContain("/api/v1/attachment/a%2Fb%40c/download");
  });

  it("throws on non-2xx responses", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const resolver = makeBluebubblesAttachmentResolver(
      { url: "http://localhost:1234", password: "x" },
      fakeFetch,
    );
    await expect(resolver("bluebubbles://attachment/zzz")).rejects.toThrow(
      /404/,
    );
  });

  it("rejects non-bluebubbles:// URIs", async () => {
    const resolver = makeBluebubblesAttachmentResolver(
      { url: "http://localhost", password: "" },
      (async () => new Response()) as unknown as typeof fetch,
    );
    await expect(resolver("https://example.com/x")).rejects.toThrow(/non-bb/);
  });
});

describe("pingBluebubbles", () => {
  it("returns ok=true on 200", async () => {
    const fakeFetch = (async () =>
      new Response("pong", { status: 200 })) as unknown as typeof fetch;
    const r = await pingBluebubbles({ url: "http://x", password: "p" }, fakeFetch);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });
  it("returns ok=false on network errors", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await pingBluebubbles({ url: "http://x", password: "" }, fakeFetch);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ECONNREFUSED");
  });
  it("returns ok=false when no url is configured", async () => {
    const r = await pingBluebubbles({ url: "", password: "" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no url");
  });
});
