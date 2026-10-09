# Browser Chat MCP: Development Reference

Reusable setup, operating instructions, tool contracts and code map for people and coding agents working on this repository.

- Current status, evidence, review findings and the next step: the dashboard at the top of [HANDOFF.md](HANDOFF.md).
- Architecture, design rationale and open decisions D1-D9: [DESIGN.md](DESIGN.md), section 17.
- Workflow and safety rules: [AGENTS.md](AGENTS.md). Public introduction: [README.md](README.md).

Dated test reports that used to fill this file were removed in the 2026-10-09 review. HANDOFF.md keeps that evidence, and the previous text is available with `git show 002d600:DEVELOPMENT.md`.

> **Experimental.** The local fixture supports reads, events and supervised fill and send. A selected saved Gemini chat supports reads and events; Gemini writing is private, incomplete and refused by the public tools. Never connect personal conversations.

## Architecture in Brief

```text
MCP host <-> stdio facade <-> private Unix-socket broker <-> native relay <-> extension worker <-> selected tab
```

| Component | Entry point | Started by | Responsibility |
| --- | --- | --- | --- |
| MCP facade | `packages/companion/dist/mcp-stdio.js` | The MCP host, via [.vscode/mcp.json](.vscode/mcp.json) | Public tools; connects to the broker in the `facade` role; each process is one owner |
| Broker | `packages/companion/dist/broker-process.js` | `npm run dev:broker`, by hand | Grants, operation ledger, observation buffers, deadlines and role checks |
| Native relay | `packages/companion/dist/native-relay.js`, through a launcher | Chromium, once per `connectNative` port | Validates and forwards frames in the `relay` role; no chat logic |
| Extension | `packages/extension/.output/chrome-mv3` | Loaded unpacked in container Chromium | Trusted popup, service worker and injected page functions |

There is no network control listener, CDP bridge, model-supplied selector or provider API key. The broker routes every request through the caller's owned grant, never through a model-supplied URL or provider name.

Private state, never committed:

- `~/.config/agent-messaging-mcp/broker/` (mode 0700) holds `broker.sock`, `facade.key` and `relay.key`. They are recreated on every broker start, so a broker restart ends all grants, consents and in-memory drafts.
- `~/.config/agent-messaging-mcp/operations.sqlite` (0600) holds operation metadata, keyed digests, dispatch intents and receipt hashes, never message text.
- `~/.config/agent-messaging-mcp/native-host` is the native launcher script.
- `~/.local/share/agent-messaging-mcp/chromium-dev` is the Chromium profile (a Podman volume) with logins and the native host manifest. Treat it as sensitive.

## Setup

Everything runs inside the Podman devcontainer ([devcontainer.json](.devcontainer/devcontainer.json)): Chromium, the extension, the native host, the broker and the MCP facade. Browsers on the Windows or WSL host cannot be used, and their tabs and logins are not reachable. Port 8787 is forwarded only for optional viewing of the fixture.

1. Open the repository in the devcontainer. Post-create runs `npm ci && npm run build && npm run restore:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"`. For an existing checkout, run `npm ci` and `npm run build`.
2. Start the fixture and the broker in two terminals; both keep running:

   ```bash
   npm run dev:fixture
   npm run dev:broker
   ```

   The fixture serves `http://127.0.0.1:8787/` (textarea) and `http://127.0.0.1:8787/?editor=rich` (contenteditable). Its **Switch chat** button changes the conversation in place. The broker refuses a second instance (`Broker is already running`) and recovers only its own dead runtime. Stop it with Ctrl+C.
3. Start container Chromium with the development profile:

   ```bash
   chromium --user-data-dir="$HOME/.local/share/agent-messaging-mcp/chromium-dev" --no-first-run http://127.0.0.1:8787/
   ```

   If Chromium reports a profile lock from an older container, the person uses Chromium's own unlock prompt. Never delete lock files or profile data automatically.
4. First time for a profile: open `chrome://extensions`, enable Developer Mode, choose **Load unpacked** with `packages/extension/.output/chrome-mv3` and note the extension ID (the development build has used `ihgoljipfhieipbphdchlghecffbbddo`). Then register the native host:

   ```bash
   npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev" --preview
   npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"
   ```

   This writes `<user-data-dir>/NativeMessagingHosts/com.agent_messaging_mcp.bridge.json`, which allows only that extension origin, plus the launcher. It refuses to overwrite a different registration. `npm run unregister:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"` removes only a recognized one, and `restore:native` recreates a missing launcher from an existing manifest.
