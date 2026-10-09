import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { on, once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { connectBroker } from "./broker-client.js";
import { MAX_BROKER_PENDING_REQUESTS } from "./broker-roles.js";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { handleNativeHandshake, isNativeCaller, nativeBrokerFailureReason, parseNativeFixtureApproval, parseNativeFixtureGap,
  parseNativeGeminiGap,
  parseNativeFixtureReadChallenges, parseNativeFixturePreparedReviews, parseNativeFixtureReviewApproval,
  parseNativeFixtureFillReviews, parseNativeFixtureFillReviewApproval,
  parseNativeGeminiPreparedReviews, parseNativeGeminiReviewApproval,
  parseNativeGeminiFillReviews, parseNativeGeminiFillReviewApproval,
  parseNativeFixtureSendReviews, parseNativeFixtureSendReviewApproval,
  parseNativeFixtureFill, parseNativeFixturePreflight,
  parseNativeFixtureDispatchCheck, parseNativeFixtureDispatchChecks,
  parseNativeFixtureDispatch, parseNativeFixtureDispatchAttempts,
  parseNativeFixtureReset, parseNativeFixtureRevocation,
  parseNativeFixtureSnapshot, parseNativeGeminiApproval, parseNativeGeminiReadChallenges,
  parseNativeGeminiSnapshot, parseNativePendingList,
  PROTOCOL_VERSION }
  from "./native-protocol.js";

const origin = `chrome-extension://${"a".repeat(32)}/`;
const now = 1_750_000_000_000;
const request = {
  kind: "handshake",
  protocolVersion: PROTOCOL_VERSION,
  requestId: "7f9ca8a2-4e96-48d8-8997-51abcc7e8085",
  connectionGeneration: 0,
  deadlineMs: now + 10_000,
  payload: {}
};

test("native Gemini draft review and fill consent reject arbitrary authority and invalid exact targets", () => {
  const target = { origin: "https://gemini.google.com", conversationId: "synthetic-chat",
    url: "https://gemini.google.com/app/synthetic-chat?hl=en", tabId: 3, documentId: "synthetic-document" };
  for (const [kind, parse, approval] of [
    ["list_gemini_prepared_reviews", parseNativeGeminiPreparedReviews, false],
    ["approve_gemini_review", parseNativeGeminiReviewApproval, true],
    ["list_gemini_fill_reviews", parseNativeGeminiFillReviews, false],
    ["approve_gemini_fill_review", parseNativeGeminiFillReviewApproval, true]
  ] as const) {
    const message = { ...request, kind, payload: approval
      ? { target, operationId: randomUUID(), reviewId: randomUUID() } : { target } };
    assert.deepEqual(parse(message, now), message);
    assert.deepEqual(parse({ ...message, deadlineMs: now + 30_000 }, now), { ...message, deadlineMs: now + 30_000 });
    for (const invalid of [
      { ...message, kind: "approve_gemini_send_review" }, { ...message, connectionGeneration: 1 },
      { ...message, protocolVersion: 2 }, { ...message, deadlineMs: now },
      { ...message, deadlineMs: now + 30_001 }, { ...message, deadlineMs: now + 0.5 },
      { ...message, selector: "textarea" },
      ...[{ approved: true }, { send: true }, { text: "Synthetic raw draft" }, { selector: "button" },
        { command: "navigate" }, { recoveryToken: "a".repeat(64) }].map(extra =>
        ({ ...message, payload: { ...message.payload, ...extra } })),
      ...[{ origin: "http://127.0.0.1:8787" }, { url: "https://other.invalid/app/synthetic-chat" },
        { url: `${target.url}#fragment` }, { conversationId: "other" }, { tabId: 0 },
        { documentId: "line\nbreak" }, { url: "x".repeat(513) }].map(changed =>
        ({ ...message, payload: { ...message.payload, target: { ...target, ...changed } } }))
    ]) assert.throws(() => parse(invalid, now), /Invalid native Gemini/, kind);
    if (approval) {
      assert.throws(() => parse({ ...message, payload: { ...message.payload, operationId: "invalid" } }, now), /Invalid native Gemini/);
      assert.throws(() => parse({ ...message, payload: { ...message.payload, reviewId: "invalid" } }, now), /Invalid native Gemini/);
    }
  }
});

test("native dispatch inspection accepts only bounded exact proof, never approval or submission", () => {
  const listing = { ...request, kind: "list_fixture_dispatch_checks" };
  assert.deepEqual(parseNativeFixtureDispatchChecks(listing, now), listing);
  for (const invalid of [{ ...listing, payload: { operationId: request.requestId } },
    { ...listing, payload: { selector: "button" } }, { ...listing, deadlineMs: now },
    { ...listing, deadlineMs: now + 30_001 }, { ...listing, kind: "dispatch_fixture_message" }]) {
    assert.throws(() => parseNativeFixtureDispatchChecks(invalid, now), /Invalid native fixture dispatch check list/);
  }
  const completion = { ...request, kind: "complete_fixture_dispatch_check", payload: {
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" }, operationId: request.requestId, checkId: randomUUID(),
    observation: { ok: true, editor: "textarea", draftText: "Synthetic exact draft",
      selected: true, writable: true, submitReady: true }
  } };
  assert.deepEqual(parseNativeFixtureDispatchCheck(completion, now), completion);
  const denied = { ...completion, payload: { ...completion.payload, observation: { ok: false, code: "DRAFT_CHANGED" } } };
  assert.deepEqual(parseNativeFixtureDispatchCheck(denied, now), denied);
  for (const invalid of [
    { ...completion, payload: { ...completion.payload, approved: true } },
    { ...completion, payload: { ...completion.payload, checkId: "not-a-challenge" } },
    { ...completion, payload: { ...completion.payload, target: { ...completion.payload.target, origin: "https://gemini.google.com" } } },
    { ...completion, payload: { ...completion.payload, observation: { ...completion.payload.observation, draftText: "x".repeat(2049) } } },
    { ...completion, payload: { ...completion.payload, observation: { ...completion.payload.observation, selected: false } } },
    { ...completion, payload: { ...completion.payload, observation: { ...completion.payload.observation, writable: false } } },
    { ...completion, payload: { ...completion.payload, observation: { ...completion.payload.observation, submitReady: false } } },
    { ...completion, payload: { ...completion.payload, observation: { ...completion.payload.observation, approved: true } } },
    { ...denied, payload: { ...denied.payload, observation: { ok: false, code: "DRAFT_CHANGED", detail: "private" } } },
    { ...completion, kind: "dispatch_fixture_message" }, { ...completion, deadlineMs: now }
  ]) assert.throws(() => parseNativeFixtureDispatchCheck(invalid, now), /Invalid native fixture dispatch check/);
});

test("native dispatch completion carries only bounded activation metadata, never delivery or submit commands", () => {
  const listing = { ...request, kind: "list_fixture_dispatch_attempts" };
  assert.deepEqual(parseNativeFixtureDispatchAttempts(listing, now), listing);
  for (const invalid of [{ ...listing, payload: { approved: true } }, { ...listing, payload: { selector: "button" } },
    { ...listing, kind: "dispatch_fixture_message" }, { ...listing, deadlineMs: now },
    { ...listing, deadlineMs: now + 30_001 }]) {
    assert.throws(() => parseNativeFixtureDispatchAttempts(invalid, now), /Invalid native fixture dispatch attempt list/);
  }
  const completion = { ...request, kind: "complete_fixture_dispatch", payload: {
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" }, operationId: request.requestId, attemptId: request.requestId,
    observation: { ok: true, editor: "textarea", activated: true }
  } };
  assert.deepEqual(parseNativeFixtureDispatch(completion, now), completion);
  const uncertain = { ...completion, payload: { ...completion.payload, observation: { ok: false, code: "DISPATCH_UNCERTAIN" } } };
  assert.deepEqual(parseNativeFixtureDispatch(uncertain, now), uncertain);
  for (const invalid of [
    { ...completion, payload: { ...completion.payload, delivered: true } },
    { ...completion, payload: { ...completion.payload, observation: { ...completion.payload.observation, delivered: true } } },
    { ...completion, payload: { ...completion.payload, observation: { ...completion.payload.observation, activated: false } } },
    { ...completion, payload: { ...completion.payload, observation: { ...completion.payload.observation, text: "private" } } },
    { ...uncertain, payload: { ...uncertain.payload, observation: { ok: false, code: "DISPATCH_UNCERTAIN", detail: "private" } } },
    { ...completion, payload: { ...completion.payload, target: { ...completion.payload.target, origin: "https://gemini.google.com" } } },
    { ...completion, kind: "dispatch_fixture_message" }, { ...completion, deadlineMs: now }
  ]) assert.throws(() => parseNativeFixtureDispatch(invalid, now), /Invalid native fixture dispatch completion/);
});

test("native broker diagnostics disclose only exact fixed reasons, never private error contents", () => {
  const sensitive = "draft=private-message; credential=private-token; document=private-identity";
  const knownReasons = ["Invalid broker request deadline", "Broker reply expired",
    "Broker returned a mismatched hello", "Mismatched broker reply", "Broker authentication timed out",
    "Broker request timed out"];
  for (const reason of knownReasons) {
    assert.equal(nativeBrokerFailureReason(new Error(reason, { cause: new Error(sensitive) })), reason);
    assert.equal(nativeBrokerFailureReason(new Error(`${reason}\n${sensitive}`)), "Broker request failed");
    assert.equal(nativeBrokerFailureReason(new Error(`${sensitive}: ${reason}`)), "Broker request failed");
  }
  for (const error of [new Error(sensitive, { cause: new Error(sensitive) }), new SyntaxError(sensitive),
    new Error(sensitive.repeat(1024)), Object.assign(new Error(sensitive), { name: "ZodError" }),
    sensitive, null, undefined, 42,
    { name: "ZodError", message: sensitive, toString() { throw new Error("Unexpected error coercion"); } }]) {
    assert.equal(nativeBrokerFailureReason(error), "Broker request failed");
  }
  const schemaError = new z.ZodError([{ code: "custom", path: [sensitive], message: sensitive }]);
  assert.equal(nativeBrokerFailureReason(schemaError), "Invalid broker response");
});

test("accepts only a bounded, exact handshake and the registered caller", () => {
  assert.equal(isNativeCaller(origin, origin), true);
  assert.equal(isNativeCaller(origin, origin.slice(0, -1)), true);
  assert.equal(isNativeCaller(origin, `chrome-extension://${"b".repeat(32)}/`), false);
  assert.equal(isNativeCaller("chrome-extension://*/", origin), false);

  assert.deepEqual(handleNativeHandshake(request, now), {
    ...request,
    kind: "handshake_result",
    payload: { protocolVersion: PROTOCOL_VERSION }
  });
  for (const invalid of [
    { ...request, kind: "execute" },
    { ...request, protocolVersion: 2 },
    { ...request, connectionGeneration: 1 },
    { ...request, deadlineMs: now - 1 },
    { ...request, deadlineMs: now + 30_001 },
    { ...request, payload: { command: "anything" } }
  ]) {
    assert.throws(() => handleNativeHandshake(invalid, now), /Invalid native handshake/);
  }
});

test("native pending list accepts no selectors, transcript fields, or arbitrary commands", () => {
  const listing = { ...request, kind: "list_pending" };
  assert.deepEqual(parseNativePendingList(listing, now), listing);
  for (const invalid of [
    { ...listing, kind: "evaluate" },
    { ...listing, protocolVersion: 2 },
    { ...listing, connectionGeneration: 1 },
    { ...listing, deadlineMs: now },
    { ...listing, deadlineMs: now + 30_001 },
    { ...listing, payload: { selector: "*" } },
    { ...listing, tabId: 1 }
  ]) {
    assert.throws(() => parseNativePendingList(invalid, now), /Invalid native pending list request/);
  }
});

test("native read challenge listing accepts no selectors or browser-control fields", () => {
  const listing = { ...request, kind: "list_fixture_read_challenges" };
  assert.deepEqual(parseNativeFixtureReadChallenges(listing, now), listing);
  for (const invalid of [
    { ...listing, kind: "evaluate" },
    { ...listing, connectionGeneration: 1 },
    { ...listing, deadlineMs: now },
    { ...listing, deadlineMs: now + 30_001 },
    { ...listing, payload: { selector: "*" } },
    { ...listing, tabId: 3 }
  ]) {
    assert.throws(() => parseNativeFixtureReadChallenges(invalid, now), /Invalid native fixture read challenge list/);
  }
});

test("native Gemini read challenge listing accepts no selectors or browser-control fields", () => {
  const listing = { ...request, kind: "list_gemini_read_challenges" };
  assert.deepEqual(parseNativeGeminiReadChallenges(listing, now), listing);
  for (const invalid of [
    { ...listing, kind: "evaluate" },
    { ...listing, connectionGeneration: 1 },
    { ...listing, deadlineMs: now },
    { ...listing, deadlineMs: now + 30_001 },
    { ...listing, payload: { selector: "*" } },
    { ...listing, tabId: 3 }
  ]) {
    assert.throws(() => parseNativeGeminiReadChallenges(invalid, now), /Invalid native Gemini read challenge list/);
  }
});

test("native fixture approval refuses other origins, targets, and arbitrary fields", () => {
  const approval = { ...request, kind: "approve_fixture", payload: {
    pendingRequestId: "c783ef76-d6cd-4898-8c43-204543943bac",
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" }
  } };
  assert.deepEqual(parseNativeFixtureApproval(approval, now), approval);
  for (const invalid of [
    { ...approval, kind: "evaluate" },
    { ...approval, deadlineMs: now },
    { ...approval, connectionGeneration: 1 },
    { ...approval, payload: { ...approval.payload, target: { ...approval.payload.target, origin: "https://gemini.google.com" } } },
    { ...approval, payload: { ...approval.payload, target: { ...approval.payload.target, tabId: 0 } } },
    { ...approval, payload: { ...approval.payload, target: { ...approval.payload.target, documentId: "" } } },
    { ...approval, payload: { ...approval.payload, target: { ...approval.payload.target, documentId: "x".repeat(129) } } },
    { ...approval, payload: { ...approval.payload, target: { ...approval.payload.target, documentId: "line\nbreak" } } },
    { ...approval, payload: { ...approval.payload, command: "navigate" } }
  ]) {
    assert.throws(() => parseNativeFixtureApproval(invalid, now), /Invalid native fixture approval/);
  }
});

test("native fixture review listing accepts only an exact target and no approval or send fields", () => {
  const listing = { ...request, kind: "list_fixture_prepared_reviews", payload: { target: {
    origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
    documentId: "CHROME-doc_opaque-42"
  } } };
  assert.deepEqual(parseNativeFixturePreparedReviews(listing, now), listing);
  for (const invalid of [
    { ...listing, kind: "approve_message" },
    { ...listing, deadlineMs: now },
    { ...listing, connectionGeneration: 1 },
    { ...listing, payload: { ...listing.payload, approved: true } },
    { ...listing, payload: { target: { ...listing.payload.target, origin: "https://gemini.google.com" } } },
    { ...listing, payload: { target: { ...listing.payload.target, documentId: "" } } },
    { ...listing, payload: { target: { ...listing.payload.target, selector: "*" } } }
  ]) {
    assert.throws(() => parseNativeFixturePreparedReviews(invalid, now), /Invalid native fixture prepared review list/);
  }
});

test("native fixture fill consent refuses no-send tokens, arbitrary controls, and stale envelopes", () => {
  const target = { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
    documentId: "CHROME-doc_opaque-42" };
  const listing = { ...request, kind: "list_fixture_fill_reviews", payload: { target } };
  assert.deepEqual(parseNativeFixtureFillReviews(listing, now), listing);
  for (const invalid of [
    { ...listing, kind: "list_fixture_prepared_reviews" },
    { ...listing, deadlineMs: now },
    { ...listing, deadlineMs: now + 30_001 },
    { ...listing, payload: { target, approved: true } },
    { ...listing, payload: { target: { ...target, selector: "#message" } } },
    { ...listing, payload: { target: { ...target, origin: "https://gemini.google.com" } } }
  ]) assert.throws(() => parseNativeFixtureFillReviews(invalid, now), /Invalid native fixture fill review list/);
  const approval = { ...listing, kind: "approve_fixture_fill_review", payload: { target,
    operationId: "a66b3997-9d43-4554-8399-267d1fe9f75c", reviewId: "b66b3997-9d43-4554-8399-267d1fe9f75c" } };
  assert.deepEqual(parseNativeFixtureFillReviewApproval(approval, now), approval);
  for (const invalid of [
    { ...approval, kind: "approve_fixture_review" },
    { ...approval, deadlineMs: now },
    { ...approval, connectionGeneration: 1 },
    { ...approval, payload: { ...approval.payload, reviewId: "" } },
    { ...approval, payload: { ...approval.payload, text: "Changed approved text" } },
    { ...approval, payload: { ...approval.payload, send: true } }
  ]) assert.throws(() => parseNativeFixtureFillReviewApproval(invalid, now), /Invalid native fixture fill review approval/);
});

test("native fixture send review accepts only distinct commands and exact bounded targets", () => {
  const target = { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
    documentId: "CHROME-doc_opaque-42" };
  const listing = { ...request, kind: "list_fixture_send_reviews", payload: { target } };
  assert.deepEqual(parseNativeFixtureSendReviews(listing, now), listing);
  for (const invalid of [
    { ...listing, kind: "list_fixture_prepared_reviews" },
    { ...listing, kind: "list_fixture_fill_reviews" },
    { ...listing, protocolVersion: 2 },
    { ...listing, connectionGeneration: 1 },
    { ...listing, deadlineMs: now },
    { ...listing, deadlineMs: now + 30_001 },
    { ...listing, payload: { target, approved: true } },
    { ...listing, payload: { target, text: "Changed text" } },
    { ...listing, payload: { target: { ...target, selector: "button" } } },
    { ...listing, payload: { target: { ...target, origin: "https://gemini.google.com" } } },
    { ...listing, payload: { target: { ...target, tabId: 0 } } },
    { ...listing, payload: { target: { ...target, documentId: "x".repeat(129) } } }
  ]) assert.throws(() => parseNativeFixtureSendReviews(invalid, now), /Invalid native fixture send review list/);
  const approval = { ...listing, kind: "approve_fixture_send_review", payload: { target,
    operationId: "a66b3997-9d43-4554-8399-267d1fe9f75c", reviewId: "b66b3997-9d43-4554-8399-267d1fe9f75c" } };
  assert.deepEqual(parseNativeFixtureSendReviewApproval(approval, now), approval);
  for (const invalid of [
    { ...approval, kind: "approve_fixture_review" },
    { ...approval, kind: "approve_fixture_fill_review" },
    { ...approval, deadlineMs: now },
    { ...approval, deadlineMs: now + 30_001 },
    { ...approval, connectionGeneration: 1 },
    { ...approval, payload: { ...approval.payload, operationId: "wrong" } },
    { ...approval, payload: { ...approval.payload, reviewId: "" } },
    { ...approval, payload: { ...approval.payload, text: "Changed text" } },
    { ...approval, payload: { ...approval.payload, approved: true } },
    { ...approval, payload: { ...approval.payload, send: true } },
    { ...approval, payload: { ...approval.payload, recoveryToken: "a".repeat(64) } },
    { ...approval, payload: { ...approval.payload, target: { ...target, documentId: "line\nbreak" } } }
  ]) assert.throws(() => parseNativeFixtureSendReviewApproval(invalid, now), /Invalid native fixture send review approval/);
});

test("native fixture preflight accepts only fixed results for an exact challenge target", () => {
  const completed = { ...request, kind: "complete_fixture_preflight", payload: {
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" },
    challengeId: "c783ef76-d6cd-4898-8c43-204543943bac", observation: { ok: true, editor: "textarea" }
  } };
  assert.deepEqual(parseNativeFixturePreflight(completed, now), completed);
  const denied = { ...completed, payload: { ...completed.payload, observation: { ok: false, code: "DRAFT_PRESENT" } } };
  assert.deepEqual(parseNativeFixturePreflight(denied, now), denied);
  for (const invalid of [
    { ...completed, kind: "send" },
    { ...completed, deadlineMs: now },
    { ...completed, payload: { ...completed.payload, challengeId: "invalid" } },
    { ...completed, payload: { ...completed.payload, selector: "#message" } },
    { ...completed, payload: { ...completed.payload, observation: { ok: true, editor: "textarea", draftText: "private" } } },
    { ...completed, payload: { ...completed.payload, observation: { ok: false, code: "SEND_APPROVED" } } },
    { ...completed, payload: { ...completed.payload, target: { ...completed.payload.target, origin: "https://gemini.google.com" } } }
  ]) assert.throws(() => parseNativeFixturePreflight(invalid, now), /Invalid native fixture preflight/);
});

test("native fill completion carries only a fixed outcome for one exact document attempt", () => {
  const completion = { ...request, kind: "complete_fixture_fill", payload: {
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" },
    attemptId: "c783ef76-d6cd-4898-8c43-204543943bac", observation: { ok: true, editor: "rich" }
  } };
  assert.deepEqual(parseNativeFixtureFill(completion, now), completion);
  const uncertain = { ...completion, payload: { ...completion.payload, observation: { ok: false, code: "FILL_UNCERTAIN" } } };
  assert.deepEqual(parseNativeFixtureFill(uncertain, now), uncertain);
  for (const invalid of [
    { ...completion, kind: "fill_fixture_draft" },
    { ...completion, deadlineMs: now },
    { ...completion, payload: { ...completion.payload, attemptId: "wrong" } },
    { ...completion, payload: { ...completion.payload, text: "Changed approved text" } },
    { ...completion, payload: { ...completion.payload, observation: { ok: true, editor: "rich", draftText: "private" } } },
    { ...completion, payload: { ...completion.payload, observation: { ok: false, code: "SEND_APPROVED" } } },
    { ...completion, payload: { ...completion.payload, target: { ...completion.payload.target, origin: "https://gemini.google.com" } } }
  ]) assert.throws(() => parseNativeFixtureFill(invalid, now), /Invalid native fixture fill/);
});

test("native fixture review approval requires one exact target and review token", () => {
  const approval = { ...request, kind: "approve_fixture_review", payload: {
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" },
    operationId: "a66b3997-9d43-4554-8399-267d1fe9f75c",
    reviewId: "b66b3997-9d43-4554-8399-267d1fe9f75c"
  } };
  assert.deepEqual(parseNativeFixtureReviewApproval(approval, now), approval);
  for (const invalid of [
    { ...approval, kind: "submit_fixture" },
    { ...approval, deadlineMs: now },
    { ...approval, connectionGeneration: 1 },
    { ...approval, payload: { ...approval.payload, send: true } },
    { ...approval, payload: { ...approval.payload, reviewId: "" } },
    { ...approval, payload: { ...approval.payload, target: { ...approval.payload.target,
      origin: "https://gemini.google.com" } } }
  ]) {
    assert.throws(() => parseNativeFixtureReviewApproval(invalid, now), /Invalid native fixture review approval/);
  }
});

test("native Gemini approval accepts only one exact saved chat target", () => {
  const approval = { ...request, kind: "approve_gemini", payload: {
    pendingRequestId: "c783ef76-d6cd-4898-8c43-204543943bac",
    target: { origin: "https://gemini.google.com", conversationId: "disposable-chat",
      url: "https://gemini.google.com/app/disposable-chat", tabId: 3, documentId: "CHROME-doc_gemini-42" }
  } };
  assert.deepEqual(parseNativeGeminiApproval(approval, now), approval);
  const queryApproval = { ...approval, payload: { ...approval.payload, target: {
    ...approval.payload.target, url: `${approval.payload.target.url}?hl=en`
  } } };
  assert.deepEqual(parseNativeGeminiApproval(queryApproval, now), queryApproval);
  for (const invalid of [
    { ...approval, kind: "evaluate" },
    { ...approval, deadlineMs: now },
    { ...approval, payload: { ...approval.payload, selector: "*" } },
    { ...approval, payload: { target: { ...approval.payload.target, origin: "http://127.0.0.1:8787" } } },
    { ...approval, payload: { target: { ...approval.payload.target, url: "https://gemini.google.com/app/other" } } },
    { ...approval, payload: { target: { ...approval.payload.target, url: `${approval.payload.target.url}#reply` } } },
    { ...approval, payload: { target: { ...approval.payload.target,
      url: `${approval.payload.target.url}?hl=${"x".repeat(512)}` } } },
    { ...approval, payload: { target: { ...approval.payload.target, documentId: "" } } },
    { ...approval, payload: { target: { ...approval.payload.target, tabId: 0 } } },
    { ...approval, payload: { target: { ...approval.payload.target, selector: "*" } } }
  ]) {
    assert.throws(() => parseNativeGeminiApproval(invalid, now), /Invalid native Gemini approval/);
  }
});

test("native Gemini gap accepts only one exact saved-chat URL and document", () => {
  const gap = { ...request, kind: "mark_gemini_observation_gap", payload: { target: {
    origin: "https://gemini.google.com", conversationId: "disposable-chat",
    url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 3,
    documentId: "CHROME-doc_gemini-42"
  } } };
  assert.deepEqual(parseNativeGeminiGap(gap, now), gap);
  for (const invalid of [
    { ...gap, kind: "evaluate" },
    { ...gap, deadlineMs: now },
    { ...gap, payload: { ...gap.payload, selector: "*" } },
    { ...gap, payload: { target: { ...gap.payload.target, url: `${gap.payload.target.url}&changed=1` },
      selector: "*" } },
    { ...gap, payload: { target: { ...gap.payload.target, url: `${gap.payload.target.url}#reply` } } },
    { ...gap, payload: { target: { ...gap.payload.target, documentId: "" } } },
    { ...gap, payload: { target: { ...gap.payload.target, conversationId: "other" } } }
  ]) {
    assert.throws(() => parseNativeGeminiGap(invalid, now), /Invalid native Gemini gap/);
  }
});

test("native Gemini snapshots accept bounded synthetic rows only for an exact saved chat", () => {
  const snapshot = { ...request, kind: "publish_gemini_snapshot", payload: {
    target: { origin: "https://gemini.google.com", conversationId: "disposable-chat",
      url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 3, documentId: "CHROME-doc_gemini-42" },
    messages: [{ direction: "outgoing", text: "OK" }, { direction: "outgoing", text: "OK" }]
  } };
  assert.deepEqual(parseNativeGeminiSnapshot(snapshot, now), snapshot);
  const challenged = { ...snapshot, payload: { ...snapshot.payload,
    challengeId: "a66b3997-9d43-4554-8399-267d1fe9f75c" } };
  assert.deepEqual(parseNativeGeminiSnapshot(challenged, now), challenged);
  for (const invalid of [
    { ...snapshot, kind: "evaluate" },
    { ...snapshot, deadlineMs: now },
    { ...snapshot, payload: { ...snapshot.payload, selector: "*" } },
    { ...snapshot, payload: { ...snapshot.payload, challengeId: "not-a-uuid" } },
    { ...snapshot, payload: { ...snapshot.payload, target: { ...snapshot.payload.target,
      url: "https://gemini.google.com/app/other?hl=en" } } },
    { ...snapshot, payload: { ...snapshot.payload, target: { ...snapshot.payload.target,
      url: `${snapshot.payload.target.url}#reply` } } },
    { ...snapshot, payload: { ...snapshot.payload, target: { ...snapshot.payload.target, documentId: "" } } },
    { ...snapshot, payload: { ...snapshot.payload, messages: [] } },
    { ...snapshot, payload: { ...snapshot.payload, messages: [{ direction: "incoming", text: "" }] } },
    { ...snapshot, payload: { ...snapshot.payload, messages: [{ direction: "system", text: "No" }] } },
    { ...snapshot, payload: { ...snapshot.payload, messages: [{ direction: "incoming", text: "x".repeat(2049) }] } },
    { ...snapshot, payload: { ...snapshot.payload, messages: Array.from({ length: 32 }, () => ({
      direction: "incoming", text: "é".repeat(2048)
    })) } }
  ]) {
    assert.throws(() => parseNativeGeminiSnapshot(invalid, now), /Invalid native Gemini snapshot/);
  }
});

test("native fixture gap accepts only an exact approved browser target", () => {
  const gap = { ...request, kind: "mark_fixture_observation_gap", payload: { target: {
    origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
    documentId: "CHROME-doc_opaque-42"
  } } };
  assert.deepEqual(parseNativeFixtureGap(gap, now), gap);
  for (const invalid of [
    { ...gap, kind: "evaluate" },
    { ...gap, deadlineMs: now },
    { ...gap, payload: { ...gap.payload, selector: "*" } },
    { ...gap, payload: { target: { ...gap.payload.target, origin: "https://gemini.google.com" } } },
    { ...gap, payload: { target: { ...gap.payload.target, documentId: "" } } },
    { ...gap, payload: { target: { ...gap.payload.target, tabId: 0 } } }
  ]) {
    assert.throws(() => parseNativeFixtureGap(invalid, now), /Invalid native fixture gap/);
  }
});

test("native fixture revocation accepts only bounded browser identity or tab closure", () => {
  const revoke = { ...request, kind: "revoke_fixture", payload: {
    tabId: 3, observed: { documentId: "CHROME-doc_opaque-42", conversationId: "fixture-alpha" }
  } };
  assert.deepEqual(parseNativeFixtureRevocation(revoke, now), revoke);
  assert.deepEqual(parseNativeFixtureRevocation({ ...revoke, payload: { tabId: 3, observed: null } }, now),
    { ...revoke, payload: { tabId: 3, observed: null } });
  for (const invalid of [
    { ...revoke, kind: "evaluate" },
    { ...revoke, deadlineMs: now },
    { ...revoke, payload: { tabId: 0, observed: null } },
    { ...revoke, payload: { tabId: 3, observed: { documentId: "", conversationId: "fixture-alpha" } } },
    { ...revoke, payload: { tabId: 3, observed: { documentId: "CHROME-doc_opaque-42", conversationId: "" } } },
    { ...revoke, payload: { ...revoke.payload, selector: "*" } }
  ]) {
    assert.throws(() => parseNativeFixtureRevocation(invalid, now), /Invalid native fixture revocation/);
  }
});

test("native fixture reset accepts only a bounded empty-payload command", () => {
  const reset = { ...request, kind: "revoke_all_fixture" };
  assert.deepEqual(parseNativeFixtureReset(reset, now), reset);
  for (const invalid of [
    { ...reset, kind: "evaluate" },
    { ...reset, connectionGeneration: 1 },
    { ...reset, deadlineMs: now },
    { ...reset, deadlineMs: now + 30_001 },
    { ...reset, payload: { selector: "*" } },
    { ...reset, tabId: 1 }
  ]) {
    assert.throws(() => parseNativeFixtureReset(invalid, now), /Invalid native fixture reset/);
  }
});

test("native fixture snapshots accept only bounded rows from the exact local fixture", () => {
  const snapshot = { ...request, kind: "publish_fixture_snapshot", payload: {
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" },
    messages: [{ id: "fixture-1", direction: "incoming", text: "First" }]
  } };
  assert.deepEqual(parseNativeFixtureSnapshot(snapshot, now), snapshot);
  const challenged = { ...snapshot, payload: { ...snapshot.payload,
    challengeId: "a66b3997-9d43-4554-8399-267d1fe9f75c" } };
  assert.deepEqual(parseNativeFixtureSnapshot(challenged, now), challenged);
  for (const invalid of [
    { ...snapshot, kind: "evaluate" },
    { ...snapshot, deadlineMs: now },
    { ...snapshot, payload: { ...snapshot.payload, selector: "*" } },
    { ...snapshot, payload: { ...snapshot.payload, challengeId: "not-a-uuid" } },
    { ...snapshot, payload: { ...snapshot.payload, target: { ...snapshot.payload.target,
      origin: "https://gemini.google.com" } } },
    { ...snapshot, payload: { ...snapshot.payload, target: { ...snapshot.payload.target, documentId: "" } } },
    { ...snapshot, payload: { ...snapshot.payload, messages: [...snapshot.payload.messages, snapshot.payload.messages[0]] } },
    { ...snapshot, payload: { ...snapshot.payload, messages: [{ ...snapshot.payload.messages[0], text: "x".repeat(2049) }] } },
    { ...snapshot, payload: { ...snapshot.payload, messages: [{ id: "fixture-1", direction: "system", text: "No" }] } },
    { ...snapshot, payload: { ...snapshot.payload, messages: Array.from({ length: 32 }, (_, index) => ({
      id: `fixture-${index}`, direction: "incoming", text: "é".repeat(2048)
    })) } }
  ]) {
    assert.throws(() => parseNativeFixtureSnapshot(invalid, now), /Invalid native fixture snapshot/);
  }
});

test("spawned native relay rejects private malformed input without stdout or diagnostic disclosure", { timeout: 4000 }, async () => {
  const sensitive = "private-draft-and-credential-and-browser-identity";
  const malformedJson = Buffer.from(`{"draftText":"${sensitive}",`, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(malformedJson.length, 0);
  const scenarios = [
    { frame: encodeNativeFrame({ ...request, payload: { draftText: sensitive, credential: sensitive } }),
      reason: "Invalid native handshake" },
    { frame: encodeNativeFrame({ ...request, kind: "list_pending", payload: { documentId: sensitive } }),
      reason: "Invalid native pending list request" },
    { frame: Buffer.concat([header, malformedJson]), reason: "Invalid JSON" }
  ];
  for (const scenario of scenarios) {
    const host = spawn(process.execPath, [fileURLToPath(new URL("./native-relay.js", import.meta.url)), origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "/usr/bin:/bin" }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    try {
      host.stdin.end(scenario.frame);
      const [exitCode] = await once(host, "close");
      const diagnostic = Buffer.concat(stderr).toString();
      assert.equal(exitCode, 1, diagnostic);
      assert.equal(Buffer.concat(stdout).length, 0);
      assert.equal(diagnostic.includes(sensitive), false);
      assert.equal(diagnostic.startsWith(`Invalid native host message: ${scenario.reason}; deadline delta `), true);
      assert.match(diagnostic, /; deadline delta (?:missing|-?\d+)ms\n$/);
    } finally {
      host.kill();
    }
  }
});

test("spawned native relay handles input stream errors and premature close without disclosure", { timeout: 4000 }, async () => {
  const sensitive = "private-input-stream-draft-and-credential";
  const partial = encodeNativeFrame({ ...request, payload: { draftText: sensitive } }).subarray(0, -1);
  const scenarios = [
    { frame: Buffer.alloc(0), error: true, diagnostic: "Native relay failed to read a request\n" },
    { frame: partial, error: true, diagnostic: "Native relay failed to read a request\n" },
    { frame: partial, error: false, diagnostic: "Invalid native host message: Incomplete native frame\n" }
  ];
  for (const scenario of scenarios) {
    const script = `
      process.argv[2] = ${JSON.stringify(origin)};
      process.argv[3] = ${JSON.stringify(origin)};
      await import(${JSON.stringify(new URL("./native-relay.js", import.meta.url).href)});
      process.stdin.emit("data", Buffer.from(${JSON.stringify([...scenario.frame])}));
      process.stdin.destroy(${scenario.error ? `new Error(${JSON.stringify(sensitive)})` : ""});
    `;
    const host = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "/usr/bin:/bin" }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    try {
      const [exitCode] = await once(host, "close");
      assert.equal(exitCode, 1);
      assert.equal(Buffer.concat(stdout).length, 0);
      assert.equal(Buffer.concat(stderr).toString(), scenario.diagnostic);
    } finally {
      host.stdin.destroy();
      host.kill();
    }
  }
});

test("spawned native relay fails closed when its diagnostic stream errors", { timeout: 4000 }, async () => {
  const sensitive = "private-diagnostic-stream-draft-and-credential";
  const script = `
    process.argv[2] = ${JSON.stringify(origin)};
    process.argv[3] = ${JSON.stringify(origin)};
    process.on("uncaughtExceptionMonitor", () => process.stdout.write(${JSON.stringify("Unhandled diagnostic stream error\n")}));
    await import(${JSON.stringify(new URL("./native-relay.js", import.meta.url).href)});
    process.stderr.destroy(new Error(${JSON.stringify(sensitive)}));
  `;
  const host = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "/usr/bin:/bin" }
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  try {
    const [exitCode] = await once(host, "close");
    assert.equal(exitCode, 1);
    assert.equal(Buffer.concat(stdout).length, 0);
    assert.equal(Buffer.concat(stderr).length, 0);
  } finally {
    host.stdin.destroy();
    host.kill();
  }
});

test("spawned native relay keeps malformed deadline diagnostics bounded and private", { timeout: 4000 }, async () => {
  const sensitive = "private-malformed-deadline-draft-and-credential";
  for (const deadlineMs of [Number.MAX_VALUE, -Number.MAX_VALUE, 0.5, Number.MIN_VALUE, -Number.MAX_SAFE_INTEGER]) {
    const host = spawn(process.execPath, [fileURLToPath(new URL("./native-relay.js", import.meta.url)), origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "/usr/bin:/bin" }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    try {
      host.stdin.end(encodeNativeFrame({ ...request, deadlineMs, payload: { draftText: sensitive, credential: sensitive } }));
      const [exitCode] = await once(host, "close");
      assert.equal(exitCode, 1);
      assert.equal(Buffer.concat(stdout).length, 0);
      assert.equal(Buffer.concat(stderr).toString(), "Invalid native host message: Invalid native handshake; deadline delta missingms\n");
    } finally {
      host.kill();
    }
  }
});

test("spawned native relay bounds queued broker work without disclosing payloads and reuses capacity", { timeout: 4000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-native-queue-"));
  const sensitive = "private-native-queued-message-and-credential";
  const message = { ...request, kind: "publish_fixture_snapshot", deadlineMs: Date.now() + 10_000, payload: {
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" },
    messages: [{ id: "fixture-1", direction: "incoming", text: sensitive }]
  } };
  const frame = encodeNativeFrame(message);
  try {
    for (const count of [MAX_BROKER_PENDING_REQUESTS, MAX_BROKER_PENDING_REQUESTS + 1]) {
      const host = spawn(process.execPath, [fileURLToPath(new URL("./native-relay.js", import.meta.url)), origin, origin], {
        stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const decoder = new NativeFrameDecoder();
      const replies: unknown[] = [];
      let receivedBatch: () => void = () => {};
      const firstBatch = new Promise<void>((resolve) => { receivedBatch = resolve; });
      host.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        replies.push(...decoder.push(chunk));
        if (replies.length >= MAX_BROKER_PENDING_REQUESTS) receivedBatch();
      });
      host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      try {
        const burst = Buffer.concat(Array.from({ length: count }, () => frame));
        if (count === MAX_BROKER_PENDING_REQUESTS) {
          host.stdin.write(burst);
          await firstBatch;
          host.stdin.end(frame);
        } else {
          host.stdin.end(burst);
        }
        const [exitCode] = await once(host, "close");
        const diagnostic = Buffer.concat(stderr).toString();
        assert.equal(diagnostic.includes(sensitive), false);
        assert.equal(Buffer.concat(stdout).toString().includes(sensitive), false);
        if (count === MAX_BROKER_PENDING_REQUESTS) {
          assert.equal(exitCode, 0);
          assert.equal(replies.length, count + 1);
          for (const reply of replies as { kind: string; payload: unknown }[]) {
            assert.equal(reply.kind, "error");
            assert.deepEqual(reply.payload, { code: "BROKER_UNAVAILABLE" });
          }
        } else {
          assert.equal(exitCode, 1);
          assert.equal(Buffer.concat(stdout).length, 0);
          assert.match(diagnostic, /^Invalid native host message: Invalid native request queue; deadline delta -?\d+ms\n$/);
        }
      } finally {
        host.kill();
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("spawned native relay bounds handshakes with forwarding work and preserves reply order", { timeout: 4000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-native-handshake-queue-"));
  try {
    for (const mixed of [false, true]) {
      for (const count of [MAX_BROKER_PENDING_REQUESTS, MAX_BROKER_PENDING_REQUESTS + 1]) {
        const messages = Array.from({ length: count }, (_, index) => ({ ...request, requestId: randomUUID(),
          kind: mixed && index % 2 === 0 ? "list_pending" : "handshake", deadlineMs: Date.now() + 10_000 }));
        const host = spawn(process.execPath, [fileURLToPath(new URL("./native-relay.js", import.meta.url)), origin, origin], {
          stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        try {
          host.stdin.end(Buffer.concat(messages.map((message) => encodeNativeFrame(message))));
          const [exitCode] = await once(host, "close");
          const diagnostic = Buffer.concat(stderr).toString();
          if (count === MAX_BROKER_PENDING_REQUESTS) {
            assert.equal(exitCode, 0, diagnostic);
            const replies = new NativeFrameDecoder().push(Buffer.concat(stdout)) as {
              kind: string; requestId: string; deadlineMs: number; payload: unknown
            }[];
            assert.equal(replies.length, messages.length);
            for (let index = 0; index < messages.length; index++) {
              assert.equal(replies[index]?.requestId, messages[index]?.requestId);
              assert.equal(replies[index]?.deadlineMs, messages[index]?.deadlineMs);
              assert.equal(replies[index]?.kind, messages[index]?.kind === "handshake" ? "handshake_result" : "error");
              assert.deepEqual(replies[index]?.payload, messages[index]?.kind === "handshake"
                ? { protocolVersion: PROTOCOL_VERSION } : { code: "BROKER_UNAVAILABLE" });
            }
          } else {
            assert.equal(exitCode, 1);
            assert.equal(Buffer.concat(stdout).length, 0);
            assert.match(diagnostic, /^Invalid native host message: Invalid native request queue; deadline delta -?\d+ms\n$/);
          }
        } finally {
          host.kill();
        }
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("spawned native relay refuses truncated input without disclosing unfinished payloads", { timeout: 4000 }, async () => {
  const sensitive = "private-unfinished-draft-and-credential";
  const frame = encodeNativeFrame({ draftText: sensitive, credential: sensitive });
  for (const length of [1, 3, 4, frame.length - 1]) {
    const host = spawn(process.execPath, [fileURLToPath(new URL("./native-relay.js", import.meta.url)), origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "/usr/bin:/bin" }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    try {
      host.stdin.end(frame.subarray(0, length));
      const [exitCode] = await once(host, "close");
      assert.equal(exitCode, 1, `Truncated input at byte ${length}`);
      assert.equal(Buffer.concat(stdout).length, 0);
      assert.equal(Buffer.concat(stderr).toString(), "Invalid native host message: Incomplete native frame\n");
    } finally {
      host.kill();
    }
  }
});

test("spawned native relay handles a closed stdout pipe with a fixed diagnostic", { timeout: 4000 }, async () => {
  const host = spawn(process.execPath, [fileURLToPath(new URL("./native-relay.js", import.meta.url)), origin, origin], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "/usr/bin:/bin" }
  });
  const stderr: Buffer[] = [];
  host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  try {
    const stdoutClosed = once(host.stdout, "close");
    host.stdout.destroy();
    await stdoutClosed;
    const closed = once(host, "close");
    host.stdin.end(encodeNativeFrame({ ...request, deadlineMs: Date.now() + 10_000 }));
    const [exitCode] = await closed;
    assert.equal(exitCode, 1);
    assert.equal(Buffer.concat(stderr).toString(), "Native relay failed to write a response\n");
  } finally {
    host.kill();
  }
});

test("spawned native relay replies with a framed version and no other stdout", async () => {
  const host = spawn(process.execPath, [new URL("./native-relay.js", import.meta.url).pathname, origin, origin], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const handshake = { ...request, deadlineMs: Date.now() + 10_000 };
  const frame = encodeNativeFrame(handshake);
  host.stdin.write(frame.subarray(0, 3));
  host.stdin.end(frame.subarray(3));
  const [exitCode] = await once(host, "exit");

  assert.equal(exitCode, 0, Buffer.concat(stderr).toString());
  assert.equal(Buffer.concat(stderr).toString(), "");
  const replies = new NativeFrameDecoder().push(Buffer.concat(stdout));
  assert.deepEqual(replies, [handleNativeHandshake(handshake, Date.now())]);
});

test("native relay lists only live broker pending IDs over real framing", { timeout: 8000 }, async (context) => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-native-pending-"));
  const brokerEntry = fileURLToPath(new URL("./broker-process.js", import.meta.url));
  const relayEntry = fileURLToPath(new URL("./native-relay.js", import.meta.url));
  const broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: home }, stdio: "ignore" });
  const brokerExit = once(broker, "exit");
  let facade: Awaited<ReturnType<typeof connectBroker>> | undefined;
  let reviewPort: ReturnType<typeof spawn> | undefined;
  let reviewPortClose: ReturnType<typeof once> | undefined;
  const stopReviewHost = () => { reviewPort?.kill(); };
  context.signal.addEventListener("abort", stopReviewHost, { once: true });

  try {
    const socketPath = join(home, ".config/agent-messaging-mcp/broker/broker.sock");
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const info = await stat(socketPath);
        ready = info.isSocket() && (info.mode & 0o077) === 0;
        if (ready) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await setTimeout(25);
    }
    assert.equal(ready, true, "Broker did not start");
    facade = await connectBroker("facade", join(home, ".config/agent-messaging-mcp/broker"));
    const created = await facade.requestConnection();
    assert.equal(created.kind, "connection_requested");
    if (created.kind !== "connection_requested") throw new Error("Expected pending request");

    const host = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const listing = { ...request, kind: "list_pending", deadlineMs: Date.now() + 10_000 };
    const frame = encodeNativeFrame(listing);
    host.stdin.write(frame.subarray(0, 2));
    host.stdin.end(frame.subarray(2));
    const [code] = await once(host, "exit");

    assert.equal(code, 0, Buffer.concat(stderr).toString());
    const [reply] = new NativeFrameDecoder().push(Buffer.concat(stdout)) as [{
      kind: string; requestId: string; payload: { requests: { requestId: string; expiresAt: number }[] }
    }];
    assert.equal(reply.kind, "pending_list");
    assert.equal(reply.requestId, listing.requestId);
    assert.deepEqual(reply.payload.requests, [{
      requestId: created.payload.requestId, expiresAt: created.payload.expiresAt
    }]);

    const approvalHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const approvalOutput: Buffer[] = [];
    const approvalErrors: Buffer[] = [];
    approvalHost.stdout.on("data", (chunk: Buffer) => approvalOutput.push(chunk));
    approvalHost.stderr.on("data", (chunk: Buffer) => approvalErrors.push(chunk));
    const approval = { ...request, kind: "approve_fixture", deadlineMs: Date.now() + 10_000, payload: {
      pendingRequestId: created.payload.requestId,
      target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
        documentId: "a66b3997-9d43-4554-8399-267d1fe9f75c" }
    } };
    approvalHost.stdin.end(Buffer.concat([encodeNativeFrame(approval), encodeNativeFrame(approval)]));
    const [approvalExit] = await once(approvalHost, "exit");
    assert.equal(approvalExit, 0, Buffer.concat(approvalErrors).toString());
    const responses = new NativeFrameDecoder().push(Buffer.concat(approvalOutput)) as [
      { kind: string; requestId: string; payload: { requestId: string; expiresAt: number } },
      { kind: string; payload: { code: string } }
    ];
    assert.equal(responses.length, 2);
    assert.equal(responses[0].kind, "fixture_approved");
    assert.equal(responses[0].requestId, approval.requestId);
    assert.equal(responses[0].payload.requestId, created.payload.requestId);
    assert.deepEqual(responses[1], {
      kind: "error", protocolVersion: PROTOCOL_VERSION, requestId: approval.requestId,
      connectionGeneration: 0, deadlineMs: approval.deadlineMs, payload: { code: "APPROVAL_INVALID" }
    });
    const granted = await facade.getConnection(created.payload.requestId);
    if (granted.kind !== "connection_state") throw new Error("Expected owned connection state");
    assert.equal(granted.payload.state, "ready_readonly");
    if (granted.payload.state !== "ready_readonly") throw new Error("Expected approved fixture handle");

    const prepared = await facade.prepareFixtureMessage(granted.payload.connectionId, 1,
      "Synthetic fixture review", "b66b3997-9d43-4554-8399-267d1fe9f75c");
    if (prepared.kind !== "message_prepared") throw new Error("Expected prepared fixture review");
    const reviewHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const reviewOutput: Buffer[] = [];
    const reviewErrors: Buffer[] = [];
    reviewHost.stdout.on("data", (chunk: Buffer) => reviewOutput.push(chunk));
    reviewHost.stderr.on("data", (chunk: Buffer) => reviewErrors.push(chunk));
    const reviewRequest = { ...request, kind: "list_fixture_prepared_reviews", deadlineMs: Date.now() + 10_000,
      payload: { target: approval.payload.target } };
    reviewHost.stdin.end(encodeNativeFrame(reviewRequest));
    const [reviewExit] = await once(reviewHost, "exit");
    assert.equal(reviewExit, 0, Buffer.concat(reviewErrors).toString());
    const [reviewReply] = new NativeFrameDecoder().push(Buffer.concat(reviewOutput)) as [{
      kind: string; payload: { reviews: { operationId: string; reviewId: string; expiresAt: number;
        preview: { target: string; text: string } }[]; hasMore: boolean }
    }];
    assert.equal(reviewReply.kind, "fixture_prepared_reviews");
    const reviewId = reviewReply.payload.reviews[0]?.reviewId;
    assert.ok(reviewId);
    assert.deepEqual(reviewReply.payload, { reviews: [{ operationId: prepared.payload.operationId,
      reviewId, expiresAt: prepared.payload.expiresAt, preview: prepared.payload.preview }], hasMore: false });

    const approvalReviewHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const approvalReviewOutput: Buffer[] = [];
    const approvalReviewErrors: Buffer[] = [];
    approvalReviewHost.stdout.on("data", (chunk: Buffer) => approvalReviewOutput.push(chunk));
    approvalReviewHost.stderr.on("data", (chunk: Buffer) => approvalReviewErrors.push(chunk));
    const approvalReviewRequest = { ...request, kind: "approve_fixture_review", deadlineMs: Date.now() + 10_000,
      payload: { target: approval.payload.target, operationId: prepared.payload.operationId, reviewId } };
    approvalReviewHost.stdin.end(encodeNativeFrame(approvalReviewRequest));
    const [approvalReviewExit] = await once(approvalReviewHost, "exit");
    assert.equal(approvalReviewExit, 0, Buffer.concat(approvalReviewErrors).toString());
    const [approvalReviewReply] = new NativeFrameDecoder().push(Buffer.concat(approvalReviewOutput)) as [{
      kind: string; payload: { operationId: string; state: string; approvedAt: number; expiresAt: number }
    }];
    assert.equal(approvalReviewReply.kind, "fixture_review_approved");
    assert.equal(approvalReviewReply.payload.operationId, prepared.payload.operationId);
    assert.equal(approvalReviewReply.payload.state, "approved");

    let lastExchangeDiagnostic = "";
    const fillHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    reviewPort = fillHost;
    reviewPortClose = once(fillHost, "close");
    const fillErrors: Buffer[] = [];
    fillHost.stderr.on("data", (chunk: Buffer) => fillErrors.push(chunk));
    fillHost.stdin.on("error", stopReviewHost);
    const exchangeFillReview = async (message: unknown) => {
      const diagnosticOffset = fillErrors.length;
      const decoder = new NativeFrameDecoder();
      const chunks = on(fillHost.stdout, "data", { close: ["end", "close"], signal: context.signal });
      fillHost.stdin.write(encodeNativeFrame(message));
      for await (const [chunk] of chunks) {
        const replies = decoder.push(chunk as Buffer);
        if (!replies.length) continue;
        assert.equal(replies.length, 1);
        assert.equal((replies[0] as { requestId: string }).requestId, request.requestId);
        await setImmediate();
        lastExchangeDiagnostic = Buffer.concat(fillErrors.slice(diagnosticOffset)).toString();
        return replies;
      }
      throw new Error("Native review port closed without a response");
    };
    const [fillListing] = await exchangeFillReview({ ...request, kind: "list_fixture_fill_reviews",
      deadlineMs: Date.now() + 10_000, payload: { target: approval.payload.target } }) as [{
      kind: string; payload: { reviews: { operationId: string; reviewId: string; preview: { text: string } }[] }
    }];
    assert.equal(fillListing.kind, "fixture_fill_reviews");
    const [fillReview] = fillListing.payload.reviews;
    assert.ok(fillReview);
    assert.equal(fillReview.operationId, prepared.payload.operationId);
    assert.equal(fillReview.preview.text, prepared.payload.preview.text);
    assert.notEqual(fillReview.reviewId, reviewId);
    assert.equal(JSON.stringify(fillListing).includes(prepared.payload.recoveryToken), false);
    const fillApprovalRequest = { ...request, kind: "approve_fixture_fill_review", deadlineMs: Date.now() + 10_000,
      payload: { target: approval.payload.target, operationId: fillReview.operationId, reviewId: fillReview.reviewId } };
    const [fillApproval] = await exchangeFillReview(fillApprovalRequest) as [{
      kind: string; payload: { operationId: string; state: string }
    }];
    assert.equal(fillApproval.kind, "fixture_fill_review_approved");
    assert.equal(fillApproval.payload.operationId, prepared.payload.operationId);
    assert.equal(fillApproval.payload.state, "fill_approved");
    const [fillReplay] = await exchangeFillReview({ ...fillApprovalRequest, deadlineMs: Date.now() + 10_000 }) as [{
      kind: string; payload: { code: string }
    }];
    assert.equal(fillReplay.kind, "error");
    assert.equal(fillReplay.payload.code, "FILL_REVIEW_UNAVAILABLE");

    const [beforeFilled] = await exchangeFillReview({ ...request, kind: "list_fixture_send_reviews",
      deadlineMs: Date.now() + 10_000, payload: { target: approval.payload.target } }) as [{
      kind: string; payload: { reviews: unknown[]; hasMore: boolean }
    }];
    assert.equal(beforeFilled.kind, "fixture_send_reviews");
    assert.deepEqual(beforeFilled.payload, { reviews: [], hasMore: false });

    const filling = facade.fillFixtureDraft(prepared.payload.operationId);
    const fillObserver = await connectBroker("relay", join(home, ".config/agent-messaging-mcp/broker"));
    let fillAttemptId: string | undefined;
    try {
      for (let attempt = 0; attempt < 40; attempt++) {
        const watch = await fillObserver.listFixtureReadChallenges();
        if (watch.kind !== "fixture_read_challenges") throw new Error("Expected fill watch metadata");
        fillAttemptId = watch.payload.draftFills[0]?.attemptId;
        if (fillAttemptId) {
          assert.equal(watch.payload.draftFills[0]?.operationId, prepared.payload.operationId);
          assert.equal(watch.payload.draftFills[0]?.text, prepared.payload.preview.text);
          assert.equal(JSON.stringify(watch.payload).includes(prepared.payload.recoveryToken), false);
          break;
        }
        await setTimeout(10);
      }
    } finally {
      fillObserver.close();
    }
    assert.ok(fillAttemptId);
    const fillCompletionRequest = { ...request, kind: "complete_fixture_fill", deadlineMs: Date.now() + 10_000,
      payload: { target: approval.payload.target, attemptId: fillAttemptId, observation: { ok: true, editor: "textarea" } } };
    const [fillCompletion] = await exchangeFillReview(fillCompletionRequest) as [{ kind: string; payload: { accepted: boolean } }];
    assert.equal(fillCompletion.kind, "fixture_fill_recorded");
    assert.equal(fillCompletion.payload.accepted, true);
    const fillResult = await filling;
    if (fillResult.kind !== "fixture_fill") throw new Error("Expected native fixture fill result");
    assert.equal(fillResult.payload.ok, true);
    assert.equal(fillResult.payload.operationId, prepared.payload.operationId);
    const [fillCompletionReplay] = await exchangeFillReview({ ...fillCompletionRequest, deadlineMs: Date.now() + 10_000 }) as [{
      kind: string; payload: { accepted: boolean }
    }];
    assert.equal(fillCompletionReplay.payload.accepted, false);
    assert.deepEqual((await facade.fillFixtureDraft(prepared.payload.operationId)).payload, { code: "FILL_UNAVAILABLE" });

    const owningFacade = facade;
    const sendTarget = { ...approval.payload.target, origin: "http://127.0.0.1:8787" as const,
      conversationId: "fixture-alpha" as const };
    assert.throws(() => owningFacade.listFixtureSendReviews(sendTarget), /Broker role cannot perform/);
    assert.throws(() => owningFacade.approveFixtureSendReview(sendTarget, prepared.payload.operationId,
      fillReview.reviewId), /Broker role cannot perform/);
    const beforeSendReview = await facade.getPreparedOperation(prepared.payload.operationId);
    const [sendListing] = await exchangeFillReview({ ...request, kind: "list_fixture_send_reviews",
      deadlineMs: Date.now() + 10_000, payload: { target: approval.payload.target } }) as [{
      kind: string; payload: { reviews: { operationId: string; reviewId: string; expiresAt: number;
        preview: { target: string; text: string } }[]; hasMore: boolean }
    }];
    assert.equal(sendListing.kind, "fixture_send_reviews");
    assert.equal(sendListing.payload.reviews.length, 1);
    assert.equal(sendListing.payload.hasMore, false);
    const [sendReview] = sendListing.payload.reviews;
    assert.ok(sendReview);
    assert.equal(sendReview.operationId, prepared.payload.operationId);
    assert.deepEqual(sendReview.preview, prepared.payload.preview);
    assert.equal(sendReview.expiresAt, approvalReviewReply.payload.expiresAt);
    assert.notEqual(sendReview.reviewId, reviewId);
    assert.notEqual(sendReview.reviewId, fillReview.reviewId);
    assert.equal(JSON.stringify(sendListing).includes(prepared.payload.recoveryToken), false);
    const sendApprovalRequest = { ...request, kind: "approve_fixture_send_review",
      payload: { target: approval.payload.target, operationId: sendReview.operationId, reviewId: sendReview.reviewId } };
    for (const wrongReviewId of [reviewId, fillReview.reviewId]) {
      const [wrongPurpose] = await exchangeFillReview({ ...sendApprovalRequest, deadlineMs: Date.now() + 10_000,
        payload: { ...sendApprovalRequest.payload, reviewId: wrongReviewId } }) as [{ kind: string; payload: { code: string } }];
      assert.equal(wrongPurpose.kind, "error");
      assert.deepEqual(wrongPurpose.payload, { code: "SEND_REVIEW_UNAVAILABLE" }, lastExchangeDiagnostic);
    }
    const [sendConsent] = await exchangeFillReview({ ...sendApprovalRequest, deadlineMs: Date.now() + 10_000 }) as [{
      kind: string; payload: { operationId: string; state: string; approvedAt: number; expiresAt: number }
    }];
    assert.equal(sendConsent.kind, "fixture_send_review_approved",
      `${JSON.stringify(sendConsent.payload)} ${lastExchangeDiagnostic}`);
    assert.equal(sendConsent.payload.operationId, prepared.payload.operationId);
    assert.equal(sendConsent.payload.state, "send_approved");
    assert.equal(sendConsent.payload.expiresAt, sendReview.expiresAt);
    assert.equal(Number.isSafeInteger(sendConsent.payload.approvedAt), true);
    const [sendReplay] = await exchangeFillReview({ ...sendApprovalRequest, deadlineMs: Date.now() + 10_000 }) as [{
      kind: string; payload: { code: string }
    }];
    assert.equal(sendReplay.kind, "error");
    assert.deepEqual(sendReplay.payload, { code: "SEND_REVIEW_UNAVAILABLE" });
    assert.deepEqual((await facade.getPreparedOperation(prepared.payload.operationId)).payload, beforeSendReview.payload);
    assert.throws(() => owningFacade.listFixtureDispatchChecks(), /Broker role cannot perform/);
    const [publishedBaseline] = await exchangeFillReview({ ...request, kind: "publish_fixture_snapshot",
      deadlineMs: Date.now() + 10_000, payload: { target: sendTarget, messages: [] } }) as [{
      kind: string; payload: { count: number }
    }];
    assert.equal(publishedBaseline.kind, "fixture_snapshot_published");
    assert.equal(publishedBaseline.payload.count, 1);
    const inspecting = owningFacade.checkFixtureDispatch(prepared.payload.operationId);
    let dispatchCheckId: string | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const [listedChecks] = await exchangeFillReview({ ...request, kind: "list_fixture_dispatch_checks",
        deadlineMs: Date.now() + 10_000, payload: {} }) as [{ kind: string; payload: { checks: {
          operationId: string; checkId: string; text: string; expiresAt: number
        }[] } }];
      assert.equal(listedChecks.kind, "fixture_dispatch_checks");
      const check = listedChecks.payload.checks.find(candidate => candidate.operationId === prepared.payload.operationId);
      if (check) {
        dispatchCheckId = check.checkId;
        assert.equal(check.text, prepared.payload.preview.text);
        assert.equal(check.expiresAt > Date.now(), true);
        assert.equal(JSON.stringify(listedChecks).includes(prepared.payload.recoveryToken), false);
        break;
      }
      await setTimeout(10);
    }
    assert.ok(dispatchCheckId, "Broker did not queue a native exact-draft inspection");
    const dispatchObservation = { ok: true as const, editor: "textarea" as const, draftText: prepared.payload.preview.text,
      selected: true as const, writable: true as const, submitReady: true as const };
    assert.throws(() => owningFacade.completeFixtureDispatchCheck(sendTarget, prepared.payload.operationId,
      dispatchCheckId!, dispatchObservation), /Broker role cannot perform/);
    const dispatchCompletionRequest = { ...request, kind: "complete_fixture_dispatch_check", payload: {
      target: sendTarget, operationId: prepared.payload.operationId, checkId: dispatchCheckId, observation: dispatchObservation
    } };
    const [wrongDocumentCheck] = await exchangeFillReview({ ...dispatchCompletionRequest, deadlineMs: Date.now() + 10_000,
      payload: { ...dispatchCompletionRequest.payload, target: { ...sendTarget, documentId: "changed" } } }) as [{
      kind: string; payload: { accepted: boolean }
    }];
    assert.equal(wrongDocumentCheck.kind, "fixture_dispatch_check_recorded");
    assert.equal(wrongDocumentCheck.payload.accepted, false);
    const [dispatchChecked] = await exchangeFillReview({ ...dispatchCompletionRequest,
      deadlineMs: Date.now() + 10_000 }) as [{ kind: string; payload: { accepted: boolean } }];
    assert.equal(dispatchChecked.kind, "fixture_dispatch_check_recorded");
    assert.equal(dispatchChecked.payload.accepted, true);
    const inspected = await inspecting;
    assert.equal(inspected.kind, "fixture_dispatch_check");
    assert.deepEqual(inspected.payload, { operationId: prepared.payload.operationId, checkId: dispatchCheckId, ready: true });
    const [dispatchCheckReplay] = await exchangeFillReview({ ...dispatchCompletionRequest,
      deadlineMs: Date.now() + 10_000 }) as [{ kind: string; payload: { accepted: boolean } }];
    assert.equal(dispatchCheckReplay.payload.accepted, false);
    assert.deepEqual((await facade.getPreparedOperation(prepared.payload.operationId)).payload, beforeSendReview.payload);
    const attemptsEnvelope = { ...request, kind: "list_fixture_dispatch_attempts", payload: {},
      deadlineMs: Date.now() + 10_000 };
    const [unstartedAttempts] = await exchangeFillReview(attemptsEnvelope) as [{
      kind: string; deadlineMs: number; payload: { attempts: unknown[] }
    }];
    assert.equal(unstartedAttempts.kind, "fixture_dispatch_attempts");
    assert.equal(unstartedAttempts.deadlineMs, attemptsEnvelope.deadlineMs);
    assert.deepEqual(unstartedAttempts.payload, { attempts: [] });
    const completionEnvelope = { ...request, kind: "complete_fixture_dispatch", deadlineMs: Date.now() + 10_000,
      payload: { target: sendTarget, operationId: prepared.payload.operationId, attemptId: prepared.payload.operationId,
        observation: { ok: true, editor: "textarea", activated: true } } };
    const [unstartedCompletion] = await exchangeFillReview(completionEnvelope) as [{
      kind: string; deadlineMs: number; payload: { accepted: boolean }
    }];
    assert.equal(unstartedCompletion.kind, "fixture_dispatch_recorded");
    assert.equal(unstartedCompletion.deadlineMs, completionEnvelope.deadlineMs);
    assert.deepEqual(unstartedCompletion.payload, { accepted: false });
    assert.deepEqual((await facade.getPreparedOperation(prepared.payload.operationId)).payload, beforeSendReview.payload);
    const geminiTarget = { origin: "https://gemini.google.com" as const, conversationId: "synthetic-chat",
      url: "https://gemini.google.com/app/synthetic-chat?hl=en", tabId: 4, documentId: "synthetic-gemini-document" };
    assert.throws(() => owningFacade.listGeminiPreparedReviews(geminiTarget), /Broker role cannot perform/);
    assert.throws(() => owningFacade.listGeminiFillReviews(geminiTarget), /Broker role cannot perform/);
    assert.throws(() => owningFacade.approveGeminiReview(geminiTarget, prepared.payload.operationId, reviewId), /Broker role cannot perform/);
    assert.throws(() => owningFacade.approveGeminiFillReview(geminiTarget, prepared.payload.operationId, fillReview.reviewId), /Broker role cannot perform/);
    for (const [kind, expected] of [["list_gemini_prepared_reviews", "gemini_prepared_reviews"],
      ["list_gemini_fill_reviews", "gemini_fill_reviews"]] as const) {
      const envelope = { ...request, kind, deadlineMs: Date.now() + 10_000, payload: { target: geminiTarget } };
      const [reply] = await exchangeFillReview(envelope) as [{ kind: string; deadlineMs: number; payload: unknown }];
      assert.equal(reply.kind, expected, lastExchangeDiagnostic);
      assert.equal(reply.deadlineMs, envelope.deadlineMs);
      assert.deepEqual(reply.payload, { reviews: [], hasMore: false });
    }
    for (const [kind, code] of [["approve_gemini_review", "REVIEW_UNAVAILABLE"],
      ["approve_gemini_fill_review", "FILL_REVIEW_UNAVAILABLE"]] as const) {
      const envelope: typeof request & { payload: {
        target: typeof geminiTarget; operationId: string; reviewId: string
      } } = { ...request, kind, deadlineMs: Date.now() + 10_000,
        payload: { target: geminiTarget, operationId: prepared.payload.operationId, reviewId } };
      const [reply] = await exchangeFillReview(envelope) as [{ kind: string; deadlineMs: number; payload: unknown }];
      assert.equal(reply.kind, "error", lastExchangeDiagnostic);
      assert.equal(reply.deadlineMs, envelope.deadlineMs);
      assert.deepEqual(reply.payload, { code });
    }
    assert.deepEqual((await facade.getPreparedOperation(prepared.payload.operationId)).payload, beforeSendReview.payload);
    fillHost.stdin.end();
    const [fillExit] = await reviewPortClose;
    assert.equal(fillExit, 0, Buffer.concat(fillErrors).toString());

    const checking = facade.checkFixturePreflight(prepared.payload.operationId);
    const preflightObserver = await connectBroker("relay", join(home, ".config/agent-messaging-mcp/broker"));
    try {
      let queued = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const watch = await preflightObserver.listFixtureReadChallenges();
        if (watch.kind !== "fixture_read_challenges") throw new Error("Expected fixture watch metadata");
        if (watch.payload.preflightChecks.length) { queued = true; break; }
        await setTimeout(10);
      }
      assert.equal(queued, true, "Broker did not queue a native preflight check");
    } finally {
      preflightObserver.close();
    }
    const preflightWatchHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const preflightWatchOutput: Buffer[] = [];
    const preflightWatchErrors: Buffer[] = [];
    preflightWatchHost.stdout.on("data", (chunk: Buffer) => preflightWatchOutput.push(chunk));
    preflightWatchHost.stderr.on("data", (chunk: Buffer) => preflightWatchErrors.push(chunk));
    preflightWatchHost.stdin.end(encodeNativeFrame({ ...request, kind: "list_fixture_read_challenges",
      deadlineMs: Date.now() + 10_000 }));
    const [preflightWatchExit] = await once(preflightWatchHost, "exit");
    assert.equal(preflightWatchExit, 0, Buffer.concat(preflightWatchErrors).toString());
    const [preflightWatch] = new NativeFrameDecoder().push(Buffer.concat(preflightWatchOutput)) as [{
      kind: string; payload: { preflightChecks: { challengeId: string; operationId: string; text: string; target: unknown }[] }
    }];
    assert.equal(preflightWatch.kind, "fixture_read_challenges");
    const [preflight] = preflightWatch.payload.preflightChecks;
    assert.ok(preflight);
    assert.equal(preflight.operationId, prepared.payload.operationId);
    assert.equal(preflight.text, prepared.payload.preview.text);
    assert.deepEqual(preflight.target, approval.payload.target);
    assert.equal(JSON.stringify(preflightWatch).includes(prepared.payload.recoveryToken), false);

    const completionHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const completionOutput: Buffer[] = [];
    const completionErrors: Buffer[] = [];
    completionHost.stdout.on("data", (chunk: Buffer) => completionOutput.push(chunk));
    completionHost.stderr.on("data", (chunk: Buffer) => completionErrors.push(chunk));
    const complete = { ...request, kind: "complete_fixture_preflight", deadlineMs: Date.now() + 10_000,
      payload: { target: approval.payload.target, challengeId: preflight.challengeId,
        observation: { ok: true, editor: "textarea" } } };
    completionHost.stdin.end(Buffer.concat([encodeNativeFrame(complete), encodeNativeFrame(complete)]));
    const [completionExit] = await once(completionHost, "exit");
    assert.equal(completionExit, 0, Buffer.concat(completionErrors).toString());
    const completions = new NativeFrameDecoder().push(Buffer.concat(completionOutput)) as {
      kind: string; payload: { accepted: boolean }
    }[];
    assert.deepEqual(completions.map((reply) => ({ kind: reply.kind, payload: reply.payload })), [
      { kind: "fixture_preflight_recorded", payload: { accepted: true } },
      { kind: "fixture_preflight_recorded", payload: { accepted: false } }
    ]);
    const checked = await checking;
    if (checked.kind !== "fixture_preflight") throw new Error("Expected completed fixture preflight");
    assert.equal(checked.payload.operationId, prepared.payload.operationId);
    assert.equal(checked.payload.ok, true);
    const operationAfterCheck = await facade.getPreparedOperation(prepared.payload.operationId);
    if (operationAfterCheck.kind !== "prepared_operation_state") throw new Error("Expected operation status");
    assert.equal(operationAfterCheck.payload.state, "approved");

    const publicationHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const publicationOutput: Buffer[] = [];
    const publicationErrors: Buffer[] = [];
    publicationHost.stdout.on("data", (chunk: Buffer) => publicationOutput.push(chunk));
    publicationHost.stderr.on("data", (chunk: Buffer) => publicationErrors.push(chunk));
    const publication = { ...request, kind: "publish_fixture_snapshot", deadlineMs: Date.now() + 10_000, payload: {
      target: approval.payload.target,
      messages: [{ id: "fixture-1", direction: "incoming", text: "Can you read this message?" }]
    } };
    publicationHost.stdin.end(encodeNativeFrame(publication));
    const [publicationExit] = await once(publicationHost, "exit");
    assert.equal(publicationExit, 0, `${Buffer.concat(publicationErrors).toString()}Test deadline delta at exit: ${publication.deadlineMs - Date.now()}ms`);
    const [published] = new NativeFrameDecoder().push(Buffer.concat(publicationOutput)) as [{
      kind: string; requestId: string; payload: { count: number }
    }];
    assert.equal(published.kind, "fixture_snapshot_published");
    assert.equal(published.requestId, publication.requestId);
    assert.deepEqual(published.payload, { count: 1 });

    const reading = facade.readFixtureSnapshot(granted.payload.connectionId);
    const challengeObserver = await connectBroker("relay", join(home, ".config/agent-messaging-mcp/broker"));
    try {
      let found = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const listed = await challengeObserver.listFixtureReadChallenges();
        if (listed.kind !== "fixture_read_challenges") throw new Error("Expected read challenges");
        if (listed.payload.challenges.length) { found = true; break; }
        await setTimeout(10);
      }
      assert.equal(found, true, "Broker did not queue a native fixture read challenge");
    } finally {
      challengeObserver.close();
    }
    const challengeHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const challengeOutput: Buffer[] = [];
    const challengeErrors: Buffer[] = [];
    challengeHost.stdout.on("data", (chunk: Buffer) => challengeOutput.push(chunk));
    challengeHost.stderr.on("data", (chunk: Buffer) => challengeErrors.push(chunk));
    const challengeList = { ...request, kind: "list_fixture_read_challenges", deadlineMs: Date.now() + 10_000 };
    challengeHost.stdin.end(encodeNativeFrame(challengeList));
    const [challengeExit] = await once(challengeHost, "exit");
    assert.equal(challengeExit, 0, Buffer.concat(challengeErrors).toString());
    const [challengeReply] = new NativeFrameDecoder().push(Buffer.concat(challengeOutput)) as [{
      kind: string; requestId: string; payload: {
        challenges: { challengeId: string; target: unknown }[]; activeTabIds: number[]
      }
    }];
    assert.equal(challengeReply.kind, "fixture_read_challenges");
    assert.equal(challengeReply.requestId, challengeList.requestId);
    assert.deepEqual(challengeReply.payload.activeTabIds, [3]);
    const [challenge] = challengeReply.payload.challenges;
    assert.ok(challenge?.challengeId);
    assert.deepEqual(challenge.target, publication.payload.target);

    const responseHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const responseOutput: Buffer[] = [];
    const responseErrors: Buffer[] = [];
    responseHost.stdout.on("data", (chunk: Buffer) => responseOutput.push(chunk));
    responseHost.stderr.on("data", (chunk: Buffer) => responseErrors.push(chunk));
    responseHost.stdin.end(encodeNativeFrame({ ...publication, payload: {
      ...publication.payload, challengeId: challenge.challengeId
    } }));
    const [responseExit] = await once(responseHost, "exit");
    assert.equal(responseExit, 0, Buffer.concat(responseErrors).toString());
    const [confirmed] = new NativeFrameDecoder().push(Buffer.concat(responseOutput)) as [{
      kind: string; payload: { count: number }
    }];
    assert.equal(confirmed.kind, "fixture_snapshot_published");
    assert.deepEqual(confirmed.payload, { count: 1 });
    const snapshot = await reading;
    if (snapshot.kind !== "fixture_snapshot") throw new Error("Expected a published fixture snapshot");
    assert.deepEqual(snapshot.payload.messages, publication.payload.messages);

    const gapHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const gapOutput: Buffer[] = [];
    const gapErrors: Buffer[] = [];
    gapHost.stdout.on("data", (chunk: Buffer) => gapOutput.push(chunk));
    gapHost.stderr.on("data", (chunk: Buffer) => gapErrors.push(chunk));
    const gap = { ...request, kind: "mark_fixture_observation_gap", deadlineMs: Date.now() + 10_000,
      payload: { target: publication.payload.target } };
    gapHost.stdin.end(encodeNativeFrame(gap));
    const [gapExit] = await once(gapHost, "exit");
    assert.equal(gapExit, 0, Buffer.concat(gapErrors).toString());
    const [gapReply] = new NativeFrameDecoder().push(Buffer.concat(gapOutput)) as [{
      kind: string; requestId: string; payload: { count: number }
    }];
    assert.equal(gapReply.kind, "fixture_gap_marked");
    assert.equal(gapReply.requestId, gap.requestId);
    assert.deepEqual(gapReply.payload, { count: 1 });
    assert.deepEqual((await facade.readFixtureEvents(granted.payload.connectionId, snapshot.payload.cursor)).payload,
      { state: "expired", resnapshot: true });
    const afterGap = await facade.getConnection(created.payload.requestId);
    if (afterGap.kind !== "connection_state" || afterGap.payload.state !== "ready_readonly") {
      throw new Error("Expected a live connection after a native gap");
    }
    assert.deepEqual(afterGap.payload.observation, { state: "not_observed", capturedAt: null });

    const revokeHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const revokeOutput: Buffer[] = [];
    const revokeErrors: Buffer[] = [];
    revokeHost.stdout.on("data", (chunk: Buffer) => revokeOutput.push(chunk));
    revokeHost.stderr.on("data", (chunk: Buffer) => revokeErrors.push(chunk));
    const revoke = { ...request, kind: "revoke_fixture", deadlineMs: Date.now() + 10_000,
      payload: { tabId: 3, observed: { documentId: "next-document", conversationId: "fixture-alpha" } } };
    revokeHost.stdin.end(encodeNativeFrame(revoke));
    const [revokeExit] = await once(revokeHost, "exit");
    assert.equal(revokeExit, 0, Buffer.concat(revokeErrors).toString());
    const [revoked] = new NativeFrameDecoder().push(Buffer.concat(revokeOutput)) as [{
      kind: string; requestId: string; payload: { count: number }
    }];
    assert.equal(revoked.kind, "fixture_revoked");
    assert.equal(revoked.requestId, revoke.requestId);
    assert.deepEqual(revoked.payload, { count: 1 });
    const stale = await facade.getConnection(created.payload.requestId);
    if (stale.kind !== "connection_state") throw new Error("Expected revoked connection state");
    assert.deepEqual(stale.payload, { requestId: created.payload.requestId, state: "stale" });
    assert.deepEqual((await facade.readFixtureSnapshot(granted.payload.connectionId)).payload,
      { code: "CONNECTION_NOT_FOUND" });

    const fresh = await facade.requestConnection();
    if (fresh.kind !== "connection_requested") throw new Error("Expected new pending request");
    const brokerRelay = await connectBroker("relay", join(home, ".config/agent-messaging-mcp/broker"));
    try {
      const approved = await brokerRelay.approveFixture(fresh.payload.requestId, {
        origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 4,
        documentId: "CHROME-doc_opaque-42"
      });
      assert.equal(approved.kind, "fixture_approved");
    } finally {
      brokerRelay.close();
    }
    const freshState = await facade.getConnection(fresh.payload.requestId);
    if (freshState.kind !== "connection_state") throw new Error("Expected new owned connection state");
    assert.equal(freshState.payload.state, "ready_readonly");

    const resetHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const resetOutput: Buffer[] = [];
    const resetErrors: Buffer[] = [];
    resetHost.stdout.on("data", (chunk: Buffer) => resetOutput.push(chunk));
    resetHost.stderr.on("data", (chunk: Buffer) => resetErrors.push(chunk));
    const reset = { ...request, kind: "revoke_all_fixture", deadlineMs: Date.now() + 10_000 };
    resetHost.stdin.end(encodeNativeFrame(reset));
    const [resetExit] = await once(resetHost, "exit");
    assert.equal(resetExit, 0, Buffer.concat(resetErrors).toString());
    const [resetReply] = new NativeFrameDecoder().push(Buffer.concat(resetOutput)) as [{
      kind: string; requestId: string; payload: { count: number }
    }];
    assert.equal(resetReply.kind, "fixture_revoked");
    assert.equal(resetReply.requestId, reset.requestId);
    assert.deepEqual(resetReply.payload, { count: 1 });
    const resetState = await facade.getConnection(fresh.payload.requestId);
    if (resetState.kind !== "connection_state") throw new Error("Expected reset connection state");
    assert.deepEqual(resetState.payload, { requestId: fresh.payload.requestId, state: "stale" });

    const geminiPending = await facade.requestConnection();
    if (geminiPending.kind !== "connection_requested") throw new Error("Expected Gemini pending request");
    const geminiHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const geminiOutput: Buffer[] = [];
    const geminiErrors: Buffer[] = [];
    geminiHost.stdout.on("data", (chunk: Buffer) => geminiOutput.push(chunk));
    geminiHost.stderr.on("data", (chunk: Buffer) => geminiErrors.push(chunk));
    const geminiApproval = { ...request, kind: "approve_gemini", deadlineMs: Date.now() + 10_000, payload: {
      pendingRequestId: geminiPending.payload.requestId,
      target: { origin: "https://gemini.google.com", conversationId: "disposable-chat",
        url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 6, documentId: "CHROME-doc_gemini-42" }
    } };
    geminiHost.stdin.end(Buffer.concat([encodeNativeFrame(geminiApproval), encodeNativeFrame(geminiApproval)]));
    const [geminiExit] = await once(geminiHost, "exit");
    assert.equal(geminiExit, 0, Buffer.concat(geminiErrors).toString());
    const geminiReplies = new NativeFrameDecoder().push(Buffer.concat(geminiOutput)) as [
      { kind: string; requestId: string; payload: { requestId: string } },
      { kind: string; payload: { code: string } }
    ];
    assert.equal(geminiReplies.length, 2);
    assert.equal(geminiReplies[0].kind, "gemini_approved");
    assert.equal(geminiReplies[0].requestId, geminiApproval.requestId);
    assert.equal(geminiReplies[0].payload.requestId, geminiPending.payload.requestId);
    assert.equal(geminiReplies[1].kind, "error");
    assert.deepEqual(geminiReplies[1].payload, { code: "APPROVAL_INVALID" });
    const geminiState = await facade.getConnection(geminiPending.payload.requestId);
    if (geminiState.kind !== "connection_state" || geminiState.payload.state !== "ready_readonly") {
      throw new Error("Expected a Gemini owner connection");
    }
    assert.equal(geminiState.payload.origin, "https://gemini.google.com");
    assert.equal("url" in geminiState.payload, false);
    assert.equal("tabId" in geminiState.payload, false);
    assert.equal("documentId" in geminiState.payload, false);

    const publishHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const publishOutput: Buffer[] = [];
    const publishErrors: Buffer[] = [];
    publishHost.stdout.on("data", (chunk: Buffer) => publishOutput.push(chunk));
    publishHost.stderr.on("data", (chunk: Buffer) => publishErrors.push(chunk));
    const geminiPublication = { ...request, kind: "publish_gemini_snapshot", deadlineMs: Date.now() + 10_000,
      payload: { target: geminiApproval.payload.target,
        messages: [{ direction: "outgoing", text: "Synthetic question" },
          { direction: "incoming", text: "Synthetic answer" }] } };
    publishHost.stdin.end(encodeNativeFrame(geminiPublication));
    const [publishExit] = await once(publishHost, "exit");
    assert.equal(publishExit, 0, Buffer.concat(publishErrors).toString());
    const [publishedGemini] = new NativeFrameDecoder().push(Buffer.concat(publishOutput)) as [{
      kind: string; requestId: string; payload: { count: number }
    }];
    assert.equal(publishedGemini.kind, "gemini_snapshot_published");
    assert.equal(publishedGemini.requestId, geminiPublication.requestId);
    assert.deepEqual(publishedGemini.payload, { count: 1 });
    const observedGemini = await facade.getConnection(geminiPending.payload.requestId);
    if (observedGemini.kind !== "connection_state" || observedGemini.payload.state !== "ready_readonly") {
      throw new Error("Expected a Gemini observation state");
    }
    assert.equal(observedGemini.payload.observation.state, "recent");
    assert.equal("messages" in observedGemini.payload, false);

    const readingGemini = facade.readGeminiSnapshot(geminiState.payload.connectionId);
    const geminiObserver = await connectBroker("relay", join(home, ".config/agent-messaging-mcp/broker"));
    try {
      let found = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const listed = await geminiObserver.listGeminiReadChallenges();
        if (listed.kind !== "gemini_read_challenges") throw new Error("Expected Gemini read challenges");
        if (listed.payload.challenges.length) { found = true; break; }
        await setTimeout(10);
      }
      assert.equal(found, true, "Broker did not queue a native Gemini read challenge");
    } finally {
      geminiObserver.close();
    }
    const geminiChallengeHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const geminiChallengeOutput: Buffer[] = [];
    const geminiChallengeErrors: Buffer[] = [];
    geminiChallengeHost.stdout.on("data", (chunk: Buffer) => geminiChallengeOutput.push(chunk));
    geminiChallengeHost.stderr.on("data", (chunk: Buffer) => geminiChallengeErrors.push(chunk));
    const geminiChallengeList = { ...request, kind: "list_gemini_read_challenges", deadlineMs: Date.now() + 10_000 };
    geminiChallengeHost.stdin.end(encodeNativeFrame(geminiChallengeList));
    const [geminiChallengeExit] = await once(geminiChallengeHost, "exit");
    assert.equal(geminiChallengeExit, 0, Buffer.concat(geminiChallengeErrors).toString());
    const [geminiChallengeReply] = new NativeFrameDecoder().push(Buffer.concat(geminiChallengeOutput)) as [{
      kind: string; payload: { challenges: { challengeId: string; target: unknown }[]; activeTabIds: number[] }
    }];
    assert.equal(geminiChallengeReply.kind, "gemini_read_challenges");
    assert.deepEqual(geminiChallengeReply.payload.activeTabIds, [6]);
    const [geminiChallenge] = geminiChallengeReply.payload.challenges;
    assert.ok(geminiChallenge?.challengeId);
    assert.deepEqual(geminiChallenge.target, geminiPublication.payload.target);

    const challengedHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const challengedOutput: Buffer[] = [];
    const challengedErrors: Buffer[] = [];
    challengedHost.stdout.on("data", (chunk: Buffer) => challengedOutput.push(chunk));
    challengedHost.stderr.on("data", (chunk: Buffer) => challengedErrors.push(chunk));
    const challengedPublication = { ...geminiPublication, deadlineMs: Date.now() + 10_000,
      payload: { ...geminiPublication.payload, challengeId: geminiChallenge.challengeId,
        messages: [{ direction: "outgoing", text: "Synthetic question" },
          { direction: "incoming", text: "Fresh synthetic answer" }] } };
    challengedHost.stdin.end(encodeNativeFrame(challengedPublication));
    const [challengedExit] = await once(challengedHost, "exit");
    assert.equal(challengedExit, 0, Buffer.concat(challengedErrors).toString());
    const [challengedReply] = new NativeFrameDecoder().push(Buffer.concat(challengedOutput)) as [{
      kind: string; payload: { count: number }
    }];
    assert.equal(challengedReply.kind, "gemini_snapshot_published");
    assert.deepEqual(challengedReply.payload, { count: 1 });
    const freshGemini = await readingGemini;
    if (freshGemini.kind !== "gemini_snapshot") throw new Error("Expected challenged Gemini snapshot");
    assert.deepEqual(freshGemini.payload.messages[1], { direction: "incoming", text: "Fresh synthetic answer",
      identityQuality: "uncertain", generationState: "unknown" });
    assert.equal("url" in freshGemini.payload, false);

    const geminiGapHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const geminiGapOutput: Buffer[] = [];
    const geminiGapErrors: Buffer[] = [];
    geminiGapHost.stdout.on("data", (chunk: Buffer) => geminiGapOutput.push(chunk));
    geminiGapHost.stderr.on("data", (chunk: Buffer) => geminiGapErrors.push(chunk));
    const geminiGap = { ...request, kind: "mark_gemini_observation_gap", deadlineMs: Date.now() + 10_000,
      payload: { target: geminiPublication.payload.target } };
    geminiGapHost.stdin.end(encodeNativeFrame(geminiGap));
    const [geminiGapExit] = await once(geminiGapHost, "exit");
    assert.equal(geminiGapExit, 0, Buffer.concat(geminiGapErrors).toString());
    const [geminiGapReply] = new NativeFrameDecoder().push(Buffer.concat(geminiGapOutput)) as [{
      kind: string; requestId: string; payload: { count: number }
    }];
    assert.equal(geminiGapReply.kind, "gemini_gap_marked");
    assert.equal(geminiGapReply.requestId, geminiGap.requestId);
    assert.deepEqual(geminiGapReply.payload, { count: 1 });
    const expiredGemini = await facade.readApprovedEvents(geminiState.payload.connectionId, freshGemini.payload.cursor);
    assert.equal(expiredGemini.kind, "gemini_events");
    assert.deepEqual(expiredGemini.payload, { state: "expired", resnapshot: true });

    const geminiRelay = await connectBroker("relay", join(home, ".config/agent-messaging-mcp/broker"));
    try {
      assert.deepEqual((await geminiRelay.revokeAllFixtures()).payload, { count: 1 });
    } finally {
      geminiRelay.close();
    }
    const replayHost = spawn(process.execPath, [relayEntry, origin, origin], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }
    });
    const replayOutput: Buffer[] = [];
    const replayErrors: Buffer[] = [];
    replayHost.stdout.on("data", (chunk: Buffer) => replayOutput.push(chunk));
    replayHost.stderr.on("data", (chunk: Buffer) => replayErrors.push(chunk));
    replayHost.stdin.end(encodeNativeFrame({ ...geminiPublication, deadlineMs: Date.now() + 10_000 }));
    const [replayExit] = await once(replayHost, "exit");
    assert.equal(replayExit, 0, Buffer.concat(replayErrors).toString());
    const [replayedGemini] = new NativeFrameDecoder().push(Buffer.concat(replayOutput)) as [{
      kind: string; payload: { count: number }
    }];
    assert.equal(replayedGemini.kind, "gemini_snapshot_published");
    assert.deepEqual(replayedGemini.payload, { count: 0 });
  } finally {
    context.signal.removeEventListener("abort", stopReviewHost);
    stopReviewHost();
    if (reviewPortClose) await reviewPortClose;
    facade?.close();
    broker.kill("SIGTERM");
    await brokerExit;
    await rm(home, { recursive: true, force: true });
  }
});