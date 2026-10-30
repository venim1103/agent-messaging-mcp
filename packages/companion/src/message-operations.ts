import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod/v4";
import { MAX_RETURNED_EVENTS } from "./observation-buffer.js";
import { isDatabagOrigin, isGeminiTarget, targetProvider, MAX_FIXTURE_SNAPSHOT_MESSAGES, MAX_GEMINI_SNAPSHOT_MESSAGES, PendingConnectionRequests, type ApprovedTarget, type FixtureTarget, type GeminiTarget, type StableDomTarget,
  type FixtureSnapshot, type GeminiSnapshot } from "./pending-connections.js";

export const PREPARED_MESSAGE_TTL_MS = 3 * 60_000;
export const FIXTURE_REVIEW_APPROVAL_TTL_MS = 2 * 60_000;
export const FIXTURE_SEND_APPROVAL_TTL_MS = 2 * 60_000;
export const PREPARED_KEY_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_PREPARED_MESSAGE_BYTES = 4_000;
export const MAX_ACTIVE_PREPARED_MESSAGES = 100;
export const MAX_RECORDED_PREPARED_MESSAGES = 10_000;
export const MAX_PREPARED_REVIEWS = 8;
export const FIXTURE_PREFLIGHT_TIMEOUT_MS = 4_000;
export const MAX_PENDING_FIXTURE_PREFLIGHTS = 16;
export const FIXTURE_FILL_TIMEOUT_MS = 4_000;
export const MAX_PENDING_FIXTURE_FILLS = 1;
export const FIXTURE_DISPATCH_CHECK_TIMEOUT_MS = 4_000;
export const MAX_PENDING_FIXTURE_DISPATCH_CHECKS = 16;
export const MAX_PENDING_FIXTURE_DISPATCHES = 1;
export const CHAT_SETTLE_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_SENDS_PER_HOUR = 60;
const SEND_RATE_WINDOW_MS = 60 * 60_000;
export const autonomousFailureStageSchema = z.enum(["composer", "fill", "read", "proof", "dispatch"]);
export const autonomousFailureReasonSchema = z.enum(["unconfirmed_send"]);
export class AutonomousCommitFailure extends Error {
  constructor(message: string, readonly failureStage: z.infer<typeof autonomousFailureStageSchema>,
    readonly failureReason?: z.infer<typeof autonomousFailureReasonSchema>) {
    super(message);
  }
}
export const fixtureDispatchResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), editor: z.enum(["textarea", "rich"]), activated: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["TARGET_CHANGED", "COMPOSER_UNAVAILABLE",
    "DRAFT_CHANGED", "SUBMIT_UNAVAILABLE", "DISPATCH_UNAVAILABLE", "DISPATCH_UNCERTAIN"]) })
]);
export type FixtureDispatchResult = z.infer<typeof fixtureDispatchResultSchema>;
export const resolvedDispatchStatusSchema = z.strictObject({ operationId: z.uuid(), state: z.literal("resolved"),
  startedAt: z.number().int().safe(), resolution: z.strictObject({ outcome: z.enum(["sent", "not_sent"]),
    source: z.enum(["page", "person"]), resolvedAt: z.number().int().safe() }) });
export const fixtureDispatchStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({ operationId: z.uuid(), state: z.literal("dispatch_uncertain"), startedAt: z.number().int().safe() }),
  z.strictObject({ operationId: z.uuid(), state: z.literal("observed_in_ui"), startedAt: z.number().int().safe(),
    observedAt: z.number().int().safe(), messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
  resolvedDispatchStatusSchema
]);
export const fixtureDispatchCheckResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), editor: z.enum(["textarea", "rich"]),
    draftText: z.string().max(2048), selected: z.literal(true), writable: z.literal(true),
    submitReady: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["TARGET_CHANGED", "COMPOSER_UNAVAILABLE",
    "DRAFT_CHANGED", "SUBMIT_UNAVAILABLE"]) })
]);
export type FixtureDispatchCheckResult = z.infer<typeof fixtureDispatchCheckResultSchema>;
export const geminiDispatchCheckResultSchema = z.discriminatedUnion("ok", [
  fixtureDispatchCheckResultSchema.options[0].extend({ editor: z.literal("contenteditable"),
    draftText: z.string().min(1).max(2048).refine(text => Buffer.byteLength(text, "utf8") <= MAX_PREPARED_MESSAGE_BYTES
      && text.trim() === text && !text.includes("\r")) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["TARGET_CHANGED", "UNSUPPORTED_MESSAGE_TEXT",
    "COMPOSER_UNAVAILABLE", "DRAFT_CHANGED", "SUBMIT_UNAVAILABLE"]) })
]);
export type GeminiDispatchCheckResult = z.infer<typeof geminiDispatchCheckResultSchema>;
export const geminiDispatchResultSchema = z.discriminatedUnion("ok", [
  fixtureDispatchResultSchema.options[0].extend({ editor: z.literal("contenteditable") }),
  fixtureDispatchResultSchema.options[1]
]);
export type GeminiDispatchResult = z.infer<typeof geminiDispatchResultSchema>;
export const databagTargetSchema = z.strictObject({ provider: z.literal("databag"),
  origin: z.custom<`https://${string}`>(isDatabagOrigin), conversationId: z.string().regex(/^databag_[a-f0-9]{64}$/),
  url: z.string().min(1).max(512), tabId: z.number().int().safe().positive(),
  documentId: z.string().regex(/^[!-~]{1,128}$/)
}).refine(target => target.url === `${target.origin}/#/session`);
export const chatTargetSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("fixture"), origin: z.literal("http://127.0.0.1:8787"),
    conversationId: z.literal("fixture-alpha"), tabId: z.number().int().safe().positive(),
    documentId: z.string().regex(/^[!-~]{1,128}$/) }),
  z.strictObject({ provider: z.literal("gemini"), origin: z.literal("https://gemini.google.com"),
    conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), url: z.string().min(1).max(512),
    tabId: z.number().int().safe().positive(), documentId: z.string().regex(/^[!-~]{1,128}$/) }),
  databagTargetSchema
]);
export type ChatTarget = z.infer<typeof chatTargetSchema>;
export const chatSubmitResultSchema = z.union([fixtureDispatchResultSchema, geminiDispatchResultSchema]);
export const chatJobSchema = z.strictObject({ operationId: z.uuid(), jobId: z.uuid(), phase: z.enum(["fill", "proof", "submit", "settle"]),
  target: chatTargetSchema, text: z.string().min(1).max(MAX_PREPARED_MESSAGE_BYTES)
    .refine(text => Buffer.byteLength(text, "utf8") <= MAX_PREPARED_MESSAGE_BYTES), expiresAt: z.number().int().safe(),
  leftover: z.strictObject({ operationId: z.uuid(), text: z.string().min(1).max(2048)
    .refine(text => Buffer.byteLength(text, "utf8") <= MAX_PREPARED_MESSAGE_BYTES && text.trim() === text && !text.includes("\r")) }).optional() })
  .refine(job => (!job.leftover || (job.phase === "fill" && job.leftover.operationId !== job.operationId))
    && (job.phase !== "submit" || job.jobId === job.operationId) && (job.target.provider === "fixture"
    || (job.text.length <= 2048 && job.text.trim() === job.text && !job.text.includes("\r"))));
export type ChatJob = z.infer<typeof chatJobSchema>;
export const chatSubmitJobSchema = chatJobSchema.safeExtend({ phase: z.literal("submit") });
export type ChatSubmitJob = z.infer<typeof chatSubmitJobSchema>;
export const fixturePreflightResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), editor: z.enum(["textarea", "rich"]) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["TARGET_CHANGED", "UNSUPPORTED_MESSAGE_TEXT",
    "COMPOSER_UNAVAILABLE", "DRAFT_PRESENT", "SUBMIT_UNAVAILABLE"]) })
]);
export type FixturePreflightResult = z.infer<typeof fixturePreflightResultSchema>;
export const fixturePreflightStatusSchema = z.discriminatedUnion("ok", [
  fixturePreflightResultSchema.options[0].extend({ operationId: z.uuid(), checkedAt: z.number().int().safe() }),
  fixturePreflightResultSchema.options[1].extend({ operationId: z.uuid(), checkedAt: z.number().int().safe() })
]);
export const fixtureFillResultSchema = z.discriminatedUnion("ok", [
  fixturePreflightResultSchema.options[0],
  z.strictObject({ ok: z.literal(false), code: z.enum(["TARGET_CHANGED", "UNSUPPORTED_MESSAGE_TEXT",
    "COMPOSER_UNAVAILABLE", "DRAFT_PRESENT", "SUBMIT_UNAVAILABLE", "FILL_UNAVAILABLE", "FILL_UNCERTAIN"]) })
]);
export type FixtureFillResult = z.infer<typeof fixtureFillResultSchema>;
export const geminiFillResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), editor: z.literal("contenteditable") }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["TARGET_CHANGED", "UNSUPPORTED_MESSAGE_TEXT",
    "COMPOSER_UNAVAILABLE", "DRAFT_PRESENT", "FILL_UNAVAILABLE", "FILL_UNCERTAIN"]) })
]);
export type GeminiFillResult = z.infer<typeof geminiFillResultSchema>;
const chatCompletionIdentity = { target: chatTargetSchema, operationId: z.uuid(), jobId: z.uuid() };
export const chatJobCompletionSchema = z.discriminatedUnion("phase", [
  z.strictObject({ ...chatCompletionIdentity, phase: z.literal("fill"), observation: z.union([fixtureFillResultSchema, geminiFillResultSchema]) }),
  z.strictObject({ ...chatCompletionIdentity, phase: z.literal("proof"),
    observation: z.union([fixtureDispatchCheckResultSchema, geminiDispatchCheckResultSchema]) }),
  z.strictObject({ ...chatCompletionIdentity, phase: z.literal("settle"),
    observation: z.union([fixtureDispatchCheckResultSchema, geminiDispatchCheckResultSchema]) }),
  z.strictObject({ ...chatCompletionIdentity, phase: z.literal("submit"), observation: chatSubmitResultSchema })
]).refine(payload => (payload.phase !== "submit" || payload.operationId === payload.jobId)
  && (!payload.observation.ok || (payload.target.provider === "gemini"
    ? payload.observation.editor === "contenteditable" : payload.target.provider === "databag"
      ? payload.observation.editor === "textarea" : payload.observation.editor !== "contenteditable")));
export type ChatJobObservation = z.infer<typeof chatJobCompletionSchema>["observation"];
export const geminiFillStatusSchema = z.discriminatedUnion("ok", [
  geminiFillResultSchema.options[0].extend({ operationId: z.uuid(), completedAt: z.number().int().safe() }),
  geminiFillResultSchema.options[1].extend({ operationId: z.uuid(), completedAt: z.number().int().safe() })
]);
export const fixtureFillStatusSchema = z.discriminatedUnion("ok", [
  fixtureFillResultSchema.options[0].extend({ operationId: z.uuid(), completedAt: z.number().int().safe() }),
  fixtureFillResultSchema.options[1].extend({ operationId: z.uuid(), completedAt: z.number().int().safe() })
]);
export const fixtureDraftFillStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("fill_approved"), expiresAt: z.number().int().safe() }),
  z.strictObject({ state: z.literal("filling"), startedAt: z.number().int().safe(), expiresAt: z.number().int().safe() }),
  z.strictObject({ state: z.literal("filled"), completedAt: z.number().int().safe(), editor: z.enum(["textarea", "rich", "contenteditable"]) }),
  z.strictObject({ state: z.literal("failed"), completedAt: z.number().int().safe(), code: z.enum(["TARGET_CHANGED",
    "UNSUPPORTED_MESSAGE_TEXT", "COMPOSER_UNAVAILABLE", "DRAFT_PRESENT", "SUBMIT_UNAVAILABLE", "FILL_UNAVAILABLE"]) }),
  z.strictObject({ state: z.literal("uncertain"), completedAt: z.number().int().safe() })
]);
const fixtureObservationSchema = z.strictObject({
  kind: z.literal("fixture_snapshot"),
  omittedBefore: z.boolean(),
  messages: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    direction: z.enum(["incoming", "outgoing"]), text: z.string().max(16_000), truncated: z.literal(true).optional()
  })).max(MAX_FIXTURE_SNAPSHOT_MESSAGES)
});
const geminiObservationSchema = z.strictObject({
  kind: z.literal("gemini_snapshot"), omittedBefore: z.boolean(),
  messages: z.array(z.strictObject({ direction: z.enum(["incoming", "outgoing"]), text: z.string().max(16_000),
    truncated: z.literal(true).optional(), identityQuality: z.literal("uncertain"), generationState: z.enum(["unknown", "streaming", "complete"])
  }).refine(message => message.direction === "incoming" || message.generationState === "unknown")).max(MAX_FIXTURE_SNAPSHOT_MESSAGES)
});

