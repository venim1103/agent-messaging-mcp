import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_READ_TIMEOUT_MS, GEMINI_READ_TIMEOUT_MS, MAX_FIXTURE_SNAPSHOT_AGE_MS, MAX_GEMINI_SNAPSHOT_AGE_MS,
  MAX_AUTONOMOUS_CONNECTIONS, MAX_CONNECTION_WAIT_MS, MAX_CONNECTED_AGENTS, MAX_PENDING_REQUESTS, PendingConnectionRequests,
  PENDING_REQUEST_TTL_MS, READONLY_CONNECTION_TTL_MS, ReplyObservation, isGeminiTarget, type ApprovedTarget, type DatabagTarget }
  from "./pending-connections.js";

for (const provider of ["fixture", "gemini"]) {
  const messages = provider === "fixture"
    ? [{ id: "synthetic-reply", direction: "incoming" as const, text: "Synthetic reply" }]
    : [{ direction: "incoming" as const, text: "Synthetic reply", identityQuality: "uncertain" as const, generationState: "unknown" as const }];
  const snapshot = (capturedAt: number, sequence = 1, epoch = "synthetic-epoch") => ({
    coverage: "rendered_only" as const, generation: 1 as const, capturedAt, cursor: { epoch, sequence }, omittedBefore: false, messages
  });
  test(`${provider} reply quiet period needs fresh unchanged observations and never confirms completion`, () => {
    const observation = new ReplyObservation();
    assert.equal(observation.observe(snapshot(1000), 1000), null);
    assert.equal(observation.observe(snapshot(2999), 2999), null);
    const settled = observation.observe(snapshot(3000), 3000);
    assert.equal(settled?.generationState, "settled_heuristic");
    assert.equal(settled?.text, "Synthetic reply");
    assert.equal(Object.isFrozen(settled), true);
    assert.equal(observation.observe(snapshot(3000), 5000), null);
    assert.equal(observation.observe(snapshot(6000), 6000), null);
    assert.equal(observation.observe(snapshot(8000), 8000)?.generationState, "settled_heuristic");
    const delayed = new ReplyObservation();
    assert.equal(delayed.observe(snapshot(1000), 1000), null);
    assert.equal(delayed.observe(snapshot(1001), 3000), null);
    assert.equal(delayed.observe(snapshot(3000), 3000)?.generationState, "settled_heuristic");
  });
  test(`${provider} reply quiet period resets on revisions, restored text, gaps and unsafe newest rows`, () => {
    const observation = new ReplyObservation();
    assert.equal(observation.observe(snapshot(1000), 1000), null);
    assert.equal(observation.observe(snapshot(3000, 3), 3000), null);
    assert.equal(observation.observe(snapshot(5000, 3, "reloaded-epoch"), 5000), null);
    assert.equal(observation.observe(snapshot(7000, 3, "reloaded-epoch"), 7000)?.generationState, "settled_heuristic");
    assert.equal(observation.observe({ ...snapshot(8000), messages: messages.map(message => ({ ...message, truncated: true as const })) }, 8000), null);
    assert.equal(observation.observe(snapshot(10000), 10000), null);
    assert.equal(observation.observe({ ...snapshot(12000), messages: [{ id: "later-outgoing", direction: "outgoing", text: "Synthetic new question" }] }, 12000), null);
    assert.equal(observation.observe(snapshot(14000), 14000), null);
    assert.equal(observation.observe(snapshot(16001), 16000), null);
    assert.equal(observation.observe(snapshot(18000), 18000), null);
    assert.equal(observation.observe(snapshot(17000), 17000), null);
  });
  if (provider === "gemini") test("Gemini streaming evidence resets quiet time even when text and cursor stay unchanged", () => {
    const observation = new ReplyObservation();
    const streaming = (capturedAt: number) => ({ ...snapshot(capturedAt), messages: [{
      direction: "incoming" as const, text: "Synthetic reply", identityQuality: "uncertain" as const, generationState: "streaming" as const
    }] });
    assert.equal(observation.observe(snapshot(1000), 1000), null);
    assert.equal(observation.observe(streaming(3000), 3000), null);
    assert.equal(observation.observe(streaming(8000), 8000), null);
    assert.equal(observation.observe(snapshot(9000), 9000), null);
    assert.equal(observation.observe(snapshot(10999), 10999), null);
    assert.equal(observation.observe(snapshot(11000), 11000)?.generationState, "settled_heuristic");
  });
}

test("Gemini explicit UI completion is fresh, incoming and untruncated without a heuristic delay", () => {
  const observation = new ReplyObservation();
  const message = { direction: "incoming" as const, text: "Synthetic completed reply", identityQuality: "uncertain" as const,
    generationState: "complete" as const };
  const snapshot = (capturedAt: number) => ({ coverage: "rendered_only" as const, generation: 1 as const, capturedAt,
    cursor: { epoch: "synthetic-epoch", sequence: 1 }, omittedBefore: false, messages: [message] });
  const complete = observation.observe(snapshot(1000), 1000);
  assert.equal(complete?.generationState, "complete");
  assert.equal(Object.isFrozen(complete), true);
  assert.equal(observation.observe(snapshot(1000), 1001), null);
  assert.equal(observation.observe({ ...snapshot(2000), messages: [{ ...message, truncated: true }] }, 2000), null);
  assert.equal(observation.observe({ ...snapshot(3000), messages: [{ ...message, direction: "outgoing" }] }, 3000), null);
  assert.equal(observation.observe({ ...snapshot(4000), messages: [{ ...message, text: "" }] }, 4000), null);
  assert.equal(observation.observe(snapshot(5001), 5000), null);
  assert.equal(observation.observe(snapshot(6000), 6000)?.generationState, "complete");
});

test("Databag autonomous admission pins exact HTTPS session identity and rejects legacy grants", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("Databag owner");
  const stranger = Symbol("other owner");
  const agent = requests.registerAgent(owner);
  const selected = { provider: "databag", origin: "https://databag.example", url: "https://databag.example/#/session",
    conversationId: `databag_${"a".repeat(64)}`, tabId: 3, documentId: "synthetic-document" };
  const target = selected as unknown as ApprovedTarget;
  const grant = requests.approveAgent(agent.agentId, target, 1000);
  assert.ok(grant);
  assert.equal(grant.state, "ready");
  assert.deepEqual(grant.capabilities, ["read", "send"]);
  assert.deepEqual(requests.getAutonomousTarget(owner, grant.connectionId, 1000), target);
  assert.equal(requests.getAutonomousTarget(stranger, grant.connectionId, 1000), null);
  assert.equal(requests.getApprovedTarget(owner, grant.connectionId, 1000), null);
  assert.equal(requests.getGeminiTarget(owner, grant.connectionId, 1000), null);
  for (const changes of [
    { provider: "gemini" }, { provider: undefined }, { origin: "http://databag.example" },
    { origin: "https://databag.example/" }, { origin: "https://user@databag.example" },
    { origin: "https://*.example" }, { origin: "https://gemini.google.com" },
    { url: "https://databag.example/#/session?other" }, { url: "https://other.example/#/session" },
    { conversationId: "fixture-alpha" }, { conversationId: `databag_${"A".repeat(64)}` },
    { documentId: "" }, { tabId: 0 }
  ]) {
    assert.equal(requests.approveAgent(agent.agentId, { ...selected, ...changes } as unknown as ApprovedTarget, 1000), null);
  }
  assert.equal(requests.removeChatAgent(agent.agentId,
    { ...selected, url: `${selected.url}?other` } as unknown as ApprovedTarget, 1000), 0);
  assert.equal(requests.disconnectChat({ ...target, documentId: "wrong-document" }, 1000), 0);
  const pending = requests.create(owner, 1000);
  assert.equal(requests.approve(pending.requestId,
    target as Parameters<PendingConnectionRequests["approve"]>[1], 1000), null);
  assert.equal(requests.approveGemini(pending.requestId,
    target as Parameters<PendingConnectionRequests["approveGemini"]>[1], 1000), null);
  assert.equal(requests.beginChatReload(target, 1001), 1);
  assert.equal(requests.getAutonomousTarget(owner, grant.connectionId, 1001), null);
  const updated = { ...target, documentId: "reloaded-document" };
  assert.equal(requests.rebindChat(target,
    { ...selected, documentId: updated.documentId, conversationId: `databag_${"b".repeat(64)}` } as unknown as ApprovedTarget, 1001), 0);
  assert.equal(requests.rebindChat(target, updated, 1002), 1);
  assert.equal(requests.get(owner, grant.requestId, 1002)?.state, "ready");
  assert.deepEqual(requests.getAutonomousTarget(owner, grant.connectionId, 1002), updated);
  assert.equal(requests.disconnectChat(target, 1002), 0);
  assert.equal(requests.disconnectChat(updated, 1002), 1);
  assert.equal(requests.get(owner, grant.requestId, 1002)?.state, "stale");
  requests.disconnect(owner);
});

