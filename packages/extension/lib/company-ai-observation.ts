export function inspectCompanyAIChatStructure(input: { expectedUrl: string }) {
  if (!input || typeof input.expectedUrl !== "string" || input.expectedUrl.length > 512
    || window.top !== window || document.visibilityState !== "visible" || location.href !== input.expectedUrl) return null;
  const url = new URL(input.expectedUrl);
  if (url.protocol !== "https:" || url.port || url.username || url.password
    || !/^chat\.app\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.com$/.test(url.hostname) || !document.body) return null;

  const counts = { mainRegions: 0, timelines: 0, articles: 0, forms: 0, lists: 0,
    textareas: 0, contenteditables: 0, buttons: 0, links: 0, iframes: 0 };
  const editors: { kind: "textarea" | "contenteditable" | "textbox"; disabled: boolean; readOnly: boolean }[] = [];
  const tags = new Set(["body", "main", "section", "article", "aside", "header", "footer", "nav", "div", "span", "p",
    "form", "textarea", "input", "button", "a", "label", "select", "option", "ol", "ul", "li", "pre", "code",
    "blockquote", "table", "thead", "tbody", "tr", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6", "img", "svg", "iframe"]);
  const roles = new Set(["main", "log", "feed", "article", "form", "list", "listitem", "button", "link", "textbox",
    "region", "group", "tab", "tablist", "tabpanel", "status", "alert", "navigation", "banner", "contentinfo",
    "complementary", "heading", "presentation", "none", "dialog", "menu", "menuitem", "progressbar"]);
  const identityAttributeNames = ["id", "data-account-id", "data-user-id", "data-conversation-id", "data-chat-id",
    "data-message-id", "data-testid", "aria-selected", "aria-current"];
  const structure: { tag: string; role: string | null; parent: number | null; attributeNames: string[] }[] = [];
  const pending: { element: Element; depth: number; parent: number | null }[] = [{ element: document.body, depth: 0, parent: null }];
  let visitedElements = 0;
  let limited = false;
  let editorsOmitted = false;
  let structureOmitted = false;
  while (pending.length && visitedElements < 4096) {
    const entry = pending.pop()!;
    const element = entry.element;
    visitedElements++;
    if (entry.depth > 0 && element.nextElementSibling) {
      pending.push({ element: element.nextElementSibling, depth: entry.depth, parent: entry.parent });
    }
    const tag = element.localName;
    if (["script", "style", "template", "noscript"].includes(tag)) continue;
    const style = getComputedStyle(element);
    if (element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true"
      || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) continue;
    let childParent = entry.parent;
    if (element.getClientRects().length > 0) {
      const role = element.getAttribute("role");
      if (structure.length < 512) {
        childParent = structure.length;
        structure.push({ tag: tags.has(tag) ? tag : "other", role: role !== null && roles.has(role) ? role : null,
          parent: entry.parent, attributeNames: identityAttributeNames.filter(name => element.hasAttribute(name)) });
      } else structureOmitted = true;
      if (tag === "main" || role === "main") counts.mainRegions++;
      if (role === "log" || role === "feed") counts.timelines++;
      if (tag === "article" || role === "article") counts.articles++;
      if (tag === "form" || role === "form") counts.forms++;
      if (tag === "ol" || tag === "ul" || role === "list") counts.lists++;
      if (tag === "button" || role === "button") counts.buttons++;
      if (tag === "a" || role === "link") counts.links++;
      if (tag === "iframe") counts.iframes++;
      const editable = element.getAttribute("contenteditable");
      const contenteditable = editable === "" || editable === "true" || editable === "plaintext-only";
      if (tag === "textarea") counts.textareas++;
      if (contenteditable) counts.contenteditables++;
      const kind = tag === "textarea" ? "textarea" : contenteditable ? "contenteditable"
        : role === "textbox" && tag !== "input" ? "textbox" : null;
      if (kind) {
        if (editors.length < 8) editors.push({ kind,
          disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
          readOnly: element.hasAttribute("readonly") || element.getAttribute("aria-readonly") === "true" });
        else editorsOmitted = true;
      }
    }
    if (tag !== "iframe" && element.firstElementChild) {
      if (entry.depth >= 64) limited = true;
      else pending.push({ element: element.firstElementChild, depth: entry.depth + 1, parent: childParent });
    }
  }
  return { visitedElements, limited: limited || pending.length > 0, counts, editors, editorsOmitted,
    structure, structureOmitted: structureOmitted || limited || pending.length > 0 };
}

export function proveCompanyAIChatIdentity(editor: object, timeline: object, profile: object,
  ElementType: new () => object, deadline: number, readProfile: () => unknown):
  { status: "ok"; sameCommittedRoot: true; conversationMatched: true; profileAccountMatched: true; ready: true }
  | { status: "refused" | "expired" } {
  try {
    if (!Number.isFinite(deadline)) return { status: "refused" };
    if (Date.now() >= deadline) return { status: "expired" };
    if (typeof readProfile !== "function" || new Set([editor, timeline, profile]).size !== 3) throw null;
    const object = (value: unknown): value is object => value !== null && typeof value === "object";
    const own = (target: object, name: string, optional = false): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (!descriptor && optional) return undefined;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw null;
      return descriptor.value;
    };
    const resolve = (elements: object[]) => {
      let rootState: object | undefined;
      const attachments = elements.map(element => {
        if (!(element instanceof ElementType)) throw null;
        const names = Object.getOwnPropertyNames(element);
        if (names.length > 64) throw null;
        const matching = names.filter(name => name.startsWith("__reactFiber$"));
        if (matching.length !== 1) throw null;
        const name = matching[0]!;
        const attached = own(element, name);
        if (!object(attached) || own(attached, "stateNode") !== element) throw null;
        const alternate = own(attached, "alternate", true);
        if (alternate !== undefined && alternate !== null && (!object(alternate) || alternate === attached)) throw null;
        const candidates = object(alternate) ? [attached, alternate] : [attached];
        for (const candidate of candidates) {
          if (own(candidate, "stateNode") !== element) throw null;
          let node = candidate;
          const seen = new Set<object>();
          while (true) {
            if (Date.now() >= deadline || seen.size >= 64 || seen.has(node)) throw null;
            seen.add(node);
            const parent = own(node, "return");
            if (parent === null) break;
            if (!object(parent)) throw null;
            node = parent;
          }
          const state = own(node, "stateNode");
          if (!object(state) || (rootState !== undefined && rootState !== state)) throw null;
          rootState = state;
        }
        return { element, name, attached, candidates };
      });
      if (!rootState) throw null;
      const root = own(rootState, "current");
      if (!object(root) || own(root, "stateNode") !== rootState || own(root, "return") !== null) throw null;
      const parents = new Map<object, object | null>([[root, null]]);
      const first = own(root, "child");
      if (first !== null && !object(first)) throw null;
      const stack = object(first) ? [{ node: first, parent: root, depth: 1, siblings: 1 }] : [];
      while (stack.length) {
        if (Date.now() >= deadline) throw null;
        const { node, parent, depth, siblings } = stack.pop()!;
        if (depth >= 64 || siblings > 64 || parents.size >= 4096 || parents.has(node)) throw null;
        parents.set(node, parent);
        const child = own(node, "child");
        const sibling = own(node, "sibling");
        if (child !== null && !object(child)) throw null;
        if (sibling !== null && !object(sibling)) throw null;
        if (object(sibling)) stack.push({ node: sibling, parent, depth, siblings: siblings + 1 });
        if (object(child)) stack.push({ node: child, parent: node, depth: depth + 1, siblings: 1 });
      }
      const chains = attachments.map(attachment => {
        const matches = attachment.candidates.filter(candidate => parents.has(candidate));
        if (matches.length !== 1) throw null;
        const chain: object[] = [];
        let node: object | null = matches[0]!;
        while (node !== null) {
          if (Date.now() >= deadline || chain.length >= 64) throw null;
          chain.push(node);
          const parent = parents.get(node);
          if (parent === undefined) throw null;
          node = parent;
        }
        return chain;
      });
      const current = () => own(rootState!, "current") === root && attachments.every(attachment =>
        own(attachment.element, attachment.name) === attachment.attached);
      if (!current()) throw null;
      return { root, rootState, chains, current };
    };
    const conversation = resolve([editor, timeline]);
    const accountProof = resolve([profile]);
    if (conversation.root !== accountProof.root || conversation.rootState !== accountProof.rootState) throw null;
    const dependencies = (node: object, inspect: (value: unknown) => void) => {
      const dependencyState = own(node, "dependencies");
      if (dependencyState === null) return;
      if (!object(dependencyState)) throw null;
      let dependency = own(dependencyState, "firstContext");
      const seen = new Set<object>();
      while (dependency !== null) {
        if (Date.now() >= deadline || seen.size >= 32 || !object(dependency) || seen.has(dependency)) throw null;
        seen.add(dependency);
        inspect(own(dependency, "memoizedValue"));
        dependency = own(dependency, "next");
      }
    };
    const bounded = (value: unknown, limit: number): value is string => typeof value === "string"
      && value.length > 0 && value.length <= limit && value === value.trim();
    const identifiers = conversation.chains.map(chain => {
      let identity: string | undefined;
      const sources = new Set<object>();
      for (const node of chain.slice(0, -1)) {
        if (Date.now() >= deadline) throw null;
        const inspect = (value: unknown) => {
          if (!object(value)) return;
          const descriptor = Object.getOwnPropertyDescriptor(value, "conversationId");
          if (!descriptor) return;
          if (!Object.hasOwn(descriptor, "value")) throw null;
          const candidate: unknown = descriptor.value;
          if (!bounded(candidate, 512) || (identity !== undefined && candidate !== identity)) throw null;
          identity = candidate;
          sources.add(node);
        };
        inspect(own(node, "memoizedProps"));
        dependencies(node, inspect);
      }
      return { identity, sources };
    });
    const editorProof = identifiers[0]!;
    const timelineProof = identifiers[1]!;
    if (editorProof.identity === undefined || editorProof.identity !== timelineProof.identity
      || ![...editorProof.sources].some(source => timelineProof.sources.has(source))) throw null;
    let account: object | undefined;
    for (const node of accountProof.chains[0]!.slice(0, -1)) {
      dependencies(node, value => {
        if (!object(value)) return;
        const accounts = own(value, "accounts", true);
        if (accounts === undefined) return;
        if (!Array.isArray(accounts) || own(accounts, "length") !== 1) throw null;
        const candidate = own(accounts, "0");
        if (!object(candidate) || (account !== undefined && account !== candidate) || own(value, "inProgress") !== "none") throw null;
        account = candidate;
      });
    }
    if (!account || !bounded(own(account, "homeAccountId"), 512) || !bounded(own(account, "localAccountId"), 512)) throw null;
    const username = own(account, "username");
    if (!bounded(username, 256)) throw null;
    const displayed = readProfile();
    if (typeof displayed !== "string" || displayed.length > 256 || displayed.trim() !== username
      || Date.now() >= deadline || !conversation.current() || !accountProof.current()) throw null;
    return { status: "ok", sameCommittedRoot: true, conversationMatched: true, profileAccountMatched: true, ready: true };
  } catch { return { status: "refused" }; }
}

export function proveCompanyAIChatIdentityInDocument(input: { expectedUrl: string; editor: Element;
  timeline: Element; profile: Element; deadline: number; readProfile: () => unknown }):
  ReturnType<typeof proveCompanyAIChatIdentity> {
  try {
    const { expectedUrl, editor, timeline, profile, deadline, readProfile } = input;
    if (!Number.isFinite(deadline)) return { status: "refused" };
    if (Date.now() >= deadline) return { status: "expired" };
    if (typeof expectedUrl !== "string" || expectedUrl.length > 512) return { status: "refused" };
    const url = new URL(expectedUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || !/^chat\.app\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.com$/.test(url.hostname)) return { status: "refused" };
    const expectedWindow = window;
    const expectedDocument = document;
    const expectedLocation = location;
    const expectedRoot = document.documentElement;
    const ElementType = Element;
    const current = () => window === expectedWindow && document === expectedDocument && location === expectedLocation
      && window.document === document && window.location === location && window.top === window
      && document.defaultView === window && document.visibilityState === "visible"
      && location.href === expectedUrl && document.documentElement === expectedRoot && Element === ElementType
      && !!expectedRoot && [editor, timeline, profile].every(element => element instanceof ElementType
        && element.ownerDocument === expectedDocument && element.isConnected && expectedRoot.contains(element));
    const admitted = current();
    if (Date.now() >= deadline) return { status: "expired" };
    if (!admitted) return { status: "refused" };
    const result = proveCompanyAIChatIdentity(editor, timeline, profile, ElementType, deadline, readProfile);
    const stillCurrent = current();
    if (Date.now() >= deadline) return { status: "expired" };
    return stillCurrent ? result : { status: "refused" };
  } catch { return { status: "refused" }; }
}