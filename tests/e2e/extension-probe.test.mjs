import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "playwright-core";
import { connectBroker } from "../../packages/companion/dist/broker-client.js";
import { planNativeRegistration, registerNative } from "../../packages/companion/dist/native-registration.js";
import { reserveBrowserSubmitAttempt, reserveFixtureSubmitAttempt } from "../../packages/extension/lib/fixture-observation.ts";

const extensionDirectory = fileURLToPath(new URL("../../packages/extension/.output/chrome-mv3/", import.meta.url));
const nativeRelayPath = fileURLToPath(new URL("../../packages/companion/dist/native-relay.js", import.meta.url));

async function brokerSocketReady(socketPath) {
  try {
    const info = await stat(socketPath);
    return info.isSocket() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return false;
  }
}

test("extension broker readiness rejects a socket until its permissions are private", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-extension-readiness-"));
  const socketPath = join(home, "broker.sock");
  const server = createServer();
  try {
    assert.equal(await brokerSocketReady(socketPath), false);
    assert.equal(await brokerSocketReady(home), false);
    const listening = once(server, "listening");
    server.listen(socketPath);
    await listening;
    await chmod(socketPath, 0o666);
    assert.equal(await brokerSocketReady(socketPath), false);
    await chmod(socketPath, 0o600);
    assert.equal(await brokerSocketReady(socketPath), true);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("isolated Chromium loads the extension, popup, and native host", { timeout: 15000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-extension-test-"));
  const launch = () => chromium.launchPersistentContext(profile, {
    chromiumSandbox: true, executablePath: "/usr/bin/chromium", headless: true,
    args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`]
  });
  let context;
  try {
    context = await launch();
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
    const sandbox = await context.newPage();
    await sandbox.goto("chrome://sandbox/");
    const sandboxStatus = await sandbox.locator("tr").evaluateAll((rows) => Object.fromEntries(rows
      .map((row) => Array.from(row.querySelectorAll("td"), (cell) => cell.textContent.trim()))
      .filter((cells) => cells.length === 2)));
    assert.equal(sandboxStatus["Seccomp-BPF sandbox"], "Yes", JSON.stringify(sandboxStatus));
    assert.ok(["Namespace", "SUID"].includes(sandboxStatus["Layer 1 Sandbox"]),
      JSON.stringify(sandboxStatus));
    const operationId = crypto.randomUUID();
    const reservation = () => ({ operationId, expiresAt: Date.now() + 4000 });
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt, reservation()), true);
    const geminiOperationId = crypto.randomUUID();
    const geminiReservation = () => ({ operationId: geminiOperationId, expiresAt: Date.now() + 4000, provider: "gemini" });
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt, geminiReservation()), true);
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt, geminiReservation()), false);
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt, { ...geminiReservation(), provider: "unsupported" }), false);
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() - 1, provider: "gemini" }), false);
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 10_000, provider: "gemini" }), false);
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt, reservation()), false);
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt, { ...reservation(), operationId: "invalid" }), false);
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt, { ...reservation(), expiresAt: Date.now() - 1 }), false);
    await worker.evaluate(() => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      globalThis.fixtureOriginalReservationGet = get;
      chrome.storage.local.get = async keys => {
        if (keys === null) await new Promise(resolve => { globalThis.fixtureReleaseReservationGet = resolve; });
        return get(keys);
      };
    });
    const pendingReservation = worker.evaluate(reserveFixtureSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000 });
    try {
      assert.equal(await worker.evaluate(() => globalThis.fixtureSubmitReservationPending), true);
      assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt,
        { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000 }), false);
      assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt,
        { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000, provider: "gemini" }), false);
    } finally {
      await worker.evaluate(() => {
        chrome.storage.local.get = globalThis.fixtureOriginalReservationGet;
        globalThis.fixtureReleaseReservationGet();
        delete globalThis.fixtureOriginalReservationGet;
        delete globalThis.fixtureReleaseReservationGet;
      });
    }
    assert.equal(await pendingReservation, true);
    const expiredReservationId = crypto.randomUUID();
    await worker.evaluate(() => {
      globalThis.fixtureOriginalReservationGet = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = keys => keys === null
        ? new Promise(resolve => { globalThis.fixtureReleaseReservationGet = resolve; })
        : globalThis.fixtureOriginalReservationGet(keys);
    });
    try {
      assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt,
        { operationId: expiredReservationId, expiresAt: Date.now() + 100 }), false);
      assert.equal(await worker.evaluate(() => globalThis.fixtureSubmitReservationPending), true);
      assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt,
        { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000 }), false);
    } finally {
      await worker.evaluate(async () => {
        chrome.storage.local.get = globalThis.fixtureOriginalReservationGet;
        globalThis.fixtureReleaseReservationGet({});
        await Promise.resolve();
        delete globalThis.fixtureOriginalReservationGet;
        delete globalThis.fixtureReleaseReservationGet;
      });
    }
    assert.equal(await worker.evaluate(() => globalThis.fixtureSubmitReservationPending), false);
    assert.deepEqual(await worker.evaluate(key => chrome.storage.local.get(key),
      `fixture-submit-attempt-${expiredReservationId}`), {});
    await worker.evaluate(() => {
      globalThis.fixtureOriginalReservationGet = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = async () => { throw new Error("Private synthetic storage failure"); };
    });
    try {
      assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt,
        { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000 }), false);
    } finally {
      await worker.evaluate(() => {
        chrome.storage.local.get = globalThis.fixtureOriginalReservationGet;
        delete globalThis.fixtureOriginalReservationGet;
      });
    }
    await context.close();
    context = await launch();
    worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    assert.equal(new URL(worker.url()).hostname, extensionId);
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt, reservation()), false);
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt, geminiReservation()), false);
    const persisted = await worker.evaluate(async () => chrome.storage.local.get(null));
    assert.equal(persisted[`fixture-submit-attempt-${operationId}`], true);
    assert.equal(persisted[`gemini-submit-attempt-${geminiOperationId}`], true);
    assert.equal(Object.values(persisted).every(value => value === true), true);
    const missingWriteId = crypto.randomUUID();
    await worker.evaluate(() => {
      globalThis.originalReservationSet = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = async () => {};
    });
    try {
      assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt,
        { operationId: missingWriteId, expiresAt: Date.now() + 4000, provider: "gemini" }), false);
      assert.deepEqual(await worker.evaluate(key => chrome.storage.local.get(key), `gemini-submit-attempt-${missingWriteId}`), {});
    } finally {
      await worker.evaluate(() => {
        chrome.storage.local.set = globalThis.originalReservationSet;
        delete globalThis.originalReservationSet;
      });
    }
    await worker.evaluate(async () => chrome.storage.local.set({ "gemini-submit-attempt-invalid": true }));
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000, provider: "gemini" }), false);
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000 }), false);
    await worker.evaluate(async () => chrome.storage.local.remove("gemini-submit-attempt-invalid"));
    await worker.evaluate(async key => chrome.storage.local.set({ [key]: false }), `gemini-submit-attempt-${geminiOperationId}`);
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000, provider: "gemini" }), false);
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000 }), false);
    await worker.evaluate(async key => chrome.storage.local.set({ [key]: true }), `gemini-submit-attempt-${geminiOperationId}`);
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ "fixture-submit-attempt-invalid": true });
    });
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000 }), false);
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(Object.fromEntries(Array.from({ length: 10_000 }, () =>
        [`fixture-submit-attempt-${crypto.randomUUID()}`, true])));
    });
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000 }), false);
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(Object.fromEntries(Array.from({ length: 10_000 }, (_, index) =>
        [`${index % 2 ? "gemini" : "fixture"}-submit-attempt-${crypto.randomUUID()}`, true])));
    });
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000, provider: "gemini" }), false);
    assert.equal(await worker.evaluate(reserveFixtureSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000 }), false);
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(Object.fromEntries(Array.from({ length: 10_000 }, () =>
        [`gemini-submit-attempt-${crypto.randomUUID()}`, true])));
    });
    assert.equal(await worker.evaluate(reserveBrowserSubmitAttempt,
      { operationId: crypto.randomUUID(), expiresAt: Date.now() + 4000, provider: "gemini" }), false);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("worker wake marks a gap; reload, tab close, denied reads, and disconnect revoke grants", { timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-restart-test-"));
  const directory = join(profile, ".config/agent-messaging-mcp/broker");
  const brokerEntry = fileURLToPath(new URL("../../packages/companion/dist/broker-process.js", import.meta.url));
  const launch = () => chromium.launchPersistentContext(profile, {
    chromiumSandbox: true,
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
        ready = await brokerSocketReady(join(directory, "broker.sock"));
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
    const unselectedGemini = await facade.requestConnection();
    if (unselectedGemini.kind !== "connection_requested") throw new Error("Expected a pending Gemini test request");
    const popupTabId = await popup.evaluate(async () =>
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
    assert.ok(popupTabId);
    const deniedGemini = await popup.evaluate(({ tabId, pendingRequestId }) => chrome.runtime.sendMessage({
      kind: "approve_gemini", tabId, expectedUrl: "https://gemini.google.com/app/disposable-chat", pendingRequestId
    }), { tabId: popupTabId, pendingRequestId: unselectedGemini.payload.requestId });
    assert.equal(deniedGemini?.ok, false);
    assert.equal((await facade.getConnection(unselectedGemini.payload.requestId)).payload.state, "pending");
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

    async function createSettledTab() {
      return worker.evaluate(async () => {
        const tab = await chrome.tabs.create({ url: "about:blank", active: false });
        await new Promise((resolve) => {
          const finished = () => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          };
          const onUpdated = (updatedTabId, changes) => {
            if (updatedTabId === tab.id && changes.status === "complete") finished();
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
          void chrome.tabs.get(tab.id).then((current) => { if (current.status === "complete") finished(); });
        });
        return tab;
      });
    }

    const beforeReload = await grant(3);
    const beforeWake = await facade.getConnection(beforeReload);
    if (beforeWake.kind !== "connection_state" || beforeWake.payload.state !== "ready_readonly") {
      throw new Error("Expected a seeded worker-wake grant");
    }
    const wakeTarget = { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId: 3,
      documentId: "CHROME-doc_3" };
    const wakeRows = [{ id: "fixture-1", direction: "incoming", text: "Before worker wake" }];
    assert.deepEqual((await relay.publishFixtureSnapshot(wakeTarget, wakeRows)).payload, { count: 1 });
    const initialRead = facade.readFixtureSnapshot(beforeWake.payload.connectionId);
    let initialChallenge;
    for (let attempt = 0; attempt < 40; attempt++) {
      const listing = await relay.listFixtureReadChallenges();
      if (listing.kind !== "fixture_read_challenges") throw new Error("Expected seeded read challenges");
      initialChallenge = listing.payload.challenges[0]?.challengeId;
      if (initialChallenge) break;
      await setTimeout(10);
    }
    assert.ok(initialChallenge, "Broker did not challenge the seeded snapshot read");
    assert.deepEqual((await relay.publishFixtureSnapshot(wakeTarget, wakeRows, initialChallenge)).payload, { count: 1 });
    const initialSnapshot = await initialRead;
    if (initialSnapshot.kind !== "fixture_snapshot") throw new Error("Expected old event cursor");
    await worker.evaluate(() => chrome.storage.session.set({
      "fixture-grant-3": { documentId: "CHROME-doc_3", expiresAt: Date.now() + 30_000 }
    }));
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
    let gapMarked = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await facade.getConnection(beforeReload);
      if (state.kind === "connection_state" && state.payload.state === "ready_readonly"
        && state.payload.observation.state === "not_observed") { gapMarked = true; break; }
      await setTimeout(50);
    }
    assert.equal(gapMarked, true, "Worker wake did not mark an observation gap");
    const oldEvents = await facade.readFixtureEvents(beforeWake.payload.connectionId, initialSnapshot.payload.cursor);
    assert.equal(oldEvents.kind, "fixture_events");
    assert.deepEqual(oldEvents.payload, { state: "expired", resnapshot: true });
    await awake.close();
    await serviceWorkers.detach();

    const geminiBeforeReload = await facade.requestConnection();
    if (geminiBeforeReload.kind !== "connection_requested") throw new Error("Expected Gemini reload request");
    const geminiReloadApproval = await relay.approveGemini(geminiBeforeReload.payload.requestId, {
      origin: "https://gemini.google.com", conversationId: "disposable-chat",
      url: "https://gemini.google.com/app/disposable-chat", tabId: 5,
      documentId: "CHROME-doc_gemini-reload"
    });
    assert.equal(geminiReloadApproval.kind, "gemini_approved");

    const reloadError = await manager.evaluate((id) => new Promise((resolve) =>
      chrome.developerPrivate.reload(id, { failQuietly: false }, () =>
        resolve(chrome.runtime.lastError?.message ?? null))), extensionId);
    assert.equal(reloadError, null);
    await manager.waitForFunction((id) => new Promise((resolve) =>
      chrome.developerPrivate.getExtensionInfo(id, (info) => resolve(info?.state === "ENABLED"))),
    extensionId, { timeout: 8000 });
    const wake = await context.newPage();
    await wake.goto(`chrome-extension://${extensionId}/popup.html`);
    await wake.evaluate(() => chrome.runtime.sendMessage({ kind: "list_fixture_pending", tabId: 1 }));
    const reloadedMarker = await wake.evaluate(async () =>
      (await chrome.storage.session.get("fixture-reset-done"))["fixture-reset-done"]);
    await wake.close();
    assert.equal(reloadedMarker, true);
    await waitForStale(beforeReload);
    await waitForStale(geminiBeforeReload.payload.requestId);
    const runtimeErrors = await manager.evaluate((id) => new Promise((resolve) =>
      chrome.developerPrivate.getExtensionInfo(id, (info) => resolve(
        info?.runtimeErrors?.map((error) => error.message) ?? []
      ))), extensionId);
    assert.equal(runtimeErrors.some((message) => message.includes("Unchecked runtime.lastError: Native host has exited")),
      false, JSON.stringify(runtimeErrors));

    const beforeBrowserRestart = await grant(4);
    await context.close();
    context = await launch();
    worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    assert.equal(new URL(worker.url()).hostname, extensionId);
    const restartedPopup = await context.newPage();
    await restartedPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    const restartedResponse = await restartedPopup.evaluate(() =>
      chrome.runtime.sendMessage({ kind: "list_fixture_pending", tabId: 1 }));
    assert.equal(restartedResponse?.ok, false, JSON.stringify(restartedResponse));
    assert.notEqual(restartedResponse?.error, "Fixture grant reset unavailable; try again");
    await waitForStale(beforeBrowserRestart);
    assert.equal(await worker.evaluate(async () =>
      (await chrome.storage.session.get("fixture-reset-done"))["fixture-reset-done"]), true);
    await restartedPopup.close();

    const trackedTab = await createSettledTab();
    const beforeTabClose = await grant(trackedTab.id);
    await worker.evaluate(({ tabId }) => chrome.storage.session.set({
      [`fixture-grant-${tabId}`]: { documentId: `CHROME-doc_${tabId}`, expiresAt: Date.now() + 10_000 }
    }), { tabId: trackedTab.id });
    await worker.evaluate((tabId) => chrome.tabs.remove(tabId), trackedTab.id);
    await waitForStale(beforeTabClose);

    const geminiTab = await createSettledTab();
    const geminiPending = await facade.requestConnection();
    if (geminiPending.kind !== "connection_requested") throw new Error("Expected a synthetic Gemini request");
    const geminiApproved = await relay.approveGemini(geminiPending.payload.requestId, {
      origin: "https://gemini.google.com", conversationId: "disposable-chat",
      url: "https://gemini.google.com/app/disposable-chat", tabId: geminiTab.id,
      documentId: `CHROME-doc_${geminiTab.id}`
    });
    assert.equal(geminiApproved.kind, "gemini_approved");
    await worker.evaluate(({ tabId }) => chrome.storage.session.set({
      [`gemini-grant-${tabId}`]: { documentId: `CHROME-doc_${tabId}`,
        url: "https://gemini.google.com/app/disposable-chat", expiresAt: Date.now() + 30_000 }
    }), { tabId: geminiTab.id });
    await worker.evaluate((tabId) => chrome.tabs.remove(tabId), geminiTab.id);
    await waitForStale(geminiPending.payload.requestId);

    const unapprovedTab = await createSettledTab();
    const beforeDeniedRead = await grant(unapprovedTab.id);
    const deniedState = await facade.getConnection(beforeDeniedRead);
    if (deniedState.kind !== "connection_state" || deniedState.payload.state !== "ready_readonly") {
      throw new Error("Expected a seeded read handle");
    }
    await worker.evaluate(({ tabId }) => chrome.storage.session.set({
      [`fixture-grant-${tabId}`]: { documentId: `CHROME-doc_${tabId}`, expiresAt: Date.now() + 30_000 }
    }), { tabId: unapprovedTab.id });
    const unapprovedGeminiTab = await createSettledTab();
    const unapprovedGemini = await facade.requestConnection();
    if (unapprovedGemini.kind !== "connection_requested") throw new Error("Expected a Gemini read request");
    const geminiTarget = { origin: "https://gemini.google.com", conversationId: "disposable-chat",
      url: "https://gemini.google.com/app/disposable-chat?hl=en", tabId: unapprovedGeminiTab.id,
      documentId: `CHROME-doc_${unapprovedGeminiTab.id}` };
    assert.equal((await relay.approveGemini(unapprovedGemini.payload.requestId, geminiTarget)).kind, "gemini_approved");
    const unapprovedGeminiState = await facade.getConnection(unapprovedGemini.payload.requestId);
    if (unapprovedGeminiState.kind !== "connection_state"
      || unapprovedGeminiState.payload.state !== "ready_readonly") throw new Error("Expected a Gemini read handle");
    await worker.evaluate(({ tabId, url }) => chrome.storage.session.set({
      [`gemini-grant-${tabId}`]: { documentId: `CHROME-doc_${tabId}`, url, expiresAt: Date.now() + 30_000 }
    }), { tabId: unapprovedGeminiTab.id, url: geminiTarget.url });
    const disconnectedTab = await createSettledTab();
    const beforeDisconnect = await grant(disconnectedTab.id);
    const disconnectState = await facade.getConnection(beforeDisconnect);
    if (disconnectState.kind !== "connection_state" || disconnectState.payload.state !== "ready_readonly") {
      throw new Error("Expected a disconnectable seeded handle");
    }
    await worker.evaluate(({ tabId }) => chrome.storage.session.set({
      [`fixture-grant-${tabId}`]: { documentId: `CHROME-doc_${tabId}`, expiresAt: Date.now() + 30_000 }
    }), { tabId: disconnectedTab.id });
    await worker.evaluate(() => chrome.storage.session.set({
      "fixture-grant-9999": { documentId: "CHROME-doc_orphan", expiresAt: Date.now() + 30_000 }
    }));
    await worker.evaluate(() => chrome.storage.session.set({
      "gemini-grant-9999": { documentId: "CHROME-doc_orphan",
        url: "https://gemini.google.com/app/disposable-chat?hl=en", expiresAt: Date.now() + 30_000 }
    }));
    const resumedManager = await context.newPage();
    await resumedManager.goto("chrome://extensions/");
    const readerWorkers = await context.newCDPSession(resumedManager);
    let confirmReadWorkerStopped;
    const readWorkerStopped = new Promise((resolve) => { confirmReadWorkerStopped = resolve; });
    const readWorkerVersion = new Promise((resolve) => readerWorkers.on("ServiceWorker.workerVersionUpdated", (event) => {
      const version = event.versions.find((entry) => entry.scriptURL === worker.url());
      if (version) resolve(version.versionId);
      if (version?.runningStatus === "stopped") confirmReadWorkerStopped();
    }));
    await readerWorkers.send("ServiceWorker.enable");
    const readVersionId = await Promise.race([readWorkerVersion, setTimeout(3000).then(() => {
      throw new Error("Read worker version not found");
    })]);
    await readerWorkers.send("ServiceWorker.stopWorker", { versionId: readVersionId });
    await Promise.race([readWorkerStopped, setTimeout(5000).then(() => {
      throw new Error("Read worker did not stop");
    })]);
    const resumedPopup = await context.newPage();
    await resumedPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    await resumedPopup.evaluate(() => chrome.runtime.sendMessage({ kind: "list_fixture_pending", tabId: 1 }));
    await resumedPopup.waitForFunction(async () =>
      (await chrome.storage.session.get("fixture-grant-9999"))["fixture-grant-9999"] === undefined,
    undefined, { timeout: 8000 });
    await resumedPopup.waitForFunction(async () =>
      (await chrome.storage.session.get("gemini-grant-9999"))["gemini-grant-9999"] === undefined,
    undefined, { timeout: 8000 });
    const denied = await facade.readFixtureSnapshot(deniedState.payload.connectionId);
    assert.equal(denied.kind, "error");
    assert.deepEqual(denied.payload, { code: "CONNECTION_NOT_FOUND" });
    await waitForStale(beforeDeniedRead);
    const beforeGeminiChallenge = await facade.getConnection(unapprovedGemini.payload.requestId);
    const trackedGeminiBefore = await resumedPopup.evaluate(async (tabId) => {
      const key = `gemini-grant-${tabId}`;
      return (await chrome.storage.session.get(key))[key] !== undefined;
    }, unapprovedGeminiTab.id);
    assert.equal(beforeGeminiChallenge.payload.state, "ready_readonly",
      `Gemini grant was revoked before its challenge; tracked: ${trackedGeminiBefore}`);
    assert.equal(trackedGeminiBefore, true);
    const deniedGeminiRead = await facade.readGeminiSnapshot(unapprovedGeminiState.payload.connectionId);
    assert.equal(deniedGeminiRead.kind, "error");
    assert.deepEqual(deniedGeminiRead.payload, { code: "CONNECTION_NOT_FOUND" });
    await waitForStale(unapprovedGemini.payload.requestId);
    await resumedPopup.waitForFunction(async (tabId) => {
      const key = `gemini-grant-status-${tabId}`;
      return (await chrome.storage.session.get(key))[key]?.code === "target_changed";
    }, unapprovedGeminiTab.id, { timeout: 2000 });
    const geminiStatus = await resumedPopup.evaluate(async (tabId) => {
      const key = `gemini-grant-status-${tabId}`;
      return (await chrome.storage.session.get(key))[key];
    }, unapprovedGeminiTab.id);
    assert.equal(geminiStatus?.code, "target_changed");
    assert.equal(Number.isSafeInteger(geminiStatus?.recordedAt), true);
    assert.deepEqual(Object.keys(geminiStatus).sort(), ["code", "recordedAt"]);
    assert.deepEqual((await facade.disconnectFixture(disconnectState.payload.connectionId)).payload,
      { disconnected: true });
    await resumedPopup.waitForFunction(async (tabId) => {
      const key = `fixture-grant-${tabId}`;
      return (await chrome.storage.session.get(key))[key] === undefined;
    }, disconnectedTab.id, { timeout: 4000 });
    assert.equal(await resumedPopup.evaluate(async (tabId) => !!await chrome.tabs.get(tabId), disconnectedTab.id), true);
    assert.deepEqual((await facade.getConnection(beforeDisconnect)).payload,
      { requestId: beforeDisconnect, state: "stale" });
    await resumedPopup.close();
    await readerWorkers.detach();
  } finally {
    await context?.close();
    facade?.close();
    relay?.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    await rm(profile, { recursive: true, force: true });
  }
});

test("trusted fixture popup separates consent from one-shot exact-document draft fill", { timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-fixture-review-test-"));
  let mcpClient;
  const unpacked = join(profile, "unpacked-extension");
  await cp(extensionDirectory, unpacked, { recursive: true });
  const manifestPath = join(unpacked, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://127.0.0.1:8787/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const brokerDirectory = join(profile, ".config/agent-messaging-mcp/broker");
  const brokerEntry = fileURLToPath(new URL("../../packages/companion/dist/broker-process.js", import.meta.url));
  let context;
  let broker;
  let brokerExit;
  let facade;
  let relay;
  try {
    context = await chromium.launchPersistentContext(profile, {
      chromiumSandbox: true,
      executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
      args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`]
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    const extensionId = new URL(worker.url()).hostname;
    await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
    broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
    brokerExit = once(broker, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        ready = await brokerSocketReady(join(brokerDirectory, "broker.sock"));
        if (ready) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await setTimeout(25);
    }
    assert.equal(ready, true, "Broker did not start");
    facade = await connectBroker("facade", brokerDirectory);

    const fixture = await context.newPage();
    const fixtureHtml = await readFile(fileURLToPath(new URL("../fixtures/chat.html", import.meta.url)), "utf8");
    await fixture.route("http://127.0.0.1:8787/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8", body: fixtureHtml
    }));
    const url = "http://127.0.0.1:8787/";
    await fixture.goto(url);
    const selected = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [identity] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
        func: () => document.querySelector("main")?.getAttribute("data-conversation-id") });
      return { tabId: tab.id, documentId: identity.documentId, conversation: identity.result };
    });
    assert.equal(selected.conversation, "fixture-alpha");
    assert.match(selected.documentId, /^[!-~]{1,128}$/);

    const popup = await context.newPage();
    await fixture.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const waitForPopupResult = async (locator) => {
      try {
        await locator.waitFor({ state: "visible", timeout: 4000 });
      } catch (error) {
        const status = await popup.locator("#status").textContent();
        throw new Error(`Fixture popup did not produce the expected result; status: ${status}`, { cause: error });
      }
    };
    await popup.getByRole("button", { name: "Review fixture drafts" }).waitFor({ state: "visible" });
    const reviewArgs = { tabId: selected.tabId, expectedUrl: url };
    assert.equal(await popup.locator("#view-fixture-send-reviews").count(), 1);
    const before = await popup.evaluate((args) => chrome.runtime.sendMessage({
      kind: "list_fixture_prepared_reviews", ...args
    }), reviewArgs);
    assert.equal(before.ok, false);

    for (const scenario of [
      { selector: "#view-fixture-reviews", outcome: "empty" },
      { selector: "#view-fixture-fill-reviews", outcome: "empty" },
      { selector: "#view-fixture-reviews", outcome: "refused" },
      { selector: "#view-fixture-fill-reviews", outcome: "rejected" },
      { selector: "#view-fixture-send-reviews", outcome: "empty" },
      { selector: "#view-fixture-send-reviews", outcome: "refused" },
      { selector: "#view-fixture-send-reviews", outcome: "rejected" }
    ]) {
      await popup.evaluate(() => {
        globalThis.fixtureOriginalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (...args) => ["list_fixture_prepared_reviews", "list_fixture_fill_reviews", "list_fixture_send_reviews"]
          .includes(args[0]?.kind) ? new Promise((resolve, reject) => {
            globalThis.fixtureResolveReview = resolve;
            globalThis.fixtureRejectReview = reject;
          }) : globalThis.fixtureOriginalSendMessage(...args);
      });
      let changedTab;
      try {
        await popup.evaluate((selector) => document.querySelector(selector).click(), scenario.selector);
        await popup.waitForFunction(() => typeof globalThis.fixtureResolveReview === "function", undefined, { timeout: 4000 });
        changedTab = await context.newPage();
        await changedTab.goto("about:blank");
        await popup.getByText("Selected fixture changed. Draft review cleared.", { exact: true })
          .waitFor({ state: "visible", timeout: 4000 });
        await popup.evaluate((outcome) => {
          if (outcome === "rejected") globalThis.fixtureRejectReview(new Error("Late fixture review failure"));
          else globalThis.fixtureResolveReview(outcome === "empty" ? { ok: true, reviews: [], hasMore: false }
            : { ok: false, error: "Late fixture review refused" });
        }, scenario.outcome);
        await popup.waitForFunction(() => !document.querySelector("#view-fixture-reviews").disabled, undefined, { timeout: 4000 });
        assert.equal(await popup.locator("#fixture-review-result").evaluate((element) => element.hidden), true);
        assert.equal(await popup.locator("#fixture-reviews pre").count(), 0);
        assert.equal(await popup.locator("#status").textContent(), "Selected fixture changed. Draft review cleared.");
      } finally {
        await popup.evaluate(() => {
          chrome.runtime.sendMessage = globalThis.fixtureOriginalSendMessage;
          delete globalThis.fixtureOriginalSendMessage;
          delete globalThis.fixtureResolveReview;
          delete globalThis.fixtureRejectReview;
        });
        await changedTab?.close();
        await fixture.bringToFront();
        await popup.reload();
        await popup.getByRole("button", { name: "Review fixture drafts" }).waitFor({ state: "visible" });
      }
    }

    const created = await facade.requestConnection();
    if (created.kind !== "connection_requested") throw new Error("Expected fixture request");
    const approved = await popup.evaluate(({ tabId, expectedUrl, pendingRequestId }) => chrome.runtime.sendMessage({
      kind: "approve_fixture", tabId, expectedUrl, pendingRequestId
    }), { ...reviewArgs, pendingRequestId: created.payload.requestId });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const connection = await facade.getConnection(created.payload.requestId);
    if (connection.kind !== "connection_state" || connection.payload.state !== "ready_readonly") {
      throw new Error("Expected approved fixture handle");
    }
    const text = "Synthetic <script>alert(1)</script> &\nSecond line";
    const prepared = await facade.prepareFixtureMessage(connection.payload.connectionId, 1, text,
      "b66b3997-9d43-4554-8399-267d1fe9f75c");
    assert.equal(prepared.kind, "message_prepared");
    const prematureFill = await popup.evaluate((args) => chrome.runtime.sendMessage({
      kind: "list_fixture_fill_reviews", ...args
    }), reviewArgs);
    assert.deepEqual(prematureFill, { ok: true, reviews: [], hasMore: false });
    const prematureSend = await popup.evaluate((args) => chrome.runtime.sendMessage({
      kind: "list_fixture_send_reviews", ...args
    }), reviewArgs);
    assert.deepEqual(prematureSend, { ok: true, reviews: [], hasMore: false });
    await popup.evaluate(() => document.querySelector("#view-fixture-reviews").click());
    await waitForPopupResult(popup.locator("#fixture-reviews pre"));
    assert.equal(await popup.locator("#fixture-reviews pre").textContent(), text);
    assert.equal(await popup.locator("#fixture-reviews script").count(), 0);
    assert.equal(await popup.getByRole("button", { name: "Approve draft (no send)" }).count(), 1);
    await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
    await waitForPopupResult(popup.getByText(`Approved fixture draft ${prepared.payload.operationId}. No message was sent.`));
    assert.equal(await popup.locator("#fixture-reviews pre").count(), 0);
    relay = await connectBroker("relay", brokerDirectory);
    const target = { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
      tabId: selected.tabId, documentId: selected.documentId };
    assert.deepEqual((await relay.listFixturePreparedReviews(target)).payload, { reviews: [], hasMore: false });
    await popup.evaluate(() => document.querySelector("#view-fixture-fill-reviews").click());
    await waitForPopupResult(popup.locator("#fixture-reviews pre"));
    assert.equal(await popup.locator("#fixture-reviews pre").textContent(), text);
    assert.equal(await popup.locator("#fixture-reviews script").count(), 0);
    assert.equal(await popup.getByRole("button", { name: "Allow draft fill (no send)" }).count(), 1);
    assert.equal(await popup.getByRole("button", { name: "Approve draft (no send)" }).count(), 0);
    await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
    await waitForPopupResult(popup.getByText(`Allowed fixture draft fill ${prepared.payload.operationId}. Editor unchanged. No message was sent.`));
    assert.deepEqual((await relay.listFixtureFillReviews(target)).payload, { reviews: [], hasMore: false });
    assert.equal(await fixture.locator("#message").inputValue(), "");
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    const checked = await facade.checkFixturePreflight(prepared.payload.operationId);
    if (checked.kind !== "fixture_preflight") throw new Error(`Expected fixture preflight: ${JSON.stringify(checked.payload)}`);
    assert.equal(checked.payload.ok, true, JSON.stringify(checked.payload));
    assert.equal(checked.payload.editor, "textarea");
    assert.equal(JSON.stringify(checked.payload).includes(text), false);
    assert.equal(await fixture.locator("#message").inputValue(), "");
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);

    await fixture.locator("#message").fill("User draft must remain");
    const draftCheck = await facade.checkFixturePreflight(prepared.payload.operationId);
    assert.equal(draftCheck.kind, "fixture_preflight");
    assert.equal(draftCheck.payload.ok, false);
    assert.equal(draftCheck.payload.code, "DRAFT_PRESENT");
    assert.equal(await fixture.locator("#message").inputValue(), "User draft must remain");
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    await fixture.locator("#message").fill("");
    await fixture.locator("button[type=submit]").evaluate((button) => { button.disabled = true; });
    const submitCheck = await facade.checkFixturePreflight(prepared.payload.operationId);
    assert.equal(submitCheck.kind, "fixture_preflight");
    assert.equal(submitCheck.payload.ok, false);
    assert.equal(submitCheck.payload.code, "SUBMIT_UNAVAILABLE");
    await fixture.locator("button[type=submit]").evaluate((button) => { button.disabled = false; });
    await popup.bringToFront();
    const inactiveCheck = await facade.checkFixturePreflight(prepared.payload.operationId);
    assert.equal(inactiveCheck.kind, "fixture_preflight");
    assert.equal(inactiveCheck.payload.ok, false);
    assert.equal(inactiveCheck.payload.code, "TARGET_CHANGED");
    await fixture.bringToFront();
    const operationAfterCheck = await facade.getPreparedOperation(prepared.payload.operationId);
    assert.equal(operationAfterCheck.kind, "prepared_operation_state");
    assert.equal(operationAfterCheck.payload.state, "approved");
    const filled = await facade.fillFixtureDraft(prepared.payload.operationId);
    assert.equal(filled.kind, "fixture_fill");
    assert.equal(filled.payload.ok, true, JSON.stringify(filled.payload));
    assert.equal(filled.payload.editor, "textarea");
    assert.equal(await fixture.locator("#message").inputValue(), text);
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    const sendReviews = await relay.listFixtureSendReviews(target);
    assert.equal(sendReviews.kind, "fixture_send_reviews");
    const sendReviewId = sendReviews.payload.reviews[0].reviewId;
    assert.deepEqual((await relay.approveFixtureFillReview(target, prepared.payload.operationId,
      sendReviewId)).payload, { code: "FILL_REVIEW_UNAVAILABLE" });
    await popup.evaluate(() => document.querySelector("#view-fixture-send-reviews").click());
    await waitForPopupResult(popup.locator("#fixture-reviews pre"));
    assert.equal(await popup.locator("#fixture-review-heading").textContent(), "Fixture send consent");
    assert.equal(await popup.locator("#fixture-reviews pre").textContent(), text);
    assert.equal(await popup.locator("#fixture-reviews script").count(), 0);
    assert.equal(await popup.getByRole("button", { name: "Approve fixture send", exact: true }).count(), 1);
    assert.equal(await popup.getByRole("button", { name: "Allow draft fill (no send)", exact: true }).count(), 0);
    await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
    await waitForPopupResult(popup.getByText(`Approved fixture send ${prepared.payload.operationId}. No message was sent.`));
    assert.equal(await fixture.locator("#message").inputValue(), text);
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    assert.equal((await facade.getPreparedOperation(prepared.payload.operationId)).payload.state, "approved");
    const staleSendReview = await popup.evaluate((args) => chrome.runtime.sendMessage({
      kind: "approve_fixture_send_review", ...args
    }), { ...reviewArgs, operationId: prepared.payload.operationId, reviewId: sendReviewId });
    assert.equal(staleSendReview.ok, false);
    const postConsentSnapshot = await facade.readFixtureSnapshot(connection.payload.connectionId);
    assert.equal(postConsentSnapshot.kind, "fixture_snapshot");
    const exactInspection = await facade.checkFixtureDispatch(prepared.payload.operationId);
    assert.equal(exactInspection.kind, "fixture_dispatch_check", JSON.stringify(exactInspection.payload));
    assert.equal(exactInspection.payload.ready, true);
    assert.equal(await fixture.locator("#message").inputValue(), text);
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    await fixture.locator("#message").fill("Preserve this changed fixture draft");
    assert.equal((await facade.readFixtureSnapshot(connection.payload.connectionId)).kind, "fixture_snapshot");
    const changedInspection = await facade.checkFixtureDispatch(prepared.payload.operationId);
    assert.equal(changedInspection.kind, "fixture_dispatch_check", JSON.stringify(changedInspection.payload));
    assert.equal(changedInspection.payload.ready, false);
    assert.equal(await fixture.locator("#message").inputValue(), "Preserve this changed fixture draft");
    await fixture.locator("#message").fill(text);
    await fixture.locator("button[type=submit]").evaluate(button => { button.disabled = true; });
    assert.equal((await facade.readFixtureSnapshot(connection.payload.connectionId)).kind, "fixture_snapshot");
    const blockedInspection = await facade.checkFixtureDispatch(prepared.payload.operationId);
    assert.equal(blockedInspection.kind, "fixture_dispatch_check", JSON.stringify(blockedInspection.payload));
    assert.equal(blockedInspection.payload.ready, false);
    assert.equal(await fixture.locator("#message").inputValue(), text);
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    await fixture.locator("button[type=submit]").evaluate(button => { button.disabled = false; });
    assert.equal((await facade.readFixtureSnapshot(connection.payload.connectionId)).kind, "fixture_snapshot");
    const unapprovedTab = await context.newPage();
    try {
      await unapprovedTab.bringToFront();
      const inactiveInspection = await facade.checkFixtureDispatch(prepared.payload.operationId);
      assert.equal(inactiveInspection.kind, "fixture_dispatch_check", JSON.stringify(inactiveInspection.payload));
      assert.equal(inactiveInspection.payload.ready, false);
      assert.equal(await fixture.locator("#message").inputValue(), text);
      assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    } finally {
      await unapprovedTab.close();
      await fixture.bringToFront();
    }
    assert.equal((await facade.getPreparedOperation(prepared.payload.operationId)).payload.state, "approved");
    const { DatabaseSync } = await import("node:sqlite");
    const journal = new DatabaseSync(join(profile, ".config/agent-messaging-mcp/operations.sqlite"), { readOnly: true });
    try {
      assert.equal(journal.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get().count, 0);
    } finally {
      journal.close();
    }
    assert.deepEqual((await facade.fillFixtureDraft(prepared.payload.operationId)).payload, { code: "FILL_UNAVAILABLE" });
    await fixture.locator("#message").fill("");
    assert.deepEqual((await facade.fillFixtureDraft(prepared.payload.operationId)).payload, { code: "FILL_UNAVAILABLE" });
    assert.equal(await fixture.locator("#message").inputValue(), "");

    const approveFillCandidate = async (candidate) => {
      for (const [buttonId, statusText] of [
        ["view-fixture-reviews", `Approved fixture draft ${candidate.operationId}. No message was sent.`],
        ["view-fixture-fill-reviews", `Allowed fixture draft fill ${candidate.operationId}. Editor unchanged. No message was sent.`]
      ]) {
        await popup.evaluate((id) => document.getElementById(id).click(), buttonId);
        await waitForPopupResult(popup.locator("#fixture-reviews pre"));
        assert.equal(await popup.locator("#fixture-reviews pre").textContent(), candidate.preview.text);
        await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
        await waitForPopupResult(popup.getByText(statusText));
      }
    };

    const second = await facade.prepareFixtureMessage(connection.payload.connectionId, 1, "Second fixture draft",
      "c66b3997-9d43-4554-8399-267d1fe9f75c");
    assert.equal(second.kind, "message_prepared");
    await approveFillCandidate(second.payload);
    await fixture.locator("#message").fill("Preserve this user draft");
    const blockedFill = await facade.fillFixtureDraft(second.payload.operationId);
    assert.equal(blockedFill.kind, "fixture_fill");
    assert.equal(blockedFill.payload.ok, false);
    assert.equal(blockedFill.payload.code, "DRAFT_PRESENT");
    assert.equal(await fixture.locator("#message").inputValue(), "Preserve this user draft");
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    await fixture.locator("#message").fill("");
    assert.deepEqual((await facade.fillFixtureDraft(second.payload.operationId)).payload, { code: "FILL_UNAVAILABLE" });
    const third = await facade.prepareFixtureMessage(connection.payload.connectionId, 1, "Third fixture draft",
      "d66b3997-9d43-4554-8399-267d1fe9f75c");
    assert.equal(third.kind, "message_prepared");
    await popup.evaluate(() => document.querySelector("#view-fixture-reviews").click());
    await waitForPopupResult(popup.locator("#fixture-reviews pre"));
    assert.equal(await popup.locator("#fixture-reviews pre").textContent(), "Third fixture draft");
    await fixture.evaluate(() => document.querySelector("main").dataset.conversationId = "fixture-beta");
    await popup.locator("#fixture-review-result").waitFor({ state: "hidden", timeout: 4000 });
    assert.equal(await popup.locator("#fixture-review-result").isHidden(), true);
    assert.equal(await popup.locator("#fixture-reviews pre").count(), 0);
    const afterSwitch = await popup.evaluate((args) => chrome.runtime.sendMessage({
      kind: "list_fixture_prepared_reviews", ...args
    }), reviewArgs);
    assert.equal(afterSwitch.ok, false);

    const richUrl = "http://127.0.0.1:8787/?editor=rich";
    await fixture.goto(richUrl);
    await fixture.bringToFront();
    await popup.reload();
    await popup.getByRole("button", { name: "Review fixture drafts" }).waitFor({ state: "visible" });
    const richPending = await facade.requestConnection();
    assert.equal(richPending.kind, "connection_requested");
    const richApproval = await popup.evaluate((args) => chrome.runtime.sendMessage({ kind: "approve_fixture", ...args }), {
      tabId: selected.tabId, expectedUrl: richUrl, pendingRequestId: richPending.payload.requestId
    });
    assert.equal(richApproval.ok, true, JSON.stringify(richApproval));
    const richConnection = await facade.getConnection(richPending.payload.requestId);
    assert.equal(richConnection.kind, "connection_state");
    assert.equal(richConnection.payload.state, "ready_readonly");
    const richPrepared = await facade.prepareFixtureMessage(richConnection.payload.connectionId, 1,
      "Rich exact line\nSecond line \u00e9", "e66b3997-9d43-4554-8399-267d1fe9f75c");
    assert.equal(richPrepared.kind, "message_prepared");
    await approveFillCandidate(richPrepared.payload);
    const richFilled = await facade.fillFixtureDraft(richPrepared.payload.operationId);
    assert.equal(richFilled.kind, "fixture_fill");
    assert.equal(richFilled.payload.ok, true, JSON.stringify(richFilled.payload));
    assert.equal(richFilled.payload.editor, "rich");
    assert.equal(await fixture.locator("#rich-message").innerText(), richPrepared.payload.preview.text);
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    await popup.evaluate(() => document.querySelector("#view-fixture-send-reviews").click());
    await waitForPopupResult(popup.locator("#fixture-reviews pre"));
    assert.equal(await popup.locator("#fixture-reviews pre").textContent(), richPrepared.payload.preview.text);
    await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
    await waitForPopupResult(popup.getByText(`Approved fixture send ${richPrepared.payload.operationId}. No message was sent.`));
    assert.equal((await facade.readFixtureSnapshot(richConnection.payload.connectionId)).kind, "fixture_snapshot");
    const richInspection = await facade.checkFixtureDispatch(richPrepared.payload.operationId);
    assert.equal(richInspection.kind, "fixture_dispatch_check", JSON.stringify(richInspection.payload));
    assert.equal(richInspection.payload.ready, true);
    assert.equal(await fixture.locator("#rich-message").innerText(), richPrepared.payload.preview.text);
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    await fixture.locator("#rich-message").fill("");
    const lostPrepared = await facade.prepareFixtureMessage(richConnection.payload.connectionId, 1,
      "Synthetic fill with a lost script result", "f66b3997-9d43-4554-8399-267d1fe9f75c");
    assert.equal(lostPrepared.kind, "message_prepared");
    await approveFillCandidate(lostPrepared.payload);
    await worker.evaluate(() => {
      const execute = chrome.scripting.executeScript.bind(chrome.scripting);
      globalThis.fixtureOriginalExecute = execute;
      chrome.scripting.executeScript = async (options) => {
        const results = await execute(options);
        return options.args?.[0]?.attemptId ? [] : results;
      };
    });
    try {
      const lostResult = await facade.fillFixtureDraft(lostPrepared.payload.operationId);
      assert.equal(lostResult.kind, "fixture_fill");
      assert.equal(lostResult.payload.ok, false);
      assert.equal(lostResult.payload.code, "FILL_UNCERTAIN");
      assert.equal(await fixture.locator("#rich-message").innerText(), lostPrepared.payload.preview.text);
      assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
      await fixture.locator("#rich-message").fill("");
      assert.deepEqual((await facade.fillFixtureDraft(lostPrepared.payload.operationId)).payload, { code: "FILL_UNAVAILABLE" });
      assert.equal(await fixture.locator("#rich-message").innerText(), "\n");
    } finally {
      await worker.evaluate(() => {
        chrome.scripting.executeScript = globalThis.fixtureOriginalExecute;
        delete globalThis.fixtureOriginalExecute;
      });
    }
    await fixture.locator("#rich-message").evaluate((editor) => editor.replaceChildren());
    assert.equal(await fixture.locator("#rich-message").innerText(), "");
    mcpClient = new Client({ name: "fixture-browser-fill-test", version: "0.0.1" });
    const mcpEntry = fileURLToPath(new URL("../../packages/companion/dist/mcp-stdio.js", import.meta.url));
    await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntry],
      env: { ...process.env, HOME: profile } }));
    const mcpPending = await mcpClient.callTool({ name: "chat_request_connection", arguments: {} });
    assert.equal(mcpPending.isError, undefined);
    const mcpGrant = await popup.evaluate((args) => chrome.runtime.sendMessage({ kind: "approve_fixture", ...args }), {
      tabId: selected.tabId, expectedUrl: richUrl, pendingRequestId: mcpPending.structuredContent.requestId
    });
    assert.equal(mcpGrant.ok, true, JSON.stringify(mcpGrant));
    const mcpConnection = await mcpClient.callTool({ name: "chat_get_connection",
      arguments: { requestId: mcpPending.structuredContent.requestId } });
    assert.equal(mcpConnection.structuredContent.state, "ready_readonly");
    const mcpPrepared = await mcpClient.callTool({ name: "chat_prepare_message", arguments: {
      connectionId: mcpConnection.structuredContent.connectionId, expectedGeneration: 1,
      text: "Exact MCP fixture draft\nStill unsent", idempotencyKey: "a76b3997-9d43-4554-8399-267d1fe9f75c"
    } });
    assert.equal(mcpPrepared.isError, undefined);
    await approveFillCandidate(mcpPrepared.structuredContent);
    const mcpFilled = await mcpClient.callTool({ name: "chat_fill_draft",
      arguments: { operationId: mcpPrepared.structuredContent.operationId } });
    assert.equal(mcpFilled.isError, false, JSON.stringify(mcpFilled.structuredContent));
    assert.equal(mcpFilled.structuredContent.ok, true);
    assert.equal(mcpFilled.structuredContent.retryAllowed, false);
    assert.equal(await fixture.locator("#rich-message").innerText(), mcpPrepared.structuredContent.preview.text);
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);
    const mcpFillState = await mcpClient.callTool({ name: "chat_get_operation",
      arguments: { operationId: mcpPrepared.structuredContent.operationId } });
    assert.deepEqual(mcpFillState.structuredContent.draftFill, { state: "filled", editor: "rich",
      completedAt: mcpFilled.structuredContent.completedAt });
    assert.equal(JSON.stringify(mcpFillState).includes(mcpPrepared.structuredContent.preview.text), false);
    assert.equal(JSON.stringify(mcpFillState).includes(mcpPrepared.structuredContent.recoveryToken), false);
    const mcpReplay = await mcpClient.callTool({ name: "chat_fill_draft",
      arguments: { operationId: mcpPrepared.structuredContent.operationId } });
    assert.equal(mcpReplay.isError, true);
    assert.equal(mcpReplay.structuredContent.code, "FILL_UNAVAILABLE");
    const mcpDisconnected = await mcpClient.callTool({ name: "chat_disconnect",
      arguments: { connectionId: mcpConnection.structuredContent.connectionId } });
    assert.deepEqual(mcpDisconnected.structuredContent, { disconnected: true });
  } finally {
    await mcpClient?.close().catch(() => {});
    facade?.close();
    relay?.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function exerciseFixtureDispatch(outcome) {
  let mcpClient;
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-fixture-dispatch-test-"));
  const unpacked = join(profile, "unpacked-extension");
  await cp(extensionDirectory, unpacked, { recursive: true });
  const manifestPath = join(unpacked, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://127.0.0.1:8787/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const directory = join(profile, ".config/agent-messaging-mcp/broker");
  const brokerEntry = fileURLToPath(new URL("../../packages/companion/dist/broker-process.js", import.meta.url));
  let context;
  let broker;
  let brokerExit;
  let facade;
  let relay;
  try {
    context = await chromium.launchPersistentContext(profile, { chromiumSandbox: true,
      executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
      args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    const extensionId = new URL(worker.url()).hostname;
    await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
    broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
    brokerExit = once(broker, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        ready = await brokerSocketReady(join(directory, "broker.sock"));
        if (ready) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await setTimeout(25);
    }
    assert.equal(ready, true, "Broker did not start");
    facade = await connectBroker("facade", directory);
    relay = await connectBroker("relay", directory);
    mcpClient = new Client({ name: "fixture-browser-commit-test", version: "0.0.1" });
    const mcpEntry = fileURLToPath(new URL("../../packages/companion/dist/mcp-stdio.js", import.meta.url));
    await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntry],
      env: { ...process.env, HOME: profile } }));
    const fixture = await context.newPage();
    const html = await readFile(fileURLToPath(new URL("../fixtures/chat.html", import.meta.url)), "utf8");
    await fixture.route("http://127.0.0.1:8787/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
    const rich = outcome === "lost_script" || outcome === "worker_crash";
    const url = `http://127.0.0.1:8787/${rich ? "?editor=rich" : ""}`;
    await fixture.goto(url);
    await fixture.evaluate(() => {
      globalThis.fixtureSubmitCount = 0;
      document.querySelector("#composer").addEventListener("submit", () => { globalThis.fixtureSubmitCount++; });
    });
    const selected = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [identity] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
        func: () => document.querySelector("main")?.getAttribute("data-conversation-id") });
      return { tabId: tab.id, documentId: identity.documentId, conversation: identity.result };
    });
    assert.equal(selected.conversation, "fixture-alpha");
    const requested = await mcpClient.callTool({ name: "chat_request_connection", arguments: {} });
    assert.equal(requested.isError, undefined);
    const pending = requested.structuredContent;
    const popup = await context.newPage();
    await fixture.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByRole("button", { name: "Review fixture drafts" }).waitFor({ state: "visible", timeout: 4000 });
    const approved = await popup.evaluate(args => chrome.runtime.sendMessage({ kind: "approve_fixture", ...args }),
      { tabId: selected.tabId, expectedUrl: url, pendingRequestId: pending.requestId });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const connected = await mcpClient.callTool({ name: "chat_get_connection", arguments: { requestId: pending.requestId } });
    const connection = connected.structuredContent;
    assert.equal(connection.state, "ready_readonly");
    const preparation = await mcpClient.callTool({ name: "chat_prepare_message", arguments: {
      connectionId: connection.connectionId, expectedGeneration: 1, text: `Synthetic one-shot ${outcome}`,
      idempotencyKey: "a66b3997-9d43-4554-8399-267d1fe9f75c"
    } });
    assert.equal(preparation.isError, undefined);
    const prepared = preparation.structuredContent;
    for (const [purpose, status] of [["reviews", "Approved fixture draft"], ["fill-reviews", "Allowed fixture draft fill"]]) {
      await popup.evaluate(id => document.getElementById(id).click(), `view-fixture-${purpose}`);
      await popup.locator("#fixture-reviews pre").waitFor({ state: "visible", timeout: 4000 });
      assert.equal(await popup.locator("#fixture-reviews pre").textContent(), prepared.preview.text);
      await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
      await popup.getByText(`${status} ${prepared.operationId}.`, { exact: false }).waitFor({ state: "visible", timeout: 4000 });
    }
    const filled = await mcpClient.callTool({ name: "chat_fill_draft", arguments: { operationId: prepared.operationId } });
    assert.equal(filled.structuredContent.ok, true);
    const noConsent = await mcpClient.callTool({ name: "chat_commit_message", arguments: { operationId: prepared.operationId } });
    assert.equal(noConsent.isError, true);
    assert.deepEqual(noConsent.structuredContent, { operationId: prepared.operationId, ok: false,
      code: "DISPATCH_UNAVAILABLE", retryAllowed: false });
    await popup.evaluate(() => document.getElementById("view-fixture-send-reviews").click());
    await popup.locator("#fixture-reviews pre").waitFor({ state: "visible", timeout: 4000 });
    assert.equal(await popup.locator("#fixture-reviews pre").textContent(), prepared.preview.text);
    await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
    await popup.getByText(`Approved fixture send ${prepared.operationId}. No message was sent.`)
      .waitFor({ state: "visible", timeout: 4000 });
    assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 0);
    if (outcome === "lost_script" || outcome === "worker_crash" || outcome === "broker_crash") {
      await worker.evaluate(({ operationId, hold }) => {
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        chrome.scripting.executeScript = async options => {
          const result = await execute(options);
          if (options.args?.[0]?.attemptId === operationId) {
            if (hold) return new Promise(() => {});
            throw new Error("Synthetic lost submit script result");
          }
          return result;
        };
      }, { operationId: prepared.operationId, hold: outcome !== "lost_script" });
    }
    if (outcome === "lost_native_completion") {
      await worker.evaluate(() => {
        const connect = chrome.runtime.connectNative.bind(chrome.runtime);
        chrome.runtime.connectNative = (...args) => {
          const port = connect(...args);
          const post = port.postMessage.bind(port);
          port.postMessage = message => {
            if (message.kind === "complete_fixture_dispatch") { globalThis.fixtureDroppedCompletion = true; return; }
            post(message);
          };
          return port;
        };
      });
    }
    if (outcome === "blocked_after_reservation") {
      await worker.evaluate(({ tabId, documentId }) => {
        const set = chrome.storage.local.set.bind(chrome.storage.local);
        chrome.storage.local.set = async items => {
          await set(items);
          await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] },
            func: () => { document.querySelector("button[type=submit]").disabled = true; } });
        };
      }, selected);
    }
    const dispatching = mcpClient.callTool({ name: "chat_commit_message", arguments: { operationId: prepared.operationId } })
      .then(reply => ({ reply }), error => ({ error }));
    if (outcome !== "blocked_after_reservation") {
      await fixture.waitForFunction(() => globalThis.fixtureSubmitCount === 1, null, { timeout: 4000 });
    }
    if (outcome === "worker_crash") {
      const manager = await context.newPage();
      await manager.goto("chrome://extensions/");
      const session = await context.newCDPSession(manager);
      let confirmStopped;
      const stopped = new Promise(resolve => { confirmStopped = resolve; });
      const version = new Promise(resolve => session.on("ServiceWorker.workerVersionUpdated", event => {
        const match = event.versions.find(entry => entry.scriptURL === worker.url());
        if (match) resolve(match.versionId);
        if (match?.runningStatus === "stopped") confirmStopped();
      }));
      await session.send("ServiceWorker.enable");
      const versionId = await Promise.race([version, setTimeout(3000).then(() => { throw new Error("Submit worker version not found"); })]);
      await session.send("ServiceWorker.stopWorker", { versionId });
      await Promise.race([stopped, setTimeout(5000).then(() => { throw new Error("Submit worker did not stop"); })]);
      await session.detach();
      await manager.close();
    }
    if (outcome === "broker_crash") {
      const previousKey = await readFile(join(directory, "facade.key"), "utf8");
      broker.kill("SIGKILL");
      await brokerExit;
      const crashed = await dispatching;
      assert.equal(crashed.reply?.isError, true);
      assert.deepEqual(crashed.reply.structuredContent, { operationId: prepared.operationId, ok: false,
        code: "DISPATCH_UNCERTAIN", retryAllowed: false, state: "dispatch_uncertain" });
      facade.close();
      relay.close();
      broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
      brokerExit = once(broker, "exit");
      let recovered = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          recovered = await readFile(join(directory, "facade.key"), "utf8") !== previousKey
            && await brokerSocketReady(join(directory, "broker.sock"));
          if (recovered) break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await setTimeout(25);
      }
      assert.equal(recovered, true, "Crashed broker did not recover with new private credentials");
      facade = await connectBroker("facade", directory);
      relay = await connectBroker("relay", directory);
      assert.deepEqual((await facade.getConnection(pending.requestId)).payload, { state: "unknown" });
      assert.equal((await facade.getPreparedOperation(prepared.operationId, prepared.recoveryToken)).payload.state,
        "dispatch_uncertain");
      assert.deepEqual((await facade.commitFixtureMessage(prepared.operationId)).payload,
        { code: "DISPATCH_UNAVAILABLE" });
      assert.deepEqual((await relay.listFixtureDispatchAttempts()).payload, { attempts: [] });
    }
    const settled = await dispatching;
    assert.ok(settled.reply);
    const status = settled.reply.structuredContent;
    assert.equal(status.state, outcome === "observed" ? "observed_in_ui" : "dispatch_uncertain");
    assert.equal(status.ok, outcome === "observed");
    assert.equal(status.retryAllowed, false);
    assert.equal(settled.reply.isError, outcome !== "observed");
    assert.equal(JSON.stringify(settled.reply).includes(prepared.preview.text), false);
    assert.equal(JSON.stringify(settled.reply).includes(prepared.recoveryToken), false);
    assert.equal(JSON.stringify(settled.reply).includes(selected.documentId), false);
    if (outcome !== "broker_crash") {
      assert.deepEqual((await mcpClient.callTool({ name: "chat_commit_message",
        arguments: { operationId: prepared.operationId } })).structuredContent, status);
      assert.deepEqual((await relay.listFixtureDispatchAttempts()).payload, { attempts: [] });
      assert.equal((await facade.getPreparedOperation(prepared.operationId, prepared.recoveryToken)).payload.state, status.state);
    } else {
      const recoveredStatus = await mcpClient.callTool({ name: "chat_get_operation", arguments: {
        operationId: prepared.operationId, recoveryToken: prepared.recoveryToken
      } });
      assert.equal(recoveredStatus.structuredContent.state, "dispatch_uncertain");
      const denied = await mcpClient.callTool({ name: "chat_commit_message", arguments: { operationId: prepared.operationId } });
      assert.deepEqual(denied.structuredContent, { operationId: prepared.operationId, ok: false,
        code: "DISPATCH_UNAVAILABLE", retryAllowed: false });
    }
    if (outcome === "worker_crash") {
      await fixture.bringToFront();
      await popup.evaluate(tabId => chrome.runtime.sendMessage({ kind: "list_fixture_pending", tabId }), selected.tabId);
      worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
      assert.deepEqual((await relay.listFixtureDispatchAttempts()).payload, { attempts: [] });
    }
    assert.equal(await worker.evaluate(async operationId =>
      (await chrome.storage.local.get(`fixture-submit-attempt-${operationId}`))[`fixture-submit-attempt-${operationId}`],
    prepared.operationId), true);
    if (outcome === "lost_native_completion") {
      assert.equal(await worker.evaluate(() => globalThis.fixtureDroppedCompletion), true);
    }
    assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), outcome === "blocked_after_reservation" ? 0 : 1);
    assert.equal(await fixture.locator("ol[role=log] li").count(), outcome === "blocked_after_reservation" ? 2 : 3);
    const { DatabaseSync } = await import("node:sqlite");
    const journal = new DatabaseSync(join(profile, ".config/agent-messaging-mcp/operations.sqlite"), { readOnly: true });
    try {
      assert.equal(journal.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get().count, 1);
      if (outcome === "broker_crash") {
        assert.equal(journal.prepare("SELECT state FROM message_dispatch_attempts").get().state, "unknown");
      }
    } finally { journal.close(); }
  } finally {
    await mcpClient?.close().catch(() => {});
    facade?.close();
    relay?.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

test("private fixture submit activates once and stays uncertain after lost results or changed controls", { timeout: 30000 }, async () => {
  for (const outcome of ["observed", "lost_script", "lost_native_completion", "blocked_after_reservation"]) {
    await exerciseFixtureDispatch(outcome);
  }
});

test("worker and broker crashes after fixture activation never restore submit authority", { timeout: 30000 }, async () => {
  for (const outcome of ["worker_crash", "broker_crash"]) await exerciseFixtureDispatch(outcome);
});

test("test-only Gemini host access carries exact synthetic rows and later observations", { timeout: 20000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-gemini-read-test-"));
  const unpacked = join(profile, "unpacked-extension");
  await cp(extensionDirectory, unpacked, { recursive: true });
  const manifestPath = join(unpacked, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["https://gemini.google.com/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const brokerDirectory = join(profile, ".config/agent-messaging-mcp/broker");
  const brokerEntry = fileURLToPath(new URL("../../packages/companion/dist/broker-process.js", import.meta.url));
  let context;
  let broker;
  let brokerExit;
  let facade;
  try {
    context = await chromium.launchPersistentContext(profile, {
      chromiumSandbox: true,
      executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
      args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`]
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    const extensionId = new URL(worker.url()).hostname;
    await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
    broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
    brokerExit = once(broker, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        ready = await brokerSocketReady(join(brokerDirectory, "broker.sock"));
        if (ready) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await setTimeout(25);
    }
    assert.equal(ready, true, "Broker did not start");
    facade = await connectBroker("facade", brokerDirectory);

    const url = "https://gemini.google.com/app/disposable-chat?hl=en";
    const page = await context.newPage();
    await page.route("https://gemini.google.com/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><meta charset="utf-8"><style>
        main, infinite-scroller, user-query, user-query-content, model-response, model-response-content { display:block }
      </style></head><body><main><div contenteditable="true" aria-label="Enter a prompt for Gemini">Private draft</div>
        <infinite-scroller><user-query><user-query-content><p class="query-text-line">Synthetic question</p>
          </user-query-content></user-query><model-response><model-response-content><p>Synthetic answer</p>
          </model-response-content></model-response></infinite-scroller></main>
        <button type="button" class="send-button" aria-label="Send message" onclick="window.controlActivations += 1">Private control text</button>
        <script>window.controlActivations = 0;</script></body></html>`
    }));
    await page.goto(url);
    const selected = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
        func: () => location.href });
      return { tabId: tab.id, documentId: injection.documentId, url: injection.result };
    });
    assert.equal(selected.url, url);
    assert.match(selected.documentId, /^[!-~]{1,128}$/);

    const created = await facade.requestConnection();
    if (created.kind !== "connection_requested") throw new Error("Expected synthetic Gemini request");
    const popup = await context.newPage();
    await page.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const beforeInspection = await page.locator("body").innerHTML();
    await popup.evaluate(() => document.getElementById("inspect").click());
    await popup.locator("#result").waitFor({ state: "visible", timeout: 4000 });
    const controlDiagnostic = await popup.locator("#messages").textContent();
    assert.ok(controlDiagnostic.includes("Send controls"));
    assert.ok(controlDiagnostic.includes("send-message; send-button; button; visible; enabled; no aria-disabled; outside timeline; outside main; no shared editor form"));
    assert.ok(controlDiagnostic.includes("Prompt state"));
    assert.ok(controlDiagnostic.includes("1 prompt matches; nonempty"));
    assert.ok(controlDiagnostic.includes("Nearby prompt controls"));
    assert.ok(controlDiagnostic.includes("None within bounded ancestors"));
    assert.equal(controlDiagnostic.includes("Private control text"), false);
    assert.equal(controlDiagnostic.includes("Private draft"), false);
    assert.equal(await page.locator("body").innerHTML(), beforeInspection);
    assert.equal(await page.evaluate(() => window.controlActivations), 0);
    assert.equal((await facade.getConnection(created.payload.requestId)).payload.state, "pending");
    const approved = await popup.evaluate(({ tabId, expectedUrl, pendingRequestId }) => chrome.runtime.sendMessage({
      kind: "approve_gemini", tabId, expectedUrl, pendingRequestId
    }), { tabId: selected.tabId, expectedUrl: url, pendingRequestId: created.payload.requestId });
    assert.equal(approved?.ok, true, JSON.stringify(approved));
    const state = await facade.getConnection(created.payload.requestId);
    if (state.kind !== "connection_state" || state.payload.state !== "ready_readonly") {
      throw new Error("Expected a seeded Gemini owner handle");
    }
    assert.equal(state.payload.observation.state, "not_observed");
    const prepared = await facade.prepareGeminiMessage(state.payload.connectionId, 1,
      "Synthetic trusted Gemini consent only", "c66b3997-9d43-4554-8399-267d1fe9f75c");
    if (prepared.kind !== "gemini_message_prepared") throw new Error("Expected private Gemini candidate");
    const reviewArgs = { tabId: selected.tabId, expectedUrl: url };
    assert.equal(await popup.locator("#view-fixture-send-reviews").isVisible(), false);
    await popup.evaluate(() => document.getElementById("view-fixture-fill-reviews").click());
    await popup.locator("#fixture-review-result").waitFor({ state: "visible", timeout: 4000 });
    assert.equal(await popup.locator("#fixture-reviews li").count(), 0);
    assert.deepEqual((await facade.fillGeminiDraft(prepared.payload.operationId)).payload, { code: "FILL_UNAVAILABLE" });
    await popup.evaluate(() => {
      window.syntheticOriginalSendMessage = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async function(...args) {
        const reply = await Reflect.apply(window.syntheticOriginalSendMessage, chrome.runtime, args);
        if (args[0]?.kind === "list_gemini_prepared_reviews" && reply?.ok) window.syntheticOrdinaryReply = reply;
        return reply;
      };
    });
    await popup.evaluate(() => document.getElementById("view-fixture-reviews").click());
    await popup.locator("#fixture-reviews li").waitFor({ state: "visible", timeout: 4000 });
    assert.equal(await popup.locator("#fixture-reviews pre").textContent(), prepared.payload.preview.text);
    const ordinary = await popup.evaluate(() => {
      chrome.runtime.sendMessage = window.syntheticOriginalSendMessage;
      return window.syntheticOrdinaryReply;
    });
    assert.equal(ordinary.ok, true);
    await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
    await popup.waitForFunction(() => document.getElementById("status").textContent.startsWith("Approved Gemini draft"),
      undefined, { timeout: 4000 });
    const phaseConfusion = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
      kind: "approve_gemini_fill_review", ...reviewArgs, operationId: prepared.payload.operationId,
      reviewId: ordinary.reviews[0].reviewId
    });
    assert.equal(phaseConfusion.ok, false);
    assert.deepEqual((await facade.fillGeminiDraft(prepared.payload.operationId)).payload, { code: "FILL_UNAVAILABLE" });
    await popup.evaluate(() => document.getElementById("view-fixture-fill-reviews").click());
    await popup.locator("#fixture-reviews li").waitFor({ state: "visible", timeout: 4000 });
    assert.equal(await popup.locator("#fixture-reviews pre").textContent(), prepared.payload.preview.text);
    await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
    await popup.waitForFunction(() => document.getElementById("status").textContent.startsWith("Allowed Gemini draft fill"),
      undefined, { timeout: 4000 });
    assert.equal(await page.locator("[contenteditable]").textContent(), "Private draft");
    assert.equal(await page.evaluate(() => window.controlActivations), 0);
    assert.equal((await facade.getPreparedOperation(prepared.payload.operationId)).payload.draftFill.state, "fill_approved");
    assert.deepEqual((await facade.commitFixtureMessage(prepared.payload.operationId)).payload, { code: "DISPATCH_UNAVAILABLE" });
    const guarded = await facade.prepareGeminiMessage(state.payload.connectionId, 1,
      "Synthetic sender and selection guard", "d66b3997-9d43-4554-8399-267d1fe9f75c");
    if (guarded.kind !== "gemini_message_prepared") throw new Error("Expected guarded synthetic preparation");
    const guardedReviews = await popup.evaluate(args => chrome.runtime.sendMessage({ kind: "list_gemini_prepared_reviews", ...args }), reviewArgs);
    assert.equal(guardedReviews.ok, true);
    const guardedApproval = { kind: "approve_gemini_review", ...reviewArgs,
      operationId: guarded.payload.operationId, reviewId: guardedReviews.reviews[0].reviewId };
    const untrusted = await worker.evaluate(async ({ tabId, documentId, message }) => {
      const [reply] = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] },
        func: async request => { try { return await chrome.runtime.sendMessage(request); } catch { return null; } },
        args: [message] });
      return reply.result;
    }, { tabId: selected.tabId, documentId: selected.documentId, message: guardedApproval });
    assert.notEqual(untrusted?.ok, true);
    for (const message of [
      { ...guardedApproval, expectedUrl: url.replace("hl=en", "hl=fr") },
      { ...guardedApproval, kind: "approve_fixture_review" },
      { ...guardedApproval, kind: "approve_gemini_send_review" },
      { ...guardedApproval, text: "Forged synthetic text" },
      { ...guardedApproval, approved: true }
    ]) {
      const refused = await popup.evaluate(async request => {
        try { return await chrome.runtime.sendMessage(request); } catch { return null; }
      }, message);
      assert.notEqual(refused?.ok, true);
      assert.equal((await facade.getPreparedOperation(guarded.payload.operationId)).payload.state, "awaiting_approval");
    }
    await popup.evaluate(() => document.getElementById("view-fixture-reviews").click());
    await popup.locator("#fixture-reviews li").waitFor({ state: "visible", timeout: 4000 });
    const otherTab = await context.newPage();
    await otherTab.goto("about:blank");
    await popup.locator("#fixture-review-result").waitFor({ state: "hidden", timeout: 4000 });
    assert.equal(await popup.locator("#fixture-reviews li").count(), 0);
    assert.equal((await facade.getPreparedOperation(guarded.payload.operationId)).payload.state, "awaiting_approval");
    await otherTab.close();
    await page.bringToFront();
    assert.equal(await page.locator("[contenteditable]").textContent(), "Private draft");
    assert.equal(await page.evaluate(() => window.controlActivations), 0);
    const read = await facade.readApprovedSnapshot(state.payload.connectionId);
    if (read.kind !== "gemini_snapshot") throw new Error(`Expected a challenged Gemini snapshot, got ${read.kind}`);
    assert.deepEqual(read.payload.messages, [
      { direction: "outgoing", text: "Synthetic question", identityQuality: "uncertain", generationState: "unknown" },
      { direction: "incoming", text: "Synthetic answer", identityQuality: "uncertain", generationState: "unknown" }
    ]);
    assert.equal("url" in read.payload, false);
    assert.equal(JSON.stringify(read.payload).includes("Private draft"), false);
    await page.locator("model-response-content p").evaluate((paragraph) => { paragraph.textContent = ""; });
    let streaming;
    for (let attempt = 0; attempt < 80; attempt++) {
      const next = await facade.readApprovedEvents(state.payload.connectionId, read.payload.cursor, 1);
      assert.equal(next.kind, "gemini_events", "Expected Gemini events during an empty streaming row");
      assert.equal(next.payload.state, "ok", "Expected a valid Gemini cursor during an empty streaming row");
      if (next.payload.events.length) { streaming = next.payload; break; }
      await setTimeout(25);
    }
    assert.ok(streaming, "An empty streaming row did not publish its remaining visible messages");
    assert.deepEqual(streaming.events[0]?.payload.messages, [
      { direction: "outgoing", text: "Synthetic question", identityQuality: "uncertain", generationState: "unknown" }
    ]);
    const whileStreaming = await facade.getConnection(created.payload.requestId);
    assert.equal(whileStreaming.payload.state, "ready_readonly");
    await page.locator("model-response-content p").evaluate((paragraph) => {
      paragraph.textContent = "Later synthetic answer";
    });
    let observed;
    for (let attempt = 0; attempt < 80; attempt++) {
      const next = await facade.readApprovedEvents(state.payload.connectionId, streaming.cursor, 1);
      assert.equal(next.kind, "gemini_events", "Expected Gemini events after a timeline mutation");
      assert.equal(next.payload.state, "ok", "Expected a live Gemini event cursor");
      if (next.payload.events.length) { observed = next.payload; break; }
      await setTimeout(25);
    }
    assert.ok(observed, "Gemini timeline mutation did not reach the owner buffer");
    assert.equal(observed.cursor.sequence, streaming.cursor.sequence + 1);
    assert.deepEqual(observed.events[0]?.payload.messages, [
      { direction: "outgoing", text: "Synthetic question", identityQuality: "uncertain", generationState: "unknown" },
      { direction: "incoming", text: "Later synthetic answer", identityQuality: "uncertain", generationState: "unknown" }
    ]);
    assert.equal(JSON.stringify(observed.events).includes("Private draft"), false);

    const manager = await context.newPage();
    await manager.goto("chrome://extensions/");
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
      throw new Error("Gemini worker version not found");
    })]);
    await serviceWorkers.send("ServiceWorker.stopWorker", { versionId });
    await Promise.race([stopped, setTimeout(5000).then(() => { throw new Error("Gemini worker did not stop"); })]);
    const wake = await context.newPage();
    await wake.goto(`chrome-extension://${extensionId}/popup.html`);
    await wake.evaluate(() => chrome.runtime.sendMessage({ kind: "probe_native_handshake" }));
    let expired = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const old = await facade.readApprovedEvents(state.payload.connectionId, observed.cursor, 1);
      if (old.kind === "gemini_events" && old.payload.state === "expired") { expired = true; break; }
      await setTimeout(50);
    }
    assert.equal(expired, true, "Gemini worker wake did not expire the old event cursor");
    const afterWake = await facade.getConnection(created.payload.requestId);
    if (afterWake.kind !== "connection_state" || afterWake.payload.state !== "ready_readonly") {
      throw new Error("Gemini worker wake revoked its valid owner");
    }
    assert.deepEqual(afterWake.payload.observation, { state: "not_observed", capturedAt: null });
    const refreshed = await facade.readApprovedSnapshot(state.payload.connectionId);
    if (refreshed.kind !== "gemini_snapshot") throw new Error("Expected resnapshot after Gemini worker wake");
    assert.notEqual(refreshed.payload.cursor.epoch, observed.cursor.epoch);
    assert.deepEqual(refreshed.payload.messages, observed.events[0]?.payload.messages);
    await serviceWorkers.detach();

    assert.deepEqual((await facade.disconnectFixture(state.payload.connectionId)).payload, { disconnected: true });
    await popup.waitForFunction(async (tabId) => {
      const key = `gemini-grant-${tabId}`;
      return (await chrome.storage.session.get(key))[key] === undefined;
    }, selected.tabId, { timeout: 4000 });
    assert.equal(page.isClosed(), false);

    const second = await facade.requestConnection();
    if (second.kind !== "connection_requested") throw new Error("Expected another synthetic Gemini request");
    await page.bringToFront();
    const secondApproval = await popup.evaluate(({ tabId, expectedUrl, pendingRequestId }) => chrome.runtime.sendMessage({
      kind: "approve_gemini", tabId, expectedUrl, pendingRequestId
    }), { tabId: selected.tabId, expectedUrl: url, pendingRequestId: second.payload.requestId });
    assert.equal(secondApproval?.ok, true, JSON.stringify(secondApproval));
    await page.locator("main").evaluate((main) => {
      const timeline = main.querySelector("infinite-scroller");
      main.append(timeline.cloneNode(true));
      timeline.querySelector("model-response-content p").textContent = "Synthetic ambiguous timeline";
    });
    let ambiguousRevoked = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const current = await facade.getConnection(second.payload.requestId);
      if (current.payload.state === "stale") { ambiguousRevoked = true; break; }
      await setTimeout(25);
    }
    assert.equal(ambiguousRevoked, true, "Ambiguous Gemini timeline did not revoke its grant");
    await popup.waitForFunction(async (tabId) => {
      const key = `gemini-grant-status-${tabId}`;
      return (await chrome.storage.session.get(key))[key]?.code === "observation_unavailable";
    }, selected.tabId, { timeout: 4000 });
    const status = await popup.evaluate(async (tabId) => {
      const key = `gemini-grant-status-${tabId}`;
      return (await chrome.storage.session.get(key))[key];
    }, selected.tabId);
    assert.deepEqual(Object.keys(status).sort(), ["code", "recordedAt"]);
    assert.equal(Number.isSafeInteger(status.recordedAt), true);
    await page.bringToFront();
    await popup.evaluate(() => document.querySelector("#inspect").click());
    await popup.getByText("Last read-only grant", { exact: true }).waitFor({ timeout: 4000 });
    const diagnostic = await popup.locator("#messages li").filter({ hasText: "Last read-only grant" }).innerText();
    assert.match(diagnostic, /Observation unavailable; grant revoked/);
    assert.equal(diagnostic.includes("https://"), false);
    assert.equal(diagnostic.includes("Synthetic ambiguous timeline"), false);
  } finally {
    facade?.close();
    await context?.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    await rm(profile, { recursive: true, force: true });
  }
});