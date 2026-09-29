import * as z from "zod/v4";
import type { BrokerRole } from "./broker-roles.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { MAX_FIXTURE_EVENTS_PER_READ, MAX_FIXTURE_SNAPSHOT_MESSAGES, MAX_GEMINI_SNAPSHOT_MESSAGES,
  PendingConnectionRequests }
  from "./pending-connections.js";

const envelope = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe()
};
const fixtureTarget = z.strictObject({
  origin: z.literal("http://127.0.0.1:8787"), conversationId: z.literal("fixture-alpha"),
  tabId: z.number().int().safe().positive(), documentId: z.string().regex(/^[!-~]{1,128}$/)
});
const geminiTarget = z.strictObject({
  origin: z.literal("https://gemini.google.com"),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  url: z.string().min(1).max(512),
  tabId: z.number().int().safe().positive(), documentId: z.string().regex(/^[!-~]{1,128}$/)
});
const fixtureMessage = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  direction: z.enum(["incoming", "outgoing"]), text: z.string().max(2048)
});
const geminiMessage = z.strictObject({
  direction: z.enum(["incoming", "outgoing"]), text: z.string().min(1).max(2048)
});

const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, kind: z.literal("request_connection"), payload: z.strictObject({}) }),
  z.strictObject({ ...envelope, kind: z.literal("get_connection"), payload: z.strictObject({ requestId: z.uuid() }) }),
  z.strictObject({ ...envelope, kind: z.literal("read_fixture_snapshot"), payload: z.strictObject({
    connectionId: z.uuid(), limit: z.number().int().min(1).max(MAX_FIXTURE_SNAPSHOT_MESSAGES).optional()
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("read_gemini_snapshot"), payload: z.strictObject({
    connectionId: z.uuid(), limit: z.number().int().min(1).max(MAX_GEMINI_SNAPSHOT_MESSAGES).optional()
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("read_fixture_events"), payload: z.strictObject({
    connectionId: z.uuid(), cursor: z.strictObject({
      epoch: z.uuid(), sequence: z.number().int().safe().nonnegative()
    }), limit: z.number().int().min(1).max(MAX_FIXTURE_EVENTS_PER_READ).optional()
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("disconnect_fixture"), payload: z.strictObject({
    connectionId: z.uuid()
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("list_fixture_read_challenges"), payload: z.strictObject({}) }),
  z.strictObject({ ...envelope, kind: z.literal("list_gemini_read_challenges"), payload: z.strictObject({}) }),
  z.strictObject({ ...envelope, kind: z.literal("list_pending"), payload: z.strictObject({}) }),
  z.strictObject({ ...envelope, kind: z.literal("approve_fixture"), payload: z.strictObject({
    pendingRequestId: z.uuid(),
    target: fixtureTarget
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("approve_gemini"), payload: z.strictObject({
    pendingRequestId: z.uuid(), target: geminiTarget
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("publish_fixture_snapshot"), payload: z.strictObject({
    target: fixtureTarget, messages: z.array(fixtureMessage).max(MAX_FIXTURE_SNAPSHOT_MESSAGES),
    challengeId: z.uuid().optional()
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("publish_gemini_snapshot"), payload: z.strictObject({
    target: geminiTarget, messages: z.array(geminiMessage).min(1).max(MAX_GEMINI_SNAPSHOT_MESSAGES),
    challengeId: z.uuid().optional()
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("mark_fixture_observation_gap"), payload: z.strictObject({
    target: fixtureTarget
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("revoke_fixture"), payload: z.strictObject({
    tabId: z.number().int().safe().positive(),
    observed: z.union([z.null(), z.strictObject({
      documentId: z.string().regex(/^[!-~]{1,128}$/), conversationId: z.string().min(1).max(128)
    })])
  }) }),
  z.strictObject({ ...envelope, kind: z.literal("revoke_all_fixture"), payload: z.strictObject({}) })
]);

export function handleBrokerRequest(message: unknown, role: BrokerRole, owner: symbol,
  requests: PendingConnectionRequests, now = Date.now()) {
  const request = requestSchema.parse(message);
  if (request.deadlineMs <= now || request.deadlineMs > now + 30_000) throw new Error("Invalid broker deadline");
  const response = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    connectionGeneration: 0,
    deadlineMs: request.deadlineMs
  };
  if (request.kind === "list_pending") {
    return role === "relay"
      ? { ...response, kind: "pending_list" as const, payload: { requests: requests.listPending(now) } }
      : { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
  }
  if (request.kind === "list_fixture_read_challenges") {
    return role === "relay"
      ? { ...response, kind: "fixture_read_challenges" as const,
        payload: { challenges: requests.listFixtureReadChallenges(now),
          activeTabIds: requests.listActiveFixtureTabIds(now) } }
      : { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
  }
  if (request.kind === "list_gemini_read_challenges") {
    return role === "relay"
      ? { ...response, kind: "gemini_read_challenges" as const,
        payload: { challenges: requests.listGeminiReadChallenges(now) } }
      : { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
  }
  if (request.kind === "approve_fixture") {
    if (role !== "relay") return { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
    const grant = requests.approve(request.payload.pendingRequestId, request.payload.target, now);
    return grant
      ? { ...response, kind: "fixture_approved" as const, payload: { requestId: grant.requestId, expiresAt: grant.expiresAt } }
      : { ...response, kind: "error" as const, payload: { code: "APPROVAL_INVALID" } };
  }
  if (request.kind === "approve_gemini") {
    if (role !== "relay") return { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
    const grant = requests.approveGemini(request.payload.pendingRequestId, request.payload.target, now);
    return grant
      ? { ...response, kind: "gemini_approved" as const,
        payload: { requestId: grant.requestId, expiresAt: grant.expiresAt } }
      : { ...response, kind: "error" as const, payload: { code: "APPROVAL_INVALID" } };
  }
  if (request.kind === "publish_fixture_snapshot") {
    return role === "relay"
      ? { ...response, kind: "fixture_snapshot_published" as const,
        payload: { count: requests.publishFixtureSnapshot(request.payload.target, request.payload.messages,
          now, request.payload.challengeId) } }
      : { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
  }
  if (request.kind === "publish_gemini_snapshot") {
    return role === "relay"
      ? { ...response, kind: "gemini_snapshot_published" as const,
        payload: { count: requests.publishGeminiSnapshot(request.payload.target, request.payload.messages,
          now, request.payload.challengeId) } }
      : { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
  }
  if (request.kind === "mark_fixture_observation_gap") {
    return role === "relay"
      ? { ...response, kind: "fixture_gap_marked" as const,
        payload: { count: requests.markFixtureObservationGap(request.payload.target, now) } }
      : { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
  }
  if (request.kind === "revoke_fixture") {
    return role === "relay"
      ? { ...response, kind: "fixture_revoked" as const,
        payload: { count: requests.revokeChangedTab(request.payload.tabId, request.payload.observed) } }
      : { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
  }
  if (request.kind === "revoke_all_fixture") {
    return role === "relay"
      ? { ...response, kind: "fixture_revoked" as const, payload: { count: requests.revokeAllFixtures() } }
      : { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
  }
  if (role !== "facade") {
    return { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
  }
  if (request.kind === "read_fixture_snapshot") {
    return requests.getApprovedTarget(owner, request.payload.connectionId, now)
      ? { ...response, kind: "fixture_read_authorized" as const, payload: {
        connectionId: request.payload.connectionId, limit: request.payload.limit ?? MAX_FIXTURE_SNAPSHOT_MESSAGES
      } }
      : { ...response, kind: "error" as const, payload: { code: "CONNECTION_NOT_FOUND" } };
  }
  if (request.kind === "read_gemini_snapshot") {
    return requests.getGeminiTarget(owner, request.payload.connectionId, now)
      ? { ...response, kind: "gemini_read_authorized" as const, payload: {
        connectionId: request.payload.connectionId, limit: request.payload.limit ?? MAX_GEMINI_SNAPSHOT_MESSAGES
      } }
      : { ...response, kind: "error" as const, payload: { code: "CONNECTION_NOT_FOUND" } };
  }
  if (request.kind === "read_fixture_events") {
    const events = requests.readFixtureEvents(owner, request.payload.connectionId,
      request.payload.cursor, request.payload.limit ?? MAX_FIXTURE_EVENTS_PER_READ, now);
    return events && events !== "not_ready"
      ? { ...response, kind: "fixture_events" as const, payload: events }
      : { ...response, kind: "error" as const,
        payload: { code: events === "not_ready" ? "OBSERVATION_UNAVAILABLE" : "CONNECTION_NOT_FOUND" } };
  }
  if (request.kind === "disconnect_fixture") {
    return { ...response, kind: "fixture_disconnected" as const,
      payload: { disconnected: requests.disconnectFixture(owner, request.payload.connectionId, now) } };
  }
  if (request.kind === "request_connection") {
    try {
      return { ...response, kind: "connection_requested" as const, payload: requests.create(owner, now) };
    } catch {
      return { ...response, kind: "error" as const, payload: { code: "TOO_MANY_PENDING" } };
    }
  }
  return {
    ...response,
    kind: "connection_state" as const,
    payload: requests.get(owner, request.payload.requestId, now) ?? { state: "unknown" }
  };
}