test("Databag stable DOM reads share bounded challenges and revoke old-document evidence", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("Databag reader");
  const other = Symbol("other reader");
  const target: DatabagTarget = { provider: "databag", origin: "https://databag.example", url: "https://databag.example/#/session",
    conversationId: `databag_${"a".repeat(64)}`, tabId: 3, documentId: "synthetic-document" };
  const first = requests.approveAgent(requests.registerAgent(owner).agentId, target, 1000);
  const second = requests.approveAgent(requests.registerAgent(other).agentId, target, 1000);
  assert.ok(first && second);
  assert.equal(requests.getStableSnapshot(owner, first.connectionId, 1000), "not_ready");
  assert.equal(requests.getFixtureSnapshot(owner, first.connectionId, 1000), null);
  assert.equal(requests.requestFreshFixtureRead(owner, first.connectionId, 1000), null);
  assert.equal(requests.requestFreshStableRead(other, first.connectionId, 1000), null);
  const read = requests.requestFreshStableRead(owner, first.connectionId, 1000, 1050);
  assert.ok(read && read !== "busy");
  assert.equal(requests.listFixtureReadChallenges(1000).length, 0);
  assert.deepEqual(requests.listStableReadChallenges(1000), [{ challengeId: read.challengeId, target, expiresAt: 1050 }]);
  const rows = [{ id: "synthetic-row", direction: "incoming" as const, text: "Synthetic reply" }];
  assert.equal(requests.publishStableSnapshot({ ...target, url: `${target.url}?other` }, rows, 1001, read.challengeId), 0);
  assert.equal(requests.publishStableSnapshot({ ...target, documentId: "other-document" }, rows, 1001, read.challengeId), 0);
  assert.equal(requests.publishStableSnapshot(target, rows, 1001, read.challengeId), 2);
  const snapshot = await read.result;
  assert.ok(snapshot && snapshot !== "not_ready");
  assert.deepEqual(snapshot.messages, rows);
  assert.equal(requests.readFixtureEvents(owner, first.connectionId, snapshot.cursor, 2, 1001), null);
  const pending = requests.requestFreshStableRead(owner, first.connectionId, 1002, 1050);
  assert.ok(pending && pending !== "busy");
  assert.equal(requests.markStableObservationGap({ ...target, url: `${target.url}?other` }, 1002), 0);
  assert.equal(requests.beginChatReload(target, 1002), 2);
  assert.equal(await pending.result, "not_ready");
  assert.equal(requests.publishStableSnapshot(target, rows, 1002), 0);
  const updated = { ...target, documentId: "new-document" };
  assert.equal(requests.rebindChat(target, updated, 1003), 2);
  assert.equal(requests.publishStableSnapshot(target, rows, 1003), 0);
  assert.equal(requests.publishStableSnapshot(updated, rows, 1003), 2);
  const events = requests.readStableEvents(owner, first.connectionId, snapshot.cursor, 2, 1003);
  assert.ok(events && typeof events === "object");
  assert.equal(events.state, "expired");
  assert.equal(requests.removeChatAgent(requests.listChatAgents(updated, 1003)[0]!.agentId, updated, 1003), 1);
  assert.equal(requests.getStableSnapshot(owner, first.connectionId, 1003), null);
  assert.ok(requests.getStableSnapshot(other, second.connectionId, 1003));
  requests.disconnect(owner);
  requests.disconnect(other);
});

for (const target of [
  { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3, documentId: "synthetic-document" },
  { origin: "https://gemini.google.com", conversationId: "synthetic-chat", tabId: 3,
    documentId: "synthetic-document", url: "https://gemini.google.com/app/synthetic-chat" }
] as const) {
  test(`${target.origin} agent roster and removal preserve other owners and targets`, async () => {
    const requests = new PendingConnectionRequests();
    const first = Symbol("first agent");
    const second = Symbol("second agent");
    const firstAgent = requests.registerAgent(first, "Same reported name");
    const secondAgent = requests.registerAgent(second, "Same reported name");
    assert.notEqual(firstAgent.agentId, secondAgent.agentId);
    const firstPending = requests.create(first, 1000);
    const secondPending = requests.create(second, 1000);
    const otherPending = requests.create(first, 1000);
    const approve = (requestId: string, selected: ApprovedTarget, now: number) => isGeminiTarget(selected)
      ? requests.approveGemini(requestId, selected, now)
      : selected.origin === "http://127.0.0.1:8787" ? requests.approve(requestId, selected, now) : null;
    const firstGrant = approve(firstPending.requestId, target, 1000);
    const secondGrant = approve(secondPending.requestId, target, 1000);
    const otherGrant = approve(otherPending.requestId, { ...target, tabId: 4 }, 1000);
    assert.ok(firstGrant && secondGrant && otherGrant);
    assert.deepEqual(requests.listChatAgents(target, 1000), [
      { ...firstAgent, connectionCount: 1 }, { ...secondAgent, connectionCount: 1 }
    ]);
    const read = target.origin === "https://gemini.google.com"
      ? requests.requestFreshGeminiRead(first, firstGrant.connectionId, 1000)
      : requests.requestFreshFixtureRead(first, firstGrant.connectionId, 1000);
    assert.ok(read && read !== "busy");
    assert.equal(requests.removeChatAgent(firstAgent.agentId, { ...target, documentId: "wrong-document" }, 1000), 0);
    assert.equal(requests.removeChatAgent("unknown-agent", target, 1000), 0);
    assert.equal(requests.removeChatAgent(firstAgent.agentId, target, 1000), 1);
    assert.equal(await read.result, null);
    assert.equal(requests.get(first, firstPending.requestId, 1000)?.state, "stale");
    assert.equal(requests.get(second, secondPending.requestId, 1000)?.state, "ready_readonly");
    assert.equal(requests.get(first, otherPending.requestId, 1000)?.state, "ready_readonly");
    assert.equal(requests.removeChatAgent(firstAgent.agentId, target, 1000), 0);
    assert.equal(approve(firstPending.requestId, target, 1000), null);
    assert.deepEqual(requests.listChatAgents(target, 1000), [
      { ...firstAgent, connectionCount: 0 }, { ...secondAgent, connectionCount: 1 }
    ]);
    assert.equal(JSON.stringify(requests.listChatAgents(target, 1000)).includes(firstGrant.connectionId), false);
    const secondRead = target.origin === "https://gemini.google.com"
      ? requests.requestFreshGeminiRead(second, secondGrant.connectionId, 1000)
      : requests.requestFreshFixtureRead(second, secondGrant.connectionId, 1000);
    assert.ok(secondRead && secondRead !== "busy");
    assert.equal(requests.disconnectChat({ ...target, documentId: "wrong-document" }, 1000), 0);
    assert.equal(requests.disconnectChat(target, 1000), 1);
    assert.equal(await secondRead.result, null);
    assert.equal(requests.get(second, secondPending.requestId, 1000)?.state, "stale");
    assert.equal(requests.get(first, otherPending.requestId, 1000)?.state, "ready_readonly");
    requests.disconnect(first);
    assert.deepEqual(requests.listChatAgents(target, 1000), [{ ...secondAgent, connectionCount: 0 }]);
    const restarted = requests.registerAgent(first, "Same reported name");
    assert.notEqual(restarted.agentId, firstAgent.agentId);
    assert.equal(requests.listChatAgents(target, 1000)[1]?.connectionCount, 0);
    requests.disconnect(second);
    requests.disconnect(first);
  });
}

for (const target of [
  { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3, documentId: "synthetic-document" },
  { origin: "https://gemini.google.com", conversationId: "synthetic-chat", tabId: 3,
    documentId: "synthetic-document", url: "https://gemini.google.com/app/synthetic-chat" }
] as const) {
  test(`${target.origin} autonomous grants remain owner-bound without expiry and keep finite read leases`, async () => {
    const requests = new PendingConnectionRequests();
    const first = Symbol("first owner");
    const second = Symbol("second owner");
    const firstAgent = requests.registerAgent(first);
    const secondAgent = requests.registerAgent(second);
    const now = 1000;
    assert.equal(requests.approveAgent("unknown", target, now), null);
    assert.equal(requests.approveAgent(firstAgent.agentId, { ...target, tabId: 0 }, now), null);
    assert.equal(requests.approveAgent(firstAgent.agentId, { ...target, documentId: "" }, now), null);
    assert.equal(requests.approveAgent(firstAgent.agentId, target, NaN), null);
    const granted = requests.approveAgent(firstAgent.agentId, target, now);
    const other = requests.approveAgent(secondAgent.agentId, target, now);
    assert.ok(granted && other);
    assert.equal(granted.expiresAt, null);
    assert.equal(granted.state, "ready");
    assert.deepEqual(granted.capabilities, ["read", "send"]);
    assert.ok(Object.isFrozen(granted) && Object.isFrozen(granted.capabilities));
    assert.notEqual(granted.connectionId, other.connectionId);
    assert.equal(requests.get(second, granted.requestId, now), null);
    assert.equal(requests.getConnectionExpiresAt(second, granted.connectionId, now), null);
    const later = now + 10 * 365 * 24 * 60 * 60_000;
    requests.create(second, later);
    assert.equal(requests.get(first, granted.requestId, later)?.state, "ready");
    assert.equal(requests.approveAgent(firstAgent.agentId, target, later), granted);
    assert.equal(requests.getConnectionExpiresAt(first, granted.connectionId, later), Infinity);
    const published = target.origin === "https://gemini.google.com"
      ? requests.publishGeminiSnapshot(target, [{ direction: "incoming", text: "Synthetic reply" }], later)
      : requests.publishFixtureSnapshot(target, [{ id: "synthetic-row", direction: "incoming", text: "Synthetic reply" }], later);
    assert.equal(published, 2);
    assert.equal(requests.get(first, granted.requestId, later)?.state, "ready");
    const challenged = target.origin === "https://gemini.google.com"
      ? requests.requestFreshGeminiRead(first, granted.connectionId, later, later + 50)
      : requests.requestFreshFixtureRead(first, granted.connectionId, later, later + 50);
    assert.ok(challenged && challenged !== "busy");
    const challenges = target.origin === "https://gemini.google.com"
      ? requests.listGeminiReadChallenges(later) : requests.listFixtureReadChallenges(later);
    assert.equal(challenges[0]?.expiresAt, later + 50);
    assert.equal(requests.removeChatAgent(firstAgent.agentId, target, later), 1);
    assert.equal(await challenged.result, null);
    assert.equal(requests.get(first, granted.requestId, later)?.state, "stale");
    assert.equal(requests.get(second, other.requestId, later)?.state, "ready");
    const again = requests.approveAgent(firstAgent.agentId, target, later);
    assert.ok(again);
    assert.notEqual(again.connectionId, granted.connectionId);
    requests.create(first, later + PENDING_REQUEST_TTL_MS);
    assert.equal(requests.get(first, granted.requestId, later + PENDING_REQUEST_TTL_MS), null);
    assert.equal(requests.get(first, again.requestId, later + PENDING_REQUEST_TTL_MS)?.state, "ready");
    assert.equal(requests.disconnectFixture(second, again.connectionId, later), false);
    requests.disconnect(first);
    assert.equal(requests.approveAgent(firstAgent.agentId, target, later), null);
    assert.equal(requests.get(second, other.requestId, later)?.state, "ready");
    requests.disconnect(second);
  });
}

