import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { connectBroker } from "./broker-client.js";

const server = new McpServer({ name: "browser-chat-feasibility", version: "0.0.1" });
const runtimeDirectory = join(homedir(), ".config/agent-messaging-mcp/broker");
let broker: Awaited<ReturnType<typeof connectBroker>> | undefined;

async function pendingBroker() {
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

server.registerTool("browser_chat_feasibility", {
  description: "Check MCP stdio compatibility without accessing any browser tab or conversation.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true }
}, async () => ({
  content: [{ type: "text", text: "MCP stdio diagnostic OK. No browser data was read or sent." }]
}));

server.registerTool("chat.request_connection", {
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

server.registerTool("chat.get_connection", {
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

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "MCP stdio connection failed"}\n`);
  process.exitCode = 1;
});