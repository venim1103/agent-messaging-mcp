export type GeminiRenderedMessage = { direction: "incoming" | "outgoing"; text: string };

export function inspectGeminiDraft(input: { expectedUrl: string; text: string; draftMode?: "empty" | "prepared" }):
  { ok: true; editor: "contenteditable" } | { ok: false;
    code: "TARGET_CHANGED" | "UNSUPPORTED_MESSAGE_TEXT" | "COMPOSER_UNAVAILABLE" | "DRAFT_CHANGED" } {
  const failed = (code: "TARGET_CHANGED" | "UNSUPPORTED_MESSAGE_TEXT" | "COMPOSER_UNAVAILABLE" | "DRAFT_CHANGED") =>
    ({ ok: false as const, code });
  if (!input || window.top !== window || document.visibilityState !== "visible"
    || location.href !== input.expectedUrl || location.origin !== "https://gemini.google.com") return failed("TARGET_CHANGED");
  const url = new URL(location.href);
  const route = url.pathname.split("/").filter(Boolean);
  if (url.href.length > 512 || url.username || url.password || url.hash || route.length !== 2
    || route.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) return failed("TARGET_CHANGED");
  if (typeof input.text !== "string" || input.text.length > 2048
    || new TextEncoder().encode(input.text).length > 4000 || !input.text.trim()
    || (input.draftMode !== undefined && input.draftMode !== "empty" && input.draftMode !== "prepared")) {
    return failed("UNSUPPORTED_MESSAGE_TEXT");
  }
  const visible = (element: HTMLElement) => element.getClientRects().length > 0
    && getComputedStyle(element).visibility === "visible";
  const regions = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  if (regions.length !== 1) return failed("TARGET_CHANGED");
  const region = regions[0]!;
  const timelines = [...region.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((timeline) => visible(timeline) && [...timeline.querySelectorAll<HTMLElement>("user-query, model-response")].some(visible));
  if (timelines.length !== 1) return failed("TARGET_CHANGED");
  const editors = [...document.querySelectorAll<HTMLElement>("[contenteditable=true]")]
    .filter((element) => visible(element) && (element.getAttribute("aria-label") === "Enter a prompt for Gemini"
      || element.getAttribute("placeholder") === "Enter a prompt for Gemini"));
  const editor = editors.length === 1 ? editors[0] : undefined;
  if (!editor || !region.contains(editor) || timelines[0]!.contains(editor) || !editor.isContentEditable
    || editor.closest("[inert], [aria-hidden=true], [aria-disabled=true], [aria-readonly=true]")
    || editor.parentElement?.closest("[contenteditable]")
    || editor.querySelector("[contenteditable], input, textarea, [role=textbox]")) return failed("COMPOSER_UNAVAILABLE");
  for (let ancestor: HTMLElement | null = editor; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.visibility !== "visible" || Number(style.opacity) === 0) return failed("COMPOSER_UNAVAILABLE");
  }
  const rect = editor.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  if (rect.width <= 0 || rect.height <= 0 || centerX < 0 || centerY < 0
    || centerX >= innerWidth || centerY >= innerHeight) return failed("COMPOSER_UNAVAILABLE");
  const hit = document.elementFromPoint(centerX, centerY);
  if (!hit || (hit !== editor && !editor.contains(hit))) return failed("COMPOSER_UNAVAILABLE");
  if (input.draftMode === "prepared" ? editor.innerText !== input.text
    : Boolean(editor.textContent?.length || editor.innerText.trim())) return failed("DRAFT_CHANGED");
  return { ok: true, editor: "contenteditable" };
}

