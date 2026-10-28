export type DatabagIdentity = { url: string; conversationId: string };
export type DatabagCapture = { messages: { id: string; direction: "incoming" | "outgoing";
  text: string; truncated?: true }[]; omittedBefore: boolean };
type DatabagAdapter = {
  origins: string;
  identify: () => Promise<DatabagIdentity | null>;
  capture: (conversationId: string) => Promise<DatabagCapture | null>;
  observe: (conversationId: string) => Promise<boolean>;
  stop: () => void;
};
type DatabagScope = { agentDatabagAdapter?: DatabagAdapter };

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
  if (scope.agentDatabagAdapter) return scope.agentDatabagAdapter.origins === signature;
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
  scope.agentDatabagAdapter = { origins: signature, identify, capture, observe, stop: () => stopObservation() };
  return true;
}

export function identifyDatabagConversation(): Promise<DatabagIdentity | null> {
  return (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.identify() ?? Promise.resolve(null);
}

export function captureDatabagSnapshot(conversationId: string): Promise<DatabagCapture | null> {
  return (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.capture(conversationId) ?? Promise.resolve(null);
}

export function observeDatabagMessages(conversationId: string): Promise<boolean> {
  return (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.observe(conversationId) ?? Promise.resolve(false);
}

export function stopDatabagObservation(): void {
  (globalThis as typeof globalThis & DatabagScope).agentDatabagAdapter?.stop();
}