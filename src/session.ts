/**
 * An authenticated, encrypted connection to one peer.
 *
 * Plaintext of every Sealed frame: kind (u8) | payload
 *   CLIP  1  UTF-8 text, exactly as it was in the clipboard
 *   PING  2  empty; the peer answers with PONG
 *   PONG  3  empty
 *   INFO  4  JSON {"name": string, "version": string, "maxTextBytes": number}
 * Unknown kinds are ignored, so later versions can add messages.
 */
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { MAX_TEXT_BYTES_CEILING, MIN_TEXT_BYTES } from './config.ts';
import { type SecureChannel, TAG_BYTES } from './crypto.ts';
import { FrameType } from './frame.ts';
import { ConnectionClosedError, type FrameReader } from './frame-reader.ts';
import { sanitizeForTerminal } from './log.ts';

export const MessageKind = { Clip: 1, Ping: 2, Pong: 3, Info: 4 } as const;

export interface PeerInfo {
  name: string;
  version: string;
  maxTextBytes: number;
}

export interface SessionOptions {
  /** Largest text we accept and send. */
  maxTextBytes: number;
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
  localName: string;
  version: string;
}

interface SessionEvents {
  clip: [text: string];
  info: [info: PeerInfo];
  /** `error` is null for a normal close. */
  close: [error: Error | null];
}

export type SendResult = 'sent' | 'too-large' | 'closed';

export class ProtocolError extends Error {
  override name = 'ProtocolError';
}

export class PeerTimeoutError extends Error {
  override name = 'PeerTimeoutError';
}

/** INFO and other control messages must fit even when the text limit is small. */
const MIN_BODY_BYTES = 4096;

export class Session extends EventEmitter<SessionEvents> {
  readonly remoteAddress: string;
  peer: PeerInfo | null = null;
  readonly #socket: Socket;
  readonly #reader: FrameReader;
  readonly #channel: SecureChannel;
  readonly #options: SessionOptions;
  #closed = false;
  #lastSentAt = 0;
  #heartbeat: NodeJS.Timeout | undefined;
  #idle: NodeJS.Timeout | undefined;

  constructor(socket: Socket, reader: FrameReader, channel: SecureChannel, options: SessionOptions) {
    super();
    this.#socket = socket;
    this.#reader = reader;
    this.#channel = channel;
    this.#options = options;
    this.remoteAddress = formatAddress(socket.remoteAddress, socket.remotePort);
  }

  /** "name (address)" once the peer has introduced itself, otherwise the address. */
  get label(): string {
    return this.peer ? `${this.peer.name} (${this.remoteAddress})` : this.remoteAddress;
  }

  get closed(): boolean {
    return this.#closed;
  }

  start(): void {
    this.#reader.maxBodyBytes = Math.max(this.#options.maxTextBytes, MIN_BODY_BYTES) + 1 + TAG_BYTES;
    const info = { name: this.#options.localName, version: this.#options.version, maxTextBytes: this.#options.maxTextBytes };
    this.#send(MessageKind.Info, Buffer.from(JSON.stringify(info)));
    this.#idle = setTimeout(() => {
      this.#finish(new PeerTimeoutError(`no data from the peer for ${Math.round(this.#options.idleTimeoutMs / 1000)} s`));
    }, this.#options.idleTimeoutMs);
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastSentAt >= this.#options.heartbeatIntervalMs) this.#send(MessageKind.Ping);
    }, this.#options.heartbeatIntervalMs);
    void this.#readLoop();
  }

  /** Sends clipboard text. Text larger than our or the peer's limit is not sent. */
  sendClip(text: string): SendResult {
    if (this.#closed) return 'closed';
    const bytes = Buffer.from(text, 'utf8');
    const limit = Math.min(this.#options.maxTextBytes, this.peer?.maxTextBytes ?? Number.POSITIVE_INFINITY);
    if (bytes.length > limit) return 'too-large';
    this.#send(MessageKind.Clip, bytes);
    return 'sent';
  }

  /** Closes the connection. Queued data is still delivered on a normal close. */
  close(error: Error | null = null): void {
    this.#finish(error);
  }

  #send(kind: number, payload: Buffer = Buffer.alloc(0)): void {
    if (this.#closed || this.#socket.destroyed) return;
    this.#socket.write(this.#channel.seal(Buffer.concat([Buffer.of(kind), payload])));
    this.#lastSentAt = Date.now();
  }

  async #readLoop(): Promise<void> {
    try {
      for (;;) {
        const frame = await this.#reader.next();
        this.#idle?.refresh();
        if (frame.type !== FrameType.Sealed) throw new ProtocolError(`unexpected frame type 0x${frame.type.toString(16)}`);
        const plaintext = this.#channel.open(frame);
        if (plaintext.length === 0) throw new ProtocolError('empty message');
        this.#handle(plaintext.readUInt8(0), plaintext.subarray(1));
      }
    } catch (error) {
      this.#finish(error instanceof ConnectionClosedError ? null : asError(error));
    }
  }

  #handle(kind: number, payload: Buffer): void {
    switch (kind) {
      case MessageKind.Clip:
        if (payload.length > this.#options.maxTextBytes) throw new ProtocolError('the peer sent text above the agreed limit');
        if (payload.length > 0) this.emit('clip', payload.toString('utf8'));
        break;
      case MessageKind.Ping:
        this.#send(MessageKind.Pong);
        break;
      case MessageKind.Pong:
        break;
      case MessageKind.Info:
        this.peer = parsePeerInfo(payload);
        this.emit('info', this.peer);
        break;
      default:
        break;
    }
  }

  #finish(error: Error | null): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    clearTimeout(this.#idle);
    if (error) {
      this.#socket.destroy();
    } else {
      // Flush queued frames, but do not wait forever for a peer that does not answer.
      this.#socket.end();
      setTimeout(() => this.#socket.destroy(), 2000).unref();
    }
    this.emit('close', error);
  }
}

export function parsePeerInfo(payload: Buffer): PeerInfo {
  let data: unknown;
  try {
    data = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new ProtocolError('malformed INFO message');
  }
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const name = typeof record.name === 'string' ? sanitizeForTerminal(record.name) : '';
  const version = typeof record.version === 'string' ? sanitizeForTerminal(record.version, 32) : '?';
  const limit = typeof record.maxTextBytes === 'number' && Number.isFinite(record.maxTextBytes) ? Math.floor(record.maxTextBytes) : MIN_TEXT_BYTES;
  return {
    name: name || 'unnamed',
    version: version || '?',
    maxTextBytes: Math.min(Math.max(limit, MIN_TEXT_BYTES), MAX_TEXT_BYTES_CEILING),
  };
}

/** "192.168.1.5:8134", "[fe80::1]:8134"; IPv4-mapped IPv6 addresses are shown as IPv4. */
export function formatAddress(address: string | undefined, port: number | undefined): string {
  if (!address) return 'unknown';
  const host = address.startsWith('::ffff:') ? address.slice(7) : address;
  const shown = host.includes(':') ? `[${host}]` : host;
  return port === undefined ? shown : `${shown}:${port}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