5. The workspace [MCP configuration](.vscode/mcp.json) registers `browserChatFeasibility`. Start or restart it with **MCP: List Servers** after every build.
6. Verify the chain:
   - `browser_chat_feasibility` returns `MCP stdio diagnostic OK. No browser data was read or sent.`
   - On the fixture tab, the toolbar popup's **Inspect this chat** lists the fixture rows and `Native bridge ready (protocol v1). Nothing was sent.`
   - `chat_request_connection` returns a pending request. `BROKER_UNAVAILABLE` means the broker is not running.

## Coordinated Restart After Source Changes

Running processes keep the code they started with.

1. Run `npm run build`.
2. Look for a running broker (`pgrep -af broker-process`). Stop it with Ctrl+C in its terminal, then start `npm run dev:broker` again. This ends every grant and consent; unresolved dispatch intents survive only as status.
3. Restart the MCP server (**MCP: List Servers**) so the facade reconnects and tool descriptions refresh. The new facade is a new owner: old request, connection and operation IDs return `unknown`.
4. Reload the extension in `chrome://extensions`, which revokes its grants, then select the chat tab again.

Toolbar clicks, extension reloads and profile unlocks are human steps. Ask for them precisely and never assume that an earlier service, grant or approval survived (AGENTS.md).

## Agent Workflow

### Connect and read

1. `chat_request_connection` returns `{ requestId, state: "pending", expiresAt }`. The request expires after 60 seconds.
2. Human: select the chat tab, click the extension's toolbar icon, choose **View pending requests**, then **Approve read-only fixture** or **Approve read-only Gemini chat** for that request.
3. `chat_get_connection { requestId }` returns `ready_readonly` with `connectionId`, `origin`, `conversationId`, `generation: 1`, `expiresAt` (five minutes after approval, no renewal) and `observation` age (`not_observed`, `recent` or `old`, not a presence signal). Other states are `pending`, `expired`, `stale` (revoked) and `unknown` (foreign or forgotten).
4. `chat_read_messages { connectionId, limit? }` returns a fresh rendered snapshot with `coverage: "rendered_only"`, `capturedAt`, `cursor`, `messages` and `omittedBefore`. Fixture rows have stable IDs; Gemini rows carry `identityQuality: "uncertain"` and `generationState: "unknown"`.
5. `chat_wait_for_events { connectionId, cursor, timeoutMs?, limit? }` waits up to 20 seconds and returns `{ state: "ok", events, cursor, timedOut }`. Each event holds a full rendered snapshot, not a delta. On `CURSOR_EXPIRED`, call `chat_read_messages` again.
6. `chat_disconnect { connectionId }` returns `{ disconnected }` and leaves the tab open.

For Gemini, treat events as change hints. A streaming reply produces many snapshots, the 32-event buffer can expire a cursor, and completion is unknown, so wait until events stop for a while and then read again. A reply longer than 2,048 characters or a chat with more than 32 rendered rows currently ends the grant (HANDOFF finding R1).

### Supervised send (fixture only)

1. `chat_prepare_message { connectionId, expectedGeneration: 1, text, idempotencyKey }` with a new UUID key returns `operationId`, `awaiting_approval`, `expiresAt` (three minutes), the exact `preview` and a private `recoveryToken`.
2. Human: **Review fixture drafts**, then **Approve draft (no send)**.
3. Human: **Review fixture draft fill**, then **Allow draft fill (no send)**.
4. `chat_fill_draft { operationId }`, once, while the same fixture document is selected and its editor is empty.
5. Human: check the draft, then **Review fixture sending** and **Approve fixture send**.
6. `chat_commit_message { operationId }`, once.
7. `chat_get_operation { operationId, recoveryToken? }` reports status only.

Each human approval lasts at most two minutes and ends with the preparation or connection. Never retry an uncertain fill or commit, and never create a replacement operation after uncertainty. On a Gemini connection, `chat_prepare_message` currently returns `CONNECTION_NOT_FOUND` because public writes are fixture-only; the connection itself remains valid for reads.

## Tool Reference

