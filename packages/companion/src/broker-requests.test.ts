import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleBrokerRequest } from "./broker-requests.js";
import { PreparedMessageOperations } from "./message-operations.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { GEMINI_READ_TIMEOUT_MS, MAX_PENDING_REQUESTS, PendingConnectionRequests, PENDING_REQUEST_TTL_MS }
  from "./pending-connections.js";

test("only a relay marks a gap for the exact approved Gemini URL and document", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("Gemini owner");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com" as const, conversationId: "disposable-chat",
    url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: 4,
    documentId: "CHROME-doc_gemini-42" };
  const grant = requests.approveGemini(pending.requestId, target, 2000)!;
  requests.publishGeminiSnapshot(target, [{ direction: "incoming", text: "Synthetic" }], 2001);
  const before = requests.getGeminiSnapshot(owner, grant.connectionId, 2001);
  if (!before || before === "not_ready") throw new Error("Expected an old Gemini cursor");
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const gap = { ...envelope, kind: "mark_gemini_observation_gap", payload: { target } };
  assert.deepEqual(handleBrokerRequest(gap, "facade", owner, requests, 2002).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest({ ...gap, payload: { target: { ...target, url: `${target.url}&other=1` } } },
    "relay", Symbol("relay"), requests, 2002).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest(gap, "relay", Symbol("relay"), requests, 2002), {
    ...envelope, kind: "gemini_gap_marked", payload: { count: 1 }
  });
  assert.deepEqual(requests.readGeminiEvents(owner, grant.connectionId, before.cursor, 1, 2002),
    { state: "expired", resnapshot: true });
  assert.equal(requests.get(owner, pending.requestId, 2002)?.state, "ready_readonly");
  assert.throws(() => handleBrokerRequest({ ...gap, payload: { ...gap.payload, selector: "*" } },
    "relay", Symbol("relay"), requests, 2002));
});

