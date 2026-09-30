type FixtureMessage = { id: string; direction: "incoming" | "outgoing"; text: string };
type FixturePreflight = { ok: true; editor: "textarea" | "rich" } | { ok: false;
  code: "TARGET_CHANGED" | "UNSUPPORTED_MESSAGE_TEXT" | "COMPOSER_UNAVAILABLE" | "DRAFT_PRESENT" | "SUBMIT_UNAVAILABLE"
};

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

export function inspectFixturePreflight(input: { expectedUrl: string; text: string }): FixturePreflight {
  const fixtureUrl = "http://127.0.0.1:8787/";
  const richUrl = `${fixtureUrl}?editor=rich`;
  if (!input || (input.expectedUrl !== fixtureUrl && input.expectedUrl !== richUrl)
    || location.href !== input.expectedUrl || window.top !== window) return { ok: false, code: "TARGET_CHANGED" };
  if (typeof input.text !== "string" || !input.text || input.text !== input.text.trim() || input.text.includes("\r")
    || input.text.length > 2048 || new TextEncoder().encode(input.text).length > 4000) {
    return { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" };
  }
  const roots = document.querySelectorAll<HTMLElement>("main[data-conversation-id]");
  if (roots.length !== 1 || roots[0]?.dataset.conversationId !== "fixture-alpha") return { ok: false, code: "TARGET_CHANGED" };
  const visible = (element: HTMLElement) => element.getClientRects().length > 0
    && getComputedStyle(element).visibility === "visible" && Number(getComputedStyle(element).opacity) > 0;
  const forms = roots[0].querySelectorAll("form#composer");
  const form = forms[0];
  if (forms.length !== 1 || !(form instanceof HTMLFormElement) || !visible(roots[0]) || !visible(form)) {
    return { ok: false, code: "COMPOSER_UNAVAILABLE" };
  }
  const editors = [...form.querySelectorAll<HTMLElement>("textarea, [contenteditable=true], [role=textbox]")].filter(visible);
  const editor = editors[0];
  const kind = input.expectedUrl === richUrl ? "rich" : "textarea";
  if (editors.length !== 1 || !editor || editor.closest("[inert], [aria-disabled=true], fieldset:disabled")) {
    return { ok: false, code: "COMPOSER_UNAVAILABLE" };
  }
  if (kind === "textarea") {
    if (!(editor instanceof HTMLTextAreaElement) || editor.id !== "message" || editor.matches(":disabled") || editor.readOnly) {
      return { ok: false, code: "COMPOSER_UNAVAILABLE" };
    }
    if (editor.value.length > 0) return { ok: false, code: "DRAFT_PRESENT" };
  } else {
    if (editor.id !== "rich-message" || !editor.isContentEditable || editor.getAttribute("aria-readonly") === "true") {
      return { ok: false, code: "COMPOSER_UNAVAILABLE" };
    }
    const placeholder = editor.childNodes.length === 1 && editor.firstChild instanceof HTMLBRElement;
    if (editor.textContent?.length || (editor.childNodes.length > 0 && !placeholder)) return { ok: false, code: "DRAFT_PRESENT" };
  }
  const buttons = form.querySelectorAll("button[type=submit]");
  const button = buttons[0];
  if (buttons.length !== 1 || !(button instanceof HTMLButtonElement) || button.form !== form || !visible(button)
    || button.matches(":disabled") || button.closest("[inert], [aria-disabled=true]")) return { ok: false, code: "SUBMIT_UNAVAILABLE" };
  const rect = button.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0
    || rect.right > innerWidth || rect.bottom > innerHeight) return { ok: false, code: "SUBMIT_UNAVAILABLE" };
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!hit || (hit !== button && !button.contains(hit))) return { ok: false, code: "SUBMIT_UNAVAILABLE" };
  const editorRect = editor.getBoundingClientRect();
  if (editorRect.width <= 0 || editorRect.height <= 0 || editorRect.left < 0 || editorRect.top < 0
    || editorRect.right > innerWidth || editorRect.bottom > innerHeight) return { ok: false, code: "COMPOSER_UNAVAILABLE" };
  const editorHit = document.elementFromPoint(editorRect.left + editorRect.width / 2, editorRect.top + editorRect.height / 2);
  if (!editorHit || (editorHit !== editor && !editor.contains(editorHit))) return { ok: false, code: "COMPOSER_UNAVAILABLE" };
  return { ok: true, editor: kind };
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