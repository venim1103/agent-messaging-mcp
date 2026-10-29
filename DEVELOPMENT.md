# Browser Chat MCP: Development Reference

Reusable setup, operating instructions, tool contracts and code map for people and coding agents working on this repository.

- Current status, evidence, review findings and the next step: the dashboard at the top of [HANDOFF.md](HANDOFF.md).
- Target experience, architecture, design rationale and decisions D1-D13: [DESIGN.md](DESIGN.md), sections 2 and 17.
- Workflow and safety rules: [AGENTS.md](AGENTS.md). Public introduction: [README.md](README.md).

Dated test reports that used to fill this file were removed in the 2026-10-09 review. HANDOFF.md keeps that evidence, and the previous text is available with `git show 002d600:DEVELOPMENT.md`.

> **Experimental.** The local fixture supports reads, events and supervised fill and send. Public autonomous reads/sends and reply waiting are implemented with synthetic coverage for the fixture and selected saved Gemini chats. Live use remains experimental; consult HANDOFF.md for installed evidence and limits. Never connect personal conversations.

The decided target is one **Connect this chat** approval per agent, after which each approved agent chats on its own until its connection ends. Several agents may share a chat (DESIGN.md sections 2 and 17). Popup-first admission, owned pickup, no-expiry grants, exact same-chat reload and autonomous sending are implemented and synthetic-tested. Implementation and synthetic coverage do not substitute for installed/live acceptance; see HANDOFF.md for current evidence.

## Architecture in Brief

```text
MCP host <-> stdio facade <-> private Unix-socket broker <-> native relay <-> extension worker <-> selected tab
```

| Component | Entry point | Started by | Responsibility |
| --- | --- | --- | --- |
| MCP facade | `packages/companion/dist/mcp-stdio.js` | The MCP host, via [.vscode/mcp.json](.vscode/mcp.json) | Public tools; connects to the broker in the `facade` role; each process is one owner |
| Broker | `packages/companion/dist/broker-process.js` | MCP facade on demand; `npm run dev:broker` for foreground debugging | Grants, operation ledger, observation buffers, deadlines and role checks |
| Native relay | `packages/companion/dist/native-relay.js`, through a launcher | Chromium, once per `connectNative` port | Validates and forwards frames in the `relay` role; no chat logic |
| Extension | `packages/extension/.output/chrome-mv3` | Loaded unpacked in container Chromium | Trusted popup, service worker and injected page functions |

There is no network control listener, CDP bridge, model-supplied selector or provider API key. The broker routes every request through the caller's owned grant, never through a model-supplied URL or provider name.

Private state, never committed:

- `~/.config/agent-messaging-mcp/broker/` (mode 0700) holds `broker.sock`, `facade.key` and `relay.key`. They are recreated on every broker start, so a broker restart ends all grants, consents and in-memory drafts.
- `~/.config/agent-messaging-mcp/operations.sqlite` (0600) holds operation metadata, keyed digests, dispatch intents and receipt hashes, never message text.
- `~/.config/agent-messaging-mcp/native-host` is the native launcher script.
- `~/.local/share/agent-messaging-mcp/chromium-dev` is the Chromium profile (a Podman volume) with logins and the native host manifest. Treat it as sensitive.

New dispatch attempts carry a conversation HMAC under a persistent 32-byte key in the private database. Unresolved attempts block new intents and fills in that chat for every owner, including after restart, not unrelated chats. Old unkeyed attempts retain global blocking. Missing/corrupt keys with keyed attempts fail startup; do not delete or regenerate the key/database to bypass uncertainty. The ledger supports immutable attributed resolution/status through the trusted selected-chat popup controls and bounded autonomous page-sent/not-sent reconciliation described below.

`BROWSER_CHAT_MAX_SENDS_PER_HOUR` sets the broker's positive safe-integer limit (default 60). Restart the broker to change it; this ends current grants. All keyed journal attempts count within the rolling hour for that conversation across owners/restarts, including evidenced attempts; future timestamps remain counted after a backward clock shift. Fill admission and durable intent insertion refuse at the limit without restoring or consuming extra authority. Invalid configuration fails startup. No MCP argument can configure the limit.

## Setup

Everything runs inside the Podman devcontainer ([devcontainer.json](.devcontainer/devcontainer.json)): Chromium, the extension, the native host, the broker and the MCP facade. Browsers on the Windows or WSL host cannot be used, and their tabs and logins are not reachable. Port 8787 is forwarded only for optional viewing of the fixture.

1. Open the repository in the devcontainer. Post-create runs `npm ci && npm run build && npm run restore:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"`. For an existing checkout, run `npm ci` and `npm run build`.
2. For fixture development, start the fixture in a terminal; it keeps running:

   ```bash
   npm run dev:fixture
   ```

   The fixture serves `http://127.0.0.1:8787/` (textarea) and `http://127.0.0.1:8787/?editor=rich` (contenteditable). Its **Switch chat** button changes the conversation in place. Gemini development does not need this fixture server.

   Starting the MCP facade also connects it to the broker. If the runtime is missing or its socket refuses, the facade makes at most one detached broker-start attempt and checks readiness within a five-second absolute startup budget. The child uses ignored stdio, never MCP stdout. Private directory/key/socket ownership, modes and authenticated role checks remain mandatory; unsafe runtimes or failed authentication do not trigger a replacement. Concurrent facades share the broker but keep separate owners; a detached broker stays running when a facade exits.

   A broker must atomically claim its private runtime directory before initializing the operation ledger. A losing starter must not create tables or recover the running broker's persisted attempts. Ledger initialization failure removes the newly claimed runtime without publishing a socket; it does not change SQLite locking, security checks or startup deadlines.

   The startup budget clips only authentication, not the persistent facade's later requests or keepalive. The private connector's separate upstream deadline still clips every request made by a short-lived native relay. Neither deadline grants or renews chat authority.

   `npm run dev:broker` remains available for foreground debugging (stop with Ctrl+C). It refuses a second instance (`Broker is already running`) and recovers only its own dead runtime. Set `BROWSER_CHAT_AUTO_START_BROKER=0` in the MCP process environment to disable eager connection and auto-start for tests/manual debugging; tool calls then connect lazily to an already running broker.
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
   - `chat_request_connection` returns a pending request. `BROKER_UNAVAILABLE` means private broker startup/connection failed; inspect ownership, permissions and startup state rather than retrying uncertain writes.

### Development Profile Volume Ownership

The devcontainer specifies both `containerUser: node` and `remoteUser: node`, with UID/GID 1000 and `updateRemoteUserUID: false`. Podman's `:U` profile-volume option follows the container runtime user, not just the VS Code remote user. A root runtime user can therefore leave the saved profile root-owned while Chromium runs as `node`.

If Chromium cannot unlock its profile because of `Permission denied`, inspect ownership metadata rather than deleting locks or profile data. A root-only `NativeMessagingHosts` directory can also make the existing registration inaccessible; a failed existence check alone does not prove it is missing.

After explicit authorization, with the old browser/container stopped, the person can perform this one-time repair from the WSL host, outside the devcontainer. Replace `CONTAINER_ID` with the current development container's ID:

```bash
podman exec --user 0 CONTAINER_ID chown -hR --from=0:0 1000:1000 -- /home/node/.local/share/agent-messaging-mcp/chromium-dev
```

This changes only root-owned entries inside the development profile; `-h` avoids changing symlink targets. Verify ownership afterward, then let the person use Chromium's own unlock/relaunch prompt. Restore a missing native launcher from an accessible recognized registration with the normal `restore:native` setup command; do not invent a new extension ID or replace an unknown manifest.

