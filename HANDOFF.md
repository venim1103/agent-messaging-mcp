# Implementation Handoff

Updated: 2026-09-30.

This document tells the next AI how to turn [DESIGN.md](DESIGN.md) into a working implementation. The design explains the architecture and tradeoffs; this handoff supplies the work order, concrete deliverables, and checks. **The opt-in broker and user-approved fixture-only connection work. Each MCP fixture read waits for a bounded exact-document browser challenge; real toolbar-approved reads, a chat switch, and a fixture message-to-MCP event wait passed. One explicitly authorized disposable Gemini chat returned two rendered rows through an exact-document read, then its owner disconnected; later Gemini events and worker-wake gaps are synthetic-tested only. No real-site send has occurred.** VS Code tool executions run in the Podman devcontainer, and the user confirmed that its Chromium fixture window is visible on Windows.

## 1. Start Here

Read this document and [DESIGN.md](DESIGN.md), then inspect the current worktree before changing anything. Preserve any work added after this handoff. Do not spend another session redesigning the system unless a focused experiment disproves an important assumption.

Current public MCP tools use underscores: `chat_request_connection`, `chat_get_connection`, `chat_read_messages`, `chat_wait_for_events`, and `chat_disconnect`. VS Code rejected the earlier dotted spellings quoted in historical milestones below; those are not usable tool names. `browser_chat_feasibility` remains unchanged.

Suggested request for the next AI when the user is ready to start:

> Read [HANDOFF.md](HANDOFF.md) and [DESIGN.md](DESIGN.md). Continue Milestone 1 in the Podman devcontainer: fixture approval, browser-challenged reads, and fixture event waiting passed with real toolbar approval. One exact selected disposable Gemini chat returned two visible rows through the reviewed read-only adapter; later Gemini event delivery passed synthetic tests only. Strengthen browser health/gaps, identity, completion, and additional variants before claiming general real-site support. Require fresh exact-chat approval for another read; sending remains separately gated.

### What the user actually wants

An agent using MCP can read and send messages in **a browser chat conversation explicitly selected by the user**. The chat might be Gemini, WhatsApp Web, or another website. The user should be able to open the chat normally, keep their existing login, and connect it using an extension action.

Gemini is a convenient first AI-chat test target, not a requirement to integrate with Google's API. LM Studio was only an earlier example. Do not build an LM Studio integration, terminal chat client, native desktop automation tool, or unrestricted browser MCP server.

The eventual generic behavior comes from a shared chat model plus reviewed site adapters and a user-calibrated DOM profile. It does not mean every website can be supported without configuration or maintenance.

## 2. Current State and Environment

| Item | Status at handoff |
| --- | --- |
| Repository | Fixture server, WXT popup/background, native relay, and opt-in private broker IPC. Owner-bound fixture reads/events passed real toolbar/browser/MCP checks. One exact-URL Gemini grant passed real toolbar approval, a two-row rendered-only MCP text read, and owner disconnect; Gemini later-event delivery passes synthetic browser tests only. No production send tools |
| Design | Proposed architecture and phased plan in [DESIGN.md](DESIGN.md) |
| Workspace location | `/workspaces/agent-messaging-mcp` in the devcontainer; the earlier WSL host path was `/home/vscode/AI/agent-messaging-mcp` |
| Kernel observed | `Linux 6.18.33.2-microsoft-standard-WSL2` |
| WSL distribution variable | `Ubuntu` |
| Container browser | `/usr/bin/chromium`; version `153.0.8010.52` on Debian 12 at the time of testing |
| Display variables | `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0` |
| Toolchain | Node `v24.21.0`, npm `12.1.0` observed in the current container; post-create runs `npm ci`, the package build, and restoration of a previously approved native host. No WSL/Windows Node, npm, or Chromium installation is required by this project workflow |
| Package manager | npm; use the tracked lockfile and `npm ci` inside the container |
| Podman/devcontainer | Rootless Podman `4.9.3` (`crun`); devcontainer CLI `0.87.0` started the container with `--docker-path podman`, UID 1000, and mounted workspace |
| Browser validation | Chromium `153.0.8010.52` launched without `--no-sandbox` inside Podman; user confirmed the fixture window is visible on Windows, invoked unpacked extension `ihgoljipfhieipbphdchlghecffbbddo` on the fixture, and saw both messages and `Native bridge ready (protocol v1)` |
| Rich-editor probe | `playwright-core` `1.63.0` used the container's `/usr/bin/chromium` headlessly with sandboxing intact; `npm run test:e2e` passed for the synthetic `?editor=rich` and existing textarea variants. After explicitly approving the required debugger permission, the user also invoked a fixture-only extension probe that inserted and read back 24 fixed characters without clicking Send. No live-site editor was tested |
| Container network | Fixture listens on port 8787 inside the container. No fixed WSL host port is published; VS Code can forward it for optional Windows preview |
| Browser profile | Podman volume `agent-messaging-mcp-chromium-profile` remained mounted and writable by UID 1000 across a VS Code devcontainer rebuild; the extension and its ID persisted, but Gemini login/draft persistence was not tested |
| Live integration | A user-approved read-only probe of one disposable Gemini chat found matching user/model row boundaries. In the same chat, a separately approved fixed Gemini draft was inserted and read back (87 characters), and the user showed it in the composer without submitting. No persistent connection, generation handling, real-site send, or supported Gemini adapter exists |

Recheck the environment at the beginning of implementation. A future AI may run in a different terminal, container, or remote host. Do not interpret installed Chromium or populated display variables as a successful browser test.

### Podman devcontainer and browser placement

The active configuration is [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) and its [Dockerfile](.devcontainer/Dockerfile). The image installs Chromium, Node, and npm; creation runs `npm ci && npm run build && npm run restore:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"`. Restore does nothing without an existing exact-origin registration in the profile volume; the user must initially choose and register an extension ID. It uses rootless Podman, `remoteUser: node`, `--userns=keep-id`, and an X11 socket mount for WSLg. A Podman volume retains the development Chromium profile across container replacement; it contains sensitive login data and must never be copied into Git. The fixture binds `0.0.0.0` *inside the container* via `FIXTURE_HOST`. No port is published on the WSL host; VS Code can forward fixture port 8787 for optional Windows preview. That fixture port is not an authenticated browser-control bridge.

On a **WSL host terminal**, the following commands were verified:

```bash
devcontainer up --workspace-folder "$PWD" --docker-path podman
devcontainer exec --workspace-folder "$PWD" --docker-path podman npm run test:unit
devcontainer exec --workspace-folder "$PWD" --docker-path podman npm run build:extension
devcontainer exec --workspace-folder "$PWD" --docker-path podman npm run dev:fixture
```

