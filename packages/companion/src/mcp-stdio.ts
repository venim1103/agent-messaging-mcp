import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as waitForBroker } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { connectBroker } from "./broker-client.js";
import { IncomingTaskStore } from "./incoming-task-store.js";
import { fixtureDispatchStatusSchema, MAX_PREPARED_MESSAGE_BYTES } from "./message-operations.js";
import { ReplyObservation } from "./pending-connections.js";

const taskStore = new IncomingTaskStore();
const server = new McpServer({ name: "browser-chat-feasibility", version: "0.0.1" }, {
  taskStore, capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }
});
const incomingWaiters = new Set<string>();
const runtimeDirectory = join(homedir(), ".config/agent-messaging-mcp/broker");
let broker: Awaited<ReturnType<typeof connectBroker>> | undefined;
let connectingBroker: ReturnType<typeof connectBroker> | undefined;
let facadeClosed = false;
let brokerStartAttempted = false;

async function connectFacadeBroker() {
  const deadlineMs = Date.now() + 5000;
  const reportedLabel = server.server.getClientVersion()?.name.replace(/[^ -~]/g, "?").slice(0, 80).trim();
  const agentLabel = process.env.BROWSER_CHAT_AGENT_LABEL ?? (reportedLabel || "MCP agent");
  try {
    return await connectBroker("facade", runtimeDirectory, undefined, deadlineMs, agentLabel);
  } catch (error) {
    if (facadeClosed || brokerStartAttempted || process.env.BROWSER_CHAT_AUTO_START_BROKER === "0"
      || !(error instanceof Error && "code" in error
        && (error.code === "ENOENT" || error.code === "ECONNREFUSED"))) throw error;
  }
  brokerStartAttempted = true;
  let spawnFailed = false;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./broker-process.js", import.meta.url))],
    { detached: true, stdio: "ignore" });
  child.once("error", () => { spawnFailed = true; });
  child.unref();
  while (!facadeClosed && !spawnFailed && Date.now() < deadlineMs) {
    try {
      const socket = await stat(join(runtimeDirectory, "broker.sock"));
      if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0) {
        throw new Error("Broker socket has unsafe ownership or permissions");
      }
      return await connectBroker("facade", runtimeDirectory, undefined, deadlineMs, agentLabel);
    } catch (error) {
      if (!(error instanceof Error && "code" in error
        && (error.code === "ENOENT" || error.code === "ECONNREFUSED"))) throw error;
    }
    const remaining = deadlineMs - Date.now();
    if (remaining > 0) await waitForBroker(Math.min(25, remaining));
  }
  throw new Error("Broker startup unavailable");
}

function closeFacadeBroker() {
  facadeClosed = true;
  taskStore.cleanup();
  broker?.close();
  broker = undefined;
  void connectingBroker?.then((client) => client.close(), () => {});
}

process.stdin.once("end", closeFacadeBroker);
process.stdin.once("close", closeFacadeBroker);

async function pendingBroker() {
  if (facadeClosed) throw new Error("MCP stdio is closed");
  if (broker?.closed) broker = undefined;
  if (broker) return broker;
  const connection = connectingBroker ??= connectFacadeBroker();
  try {
    const connected = await connection;
    if (facadeClosed) {
      connected.close();
      throw new Error("MCP stdio is closed");
    }
    return broker ??= connected;
  } finally {
    if (connectingBroker === connection) connectingBroker = undefined;
  }
}

function unavailable() {
  broker?.close();
  broker = undefined;
  return { isError: true, content: [{ type: "text" as const, text: "BROKER_UNAVAILABLE: Check private broker startup; no chat was accessed." }] };
}

function blocked(code: string) {
  return { isError: true, content: [{ type: "text" as const, text: `${code}: No chat was accessed.` }] };
}

