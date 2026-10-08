type FixtureMessage = { id: string; direction: "incoming" | "outgoing"; text: string };
type FixturePreflight = { ok: true; editor: "textarea" | "rich" } | { ok: false;
  code: "TARGET_CHANGED" | "UNSUPPORTED_MESSAGE_TEXT" | "COMPOSER_UNAVAILABLE" | "DRAFT_PRESENT" | "SUBMIT_UNAVAILABLE"
};
type FixtureFill = FixturePreflight | { ok: false; code: "FILL_UNAVAILABLE" | "FILL_UNCERTAIN" };
type FixtureSubmit = { ok: true; editor: "textarea" | "rich"; activated: true } | { ok: false;
  code: "TARGET_CHANGED" | "COMPOSER_UNAVAILABLE" | "DRAFT_CHANGED" | "SUBMIT_UNAVAILABLE"
    | "DISPATCH_UNAVAILABLE" | "DISPATCH_UNCERTAIN" };

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

export function inspectFixturePreflight(input: {
  expectedUrl: string; text: string; draftState?: "empty" | "prepared"
}): FixturePreflight {
  const fixtureUrl = "http://127.0.0.1:8787/";
  const richUrl = `${fixtureUrl}?editor=rich`;
  if (!input || (input.expectedUrl !== fixtureUrl && input.expectedUrl !== richUrl)
    || location.href !== input.expectedUrl || window.top !== window) return { ok: false, code: "TARGET_CHANGED" };
  if (typeof input.text !== "string" || !input.text || input.text !== input.text.trim() || input.text.includes("\r")
    || input.text.length > 2048 || new TextEncoder().encode(input.text).length > 4000) {
    return { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" };
  }
  const draftState = input.draftState === undefined ? "empty" : input.draftState;
  if (draftState !== "empty" && draftState !== "prepared") return { ok: false, code: "COMPOSER_UNAVAILABLE" };
  if (draftState === "prepared" && document.visibilityState !== "visible") return { ok: false, code: "TARGET_CHANGED" };
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
    if (draftState === "prepared" ? editor.value !== input.text : editor.value.length > 0) {
      return { ok: false, code: "DRAFT_PRESENT" };
    }
  } else {
    if (editor.id !== "rich-message" || !editor.isContentEditable || editor.getAttribute("aria-readonly") === "true") {
      return { ok: false, code: "COMPOSER_UNAVAILABLE" };
    }
    const placeholder = editor.childNodes.length === 1 && editor.firstChild instanceof HTMLBRElement;
    if (draftState === "prepared" ? editor.innerText !== input.text
      : editor.textContent?.length || (editor.childNodes.length > 0 && !placeholder)) {
      return { ok: false, code: "DRAFT_PRESENT" };
    }
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

export function fillFixtureDraft(input: {
  expectedUrl: string; text: string; operationId: string; attemptId: string; expiresAt: number
}): FixtureFill {
  const fixtureUrl = "http://127.0.0.1:8787/";
  const richUrl = `${fixtureUrl}?editor=rich`;
  const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!input || typeof input.operationId !== "string" || !identifier.test(input.operationId)
    || typeof input.attemptId !== "string" || !identifier.test(input.attemptId)
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()
    || input.expiresAt > Date.now() + 4_000) return { ok: false, code: "FILL_UNAVAILABLE" };
  if ((input.expectedUrl !== fixtureUrl && input.expectedUrl !== richUrl)
    || location.href !== input.expectedUrl || window.top !== window) return { ok: false, code: "TARGET_CHANGED" };
  if (typeof input.text !== "string" || !input.text || input.text !== input.text.trim() || input.text.includes("\r")
    || input.text.length > 2048 || new TextEncoder().encode(input.text).length > 4000) {
    return { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" };
  }
  const scope = globalThis as typeof globalThis & { fixtureDraftFillAttempts?: Set<string> };
  const attempts = scope.fixtureDraftFillAttempts ??= new Set<string>();
  if (attempts.has(input.attemptId) || attempts.size >= 100) return { ok: false, code: "FILL_UNAVAILABLE" };
  attempts.add(input.attemptId);
  const inspect = () => {
    if (location.href !== input.expectedUrl || document.visibilityState !== "visible") {
      return { ok: false as const, code: "TARGET_CHANGED" as const };
    }
    const roots = document.querySelectorAll<HTMLElement>("main[data-conversation-id]");
    const root = roots[0];
    if (roots.length !== 1 || root?.dataset.conversationId !== "fixture-alpha") {
      return { ok: false as const, code: "TARGET_CHANGED" as const };
    }
    const visible = (element: HTMLElement) => element.getClientRects().length > 0
      && getComputedStyle(element).visibility === "visible" && Number(getComputedStyle(element).opacity) > 0;
    const forms = root.querySelectorAll("form#composer");
    const form = forms[0];
    if (forms.length !== 1 || !(form instanceof HTMLFormElement) || !visible(root) || !visible(form)) {
      return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
    }
    const editors = [...form.querySelectorAll<HTMLElement>("textarea, [contenteditable=true], [role=textbox]")].filter(visible);
    const editor = editors[0];
    const kind = input.expectedUrl === richUrl ? "rich" as const : "textarea" as const;
    if (editors.length !== 1 || !editor || editor.closest("[inert], [aria-disabled=true], fieldset:disabled")) {
      return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
    }
    if (kind === "textarea") {
      if (!(editor instanceof HTMLTextAreaElement) || editor.id !== "message" || editor.matches(":disabled") || editor.readOnly) {
        return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
      }
      if (editor.value.length) return { ok: false as const, code: "DRAFT_PRESENT" as const };
    } else {
      if (editor.id !== "rich-message" || !editor.isContentEditable || editor.getAttribute("aria-readonly") === "true") {
        return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
      }
      const placeholder = editor.childNodes.length === 1 && editor.firstChild instanceof HTMLBRElement;
      if (editor.textContent?.length || (editor.childNodes.length > 0 && !placeholder)) {
        return { ok: false as const, code: "DRAFT_PRESENT" as const };
      }
    }
    const buttons = form.querySelectorAll("button[type=submit]");
    const button = buttons[0];
    if (buttons.length !== 1 || !(button instanceof HTMLButtonElement) || button.form !== form || !visible(button)
      || button.matches(":disabled") || button.closest("[inert], [aria-disabled=true]")) {
      return { ok: false as const, code: "SUBMIT_UNAVAILABLE" as const };
    }
    for (const [element, code] of [[button, "SUBMIT_UNAVAILABLE"], [editor, "COMPOSER_UNAVAILABLE"]] as const) {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0
        || rect.right > innerWidth || rect.bottom > innerHeight || !hit || (hit !== element && !element.contains(hit))) {
        return { ok: false as const, code };
      }
    }
    return { ok: true as const, root, editor, kind };
  };
  try {
    const before = inspect();
    if (!before.ok) return before;
    before.editor.focus({ preventScroll: true });
    const focused = inspect();
    if (!focused.ok) return focused;
    if (focused.root !== before.root || focused.editor !== before.editor || document.activeElement !== focused.editor
      || Date.now() >= input.expiresAt) return { ok: false, code: "FILL_UNAVAILABLE" };
    if (focused.editor instanceof HTMLTextAreaElement) focused.editor.setSelectionRange(0, 0);
    else {
      const selection = window.getSelection();
      if (!selection) return { ok: false, code: "FILL_UNAVAILABLE" };
      const range = document.createRange();
      range.selectNodeContents(focused.editor);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const ready = inspect();
    if (!ready.ok) return ready;
    if (ready.root !== focused.root || ready.editor !== focused.editor || document.activeElement !== ready.editor
      || Date.now() >= input.expiresAt) return { ok: false, code: "FILL_UNAVAILABLE" };
    if (!document.execCommand("insertText", false, input.text)) return { ok: false, code: "FILL_UNCERTAIN" };
    const text = ready.editor instanceof HTMLTextAreaElement ? ready.editor.value : ready.editor.innerText;
    const roots = document.querySelectorAll<HTMLElement>("main[data-conversation-id]");
    if (location.href !== input.expectedUrl || roots.length !== 1 || roots[0] !== ready.root
      || ready.root.dataset.conversationId !== "fixture-alpha" || !ready.editor.isConnected
      || document.activeElement !== ready.editor || text !== input.text) return { ok: false, code: "FILL_UNCERTAIN" };
    return { ok: true, editor: ready.kind };
  } catch {
    return { ok: false, code: "FILL_UNCERTAIN" };
  }
}

export async function reserveFixtureSubmitAttempt(input: { operationId: string; expiresAt: number }): Promise<boolean> {
  const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!input || typeof input.operationId !== "string" || !identifier.test(input.operationId)
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()
    || input.expiresAt > Date.now() + 4_000) return false;
  const scope = globalThis as typeof globalThis & {
    fixtureSubmitReservationPending?: boolean;
    chrome?: { storage?: { local?: {
      get: (keys: string | null) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>
    } } }
  };
  const storage = scope.chrome?.storage?.local;
  if (!storage || scope.fixtureSubmitReservationPending) return false;
  scope.fixtureSubmitReservationPending = true;
  const prefix = "fixture-submit-attempt-";
  const key = `${prefix}${input.operationId}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = async () => {
    try {
      const entries = await storage.get(null);
      const keys = Object.keys(entries).filter(entry => entry.startsWith(prefix));
      if (keys.length >= 10_000 || keys.some(entry => !identifier.test(entry.slice(prefix.length)) || entries[entry] !== true)
        || Object.hasOwn(entries, key) || input.expiresAt <= Date.now()) return false;
      await storage.set({ [key]: true });
      if (input.expiresAt <= Date.now()) return false;
      const written = await storage.get(key);
      return input.expiresAt > Date.now() && written[key] === true;
    } catch {
      return false;
    } finally {
      scope.fixtureSubmitReservationPending = false;
    }
  };
  try {
    return await Promise.race([persist(), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), Math.max(0, input.expiresAt - Date.now()));
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export function submitFixtureDraft(input: {
  expectedUrl: string; text: string; operationId: string; attemptId: string; expiresAt: number
}): FixtureSubmit {
  const fixtureUrl = "http://127.0.0.1:8787/";
  const richUrl = `${fixtureUrl}?editor=rich`;
  const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!input || typeof input.operationId !== "string" || !identifier.test(input.operationId)
    || input.attemptId !== input.operationId || !Number.isSafeInteger(input.expiresAt)) {
    return { ok: false, code: "DISPATCH_UNAVAILABLE" };
  }
  const scope = globalThis as typeof globalThis & { fixtureSubmitAttempts?: Set<string> };
  const attempts = scope.fixtureSubmitAttempts ??= new Set<string>();
  if (attempts.has(input.operationId) || attempts.size >= 100) return { ok: false, code: "DISPATCH_UNAVAILABLE" };
  attempts.add(input.operationId);
  if (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 4_000) {
    return { ok: false, code: "DISPATCH_UNAVAILABLE" };
  }
  if ((input.expectedUrl !== fixtureUrl && input.expectedUrl !== richUrl)
    || location.href !== input.expectedUrl || window.top !== window || document.visibilityState !== "visible") {
    return { ok: false, code: "TARGET_CHANGED" };
  }
  if (typeof input.text !== "string" || !input.text || input.text !== input.text.trim() || input.text.includes("\r")
    || input.text.length > 2048 || new TextEncoder().encode(input.text).length > 4000) {
    return { ok: false, code: "DISPATCH_UNAVAILABLE" };
  }
  const inspect = () => {
    if (location.href !== input.expectedUrl || document.visibilityState !== "visible" || input.expiresAt <= Date.now()) {
      return { ok: false as const, code: "TARGET_CHANGED" as const };
    }
    const roots = document.querySelectorAll<HTMLElement>("main[data-conversation-id]");
    const root = roots[0];
    if (roots.length !== 1 || root?.dataset.conversationId !== "fixture-alpha") {
      return { ok: false as const, code: "TARGET_CHANGED" as const };
    }
    const visible = (element: HTMLElement) => element.getClientRects().length > 0
      && getComputedStyle(element).visibility === "visible" && Number(getComputedStyle(element).opacity) > 0;
    const forms = root.querySelectorAll("form#composer");
    const form = forms[0];
    if (forms.length !== 1 || !(form instanceof HTMLFormElement) || !visible(root) || !visible(form)) {
      return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
    }
    const editors = [...form.querySelectorAll<HTMLElement>("textarea, [contenteditable=true], [role=textbox]")].filter(visible);
    const editor = editors[0];
    const kind = input.expectedUrl === richUrl ? "rich" as const : "textarea" as const;
    if (editors.length !== 1 || !editor || editor.closest("[inert], [aria-disabled=true], fieldset:disabled")) {
      return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
    }
    if (kind === "textarea") {
      if (!(editor instanceof HTMLTextAreaElement) || editor.id !== "message" || editor.matches(":disabled") || editor.readOnly) {
        return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
      }
      if (editor.value !== input.text) return { ok: false as const, code: "DRAFT_CHANGED" as const };
    } else {
      if (editor.id !== "rich-message" || !editor.isContentEditable || editor.getAttribute("aria-readonly") === "true") {
        return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
      }
      if (editor.innerText !== input.text) return { ok: false as const, code: "DRAFT_CHANGED" as const };
    }
    const buttons = form.querySelectorAll("button[type=submit]");
    const button = buttons[0];
    if (buttons.length !== 1 || !(button instanceof HTMLButtonElement) || button.form !== form || !visible(button)
      || button.matches(":disabled") || button.closest("[inert], [aria-disabled=true]")) {
      return { ok: false as const, code: "SUBMIT_UNAVAILABLE" as const };
    }
    for (const [element, code] of [[button, "SUBMIT_UNAVAILABLE"], [editor, "COMPOSER_UNAVAILABLE"]] as const) {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0
        || rect.right > innerWidth || rect.bottom > innerHeight || !hit || (hit !== element && !element.contains(hit))) {
        return { ok: false as const, code };
      }
    }
    return { ok: true as const, root, form, editor, button, kind };
  };
  let activated = false;
  try {
    const before = inspect();
    if (!before.ok) return before;
    HTMLElement.prototype.focus.call(before.button, { preventScroll: true });
    const ready = inspect();
    if (!ready.ok) return ready;
    if (ready.root !== before.root || ready.form !== before.form || ready.editor !== before.editor
      || ready.button !== before.button || document.activeElement !== ready.button || Date.now() >= input.expiresAt) {
      return { ok: false, code: "DISPATCH_UNAVAILABLE" };
    }
    activated = true;
    HTMLElement.prototype.click.call(ready.button);
    return { ok: true, editor: ready.kind, activated: true };
  } catch {
    return { ok: false, code: activated ? "DISPATCH_UNCERTAIN" : "DISPATCH_UNAVAILABLE" };
  }
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