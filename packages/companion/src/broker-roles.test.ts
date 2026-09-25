import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticateBrokerRole, createBrokerCredentials } from "./broker-roles.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";

test("facade and relay roles require distinct validated credentials", () => {
  const credentials = createBrokerCredentials();
  assert.match(credentials.facade, /^[0-9a-f]{64}$/);
  assert.match(credentials.relay, /^[0-9a-f]{64}$/);
  assert.notEqual(credentials.facade, credentials.relay);

  const facadeHello = {
    kind: "hello", protocolVersion: PROTOCOL_VERSION,
    requestId: "a66b3997-9d43-4554-8399-267d1fe9f75c", connectionGeneration: 0,
    deadlineMs: 20_000, role: "facade", credential: credentials.facade, payload: {}
  };
  assert.deepEqual(authenticateBrokerRole(facadeHello, credentials, 1000), {
    role: "facade", requestId: facadeHello.requestId
  });
  assert.equal(authenticateBrokerRole({ ...facadeHello, role: "relay" }, credentials, 1000), null);
  assert.equal(authenticateBrokerRole({ ...facadeHello, credential: credentials.relay }, credentials, 1000), null);
  assert.equal(authenticateBrokerRole({ ...facadeHello, credential: "a".repeat(64) }, credentials, 1000), null);
  assert.equal(authenticateBrokerRole({ ...facadeHello, protocolVersion: PROTOCOL_VERSION + 1 }, credentials, 1000), null);
  assert.equal(authenticateBrokerRole({ ...facadeHello, deadlineMs: 1000 }, credentials, 1000), null);
  assert.equal(authenticateBrokerRole({ ...facadeHello, deadlineMs: 31_001 }, credentials, 1000), null);
  assert.equal(authenticateBrokerRole({ ...facadeHello, arbitraryCommand: "evaluate" }, credentials, 1000), null);

  const relayHello = { ...facadeHello, role: "relay", credential: credentials.relay };
  assert.deepEqual(authenticateBrokerRole(relayHello, credentials, 1000), {
    role: "relay", requestId: relayHello.requestId
  });
});