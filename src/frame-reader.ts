import type { Duplex } from 'node:stream';
import { FrameDecoder, type Frame } from './frame.ts';

export class ConnectionClosedError extends Error {
  override name = 'ConnectionClosedError';
}

/**
 * Pull-based frame reader over a socket: `await reader.next()` returns one frame at a time.
 * The caller can change `maxBodyBytes` between frames, for example after the handshake.
 * After the connection ends, the reader still returns the frames that arrived before the end,
 * then it throws the reason (`ConnectionClosedError`, a socket error, or a `FrameError`).
 */
export class FrameReader {
  #decoder: FrameDecoder;
  #wake: (() => void) | null = null;
  #end: Error | null = null;

  constructor(socket: Duplex, maxBodyBytes: number) {
    this.#decoder = new FrameDecoder(maxBodyBytes);
    socket.on('data', (chunk: Buffer) => {
      this.#decoder.push(chunk);
      this.#notify();
    });
    socket.on('end', () => this.#finish(new ConnectionClosedError('the peer closed the connection')));
    socket.on('close', () => this.#finish(new ConnectionClosedError('the connection was closed')));
    socket.on('error', (error: Error) => this.#finish(error));
  }

  get maxBodyBytes(): number {
    return this.#decoder.maxBodyBytes;
  }

  set maxBodyBytes(value: number) {
    this.#decoder.maxBodyBytes = value;
  }

  async next(): Promise<Frame> {
    for (;;) {
      const frame = this.#decoder.next();
      if (frame) return frame;
      if (this.#end) throw this.#end;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  #finish(error: Error): void {
    this.#end ??= error;
    this.#notify();
  }
}
