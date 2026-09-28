import { browser } from "wxt/browser";
import { geminiDraftText } from "../lib/approved-probe";

const nativeHostName = "com.agent_messaging_mcp.bridge";
const protocolVersion = 1;
const richFixtureUrl = "http://127.0.0.1:8787/?editor=rich";
const fixtureInputText = "Fixture debugger probe \u00e9";
const geminiOrigin = "https://gemini.google.com";

type ProbeResult = { ok: true; protocolVersion: number } | { ok: false; error: string };
type FixtureInputResult = { ok: true; characters: number } | { ok: false; error: string };
type PendingListResult = { ok: true; requests: { requestId: string; expiresAt: number }[] }
  | { ok: false; error: string };
type FixtureApprovalResult = { ok: true; requestId: string; expiresAt: number }
  | { ok: false; error: string };

let inputInProgress = false;

function isSelectedFixture(): boolean {
  return location.origin === "http://127.0.0.1:8787"
    && document.querySelector("main[data-conversation-id=fixture-alpha]") !== null;
}

function readFixtureIdentity(): string | null {
  if (location.origin !== "http://127.0.0.1:8787") return null;
  const fixtures = document.querySelectorAll<HTMLElement>("main[data-conversation-id]");
  return fixtures.length === 1 && fixtures[0]?.dataset.conversationId === "fixture-alpha" ? "fixture-alpha" : null;
}

async function approveFixture(tabId: number, expectedUrl: string, pendingRequestId: string): Promise<FixtureApprovalResult> {
  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (active?.id !== tabId || !tab.active || tab.url !== expectedUrl
      || new URL(expectedUrl).origin !== "http://127.0.0.1:8787") {
      return { ok: false, error: "Fixture tab changed; no approval sent" };
    }
    const [identity] = await browser.scripting.executeScript({ target: { tabId }, func: readFixtureIdentity });
    if (!identity || identity.frameId !== 0) return { ok: false, error: "Fixture main frame unavailable; no approval sent" };
    if (identity.result !== "fixture-alpha") return { ok: false, error: "Fixture identity changed; no approval sent" };
    if (typeof identity.documentId !== "string") return { ok: false, error: "Chrome document ID missing; no approval sent" };
    if (!/^[!-~]{1,128}$/.test(identity.documentId)) {
      return { ok: false, error: "Chrome document ID format unrecognized; no approval sent" };
    }
    const documentId = identity.documentId;
    const [fresh] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
    });
    if (fresh?.documentId !== documentId || fresh.result !== "fixture-alpha"
      || (await browser.tabs.get(tabId)).url !== expectedUrl) {
      return { ok: false, error: "Fixture changed; no approval sent" };
    }

    return await new Promise<FixtureApprovalResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve({ ok: false, error: "Native fixture approval unavailable" });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, error: "Fixture approval timed out" }), 10_000);

      function finish(result: FixtureApprovalResult) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        void (async () => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
          const reply = value as Record<string, unknown>;
          if (reply.protocolVersion !== protocolVersion || reply.requestId !== requestId
            || reply.connectionGeneration !== 0 || reply.deadlineMs !== deadlineMs
            || typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) throw new Error();
          const payload = reply.payload as Record<string, unknown>;
          if (reply.kind === "error" && payload.code === "APPROVAL_INVALID") {
            finish({ ok: false, error: "Request expired or already approved" });
            return;
          }
          if (reply.kind === "error" && payload.code === "BROKER_UNAVAILABLE") {
            finish({ ok: false, error: "Broker unavailable; no approval" });
            return;
          }
          if (reply.kind !== "fixture_approved" || Object.keys(payload).length !== 2
            || payload.requestId !== pendingRequestId || typeof payload.expiresAt !== "number"
            || !Number.isSafeInteger(payload.expiresAt)) throw new Error();
          const [current] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
          });
          if (current?.documentId !== documentId || current.result !== "fixture-alpha"
            || (await browser.tabs.get(tabId)).url !== expectedUrl) throw new Error();
          finish({ ok: true, requestId: pendingRequestId, expiresAt: payload.expiresAt });
        })().catch(() => finish({ ok: false, error: "Fixture changed or approval response invalid; reconnect" }));
      });
      port.onDisconnect.addListener(() => finish({ ok: false, error: "Native fixture approval unavailable" }));
      port.postMessage({
        kind: "approve_fixture", protocolVersion, requestId, connectionGeneration: 0, deadlineMs,
        payload: { pendingRequestId, target: {
          origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId, documentId
        } }
      });
    });
  } catch {
    return { ok: false, error: "Fixture changed or approval unavailable; reconnect" };
  }
}

