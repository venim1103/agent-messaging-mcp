import { browser } from "wxt/browser";
import { geminiDraftText } from "../lib/approved-probe";
import { captureFixtureSnapshot, inspectFixturePreflight, observeFixtureMessages } from "../lib/fixture-observation";
import { captureGeminiSnapshot, identifyGeminiConversation, isEligibleGeminiUrl,
  observeGeminiIdentity, observeGeminiMessages }
  from "../lib/gemini-observation";

const nativeHostName = "com.agent_messaging_mcp.bridge";
const protocolVersion = 1;
const richFixtureUrl = "http://127.0.0.1:8787/?editor=rich";
const fixtureInputText = "Fixture debugger probe \u00e9";
const geminiOrigin = "https://gemini.google.com";

type ProbeResult = { ok: true; protocolVersion: number } | { ok: false; error: string };
type FixtureInputResult = { ok: true; characters: number } | { ok: false; error: string };
type PendingListResult = { ok: true; requests: { requestId: string; expiresAt: number }[] }
  | { ok: false; error: string };
type FixtureApprovalResult = { ok: true; requestId: string; expiresAt: number }
  | { ok: false; error: string };
type FixtureReviewsResult = { ok: true; reviews: { operationId: string; expiresAt: number;
  reviewId: string; preview: { target: "fixture-alpha"; text: string } }[]; hasMore: boolean }
  | { ok: false; error: string };
type FixtureReviewApprovalResult = { ok: true; operationId: string; expiresAt: number }
  | { ok: false; error: string };
type FixturePreflightChallenge = { challengeId: string; operationId: string; expiresAt: number;
  tabId: number; documentId: string; text: string };

let inputInProgress = false;
const fixtureResetKey = "fixture-reset-done";
const fixtureGrantKey = (tabId: number) => `fixture-grant-${tabId}`;
const geminiGrantKey = (tabId: number) => `gemini-grant-${tabId}`;
const geminiStatusKey = (tabId: number) => `gemini-grant-status-${tabId}`;
type StoredFixtureGrant = { documentId: string; expiresAt: number };
type StoredGeminiGrant = { documentId: string; url: string; expiresAt: number };
type GeminiGrantStatus = { code: "target_changed" | "observation_unavailable"; recordedAt: number };
type GrantCountRequest = { kind: "revoke_fixture"; payload: {
  tabId: number; observed: { documentId: string; conversationId: string } | null
} } | { kind: "revoke_all_fixture"; payload: Record<string, never> }
  | { kind: "mark_fixture_observation_gap"; payload: { target: {
    origin: "http://127.0.0.1:8787"; conversationId: "fixture-alpha";
    tabId: number; documentId: string
  } } } | { kind: "mark_gemini_observation_gap"; payload: { target: {
    origin: "https://gemini.google.com"; conversationId: string; url: string;
    tabId: number; documentId: string
  } } };
let fixtureResetPromise: Promise<boolean> | undefined;
const fixtureSnapshotJobs = new Map<number, Promise<boolean>>();
const geminiSnapshotJobs = new Map<number, Promise<boolean>>();
let fixtureReadWatch: ReturnType<typeof browser.runtime.connectNative> | undefined;
let geminiReadWatch: ReturnType<typeof browser.runtime.connectNative> | undefined;

async function recordGeminiGrantStatus(tabId: number, code: GeminiGrantStatus["code"]): Promise<void> {
  const key = geminiStatusKey(tabId);
  const previous = (await browser.storage.session.get(key))[key] as GeminiGrantStatus | undefined;
  if (previous?.recordedAt && Date.now() - previous.recordedAt < 5 * 60_000) return;
  await browser.storage.session.set({ [key]: { code, recordedAt: Date.now() } satisfies GeminiGrantStatus });
}

async function classifyGeminiPublicationFailure(tabId: number, expectedUrl: string,
  documentId: string): Promise<GeminiGrantStatus["code"]> {
  try {
    if ((await browser.tabs.get(tabId)).url !== expectedUrl) return "target_changed";
    const [current] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: identifyGeminiConversation
    });
    return current?.frameId === 0 && current.documentId === documentId
      ? "observation_unavailable" : "target_changed";
  } catch {
    return "target_changed";
  }
}

async function revokeTrackedFixture(tabId: number, geminiReason?: GeminiGrantStatus["code"]): Promise<void> {
  const keys = [fixtureGrantKey(tabId), geminiGrantKey(tabId)];
  const stored = await browser.storage.session.get(keys);
  const active: string[] = [];
  for (const key of keys) {
    const grant = stored[key] as StoredFixtureGrant | StoredGeminiGrant | undefined;
    if (!grant) continue;
    if (typeof grant.expiresAt === "number" && grant.expiresAt <= Date.now()) {
      await browser.storage.session.remove(key);
    } else {
      active.push(key);
    }
  }
  if (active.length && await revokeFixtureTab(tabId, null)) {
    if (geminiReason && active.includes(geminiGrantKey(tabId))) {
      await recordGeminiGrantStatus(tabId, geminiReason).catch(() => {});
    }
    await browser.storage.session.remove(active);
  }
}

async function revokeFixtureTab(tabId: number,
  observed: { documentId: string; conversationId: string } | null): Promise<boolean> {
  return sendGrantCountRequest({ kind: "revoke_fixture", payload: { tabId, observed } });
}

async function sendGrantCountRequest(command: GrantCountRequest): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish(false), 10_000);

      function finish(ok: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return finish(false);
        const reply = value as Record<string, unknown>;
        const payload = reply.payload;
        finish(reply.kind === (command.kind === "mark_fixture_observation_gap" ? "fixture_gap_marked"
          : command.kind === "mark_gemini_observation_gap" ? "gemini_gap_marked" : "fixture_revoked")
          && reply.protocolVersion === protocolVersion
          && reply.requestId === requestId && reply.connectionGeneration === 0 && reply.deadlineMs === deadlineMs
          && typeof payload === "object" && payload !== null && !Array.isArray(payload)
          && Object.keys(payload).length === 1 && typeof (payload as { count?: unknown }).count === "number"
          && Number.isSafeInteger((payload as { count: number }).count)
          && (payload as { count: number }).count >= 0);
      });
      port.onDisconnect.addListener(() => { void browser.runtime.lastError; finish(false); });
      port.postMessage({ ...command, protocolVersion, requestId,
        connectionGeneration: 0, deadlineMs });
    });
  } catch {
    return false;
  }
}

function ensureFixtureReset(): Promise<boolean> {
  if (!fixtureResetPromise) {
    fixtureResetPromise = (async () => {
      const stored = await browser.storage.session.get(fixtureResetKey);
      if (stored[fixtureResetKey] === true) return true;
      if (!await sendGrantCountRequest({ kind: "revoke_all_fixture", payload: {} })) return false;
      await browser.storage.session.set({ [fixtureResetKey]: true });
      return true;
    })().catch(() => false).then((ready) => {
      if (!ready) fixtureResetPromise = undefined;
      return ready;
    });
  }
  return fixtureResetPromise;
}

function isSelectedFixture(): boolean {
  return location.origin === "http://127.0.0.1:8787"
    && document.querySelector("main[data-conversation-id=fixture-alpha]") !== null;
}

function readFixtureIdentity(): string | null {
  if (location.origin !== "http://127.0.0.1:8787") return null;
  const fixtures = document.querySelectorAll<HTMLElement>("main[data-conversation-id]");
  return fixtures.length === 1 && fixtures[0]?.dataset.conversationId === "fixture-alpha" ? "fixture-alpha" : null;
}

function observeFixtureIdentity(): boolean {
  if (location.origin !== "http://127.0.0.1:8787") return false;
  const root = document.querySelector<HTMLElement>("main[data-conversation-id=fixture-alpha]");
  const runtime = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { sendMessage: (message: { kind: string }) => Promise<unknown> } }
  }).chrome?.runtime;
  if (!root || !runtime) return false;
  const workerScope = globalThis as typeof globalThis & { fixtureIdentityObserver?: MutationObserver };
  if (workerScope.fixtureIdentityObserver) return true;
  const observer = new MutationObserver(() => {
    if (root.dataset.conversationId !== "fixture-alpha") {
      observer.disconnect();
      delete workerScope.fixtureIdentityObserver;
      void runtime.sendMessage({ kind: "fixture_identity_changed" }).catch(() => {});
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ["data-conversation-id"] });
  workerScope.fixtureIdentityObserver = observer;
  return true;
}

