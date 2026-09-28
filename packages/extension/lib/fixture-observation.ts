type FixtureMessage = { id: string; direction: "incoming" | "outgoing"; text: string };

export function captureFixtureSnapshot(): { messages: FixtureMessage[] } | null {
  if (location.origin !== "http://127.0.0.1:8787") return null;
  const roots = document.querySelectorAll<HTMLElement>("main[data-conversation-id]");
  if (roots.length !== 1 || roots[0]?.dataset.conversationId !== "fixture-alpha") return null;
  const timelines = roots[0].querySelectorAll<HTMLOListElement>("ol#messages[role=log]");
  if (timelines.length !== 1 || !timelines[0] || timelines[0].children.length > 32) return null;

  const messages: FixtureMessage[] = [];
  const ids = new Set<string>();
  for (const row of timelines[0].children) {
    if (!(row instanceof HTMLLIElement)) return null;
    const id = row.getAttribute("data-message-id");
    const direction = row.getAttribute("data-direction");
    const paragraphs = row.querySelectorAll("p");
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || ids.has(id)
      || (direction !== "incoming" && direction !== "outgoing") || paragraphs.length !== 1) return null;
    const text = paragraphs[0]!.innerText;
    if (text.length > 2048) return null;
    ids.add(id);
    messages.push({ id, direction, text });
  }
  return new TextEncoder().encode(JSON.stringify(messages)).length <= 64 * 1024 ? { messages } : null;
}

export function observeFixtureMessages(): boolean {
  if (location.origin !== "http://127.0.0.1:8787") return false;
  const root = document.querySelector<HTMLElement>("main[data-conversation-id=fixture-alpha]");
  const timeline = root?.querySelector<HTMLOListElement>("ol#messages[role=log]");
  const runtime = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { sendMessage: (message: { kind: string }) => Promise<unknown> } }
  }).chrome?.runtime;
  if (!root || !timeline || !runtime) return false;
  const scope = globalThis as typeof globalThis & { fixtureMessagesObserver?: MutationObserver };
  if (scope.fixtureMessagesObserver) return true;

  const observer = new MutationObserver(() => {
    if (!root.isConnected || root.dataset.conversationId !== "fixture-alpha") {
      observer.disconnect();
      delete scope.fixtureMessagesObserver;
      return;
    }
    void runtime.sendMessage({ kind: "fixture_messages_changed" }).catch(() => {});
  });
  observer.observe(timeline, {
    childList: true, characterData: true, subtree: true,
    attributes: true, attributeFilter: ["data-message-id", "data-direction"]
  });
  scope.fixtureMessagesObserver = observer;
  return true;
}