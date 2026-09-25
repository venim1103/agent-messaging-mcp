import assert from "node:assert/strict";
import { test } from "node:test";
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
    assert.deepEqual(tools.map((tool) => tool.name), ["browser_chat_feasibility"]);

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