/**
 * BlueBubbles attachment fetcher and server probe.
 *
 * The webhook delivers messages with attachments by reference (guid + mime
 * + transferName) — not the bytes. To materialize the actual file we hit
 * the BB Server's attachment-download endpoint:
 *
 *   GET <bb-url>/api/v1/attachment/<guid>/download?password=<password>
 *
 * Password resolution is NOT done here; callers pass it in (typically from
 * `SecretSource.get("PEBBLE_BLUEBUBBLES_PASSWORD")`). Passwords never enter
 * the markdown vault or the SQLite mirror.
 *
 * Reference: https://documentation.bluebubbles.app/server/api
 */

export interface BluebubblesConfig {
  /** Base URL, e.g. "http://192.168.1.42:1234" or "https://bb.example.com". */
  url: string;
  /** BB Server password (from SecretSource). */
  password: string;
}

export const BLUEBUBBLES_URI_SCHEME = "bluebubbles:";

/** Encode a guid into the canonical pebble-internal URI. */
export function bluebubblesUri(guid: string): string {
  return `bluebubbles://attachment/${encodeURIComponent(guid)}`;
}

/** Inverse of bluebubblesUri — null if the URI is not BB-shaped. */
export function parseBluebubblesUri(uri: string): { guid: string } | null {
  if (!uri.startsWith("bluebubbles://attachment/")) return null;
  const rest = uri.slice("bluebubbles://attachment/".length);
  if (!rest) return null;
  return { guid: decodeURIComponent(rest) };
}

export interface AttachmentResolverResult {
  data: Buffer;
  filename?: string;
  mime?: string;
}

export type AttachmentResolver = (uri: string) => Promise<AttachmentResolverResult>;

export function makeBluebubblesAttachmentResolver(
  cfg: BluebubblesConfig,
  fetchImpl: typeof fetch = fetch,
): AttachmentResolver {
  if (!cfg.url) throw new Error("bluebubbles: url is required");
  return async (uri: string) => {
    const parsed = parseBluebubblesUri(uri);
    if (!parsed) throw new Error(`bluebubbles resolver got non-bb uri: ${uri}`);
    const u = new URL(`/api/v1/attachment/${encodeURIComponent(parsed.guid)}/download`, cfg.url);
    if (cfg.password) u.searchParams.set("password", cfg.password);
    const res = await fetchImpl(u.toString());
    if (!res.ok) {
      throw new Error(`bluebubbles attachment fetch failed: ${res.status} (guid=${parsed.guid})`);
    }
    const ab = await res.arrayBuffer();
    const mime = res.headers.get("content-type") ?? undefined;
    const out: AttachmentResolverResult = { data: Buffer.from(ab) };
    if (mime) out.mime = mime;
    return out;
  };
}

/** Liveness probe used by `pebble doctor`. Resolves true on 2xx, false otherwise. */
export async function pingBluebubbles(
  cfg: BluebubblesConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; detail: string }> {
  if (!cfg.url) return { ok: false, status: 0, detail: "no url configured" };
  // /api/v1/ping is the canonical liveness endpoint exposed by BB Server.
  const u = new URL("/api/v1/ping", cfg.url);
  if (cfg.password) u.searchParams.set("password", cfg.password);
  try {
    const res = await fetchImpl(u.toString());
    return {
      ok: res.ok,
      status: res.status,
      detail: res.ok ? "reachable" : `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, status: 0, detail: (err as Error).message };
  }
}
