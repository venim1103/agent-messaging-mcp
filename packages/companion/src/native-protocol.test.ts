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
import { handleNativeHandshake, isNativeCaller, parseNativeFixtureApproval, parseNativePendingList, PROTOCOL_VERSION }
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

  assert.equal(exitCode, 0);
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
  } finally {
    facade?.close();
    broker.kill("SIGTERM");
    await brokerExit;
    await rm(home, { recursive: true, force: true });
  }
});