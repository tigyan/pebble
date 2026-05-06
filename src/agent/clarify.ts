import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  type AgentAction,
  AgentActionSchema,
  type ClarificationRequest,
  ClarificationRequestSchema,
  type ClarificationSourceKind,
} from "../types/index.js";
import { agentActionsLogPath } from "../vault/paths.js";
import type { AgentContext } from "./tools.js";

export interface StageClarificationArgs {
  source_kind: ClarificationSourceKind;
  ingestion_id?: string | null;
  sender: string;
  thread_id: string;
  question: string;
  options?: string[];
  context?: Record<string, unknown>;
}

export interface StageClarificationResult {
  request: ClarificationRequest;
  /** True if an open clarification already existed for this thread (no new row written). */
  reused: boolean;
}

/**
 * Stage a question the Librarian wants to ask the user. Persists a row in
 * `clarifications` and appends an `agent_actions` audit entry. Does NOT send
 * anything outbound — the caller (or a separate worker) handles routing the
 * question to iMessage / dashboard.
 *
 * Idempotent per thread: if there is already an `open` clarification on
 * `thread_id`, returns it with `reused: true` instead of creating a duplicate.
 */
export async function stageClarification(
  ctx: AgentContext,
  args: StageClarificationArgs,
): Promise<StageClarificationResult> {
  const existing = ctx.db.findOpenClarificationByThread(args.thread_id);
  if (existing) {
    await recordAction(
      ctx,
      buildAction(ctx, args, true, `reused ${existing.id}`),
    );
    return { request: existing, reused: true };
  }

  const request = ClarificationRequestSchema.parse({
    id: nanoid(12),
    created_at: new Date().toISOString(),
    status: "open",
    source_kind: args.source_kind,
    ingestion_id: args.ingestion_id ?? null,
    sender: args.sender,
    thread_id: args.thread_id,
    question: args.question,
    options: args.options ?? [],
    context: args.context ?? {},
    answered_at: null,
    answer_text: null,
  });

  if (!ctx.dryRun) {
    ctx.db.insertClarification(request);
  }

  await recordAction(
    ctx,
    buildAction(ctx, args, true, ctx.dryRun ? "dry-run" : `staged ${request.id}`),
  );

  return { request, reused: false };
}

function buildAction(
  ctx: AgentContext,
  args: StageClarificationArgs,
  ok: boolean,
  summary?: string,
): AgentAction {
  return AgentActionSchema.parse({
    ts: new Date().toISOString(),
    agent: ctx.agent,
    tool: "stage_clarification",
    args: {
      source_kind: args.source_kind,
      ingestion_id: args.ingestion_id ?? null,
      thread_id: args.thread_id,
      question_len: args.question.length,
      options_count: (args.options ?? []).length,
    },
    dry_run: ctx.dryRun,
    ok,
    ...(summary !== undefined ? { result_summary: summary } : {}),
  });
}

export interface ResolveReplyArgs {
  sender: string;
  thread_id: string;
  text: string;
}

export interface ResolveReplyResult {
  request: ClarificationRequest;
}

/**
 * If `payload`'s thread has an open clarification, mark it answered with the
 * raw inbound text and audit the resolution. Returns `null` when there is
 * nothing to resolve — caller continues with normal ingestion in that case.
 *
 * The raw text is stored verbatim; mapping "1" / "Inbox" / "первое" onto the
 * staged options is deferred to whoever resumes the original task (they hold
 * the `context.kind` discriminator).
 */
export async function tryResolveClarification(
  ctx: AgentContext,
  args: ResolveReplyArgs,
): Promise<ResolveReplyResult | null> {
  const open = ctx.db.findOpenClarificationByThread(args.thread_id);
  if (!open) return null;

  const answered_at = new Date().toISOString();
  if (!ctx.dryRun) {
    ctx.db.resolveClarification({
      id: open.id,
      answer_text: args.text,
      answered_at,
    });
  }

  const summary = ctx.dryRun ? "dry-run" : `resolved ${open.id}`;
  await recordAction(
    ctx,
    AgentActionSchema.parse({
      ts: answered_at,
      agent: ctx.agent,
      tool: "stage_clarification",
      args: {
        op: "resolve",
        clarification_id: open.id,
        thread_id: args.thread_id,
        answer_len: args.text.length,
      },
      dry_run: ctx.dryRun,
      ok: true,
      result_summary: summary,
    }),
  );

  return {
    request: {
      ...open,
      status: ctx.dryRun ? open.status : "answered",
      answered_at: ctx.dryRun ? open.answered_at : answered_at,
      answer_text: ctx.dryRun ? open.answer_text : args.text,
    },
  };
}

async function recordAction(ctx: AgentContext, action: AgentAction): Promise<void> {
  ctx.db.logAgentAction(action);
  const logPath = agentActionsLogPath(ctx.vaultPath);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(action) + "\n", "utf8");
}