test("only an owning facade prepares immutable fixture text without approval or dispatch", () => {
  const requests = new PendingConnectionRequests();
  const database = new DatabaseSync(":memory:");
  try {
    const operations = new PreparedMessageOperations(requests, database);
    const owner = Symbol("fixture owner");
    const stranger = Symbol("other facade");
    const pending = requests.create(owner, 1000);
    const envelope = { protocolVersion: PROTOCOL_VERSION,
      requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
    const prepare = { ...envelope, kind: "prepare_fixture_message", payload: {
      connectionId: "a66b3997-9d43-4554-8399-267d1fe9f75c", expectedGeneration: 1,
      text: "Synthetic fixture-only draft", idempotencyKey: "b66b3997-9d43-4554-8399-267d1fe9f75c"
    } };
    assert.deepEqual(handleBrokerRequest(prepare, "facade", owner, requests, 2000, operations).payload,
      { code: "CONNECTION_NOT_FOUND" });
    const grant = requests.approve(pending.requestId, { origin: "http://127.0.0.1:8787",
      conversationId: "fixture-alpha", tabId: 3, documentId: "CHROME-doc_opaque-42" }, 2000)!;
    const owned = { ...prepare, payload: { ...prepare.payload, connectionId: grant.connectionId } };
    assert.deepEqual(handleBrokerRequest(owned, "relay", stranger, requests, 2001, operations).payload,
      { code: "PERMISSION_DENIED" });
    assert.deepEqual(handleBrokerRequest(owned, "facade", stranger, requests, 2001, operations).payload,
      { code: "CONNECTION_NOT_FOUND" });
    const prepared = handleBrokerRequest(owned, "facade", owner, requests, 2001, operations);
    if (prepared.kind !== "message_prepared") throw new Error("Expected prepared fixture text");
    assert.equal(prepared.payload.state, "awaiting_approval");
    assert.equal(prepared.payload.preview.text, owned.payload.text);
    assert.deepEqual(handleBrokerRequest(owned, "facade", owner, requests, 2002, operations).payload,
      prepared.payload);
    assert.deepEqual(handleBrokerRequest({ ...owned, payload: { ...owned.payload, text: "Changed" } },
      "facade", owner, requests, 2002, operations).payload, { code: "IDEMPOTENCY_CONFLICT" });
    assert.throws(() => handleBrokerRequest({ ...owned, payload: { ...owned.payload, approved: true } },
      "facade", owner, requests, 2002, operations));
    requests.revokeChangedTab(3, null);
    assert.deepEqual(handleBrokerRequest(owned, "facade", owner, requests, 2003, operations).payload,
      { code: "CONNECTION_NOT_FOUND" });
    const geminiPending = requests.create(owner, 1000);
    const gemini = requests.approveGemini(geminiPending.requestId, { origin: "https://gemini.google.com",
      conversationId: "disposable-chat", url: "https://gemini.google.com/app/disposable-chat?hl=en",
      tabId: 4, documentId: "CHROME-doc_gemini-42" }, 2000)!;
    assert.deepEqual(handleBrokerRequest({ ...owned, payload: { ...owned.payload,
      connectionId: gemini.connectionId } }, "facade", owner, requests, 2003, operations).payload,
    { code: "CONNECTION_NOT_FOUND" });
  } finally {
    database.close();
  }
});

test("only an owning facade can create and query pending connections", () => {
  const requests = new PendingConnectionRequests();
  const firstClient = Symbol("first facade");
  const secondClient = Symbol("second facade");
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "a66b3997-9d43-4554-8399-267d1fe9f75c",
    connectionGeneration: 0,
    deadlineMs: 20_000
  };
  const create = { ...envelope, kind: "request_connection", payload: {} };

  assert.deepEqual(handleBrokerRequest(create, "relay", firstClient, requests, 1000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  const created = handleBrokerRequest(create, "facade", firstClient, requests, 1000);
  assert.equal(created.kind, "connection_requested");
  if (created.kind !== "connection_requested") throw new Error("Expected a pending request");
  const get = { ...envelope, kind: "get_connection", payload: { requestId: created.payload.requestId } };
  const list = { ...envelope, kind: "list_pending", payload: {} };
  const approval = { ...envelope, kind: "approve_fixture", payload: {
    pendingRequestId: created.payload.requestId,
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "a66b3997-9d43-4554-8399-267d1fe9f75c" }
  } };
  assert.deepEqual(handleBrokerRequest(approval, "facade", firstClient, requests, 1000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  assert.deepEqual(handleBrokerRequest(list, "facade", firstClient, requests, 1000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  assert.deepEqual(handleBrokerRequest(list, "relay", secondClient, requests, 1000), {
    ...envelope, kind: "pending_list", payload: { requests: [{
      requestId: created.payload.requestId, expiresAt: created.payload.expiresAt
    }] }
  });
  assert.deepEqual(handleBrokerRequest({ ...list, deadlineMs: 1000 + PENDING_REQUEST_TTL_MS + 5000 },
    "relay", secondClient, requests, 1000 + PENDING_REQUEST_TTL_MS).payload, { requests: [] });

  assert.deepEqual(handleBrokerRequest(get, "facade", secondClient, requests, 1000), {
    ...envelope, kind: "connection_state", payload: { state: "unknown" }
  });
  assert.equal(handleBrokerRequest(get, "facade", firstClient, requests, 1000).payload.state, "pending");
  const expiredAt = 1000 + PENDING_REQUEST_TTL_MS;
  assert.equal(handleBrokerRequest({ ...get, deadlineMs: expiredAt + 10_000 }, "facade", firstClient, requests,
    expiredAt).payload.state, "expired");
  assert.throws(() => handleBrokerRequest({ ...create, kind: "evaluate" }, "facade", firstClient, requests, 1000));
  assert.throws(() => handleBrokerRequest({ ...create, deadlineMs: 1000 }, "facade", firstClient, requests, 1000));

  for (let index = 1; index < MAX_PENDING_REQUESTS; index++) requests.create(firstClient, 1000);
  assert.deepEqual(handleBrokerRequest(create, "facade", firstClient, requests, 1000), {
    ...envelope, kind: "error", payload: { code: "TOO_MANY_PENDING" }
  });
});

test("authenticated relay alone approves a selected fixture and only its MCP owner sees the grant", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("MCP owner");
  const stranger = Symbol("other client");
  const pending = requests.create(owner, 1000);
  const envelope = {
    protocolVersion: PROTOCOL_VERSION, requestId: "c783ef76-d6cd-4898-8c43-204543943bac",
    connectionGeneration: 0, deadlineMs: 10_000
  };
  const approval = { ...envelope, kind: "approve_fixture", payload: {
    pendingRequestId: pending.requestId,
    target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_opaque-42" }
  } };

  assert.equal(handleBrokerRequest(approval, "relay", stranger, requests, 2000).kind, "fixture_approved");
  assert.deepEqual(handleBrokerRequest(approval, "relay", stranger, requests, 2000), {
    ...envelope, kind: "error", payload: { code: "APPROVAL_INVALID" }
  });
  const lookup = { ...envelope, kind: "get_connection", payload: { requestId: pending.requestId } };
  assert.deepEqual(handleBrokerRequest(lookup, "facade", stranger, requests, 2000).payload, { state: "unknown" });
  const own = handleBrokerRequest(lookup, "facade", owner, requests, 2000);
  assert.equal(own.payload.state, "ready_readonly");
  assert.equal("tabId" in own.payload, false);
  const revoke = { ...envelope, kind: "revoke_fixture", payload: {
    tabId: 3, observed: { documentId: "different-document", conversationId: "fixture-alpha" }
  } };
  assert.deepEqual(handleBrokerRequest(revoke, "facade", owner, requests, 2000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  assert.deepEqual(handleBrokerRequest(revoke, "relay", stranger, requests, 2000), {
    ...envelope, kind: "fixture_revoked", payload: { count: 1 }
  });
  assert.deepEqual(handleBrokerRequest(lookup, "facade", owner, requests, 2000).payload,
    { requestId: pending.requestId, state: "stale" });
  assert.deepEqual(handleBrokerRequest(revoke, "relay", stranger, requests, 2000).payload, { count: 0 });
  const reset = { ...envelope, kind: "revoke_all_fixture", payload: {} };
  assert.deepEqual(handleBrokerRequest(reset, "facade", owner, requests, 2000), {
    ...envelope, kind: "error", payload: { code: "PERMISSION_DENIED" }
  });
  const another = requests.create(owner, 1000);
  requests.approve(another.requestId, { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
    tabId: 4, documentId: "CHROME-doc_opaque-42" }, 2000);
  assert.deepEqual(handleBrokerRequest(reset, "relay", stranger, requests, 2000), {
    ...envelope, kind: "fixture_revoked", payload: { count: 1 }
  });
  assert.throws(() => handleBrokerRequest({ ...reset, payload: { tabId: 4 } }, "relay", stranger, requests, 2000));
  assert.deepEqual(handleBrokerRequest({ ...approval, deadlineMs: 70_000 }, "relay", stranger, requests, 61_000), {
    ...envelope, deadlineMs: 70_000, kind: "error", payload: { code: "APPROVAL_INVALID" }
  });
});

test("a relay publishes bounded fixture rows but only the owning facade reads an approved snapshot", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("approved client");
  const stranger = Symbol("other client");
  const pending = requests.create(owner, 1000);
  const target = {
    origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42"
  };
  const envelope = {
    protocolVersion: PROTOCOL_VERSION, requestId: "c783ef76-d6cd-4898-8c43-204543943bac",
    connectionGeneration: 0, deadlineMs: 10_000
  };
  const messages = [
    { id: "fixture-1", direction: "incoming", text: "First" },
    { id: "fixture-2", direction: "outgoing", text: "Second" }
  ];
  const publish = { ...envelope, kind: "publish_fixture_snapshot", payload: { target, messages } };
  assert.deepEqual(handleBrokerRequest(publish, "facade", owner, requests, 2000).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(publish, "relay", stranger, requests, 2000).payload, { count: 0 });
  const grant = requests.approve(pending.requestId, target, 2000)!;
  const read = { ...envelope, kind: "read_fixture_snapshot", payload: { connectionId: grant.connectionId } };
  const genericRead = { ...envelope, kind: "read_approved_snapshot", payload: { connectionId: grant.connectionId } };
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", owner, requests, 2000), {
    ...envelope, kind: "fixture_read_authorized", payload: { connectionId: grant.connectionId, limit: 32 }
  });
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", stranger, requests, 2000).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(read, "facade", owner, requests, 2000), {
    ...envelope, kind: "fixture_read_authorized", payload: { connectionId: grant.connectionId, limit: 32 }
  });
  assert.deepEqual(handleBrokerRequest(read, "relay", stranger, requests, 2000).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(read, "facade", stranger, requests, 2000).payload,
    { code: "CONNECTION_NOT_FOUND" });
  const challenges = { ...envelope, kind: "list_fixture_read_challenges", payload: {} };
  assert.deepEqual(handleBrokerRequest(challenges, "facade", owner, requests, 2000).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2000).payload,
    { challenges: [], activeTabIds: [3] });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: { ...publish.payload, target: { ...target, tabId: 4 } } },
    "relay", stranger, requests, 2001).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest(publish, "relay", stranger, requests, 2001).payload, { count: 1 });
  assert.deepEqual(handleBrokerRequest({ ...read, payload: { ...read.payload, limit: 1 } },
    "facade", owner, requests, 2001), {
    ...envelope, kind: "fixture_read_authorized", payload: { connectionId: grant.connectionId, limit: 1 }
  });
  const initial = requests.getFixtureSnapshot(owner, grant.connectionId, 2001);
  if (!initial || initial === "not_ready") throw new Error("Expected an event cursor");
  const eventRead = { ...envelope, kind: "read_fixture_events", payload: {
    connectionId: grant.connectionId, cursor: initial.cursor, limit: 2
  } };
  assert.deepEqual(handleBrokerRequest(eventRead, "relay", stranger, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(eventRead, "facade", stranger, requests, 2001).payload,
    { code: "CONNECTION_NOT_FOUND" });
  const emptyPage = handleBrokerRequest(eventRead, "facade", owner, requests, 2001);
  if (emptyPage.kind !== "fixture_events" || emptyPage.payload.state !== "ok") {
    throw new Error("Expected an empty event page");
  }
  assert.deepEqual(emptyPage.payload.events, []);
  const later = [{ id: "fixture-3", direction: "incoming", text: "Later" }];
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: { target, messages: later } },
    "relay", stranger, requests, 2002).payload, { count: 1 });
  const observed = handleBrokerRequest(eventRead, "facade", owner, requests, 2002);
  assert.equal(observed.kind, "fixture_events");
  if (observed.kind !== "fixture_events" || observed.payload.state !== "ok") throw new Error("Expected a later event");
  assert.deepEqual(observed.payload.events[0]?.payload, { kind: "fixture_snapshot", messages: later });
  assert.equal(observed.payload.cursor.sequence, 2);
  assert.deepEqual(handleBrokerRequest({ ...eventRead, payload: { ...eventRead.payload,
    cursor: { epoch: "a66b3997-9d43-4554-8399-267d1fe9f75c", sequence: 1 } } },
  "facade", owner, requests, 2002).payload, { state: "expired", resnapshot: true });
  assert.throws(() => handleBrokerRequest({ ...publish, payload: { ...publish.payload, selector: "*" } },
    "relay", stranger, requests, 2001));
  assert.throws(() => handleBrokerRequest({ ...eventRead, payload: { ...eventRead.payload, limit: 3 } },
    "facade", owner, requests, 2002));
  assert.throws(() => handleBrokerRequest({ ...challenges, payload: { selector: "*" } },
    "relay", stranger, requests, 2001));
  assert.throws(() => handleBrokerRequest({ ...read, payload: { ...read.payload, limit: 33 } },
    "facade", owner, requests, 2001));
  requests.revokeAllFixtures();
  assert.deepEqual(handleBrokerRequest(read, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(eventRead, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
});

test("only the owning facade disconnects an approved fixture without exposing its tab", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("owner");
  const stranger = Symbol("stranger");
  const pending = requests.create(owner, 1000);
  const grant = requests.approve(pending.requestId, {
    origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
    tabId: 3, documentId: "CHROME-doc_opaque-42"
  }, 2000)!;
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const disconnect = { ...envelope, kind: "disconnect_fixture", payload: { connectionId: grant.connectionId } };
  assert.deepEqual(handleBrokerRequest(disconnect, "relay", stranger, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(disconnect, "facade", stranger, requests, 2001).payload,
    { disconnected: false });
  assert.deepEqual(handleBrokerRequest(disconnect, "facade", owner, requests, 2001), {
    ...envelope, kind: "fixture_disconnected", payload: { disconnected: true }
  });
  assert.deepEqual(handleBrokerRequest(disconnect, "facade", owner, requests, 2001).payload,
    { disconnected: false });
  assert.deepEqual(handleBrokerRequest({ ...envelope, kind: "get_connection",
    payload: { requestId: pending.requestId } }, "facade", owner, requests, 2001).payload,
    { requestId: pending.requestId, state: "stale" });
  assert.deepEqual(handleBrokerRequest({ ...envelope, kind: "list_fixture_read_challenges", payload: {} },
    "relay", stranger, requests, 2001).payload, { challenges: [], activeTabIds: [] });
  assert.throws(() => handleBrokerRequest({ ...disconnect, payload: { ...disconnect.payload, tabId: 3 } },
    "facade", owner, requests, 2001));
});

test("generic event reads follow the owned Gemini grant and not a caller-selected provider", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("Gemini reader");
  const other = Symbol("second facade");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com" as const,
    conversationId: "disposable-chat", url: "https://gemini.google.com/app/disposable-chat?hl=en",
    tabId: 4, documentId: "CHROME-doc_gemini-42" };
  const grant = requests.approveGemini(pending.requestId, target, 2000)!;
  const firstRows = [{ direction: "outgoing" as const, text: "Synthetic question" }];
  requests.publishGeminiSnapshot(target, firstRows, 2001);
  const first = requests.getGeminiSnapshot(owner, grant.connectionId, 2001);
  if (!first || first === "not_ready") throw new Error("Expected a Gemini cursor");
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const read = { ...envelope, kind: "read_approved_events", payload: {
    connectionId: grant.connectionId, cursor: first.cursor, limit: 1
  } };
  assert.deepEqual(handleBrokerRequest(read, "relay", other, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(read, "facade", other, requests, 2001).payload,
    { code: "CONNECTION_NOT_FOUND" });
  const empty = handleBrokerRequest(read, "facade", owner, requests, 2001);
  if (empty.kind !== "gemini_events" || empty.payload.state !== "ok") throw new Error("Expected empty Gemini events");
  assert.deepEqual(empty.payload.events, []);
  const laterRows = [...firstRows, { direction: "incoming" as const, text: "Synthetic reply" }];
  requests.publishGeminiSnapshot({ ...target, url: `${target.url}&changed=1` }, laterRows, 2002);
  const unchanged = handleBrokerRequest(read, "facade", owner, requests, 2002);
  if (unchanged.kind !== "gemini_events" || unchanged.payload.state !== "ok") {
    throw new Error("Expected unchanged Gemini events");
  }
  assert.deepEqual(unchanged.payload.events, []);
  requests.publishGeminiSnapshot(target, laterRows, 2002);
  const later = handleBrokerRequest(read, "facade", owner, requests, 2002);
  if (later.kind !== "gemini_events" || later.payload.state !== "ok") throw new Error("Expected Gemini update");
  assert.deepEqual(later.payload.events[0]?.payload, { kind: "gemini_snapshot", messages: laterRows.map((row) => ({
    ...row, identityQuality: "uncertain", generationState: "unknown"
  })) });
  assert.deepEqual(handleBrokerRequest({ ...read, payload: { ...read.payload,
    cursor: { epoch: "a66b3997-9d43-4554-8399-267d1fe9f75c", sequence: 1 } } },
  "facade", owner, requests, 2002).payload, { state: "expired", resnapshot: true });
  assert.throws(() => handleBrokerRequest({ ...read, payload: { ...read.payload, provider: "fixture" } },
    "facade", owner, requests, 2002));
  requests.disconnectFixture(owner, grant.connectionId, 2003);
  assert.deepEqual(handleBrokerRequest(read, "facade", owner, requests, 2003).payload,
    { code: "CONNECTION_NOT_FOUND" });
});

