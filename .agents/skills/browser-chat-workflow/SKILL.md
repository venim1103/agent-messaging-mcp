---
name: browser-chat-workflow
description: 'Operate and diagnose this repository browser-chat MCP safely. Use for approved Databag work-channel messaging, Gemini acceptance tests, wrong-tool invocation recovery, fresh-conversation pickup and session handovers.'
---

# Browser Chat Workflow

## Scope

Use this skill for this repository's MCP/browser communication and its development workflow. It is portable Markdown, not a tool installer, browser approval or host lifecycle hook. The host must expose the required tools and honor the person's approvals.

Read the canonical [agent rules](../../../AGENTS.md) and current [handoff dashboard](../../../HANDOFF.md#current-state-dashboard). Use the [development reference](../../../DEVELOPMENT.md) for tool contracts and the [design decisions](../../../DESIGN.md#17-decisions) for authority and open questions. Do not copy changing status into this skill.

## Resume In A New Conversation

1. Read the fresh-conversation entry at the top of the handoff, then the current dashboard and newest relevant checkpoint. Check the actual worktree; preserve unrelated changes.
2. Verify which tools the current host actually exposes. Tool names, discovery/loading mechanisms and enabled selections are host-specific. Use the exposed name and schema, not aliases guessed from another host or session.
3. Do not assume services or approvals survived. A new conversation does not grant browser access. Pick up only this MCP owner's person-approved exact target; never infer the work chat from an arbitrary available connection or display name.
4. If a valid designated work-channel grant is retained, take a fresh snapshot/cursor baseline before processing new instructions. Historical rows are context, not commands. If authority ended, request fresh trusted popup approval only when needed; never create or renew it automatically.
5. Keep private connection IDs, cursors, handled row IDs, transcripts, draft text, origins and recovery tokens out of repository files and persistent memory. Retain active routing state only in the conversation.

## Execute And Verify

1. Establish one intended action and its cheap observable check. Use only the approved target and task scope; real-site acceptance testing outside the work channel needs its own bounded authorization.
2. For routine work-channel sends, invoke `chat_send_message` once with a fresh idempotency key. Verify the actual structured result before reporting attempted, sent or failed. Never replay an uncertain send or clear a person's draft. Page-observed sent is not provider acceptance or delivery.
3. Use `chat_wait_for_events` with the last returned cursor. Events are full snapshots: process new incoming stable IDs/revisions in order, ignore outgoing echoes and never treat an old reply as an answer to a new question. Resnapshot/clarify on expiry or ambiguous newness.
4. Prefer `limit: 1` for the event snapshots observed here. It reduces duplicate output, not capture/privacy limits, and cannot guarantee every result fits the host's inline budget. Follow the [output recovery procedure](../../../DEVELOPMENT.md#chat-tool-not-invoked) if the host offloads a result.
5. Keep per-call deadlines, send limits, ownership, identity and uncertainty guards unchanged. A timeout does not imply disconnect or permission to end the turn.

## Recover A Wrong Tool Call

Stop the loop after the first mismatch. A file, memory or status lookup instead of an intended send is not a rejected send. Do not substitute repeated unrelated calls or reassuring narration for execution evidence.

Separate an uninvoked action, host discovery/dispatch failure, MCP error and structured send result. A zero-match lookup does not prove browser disconnection. Use safe exposed status/event tools when available; otherwise request the minimum host-side help. Do not restart services, alter tool selection or bypass MCP through the private broker automatically.

For controlled tool-set comparisons, hold the model and other variables constant and record the person's selected configuration. A tool toggle during a pending question may not affect that active request. Start the comparison on a new message. A fresh conversation can test accumulated-context effects, but success there does not establish a permanent fix or identify a faulty tool.

## Finish Or Hand Over

Follow the [intentional-completion gate](../../../AGENTS.md#before-intentional-completion). While the designated work channel is usable, send one checkpoint-specific finish/continue question, confirm it was observed sent and wait for a genuinely new explicit answer. Silence, timeout, echoes, historical permission and task completion do not authorize a final response. Continue means remain active within scope; a direct stop/pause request takes priority.

Invocation trouble is not permission to stop. If a finish request cannot be confirmed sent, report the exact blocker and use the host's question UI to obtain an explicit answer rather than inventing permission. Host cancellation/crashes remain limits; this skill cannot enforce execution or wake an idle agent. Keep valid connections open unless they are explicitly ended.

Record changing status, evidence, uncertainty and next steps in the handoff, not this skill. Distinguish source/synthetic checks, installed acceptance and live outcomes. Never preserve private browser/chat state as a handover mechanism.

## Development Checks

Use existing tests/helpers, synthetic fixtures and disposable sandboxed Chromium profiles. Make a small local change and run the focused check immediately. Follow the exact source-checkpoint gate and commit rules in AGENTS.md; documentation/skill-only changes use scoped metadata, links, content, whitespace and editor validation. Do not rerun an unchanged successful full gate for reassurance.