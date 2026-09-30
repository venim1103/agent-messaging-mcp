import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, readFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MAX_ACTIVE_PREPARED_MESSAGES, MAX_PREPARED_MESSAGE_BYTES,
  MAX_PREPARED_REVIEWS, MAX_RECORDED_PREPARED_MESSAGES, openPrivateOperationDatabase, PreparedMessageOperations,
  PREPARED_KEY_RETENTION_MS, PREPARED_MESSAGE_TTL_MS, FIXTURE_REVIEW_APPROVAL_TTL_MS,
  FIXTURE_PREFLIGHT_TIMEOUT_MS, MAX_PENDING_FIXTURE_PREFLIGHTS }
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
    ledger.createRecoveryReceipt(owner, first.operationId, 2002);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_operation_recovery").get()?.count, 1);
    assert.throws(() => ledger.createRecoveryReceipt(owner, first.operationId, first.expiresAt),
      /OPERATION_UNAVAILABLE/);
    assert.throws(() => ledger.prepare(owner, firstGrant.connectionId, 1, "Synthetic", key,
      first.expiresAt + 1), /OPERATION_EXPIRED/);

    const later = first.expiresAt + PREPARED_KEY_RETENTION_MS + 1;
    const laterPending = requests.create(owner, later - 2);
    const laterGrant = requests.approve(laterPending.requestId, target, later - 1)!;
    assert.equal(ledger.prepare(owner, laterGrant.connectionId, 1, "New draft", key, later).state,
      "awaiting_approval");
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_operation_recovery").get()?.count, 0);
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

