import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("official SDK stdio client discovers and calls the diagnostic tool", async () => {
  const client = new Client({ name: "browser-chat-test", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./mcp-stdio.js", import.meta.url))]
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      "browser_chat_feasibility", "chat.request_connection", "chat.get_connection"
    ]);

    const result = await client.callTool({ name: "browser_chat_feasibility", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{
      type: "text",
      text: "MCP stdio diagnostic OK. No browser data was read or sent."
    }]);
  } finally {
    await client.close();
  }
});

test("two real MCP clients cannot reuse each other's pending handles", { timeout: 8000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-mcp-home-"));
  const entry = fileURLToPath(new URL("./mcp-stdio.js", import.meta.url));
  const brokerEntry = fileURLToPath(new URL("./broker-process.js", import.meta.url));
  const clientOne = new Client({ name: "client-one", version: "0.0.1" });
  const clientTwo = new Client({ name: "client-two", version: "0.0.1" });
  const options = { command: process.execPath, args: [entry], env: { ...process.env, HOME: home } };
  const brokerDirectory = join(home, ".config/agent-messaging-mcp/broker");
  let broker: ReturnType<typeof spawn> | undefined;
  let brokerExit: ReturnType<typeof once> | undefined;

  try {
    await clientOne.connect(new StdioClientTransport(options));
    const unavailable = await clientOne.callTool({ name: "chat.request_connection", arguments: {} });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0]?.type === "text" ? unavailable.content[0].text : "", /BROKER_UNAVAILABLE/);

    broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: home }, stdio: "ignore" });
    brokerExit = once(broker, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        ready = (await stat(join(brokerDirectory, "broker.sock"))).isSocket();
        if (ready) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await setTimeout(25);
    }
    assert.equal(ready, true, "Broker did not start");

    const created = await clientOne.callTool({ name: "chat.request_connection", arguments: {} });
    assert.equal(created.isError, undefined);
    const handle = created.structuredContent as { requestId: string; state: string; expiresAt: number };
    assert.equal(handle.state, "pending");

    await clientTwo.connect(new StdioClientTransport(options));
    const hidden = await clientTwo.callTool({ name: "chat.get_connection", arguments: { requestId: handle.requestId } });
    assert.deepEqual(hidden.structuredContent, { state: "unknown" });
    const own = await clientOne.callTool({ name: "chat.get_connection", arguments: { requestId: handle.requestId } });
    assert.deepEqual(own.structuredContent, handle);
    await clientOne.close();
    const disconnected = await clientTwo.callTool({ name: "chat.get_connection", arguments: { requestId: handle.requestId } });
    assert.deepEqual(disconnected.structuredContent, { state: "unknown" });
  } finally {
    await clientOne.close();
    await clientTwo.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    await rm(home, { recursive: true, force: true });
  }
});