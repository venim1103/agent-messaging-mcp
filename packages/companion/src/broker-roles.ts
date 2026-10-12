import { randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";
import { PROTOCOL_VERSION } from "./native-protocol.js";

export const MAX_BROKER_PENDING_REQUESTS = 16;

export type BrokerRole = "facade" | "relay";
export type BrokerCredentials = Readonly<Record<BrokerRole, string>>;
export type AuthenticatedHello = Readonly<{ role: BrokerRole; requestId: string; deadlineMs: number; agentLabel?: string }>;

const helloSchema = z.strictObject({
  kind: z.literal("hello"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  role: z.enum(["facade", "relay"]),
  credential: z.string().regex(/^[0-9a-f]{64}$/),
  payload: z.strictObject({ agentLabel: z.string().regex(/^[ -~]{1,80}$/).refine(label => label.trim() === label).optional() })
});

export function createBrokerCredentials(): BrokerCredentials {
  return { facade: randomBytes(32).toString("hex"), relay: randomBytes(32).toString("hex") };
}

export function authenticateBrokerRole(message: unknown, credentials: BrokerCredentials, now = Date.now()): AuthenticatedHello | null {
  const parsed = helloSchema.safeParse(message);
  if (!parsed.success || parsed.data.deadlineMs <= now || parsed.data.deadlineMs > now + 30_000
    || (parsed.data.role === "relay" && parsed.data.payload.agentLabel !== undefined)) return null;

  const expected = Buffer.from(credentials[parsed.data.role], "hex");
  const received = Buffer.from(parsed.data.credential, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received)
    ? { role: parsed.data.role, requestId: parsed.data.requestId, deadlineMs: parsed.data.deadlineMs,
      ...(parsed.data.payload.agentLabel !== undefined ? { agentLabel: parsed.data.payload.agentLabel } : {}) } : null;
}