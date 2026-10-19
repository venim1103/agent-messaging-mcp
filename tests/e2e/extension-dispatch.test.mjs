import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { fillFixtureDraft, inspectFixturePreflight, submitFixtureDraft } from "../../packages/extension/lib/fixture-observation.ts";
import { fillGeminiDraft, inspectGeminiDraft, submitGeminiDraft } from "../../packages/extension/lib/gemini-observation.ts";
import { extensionDirectory, nativeRelayPath, brokerSocketReady, trackTestPhase, traceBrowserJobs } from "./extension-harness.mjs";

async function exerciseChatDispatch(outcome, provider = "fixture", testContext, autonomous = false) {
  const setPhase = trackTestPhase(testContext, outcome === "expired_read" ? `${provider} read expiry`
    : outcome === "removed_probes" ? `${provider} removed probes` : `${autonomous ? "autonomous " : ""}${provider} submit ${outcome}`);
  const retainedDraft = ["not_sent", "not_sent_changed", "lost_settle", "owned_leftover"].includes(outcome);
  const hiddenSend = outcome === "hidden_send" || outcome === "hidden_send_rich";
  const realVisibility = outcome === "own_window" || outcome === "hidden" || hiddenSend;
  let mcpClient;
  let publicSendCancellation;
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
  let visibilityBrowser;
  let visibilityBrowserExit;
  let visibilityBrowserControl;
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
    if (realVisibility) {
      visibilityBrowser = spawn("/usr/bin/chromium", ["--headless=new", "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", `--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`, "about:blank"],
      { env: { ...process.env, HOME: profile }, stdio: ["ignore", "ignore", "pipe"] });
      visibilityBrowserExit = once(visibilityBrowser, "exit");
      const endpoint = await new Promise((resolve, reject) => {
        const timer = globalThis.setTimeout(() => reject(new Error("Disposable visibility browser did not start")), 5000);
        visibilityBrowser.once("error", error => { clearTimeout(timer); reject(error); });
        visibilityBrowser.once("exit", () => { clearTimeout(timer); reject(new Error("Visibility browser exited during startup")); });
        let output = "";
        visibilityBrowser.stderr.on("data", chunk => {
          output = `${output}${chunk}`.slice(-4096);
          const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
          if (match) { clearTimeout(timer); resolve(match[1]); }
        });
      });
      const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
      visibilityBrowserControl = await browser.newBrowserCDPSession();
      context = browser.contexts()[0];
    } else context = await chromium.launchPersistentContext(profile, { chromiumSandbox: true,
      executablePath: "/usr/bin/chromium", headless: true, env: { ...process.env, HOME: profile },
      args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    const extensionId = new URL(worker.url()).hostname;
    if (autonomous === "public") await traceBrowserJobs(worker);
    if (outcome === "expired_read") await worker.evaluate(() => {
      const connect = chrome.runtime.connectNative.bind(chrome.runtime);
      let confirmPort;
      globalThis.deadlineReadPortReady = new Promise(resolve => { confirmPort = resolve; });
      chrome.runtime.connectNative = (...args) => {
        const port = connect(...args);
        const post = port.postMessage.bind(port);
        port.postMessage = message => {
          if (message.kind === "list_fixture_read_challenges" || message.kind === "list_gemini_read_challenges") {
            globalThis.deadlineReadPort = port;
            confirmPort();
          }
          post(message);
        };
        return port;
      };
    });
    if (outcome === "lost_native_completion" || outcome === "lost_settle") {
      await worker.evaluate(({ provider, autonomous, outcome }) => {
        const connect = chrome.runtime.connectNative.bind(chrome.runtime);
        chrome.runtime.connectNative = (...args) => {
          const port = connect(...args);
          const post = port.postMessage.bind(port);
          port.postMessage = message => {
            if (message.kind === (autonomous || provider === "gemini" ? "complete_chat_job" : "complete_fixture_dispatch")
              && (!autonomous || message.payload?.phase === (outcome === "lost_settle" ? "settle" : "submit"))) {
              globalThis.fixtureDroppedCompletionCount = (globalThis.fixtureDroppedCompletionCount ?? 0) + 1;
              globalThis.fixtureDroppedCompletion = true; return;
            }
            post(message);
          };
          return port;
        };
      }, { provider, autonomous, outcome });
    }
    await registerNative(planNativeRegistration(profile, extensionId, process.execPath, nativeRelayPath, profile));
    facade = await connectBroker("facade", directory, undefined, undefined,
      autonomous === true ? "Synthetic autonomous browser owner" : undefined);
    relay = await connectBroker("relay", directory);
    mcpClient = new Client({ name: autonomous === "public" ? "Synthetic autonomous browser owner" : "fixture-browser-commit-test", version: "0.0.1" });
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
    const rich = outcome === "lost_script" || outcome === "worker_crash" || outcome === "removed_probes" || outcome === "hidden_send_rich";
    const url = provider === "gemini" ? "https://gemini.google.com/app/synthetic-neutral-submit?hl=en"
      : `http://127.0.0.1:8787/${rich ? "?editor=rich" : ""}`;
    await fixture.goto(url);
    if (provider === "fixture") await fixture.evaluate(() => {
      globalThis.fixtureSubmitCount = 0;
      document.querySelector("#composer").addEventListener("submit", () => { globalThis.fixtureSubmitCount++; });
    });
    if (autonomous && outcome === "delayed") await fixture.evaluate(provider => {
      const timeline = document.querySelector(provider === "gemini" ? "infinite-scroller" : "#messages");
      const append = timeline.append.bind(timeline);
      const appendChild = timeline.appendChild.bind(timeline);
      globalThis.fixtureDeferredAppends = 0;
      timeline.append = (...nodes) => {
        globalThis.fixtureDeferredAppends++;
        setTimeout(() => append(...nodes), 150);
      };
      timeline.appendChild = node => {
        globalThis.fixtureDeferredAppends++;
        setTimeout(() => appendChild(node), 150);
        return node;
      };
    }, provider);
    if (autonomous && retainedDraft) await fixture.evaluate(({ provider, outcome }) => {
      const control = document.querySelector(provider === "gemini" ? 'button[type="submit"]' : "#composer");
      control.addEventListener(provider === "gemini" ? "click" : "submit", event => {
        if (outcome === "owned_leftover" && globalThis.fixtureSubmitCount > 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        globalThis.fixtureSubmitCount++;
        if (outcome === "not_sent_changed") document.querySelector(provider === "gemini"
          ? "user-query-content p" : "#messages li p").textContent = "Synthetic changed dispatch baseline";
      }, true);
    }, { provider, outcome });
    const selected = await worker.evaluate(async provider => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [identity] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
        func: () => ({ url: location.href, conversation: document.querySelector("main")?.getAttribute("data-conversation-id") }) });
      return { tabId: tab.id, documentId: identity.documentId,
        conversation: provider === "gemini" ? new URL(identity.result.url).pathname.split("/")[2] : identity.result.conversation };
    }, provider);
    assert.equal(selected.conversation, provider === "gemini" ? "synthetic-neutral-submit" : "fixture-alpha");
    if (autonomous) {
      const popup = await context.newPage();
      await fixture.bringToFront();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      const connect = popup.locator("#agent-list li").filter({ hasText: "Synthetic autonomous browser owner" })
        .getByRole("button", { name: "Connect this chat" });
      await connect.waitFor({ state: "visible", timeout: 4000 });
      assert.equal(await connect.isEnabled(), true);
      await connect.evaluate(button => button.addEventListener("click", event => {
        globalThis.visibilityApprovalGesture = { trusted: event.isTrusted, active: navigator.userActivation.isActive };
      }, { once: true }));
      await connect.press("Enter", { timeout: 4000 });
      assert.deepEqual(await popup.evaluate(() => globalThis.visibilityApprovalGesture), { trusted: true, active: true });
      await popup.waitForFunction(() => document.querySelector("#agent-count")?.textContent?.startsWith("1 connected"), null,
        { timeout: 4000, polling: realVisibility ? 100 : "raf" });
      const pickup = autonomous === "public"
        ? (await mcpClient.callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent
        : (await facade.waitForConnection(0)).payload;
      assert.ok(pickup.connections[0]);
      const connection = pickup.connections[0];
      assert.equal(connection.state, "ready");
      assert.equal(connection.expiresAt, null);
      assert.deepEqual(connection.capabilities, ["read", "send"]);
      if (autonomous === "public") {
        setPhase(outcome === "expired_read" ? "public read expiry" : "public autonomous send");
        assert.match(await popup.locator("#connection-consent").textContent(), /site changes may interrupt access/);
        assert.equal(await popup.locator("#status").textContent(), "Agent connected.");
        if (outcome === "removed_probes") {
          setPhase("removed probe refusal");
          assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "nativeMessaging", "storage"]);
          assert.equal(manifest.optional_permissions?.includes("debugger") ?? false, false);
          assert.equal(await popup.locator("#test-fixture-input, #prepare-gemini-draft, #gemini-draft-review").count(), 0);
          await fixture.bringToFront();
          const editor = fixture.locator(provider === "gemini" ? "[contenteditable]" : "#rich-message");
          const draft = "Synthetic human draft stays untouched by removed probes";
          await editor.fill(draft);
          const before = await fixture.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement?.outerHTML }));
          const replies = await popup.evaluate(async expectedUrl => {
            const tab = (await chrome.tabs.query({})).find(tab => tab.url === expectedUrl);
            if (!tab?.id) throw new Error("Expected synthetic selected chat");
            return [
              await chrome.runtime.sendMessage({ kind: "probe_fixture_input", tabId: tab.id }) ?? null,
              await chrome.runtime.sendMessage({ kind: "prepare_gemini_draft", tabId: tab.id, expectedUrl }) ?? null
            ];
          }, fixture.url());
          assert.deepEqual(replies, [null, null]);
          assert.deepEqual(await fixture.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement?.outerHTML })), before);
          assert.equal(await editor.innerText(), draft);
          assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 0);
          return;
        }
        if (outcome === "expired_read") {
          setPhase("expired queued read");
          await fixture.bringToFront();
          const editor = fixture.locator(provider === "gemini" ? "[contenteditable]" : "#message");
          const draft = "Synthetic human draft must remain through read expiry";
          await editor.fill(draft);
          await worker.evaluate(() => globalThis.deadlineReadPortReady);
          await worker.evaluate(provider => {
            const execute = chrome.scripting.executeScript.bind(chrome.scripting);
            const port = globalThis.deadlineReadPort;
            const post = port.postMessage.bind(port);
            let release;
            const held = new Promise(resolve => { release = resolve; });
            let confirmCapture;
            let confirmChallenge;
            let confirmDrained;
            globalThis.queuedReadCaptureStarted = new Promise(resolve => { confirmCapture = resolve; });
            globalThis.queuedReadChallengeListed = new Promise(resolve => { confirmChallenge = resolve; });
            globalThis.queuedReadDrained = new Promise(resolve => { confirmDrained = resolve; });
            globalThis.queuedReadCaptureCount = 0;
            let released = false;
            const onMessage = reply => {
              if (reply.kind === `${provider}_read_challenges` && reply.payload.challenges.length) {
                globalThis.queuedReadExpiresAt = Math.max(...reply.payload.challenges.map(challenge => challenge.expiresAt));
                confirmChallenge();
              }
            };
            port.onMessage.addListener(onMessage);
            port.postMessage = message => {
              if (released && (provider === "gemini" ? message.kind === "list_gemini_fill_challenges"
                : message.kind === "list_chat_jobs" && message.payload.phase === "fill")) confirmDrained();
              post(message);
            };
            chrome.scripting.executeScript = async details => {
              const source = details.func?.toString() ?? "";
              const snapshot = provider === "gemini" ? source.includes("query-text-line") && source.includes("model-response-content")
                : source.includes("data-message-id") && source.includes("ol#messages[role=log]");
              if (!snapshot) return execute(details);
              globalThis.queuedReadCaptureCount++;
              const result = await execute(details);
              if (globalThis.queuedReadCaptureCount === 1) { confirmCapture(); await held; }
              return result;
            };
            globalThis.releaseQueuedRead = () => { released = true; release(); };
            globalThis.restoreQueuedRead = () => {
              release();
              chrome.scripting.executeScript = execute;
              port.postMessage = post;
              port.onMessage.removeListener(onMessage);
            };
          }, provider);
          await fixture.locator(provider === "gemini" ? "infinite-scroller" : "#messages").evaluate(timeline => {
            const marker = document.createElement("span");
            timeline.append(marker);
            marker.remove();
          });
          await worker.evaluate(() => globalThis.queuedReadCaptureStarted);
          const reading = mcpClient.callTool({ name: "chat_wait_for_reply",
            arguments: { connectionId: connection.connectionId, timeoutMs: 1000 } });
          await worker.evaluate(() => globalThis.queuedReadChallengeListed);
          assert.deepEqual((await reading).structuredContent, { timedOut: true });
          assert.equal(await worker.evaluate(() => globalThis.queuedReadExpiresAt <= Date.now()), true);
          await worker.evaluate(() => globalThis.releaseQueuedRead());
          await worker.evaluate(() => globalThis.queuedReadDrained);
          assert.equal(await worker.evaluate(() => globalThis.queuedReadCaptureCount), 1,
            "An expired queued read invoked another page capture");
          await worker.evaluate(() => globalThis.restoreQueuedRead());
          const fresh = await mcpClient.callTool({ name: "chat_read_messages", arguments: { connectionId: connection.connectionId } });
          assert.equal(fresh.isError, undefined);
          assert.equal(fresh.structuredContent.coverage, "rendered_only");
          assert.equal(await editor.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.innerText), draft);
          assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 0);
          return;
        }
        if (provider === "gemini" && outcome === "observed") {
          await fixture.evaluate(() => {
            const response = document.createElement("model-response");
            response.style.display = "block";
            const content = document.createElement("model-response-content");
            content.textContent = "Synthetic completed baseline reply";
            response.append(content);
            document.querySelector("infinite-scroller").append(response);
            for (const name of ["section", "div"]) {
              const marker = document.createElement(name);
              marker.setAttribute("aria-busy", "false");
              marker.textContent = "Synthetic completion marker";
              response.append(marker);
            }
            const copy = document.createElement("button");
            copy.setAttribute("aria-label", "Copy");
            copy.textContent = "Copy";
            response.append(copy);
          });
          const beforeSend = (await mcpClient.callTool({ name: "chat_read_messages",
            arguments: { connectionId: connection.connectionId } })).structuredContent;
          assert.equal(beforeSend.messages.at(-1).generationState, "complete");
        }
        const argumentsValue = { connectionId: connection.connectionId, text: "Synthetic public autonomous message",
          idempotencyKey: "a66b3997-9d43-4554-8399-267d1fe9f75c" };
        await fixture.bringToFront();
        const hidden = outcome === "hidden";
        const inactive = hidden || hiddenSend;
        let foregroundTabId;
        const hiddenDraft = "Synthetic hidden-tab human draft must remain";
        if (hidden) {
          await fixture.locator(provider === "gemini" ? "[contenteditable]" : "#message").fill(hiddenDraft);
        }
        if (realVisibility) {
          const windows = await worker.evaluate(async ({ tabId, hidden }) => {
            const chat = await chrome.tabs.get(tabId);
            if (hidden) await chrome.tabs.create({ windowId: chat.windowId, url: "about:blank", active: true });
            else await chrome.windows.create({ url: "about:blank", focused: true });
            const current = await chrome.windows.getLastFocused();
            const [selected] = await chrome.tabs.query({ active: true, currentWindow: true });
            return { chatWindowId: chat.windowId, currentWindowId: current.id, selectedTabId: selected.id,
              chatActive: (await chrome.tabs.get(tabId)).active };
          }, { tabId: selected.tabId, hidden: inactive });
          foregroundTabId = windows.selectedTabId;
          assert.equal(windows.chatActive, !inactive);
          assert.notEqual(windows.selectedTabId, selected.tabId);
          if (!inactive) assert.notEqual(windows.currentWindowId, windows.chatWindowId);
          if (inactive) await fixture.waitForFunction(() => document.visibilityState === "hidden", null, { timeout: 4000, polling: 100 });
          assert.equal(await fixture.evaluate(() => document.visibilityState), inactive ? "hidden" : "visible");
        }
        if (hiddenSend) {
          const before = await fixture.evaluate(() => ({ html: document.body.innerHTML, focus: document.activeElement?.outerHTML }));
          const operationId = crypto.randomUUID();
          const input = { expectedUrl: fixture.url(), text: argumentsValue.text, operationId,
            attemptId: crypto.randomUUID(), expiresAt: Date.now() + 4000 };
          const inspected = provider === "gemini"
            ? await fixture.evaluate(inspectGeminiDraft, { ...input, draftMode: "prepared", checkSubmit: true })
            : await fixture.evaluate(inspectFixturePreflight, { ...input, draftState: "prepared" });
          assert.deepEqual(inspected, { ok: false, code: "TARGET_CHANGED" });
          assert.deepEqual(provider === "gemini" ? await fixture.evaluate(fillGeminiDraft, input)
            : await fixture.evaluate(fillFixtureDraft, input), { ok: false, code: "TARGET_CHANGED" });
          assert.deepEqual(provider === "gemini" ? await fixture.evaluate(submitGeminiDraft, { ...input, attemptId: operationId })
            : await fixture.evaluate(submitFixtureDraft, { ...input, attemptId: operationId }), { ok: false, code: "TARGET_CHANGED" });
          assert.deepEqual(await fixture.evaluate(() => ({ html: document.body.innerHTML, focus: document.activeElement?.outerHTML })), before);
        }
        if (["revoked_after_fill", "revoked_after_submit", "cancel_after_fill", "cancel_after_submit"].includes(outcome)) {
          const cancelled = outcome.startsWith("cancel_");
          const afterSubmit = outcome.endsWith("_submit");
          await worker.evaluate(({ afterSubmit, tabId }) => {
            globalThis.revocationBoundaryCount = 0;
            globalThis.revocationBoundaryReached = new Promise(resolve => { globalThis.confirmRevocationBoundary = resolve; });
            const released = new Promise(resolve => { globalThis.releaseRevocationBoundary = resolve; });
            const execute = chrome.scripting.executeScript.bind(chrome.scripting);
            chrome.scripting.executeScript = async details => {
              const result = await execute(details);
              const input = details.args?.[0];
              if (details.target.tabId === tabId && input?.operationId && input.attemptId
                && (input.operationId === input.attemptId) === afterSubmit && result[0]?.result?.ok) {
                globalThis.revocationBoundaryCount++;
                if (globalThis.revocationBoundaryCount === 1) {
                  globalThis.revocationBoundaryOperationId = input.operationId;
                  globalThis.revocationBoundaryExpiresAt = input.expiresAt;
                  globalThis.confirmRevocationBoundary();
                  await released;
                }
              }
              return result;
            };
          }, { afterSubmit, tabId: selected.tabId });
          publicSendCancellation = new AbortController();
          const sending = mcpClient.callTool({ name: "chat_send_message", arguments: argumentsValue }, { signal: publicSendCancellation.signal })
            .then(result => ({ result }), error => ({ error }));
          await worker.evaluate(() => globalThis.revocationBoundaryReached);
          setPhase(afterSubmit ? "revoking after submit activation" : "revoking after fill readback");
          assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), afterSubmit ? 1 : 0);
          let completion;
          if (cancelled) {
            setPhase("same-key duplicate queued before SDK cancellation");
            const duplicate = mcpClient.callTool({ name: "chat_send_message", arguments: argumentsValue })
              .then(result => ({ result }), error => ({ error }));
            await setTimeout(25);
            publicSendCancellation.abort();
            const cancellation = await sending;
            assert.equal(cancellation.error?.name, "SdkError");
            assert.match(cancellation.error.message, /AbortError/);
            completion = await duplicate;
            await popup.getByRole("button", { name: "Refresh agents" }).click({ timeout: 4000 });
          } else {
            await popup.locator("#agent-list li").filter({ hasText: "Synthetic autonomous browser owner" })
              .getByRole("button", { name: "Remove access" }).click({ timeout: 4000 });
          }
          await popup.waitForFunction(() => document.querySelector("#agent-count")?.textContent?.startsWith("0 connected"), null, { timeout: 4000 });
          setPhase("revocation acknowledged before lease expiry");
          assert.equal(await worker.evaluate(() => Date.now() < globalThis.revocationBoundaryExpiresAt), true);
          await worker.evaluate(() => globalThis.releaseRevocationBoundary());
          completion ??= await sending;
          assert.equal(completion.error, undefined);
          const status = completion.result.structuredContent;
          assert.equal(status.state, afterSubmit || cancelled ? "unresolved" : "not_sent");
          assert.equal(status.retryAllowed, false);
          const operationId = await worker.evaluate(() => globalThis.revocationBoundaryOperationId);
          if (cancelled) {
            assert.deepEqual(status, { state: "unresolved", code: "DISPATCH_UNCERTAIN", retryAllowed: false });
            assert.equal((await mcpClient.callTool({ name: "chat_get_operation", arguments: { operationId } })).structuredContent.state, "unknown");
          } else {
            assert.equal(status.operationId, operationId);
            assert.match(status.recoveryToken, /^[0-9a-f]{64}$/);
          }
          assert.equal(await worker.evaluate(() => globalThis.revocationBoundaryCount), 1);
          assert.equal(await worker.evaluate(async ({ provider, tabId }) =>
            Object.hasOwn(await chrome.storage.session.get(`${provider}-grant-${tabId}`), `${provider}-grant-${tabId}`),
          { provider, tabId: selected.tabId }), false);
          assert.deepEqual((await mcpClient.callTool({ name: "chat_wait_for_connection", arguments: { timeoutMs: 0 } })).structuredContent,
            { connections: [], timedOut: true });
          const fresh = await mcpClient.callTool({ name: "chat_send_message", arguments: {
            ...argumentsValue, idempotencyKey: crypto.randomUUID(), text: "Synthetic new send must require fresh approval"
          } });
          assert.deepEqual(fresh.structuredContent, { state: "not_sent", code: "CONNECTION_NOT_FOUND", retryAllowed: false });
          if (!cancelled) assert.equal((await facade.getPreparedOperation(operationId, status.recoveryToken)).payload.state,
            afterSubmit ? "dispatch_uncertain" : "unknown");
          assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), afterSubmit ? 1 : 0);
          assert.equal(await fixture.locator(provider === "gemini" ? "infinite-scroller user-query" : "ol[role=log] li").count(),
            (provider === "gemini" ? 1 : 2) + (afterSubmit ? 1 : 0));
          assert.equal(await fixture.locator(provider === "gemini" ? "[contenteditable]" : "#message").evaluate(editor =>
            editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText), afterSubmit ? "" : argumentsValue.text);
          for (const phase of ["fill", "proof", "submit", "settle"]) assert.deepEqual((await relay.listChatJobs(phase, provider)).payload, { jobs: [] });
          assert.equal(await worker.evaluate(async ({ provider, operationId }) =>
            (await chrome.storage.local.get(`${provider}-submit-attempt-${operationId}`))[`${provider}-submit-attempt-${operationId}`],
          { provider, operationId }), afterSubmit ? true : undefined);
          const { DatabaseSync } = await import("node:sqlite");
          const journal = new DatabaseSync(join(profile, ".config/agent-messaging-mcp/operations.sqlite"), { readOnly: true });
          try {
            assert.equal(journal.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get().count, afterSubmit ? 1 : 0);
            assert.equal(journal.prepare("SELECT count(*) AS count FROM message_dispatch_resolutions").get().count, 0);
          } finally { journal.close(); }
          return;
        }
        const result = await mcpClient.callTool({ name: "chat_send_message", arguments: argumentsValue });
        const status = result.structuredContent;
        if (inactive) {
          assert.equal(await fixture.evaluate(() => document.visibilityState), "hidden");
          assert.deepEqual(await worker.evaluate(async tabId => ({ active: (await chrome.tabs.get(tabId)).active,
            foregroundTabId: (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id }), selected.tabId),
          { active: false, foregroundTabId });
        }
        const expectedState = outcome === "observed" || outcome === "own_window" || hiddenSend ? "sent" : outcome === "lost_settle" ? "unresolved" : "not_sent";
        const sendDiagnostic = result.isError !== (expectedState !== "sent") || status.failureStage
          ? JSON.stringify({ provider, outcome, state: status.state, code: status.code, failureStage: status.failureStage,
            jobs: await worker.evaluate(() => globalThis.browserJobTrace) }) : undefined;
        assert.equal(result.isError, expectedState !== "sent", sendDiagnostic);
        assert.equal(status.state, expectedState, sendDiagnostic);
        if (hiddenSend) {
          const snapshot = await mcpClient.callTool({ name: "chat_read_messages", arguments: { connectionId: connection.connectionId } });
          assert.equal(snapshot.isError, undefined);
          assert.equal(snapshot.structuredContent.messages.at(-1).text, argumentsValue.text);
          assert.equal(await fixture.evaluate(() => document.visibilityState), "hidden");
          assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id), foregroundTabId);
        }
        assert.equal(status.retryAllowed, false);
        if (hidden) assert.equal(status.code, "DISPATCH_UNAVAILABLE");
        assert.match(status.recoveryToken, /^[0-9a-f]{64}$/);
        if (outcome === "not_sent") assert.equal(status.resolution.source, "page");
        if (outcome === "lost_settle") assert.equal(await worker.evaluate(() => globalThis.fixtureDroppedCompletionCount), 1);
        setPhase("public status and replay");
        const replay = await mcpClient.callTool({ name: "chat_send_message", arguments: argumentsValue });
        const { recoveryToken, ...withoutReceipt } = status;
        assert.deepEqual(replay.structuredContent, hidden ? status : withoutReceipt, sendDiagnostic);
        assert.deepEqual((await facade.getPreparedOperation(status.operationId, recoveryToken)).payload.state,
          hidden ? "unknown" : expectedState === "unresolved" ? "dispatch_uncertain"
            : provider === "gemini" || expectedState === "not_sent" ? "resolved" : "observed_in_ui");
        if (hidden) assert.equal((await mcpClient.callTool({ name: "chat_get_operation", arguments: {
          operationId: status.operationId
        } })).structuredContent.state, "prepared");
        const conflict = await mcpClient.callTool({ name: "chat_send_message", arguments: { ...argumentsValue, text: "Synthetic conflicting public text" } });
        assert.equal(conflict.structuredContent.code, "IDEMPOTENCY_CONFLICT");
        assert.equal(conflict.structuredContent.retryAllowed, false);
        assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), hidden ? 0 : 1);
        assert.equal(await fixture.locator(provider === "gemini" ? "infinite-scroller user-query" : "ol[role=log] li").count(),
          (provider === "gemini" ? 1 : 2) + (retainedDraft || hidden ? 0 : 1));
        assert.equal(await fixture.locator(provider === "gemini" ? "[contenteditable]" : "#message").evaluate(editor =>
          editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText), hidden ? hiddenDraft : retainedDraft ? argumentsValue.text : "");
        for (const phase of ["fill", "proof", "submit", "settle"]) assert.deepEqual((await relay.listChatJobs(phase, provider)).payload, { jobs: [] });
        assert.equal(await worker.evaluate(async ({ operationId, provider }) =>
          (await chrome.storage.local.get(`${provider}-submit-attempt-${operationId}`))[`${provider}-submit-attempt-${operationId}`],
        { operationId: status.operationId, provider }), hidden ? undefined : true);
        const checkOwnership = () => worker.evaluate(async ({ selected, operationId, text, url, provider }) => {
          const [result] = await chrome.scripting.executeScript({ target: { tabId: selected.tabId, documentIds: [selected.documentId] },
            func: ({ operationId, text, url, provider }) => globalThis.agentDraftOwnership
              ? { installed: true, owned: globalThis.agentDraftOwnership.matches(operationId, text, url,
                document.querySelector(provider === "gemini" ? "[contenteditable]" : "#message"), document.querySelector("main")) }
              : { installed: false },
            args: [{ operationId, text, url, provider }] });
          return result.result;
        }, { selected, operationId: status.operationId, text: argumentsValue.text, url, provider });
        assert.deepEqual(await checkOwnership(), hidden ? { installed: false } : { installed: true, owned: retainedDraft });
        if (outcome === "not_sent") {
          const editor = fixture.locator(provider === "gemini" ? "[contenteditable]" : "#message");
          await editor.fill("");
          await editor.fill(argumentsValue.text);
          assert.deepEqual(await checkOwnership(), { installed: true, owned: false });
          const refused = await mcpClient.callTool({ name: "chat_send_message", arguments: {
            ...argumentsValue, idempotencyKey: crypto.randomUUID(), text: "Synthetic new message must preserve the retyped draft"
          } });
          assert.equal(refused.structuredContent.state, "not_sent");
          assert.equal(refused.structuredContent.retryAllowed, false);
          assert.equal(await editor.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.innerText), argumentsValue.text);
          assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 1);
        }
        const encoded = JSON.stringify(withoutReceipt);
        for (const privateValue of [argumentsValue.text, recoveryToken, selected.documentId]) assert.equal(encoded.includes(privateValue), false);
        const { DatabaseSync } = await import("node:sqlite");
        const journal = new DatabaseSync(join(profile, ".config/agent-messaging-mcp/operations.sqlite"), { readOnly: true });
        try {
          assert.equal(journal.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get().count, hidden ? 0 : 1);
          if (outcome === "owned_leftover") {
            setPhase("fresh send replacing known own leftover");
            const next = { ...argumentsValue, idempotencyKey: crypto.randomUUID(), text: "Synthetic independently requested next message" };
            const nextResult = await mcpClient.callTool({ name: "chat_send_message", arguments: next });
            assert.equal(nextResult.structuredContent.state, "sent");
            assert.equal(nextResult.structuredContent.retryAllowed, false);
            assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 2);
            assert.equal(await fixture.locator(provider === "gemini" ? "[contenteditable]" : "#message").evaluate(editor =>
              editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText), "");
            const snapshot = await mcpClient.callTool({ name: "chat_read_messages", arguments: { connectionId: connection.connectionId } });
            assert.equal(snapshot.structuredContent.messages.filter(message => message.text === argumentsValue.text).length, 0);
            assert.equal(snapshot.structuredContent.messages.filter(message => message.text === next.text).length, 1);
            assert.equal(journal.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get().count, 2);
            assert.equal((await facade.getPreparedOperation(status.operationId, recoveryToken)).payload.resolution.outcome, "not_sent");
            await mcpClient.callTool({ name: "chat_send_message", arguments: next });
            assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 2);
            assert.equal(journal.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get().count, 2);
          }
        }
        finally { journal.close(); }
        if (outcome === "observed") {
          setPhase("public reply wait and streaming revision");
          assert.deepEqual((await mcpClient.callTool({ name: "chat_wait_for_reply", arguments: {
            connectionId: connection.connectionId, timeoutMs: 150
          } })).structuredContent, { timedOut: true });
          await fixture.evaluate(provider => {
            const row = document.createElement(provider === "gemini" ? "model-response" : "li");
            const content = document.createElement(provider === "gemini" ? "model-response-content" : "p");
            if (provider === "fixture") {
              row.dataset.messageId = "synthetic-streaming-reply";
              row.dataset.direction = "incoming";
            } else row.setAttribute("aria-busy", "true");
            content.textContent = "Synthetic partial reply";
            row.append(content);
            document.querySelector(provider === "gemini" ? "infinite-scroller" : "#messages").append(row);
          }, provider);
          const partial = await mcpClient.callTool({ name: "chat_read_messages", arguments: { connectionId: connection.connectionId } });
          assert.equal(partial.isError, undefined, JSON.stringify(partial));
          assert.equal(partial.structuredContent.messages.at(-1).text, "Synthetic partial reply");
          if (provider === "gemini") {
            assert.equal(partial.structuredContent.messages.at(-1).generationState, "streaming");
            assert.deepEqual((await mcpClient.callTool({ name: "chat_wait_for_reply", arguments: {
              connectionId: connection.connectionId, timeoutMs: 2200
            } })).structuredContent, { timedOut: true });
            await fixture.locator("model-response").last().evaluate(row => row.setAttribute("aria-busy", "false"));
          }
          await fixture.evaluate(provider => {
            globalThis.replyRevisionCount = 0;
            setTimeout(() => {
              document.querySelector(provider === "gemini" ? "model-response:last-child model-response-content" : "#messages li:last-child p")
                .textContent = "Synthetic final reply";
              globalThis.replyRevisionCount++;
              globalThis.replyRevisionAt = performance.now();
            }, 500);
          }, provider);
          const reply = await mcpClient.callTool({ name: "chat_wait_for_reply", arguments: {
            connectionId: connection.connectionId, timeoutMs: 4000
          } });
          assert.equal(reply.isError, undefined);
          assert.equal(reply.structuredContent.timedOut, false, JSON.stringify({ provider,
            revision: await fixture.evaluate(() => ({ count: globalThis.replyRevisionCount,
              ageMs: performance.now() - globalThis.replyRevisionAt })) }));
          assert.equal(reply.structuredContent.reply.text, "Synthetic final reply");
          assert.equal(reply.structuredContent.reply.generationState, "settled_heuristic");
          assert.equal(await fixture.evaluate(() => globalThis.replyRevisionCount), 1);
          assert.ok(await fixture.evaluate(() => performance.now() - globalThis.replyRevisionAt) >= 2000);
          if (provider === "gemini") {
            await fixture.locator("model-response").last().evaluate(row => {
              row.removeAttribute("aria-busy");
              for (let index = 0; index < 2; index++) {
                const marker = document.createElement("div");
                marker.setAttribute("aria-busy", "false");
                marker.textContent = "Synthetic UI marker";
                row.append(marker);
              }
              const copy = document.createElement("button");
              copy.setAttribute("aria-label", "Copy");
              copy.textContent = "Copy";
              row.append(copy);
            });
            const completed = await mcpClient.callTool({ name: "chat_wait_for_reply", arguments: {
              connectionId: connection.connectionId, timeoutMs: 1500
            } });
            assert.equal(completed.isError, undefined, JSON.stringify(completed));
            assert.equal(completed.structuredContent.timedOut, false);
            assert.equal(completed.structuredContent.reply.text, "Synthetic final reply");
            assert.equal(completed.structuredContent.reply.generationState, "complete");
            assert.ok(completed.structuredContent.cursor.sequence > reply.structuredContent.cursor.sequence);
          }
          assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 1);
        }
        return;
      }
      setPhase("autonomous prepare and commit");
      const deadlineMs = Date.now() + 12_000;
      const preparation = await facade.prepareChatMessage(connection.connectionId, "Synthetic autonomous browser message",
        "a66b3997-9d43-4554-8399-267d1fe9f75c", deadlineMs);
      assert.equal(preparation.kind, "chat_message_prepared");
      const prepared = preparation.payload;
      assert.equal(prepared.state, "prepared");
      assert.equal(prepared.expiresAt, deadlineMs);
      assert.match(prepared.recoveryToken, /^[0-9a-f]{64}$/);
      assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 0);
      await fixture.bringToFront();
      if (outcome === "lost_script") await worker.evaluate(operationId => {
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        globalThis.autonomousLostSubmitResults = 0;
        chrome.scripting.executeScript = async options => {
          const result = await execute(options);
          if (options.args?.[0]?.attemptId === operationId) {
            globalThis.autonomousLostSubmitResults++;
            throw new Error("Synthetic lost autonomous submit result");
          }
          return result;
        };
      }, prepared.operationId);
      const dispatch = await facade.commitPreparedMessage(prepared.operationId, deadlineMs);
      setPhase("autonomous status and replay");
      assert.equal(dispatch.kind, "chat_dispatch");
      assert.equal(dispatch.deadlineMs, deadlineMs);
      assert.equal(dispatch.payload.state, retainedDraft ? outcome === "not_sent" ? "resolved" : "dispatch_uncertain"
        : provider === "gemini" ? "resolved" : "observed_in_ui");
      if (outcome === "not_sent") {
        assert.equal(dispatch.payload.resolution.outcome, "not_sent");
        assert.equal(dispatch.payload.resolution.source, "page");
      }
      assert.equal(await fixture.evaluate(() => globalThis.fixtureSubmitCount), 1);
      if (outcome === "delayed") assert.equal(await fixture.evaluate(() => globalThis.fixtureDeferredAppends), 1);
      if (outcome === "lost_script") assert.equal(await worker.evaluate(() => globalThis.autonomousLostSubmitResults), 1);
      if (outcome === "lost_native_completion" || outcome === "lost_settle") {
        assert.equal(await worker.evaluate(() => globalThis.fixtureDroppedCompletionCount), 1);
      }
      assert.equal(await fixture.locator(provider === "gemini" ? "infinite-scroller user-query" : "ol[role=log] li").count(),
        (provider === "gemini" ? 1 : 2) + (retainedDraft ? 0 : 1));
      assert.equal(await fixture.locator(provider === "gemini" ? "[contenteditable]" : "#message").evaluate(editor =>
        editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText), retainedDraft ? prepared.preview.text : "");
      assert.deepEqual((await facade.commitPreparedMessage(prepared.operationId, deadlineMs)).payload, dispatch.payload);
      for (const phase of ["fill", "proof", "submit", "settle"]) assert.deepEqual((await relay.listChatJobs(phase, provider)).payload, { jobs: [] });
      assert.equal((await facade.getPreparedOperation(prepared.operationId, prepared.recoveryToken)).payload.state, dispatch.payload.state);
      assert.equal(await worker.evaluate(async ({ operationId, provider }) =>
        (await chrome.storage.local.get(`${provider}-submit-attempt-${operationId}`))[`${provider}-submit-attempt-${operationId}`],
      { operationId: prepared.operationId, provider }), true);
      const encoded = JSON.stringify(dispatch.payload);
      for (const privateValue of [prepared.preview.text, prepared.recoveryToken, selected.documentId]) assert.equal(encoded.includes(privateValue), false);
      const { DatabaseSync } = await import("node:sqlite");
      const journal = new DatabaseSync(join(profile, ".config/agent-messaging-mcp/operations.sqlite"), { readOnly: true });
      try { assert.equal(journal.prepare("SELECT count(*) AS count FROM message_dispatch_attempts").get().count, 1); }
      finally { journal.close(); }
      return;
    }
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
    publicSendCancellation?.abort();
    await mcpClient?.close().catch(() => {});
    facade?.close();
    relay?.close();
    broker?.kill("SIGTERM");
    if (brokerExit) await brokerExit;
    try {
      if (visibilityBrowserControl) {
        await visibilityBrowserControl.send("Browser.close").catch(() => {});
        let closeTimer;
        try {
          await Promise.race([visibilityBrowserExit, new Promise((_, reject) => {
            closeTimer = globalThis.setTimeout(() => reject(new Error("Disposable visibility browser did not close")), 5000);
          })]);
        } finally { clearTimeout(closeTimer); }
      } else await context?.close();
    }
    finally {
      if (visibilityBrowser?.exitCode === null && visibilityBrowser.signalCode === null) visibilityBrowser.kill("SIGTERM");
      if (visibilityBrowserExit) await visibilityBrowserExit;
      await rm(profile, { recursive: true, force: true });
      setPhase("complete");
    }
  }
}

