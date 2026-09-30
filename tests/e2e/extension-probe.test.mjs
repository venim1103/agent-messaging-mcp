import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

test("worker wake marks a gap; reload, tab close, denied reads, and disconnect revoke grants", { timeout: 30000 }, async () => {
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
    await waitForStale(beforeReload);
    await waitForStale(geminiBeforeReload.payload.requestId);
    const wake = await context.newPage();
    await wake.goto(`chrome-extension://${extensionId}/popup.html`);
    await wake.evaluate(() => chrome.runtime.sendMessage({ kind: "list_fixture_pending", tabId: 1 }));
    const reloadedMarker = await wake.evaluate(async () =>
      (await chrome.storage.session.get("fixture-reset-done"))["fixture-reset-done"]);
    await wake.close();
    assert.equal(reloadedMarker, true);
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

    const geminiTab = await worker.evaluate(() => chrome.tabs.create({ url: "about:blank", active: false }));
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

    const unapprovedTab = await worker.evaluate(() => chrome.tabs.create({ url: "about:blank", active: false }));
    const beforeDeniedRead = await grant(unapprovedTab.id);
    const deniedState = await facade.getConnection(beforeDeniedRead);
    if (deniedState.kind !== "connection_state" || deniedState.payload.state !== "ready_readonly") {
      throw new Error("Expected a seeded read handle");
    }
    await worker.evaluate(({ tabId }) => chrome.storage.session.set({
      [`fixture-grant-${tabId}`]: { documentId: `CHROME-doc_${tabId}`, expiresAt: Date.now() + 30_000 }
    }), { tabId: unapprovedTab.id });
    const unapprovedGeminiTab = await worker.evaluate(() => chrome.tabs.create({ url: "about:blank", active: false }));
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
    const disconnectedTab = await worker.evaluate(() => chrome.tabs.create({ url: "about:blank", active: false }));
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

test("trusted fixture popup reviews prepared text without editing the page", { timeout: 20000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-fixture-review-test-"));
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
  try {
    context = await chromium.launchPersistentContext(profile, {
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
        ready = (await stat(join(brokerDirectory, "broker.sock"))).isSocket();
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
    await popup.getByRole("button", { name: "Review fixture drafts" }).waitFor({ state: "visible" });
    const reviewArgs = { tabId: selected.tabId, expectedUrl: url };
    const before = await popup.evaluate((args) => chrome.runtime.sendMessage({
      kind: "list_fixture_prepared_reviews", ...args
    }), reviewArgs);
    assert.equal(before.ok, false);

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
    await popup.evaluate(() => document.querySelector("#view-fixture-reviews").click());
    await popup.locator("#fixture-reviews pre").waitFor({ state: "visible", timeout: 4000 });
    assert.equal(await popup.locator("#fixture-reviews pre").textContent(), text);
    assert.equal(await popup.locator("#fixture-reviews script").count(), 0);
    assert.equal(await popup.locator("#fixture-reviews button").count(), 0);
    assert.equal(await fixture.locator("#message").inputValue(), "");
    assert.equal(await fixture.locator("ol[role=log] li").count(), 2);

    await fixture.evaluate(() => document.querySelector("main").dataset.conversationId = "fixture-beta");
    await popup.locator("#fixture-review-result").waitFor({ state: "hidden", timeout: 4000 });
    assert.equal(await popup.locator("#fixture-review-result").isHidden(), true);
    assert.equal(await popup.locator("#fixture-reviews pre").count(), 0);
    const afterSwitch = await popup.evaluate((args) => chrome.runtime.sendMessage({
      kind: "list_fixture_prepared_reviews", ...args
    }), reviewArgs);
    assert.equal(afterSwitch.ok, false);
  } finally {
    facade?.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
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
        ready = (await stat(join(brokerDirectory, "broker.sock"))).isSocket();
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
          </model-response-content></model-response></infinite-scroller></main></body></html>`
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
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront();
    const approved = await popup.evaluate(({ tabId, expectedUrl, pendingRequestId }) => chrome.runtime.sendMessage({
      kind: "approve_gemini", tabId, expectedUrl, pendingRequestId
    }), { tabId: selected.tabId, expectedUrl: url, pendingRequestId: created.payload.requestId });
    assert.equal(approved?.ok, true, JSON.stringify(approved));
    const state = await facade.getConnection(created.payload.requestId);
    if (state.kind !== "connection_state" || state.payload.state !== "ready_readonly") {
      throw new Error("Expected a seeded Gemini owner handle");
    }
    assert.equal(state.payload.observation.state, "not_observed");
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
      if (next.kind !== "gemini_events" || next.payload.state !== "ok") {
        throw new Error("Expected a valid Gemini event during an empty streaming row");
      }
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
      if (next.kind !== "gemini_events" || next.payload.state !== "ok") {
        throw new Error("Expected a live Gemini event cursor");
      }
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