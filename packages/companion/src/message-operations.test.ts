import assert from "node:assert/strict";
import { chmod, lstat, readFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MAX_ACTIVE_PREPARED_MESSAGES, MAX_PREPARED_MESSAGE_BYTES,
  MAX_PREPARED_REVIEWS, MAX_RECORDED_PREPARED_MESSAGES, openPrivateOperationDatabase, PreparedMessageOperations,
  PREPARED_KEY_RETENTION_MS, PREPARED_MESSAGE_TTL_MS, FIXTURE_REVIEW_APPROVAL_TTL_MS }
  from "./message-operations.js";
import { PendingConnectionRequests } from "./pending-connections.js";

test("fixture preparation persists no text and cannot dispatch without a trusted approval path", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-prepare-"));
  const path = join(home, "operations.sqlite");
  let database = openPrivateOperationDatabase(home);
  try {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    assert.throws(() => openPrivateOperationDatabase(home), /database must be owned by this user and private/);
    await chmod(path, 0o600);
    const linkedDirectory = join(home, "linked-directory");
    await symlink(home, linkedDirectory);
    assert.throws(() => openPrivateOperationDatabase(linkedDirectory), /directory must be owned by this user and private/);
    const requests = new PendingConnectionRequests();
    const owner = Symbol("MCP owner");
    const stranger = Symbol("other MCP client");
    const pending = requests.create(owner, 1000);
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const ledger = new PreparedMessageOperations(requests, database);
    const key = "a66b3997-9d43-4554-8399-267d1fe9f75c";
    const text = "Synthetic private prepare-only text \u00e9";
    assert.throws(() => ledger.prepare(stranger, grant.connectionId, 1, text, key, 2001), /CONNECTION_NOT_FOUND/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 2, text, key, 2001), /GENERATION_MISMATCH/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, " ", key, 2001), /INVALID_MESSAGE_TEXT/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1,
      "\u00e9".repeat(MAX_PREPARED_MESSAGE_BYTES), key, 2001), /INVALID_MESSAGE_TEXT/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, text, "not-a-uuid", 2001),
      /INVALID_IDEMPOTENCY_KEY/);
    const prepared = ledger.prepare(owner, grant.connectionId, 1, text, key, 2001);
    assert.equal(prepared.state, "awaiting_approval");
    assert.equal(prepared.preview.text, text);
    assert.equal(prepared.expiresAt, 2001 + PREPARED_MESSAGE_TTL_MS);
    assert.deepEqual(ledger.listFixtureReviews({ ...target, documentId: "other-document" }, 2002),
      { reviews: [], hasMore: false });
    const firstReview = ledger.listFixtureReviews(target, 2002);
    assert.equal(firstReview.hasMore, false);
    assert.deepEqual(firstReview.reviews.map(({ reviewId, ...preview }) => preview), [{
      operationId: prepared.operationId, expiresAt: prepared.expiresAt, preview: prepared.preview
    }]);
    assert.match(firstReview.reviews[0]!.reviewId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(ledger.prepare(owner, grant.connectionId, 1, text, key, 2002), prepared);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, `${text}!`, key, 2002), /IDEMPOTENCY_CONFLICT/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count, 1);
    assert.equal((await readFile(path)).includes(Buffer.from(text)), false);
    assert.equal((await readFile(path)).includes(Buffer.from(target.documentId)), false);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, text, key,
      prepared.expiresAt), /OPERATION_EXPIRED/);
    for (let index = 1; index <= MAX_ACTIVE_PREPARED_MESSAGES; index++) {
      ledger.prepare(owner, grant.connectionId, 1, `Fixture text ${index}`,
        `a66b3997-9d43-4554-8399-${String(index).padStart(12, "0")}`, 2002);
    }
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, "Over capacity",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2002), /TOO_MANY_PREPARED/);
    assert.equal(ledger.listFixtureReviews(target, 2002).reviews.length, MAX_PREPARED_REVIEWS);
    assert.equal(ledger.listFixtureReviews(target, 2002).hasMore, true);
    assert.equal(ledger.prepare(owner, grant.connectionId, 1, "After expiry",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", prepared.expiresAt + 1).state, "awaiting_approval");
    requests.revokeChangedTab(3, null);
    assert.deepEqual(ledger.listFixtureReviews(target, 2003), { reviews: [], hasMore: false });
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, text, key, 2003), /CONNECTION_NOT_FOUND/);
    ledger.disconnect(owner);
    database.close();
    database = openPrivateOperationDatabase(home);
    const restartedRequests = new PendingConnectionRequests();
    const restartedOwner = Symbol("fresh broker owner");
    const restartedPending = restartedRequests.create(restartedOwner, 1000);
    const restartedGrant = restartedRequests.approve(restartedPending.requestId, target, 2000)!;
    const restartedLedger = new PreparedMessageOperations(restartedRequests, database);
    assert.throws(() => restartedLedger.prepare(restartedOwner, restartedGrant.connectionId, 1, text, key, 2004),
      /OPERATION_UNAVAILABLE/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count,
      MAX_ACTIVE_PREPARED_MESSAGES + 2);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("fixture approval consumes one exact-document review token and never dispatches", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const requests = new PendingConnectionRequests();
    const ledger = new PreparedMessageOperations(requests, database);
    const owner = Symbol("fixture owner");
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic approved preview",
      "a66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    assert.deepEqual(ledger.getOperation(Symbol("other owner"), prepared.operationId, 2002), { state: "unknown" });
    assert.deepEqual(ledger.getOperation(owner, prepared.operationId, 2002), { operationId: prepared.operationId,
      state: "awaiting_approval", expiresAt: prepared.expiresAt });
    assert.throws(() => ledger.approveFixtureReview(target, prepared.operationId,
      undefined as unknown as string, 2002), /REVIEW_UNAVAILABLE/);
    const [oldReview] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(oldReview);
    assert.throws(() => ledger.approveFixtureReview(target, prepared.operationId,
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2003), /REVIEW_UNAVAILABLE/);
    assert.throws(() => ledger.approveFixtureReview({ ...target, documentId: "other-document" },
      prepared.operationId, oldReview.reviewId, 2003), /REVIEW_UNAVAILABLE/);
    const [review] = ledger.listFixtureReviews(target, 2004).reviews;
    assert.ok(review);
    assert.throws(() => ledger.approveFixtureReview(target, prepared.operationId,
      oldReview.reviewId, 2005), /REVIEW_UNAVAILABLE/);
    const approved = ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2005);
    assert.deepEqual(approved, { operationId: prepared.operationId, state: "approved", approvedAt: 2005,
      expiresAt: 2005 + FIXTURE_REVIEW_APPROVAL_TTL_MS });
    assert.deepEqual(ledger.getOperation(owner, prepared.operationId, 2006), { operationId: prepared.operationId,
      state: "approved", expiresAt: prepared.expiresAt, approvalExpiresAt: approved.expiresAt });
    assert.deepEqual(ledger.listFixtureReviews(target, 2006), { reviews: [], hasMore: false });
    assert.throws(() => ledger.approveFixtureReview(target, prepared.operationId,
      review.reviewId, 2006), /REVIEW_UNAVAILABLE/);
    assert.deepEqual(ledger.getOperation(owner, prepared.operationId, approved.expiresAt), {
      operationId: prepared.operationId, state: "awaiting_approval", expiresAt: prepared.expiresAt
    });
    const [afterExpiry] = ledger.listFixtureReviews(target, approved.expiresAt).reviews;
    assert.ok(afterExpiry);
    requests.revokeChangedTab(3, null);
    assert.deepEqual(ledger.getOperation(owner, prepared.operationId, approved.expiresAt + 1), {
      operationId: prepared.operationId, state: "stale"
    });
    assert.throws(() => ledger.approveFixtureReview(target, prepared.operationId,
      afterExpiry.reviewId, approved.expiresAt + 1), /REVIEW_UNAVAILABLE/);
    assert.deepEqual(ledger.listFixtureReviews(target, approved.expiresAt + 1), { reviews: [], hasMore: false });
    assert.deepEqual(ledger.getOperation(owner, prepared.operationId, prepared.expiresAt), {
      operationId: prepared.operationId, state: "expired"
    });
    ledger.disconnect(owner);
    assert.deepEqual(ledger.getOperation(owner, prepared.operationId, prepared.expiresAt), { state: "unknown" });
  } finally {
    database.close();
  }
});

