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
  FIXTURE_PREFLIGHT_TIMEOUT_MS, MAX_PENDING_FIXTURE_PREFLIGHTS, MAX_PENDING_FIXTURE_DISPATCH_CHECKS,
  fixtureFillResultSchema, fixtureDraftFillStateSchema, geminiFillResultSchema, geminiFillStatusSchema }
  from "./message-operations.js";
import { PendingConnectionRequests, type FixtureTarget } from "./pending-connections.js";

function approveSyntheticSend(ledger: PreparedMessageOperations, owner: symbol, operationId: string,
  target: FixtureTarget, now: number) {
  const status = ledger.getOperation(owner, operationId, now);
  if (!("draftFill" in status) || status.draftFill?.state !== "filled") {
    const review = ledger.listFixtureFillReviews(target, now).reviews.find(candidate => candidate.operationId === operationId);
    assert.ok(review);
    ledger.approveFixtureFillReview(target, operationId, review.reviewId, now);
    const filling = ledger.requestFixtureFill(owner, operationId, now);
    if (!filling || filling === "busy") throw new Error("Expected synthetic fixture fill");
    assert.equal(ledger.completeFixtureFill(target, filling.attemptId, { ok: true, editor: "textarea" }, now), true);
  }
  const review = ledger.listFixtureSendReviews(target, now).reviews.find(candidate => candidate.operationId === operationId);
  assert.ok(review);
  ledger.approveFixtureSendReview(target, operationId, review.reviewId, now);
}

function checkSyntheticDispatch(ledger: PreparedMessageOperations, owner: symbol, operationId: string,
  target: FixtureTarget, text: string, now: number) {
  const check = ledger.requestFixtureDispatchCheck(owner, operationId, now);
  assert.equal(ledger.completeFixtureDispatchCheck(target, operationId, check.checkId,
    { ok: true, editor: "textarea", draftText: text, selected: true, writable: true, submitReady: true }, now), true);
  return check.checkId;
}

