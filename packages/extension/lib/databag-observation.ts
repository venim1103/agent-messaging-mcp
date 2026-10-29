export type DatabagIdentity = { url: string; conversationId: string };
export type DatabagCapture = { messages: { id: string; direction: "incoming" | "outgoing";
  text: string; truncated?: true }[]; omittedBefore: boolean };
export type DatabagDraftInput = { expectedUrl: string; conversationId: string; text: string;
  draftState?: "empty" | "prepared"; allowHidden?: true };
export type DatabagPreflight = { ok: true; editor: "textarea" } | { ok: false;
  code: "TARGET_CHANGED" | "UNSUPPORTED_MESSAGE_TEXT" | "COMPOSER_UNAVAILABLE" | "DRAFT_PRESENT" | "SUBMIT_UNAVAILABLE" };
export type DatabagFillInput = Omit<DatabagDraftInput, "draftState"> & { operationId: string; attemptId: string; expiresAt: number;
  leftover?: { operationId: string; text: string } };
export type DatabagFill = DatabagPreflight | { ok: false; code: "FILL_UNAVAILABLE" | "FILL_UNCERTAIN" };
export type DatabagSubmitInput = Omit<DatabagFillInput, "leftover">;
export type DatabagSubmit = { ok: true; editor: "textarea"; activated: true } | { ok: false;
  code: "TARGET_CHANGED" | "COMPOSER_UNAVAILABLE" | "DRAFT_CHANGED" | "SUBMIT_UNAVAILABLE" | "DISPATCH_UNAVAILABLE" | "DISPATCH_UNCERTAIN" };
export type DatabagStructure = {
  visitedElements: number;
  limited: boolean;
  markerContractPresent: boolean;
  counts: { conversationRegions: number; timelines: number; focusedRows: number; accountRegions: number;
    accountHandles: number; composers: number; messageRows: number; messageTexts: number; fileInputs: number;
    stagedAssetChildren: number; editorCandidates: number; sendButtons: number };
  nativeElements: { textareas: number; contenteditables: number; buttons: number; fileInputs: number; iframes: number };
  cssNaming: { scoped: number; componentPrefixed: number; other: number };
  controlElements: { labels: number; roleButtons: number; svgRoots: number };
  sendRegions: { buttons: number; labels: number; divs: number; spans: number; svgs: number; other: number };
  editors: { disabled: boolean; readOnly: boolean }[];
  sends: { disabled: boolean; ariaDisabled: boolean }[];
};
type DatabagAdapter = {
  origins: string;
  identify: () => Promise<DatabagIdentity | null>;
  capture: (conversationId: string) => Promise<DatabagCapture | null>;
  inspect: (input: DatabagDraftInput) => Promise<DatabagPreflight>;
  fill: (input: DatabagFillInput) => Promise<DatabagFill>;
  submit: (input: DatabagSubmitInput) => Promise<DatabagSubmit>;
  observe: (conversationId: string) => Promise<boolean>;
  stop: () => void;
};
type DatabagScope = { agentDatabagAdapter?: DatabagAdapter };

