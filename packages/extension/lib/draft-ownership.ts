export type DraftOwnershipTracker = {
  begin(operationId: string, text: string, expectedUrl: string, editor: HTMLElement, root: HTMLElement,
    leftover?: { operationId: string; text: string }): boolean;
  confirm(operationId: string): boolean;
  matches(operationId: string, text: string, expectedUrl: string, editor: HTMLElement, root: HTMLElement): boolean;
  release(operationId: string): void;
};

export function installDraftOwnershipTracker(): void {
  const scope = globalThis as typeof globalThis & { agentDraftOwnership?: DraftOwnershipTracker };
  if (scope.agentDraftOwnership) return;
  let record: {
    operationId: string; text: string; expectedUrl: string; editor: HTMLElement; root: HTMLElement;
    filling: boolean; inserted: string; pendingChange: boolean; invalid: boolean;
  } | null = null;
  const textOf = (editor: HTMLElement) => editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
  const inspectMutations = (mutations: MutationRecord[]) => {
    if (!record) return;
    for (const mutation of mutations) {
      if ([...mutation.removedNodes].some(node => node === record!.editor || node === record!.root
        || node.contains(record!.editor) || node.contains(record!.root))) record.invalid = true;
      if (!record.filling && (mutation.target === record.editor || record.editor.contains(mutation.target)
        || (mutation.type === "attributes" && (mutation.target === record.root || mutation.target.contains(record.root))))) {
        record.invalid = true;
      }
    }
  };
  const observer = new MutationObserver(inspectMutations);
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["contenteditable", "disabled", "readonly", "aria-readonly", "aria-disabled", "hidden", "inert", "value",
      "data-conversation-id", "data-chat-contract", "data-chat-ready", "data-chat-account", "data-chat-peer", "data-chat-channel",
      "data-chat-draft-safe", "aria-label", "placeholder", "role", "style", "class"] });
  const invalidate = (event: Event) => {
    if (!record || !(event.target instanceof Node)
      || (event.target !== record.editor && !record.editor.contains(event.target))) return;
    if (event.type === "change" && event.isTrusted && !record.filling && record.pendingChange
      && textOf(record.editor) === record.text) {
      record.pendingChange = false;
      return;
    }
    if (record.filling && event instanceof InputEvent && event.type === "input" && event.isTrusted
      && event.inputType === "insertText" && (typeof event.data === "string" || event.data === null)) {
      record.inserted += event.data ?? "\n";
      if (record.inserted.length > record.text.length) record.invalid = true;
    }
    else record.invalid = true;
  };
  for (const kind of ["beforeinput", "input", "change", "keydown", "pointerdown", "paste", "cut", "drop"]) {
    document.addEventListener(kind, invalidate, true);
  }
  document.addEventListener("visibilitychange", () => { if (record) record.invalid = true; }, true);
  window.addEventListener("pagehide", () => { record = null; }, true);
  const current = () => {
    inspectMutations(observer.takeRecords());
    if (!record) return null;
    if (window.top !== window || document.visibilityState !== "visible" || location.href !== record.expectedUrl
      || !record.root.isConnected || !record.editor.isConnected || !record.root.contains(record.editor)
      || textOf(record.editor) !== record.text) record.invalid = true;
    return record.invalid ? null : record;
  };
  scope.agentDraftOwnership = Object.freeze({
    begin(operationId, text, expectedUrl, editor, root, leftover) {
      const previous = leftover ? current() : null;
      const replaceable = previous && !previous.filling && previous.operationId === leftover?.operationId
        && previous.text === leftover.text && previous.expectedUrl === expectedUrl && previous.editor === editor && previous.root === root;
      record = null;
      observer.takeRecords();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)
        || !text || text.length > 2048 || location.href !== expectedUrl || window.top !== window
        || document.visibilityState !== "visible" || !editor.isConnected || !root.isConnected
        || !root.contains(editor) || (leftover ? !replaceable : textOf(editor).length > 0)) return false;
      record = { operationId, text, expectedUrl, editor, root, filling: true, inserted: "", pendingChange: false, invalid: false };
      return true;
    },
    confirm(operationId) {
      const owned = current();
      if (!owned || owned.operationId !== operationId || !owned.filling || owned.inserted !== owned.text) {
        if (record) record.invalid = true;
        return false;
      }
      owned.filling = false;
      owned.pendingChange = owned.editor instanceof HTMLTextAreaElement;
      return true;
    },
    matches(operationId, text, expectedUrl, editor, root) {
      const owned = current();
      return Boolean(owned && !owned.filling && owned.operationId === operationId && owned.text === text
        && owned.expectedUrl === expectedUrl && owned.editor === editor && owned.root === root);
    },
    release(operationId) { if (record?.operationId === operationId) record = null; }
  });
}