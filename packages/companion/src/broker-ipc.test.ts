import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startBrokerSocket } from "./broker-ipc.js";
import { createBrokerCredentials } from "./broker-roles.js";
import { encodeNativeFrame, MAX_NATIVE_FRAME_BYTES, NativeFrameDecoder } from "./native-framing.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";

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

test("private broker socket authenticates one role and refuses impersonation or a second instance", { timeout: 5000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-ipc-"));
  const directory = join(home, "broker");
  const credentials = createBrokerCredentials();
  const broker = await startBrokerSocket(directory, credentials);
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