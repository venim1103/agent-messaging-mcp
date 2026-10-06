import assert from "node:assert/strict";
import { endianness } from "node:os";
import { Writable } from "node:stream";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { encodeNativeFrame, MAX_NATIVE_FRAME_BYTES, NativeFrameDecoder, writeNativeFrame } from "./native-framing.js";

test("frame output waits for drain and preserves bytes without retaining listeners", async () => {
  const chunks: Buffer[] = [];
  let releaseWrite: () => void = () => {};
  const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, complete) {
    chunks.push(Buffer.from(chunk));
    releaseWrite = () => complete();
  } });
  try {
    const message = { text: "Unicode \u20ac\uD83D\uDE00" };
    let settled = false;
    const writing = writeNativeFrame(output, message).then(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false);
    releaseWrite();
    await writing;
    assert.deepEqual(new NativeFrameDecoder().push(Buffer.concat(chunks)), [message]);
    for (const event of ["drain", "error", "close", "finish"]) assert.equal(output.listenerCount(event), 0);
  } finally {
    output.destroy();
  }
});

test("frame output rejects close and error while draining and removes listeners", async () => {
  for (const error of [undefined, new Error("Synthetic output failure")]) {
    const output = new Writable({ highWaterMark: 1, write() {} });
    try {
      const writing = writeNativeFrame(output, { text: "Must settle" });
      const rejected = assert.rejects(writing, error ? /Synthetic output failure/ : /Native frame output closed/);
      output.destroy(error);
      await rejected;
      for (const event of ["drain", "error", "close", "finish"]) assert.equal(output.listenerCount(event), 0);
    } finally {
      output.destroy();
    }
  }
});

test("frame output rejects finish without close while draining and removes listeners", async () => {
  let releaseWrite: () => void = () => {};
  const output = new Writable({ highWaterMark: 1, autoDestroy: false,
    write(_chunk, _encoding, complete) { releaseWrite = () => complete(); }
  });
  let settled = "pending";
  let failure: unknown;
  try {
    const writing = writeNativeFrame(output, { text: "Must settle on finish" }).then(() => {
      settled = "written";
    }, (error: unknown) => {
      settled = "rejected";
      failure = error;
    });
    const finished = new Promise<void>((resolve) => output.once("finish", resolve));
    output.end();
    releaseWrite();
    await finished;
    await setImmediate();
    assert.equal(output.destroyed, false);
    assert.equal(settled, "rejected");
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, "Native frame output closed");
    await writing;
    for (const event of ["drain", "error", "close", "finish"]) assert.equal(output.listenerCount(event), 0);
  } finally {
    output.destroy();
  }
});

test("frame output refuses closed streams and excess bytes before writing", async (context) => {
  for (const state of ["open", "ended", "destroyed"]) {
    const output = new Writable({ write(_chunk, _encoding, complete) { complete(); } });
    if (state === "ended") output.end();
    if (state === "destroyed") output.destroy();
    const write = context.mock.method(output, "write", () => {
      assert.fail("Refused output must not reach the stream");
    });
    try {
      const message = { text: "x".repeat(MAX_NATIVE_FRAME_BYTES) };
      await assert.rejects(writeNativeFrame(output, message), state === "open"
        ? /Invalid native frame size/ : /Native frame output closed/);
      assert.equal(write.mock.callCount(), 0);
    } finally {
      write.mock.restore();
      output.destroy();
    }
  }
});

test("decodes partial headers, partial bodies, and adjacent Unicode frames", () => {
  const first = { text: "hello \uD83D\uDE00" };
  const second = { text: "again" };
  const frames = Buffer.concat([encodeNativeFrame(first), encodeNativeFrame(second)]);
  const decoder = new NativeFrameDecoder();

  assert.deepEqual(decoder.push(frames.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frames.subarray(2, 7)), []);
  assert.deepEqual(decoder.push(frames.subarray(7)), [first, second]);
});

test("stopping the frame consumer stops decoding at its queue boundary", (context) => {
  const frames = Buffer.concat(Array.from({ length: 64 }, (_unused, index) => encodeNativeFrame({ index })));
  const originalParse = JSON.parse;
  for (const capacity of [0, 1, 16]) {
    let decoded = 0;
    let consumed = 0;
    const parse = context.mock.method(JSON, "parse", (text: string) => {
      decoded++;
      return originalParse(text) as unknown;
    });
    try {
      assert.throws(() => {
        for (const _message of new NativeFrameDecoder().frames(frames)) {
          if (consumed++ >= capacity) throw new Error("Synthetic queue overflow");
        }
      }, /Synthetic queue overflow/);
      assert.equal(decoded, capacity + 1);
      assert.equal(parse.mock.callCount(), capacity + 1);
    } finally {
      parse.mock.restore();
    }
  }
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

test("encoder accepts the maximum UTF-8 frame and refuses excess bytes before allocation", (context) => {
  const textBytes = MAX_NATIVE_FRAME_BYTES - Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");
  const texts = [
    "x".repeat(textBytes),
    "\uD83D\uDE00".repeat(Math.floor(textBytes / 4)) + "x".repeat(textBytes % 4)
  ];
  for (const text of texts) {
    const message = { text };
    const frame = encodeNativeFrame(message);
    assert.equal(frame.length, 4 + MAX_NATIVE_FRAME_BYTES);
    const decoder = new NativeFrameDecoder();
    assert.deepEqual(decoder.push(frame), [message]);
    assert.doesNotThrow(() => decoder.finish());
  }

  const bodyAllocation = context.mock.method(Buffer, "from", () => {
    assert.fail("An oversized native body must not be allocated");
  });
  const frameAllocation = context.mock.method(Buffer, "allocUnsafe", () => {
    assert.fail("An oversized native frame must not be allocated");
  });
  try {
    for (const text of texts) {
      assert.throws(() => encodeNativeFrame({ text: `${text}x` }), /Invalid native frame size/);
    }
    assert.equal(bodyAllocation.mock.callCount(), 0);
    assert.equal(frameAllocation.mock.callCount(), 0);
  } finally {
    bodyAllocation.mock.restore();
    frameAllocation.mock.restore();
  }
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