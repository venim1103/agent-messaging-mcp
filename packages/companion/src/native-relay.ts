import { homedir } from "node:os";
import { join } from "node:path";
import { connectBroker } from "./broker-client.js";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { handleNativeHandshake, isNativeCaller, parseNativeFixtureApproval, parseNativePendingList, PROTOCOL_VERSION }
  from "./native-protocol.js";

const expectedOrigin = process.argv[2] ?? "";
const callerOrigin = process.argv[3] ?? "";

if (!isNativeCaller(expectedOrigin, callerOrigin)) {
  process.stderr.write("Native host caller origin mismatch\n");
  process.exitCode = 1;
} else {
  const decoder = new NativeFrameDecoder();
  let nativeReply: Promise<void> = Promise.resolve();
  let invalid = false;

  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) {
        if (typeof message === "object" && message !== null && "kind" in message && message.kind === "handshake") {
          process.stdout.write(encodeNativeFrame(handleNativeHandshake(message)));
          continue;
        }
        const request = typeof message === "object" && message !== null && "kind" in message
          && message.kind === "approve_fixture" ? parseNativeFixtureApproval(message) : parseNativePendingList(message);
        nativeReply = nativeReply.then(async () => {
          if (invalid) return;
          let client: Awaited<ReturnType<typeof connectBroker>> | undefined;
          let kind: "pending_list" | "fixture_approved" | "error";
          let payload: { requests: ReadonlyArray<{ requestId: string; expiresAt: number }> }
            | { requestId: string; expiresAt: number } | { code: string };
          try {
            client = await connectBroker("relay", join(homedir(), ".config/agent-messaging-mcp/broker"));
            if (request.kind === "list_pending") {
              const result = await client.listPending();
              if (result.kind !== "pending_list") throw new Error("Broker refused pending list");
              kind = "pending_list";
              payload = result.payload;
            } else {
              const result = await client.approveFixture(request.payload.pendingRequestId, request.payload.target);
              if (result.kind === "fixture_approved") {
                kind = "fixture_approved";
                payload = result.payload;
              } else if (result.kind === "error" && result.payload.code === "APPROVAL_INVALID") {
                kind = "error";
                payload = { code: "APPROVAL_INVALID" };
              } else throw new Error("Broker refused fixture approval");
            }
          } catch {
            kind = "error";
            payload = { code: "BROKER_UNAVAILABLE" };
          } finally {
            client?.close();
          }
          if (!invalid) process.stdout.write(encodeNativeFrame({
            kind, protocolVersion: PROTOCOL_VERSION, requestId: request.requestId,
            connectionGeneration: 0, deadlineMs: request.deadlineMs, payload
          }));
        }).catch(() => {
          process.stderr.write("Native relay failed to encode a pending response\n");
          process.exitCode = 1;
          process.stdin.destroy();
        });
      }
    } catch {
      invalid = true;
      process.stderr.write("Invalid native host message\n");
      process.exitCode = 1;
      process.stdin.destroy();
    }
  });
}