test("private dispatch intent persists before any submit and restart refuses reuse", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-dispatch-journal-"));
  const path = join(home, "operations.sqlite");
  let database = openPrivateOperationDatabase(home);
  try {
    const requests = new PendingConnectionRequests();
    const owner = Symbol("prepared fixture owner");
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const ledger = new PreparedMessageOperations(requests, database);
    const key = "a66b3997-9d43-4554-8399-267d1fe9f75c";
    const text = "Synthetic dispatch intent only";
    const prepared = ledger.prepare(owner, grant.connectionId, 1, text, key, 2001);
    assert.throws(() => ledger.createRecoveryReceipt(Symbol("foreign"), prepared.operationId, 2002),
      /OPERATION_UNAVAILABLE/);
    const receipt = ledger.createRecoveryReceipt(owner, prepared.operationId, 2002);
    assert.match(receipt.recoveryToken, /^[0-9a-f]{64}$/);
    assert.deepEqual(ledger.createRecoveryReceipt(owner, prepared.operationId, 2002), receipt);
    assert.deepEqual(ledger.recoverOperationStatus(prepared.operationId, receipt.recoveryToken), { state: "unknown" });
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2002), /APPROVAL_REQUIRED/);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    assert.throws(() => ledger.recordFixtureDispatchStart(Symbol("foreign"), prepared.operationId, 2004),
      /APPROVAL_REQUIRED/);
    const started = ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2004);
    assert.deepEqual(started, { operationId: prepared.operationId, state: "dispatching", startedAt: 2004 });
    assert.deepEqual(database.prepare("SELECT * FROM message_dispatch_attempts").all().map((row) => ({ ...row })), [
      { operation_id: prepared.operationId, started_at: 2004, state: "dispatching" }
    ]);
    assert.deepEqual(ledger.getOperation(owner, prepared.operationId, 2005), {
      operationId: prepared.operationId, state: "dispatch_uncertain", startedAt: 2004
    });
    assert.deepEqual(ledger.recoverOperationStatus(prepared.operationId, receipt.recoveryToken), {
      operationId: prepared.operationId, state: "dispatch_uncertain", startedAt: 2004
    });
    assert.deepEqual(ledger.recoverOperationStatus(prepared.operationId, "0".repeat(64)), { state: "unknown" });
    assert.deepEqual(ledger.recoverOperationStatus("b66b3997-9d43-4554-8399-267d1fe9f75c", receipt.recoveryToken),
      { state: "unknown" });
    assert.throws(() => ledger.createRecoveryReceipt(owner, prepared.operationId, 2005), /OPERATION_UNAVAILABLE/);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2005), /DISPATCH_UNCERTAIN/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, text, key, 2005), /DISPATCH_UNCERTAIN/);
    assert.deepEqual(ledger.listFixtureReviews(target, 2005), { reviews: [], hasMore: false });
    assert.equal((await readFile(path)).includes(Buffer.from(text)), false);
    assert.equal((await readFile(path)).includes(Buffer.from(target.documentId)), false);
    assert.equal((await readFile(path)).includes(Buffer.from(receipt.recoveryToken)), false);

    database.close();
    database = openPrivateOperationDatabase(home);
    assert.equal(database.prepare("PRAGMA synchronous").get()?.synchronous, 2);
    const restarted = new PreparedMessageOperations(new PendingConnectionRequests(), database);
    assert.deepEqual(restarted.recoverOperationStatus(prepared.operationId, receipt.recoveryToken), {
      operationId: prepared.operationId, state: "dispatch_uncertain", startedAt: 2004
    });
    assert.deepEqual(restarted.recoverOperationStatus(prepared.operationId, "invalid"), { state: "unknown" });
    assert.deepEqual(database.prepare("SELECT * FROM message_dispatch_attempts").all().map((row) => ({ ...row })), [
      { operation_id: prepared.operationId, started_at: 2004, state: "unknown" }
    ]);
    assert.equal(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    const nextOwner = Symbol("new broker owner");
    const nextRequests = new PendingConnectionRequests();
    const nextPending = nextRequests.create(nextOwner, 1000);
    const nextGrant = nextRequests.approve(nextPending.requestId, target, 2000)!;
    const nextLedger = new PreparedMessageOperations(nextRequests, database);
    assert.throws(() => nextLedger.createRecoveryReceipt(nextOwner, prepared.operationId, 2005),
      /OPERATION_UNAVAILABLE/);
    assert.throws(() => nextLedger.recordFixtureDispatchStart(nextOwner, prepared.operationId, 2005), /APPROVAL_REQUIRED/);
    assert.throws(() => nextLedger.prepare(nextOwner, nextGrant.connectionId, 1, text, key, 2005),
      /OPERATION_UNAVAILABLE/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 1);
    assert.equal(restarted.getOperation(nextOwner, prepared.operationId, 2005).state, "unknown");
    const later = prepared.expiresAt + PREPARED_KEY_RETENTION_MS + 1;
    const laterPending = nextRequests.create(nextOwner, later - 2);
    const laterGrant = nextRequests.approve(laterPending.requestId, target, later - 1)!;
    assert.throws(() => nextLedger.prepare(nextOwner, laterGrant.connectionId, 1, text, key, later),
      /OPERATION_UNAVAILABLE/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count, 1);
    assert.deepEqual(nextLedger.recoverOperationStatus(prepared.operationId, receipt.recoveryToken), {
      operationId: prepared.operationId, state: "dispatch_uncertain", startedAt: 2004
    });
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("abrupt process death leaves before-start safe and after-start uncertain", async () => {
  const childScript = `
    import { openPrivateOperationDatabase, PreparedMessageOperations } from ${JSON.stringify(new URL("./message-operations.js", import.meta.url).href)};
    import { PendingConnectionRequests } from ${JSON.stringify(new URL("./pending-connections.js", import.meta.url).href)};
    const database = openPrivateOperationDatabase(process.argv[1]);
    const requests = new PendingConnectionRequests();
    const owner = Symbol("crash fixture owner");
    const target = { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000);
    const ledger = new PreparedMessageOperations(requests, database);
    const key = "a66b3997-9d43-4554-8399-267d1fe9f75c";
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic crash probe", key, 2001);
    const receipt = ledger.createRecoveryReceipt(owner, prepared.operationId, 2002);
    if (process.argv[2] !== "before") {
      const [review] = ledger.listFixtureReviews(target, 2002).reviews;
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
      requests.publishFixtureSnapshot(target, [{ id: "fixture-2", direction: "outgoing", text: "Old row" }], 2003);
      ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003);
      ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2004);
      if (process.argv[2] === "observed") {
        requests.publishFixtureSnapshot(target,
          [{ id: "fixture-3", direction: "outgoing", text: "Synthetic crash probe" }], 2005);
        ledger.reconcileFixtureObservation(owner, prepared.operationId, 2006);
      }
    }
    process.stdout.write(JSON.stringify({ ...receipt, key }) + "\\n",
      () => process.kill(process.pid, "SIGKILL"));
  `;
  for (const phase of ["before", "after", "observed"]) {
    const home = await mkdtemp(join(tmpdir(), `agent-messaging-crash-${phase}-`));
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript, home, phase], {
        encoding: "utf8", timeout: 5000
      });
      assert.equal(child.signal, "SIGKILL", child.stderr);
      const { operationId, key, recoveryToken } = JSON.parse(child.stdout.trim()) as {
        operationId: string; key: string; recoveryToken: string
      };
      const database = openPrivateOperationDatabase(home);
      try {
        const recovered = new PreparedMessageOperations(new PendingConnectionRequests(), database);
        assert.deepEqual(recovered.recoverOperationStatus(operationId, recoveryToken), phase === "observed"
          ? { operationId, state: "observed_in_ui", startedAt: 2004, observedAt: 2005, messageId: "fixture-3" }
          : phase === "after" ? { operationId, state: "dispatch_uncertain", startedAt: 2004 } : { state: "unknown" });
        assert.deepEqual(database.prepare("SELECT operation_id, state FROM message_dispatch_attempts").all()
          .map((row) => ({ ...row })), phase !== "before" ? [{ operation_id: operationId, state: "unknown" }] : []);
        const owner = Symbol("fresh owner");
        const requests = new PendingConnectionRequests();
        const target = { origin: "http://127.0.0.1:8787" as const,
          conversationId: "fixture-alpha" as const, tabId: 3, documentId: "CHROME-doc_opaque-42" };
        const pending = requests.create(owner, 1000);
        const grant = requests.approve(pending.requestId, target, 2000)!;
        const restarted = new PreparedMessageOperations(requests, database);
        assert.throws(() => restarted.prepare(owner, grant.connectionId, 1, "Synthetic crash probe", key, 2005),
          /OPERATION_UNAVAILABLE/);
        assert.equal((await readFile(join(home, "operations.sqlite"))).includes(Buffer.from(recoveryToken)), false);
      } finally {
        database.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("one unresolved fixture dispatch intent blocks a second approved operation", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const requests = new PendingConnectionRequests();
    const owner = Symbol("fixture writer");
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const ledger = new PreparedMessageOperations(requests, database);
    const first = ledger.prepare(owner, grant.connectionId, 1, "First synthetic draft",
      "a66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    const second = ledger.prepare(owner, grant.connectionId, 1, "Second synthetic draft",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    for (const review of ledger.listFixtureReviews(target, 2002).reviews) {
      ledger.approveFixtureReview(target, review.operationId, review.reviewId, 2003);
    }
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, first.operationId, 2004), /RECOVERY_REQUIRED/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
    const firstReceipt = ledger.createRecoveryReceipt(owner, first.operationId, 2004);
    const secondReceipt = ledger.createRecoveryReceipt(owner, second.operationId, 2004);
    ledger.recordFixtureDispatchStart(owner, first.operationId, 2004);
    assert.deepEqual(ledger.recoverOperationStatus(first.operationId, secondReceipt.recoveryToken), { state: "unknown" });
    assert.deepEqual(ledger.recoverOperationStatus(second.operationId, firstReceipt.recoveryToken), { state: "unknown" });
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, second.operationId, 2005), /DISPATCH_UNCERTAIN/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 1);
    assert.equal(ledger.getOperation(owner, second.operationId, 2005).state, "approved");
  } finally {
    database.close();
  }
});