function stopFixtureObservation(): void {
  const scope = globalThis as typeof globalThis & {
    fixtureIdentityObserver?: MutationObserver; fixtureMessagesObserver?: MutationObserver
  };
  scope.fixtureIdentityObserver?.disconnect();
  scope.fixtureMessagesObserver?.disconnect();
  delete scope.fixtureIdentityObserver;
  delete scope.fixtureMessagesObserver;
}

async function publishFixtureSnapshot(tabId: number, documentId: string, challengeId?: string): Promise<boolean> {
  try {
    const key = fixtureGrantKey(tabId);
    const stored = (await browser.storage.session.get(key))[key] as StoredFixtureGrant | undefined;
    if (stored?.documentId !== documentId || typeof stored.expiresAt !== "number"
      || stored.expiresAt <= Date.now()) return false;
    const [captured] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: captureFixtureSnapshot
    });
    const tab = await browser.tabs.get(tabId);
    if (captured?.frameId !== 0 || captured.documentId !== documentId || !captured.result
      || !tab.url || new URL(tab.url).origin !== "http://127.0.0.1:8787") return false;
    const messages = captured.result.messages;

    const published = await new Promise<boolean>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish(false), 10_000);

      function finish(ok: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return finish(false);
        const reply = value as Record<string, unknown>;
        const payload = reply.payload;
        finish(Object.keys(reply).length === 6 && reply.kind === "fixture_snapshot_published"
          && reply.protocolVersion === protocolVersion && reply.requestId === requestId
          && reply.connectionGeneration === 0 && reply.deadlineMs === deadlineMs
          && typeof payload === "object" && payload !== null && !Array.isArray(payload)
          && Object.keys(payload).length === 1 && typeof (payload as { count?: unknown }).count === "number"
          && Number.isSafeInteger((payload as { count: number }).count)
          && (payload as { count: number }).count > 0);
      });
      port.onDisconnect.addListener(() => { void browser.runtime.lastError; finish(false); });
      port.postMessage({
        kind: "publish_fixture_snapshot", protocolVersion, requestId, connectionGeneration: 0,
        deadlineMs, payload: { target: {
          origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId, documentId
        }, messages, ...(challengeId === undefined ? {} : { challengeId }) }
      });
    });
    if (!published) return false;
    const [stillCurrent] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
    });
    const currentTab = await browser.tabs.get(tabId);
    return stillCurrent?.frameId === 0 && stillCurrent.documentId === documentId
      && stillCurrent.result === "fixture-alpha" && !!currentTab.url
      && new URL(currentTab.url).origin === "http://127.0.0.1:8787";
  } catch {
    return false;
  }
}

function queueFixtureSnapshot(tabId: number, documentId: string, challengeId?: string): Promise<boolean> {
  const previous = fixtureSnapshotJobs.get(tabId) ?? Promise.resolve(true);
  const job = previous.then(() => publishFixtureSnapshot(tabId, documentId, challengeId),
    () => publishFixtureSnapshot(tabId, documentId, challengeId));
  fixtureSnapshotJobs.set(tabId, job);
  void job.finally(() => {
    if (fixtureSnapshotJobs.get(tabId) === job) fixtureSnapshotJobs.delete(tabId);
  });
  return job;
}

async function publishGeminiSnapshot(tabId: number, expectedUrl: string,
  documentId: string, challengeId?: string): Promise<boolean> {
  try {
    if (!isEligibleGeminiUrl(expectedUrl)
      || (challengeId !== undefined
        && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(challengeId))) {
      return false;
    }
    const key = geminiGrantKey(tabId);
    const stored = (await browser.storage.session.get(key))[key] as StoredGeminiGrant | undefined;
    if (stored?.documentId !== documentId || stored.url !== expectedUrl
      || typeof stored.expiresAt !== "number" || !Number.isSafeInteger(stored.expiresAt)
      || stored.expiresAt <= Date.now()) return false;
    const [captured] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: captureGeminiSnapshot, args: [expectedUrl]
    });
    const tab = await browser.tabs.get(tabId);
    if (captured?.frameId !== 0 || captured.documentId !== documentId || !captured.result
      || tab.url !== expectedUrl) return false;
    const messages = captured.result.messages;
    const conversationId = new URL(expectedUrl).pathname.split("/").filter(Boolean)[1]!;

    const published = await new Promise<boolean>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish(false), 10_000);

      function finish(ok: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return finish(false);
        const reply = value as Record<string, unknown>;
        const payload = reply.payload;
        finish(Object.keys(reply).length === 6 && reply.kind === "gemini_snapshot_published"
          && reply.protocolVersion === protocolVersion && reply.requestId === requestId
          && reply.connectionGeneration === 0 && reply.deadlineMs === deadlineMs
          && typeof payload === "object" && payload !== null && !Array.isArray(payload)
          && Object.keys(payload).length === 1 && typeof (payload as { count?: unknown }).count === "number"
          && Number.isSafeInteger((payload as { count: number }).count)
          && (payload as { count: number }).count > 0);
      });
      port.onDisconnect.addListener(() => { void browser.runtime.lastError; finish(false); });
      port.postMessage({ kind: "publish_gemini_snapshot", protocolVersion, requestId,
        connectionGeneration: 0, deadlineMs, payload: { target: {
          origin: geminiOrigin, conversationId, url: expectedUrl, tabId, documentId
        }, messages, ...(challengeId === undefined ? {} : { challengeId }) } });
    });
    if (!published) return false;
    const [current] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: identifyGeminiConversation
    });
    const currentTab = await browser.tabs.get(tabId);
    return current?.frameId === 0 && current.documentId === documentId
      && current.result?.url === expectedUrl && current.result.conversationId === conversationId
      && currentTab.url === expectedUrl;
  } catch {
    return false;
  }
}

function queueGeminiSnapshot(tabId: number, expectedUrl: string, documentId: string, challengeId?: string) {
  const previous = geminiSnapshotJobs.get(tabId) ?? Promise.resolve(true);
  const job = previous.then(() => publishGeminiSnapshot(tabId, expectedUrl, documentId, challengeId),
    () => publishGeminiSnapshot(tabId, expectedUrl, documentId, challengeId));
  geminiSnapshotJobs.set(tabId, job);
  void job.finally(() => {
    if (geminiSnapshotJobs.get(tabId) === job) geminiSnapshotJobs.delete(tabId);
  });
  return job;
}

async function hasTrackedFixtureGrant(): Promise<boolean> {
  const stored = await browser.storage.session.get(null);
  return Object.entries(stored).some(([key, value]) => {
    if (!/^fixture-grant-[1-9]\d*$/.test(key) || typeof value !== "object" || value === null) return false;
    const grant = value as Partial<StoredFixtureGrant>;
    return typeof grant.documentId === "string" && /^[!-~]{1,128}$/.test(grant.documentId)
      && typeof grant.expiresAt === "number" && Number.isSafeInteger(grant.expiresAt)
      && grant.expiresAt > Date.now();
  });
}

async function hasTrackedGeminiGrant(): Promise<boolean> {
  const stored = await browser.storage.session.get(null);
  return Object.entries(stored).some(([key, value]) => {
    if (!/^gemini-grant-[1-9]\d*$/.test(key) || typeof value !== "object" || value === null) return false;
    const grant = value as Partial<StoredGeminiGrant>;
    return typeof grant.documentId === "string" && /^[!-~]{1,128}$/.test(grant.documentId)
      && typeof grant.url === "string" && isEligibleGeminiUrl(grant.url)
      && typeof grant.expiresAt === "number" && Number.isSafeInteger(grant.expiresAt)
      && grant.expiresAt > Date.now();
  });
}

function stopGeminiObservation(): void {
  const scope = globalThis as typeof globalThis & {
    geminiIdentityObserver?: MutationObserver; geminiMessagesObserver?: MutationObserver;
    geminiMessagesObserverUrl?: string; geminiMessagesNotifyTimer?: ReturnType<typeof setTimeout>
  };
  scope.geminiIdentityObserver?.disconnect();
  scope.geminiMessagesObserver?.disconnect();
  clearTimeout(scope.geminiMessagesNotifyTimer);
  delete scope.geminiIdentityObserver;
  delete scope.geminiMessagesObserver;
  delete scope.geminiMessagesObserverUrl;
  delete scope.geminiMessagesNotifyTimer;
}

async function releaseDisconnectedGemini(activeTabIds: number[]): Promise<void> {
  const active = new Set(activeTabIds);
  const stored = await browser.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!/^gemini-grant-[1-9]\d*$/.test(key)) continue;
    const tabId = Number(key.slice("gemini-grant-".length));
    if (!Number.isSafeInteger(tabId) || active.has(tabId)) continue;
    await browser.storage.session.remove(key);
    const grant = value as StoredGeminiGrant | undefined;
    if (typeof grant?.documentId !== "string" || !/^[!-~]{1,128}$/.test(grant.documentId)) continue;
    void browser.scripting.executeScript({ target: { tabId, documentIds: [grant.documentId] },
      func: stopGeminiObservation }).catch(() => {});
  }
}