for (const target of [
  { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3, documentId: "synthetic-document" },
  { origin: "https://gemini.google.com", conversationId: "synthetic-chat", tabId: 3,
    documentId: "synthetic-document", url: "https://gemini.google.com/app/synthetic-chat" }
] as const) {
  test(`${target.origin} reload rebind preserves only existing autonomous owners and invalidates observations`, async () => {
    const requests = new PendingConnectionRequests();
    const first = Symbol("first owner");
    const second = Symbol("second owner");
    const legacy = Symbol("legacy owner");
    const firstAgent = requests.registerAgent(first);
    const secondAgent = requests.registerAgent(second);
    const firstGrant = requests.approveAgent(firstAgent.agentId, target, 1000);
    const secondGrant = requests.approveAgent(secondAgent.agentId, target, 1000);
    const pending = requests.create(legacy, 1000);
    const legacyGrant = target.origin === "https://gemini.google.com"
      ? requests.approveGemini(pending.requestId, target, 1000) : requests.approve(pending.requestId, target, 1000);
    assert.ok(firstGrant && secondGrant && legacyGrant);
    const updated = { ...target, documentId: "reloaded-document" };
    assert.equal(requests.rebindChat(target, updated, 1000), 0);
    const publish = (selected: ApprovedTarget, now: number) => isGeminiTarget(selected)
      ? requests.publishGeminiSnapshot(selected, [{ direction: "incoming", text: "Synthetic reply" }], now)
      : selected.origin === "http://127.0.0.1:8787"
        ? requests.publishFixtureSnapshot(selected, [{ id: "row", direction: "incoming", text: "Synthetic reply" }], now) : 0;
    assert.equal(publish(target, 1000), 3);
    const snapshot = target.origin === "https://gemini.google.com"
      ? requests.getGeminiSnapshot(first, firstGrant.connectionId, 1000)
      : requests.getFixtureSnapshot(first, firstGrant.connectionId, 1000);
    assert.ok(snapshot && snapshot !== "not_ready");
    const read = target.origin === "https://gemini.google.com"
      ? requests.requestFreshGeminiRead(first, firstGrant.connectionId, 1000)
      : requests.requestFreshFixtureRead(first, firstGrant.connectionId, 1000);
    assert.ok(read && read !== "busy");
    assert.equal(requests.beginChatReload(target, 1001), 2);
    assert.equal(await read.result, "not_ready");
    assert.equal(requests.get(legacy, pending.requestId, 1001)?.state, "stale");
    assert.equal(requests.getConnectionExpiresAt(first, firstGrant.connectionId, 1001), null);
    assert.equal(publish(target, 1001), 0);
    assert.equal(requests.rebindChat(target, { ...updated, tabId: 4 }, 1001), 0);
    assert.equal(requests.rebindChat(target, target, 1001), 0);
    if (target.origin === "https://gemini.google.com") {
      assert.equal(requests.rebindChat(target, { ...target, documentId: updated.documentId, url: `${target.url}?other` }, 1001), 0);
    }
    assert.equal(requests.approveAgent(firstAgent.agentId, target, 1001), firstGrant);
    assert.equal(requests.removeChatAgent(secondAgent.agentId, target, 1001), 1);
    assert.equal(requests.rebindChat(target, updated, 1002), 1);
    assert.equal(requests.rebindChat(target, updated, 1002), 0);
    assert.equal(requests.get(first, firstGrant.requestId, 1002)?.state, "ready");
    assert.equal(requests.get(second, secondGrant.requestId, 1002)?.state, "stale");
    assert.equal(publish(target, 1002), 0);
    assert.equal(publish(updated, 1002), 1);
    const events = target.origin === "https://gemini.google.com"
      ? requests.readGeminiEvents(first, firstGrant.connectionId, snapshot.cursor, 2, 1002)
      : requests.readFixtureEvents(first, firstGrant.connectionId, snapshot.cursor, 2, 1002);
    assert.ok(events && typeof events === "object");
    assert.equal(events.state, "expired");
    const rebound = requests.get(first, firstGrant.requestId, 1002);
    assert.ok(rebound?.state === "ready");
    assert.equal(rebound.connectionId, firstGrant.connectionId);
    assert.equal(requests.beginChatReload(updated, 1003), 1);
    assert.equal(requests.disconnectFixture(first, firstGrant.connectionId, 1003), true);
    assert.equal(requests.rebindChat(updated, { ...updated, documentId: "another-document" }, 1003), 0);
    requests.disconnect(first);
    requests.disconnect(second);
    requests.disconnect(legacy);
  });
}

test("connection pickup waits for only its approved registered owner and cancels without authority", async () => {
  const requests = new PendingConnectionRequests();
  const first = Symbol("first owner");
  const second = Symbol("second owner");
  const agent = requests.registerAgent(first);
  requests.registerAgent(second);
  const target = { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
    tabId: 1, documentId: "synthetic-document" } as const;
  assert.equal(requests.waitForConnection(Symbol("unregistered"), 1000, 1001), null);
  for (const deadline of [999, NaN, Infinity, 1000 + MAX_CONNECTION_WAIT_MS + 1]) {
    assert.equal(requests.waitForConnection(first, 1000, deadline), null);
  }
  assert.deepEqual(await requests.waitForConnection(first, 1000, 1000), { connections: [], timedOut: true });
  const waiting = requests.waitForConnection(first, 1000, 2000);
  const foreign = requests.waitForConnection(second, 1000, 2000);
  assert.ok(waiting && waiting !== "busy" && foreign && foreign !== "busy");
  assert.equal(requests.waitForConnection(first, 1000, 2000), "busy");
  const connection = requests.approveAgent(agent.agentId, target, 1000);
  assert.ok(connection);
  assert.deepEqual(await waiting, { connections: [connection], timedOut: false });
  assert.deepEqual(await requests.waitForConnection(first, 1000, 1000), { connections: [connection], timedOut: false });
  requests.disconnect(second);
  assert.deepEqual(await foreign, { connections: [], timedOut: false });
  assert.equal(requests.removeChatAgent(agent.agentId, target, 1000), 1);
  assert.deepEqual(await requests.waitForConnection(first, 1000, 1000), { connections: [], timedOut: true });
  const timeout = requests.waitForConnection(first, 1000, 1001);
  assert.ok(timeout && timeout !== "busy");
  assert.deepEqual(await timeout, { connections: [], timedOut: true });
  const late = requests.waitForConnection(first, 1000, 1001);
  assert.ok(late && late !== "busy");
  assert.ok(requests.approveAgent(agent.agentId, target, 1001));
  assert.deepEqual(await late, { connections: [], timedOut: true });
  assert.equal(requests.getConnectionExpiresAt(first, connection.connectionId, 1001), null);
  requests.disconnect(first);
});

test("autonomous grant records are bounded including retained revocation tombstones", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("owner");
  const agent = requests.registerAgent(owner);
  const target = { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
    tabId: 1, documentId: "synthetic-document" } as const;
  for (let tabId = 1; tabId <= MAX_AUTONOMOUS_CONNECTIONS; tabId++) {
    assert.ok(requests.approveAgent(agent.agentId, { ...target, tabId }, 1000));
  }
  assert.ok(requests.approveAgent(agent.agentId, target, 1000));
  assert.equal(requests.approveAgent(agent.agentId, { ...target, tabId: 101 }, 1000), null);
  assert.equal(requests.disconnectChat(target, 1000), 1);
  assert.equal(requests.approveAgent(agent.agentId, target, 1000), null);
  assert.ok(requests.approveAgent(agent.agentId, target, 1000 + PENDING_REQUEST_TTL_MS));
  requests.disconnect(owner);
});

