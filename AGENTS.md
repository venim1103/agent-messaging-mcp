# Project Agent Workflow

Build communication between an MCP agent and a browser chat explicitly selected and approved by a person, using their existing login. Preserve the private broker/native-host/extension architecture; do not add provider APIs, credential export or unrestricted browser control.

## Start With Context

- Read the **Current State Dashboard** at the top of [HANDOFF.md](HANDOFF.md) first, then the newest relevant checkpoint below it. Older dated entries are history; when they disagree with the dashboard, the dashboard wins. Use [DEVELOPMENT.md](DEVELOPMENT.md) for setup, tool usage and technical reference, and [DESIGN.md](DESIGN.md) for architecture, authority contracts and open decisions (section 17).
- Check the actual worktree and nearby implementation/tests. Preserve user changes; do not assume services, grants or approvals survived a restart.
- After an interrupted tool call with unknown outcome, verify whether it applied before repeating it. Distinguish completed, tested, staged and connected work.

## Documentation Audience

- [README.md](README.md) is the GitHub front page for visitors. Keep it a concise public introduction with plain-language capabilities, maturity/safety caveats, documentation links and licensing. Do not add discussions, progress updates, handovers, test counts, commit history, setup commands or technical implementation details there.
- Put reusable setup, operating instructions, tool contracts and implementation reference in [DEVELOPMENT.md](DEVELOPMENT.md). Keep architecture and design rationale in [DESIGN.md](DESIGN.md).
- Put changing implementation status, decisions/discussions, test evidence, failed-check history and next-session handover in [HANDOFF.md](HANDOFF.md). Keep its Current State Dashboard accurate in place at every checkpoint (capability matrix, Gemini chain, critical path, findings, next step) and add a short dated entry for the evidence. Clearly distinguish historical notes from current capabilities.
- Record design questions that need the user's choice as numbered decisions in DESIGN.md section 17 and refer to them by ID; mark them resolved there and in the dashboard once the user decides.
- Write for smaller models and file readers: keep every line under about 1,000 characters (readers truncate at 2,000), prefer short bullets, state each fact once and link to it, and cite the Safety Boundaries below instead of repeating standard caveats in every entry.
- Keep stable agent workflow rules in this file. Update the public README only when the visitor-facing description or safety guidance genuinely changes, not at each development checkpoint.

## Work Independently

- The user prefers autonomous implementation within the agreed scope. Make routine implementation/testing decisions without repeatedly asking permission; continue through verification and useful checkpoints until done or genuinely blocked.
- Keep changes small and local. Form a concrete hypothesis, make the smallest useful edit and immediately run a focused check before expanding scope. Reuse existing tests/helpers and avoid unrelated cleanup.
- Before adding a chat provider, a private command family or a new consent type, read DESIGN.md sections 8 and 17 (D1, D5). Do not add a provider by copying the fixture/Gemini command families.
- Give concise progress updates explaining what changed, what was verified and what remains. Be explicit about uncertain evidence and missing authorization.
- Do not spawn subagents unless requested by the user or required by an applicable skill.
- Respect requests to pause, stop or finish for the day. Finish only the agreed checkpoint; a terminal notification or documentation request is not permission to resume paused implementation.

## Verification And Commits

- Use synthetic fixtures and disposable, sandboxed Chromium profiles for autonomous browser tests. Never substitute the person's logged-in profile for an isolated test profile.
- Before every source checkpoint commit, run this exact gate from the repository root:

```bash
npm run build && npm run typecheck && npm run test:unit && npm run test:e2e
```

- Do not weaken deadlines, timeouts, polling, assertions, sandbox, ownership/privacy checks or grant expiry to obtain green results. Do not automatically rerun a failed gate seeking green; diagnose it first. A substantive repair permits rerunning the focused check and a new gate.
- Do not rerun an unchanged successful gate merely for reassurance. Documentation/instruction-only edits need scoped content, link and whitespace validation; report accurately which checks ran.
- Scoped local checkpoint commits are authorized as part of the workflow. Commit meaningful tested increments periodically, not every probe and not only at the end of a large task. Review the diff and stage only files belonging to the checkpoint.
- Do not push or create branches unless explicitly requested. Never revert another person's changes.

## When To Ask For Help

Ask the user for a small, precise action when a test requires:

- A real installed-browser gesture: selecting the exact tab/chat, approving through the trusted toolbar/popup, or restarting/reloading MCP or the extension when a human step is required.
- Fresh authorization for real-site inspection/reads using their account. A synthetic test or an old grant is not permission for a live check.
- A real-site connector draft fill or message submission. Obtain separate explicit authorization for the exact chat and text before filling, and separate send approval before any live submission. Read access, ordinary review, fill consent and manually typed drafts are not send permission.
- Visual acceptance that automation cannot establish, such as confirming the actual draft is present and unsent. Ask what was actually performed/observed, not just whether the user approves an action.
- A genuine blocker, ambiguous requirement or proposed expansion of scope/security/environment constraints.

Prepare the autonomous prerequisites first. Explain the bounded action and expected evidence; request only necessary, privacy-preserving metadata. Never ask the user to paste passwords, tokens, cookies or profile data. Recheck expiry after human coordination; do not extend it or silently retry an expired request.

## Safety Boundaries

- Keep connection approval, ordinary review, fill consent, send consent, fresh proof, durable intent and browser reservation distinct. Recovery receipts recover status, never write authority.
- Never automatically retry or replace an uncertain fill/submit, restore consumed authority, or clear/submit a person's existing draft. Report uncertainty conservatively; UI observation is not provider acceptance or delivery.
- Do not change clocks/NTP, host/network settings, browser profile locks, TLS/security or privilege configuration as a testing workaround. Ask before such separately scoped work. The tracked [clock diagnostic](tests/diagnostics/clock-probe.c) is optional and must not run without explicit authorization.
- Keep sensitive profiles outside Git. Do not record real chat/draft text, full private URLs, credentials or recovery secrets in repository docs, logs, screenshots or memory.

## Leave A Clear Handoff

- Update [HANDOFF.md](HANDOFF.md) at meaningful checkpoints with the actual change, commands/results, failed-check history, limits and next concrete step. Preserve earlier results rather than rewriting failures as successes.
- Keep stable workflow rules here and changing implementation status in the handoff. Document synthetic coverage, installed acceptance and live-provider evidence separately; do not describe an unconnected primitive as a working public tool.
- When stopping, give a concise outcome with commit IDs, verification, remaining boundaries and worktree state. Do not continue into the next implementation slice after the user's stop request.