import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { connectBroker } from "./broker-client.js";
import { recoverStaleBrokerRuntime } from "./broker-recovery.js";

test("spawned broker keeps role credentials private and exits cleanly", { timeout: 5000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-broker-home-"));
  const entry = fileURLToPath(new URL("./broker-process.js", import.meta.url));
  const broker = spawn(process.execPath, [entry], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  const directory = join(home, ".config/agent-messaging-mcp/broker");
  const exit = once(broker, "exit");

  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const info = await stat(join(directory, "broker.sock"));
        ready = info.isSocket();
        if (ready) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await setTimeout(25);
    }
    assert.equal(ready, true, "Broker did not start");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "facade.key"))).mode & 0o777, 0o600);
    const facadeKey = await readFile(join(directory, "facade.key"), "utf8");
    assert.match(facadeKey, /^[0-9a-f]{64}$/);
    const facade = await connectBroker("facade", directory);
    const created = await facade.requestConnection();
    assert.equal(created.kind, "connection_requested");
    if (created.kind !== "connection_requested") throw new Error("Expected a pending request");
    const state = await facade.getConnection(created.payload.requestId);
    assert.equal(state.kind, "connection_state");
    assert.deepEqual(state.payload, created.payload);
    const otherFacade = await connectBroker("facade", directory);
    const otherState = await otherFacade.getConnection(created.payload.requestId);
    assert.deepEqual(otherState.payload, { state: "unknown" });
    const relay = await connectBroker("relay", directory);
    assert.throws(() => relay.requestConnection(), /Broker role cannot perform/);
    assert.throws(() => facade.listPending(), /Broker role cannot perform/);
    const listed = await relay.listPending();
    assert.equal(listed.kind, "pending_list");
    if (listed.kind !== "pending_list") throw new Error("Expected a pending list");
    assert.deepEqual(listed.payload.requests, [{ requestId: created.payload.requestId, expiresAt: created.payload.expiresAt }]);
    const approved = await relay.approveFixture(created.payload.requestId, {
      origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "a66b3997-9d43-4554-8399-267d1fe9f75c"
    });
    assert.equal(approved.kind, "fixture_approved");
    assert.throws(() => facade.approveFixture(created.payload.requestId, {
      origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "a66b3997-9d43-4554-8399-267d1fe9f75c"
    }), /Broker role cannot perform/);
    const readyState = await facade.getConnection(created.payload.requestId);
    assert.equal(readyState.kind, "connection_state");
    assert.equal(readyState.payload.state, "ready_readonly");
    assert.throws(() => facade.revokeFixture(3, null), /Broker role cannot perform/);
    const revoked = await relay.revokeFixture(3, { documentId: "next-document", conversationId: "fixture-alpha" });
    assert.equal(revoked.kind, "fixture_revoked");
    assert.deepEqual(revoked.payload, { count: 1 });
    assert.deepEqual((await facade.getConnection(created.payload.requestId)).payload,
      { requestId: created.payload.requestId, state: "stale" });
    assert.deepEqual((await otherFacade.getConnection(created.payload.requestId)).payload, { state: "unknown" });

    const another = await facade.requestConnection();
    if (another.kind !== "connection_requested") throw new Error("Expected another pending request");
    await relay.approveFixture(another.payload.requestId, {
      origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 4,
      documentId: "CHROME-doc_opaque-42"
    });
    const anotherState = await facade.getConnection(another.payload.requestId);
    if (anotherState.kind !== "connection_state") throw new Error("Expected another owned connection");
    assert.equal(anotherState.payload.state, "ready_readonly");
    if (anotherState.payload.state !== "ready_readonly") throw new Error("Expected an approved fixture handle");
    const connectionId = anotherState.payload.connectionId;
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 4, documentId: "CHROME-doc_opaque-42" };
    const messages = [{ id: "fixture-1", direction: "incoming" as const, text: "Fixture row" }];
    assert.throws(() => facade.publishFixtureSnapshot(target, messages), /Broker role cannot perform/);
    assert.throws(() => relay.readFixtureSnapshot(connectionId), /Broker role cannot perform/);
    assert.deepEqual((await facade.readFixtureSnapshot(connectionId)).payload,
      { code: "OBSERVATION_UNAVAILABLE" });
    assert.deepEqual((await otherFacade.readFixtureSnapshot(connectionId)).payload,
      { code: "CONNECTION_NOT_FOUND" });
    const published = await relay.publishFixtureSnapshot(target, messages);
    assert.equal(published.kind, "fixture_snapshot_published");
    assert.deepEqual(published.payload, { count: 1 });
    const snapshot = await facade.readFixtureSnapshot(connectionId);
    if (snapshot.kind !== "fixture_snapshot") throw new Error("Expected a fixture snapshot");
    assert.deepEqual(snapshot.payload.messages, messages);
    assert.equal(snapshot.payload.coverage, "rendered_only");
    assert.equal(snapshot.payload.cursor.sequence, 1);
    assert.throws(() => facade.revokeAllFixtures(), /Broker role cannot perform/);
    const reset = await relay.revokeAllFixtures();
    assert.equal(reset.kind, "fixture_revoked");
    assert.deepEqual(reset.payload, { count: 1 });
    assert.deepEqual((await facade.getConnection(another.payload.requestId)).payload,
      { requestId: another.payload.requestId, state: "stale" });
    assert.deepEqual((await facade.readFixtureSnapshot(connectionId)).payload,
      { code: "CONNECTION_NOT_FOUND" });
    otherFacade.close();
    facade.close();
    assert.deepEqual((await relay.listPending() as typeof listed).payload.requests, []);
    relay.close();

    const duplicate = spawn(process.execPath, [entry], { env: { ...process.env, HOME: home }, stdio: "ignore" });
    const [duplicateExit] = await once(duplicate, "exit");
    assert.equal(duplicateExit, 1);
    assert.equal(await readFile(join(directory, "facade.key"), "utf8"), facadeKey);
    assert.equal((await stat(join(directory, "broker.sock"))).isSocket(), true);

    broker.kill("SIGTERM");
    const [code] = await exit;
    assert.equal(code, 0);
    await assert.rejects(stat(directory), { code: "ENOENT" });
  } finally {
    broker.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  }
});