test("only an authenticated relay can mark an exact fixture observation gap", () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("owner");
  const pending = requests.create(owner, 1000);
  const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
    tabId: 3, documentId: "CHROME-doc_opaque-42" };
  const grant = requests.approve(pending.requestId, target, 2000)!;
  const rows = [{ id: "fixture-1", direction: "incoming" as const, text: "Observed" }];
  requests.publishFixtureSnapshot(target, rows, 2001);
  const old = requests.getFixtureSnapshot(owner, grant.connectionId, 2001);
  if (!old || old === "not_ready") throw new Error("Expected old snapshot cursor");
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const gap = { ...envelope, kind: "mark_fixture_observation_gap", payload: { target } };
  assert.deepEqual(handleBrokerRequest(gap, "facade", owner, requests, 2002).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest({ ...gap, payload: { target: { ...target, tabId: 4 } } },
    "relay", Symbol("relay"), requests, 2002).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest(gap, "relay", Symbol("relay"), requests, 2002), {
    ...envelope, kind: "fixture_gap_marked", payload: { count: 1 }
  });
  assert.deepEqual(requests.readFixtureEvents(owner, grant.connectionId, old.cursor, 1, 2002),
    { state: "expired", resnapshot: true });
  assert.equal(requests.get(owner, pending.requestId, 2002)?.state, "ready_readonly");
  assert.throws(() => handleBrokerRequest({ ...gap, payload: { ...gap.payload, selector: "*" } },
    "relay", Symbol("relay"), requests, 2002));
});