test("agent identity registration has bounded immutable labels and capacity", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("agent owner");
  for (const label of ["", " padded", "padded ", "line\nbreak", "x".repeat(81), "\u202eHidden"]) {
    assert.throws(() => requests.registerAgent(owner, label), /Invalid broker-owned/);
  }
  const agent = requests.registerAgent(owner);
  assert.ok(Object.isFrozen(agent));
  assert.throws(() => requests.registerAgent(owner), /already registered/);
  for (let index = 1; index < MAX_CONNECTED_AGENTS; index++) requests.registerAgent(Symbol("other agent"));
  assert.throws(() => requests.registerAgent(Symbol("over capacity")), /Too many connected agents/);
  requests.disconnect(owner);
  assert.ok(requests.registerAgent(owner));
});

test("pending requests remain private to their broker-owned client", () => {
  const requests = new PendingConnectionRequests();
  const firstClient = Symbol("first client");
  const secondClient = Symbol("second client");
  const created = requests.create(firstClient, 1000);

  assert.match(created.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created, { requestId: created.requestId, state: "pending", expiresAt: 1000 + PENDING_REQUEST_TTL_MS });
  assert.equal(requests.get(secondClient, created.requestId, 1000), null);
  assert.deepEqual(requests.get(firstClient, created.requestId, 1000), created);
  assert.deepEqual(requests.listPending(1000), [{ requestId: created.requestId, expiresAt: created.expiresAt }]);
  assert.deepEqual(requests.listPending(created.expiresAt), []);
  assert.deepEqual(requests.get(firstClient, created.requestId, created.expiresAt), { ...created, state: "expired" });

  requests.disconnect(secondClient);
  assert.deepEqual(requests.get(firstClient, created.requestId, 1000), created);
  requests.disconnect(firstClient);
  assert.equal(requests.get(firstClient, created.requestId, 1000), null);
  assert.deepEqual(requests.listPending(1000), []);
});

test("bounds pending requests and releases expired records before accepting another", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("authenticated client");
  const first = requests.create(owner, 1000);
  for (let index = 1; index < MAX_PENDING_REQUESTS; index++) requests.create(owner, 1000);

  assert.throws(() => requests.create(owner, 1000), /Too many pending connections/);
  const next = requests.create(owner, 1000 + PENDING_REQUEST_TTL_MS);
  assert.equal(next.state, "pending");
  assert.equal(next.expiresAt, 1000 + PENDING_REQUEST_TTL_MS * 2);
  assert.equal(requests.get(owner, first.requestId, next.expiresAt - 1)?.state, "expired");
  assert.equal(requests.get(Symbol("another client"), first.requestId, next.expiresAt - 1), null);
  assert.equal(requests.get(owner, first.requestId, next.expiresAt), null);
});

test("a fixture grant is one-shot, owner-bound, and expires without exposing tab metadata", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("request owner");
  const stranger = Symbol("another MCP client");
  const pending = requests.create(owner, 1000);
  const target = {
    origin: "http://127.0.0.1:8787" as const,
    conversationId: "fixture-alpha" as const,
    tabId: 3,
    documentId: "a66b3997-9d43-4554-8399-267d1fe9f75c"
  };

  assert.equal(requests.approve(pending.requestId, { ...target, tabId: 0 }, 2000), null);
  assert.equal(requests.approve(pending.requestId, { ...target, documentId: "" }, 2000), null);
  assert.equal(requests.approve(pending.requestId, { ...target, documentId: "x".repeat(129) }, 2000), null);
  assert.equal(requests.approve("unknown", target, 2000), null);
  assert.equal(requests.get(stranger, pending.requestId, 2000), null);
  assert.equal(requests.getApprovedTarget(owner, pending.requestId, 2000), null);
  const granted = requests.approve(pending.requestId, target, 2000);
  assert.equal(granted?.state, "ready_readonly");
  assert.match(granted?.connectionId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(granted?.expiresAt, 2000 + READONLY_CONNECTION_TTL_MS);
  assert.equal("tabId" in granted!, false);
  assert.equal("documentId" in granted!, false);
  assert.deepEqual(requests.get(owner, pending.requestId, 2000), { ...granted,
    observation: { state: "not_observed", capturedAt: null } });
  assert.equal(requests.get(stranger, pending.requestId, 2000), null);
  assert.deepEqual(requests.getApprovedTarget(owner, granted!.connectionId, 2000), target);
  assert.equal(requests.getGeminiTarget(owner, granted!.connectionId, 2000), null);
  assert.equal(requests.getApprovedTarget(stranger, granted!.connectionId, 2000), null);
  assert.deepEqual(requests.listPending(2000), []);
  assert.equal(requests.approve(pending.requestId, target, 2001), null);
  assert.equal(requests.get(owner, pending.requestId, granted!.expiresAt)?.state, "expired");
  assert.equal(requests.getApprovedTarget(owner, granted!.connectionId, granted!.expiresAt), null);
  requests.disconnect(owner);
  assert.equal(requests.get(owner, pending.requestId, 2000), null);
  assert.equal(requests.getApprovedTarget(owner, granted!.connectionId, 2000), null);

  const upper = requests.create(owner, 1000);
  assert.equal(requests.approve(upper.requestId, { ...target, documentId: "CHROME-doc_opaque-42" }, 2000)?.state,
    "ready_readonly");
  const expired = requests.create(owner, 1000);
  assert.equal(requests.approve(expired.requestId, target, expired.expiresAt), null);
});

test("a changed fixture document or conversation revokes a grant without reviving its handle", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("MCP client");
  const pending = requests.create(owner, 1000);
  const target = {
    origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42"
  };
  const granted = requests.approve(pending.requestId, target, 2000);
  assert.equal(requests.revokeChangedTab(3, { documentId: target.documentId, conversationId: target.conversationId }), 0);
  assert.deepEqual(requests.get(owner, pending.requestId, 2000), { ...granted,
    observation: { state: "not_observed", capturedAt: null } });
  assert.equal(requests.revokeChangedTab(3, { documentId: "new-document", conversationId: target.conversationId }), 1);
  assert.deepEqual(requests.get(owner, pending.requestId, 2000), { requestId: pending.requestId, state: "stale" });
  assert.equal(requests.getApprovedTarget(owner, granted!.connectionId, 2000), null);
  assert.equal(requests.revokeChangedTab(3, { documentId: target.documentId, conversationId: target.conversationId }), 0);
  assert.equal(requests.approve(pending.requestId, target, 2000), null);
  assert.equal(requests.get(Symbol("another client"), pending.requestId, 2000), null);

  const second = requests.create(owner, 1000);
  requests.approve(second.requestId, target, 2000);
  assert.equal(requests.revokeChangedTab(3, { documentId: target.documentId, conversationId: "fixture-beta" }), 1);
  assert.equal(requests.get(owner, second.requestId, 2000)?.state, "stale");
  const third = requests.create(owner, 1000);
  requests.approve(third.requestId, target, 2000);
  assert.equal(requests.revokeChangedTab(3, null), 1);
  assert.equal(requests.get(owner, third.requestId, 2000)?.state, "stale");
});

test("a new extension instance revokes all grants but leaves unapproved requests pending", () => {
  const requests = new PendingConnectionRequests();
  const first = Symbol("first client");
  const second = Symbol("second client");
  const target = {
    origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42"
  };
  const firstRequest = requests.create(first, 1000);
  const secondRequest = requests.create(second, 1000);
  const stillPending = requests.create(first, 1000);
  requests.approve(firstRequest.requestId, target, 2000);
  requests.approve(secondRequest.requestId, { ...target, tabId: 4 }, 2000);

  assert.equal(requests.revokeAllFixtures(), 2);
  assert.deepEqual(requests.get(first, firstRequest.requestId, 2000), { requestId: firstRequest.requestId, state: "stale" });
  assert.deepEqual(requests.get(second, secondRequest.requestId, 2000), { requestId: secondRequest.requestId, state: "stale" });
  assert.equal(requests.get(first, stillPending.requestId, 2000)?.state, "pending");
  assert.equal(requests.revokeAllFixtures(), 0);
});

