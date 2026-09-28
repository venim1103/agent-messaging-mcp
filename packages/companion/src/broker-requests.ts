import * as z from "zod/v4";
import type { BrokerRole } from "./broker-roles.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { PendingConnectionRequests } from "./pending-connections.js";

const envelope = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe()
};

const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, kind: z.literal("request_connection"), payload: z.strictObject({}) }),
  z.strictObject({ ...envelope, kind: z.literal("get_connection"), payload: z.strictObject({ requestId: z.uuid() }) }),
  z.strictObject({ ...envelope, kind: z.literal("list_pending"), payload: z.strictObject({}) }),
  z.strictObject({ ...envelope, kind: z.literal("approve_fixture"), payload: z.strictObject({
    pendingRequestId: z.uuid(),
    target: z.strictObject({
      origin: z.literal("http://127.0.0.1:8787"), conversationId: z.literal("fixture-alpha"),
      tabId: z.number().int().safe().positive(), documentId: z.string().regex(/^[!-~]{1,128}$/)
    })
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
  if (request.kind === "approve_fixture") {
    if (role !== "relay") return { ...response, kind: "error" as const, payload: { code: "PERMISSION_DENIED" } };
    const grant = requests.approve(request.payload.pendingRequestId, request.payload.target, now);
    return grant
      ? { ...response, kind: "fixture_approved" as const, payload: { requestId: grant.requestId, expiresAt: grant.expiresAt } }
      : { ...response, kind: "error" as const, payload: { code: "APPROVAL_INVALID" } };
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