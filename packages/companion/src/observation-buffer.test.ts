import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_EVENT_BYTES, ObservationBuffer } from "./observation-buffer.js";

test("two readers retain independent cursors and published events cannot be changed", () => {
  const buffer = new ObservationBuffer();
  const firstReader = buffer.bookmark();
  const secondReader = buffer.bookmark();
  const message = { messageId: "fixture-1", text: "first", revision: 1 };
  const first = buffer.append(message);
  message.text = "changed after publish";

  assert.equal((first.payload as { text: string }).text, "first");
  assert.equal(Object.isFrozen(first.payload), true);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(buffer.read(firstReader, 1).events, [first]);
  assert.deepEqual(buffer.read(secondReader, 1).events, [first]);

  const firstPage = buffer.read(firstReader, 1);
  if (firstPage.state !== "ok") throw new Error("Expected the initial observation page");
  const nextCursor = firstPage.cursor;
  const revision = buffer.append({ messageId: "fixture-1", text: "second", revision: 2 });
  const nextPage = buffer.read(nextCursor);
  if (nextPage.state !== "ok") throw new Error("Expected the next observation page");
  assert.deepEqual(nextPage.events, [revision]);
  assert.deepEqual(buffer.read(secondReader).events, [first, revision]);
  assert.equal(nextPage.cursor.sequence, revision.sequence);

  const repeated = buffer.append({ messageId: "fixture-2", text: "second", revision: 1 });
  assert.notEqual(repeated.sequence, revision.sequence);
  assert.deepEqual(buffer.read(nextPage.cursor).events, [repeated]);
});

test("eviction or epoch changes expire cursors with a resnapshot path", () => {
  const buffer = new ObservationBuffer({ maxEvents: 2 });
  const before = buffer.bookmark();
  const first = buffer.append({ text: "first" });
  const afterFirst = buffer.bookmark();
  const second = buffer.append({ text: "second" });
  const third = buffer.append({ text: "third" });

  assert.deepEqual(buffer.read(before), { state: "expired", resnapshot: true });
  assert.deepEqual(buffer.read(afterFirst).events, [second, third]);
  assert.deepEqual(buffer.read({ epoch: "unknown", sequence: first.sequence }), { state: "expired", resnapshot: true });
  assert.deepEqual(buffer.read({ epoch: buffer.epoch, sequence: 99 }), { state: "expired", resnapshot: true });
  assert.throws(() => buffer.read(afterFirst, 101), /Invalid observation read limit/);
});

test("size limits count UTF-8 bytes and reject oversized events before publishing", () => {
  const buffer = new ObservationBuffer({ maxBytes: 200 });
  const start = buffer.bookmark();
  assert.throws(() => buffer.append({ text: "\u00e9".repeat(80) }), /exceeds size limit/);
  assert.deepEqual(buffer.read(start).events, []);
  assert.throws(() => new ObservationBuffer().append({ text: "x".repeat(MAX_EVENT_BYTES) }), /exceeds size limit/);
});

test("byte-pressure eviction expires only cursors older than the retained boundary", () => {
  const payload = { text: "\u00e9".repeat(10) };
  const eventBytes = Buffer.byteLength(JSON.stringify({ epoch: "a".repeat(36), sequence: 1, payload }), "utf8");
  const buffer = new ObservationBuffer({ maxBytes: eventBytes * 2 });
  const before = buffer.bookmark();
  buffer.append(payload);
  const afterFirst = buffer.bookmark();
  const second = buffer.append(payload);
  const third = buffer.append(payload);

  assert.deepEqual(buffer.read(before), { state: "expired", resnapshot: true });
  assert.deepEqual(buffer.read(afterFirst).events, [second, third]);
});