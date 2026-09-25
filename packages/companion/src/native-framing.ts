import { endianness } from "node:os";

export const MAX_NATIVE_FRAME_BYTES = 256 * 1024;
const littleEndian = endianness() === "LE";

export function encodeNativeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length === 0 || body.length > MAX_NATIVE_FRAME_BYTES) {
    throw new Error("Invalid native frame size");
  }

  const frame = Buffer.allocUnsafe(4 + body.length);
  if (littleEndian) frame.writeUInt32LE(body.length, 0);
  else frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class NativeFrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | null = null;
  private bodyBytes = 0;

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

      messages.push(JSON.parse(this.body.toString("utf8")) as unknown);
      this.headerBytes = 0;
      this.body = null;
      this.bodyBytes = 0;
    }

    return messages;
  }
}