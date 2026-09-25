import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import * as z from "zod/v4";
import type { BrokerRole } from "./broker-roles.js";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";

const helloResult = z.strictObject({
  kind: z.literal("hello_result"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({ role: z.enum(["facade", "relay"]) })
});

const replySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("connection_requested"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ requestId: z.uuid(), state: z.literal("pending"), expiresAt: z.number().int().safe() })
  }),
  z.strictObject({
    kind: z.literal("connection_state"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.union([
      z.strictObject({ state: z.literal("unknown") }),
      z.strictObject({ requestId: z.uuid(), state: z.enum(["pending", "expired"]), expiresAt: z.number().int().safe() })
    ])
  }),
  z.strictObject({
    kind: z.literal("error"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ code: z.enum(["PERMISSION_DENIED", "TOO_MANY_PENDING"]) })
  })
]);

export async function connectBroker(role: BrokerRole, runtimeDirectory: string) {
  const directory = await stat(runtimeDirectory);
  const keyPath = join(runtimeDirectory, `${role}.key`);
  const key = await stat(keyPath);
  const socketPath = join(runtimeDirectory, "broker.sock");
  const socketInfo = await stat(socketPath);
  const owner = process.getuid?.();
  if (!directory.isDirectory() || directory.uid !== owner || (directory.mode & 0o077) !== 0
    || !key.isFile() || key.uid !== owner || (key.mode & 0o077) !== 0 || key.size !== 64
    || !socketInfo.isSocket() || socketInfo.uid !== owner || (socketInfo.mode & 0o077) !== 0) {
    throw new Error("Broker runtime has unsafe ownership or permissions");
  }

  const credential = await readFile(keyPath, "utf8");
  if (!/^[0-9a-f]{64}$/.test(credential)) throw new Error("Broker role credential is invalid");
  const socket = connect(socketPath);
  try {
    await once(socket, "connect");
    const requestId = randomUUID();
    const decoder = new NativeFrameDecoder();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new Error("Broker authentication timed out")), 5000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onData = (chunk: Buffer) => {
        try {
          const messages = decoder.push(chunk);
          if (messages.length > 1) throw new Error("Unexpected broker frames");
          if (messages.length === 1) { cleanup(); resolve(messages[0]); }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("Broker disconnected during authentication")); };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    socket.write(encodeNativeFrame({
      kind: "hello", protocolVersion: PROTOCOL_VERSION, requestId, connectionGeneration: 0,
      deadlineMs: Date.now() + 5000, role, credential, payload: {}
    }));
    const reply = helloResult.parse(await response);
    if (reply.requestId !== requestId || reply.payload.role !== role
      || reply.deadlineMs <= Date.now() || reply.deadlineMs > Date.now() + 30_000) {
      throw new Error("Broker returned a mismatched hello");
    }
    let nextRequest: Promise<void> = Promise.resolve();
    const request = (kind: "request_connection" | "get_connection", payload: object) => {
      if (role !== "facade") throw new Error("Only the facade can request a connection");
      const operation = nextRequest.then(async () => {
        if (socket.destroyed) throw new Error("Broker connection closed");
        const requestId = randomUUID();
        const deadlineMs = Date.now() + 5000;
        const decoder = new NativeFrameDecoder();
        const response = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => socket.destroy(new Error("Broker request timed out")), 5000);
          const cleanup = () => {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("error", onError);
            socket.off("close", onClose);
          };
          const onData = (chunk: Buffer) => {
            try {
              const messages = decoder.push(chunk);
              if (messages.length > 1) throw new Error("Unexpected broker frames");
              if (messages.length === 1) { cleanup(); resolve(messages[0]); }
            } catch (error) {
              cleanup();
              reject(error);
            }
          };
          const onError = (error: Error) => { cleanup(); reject(error); };
          const onClose = () => { cleanup(); reject(new Error("Broker disconnected during request")); };
          socket.on("data", onData);
          socket.once("error", onError);
          socket.once("close", onClose);
        });
        socket.write(encodeNativeFrame({ kind, protocolVersion: PROTOCOL_VERSION, requestId,
          connectionGeneration: 0, deadlineMs, payload }));
        const reply = replySchema.parse(await response);
        if (reply.requestId !== requestId || reply.deadlineMs !== deadlineMs) throw new Error("Mismatched broker reply");
        return reply;
      });
      nextRequest = operation.then(() => {}, () => {});
      return operation;
    };
    return {
      role,
      requestConnection: () => request("request_connection", {}),
      getConnection: (requestId: string) => request("get_connection", { requestId }),
      close: () => socket.destroy()
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}