import { isUtf8 } from "node:buffer";
import { endianness } from "node:os";
import type { Writable } from "node:stream";

export const MAX_NATIVE_FRAME_BYTES = 256 * 1024;
const littleEndian = endianness() === "LE";

export function encodeNativeFrame(message: unknown): Buffer {
  const serialized = JSON.stringify(message);
  const bodyLength = Buffer.byteLength(serialized, "utf8");
  if (bodyLength === 0 || bodyLength > MAX_NATIVE_FRAME_BYTES) {
    throw new Error("Invalid native frame size");
  }

  const frame = Buffer.allocUnsafe(4 + bodyLength);
  if (littleEndian) frame.writeUInt32LE(bodyLength, 0);
  else frame.writeUInt32BE(bodyLength, 0);
  frame.write(serialized, 4, bodyLength, "utf8");
  return frame;
}

export async function writeNativeFrame(output: Writable, message: unknown): Promise<void> {
  if (output.destroyed || output.writableEnded) throw new Error("Native frame output closed");
  if (output.write(encodeNativeFrame(message))) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      output.off("drain", onDrain);
      output.off("error", onError);
      output.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("Native frame output closed")); };
    output.once("drain", onDrain);
    output.once("error", onError);
    output.once("close", onClose);
  });
}

export class NativeFrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | null = null;
  private bodyBytes = 0;

  finish(): void {
    if (this.headerBytes !== 0 || this.body !== null) throw new Error("Incomplete native frame");
  }

  push(chunk: Buffer): unknown[] {
    const messages: unknown[] = [];
    let offset = 0;

    while (offset < chunk.length) {
      if (!this.body) {
        const copied = chunk.copy(this.header, this.headerBytes, offset, offset + 4 - this.headerBytes);
        this.headerBytes += copied;
        offset += copied;
        if (this.headerBytes < 4) break;

        const length = littleEndian ? this.header.readUInt32LE(0) : this.header.readUInt32BE(0);
        if (length === 0 || length > MAX_NATIVE_FRAME_BYTES) {
          throw new Error("Invalid native frame size");
        }
        this.body = Buffer.alloc(length);
        this.bodyBytes = 0;
      }

      const copied = chunk.copy(this.body, this.bodyBytes, offset, offset + this.body.length - this.bodyBytes);
      this.bodyBytes += copied;
      offset += copied;
      if (this.bodyBytes < this.body.length) break;

      if (!isUtf8(this.body)) throw new Error("Invalid native frame encoding");
      messages.push(JSON.parse(this.body.toString("utf8")) as unknown);
      this.headerBytes = 0;
      this.body = null;
      this.bodyBytes = 0;
    }

    return messages;
  }
}