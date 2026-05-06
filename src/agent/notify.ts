import fs from "node:fs/promises";
import path from "node:path";
import {
  type AgentAction,
  AgentActionSchema,
  type ClarificationRequest,
} from "../types/index.js";
import { agentActionsLogPath } from "../vault/paths.js";
import { type BridgeSendArgs, sendBridgeMessage, BridgeSendError } from "../bridge/send.js";
import type { AgentContext } from "./tools.js";

export interface NotifyConfig {
  enabled: boolean;
  bridgeUrl: string;
  bridgeToken: string;
}

export interface NotifyDeps {
  ctx: AgentContext;
  config: NotifyConfig;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface NotifyResult {
  /** "sent" or "queued" if Bridge accepted the request; never throws on Bridge errors. */
  status: "sent" | "queued" | "skipped" | "already_notified" | "error";
  reason?: string;
  bridge_status?: string;
}

/**
 * Format a clarification's question (with options as numbered list, when
 * present) and post it to Pebble Bridge as an iMessage to `request.thread_id`.
 * Best-effort: any failure (flag off, missing config, HTTP error, network) is
 * audited and returned, never thrown — so a Bridge outage does not propagate
 * up into the ingest / triage / `/do` flow that staged the question.
 *
 * Idempotent: if `notified_at` is already set we no-op.
 */
export async function notifyClarification(
  deps: NotifyDeps,
  request: ClarificationRequest,
): Promise<NotifyResult> {
  const { ctx, config } = deps;

  if (request.notified_at) {
    return { status: "already_notified" };
  }
  if (!config.enabled) {
    await audit(ctx, request, false, "skipped: outbound_send disabled");
    return { status: "skipped", reason: "disabled" };
  }
  if (!config.bridgeUrl || !config.bridgeToken) {
    await audit(ctx, request, false, "skipped: bridge config missing");
    return { status: "skipped", reason: "no_config" };
  }

  const text = formatQuestion(request);
  const args: BridgeSendArgs = {
    url: config.bridgeUrl,
    token: config.bridgeToken,
    chat_id: request.thread_id,
    text,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };

  if (ctx.dryRun) {
    await audit(ctx, request, true, "dry-run");
    return { status: "sent", reason: "dry-run", bridge_status: "dry-run" };
  }

  try {
    const result = await sendBridgeMessage(args);
    if (result.status === "sent" || result.status === "queued") {
      ctx.db.markClarificationNotified({ id: request.id });
      await audit(ctx, request, true, `${result.status} via ${result.provider}`);
      return { status: result.status, bridge_status: result.status };
    }
    // unsupported / permission_required / failed — count as error, do not stamp notified_at.
    const reason = result.error?.message ?? result.reason ?? result.status;
    await audit(ctx, request, false, `bridge ${result.status}: ${reason}`);
    return { status: "error", reason, bridge_status: result.status };
  } catch (err) {
    const reason =
      err instanceof BridgeSendError
        ? `${err.code}: ${err.message}`
        : (err as Error).message;
    await audit(ctx, request, false, `bridge error: ${reason}`);
    return { status: "error", reason };
  }
}

export function formatQuestion(request: ClarificationRequest): string {
  const opts = request.options ?? [];
  if (opts.length === 0) return request.question;
  const numbered = opts.map((o, i) => `[${i + 1}] ${o}`).join("\n");
  return `${request.question}\n\n${numbered}`;
}

async function audit(
  ctx: AgentContext,
  request: ClarificationRequest,
  ok: boolean,
  summary: string,
): Promise<void> {
  const action: AgentAction = AgentActionSchema.parse({
    ts: new Date().toISOString(),
    agent: ctx.agent,
    tool: "stage_clarification",
    args: {
      op: "notify",
      clarification_id: request.id,
      thread_id: request.thread_id,
      question_len: request.question.length,
      options_count: (request.options ?? []).length,
    },
    dry_run: ctx.dryRun,
    ok,
    result_summary: summary,
  });
  ctx.db.logAgentAction(action);
  const logPath = agentActionsLogPath(ctx.vaultPath);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(action) + "\n", "utf8");
}
