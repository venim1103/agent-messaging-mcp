import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
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
import { createNativeRequestChannel } from "../../packages/extension/lib/native-channel.ts";

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

function trackTestPhase(testContext, label) {
  const started = performance.now();
  let phase = "preparing";
  testContext?.signal.addEventListener("abort", () => {
    testContext.diagnostic(`${label} at test end: ${phase} (${Math.round(performance.now() - started)} ms)`);
  }, { once: true });
  return next => {
    phase = next;
    testContext?.diagnostic(`${label}: ${phase} (${Math.round(performance.now() - started)} ms)`);
  };
}

async function createNativeWatchHarness(profile, requestKind) {
  const pidPath = join(profile, "native-watch.json");
  const relayPath = join(profile, "native-watch-relay.mjs");
  await writeFile(relayPath, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { NativeFrameDecoder } from ${JSON.stringify(fileURLToPath(new URL("../../packages/companion/dist/native-framing.js", import.meta.url)))};
const relay = spawn(process.execPath, [${JSON.stringify(nativeRelayPath)}, ...process.argv.slice(2)], { stdio: ["pipe", "pipe", "inherit"] });
const decoder = new NativeFrameDecoder();
let marked = false;
process.stdin.on("data", chunk => {
  for (const request of decoder.push(chunk)) {
    if (!marked && request.kind === ${JSON.stringify(requestKind)}) {
      writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ pid: relay.pid, parent: process.pid }), { mode: 0o600 });
      marked = true;
    }
  }
});
process.stdin.pipe(relay.stdin);
relay.stdout.pipe(process.stdout);
relay.once("close", code => process.exit(code ?? 1));
relay.once("error", () => process.exit(1));
process.on("SIGTERM", () => relay.kill("SIGTERM"));
`, { mode: 0o600 });
  return { pidPath, relayPath };
}

async function stopNativeWatch(harness) {
  const watch = JSON.parse(await readFile(harness.pidPath, "utf8"));
  assert.ok(Number.isSafeInteger(watch.pid) && watch.pid > 0);
  assert.ok(Number.isSafeInteger(watch.parent) && watch.parent > 0);
  assert.equal((await stat(`/proc/${watch.pid}`)).uid, process.getuid());
  assert.equal((await readFile(`/proc/${watch.parent}/cmdline`, "utf8")).split("\0").includes(harness.relayPath), true);
  assert.equal((await readFile(`/proc/${watch.pid}/cmdline`, "utf8")).split("\0").includes(nativeRelayPath), true);
  assert.equal(Number((await readFile(`/proc/${watch.pid}/status`, "utf8")).match(/^PPid:\s+(\d+)$/m)?.[1]), watch.parent);
  process.kill(watch.pid, "SIGTERM");
}

function createNativeChannelHarness() {
  const ports = [];
  const request = createNativeRequestChannel(() => {
    const messages = [];
    const listeners = {};
    const port = { messages, listeners, disconnected: false,
      postMessage: message => messages.push(message),
      disconnect() { this.disconnected = true; },
      onMessage: { addListener: listener => { listeners.message = listener; } },
      onDisconnect: { addListener: listener => { listeners.disconnect = listener; } } };
    ports.push(port);
    return port;
  });
  return { ports, request };
}

test("native request channel reuses bounded ports without replay after loss or expiry", async testContext => {
  testContext.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const { ports, request } = createNativeChannelHarness();
  const reply = (port, index, payload = {}) => port.listeners.message({
    ...port.messages[index], kind: "chat_agents", payload
  });
  const first = request("list_chat_agents", {}, Date.now() + 2_000);
  reply(ports[0], 0, { marker: "first" });
  assert.deepEqual((await first).payload, { marker: "first" });
  const second = request("list_chat_agents", {}, Date.now() + 2_000);
  const third = request("list_chat_agents", {}, Date.now() + 2_000);
  assert.equal(ports.length, 1);
  assert.equal(new Set(ports[0].messages.map(message => message.requestId)).size, 3);
  reply(ports[0], 2, { marker: "third" });
  reply(ports[0], 1, { marker: "second" });
  assert.deepEqual((await second).payload, { marker: "second" });
  assert.deepEqual((await third).payload, { marker: "third" });
  testContext.mock.timers.tick(999);
  assert.equal(ports[0].disconnected, false);
  testContext.mock.timers.tick(1);
  assert.equal(ports[0].disconnected, true);

  const pending = Array.from({ length: 16 }, () => request("list_chat_agents", {}, Date.now() + 2_000));
  await assert.rejects(request("list_chat_agents", {}, Date.now() + 2_000), /unavailable/);
  assert.equal(ports.length, 2);
  assert.equal(ports[1].messages.length, 16);
  for (let index = 0; index < 16; index++) reply(ports[1], index);
  await Promise.all(pending);

  const expiring = assert.rejects(request("list_chat_agents", {}, Date.now() + 100), /unavailable/);
  const concurrent = assert.rejects(request("list_chat_agents", {}, Date.now() + 2_000), /unavailable/);
  testContext.mock.timers.tick(100);
  await Promise.all([expiring, concurrent]);
  assert.equal(ports[1].disconnected, true);
  assert.equal(ports.length, 2);
  const afterExpiry = request("list_chat_agents", {}, Date.now() + 2_000);
  assert.equal(ports.length, 3);
  reply(ports[1], 16);
  reply(ports[2], 0);
  await afterExpiry;

  const disconnected = assert.rejects(request("list_chat_agents", {}, Date.now() + 2_000), /unavailable/);
  ports[2].listeners.disconnect();
  await disconnected;
  assert.equal(ports.length, 3);
  await assert.rejects(request("list_chat_agents", {}, Date.now()), /unavailable/);
  await assert.rejects(request("list_chat_agents", {}, Date.now() + 30_001), /unavailable/);
  assert.equal(ports.length, 3);
});

test("native request channel fails closed on malformed replies and startup or post errors", async testContext => {
  testContext.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  for (const mutate of [
    () => null,
    () => [],
    message => ({ ...message, extra: true }),
    message => ({ ...message, requestId: crypto.randomUUID() }),
    message => ({ ...message, protocolVersion: 2 }),
    message => ({ ...message, connectionGeneration: 1 }),
    message => ({ ...message, deadlineMs: message.deadlineMs + 1 }),
    message => ({ ...message, kind: null }),
    message => ({ ...message, payload: null }),
    message => ({ ...message, payload: [] })
  ]) {
    const { request, ports } = createNativeChannelHarness();
    const first = assert.rejects(request("list_chat_agents", {}, Date.now() + 1_000), /unavailable/);
    const second = assert.rejects(request("list_chat_agents", {}, Date.now() + 1_000), /unavailable/);
    ports[0].listeners.message(mutate({ ...ports[0].messages[0], kind: "chat_agents", payload: {} }));
    await Promise.all([first, second]);
    assert.equal(ports[0].disconnected, true);
    assert.equal(ports[0].messages.length, 2);
    assert.equal(ports.length, 1);
  }

  const { request, ports } = createNativeChannelHarness();
  const first = request("list_chat_agents", {}, Date.now() + 1_000);
  ports[0].listeners.message({ ...ports[0].messages[0], kind: "chat_agents", payload: {} });
  await first;
  let failedPosts = 0;
  ports[0].postMessage = () => { failedPosts++; throw new Error("Synthetic post failure"); };
  await assert.rejects(request("list_chat_agents", {}, Date.now() + 1_000), /unavailable/);
  assert.equal(failedPosts, 1);
  assert.equal(ports[0].disconnected, true);
  testContext.mock.timers.tick(10_000);
  assert.equal(ports.length, 1);

  let connectionAttempts = 0;
  const refused = createNativeRequestChannel(() => { connectionAttempts++; throw new Error("Synthetic connection failure"); });
  await assert.rejects(refused("list_chat_agents", {}, Date.now() + 1_000), /unavailable/);
  assert.equal(connectionAttempts, 1);

  let registrationDisconnects = 0;
  const failedRegistration = createNativeRequestChannel(() => ({
    postMessage() { assert.fail("A request was posted after listener registration failed"); },
    disconnect() { registrationDisconnects++; },
    onMessage: { addListener() { throw new Error("Synthetic listener failure"); } },
    onDisconnect: { addListener() {} }
  }));
  await assert.rejects(failedRegistration("list_chat_agents", {}, Date.now() + 1_000), /unavailable/);
  assert.equal(registrationDisconnects, 1);
});

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

test("trusted fixture popup separates consent from one-shot exact-document draft fill", { timeout: 30000 }, async testContext => {
  const setPhase = trackTestPhase(testContext, "Fixture consent");
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-fixture-review-test-"));
  const nativeWatch = await createNativeWatchHarness(profile, "list_fixture_read_challenges");
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
    await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeWatch.relayPath, profile));
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
    setPhase("late-review boundaries");

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

    setPhase("read-watch recovery");
    const created = await facade.requestConnection();
    if (created.kind !== "connection_requested") throw new Error("Expected fixture request");
    await worker.evaluate(() => {
      const connect = chrome.runtime.connectNative.bind(chrome.runtime);
      globalThis.syntheticFixtureWatches = [];
      chrome.runtime.connectNative = (...args) => {
        const port = connect(...args);
        const post = port.postMessage.bind(port);
        port.postMessage = message => {
          if (message.kind === "list_fixture_read_challenges"
            && !globalThis.syntheticFixtureWatches.includes(port)) globalThis.syntheticFixtureWatches.push(port);
          post(message);
        };
        return port;
      };
    });
    const approved = await popup.evaluate(({ tabId, expectedUrl, pendingRequestId }) => chrome.runtime.sendMessage({
      kind: "approve_fixture", tabId, expectedUrl, pendingRequestId
    }), { ...reviewArgs, pendingRequestId: created.payload.requestId });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const connection = await facade.getConnection(created.payload.requestId);
    if (connection.kind !== "connection_state" || connection.payload.state !== "ready_readonly") {
      throw new Error("Expected approved fixture handle");
    }
    const beforeNativeLoss = await facade.readFixtureSnapshot(connection.payload.connectionId);
    assert.equal(beforeNativeLoss.kind, "fixture_snapshot");
    await stopNativeWatch(nativeWatch);
    const afterNativeLoss = await facade.readFixtureSnapshot(connection.payload.connectionId);
    assert.equal(afterNativeLoss.kind, "fixture_snapshot", "Fixture native watch did not recover without reapproval");
    assert.deepEqual(afterNativeLoss.payload.messages, beforeNativeLoss.payload.messages);
    assert.equal(await worker.evaluate(() => globalThis.syntheticFixtureWatches.length), 2);
    await fixture.locator("ol#messages li").first().evaluate(row => {
      globalThis.syntheticMissingParagraph = row.querySelector("p");
      globalThis.syntheticMissingParagraph.remove();
    });
    assert.deepEqual((await facade.readFixtureSnapshot(connection.payload.connectionId)).payload,
      { code: "OBSERVATION_UNAVAILABLE" });
    assert.equal((await facade.getConnection(created.payload.requestId)).payload.state, "ready_readonly");
    await fixture.locator("ol#messages li").first().evaluate(row => row.append(globalThis.syntheticMissingParagraph));
    assert.equal((await facade.readFixtureSnapshot(connection.payload.connectionId)).kind, "fixture_snapshot");
    setPhase("textarea consent and fill");
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
    setPhase("textarea proof boundaries");
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

    const approveReplacementConnection = async (previous, expectedUrl) => {
      assert.equal((await facade.disconnectFixture(previous.payload.connectionId)).payload.disconnected, true);
      const pending = await facade.requestConnection();
      assert.equal(pending.kind, "connection_requested");
      const approved = await popup.evaluate(args => chrome.runtime.sendMessage({ kind: "approve_fixture", ...args }), {
        tabId: selected.tabId, expectedUrl, pendingRequestId: pending.payload.requestId
      });
      assert.equal(approved.ok, true, JSON.stringify(approved));
      const replacement = await facade.getConnection(pending.payload.requestId);
      assert.equal(replacement.kind, "connection_state");
      assert.equal(replacement.payload.state, "ready_readonly");
      assert.notEqual(replacement.payload.connectionId, previous.payload.connectionId);
      return replacement;
    };
    const secondConnection = await approveReplacementConnection(connection, url);
    setPhase("draft and changed-chat refusals");
    assert.equal((await facade.getPreparedOperation(prepared.payload.operationId)).payload.state, "stale");
    const second = await facade.prepareFixtureMessage(secondConnection.payload.connectionId, 1, "Second fixture draft",
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
    const third = await facade.prepareFixtureMessage(secondConnection.payload.connectionId, 1, "Third fixture draft",
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
    setPhase("rich fill and proof");
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
    const lostConnection = await approveReplacementConnection(richConnection, richUrl);
    assert.equal((await facade.getPreparedOperation(richPrepared.payload.operationId)).payload.state, "stale");
    const lostPrepared = await facade.prepareFixtureMessage(lostConnection.payload.connectionId, 1,
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
    setPhase("MCP rich fill");
    assert.equal((await facade.disconnectFixture(lostConnection.payload.connectionId)).payload.disconnected, true);
    assert.equal((await facade.getPreparedOperation(lostPrepared.payload.operationId)).payload.state, "stale");
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

for (const provider of ["fixture", "gemini"]) {
  test(`${provider} trusted popup resolves uncertainty without composer or authority changes`, { timeout: 20000 }, async (testContext) => {
    const profile = await mkdtemp(join(tmpdir(), "agent-messaging-resolution-popup-"));
    const unpacked = join(profile, "unpacked-extension");
    await cp(extensionDirectory, unpacked, { recursive: true });
    const manifestPath = join(unpacked, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = ["http://127.0.0.1:8787/*", "https://gemini.google.com/*"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const directory = join(profile, ".config/agent-messaging-mcp/broker");
    const brokerEntry = fileURLToPath(new URL("../../packages/companion/dist/broker-process.js", import.meta.url));
    let context;
    let broker;
    let brokerExit;
    let journal;
    try {
      testContext.signal.throwIfAborted();
      context = await chromium.launchPersistentContext(profile, { chromiumSandbox: true,
        executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
        args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
      const extensionId = new URL(worker.url()).hostname;
      await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
      broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
      brokerExit = once(broker, "exit");
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        testContext.signal.throwIfAborted();
        ready = await brokerSocketReady(join(directory, "broker.sock"));
        if (ready) break;
        await setTimeout(25);
      }
      assert.equal(ready, true, "Resolution broker did not start");
      const { DatabaseSync } = await import("node:sqlite");
      journal = new DatabaseSync(join(profile, ".config/agent-messaging-mcp/operations.sqlite"));
      const key = journal.prepare("SELECT key FROM message_conversation_key WHERE singleton = 1").get()?.key;
      assert.ok(key instanceof Uint8Array);
      const origin = provider === "fixture" ? "http://127.0.0.1:8787" : "https://gemini.google.com";
      const conversationId = provider === "fixture" ? "fixture-alpha" : "synthetic-resolution";
      const digest = id => createHmac("sha256", key).update(JSON.stringify([origin, id])).digest("hex");
      const operationIds = Array.from({ length: 4 }, () => crypto.randomUUID());
      const startedAt = Date.now() - 5000;
      const prepare = journal.prepare(`INSERT INTO prepared_message_operations
        (operation_id, owner_id, connection_id, idempotency_key, content_digest, target_digest, expires_at, state)
        VALUES (?, 'synthetic-owner', 'synthetic-connection', ?, ?, ?, ?, 'awaiting_approval')`);
      const insert = journal.prepare(`INSERT INTO message_dispatch_attempts (operation_id, started_at, conversation_key, state)
        VALUES (?, ?, ?, 'unknown')`);
      operationIds.forEach((operationId, index) => {
        prepare.run(operationId, crypto.randomUUID(), "0".repeat(64), "1".repeat(64), startedAt);
        insert.run(operationId, index === 3 ? Date.now() + 60000 : startedAt,
          digest(index === 2 ? `${conversationId}-other` : conversationId));
      });
      const page = await context.newPage();
      const url = provider === "fixture" ? `${origin}/` : `${origin}/app/${conversationId}`;
      const html = provider === "fixture" ? await readFile(fileURLToPath(new URL("../fixtures/chat.html", import.meta.url)), "utf8")
        : `<!doctype html><main><infinite-scroller><user-query><user-query-content><p class="query-text-line">Synthetic row</p></user-query-content></user-query>
          <model-response><model-response-content>Synthetic reply</model-response-content></model-response></infinite-scroller>
          <div contenteditable="true" aria-label="Enter a prompt for Gemini"></div><button type="submit" aria-label="Send message">Send</button></main>`;
      await page.route(url, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
      await page.goto(url);
      const editor = page.locator(provider === "fixture" ? "#message" : "[contenteditable]");
      await editor.fill("A person's synthetic unsent draft");
      await page.evaluate(() => {
        globalThis.resolutionEvents = { input: 0, click: 0, submit: 0 };
        for (const kind of Object.keys(globalThis.resolutionEvents)) {
          document.addEventListener(kind, () => globalThis.resolutionEvents[kind]++, true);
        }
      });
      const selected = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return { tabId: tab.id, expectedUrl: tab.url };
      });
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 360, height: 900 });
      await page.bringToFront();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForFunction(() => document.querySelector("#unconfirmed-status")?.textContent === "Not checked",
        undefined, { timeout: 4000 });
      await popup.getByRole("button", { name: "Refresh status", exact: true }).click();
      await popup.waitForFunction(() => document.querySelectorAll("#unconfirmed-list li[data-operation-id]").length === 2,
        undefined, { timeout: 4000 });
      const storageBefore = await worker.evaluate(() => chrome.storage.session.get(null));
      assert.deepEqual(new Set(await popup.locator("#unconfirmed-list li").evaluateAll(rows => rows.map(row => row.dataset.operationId))),
        new Set(operationIds.slice(0, 2)));
      assert.equal(await popup.locator("#unconfirmed-list").evaluate(list => [...list.querySelectorAll("p, time, button")]
        .every(element => element.scrollWidth <= element.clientWidth)), true);
      await popup.locator("main").screenshot({ path: join(tmpdir(), `agent-messaging-${provider}-resolutions.png`) });
      for (const kind of ["list_unconfirmed_dispatches", "resolve_unconfirmed_dispatch"]) {
        const forged = await worker.evaluate(async args => {
          const [reply] = await chrome.scripting.executeScript({ target: { tabId: args.tabId }, args: [args],
            func: args => chrome.runtime.sendMessage(args).catch(() => null) });
          return reply.result ?? null;
        }, { ...selected, kind, ...(kind === "resolve_unconfirmed_dispatch" ? { operationId: operationIds[0], outcome: "sent" } : {}) });
        assert.equal(forged?.ok === true, false);
      }
      assert.equal(journal.prepare("SELECT COUNT(*) AS count FROM message_dispatch_resolutions").get().count, 0);
      for (const [index, label, outcome] of [[0, "Not sent", "not_sent"], [1, "Sent", "sent"]]) {
        await popup.locator(`[data-operation-id="${operationIds[index]}"]`).getByRole("button", { name: label, exact: true }).click();
        await popup.waitForFunction(operationId => !document.querySelector(`[data-operation-id="${operationId}"]`),
          operationIds[index], { timeout: 4000 });
        const resolution = journal.prepare("SELECT outcome, source, resolved_at FROM message_dispatch_resolutions WHERE operation_id = ?").get(operationIds[index]);
        assert.equal(resolution.outcome, outcome);
        assert.equal(resolution.source, "person");
        assert.ok(resolution.resolved_at >= startedAt);
        const replay = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
          ...selected, kind: "resolve_unconfirmed_dispatch", operationId: operationIds[index], outcome });
        assert.equal(replay.ok, true);
        assert.deepEqual(journal.prepare("SELECT outcome, source, resolved_at FROM message_dispatch_resolutions WHERE operation_id = ?").get(operationIds[index]), resolution);
      }
      assert.equal(await popup.locator("#unconfirmed-status").textContent(), "Nothing to resolve");
      const conflict = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
        ...selected, kind: "resolve_unconfirmed_dispatch", operationId: operationIds[0], outcome: "sent" });
      assert.equal(conflict.ok, false);
      const foreign = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
        ...selected, kind: "resolve_unconfirmed_dispatch", operationId: operationIds[2], outcome: "not_sent" });
      assert.equal(foreign.ok, false);
      assert.equal(journal.prepare("SELECT COUNT(*) AS count FROM message_dispatch_resolutions").get().count, 2);
      assert.equal(journal.prepare("SELECT COUNT(*) AS count FROM message_dispatch_attempts").get().count, 4);
      assert.deepEqual(await worker.evaluate(() => chrome.storage.session.get(null)), storageBefore);
      assert.equal(await editor.evaluate(element => element.value ?? element.textContent), "A person's synthetic unsent draft");
      assert.deepEqual(await page.evaluate(() => globalThis.resolutionEvents), { input: 0, click: 0, submit: 0 });
      await worker.evaluate(() => {
        globalThis.malformedResolutionListing = true;
        const connect = chrome.runtime.connectNative.bind(chrome.runtime);
        chrome.runtime.connectNative = (...args) => {
          const port = connect(...args);
          const listen = port.onMessage.addListener.bind(port.onMessage);
          port.onMessage.addListener = listener => listen(reply => {
            if (reply.kind === "unconfirmed_dispatches" && globalThis.holdResolutionListing) {
              globalThis.holdResolutionListing = false;
              globalThis.releaseResolutionListing = () => listener(reply);
            } else listener(reply.kind === "unconfirmed_dispatches" && globalThis.malformedResolutionListing
              ? { ...reply, payload: { ...reply.payload, retryAllowed: true } } : reply);
          });
          return port;
        };
      });
      await popup.getByRole("button", { name: "Refresh status", exact: true }).click();
      await popup.waitForFunction(() => document.querySelector("#unconfirmed-status")?.textContent === "Unavailable",
        undefined, { timeout: 4000 });
      assert.equal(await popup.locator("#unconfirmed-list li").count(), 0);
      assert.equal(await popup.locator("#refresh-unconfirmed").isEnabled(), true);
      await worker.evaluate(() => {
        globalThis.malformedResolutionListing = false;
        globalThis.holdResolutionListing = true;
      });
      await popup.evaluate(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (...args) => {
          const response = send(...args);
          if (args[0]?.kind === "list_unconfirmed_dispatches") globalThis.resolutionListingResponse = response;
          return response;
        };
      });
      await popup.getByRole("button", { name: "Refresh status", exact: true }).click();
      let held = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        testContext.signal.throwIfAborted();
        held = await worker.evaluate(() => typeof globalThis.releaseResolutionListing === "function");
        if (held) break;
        await setTimeout(25);
      }
      assert.equal(held, true, "Resolution listing reply was not held");
      assert.equal(await popup.locator("#refresh-unconfirmed").isDisabled(), true);
      const other = await context.newPage();
      await other.goto("about:blank");
      await other.bringToFront();
      await popup.waitForFunction(() => document.querySelector("#unconfirmed-status")?.textContent === "Unavailable"
        && !document.querySelector("#refresh-unconfirmed")?.disabled, undefined, { timeout: 4000 });
      await worker.evaluate(() => globalThis.releaseResolutionListing());
      assert.equal((await popup.evaluate(() => globalThis.resolutionListingResponse)).ok, false);
      assert.equal(await popup.locator("#unconfirmed-list li").count(), 0);
      assert.equal(await popup.locator("#unconfirmed-status").textContent(), "Unavailable");
      await page.bringToFront();
      await popup.getByRole("button", { name: "Refresh status", exact: true }).click();
      await popup.waitForFunction(() => document.querySelector("#unconfirmed-status")?.textContent === "Nothing to resolve",
        undefined, { timeout: 4000 });
      assert.deepEqual(await worker.evaluate(() => chrome.storage.session.get(null)), storageBefore);
      assert.deepEqual(await page.evaluate(() => globalThis.resolutionEvents), { input: 0, click: 0, submit: 0 });
    } finally {
      journal?.close();
      broker?.kill("SIGTERM");
      if (brokerExit) await brokerExit;
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });

  test(`${provider} popup roster removes one agent and preserves a newer approval`, { timeout: 20000 }, async (testContext) => {
    const profile = await mkdtemp(join(tmpdir(), "agent-messaging-roster-test-"));
    const unpacked = join(profile, "unpacked-extension");
    await cp(extensionDirectory, unpacked, { recursive: true });
    const manifestPath = join(unpacked, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = ["http://127.0.0.1:8787/*", "https://gemini.google.com/*"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const directory = join(profile, ".config/agent-messaging-mcp/broker");
    const brokerEntry = fileURLToPath(new URL("../../packages/companion/dist/broker-process.js", import.meta.url));
    const mcpEntry = fileURLToPath(new URL("../../packages/companion/dist/mcp-stdio.js", import.meta.url));
    const firstLabel = `Synthetic ${"W".repeat(70)}`;
    const secondLabel = "Synthetic host two";
    const clients = [new Client({ name: firstLabel, version: "0.0.1" }), new Client({ name: secondLabel, version: "0.0.1" })];
    let context;
    let broker;
    let brokerExit;
    try {
      testContext.signal.throwIfAborted();
      context = await chromium.launchPersistentContext(profile, { chromiumSandbox: true,
        executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
        args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
      const extensionId = new URL(worker.url()).hostname;
      await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
      broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
      brokerExit = once(broker, "exit");
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        ready = await brokerSocketReady(join(directory, "broker.sock"));
        if (ready) break;
        await setTimeout(25);
      }
      assert.equal(ready, true, "Roster broker did not start");
      const options = { command: process.execPath, args: [mcpEntry],
        env: { ...process.env, HOME: profile, BROWSER_CHAT_AUTO_START_BROKER: "0" } };
      delete options.env.BROWSER_CHAT_AGENT_LABEL;
      await Promise.all(clients.map(client => client.connect(new StdioClientTransport(options))));
      const requested = await Promise.all(clients.map(client => client.callTool({ name: "chat_request_connection", arguments: {} })));
      assert.ok(requested.every(reply => reply.isError === undefined));
      const page = await context.newPage();
      const url = provider === "fixture" ? "http://127.0.0.1:8787/" : "https://gemini.google.com/app/synthetic-roster";
      const html = provider === "fixture" ? await readFile(fileURLToPath(new URL("../fixtures/chat.html", import.meta.url)), "utf8")
        : `<!doctype html><main><infinite-scroller><user-query><user-query-content><p class="query-text-line">Synthetic user row</p></user-query-content></user-query>
          <model-response><model-response-content>Synthetic reply</model-response-content></model-response></infinite-scroller>
          <div contenteditable="true" aria-label="Enter a prompt for Gemini"></div><button type="submit" aria-label="Send message">Send</button></main>`;
      await page.route(url, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
      await page.goto(url);
      const selected = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return { tabId: tab.id, url: tab.url };
      });
      const popup = await context.newPage();
      await page.bringToFront();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      const waitCount = async count => popup.waitForFunction(expected =>
        document.querySelector("#agent-count")?.textContent === `${expected} connected / 2 available`, count, { timeout: 4000 });
      await waitCount(0);
      const approve = async requestId => {
        const result = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
          kind: provider === "fixture" ? "approve_fixture" : "approve_gemini",
          tabId: selected.tabId, expectedUrl: url, pendingRequestId: requestId
        });
        assert.equal(result.ok, true, JSON.stringify(result));
      };
      for (const reply of requested) await approve(reply.structuredContent.requestId);
      await waitCount(2);
      const firstRow = popup.locator("#agent-list li").filter({ hasText: firstLabel });
      const secondRow = popup.locator("#agent-list li").filter({ hasText: secondLabel });
      assert.equal(await firstRow.count(), 1);
      assert.notEqual(await firstRow.getAttribute("data-agent-id"), await secondRow.getAttribute("data-agent-id"));
      assert.equal(await popup.locator("#agent-list").evaluate(list => [...list.querySelectorAll("p, strong")]
        .every(element => element.scrollWidth <= element.clientWidth)), true);
      await popup.locator("main").screenshot({ path: join(tmpdir(), `agent-messaging-${provider}-roster.png`) });
      const connections = await Promise.all(clients.map((client, index) => client.callTool({ name: "chat_get_connection",
        arguments: { requestId: requested[index].structuredContent.requestId } })));
      const snapshots = await Promise.all(clients.map((client, index) => client.callTool({ name: "chat_read_messages",
        arguments: { connectionId: connections[index].structuredContent.connectionId } })));
      assert.ok(snapshots.every(reply => reply.isError === undefined));
      assert.notDeepEqual(snapshots[0].structuredContent.cursor, snapshots[1].structuredContent.cursor);
      const forged = await worker.evaluate(async ({ tabId, expectedUrl }) => {
        const [reply] = await chrome.scripting.executeScript({ target: { tabId }, args: [tabId, expectedUrl],
          func: async (selectedTab, selectedUrl) => chrome.runtime.sendMessage({ kind: "list_chat_agents",
            tabId: selectedTab, expectedUrl: selectedUrl }).catch(() => null) });
        return reply.result ?? null;
      }, { tabId: selected.tabId, expectedUrl: url });
      assert.equal(forged?.ok === true, false);
      await firstRow.getByRole("button", { name: "Remove access" }).click();
      await waitCount(1);
      assert.equal((await clients[0].callTool({ name: "chat_read_messages",
        arguments: { connectionId: connections[0].structuredContent.connectionId } })).isError, true);
      const survivor = await clients[1].callTool({ name: "chat_read_messages",
        arguments: { connectionId: connections[1].structuredContent.connectionId } });
      assert.equal(survivor.isError, undefined);
      assert.deepEqual(survivor.structuredContent.cursor, snapshots[1].structuredContent.cursor);
      const fresh = await clients[0].callTool({ name: "chat_request_connection", arguments: {} });
      assert.equal(fresh.structuredContent.state, "pending");
      await worker.evaluate(() => {
        globalThis.holdNextAgentRemoval = true;
        const connect = chrome.runtime.connectNative.bind(chrome.runtime);
        chrome.runtime.connectNative = (...args) => {
          const port = connect(...args);
          const listen = port.onMessage.addListener.bind(port.onMessage);
          port.onMessage.addListener = listener => listen(reply => {
            if (globalThis.holdNextAgentRemoval && reply.kind === "chat_agent_removed" && reply.payload.remainingAgents === 0) {
              globalThis.holdNextAgentRemoval = false;
              globalThis.releaseAgentRemoval = () => listener(reply);
              globalThis.agentRemovalHeld = true;
            } else listener(reply);
          });
          return port;
        };
      });
      await secondRow.getByRole("button", { name: "Remove access" }).click();
      let held = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        testContext.signal.throwIfAborted();
        held = await worker.evaluate(() => globalThis.agentRemovalHeld === true);
        if (held) break;
        await setTimeout(25);
      }
      assert.equal(held, true, "Last-agent removal reply was not held");
      await approve(fresh.structuredContent.requestId);
      const key = `${provider}-grant-${selected.tabId}`;
      const newRevision = await worker.evaluate(async key => (await chrome.storage.session.get(key))[key].revision, key);
      assert.equal(typeof newRevision, "string");
      await worker.evaluate(() => globalThis.releaseAgentRemoval());
      await waitCount(1);
      assert.equal(await worker.evaluate(async key => (await chrome.storage.session.get(key))[key]?.revision, key), newRevision);
      const reconnected = await clients[0].callTool({ name: "chat_get_connection", arguments: { requestId: fresh.structuredContent.requestId } });
      assert.equal((await clients[0].callTool({ name: "chat_read_messages",
        arguments: { connectionId: reconnected.structuredContent.connectionId } })).isError, undefined);
      const otherFresh = await clients[1].callTool({ name: "chat_request_connection", arguments: {} });
      await approve(otherFresh.structuredContent.requestId);
      await waitCount(2);
      await worker.evaluate(key => {
        const remove = chrome.storage.session.remove.bind(chrome.storage.session);
        chrome.storage.session.remove = keys => {
          if (keys === key && !globalThis.agentStorageRemovalHeld) {
            globalThis.agentStorageRemovalHeld = true;
            return new Promise((resolve, reject) => {
              globalThis.releaseAgentStorageRemoval = () => remove(keys).then(resolve, reject);
            });
          }
          return remove(keys);
        };
      }, key);
      await popup.getByRole("button", { name: "Disconnect all" }).click();
      let storageHeld = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        testContext.signal.throwIfAborted();
        storageHeld = await worker.evaluate(() => globalThis.agentStorageRemovalHeld === true);
        if (storageHeld) break;
        await setTimeout(25);
      }
      assert.equal(storageHeld, true, "Grant deletion was not held");
      const newest = await clients[0].callTool({ name: "chat_request_connection", arguments: {} });
      const approving = approve(newest.structuredContent.requestId);
      let newestConnection;
      for (let attempt = 0; attempt < 80; attempt++) {
        testContext.signal.throwIfAborted();
        const result = await clients[0].callTool({ name: "chat_get_connection", arguments: { requestId: newest.structuredContent.requestId } });
        if (result.structuredContent.state === "ready_readonly") { newestConnection = result.structuredContent; break; }
        await setTimeout(25);
      }
      assert.ok(newestConnection, "New approval did not reach the broker while deletion was held");
      await worker.evaluate(() => globalThis.releaseAgentStorageRemoval());
      await approving;
      await waitCount(1);
      assert.equal(typeof await worker.evaluate(async key => (await chrome.storage.session.get(key))[key]?.revision, key), "string");
      assert.equal((await clients[0].callTool({ name: "chat_read_messages",
        arguments: { connectionId: newestConnection.connectionId } })).isError, undefined);
      await popup.getByRole("button", { name: "Disconnect all" }).click();
      await waitCount(0);
      assert.equal(await worker.evaluate(async key => (await chrome.storage.session.get(key))[key], key), undefined);
      assert.equal((await clients[0].callTool({ name: "chat_read_messages",
        arguments: { connectionId: reconnected.structuredContent.connectionId } })).isError, true);
      assert.equal((await clients[0].callTool({ name: "chat_read_messages",
        arguments: { connectionId: newestConnection.connectionId } })).isError, true);
    } finally {
      await Promise.all(clients.map(client => client.close().catch(() => {})));
      await context?.close();
      broker?.kill("SIGTERM");
      if (brokerExit) await brokerExit;
      await rm(profile, { recursive: true, force: true });
    }
  });
}

for (const { provider, scenario } of ["fixture", "gemini"].flatMap(provider =>
  ["failure", "lifetime", "reload", "reload-failure"].map(scenario => ({ provider, scenario })))) {
  test(`${provider} popup autonomous admission (${scenario}) is per agent and preserves other owners`, { timeout: 20000 }, async (testContext) => {
    const profile = await mkdtemp(join(tmpdir(), "agent-messaging-autonomous-test-"));
    const unpacked = join(profile, "unpacked-extension");
    await cp(extensionDirectory, unpacked, { recursive: true });
    const manifestPath = join(unpacked, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = ["http://127.0.0.1:8787/*", "https://gemini.google.com/*"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const directory = join(profile, ".config/agent-messaging-mcp/broker");
    const brokerEntry = fileURLToPath(new URL("../../packages/companion/dist/broker-process.js", import.meta.url));
    const mcpEntry = fileURLToPath(new URL("../../packages/companion/dist/mcp-stdio.js", import.meta.url));
    const clients = [new Client({ name: "Autonomous one", version: "0.0.1" }), new Client({ name: "Autonomous two", version: "0.0.1" })];
    let context;
    let broker;
    let brokerExit;
    try {
      testContext.signal.throwIfAborted();
      context = await chromium.launchPersistentContext(profile, { chromiumSandbox: true,
        executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
        args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
      const extensionId = new URL(worker.url()).hostname;
      await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
      broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
      brokerExit = once(broker, "exit");
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        ready = await brokerSocketReady(join(directory, "broker.sock"));
        if (ready) break;
        await setTimeout(25);
      }
      assert.equal(ready, true, "Autonomous broker did not start");
      if (scenario === "reload-failure") {
        await worker.evaluate(() => {
          globalThis.syntheticRebindCorruptions = 0;
          const connect = chrome.runtime.connectNative.bind(chrome.runtime);
          chrome.runtime.connectNative = (...args) => {
            const port = connect(...args);
            const listen = port.onMessage.addListener.bind(port.onMessage);
            port.onMessage.addListener = listener => listen(reply => {
              if (reply.kind === "chat_rebound") {
                globalThis.syntheticRebindCorruptions++;
                return listener({ ...reply, payload: { ...reply.payload, renewed: true } });
              }
              listener(reply);
            });
            return port;
          };
        });
      }
      const options = { command: process.execPath, args: [mcpEntry],
        env: { ...process.env, HOME: profile, BROWSER_CHAT_AUTO_START_BROKER: "0" } };
      delete options.env.BROWSER_CHAT_AGENT_LABEL;
      await Promise.all(clients.map(client => client.connect(new StdioClientTransport(options))));
      for (const client of clients) {
        assert.deepEqual((await client.callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
          { connections: [], timedOut: true });
      }
      const page = await context.newPage();
      const url = provider === "fixture" ? "http://127.0.0.1:8787/" : "https://gemini.google.com/app/synthetic-autonomous";
      const html = provider === "fixture" ? await readFile(fileURLToPath(new URL("../fixtures/chat.html", import.meta.url)), "utf8")
        : `<!doctype html><main><infinite-scroller><user-query><user-query-content><p class="query-text-line">Synthetic user row</p></user-query-content></user-query>
          <model-response><model-response-content>Synthetic reply</model-response-content></model-response></infinite-scroller>
          <div contenteditable="true" aria-label="Enter a prompt for Gemini"></div><button type="submit" aria-label="Send message">Send</button></main>`;
      await page.route(url, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
      await page.goto(url);
      const selected = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        globalThis.withheldChatAccess = true;
        chrome.scripting.executeScript = options => globalThis.withheldChatAccess
          ? Promise.reject(new Error("Synthetic withheld host access")) : execute(options);
        return { tabId: tab.id, url: tab.url };
      });
      const popup = await context.newPage();
      await page.bringToFront();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.getByText("2 agents available; chat status unavailable", { exact: true }).waitFor({ timeout: 4000 });
      await worker.evaluate(() => { globalThis.withheldChatAccess = false; });
      await popup.evaluate(() => {
        const request = chrome.permissions.request.bind(chrome.permissions);
        globalThis.agentPermissionRequests = [];
        globalThis.denyNextAgentPermission = true;
        chrome.permissions.request = options => {
          globalThis.agentPermissionRequests.push({ origins: options.origins, gesture: navigator.userActivation.isActive });
          if (globalThis.denyNextAgentPermission) {
            globalThis.denyNextAgentPermission = false;
            return Promise.resolve(false);
          }
          return request(options);
        };
      });
      const row = label => popup.locator("#agent-list li").filter({ hasText: label });
      const waitCount = (count, available = 2) => popup.waitForFunction(({ count, available }) =>
        document.querySelector("#agent-count")?.textContent === `${count} connected / ${available} available`,
      { count, available }, { timeout: 4000 });
      await row("Autonomous one").getByRole("button", { name: "Connect this chat" }).click();
      await popup.getByText("Site access denied; no connection created.", { exact: true }).waitFor({ timeout: 4000 });
      await waitCount(0);
      assert.deepEqual((await clients[0].callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
        { connections: [], timedOut: true });
      const waitStartedAt = performance.now();
      const waiting = clients[0].callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 2000 } })
        .then(reply => ({ reply, elapsedMs: performance.now() - waitStartedAt }));
      await row("Autonomous one").getByRole("button", { name: "Connect this chat" }).click();
      await waitCount(1);
      const boundedWait = await waiting;
      assert.equal(boundedWait.reply.isError, undefined);
      if (boundedWait.reply.structuredContent.timedOut) {
        assert.deepEqual(boundedWait.reply.structuredContent, { connections: [], timedOut: true });
        assert.ok(boundedWait.elapsedMs >= 2000, "Pickup timed out before its requested wait elapsed");
      }
      const firstPickup = await clients[0].callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } });
      assert.equal(firstPickup.isError, undefined);
      assert.equal(firstPickup.structuredContent.connections.length, 1, JSON.stringify(firstPickup.structuredContent));
      const first = firstPickup.structuredContent.connections[0];
      if (!boundedWait.reply.structuredContent.timedOut) {
        assert.deepEqual(boundedWait.reply.structuredContent.connections, [first]);
      }
      assert.equal(first.state, "ready");
      assert.equal(first.expiresAt, null);
      assert.deepEqual(first.capabilities, ["read", "send"]);
      const permissions = await popup.evaluate(() => globalThis.agentPermissionRequests);
      assert.equal(permissions.length, 2);
      assert.ok(permissions.every(request => request.gesture === true
        && JSON.stringify(request.origins) === JSON.stringify([`${new URL(url).origin}/*`])));
      assert.deepEqual((await clients[1].callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
        { connections: [], timedOut: true });
      const key = `${provider}-grant-${selected.tabId}`;
      assert.equal(await worker.evaluate(async key => (await chrome.storage.session.get(key))[key].expiresAt, key), null);
      const firstRead = await clients[0].callTool({ name: "chat_read_messages", arguments: { connectionId: first.connectionId } });
      assert.equal(firstRead.isError, undefined);
      await row("Autonomous two").getByRole("button", { name: "Connect this chat" }).click();
      await waitCount(2);
      const otherPickup = await clients[1].callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } });
      const second = otherPickup.structuredContent.connections[0];
      const otherRead = await clients[1].callTool({ name: "chat_read_messages", arguments: { connectionId: second.connectionId } });
      assert.equal(otherRead.isError, undefined);
      assert.notDeepEqual(otherRead.structuredContent.cursor, firstRead.structuredContent.cursor);
      if (scenario === "failure") {
        await popup.locator("#agent-panel").screenshot({ path: join(tmpdir(), `agent-messaging-${provider}-autonomous.png`) });
      }
      const firstAgentId = await row("Autonomous one").getAttribute("data-agent-id");
      if (scenario === "reload" || scenario === "reload-failure") {
        const originalDocument = await worker.evaluate(async key => (await chrome.storage.session.get(key))[key].documentId, key);
        let oldRead;
        if (scenario !== "reload-failure") {
          await worker.evaluate(documentId => {
            const execute = chrome.scripting.executeScript.bind(chrome.scripting);
            chrome.scripting.executeScript = async options => {
              const result = await execute(options);
              if (options.target.documentIds?.[0] === documentId && options.func.toString().includes("omittedBefore")) {
                chrome.scripting.executeScript = execute;
                return new Promise(resolve => { globalThis.releaseOldCapture = () => resolve(result); });
              }
              return result;
            };
          }, originalDocument);
          oldRead = clients[0].callTool({ name: "chat_read_messages", arguments: { connectionId: first.connectionId } });
          let captureHeld = false;
          for (let attempt = 0; attempt < 80; attempt++) {
            testContext.signal.throwIfAborted();
            captureHeld = await worker.evaluate(() => typeof globalThis.releaseOldCapture === "function");
            if (captureHeld) break;
            await setTimeout(25);
          }
          assert.equal(captureHeld, true, "Old-document capture was not held before reload");
        }
        await page.reload();
        let reloaded = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          testContext.signal.throwIfAborted();
          reloaded = await worker.evaluate(async ({ key, originalDocument, failed }) => {
            const grant = (await chrome.storage.session.get(key))[key];
            return failed ? !grant : grant?.documentId !== originalDocument && grant?.expiresAt === null && !grant.reloadPending;
          }, { key, originalDocument, failed: scenario === "reload-failure" });
          if (reloaded) break;
          await setTimeout(25);
        }
        assert.equal(reloaded, true, "Reload did not settle the tracked grant");
        if (scenario === "reload-failure") {
          assert.equal(await worker.evaluate(() => globalThis.syntheticRebindCorruptions), 1);
          for (const client of clients) {
            assert.deepEqual((await client.callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
              { connections: [], timedOut: true });
          }
          return;
        }
        await worker.evaluate(() => globalThis.releaseOldCapture());
        assert.equal((await oldRead).isError, true, "Old capture must not satisfy a post-reload read");
        for (const [client, connection, before] of [[clients[0], first, firstRead], [clients[1], second, otherRead]]) {
          assert.deepEqual((await client.callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
            { connections: [connection], timedOut: false });
          const after = await client.callTool({ name: "chat_read_messages", arguments: { connectionId: connection.connectionId } });
          assert.equal(after.isError, undefined);
          assert.notEqual(after.structuredContent.cursor.epoch, before.structuredContent.cursor.epoch);
          const gap = await client.callTool({ name: "chat_wait_for_events", arguments: {
            connectionId: connection.connectionId, cursor: before.structuredContent.cursor, timeoutMs: 0
          } });
          assert.deepEqual(gap.structuredContent, { code: "CURSOR_EXPIRED", resnapshot: true });
        }
      }
      for (const extra of [{ approved: true }, { connectionId: first.connectionId }]) {
        assert.equal(await popup.evaluate(args => chrome.runtime.sendMessage(args), {
          kind: "approve_chat_agent", tabId: selected.tabId, expectedUrl: url, agentId: firstAgentId, ...extra
        }), undefined);
      }
      await row("Autonomous one").getByRole("button", { name: "Remove access" }).click();
      await waitCount(1);
      assert.deepEqual((await clients[0].callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
        { connections: [], timedOut: true });
      let later;
      if (scenario === "reload") {
        await page.reload();
        await popup.getByRole("button", { name: "Refresh agents" }).click();
        await waitCount(1);
        assert.deepEqual((await clients[0].callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
          { connections: [], timedOut: true });
        assert.deepEqual((await clients[1].callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
          { connections: [second], timedOut: false });
        await page.route(`${url}?changed`, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
        await page.goto(`${url}?changed`);
      } else if (scenario === "failure") {
        await worker.evaluate(agentId => {
          const connect = chrome.runtime.connectNative.bind(chrome.runtime);
          chrome.runtime.connectNative = (...args) => {
            const port = connect(...args);
            const listen = port.onMessage.addListener.bind(port.onMessage);
            port.onMessage.addListener = listener => listen(reply => listener(reply.kind === "chat_agent_approved" && reply.payload.agentId === agentId
              ? { ...reply, payload: { ...reply.payload, approved: true } } : reply));
            return port;
          };
        }, firstAgentId);
        await row("Autonomous one").getByRole("button", { name: "Connect this chat" }).click();
        await popup.getByText("Agent management invalid, unavailable or selected chat changed", { exact: true }).waitFor({ timeout: 4000 });
        await waitCount(1);
        assert.deepEqual((await clients[0].callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
          { connections: [], timedOut: true });
        assert.deepEqual((await clients[1].callTool({ name: "chat_read_messages", arguments: { connectionId: second.connectionId } })).structuredContent.cursor,
          otherRead.structuredContent.cursor);
      } else {
        await clients[0].close();
        later = new Client({ name: "Autonomous later", version: "0.0.1" });
        clients.push(later);
        await later.connect(new StdioClientTransport(options));
        assert.deepEqual((await later.callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
          { connections: [], timedOut: true });
        await popup.getByRole("button", { name: "Refresh agents" }).click();
        await waitCount(1);
        await row("Autonomous later").getByRole("button", { name: "Connect this chat" }).click();
        await waitCount(2);
        const latePickup = await later.callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } });
        const late = latePickup.structuredContent.connections[0];
        assert.notEqual(late.connectionId, first.connectionId);
      }
      await page.close();
      let ended = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        testContext.signal.throwIfAborted();
        const state = await clients[1].callTool({ name: "chat_get_connection", arguments: { requestId: second.requestId } });
        ended = state.structuredContent.state === "stale";
        if (ended) break;
        await setTimeout(25);
      }
      assert.equal(ended, true, "Closing the tab did not end autonomous access");
      if (later) {
        assert.deepEqual((await later.callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
          { connections: [], timedOut: true });
      }
    } finally {
      await Promise.all(clients.map(client => client.close().catch(() => {})));
      await context?.close();
      broker?.kill("SIGTERM");
      if (brokerExit) await brokerExit;
      await rm(profile, { recursive: true, force: true });
    }
  });
}

async function exerciseChatDispatch(outcome, provider = "fixture", testContext) {
  const setPhase = trackTestPhase(testContext, `${provider} submit ${outcome}`);
  let mcpClient;
  const profile = await mkdtemp(join(tmpdir(), `agent-messaging-${provider}-dispatch-test-`));
  const unpacked = join(profile, "unpacked-extension");
  await cp(extensionDirectory, unpacked, { recursive: true });
  const manifestPath = join(unpacked, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [provider === "gemini" ? "https://gemini.google.com/*" : "http://127.0.0.1:8787/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const directory = join(profile, ".config/agent-messaging-mcp/broker");
  const brokerEntry = fileURLToPath(new URL("../../packages/companion/dist/broker-process.js", import.meta.url));
  let context;
  let broker;
  let brokerExit;
  let facade;
  let relay;
  try {
    let brokerStderr = "";
    const started = performance.now();
    broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: ["ignore", "ignore", "pipe"] });
    broker.stderr.on("data", chunk => { brokerStderr = `${brokerStderr}${chunk}`.slice(0, 1024); });
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
    assert.equal(ready, true, `Broker did not start (${outcome}): ${JSON.stringify({
      elapsedMs: Math.round(performance.now() - started), exitCode: broker.exitCode,
      signalCode: broker.signalCode, stderr: brokerStderr
    })}`);
    setPhase("browser startup");
    context = await chromium.launchPersistentContext(profile, { chromiumSandbox: true,
      executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
      args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    const extensionId = new URL(worker.url()).hostname;
    if (outcome === "lost_native_completion") {
      await worker.evaluate(provider => {
        const connect = chrome.runtime.connectNative.bind(chrome.runtime);
        chrome.runtime.connectNative = (...args) => {
          const port = connect(...args);
          const post = port.postMessage.bind(port);
          port.postMessage = message => {
            if (message.kind === (provider === "gemini" ? "complete_chat_job" : "complete_fixture_dispatch")) {
              globalThis.fixtureDroppedCompletion = true; return;
            }
            post(message);
          };
          return port;
        };
      }, provider);
    }
    await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
    facade = await connectBroker("facade", directory);
    relay = await connectBroker("relay", directory);
    mcpClient = new Client({ name: "fixture-browser-commit-test", version: "0.0.1" });
    const mcpEntry = fileURLToPath(new URL("../../packages/companion/dist/mcp-stdio.js", import.meta.url));
    await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntry],
      env: { ...process.env, HOME: profile } }));
    const fixture = await context.newPage();
    const html = provider === "gemini" ? `<!doctype html><html><head><meta charset="utf-8"><style>
      main, infinite-scroller, user-query, user-query-content { display:block }
      [contenteditable] { min-height:40px; width:480px; border:1px solid black }
      </style></head><body><main><div contenteditable="true" aria-label="Enter a prompt for Gemini"></div>
      <infinite-scroller><user-query><user-query-content><p class="query-text-line">Synthetic existing row</p>
      </user-query-content></user-query></infinite-scroller>
      <button type="submit" aria-label="Send message">Send</button></main><script>
      window.fixtureSubmitCount=0;
      document.querySelector('button').addEventListener('click',()=>{
        window.fixtureSubmitCount++;
        const editor=document.querySelector('[contenteditable]');
        const row=document.createElement('user-query');
        const content=document.createElement('user-query-content');
        const line=document.createElement('p');line.className='query-text-line';line.textContent=editor.innerText;
        content.append(line);row.append(content);document.querySelector('infinite-scroller').append(row);
        editor.textContent='';
      });</script></body></html>` : await readFile(fileURLToPath(new URL("../fixtures/chat.html", import.meta.url)), "utf8");
    await fixture.route(provider === "gemini" ? "https://gemini.google.com/**" : "http://127.0.0.1:8787/**",
      route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
    const rich = outcome === "lost_script" || outcome === "worker_crash";
    const url = provider === "gemini" ? "https://gemini.google.com/app/synthetic-neutral-submit?hl=en"
      : `http://127.0.0.1:8787/${rich ? "?editor=rich" : ""}`;
    await fixture.goto(url);
    if (provider === "fixture") await fixture.evaluate(() => {
      globalThis.fixtureSubmitCount = 0;
      document.querySelector("#composer").addEventListener("submit", () => { globalThis.fixtureSubmitCount++; });
    });
    const selected = await worker.evaluate(async provider => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [identity] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
        func: () => ({ url: location.href, conversation: document.querySelector("main")?.getAttribute("data-conversation-id") }) });
      return { tabId: tab.id, documentId: identity.documentId,
        conversation: provider === "gemini" ? new URL(identity.result.url).pathname.split("/")[2] : identity.result.conversation };
    }, provider);
    assert.equal(selected.conversation, provider === "gemini" ? "synthetic-neutral-submit" : "fixture-alpha");
    const requested = provider === "gemini" ? await facade.requestConnection()
      : await mcpClient.callTool({ name: "chat_request_connection", arguments: {} });
    if (provider === "fixture") assert.equal(requested.isError, undefined);
    else assert.equal(requested.kind, "connection_requested");
    const pending = provider === "gemini" ? requested.payload : requested.structuredContent;
    const popup = await context.newPage();
    await fixture.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByRole("button", { name: provider === "gemini" ? "Review Gemini drafts" : "Review fixture drafts" })
      .waitFor({ state: "visible", timeout: 4000 });
    const approved = await popup.evaluate(args => chrome.runtime.sendMessage(args),
      { kind: provider === "gemini" ? "approve_gemini" : "approve_fixture",
        tabId: selected.tabId, expectedUrl: url, pendingRequestId: pending.requestId });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const connected = provider === "gemini" ? await facade.getConnection(pending.requestId)
      : await mcpClient.callTool({ name: "chat_get_connection", arguments: { requestId: pending.requestId } });
    const connection = provider === "gemini" ? connected.payload : connected.structuredContent;
    assert.equal(connection.state, "ready_readonly");
    setPhase("prepare and fill");
    const preparation = provider === "gemini"
      ? await facade.prepareGeminiMessage(connection.connectionId, 1, `Synthetic one-shot ${outcome}`, "a66b3997-9d43-4554-8399-267d1fe9f75c")
      : await mcpClient.callTool({ name: "chat_prepare_message", arguments: {
      connectionId: connection.connectionId, expectedGeneration: 1, text: `Synthetic one-shot ${outcome}`,
      idempotencyKey: "a66b3997-9d43-4554-8399-267d1fe9f75c"
    } });
    if (provider === "fixture") assert.equal(preparation.isError, undefined);
    else assert.equal(preparation.kind, "gemini_message_prepared");
    const prepared = provider === "gemini" ? preparation.payload : preparation.structuredContent;
    if (provider === "gemini") {
      for (const [list, approve] of [["list_gemini_prepared_reviews", "approve_gemini_review"],
        ["list_gemini_fill_reviews", "approve_gemini_fill_review"]]) {
        const reviews = await popup.evaluate(args => chrome.runtime.sendMessage(args), { kind: list, tabId: selected.tabId, expectedUrl: url });
        assert.equal(reviews.ok, true);
        assert.equal(reviews.reviews[0].preview.text, prepared.preview.text);
        const consent = await popup.evaluate(args => chrome.runtime.sendMessage(args), { kind: approve, tabId: selected.tabId,
          expectedUrl: url, operationId: prepared.operationId, reviewId: reviews.reviews[0].reviewId });
        assert.equal(consent.ok, true);
      }
    } else for (const [purpose, status] of [["reviews", "Approved fixture draft"], ["fill-reviews", "Allowed fixture draft fill"]]) {
      await popup.evaluate(id => document.getElementById(id).click(), `view-fixture-${purpose}`);
      await popup.locator("#fixture-reviews pre").waitFor({ state: "visible", timeout: 4000 });
      assert.equal(await popup.locator("#fixture-reviews pre").textContent(), prepared.preview.text);
      await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
      await popup.getByText(`${status} ${prepared.operationId}.`, { exact: false }).waitFor({ state: "visible", timeout: 4000 });
    }
    const filled = provider === "gemini" ? await facade.fillGeminiDraft(prepared.operationId)
      : await mcpClient.callTool({ name: "chat_fill_draft", arguments: { operationId: prepared.operationId } });
    assert.equal((provider === "gemini" ? filled.payload : filled.structuredContent).ok, true);
    if (provider === "gemini") {
      assert.deepEqual((await facade.commitPreparedMessage(prepared.operationId)).payload, { code: "DISPATCH_UNAVAILABLE" });
      const reviews = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
        kind: "list_gemini_send_reviews", tabId: selected.tabId, expectedUrl: url });
      assert.equal(reviews.ok, true);
      assert.equal(reviews.reviews[0].preview.text, prepared.preview.text);
      const consent = await popup.evaluate(args => chrome.runtime.sendMessage(args), { kind: "approve_gemini_send_review",
        tabId: selected.tabId, expectedUrl: url, operationId: prepared.operationId, reviewId: reviews.reviews[0].reviewId });
      assert.equal(consent.ok, true);
    } else {
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
    }
    assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 0);
    setPhase("proof and submit");
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
    const dispatching = (provider === "gemini" ? facade.commitPreparedMessage(prepared.operationId)
      : mcpClient.callTool({ name: "chat_commit_message", arguments: { operationId: prepared.operationId } }))
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
      if (provider === "gemini") assert.ok(crashed.error);
      else {
        assert.equal(crashed.reply?.isError, true);
        assert.deepEqual(crashed.reply.structuredContent, { operationId: prepared.operationId, ok: false,
          code: "DISPATCH_UNCERTAIN", retryAllowed: false, state: "dispatch_uncertain" });
      }
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
      assert.deepEqual((provider === "gemini" ? await facade.commitPreparedMessage(prepared.operationId)
        : await facade.commitFixtureMessage(prepared.operationId)).payload,
        { code: "DISPATCH_UNAVAILABLE" });
      assert.deepEqual((provider === "gemini" ? await relay.listChatJobs("submit", "gemini")
        : await relay.listFixtureDispatchAttempts()).payload, provider === "gemini" ? { jobs: [] } : { attempts: [] });
    }
    const settled = await dispatching;
    setPhase("status and replay");
    if (provider !== "gemini" || outcome !== "broker_crash") assert.ok(settled.reply);
    const status = provider === "gemini" ? outcome === "broker_crash"
      ? (await facade.getPreparedOperation(prepared.operationId, prepared.recoveryToken)).payload : settled.reply.payload
      : settled.reply.structuredContent;
    assert.equal(status.state, outcome === "observed" ? provider === "gemini" ? "resolved" : "observed_in_ui" : "dispatch_uncertain");
    if (provider === "fixture") {
      assert.equal(status.ok, outcome === "observed");
      assert.equal(status.retryAllowed, false);
      assert.equal(settled.reply.isError, outcome !== "observed");
    } else if (outcome === "observed") {
      assert.equal(status.resolution.outcome, "sent");
      assert.equal(status.resolution.source, "page");
    }
    assert.equal(JSON.stringify(status).includes(prepared.preview.text), false);
    assert.equal(JSON.stringify(status).includes(prepared.recoveryToken), false);
    assert.equal(JSON.stringify(status).includes(selected.documentId), false);
    if (outcome !== "broker_crash") {
      const replay = provider === "gemini" ? await facade.commitPreparedMessage(prepared.operationId)
        : await mcpClient.callTool({ name: "chat_commit_message", arguments: { operationId: prepared.operationId } });
      assert.deepEqual(provider === "gemini" ? replay.payload : replay.structuredContent, status);
      assert.deepEqual((provider === "gemini" ? await relay.listChatJobs("submit", "gemini")
        : await relay.listFixtureDispatchAttempts()).payload, provider === "gemini" ? { jobs: [] } : { attempts: [] });
      assert.equal((await facade.getPreparedOperation(prepared.operationId, prepared.recoveryToken)).payload.state, status.state);
    } else if (provider === "fixture") {
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
      assert.deepEqual((provider === "gemini" ? await relay.listChatJobs("submit", "gemini")
        : await relay.listFixtureDispatchAttempts()).payload, provider === "gemini" ? { jobs: [] } : { attempts: [] });
    }
    assert.equal(await worker.evaluate(async ({ operationId, provider }) =>
      (await chrome.storage.local.get(`${provider}-submit-attempt-${operationId}`))[`${provider}-submit-attempt-${operationId}`],
    { operationId: prepared.operationId, provider }), true);
    if (outcome === "lost_native_completion") {
      assert.equal(await worker.evaluate(() => globalThis.fixtureDroppedCompletion), true);
    }
    assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), outcome === "blocked_after_reservation" ? 0 : 1);
    assert.equal(await fixture.locator(provider === "gemini" ? "infinite-scroller user-query" : "ol[role=log] li").count(),
      (provider === "gemini" ? 1 : 2) + (outcome === "blocked_after_reservation" ? 0 : 1));
    const { DatabaseSync } = await import("node:sqlite");
    const journal = new DatabaseSync(join(profile, ".config/agent-messaging-mcp/operations.sqlite"), { readOnly: true });
    try {
      assert.equal(journal.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get().count, 1);
      if (outcome === "broker_crash") {
        assert.equal(journal.prepare("SELECT state FROM message_dispatch_attempts").get().state, "unknown");
      }
    } finally { journal.close(); }
  } finally {
    setPhase("cleanup");
    await mcpClient?.close().catch(() => {});
    facade?.close();
    relay?.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    setPhase("complete");
  }
}

test("private fixture submit activates once and stays uncertain after lost results or changed controls", { timeout: 30000 }, async testContext => {
  for (const outcome of ["observed", "lost_script", "lost_native_completion", "blocked_after_reservation"]) {
    testContext.signal.throwIfAborted();
    await exerciseChatDispatch(outcome, "fixture", testContext);
  }
});

test("worker and broker crashes after fixture activation never restore submit authority", { timeout: 30000 }, async () => {
  for (const outcome of ["worker_crash", "broker_crash"]) await exerciseChatDispatch(outcome);
});

for (const outcome of ["observed", "lost_script", "lost_native_completion", "blocked_after_reservation", "worker_crash", "broker_crash"]) {
  test(`neutral Gemini worker submits once without restoring authority (${outcome})`, { timeout: 25000 }, async testContext => {
    testContext.signal.throwIfAborted();
    await exerciseChatDispatch(outcome, "gemini");
  });
}

for (const outcome of ["observed", "script-result-loss", "completion-request-loss", "worker-stop", "broker-stop"]) {
  test(`connected Gemini worker fills once and never retries lost script or completion results (${outcome})`, { timeout: 25000 }, async (testContext) => {
    let phase = "starting";
    testContext.signal.addEventListener("abort", () => testContext.diagnostic(`Synthetic Gemini phase at test end: ${phase}`), { once: true });
    testContext.signal.throwIfAborted();
    const profile = await mkdtemp(join(tmpdir(), "agent-messaging-gemini-worker-fill-"));
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
    let relay;
    try {
      context = await chromium.launchPersistentContext(profile, {
        chromiumSandbox: true, executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
        args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`]
      });
      let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
      const extensionId = new URL(worker.url()).hostname;
      await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
      broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
      brokerExit = once(broker, "exit");
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        try { if (await brokerSocketReady(join(brokerDirectory, "broker.sock"))) { ready = true; break; } }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await setTimeout(25);
      }
      assert.equal(ready, true, "Broker did not start");
      facade = await connectBroker("facade", brokerDirectory);
      relay = await connectBroker("relay", brokerDirectory);
      const page = await context.newPage();
      const url = "https://gemini.google.com/app/synthetic-worker-fill?hl=en";
      await worker.evaluate(scenario => {
        globalThis.syntheticFillCompletionDrops = 0;
        const connect = chrome.runtime.connectNative.bind(chrome.runtime);
        chrome.runtime.connectNative = (...args) => {
          const port = connect(...args);
          const post = port.postMessage.bind(port);
          port.postMessage = message => {
            if (scenario === "completion-request-loss" && message.kind === "complete_gemini_fill") {
              globalThis.syntheticFillCompletionDrops++;
              return;
            }
            post(message);
          };
          return port;
        };
      }, outcome);
      await page.route("https://gemini.google.com/**", route => route.fulfill({ contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><head><meta charset="utf-8"><style>
          main, infinite-scroller, user-query, user-query-content { display:block }
          [contenteditable] { min-height:40px; width:480px; border:1px solid black }
        </style></head><body><main><div contenteditable="true" aria-label="Enter a prompt for Gemini"></div>
          <infinite-scroller><user-query><user-query-content><p class="query-text-line">Synthetic existing row</p>
          </user-query-content></user-query></infinite-scroller>
          <button type="submit" aria-label="Send message" onclick="window.controlActivations++">Send</button></main>
          <script>window.controlActivations=0;window.inputEvents=[];
          document.querySelector('[contenteditable]').addEventListener('input',event=>window.inputEvents.push(event.isTrusted));</script>
        </body></html>` }));
      await page.goto(url);
      const selected = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const [identity] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.href });
        return { tabId: tab.id, documentId: identity.documentId };
      });
      const popup = await context.newPage();
      await page.bringToFront();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      const pending = await facade.requestConnection();
      if (pending.kind !== "connection_requested") throw new Error("Expected synthetic worker-fill pending request");
      const granted = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
        kind: "approve_gemini", tabId: selected.tabId, expectedUrl: url, pendingRequestId: pending.payload.requestId
      });
      assert.equal(granted?.ok, true);
      const connection = await facade.getConnection(pending.payload.requestId);
      if (connection.kind !== "connection_state" || connection.payload.state !== "ready_readonly") throw new Error("Expected synthetic grant");
      const text = "Synthetic worker fill \u00e9\nSecond line";
      phase = `${outcome}:preparing`;
      const prepared = await facade.prepareGeminiMessage(connection.payload.connectionId, 1, text, crypto.randomUUID());
      if (prepared.kind !== "gemini_message_prepared") throw new Error("Expected private worker-fill preparation");
      const consentReviewIds = [];
      for (const [list, approve] of [["list_gemini_prepared_reviews", "approve_gemini_review"],
        ["list_gemini_fill_reviews", "approve_gemini_fill_review"]]) {
        const reviews = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
          kind: list, tabId: selected.tabId, expectedUrl: url
        });
        assert.equal(reviews.ok, true);
        consentReviewIds.push(reviews.reviews[0].reviewId);
        const approved = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
          kind: approve, tabId: selected.tabId, expectedUrl: url,
          operationId: prepared.payload.operationId, reviewId: reviews.reviews[0].reviewId
        });
        assert.equal(approved.ok, true);
      }
      await worker.evaluate(async ({ scenario, tabId, documentId }) => {
        await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, func: () => {
          globalThis.syntheticNativeInsertCalls = 0;
          const nativeInsert = Document.prototype.execCommand;
          Document.prototype.execCommand = function(command, ...args) {
            if (command === "insertText") globalThis.syntheticNativeInsertCalls++;
            return Reflect.apply(nativeInsert, this, [command, ...args]);
          };
        } });
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        globalThis.syntheticFillExecutions = 0;
        chrome.scripting.executeScript = async details => {
          const results = await execute(details);
          if (details.func.toString().includes("geminiDraftFillAttempts")) {
            globalThis.syntheticFillExecutions++;
            if (scenario === "script-result-loss") return [];
            if (scenario === "worker-stop" || scenario === "broker-stop") {
              return new Promise(resolve => { globalThis.syntheticReleaseFillResults = () => resolve(results); });
            }
          }
          return results;
        };
      }, { scenario: outcome, ...selected });
      const nativeInsertCalls = () => worker.evaluate(async target => {
        const [count] = await chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [target.documentId] },
          func: () => globalThis.syntheticNativeInsertCalls });
        return count.result;
      }, selected);
      const filling = facade.fillGeminiDraft(prepared.payload.operationId);
      const lostBroker = outcome === "broker-stop" ? assert.rejects(filling, /closed|disconnected/i) : undefined;
      if (outcome === "worker-stop" || outcome === "broker-stop") {
        let inputObserved = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          if (await worker.evaluate(() => globalThis.syntheticFillExecutions === 1)) { inputObserved = true; break; }
          await setTimeout(25);
        }
        assert.equal(inputObserved, true, "The real insertion did not reach the controlled result boundary");
        assert.equal(await nativeInsertCalls(), 1);
        assert.equal(await page.locator("[contenteditable]").innerText(), text);
      }
      if (outcome === "worker-stop") {
        const manager = await context.newPage();
        await manager.goto("chrome://extensions/");
        const serviceWorkers = await context.newCDPSession(manager);
        let confirmStopped;
        const stopped = new Promise(resolve => { confirmStopped = resolve; });
        const registered = new Promise(resolve => serviceWorkers.on("ServiceWorker.workerVersionUpdated", event => {
          const version = event.versions.find(entry => entry.scriptURL === worker.url());
          if (version) resolve(version.versionId);
          if (version?.runningStatus === "stopped") confirmStopped();
        }));
        await serviceWorkers.send("ServiceWorker.enable");
        const versionId = await Promise.race([registered, setTimeout(3000).then(() => { throw new Error("Worker version not found"); })]);
        await serviceWorkers.send("ServiceWorker.stopWorker", { versionId });
        await Promise.race([stopped, setTimeout(5000).then(() => { throw new Error("Gemini fill worker did not stop"); })]);
        await page.bringToFront();
        await popup.reload();
        const awake = await popup.evaluate(() => chrome.runtime.sendMessage({ kind: "probe_native_handshake" }));
        assert.equal(awake?.ok, true);
        worker = context.serviceWorkers().find(candidate => candidate.url() === worker.url()) ?? worker;
        await serviceWorkers.detach();
        await manager.close();
      } else if (outcome === "broker-stop") {
        const previousKey = await readFile(join(brokerDirectory, "facade.key"), "utf8");
        broker.kill("SIGKILL");
        await brokerExit;
        brokerExit = undefined;
        await lostBroker;
        facade.close();
        relay.close();
        broker = spawn(process.execPath, [brokerEntry], { env: { ...process.env, HOME: profile }, stdio: "ignore" });
        brokerExit = once(broker, "exit");
        ready = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          try {
            ready = await readFile(join(brokerDirectory, "facade.key"), "utf8") !== previousKey
              && await brokerSocketReady(join(brokerDirectory, "broker.sock"));
            if (ready) break;
          }
          catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          }
          await setTimeout(25);
        }
        assert.equal(ready, true, "Replacement synthetic broker did not start");
        facade = await connectBroker("facade", brokerDirectory);
        relay = await connectBroker("relay", brokerDirectory);
        await worker.evaluate(() => globalThis.syntheticReleaseFillResults());
      }
      if (!lostBroker) {
        const filled = await filling;
        if (filled.kind !== "gemini_fill") throw new Error("Expected fixed connected fill outcome");
        assert.equal(filled.payload.ok, outcome === "observed", outcome);
        if (!filled.payload.ok) assert.equal(filled.payload.code, "FILL_UNCERTAIN", outcome);
      }
      assert.equal(await page.locator("[contenteditable]").innerText(), text);
      const inputEvents = await page.evaluate(() => window.inputEvents);
      assert.ok(inputEvents.length > 0);
      assert.equal(inputEvents.every(trusted => trusted === true), true);
      assert.equal(await nativeInsertCalls(), 1);
      assert.equal(await page.evaluate(() => window.controlActivations), 0);
      assert.equal(await worker.evaluate(() => globalThis.syntheticFillExecutions ?? 0), outcome === "worker-stop" ? 0 : 1);
      assert.equal(await worker.evaluate(() => globalThis.syntheticFillCompletionDrops ?? 0), outcome === "completion-request-loss" ? 1 : 0);
      assert.deepEqual((await facade.fillGeminiDraft(prepared.payload.operationId)).payload, { code: "FILL_UNAVAILABLE" });
      assert.deepEqual((await relay.listGeminiFillChallenges()).payload, { fills: [] });
      const status = await facade.getPreparedOperation(prepared.payload.operationId);
      phase = `${outcome}:filled`;
      testContext.diagnostic(`Synthetic Gemini fill result reached: ${outcome}`);
      if (outcome === "broker-stop") assert.deepEqual(status.payload, { state: "unknown" });
      else assert.equal(status.payload.draftFill.state, outcome === "observed" ? "filled" : "uncertain");
      if (outcome === "observed") {
        const reviewArgs = { tabId: selected.tabId, expectedUrl: url, operationId: prepared.payload.operationId };
        for (const reviewId of consentReviewIds) {
          const refused = await popup.evaluate(args => chrome.runtime.sendMessage(args), {
            kind: "approve_gemini_send_review", ...reviewArgs, reviewId
          });
          assert.equal(refused.ok, false);
        }
        await popup.evaluate(() => {
          const send = chrome.runtime.sendMessage;
          chrome.runtime.sendMessage = async function(...args) {
            const response = await Reflect.apply(send, chrome.runtime, args);
            if (args[0]?.kind === "list_gemini_send_reviews") window.syntheticGeminiSendReview = response.reviews?.[0];
            return response;
          };
        });
        const showSend = async () => {
          await popup.evaluate(() => document.getElementById("view-fixture-send-reviews").click());
          await popup.locator("#fixture-reviews pre").waitFor({ state: "visible", timeout: 4000 });
          assert.equal(await popup.locator("#fixture-review-heading").textContent(), "Gemini send consent");
          assert.equal(await popup.locator("#fixture-reviews pre").textContent(), text);
          assert.equal(await popup.locator("#fixture-reviews script").count(), 0);
          assert.equal(await popup.getByRole("button", { name: "Approve Gemini send", exact: true }).count(), 1);
          assert.equal(await popup.getByRole("button", { name: "Allow draft fill (no send)", exact: true }).count(), 0);
          return popup.evaluate(() => window.syntheticGeminiSendReview);
        };
        const oldSend = await showSend();
        phase = `${outcome}:first-send-review`;
        const sendReview = await showSend();
        phase = `${outcome}:rotated-send-review`;
        assert.notEqual(sendReview.reviewId, oldSend.reviewId);
        assert.equal(sendReview.operationId, prepared.payload.operationId);
        assert.deepEqual(sendReview.preview, { target: "gemini", text });
        assert.ok(sendReview.expiresAt <= connection.payload.expiresAt);
        const approval = { kind: "approve_gemini_send_review", ...reviewArgs, reviewId: sendReview.reviewId };
        const untrusted = await worker.evaluate(async ({ tabId, documentId, message }) => {
          const [reply] = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] },
            func: async request => { try { return await chrome.runtime.sendMessage(request); } catch { return null; } },
            args: [message] });
          return reply.result;
        }, { ...selected, message: approval });
        assert.notEqual(untrusted?.ok, true);
        for (const message of [{ ...approval, reviewId: oldSend.reviewId },
          { ...approval, expectedUrl: url.replace("hl=en", "hl=fr") },
          { ...approval, kind: "approve_fixture_send_review" }, { ...approval, kind: "approve_gemini_fill_review" },
          { ...approval, approved: true }, { ...approval, text: "Forged synthetic text" }]) {
          const refused = await popup.evaluate(async request => {
            try { return await chrome.runtime.sendMessage(request); } catch { return null; }
          }, message);
          assert.notEqual(refused?.ok, true);
          assert.deepEqual((await facade.getPreparedOperation(prepared.payload.operationId)).payload, status.payload);
        }
        await popup.evaluate(() => document.querySelector("#fixture-reviews button").click());
        phase = `${outcome}:send-approval`;
        await popup.getByText(`Approved Gemini send ${prepared.payload.operationId}. No message was sent.`, { exact: true })
          .waitFor({ state: "visible", timeout: 4000 });
        assert.deepEqual((await facade.getPreparedOperation(prepared.payload.operationId)).payload, status.payload);
        assert.equal((await popup.evaluate(args => chrome.runtime.sendMessage(args), approval)).ok, false);
        assert.deepEqual((await relay.listGeminiDispatchChecks()).payload, { checks: [] });
        testContext.diagnostic("Synthetic Gemini Send consent completed without activation");
        await worker.evaluate(() => {
          globalThis.syntheticGeminiProofMode = "positive";
          globalThis.syntheticGeminiProofExecutions = 0;
          const execute = chrome.scripting.executeScript.bind(chrome.scripting);
          chrome.scripting.executeScript = async details => {
            const result = await execute(details);
            if (details.func.toString().includes(".checkSubmit")) {
              globalThis.syntheticGeminiProofExecutions++;
              if (globalThis.syntheticGeminiProofMode === "result-loss") return [];
              if (globalThis.syntheticGeminiProofMode === "grant-loss") {
                await chrome.storage.session.remove(`gemini-grant-${details.target.tabId}`);
              }
            }
            return result;
          };
        });
        const bodyBeforeProof = await page.locator("body").innerHTML();
        const focusBeforeProof = await page.evaluate(() => document.activeElement.outerHTML);
        phase = `${outcome}:read-only-proof`;
        const proof = await facade.checkGeminiDispatch(prepared.payload.operationId);
        assert.equal(proof.kind, "gemini_dispatch_check");
        assert.equal(proof.payload.ready, true);
        assert.deepEqual((await relay.listGeminiDispatchChecks()).payload, { checks: [] });
        assert.equal(await page.locator("body").innerHTML(), bodyBeforeProof);
        assert.equal(await page.evaluate(() => document.activeElement.outerHTML), focusBeforeProof);
        assert.equal(await worker.evaluate(() => globalThis.syntheticGeminiProofExecutions), 1);
        assert.deepEqual((await facade.checkGeminiDispatch(prepared.payload.operationId)).payload, { code: "DISPATCH_CHECK_UNAVAILABLE" });
        testContext.diagnostic("Synthetic Gemini read-only worker proof completed without activation");
        const proofIds = new Set([proof.payload.checkId]);
        for (const mode of ["changed-draft", "disabled-submit", "result-loss", "grant-loss"]) {
          phase = `${outcome}:proof-${mode}`;
          await page.evaluate(({ mode, text }) => {
            document.querySelector("[contenteditable]").innerText = mode === "changed-draft" ? "Preserve this synthetic changed draft" : text;
            document.querySelector("button").disabled = mode === "disabled-submit";
            const row = document.createElement("model-response");
            const content = document.createElement("model-response-content");
            content.textContent = `Synthetic proof baseline ${mode}`;
            row.append(content);
            document.querySelector("infinite-scroller").append(row);
          }, { mode, text });
          const snapshot = await facade.readApprovedSnapshot(connection.payload.connectionId);
          assert.equal(snapshot.kind, "gemini_snapshot");
          assert.ok(snapshot.payload.messages.some(message => message.text === `Synthetic proof baseline ${mode}`));
          await worker.evaluate(mode => { globalThis.syntheticGeminiProofMode = mode; }, mode);
          const body = await page.locator("body").innerHTML();
          const focused = await page.evaluate(() => document.activeElement.outerHTML);
          const refused = await facade.checkGeminiDispatch(prepared.payload.operationId);
          assert.equal(refused.kind, "gemini_dispatch_check", mode);
          assert.equal(refused.payload.ready, false, mode);
          assert.equal(proofIds.has(refused.payload.checkId), false);
          proofIds.add(refused.payload.checkId);
          assert.equal(await page.locator("body").innerHTML(), body, mode);
          assert.equal(await page.evaluate(() => document.activeElement.outerHTML), focused, mode);
          assert.deepEqual(await page.evaluate(() => window.inputEvents), inputEvents);
          assert.equal(await nativeInsertCalls(), 1);
          assert.equal(await page.evaluate(() => window.controlActivations), 0);
          assert.deepEqual((await relay.listGeminiDispatchChecks()).payload, { checks: [] });
        }
        assert.equal(await worker.evaluate(() => globalThis.syntheticGeminiProofExecutions), 5);
        await page.evaluate(text => { document.querySelector("[contenteditable]").innerText = text; }, text);
        testContext.diagnostic("Synthetic Gemini read-only worker proof refused four unsafe/lost-result boundaries");
      } else {
        const reviews = await relay.listGeminiSendReviews({ origin: "https://gemini.google.com", conversationId: "synthetic-worker-fill",
          url, tabId: selected.tabId, documentId: selected.documentId });
        assert.deepEqual(reviews.payload, { reviews: [], hasMore: false });
      }
      assert.equal(await page.locator("[contenteditable]").innerText(), text);
      assert.deepEqual(await page.evaluate(() => window.inputEvents), inputEvents);
      assert.equal(await nativeInsertCalls(), 1);
      assert.equal(await page.evaluate(() => window.controlActivations), 0);
    } finally {
      phase = `${outcome}:browser-close`;
      facade?.close();
      relay?.close();
      await context?.close();
      phase = `${outcome}:broker-close`;
      broker?.kill();
      if (brokerExit) await brokerExit;
      await rm(profile, { recursive: true, force: true });
      testContext.diagnostic(`Synthetic Gemini scenario cleaned up: ${outcome}`);
    }
    phase = "complete";
  });
}

test("test-only Gemini host access carries exact synthetic rows and later observations", { timeout: 20000 }, async testContext => {
  const setPhase = trackTestPhase(testContext, "Gemini read workflow");
  const profile = await mkdtemp(join(tmpdir(), "agent-messaging-gemini-read-test-"));
  const nativeWatch = await createNativeWatchHarness(profile, "list_gemini_read_challenges");
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
    await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeWatch.relayPath, profile));
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
    await worker.evaluate(() => {
      const connect = chrome.runtime.connectNative.bind(chrome.runtime);
      globalThis.syntheticGeminiWatches = [];
      globalThis.syntheticGeminiFillOffers = [];
      chrome.runtime.connectNative = (...args) => {
        const port = connect(...args);
        const post = port.postMessage.bind(port);
        port.postMessage = message => {
          if (message.kind === "list_gemini_read_challenges"
            && !globalThis.syntheticGeminiWatches.includes(port)) globalThis.syntheticGeminiWatches.push(port);
          post(message);
        };
        port.onMessage.addListener(reply => {
          if (reply.kind === "gemini_fill_challenges") {
            globalThis.syntheticGeminiFillOffers.push(...reply.payload.fills.map(fill => fill.attemptId));
          }
        });
        return port;
      };
    });
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
    setPhase("supervised consent boundaries");
    const reviewArgs = { tabId: selected.tabId, expectedUrl: url };
    assert.equal(await popup.locator("#view-fixture-send-reviews").isVisible(), true);
    assert.equal(await popup.locator("#view-fixture-send-reviews").textContent(), "Review Gemini send consent");
    await popup.evaluate(() => document.getElementById("view-fixture-send-reviews").click());
    await popup.locator("#fixture-review-result").waitFor({ state: "visible", timeout: 4000 });
    assert.equal(await popup.locator("#fixture-reviews li").count(), 0);
    assert.equal(await page.evaluate(() => window.controlActivations), 0);
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
    const refusedFill = await facade.fillGeminiDraft(prepared.payload.operationId);
    assert.equal(refusedFill.kind, "gemini_fill");
    assert.deepEqual(refusedFill.payload.ok ? refusedFill.payload : { ok: refusedFill.payload.ok, code: refusedFill.payload.code },
      { ok: false, code: "DRAFT_PRESENT" });
    assert.equal(await page.locator("[contenteditable]").textContent(), "Private draft");
    assert.equal(await page.evaluate(() => window.controlActivations), 0);
    assert.deepEqual((await facade.fillGeminiDraft(prepared.payload.operationId)).payload, { code: "FILL_UNAVAILABLE" });
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
    assert.equal(await worker.evaluate(() => globalThis.syntheticGeminiWatches.length), 1);
    setPhase("read-watch recovery");
    await stopNativeWatch(nativeWatch);
    const recoveryStarted = performance.now();
    const afterNativeLoss = await facade.readApprovedSnapshot(state.payload.connectionId);
    assert.equal(afterNativeLoss.kind, "gemini_snapshot", `Stopped native watch did not recover without reapproval: ${JSON.stringify({
      elapsedMs: Math.round(performance.now() - recoveryStarted), code: afterNativeLoss.kind === "error" ? afterNativeLoss.payload.code : null,
      watches: await worker.evaluate(() => globalThis.syntheticGeminiWatches.length)
    })}`);
    assert.deepEqual(afterNativeLoss.payload.messages, read.payload.messages);
    assert.equal(await worker.evaluate(() => globalThis.syntheticGeminiWatches.length), 2);
    const fillOffers = await worker.evaluate(() => globalThis.syntheticGeminiFillOffers);
    assert.equal(fillOffers.length, 1, "Read watch restart re-offered a consumed fill job");
    assert.equal(new Set(fillOffers).size, fillOffers.length);
    assert.equal((await facade.getConnection(created.payload.requestId)).payload.state, "ready_readonly");
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
    setPhase("worker wake");
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
    setPhase("read-window and revocation boundaries");
    await page.bringToFront();
    const secondApproval = await popup.evaluate(({ tabId, expectedUrl, pendingRequestId }) => chrome.runtime.sendMessage({
      kind: "approve_gemini", tabId, expectedUrl, pendingRequestId
    }), { tabId: selected.tabId, expectedUrl: url, pendingRequestId: second.payload.requestId });
    assert.equal(secondApproval?.ok, true, JSON.stringify(secondApproval));
    const secondState = await facade.getConnection(second.payload.requestId);
    assert.equal(secondState.payload.state, "ready_readonly");
    await page.locator("model-response-content").evaluate(content => {
      globalThis.syntheticMissingContent = content;
      content.remove();
    });
    assert.deepEqual((await facade.readApprovedSnapshot(secondState.payload.connectionId)).payload,
      { code: "OBSERVATION_UNAVAILABLE" });
    assert.equal((await facade.getConnection(second.payload.requestId)).payload.state, "ready_readonly");
    await page.locator("model-response").evaluate(row => row.append(globalThis.syntheticMissingContent));
    assert.equal((await facade.readApprovedSnapshot(secondState.payload.connectionId)).kind, "gemini_snapshot");
    await page.locator("infinite-scroller").evaluate(timeline => {
      for (let index = 0; index < 33; index++) {
        const row = document.createElement("model-response");
        const content = document.createElement("model-response-content");
        content.textContent = index === 32 ? "x".repeat(16001) : `Synthetic window row ${index}`;
        row.append(content);
        timeline.append(row);
      }
    });
    const windowed = await facade.readApprovedSnapshot(secondState.payload.connectionId);
    assert.equal(windowed.kind, "gemini_snapshot");
    assert.equal(windowed.payload.messages.length, 32);
    assert.equal(windowed.payload.omittedBefore, true);
    assert.equal(windowed.payload.messages.at(-1).truncated, true);
    assert.equal(windowed.payload.messages.at(-1).text, "x".repeat(16000));
    await page.locator("main").evaluate((main) => {
      const timeline = main.querySelector("infinite-scroller");
      main.append(timeline.cloneNode(true));
      timeline.querySelector("model-response-content p").textContent = "Synthetic ambiguous timeline";
    });
    assert.deepEqual((await facade.readApprovedSnapshot(secondState.payload.connectionId)).payload,
      { code: "OBSERVATION_UNAVAILABLE" });
    assert.equal((await facade.getConnection(second.payload.requestId)).payload.state, "ready_readonly");
    await page.evaluate(() => history.replaceState({}, "", "?hl=fr"));
    let targetRevoked = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const current = await facade.getConnection(second.payload.requestId);
      if (current.payload.state === "stale") { targetRevoked = true; break; }
      await setTimeout(25);
    }
    assert.equal(targetRevoked, true, "Changed Gemini URL did not revoke its grant");
    await popup.waitForFunction(async (tabId) => {
      const key = `gemini-grant-status-${tabId}`;
      return (await chrome.storage.session.get(key))[key]?.code === "target_changed";
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
    assert.equal(diagnostic, "Last read-only grant\n\nTarget or document changed/unavailable");
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