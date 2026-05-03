import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeAttachments } from "../../src/ingest/attachments.js";
import { makeTempVault, rmRf } from "../helpers.js";

let vault = "";
beforeEach(async () => {
  vault = await makeTempVault();
  await fs.mkdir(path.join(vault, "_System", "attachments"), { recursive: true });
});
afterEach(async () => {
  await rmRf(vault);
});

describe("materializeAttachments", () => {
  it("copies http(s) attachments via fetch and rewrites uri to vault-relative", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("https://example.test/cat.png");
      return new Response(Buffer.from([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const out = await materializeAttachments(
      [{ kind: "image", uri: "https://example.test/cat.png" }],
      { vaultPath: vault, fetchImpl: fakeFetch },
    );

    expect(out).toHaveLength(1);
    const a = out[0]!;
    expect(a.uri.startsWith(path.join("_System", "attachments"))).toBe(true);
    expect(a.uri.endsWith("cat.png")).toBe(true);
    expect(a.bytes).toBe(4);

    const onDisk = await fs.readFile(path.join(vault, a.uri));
    expect(onDisk.length).toBe(4);
  });

  it("decodes data: URIs and writes them locally", async () => {
    const buf = Buffer.from("hello world", "utf8");
    const dataUri = "data:text/plain;base64," + buf.toString("base64");
    const out = await materializeAttachments(
      [{ kind: "file", uri: dataUri, filename: "note.txt" }],
      { vaultPath: vault },
    );
    const onDisk = await fs.readFile(path.join(vault, out[0]!.uri), "utf8");
    expect(onDisk).toBe("hello world");
    expect(out[0]!.uri.endsWith("note.txt")).toBe(true);
  });

  it("copies absolute filesystem paths into the vault attachments dir", async () => {
    // Stage a file outside the vault to simulate a disk-attached drop.
    const tmp = await makeTempVault("attach-source-");
    const srcFile = path.join(tmp, "source.bin");
    await fs.writeFile(srcFile, Buffer.from([9, 9, 9]));
    try {
      const out = await materializeAttachments(
        [{ kind: "file", uri: srcFile }],
        { vaultPath: vault },
      );
      expect(out[0]!.uri.startsWith(path.join("_System", "attachments"))).toBe(true);
      const persisted = await fs.readFile(path.join(vault, out[0]!.uri));
      expect(persisted.length).toBe(3);
    } finally {
      await rmRf(tmp);
    }
  });

  it("leaves vault-internal absolute paths and relative paths untouched", async () => {
    const internal = path.join(vault, "_System", "attachments", "kept.bin");
    await fs.writeFile(internal, Buffer.from([1]));
    const before = (await fs.readdir(path.join(vault, "_System", "attachments"))).length;

    const out = await materializeAttachments(
      [
        { kind: "file", uri: internal },
        { kind: "file", uri: "_System/attachments/relative.bin" },
      ],
      { vaultPath: vault },
    );
    expect(out[0]!.uri).toBe(internal);
    expect(out[1]!.uri).toBe("_System/attachments/relative.bin");

    // No new files written.
    const after = (await fs.readdir(path.join(vault, "_System", "attachments"))).length;
    expect(after).toBe(before);
  });

  it("enforces the maxBytes guardrail", async () => {
    const fakeFetch = (async () =>
      new Response(Buffer.alloc(1024), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      materializeAttachments(
        [{ kind: "file", uri: "https://example.test/big" }],
        { vaultPath: vault, fetchImpl: fakeFetch, maxBytes: 100 },
      ),
    ).rejects.toThrow(/exceeds/);
  });

  it("propagates a non-2xx fetch as an error", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(
      materializeAttachments(
        [{ kind: "image", uri: "https://example.test/missing.png" }],
        { vaultPath: vault, fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow(/404/);
  });

  it("invokes a custom-scheme resolver and writes its bytes into the vault", async () => {
    const calls: string[] = [];
    const out = await materializeAttachments(
      [
        {
          kind: "image",
          uri: "bluebubbles://attachment/abc",
          mime: "image/jpeg",
          filename: "photo.jpg",
        },
      ],
      {
        vaultPath: vault,
        resolvers: {
          "bluebubbles:": async (uri: string) => {
            calls.push(uri);
            return { data: Buffer.from("fake-jpeg-bytes"), mime: "image/jpeg" };
          },
        },
      },
    );
    expect(calls).toEqual(["bluebubbles://attachment/abc"]);
    expect(out[0]!.uri.startsWith(path.join("_System", "attachments"))).toBe(true);
    expect(out[0]!.uri).not.toContain("bluebubbles:");
    const onDisk = await fs.readFile(path.join(vault, out[0]!.uri), "utf8");
    expect(onDisk).toBe("fake-jpeg-bytes");
  });

  it("leaves the URI unchanged when no resolver matches the scheme", async () => {
    const out = await materializeAttachments(
      [{ kind: "file", uri: "bluebubbles://attachment/abc" }],
      { vaultPath: vault },
    );
    expect(out[0]!.uri).toBe("bluebubbles://attachment/abc");
  });

  it("enforces maxBytes for resolver-backed downloads", async () => {
    await expect(
      materializeAttachments(
        [{ kind: "file", uri: "bluebubbles://attachment/big" }],
        {
          vaultPath: vault,
          maxBytes: 4,
          resolvers: {
            "bluebubbles:": async () => ({ data: Buffer.alloc(8) }),
          },
        },
      ),
    ).rejects.toThrow(/exceeds 4 bytes/);
  });

  it("sanitizes filenames to a safe charset", async () => {
    const buf = Buffer.from("x", "utf8");
    const dataUri = "data:text/plain;base64," + buf.toString("base64");
    const out = await materializeAttachments(
      [{ kind: "file", uri: dataUri, filename: "../../etc/passwd evil ☠.txt" }],
      { vaultPath: vault },
    );
    const fname = path.basename(out[0]!.uri);
    // No traversal, no spaces, no exotic characters.
    expect(fname).not.toContain("..");
    expect(fname).not.toContain("/");
    expect(fname).not.toContain(" ");
    expect(/^[a-zA-Z0-9._-]+$/.test(fname)).toBe(true);
  });
});