async function markTrackedFixtureGaps(): Promise<boolean> {
  const stored = await browser.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!/^fixture-grant-[1-9]\d*$/.test(key)) continue;
    const tabId = Number(key.slice("fixture-grant-".length));
    const grant = value as StoredFixtureGrant | undefined;
    if (!Number.isSafeInteger(tabId) || typeof grant?.documentId !== "string"
      || !/^[!-~]{1,128}$/.test(grant.documentId) || typeof grant.expiresAt !== "number"
      || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) continue;
    if (!await sendGrantCountRequest({ kind: "mark_fixture_observation_gap", payload: {
      target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId,
        documentId: grant.documentId }
    } })) return false;
  }
  return true;
}

async function markTrackedGeminiGaps(): Promise<boolean> {
  const stored = await browser.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!/^gemini-grant-[1-9]\d*$/.test(key)) continue;
    const tabId = Number(key.slice("gemini-grant-".length));
    const grant = value as StoredGeminiGrant | undefined;
    if (!Number.isSafeInteger(tabId) || typeof grant?.documentId !== "string"
      || !/^[!-~]{1,128}$/.test(grant.documentId) || typeof grant.url !== "string"
      || !isEligibleGeminiUrl(grant.url) || typeof grant.expiresAt !== "number"
      || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) continue;
    if (!await sendGrantCountRequest({ kind: "mark_gemini_observation_gap", payload: {
      target: { origin: geminiOrigin, conversationId: new URL(grant.url).pathname.split("/").filter(Boolean)[1]!,
        url: grant.url, tabId, documentId: grant.documentId }
    } })) return false;
  }
  return true;
}

async function releaseDisconnectedFixtures(activeTabIds: number[]): Promise<void> {
  const active = new Set(activeTabIds);
  const stored = await browser.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!/^fixture-grant-[1-9]\d*$/.test(key)) continue;
    const tabId = Number(key.slice("fixture-grant-".length));
    if (!Number.isSafeInteger(tabId) || active.has(tabId)) continue;
    await browser.storage.session.remove(key);
    const grant = value as StoredFixtureGrant | undefined;
    if (typeof grant?.documentId !== "string" || !/^[!-~]{1,128}$/.test(grant.documentId)) continue;
    void browser.scripting.executeScript({ target: { tabId, documentIds: [grant.documentId] },
      func: stopFixtureObservation }).catch(() => {});
  }
}

async function checkTrackedFixturePreflight(check: FixturePreflightChallenge): Promise<void> {
  if (check.expiresAt <= Date.now()) return;
  let observation: ReturnType<typeof inspectFixturePreflight> = { ok: false, code: "TARGET_CHANGED" };
  try {
    const key = fixtureGrantKey(check.tabId);
    const grant = (await browser.storage.session.get(key))[key] as StoredFixtureGrant | undefined;
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(check.tabId);
    if (grant?.documentId === check.documentId && typeof grant.expiresAt === "number" && grant.expiresAt > Date.now()
      && active?.id === check.tabId && tab.active
      && (tab.url === "http://127.0.0.1:8787/" || tab.url === richFixtureUrl)) {
      const expectedUrl = tab.url;
      const [checked] = await browser.scripting.executeScript({ target: { tabId: check.tabId, documentIds: [check.documentId] },
        func: inspectFixturePreflight, args: [{ expectedUrl, text: check.text }] });
      if (checked?.frameId === 0 && checked.documentId === check.documentId && checked.result) {
        const [identity] = await browser.scripting.executeScript({ target: { tabId: check.tabId, documentIds: [check.documentId] },
          func: readFixtureIdentity });
        const [stillActive] = await browser.tabs.query({ active: true, currentWindow: true });
        const current = await browser.tabs.get(check.tabId);
        const stillGranted = (await browser.storage.session.get(key))[key] as StoredFixtureGrant | undefined;
        if (identity?.frameId === 0 && identity.documentId === check.documentId && identity.result === "fixture-alpha"
          && stillActive?.id === check.tabId && current.active && current.url === expectedUrl
          && stillGranted?.documentId === check.documentId && typeof stillGranted.expiresAt === "number"
          && stillGranted.expiresAt > Date.now()) observation = checked.result;
      }
    }
  } catch {}
  if (check.expiresAt <= Date.now()) return;
  await new Promise<boolean>((resolve) => {
    const requestId = crypto.randomUUID();
    const deadlineMs = Date.now() + 5_000;
    let port: ReturnType<typeof browser.runtime.connectNative>;
    try { port = browser.runtime.connectNative(nativeHostName); }
    catch { resolve(false); return; }
    let settled = false;
    const timer = setTimeout(() => finish(false), Math.max(1, Math.min(5_000, check.expiresAt - Date.now())));
    function finish(ok: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
      port.disconnect();
    }
    port.onMessage.addListener((value: unknown) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return finish(false);
      const reply = value as Record<string, unknown>;
      const payload = reply.payload;
      finish(Object.keys(reply).length === 6 && reply.kind === "fixture_preflight_recorded"
        && reply.protocolVersion === protocolVersion && reply.requestId === requestId
        && reply.connectionGeneration === 0 && reply.deadlineMs === deadlineMs
        && typeof payload === "object" && payload !== null && !Array.isArray(payload)
        && Object.keys(payload).length === 1 && (payload as { accepted?: unknown }).accepted === true);
    });
    port.onDisconnect.addListener(() => { void browser.runtime.lastError; finish(false); });
    port.postMessage({ kind: "complete_fixture_preflight", protocolVersion, requestId, connectionGeneration: 0,
      deadlineMs, payload: { target: { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
        tabId: check.tabId, documentId: check.documentId }, challengeId: check.challengeId, observation } });
  }).catch(() => false);
}

function parseFixtureReadChallenges(value: unknown, requestId: string, deadlineMs: number) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
  const reply = value as Record<string, unknown>;
  if (Object.keys(reply).length !== 6 || reply.kind !== "fixture_read_challenges"
    || reply.protocolVersion !== protocolVersion || reply.requestId !== requestId
    || reply.connectionGeneration !== 0 || reply.deadlineMs !== deadlineMs
    || typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) throw new Error();
  const payload = reply.payload as Record<string, unknown>;
  if (Object.keys(payload).length !== 3 || !Array.isArray(payload.challenges)
    || payload.challenges.length > 16 || !Array.isArray(payload.activeTabIds)
    || payload.activeTabIds.length > 100 || !payload.activeTabIds.every((tabId: unknown) =>
      typeof tabId === "number" && Number.isSafeInteger(tabId) && tabId > 0)
    || new Set(payload.activeTabIds).size !== payload.activeTabIds.length
    || !Array.isArray(payload.preflightChecks) || payload.preflightChecks.length > 16) throw new Error();

  const challenges = payload.challenges.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error();
    const challenge = entry as Record<string, unknown>;
    if (Object.keys(challenge).length !== 3 || typeof challenge.challengeId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(challenge.challengeId)
      || typeof challenge.expiresAt !== "number" || !Number.isSafeInteger(challenge.expiresAt)
      || typeof challenge.target !== "object" || challenge.target === null || Array.isArray(challenge.target)) throw new Error();
    const target = challenge.target as Record<string, unknown>;
    if (Object.keys(target).length !== 4 || target.origin !== "http://127.0.0.1:8787"
      || target.conversationId !== "fixture-alpha" || typeof target.tabId !== "number"
      || !Number.isSafeInteger(target.tabId) || target.tabId < 1
      || typeof target.documentId !== "string" || !/^[!-~]{1,128}$/.test(target.documentId)) throw new Error();
    return { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt,
      tabId: target.tabId, documentId: target.documentId };
  });
  const preflightChecks = payload.preflightChecks.map((entry: unknown): FixturePreflightChallenge => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error();
    const check = entry as Record<string, unknown>;
    const validId = (value: unknown) => typeof value === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
    if (Object.keys(check).length !== 5 || !validId(check.challengeId) || !validId(check.operationId)
      || typeof check.expiresAt !== "number" || !Number.isSafeInteger(check.expiresAt)
      || typeof check.text !== "string" || !check.text || check.text.length > 4000
      || new TextEncoder().encode(check.text).length > 4000
      || typeof check.target !== "object" || check.target === null || Array.isArray(check.target)) throw new Error();
    const target = check.target as Record<string, unknown>;
    if (Object.keys(target).length !== 4 || target.origin !== "http://127.0.0.1:8787"
      || target.conversationId !== "fixture-alpha" || typeof target.tabId !== "number"
      || !Number.isSafeInteger(target.tabId) || target.tabId < 1
      || typeof target.documentId !== "string" || !/^[!-~]{1,128}$/.test(target.documentId)) throw new Error();
    return { challengeId: check.challengeId as string, operationId: check.operationId as string,
      expiresAt: check.expiresAt, text: check.text, tabId: target.tabId, documentId: target.documentId };
  });
  return { challenges, activeTabIds: payload.activeTabIds as number[], preflightChecks };
}