| Tool | Input | Result | Notes |
| --- | --- | --- | --- |
| `browser_chat_feasibility` | none | Fixed diagnostic text | Touches no browser |
| `chat_request_connection` | none | `requestId`, `pending`, `expiresAt` | No tab is read before approval |
| `chat_get_connection` | `requestId` | Connection state | Owner only; others see `unknown` |
| `chat_read_messages` | `connectionId`, `limit` 1-32 | Fresh snapshot and cursor | Exact-document challenge, four seconds |
| `chat_wait_for_events` | `connectionId`, `cursor`, `timeoutMs` 0-20000, `limit` 1-2 | `events`, `cursor`, `timedOut` | `CURSOR_EXPIRED` needs a new read; cancellation returns `CANCELLED` |
| `chat_prepare_message` | `connectionId`, `expectedGeneration: 1`, `text`, `idempotencyKey` | Operation, exact preview, `recoveryToken` | Fixture only; the same key and text replay, changed text conflicts |
| `chat_fill_draft` | `operationId` | `ok` with `editor` and `completedAt`, or `code`; `retryAllowed: false` | Needs fill consent; refuses existing drafts; never clicks Send |
| `chat_commit_message` | `operationId` | `observed_in_ui` with row and time evidence, or `DISPATCH_UNAVAILABLE` / `DISPATCH_UNCERTAIN`; `retryAllowed: false` | Needs completed fill and Send consent; fresh read and proof run inside; replay returns status only |
| `chat_get_operation` | `operationId`, optional 64-hex `recoveryToken` | State, approval expiry, `draftFill` metadata | A token recovers only dispatch status after restart, never authority |
| `chat_disconnect` | `connectionId` | `disconnected` | Cancels pending reads; closes nothing |

Operation states are `awaiting_approval`, `approved` (ordinary no-send review only), `expired`, `stale`, `unknown`, `dispatch_uncertain` and `observed_in_ui`. `draftFill` reports `fill_approved`, `filling`, `filled`, `failed` or `uncertain`; `filled` describes a past readback, not the current draft. `observed_in_ui` is UI evidence, not acceptance or delivery.

Most refusals are text of the form `CODE: No chat was accessed.` Codes include `BROKER_UNAVAILABLE`, `CONNECTION_NOT_FOUND`, `OBSERVATION_UNAVAILABLE`, `CURSOR_EXPIRED`, `CANCELLED`, `TOO_MANY_PENDING`, `PREPARATION_UNAVAILABLE`, `GENERATION_MISMATCH`, `INVALID_MESSAGE_TEXT`, `INVALID_IDEMPOTENCY_KEY`, `IDEMPOTENCY_CONFLICT`, `OPERATION_EXPIRED`, `OPERATION_UNAVAILABLE`, `TOO_MANY_PREPARED` and `DISPATCH_UNCERTAIN`. Fill and commit return structured codes; losing the broker connection during either becomes `FILL_UNCERTAIN` or `DISPATCH_UNCERTAIN`.

## Trusted Popup

The toolbar popup is the only approval surface; page scripts and MCP calls cannot approve anything. On the fixture or an eligible saved Gemini chat it offers:

- **Inspect this chat**: a read-only diagnostic. On the fixture it lists rows and checks the native bridge. On Gemini it shows only structure metadata (regions, editors, row lengths, **Send controls**, **Prompt state** and **Nearby prompt controls**), never chat text.
- **View pending requests**, then **Approve read-only fixture** or **Approve read-only Gemini chat**.
- **Review fixture drafts** or **Review Gemini drafts**, then **Approve draft (no send)**.
- **Review fixture draft fill** or **Review Gemini fill consent**, then **Allow draft fill (no send)**.
- **Review fixture sending** or **Review Gemini send consent**, then **Approve fixture send** or **Approve Gemini send**.
- Legacy debugger probes: **Test fixture input** on the rich fixture and, on Gemini, **Fill test draft**, which types a fixed sentence into the real composer outside the operation ledger. Use them only with explicit authorization; decision D6 covers removing them.

Review lists show at most eight exact previews and clear when the tab, document, grant or expiry changes.

## Gemini Target Rules

