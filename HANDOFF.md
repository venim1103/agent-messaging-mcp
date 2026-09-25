# Implementation Handoff

Updated: 2026-09-25.

This document tells the next AI how to turn [DESIGN.md](DESIGN.md) into a working implementation. The design explains the architecture and tradeoffs; this handoff supplies the work order, concrete deliverables, and checks. **The fixture popup read the selected chat and completed a native handshake in Chromium. A diagnostic-only official-SDK MCP stdio tool passed both a local client test and an actual VS Code host call; the broker and chat MCP integration do not exist yet.** VS Code tool executions run in the Podman devcontainer, and the user confirmed that its Chromium fixture window is visible on Windows.

## 1. Start Here

Read this document and [DESIGN.md](DESIGN.md), then inspect the current worktree before changing anything. Preserve any work added after this handoff. Do not spend another session redesigning the system unless a focused experiment disproves an important assumption.

Suggested request for the next AI when the user is ready to start:

> Read [HANDOFF.md](HANDOFF.md) and [DESIGN.md](DESIGN.md). Continue Milestone 0 in the Podman devcontainer: the selected-fixture popup and native handshake passed in Chromium, and the official-SDK diagnostic tool passed both a local stdio client call and a VS Code MCP host call. Plan a bounded rich-editor experiment; request permission before any real Gemini conversation or send. Keep the browser-chat scope and safety constraints. Report exact checks and human actions; do not implement every phase in one large change.

### What the user actually wants

An agent using MCP can read and send messages in **a browser chat conversation explicitly selected by the user**. The chat might be Gemini, WhatsApp Web, or another website. The user should be able to open the chat normally, keep their existing login, and connect it using an extension action.

Gemini is a convenient first AI-chat test target, not a requirement to integrate with Google's API. LM Studio was only an earlier example. Do not build an LM Studio integration, terminal chat client, native desktop automation tool, or unrestricted browser MCP server.

The eventual generic behavior comes from a shared chat model plus reviewed site adapters and a user-calibrated DOM profile. It does not mean every website can be supported without configuration or maintenance.

## 2. Current State and Environment

| Item | Status at handoff |
| --- | --- |
| Repository | Fixture server, WXT popup/background, and a handshake-only TypeScript native host with a verified browser handshake; diagnostic-only MCP stdio tool called through a local client and VS Code Chat, but no broker or chat MCP tools |
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
| Rich-editor probe | `playwright-core` `1.63.0` used the container's `/usr/bin/chromium` headlessly with sandboxing intact; `npm run test:e2e` passed for the synthetic `?editor=rich` and existing textarea variants. No extension write path or live-site editor was tested |
| Container network | Fixture listens on port 8787 inside the container. No fixed WSL host port is published; VS Code can forward it for optional Windows preview |
| Browser profile | Podman volume `agent-messaging-mcp-chromium-profile` is mounted at the container's development profile path; confirmed writable by UID 1000, but no login persistence across a second rebuild has been tested |
| Live integration | A user-approved read-only probe of one disposable Gemini chat found separate user/model rows and the visible prompt editor; the user confirmed the scoped user line and model response matched that chat. No persistent connection, generation handling, real-site send, or supported Gemini adapter exists |

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

Both commands stay running. The browser process uses the container's profile volume and WSLg's X11 socket; its fixture window has been visually confirmed on Windows. Use `npm run build:extension` inside the container, then in that **container Chromium**, visit `chrome://extensions` and load `/workspaces/agent-messaging-mcp/packages/extension/.output/chrome-mv3`. The popup inspects only the fixture origin `http://127.0.0.1:8787`, requires the browser toolbar gesture, shows its origin/conversation and rendered messages, and attempts a native handshake. It does not persist a grant or send anything. Browsers already open on Windows/WSL are separate; the extension cannot attach to their tabs or use their logins. Log in manually in the container Chromium for any later authorized live-site test.

The handshake-only native host and registration helper run in the container, and the browser handshake passed. The future broker and chat MCP facade must also live in **the same container as Chromium**. The extension build is in the mounted workspace. Its native host is registered for extension ID `ihgoljipfhieipbphdchlghecffbbddo`; post-create restores its launcher if the profile volume retains the matching manifest. If the manifest is lost, explicitly register again after validating the ID. The forwarded **fixture** port is not a browser-control interface. Do not mount any external browser profile or expose CDP.

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

The debugger permission must be declared as a required permission when adding debugger-based input. Do not attempt to request it through `optional_permissions`. A read-only prototype may omit it; the user must explicitly accept the expanded permissions before testing the write-capable build.

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

Implement and document the following script contract as those components arrive. **`dev:fixture`, `build`, `build:companion`, `typecheck`, `test:unit`, fixture-only `test:e2e`, `build:extension`, and native registration/restore work now; the browser handshake and local/VS Code SDK diagnostic calls passed.**

| Planned command | Purpose |
| --- | --- |
| `npm run build` | Build the code units present so far |
| `npm run typecheck` | Typecheck those code units |
| `npm run test:unit` | Run unit tests once, without a watcher |
| `npm run test:e2e` | Currently one local-fixture rich-editor/textarea Chromium test; full MCP-to-browser integration tests are still planned. Never ordinary personal chats |
| `npm run dev:fixture` | Serve the deterministic fixture on an available loopback port |
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

Use the tool names in the design: `chat.request_connection`, `chat.get_connection`, `chat.read_messages`, `chat.wait_for_events`, `chat.prepare_message`, `chat.commit_message`, `chat.get_operation`, and `chat.disconnect`.

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
- [x] User-approved read-only Gemini probe on a disposable chat: one visible `infinite-scroller` contained distinct `user-query` and `model-response` rows. The user verified `user-query-content p.query-text-line` excludes neighboring UI/screen-reader wording and that `model-response-content` matched the rendered reply. The popup now returns only bounded row lengths and structure; no transcript, account details, or draft was stored. This establishes a single observed UI variant, not a production adapter.
- [x] The user pastes the whole extension popup when asked for test output. Keep diagnostic output safe to share verbatim: no message text, drafts, raw URLs/conversation IDs, or arbitrary page-provided labels. The current Gemini probe returns fixed structural labels, route depth, and row character counts only.
- [ ] Milestone 0: browser GUI, extension, native handshake, VS Code MCP, local editor input, and one real-site read probe passed; live-site input/submission feasibility remains unverified and requires separate approval.
- [ ] Milestone 1: authorized read-only pipeline verified end to end.
- [ ] Milestone 2: supervised sends and crash/retry safety verified.
- [ ] Milestone 3: Gemini and generic calibration verified.
- [ ] Milestone 4: documented local release and supported-host matrix verified.

Next action: discuss the permission and input-driver tradeoff before a single supervised exploratory Gemini send in the same disposable conversation. Get explicit approval of the exact neutral text and any expanded browser permissions first; do not use synthetic event submission or present a manual user send as an agent-driven input test. The MCP diagnostic and read-only popup are not a chat connector. The negotiated VS Code protocol version was not observed.