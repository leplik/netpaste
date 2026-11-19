import type { Duplex } from 'node:stream';
import { type Frame, FrameDecoder, HEADER_BYTES } from './frame.ts';

export class ConnectionClosedError extends Error {
  override name = 'ConnectionClosedError';
}

/** Bytes that may wait in the decoder beyond one maximum-size frame before reading pauses. */
const SLACK_BYTES = 64 * 1024;

/**
 * Pull-based frame reader over a socket: `await reader.next()` returns one frame at a time.
 * The caller can change `maxBodyBytes` between frames, for example after the handshake.
 *
 * Memory is bounded: when more than one maximum-size frame (+ 64 KiB) waits unread, the reader
 * pauses the socket, and TCP flow control stops the sender. Without this, a peer could stream
 * gigabytes while the hub is busy with scrypt and nobody calls `next()`.
 *
 * After the connection ends, the reader still returns the frames that arrived before the end,
 * then it throws the reason (`ConnectionClosedError`, a socket error, or a `FrameError`).
 */
export class FrameReader {
  readonly #socket: Duplex;
  readonly #decoder: FrameDecoder;
  #wake: (() => void) | null = null;
  #end: Error | null = null;

  constructor(socket: Duplex, maxBodyBytes: number) {
    this.#socket = socket;
    this.#decoder = new FrameDecoder(maxBodyBytes);
    socket.on('data', (chunk: Buffer) => {
      this.#decoder.push(chunk);
      if (this.#decoder.bufferedBytes > this.#highWaterMark()) socket.pause();
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

  /** Bytes received but not yet returned as frames. */
  get bufferedBytes(): number {
    return this.#decoder.bufferedBytes;
  }

  async next(): Promise<Frame> {
    for (;;) {
      const frame = this.#decoder.next();
      if (frame) {
        this.#resumeIfRoom();
        return frame;
      }
      if (this.#end) throw this.#end;
      this.#resumeIfRoom();
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  #highWaterMark(): number {
    return this.#decoder.maxBodyBytes + HEADER_BYTES + SLACK_BYTES;
  }

  #resumeIfRoom(): void {
    if (this.#socket.isPaused() && this.#decoder.bufferedBytes <= this.#highWaterMark()) this.#socket.resume();
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
