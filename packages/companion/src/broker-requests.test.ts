import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleBrokerRequest } from "./broker-requests.js";
import { FIXTURE_REVIEW_APPROVAL_TTL_MS, PreparedMessageOperations } from "./message-operations.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { GEMINI_READ_TIMEOUT_MS, MAX_PENDING_REQUESTS, PendingConnectionRequests, PENDING_REQUEST_TTL_MS }
  from "./pending-connections.js";

test("facade keepalive is a strict no-op and cannot renew browser grants", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("fixture owner");
  const pending = requests.create(owner, 1000);
  const target = { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
    documentId: "CHROME-doc_opaque-42" } as const;
  const grant = requests.approve(pending.requestId, target, 2000)!;
  const before = requests.get(owner, pending.requestId, 2001);
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const heartbeat = { ...envelope, kind: "keep_alive", payload: {} };
  assert.deepEqual(handleBrokerRequest(heartbeat, "facade", owner, requests, 2001), {
    ...envelope, kind: "kept_alive", payload: {}
  });
  assert.deepEqual(requests.get(owner, pending.requestId, 2001), before);
  assert.deepEqual(handleBrokerRequest(heartbeat, "relay", Symbol("relay"), requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  for (const payload of [{ connectionId: grant.connectionId }, { approved: true }, { text: "private" }]) {
    assert.throws(() => handleBrokerRequest({ ...heartbeat, payload }, "facade", owner, requests, 2001));
  }
  assert.throws(() => handleBrokerRequest({ ...heartbeat, deadlineMs: 2001 }, "facade", owner, requests, 2001));
  const expiredAt = grant.expiresAt;
  assert.equal(handleBrokerRequest({ ...heartbeat, deadlineMs: expiredAt + 5000 },
    "facade", owner, requests, expiredAt).kind, "kept_alive");
  assert.notEqual(requests.get(owner, pending.requestId, expiredAt)?.state, "ready_readonly");
});

test("only a relay marks a gap for the exact approved Gemini URL and document", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("Gemini owner");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com" as const, conversationId: "disposable-chat",
    url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 4,
    documentId: "CHROME-doc_gemini-42" };
  const grant = requests.approveGemini(pending.requestId, target, 2000)!;
  requests.publishGeminiSnapshot(target, [{ direction: "incoming", text: "Synthetic" }], 2001);
  const before = requests.getGeminiSnapshot(owner, grant.connectionId, 2001);
  if (!before || before === "not_ready") throw new Error("Expected an old Gemini cursor");
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const gap = { ...envelope, kind: "mark_gemini_observation_gap", payload: { target } };
  assert.deepEqual(handleBrokerRequest(gap, "facade", owner, requests, 2002).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest({ ...gap, payload: { target: { ...target, url: `${target.url}&other=1` } } },
    "relay", Symbol("relay"), requests, 2002).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest(gap, "relay", Symbol("relay"), requests, 2002), {
    ...envelope, kind: "gemini_gap_marked", payload: { count: 1 }
  });
  assert.deepEqual(requests.readGeminiEvents(owner, grant.connectionId, before.cursor, 1, 2002),
    { state: "expired", resnapshot: true });
  assert.equal(requests.get(owner, pending.requestId, 2002)?.state, "ready_readonly");
  assert.throws(() => handleBrokerRequest({ ...gap, payload: { ...gap.payload, selector: "*" } },
    "relay", Symbol("relay"), requests, 2002));
});