export function inspectGeminiSubmitControls(expectedUrl: string): { controls: {
  label: "send-message" | "send" | "unrecognized"; classMatch: boolean; type: "button" | "submit" | "other";
  visible: boolean; disabled: boolean; ariaDisabled: boolean; inTimeline: boolean; sharesEditorForm: boolean;
}[]; hasMore: boolean } | null {
  if (window.top !== window || document.visibilityState !== "visible" || location.href !== expectedUrl
    || location.origin !== "https://gemini.google.com") return null;
  const url = new URL(location.href);
  const route = url.pathname.split("/").filter(Boolean);
  if (url.href.length > 512 || url.username || url.password || url.hash || route.length !== 2
    || route.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) return null;
  const visible = (element: HTMLElement) => element.getClientRects().length > 0
    && getComputedStyle(element).visibility === "visible";
  const regions = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  if (regions.length !== 1) return null;
  const region = regions[0]!;
  const timelines = [...region.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((timeline) => visible(timeline) && [...timeline.querySelectorAll<HTMLElement>("user-query, model-response")].some(visible));
  if (timelines.length !== 1) return null;
  const editors = [...region.querySelectorAll<HTMLElement>("[contenteditable=true]")]
    .filter((editor) => visible(editor) && (editor.getAttribute("aria-label") === "Enter a prompt for Gemini"
      || editor.getAttribute("placeholder") === "Enter a prompt for Gemini"));
  const editorForm = editors.length === 1 ? editors[0]!.closest("form") : null;
  const controls = [...region.querySelectorAll<HTMLButtonElement>(
    'button.send-button, button[aria-label="Send message"], button[aria-label="Send"]')];
  return { controls: controls.slice(0, 4).map((control) => ({
    label: control.getAttribute("aria-label") === "Send message" ? "send-message"
      : control.getAttribute("aria-label") === "Send" ? "send" : "unrecognized",
    classMatch: control.classList.contains("send-button"),
    type: control.type === "button" || control.type === "submit" ? control.type : "other",
    visible: visible(control), disabled: control.disabled, ariaDisabled: control.getAttribute("aria-disabled") === "true",
    inTimeline: timelines[0]!.contains(control), sharesEditorForm: editorForm !== null && control.form === editorForm
  })), hasMore: controls.length > 4 };
}

export function isEligibleGeminiUrl(href: string): boolean {
  try {
    const url = new URL(href);
    const route = url.pathname.split("/").filter(Boolean);
    return url.href === href && url.origin === "https://gemini.google.com"
      && url.href.length <= 512 && !url.username && !url.password && !url.hash
      && route.length === 2 && route.every((segment) => /^[A-Za-z0-9_-]{1,128}$/.test(segment));
  } catch {
    return false;
  }
}

export function identifyGeminiConversation(): { conversationId: string; url: string } | null {
  if (location.origin !== "https://gemini.google.com") return null;
  const url = new URL(location.href);
  const route = url.pathname.split("/").filter(Boolean);
  if (url.href.length > 512 || url.username || url.password || url.hash || route.length !== 2
    || route.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) return null;
  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const regions = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  if (regions.length !== 1) return null;
  const timelines = [...regions[0]!.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((timeline) => visible(timeline)
      && [...timeline.querySelectorAll<HTMLElement>("user-query, model-response")].some(visible));
  return timelines.length === 1 ? { conversationId: route[1]!, url: url.href } : null;
}

export function observeGeminiIdentity(expectedUrl: string): boolean {
  if (location.origin !== "https://gemini.google.com" || location.href !== expectedUrl) return false;
  const runtime = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { sendMessage: (message: { kind: string }) => Promise<unknown> } }
  }).chrome?.runtime;
  if (!runtime) return false;
  const scope = globalThis as typeof globalThis & { geminiIdentityObserver?: MutationObserver };
  if (scope.geminiIdentityObserver) return true;
  const root = document.documentElement;
  const observer = new MutationObserver(() => {
    if (!root.isConnected || location.href !== expectedUrl) {
      observer.disconnect();
      delete scope.geminiIdentityObserver;
      void runtime.sendMessage({ kind: "gemini_identity_changed" }).catch(() => {});
    }
  });
  observer.observe(root, { childList: true, attributes: true, subtree: true });
  scope.geminiIdentityObserver = observer;
  return true;
}

