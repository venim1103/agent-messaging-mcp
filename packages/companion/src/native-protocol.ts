import * as z from "zod/v4";

export const NATIVE_HOST_NAME = "com.agent_messaging_mcp.bridge";
export const PROTOCOL_VERSION = 1;

const pendingListSchema = z.strictObject({
  kind: z.literal("list_pending"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({})
});

const fixtureApprovalSchema = z.strictObject({
  kind: z.literal("approve_fixture"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({
    pendingRequestId: z.uuid(),
    target: z.strictObject({
      origin: z.literal("http://127.0.0.1:8787"), conversationId: z.literal("fixture-alpha"),
      tabId: z.number().int().safe().positive(), documentId: z.uuid()
    })
  })
});

export function parseNativeFixtureApproval(message: unknown, now = Date.now()) {
  const result = fixtureApprovalSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000) {
    throw new Error("Invalid native fixture approval");
  }
  return result.data;
}

export function parseNativePendingList(message: unknown, now = Date.now()) {
  const result = pendingListSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000) {
    throw new Error("Invalid native pending list request");
  }
  return result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNativeCaller(expectedOrigin: string, callerOrigin: string): boolean {
  return /^chrome-extension:\/\/[a-p]{32}\/$/.test(expectedOrigin)
    && (callerOrigin === expectedOrigin || callerOrigin === expectedOrigin.slice(0, -1));
}

export function handleNativeHandshake(request: unknown, now = Date.now()) {
  if (!isRecord(request) || !isRecord(request.payload)
    || Object.keys(request).length !== 6 || Object.keys(request.payload).length !== 0
    || request.kind !== "handshake" || request.protocolVersion !== PROTOCOL_VERSION
    || request.connectionGeneration !== 0
    || typeof request.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.requestId)
    || typeof request.deadlineMs !== "number" || !Number.isSafeInteger(request.deadlineMs)
    || request.deadlineMs <= now || request.deadlineMs > now + 30_000) {
    throw new Error("Invalid native handshake");
  }

  return {
    kind: "handshake_result",
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    connectionGeneration: 0,
    deadlineMs: request.deadlineMs,
    payload: { protocolVersion: PROTOCOL_VERSION }
  };
}