export function openPrivateOperationDatabase(directory: string): DatabaseSync {
  const owner = process.getuid?.();
  const parent = lstatSync(directory);
  if (owner === undefined || !parent.isDirectory() || parent.uid !== owner || (parent.mode & 0o077) !== 0) {
    throw new Error("Operation directory must be owned by this user and private");
  }
  const filePath = join(directory, "operations.sqlite");
  try {
    const descriptor = openSync(filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(descriptor);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const file = lstatSync(filePath);
  if (!file.isFile() || file.uid !== owner || (file.mode & 0o077) !== 0) {
    throw new Error("Operation database must be owned by this user and private");
  }
  return new DatabaseSync(filePath);
}

type PreparedMessage<TargetLabel extends "fixture-alpha" | "gemini" | "databag" = "fixture-alpha"> = Readonly<{
  operationId: string;
  connectionId: string;
  state: "awaiting_approval";
  expiresAt: number;
  preview: Readonly<{ target: TargetLabel; text: string }>;
}>;
type PreparedReview<TargetLabel extends "fixture-alpha" | "gemini" = "fixture-alpha"> = Readonly<Pick<PreparedMessage<TargetLabel>, "operationId" | "expiresAt" | "preview"> & {
  reviewId: string
}>;
type FixtureDispatchBaseline = Readonly<{
  capturedAt: number;
  cursor: Readonly<{ epoch: string; sequence: number }>;
  messageIds: ReadonlyArray<string>;
  messages: FixtureSnapshot["messages"];
  omittedBefore: boolean;
}>;
type FixtureDispatchCheck = Readonly<{
  checkId: string; owner: symbol; target: StableDomTarget; text: string; createdAt: number; expiresAt: number;
  baseline: FixtureDispatchBaseline; checkedAt: number | null
}>;
type FixtureDispatchAuthorization = Readonly<{
  owner: symbol; operationId: string; target: StableDomTarget; text: string; startedAt: number; expiresAt: number
}>;
type GeminiDispatchCheck = Readonly<{
  checkId: string; owner: symbol; target: GeminiTarget; text: string; createdAt: number; expiresAt: number;
  baseline: GeminiSnapshot; checkedAt: number | null; issued: boolean
}>;
type FixtureDispatchStatus = Readonly<z.infer<typeof fixtureDispatchStatusSchema>>;
type FixturePreflightStatus = z.infer<typeof fixturePreflightStatusSchema>;
type PendingFixturePreflight = {
  owner: symbol; operationId: string; target: StableDomTarget; text: string; expiresAt: number;
  timer: ReturnType<typeof setTimeout>; resolve: (status: FixturePreflightStatus | null) => void
};
type FixtureFillStatus = z.infer<typeof fixtureFillStatusSchema>;
type FixtureDraftFillState = z.infer<typeof fixtureDraftFillStateSchema>;
type PendingFixtureFill = {
  owner: symbol; operationId: string; target: StableDomTarget; text: string; expiresAt: number;
  timer: ReturnType<typeof setTimeout>; resolve: (status: FixtureFillStatus | null) => void
};
type GeminiFillStatus = z.infer<typeof geminiFillStatusSchema>;
type PendingGeminiFill = {
  owner: symbol; operationId: string; target: GeminiTarget; text: string; expiresAt: number; issued: boolean;
  timer: ReturnType<typeof setTimeout>; resolve: (status: GeminiFillStatus | null) => void
};
type PendingFixtureDispatch = {
  owner: symbol; operationId: string; target: StableDomTarget; text: string; expiresAt: number; startedAt: number;
  issued: boolean; timer: ReturnType<typeof setTimeout>; resolve: (status: FixtureDispatchStatus) => void
};
type GeminiDispatchStatus = FixtureDispatchStatus;
type PendingGeminiDispatch = {
  owner: symbol; operationId: string; target: GeminiTarget; text: string; expiresAt: number; startedAt: number;
  baseline: GeminiSnapshot; issued: boolean; timer: ReturnType<typeof setTimeout>; resolve: (status: GeminiDispatchStatus) => void
};
type PendingComposerWait = {
  owner: symbol; target: ApprovedTarget; expiresAt: number; result: Promise<boolean>;
  timer: ReturnType<typeof setTimeout> | null; resolve: (ready: boolean) => void
};

export class PreparedMessageOperations {
  private readonly owners = new Map<symbol, string>();
  private readonly composerReservations = new Map<string, Readonly<{ owner: symbol; target: ApprovedTarget; expiresAt: number }>>();
  private readonly composerWaits = new Map<string, PendingComposerWait>();
  private readonly neutralJobOffers = new Map<string, Set<string>>();
  private readonly autonomousCommits = new Map<string, Readonly<{ owner: symbol; result: Promise<FixtureDispatchStatus> }>>();
  private readonly settlementChecks = new Map<string, {
    owner: symbol; job: Readonly<ChatJob>; createdAt: number; issued: boolean; completedAt: number | null; ready: boolean
  }>();
  private readonly contents = new Map<string, Readonly<{
    owner: symbol; connectionId: string; target: StableDomTarget; text: string; expiresAt: number; autonomous?: true
  }>>();
  private readonly geminiContents = new Map<string, Readonly<{
    owner: symbol; connectionId: string; target: GeminiTarget; text: string; expiresAt: number; autonomous?: true
  }>>();
  private readonly reviewTokens = new Map<string, string>();
  private readonly approvals = new Map<string, Readonly<{ approvedAt: number; expiresAt: number }>>();
  private readonly fillReviewTokens = new Map<string, Readonly<{ reviewId: string; expiresAt: number }>>();
  private readonly fillApprovals = new Map<string, Readonly<{ approvedAt: number; expiresAt: number }>>();
  private readonly consumedFillApprovals = new Set<string>();
  private readonly fillStates = new Map<string, Readonly<FixtureDraftFillState>>();
  private readonly sendReviewTokens = new Map<string, Readonly<{ reviewId: string; expiresAt: number }>>();
  private readonly sendApprovals = new Map<string, Readonly<{ approvedAt: number; expiresAt: number }>>();
  private readonly recoveryReceipts = new Map<string, string>();
  private readonly dispatchBaselines = new Map<string, FixtureDispatchBaseline>();
  private readonly geminiDispatchBaselines = new Map<string, GeminiSnapshot>();
  private readonly dispatchChecks = new Map<string, FixtureDispatchCheck>();
  private readonly geminiDispatchChecks = new Map<string, GeminiDispatchCheck>();
  private readonly dispatchInspections = new Map<string, {
    timer: ReturnType<typeof setTimeout>; resolve: (ready: boolean) => void
  }>();
  private readonly dispatchAuthorizations = new Map<string, FixtureDispatchAuthorization>();
  private readonly dispatchJobs = new Map<string, PendingFixtureDispatch>();
  private readonly geminiDispatchJobs = new Map<string, PendingGeminiDispatch>();
  private readonly ambiguousEvidence = new Set<string>();
  private readonly preflightChecks = new Map<string, PendingFixturePreflight>();
  private readonly fillChecks = new Map<string, PendingFixtureFill>();
  private readonly geminiFillChecks = new Map<string, PendingGeminiFill>();
  private readonly digestKey = randomBytes(32);
  private readonly conversationDigestKey: Uint8Array;

  constructor(private readonly requests: PendingConnectionRequests, private readonly database: DatabaseSync,
    private readonly maxSendsPerHour = Number(process.env.BROWSER_CHAT_MAX_SENDS_PER_HOUR ?? DEFAULT_MAX_SENDS_PER_HOUR)) {
    if (!Number.isSafeInteger(maxSendsPerHour) || maxSendsPerHour < 1) throw new Error("INVALID_SEND_RATE_LIMIT");
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
    database.exec(`CREATE TABLE IF NOT EXISTS message_conversation_key (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      key BLOB NOT NULL CHECK (length(key) = 32)
    )`);
    let key = database.prepare("SELECT key FROM message_conversation_key WHERE singleton = 1").get();
    if (!key) {
      if (database.prepare("PRAGMA table_info(message_dispatch_attempts)").all()
        .some(column => column.name === "conversation_key")
        && database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE conversation_key IS NOT NULL LIMIT 1").get()) {
        throw new Error("DISPATCH_UNAVAILABLE");
      }
      database.prepare("INSERT OR IGNORE INTO message_conversation_key (singleton, key) VALUES (1, ?)")
        .run(randomBytes(32));
      key = database.prepare("SELECT key FROM message_conversation_key WHERE singleton = 1").get();
    }
    if (!(key?.key instanceof Uint8Array) || key.key.length !== 32) throw new Error("DISPATCH_UNAVAILABLE");
    this.conversationDigestKey = Buffer.from(key.key);
    database.exec(`CREATE TABLE IF NOT EXISTS prepared_message_operations (
      operation_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      target_digest TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state = 'awaiting_approval'),
      UNIQUE (idempotency_key)
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS message_operation_recovery (
      operation_id TEXT PRIMARY KEY REFERENCES prepared_message_operations(operation_id) ON DELETE CASCADE,
      token_digest TEXT NOT NULL CHECK (length(token_digest) = 64)
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS message_dispatch_attempts (
      operation_id TEXT PRIMARY KEY REFERENCES prepared_message_operations(operation_id) ON DELETE RESTRICT,
      started_at INTEGER NOT NULL,
      conversation_key TEXT CHECK (length(conversation_key) = 64),
      state TEXT NOT NULL CHECK (state IN ('dispatching', 'unknown'))
    )`);
    if (!database.prepare("PRAGMA table_info(message_dispatch_attempts)").all()
      .some(column => column.name === "conversation_key")) {
      database.exec("ALTER TABLE message_dispatch_attempts ADD COLUMN conversation_key TEXT CHECK (length(conversation_key) = 64)");
    }
    database.exec(`CREATE INDEX IF NOT EXISTS message_dispatch_conversation_started
      ON message_dispatch_attempts (conversation_key, started_at)`);
    database.exec(`CREATE TABLE IF NOT EXISTS message_dispatch_evidence (
      operation_id TEXT PRIMARY KEY REFERENCES message_dispatch_attempts(operation_id) ON DELETE RESTRICT,
      observed_at INTEGER NOT NULL,
      message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 128)
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS message_dispatch_resolutions (
      operation_id TEXT PRIMARY KEY REFERENCES message_dispatch_attempts(operation_id) ON DELETE RESTRICT,
      resolved_at INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'not_sent')),
      source TEXT NOT NULL CHECK (source IN ('page', 'person'))
    )`);
    database.exec("UPDATE message_dispatch_attempts SET state = 'unknown' WHERE state = 'dispatching'");
  }

  private dispatchStatus(operationId: string): FixtureDispatchStatus | null {
    const record = this.database.prepare(`SELECT attempt.started_at, evidence.observed_at, evidence.message_id,
      resolution.resolved_at, resolution.outcome, resolution.source
      FROM message_dispatch_attempts AS attempt
      LEFT JOIN message_dispatch_evidence AS evidence ON evidence.operation_id = attempt.operation_id
      LEFT JOIN message_dispatch_resolutions AS resolution ON resolution.operation_id = attempt.operation_id
      WHERE attempt.operation_id = ?`).get(operationId) as {
        started_at: number; observed_at: number | null; message_id: string | null;
        resolved_at: number | null; outcome: "sent" | "not_sent" | null; source: "page" | "person" | null
      } | undefined;
    if (!record) return null;
    if (record.observed_at !== null && record.message_id !== null) {
      return { operationId, state: "observed_in_ui", startedAt: record.started_at,
        observedAt: record.observed_at, messageId: record.message_id };
    }
    if (record.resolved_at !== null && record.outcome !== null && record.source !== null) {
      return Object.freeze({ operationId, state: "resolved", startedAt: record.started_at,
        resolution: Object.freeze({ outcome: record.outcome, source: record.source, resolvedAt: record.resolved_at }) });
    }
    return { operationId, state: "dispatch_uncertain", startedAt: record.started_at };
  }

  private digest(value: string): string {
    return createHmac("sha256", this.digestKey).update(value).digest("hex");
  }

  private conversationKey(target: Pick<ApprovedTarget, "origin" | "conversationId">): string {
    return createHmac("sha256", this.conversationDigestKey)
      .update(JSON.stringify([target.origin, target.conversationId])).digest("hex");
  }

  private hasUnresolvedDispatch(target: Pick<ApprovedTarget, "origin" | "conversationId">): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM message_dispatch_attempts AS attempt
      LEFT JOIN message_dispatch_evidence AS evidence ON evidence.operation_id = attempt.operation_id
      LEFT JOIN message_dispatch_resolutions AS resolution ON resolution.operation_id = attempt.operation_id
      WHERE evidence.operation_id IS NULL AND resolution.operation_id IS NULL
      AND (attempt.conversation_key IS NULL OR attempt.conversation_key = ?) LIMIT 1`)
      .get(this.conversationKey(target)));
  }

  private isSendRateLimited(target: Pick<ApprovedTarget, "origin" | "conversationId">, now: number): boolean {
    const count = this.database.prepare(`SELECT count(*) AS count FROM message_dispatch_attempts
      WHERE conversation_key = ? AND started_at > ?`)
      .get(this.conversationKey(target), now - SEND_RATE_WINDOW_MS)?.count;
    return typeof count !== "number" || count >= this.maxSendsPerHour;
  }

  listUnconfirmedDispatches(target: ApprovedTarget, now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("DISPATCH_RESOLUTION_UNAVAILABLE");
    const rows = this.database.prepare(`SELECT attempt.operation_id, attempt.started_at
      FROM message_dispatch_attempts AS attempt
      LEFT JOIN message_dispatch_evidence AS evidence ON evidence.operation_id = attempt.operation_id
      LEFT JOIN message_dispatch_resolutions AS resolution ON resolution.operation_id = attempt.operation_id
      WHERE attempt.conversation_key = ? AND attempt.started_at >= 0 AND attempt.started_at <= ?
      AND evidence.operation_id IS NULL AND resolution.operation_id IS NULL
      ORDER BY attempt.started_at, attempt.operation_id LIMIT ?`)
      .all(this.conversationKey(target), now - FIXTURE_DISPATCH_CHECK_TIMEOUT_MS, MAX_PREPARED_REVIEWS + 1);
    const attempts = rows.slice(0, MAX_PREPARED_REVIEWS).map(row => {
      if (typeof row.operation_id !== "string" || !z.uuid().safeParse(row.operation_id).success
        || typeof row.started_at !== "number" || !Number.isSafeInteger(row.started_at)) {
        throw new Error("DISPATCH_RESOLUTION_UNAVAILABLE");
      }
      return Object.freeze({ operationId: row.operation_id, startedAt: row.started_at });
    });
    return Object.freeze({ attempts: Object.freeze(attempts), hasMore: rows.length > MAX_PREPARED_REVIEWS });
  }

  resolveUnconfirmedDispatch(target: ApprovedTarget, operationId: string, outcome: "sent" | "not_sent", now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0 || (outcome !== "sent" && outcome !== "not_sent")) {
      throw new Error("DISPATCH_RESOLUTION_UNAVAILABLE");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const record = this.database.prepare(`SELECT attempt.started_at, evidence.operation_id AS evidence_id,
        resolution.outcome AS outcome FROM message_dispatch_attempts AS attempt
        LEFT JOIN message_dispatch_evidence AS evidence ON evidence.operation_id = attempt.operation_id
        LEFT JOIN message_dispatch_resolutions AS resolution ON resolution.operation_id = attempt.operation_id
        WHERE attempt.operation_id = ? AND attempt.conversation_key = ?`)
        .get(operationId, this.conversationKey(target));
      if (!record || typeof record.started_at !== "number" || !Number.isSafeInteger(record.started_at)
        || record.started_at < 0 || now - record.started_at < FIXTURE_DISPATCH_CHECK_TIMEOUT_MS
        || record.evidence_id !== null || (record.outcome !== null && record.outcome !== outcome)) {
        throw new Error("DISPATCH_RESOLUTION_UNAVAILABLE");
      }
      this.database.prepare(`INSERT INTO message_dispatch_resolutions (operation_id, resolved_at, outcome, source)
        VALUES (?, ?, ?, 'person') ON CONFLICT (operation_id) DO NOTHING`).run(operationId, now, outcome);
      this.database.prepare("UPDATE message_dispatch_attempts SET state = 'unknown' WHERE operation_id = ?").run(operationId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.dispatchAuthorizations.delete(operationId);
    return this.dispatchStatus(operationId)!;
  }

  private release(operationId: string): void {
    this.finishFixtureDispatch(operationId);
    this.finishGeminiDispatch(operationId);
    for (const [challengeId, pending] of this.preflightChecks) {
      if (pending.operationId === operationId) this.finishPreflightCheck(challengeId, null);
    }
    for (const [attemptId, pending] of this.fillChecks) {
      if (pending.operationId === operationId) this.finishFillCheck(attemptId, null);
    }
    for (const [attemptId, pending] of this.geminiFillChecks) {
      if (pending.operationId === operationId) this.finishGeminiFillCheck(attemptId, null);
    }
    this.contents.delete(operationId);
    this.geminiContents.delete(operationId);
    this.reviewTokens.delete(operationId);
    this.approvals.delete(operationId);
    this.fillReviewTokens.delete(operationId);
    this.fillApprovals.delete(operationId);
    this.consumedFillApprovals.delete(operationId);
    this.fillStates.delete(operationId);
    this.sendReviewTokens.delete(operationId);
    this.sendApprovals.delete(operationId);
    this.recoveryReceipts.delete(operationId);
    this.dispatchBaselines.delete(operationId);
    this.geminiDispatchBaselines.delete(operationId);
    this.discardFixtureDispatchCheck(operationId);
    this.discardGeminiDispatchCheck(operationId);
    this.dispatchAuthorizations.delete(operationId);
    this.ambiguousEvidence.delete(operationId);
    this.neutralJobOffers.delete(operationId);
    this.autonomousCommits.delete(operationId);
    this.settlementChecks.delete(operationId);
    this.composerReservations.delete(operationId);
    this.finishComposerWait(operationId, false);
    for (const waitingId of this.composerWaits.keys()) this.checkComposerWait(waitingId);
  }

  private discardExpired(now: number): void {
    for (const [operationId, pending] of this.dispatchJobs) {
      if (pending.expiresAt <= now) this.finishFixtureDispatch(operationId);
    }
    for (const [operationId, pending] of this.geminiDispatchJobs) {
      if (pending.expiresAt <= now) this.finishGeminiDispatch(operationId);
    }
    for (const [operationId, operation] of this.contents) {
      if (operation.expiresAt <= now) this.release(operationId);
    }
    for (const [operationId, operation] of this.geminiContents) {
      if (operation.expiresAt <= now) this.release(operationId);
    }
    for (const [operationId, approval] of this.approvals) {
      if (approval.expiresAt <= now) this.approvals.delete(operationId);
    }
    for (const [operationId, approval] of this.fillApprovals) {
      if (approval.expiresAt <= now) this.fillApprovals.delete(operationId);
    }
    for (const [operationId, approval] of this.sendApprovals) {
      if (approval.expiresAt <= now) this.sendApprovals.delete(operationId);
    }
    for (const [operationId, check] of this.dispatchChecks) {
      if (check.expiresAt <= now) this.discardFixtureDispatchCheck(operationId);
    }
    for (const [operationId, check] of this.geminiDispatchChecks) {
      if (check.expiresAt <= now) this.discardGeminiDispatchCheck(operationId);
    }
    for (const [operationId, authorization] of this.dispatchAuthorizations) {
      if (authorization.expiresAt <= now) this.dispatchAuthorizations.delete(operationId);
    }
    this.discardGeminiFillChecks(now);
  }

  prepare(owner: symbol, connectionId: string, expectedGeneration: number,
    text: string, idempotencyKey: string, now = Date.now()): PreparedMessage {
    this.discardExpired(now);
    const target = this.requests.getApprovedTarget(owner, connectionId, now);
    if (!target) throw new Error("CONNECTION_NOT_FOUND");
    return this.prepareBound(owner, connectionId, expectedGeneration, target, "fixture-alpha", text, idempotencyKey, now);
  }

  prepareGemini(owner: symbol, connectionId: string, expectedGeneration: number,
    text: string, idempotencyKey: string, now = Date.now()): PreparedMessage<"gemini"> {
    this.discardExpired(now);
    const target = this.requests.getGeminiTarget(owner, connectionId, now);
    if (!target) throw new Error("CONNECTION_NOT_FOUND");
    return this.prepareBound(owner, connectionId, expectedGeneration, target, "gemini", text, idempotencyKey, now);
  }

  prepareAutonomous(owner: symbol, connectionId: string, text: string, idempotencyKey: string,
    deadlineMs: number, now = Date.now()) {
    this.discardExpired(now);
    const target = this.requests.getAutonomousTarget(owner, connectionId, now);
    if (!target) throw new Error("CONNECTION_NOT_FOUND");
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now || deadlineMs > now + 30_000) {
      throw new Error("INVALID_REQUEST_DEADLINE");
    }
    const prepared = this.prepareBound(owner, connectionId, 1, target,
      target.provider === "databag" ? "databag" : isGeminiTarget(target) ? "gemini" : "fixture-alpha", text, idempotencyKey, now, deadlineMs);
    const receipt = this.createRecoveryReceiptRecord(prepared.operationId);
    return Object.freeze({ ...prepared, state: "prepared" as const, recoveryToken: receipt.recoveryToken });
  }

  getAutonomousReplay(owner: symbol, connectionId: string, text: string, idempotencyKey: string, now = Date.now()) {
    this.discardExpired(now);
    if (!this.owners.has(owner)) return null;
    const record = this.database.prepare(`SELECT operation_id, owner_id, connection_id, content_digest, target_digest
      FROM prepared_message_operations WHERE idempotency_key = ?`).get(idempotencyKey) as {
        operation_id: string; owner_id: string; connection_id: string; content_digest: string; target_digest: string
      } | undefined;
    if (!record) return null;
    if (record.owner_id !== this.owners.get(owner)) throw new Error("OPERATION_UNAVAILABLE");
    const operation = this.contents.get(record.operation_id) ?? this.geminiContents.get(record.operation_id);
    const target = operation?.autonomous && operation.owner === owner && operation.connectionId === connectionId
      ? operation.target : this.requests.getAutonomousTarget(owner, connectionId, now);
    if (!target) return null;
    if (record.connection_id !== connectionId || record.content_digest !== this.digest(text)
      || record.target_digest !== this.digest(JSON.stringify({ connectionId, expectedGeneration: 1, target, mode: "autonomous" }))) {
      throw new Error("IDEMPOTENCY_CONFLICT");
    }
    return this.dispatchStatus(record.operation_id);
  }

  getAutonomousAuthorization(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.contents.get(operationId) ?? this.geminiContents.get(operationId);
    const live = operation && this.requests.getAutonomousTarget(owner, operation.connectionId, now);
    if (!operation?.autonomous || operation.owner !== owner || !this.owners.has(owner) || !live
      || !this.sameComposerTarget(operation.target, live)) return null;
    return Object.freeze({ operationId, target: operation.target, text: operation.text, expiresAt: operation.expiresAt });
  }

  private getAutonomousPhaseAuthorization(owner: symbol, operationId: string, phase: "fill" | "send", now: number) {
    const authorization = this.getAutonomousAuthorization(owner, operationId, now);
    const reservation = this.composerReservations.get(operationId);
    const fill = this.fillStates.get(operationId);
    if (!authorization || reservation?.owner !== owner || reservation.expiresAt <= now
      || this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?").get(operationId)
      || (phase === "fill" ? this.consumedFillApprovals.has(operationId)
        : fill?.state !== "filled" || fill.completedAt > now
          || (authorization.target.origin === "https://gemini.google.com" ? fill.editor !== "contenteditable" : fill.editor === "contenteditable"))) {
      return null;
    }
    return Object.freeze({ ...authorization, expiresAt: Math.min(authorization.expiresAt, reservation.expiresAt) });
  }

  acquireComposer(owner: symbol, operationId: string, deadlineMs: number): Promise<boolean> {
    const now = Date.now();
    const authorization = this.getAutonomousAuthorization(owner, operationId, now);
    if (!authorization || !Number.isSafeInteger(deadlineMs) || deadlineMs <= now
      || (this.hasUnresolvedDispatch(authorization.target)
        && !this.hasOccupiedComposer(operationId, authorization.target, now))) return Promise.resolve(false);
    const existing = this.composerWaits.get(operationId);
    if (existing) return existing.result;
    const reservation = this.composerReservations.get(operationId);
    if (reservation) return Promise.resolve(reservation.owner === owner && reservation.expiresAt > now);
    if ([...this.composerWaits.values()].some(wait => wait.owner === owner)) return Promise.resolve(false);
    let resolve!: PendingComposerWait["resolve"];
    const result = new Promise<boolean>(done => { resolve = done; });
    this.composerWaits.set(operationId, { owner, target: authorization.target, expiresAt: Math.min(deadlineMs, authorization.expiresAt),
      timer: null, result, resolve });
    this.checkComposerWait(operationId);
    return result;
  }

  private finishComposerWait(operationId: string, ready: boolean): void {
    const pending = this.composerWaits.get(operationId);
    if (!pending) return;
    this.composerWaits.delete(operationId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(ready);
  }

  private checkComposerWait(operationId: string): void {
    const pending = this.composerWaits.get(operationId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    const now = Date.now();
    const authorization = this.getAutonomousAuthorization(pending.owner, operationId, now);
    if (this.composerWaits.get(operationId) !== pending) return;
    if (!authorization || pending.expiresAt <= now || (this.hasUnresolvedDispatch(pending.target)
      && !this.hasOccupiedComposer(operationId, pending.target, now))) {
      this.finishComposerWait(operationId, false);
      return;
    }
    const first = [...this.composerWaits].find(([, wait]) => this.sameComposerTarget(wait.target, pending.target));
    if (first?.[0] === operationId && !this.hasOccupiedComposer(operationId, pending.target, now)) {
      this.composerReservations.set(operationId, Object.freeze({ owner: pending.owner, target: pending.target, expiresAt: pending.expiresAt }));
      this.finishComposerWait(operationId, true);
      return;
    }
    pending.timer = setTimeout(() => this.checkComposerWait(operationId), Math.min(25, pending.expiresAt - now));
  }

  releaseComposer(owner: symbol, operationId: string): boolean {
    if (this.composerReservations.get(operationId)?.owner !== owner) return false;
    this.composerReservations.delete(operationId);
    for (const waitingId of this.composerWaits.keys()) this.checkComposerWait(waitingId);
    return true;
  }

  private prepareBound<TargetLabel extends "fixture-alpha" | "gemini" | "databag">(owner: symbol, connectionId: string,
    expectedGeneration: number, target: ApprovedTarget, label: TargetLabel, text: string,
    idempotencyKey: string, now: number, autonomousExpiresAt?: number): PreparedMessage<TargetLabel> {
    if (expectedGeneration !== 1) throw new Error("GENERATION_MISMATCH");
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_PREPARED_MESSAGE_BYTES || !text.trim()) {
      throw new Error("INVALID_MESSAGE_TEXT");
    }
    if (target.origin !== "http://127.0.0.1:8787"
      && (text.length > 2048 || text !== text.trim() || text.includes("\r"))) throw new Error("INVALID_MESSAGE_TEXT");
    if (typeof idempotencyKey !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
      throw new Error("INVALID_IDEMPOTENCY_KEY");
    }

    this.database.prepare(`DELETE FROM prepared_message_operations WHERE expires_at <= ?
      AND operation_id NOT IN (SELECT operation_id FROM message_dispatch_attempts)`)
      .run(now - PREPARED_KEY_RETENTION_MS);
    const ownerId = this.owners.get(owner) ?? randomUUID();
    this.owners.set(owner, ownerId);
    const contentDigest = this.digest(text);
    const targetDigest = this.digest(JSON.stringify({ connectionId, expectedGeneration, target,
      mode: autonomousExpiresAt === undefined ? undefined : "autonomous" }));
    const existing = this.database.prepare(`SELECT operation_id, owner_id, connection_id, content_digest,
      target_digest, expires_at FROM prepared_message_operations
      WHERE idempotency_key = ?`).get(idempotencyKey) as {
        operation_id: string; owner_id: string; connection_id: string; content_digest: string;
        target_digest: string; expires_at: number
      } | undefined;
    if (existing) {
      if (existing.owner_id !== ownerId) throw new Error("OPERATION_UNAVAILABLE");
      if (existing.connection_id !== connectionId || existing.content_digest !== contentDigest
        || existing.target_digest !== targetDigest) throw new Error("IDEMPOTENCY_CONFLICT");
      if (this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?")
        .get(existing.operation_id)) throw new Error("DISPATCH_UNCERTAIN");
      if (existing.expires_at <= now) throw new Error("OPERATION_EXPIRED");
      const retained = this.contents.get(existing.operation_id) ?? this.geminiContents.get(existing.operation_id);
      if (!retained || retained.owner !== owner) throw new Error("OPERATION_UNAVAILABLE");
      return Object.freeze({ operationId: existing.operation_id, connectionId, state: "awaiting_approval",
        expiresAt: existing.expires_at, preview: Object.freeze({ target: label, text: retained.text }) });
    }

    if (this.contents.size + this.geminiContents.size >= MAX_ACTIVE_PREPARED_MESSAGES) throw new Error("TOO_MANY_PREPARED");
    const recorded = this.database.prepare("SELECT count(*) AS count FROM prepared_message_operations")
      .get() as { count: number };
    if (recorded.count >= MAX_RECORDED_PREPARED_MESSAGES) throw new Error("TOO_MANY_PREPARED");
    const operationId = randomUUID();
    const expiresAt = Math.min(now + PREPARED_MESSAGE_TTL_MS, autonomousExpiresAt ?? Infinity);
    this.database.prepare(`INSERT INTO prepared_message_operations
      (operation_id, owner_id, connection_id, idempotency_key, content_digest, target_digest, expires_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval')`)
      .run(operationId, ownerId, connectionId, idempotencyKey, contentDigest, targetDigest, expiresAt);
    const mode = autonomousExpiresAt === undefined ? {} : { autonomous: true as const };
    if (isGeminiTarget(target)) {
      this.geminiContents.set(operationId, Object.freeze({ owner, connectionId, target, text, expiresAt, ...mode }));
    } else {
      this.contents.set(operationId, Object.freeze({ owner, connectionId, target, text, expiresAt, ...mode }));
    }
    return Object.freeze({ operationId, connectionId, state: "awaiting_approval", expiresAt,
      preview: Object.freeze({ target: label, text }) });
  }

  private sameGeminiTarget(left: GeminiTarget, right: GeminiTarget): boolean {
    return left.origin === right.origin && left.conversationId === right.conversationId && left.url === right.url
      && left.tabId === right.tabId && left.documentId === right.documentId;
  }

  listGeminiReviews(target: GeminiTarget, now = Date.now()): Readonly<{
    reviews: ReadonlyArray<PreparedReview<"gemini">>; hasMore: boolean
  }> {
    this.discardExpired(now);
    const reviews: Omit<PreparedReview<"gemini">, "reviewId">[] = [];
    for (const [operationId, operation] of this.geminiContents) {
      if (operation.autonomous || this.approvals.has(operationId) || this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?")
        .get(operationId) || !this.sameGeminiTarget(operation.target, target)) continue;
      this.reviewTokens.delete(operationId);
      const live = this.requests.getGeminiTarget(operation.owner, operation.connectionId, now);
      if (!live || !this.sameGeminiTarget(live, target)) {
        this.release(operationId);
        continue;
      }
      reviews.push(Object.freeze({ operationId, expiresAt: operation.expiresAt,
        preview: Object.freeze({ target: "gemini", text: operation.text }) }));
    }
    return Object.freeze({ reviews: Object.freeze(reviews.slice(-MAX_PREPARED_REVIEWS).reverse().map(review => {
      const reviewId = randomUUID();
      this.reviewTokens.set(review.operationId, reviewId);
      return Object.freeze({ ...review, reviewId });
    })), hasMore: reviews.length > MAX_PREPARED_REVIEWS });
  }

  approveGeminiReview(target: GeminiTarget, operationId: string, reviewId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.geminiContents.get(operationId);
    const live = operation && this.requests.getGeminiTarget(operation.owner, operation.connectionId, now);
    if (!operation || !live || this.approvals.has(operationId)
      || this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?").get(operationId)
      || typeof reviewId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reviewId)
      || this.reviewTokens.get(operationId) !== reviewId || !this.sameGeminiTarget(operation.target, target)
      || !this.sameGeminiTarget(live, target)) throw new Error("REVIEW_UNAVAILABLE");
    this.reviewTokens.delete(operationId);
    const approval = Object.freeze({ operationId, state: "approved" as const, approvedAt: now,
      expiresAt: Math.min(operation.expiresAt, now + FIXTURE_REVIEW_APPROVAL_TTL_MS) });
    this.approvals.set(operationId, approval);
    return approval;
  }

  listGeminiFillReviews(target: GeminiTarget, now = Date.now()) {
    this.discardExpired(now);
    const reviews: PreparedReview<"gemini">[] = [];
    for (const [operationId, operation] of this.geminiContents) {
      if (!this.sameGeminiTarget(operation.target, target)) continue;
      this.fillReviewTokens.delete(operationId);
      const live = this.requests.getGeminiTarget(operation.owner, operation.connectionId, now);
      if (!live || !this.sameGeminiTarget(live, target)) {
        this.release(operationId);
        continue;
      }
      if (this.getOperation(operation.owner, operationId, now).state !== "approved"
        || this.fillApprovals.has(operationId) || this.consumedFillApprovals.has(operationId)) continue;
      const reviewId = randomUUID();
      reviews.push(Object.freeze({ operationId, reviewId, expiresAt: this.approvals.get(operationId)!.expiresAt,
        preview: Object.freeze({ target: "gemini", text: operation.text }) }));
    }
    const selected = reviews.slice(-MAX_PREPARED_REVIEWS).reverse();
    for (const review of selected) this.fillReviewTokens.set(review.operationId,
      Object.freeze({ reviewId: review.reviewId, expiresAt: review.expiresAt }));
    return Object.freeze({ reviews: Object.freeze(selected), hasMore: reviews.length > MAX_PREPARED_REVIEWS });
  }

  approveGeminiFillReview(target: GeminiTarget, operationId: string, reviewId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.geminiContents.get(operationId);
    const live = operation && this.requests.getGeminiTarget(operation.owner, operation.connectionId, now);
    const approval = this.approvals.get(operationId);
    const fillReview = this.fillReviewTokens.get(operationId);
    if (!operation || !live || !approval || this.getOperation(operation.owner, operationId, now).state !== "approved"
      || typeof reviewId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reviewId)
      || fillReview?.reviewId !== reviewId || fillReview.expiresAt <= now || this.fillApprovals.has(operationId)
      || this.consumedFillApprovals.has(operationId) || !this.sameGeminiTarget(operation.target, target)
      || !this.sameGeminiTarget(live, target)) throw new Error("FILL_REVIEW_UNAVAILABLE");
    const consent = Object.freeze({ operationId, state: "fill_approved" as const, approvedAt: now,
      expiresAt: Math.min(operation.expiresAt, approval.expiresAt, now + FIXTURE_REVIEW_APPROVAL_TTL_MS) });
    this.fillReviewTokens.delete(operationId);
    this.fillApprovals.set(operationId, consent);
    return consent;
  }

  listGeminiSendReviews(target: GeminiTarget, now = Date.now()) {
    this.discardExpired(now);
    const reviews: PreparedReview<"gemini">[] = [];
    for (const [operationId, operation] of this.geminiContents) {
      if (!this.sameGeminiTarget(operation.target, target)) continue;
      this.sendReviewTokens.delete(operationId);
      const live = this.requests.getGeminiTarget(operation.owner, operation.connectionId, now);
      const grantExpiresAt = this.requests.getConnectionExpiresAt(operation.owner, operation.connectionId, now);
      if (!live || grantExpiresAt === null || !this.sameGeminiTarget(live, target)) {
        this.release(operationId);
        continue;
      }
      const fill = this.fillStates.get(operationId);
      if (this.getOperation(operation.owner, operationId, now).state !== "approved"
        || fill?.state !== "filled" || fill.editor !== "contenteditable" || this.sendApprovals.has(operationId)) continue;
      const approval = this.approvals.get(operationId)!;
      const reviewId = randomUUID();
      reviews.push(Object.freeze({ operationId, reviewId,
        expiresAt: Math.min(operation.expiresAt, approval.expiresAt, grantExpiresAt, now + FIXTURE_SEND_APPROVAL_TTL_MS),
        preview: Object.freeze({ target: "gemini", text: operation.text }) }));
    }
    const selected = reviews.slice(-MAX_PREPARED_REVIEWS).reverse();
    for (const review of selected) this.sendReviewTokens.set(review.operationId,
      Object.freeze({ reviewId: review.reviewId, expiresAt: review.expiresAt }));
    return Object.freeze({ reviews: Object.freeze(selected), hasMore: reviews.length > MAX_PREPARED_REVIEWS });
  }

  approveGeminiSendReview(target: GeminiTarget, operationId: string, reviewId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.geminiContents.get(operationId);
    const live = operation && this.requests.getGeminiTarget(operation.owner, operation.connectionId, now);
    const grantExpiresAt = operation && this.requests.getConnectionExpiresAt(operation.owner, operation.connectionId, now);
    const approval = this.approvals.get(operationId);
    const review = this.sendReviewTokens.get(operationId);
    const fill = this.fillStates.get(operationId);
    if (!operation || !live || grantExpiresAt == null || !approval
      || this.getOperation(operation.owner, operationId, now).state !== "approved"
      || fill?.state !== "filled" || fill.editor !== "contenteditable" || this.sendApprovals.has(operationId)
      || typeof reviewId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reviewId)
      || review?.reviewId !== reviewId || review.expiresAt <= now || !this.sameGeminiTarget(operation.target, target)
      || !this.sameGeminiTarget(live, target)) throw new Error("SEND_REVIEW_UNAVAILABLE");
    const consent = Object.freeze({ operationId, state: "send_approved" as const, approvedAt: now,
      expiresAt: Math.min(operation.expiresAt, approval.expiresAt, review.expiresAt, grantExpiresAt) });
    this.sendReviewTokens.delete(operationId);
    this.sendApprovals.set(operationId, consent);
    return consent;
  }

  getGeminiSendAuthorization(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.geminiContents.get(operationId);
    if (operation?.autonomous) {
      const authority = this.getAutonomousPhaseAuthorization(owner, operationId, "send", now);
      return authority && isGeminiTarget(authority.target) ? Object.freeze({ ...authority, target: authority.target }) : null;
    }
    const live = operation && this.requests.getGeminiTarget(owner, operation.connectionId, now);
    const grantExpiresAt = operation && this.requests.getConnectionExpiresAt(owner, operation.connectionId, now);
    const consent = this.sendApprovals.get(operationId);
    const fill = this.fillStates.get(operationId);
    if (!operation || operation.owner !== owner || !live || grantExpiresAt == null || !consent || consent.expiresAt <= now
      || !this.sameGeminiTarget(operation.target, live) || fill?.state !== "filled" || fill.editor !== "contenteditable"
      || this.getOperation(owner, operationId, now).state !== "approved") return null;
    return Object.freeze({ operationId, target: operation.target, text: operation.text,
      expiresAt: Math.min(consent.expiresAt, grantExpiresAt) });
  }

  getGeminiFillAuthorization(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.geminiContents.get(operationId);
    if (operation?.autonomous) {
      const authority = this.getAutonomousPhaseAuthorization(owner, operationId, "fill", now);
      return authority && isGeminiTarget(authority.target) ? Object.freeze({ ...authority, target: authority.target }) : null;
    }
    const live = operation && this.requests.getGeminiTarget(owner, operation.connectionId, now);
    const consent = this.fillApprovals.get(operationId);
    if (!operation || operation.owner !== owner || !live || !this.sameGeminiTarget(operation.target, live)
      || !consent || consent.expiresAt <= now || this.consumedFillApprovals.has(operationId)
      || this.getOperation(owner, operationId, now).state !== "approved") return null;
    return Object.freeze({ operationId, target: operation.target, text: operation.text, expiresAt: consent.expiresAt });
  }

  consumeGeminiFillApproval(owner: symbol, operationId: string, now = Date.now()) {
    const authorization = this.getGeminiFillAuthorization(owner, operationId, now);
    if (!authorization || this.hasUnresolvedDispatch(authorization.target)
      || this.isSendRateLimited(authorization.target, now)) return null;
    this.fillApprovals.delete(operationId);
    this.fillReviewTokens.delete(operationId);
    this.consumedFillApprovals.add(operationId);
    this.fillStates.set(operationId, Object.freeze({ state: "uncertain", completedAt: now }));
    return authorization;
  }

  private finishGeminiFillCheck(attemptId: string, status: GeminiFillStatus | null, now = Date.now()): void {
    const pending = this.geminiFillChecks.get(attemptId);
    if (!pending) return;
    this.geminiFillChecks.delete(attemptId);
    clearTimeout(pending.timer);
    const state: FixtureDraftFillState = status?.ok
      ? { state: "filled", completedAt: status.completedAt, editor: status.editor }
      : !status || status.code === "FILL_UNCERTAIN"
        ? { state: "uncertain", completedAt: status?.completedAt ?? now }
        : { state: "failed", completedAt: status.completedAt, code: status.code };
    this.fillStates.set(pending.operationId, Object.freeze(state));
    pending.resolve(status);
  }

  private discardGeminiFillChecks(now: number): void {
    if (!this.geminiFillChecks.size) return;
    for (const [attemptId, pending] of this.geminiFillChecks) {
      const operation = this.geminiContents.get(pending.operationId);
      const live = operation && this.requests.getGeminiTarget(pending.owner, operation.connectionId, now);
      const approval = this.approvals.get(pending.operationId);
      if (this.hasUnresolvedDispatch(pending.target) || this.isSendRateLimited(pending.target, now)
        || pending.expiresAt <= now || !operation || operation.owner !== pending.owner
        || (!operation.autonomous && (!approval || approval.expiresAt <= now))
        || !live || !this.sameGeminiTarget(pending.target, live)
        || (operation.autonomous && !this.requests.getAutonomousTarget(pending.owner, operation.connectionId, now))) {
        this.finishGeminiFillCheck(attemptId, null, now);
      }
    }
  }

  private sameComposerTarget(left: ApprovedTarget, right: ApprovedTarget): boolean {
    return left.origin === right.origin && left.conversationId === right.conversationId
      && left.tabId === right.tabId && left.documentId === right.documentId
      && targetProvider(left) === targetProvider(right)
      && (!("url" in left) || ("url" in right && left.url === right.url));
  }

  private hasOccupiedComposer(operationId: string, target: ApprovedTarget, now: number): boolean {
    for (const [candidateId, reservation] of this.composerReservations) {
      if (!this.getAutonomousAuthorization(reservation.owner, candidateId, now) || reservation.expiresAt <= now) {
        this.composerReservations.delete(candidateId);
        continue;
      }
      if (candidateId !== operationId && this.sameComposerTarget(reservation.target, target)) return true;
    }
    for (const [candidateId, operation] of [...this.contents, ...this.geminiContents]) {
      if (candidateId === operationId || !this.sameComposerTarget(operation.target, target)) continue;
      const fill = this.fillStates.get(candidateId);
      if (!fill || (fill.state !== "filling" && fill.state !== "filled" && fill.state !== "uncertain")) continue;
      const status = this.getOperation(operation.owner, candidateId, now);
      if (status.state === "approved" || status.state === "awaiting_approval" || status.state === "prepared") return true;
    }
    return false;
  }

  requestGeminiFill(owner: symbol, operationId: string, now = Date.now(), deadlineMs = now + FIXTURE_FILL_TIMEOUT_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) return null;
    const authorization = this.getGeminiFillAuthorization(owner, operationId, now);
    const operation = this.geminiContents.get(operationId);
    const grantExpiresAt = operation && this.requests.getConnectionExpiresAt(owner, operation.connectionId, now);
    if (!authorization || !grantExpiresAt) return null;
    this.listFixtureFillChallenges(now);
    if (this.fillChecks.size + this.geminiFillChecks.size >= MAX_PENDING_FIXTURE_FILLS
      || this.hasOccupiedComposer(operationId, authorization.target, now)) return "busy" as const;
    if (!this.consumeGeminiFillApproval(owner, operationId, now)) return null;
    const attemptId = randomUUID();
    const expiresAt = Math.min(deadlineMs, authorization.expiresAt, grantExpiresAt, now + FIXTURE_FILL_TIMEOUT_MS);
    let resolve!: PendingGeminiFill["resolve"];
    const result = new Promise<GeminiFillStatus | null>((done) => { resolve = done; });
    const timer = setTimeout(() => this.finishGeminiFillCheck(attemptId, null), expiresAt - now);
    this.geminiFillChecks.set(attemptId, { owner, operationId, target: authorization.target,
      text: authorization.text, expiresAt, issued: false, timer, resolve });
    this.fillStates.set(operationId, Object.freeze({ state: "filling", startedAt: now, expiresAt }));
    return { attemptId, result };
  }

  listGeminiFillChallenges(now = Date.now(), autonomous = false) {
    this.discardExpired(now);
    return [...this.geminiFillChecks].filter(([, pending]) => !pending.issued
      && (this.geminiContents.get(pending.operationId)?.autonomous === true) === autonomous).map(([attemptId, pending]) => {
      pending.issued = true;
      return Object.freeze({ attemptId, operationId: pending.operationId, target: pending.target,
        text: pending.text, expiresAt: pending.expiresAt });
    });
  }

  completeGeminiFill(target: GeminiTarget, attemptId: string, observation: GeminiFillResult, now = Date.now()): boolean {
    const parsed = geminiFillResultSchema.safeParse(observation);
    this.discardExpired(now);
    const pending = this.geminiFillChecks.get(attemptId);
    if (!parsed.success || !pending?.issued || !this.sameGeminiTarget(pending.target, target)) return false;
    this.finishGeminiFillCheck(attemptId, { ...parsed.data, operationId: pending.operationId, completedAt: now });
    return true;
  }

  listFixtureReviews(target: FixtureTarget, now = Date.now()): Readonly<{
    reviews: ReadonlyArray<PreparedReview>; hasMore: boolean
  }> {
    this.discardExpired(now);
    const reviews: Omit<PreparedReview, "reviewId">[] = [];
    for (const [operationId, operation] of this.contents) {
      if (operation.autonomous || this.approvals.has(operationId)) continue;
      if (this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?")
        .get(operationId)) continue;
      if (operation.target.tabId !== target.tabId || operation.target.documentId !== target.documentId
        || operation.target.origin !== target.origin || operation.target.conversationId !== target.conversationId) {
        continue;
      }
      this.reviewTokens.delete(operationId);
      const live = this.requests.getApprovedTarget(operation.owner, operation.connectionId, now);
      if (!live || live.tabId !== target.tabId || live.documentId !== target.documentId
        || live.origin !== target.origin || live.conversationId !== target.conversationId) {
        this.release(operationId);
        continue;
      }
      reviews.push(Object.freeze({ operationId, expiresAt: operation.expiresAt,
        preview: Object.freeze({ target: "fixture-alpha", text: operation.text }) }));
    }
    return Object.freeze({ reviews: Object.freeze(reviews.slice(-MAX_PREPARED_REVIEWS).reverse().map((review) => {
      const reviewId = randomUUID();
      this.reviewTokens.set(review.operationId, reviewId);
      return Object.freeze({ ...review, reviewId });
    })),
      hasMore: reviews.length > MAX_PREPARED_REVIEWS });
  }

  approveFixtureReview(target: FixtureTarget, operationId: string, reviewId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.contents.get(operationId);
    const live = operation && this.requests.getApprovedTarget(operation.owner, operation.connectionId, now);
    if (!operation || !live || this.approvals.has(operationId)
      || this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?").get(operationId)
      || typeof reviewId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reviewId)
      || this.reviewTokens.get(operationId) !== reviewId
      || operation.target.origin !== target.origin || operation.target.conversationId !== target.conversationId
      || operation.target.tabId !== target.tabId || operation.target.documentId !== target.documentId
      || live.origin !== target.origin || live.conversationId !== target.conversationId
      || live.tabId !== target.tabId || live.documentId !== target.documentId) {
      throw new Error("REVIEW_UNAVAILABLE");
    }
    this.reviewTokens.delete(operationId);
    const approval = Object.freeze({ operationId, state: "approved" as const, approvedAt: now,
      expiresAt: Math.min(operation.expiresAt, now + FIXTURE_REVIEW_APPROVAL_TTL_MS) });
    this.approvals.set(operationId, approval);
    return approval;
  }

  listFixtureFillReviews(target: FixtureTarget, now = Date.now()) {
    this.discardExpired(now);
    const reviews: PreparedReview[] = [];
    for (const [operationId, operation] of this.contents) {
      if (operation.target.origin !== target.origin || operation.target.conversationId !== target.conversationId
        || operation.target.tabId !== target.tabId || operation.target.documentId !== target.documentId) continue;
      this.fillReviewTokens.delete(operationId);
      if (this.getOperation(operation.owner, operationId, now).state !== "approved"
        || this.fillApprovals.has(operationId) || this.consumedFillApprovals.has(operationId)) continue;
      const reviewId = randomUUID();
      reviews.push(Object.freeze({ operationId, reviewId, expiresAt: this.approvals.get(operationId)!.expiresAt,
        preview: Object.freeze({ target: "fixture-alpha", text: operation.text }) }));
    }
    const selected = reviews.slice(-MAX_PREPARED_REVIEWS).reverse();
    for (const review of selected) this.fillReviewTokens.set(review.operationId,
      Object.freeze({ reviewId: review.reviewId, expiresAt: review.expiresAt }));
    return Object.freeze({ reviews: Object.freeze(selected), hasMore: reviews.length > MAX_PREPARED_REVIEWS });
  }

  approveFixtureFillReview(target: FixtureTarget, operationId: string, reviewId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.contents.get(operationId);
    const approval = this.approvals.get(operationId);
    const fillReview = this.fillReviewTokens.get(operationId);
    if (!operation || !approval || this.getOperation(operation.owner, operationId, now).state !== "approved"
      || typeof reviewId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reviewId)
      || fillReview?.reviewId !== reviewId || fillReview.expiresAt <= now || this.fillApprovals.has(operationId)
      || this.consumedFillApprovals.has(operationId)
      || operation.target.origin !== target.origin || operation.target.conversationId !== target.conversationId
      || operation.target.tabId !== target.tabId || operation.target.documentId !== target.documentId) {
      throw new Error("FILL_REVIEW_UNAVAILABLE");
    }
    const consent = Object.freeze({ operationId, state: "fill_approved" as const, approvedAt: now,
      expiresAt: Math.min(operation.expiresAt, approval.expiresAt, now + FIXTURE_REVIEW_APPROVAL_TTL_MS) });
    this.fillReviewTokens.delete(operationId);
    this.fillApprovals.set(operationId, consent);
    return consent;
  }

  getFixtureFillAuthorization(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.contents.get(operationId);
    if (operation?.autonomous) {
      const authority = this.getAutonomousPhaseAuthorization(owner, operationId, "fill", now);
      return authority && !isGeminiTarget(authority.target) ? Object.freeze({ ...authority, target: authority.target }) : null;
    }
    const consent = this.fillApprovals.get(operationId);
    if (!operation || operation.owner !== owner || !consent || consent.expiresAt <= now
      || this.consumedFillApprovals.has(operationId) || this.getOperation(owner, operationId, now).state !== "approved") {
      return null;
    }
    return Object.freeze({ operationId, target: operation.target, text: operation.text, expiresAt: consent.expiresAt });
  }

  consumeFixtureFillApproval(owner: symbol, operationId: string, now = Date.now()) {
    const authorization = this.getFixtureFillAuthorization(owner, operationId, now);
    if (!authorization || this.hasUnresolvedDispatch(authorization.target)
      || this.isSendRateLimited(authorization.target, now)) return null;
    this.fillApprovals.delete(operationId);
    this.fillReviewTokens.delete(operationId);
    this.consumedFillApprovals.add(operationId);
    this.fillStates.set(operationId, Object.freeze({ state: "uncertain", completedAt: now }));
    return authorization;
  }

  listFixtureSendReviews(target: FixtureTarget, now = Date.now()) {
    this.discardExpired(now);
    const reviews: PreparedReview[] = [];
    for (const [operationId, operation] of this.contents) {
      if (operation.target.origin !== target.origin || operation.target.conversationId !== target.conversationId
        || operation.target.tabId !== target.tabId || operation.target.documentId !== target.documentId) continue;
      this.sendReviewTokens.delete(operationId);
      if (this.getOperation(operation.owner, operationId, now).state !== "approved"
        || this.fillStates.get(operationId)?.state !== "filled" || this.sendApprovals.has(operationId)) continue;
      const approval = this.approvals.get(operationId)!;
      const reviewId = randomUUID();
      reviews.push(Object.freeze({ operationId, reviewId,
        expiresAt: Math.min(operation.expiresAt, approval.expiresAt, now + FIXTURE_SEND_APPROVAL_TTL_MS),
        preview: Object.freeze({ target: "fixture-alpha", text: operation.text }) }));
    }
    const selected = reviews.slice(-MAX_PREPARED_REVIEWS).reverse();
    for (const review of selected) this.sendReviewTokens.set(review.operationId,
      Object.freeze({ reviewId: review.reviewId, expiresAt: review.expiresAt }));
    return Object.freeze({ reviews: Object.freeze(selected), hasMore: reviews.length > MAX_PREPARED_REVIEWS });
  }

  approveFixtureSendReview(target: FixtureTarget, operationId: string, reviewId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.contents.get(operationId);
    const approval = this.approvals.get(operationId);
    const review = this.sendReviewTokens.get(operationId);
    if (!operation || !approval || this.getOperation(operation.owner, operationId, now).state !== "approved"
      || this.fillStates.get(operationId)?.state !== "filled" || this.sendApprovals.has(operationId)
      || typeof reviewId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reviewId)
      || review?.reviewId !== reviewId || review.expiresAt <= now
      || operation.target.origin !== target.origin || operation.target.conversationId !== target.conversationId
      || operation.target.tabId !== target.tabId || operation.target.documentId !== target.documentId) {
      throw new Error("SEND_REVIEW_UNAVAILABLE");
    }
    const consent = Object.freeze({ operationId, state: "send_approved" as const, approvedAt: now,
      expiresAt: Math.min(operation.expiresAt, approval.expiresAt, review.expiresAt) });
    this.sendReviewTokens.delete(operationId);
    this.sendApprovals.set(operationId, consent);
    return consent;
  }

  getFixtureSendAuthorization(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.contents.get(operationId);
    if (operation?.autonomous) {
      const authority = this.getAutonomousPhaseAuthorization(owner, operationId, "send", now);
      return authority && !isGeminiTarget(authority.target) ? Object.freeze({ ...authority, target: authority.target }) : null;
    }
    const consent = this.sendApprovals.get(operationId);
    if (!operation || operation.owner !== owner || !consent || consent.expiresAt <= now
      || this.fillStates.get(operationId)?.state !== "filled"
      || this.getOperation(owner, operationId, now).state !== "approved") return null;
    return Object.freeze({ operationId, target: operation.target, text: operation.text, expiresAt: consent.expiresAt });
  }

  createRecoveryReceipt(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.contents.get(operationId);
    const live = operation && this.requests.getApprovedTarget(owner, operation.connectionId, now);
    if (!operation || operation.owner !== owner || !live
      || live.origin !== operation.target.origin || live.conversationId !== operation.target.conversationId
      || live.tabId !== operation.target.tabId || live.documentId !== operation.target.documentId
      || this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?").get(operationId)) {
      throw new Error("OPERATION_UNAVAILABLE");
    }
    return this.createRecoveryReceiptRecord(operationId);
  }

  createGeminiRecoveryReceipt(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.geminiContents.get(operationId);
    const live = operation && this.requests.getGeminiTarget(owner, operation.connectionId, now);
    if (!operation || operation.owner !== owner || !live || !this.sameGeminiTarget(operation.target, live)
      || this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?").get(operationId)) {
      throw new Error("OPERATION_UNAVAILABLE");
    }
    return this.createRecoveryReceiptRecord(operationId);
  }

  private createRecoveryReceiptRecord(operationId: string) {
    const retained = this.recoveryReceipts.get(operationId);
    if (retained) return Object.freeze({ operationId, recoveryToken: retained });
    if (this.database.prepare("SELECT 1 FROM message_operation_recovery WHERE operation_id = ?").get(operationId)) {
      throw new Error("OPERATION_UNAVAILABLE");
    }
    const recoveryToken = randomBytes(32).toString("hex");
    const digest = createHash("sha256").update(JSON.stringify([operationId, recoveryToken])).digest("hex");
    this.database.prepare("INSERT INTO message_operation_recovery (operation_id, token_digest) VALUES (?, ?)")
      .run(operationId, digest);
    this.recoveryReceipts.set(operationId, recoveryToken);
    return Object.freeze({ operationId, recoveryToken });
  }

  recoverOperationStatus(operationId: string, recoveryToken: string) {
    if (typeof operationId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)
      || typeof recoveryToken !== "string" || !/^[0-9a-f]{64}$/.test(recoveryToken)) {
      return { state: "unknown" as const };
    }
    const record = this.database.prepare(`SELECT recovery.token_digest, attempt.started_at
      FROM message_operation_recovery AS recovery
      JOIN message_dispatch_attempts AS attempt ON attempt.operation_id = recovery.operation_id
      WHERE recovery.operation_id = ?`).get(operationId) as {
        token_digest: string; started_at: number
      } | undefined;
    if (!record || !/^[0-9a-f]{64}$/.test(record.token_digest)) return { state: "unknown" as const };
    const supplied = createHash("sha256").update(JSON.stringify([operationId, recoveryToken])).digest();
    if (!timingSafeEqual(supplied, Buffer.from(record.token_digest, "hex"))) return { state: "unknown" as const };
    return this.dispatchStatus(operationId) ?? { state: "unknown" as const };
  }

  private finishPreflightCheck(challengeId: string, status: FixturePreflightStatus | null): void {
    const pending = this.preflightChecks.get(challengeId);
    if (!pending) return;
    this.preflightChecks.delete(challengeId);
    clearTimeout(pending.timer);
    pending.resolve(status);
  }

  requestFixturePreflight(owner: symbol, operationId: string, now = Date.now()) {
    const status = this.getOperation(owner, operationId, now);
    const operation = this.contents.get(operationId);
    if (status.state !== "approved" || !operation || operation.owner !== owner) return null;
    if (this.preflightChecks.size >= MAX_PENDING_FIXTURE_PREFLIGHTS
      || [...this.preflightChecks.values()].some((pending) => pending.operationId === operationId)) return "busy" as const;
    const challengeId = randomUUID();
    const expiresAt = Math.min(status.approvalExpiresAt, now + FIXTURE_PREFLIGHT_TIMEOUT_MS);
    let resolve!: PendingFixturePreflight["resolve"];
    const result = new Promise<FixturePreflightStatus | null>((done) => { resolve = done; });
    const timer = setTimeout(() => this.finishPreflightCheck(challengeId, null), expiresAt - now);
    this.preflightChecks.set(challengeId, { owner, operationId, target: operation.target,
      text: operation.text, expiresAt, timer, resolve });
    return { challengeId, result };
  }

  listFixturePreflightChallenges(now = Date.now()) {
    for (const [challengeId, pending] of this.preflightChecks) {
      if (pending.expiresAt <= now || this.getOperation(pending.owner, pending.operationId, now).state !== "approved") {
        this.finishPreflightCheck(challengeId, null);
      }
    }
    return [...this.preflightChecks].map(([challengeId, pending]) => Object.freeze({
      challengeId, operationId: pending.operationId, target: pending.target, text: pending.text, expiresAt: pending.expiresAt
    }));
  }

  completeFixturePreflight(target: FixtureTarget, challengeId: string, observation: FixturePreflightResult,
    now = Date.now()): boolean {
    const parsed = fixturePreflightResultSchema.safeParse(observation);
    const pending = this.preflightChecks.get(challengeId);
    if (!parsed.success || !pending || pending.expiresAt <= now
      || pending.target.origin !== target.origin || pending.target.conversationId !== target.conversationId
      || pending.target.tabId !== target.tabId || pending.target.documentId !== target.documentId
      || this.getOperation(pending.owner, pending.operationId, now).state !== "approved") return false;
    this.finishPreflightCheck(challengeId, { ...parsed.data, operationId: pending.operationId, checkedAt: now });
    return true;
  }

  private finishFillCheck(attemptId: string, status: FixtureFillStatus | null, now = Date.now()): void {
    const pending = this.fillChecks.get(attemptId);
    if (!pending) return;
    this.fillChecks.delete(attemptId);
    clearTimeout(pending.timer);
    const state: FixtureDraftFillState = status?.ok
      ? { state: "filled", completedAt: status.completedAt, editor: status.editor }
      : !status || status.code === "FILL_UNCERTAIN"
        ? { state: "uncertain", completedAt: status?.completedAt ?? now }
        : { state: "failed", completedAt: status.completedAt, code: status.code };
    this.fillStates.set(pending.operationId, Object.freeze(state));
    pending.resolve(status);
  }

  requestFixtureFill(owner: symbol, operationId: string, now = Date.now(), deadlineMs = now + FIXTURE_FILL_TIMEOUT_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) return null;
    const available = this.getFixtureFillAuthorization(owner, operationId, now);
    if (!available) return null;
    this.listFixtureFillChallenges(now);
    if (this.fillChecks.size + this.geminiFillChecks.size >= MAX_PENDING_FIXTURE_FILLS
      || this.hasOccupiedComposer(operationId, available.target, now)) return "busy" as const;
    const authorization = this.consumeFixtureFillApproval(owner, operationId, now);
    if (!authorization) return null;
    const attemptId = randomUUID();
    const expiresAt = Math.min(deadlineMs, authorization.expiresAt, now + FIXTURE_FILL_TIMEOUT_MS);
    let resolve!: PendingFixtureFill["resolve"];
    const result = new Promise<FixtureFillStatus | null>((done) => { resolve = done; });
    const timer = setTimeout(() => this.finishFillCheck(attemptId, null), expiresAt - now);
    this.fillChecks.set(attemptId, { owner, operationId, target: authorization.target,
      text: authorization.text, expiresAt, timer, resolve });
    this.fillStates.set(operationId, Object.freeze({ state: "filling", startedAt: now, expiresAt }));
    return { attemptId, result };
  }

  listFixtureFillChallenges(now = Date.now(), autonomous = false, provider: "fixture" | "databag" = "fixture") {
    for (const [attemptId, pending] of this.fillChecks) {
      const state = this.getOperation(pending.owner, pending.operationId, now).state;
      if (pending.expiresAt <= now || (state !== "approved" && state !== "prepared")) {
        this.finishFillCheck(attemptId, null, now);
      }
    }
    return [...this.fillChecks].filter(([, pending]) => targetProvider(pending.target) === provider
      && (this.contents.get(pending.operationId)?.autonomous === true) === autonomous)
      .map(([attemptId, pending]) => Object.freeze({
      attemptId, operationId: pending.operationId, target: pending.target, text: pending.text, expiresAt: pending.expiresAt
    }));
  }

  completeFixtureFill(target: StableDomTarget, attemptId: string, observation: FixtureFillResult,
    now = Date.now()): boolean {
    const parsed = fixtureFillResultSchema.safeParse(observation);
    const pending = this.fillChecks.get(attemptId);
    if (!parsed.success || !pending || pending.expiresAt <= now
      || !this.sameComposerTarget(pending.target, target)
      || (target.provider === "databag" && parsed.data.ok && parsed.data.editor !== "textarea")
      || !["approved", "prepared"].includes(this.getOperation(pending.owner, pending.operationId, now).state)) return false;
    this.finishFillCheck(attemptId, { ...parsed.data, operationId: pending.operationId, completedAt: now });
    return true;
  }

  recordFixtureDispatchBaseline(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.contents.get(operationId);
    const approval = this.approvals.get(operationId);
    const live = operation && this.requests.getStableTarget(owner, operation.connectionId, now);
    const autonomous = operation?.autonomous && this.getAutonomousPhaseAuthorization(owner, operationId, "send", now);
    if (!operation || operation.owner !== owner || (!autonomous && (!approval || approval.expiresAt <= now)) || !live
      || !this.sameComposerTarget(live, operation.target)
      || this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?").get(operationId)) {
      throw new Error("APPROVAL_REQUIRED");
    }
    const snapshot = this.requests.getStableSnapshot(owner, operation.connectionId, now);
    if (!snapshot || snapshot === "not_ready" || snapshot.capturedAt > now) throw new Error("OBSERVATION_UNAVAILABLE");
    const baseline = Object.freeze({ capturedAt: snapshot.capturedAt, cursor: snapshot.cursor,
      messageIds: Object.freeze(snapshot.messages.map((message) => message.id)), messages: snapshot.messages,
      omittedBefore: snapshot.omittedBefore });
    this.dispatchBaselines.set(operationId, baseline);
    this.discardFixtureDispatchCheck(operationId);
    return Object.freeze({ operationId, capturedAt: baseline.capturedAt, cursor: baseline.cursor });
  }

  private freshDispatchBaseline(owner: symbol, operationId: string, now: number) {
    const operation = this.contents.get(operationId);
    const consent = this.sendApprovals.get(operationId);
    const fill = this.fillStates.get(operationId);
    const approvedAt = operation?.autonomous && fill?.state === "filled" ? fill.completedAt : consent?.approvedAt;
    const baseline = this.dispatchBaselines.get(operationId);
    const current = operation && this.requests.getStableSnapshot(owner, operation.connectionId, now);
    if (approvedAt === undefined || !baseline || baseline.capturedAt < approvedAt || baseline.capturedAt > now
      || baseline.capturedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS <= now
      || !current || current === "not_ready" || current.capturedAt > now
      || current.capturedAt < baseline.capturedAt
      || current.cursor.epoch !== baseline.cursor.epoch || current.cursor.sequence !== baseline.cursor.sequence) {
      throw new Error("OBSERVATION_UNAVAILABLE");
    }
    return baseline;
  }

  private finishFixtureDispatchInspection(operationId: string, ready: boolean): void {
    const pending = this.dispatchInspections.get(operationId);
    if (!pending) return;
    this.dispatchInspections.delete(operationId);
    clearTimeout(pending.timer);
    pending.resolve(ready);
  }

  private discardFixtureDispatchCheck(operationId: string): void {
    this.dispatchChecks.delete(operationId);
    this.finishFixtureDispatchInspection(operationId, false);
  }

  private discardGeminiDispatchCheck(operationId: string): void {
    this.geminiDispatchChecks.delete(operationId);
    this.finishFixtureDispatchInspection(operationId, false);
  }

  private freshGeminiDispatchCheck(operationId: string, check: GeminiDispatchCheck, now: number): boolean {
    const authorization = this.getGeminiSendAuthorization(check.owner, operationId, now);
    const operation = this.geminiContents.get(operationId);
    const current = operation && this.requests.getGeminiSnapshot(check.owner, operation.connectionId, now);
    return !!authorization && this.sameGeminiTarget(authorization.target, check.target)
      && check.createdAt <= now && check.expiresAt > now && check.baseline.capturedAt <= now
      && check.baseline.capturedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS > now
      && !!current && current !== "not_ready" && current.capturedAt <= now
      && current.capturedAt >= check.baseline.capturedAt && current.cursor.epoch === check.baseline.cursor.epoch
      && current.cursor.sequence === check.baseline.cursor.sequence;
  }

  private discardInvalidGeminiDispatchChecks(now: number): void {
    for (const [operationId, check] of this.geminiDispatchChecks) {
      if (!this.freshGeminiDispatchCheck(operationId, check, now)) this.discardGeminiDispatchCheck(operationId);
    }
  }

  requestGeminiDispatchRead(owner: symbol, operationId: string, now = Date.now(),
    deadlineMs = now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) return null;
    const authorization = this.getGeminiSendAuthorization(owner, operationId, now);
    const operation = this.geminiContents.get(operationId);
    if (!authorization || !operation) return null;
    this.discardInvalidGeminiDispatchChecks(now);
    if (this.geminiDispatchChecks.has(operationId)) return "busy" as const;
    return this.requests.requestFreshGeminiRead(owner, operation.connectionId, now,
      Math.min(deadlineMs, authorization.expiresAt));
  }

  requestGeminiDispatchInspection(owner: symbol, operationId: string, now = Date.now(),
    deadlineMs = now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) throw new Error("DISPATCH_CHECK_UNAVAILABLE");
    const authorization = this.getGeminiSendAuthorization(owner, operationId, now);
    if (!authorization) throw new Error("SEND_APPROVAL_REQUIRED");
    this.discardInvalidGeminiDispatchChecks(now);
    if (this.geminiDispatchChecks.has(operationId)
      || this.dispatchChecks.size + this.geminiDispatchChecks.size >= MAX_PENDING_FIXTURE_DISPATCH_CHECKS) return "busy" as const;
    const operation = this.geminiContents.get(operationId)!;
    const consent = this.sendApprovals.get(operationId);
    const fill = this.fillStates.get(operationId);
    const approvedAt = operation.autonomous && fill?.state === "filled" ? fill.completedAt : consent?.approvedAt;
    const baseline = this.requests.getGeminiSnapshot(owner, operation.connectionId, now);
    if (approvedAt === undefined || !baseline || baseline === "not_ready" || baseline.capturedAt < approvedAt || baseline.capturedAt > now
      || baseline.capturedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS <= now) throw new Error("OBSERVATION_UNAVAILABLE");
    const check = Object.freeze({ checkId: randomUUID(), owner, target: authorization.target, text: authorization.text,
      createdAt: now, expiresAt: Math.min(deadlineMs, authorization.expiresAt, now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS,
        baseline.capturedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS), baseline, checkedAt: null, issued: false });
    this.geminiDispatchChecks.set(operationId, check);
    let resolve!: (ready: boolean) => void;
    const result = new Promise<boolean>(done => { resolve = done; });
    const timer = setTimeout(() => this.discardGeminiDispatchCheck(operationId), check.expiresAt - now);
    this.dispatchInspections.set(operationId, { timer, resolve });
    return { checkId: check.checkId, result };
  }

  listGeminiDispatchChecks(now = Date.now(), autonomous = false) {
    this.discardExpired(now);
    this.discardInvalidGeminiDispatchChecks(now);
    const offered: Readonly<{ operationId: string; checkId: string; target: GeminiTarget; text: string; expiresAt: number }>[] = [];
    for (const [operationId, check] of this.geminiDispatchChecks) {
      if (check.checkedAt !== null || check.issued || (this.geminiContents.get(operationId)?.autonomous === true) !== autonomous) continue;
      this.geminiDispatchChecks.set(operationId, Object.freeze({ ...check, issued: true }));
      offered.push(Object.freeze({ operationId, checkId: check.checkId, target: check.target, text: check.text, expiresAt: check.expiresAt }));
    }
    return Object.freeze(offered);
  }

  completeGeminiDispatchCheck(target: GeminiTarget, operationId: string, checkId: string,
    observation: GeminiDispatchCheckResult, now = Date.now()): boolean {
    this.discardExpired(now);
    const check = this.geminiDispatchChecks.get(operationId);
    const parsed = geminiDispatchCheckResultSchema.safeParse(observation);
    if (!check || check.checkId !== checkId || !check.issued || check.checkedAt !== null || !parsed.success
      || !this.sameGeminiTarget(check.target, target)) return false;
    if (!parsed.data.ok || parsed.data.draftText !== check.text || !this.freshGeminiDispatchCheck(operationId, check, now)) {
      this.discardGeminiDispatchCheck(operationId);
      return false;
    }
    this.geminiDispatchChecks.set(operationId, Object.freeze({ ...check, checkedAt: now }));
    this.finishFixtureDispatchInspection(operationId, true);
    return true;
  }

  getGeminiDispatchProof(owner: symbol, operationId: string, checkId: string, now = Date.now()) {
    this.discardExpired(now);
    const check = this.geminiDispatchChecks.get(operationId);
    if (!check || check.owner !== owner || check.checkId !== checkId || !check.issued
      || check.checkedAt === null || check.checkedAt > now) return null;
    if (!this.freshGeminiDispatchCheck(operationId, check, now)) {
      this.discardGeminiDispatchCheck(operationId);
      return null;
    }
    return check;
  }

  requestFixtureDispatchInspection(owner: symbol, operationId: string, now = Date.now(),
    deadlineMs = now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) {
    if (!this.getFixtureSendAuthorization(owner, operationId, now)) throw new Error("SEND_APPROVAL_REQUIRED");
    if (this.dispatchInspections.has(operationId)) return "busy" as const;
    this.recordFixtureDispatchBaseline(owner, operationId, now);
    const check = this.requestFixtureDispatchCheck(owner, operationId, now, deadlineMs);
    let resolve!: (ready: boolean) => void;
    const result = new Promise<boolean>((done) => { resolve = done; });
    const timer = setTimeout(() => this.discardFixtureDispatchCheck(operationId), check.expiresAt - now);
    this.dispatchInspections.set(operationId, { timer, resolve });
    return { checkId: check.checkId, result };
  }

  requestFixtureDispatchCheck(owner: symbol, operationId: string, now = Date.now(),
    deadlineMs = now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) throw new Error("DISPATCH_CHECK_UNAVAILABLE");
    const authorization = this.getFixtureSendAuthorization(owner, operationId, now);
    if (!authorization) throw new Error("SEND_APPROVAL_REQUIRED");
    if (authorization.text.length > 2048 || authorization.text.trim() !== authorization.text
      || authorization.text.includes("\r")) throw new Error("UNSUPPORTED_MESSAGE_TEXT");
    const baseline = this.freshDispatchBaseline(owner, operationId, now);
    this.listFixtureDispatchChecks(now);
    if (!this.dispatchChecks.has(operationId)
      && this.dispatchChecks.size + this.geminiDispatchChecks.size >= MAX_PENDING_FIXTURE_DISPATCH_CHECKS) {
      throw new Error("DISPATCH_CHECK_BUSY");
    }
    const check = Object.freeze({ checkId: randomUUID(), owner, target: authorization.target,
      text: authorization.text, createdAt: now,
      expiresAt: Math.min(deadlineMs, authorization.expiresAt, now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS,
        baseline.capturedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS), baseline, checkedAt: null });
    this.discardFixtureDispatchCheck(operationId);
    this.dispatchChecks.set(operationId, check);
    return Object.freeze({ operationId, checkId: check.checkId, target: check.target,
      text: check.text, expiresAt: check.expiresAt });
  }

  listFixtureDispatchChecks(now = Date.now(), autonomous = false, provider: "fixture" | "databag" = "fixture") {
    this.discardExpired(now);
    for (const [operationId, check] of this.dispatchChecks) {
      try {
        if (check.createdAt > now || check.expiresAt <= now
          || !this.getFixtureSendAuthorization(check.owner, operationId, now)
          || this.freshDispatchBaseline(check.owner, operationId, now) !== check.baseline) {
          this.discardFixtureDispatchCheck(operationId);
        }
      } catch {
        this.discardFixtureDispatchCheck(operationId);
      }
    }
    return [...this.dispatchChecks].filter(([operationId, check]) => check.checkedAt === null
      && targetProvider(check.target) === provider
      && (this.contents.get(operationId)?.autonomous === true) === autonomous)
      .map(([operationId, check]) => Object.freeze({ operationId, checkId: check.checkId,
        target: check.target, text: check.text, expiresAt: check.expiresAt }));
  }

  completeFixtureDispatchCheck(target: StableDomTarget, operationId: string, checkId: string,
    observation: FixtureDispatchCheckResult, now = Date.now()): boolean {
    this.discardExpired(now);
    const check = this.dispatchChecks.get(operationId);
    const parsed = fixtureDispatchCheckResultSchema.safeParse(observation);
    if (!check || check.checkId !== checkId || check.checkedAt !== null || check.createdAt > now
      || check.expiresAt <= now || !parsed.success
      || !this.sameComposerTarget(check.target, target)
      || (target.provider === "databag" && parsed.data.ok && parsed.data.editor !== "textarea")) return false;
    if (!parsed.data.ok || parsed.data.draftText !== check.text
      || !this.getFixtureSendAuthorization(check.owner, operationId, now)) {
      this.discardFixtureDispatchCheck(operationId);
      return false;
    }
    try {
      if (this.freshDispatchBaseline(check.owner, operationId, now) !== check.baseline) {
        this.discardFixtureDispatchCheck(operationId);
        return false;
      }
    } catch {
      this.discardFixtureDispatchCheck(operationId);
      return false;
    }
    this.dispatchChecks.set(operationId, Object.freeze({ ...check, checkedAt: now }));
    this.finishFixtureDispatchInspection(operationId, true);
    return true;
  }

  recordGeminiDispatchStart(owner: symbol, operationId: string, now = Date.now(), checkId?: string) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("DISPATCH_UNAVAILABLE");
    this.discardExpired(now);
    const ownerId = this.owners.get(owner);
    const record = this.database.prepare("SELECT owner_id FROM prepared_message_operations WHERE operation_id = ?")
      .get(operationId) as { owner_id: string } | undefined;
    if (!record || record.owner_id !== ownerId) throw new Error("APPROVAL_REQUIRED");
    if (this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?")
      .get(operationId)) throw new Error("DISPATCH_UNCERTAIN");
    const operation = this.geminiContents.get(operationId);
    const approval = this.approvals.get(operationId);
    const live = operation && this.requests.getGeminiTarget(owner, operation.connectionId, now);
    const authorized = operation?.autonomous ? this.getAutonomousPhaseAuthorization(owner, operationId, "send", now)
      : approval && approval.expiresAt > now;
    if (!operation || operation.owner !== owner || !authorized || !live
      || !this.sameGeminiTarget(operation.target, live)) throw new Error("APPROVAL_REQUIRED");
    if (!this.getGeminiSendAuthorization(owner, operationId, now)) throw new Error("SEND_APPROVAL_REQUIRED");
    if (!this.database.prepare("SELECT 1 FROM message_operation_recovery WHERE operation_id = ?").get(operationId)) {
      throw new Error("RECOVERY_REQUIRED");
    }
    if (!this.getGeminiDispatchProof(owner, operationId, checkId ?? "", now)) throw new Error("DISPATCH_CHECK_REQUIRED");
    this.recordDispatchIntent(operationId, operation.target, now);
    this.approvals.delete(operationId);
    this.reviewTokens.delete(operationId);
    this.sendApprovals.delete(operationId);
    this.sendReviewTokens.delete(operationId);
    this.discardGeminiDispatchCheck(operationId);
    return Object.freeze({ operationId, state: "dispatching" as const, startedAt: now });
  }

  private recordDispatchIntent(operationId: string, target: Pick<ApprovedTarget, "origin" | "conversationId">, now: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.hasUnresolvedDispatch(target)) throw new Error("DISPATCH_UNCERTAIN");
      if (this.isSendRateLimited(target, now)) throw new Error("SEND_RATE_LIMITED");
      this.database.prepare(`INSERT INTO message_dispatch_attempts (operation_id, started_at, conversation_key, state)
        VALUES (?, ?, ?, 'dispatching')`).run(operationId, now, this.conversationKey(target));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordFixtureDispatchStart(owner: symbol, operationId: string, now = Date.now(), checkId?: string) {
    this.discardExpired(now);
    const ownerId = this.owners.get(owner);
    const record = this.database.prepare("SELECT owner_id FROM prepared_message_operations WHERE operation_id = ?")
      .get(operationId) as { owner_id: string } | undefined;
    if (!record || record.owner_id !== ownerId) throw new Error("APPROVAL_REQUIRED");
    if (this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?")
      .get(operationId)) throw new Error("DISPATCH_UNCERTAIN");
    const operation = this.contents.get(operationId);
    const approval = this.approvals.get(operationId);
    const live = operation && this.requests.getStableTarget(owner, operation.connectionId, now);
    const authorized = operation?.autonomous ? this.getAutonomousPhaseAuthorization(owner, operationId, "send", now)
      : approval && approval.expiresAt > now;
    if (!operation || operation.owner !== owner || !authorized || !live
      || !this.sameComposerTarget(live, operation.target)) {
      throw new Error("APPROVAL_REQUIRED");
    }
    if (!this.getFixtureSendAuthorization(owner, operationId, now)) throw new Error("SEND_APPROVAL_REQUIRED");
    if (!this.database.prepare("SELECT 1 FROM message_operation_recovery WHERE operation_id = ?").get(operationId)) {
      throw new Error("RECOVERY_REQUIRED");
    }
    const baseline = this.freshDispatchBaseline(owner, operationId, now);
    const check = this.dispatchChecks.get(operationId);
    if (!check || check.owner !== owner || check.checkId !== checkId || check.baseline !== baseline
      || check.checkedAt === null || check.checkedAt > now || check.expiresAt <= now) {
      throw new Error("DISPATCH_CHECK_REQUIRED");
    }
    this.recordDispatchIntent(operationId, operation.target, now);
    this.approvals.delete(operationId);
    this.reviewTokens.delete(operationId);
    this.sendApprovals.delete(operationId);
    this.sendReviewTokens.delete(operationId);
    this.dispatchChecks.delete(operationId);
    this.dispatchAuthorizations.set(operationId, Object.freeze({ owner, operationId,
      target: operation.target, text: operation.text, startedAt: now, expiresAt: check.expiresAt }));
    return Object.freeze({ operationId, state: "dispatching" as const, startedAt: now });
  }

  consumeFixtureDispatchAuthorization(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const authorization = this.dispatchAuthorizations.get(operationId);
    if (!authorization || authorization.owner !== owner) return null;
    this.dispatchAuthorizations.delete(operationId);
    const operation = this.contents.get(operationId);
    const live = operation && this.requests.getStableTarget(owner, operation.connectionId, now);
    const baseline = this.dispatchBaselines.get(operationId);
    const current = operation && this.requests.getStableSnapshot(owner, operation.connectionId, now);
    const intent = this.database.prepare("SELECT started_at, state FROM message_dispatch_attempts WHERE operation_id = ?")
      .get(operationId) as { started_at: number; state: string } | undefined;
    if (!live || !this.sameComposerTarget(live, authorization.target)
      || authorization.startedAt > now || authorization.expiresAt <= now
      || intent?.state !== "dispatching" || intent.started_at !== authorization.startedAt
      || !baseline || baseline.capturedAt > now || baseline.capturedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS <= now
      || !current || current === "not_ready" || current.capturedAt > now || current.capturedAt < baseline.capturedAt
      || current.cursor.epoch !== baseline.cursor.epoch || current.cursor.sequence !== baseline.cursor.sequence
      || this.database.prepare("SELECT 1 FROM message_dispatch_evidence WHERE operation_id = ?").get(operationId)) return null;
    return Object.freeze({ operationId, attemptId: operationId, target: authorization.target,
      text: authorization.text, expiresAt: authorization.expiresAt });
  }

  private finishGeminiDispatch(operationId: string): void {
    const pending = this.geminiDispatchJobs.get(operationId);
    if (!pending) return;
    this.geminiDispatchJobs.delete(operationId);
    clearTimeout(pending.timer);
    pending.resolve(this.dispatchStatus(operationId) ??
      Object.freeze({ operationId, state: "dispatch_uncertain", startedAt: pending.startedAt }));
  }

  requestGeminiDispatch(owner: symbol, operationId: string, checkId: string, now = Date.now(),
    deadlineMs = now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadlineMs) || deadlineMs <= now) {
      throw new Error("DISPATCH_UNAVAILABLE");
    }
    const status = this.getOperation(owner, operationId, now);
    if (status.state === "dispatch_uncertain" || status.state === "observed_in_ui" || status.state === "resolved") {
      throw new Error("DISPATCH_UNCERTAIN");
    }
    if (status.state !== "approved" && status.state !== "prepared") throw new Error("APPROVAL_REQUIRED");
    if (this.dispatchJobs.size + this.geminiDispatchJobs.size >= MAX_PENDING_FIXTURE_DISPATCHES) throw new Error("DISPATCH_CHECK_BUSY");
    const authorization = this.getGeminiSendAuthorization(owner, operationId, now);
    const proof = this.getGeminiDispatchProof(owner, operationId, checkId, now);
    if (!authorization || !proof) throw new Error("DISPATCH_UNAVAILABLE");
    const expiresAt = Math.min(deadlineMs, authorization.expiresAt, proof.expiresAt);
    const started = this.recordGeminiDispatchStart(owner, operationId, now, checkId);
    let resolve!: PendingGeminiDispatch["resolve"];
    const result = new Promise<GeminiDispatchStatus>(done => { resolve = done; });
    const timer = setTimeout(() => this.finishGeminiDispatch(operationId), expiresAt - now);
    this.geminiDispatchJobs.set(operationId, { owner, operationId, target: authorization.target, text: authorization.text,
      expiresAt, startedAt: started.startedAt, baseline: proof.baseline, issued: false, timer, resolve });
    return { operationId, result };
  }

  private freshGeminiDispatch(pending: PendingGeminiDispatch, now: number): boolean {
    const operation = this.geminiContents.get(pending.operationId);
    const live = operation && this.requests.getGeminiTarget(pending.owner, operation.connectionId, now);
    const current = operation && this.requests.getGeminiSnapshot(pending.owner, operation.connectionId, now);
    const intent = this.database.prepare("SELECT state, started_at FROM message_dispatch_attempts WHERE operation_id = ?")
      .get(pending.operationId) as { state: string; started_at: number } | undefined;
    return !!operation && operation.owner === pending.owner && operation.text === pending.text
      && this.sameGeminiTarget(operation.target, pending.target) && !!live && this.sameGeminiTarget(live, pending.target)
      && pending.startedAt <= now && pending.expiresAt > now
      && intent?.state === "dispatching" && intent.started_at === pending.startedAt
      && pending.baseline.capturedAt <= now && pending.baseline.capturedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS > now
      && !!current && current !== "not_ready" && current.capturedAt <= now && current.capturedAt >= pending.baseline.capturedAt
      && current.cursor.epoch === pending.baseline.cursor.epoch
      && (pending.issued ? current.cursor.sequence >= pending.baseline.cursor.sequence
        : current.cursor.sequence === pending.baseline.cursor.sequence)
      && !this.database.prepare("SELECT 1 FROM message_dispatch_evidence WHERE operation_id = ?").get(pending.operationId);
  }

  listGeminiDispatchAttempts(now = Date.now()) {
    this.discardExpired(now);
    const attempts: Array<Readonly<{ operationId: string; attemptId: string; target: GeminiTarget; text: string; expiresAt: number }>> = [];
    for (const [operationId, pending] of this.geminiDispatchJobs) {
      if (!this.freshGeminiDispatch(pending, now)) {
        this.finishGeminiDispatch(operationId);
        continue;
      }
      if (pending.issued) continue;
      pending.issued = true;
      this.geminiDispatchBaselines.set(operationId, pending.baseline);
      attempts.push(Object.freeze({ operationId, attemptId: operationId, target: pending.target,
        text: pending.text, expiresAt: pending.expiresAt }));
    }
    return attempts;
  }

  completeGeminiDispatch(target: GeminiTarget, operationId: string, attemptId: string,
    observation: GeminiDispatchResult, now = Date.now()): boolean {
    this.discardExpired(now);
    const pending = this.geminiDispatchJobs.get(operationId);
    if (!pending || !pending.issued || attemptId !== operationId || !this.sameGeminiTarget(pending.target, target)
      || !geminiDispatchResultSchema.safeParse(observation).success) return false;
    if (!this.freshGeminiDispatch(pending, now)) {
      this.finishGeminiDispatch(operationId);
      return false;
    }
    if (observation.ok) this.reconcileGeminiObservation(pending.owner, operationId, now);
    this.finishGeminiDispatch(operationId);
    return true;
  }

  private geminiDispatchEvidence(owner: symbol, operationId: string, now: number) {
    const operation = this.geminiContents.get(operationId);
    const baseline = this.geminiDispatchBaselines.get(operationId);
    const live = operation && this.requests.getGeminiTarget(owner, operation.connectionId, now);
    const status = this.dispatchStatus(operationId);
    if (!operation || operation.owner !== owner || !baseline
      || baseline.messages.some(message => message.truncated) || !live || !this.sameGeminiTarget(operation.target, live)
      || status?.state !== "dispatch_uncertain" || this.ambiguousEvidence.has(operationId)) return null;
    const snapshot = this.requests.getGeminiSnapshot(owner, operation.connectionId, now);
    if (!snapshot || snapshot === "not_ready" || snapshot.capturedAt < status.startedAt
      || snapshot.capturedAt > now || snapshot.cursor.epoch !== baseline.cursor.epoch
      || snapshot.cursor.sequence < baseline.cursor.sequence) return null;
    const events = this.requests.readGeminiEvents(owner, operation.connectionId, baseline.cursor, MAX_RETURNED_EVENTS, now);
    if (!events || events === "not_ready" || events.state !== "ok"
      || events.cursor.sequence !== snapshot.cursor.sequence) return null;
    let appended = false;
    let droppedRows = 0;
    for (const capture of [...events.events.map(event => geminiObservationSchema.safeParse(event.payload)),
      geminiObservationSchema.safeParse({ kind: "gemini_snapshot", omittedBefore: snapshot.omittedBefore, messages: snapshot.messages })]) {
      if (!capture.success || capture.data.messages.some(message => message.truncated)) {
        this.ambiguousEvidence.add(operationId);
        return null;
      }
      let offset = 0;
      if (baseline.omittedBefore || capture.data.omittedBefore) {
        if (baseline.messages.length !== MAX_GEMINI_SNAPSHOT_MESSAGES
          || capture.data.messages.length !== MAX_GEMINI_SNAPSHOT_MESSAGES || !capture.data.omittedBefore) {
          this.ambiguousEvidence.add(operationId);
          return null;
        }
        const offsets = baseline.messages.flatMap((_, start) => baseline.messages.slice(start).every((message, index) =>
          message.direction === capture.data.messages[index]?.direction && message.text === capture.data.messages[index]?.text)
          ? [start] : []);
        const matched = offsets[0];
        if (offsets.length !== 1 || matched === undefined || matched > 2 || matched < droppedRows
          || (matched === 0 && !baseline.omittedBefore)) {
          this.ambiguousEvidence.add(operationId);
          return null;
        }
        offset = matched;
      } else if (droppedRows > 0 || baseline.messages.some((message, index) =>
        message.direction !== capture.data.messages[index]?.direction || message.text !== capture.data.messages[index]?.text)) {
        this.ambiguousEvidence.add(operationId);
        return null;
      }
      droppedRows = offset;
      const added = capture.data.messages.slice(baseline.messages.length - offset);
      if (!added.length) {
        if (appended) {
          this.ambiguousEvidence.add(operationId);
          return null;
        }
        continue;
      }
      if (added[0]?.direction !== "outgoing" || added[0].text !== operation.text
        || added.slice(1).some(message => message.direction !== "incoming")) {
        this.ambiguousEvidence.add(operationId);
        return null;
      }
      appended = true;
    }
    if (!appended && (baseline.omittedBefore || snapshot.omittedBefore)) return null;
    return Object.freeze({ outcome: appended ? "sent" as const : "unchanged" as const, observedAt: snapshot.capturedAt });
  }

  reconcileGeminiObservation(owner: symbol, operationId: string, now = Date.now()) {
    const status = this.getOperation(owner, operationId, now);
    if (status.state !== "dispatch_uncertain") return status;
    const evidence = this.geminiDispatchEvidence(owner, operationId, now);
    if (evidence?.outcome !== "sent") return status;
    this.database.prepare(`INSERT INTO message_dispatch_resolutions (operation_id, resolved_at, outcome, source)
      VALUES (?, ?, 'sent', 'page') ON CONFLICT (operation_id) DO NOTHING`).run(operationId, evidence.observedAt);
    return this.dispatchStatus(operationId) ?? status;
  }

  private finishFixtureDispatch(operationId: string): void {
    const pending = this.dispatchJobs.get(operationId);
    if (!pending) return;
    this.dispatchJobs.delete(operationId);
    clearTimeout(pending.timer);
    pending.resolve(this.dispatchStatus(operationId) ?? {
      operationId, state: "dispatch_uncertain", startedAt: pending.startedAt
    });
  }

  async commitFixtureMessage(owner: symbol, operationId: string, deadlineMs: number) {
    if (this.contents.get(operationId)?.target.provider === "databag") throw new Error("DISPATCH_UNAVAILABLE");
    if (!this.contents.has(operationId) && !this.dispatchStatus(operationId)) throw new Error("DISPATCH_UNAVAILABLE");
    return this.commitPreparedMessage(owner, operationId, deadlineMs);
  }

  async commitAutonomousMessage(owner: symbol, operationId: string, deadlineMs: number): Promise<FixtureDispatchStatus> {
    const now = Date.now();
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now || deadlineMs > now + 30_000) throw new Error("DISPATCH_UNAVAILABLE");
    const status = this.getOperation(owner, operationId, now);
    const running = this.autonomousCommits.get(operationId);
    if (running) {
      if (running.owner !== owner) throw new Error("DISPATCH_UNAVAILABLE");
      return running.result;
    }
    const operation = this.contents.get(operationId) ?? this.geminiContents.get(operationId);
    if (!operation?.autonomous || operation.owner !== owner) throw new Error("DISPATCH_UNAVAILABLE");
    if (status.state === "dispatch_uncertain" || status.state === "observed_in_ui" || status.state === "resolved") return status;
    const authorization = this.getAutonomousAuthorization(owner, operationId, now);
    if (!authorization) throw new Error("DISPATCH_UNAVAILABLE");
    const expiresAt = Math.min(deadlineMs, authorization.expiresAt);
    let failureStage: z.infer<typeof autonomousFailureStageSchema> = "composer";
    let failureReason: z.infer<typeof autonomousFailureReasonSchema> | undefined;
    const result = (async () => {
      if (!await this.acquireComposer(owner, operationId, expiresAt)) {
        const refusedAt = Date.now();
        if (refusedAt < expiresAt && this.getAutonomousAuthorization(owner, operationId, refusedAt)
          && this.hasUnresolvedDispatch(operation.target)
          && !this.hasOccupiedComposer(operationId, operation.target, refusedAt)) failureReason = "unconfirmed_send";
        throw new Error("DISPATCH_UNAVAILABLE");
      }
      try {
        failureStage = "fill";
        const filling = this.requestChatFill(owner, operationId, Date.now(), expiresAt);
        if (!filling || filling === "busy" || !(await filling.result)?.ok || expiresAt <= Date.now()) {
          throw new Error("DISPATCH_UNAVAILABLE");
        }
        failureStage = "read";
        const reading = operation.target.origin === "https://gemini.google.com"
          ? this.requests.requestFreshGeminiRead(owner, operation.connectionId, Date.now(), expiresAt)
          : this.requests.requestFreshStableRead(owner, operation.connectionId, Date.now(), expiresAt);
        if (!reading || reading === "busy") throw new Error("DISPATCH_UNAVAILABLE");
        const snapshot = await reading.result;
        if (!snapshot || snapshot === "not_ready" || expiresAt <= Date.now()) throw new Error("DISPATCH_UNAVAILABLE");
        failureStage = "proof";
        const inspecting = this.requestChatProof(owner, operationId, Date.now(), expiresAt);
        if (inspecting === "busy" || !await inspecting.result || expiresAt <= Date.now()) throw new Error("DISPATCH_UNAVAILABLE");
        failureStage = "dispatch";
        const dispatching = operation.target.origin === "https://gemini.google.com"
          ? this.requestGeminiDispatch(owner, operationId, inspecting.checkId, Date.now(), expiresAt)
          : this.requestFixtureDispatch(owner, operationId, inspecting.checkId, Date.now(), expiresAt);
        return await this.settleAutonomousDispatch(owner, operationId, expiresAt, await dispatching.result);
      } finally {
        this.settlementChecks.delete(operationId);
        this.releaseComposer(owner, operationId);
      }
    })().catch(error => {
      if (error instanceof Error) throw new AutonomousCommitFailure(error.message, failureStage, failureReason);
      throw error;
    }).then(completed => {
      this.autonomousCommits.delete(operationId);
      return completed;
    });
    this.autonomousCommits.set(operationId, Object.freeze({ owner, result }));
    return result;
  }

  private async settleAutonomousDispatch(owner: symbol, operationId: string, deadlineMs: number, status: FixtureDispatchStatus) {
    const expiresAt = Math.min(deadlineMs, Date.now() + CHAT_SETTLE_TIMEOUT_MS);
    const inspectAfter = status.state === "dispatch_uncertain"
      ? Math.max(status.startedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS, expiresAt - FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) : expiresAt;
    while (status.state === "dispatch_uncertain" && Date.now() < expiresAt) {
      const authorization = this.getAutonomousAuthorization(owner, operationId);
      const operation = this.contents.get(operationId) ?? this.geminiContents.get(operationId);
      if (!authorization || !operation) break;
      const observed = authorization.target.origin === "https://gemini.google.com"
        ? this.reconcileGeminiObservation(owner, operationId) : this.reconcileFixtureObservation(owner, operationId);
      if (observed.state === "observed_in_ui" || observed.state === "resolved") return observed;
      if (Date.now() >= inspectAfter) this.requestChatSettlement(owner, operationId, expiresAt);
      const terminal = this.settlementChecks.get(operationId);
      if (terminal?.ready && terminal.completedAt !== null && terminal.createdAt >= inspectAfter && terminal.job.expiresAt > Date.now()) {
        terminal.ready = false;
        const reading = authorization.target.origin === "https://gemini.google.com"
          ? this.requests.requestFreshGeminiRead(owner, operation.connectionId, Date.now(), terminal.job.expiresAt)
          : this.requests.requestFreshStableRead(owner, operation.connectionId, Date.now(), terminal.job.expiresAt);
        const snapshot = reading && reading !== "busy" ? await reading.result : null;
        const now = Date.now();
        if (snapshot && snapshot !== "not_ready" && snapshot.capturedAt >= terminal.completedAt && now < terminal.job.expiresAt
          && this.getAutonomousAuthorization(owner, operationId, now)) {
          const evidenced = authorization.target.origin === "https://gemini.google.com"
            ? this.reconcileGeminiObservation(owner, operationId, now) : this.reconcileFixtureObservation(owner, operationId, now);
          if (evidenced.state === "observed_in_ui" || evidenced.state === "resolved") return evidenced;
          const unchangedAt = authorization.target.origin === "https://gemini.google.com"
            ? this.geminiDispatchEvidence(owner, operationId, now) : this.fixtureUnchangedDispatchEvidence(owner, operationId, now);
          if (unchangedAt?.outcome === "unchanged" && unchangedAt.observedAt >= terminal.completedAt) {
            this.database.prepare(`INSERT INTO message_dispatch_resolutions (operation_id, resolved_at, outcome, source)
              VALUES (?, ?, 'not_sent', 'page') ON CONFLICT (operation_id) DO NOTHING`).run(operationId, unchangedAt.observedAt);
            return this.dispatchStatus(operationId) ?? status;
          }
        }
      }
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) break;
      await new Promise<void>(done => setTimeout(done, Math.min(25, remainingMs)));
    }
    return status;
  }

  private fixtureUnchangedDispatchEvidence(owner: symbol, operationId: string, now: number) {
    const operation = this.contents.get(operationId);
    const baseline = this.dispatchBaselines.get(operationId);
    const status = this.dispatchStatus(operationId);
    const live = operation && this.requests.getStableTarget(owner, operation.connectionId, now);
    if (!operation || operation.owner !== owner || !baseline || baseline.omittedBefore
      || baseline.messages.some(message => message.truncated) || !live || !this.sameComposerTarget(operation.target, live)
      || status?.state !== "dispatch_uncertain" || this.ambiguousEvidence.has(operationId)) return null;
    const snapshot = this.requests.getStableSnapshot(owner, operation.connectionId, now);
    if (!snapshot || snapshot === "not_ready" || snapshot.omittedBefore || snapshot.capturedAt < status.startedAt
      || snapshot.capturedAt > now || snapshot.cursor.epoch !== baseline.cursor.epoch
      || snapshot.cursor.sequence < baseline.cursor.sequence) return null;
    const events = this.requests.readStableEvents(owner, operation.connectionId, baseline.cursor, MAX_RETURNED_EVENTS, now);
    if (!events || events === "not_ready" || events.state !== "ok" || events.cursor.sequence !== snapshot.cursor.sequence) return null;
    for (const capture of [...events.events.map(event => fixtureObservationSchema.safeParse(event.payload)),
      fixtureObservationSchema.safeParse({ kind: "fixture_snapshot", omittedBefore: snapshot.omittedBefore, messages: snapshot.messages })]) {
      if (!capture.success || capture.data.omittedBefore || capture.data.messages.some(message => message.truncated)
        || capture.data.messages.length !== baseline.messages.length
        || baseline.messages.some((message, index) => message.id !== capture.data.messages[index]?.id
          || message.direction !== capture.data.messages[index]?.direction || message.text !== capture.data.messages[index]?.text)) {
        this.ambiguousEvidence.add(operationId);
        return null;
      }
    }
    return Object.freeze({ outcome: "unchanged" as const, observedAt: snapshot.capturedAt });
  }

  async commitPreparedMessage(owner: symbol, operationId: string, deadlineMs: number) {
    const now = Date.now();
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) throw new Error("DISPATCH_UNAVAILABLE");
    const status = this.getOperation(owner, operationId, now);
    if (status.state === "dispatch_uncertain" || status.state === "observed_in_ui" || status.state === "resolved") return status;
    const operation = this.contents.get(operationId) ?? this.geminiContents.get(operationId);
    const gemini = operation?.target.origin === "https://gemini.google.com";
    const adapter = gemini ? {
      authorize: () => this.getGeminiSendAuthorization(owner, operationId, now),
      read: (connectionId: string, expiresAt: number) => this.requests.requestFreshGeminiRead(owner, connectionId, now, expiresAt),
      inspect: (expiresAt: number) => this.requestGeminiDispatchInspection(owner, operationId, Date.now(), expiresAt),
      dispatch: (checkId: string, expiresAt: number) => this.requestGeminiDispatch(owner, operationId, checkId, Date.now(), expiresAt)
    } : {
      authorize: () => this.getFixtureSendAuthorization(owner, operationId, now),
      read: (connectionId: string, expiresAt: number) => this.requests.requestFreshFixtureRead(owner, connectionId, now, expiresAt),
      inspect: (expiresAt: number) => this.requestFixtureDispatchInspection(owner, operationId, Date.now(), expiresAt),
      dispatch: (checkId: string, expiresAt: number) => this.requestFixtureDispatch(owner, operationId, checkId, Date.now(), expiresAt)
    };
    const authorization = adapter.authorize();
    if (!authorization || !operation || operation.owner !== owner) throw new Error("DISPATCH_UNAVAILABLE");
    const expiresAt = Math.min(deadlineMs, authorization.expiresAt);
    this.createRecoveryReceiptRecord(operationId);
    const reading = adapter.read(operation.connectionId, expiresAt);
    if (!reading || reading === "busy") throw new Error("DISPATCH_UNAVAILABLE");
    const snapshot = await reading.result;
    if (!snapshot || snapshot === "not_ready" || expiresAt <= Date.now()) throw new Error("DISPATCH_UNAVAILABLE");
    const inspecting = adapter.inspect(expiresAt);
    if (inspecting === "busy" || !await inspecting.result || expiresAt <= Date.now()) throw new Error("DISPATCH_UNAVAILABLE");
    return adapter.dispatch(inspecting.checkId, expiresAt).result;
  }

  listChatSubmitJobs(provider: "fixture" | "gemini" | "databag", now = Date.now()) {
    const attempts = provider === "gemini" ? this.listGeminiDispatchAttempts(now) : this.listFixtureDispatchAttempts(now, true, provider);
    return attempts.map(attempt => Object.freeze(chatSubmitJobSchema.parse({ operationId: attempt.operationId, jobId: attempt.attemptId,
      phase: "submit" as const, target: Object.freeze({ ...attempt.target, provider }),
      text: attempt.text, expiresAt: attempt.expiresAt })));
  }

  private ownUnsentLeftover(operationId: string, now: number) {
    const operation = this.contents.get(operationId) ?? this.geminiContents.get(operationId);
    if (!operation?.autonomous) return undefined;
    for (const [previousId, previous] of [...this.contents, ...this.geminiContents].reverse()) {
      if (previousId === operationId || !previous.autonomous || previous.owner !== operation.owner
        || previous.connectionId !== operation.connectionId || previous.expiresAt <= now
        || !this.sameComposerTarget(previous.target, operation.target)
        || (previous.target.origin === "https://gemini.google.com" && (operation.target.origin !== "https://gemini.google.com"
          || previous.target.url !== operation.target.url)) || this.fillStates.get(previousId)?.state !== "filled") continue;
      const status = this.dispatchStatus(previousId);
      if (status?.state === "resolved" && status.resolution.outcome === "not_sent") {
        return Object.freeze({ operationId: previousId, text: previous.text });
      }
    }
    return undefined;
  }

  requestChatFill(owner: symbol, operationId: string, now = Date.now(), deadlineMs = now + FIXTURE_FILL_TIMEOUT_MS) {
    const authority = this.getAutonomousPhaseAuthorization(owner, operationId, "fill", now);
    if (!authority) return null;
    return authority.target.origin === "https://gemini.google.com" ? this.requestGeminiFill(owner, operationId, now, deadlineMs)
      : this.requestFixtureFill(owner, operationId, now, deadlineMs);
  }

  requestChatProof(owner: symbol, operationId: string, now = Date.now(), deadlineMs = now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) {
    const authority = this.getAutonomousPhaseAuthorization(owner, operationId, "send", now);
    if (!authority) throw new Error("DISPATCH_CHECK_UNAVAILABLE");
    return authority.target.origin === "https://gemini.google.com" ? this.requestGeminiDispatchInspection(owner, operationId, now, deadlineMs)
      : this.requestFixtureDispatchInspection(owner, operationId, now, deadlineMs);
  }

  requestChatSettlement(owner: symbol, operationId: string, deadlineMs: number, now = Date.now()) {
    const authorization = this.getAutonomousAuthorization(owner, operationId, now);
    const reservation = this.composerReservations.get(operationId);
    if (!authorization || !Number.isSafeInteger(deadlineMs) || deadlineMs <= now || reservation?.owner !== owner
      || reservation.expiresAt <= now || this.dispatchStatus(operationId)?.state !== "dispatch_uncertain") return null;
    const existing = this.settlementChecks.get(operationId);
    if (existing) return existing.job.expiresAt > now ? existing.job : null;
    if (this.settlementChecks.size >= MAX_PENDING_FIXTURE_DISPATCH_CHECKS) return null;
    const provider = targetProvider(authorization.target);
    const parsed = chatJobSchema.parse({ operationId, jobId: randomUUID(), phase: "settle",
      target: { ...authorization.target, provider }, text: authorization.text,
      expiresAt: Math.min(deadlineMs, authorization.expiresAt, reservation.expiresAt, now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) });
    const job = Object.freeze({ ...parsed, target: Object.freeze(parsed.target) });
    this.settlementChecks.set(operationId, { owner, job, createdAt: now, issued: false, completedAt: null, ready: false });
    return job;
  }

  listChatJobs(phase: ChatJob["phase"], provider: "fixture" | "gemini" | "databag", now = Date.now()) {
    if (phase === "settle") {
      this.discardExpired(now);
      for (const [operationId, pending] of this.settlementChecks) {
        const reservation = this.composerReservations.get(operationId);
        if (pending.issued || pending.job.target.provider !== provider || pending.job.expiresAt <= now
          || !this.getAutonomousAuthorization(pending.owner, operationId, now)
          || reservation?.owner !== pending.owner || reservation.expiresAt <= now
          || this.dispatchStatus(operationId)?.state !== "dispatch_uncertain") continue;
        pending.issued = true;
        return Object.freeze([pending.job]);
      }
      return Object.freeze([] as ChatJob[]);
    }
    if (phase === "submit") return this.listChatSubmitJobs(provider, now);
    const checks = phase === "fill" ? provider === "gemini" ? this.listGeminiFillChallenges(now, true) : this.listFixtureFillChallenges(now, true, provider)
      : provider === "gemini" ? this.listGeminiDispatchChecks(now, true) : this.listFixtureDispatchChecks(now, true, provider);
    const jobs: ChatJob[] = [];
    for (const check of checks) {
      const jobId = "attemptId" in check ? check.attemptId : check.checkId;
      const key = `${phase}:${jobId}`;
      const offered = this.neutralJobOffers.get(check.operationId) ?? new Set<string>();
      if (offered.has(key)) continue;
      const leftover = phase === "fill" ? this.ownUnsentLeftover(check.operationId, now) : undefined;
      const job = chatJobSchema.parse({ operationId: check.operationId, jobId, phase, target: { ...check.target, provider },
        text: check.text, expiresAt: check.expiresAt, ...(leftover ? { leftover } : {}) });
      offered.add(key);
      this.neutralJobOffers.set(check.operationId, offered);
      jobs.push(Object.freeze({ ...job, target: Object.freeze(job.target) }));
    }
    return Object.freeze(jobs);
  }

  completeChatJob(target: ChatTarget, operationId: string, jobId: string, phase: ChatJob["phase"],
    observation: ChatJobObservation, now = Date.now()): boolean {
    const parsed = chatJobCompletionSchema.safeParse({ target, operationId, jobId, phase, observation });
    if (!parsed.success) return false;
    if (parsed.data.phase === "settle") {
      const pending = this.settlementChecks.get(operationId);
      const authorization = pending && this.getAutonomousAuthorization(pending.owner, operationId, now);
      const reservation = this.composerReservations.get(operationId);
      if (!pending || !authorization || !pending.issued || pending.completedAt !== null || pending.createdAt > now
        || pending.job.jobId !== jobId || pending.job.expiresAt <= now
        || reservation?.owner !== pending.owner || reservation.expiresAt <= now
        || !this.sameComposerTarget(pending.job.target, target) || pending.job.target.provider !== target.provider
        || (pending.job.target.provider === "gemini" && (target.provider !== "gemini" || pending.job.target.url !== target.url))
        || this.dispatchStatus(operationId)?.state !== "dispatch_uncertain") return false;
      pending.completedAt = now;
      pending.ready = parsed.data.observation.ok && parsed.data.observation.draftText === authorization.text;
      return true;
    }
    if (parsed.data.phase === "submit") return this.completeChatSubmitJob(target, operationId, jobId, parsed.data.observation, now);
    if (!this.neutralJobOffers.get(operationId)?.has(`${phase}:${jobId}`)) return false;
    if (parsed.data.phase === "fill") return target.provider === "gemini"
      ? this.completeGeminiFill(target, jobId, parsed.data.observation as GeminiFillResult, now)
      : this.completeFixtureFill(target, jobId, parsed.data.observation as FixtureFillResult, now);
    return target.provider === "gemini"
      ? this.completeGeminiDispatchCheck(target, operationId, jobId, parsed.data.observation as GeminiDispatchCheckResult, now)
      : this.completeFixtureDispatchCheck(target, operationId, jobId, parsed.data.observation as FixtureDispatchCheckResult, now);
  }

  completeChatSubmitJob(target: ApprovedTarget, operationId: string, jobId: string,
    observation: FixtureDispatchResult | GeminiDispatchResult, now = Date.now()) {
    if (isGeminiTarget(target)) {
      const parsed = geminiDispatchResultSchema.safeParse(observation);
      return parsed.success && this.completeGeminiDispatch(target, operationId, jobId, parsed.data, now);
    }
    const parsed = fixtureDispatchResultSchema.safeParse(observation);
    return parsed.success && this.completeFixtureDispatch(target, operationId, jobId, parsed.data, now);
  }

  requestFixtureDispatch(owner: symbol, operationId: string, checkId: string, now = Date.now(),
    deadlineMs = now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) throw new Error("DISPATCH_UNAVAILABLE");
    const status = this.getOperation(owner, operationId, now);
    if (status.state === "dispatch_uncertain" || status.state === "observed_in_ui" || status.state === "resolved") {
      throw new Error("DISPATCH_UNCERTAIN");
    }
    if (status.state !== "approved" && status.state !== "prepared") throw new Error("APPROVAL_REQUIRED");
    if (this.dispatchJobs.size + this.geminiDispatchJobs.size >= MAX_PENDING_FIXTURE_DISPATCHES) throw new Error("DISPATCH_CHECK_BUSY");
    const started = this.recordFixtureDispatchStart(owner, operationId, now, checkId);
    const authorization = this.consumeFixtureDispatchAuthorization(owner, operationId, now);
    if (!authorization) throw new Error("DISPATCH_UNCERTAIN");
    const expiresAt = Math.min(deadlineMs, authorization.expiresAt);
    let resolve!: PendingFixtureDispatch["resolve"];
    const result = new Promise<FixtureDispatchStatus>(done => { resolve = done; });
    const timer = setTimeout(() => this.finishFixtureDispatch(operationId), expiresAt - now);
    this.dispatchJobs.set(operationId, { owner, operationId, target: authorization.target, text: authorization.text,
      expiresAt, startedAt: started.startedAt, issued: false, timer, resolve });
    return { operationId, result };
  }

  listFixtureDispatchAttempts(now = Date.now(), includeAutonomous = false, provider: "fixture" | "databag" = "fixture") {
    this.discardExpired(now);
    const attempts: Array<Readonly<{ operationId: string; attemptId: string; target: StableDomTarget;
      text: string; expiresAt: number }>> = [];
    for (const [operationId, pending] of this.dispatchJobs) {
      if (targetProvider(pending.target) !== provider) continue;
      const operation = this.contents.get(operationId);
      if (operation?.autonomous && !includeAutonomous) continue;
      const live = operation && this.requests.getStableTarget(pending.owner, operation.connectionId, now);
      const intent = this.database.prepare("SELECT state, started_at FROM message_dispatch_attempts WHERE operation_id = ?")
        .get(operationId) as { state: string; started_at: number } | undefined;
      if (!operation || operation.owner !== pending.owner || !live || intent?.state !== "dispatching"
        || intent.started_at !== pending.startedAt || pending.startedAt > now
        || !this.sameComposerTarget(live, pending.target)) {
        this.finishFixtureDispatch(operationId);
        continue;
      }
      if (pending.issued) continue;
      const baseline = this.dispatchBaselines.get(operationId);
      const current = this.requests.getStableSnapshot(pending.owner, operation.connectionId, now);
      if (!baseline || baseline.capturedAt > now || baseline.capturedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS <= now
        || !current || current === "not_ready" || current.capturedAt > now || current.capturedAt < baseline.capturedAt
        || current.cursor.epoch !== baseline.cursor.epoch || current.cursor.sequence !== baseline.cursor.sequence) {
        this.finishFixtureDispatch(operationId);
        continue;
      }
      pending.issued = true;
      attempts.push(Object.freeze({ operationId, attemptId: operationId, target: pending.target,
        text: pending.text, expiresAt: pending.expiresAt }));
    }
    return attempts;
  }

  completeFixtureDispatch(target: StableDomTarget, operationId: string, attemptId: string,
    observation: FixtureDispatchResult, now = Date.now()): boolean {
    this.discardExpired(now);
    const pending = this.dispatchJobs.get(operationId);
    const parsed = fixtureDispatchResultSchema.safeParse(observation);
    const operation = this.contents.get(operationId);
    const live = operation && pending && this.requests.getStableTarget(pending.owner, operation.connectionId, now);
    const intent = this.database.prepare("SELECT state, started_at FROM message_dispatch_attempts WHERE operation_id = ?")
      .get(operationId) as { state: string; started_at: number } | undefined;
    if (!pending || !pending.issued || attemptId !== operationId || !parsed.success || !live || pending.startedAt > now
      || intent?.state !== "dispatching" || intent.started_at !== pending.startedAt
      || !this.sameComposerTarget(pending.target, target) || !this.sameComposerTarget(live, target)
      || (target.provider === "databag" && parsed.data.ok && parsed.data.editor !== "textarea")) return false;
    if (parsed.data.ok) this.reconcileFixtureObservation(pending.owner, operationId, now);
    this.finishFixtureDispatch(operationId);
    return true;
  }

  reconcileFixtureObservation(owner: symbol, operationId: string, now = Date.now()) {
    const status = this.getOperation(owner, operationId, now);
    if (status.state !== "dispatch_uncertain") return status;
    const operation = this.contents.get(operationId);
    const baseline = this.dispatchBaselines.get(operationId);
    const live = operation && this.requests.getStableTarget(owner, operation.connectionId, now);
    if (!operation || operation.owner !== owner || !baseline || baseline.omittedBefore || !live || this.ambiguousEvidence.has(operationId)
      || !this.sameComposerTarget(live, operation.target)) return status;
    const snapshot = this.requests.getStableSnapshot(owner, operation.connectionId, now);
    if (!snapshot || snapshot === "not_ready" || snapshot.omittedBefore
      || snapshot.capturedAt < status.startedAt || snapshot.capturedAt > now
      || snapshot.cursor.epoch !== baseline.cursor.epoch || snapshot.cursor.sequence <= baseline.cursor.sequence) return status;
    const events = this.requests.readStableEvents(owner, operation.connectionId, baseline.cursor, MAX_RETURNED_EVENTS, now);
    if (!events || events === "not_ready" || events.state !== "ok"
      || events.cursor.sequence !== snapshot.cursor.sequence) return status;
    const known = new Set(baseline.messageIds);
    const matchingIds = new Set<string>();
    for (const event of events.events) {
      const observation = fixtureObservationSchema.safeParse(event.payload);
      if (!observation.success || observation.data.omittedBefore) return status;
      for (const message of observation.data.messages) {
        if (!message.truncated && !known.has(message.id) && message.direction === "outgoing" && message.text === operation.text) {
          matchingIds.add(message.id);
        }
      }
    }
    if (matchingIds.size > 1) {
      this.ambiguousEvidence.add(operationId);
      return status;
    }
    const matches = snapshot.messages.filter((message) => !message.truncated && !known.has(message.id)
      && message.direction === "outgoing" && message.text === operation.text);
    if (matches.length > 1) this.ambiguousEvidence.add(operationId);
    if (matches.length !== 1 || !matches[0]) return status;
    this.database.prepare(`INSERT INTO message_dispatch_evidence (operation_id, observed_at, message_id)
      VALUES (?, ?, ?) ON CONFLICT (operation_id) DO NOTHING`)
      .run(operationId, snapshot.capturedAt, matches[0].id);
    return this.dispatchStatus(operationId) ?? status;
  }

  getOperation(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const ownerId = this.owners.get(owner);
    if (!ownerId) return { state: "unknown" as const };
    const record = this.database.prepare(`SELECT owner_id, connection_id, expires_at
      FROM prepared_message_operations WHERE operation_id = ?`).get(operationId) as {
        owner_id: string; connection_id: string; expires_at: number
      } | undefined;
    if (!record || record.owner_id !== ownerId) return { state: "unknown" as const };
    const dispatch = this.dispatchStatus(operationId);
    if (dispatch) return dispatch;
    if (record.expires_at <= now) return { operationId, state: "expired" as const };
    if (!this.requests.getApprovedTarget(owner, record.connection_id, now)
      && !this.requests.getGeminiTarget(owner, record.connection_id, now)
      && !this.requests.getAutonomousTarget(owner, record.connection_id, now)) {
      return { operationId, state: "stale" as const };
    }
    const retained = this.contents.get(operationId) ?? this.geminiContents.get(operationId);
    if (!retained || retained.owner !== owner) return { state: "unknown" as const };
    for (const [attemptId, pending] of this.fillChecks) {
      if (pending.operationId === operationId && pending.expiresAt <= now) this.finishFillCheck(attemptId, null, now);
    }
    const approval = this.approvals.get(operationId);
    const fillConsent = this.fillApprovals.get(operationId);
    const draftFill = this.fillStates.get(operationId)
      ?? (fillConsent ? Object.freeze({ state: "fill_approved" as const, expiresAt: fillConsent.expiresAt }) : undefined);
    const fill = draftFill ? { draftFill } : {};
    if (retained.autonomous) return this.getAutonomousAuthorization(owner, operationId, now)
      ? { operationId, state: "prepared" as const, expiresAt: record.expires_at, ...fill }
      : { operationId, state: "stale" as const };
    return approval
      ? { operationId, state: "approved" as const, expiresAt: record.expires_at,
        approvalExpiresAt: approval.expiresAt, ...fill }
      : { operationId, state: "awaiting_approval" as const, expiresAt: record.expires_at, ...fill };
  }

  disconnect(owner: symbol): void {
    this.owners.delete(owner);
    for (const [operationId, operation] of this.contents) {
      if (operation.owner === owner) this.release(operationId);
    }
    for (const [operationId, operation] of this.geminiContents) {
      if (operation.owner === owner) this.release(operationId);
    }
  }
}