/**
 * The client: connects to a hub, keeps the connection alive, and reconnects with backoff.
 *
 *   connect ─▶ handshake ─▶ session ─▶ (connection lost) ─▶ wait 1, 2, 4 … 30 s ─▶ connect
 *                  │
 *                  └─ wrong passphrase / other protocol version ─▶ stop with an error
 */
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ClipboardWatcher } from './clipboard.ts';
import { DEFAULT_TIMINGS, type Timings } from './config.ts';
import type { KdfParams } from './crypto.ts';
import { FrameReader } from './frame-reader.ts';
import { HANDSHAKE_MAX_BODY_BYTES, HandshakeError, clientHandshake } from './handshake.ts';
import { type Logger, formatCount } from './log.ts';
import { formatAddress } from './address.ts';
import { Session } from './session.ts';

export interface Target {
  host: string;
  port: number;
}

export interface ClientOptions {
  /** Server address; null = call `findServer` before every connection attempt. */
  target: Target | null;
  /** Finds the server (mDNS). It should stop early when the signal aborts. */
  findServer?: ((signal: AbortSignal) => Promise<Target>) | undefined;
  passphrase: string;
  /** null = do not use the local clipboard (only log what arrives). */
  clipboard: ClipboardWatcher | null;
  maxTextBytes: number;
  localName: string;
  version: string;
  log: Logger;
  timings?: Partial<Timings>;
  kdf?: KdfParams;
}

interface ClientEvents {
  connected: [session: Session];
  disconnected: [session: Session, error: Error | null];
}

/** An error that retrying cannot fix, for example a wrong passphrase. */
export class FatalError extends Error {
  override name = 'FatalError';
}

export class Client extends EventEmitter<ClientEvents> {
  readonly #options: ClientOptions;
  readonly #timings: Timings;
  readonly #stop = new AbortController();
  #session: Session | null = null;
  #socket: net.Socket | null = null;

  constructor(options: ClientOptions) {
    super();
    if (!options.target && !options.findServer) throw new TypeError('either target or findServer is required');
    this.#options = options;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
    options.clipboard?.on('change', (text) => this.#onLocalChange(text));
  }

  get session(): Session | null {
    return this.#session;
  }

  /**
   * Connects and reconnects until `close()`. Rejects with `FatalError` when retrying cannot help.
   * Only an explicitly given server can make an error fatal: a server found with mDNS may be an
   * impostor, and handshake ERROR frames are not authenticated.
   */
  async run(): Promise<void> {
    const { signal } = this.#stop;
    const { log } = this.#options;
    const discovered = this.#options.target === null;
    let attempt = 0;
    while (!signal.aborted) {
      let where = 'server';
      try {
        const target = this.#options.target ?? (await this.#options.findServer!(signal));
        signal.throwIfAborted();
        where = formatAddress(target.host, target.port);
        if (await this.#connectOnce(target)) attempt = 0;
      } catch (error) {
        if (signal.aborted) break;
        const fatal = toFatal(error);
        if (fatal && !discovered) throw fatal;
        if (fatal) log.error(`${where}: ${fatal.message}`);
        else logRetry(log, where, error);
      }
      if (signal.aborted) break;
      const wait = backoffDelay(attempt++, this.#timings.reconnectMinMs, this.#timings.reconnectMaxMs);
      log.info(`reconnecting in ${(wait / 1000).toFixed(1)} s`);
      try {
        await sleep(wait, undefined, { signal });
      } catch {
        break;
      }
    }
  }

  async close(): Promise<void> {
    this.#stop.abort();
    this.#options.clipboard?.stop();
    this.#session?.close();
    this.#socket?.destroy();
  }

  /** Returns true when a session was established (the backoff starts again from the minimum). */
  async #connectOnce(target: Target): Promise<boolean> {
    const { log } = this.#options;
    const address = formatAddress(target.host, target.port);
    log.debug(`connecting to ${address}`);
    const socket = await connectTcp(target, this.#timings.connectTimeoutMs, this.#stop.signal);
    this.#socket = socket;
    const reader = new FrameReader(socket, HANDSHAKE_MAX_BODY_BYTES);
    const timer = setTimeout(() => socket.destroy(new Error('handshake timed out')), this.#timings.handshakeTimeoutMs);
    let channel;
    try {
      channel = await clientHandshake(socket, reader, {
        passphrase: this.#options.passphrase,
        ...(this.#options.kdf ? { kdf: this.#options.kdf } : {}),
      });
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const session = new Session(socket, reader, channel, {
      maxTextBytes: this.#options.maxTextBytes,
      heartbeatIntervalMs: this.#timings.heartbeatIntervalMs,
      idleTimeoutMs: this.#timings.idleTimeoutMs,
      localName: this.#options.localName,
      version: this.#options.version,
    });
    this.#session = session;
    session.once('info', () => {
      log.info(`connected to ${session.label}`);
      // Read the clipboard only while connected: without a peer there is nowhere to send it.
      void this.#options.clipboard?.start();
      this.emit('connected', session);
    });
    session.on('clip', (text) => {
      log.info(`← ${formatCount(text.length)} chars from ${session.label}`);
      void this.#options.clipboard?.apply(text);
    });
    const closed = once(session, 'close');
    session.start();
    const [error] = (await closed) as [Error | null];
    this.#session = null;
    this.#options.clipboard?.stop();
    if (!this.#stop.signal.aborted) log.info(`disconnected from ${session.label}${error ? `: ${error.message}` : ''}`);
    this.emit('disconnected', session, error);
    return true;
  }

  #onLocalChange(text: string): void {
    const { log } = this.#options;
    const session = this.#session;
    if (!session || !session.peer) {
      log.info(`not connected: local copy of ${formatCount(text.length)} chars was not sent`);
      return;
    }
    const result = session.sendClip(text);
    if (result === 'sent') log.info(`→ ${formatCount(text.length)} chars sent to ${session.label}`);
    else if (result === 'too-large') log.warn(`not sent: ${formatCount(Buffer.byteLength(text))} bytes is above the size limit`);
    else if (result === 'too-slow') log.warn('not sent: the server has not received the earlier data yet');
    else log.info('not connected: local copy was not sent');
  }
}

/** Exponential backoff with ±20 % jitter, so many clients do not reconnect at the same moment. */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, random: () => number = Math.random): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30));
  return Math.round(base * (0.8 + 0.4 * random()));
}

function toFatal(error: unknown): FatalError | null {
  if (error instanceof FatalError) return error;
  if (error instanceof HandshakeError && error.failure === 'rejected') {
    return new FatalError('wrong passphrase: the server rejected it. Use the same passphrase on all machines.');
  }
  if (error instanceof HandshakeError && error.failure === 'version-mismatch') return new FatalError(error.message);
  return null;
}

function logRetry(log: Logger, where: string, error: unknown): void {
  if (error instanceof HandshakeError && error.failure === 'peer-unverified') {
    log.warn(`${where} could not prove the passphrase: it uses a different passphrase or it is not your server`);
  } else {
    log.warn(`cannot connect to ${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function connectTcp(target: Target, timeoutMs: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // addEventListener('abort') does not fire for a signal that is already aborted.
    if (signal.aborted) {
      reject(new Error('stopped'));
      return;
    }
    const socket = net.connect({ host: target.host, port: target.port });
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => onError(new Error('stopped'));
    const onConnect = () => {
      cleanup();
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15_000);
      resolve(socket);
    };
    const timer = setTimeout(() => onError(new Error(`no answer after ${timeoutMs / 1000} s`)), timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
