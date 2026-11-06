import { createCompanyAIChatReadBinding, locateCompanyAIChatComposer, type CompanyRenderedSnapshot } from "./company-ai-observation.ts";
import { installDraftOwnershipTracker } from "./draft-ownership.ts";
import { isEligibleCompanyAIChatUrl } from "./provider-origins.ts";

export type CompanyReaderRequest = { action: "bind" | "check" | "capture" | "dispose"; url: string;
  deadline: number; conversationId?: string };
export type CompanyReaderResult = { url: string; conversationId: string; snapshot?: CompanyRenderedSnapshot } | null;

export function installCompanyAIChatReader(origins: readonly string[]): boolean {
  if (!isEligibleCompanyAIChatUrl(location.href, origins) || window.top !== window) return false;
  const marker = "agentCompanyAIChatReader";
  const existing = Object.getOwnPropertyDescriptor(globalThis, marker);
  if (existing) {
    if (!("value" in existing) || typeof existing.value !== "object" || existing.value === null) return false;
    const version = Object.getOwnPropertyDescriptor(existing.value, "version");
    const origin = Object.getOwnPropertyDescriptor(existing.value, "origin");
    const method = Object.getOwnPropertyDescriptor(existing.value, "request");
    return !!version && "value" in version && version.value === 1 && !!origin && "value" in origin
      && origin.value === origins[0] && !!method && "value" in method && typeof method.value === "function";
  }
  let binding: Extract<ReturnType<typeof createCompanyAIChatReadBinding>, { status: "ok" }> | undefined;
  let boundUrl: string | undefined;
  const request = (input: CompanyReaderRequest): CompanyReaderResult => {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).length !== (input.conversationId === undefined ? 3 : 4)
      || !["bind", "check", "capture", "dispose"].includes(input.action)
      || !isEligibleCompanyAIChatUrl(input.url, origins) || location.href !== input.url
      || !Number.isFinite(input.deadline) || input.deadline <= Date.now() || input.deadline > Date.now() + 4000) return null;
    if (input.action === "bind") {
      if (input.conversationId !== undefined) return null;
      if (boundUrl !== input.url || !binding?.check(input.deadline)) {
        binding?.dispose();
        binding = undefined;
        boundUrl = undefined;
        const created = createCompanyAIChatReadBinding({ expectedUrl: input.url, deadline: input.deadline });
        if (created.status !== "ok") return null;
        binding = created;
        boundUrl = input.url;
      }
    } else if (!binding || boundUrl !== input.url || input.conversationId !== binding.conversationId) return null;
    if (input.action === "dispose") {
      binding?.dispose(); binding = undefined; boundUrl = undefined;
      return null;
    }
    if (!binding?.check(input.deadline)) return null;
    const snapshot = input.action === "capture" ? binding.capture(input.deadline) : undefined;
    if (input.action === "capture" && !snapshot) return null;
    return { url: input.url, conversationId: binding.conversationId, ...(snapshot ? { snapshot } : {}) };
  };
  Object.defineProperty(globalThis, marker, { value: Object.freeze({ version: 1, origin: origins[0], request }),
    enumerable: false, writable: false, configurable: false });
  const receive = (event: Event) => {
    try {
      if (!(event instanceof CustomEvent) || !(event.target instanceof HTMLTextAreaElement)
        || typeof event.detail !== "string" || event.detail.length > 512) return;
      const input: unknown = JSON.parse(event.detail);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 3) return;
      const { nonce, conversationId, deadline } = input as { nonce?: unknown; conversationId?: unknown; deadline?: unknown };
      if (typeof nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)
        || typeof conversationId !== "string" || !/^company_ai_[a-f0-9]{64}$/.test(conversationId)
        || typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 4000) return;
      const valid = boundUrl === location.href && binding?.conversationId === conversationId
        && binding.checkEditor(event.target, deadline) === true;
      event.target.dispatchEvent(new CustomEvent("agent-company-identity-response-v1", {
        detail: JSON.stringify({ nonce, valid: valid === true }) }));
    } catch {}
  };
  window.addEventListener("agent-company-identity-v1", receive, true);
  window.addEventListener("pagehide", () => window.removeEventListener("agent-company-identity-v1", receive, true), { once: true });
  return true;
}