function parseGeminiReadChallenges(value: unknown, requestId: string, deadlineMs: number) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
  const reply = value as Record<string, unknown>;
  if (Object.keys(reply).length !== 6 || reply.kind !== "gemini_read_challenges"
    || reply.protocolVersion !== protocolVersion || reply.requestId !== requestId
    || reply.connectionGeneration !== 0 || reply.deadlineMs !== deadlineMs
    || typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) throw new Error();
  const payload = reply.payload as Record<string, unknown>;
  if (Object.keys(payload).length !== 2 || !Array.isArray(payload.challenges)
    || payload.challenges.length > 16 || !Array.isArray(payload.activeTabIds)
    || payload.activeTabIds.length > 100 || !payload.activeTabIds.every((tabId: unknown) =>
      typeof tabId === "number" && Number.isSafeInteger(tabId) && tabId > 0)
    || new Set(payload.activeTabIds).size !== payload.activeTabIds.length) throw new Error();

  const challenges = payload.challenges.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error();
    const challenge = entry as Record<string, unknown>;
    if (Object.keys(challenge).length !== 3 || typeof challenge.challengeId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(challenge.challengeId)
      || typeof challenge.expiresAt !== "number" || !Number.isSafeInteger(challenge.expiresAt)
      || typeof challenge.target !== "object" || challenge.target === null || Array.isArray(challenge.target)) throw new Error();
    const target = challenge.target as Record<string, unknown>;
    if (Object.keys(target).length !== 5 || target.origin !== geminiOrigin
      || typeof target.conversationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(target.conversationId)
      || typeof target.url !== "string" || !isEligibleGeminiUrl(target.url)
      || new URL(target.url).pathname.split("/").filter(Boolean)[1] !== target.conversationId
      || typeof target.tabId !== "number" || !Number.isSafeInteger(target.tabId) || target.tabId < 1
      || typeof target.documentId !== "string" || !/^[!-~]{1,128}$/.test(target.documentId)) throw new Error();
    return { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt,
      url: target.url, tabId: target.tabId, documentId: target.documentId };
  });
  return { challenges, activeTabIds: payload.activeTabIds as number[] };
}

function startFixtureReadWatch(): boolean {
  if (fixtureReadWatch) return true;
  let port: ReturnType<typeof browser.runtime.connectNative>;
  try {
    port = browser.runtime.connectNative(nativeHostName);
  } catch {
    return false;
  }
  fixtureReadWatch = port;
  let requestId: string | null = null;
  let deadlineMs = 0;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  function stop() {
    if (fixtureReadWatch !== port) return;
    fixtureReadWatch = undefined;
    clearTimeout(responseTimer);
    clearTimeout(pollTimer);
    port.disconnect();
  }

  async function poll() {
    try {
      if (!await hasTrackedFixtureGrant()) return stop();
      if (fixtureReadWatch !== port) return;
      requestId = crypto.randomUUID();
      deadlineMs = Date.now() + 5_000;
      responseTimer = setTimeout(stop, 5_000);
      port.postMessage({ kind: "list_fixture_read_challenges", protocolVersion,
        requestId, connectionGeneration: 0, deadlineMs, payload: {} });
    } catch {
      stop();
    }
  }

  port.onMessage.addListener((value: unknown) => {
    if (!requestId) return stop();
    clearTimeout(responseTimer);
    const listing = (() => {
      try { return parseFixtureReadChallenges(value, requestId, deadlineMs); }
      catch { stop(); return null; }
    })();
    requestId = null;
    if (!listing) return;
    void (async () => {
      await releaseDisconnectedFixtures(listing.activeTabIds);
      for (const check of listing.preflightChecks) await checkTrackedFixturePreflight(check);
      for (const challenge of listing.challenges) {
        if (challenge.expiresAt <= Date.now()) continue;
        const key = fixtureGrantKey(challenge.tabId);
        const grant = (await browser.storage.session.get(key))[key] as StoredFixtureGrant | undefined;
        if (!grant || grant.documentId !== challenge.documentId || typeof grant.expiresAt !== "number"
          || grant.expiresAt <= Date.now()) continue;
        if (!await queueFixtureSnapshot(challenge.tabId, challenge.documentId, challenge.challengeId)) {
          await revokeTrackedFixture(challenge.tabId);
        }
      }
      if (fixtureReadWatch === port) pollTimer = setTimeout(() => { void poll(); }, 250);
    })().catch(stop);
  });
  port.onDisconnect.addListener(() => { void browser.runtime.lastError; stop(); });
  void poll();
  return true;
}

function startGeminiReadWatch(): boolean {
  if (geminiReadWatch) return true;
  let port: ReturnType<typeof browser.runtime.connectNative>;
  try {
    port = browser.runtime.connectNative(nativeHostName);
  } catch {
    return false;
  }
  geminiReadWatch = port;
  let requestId: string | null = null;
  let deadlineMs = 0;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  function stop() {
    if (geminiReadWatch !== port) return;
    geminiReadWatch = undefined;
    clearTimeout(responseTimer);
    clearTimeout(pollTimer);
    port.disconnect();
  }

  async function poll() {
    try {
      if (!await hasTrackedGeminiGrant()) return stop();
      if (geminiReadWatch !== port) return;
      requestId = crypto.randomUUID();
      deadlineMs = Date.now() + 5_000;
      responseTimer = setTimeout(stop, 5_000);
      port.postMessage({ kind: "list_gemini_read_challenges", protocolVersion,
        requestId, connectionGeneration: 0, deadlineMs, payload: {} });
    } catch {
      stop();
    }
  }

  port.onMessage.addListener((value: unknown) => {
    if (!requestId) return stop();
    clearTimeout(responseTimer);
    const listing = (() => {
      try { return parseGeminiReadChallenges(value, requestId, deadlineMs); }
      catch { stop(); return null; }
    })();
    requestId = null;
    if (!listing) return;
    void (async () => {
      await releaseDisconnectedGemini(listing.activeTabIds);
      for (const challenge of listing.challenges) {
        if (challenge.expiresAt <= Date.now()) continue;
        const key = geminiGrantKey(challenge.tabId);
        const grant = (await browser.storage.session.get(key))[key] as StoredGeminiGrant | undefined;
        if (!grant || grant.documentId !== challenge.documentId || grant.url !== challenge.url
          || typeof grant.expiresAt !== "number" || grant.expiresAt <= Date.now()) continue;
        if (!await queueGeminiSnapshot(challenge.tabId, challenge.url,
          challenge.documentId, challenge.challengeId)) {
          await revokeTrackedFixture(challenge.tabId,
            await classifyGeminiPublicationFailure(challenge.tabId, challenge.url, challenge.documentId));
        }
      }
      if (geminiReadWatch === port) pollTimer = setTimeout(() => { void poll(); }, 250);
    })().catch(stop);
  });
  port.onDisconnect.addListener(() => { void browser.runtime.lastError; stop(); });
  void poll();
  return true;
}