test("bounded fixture snapshots belong only to live matching grants and retain a cursor", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("approved reader");
  const stranger = Symbol("other reader");
  const pending = requests.create(owner, 1000);
  const target = {
    origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42"
  };
  const messages = [{ id: "fixture-1", direction: "incoming" as const, text: "One" }];
  assert.equal(requests.publishFixtureSnapshot(target, messages, 1000), 0);
  const grant = requests.approve(pending.requestId, target, 2000)!;
  assert.equal(requests.getFixtureSnapshot(owner, grant.connectionId, 2000), "not_ready");
  assert.equal(requests.publishFixtureSnapshot({ ...target, documentId: "other" }, messages, 2001), 0);
  assert.equal(requests.publishFixtureSnapshot(target, messages, 2001), 1);
  const initial = requests.getFixtureSnapshot(owner, grant.connectionId, 2001);
  assert.notEqual(initial, null);
  assert.notEqual(initial, "not_ready");
  if (!initial || initial === "not_ready") throw new Error("Expected a fixture snapshot");
  assert.deepEqual(initial.messages, messages);
  assert.equal(initial.coverage, "rendered_only");
  assert.equal(initial.capturedAt, 2001);
  assert.equal(initial.cursor.sequence, 1);
  const recentHealth = requests.get(owner, pending.requestId, 2001);
  if (recentHealth?.state !== "ready_readonly") throw new Error("Expected a ready recent connection");
  assert.deepEqual(recentHealth.observation, { state: "recent", capturedAt: 2001 });
  const oldHealth = requests.get(owner, pending.requestId, 2002 + MAX_FIXTURE_SNAPSHOT_AGE_MS);
  if (oldHealth?.state !== "ready_readonly") throw new Error("Expected a ready old connection");
  assert.deepEqual(oldHealth.observation, { state: "old", capturedAt: 2001 });
  const atSnapshot = requests.readFixtureEvents(owner, grant.connectionId, initial.cursor, 1, 2001);
  if (!atSnapshot || atSnapshot === "not_ready" || atSnapshot.state !== "ok") {
    throw new Error("Expected an empty initial event page");
  }
  assert.deepEqual(atSnapshot.events, []);
  assert.equal(requests.readFixtureEvents(stranger, grant.connectionId, initial.cursor, 1, 2001), null);
  assert.equal(requests.getFixtureSnapshot(stranger, grant.connectionId, 2001), null);
  assert.equal(requests.getFixtureSnapshot(owner, grant.connectionId, 2001 + MAX_FIXTURE_SNAPSHOT_AGE_MS), initial);
  assert.equal(requests.publishFixtureSnapshot(target, messages, 2002), 1);
  const refreshed = requests.getFixtureSnapshot(owner, grant.connectionId, 2002);
  if (!refreshed || refreshed === "not_ready") throw new Error("Expected refreshed snapshot metadata");
  assert.equal(refreshed.cursor.sequence, initial.cursor.sequence);
  assert.equal(refreshed.capturedAt, 2002);
  assert.deepEqual(requests.readFixtureEvents(owner, grant.connectionId, initial.cursor, 1, 2002), atSnapshot);
  assert.equal(requests.getFixtureSnapshot(owner, grant.connectionId, 2003 + MAX_FIXTURE_SNAPSHOT_AGE_MS), "not_ready");
  assert.throws(() => requests.publishFixtureSnapshot(target, [...messages, messages[0]!], 2002), /Invalid fixture snapshot/);
  messages[0]!.text = "Changed after publication";
  assert.equal(initial.messages[0]?.text, "One");
  assert.equal(requests.publishFixtureSnapshot(target, messages, 2002), 1);
  const updated = requests.getFixtureSnapshot(owner, grant.connectionId, 2002);
  if (!updated || updated === "not_ready") throw new Error("Expected a newer snapshot");
  assert.equal(updated.cursor.epoch, initial.cursor.epoch);
  assert.equal(updated.cursor.sequence, 2);
  assert.equal(updated.messages[0]?.text, "Changed after publication");
  const events = requests.readFixtureEvents(owner, grant.connectionId, initial.cursor, 1, 2002);
  if (!events || events === "not_ready" || events.state !== "ok") throw new Error("Expected one later observation");
  assert.equal(events.events.length, 1);
  assert.equal(events.cursor.sequence, 2);
  assert.deepEqual(events.events[0]?.payload, { kind: "fixture_snapshot", messages, omittedBefore: false });
  assert.deepEqual(requests.readFixtureEvents(owner, grant.connectionId, { epoch: "other", sequence: 1 }, 1, 2002),
    { state: "expired", resnapshot: true });
  assert.equal(requests.getFixtureSnapshot(owner, grant.connectionId, grant.expiresAt), null);
  assert.equal(requests.revokeChangedTab(3, null), 1);
  assert.equal(requests.getFixtureSnapshot(owner, grant.connectionId, 2003), null);
  assert.equal(requests.readFixtureEvents(owner, grant.connectionId, initial.cursor, 1, 2003), null);
  assert.equal(requests.publishFixtureSnapshot(target, messages, 2003), 0);
});

for (const provider of ["fixture", "gemini"] as const) {
  test(`${provider} observation flags participate in deduplication and bounded event retention`, () => {
    const requests = new PendingConnectionRequests();
    const owner = Symbol("reader");
    const pending = requests.create(owner, 1000);
    const fixtureTarget = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_window" };
    const geminiTarget = { origin: "https://gemini.google.com" as const, conversationId: "disposable-chat",
      url: "https://gemini.google.com/app/disposable-chat", tabId: 4, documentId: "CHROME-doc_window" };
    const grant = (provider === "fixture" ? requests.approve(pending.requestId, fixtureTarget, 2000)
      : requests.approveGemini(pending.requestId, geminiTarget, 2000))!;
    const publish = (text: string, truncated?: true, omittedBefore = false, count = 1) => {
      const rows = Array.from({ length: count }, () => ({ direction: "incoming" as const, text,
        ...(truncated ? { truncated } : {}) }));
      return provider === "fixture"
        ? requests.publishFixtureSnapshot(fixtureTarget, rows.map((row, index) => ({ ...row, id: `row-${index}` })),
          2001, undefined, omittedBefore)
        : requests.publishGeminiSnapshot(geminiTarget, rows, 2001, undefined, omittedBefore);
    };
    const snapshot = () => {
      const result = provider === "fixture" ? requests.getFixtureSnapshot(owner, grant.connectionId, 2001)
        : requests.getGeminiSnapshot(owner, grant.connectionId, 2001);
      if (!result || result === "not_ready") throw new Error("Expected a snapshot");
      return result;
    };
    const events = (cursor: ReturnType<typeof snapshot>["cursor"], limit = 2) => provider === "fixture"
      ? requests.readFixtureEvents(owner, grant.connectionId, cursor, limit, 2001)
      : requests.readGeminiEvents(owner, grant.connectionId, cursor, limit, 2001);
    assert.equal(publish("x".repeat(16000)), 1);
    const initial = snapshot();
    assert.equal(initial.omittedBefore, false);
    assert.equal(initial.messages[0]?.truncated, undefined);
    assert.equal(publish("x".repeat(16000), true), 1);
    assert.equal(snapshot().messages[0]?.truncated, true);
    assert.equal(snapshot().cursor.sequence, initial.cursor.sequence + 1);
    assert.equal(publish("x".repeat(16000), true, true), 1);
    assert.equal(snapshot().omittedBefore, true);
    assert.equal(snapshot().cursor.sequence, initial.cursor.sequence + 2);
    publish("x".repeat(16000), true, true);
    assert.equal(snapshot().cursor.sequence, initial.cursor.sequence + 2);
    const flagged = events(initial.cursor);
    if (!flagged || flagged === "not_ready" || flagged.state !== "ok") throw new Error("Expected flag events");
    assert.equal(flagged.events.length, 2);
    assert.equal((flagged.events[0]?.payload as { omittedBefore: boolean }).omittedBefore, false);
    assert.equal((flagged.events[1]?.payload as { omittedBefore: boolean }).omittedBefore, true);
    assert.throws(() => publish("x".repeat(16001)), /Invalid .* snapshot/);
    assert.throws(() => publish("x", undefined, false, 33), /Invalid .* snapshot/);
    assert.throws(() => publish("x".repeat(16000), true, false, 7), /Invalid .* snapshot/);
    const beforeLarge = snapshot().cursor;
    publish("x".repeat(16000), true, true, 6);
    publish("y".repeat(16000), true, true, 6);
    const large = events(beforeLarge);
    if (!large || large === "not_ready" || large.state !== "ok") throw new Error("Expected two large events");
    assert.equal(large.events.length, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(large)) < 256 * 1024);
    const retained = snapshot().cursor;
    for (let index = 0; index < 128; index++) publish(`Small ${index}`);
    const atCapacity = events(retained);
    assert.ok(atCapacity && atCapacity !== "not_ready" && atCapacity.state === "ok");
    publish("Evict oldest");
    assert.deepEqual(events(retained), { state: "expired", resnapshot: true });
    const byteRetained = snapshot().cursor;
    for (let index = 0; index < 43; index++) publish(String(index).padEnd(16000, "z"), true, true, 6);
    const belowByteCap = events(byteRetained);
    assert.ok(belowByteCap && belowByteCap !== "not_ready" && belowByteCap.state === "ok");
    publish("Byte pressure".padEnd(16000, "z"), true, true, 6);
    assert.deepEqual(events(byteRetained), { state: "expired", resnapshot: true });
    if (provider === "fixture") {
      assert.throws(() => requests.publishFixtureSnapshot(fixtureTarget,
        [{ id: "row", direction: "incoming", text: "x", truncated: false } as never], 2001), /Invalid fixture snapshot/);
      assert.throws(() => requests.publishFixtureSnapshot(fixtureTarget,
        [{ id: "row", direction: "incoming", text: "x", extra: true } as never], 2001), /Invalid fixture snapshot/);
    } else {
      assert.throws(() => requests.publishGeminiSnapshot(geminiTarget,
        [{ direction: "incoming", text: "x", truncated: false } as never], 2001), /Invalid Gemini snapshot/);
      assert.throws(() => requests.publishGeminiSnapshot(geminiTarget,
        [{ direction: "incoming", text: "x", extra: true } as never], 2001), /Invalid Gemini snapshot/);
    }
  });
}