export function checkCompanyAIChatIdentity(editor: HTMLTextAreaElement, conversationId: string, deadline: number): boolean {
  if (!(editor instanceof HTMLTextAreaElement) || editor.ownerDocument !== document || !editor.isConnected
    || !/^company_ai_[a-f0-9]{64}$/.test(conversationId) || !Number.isFinite(deadline)
    || deadline <= Date.now() || deadline > Date.now() + 4000) return false;
  const nonce = crypto.randomUUID();
  let valid = false;
  let received = 0;
  const receive = (event: Event) => {
    if (!(event instanceof CustomEvent) || event.target !== editor || typeof event.detail !== "string" || event.detail.length > 128) return;
    try {
      const result = JSON.parse(event.detail);
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 2
        || result.nonce !== nonce || typeof result.valid !== "boolean") return;
      received++; valid = result.valid;
    } catch {}
  };
  editor.addEventListener("agent-company-identity-response-v1", receive);
  try {
    editor.dispatchEvent(new CustomEvent("agent-company-identity-v1", { bubbles: true,
      detail: JSON.stringify({ nonce, conversationId, deadline }) }));
    return received === 1 && valid && Date.now() < deadline;
  } catch { return false; }
  finally { editor.removeEventListener("agent-company-identity-response-v1", receive); }
}

export function invokeCompanyAIChatReader(input: CompanyReaderRequest): CompanyReaderResult {
  try {
    const installed = Object.getOwnPropertyDescriptor(globalThis, "agentCompanyAIChatReader");
    const method = installed && "value" in installed
      && Object.getOwnPropertyDescriptor(installed.value, "request");
    return method && "value" in method && typeof method.value === "function" ? method.value(input) : null;
  } catch { return null; }
}

type CompanyDraftInput = { expectedUrl: string; conversationId: string; text: string; deadline: number;
  draftState?: "empty" | "prepared" };
type CompanyFillInput = CompanyDraftInput & { operationId: string; attemptId: string; expiresAt: number };
type CompanyDraftFailure = { ok: false; code: "TARGET_CHANGED" | "UNSUPPORTED_MESSAGE_TEXT" | "COMPOSER_UNAVAILABLE"
  | "DRAFT_PRESENT" | "DRAFT_CHANGED" | "SUBMIT_UNAVAILABLE" | "FILL_UNAVAILABLE" | "FILL_UNCERTAIN"
  | "DISPATCH_UNAVAILABLE" | "DISPATCH_UNCERTAIN" };
type CompanyDraftResult = { ok: true; editor: "textarea" } | CompanyDraftFailure;
type CompanySubmitResult = { ok: true; editor: "textarea"; activated: true } | CompanyDraftFailure;
type CompanyWriter = { version: 1; origin: string; inspect(input: CompanyDraftInput): CompanyDraftResult;
  fill(input: CompanyFillInput): CompanyDraftResult; submit(input: CompanyFillInput): CompanySubmitResult };

