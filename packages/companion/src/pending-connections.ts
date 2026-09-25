import { randomUUID } from "node:crypto";

export const PENDING_REQUEST_TTL_MS = 60_000;
export const MAX_PENDING_REQUESTS = 100;

export type PendingRequest = Readonly<{
  requestId: string;
  state: "pending" | "expired";
  expiresAt: number;
}>;

type RequestRecord = { owner: symbol; expiresAt: number };

export class PendingConnectionRequests {
  private readonly requests = new Map<string, RequestRecord>();

  create(owner: symbol, now = Date.now()): PendingRequest {
    if (typeof owner !== "symbol") throw new TypeError("Caller identity must be broker-owned");
    let pendingCount = 0;
    for (const [requestId, request] of this.requests) {
      if (request.expiresAt + PENDING_REQUEST_TTL_MS <= now) this.requests.delete(requestId);
      else if (request.expiresAt > now) pendingCount++;
    }
    if (pendingCount >= MAX_PENDING_REQUESTS) throw new Error("Too many pending connections");

    const requestId = randomUUID();
    const expiresAt = now + PENDING_REQUEST_TTL_MS;
    this.requests.set(requestId, { owner, expiresAt });
    return { requestId, state: "pending", expiresAt };
  }

  get(owner: symbol, requestId: string, now = Date.now()): PendingRequest | null {
    const request = this.requests.get(requestId);
    if (!request || request.owner !== owner) return null;
    if (request.expiresAt + PENDING_REQUEST_TTL_MS <= now) {
      this.requests.delete(requestId);
      return null;
    }
    return {
      requestId,
      state: now >= request.expiresAt ? "expired" : "pending",
      expiresAt: request.expiresAt
    };
  }

  disconnect(owner: symbol): void {
    for (const [requestId, request] of this.requests) {
      if (request.owner === owner) this.requests.delete(requestId);
    }
  }
}