The container-user setting takes effect when the devcontainer is recreated. A one-time ownership repair does not prove future Podman remount behavior or recreate the current container. Follow the [agent safety boundaries](AGENTS.md#safety-boundaries) for privileged/profile work and trusted browser gestures.

## Coordinated Restart After Source Changes

Running processes keep the code they started with.

1. Run `npm run build`.
2. Look for a running broker (`pgrep -af broker-process`). Stop the verified broker with Ctrl+C in its debug terminal, or SIGTERM its verified owned PID if it was started detached. Start `npm run dev:broker` again, or let the restarted MCP facade auto-start it. This ends every grant and consent; unresolved dispatch intents survive only as status. Do not signal an unverified process.
3. Restart the MCP server (**MCP: List Servers**) so the facade reconnects and tool descriptions refresh. The new facade is a new owner: old request, connection and operation IDs return `unknown`.
4. Reload the extension in `chrome://extensions`, which revokes its grants, then select the chat tab again.

Toolbar clicks, extension reloads and profile unlocks are human steps. Ask for them precisely and never assume that an earlier service, grant or approval survived (AGENTS.md).

### Loaded Extension Build Identity

Production `npm run build:extension` stamps the packaged manifest's `version_name` as `<version>+sha256.<64 hex digits>`. The trusted popup displays its loaded manifest's full **Build** value, wrapping inside the existing width. Before a human reload, verify the completed build, then compare its printed marker with the popup's loaded value:

```bash
npm run verify:extension
```

The fixed-target, no-argument command reads only the production output tree. It exits nonzero on missing/malformed/unversioned or mismatched metadata, changed/missing/extra files, or symlink/non-regular entries; linked package roots/ancestors also refuse. Failure prints fixed rebuild guidance without file contents or raw paths. It never repairs, rewrites, restamps, installs, starts services or accesses a browser/profile. Use it on a quiescent build directory; it is not an atomic snapshot or protection against concurrent filesystem replacement.

The SHA-256 input is the generated manifest with `version_name` removed, followed by sorted unique output paths and their bytes, with names/byte lengths framed into the hash. The helper collects no clock, Git state, machine path, browser profile, chat data or credential; it reads only package artifacts. The same artifacts/settings reproduce the marker; changed packaged files or manifest settings change it. A missing listed output fails the build instead of producing a partial fingerprint. Development/watch builds remain **unversioned**.

This is local package-identification metadata, not signed integrity attestation, a source-commit ID, companion/broker identity or proof that every old context was reloaded. It neither selects a chat nor reads, approves, renews or sends anything. A matching loaded marker does not establish text fidelity or live-test permission. No new permission, command, network call or browser-control surface is added; public `browser_chat_feasibility` remains the no-browser-data stdio check.

### Local Extension Archive

```bash
npm run package:extension
npm run verify:extension
```

The default command rebuilds the production Chrome extension with WXT, stamps its build marker, verifies the output tree immediately before archiving, and writes a ZIP under `packages/extension/.output` named `browser-chat-mcp-<version>-chrome.zip`. Source archives are explicitly disabled. Only the default Chrome production path is covered; this is not a signed release, store submission or complete companion installer.

For manual loading, extract a successfully produced archive into a new, otherwise empty directory and use Chrome's **Load unpacked** on that directory, not on the ZIP. Keep the normal companion/native-host setup and human reload steps above. Compare the popup's loaded Build marker with the verified package marker before any separately approved live check. Packaging never installs, starts services, opens a browser or grants chat access; it does not include a profile, credentials or companion runtime.

Build/verify failure is not a new archive: an older ZIP may remain at the same filename, so require successful command completion and matching metadata rather than file presence. Use a quiescent build directory; the pre-archive verifier is a consistency check, not protection against concurrent filesystem replacement. Tests compare the exact ZIP entry set and bytes with the verified output and verify an extracted copy; byte-for-byte reproducible ZIP container metadata is not promised.

## Databag Compatibility

Stock Databag is not currently supported. Integrations must work with the existing website, without patches, custom frontend builds or redeployment. D14/D15 in [DESIGN.md](DESIGN.md#17-decisions) record the browser-only scope and superseded patch direction; D16 records the open stock-UI binding/lifetime question. See the [current capability dashboard](HANDOFF.md#current-state-dashboard) for evidence and limits.

Current chat-operation adapter source still depends on the experimental markers below. Its shared approval/read/send tests do not establish unmodified-site compatibility. The default origin remains unset; configuring it does not make stock Databag supported. Replace the connector's bindings and validate native identity/readiness before installed use; do not modify the website to satisfy the adapter.

### Shared popup inspection

The popup has one generic **Inspect this chat** action and one set of **Review drafts**, **Review fill consent** and **Review send consent** controls. A selected-chat adapter supplies diagnostics and supported supervised commands; unsupported phases stay hidden. Existing legacy command names are internal, not separate provider buttons. Inspecting does not connect an agent or approve a message.

Each explicit inspection resolves the current selected supported tab, requests only its exact optional origin permission and pins page calls to its visible top-level document ID. Denied permission performs no page script. Selection/navigation invalidates pending or displayed results; a fresh inspection after navigation does not restore an old grant.

For configured Databag `/#/session`, inspection recognizes fixed region names in `_region_suffix` and `Component_region__suffix` CSS-module formats without experimental markers. **CSS naming** counts recognized tokens by format and unrecognized tokens, never returning class names. These are counts across visited elements, not a deployed build/version determination. It returns only fixed layout counts and at most four native editor/Send state summaries.

**Native elements** independently counts visible textareas, explicit contenteditable elements, buttons and iframes, plus visited file inputs. **Control elements** independently counts visible labels, exact `role="button"` elements and SVG roots. These summaries require no recognized region; SVG roots are structural counts, not interpreted icons. **Send region elements** classifies visible recognized Send-region roots inside a recognized conversation/composer as button, label, div, span, SVG or other. Non-native regions are not promoted to native button candidates, readiness or write authority; no tooltip is required or read.

Zero CSS-region counts do not prove that the page lacks a composer. The same walk stops at 4,096 elements, depth 64 or a class attribute over 512 characters; partial results say limited. It does not enter frames, read message/account/handle text, draft values, file names/data, image URLs, tooltip/accessibility-label text, SVG contents, HTML or internal state, or perform input or persistent adapter installation. Diagnostic naming recognition does not change operational marker-dependent selectors.

This diagnostic supplies layout evidence, not stock conversation binding or read/send support. Installed review still requires a private exact-origin build, person-performed reload/selection and fresh bounded read-only authorization; return only the fixed metadata. Never use an existing connection or old live scope as inspection permission. See [Safety Boundaries](AGENTS.md#safety-boundaries).

### Historical patched contract

The retained [compatibility patch](integrations/databag/compatibility.patch) targets public upstream `45343338582b394f4f5fdb4b7e271ea1dc8dd5fd`. It is a research artifact, not an installation prerequisite or recommended deployment. The following describes the tested experiment, not stock-site operating instructions.

- The patch adds `data-chat-contract="databag-dom-v1"`, readiness and non-secret account/contact/channel markers to the selected conversation; message rows expose native IDs and direction. It marks the rendered text, timeline, composer and Send control without changing styling or login. Root `data-chat-draft-safe="true"` requires the current binding, no staged assets, unlocked detail and no in-flight send; missing/false refuses writes.
- Identity is unavailable while a focus change loads. Old listener results cannot restore a previous channel's ready binding. The adapter hashes the account/contact/channel tuple and never reads React state, SDK stores, credentials or message-source attributes.
- The initial adapter supports only plain rendered text. Locked, unconfirmed, edited, attachment-only or structurally ambiguous rows refuse capture; there is no attachment or media extraction. Hidden/unsupported descendants also refuse rather than exposing their text. The existing 32-row, 16,000-unit and 96 KiB bounds remain.
- The experiment configures one canonical HTTPS server origin using `BROWSER_CHAT_DATABAG_ORIGIN` in the extension's ignored local environment file, or the build environment. The build declares only that exact optional host origin, never an HTTPS wildcard. A replacement stock adapter must retain that boundary. Keep real deployment addresses out of tracked files. Unset means no Databag host permission.
- Only that exact origin's `/#/session` can be selected. The stored grant also pins the hashed account/contact/channel identity. Same-URL account/channel changes end it; same-chat reload suspends reads and requires fresh new-document identity before rebinding. Legacy fixture/Gemini commands cannot admit or read a Databag target.
- Neutral `list_chat_read_challenges`, `publish_chat_snapshot` and `mark_chat_observation_gap` are relay-only. Databag reuses the bounded stable-ID observation buffer and existing stable-row wire envelopes; there is no Databag command family. The shared saved-chat watcher runs neutral fill/proof/submit/settle phases with the original response/read deadlines, polling and restart backoff, never legacy Gemini phases.
- Databag sends reuse neutral preparation, composer reservation, durable intent and stable-ID evidence. Provider filtering occurs before offering a job; other providers and legacy listings cannot consume it. Plain text must be trimmed, contain no carriage returns, fit 2,048 UTF-16 units and the shared 4,000-byte limit. Only one visible, unobstructed writable textarea and marked Send control qualify. Read only file-input counts and refuse nonempty selections; never read file names/data or clear them.
- Filling uses native trusted insertion, exact readback and the shared document-local draft tracker. Only proven own leftovers selected by the broker can be replaced; human/unknown drafts remain. Root identity/readiness changes invalidate provenance. Submission consumes one document-local attempt plus the shared persistent browser reservation, rechecks after focus and activates once. Lost results never re-offer a job or restore authority.
- Databag reply waits report the existing quiet-period heuristic, not UI-complete or delivery. Page-sent evidence requires complete, untruncated stable-row observations; omitted/unsupported/ambiguous windows may stay unresolved. The Gemini rolling-window exception is not added to Databag. Never automatically resend an unresolved result.
- Approved snapshot requests must retain the broker's existing 25 ms response reserve when leaving the client queue and again after frame encoding. Local budget exhaustion refuses before any response timer or frame write; original deadlines, expiry and owner cleanup are unchanged.
- The disposable pinned frontend experiment passed Yarn 1.22.22 `install --frozen-lockfile --ignore-scripts --non-interactive` and its normal `build` script (`tsc && vite build`) from `app/client/web`. This is historical build evidence, not a deployment procedure or proof of stock compatibility.
- A future stock connector still needs actual-version review, a private exact-origin extension build, human browser login/reloads and exact-chat trusted popup approval. A source build or synthetic test grants no installed account access; follow [AGENTS.md](AGENTS.md#safety-boundaries). No website deployment change is required or authorized.

## Agent Workflow

### Popup-first connection

1. Start the MCP facade. Its authenticated instance appears by label/UUID in the trusted popup; it does not need to create a pending request.
2. Human: select an eligible chat, open the toolbar popup and choose **Connect this chat** on the intended agent's row. The click requests optional site access for that origin, then approves only that agent for the exact chat. Denial creates no connection. Each other or later agent needs a separate approval; removal/restart never silently restores access.
3. `chat_wait_for_connection { timeoutMs? }` waits at most 20 seconds and returns `{ connections, timedOut }`. Zero is an immediate query; default is 20 seconds. Each returned connection has `requestId`, `connectionId`, `state: "ready"`, `generation: 1`, `origin`, `conversationId`, `capabilities: ["read", "send"]` and `expiresAt: null`. The caller sees only its own grants; the call never grants access.
4. Use `chat_read_messages`, `chat_wait_for_events` and `chat_wait_for_reply` as described below. `chat_get_connection { requestId }` also reports current observation metadata. For writes, follow Autonomous send below; popup-first authority does not bypass the separate legacy supervised path.
5. `chat_disconnect` ends that owned grant. Human **Remove access** affects only that agent on this chat; **Disconnect all** affects all matching owners. Tab/chat/browser/owner termination ends access. Exact same-chat reload preserves autonomous handles after new-document verification and requires a fresh snapshot/cursor; old-document reads are unavailable during reload. Legacy grants still end on reload. Cancelling pickup closes the facade socket and ends all grants belonging to that owner.

Owned `chat_disconnect` bypasses an in-flight read/send in both private client and broker queues, without closing the owner's other connections. Ordinary requests remain serialized; the same 16-pending-request cap and original deadlines apply. The client correlates concurrent replies by request ID and exact deadline before strict per-request payload validation. Unknown/duplicate IDs, changed deadlines or transport loss close the socket and reject pending work; a malformed payload retains the existing per-request rejection behavior. Disconnect cannot undo an already activated send, clear its draft, restore authority or authorize retry. A subsequent trusted roster refresh clears the unchanged local grant after a validated zero-owner result.

### Legacy connection and shared read tools

1. `chat_request_connection` returns `{ requestId, state: "pending", expiresAt }`. The request expires after 60 seconds.
2. Human: select the chat tab, click the extension's toolbar icon, choose **View pending requests**, then **Approve read-only fixture** or **Approve read-only Gemini chat** for that request.
3. `chat_get_connection { requestId }` returns `ready_readonly` with `connectionId`, `origin`, `conversationId`, `generation: 1`, `expiresAt` (five minutes after approval, no renewal) and `observation` age (`not_observed`, `recent` or `old`, not a presence signal). Other states are `pending`, `expired`, `stale` (revoked) and `unknown` (foreign or forgotten).
4. `chat_read_messages { connectionId, limit? }` returns a fresh rendered snapshot with `coverage: "rendered_only"`, `capturedAt`, `cursor`, `messages` and `omittedBefore`. That flag covers capture-window/byte omissions and caller-limit omissions. A cut message has `truncated: true`; its text is not complete. Fixture rows have stable IDs; Gemini rows carry `identityQuality: "uncertain"` and `generationState: "unknown"`, `"streaming"` or reviewed UI `"complete"` as described below.
5. `chat_wait_for_events { connectionId, cursor, timeoutMs?, limit? }` waits up to 20 seconds and returns `{ state: "ok", events, cursor, timedOut }`. Each event holds a full rendered snapshot, not a delta. On `CURSOR_EXPIRED`, call `chat_read_messages` again.
6. `chat_disconnect { connectionId }` returns `{ disconnected }` and leaves the tab open.

For Gemini, treat events as change hints. A streaming reply produces many snapshots; the 128-event/4 MiB buffer can still expire a cursor. Generation states describe page UI, never provider acceptance or delivery. Captures keep the newest 32 visible rows, cap each message at 16,000 UTF-16 units and drop oldest rows until the capture fits 96 KiB. Snapshot events carry the same omission and truncation flags.

Chromium can return empty `innerText` for `content-visibility: auto` descendants in hidden tabs or outside the viewport of a visible chat, even when row geometry is available. Empty captures under an auto-contained ancestor use a CSS-aware text fallback for query lines and response content, regardless of tab visibility. This prevents an older offscreen query from invalidating the whole capture as a conversation grows. Explicitly hidden ancestors/subtrees, scripts and styles remain excluded; traversal fails closed above 4,096 nodes or depth 64 per text region. Existing capture/truncation limits and completion evidence are unchanged. No tab activation, page mutation, alternate permission or deadline extension; ordinary rendered `innerText` remains preferred. Both cases are synthetically reproduced; the exact cause of earlier installed failures remains unconfirmed.

For paired KaTeX markup, `innerText` can duplicate a CSS-clipped alternative and the visible equation. Capture recognizes only an absolutely positioned, overflow-hidden alternative with legacy `clip: rect(1px, 1px, 1px, 1px)` / `rect(0px, 0px, 0px, 0px)` or modern `clip-path: inset(50%)`, paired with a visible sibling HTML layer. The same bounded collector excludes only that alternative; other shapes retain ordinary behavior, including nonzero clips and different position/overflow. Visible `aria-hidden` math remains readable; hidden MathML/TeX is never substituted.

Incoming Gemini replies preserve visible native superscripts/subscripts as `^(...)` / `_(...)`. Within recognized paired KaTeX HTML, validated positioned scripts use the same grouping, a visible fraction bar yields `(numerator)/(denominator)`, and a visible radical yields `sqrt(...)` or `root(index, ...)`. Nested supported forms compose. Unrecognized or altered layout retains ordinary visible text instead of inventing structure or dropping extra visible terms.

Radical SVGs or loaded images may sit behind visible HTML wrappers. The existing bounded collector propagates graphic evidence through those wrappers rather than performing a separate descendant search. Image leaves must be complete, have nonzero natural dimensions and positive computed width/height. Missing, pending, broken, hidden, transparent or zero-size images cannot supply evidence; hidden/transparent wrappers still refuse. No image URL/alt/source/contents, SVG text/path contents or hidden MathML/TeX is read, decoded or fetched by capture. Offscreen auto-contained graphics use CSS/readiness checks without requiring viewport geometry. This is structural evidence, not pixel inspection or proof of a particular image's meaning.

Outgoing rows keep their existing exact-text path for send evidence. Visible HTML subtree nodes still consume the 4,096-node/depth-64 budget before formatting; omission, truncation and no-mutation rules are unchanged. Test-only pinned KaTeX generates invented fixtures and is not bundled into the extension. This is limited visible-structure formatting, not TeX recovery, complete math serialization or a numerical-fidelity guarantee; installed acceptance remains separate in HANDOFF.md.

Only the newest rendered row may receive `streaming`, and only if it is incoming with a visible `aria-busy="true"` marker on the row/descendant or the visible reviewed `Stop response` button with a stop icon outside the timeline. Older replies, outgoing rows and absent/hidden/unrecognized controls remain `unknown`. A disappearing Stop control, copy button or missing busy marker never proves completion. Indicator-only transitions advance the snapshot/event cursor; timeline busy-attribute changes also notify the existing observer. These signals neither read other page areas' text nor create browser authority.

The newest incoming row may instead report UI `complete` only for the reviewed shape: no root busy attribute, exactly two visible busy descendants explicitly `false` belonging to that response, exactly one visible enabled `Copy` action, and no visible Stop/progress control. Missing, unexpected, hidden, extra or conflicting markers cannot satisfy it. This is a conservative UI interpretation, not a provider guarantee; site changes or localization can leave the state unknown. Only an untruncated row can satisfy reply waiting even if a raw truncated capture reports the UI state.

A missing or ambiguous message element skips publication when URL, document and conversation are unchanged. A challenged read then returns `OBSERVATION_UNAVAILABLE` after its original four-second budget; a later read can recover without reapproval. Identity changes still revoke the grant. No snapshot omission or truncation proves a complete history.

### Waiting For Replies

`chat_wait_for_reply { connectionId, timeoutMs? }` waits at most 20 seconds (default 20 seconds) using existing fresh exact-document reads. Zero returns `{ timedOut: true }` without reading. No new read starts with at most 25 ms remaining, matching the broker's existing response reserve; this shortens work within the original budget, never extends a deadline or preserves authority after a real disconnect. Success returns `{ timedOut: false, coverage, generation, capturedAt, cursor, omittedBefore, reply }`; only the newest rendered row may qualify, and it must be incoming, nonempty and untruncated. A previously existing newest reply can qualify; this is not correlation to a particular send.

Without a reviewed complete signal, the tracker requires a two-second span of advancing fresh captures with the same observation epoch/sequence and entire rendered window. Revisions, changed-restored text reflected in the cursor, gaps, reloads, truncation, outgoing tails, backward time, unavailable captures and positive streaming evidence reset it. Unchanged streaming text cannot settle. After streaming clears, the fallback needs a fresh full quiet period and returns `settled_heuristic`; network stalls can look quiet.

A fresh reviewed UI-complete newest row returns `reply.generationState: "complete"` without that heuristic delay, retaining ownership, timestamp, nonempty and truncation checks. Both result types disclose missing earlier rows and neither proves complete history, provider acceptance or delivery.

Timeout returns no reply and does not intentionally disconnect the owner. A local read-deadline refusal within the existing 25 ms response reserve is also a timeout, not a broker outage; other encoding/transport errors retain their normal owner-ending behavior. Reads remain at most four seconds and are clipped to the original wait budget with a transport-reply allowance. A locally expired queued or encoded read cannot reach the browser. Cancellation ends the owning broker connection; reconnect requires fresh approval. Errors use structured `code`, including `CONNECTION_NOT_FOUND`, `CANCELLED` and `BROKER_UNAVAILABLE`. Synthetic SDK/browser coverage exists for both providers; installed/live evidence is tracked separately in HANDOFF.md.

Both extension read watches forward each challenge's original expiry into the snapshot queue. The existing publisher checks it after queued work drains and before page capture/publication; late reads are skipped without expiring the connection or touching its draft. Integer transport deadlines round the remaining fractional budget up, still clipped to the original wall deadline and five-second transport cap; the enclosing wait retains its original monotonic budget.

### Autonomous send

After **Connect this chat** and `chat_wait_for_connection`, call `chat_send_message { connectionId, text, idempotencyKey }` with a UUID key. Only the live owned autonomous grant authorizes a new attempt. The broker runs preparation, fill, challenged read, exact proof, durable intent, one reserved activation and bounded evidence inside one original 30-second deadline. Each browser lease remains at most four seconds.

After visible trusted-popup approval, an autonomous connection may send in that exact chat while its tab is hidden/inactive, without activating it or changing the foreground tab (D11a). Exact document/URL, layout/hit tests, original deadlines, fresh proof and one-shot reservation still apply. Existing human/unknown drafts refuse without input, intent or activation. Hidden fills create no retained D10a replacement authority; visibility loss still invalidates provenance. Supervised/default page helpers remain visible-only. Fixture textarea/rich and routed synthetic Gemini are covered without focus emulation; see the [current evidence and installed limits](HANDOFF.md#current-state-dashboard) rather than treating synthetic coverage as deployment or reliability proof.

Results always have `retryAllowed: false` and `state: "sent" | "not_sent" | "unresolved"` with a code. `sent` is a page/person assessment, not acceptance or delivery. `not_sent` means a definite refusal before durable intent or a page/person assessment; returning it does not clear any draft. A fresh independently keyed message may replace only this owner's known resolved unsent leftover under the bounded D10a checks below. `unresolved` may mean the send happened and must not trigger an automatic replacement. An unresolved durable attempt pauses the conversation across owners.

Gemini can assess page-sent across a full 32-row rollover using the [D9a bounded evidence rule](DESIGN.md#gemini-outcome-evidence-decided-d9). It requires a unique exact overlap retaining at least 30 baseline rows, one matching outgoing row and optionally one incoming reply. Ambiguous, edited, truncated, discontinuous or smaller omitted windows stay uncertain. Changes entirely outside the captured window are not observable; partial-window evidence never establishes page-attributed `not_sent`. This changes neither capture limits nor retry/authority rules. Installed long-chat acceptance is tracked separately in HANDOFF.md.

Autonomous `DISPATCH_UNAVAILABLE` results may include optional `failureStage`: `composer`, `fill`, `read`, `proof` or `dispatch`. This fixed metadata names the last attempted phase, not a proven root cause or new authority. Existing codes, no-retry behavior and durable-status precedence remain unchanged; transport loss still yields unresolved without an invented stage. Source coverage does not establish deployment; use the coordinated restart procedure above and the [current checkpoint evidence](HANDOFF.md#t5-gated-read-deadlines-and-refusal-diagnostics-2026-10-16).

The first prepared response includes `operationId` and a private `recoveryToken`; keep the token private. `chat_get_operation { operationId, recoveryToken }` can recover dispatch metadata without chat access or write authority. Same key and arguments return the existing status without another activation; a status-only replay need not repeat the token. Changed arguments conflict. New work requires a new key and valid authority, and still refuses an existing draft. Cancellation closes the owning broker connection; it cannot undo an already activated send.

Transport failure returns `unresolved / DISPATCH_UNCERTAIN` even while awaiting preparation: a same-key concurrent or earlier invocation may already have durable intent. Local call progress is not proof of non-send. Cancellation cannot restore approval on a replacement broker connection; receipt recovery stays status-only.

Trusted-popup removal after fill leaves the draft unsent without durable intent or activation. Removal after activation cannot undo it and stays unresolved when evidence has not reached the broker. Both refuse new work without fresh approval; receipt recovery creates no authority. Synthetic browser checks remove access before the original lease expires.

Actual SDK cancellation with a queued same-key call is browser-tested after fill and after activation for both providers. The duplicate stays unresolved, jobs are not re-offered, and the replacement owner has no inherited approval or operation access. A trusted roster refresh removes the unchanged autonomous local grant only after a validated exact-chat zero-owner reply; other connected owners and newer approvals remain intact.

This public path works for the fixture and routed synthetic Gemini pages, including own-window/hidden empty-composer sending, hidden human-draft refusal, popup removal/cancellation after fill/activation, bounded visible own-leftover replacement (D10a) and human-draft preservation. Installed/live evidence and remaining limits are tracked in HANDOFF.md. Do not infer live test authorization from synthetic coverage.

### Supervised send (fixture only)

These legacy controls still require the finite read-only grant and distinct per-message consents. Popup-first autonomous grants instead use `chat_send_message`; they do not bypass the supervised controls.

1. `chat_prepare_message { connectionId, expectedGeneration: 1, text, idempotencyKey }` with a new UUID key returns `operationId`, `awaiting_approval`, `expiresAt` (three minutes), the exact `preview` and a private `recoveryToken`.
2. Human: **Review fixture drafts**, then **Approve draft (no send)**.
3. Human: **Review fixture draft fill**, then **Allow draft fill (no send)**.
4. Check `chat_get_operation` reports `approved` and `draftFill.state` as `fill_approved`; ordinary review alone is insufficient. Then call `chat_fill_draft { operationId }` once, while the same fixture document is selected and its editor is empty.
5. Human: check the draft, then **Review fixture sending** and **Approve fixture send**.
6. `chat_commit_message { operationId }`, once.
7. `chat_get_operation { operationId, recoveryToken? }` reports status only.

Each human approval lasts at most two minutes and ends with the preparation or connection. Never retry an uncertain fill or commit, and never create a replacement operation after uncertainty. On a Gemini connection, legacy `chat_prepare_message` returns `CONNECTION_NOT_FOUND`; autonomous sending uses the separate public tool above.

## Tool Reference

| Tool | Input | Result | Notes |
| --- | --- | --- | --- |
| `browser_chat_feasibility` | none | Fixed diagnostic text | Touches no browser |
| `chat_request_connection` | none | `requestId`, `pending`, `expiresAt` | No tab is read before approval |
| `chat_get_connection` | `requestId` | Connection state | Owner only; others see `unknown` |
| `chat_wait_for_connection` | Optional `timeoutMs` 0-20000, default 20000 | Owned `connections`, `timedOut` | Popup-first grants only; no approval creation; cancellation ends owner grants |
| `chat_read_messages` | `connectionId`, `limit` 1-32 | Fresh snapshot and cursor | Exact-document challenge, four seconds |
| `chat_wait_for_events` | `connectionId`, `cursor`, `timeoutMs` 0-20000, `limit` 1-2 | `events`, `cursor`, `timedOut` | `CURSOR_EXPIRED` needs a new read; cancellation returns `CANCELLED` |
| `chat_wait_for_reply` | `connectionId`, optional `timeoutMs` 0-20000 | `timedOut`; on success, latest `reply` and observation metadata | Reviewed UI `complete` or two-second `settled_heuristic`; existing newest reply may qualify; timeout has no reply |
| `chat_send_message` | `connectionId`, `text`, UUID `idempotencyKey` | `sent`, `not_sent` or `unresolved`, `code`, `retryAllowed: false`; operation/receipt when prepared | Autonomous fixture/Gemini only; one original deadline; exact-key replay is status only |
| `chat_prepare_message` | `connectionId`, `expectedGeneration: 1`, `text`, `idempotencyKey` | Operation, exact preview, `recoveryToken` | Fixture only; the same key and text replay, changed text conflicts |
| `chat_fill_draft` | `operationId` | `ok` with `editor` and `completedAt`, or `code`; `retryAllowed: false` | Needs fill consent; refuses existing drafts; never clicks Send |
| `chat_commit_message` | `operationId` | `observed_in_ui` with row and time evidence, or `DISPATCH_UNAVAILABLE` / `DISPATCH_UNCERTAIN`; `retryAllowed: false` | Needs completed fill and Send consent; fresh read and proof run inside; replay returns status only |
| `chat_get_operation` | `operationId`, optional 64-hex `recoveryToken` | State, approval expiry, `draftFill` metadata | A token recovers only dispatch status after restart, never authority |
| `chat_disconnect` | `connectionId` | `disconnected` | Cancels pending reads; closes nothing |

Operation states are `awaiting_approval`, `approved` (ordinary no-send review only), autonomous `prepared`, `expired`, `stale`, `unknown`, `dispatch_uncertain`, `observed_in_ui` and `resolved`. These are distinct from the public send result's three states. `resolved` carries outcome, source and time: a declared page/person assessment, never provider acceptance or delivery. Trusted popup choices record person attribution; page reconciliation records page attribution. Resolution never restores the old operation's write authority, and its attempt still counts against the hourly limit. `draftFill` reports `fill_approved`, `filling`, `filled`, `failed` or `uncertain`; `filled` describes a past readback, not the current draft. `observed_in_ui` is UI evidence, not acceptance or delivery.

Fixture send reconciliation stays uncertain when its baseline, an intervening event or the current capture omitted rows. A truncated outgoing row cannot prove an exact text match. Status recovery does not restore write authority.

Most legacy refusals are text of the form `CODE: No chat was accessed.` Codes include `BROKER_UNAVAILABLE`, `CONNECTION_NOT_FOUND`, `OBSERVATION_UNAVAILABLE`, `CURSOR_EXPIRED`, `CANCELLED`, `TOO_MANY_PENDING`, `PREPARATION_UNAVAILABLE`, `GENERATION_MISMATCH`, `INVALID_MESSAGE_TEXT`, `INVALID_IDEMPOTENCY_KEY`, `IDEMPOTENCY_CONFLICT`, `OPERATION_EXPIRED`, `OPERATION_UNAVAILABLE`, `TOO_MANY_PREPARED` and `DISPATCH_UNCERTAIN`. Fill, commit and autonomous send return structured codes. Transport loss after autonomous commit begins returns `unresolved`, even when no activation can be established; it is never mislabeled a definite failure.

### Private Neutral Job Contracts

These are development transport contracts, not new public MCP tools. Private Gemini preparation/fill and ordinary review, fill consent and Send consent still use the supervised legacy finite grant. Autonomous grants do not bypass those controls.

- Facade-only `commit_prepared_message { operationId }` returns `chat_dispatch` status. A shared routine selects the provider's challenged read, exact-draft proof and durable dispatch inside the original request deadline; each inner lease remains at most four seconds. Existing `commit_fixture_message` retains fixture-only admission. Neither path retries uncertain work.
- Relay-only `list_chat_jobs { phase: "fill" | "proof" | "submit" | "settle", provider: "fixture" | "gemini" }` returns `chat_jobs { jobs }`. Strict jobs carry `operationId`, `jobId`, `phase`, exact provider-tagged `target`, bounded `text` and original `expiresAt`. Submit IDs match the operation and require durable intent. Other phases have independent IDs and require autonomous composer ownership; `settle` uses a separate status-only queue. Limits are one fill/submit/settle or 16 proofs per listing. Every offer is one-shot and provider/phase homogeneous; legacy listings do not consume autonomous offers.
- Relay-only `complete_chat_job { phase, target, operationId, jobId, observation }` returns `chat_job_recorded { accepted }`. Phase-specific results, target, editor/provider and job identity must match. Completion records an observation, not approval, acceptance or delivery; it creates no authority or replacement job.
- Neutral worker phases check the exact live grant/document/URL/conversation, using the shared input lock and guarded fill/proof/submit functions. Only the stored autonomous grant (`expiresAt: null`) allows an inactive tab and supplies extension-internal `allowHidden: true` to page helpers; it is not a broker/native/MCP argument. Submit alone reserves the provider-scoped attempt persistently before one activation. `settle` is read-only. Publication/completion stay clipped to original leases. Legacy phases retain active/visible/current-window requirements.
- Private `prepare_gemini_message` returns the existing 64-hex `recoveryToken`, stored only as a digest. Recovery before durable intent remains `unknown`; later recovery is status only. Never log the raw token or treat it as write authority.
- Gemini page-sent evidence requires continuous retained observations, an unchanged complete baseline and exactly one matching appended outgoing row. Following incoming rows and their streaming revisions are allowed; omissions, truncation, gaps/eviction, duplicates, prefix edits or disappearing outgoing rows stay uncertain. Successful evidence records immutable `resolved { outcome: "sent", source: "page", resolvedAt }` metadata. Bounded autonomous settlement and page-not-sent are described below.

### Internal Autonomous Ledger Primitives

These primitives back public `chat_send_message`. Authenticated neutral preparation/commit, broker/native/worker phases and bounded page-sent/not-sent settlement are connected. Disposable fixture and routed-synthetic Gemini browser flows cover delayed rows, retained drafts, changed baseline evidence and lost submit/terminal-proof results. Consult HANDOFF.md for installed/live evidence.

- `prepareAutonomous(owner, connectionId, text, idempotencyKey, deadlineMs)` requires an owned live autonomous `ready` grant, validates provider text limits and separates autonomous/supervised idempotency. It returns `prepared` plus a status receipt; the original request expiry is at most 30 seconds and replay cannot renew it. No supervised approval is created or offered for ordinary review.
- Private facade-only `prepare_chat_message` carries only `connectionId`, `text` and `idempotencyKey`; `prepareChatMessage` returns `chat_message_prepared` with the original expiry and recovery receipt before any job or intent. Exact owned durable replay instead returns `chat_dispatch` without preparation or renewed authority, even after grant removal while original target metadata remains. New work derives provider from the live grant, refuses legacy read-only handles and rejects extras. Existing `commit_prepared_message` derives autonomous/supervised routing from the owned operation; a late expected error returns durable status if one exists, never a false pre-intent refusal.
- `prepareChatMessage(..., deadlineMs)` and `commitPreparedMessage(operationId, deadlineMs)` accept an explicit original absolute send deadline up to 30 seconds, clipped to any upstream deadline. No other request budget changes: ordinary calls retain five seconds, pickup keeps its separate bounded wait, and browser jobs keep four-second leases. Reusing the prepared expiry cannot renew the operation; recovery receipts return status only.
- `acquireComposer(owner, operationId, deadlineMs)` resolves readiness only for live owned authority, uses FIFO per exact origin/conversation/tab/document and allows at most one queued wait per owner. Independent composers are eligible. A wait stays bounded behind an occupied active submit; unresolved intent blocks acquisition after that reservation releases. Its reservation also blocks legacy fill admission before consent is consumed; `releaseComposer` is owner-only and changes coordination, never grant authority. Removal, owner close, reload suspension or expiry prevent phase authorization.
- `requestChatFill` and `requestChatProof` require the live grant and owned reservation. They reuse provider queues and exact fresh post-fill baseline checks. Inner leases remain at most four seconds and clipped to the original operation/upstream expiry; consumed fill authority is never restored.
- `listChatJobs(phase, provider)` offers strict ledger jobs only once; `completeChatJob` validates phase, offer, exact target, provider/editor and original expiry. Fill/proof completions create no approval, durable intent or activation. The strict client status codec accepts internal `prepared` metadata without widening writer contracts.
- Autonomous intent admission requires the direct live owned grant, composer reservation, completed fill, receipt and fresh proof; it does not mint supervised ordinary or Send approvals.
- `commitAutonomousMessage(owner, operationId, deadlineMs)` joins composer acquisition, fill, fresh challenged read, proof, durable intent and one submit under the minimum of the original request and prepared-operation expiry. Concurrent replays share the first result and cannot renew it. Completed replay reads current durable status; rejected attempts cannot automatically restart. The owned reservation spans post-submit settlement and releases on completion/refusal, keeping conversation uncertainty and all consumed authority intact.
- After uncertain submit completion, settlement reconciles retained provider evidence for at most `CHAT_SETTLE_TIMEOUT_MS` (five seconds), clipped to the same absolute deadline. Delayed matching outgoing rows can yield current UI/page-sent status without another activation. Lost authority, gaps, missing/ambiguous evidence or expiry remain uncertain. No additional write lease or retry is created; ordinary status recovery remains read-only.
- Page-not-sent waits until the old activation lease ends, then obtains one read-only `settle` exact-draft/Send-control proof followed by a fresh challenged snapshot. Both remain inside the existing five-second/original deadline. Complete continuous unchanged baseline rows yield immutable page-attributed `not_sent`; absence alone, gaps, edits, omissions, truncation, unavailable/expired proof or reads and lost authority stay uncertain. Settlement never clears the draft or restores consumed writes. A later independent send may use bounded D10a replacement below.
- Neutral fills install `draft-ownership.ts` in the exact isolated document. One memory-only marker binds the operation, URL, root/editor objects and exact trusted insertion/readback. Input or same-text human retyping, relevant mutations, replacement, observed mismatch, visibility loss and pagehide invalidate it. The known textarea insertion's one deferred native blur-change is distinct from later editing. Provenance alone is not replacement authority; unknown or human drafts remain untouched.
- D10a uses only a new fill job's optional broker-derived `leftover { operationId, text }`. The prior filled autonomous operation must have the same owner, connection and exact composer/URL, retained unexpired metadata and immutable resolved-not-sent status. Only `fill` accepts this strict descriptor, never proof/submit/settle or caller preparation arguments. The worker performs read-only retained-draft preflight and the adapter revalidates ownership after focus/selection before one selected native insertion. Expired/restarted/foreign/unresolved prior operations cannot authorize replacement. No old attempt is retried or authority restored; there is no standalone clear tool or durable draft storage.

### Native Request Channel

Snapshot publication, legacy/neutral job completion and shared roster/reload/resolution/review requests reuse one worker control port, separate from the read watches. The channel keeps at most 16 pending IDs, validates every strict original envelope and deadline, and closes after one idle second. Expiry, invalid/unknown replies, disconnect or posting/startup failure close that channel and reject all pending requests; later caller requests may open a new port, but failed requests are never replayed. Payload validation and exact-document/authority checks remain in their existing callers. The relay still authenticates each forwarded broker request in the original role and deadline.

Grant-count metadata (startup observation gaps and fixture/tab/global revocation) also uses that channel instead of opening a host per request. `requestNativeGrantCount` keeps its ten-second absolute budget, expected reply kind and exactly one nonnegative safe-integer count; errors return false, never renewed approval. Shared envelope/expiry/no-replay checks still apply. Current source acceptance and failed-gate evidence are tracked in HANDOFF.md.

## Trusted Popup

The toolbar popup is the only approval surface; page scripts and MCP calls cannot approve anything. On the fixture or an eligible saved Gemini chat it offers:

Open this small panel from the extension icon in container Chromium's toolbar, using the Extensions puzzle-piece menu if necessary, while the chat tab remains selected underneath. Do not open the extension UI as a full browser tab or confuse it with the `chrome://extensions` management page. After an approval click, report its actual confirmation or error; clicking alone is not evidence that consent was granted.

- **Inspect this chat**: a read-only diagnostic. On the fixture it lists rows and checks the native bridge. On Gemini it shows only structure metadata (regions, editors, row lengths, **Send controls**, **Prompt state**, **Nearby prompt controls** and **Math layout**), never chat text.
- **View pending requests**, then **Approve read-only fixture** or **Approve read-only Gemini chat**.
- Agent roster: **Connect this chat** per agent, **Remove access**, **Disconnect all** and **Refresh agents**. The consent text discloses read/send authority and influence from chat content, and warns that site changes may interrupt access. See HANDOFF.md for current acceptance evidence.
- **Unconfirmed Sends**: **Refresh status** loads eligible selected-chat operation IDs/timestamps; **Sent** / **Not sent** record an immutable person assessment, never activate Send or touch the composer. It does not automatically check on ordinary popup opens.
- **Review fixture drafts** or **Review Gemini drafts**, then **Approve draft (no send)**.
- **Review fixture draft fill** or **Review Gemini fill consent**, then **Allow draft fill (no send)**.
- **Review fixture sending** or **Review Gemini send consent**, then **Approve fixture send** or **Approve Gemini send**.

**Math layout** scans only the newest rendered incoming response on the exact selected saved-chat URL/document. It returns counts and fixed-vocabulary root shapes: relative depths, child counts, display categories, relative positioning, strut/offset-sign and hidden/nonzero-opacity flags. It visits at most 4,096 nodes to depth 64 and records at most four outer root subtrees with 64 shape nodes each; limit flags mark partial results. SVGs/images are opaque leaves. No text/HTML, unknown class/attribute values, hidden MathML/TeX, SVG contents, URLs or credentials are read or returned by this math probe. It does not focus, scroll, edit, approve a connection or send. Active/visible top-level-page and exact-document checks remain required; do not infer renderer fidelity from its counts.

The legacy **Test fixture input** and **Fill test draft** controls and runtime routes are removed (D6). All connected writes stay inside the operation pipeline; native-bridge diagnostics remain. The extension no longer requests debugger permission. D11a autonomous hidden sending has source/synthetic coverage, not installed/live acceptance.

Review lists show at most eight exact previews and clear when the tab, document, grant or expiry changes.

Fill queue admission also retains the exact composer across operations: another operation is busy while a live filling, filled or fill-uncertain operation targets the same origin/conversation/tab/document. This covers multiple owners and competing operations of one owner. Busy does not consume the candidate's consent. Independent composers remain eligible after the global pending-fill slot clears. Definite fill failure, revocation, original preparation expiry or known dispatch outcome releases coordination, never authority. An unresolved durable intent still pauses its conversation. Clearing a draft manually does not end a live prepared operation or permit old-operation replay; no autonomous waiting/sending tool is connected yet.

### Unconfirmed Send Resolution

Select the exact chat in the container browser, open its trusted toolbar popup, and use **Refresh status**. The list shows at most eight operation IDs/start times and an overflow marker, never message text, private URLs or recovery tokens. Attempts appear only after the old maximum four-second activation lease ends, without existing UI evidence or resolution. Old unkeyed attempts cannot be attributed to a guessed chat and remain globally blocking. **Nothing to resolve** means no eligible entries, not proof that no uncertainty exists.

Choose **Sent** or **Not sent** only after assessing that attempt. The immutable outcome is attributed to the person, not page evidence or provider acceptance/delivery. Same-outcome replay returns the original record; conflicting, foreign, premature or legacy-unkeyed resolutions refuse. Recorded resolution releases that conversation's pause but retains the attempt's hourly count. It never authorizes old operation/key replay, fills or clears a draft, reactivates Send or changes connections; subsequent operations need their own authority.

The private provider-neutral native/broker commands are relay-only: `list_unconfirmed_dispatches { target }` returns `unconfirmed_dispatches { attempts: [{ operationId, startedAt }], hasMore }`; `resolve_unconfirmed_dispatch { target, operationId, outcome }` returns `dispatch_resolved { operationId, state: "resolved", startedAt, resolution: { outcome, source: "person", resolvedAt } }`. They are not public MCP actions and accept no source, approval, draft, model/owner identity or retry fields. Unavailable resolutions use `DISPATCH_RESOLUTION_UNAVAILABLE`.

The worker pins the active tab, exact URL, top-level document and conversation before/after the native request inside one original ten-second budget. Tab, document or grant changes clear popup rows; stale/malformed replies cannot revive them. Refresh after uncertainty or failure is read-only, not an action retry. Optional origin access must already be available; metadata refresh never asks for site permission or grants read/send access. Installed acceptance and current deployment state are recorded in [HANDOFF.md](HANDOFF.md).

## Gemini Target Rules

- Eligible: a saved chat URL with exactly two path segments, such as `https://gemini.google.com/app/<id>`, with an optional query (bound exactly), no fragment and at most 512 characters. New unsaved chats (`/app`) and multi-account paths such as `/u/<n>/app/<id>` are not eligible.
- Route eligibility does not prove persistence: a signed-out temporary chat may have an eligible route yet disappear on reload. Signed-in status alone is insufficient; have the person confirm the history/Activity setting actually retains the non-temporary test chat. Test installed same-chat reload only with a chat that the provider retains. If reload returns to a landing page or another chat, the original target is gone; do not reconnect or read the replacement as recovery of that chat.
- A grant binds the tab, Chrome document, exact URL and conversation ID. Autonomous grants preserve approval only on exact same-chat reload with fresh new-document verification; legacy grants revoke on reload. Navigation (including query changes), closure or extension reload ends access. Capture failures alone no longer revoke an unchanged target; they cannot authorize reading a changed target.
- Gemini's page-load completion may precede its rendered timeline. During same-chat rebind, the worker may retry missing identity at intervals up to 50 ms within the existing ten-second completion-phase deadline, with access still suspended. Changed URL, wrong/same-old document, invalid identity or rebind reply, and deadline exhaustion cannot restore access. No snapshot is accepted before verified rebind; the deadline is not extended.
- Reads parse `user-query` and `model-response` rows inside one rendered `infinite-scroller` in one `main` region. Fill/submit require one unobstructed prompt editor labeled `Enter a prompt for Gemini` (empty before filling) and one rendered `Send message` submit button. Autonomous jobs may operate while the tab is hidden under D11a; supervised operations still require it active/visible. Rendered layout checks are not dropped for hidden tabs.
- These selectors reflect one observed UI variant and can break whenever Gemini changes its page.

## Agent Roster

The selected eligible chat's popup lists authenticated MCP facade instances, their labels/UUIDs, live exact-chat counts and supervised/autonomous status. Each row without autonomous access offers **Connect this chat**, including a legacy connected row; connected rows offer **Remove access**. **Disconnect all** removes all owners from that exact target, not another chat or the tab. Refresh rereads the roster. Before script permission, metadata-only listing shows available owners and unknown chat status; it cannot prove a zero connected count. Approval requests optional origin access directly from the trusted click, then verifies the exact document.

The label defaults to the MCP client's reported name (sanitized/truncated to at most 80 printable ASCII characters), or `MCP agent`. Set `BROWSER_CHAT_AGENT_LABEL` in the MCP process environment to a nonempty, unpadded printable ASCII label of at most 80 characters. Invalid overrides are rejected. Labels are not verified model identities; two threads sharing one facade appear as one instance. Duplicate labels are distinguished by instance UUID. Restarting a facade creates a new instance, without inherited grants.

Removal revokes matching grants and cancels pending reads. It does not undo an activated send or restore consumed authority. A removed instance remains available but needs a fresh trusted approval, without a pending request for popup-first access. Autonomous grants are `ready` with no expiry; legacy grants remain `ready_readonly` with five-minute expiry and per-message supervised write consent. Failed or uncertain admission setup makes one exact-agent/target removal attempt, never an approval retry or whole-chat compensation. If the native bridge is unavailable, this attempt cannot establish that revocation succeeded.

## Limits and Timers

| Item | Value | Defined in |
| --- | --- | --- |
| Pending connection request | 60 s; at most 100 pending | `pending-connections.ts` |
| Read-only grant | 5 min without renewal; `generation` always 1 | `pending-connections.ts` |
| Autonomous grant | No expiry; at most 100 records including revoked tombstones retained 60 s | `pending-connections.ts` |
| Connection pickup | 20 s maximum; one pending wait per owner; only pickup uses 20 s plus 250 ms response headroom | `pending-connections.ts`, `broker-client.ts`, `broker-ipc.ts` |
| Fresh read challenge | 4 s | `pending-connections.ts` |
| Native watch recovery | One pending restart per provider; 1 s doubling to 10 s, reset on valid reply; requires a tracked unexpired grant | `background.ts` |
| Snapshot | Newest 32 visible rows; 16,000 UTF-16 units per message with `truncated: true`; 96 KiB capture JSON; `omittedBefore` for dropped rows; unchanged-target failures skip publication | `gemini-observation.ts`, `fixture-observation.ts`, `pending-connections.ts` |
| Observation buffer per grant | 128 events, 4 MiB; both bounds can expire cursors | `pending-connections.ts` |
| Event wait | 20 s maximum, 2 events per call, 200 ms polling | `mcp-stdio.ts` |
| Prepared text | 4,000 UTF-8 bytes; Gemini also 2,048 UTF-16 units, no surrounding whitespace, no carriage return | `message-operations.ts` |
| Preparation | 3 min; 100 active and 10,000 recorded; keys kept one day after expiry; unresolved intents never pruned | `message-operations.ts` |
| Consents | At most 2 min each, clipped; review lists show 8 | `message-operations.ts` |
| Browser leases | Fill, proof and submit 4 s; one pending fill shared by providers; one pending submit; 16 proofs or preflights | `message-operations.ts` |
| Facade requests | 5 s except connection pickup; keepalive every 60 s when idle; idle sockets drop after 150 s | `broker-client.ts`, `broker-ipc.ts` |
| Broker capacity | 16 sockets; 16 queued requests per socket | `broker-ipc.ts`, `broker-roles.ts` |
| Agent registry | At most 16 authenticated facade instances, within the shared socket cap; labels 1-80 printable ASCII characters | `pending-connections.ts`, `broker-roles.ts` |
| Native frames | 256 KiB; relay queue 16 | `native-framing.ts`, `native-relay.ts` |
| Browser submit markers | 10,000 operation IDs, no eviction | `fixture-observation.ts` |

## Private Protocol

- Broker sockets and Native Messaging use the same framing: UTF-8 JSON with a native-endian 32-bit length prefix, at most 256 KiB, in the envelope `{ kind, protocolVersion: 1, requestId, connectionGeneration: 0, deadlineMs, payload }`. Every schema is strict. Deadlines are absolute and only ever clipped, never extended.
- Each broker socket authenticates once as `facade` (the MCP owner of grants and operations) or `relay` (the native host). Facade-only requests query state and start reads, preparation, fills, proofs and commits. Relay-only requests list and approve pending requests and reviews, list and complete browser challenges and jobs, publish snapshots, mark gaps and revoke grants. Facades cannot approve or complete browser work, and relays cannot read, prepare, fill or commit for an owner.
- A facade hello may carry an optional `agentLabel` in its strict payload; relay hellos may not. The broker, never the client, creates `agentId`. Provider-neutral relay-only `list_chat_agents { target }` returns `chat_agents { agents: [{ agentId, label, connectionCount }] }`; IDs/labels are owner descriptors, not connection handles. `remove_chat_agent { target, agentId }` and `disconnect_chat { target }` return `chat_agent_removed { revoked, remainingAgents }`. Targets use the existing strict fixture/Gemini schema, with exact document and Gemini URL; the trusted worker pins the selected tab/document before and after each request. Removal replies describe the state at broker execution, not a promise that no later human approval occurred.
- Relay-only `list_available_agents {}` uses the same descriptor reply without target access; its zero counts are placeholders, not a verified chat roster. A target-specific row includes optional `autonomous: true` only when that owner has a matching autonomous grant. Relay-only `approve_chat_agent { target, agentId }` returns `chat_agent_approved { agentId, expiresAt: null }`, never connection handles. Facade-only `wait_for_connection { timeoutMs }` returns `connection_pickup { connections, timedOut }` for that owner. Ready connection states include observation metadata. Strict bounds, original deadlines and role checks apply through every transport.
- Write jobs (Gemini fill, Gemini proof and every submit job) are offered once and never re-offered. Read challenges and fixture fill and proof checks are listed until answered or expired; one-shot attempt IDs in the page stop a second fixture fill. Lost or late results become uncertainty, never retries.
- Relay-only `begin_chat_reload { target }` returns `chat_reload_started { preserved }`; it suspends existing autonomous grants, revokes legacy grants and clears old observations/reads. `rebind_chat { previous, target }` returns `chat_rebound { rebound }`; only a different document on the same exact approved chat/tab may rebind, and only still-authorized suspended grants. Neither command creates approval or restores removed owners. Suspended grants remain removable and tracked for cleanup, but cannot serve reads/publications or be picked up until rebound. The worker serializes updates and verifies identity before/after rebind, pins the full fixture URL too, and reinstalls observers. Failure/uncertainty attempts pinned-target disconnect; it cannot prove revocation if the bridge is unavailable. Cursors expire across reload; handles and `generation: 1` remain unchanged. No write job is replayed.
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

- `entrypoints/background.ts`: service worker with native watches, approvals, consent handlers, fill, proof and submit executors, revocation and native-bridge diagnostics.
- `entrypoints/popup/`: trusted popup, including local loaded-build metadata.
- `lib/fixture-observation.ts`: fixture page functions and the persistent submit reservation (`reserveBrowserSubmitAttempt`).
- `lib/gemini-observation.ts`: Gemini page functions for eligibility, identity, observation, capture, inspection, fill, submit and diagnostics.
- [packages/extension/wxt.config.ts](packages/extension/wxt.config.ts): manifest, production fingerprint and pre-archive verification hooks, disabled source archives and unchanged required/optional permissions.
- [packages/extension/build-fingerprint.ts](packages/extension/build-fingerprint.ts): Node-only artifact hashing and offline consistency verification; not a browser or broker module.
- [packages/extension/verify-build.mjs](packages/extension/verify-build.mjs): fixed-target read-only verification CLI with sanitized failure output.

Tests: `tests/fixtures/` holds the synthetic chat page and server. `tests/e2e/extension-probe.test.mjs` covers full-stack admission, reads and fills; `tests/e2e/extension-dispatch.test.mjs` covers autonomous/supervised dispatch, loss and crashes. Both use disposable Chromium, broker and native host through shared `extension-harness.mjs` readiness/timing helpers. `tests/e2e/fixture-editor.test.mjs` and `tests/e2e/gemini-observation.test.mjs` test page functions on synthetic pages. `tests/diagnostics/clock-probe.c` is optional and must not run without explicit authorization.

## Testing

| Script | Effect |
| --- | --- |
| `npm run build` | Companion `tsc` and extension `wxt build` |
| `npm run verify:extension` | Read-only consistency check of completed production extension output; never rebuilds or opens a browser |
| `npm run package:extension` | Rebuilds and verifies the default production Chrome extension, then creates its ZIP; no source archive or installation |
| `npm run typecheck` | Both packages |
| `npm run test:unit` | Runs fixture and compiled companion tests; build first, reuses the gate's existing build |
| `npm run test:unit:build` | Builds the companion, then runs all units; standalone convenience |
| `npm run test:e2e` | Runs all E2E files through bounded parallel/serial groups; build first |
| `npm run test:e2e:focus -- <node-test-options> <file>` | Single-worker focused E2E run against existing built artifacts |

The exact gate before every source commit (AGENTS.md):

```bash
npm run build && npm run typecheck && npm run test:unit && npm run test:e2e
```

Fast edit loop: build once after checkout, then rebuild only the package whose source changed. Run a behavior-scoped test immediately after each edit; run the full gate at meaningful source checkpoints, not after every probe. Never use stale build output. Documentation-only edits need scoped content/link/whitespace checks instead of a source gate.

Focused runs (both packages must already be built for E2E):

```bash
npm run build:companion && node --test --test-name-pattern='<regex>' packages/companion/dist/<module>.test.js
npm run build:extension && npm run test:e2e:focus -- --test-name-pattern='<regex>' tests/e2e/<file>.test.mjs
```

Use `extension-dispatch.test.mjs` for public sends and private submit/loss cases, and `extension-probe.test.mjs` for popup admission/read/fill cases. A focused public send took about five seconds in the initial benchmark; timing depends on the machine and power state.

`tests/e2e/run.mjs` discovers every E2E test file. Independent cases run with two isolated file workers. Six composite cases (fixture private-submit matrix, fixture crash matrix, both provider roster-race matrices, Gemini read workflow and Gemini inspector matrix) run serially through complementary name filters; their aggregate deadlines made all-parallel execution unreliable. Profiles, brokers and authority are never shared. New unmatched tests enter the parallel group; update the serial pattern when adding a composite case. A failed group stops the gate without an automatic retry. Keep the original case deadlines, polling, sandbox and assertions.

Shared `extension-harness.mjs` helpers include a 32-event synthetic-only native-job trace with counts, fixed result codes and relative timing, never text/targets/receipts. The supervised Gemini fault injector captures its mode before awaiting browser execution; a fake deferred-call regression verifies later modes cannot alter an earlier invocation. Public connection tests use genuine Enter activation with visible/enabled and trusted-user-gesture assertions to avoid background-popup mouse stability waits; this is not installed-toolbar acceptance.

Browser-test rules: launch Chromium with `chromiumSandbox: true`, because Playwright otherwise adds `--no-sandbox`; use disposable profiles and an isolated HOME broker; wait for the current-user, owner-only socket before connecting; keep the original timeouts and assertions. Test copies of the extension may get temporary host permissions, and automated popup navigation does not grant `activeTab`, so these tests do not prove real toolbar approval. Installed-toolbar and live checks are separate, human-assisted evidence.

## Troubleshooting

- `BROKER_UNAVAILABLE`: start `npm run dev:broker`; the facade reconnects on the next call. Read-only calls can then be repeated, but an uncertain fill or commit must not be.
- `CONNECTION_NOT_FOUND` or `stale`: a legacy grant expired or reloaded; the tab navigated/closed; conversation changed; extension reloaded; or MCP restarted as a new owner. Reconnect through the popup. Autonomous reads are temporarily unavailable during exact-chat reload; after successful rebind, take a fresh snapshot rather than reuse an old cursor.
- `OBSERVATION_UNAVAILABLE`: no valid capture answered the fresh challenge within four seconds. Missing/ambiguous row content with unchanged identity is skipped, not revoked; a later read may recover. Stopped native watches resume polling with bounded 1-10 s backoff while a tracked grant remains. Neither behavior retries an uncertain fill or send. Worker wake still marks an observation gap.
- No pending request in the popup: the request expired after 60 seconds, or the selected tab is not the fixture or an eligible saved Gemini chat.
- Native bridge unavailable: check the registration with `--preview`, the extension ID, the launcher path and that the manifest is in the profile Chromium is using.
- Tools missing or outdated: rebuild and restart the MCP server.
- `Refusing to recover ...` at broker start: inspect ownership and modes under `~/.config/agent-messaging-mcp` by hand; never loosen the checks.

## Live-Chat Rules

Use only disposable chats in the development profile, with fresh human authorization for each live read. A live connector fill needs explicit approval of the exact chat and text, and a live send needs a separate approval. Never clear or submit a draft the person typed. Do not store chat text, full URLs, IDs or recovery tokens in documents, logs or memory. Details are in AGENTS.md.

### Manual Post-Fill Control Review

Use only after fresh authorization for the exact selected disposable Gemini chat. This one-shot read-only Console probe mirrors composer/Send checks and snapshot row selectors, emitting only fixed metadata. `readShape` describes at most the newest 32 rendered row structures, never their text; overflow and wrapper/query-line counts can reveal unsupported structure but do not prove capture or publication succeeded. It does not read draft/message text, click, focus, fill, send or clear anything. Leave the existing draft untouched. Do not bypass paste protection or rerun automatically; return only its JSON, never other logs, URLs or screenshots.

```js
(() => {
   const emit = value => console.log(JSON.stringify(value));
   if (window.top !== window || location.origin !== "https://gemini.google.com"
      || !/^\/app\/[A-Za-z0-9_-]{1,128}\/?$/.test(location.pathname)) return emit({ code: "UNSUPPORTED_CHAT" });
   const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
   const regions = [...document.querySelectorAll("main, [role=main]")].filter(visible);
   const timelines = regions.length === 1 ? [...regions[0].querySelectorAll("infinite-scroller")].filter(visible) : [];
   const describe = element => {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(centerX, centerY);
      const clearAncestors = ![element, ...function* () {
         for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) yield ancestor;
      }()].some(ancestor => getComputedStyle(ancestor).visibility !== "visible" || Number(getComputedStyle(ancestor).opacity) === 0);
      return { insideMain: regions.length === 1 && regions[0].contains(element),
         insideTimeline: timelines.some(timeline => timeline.contains(element)),
         blocked: Boolean(element.closest("[inert], [aria-hidden=true], [aria-disabled=true], [aria-readonly=true]")),
         centerInViewport: centerX >= 0 && centerY >= 0 && centerX < innerWidth && centerY < innerHeight,
         unobstructed: clearAncestors && Boolean(hit && (hit === element || element.contains(hit))) };
   };
   const editors = [...document.querySelectorAll("[contenteditable=true]")].filter(element => visible(element)
      && (element.getAttribute("aria-label") === "Enter a prompt for Gemini" || element.getAttribute("placeholder") === "Enter a prompt for Gemini"));
   const controls = [...document.querySelectorAll('button[aria-label="Send message"]')].filter(visible);
   const rendered = element => element.getClientRects().length > 0;
   const readRegions = [...document.querySelectorAll("main, [role=main]")].filter(rendered);
   const readTimelines = readRegions.length === 1 ? [...readRegions[0].querySelectorAll("infinite-scroller")]
      .filter(element => rendered(element) && element.querySelector("user-query, model-response")) : [];
   const rows = readTimelines.length === 1 ? [...readTimelines[0].querySelectorAll("user-query, model-response")].filter(rendered) : [];
   const readShape = { regions: readRegions.length, timelines: readTimelines.length, totalRows: rows.length,
      rowsOverflow: rows.length > 32, rows: rows.slice(-32).map(row => {
         const outgoing = row.localName === "user-query";
         const blocks = row.querySelectorAll(outgoing ? "user-query-content" : "model-response-content");
         return { direction: outgoing ? "outgoing" : "incoming", visible: visible(row),
            directTimeline: row.closest("infinite-scroller") === readTimelines[0], contentBlocks: blocks.length,
            queryLines: outgoing && blocks.length === 1 ? [...blocks[0].querySelectorAll("p.query-text-line")].filter(rendered).length : null };
      }) };
   emit({ code: "CAPTURED", visible: document.visibilityState === "visible", regions: regions.length, timelines: timelines.length,
      editors: editors.slice(0, 8).map(element => ({ ...describe(element), editable: element.isContentEditable,
         nested: Boolean(element.parentElement?.closest("[contenteditable]")),
         embedded: Boolean(element.querySelector("[contenteditable], input, textarea, [role=textbox]")) })), editorsOverflow: editors.length > 8,
      controls: controls.slice(0, 8).map(element => ({ ...describe(element), type: ["submit", "button", "reset"].includes(element.type) ? element.type : "other",
         disabled: element.matches(":disabled") })), controlsOverflow: controls.length > 8, readShape });
})();
```

### Manual Completion-Metadata Review

After explicit read-only authorization and confirmation of the exact selected disposable saved chat, run this in that chat's DevTools Console. Start it before manually submitting one non-sensitive prompt. It samples for 60 seconds, stops on a URL/visibility change, and prints only fixed control metadata. It never clicks, focuses, fills, sends or reads message bodies; the selected URL stays local for the identity guard and is never printed. Use an existing chat with a stable saved route, not a new blank chat. Do not bypass paste protection or change security settings if the console blocks it; report the block.

The follow-up version below distinguishes an absent busy attribute from explicit `false` on the newest response and its visible descendants. Obtain fresh bounded authorization before any additional capture; do not rerun automatically. Missing state, overflow or an unexpected value remains inconclusive.

```js
(async () => {
   const emit = (code, samples) => console.log(JSON.stringify({ code, samples }));
   if (window.top !== window || location.origin !== "https://gemini.google.com"
      || !/^\/app\/[A-Za-z0-9_-]{1,128}\/?$/.test(location.pathname)) return emit("UNSUPPORTED_CHAT", []);
   const selected = location.href;
   const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
   const busyValue = element => {
      const value = element.getAttribute("aria-busy");
      return value === null ? "absent" : value === "true" || value === "false" ? value : "other";
   };
   const labels = new Map([["Send message", "send-message"], ["Send", "send"], ["Stop response", "stop-response"],
      ["Stop generating", "stop-generating"], ["Stop", "stop"], ["Copy response", "copy-response"],
      ["Copy", "copy"], ["Good response", "good-response"], ["Bad response", "bad-response"]]);
   const describe = control => {
      const icons = [...control.querySelectorAll("mat-icon, [data-mat-icon-name], .google-symbols, .material-symbols-outlined, .material-icons")];
      const hasIcon = name => icons.some(icon => icon.getAttribute("data-mat-icon-name") === name || icon.textContent?.trim() === name);
      return { label: labels.get(control.getAttribute("aria-label")) ?? "other", sendClass: control.classList.contains("send-button"),
         disabled: control.matches(":disabled"), ariaDisabled: control.getAttribute("aria-disabled") === "true",
         sendIcon: hasIcon("send"), stopIcon: hasIcon("stop") };
   };
   const samples = [];
   const started = performance.now();
   let previous;
   let code = "CAPTURED";
   while (performance.now() - started < 60_000) {
      if (location.href !== selected) { code = "CHAT_CHANGED"; break; }
      if (document.visibilityState !== "visible") { code = "NOT_VISIBLE"; break; }
      const regions = [...document.querySelectorAll("main, [role=main]")].filter(visible);
      const timelines = regions.length === 1 ? [...regions[0].querySelectorAll("infinite-scroller")].filter(visible) : [];
      if (timelines.length !== 1) { code = "AMBIGUOUS_TIMELINE"; break; }
      const rows = [...timelines[0].querySelectorAll("user-query, model-response")].filter(visible);
      const reply = rows.filter(row => row.localName === "model-response").at(-1);
      const busyNodes = reply ? [...reply.querySelectorAll("[aria-busy]")].filter(visible) : [];
      const composer = [...regions[0].querySelectorAll('button.send-button, button[aria-label="Send message"], button[aria-label="Send"], button[aria-label*="Stop" i]')].filter(visible);
      const actions = reply ? [...reply.querySelectorAll("button, [role=button]")].filter(visible) : [];
      const state = { rows: rows.length, tail: rows.at(-1)?.localName === "model-response" ? "incoming" : rows.length ? "outgoing" : "none",
         composer: composer.slice(0, 8).map(describe), composerOverflow: composer.length > 8,
         replyActions: actions.slice(0, 8).map(describe), replyActionsOverflow: actions.length > 8,
         replyBusy: { row: reply ? busyValue(reply) : "no-reply", descendants: busyNodes.slice(0, 8).map(busyValue), overflow: busyNodes.length > 8 },
         busy: Boolean(reply && (reply.matches('[aria-busy="true"]') || [...reply.querySelectorAll('[aria-busy="true"]')].some(visible))),
         progress: [...regions[0].querySelectorAll('mat-progress-spinner, [role="progressbar"]')].filter(visible).length };
      const fingerprint = JSON.stringify(state);
      if (fingerprint !== previous) { samples.push({ elapsedMs: Math.round(performance.now() - started), ...state }); previous = fingerprint; }
      if (samples.length >= 32) { code = "CHANGE_LIMIT"; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
   }
   emit(code, samples);
})();
```

Report only the emitted JSON and whether the reply visibly finished during the capture. Do not paste other console logs, raw HTML, screenshots, chat text or URLs. These samples identify candidates for review, not a completion claim; missing/unrecognized controls, overflow or an interrupted capture remain inconclusive. No product authority, general browser-control bridge or automatic retry is created.
