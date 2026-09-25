import { browser } from "wxt/browser";

type FixturePreview = {
  conversationId: string;
  messages: { id: string; direction: string; text: string }[];
};
type GeminiPreview = {
  routeDepth: number;
  mainRegions: number;
  editors: { tag: string; isPrompt: boolean }[];
  timelineCount: number;
  rows: { tag: string; characters: number }[];
};
type ProbeResult = { ok: true; protocolVersion: number } | { ok: false; error: string };
type FixtureInputResult = { ok: true; characters: number } | { ok: false; error: string };

const fixtureOrigin = "http://127.0.0.1:8787";
const richFixtureUrl = `${fixtureOrigin}/?editor=rich`;
const geminiOrigin = "https://gemini.google.com";
const inspectButton = document.querySelector<HTMLButtonElement>("#inspect");
const fixtureInputButton = document.querySelector<HTMLButtonElement>("#test-fixture-input");
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

function inspectGeminiStructure(): GeminiPreview | null {
  if (location.origin !== "https://gemini.google.com") return null;

  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const mainRegions = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  const main = mainRegions[0];
  const timelines = main ? [...main.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((scroller) => visible(scroller) && scroller.querySelector("user-query, model-response")) : [];
  const timeline = timelines.length === 1 ? timelines[0] : undefined;
  const rows = timeline ? [...timeline.querySelectorAll<HTMLElement>("user-query, model-response")]
    .filter(visible)
    .slice(-4)
    .map((row) => {
      const text = row.localName === "user-query"
        ? [...row.querySelectorAll<HTMLElement>("user-query-content p.query-text-line")]
          .filter(visible).map((line) => line.innerText).join("\n").trim()
        : row.querySelector<HTMLElement>("model-response-content")?.innerText.trim() ?? "";
      return { tag: row.localName, characters: text.length };
    }) : [];

  return {
    routeDepth: location.pathname.split("/").filter(Boolean).length,
    mainRegions: mainRegions.length,
    editors: [...document.querySelectorAll<HTMLElement>("textarea, [contenteditable=true], [role=textbox]")]
      .filter(visible)
      .slice(0, 6)
      .map((editor) => ({
        tag: editor.localName,
        isPrompt: editor.getAttribute("aria-label") === "Enter a prompt for Gemini"
      })),
    timelineCount: timelines.length,
    rows
  };
}

if (!inspectButton || !fixtureInputButton || !status || !result || !conversation || !messages) {
  throw new Error("Fixture probe UI is incomplete");
}

void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  fixtureInputButton.hidden = tab?.url !== richFixtureUrl;
});

fixtureInputButton.addEventListener("click", async () => {
  fixtureInputButton.disabled = true;
  status.textContent = "Checking debugger input on the local rich fixture...";
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null || tab.url !== richFixtureUrl) {
      status.textContent = "Open the local rich fixture to test input. Nothing sent.";
      return;
    }
    const probe = await browser.runtime.sendMessage({ kind: "probe_fixture_input", tabId: tab.id }) as FixtureInputResult;
    status.textContent = probe.ok
      ? `Fixture input read back (${probe.characters} characters). Send was not clicked.`
      : `${probe.error}. Send was not clicked.`;
  } catch {
    status.textContent = "Fixture debugger input unavailable. Inspect the draft before retrying.";
  } finally {
    fixtureInputButton.disabled = false;
  }
});

inspectButton.addEventListener("click", async () => {
  inspectButton.disabled = true;
  result.hidden = true;
  messages.replaceChildren();
  status.textContent = "Inspecting selected tab...";

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null || !tab.url) {
      status.textContent = "Open the fixture or a disposable Gemini chat first.";
      return;
    }

    const origin = new URL(tab.url).origin;
    if (origin === geminiOrigin) {
      const [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: inspectGeminiStructure
      });
      const preview = injection?.result;
      if (!preview) {
        status.textContent = "Could not inspect the selected Gemini tab.";
        return;
      }

      conversation.textContent = "Gemini structure (not connected)";
      const details: [string, string][] = [
        ["Route", `${preview.routeDepth} path segments (values omitted)`],
        ["Regions", `${preview.mainRegions} main, ${preview.timelineCount} candidate chat timelines`],
        ["Editors", preview.editors.map((editor) => `${editor.tag}: ${editor.isPrompt ? "Gemini prompt" : "other editor"}`).join("\n") || "None visible"],
        ["Rendered rows", preview.timelineCount === 1
          ? preview.rows.map((row) => `${row.tag} (${row.characters} chars)`).join("\n") || "No visible rows"
          : "Missing or ambiguous chat region; no text inspected"]
      ];
      for (const [label, text] of details) {
        const row = document.createElement("li");
        const heading = document.createElement("strong");
        heading.textContent = label;
        const value = document.createElement("p");
        value.textContent = text;
        row.append(heading, value);
        messages.append(row);
      }
      result.hidden = false;
      status.textContent = "Structure and lengths only. No message text returned, drafts, connection, or sending.";
      return;
    }

    if (origin !== fixtureOrigin) {
      status.textContent = "Only the local fixture and gemini.google.com are supported by this probe.";
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