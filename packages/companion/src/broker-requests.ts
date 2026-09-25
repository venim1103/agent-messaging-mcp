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
  z.strictObject({ ...envelope, kind: z.literal("get_connection"), payload: z.strictObject({ requestId: z.uuid() }) })
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