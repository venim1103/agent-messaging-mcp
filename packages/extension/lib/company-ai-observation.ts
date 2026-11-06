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

export function locateCompanyAIChatReadTargets(input: { expectedUrl: string; deadline: number }) {
  try {
    const { expectedUrl, deadline } = input;
    const now = Date.now();
    if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 4000
      || typeof expectedUrl !== "string" || expectedUrl.length > 512
      || window.top !== window || document.visibilityState !== "visible" || location.href !== expectedUrl) return null;
    const url = new URL(expectedUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || !/^chat\.app\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.com$/.test(url.hostname)
      || [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]
        .some(name => /^(code|access_token|id_token|client_info|state|session_state)$/i.test(name))) return null;
    if (!document.body) return null;
    const visible: Element[] = [];
    const pending: { element: Element; depth: number }[] = [{ element: document.body, depth: 0 }];
    let visited = 0;
    while (pending.length) {
      if (Date.now() >= deadline || ++visited > 4096) return null;
      const { element, depth } = pending.pop()!;
      if (depth && element.nextElementSibling) pending.push({ element: element.nextElementSibling, depth });
      if (["script", "style", "template", "noscript", "iframe"].includes(element.localName)) continue;
      const style = getComputedStyle(element);
      if (element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true"
        || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) continue;
      if (element.getClientRects().length) visible.push(element);
      if (element.firstElementChild) {
        if (depth >= 64) return null;
        pending.push({ element: element.firstElementChild, depth: depth + 1 });
      }
    }
    const editors = visible.filter(element => element.localName === "textarea");
    if (editors.length !== 1 || !(editors[0] instanceof HTMLTextAreaElement)
      || editors[0].disabled || editors[0].readOnly) return null;
    const editor = editors[0];
    const profileSpans = visible.filter(element => element.localName === "span" && element.closest("nav")
      && !element.closest("a,button,[role=button]"));
    const profiles = profileSpans.filter(element => !profileSpans.some(child => child !== element && element.contains(child))
      && element.childNodes.length <= 32 && [...element.childNodes].some(child => child.nodeType === Node.TEXT_NODE));
    if (profiles.length !== 1) return null;
    const profile = profiles[0]!;
    const textContainers = visible.filter(element => ["p", "pre", "blockquote", "table", "ol", "ul"].includes(element.localName));
    const groups = new Map<Element, Element[]>();
    for (const element of visible) {
      if (Date.now() >= deadline) return null;
      const parent = element.parentElement;
      if (element.localName !== "div" || !element.hasAttribute("data-testid") || !parent
        || element.closest("nav") || element.contains(editor) || element.contains(profile)
        || !textContainers.some(text => element.contains(text))) continue;
      const rows = groups.get(parent) ?? [];
      rows.push(element);
      groups.set(parent, rows);
    }
    for (let ancestor = editor.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      if (Date.now() >= deadline) return null;
      const candidates = [...groups].filter(([timeline, rows]) => ancestor.contains(timeline)
        && !timeline.contains(editor) && !timeline.contains(profile) && rows.length <= 32);
      if (candidates.length > 1) return null;
      if (candidates.length === 1) {
        const [timeline, rows] = candidates[0]!;
        return { editor, timeline, profile, rows };
      }
    }
    return null;
  } catch { return null; }
}