async function approveFixture(tabId: number, expectedUrl: string, pendingRequestId: string): Promise<FixtureApprovalResult> {
  try {
    if (!await ensureFixtureReset()) return { ok: false, error: "Fixture grant reset unavailable; try again" };
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (active?.id !== tabId || !tab.active || tab.url !== expectedUrl
      || new URL(expectedUrl).origin !== "http://127.0.0.1:8787") {
      return { ok: false, error: "Fixture tab changed; no approval sent" };
    }
    const [identity] = await browser.scripting.executeScript({ target: { tabId }, func: readFixtureIdentity });
    if (!identity || identity.frameId !== 0) return { ok: false, error: "Fixture main frame unavailable; no approval sent" };
    if (identity.result !== "fixture-alpha") return { ok: false, error: "Fixture identity changed; no approval sent" };
    if (typeof identity.documentId !== "string") return { ok: false, error: "Chrome document ID missing; no approval sent" };
    if (!/^[!-~]{1,128}$/.test(identity.documentId)) {
      return { ok: false, error: "Chrome document ID format unrecognized; no approval sent" };
    }
    const documentId = identity.documentId;
    const [fresh] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
    });
    if (fresh?.documentId !== documentId || fresh.result !== "fixture-alpha"
      || (await browser.tabs.get(tabId)).url !== expectedUrl) {
      return { ok: false, error: "Fixture changed; no approval sent" };
    }

    return await new Promise<FixtureApprovalResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve({ ok: false, error: "Native fixture approval unavailable" });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, error: "Fixture approval timed out" }), 10_000);

      function finish(result: FixtureApprovalResult) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        let brokerApproved = false;
        void (async () => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
          const reply = value as Record<string, unknown>;
          if (reply.protocolVersion !== protocolVersion || reply.requestId !== requestId
            || reply.connectionGeneration !== 0 || reply.deadlineMs !== deadlineMs
            || typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) throw new Error();
          const payload = reply.payload as Record<string, unknown>;
          if (reply.kind === "error" && payload.code === "APPROVAL_INVALID") {
            finish({ ok: false, error: "Request expired or already approved" });
            return;
          }
          if (reply.kind === "error" && payload.code === "BROKER_UNAVAILABLE") {
            finish({ ok: false, error: "Broker unavailable; no approval" });
            return;
          }
          if (reply.kind !== "fixture_approved" || Object.keys(payload).length !== 2
            || payload.requestId !== pendingRequestId || typeof payload.expiresAt !== "number"
            || !Number.isSafeInteger(payload.expiresAt)) throw new Error();
          brokerApproved = true;
          const [current] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
          });
          const currentTab = await browser.tabs.get(tabId);
          if (current?.documentId !== documentId || current.result !== "fixture-alpha"
            || !currentTab.active || currentTab.url !== expectedUrl) throw new Error();
          await browser.storage.session.set({ [fixtureGrantKey(tabId)]: {
            documentId, expiresAt: payload.expiresAt
          } satisfies StoredFixtureGrant });
          const [stillCurrent] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
          });
          const stableTab = await browser.tabs.get(tabId);
          if (stillCurrent?.documentId !== documentId || stillCurrent.result !== "fixture-alpha"
            || !stableTab.active || stableTab.url !== expectedUrl) throw new Error();
          const [observing] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: observeFixtureIdentity
          });
          if (observing?.documentId !== documentId || observing.result !== true) throw new Error();
          const [watchingMessages] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: observeFixtureMessages
          });
          if (watchingMessages?.frameId !== 0 || watchingMessages.documentId !== documentId
            || watchingMessages.result !== true || !await queueFixtureSnapshot(tabId, documentId)) throw new Error();
          if (!startFixtureReadWatch()) throw new Error();
          finish({ ok: true, requestId: pendingRequestId, expiresAt: payload.expiresAt });
        })().catch(async () => {
          if (brokerApproved && await revokeFixtureTab(tabId, null)) {
            await browser.storage.session.remove(fixtureGrantKey(tabId)).catch(() => {});
          }
          finish({ ok: false, error: "Fixture changed or approval response invalid; reconnect" });
        });
      });
      port.onDisconnect.addListener(() => {
        void browser.runtime.lastError;
        finish({ ok: false, error: "Native fixture approval unavailable" });
      });
      port.postMessage({
        kind: "approve_fixture", protocolVersion, requestId, connectionGeneration: 0, deadlineMs,
        payload: { pendingRequestId, target: {
          origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId, documentId
        } }
      });
    });
  } catch {
    return { ok: false, error: "Fixture changed or approval unavailable; reconnect" };
  }
}

async function approveGemini(tabId: number, expectedUrl: string, pendingRequestId: string): Promise<FixtureApprovalResult> {
  try {
    if (!await ensureFixtureReset()) return { ok: false, error: "Connection reset unavailable; try again" };
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (active?.id !== tabId || !tab.active || tab.url !== expectedUrl
      || new URL(expectedUrl).origin !== geminiOrigin) {
      return { ok: false, error: "Selected Gemini chat changed; no approval sent" };
    }
    const [identity] = await browser.scripting.executeScript({ target: { tabId }, func: identifyGeminiConversation });
    if (identity?.frameId !== 0 || identity.result?.url !== expectedUrl
      || typeof identity.documentId !== "string" || !/^[!-~]{1,128}$/.test(identity.documentId)) {
      return { ok: false, error: "Gemini chat identity unavailable; no approval sent" };
    }
    const documentId = identity.documentId;
    const conversationId = identity.result.conversationId;
    const [fresh] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: identifyGeminiConversation
    });
    if (fresh?.frameId !== 0 || fresh.documentId !== documentId
      || fresh.result?.url !== expectedUrl || fresh.result.conversationId !== conversationId
      || (await browser.tabs.get(tabId)).url !== expectedUrl) {
      return { ok: false, error: "Selected Gemini chat changed; no approval sent" };
    }

    return await new Promise<FixtureApprovalResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve({ ok: false, error: "Native Gemini approval unavailable" });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, error: "Gemini approval timed out" }), 10_000);

      function finish(result: FixtureApprovalResult) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        let brokerApproved = false;
        void (async () => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
          const reply = value as Record<string, unknown>;
          if (Object.keys(reply).length !== 6 || reply.protocolVersion !== protocolVersion
            || reply.requestId !== requestId || reply.connectionGeneration !== 0 || reply.deadlineMs !== deadlineMs
            || typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) throw new Error();
          const payload = reply.payload as Record<string, unknown>;
          if (reply.kind === "error" && Object.keys(payload).length === 1 && payload.code === "APPROVAL_INVALID") {
            finish({ ok: false, error: "Request expired or already approved" });
            return;
          }
          if (reply.kind === "error" && Object.keys(payload).length === 1 && payload.code === "BROKER_UNAVAILABLE") {
            finish({ ok: false, error: "Broker unavailable; no approval" });
            return;
          }
          if (reply.kind !== "gemini_approved" || Object.keys(payload).length !== 2
            || payload.requestId !== pendingRequestId || typeof payload.expiresAt !== "number"
            || !Number.isSafeInteger(payload.expiresAt)) throw new Error();
          brokerApproved = true;
          const [current] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: identifyGeminiConversation
          });
          const currentTab = await browser.tabs.get(tabId);
          if (current?.frameId !== 0 || current.documentId !== documentId
            || current.result?.url !== expectedUrl || current.result.conversationId !== conversationId
            || !currentTab.active || currentTab.url !== expectedUrl) throw new Error();
          await browser.storage.session.set({ [geminiGrantKey(tabId)]: {
            documentId, url: expectedUrl, expiresAt: payload.expiresAt
          } satisfies StoredGeminiGrant });
          await browser.storage.session.remove(geminiStatusKey(tabId));
          const [stillCurrent] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: identifyGeminiConversation
          });
          const stableTab = await browser.tabs.get(tabId);
          if (stillCurrent?.frameId !== 0 || stillCurrent.documentId !== documentId
            || stillCurrent.result?.url !== expectedUrl || stillCurrent.result.conversationId !== conversationId
            || !stableTab.active || stableTab.url !== expectedUrl) throw new Error();
          const [observing] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: observeGeminiIdentity, args: [expectedUrl]
          });
          if (observing?.frameId !== 0 || observing.documentId !== documentId || observing.result !== true) throw new Error();
          const [watchingMessages] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: observeGeminiMessages, args: [expectedUrl]
          });
          if (watchingMessages?.frameId !== 0 || watchingMessages.documentId !== documentId
            || watchingMessages.result !== true) throw new Error();
          if (!startGeminiReadWatch()) throw new Error();
          finish({ ok: true, requestId: pendingRequestId, expiresAt: payload.expiresAt });
        })().catch(async () => {
          if (brokerApproved && await revokeFixtureTab(tabId, null)) {
            await browser.storage.session.remove(geminiGrantKey(tabId)).catch(() => {});
          }
          finish({ ok: false, error: "Gemini chat changed or approval response invalid; reconnect" });
        });
      });
      port.onDisconnect.addListener(() => {
        void browser.runtime.lastError;
        finish({ ok: false, error: "Native Gemini approval unavailable" });
      });
      port.postMessage({ kind: "approve_gemini", protocolVersion, requestId, connectionGeneration: 0,
        deadlineMs, payload: { pendingRequestId, target: {
          origin: geminiOrigin, conversationId, url: expectedUrl, tabId, documentId
        } } });
    });
  } catch {
    return { ok: false, error: "Selected Gemini chat changed or approval unavailable; reconnect" };
  }
}