- Eligible: a saved chat URL with exactly two path segments, such as `https://gemini.google.com/app/<id>`, with an optional query (bound exactly), no fragment and at most 512 characters. New unsaved chats (`/app`) and multi-account paths such as `/u/<n>/app/<id>` are not eligible.
- A grant binds the tab, Chrome document, exact URL and conversation ID. Reloading, navigating or closing the tab, reloading the extension or an observation failure makes it `stale`.
- Reads parse `user-query` and `model-response` rows inside one visible `infinite-scroller` in one `main` region. Fill and submit also need the tab active and visible, one prompt editor labeled `Enter a prompt for Gemini` (empty before filling) and one visible `Send message` submit button.
- These selectors reflect one observed UI variant and can break whenever Gemini changes its page.

## Limits and Timers

| Item | Value | Defined in |
| --- | --- | --- |
| Pending connection request | 60 s; at most 100 pending | `pending-connections.ts` |
| Read-only grant | 5 min without renewal; `generation` always 1 | `pending-connections.ts` |
| Fresh read challenge | 4 s | `pending-connections.ts` |
| Snapshot | 32 rows, 2,048 UTF-16 units per message, 64 KiB; a failed capture revokes the grant | `gemini-observation.ts`, `fixture-observation.ts`, `pending-connections.ts` |
| Observation buffer per grant | 32 events, 256 KiB | `pending-connections.ts` |
| Event wait | 20 s maximum, 2 events per call, 200 ms polling | `mcp-stdio.ts` |
| Prepared text | 4,000 UTF-8 bytes; Gemini also 2,048 UTF-16 units, no surrounding whitespace, no carriage return | `message-operations.ts` |
| Preparation | 3 min; 100 active and 10,000 recorded; keys kept one day after expiry; unresolved intents never pruned | `message-operations.ts` |
| Consents | At most 2 min each, clipped; review lists show 8 | `message-operations.ts` |
| Browser leases | Fill, proof and submit 4 s; one pending fill shared by providers; one pending submit; 16 proofs or preflights | `message-operations.ts` |
| Facade requests | 5 s budget; keepalive every 60 s when idle; the broker drops idle sockets after 150 s | `broker-client.ts`, `broker-ipc.ts` |
| Broker capacity | 16 sockets; 16 queued requests per socket | `broker-ipc.ts`, `broker-roles.ts` |
| Native frames | 256 KiB; relay queue 16 | `native-framing.ts`, `native-relay.ts` |
| Browser submit markers | 10,000 operation IDs, no eviction | `fixture-observation.ts` |

## Private Protocol

- Broker sockets and Native Messaging use the same framing: UTF-8 JSON with a native-endian 32-bit length prefix, at most 256 KiB, in the envelope `{ kind, protocolVersion: 1, requestId, connectionGeneration: 0, deadlineMs, payload }`. Every schema is strict. Deadlines are absolute and only ever clipped, never extended.
- Each broker socket authenticates once as `facade` (the MCP owner of grants and operations) or `relay` (the native host). Facade-only requests query state and start reads, preparation, fills, proofs and commits. Relay-only requests list and approve pending requests and reviews, list and complete browser challenges and jobs, publish snapshots, mark gaps and revoke grants. Facades cannot approve or complete browser work, and relays cannot read, prepare, fill or commit for an owner.
- Write jobs (Gemini fill, Gemini proof and every submit job) are offered once and never re-offered. Read challenges and fixture fill and proof checks are listed until answered or expired; one-shot attempt IDs in the page stop a second fixture fill. Lost or late results become uncertainty, never retries.
- A command spans `broker-requests.ts` (schema and role check), `broker-ipc.ts` (asynchronous orchestration), `broker-client.ts` (client method and reply schema), `native-protocol.ts` (relay parser), `native-relay.ts` (forwarding) and `entrypoints/background.ts` (hand-written extension validation). Change them together, and read DESIGN.md sections 8 and 17 before adding a command family.

## Code Map

Companion (`packages/companion/src`; tests sit beside modules as `*.test.ts` and run from `dist`):

- `mcp-stdio.ts`: MCP facade, public tools and broker connection lifecycle.
- `broker-process.ts`, `broker-recovery.ts`: broker entry point, private runtime, singleton start and safe stale-runtime recovery.
- `broker-roles.ts`, `broker-ipc.ts`, `broker-requests.ts`: role authentication, socket server with its per-socket queue, request schemas and handlers.
- `broker-client.ts`: authenticated client, deadlines, reply schemas and keepalive.
- `pending-connections.ts`: pending requests, grants, read challenges, snapshots, observation buffers, gaps and revocation.
- `observation-buffer.ts`: bounded immutable event log with cursors.
- `message-operations.ts`: operation ledger with preparation, reviews and consents, fill, proof and dispatch queues, SQLite intents, receipts and reconciliation.
- `native-framing.ts`, `native-protocol.ts`, `native-relay.ts`: frame codec, relay parsers and the relay process.
- `native-registration.ts`, `register-native.ts`: native host register, restore and unregister.