export function inspectDatabagStructure(input: { expectedUrl: string; origin: string }): DatabagStructure | null {
  if (!input || typeof input.origin !== "string" || typeof input.expectedUrl !== "string"
    || input.expectedUrl.length > 512 || input.expectedUrl !== `${input.origin}/#/session`
    || window.top !== window || location.href !== input.expectedUrl || document.visibilityState !== "visible") return null;
  try {
    const url = new URL(input.origin);
    if (url.protocol !== "https:" || url.origin !== input.origin || url.href !== `${input.origin}/`
      || url.username || url.password || url.hostname.includes("*") || input.origin === "https://gemini.google.com") return null;
  } catch { return null; }
  const body = document.body;
  if (!body) return null;
  const result: DatabagStructure = { visitedElements: 0, limited: false, markerContractPresent: false,
    counts: { conversationRegions: 0, timelines: 0, focusedRows: 0, accountRegions: 0, accountHandles: 0,
      composers: 0, messageRows: 0, messageTexts: 0, fileInputs: 0, stagedAssetChildren: 0,
      editorCandidates: 0, sendButtons: 0 },
    nativeElements: { textareas: 0, contenteditables: 0, buttons: 0, fileInputs: 0, iframes: 0 },
    cssNaming: { scoped: 0, componentPrefixed: 0, other: 0 }, controlElements: { labels: 0, roleButtons: 0, svgRoots: 0 },
    sendRegions: { buttons: 0, labels: 0, divs: 0, spans: 0, svgs: 0, other: 0 }, editors: [], sends: [] };
  const ancestry: { conversation: boolean; composer: boolean; send: boolean; account: boolean }[] = [];
  let element: Element | null = body;
  let depth = 0;
  while (element) {
    if (result.visitedElements >= 4096 || depth > 64) { result.limited = true; break; }
    result.visitedElements++;
    const classes = element.getAttribute("class") ?? "";
    if (classes.length > 512) { result.limited = true; break; }
    const names = new Set<string>();
    for (const token of classes.split(/\s+/)) {
      if (!token) continue;
      const scoped = /^_(conversation|thread|focused|identity|handle|staging|send|files|topic|text)_[A-Za-z0-9_-]+$/.exec(token);
      const prefixed = scoped ? null
        : /^[A-Za-z][A-Za-z0-9_-]*_(conversation|thread|focused|identity|handle|staging|send|files|topic|text)__[A-Za-z0-9_-]+$/.exec(token);
      const match = scoped ?? prefixed;
      result.cssNaming[scoped ? "scoped" : prefixed ? "componentPrefixed" : "other"]++;
      if (match?.[1]) names.add(match[1]);
    }
    const parent = ancestry[depth - 1];
    const current = { conversation: names.has("conversation") || Boolean(parent?.conversation),
      composer: names.has("staging") || Boolean(parent?.composer), send: names.has("send") || Boolean(parent?.send),
      account: names.has("identity") || Boolean(parent?.account) };
    ancestry[depth] = current;
    const style = getComputedStyle(element);
    const hidden = element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true"
      || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0;
    if (element instanceof HTMLInputElement && element.type === "file") result.nativeElements.fileInputs++;
    if (parent?.composer && element instanceof HTMLInputElement && element.type === "file") result.counts.fileInputs++;
    if (!hidden && element.getClientRects().length) {
      if (element instanceof HTMLTextAreaElement) result.nativeElements.textareas++;
      if (element instanceof HTMLElement && element.hasAttribute("contenteditable") && element.isContentEditable) {
        result.nativeElements.contenteditables++;
      }
      if (element instanceof HTMLButtonElement) result.nativeElements.buttons++;
      if (element instanceof HTMLIFrameElement) result.nativeElements.iframes++;
      if (element instanceof HTMLLabelElement) result.controlElements.labels++;
      if (element.getAttribute("role") === "button") result.controlElements.roleButtons++;
      if (element instanceof SVGSVGElement) result.controlElements.svgRoots++;
      if (names.has("conversation")) result.counts.conversationRegions++;
      if (names.has("focused")) result.counts.focusedRows++;
      if (names.has("identity")) result.counts.accountRegions++;
      if (current.account && names.has("handle")) result.counts.accountHandles++;
      if (current.conversation) {
        if (names.has("thread")) result.counts.timelines++;
        if (names.has("topic")) result.counts.messageRows++;
        if (!current.account && names.has("text")) result.counts.messageTexts++;
        if (names.has("staging")) result.counts.composers++;
      }
      if (current.conversation && current.composer) {
        if (names.has("send")) {
          const category = element instanceof HTMLButtonElement ? "buttons" : element instanceof HTMLLabelElement ? "labels"
            : element instanceof HTMLDivElement ? "divs" : element instanceof HTMLSpanElement ? "spans"
            : element instanceof SVGSVGElement ? "svgs" : "other";
          result.sendRegions[category]++;
        }
        if (names.has("files")) result.counts.stagedAssetChildren += element.childElementCount;
        if (element instanceof HTMLTextAreaElement) {
          result.counts.editorCandidates++;
          if (result.editors.length < 4) result.editors.push({ disabled: element.matches(":disabled"), readOnly: element.readOnly });
        }
        if (current.send && element instanceof HTMLButtonElement) {
          result.counts.sendButtons++;
          if (result.sends.length < 4) result.sends.push({ disabled: element.matches(":disabled"),
            ariaDisabled: element.getAttribute("aria-disabled") === "true" });
        }
      }
      if (element.hasAttribute("data-chat-contract")) result.markerContractPresent = true;
    }
    if (!hidden && element.firstElementChild) { element = element.firstElementChild; depth++; continue; }
    while (element !== body && !element.nextElementSibling) { element = element.parentElement!; depth--; }
    if (element === body) break;
    element = element.nextElementSibling;
  }
  return location.href === input.expectedUrl && document.visibilityState === "visible" && body === document.body ? result : null;
}

