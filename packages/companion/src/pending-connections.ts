import { randomUUID } from "node:crypto";
import { ObservationBuffer } from "./observation-buffer.js";

export const PENDING_REQUEST_TTL_MS = 60_000;
export const MAX_PENDING_REQUESTS = 100;
export const READONLY_CONNECTION_TTL_MS = 5 * 60_000;
export const MAX_FIXTURE_SNAPSHOT_MESSAGES = 32;
export const MAX_FIXTURE_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_FIXTURE_SNAPSHOT_AGE_MS = 30_000;
export const MAX_GEMINI_SNAPSHOT_MESSAGES = 32;
export const MAX_GEMINI_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_GEMINI_SNAPSHOT_AGE_MS = 30_000;
export const GEMINI_READ_TIMEOUT_MS = 4_000;
export const MAX_PENDING_GEMINI_READS = 16;
export const MAX_FIXTURE_EVENTS_PER_READ = 2;
export const FIXTURE_READ_TIMEOUT_MS = 4_000;
export const MAX_PENDING_FIXTURE_READS = 16;

export type PendingRequest = Readonly<{
  requestId: string;
  state: "pending" | "expired";
  expiresAt: number;
}>;

export type FixtureTarget = Readonly<{
  origin: "http://127.0.0.1:8787";
  conversationId: "fixture-alpha";
  tabId: number;
  documentId: string;
}>;
export type GeminiTarget = Readonly<{
  origin: "https://gemini.google.com";
  conversationId: string;
  url: string;
  tabId: number;
  documentId: string;
}>;
export type ApprovedTarget = FixtureTarget | GeminiTarget;

export type ReadonlyConnection = Readonly<{
  requestId: string;
  state: "ready_readonly";
  connectionId: string;
  generation: 1;
  origin: ApprovedTarget["origin"];
  conversationId: string;
  expiresAt: number;
}>;
export type ReadonlyConnectionState = ReadonlyConnection & Readonly<{
  observation: Readonly<{ state: "not_observed" | "recent" | "old"; capturedAt: number | null }>;
}>;

export type FixtureMessage = Readonly<{ id: string; direction: "incoming" | "outgoing"; text: string }>;
export type FixtureSnapshot = Readonly<{
  coverage: "rendered_only";
  generation: 1;
  capturedAt: number;
  cursor: Readonly<{ epoch: string; sequence: number }>;
  messages: ReadonlyArray<FixtureMessage>;
}>;
export type GeminiRenderedMessage = Readonly<{ direction: "incoming" | "outgoing"; text: string }>;
export type GeminiSnapshot = Readonly<{
  coverage: "rendered_only";
  generation: 1;
  capturedAt: number;
  cursor: Readonly<{ epoch: string; sequence: number }>;
  messages: ReadonlyArray<Readonly<GeminiRenderedMessage & {
    identityQuality: "uncertain"; generationState: "unknown"
  }>>;
}>;

type FixtureGrant = {
  connection: ReadonlyConnection;
  target: ApprovedTarget;
  stale: boolean;
  observations?: ObservationBuffer;
  snapshot?: FixtureSnapshot;
  geminiObservations?: ObservationBuffer;
  geminiSnapshot?: GeminiSnapshot;
};
type RequestRecord = { owner: symbol; expiresAt: number; grant?: FixtureGrant };
type PendingFixtureRead = {
  owner: symbol;
  connectionId: string;
  target: ApprovedTarget;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (snapshot: FixtureSnapshot | "not_ready" | null) => void;
};
type PendingGeminiRead = {
  owner: symbol;
  connectionId: string;
  target: GeminiTarget;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (snapshot: GeminiSnapshot | "not_ready" | null) => void;
};

export class PendingConnectionRequests {
  private readonly requests = new Map<string, RequestRecord>();
  private readonly fixtureReads = new Map<string, PendingFixtureRead>();
  private readonly geminiReads = new Map<string, PendingGeminiRead>();

