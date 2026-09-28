import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PENDING_REQUESTS, PendingConnectionRequests, PENDING_REQUEST_TTL_MS, READONLY_CONNECTION_TTL_MS }
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
  const granted = requests.approve(pending.requestId, target, 2000);
  assert.equal(granted?.state, "ready_readonly");
  assert.match(granted?.connectionId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(granted?.expiresAt, 2000 + READONLY_CONNECTION_TTL_MS);
  assert.equal("tabId" in granted!, false);
  assert.equal("documentId" in granted!, false);
  assert.deepEqual(requests.get(owner, pending.requestId, 2000), granted);
  assert.equal(requests.get(stranger, pending.requestId, 2000), null);
  assert.deepEqual(requests.listPending(2000), []);
  assert.equal(requests.approve(pending.requestId, target, 2001), null);
  assert.equal(requests.get(owner, pending.requestId, granted!.expiresAt)?.state, "expired");
  requests.disconnect(owner);
  assert.equal(requests.get(owner, pending.requestId, 2000), null);

  const upper = requests.create(owner, 1000);
  assert.equal(requests.approve(upper.requestId, { ...target, documentId: "CHROME-doc_opaque-42" }, 2000)?.state,
    "ready_readonly");
  const expired = requests.create(owner, 1000);
  assert.equal(requests.approve(expired.requestId, target, expired.expiresAt), null);
});