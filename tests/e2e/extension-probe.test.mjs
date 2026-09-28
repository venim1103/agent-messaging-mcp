import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { connectBroker } from "../../packages/companion/dist/broker-client.js";
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

test("worker wake preserves a grant; reload, restart, and tab close revoke grants", { timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-restart-test-"));
  const directory = join(profile, ".config/agent-messaging-mcp/broker");
  const brokerEntry = fileURLToPath(new URL("../../packages/companion/dist/broker-process.js", import.meta.url));
  const launch = () => chromium.launchPersistentContext(profile, {
    executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"]
  });
  let context;
  let broker;
  let brokerExit;
  let facade;
  let relay;
  try {
    context = await launch();
    const manager = await context.newPage();
    await manager.goto("chrome://extensions/");
    const modeError = await manager.evaluate(() => new Promise((resolve) =>
      chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () =>
        resolve(chrome.runtime.lastError?.message ?? null))));
    assert.equal(modeError, null);
    const { id: extensionId } = await (await context.browser().newBrowserCDPSession())
      .send("Extensions.loadUnpacked", { path: extensionDirectory });
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    assert.equal(new URL(worker.url()).hostname, extensionId);
    await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));

    broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
    brokerExit = once(broker, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        ready = (await stat(join(directory, "broker.sock"))).isSocket();
        if (ready) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await setTimeout(25);
    }
    assert.equal(ready, true, "Broker did not start");
    facade = await connectBroker("facade", directory);
    relay = await connectBroker("relay", directory);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const response = await popup.evaluate(() => chrome.runtime.sendMessage({ kind: "list_fixture_pending", tabId: 1 }));
    assert.equal(response?.ok, false, JSON.stringify(response));
    assert.notEqual(response.error, "Fixture grant reset unavailable; try again");
    assert.equal(await worker.evaluate(async () =>
      (await chrome.storage.session.get("fixture-reset-done"))["fixture-reset-done"]), true);
    await popup.close();

    async function grant(tabId) {
      const created = await facade.requestConnection();
      if (created.kind !== "connection_requested") throw new Error("Expected pending request");
      const approved = await relay.approveFixture(created.payload.requestId, {
        origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId,
        documentId: `CHROME-doc_${tabId}`
      });
      assert.equal(approved.kind, "fixture_approved");
      const state = await facade.getConnection(created.payload.requestId);
      assert.equal(state.payload.state, "ready_readonly");
      return created.payload.requestId;
    }

    async function waitForStale(requestId) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const state = await facade.getConnection(requestId);
        if (state.payload.state === "stale") return;
        await setTimeout(50);
      }
      assert.fail(`Fixture grant ${requestId} was not revoked by the restarted extension`);
    }

    const beforeReload = await grant(3);
    const serviceWorkers = await context.newCDPSession(manager);
    let confirmStopped;
    const stopped = new Promise((resolve) => { confirmStopped = resolve; });
    const registered = new Promise((resolve) => serviceWorkers.on("ServiceWorker.workerVersionUpdated", (event) => {
      const version = event.versions.find((entry) => entry.scriptURL === worker.url());
      if (version) resolve(version.versionId);
      if (version?.runningStatus === "stopped") confirmStopped();
    }));
    await serviceWorkers.send("ServiceWorker.enable");
    const versionId = await Promise.race([registered, setTimeout(3000).then(() => {
      throw new Error("Extension worker version not found");
    })]);
    await serviceWorkers.send("ServiceWorker.stopWorker", { versionId });
    await Promise.race([stopped, setTimeout(5000).then(() => { throw new Error("Extension worker did not stop"); })]);
    const awake = await context.newPage();
    await awake.goto(`chrome-extension://${extensionId}/popup.html`);
    const wakeResponse = await awake.evaluate(() => chrome.runtime.sendMessage({ kind: "list_fixture_pending", tabId: 1 }));
    assert.equal(wakeResponse?.ok, false, JSON.stringify(wakeResponse));
    assert.notEqual(wakeResponse?.error, "Fixture grant reset unavailable; try again");
    assert.equal((await facade.getConnection(beforeReload)).payload.state, "ready_readonly");
    await awake.close();
    await serviceWorkers.detach();

    const reloadError = await manager.evaluate((id) => new Promise((resolve) =>
      chrome.developerPrivate.reload(id, { failQuietly: false }, () =>
        resolve(chrome.runtime.lastError?.message ?? null))), extensionId);
    assert.equal(reloadError, null);
    await manager.waitForFunction((id) => new Promise((resolve) =>
      chrome.developerPrivate.getExtensionInfo(id, (info) => resolve(info?.state === "ENABLED"))),
    extensionId, { timeout: 8000 });
    await waitForStale(beforeReload);
    const wake = await context.newPage();
    await wake.goto(`chrome-extension://${extensionId}/popup.html`);
    await wake.evaluate(() => chrome.runtime.sendMessage({ kind: "list_fixture_pending", tabId: 1 }));
    const reloadedMarker = await wake.evaluate(async () =>
      (await chrome.storage.session.get("fixture-reset-done"))["fixture-reset-done"]);
    await wake.close();
    assert.equal(reloadedMarker, true);

    const beforeBrowserRestart = await grant(4);
    await context.close();
    context = await launch();
    worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    assert.equal(new URL(worker.url()).hostname, extensionId);
    await waitForStale(beforeBrowserRestart);
    assert.equal(await worker.evaluate(async () =>
      (await chrome.storage.session.get("fixture-reset-done"))["fixture-reset-done"]), true);

    const trackedTab = await worker.evaluate(() => chrome.tabs.create({ url: "about:blank", active: false }));
    const beforeTabClose = await grant(trackedTab.id);
    await worker.evaluate(({ tabId }) => chrome.storage.session.set({
      [`fixture-grant-${tabId}`]: { documentId: `CHROME-doc_${tabId}`, expiresAt: Date.now() + 10_000 }
    }), { tabId: trackedTab.id });
    await worker.evaluate((tabId) => chrome.tabs.remove(tabId), trackedTab.id);
    await waitForStale(beforeTabClose);
  } finally {
    await context?.close();
    facade?.close();
    relay?.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    await rm(profile, { recursive: true, force: true });
  }
});