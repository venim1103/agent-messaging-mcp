import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_READ_TIMEOUT_MS, GEMINI_READ_TIMEOUT_MS, MAX_FIXTURE_SNAPSHOT_AGE_MS, MAX_GEMINI_SNAPSHOT_AGE_MS,
  MAX_PENDING_REQUESTS, PendingConnectionRequests,
  PENDING_REQUEST_TTL_MS, READONLY_CONNECTION_TTL_MS }
  from "./pending-connections.js";

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
  assert.deepEqual(events.events[0]?.payload, { kind: "fixture_snapshot", messages });
  assert.deepEqual(requests.readFixtureEvents(owner, grant.connectionId, { epoch: "other", sequence: 1 }, 1, 2002),
    { state: "expired", resnapshot: true });
  assert.equal(requests.getFixtureSnapshot(owner, grant.connectionId, grant.expiresAt), null);
  assert.equal(requests.revokeChangedTab(3, null), 1);
  assert.equal(requests.getFixtureSnapshot(owner, grant.connectionId, 2003), null);
  assert.equal(requests.readFixtureEvents(owner, grant.connectionId, initial.cursor, 1, 2003), null);
  assert.equal(requests.publishFixtureSnapshot(target, messages, 2003), 0);
});

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
  assert.deepEqual(events.events[0]?.payload, { kind: "gemini_snapshot", messages: later.map((message) => ({
    ...message, identityQuality: "uncertain", generationState: "unknown"
  })) });
  assert.deepEqual(requests.readGeminiEvents(owner, granted!.connectionId, { epoch: "other", sequence: 1 }, 1, 2003),
    { state: "expired", resnapshot: true });
  assert.throws(() => requests.publishGeminiSnapshot(target, [{ direction: "incoming", text: "x".repeat(2049) }], 2002),
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