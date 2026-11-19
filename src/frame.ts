/**
 * Length-prefixed framing on top of the TCP byte stream.
 *
 *   frame = length (u32 big-endian, counts type + body) | type (u8) | body
 *
 * TCP does not keep message boundaries: one `data` event can hold half a frame or
 * several frames. The decoder buffers bytes until a whole frame is available and checks
 * the declared length against a limit before it buffers the body.
 */

export const FrameType = {
  /** Handshake: protocol version, role and ephemeral X25519 key (plaintext). */
  Hello: 0x01,
  /** Handshake: proof of the passphrase (HMAC over the transcript). */
  Auth: 0x02,
  /** Handshake failure reported to the peer (plaintext, error code only). */
  Error: 0x03,
  /** Any message after the handshake, encrypted with AES-256-GCM. */
  Sealed: 0x10,
} as const;

export const HEADER_BYTES = 5;
const LENGTH_BYTES = 4;

export interface Frame {
  /** The 5 header bytes (length + type). Sealed frames use them as additional authenticated data. */
  header: Buffer;
  type: number;
  body: Buffer;
}

export class FrameError extends Error {
  override name = 'FrameError';
}

export function frameHeader(type: number, bodyBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(bodyBytes + 1, 0);
  header.writeUInt8(type, LENGTH_BYTES);
  return header;
}

export function encodeFrame(type: number, body: Uint8Array = Buffer.alloc(0)): Buffer {
  return Buffer.concat([frameHeader(type, body.length), body]);
}

export class FrameDecoder {
  /** Largest accepted body. The owner can change it between frames (for example after the handshake). */
  maxBodyBytes: number;
  #chunks: Buffer[] = [];
  #buffered = 0;

  constructor(maxBodyBytes: number) {
    this.maxBodyBytes = maxBodyBytes;
  }

  get bufferedBytes(): number {
    return this.#buffered;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
  }

  /** Returns the next complete frame, or `null` when more bytes are needed. */
  next(): Frame | null {
    if (this.#buffered < LENGTH_BYTES) return null;
    const length = this.#peek(LENGTH_BYTES).readUInt32BE(0);
    if (length === 0) throw new FrameError('received a frame without a type byte');
    const bodyBytes = length - 1;
    if (bodyBytes > this.maxBodyBytes) {
      throw new FrameError(`frame of ${bodyBytes} bytes is larger than the limit of ${this.maxBodyBytes} bytes`);
    }
    if (this.#buffered < LENGTH_BYTES + length) return null;
    const raw = this.#take(LENGTH_BYTES + length);
    return { header: raw.subarray(0, HEADER_BYTES), type: raw.readUInt8(LENGTH_BYTES), body: raw.subarray(HEADER_BYTES) };
  }

  #peek(n: number): Buffer {
    const first = this.#chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.alloc(n);
    let offset = 0;
    for (const chunk of this.#chunks) {
      offset += chunk.copy(out, offset, 0, Math.min(chunk.length, n - offset));
      if (offset === n) break;
    }
    return out;
  }

  #take(n: number): Buffer {
    const first = this.#chunks[0]!;
    if (first.length >= n) {
      if (first.length === n) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(n);
      this.#buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.alloc(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.#chunks[0]!;
      const want = n - offset;
      if (chunk.length <= want) {
        offset += chunk.copy(out, offset);
        this.#chunks.shift();
      } else {
        offset += chunk.copy(out, offset, 0, want);
        this.#chunks[0] = chunk.subarray(want);
      }
    }
    this.#buffered -= n;
    return out;
  }
}