test("isolated Gemini preparations bind provider/owner/URL without fixture authority", () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const ledger = new PreparedMessageOperations(requests, database);
  const owner = Symbol("isolated Gemini preparation");
  try {
    const target = { origin: "https://gemini.google.com" as const, conversationId: "disposable-chat",
      url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 3, documentId: "synthetic-gemini-document" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approveGemini(pending.requestId, target, 2000)!;
    const fixtureTarget = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: target.tabId, documentId: target.documentId };
    const fixturePending = requests.create(owner, 2000);
    const fixtureGrant = requests.approve(fixturePending.requestId, fixtureTarget, 2000)!;
    const key = "a66b3997-9d43-4554-8399-267d1fe9f75c";
    const text = "Synthetic isolated Gemini preparation";
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, text, key, 2001), /CONNECTION_NOT_FOUND/);
    assert.throws(() => ledger.prepareGemini(owner, fixtureGrant.connectionId, 1, text, key, 2001), /CONNECTION_NOT_FOUND/);
    assert.throws(() => ledger.prepareGemini(Symbol("foreign"), grant.connectionId, 1, text, key, 2001), /CONNECTION_NOT_FOUND/);
    assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 2, text, key, 2001), /GENERATION_MISMATCH/);
    for (const invalid of ["", " ", " text", "text\r\n", "x".repeat(2049), "\u00e9".repeat(2048)]) {
      assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, invalid, key, 2001), /INVALID_MESSAGE_TEXT/);
    }
    assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, text, "invalid", 2001), /INVALID_IDEMPOTENCY_KEY/);
    const prepared = ledger.prepareGemini(owner, grant.connectionId, 1, text, key, 2001);
    assert.deepEqual(prepared.preview, { target: "gemini", text });
    assert.equal(Object.isFrozen(prepared), true);
    assert.equal(Object.isFrozen(prepared.preview), true);
    assert.deepEqual(ledger.prepareGemini(owner, grant.connectionId, 1, text, key, 2002), prepared);
    assert.equal(ledger.getOperation(owner, prepared.operationId, 2002).state, "awaiting_approval");
    assert.deepEqual(ledger.getOperation(Symbol("foreign"), prepared.operationId, 2002), { state: "unknown" });
    assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, "Changed text", key, 2002), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => ledger.prepare(owner, fixtureGrant.connectionId, 1, text, key, 2002), /IDEMPOTENCY_CONFLICT/);
    const otherPending = requests.create(owner, 2002);
    const otherGrant = requests.approveGemini(otherPending.requestId, { ...target, url: target.url.replace("hl=en", "hl=fr") }, 2002)!;
    assert.throws(() => ledger.prepareGemini(owner, otherGrant.connectionId, 1, text, key, 2003), /IDEMPOTENCY_CONFLICT/);
    const originalTarget = requests.getGeminiTarget.bind(requests);
    requests.getGeminiTarget = (identity, connectionId, now) => {
      const selected = originalTarget(identity, connectionId, now);
      return selected ? { ...selected, url: selected.url.replace("hl=en", "hl=fr") } : null;
    };
    try {
      assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, text, key, 2003), /IDEMPOTENCY_CONFLICT/);
    } finally {
      requests.getGeminiTarget = originalTarget;
    }
    assert.deepEqual(ledger.listFixtureReviews(fixtureTarget, 2003), { reviews: [], hasMore: false });
    assert.deepEqual(ledger.listFixtureFillReviews(fixtureTarget, 2003), { reviews: [], hasMore: false });
    assert.deepEqual(ledger.listFixtureSendReviews(fixtureTarget, 2003), { reviews: [], hasMore: false });
    assert.throws(() => ledger.approveFixtureReview(fixtureTarget, prepared.operationId, key, 2003), /REVIEW_UNAVAILABLE/);
    assert.equal(ledger.getFixtureFillAuthorization(owner, prepared.operationId, 2003), null);
    assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2003), null);
    assert.deepEqual(ledger.listFixtureDispatchAttempts(2003), []);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
    const journal = JSON.stringify(database.prepare("SELECT * FROM prepared_message_operations").all());
    assert.equal(journal.includes(text), false);
    assert.equal(journal.includes(target.url), false);
    assert.equal(journal.includes(target.documentId), false);
    assert.equal(ledger.getOperation(owner, prepared.operationId, prepared.expiresAt).state, "expired");
    assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, text, key, prepared.expiresAt), /OPERATION_EXPIRED/);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("isolated Gemini preparations share caps and lose authority on grant expiry/disconnect/restart", () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const ledger = new PreparedMessageOperations(requests, database);
  const owner = Symbol("bounded Gemini preparation");
  try {
    const target = { origin: "https://gemini.google.com" as const, conversationId: "disposable-chat",
      url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 3, documentId: "synthetic-gemini-document" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approveGemini(pending.requestId, target, 2000)!;
    const fixturePending = requests.create(owner, 2000);
    const fixtureGrant = requests.approve(fixturePending.requestId, { origin: "http://127.0.0.1:8787",
      conversationId: "fixture-alpha", tabId: 4, documentId: "synthetic-fixture-document" }, 2000)!;
    const text = "Synthetic bounded preparation";
    let geminiOperationId = "";
    const geminiKey = "b66b3997-9d43-4554-8399-000000000001";
    for (let index = 0; index < MAX_ACTIVE_PREPARED_MESSAGES; index++) {
      const key = `b66b3997-9d43-4554-8399-${index.toString(16).padStart(12, "0")}`;
      const prepared = index % 2
        ? ledger.prepareGemini(owner, grant.connectionId, 1, text, key, 2001)
        : ledger.prepare(owner, fixtureGrant.connectionId, 1, text, key, 2001);
      if (key === geminiKey) geminiOperationId = prepared.operationId;
    }
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count,
      MAX_ACTIVE_PREPARED_MESSAGES);
    const extraKey = "c66b3997-9d43-4554-8399-267d1fe9f75c";
    assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, text, extraKey, 2002), /TOO_MANY_PREPARED/);
    assert.throws(() => ledger.prepare(owner, fixtureGrant.connectionId, 1, text, extraKey, 2002), /TOO_MANY_PREPARED/);
    assert.equal(ledger.prepareGemini(owner, grant.connectionId, 1, text, geminiKey, 2002).operationId, geminiOperationId);
    ledger.disconnect(owner);
    assert.deepEqual(ledger.getOperation(owner, geminiOperationId, 2002), { state: "unknown" });
    assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, text, geminiKey, 2002), /OPERATION_UNAVAILABLE/);
    const lateKey = "d66b3997-9d43-4554-8399-267d1fe9f75c";
    const late = ledger.prepareGemini(owner, grant.connectionId, 1, text, lateKey, grant.expiresAt - 1);
    assert.equal(ledger.getOperation(owner, late.operationId, grant.expiresAt - 1).state, "awaiting_approval");
    assert.equal(ledger.getOperation(owner, late.operationId, grant.expiresAt).state, "stale");
    assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, text, lateKey, grant.expiresAt), /CONNECTION_NOT_FOUND/);
    const restarted = new PreparedMessageOperations(requests, database);
    assert.deepEqual(restarted.getOperation(owner, late.operationId, grant.expiresAt - 1), { state: "unknown" });
    assert.throws(() => restarted.prepareGemini(owner, grant.connectionId, 1, text, lateKey, grant.expiresAt - 1), /OPERATION_UNAVAILABLE/);
    restarted.disconnect(owner);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("isolated Gemini review and fill approval stay distinct, exact-target and provider-bound", () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const ledger = new PreparedMessageOperations(requests, database);
  const owner = Symbol("isolated Gemini consent");
  try {
    const target = { origin: "https://gemini.google.com" as const, conversationId: "disposable-chat",
      url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 3, documentId: "synthetic-gemini-document" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approveGemini(pending.requestId, target, 2000)!;
    const prepared = ledger.prepareGemini(owner, grant.connectionId, 1, "Synthetic no-send consent",
      "a66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    const fixtureTarget = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: target.tabId, documentId: target.documentId };
    const fixturePending = requests.create(owner, 2001);
    const fixtureGrant = requests.approve(fixturePending.requestId, fixtureTarget, 2001)!;
    const fixture = ledger.prepare(owner, fixtureGrant.connectionId, 1, "Synthetic fixture consent",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    const fixtureReview = ledger.listFixtureReviews(fixtureTarget, 2002).reviews[0]!;
    const [review] = ledger.listGeminiReviews(target, 2002).reviews;
    assert.ok(review);
    assert.deepEqual(review.preview, prepared.preview);
    assert.equal(ledger.getGeminiFillAuthorization(owner, prepared.operationId, 2002), null);
    assert.deepEqual(ledger.listGeminiFillReviews(target, 2002), { reviews: [], hasMore: false });
    for (const changed of [{ ...target, url: target.url.replace("hl=en", "hl=fr") }, { ...target, tabId: 4 },
      { ...target, documentId: "other" }, { ...target, conversationId: "other" }]) {
      assert.deepEqual(ledger.listGeminiReviews(changed, 2002), { reviews: [], hasMore: false });
      assert.throws(() => ledger.approveGeminiReview(changed, prepared.operationId, review.reviewId, 2002), /REVIEW_UNAVAILABLE/);
    }
    const rotated = ledger.listGeminiReviews(target, 2003).reviews[0]!;
    assert.notEqual(rotated.reviewId, review.reviewId);
    assert.throws(() => ledger.approveGeminiReview(target, prepared.operationId, review.reviewId, 2003), /REVIEW_UNAVAILABLE/);
    assert.throws(() => ledger.approveGeminiReview(target, fixture.operationId, fixtureReview.reviewId, 2003), /REVIEW_UNAVAILABLE/);
    assert.throws(() => ledger.approveFixtureReview(fixtureTarget, prepared.operationId, rotated.reviewId, 2003), /REVIEW_UNAVAILABLE/);
    const approval = ledger.approveGeminiReview(target, prepared.operationId, rotated.reviewId, 2003);
    assert.equal(approval.expiresAt, 2003 + FIXTURE_REVIEW_APPROVAL_TTL_MS);
    assert.equal(ledger.getOperation(owner, prepared.operationId, 2003).state, "approved");
    assert.throws(() => ledger.approveGeminiReview(target, prepared.operationId, rotated.reviewId, 2003), /REVIEW_UNAVAILABLE/);
    assert.deepEqual(ledger.listGeminiReviews(target, 2003), { reviews: [], hasMore: false });
    ledger.approveFixtureReview(fixtureTarget, fixture.operationId, fixtureReview.reviewId, 2003);
    const fixtureFill = ledger.listFixtureFillReviews(fixtureTarget, 2003).reviews[0]!;
    const firstFill = ledger.listGeminiFillReviews(target, 2004).reviews[0]!;
    const fill = ledger.listGeminiFillReviews(target, 2005).reviews[0]!;
    assert.notEqual(firstFill.reviewId, fill.reviewId);
    assert.throws(() => ledger.approveGeminiFillReview(target, prepared.operationId, firstFill.reviewId, 2005), /FILL_REVIEW_UNAVAILABLE/);
    assert.throws(() => ledger.approveGeminiFillReview({ ...target, url: target.url.replace("hl=en", "hl=fr") },
      prepared.operationId, fill.reviewId, 2005), /FILL_REVIEW_UNAVAILABLE/);
    assert.throws(() => ledger.approveGeminiFillReview(target, fixture.operationId, fixtureFill.reviewId, 2005), /FILL_REVIEW_UNAVAILABLE/);
    assert.throws(() => ledger.approveFixtureFillReview(fixtureTarget, prepared.operationId, fill.reviewId, 2005), /FILL_REVIEW_UNAVAILABLE/);
    const consent = ledger.approveGeminiFillReview(target, prepared.operationId, fill.reviewId, 2005);
    assert.equal(consent.expiresAt, approval.expiresAt);
    assert.equal(ledger.getGeminiFillAuthorization(Symbol("foreign"), prepared.operationId, 2005), null);
    assert.equal(ledger.getGeminiFillAuthorization(owner, fixture.operationId, 2005), null);
    assert.equal(ledger.getFixtureFillAuthorization(owner, prepared.operationId, 2005), null);
    assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2005), null);
    assert.equal(ledger.consumeFixtureFillApproval(owner, prepared.operationId, 2005), null);
    const authorization = ledger.consumeGeminiFillApproval(owner, prepared.operationId, 2006);
    assert.deepEqual(authorization, { operationId: prepared.operationId, target, text: prepared.preview.text, expiresAt: consent.expiresAt });
    assert.equal(ledger.consumeGeminiFillApproval(owner, prepared.operationId, 2006), null);
    assert.deepEqual(ledger.listGeminiFillReviews(target, 2006), { reviews: [], hasMore: false });
    const status = ledger.getOperation(owner, prepared.operationId, 2006);
    assert.ok("draftFill" in status);
    assert.equal(status.draftFill?.state, "uncertain");
    ledger.approveFixtureFillReview(fixtureTarget, fixture.operationId, fixtureFill.reviewId, 2006);
    assert.ok(ledger.getFixtureFillAuthorization(owner, fixture.operationId, 2006));
    assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2006), null);
    assert.deepEqual(ledger.listFixtureDispatchAttempts(2006), []);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("isolated Gemini review and fill approval honor caps, expiry and authority loss", () => {
  for (const outcome of ["bounds", "invalid-token", "preparation-expired", "approval-expired", "grant-expired",
    "live-target-changed", "disconnect", "restart", "unresolved-dispatch"]) {
    const database = new DatabaseSync(":memory:");
    const requests = new PendingConnectionRequests();
    const ledger = new PreparedMessageOperations(requests, database);
    const owner = Symbol(outcome);
    try {
      const target = { origin: "https://gemini.google.com" as const, conversationId: "disposable-chat",
        url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 3, documentId: "synthetic-gemini-document" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approveGemini(pending.requestId, target, 2000)!;
      const now = outcome === "grant-expired" ? grant.expiresAt - 10 : 2001;
      const key = "a66b3997-9d43-4554-8399-267d1fe9f75c";
      const text = "Synthetic bounded no-send review";
      const prepared = ledger.prepareGemini(owner, grant.connectionId, 1, text, key, now);
      if (outcome === "bounds") {
        for (let index = 1; index < MAX_PREPARED_REVIEWS + 2; index++) ledger.prepareGemini(owner, grant.connectionId,
          1, text, `b66b3997-9d43-4554-8399-${index.toString(16).padStart(12, "0")}`, now + index);
        const first = ledger.listGeminiReviews(target, now + 20);
        assert.equal(first.reviews.length, MAX_PREPARED_REVIEWS);
        assert.equal(first.hasMore, true);
        assert.equal(JSON.stringify(first).includes(target.url), false);
        const rotated = ledger.listGeminiReviews(target, now + 21);
        assert.throws(() => ledger.approveGeminiReview(target, first.reviews[0]!.operationId,
          first.reviews[0]!.reviewId, now + 21), /REVIEW_UNAVAILABLE/);
        for (const review of rotated.reviews) ledger.approveGeminiReview(target, review.operationId, review.reviewId, now + 21);
        for (const review of ledger.listGeminiReviews(target, now + 22).reviews)
          ledger.approveGeminiReview(target, review.operationId, review.reviewId, now + 22);
        const fills = ledger.listGeminiFillReviews(target, now + 23);
        assert.equal(fills.reviews.length, MAX_PREPARED_REVIEWS);
        assert.equal(fills.hasMore, true);
        for (const review of fills.reviews) ledger.approveGeminiFillReview(target, review.operationId, review.reviewId, now + 23);
        const remaining = ledger.listGeminiFillReviews(target, now + 24);
        assert.equal(remaining.reviews.length, 2);
        assert.equal(remaining.hasMore, false);
        assert.equal(ledger.getGeminiFillAuthorization(owner, prepared.operationId, now + 24), null);
        assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
        continue;
      }
      const review = ledger.listGeminiReviews(target, now + 1).reviews[0]!;
      if (outcome === "preparation-expired") {
        assert.throws(() => ledger.approveGeminiReview(target, prepared.operationId, review.reviewId, prepared.expiresAt), /REVIEW_UNAVAILABLE/);
        assert.deepEqual(ledger.listGeminiFillReviews(target, prepared.expiresAt), { reviews: [], hasMore: false });
        assert.equal(ledger.getGeminiFillAuthorization(owner, prepared.operationId, prepared.expiresAt), null);
        continue;
      }
      if (outcome === "invalid-token") assert.throws(() => ledger.approveGeminiReview(target, prepared.operationId, key,
        now + 2), /REVIEW_UNAVAILABLE/);
      const approval = ledger.approveGeminiReview(target, prepared.operationId, review.reviewId, now + 2);
      const fill = ledger.listGeminiFillReviews(target, now + 3).reviews[0]!;
      if (outcome === "invalid-token") assert.throws(() => ledger.approveGeminiFillReview(target, prepared.operationId,
        review.reviewId, now + 4), /FILL_REVIEW_UNAVAILABLE/);
      ledger.approveGeminiFillReview(target, prepared.operationId, fill.reviewId, now + 4);
      if (outcome === "approval-expired" || outcome === "grant-expired") {
        const expiredAt = outcome === "grant-expired" ? grant.expiresAt : approval.expiresAt;
        assert.equal(ledger.getGeminiFillAuthorization(owner, prepared.operationId, expiredAt), null);
        assert.equal(ledger.consumeGeminiFillApproval(owner, prepared.operationId, expiredAt), null);
        assert.throws(() => ledger.approveGeminiFillReview(target, prepared.operationId, fill.reviewId, expiredAt), /FILL_REVIEW_UNAVAILABLE/);
        assert.equal(ledger.getOperation(owner, prepared.operationId, expiredAt).state,
          outcome === "grant-expired" ? "stale" : "awaiting_approval");
      } else if (outcome === "live-target-changed") {
        const original = requests.getGeminiTarget.bind(requests);
        requests.getGeminiTarget = (identity, connectionId, time) => {
          const selected = original(identity, connectionId, time);
          return selected ? { ...selected, url: selected.url.replace("hl=en", "hl=fr") } : null;
        };
        try {
          assert.equal(ledger.getGeminiFillAuthorization(owner, prepared.operationId, now + 5), null);
          assert.equal(ledger.consumeGeminiFillApproval(owner, prepared.operationId, now + 5), null);
          assert.deepEqual(ledger.listGeminiFillReviews(target, now + 5), { reviews: [], hasMore: false });
        } finally {
          requests.getGeminiTarget = original;
        }
        assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, text, key, now + 6), /OPERATION_UNAVAILABLE/);
      } else if (outcome === "disconnect") {
        ledger.disconnect(owner);
        assert.equal(ledger.getGeminiFillAuthorization(owner, prepared.operationId, now + 5), null);
        assert.throws(() => ledger.prepareGemini(owner, grant.connectionId, 1, text, key, now + 5), /OPERATION_UNAVAILABLE/);
      } else if (outcome === "restart") {
        const restarted = new PreparedMessageOperations(requests, database);
        assert.equal(restarted.getGeminiFillAuthorization(owner, prepared.operationId, now + 5), null);
        assert.deepEqual(restarted.listGeminiReviews(target, now + 5), { reviews: [], hasMore: false });
        assert.throws(() => restarted.prepareGemini(owner, grant.connectionId, 1, text, key, now + 5), /OPERATION_UNAVAILABLE/);
        restarted.disconnect(owner);
      } else if (outcome === "unresolved-dispatch") {
        const fixturePending = requests.create(owner, now + 5);
        const fixtureGrant = requests.approve(fixturePending.requestId, { origin: "http://127.0.0.1:8787",
          conversationId: "fixture-alpha", tabId: 4, documentId: "synthetic-fixture-document" }, now + 5)!;
        const fixture = ledger.prepare(owner, fixtureGrant.connectionId, 1, text,
          "b66b3997-9d43-4554-8399-267d1fe9f75c", now + 5);
        database.prepare("INSERT INTO message_dispatch_attempts (operation_id, started_at, state) VALUES (?, ?, 'unknown')")
          .run(fixture.operationId, now + 5);
        assert.ok(ledger.getGeminiFillAuthorization(owner, prepared.operationId, now + 5));
        assert.equal(ledger.consumeGeminiFillApproval(owner, prepared.operationId, now + 5), null);
      } else {
        assert.ok(ledger.consumeGeminiFillApproval(owner, prepared.operationId, now + 5));
        assert.equal(ledger.consumeGeminiFillApproval(owner, prepared.operationId, now + 5), null);
      }
      assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, now + 6), null);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count,
        outcome === "unresolved-dispatch" ? 1 : 0);
    } finally {
      ledger.disconnect(owner);
      database.close();
    }
  }
});

