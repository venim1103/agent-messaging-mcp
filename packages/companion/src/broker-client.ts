import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import * as z from "zod/v4";
import { MAX_BROKER_PENDING_REQUESTS, type BrokerRole } from "./broker-roles.js";
import { fixtureDispatchStatusSchema, fixtureDraftFillStateSchema, fixtureFillStatusSchema, fixturePreflightStatusSchema,
  MAX_PENDING_FIXTURE_FILLS, MAX_PENDING_FIXTURE_PREFLIGHTS, MAX_PENDING_FIXTURE_DISPATCH_CHECKS,
  MAX_PENDING_FIXTURE_DISPATCHES,
  MAX_PREPARED_MESSAGE_BYTES, MAX_PREPARED_REVIEWS, type FixtureDispatchCheckResult,
  type FixtureDispatchResult, type FixtureFillResult, type FixturePreflightResult } from "./message-operations.js";
import type { FixtureMessage, FixtureTarget, GeminiRenderedMessage, GeminiTarget } from "./pending-connections.js";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { MAX_FIXTURE_EVENTS_PER_READ, MAX_FIXTURE_SNAPSHOT_MESSAGES, MAX_GEMINI_EVENTS_PER_READ,
  MAX_GEMINI_SNAPSHOT_MESSAGES,
  MAX_PENDING_FIXTURE_READS, MAX_PENDING_GEMINI_READS, MAX_PENDING_REQUESTS }
  from "./pending-connections.js";

const helloResult = z.strictObject({
  kind: z.literal("hello_result"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({ role: z.enum(["facade", "relay"]) })
});
const fixtureMessage = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  direction: z.enum(["incoming", "outgoing"]), text: z.string().max(2048)
});
const fixtureTarget = z.strictObject({
  origin: z.literal("http://127.0.0.1:8787"), conversationId: z.literal("fixture-alpha"),
  tabId: z.number().int().safe().positive(), documentId: z.string().regex(/^[!-~]{1,128}$/)
});
const geminiTarget = z.strictObject({
  origin: z.literal("https://gemini.google.com"),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), url: z.string().min(1).max(512),
  tabId: z.number().int().safe().positive(), documentId: z.string().regex(/^[!-~]{1,128}$/)
});
const geminiMessage = z.strictObject({
  direction: z.enum(["incoming", "outgoing"]), text: z.string().min(1).max(2048),
  identityQuality: z.literal("uncertain"), generationState: z.literal("unknown")
});
const fixtureCursor = z.strictObject({ epoch: z.uuid(), sequence: z.number().int().safe().nonnegative() });

const replySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("kept_alive"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({})
  }),
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
      z.strictObject({ requestId: z.uuid(), state: z.literal("stale") }),
      z.strictObject({ requestId: z.uuid(), state: z.enum(["pending", "expired"]), expiresAt: z.number().int().safe() }),
      z.strictObject({ requestId: z.uuid(), state: z.literal("ready_readonly"), connectionId: z.uuid(),
        generation: z.literal(1), origin: z.literal("http://127.0.0.1:8787"),
        conversationId: z.literal("fixture-alpha"), expiresAt: z.number().int().safe(),
        observation: z.strictObject({ state: z.enum(["not_observed", "recent", "old"]),
          capturedAt: z.number().int().safe().nullable() }) }),
      z.strictObject({ requestId: z.uuid(), state: z.literal("ready_readonly"), connectionId: z.uuid(),
        generation: z.literal(1), origin: z.literal("https://gemini.google.com"),
        conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), expiresAt: z.number().int().safe(),
        observation: z.strictObject({ state: z.enum(["not_observed", "recent", "old"]),
          capturedAt: z.number().int().safe().nullable() }) })
    ])
  }),
  z.strictObject({
    kind: z.literal("pending_list"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({
      requests: z.array(z.strictObject({ requestId: z.uuid(), expiresAt: z.number().int().safe() }))
        .max(MAX_PENDING_REQUESTS)
    })
  }),
  z.strictObject({
    kind: z.literal("fixture_approved"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ requestId: z.uuid(), expiresAt: z.number().int().safe() })
  }),
  z.strictObject({
    kind: z.literal("gemini_approved"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ requestId: z.uuid(), expiresAt: z.number().int().safe() })
  }),
  z.strictObject({
    kind: z.literal("fixture_revoked"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ count: z.number().int().safe().nonnegative() })
  }),
  z.strictObject({
    kind: z.literal("fixture_snapshot_published"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ count: z.number().int().safe().nonnegative() })
  }),
  z.strictObject({
    kind: z.literal("gemini_snapshot_published"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ count: z.number().int().safe().nonnegative() })
  }),
  z.strictObject({
    kind: z.literal("fixture_read_challenges"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ challenges: z.array(z.strictObject({
      challengeId: z.uuid(), target: fixtureTarget, expiresAt: z.number().int().safe()
    })).max(MAX_PENDING_FIXTURE_READS),
    activeTabIds: z.array(z.number().int().safe().positive()).max(MAX_PENDING_REQUESTS),
    preflightChecks: z.array(z.strictObject({ challengeId: z.uuid(), operationId: z.uuid(), target: fixtureTarget,
      text: z.string().min(1).max(MAX_PREPARED_MESSAGE_BYTES), expiresAt: z.number().int().safe()
    })).max(MAX_PENDING_FIXTURE_PREFLIGHTS),
    draftFills: z.array(z.strictObject({ attemptId: z.uuid(), operationId: z.uuid(), target: fixtureTarget,
      text: z.string().min(1).max(MAX_PREPARED_MESSAGE_BYTES), expiresAt: z.number().int().safe()
    })).max(MAX_PENDING_FIXTURE_FILLS) })
  }),
  z.strictObject({
    kind: z.literal("fixture_prepared_reviews"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ reviews: z.array(z.strictObject({
      operationId: z.uuid(), reviewId: z.uuid(), expiresAt: z.number().int().safe(),
      preview: z.strictObject({ target: z.literal("fixture-alpha"),
        text: z.string().min(1).max(MAX_PREPARED_MESSAGE_BYTES) })
    })).max(MAX_PREPARED_REVIEWS), hasMore: z.boolean() })
  }),
  z.strictObject({
    kind: z.literal("fixture_review_approved"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ operationId: z.uuid(), state: z.literal("approved"),
      approvedAt: z.number().int().safe(), expiresAt: z.number().int().safe() })
  }),
  z.strictObject({
    kind: z.literal("fixture_fill_reviews"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ reviews: z.array(z.strictObject({
      operationId: z.uuid(), reviewId: z.uuid(), expiresAt: z.number().int().safe(),
      preview: z.strictObject({ target: z.literal("fixture-alpha"),
        text: z.string().min(1).max(MAX_PREPARED_MESSAGE_BYTES) })
    })).max(MAX_PREPARED_REVIEWS), hasMore: z.boolean() })
  }),
  z.strictObject({
    kind: z.literal("fixture_fill_review_approved"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ operationId: z.uuid(), state: z.literal("fill_approved"),
      approvedAt: z.number().int().safe(), expiresAt: z.number().int().safe() })
  }),
  z.strictObject({
    kind: z.literal("fixture_send_reviews"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ reviews: z.array(z.strictObject({
      operationId: z.uuid(), reviewId: z.uuid(), expiresAt: z.number().int().safe(),
      preview: z.strictObject({ target: z.literal("fixture-alpha"),
        text: z.string().min(1).max(MAX_PREPARED_MESSAGE_BYTES) })
    })).max(MAX_PREPARED_REVIEWS), hasMore: z.boolean() })
  }),
  z.strictObject({
    kind: z.literal("fixture_send_review_approved"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ operationId: z.uuid(), state: z.literal("send_approved"),
      approvedAt: z.number().int().safe(), expiresAt: z.number().int().safe() })
  }),
  z.strictObject({
    kind: z.literal("fixture_preflight"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: fixturePreflightStatusSchema
  }),
  z.strictObject({
    kind: z.literal("fixture_preflight_recorded"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ accepted: z.boolean() })
  }),
  z.strictObject({
    kind: z.literal("fixture_dispatch_checks"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ checks: z.array(z.strictObject({ operationId: z.uuid(), checkId: z.uuid(),
      target: fixtureTarget, text: z.string().min(1).max(2048), expiresAt: z.number().int().safe()
    })).max(MAX_PENDING_FIXTURE_DISPATCH_CHECKS) })
  }),
  z.strictObject({
    kind: z.literal("fixture_dispatch_check"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ operationId: z.uuid(), checkId: z.uuid(), ready: z.boolean() })
  }),
  z.strictObject({
    kind: z.literal("fixture_dispatch_check_recorded"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ accepted: z.boolean() })
  }),
  z.strictObject({
    kind: z.literal("fixture_dispatch_attempts"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ attempts: z.array(z.strictObject({ operationId: z.uuid(), attemptId: z.uuid(),
      target: fixtureTarget, text: z.string().min(1).max(2048), expiresAt: z.number().int().safe()
    })).max(MAX_PENDING_FIXTURE_DISPATCHES) })
  }),
  z.strictObject({
    kind: z.literal("fixture_dispatch"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: fixtureDispatchStatusSchema
  }),
  z.strictObject({
    kind: z.literal("fixture_dispatch_recorded"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ accepted: z.boolean() })
  }),
  z.strictObject({
    kind: z.literal("fixture_fill"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: fixtureFillStatusSchema
  }),
  z.strictObject({
    kind: z.literal("fixture_fill_recorded"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ accepted: z.boolean() })
  }),
  z.strictObject({
    kind: z.literal("gemini_read_challenges"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ challenges: z.array(z.strictObject({
      challengeId: z.uuid(), target: geminiTarget, expiresAt: z.number().int().safe()
    })).max(MAX_PENDING_GEMINI_READS),
    activeTabIds: z.array(z.number().int().safe().positive()).max(MAX_PENDING_REQUESTS) })
  }),
  z.strictObject({
    kind: z.literal("fixture_disconnected"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ disconnected: z.boolean() })
  }),
  z.strictObject({
    kind: z.literal("message_prepared"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ operationId: z.uuid(), connectionId: z.uuid(),
      state: z.literal("awaiting_approval"), expiresAt: z.number().int().safe(),
      recoveryToken: z.string().regex(/^[0-9a-f]{64}$/),
      preview: z.strictObject({ target: z.literal("fixture-alpha"),
        text: z.string().min(1).max(MAX_PREPARED_MESSAGE_BYTES) }) })
  }),
  z.strictObject({
    kind: z.literal("prepared_operation_state"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.discriminatedUnion("state", [
      z.strictObject({ state: z.literal("unknown") }),
      z.strictObject({ operationId: z.uuid(), state: z.literal("expired") }),
      z.strictObject({ operationId: z.uuid(), state: z.literal("stale") }),
      z.strictObject({ operationId: z.uuid(), state: z.literal("awaiting_approval"),
        expiresAt: z.number().int().safe(), draftFill: fixtureDraftFillStateSchema.optional() }),
      z.strictObject({ operationId: z.uuid(), state: z.literal("approved"),
        expiresAt: z.number().int().safe(), approvalExpiresAt: z.number().int().safe(),
        draftFill: fixtureDraftFillStateSchema.optional() }),
      z.strictObject({ operationId: z.uuid(), state: z.literal("dispatch_uncertain"),
        startedAt: z.number().int().safe() }),
      z.strictObject({ operationId: z.uuid(), state: z.literal("observed_in_ui"),
        startedAt: z.number().int().safe(), observedAt: z.number().int().safe(),
        messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })
    ])
  }),
  z.strictObject({
    kind: z.literal("fixture_gap_marked"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ count: z.number().int().safe().nonnegative() })
  }),
  z.strictObject({
    kind: z.literal("gemini_gap_marked"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ count: z.number().int().safe().nonnegative() })
  }),
  z.strictObject({
    kind: z.literal("fixture_snapshot"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({
      coverage: z.literal("rendered_only"), generation: z.literal(1), capturedAt: z.number().int().safe(),
      cursor: fixtureCursor,
      messages: z.array(fixtureMessage).max(MAX_FIXTURE_SNAPSHOT_MESSAGES), omittedBefore: z.boolean()
    })
  }),
  z.strictObject({
    kind: z.literal("gemini_snapshot"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({
      coverage: z.literal("rendered_only"), generation: z.literal(1), capturedAt: z.number().int().safe(),
      cursor: fixtureCursor,
      messages: z.array(geminiMessage).max(MAX_GEMINI_SNAPSHOT_MESSAGES), omittedBefore: z.boolean()
    })
  }),
  z.strictObject({
    kind: z.literal("fixture_events"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.discriminatedUnion("state", [
      z.strictObject({ state: z.literal("expired"), resnapshot: z.literal(true) }),
      z.strictObject({ state: z.literal("ok"), cursor: fixtureCursor,
        events: z.array(z.strictObject({ epoch: z.uuid(), sequence: z.number().int().safe().positive(),
          payload: z.strictObject({ kind: z.literal("fixture_snapshot"),
            messages: z.array(fixtureMessage).max(MAX_FIXTURE_SNAPSHOT_MESSAGES) })
        })).max(MAX_FIXTURE_EVENTS_PER_READ) })
    ])
  }),
  z.strictObject({
    kind: z.literal("gemini_events"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.discriminatedUnion("state", [
      z.strictObject({ state: z.literal("expired"), resnapshot: z.literal(true) }),
      z.strictObject({ state: z.literal("ok"), cursor: fixtureCursor,
        events: z.array(z.strictObject({ epoch: z.uuid(), sequence: z.number().int().safe().positive(),
          payload: z.strictObject({ kind: z.literal("gemini_snapshot"),
            messages: z.array(geminiMessage).max(MAX_GEMINI_SNAPSHOT_MESSAGES) })
        })).max(MAX_GEMINI_EVENTS_PER_READ) })
    ])
  }),
  z.strictObject({
    kind: z.literal("error"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ code: z.enum(["PERMISSION_DENIED", "TOO_MANY_PENDING", "APPROVAL_INVALID",
      "OBSERVATION_UNAVAILABLE", "CONNECTION_NOT_FOUND", "PREPARATION_UNAVAILABLE", "GENERATION_MISMATCH",
      "INVALID_MESSAGE_TEXT", "INVALID_IDEMPOTENCY_KEY", "IDEMPOTENCY_CONFLICT", "OPERATION_EXPIRED",
      "OPERATION_UNAVAILABLE", "TOO_MANY_PREPARED", "REVIEW_UNAVAILABLE", "FILL_REVIEW_UNAVAILABLE",
      "SEND_REVIEW_UNAVAILABLE",
      "DISPATCH_CHECK_UNAVAILABLE", "DISPATCH_UNAVAILABLE",
      "DISPATCH_UNCERTAIN", "PREFLIGHT_UNAVAILABLE", "FILL_UNAVAILABLE"]) })
  })
]);

export function brokerRequestDeadline(now: number, upstreamDeadlineMs?: number): number {
  const localDeadline = now + 5000;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(localDeadline)
    || (upstreamDeadlineMs !== undefined && (!Number.isSafeInteger(upstreamDeadlineMs)
      || upstreamDeadlineMs <= now || upstreamDeadlineMs > now + 30_000))) {
    throw new Error("Invalid broker request deadline");
  }
  return Math.min(localDeadline, upstreamDeadlineMs ?? localDeadline);
}

