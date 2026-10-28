# Browser Chat MCP

Connect an AI assistant to a browser chat you explicitly select and approve, using your existing browser login.

You choose the conversation and approve each assistant once. That assistant can then read and send in that chat until its connection ends. Your login stays in your browser: no provider API keys or exported credentials are needed.

Reply waiting uses page completion indicators where available and quiet-period estimates otherwise.

Supported integrations include Gemini and experimental plain-text Databag chats. Databag requires a patched web client; the stock image alone is not sufficient. See [DEVELOPMENT.md](DEVELOPMENT.md#databag-compatibility) for compatibility requirements.

> **Experimental prototype.** Not ready for everyday use or personal conversations. Browser and site support is limited; background-tab reliability on real sites is unverified. Messages observed on the page are not proof of delivery.

## Documentation

- [DEVELOPMENT.md](DEVELOPMENT.md): setup, usage and technical reference.
- [DESIGN.md](DESIGN.md): architecture and design rationale.
- [HANDOFF.md](HANDOFF.md): development checkpoints, evidence and handover.
- [AGENTS.md](AGENTS.md): project workflow for coding agents.

## License

See [LICENSE](LICENSE).