test("fresh fixture read challenges belong to a live owner and expire or cancel without exposing rows", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("reader");
  const pending = requests.create(owner, 1000);
  const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42" };
  assert.equal(requests.requestFreshFixtureRead(owner, pending.requestId, 2000), null);
  const grant = requests.approve(pending.requestId, target, 2000)!;
  assert.equal(requests.requestFreshFixtureRead(Symbol("stranger"), grant.connectionId, 2001), null);
  const first = requests.requestFreshFixtureRead(owner, grant.connectionId, 2001);
  if (!first || first === "busy") throw new Error("Expected a read challenge");
  assert.deepEqual(requests.listFixtureReadChallenges(2001), [{
    challengeId: first.challengeId, target, expiresAt: 2001 + FIXTURE_READ_TIMEOUT_MS
  }]);
  assert.deepEqual(requests.listFixtureReadChallenges(2001 + FIXTURE_READ_TIMEOUT_MS), []);
  assert.equal(await first.result, "not_ready");

  const second = requests.requestFreshFixtureRead(owner, grant.connectionId, 2002);
  if (!second || second === "busy") throw new Error("Expected another challenge");
  assert.equal(requests.revokeChangedTab(3, null), 1);
  assert.equal(await second.result, null);
  assert.deepEqual(requests.listFixtureReadChallenges(2002), []);
  assert.equal(requests.requestFreshFixtureRead(owner, grant.connectionId, 2002), null);

  const another = requests.create(owner, 1000);
  const anotherGrant = requests.approve(another.requestId, target, 2000)!;
  const third = requests.requestFreshFixtureRead(owner, anotherGrant.connectionId, 2002);
  if (!third || third === "busy") throw new Error("Expected an owned challenge");
  requests.disconnect(owner);
  assert.equal(await third.result, null);
  assert.deepEqual(requests.listFixtureReadChallenges(2002), []);
});

test("fixture reads preserve the original request and grant deadlines without creating authority", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("reader");
  const pending = requests.create(owner, 1000);
  const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42" };
  const grant = requests.approve(pending.requestId, target, 2000)!;
  for (const deadlineMs of [2000, 2001, 2001.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(requests.requestFreshFixtureRead(owner, grant.connectionId, 2001, deadlineMs), null);
    assert.deepEqual(requests.listFixtureReadChallenges(2001), []);
  }
  const clipped = requests.requestFreshFixtureRead(owner, grant.connectionId, 2001, 2002);
  if (!clipped || clipped === "busy") throw new Error("Expected request-clipped read");
  assert.deepEqual(requests.listFixtureReadChallenges(2001), [{ challengeId: clipped.challengeId, target, expiresAt: 2002 }]);
  assert.equal(await clipped.result, "not_ready");
  assert.deepEqual(requests.listFixtureReadChallenges(2002), []);
  const beforeExpiry = grant.expiresAt - 2;
  const grantClipped = requests.requestFreshFixtureRead(owner, grant.connectionId, beforeExpiry, grant.expiresAt + 1000);
  if (!grantClipped || grantClipped === "busy") throw new Error("Expected original-grant-clipped read");
  assert.deepEqual(requests.listFixtureReadChallenges(beforeExpiry), [{ challengeId: grantClipped.challengeId,
    target, expiresAt: grant.expiresAt }]);
  assert.deepEqual(requests.listFixtureReadChallenges(grant.expiresAt), []);
  assert.equal(await grantClipped.result, "not_ready");
  assert.equal(requests.requestFreshFixtureRead(owner, grant.connectionId, grant.expiresAt, grant.expiresAt + 1), null);
});

test("only a new exact-target publication completes its read challenge once", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("reader");
  const pending = requests.create(owner, 1000);
  const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42" };
  const grant = requests.approve(pending.requestId, target, 2000)!;
  const messages = [{ id: "fixture-1", direction: "incoming" as const, text: "Old row" }];
  assert.equal(requests.publishFixtureSnapshot(target, messages, 2001), 1);
  const challenge = requests.requestFreshFixtureRead(owner, grant.connectionId, 2002);
  if (!challenge || challenge === "busy") throw new Error("Expected a fresh-read challenge");
  assert.equal(requests.publishFixtureSnapshot({ ...target, documentId: "other" }, messages, 2003,
    challenge.challengeId), 0);
  assert.equal(requests.publishFixtureSnapshot(target, messages, 2003, "a66b3997-9d43-4554-8399-267d1fe9f75c"), 0);
  assert.equal(requests.listFixtureReadChallenges(2003).length, 1);
  const updated = [{ ...messages[0]!, text: "Current row" }];
  assert.equal(requests.publishFixtureSnapshot(target, updated, 2004, challenge.challengeId), 1);
  const observed = await challenge.result;
  if (!observed || observed === "not_ready") throw new Error("Expected the challenged snapshot");
  assert.equal(observed.messages[0]?.text, "Current row");
  assert.equal(observed.capturedAt, 2004);
  assert.deepEqual(requests.listFixtureReadChallenges(2004), []);
  assert.equal(requests.publishFixtureSnapshot(target, updated, 2005, challenge.challengeId), 0);
  const unchangedRead = requests.requestFreshFixtureRead(owner, grant.connectionId, 2005);
  if (!unchangedRead || unchangedRead === "busy") throw new Error("Expected a second read challenge");
  assert.equal(requests.publishFixtureSnapshot(target, updated, 2006, unchangedRead.challengeId), 1);
  const unchanged = await unchangedRead.result;
  if (!unchanged || unchanged === "not_ready") throw new Error("Expected a refreshed read");
  assert.equal(unchanged.capturedAt, 2006);
  assert.equal(unchanged.cursor.sequence, observed.cursor.sequence);
  const events = requests.readFixtureEvents(owner, grant.connectionId, observed.cursor, 1, 2006);
  if (!events || events === "not_ready" || events.state !== "ok") throw new Error("Expected an empty event page");
  assert.deepEqual(events.events, []);
});

test("owner disconnect revokes one fixture grant and cancels its pending reads", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("disconnecting client");
  const other = Symbol("other owner");
  const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42" };
  const first = requests.create(owner, 1000);
  const second = requests.create(other, 1000);
  const firstGrant = requests.approve(first.requestId, target, 2000)!;
  const secondGrant = requests.approve(second.requestId, { ...target, tabId: 4 }, 2000)!;
  assert.deepEqual(requests.listActiveFixtureTabIds(2001), [3, 4]);
  assert.equal(requests.disconnectFixture(other, firstGrant.connectionId, 2001), false);
  const reading = requests.requestFreshFixtureRead(owner, firstGrant.connectionId, 2001);
  if (!reading || reading === "busy") throw new Error("Expected a pending read");
  assert.equal(requests.disconnectFixture(owner, firstGrant.connectionId, 2002), true);
  assert.equal(await reading.result, null);
  assert.equal(requests.disconnectFixture(owner, firstGrant.connectionId, 2002), false);
  assert.deepEqual(requests.get(owner, first.requestId, 2002), { requestId: first.requestId, state: "stale" });
  assert.equal(requests.getApprovedTarget(owner, firstGrant.connectionId, 2002), null);
  assert.deepEqual(requests.listActiveFixtureTabIds(2002), [4]);
  assert.equal(requests.get(other, second.requestId, 2002)?.state, "ready_readonly");
  requests.disconnect(other);
  assert.deepEqual(requests.listActiveFixtureTabIds(2002), []);
  assert.equal(requests.getApprovedTarget(other, secondGrant.connectionId, 2002), null);
});