async function listPendingForSelectedTab(tabId: number, expectedGeminiUrl?: string): Promise<PendingListResult> {
  try {
    if (!await ensureFixtureReset()) return { ok: false, error: "Fixture grant reset unavailable; try again" };
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (active?.id !== tabId || !tab.active || !tab.url) {
      return { ok: false, error: expectedGeminiUrl ? "Select the saved Gemini chat first" : "Select the local fixture tab first" };
    }
    if (expectedGeminiUrl) {
      if (tab.url !== expectedGeminiUrl || new URL(tab.url).origin !== geminiOrigin) {
        return { ok: false, error: "Selected Gemini chat changed" };
      }
      const [identity] = await browser.scripting.executeScript({
        target: { tabId }, func: identifyGeminiConversation
      });
      if (identity?.frameId !== 0 || identity.result?.url !== expectedGeminiUrl
        || (await browser.tabs.get(tabId)).url !== expectedGeminiUrl) {
        return { ok: false, error: "Selected Gemini conversation unavailable" };
      }
    } else {
      if (new URL(tab.url).origin !== "http://127.0.0.1:8787") {
        return { ok: false, error: "Select the local fixture tab first" };
      }
      const [fixture] = await browser.scripting.executeScript({ target: { tabId }, func: isSelectedFixture });
      if (fixture?.result !== true) return { ok: false, error: "Fixture conversation not found" };
    }
    const selectedUrl = tab.url;

    return await new Promise<PendingListResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve({ ok: false, error: "Native pending list unavailable" });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, error: "Native pending list timed out" }), 10_000);

      function finish(result: PendingListResult) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        void (async () => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
          const reply = value as Record<string, unknown>;
          if (reply.kind !== "pending_list" || reply.protocolVersion !== protocolVersion
            || reply.requestId !== requestId || reply.connectionGeneration !== 0 || reply.deadlineMs !== deadlineMs
            || typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) {
            throw new Error();
          }
          const requests = (reply.payload as { requests?: unknown }).requests;
          if (!Array.isArray(requests) || requests.length > 100 || !requests.every((item: unknown) => {
            if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
            const entry = item as Record<string, unknown>;
            return Object.keys(entry).length === 2 && typeof entry.requestId === "string"
              && /^[0-9a-f-]{36}$/.test(entry.requestId)
              && typeof entry.expiresAt === "number" && Number.isSafeInteger(entry.expiresAt);
          })) throw new Error();
          const current = await browser.tabs.get(tabId);
          if (!current.active || current.url !== selectedUrl) throw new Error();
          finish({ ok: true, requests: requests as { requestId: string; expiresAt: number }[] });
        })().catch(() => finish({ ok: false, error: "Pending list invalid or selected tab changed" }));
      });
      port.onDisconnect.addListener(() => {
        void browser.runtime.lastError;
        finish({ ok: false, error: "Native pending list unavailable" });
      });
      port.postMessage({
        kind: "list_pending", protocolVersion, requestId, connectionGeneration: 0,
        deadlineMs, payload: {}
      });
    });
  } catch {
    return { ok: false, error: expectedGeminiUrl ? "Gemini pending list unavailable" : "Fixture pending list unavailable" };
  }
}

async function listFixtureReviewsForSelectedTab(tabId: number, expectedUrl: string): Promise<FixtureReviewsResult> {
  try {
    if (!await ensureFixtureReset()) return { ok: false, error: "Fixture grant reset unavailable" };
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (active?.id !== tabId || !tab.active || tab.url !== expectedUrl
      || new URL(expectedUrl).origin !== "http://127.0.0.1:8787") {
      return { ok: false, error: "Select the approved local fixture first" };
    }
    const key = fixtureGrantKey(tabId);
    const stored = (await browser.storage.session.get(key))[key] as StoredFixtureGrant | undefined;
    if (!stored || typeof stored.documentId !== "string" || !/^[!-~]{1,128}$/.test(stored.documentId)
      || typeof stored.expiresAt !== "number" || stored.expiresAt <= Date.now()) {
      return { ok: false, error: "Fixture approval expired or unavailable" };
    }
    const documentId = stored.documentId;
    const [identity] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
    });
    if (identity?.frameId !== 0 || identity.documentId !== documentId || identity.result !== "fixture-alpha"
      || (await browser.tabs.get(tabId)).url !== expectedUrl) {
      return { ok: false, error: "Approved fixture document changed" };
    }

    return await new Promise<FixtureReviewsResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve({ ok: false, error: "Native fixture review unavailable" });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, error: "Fixture review timed out" }), 10_000);

      function finish(result: FixtureReviewsResult) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        void (async () => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
          const reply = value as Record<string, unknown>;
          if (Object.keys(reply).length !== 6 || reply.protocolVersion !== protocolVersion
            || reply.requestId !== requestId || reply.connectionGeneration !== 0 || reply.deadlineMs !== deadlineMs
            || typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) {
            throw new Error();
          }
          const payload = reply.payload as Record<string, unknown>;
          if (reply.kind === "error" && Object.keys(payload).length === 1
            && payload.code === "BROKER_UNAVAILABLE") {
            finish({ ok: false, error: "Broker unavailable; no fixture review" });
            return;
          }
          const reviews = payload.reviews;
          if (reply.kind !== "fixture_prepared_reviews" || Object.keys(payload).length !== 2
            || !Array.isArray(reviews) || reviews.length > 8 || typeof payload.hasMore !== "boolean"
            || !reviews.every((item: unknown) => {
              if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
              const entry = item as Record<string, unknown>;
              const preview = entry.preview;
              return Object.keys(entry).length === 4 && typeof entry.operationId === "string"
                && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.operationId)
                && typeof entry.reviewId === "string"
                && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.reviewId)
                && typeof entry.expiresAt === "number" && Number.isSafeInteger(entry.expiresAt)
                && entry.expiresAt > Date.now()
                && typeof preview === "object" && preview !== null && !Array.isArray(preview)
                && Object.keys(preview).length === 2
                && (preview as Record<string, unknown>).target === "fixture-alpha"
                && typeof (preview as Record<string, unknown>).text === "string"
                && new TextEncoder().encode((preview as { text: string }).text).length <= 4_000;
            })) throw new Error();
          const [fresh] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
          });
          const current = await browser.tabs.get(tabId);
          const [selected] = await browser.tabs.query({ active: true, currentWindow: true });
          const grant = (await browser.storage.session.get(key))[key] as StoredFixtureGrant | undefined;
          if (fresh?.frameId !== 0 || fresh.documentId !== documentId || fresh.result !== "fixture-alpha"
            || selected?.id !== tabId || !current.active || current.url !== expectedUrl
            || grant?.documentId !== documentId || typeof grant.expiresAt !== "number"
            || grant.expiresAt <= Date.now()) throw new Error();
          finish({ ok: true, reviews: reviews as Extract<FixtureReviewsResult, { ok: true }>["reviews"],
            hasMore: payload.hasMore as boolean });
        })().catch(() => finish({ ok: false, error: "Fixture review invalid or selected document changed" }));
      });
      port.onDisconnect.addListener(() => {
        void browser.runtime.lastError;
        finish({ ok: false, error: "Native fixture review unavailable" });
      });
      port.postMessage({ kind: "list_fixture_prepared_reviews", protocolVersion, requestId,
        connectionGeneration: 0, deadlineMs, payload: { target: {
          origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId, documentId
        } } });
    });
  } catch {
    return { ok: false, error: "Approved fixture document unavailable" };
  }
}

