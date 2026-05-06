import { z } from "zod";

// --- Inbound payload (webhook contract) ----------------------------------

export const SourceSchema = z.enum(["imessage", "sms", "shortcut", "manual"]);
export type Source = z.infer<typeof SourceSchema>;

export const AttachmentSchema = z.object({
  kind: z.enum(["image", "audio", "video", "file", "link"]).default("file"),
  // Local path inside the vault (preferred) OR a remote URI we will copy in.
  uri: z.string().min(1),
  mime: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  filename: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const IngestPayloadSchema = z.object({
  source: SourceSchema,
  sender: z.string().min(1),
  thread_id: z.string().min(1),
  text: z.string().default(""),
  attachments: z.array(AttachmentSchema).optional(),
  timestamp: z
    .string()
    .datetime({ offset: true })
    .or(z.string().datetime())
    .default(() => new Date().toISOString()),
});
export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

// --- Internal record (after ingestion) -----------------------------------

export const IngestStatusSchema = z.enum(["raw", "triaged", "filed", "linked", "rejected"]);
export type IngestStatus = z.infer<typeof IngestStatusSchema>;

export const IngestRecordSchema = IngestPayloadSchema.extend({
  id: z.string().min(1),
  received_at: z.string().datetime(),
  status: IngestStatusSchema.default("raw"),
  original_text_hash: z.string().min(1),
  inbox_path: z.string().min(1),
  thread_path: z.string().min(1),
  person_path: z.string().min(1),
});
export type IngestRecord = z.infer<typeof IngestRecordSchema>;

// --- Triage classifier output --------------------------------------------

export const NoteTypeSchema = z.enum([
  "idea",
  "task",
  "meeting_note",
  "contact",
  "project_note",
  "reference",
  "question",
  "journal",
  "finance",
  "travel",
  "media",
  "other",
]);
export type NoteType = z.infer<typeof NoteTypeSchema>;

export const UrgencySchema = z.enum(["none", "low", "medium", "high"]);
export type Urgency = z.infer<typeof UrgencySchema>;

export const TriageResultSchema = z.object({
  type: NoteTypeSchema,
  urgency: UrgencySchema,
  suggested_folder: z.string().min(1),
  suggested_tags: z.array(z.string().min(1)).default([]),
  suggested_backlinks: z.array(z.string().min(1)).default([]),
  is_task: z.boolean().default(false),
  duplicate_of: z.string().nullable().default(null),
  agent_confidence: z.number().min(0).max(1),
  rationale: z.string().max(2000).optional(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

// --- /do command result --------------------------------------------------

/**
 * What a CommandProvider returns for a `/do` request. The provider sees the
 * user's instruction plus a short list of vault candidates (top FTS hits) and
 * decides where to write. We re-validate with Zod before any filesystem op.
 */
export const CommandResultSchema = z.object({
  /** Append to an existing note, or create a new one. */
  action: z.enum(["append", "create"]),
  /** Vault-relative path. Must end in `.md`; refused if it escapes the vault. */
  target_path: z.string().min(1),
  /** Markdown body to write. Must be non-empty. */
  markdown: z.string().min(1),
  /** One-sentence reason for auditability (optional). */
  rationale: z.string().max(500).optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

/**
 * Tool-loop step for `/do`. The provider can either request reads of vault
 * notes (so it can ground the final write in real content) or emit the
 * terminal write (`CommandResult`). The runner caps total steps so the loop
 * can't run away.
 */
export const CommandReadRequestSchema = z.object({
  action: z.literal("read"),
  paths: z.array(z.string().min(1)).min(1).max(5),
  rationale: z.string().max(500).optional(),
});
export type CommandReadRequest = z.infer<typeof CommandReadRequestSchema>;

export const CommandStepSchema = z.union([
  CommandReadRequestSchema,
  CommandResultSchema,
]);
export type CommandStep = z.infer<typeof CommandStepSchema>;

// --- Clarification (Librarian asks the user back) ------------------------

/**
 * When the agent (triage / `/do` / filing) cannot file confidently it stages
 * a `ClarificationRequest`: a single concrete question, optional choice list,
 * and enough context to resume once the user answers. Persisted in SQLite so
 * an inbound reply on the same `thread_id` can be matched and applied.
 *
 * `source_kind` distinguishes who asked:
 *   - `do_command` — `/do` couldn't confidently pick a target
 *   - `ingestion`  — passive triage/filing got stuck on a raw item
 */
export const ClarificationSourceKindSchema = z.enum(["do_command", "ingestion"]);
export type ClarificationSourceKind = z.infer<typeof ClarificationSourceKindSchema>;

export const ClarificationStatusSchema = z.enum(["open", "answered", "cancelled"]);
export type ClarificationStatus = z.infer<typeof ClarificationStatusSchema>;

export const ClarificationRequestSchema = z.object({
  id: z.string().min(1),
  created_at: z.string().datetime(),
  status: ClarificationStatusSchema.default("open"),
  source_kind: ClarificationSourceKindSchema,
  /** Originating ingestion, when the question is about a specific raw item. */
  ingestion_id: z.string().nullable().default(null),
  /** Routing back: same iMessage thread the original message came from. */
  sender: z.string().min(1),
  thread_id: z.string().min(1),
  /** One concrete question to put in the iMessage reply. */
  question: z.string().min(1).max(1_000),
  /** Optional choice list (max 5). Empty array = free-form answer expected. */
  options: z.array(z.string().min(1).max(200)).max(5).default([]),
  /**
   * Auditable context the agent considered: attempted target, candidates seen,
   * provider rationale, etc. Schema-loose by design — this is for humans /
   * future replays, not a state machine.
   */
  context: z.record(z.string(), z.unknown()).default({}),
  answered_at: z.string().datetime().nullable().default(null),
  answer_text: z.string().nullable().default(null),
  /** When (if ever) the question was actually sent over the outbound channel. */
  notified_at: z.string().datetime().nullable().default(null),
});
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;

// --- Note frontmatter (what we write into Markdown) ----------------------

export const NoteFrontmatterSchema = z.object({
  source: SourceSchema,
  sender: z.string(),
  thread_id: z.string(),
  received_at: z.string().datetime(),
  status: IngestStatusSchema,
  tags: z.array(z.string()).default([]),
  agent_confidence: z.number().min(0).max(1).nullable().default(null),
  original_text_hash: z.string(),
  ingestion_id: z.string(),
});
export type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;

// --- Adapter interface ---------------------------------------------------

export interface IngestionAdapter {
  /** Stable id, e.g. "shortcuts", "bluebubbles". */
  readonly name: string;
  /** Cheap detector based on headers/body to decide which adapter to use. */
  matches(headers: Record<string, string | string[] | undefined>, body: unknown): boolean;
  /** Normalize provider-specific body into the canonical IngestPayload. */
  normalize(body: unknown): IngestPayload;
}

// --- Agent action log entry ----------------------------------------------

export const AgentActionSchema = z.object({
  ts: z.string().datetime(),
  agent: z.string(),
  tool: z.enum([
    "read_note",
    "append_to_note",
    "create_note",
    "propose_patch",
    "search_vault",
    "list_recent_ingestions",
    "mark_ingestion_status",
    "stage_clarification",
  ]),
  args: z.record(z.unknown()),
  dry_run: z.boolean().default(false),
  ok: z.boolean(),
  error: z.string().optional(),
  result_summary: z.string().optional(),
});
export type AgentAction = z.infer<typeof AgentActionSchema>;