test("isolated Gemini fill result schemas accept only fixed no-send outcomes", () => {
  assert.equal(geminiFillResultSchema.safeParse({ ok: true, editor: "contenteditable" }).success, true);
  for (const editor of ["textarea", "rich", "other"]) {
    assert.equal(geminiFillResultSchema.safeParse({ ok: true, editor }).success, false);
  }
  assert.equal(fixtureFillResultSchema.safeParse({ ok: true, editor: "contenteditable" }).success, false);
  for (const code of ["TARGET_CHANGED", "UNSUPPORTED_MESSAGE_TEXT", "COMPOSER_UNAVAILABLE", "DRAFT_PRESENT",
    "FILL_UNAVAILABLE", "FILL_UNCERTAIN"]) assert.equal(geminiFillResultSchema.safeParse({ ok: false, code }).success, true);
  for (const extra of [{ activated: true }, { sent: true }, { delivered: true }, { retryAllowed: true }, { text: "Private draft" }]) {
    assert.equal(geminiFillResultSchema.safeParse({ ok: true, editor: "contenteditable", ...extra }).success, false);
  }
  assert.equal(geminiFillResultSchema.safeParse({ ok: false, code: "unknown" }).success, false);
  const status = { ok: true, editor: "contenteditable", operationId: "a66b3997-9d43-4554-8399-267d1fe9f75c", completedAt: 2001 };
  assert.equal(geminiFillStatusSchema.safeParse(status).success, true);
  assert.equal(geminiFillStatusSchema.safeParse({ ...status, completedAt: Infinity }).success, false);
  assert.equal(geminiFillStatusSchema.safeParse({ ...status, operationId: "invalid" }).success, false);
  for (const editor of ["textarea", "rich", "contenteditable"]) {
    assert.equal(fixtureDraftFillStateSchema.safeParse({ state: "filled", completedAt: 2001, editor }).success, true);
  }
});