Extension (`packages/extension`):

- `entrypoints/background.ts`: service worker with native watches, approvals, consent handlers, fill, proof and submit executors, revocation and legacy probes.
- `entrypoints/popup/`: trusted popup.
- `lib/fixture-observation.ts`: fixture page functions and the persistent submit reservation (`reserveBrowserSubmitAttempt`).
- `lib/gemini-observation.ts`: Gemini page functions for eligibility, identity, observation, capture, inspection, fill, submit and diagnostics.
- `lib/approved-probe.ts`: fixed text for the legacy Gemini probe.
- `wxt.config.ts`: manifest and permissions (`activeTab`, `scripting`, `nativeMessaging`, `debugger`, `storage`).

Tests: `tests/fixtures/` holds the synthetic chat page and server. `tests/e2e/extension-probe.test.mjs` runs the full stack with disposable Chromium, broker and native host, including loss and crash cases. `tests/e2e/fixture-editor.test.mjs` and `tests/e2e/gemini-observation.test.mjs` test page functions on synthetic pages. `tests/diagnostics/clock-probe.c` is optional and must not run without explicit authorization.

## Testing

| Script | Effect |
| --- | --- |
| `npm run build` | Companion `tsc` and extension `wxt build` |
| `npm run typecheck` | Both packages |
| `npm run test:unit` | Builds the companion, then runs `node --test` on the fixture tests and `packages/companion/dist/*.test.js` |
| `npm run test:e2e` | `node --test tests/e2e/*.test.mjs` with sandboxed disposable Chromium; build first |

The exact gate before every source commit (AGENTS.md):

```bash
npm run build && npm run typecheck && npm run test:unit && npm run test:e2e
```

Focused runs:

```bash
npm run build:companion && node --test --test-name-pattern='<regex>' packages/companion/dist/<module>.test.js
npm run build && node --test --test-name-pattern='<regex>' tests/e2e/<file>.test.mjs
```

Browser-test rules: launch Chromium with `chromiumSandbox: true`, because Playwright otherwise adds `--no-sandbox`; use disposable profiles and an isolated HOME broker; wait for the current-user, owner-only socket before connecting; keep the original timeouts and assertions. Test copies of the extension may get temporary host permissions, and automated popup navigation does not grant `activeTab`, so these tests do not prove real toolbar approval. Installed-toolbar and live checks are separate, human-assisted evidence.

## Troubleshooting

- `BROKER_UNAVAILABLE`: start `npm run dev:broker`; the facade reconnects on the next call. Read-only calls can then be repeated, but an uncertain fill or commit must not be.
- `CONNECTION_NOT_FOUND` or `stale`: the grant expired after five minutes; the tab reloaded, navigated or closed; the conversation changed; the extension reloaded; an observation failed (HANDOFF R1); or the MCP server restarted and became a new owner. Request a new connection.
- `OBSERVATION_UNAVAILABLE`: the extension did not answer within four seconds. The tab may be gone, or the worker's native watch may have stopped (HANDOFF R2); reloading the extension restarts it and marks an observation gap.
- No pending request in the popup: the request expired after 60 seconds, or the selected tab is not the fixture or an eligible saved Gemini chat.
- Native bridge unavailable: check the registration with `--preview`, the extension ID, the launcher path and that the manifest is in the profile Chromium is using.
- Tools missing or outdated: rebuild and restart the MCP server.
- `Refusing to recover ...` at broker start: inspect ownership and modes under `~/.config/agent-messaging-mcp` by hand; never loosen the checks.

## Live-Chat Rules

Use only disposable chats in the development profile, with fresh human authorization for each live read. A live connector fill needs explicit approval of the exact chat and text, and a live send needs a separate approval. Never clear or submit a draft the person typed. Do not store chat text, full URLs, IDs or recovery tokens in documents, logs or memory. Details are in AGENTS.md.