test("expired preparation keys have bounded retention and metadata refuses excess rows", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const requests = new PendingConnectionRequests();
    const ledger = new PreparedMessageOperations(requests, database);
    const owner = Symbol("fixture owner");
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const firstPending = requests.create(owner, 1000);
    const firstGrant = requests.approve(firstPending.requestId, target, 2000)!;
    const key = "a66b3997-9d43-4554-8399-267d1fe9f75c";
    const first = ledger.prepare(owner, firstGrant.connectionId, 1, "Synthetic", key, 2001);
    assert.throws(() => ledger.prepare(owner, firstGrant.connectionId, 1, "Synthetic", key,
      first.expiresAt + 1), /OPERATION_EXPIRED/);

    const later = first.expiresAt + PREPARED_KEY_RETENTION_MS + 1;
    const laterPending = requests.create(owner, later - 2);
    const laterGrant = requests.approve(laterPending.requestId, target, later - 1)!;
    assert.equal(ledger.prepare(owner, laterGrant.connectionId, 1, "New draft", key, later).state,
      "awaiting_approval");
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count, 1);
    database.prepare(`WITH RECURSIVE sequence(number) AS (
      SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < ?
    ) INSERT INTO prepared_message_operations
      (operation_id, owner_id, connection_id, idempotency_key, content_digest, target_digest, expires_at, state)
    SELECT 'seed-' || number, 'other-owner', 'other-connection', 'seed-key-' || number,
      'content-digest', 'target-digest', ?, 'awaiting_approval' FROM sequence`)
      .run(MAX_RECORDED_PREPARED_MESSAGES - 1, later + PREPARED_MESSAGE_TTL_MS);
    assert.throws(() => ledger.prepare(owner, laterGrant.connectionId, 1, "Another draft",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", later + 1), /TOO_MANY_PREPARED/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count,
      MAX_RECORDED_PREPARED_MESSAGES);
  } finally {
    database.close();
  }
});