test("durable dispatch jobs offer once and never regain authority after uncertain outcomes", async () => {
  for (const outcome of ["observed", "no_evidence", "failure", "wrong_target", "expired", "disconnected", "restarted",
    "changed_before_issue", "gap_before_issue", "actual_timeout", "request_deadline"]) {
    const database = new DatabaseSync(":memory:");
    const requests = new PendingConnectionRequests();
    const owner = Symbol("durable fixture job");
    const ledger = new PreparedMessageOperations(requests, database);
    try {
      const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
        tabId: 3, documentId: "CHROME-doc_opaque-42" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approve(pending.requestId, target, 2000)!;
      const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic durable dispatch",
        "a66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
      const review = ledger.listFixtureReviews(target, 2002).reviews[0]!;
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2002);
      approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
      const receipt = ledger.createRecoveryReceipt(owner, prepared.operationId, 2003);
      requests.publishFixtureSnapshot(target, [], 2003);
      ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003);
      const check = ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2004,
        outcome === "actual_timeout" ? 2006 : 6003);
      assert.equal(ledger.completeFixtureDispatchCheck(target, prepared.operationId, check.checkId,
        { ok: true, editor: "textarea", draftText: prepared.preview.text, selected: true, writable: true, submitReady: true },
        2004), true);
      assert.deepEqual(ledger.listFixtureDispatchAttempts(2004), []);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
      assert.throws(() => ledger.requestFixtureDispatch(Symbol("foreign"), prepared.operationId, check.checkId, 2005),
        /APPROVAL_REQUIRED/);
      const dispatch = ledger.requestFixtureDispatch(owner, prepared.operationId, check.checkId, 2005,
        outcome === "request_deadline" ? 2006 : 9000);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 1);
      assert.equal(ledger.consumeFixtureDispatchAuthorization(owner, prepared.operationId, 2005), null);
      const completion = { ok: true as const, editor: "textarea" as const, activated: true as const };
      assert.equal(ledger.completeFixtureDispatch(target, prepared.operationId, prepared.operationId, completion, 2005), false);
      if (outcome === "changed_before_issue") requests.publishFixtureSnapshot(target,
        [{ id: "manual", direction: "outgoing", text: "Changed before browser offer" }], 2006);
      if (outcome === "gap_before_issue") requests.markFixtureObservationGap(target, 2006);
      const offered = ledger.listFixtureDispatchAttempts(
        outcome === "changed_before_issue" || outcome === "gap_before_issue" ? 2006 : 2005);
      if (outcome === "changed_before_issue" || outcome === "gap_before_issue") assert.deepEqual(offered, []);
      else {
        assert.deepEqual(offered, [{ operationId: prepared.operationId, attemptId: prepared.operationId, target,
          text: prepared.preview.text, expiresAt: outcome === "request_deadline" ? 2006 : check.expiresAt }]);
        assert.equal(JSON.stringify(offered).includes(receipt.recoveryToken), false);
      }
      assert.deepEqual(ledger.listFixtureDispatchAttempts(2005), []);
      if (outcome === "observed") requests.publishFixtureSnapshot(target,
        [{ id: "new-outgoing", direction: "outgoing", text: prepared.preview.text }], 2006);
      if (outcome === "observed") assert.deepEqual(ledger.listFixtureDispatchAttempts(2006), []);
      if (["observed", "no_evidence", "failure", "wrong_target"].includes(outcome)) {
        assert.equal(ledger.completeFixtureDispatch({ ...target, documentId: "wrong" }, prepared.operationId,
          prepared.operationId, completion, 2006), false);
        assert.equal(ledger.completeFixtureDispatch(target, prepared.operationId, "foreign-attempt", completion, 2006), false);
        assert.equal(ledger.completeFixtureDispatch(target, prepared.operationId, prepared.operationId,
          { ...completion, delivered: true } as typeof completion, 2006), false);
        assert.equal(ledger.completeFixtureDispatch(target, prepared.operationId, prepared.operationId,
          outcome === "failure" || outcome === "wrong_target" ? { ok: false, code: "DISPATCH_UNCERTAIN" } : completion,
          2006), true);
      }
      if (outcome === "expired") ledger.listFixtureDispatchAttempts(6003);
      if (outcome === "disconnected") ledger.disconnect(owner);
      if (outcome === "restarted") {
        const restarted = new PreparedMessageOperations(requests, database);
        assert.equal(ledger.completeFixtureDispatch(target, prepared.operationId, prepared.operationId, completion, 2006), false);
        assert.deepEqual(restarted.listFixtureDispatchAttempts(2006), []);
        assert.deepEqual(ledger.listFixtureDispatchAttempts(2006), []);
      }
      const result = await dispatch.result;
      assert.deepEqual(result, outcome === "observed" ? { operationId: prepared.operationId, state: "observed_in_ui",
        startedAt: 2005, observedAt: 2006, messageId: "new-outgoing" }
        : { operationId: prepared.operationId, state: "dispatch_uncertain", startedAt: 2005 }, outcome);
      assert.deepEqual(ledger.recoverOperationStatus(prepared.operationId, receipt.recoveryToken), result);
      assert.deepEqual(ledger.listFixtureDispatchAttempts(2007), []);
      assert.equal(ledger.completeFixtureDispatch(target, prepared.operationId, prepared.operationId, completion, 2007), false);
      assert.equal(ledger.consumeFixtureDispatchAuthorization(owner, prepared.operationId, 2007), null);
      assert.throws(() => ledger.requestFixtureDispatch(owner, prepared.operationId, check.checkId, 2007),
        /APPROVAL_REQUIRED|DISPATCH_UNCERTAIN/);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 1);
    } finally {
      ledger.disconnect(owner);
      database.close();
    }
  }
});

test("pending durable dispatch refuses a second job before creating another intent", async () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("bounded dispatch jobs");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const checks: { operationId: string; checkId: string }[] = [];
    requests.publishFixtureSnapshot(target, [], 2003);
    for (const idempotencyKey of ["a66b3997-9d43-4554-8399-267d1fe9f75c", "b66b3997-9d43-4554-8399-267d1fe9f75c"]) {
      const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic bounded job", idempotencyKey, 2001);
      const review = ledger.listFixtureReviews(target, 2002).reviews.find(item => item.operationId === prepared.operationId)!;
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2002);
      approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
      ledger.createRecoveryReceipt(owner, prepared.operationId, 2003);
      ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003);
      checks.push({ operationId: prepared.operationId,
        checkId: checkSyntheticDispatch(ledger, owner, prepared.operationId, target, prepared.preview.text, 2004) });
    }
    const first = ledger.requestFixtureDispatch(owner, checks[0]!.operationId, checks[0]!.checkId, 2005);
    assert.throws(() => ledger.requestFixtureDispatch(owner, checks[1]!.operationId, checks[1]!.checkId, 2005),
      /DISPATCH_CHECK_BUSY/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 1);
    assert.equal(ledger.getOperation(owner, checks[1]!.operationId, 2005).state, "approved");
    const [attempt] = ledger.listFixtureDispatchAttempts(2005);
    assert.equal(attempt?.operationId, first.operationId);
    assert.equal(ledger.completeFixtureDispatch(target, first.operationId, first.operationId,
      { ok: false, code: "DISPATCH_UNCERTAIN" }, 2006), true);
    assert.equal((await first.result).state, "dispatch_uncertain");
    assert.throws(() => ledger.requestFixtureDispatch(owner, checks[1]!.operationId, checks[1]!.checkId, 2007),
      /DISPATCH_UNCERTAIN/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 1);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("dispatch check listing excludes completed and invalidated proofs without durable intent", () => {
  for (const outcome of ["pending", "completed", "expired", "future", "changed", "gap", "recaptured", "revoked",
    "disconnected"]) {
    const database = new DatabaseSync(":memory:");
    const requests = new PendingConnectionRequests();
    const owner = Symbol("fixture check owner");
    const ledger = new PreparedMessageOperations(requests, database);
    try {
      const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
        tabId: 3, documentId: "CHROME-doc_opaque-42" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approve(pending.requestId, target, 2000)!;
      const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic check only",
        "a66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
      const review = ledger.listFixtureReviews(target, 2002).reviews[0]!;
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2002);
      approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
      requests.publishFixtureSnapshot(target, [], 2003);
      ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003);
      const check = ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2004);
      const exact = { ok: true as const, editor: "textarea" as const, draftText: prepared.preview.text,
        selected: true as const, writable: true as const, submitReady: true as const };
      if (outcome === "completed") {
        assert.equal(ledger.completeFixtureDispatchCheck(target, prepared.operationId, check.checkId, exact, 2005), true);
      }
      if (outcome === "changed") requests.publishFixtureSnapshot(target,
        [{ id: "fixture-new", direction: "outgoing", text: "Changed timeline" }], 2005);
      if (outcome === "gap") requests.markFixtureObservationGap(target, 2005);
      if (outcome === "recaptured") ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2005);
      if (outcome === "revoked") requests.revokeChangedTab(3, null);
      if (outcome === "disconnected") ledger.disconnect(owner);
      const now = outcome === "expired" ? 6003 : outcome === "future" ? 2002 : 2005;
      const listing = ledger.listFixtureDispatchChecks(now);
      assert.deepEqual(listing, outcome === "pending" ? [check] : [], outcome);
      if (outcome === "pending") {
        assert.equal(Object.isFrozen(listing[0]), true);
        assert.equal("owner" in listing[0]!, false);
      } else {
        assert.equal(ledger.completeFixtureDispatchCheck(target, prepared.operationId, check.checkId, exact, 2006), false,
          outcome);
      }
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0, outcome);
    } finally {
      ledger.disconnect(owner);
      database.close();
    }
  }
});

test("dispatch inspection waits for exact proof and clips its original deadline", async () => {
  for (const outcome of ["exact", "changed", "wrong_target", "replaced", "recaptured", "disconnected", "expired", "deadline"]) {
    const database = new DatabaseSync(":memory:");
    const requests = new PendingConnectionRequests();
    const owner = Symbol("waiting fixture check");
    const ledger = new PreparedMessageOperations(requests, database);
    try {
      const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
        tabId: 3, documentId: "CHROME-doc_opaque-42" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approve(pending.requestId, target, 2000)!;
      const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic waiting check",
        "a66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
      const review = ledger.listFixtureReviews(target, 2002).reviews[0]!;
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2002);
      approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
      requests.publishFixtureSnapshot(target, [], 2003);
      assert.throws(() => ledger.requestFixtureDispatchInspection(Symbol("other owner"), prepared.operationId, 2004),
        /APPROVAL_REQUIRED/);
      const inspection = ledger.requestFixtureDispatchInspection(owner, prepared.operationId, 2004,
        outcome === "deadline" ? 2005 : 8000);
      if (inspection === "busy") throw new Error("Expected a fresh inspection");
      let settled = false;
      void inspection.result.then(() => { settled = true; });
      await Promise.resolve();
      assert.equal(settled, false, outcome);
      assert.throws(() => ledger.requestFixtureDispatchInspection(Symbol("other owner"), prepared.operationId, 2004),
        /APPROVAL_REQUIRED/);
      assert.equal(ledger.requestFixtureDispatchInspection(owner, prepared.operationId, 2004), "busy");
      const [check] = ledger.listFixtureDispatchChecks(2004);
      assert.equal(check?.expiresAt, outcome === "deadline" ? 2005 : 6003);
      const exact = { ok: true as const, editor: "rich" as const, draftText: prepared.preview.text,
        selected: true as const, writable: true as const, submitReady: true as const };
      if (outcome === "exact" || outcome === "changed") {
        assert.equal(ledger.completeFixtureDispatchCheck(target, prepared.operationId, inspection.checkId,
          outcome === "exact" ? exact : { ...exact, draftText: "Human changed the draft" }, 2005), outcome === "exact");
      }
      if (outcome === "wrong_target") {
        assert.equal(ledger.completeFixtureDispatchCheck({ ...target, documentId: "different" }, prepared.operationId,
          inspection.checkId, exact, 2005), false);
        ledger.disconnect(owner);
      }
      if (outcome === "replaced") ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2005);
      if (outcome === "recaptured") ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2005);
      if (outcome === "disconnected") ledger.disconnect(owner);
      if (outcome === "expired") ledger.listFixtureDispatchChecks(6003);
      assert.equal(await inspection.result, outcome === "exact", outcome);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0, outcome);
    } finally {
      ledger.disconnect(owner);
      database.close();
    }
  }
});