export async function connectBroker(role: BrokerRole, runtimeDirectory: string, upstreamDeadlineMs?: number) {
  brokerRequestDeadline(Date.now(), upstreamDeadlineMs);
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
    const startedAt = Date.now();
    const deadlineMs = brokerRequestDeadline(startedAt, upstreamDeadlineMs);
    const decoder = new NativeFrameDecoder();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new Error("Broker authentication timed out")), deadlineMs - startedAt);
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
      deadlineMs, role, credential, payload: {}
    }));
    const reply = helloResult.parse(await response);
    if (reply.requestId !== requestId || reply.payload.role !== role
      || reply.deadlineMs !== deadlineMs
      || reply.deadlineMs <= Date.now() || reply.deadlineMs > Date.now() + 30_000) {
      throw new Error("Broker returned a mismatched hello");
    }
    let nextRequest: Promise<void> = Promise.resolve();
    let pendingRequests = 0;
    const request = (kind: "keep_alive" | "request_connection" | "get_connection" | "read_fixture_snapshot" | "read_fixture_events"
      | "read_approved_events"
      | "read_gemini_snapshot" | "read_approved_snapshot"
      | "disconnect_fixture" | "prepare_fixture_message" | "get_prepared_operation"
      | "check_fixture_preflight" | "complete_fixture_preflight"
      | "check_fixture_dispatch" | "list_fixture_dispatch_checks" | "complete_fixture_dispatch_check"
      | "dispatch_fixture_message" | "commit_fixture_message" | "list_fixture_dispatch_attempts" | "complete_fixture_dispatch"
      | "fill_fixture_draft" | "complete_fixture_fill"
      | "list_pending" | "list_fixture_read_challenges" | "list_fixture_prepared_reviews"
      | "approve_fixture_review"
      | "list_fixture_fill_reviews" | "approve_fixture_fill_review"
      | "list_fixture_send_reviews" | "approve_fixture_send_review"
      | "list_gemini_read_challenges"
      | "approve_fixture" | "approve_gemini"
      | "publish_fixture_snapshot" | "publish_gemini_snapshot"
      | "revoke_fixture" | "revoke_all_fixture" | "mark_fixture_observation_gap"
      | "mark_gemini_observation_gap", payload: object) => {
      if (kind === "list_pending" || kind === "list_fixture_read_challenges"
        || kind === "list_fixture_prepared_reviews" || kind === "approve_fixture_review"
        || kind === "list_fixture_fill_reviews" || kind === "approve_fixture_fill_review"
        || kind === "list_fixture_send_reviews" || kind === "approve_fixture_send_review"
        || kind === "complete_fixture_preflight"
        || kind === "list_fixture_dispatch_checks" || kind === "complete_fixture_dispatch_check"
        || kind === "list_fixture_dispatch_attempts" || kind === "complete_fixture_dispatch"
        || kind === "complete_fixture_fill"
        || kind === "list_gemini_read_challenges"
        || kind === "approve_fixture" || kind === "approve_gemini" || kind === "revoke_fixture"
        || kind === "revoke_all_fixture" || kind === "publish_fixture_snapshot"
        || kind === "publish_gemini_snapshot"
        || kind === "mark_fixture_observation_gap" || kind === "mark_gemini_observation_gap"
        ? role !== "relay" : role !== "facade") {
        throw new Error("Broker role cannot perform this operation");
      }
      if (pendingRequests >= MAX_BROKER_PENDING_REQUESTS) return Promise.reject(new Error("Broker request queue is full"));
      pendingRequests++;
      const operation = nextRequest.then(async () => {
        if (socket.destroyed) throw new Error("Broker connection closed");
        const requestId = randomUUID();
        const startedAt = Date.now();
        const deadlineMs = brokerRequestDeadline(startedAt, upstreamDeadlineMs);
        const frame = encodeNativeFrame({ kind, protocolVersion: PROTOCOL_VERSION, requestId,
          connectionGeneration: 0, deadlineMs, payload });
        const responseStartedAt = Date.now();
        const responseTimeoutMs = brokerRequestDeadline(responseStartedAt, deadlineMs) - responseStartedAt;
        const decoder = new NativeFrameDecoder();
        const response = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => socket.destroy(new Error("Broker request timed out")), responseTimeoutMs);
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
        socket.write(frame);
        const reply = replySchema.parse(await response);
        if (reply.requestId !== requestId || reply.deadlineMs !== deadlineMs) throw new Error("Mismatched broker reply");
        if (reply.deadlineMs <= Date.now()) throw new Error("Broker reply expired");
        return reply;
      });
      const completed = operation.finally(() => { pendingRequests--; });
      nextRequest = completed.then(() => {}, () => {});
      return completed;
    };
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const stopKeepAlive = () => {
      if (keepAlive === undefined) return;
      clearInterval(keepAlive);
      keepAlive = undefined;
    };
    socket.once("close", stopKeepAlive);
    if (role === "facade" && upstreamDeadlineMs === undefined) {
      keepAlive = setInterval(() => {
        if (socket.destroyed || pendingRequests !== 0) return;
        void request("keep_alive", {}).then((reply) => {
          if (reply.kind !== "kept_alive") socket.destroy();
        }, () => socket.destroy());
      }, 60_000);
      keepAlive.unref();
    }
    return {
      role,
      get closed() { return socket.destroyed; },
      requestConnection: () => request("request_connection", {}),
      getConnection: (requestId: string) => request("get_connection", { requestId }),
      readFixtureSnapshot: (connectionId: string, limit?: number) =>
        request("read_fixture_snapshot", { connectionId, ...(limit === undefined ? {} : { limit }) }),
      readGeminiSnapshot: (connectionId: string, limit?: number) =>
        request("read_gemini_snapshot", { connectionId, ...(limit === undefined ? {} : { limit }) }),
      readApprovedSnapshot: (connectionId: string, limit?: number) =>
        request("read_approved_snapshot", { connectionId, ...(limit === undefined ? {} : { limit }) }),
      readFixtureEvents: (connectionId: string, cursor: { epoch: string; sequence: number }, limit?: number) =>
        request("read_fixture_events", { connectionId, cursor, ...(limit === undefined ? {} : { limit }) }),
      readApprovedEvents: (connectionId: string, cursor: { epoch: string; sequence: number }, limit?: number) =>
        request("read_approved_events", { connectionId, cursor, ...(limit === undefined ? {} : { limit }) }),
      disconnectFixture: (connectionId: string) => request("disconnect_fixture", { connectionId }),
      prepareFixtureMessage: (connectionId: string, expectedGeneration: 1, text: string, idempotencyKey: string) =>
        request("prepare_fixture_message", { connectionId, expectedGeneration, text, idempotencyKey }),
      getPreparedOperation: (operationId: string, recoveryToken?: string) =>
        request("get_prepared_operation", { operationId,
          ...(recoveryToken === undefined ? {} : { recoveryToken }) }),
      checkFixturePreflight: (operationId: string) => request("check_fixture_preflight", { operationId }),
      completeFixturePreflight: (target: FixtureTarget, challengeId: string, observation: FixturePreflightResult) =>
        request("complete_fixture_preflight", { target, challengeId, observation }),
      checkFixtureDispatch: (operationId: string) => request("check_fixture_dispatch", { operationId }),
      listFixtureDispatchChecks: () => request("list_fixture_dispatch_checks", {}),
      completeFixtureDispatchCheck: (target: FixtureTarget, operationId: string, checkId: string,
        observation: FixtureDispatchCheckResult) =>
        request("complete_fixture_dispatch_check", { target, operationId, checkId, observation }),
      dispatchFixtureMessage: (operationId: string, checkId: string) => request("dispatch_fixture_message", { operationId, checkId }),
      commitFixtureMessage: (operationId: string) => request("commit_fixture_message", { operationId }),
      listFixtureDispatchAttempts: () => request("list_fixture_dispatch_attempts", {}),
      completeFixtureDispatch: (target: FixtureTarget, operationId: string, attemptId: string,
        observation: FixtureDispatchResult) => request("complete_fixture_dispatch", { target, operationId, attemptId, observation }),
      fillFixtureDraft: (operationId: string) => request("fill_fixture_draft", { operationId }),
      completeFixtureFill: (target: FixtureTarget, attemptId: string, observation: FixtureFillResult) =>
        request("complete_fixture_fill", { target, attemptId, observation }),
      listPending: () => request("list_pending", {}),
      listFixtureReadChallenges: () => request("list_fixture_read_challenges", {}),
      listFixturePreparedReviews: (target: FixtureTarget) => request("list_fixture_prepared_reviews", { target }),
      approveFixtureReview: (target: FixtureTarget, operationId: string, reviewId: string) =>
        request("approve_fixture_review", { target, operationId, reviewId }),
      listFixtureFillReviews: (target: FixtureTarget) => request("list_fixture_fill_reviews", { target }),
      approveFixtureFillReview: (target: FixtureTarget, operationId: string, reviewId: string) =>
        request("approve_fixture_fill_review", { target, operationId, reviewId }),
      listFixtureSendReviews: (target: FixtureTarget) => request("list_fixture_send_reviews", { target }),
      approveFixtureSendReview: (target: FixtureTarget, operationId: string, reviewId: string) =>
        request("approve_fixture_send_review", { target, operationId, reviewId }),
      listGeminiReadChallenges: () => request("list_gemini_read_challenges", {}),
      approveFixture: (pendingRequestId: string, target: FixtureTarget) =>
        request("approve_fixture", { pendingRequestId, target }),
      approveGemini: (pendingRequestId: string, target: GeminiTarget) =>
        request("approve_gemini", { pendingRequestId, target }),
      publishFixtureSnapshot: (target: FixtureTarget, messages: ReadonlyArray<FixtureMessage>, challengeId?: string) =>
        request("publish_fixture_snapshot", { target, messages,
          ...(challengeId === undefined ? {} : { challengeId }) }),
      publishGeminiSnapshot: (target: GeminiTarget, messages: ReadonlyArray<GeminiRenderedMessage>, challengeId?: string) =>
        request("publish_gemini_snapshot", { target, messages,
          ...(challengeId === undefined ? {} : { challengeId }) }),
      markFixtureObservationGap: (target: FixtureTarget) => request("mark_fixture_observation_gap", { target }),
      markGeminiObservationGap: (target: GeminiTarget) => request("mark_gemini_observation_gap", { target }),
      revokeFixture: (tabId: number, observed: { documentId: string; conversationId: string } | null) =>
        request("revoke_fixture", { tabId, observed }),
      revokeAllFixtures: () => request("revoke_all_fixture", {}),
      close: () => { stopKeepAlive(); socket.destroy(); }
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}