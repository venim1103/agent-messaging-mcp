import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { encodeNativeFrame, NativeFrameDecoder } from "./native-framing.js";
import { handleNativeHandshake, isNativeCaller, PROTOCOL_VERSION } from "./native-protocol.js";

const origin = `chrome-extension://${"a".repeat(32)}/`;
const now = 1_750_000_000_000;
const request = {
  kind: "handshake",
  protocolVersion: PROTOCOL_VERSION,
  requestId: "7f9ca8a2-4e96-48d8-8997-51abcc7e8085",
  connectionGeneration: 0,
  deadlineMs: now + 10_000,
  payload: {}
};

test("accepts only a bounded, exact handshake and the registered caller", () => {
  assert.equal(isNativeCaller(origin, origin), true);
  assert.equal(isNativeCaller(origin, origin.slice(0, -1)), true);
  assert.equal(isNativeCaller(origin, `chrome-extension://${"b".repeat(32)}/`), false);
  assert.equal(isNativeCaller("chrome-extension://*/", origin), false);

  assert.deepEqual(handleNativeHandshake(request, now), {
    ...request,
    kind: "handshake_result",
    payload: { protocolVersion: PROTOCOL_VERSION }
  });
  for (const invalid of [
    { ...request, kind: "execute" },
    { ...request, protocolVersion: 2 },
    { ...request, connectionGeneration: 1 },
    { ...request, deadlineMs: now - 1 },
    { ...request, deadlineMs: now + 30_001 },
    { ...request, payload: { command: "anything" } }
  ]) {
    assert.throws(() => handleNativeHandshake(invalid, now), /Invalid native handshake/);
  }
});

test("spawned native relay replies with a framed version and no other stdout", async () => {
  const host = spawn(process.execPath, [new URL("./native-relay.js", import.meta.url).pathname, origin, origin], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  host.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  host.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const handshake = { ...request, deadlineMs: Date.now() + 10_000 };
  const frame = encodeNativeFrame(handshake);
  host.stdin.write(frame.subarray(0, 3));
  host.stdin.end(frame.subarray(3));
  const [exitCode] = await once(host, "exit");

  assert.equal(exitCode, 0);
  assert.equal(Buffer.concat(stderr).toString(), "");
  const replies = new NativeFrameDecoder().push(Buffer.concat(stdout));
  assert.deepEqual(replies, [handleNativeHandshake(handshake, Date.now())]);
});