# agent-messaging-mcp
Small repo for setting up generic access for agents trough MCP to messaging platforms (chat windows).

## Planning Documents

- [DESIGN.md](DESIGN.md): architecture, scope, safety model, and phased plan.
- [HANDOFF.md](HANDOFF.md): implementation work order, WSL/Chromium setup, acceptance checks, and current progress for the next AI.

Milestone 0 has a synthetic chat fixture, a read-only WXT popup, a handshake-only Native Messaging host, and a diagnostic-only official-SDK MCP stdio server. In container Chromium, the user inspected `fixture-alpha` and both rendered messages through the popup and saw `Native bridge ready (protocol v1)`; no message was sent. A local MCP client and VS Code Chat both called the diagnostic tool successfully. A separate user-approved probe of one disposable Gemini chat identified the user/model row structure and matching displayed text; the popup now reports only row lengths. There is no broker, chat MCP integration, Gemini adapter, or real-site send capability yet.

Milestone 1 has an internal private Unix broker socket and owner-bound pending connection requests, tested with separate facade and relay clients. The broker is not yet started by the MCP facade or native host, and the role credentials are not provisioned to external processes. No MCP chat tool or browser message access is available through this IPC foundation.

The fixture has an opt-in contenteditable variant at `http://127.0.0.1:8787/?editor=rich`. `npm run test:e2e` uses pinned Playwright Core and the devcontainer's installed Chromium to verify that a synthetic input event cannot submit a draft while browser-generated multiline Unicode input can; the original textarea is also checked. This is a local editor probe, not an extension send or a Gemini compatibility test. The existing devcontainer image supplies Chromium, and post-create `npm ci` restores Playwright Core on rebuild.

Inside the devcontainer, post-create runs `npm ci && npm run build && npm run restore:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"`; `npm run typecheck` and `npm run test:unit` check the current packages. Restore is a no-op until a user registers an extension ID and only recreates a missing launcher from that exact persisted profile registration. `npm run dev:fixture` serves the synthetic chat on port 8787. Open it in container Chromium using the isolated profile described in [HANDOFF.md](HANDOFF.md), then load `packages/extension/.output/chrome-mv3` from `chrome://extensions`.

After a tested VS Code devcontainer rebuild, the extension ID and native manifest persisted in the profile volume, post-create restored the host launcher, and the fixture popup again completed a real native handshake. The fixture server and Chromium processes must be restarted after a rebuild; user login or unsent Gemini draft persistence has not been tested.

After copying that installation's extension ID, register the development native host for this browser profile:

```bash
npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev" --preview
npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"
```

Set `EXTENSION_ID` from container Chromium's `chrome://extensions` first. Preview makes no changes; registration refuses to replace unrelated files. Initial registration stays manual because it needs this browser's extension ID. The manifest goes in the chosen Chromium profile and its launcher in the writable `$HOME/.config/agent-messaging-mcp` directory. Post-create restores the launcher if that exact manifest survives a container rebuild; if the manifest is lost, re-register after verifying the ID. After the browser test, remove only this application's registration with `npm run unregister:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"`. The fixture popup confirmed that Chromium found the manifest in the development profile and completed the native handshake.

VS Code's workspace [MCP configuration](.vscode/mcp.json) starts the diagnostic server with the container's Node executable and built companion entry point. The `browser_chat_feasibility` tool returned `MCP stdio diagnostic OK. No browser data was read or sent.` in VS Code Chat. This verifies VS Code MCP stdio tool invocation, not browser-chat integration.

The Gemini popup inspects only the user-selected tab and returns fixed structural indicators and bounded message character counts; it does not return transcript text, draft contents, or conversation identifiers. It is safe to share its complete output for diagnostics, but it does not grant a persistent chat connection or send anything. The development extension declares Chrome's powerful `debugger` permission as required. User-clicked input probes can fill the exact empty local rich fixture or one explicitly approved fixed draft in the selected disposable Gemini conversation. They compare read-back, detach, and never click Send. The Gemini draft matched in the visible composer in one test, but submission, service acceptance, and delivery remain unverified; any send needs separate approval.
