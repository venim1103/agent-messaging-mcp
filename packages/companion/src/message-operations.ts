import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PendingConnectionRequests, type FixtureTarget } from "./pending-connections.js";

export const PREPARED_MESSAGE_TTL_MS = 60_000;
export const MAX_PREPARED_MESSAGE_BYTES = 4_000;
export const MAX_ACTIVE_PREPARED_MESSAGES = 100;

type PreparedMessage = Readonly<{
  operationId: string;
  connectionId: string;
  state: "awaiting_approval";
  expiresAt: number;
  preview: Readonly<{ target: "fixture-alpha"; text: string }>;
}>;

export class PreparedMessageOperations {
  private readonly owners = new Map<symbol, string>();
  private readonly contents = new Map<string, Readonly<{
    owner: symbol; target: FixtureTarget; text: string; expiresAt: number
  }>>();
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

  private discardExpired(now: number): void {
    for (const [operationId, operation] of this.contents) {
      if (operation.expiresAt <= now) this.contents.delete(operationId);
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
    const operationId = randomUUID();
    const expiresAt = now + PREPARED_MESSAGE_TTL_MS;
    this.database.prepare(`INSERT INTO prepared_message_operations
      (operation_id, owner_id, connection_id, idempotency_key, content_digest, target_digest, expires_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval')`)
      .run(operationId, ownerId, connectionId, idempotencyKey, contentDigest, targetDigest, expiresAt);
    this.contents.set(operationId, Object.freeze({ owner, target, text, expiresAt }));
    return Object.freeze({ operationId, connectionId, state: "awaiting_approval", expiresAt,
      preview: Object.freeze({ target: "fixture-alpha", text }) });
  }

  disconnect(owner: symbol): void {
    this.owners.delete(owner);
    for (const [operationId, operation] of this.contents) {
      if (operation.owner === owner) this.contents.delete(operationId);
    }
  }
}