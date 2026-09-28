import { randomUUID } from "node:crypto";

export const PENDING_REQUEST_TTL_MS = 60_000;
export const MAX_PENDING_REQUESTS = 100;
export const READONLY_CONNECTION_TTL_MS = 5 * 60_000;

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

type RequestRecord = { owner: symbol; expiresAt: number; grant?: {
  connection: ReadonlyConnection; target: FixtureTarget; stale: boolean
} };

export class PendingConnectionRequests {
  private readonly requests = new Map<string, RequestRecord>();

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