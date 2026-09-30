import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { connectBroker } from "./broker-client.js";
import { MAX_PREPARED_MESSAGE_BYTES } from "./message-operations.js";

const server = new McpServer({ name: "browser-chat-feasibility", version: "0.0.1" });
const runtimeDirectory = join(homedir(), ".config/agent-messaging-mcp/broker");
let broker: Awaited<ReturnType<typeof connectBroker>> | undefined;

async function pendingBroker() {
  if (broker?.closed) broker = undefined;
  return broker ??= await connectBroker("facade", runtimeDirectory);
}

function unavailable() {
  broker?.close();
  broker = undefined;
  return { isError: true, content: [{ type: "text" as const, text: "BROKER_UNAVAILABLE: Start the private local broker; no chat was accessed." }] };
}

function blocked(code: string) {
  return { isError: true, content: [{ type: "text" as const, text: `${code}: No chat was accessed.` }] };
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

server.registerTool("chat_read_messages", {
  description: "Read a fresh rendered-only snapshot from an owned, toolbar-approved fixture or Gemini chat after an exact-document browser challenge. Gemini results contain the selected chat's visible message text, not complete history.",
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

server.registerTool("chat_wait_for_events", {
  description: "Wait for later rendered-only fixture or Gemini snapshots from an owned cursor, with a bounded timeout and explicit resnapshot on cursor expiry. Gemini row identity and completion remain uncertain.",
  inputSchema: z.object({
    connectionId: z.uuid(),
    cursor: z.object({ epoch: z.uuid(), sequence: z.number().int().safe().nonnegative() }).strict(),
    timeoutMs: z.number().int().min(0).max(20_000).optional(),
    limit: z.number().int().min(1).max(2).optional()
  }).strict(),
  annotations: { readOnlyHint: true }
}, async ({ connectionId, cursor, timeoutMs, limit }, extra) => {
  const deadline = Date.now() + (timeoutMs ?? 20_000);
  try {
    while (true) {
      if (extra.mcpReq.signal.aborted) return blocked("CANCELLED");
      const result = await (await pendingBroker()).readApprovedEvents(connectionId, cursor, limit);
      if (result.kind === "error") return blocked(result.payload.code);
      if (result.kind !== "fixture_events" && result.kind !== "gemini_events") return unavailable();
      if (result.payload.state === "expired") return {
        isError: true,
        content: [{ type: "text" as const, text: "CURSOR_EXPIRED: Call chat_read_messages for a new snapshot." }],
        structuredContent: { code: "CURSOR_EXPIRED", resnapshot: true }
      };
      const timedOut = result.payload.events.length === 0 && Date.now() >= deadline;
      if (result.payload.events.length || timedOut) {
        const payload = { ...result.payload, timedOut };
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
      }
      await waitForPoll(Math.min(200, deadline - Date.now()), extra.mcpReq.signal);
    }
  } catch {
    return unavailable();
  }
});

server.registerTool("chat_prepare_message", {
  description: "Prepare an immutable fixture-only message preview for an owned approved connection. The draft expires after 60 seconds. This cannot approve, fill, or send a message; Gemini preparation is unavailable.",
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

server.registerTool("chat_disconnect", {
  description: "Revoke an owned read-only browser-chat connection without closing its tab. Pending reads are cancelled and subsequent access is denied.",
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

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "MCP stdio connection failed"}\n`);
  process.exitCode = 1;
});