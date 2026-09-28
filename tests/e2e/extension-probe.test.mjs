import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { planNativeRegistration, registerNative } from "../../packages/companion/dist/native-registration.js";

const extensionDirectory = fileURLToPath(new URL("../../packages/extension/.output/chrome-mv3/", import.meta.url));
const nativeRelayPath = fileURLToPath(new URL("../../packages/companion/dist/native-relay.js", import.meta.url));

test("isolated Chromium loads the extension, popup, and native host", { timeout: 15000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-extension-test-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: "/usr/bin/chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`
      ]
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 5000 });
    const extensionId = new URL(worker.url()).hostname;
    assert.match(extensionId, /^[a-p]{32}$/);
    await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
    assert.equal(await worker.evaluate(() => typeof chrome.storage.session.get), "function");

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    assert.equal(await popup.locator("h1").textContent(), "Browser chat");
    assert.equal(await popup.getByRole("button", { name: "Inspect this chat" }).count(), 1);
    assert.equal(await popup.getByRole("button", { name: "View pending requests" }).isHidden(), true);

    const handshake = await worker.evaluate(async () => {
      const requestId = crypto.randomUUID();
      const port = chrome.runtime.connectNative("com.agent_messaging_mcp.bridge");
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { port.disconnect(); reject(new Error("Native handshake timed out")); }, 5000);
        port.onMessage.addListener((reply) => { clearTimeout(timer); port.disconnect(); resolve(reply); });
        port.onDisconnect.addListener(() => {
          clearTimeout(timer);
          reject(new Error(chrome.runtime.lastError?.message ?? "Native host disconnected"));
        });
        port.postMessage({
          kind: "handshake", protocolVersion: 1, requestId, connectionGeneration: 0,
          deadlineMs: Date.now() + 5000, payload: {}
        });
      });
      return { requestId, reply };
    });
    assert.equal(handshake.reply.kind, "handshake_result");
    assert.equal(handshake.reply.requestId, handshake.requestId);
    assert.deepEqual(handshake.reply.payload, { protocolVersion: 1 });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});