for (const provider of ["fixture", "gemini"]) {
  if (provider === "fixture") test("public fixture sends from a hidden rich empty composer without activating its tab", { timeout: 15000 }, async testContext => {
    testContext.signal.throwIfAborted();
    await exerciseChatDispatch("hidden_send_rich", provider, testContext, "public");
  });
  test(`public ${provider} sends from a hidden empty composer without activating its tab`, { timeout: 15000 }, async testContext => {
    testContext.signal.throwIfAborted();
    await exerciseChatDispatch("hidden_send", provider, testContext, "public");
  });
  test(`public ${provider} removed debugger probes cannot change a human draft`, { timeout: 15000 }, async testContext => {
    testContext.signal.throwIfAborted();
    await exerciseChatDispatch("removed_probes", provider, testContext, "public");
  });
  test(`public ${provider} read expiry skips queued captures and preserves its draft`, { timeout: 15000 }, async testContext => {
    testContext.signal.throwIfAborted();
    await exerciseChatDispatch("expired_read", provider, testContext, "public");
  });
  for (const outcome of ["observed", "own_window", "hidden", "revoked_after_fill", "revoked_after_submit", "cancel_after_fill", "cancel_after_submit", "not_sent", "lost_settle", "owned_leftover"]) {
    test(`public ${provider} send uses one connection and returns idempotent status (${outcome})`, { timeout: 15000 }, async testContext => {
      testContext.signal.throwIfAborted();
      await exerciseChatDispatch(outcome, provider, testContext, "public");
    });
  }
  for (const outcome of ["observed", "delayed", "lost_script", "lost_native_completion", "not_sent", "not_sent_changed", "lost_settle"]) {
    test(`autonomous ${provider} worker sends once after one popup connection approval (${outcome})`, { timeout: 15000 }, async testContext => {
      testContext.signal.throwIfAborted();
      await exerciseChatDispatch(outcome, provider, testContext, true);
    });
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