test("one exact Gemini conversation grants only its MCP owner without enabling fixture reads", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("approved reader");
  const stranger = Symbol("another client");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com" as const,
    conversationId: "disposable-chat", url: "https://gemini.google.com/app/disposable-chat",
    tabId: 4, documentId: "CHROME-doc_gemini-42" };
  assert.equal(requests.approveGemini(pending.requestId, { ...target, origin: "http://127.0.0.1:8787" as never }, 2000), null);
  assert.equal(requests.approveGemini(pending.requestId, { ...target,
    url: `${target.url}?hl=${"x".repeat(512)}` }, 2000), null);
  assert.equal(requests.approveGemini(pending.requestId, { ...target, url: `${target.url}#conversation` }, 2000), null);
  assert.equal(requests.approveGemini(pending.requestId, { ...target, conversationId: "another-chat" }, 2000), null);
  assert.equal(requests.approveGemini(pending.requestId, { ...target, documentId: "" }, 2000), null);
  assert.equal(requests.approveGemini(pending.requestId, { ...target, tabId: 0 }, 2000), null);
  assert.equal(requests.getGeminiTarget(owner, pending.requestId, 2000), null);
  const granted = requests.approveGemini(pending.requestId, target, 2000);
  assert.equal(granted?.state, "ready_readonly");
  assert.equal(granted?.origin, "https://gemini.google.com");
  assert.equal(granted?.conversationId, "disposable-chat");
  assert.equal("url" in granted!, false);
  assert.equal("documentId" in granted!, false);
  assert.equal(requests.get(stranger, pending.requestId, 2000), null);
  assert.equal(requests.get(owner, pending.requestId, 2000)?.state, "ready_readonly");
  assert.deepEqual(requests.getGeminiTarget(owner, granted!.connectionId, 2000), target);
  assert.equal(requests.getGeminiTarget(stranger, granted!.connectionId, 2000), null);
  assert.equal(requests.getGeminiTarget(owner, granted!.connectionId, granted!.expiresAt), null);
  const messages = [
    { direction: "outgoing" as const, text: "OK" },
    { direction: "outgoing" as const, text: "OK" },
    { direction: "incoming" as const, text: "Reply" }
  ];
  assert.equal(requests.getGeminiSnapshot(owner, granted!.connectionId, 2000), "not_ready");
  assert.equal(requests.getGeminiSnapshot(stranger, granted!.connectionId, 2000), null);
  assert.equal(requests.publishGeminiSnapshot({ ...target, url: `${target.url}?hl=en` }, messages, 2001), 0);
  assert.equal(requests.publishGeminiSnapshot({ ...target, documentId: "other" }, messages, 2001), 0);
  assert.equal(requests.publishGeminiSnapshot(target, messages, 2001), 1);
  const snapshot = requests.getGeminiSnapshot(owner, granted!.connectionId, 2001);
  if (!snapshot || snapshot === "not_ready") throw new Error("Expected a private Gemini snapshot");
  assert.deepEqual(snapshot.messages, messages.map((message) => ({ ...message,
    identityQuality: "uncertain", generationState: "unknown" })));
  assert.equal(snapshot.coverage, "rendered_only");
  assert.equal(snapshot.cursor.sequence, 1);
  const initialEvents = requests.readGeminiEvents(owner, granted!.connectionId, snapshot.cursor, 1, 2001);
  if (!initialEvents || initialEvents === "not_ready" || initialEvents.state !== "ok") {
    throw new Error("Expected an empty Gemini event page");
  }
  assert.deepEqual(initialEvents.events, []);
  assert.equal(requests.readGeminiEvents(stranger, granted!.connectionId, snapshot.cursor, 1, 2001), null);
  assert.deepEqual((requests.get(owner, pending.requestId, 2001) as { observation: unknown }).observation,
    { state: "recent", capturedAt: 2001 });
  assert.equal(requests.publishGeminiSnapshot(target, messages, 2002), 1);
  const refreshed = requests.getGeminiSnapshot(owner, granted!.connectionId, 2002);
  if (!refreshed || refreshed === "not_ready") throw new Error("Expected refreshed Gemini capture");
  assert.equal(refreshed.capturedAt, 2002);
  assert.equal(refreshed.cursor.sequence, snapshot.cursor.sequence);
  assert.equal(requests.getGeminiSnapshot(owner, granted!.connectionId, 2002 + MAX_GEMINI_SNAPSHOT_AGE_MS + 1),
    "not_ready");
  const later = [...messages, { direction: "incoming" as const, text: "Another reply" }];
  assert.equal(requests.publishGeminiSnapshot(target, later, 2003), 1);
  const events = requests.readGeminiEvents(owner, granted!.connectionId, snapshot.cursor, 1, 2003);
  if (!events || events === "not_ready" || events.state !== "ok") throw new Error("Expected one Gemini update");
  assert.equal(events.cursor.sequence, snapshot.cursor.sequence + 1);
  assert.deepEqual(events.events[0]?.payload, { kind: "gemini_snapshot", omittedBefore: false, messages: later.map((message) => ({
    ...message, identityQuality: "uncertain", generationState: "unknown"
  })) });
  assert.deepEqual(requests.readGeminiEvents(owner, granted!.connectionId, { epoch: "other", sequence: 1 }, 1, 2003),
    { state: "expired", resnapshot: true });
  const streaming = later.map((message, index) => index === later.length - 1 ? { ...message, generationState: "streaming" as const } : message);
  assert.equal(requests.publishGeminiSnapshot(target, streaming, 2004), 1);
  const busy = requests.getGeminiSnapshot(owner, granted!.connectionId, 2004);
  if (!busy || busy === "not_ready") throw new Error("Expected streaming capture");
  assert.equal(busy.messages.at(-1)?.generationState, "streaming");
  assert.equal(busy.cursor.sequence, events.cursor.sequence + 1);
  assert.equal(requests.publishGeminiSnapshot(target, streaming, 2005), 1);
  assert.equal(requests.publishGeminiSnapshot(target, later, 2006), 1);
  const quiet = requests.getGeminiSnapshot(owner, granted!.connectionId, 2006);
  if (!quiet || quiet === "not_ready") throw new Error("Expected unknown capture after streaming");
  assert.equal(quiet.messages.at(-1)?.generationState, "unknown");
  assert.equal(quiet.cursor.sequence, busy.cursor.sequence + 1);
  const completed = later.map((message, index) => index === later.length - 1 ? { ...message, generationState: "complete" as const } : message);
  assert.equal(requests.publishGeminiSnapshot(target, completed, 2007), 1);
  const terminal = requests.getGeminiSnapshot(owner, granted!.connectionId, 2007);
  if (!terminal || terminal === "not_ready") throw new Error("Expected UI-complete capture");
  assert.equal(terminal.messages.at(-1)?.generationState, "complete");
  assert.equal(terminal.cursor.sequence, quiet.cursor.sequence + 1);
  assert.throws(() => requests.publishGeminiSnapshot(target, [{ direction: "incoming", text: "Reply", generationState: "settled_heuristic" as never }], 2007),
    /Invalid Gemini snapshot/);
  assert.throws(() => requests.publishGeminiSnapshot(target, [{ direction: "outgoing", text: "Question", generationState: "complete" }], 2007),
    /Invalid Gemini snapshot/);
  assert.throws(() => requests.publishGeminiSnapshot(target, [{ direction: "outgoing", text: "Question", generationState: "streaming" }], 2007),
    /Invalid Gemini snapshot/);
  assert.throws(() => requests.publishGeminiSnapshot(target, [{ direction: "incoming", text: "x".repeat(16001) }], 2002),
    /Invalid Gemini snapshot/);
  assert.throws(() => requests.publishGeminiSnapshot(target, [{ direction: "incoming", text: 0 as never }], 2002),
    /Invalid Gemini snapshot/);
  assert.throws(() => requests.publishGeminiSnapshot(target, Array.from({ length: 32 }, () => ({
    direction: "incoming", text: "é".repeat(2048)
  })), 2002), /Invalid Gemini snapshot/);
  assert.equal(requests.getApprovedTarget(owner, granted!.connectionId, 2000), null);
  assert.equal(requests.getFixtureSnapshot(owner, granted!.connectionId, 2000), null);
  assert.equal(requests.requestFreshFixtureRead(owner, granted!.connectionId, 2000), null);
  assert.deepEqual(requests.listActiveFixtureTabIds(2000), []);
  assert.equal(requests.approveGemini(pending.requestId, target, 2000), null);
  assert.equal(requests.revokeChangedTab(4, { documentId: "another-document", conversationId: target.conversationId }), 1);
  assert.deepEqual(requests.get(owner, pending.requestId, 2001), { requestId: pending.requestId, state: "stale" });
  assert.equal(requests.getGeminiTarget(owner, granted!.connectionId, 2001), null);
  assert.equal(requests.getGeminiSnapshot(owner, granted!.connectionId, 2001), null);
  assert.equal(requests.readGeminiEvents(owner, granted!.connectionId, snapshot.cursor, 1, 2001), null);
  const queryPending = requests.create(owner, 1000);
  const queryTarget = { ...target, url: `${target.url}?hl=en` };
  const queryGrant = requests.approveGemini(queryPending.requestId, queryTarget, 2000);
  assert.equal(queryGrant?.state, "ready_readonly");
  assert.equal("url" in queryGrant!, false);
  assert.deepEqual(requests.get(owner, queryPending.requestId, 2000)?.state, "ready_readonly");
  assert.deepEqual(requests.getGeminiTarget(owner, queryGrant!.connectionId, 2000), queryTarget);
  assert.equal(requests.approveGemini(requests.create(owner, 1000).requestId, target, 61_000), null);
  assert.equal(requests.revokeAllFixtures(), 1);
  assert.equal(requests.getGeminiTarget(owner, queryGrant!.connectionId, 2001), null);
});

