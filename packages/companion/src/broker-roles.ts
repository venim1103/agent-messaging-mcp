import { randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";
import { PROTOCOL_VERSION } from "./native-protocol.js";

export type BrokerRole = "facade" | "relay";
export type BrokerCredentials = Readonly<Record<BrokerRole, string>>;
export type AuthenticatedHello = Readonly<{ role: BrokerRole; requestId: string }>;

const helloSchema = z.strictObject({
  kind: z.literal("hello"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  connectionGeneration: z.literal(0),
  deadlineMs: z.number().int().safe(),
  role: z.enum(["facade", "relay"]),
  credential: z.string().regex(/^[0-9a-f]{64}$/),
  payload: z.strictObject({})
});

export function createBrokerCredentials(): BrokerCredentials {
  return { facade: randomBytes(32).toString("hex"), relay: randomBytes(32).toString("hex") };
}

export function authenticateBrokerRole(message: unknown, credentials: BrokerCredentials, now = Date.now()): AuthenticatedHello | null {
  const parsed = helloSchema.safeParse(message);
  if (!parsed.success || parsed.data.deadlineMs <= now || parsed.data.deadlineMs > now + 30_000) return null;

  const expected = Buffer.from(credentials[parsed.data.role], "hex");
  const received = Buffer.from(parsed.data.credential, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received)
    ? { role: parsed.data.role, requestId: parsed.data.requestId } : null;
}