test("dispatch checks have bounded capacity and release expired slots without renewing consent", () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("bounded fixture checks");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    requests.publishFixtureSnapshot(target, [], 2003);
    const operationIds: string[] = [];
    for (let index = 0; index <= MAX_PENDING_FIXTURE_DISPATCH_CHECKS; index++) {
      const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic bounded check",
        `a66b3997-9d43-4554-8399-${index.toString(16).padStart(12, "0")}`, 2001);
      const review = ledger.listFixtureReviews(target, 2002).reviews.find(item => item.operationId === prepared.operationId)!;
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2002);
      approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
      ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003);
      operationIds.push(prepared.operationId);
      if (index < MAX_PENDING_FIXTURE_DISPATCH_CHECKS) ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2004);
    }
    assert.equal(ledger.listFixtureDispatchChecks(2005).length, MAX_PENDING_FIXTURE_DISPATCH_CHECKS);
    const overflow = operationIds.at(-1)!;
    const consent = ledger.getFixtureSendAuthorization(owner, overflow, 2005);
    assert.throws(() => ledger.requestFixtureDispatchCheck(owner, overflow, 2005), /DISPATCH_CHECK_BUSY/);
    const replaced = ledger.requestFixtureDispatchCheck(owner, operationIds[0]!, 2005);
    assert.equal(ledger.listFixtureDispatchChecks(2005).length, MAX_PENDING_FIXTURE_DISPATCH_CHECKS);
    assert.equal(ledger.listFixtureDispatchChecks(2005).find(check => check.operationId === operationIds[0])?.checkId,
      replaced.checkId);
    assert.deepEqual(ledger.listFixtureDispatchChecks(6003), []);
    requests.publishFixtureSnapshot(target, [], 6004);
    ledger.recordFixtureDispatchBaseline(owner, overflow, 6004);
    const next = ledger.requestFixtureDispatchCheck(owner, overflow, 6004);
    assert.deepEqual(ledger.listFixtureDispatchChecks(6004), [next]);
    assert.deepEqual(ledger.getFixtureSendAuthorization(owner, overflow, 6004), consent);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("journal start requires a fresh baseline and exact current draft after distinct send consent", () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("internal fixture writer");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic guarded intent",
      "a66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    approveSyntheticSend(ledger, owner, prepared.operationId, target, 2004);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2004), /RECOVERY_REQUIRED/);
    ledger.createRecoveryReceipt(owner, prepared.operationId, 2004);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2004), /OBSERVATION_UNAVAILABLE/);
    requests.publishFixtureSnapshot(target, [], 2003);
    ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2004);
    assert.throws(() => ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2004), /OBSERVATION_UNAVAILABLE/);
    requests.publishFixtureSnapshot(target, [], 2004);
    ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2004);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2004), /DISPATCH_CHECK_REQUIRED/);
    const check = ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2004);
    const exact = { ok: true as const, editor: "textarea" as const, draftText: prepared.preview.text,
      selected: true as const, writable: true as const, submitReady: true as const };
    assert.equal(ledger.completeFixtureDispatchCheck({ ...target, documentId: "changed" }, prepared.operationId,
      check.checkId, exact, 2005), false);
    assert.equal(ledger.completeFixtureDispatchCheck(target, prepared.operationId, check.checkId,
      { ...exact, draftText: "User changed this draft" }, 2005), false);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2005, check.checkId),
      /DISPATCH_CHECK_REQUIRED/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
    const currentCheck = checkSyntheticDispatch(ledger, owner, prepared.operationId, target, prepared.preview.text, 2006);
    assert.deepEqual(ledger.listFixtureDispatchChecks(2006), []);
    assert.equal(ledger.completeFixtureDispatchCheck(target, prepared.operationId, currentCheck, exact, 2006), false);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2007, check.checkId),
      /DISPATCH_CHECK_REQUIRED/);
    const started = ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2007, currentCheck);
    assert.equal(started.state, "dispatching");
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 1);
    assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2007), null);
    assert.equal(ledger.consumeFixtureDispatchAuthorization(Symbol("foreign"), prepared.operationId, 2007), null);
    assert.deepEqual(ledger.consumeFixtureDispatchAuthorization(owner, prepared.operationId, 2007), {
      operationId: prepared.operationId, attemptId: prepared.operationId, target, text: prepared.preview.text,
      expiresAt: 6004
    });
    assert.equal(ledger.consumeFixtureDispatchAuthorization(owner, prepared.operationId, 2008), null);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2008, currentCheck), /DISPATCH_UNCERTAIN/);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("journal checks reject stale, replaced, malformed, and revoked proof without durable intent", () => {
  for (const failure of ["expired", "future", "replaced", "recaptured", "changed", "gap", "revoked", "foreign",
    "wrong_operation", "failure", "malformed", "inactive", "read_only", "blocked_submit", "journal_failure"]) {
    const database = new DatabaseSync(":memory:");
    const requests = new PendingConnectionRequests();
    const owner = Symbol("guarded fixture writer");
    const ledger = new PreparedMessageOperations(requests, database);
    try {
      const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
        tabId: 3, documentId: "CHROME-doc_opaque-42" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approve(pending.requestId, target, 2000)!;
      const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic guarded dispatch",
        "a66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
      const [review] = ledger.listFixtureReviews(target, 2002).reviews;
      assert.ok(review);
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
      approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
      ledger.createRecoveryReceipt(owner, prepared.operationId, 2003);
      requests.publishFixtureSnapshot(target, [], 2003);
      ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003);
      const check = ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2004);
      const exact = { ok: true as const, editor: "rich" as const, draftText: prepared.preview.text,
        selected: true as const, writable: true as const, submitReady: true as const };
      if (["failure", "malformed", "inactive", "read_only", "blocked_submit"].includes(failure)) {
        const observation = failure === "failure" ? { ok: false, code: "DRAFT_CHANGED" }
          : failure === "malformed" ? { ...exact, approved: true }
          : { ...exact, [failure === "inactive" ? "selected" : failure === "read_only" ? "writable" : "submitReady"]: false };
        assert.equal(ledger.completeFixtureDispatchCheck(target, prepared.operationId, check.checkId,
          observation as typeof exact, 2004), false, failure);
      } else {
        assert.equal(ledger.completeFixtureDispatchCheck(target, prepared.operationId, check.checkId, exact, 2004), true);
      }
      if (failure === "replaced") ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2005);
      if (failure === "recaptured") ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2005);
      if (failure === "changed") requests.publishFixtureSnapshot(target,
        [{ id: "fixture-3", direction: "outgoing", text: "A changed timeline" }], 2005);
      if (failure === "gap") requests.markFixtureObservationGap(target, 2005);
      if (failure === "revoked") requests.revokeChangedTab(3, null);
      if (failure === "journal_failure") database.exec(`CREATE TRIGGER reject_dispatch BEFORE INSERT ON message_dispatch_attempts
        BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END`);
      assert.throws(() => ledger.recordFixtureDispatchStart(failure === "foreign" ? Symbol("foreign") : owner,
        failure === "wrong_operation" ? "b66b3997-9d43-4554-8399-267d1fe9f75c" : prepared.operationId,
        failure === "expired" ? 6003 : failure === "future" ? 2002 : 2005, check.checkId),
        /APPROVAL_REQUIRED|OBSERVATION_UNAVAILABLE|DISPATCH_CHECK_REQUIRED|synthetic journal failure/, failure);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0, failure);
      assert.equal(ledger.consumeFixtureDispatchAuthorization(owner, prepared.operationId, 2005), null, failure);
    } finally {
      ledger.disconnect(owner);
      database.close();
    }
  }
});