async function approveFixtureReviewForSelectedTab(tabId: number, expectedUrl: string,
  operationId: string, reviewId: string): Promise<FixtureReviewApprovalResult> {
  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (active?.id !== tabId || !tab.active || tab.url !== expectedUrl
      || new URL(expectedUrl).origin !== "http://127.0.0.1:8787") {
      return { ok: false, error: "Select the approved local fixture first" };
    }
    const key = fixtureGrantKey(tabId);
    const stored = (await browser.storage.session.get(key))[key] as StoredFixtureGrant | undefined;
    if (!stored || typeof stored.documentId !== "string" || !/^[!-~]{1,128}$/.test(stored.documentId)
      || typeof stored.expiresAt !== "number" || stored.expiresAt <= Date.now()) {
      return { ok: false, error: "Fixture approval expired or unavailable" };
    }
    const documentId = stored.documentId;
    const [identity] = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
    });
    if (identity?.frameId !== 0 || identity.documentId !== documentId || identity.result !== "fixture-alpha"
      || (await browser.tabs.get(tabId)).url !== expectedUrl) {
      return { ok: false, error: "Approved fixture document changed" };
    }

    return await new Promise<FixtureReviewApprovalResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const deadlineMs = Date.now() + 10_000;
      let port: ReturnType<typeof browser.runtime.connectNative>;
      try {
        port = browser.runtime.connectNative(nativeHostName);
      } catch {
        resolve({ ok: false, error: "Native fixture approval unavailable" });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, error: "Fixture approval timed out" }), 10_000);

      function finish(result: FixtureReviewApprovalResult) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
        port.disconnect();
      }

      port.onMessage.addListener((value: unknown) => {
        let brokerApproved = false;
        void (async () => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
          const reply = value as Record<string, unknown>;
          if (Object.keys(reply).length !== 6 || reply.protocolVersion !== protocolVersion
            || reply.requestId !== requestId || reply.connectionGeneration !== 0 || reply.deadlineMs !== deadlineMs
            || typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) {
            throw new Error();
          }
          const payload = reply.payload as Record<string, unknown>;
          if (reply.kind === "error" && Object.keys(payload).length === 1
            && payload.code === "REVIEW_UNAVAILABLE") {
            finish({ ok: false, error: "Draft review expired or already approved" });
            return;
          }
          if (reply.kind === "error" && Object.keys(payload).length === 1
            && payload.code === "BROKER_UNAVAILABLE") {
            finish({ ok: false, error: "Broker unavailable; no approval" });
            return;
          }
          if (reply.kind !== "fixture_review_approved" || Object.keys(payload).length !== 4
            || payload.operationId !== operationId || payload.state !== "approved"
            || typeof payload.approvedAt !== "number" || !Number.isSafeInteger(payload.approvedAt)
            || typeof payload.expiresAt !== "number" || !Number.isSafeInteger(payload.expiresAt)
            || payload.expiresAt <= Date.now()) throw new Error();
          brokerApproved = true;
          const [fresh] = await browser.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: readFixtureIdentity
          });
          const current = await browser.tabs.get(tabId);
          const [selected] = await browser.tabs.query({ active: true, currentWindow: true });
          const grant = (await browser.storage.session.get(key))[key] as StoredFixtureGrant | undefined;
          if (fresh?.frameId !== 0 || fresh.documentId !== documentId || fresh.result !== "fixture-alpha"
            || selected?.id !== tabId || !current.active || current.url !== expectedUrl
            || grant?.documentId !== documentId || typeof grant.expiresAt !== "number"
            || grant.expiresAt <= Date.now()) throw new Error();
          finish({ ok: true, operationId, expiresAt: payload.expiresAt });
        })().catch(async () => {
          if (brokerApproved && await revokeFixtureTab(tabId, null)) {
            await browser.storage.session.remove(key).catch(() => {});
          }
          finish({ ok: false, error: "Fixture changed or review response invalid; reconnect" });
        });
      });
      port.onDisconnect.addListener(() => {
        void browser.runtime.lastError;
        finish({ ok: false, error: "Native fixture approval unavailable" });
      });
      port.postMessage({ kind: "approve_fixture_review", protocolVersion, requestId,
        connectionGeneration: 0, deadlineMs, payload: { target: {
          origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha", tabId, documentId
        }, operationId, reviewId } });
    });
  } catch {
    return { ok: false, error: "Approved fixture document unavailable" };
  }
}

function focusFixtureEditor(): boolean {
  if (location.href !== "http://127.0.0.1:8787/?editor=rich"
    || document.querySelector("main[data-conversation-id=fixture-alpha]") === null) return false;
  const editor = document.querySelector<HTMLElement>("#rich-message[contenteditable=true]");
  if (!editor || editor.hidden || editor.getClientRects().length === 0 || editor.innerText.length > 0) return false;
  editor.focus();
  return document.activeElement === editor;
}

function readFixtureEditor(): string | null {
  if (location.href !== "http://127.0.0.1:8787/?editor=rich"
    || document.querySelector("main[data-conversation-id=fixture-alpha]") === null) return null;
  return document.querySelector<HTMLElement>("#rich-message[contenteditable=true]")?.innerText ?? null;
}

async function probeFixtureInput(tabId: number): Promise<FixtureInputResult> {
  if (inputInProgress) return { ok: false, error: "An input probe is already running" };
  inputInProgress = true;
  let attached = false;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (activeTab?.id !== tabId || !tab.active || tab.url !== richFixtureUrl) {
      return { ok: false, error: "Only the selected rich local fixture can receive probe input" };
    }

    await browser.debugger.attach({ tabId }, "1.3");
    attached = true;
    const [focused] = await browser.scripting.executeScript({ target: { tabId }, func: focusFixtureEditor });
    if (focused?.result !== true || (await browser.tabs.get(tabId)).url !== richFixtureUrl) {
      return { ok: false, error: "Fixture changed, contains a draft, or editor could not be focused" };
    }

    await browser.debugger.sendCommand({ tabId }, "Input.insertText", { text: fixtureInputText });
    const [readback] = await browser.scripting.executeScript({ target: { tabId }, func: readFixtureEditor });
    if (readback?.result !== fixtureInputText) {
      return { ok: false, error: "Fixture input did not match; draft was not cleared" };
    }
    return { ok: true, characters: fixtureInputText.length };
  } catch {
    return { ok: false, error: "Fixture debugger input unavailable; inspect the draft before retrying" };
  } finally {
    let detachFailed = false;
    if (attached) {
      try {
        await browser.debugger.detach({ tabId });
      } catch {
        detachFailed = true;
      }
    }
    inputInProgress = false;
    if (detachFailed) throw new Error("Fixture debugger did not detach cleanly");
  }
}

function focusGeminiEditor(expectedUrl: string): boolean {
  if (location.href !== expectedUrl || location.origin !== "https://gemini.google.com") return false;
  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const main = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  if (main.length !== 1 || [...main[0]!.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((scroller) => visible(scroller) && scroller.querySelector("user-query, model-response")).length !== 1) return false;

  const editors = [...document.querySelectorAll<HTMLElement>("[contenteditable=true]")]
    .filter((element) => visible(element) && (element.getAttribute("aria-label") === "Enter a prompt for Gemini"
      || element.getAttribute("placeholder") === "Enter a prompt for Gemini"));
  const editor = editors.length === 1 ? editors[0] : undefined;
  if (!editor || !main[0]!.contains(editor) || editor.textContent?.length || editor.innerText.trim()) return false;
  editor.focus();
  return document.activeElement === editor && !editor.textContent?.length && !editor.innerText.trim();
}

function readGeminiEditor(expectedUrl: string): string | null {
  if (location.href !== expectedUrl || location.origin !== "https://gemini.google.com") return null;
  const editors = [...document.querySelectorAll<HTMLElement>("[contenteditable=true]")]
    .filter((element) => element.getClientRects().length > 0
      && (element.getAttribute("aria-label") === "Enter a prompt for Gemini"
        || element.getAttribute("placeholder") === "Enter a prompt for Gemini"));
  return editors.length === 1 ? editors[0]!.innerText.trim() : null;
}

async function prepareGeminiDraft(tabId: number, expectedUrl: string): Promise<FixtureInputResult> {
  if (inputInProgress) return { ok: false, error: "An input probe is already running" };
  inputInProgress = true;
  let attached = false;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = await browser.tabs.get(tabId);
    if (activeTab?.id !== tabId || !tab.active || tab.url !== expectedUrl) {
      return { ok: false, error: "The selected Gemini tab changed; no draft was filled" };
    }
    const url = new URL(expectedUrl);
    if (url.origin !== geminiOrigin || url.pathname.split("/").filter(Boolean).length !== 2) {
      return { ok: false, error: "Open the saved disposable Gemini chat first; no draft was filled" };
    }
    await browser.debugger.attach({ tabId }, "1.3");
    attached = true;
    const [focused] = await browser.scripting.executeScript({
      target: { tabId }, func: focusGeminiEditor, args: [expectedUrl]
    });
    const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (focused?.result !== true || currentTab?.id !== tabId || (await browser.tabs.get(tabId)).url !== expectedUrl) {
      return { ok: false, error: "The conversation changed, has a draft, or editor is ambiguous; no text was inserted" };
    }

    await browser.debugger.sendCommand({ tabId }, "Input.insertText", { text: geminiDraftText });
    const [readback] = await browser.scripting.executeScript({
      target: { tabId }, func: readGeminiEditor, args: [expectedUrl]
    });
    if (readback?.result !== geminiDraftText) {
      return { ok: false, error: "Gemini draft could not be verified; inspect it before any retry" };
    }
    return { ok: true, characters: geminiDraftText.length };
  } catch {
    return { ok: false, error: "Gemini draft input unavailable; inspect the composer before any retry" };
  } finally {
    let detachFailed = false;
    if (attached) {
      try {
        await browser.debugger.detach({ tabId });
      } catch {
        detachFailed = true;
      }
    }
    inputInProgress = false;
    if (detachFailed) throw new Error("Gemini debugger did not detach cleanly; inspect the draft");
  }
}