async function listFixturePending(tabId: number): Promise<PendingListResult> {
  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (active?.id !== tabId || !tab.active || !tab.url
      || new URL(tab.url).origin !== "http://127.0.0.1:8787") {
      return { ok: false, error: "Select the local fixture tab first" };
    }
    const [fixture] = await browser.scripting.executeScript({ target: { tabId }, func: isSelectedFixture });
    if (fixture?.result !== true) return { ok: false, error: "Fixture conversation not found" };
    const selectedUrl = tab.url;

    return await new Promise<PendingListResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve({ ok: false, error: "Native pending list unavailable" });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, error: "Native pending list timed out" }), 10_000);

      function finish(result: PendingListResult) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        void (async () => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
          const reply = value as Record<string, unknown>;
          if (reply.kind !== "pending_list" || reply.protocolVersion !== protocolVersion
            || reply.requestId !== requestId || reply.connectionGeneration !== 0 || reply.deadlineMs !== deadlineMs
            || typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) {
            throw new Error();
          }
          const requests = (reply.payload as { requests?: unknown }).requests;
          if (!Array.isArray(requests) || requests.length > 100 || !requests.every((item: unknown) => {
            if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
            const entry = item as Record<string, unknown>;
            return Object.keys(entry).length === 2 && typeof entry.requestId === "string"
              && /^[0-9a-f-]{36}$/.test(entry.requestId)
              && typeof entry.expiresAt === "number" && Number.isSafeInteger(entry.expiresAt);
          })) throw new Error();
          const current = await browser.tabs.get(tabId);
          if (!current.active || current.url !== selectedUrl) throw new Error();
          finish({ ok: true, requests: requests as { requestId: string; expiresAt: number }[] });
        })().catch(() => finish({ ok: false, error: "Pending list invalid or fixture tab changed" }));
      });
      port.onDisconnect.addListener(() => finish({ ok: false, error: "Native pending list unavailable" }));
      port.postMessage({
        kind: "list_pending", protocolVersion, requestId, connectionGeneration: 0,
        deadlineMs, payload: {}
      });
    });
  } catch {
    return { ok: false, error: "Fixture pending list unavailable" };
  }
}

function focusFixtureEditor(): boolean {
  if (location.href !== "http://127.0.0.1:8787/?editor=rich"
    || document.querySelector("main[data-conversation-id=fixture-alpha]") === null) return false;
  const editor = document.querySelector<HTMLElement>("#rich-message[contenteditable=true]");
  if (!editor || editor.hidden || editor.getClientRects().length === 0 || editor.innerText.length > 0) return false;
  editor.focus();
  return document.activeElement === editor;
}

function readFixtureEditor(): string | null {
  if (location.href !== "http://127.0.0.1:8787/?editor=rich"
    || document.querySelector("main[data-conversation-id=fixture-alpha]") === null) return null;
  return document.querySelector<HTMLElement>("#rich-message[contenteditable=true]")?.innerText ?? null;
}

async function probeFixtureInput(tabId: number): Promise<FixtureInputResult> {
  if (inputInProgress) return { ok: false, error: "An input probe is already running" };
  inputInProgress = true;
  let attached = false;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (activeTab?.id !== tabId || !tab.active || tab.url !== richFixtureUrl) {
      return { ok: false, error: "Only the selected rich local fixture can receive probe input" };
    }

    await browser.debugger.attach({ tabId }, "1.3");
    attached = true;
    const [focused] = await browser.scripting.executeScript({ target: { tabId }, func: focusFixtureEditor });
    if (focused?.result !== true || (await browser.tabs.get(tabId)).url !== richFixtureUrl) {
      return { ok: false, error: "Fixture changed, contains a draft, or editor could not be focused" };
    }

    await browser.debugger.sendCommand({ tabId }, "Input.insertText", { text: fixtureInputText });
    const [readback] = await browser.scripting.executeScript({ target: { tabId }, func: readFixtureEditor });
    if (readback?.result !== fixtureInputText) {
      return { ok: false, error: "Fixture input did not match; draft was not cleared" };
    }
    return { ok: true, characters: fixtureInputText.length };
  } catch {
    return { ok: false, error: "Fixture debugger input unavailable; inspect the draft before retrying" };
  } finally {
    let detachFailed = false;
    if (attached) {
      try {
        await browser.debugger.detach({ tabId });
      } catch {
        detachFailed = true;
      }
    }
    inputInProgress = false;
    if (detachFailed) throw new Error("Fixture debugger did not detach cleanly");
  }
}

