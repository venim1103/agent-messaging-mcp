import { homedir } from "node:os";
import { join } from "node:path";
import { connectBroker } from "./broker-client.js";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { handleNativeHandshake, isNativeCaller, parseNativeFixtureApproval, parseNativeFixtureGap,
  parseNativeFixtureReadChallenges, parseNativeGeminiApproval, parseNativeGeminiReadChallenges,
  parseNativeGeminiSnapshot,
  parseNativeFixtureReset, parseNativeFixtureRevocation, parseNativeFixtureSnapshot, parseNativePendingList,
  PROTOCOL_VERSION }
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
    let deadlineMs: number | undefined;
    try {
      for (const message of decoder.push(chunk)) {
        deadlineMs = typeof message === "object" && message !== null && "deadlineMs" in message
          && typeof message.deadlineMs === "number" ? message.deadlineMs : undefined;
        if (typeof message === "object" && message !== null && "kind" in message && message.kind === "handshake") {
          process.stdout.write(encodeNativeFrame(handleNativeHandshake(message)));
          continue;
        }
        const request = typeof message === "object" && message !== null && "kind" in message
          && message.kind === "approve_fixture" ? parseNativeFixtureApproval(message)
          : typeof message === "object" && message !== null && "kind" in message
            && message.kind === "approve_gemini" ? parseNativeGeminiApproval(message)
          : typeof message === "object" && message !== null && "kind" in message
            && message.kind === "revoke_fixture" ? parseNativeFixtureRevocation(message)
            : typeof message === "object" && message !== null && "kind" in message
              && message.kind === "revoke_all_fixture" ? parseNativeFixtureReset(message)
              : typeof message === "object" && message !== null && "kind" in message
                && message.kind === "publish_fixture_snapshot" ? parseNativeFixtureSnapshot(message)
                : typeof message === "object" && message !== null && "kind" in message
                  && message.kind === "publish_gemini_snapshot" ? parseNativeGeminiSnapshot(message)
                : typeof message === "object" && message !== null && "kind" in message
                  && message.kind === "list_fixture_read_challenges" ? parseNativeFixtureReadChallenges(message)
                  : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "list_gemini_read_challenges" ? parseNativeGeminiReadChallenges(message)
                    : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "mark_fixture_observation_gap" ? parseNativeFixtureGap(message)
              : parseNativePendingList(message);
        nativeReply = nativeReply.then(async () => {
          if (invalid) return;
          let client: Awaited<ReturnType<typeof connectBroker>> | undefined;
          let kind: "pending_list" | "fixture_read_challenges" | "gemini_read_challenges"
            | "fixture_approved" | "gemini_approved" | "fixture_revoked"
            | "fixture_snapshot_published" | "gemini_snapshot_published" | "fixture_gap_marked" | "error";
          let payload: { requests: ReadonlyArray<{ requestId: string; expiresAt: number }> }
            | { challenges: ReadonlyArray<{ challengeId: string; target: {
              origin: string; conversationId: string; tabId: number; documentId: string
            }; expiresAt: number }>; activeTabIds: ReadonlyArray<number> }
            | { challenges: ReadonlyArray<{ challengeId: string; target: {
              origin: string; conversationId: string; url: string; tabId: number; documentId: string
            }; expiresAt: number }>; activeTabIds: ReadonlyArray<number> }
            | { requestId: string; expiresAt: number } | { count: number } | { code: string };
          try {
            client = await connectBroker("relay", join(homedir(), ".config/agent-messaging-mcp/broker"));
            if (request.kind === "list_pending") {
              const result = await client.listPending();
              if (result.kind !== "pending_list") throw new Error("Broker refused pending list");
              kind = "pending_list";
              payload = result.payload;
            } else if (request.kind === "list_fixture_read_challenges") {
              const result = await client.listFixtureReadChallenges();
              if (result.kind !== "fixture_read_challenges") throw new Error("Broker refused read challenges");
              kind = "fixture_read_challenges";
              payload = result.payload;
            } else if (request.kind === "list_gemini_read_challenges") {
              const result = await client.listGeminiReadChallenges();
              if (result.kind !== "gemini_read_challenges") throw new Error("Broker refused Gemini read challenges");
              kind = "gemini_read_challenges";
              payload = result.payload;
            } else if (request.kind === "approve_fixture") {
              const result = await client.approveFixture(request.payload.pendingRequestId, request.payload.target);
              if (result.kind === "fixture_approved") {
                kind = "fixture_approved";
                payload = result.payload;
              } else if (result.kind === "error" && result.payload.code === "APPROVAL_INVALID") {
                kind = "error";
                payload = { code: "APPROVAL_INVALID" };
              } else throw new Error("Broker refused fixture approval");
            } else if (request.kind === "approve_gemini") {
              const result = await client.approveGemini(request.payload.pendingRequestId, request.payload.target);
              if (result.kind === "gemini_approved") {
                kind = "gemini_approved";
                payload = result.payload;
              } else if (result.kind === "error" && result.payload.code === "APPROVAL_INVALID") {
                kind = "error";
                payload = { code: "APPROVAL_INVALID" };
              } else throw new Error("Broker refused Gemini approval");
            } else if (request.kind === "revoke_fixture") {
              const result = await client.revokeFixture(request.payload.tabId, request.payload.observed);
              if (result.kind !== "fixture_revoked") throw new Error("Broker refused fixture revocation");
              kind = "fixture_revoked";
              payload = result.payload;
            } else if (request.kind === "revoke_all_fixture") {
              const result = await client.revokeAllFixtures();
              if (result.kind !== "fixture_revoked") throw new Error("Broker refused fixture reset");
              kind = "fixture_revoked";
              payload = result.payload;
            } else if (request.kind === "mark_fixture_observation_gap") {
              const result = await client.markFixtureObservationGap(request.payload.target);
              if (result.kind !== "fixture_gap_marked") throw new Error("Broker refused fixture gap");
              kind = "fixture_gap_marked";
              payload = result.payload;
            } else if (request.kind === "publish_gemini_snapshot") {
              const result = await client.publishGeminiSnapshot(request.payload.target, request.payload.messages,
                request.payload.challengeId);
              if (result.kind !== "gemini_snapshot_published") throw new Error("Broker refused Gemini snapshot");
              kind = "gemini_snapshot_published";
              payload = result.payload;
            } else {
              const result = await client.publishFixtureSnapshot(request.payload.target, request.payload.messages,
                request.payload.challengeId);
              if (result.kind !== "fixture_snapshot_published") throw new Error("Broker refused fixture snapshot");
              kind = "fixture_snapshot_published";
              payload = result.payload;
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
    } catch (error) {
      invalid = true;
      const reason = error instanceof Error && /^Invalid native (handshake|pending list request|fixture (approval|reset|revocation|snapshot|gap|read challenge list)|frame size)$/.test(error.message)
        ? error.message : error instanceof SyntaxError ? "Invalid JSON" : "Invalid schema";
      const deadline = deadlineMs === undefined ? "missing" : String(Math.trunc(deadlineMs - Date.now()));
      process.stderr.write(`Invalid native host message: ${reason}; deadline delta ${deadline}ms\n`);
      process.exitCode = 1;
      process.stdin.destroy();
    }
  });
}