test("durable intent never recovers submit authority after expiry, revocation, disconnect, restart, or UI echo", () => {
  for (const failure of ["expired", "revoked", "disconnected", "restarted", "echo", "future"]) {
    const database = new DatabaseSync(":memory:");
    const requests = new PendingConnectionRequests();
    const owner = Symbol("one-shot fixture writer");
    const ledger = new PreparedMessageOperations(requests, database);
    try {
      const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
        tabId: 3, documentId: "CHROME-doc_opaque-42" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approve(pending.requestId, target, 2000)!;
      const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic durable guard",
        "a66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
      const [review] = ledger.listFixtureReviews(target, 2002).reviews;
      assert.ok(review);
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
      approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
      const receipt = ledger.createRecoveryReceipt(owner, prepared.operationId, 2003);
      requests.publishFixtureSnapshot(target, [], 2003);
      ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003);
      const checkId = checkSyntheticDispatch(ledger, owner, prepared.operationId, target, prepared.preview.text, 2004);
      ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2005, checkId);
      assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2005), null);
      if (failure === "revoked") requests.revokeChangedTab(3, null);
      if (failure === "disconnected") ledger.disconnect(owner);
      if (failure === "restarted") {
        const restarted = new PreparedMessageOperations(requests, database);
        assert.equal(restarted.consumeFixtureDispatchAuthorization(owner, prepared.operationId, 2006), null);
      }
      if (failure === "echo") {
        requests.publishFixtureSnapshot(target, [{ id: "fixture-3", direction: "outgoing", text: prepared.preview.text }], 2006);
        assert.equal(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2006).state, "observed_in_ui");
      }
      assert.equal(ledger.consumeFixtureDispatchAuthorization(owner, prepared.operationId,
        failure === "expired" ? 6003 : failure === "future" ? 2004 : 2006), null, failure);
      assert.equal(ledger.consumeFixtureDispatchAuthorization(owner, prepared.operationId, 2007), null, failure);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 1);
      assert.equal(ledger.recoverOperationStatus(prepared.operationId, receipt.recoveryToken).state,
        failure === "echo" ? "observed_in_ui" : "dispatch_uncertain");
    } finally {
      ledger.disconnect(owner);
      database.close();
    }
  }
});

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

test("prepared text refuses excess UTF-8 bytes before trimming and preserves exact-cap previews", (context) => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("bounded fixture preview owner");
  const ledger = new PreparedMessageOperations(requests, database);
  const pending = requests.create(owner, 1000);
  const grant = requests.approve(pending.requestId, { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
    tabId: 3, documentId: "CHROME-doc_bounded-preview" }, 2000)!;
  const texts = ["x".repeat(MAX_PREPARED_MESSAGE_BYTES),
    "\uD83D\uDE00".repeat(Math.floor(MAX_PREPARED_MESSAGE_BYTES / 4)) + "x".repeat(MAX_PREPARED_MESSAGE_BYTES % 4)];
  try {
    for (const [index, text] of texts.entries()) {
      const key = `a66b3997-9d43-4554-8399-${String(index).padStart(12, "0")}`;
      const oversized = `${text}x`;
      const originalTrim = String.prototype.trim;
      const trim = context.mock.method(String.prototype, "trim", function (this: string) {
        if (this.valueOf() === oversized) assert.fail("Oversized prepared text must not be trimmed");
        return originalTrim.call(this);
      });
      try {
        assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, oversized, key, 2001), /INVALID_MESSAGE_TEXT/);
      } finally {
        trim.mock.restore();
      }
      assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count, index);
      const prepared = ledger.prepare(owner, grant.connectionId, 1, text, key, 2001);
      assert.equal(Buffer.byteLength(prepared.preview.text, "utf8"), MAX_PREPARED_MESSAGE_BYTES);
      assert.equal(prepared.preview.text, text);
      assert.equal(prepared.state, "awaiting_approval");
    }
  } finally {
    ledger.disconnect(owner);
    database.close();
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
    approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
    requests.publishFixtureSnapshot(target, [], 2003);
    ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003);
    const checkId = checkSyntheticDispatch(ledger, owner, prepared.operationId, target, text, 2003);
    const started = ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2004, checkId);
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
      const [fillReview] = ledger.listFixtureFillReviews(target, 2003).reviews;
      ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2003);
      const filling = ledger.requestFixtureFill(owner, prepared.operationId, 2003);
      ledger.completeFixtureFill(target, filling.attemptId, { ok: true, editor: "textarea" }, 2003);
      const [sendReview] = ledger.listFixtureSendReviews(target, 2003).reviews;
      ledger.approveFixtureSendReview(target, prepared.operationId, sendReview.reviewId, 2003);
      requests.publishFixtureSnapshot(target, [{ id: "fixture-2", direction: "outgoing", text: "Old row" }], 2003);
      ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2003);
      const check = ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2003);
      ledger.completeFixtureDispatchCheck(target, prepared.operationId, check.checkId,
        { ok: true, editor: "textarea", draftText: prepared.preview.text, selected: true, writable: true, submitReady: true }, 2003);
      ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2004, check.checkId);
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
    for (const prepared of [first, second]) approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
    requests.publishFixtureSnapshot(target, [], 2003);
    ledger.recordFixtureDispatchBaseline(owner, first.operationId, 2003);
    ledger.recordFixtureDispatchBaseline(owner, second.operationId, 2003);
    const firstCheck = checkSyntheticDispatch(ledger, owner, first.operationId, target, first.preview.text, 2003);
    const secondCheck = checkSyntheticDispatch(ledger, owner, second.operationId, target, second.preview.text, 2003);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, first.operationId, 2004), /RECOVERY_REQUIRED/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
    const firstReceipt = ledger.createRecoveryReceipt(owner, first.operationId, 2004);
    const secondReceipt = ledger.createRecoveryReceipt(owner, second.operationId, 2004);
    ledger.recordFixtureDispatchStart(owner, first.operationId, 2004, firstCheck);
    assert.deepEqual(ledger.recoverOperationStatus(first.operationId, secondReceipt.recoveryToken), { state: "unknown" });
    assert.deepEqual(ledger.recoverOperationStatus(second.operationId, firstReceipt.recoveryToken), { state: "unknown" });
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, second.operationId, 2005, secondCheck), /DISPATCH_UNCERTAIN/);
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

