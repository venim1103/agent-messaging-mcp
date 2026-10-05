import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { connectBroker } from "./broker-client.js";
import { startBrokerSocket } from "./broker-ipc.js";
import { createBrokerCredentials } from "./broker-roles.js";
import { openPrivateOperationDatabase, PreparedMessageOperations } from "./message-operations.js";
import { PendingConnectionRequests } from "./pending-connections.js";

async function brokerSocketReady(socketPath: string): Promise<boolean> {
  try {
    const info = await stat(socketPath);
    return info.isSocket() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return false;
  }
}

test("broker readiness rejects a socket until its permissions are private", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-mcp-readiness-"));
  const socketPath = join(home, "broker.sock");
  const server = createServer();
  try {
    assert.equal(await brokerSocketReady(socketPath), false);
    assert.equal(await brokerSocketReady(home), false);
    const listening = once(server, "listening");
    server.listen(socketPath);
    await listening;
    await chmod(socketPath, 0o666);
    assert.equal(await brokerSocketReady(socketPath), false);
    await chmod(socketPath, 0o600);
    assert.equal(await brokerSocketReady(socketPath), true);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("official SDK stdio client discovers and calls the diagnostic tool", async () => {
  const client = new Client({ name: "browser-chat-test", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./mcp-stdio.js", import.meta.url))]
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      "browser_chat_feasibility", "chat_request_connection", "chat_get_connection", "chat_read_messages",
      "chat_wait_for_events", "chat_prepare_message", "chat_fill_draft", "chat_get_operation", "chat_disconnect"
    ]);
    assert.ok(tools.every((tool) => /^[a-z0-9_-]+$/.test(tool.name)));
    const fillTool = tools.find((tool) => tool.name === "chat_fill_draft");
    assert.equal(fillTool?.annotations?.readOnlyHint, false);
    assert.equal(fillTool?.annotations?.idempotentHint, false);

    const result = await client.callTool({ name: "browser_chat_feasibility", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{
      type: "text",
      text: "MCP stdio diagnostic OK. No browser data was read or sent."
    }]);
  } finally {
    await client.close();
  }
});

test("concurrent first MCP calls retain one broker owner without sharing it with another facade", { timeout: 5000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-mcp-concurrent-"));
  const parent = join(home, ".config/agent-messaging-mcp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const broker = await startBrokerSocket(join(parent, "broker"), createBrokerCredentials());
  const client = new Client({ name: "concurrent-owner", version: "0.0.1" });
  const other = new Client({ name: "other-owner", version: "0.0.1" });
  const options = { command: process.execPath,
    args: [fileURLToPath(new URL("./mcp-stdio.js", import.meta.url))], env: { ...process.env, HOME: home } };
  try {
    await client.connect(new StdioClientTransport(options));
    const created = await Promise.all(Array.from({ length: 8 }, () => client.callTool({
      name: "chat_request_connection", arguments: {}
    })));
    const handles = created.map((result) => {
      assert.equal(result.isError, undefined);
      const handle = result.structuredContent as { requestId: string; state: string };
      assert.equal(handle.state, "pending");
      return handle;
    });
    assert.equal(new Set(handles.map((handle) => handle.requestId)).size, handles.length);
    const owned = await Promise.all(handles.map((handle) => client.callTool({
      name: "chat_get_connection", arguments: { requestId: handle.requestId }
    })));
    for (let index = 0; index < handles.length; index++) {
      assert.equal(owned[index]?.isError, undefined);
      assert.deepEqual(owned[index]?.structuredContent, handles[index]);
    }
    await other.connect(new StdioClientTransport(options));
    for (const handle of handles) {
      const foreign = await other.callTool({ name: "chat_get_connection", arguments: { requestId: handle.requestId } });
      assert.equal(foreign.isError, undefined);
      assert.deepEqual(foreign.structuredContent, { state: "unknown" });
    }
  } finally {
    await client.close();
    await other.close();
    await broker.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("two real MCP clients cannot reuse each other's pending handles", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-mcp-home-"));
  const entry = fileURLToPath(new URL("./mcp-stdio.js", import.meta.url));
  const brokerEntry = fileURLToPath(new URL("./broker-process.js", import.meta.url));
  const clientOne = new Client({ name: "client-one", version: "0.0.1" });
  const clientTwo = new Client({ name: "client-two", version: "0.0.1" });
  const options = { command: process.execPath, args: [entry], env: { ...process.env, HOME: home } };
  const brokerDirectory = join(home, ".config/agent-messaging-mcp/broker");
  let broker: ReturnType<typeof spawn> | undefined;
  let brokerExit: ReturnType<typeof once> | undefined;

  try {
    await clientOne.connect(new StdioClientTransport(options));
    const unavailable = await clientOne.callTool({ name: "chat_request_connection", arguments: {} });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0]?.type === "text" ? unavailable.content[0].text : "", /BROKER_UNAVAILABLE/);
    const unavailableFillId = "a66b3997-9d43-4554-8399-267d1fe9f75c";
    const unavailableFill = await clientOne.callTool({ name: "chat_fill_draft", arguments: { operationId: unavailableFillId } });
    assert.equal(unavailableFill.isError, true);
    assert.deepEqual(unavailableFill.structuredContent, { operationId: unavailableFillId, ok: false,
      code: "FILL_UNCERTAIN", retryAllowed: false });

    broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: home }, stdio: "ignore" });
    brokerExit = once(broker, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      ready = await brokerSocketReady(join(brokerDirectory, "broker.sock"));
      if (ready) break;
      await setTimeout(25);
    }
    assert.equal(ready, true, "Broker did not start");

    const created = await clientOne.callTool({ name: "chat_request_connection", arguments: {} });
    assert.equal(created.isError, undefined);
    const handle = created.structuredContent as { requestId: string; state: string; expiresAt: number };
    assert.equal(handle.state, "pending");
    const pendingRead = await clientOne.callTool({ name: "chat_read_messages", arguments: {
      connectionId: "a66b3997-9d43-4554-8399-267d1fe9f75c"
    } });
    assert.equal(pendingRead.isError, true);
    assert.match(pendingRead.content[0]?.type === "text" ? pendingRead.content[0].text : "", /CONNECTION_NOT_FOUND/);

    await clientTwo.connect(new StdioClientTransport(options));
    const hidden = await clientTwo.callTool({ name: "chat_get_connection", arguments: { requestId: handle.requestId } });
    assert.deepEqual(hidden.structuredContent, { state: "unknown" });
    const own = await clientOne.callTool({ name: "chat_get_connection", arguments: { requestId: handle.requestId } });
    assert.deepEqual(own.structuredContent, handle);

    const relay = await connectBroker("relay", brokerDirectory);
    const target = {
      origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42"
    } as const;
    const approved = await relay.approveFixture(handle.requestId, target);
    assert.equal(approved.kind, "fixture_approved");
    const readyState = await clientOne.callTool({ name: "chat_get_connection", arguments: { requestId: handle.requestId } });
    assert.equal(readyState.isError, undefined);
    const readyContent = readyState.structuredContent;
    assert.ok(readyContent && typeof readyContent === "object" && !Array.isArray(readyContent));
    assert.equal((readyContent as { state: string }).state, "ready_readonly");
    assert.equal("tabId" in readyContent, false);
    assert.deepEqual((readyContent as { observation: unknown }).observation,
      { state: "not_observed", capturedAt: null });
    const connectionId = (readyContent as { connectionId: string }).connectionId;
    const draft = { connectionId, expectedGeneration: 1, text: "Synthetic fixture-only draft",
      idempotencyKey: "b66b3997-9d43-4554-8399-267d1fe9f75c" };
    const otherPrepare = await clientTwo.callTool({ name: "chat_prepare_message", arguments: draft });
    assert.equal(otherPrepare.isError, true);
    assert.match(otherPrepare.content[0]?.type === "text" ? otherPrepare.content[0].text : "",
      /CONNECTION_NOT_FOUND/);
    const prepared = await clientOne.callTool({ name: "chat_prepare_message", arguments: draft });
    assert.equal(prepared.isError, undefined);
    const preview = prepared.structuredContent as { state: string; operationId: string;
      connectionId: string; expiresAt: number; recoveryToken: string; preview: { target: string; text: string } };
    assert.equal(preview.state, "awaiting_approval");
    assert.equal(preview.connectionId, connectionId);
    assert.deepEqual(preview.preview, { target: "fixture-alpha", text: draft.text });
    assert.match(preview.recoveryToken, /^[0-9a-f]{64}$/);
    assert.deepEqual((await clientTwo.callTool({ name: "chat_get_operation", arguments: {
      operationId: preview.operationId
    } })).structuredContent, { state: "unknown" });
    assert.deepEqual((await clientOne.callTool({ name: "chat_get_operation", arguments: {
      operationId: preview.operationId
    } })).structuredContent, { operationId: preview.operationId,
      state: "awaiting_approval", expiresAt: preview.expiresAt });
    const noReviewFill = await clientOne.callTool({ name: "chat_fill_draft", arguments: { operationId: preview.operationId } });
    assert.equal(noReviewFill.isError, true);
    assert.deepEqual(noReviewFill.structuredContent, { operationId: preview.operationId, ok: false,
      code: "FILL_UNAVAILABLE", retryAllowed: false });
    const reviewed = await relay.listFixturePreparedReviews(target);
    if (reviewed.kind !== "fixture_prepared_reviews") throw new Error("Expected test fixture review");
    assert.equal(JSON.stringify(reviewed.payload).includes(preview.recoveryToken), false);
    const reviewId = reviewed.payload.reviews[0]?.reviewId;
    assert.ok(reviewId);
    assert.equal((await relay.approveFixtureReview(target, preview.operationId, reviewId)).kind,
      "fixture_review_approved");
    const approvedState = (await clientOne.callTool({ name: "chat_get_operation", arguments: {
      operationId: preview.operationId
    } })).structuredContent as { operationId: string; state: string; approvalExpiresAt: number };
    assert.equal(approvedState.state, "approved");
    assert.equal(approvedState.operationId, preview.operationId);
    assert.ok(approvedState.approvalExpiresAt <= preview.expiresAt);
    const noFillConsent = await clientOne.callTool({ name: "chat_fill_draft", arguments: { operationId: preview.operationId } });
    assert.equal(noFillConsent.isError, true);
    assert.deepEqual(noFillConsent.structuredContent, { operationId: preview.operationId, ok: false,
      code: "FILL_UNAVAILABLE", retryAllowed: false });
    for (const extra of [{ approved: true }, { text: "Changed" }, { tabId: 3 }, { recoveryToken: preview.recoveryToken }]) {
      const invalidFill = await clientOne.callTool({ name: "chat_fill_draft", arguments: { operationId: preview.operationId, ...extra } });
      assert.equal(invalidFill.isError, true);
    }
    const fillReviewed = await relay.listFixtureFillReviews(target);
    if (fillReviewed.kind !== "fixture_fill_reviews") throw new Error("Expected separate fixture fill review");
    const fillReviewId = fillReviewed.payload.reviews[0]?.reviewId;
    assert.ok(fillReviewId);
    assert.equal((await relay.approveFixtureFillReview(target, preview.operationId, fillReviewId)).kind,
      "fixture_fill_review_approved");
    const hiddenFill = await clientTwo.callTool({ name: "chat_fill_draft", arguments: { operationId: preview.operationId } });
    assert.equal(hiddenFill.isError, true);
    assert.deepEqual(hiddenFill.structuredContent, { operationId: preview.operationId, ok: false,
      code: "FILL_UNAVAILABLE", retryAllowed: false });
    const fillApprovedStatus = await clientOne.callTool({ name: "chat_get_operation", arguments: { operationId: preview.operationId } });
    assert.equal((fillApprovedStatus.structuredContent as { draftFill: { state: string } }).draftFill.state, "fill_approved");
    const filling = clientOne.callTool({ name: "chat_fill_draft", arguments: { operationId: preview.operationId } });
    let fillAttemptId: string | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const watch = await relay.listFixtureReadChallenges();
      if (watch.kind !== "fixture_read_challenges") throw new Error("Expected native fill watch");
      fillAttemptId = watch.payload.draftFills[0]?.attemptId;
      if (fillAttemptId) {
        assert.equal(watch.payload.draftFills[0]?.text, draft.text);
        assert.deepEqual(watch.payload.draftFills[0]?.target, target);
        assert.equal(JSON.stringify(watch.payload).includes(preview.recoveryToken), false);
        break;
      }
      await setTimeout(10);
    }
    assert.ok(fillAttemptId);
    assert.deepEqual((await relay.completeFixtureFill(target, fillAttemptId, { ok: true, editor: "textarea" })).payload,
      { accepted: true });
    const fillResult = await filling;
    assert.equal(fillResult.isError, false);
    const fillPayload = fillResult.structuredContent as { operationId: string; ok: boolean; editor: string;
      completedAt: number; retryAllowed: boolean };
    assert.equal(fillPayload.operationId, preview.operationId);
    assert.equal(fillPayload.ok, true);
    assert.equal(fillPayload.editor, "textarea");
    assert.equal(fillPayload.retryAllowed, false);
    assert.equal(Number.isSafeInteger(fillPayload.completedAt), true);
    const filledState = await clientOne.callTool({ name: "chat_get_operation", arguments: { operationId: preview.operationId } });
    assert.deepEqual((filledState.structuredContent as { draftFill: unknown }).draftFill, {
      state: "filled", completedAt: fillPayload.completedAt, editor: "textarea"
    });
    assert.equal(JSON.stringify(filledState).includes(draft.text), false);
    assert.equal(JSON.stringify(filledState).includes(target.documentId), false);
    assert.equal(JSON.stringify(filledState).includes(preview.recoveryToken), false);
    assert.deepEqual((await clientTwo.callTool({ name: "chat_get_operation", arguments: { operationId: preview.operationId } }))
      .structuredContent, { state: "unknown" });
    const fillReplay = await clientOne.callTool({ name: "chat_fill_draft", arguments: { operationId: preview.operationId } });
    assert.equal(fillReplay.isError, true);
    assert.deepEqual(fillReplay.structuredContent, { operationId: preview.operationId, ok: false,
      code: "FILL_UNAVAILABLE", retryAllowed: false });
    assert.deepEqual((await clientOne.callTool({ name: "chat_prepare_message", arguments: draft })).structuredContent,
      preview);
    const conflict = await clientOne.callTool({ name: "chat_prepare_message", arguments: {
      ...draft, text: "Changed draft"
    } });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0]?.type === "text" ? conflict.content[0].text : "", /IDEMPOTENCY_CONFLICT/);
    const notObserved = await clientOne.callTool({ name: "chat_read_messages", arguments: { connectionId } });
    assert.equal(notObserved.isError, true);
    assert.match(notObserved.content[0]?.type === "text" ? notObserved.content[0].text : "",
      /OBSERVATION_UNAVAILABLE/);
    const hiddenRead = await clientTwo.callTool({ name: "chat_read_messages", arguments: { connectionId } });
    assert.equal(hiddenRead.isError, true);
    assert.match(hiddenRead.content[0]?.type === "text" ? hiddenRead.content[0].text : "", /CONNECTION_NOT_FOUND/);
    const messages = [{ id: "fixture-1", direction: "incoming" as const, text: "Synthetic fixture message" }];
    assert.deepEqual((await relay.publishFixtureSnapshot(target, messages)).payload, { count: 1 });
    const reading = clientOne.callTool({ name: "chat_read_messages", arguments: { connectionId, limit: 1 } });
    let challengeId: string | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const listed = await relay.listFixtureReadChallenges();
      if (listed.kind !== "fixture_read_challenges") throw new Error("Expected read challenges");
      const [challenge] = listed.payload.challenges;
      if (challenge) {
        assert.deepEqual(challenge.target, target);
        challengeId = challenge.challengeId;
        break;
      }
      await setTimeout(10);
    }
    assert.ok(challengeId, "MCP read did not issue a fixture browser challenge");
    assert.deepEqual((await relay.publishFixtureSnapshot(target, messages, challengeId)).payload, { count: 1 });
    const snapshot = await reading;
    assert.equal(snapshot.isError, undefined);
    assert.ok(snapshot.structuredContent && typeof snapshot.structuredContent === "object");
    assert.deepEqual((snapshot.structuredContent as { messages: unknown }).messages, messages);
    assert.equal((snapshot.structuredContent as { coverage: string }).coverage, "rendered_only");
    assert.equal((snapshot.structuredContent as { omittedBefore: boolean }).omittedBefore, false);
    const observedState = await clientOne.callTool({ name: "chat_get_connection", arguments: {
      requestId: handle.requestId
    } });
    assert.deepEqual((observedState.structuredContent as { observation: unknown }).observation,
      { state: "recent", capturedAt: (snapshot.structuredContent as { capturedAt: number }).capturedAt });
    const cursor = (snapshot.structuredContent as { cursor: { epoch: string; sequence: number } }).cursor;
    const empty = await clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId, cursor, timeoutMs: 0
    } });
    assert.deepEqual((empty.structuredContent as { events: unknown[]; timedOut: boolean }).events, []);
    assert.equal((empty.structuredContent as { timedOut: boolean }).timedOut, true);
    const hiddenEvents = await clientTwo.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId, cursor, timeoutMs: 0
    } });
    assert.equal(hiddenEvents.isError, true);
    const cancelledRequest = new AbortController();
    const cancelled = clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId, cursor, timeoutMs: 20_000
    } }, { signal: cancelledRequest.signal });
    await setTimeout(25);
    cancelledRequest.abort();
    await assert.rejects(cancelled, { name: "SdkError", message: /AbortError/ });
    const afterCancellation = await clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId, cursor, timeoutMs: 0
    } });
    assert.deepEqual((afterCancellation.structuredContent as { events: unknown[] }).events, []);
    const waiting = clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId, cursor, timeoutMs: 2000, limit: 1
    } });
    await setTimeout(25);
    const later = [{ ...messages[0]!, text: "Later synthetic fixture message" }];
    assert.deepEqual((await relay.publishFixtureSnapshot(target, later)).payload, { count: 1 });
    const observed = await waiting;
    assert.equal(observed.isError, undefined);
    const eventPage = observed.structuredContent as { events: { payload: unknown }[]; cursor: {
      epoch: string; sequence: number
    }; timedOut: boolean };
    assert.equal(eventPage.timedOut, false);
    assert.deepEqual(eventPage.events[0]?.payload, { kind: "fixture_snapshot", messages: later });
    assert.equal(eventPage.cursor.sequence, cursor.sequence + 1);
    const expired = await clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId, cursor: { epoch: "a66b3997-9d43-4554-8399-267d1fe9f75c", sequence: 1 }, timeoutMs: 0
    } });
    assert.equal(expired.isError, true);
    assert.deepEqual(expired.structuredContent, { code: "CURSOR_EXPIRED", resnapshot: true });
    assert.deepEqual((await relay.revokeFixture(3, null)).payload, { count: 1 });
    assert.deepEqual((await clientOne.callTool({ name: "chat_get_operation", arguments: {
      operationId: preview.operationId
    } })).structuredContent, { operationId: preview.operationId, state: "stale" });
    assert.equal((await clientOne.callTool({ name: "chat_prepare_message", arguments: draft })).isError, true);
    const staleRead = await clientOne.callTool({ name: "chat_read_messages", arguments: { connectionId } });
    assert.equal(staleRead.isError, true);
    assert.match(staleRead.content[0]?.type === "text" ? staleRead.content[0].text : "", /CONNECTION_NOT_FOUND/);
    const staleEvents = await clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId, cursor, timeoutMs: 0
    } });
    assert.equal(staleEvents.isError, true);

    const geminiRequested = await clientOne.callTool({ name: "chat_request_connection", arguments: {} });
    const geminiHandle = geminiRequested.structuredContent as { requestId: string };
    const geminiTarget = { origin: "https://gemini.google.com" as const,
      conversationId: "disposable-chat", url: "https://gemini.google.com/app/disposable-chat?hl=en",
      tabId: 5, documentId: "CHROME-doc_gemini-42" };
    assert.equal((await relay.approveGemini(geminiHandle.requestId, geminiTarget)).kind, "gemini_approved");
    const geminiReady = await clientOne.callTool({ name: "chat_get_connection", arguments: {
      requestId: geminiHandle.requestId
    } });
    const geminiConnection = geminiReady.structuredContent as { connectionId: string; origin: string };
    assert.equal(geminiConnection.origin, "https://gemini.google.com");
    assert.equal("url" in geminiConnection, false);
    const geminiPrepare = await clientOne.callTool({ name: "chat_prepare_message", arguments: {
      ...draft, connectionId: geminiConnection.connectionId, idempotencyKey: "c66b3997-9d43-4554-8399-267d1fe9f75c"
    } });
    assert.equal(geminiPrepare.isError, true);
    assert.match(geminiPrepare.content[0]?.type === "text" ? geminiPrepare.content[0].text : "",
      /CONNECTION_NOT_FOUND/);
    const hiddenGemini = await clientTwo.callTool({ name: "chat_read_messages", arguments: {
      connectionId: geminiConnection.connectionId
    } });
    assert.equal(hiddenGemini.isError, true);
    const geminiReading = clientOne.callTool({ name: "chat_read_messages", arguments: {
      connectionId: geminiConnection.connectionId, limit: 1
    } });
    let geminiChallengeId: string | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const listed = await relay.listGeminiReadChallenges();
      if (listed.kind !== "gemini_read_challenges") throw new Error("Expected Gemini read challenges");
      const [challenge] = listed.payload.challenges;
      if (challenge) {
        assert.deepEqual(challenge.target, geminiTarget);
        geminiChallengeId = challenge.challengeId;
        break;
      }
      await setTimeout(10);
    }
    assert.ok(geminiChallengeId, "MCP Gemini read did not issue an owner-bound challenge");
    const geminiRows = [{ direction: "outgoing" as const, text: "Synthetic question" },
      { direction: "incoming" as const, text: "Synthetic answer" }];
    assert.deepEqual((await relay.publishGeminiSnapshot({ ...geminiTarget, url: `${geminiTarget.url}&changed=1` },
      geminiRows, geminiChallengeId)).payload, { count: 0 });
    assert.deepEqual((await relay.publishGeminiSnapshot(geminiTarget, geminiRows, geminiChallengeId)).payload,
      { count: 1 });
    const geminiSnapshot = await geminiReading;
    assert.equal(geminiSnapshot.isError, undefined);
    assert.deepEqual((geminiSnapshot.structuredContent as { messages: unknown }).messages, [{
      direction: "incoming", text: "Synthetic answer", identityQuality: "uncertain", generationState: "unknown"
    }]);
    assert.equal((geminiSnapshot.structuredContent as { coverage: string }).coverage, "rendered_only");
    assert.equal((geminiSnapshot.structuredContent as { omittedBefore: boolean }).omittedBefore, true);
    assert.equal("url" in (geminiSnapshot.structuredContent as object), false);
    const geminiCursor = (geminiSnapshot.structuredContent as { cursor: { epoch: string; sequence: number } }).cursor;
    const emptyGemini = await clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId: geminiConnection.connectionId, cursor: geminiCursor, timeoutMs: 0
    } });
    assert.equal((emptyGemini.structuredContent as { timedOut: boolean }).timedOut, true);
    assert.equal((await clientTwo.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId: geminiConnection.connectionId, cursor: geminiCursor, timeoutMs: 0
    } })).isError, true);
    const waitingGemini = clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId: geminiConnection.connectionId, cursor: geminiCursor, timeoutMs: 2000, limit: 1
    } });
    await setTimeout(25);
    const laterGeminiRows = [...geminiRows, { direction: "incoming" as const, text: "Synthetic follow-up" }];
    assert.deepEqual((await relay.publishGeminiSnapshot(geminiTarget, laterGeminiRows)).payload, { count: 1 });
    const geminiEvents = await waitingGemini;
    assert.equal(geminiEvents.isError, undefined);
    const geminiPage = geminiEvents.structuredContent as { events: { payload: {
      kind: string; messages: { direction: string; text: string; identityQuality: string; generationState: string }[]
    } }[]; cursor: { sequence: number }; timedOut: boolean };
    assert.equal(geminiPage.timedOut, false);
    assert.equal(geminiPage.cursor.sequence, geminiCursor.sequence + 1);
    assert.deepEqual(geminiPage.events[0]?.payload.messages.at(-1), {
      direction: "incoming", text: "Synthetic follow-up", identityQuality: "uncertain", generationState: "unknown"
    });
    assert.equal((await clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId: geminiConnection.connectionId,
      cursor: { epoch: "a66b3997-9d43-4554-8399-267d1fe9f75c", sequence: 1 }, timeoutMs: 0
    } })).isError, true);
    assert.deepEqual((await clientOne.callTool({ name: "chat_disconnect", arguments: {
      connectionId: geminiConnection.connectionId
    } })).structuredContent, { disconnected: true });
    const afterGeminiDisconnect = await clientOne.callTool({ name: "chat_read_messages", arguments: {
      connectionId: geminiConnection.connectionId
    } });
    assert.equal(afterGeminiDisconnect.isError, true);
    assert.equal((await clientOne.callTool({ name: "chat_wait_for_events", arguments: {
      connectionId: geminiConnection.connectionId, cursor: geminiCursor, timeoutMs: 0
    } })).isError, true);

    const next = await clientOne.callTool({ name: "chat_request_connection", arguments: {} });
    const pendingDisconnect = next.structuredContent as { requestId: string };
    await relay.approveFixture(pendingDisconnect.requestId, { ...target, tabId: 4 });
    const readyDisconnect = await clientOne.callTool({ name: "chat_get_connection", arguments: {
      requestId: pendingDisconnect.requestId
    } });
    const disconnectId = (readyDisconnect.structuredContent as { connectionId: string }).connectionId;
    assert.deepEqual((await clientTwo.callTool({ name: "chat_disconnect", arguments: {
      connectionId: disconnectId
    } })).structuredContent, { disconnected: false });
    assert.deepEqual((await clientOne.callTool({ name: "chat_disconnect", arguments: {
      connectionId: disconnectId
    } })).structuredContent, { disconnected: true });
    assert.deepEqual((await clientOne.callTool({ name: "chat_disconnect", arguments: {
      connectionId: disconnectId
    } })).structuredContent, { disconnected: false });
    assert.deepEqual((await clientOne.callTool({ name: "chat_get_connection", arguments: {
      requestId: pendingDisconnect.requestId
    } })).structuredContent, { requestId: pendingDisconnect.requestId, state: "stale" });
    const disconnectedRead = await clientOne.callTool({ name: "chat_read_messages", arguments: {
      connectionId: disconnectId
    } });
    assert.equal(disconnectedRead.isError, true);
    relay.close();
    assert.deepEqual((await clientTwo.callTool({
      name: "chat_get_connection", arguments: { requestId: handle.requestId }
    })).structuredContent, { state: "unknown" });
    await clientOne.close();
    const disconnected = await clientTwo.callTool({ name: "chat_get_connection", arguments: { requestId: handle.requestId } });
    assert.deepEqual(disconnected.structuredContent, { state: "unknown" });

    broker.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: home }, stdio: "ignore" });
    brokerExit = once(broker, "exit");
    ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      ready = await brokerSocketReady(join(brokerDirectory, "broker.sock"));
      if (ready) break;
      await setTimeout(25);
    }
    assert.equal(ready, true, "Restarted broker did not start");
    const afterRestart = await clientTwo.callTool({ name: "chat_request_connection", arguments: {} });
    assert.equal(afterRestart.isError, undefined, "First request after broker restart should reconnect");
    assert.equal((afterRestart.structuredContent as { state: string }).state, "pending");
  } finally {
    await clientOne.close();
    await clientTwo.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    await rm(home, { recursive: true, force: true });
  }
});