export function installDatabagAdapter(origins: readonly string[]): boolean {
  if (!Array.isArray(origins) || origins.length !== 1 || typeof origins[0] !== "string") return false;
  const origin = origins[0];
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.href !== `${origin}/`
      || url.username || url.password || url.hostname.includes("*") || origin === "https://gemini.google.com") return false;
  } catch { return false; }
  if (location.origin !== origin || window.top !== window) return false;
  const scope = globalThis as typeof globalThis & DatabagScope;
  const signature = JSON.stringify(origins);
  if (scope.agentDatabagAdapter) return scope.agentDatabagAdapter.origins === signature
    && typeof scope.agentDatabagAdapter.inspect === "function" && typeof scope.agentDatabagAdapter.fill === "function"
    && typeof scope.agentDatabagAdapter.submit === "function";
  const visible = (element: HTMLElement) => {
    if (!element.getClientRects().length) return false;
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.hidden || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true"
        || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const context = () => {
    if (location.href !== `${origin}/#/session` || window.top !== window) return null;
    const roots = document.querySelectorAll<HTMLElement>('[data-chat-contract="databag-dom-v1"]');
    const root = roots[0];
    if (roots.length !== 1 || !root || !visible(root) || root.dataset.chatReady !== "true") return null;
    const values = [root.dataset.chatAccount, root.dataset.chatPeer, root.dataset.chatChannel];
    if (values.some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value))) return null;
    const timelines = root.querySelectorAll<HTMLElement>('[data-chat-timeline="true"][role="log"]');
    const timeline = timelines[0];
    if (timelines.length !== 1 || !timeline || !visible(timeline)) return null;
    return { root, timeline, identity: JSON.stringify(values) };
  };
  const identify = async (): Promise<DatabagIdentity | null> => {
    const before = context();
    if (!before) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(before.identity));
    const after = context();
    if (!after || after.root !== before.root || after.timeline !== before.timeline || after.identity !== before.identity) return null;
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return { url: location.href, conversationId: `databag_${hash}` };
  };
  const bind = async (conversationId: string) => {
    const before = context();
    const identity = await identify();
    const after = context();
    return before && identity?.conversationId === conversationId && after
      && after.root === before.root && after.timeline === before.timeline && after.identity === before.identity ? after : null;
  };
  const validDraft = (input: DatabagDraftInput) => input && input.expectedUrl === `${origin}/#/session`
    && location.href === input.expectedUrl && /^databag_[a-f0-9]{64}$/.test(input.conversationId)
    && (input.allowHidden === undefined || input.allowHidden === true)
    && typeof input.text === "string" && input.text.length > 0 && input.text.length <= 2048
    && input.text === input.text.trim() && !input.text.includes("\r") && new TextEncoder().encode(input.text).length <= 4000;
  const unobstructed = (element: HTMLElement) => {
    if (!visible(element)) return false;
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    if (rect.width <= 0 || rect.height <= 0 || centerX < 0 || centerY < 0 || centerX >= innerWidth || centerY >= innerHeight) return false;
    const hit = document.elementFromPoint(centerX, centerY);
    return Boolean(hit && (hit === element || element.contains(hit)));
  };
  const composer = (binding: NonNullable<ReturnType<typeof context>>, allowHidden?: true) => {
    const current = context();
    if (!current || current.root !== binding.root || current.timeline !== binding.timeline || current.identity !== binding.identity
      || (document.visibilityState !== "visible" && allowHidden !== true)) return { ok: false as const, code: "TARGET_CHANGED" as const };
    const root = current.root;
    const regions = root.querySelectorAll<HTMLElement>('[data-chat-composer="true"]');
    const region = regions[0];
    if (root.dataset.chatDraftSafe !== "true" || regions.length !== 1 || !region || !visible(region)
      || current.timeline.contains(region)) return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
    const files = region.querySelectorAll<HTMLInputElement>('input[type="file"]');
    if ([...files].some(file => !(file instanceof HTMLInputElement) || !file.files || file.files.length > 0)) {
      return { ok: false as const, code: "DRAFT_PRESENT" as const };
    }
    const editors = [...region.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
    const editor = editors[0];
    if (editors.length !== 1 || !(editor instanceof HTMLTextAreaElement) || editor.readOnly || editor.matches(":disabled")
      || editor.closest('[inert], [aria-disabled="true"], [aria-readonly="true"], fieldset:disabled') || !unobstructed(editor)) {
      return { ok: false as const, code: "COMPOSER_UNAVAILABLE" as const };
    }
    const buttons = region.querySelectorAll<HTMLElement>('[data-chat-send="true"]');
    const button = buttons[0];
    if (buttons.length !== 1 || !(button instanceof HTMLButtonElement) || !unobstructed(button)
      || button.closest('[inert], [aria-disabled="true"]')) return { ok: false as const, code: "SUBMIT_UNAVAILABLE" as const };
    return { ok: true as const, root, region, editor, button };
  };
  const inspect = async (input: DatabagDraftInput): Promise<DatabagPreflight> => {
    if (!validDraft(input)) return { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" };
    if (input.draftState !== undefined && input.draftState !== "empty" && input.draftState !== "prepared") {
      return { ok: false, code: "COMPOSER_UNAVAILABLE" };
    }
    const binding = await bind(input.conversationId);
    if (!binding) return { ok: false, code: "TARGET_CHANGED" };
    const found = composer(binding, input.allowHidden);
    if (!found.ok) return found;
    if (input.draftState === "prepared" ? found.editor.value !== input.text : found.editor.value.length > 0) {
      return { ok: false, code: "DRAFT_PRESENT" };
    }
    if (input.draftState === "prepared" && found.button.matches(":disabled")) return { ok: false, code: "SUBMIT_UNAVAILABLE" };
    return { ok: true, editor: "textarea" };
  };
  const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const fillAttempts = new Set<string>();
  const fill = async (input: DatabagFillInput): Promise<DatabagFill> => {
    if (!input || !identifier.test(input.operationId) || !identifier.test(input.attemptId)
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 4000
      || (input.leftover && (!identifier.test(input.leftover.operationId) || input.leftover.operationId === input.operationId
        || typeof input.leftover.text !== "string" || !input.leftover.text || input.leftover.text.length > 2048
        || new TextEncoder().encode(input.leftover.text).length > 4000))) return { ok: false, code: "FILL_UNAVAILABLE" };
    if (!validDraft(input)) return { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" };
    if (fillAttempts.has(input.attemptId) || fillAttempts.size >= 100) return { ok: false, code: "FILL_UNAVAILABLE" };
    fillAttempts.add(input.attemptId);
    const binding = await bind(input.conversationId);
    if (!binding) return { ok: false, code: "TARGET_CHANGED" };
    const ownership = (globalThis as typeof globalThis & {
      agentDraftOwnership?: import("./draft-ownership").DraftOwnershipTracker
    }).agentDraftOwnership;
    const inspectFill = () => {
      const found = composer(binding, input.allowHidden);
      if (!found.ok) return found;
      const replacing = found.editor.value.length > 0;
      if (replacing && (!input.leftover || !ownership?.matches(input.leftover.operationId,
        input.leftover.text, input.expectedUrl, found.editor, found.root))) return { ok: false as const, code: "DRAFT_PRESENT" as const };
      return { ...found, replacing };
    };
    try {
      const before = inspectFill();
      if (!before.ok) return before;
      if (Date.now() >= input.expiresAt) return { ok: false, code: "FILL_UNAVAILABLE" };
      HTMLElement.prototype.focus.call(before.editor, { preventScroll: true });
      const focused = inspectFill();
      if (!focused.ok) return focused;
      if (focused.root !== before.root || focused.region !== before.region || focused.editor !== before.editor
        || focused.button !== before.button || focused.replacing !== before.replacing || document.activeElement !== focused.editor
        || Date.now() >= input.expiresAt) return { ok: false, code: "FILL_UNAVAILABLE" };
      HTMLTextAreaElement.prototype.setSelectionRange.call(focused.editor, 0, focused.replacing ? input.leftover!.text.length : 0);
      const ready = inspectFill();
      if (!ready.ok) return ready;
      if (ready.root !== focused.root || ready.region !== focused.region || ready.editor !== focused.editor
        || ready.button !== focused.button || ready.replacing !== focused.replacing || document.activeElement !== ready.editor
        || Date.now() >= input.expiresAt) return { ok: false, code: "FILL_UNAVAILABLE" };
      const recorded = ownership?.begin(input.operationId, input.text, input.expectedUrl, ready.editor, ready.root,
        ready.replacing ? input.leftover : undefined);
      if (ready.replacing && !recorded) return { ok: false, code: "FILL_UNAVAILABLE" };
      if (!Document.prototype.execCommand.call(document, "insertText", false, input.text)) return { ok: false, code: "FILL_UNCERTAIN" };
      const after = composer(binding, input.allowHidden);
      if (!after.ok || after.root !== ready.root || after.region !== ready.region || after.editor !== ready.editor
        || after.button !== ready.button || document.activeElement !== ready.editor || ready.editor.value !== input.text
        || Date.now() >= input.expiresAt) return { ok: false, code: "FILL_UNCERTAIN" };
      ownership?.confirm(input.operationId);
      return { ok: true, editor: "textarea" };
    } catch { return { ok: false, code: "FILL_UNCERTAIN" }; }
  };
  const submitAttempts = new Set<string>();
  const submit = async (input: DatabagSubmitInput): Promise<DatabagSubmit> => {
    if (!input || !identifier.test(input.operationId) || input.attemptId !== input.operationId
      || !Number.isSafeInteger(input.expiresAt) || (input.allowHidden !== undefined && input.allowHidden !== true)) {
      return { ok: false, code: "DISPATCH_UNAVAILABLE" };
    }
    if (submitAttempts.has(input.operationId) || submitAttempts.size >= 100) return { ok: false, code: "DISPATCH_UNAVAILABLE" };
    submitAttempts.add(input.operationId);
    if (!validDraft(input) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 4000) {
      return { ok: false, code: "DISPATCH_UNAVAILABLE" };
    }
    const binding = await bind(input.conversationId);
    if (!binding) return { ok: false, code: "TARGET_CHANGED" };
    const inspectSubmit = () => {
      const found = composer(binding, input.allowHidden);
      if (!found.ok) return found.code === "DRAFT_PRESENT" ? { ok: false as const, code: "DRAFT_CHANGED" as const } : found;
      if (found.editor.value !== input.text) return { ok: false as const, code: "DRAFT_CHANGED" as const };
      if (found.button.matches(":disabled")) return { ok: false as const, code: "SUBMIT_UNAVAILABLE" as const };
      return found;
    };
    let activated = false;
    try {
      const before = inspectSubmit();
      if (!before.ok) return before;
      if (Date.now() >= input.expiresAt) return { ok: false, code: "DISPATCH_UNAVAILABLE" };
      HTMLElement.prototype.focus.call(before.button, { preventScroll: true });
      const ready = inspectSubmit();
      if (!ready.ok) return ready;
      if (ready.root !== before.root || ready.region !== before.region || ready.editor !== before.editor
        || ready.button !== before.button || document.activeElement !== ready.button || Date.now() >= input.expiresAt) {
        return { ok: false, code: "DISPATCH_UNAVAILABLE" };
      }
      activated = true;
      HTMLElement.prototype.click.call(ready.button);
      return { ok: true, editor: "textarea", activated: true };
    } catch { return { ok: false, code: activated ? "DISPATCH_UNCERTAIN" : "DISPATCH_UNAVAILABLE" }; }
  };
  const capture = async (conversationId: string): Promise<DatabagCapture | null> => {
    const starting = context();
    const identity = await identify();
    const current = context();
    if (!starting || !identity || identity.conversationId !== conversationId || !current
      || starting.root !== current.root || starting.timeline !== current.timeline || starting.identity !== current.identity) return null;
    if (current.timeline.childElementCount > 4096) return null;
    const rows: HTMLElement[] = [];
    for (const child of current.timeline.children) {
      if (!(child instanceof HTMLElement)) return null;
      if (!child.hasAttribute("data-chat-message-id")) {
        if (child.className !== "topicPad") return null;
        continue;
      }
      if (visible(child)) rows.push(child);
    }
    const messages: DatabagCapture["messages"] = [];
    const ids = new Set<string>();
    for (const row of rows.slice(-32)) {
      const id = row.dataset.chatMessageId;
      const direction = row.dataset.chatDirection;
      const regions = row.querySelectorAll<HTMLElement>('[data-chat-text="true"]');
      const region = regions[0];
      if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || ids.has(id) || row.dataset.chatReadable !== "true"
        || (direction !== "incoming" && direction !== "outgoing") || regions.length !== 1 || !region || !visible(region)) return null;
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_ALL);
      let nodes = 0;
      while (walker.nextNode()) {
        if (++nodes > 4096) return null;
        if (walker.currentNode instanceof Element
          && (!(walker.currentNode instanceof HTMLElement) || !visible(walker.currentNode)
            || !["span", "a", "br"].includes(walker.currentNode.localName))) return null;
        let depth = 0;
        for (let ancestor = walker.currentNode.parentNode; ancestor && ancestor !== region; ancestor = ancestor.parentNode) {
          if (++depth > 64) return null;
        }
      }
      const text = region.innerText.trim();
      ids.add(id);
      messages.push({ id, direction, text: text.slice(0, 16_000), ...(text.length > 16_000 ? { truncated: true as const } : {}) });
    }
    let omittedBefore = rows.length > 32;
    const size = () => new TextEncoder().encode(JSON.stringify({ messages, omittedBefore })).length;
    while (size() > 96 * 1024 && messages.length > 1) { messages.shift(); omittedBefore = true; }
    if (size() > 96 * 1024 && messages[0]) {
      const newest = messages[0];
      const text = newest.text;
      newest.truncated = true;
      let lower = 0;
      let upper = text.length;
      while (lower < upper) {
        const length = Math.ceil((lower + upper) / 2);
        newest.text = text.slice(0, length);
        if (size() <= 96 * 1024) lower = length;
        else upper = length - 1;
      }
      newest.text = text.slice(0, lower);
    }
    const after = context();
    return after?.root === current.root && after.timeline === current.timeline && after.identity === current.identity
      ? { messages, omittedBefore } : null;
  };
  let stopObservation = () => {};
  const observe = async (conversationId: string): Promise<boolean> => {
    const starting = context();
    const identity = await identify();
    let watched = context();
    const runtime = (globalThis as typeof globalThis & { chrome?: { runtime?: {
      sendMessage: (message: { kind: string; provider: string; conversationId: string }) => Promise<unknown>
    } } }).chrome?.runtime;
    if (!starting || !identity || identity.conversationId !== conversationId || !watched || !runtime
      || starting.root !== watched.root || starting.timeline !== watched.timeline || starting.identity !== watched.identity) return false;
    stopObservation();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const notify = (kind: "chat_changed" | "chat_identity_changed") => {
      void runtime.sendMessage({ kind, provider: "databag", conversationId }).catch(() => {});
    };
    const changed = () => {
      if (stopped || timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; if (!stopped) notify("chat_changed"); }, 200);
    };
    const rows = new MutationObserver(changed);
    const guard = () => {
      if (stopped) return;
      const current = context();
      if (location.href !== identity.url || (current && current.identity !== watched!.identity)) {
        notify("chat_identity_changed");
        stop();
      } else if (current && (current.root !== watched!.root || current.timeline !== watched!.timeline)) {
        watched = current;
        rows.disconnect();
        rows.observe(current.timeline, { subtree: true, childList: true, characterData: true, attributes: true });
        changed();
      } else if (!current) changed();
    };
    const identityObserver = new MutationObserver(guard);
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      rows.disconnect();
      identityObserver.disconnect();
      window.removeEventListener("hashchange", guard);
      window.removeEventListener("pagehide", stop);
    };
    stopObservation = stop;
    rows.observe(watched.timeline, { subtree: true, childList: true, characterData: true, attributes: true });
    identityObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["data-chat-contract", "data-chat-ready", "data-chat-account", "data-chat-peer", "data-chat-channel",
        "data-chat-timeline", "hidden", "inert", "aria-hidden", "class", "style"] });
    window.addEventListener("hashchange", guard);
    window.addEventListener("pagehide", stop, { once: true });
    changed();
    return true;
  };
  scope.agentDatabagAdapter = { origins: signature, identify, capture, inspect, fill, submit, observe, stop: () => stopObservation() };
  return true;
}

export function identifyDatabagConversation(): Promise<DatabagIdentity | null> {
  return (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.identify() ?? Promise.resolve(null);
}

export function captureDatabagSnapshot(conversationId: string): Promise<DatabagCapture | null> {
  return (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.capture(conversationId) ?? Promise.resolve(null);
}

export function inspectDatabagDraft(input: DatabagDraftInput): Promise<DatabagPreflight> {
  return (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.inspect(input)
    ?? Promise.resolve({ ok: false, code: "TARGET_CHANGED" });
}

export function fillDatabagDraft(input: DatabagFillInput): Promise<DatabagFill> {
  return (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.fill(input)
    ?? Promise.resolve({ ok: false, code: "TARGET_CHANGED" });
}

export function submitDatabagDraft(input: DatabagSubmitInput): Promise<DatabagSubmit> {
  return (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.submit(input)
    ?? Promise.resolve({ ok: false, code: "TARGET_CHANGED" });
}

export function observeDatabagMessages(conversationId: string): Promise<boolean> {
  return (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.observe(conversationId) ?? Promise.resolve(false);
}

export function stopDatabagObservation(): void {
  (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.stop();
}