  private finishFixtureRead(challengeId: string, result: FixtureSnapshot | "not_ready" | null): void {
    const pending = this.fixtureReads.get(challengeId);
    if (!pending) return;
    this.fixtureReads.delete(challengeId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private finishGeminiRead(challengeId: string, result: GeminiSnapshot | "not_ready" | null): void {
    const pending = this.geminiReads.get(challengeId);
    if (!pending) return;
    this.geminiReads.delete(challengeId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private revokeGrant(grant: FixtureGrant): void {
    grant.stale = true;
    grant.snapshot = undefined;
    grant.observations = undefined;
    grant.geminiSnapshot = undefined;
    grant.geminiObservations = undefined;
    for (const [challengeId, pending] of this.fixtureReads) {
      if (pending.connectionId === grant.connection.connectionId) this.finishFixtureRead(challengeId, null);
    }
    for (const [challengeId, pending] of this.geminiReads) {
      if (pending.connectionId === grant.connection.connectionId) this.finishGeminiRead(challengeId, null);
    }
  }

  private liveGrant(owner: symbol, connectionId: string, now: number): FixtureGrant | null {
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (request.owner === owner && grant?.connection.connectionId === connectionId) {
        return !grant.stale && now < grant.connection.expiresAt ? grant : null;
      }
    }
    return null;
  }

  create(owner: symbol, now = Date.now()): PendingRequest {
    if (typeof owner !== "symbol") throw new TypeError("Caller identity must be broker-owned");
    let pendingCount = 0;
    for (const [requestId, request] of this.requests) {
      if ((request.grant?.connection.expiresAt ?? request.expiresAt) + PENDING_REQUEST_TTL_MS <= now) {
        this.requests.delete(requestId);
      } else if (!request.grant && request.expiresAt > now) pendingCount++;
    }
    if (pendingCount >= MAX_PENDING_REQUESTS) throw new Error("Too many pending connections");

    const requestId = randomUUID();
    const expiresAt = now + PENDING_REQUEST_TTL_MS;
    this.requests.set(requestId, { owner, expiresAt });
    return { requestId, state: "pending", expiresAt };
  }

  get(owner: symbol, requestId: string, now = Date.now()): PendingRequest | ReadonlyConnectionState
    | Readonly<{ requestId: string; state: "stale" }> | null {
    const request = this.requests.get(requestId);
    if (!request || request.owner !== owner) return null;
    const expiresAt = request.grant?.connection.expiresAt ?? request.expiresAt;
    if (expiresAt + PENDING_REQUEST_TTL_MS <= now) {
      this.requests.delete(requestId);
      return null;
    }
    if (request.grant?.stale && now < expiresAt) return { requestId, state: "stale" };
    if (request.grant && now < expiresAt) {
      const capturedAt = request.grant.snapshot?.capturedAt ?? request.grant.geminiSnapshot?.capturedAt ?? null;
      return Object.freeze({ ...request.grant.connection, observation: Object.freeze({
        state: capturedAt === null ? "not_observed" as const
          : now - capturedAt <= (request.grant.target.origin === "https://gemini.google.com"
            ? MAX_GEMINI_SNAPSHOT_AGE_MS : MAX_FIXTURE_SNAPSHOT_AGE_MS) ? "recent" as const : "old" as const,
        capturedAt
      }) });
    }
    return {
      requestId,
      state: now >= expiresAt ? "expired" : "pending",
      expiresAt
    };
  }

  getApprovedTarget(owner: symbol, connectionId: string, now = Date.now()): FixtureTarget | null {
    const target = this.liveGrant(owner, connectionId, now)?.target;
    return target?.origin === "http://127.0.0.1:8787" ? target : null;
  }

  getGeminiTarget(owner: symbol, connectionId: string, now = Date.now()): GeminiTarget | null {
    const target = this.liveGrant(owner, connectionId, now)?.target;
    return target?.origin === "https://gemini.google.com" ? target : null;
  }

  getGeminiSnapshot(owner: symbol, connectionId: string, now = Date.now()): GeminiSnapshot | "not_ready" | null {
    const grant = this.liveGrant(owner, connectionId, now);
    if (grant?.target.origin !== "https://gemini.google.com") return null;
    return grant.geminiSnapshot && now - grant.geminiSnapshot.capturedAt <= MAX_GEMINI_SNAPSHOT_AGE_MS
      ? grant.geminiSnapshot : "not_ready";
  }

  requestFreshGeminiRead(owner: symbol, connectionId: string, now = Date.now()) {
    const grant = this.liveGrant(owner, connectionId, now);
    if (grant?.target.origin !== "https://gemini.google.com") return null;
    if (this.geminiReads.size >= MAX_PENDING_GEMINI_READS) return "busy" as const;
    const challengeId = randomUUID();
    const expiresAt = now + GEMINI_READ_TIMEOUT_MS;
    let resolve!: PendingGeminiRead["resolve"];
    const result = new Promise<GeminiSnapshot | "not_ready" | null>((done) => { resolve = done; });
    const timer = setTimeout(() => this.finishGeminiRead(challengeId, "not_ready"), GEMINI_READ_TIMEOUT_MS);
    this.geminiReads.set(challengeId, { owner, connectionId, target: grant.target, expiresAt, timer, resolve });
    return { challengeId, result };
  }

  listGeminiReadChallenges(now = Date.now()) {
    for (const [challengeId, pending] of this.geminiReads) {
      if (pending.expiresAt <= now) this.finishGeminiRead(challengeId, "not_ready");
    }
    return [...this.geminiReads].map(([challengeId, pending]) => ({
      challengeId, target: pending.target, expiresAt: pending.expiresAt
    }));
  }

  listActiveGeminiTabIds(now = Date.now()): number[] {
    const tabs = new Set<number>();
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (grant?.target.origin === "https://gemini.google.com"
        && !grant.stale && now < grant.connection.expiresAt) tabs.add(grant.target.tabId);
    }
    return [...tabs].sort((first, second) => first - second);
  }

  publishGeminiSnapshot(target: GeminiTarget, messages: ReadonlyArray<GeminiRenderedMessage>,
    now = Date.now(), challengeId?: string): number {
    if (!messages.length || messages.length > MAX_GEMINI_SNAPSHOT_MESSAGES
      || messages.some((message) => typeof message !== "object" || message === null
        || (message.direction !== "incoming" && message.direction !== "outgoing")
        || typeof message.text !== "string" || !message.text || message.text.length > 2048)
      || Buffer.byteLength(JSON.stringify(messages), "utf8") > MAX_GEMINI_SNAPSHOT_BYTES) {
      throw new Error("Invalid Gemini snapshot");
    }
    const pending = challengeId ? this.geminiReads.get(challengeId) : undefined;
    if (challengeId && (!pending || pending.expiresAt <= now
      || pending.target.origin !== target.origin || pending.target.conversationId !== target.conversationId
      || pending.target.url !== target.url || pending.target.tabId !== target.tabId
      || pending.target.documentId !== target.documentId
      || !this.liveGrant(pending.owner, pending.connectionId, now))) return 0;
    const normalized = messages.map((message) => Object.freeze({ direction: message.direction, text: message.text,
      identityQuality: "uncertain" as const, generationState: "unknown" as const }));
    let published = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (!grant || grant.stale || now >= grant.connection.expiresAt
        || grant.target.origin !== target.origin || grant.target.conversationId !== target.conversationId
        || grant.target.url !== target.url || grant.target.tabId !== target.tabId
        || grant.target.documentId !== target.documentId) continue;
      grant.geminiObservations ??= new ObservationBuffer({ maxEvents: 32, maxBytes: 256 * 1024 });
      const previous = grant.geminiSnapshot?.messages;
      if (!previous || previous.length !== normalized.length || normalized.some((message, index) =>
        message.direction !== previous[index]?.direction || message.text !== previous[index]?.text)) {
        grant.geminiObservations.append({ kind: "gemini_snapshot", messages: normalized });
      }
      grant.geminiSnapshot = Object.freeze({ coverage: "rendered_only", generation: 1, capturedAt: now,
        cursor: grant.geminiObservations.bookmark(), messages: Object.freeze(normalized) });
      published++;
    }
    if (pending && challengeId) {
      this.finishGeminiRead(challengeId, this.getGeminiSnapshot(pending.owner, pending.connectionId, now));
    }
    return published;
  }

  getFixtureSnapshot(owner: symbol, connectionId: string, now = Date.now()): FixtureSnapshot | "not_ready" | null {
    const grant = this.liveGrant(owner, connectionId, now);
    if (grant?.target.origin !== "http://127.0.0.1:8787") return null;
    return grant.snapshot && now - grant.snapshot.capturedAt <= MAX_FIXTURE_SNAPSHOT_AGE_MS
      ? grant.snapshot : "not_ready";
  }

  readFixtureEvents(owner: symbol, connectionId: string,
    cursor: { epoch: string; sequence: number }, limit = MAX_FIXTURE_EVENTS_PER_READ, now = Date.now()) {
    const grant = this.liveGrant(owner, connectionId, now);
    if (grant?.target.origin !== "http://127.0.0.1:8787") return null;
    return grant.observations?.read(cursor, limit) ?? "not_ready";
  }

  requestFreshFixtureRead(owner: symbol, connectionId: string, now = Date.now()) {
    const grant = this.liveGrant(owner, connectionId, now);
    if (grant?.target.origin !== "http://127.0.0.1:8787") return null;
    if (this.fixtureReads.size >= MAX_PENDING_FIXTURE_READS) return "busy" as const;
    const challengeId = randomUUID();
    const expiresAt = now + FIXTURE_READ_TIMEOUT_MS;
    let resolve!: PendingFixtureRead["resolve"];
    const result = new Promise<FixtureSnapshot | "not_ready" | null>((done) => { resolve = done; });
    const timer = setTimeout(() => this.finishFixtureRead(challengeId, "not_ready"), FIXTURE_READ_TIMEOUT_MS);
    this.fixtureReads.set(challengeId, { owner, connectionId, target: grant.target, expiresAt, timer, resolve });
    return { challengeId, result };
  }

  listFixtureReadChallenges(now = Date.now()) {
    for (const [challengeId, pending] of this.fixtureReads) {
      if (pending.expiresAt <= now) this.finishFixtureRead(challengeId, "not_ready");
    }
    return [...this.fixtureReads].map(([challengeId, pending]) => ({
      challengeId, target: pending.target, expiresAt: pending.expiresAt
    }));
  }

  listActiveFixtureTabIds(now = Date.now()): number[] {
    const tabs = new Set<number>();
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (grant?.target.origin === "http://127.0.0.1:8787"
        && !grant.stale && now < grant.connection.expiresAt) tabs.add(grant.target.tabId);
    }
    return [...tabs].sort((first, second) => first - second);
  }