export function installCompanyAIChatWriter(origins: readonly string[]): boolean {
  if (!isEligibleCompanyAIChatUrl(location.href, origins) || window.top !== window) return false;
  const marker = "agentCompanyAIChatWriter";
  const existing = Object.getOwnPropertyDescriptor(globalThis, marker);
  if (existing) {
    if (!("value" in existing) || !existing.value || typeof existing.value !== "object") return false;
    return ["version", "origin", "inspect", "fill", "submit"].every(name => {
      const property = Object.getOwnPropertyDescriptor(existing.value, name);
      return property && "value" in property && (name === "version" ? property.value === 1
        : name === "origin" ? property.value === origins[0] : typeof property.value === "function");
    });
  }
  const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const fillAttempts = new Set<string>();
  const submitAttempts = new Set<string>();
  const inspectTargets = (input: CompanyDraftInput, allowDisabledSend = false) => {
    if (!input || input.expectedUrl !== location.href || !isEligibleCompanyAIChatUrl(input.expectedUrl, origins)
      || !Number.isFinite(input.deadline) || input.deadline <= Date.now() || input.deadline > Date.now() + 4000) {
      return { ok: false as const, code: "TARGET_CHANGED" as const };
    }
    if (typeof input.text !== "string" || !input.text || input.text !== input.text.trim() || input.text.includes("\r")
      || input.text.length > 2048 || new TextEncoder().encode(input.text).length > 4000) {
      return { ok: false as const, code: "UNSUPPORTED_MESSAGE_TEXT" as const };
    }
    const targets = locateCompanyAIChatComposer({ expectedUrl: input.expectedUrl, deadline: input.deadline });
    if (!targets || !checkCompanyAIChatIdentity(targets.editor, input.conversationId, input.deadline)) {
      return { ok: false as const, code: "TARGET_CHANGED" as const };
    }
    for (const [element, code] of [[targets.editor, "COMPOSER_UNAVAILABLE"], [targets.send, "SUBMIT_UNAVAILABLE"]] as const) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) {
        return { ok: false as const, code };
      }
      if (element === targets.send && allowDisabledSend && element.matches(":disabled")) continue;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || (hit !== element && !element.contains(hit))) return { ok: false as const, code };
    }
    if (targets.editor.maxLength >= 0 && input.text.length > targets.editor.maxLength) {
      return { ok: false as const, code: "UNSUPPORTED_MESSAGE_TEXT" as const };
    }
    return { ok: true as const, ...targets };
  };
  const inspect = (input: CompanyDraftInput): CompanyDraftResult => {
    try {
      const found = inspectTargets(input, input?.draftState !== "prepared");
      if (!found.ok) return found;
      if (input.draftState !== undefined && input.draftState !== "empty" && input.draftState !== "prepared") {
        return { ok: false, code: "COMPOSER_UNAVAILABLE" };
      }
      if (input.draftState === "prepared" ? found.editor.value !== input.text : found.editor.value.length !== 0) {
        return { ok: false, code: "DRAFT_PRESENT" };
      }
      if (input.draftState === "prepared" && found.send.matches(":disabled")) return { ok: false, code: "SUBMIT_UNAVAILABLE" };
      return checkCompanyAIChatIdentity(found.editor, input.conversationId, input.deadline)
        ? { ok: true, editor: "textarea" } : { ok: false, code: "TARGET_CHANGED" };
    } catch { return { ok: false, code: "COMPOSER_UNAVAILABLE" }; }
  };
  const fill = (input: CompanyFillInput): CompanyDraftResult => {
    if (!input || !identifier.test(input.operationId) || !identifier.test(input.attemptId)
      || !Number.isSafeInteger(input.expiresAt) || input.deadline !== input.expiresAt
      || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 4000
      || fillAttempts.has(input.attemptId) || fillAttempts.size >= 100) return { ok: false, code: "FILL_UNAVAILABLE" };
    fillAttempts.add(input.attemptId);
    let inserted = false;
    try {
      const before = inspectTargets(input, true);
      if (!before.ok) return before;
      if (before.editor.value.length) return { ok: false, code: "DRAFT_PRESENT" };
      HTMLElement.prototype.focus.call(before.editor, { preventScroll: true });
      HTMLTextAreaElement.prototype.setSelectionRange.call(before.editor, 0, 0);
      const ready = inspectTargets(input, true);
      if (!ready.ok) return ready;
      if (ready.editor !== before.editor || ready.composer !== before.composer || ready.send !== before.send
        || document.activeElement !== ready.editor || ready.editor.value.length || Date.now() >= input.expiresAt) {
        return { ok: false, code: "FILL_UNAVAILABLE" };
      }
      installDraftOwnershipTracker();
      const ownership = (globalThis as typeof globalThis & { agentDraftOwnership?: import("./draft-ownership.ts").DraftOwnershipTracker }).agentDraftOwnership;
      if (!(ready.composer instanceof HTMLElement) || !ownership?.begin(input.operationId, input.text, input.expectedUrl,
        ready.editor, ready.composer)) return { ok: false, code: "FILL_UNAVAILABLE" };
      if (!checkCompanyAIChatIdentity(ready.editor, input.conversationId, input.deadline)) return { ok: false, code: "TARGET_CHANGED" };
      inserted = true;
      if (!Document.prototype.execCommand.call(document, "insertText", false, input.text)) return { ok: false, code: "FILL_UNCERTAIN" };
      const after = inspectTargets(input, true);
      if (!after.ok || after.editor !== ready.editor || after.composer !== ready.composer || after.send !== ready.send
        || document.activeElement !== ready.editor || ready.editor.value !== input.text || !ownership.confirm(input.operationId)
        || Date.now() >= input.expiresAt) return { ok: false, code: "FILL_UNCERTAIN" };
      return { ok: true, editor: "textarea" };
    } catch { return { ok: false, code: inserted ? "FILL_UNCERTAIN" : "FILL_UNAVAILABLE" }; }
  };
  const submit = (input: CompanyFillInput): CompanySubmitResult => {
    if (!input || !identifier.test(input.operationId) || input.attemptId !== input.operationId
      || submitAttempts.has(input.operationId) || submitAttempts.size >= 100) return { ok: false, code: "DISPATCH_UNAVAILABLE" };
    submitAttempts.add(input.operationId);
    let activated = false;
    try {
      if (!Number.isSafeInteger(input.expiresAt) || input.deadline !== input.expiresAt) return { ok: false, code: "DISPATCH_UNAVAILABLE" };
      const before = inspectTargets(input);
      if (!before.ok) return before;
      if (before.editor.value !== input.text) return { ok: false, code: "DRAFT_CHANGED" };
      if (before.send.matches(":disabled")) return { ok: false, code: "SUBMIT_UNAVAILABLE" };
      HTMLElement.prototype.focus.call(before.send, { preventScroll: true });
      const ready = inspectTargets(input);
      if (!ready.ok) return ready;
      if (ready.editor !== before.editor || ready.composer !== before.composer || ready.send !== before.send
        || document.activeElement !== ready.send || ready.send.matches(":disabled") || ready.editor.value !== input.text
        || Date.now() >= input.expiresAt) return { ok: false, code: "DISPATCH_UNAVAILABLE" };
      if (!checkCompanyAIChatIdentity(ready.editor, input.conversationId, input.deadline)) return { ok: false, code: "TARGET_CHANGED" };
      activated = true;
      HTMLElement.prototype.click.call(ready.send);
      return { ok: true, editor: "textarea", activated: true };
    } catch { return { ok: false, code: activated ? "DISPATCH_UNCERTAIN" : "DISPATCH_UNAVAILABLE" }; }
  };
  Object.defineProperty(globalThis, marker, { value: Object.freeze({ version: 1, origin: origins[0], inspect, fill, submit }),
    enumerable: false, writable: false, configurable: false });
  return true;
}

export function inspectCompanyAIChatDraft(input: CompanyDraftInput): CompanyDraftResult {
  return (globalThis as typeof globalThis & { agentCompanyAIChatWriter?: CompanyWriter }).agentCompanyAIChatWriter?.inspect(input)
    ?? { ok: false, code: "TARGET_CHANGED" };
}

export function fillCompanyAIChatDraft(input: CompanyFillInput): CompanyDraftResult {
  return (globalThis as typeof globalThis & { agentCompanyAIChatWriter?: CompanyWriter }).agentCompanyAIChatWriter?.fill(input)
    ?? { ok: false, code: "TARGET_CHANGED" };
}

export function submitCompanyAIChatDraft(input: CompanyFillInput): CompanySubmitResult {
  return (globalThis as typeof globalThis & { agentCompanyAIChatWriter?: CompanyWriter }).agentCompanyAIChatWriter?.submit(input)
    ?? { ok: false, code: "TARGET_CHANGED" };
}