test("draft-fill consent is separate from no-send review and consumed once for its owner", () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("fixture owner");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic exact draft fill",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    assert.deepEqual(ledger.listFixtureFillReviews(target, 2002), { reviews: [], hasMore: false });
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    assert.equal(ledger.getFixtureFillAuthorization(owner, prepared.operationId, 2004), null);
    assert.throws(() => ledger.approveFixtureFillReview(target, prepared.operationId, review.reviewId, 2004),
      /FILL_REVIEW_UNAVAILABLE/);
    const [oldFillReview] = ledger.listFixtureFillReviews(target, 2004).reviews;
    assert.ok(oldFillReview);
    const [fillReview] = ledger.listFixtureFillReviews(target, 2005).reviews;
    assert.ok(fillReview);
    assert.throws(() => ledger.approveFixtureFillReview(target, prepared.operationId, oldFillReview.reviewId, 2006),
      /FILL_REVIEW_UNAVAILABLE/);
    assert.throws(() => ledger.approveFixtureFillReview({ ...target, documentId: "other" }, prepared.operationId,
      fillReview.reviewId, 2006), /FILL_REVIEW_UNAVAILABLE/);
    const consent = ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2006);
    assert.equal(consent.state, "fill_approved");
    assert.equal(consent.expiresAt, 2003 + FIXTURE_REVIEW_APPROVAL_TTL_MS);
    const consentStatus = ledger.getOperation(owner, prepared.operationId, 2007);
    if (consentStatus.state !== "approved") throw new Error("Expected owned no-send approval");
    assert.deepEqual(consentStatus.draftFill, { state: "fill_approved", expiresAt: consent.expiresAt });
    assert.equal(ledger.getFixtureFillAuthorization(Symbol("other owner"), prepared.operationId, 2007), null);
    assert.deepEqual(ledger.consumeFixtureFillApproval(owner, prepared.operationId, 2007), {
      operationId: prepared.operationId, target, text: prepared.preview.text, expiresAt: consent.expiresAt
    });
    assert.equal(ledger.consumeFixtureFillApproval(owner, prepared.operationId, 2008), null);
    assert.deepEqual(ledger.listFixtureFillReviews(target, 2008), { reviews: [], hasMore: false });
    assert.throws(() => ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2008),
      /FILL_REVIEW_UNAVAILABLE/);
    assert.equal(ledger.getOperation(owner, prepared.operationId, 2008).state, "approved");
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
    ledger.disconnect(owner);
    assert.equal(ledger.getFixtureFillAuthorization(owner, prepared.operationId, 2009), null);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("send consent is distinct from no-send review and fill consent and requires completed fill", async () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("fixture send reviewer");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic explicit send review",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    assert.deepEqual(ledger.listFixtureSendReviews(target, 2002), { reviews: [], hasMore: false });
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2004), null);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2004),
      /SEND_APPROVAL_REQUIRED/);
    assert.throws(() => ledger.approveFixtureSendReview(target, prepared.operationId, review.reviewId, 2004),
      /SEND_REVIEW_UNAVAILABLE/);
    const [fillReview] = ledger.listFixtureFillReviews(target, 2004).reviews;
    assert.ok(fillReview);
    ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2005);
    assert.deepEqual(ledger.listFixtureSendReviews(target, 2005), { reviews: [], hasMore: false });
    const filling = ledger.requestFixtureFill(owner, prepared.operationId, 2006);
    if (!filling || filling === "busy") throw new Error("Expected synthetic fixture fill");
    assert.deepEqual(ledger.listFixtureSendReviews(target, 2006), { reviews: [], hasMore: false });
    assert.equal(ledger.completeFixtureFill(target, filling.attemptId, { ok: true, editor: "textarea" }, 2007), true);
    assert.ok((await filling.result)?.ok);
    assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2008), null);
    assert.throws(() => ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2008),
      /SEND_APPROVAL_REQUIRED/);
    assert.deepEqual(ledger.listFixtureSendReviews({ ...target, documentId: "other" }, 2008),
      { reviews: [], hasMore: false });
    const [oldSendReview] = ledger.listFixtureSendReviews(target, 2008).reviews;
    const [sendReview] = ledger.listFixtureSendReviews(target, 2009).reviews;
    assert.ok(oldSendReview && sendReview);
    for (const token of [review.reviewId, fillReview.reviewId, oldSendReview.reviewId]) {
      assert.throws(() => ledger.approveFixtureSendReview(target, prepared.operationId, token, 2010),
        /SEND_REVIEW_UNAVAILABLE/);
    }
    assert.throws(() => ledger.approveFixtureSendReview({ ...target, tabId: 4 }, prepared.operationId,
      sendReview.reviewId, 2010), /SEND_REVIEW_UNAVAILABLE/);
    const consent = ledger.approveFixtureSendReview(target, prepared.operationId, sendReview.reviewId, 2010);
    assert.equal(consent.state, "send_approved");
    assert.ok(consent.expiresAt <= prepared.expiresAt && consent.expiresAt <= sendReview.expiresAt);
    assert.deepEqual(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2011), {
      operationId: prepared.operationId, target, text: prepared.preview.text, expiresAt: consent.expiresAt
    });
    assert.equal(ledger.getFixtureSendAuthorization(Symbol("foreign owner"), prepared.operationId, 2011), null);
    assert.throws(() => ledger.approveFixtureSendReview(target, prepared.operationId, sendReview.reviewId, 2011),
      /SEND_REVIEW_UNAVAILABLE/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
    requests.revokeChangedTab(3, null);
    assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2012), null);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("send-review expiry cannot be revived by ordinary review renewal or a new ledger", async () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("fixture send reviewer");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic send-review expiry",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    const [fillReview] = ledger.listFixtureFillReviews(target, 2004).reviews;
    assert.ok(fillReview);
    ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2005);
    const filling = ledger.requestFixtureFill(owner, prepared.operationId, 2006);
    if (!filling || filling === "busy") throw new Error("Expected synthetic fill attempt");
    assert.equal(ledger.completeFixtureFill(target, filling.attemptId, { ok: true, editor: "rich" }, 2007), true);
    await filling.result;
    const [expiredSendReview] = ledger.listFixtureSendReviews(target, 2008).reviews;
    assert.ok(expiredSendReview);
    const renewedAt = expiredSendReview.expiresAt + 1;
    const [renewedReview] = ledger.listFixtureReviews(target, renewedAt).reviews;
    assert.ok(renewedReview);
    ledger.approveFixtureReview(target, prepared.operationId, renewedReview.reviewId, renewedAt);
    assert.throws(() => ledger.approveFixtureSendReview(target, prepared.operationId,
      expiredSendReview.reviewId, renewedAt), /SEND_REVIEW_UNAVAILABLE/);
    const [freshSendReview] = ledger.listFixtureSendReviews(target, renewedAt).reviews;
    assert.ok(freshSendReview);
    const consent = ledger.approveFixtureSendReview(target, prepared.operationId, freshSendReview.reviewId, renewedAt);
    assert.ok(ledger.getFixtureSendAuthorization(owner, prepared.operationId, renewedAt + 1));
    const restarted = new PreparedMessageOperations(requests, database);
    assert.equal(restarted.getFixtureSendAuthorization(owner, prepared.operationId, renewedAt + 1), null);
    assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, consent.expiresAt), null);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("failed and uncertain fixture fills cannot offer send authority", async () => {
  for (const result of [{ ok: false as const, code: "DRAFT_PRESENT" as const },
    { ok: false as const, code: "FILL_UNCERTAIN" as const }]) {
    const database = new DatabaseSync(":memory:");
    const requests = new PendingConnectionRequests();
    const owner = Symbol("fixture owner");
    const ledger = new PreparedMessageOperations(requests, database);
    try {
      const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
        tabId: 3, documentId: "CHROME-doc_opaque-42" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approve(pending.requestId, target, 2000)!;
      const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic failed fill",
        "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
      const [review] = ledger.listFixtureReviews(target, 2002).reviews;
      assert.ok(review);
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
      const [fillReview] = ledger.listFixtureFillReviews(target, 2004).reviews;
      assert.ok(fillReview);
      ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2005);
      const filling = ledger.requestFixtureFill(owner, prepared.operationId, 2006);
      if (!filling || filling === "busy") throw new Error("Expected synthetic refused fill");
      assert.equal(ledger.completeFixtureFill(target, filling.attemptId, result, 2007), true);
      await filling.result;
      assert.deepEqual(ledger.listFixtureSendReviews(target, 2008), { reviews: [], hasMore: false });
      assert.equal(ledger.getFixtureSendAuthorization(owner, prepared.operationId, 2008), null);
      assert.throws(() => ledger.approveFixtureSendReview(target, prepared.operationId, fillReview.reviewId, 2008),
        /SEND_REVIEW_UNAVAILABLE/);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
    } finally {
      ledger.disconnect(owner);
      database.close();
    }
  }
});

test("manual fixture review can pause beyond old windows without removing expiry or one-shot checks", () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("manual fixture tester");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic delayed fixture fill",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    assert.equal(prepared.expiresAt, 2001 + 3 * 60_000);
    const reviewedAt = 2001 + 75_000;
    const [review] = ledger.listFixtureReviews(target, reviewedAt).reviews;
    assert.ok(review, "Prepared preview should survive a 75-second manual pause");
    const approved = ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, reviewedAt);
    assert.equal(approved.expiresAt, Math.min(prepared.expiresAt, reviewedAt + 2 * 60_000));
    const fillReviewedAt = reviewedAt + 45_000;
    const [fillReview] = ledger.listFixtureFillReviews(target, fillReviewedAt).reviews;
    assert.ok(fillReview, "Separate fill review should survive a further 45-second pause");
    const consent = ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, fillReviewedAt);
    assert.ok(consent.expiresAt <= prepared.expiresAt && consent.expiresAt <= approved.expiresAt);
    assert.ok(ledger.getFixtureFillAuthorization(owner, prepared.operationId, fillReviewedAt + 1));
    assert.ok(ledger.consumeFixtureFillApproval(owner, prepared.operationId, fillReviewedAt + 1));
    assert.equal(ledger.consumeFixtureFillApproval(owner, prepared.operationId, fillReviewedAt + 2), null);
    assert.equal(ledger.getFixtureFillAuthorization(owner, prepared.operationId, prepared.expiresAt), null);
    assert.equal(ledger.getOperation(owner, prepared.operationId, prepared.expiresAt).state, "expired");
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("renewing no-send approval cannot revive an expired fill-review token", () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("fixture owner");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic expiring fill review",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    const [oldFillReview] = ledger.listFixtureFillReviews(target, 2004).reviews;
    assert.ok(oldFillReview);
    const renewedAt = oldFillReview.expiresAt + 1;
    const [renewedReview] = ledger.listFixtureReviews(target, renewedAt).reviews;
    assert.ok(renewedReview);
    ledger.approveFixtureReview(target, prepared.operationId, renewedReview.reviewId, renewedAt);
    assert.equal(ledger.getOperation(owner, prepared.operationId, renewedAt).state, "approved");
    assert.throws(() => ledger.approveFixtureFillReview(target, prepared.operationId, oldFillReview.reviewId, renewedAt),
      /FILL_REVIEW_UNAVAILABLE/);
    const [freshFillReview] = ledger.listFixtureFillReviews(target, renewedAt).reviews;
    assert.ok(freshFillReview);
    assert.equal(ledger.approveFixtureFillReview(target, prepared.operationId, freshFillReview.reviewId, renewedAt).state,
      "fill_approved");
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("expired, revoked, or writer-blocked fill consent cannot authorize a draft edit", () => {
  for (const failure of ["expired", "revoked", "writer_uncertain"]) {
    const database = new DatabaseSync(":memory:");
    const requests = new PendingConnectionRequests();
    const owner = Symbol("fixture owner");
    const ledger = new PreparedMessageOperations(requests, database);
    try {
      const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
        tabId: 3, documentId: "CHROME-doc_opaque-42" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approve(pending.requestId, target, 2000)!;
      const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic fill candidate",
        "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
      const [review] = ledger.listFixtureReviews(target, 2002).reviews;
      assert.ok(review);
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
      const [fillReview] = ledger.listFixtureFillReviews(target, 2004).reviews;
      assert.ok(fillReview);
      const consent = ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2005);
      if (failure === "expired") {
        assert.equal(ledger.getFixtureFillAuthorization(owner, prepared.operationId, consent.expiresAt), null);
        assert.equal(ledger.consumeFixtureFillApproval(owner, prepared.operationId, consent.expiresAt), null);
      } else if (failure === "revoked") {
        requests.revokeChangedTab(3, null);
        assert.equal(ledger.getFixtureFillAuthorization(owner, prepared.operationId, 2006), null);
        assert.equal(ledger.consumeFixtureFillApproval(owner, prepared.operationId, 2006), null);
      } else {
        const blocking = ledger.prepare(owner, grant.connectionId, 1, "Synthetic unresolved attempt",
          "c66b3997-9d43-4554-8399-267d1fe9f75c", 2006);
        ledger.createRecoveryReceipt(owner, blocking.operationId, 2006);
        const [blockingReview] = ledger.listFixtureReviews(target, 2007).reviews;
        assert.ok(blockingReview);
        ledger.approveFixtureReview(target, blocking.operationId, blockingReview.reviewId, 2008);
        approveSyntheticSend(ledger, owner, blocking.operationId, target, 2008);
        requests.publishFixtureSnapshot(target, [], 2008);
        ledger.recordFixtureDispatchBaseline(owner, blocking.operationId, 2008);
        const checkId = checkSyntheticDispatch(ledger, owner, blocking.operationId, target, blocking.preview.text, 2008);
        ledger.recordFixtureDispatchStart(owner, blocking.operationId, 2009, checkId);
        assert.equal(ledger.consumeFixtureFillApproval(owner, prepared.operationId, 2010), null);
        assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 1);
      }
    } finally {
      ledger.disconnect(owner);
      database.close();
    }
  }
});