  disconnectFixture(owner: symbol, connectionId: string, now = Date.now()): boolean {
    const grant = this.liveGrant(owner, connectionId, now);
    if (!grant) return false;
    this.revokeGrant(grant);
    return true;
  }

  markFixtureObservationGap(target: FixtureTarget, now = Date.now()): number {
    let marked = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (!grant || grant.stale || now >= grant.connection.expiresAt
        || grant.target.origin !== target.origin || grant.target.conversationId !== target.conversationId
        || grant.target.tabId !== target.tabId || grant.target.documentId !== target.documentId) continue;
      if (!grant.snapshot && (!grant.observations || grant.observations.bookmark().sequence === 0)) continue;
      grant.snapshot = undefined;
      grant.observations = new ObservationBuffer({ maxEvents: 32, maxBytes: 256 * 1024 });
      for (const [challengeId, pending] of this.fixtureReads) {
        if (pending.connectionId === grant.connection.connectionId) this.finishFixtureRead(challengeId, "not_ready");
      }
      marked++;
    }
    return marked;
  }

  publishFixtureSnapshot(target: FixtureTarget, messages: ReadonlyArray<FixtureMessage>,
    now = Date.now(), challengeId?: string): number {
    if (messages.length > MAX_FIXTURE_SNAPSHOT_MESSAGES
      || Buffer.byteLength(JSON.stringify(messages), "utf8") > MAX_FIXTURE_SNAPSHOT_BYTES
      || new Set(messages.map((message) => message.id)).size !== messages.length) {
      throw new Error("Invalid fixture snapshot");
    }
    const pending = challengeId ? this.fixtureReads.get(challengeId) : undefined;
    if (challengeId && (!pending || pending.expiresAt <= now
      || pending.target.origin !== target.origin || pending.target.conversationId !== target.conversationId
      || pending.target.tabId !== target.tabId || pending.target.documentId !== target.documentId
      || !this.liveGrant(pending.owner, pending.connectionId, now))) return 0;
    let published = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (!grant || grant.stale || now >= grant.connection.expiresAt
        || grant.target.origin !== target.origin || grant.target.conversationId !== target.conversationId
        || grant.target.tabId !== target.tabId || grant.target.documentId !== target.documentId) continue;
      grant.observations ??= new ObservationBuffer({ maxEvents: 32, maxBytes: 256 * 1024 });
      const previous = grant.snapshot?.messages;
      if (!previous || previous.length !== messages.length || messages.some((message, index) =>
        message.id !== previous[index]?.id || message.direction !== previous[index]?.direction
          || message.text !== previous[index]?.text)) {
        grant.observations.append({ kind: "fixture_snapshot", messages });
      }
      grant.snapshot = Object.freeze({
        coverage: "rendered_only", generation: 1, capturedAt: now,
        cursor: grant.observations.bookmark(),
        messages: Object.freeze(messages.map((message) => Object.freeze({ ...message })))
      });
      published++;
    }
    if (pending && challengeId) {
      this.finishFixtureRead(challengeId, this.getFixtureSnapshot(pending.owner, pending.connectionId, now));
    }
    return published;
  }

  approve(requestId: string, target: FixtureTarget, now = Date.now()): ReadonlyConnection | null {
    if (target.origin !== "http://127.0.0.1:8787" || target.conversationId !== "fixture-alpha"
      || !Number.isSafeInteger(target.tabId) || target.tabId < 1
      || !/^[!-~]{1,128}$/.test(target.documentId)) return null;
    return this.createGrant(requestId, target, now);
  }

  approveGemini(requestId: string, target: GeminiTarget, now = Date.now()): ReadonlyConnection | null {
    if (target.origin !== "https://gemini.google.com" || !Number.isSafeInteger(target.tabId) || target.tabId < 1
      || !/^[!-~]{1,128}$/.test(target.documentId) || target.url.length > 512) return null;
    try {
      const url = new URL(target.url);
      const route = url.pathname.split("/").filter(Boolean);
      if (url.origin !== target.origin || url.username || url.password || url.hash
        || url.href !== target.url || route.length !== 2
        || route.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))
        || route[1] !== target.conversationId) return null;
    } catch {
      return null;
    }
    return this.createGrant(requestId, target, now);
  }

  private createGrant(requestId: string, target: ApprovedTarget, now: number): ReadonlyConnection | null {
    const request = this.requests.get(requestId);
    if (!request || request.grant || now >= request.expiresAt) return null;

    const connection = Object.freeze({
      requestId,
      state: "ready_readonly" as const,
      connectionId: randomUUID(),
      generation: 1 as const,
      origin: target.origin,
      conversationId: target.conversationId,
      expiresAt: now + READONLY_CONNECTION_TTL_MS
    });
    request.grant = { connection, target: Object.freeze({ ...target }), stale: false };
    return connection;
  }

  revokeChangedTab(tabId: number, observed: { documentId: string; conversationId: string } | null): number {
    let revoked = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (grant && grant.target.tabId === tabId && !grant.stale
        && (!observed || grant.target.documentId !== observed.documentId
          || grant.target.conversationId !== observed.conversationId)) {
        this.revokeGrant(grant);
        revoked++;
      }
    }
    return revoked;
  }

  revokeAllFixtures(): number {
    let revoked = 0;
    for (const request of this.requests.values()) {
      if (request.grant && !request.grant.stale) {
        this.revokeGrant(request.grant);
        revoked++;
      }
    }
    return revoked;
  }

  listPending(now = Date.now()): ReadonlyArray<Readonly<{ requestId: string; expiresAt: number }>> {
    return [...this.requests]
      .filter(([, request]) => !request.grant && request.expiresAt > now)
      .slice(0, MAX_PENDING_REQUESTS)
      .map(([requestId, request]) => Object.freeze({ requestId, expiresAt: request.expiresAt }));
  }

  disconnect(owner: symbol): void {
    for (const [challengeId, pending] of this.fixtureReads) {
      if (pending.owner === owner) this.finishFixtureRead(challengeId, null);
    }
    for (const [challengeId, pending] of this.geminiReads) {
      if (pending.owner === owner) this.finishGeminiRead(challengeId, null);
    }
    for (const [requestId, request] of this.requests) {
      if (request.owner === owner) this.requests.delete(requestId);
    }
  }
}