# Browser Chat MCP: Design and Implementation Plan

Status: accepted architecture, partly implemented as a local prototype. Original research: 2026-09-25. Implementation review: 2026-10-09.

Sections 1-16 keep the original research and rationale. Paragraphs marked **Implementation note (2026-10-09)** record where the prototype differs. Section 2 states the decided target experience, section 17 records decisions D1-D13, and **Decision (2026-10-09)** paragraphs mark where they change the original plan. Current status, evidence and the next step are in the dashboard at the top of [HANDOFF.md](HANDOFF.md); setup and tool reference are in [DEVELOPMENT.md](DEVELOPMENT.md).

## 1. Recommendation

Build a **browser-chat integration**, not a general browser automation MCP server:

- A browser extension lets the user explicitly connect the tab and conversation they already have open.
- A local broker manages authorization, conversation bindings, message observations, and outgoing operations.
- An MCP interface exposes a small set of chat operations with structured results.
- A generic, user-configurable DOM adapter covers conventional chat layouts; reviewed site adapters handle applications such as Gemini and WhatsApp Web.
- Use TypeScript throughout. Use the official MCP SDK, WXT for extension development, and Playwright for feasibility experiments and end-to-end testing.
- For reliable rich-text input, use a narrowly implemented browser-debugger input driver inside the extension. Do not expose raw debugger commands or arbitrary JavaScript to the agent.

**The important qualification:** generic discovery is achievable; universally reliable sending and complete history extraction from every chat website are not. The product should publish capabilities and refuse unsupported operations rather than guess.

For the first supported AI-chat integration, use Gemini's browser interface. It is a representative target, not an architectural dependency. No model-provider API integration is necessary.

## 2. Scope and Product Contract

### Target experience (decided 2026-10-09)

1. The person installs the extension and starts the MCP server in VS Code.
2. In the browser that has the extension, they open a Gemini chat and click **Connect this chat** in the extension popup once.
3. From then on the agent reads and sends messages in that chat without further intervention.
4. Closing the tab, switching to another chat, or restarting the browser or VS Code ends the connection. Reloading the same chat keeps it.

For now everything runs in the Podman devcontainer (D12), and the chat tab must stay visible, though its own window is fine; later a hidden tab must work too (D11). Section 17 records the decisions behind this. The original scope below assumed per-message approval; where it differs, the target experience wins.

### Initial scope

- Desktop Chrome and Edge, one local user, an ordinary HTTP(S) browser tab.
- Existing login sessions remain in the user's browser; login and MFA remain manual.
- One explicitly selected conversation per connection, initially one active writer.
- Read currently rendered messages and retain subsequently observed messages in a bounded, temporary buffer.
- Send plain text, including multiline text and Unicode, through the website's composer.
- Observe incoming messages and revisions to streaming AI responses.
- Give the user a persistent connection indicator, outgoing-message approval, pause, and disconnect controls.

The software may use command-line launchers for installation and MCP startup, but the **chat target is always a browser UI**, not a terminal chat application.

### Not part of the first release

- Native desktop applications, mobile browsers, or arbitrary operating-system window control.
- Automatic login, CAPTCHA handling, account creation, or evasion of platform controls.
- Bulk outreach, contact harvesting, unattended cross-conversation navigation, or built-in bot-to-bot orchestration.
- Attachments, voice messages, reactions, edits, deletes, and automatic link opening.
- Complete server-side history, guaranteed recipient delivery, or guaranteed real-time operation while the browser is suspended.
- A hosted service, distributed database, plugin marketplace, or an LLM embedded in the MCP server.

## 3. Browser Access: Options and Decision

| Approach | Existing logged-in tab | Main benefit | Main drawback | Decision |
| --- | --- | --- | --- | --- |
| Custom WebExtension and local bridge | Yes, after user authorization | Purpose-built selection, observations, approvals, and revocation | Extension and native-host installation; rich editors need additional input support | Recommended product architecture |
| Existing Playwright extension and Playwright MCP | Yes | Already provides a consent and tab-selection workflow | Broad browser permissions and general automation surface; no chat semantics | Use as the feasibility baseline |
| Playwright attached through a remote-debugging endpoint | Only if debugging access was enabled | Mature automation API | Not a universal attach-to-any-running-browser mechanism | Optional developer backend later |
| Playwright-managed persistent browser profile | Requires a separate browser session and login | Predictable, testable environment | Does not deliver the desired existing-tab experience | Useful alternative if extensions are unacceptable |
| Screenshot/OCR and OS mouse control | Visually, yes | Can reach non-DOM interfaces | Focus, layout, scaling, attribution, and duplicate-detection problems | Not a default; no blind visual sending |
| Official messaging/provider APIs | Independent of the browser UI | Usually the strongest delivery contract | Different permissions and scope; does not operate the selected UI conversation | Separate integration, not a replacement for this request |

### Why not simply use Playwright for everything?

Playwright is well suited to controlled browser automation. Its Chrome extension already lets a user choose an existing tab and reuse login state. This is useful prior art and a fast way to demonstrate the basic idea. [1]

However, attaching to a tab does not answer the domain questions: which elements are actual messages, which conversation is authorized, whether a streaming reply is finished, and whether retrying a send will duplicate it. A chat-specific layer remains necessary with any browser-control library.

The proposed custom extension is justified by its chat picker, browser-owned approval UI, continuous DOM observation, and enforcement close to the selected tab. Do not fork Playwright or rely on undocumented extension-transport internals. Start the feasibility work with its documented extension mode; it remains a viable smaller solution if general browser access and best-effort chat handling turn out to be sufficient.

Ordinary CDP attachment is not an alternative to obtaining permission. Playwright documents Chromium-only support and lower fidelity for `connectOverCDP`. Chrome 136 also stopped honoring remote-debugging switches against the default user-data directory. Do not design around silently attaching to an arbitrary daily-use profile or copying its cookies. [2][3]

## 4. User Experience

### First-time setup

1. Install the browser extension and local companion package.
2. Register the companion's native-messaging host for that browser and OS user.
3. Add the MCP server to the agent host. The launcher starts or connects to the local broker.
4. Open and log in to the desired chat website normally.

Installation should ultimately be handled by one companion installer per supported OS. An extension alone cannot install its native host. In the current development setup, both the browser and native host will run inside the same Podman devcontainer. A containerized companion cannot register a host for a separate browser running on Windows or WSL.

### Connect a conversation

