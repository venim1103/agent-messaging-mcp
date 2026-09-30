import * as z from "zod/v4";
import { MAX_FIXTURE_SNAPSHOT_BYTES, MAX_FIXTURE_SNAPSHOT_MESSAGES,
  MAX_GEMINI_SNAPSHOT_BYTES, MAX_GEMINI_SNAPSHOT_MESSAGES } from "./pending-connections.js";

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

const fixtureReadChallengesSchema = z.strictObject({
  kind: z.literal("list_fixture_read_challenges"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({})
});

const geminiReadChallengesSchema = z.strictObject({
  kind: z.literal("list_gemini_read_challenges"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({})
});

export function parseNativeGeminiReadChallenges(message: unknown, now = Date.now()) {
  const result = geminiReadChallengesSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000) {
    throw new Error("Invalid native Gemini read challenge list");
  }
  return result.data;
}

export function parseNativeFixtureReadChallenges(message: unknown, now = Date.now()) {
  const result = fixtureReadChallengesSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000) {
    throw new Error("Invalid native fixture read challenge list");
  }
  return result.data;
}

const fixtureTargetSchema = z.strictObject({
  origin: z.literal("http://127.0.0.1:8787"), conversationId: z.literal("fixture-alpha"),
  tabId: z.number().int().safe().positive(), documentId: z.string().regex(/^[!-~]{1,128}$/)
});

const fixtureApprovalSchema = z.strictObject({
  kind: z.literal("approve_fixture"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({
    pendingRequestId: z.uuid(),
    target: fixtureTargetSchema
  })
});

const geminiTargetSchema = z.strictObject({
  origin: z.literal("https://gemini.google.com"),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  url: z.string().min(1).max(512),
  tabId: z.number().int().safe().positive(),
  documentId: z.string().regex(/^[!-~]{1,128}$/)
});

function isValidGeminiTarget(target: z.infer<typeof geminiTargetSchema>): boolean {
  try {
    const url = new URL(target.url);
    const route = url.pathname.split("/").filter(Boolean);
    return url.href === target.url && url.origin === target.origin && !url.username && !url.password
      && !url.hash && route.length === 2 && route[1] === target.conversationId
      && route.every((segment) => /^[A-Za-z0-9_-]{1,128}$/.test(segment));
  } catch {
    return false;
  }
}

const geminiApprovalSchema = z.strictObject({
  kind: z.literal("approve_gemini"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({
    pendingRequestId: z.uuid(),
    target: geminiTargetSchema
  })
});

export function parseNativeGeminiApproval(message: unknown, now = Date.now()) {
  const result = geminiApprovalSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000
    || !isValidGeminiTarget(result.data.payload.target)) {
    throw new Error("Invalid native Gemini approval");
  }
  return result.data;
}

const geminiGapSchema = z.strictObject({
  kind: z.literal("mark_gemini_observation_gap"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({ target: geminiTargetSchema })
});

export function parseNativeGeminiGap(message: unknown, now = Date.now()) {
  const result = geminiGapSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000
    || !isValidGeminiTarget(result.data.payload.target)) {
    throw new Error("Invalid native Gemini gap");
  }
  return result.data;
}

const geminiSnapshotSchema = z.strictObject({
  kind: z.literal("publish_gemini_snapshot"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({
    target: geminiTargetSchema,
    messages: z.array(z.strictObject({
      direction: z.enum(["incoming", "outgoing"]), text: z.string().min(1).max(2048)
    })).min(1).max(MAX_GEMINI_SNAPSHOT_MESSAGES),
    challengeId: z.uuid().optional()
  })
});

export function parseNativeGeminiSnapshot(message: unknown, now = Date.now()) {
  const result = geminiSnapshotSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000
    || !isValidGeminiTarget(result.data.payload.target)
    || Buffer.byteLength(JSON.stringify(result.data.payload.messages), "utf8") > MAX_GEMINI_SNAPSHOT_BYTES) {
    throw new Error("Invalid native Gemini snapshot");
  }
  return result.data;
}

const fixtureGapSchema = z.strictObject({
  kind: z.literal("mark_fixture_observation_gap"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({ target: fixtureTargetSchema })
});

export function parseNativeFixtureGap(message: unknown, now = Date.now()) {
  const result = fixtureGapSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000) {
    throw new Error("Invalid native fixture gap");
  }
  return result.data;
}

const fixtureSnapshotSchema = z.strictObject({
  kind: z.literal("publish_fixture_snapshot"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({
    target: fixtureTargetSchema,
    messages: z.array(z.strictObject({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      direction: z.enum(["incoming", "outgoing"]), text: z.string().max(2048)
    })).max(MAX_FIXTURE_SNAPSHOT_MESSAGES),
    challengeId: z.uuid().optional()
  })
});

export function parseNativeFixtureSnapshot(message: unknown, now = Date.now()) {
  const result = fixtureSnapshotSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000
    || Buffer.byteLength(JSON.stringify(result.data.payload.messages), "utf8") > MAX_FIXTURE_SNAPSHOT_BYTES
    || new Set(result.data.payload.messages.map((entry) => entry.id)).size !== result.data.payload.messages.length) {
    throw new Error("Invalid native fixture snapshot");
  }
  return result.data;
}

const fixtureRevocationSchema = z.strictObject({
  kind: z.literal("revoke_fixture"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({
    tabId: z.number().int().safe().positive(),
    observed: z.union([z.null(), z.strictObject({
      documentId: z.string().regex(/^[!-~]{1,128}$/), conversationId: z.string().min(1).max(128)
    })])
  })
});

const fixtureResetSchema = z.strictObject({
  kind: z.literal("revoke_all_fixture"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  payload: z.strictObject({})
});

export function parseNativeFixtureReset(message: unknown, now = Date.now()) {
  const result = fixtureResetSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000) {
    throw new Error("Invalid native fixture reset");
  }
  return result.data;
}

export function parseNativeFixtureRevocation(message: unknown, now = Date.now()) {
  const result = fixtureRevocationSchema.safeParse(message);
  if (!result.success || result.data.deadlineMs <= now || result.data.deadlineMs > now + 30_000) {
    throw new Error("Invalid native fixture revocation");
  }
  return result.data;
}

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