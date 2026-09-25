import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PENDING_REQUESTS, PendingConnectionRequests, PENDING_REQUEST_TTL_MS } from "./pending-connections.js";

test("pending requests remain private to their broker-owned client", () => {
  const requests = new PendingConnectionRequests();
  const firstClient = Symbol("first client");
  const secondClient = Symbol("second client");
  const created = requests.create(firstClient, 1000);

  assert.match(created.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created, { requestId: created.requestId, state: "pending", expiresAt: 1000 + PENDING_REQUEST_TTL_MS });
  assert.equal(requests.get(secondClient, created.requestId, 1000), null);
  assert.deepEqual(requests.get(firstClient, created.requestId, 1000), created);
  assert.deepEqual(requests.get(firstClient, created.requestId, created.expiresAt), { ...created, state: "expired" });

  requests.disconnect(secondClient);
  assert.deepEqual(requests.get(firstClient, created.requestId, 1000), created);
  requests.disconnect(firstClient);
  assert.equal(requests.get(firstClient, created.requestId, 1000), null);
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