import { randomUUID } from "node:crypto";
import { ObservationBuffer } from "./observation-buffer.js";

export const PENDING_REQUEST_TTL_MS = 60_000;
export const MAX_PENDING_REQUESTS = 100;
export const MAX_CONNECTED_AGENTS = 16;
export const MAX_AUTONOMOUS_CONNECTIONS = 100;
export const MAX_CONNECTION_WAIT_MS = 20_000;
export const READONLY_CONNECTION_TTL_MS = 5 * 60_000;
export const MAX_FIXTURE_SNAPSHOT_MESSAGES = 32;
export const MAX_FIXTURE_SNAPSHOT_BYTES = 96 * 1024;
export const MAX_FIXTURE_SNAPSHOT_AGE_MS = 30_000;
export const MAX_GEMINI_SNAPSHOT_MESSAGES = 32;
export const MAX_GEMINI_SNAPSHOT_BYTES = 96 * 1024;
export const MAX_GEMINI_SNAPSHOT_AGE_MS = 30_000;
export const MAX_GEMINI_EVENTS_PER_READ = 2;
export const GEMINI_READ_TIMEOUT_MS = 4_000;
export const MAX_PENDING_GEMINI_READS = 16;
export const MAX_FIXTURE_EVENTS_PER_READ = 2;
export const FIXTURE_READ_TIMEOUT_MS = 4_000;
export const MAX_PENDING_FIXTURE_READS = 16;
const observationLimits = { maxEvents: 128, maxBytes: 4 * 1024 * 1024 };

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

export type ConnectedAgent = Readonly<{ agentId: string; label: string }>;
export type ChatAgent = ConnectedAgent & Readonly<{ connectionCount: number; autonomous?: true }>;

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
export type AutonomousConnection = Readonly<Omit<ReadonlyConnection, "state" | "expiresAt"> & {
  state: "ready";
  capabilities: readonly ["read", "send"];
  expiresAt: null;
}>;
export type ApprovedConnection = ReadonlyConnection | AutonomousConnection;
export type ApprovedConnectionState = ApprovedConnection & Pick<ReadonlyConnectionState, "observation">;
export type ConnectionPickup = Readonly<{ connections: ReadonlyArray<AutonomousConnection>; timedOut: boolean }>;

export type FixtureMessage = Readonly<{ id: string; direction: "incoming" | "outgoing"; text: string; truncated?: true }>;
export type FixtureSnapshot = Readonly<{
  coverage: "rendered_only";
  generation: 1;
  capturedAt: number;
  cursor: Readonly<{ epoch: string; sequence: number }>;
  omittedBefore: boolean;
  messages: ReadonlyArray<FixtureMessage>;
}>;
export type GeminiRenderedMessage = Readonly<{ direction: "incoming" | "outgoing"; text: string; truncated?: true }>;
export type GeminiSnapshot = Readonly<{
  coverage: "rendered_only";
  generation: 1;
  capturedAt: number;
  cursor: Readonly<{ epoch: string; sequence: number }>;
  omittedBefore: boolean;
  messages: ReadonlyArray<Readonly<GeminiRenderedMessage & {
    identityQuality: "uncertain"; generationState: "unknown"
  }>>;
}>;