test("Gemini fresh reads preserve the original request and grant deadline without renewing authority", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("bounded Gemini read");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com" as const, conversationId: "synthetic-chat",
    url: "https://gemini.google.com/app/synthetic-chat?hl=en", tabId: 4, documentId: "synthetic-document" };
  const grant = requests.approveGemini(pending.requestId, target, 2000)!;
  try {
    for (const deadline of [NaN, Infinity, 2001, 2000, 2001.5]) {
      assert.equal(requests.requestFreshGeminiRead(owner, grant.connectionId, 2001, deadline), null);
      assert.deepEqual(requests.listGeminiReadChallenges(2001), []);
    }
    assert.equal(requests.requestFreshGeminiRead(Symbol("foreign"), grant.connectionId, 2001, 2002), null);
    const clipped = requests.requestFreshGeminiRead(owner, grant.connectionId, 2001, 2002);
    assert.ok(clipped && clipped !== "busy");
    assert.equal(requests.listGeminiReadChallenges(2001)[0]?.expiresAt, 2002);
    assert.deepEqual(requests.listGeminiReadChallenges(2002), []);
    assert.equal(await clipped.result, "not_ready");
    assert.equal(requests.publishGeminiSnapshot(target, [{ direction: "incoming", text: "Synthetic late row" }],
      2002, clipped.challengeId), 0);
    const ordinary = requests.requestFreshGeminiRead(owner, grant.connectionId, 2003, 20_000);
    assert.ok(ordinary && ordinary !== "busy");
    assert.equal(requests.listGeminiReadChallenges(2003)[0]?.expiresAt, 2003 + GEMINI_READ_TIMEOUT_MS);
    requests.listGeminiReadChallenges(2003 + GEMINI_READ_TIMEOUT_MS);
    assert.equal(await ordinary.result, "not_ready");
    const beforeExpiry = grant.expiresAt - 1;
    const grantClipped = requests.requestFreshGeminiRead(owner, grant.connectionId, beforeExpiry, grant.expiresAt + 1000);
    assert.ok(grantClipped && grantClipped !== "busy");
    assert.equal(requests.listGeminiReadChallenges(beforeExpiry)[0]?.expiresAt, grant.expiresAt);
    assert.deepEqual(requests.listGeminiReadChallenges(grant.expiresAt), []);
    assert.equal(await grantClipped.result, "not_ready");
    assert.equal(requests.requestFreshGeminiRead(owner, grant.connectionId, grant.expiresAt, grant.expiresAt + 1), null);
    assert.equal(requests.getConnectionExpiresAt(owner, grant.connectionId, 2001), grant.expiresAt);
  } finally {
    requests.disconnect(owner);
  }
});

test("fresh Gemini challenges require the exact owner, URL and document and cannot be replayed", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("Gemini reader");
  const stranger = Symbol("other reader");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com" as const, conversationId: "disposable-chat",
    url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 4, documentId: "CHROME-doc_gemini-42" };
  const rows = [{ direction: "outgoing" as const, text: "Before" }];
  assert.equal(requests.requestFreshGeminiRead(owner, pending.requestId, 2000), null);
  const grant = requests.approveGemini(pending.requestId, target, 2000)!;
  assert.equal(requests.requestFreshGeminiRead(stranger, grant.connectionId, 2001), null);
  assert.deepEqual(requests.listActiveGeminiTabIds(2001), [4]);
  assert.deepEqual(requests.listActiveFixtureTabIds(2001), []);
  assert.equal(requests.publishGeminiSnapshot(target, rows, 2001), 1);
  const reading = requests.requestFreshGeminiRead(owner, grant.connectionId, 2002);
  if (!reading || reading === "busy") throw new Error("Expected a Gemini read challenge");
  assert.deepEqual(requests.listGeminiReadChallenges(2002), [{
    challengeId: reading.challengeId, target, expiresAt: 2002 + GEMINI_READ_TIMEOUT_MS
  }]);
  assert.equal(requests.publishGeminiSnapshot({ ...target, url: `${target.url}&other=1` }, rows,
    2003, reading.challengeId), 0);
  assert.equal(requests.publishGeminiSnapshot({ ...target, documentId: "other" }, rows,
    2003, reading.challengeId), 0);
  assert.equal(requests.publishGeminiSnapshot(target, rows, 2003,
    "a66b3997-9d43-4554-8399-267d1fe9f75c"), 0);
  assert.equal(requests.listGeminiReadChallenges(2003).length, 1);
  const current = [{ direction: "outgoing" as const, text: "After" }];
  assert.equal(requests.publishGeminiSnapshot(target, current, 2004, reading.challengeId), 1);
  const observed = await reading.result;
  if (!observed || observed === "not_ready") throw new Error("Expected challenged Gemini rows");
  assert.deepEqual(observed.messages[0], { ...current[0], identityQuality: "uncertain", generationState: "unknown" });
  assert.equal(observed.capturedAt, 2004);
  assert.deepEqual(requests.listGeminiReadChallenges(2004), []);
  assert.equal(requests.publishGeminiSnapshot(target, current, 2005, reading.challengeId), 0);

  const expired = requests.requestFreshGeminiRead(owner, grant.connectionId, 2005);
  if (!expired || expired === "busy") throw new Error("Expected another Gemini challenge");
  assert.deepEqual(requests.listGeminiReadChallenges(2005 + GEMINI_READ_TIMEOUT_MS), []);
  assert.equal(await expired.result, "not_ready");
  const cancelled = requests.requestFreshGeminiRead(owner, grant.connectionId, 2006);
  if (!cancelled || cancelled === "busy") throw new Error("Expected a cancellable Gemini challenge");
  assert.equal(requests.disconnectFixture(owner, grant.connectionId, 2007), true);
  assert.equal(await cancelled.result, null);
  assert.deepEqual(requests.listActiveGeminiTabIds(2007), []);
  assert.equal(requests.getGeminiSnapshot(owner, grant.connectionId, 2007), null);
  assert.equal(requests.requestFreshGeminiRead(owner, grant.connectionId, 2007), null);
});

test("worker wake marks an exact fixture observation gap without revoking its owner", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("returning reader");
  const pending = requests.create(owner, 1000);
  const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42" };
  const grant = requests.approve(pending.requestId, target, 2000)!;
  const rows = [{ id: "fixture-1", direction: "incoming" as const, text: "Before suspension" }];
  assert.equal(requests.publishFixtureSnapshot(target, rows, 2001), 1);
  const before = requests.getFixtureSnapshot(owner, grant.connectionId, 2001);
  if (!before || before === "not_ready") throw new Error("Expected the old cursor");
  const reading = requests.requestFreshFixtureRead(owner, grant.connectionId, 2002);
  if (!reading || reading === "busy") throw new Error("Expected a pending read");
  assert.equal(requests.markFixtureObservationGap({ ...target, documentId: "other" }, 2003), 0);
  assert.equal(requests.markFixtureObservationGap(target, 2003), 1);
  assert.equal(await reading.result, "not_ready");
  assert.equal(requests.getFixtureSnapshot(owner, grant.connectionId, 2003), "not_ready");
  assert.deepEqual(requests.readFixtureEvents(owner, grant.connectionId, before.cursor, 1, 2003),
    { state: "expired", resnapshot: true });
  const retry = requests.requestFreshFixtureRead(owner, grant.connectionId, 2003);
  if (!retry || retry === "busy") throw new Error("Expected a post-gap read challenge");
  assert.equal(requests.markFixtureObservationGap(target, 2004), 0);
  assert.equal(requests.listFixtureReadChallenges(2004).length, 1);
  assert.deepEqual(requests.get(owner, pending.requestId, 2003), { ...grant,
    observation: { state: "not_observed", capturedAt: null } });
  assert.equal(requests.publishFixtureSnapshot(target, rows, 2004, retry.challengeId), 1);
  assert.notEqual(await retry.result, "not_ready");
  const after = requests.getFixtureSnapshot(owner, grant.connectionId, 2004);
  if (!after || after === "not_ready") throw new Error("Expected a new snapshot epoch");
  assert.notEqual(after.cursor.epoch, before.cursor.epoch);
  assert.equal(after.cursor.sequence, 1);
  assert.equal(requests.markFixtureObservationGap(target, grant.expiresAt), 0);
});

test("Gemini worker wake expires only the exact approved chat's observed cursor", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("returning Gemini reader");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com" as const, conversationId: "disposable-chat",
    url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 4,
    documentId: "CHROME-doc_gemini-42" };
  const grant = requests.approveGemini(pending.requestId, target, 2000)!;
  const rows = [{ direction: "incoming" as const, text: "Synthetic before suspension" }];
  assert.equal(requests.publishGeminiSnapshot(target, rows, 2001), 1);
  const before = requests.getGeminiSnapshot(owner, grant.connectionId, 2001);
  if (!before || before === "not_ready") throw new Error("Expected an old Gemini cursor");
  const reading = requests.requestFreshGeminiRead(owner, grant.connectionId, 2002);
  if (!reading || reading === "busy") throw new Error("Expected a Gemini challenge");
  assert.equal(requests.markGeminiObservationGap({ ...target, url: `${target.url}&changed=1` }, 2003), 0);
  assert.equal(requests.markGeminiObservationGap({ ...target, documentId: "other" }, 2003), 0);
  assert.equal(requests.markGeminiObservationGap(target, 2003), 1);
  assert.equal(await reading.result, "not_ready");
  assert.equal(requests.getGeminiSnapshot(owner, grant.connectionId, 2003), "not_ready");
  assert.deepEqual(requests.readGeminiEvents(owner, grant.connectionId, before.cursor, 1, 2003),
    { state: "expired", resnapshot: true });
  assert.equal(requests.get(owner, pending.requestId, 2003)?.state, "ready_readonly");
  assert.equal(requests.markGeminiObservationGap(target, 2003), 0);
  const resumed = requests.requestFreshGeminiRead(owner, grant.connectionId, 2004);
  if (!resumed || resumed === "busy") throw new Error("Expected a post-gap Gemini challenge");
  assert.equal(requests.markGeminiObservationGap(target, 2004), 0);
  assert.equal(requests.publishGeminiSnapshot(target, rows, 2005, resumed.challengeId), 1);
  const after = await resumed.result;
  if (!after || after === "not_ready") throw new Error("Expected a resnapshot");
  assert.notEqual(after.cursor.epoch, before.cursor.epoch);
  assert.equal(after.cursor.sequence, 1);
  assert.equal(requests.markGeminiObservationGap(target, grant.expiresAt), 0);
});