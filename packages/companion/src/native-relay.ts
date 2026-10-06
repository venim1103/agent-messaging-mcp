import { homedir } from "node:os";
import { join } from "node:path";
import { connectBroker } from "./broker-client.js";
import { MAX_BROKER_PENDING_REQUESTS } from "./broker-roles.js";
import { NativeFrameDecoder, writeNativeFrame } from "./native-framing.js";
import { handleNativeHandshake, isNativeCaller, nativeBrokerFailureReason, parseNativeFixtureApproval, parseNativeFixtureGap,
  parseNativeGeminiGap,
  parseNativeFixtureReadChallenges, parseNativeGeminiApproval, parseNativeGeminiReadChallenges,
  parseNativeFixturePreparedReviews, parseNativeFixtureReviewApproval,
  parseNativeFixtureFillReviews, parseNativeFixtureFillReviewApproval,
  parseNativeFixtureSendReviews, parseNativeFixtureSendReviewApproval,
  parseNativeFixtureFill, parseNativeFixturePreflight,
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
  let pendingRequests = 0;
  let invalid = false;

  function failNativeOutput(): void {
    if (invalid) return;
    invalid = true;
    process.stderr.write("Native relay failed to write a response\n");
    process.exitCode = 1;
    process.stdin.destroy();
  }

  process.stdout.on("error", failNativeOutput);
  process.stdout.on("close", failNativeOutput);

  process.stderr.on("error", () => {
    invalid = true;
    process.exitCode = 1;
    process.stdin.destroy();
  });

  process.stdin.on("error", () => {
    if (invalid) return;
    invalid = true;
    process.stderr.write("Native relay failed to read a request\n");
    process.exitCode = 1;
    process.stdin.destroy();
  });

  function queueNativeReply(reply: () => void | Promise<void>): void {
    if (pendingRequests >= MAX_BROKER_PENDING_REQUESTS) throw new Error("Invalid native request queue");
    pendingRequests++;
    nativeReply = nativeReply.then(async () => {
      if (!invalid) await reply();
    }).catch(failNativeOutput).finally(() => { pendingRequests--; });
  }

  process.stdin.on("data", (chunk: Buffer) => {
    let deadlineMs: number | undefined;
    try {
      for (const message of decoder.frames(chunk)) {
        deadlineMs = typeof message === "object" && message !== null && "deadlineMs" in message
          && typeof message.deadlineMs === "number" && Number.isSafeInteger(message.deadlineMs) ? message.deadlineMs : undefined;
        if (typeof message === "object" && message !== null && "kind" in message && message.kind === "handshake") {
          const response = handleNativeHandshake(message);
          queueNativeReply(() => writeNativeFrame(process.stdout, response));
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
                    && message.kind === "list_fixture_prepared_reviews" ? parseNativeFixturePreparedReviews(message)
                  : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "approve_fixture_review" ? parseNativeFixtureReviewApproval(message)
                  : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "list_fixture_fill_reviews" ? parseNativeFixtureFillReviews(message)
                  : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "approve_fixture_fill_review" ? parseNativeFixtureFillReviewApproval(message)
                  : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "list_fixture_send_reviews" ? parseNativeFixtureSendReviews(message)
                  : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "approve_fixture_send_review" ? parseNativeFixtureSendReviewApproval(message)
                  : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "complete_fixture_preflight" ? parseNativeFixturePreflight(message)
                  : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "complete_fixture_fill" ? parseNativeFixtureFill(message)
                  : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "list_gemini_read_challenges" ? parseNativeGeminiReadChallenges(message)
                    : typeof message === "object" && message !== null && "kind" in message
                    && message.kind === "mark_fixture_observation_gap" ? parseNativeFixtureGap(message)
                    : typeof message === "object" && message !== null && "kind" in message
                      && message.kind === "mark_gemini_observation_gap" ? parseNativeGeminiGap(message)
              : parseNativePendingList(message);
              queueNativeReply(async () => {
          let client: Awaited<ReturnType<typeof connectBroker>> | undefined;
          let kind: "pending_list" | "fixture_read_challenges" | "fixture_prepared_reviews" | "gemini_read_challenges"
            | "fixture_approved" | "fixture_review_approved" | "gemini_approved" | "fixture_revoked"
            | "fixture_fill_reviews" | "fixture_fill_review_approved"
            | "fixture_send_reviews" | "fixture_send_review_approved"
            | "fixture_fill_recorded" | "fixture_preflight_recorded"
            | "fixture_snapshot_published" | "gemini_snapshot_published"
            | "fixture_gap_marked" | "gemini_gap_marked" | "error";
          let payload: { requests: ReadonlyArray<{ requestId: string; expiresAt: number }> }
            | { challenges: ReadonlyArray<{ challengeId: string; target: {
              origin: string; conversationId: string; tabId: number; documentId: string
            }; expiresAt: number }>; activeTabIds: ReadonlyArray<number>;
              preflightChecks: ReadonlyArray<{ challengeId: string; operationId: string; target: {
                origin: string; conversationId: string; tabId: number; documentId: string
              }; text: string; expiresAt: number }>;
              draftFills: ReadonlyArray<{ attemptId: string; operationId: string; target: {
                origin: string; conversationId: string; tabId: number; documentId: string
              }; text: string; expiresAt: number }> }
            | { challenges: ReadonlyArray<{ challengeId: string; target: {
              origin: string; conversationId: string; url: string; tabId: number; documentId: string
            }; expiresAt: number }>; activeTabIds: ReadonlyArray<number> }
            | { reviews: ReadonlyArray<{ operationId: string; reviewId: string; expiresAt: number;
              preview: { target: "fixture-alpha"; text: string } }>; hasMore: boolean }
            | { operationId: string; state: "approved" | "fill_approved" | "send_approved"; approvedAt: number; expiresAt: number }
            | { accepted: boolean }
            | { requestId: string; expiresAt: number } | { count: number } | { code: string };
          try {
            client = await connectBroker("relay", join(homedir(), ".config/agent-messaging-mcp/broker"), request.deadlineMs);
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
            } else if (request.kind === "list_fixture_prepared_reviews") {
              const result = await client.listFixturePreparedReviews(request.payload.target);
              if (result.kind !== "fixture_prepared_reviews") throw new Error("Broker refused fixture reviews");
              kind = "fixture_prepared_reviews";
              payload = result.payload;
            } else if (request.kind === "approve_fixture_review") {
              const result = await client.approveFixtureReview(request.payload.target, request.payload.operationId,
                request.payload.reviewId);
              if (result.kind === "fixture_review_approved") {
                kind = "fixture_review_approved";
                payload = result.payload;
              } else if (result.kind === "error" && result.payload.code === "REVIEW_UNAVAILABLE") {
                kind = "error";
                payload = { code: "REVIEW_UNAVAILABLE" };
              } else throw new Error("Broker refused fixture review approval");
            } else if (request.kind === "list_fixture_fill_reviews") {
              const result = await client.listFixtureFillReviews(request.payload.target);
              if (result.kind !== "fixture_fill_reviews") throw new Error("Broker refused fixture fill reviews");
              kind = "fixture_fill_reviews";
              payload = result.payload;
            } else if (request.kind === "approve_fixture_fill_review") {
              const result = await client.approveFixtureFillReview(request.payload.target, request.payload.operationId,
                request.payload.reviewId);
              if (result.kind === "fixture_fill_review_approved") {
                kind = "fixture_fill_review_approved";
                payload = result.payload;
              } else if (result.kind === "error" && result.payload.code === "FILL_REVIEW_UNAVAILABLE") {
                kind = "error";
                payload = { code: "FILL_REVIEW_UNAVAILABLE" };
              } else throw new Error("Broker refused fixture fill review approval");
            } else if (request.kind === "list_fixture_send_reviews") {
              const result = await client.listFixtureSendReviews(request.payload.target);
              if (result.kind !== "fixture_send_reviews") throw new Error("Broker refused fixture send reviews");
              kind = "fixture_send_reviews";
              payload = result.payload;
            } else if (request.kind === "approve_fixture_send_review") {
              const result = await client.approveFixtureSendReview(request.payload.target, request.payload.operationId,
                request.payload.reviewId);
              if (result.kind === "fixture_send_review_approved") {
                kind = "fixture_send_review_approved";
                payload = result.payload;
              } else if (result.kind === "error" && result.payload.code === "SEND_REVIEW_UNAVAILABLE") {
                kind = "error";
                payload = { code: "SEND_REVIEW_UNAVAILABLE" };
              } else throw new Error("Broker refused fixture send review approval");
            } else if (request.kind === "complete_fixture_preflight") {
              const result = await client.completeFixturePreflight(request.payload.target, request.payload.challengeId,
                request.payload.observation);
              if (result.kind !== "fixture_preflight_recorded") throw new Error("Broker refused fixture preflight");
              kind = "fixture_preflight_recorded";
              payload = result.payload;
            } else if (request.kind === "complete_fixture_fill") {
              const result = await client.completeFixtureFill(request.payload.target, request.payload.attemptId,
                request.payload.observation);
              if (result.kind !== "fixture_fill_recorded") throw new Error("Broker refused fixture fill result");
              kind = "fixture_fill_recorded";
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
            } else if (request.kind === "mark_gemini_observation_gap") {
              const result = await client.markGeminiObservationGap(request.payload.target);
              if (result.kind !== "gemini_gap_marked") throw new Error("Broker refused Gemini gap");
              kind = "gemini_gap_marked";
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
          } catch (error) {
            process.stderr.write(`Native relay broker failure: ${nativeBrokerFailureReason(error)}\n`);
            kind = "error";
            payload = { code: "BROKER_UNAVAILABLE" };
          } finally {
            client?.close();
          }
          if (!invalid) await writeNativeFrame(process.stdout, {
            kind, protocolVersion: PROTOCOL_VERSION, requestId: request.requestId,
            connectionGeneration: 0, deadlineMs: request.deadlineMs, payload
          });
        });
      }
    } catch (error) {
      invalid = true;
      const reason = error instanceof Error && /^Invalid native (handshake|pending list request|request queue|fixture (approval|review approval|reset|revocation|snapshot|gap|read challenge list|prepared review list)|frame size)$/.test(error.message)
        ? error.message : error instanceof SyntaxError ? "Invalid JSON" : "Invalid schema";
      const delta = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
      const deadline = Number.isSafeInteger(delta) ? String(delta) : "missing";
      process.stderr.write(`Invalid native host message: ${reason}; deadline delta ${deadline}ms\n`);
      process.exitCode = 1;
      process.stdin.destroy();
    }
  });

  function finishNativeInput(): void {
    if (invalid) return;
    try {
      decoder.finish();
    } catch {
      invalid = true;
      process.stderr.write("Invalid native host message: Incomplete native frame\n");
      process.exitCode = 1;
    }
  }

  process.stdin.on("end", finishNativeInput);
  process.stdin.on("close", finishNativeInput);
}