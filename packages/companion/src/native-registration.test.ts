import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { PROTOCOL_VERSION } from "./native-protocol.js";
import { nativeManifestPath, planNativeRegistration, registerNative, restoreNative, unregisterNative } from "./native-registration.js";

test("previews, registers, and removes only this extension's native host", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-registration-"));
  const extensionId = "a".repeat(32);
  const profile = join(home, "chromium-dev");
  const plan = planNativeRegistration(home, extensionId, process.execPath, "/path/to/native-relay.js", profile);

  try {
    assert.equal(plan.launcherPath, join(home, ".config/agent-messaging-mcp/native-host"));
    assert.equal(plan.manifestPath, join(profile, "NativeMessagingHosts/com.agent_messaging_mcp.bridge.json"));
    assert.equal(nativeManifestPath(home), join(home, ".config/chromium/NativeMessagingHosts/com.agent_messaging_mcp.bridge.json"));
    await registerNative(plan, true);
    await assert.rejects(readFile(plan.manifestPath), { code: "ENOENT" });

    await registerNative(plan);
    await registerNative(plan);
    assert.equal((await stat(plan.launcherPath)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(plan.manifestPath, "utf8")).allowed_origins, [plan.origin]);
    assert.match(await readFile(plan.launcherPath, "utf8"), /exec .*native-relay\.js/);

    await unregisterNative(home, process.execPath, "/path/to/native-relay.js", profile, true);
    assert.equal(await readFile(plan.manifestPath, "utf8"), plan.manifest);
    await unregisterNative(home, process.execPath, "/path/to/native-relay.js", profile);
    await assert.rejects(readFile(plan.manifestPath), { code: "ENOENT" });

    await mkdir(dirname(plan.manifestPath), { recursive: true });
    await writeFile(plan.manifestPath, "unrelated registration");
    await assert.rejects(registerNative(plan), /Refusing to replace/);
    await assert.rejects(unregisterNative(home, process.execPath, "/path/to/native-relay.js", profile),
      /Refusing to remove/);
    assert.equal(await readFile(plan.manifestPath, "utf8"), "unrelated registration");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("generated launcher starts the relay without an inherited Node PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-launcher-"));
  const relayPath = fileURLToPath(new URL("./native-relay.js", import.meta.url));
  const plan = planNativeRegistration(home, "a".repeat(32), process.execPath, relayPath);

  try {
    await registerNative(plan);
    const host = spawn(plan.launcherPath, [plan.origin], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: "/nonexistent" }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const request = {
      kind: "handshake",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "a66b3997-9d43-4554-8399-267d1fe9f75c",
      connectionGeneration: 0,
      deadlineMs: Date.now() + 10_000,
      payload: {}
    };
    host.stdin.end(encodeNativeFrame(request));
    const [exitCode] = await once(host, "exit");

    assert.equal(exitCode, 0, Buffer.concat(stderr).toString());
    assert.deepEqual(new NativeFrameDecoder().push(Buffer.concat(stdout)), [{
      ...request,
      kind: "handshake_result",
      payload: { protocolVersion: PROTOCOL_VERSION }
    }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("restores only an existing exact-origin registration after launcher loss", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-restore-"));
  const profile = join(home, "chromium-dev");
  const relayPath = "/path/to/native-relay.js";
  const plan = planNativeRegistration(home, "a".repeat(32), process.execPath, relayPath, profile);

  try {
    assert.equal(await restoreNative(home, process.execPath, relayPath, profile), null);
    await assert.rejects(readFile(plan.manifestPath), { code: "ENOENT" });

    await registerNative(plan);
    await unlink(plan.launcherPath);
    assert.equal((await restoreNative(home, process.execPath, relayPath, profile, true))?.origin, plan.origin);
    await assert.rejects(readFile(plan.launcherPath), { code: "ENOENT" });

    assert.equal((await restoreNative(home, process.execPath, relayPath, profile))?.origin, plan.origin);
    assert.equal((await stat(plan.launcherPath)).mode & 0o777, 0o700);
    await restoreNative(home, process.execPath, relayPath, profile);
    assert.equal(await readFile(plan.manifestPath, "utf8"), plan.manifest);

    await writeFile(plan.manifestPath, "unrelated registration");
    await assert.rejects(restoreNative(home, process.execPath, relayPath, profile), /Refusing to remove/);
    assert.equal(await readFile(plan.manifestPath, "utf8"), "unrelated registration");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});