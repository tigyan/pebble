import path from "node:path";

/** Directory layout, all relative to the vault root. */
export const VAULT_DIRS = {
  inbox: "Inbox",
  sources: "Sources",
  people: "People",
  system: "_System",
  patches: "_System/patches",
  attachments: "_System/attachments",
} as const;

const SAFE = /[^a-zA-Z0-9._\-+@ ]/g;

/** Make a sender/thread id safe for filesystem use. Never hashes — just normalizes. */
export function normalizeSegment(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "unknown";
  // Preserve human readability for things like phone numbers or emails.
  return trimmed.replace(SAFE, "_").slice(0, 120);
}

export function inboxPathFor(vault: string, isoDate: string): string {
  const day = isoDate.slice(0, 10); // YYYY-MM-DD
  return path.join(vault, VAULT_DIRS.inbox, `${day}.md`);
}

export function threadPathFor(
  vault: string,
  source: string,
  threadId: string,
): string {
  return path.join(
    vault,
    VAULT_DIRS.sources,
    capitalize(source),
    `${normalizeSegment(threadId)}.md`,
  );
}

export function personPathFor(vault: string, sender: string): string {
  return path.join(vault, VAULT_DIRS.people, `${normalizeSegment(sender)}.md`);
}

export function ingestionLogPath(vault: string): string {
  return path.join(vault, VAULT_DIRS.system, "ingestion-log.jsonl");
}

export function agentActionsLogPath(vault: string): string {
  return path.join(vault, VAULT_DIRS.system, "agent-actions.jsonl");
}

function capitalize(s: string): string {
  if (!s) return s;
  if (s === "imessage") return "iMessage";
  return s[0]!.toUpperCase() + s.slice(1);
}
