import assert from "node:assert/strict";
import { test } from "node:test";
import { handleBrokerRequest } from "./broker-requests.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { PendingConnectionRequests, PENDING_REQUEST_TTL_MS } from "./pending-connections.js";

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

  assert.deepEqual(handleBrokerRequest(get, "facade", secondClient, requests, 1000), {
    ...envelope, kind: "connection_state", payload: { state: "unknown" }
  });
  assert.equal(handleBrokerRequest(get, "facade", firstClient, requests, 1000).payload.state, "pending");
  const expiredAt = 1000 + PENDING_REQUEST_TTL_MS;
  assert.equal(handleBrokerRequest({ ...get, deadlineMs: expiredAt + 10_000 }, "facade", firstClient, requests,
    expiredAt).payload.state, "expired");
  assert.throws(() => handleBrokerRequest({ ...create, kind: "evaluate" }, "facade", firstClient, requests, 1000));
  assert.throws(() => handleBrokerRequest({ ...create, deadlineMs: 1000 }, "facade", firstClient, requests, 1000));
});