type FixtureGrant = {
  connection: ApprovedConnection;
  target: ApprovedTarget;
  stale: boolean;
  reloadPending?: boolean;
  revokedAt?: number;
  observations?: ObservationBuffer;
  snapshot?: FixtureSnapshot;
  geminiObservations?: ObservationBuffer;
  geminiSnapshot?: GeminiSnapshot;
};
type RequestRecord = { owner: symbol; expiresAt: number; grant?: FixtureGrant };
type ConnectionWait = {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (pickup: ConnectionPickup) => void;
};
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
  private readonly agents = new Map<symbol, ConnectedAgent>();
  private readonly connectionWaits = new Map<symbol, ConnectionWait>();
  private readonly requests = new Map<string, RequestRecord>();
  private readonly fixtureReads = new Map<string, PendingFixtureRead>();
  private readonly geminiReads = new Map<string, PendingGeminiRead>();

  registerAgent(owner: symbol, label = "MCP agent"): ConnectedAgent {
    if (typeof owner !== "symbol" || !/^[ -~]{1,80}$/.test(label) || label.trim() !== label) {
      throw new TypeError("Invalid broker-owned agent identity or display label");
    }
    if (this.agents.has(owner)) throw new Error("Agent is already registered");
    if (this.agents.size >= MAX_CONNECTED_AGENTS) throw new Error("Too many connected agents");
    const agent = Object.freeze({ agentId: randomUUID(), label });
    this.agents.set(owner, agent);
    return agent;
  }

  private matchesTarget(first: ApprovedTarget, second: ApprovedTarget): boolean {
    return first.origin === second.origin && first.conversationId === second.conversationId
      && first.tabId === second.tabId && first.documentId === second.documentId
      && (first.origin !== "https://gemini.google.com"
        || (second.origin === "https://gemini.google.com" && first.url === second.url));
  }

  private isAuthorizedGrant(grant: FixtureGrant, now: number): boolean {
    return !grant.stale && now < (grant.connection.expiresAt ?? Infinity);
  }

  private isLiveGrant(grant: FixtureGrant, now: number): boolean {
    return this.isAuthorizedGrant(grant, now) && !grant.reloadPending;
  }

  private recordExpiresAt(request: RequestRecord): number {
    if (!request.grant) return request.expiresAt;
    return request.grant.connection.expiresAt ?? request.grant.revokedAt ?? Infinity;
  }

  private pruneExpiredRecords(now: number): void {
    for (const [requestId, request] of this.requests) {
      if (this.recordExpiresAt(request) + PENDING_REQUEST_TTL_MS <= now) this.requests.delete(requestId);
    }
  }

  private ownedAutonomousConnections(owner: symbol, now: number): ReadonlyArray<AutonomousConnection> {
    return Object.freeze([...this.requests.values()].flatMap(request => {
      const grant = request.grant;
      return request.owner === owner && grant?.connection.state === "ready" && this.isLiveGrant(grant, now)
        ? [grant.connection] : [];
    }));
  }

  private finishConnectionWait(owner: symbol, pickup: ConnectionPickup, now = Date.now()): void {
    const pending = this.connectionWaits.get(owner);
    if (!pending) return;
    this.connectionWaits.delete(owner);
    clearTimeout(pending.timer);
    pending.resolve(Object.freeze(pickup.connections.length && now >= pending.expiresAt
      ? { connections: Object.freeze([]), timedOut: true } : pickup));
  }

  waitForConnection(owner: symbol, now = Date.now(), deadlineMs = now + MAX_CONNECTION_WAIT_MS) {
    if (!this.agents.has(owner) || !Number.isSafeInteger(now) || !Number.isSafeInteger(deadlineMs) || deadlineMs < now
      || deadlineMs > now + MAX_CONNECTION_WAIT_MS) return null;
    const connections = this.ownedAutonomousConnections(owner, now);
    if (connections.length || deadlineMs === now) return Promise.resolve(Object.freeze({ connections, timedOut: !connections.length }));
    if (this.connectionWaits.has(owner)) return "busy" as const;
    return new Promise<ConnectionPickup>(resolve => {
      const timer = setTimeout(() => this.finishConnectionWait(owner, { connections: Object.freeze([]), timedOut: true }), deadlineMs - now);
      this.connectionWaits.set(owner, { expiresAt: deadlineMs, timer, resolve });
    });
  }

  listChatAgents(target?: ApprovedTarget, now = Date.now()): ReadonlyArray<ChatAgent> {
    return Object.freeze([...this.agents].map(([owner, agent]) => {
      let connectionCount = 0;
      let autonomous = false;
      for (const request of this.requests.values()) {
        const grant = request.grant;
        if (target && request.owner === owner && grant && this.isAuthorizedGrant(grant, now)
          && this.matchesTarget(grant.target, target)) {
          connectionCount++;
          autonomous ||= grant.connection.state === "ready";
        }
      }
      return Object.freeze({ ...agent, connectionCount, ...(autonomous ? { autonomous: true as const } : {}) });
    }));
  }

  removeChatAgent(agentId: string, target: ApprovedTarget, now = Date.now()): number {
    const entry = [...this.agents].find(([, agent]) => agent.agentId === agentId);
    if (!entry) return 0;
    let revoked = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (request.owner === entry[0] && grant && this.isAuthorizedGrant(grant, now)
        && this.matchesTarget(grant.target, target)) {
        this.revokeGrant(grant, now);
        revoked++;
      }
    }
    return revoked;
  }

  disconnectChat(target: ApprovedTarget, now = Date.now()): number {
    let revoked = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (grant && this.isAuthorizedGrant(grant, now) && this.matchesTarget(grant.target, target)) {
        this.revokeGrant(grant, now);
        revoked++;
      }
    }
    return revoked;
  }

  beginChatReload(target: ApprovedTarget, now = Date.now()): number {
    if (!this.validTarget(target)) return 0;
    let preserved = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (!grant || !this.isAuthorizedGrant(grant, now) || !this.matchesTarget(grant.target, target)) continue;
      if (grant.connection.state !== "ready") {
        this.revokeGrant(grant, now);
        continue;
      }
      grant.reloadPending = true;
      grant.snapshot = undefined;
      grant.geminiSnapshot = undefined;
      if (target.origin === "http://127.0.0.1:8787") grant.observations = new ObservationBuffer(observationLimits);
      else grant.geminiObservations = new ObservationBuffer(observationLimits);
      for (const [challengeId, pending] of this.fixtureReads) {
        if (pending.connectionId === grant.connection.connectionId) this.finishFixtureRead(challengeId, "not_ready");
      }
      for (const [challengeId, pending] of this.geminiReads) {
        if (pending.connectionId === grant.connection.connectionId) this.finishGeminiRead(challengeId, "not_ready");
      }
      preserved++;
    }
    return preserved;
  }

  rebindChat(previous: ApprovedTarget, target: ApprovedTarget, now = Date.now()): number {
    if (!this.validTarget(previous) || !this.validTarget(target) || previous.documentId === target.documentId
      || !this.matchesTarget(previous, { ...target, documentId: previous.documentId })) return 0;
    let rebound = 0;
    const owners = new Set<symbol>();
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (!grant || grant.connection.state !== "ready" || !grant.reloadPending || !this.isAuthorizedGrant(grant, now)
        || !this.matchesTarget(grant.target, previous)) continue;
      grant.target = Object.freeze({ ...target });
      grant.reloadPending = false;
      owners.add(request.owner);
      rebound++;
    }
    for (const owner of owners) {
      this.finishConnectionWait(owner, { connections: this.ownedAutonomousConnections(owner, now), timedOut: false }, now);
    }
    return rebound;
  }

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

  private revokeGrant(grant: FixtureGrant, now = Date.now()): void {
    grant.stale = true;
    grant.revokedAt = now;
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

  private liveGrant(owner: symbol, connectionId: string, now: number, allowReload = false): FixtureGrant | null {
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (request.owner === owner && grant?.connection.connectionId === connectionId) {
        return this.isAuthorizedGrant(grant, now) && (allowReload || !grant.reloadPending) ? grant : null;
      }
    }
    return null;
  }

  create(owner: symbol, now = Date.now()): PendingRequest {
    if (typeof owner !== "symbol") throw new TypeError("Caller identity must be broker-owned");
    this.pruneExpiredRecords(now);
    const pendingCount = [...this.requests.values()].filter(request => !request.grant && request.expiresAt > now).length;
    if (pendingCount >= MAX_PENDING_REQUESTS) throw new Error("Too many pending connections");

    const requestId = randomUUID();
    const expiresAt = now + PENDING_REQUEST_TTL_MS;
    this.requests.set(requestId, { owner, expiresAt });
    return { requestId, state: "pending", expiresAt };
  }

  get(owner: symbol, requestId: string, now = Date.now()): PendingRequest | ApprovedConnectionState
    | Readonly<{ requestId: string; state: "stale" }> | null {
    const request = this.requests.get(requestId);
    if (!request || request.owner !== owner) return null;
    const expiresAt = this.recordExpiresAt(request);
    if (expiresAt + PENDING_REQUEST_TTL_MS <= now) {
      this.requests.delete(requestId);
      return null;
    }
    if (request.grant?.stale && (request.grant.connection.expiresAt === null || now < expiresAt)) return { requestId, state: "stale" };
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

  getConnectionExpiresAt(owner: symbol, connectionId: string, now = Date.now()): number | null {
    const grant = this.liveGrant(owner, connectionId, now);
    return grant ? grant.connection.expiresAt ?? Infinity : null;
  }

  getGeminiSnapshot(owner: symbol, connectionId: string, now = Date.now()): GeminiSnapshot | "not_ready" | null {
    const grant = this.liveGrant(owner, connectionId, now);
    if (grant?.target.origin !== "https://gemini.google.com") return null;
    return grant.geminiSnapshot && now - grant.geminiSnapshot.capturedAt <= MAX_GEMINI_SNAPSHOT_AGE_MS
      ? grant.geminiSnapshot : "not_ready";
  }

  readGeminiEvents(owner: symbol, connectionId: string,
    cursor: { epoch: string; sequence: number }, limit = MAX_GEMINI_EVENTS_PER_READ, now = Date.now()) {
    const grant = this.liveGrant(owner, connectionId, now);
    if (grant?.target.origin !== "https://gemini.google.com") return null;
    return grant.geminiObservations?.read(cursor, limit) ?? "not_ready";
  }

  requestFreshGeminiRead(owner: symbol, connectionId: string, now = Date.now(), deadlineMs = now + GEMINI_READ_TIMEOUT_MS) {
    const grant = this.liveGrant(owner, connectionId, now);
    if (grant?.target.origin !== "https://gemini.google.com" || !Number.isSafeInteger(deadlineMs) || deadlineMs <= now) return null;
    if (this.geminiReads.size >= MAX_PENDING_GEMINI_READS) return "busy" as const;
    const challengeId = randomUUID();
    const expiresAt = Math.min(now + GEMINI_READ_TIMEOUT_MS, deadlineMs, grant.connection.expiresAt ?? Infinity);
    let resolve!: PendingGeminiRead["resolve"];
    const result = new Promise<GeminiSnapshot | "not_ready" | null>((done) => { resolve = done; });
    const timer = setTimeout(() => this.finishGeminiRead(challengeId, "not_ready"), expiresAt - now);
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
        && this.isAuthorizedGrant(grant, now)) tabs.add(grant.target.tabId);
    }
    return [...tabs].sort((first, second) => first - second);
  }

  publishGeminiSnapshot(target: GeminiTarget, messages: ReadonlyArray<GeminiRenderedMessage>,
    now = Date.now(), challengeId?: string, omittedBefore = false): number {
    if (!messages.length || messages.length > MAX_GEMINI_SNAPSHOT_MESSAGES
      || typeof omittedBefore !== "boolean"
      || messages.some((message) => typeof message !== "object" || message === null
        || Object.keys(message).some((key) => !["direction", "text", "truncated"].includes(key))
        || ("truncated" in message && message.truncated !== true)
        || (message.direction !== "incoming" && message.direction !== "outgoing")
        || typeof message.text !== "string" || !message.text || message.text.length > 16_000)
      || Buffer.byteLength(JSON.stringify({ messages, omittedBefore }), "utf8") > MAX_GEMINI_SNAPSHOT_BYTES) {
      throw new Error("Invalid Gemini snapshot");
    }
    const pending = challengeId ? this.geminiReads.get(challengeId) : undefined;
    if (challengeId && (!pending || pending.expiresAt <= now
      || pending.target.origin !== target.origin || pending.target.conversationId !== target.conversationId
      || pending.target.url !== target.url || pending.target.tabId !== target.tabId
      || pending.target.documentId !== target.documentId
      || !this.liveGrant(pending.owner, pending.connectionId, now))) return 0;
    const normalized = messages.map((message) => Object.freeze({ direction: message.direction, text: message.text,
      ...(message.truncated ? { truncated: true as const } : {}),
      identityQuality: "uncertain" as const, generationState: "unknown" as const }));
    let published = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (!grant || !this.isLiveGrant(grant, now)
        || grant.target.origin !== target.origin || grant.target.conversationId !== target.conversationId
        || grant.target.url !== target.url || grant.target.tabId !== target.tabId
        || grant.target.documentId !== target.documentId) continue;
      grant.geminiObservations ??= new ObservationBuffer(observationLimits);
      const previous = grant.geminiSnapshot?.messages;
      if (!previous || grant.geminiSnapshot?.omittedBefore !== omittedBefore
        || previous.length !== normalized.length || normalized.some((message, index) =>
        message.direction !== previous[index]?.direction || message.text !== previous[index]?.text
          || message.truncated !== previous[index]?.truncated)) {
        grant.geminiObservations.append({ kind: "gemini_snapshot", messages: normalized, omittedBefore });
      }
      grant.geminiSnapshot = Object.freeze({ coverage: "rendered_only", generation: 1, capturedAt: now,
        cursor: grant.geminiObservations.bookmark(), messages: Object.freeze(normalized), omittedBefore });
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

  requestFreshFixtureRead(owner: symbol, connectionId: string, now = Date.now(), deadlineMs = now + FIXTURE_READ_TIMEOUT_MS) {
    const grant = this.liveGrant(owner, connectionId, now);
    if (grant?.target.origin !== "http://127.0.0.1:8787" || !Number.isSafeInteger(deadlineMs) || deadlineMs <= now) return null;
    if (this.fixtureReads.size >= MAX_PENDING_FIXTURE_READS) return "busy" as const;
    const challengeId = randomUUID();
    const expiresAt = Math.min(now + FIXTURE_READ_TIMEOUT_MS, deadlineMs, grant.connection.expiresAt ?? Infinity);
    let resolve!: PendingFixtureRead["resolve"];
    const result = new Promise<FixtureSnapshot | "not_ready" | null>((done) => { resolve = done; });
    const timer = setTimeout(() => this.finishFixtureRead(challengeId, "not_ready"), expiresAt - now);
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
        && this.isAuthorizedGrant(grant, now)) tabs.add(grant.target.tabId);
    }
    return [...tabs].sort((first, second) => first - second);
  }

  disconnectFixture(owner: symbol, connectionId: string, now = Date.now()): boolean {
    const grant = this.liveGrant(owner, connectionId, now, true);
    if (!grant) return false;
    this.revokeGrant(grant, now);
    return true;
  }

  markFixtureObservationGap(target: FixtureTarget, now = Date.now()): number {
    let marked = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (!grant || !this.isLiveGrant(grant, now)
        || grant.target.origin !== target.origin || grant.target.conversationId !== target.conversationId
        || grant.target.tabId !== target.tabId || grant.target.documentId !== target.documentId) continue;
      if (!grant.snapshot && (!grant.observations || grant.observations.bookmark().sequence === 0)) continue;
      grant.snapshot = undefined;
      grant.observations = new ObservationBuffer(observationLimits);
      for (const [challengeId, pending] of this.fixtureReads) {
        if (pending.connectionId === grant.connection.connectionId) this.finishFixtureRead(challengeId, "not_ready");
      }
      marked++;
    }
    return marked;
  }

  markGeminiObservationGap(target: GeminiTarget, now = Date.now()): number {
    let marked = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (!grant || !this.isLiveGrant(grant, now)
        || grant.target.origin !== target.origin || grant.target.conversationId !== target.conversationId
        || grant.target.url !== target.url || grant.target.tabId !== target.tabId
        || grant.target.documentId !== target.documentId) continue;
      if (!grant.geminiSnapshot
        && (!grant.geminiObservations || grant.geminiObservations.bookmark().sequence === 0)) continue;
      grant.geminiSnapshot = undefined;
      grant.geminiObservations = new ObservationBuffer(observationLimits);
      for (const [challengeId, pending] of this.geminiReads) {
        if (pending.connectionId === grant.connection.connectionId) this.finishGeminiRead(challengeId, "not_ready");
      }
      marked++;
    }
    return marked;
  }

  publishFixtureSnapshot(target: FixtureTarget, messages: ReadonlyArray<FixtureMessage>,
    now = Date.now(), challengeId?: string, omittedBefore = false): number {
    if (messages.length > MAX_FIXTURE_SNAPSHOT_MESSAGES
      || typeof omittedBefore !== "boolean"
      || messages.some((message) => typeof message !== "object" || message === null
        || Object.keys(message).some((key) => !["id", "direction", "text", "truncated"].includes(key))
        || ("truncated" in message && message.truncated !== true)
        || typeof message.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.id)
        || (message.direction !== "incoming" && message.direction !== "outgoing")
        || typeof message.text !== "string" || message.text.length > 16_000)
      || Buffer.byteLength(JSON.stringify({ messages, omittedBefore }), "utf8") > MAX_FIXTURE_SNAPSHOT_BYTES
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
      if (!grant || !this.isLiveGrant(grant, now)
        || grant.target.origin !== target.origin || grant.target.conversationId !== target.conversationId
        || grant.target.tabId !== target.tabId || grant.target.documentId !== target.documentId) continue;
      grant.observations ??= new ObservationBuffer(observationLimits);
      const previous = grant.snapshot?.messages;
      if (!previous || grant.snapshot?.omittedBefore !== omittedBefore
        || previous.length !== messages.length || messages.some((message, index) =>
        message.id !== previous[index]?.id || message.direction !== previous[index]?.direction
          || message.text !== previous[index]?.text || message.truncated !== previous[index]?.truncated)) {
        grant.observations.append({ kind: "fixture_snapshot", messages, omittedBefore });
      }
      grant.snapshot = Object.freeze({
        coverage: "rendered_only", generation: 1, capturedAt: now,
        cursor: grant.observations.bookmark(), omittedBefore,
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
    if (target.origin !== "http://127.0.0.1:8787" || !this.validTarget(target)) return null;
    return this.createGrant(requestId, target, now);
  }

  approveGemini(requestId: string, target: GeminiTarget, now = Date.now()): ReadonlyConnection | null {
    if (target.origin !== "https://gemini.google.com" || !this.validTarget(target)) return null;
    return this.createGrant(requestId, target, now);
  }

  approveAgent(agentId: string, target: ApprovedTarget, now = Date.now()): AutonomousConnection | null {
    const entry = [...this.agents].find(([, agent]) => agent.agentId === agentId);
    if (!entry || !Number.isSafeInteger(now) || now < 0 || !this.validTarget(target)) return null;
    const owner = entry[0];
    this.pruneExpiredRecords(now);
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (request.owner === owner && grant?.connection.state === "ready" && this.isAuthorizedGrant(grant, now)
        && this.matchesTarget(grant.target, target)) return grant.connection;
    }
    if ([...this.requests.values()].filter(request => request.grant?.connection.state === "ready").length
      >= MAX_AUTONOMOUS_CONNECTIONS) return null;
    const pending = this.create(owner, now);
    const connection: AutonomousConnection = Object.freeze({ requestId: pending.requestId, state: "ready",
      connectionId: randomUUID(), generation: 1, origin: target.origin, conversationId: target.conversationId,
      capabilities: Object.freeze(["read", "send"] as const), expiresAt: null });
    this.requests.get(pending.requestId)!.grant = { connection, target: Object.freeze({ ...target }), stale: false };
    this.finishConnectionWait(owner, { connections: this.ownedAutonomousConnections(owner, now), timedOut: false }, now);
    return connection;
  }

  private validTarget(target: ApprovedTarget): boolean {
    if (target.origin === "http://127.0.0.1:8787") {
      return target.conversationId === "fixture-alpha" && Number.isSafeInteger(target.tabId) && target.tabId > 0
        && /^[!-~]{1,128}$/.test(target.documentId);
    }
    if (target.origin !== "https://gemini.google.com" || !Number.isSafeInteger(target.tabId) || target.tabId < 1
      || !/^[!-~]{1,128}$/.test(target.documentId) || target.url.length > 512) return false;
    try {
      const url = new URL(target.url);
      const route = url.pathname.split("/").filter(Boolean);
      if (url.origin !== target.origin || url.username || url.password || url.hash
        || url.href !== target.url || route.length !== 2
        || route.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))
        || route[1] !== target.conversationId) return false;
    } catch {
      return false;
    }
    return true;
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

  revokeChangedTab(tabId: number, observed: { documentId: string; conversationId: string } | null, now = Date.now()): number {
    let revoked = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (grant && grant.target.tabId === tabId && !grant.stale
        && (!observed || grant.target.documentId !== observed.documentId
          || grant.target.conversationId !== observed.conversationId)) {
        this.revokeGrant(grant, now);
        revoked++;
      }
    }
    return revoked;
  }

  revokeAllFixtures(now = Date.now()): number {
    let revoked = 0;
    for (const request of this.requests.values()) {
      if (request.grant && !request.grant.stale) {
        this.revokeGrant(request.grant, now);
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
    this.agents.delete(owner);
    this.finishConnectionWait(owner, { connections: Object.freeze([]), timedOut: false });
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