1. The agent requests a connection. The broker creates a short-lived pending request without reading any tab.
2. The user brings the desired tab to the foreground and clicks the extension's **Connect This Chat** action.
3. The extension shows the pending client request and detects the active conversation.
4. For a known application, it previews the detected conversation, recent message boundaries, and composer. For an unknown application, the user calibrates these elements.
5. The user approves that connection in the extension's own UI and chooses read-only or send-with-approval mode.
6. The agent receives an opaque connection handle and capability report, not unrestricted browser access.

This is the practical equivalent of the proposed window click: **activate the tab, then invoke the extension**. Merely clicking an operating-system window does not grant DOM access. A screen-sharing picker supplies pixels, not message structure or control rights.

The browser's `activeTab` grant requires a supported user gesture. It can survive same-origin navigation, but it is revoked on cross-origin navigation or tab closure. Application authorization must be narrower than this: selecting another conversation on the same origin must not silently authorize that conversation. [4]

**Decision (2026-10-09, D13 and D1):** The person starts the connection from the popup with **Connect this chat**, and the MCP agent picks it up with a dedicated tool instead of creating a pending request first. One approval grants reading and autonomous sending in that chat, so the target flow has no read-only or send-with-approval choice. The existing agent-first request flow remains for tests.

### While connected

- Show the origin, conversation identity, connected client, read/write mode, and connection health in an extension panel.
- Review exact outgoing text and the intended conversation in that panel; approvals never come from page content.
- An injected highlight can help select elements, but it is not an authorization surface because the page can imitate or manipulate it.
- Preserve existing user drafts. Pause writes when unexpected user interaction or a changed conversation is detected.
- Disconnect revokes queued actions, stops observation, releases debugger attachment, and makes buffered content inaccessible through that connection. It does not close the user's tab or log them out.

## 5. Architecture

```mermaid
flowchart LR
    Agent[Agent / MCP host] <-->|MCP stdio| Facade[MCP facade]
    Facade <-->|Private local IPC| Broker[Local chat broker]
    Broker <-->|Private local IPC| Native[Browser-spawned native host]
    Native <-->|Native Messaging| Extension[Extension service worker and panel]
    Extension <-->|Typed messages| Content[Content script and chat adapter]
    Content <-->|Observe and inspect DOM| Chat[User-selected chat tab]
    Extension -->|Guarded debugger input| Chat
```

### Component responsibilities

| Component | Responsibilities |
| --- | --- |
| MCP facade | Tool schemas, result formatting, client compatibility, cancellation, and optional resource notifications |
| Broker | Connection ownership, grants, operation journal, event cursors, deadlines, rate limits, and write serialization |
| Native host | Small transport relay between the browser and broker; no chat parsing or general command execution |
| Extension service worker | Validate browser message senders, enforce selected targets, route observations, execute approved input operations, and handle browser lifecycle events |
| Extension panel | Connection approval, calibration, pending-message review, pause, and revoke controls |
| Content script and adapters | Resolve message/composer elements, identify conversations, normalize messages, and observe UI changes |

Use one installed Node package with separate launcher modes for the facade, broker, and native host. These are small processes with different lifecycles, not separate services requiring a distributed deployment.

**Implementation note (2026-10-09):** The facade, broker and native relay are separate compiled entry points in `packages/companion/dist`. There is no separate content script or side panel: the service worker injects self-contained, reviewed page functions with `scripting.executeScript` into the exact approved document, and the toolbar popup is the trusted panel.

### Why a native bridge?

Native Messaging avoids exposing an unauthenticated browser-control HTTP or WebSocket listener. The host manifest names the exact allowed extension ID. The extension uses `runtime.connectNative` for bidirectional communication. [5]

The native host is **spawned by the browser**, while an MCP stdio server is normally spawned by the MCP client. They cannot both own the same process's standard streams. Native Messaging also uses length-prefixed JSON, whereas MCP stdio uses newline-delimited JSON. A relay and private local IPC explicitly resolve this difference.

On Linux/macOS, use a Unix-domain socket in a user-private runtime directory. On Windows, use a named pipe restricted to that user. Authenticate facade registrations, restrict the native relay role, and use an atomic singleton startup mechanism for the broker. Do not trust a client-supplied display name as authentication.

Version the internal message protocol. Include request IDs, connection generation, deadlines, and validated payload types. Bound and chunk observation batches below the native host's 1 MiB outbound message limit; a 256 KiB application envelope limit is a reasonable starting point. [5]

## 6. Browser Permissions and Input

The control-capable extension requires `activeTab`, `scripting`, `storage`, `nativeMessaging`, and `debugger`, plus `sidePanel` if the Chrome side-panel API is used. Avoid blanket host permissions and browser-history/cookie permissions. Inject scripts only after the user selects a tab.

**Important permission tradeoff:** Chrome does not allow `debugger` in `optional_permissions`. It must be declared as a required permission for the control-capable extension. A runtime checkbox cannot turn a low-permission extension into a debugger-enabled one. [6]

The debugger permission is powerful and is not technically restricted by `activeTab`. Selected-tab restrictions must therefore be enforced by trusted extension code. Read-only mode reduces what this application permits, not the installed extension's underlying maximum privilege. A separately packaged no-debugger edition is possible later, but is not necessary for the MVP.

### Sending through modern editors

Do not assume assigning `textarea.value`, setting `innerHTML`, or dispatching a synthetic keyboard event reproduces user editing. Framework-controlled inputs and rich-text editors can reject these changes or keep different internal state. Script-dispatched events are not trusted browser input. [7]

Use a small, typed input driver over `chrome.debugger`, limited to the selected tab and operations needed by the adapter: focus the verified composer, insert text, activate the verified send control, and inspect the resulting UI state. Prefer the actual send button; use Enter only when the adapter knows the site's configured submit behavior. Never paste through the user's clipboard.

The agent cannot choose CDP methods, coordinates, selectors, or executable expressions. The extension resolves and checks targets itself. Do not expose network interception, cookie extraction, arbitrary navigation, or an unrestricted evaluate tool.

Debugger access improves input reliability; it does not guarantee acceptance by every website or bypass browser/platform restrictions. Handle attachment rejection, user cancellation, and DevTools-triggered detachment explicitly. [8]

