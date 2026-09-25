# agent-messaging-mcp
Small repo for setting up generic access for agents trough MCP to messaging platforms (chat windows).

## Planning Documents

- [DESIGN.md](DESIGN.md): architecture, scope, safety model, and phased plan.
- [HANDOFF.md](HANDOFF.md): implementation work order, WSL/Chromium setup, acceptance checks, and current progress for the next AI.

Milestone 0 has a synthetic chat fixture and a read-only WXT extension popup. There is no native host, broker, or MCP server yet. Use the Podman/WSL instructions in [HANDOFF.md](HANDOFF.md) before testing the browser extension.
