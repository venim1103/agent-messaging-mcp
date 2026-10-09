import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod/v4";
import { MAX_RETURNED_EVENTS } from "./observation-buffer.js";
import { MAX_FIXTURE_SNAPSHOT_MESSAGES, PendingConnectionRequests, type ApprovedTarget, type FixtureTarget, type GeminiTarget } from "./pending-connections.js";

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
export const fixtureDispatchResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), editor: z.enum(["textarea", "rich"]), activated: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["TARGET_CHANGED", "COMPOSER_UNAVAILABLE",
    "DRAFT_CHANGED", "SUBMIT_UNAVAILABLE", "DISPATCH_UNAVAILABLE", "DISPATCH_UNCERTAIN"]) })
]);
export type FixtureDispatchResult = z.infer<typeof fixtureDispatchResultSchema>;
export const fixtureDispatchStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({ operationId: z.uuid(), state: z.literal("dispatch_uncertain"), startedAt: z.number().int().safe() }),
  z.strictObject({ operationId: z.uuid(), state: z.literal("observed_in_ui"), startedAt: z.number().int().safe(),
    observedAt: z.number().int().safe(), messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })
]);
export const fixtureDispatchCheckResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), editor: z.enum(["textarea", "rich"]),
    draftText: z.string().max(2048), selected: z.literal(true), writable: z.literal(true),
    submitReady: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["TARGET_CHANGED", "COMPOSER_UNAVAILABLE",
    "DRAFT_CHANGED", "SUBMIT_UNAVAILABLE"]) })
]);
export type FixtureDispatchCheckResult = z.infer<typeof fixtureDispatchCheckResultSchema>;
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
  messages: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    direction: z.enum(["incoming", "outgoing"]), text: z.string().max(2048)
  })).max(MAX_FIXTURE_SNAPSHOT_MESSAGES)
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

type PreparedMessage<TargetLabel extends "fixture-alpha" | "gemini" = "fixture-alpha"> = Readonly<{
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
}>;
type FixtureDispatchCheck = Readonly<{
  checkId: string; owner: symbol; target: FixtureTarget; text: string; createdAt: number; expiresAt: number;
  baseline: FixtureDispatchBaseline; checkedAt: number | null
}>;
type FixtureDispatchAuthorization = Readonly<{
  owner: symbol; operationId: string; target: FixtureTarget; text: string; startedAt: number; expiresAt: number
}>;
type FixtureDispatchStatus = Readonly<z.infer<typeof fixtureDispatchStatusSchema>>;
type FixturePreflightStatus = z.infer<typeof fixturePreflightStatusSchema>;
type PendingFixturePreflight = {
  owner: symbol; operationId: string; target: FixtureTarget; text: string; expiresAt: number;
  timer: ReturnType<typeof setTimeout>; resolve: (status: FixturePreflightStatus | null) => void
};
type FixtureFillStatus = z.infer<typeof fixtureFillStatusSchema>;
type FixtureDraftFillState = z.infer<typeof fixtureDraftFillStateSchema>;
type PendingFixtureFill = {
  owner: symbol; operationId: string; target: FixtureTarget; text: string; expiresAt: number;
  timer: ReturnType<typeof setTimeout>; resolve: (status: FixtureFillStatus | null) => void
};
type GeminiFillStatus = z.infer<typeof geminiFillStatusSchema>;
type PendingGeminiFill = {
  owner: symbol; operationId: string; target: GeminiTarget; text: string; expiresAt: number; issued: boolean;
  timer: ReturnType<typeof setTimeout>; resolve: (status: GeminiFillStatus | null) => void
};
type PendingFixtureDispatch = {
  owner: symbol; operationId: string; target: FixtureTarget; text: string; expiresAt: number; startedAt: number;
  issued: boolean; timer: ReturnType<typeof setTimeout>; resolve: (status: FixtureDispatchStatus) => void
};