**Implementation note (2026-10-09):** The connected fill and submit paths do not use `chrome.debugger`. They run reviewed page functions in the approved document: one `document.execCommand("insertText")` call to fill, whose browser-generated input events tested as trusted in synthetic pages, and one script-initiated `click()` on the verified Send control, which is not trusted user input. Identity, focus, draft and lease checks surround both. Fixture tests and one installed fixture send passed; live Gemini acceptance of either step is unverified. `debugger` stays declared only for two legacy popup probes, one of which types a fixed sentence into a real Gemini composer outside the operation ledger. Decision D6 covers removing them and the permission.

## 7. Connections and Authorization

A connection is an application-level binding, not an MCP transport session.

Internally bind:

- Authenticated local client identity and a broker-minted connection ID.
- Browser-profile installation identity and current browser instance.
- Tab ID, frame/document identity, and a monotonically changing connection generation.
- Exact origin and adapter-provided conversation/account identity when observable.
- Granted operations, expiry, approval policy, and any rate/message limits.

Every read and action checks ownership and the current grant. Every write also checks generation, document, conversation, composer, and approval. An opaque handle is not a substitute for authorization.

Use stable conversation identifiers from the visible URL or supported DOM metadata when available. A display title alone is insufficient: different conversations can have identical names, and an AI chat can rename itself. For supported new-chat flows, an adapter may recognize the expected transition from an unsaved chat to its newly assigned conversation ID after submission. Unknown identity transitions require reconnection.

Suggested connection states are `pending`, `calibrating`, `ready_readonly`, `ready_write`, `paused`, `stale`, and `disconnected`. A stale or paused connection never executes queued writes automatically on recovery.

Reloads require a fresh document check; browser or broker restarts invalidate active write grants. Cross-origin navigation, account changes, unexpected conversation changes, or revocation invalidate pending approvals. A tab ID reused later cannot revive an old connection.

**Implementation note (2026-10-09):** Implemented connection states are `pending`, `expired`, `ready_readonly` and `stale`, plus `unknown` for foreign or forgotten requests. Every approval is read-only; write authority comes only from per-operation trusted consents (section 10), so `calibrating`, `ready_write` and `paused` do not exist. Grants last five minutes without renewal (decision D2), `generation` is always 1, and reapproval creates a new connection. A grant binds the owning facade socket, tab, Chrome document ID, origin and conversation ID, plus the exact saved-chat URL including any query for Gemini. Browser-instance identity is approximated by revoking all grants when the extension worker starts fresh.

**Decision (2026-10-09, D2):** Connections have no fixed expiry. They end when the tab closes, the tab shows another chat, the browser or MCP server restarts, or the agent or person disconnects. A reload of the same chat re-attaches to the new document after an observation gap. This needs host permission for the chat's site, requested once during **Connect this chat**, because `activeTab` ends on navigation. A connection with an unresolved send stays readable but pauses sending (D10).

## 8. Generic Adapter Strategy

Use progressive support, not a universal selector or a model making a fresh guess for every message.

| Level | How it works | Supported behavior |
| --- | --- | --- |
| Reviewed site adapter | Versioned adapter for a known UI, initially Gemini | Highest confidence in conversation identity, messages, editor input, and streaming/submission indicators |
| Calibrated generic adapter | User identifies relevant elements; saved declarative profile | Basic reading and sending only where identity and writer checks pass |
| Automatic discovery | Rank semantic DOM candidates and offer a preview | Setup assistance; no automatic write authorization |
| Unsupported | Missing structure, ambiguous identity, or unsupported editor | Explain the limitation and remain read-only or disconnected |

### Generic calibration

The picker identifies the conversation header/identity region, message-list container, a representative message row, composer, and send control. Optional mappings identify sender, direction, timestamps, and generation status. Preview multiple rows, including both directions when possible, before accepting a profile.

Prefer semantic roles, accessible names, labels, stable attributes, and scoped relative selectors. Avoid absolute XPath and deep positional selectors as primary identifiers. Use `dom-accessibility-api` for accessible-name/role semantics rather than inventing an accessibility parser. Reading DOM/ARIA attributes is not equivalent to having the browser's entire accessibility tree.

Save profiles as bounded declarative configuration: origin, structural signature, selectors, supported editor strategy, and validation rules. Profiles must not contain executable JavaScript. An agent may suggest a repair, but a human must approve a changed target mapping before writes resume.

### Adapter responsibilities

Each adapter implements the same conceptual operations: detect compatibility, identify the conversation, locate the timeline, parse a message row, read the composer, describe input actions, inspect submission evidence, and identify generation state. The broker owns policy, deduplication, cursors, and deadlines; adapters must not reimplement them.

Use bundled, reviewed TypeScript adapters for exceptional application behavior. Sharing the same rich-text editor does not imply two sites share message identity or conversation semantics.

Initially support top-level DOM chat UIs. Open shadow roots can be handled explicitly; cross-origin frames need additional scoped permission and frame tracking. Canvas-only UIs, inaccessible structures, and closed shadow roots without a tested access path are not promised support.

**Implementation note (2026-10-09):** The prototype has two hard-coded targets, the synthetic fixture and Gemini, with no adapter interface or calibration. Each capability is a separate provider-specific family in every layer: ledger methods, 52 private broker request kinds, client methods, native parsers, worker executors and popup commands. Several fixture-named functions are in fact provider-generic. This contradicts the rule above that adapters must not reimplement policy, and every new site would cost a full copy. Target, starting with the autonomous send path (decision D5):

- One target schema with a `provider` field; the fixture becomes one provider.
- Purpose- or phase-parameterized private commands, for example `list_reviews`/`approve_review` with `review`, `fill` or `send`, and `list_jobs`/`complete_job` with `read`, `fill`, `proof` or `submit`, instead of per-provider command families.
- One ledger pipeline. Adapters supply text constraints, the editor kind and the outcome-evidence rule (section 10).
- An extension adapter registry with `eligibleUrl`, `identify`, `observe`, `capture`, `inspectDraft`, `fill`, `submit` and `completion`, each a self-contained reviewed page function.
- Every safety invariant unchanged: trusted consents, exact targets, one-offer leased jobs, durable intent, browser reservation and status-only recovery.

## 9. Reading and Observing Messages

### Observation pipeline

1. Establish conversation identity and install a `MutationObserver` before taking the initial snapshot.
2. Snapshot only the configured timeline, then reconcile buffered mutations so snapshot-to-stream handoff does not lose updates.
3. Parse changed rows into normalized messages and coalesce rapid revisions.
4. Validate source document/generation and append bounded events to the broker's buffer.
5. Return snapshots or incremental events to authorized callers.

