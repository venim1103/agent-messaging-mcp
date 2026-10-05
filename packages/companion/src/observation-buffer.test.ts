import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_EVENT_BYTES, MAX_OBSERVATION_DEPTH, ObservationBuffer } from "./observation-buffer.js";

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

test("nested payloads remain detached and frozen while returned pages stay reader-local", () => {
  const buffer = new ObservationBuffer();
  const start = buffer.bookmark();
  const payload = { messages: [{ text: "Original", metadata: { labels: ["fixture"] } }] };
  const event = buffer.append(payload);
  payload.messages[0]!.text = "Changed";
  payload.messages[0]!.metadata.labels.push("caller mutation");
  assert.deepEqual(event.payload, { messages: [{ text: "Original", metadata: { labels: ["fixture"] } }] });
  assert.equal(Object.isFrozen(payload.messages), false);
  const published = event.payload as { messages: { text: string; metadata: { labels: string[] } }[] };
  assert.equal(Object.isFrozen(published.messages), true);
  assert.equal(Object.isFrozen(published.messages[0]), true);
  assert.equal(Object.isFrozen(published.messages[0]!.metadata), true);
  assert.equal(Object.isFrozen(published.messages[0]!.metadata.labels), true);
  assert.throws(() => { published.messages[0]!.text = "Reader mutation"; }, TypeError);
  assert.throws(() => published.messages[0]!.metadata.labels.push("reader mutation"), TypeError);
  const firstPage = buffer.read(start);
  if (firstPage.state !== "ok") throw new Error("Expected a retained observation page");
  firstPage.events.splice(0);
  assert.deepEqual(buffer.read(start).events, [event]);
  assert.throws(() => { (firstPage.cursor as { sequence: number }).sequence = 999; }, TypeError);
  assert.equal(buffer.bookmark().sequence, event.sequence);
});

test("rejected payloads neither advance cursors nor evict a retained event", () => {
  const buffer = new ObservationBuffer({ maxEvents: 1 });
  const start = buffer.bookmark();
  const retained = buffer.append({ text: "Must remain" });
  const beforeRejection = buffer.bookmark();
  for (const invalid of [undefined, NaN, Infinity, -Infinity, 1n, Symbol("not JSON"),
    () => "not JSON", { text: undefined }, { nested: { callback: () => "not JSON" } },
    { text: "x".repeat(MAX_EVENT_BYTES) }]) {
    assert.throws(() => buffer.append(invalid));
    assert.deepEqual(buffer.bookmark(), beforeRejection);
    assert.deepEqual(buffer.read(start).events, [retained]);
  }
  const replacement = buffer.append({ text: "Valid next event" });
  assert.equal(replacement.sequence, retained.sequence + 1);
  assert.deepEqual(buffer.read(start), { state: "expired", resnapshot: true });
  assert.deepEqual(buffer.read(beforeRejection).events, [replacement]);
});

test("deep and cyclic payloads are refused before recursive validation without losing retained events", () => {
  const buffer = new ObservationBuffer({ maxEvents: 1 });
  const start = buffer.bookmark();
  const retained = buffer.append({ text: "Must remain" });
  const beforeRejection = buffer.bookmark();
  let deep: unknown = "leaf";
  for (let depth = 0; depth < 10000; depth++) deep = [deep];
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  const cyclicObject: { self?: unknown } = {};
  cyclicObject.self = cyclicObject;
  for (const invalid of [deep, cyclicArray, cyclicObject]) {
    assert.throws(() => buffer.append(invalid), {
      name: "Error", message: "Observation payload exceeds nesting limit"
    });
    assert.deepEqual(buffer.bookmark(), beforeRejection);
    assert.deepEqual(buffer.read(start).events, [retained]);
  }
  const replacement = buffer.append({ text: "Valid next event" });
  assert.equal(replacement.sequence, retained.sequence + 1);
  assert.deepEqual(buffer.read(beforeRejection).events, [replacement]);
});

test("array and object nesting accepts the exact limit and refuses the next level", () => {
  for (const shape of ["array", "object"]) {
    const buffer = new ObservationBuffer();
    let payload: unknown = "leaf";
    for (let depth = 0; depth < MAX_OBSERVATION_DEPTH; depth++) {
      payload = shape === "array" ? [payload] : { nested: payload };
    }
    const retained = buffer.append(payload);
    assert.deepEqual(retained.payload, payload);
    const beforeRejection = buffer.bookmark();
    const tooDeep = shape === "array" ? [payload] : { nested: payload };
    assert.throws(() => buffer.append(tooDeep), /Observation payload exceeds nesting limit/);
    assert.deepEqual(buffer.bookmark(), beforeRejection);
    const next = buffer.append({ text: "Valid next event" });
    assert.equal(next.sequence, retained.sequence + 1);
  }
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