test("only the relay grants distinct fixture send consent after completed fill without dispatch", () => {
  const requests = new PendingConnectionRequests();
  const database = new DatabaseSync(":memory:");
  try {
    const operations = new PreparedMessageOperations(requests, database);
    const owner = Symbol("fixture owner");
    const stranger = Symbol("other facade");
    const relay = Symbol("trusted relay");
    const envelope = { protocolVersion: PROTOCOL_VERSION,
      requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const prepared = handleBrokerRequest({ ...envelope, kind: "prepare_fixture_message", payload: {
      connectionId: grant.connectionId, expectedGeneration: 1, text: "Synthetic send review only",
      idempotencyKey: "b66b3997-9d43-4554-8399-267d1fe9f75c"
    } }, "facade", owner, requests, 2001, operations);
    if (prepared.kind !== "message_prepared") throw new Error("Expected prepared text");
    const operationId = prepared.payload.operationId;
    const inspectionRequest = { ...envelope, kind: "check_fixture_dispatch", payload: { operationId } };
    assert.deepEqual(handleBrokerRequest(inspectionRequest, "facade", owner, requests, 2002, operations).payload,
      { code: "DISPATCH_CHECK_UNAVAILABLE" });
    const listing = { ...envelope, kind: "list_fixture_send_reviews", payload: { target } };
    assert.deepEqual(handleBrokerRequest(listing, "relay", relay, requests, 2002, operations).payload,
      { reviews: [], hasMore: false });
    const ordinary = operations.listFixtureReviews(target, 2002).reviews[0]!;
    operations.approveFixtureReview(target, operationId, ordinary.reviewId, 2002);
    const fill = operations.listFixtureFillReviews(target, 2003).reviews[0]!;
    operations.approveFixtureFillReview(target, operationId, fill.reviewId, 2003);
    assert.deepEqual(handleBrokerRequest(listing, "relay", relay, requests, 2003, operations).payload,
      { reviews: [], hasMore: false });
    const attempt = operations.requestFixtureFill(owner, operationId, 2003);
    if (!attempt || attempt === "busy") throw new Error("Expected consented fill");
    assert.equal(operations.completeFixtureFill(target, attempt.attemptId, { ok: true, editor: "textarea" }, 2004), true);
    for (const facade of [owner, stranger]) {
      assert.deepEqual(handleBrokerRequest(listing, "facade", facade, requests, 2005, operations).payload,
        { code: "PERMISSION_DENIED" });
    }
    assert.deepEqual(handleBrokerRequest(listing, "relay", relay, requests, 2005).payload,
      { code: "PREPARATION_UNAVAILABLE" });
    const listed = handleBrokerRequest(listing, "relay", relay, requests, 2005, operations);
    if (listed.kind !== "fixture_send_reviews") throw new Error("Expected separate send review");
    const review = listed.payload.reviews[0]!;
    assert.deepEqual(listed.payload, { reviews: [{ operationId, reviewId: review.reviewId,
      expiresAt: 2002 + FIXTURE_REVIEW_APPROVAL_TTL_MS, preview: prepared.payload.preview }], hasMore: false });
    assert.notEqual(review.reviewId, ordinary.reviewId);
    assert.notEqual(review.reviewId, fill.reviewId);
    assert.equal(JSON.stringify(listed.payload).includes(prepared.payload.recoveryToken), false);
    const approval = { ...envelope, kind: "approve_fixture_send_review", payload: {
      target, operationId, reviewId: review.reviewId
    } };
    for (const facade of [owner, stranger]) {
      assert.deepEqual(handleBrokerRequest(approval, "facade", facade, requests, 2006, operations).payload,
        { code: "PERMISSION_DENIED" });
    }
    assert.deepEqual(handleBrokerRequest(approval, "relay", relay, requests, 2006).payload,
      { code: "PREPARATION_UNAVAILABLE" });
    for (const reviewId of [ordinary.reviewId, fill.reviewId]) {
      assert.deepEqual(handleBrokerRequest({ ...approval, payload: { ...approval.payload, reviewId } },
        "relay", relay, requests, 2006, operations).payload, { code: "SEND_REVIEW_UNAVAILABLE" });
    }
    const otherTarget = { ...target, documentId: "CHROME-doc_changed" };
    assert.deepEqual(handleBrokerRequest({ ...listing, payload: { target: otherTarget } },
      "relay", relay, requests, 2006, operations).payload, { reviews: [], hasMore: false });
    assert.deepEqual(handleBrokerRequest({ ...approval, payload: { ...approval.payload, target: otherTarget } },
      "relay", relay, requests, 2006, operations).payload, { code: "SEND_REVIEW_UNAVAILABLE" });
    for (const extra of [{ approved: true }, { text: "Changed" }, { selector: "button" },
      { recoveryToken: prepared.payload.recoveryToken }]) {
      assert.throws(() => handleBrokerRequest({ ...approval, payload: { ...approval.payload, ...extra } },
        "relay", relay, requests, 2006, operations));
    }
    const renewed = handleBrokerRequest(listing, "relay", relay, requests, 2007, operations);
    if (renewed.kind !== "fixture_send_reviews") throw new Error("Expected refreshed send review");
    assert.deepEqual(handleBrokerRequest(approval, "relay", relay, requests, 2008, operations).payload,
      { code: "SEND_REVIEW_UNAVAILABLE" });
    const currentApproval = { ...approval, payload: { ...approval.payload, reviewId: renewed.payload.reviews[0]!.reviewId } };
    const consent = handleBrokerRequest(currentApproval, "relay", relay, requests, 2008, operations);
    if (consent.kind !== "fixture_send_review_approved") throw new Error("Expected distinct send consent");
    assert.deepEqual(consent.payload, { operationId, state: "send_approved", approvedAt: 2008,
      expiresAt: 2002 + FIXTURE_REVIEW_APPROVAL_TTL_MS });
    assert.equal(operations.getFixtureSendAuthorization(stranger, operationId, 2008), null);
    assert.ok(operations.getFixtureSendAuthorization(owner, operationId, 2008));
    assert.deepEqual(handleBrokerRequest(currentApproval, "relay", relay, requests, 2009, operations).payload,
      { code: "SEND_REVIEW_UNAVAILABLE" });
    assert.equal(handleBrokerRequest(inspectionRequest, "facade", owner, requests, 2009, operations).kind,
      "fixture_dispatch_check_authorized");
    assert.deepEqual(handleBrokerRequest(inspectionRequest, "facade", stranger, requests, 2009, operations).payload,
      { code: "DISPATCH_CHECK_UNAVAILABLE" });
    assert.deepEqual(handleBrokerRequest(inspectionRequest, "relay", relay, requests, 2009, operations).payload,
      { code: "PERMISSION_DENIED" });
    for (const extra of [{ approved: true }, { text: "Changed" }, { target }, { checkId: operationId }]) {
      assert.throws(() => handleBrokerRequest({ ...inspectionRequest, payload: { operationId, ...extra } },
        "facade", owner, requests, 2009, operations));
    }
    requests.publishFixtureSnapshot(target, [], 2009);
    const inspection = operations.requestFixtureDispatchInspection(owner, operationId, 2009);
    if (inspection === "busy") throw new Error("Expected private dispatch inspection");
    const checksRequest = { ...envelope, kind: "list_fixture_dispatch_checks", payload: {} };
    const checks = handleBrokerRequest(checksRequest, "relay", relay, requests, 2009, operations);
    if (checks.kind !== "fixture_dispatch_checks") throw new Error("Expected bounded native checks");
    assert.equal(checks.payload.checks[0]?.checkId, inspection.checkId);
    assert.equal(checks.payload.checks[0]?.text, prepared.payload.preview.text);
    assert.equal(JSON.stringify(checks.payload).includes(prepared.payload.recoveryToken), false);
    assert.deepEqual(handleBrokerRequest(checksRequest, "facade", owner, requests, 2009, operations).payload,
      { code: "PERMISSION_DENIED" });
    const completion = { ...envelope, kind: "complete_fixture_dispatch_check", payload: {
      target, operationId, checkId: inspection.checkId, observation: { ok: true, editor: "textarea",
        draftText: prepared.payload.preview.text, selected: true, writable: true, submitReady: true }
    } };
    assert.deepEqual(handleBrokerRequest(completion, "facade", owner, requests, 2009, operations).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest({ ...completion, payload: { ...completion.payload,
      target: { ...target, documentId: "changed" } } }, "relay", relay, requests, 2009, operations).payload,
    { accepted: false });
    assert.throws(() => handleBrokerRequest({ ...completion, payload: { ...completion.payload,
      observation: { ...completion.payload.observation, approved: true } } }, "relay", relay, requests, 2009, operations));
    assert.deepEqual(handleBrokerRequest(completion, "relay", relay, requests, 2009, operations).payload,
      { accepted: true });
    assert.deepEqual(handleBrokerRequest(completion, "relay", relay, requests, 2009, operations).payload,
      { accepted: false });
    assert.deepEqual(handleBrokerRequest(checksRequest, "relay", relay, requests, 2009, operations).payload, { checks: [] });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM message_dispatch_attempts").get() as { count: number }).count, 0);
    assert.throws(() => handleBrokerRequest({ ...envelope, kind: "record_fixture_dispatch_start", payload: { operationId } },
      "facade", owner, requests, 2009, operations));
    requests.revokeAllFixtures();
    assert.equal(operations.getFixtureSendAuthorization(owner, operationId, 2010), null);
    assert.deepEqual(handleBrokerRequest(listing, "relay", relay, requests, 2010, operations).payload,
      { reviews: [], hasMore: false });
  } finally {
    database.close();
  }
});

test("only an owning facade prepares immutable fixture text without approval or dispatch", () => {
  const requests = new PendingConnectionRequests();
  const database = new DatabaseSync(":memory:");
  try {
    const operations = new PreparedMessageOperations(requests, database);
    const owner = Symbol("fixture owner");
    const stranger = Symbol("other facade");
    const pending = requests.create(owner, 1000);
    const envelope = { protocolVersion: PROTOCOL_VERSION,
      requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
    const prepare = { ...envelope, kind: "prepare_fixture_message", payload: {
      connectionId: "a66b3997-9d43-4554-8399-267d1fe9f75c", expectedGeneration: 1,
      text: "Synthetic fixture-only draft", idempotencyKey: "b66b3997-9d43-4554-8399-267d1fe9f75c"
    } };
    assert.deepEqual(handleBrokerRequest(prepare, "facade", owner, requests, 2000, operations).payload,
      { code: "CONNECTION_NOT_FOUND" });
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const owned = { ...prepare, payload: { ...prepare.payload, connectionId: grant.connectionId } };
    assert.deepEqual(handleBrokerRequest(owned, "relay", stranger, requests, 2001, operations).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest(owned, "facade", stranger, requests, 2001, operations).payload,
      { code: "CONNECTION_NOT_FOUND" });
    const prepared = handleBrokerRequest(owned, "facade", owner, requests, 2001, operations);
    if (prepared.kind !== "message_prepared") throw new Error("Expected prepared fixture text");
    assert.equal(prepared.payload.state, "awaiting_approval");
    assert.equal(prepared.payload.preview.text, owned.payload.text);
    assert.match(prepared.payload.recoveryToken, /^[0-9a-f]{64}$/);
    const preflight = { ...envelope, kind: "check_fixture_preflight", payload: {
      operationId: prepared.payload.operationId
    } };
    assert.deepEqual(handleBrokerRequest(preflight, "facade", owner, requests, 2002, operations).payload,
      { code: "OPERATION_UNAVAILABLE" });
    assert.deepEqual(handleBrokerRequest(preflight, "relay", stranger, requests, 2002, operations).payload,
      { code: "PERMISSION_DENIED" });
    const status = { ...envelope, kind: "get_prepared_operation", payload: {
      operationId: prepared.payload.operationId
    } };
    assert.deepEqual(handleBrokerRequest(status, "relay", stranger, requests, 2002, operations).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest(status, "facade", stranger, requests, 2002, operations).payload,
      { state: "unknown" });
    assert.deepEqual(handleBrokerRequest(status, "facade", owner, requests, 2002, operations).payload,
      { operationId: prepared.payload.operationId, state: "awaiting_approval",
        expiresAt: prepared.payload.expiresAt });
    const list = { ...envelope, kind: "list_fixture_prepared_reviews", payload: { target } };
    assert.deepEqual(handleBrokerRequest(list, "facade", owner, requests, 2002, operations).payload,
      { code: "PERMISSION_DENIED" });
    const listed = handleBrokerRequest(list, "relay", stranger, requests, 2002, operations);
    if (listed.kind !== "fixture_prepared_reviews") throw new Error("Expected fixture review listing");
    const reviewId = listed.payload.reviews[0]?.reviewId;
    assert.ok(reviewId);
    assert.deepEqual(listed.payload, { reviews: [{ operationId: prepared.payload.operationId, reviewId,
      expiresAt: prepared.payload.expiresAt, preview: prepared.payload.preview }], hasMore: false });
    assert.deepEqual(handleBrokerRequest({ ...list, payload: { target: { ...target,
      documentId: "other-document" } } }, "relay", stranger, requests, 2002, operations).payload,
    { reviews: [], hasMore: false });
    assert.deepEqual(handleBrokerRequest(owned, "facade", owner, requests, 2002, operations).payload,
      prepared.payload);
    assert.deepEqual(handleBrokerRequest({ ...owned, payload: { ...owned.payload, text: "Changed" } },
      "facade", owner, requests, 2002, operations).payload, { code: "IDEMPOTENCY_CONFLICT" });
    assert.throws(() => handleBrokerRequest({ ...owned, payload: { ...owned.payload, approved: true } },
      "facade", owner, requests, 2002, operations));
    const approveReview = { ...envelope, kind: "approve_fixture_review", payload: {
      target, operationId: prepared.payload.operationId, reviewId
    } };
    assert.deepEqual(handleBrokerRequest(approveReview, "facade", owner, requests, 2002, operations).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest({ ...approveReview, payload: { ...approveReview.payload,
      target: { ...target, documentId: "other-document" } } }, "relay", stranger, requests, 2002, operations).payload,
    { code: "REVIEW_UNAVAILABLE" });
    assert.equal(handleBrokerRequest(approveReview, "relay", stranger, requests, 2002, operations).kind,
      "fixture_review_approved");
    assert.deepEqual(handleBrokerRequest(status, "facade", owner, requests, 2002, operations).payload,
      { operationId: prepared.payload.operationId, state: "approved", expiresAt: prepared.payload.expiresAt,
        approvalExpiresAt: 2002 + FIXTURE_REVIEW_APPROVAL_TTL_MS });
    const fillList = { ...envelope, kind: "list_fixture_fill_reviews", payload: { target } };
    assert.deepEqual(handleBrokerRequest(fillList, "facade", owner, requests, 2003, operations).payload,
      { code: "PERMISSION_DENIED" });
    const fillListed = handleBrokerRequest(fillList, "relay", stranger, requests, 2003, operations);
    if (fillListed.kind !== "fixture_fill_reviews") throw new Error("Expected a separate fill review");
    const fillReviewId = fillListed.payload.reviews[0]?.reviewId;
    assert.ok(fillReviewId);
    assert.notEqual(fillReviewId, reviewId);
    assert.equal(fillListed.payload.reviews[0]?.preview.text, prepared.payload.preview.text);
    assert.equal(JSON.stringify(fillListed.payload).includes(prepared.payload.recoveryToken), false);
    const approveFill = { ...envelope, kind: "approve_fixture_fill_review", payload: {
      target, operationId: prepared.payload.operationId, reviewId: fillReviewId
    } };
    assert.deepEqual(handleBrokerRequest(approveFill, "facade", owner, requests, 2003, operations).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest({ ...approveFill, payload: { ...approveFill.payload, reviewId } },
      "relay", stranger, requests, 2003, operations).payload, { code: "FILL_REVIEW_UNAVAILABLE" });
    assert.deepEqual(handleBrokerRequest({ ...approveFill, payload: { ...approveFill.payload,
      target: { ...target, documentId: "other-document" } } }, "relay", stranger, requests, 2003, operations).payload,
    { code: "FILL_REVIEW_UNAVAILABLE" });
    assert.throws(() => handleBrokerRequest({ ...approveFill, payload: { ...approveFill.payload, approved: true } },
      "relay", stranger, requests, 2003, operations));
    const fillConsent = handleBrokerRequest(approveFill, "relay", stranger, requests, 2003, operations);
    if (fillConsent.kind !== "fixture_fill_review_approved") throw new Error("Expected separate fill consent");
    assert.equal(fillConsent.payload.state, "fill_approved");
    assert.equal(fillConsent.payload.expiresAt, 2002 + FIXTURE_REVIEW_APPROVAL_TTL_MS);
    assert.deepEqual(handleBrokerRequest(approveFill, "relay", stranger, requests, 2003, operations).payload,
      { code: "FILL_REVIEW_UNAVAILABLE" });
    assert.equal(operations.getFixtureFillAuthorization(stranger, prepared.payload.operationId, 2003), null);
    const fillRequest = { ...envelope, kind: "fill_fixture_draft", payload: { operationId: prepared.payload.operationId } };
    assert.deepEqual(handleBrokerRequest(fillRequest, "relay", stranger, requests, 2003, operations).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest(fillRequest, "facade", stranger, requests, 2003, operations).payload,
      { code: "FILL_UNAVAILABLE" });
    assert.deepEqual(handleBrokerRequest(fillRequest, "facade", owner, requests, 2003, operations), {
      ...envelope, kind: "fixture_fill_authorized", payload: { operationId: prepared.payload.operationId }
    });
    assert.throws(() => handleBrokerRequest({ ...fillRequest, payload: { ...fillRequest.payload, text: "Changed" } },
      "facade", owner, requests, 2003, operations));
    const filling = operations.requestFixtureFill(owner, prepared.payload.operationId, 2003);
    if (!filling || filling === "busy") throw new Error("Expected consented fixture fill");
    const completeFill = { ...envelope, kind: "complete_fixture_fill", payload: {
      target, attemptId: filling.attemptId, observation: { ok: false, code: "DRAFT_PRESENT" }
    } };
    assert.deepEqual(handleBrokerRequest(completeFill, "facade", owner, requests, 2004, operations).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest({ ...completeFill, payload: { ...completeFill.payload,
      target: { ...target, documentId: "other-document" } } }, "relay", stranger, requests, 2004, operations).payload,
    { accepted: false });
    assert.deepEqual(handleBrokerRequest(completeFill, "relay", stranger, requests, 2004, operations).payload,
      { accepted: true });
    assert.deepEqual(handleBrokerRequest(completeFill, "relay", stranger, requests, 2004, operations).payload,
      { accepted: false });
    assert.deepEqual(handleBrokerRequest(fillRequest, "facade", owner, requests, 2004, operations).payload,
      { code: "FILL_UNAVAILABLE" });
    assert.deepEqual(handleBrokerRequest(preflight, "facade", stranger, requests, 2003, operations).payload,
      { code: "OPERATION_UNAVAILABLE" });
    assert.deepEqual(handleBrokerRequest(preflight, "facade", owner, requests, 2003, operations), {
      ...envelope, kind: "fixture_preflight_authorized", payload: { operationId: prepared.payload.operationId }
    });
    const check = operations.requestFixturePreflight(owner, prepared.payload.operationId, 2003);
    if (!check || check === "busy") throw new Error("Expected a queued preflight");
    const listing = handleBrokerRequest({ ...envelope, kind: "list_fixture_read_challenges", payload: {} },
      "relay", stranger, requests, 2003, operations);
    if (listing.kind !== "fixture_read_challenges") throw new Error("Expected native watch metadata");
    assert.equal(listing.payload.preflightChecks.length, 1);
    assert.equal(JSON.stringify(listing.payload).includes(prepared.payload.recoveryToken), false);
    const complete = { ...envelope, kind: "complete_fixture_preflight", payload: {
      target, challengeId: check.challengeId, observation: { ok: true, editor: "textarea" }
    } };
    assert.deepEqual(handleBrokerRequest(complete, "facade", owner, requests, 2004, operations).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest({ ...complete, payload: { ...complete.payload, target: { ...target,
      documentId: "wrong-document" } } }, "relay", stranger, requests, 2004, operations).payload, { accepted: false });
    assert.deepEqual(handleBrokerRequest(complete, "relay", stranger, requests, 2004, operations).payload,
      { accepted: true });
    assert.deepEqual(handleBrokerRequest(complete, "relay", stranger, requests, 2005, operations).payload,
      { accepted: false });
    assert.throws(() => handleBrokerRequest({ ...complete, payload: { ...complete.payload,
      observation: { ok: true, editor: "textarea", draftText: "Synthetic page draft" } } },
    "relay", stranger, requests, 2005, operations));
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
    assert.deepEqual(handleBrokerRequest(approveReview, "relay", stranger, requests, 2002, operations).payload,
      { code: "REVIEW_UNAVAILABLE" });
    requests.revokeChangedTab(3, null);
    assert.equal(operations.getFixtureFillAuthorization(owner, prepared.payload.operationId, 2003), null);
    assert.deepEqual(handleBrokerRequest(preflight, "facade", owner, requests, 2003, operations).payload,
      { code: "OPERATION_UNAVAILABLE" });
    assert.deepEqual(handleBrokerRequest(status, "facade", owner, requests, 2003, operations).payload,
      { operationId: prepared.payload.operationId, state: "stale" });
    assert.deepEqual(handleBrokerRequest(list, "relay", stranger, requests, 2003, operations).payload,
      { reviews: [], hasMore: false });
    assert.deepEqual(handleBrokerRequest(owned, "facade", owner, requests, 2003, operations).payload,
      { code: "CONNECTION_NOT_FOUND" });
    const geminiPending = requests.create(owner, 1000);
    const gemini = requests.approveGemini(geminiPending.requestId, { origin: "https://gemini.google.com",
      conversationId: "disposable-chat", url: "https://gemini.google.com/app/disposable-chat?hl=en",
      tabId: 4, documentId: "CHROME-doc_gemini-42" }, 2000)!;
    assert.deepEqual(handleBrokerRequest({ ...owned, payload: { ...owned.payload,
      connectionId: gemini.connectionId } }, "facade", owner, requests, 2003, operations).payload,
    { code: "CONNECTION_NOT_FOUND" });
  } finally {
    database.close();
  }
});

test("a facade receipt recovers only uncertain operation status after an owner restart", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const requests = new PendingConnectionRequests();
    const owner = Symbol("preparing owner");
    const operations = new PreparedMessageOperations(requests, database);
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const envelope = { protocolVersion: PROTOCOL_VERSION,
      requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
    const prepared = handleBrokerRequest({ ...envelope, kind: "prepare_fixture_message", payload: {
      connectionId: grant.connectionId, expectedGeneration: 1, text: "Synthetic recovery preview",
      idempotencyKey: "b66b3997-9d43-4554-8399-267d1fe9f75c"
    } }, "facade", owner, requests, 2001, operations);
    if (prepared.kind !== "message_prepared") throw new Error("Expected fixture recovery receipt");
    const recover = { ...envelope, kind: "get_prepared_operation", payload: {
      operationId: prepared.payload.operationId, recoveryToken: prepared.payload.recoveryToken
    } };
    assert.deepEqual(handleBrokerRequest(recover, "facade", owner, requests, 2002, operations).payload,
      { state: "unknown" });
    const [review] = operations.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    assert.equal(JSON.stringify(review).includes(prepared.payload.recoveryToken), false);
    operations.approveFixtureReview(target, prepared.payload.operationId, review.reviewId, 2003);
    database.prepare("INSERT INTO message_dispatch_attempts (operation_id, started_at, state) VALUES (?, ?, 'dispatching')")
      .run(prepared.payload.operationId, 2004);

    const restartedRequests = new PendingConnectionRequests();
    const restarted = new PreparedMessageOperations(restartedRequests, database);
    const reader = Symbol("new facade session");
    assert.deepEqual(handleBrokerRequest({ ...recover, payload: { operationId: prepared.payload.operationId } },
      "facade", reader, restartedRequests, 2005, restarted).payload, { state: "unknown" });
    assert.deepEqual(handleBrokerRequest({ ...recover, payload: { ...recover.payload, recoveryToken: "0".repeat(64) } },
      "facade", reader, restartedRequests, 2005, restarted).payload, { state: "unknown" });
    assert.deepEqual(handleBrokerRequest(recover, "relay", reader, restartedRequests, 2005, restarted).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest(recover, "facade", reader, restartedRequests, 2005, restarted), {
      ...envelope, kind: "prepared_operation_state", payload: {
        operationId: prepared.payload.operationId, state: "dispatch_uncertain", startedAt: 2004
      }
    });
    assert.deepEqual(restarted.getOperation(reader, prepared.payload.operationId, 2005), { state: "unknown" });
    assert.equal(restartedRequests.getApprovedTarget(reader, grant.connectionId, 2005), null);
    const operationId = prepared.payload.operationId;
    assert.throws(() => restarted.recordFixtureDispatchStart(reader, operationId, 2005), /APPROVAL_REQUIRED/);
    assert.throws(() => handleBrokerRequest({ ...recover, payload: { ...recover.payload, recoveryToken: "invalid" } },
      "facade", reader, restartedRequests, 2005, restarted));
  } finally {
    database.close();
  }
});

test("only an owning facade can create and query pending connections", () => {
  const requests = new PendingConnectionRequests();
  const firstClient = Symbol("first facade");
  const secondClient = Symbol("second facade");
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "a66b3997-9d43-4554-8399-267d1fe9f75c",
    connectionGeneration: 0,
    deadlineMs: 20_000
  };
  const create = { ...envelope, kind: "request_connection", payload: {} };

  assert.deepEqual(handleBrokerRequest(create, "relay", firstClient, requests, 1000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  const created = handleBrokerRequest(create, "facade", firstClient, requests, 1000);
  assert.equal(created.kind, "connection_requested");
  if (created.kind !== "connection_requested") throw new Error("Expected a pending request");
  const get = { ...envelope, kind: "get_connection", payload: { requestId: created.payload.requestId } };
  const list = { ...envelope, kind: "list_pending", payload: {} };
  const approval = { ...envelope, kind: "approve_fixture", payload: {
    pendingRequestId: created.payload.requestId,
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "a66b3997-9d43-4554-8399-267d1fe9f75c" }
  } };
  assert.deepEqual(handleBrokerRequest(approval, "facade", firstClient, requests, 1000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  assert.deepEqual(handleBrokerRequest(list, "facade", firstClient, requests, 1000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  assert.deepEqual(handleBrokerRequest(list, "relay", secondClient, requests, 1000), {
    ...envelope, kind: "pending_list", payload: { requests: [{
      requestId: created.payload.requestId, expiresAt: created.payload.expiresAt
    }] }
  });
  assert.deepEqual(handleBrokerRequest({ ...list, deadlineMs: 1000 + PENDING_REQUEST_TTL_MS + 5000 },
    "relay", secondClient, requests, 1000 + PENDING_REQUEST_TTL_MS).payload, { requests: [] });

  assert.deepEqual(handleBrokerRequest(get, "facade", secondClient, requests, 1000), {
    ...envelope, kind: "connection_state", payload: { state: "unknown" }
  });
  assert.deepEqual(handleBrokerRequest(get, "facade", firstClient, requests, 1000).payload, created.payload);
  const expiredAt = 1000 + PENDING_REQUEST_TTL_MS;
  assert.deepEqual(handleBrokerRequest({ ...get, deadlineMs: expiredAt + 10_000 }, "facade", firstClient, requests,
    expiredAt).payload, { ...created.payload, state: "expired" });
  assert.throws(() => handleBrokerRequest({ ...create, kind: "evaluate" }, "facade", firstClient, requests, 1000));
  assert.throws(() => handleBrokerRequest({ ...create, deadlineMs: 1000 }, "facade", firstClient, requests, 1000));

  for (let index = 1; index < MAX_PENDING_REQUESTS; index++) requests.create(firstClient, 1000);
  assert.deepEqual(handleBrokerRequest(create, "facade", firstClient, requests, 1000), {
    ...envelope, kind: "error", payload: { code: "TOO_MANY_PENDING" }
  });
});

test("authenticated relay alone approves a selected fixture and only its MCP owner sees the grant", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("MCP owner");
  const stranger = Symbol("other client");
  const pending = requests.create(owner, 1000);
  const envelope = {
    protocolVersion: PROTOCOL_VERSION, requestId: "c783ef76-d6cd-4898-8c43-204543943bac",
    connectionGeneration: 0, deadlineMs: 10_000
  };
  const approval = { ...envelope, kind: "approve_fixture", payload: {
    pendingRequestId: pending.requestId,
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" }
  } };

  assert.equal(handleBrokerRequest(approval, "relay", stranger, requests, 2000).kind, "fixture_approved");
  assert.deepEqual(handleBrokerRequest(approval, "relay", stranger, requests, 2000), {
    ...envelope, kind: "error", payload: { code: "APPROVAL_INVALID" }
  });
  const lookup = { ...envelope, kind: "get_connection", payload: { requestId: pending.requestId } };
  assert.deepEqual(handleBrokerRequest(lookup, "facade", stranger, requests, 2000).payload, { state: "unknown" });
  const own = handleBrokerRequest(lookup, "facade", owner, requests, 2000);
  if (own.kind !== "connection_state") throw new Error("Expected owned connection state");
  assert.equal(own.payload.state, "ready_readonly");
  assert.equal("tabId" in own.payload, false);
  const revoke = { ...envelope, kind: "revoke_fixture", payload: {
    tabId: 3, observed: { documentId: "different-document", conversationId: "fixture-alpha" }
  } };
  assert.deepEqual(handleBrokerRequest(revoke, "facade", owner, requests, 2000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  assert.deepEqual(handleBrokerRequest(revoke, "relay", stranger, requests, 2000), {
    ...envelope, kind: "fixture_revoked", payload: { count: 1 }
  });
  assert.deepEqual(handleBrokerRequest(lookup, "facade", owner, requests, 2000).payload,
    { requestId: pending.requestId, state: "stale" });
  assert.deepEqual(handleBrokerRequest(revoke, "relay", stranger, requests, 2000).payload, { count: 0 });
  const reset = { ...envelope, kind: "revoke_all_fixture", payload: {} };
  assert.deepEqual(handleBrokerRequest(reset, "facade", owner, requests, 2000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  const another = requests.create(owner, 1000);
  requests.approve(another.requestId, { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
    tabId: 4, documentId: "CHROME-doc_opaque-42" }, 2000);
  assert.deepEqual(handleBrokerRequest(reset, "relay", stranger, requests, 2000), {
    ...envelope, kind: "fixture_revoked", payload: { count: 1 }
  });
  assert.throws(() => handleBrokerRequest({ ...reset, payload: { tabId: 4 } }, "relay", stranger, requests, 2000));
  assert.deepEqual(handleBrokerRequest({ ...approval, deadlineMs: 70_000 }, "relay", stranger, requests, 61_000), {
    ...envelope, deadlineMs: 70_000, kind: "error", payload: { code: "APPROVAL_INVALID" }
  });
});

test("a relay publishes bounded fixture rows but only the owning facade reads an approved snapshot", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("approved client");
  const stranger = Symbol("other client");
  const pending = requests.create(owner, 1000);
  const target = {
    origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42"
  };
  const envelope = {
    protocolVersion: PROTOCOL_VERSION, requestId: "c783ef76-d6cd-4898-8c43-204543943bac",
    connectionGeneration: 0, deadlineMs: 10_000
  };
  const messages = [
    { id: "fixture-1", direction: "incoming", text: "First" },
    { id: "fixture-2", direction: "outgoing", text: "Second" }
  ];
  const publish = { ...envelope, kind: "publish_fixture_snapshot", payload: { target, messages } };
  assert.deepEqual(handleBrokerRequest(publish, "facade", owner, requests, 2000).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(publish, "relay", stranger, requests, 2000).payload, { count: 0 });
  const grant = requests.approve(pending.requestId, target, 2000)!;
  const read = { ...envelope, kind: "read_fixture_snapshot", payload: { connectionId: grant.connectionId } };
  const genericRead = { ...envelope, kind: "read_approved_snapshot", payload: { connectionId: grant.connectionId } };
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", owner, requests, 2000), {
    ...envelope, kind: "fixture_read_authorized", payload: { connectionId: grant.connectionId, limit: 32 }
  });
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", stranger, requests, 2000).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(read, "facade", owner, requests, 2000), {
    ...envelope, kind: "fixture_read_authorized", payload: { connectionId: grant.connectionId, limit: 32 }
  });
  assert.deepEqual(handleBrokerRequest(read, "relay", stranger, requests, 2000).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(read, "facade", stranger, requests, 2000).payload,
    { code: "CONNECTION_NOT_FOUND" });
  const challenges = { ...envelope, kind: "list_fixture_read_challenges", payload: {} };
  assert.deepEqual(handleBrokerRequest(challenges, "facade", owner, requests, 2000).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2000).payload,
    { challenges: [], activeTabIds: [3], preflightChecks: [], draftFills: [] });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: { ...publish.payload, target: { ...target, tabId: 4 } } },
    "relay", stranger, requests, 2001).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest(publish, "relay", stranger, requests, 2001).payload, { count: 1 });
  assert.deepEqual(handleBrokerRequest({ ...read, payload: { ...read.payload, limit: 1 } },
    "facade", owner, requests, 2001), {
    ...envelope, kind: "fixture_read_authorized", payload: { connectionId: grant.connectionId, limit: 1 }
  });
  const initial = requests.getFixtureSnapshot(owner, grant.connectionId, 2001);
  if (!initial || initial === "not_ready") throw new Error("Expected an event cursor");
  const eventRead = { ...envelope, kind: "read_fixture_events", payload: {
    connectionId: grant.connectionId, cursor: initial.cursor, limit: 2
  } };
  assert.deepEqual(handleBrokerRequest(eventRead, "relay", stranger, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(eventRead, "facade", stranger, requests, 2001).payload,
    { code: "CONNECTION_NOT_FOUND" });
  const emptyPage = handleBrokerRequest(eventRead, "facade", owner, requests, 2001);
  if (emptyPage.kind !== "fixture_events" || emptyPage.payload.state !== "ok") {
    throw new Error("Expected an empty event page");
  }
  assert.deepEqual(emptyPage.payload.events, []);
  const later = [{ id: "fixture-3", direction: "incoming", text: "Later" }];
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: { target, messages: later } },
    "relay", stranger, requests, 2002).payload, { count: 1 });
  const observed = handleBrokerRequest(eventRead, "facade", owner, requests, 2002);
  assert.equal(observed.kind, "fixture_events");
  if (observed.kind !== "fixture_events" || observed.payload.state !== "ok") throw new Error("Expected a later event");
  assert.deepEqual(observed.payload.events[0]?.payload, { kind: "fixture_snapshot", messages: later });
  assert.equal(observed.payload.cursor.sequence, 2);
  assert.deepEqual(handleBrokerRequest({ ...eventRead, payload: { ...eventRead.payload,
    cursor: { epoch: "a66b3997-9d43-4554-8399-267d1fe9f75c", sequence: 1 } } },
  "facade", owner, requests, 2002).payload, { state: "expired", resnapshot: true });
  assert.throws(() => handleBrokerRequest({ ...publish, payload: { ...publish.payload, selector: "*" } },
    "relay", stranger, requests, 2001));
  assert.throws(() => handleBrokerRequest({ ...eventRead, payload: { ...eventRead.payload, limit: 3 } },
    "facade", owner, requests, 2002));
  assert.throws(() => handleBrokerRequest({ ...challenges, payload: { selector: "*" } },
    "relay", stranger, requests, 2001));
  assert.throws(() => handleBrokerRequest({ ...read, payload: { ...read.payload, limit: 33 } },
    "facade", owner, requests, 2001));
  requests.revokeAllFixtures();
  assert.deepEqual(handleBrokerRequest(read, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(eventRead, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
});

test("only the owning facade disconnects an approved fixture without exposing its tab", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("owner");
  const stranger = Symbol("stranger");
  const pending = requests.create(owner, 1000);
  const grant = requests.approve(pending.requestId, {
    origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
    tabId: 3, documentId: "CHROME-doc_opaque-42"
  }, 2000)!;
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const disconnect = { ...envelope, kind: "disconnect_fixture", payload: { connectionId: grant.connectionId } };
  assert.deepEqual(handleBrokerRequest(disconnect, "relay", stranger, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(disconnect, "facade", stranger, requests, 2001).payload,
    { disconnected: false });
  assert.deepEqual(handleBrokerRequest(disconnect, "facade", owner, requests, 2001), {
    ...envelope, kind: "fixture_disconnected", payload: { disconnected: true }
  });
  assert.deepEqual(handleBrokerRequest(disconnect, "facade", owner, requests, 2001).payload,
    { disconnected: false });
  assert.deepEqual(handleBrokerRequest({ ...envelope, kind: "get_connection",
    payload: { requestId: pending.requestId } }, "facade", owner, requests, 2001).payload,
    { requestId: pending.requestId, state: "stale" });
  assert.deepEqual(handleBrokerRequest({ ...envelope, kind: "list_fixture_read_challenges", payload: {} },
    "relay", stranger, requests, 2001).payload, { challenges: [], activeTabIds: [], preflightChecks: [], draftFills: [] });
  assert.throws(() => handleBrokerRequest({ ...disconnect, payload: { ...disconnect.payload, tabId: 3 } },
    "facade", owner, requests, 2001));
});

test("generic event reads follow the owned Gemini grant and not a caller-selected provider", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("Gemini reader");
  const other = Symbol("second facade");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com" as const,
    conversationId: "disposable-chat", url: "https://gemini.google.com/app/disposable-chat?hl=en",
    tabId: 4, documentId: "CHROME-doc_gemini-42" };
  const grant = requests.approveGemini(pending.requestId, target, 2000)!;
  const firstRows = [{ direction: "outgoing" as const, text: "Synthetic question" }];
  requests.publishGeminiSnapshot(target, firstRows, 2001);
  const first = requests.getGeminiSnapshot(owner, grant.connectionId, 2001);
  if (!first || first === "not_ready") throw new Error("Expected a Gemini cursor");
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const read = { ...envelope, kind: "read_approved_events", payload: {
    connectionId: grant.connectionId, cursor: first.cursor, limit: 1
  } };
  assert.deepEqual(handleBrokerRequest(read, "relay", other, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(read, "facade", other, requests, 2001).payload,
    { code: "CONNECTION_NOT_FOUND" });
  const empty = handleBrokerRequest(read, "facade", owner, requests, 2001);
  if (empty.kind !== "gemini_events" || empty.payload.state !== "ok") throw new Error("Expected empty Gemini events");
  assert.deepEqual(empty.payload.events, []);
  const laterRows = [...firstRows, { direction: "incoming" as const, text: "Synthetic reply" }];
  requests.publishGeminiSnapshot({ ...target, url: `${target.url}&changed=1` }, laterRows, 2002);
  const unchanged = handleBrokerRequest(read, "facade", owner, requests, 2002);
  if (unchanged.kind !== "gemini_events" || unchanged.payload.state !== "ok") {
    throw new Error("Expected unchanged Gemini events");
  }
  assert.deepEqual(unchanged.payload.events, []);
  requests.publishGeminiSnapshot(target, laterRows, 2002);
  const later = handleBrokerRequest(read, "facade", owner, requests, 2002);
  if (later.kind !== "gemini_events" || later.payload.state !== "ok") throw new Error("Expected Gemini update");
  assert.deepEqual(later.payload.events[0]?.payload, { kind: "gemini_snapshot", messages: laterRows.map((row) => ({
    ...row, identityQuality: "uncertain", generationState: "unknown"
  })) });
  assert.deepEqual(handleBrokerRequest({ ...read, payload: { ...read.payload,
    cursor: { epoch: "a66b3997-9d43-4554-8399-267d1fe9f75c", sequence: 1 } } },
  "facade", owner, requests, 2002).payload, { state: "expired", resnapshot: true });
  assert.throws(() => handleBrokerRequest({ ...read, payload: { ...read.payload, provider: "fixture" } },
    "facade", owner, requests, 2002));
  requests.disconnectFixture(owner, grant.connectionId, 2003);
  assert.deepEqual(handleBrokerRequest(read, "facade", owner, requests, 2003).payload,
    { code: "CONNECTION_NOT_FOUND" });
});