Do not repeatedly extract the whole page. Scope observation to the message area, with separate lightweight guards for conversation identity and composer state. Use occasional reconciliation when needed, especially after reconnects or large rerenders; MutationObserver callbacks alone are not proof of completeness.

### Message model

| Field | Meaning |
| --- | --- |
| `messageId` | Local stable identifier within the connection's observation history |
| `nativeId` | Site identifier, when actually available; otherwise null |
| `identityQuality` | Whether identity is native, locally tracked, or uncertain |
| `sender` | Observed sender metadata, with unknown fields left null |
| `direction` | `incoming`, `outgoing`, or `unknown` |
| `text` | Message text preserving meaningful newlines and code formatting |
| `sourceTimestamp` / `timestampRaw` | Parsed timestamp only when justified, plus original UI representation |
| `observedAt` | When this system observed the message, not when the sender sent it |
| `revision` | Increases when the observed message changes |
| `generationState` | `streaming`, `complete`, `settled_heuristic`, or `unknown` |

Do not deduplicate solely by text hash: two legitimate messages can both say "OK". Prefer native IDs; otherwise track local identity conservatively and report ambiguity. Virtualized interfaces recycle DOM nodes, so node identity alone is also insufficient. A content hash is useful for detecting revisions, not proving identity.

Newly discovered DOM rows are observations, not necessarily newly received messages. Distinguish initial snapshots, live observations, and any later history backfill. A row disappearing from a virtualized list is not a deletion; emit a deletion only when the UI supplies corresponding evidence.

For AI responses, publish revisions under one message identity where possible. Use adapter-specific indicators to declare completion. A quiet period, for example 750 ms without edits, can mean `settled_heuristic`, never confirmed completion. A stalled network can look quiet too.

### Coverage, cursors, and retention

Every snapshot includes coverage such as `rendered_only` or `observed_since_connect`, a freshness timestamp, a generation, and an event cursor anchored to that snapshot. Reading is non-destructive: each consumer maintains its own cursor.

An event cursor encodes an observation-stream epoch and sequence, not a website timestamp or message ID. Buffer eviction, a process restart, or an unrecoverable observation gap produces an explicit `CURSOR_EXPIRED` or gap result and a resynchronization path. Never silently jump to the current end.

Keep transcript data in bounded memory by default. Proposed starting limits are 1,000 events or 5 MiB per connection, whichever comes first; make limits configurable and coalesce streaming revisions. Persist adapter profiles and send-operation metadata separately. Do not present the buffer as a complete transcript archive.

Do not automatically scroll for history in the MVP. Later backfill must be separately authorized, bounded by time/message count, restore the viewport when practical, and identify gaps. The website itself may change presence or read receipts while a conversation is open; the integration cannot promise to suppress those effects.

**Implementation note (2026-10-09):** A read sends a fresh broker challenge that the extension must answer within four seconds; a timeline observer throttled to 200 ms publishes later snapshots. Snapshots are capped at 32 rows, 2,048 UTF-16 units per message and 64 KiB, and each grant buffers 32 events or 256 KiB, far below the starting limits above. Events carry full rendered snapshots, at most two per wait call. Gemini rows always report `identityQuality: uncertain` and `generationState: unknown`. Any capture or parse failure revokes the grant, including more rows, a longer message or a row that momentarily lacks its content element, so ordinary Gemini replies can end a connection. Decisions D3 (completion signal) and D8 (window and failure policy) address this.

## 10. Sending Without Blind Retries

Sending has external effects. A successful DOM click is not sufficient evidence that the message was accepted, delivered, or read.

### Prepare, authorize, commit, reconcile

1. **Prepare:** validate the connection, text limits, idempotency key, and target identity. Create an operation bound to the exact text and connection generation. Do not modify the website yet.
2. **Authorize:** display the exact message and target in trusted extension UI. Human approval is bound to the operation, expires quickly, and cannot be supplied as an agent-controlled `approved: true` argument.
3. **Preflight:** acquire the connection's writer lock; recheck the current document/conversation and ensure the composer has no unrelated draft. Confirm the send control is available and unobstructed.
4. **Fill:** enter text using the verified editor strategy. Read it back and compare against the approved content, allowing only explicitly documented editor normalization. Abort on unexpected user edits or identity changes.
5. **Commit:** durably record that dispatch is starting, recheck the target and approval, then activate the send control once. The browser side rejects duplicate operation dispatches within its current generation.
6. **Reconcile:** inspect newly observed outgoing-message evidence and application status. Correlate native message ID, direction, content, and observation ordering when available. Composer clearing alone is not confirmation.

Default policy is approval for each send. A later explicitly granted autonomous mode can be limited to one conversation, a short lifetime, and a small message/rate budget. The agent must not be able to widen that grant itself.

**Decision (2026-10-09, D1):** Autonomous mode is the product default. The single **Connect this chat** approval allows the agent to send in that chat until the connection ends; the agent cannot create, widen or renew it. A runaway guard allows one message at a time and a generous, configurable hourly cap. Every machine-side guard still applies to each message. Because no person reviews individual messages, chat content can steer what the agent sends into that chat (prompt injection), and the approval text must say so. The supervised three-consent flow remains for tests and as an optional stricter mode.

### Implemented authority chain (prototype)

The prototype splits **Authorize** into three separate trusted popup consents and keeps every link's authority distinct. The chain is complete for the fixture; the [HANDOFF.md](HANDOFF.md) dashboard tracks which Gemini links are connected. Checkpoint history is in HANDOFF.md.

1. **Prepare** (`chat_prepare_message`): immutable text bound to owner, connection and exact target. SQLite stores only keyed digests. A private status-recovery receipt is returned.
2. **Ordinary review** (**Approve draft (no send)**): short-lived. The public state `approved` means only this review, never send permission.
3. **Fill consent** (**Allow draft fill (no send)**): a separate token, consumed once before any input.
4. **Fill** (`chat_fill_draft`): one leased browser attempt into an empty editor with exact readback. Lost results are `FILL_UNCERTAIN` and are never retried.
5. **Send consent** (**Approve fixture send** / **Approve Gemini send**): offered only after a successful fill, with its own token and expiry.
6. **Fresh baseline and proof**: a challenged rendered snapshot taken after Send consent, then a read-only exact-draft and Send-control inspection, all inside the original request deadline.
7. **Durable intent**: one `BEGIN IMMEDIATE` SQLite transaction refuses any other unresolved intent and records `dispatching` before consent and proof are consumed.
8. **One-offer job and browser reservation**: the job is offered once and never re-offered. The worker writes and verifies a persistent operation-ID marker before acting.
9. **Guarded activation**: identity, draft, control and lease are rechecked after focus, then one activation. Exceptions after activation begins are uncertain.
10. **Reconcile**: only a unique new outgoing UI row yields `observed_in_ui`; everything else stays `dispatch_uncertain`. Receipts recover status only.

