import { browser } from "wxt/browser";

type FixturePreview = {
  conversationId: string;
  messages: { id: string; direction: string; text: string }[];
};
type ProbeResult = { ok: true; protocolVersion: number } | { ok: false; error: string };

const fixtureOrigin = "http://127.0.0.1:8787";
const inspectButton = document.querySelector<HTMLButtonElement>("#inspect");
const status = document.querySelector<HTMLElement>("#status");
const result = document.querySelector<HTMLElement>("#result");
const conversation = document.querySelector<HTMLElement>("#conversation");
const messages = document.querySelector<HTMLOListElement>("#messages");

function inspectFixture(): FixturePreview | null {
  const root = document.querySelector<HTMLElement>("main[data-conversation-id]");
  const conversationId = root?.dataset.conversationId;
  if (!root || !conversationId) return null;

  return {
    conversationId,
    messages: [...root.querySelectorAll<HTMLElement>("ol[role=log] > li[data-message-id]")]
      .slice(-6)
      .map((row) => ({
        id: row.dataset.messageId ?? "",
        direction: row.dataset.direction ?? "unknown",
        text: (row.querySelector("p")?.textContent ?? "").slice(0, 4000)
      }))
  };
}

if (!inspectButton || !status || !result || !conversation || !messages) {
  throw new Error("Fixture probe UI is incomplete");
}

inspectButton.addEventListener("click", async () => {
  inspectButton.disabled = true;
  result.hidden = true;
  messages.replaceChildren();
  status.textContent = "Inspecting selected tab...";

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null || !tab.url || new URL(tab.url).origin !== fixtureOrigin) {
      status.textContent = "Open the local fixture at http://127.0.0.1:8787/ first.";
      return;
    }

    const [injection] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: inspectFixture
    });
    const preview = injection?.result;
    if (!preview) {
      status.textContent = "No fixture conversation found in this tab.";
      return;
    }

    conversation.textContent = `${fixtureOrigin} / ${preview.conversationId}`;
    for (const message of preview.messages) {
      const row = document.createElement("li");
      const direction = document.createElement("strong");
      direction.textContent = message.direction;
      const text = document.createElement("p");
      text.textContent = message.text;
      row.append(direction, text);
      messages.append(row);
    }
    result.hidden = false;
    status.textContent = `${preview.messages.length} rendered messages found. Checking local bridge...`;
    const probe = await browser.runtime.sendMessage({ kind: "probe_native_handshake" }) as ProbeResult;
    status.textContent = probe.ok
      ? `Native bridge ready (protocol v${probe.protocolVersion}). Nothing was sent.`
      : `Native bridge unavailable: ${probe.error}. Nothing was sent.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not inspect this tab.";
  } finally {
    inspectButton.disabled = false;
  }
});