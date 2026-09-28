import { randomUUID } from "node:crypto";
import * as z from "zod/v4";

export const MAX_OBSERVATION_EVENTS = 1000;
export const MAX_OBSERVATION_BYTES = 5 * 1024 * 1024;
export const MAX_EVENT_BYTES = 256 * 1024;
export const MAX_RETURNED_EVENTS = 100;

type Cursor = Readonly<{ epoch: string; sequence: number }>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;
type ObservationEvent = Readonly<{ epoch: string; sequence: number; payload: JsonValue }>;

function freeze(value: JsonValue): JsonValue {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export class ObservationBuffer {
  readonly epoch = randomUUID();
  private readonly events: ObservationEvent[] = [];
  private sequence = 0;
  private bytes = 0;
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(limits: { maxEvents?: number; maxBytes?: number } = {}) {
    this.maxEvents = limits.maxEvents ?? MAX_OBSERVATION_EVENTS;
    this.maxBytes = limits.maxBytes ?? MAX_OBSERVATION_BYTES;
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1 || this.maxEvents > MAX_OBSERVATION_EVENTS
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_OBSERVATION_BYTES) {
      throw new Error("Invalid observation buffer limits");
    }
  }

  bookmark(): Cursor {
    return Object.freeze({ epoch: this.epoch, sequence: this.sequence });
  }

  append(payload: unknown): ObservationEvent {
    const parsed = z.json().parse(payload);
    const serialized = JSON.stringify({ epoch: this.epoch, sequence: this.sequence + 1, payload: parsed });
    const size = Buffer.byteLength(serialized, "utf8");
    if (size > MAX_EVENT_BYTES || size > this.maxBytes) throw new Error("Observation event exceeds size limit");

    const event = JSON.parse(serialized) as ObservationEvent;
    freeze(event.payload);
    Object.freeze(event);
    this.events.push(event);
    this.sequence++;
    this.bytes += size;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const evicted = this.events.shift();
      if (evicted) this.bytes -= Buffer.byteLength(JSON.stringify(evicted), "utf8");
    }
    return event;
  }

  read(cursor: Cursor, limit = MAX_RETURNED_EVENTS) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RETURNED_EVENTS) {
      throw new Error("Invalid observation read limit");
    }
    const first = this.events[0]?.sequence ?? this.sequence + 1;
    if (cursor.epoch !== this.epoch || !Number.isSafeInteger(cursor.sequence)
      || cursor.sequence < first - 1 || cursor.sequence > this.sequence) {
      return { state: "expired" as const, resnapshot: true as const };
    }
    const events = this.events.filter((event) => event.sequence > cursor.sequence).slice(0, limit);
    return {
      state: "ok" as const,
      cursor: Object.freeze({ epoch: this.epoch, sequence: events.at(-1)?.sequence ?? cursor.sequence }),
      events
    };
  }
}