import { browser } from "wxt/browser";

const nativeHostName = "com.agent_messaging_mcp.bridge";
const protocolVersion = 1;
const richFixtureUrl = "http://127.0.0.1:8787/?editor=rich";
const fixtureInputText = "Fixture debugger probe \u00e9";

type ProbeResult = { ok: true; protocolVersion: number } | { ok: false; error: string };
type FixtureInputResult = { ok: true; characters: number } | { ok: false; error: string };

let fixtureInputInProgress = false;

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
  if (fixtureInputInProgress) return { ok: false, error: "A fixture input probe is already running" };
  fixtureInputInProgress = true;
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
    fixtureInputInProgress = false;
    if (detachFailed) throw new Error("Fixture debugger did not detach cleanly");
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
    if (request.kind === "probe_fixture_input" && Object.keys(request).length === 2
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0) {
      return probeFixtureInput(request.tabId);
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