The last command stays running while the fixture is being tested. In VS Code, open the WSL folder and set the **WSL/Dev Containers host** user setting `dev.containers.dockerPath` to `podman`, then use **Dev Containers: Reopen in Container**. Podman 4.9.3 worked with the CLI here even though Microsoft's documentation describes Podman 5+ as mostly Docker-compatible; the actual VS Code GUI reopen still needs validation. If viewing the fixture in a Windows browser, use the forwarded address shown in VS Code's Ports view, which may use a different local port. A user needs rootless Podman and the devcontainer CLI (plus VS Code's Dev Containers extension and WSLg to view the GUI), not host Node/npm/Chromium or Docker Compose.

Earlier CLI and VS Code invocations created separate project containers, both configured to publish WSL port 8787; VS Code could not start its container while the CLI container held that port. The fixed `--publish` option was removed. The failed VS Code container and earlier CLI container were replaced without deleting the named Chromium profile volume. A fresh command-line container started with empty `PortBindings`; if another old project container still appears after reopening, inspect its labels and port bindings rather than removing unrelated containers.

In the current **container terminal**, run these in separate terminals if they are not already running:

```bash
npm run dev:fixture
chromium --user-data-dir="$HOME/.local/share/agent-messaging-mcp/chromium-dev" --no-first-run http://127.0.0.1:8787/
```

Both commands stay running. The browser process uses the container's profile volume and WSLg's X11 socket; its fixture window has been visually confirmed on Windows. Use `npm run build:extension` inside the container, then in that **container Chromium**, visit `chrome://extensions` and load `/workspaces/agent-messaging-mcp/packages/extension/.output/chrome-mv3`. The popup inspects only the fixture origin `http://127.0.0.1:8787`, requires the browser toolbar gesture, shows its origin/conversation and rendered messages, and attempts a native handshake. Its separate trusted fixture approval flow can persist a bounded broker grant; merely inspecting the fixture does not approve one. It does not send anything. Browsers already open on Windows/WSL are separate; the extension cannot attach to their tabs or use their logins. Log in manually in the container Chromium for any later authorized live-site test.

The native host and registration helper run in the container, and the browser handshake passed. The opt-in broker and chat MCP facade also live in **the same container as Chromium**. The extension build is in the mounted workspace. Its native host is registered for extension ID `ihgoljipfhieipbphdchlghecffbbddo`; post-create restores its launcher if the profile volume retains the matching manifest. If the manifest is lost, explicitly register again after validating the ID. The forwarded **fixture** port is not a browser-control interface. Do not mount any external browser profile or expose CDP.

The current VS Code agent tools run inside the container at `/workspaces/agent-messaging-mcp`, and the user confirmed that the container Chromium fixture window is visible on Windows. The user invoked the extension on the fixture and verified selected-tab access and the native handshake. VS Code's window and Copilot Chat UI remain on Windows by design; the workspace, integrated terminals, agent tool executions, and any workspace extension host run in the container. VS Code chooses whether a particular Copilot extension component runs as a UI or workspace extension. Do not claim the whole chat service or Windows UI runs inside Podman.

## 3. Keep These Decisions

1. **TypeScript and local-first:** Node.js 24 LTS, npm workspaces, WXT for the extension, the official MCP SDK, and shared Zod schemas. Verify and pin compatible published versions before choosing imports; the design's SDK research is dated, not a substitute for checking the installed API.
2. **Three code units:** shared domain/contracts, one local companion package, and the extension. The companion has separate MCP, broker, and native-relay entry points; these do not need separate repositories or a service framework.
3. **MCP stdio first:** use private local IPC between local processes and Native Messaging between Chromium and the companion. Do not add an HTTP/WebSocket control listener to make local development easier.
4. **Extension-controlled access:** user invocation selects the tab; connection approval binds the conversation and client. Never expose raw tab selection, arbitrary selectors, JavaScript evaluation, navigation, or CDP commands through MCP.
5. **Read-only before writing:** prove selection, ownership, snapshots, events, and revocation before exposing production message submission.
6. **Supervised writes:** prepare an immutable operation, approve it in trusted extension UI, then commit with fresh checks and a durable operation record. A model-controlled boolean is not human approval.
7. **Honest results:** rendered history is not full history; a quiet AI response is not necessarily complete; an optimistic outgoing row is not a delivery receipt; uncertain sends are not automatically retried.
8. **No embedded model or scheduler:** the MCP host supplies the agent. Waiting for incoming events does not guarantee the host will wake a model or reply automatically.

The debugger permission is declared as required, not in `optional_permissions`. The user approved this expanded development permission for a fixture-only input probe; Chrome briefly showed its debugging indicator. Although the built extension has this powerful permission, the implemented worker command checks the exact active rich-fixture URL, refuses an existing draft, inserts fixed text, reads it back, and detaches. It has no live-site input or submit command; permission acceptance and fixture success do not authorize a Gemini send.

## 4. First Session: WSL and Browser Feasibility

### 4.1 Verify prerequisites without changing the machine

Run browser/toolchain checks in a terminal **inside the devcontainer**:

```bash
uname -sr
command -v chromium node npm
chromium --version
node --version
npm --version
printf 'DISPLAY=%s\n' "$DISPLAY"
```

No host Node/npm/Chromium setup is needed. The container's observed browser executable is `chromium`, not `chromium-browser`. WSLg is a display prerequisite supplied by the WSL host.

Check the published SDK's version, runtime requirements, and documented stdio API before installing dependencies. Use a stable release and a lockfile. If package names or protocol support differ from the design, document the verified choice; do not invent an import or write a replacement MCP protocol implementation.

### 4.2 Verify a visible browser

For development, use the dedicated Podman volume-backed browser profile outside the repository, separate from the user's everyday profile. Run inside the container:

```bash
chromium --user-data-dir="$HOME/.local/share/agent-messaging-mcp/chromium-dev" --no-first-run
```

This command creates profile data on first use. A dedicated profile is a test isolation measure, not a change to the product requirement: the final extension must also work in a user's existing browser profile after installation and approval.

Verify that the window is actually visible through WSLg, a local fixture URL loads, and the extension page can be opened. Do not add `--no-sandbox`, disable web security, export a debugger port, copy cookies, or run Chromium as root to work around a failure. Diagnose the actual failure and ask the user to perform a required OS-level action if needed.

Keep the browser, native host, and broker in the same container and OS-user context for this first milestone. Do not silently substitute Windows or WSL Chromium: either would require separate native-host registration and a different IPC boundary.

### 4.3 Load the development extension

After a minimal WXT build exists, open `chrome://extensions`, enable Developer Mode, and load the generated directory containing the built manifest, normally WXT's `.output/chrome-mv3` directory within the extension package. Verify the actual output path; do not load the TypeScript source directory.

Record the unpacked extension ID. Keep it stable across the native-messaging tests by reusing the same build location or an explicit development public manifest key. The key in an extension manifest is not a secret. Do not reuse another extension's identity or relax native-host origin checks to accommodate changing IDs.

Browser toolbar clicks, developer-mode changes, installation permission review, login, MFA, and message approvals may require the human. Browser tools attached to their own isolated page are not automatically attached to the visible WSL browser. State which action is needed rather than claiming it was done.

### 4.4 Prove the native-messaging route

Build a tiny relay that accepts one typed handshake and returns its protocol version. Register it for the exact extension ID, then call `runtime.connectNative` from the extension service worker and verify a round trip.

The normal per-user Chromium host-manifest location on Linux is under `~/.config/chromium/NativeMessagingHosts`. Verify the effective lookup for this Chromium build and chosen user-data directory, especially if the package is sandboxed or redirects configuration. Do not register under a Windows browser or guess that a host manifest belongs inside the `Default` profile directory.

Use a host name such as `com.agent_messaging_mcp.bridge` consistently. The host manifest must use an absolute path to an executable launcher and an exact `chrome-extension://<actual-extension-id>/` allowed origin. The registration helper must preview what it changes and not overwrite unrelated registrations.

**Environment detail:** the browser-spawned host may not inherit the interactive shell's PATH. Resolve the container's absolute Node executable during registration and use a launcher that invokes the built relay with that executable. Verify it without relying on shell startup files. Never write diagnostic output to native-host stdout.

The current helper builds the companion and previews changes with `npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev" --preview`. In this container, it registered for the real ID `ihgoljipfhieipbphdchlghecffbbddo`: the profile manifest allows only that origin, and its launcher is executable under `$HOME/.config/agent-messaging-mcp/native-host`. Podman's volume mount leaves `$HOME/.local/share/agent-messaging-mcp` root-owned here, so a launcher placed there failed with `EACCES`; the writable config directory avoids that. The launcher uses the absolute Node executable, and isolated subprocess tests exercise real framing and the launcher without a usable `PATH`. The user confirmed actual browser lookup and a protocol-v1 native round trip. Post-create `restore:native` recreates a missing launcher only for the exact existing profile manifest; a new profile gets no grant, and a changed manifest is rejected. `npm run unregister:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"` removes only a recognized application registration. Do not expand into a complete installer yet.

## 5. Proposed Structure and Development Commands

Create only the parts needed for the current milestone. The following is a proposed structure, not files that already exist:

```text
packages/
  core/                 shared schemas, connection/operation rules, event buffer
  companion/            MCP facade, broker, local IPC, native relay, registration
  extension/            WXT entrypoints, trusted UI, content script, adapters
tests/
  fixtures/             one controllable browser-chat fixture with layout variants
  e2e/                  browser and full-pipeline tests
```

Place unit tests next to the modules they exercise. Reuse the fixture and helpers across phases. Do not create throwaway prototypes that then require a second implementation of the same domain logic; keep experiments small enough to promote or remove deliberately.

Implement and document the following script contract as those components arrive. **`dev:fixture`, opt-in `dev:broker`, `build`, `build:companion`, `typecheck`, `test:unit`, fixture-only `test:e2e`, `build:extension`, and native registration/restore work now; the browser handshake and local/VS Code SDK diagnostic calls passed.**

| Planned command | Purpose |
| --- | --- |
| `npm run build` | Build the code units present so far |
| `npm run typecheck` | Typecheck those code units |
| `npm run test:unit` | Run unit tests once, without a watcher |
| `npm run test:e2e` | Local-fixture input and disposable-profile extension/native lifecycle tests; full MCP transcript reads are still planned. Never ordinary personal chats |
| `npm run dev:fixture` | Serve the deterministic fixture on an available loopback port |
| `npm run dev:broker` | Start the local-only private broker process explicitly for pending-only MCP tests; never a network listener and not auto-started on devcontainer creation |
| `npm run build:extension` | Build the unpacked extension and report its path |
| `npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"` | Register this development build for the selected Chromium profile after `--preview` and validating the actual ID |
| `npm run restore:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"` | Restore a missing launcher only from an existing validated profile registration; post-create runs this automatically |
| `npm run unregister:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"` | Remove only this application's registered development host |

Start with a small root workspace configuration, strict TypeScript, and a lockfile. Add dependencies when their phase needs them: SQLite is needed for durable sends, not for the first read-only handshake. Do not add a bundler framework for the companion, a task orchestrator, Docker, or a large UI framework without a concrete need.

Exclude generated builds, test reports, screenshots, browser profiles, tokens, and journals from version control as soon as those artifacts become possible. Keep actual runtime state under user-private runtime/data directories, not the repository.

## 6. Milestones and Exit Checks

Each milestone should leave a runnable, validated increment. Report progress and update this handoff after each milestone. Do not treat an external login or permission gate as permission to skip validation and build all later layers.

### Milestone 0: Feasibility, Not the Whole App

This corresponds to Phase 0 of the design. Resolve the browser and integration risks before broad scaffolding.

1. Complete the environment and visible-browser checks above.
2. Establish the smallest workspace/build needed for a fixture, an unpacked read-only extension, and a native relay.
3. Make a local fixture with a conversation identifier, message list, composer, and send button. It must contain only synthetic test data.
4. Invoke the extension on that fixture tab, display the selected origin/conversation, and complete the native handshake.
5. Use the documented existing Playwright-extension mode as a bounded automation baseline when useful. Do not depend on its private transport or install it into a personal profile without approval.
6. Probe rich-editor input and inspect a disposable Gemini conversation only with the user's permission. Any exploratory send must be explicitly approved and clearly separated from the unfinished product's write path.
7. Verify that a minimal official-SDK stdio tool works in the actual VS Code MCP host. Record the package/version/protocol combination instead of assuming the examples in the design match that client.

**Exit evidence:** Chromium version, visible GUI result, extension ID/build path, successful native handshake, actual MCP tool result, and a short record of input/real-site findings. Every item must be marked passed, failed, or waiting on an identified human action. Browser installation alone does not pass this gate.

If real-site login is unavailable, the local tests can continue; explicitly leave real-site feasibility unverified. Do not claim Gemini support or replace browser interaction with a provider API to manufacture a passing result.

### Milestone 1: Read-Only End-to-End Connection

Build the full route: MCP client -> facade -> broker -> native relay -> extension -> selected fixture conversation, with observations returning through the same route.

1. Define shared schemas for connection requests, bindings, capabilities, messages, event cursors, and domain errors.
2. Add the local broker and private IPC. Use a user-private runtime directory, restrictive permissions, authenticated process roles, and race-safe singleton startup. Never use a globally predictable socket in a world-writable directory without ownership protection.
3. Add a pending connection request flow. The request tool returns promptly with an ID; it must not hang indefinitely while the user selects a tab.
4. Implement trusted extension-side selection and approval, binding one conversation to one client. Do not grant access to every tab on the same site.
5. Implement snapshot capture, the observation buffer, bounded event waiting, health reporting, and disconnect.
6. Wire the read-only MCP tools from the design and exercise them through a real stdio client.

**Exit checks:** no chat data before approval; only the selected conversation appears; same-origin conversation switching invalidates the binding; a second client cannot reuse the first client's handles; initial messages are not mislabeled as newly received; wait can time out and be cancelled; revoke prevents subsequent reads and removes listeners without closing the tab.

### Milestone 2: Supervised Sending and Recovery

Do not add a shortcut `send_message` tool that bypasses the operation lifecycle.

1. Add SQLite operation metadata and the prepare/approve/commit/status schemas and tools.
2. Add exact-text/target review in extension-owned UI. The browser page and the model must not be able to mint approval.
3. Add the declared debugger permission with user-visible review, then implement only the input operations required by the fixture and first adapter.
4. Implement per-connection write serialization, draft detection, read-back verification, fresh conversation/generation checks, approval expiry, and one-shot dispatch.
5. Persist the dispatch-starting state before activating submit. Reconcile outgoing UI evidence separately from transport success.
6. Inject crashes and lost responses at every boundary around submission; reissue the same operation and verify that the connector never dispatches it twice.

**Exit checks:** multiline/Unicode survives; unrelated drafts remain untouched; a changed target or expired approval blocks commit; duplicate commit returns the old operation; a post-dispatch crash yields `unknown` rather than automatic resend; optimistic UI does not become a claimed delivery receipt; disconnect prevents queued writes.

Local-fixture automation may click the real extension approval UI using Playwright. It must not bypass approval by writing internal state and then count that as end-to-end approval coverage.

### Milestone 3: Gemini and Generic Calibration

1. Inspect the current Gemini browser DOM in a disposable authorized conversation. Choose scoped semantic selectors and stable observed identifiers; do not invent selectors from screenshots or earlier knowledge.
2. Implement the site adapter against the shared adapter contract. Distinguish streaming, explicit completion, and heuristic settling. Handle conversation-title changes separately from actual conversation identity changes.
3. Test the new-chat-to-saved-conversation transition before allowing it as a special case. Unrecognized identity changes must still stop writes.
4. Add a calibration picker for the timeline, message row, identity region, composer, and submit control, with optional sender/timestamp mappings and a preview.
5. Save only validated declarative profiles. Changed or ambiguous mappings require user review before writes resume.
6. Test an unfamiliar fixture layout using calibration, then validate a second real web chat when the user chooses one and authorizes the test.

**Exit checks:** the first known site works through the same MCP tools; generic calibration requires no source edit; a broken selector disables affected capabilities; two identical messages remain two messages; node recycling does not manufacture deletions; the second adapter does not require changing the broker's policy or public tool schemas.

Do not start with a catalog of many site adapters. Prove one AI-chat flow and one structurally different flow first.

### Milestone 4: Local Release Hardening

Finish reproducible Linux/WSL installation and removal, native-host diagnostics, release builds, restrictive storage permissions, restart/revocation handling, and user-facing setup instructions. Validate the installed extension in a normal supported Chromium browser separately from Playwright's test browser.

Test another intended MCP host and document the verified browser/host/version matrix. Keep untested Windows/macOS packaging, Firefox, remote HTTP, attachments, history backfill, and autonomous response loops out of the release claim.

## 7. Contracts to Make Precise During Implementation

### MCP operations

Use the tool names in the design: `chat_request_connection`, `chat_get_connection`, `chat_read_messages`, `chat_wait_for_events`, `chat_prepare_message`, `chat_commit_message`, `chat_get_operation`, and `chat_disconnect`.

Implement only the read-only subset in Milestone 1. `get_connection` resolves the pending request into current connection state. `prepare_message` creates an immutable text/target operation without changing the composer. `commit_message` executes only a still-valid approved operation; `get_operation` is how a client recovers from a lost response. Keep blocked/pending states explicit rather than encouraging the model to create another operation.

Treat connection IDs and operation IDs as identifiers, not authentication credentials. The broker authorizes every access against the authenticated caller and current grant. Declare supported protocol versions through the SDK and verify host compatibility; application connection state must not depend on a particular MCP transport's session mechanisms.

### Native and local transport

- Native Messaging is UTF-8 JSON preceded by a native-endian 32-bit byte length. MCP stdio is newline-delimited JSON. They are different transports and separate process entry points.
- Implement incremental decoding for partial headers, partial bodies, and multiple messages in one read. Count bytes, not JavaScript string characters. Reject oversized frames before allocating their advertised size.
- Validate every envelope: protocol version, request ID, permitted message kind, connection generation, deadline, and typed payload. Native-relay clients cannot impersonate MCP clients or vice versa.
- Validate browser-provided sender extension/tab/frame/document/origin metadata against the binding. A page-supplied identity field is not sufficient.
- The native relay forwards only the application protocol. No arbitrary process execution, filesystem reads, browser evaluation, or raw CDP pass-through.

### Observation semantics

Install observation before the initial snapshot, reconcile the handoff, and return a cursor representing precisely the snapshot boundary. Later events must not be lost between reading a snapshot and waiting.

Use immutable, monotonically ordered events within an observation epoch. Coalesce rapid DOM changes before publishing an event; do not rewrite an already published sequence in place. Different consumers keep independent cursors. Eviction or restart returns a gap/expired-cursor result with a resnapshot path.

Message identity and message text are separate. Preserve revisions when identity is reliable; otherwise report uncertainty. Avoid claiming an exact sender, timezone, timestamp, completion status, or service receipt the UI does not expose.

### Write semantics

Approvals bind the operation ID, client, text digest, target identity, connection generation, and expiry. They cannot survive a document/conversation change. Do not hold the writer lock while waiting for human approval or new incoming messages.

An idempotency key is client-scoped and bound to the exact request. The same key with different text/target is an error. Recovery consults the operation journal; it must not translate a network error into permission to click Send again. Keys/operation handles have an explicit retention policy, and expired handles are rejected.

Cancellation before dispatch prevents submission. After dispatch it cannot unsend the message; retain and reconcile the operation state. If filling has already occurred when an operation is stopped, report the draft state and do not clear text the human might have edited.

Suggested starting limits: one active writer, event waits capped at 20 seconds, at most 100 returned events per call, a 1,000-event/5 MiB buffer, and 256 KiB internal envelopes. Choose and test explicit message-size, approval-expiry, and journal-retention limits before enabling sends. Reject oversized outgoing text rather than silently truncating or splitting it.

## 8. Test Fixtures and Required Failure Cases

Extend one controllable local fixture instead of relying on a real service for every test. Add scenarios incrementally:

| Scenario | Required observation |
| --- | --- |
| Simple textarea and contenteditable composer | Correct text round trip; framework-specific editor fixture added when that writer is implemented |
| Incoming append and repeated identical messages | Correct boundaries and distinct identities |
| Token streaming with a long pause | Revisions preserved; pause alone does not become confirmed completion |
| Virtualized/recycled message rows | No false deletion or identity reuse |
| Same-origin conversation/account switch | Old grant and pending sends become invalid |
| User types before/during an operation | Draft preserved, operation blocked or paused |
| Slow, rejected, and optimistic sends | Honest status/evidence; no false service acceptance |
| Native relay/broker/browser failure around dispatch | Journal-based recovery; no duplicate dispatch |
| Buffer overflow, suspension, and reload | Explicit stale/gap/expired-cursor handling |
| Forged page approval and a second MCP client | Access denied without data leakage |

Use Vitest for contracts/state machines and Playwright's bundled Chromium with a persistent context for automated extension tests. Keep that test profile separate from the manually used container Chromium profile.

At least one integration test must traverse the public MCP tool -> broker -> real native framing -> extension -> fixture path. Unit mocks and direct content-script calls cannot substitute for this test. Similarly, directly invoking an action handler does not prove that a real browser user gesture granted `activeTab`; manually verify that installation/selection path when browser automation cannot exercise it faithfully.

Do not open DevTools on a tab during debugger-input acceptance without treating potential detachment as part of the test. Use separate diagnostic runs for such failures.

Once the user authorizes a live Gemini test, use a disposable conversation and an explicitly approved neutral message. The user performs login/MFA directly in the browser. Never request credentials in chat, capture authentication screenshots for reports, export the profile, or store personal transcripts as fixtures.

## 9. How to Work and Leave the Next Handoff

For each change: identify the owning module, make a small edit, run the cheapest relevant check immediately, and then continue. Prefer a narrow state-machine or browser-fixture test over running the entire suite for every edit. Do not leave a failed focused test unresolved while adding another feature.

Distinguish planned commands from commands that actually ran. For every milestone, record the command, exit status, and relevant result. A browser page loading is not a message-send test; a mocked native relay is not a real native-host installation test. Do not present missing human interaction as a passing automated check.

If blocked, report the exact boundary: unavailable GUI, extension permission, host registration, SDK compatibility, site login, changed DOM, or ambiguous send evidence. State the one user action or experiment needed to continue. Do not replace the architecture or weaken permissions silently.

After each completed milestone, update the status below and the setup documentation with actual build paths, executable names, tested versions, and runnable commands. Keep tokens, transcript text, account identifiers, and profile contents out of that record.

### Current Milestone Status

- [x] Product design and implementation handoff written.
- [x] Rootless Podman devcontainer started with Node/npm and Chromium installed inside it; fixture and WXT checks passed inside.
- [x] Container X11 socket access and Windows access to the container fixture on loopback verified; browser profile volume writable.
- [x] VS Code agent tools run in the container; user visually confirmed container Chromium's fixture window on Windows.
- [x] Handshake-only native host, non-overwriting registration and restore helpers, and service worker build; post-create `npm ci && npm run build && npm run restore:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"` passed in the running container.
- [x] Load the extension in container Chromium; ID `ihgoljipfhieipbphdchlghecffbbddo`.
- [x] Register a native host for that ID in the development Chromium profile; manifest and launcher are owner-private.
- [x] User invoked the popup on the selected fixture tab: it showed `fixture-alpha`, both rendered messages, and `Native bridge ready (protocol v1). Nothing was sent.` The native host manifest was found in the development Chromium profile.
- [x] Official `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.1.0 with Zod 4.6.5: a local SDK stdio client discovered and called the diagnostic-only tool. The SDK documents MCP `2026-07-28` support; the actual VS Code negotiated protocol version was not observed.
- [x] In VS Code Chat, `browser_chat_feasibility` was invoked through the workspace [`.vscode/mcp.json`](.vscode/mcp.json) and returned `MCP stdio diagnostic OK. No browser data was read or sent.` This proves a VS Code host tool call, not chat access.
- [x] `npm run test:e2e` passed one fixture-only Chromium test: synthetic `InputEvent` did not update the contenteditable editor's state; browser-generated input submitted multiline Unicode text; the textarea still worked. `npm ci`, build, native restore, typecheck, and all nine unit tests also passed. This does not prove debugger input, an extension send, or Gemini compatibility.
- [x] User-approved fixture-only extension debugger probe in container Chromium: the popup reported `Fixture input read back (24 characters). Send was not clicked.` Chromium briefly showed its debugging indicator. The worker accepts no agent-supplied text or selector, checks the selected rich fixture and empty draft, and detaches after read-back. This is not a message submission or a Gemini editor test.
- [x] Separately approved Gemini fill-only experiment in the selected disposable chat: the trusted popup showed the exact fixed text; the worker checked the active tab, unchanged conversation URL, unique timeline, and empty labeled editor before `Input.insertText`. The popup reported an 87-character read-back match, and the user showed the matching unsent draft in the Gemini composer. Chrome's debugger indicator appeared during the experiment. No submit command exists; a matching draft is not service acceptance or delivery.
- [x] User-approved read-only Gemini probe on a disposable chat: one visible `infinite-scroller` contained distinct `user-query` and `model-response` rows. The user verified `user-query-content p.query-text-line` excludes neighboring UI/screen-reader wording and that `model-response-content` matched the rendered reply. The popup now returns only bounded row lengths and structure; no transcript, account details, or draft was stored. This establishes a single observed UI variant, not a production adapter.
- [x] The user pastes the whole extension popup when asked for test output. Keep diagnostic output safe to share verbatim: no message text, drafts, raw URLs/conversation IDs, or arbitrary page-provided labels. The current Gemini probe returns fixed structural labels, route depth, and row character counts only.
- [x] VS Code **Rebuild Container** verified: new container retained the named Chromium profile and extension ID, built companion/extension, and restored the exact-origin native launcher (`700`) and manifest (`600`). After rebuilding, `npm run build`, `npm run typecheck`, `npm run test:unit` (9 passed), and `npm run test:e2e` (1 passed) succeeded. VS Code Chat called `browser_chat_feasibility` successfully; the user saw the reopened Chromium fixture and confirmed a fresh `Native bridge ready (protocol v1)` popup and a 24-character rich-fixture debugger read-back without clicking Send. A debugging indicator was visible in the screenshot. No real chat, Gemini login, or unsent draft persistence was verified after rebuild.
- [x] After rebuilding, the user opened a new disposable Gemini conversation and manually sent a greeting. The read-only popup again found one candidate timeline and distinct three-character user and 35-character model rows. This tests the observed selector shape on a new chat; it does not prove that the old anonymous conversation or draft persisted, or that the connector can submit messages.
- [x] Milestone 1 pending-request foundation: the companion mints UUIDs, caps active requests at 100, reports expiry after 60 seconds, and retains expired status for one more minute. Real official-SDK clients now use distinct owner-bound facade sockets to create/query only pending/expired/unknown states; no tab can be selected or read yet.
- [x] Local IPC foundation: an opt-in broker process atomically owns a `0700` runtime directory with `0600` Unix socket and separate `0600` facade/relay keys. Strict bounded role hellos, per-socket owners, malformed/oversized frame rejection, singleton collision, and process cleanup were tested. An authenticated facade client can request/query pending state; a second client sees `unknown`, a relay gets `PERMISSION_DENIED`. The native host now forwards only a strict `list_pending` request through the authenticated relay role, returning unexpired IDs/deadlines without client owners, tab data, or messages. A real facade -> broker -> native-frame subprocess test passed; the extension has no broker approval or snapshot route. Post-create builds the broker but does not start it.
- [x] In container Chromium, the user clicked **View pending requests** on the selected local fixture tab. With no request it displayed an empty list; after `chat.request_connection` in VS Code it showed the same unexpired ID and remaining seconds through the extension -> native host -> authenticated broker relay. The popup showed no client owner, tab, transcript, or approval, and returned `No connection approved or chat data read.` The user may paste the entire diagnostic popup. This is not a connection grant.
- [x] Broker-side fixture grant contract: only an authenticated relay IPC role can approve an unexpired pending request bound to `http://127.0.0.1:8787`, `fixture-alpha`, one tab, and one browser document. The grant is one-shot and produces an owner-only `ready_readonly` connection ID with five-minute expiry; a second facade still sees `unknown`, and tab/document IDs are not returned in MCP state. A strict native `approve_fixture` frame forwards that target through the relay; a real subprocess test proved one approval and replay rejection. Chromium supplies an opaque 32-character document ID in this tested browser, not necessarily a UUID. Broker revocation on tab/document/conversation change now produces owner-visible `stale` without a handle, and a strict native `revoke_fixture` frame passed a real subprocess test. The extension does not yet emit lifecycle notifications; snapshots and message-read tools remain unimplemented.
- [x] The first trusted **Approve read-only fixture** click reported approval, but the owning VS Code `chat.get_connection` returned `BROKER_UNAVAILABLE`, then `unknown`: its running MCP process predated the `ready_readonly` parser. After restarting `browserChatFeasibility`, the user approved a fresh fixture request and this host returned `ready_readonly`, a broker-minted connection ID, generation 1, and only fixture origin/conversation metadata. No tab/document ID or chat message was returned. This verifies the user-gesture approval and owner-state route, not document-change revocation or an authorized transcript read.
- [x] `npm run test:e2e` now loads the unpacked MV3 extension, service worker, and popup in a disposable Playwright Core Chromium profile and completes a correlated Native Messaging handshake with a test-only exact-ID registration. It never reuses the manually used browser profile or Gemini login. This automated transport check does **not** prove the real toolbar `activeTab` gesture or trusted approval click; those still require manual verification until tested faithfully.
- [x] The opt-in broker was started in the current devcontainer with `npm run dev:broker`; the live directory is `0700` and socket/role keys are `0600`. After VS Code refreshed the tools, `chat.request_connection` returned only a pending request ID and expiry, and `chat.get_connection` returned that same pending state for the current host client. No browser tab, transcript, or approved connection handle was returned; the pending request expires automatically.
- [x] After the broker's terminal ended abruptly, its private directory, keys, and socket remained but the socket refused connections (`ECONNREFUSED`). A tested broker startup now recovers only its own exact owner-private dead runtime using a refused socket probe and atomic quarantine rename; live brokers and unfamiliar files are left untouched. The real runtime restarted, rotated its role keys, retained `0700`/`0600` permissions, and accepted a facade handshake without creating a request. Seventeen companion tests passed, including SIGKILL/restart and foreign-file refusal. Browser and fixture processes were not restarted for this recovery check.
- [x] An internal broker-owned observation buffer now uses a fresh epoch and monotonically ordered immutable JSON events, independent read cursors, a 1,000-event/5 MiB cap, 256 KiB single-event cap, and at most 100 results per read. Epoch changes or count/UTF-8-byte eviction return an explicit expired cursor requiring resnapshot; repeated identical text still yields distinct sequences. Twenty-one companion tests passed. The buffer is in memory only and is not yet fed by the extension or exposed via authorized MCP reads; the snapshot-to-event handoff and wait/cancellation are still unimplemented.
- [x] The extension declares required `storage` permission and records only approved fixture tab/document IDs and expiry in memory-only `storage.session`, surviving MV3 worker suspension. In container Chromium, the user approved one fixture request, this VS Code MCP client received `ready_readonly`, then the user reloaded that fixture tab; `chat.get_connection` returned only `stale` with no handle. This verifies the tab-reload lifecycle signal through extension -> native relay -> broker -> owner. The separate restart/tab-close checks below use disposable automation, not this manual toolbar approval.
- [x] The synthetic fixture's same-document **Switch chat** changes its conversation ID and rendered rows without changing URL (isolated Playwright test passed). After a second trusted fixture approval, a document-scoped extension observer signaled the in-place identity change using browser-supplied sender tab/document/frame metadata. The owning VS Code MCP client first received `ready_readonly`, then `stale` with no handle after the user clicked **Switch chat** once. This verifies fixture-specific same-origin conversation revocation, not generic Gemini routing or transcript access.
- [x] A strict empty-payload native `revoke_all_fixture` frame is relay-only in the authenticated broker and revokes every fixture grant without deleting pending requests. The extension records an acknowledged reset in `storage.session` per extension/browser instance; a failed reset blocks fixture listing/approval and retries, while an ordinary MV3 worker wake reuses the marker. Companion tests cover schema rejection, facade denial, real broker IPC, and a spawned native host. An isolated Playwright profile installed the extension in developer mode and, with a real broker, confirmed a stopped/woken worker retains `ready_readonly`, extension reload and browser restart each make a seeded grant `stale`, and closing a session-tracked test tab revokes its seeded grant. The test does not exercise a real toolbar `activeTab` approval or the manually used browser profile.
- [x] Fixture-only snapshots now flow through a strict relay-only native `publish_fixture_snapshot` frame into bounded, cursor-anchored per-grant memory. The trusted background worker installs a document-scoped message observer before capture and publishes only exact-document `fixture-alpha` rows; capture/publication failure during approval revokes the grant. The official SDK `chat.read_messages` tool returns cached rendered-only rows with `capturedAt`, generation, cursor, and omission status only to the owning connection; other clients, pending grants, and revoked handles get no rows. Companion IPC/native subprocess tests and isolated Playwright DOM tests pass. Programmatic `chrome.action.openPopup()` did not grant `activeTab` in this Chromium profile, so the new extension approval-to-MCP-read path still needs an actual toolbar gesture. Cached reads do not prove current tab identity at each call and must not be enabled for Gemini until live revalidation is built.
- [x] A follow-up replaced cache-only fixture reads with a four-second owner-bound broker challenge. The authenticated native relay exposes only bounded challenge IDs and exact fixture targets; the extension polls while a session-tracked grant exists, retargets Chrome's document, and publishes fresh rows with the matching one-shot challenge ID. Timeout, revocation, disconnect, replay, wrong document, and missing `activeTab` return no text. A 30-second cache-age cutoff remains as defense in depth. Unit, real broker/native/MCP SDK, and isolated Chromium negative tests pass; the positive real toolbar approval-to-read route still needs a human check. This remains fixture-only, with no event-wait tool or Gemini adapter.
- [x] In the installed container Chromium, the user approved one fresh fixture request through the real toolbar popup; the owning VS Code MCP client returned `ready_readonly`, then two successive `chat.read_messages` calls returned exactly the two synthetic `fixture-alpha` rows with `rendered_only` coverage and advancing cursor sequences 2 and 3. After the user clicked the fixture's **Switch chat**, `chat.get_connection` returned `stale` and another read returned `CONNECTION_NOT_FOUND` without rows. This verifies the positive browser-to-native-to-broker-to-MCP read and same-document revocation route, not Gemini, event waiting, or message sending.
- [x] The fixture-only `chat.wait_for_events` uses the snapshot cursor and owner-bound broker buffer, returning at most two full-snapshot events per call after a bounded 20-second wait. Empty timeouts, later updates, second-client denial, revocation, wrong-epoch `CURSOR_EXPIRED` with a resnapshot path, and an actual official SDK AbortSignal followed by another successful call passed local tests. The fixture mutation-to-MCP wait is not yet verified through the installed browser toolbar, and this is not a generic site event adapter.
- [x] With a new real toolbar-approved fixture grant, the owning VS Code MCP client read the two synthetic initial rows and received cursor sequence 2. The user then sent exactly `Fixture event probe` using the local fixture's own composer. `chat.wait_for_events` returned `timedOut: false`, sequence 3, and one `fixture_snapshot` event containing the current three rendered rows, including outgoing `fixture-3` with that exact synthetic text. This is end-to-end fixture observation, not a Gemini send or evidence that every row in the event is newly received.
- [x] A subsequent fixture-only `chat.disconnect` revokes only the owner's broker grant, cancels pending reads, and makes later reads return no rows without closing the tab. The extension's authenticated native watch now receives only active fixture tab IDs, clears disconnected session records, and disconnects document observers when Chrome still permits exact-document injection. Companion unit/SDK/socket tests and an isolated Chromium test with the tab left open pass; a toolbar-approved installed-profile disconnect has not yet been exercised. The broker also suppresses events for unchanged snapshots while refreshing their capture timestamp, so the earlier manually observed sequence 2-to-3 on two identical reads is historical, not the expected behavior of this newer build.
- [x] `chat.get_connection` now returns `observation: { state, capturedAt }` only for an owner's ready fixture grant: `not_observed` before a snapshot, `recent` within 30 seconds, or `old` afterward. Deterministic unit and real SDK tests pass; foreign clients still see `unknown`, and stale grants contain no observation metadata. This describes broker snapshot age only, not browser connectivity or AI response completion.
- [x] On an ordinary MV3 worker wake with a session-tracked fixture grant, the extension now sends a strict exact-target Native Messaging gap frame before resuming its native read watch. The broker keeps the owner-approved grant but clears old snapshots, rotates its observation epoch, expires prior cursors, and cancels in-flight reads. A repeated gap mark on an already-empty epoch is a no-op so it cannot cancel a newer read without an earlier cursor to protect. Relay-only role checks, spawned native/broker tests, and a disposable Chromium service-worker stop/wake test passed; the watcher still denies unapproved-tab reads and preserves reload/tab-close/disconnect behavior. This reports a possible observation gap, not continuous browser liveness or a Gemini adapter.
- [x] For one user-selected disposable Gemini conversation, a structure-only toolbar diagnostic found one candidate timeline and two bounded row lengths; a separate synthetic Playwright test validated a reviewed read-only parser and an identity-only exact-URL selector without accessing live text through MCP. The broker now approves one saved Gemini URL/tab/document for only its pending-request owner, while fixture read APIs deny that handle. Strict `approve_gemini` broker/native frames and a spawned-host replay test pass. The trusted popup has a separate **Approve read-only Gemini chat** command that checks the active tab and Chrome document before and after approval; a text-free document observer, tab close, and extension reload revoke seeded Gemini grants. Build, typecheck, 45 unit tests, and five isolated Chromium tests passed. This new Gemini approval route has NOT yet passed a real toolbar click and exposes no Gemini transcript or send tool.
- [x] On the actual selected disposable Gemini tab, the structure-only popup reported **Approval route: query present** and therefore hid **View pending requests**; no approval occurred. The exact-target policy now permits a canonical saved-chat URL with a query within the existing 512-character bound, but still rejects fragments, credentials, changed routes, and oversized URLs. The trusted popup reports only a sanitized eligibility label, never query values; browser identity and route observation preserve the full URL for exact-document checks. Focused broker, native, and synthetic Chromium tests pass. Reloading the installed extension and rechecking visibility/approval remain separate human gates; there is still no Gemini MCP text read or send tool.
- [x] After reloading the installed extension, the user saw **Eligible saved-chat URL (query bound exactly)** and **View pending requests** on the same selected disposable Gemini conversation. A fresh real-toolbar **Approve read-only Gemini chat** click returned owner-visible `ready_readonly` through VS Code MCP with generation 1, Gemini origin, and `observation: not_observed`; the owning `chat.disconnect` returned `disconnected: true` and subsequent lookup returned `stale`. No Gemini message text, full URL, browser tab/document ID, draft, or send result was returned through MCP. This verifies only exact selected-chat authorization and revocation, not Gemini transcript access or completion semantics.
- [x] A broker-internal `getGeminiTarget` resolves the exact saved-chat URL/tab/document only for its live MCP owner; fixture, pending, foreign, expired, and revoked handles cannot resolve it. A separate bounded in-memory Gemini snapshot store accepts only exact-target synthetic direction/text rows, preserves duplicates, labels identity `uncertain` and generation state `unknown`, and clears text on revocation. Strict relay-only broker/native `publish_gemini_snapshot` frames pass synthetic process tests: the reply is count-only and a revoked grant rejects replay. The extension does not invoke this frame; no Gemini MCP text tool or live browser capture is wired.
- [x] A separate four-second Gemini read challenge binds one live owner to the exact approved URL/tab/document. Broker role tests, a spawned Unix broker, and a browser-spawned native-host subprocess passed with synthetic rows: a changed query or document cannot complete the one-shot challenge, another facade is denied, timeout and revocation cancel it, and the reply omits URL/browser IDs. Strict native polling returns only challenge metadata; a second synthetic native publication with the matching one-shot ID completes the private facade read. The extension does not request or answer Gemini challenges; no public MCP Gemini text tool or live-chat text read exists.
- [x] The existing `chat.read_messages` now lets the broker route by an owner-approved fixture or Gemini grant, with no model-supplied provider or URL. The trusted worker polls Gemini challenges only for a stored exact URL/document and calls the bounded reviewed parser only on that challenged read; native publication returns a count, while the owner receives rendered-only rows labeled `identityQuality: uncertain` and `generationState: unknown`. A disposable Chromium test copied the extension and granted host access **only to that test copy**, served a synthetic Gemini page, excluded its draft, returned two synthetic rows through the broker, then verified disconnect clears tracking without closing the tab. Another isolated test verifies that a seeded but unapproved non-Gemini document returns no rows and revokes the grant. This does not simulate the browser's toolbar `activeTab` grant or verify any selected live Gemini text read.
- [x] After VS Code MCP tool names were changed to underscores and the extension/browser were restarted, the selected disposable Gemini tab reported one timeline and two bounded read-shape rows. The user explicitly authorized read-only rendered text for that selected chat and clicked the real toolbar **Approve read-only Gemini chat** action for a fresh pending ID. The owning `chat_get_connection` returned `ready_readonly` for Gemini with no URL or tab/document ID; one `chat_read_messages` call returned exactly two currently visible rows, labeled identity `uncertain` and generation `unknown`, with `rendered_only` coverage. The owning `chat_disconnect` returned `disconnected: true`, and `chat_get_connection` then returned `stale`. Do not copy that chat text or full URL into documentation. This proves one live read-only variant, not complete history, reliable row identity/completion, generic Gemini support, or sending.
- [x] A provider-routed `chat_wait_for_events` now reads owner-bound Gemini snapshot events from the same cursor returned by `chat_read_messages`. Broker/SDK tests reject second-client, changed-URL, wrong-epoch, and revoked handles; a 200 ms throttled, exact-URL timeline observer sends only a fixed mutation signal to the trusted extension worker. A disposable Chromium test-copy extension with synthetic Gemini host access captured a mocked later model-response edit, published a bounded full rendered snapshot through Native Messaging, and returned one later event with no draft text. The installed real Gemini tab was not used for this mutation test; no real-site send or live Gemini event wait has been authorized or verified.
- [x] On an ordinary MV3 worker wake with a session-tracked Gemini grant, the extension now sends a strict relay-only exact-URL/tab/document gap frame before resuming native polling. The broker preserves the owner-approved grant, clears its old Gemini snapshot, rotates the cursor epoch, and cancels any read spanning the gap; a repeated mark on an empty epoch is a no-op. Broker/native subprocess tests and a disposable Chromium test-copy worker stop/wake pass: an old cursor expires and a fresh challenged read returns the mocked rows in a new epoch. The installed Gemini chat was not used to test wake continuity, and this is not continuous presence reporting.
- [ ] The user authorized one manually sent benign prompt in the same disposable Gemini chat after a fresh real-toolbar approval and two-row `chat_read_messages` snapshot. `chat_wait_for_events` returned `CONNECTION_NOT_FOUND`; `chat_get_connection` confirmed the grant was `stale`, so no further read or automatic resend was attempted. The structure-only popup later reported one eligible saved-chat route, one timeline, and four bounded rows, but the exact old/new URL values were not inspected. A transient empty model-response row could have caused the passive parser to reject the intermediate snapshot, or the exact URL may have changed, in which case revocation was correct. The reviewed parser now skips only an empty model-response text row while keeping visible user rows; a disposable extension/browser test verifies empty-to-filled streaming publishes two later events without revoking. This is a synthetic fix, not proof of the real failure's cause. Any new live event trial needs fresh exact-chat approval and separately authorized human sending.
- [x] A follow-up adds a short-lived, text-free Gemini revocation diagnostic in extension `storage.session`, keyed only by browser tab ID: `target_changed` for a URL/document that is unavailable, or `observation_unavailable` when the saved URL/document still matches but publication cannot complete. Only the first recent cause is retained until the next approval; the structure-only popup displays a fixed label and no URL, document ID, or row text. Isolated Chromium tests cover denied exact-document reads and ambiguous synthetic timelines, including safe popup rendering. The earlier live event failure predated this diagnostic; no cause has been established for that attempt, and the diagnostic has not been exercised on the installed Gemini chat.
- [x] A human pause exposed a stale cached facade socket after the private broker's 150-second idle timeout: the first `chat_request_connection` returned `BROKER_UNAVAILABLE`, while the second reconnected. The broker client now exposes its closed-socket state, and the running MCP facade reopens a closed broker client before the first subsequent request. An official SDK subprocess test stops and restarts the broker while keeping the same MCP client alive; its first new request succeeds. Broker restart still invalidates old owner grants and does not revive them.
- [ ] The native-host fixture subprocess test intermittently rejects a framed request with a deadline reported about 103 seconds old despite a roughly one-second test duration. A parent/child clock comparison showed no steady skew; the native suite failed once in isolation, then passed, and a normal parallel unit rerun passed 48/48. A test-only assertion now reports the parent-side deadline delta if fixture publication fails again. The root cause is unresolved; do not weaken production expiry checks or claim deterministic reliability from the passing rerun.
- [ ] Milestone 0: browser GUI, extension, native handshake, VS Code MCP, local editor input, and one real-site read plus fill-only probe passed; live-site submission feasibility remains unverified and requires separate approval.
- [ ] Milestone 1: authorized read-only pipeline verified end to end.
- [ ] Milestone 2: supervised sends and crash/retry safety verified.
- [ ] Milestone 3: Gemini and generic calibration verified.
- [ ] Milestone 4: documented local release and supported-host matrix verified.

Next action: use the new text-free diagnostic only in a separately authorized live Gemini event trial, then harden continuous browser presence and Gemini identity/completion semantics before claiming robust real-site support. The first disposable Gemini rendered-text read and immediate revocation passed; live Gemini event delivery failed closed, and the empty-row fix and revocation categories are synthetic-tested only. Fixture read, switch, and message events remain manually verified. Any Gemini send by the connector still needs separate approval; the existing command only fills a draft, never clicks Send. Do not auto-retry uncertain sends or treat optimistic UI as delivery. The negotiated VS Code protocol version was not observed.