export function observeGeminiMessages(expectedUrl: string): boolean {
  if (location.origin !== "https://gemini.google.com" || location.href !== expectedUrl) return false;
  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const regions = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  if (regions.length !== 1) return false;
  const timelines = [...regions[0]!.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((timeline) => visible(timeline) && timeline.querySelector("user-query, model-response"));
  if (timelines.length !== 1) return false;
  const runtime = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { sendMessage: (message: { kind: string }) => Promise<unknown> } }
  }).chrome?.runtime;
  if (!runtime) return false;
  const scope = globalThis as typeof globalThis & {
    geminiMessagesObserver?: MutationObserver; geminiMessagesObserverUrl?: string;
    geminiMessagesNotifyTimer?: ReturnType<typeof setTimeout>
  };
  if (scope.geminiMessagesObserver && scope.geminiMessagesObserverUrl === expectedUrl) return true;
  scope.geminiMessagesObserver?.disconnect();
  clearTimeout(scope.geminiMessagesNotifyTimer);
  const timeline = timelines[0]!;
  const observer = new MutationObserver(() => {
    if (!timeline.isConnected || location.href !== expectedUrl) {
      observer.disconnect();
      clearTimeout(scope.geminiMessagesNotifyTimer);
      delete scope.geminiMessagesObserver;
      delete scope.geminiMessagesObserverUrl;
      delete scope.geminiMessagesNotifyTimer;
      return;
    }
    if (scope.geminiMessagesNotifyTimer) return;
    scope.geminiMessagesNotifyTimer = setTimeout(() => {
      delete scope.geminiMessagesNotifyTimer;
      if (timeline.isConnected && location.href === expectedUrl) {
        void runtime.sendMessage({ kind: "gemini_messages_changed" }).catch(() => {});
      }
    }, 200);
  });
  observer.observe(timeline, { childList: true, characterData: true, subtree: true,
    attributes: true, attributeFilter: ["hidden", "class", "style"] });
  scope.geminiMessagesObserver = observer;
  scope.geminiMessagesObserverUrl = expectedUrl;
  return true;
}

export function captureGeminiSnapshot(expectedUrl?: string): { messages: GeminiRenderedMessage[] } | null {
  if (location.origin !== "https://gemini.google.com"
    || (expectedUrl !== undefined && location.href !== expectedUrl)) return null;
  const url = new URL(location.href);
  if (url.href.length > 512 || url.username || url.password || url.hash) return null;
  const route = url.pathname.split("/").filter(Boolean);
  if (route.length !== 2 || route.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) return null;

  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const regions = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  if (regions.length !== 1) return null;
  const timelines = [...regions[0]!.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((timeline) => visible(timeline) && timeline.querySelector("user-query, model-response"));
  if (timelines.length !== 1) return null;
  const timeline = timelines[0]!;
  const rows = [...timeline.querySelectorAll<HTMLElement>("user-query, model-response")].filter(visible);
  if (!rows.length || rows.length > 32) return null;

  const messages: GeminiRenderedMessage[] = [];
  for (const row of rows) {
    if (row.closest("infinite-scroller") !== timeline) return null;
    let text: string;
    if (row.localName === "user-query") {
      const content = row.querySelectorAll<HTMLElement>("user-query-content");
      if (content.length !== 1) return null;
      const lines = [...content[0]!.querySelectorAll<HTMLElement>("p.query-text-line")].filter(visible);
      if (!lines.length) return null;
      text = lines.map((line) => line.innerText).join("\n").trim();
    } else {
      const content = row.querySelectorAll<HTMLElement>("model-response-content");
      if (content.length !== 1) return null;
      text = content[0]!.innerText.trim();
    }
    if (!text && row.localName === "model-response") continue;
    if (!text || text.length > 2048) return null;
    messages.push({ direction: row.localName === "user-query" ? "outgoing" : "incoming", text });
  }
  return messages.length && new TextEncoder().encode(JSON.stringify(messages)).length <= 64 * 1024
    ? { messages } : null;
}