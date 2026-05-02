import matter from "gray-matter";
import type { NoteFrontmatter } from "../types/index.js";

/** Render frontmatter + body. We avoid yaml lib to keep deps small; gray-matter handles it. */
export function renderNote(fm: NoteFrontmatter, body: string): string {
  const file = matter.stringify(body.endsWith("\n") ? body : body + "\n", fm as Record<string, unknown>);
  return file;
}

export function parseNote(raw: string): { data: Record<string, unknown>; content: string } {
  const f = matter(raw);
  return { data: f.data as Record<string, unknown>, content: f.content };
}
