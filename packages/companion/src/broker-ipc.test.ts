import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { connectBroker } from "./broker-client.js";
import { BROKER_IDLE_TIMEOUT_MS, startBrokerSocket } from "./broker-ipc.js";
import { createBrokerCredentials } from "./broker-roles.js";
import { PreparedMessageOperations } from "./message-operations.js";
import { encodeNativeFrame, MAX_NATIVE_FRAME_BYTES, NativeFrameDecoder } from "./native-framing.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { PendingConnectionRequests, PENDING_REQUEST_TTL_MS } from "./pending-connections.js";

async function exchange(socket: Socket, message: unknown): Promise<unknown> {
  const decoder = new NativeFrameDecoder();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      try {
        const [response] = decoder.push(chunk);
        if (response !== undefined) {
          cleanup();
          resolve(response);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("Broker closed without a response")); };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(encodeNativeFrame(message));
  });
}

test("authenticated fixture preparation remains owner-bound and cannot dispatch", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-prepare-ipc-"));
  const directory = join(home, "broker");
  const database = new DatabaseSync(":memory:");
  const broker = await startBrokerSocket(directory, createBrokerCredentials(), database);
  const facade = await connectBroker("facade", directory);
  const otherFacade = await connectBroker("facade", directory);
  const relay = await connectBroker("relay", directory);
  try {
    const pending = await facade.requestConnection();
    if (pending.kind !== "connection_requested") throw new Error("Expected pending fixture approval");
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    assert.equal((await relay.approveFixture(pending.payload.requestId, target)).kind, "fixture_approved");
    const connection = await facade.getConnection(pending.payload.requestId);
    if (connection.kind !== "connection_state" || connection.payload.state !== "ready_readonly") {
      throw new Error("Expected ready fixture handle");
    }
    const connectionId = connection.payload.connectionId;
    const idempotencyKey = "b66b3997-9d43-4554-8399-267d1fe9f75c";
    const text = "Synthetic fixture-only draft";
    assert.deepEqual((await otherFacade.prepareFixtureMessage(connection.payload.connectionId, 1,
      text, idempotencyKey)).payload, { code: "CONNECTION_NOT_FOUND" });
    const prepared = await facade.prepareFixtureMessage(connection.payload.connectionId, 1, text, idempotencyKey);
    if (prepared.kind !== "message_prepared") throw new Error("Expected prepared fixture draft");
    assert.equal(prepared.payload.state, "awaiting_approval");
    assert.deepEqual(prepared.payload.preview, { target: "fixture-alpha", text });
    assert.match(prepared.payload.recoveryToken, /^[0-9a-f]{64}$/);
    assert.deepEqual((await otherFacade.getPreparedOperation(prepared.payload.operationId)).payload,
      { state: "unknown" });
    assert.deepEqual((await facade.getPreparedOperation(prepared.payload.operationId)).payload,
      { operationId: prepared.payload.operationId, state: "awaiting_approval",
        expiresAt: prepared.payload.expiresAt });
    const listed = await relay.listFixturePreparedReviews(target);
    assert.equal(listed.kind, "fixture_prepared_reviews");
    if (listed.kind !== "fixture_prepared_reviews") throw new Error("Expected reviewed fixture preview");
    const reviewId = listed.payload.reviews[0]?.reviewId;
    assert.ok(reviewId);
    assert.deepEqual(listed.payload, { reviews: [{ operationId: prepared.payload.operationId, reviewId,
      expiresAt: prepared.payload.expiresAt, preview: prepared.payload.preview }], hasMore: false });
    assert.deepEqual((await relay.listFixturePreparedReviews({ ...target,
      documentId: "other-document" })).payload, { reviews: [], hasMore: false });
    assert.deepEqual((await relay.approveFixtureReview({ ...target, documentId: "other-document" },
      prepared.payload.operationId, reviewId)).payload, { code: "REVIEW_UNAVAILABLE" });
    const approved = await relay.approveFixtureReview(target, prepared.payload.operationId, reviewId);
    assert.equal(approved.kind, "fixture_review_approved");
    const operationId = prepared.payload.operationId;
    assert.deepEqual((await otherFacade.checkFixturePreflight(operationId)).payload, { code: "OPERATION_UNAVAILABLE" });
    assert.throws(() => relay.checkFixturePreflight(operationId), /role cannot perform/);
    const checking = facade.checkFixturePreflight(operationId);
    let challengeId: string | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const watch = await relay.listFixtureReadChallenges();
      if (watch.kind !== "fixture_read_challenges") throw new Error("Expected fixture watch reply");
      challengeId = watch.payload.preflightChecks[0]?.challengeId;
      if (challengeId) {
        assert.equal(watch.payload.preflightChecks[0]?.operationId, operationId);
        assert.equal(watch.payload.preflightChecks[0]?.text, text);
        assert.equal(JSON.stringify(watch.payload).includes(prepared.payload.recoveryToken), false);
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(challengeId, "Broker did not queue a preflight check");
    assert.throws(() => facade.completeFixturePreflight(target, challengeId!, { ok: true, editor: "textarea" }),
      /role cannot perform/);
    assert.deepEqual((await relay.completeFixturePreflight({ ...target, documentId: "other-document" }, challengeId,
      { ok: true, editor: "textarea" })).payload, { accepted: false });
    assert.deepEqual((await relay.completeFixturePreflight(target, challengeId, { ok: false, code: "DRAFT_PRESENT" })).payload,
      { accepted: true });
    const checked = await checking;
    if (checked.kind !== "fixture_preflight") throw new Error("Expected a fixed preflight result");
    assert.equal(checked.payload.operationId, operationId);
    assert.equal(checked.payload.ok, false);
    if (checked.payload.ok) throw new Error("Expected draft preservation");
    assert.equal(checked.payload.code, "DRAFT_PRESENT");
    assert.deepEqual((await relay.completeFixturePreflight(target, challengeId, { ok: true, editor: "textarea" })).payload,
      { accepted: false });
    assert.deepEqual((await facade.getPreparedOperation(prepared.payload.operationId)).payload,
      { operationId: prepared.payload.operationId, state: "approved", expiresAt: prepared.payload.expiresAt,
        approvalExpiresAt: approved.payload.expiresAt });
    assert.deepEqual((await relay.approveFixtureReview(target, prepared.payload.operationId,
      reviewId)).payload, { code: "REVIEW_UNAVAILABLE" });
    assert.deepEqual((await relay.listFixturePreparedReviews(target)).payload, { reviews: [], hasMore: false });
    const retry = await facade.prepareFixtureMessage(connection.payload.connectionId, 1, text, idempotencyKey);
    if (retry.kind !== "message_prepared") throw new Error("Expected same prepared draft");
    assert.equal(retry.payload.operationId, prepared.payload.operationId);
    assert.equal(retry.payload.recoveryToken, prepared.payload.recoveryToken);
    assert.deepEqual((await facade.prepareFixtureMessage(connection.payload.connectionId, 1,
      "Changed draft", idempotencyKey)).payload, { code: "IDEMPOTENCY_CONFLICT" });
    assert.throws(() => relay.prepareFixtureMessage(connectionId, 1, text, idempotencyKey),
      /role cannot perform/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get()?.count, 0);
    const cancelled = facade.checkFixturePreflight(operationId);
    let queued = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const watch = await relay.listFixtureReadChallenges();
      if (watch.kind !== "fixture_read_challenges") throw new Error("Expected pending preflight metadata");
      if (watch.payload.preflightChecks.length) { queued = true; break; }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(queued, true);
    facade.close();
    await assert.rejects(cancelled, /closed|disconnected/i);
    let cleared = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const watch = await relay.listFixtureReadChallenges();
      if (watch.kind !== "fixture_read_challenges") throw new Error("Expected cleared watch metadata");
      if (!watch.payload.preflightChecks.length) { cleared = true; break; }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cleared, true, "Closed facade left a pending preflight");
  } finally {
    facade.close();
    otherFacade.close();
    relay.close();
    await broker.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a new facade recovers uncertain status without inheriting a browser grant", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-recovery-ipc-"));
  const directory = join(home, "broker");
  const database = new DatabaseSync(":memory:");
  const requests = new PendingConnectionRequests();
  const owner = Symbol("previous owner");
  const ledger = new PreparedMessageOperations(requests, database);
  const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42" };
  const pending = requests.create(owner);
  const grant = requests.approve(pending.requestId, target)!;
  const key = "b66b3997-9d43-4554-8399-267d1fe9f75c";
  const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic receipt status", key);
  const receipt = ledger.createRecoveryReceipt(owner, prepared.operationId);
  const [review] = ledger.listFixtureReviews(target).reviews;
  assert.ok(review);
  ledger.approveFixtureReview(target, prepared.operationId, review.reviewId);
  const started = ledger.recordFixtureDispatchStart(owner, prepared.operationId);
  ledger.disconnect(owner);

  const broker = await startBrokerSocket(directory, createBrokerCredentials(), database);
  const facade = await connectBroker("facade", directory);
  const relay = await connectBroker("relay", directory);
  try {
    assert.deepEqual((await facade.getPreparedOperation(prepared.operationId)).payload, { state: "unknown" });
    assert.deepEqual((await facade.getPreparedOperation(prepared.operationId, "0".repeat(64))).payload,
      { state: "unknown" });
    const recovered = await facade.getPreparedOperation(prepared.operationId, receipt.recoveryToken);
    assert.equal(recovered.kind, "prepared_operation_state");
    assert.deepEqual(recovered.payload, { operationId: prepared.operationId, state: "dispatch_uncertain",
      startedAt: started.startedAt });
    assert.deepEqual((await facade.getConnection(pending.requestId)).payload, { state: "unknown" });
    assert.deepEqual((await facade.readApprovedSnapshot(grant.connectionId)).payload, { code: "CONNECTION_NOT_FOUND" });
    assert.deepEqual((await facade.prepareFixtureMessage(grant.connectionId, 1, "Synthetic receipt status", key)).payload,
      { code: "CONNECTION_NOT_FOUND" });
    assert.throws(() => relay.getPreparedOperation(prepared.operationId, receipt.recoveryToken), /role cannot perform/);
  } finally {
    facade.close();
    relay.close();
    await broker.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("private broker socket authenticates one role and refuses impersonation or a second instance", { timeout: 5000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-ipc-"));
  const directory = join(home, "broker");
  const credentials = createBrokerCredentials();
  const broker = await startBrokerSocket(directory, credentials);
  assert.ok(BROKER_IDLE_TIMEOUT_MS > PENDING_REQUEST_TTL_MS * 2);
  const request = {
    kind: "hello", protocolVersion: PROTOCOL_VERSION,
    requestId: "a66b3997-9d43-4554-8399-267d1fe9f75c",
    connectionGeneration: 0, deadlineMs: Date.now() + 10_000,
    role: "facade", credential: credentials.facade, payload: {}
  };

  try {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(broker.socketPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "facade.key"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "relay.key"))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(directory, "facade.key"), "utf8"), credentials.facade);
    assert.equal(await readFile(join(directory, "relay.key"), "utf8"), credentials.relay);
    await assert.rejects(startBrokerSocket(directory, credentials), { code: "EEXIST" });

    const facade = connect(broker.socketPath);
    await once(facade, "connect");
    const reply = once(facade, "data");
    const frame = encodeNativeFrame(request);
    facade.write(frame.subarray(0, 2));
    facade.write(frame.subarray(2));
    const [replyChunk] = await reply;
    const [response] = new NativeFrameDecoder().push(replyChunk as Buffer) as [{
      kind: string; protocolVersion: number; requestId: string; connectionGeneration: number;
      deadlineMs: number; payload: { role: string }
    }];
    assert.ok(response.deadlineMs > Date.now() && response.deadlineMs <= Date.now() + 10_000);
    assert.deepEqual(new NativeFrameDecoder().push(replyChunk as Buffer), [{
      kind: "hello_result", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId,
      connectionGeneration: 0, deadlineMs: response.deadlineMs,
      payload: { role: "facade" }
    }]);

    const command = {
      kind: "request_connection", protocolVersion: PROTOCOL_VERSION,
      requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0,
      deadlineMs: Date.now() + 10_000, payload: {}
    };
    const created = await exchange(facade, command) as {
      kind: string; payload: { requestId: string; state: string; expiresAt: number }
    };
    assert.equal(created.kind, "connection_requested");
    assert.equal(created.payload.state, "pending");
    const get = { ...command, kind: "get_connection", payload: { requestId: created.payload.requestId } };
    assert.deepEqual((await exchange(facade, get) as { payload: unknown }).payload, created.payload);

    const otherFacade = connect(broker.socketPath);
    await once(otherFacade, "connect");
    assert.equal((await exchange(otherFacade, request) as { payload: { role: string } }).payload.role, "facade");
    assert.deepEqual((await exchange(otherFacade, get) as { payload: unknown }).payload, { state: "unknown" });
    otherFacade.destroy();

    const relay = connect(broker.socketPath);
    await once(relay, "connect");
    assert.equal((await exchange(relay, { ...request, role: "relay", credential: credentials.relay }) as {
      payload: { role: string }
    }).payload.role, "relay");
    assert.deepEqual((await exchange(relay, get) as { payload: unknown }).payload, { code: "PERMISSION_DENIED" });
    relay.destroy();

    const closedAfterCommand = once(facade, "close");
    facade.write(encodeNativeFrame({ ...request, kind: "evaluate" }));
    await closedAfterCommand;

    const imposter = connect(broker.socketPath);
    await once(imposter, "connect");
    const closed = once(imposter, "close");
    imposter.write(encodeNativeFrame({ ...request, role: "relay" }));
    await closed;

    const oversized = connect(broker.socketPath);
    await once(oversized, "connect");
    const rejected = once(oversized, "close");
    const header = Buffer.alloc(4);
    if (endianness() === "LE") header.writeUInt32LE(MAX_NATIVE_FRAME_BYTES + 1);
    else header.writeUInt32BE(MAX_NATIVE_FRAME_BYTES + 1);
    oversized.write(header);
    await rejected;
  } finally {
    await broker.close();
    await rm(home, { recursive: true, force: true });
  }
});