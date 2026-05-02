import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Attachment } from "../types/index.js";
import { VAULT_DIRS } from "../vault/paths.js";

const FILENAME_SAFE = /[^a-zA-Z0-9._-]/g;
const MAX_FILENAME = 80;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB

export interface MaterializeOptions {
  vaultPath: string;
  /** Hard cap per remote attachment. Default 32 MiB. */
  maxBytes?: number;
  /** Optional fetch override (for tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Copy any remote / out-of-vault attachments into `<vault>/_System/attachments/`
 * and rewrite their uri to a relative path inside the vault. Already-internal
 * attachments are returned unchanged.
 *
 * Privacy invariant: attachments are stored locally and referenced by path.
 * They are NEVER auto-uploaded to model providers.
 */
export async function materializeAttachments(
  attachments: Attachment[] | undefined,
  opts: MaterializeOptions,
): Promise<Attachment[]> {
  if (!attachments || attachments.length === 0) return [];
  const out: Attachment[] = [];
  for (const a of attachments) {
    out.push(await materializeOne(a, opts));
  }
  return out;
}

async function materializeOne(att: Attachment, opts: MaterializeOptions): Promise<Attachment> {
  const vault = path.resolve(opts.vaultPath);
  const dir = path.join(vault, VAULT_DIRS.attachments);
  await fs.mkdir(dir, { recursive: true });

  const uri = att.uri;
  // Already inside the vault → leave alone.
  if (isInsideVault(uri, vault)) return att;

  const id = nanoid(8);
  const baseName = sanitizeFilename(att.filename ?? guessName(uri));
  const targetName = `${id}-${baseName}`;
  const targetPath = path.join(dir, targetName);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let bytes = 0;
  if (uri.startsWith("data:")) {
    const buf = decodeDataUri(uri);
    if (buf.byteLength > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
    await fs.writeFile(targetPath, buf);
    bytes = buf.byteLength;
  } else if (/^https?:\/\//i.test(uri)) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(uri);
    if (!res.ok) throw new Error(`attachment fetch failed: ${res.status} ${uri}`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
    await fs.writeFile(targetPath, Buffer.from(ab));
    bytes = ab.byteLength;
  } else if (path.isAbsolute(uri)) {
    const stat = await fs.stat(uri);
    if (stat.size > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
    await fs.copyFile(uri, targetPath);
    bytes = stat.size;
  } else {
    // Unknown / relative scheme — leave as-is, don't pretend we copied it.
    return att;
  }

  return {
    ...att,
    uri: path.relative(vault, targetPath),
    filename: att.filename ?? baseName,
    bytes: att.bytes ?? bytes,
  };
}

function isInsideVault(uri: string, vault: string): boolean {
  if (!path.isAbsolute(uri)) {
    if (/^[a-z]+:/i.test(uri)) return false; // url-like
    // relative path → assume vault-relative, leave alone
    return true;
  }
  const rel = path.relative(vault, uri);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function decodeDataUri(uri: string): Buffer {
  const m = uri.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!m) throw new Error("invalid data: URI");
  const isBase64 = m[2] === ";base64";
  const payload = m[3] ?? "";
  return isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  const cleaned = base.replace(FILENAME_SAFE, "_").replace(/_+/g, "_");
  const trimmed = cleaned.length > MAX_FILENAME ? cleaned.slice(0, MAX_FILENAME) : cleaned;
  return trimmed || "attachment";
}

function guessName(uri: string): string {
  if (uri.startsWith("data:")) {
    const m = uri.match(/^data:([^;,]*)/);
    const ext = (m?.[1] ?? "application/octet-stream").split("/")[1] ?? "bin";
    const stamp = createHash("sha1").update(uri).digest("hex").slice(0, 6);
    return `data-${stamp}.${ext}`;
  }
  try {
    const u = new URL(uri);
    const last = path.basename(u.pathname) || "download";
    return last;
  } catch {
    return path.basename(uri) || "attachment";
  }
}
