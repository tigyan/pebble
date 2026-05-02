import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PebbleDB } from "../db/client.js";
import { parseNote } from "../vault/frontmatter.js";

export interface IndexResult {
  scanned: number;
  indexed: number;
  skippedHidden: number;
}

/** Walk the vault and (re)index every .md file into the SQLite mirror + FTS. */
export async function indexVault(opts: {
  vaultPath: string;
  db: PebbleDB;
  /** Folders inside the vault to skip (defaults: _System, .obsidian, .trash). */
  skip?: string[];
}): Promise<IndexResult> {
  const skip = new Set(opts.skip ?? ["_System", ".obsidian", ".trash"]);
  const root = path.resolve(opts.vaultPath);

  let scanned = 0;
  let indexed = 0;
  let skippedHidden = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      const top = rel.split(path.sep)[0] ?? "";
      if (skip.has(top) || e.name.startsWith(".")) {
        skippedHidden++;
        continue;
      }
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        scanned++;
        await indexFile(abs);
        indexed++;
      }
    }
  }

  async function indexFile(abs: string): Promise<void> {
    const raw = await fs.readFile(abs, "utf8");
    const { data: fm, content } = parseNote(raw);
    const title = (fm["title"] as string | undefined) ?? deriveTitle(content, abs);
    const aliases = toStringArray(fm["aliases"]);
    const tags = mergeTags(toStringArray(fm["tags"]), extractInlineTags(content));
    const headings = extractHeadings(content);
    const links = extractWikilinks(content);
    const bodyHash = sha256(content);

    opts.db.upsertNote({
      path: abs,
      title,
      tags,
      aliases,
      headings,
      links,
      frontmatter: fm,
      body: content,
      bodyHash,
    });
  }

  await walk(root);
  return { scanned, indexed, skippedHidden };
}

function deriveTitle(content: string, abs: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m && m[1]) return m[1].trim();
  return path.basename(abs, ".md");
}

function extractHeadings(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)) {
    out.push(m[2]!.trim());
  }
  return out;
}

function extractWikilinks(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    out.add(m[1]!.trim());
  }
  return Array.from(out);
}

function extractInlineTags(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/(^|\s)#([a-z0-9_\-/]+)/gi)) {
    out.add(m[2]!);
  }
  return Array.from(out);
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return [v];
  return [];
}

function mergeTags(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