function focusGeminiEditor(expectedUrl: string): boolean {
  if (location.href !== expectedUrl || location.origin !== "https://gemini.google.com") return false;
  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const main = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  if (main.length !== 1 || [...main[0]!.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((scroller) => visible(scroller) && scroller.querySelector("user-query, model-response")).length !== 1) return false;

  const editors = [...document.querySelectorAll<HTMLElement>("[contenteditable=true]")]
    .filter((element) => visible(element) && (element.getAttribute("aria-label") === "Enter a prompt for Gemini"
      || element.getAttribute("placeholder") === "Enter a prompt for Gemini"));
  const editor = editors.length === 1 ? editors[0] : undefined;
  if (!editor || !main[0]!.contains(editor) || editor.textContent?.length || editor.innerText.trim()) return false;
  editor.focus();
  return document.activeElement === editor && !editor.textContent?.length && !editor.innerText.trim();
}

function readGeminiEditor(expectedUrl: string): string | null {
  if (location.href !== expectedUrl || location.origin !== "https://gemini.google.com") return null;
  const editors = [...document.querySelectorAll<HTMLElement>("[contenteditable=true]")]
    .filter((element) => element.getClientRects().length > 0
      && (element.getAttribute("aria-label") === "Enter a prompt for Gemini"
        || element.getAttribute("placeholder") === "Enter a prompt for Gemini"));
  return editors.length === 1 ? editors[0]!.innerText.trim() : null;
}

async function prepareGeminiDraft(tabId: number, expectedUrl: string): Promise<FixtureInputResult> {
  if (inputInProgress) return { ok: false, error: "An input probe is already running" };
  inputInProgress = true;
  let attached = false;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (activeTab?.id !== tabId || !tab.active || tab.url !== expectedUrl) {
      return { ok: false, error: "The selected Gemini tab changed; no draft was filled" };
    }
    const url = new URL(expectedUrl);
    if (url.origin !== geminiOrigin || url.pathname.split("/").filter(Boolean).length !== 2) {
      return { ok: false, error: "Open the saved disposable Gemini chat first; no draft was filled" };
    }
    await browser.debugger.attach({ tabId }, "1.3");
    attached = true;
    const [focused] = await browser.scripting.executeScript({
      target: { tabId }, func: focusGeminiEditor, args: [expectedUrl]
    });
    const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (focused?.result !== true || currentTab?.id !== tabId || (await browser.tabs.get(tabId)).url !== expectedUrl) {
      return { ok: false, error: "The conversation changed, has a draft, or editor is ambiguous; no text was inserted" };
    }

    await browser.debugger.sendCommand({ tabId }, "Input.insertText", { text: geminiDraftText });
    const [readback] = await browser.scripting.executeScript({
      target: { tabId }, func: readGeminiEditor, args: [expectedUrl]
    });
    if (readback?.result !== geminiDraftText) {
      return { ok: false, error: "Gemini draft could not be verified; inspect it before any retry" };
    }
    return { ok: true, characters: geminiDraftText.length };
  } catch {
    return { ok: false, error: "Gemini draft input unavailable; inspect the composer before any retry" };
  } finally {
    let detachFailed = false;
    if (attached) {
      try {
        await browser.debugger.detach({ tabId });
      } catch {
        detachFailed = true;
      }
    }
    inputInProgress = false;
    if (detachFailed) throw new Error("Gemini debugger did not detach cleanly; inspect the draft");
  }
}

function isHandshakeReply(value: unknown, requestId: string, deadlineMs: number): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reply = value as Record<string, unknown>;
  if (typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) return false;

  return Object.keys(reply).length === 6
    && reply.kind === "handshake_result"
    && reply.protocolVersion === protocolVersion
    && reply.requestId === requestId
    && reply.connectionGeneration === 0
    && reply.deadlineMs === deadlineMs
    && Object.keys(reply.payload).length === 1
    && (reply.payload as Record<string, unknown>).protocolVersion === protocolVersion;
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL("/popup.html")
      || typeof message !== "object" || message === null || Array.isArray(message)) return;

    const request = message as Record<string, unknown>;
    if (request.kind === "list_fixture_pending" && Object.keys(request).length === 2
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0) {
      return listFixturePending(request.tabId);
    }
    if (request.kind === "approve_fixture" && Object.keys(request).length === 4
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0
      && typeof request.expectedUrl === "string" && request.expectedUrl.length < 2048
      && typeof request.pendingRequestId === "string" && /^[0-9a-f-]{36}$/.test(request.pendingRequestId)) {
      return approveFixture(request.tabId, request.expectedUrl, request.pendingRequestId);
    }
    if (request.kind === "probe_fixture_input" && Object.keys(request).length === 2
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0) {
      return probeFixtureInput(request.tabId);
    }
    if (request.kind === "prepare_gemini_draft" && Object.keys(request).length === 3
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0
      && typeof request.expectedUrl === "string" && request.expectedUrl.length < 4096) {
      return prepareGeminiDraft(request.tabId, request.expectedUrl);
    }
    if (request.kind !== "probe_native_handshake") return;

    return new Promise<ProbeResult>((resolve) => {
      try {
        const requestId = crypto.randomUUID();
        const deadlineMs = Date.now() + 10_000;
        const port = browser.runtime.connectNative(nativeHostName);
        let settled = false;
        const timeout = setTimeout(() => finish({ ok: false, error: "Native host timed out" }), 10_000);

        function finish(result: ProbeResult) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(result);
          port.disconnect();
        }

        port.onMessage.addListener((reply: unknown) => {
          finish(isHandshakeReply(reply, requestId, deadlineMs)
            ? { ok: true, protocolVersion }
            : { ok: false, error: "Native host returned an invalid handshake" });
        });
        port.onDisconnect.addListener(() => {
          finish({ ok: false, error: browser.runtime.lastError?.message ?? "Native host disconnected" });
        });
        port.postMessage({
          kind: "handshake",
          protocolVersion,
          requestId,
          connectionGeneration: 0,
          deadlineMs,
          payload: {}
        });
      } catch (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : "Native host unavailable" });
      }
    });
  });
});