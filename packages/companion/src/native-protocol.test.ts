import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connectBroker } from "./broker-client.js";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { handleNativeHandshake, isNativeCaller, parseNativeFixtureApproval, parseNativeFixtureGap,
  parseNativeGeminiGap,
  parseNativeFixtureReadChallenges, parseNativeFixturePreparedReviews, parseNativeFixtureReviewApproval,
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

test("native relay lists only live broker pending IDs over real framing", { timeout: 8000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-native-pending-"));
  const brokerEntry = fileURLToPath(new URL("./broker-process.js", import.meta.url));
  const relayEntry = fileURLToPath(new URL("./native-relay.js", import.meta.url));
  const broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: home }, stdio: "ignore" });
  const brokerExit = once(broker, "exit");
  let facade: Awaited<ReturnType<typeof connectBroker>> | undefined;

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
    facade?.close();
    broker.kill("SIGTERM");
    await brokerExit;
    await rm(home, { recursive: true, force: true });
  }
});