Positive results are UI observations, never acceptance or delivery, and every fill and commit result carries `retryAllowed: false`. In the default autonomous mode, decision D1 replaces the three consents (links 2, 3 and 5) with the single connection approval; the machine-side links stay.

### Gemini outcome evidence (decided, D9)

Fixture evidence relies on stable row IDs. Gemini rows have none, so the staged Gemini job always ends `dispatch_uncertain`. Rule: report `observed_in_ui` only when, under continuous observation since the post-consent baseline (same epoch, no gap), a later snapshot equals the baseline rows followed by exactly one new outgoing row whose text equals the prepared text, optionally followed by incoming rows. Window shifts, duplicates, edits or gaps stay uncertain.

### Unconfirmed sends (decided, D10)

The prototype's durable barrier is global and permanent: one send without evidence blocks every later send in every chat, across restarts. The barrier becomes per connection. After activation, reconciliation watches for a bounded settle window. The exact new outgoing row (D9) means sent. The exact prepared text still in the composer, Send still available and no new outgoing row means not sent, and the agent may send again as a new operation. Anything else leaves the operation unresolved: that chat pauses sending, and the popup offers a one-click **Sent** / **Not sent** resolution. Nothing is resent automatically, and receipts still recover status only. Open sub-question D10a: may the system clear a leftover draft that exactly equals the agent's own not-sent text before the next send?

### Result states

| State | What the caller may infer |
| --- | --- |
| `prepared` / `awaiting_approval` | No submission has occurred |
| `approved` | Permission exists for this exact operation, subject to fresh preflight checks |
| `dispatching` | Submission may be in progress; do not create a replacement operation |
| `observed_in_ui` | Matching outgoing evidence appeared; this may still be a local optimistic echo |
| `accepted_by_service` | The adapter observed a documented UI indicator of service acceptance |
| `failed_before_dispatch` | This operation did not activate submission |
| `unknown` | A submission might have occurred, but its outcome cannot be established |

Recipient delivery/read status is a separate optional observation, never inferred from `observed_in_ui`. Likewise, an AI reply beginning is useful evidence but does not identify a formal provider-side delivery receipt.

**Implementation note (2026-10-09):** Implemented operation states are `awaiting_approval`, `approved` (ordinary no-send review only), `expired`, `stale`, `unknown`, `dispatch_uncertain` and `observed_in_ui`, plus `draftFill` metadata (`fill_approved`, `filling`, `filled`, `failed`, `uncertain`). `dispatching` exists only inside the journal, known pre-activation refusals are reported as `DISPATCH_UNAVAILABLE` instead of `failed_before_dispatch`, and `accepted_by_service` is not implemented.

### Idempotency and crash behavior

Store operation IDs, client-scoped idempotency keys, target identity, a keyed content digest, phase, and available receipt metadata in SQLite. Persist the transition to `dispatching` before issuing input. Avoid storing message bodies in the durable journal by default.

The same key and arguments return the existing operation; reuse with different arguments is an error. A retry of `commit` returns or reconciles the existing operation and does not click again. Restart recovery treats an interrupted dispatch as `unknown`, and new write grants require user approval. Journal retention and the deduplication window must be explicit; expired operation handles are rejected, not replayed.

**Exactly-once delivery cannot be guaranteed through an arbitrary UI.** A crash can occur after the website accepted the message but before the broker saw evidence. Prefer an uncertain result requiring review over an automatic duplicate. If the website itself retries or duplicates a request, the MCP layer cannot provide stronger server-side guarantees than the website exposes.

Serializing agents does not lock out the human or the website. Fresh guards, draft checks, and cancellation reduce races, but cannot make multiple UI actions an atomic transaction. This is another reason to keep uncertain targets read-only and require supervised sending initially.

## 11. MCP Interface

Keep the public tool list small and stable. Per-connection capabilities are returned as data rather than dynamically exposing arbitrary browser tools.

| Tool | Main arguments | Result and behavior |
| --- | --- | --- |
| `chat_request_connection` | Optional user-facing label | Short-lived connection request; waits for browser-side user selection without scraping tabs |
| `chat_get_connection` | Connection request ID | Pending/ready state, connection handle, generation, target summary, capabilities, and health |
| `chat_read_messages` | Connection handle, bounded limit, optional snapshot-pagination token | Structured snapshot, coverage, freshness, and event cursor; no automatic scrolling |
| `chat_wait_for_events` | Connection handle, event cursor, bounded timeout and limit | Incremental observations/revisions/status changes; returns normally on timeout |
| `chat_prepare_message` | Connection handle, expected generation, text, idempotency key | Operation ID, canonical preview, and approval state |
| `chat_commit_message` | Operation ID | Executes only if approved and still valid; otherwise reports the blocking state |
| `chat_get_operation` | Operation ID, optional status-recovery secret | Current status and evidence; receipt recovery cannot restore approval or permit replay |
| `chat_disconnect` | Connection handle | Revokes access and cancels pending work |

Tool names use lowercase letters, digits, underscores, and hyphens for VS Code host compatibility. This table describes the intended interface, not a claim that every argument/capability is implemented. Use shared Zod schemas, bounded inputs, output schemas, and structured tool results. Include a serialized text representation where needed for older clients. Mark reads appropriately; mark sending as a non-read-only external action. Tool annotations help clients present risk but are not access controls.

**Implementation note (2026-10-09):** The prototype adds `chat_fill_draft` for one separately approved unsent fill, plus the diagnostic `browser_chat_feasibility`. `chat_request_connection` takes no label and `chat_read_messages` has no pagination token. Prepare, fill and commit are public for the fixture only; Gemini writes are private and incomplete. Commit accepts only an owned operation ID and always returns `retryAllowed: false`. Inputs use strict Zod schemas and results carry `structuredContent`, but no tool declares an output schema, and most refusals are plain `CODE: No chat was accessed.` text without retry guidance; fill and commit return structured codes. Per-provider availability is in the [DEVELOPMENT.md](DEVELOPMENT.md) tool reference and the [HANDOFF.md](HANDOFF.md) capability matrix.

### Target tools (decided direction, 2026-10-09)

