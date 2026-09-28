import assert from "node:assert/strict";
import { test } from "node:test";
import { handleBrokerRequest } from "./broker-requests.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { MAX_PENDING_REQUESTS, PendingConnectionRequests, PENDING_REQUEST_TTL_MS } from "./pending-connections.js";

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
      documentId: "a66b3997-9d43-4554-8399-267d1fe9f75c" }
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
  assert.deepEqual(handleBrokerRequest({ ...approval, deadlineMs: 70_000 }, "relay", stranger, requests, 61_000), {
    ...envelope, deadlineMs: 70_000, kind: "error", payload: { code: "APPROVAL_INVALID" }
  });
});