test("only an authenticated relay can mark an exact fixture observation gap", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("owner");
  const pending = requests.create(owner, 1000);
  const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42" };
  const grant = requests.approve(pending.requestId, target, 2000)!;
  const rows = [{ id: "fixture-1", direction: "incoming" as const, text: "Observed" }];
  requests.publishFixtureSnapshot(target, rows, 2001);
  const old = requests.getFixtureSnapshot(owner, grant.connectionId, 2001);
  if (!old || old === "not_ready") throw new Error("Expected old snapshot cursor");
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const gap = { ...envelope, kind: "mark_fixture_observation_gap", payload: { target } };
  assert.deepEqual(handleBrokerRequest(gap, "facade", owner, requests, 2002).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest({ ...gap, payload: { target: { ...target, tabId: 4 } } },
    "relay", Symbol("relay"), requests, 2002).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest(gap, "relay", Symbol("relay"), requests, 2002), {
    ...envelope, kind: "fixture_gap_marked", payload: { count: 1 }
  });
  assert.deepEqual(requests.readFixtureEvents(owner, grant.connectionId, old.cursor, 1, 2002),
    { state: "expired", resnapshot: true });
  assert.equal(requests.get(owner, pending.requestId, 2002)?.state, "ready_readonly");
  assert.throws(() => handleBrokerRequest({ ...gap, payload: { ...gap.payload, selector: "*" } },
    "relay", Symbol("relay"), requests, 2002));
});

