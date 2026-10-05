import assert from "node:assert/strict";
import { endianness } from "node:os";
import { test } from "node:test";
import { encodeNativeFrame, MAX_NATIVE_FRAME_BYTES, NativeFrameDecoder } from "./native-framing.js";

test("decodes partial headers, partial bodies, and adjacent Unicode frames", () => {
  const first = { text: "hello \uD83D\uDE00" };
  const second = { text: "again" };
  const frames = Buffer.concat([encodeNativeFrame(first), encodeNativeFrame(second)]);
  const decoder = new NativeFrameDecoder();

  assert.deepEqual(decoder.push(frames.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frames.subarray(2, 7)), []);
  assert.deepEqual(decoder.push(frames.subarray(7)), [first, second]);
});

test("end-of-stream refuses incomplete headers and bodies at every byte boundary", () => {
  const message = { text: "Private \u20ac\uD83D\uDE00" };
  const frame = encodeNativeFrame(message);
  for (let length = 1; length < frame.length; length++) {
    const decoder = new NativeFrameDecoder();
    assert.deepEqual(decoder.push(frame.subarray(0, length)), []);
    assert.throws(() => decoder.finish(), /Incomplete native frame/);
  }
  const adjacent = new NativeFrameDecoder();
  assert.deepEqual(adjacent.push(Buffer.concat([frame, frame.subarray(0, frame.length - 1)])), [message]);
  assert.throws(() => adjacent.finish(), /Incomplete native frame/);
});

test("end-of-stream accepts empty input and complete fragmented adjacent frames", () => {
  assert.doesNotThrow(() => new NativeFrameDecoder().finish());
  const first = { text: "First" };
  const second = { text: "Second" };
  const frames = Buffer.concat([encodeNativeFrame(first), encodeNativeFrame(second)]);
  const decoder = new NativeFrameDecoder();
  const messages: unknown[] = [];
  for (const byte of frames) messages.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(messages, [first, second]);
  assert.doesNotThrow(() => decoder.finish());
});

test("rejects oversized frames before reading their bodies", () => {
  const header = Buffer.alloc(4);
  if (endianness() === "LE") header.writeUInt32LE(MAX_NATIVE_FRAME_BYTES + 1);
  else header.writeUInt32BE(MAX_NATIVE_FRAME_BYTES + 1);

  assert.throws(() => new NativeFrameDecoder().push(header), /Invalid native frame size/);
  assert.throws(() => encodeNativeFrame({ text: "x".repeat(MAX_NATIVE_FRAME_BYTES) }), /Invalid native frame size/);
});

test("rejects malformed UTF-8 instead of silently replacing message bytes", () => {
  for (const malformed of [
    [0x80], [0xc0, 0xaf], [0xe2, 0x82], [0xe2, 0x28, 0xa1],
    [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]
  ]) {
    const body = Buffer.concat([Buffer.from('{"text":"'), Buffer.from(malformed), Buffer.from('"}')]);
    const frame = Buffer.concat([Buffer.alloc(4), body]);
    if (endianness() === "LE") frame.writeUInt32LE(body.length);
    else frame.writeUInt32BE(body.length);
    assert.throws(() => new NativeFrameDecoder().push(frame), /Invalid native frame encoding/);
    const fragmented = new NativeFrameDecoder();
    assert.deepEqual(fragmented.push(frame.subarray(0, frame.length - 1)), []);
    assert.throws(() => fragmented.push(frame.subarray(frame.length - 1)), /Invalid native frame encoding/);
  }
});

test("accepts valid Unicode and explicit replacement characters across every byte boundary", () => {
  const message = { text: "A\u20ac\uD83D\uDE00\ufffd" };
  const frame = encodeNativeFrame(message);
  for (let boundary = 1; boundary < frame.length; boundary++) {
    const decoder = new NativeFrameDecoder();
    assert.deepEqual(decoder.push(frame.subarray(0, boundary)), []);
    assert.deepEqual(decoder.push(frame.subarray(boundary)), [message]);
  }
});