export function locateCompanyAIChatComposer(input: { expectedUrl: string; deadline: number }) {
  try {
    const targets = locateCompanyAIChatReadTargets(input);
    if (!targets) return null;
    let composer: Element | null = targets.editor.form ?? targets.editor.parentElement;
    for (let depth = 0; composer && depth < 8; depth++, composer = composer.parentElement) {
      if (composer === document.body || composer.contains(targets.timeline) || composer.contains(targets.profile)) return null;
      if (composer.querySelector("button")) break;
    }
    if (!composer || composer.contains(targets.timeline) || composer.contains(targets.profile)
      || targets.editor.closest("[inert],[aria-disabled=true],[aria-readonly=true],fieldset:disabled")) return null;
    const buttons = new Map<HTMLButtonElement, string>();
    const pending: { node: Node; depth: number; hidden: boolean }[] = [{ node: composer, depth: 0, hidden: false }];
    let visited = 0;
    while (pending.length) {
      if (Date.now() >= input.deadline || ++visited > 512) return null;
      const { node, depth, hidden: ancestorHidden } = pending.pop()!;
      if (depth && node.nextSibling) pending.push({ node: node.nextSibling, depth, hidden: ancestorHidden });
      let hidden = ancestorHidden;
      if (node instanceof Element) {
        if (["script", "style", "template", "noscript"].includes(node.localName)) continue;
        if (["iframe", "object", "embed"].includes(node.localName)) return null;
        if (node === targets.editor) continue;
        if (node instanceof HTMLInputElement && node.type === "file" && node.files?.length !== 0) return null;
        const style = getComputedStyle(node);
        hidden ||= node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true"
          || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0;
        if (!hidden) {
          if (node instanceof HTMLButtonElement) {
            if (buttons.size >= 16) return null;
            buttons.set(node, "");
          } else if (!node.closest("button") && !["div", "span", "form", "section", "label"].includes(node.localName)) return null;
        }
      } else if (node.nodeType === Node.TEXT_NODE && !hidden) {
        const button = node.parentElement?.closest("button");
        if (!button || !buttons.has(button)) {
          if ((node as Text).length) return null;
        } else {
          const previous = buttons.get(button)!;
          if ((node as Text).length > 128 - previous.length) return null;
          const value = node.nodeValue;
          if (typeof value !== "string") return null;
          buttons.set(button, previous + value);
        }
      }
      if (node.firstChild) {
        if (depth >= 32) return null;
        pending.push({ node: node.firstChild, depth: depth + 1, hidden });
      }
    }
    const sending = [...buttons].filter(([, label]) => label.trim().toLowerCase() === "send");
    if (sending.length !== 1 || [...buttons.values()].some(label => /\bstop\b/i.test(label))) return null;
    const send = sending[0]![0];
    if (send.type === "reset" || send.closest("[inert],[aria-disabled=true]")) return null;
    return Date.now() < input.deadline && composer.isConnected && send.isConnected ? { ...targets, composer, send } : null;
  } catch { return null; }
}

type CompanyIdentityProof = { status: "ok"; sameCommittedRoot: true; conversationMatched: true;
  profileAccountMatched: true; ready: true } | { status: "refused" | "expired" };
type CompanyIdentitySnapshot = { rootState: object; account: object; conversationId: string;
  homeAccountId: string; localAccountId: string; username: string };
type CompanyIdentityRead = { proof: CompanyIdentityProof; snapshot?: CompanyIdentitySnapshot };
type CompanyDocumentInput = { expectedUrl: string; editor: Element; timeline: Element; profile: Element;
  deadline: number; readProfile: () => unknown };
type CompanyDocumentRead = { proof: CompanyIdentityProof;
  snapshot?: CompanyIdentitySnapshot & { document: Document; documentRoot: Element;
    window: Window; location: Location; ElementType: typeof Element } };

