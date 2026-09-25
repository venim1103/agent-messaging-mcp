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

test("rejects oversized frames before reading their bodies", () => {
  const header = Buffer.alloc(4);
  if (endianness() === "LE") header.writeUInt32LE(MAX_NATIVE_FRAME_BYTES + 1);
  else header.writeUInt32BE(MAX_NATIVE_FRAME_BYTES + 1);

  assert.throws(() => new NativeFrameDecoder().push(header), /Invalid native frame size/);
  assert.throws(() => encodeNativeFrame({ text: "x".repeat(MAX_NATIVE_FRAME_BYTES) }), /Invalid native frame size/);
});