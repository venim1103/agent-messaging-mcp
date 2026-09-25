# agent-messaging-mcp
Small repo for setting up generic access for agents trough MCP to messaging platforms (chat windows).

## Planning Documents

- [DESIGN.md](DESIGN.md): architecture, scope, safety model, and phased plan.
- [HANDOFF.md](HANDOFF.md): implementation work order, WSL/Chromium setup, acceptance checks, and current progress for the next AI.

Milestone 0 has a synthetic chat fixture, a read-only WXT popup, a handshake-only Native Messaging host, and a diagnostic-only official-SDK MCP stdio server. In container Chromium, the user inspected `fixture-alpha` and both rendered messages through the popup and saw `Native bridge ready (protocol v1)`; no message was sent. A local MCP client and VS Code Chat both called the diagnostic tool successfully. There is no broker, chat MCP integration, or Gemini adapter yet.

Inside the devcontainer, post-create runs `npm ci && npm run build && npm run restore:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"`; `npm run typecheck` and `npm run test:unit` check the current packages. Restore is a no-op until a user registers an extension ID and only recreates a missing launcher from that exact persisted profile registration. `npm run dev:fixture` serves the synthetic chat on port 8787. Open it in container Chromium using the isolated profile described in [HANDOFF.md](HANDOFF.md), then load `packages/extension/.output/chrome-mv3` from `chrome://extensions`.

After copying that installation's extension ID, register the development native host for this browser profile:

```bash
npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev" --preview
npm run register:native -- --browser chromium --extension-id "$EXTENSION_ID" --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"
```

Set `EXTENSION_ID` from container Chromium's `chrome://extensions` first. Preview makes no changes; registration refuses to replace unrelated files. Initial registration stays manual because it needs this browser's extension ID. The manifest goes in the chosen Chromium profile and its launcher in the writable `$HOME/.config/agent-messaging-mcp` directory. Post-create restores the launcher if that exact manifest survives a container rebuild; if the manifest is lost, re-register after verifying the ID. After the browser test, remove only this application's registration with `npm run unregister:native -- --browser chromium --user-data-dir "$HOME/.local/share/agent-messaging-mcp/chromium-dev"`. The fixture popup confirmed that Chromium found the manifest in the development profile and completed the native handshake.

VS Code's workspace [MCP configuration](.vscode/mcp.json) starts the diagnostic server with the container's Node executable and built companion entry point. The `browser_chat_feasibility` tool returned `MCP stdio diagnostic OK. No browser data was read or sent.` in VS Code Chat. This verifies VS Code MCP stdio tool invocation, not browser-chat integration.