test("a recovery receipt reveals only dispatch metadata to a fresh MCP process", { timeout: 8000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-mcp-receipt-"));
  const parent = join(home, ".config/agent-messaging-mcp");
  const client = new Client({ name: "recovery-client", version: "0.0.1" });
  const brokerEntry = fileURLToPath(new URL("./broker-process.js", import.meta.url));
  let database: ReturnType<typeof openPrivateOperationDatabase> | undefined;
  let broker: ReturnType<typeof spawn> | undefined;
  let brokerExit: ReturnType<typeof once> | undefined;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    database = openPrivateOperationDatabase(parent);
    const requests = new PendingConnectionRequests();
    const owner = Symbol("old preparing owner");
    const ledger = new PreparedMessageOperations(requests, database);
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const pending = requests.create(owner);
    const grant = requests.approve(pending.requestId, target)!;
    const prepared = ledger.prepare(owner, grant.connectionId, 1, "Synthetic recovery status only",
      "b66b3997-9d43-4554-8399-267d1fe9f75c");
    const receipt = ledger.createRecoveryReceipt(owner, prepared.operationId);
    const [review] = ledger.listFixtureReviews(target).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId);
    requests.publishFixtureSnapshot(target, [{ id: "fixture-2", direction: "outgoing", text: "Old synthetic row" }]);
    ledger.recordFixtureDispatchBaseline(owner, prepared.operationId);
    const started = { startedAt: Date.now() };
    database.prepare("INSERT INTO message_dispatch_attempts (operation_id, started_at, state) VALUES (?, ?, 'dispatching')")
      .run(prepared.operationId, started.startedAt);
    requests.publishFixtureSnapshot(target, [{ id: "fixture-2", direction: "outgoing", text: "Old synthetic row" },
      { id: "fixture-3", direction: "outgoing", text: prepared.preview.text }]);
    const observed = ledger.reconcileFixtureObservation(owner, prepared.operationId);
    assert.equal(observed.state, "observed_in_ui");
    const unresolved = ledger.prepare(owner, grant.connectionId, 1, "Other synthetic unresolved operation",
      "c66b3997-9d43-4554-8399-267d1fe9f75c");
    const unresolvedReceipt = ledger.createRecoveryReceipt(owner, unresolved.operationId);
    const [nextReview] = ledger.listFixtureReviews(target).reviews;
    assert.ok(nextReview);
    ledger.approveFixtureReview(target, unresolved.operationId, nextReview.reviewId);
    ledger.recordFixtureDispatchBaseline(owner, unresolved.operationId);
    const unresolvedStart = { startedAt: Date.now() };
    database.prepare("INSERT INTO message_dispatch_attempts (operation_id, started_at, state) VALUES (?, ?, 'dispatching')")
      .run(unresolved.operationId, unresolvedStart.startedAt);
    database.close();
    database = undefined;

    broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: home }, stdio: "ignore" });
    brokerExit = once(broker, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      ready = await brokerSocketReady(join(parent, "broker/broker.sock"));
      if (ready) break;
      await setTimeout(25);
    }
    assert.equal(ready, true, "Recovery broker did not start");
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("./mcp-stdio.js", import.meta.url))], env: { ...process.env, HOME: home } }));
    const status = { name: "chat_get_operation", arguments: { operationId: prepared.operationId } };
    assert.deepEqual((await client.callTool(status)).structuredContent, { state: "unknown" });
    assert.deepEqual((await client.callTool({ ...status, arguments: {
      ...status.arguments, recoveryToken: "0".repeat(64)
    } })).structuredContent, { state: "unknown" });
    const recovered = await client.callTool({ ...status, arguments: {
      ...status.arguments, recoveryToken: receipt.recoveryToken
    } });
    assert.equal(recovered.isError, undefined);
    assert.deepEqual(recovered.structuredContent, observed);
    assert.equal((recovered.structuredContent as { startedAt: number }).startedAt, started.startedAt);
    const uncertain = await client.callTool({ name: "chat_get_operation", arguments: {
      operationId: unresolved.operationId, recoveryToken: unresolvedReceipt.recoveryToken
    } });
    assert.deepEqual(uncertain.structuredContent, { operationId: unresolved.operationId,
      state: "dispatch_uncertain", startedAt: unresolvedStart.startedAt });
    assert.deepEqual((await client.callTool(status)).structuredContent, { state: "unknown" });
    const read = await client.callTool({ name: "chat_read_messages", arguments: { connectionId: grant.connectionId } });
    assert.equal(read.isError, true);
    assert.match(read.content[0]?.type === "text" ? read.content[0].text : "", /CONNECTION_NOT_FOUND/);
  } finally {
    await client.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    database?.close();
    await rm(home, { recursive: true, force: true });
  }
});