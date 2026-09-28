# Browser Chat MCP

Connect an MCP agent to a browser chat that a person opens and approves through an extension. The intended experience uses the person's existing browser login and the chat website itself, not a provider API or exported credentials.

> **Status: early local prototype.** The approved read path is implemented only for the synthetic chat fixture; its full toolbar-to-MCP flow still needs a manual browser check. Gemini is not connected through MCP, and there is no message-send tool. Do not use this build to grant access to personal conversations.

## How It Works

An agent requests a connection through MCP. The user selects the local fixture tab and approves the pending request in the extension popup. A browser-spawned Native Messaging host relays bounded observations to a private local broker; only the MCP client that owns the approved connection can read them.

```text
MCP client <-> stdio facade <-> private Unix broker <-> native relay <-> extension <-> approved tab
```

There is no network browser-control listener, unrestricted CDP bridge, model-supplied selector, or provider API key. Approval binds one fixture conversation to its browser tab and document. Reloading the tab, switching the fixture conversation, or restarting the extension invalidates that grant.

## What Works Today

- `chat.request_connection` creates a short-lived pending request; `chat.get_connection` reports owner-visible state and, after approval, a read-only connection ID.
- `chat.read_messages` returns the latest **cached, rendered-only fixture snapshot** with a capture time and cursor. It is not a live query on every call, complete chat history, or a Gemini transcript.
- The extension observes the approved fixture's message list and publishes bounded updates. Reads are denied for other MCP clients and for revoked or expired grants.
- The popup has separate structure-only Gemini diagnostics and explicitly approved draft-input probes. They do not create a Gemini MCP connection or click Send.

The full toolbar-approval-to-MCP-read flow with the new snapshot code still needs a manual check in the installed development browser. See [HANDOFF.md](HANDOFF.md) for verified tests, remaining risks, and the current next step.

## Try the Local Fixture

Work inside the supplied devcontainer with Node.js 24+ and Chromium. Its post-create step installs dependencies and builds the packages; for an existing checkout, run:

```bash
npm ci
npm run build
```

Start the fixture and broker in separate terminals, then open the fixture in **container Chromium**:

```bash
npm run dev:fixture
npm run dev:broker
chromium --user-data-dir="$HOME/.local/share/agent-messaging-mcp/chromium-dev" --no-first-run http://127.0.0.1:8787/
```

In `chrome://extensions`, enable Developer Mode and load the unpacked build at `packages/extension/.output/chrome-mv3`. Note its extension ID, then register the exact-origin native host for that browser profile:

```bash
npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev" --preview
npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"
```

The workspace [MCP configuration](.vscode/mcp.json) registers `browserChatFeasibility` in VS Code. Restart that server with **MCP: List Servers** after rebuilding. Call `chat.request_connection`, use the extension's toolbar popup on the selected fixture tab to **View pending requests** and **Approve read-only fixture**, then call `chat.get_connection` with the request ID and `chat.read_messages` with the returned connection ID. A pending request expires after 60 seconds; an approved fixture grant lasts at most five minutes.

## Verification and Limits

```bash
npm run typecheck
npm run test:unit
npm run test:e2e
```

Unit and isolated Chromium tests cover role isolation, native framing, fixture snapshots, and revocation. Automated popup navigation does **not** grant Chrome's `activeTab` permission, so those tests do not replace the real toolbar approval check. Cached reads can outlive a tab change if the browser cannot deliver revocation; a fresh browser challenge on every read and event waiting are still needed before supporting real-site conversations. Sending requires a separate supervised approval and recovery path.

Read [DESIGN.md](DESIGN.md) for the architecture and intended capabilities, [HANDOFF.md](HANDOFF.md) for setup details and test evidence, and [LICENSE](LICENSE) for licensing.
