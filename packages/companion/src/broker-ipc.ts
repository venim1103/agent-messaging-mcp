import { chmod, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authenticateBrokerRole, MAX_BROKER_PENDING_REQUESTS, type BrokerCredentials } from "./broker-roles.js";
import { handleBrokerRequest } from "./broker-requests.js";
import { PreparedMessageOperations } from "./message-operations.js";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { PendingConnectionRequests, PENDING_REQUEST_TTL_MS } from "./pending-connections.js";

export const BROKER_IDLE_TIMEOUT_MS = PENDING_REQUEST_TTL_MS * 2 + 30_000;

async function writeBrokerResponse(socket: Socket, message: unknown): Promise<void> {
  if (socket.destroyed) throw new Error("Broker connection closed");
  if (socket.write(encodeNativeFrame(message))) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("Broker connection closed")); };
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function startBrokerSocket(runtimeDirectory: string, credentials: BrokerCredentials,
  operationDatabase?: DatabaseSync) {
  const socketPath = join(runtimeDirectory, "broker.sock");
  const facadeKeyPath = join(runtimeDirectory, "facade.key");
  const relayKeyPath = join(runtimeDirectory, "relay.key");
  const clients = new Set<Socket>();
  const requests = new PendingConnectionRequests();
  const operations = operationDatabase ? new PreparedMessageOperations(requests, operationDatabase) : undefined;
  await mkdir(runtimeDirectory, { mode: 0o700 });
  const server = createServer((socket) => {
    if (clients.size >= 16) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    const owner = Symbol("broker caller");
    socket.on("close", () => {
      clients.delete(socket);
      requests.disconnect(owner);
      operations?.disconnect(owner);
    });
    socket.on("error", () => socket.destroy());
    const timeout = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => clearTimeout(timeout));
    socket.setTimeout(BROKER_IDLE_TIMEOUT_MS, () => socket.destroy());
    const decoder = new NativeFrameDecoder();
    let role: "facade" | "relay" | null = null;
    let responses: Promise<void> = Promise.resolve();
    let pendingRequests = 0;

    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (role) {
            if (pendingRequests >= MAX_BROKER_PENDING_REQUESTS) {
              socket.destroy();
              return;
            }
            pendingRequests++;
            const authenticatedRole = role;
            responses = responses.then(async () => {
              if (socket.destroyed) return;
              const reply = handleBrokerRequest(message, authenticatedRole, owner, requests, Date.now(), operations);
              if (reply.kind === "fixture_fill_authorized") {
                const pending = operations?.requestFixtureFill(owner, reply.payload.operationId);
                if (!pending || pending === "busy") {
                  await writeBrokerResponse(socket, { ...reply, kind: "error", payload: { code: "FILL_UNAVAILABLE" } });
                  return;
                }
                const filled = await pending.result;
                if (socket.destroyed) return;
                await writeBrokerResponse(socket, { ...reply, kind: "fixture_fill", payload: filled ?? {
                  operationId: reply.payload.operationId, completedAt: Date.now(), ok: false, code: "FILL_UNCERTAIN"
                } });
                return;
              }
              if (reply.kind === "fixture_preflight_authorized") {
                const pending = operations?.requestFixturePreflight(owner, reply.payload.operationId);
                if (!pending || pending === "busy") {
                  await writeBrokerResponse(socket, { ...reply, kind: "error", payload: { code: "PREFLIGHT_UNAVAILABLE" } });
                  return;
                }
                const checked = await pending.result;
                if (socket.destroyed) return;
                await writeBrokerResponse(socket, checked
                  ? { ...reply, kind: "fixture_preflight", payload: checked }
                  : { ...reply, kind: "error", payload: { code: "PREFLIGHT_UNAVAILABLE" } });
                return;
              }
              if (reply.kind !== "fixture_read_authorized" && reply.kind !== "gemini_read_authorized") {
                await writeBrokerResponse(socket, reply);
                return;
              }
              const pending = reply.kind === "fixture_read_authorized"
                ? requests.requestFreshFixtureRead(owner, reply.payload.connectionId)
                : requests.requestFreshGeminiRead(owner, reply.payload.connectionId);
              if (!pending || pending === "busy") {
                await writeBrokerResponse(socket, { ...reply, kind: "error",
                  payload: { code: pending === "busy" ? "OBSERVATION_UNAVAILABLE" : "CONNECTION_NOT_FOUND" } });
                return;
              }
              const snapshot = await pending.result;
              if (socket.destroyed) return;
              await writeBrokerResponse(socket, snapshot && snapshot !== "not_ready"
                ? { ...reply, kind: reply.kind === "fixture_read_authorized" ? "fixture_snapshot" : "gemini_snapshot", payload: {
                  ...snapshot, messages: snapshot.messages.slice(-reply.payload.limit),
                  omittedBefore: snapshot.messages.length > reply.payload.limit
                } }
                : { ...reply, kind: "error", payload: {
                  code: snapshot === "not_ready" ? "OBSERVATION_UNAVAILABLE" : "CONNECTION_NOT_FOUND"
                } });
            }).catch(() => { socket.destroy(); }).finally(() => { pendingRequests--; });
            continue;
          }
          const hello = authenticateBrokerRole(message, credentials);
          if (!hello) {
            socket.destroy();
            return;
          }
          role = hello.role;
          clearTimeout(timeout);
          responses = writeBrokerResponse(socket, {
            kind: "hello_result",
            protocolVersion: PROTOCOL_VERSION,
            requestId: hello.requestId,
            connectionGeneration: 0,
            deadlineMs: hello.deadlineMs,
            payload: { role: hello.role }
          }).catch(() => { socket.destroy(); });
        }
      } catch {
        socket.destroy();
      }
    });
  });

  try {
    await writeFile(facadeKeyPath, credentials.facade, { flag: "wx", mode: 0o600 });
    await writeFile(relayKeyPath, credentials.relay, { flag: "wx", mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    if (server.listening) server.close();
    await unlink(socketPath).catch(() => {});
    await unlink(facadeKeyPath).catch(() => {});
    await unlink(relayKeyPath).catch(() => {});
    await rmdir(runtimeDirectory);
    throw error;
  }

  return {
    socketPath,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await unlink(facadeKeyPath);
      await unlink(relayKeyPath);
      await rmdir(runtimeDirectory);
    }
  };
}