The autonomous flow adds provider-neutral tools; exact names may change during implementation:

- A connection pickup tool that waits a bounded time for a chat the person connected from the popup and returns its handle.
- `chat_send_message { connectionId, text, idempotencyKey }`, which runs fill, proof, intent, activation and evidence internally and returns sent, not sent or unresolved (sending paused), never inviting an automatic resend.
- A wait-for-reply tool that returns the newest incoming reply once it is complete or settled (D3), or times out.

`chat_read_messages`, `chat_wait_for_events`, `chat_get_operation` and `chat_disconnect` stay. The supervised prepare, fill and commit tools stay for the fixture and tests.

Domain failures should be actionable, for example `CONVERSATION_CHANGED`, `DRAFT_PRESENT`, `APPROVAL_REQUIRED`, `ADAPTER_STALE`, `BROWSER_DISCONNECTED`, `CURSOR_EXPIRED`, and `SEND_OUTCOME_UNKNOWN`. Return structured error details with whether a safe retry is possible. A transport failure after dispatch does not become a known send failure.

### Receiving does not automatically wake an agent

The universally useful baseline is `read_messages` plus a bounded `wait_for_events` call, for example 20 seconds with a server-configured cap below the host's tool timeout. Waiting must not hold the writer lock or prevent disconnect/cancellation.

An optional resource template such as `chat://connections/{id}/messages` can support change subscriptions. However, a notification to an MCP client is not a guarantee that its host will start a new model turn or send a reply. An always-on responder needs a separate host/orchestration loop and explicit user authorization. The MCP server is a connector, not that scheduler.

### Current protocol compatibility

As of this research date, the official TypeScript SDK's stable v2 line implements MCP `2026-07-28`. That revision removed protocol-level initialization sessions and changed resource subscriptions to `subscriptions/listen`; older examples using only `resources/subscribe`, a permanent HTTP GET stream, or `Mcp-Session-Id` are not the current protocol shape. [9][10]

Use the official SDK and its documented compatibility facilities for the target hosts, rather than hand-writing either protocol generation. Verify actual VS Code and one other host during the feasibility phase. Keep connection IDs and operation IDs explicit application handles across both generations.

Start with stdio. If resources are added, serve private, immediately stale chat snapshots rather than shared-cacheable transcripts. Treat subscription notifications as hints to read after the last application cursor. Do not depend on transport-level replay for recovery. [10][11]

## 12. Lifecycle and Deployment

### Browser and extension lifecycle

Manifest V3 service workers can terminate and restart. A native-messaging connection keeps the worker alive while connected, but the design must still survive crashes, browser updates, sleep, tab discard, and native-host loss. Keep only recoverable routing state in extension session storage and authoritative operation state in the broker. [12]

On reconnection, establish a fresh document/generation, resnapshot, and report any observation gap. Do not auto-replay pending sends. Background rendering and website updates can be throttled or stopped, so health reports must distinguish connected, observing, stale, and suspended states.

**Implementation note (2026-10-09):** The broker is started by hand (`npm run dev:broker`); the MCP facade only connects and otherwise reports `BROKER_UNAVAILABLE` (decision D4). Each facade process is one owner, so restarting the MCP server or the broker drops that owner's grants and in-memory operations. The worker polls the broker through one persistent native port per provider. If that watch stops after a five-second reply timeout, a parse failure or a disconnect, it restarts only after a new approval or a worker restart, which also marks an observation gap; until then reads and browser jobs time out while the grant still looks ready. Health reporting is limited to snapshot age (`recent` or `old`). Other publications and completions open one short-lived native port each.

**Decision (2026-10-09, D4 and D12):** The MCP server starts the broker itself when none is running, using the existing singleton and recovery checks, and connects at startup so popup-first connections can reach it. The product target stays the devcontainer: container Chromium with the person's Gemini login, plus the native host, broker and MCP server in the same container. Host-browser deployments remain a later option.

### Local, container, and remote hosts

The extension and native companion run where the browser runs. For this project's Podman devcontainer workflow, that means **Chromium, its installed extension, the native messaging host, the broker, and the MCP facade all run inside the same container**. Node/npm and Chromium are installed in the image; WSLg's X11 socket only carries the browser window to Windows. The container browser has its own persistent profile: users log in there manually; the extension cannot attach to existing tabs in Windows or WSL Chromium.

For an eventual non-container desktop deployment, run the native companion alongside the user's chosen desktop browser. Container-based development does not change that product requirement. A broker inside a container cannot access a separate host browser just because both have an address called `localhost`.

Use stdio and private local IPC among processes in the container, with no TCP browser-control listener. The synthetic fixture runs on container port 8787; VS Code may forward it for optional Windows preview, but the devcontainer does not publish a fixed host port. If a future deployment separates the MCP host and browser companion across machines or containers, add an **opt-in authenticated Streamable HTTP facade** through a deliberately configured private tunnel. This is a separate deployment profile, not a reason to expose the browser's debugger port.

The HTTP endpoint must validate Origin and Host, authenticate and authorize every caller, and bind to loopback by default. Use TLS for non-loopback access and the SDK's documented authorization facilities for remote deployments. A tunnel does not replace application authorization; never enable wildcard browser origins or assume CORS alone protects a local control endpoint. [11]

With the agent and browser both inside this devcontainer, remote broker access is unnecessary for the MVP. Defer its packaging and authentication UX unless the target deployment later requires separate locations.

## 13. Security and Privacy

| Risk | Required control |
| --- | --- |
| Agent accesses unrelated conversations | User-selected bindings, authenticated ownership, exact target checks, no arbitrary tab or recipient selection tools |
| Malicious page impersonates approval | Approval only from extension-owned UI; browser-provided sender identity validation; no page-to-native command forwarding |
| Incoming message contains prompt injection | Treat all chat content as untrusted external data, never as system instructions or executable configuration |
| Injection persuades agent to exfiltrate information | Per-message review by default, narrow recipient grants, message limits, and host-side instruction boundaries; sanitization alone is insufficient |
| Misrouted or duplicated send | Fresh conversation/document guards, preserved drafts, one writer, durable operation journal, and explicit unknown outcomes |
| Broad debugger capability is abused | Small reviewed command surface, selected-target enforcement, no raw browser tools, and visible browser/user revocation |
| Local web page probes the companion | Native Messaging and private IPC by default; authenticated, origin-validated HTTP only when explicitly enabled |
| Sensitive conversations persist unexpectedly | Bounded memory buffers, no transcript/screenshot logging by default, restrictive local file permissions, and explicit retention controls |

