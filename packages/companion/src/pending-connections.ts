import { randomUUID } from "node:crypto";
import { ObservationBuffer } from "./observation-buffer.js";

export const PENDING_REQUEST_TTL_MS = 60_000;
export const MAX_PENDING_REQUESTS = 100;
export const READONLY_CONNECTION_TTL_MS = 5 * 60_000;
export const MAX_FIXTURE_SNAPSHOT_MESSAGES = 32;
export const MAX_FIXTURE_SNAPSHOT_BYTES = 64 * 1024;

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

export type ReadonlyConnection = Readonly<{
  requestId: string;
  state: "ready_readonly";
  connectionId: string;
  generation: 1;
  origin: FixtureTarget["origin"];
  conversationId: FixtureTarget["conversationId"];
  expiresAt: number;
}>;

export type FixtureMessage = Readonly<{ id: string; direction: "incoming" | "outgoing"; text: string }>;
export type FixtureSnapshot = Readonly<{
  coverage: "rendered_only";
  generation: 1;
  capturedAt: number;
  cursor: Readonly<{ epoch: string; sequence: number }>;
  messages: ReadonlyArray<FixtureMessage>;
}>;

type FixtureGrant = {
  connection: ReadonlyConnection;
  target: FixtureTarget;
  stale: boolean;
  observations?: ObservationBuffer;
  snapshot?: FixtureSnapshot;
};
type RequestRecord = { owner: symbol; expiresAt: number; grant?: FixtureGrant };

export class PendingConnectionRequests {
  private readonly requests = new Map<string, RequestRecord>();

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

  get(owner: symbol, requestId: string, now = Date.now()): PendingRequest | ReadonlyConnection
    | Readonly<{ requestId: string; state: "stale" }> | null {
    const request = this.requests.get(requestId);
    if (!request || request.owner !== owner) return null;
    const expiresAt = request.grant?.connection.expiresAt ?? request.expiresAt;
    if (expiresAt + PENDING_REQUEST_TTL_MS <= now) {
      this.requests.delete(requestId);
      return null;
    }
    if (request.grant?.stale && now < expiresAt) return { requestId, state: "stale" };
    if (request.grant && now < expiresAt) return request.grant.connection;
    return {
      requestId,
      state: now >= expiresAt ? "expired" : "pending",
      expiresAt
    };
  }

  getApprovedTarget(owner: symbol, connectionId: string, now = Date.now()): FixtureTarget | null {
    return this.liveGrant(owner, connectionId, now)?.target ?? null;
  }

  getFixtureSnapshot(owner: symbol, connectionId: string, now = Date.now()): FixtureSnapshot | "not_ready" | null {
    const grant = this.liveGrant(owner, connectionId, now);
    return grant ? grant.snapshot ?? "not_ready" : null;
  }

  publishFixtureSnapshot(target: FixtureTarget, messages: ReadonlyArray<FixtureMessage>, now = Date.now()): number {
    if (messages.length > MAX_FIXTURE_SNAPSHOT_MESSAGES
      || Buffer.byteLength(JSON.stringify(messages), "utf8") > MAX_FIXTURE_SNAPSHOT_BYTES
      || new Set(messages.map((message) => message.id)).size !== messages.length) {
      throw new Error("Invalid fixture snapshot");
    }
    let published = 0;
    for (const request of this.requests.values()) {
      const grant = request.grant;
      if (!grant || grant.stale || now >= grant.connection.expiresAt
        || grant.target.origin !== target.origin || grant.target.conversationId !== target.conversationId
        || grant.target.tabId !== target.tabId || grant.target.documentId !== target.documentId) continue;
      grant.observations ??= new ObservationBuffer({ maxEvents: 32, maxBytes: 256 * 1024 });
      grant.observations.append({ kind: "fixture_snapshot", messages });
      grant.snapshot = Object.freeze({
        coverage: "rendered_only", generation: 1, capturedAt: now,
        cursor: grant.observations.bookmark(),
        messages: Object.freeze(messages.map((message) => Object.freeze({ ...message })))
      });
      published++;
    }
    return published;
  }

  approve(requestId: string, target: FixtureTarget, now = Date.now()): ReadonlyConnection | null {
    const request = this.requests.get(requestId);
    if (!request || request.grant || now >= request.expiresAt
      || target.origin !== "http://127.0.0.1:8787" || target.conversationId !== "fixture-alpha"
      || !Number.isSafeInteger(target.tabId) || target.tabId < 1
      || !/^[!-~]{1,128}$/.test(target.documentId)) return null;

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
        grant.stale = true;
        grant.snapshot = undefined;
        grant.observations = undefined;
        revoked++;
      }
    }
    return revoked;
  }

  revokeAllFixtures(): number {
    let revoked = 0;
    for (const request of this.requests.values()) {
      if (request.grant && !request.grant.stale) {
        request.grant.stale = true;
        request.grant.snapshot = undefined;
        request.grant.observations = undefined;
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
    for (const [requestId, request] of this.requests) {
      if (request.owner === owner) this.requests.delete(requestId);
    }
  }
}