test("broker replaces its own stale runtime after an abrupt exit", { timeout: 6000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-broker-restart-"));
  const entry = fileURLToPath(new URL("./broker-process.js", import.meta.url));
  const directory = join(home, ".config/agent-messaging-mcp/broker");
  const first = spawn(process.execPath, [entry], { env: { ...process.env, HOME: home }, stdio: "ignore" });
  const firstExit = once(first, "exit");
  let second: ReturnType<typeof spawn> | undefined;

  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        ready = (await stat(join(directory, "broker.sock"))).isSocket();
        if (ready) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await setTimeout(25);
    }
    assert.equal(ready, true, "First broker did not start");
    const oldKey = await readFile(join(directory, "facade.key"), "utf8");
    first.kill("SIGKILL");
    const [, signal] = await firstExit;
    assert.equal(signal, "SIGKILL");
    assert.equal((await stat(directory)).isDirectory(), true);

    second = spawn(process.execPath, [entry], { env: { ...process.env, HOME: home }, stdio: "ignore" });
    let refreshed = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const rotated = (await readFile(join(directory, "facade.key"), "utf8")) !== oldKey;
        const socket = await stat(join(directory, "broker.sock"));
        refreshed = rotated && socket.isSocket() && (socket.mode & 0o077) === 0;
        if (refreshed) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await setTimeout(25);
    }
    assert.equal(refreshed, true, "Broker did not rotate its stale credential");
    const client = await connectBroker("facade", directory);
    client.close();
  } finally {
    first.kill("SIGKILL");
    second?.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  }
});

test("stale broker recovery refuses an unrecognized private directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-broker-foreign-"));
  const directory = join(home, "broker");
  try {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "user-file"), "do not remove", { mode: 0o600 });
    await assert.rejects(recoverStaleBrokerRuntime(home), /unexpected broker runtime files/);
    assert.equal(await readFile(join(directory, "user-file"), "utf8"), "do not remove");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});