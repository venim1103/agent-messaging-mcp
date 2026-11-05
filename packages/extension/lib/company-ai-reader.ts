import { createCompanyAIChatReadBinding, type CompanyRenderedSnapshot } from "./company-ai-observation.ts";
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
  return true;
}

export function invokeCompanyAIChatReader(input: CompanyReaderRequest): CompanyReaderResult {
  try {
    const installed = Object.getOwnPropertyDescriptor(globalThis, "agentCompanyAIChatReader");
    const method = installed && "value" in installed
      && Object.getOwnPropertyDescriptor(installed.value, "request");
    return method && "value" in method && typeof method.value === "function" ? method.value(input) : null;
  } catch { return null; }
}