function isHandshakeReply(value: unknown, requestId: string, deadlineMs: number): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reply = value as Record<string, unknown>;
  if (typeof reply.payload !== "object" || reply.payload === null || Array.isArray(reply.payload)) return false;

  return Object.keys(reply).length === 6
    && reply.kind === "handshake_result"
    && reply.protocolVersion === protocolVersion
    && reply.requestId === requestId
    && reply.connectionGeneration === 0
    && reply.deadlineMs === deadlineMs
    && Object.keys(reply.payload).length === 1
    && (reply.payload as Record<string, unknown>).protocolVersion === protocolVersion;
}

export default defineBackground(() => {
  void ensureFixtureReset().then(async (ready) => {
    if (ready && await hasTrackedFixtureGrant() && await markTrackedFixtureGaps()) startFixtureReadWatch();
    if (ready && await hasTrackedGeminiGrant() && await markTrackedGeminiGaps()) startGeminiReadWatch();
  }).catch(() => {});
  browser.tabs.onRemoved.addListener((tabId) => { void revokeTrackedFixture(tabId).catch(() => {}); });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" || changeInfo.url) {
      void revokeTrackedFixture(tabId, "target_changed").catch(() => {});
    }
  });
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (typeof message === "object" && message !== null && !Array.isArray(message)
      && Object.keys(message).length === 1 && (message as { kind?: unknown }).kind === "gemini_messages_changed") {
      if (sender.id !== browser.runtime.id || sender.origin !== geminiOrigin
        || sender.frameId !== 0 || sender.tab?.id == null || typeof sender.documentId !== "string") return;
      const tabId = sender.tab.id;
      const documentId = sender.documentId;
      return browser.storage.session.get(geminiGrantKey(tabId)).then(async (stored) => {
        const grant = stored[geminiGrantKey(tabId)] as StoredGeminiGrant | undefined;
        if (!grant || grant.documentId !== documentId || !isEligibleGeminiUrl(grant.url)
          || typeof grant.expiresAt !== "number" || grant.expiresAt <= Date.now()) return;
        if (!await queueGeminiSnapshot(tabId, grant.url, documentId)) {
          await revokeTrackedFixture(tabId, await classifyGeminiPublicationFailure(tabId, grant.url, documentId));
        }
      }).catch(() => {});
    }
    if (typeof message === "object" && message !== null && !Array.isArray(message)
      && Object.keys(message).length === 1 && (message as { kind?: unknown }).kind === "gemini_identity_changed") {
      if (sender.id !== browser.runtime.id || sender.origin !== geminiOrigin
        || sender.frameId !== 0 || sender.tab?.id == null || typeof sender.documentId !== "string") return;
      const tabId = sender.tab.id;
      return browser.storage.session.get(geminiGrantKey(tabId)).then(async (stored) => {
        const grant = stored[geminiGrantKey(tabId)] as StoredGeminiGrant | undefined;
        if (grant?.documentId !== sender.documentId) return;
        await revokeTrackedFixture(tabId, "target_changed");
      });
    }
    if (typeof message === "object" && message !== null && !Array.isArray(message)
      && Object.keys(message).length === 1 && (message as { kind?: unknown }).kind === "fixture_messages_changed") {
      if (sender.id !== browser.runtime.id || sender.origin !== "http://127.0.0.1:8787"
        || sender.frameId !== 0 || sender.tab?.id == null || typeof sender.documentId !== "string") return;
      const tabId = sender.tab.id;
      const documentId = sender.documentId;
      return browser.storage.session.get(fixtureGrantKey(tabId)).then(async (stored) => {
        const grant = stored[fixtureGrantKey(tabId)] as StoredFixtureGrant | undefined;
        if (!grant || grant.documentId !== documentId || typeof grant.expiresAt !== "number"
          || grant.expiresAt <= Date.now()) return;
        if (!await queueFixtureSnapshot(tabId, documentId)) await revokeTrackedFixture(tabId);
      }).catch(() => {});
    }
    if (typeof message === "object" && message !== null && !Array.isArray(message)
      && Object.keys(message).length === 1 && (message as { kind?: unknown }).kind === "fixture_identity_changed") {
      if (sender.id !== browser.runtime.id || sender.origin !== "http://127.0.0.1:8787"
        || sender.frameId !== 0 || sender.tab?.id == null || typeof sender.documentId !== "string") return;
      const tabId = sender.tab.id;
      return browser.storage.session.get(fixtureGrantKey(tabId)).then((stored) => {
        const grant = stored[fixtureGrantKey(tabId)] as StoredFixtureGrant | undefined;
        if (grant?.documentId !== sender.documentId) return;
        return revokeTrackedFixture(tabId);
      });
    }
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL("/popup.html")
      || typeof message !== "object" || message === null || Array.isArray(message)) return;

    const request = message as Record<string, unknown>;
    if (request.kind === "list_fixture_pending" && Object.keys(request).length === 2
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0) {
      return listPendingForSelectedTab(request.tabId);
    }
    if (request.kind === "list_fixture_prepared_reviews" && Object.keys(request).length === 3
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0
      && typeof request.expectedUrl === "string" && request.expectedUrl.length < 2048) {
      return listFixtureReviewsForSelectedTab(request.tabId, request.expectedUrl);
    }
    if (request.kind === "approve_fixture_review" && Object.keys(request).length === 5
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0
      && typeof request.expectedUrl === "string" && request.expectedUrl.length < 2048
      && typeof request.operationId === "string" && /^[0-9a-f-]{36}$/.test(request.operationId)
      && typeof request.reviewId === "string" && /^[0-9a-f-]{36}$/.test(request.reviewId)) {
      return approveFixtureReviewForSelectedTab(request.tabId, request.expectedUrl,
        request.operationId, request.reviewId);
    }
    if (request.kind === "list_gemini_pending" && Object.keys(request).length === 3
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0
      && typeof request.expectedUrl === "string" && request.expectedUrl.length <= 512) {
      return listPendingForSelectedTab(request.tabId, request.expectedUrl);
    }
    if (request.kind === "approve_fixture" && Object.keys(request).length === 4
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0
      && typeof request.expectedUrl === "string" && request.expectedUrl.length < 2048
      && typeof request.pendingRequestId === "string" && /^[0-9a-f-]{36}$/.test(request.pendingRequestId)) {
      return approveFixture(request.tabId, request.expectedUrl, request.pendingRequestId);
    }
    if (request.kind === "approve_gemini" && Object.keys(request).length === 4
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0
      && typeof request.expectedUrl === "string" && request.expectedUrl.length <= 512
      && typeof request.pendingRequestId === "string" && /^[0-9a-f-]{36}$/.test(request.pendingRequestId)) {
      return approveGemini(request.tabId, request.expectedUrl, request.pendingRequestId);
    }
    if (request.kind === "probe_fixture_input" && Object.keys(request).length === 2
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0) {
      return probeFixtureInput(request.tabId);
    }
    if (request.kind === "prepare_gemini_draft" && Object.keys(request).length === 3
      && typeof request.tabId === "number" && Number.isSafeInteger(request.tabId) && request.tabId > 0
      && typeof request.expectedUrl === "string" && request.expectedUrl.length < 4096) {
      return prepareGeminiDraft(request.tabId, request.expectedUrl);
    }
    if (request.kind !== "probe_native_handshake") return;

    return new Promise<ProbeResult>((resolve) => {
      try {
        const requestId = crypto.randomUUID();
        const deadlineMs = Date.now() + 10_000;
        const port = browser.runtime.connectNative(nativeHostName);
        let settled = false;
        const timeout = setTimeout(() => finish({ ok: false, error: "Native host timed out" }), 10_000);

        function finish(result: ProbeResult) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(result);
          port.disconnect();
        }

        port.onMessage.addListener((reply: unknown) => {
          finish(isHandshakeReply(reply, requestId, deadlineMs)
            ? { ok: true, protocolVersion }
            : { ok: false, error: "Native host returned an invalid handshake" });
        });
        port.onDisconnect.addListener(() => {
          finish({ ok: false, error: browser.runtime.lastError?.message ?? "Native host disconnected" });
        });
        port.postMessage({
          kind: "handshake",
          protocolVersion,
          requestId,
          connectionGeneration: 0,
          deadlineMs,
          payload: {}
        });
      } catch (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : "Native host unavailable" });
      }
    });
  });
});