test("only a relay approves one exact Gemini chat and its MCP owner sees no browser IDs", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("selected chat owner");
  const stranger = Symbol("another MCP client");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com", conversationId: "disposable-chat",
    url: "https://gemini.google.com/app/disposable-chat", tabId: 4, documentId: "CHROME-doc_gemini-42" };
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const approval = { ...envelope, kind: "approve_gemini", payload: {
    pendingRequestId: pending.requestId, target
  } };
  assert.deepEqual(handleBrokerRequest(approval, "facade", owner, requests, 2000).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest({ ...approval, payload: {
    ...approval.payload, target: { ...target, url: `${target.url}/other` }
  } }, "relay", stranger, requests, 2000).payload, { code: "APPROVAL_INVALID" });
  assert.equal(handleBrokerRequest(approval, "relay", stranger, requests, 2000).kind, "gemini_approved");
  assert.deepEqual(handleBrokerRequest(approval, "relay", stranger, requests, 2000).payload,
    { code: "APPROVAL_INVALID" });
  const lookup = { ...envelope, kind: "get_connection", payload: { requestId: pending.requestId } };
  assert.deepEqual(handleBrokerRequest(lookup, "facade", stranger, requests, 2001).payload,
    { state: "unknown" });
  const state = handleBrokerRequest(lookup, "facade", owner, requests, 2001);
  assert.equal(state.kind, "connection_state");
  assert.equal(state.payload.state, "ready_readonly");
  assert.equal(state.payload.origin, target.origin);
  assert.equal("tabId" in state.payload, false);
  assert.equal("documentId" in state.payload, false);
  assert.equal("url" in state.payload, false);
  assert.deepEqual(handleBrokerRequest({ ...envelope, kind: "read_fixture_snapshot", payload: {
    connectionId: "a66b3997-9d43-4554-8399-267d1fe9f75c"
  } }, "facade", owner, requests, 2001).payload, { code: "CONNECTION_NOT_FOUND" });
  const rows = [{ direction: "outgoing", text: "OK" }, { direction: "outgoing", text: "OK" }];
  const publish = { ...envelope, kind: "publish_gemini_snapshot", payload: { target, messages: rows } };
  const challenges = { ...envelope, kind: "list_gemini_read_challenges", payload: {} };
  assert.deepEqual(handleBrokerRequest(challenges, "facade", owner, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2001).payload,
    { challenges: [], activeTabIds: [4] });
  assert.deepEqual(handleBrokerRequest(publish, "facade", owner, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: {
    target: { ...target, url: `${target.url}?hl=en` }, messages: rows
  } }, "relay", stranger, requests, 2001).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: {
    target: { ...target, documentId: "other" }, messages: rows
  } }, "relay", stranger, requests, 2001).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest(publish, "relay", stranger, requests, 2001), {
    ...envelope, kind: "gemini_snapshot_published", payload: { count: 1 }
  });
  const connection = requests.get(owner, pending.requestId, 2001);
  if (connection?.state !== "ready_readonly") throw new Error("Expected a Gemini connection");
  const geminiRead = { ...envelope, kind: "read_gemini_snapshot", payload: {
    connectionId: connection.connectionId, limit: 1
  } };
  const genericRead = { ...envelope, kind: "read_approved_snapshot", payload: {
    connectionId: connection.connectionId, limit: 1
  } };
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", owner, requests, 2001), {
    ...envelope, kind: "gemini_read_authorized", payload: { connectionId: connection.connectionId, limit: 1 }
  });
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", stranger, requests, 2001).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(geminiRead, "relay", stranger, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(geminiRead, "facade", stranger, requests, 2001).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(geminiRead, "facade", owner, requests, 2001), {
    ...envelope, kind: "gemini_read_authorized", payload: { connectionId: connection.connectionId, limit: 1 }
  });
  assert.deepEqual(handleBrokerRequest({ ...geminiRead, payload: { ...geminiRead.payload,
    connectionId: pending.requestId } }, "facade", owner, requests, 2001).payload,
  { code: "CONNECTION_NOT_FOUND" });
  assert.throws(() => handleBrokerRequest({ ...geminiRead, payload: { ...geminiRead.payload, limit: 33 } },
    "facade", owner, requests, 2001));
  assert.equal(requests.getGeminiSnapshot(stranger, connection.connectionId, 2001), null);
  const observed = requests.getGeminiSnapshot(owner, connection.connectionId, 2001);
  if (!observed || observed === "not_ready") throw new Error("Expected a private Gemini snapshot");
  assert.deepEqual(observed.messages.map(({ direction, text }) => ({ direction, text })), rows);
  const reading = requests.requestFreshGeminiRead(owner, connection.connectionId, 2002);
  if (!reading || reading === "busy") throw new Error("Expected a Gemini read challenge");
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2002).payload, {
    challenges: [{ challengeId: reading.challengeId, target, expiresAt: 2002 + GEMINI_READ_TIMEOUT_MS }],
    activeTabIds: [4]
  });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: { ...publish.payload,
    target: { ...target, url: `${target.url}?hl=en` }, challengeId: reading.challengeId } },
  "relay", stranger, requests, 2003).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: { ...publish.payload,
    challengeId: reading.challengeId } }, "relay", stranger, requests, 2003).payload, { count: 1 });
  const challenged = await reading.result;
  if (!challenged || challenged === "not_ready") throw new Error("Expected challenged Gemini snapshot");
  assert.deepEqual(challenged.messages.map(({ direction, text }) => ({ direction, text })), rows);
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2003).payload,
    { challenges: [], activeTabIds: [4] });
  assert.equal("messages" in handleBrokerRequest(lookup, "facade", owner, requests, 2001).payload, false);
  assert.throws(() => handleBrokerRequest({ ...challenges, payload: { tabId: 4 } },
    "relay", stranger, requests, 2003));
  assert.throws(() => handleBrokerRequest({ ...publish, payload: { ...publish.payload,
    challengeId: "not-a-uuid" } }, "relay", stranger, requests, 2003));
  assert.throws(() => handleBrokerRequest({ ...publish, payload: { ...publish.payload, selector: "*" } },
    "relay", stranger, requests, 2001));
  assert.equal(requests.revokeChangedTab(4, null), 1);
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2003).payload,
    { challenges: [], activeTabIds: [] });
  assert.deepEqual(handleBrokerRequest(publish, "relay", stranger, requests, 2002).payload, { count: 0 });
  assert.equal(requests.getGeminiSnapshot(owner, connection.connectionId, 2002), null);
  assert.deepEqual(handleBrokerRequest(geminiRead, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.throws(() => handleBrokerRequest({ ...approval, payload: {
    ...approval.payload, target: { ...target, selector: "*" }
  } }, "relay", stranger, requests, 2000));
});