Render previews as text, not executable HTML. Do not read browser cookies, passwords, unrelated page regions, local storage, or network payloads for convenience. Do not log authorization material. Built-in adapters are reviewed code; configuration profiles cannot download and execute code.

Local operation does not mean chat content stays local after it is returned to an agent: the MCP host may forward it to a cloud model or retain tool logs. Make that boundary explicit during connection approval. The website's encryption protects its own transport, not exported plaintext in an agent context.

The trust boundary excludes a compromised browser, installed companion, extension, or malicious process running with equivalent OS-user access. These controls constrain agent and page behavior; they do not turn a powerful browser extension into a sandbox against its own code.

Respect each site's terms and account rules. Browser automation is not made compliant merely by using the official website. WhatsApp, for example, publishes restrictions on adversarial automation and messaging behavior. Do not promise universal platform approval or evade anti-abuse measures. [13]

## 14. Libraries and Code Organization

| Area | Selection | Reason |
| --- | --- | --- |
| Runtime/language | Node.js 24 LTS and TypeScript | Shared browser/server types and a mature local tooling ecosystem |
| MCP | Official `@modelcontextprotocol/server` v2; documented legacy compatibility when needed | Current protocol support without a homegrown implementation |
| HTTP, if enabled | Official `@modelcontextprotocol/node` integration | Reuse transport/SDK validation instead of designing another protocol |
| Extension build | WXT, Manifest V3, small TypeScript UI | Extension-specific development and packaging; no large UI framework required |
| Validation | Zod v4 | Shared runtime validation for MCP, IPC, adapter profiles, and observations |
| DOM semantics | Native DOM APIs and `dom-accessibility-api` | Incremental observation and standard accessible-name handling |
| Browser input | `chrome.debugger`, with `devtools-protocol` types | Trusted browser input without exposing a general automation API |
| Operation journal | SQLite through `better-sqlite3` | Local transactional state; no database service |
| Tests | Vitest and `@playwright/test` | Deterministic domain tests and real extension/browser workflows |

Pin tested versions when implementation begins. Check native SQLite packaging on each supported OS. WXT does not replace understanding browser permissions or lifecycle rules. [14]

Keep three main code units initially: shared contracts/domain logic, the local companion/MCP package, and the extension with its bundled adapters. Keep tests adjacent to the behavior they cover and share a deterministic fixture-chat application. Do not create a generalized remote plugin platform or multiple browser backends before the first adapter works.

**Implementation note (2026-10-09):** Actual choices are Node 24 with built-in `node:sqlite` (`DatabaseSync`) instead of `better-sqlite3`; `node:test` and `playwright-core` 1.63 with the container's Chromium instead of Vitest and `@playwright/test`; MCP SDK `@modelcontextprotocol/server` and `client` 2.1.0, Zod 4.6.5, TypeScript 5.9.3 and WXT 0.21.4. `dom-accessibility-api` and `devtools-protocol` are unused. There is no shared contracts package: Zod schemas live in the companion, and the extension re-validates native replies with hand-written checks, so every protocol change must be mirrored by hand.

## 15. Implementation Plan and Gates

The following work starts only after approval of the design.

| Phase | Deliverables | Exit criteria | Rough effort |
| --- | --- | --- | --- |
| 0. Feasibility | Existing Playwright-extension experiment; minimal chat fixtures; targeted rich-editor and permission probes; MCP host compatibility check | Select an existing tab; read bounded messages; demonstrate an authorized send on a disposable Gemini conversation; identify native-driver requirements and any policy blockers | 2-3 engineering days |
| 1. Read-only vertical slice | Local broker, native relay, extension connect/revoke UI, basic adapter, MCP request/read/wait/disconnect tools | No access before approval; only selected conversation returned; snapshot/event handoff and revocation work; no writes implemented | 4-6 days |
| 2. Safe sending | Debugger input driver, explicit install-time permission disclosure, prepare/approve/commit flow, durable journal, draft/conflict checks | Rich-editor round trip works; crash/retry tests do not cause a second dispatch; uncertain outcomes are surfaced correctly | 5-8 days |
| 3. Generic support | Calibration picker, declarative profiles, Gemini-specific streaming/identity behavior, second distinct chat integration | Known site works without calibration; an unfamiliar fixture works through calibration; broken profiles stop writes; no core changes are needed for the second adapter | 4-7 days |
| 4. Packaging and hardening | Installer/uninstaller, reconnect UX, client documentation, privacy controls, targeted cross-browser/manual tests | Clean installation and removal; supported browser/host matrix passes; secrets and transcripts absent from default logs | 4-7 days |
| Later | Extra site adapters, history backfill, richer messages, additional browsers, remote profile, tightly scoped autonomous grants | Each feature gets an explicit capability, permission policy, and acceptance tests | Scope separately |

For one engineer, a supervised useful alpha is approximately 2-3 weeks; a hardened local Chromium release is roughly 4-7 weeks. These are planning ranges, not commitments. Browser-store review, enterprise policy constraints, adapter breakage, remote deployment, and multi-OS installers can add substantial time.

The earliest go/no-go is Phase 0. If the full-control extension's required permission or native installation is unacceptable, choose a separate Playwright-managed profile or a more limited read-only product; do not hide the tradeoff behind an unreliable synthetic-input fallback.

### Status (2026-10-09)

The effort column above is the original planning estimate, not a schedule.

- **Phase 0:** done except a connector-driven live send. Container GUI, extension, native host, VS Code MCP, fixture input, live Gemini structure and read checks, and a debugger fill probe passed.
- **Phase 1:** done for the fixture and one observed Gemini UI variant: installed-toolbar approval, reads, events and revocation. Read robustness gaps remain (HANDOFF findings R1 and R2).
- **Phase 2:** fixture done, including installed-toolbar fill and send. Gemini consent, fill and proof are connected privately; dispatch, outcome evidence and public routing remain.
- **Phase 3:** not started. There is no adapter interface, calibration, completion semantics or second site.
- **Phase 4:** not started. There is no installer, broker auto-start, production popup or host matrix.

## 16. Verification Strategy

### Deterministic tests

