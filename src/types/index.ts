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

export const IngestStatusSchema = z.enum(["raw", "triaged", "filed", "linked"]);
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
  ]),
  args: z.record(z.unknown()),
  dry_run: z.boolean().default(false),
  ok: z.boolean(),
  error: z.string().optional(),
  result_summary: z.string().optional(),
});
export type AgentAction = z.infer<typeof AgentActionSchema>;
