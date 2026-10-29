export type DatabagReactIdentity = {
  accountId: string;
  peerId: string | null;
  channelId: string;
  sessionToken: string;
  focusToken: string;
  ready: boolean;
  available: boolean;
  draftSafe: boolean;
  rows?: { id: string; direction: "incoming" | "outgoing" }[];
  rowCount?: number;
};

export function installDatabagIdentityBridge(origins: readonly string[]): boolean {
  if (!Array.isArray(origins) || origins.length !== 1 || typeof origins[0] !== "string") return false;
  const origin = origins[0];
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.href !== `${origin}/`
      || url.username || url.password || url.hostname.includes("*") || origin === "https://gemini.google.com"
      || location.href !== `${origin}/#/session` || window.top !== window) return false;
  } catch { return false; }
  const data = (object: unknown, key: string): unknown => {
    if (!object || typeof object !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const marker = "agentDatabagIdentityBridge";
  const installed = data(window, marker);
  if (installed) return data(installed, "origin") === origin && data(installed, "version") === 1;
  const tokens = new WeakMap<object, string>();
  const token = (object: object) => {
    let value = tokens.get(object);
    if (!value) { value = crypto.randomUUID(); tokens.set(object, value); }
    return value;
  };
  const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
  const context = (owner: unknown): { session: object; focus: object } | null => {
    let dependency = data(data(owner, "dependencies"), "firstContext");
    let found: { session: object; focus: object } | null = null;
    for (let count = 0; dependency && count < 8; count++) {
      const state = data(data(dependency, "memoizedValue"), "state");
      const session = data(state, "session");
      const focus = data(state, "focus");
      if (session && typeof session === "object" && focus && typeof focus === "object") {
        if (found) return null;
        found = { session, focus };
      }
      dependency = data(dependency, "next");
    }
    return dependency ? null : found;
  };
  const read = (element: HTMLElement, includeRows: boolean): DatabagReactIdentity | null => {
    if (location.href !== `${origin}/#/session` || element.ownerDocument !== document || !element.isConnected
      || element.localName !== "div" || element.className.length > 512
      || !element.className.split(/\s+/).some(name => /^_conversation_[A-Za-z0-9_-]+$/.test(name))) return null;
    const properties = Object.getOwnPropertyNames(element);
    if (properties.length > 512) return null;
    const names = properties.filter(name => name.startsWith("__reactFiber$"));
    const name = names[0];
    if (names.length !== 1 || !name) return null;
    let root = data(element, name);
    for (let depth = 0; root && data(root, "return") && depth < 64; depth++) root = data(root, "return");
    if (!root || data(root, "return")) return null;
    const container = data(root, "stateNode");
    const current = data(container, "current");
    if (!current) return null;
    const stack: unknown[] = [current];
    const seen = new Set<unknown>();
    const hosts = new Map<Element, unknown>();
    let host: unknown;
    while (stack.length && seen.size < 4096) {
      const node = stack.pop();
      if (!node || seen.has(node)) return null;
      seen.add(node);
      const stateNode = data(node, "stateNode");
      if (stateNode instanceof Element) hosts.set(stateNode, node);
      if (stateNode === element) host = node;
      const sibling = data(node, "sibling");
      const child = data(node, "child");
      if (sibling) stack.push(sibling);
      if (child) stack.push(child);
    }
    if (!host || stack.length) return null;
    let owner = data(host, "return");
    for (let depth = 0; owner && depth < 16; depth++, owner = data(owner, "return")) {
      let hook = data(owner, "memoizedState");
      for (let count = 0; hook && count < 32; count++, hook = data(hook, "next")) {
        const state = data(hook, "memoizedState");
        if (typeof data(state, "loaded") !== "boolean" || typeof data(state, "detailSet") !== "boolean"
          || typeof data(state, "access") !== "boolean" || data(state, "cardId") === undefined) continue;
        const selected = context(owner);
        if (!selected) return null;
        const accountId = data(selected.session, "guid");
        if (!identifier(accountId) || data(selected.focus, "guid") !== accountId) return null;
        const prototype = Object.getPrototypeOf(selected.focus);
        const descriptor = Object.getOwnPropertyDescriptor(selected.focus, "getFocused")
          ?? (prototype && Object.getOwnPropertyDescriptor(prototype, "getFocused"));
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return null;
        const source = Function.prototype.toString.call(descriptor.value);
        if (source.length > 512) return null;
        const compact = source.replace(/\s+/g, "");
        const direct = /^getFocused\(\)\{(?:const|let|var)\{cardId,channelId\}=this;return\{cardId,channelId\};?\}$/;
        const renamed = /^getFocused\(\)\{(?:const|let|var)\{cardId:([A-Za-z_$][\w$]*),channelId:([A-Za-z_$][\w$]*)\}=this;return\{cardId:\1,channelId:\2\};?\}$/;
        if (!direct.test(compact) && !renamed.test(compact)) return null;
        for (const key of ["cardId", "channelId"]) {
          const field = Object.getOwnPropertyDescriptor(selected.focus, key);
          if (!field || !("value" in field)) return null;
        }
        const focused: unknown = Reflect.apply(descriptor.value, selected.focus, []);
        const peerId = data(focused, "cardId");
        const channelId = data(focused, "channelId");
        if ((peerId !== null && !identifier(peerId)) || !identifier(channelId)) return null;
        const previous = context(data(owner, "alternate"));
        const profile = data(state, "profile");
        const detail = data(state, "detail");
        const available = data(state, "loaded") === true && data(state, "detailSet") === true && data(state, "access") === true
          && data(state, "cardId") === peerId && data(profile, "guid") === accountId
          && detail !== null && typeof detail === "object" && data(detail, "locked") === false;
        const ready = available && previous?.session === selected.session && previous.focus === selected.focus
          && data(container, "pendingLanes") === 0 && data(owner, "lanes") === 0;
        const assets = data(state, "assets");
        const draftSafe = Array.isArray(assets) && assets.length === 0;
        if (data(container, "current") !== current || location.href !== `${origin}/#/session` || !element.isConnected) return null;
        const identity: DatabagReactIdentity = { accountId, peerId, channelId,
          sessionToken: token(selected.session), focusToken: token(selected.focus), ready, available, draftSafe };
        if (!includeRows) return identity;
        if (!ready) return null;
        const timelines = [...element.querySelectorAll<HTMLElement>('[class*="_thread_"]')]
          .filter(timeline => timeline.className.length <= 512
            && timeline.className.split(/\s+/).some(name => /^_thread_[A-Za-z0-9_-]+$/.test(name)));
        const timeline = timelines[0];
        if (timelines.length !== 1 || !timeline || timeline.childElementCount > 4096) return null;
        const elements: HTMLElement[] = [];
        for (const child of timeline.children) {
          if (!(child instanceof HTMLElement) || child.className.length > 512) return null;
          if (child.className === "topicPad") continue;
          if (!child.className.split(/\s+/).some(name => /^_topic_[A-Za-z0-9_-]+$/.test(name))) return null;
          elements.push(child);
        }
        const rows: NonNullable<DatabagReactIdentity["rows"]> = [];
        const ids = new Set<string>();
        for (const row of elements.slice(-32)) {
          let messageOwner = data(hosts.get(row), "return");
          let topic: unknown;
          for (let depth = 0; messageOwner && depth < 16; depth++, messageOwner = data(messageOwner, "return")) {
            topic = data(data(messageOwner, "memoizedProps"), "topic");
            if (topic) break;
          }
          const id = data(topic, "topicId");
          const sender = data(topic, "guid");
          if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || ids.has(id) || !identifier(sender)
            || data(topic, "locked") !== false || data(topic, "blocked") !== false) return null;
          ids.add(id);
          rows.push({ id, direction: sender === accountId ? "outgoing" : "incoming" });
        }
        if (data(container, "current") !== current || !element.isConnected || location.href !== `${origin}/#/session`) return null;
        return { ...identity, rows, rowCount: elements.length };
      }
    }
    return null;
  };
  const receive = (event: Event) => {
    try {
      if (!(event instanceof CustomEvent) || !(event.target instanceof HTMLElement) || typeof event.detail !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.detail)) return;
      event.target.dispatchEvent(new CustomEvent("agent-databag-identity-response-v1", {
        detail: JSON.stringify({ nonce: event.detail, identity: read(event.target, event.type === "agent-databag-rows-v1") }) }));
    } catch {}
  };
  window.addEventListener("agent-databag-identity-v1", receive, true);
  window.addEventListener("agent-databag-rows-v1", receive, true);
  window.addEventListener("pagehide", () => {
    window.removeEventListener("agent-databag-identity-v1", receive, true);
    window.removeEventListener("agent-databag-rows-v1", receive, true);
  }, { once: true });
  Object.defineProperty(window, marker, { value: Object.freeze({ origin, version: 1 }), configurable: false });
  return true;
}