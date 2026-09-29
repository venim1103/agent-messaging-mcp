import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import * as z from "zod/v4";
import type { BrokerRole } from "./broker-roles.js";
import type { FixtureMessage, FixtureTarget, GeminiRenderedMessage, GeminiTarget } from "./pending-connections.js";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { MAX_FIXTURE_EVENTS_PER_READ, MAX_FIXTURE_SNAPSHOT_MESSAGES, MAX_GEMINI_SNAPSHOT_MESSAGES,
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
    activeTabIds: z.array(z.number().int().safe().positive()).max(MAX_PENDING_REQUESTS) })
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
    kind: z.literal("fixture_gap_marked"), protocolVersion: z.literal(PROTOCOL_VERSION),
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
    kind: z.literal("error"), protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(), connectionGeneration: z.literal(0), deadlineMs: z.number().int().safe(),
    payload: z.strictObject({ code: z.enum(["PERMISSION_DENIED", "TOO_MANY_PENDING", "APPROVAL_INVALID",
      "OBSERVATION_UNAVAILABLE", "CONNECTION_NOT_FOUND"]) })
  })
]);

export async function connectBroker(role: BrokerRole, runtimeDirectory: string) {
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
    const decoder = new NativeFrameDecoder();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new Error("Broker authentication timed out")), 5000);
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
      deadlineMs: Date.now() + 5000, role, credential, payload: {}
    }));
    const reply = helloResult.parse(await response);
    if (reply.requestId !== requestId || reply.payload.role !== role
      || reply.deadlineMs <= Date.now() || reply.deadlineMs > Date.now() + 30_000) {
      throw new Error("Broker returned a mismatched hello");
    }
    let nextRequest: Promise<void> = Promise.resolve();
    const request = (kind: "request_connection" | "get_connection" | "read_fixture_snapshot" | "read_fixture_events"
      | "read_gemini_snapshot" | "read_approved_snapshot"
      | "disconnect_fixture"
      | "list_pending" | "list_fixture_read_challenges" | "list_gemini_read_challenges"
      | "approve_fixture" | "approve_gemini"
      | "publish_fixture_snapshot" | "publish_gemini_snapshot"
      | "revoke_fixture" | "revoke_all_fixture" | "mark_fixture_observation_gap", payload: object) => {
      if (kind === "list_pending" || kind === "list_fixture_read_challenges"
        || kind === "list_gemini_read_challenges"
        || kind === "approve_fixture" || kind === "approve_gemini" || kind === "revoke_fixture"
        || kind === "revoke_all_fixture" || kind === "publish_fixture_snapshot"
        || kind === "publish_gemini_snapshot"
        || kind === "mark_fixture_observation_gap"
        ? role !== "relay" : role !== "facade") {
        throw new Error("Broker role cannot perform this operation");
      }
      const operation = nextRequest.then(async () => {
        if (socket.destroyed) throw new Error("Broker connection closed");
        const requestId = randomUUID();
        const deadlineMs = Date.now() + 5000;
        const decoder = new NativeFrameDecoder();
        const response = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => socket.destroy(new Error("Broker request timed out")), 5000);
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
        socket.write(encodeNativeFrame({ kind, protocolVersion: PROTOCOL_VERSION, requestId,
          connectionGeneration: 0, deadlineMs, payload }));
        const reply = replySchema.parse(await response);
        if (reply.requestId !== requestId || reply.deadlineMs !== deadlineMs) throw new Error("Mismatched broker reply");
        return reply;
      });
      nextRequest = operation.then(() => {}, () => {});
      return operation;
    };
    return {
      role,
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
      disconnectFixture: (connectionId: string) => request("disconnect_fixture", { connectionId }),
      listPending: () => request("list_pending", {}),
      listFixtureReadChallenges: () => request("list_fixture_read_challenges", {}),
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
      revokeFixture: (tabId: number, observed: { documentId: string; conversationId: string } | null) =>
        request("revoke_fixture", { tabId, observed }),
      revokeAllFixtures: () => request("revoke_all_fixture", {}),
      close: () => socket.destroy()
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}