export class PreparedMessageOperations {
  private readonly owners = new Map<symbol, string>();
  private readonly contents = new Map<string, Readonly<{
    owner: symbol; connectionId: string; target: FixtureTarget; text: string; expiresAt: number
  }>>();
  private readonly geminiContents = new Map<string, Readonly<{
    owner: symbol; connectionId: string; target: GeminiTarget; text: string; expiresAt: number
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
  private readonly dispatchChecks = new Map<string, FixtureDispatchCheck>();
  private readonly dispatchInspections = new Map<string, {
    timer: ReturnType<typeof setTimeout>; resolve: (ready: boolean) => void
  }>();
  private readonly dispatchAuthorizations = new Map<string, FixtureDispatchAuthorization>();
  private readonly dispatchJobs = new Map<string, PendingFixtureDispatch>();
  private readonly ambiguousEvidence = new Set<string>();
  private readonly preflightChecks = new Map<string, PendingFixturePreflight>();
  private readonly fillChecks = new Map<string, PendingFixtureFill>();
  private readonly geminiFillChecks = new Map<string, PendingGeminiFill>();
  private readonly digestKey = randomBytes(32);

  constructor(private readonly requests: PendingConnectionRequests, private readonly database: DatabaseSync) {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
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
      state TEXT NOT NULL CHECK (state IN ('dispatching', 'unknown'))
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS message_dispatch_evidence (
      operation_id TEXT PRIMARY KEY REFERENCES message_dispatch_attempts(operation_id) ON DELETE RESTRICT,
      observed_at INTEGER NOT NULL,
      message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 128)
    )`);
    database.exec("UPDATE message_dispatch_attempts SET state = 'unknown' WHERE state = 'dispatching'");
  }

  private dispatchStatus(operationId: string): FixtureDispatchStatus | null {
    const record = this.database.prepare(`SELECT attempt.started_at, evidence.observed_at, evidence.message_id
      FROM message_dispatch_attempts AS attempt
      LEFT JOIN message_dispatch_evidence AS evidence ON evidence.operation_id = attempt.operation_id
      WHERE attempt.operation_id = ?`).get(operationId) as {
        started_at: number; observed_at: number | null; message_id: string | null
      } | undefined;
    if (!record) return null;
    return record.observed_at !== null && record.message_id !== null
      ? { operationId, state: "observed_in_ui", startedAt: record.started_at,
        observedAt: record.observed_at, messageId: record.message_id }
      : { operationId, state: "dispatch_uncertain", startedAt: record.started_at };
  }

  private digest(value: string): string {
    return createHmac("sha256", this.digestKey).update(value).digest("hex");
  }

  private release(operationId: string): void {
    this.finishFixtureDispatch(operationId);
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
    this.discardFixtureDispatchCheck(operationId);
    this.dispatchAuthorizations.delete(operationId);
    this.ambiguousEvidence.delete(operationId);
  }

  private discardExpired(now: number): void {
    for (const [operationId, pending] of this.dispatchJobs) {
      if (pending.expiresAt <= now) this.finishFixtureDispatch(operationId);
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

  private prepareBound<TargetLabel extends "fixture-alpha" | "gemini">(owner: symbol, connectionId: string,
    expectedGeneration: number, target: ApprovedTarget, label: TargetLabel, text: string,
    idempotencyKey: string, now: number): PreparedMessage<TargetLabel> {
    if (expectedGeneration !== 1) throw new Error("GENERATION_MISMATCH");
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_PREPARED_MESSAGE_BYTES || !text.trim()) {
      throw new Error("INVALID_MESSAGE_TEXT");
    }
    if (target.origin === "https://gemini.google.com"
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
    const targetDigest = this.digest(JSON.stringify({ connectionId, expectedGeneration, target }));
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
    const expiresAt = now + PREPARED_MESSAGE_TTL_MS;
    this.database.prepare(`INSERT INTO prepared_message_operations
      (operation_id, owner_id, connection_id, idempotency_key, content_digest, target_digest, expires_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval')`)
      .run(operationId, ownerId, connectionId, idempotencyKey, contentDigest, targetDigest, expiresAt);
    if (target.origin === "https://gemini.google.com") {
      this.geminiContents.set(operationId, Object.freeze({ owner, connectionId, target, text, expiresAt }));
    } else {
      this.contents.set(operationId, Object.freeze({ owner, connectionId, target, text, expiresAt }));
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
      if (this.approvals.has(operationId) || this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?")
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

  getGeminiFillAuthorization(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.geminiContents.get(operationId);
    const live = operation && this.requests.getGeminiTarget(owner, operation.connectionId, now);
    const consent = this.fillApprovals.get(operationId);
    if (!operation || operation.owner !== owner || !live || !this.sameGeminiTarget(operation.target, live)
      || !consent || consent.expiresAt <= now || this.consumedFillApprovals.has(operationId)
      || this.getOperation(owner, operationId, now).state !== "approved") return null;
    return Object.freeze({ operationId, target: operation.target, text: operation.text, expiresAt: consent.expiresAt });
  }

  consumeGeminiFillApproval(owner: symbol, operationId: string, now = Date.now()) {
    const authorization = this.getGeminiFillAuthorization(owner, operationId, now);
    if (!authorization || this.database.prepare(`SELECT 1 FROM message_dispatch_attempts AS attempt
      LEFT JOIN message_dispatch_evidence AS evidence ON evidence.operation_id = attempt.operation_id
      WHERE evidence.operation_id IS NULL LIMIT 1`).get()) return null;
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
    const blocked = this.database.prepare(`SELECT 1 FROM message_dispatch_attempts AS attempt
      LEFT JOIN message_dispatch_evidence AS evidence ON evidence.operation_id = attempt.operation_id
      WHERE evidence.operation_id IS NULL LIMIT 1`).get();
    for (const [attemptId, pending] of this.geminiFillChecks) {
      const operation = this.geminiContents.get(pending.operationId);
      const live = operation && this.requests.getGeminiTarget(pending.owner, operation.connectionId, now);
      const approval = this.approvals.get(pending.operationId);
      if (blocked || pending.expiresAt <= now || !operation || operation.owner !== pending.owner
        || !approval || approval.expiresAt <= now || !live || !this.sameGeminiTarget(pending.target, live)) {
        this.finishGeminiFillCheck(attemptId, null, now);
      }
    }
  }

  requestGeminiFill(owner: symbol, operationId: string, now = Date.now(), deadlineMs = now + FIXTURE_FILL_TIMEOUT_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) return null;
    const authorization = this.getGeminiFillAuthorization(owner, operationId, now);
    const operation = this.geminiContents.get(operationId);
    const grantExpiresAt = operation && this.requests.getConnectionExpiresAt(owner, operation.connectionId, now);
    if (!authorization || !grantExpiresAt) return null;
    this.listFixtureFillChallenges(now);
    if (this.fillChecks.size + this.geminiFillChecks.size >= MAX_PENDING_FIXTURE_FILLS) return "busy" as const;
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

  listGeminiFillChallenges(now = Date.now()) {
    this.discardExpired(now);
    return [...this.geminiFillChecks].filter(([, pending]) => !pending.issued).map(([attemptId, pending]) => {
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
      if (this.approvals.has(operationId)) continue;
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
    const consent = this.fillApprovals.get(operationId);
    if (!operation || operation.owner !== owner || !consent || consent.expiresAt <= now
      || this.consumedFillApprovals.has(operationId) || this.getOperation(owner, operationId, now).state !== "approved") {
      return null;
    }
    return Object.freeze({ operationId, target: operation.target, text: operation.text, expiresAt: consent.expiresAt });
  }

  consumeFixtureFillApproval(owner: symbol, operationId: string, now = Date.now()) {
    const authorization = this.getFixtureFillAuthorization(owner, operationId, now);
    if (!authorization || this.database.prepare(`SELECT 1 FROM message_dispatch_attempts AS attempt
      LEFT JOIN message_dispatch_evidence AS evidence ON evidence.operation_id = attempt.operation_id
      WHERE evidence.operation_id IS NULL LIMIT 1`).get()) return null;
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

  requestFixtureFill(owner: symbol, operationId: string, now = Date.now()) {
    if (!this.getFixtureFillAuthorization(owner, operationId, now)) return null;
    this.listFixtureFillChallenges(now);
    if (this.fillChecks.size + this.geminiFillChecks.size >= MAX_PENDING_FIXTURE_FILLS) return "busy" as const;
    const authorization = this.consumeFixtureFillApproval(owner, operationId, now);
    if (!authorization) return null;
    const attemptId = randomUUID();
    const expiresAt = Math.min(authorization.expiresAt, now + FIXTURE_FILL_TIMEOUT_MS);
    let resolve!: PendingFixtureFill["resolve"];
    const result = new Promise<FixtureFillStatus | null>((done) => { resolve = done; });
    const timer = setTimeout(() => this.finishFillCheck(attemptId, null), expiresAt - now);
    this.fillChecks.set(attemptId, { owner, operationId, target: authorization.target,
      text: authorization.text, expiresAt, timer, resolve });
    this.fillStates.set(operationId, Object.freeze({ state: "filling", startedAt: now, expiresAt }));
    return { attemptId, result };
  }

  listFixtureFillChallenges(now = Date.now()) {
    for (const [attemptId, pending] of this.fillChecks) {
      if (pending.expiresAt <= now || this.getOperation(pending.owner, pending.operationId, now).state !== "approved") {
        this.finishFillCheck(attemptId, null, now);
      }
    }
    return [...this.fillChecks].map(([attemptId, pending]) => Object.freeze({
      attemptId, operationId: pending.operationId, target: pending.target, text: pending.text, expiresAt: pending.expiresAt
    }));
  }

  completeFixtureFill(target: FixtureTarget, attemptId: string, observation: FixtureFillResult,
    now = Date.now()): boolean {
    const parsed = fixtureFillResultSchema.safeParse(observation);
    const pending = this.fillChecks.get(attemptId);
    if (!parsed.success || !pending || pending.expiresAt <= now
      || pending.target.origin !== target.origin || pending.target.conversationId !== target.conversationId
      || pending.target.tabId !== target.tabId || pending.target.documentId !== target.documentId
      || this.getOperation(pending.owner, pending.operationId, now).state !== "approved") return false;
    this.finishFillCheck(attemptId, { ...parsed.data, operationId: pending.operationId, completedAt: now });
    return true;
  }

  recordFixtureDispatchBaseline(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const operation = this.contents.get(operationId);
    const approval = this.approvals.get(operationId);
    const live = operation && this.requests.getApprovedTarget(owner, operation.connectionId, now);
    if (!operation || operation.owner !== owner || !approval || approval.expiresAt <= now || !live
      || live.origin !== operation.target.origin || live.conversationId !== operation.target.conversationId
      || live.tabId !== operation.target.tabId || live.documentId !== operation.target.documentId
      || this.database.prepare("SELECT 1 FROM message_dispatch_attempts WHERE operation_id = ?").get(operationId)) {
      throw new Error("APPROVAL_REQUIRED");
    }
    const snapshot = this.requests.getFixtureSnapshot(owner, operation.connectionId, now);
    if (!snapshot || snapshot === "not_ready" || snapshot.capturedAt > now) throw new Error("OBSERVATION_UNAVAILABLE");
    const baseline = Object.freeze({ capturedAt: snapshot.capturedAt, cursor: snapshot.cursor,
      messageIds: Object.freeze(snapshot.messages.map((message) => message.id)) });
    this.dispatchBaselines.set(operationId, baseline);
    this.discardFixtureDispatchCheck(operationId);
    return Object.freeze({ operationId, capturedAt: baseline.capturedAt, cursor: baseline.cursor });
  }

  private freshDispatchBaseline(owner: symbol, operationId: string, now: number) {
    const operation = this.contents.get(operationId);
    const consent = this.sendApprovals.get(operationId);
    const baseline = this.dispatchBaselines.get(operationId);
    const current = operation && this.requests.getFixtureSnapshot(owner, operation.connectionId, now);
    if (!consent || !baseline || baseline.capturedAt < consent.approvedAt || baseline.capturedAt > now
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
    if (!this.dispatchChecks.has(operationId) && this.dispatchChecks.size >= MAX_PENDING_FIXTURE_DISPATCH_CHECKS) {
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

  listFixtureDispatchChecks(now = Date.now()) {
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
    return [...this.dispatchChecks].filter(([, check]) => check.checkedAt === null)
      .map(([operationId, check]) => Object.freeze({ operationId, checkId: check.checkId,
        target: check.target, text: check.text, expiresAt: check.expiresAt }));
  }

  completeFixtureDispatchCheck(target: FixtureTarget, operationId: string, checkId: string,
    observation: FixtureDispatchCheckResult, now = Date.now()): boolean {
    this.discardExpired(now);
    const check = this.dispatchChecks.get(operationId);
    const parsed = fixtureDispatchCheckResultSchema.safeParse(observation);
    if (!check || check.checkId !== checkId || check.checkedAt !== null || check.createdAt > now
      || check.expiresAt <= now || !parsed.success
      || check.target.origin !== target.origin || check.target.conversationId !== target.conversationId
      || check.target.tabId !== target.tabId || check.target.documentId !== target.documentId) return false;
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
    const live = operation && this.requests.getApprovedTarget(owner, operation.connectionId, now);
    if (!operation || operation.owner !== owner || !approval || approval.expiresAt <= now || !live
      || live.origin !== operation.target.origin || live.conversationId !== operation.target.conversationId
      || live.tabId !== operation.target.tabId || live.documentId !== operation.target.documentId) {
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
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.database.prepare(`SELECT 1 FROM message_dispatch_attempts AS attempt
        LEFT JOIN message_dispatch_evidence AS evidence ON evidence.operation_id = attempt.operation_id
        WHERE evidence.operation_id IS NULL LIMIT 1`).get()) {
        throw new Error("DISPATCH_UNCERTAIN");
      }
      this.database.prepare(`INSERT INTO message_dispatch_attempts (operation_id, started_at, state)
        VALUES (?, ?, 'dispatching')`).run(operationId, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
    const live = operation && this.requests.getApprovedTarget(owner, operation.connectionId, now);
    const baseline = this.dispatchBaselines.get(operationId);
    const current = operation && this.requests.getFixtureSnapshot(owner, operation.connectionId, now);
    const intent = this.database.prepare("SELECT started_at, state FROM message_dispatch_attempts WHERE operation_id = ?")
      .get(operationId) as { started_at: number; state: string } | undefined;
    if (!live || live.origin !== authorization.target.origin || live.conversationId !== authorization.target.conversationId
      || live.tabId !== authorization.target.tabId || live.documentId !== authorization.target.documentId
      || authorization.startedAt > now || authorization.expiresAt <= now
      || intent?.state !== "dispatching" || intent.started_at !== authorization.startedAt
      || !baseline || baseline.capturedAt > now || baseline.capturedAt + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS <= now
      || !current || current === "not_ready" || current.capturedAt > now || current.capturedAt < baseline.capturedAt
      || current.cursor.epoch !== baseline.cursor.epoch || current.cursor.sequence !== baseline.cursor.sequence
      || this.database.prepare("SELECT 1 FROM message_dispatch_evidence WHERE operation_id = ?").get(operationId)) return null;
    return Object.freeze({ operationId, attemptId: operationId, target: authorization.target,
      text: authorization.text, expiresAt: authorization.expiresAt });
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
    const now = Date.now();
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) throw new Error("DISPATCH_UNAVAILABLE");
    const status = this.getOperation(owner, operationId, now);
    if (status.state === "dispatch_uncertain" || status.state === "observed_in_ui") return status;
    const authorization = this.getFixtureSendAuthorization(owner, operationId, now);
    const operation = this.contents.get(operationId);
    if (!authorization || !operation || operation.owner !== owner) throw new Error("DISPATCH_UNAVAILABLE");
    const expiresAt = Math.min(deadlineMs, authorization.expiresAt);
    const reading = this.requests.requestFreshFixtureRead(owner, operation.connectionId, now, expiresAt);
    if (!reading || reading === "busy") throw new Error("DISPATCH_UNAVAILABLE");
    const snapshot = await reading.result;
    if (!snapshot || snapshot === "not_ready" || expiresAt <= Date.now()) throw new Error("DISPATCH_UNAVAILABLE");
    const inspecting = this.requestFixtureDispatchInspection(owner, operationId, Date.now(), expiresAt);
    if (inspecting === "busy" || !await inspecting.result || expiresAt <= Date.now()) throw new Error("DISPATCH_UNAVAILABLE");
    return this.requestFixtureDispatch(owner, operationId, inspecting.checkId, Date.now(), expiresAt).result;
  }

  requestFixtureDispatch(owner: symbol, operationId: string, checkId: string, now = Date.now(),
    deadlineMs = now + FIXTURE_DISPATCH_CHECK_TIMEOUT_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) throw new Error("DISPATCH_UNAVAILABLE");
    const status = this.getOperation(owner, operationId, now);
    if (status.state === "dispatch_uncertain" || status.state === "observed_in_ui") throw new Error("DISPATCH_UNCERTAIN");
    if (status.state !== "approved") throw new Error("APPROVAL_REQUIRED");
    if (this.dispatchJobs.size >= MAX_PENDING_FIXTURE_DISPATCHES) throw new Error("DISPATCH_CHECK_BUSY");
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

  listFixtureDispatchAttempts(now = Date.now()) {
    this.discardExpired(now);
    const attempts: Array<Readonly<{ operationId: string; attemptId: string; target: FixtureTarget;
      text: string; expiresAt: number }>> = [];
    for (const [operationId, pending] of this.dispatchJobs) {
      const operation = this.contents.get(operationId);
      const live = operation && this.requests.getApprovedTarget(pending.owner, operation.connectionId, now);
      const intent = this.database.prepare("SELECT state, started_at FROM message_dispatch_attempts WHERE operation_id = ?")
        .get(operationId) as { state: string; started_at: number } | undefined;
      if (!operation || operation.owner !== pending.owner || !live || intent?.state !== "dispatching"
        || intent.started_at !== pending.startedAt || pending.startedAt > now
        || live.origin !== pending.target.origin || live.conversationId !== pending.target.conversationId
        || live.tabId !== pending.target.tabId || live.documentId !== pending.target.documentId) {
        this.finishFixtureDispatch(operationId);
        continue;
      }
      if (pending.issued) continue;
      const baseline = this.dispatchBaselines.get(operationId);
      const current = this.requests.getFixtureSnapshot(pending.owner, operation.connectionId, now);
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

  completeFixtureDispatch(target: FixtureTarget, operationId: string, attemptId: string,
    observation: FixtureDispatchResult, now = Date.now()): boolean {
    this.discardExpired(now);
    const pending = this.dispatchJobs.get(operationId);
    const parsed = fixtureDispatchResultSchema.safeParse(observation);
    const operation = this.contents.get(operationId);
    const live = operation && pending && this.requests.getApprovedTarget(pending.owner, operation.connectionId, now);
    const intent = this.database.prepare("SELECT state, started_at FROM message_dispatch_attempts WHERE operation_id = ?")
      .get(operationId) as { state: string; started_at: number } | undefined;
    if (!pending || !pending.issued || attemptId !== operationId || !parsed.success || !live || pending.startedAt > now
      || intent?.state !== "dispatching" || intent.started_at !== pending.startedAt
      || pending.target.origin !== target.origin || pending.target.conversationId !== target.conversationId
      || pending.target.tabId !== target.tabId || pending.target.documentId !== target.documentId
      || live.origin !== target.origin || live.conversationId !== target.conversationId
      || live.tabId !== target.tabId || live.documentId !== target.documentId) return false;
    if (parsed.data.ok) this.reconcileFixtureObservation(pending.owner, operationId, now);
    this.finishFixtureDispatch(operationId);
    return true;
  }

  reconcileFixtureObservation(owner: symbol, operationId: string, now = Date.now()) {
    const status = this.getOperation(owner, operationId, now);
    if (status.state !== "dispatch_uncertain") return status;
    const operation = this.contents.get(operationId);
    const baseline = this.dispatchBaselines.get(operationId);
    const live = operation && this.requests.getApprovedTarget(owner, operation.connectionId, now);
    if (!operation || operation.owner !== owner || !baseline || !live || this.ambiguousEvidence.has(operationId)
      || live.origin !== operation.target.origin || live.conversationId !== operation.target.conversationId
      || live.tabId !== operation.target.tabId || live.documentId !== operation.target.documentId) return status;
    const snapshot = this.requests.getFixtureSnapshot(owner, operation.connectionId, now);
    if (!snapshot || snapshot === "not_ready" || snapshot.capturedAt < status.startedAt || snapshot.capturedAt > now
      || snapshot.cursor.epoch !== baseline.cursor.epoch || snapshot.cursor.sequence <= baseline.cursor.sequence) return status;
    const events = this.requests.readFixtureEvents(owner, operation.connectionId, baseline.cursor, MAX_RETURNED_EVENTS, now);
    if (!events || events === "not_ready" || events.state !== "ok"
      || events.cursor.sequence !== snapshot.cursor.sequence) return status;
    const known = new Set(baseline.messageIds);
    const matchingIds = new Set<string>();
    for (const event of events.events) {
      const observation = fixtureObservationSchema.safeParse(event.payload);
      if (!observation.success) return status;
      for (const message of observation.data.messages) {
        if (!known.has(message.id) && message.direction === "outgoing" && message.text === operation.text) {
          matchingIds.add(message.id);
        }
      }
    }
    if (matchingIds.size > 1) {
      this.ambiguousEvidence.add(operationId);
      return status;
    }
    const matches = snapshot.messages.filter((message) => !known.has(message.id)
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
      && !this.requests.getGeminiTarget(owner, record.connection_id, now)) {
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