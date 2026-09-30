# Browser Chat MCP

Connect an MCP agent to a browser chat that a person opens and approves through an extension. The intended experience uses the person's existing browser login and the chat website itself, not a provider API or exported credentials.

> **Status: early local prototype.** The fixture toolbar-to-MCP read path is manually verified. One explicitly selected disposable Gemini chat also passed a real read-only toolbar approval, returned two visible rows through MCP, and was disconnected. This is not complete chat history or general Gemini support. There is no message-send tool. Do not use this build to grant access to personal conversations.

## How It Works

An agent requests a connection through MCP. The user selects the local fixture tab and approves the pending request in the extension popup. A browser-spawned Native Messaging host relays bounded observations to a private local broker; only the MCP client that owns the approved connection can read them.

```text
MCP client <-> stdio facade <-> private Unix broker <-> native relay <-> extension <-> approved tab
```

There is no network browser-control listener, unrestricted CDP bridge, model-supplied selector, or provider API key. Approval binds one fixture conversation to its browser tab and document. Reloading the tab, switching the fixture conversation, or restarting the extension invalidates that grant.

## What Works Today

- `chat_request_connection` creates a short-lived pending request; `chat_get_connection` reports owner-visible state and, after approval, a read-only connection ID plus the last snapshot's observation freshness (`not_observed`, `recent`, or `old`). Freshness is not a browser-presence signal.
- `chat_read_messages` requests a **fresh, rendered-only snapshot** through a bounded browser challenge. The broker selects fixture or Gemini from the owned connection, never from model-supplied selectors or URLs. Gemini rows have uncertain identity and unknown completion state; neither provider promises complete chat history.
- `chat_wait_for_events` waits up to 20 seconds for later fixture or Gemini snapshots after an owned cursor, returning at most two per call. Timeouts are explicit; an expired cursor requires another `chat_read_messages` snapshot. A real fixture message appeared through this route in a manual toolbar test; Gemini timeline changes passed only on a synthetic page with a test-copy extension. After an MV3 worker wake, the extension conservatively expires old fixture and Gemini cursors if an observation gap is possible; Gemini wake/resnapshot was checked in the synthetic browser. Each event contains the current rendered snapshot, not only newly received rows.
- `chat_disconnect` lets the owning MCP client revoke a fixture or Gemini grant without closing the tab. The fixture native watcher drops tracking and document observers when its broker grant ends. An unchanged fixture reread refreshes capture time without manufacturing an event.
- The extension observes the approved fixture's message list and publishes bounded updates. Reads are denied for other MCP clients and for revoked or expired grants.
- On a selected saved Gemini chat, the trusted popup can request an explicit read-only grant bound to that tab's exact URL (including a bounded query, if present) and browser document. Fragments remain unsupported; the full URL is not returned to MCP. One real toolbar-approved, exact-document MCP read returned two currently rendered rows with `identityQuality: uncertain` and `generationState: unknown`; the owner then disconnected and verified the grant became stale. A text-free, throttled timeline observer published a later synthetic Gemini row through a disposable test-copy extension, not the installed browser. This verifies one observed chat shape, not stable row IDs, response completion, or complete history. The popup's structure-only diagnostics and separate draft-input probes do not click Send.

The local toolbar-approval-to-MCP-read route returned two synthetic rows on consecutive reads; switching fixture conversations then made that connection stale and blocked another read. A separate fixture-only message advanced the event cursor and appeared through `chat_wait_for_events`. See [HANDOFF.md](HANDOFF.md) for the exact evidence, remaining risks, and next step.

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

The workspace [MCP configuration](.vscode/mcp.json) registers `browserChatFeasibility` in VS Code. Restart that server with **MCP: List Servers** after rebuilding. Call `chat_request_connection`, use the extension's toolbar popup on the selected fixture tab to **View pending requests** and **Approve read-only fixture**, then call `chat_get_connection` with the request ID and `chat_read_messages` with the returned connection ID. Pass the snapshot's cursor and connection ID to `chat_wait_for_events` for later fixture observations; call `chat_disconnect` when done. A pending request expires after 60 seconds; an approved fixture grant lasts at most five minutes.

## Verification and Limits

```bash
npm run typecheck
npm run test:unit
npm run test:e2e
```

Unit and isolated Chromium tests cover role isolation, native framing, read challenges, event cursors, both providers' worker-wake gap invalidation, Gemini grant selection, and disconnect cleanup; the real toolbar fixture read/event route and one disposable Gemini text read also passed manual checks. Automated popup navigation does **not** grant Chrome's `activeTab` permission and is not counted as trusted approval coverage. Read challenges fail closed if the browser cannot verify the approved document. A later manually sent prompt in that disposable Gemini chat left its grant `stale` before an event could be returned; the settled page still had a valid read shape. Synthetic tests now tolerate a temporarily empty model response, but the live cause could also have been an exact URL change and is unverified. Continuous presence reporting, robust real-site identity/completion semantics, and additional site variants remain open. Sending by this connector requires a separate supervised approval and recovery path.

Read [DESIGN.md](DESIGN.md) for the architecture and intended capabilities, [HANDOFF.md](HANDOFF.md) for setup details and test evidence, and [LICENSE](LICENSE) for licensing.