- Parse message text, multiline code, Unicode, timestamps, unknown senders, quoted messages, and repeated identical messages.
- Exercise streaming revisions, delayed continuation after a quiet interval, optimistic outgoing rows, and virtualized node recycling.
- Verify snapshot-to-event cursor consistency, bounded-buffer overflow, cursor expiration, and reconnection gaps.
- Test connection expiry, exact-origin checks, generation mismatches, account/conversation changes, stale approvals, and competing clients.
- Inject failures before filling, before dispatch, immediately after dispatch, and after UI evidence but before the tool response.
- Retry identical operations after each failure; assert no second dispatch from the connector and no false delivery claims.
- Verify that malformed IPC, page-origin approval attempts, oversized payloads, and agent-controlled arbitrary browser commands are rejected.

Use Playwright's bundled Chromium with a persistent context for automated extension tests. Its documentation notes that branded Chrome/Edge removed the command-line flags used for extension side-loading, so separately validate the installed-extension path in real supported browsers. [15]

### Real-site acceptance

Use disposable conversations and authorized test accounts. Start with Gemini, then a distinct messaging-style web UI; WhatsApp Web is a candidate subject to platform constraints and explicit test consent. Do not automate ordinary personal conversations in CI.

Acceptance requires correct message boundaries, successful plain-text submission with honest evidence, handling of route/title changes, safe pause on ambiguous identity, and visible revoke behavior. A site is supported only for the browsers, UI variants, locales, and operations actually validated. Automated fixture success alone does not certify a live site.

### Performance targets

Initially target observation-to-event latency under 500 ms at the 95th percentile for active fixture tabs, excluding network/model generation time. Target cached reads under 200 ms, bounded memory, and no full-page rescans per keystroke. Measure these during implementation; they are not current results. No latency target applies while the browser or website is suspended.

## 17. Decisions

### Confirmed by the prototype

- Chromium first, developed in a rootless Podman devcontainer that holds Chromium, the extension, the native host, the broker and the MCP facade.
- Gemini's web app is the first real AI-chat target; a local synthetic fixture is the deterministic test target.
- Local stdio MCP, private Unix-socket IPC and Native Messaging; no network control listener.
- Trusted extension-owned approval, durable intent, one guarded activation and no automatic retry. The prototype implements the supervised three-consent form; D1 makes one connection approval the product default.
- No transcript persistence: private SQLite stores operation metadata, keyed digests and receipt hashes only.
- The development extension declares `debugger`; the user accepted it for fixture and Gemini input probes (see D6).

Still open from the original list: which second chat UI to validate. Installers beyond the devcontainer are not needed for now (D12). None of this ties the architecture to a particular model provider.

### Decisions (2026-10-09)

The review raised D1-D9. The user's target experience (section 2) and answers on 2026-10-09 settle most of them and add D10-D13.

- **D1 Per-message consent: decided.** One **Connect this chat** approval grants autonomous reading and sending in that chat (section 10). Runaway guard: one message at a time and a generous, configurable hourly cap. The supervised three-consent flow stays for tests.
- **D2 Connection lifetime: decided.** No fixed expiry. The connection ends on tab close, chat switch, browser or MCP server restart, or disconnect; reloading the same chat keeps it (section 7).
- **D3 Completion signal: decided.** A quiet-period `settled_heuristic` plus a reviewed Gemini indicator reporting `complete`. The indicator needs a fresh human-authorized read-only DOM review of a disposable chat.
- **D4 Broker start: decided.** The MCP server starts a detached broker on demand and connects at startup; `npm run dev:broker` stays for debugging.
- **D5 Provider-neutral pipeline: decided.** Build the autonomous send path provider-neutral (section 8), reusing today's primitives, and add no new provider-specific command families.
- **D6 Debugger permission: open.** Decide after the first live test. If Gemini rejects `execCommand` input or the script-initiated Send click, or if hidden-tab operation (D11) needs it, add a reviewed debugger input step inside the operation chain rather than reviving the legacy probes.
- **D7 Checkpoint size: decided.** One checkpoint per authority boundary when it follows an established pattern, with shorter handoff entries.
- **D8 Observation window and failure policy: decided.** Publish the newest rows with `omittedBefore`, mark per-message truncation explicitly within the frame limit, and when URL, document and conversation are unchanged skip a failed capture instead of revoking; challenged reads then return `OBSERVATION_UNAVAILABLE`. Identity changes still revoke.
- **D9 Gemini outcome evidence: decided.** The append-only rule in section 10.
- **D10 Unconfirmed sends: decided.** Resolve from page evidence and pause only the affected chat when still unclear, with a one-click popup resolution; the barrier becomes per connection (section 10). Sub-question D10a (clearing the agent's own leftover draft) is open.
- **D11 Hidden tab: decided, phased.** First the chat tab must stay visible; its own window is fine, so "active tab of the current window" relaxes to "visible tab". Later a hidden tab must work too, so that only closing the tab or the browser disconnects.
- **D12 Target platform: decided.** Keep the devcontainer: container Chromium, native host, broker and MCP server in one container (section 12).
- **D13 Connection start: decided.** The person clicks **Connect this chat** first and the agent picks the chat up (section 4). Sub-question D13a is open: which agent receives the chat when several MCP servers are connected. The proposed first rule is the single connected agent, refusing when there are none or several.

The system's value should be **controlled, inspectable chat operations with explicit limitations**, rather than a claim that every website can be automated identically.

## Sources

Primary documentation reviewed for this proposal; facts about a live site's compatibility still require the planned experiments.

[1]: https://github.com/microsoft/playwright/tree/main/packages/extension
[2]: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
[3]: https://developer.chrome.com/blog/remote-debugging-port
[4]: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
[5]: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
[6]: https://developer.chrome.com/docs/extensions/reference/api/permissions
[7]: https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted
[8]: https://developer.chrome.com/docs/extensions/reference/api/debugger
[9]: https://github.com/modelcontextprotocol/typescript-sdk
[10]: https://modelcontextprotocol.io/specification/2026-07-28/changelog
[11]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
[12]: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
[13]: https://www.whatsapp.com/legal/messaging-guidelines
[14]: https://wxt.dev/guide/introduction.html
[15]: https://playwright.dev/docs/chrome-extensions

- [Playwright existing-browser extension][1]
- [Playwright CDP attachment][2] and [Chrome debugging-profile restrictions][3]
- [User-activated tab access][4], [Native Messaging][5], and [optional-permission limitations][6]
- [Synthetic-event trust][7], [debugger API][8], and [extension service-worker lifecycle][12]
- [Official MCP TypeScript SDK][9], [2026 protocol changes][10], and [Streamable HTTP][11]
- [WhatsApp messaging guidelines][13], [WXT][14], and [Playwright extension testing][15]