test("approved fixture preflight challenges are exact-target, bounded, and cannot dispatch", async () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("fixture owner");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic preflight text",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    assert.equal(ledger.requestFixturePreflight(owner, prepared.operationId, 2002), null);
    const receipt = ledger.createRecoveryReceipt(owner, prepared.operationId, 2002);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    assert.equal(ledger.requestFixturePreflight(Symbol("other"), prepared.operationId, 2004), null);
    const check = ledger.requestFixturePreflight(owner, prepared.operationId, 2004);
    if (!check || check === "busy") throw new Error("Expected a preflight challenge");
    assert.equal(ledger.requestFixturePreflight(owner, prepared.operationId, 2004), "busy");
    assert.deepEqual(ledger.listFixturePreflightChallenges(2004), [{ challengeId: check.challengeId,
      operationId: prepared.operationId, target, text: prepared.preview.text,
      expiresAt: 2004 + FIXTURE_PREFLIGHT_TIMEOUT_MS }]);
    assert.equal(JSON.stringify(ledger.listFixturePreflightChallenges(2004)).includes(receipt.recoveryToken), false);
    assert.equal(ledger.completeFixturePreflight({ ...target, documentId: "other" }, check.challengeId,
      { ok: true, editor: "textarea" }, 2005), false);
    const extra = { ok: true as const, editor: "textarea" as const, draftText: "Synthetic private draft" };
    assert.equal(ledger.completeFixturePreflight(target, check.challengeId, extra, 2005), false);
    assert.equal(ledger.completeFixturePreflight(target, check.challengeId, { ok: false, code: "DRAFT_PRESENT" }, 2006), true);
    assert.deepEqual(await check.result, { operationId: prepared.operationId, checkedAt: 2006,
      ok: false, code: "DRAFT_PRESENT" });
    assert.equal(ledger.completeFixturePreflight(target, check.challengeId, { ok: true, editor: "textarea" }, 2007), false);
    const expired = ledger.requestFixturePreflight(owner, prepared.operationId, 2008);
    if (!expired || expired === "busy") throw new Error("Expected another challenge");
    assert.deepEqual(ledger.listFixturePreflightChallenges(2008 + FIXTURE_PREFLIGHT_TIMEOUT_MS), []);
    assert.equal(await expired.result, null);
    const revoked = ledger.requestFixturePreflight(owner, prepared.operationId, 2009);
    if (!revoked || revoked === "busy") throw new Error("Expected a cancellable challenge");
    requests.revokeChangedTab(3, null);
    assert.deepEqual(ledger.listFixturePreflightChallenges(2010), []);
    assert.equal(await revoked.result, null);
    assert.equal(ledger.requestFixturePreflight(owner, prepared.operationId, 2010), null);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("fixture preflight capacity and owner disconnect cancel waiting checks", async () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("fixture owner");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const waiting: Array<Promise<unknown>> = [];
    for (let index = 1; index <= MAX_PENDING_FIXTURE_PREFLIGHTS + 1; index++) {
      const prepared = ledger.prepare(owner, grant.connectionId, 1, `Synthetic check ${index}`,
        `b66b3997-9d43-4554-8399-${String(index).padStart(12, "0")}`, 2001);
      const [review] = ledger.listFixtureReviews(target, 2002).reviews;
      assert.ok(review);
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
      const check = ledger.requestFixturePreflight(owner, prepared.operationId, 2004);
      if (index > MAX_PENDING_FIXTURE_PREFLIGHTS) assert.equal(check, "busy");
      else {
        if (!check || check === "busy") throw new Error("Expected an available check slot");
        waiting.push(check.result);
      }
    }
    ledger.disconnect(owner);
    assert.deepEqual(await Promise.all(waiting), Array(MAX_PENDING_FIXTURE_PREFLIGHTS).fill(null));
    assert.deepEqual(ledger.listFixturePreflightChallenges(2005), []);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("fixture dispatch baselines require a fresh owned snapshot and trusted approval", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const requests = new PendingConnectionRequests();
    const owner = Symbol("approved fixture writer");
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const ledger = new PreparedMessageOperations(requests, database);
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic approved text",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    assert.throws(() => ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2002), /APPROVAL_REQUIRED/);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    assert.throws(() => ledger.recordFixtureDispatchBaseline(Symbol("other owner"), prepared.operationId, 2004),
      /APPROVAL_REQUIRED/);
    assert.throws(() => ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2004),
      /OBSERVATION_UNAVAILABLE/);
    requests.publishFixtureSnapshot(target, [{ id: "fixture-2", direction: "outgoing", text: prepared.preview.text }], 2004);
    const snapshot = requests.getFixtureSnapshot(owner, grant.connectionId, 2004);
    if (!snapshot || snapshot === "not_ready") throw new Error("Expected a baseline snapshot");
    assert.deepEqual(ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2005), {
      operationId: prepared.operationId, capturedAt: snapshot.capturedAt, cursor: snapshot.cursor
    });
    assert.throws(() => ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003),
      /OBSERVATION_UNAVAILABLE/);
    requests.revokeChangedTab(3, null);
    assert.throws(() => ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2006), /APPROVAL_REQUIRED/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("only one new exact outgoing fixture row records durable UI evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-evidence-"));
  let database = openPrivateOperationDatabase(home);
  try {
    const requests = new PendingConnectionRequests();
    const owner = Symbol("fixture writer");
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const ledger = new PreparedMessageOperations(requests, database);
    const text = "Synthetic evidence\nexact approved text";
    const key = "b66b3997-9d43-4554-8399-267d1fe9f75c";
    const prepared = ledger.prepare(owner, grant.connectionId, 1, text, key, 2001);
    const receipt = ledger.createRecoveryReceipt(owner, prepared.operationId, 2001);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    const before = [{ id: "fixture-2", direction: "outgoing" as const, text }];
    requests.publishFixtureSnapshot(target, before, 2003);
    ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2004);
    ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2005);
    assert.equal(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2006).state, "dispatch_uncertain");
    assert.deepEqual(ledger.reconcileFixtureObservation(Symbol("other owner"), prepared.operationId, 2006),
      { state: "unknown" });
    requests.publishFixtureSnapshot(target, [...before, { id: "fixture-3", direction: "incoming", text }], 2006);
    assert.equal(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2007).state, "dispatch_uncertain");
    requests.publishFixtureSnapshot(target, [...before, { id: "fixture-3", direction: "outgoing", text: `${text}!` }], 2007);
    assert.equal(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2008).state, "dispatch_uncertain");
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_evidence").get()?.count, 0);
    requests.publishFixtureSnapshot(target, [...before, { id: "fixture-3", direction: "outgoing", text }], 2009);
    const observed = ledger.reconcileFixtureObservation(owner, prepared.operationId, 2010);
    assert.deepEqual(observed, { operationId: prepared.operationId, state: "observed_in_ui",
      startedAt: 2005, observedAt: 2009, messageId: "fixture-3" });
    assert.deepEqual(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2011), observed);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_evidence").get()?.count, 1);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2011), /DISPATCH_UNCERTAIN/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, text, key, 2011), /DISPATCH_UNCERTAIN/);
    const next = ledger.prepare(owner, grant.connectionId, 1, "Another synthetic operation",
      "c66b3997-9d43-4554-8399-267d1fe9f75c", 2011);
    ledger.createRecoveryReceipt(owner, next.operationId, 2011);
    const [nextReview] = ledger.listFixtureReviews(target, 2012).reviews;
    assert.ok(nextReview);
    ledger.approveFixtureReview(target, next.operationId, nextReview.reviewId, 2013);
    ledger.recordFixtureDispatchBaseline(owner, next.operationId, 2013);
    assert.equal(ledger.recordFixtureDispatchStart(owner, next.operationId, 2014).state, "dispatching");
    assert.equal((await readFile(join(home, "operations.sqlite"))).includes(Buffer.from(text)), false);
    assert.equal((await readFile(join(home, "operations.sqlite"))).includes(Buffer.from(receipt.recoveryToken)), false);
    database.close();
    database = openPrivateOperationDatabase(home);
    const restarted = new PreparedMessageOperations(new PendingConnectionRequests(), database);
    assert.deepEqual(restarted.recoverOperationStatus(prepared.operationId, receipt.recoveryToken), observed);
    assert.deepEqual(restarted.getOperation(Symbol("new owner"), prepared.operationId), { state: "unknown" });
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("ambiguous rows, observation gaps, and revoked fixture grants stay uncertain", () => {
  for (const failure of ["ambiguity", "ambiguity_history", "historical_matches", "epoch", "overflow", "revoked",
    "no_baseline", "changed_baseline", "old_baseline", "trimmed_text"]) {
    const database = new DatabaseSync(":memory:");
    try {
      const requests = new PendingConnectionRequests();
      const owner = Symbol("fixture writer");
      const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
        tabId: 3, documentId: "CHROME-doc_opaque-42" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approve(pending.requestId, target, 2000)!;
      const ledger = new PreparedMessageOperations(requests, database);
      const text = failure === "trimmed_text" ? " Synthetic matched row " : "Synthetic matched row";
      const prepared = ledger.prepare(owner, grant.connectionId, 1, text,
        "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
      ledger.createRecoveryReceipt(owner, prepared.operationId, 2001);
      const [review] = ledger.listFixtureReviews(target, 2002).reviews;
      assert.ok(review);
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
      requests.publishFixtureSnapshot(target, [{ id: "fixture-2", direction: "outgoing", text: "Before" }], 2000);
      if (failure !== "no_baseline") ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2004);
      if (failure === "changed_baseline") {
        requests.publishFixtureSnapshot(target, [{ id: "fixture-2", direction: "outgoing", text: "Changed" }], 2005);
        assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2006), /OBSERVATION_UNAVAILABLE/);
        assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
        continue;
      }
      if (failure === "old_baseline") {
        assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 32001), /OBSERVATION_UNAVAILABLE/);
        assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
        continue;
      }
      ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2005);
      if (failure === "epoch") requests.markFixtureObservationGap(target, 2006);
      if (failure === "overflow") {
        for (let index = 0; index < 33; index++) {
          requests.publishFixtureSnapshot(target,
            [{ id: "fixture-2", direction: "outgoing", text: `Revision ${index}` }], 2006);
        }
      }
      if (failure === "ambiguity" || failure === "ambiguity_history") {
        requests.publishFixtureSnapshot(target, [{ id: "fixture-3", direction: "outgoing", text },
          { id: "fixture-4", direction: "outgoing", text }], 2006);
      }
      if (failure === "historical_matches") {
        requests.publishFixtureSnapshot(target, [{ id: "fixture-4", direction: "outgoing", text }], 2006);
      }
      if (failure === "ambiguity") {
        assert.equal(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2007).state,
          "dispatch_uncertain", failure);
      }
      requests.publishFixtureSnapshot(target, [{ id: "fixture-3", direction: "outgoing",
        text: failure === "trimmed_text" ? text.trim() : text }], 2008);
      if (failure === "revoked") requests.revokeChangedTab(3, null);
      assert.equal(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2009).state,
        "dispatch_uncertain", failure);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_evidence").get()?.count, 0, failure);
    } finally {
      database.close();
    }
  }
});