function readCompanyAIChatIdentity(editor: object, timeline: object, profile: object,
  ElementType: new () => object, deadline: number, readProfile: () => unknown): CompanyIdentityRead {
  try {
    if (!Number.isFinite(deadline)) return { proof: { status: "refused" } };
    if (Date.now() >= deadline) return { proof: { status: "expired" } };
    if (typeof readProfile !== "function" || new Set([editor, timeline, profile]).size !== 3) throw null;
    const object = (value: unknown): value is object => value !== null && typeof value === "object";
    const readings: { target: object; name: string; descriptor: PropertyDescriptor | undefined }[] = [];
    const descriptorOf = (target: object, name: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      readings.push({ target, name, descriptor });
      return descriptor;
    };
    const own = (target: object, name: string, optional = false): unknown => {
      const descriptor = descriptorOf(target, name);
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
      const current = () => own(rootState!, "current") === root && attachments.every(attachment => {
        const names = Object.getOwnPropertyNames(attachment.element);
        const matching = names.filter(name => name.startsWith("__reactFiber$"));
        return names.length <= 64 && matching.length === 1 && matching[0] === attachment.name
          && own(attachment.element, attachment.name) === attachment.attached;
      });
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
          const descriptor = descriptorOf(value, "conversationId");
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
    if (!account) throw null;
    const homeAccountId = own(account, "homeAccountId");
    const localAccountId = own(account, "localAccountId");
    if (!bounded(homeAccountId, 512) || !bounded(localAccountId, 512)) throw null;
    const username = own(account, "username");
    if (!bounded(username, 256)) throw null;
    const displayed = readProfile();
    if (typeof displayed !== "string" || displayed.length > 256 || displayed.trim() !== username
      || Date.now() >= deadline || !conversation.current() || !accountProof.current()) throw null;
    for (const reading of readings) {
      if (Date.now() >= deadline) throw null;
      const current = Object.getOwnPropertyDescriptor(reading.target, reading.name);
      if (reading.descriptor ? !current || !Object.hasOwn(current, "value")
        || current.value !== reading.descriptor.value : current !== undefined) throw null;
    }
    if (Date.now() >= deadline) throw null;
    return { proof: { status: "ok", sameCommittedRoot: true, conversationMatched: true, profileAccountMatched: true, ready: true },
      snapshot: { rootState: conversation.rootState, account, conversationId: editorProof.identity,
        homeAccountId, localAccountId, username } };
  } catch { return { proof: { status: "refused" } }; }
}

export function proveCompanyAIChatIdentity(editor: object, timeline: object, profile: object,
  ElementType: new () => object, deadline: number, readProfile: () => unknown): CompanyIdentityProof {
  return readCompanyAIChatIdentity(editor, timeline, profile, ElementType, deadline, readProfile).proof;
}

function readCompanyAIChatIdentityInDocument(input: CompanyDocumentInput): CompanyDocumentRead {
  try {
    const { expectedUrl, editor, timeline, profile, deadline, readProfile } = input;
    if (!Number.isFinite(deadline)) return { proof: { status: "refused" } };
    if (Date.now() >= deadline) return { proof: { status: "expired" } };
    if (typeof expectedUrl !== "string" || expectedUrl.length > 512) return { proof: { status: "refused" } };
    const url = new URL(expectedUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || !/^chat\.app\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.com$/.test(url.hostname)) return { proof: { status: "refused" } };
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
    if (Date.now() >= deadline) return { proof: { status: "expired" } };
    if (!admitted) return { proof: { status: "refused" } };
    const result = readCompanyAIChatIdentity(editor, timeline, profile, ElementType, deadline, readProfile);
    const stillCurrent = current();
    if (Date.now() >= deadline) return { proof: { status: "expired" } };
    if (!stillCurrent) return { proof: { status: "refused" } };
    return { proof: result.proof, ...(result.snapshot ? { snapshot: { ...result.snapshot,
      document: expectedDocument, documentRoot: expectedRoot, window: expectedWindow,
      location: expectedLocation, ElementType } } : {}) };
  } catch { return { proof: { status: "refused" } }; }
}

export function proveCompanyAIChatIdentityInDocument(input: CompanyDocumentInput): CompanyIdentityProof {
  return readCompanyAIChatIdentityInDocument(input).proof;
}

function captureCompanyAIChatIdentity(input: CompanyDocumentInput):
  { status: "ok"; check: (deadline?: number) => CompanyIdentityProof; dispose: () => void } | { status: "refused" | "expired" } {
  try {
    let request: CompanyDocumentInput | undefined = { ...input };
    let captured: CompanyDocumentRead["snapshot"];
    {
      const initial = readCompanyAIChatIdentityInDocument(request);
      if (initial.proof.status !== "ok") return initial.proof;
      captured = initial.snapshot;
      if (!captured) return { status: "refused" };
    }
    let terminal: { status: "refused" | "expired" } | undefined;
    let listenerWindow: Window | undefined = captured.window;
    let listenerDocument: Document | undefined = captured.document;
    let checking = false;
    const end = (proof: { status: "refused" | "expired" } = { status: "refused" }) => {
      terminal ??= proof;
      captured = undefined;
      request = undefined;
      try { listenerWindow?.removeEventListener("pagehide", pageHidden); } catch {}
      try { listenerDocument?.removeEventListener("visibilitychange", visibilityChanged); } catch {}
      listenerWindow = undefined;
      listenerDocument = undefined;
      return terminal;
    };
    const pageHidden = () => { end(); };
    const visibilityChanged = () => {
      try { if (listenerDocument?.visibilityState !== "visible") end(); } catch { end(); }
    };
    try {
      listenerWindow.addEventListener("pagehide", pageHidden);
      listenerDocument.addEventListener("visibilitychange", visibilityChanged);
    } catch { return end(); }
    if (terminal || !request) return end();
    if (Date.now() >= request.deadline) return end({ status: "expired" });
    return { status: "ok", dispose: () => { end(); }, check: (deadline?: number) => {
      if (terminal) return terminal;
      if (checking || !request) return end();
      checking = true;
      const fresh = readCompanyAIChatIdentityInDocument(deadline === undefined ? request : { ...request, deadline });
      checking = false;
      if (terminal) return terminal;
      const current = fresh.snapshot;
      if (fresh.proof.status !== "ok" || !current || !captured
        || current.rootState !== captured.rootState || current.account !== captured.account
        || current.conversationId !== captured.conversationId || current.homeAccountId !== captured.homeAccountId
        || current.localAccountId !== captured.localAccountId || current.username !== captured.username
        || current.document !== captured.document || current.documentRoot !== captured.documentRoot
        || current.window !== captured.window || current.location !== captured.location
        || current.ElementType !== captured.ElementType) {
        return end(fresh.proof.status === "ok" ? { status: "refused" } : fresh.proof);
      }
      return fresh.proof;
    } };
  } catch { return { status: "refused" }; }
}

export function createCompanyAIChatIdentityCheck(input: CompanyDocumentInput):
  { status: "ok"; check: () => CompanyIdentityProof; dispose: () => void } | { status: "refused" | "expired" } {
  const captured = captureCompanyAIChatIdentity(input);
  return captured.status === "ok" ? { status: "ok", check: () => captured.check(), dispose: captured.dispose } : captured;
}

export function createCompanyAIChatIdentityBinding(input: CompanyDocumentInput):
  { status: "ok"; conversationId: string; check: (deadline: number) => CompanyIdentityProof; dispose: () => void }
  | { status: "refused" | "expired" } {
  let captured: ReturnType<typeof captureCompanyAIChatIdentity> | undefined;
  try {
    const request = { ...input };
    const now = Date.now();
    if (!Number.isFinite(request.deadline) || request.deadline > now + 4000) return { status: "refused" };
    if (request.deadline <= now) return { status: "expired" };
    const url = new URL(request.expectedUrl);
    if ([...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]
      .some(name => /^(code|access_token|id_token|client_info|state|session_state)$/i.test(name))) return { status: "refused" };
    const binding = captureCompanyAIChatIdentity(request);
    captured = binding;
    if (binding.status !== "ok") return binding;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const proof = binding.check();
    if (proof.status !== "ok") { binding.dispose(); return proof; }
    const conversationId = `company_ai_${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`;
    return { status: "ok", conversationId, dispose: binding.dispose, check: (deadline: number) => {
      const now = Date.now();
      return binding.check(!Number.isFinite(deadline) || deadline > now + 4000 ? NaN : deadline);
    } };
  } catch {
    if (captured?.status === "ok") captured.dispose();
    return { status: "refused" };
  }
}

export type CompanyRenderedSnapshot = { messages: { direction: "incoming" | "outgoing" | "unknown"; text: string; truncated?: true }[]; omittedBefore: true };

export function createCompanyAIChatReadBinding(input: { expectedUrl: string; deadline: number }):
  { status: "ok"; conversationId: string; check: (deadline: number) => boolean;
    checkEditor: (editor: Element, deadline: number) => boolean;
    capture: (deadline: number) => CompanyRenderedSnapshot | null; dispose: () => void } | { status: "refused" | "expired" } {
  let disposeOnError: (() => void) | undefined;
  try {
    const expectedUrl = input.expectedUrl;
    let targets = locateCompanyAIChatReadTargets(input) ?? undefined;
    if (!targets) return { status: input.deadline <= Date.now() ? "expired" : "refused" };
    const readProfile = () => {
      if (!targets || targets.profile.childNodes.length > 32) return null;
      let text = "";
      for (const node of targets.profile.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const value = node.nodeValue;
        if (typeof value !== "string" || value.length > 256 - text.length) return null;
        text += value;
      }
      return text;
    };
    const identity = createCompanyAIChatIdentityBinding({ ...input, editor: targets.editor,
      timeline: targets.timeline, profile: targets.profile, readProfile });
    if (identity.status !== "ok") return identity;
    let listenerWindow: Window | undefined = window;
    let listenerDocument: Document | undefined = document;
    const dispose = () => {
      identity.dispose(); targets = undefined;
      try { listenerWindow?.removeEventListener("pagehide", dispose); } catch {}
      try { listenerDocument?.removeEventListener("visibilitychange", visibilityChanged); } catch {}
      listenerWindow = undefined; listenerDocument = undefined;
    };
    const visibilityChanged = () => {
      try { if (listenerDocument?.visibilityState !== "visible") dispose(); } catch { dispose(); }
    };
    disposeOnError = dispose;
    listenerWindow.addEventListener("pagehide", dispose);
    listenerDocument.addEventListener("visibilitychange", visibilityChanged);
    const check = (deadline: number) => {
      const current = targets && locateCompanyAIChatReadTargets({ expectedUrl, deadline });
      if (!current || !targets || current.editor !== targets.editor || current.timeline !== targets.timeline
        || current.profile !== targets.profile || identity.check(deadline).status !== "ok") {
        dispose(); return false;
      }
      return true;
    };
    return { status: "ok", conversationId: identity.conversationId, check, dispose,
      checkEditor: (editor, deadline) => targets?.editor === editor && check(deadline), capture: (deadline: number) => {
      try {
        if (!check(deadline) || !targets) return null;
        const current = locateCompanyAIChatReadTargets({ expectedUrl, deadline });
        if (!current) return null;
        const messages: CompanyRenderedSnapshot["messages"] = [];
        const encoder = new TextEncoder();
        let bytesLeft = 96 * 1024 - encoder.encode(JSON.stringify({ messages: [], omittedBefore: true })).length;
        let visited = 0;
        for (const row of [...current.rows].reverse()) {
          if (!bytesLeft) break;
          const classes = row.getAttribute("class") ?? "";
          const roles = classes.length <= 256 ? new Set(classes.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
            .split(/[^a-z]+/).filter(token => token === "user" || token === "assistant")) : new Set<string>();
          const direction = roles.size === 1 ? roles.has("user") ? "outgoing" : "incoming" : "unknown";
          let text = "";
          let truncated = false;
          const pending: { node: Node; depth: number }[] = [{ node: row, depth: 0 }];
          while (pending.length) {
            if (Date.now() >= deadline || ++visited > 4096) return null;
            const { node, depth } = pending.pop()!;
            if (depth && node.nextSibling) pending.push({ node: node.nextSibling, depth });
            if (node.nodeType === Node.TEXT_NODE) {
              const value = node.nodeValue;
              if (typeof value !== "string") return null;
              if (value.length > 16000 - text.length) truncated = true;
              text += value.slice(0, 16000 - text.length);
              if (truncated) break;
            } else if (node instanceof Element) {
              if (["button", "input", "textarea", "select", "script", "style", "template", "noscript", "iframe", "svg", "img"].includes(node.localName)
                || node.getAttribute("role") === "button" || node.hasAttribute("hidden") || node.hasAttribute("inert")
                || node.getAttribute("aria-hidden") === "true") continue;
              const style = getComputedStyle(node);
              if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) continue;
              if (["p", "pre", "blockquote", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6"].includes(node.localName)
                && text && !text.endsWith("\n")) {
                if (text.length >= 16000) { truncated = true; break; }
                text += "\n";
              }
              if (node.firstChild) {
                if (depth >= 64) return null;
                pending.push({ node: node.firstChild, depth: depth + 1 });
              }
            }
          }
          text = text.trim();
          const cost = (value: string) => encoder.encode(JSON.stringify({ direction, text: value,
            ...(truncated ? { truncated: true } : {}) })).length + (messages.length ? 1 : 0);
          if (cost(text) > bytesLeft) {
            truncated = true;
            let lower = 0;
            let upper = text.length;
            while (lower < upper) {
              const middle = Math.ceil((lower + upper) / 2);
              if (cost(text.slice(0, middle)) <= bytesLeft) lower = middle;
              else upper = middle - 1;
            }
            text = text.slice(0, lower);
            truncated = true;
          }
          if (!text) continue;
          bytesLeft -= cost(text);
          messages.unshift({ direction, text, ...(truncated ? { truncated: true as const } : {}) });
        }
        return check(deadline) && messages.length ? { messages, omittedBefore: true } : null;
      } catch { return null; }
    } };
  } catch { disposeOnError?.(); return { status: "refused" }; }
}