test("only a relay approves one exact Gemini chat and its MCP owner sees no browser IDs", async () => {
  const requests = new PendingConnectionRequests();
  const owner = Symbol("selected chat owner");
  const stranger = Symbol("another MCP client");
  const pending = requests.create(owner, 1000);
  const target = { origin: "https://gemini.google.com", conversationId: "disposable-chat",
    url: "https://gemini.google.com/app/disposable-chat", tabId: 4, documentId: "CHROME-doc_gemini-42" };
  const envelope = { protocolVersion: PROTOCOL_VERSION,
    requestId: "c783ef76-d6cd-4898-8c43-204543943bac", connectionGeneration: 0, deadlineMs: 10_000 };
  const approval = { ...envelope, kind: "approve_gemini", payload: {
    pendingRequestId: pending.requestId, target
  } };
  assert.deepEqual(handleBrokerRequest(approval, "facade", owner, requests, 2000).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest({ ...approval, payload: {
    ...approval.payload, target: { ...target, url: `${target.url}/other` }
  } }, "relay", stranger, requests, 2000).payload, { code: "APPROVAL_INVALID" });
  assert.equal(handleBrokerRequest(approval, "relay", stranger, requests, 2000).kind, "gemini_approved");
  assert.deepEqual(handleBrokerRequest(approval, "relay", stranger, requests, 2000).payload,
    { code: "APPROVAL_INVALID" });
  const lookup = { ...envelope, kind: "get_connection", payload: { requestId: pending.requestId } };
  assert.deepEqual(handleBrokerRequest(lookup, "facade", stranger, requests, 2001).payload,
    { state: "unknown" });
  const state = handleBrokerRequest(lookup, "facade", owner, requests, 2001);
  assert.equal(state.kind, "connection_state");
  assert.equal(state.payload.state, "ready_readonly");
  assert.equal(state.payload.origin, target.origin);
  assert.equal("tabId" in state.payload, false);
  assert.equal("documentId" in state.payload, false);
  assert.equal("url" in state.payload, false);
  assert.deepEqual(handleBrokerRequest({ ...envelope, kind: "read_fixture_snapshot", payload: {
    connectionId: "a66b3997-9d43-4554-8399-267d1fe9f75c"
  } }, "facade", owner, requests, 2001).payload, { code: "CONNECTION_NOT_FOUND" });
  const rows = [{ direction: "outgoing", text: "OK" }, { direction: "outgoing", text: "OK" }];
  const publish = { ...envelope, kind: "publish_gemini_snapshot", payload: { target, messages: rows } };
  const challenges = { ...envelope, kind: "list_gemini_read_challenges", payload: {} };
  assert.deepEqual(handleBrokerRequest(challenges, "facade", owner, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2001).payload,
    { challenges: [], activeTabIds: [4] });
  assert.deepEqual(handleBrokerRequest(publish, "facade", owner, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: {
    target: { ...target, url: `${target.url}?hl=en` }, messages: rows
  } }, "relay", stranger, requests, 2001).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: {
    target: { ...target, documentId: "other" }, messages: rows
  } }, "relay", stranger, requests, 2001).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest(publish, "relay", stranger, requests, 2001), {
    ...envelope, kind: "gemini_snapshot_published", payload: { count: 1 }
  });
  const connection = requests.get(owner, pending.requestId, 2001);
  if (connection?.state !== "ready_readonly") throw new Error("Expected a Gemini connection");
  const geminiRead = { ...envelope, kind: "read_gemini_snapshot", payload: {
    connectionId: connection.connectionId, limit: 1
  } };
  const genericRead = { ...envelope, kind: "read_approved_snapshot", payload: {
    connectionId: connection.connectionId, limit: 1
  } };
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", owner, requests, 2001), {
    ...envelope, kind: "gemini_read_authorized", payload: { connectionId: connection.connectionId, limit: 1 }
  });
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", stranger, requests, 2001).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(geminiRead, "relay", stranger, requests, 2001).payload,
    { code: "PERMISSION_DENIED" });
  assert.deepEqual(handleBrokerRequest(geminiRead, "facade", stranger, requests, 2001).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(geminiRead, "facade", owner, requests, 2001), {
    ...envelope, kind: "gemini_read_authorized", payload: { connectionId: connection.connectionId, limit: 1 }
  });
  assert.deepEqual(handleBrokerRequest({ ...geminiRead, payload: { ...geminiRead.payload,
    connectionId: pending.requestId } }, "facade", owner, requests, 2001).payload,
  { code: "CONNECTION_NOT_FOUND" });
  assert.throws(() => handleBrokerRequest({ ...geminiRead, payload: { ...geminiRead.payload, limit: 33 } },
    "facade", owner, requests, 2001));
  assert.equal(requests.getGeminiSnapshot(stranger, connection.connectionId, 2001), null);
  const observed = requests.getGeminiSnapshot(owner, connection.connectionId, 2001);
  if (!observed || observed === "not_ready") throw new Error("Expected a private Gemini snapshot");
  assert.deepEqual(observed.messages.map(({ direction, text }) => ({ direction, text })), rows);
  const reading = requests.requestFreshGeminiRead(owner, connection.connectionId, 2002);
  if (!reading || reading === "busy") throw new Error("Expected a Gemini read challenge");
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2002).payload, {
    challenges: [{ challengeId: reading.challengeId, target, expiresAt: 2002 + GEMINI_READ_TIMEOUT_MS }],
    activeTabIds: [4]
  });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: { ...publish.payload,
    target: { ...target, url: `${target.url}?hl=en` }, challengeId: reading.challengeId } },
  "relay", stranger, requests, 2003).payload, { count: 0 });
  assert.deepEqual(handleBrokerRequest({ ...publish, payload: { ...publish.payload,
    challengeId: reading.challengeId } }, "relay", stranger, requests, 2003).payload, { count: 1 });
  const challenged = await reading.result;
  if (!challenged || challenged === "not_ready") throw new Error("Expected challenged Gemini snapshot");
  assert.deepEqual(challenged.messages.map(({ direction, text }) => ({ direction, text })), rows);
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2003).payload,
    { challenges: [], activeTabIds: [4] });
  assert.equal("messages" in handleBrokerRequest(lookup, "facade", owner, requests, 2001).payload, false);
  assert.throws(() => handleBrokerRequest({ ...challenges, payload: { tabId: 4 } },
    "relay", stranger, requests, 2003));
  assert.throws(() => handleBrokerRequest({ ...publish, payload: { ...publish.payload,
    challengeId: "not-a-uuid" } }, "relay", stranger, requests, 2003));
  assert.throws(() => handleBrokerRequest({ ...publish, payload: { ...publish.payload, selector: "*" } },
    "relay", stranger, requests, 2001));
  assert.equal(requests.revokeChangedTab(4, null), 1);
  assert.deepEqual(handleBrokerRequest(challenges, "relay", stranger, requests, 2003).payload,
    { challenges: [], activeTabIds: [] });
  assert.deepEqual(handleBrokerRequest(publish, "relay", stranger, requests, 2002).payload, { count: 0 });
  assert.equal(requests.getGeminiSnapshot(owner, connection.connectionId, 2002), null);
  assert.deepEqual(handleBrokerRequest(geminiRead, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.deepEqual(handleBrokerRequest(genericRead, "facade", owner, requests, 2002).payload,
    { code: "CONNECTION_NOT_FOUND" });
  assert.throws(() => handleBrokerRequest({ ...approval, payload: {
    ...approval.payload, target: { ...target, selector: "*" }
  } }, "relay", stranger, requests, 2000));
});