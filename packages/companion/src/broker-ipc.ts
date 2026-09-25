import { chmod, mkdir, rmdir, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { authenticateBrokerRole, type BrokerCredentials } from "./broker-roles.js";
import { handleBrokerRequest } from "./broker-requests.js";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { PendingConnectionRequests } from "./pending-connections.js";

export async function startBrokerSocket(runtimeDirectory: string, credentials: BrokerCredentials) {
  await mkdir(runtimeDirectory, { mode: 0o700 });
  const socketPath = join(runtimeDirectory, "broker.sock");
  const clients = new Set<Socket>();
  const requests = new PendingConnectionRequests();
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
    });
    socket.on("error", () => socket.destroy());
    const timeout = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => clearTimeout(timeout));
    socket.setTimeout(30_000, () => socket.destroy());
    const decoder = new NativeFrameDecoder();
    let role: "facade" | "relay" | null = null;

    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (role) {
            socket.write(encodeNativeFrame(handleBrokerRequest(message, role, owner, requests)));
            continue;
          }
          const hello = authenticateBrokerRole(message, credentials);
          if (!hello) {
            socket.destroy();
            return;
          }
          role = hello.role;
          clearTimeout(timeout);
          socket.write(encodeNativeFrame({
            kind: "hello_result",
            protocolVersion: PROTOCOL_VERSION,
            requestId: hello.requestId,
            connectionGeneration: 0,
            deadlineMs: Date.now() + 10_000,
            payload: { role: hello.role }
          }));
        }
      } catch {
        socket.destroy();
      }
    });
  });

  try {
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
    await rmdir(runtimeDirectory);
    throw error;
  }

  return {
    socketPath,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rmdir(runtimeDirectory);
    }
  };
}