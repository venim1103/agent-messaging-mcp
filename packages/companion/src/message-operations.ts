import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PendingConnectionRequests, type FixtureTarget } from "./pending-connections.js";

export const PREPARED_MESSAGE_TTL_MS = 60_000;
export const FIXTURE_REVIEW_APPROVAL_TTL_MS = 30_000;
export const PREPARED_KEY_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_PREPARED_MESSAGE_BYTES = 4_000;
export const MAX_ACTIVE_PREPARED_MESSAGES = 100;
export const MAX_RECORDED_PREPARED_MESSAGES = 10_000;
export const MAX_PREPARED_REVIEWS = 8;

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

type PreparedMessage = Readonly<{
  operationId: string;
  connectionId: string;
  state: "awaiting_approval";
  expiresAt: number;
  preview: Readonly<{ target: "fixture-alpha"; text: string }>;
}>;
type PreparedReview = Readonly<Pick<PreparedMessage, "operationId" | "expiresAt" | "preview"> & {
  reviewId: string
}>;

export class PreparedMessageOperations {
  private readonly owners = new Map<symbol, string>();
  private readonly contents = new Map<string, Readonly<{
    owner: symbol; connectionId: string; target: FixtureTarget; text: string; expiresAt: number
  }>>();
  private readonly reviewTokens = new Map<string, string>();
  private readonly approvals = new Map<string, Readonly<{ approvedAt: number; expiresAt: number }>>();
  private readonly digestKey = randomBytes(32);

  constructor(private readonly requests: PendingConnectionRequests, private readonly database: DatabaseSync) {
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
  }

  private digest(value: string): string {
    return createHmac("sha256", this.digestKey).update(value).digest("hex");
  }

  private release(operationId: string): void {
    this.contents.delete(operationId);
    this.reviewTokens.delete(operationId);
    this.approvals.delete(operationId);
  }

  private discardExpired(now: number): void {
    for (const [operationId, operation] of this.contents) {
      if (operation.expiresAt <= now) this.release(operationId);
    }
    for (const [operationId, approval] of this.approvals) {
      if (approval.expiresAt <= now) this.approvals.delete(operationId);
    }
  }

  prepare(owner: symbol, connectionId: string, expectedGeneration: number,
    text: string, idempotencyKey: string, now = Date.now()): PreparedMessage {
    this.discardExpired(now);
    const target = this.requests.getApprovedTarget(owner, connectionId, now);
    if (!target) throw new Error("CONNECTION_NOT_FOUND");
    if (expectedGeneration !== 1) throw new Error("GENERATION_MISMATCH");
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > MAX_PREPARED_MESSAGE_BYTES) {
      throw new Error("INVALID_MESSAGE_TEXT");
    }
    if (typeof idempotencyKey !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
      throw new Error("INVALID_IDEMPOTENCY_KEY");
    }

    this.database.prepare("DELETE FROM prepared_message_operations WHERE expires_at <= ?")
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
      if (existing.expires_at <= now) throw new Error("OPERATION_EXPIRED");
      const retained = this.contents.get(existing.operation_id);
      if (!retained || retained.owner !== owner) throw new Error("OPERATION_UNAVAILABLE");
      return Object.freeze({ operationId: existing.operation_id, connectionId, state: "awaiting_approval",
        expiresAt: existing.expires_at, preview: Object.freeze({ target: "fixture-alpha", text: retained.text }) });
    }

    if (this.contents.size >= MAX_ACTIVE_PREPARED_MESSAGES) throw new Error("TOO_MANY_PREPARED");
    const recorded = this.database.prepare("SELECT count(*) AS count FROM prepared_message_operations")
      .get() as { count: number };
    if (recorded.count >= MAX_RECORDED_PREPARED_MESSAGES) throw new Error("TOO_MANY_PREPARED");
    const operationId = randomUUID();
    const expiresAt = now + PREPARED_MESSAGE_TTL_MS;
    this.database.prepare(`INSERT INTO prepared_message_operations
      (operation_id, owner_id, connection_id, idempotency_key, content_digest, target_digest, expires_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval')`)
      .run(operationId, ownerId, connectionId, idempotencyKey, contentDigest, targetDigest, expiresAt);
    this.contents.set(operationId, Object.freeze({ owner, connectionId, target, text, expiresAt }));
    return Object.freeze({ operationId, connectionId, state: "awaiting_approval", expiresAt,
      preview: Object.freeze({ target: "fixture-alpha", text }) });
  }

  listFixtureReviews(target: FixtureTarget, now = Date.now()): Readonly<{
    reviews: ReadonlyArray<PreparedReview>; hasMore: boolean
  }> {
    this.discardExpired(now);
    const reviews: Omit<PreparedReview, "reviewId">[] = [];
    for (const [operationId, operation] of this.contents) {
      if (this.approvals.has(operationId)) continue;
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

  getOperation(owner: symbol, operationId: string, now = Date.now()) {
    this.discardExpired(now);
    const ownerId = this.owners.get(owner);
    if (!ownerId) return { state: "unknown" as const };
    const record = this.database.prepare(`SELECT owner_id, connection_id, expires_at
      FROM prepared_message_operations WHERE operation_id = ?`).get(operationId) as {
        owner_id: string; connection_id: string; expires_at: number
      } | undefined;
    if (!record || record.owner_id !== ownerId) return { state: "unknown" as const };
    if (record.expires_at <= now) return { operationId, state: "expired" as const };
    if (!this.requests.getApprovedTarget(owner, record.connection_id, now)) {
      return { operationId, state: "stale" as const };
    }
    const retained = this.contents.get(operationId);
    if (!retained || retained.owner !== owner) return { state: "unknown" as const };
    const approval = this.approvals.get(operationId);
    return approval
      ? { operationId, state: "approved" as const, expiresAt: record.expires_at,
        approvalExpiresAt: approval.expiresAt }
      : { operationId, state: "awaiting_approval" as const, expiresAt: record.expires_at };
  }

  disconnect(owner: symbol): void {
    this.owners.delete(owner);
    for (const [operationId, operation] of this.contents) {
      if (operation.owner === owner) this.release(operationId);
    }
  }
}