test("fixture fill queue consumes separate owner consent before one exact-target attempt", async () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("fixture owner");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic one-shot fill",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    assert.equal(ledger.requestFixtureFill(owner, prepared.operationId, 2004), null);
    const [fillReview] = ledger.listFixtureFillReviews(target, 2004).reviews;
    assert.ok(fillReview);
    ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2005);
    assert.equal(ledger.requestFixtureFill(Symbol("foreign"), prepared.operationId, 2006), null);
    const filling = ledger.requestFixtureFill(owner, prepared.operationId, 2006);
    if (!filling || filling === "busy") throw new Error("Expected one owner fill attempt");
    const fillingStatus = ledger.getOperation(owner, prepared.operationId, 2006);
    if (fillingStatus.state !== "approved") throw new Error("Expected an owned in-flight fill");
    assert.deepEqual(fillingStatus.draftFill, { state: "filling", startedAt: 2006, expiresAt: 6006 });
    assert.deepEqual(ledger.getOperation(Symbol("foreign"), prepared.operationId, 2006), { state: "unknown" });
    assert.equal(ledger.getFixtureFillAuthorization(owner, prepared.operationId, 2006), null);
    assert.equal(ledger.requestFixtureFill(owner, prepared.operationId, 2007), null);
    assert.deepEqual(ledger.listFixtureFillChallenges(2007), [{ attemptId: filling.attemptId,
      operationId: prepared.operationId, target, text: prepared.preview.text, expiresAt: 6006 }]);
    const second = ledger.prepare(owner, grant.connectionId, 1, "Synthetic second fill",
      "c66b3997-9d43-4554-8399-267d1fe9f75c", 2007);
    const [secondReview] = ledger.listFixtureReviews(target, 2008).reviews;
    assert.ok(secondReview);
    ledger.approveFixtureReview(target, second.operationId, secondReview.reviewId, 2008);
    const [secondFillReview] = ledger.listFixtureFillReviews(target, 2009).reviews;
    assert.ok(secondFillReview);
    ledger.approveFixtureFillReview(target, second.operationId, secondFillReview.reviewId, 2009);
    assert.equal(ledger.requestFixtureFill(owner, second.operationId, 2010), "busy");
    assert.ok(ledger.getFixtureFillAuthorization(owner, second.operationId, 2010));
    assert.equal(ledger.completeFixtureFill({ ...target, documentId: "other" }, filling.attemptId,
      { ok: true, editor: "textarea" }, 2010), false);
    assert.equal(ledger.completeFixtureFill(target, filling.attemptId,
      { ok: true, editor: "textarea", draftText: "private" } as never, 2010), false);
    assert.equal(ledger.completeFixtureFill(target, filling.attemptId, { ok: true, editor: "textarea" }, 2011), true);
    assert.deepEqual(await filling.result, { operationId: prepared.operationId, completedAt: 2011,
      ok: true, editor: "textarea" });
    const filledStatus = ledger.getOperation(owner, prepared.operationId, 2011);
    if (filledStatus.state !== "approved") throw new Error("Expected owned fill readback");
    assert.deepEqual(filledStatus.draftFill, { state: "filled", completedAt: 2011, editor: "textarea" });
    assert.equal(JSON.stringify(filledStatus).includes(prepared.preview.text), false);
    assert.equal(JSON.stringify(filledStatus).includes(target.documentId), false);
    assert.equal(ledger.completeFixtureFill(target, filling.attemptId, { ok: true, editor: "textarea" }, 2012), false);
    assert.equal(ledger.requestFixtureFill(owner, prepared.operationId, 2012), null);
    const next = ledger.requestFixtureFill(owner, second.operationId, 2012);
    if (!next || next === "busy") throw new Error("Expected serialized second attempt");
    const deadlineStatus = ledger.getOperation(owner, second.operationId, 6012);
    if (deadlineStatus.state !== "approved") throw new Error("Expected owned fill deadline status");
    assert.deepEqual(deadlineStatus.draftFill, { state: "uncertain", completedAt: 6012 });
    assert.deepEqual(ledger.listFixtureFillChallenges(6012), []);
    assert.equal(await next.result, null);
    const unknownStatus = ledger.getOperation(owner, second.operationId, 6013);
    if (unknownStatus.state !== "approved") throw new Error("Expected owned uncertain fill");
    assert.deepEqual(unknownStatus.draftFill, { state: "uncertain", completedAt: 6012 });
    assert.equal(ledger.requestFixtureFill(owner, second.operationId, 6013), null);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
  } finally {
    ledger.disconnect(owner);
    database.close();
  }
});

test("fixture fill queues cancel on disconnect and never regain consumed consent", async () => {
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("fixture owner");
  const ledger = new PreparedMessageOperations(requests, database);
  try {
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic disconnected fill",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    const [fillReview] = ledger.listFixtureFillReviews(target, 2004).reviews;
    assert.ok(fillReview);
    ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2005);
    const filling = ledger.requestFixtureFill(owner, prepared.operationId, 2006);
    if (!filling || filling === "busy") throw new Error("Expected disconnectable fill");
    ledger.disconnect(owner);
    assert.equal(await filling.result, null);
    assert.deepEqual(ledger.listFixtureFillChallenges(2007), []);
    assert.equal(ledger.requestFixtureFill(owner, prepared.operationId, 2007), null);
    assert.equal(ledger.completeFixtureFill(target, filling.attemptId, { ok: true, editor: "textarea" }, 2007), false);
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
    approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
    const before = [{ id: "fixture-2", direction: "outgoing" as const, text }];
    requests.publishFixtureSnapshot(target, before, 2003);
    ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2004);
    const checkId = checkSyntheticDispatch(ledger, owner, prepared.operationId, target, text, 2004);
    ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2005, checkId);
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
    approveSyntheticSend(ledger, owner, next.operationId, target, 2013);
    requests.publishFixtureSnapshot(target, [...before, { id: "fixture-3", direction: "outgoing", text }], 2013);
    ledger.recordFixtureDispatchBaseline(owner, next.operationId, 2013);
    const nextCheck = checkSyntheticDispatch(ledger, owner, next.operationId, target, next.preview.text, 2013);
    assert.equal(ledger.recordFixtureDispatchStart(owner, next.operationId, 2014, nextCheck).state, "dispatching");
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
    "no_baseline", "changed_baseline", "old_baseline", "unsupported_text"]) {
    const database = new DatabaseSync(":memory:");
    try {
      const requests = new PendingConnectionRequests();
      const owner = Symbol("fixture writer");
      const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
        tabId: 3, documentId: "CHROME-doc_opaque-42" };
      const pending = requests.create(owner, 1000);
      const grant = requests.approve(pending.requestId, target, 2000)!;
      const ledger = new PreparedMessageOperations(requests, database);
      const text = failure === "unsupported_text" ? " Synthetic matched row " : "Synthetic matched row";
      const prepared = ledger.prepare(owner, grant.connectionId, 1, text,
        "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
      ledger.createRecoveryReceipt(owner, prepared.operationId, 2001);
      const [review] = ledger.listFixtureReviews(target, 2002).reviews;
      assert.ok(review);
      ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
      approveSyntheticSend(ledger, owner, prepared.operationId, target, 2003);
      requests.publishFixtureSnapshot(target, [{ id: "fixture-2", direction: "outgoing", text: "Before" }], 2003);
      if (failure !== "no_baseline") ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2004);
      if (failure === "no_baseline" || failure === "unsupported_text") {
        assert.throws(() => ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2004),
          failure === "no_baseline" ? /OBSERVATION_UNAVAILABLE/ : /UNSUPPORTED_MESSAGE_TEXT/);
        assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
        continue;
      }
      const checkId = checkSyntheticDispatch(ledger, owner, prepared.operationId, target, text, 2004);
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
      ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2005, checkId);
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
        text }], 2008);
      if (failure === "revoked") requests.revokeChangedTab(3, null);
      assert.equal(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2009).state,
        "dispatch_uncertain", failure);
      assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_evidence").get()?.count, 0, failure);
    } finally {
      database.close();
    }
  }
});