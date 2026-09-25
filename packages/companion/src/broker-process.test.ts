import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { connectBroker } from "./broker-client.js";

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
    otherFacade.close();
    facade.close();
    const relay = await connectBroker("relay", directory);
    assert.throws(() => relay.requestConnection(), /Only the facade/);
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