function fillFailure(operationId: string, code: string) {
  const payload = { operationId, ok: false, code, retryAllowed: false };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function commitFailure(operationId: string, code: "DISPATCH_UNAVAILABLE" | "DISPATCH_UNCERTAIN") {
  const payload = { operationId, ok: false, code, retryAllowed: false,
    ...(code === "DISPATCH_UNCERTAIN" ? { state: "dispatch_uncertain" } : {}) };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function sendResult(state: "sent" | "not_sent" | "unresolved", code: string, metadata: Record<string, unknown> = {}) {
  const payload = { ...metadata, state, code, retryAllowed: false };
  return { isError: state !== "sent", content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function sendStatus(status: z.infer<typeof fixtureDispatchStatusSchema>, recoveryToken?: string) {
  const state = status.state === "observed_in_ui" ? "sent"
    : status.state === "resolved" ? status.resolution.outcome : "unresolved";
  const code = status.state === "resolved" ? `${status.resolution.source === "page" ? "PAGE" : "PERSON"}_${state.toUpperCase()}`
    : state === "sent" ? "OBSERVED_IN_UI" : "DISPATCH_UNCERTAIN";
  return sendResult(state, code, { ...status, ...(recoveryToken ? { recoveryToken } : {}) });
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    signal.addEventListener("abort", finish, { once: true });
    const timer = setTimeout(finish, milliseconds);
    if (signal.aborted) finish();
  });
}

server.registerTool("browser_chat_feasibility", {
  description: "Check MCP stdio compatibility without accessing any browser tab or conversation.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true }
}, async () => ({
  content: [{ type: "text", text: "MCP stdio diagnostic OK. No browser data was read or sent." }]
}));

server.registerTool("chat_request_connection", {
  description: "Request a pending browser-chat connection. No tab is read until separate browser-side approval.",
  inputSchema: z.object({}).strict()
}, async () => {
  try {
    const result = await (await pendingBroker()).requestConnection();
    if (result.kind === "error") return blocked(result.payload.code);
    if (result.kind !== "connection_requested") return unavailable();
    return { content: [{ type: "text", text: JSON.stringify(result.payload) }], structuredContent: result.payload };
  } catch {
    return unavailable();
  }
});

server.registerTool("chat_get_connection", {
  description: "Check an owned pending request; an unapproved request never contains messages or a connection handle.",
  inputSchema: z.object({ requestId: z.uuid() }).strict(),
  annotations: { readOnlyHint: true }
}, async ({ requestId }) => {
  try {
    const result = await (await pendingBroker()).getConnection(requestId);
    if (result.kind === "error") return blocked(result.payload.code);
    if (result.kind !== "connection_state") return unavailable();
    return { content: [{ type: "text", text: JSON.stringify(result.payload) }], structuredContent: result.payload };
  } catch {
    return unavailable();
  }
});

server.registerTool("chat_wait_for_connection", {
  description: "Wait up to 20 seconds for autonomous connections approved for this MCP agent in the trusted popup. This never creates or widens approval and never returns another agent's connections.",
  inputSchema: z.object({ timeoutMs: z.number().int().min(0).max(20_000).optional() }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true }
}, async ({ timeoutMs }, extra) => {
  const cancel = () => { broker?.close(); };
  extra.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (extra.signal.aborted) return blocked("CANCELLED");
    const client = await pendingBroker();
    if (extra.signal.aborted) { client.close(); return blocked("CANCELLED"); }
    const result = await client.waitForConnection(timeoutMs);
    if (extra.signal.aborted) return blocked("CANCELLED");
    if (result.kind === "error") return blocked(result.payload.code);
    if (result.kind !== "connection_pickup") return unavailable();
    return { content: [{ type: "text", text: JSON.stringify(result.payload) }], structuredContent: result.payload };
  } catch {
    return extra.signal.aborted ? blocked("CANCELLED") : unavailable();
  } finally {
    extra.signal.removeEventListener("abort", cancel);
  }
});

server.registerTool("chat_read_messages", {
  description: "Read a fresh rendered-only snapshot from an owned, toolbar-approved fixture, Gemini, configured Databag or Company AI chat after an exact-document browser challenge. Results contain the selected chat's supported visible message text, not complete history. Company AI has uncertain row identity, conservative sender hints and unknown completion. Databag supports plain text only.",
  inputSchema: z.object({ connectionId: z.uuid(), limit: z.number().int().min(1).max(32).optional() }).strict(),
  annotations: { readOnlyHint: true }
}, async ({ connectionId, limit }) => {
  try {
    const result = await (await pendingBroker()).readApprovedSnapshot(connectionId, limit);
    if (result.kind === "error") return blocked(result.payload.code);
    if (result.kind !== "fixture_snapshot" && result.kind !== "gemini_snapshot") return unavailable();
    return { content: [{ type: "text", text: JSON.stringify(result.payload) }], structuredContent: result.payload };
  } catch {
    return unavailable();
  }
});

const eventWaitSchema = z.object({
  connectionId: z.uuid(),
  cursor: z.object({ epoch: z.uuid(), sequence: z.number().int().safe().nonnegative() }).strict(),
  timeoutMs: z.number().int().min(0).max(20_000).optional(),
  limit: z.number().int().min(1).max(2).optional(),
  view: z.enum(["snapshots", "incoming_changes"]).optional()
}).strict();
const answerWaitSchema = eventWaitSchema.omit({ view: true, cursor: true }).extend({
  operationId: z.uuid(), cursor: eventWaitSchema.shape.cursor.optional()
});

async function runEventWait(args: z.infer<typeof eventWaitSchema> | z.infer<typeof answerWaitSchema>,
  signal: AbortSignal, pending: boolean) {
  const deadline = Date.now() + (args.timeoutMs ?? 20_000);
  const failure = (code: string) => "operationId" in args
    ? { ...blocked(code), structuredContent: { code } } : blocked(code);
  try {
    if (signal.aborted) return failure("CANCELLED");
    const client = await pendingBroker();
    let eventArgs: z.infer<typeof eventWaitSchema>;
    if ("operationId" in args) {
      const status = await client.getPreparedOperation(args.operationId, undefined, true);
      if (signal.aborted) return failure("CANCELLED");
      if (status.kind === "error") return failure(status.payload.code);
      if (status.kind !== "prepared_operation_state") return unavailable();
      const sent = status.payload.state === "observed_in_ui"
        || (status.payload.state === "resolved" && status.payload.resolution.outcome === "sent");
      if (!sent) return failure("QUESTION_NOT_SENT");
      if (!("answerWaitAnchor" in status.payload) || !status.payload.answerWaitAnchor
        || status.payload.answerWaitAnchor.connectionId !== args.connectionId) return failure("ANSWER_ANCHOR_UNAVAILABLE");
      const anchor = status.payload.answerWaitAnchor;
      if (args.cursor && (args.cursor.epoch !== anchor.cursor.epoch
        || args.cursor.sequence < anchor.cursor.sequence)) return failure("INVALID_ANSWER_CURSOR");
      eventArgs = { ...args, cursor: args.cursor ?? anchor.cursor, view: "incoming_changes" };
    } else eventArgs = args;
    if (!pending || eventArgs.view !== "incoming_changes" || eventArgs.timeoutMs === 0) {
      return waitForEvents(eventArgs, signal, client, deadline);
    }
    let cursor = eventArgs.cursor;
    while (!signal.aborted) {
      const result = await waitForEvents({ ...eventArgs, cursor }, signal, client);
      if (result.isError || !("structuredContent" in result) || !("timedOut" in result.structuredContent)
        || !result.structuredContent.timedOut) return result;
      cursor = result.structuredContent.cursor;
      await waitForPoll(200, signal);
    }
    return failure("CANCELLED");
  } catch {
    return failure(signal.aborted ? "CANCELLED" : "BROKER_UNAVAILABLE");
  }
}

async function waitForEvents({ connectionId, cursor, timeoutMs, limit, view }: z.infer<typeof eventWaitSchema>,
  signal: AbortSignal, client?: Awaited<ReturnType<typeof connectBroker>>, deadline = Date.now() + (timeoutMs ?? 20_000)) {
  let currentCursor = cursor;
  try {
    while (true) {
      if (signal.aborted) return blocked("CANCELLED");
      const result = await (client ?? await pendingBroker()).readApprovedEvents(connectionId, currentCursor, limit, view);
      if (signal.aborted) return blocked("CANCELLED");
      if (result.kind === "error" && result.payload.code === "VIEW_UNSUPPORTED") return {
        isError: true,
        content: [{ type: "text" as const, text: "VIEW_UNSUPPORTED: incoming_changes requires stable row IDs. Use snapshots for this connection." }],
        structuredContent: { code: "VIEW_UNSUPPORTED" }
      };
      if (result.kind === "error") return blocked(result.payload.code);
      if (result.kind !== "fixture_events" && result.kind !== "gemini_events") return unavailable();
      if (result.payload.state === "expired") return {
        isError: true,
        content: [{ type: "text" as const, text: "CURSOR_EXPIRED: Call chat_read_messages for a new snapshot." }],
        structuredContent: { code: "CURSOR_EXPIRED", resnapshot: true }
      };
      if (view === "incoming_changes" && (result.kind !== "fixture_events"
        || result.payload.events.some(event => event.payload.kind !== "incoming_changes"))) return unavailable();
      currentCursor = result.payload.cursor;
      const timedOut = result.payload.events.length === 0 && Date.now() >= deadline;
      if (result.payload.events.length || timedOut) {
        const payload = { ...result.payload, timedOut };
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
      }
      await waitForPoll(Math.min(200, deadline - Date.now()), signal);
    }
  } catch {
    return signal.aborted ? blocked("CANCELLED") : client ? blocked("BROKER_UNAVAILABLE") : unavailable();
  }
}

server.registerTool("chat_check_for_messages", {
  description: "Check once for extra rendered information after an owned cursor; never wait for an answer or create a pending task. Defaults to compact incoming_changes for fixture/Databag stable rows; use snapshots explicitly for Gemini. Advance past outgoing-only frames without returning their text in compact mode. Interpret new rows and revisions; cursor gaps require a fresh snapshot. This check is independent of any pending answer wait and grants no send authority.",
  inputSchema: eventWaitSchema.omit({ timeoutMs: true }),
  annotations: { readOnlyHint: true }
}, async (args, extra) => waitForEvents({ ...args, view: args.view ?? "incoming_changes", timeoutMs: 0 }, extra.signal));

function registerEventWait(name: string, inputSchema: typeof eventWaitSchema | typeof answerWaitSchema, description: string) {
  server.experimental.tasks.registerToolTask(name, {
    description,
    inputSchema,
    execution: { taskSupport: "optional" },
    annotations: { readOnlyHint: true }
  }, {
    async createTask(rawArguments, extra) {
      const args = inputSchema.parse(rawArguments);
      const incoming = "operationId" in args || args.view === "incoming_changes";
      const task = await extra.taskStore.createTask({ ttl: null, pollInterval: 1000 });
      if (!taskStore.isAugmented(task.taskId)) {
        const reserved = incoming && !incomingWaiters.has(args.connectionId);
        if (reserved) incomingWaiters.add(args.connectionId);
        try {
          const result = incoming && !reserved ? blocked("INCOMING_WAIT_ACTIVE") : await runEventWait(args, extra.signal, false);
          await extra.taskStore.storeTaskResult(task.taskId, "completed", result);
          return { task: await extra.taskStore.getTask(task.taskId) };
        } finally {
          if (reserved) incomingWaiters.delete(args.connectionId);
        }
      }
      const reserved = incoming && !incomingWaiters.has(args.connectionId);
      if (reserved) incomingWaiters.add(args.connectionId);
      const run = async () => {
        try {
          if (incoming && !reserved) return blocked("INCOMING_WAIT_ACTIVE");
          const signal = taskStore.signal(task.taskId);
          return await runEventWait(args, signal, true);
        } finally {
          if (reserved) incomingWaiters.delete(args.connectionId);
        }
      };
      void run().then(async result => {
        if ((await taskStore.getTask(task.taskId))?.status === "working") {
          await taskStore.storeTaskResult(task.taskId, "completed", result);
        }
      }).catch(async () => {
        if ((await taskStore.getTask(task.taskId))?.status === "working") {
          await taskStore.storeTaskResult(task.taskId, "completed", blocked("BROKER_UNAVAILABLE"));
        }
      });
      return { task };
    },
    async getTask(_arguments, extra) { return extra.taskStore.getTask(extra.taskId); },
    async getTaskResult(_arguments, extra) { return CallToolResultSchema.parse(await extra.taskStore.getTaskResult(extra.taskId)); }
  });
}

registerEventWait("chat_wait_for_events", eventWaitSchema,
  "Low-level compatibility event reader; use chat_check_for_messages for extras and chat_wait_for_answer after a confirmed question send. Ordinary calls wait up to 20 seconds, defaulting to snapshots; zero timeout is nonwaiting even in task mode. Task incoming_changes stays pending across bounded reads until an event, cancellation or original-connection loss. One incoming waiter per connection; 16 retained tasks, terminal retention five minutes, memory-only state. Compact fixture/Databag reads return ordered new rows and marked revisions, skip outgoing text and advance the cursor. Gaps require explicit resnapshot; Gemini supports snapshots only. No idle-turn wake-up, reconnect, approval renewal or delivery guarantee.");
registerEventWait("chat_wait_for_answer", answerWaitSchema,
  "Wait for incoming candidates only after the latest actual confirmed sent operation in this owned fixture/Databag connection. operationId names the sent question, not a prepared or uncertain send. The default cursor is its retained pre-send baseline, catching fast replies before wait registration; an explicit continuation cursor must not precede it or cross epochs. Ordinary calls are bounded to 20 seconds; task calls stay pending across bounded reads. Zero timeout always checks once. Shares incoming-wait exclusivity, the 16-task cap, five-minute terminal retention and cancellation/owner/gap guards. New rows require interpretation; revisions or omission metadata are not answer/finish permission. No transcript persistence, reconnect, new send authority, model concurrency or ended-turn wake-up guarantee.");

server.registerTool("chat_wait_for_reply", {
  description: "Wait up to 20 seconds for the newest rendered incoming fixture, Gemini, configured Databag or Company AI reply under fresh exact-document observations. A reviewed Gemini UI signal may yield complete; otherwise two seconds of unchanged captures yield settled_heuristic. Databag and Company AI use that heuristic, not a completion signal. Positive streaming blocks settling. Neither result proves provider acceptance or delivery. An existing newest reply may qualify; an outgoing or truncated newest row cannot. Timeout returns no reply. Only a live owned connection permits reads; cancellation ends the owning broker connection.",
  inputSchema: z.object({ connectionId: z.uuid(), timeoutMs: z.number().int().min(0).max(20_000).optional() }).strict(),
  annotations: { readOnlyHint: true }
}, async ({ connectionId, timeoutMs }, extra) => {
  const budgetMs = timeoutMs ?? 20_000;
  const startedAt = performance.now();
  const deadlineMs = Date.now() + budgetMs;
  const remaining = () => Math.min(deadlineMs - Date.now(), budgetMs - (performance.now() - startedAt));
  const output = (payload: Record<string, unknown>, isError = false) => ({
    ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload
  });
  const timedOut = () => output({ timedOut: true });
  const bounded = async <Value>(pending: Promise<Value>): Promise<Value | null> => {
    const finished = new AbortController();
    try {
      return await Promise.race([pending, waitForPoll(Math.max(0, remaining()),
        AbortSignal.any([extra.signal, finished.signal])).then(() => null)]);
    } finally { finished.abort(); }
  };
  let client: Awaited<ReturnType<typeof connectBroker>> | null = null;
  const cancel = () => client?.close();
  extra.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (extra.signal.aborted) return output({ code: "CANCELLED" }, true);
    if (remaining() <= 0) return timedOut();
    client = await bounded(pendingBroker());
    if (extra.signal.aborted) { cancel(); return output({ code: "CANCELLED" }, true); }
    if (!client || remaining() <= 25) return timedOut();
    let observation = new ReplyObservation();
    while (remaining() > 25) {
      const readDeadline = Math.min(deadlineMs, Date.now() + Math.min(5000, Math.ceil(remaining())));
      const read = await bounded(client.readApprovedSnapshot(connectionId, 32, readDeadline));
      if (extra.signal.aborted) return output({ code: "CANCELLED" }, true);
      if (!read || remaining() <= 0) return timedOut();
      if (read.kind === "error") {
        if (read.payload.code === "OBSERVATION_UNAVAILABLE") {
          observation = new ReplyObservation();
          await waitForPoll(Math.min(500, Math.max(0, remaining())), extra.signal);
          continue;
        }
        return output({ code: read.payload.code }, true);
      }
      if (read.kind !== "fixture_snapshot" && read.kind !== "gemini_snapshot") throw new Error("Unexpected reply observation");
      const reply = observation.observe(read.payload);
      if (reply) {
        const { coverage, generation, capturedAt, cursor, omittedBefore } = read.payload;
        return output({ timedOut: false, coverage, generation, capturedAt, cursor, omittedBefore, reply });
      }
      await waitForPoll(Math.min(500, Math.max(0, remaining())), extra.signal);
    }
    return timedOut();
  } catch (error) {
    if (extra.signal.aborted) return output({ code: "CANCELLED" }, true);
    if (remaining() <= 0 || (remaining() <= 25 && error instanceof Error
      && error.message === "Invalid autonomous request deadline")) return timedOut();
    client?.close();
    if (broker === client) broker = undefined;
    return output({ code: "BROKER_UNAVAILABLE" }, true);
  } finally {
    extra.signal.removeEventListener("abort", cancel);
  }
});

server.registerTool("chat_send_message", {
  description: "Send once in an owned autonomous fixture, Gemini, configured Databag or Company AI chat with explicit read/send approval for this agent through Connect this chat. Databag requires its reviewed DOM contract and a plain-text, attachment-free composer. Company AI requires a visible, empty native textarea and unambiguous Send control; only qualified retained-window outgoing evidence confirms page-sent, otherwise trusted outcome review is required. One original deadline spans preparation, fill, fresh proof, durable intent, one activation and bounded evidence. Returns sent, not_sent or unresolved, always retryAllowed false; sent is a page or person assessment, not provider acceptance or delivery. The same key and arguments return existing status without another submission. Never automatically resend an unresolved result or clear a person's draft. Recovery tokens permit status only."
    + " A composer refusal with failureReason unconfirmed_send requires the person to review Unconfirmed Sends in the trusted popup and record the actual outcome; never retry the blocked operation.",
  inputSchema: z.object({ connectionId: z.uuid(), text: z.string().min(1).max(MAX_PREPARED_MESSAGE_BYTES),
    idempotencyKey: z.uuid() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
}, async ({ connectionId, text, idempotencyKey }, extra) => {
  const deadlineMs = Date.now() + 30_000;
  let client: Awaited<ReturnType<typeof connectBroker>> | undefined;
  let prepared: { operationId: string; expiresAt: number; recoveryToken: string } | undefined;
  const cancel = () => client?.close();
  extra.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (extra.signal.aborted) return sendResult("not_sent", "CANCELLED");
    client = await pendingBroker();
    if (extra.signal.aborted) { cancel(); return sendResult("not_sent", "CANCELLED"); }
    const preparation = await client.prepareChatMessage(connectionId, text, idempotencyKey, deadlineMs);
    if (preparation.kind === "error") return sendResult(preparation.payload.code === "DISPATCH_UNCERTAIN" ? "unresolved" : "not_sent",
      preparation.payload.code);
    if (preparation.kind === "chat_dispatch") return sendStatus(preparation.payload);
    if (preparation.kind !== "chat_message_prepared") throw new Error("Unexpected autonomous preparation reply");
    const { operationId, expiresAt, recoveryToken } = preparation.payload;
    prepared = { operationId, expiresAt, recoveryToken };
    if (extra.signal.aborted || expiresAt <= Date.now()) return sendResult("not_sent",
      extra.signal.aborted ? "CANCELLED" : "OPERATION_EXPIRED", { operationId, recoveryToken });
    const result = await client.commitPreparedMessage(operationId, Math.min(deadlineMs, expiresAt));
    if (result.kind === "error") return sendResult(result.payload.code === "DISPATCH_UNAVAILABLE" ? "not_sent" : "unresolved",
      result.payload.code, { operationId, recoveryToken,
        ...(result.payload.failureStage ? { failureStage: result.payload.failureStage } : {}),
        ...(result.payload.failureReason ? { failureReason: result.payload.failureReason } : {}) });
    if (result.kind !== "chat_dispatch") throw new Error("Unexpected autonomous commit reply");
    return sendStatus(result.payload, recoveryToken);
  } catch {
    client?.close();
    if (broker === client) broker = undefined;
    return sendResult("unresolved", "DISPATCH_UNCERTAIN",
      prepared ? { operationId: prepared.operationId, recoveryToken: prepared.recoveryToken } : {});
  } finally {
    extra.signal.removeEventListener("abort", cancel);
  }
});

server.registerTool("chat_prepare_message", {
  description: "Prepare an immutable fixture-only preview and private status-recovery token for an owned connection. The fixture draft expires after 3 minutes. This cannot approve, fill, or send; Gemini and Databag supervised preparation are unavailable.",
  inputSchema: z.object({ connectionId: z.uuid(), expectedGeneration: z.literal(1),
    text: z.string().min(1).max(MAX_PREPARED_MESSAGE_BYTES), idempotencyKey: z.uuid() }).strict()
}, async ({ connectionId, expectedGeneration, text, idempotencyKey }) => {
  try {
    const result = await (await pendingBroker()).prepareFixtureMessage(connectionId, expectedGeneration,
      text, idempotencyKey);
    if (result.kind === "error") return blocked(result.payload.code);
    if (result.kind !== "message_prepared") return unavailable();
    return { content: [{ type: "text", text: JSON.stringify(result.payload) }], structuredContent: result.payload };
  } catch {
    return unavailable();
  }
});

server.registerTool("chat_fill_draft", {
  description: "Fill the owned local fixture's empty editor once with immutable prepared text, never submit. Requires separate trusted popup Allow draft fill (no send) consent, not ordinary no-send review. Gemini and Databag are unavailable through this supervised tool. Do not automatically retry any result; FILL_UNCERTAIN may mean the draft was edited. Success is exact readback at that time, not current draft state or delivery.",
  inputSchema: z.object({ operationId: z.uuid() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}, async ({ operationId }) => {
  try {
    const result = await (await pendingBroker()).fillFixtureDraft(operationId);
    if (result.kind === "error") return fillFailure(operationId, result.payload.code);
    if (result.kind !== "fixture_fill") throw new Error("Unexpected fixture fill reply");
    const payload = { ...result.payload, retryAllowed: false };
    return { isError: !payload.ok, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  } catch {
    broker?.close();
    broker = undefined;
    return fillFailure(operationId, "FILL_UNCERTAIN");
  }
});

server.registerTool("chat_commit_message", {
  description: "Submit an owned local fixture operation once after completed fill and distinct trusted popup Approve fixture send consent. Obtains a fresh exact-document baseline and current-draft proof before durable intent and one guarded activation. Gemini and Databag are unavailable through this supervised tool. Never automatically retry; uncertainty may mean submitted. observed_in_ui is unique outgoing UI evidence, not acceptance or delivery. Recovery tokens grant status only.",
  inputSchema: z.object({ operationId: z.uuid() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
}, async ({ operationId }, extra) => {
  let client: Awaited<ReturnType<typeof connectBroker>> | undefined;
  const cancel = () => client?.close();
  try {
    if (extra.signal.aborted) return commitFailure(operationId, "DISPATCH_UNAVAILABLE");
    client = await pendingBroker();
    extra.signal.addEventListener("abort", cancel, { once: true });
    if (extra.signal.aborted) { cancel(); return commitFailure(operationId, "DISPATCH_UNCERTAIN"); }
    const result = await client.commitFixtureMessage(operationId);
    if (result.kind === "error") return commitFailure(operationId,
      result.payload.code === "DISPATCH_UNCERTAIN" ? "DISPATCH_UNCERTAIN" : "DISPATCH_UNAVAILABLE");
    if (result.kind !== "fixture_dispatch") throw new Error("Unexpected fixture commit reply");
    const ok = result.payload.state === "observed_in_ui";
    const payload = { ...result.payload, ok, retryAllowed: false,
      ...(!ok ? { code: "DISPATCH_UNCERTAIN" } : {}) };
    return { isError: !ok, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  } catch {
    client?.close();
    if (broker === client) broker = undefined;
    return commitFailure(operationId, "DISPATCH_UNCERTAIN");
  } finally {
    extra.signal.removeEventListener("abort", cancel);
  }
});

server.registerTool("chat_get_operation", {
  description: "Read owned fixture, Gemini, configured Databag or Company AI operation status, including durable dispatch uncertainty and immutable page/person resolutions. A recoveryToken recovers dispatch status after restart, never fill state, browser access, approval or resend permission. Filled describes past exact readback, not the current draft. Page or person evidence is not service acceptance or delivery; no status query performs a submit.",
  inputSchema: z.object({ operationId: z.uuid(), recoveryToken: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
  annotations: { readOnlyHint: true }
}, async ({ operationId, recoveryToken }) => {
  try {
    const result = await (await pendingBroker()).getPreparedOperation(operationId, recoveryToken);
    if (result.kind === "error") return blocked(result.payload.code);
    if (result.kind !== "prepared_operation_state") return unavailable();
    return { content: [{ type: "text", text: JSON.stringify(result.payload) }], structuredContent: result.payload };
  } catch {
    return unavailable();
  }
});

server.registerTool("chat_disconnect", {
  description: "End an owned browser-chat connection without closing its tab. Pending access is cancelled and subsequent reads and writes are denied; an already activated send cannot be undone.",
  inputSchema: z.object({ connectionId: z.uuid() }).strict()
}, async ({ connectionId }) => {
  try {
    const result = await (await pendingBroker()).disconnectFixture(connectionId);
    if (result.kind === "error") return blocked(result.payload.code);
    if (result.kind !== "fixture_disconnected") return unavailable();
    return { content: [{ type: "text", text: JSON.stringify(result.payload) }], structuredContent: result.payload };
  } catch {
    return unavailable();
  }
});

server.server.oninitialized = () => {
  if (process.env.BROWSER_CHAT_AUTO_START_BROKER !== "0") void pendingBroker().catch(() => {});
};

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "MCP stdio connection failed"}\n`);
  process.exitCode = 1;
});