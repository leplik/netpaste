/**
 * The hub: accepts clients, checks the passphrase, and relays clipboard text.
 *
 *   client A ──▶ hub ──▶ client B, client C …   (never back to A)
 *                 └────▶ local clipboard (unless --no-clipboard)
 *   local clipboard change ──▶ all clients
 *
 * Connections that have not proved the passphrase are limited per address and in total,
 * and an address that sent a wrong passphrase is blocked for a while.
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { addressKey, formatAddress } from './address.ts';
import type { ClipboardWatcher } from './clipboard.ts';
import {
  DEFAULT_TIMINGS,
  MAX_CONCURRENT_KDF,
  MAX_CONNECTIONS,
  MAX_PENDING,
  MAX_PENDING_PER_ADDRESS,
  MAX_SESSIONS,
  type Timings,
} from './config.ts';
import type { KdfParams } from './crypto.ts';
import { FrameReader } from './frame-reader.ts';
import { HANDSHAKE_MAX_BODY_BYTES, HandshakeError, serverHandshake } from './handshake.ts';
import { Limiter } from './limiter.ts';
import { type Logger, formatCount } from './log.ts';
import { Session } from './session.ts';

export interface HubOptions {
  port: number;
  /** Listen address; all interfaces when undefined. */
  host?: string | undefined;
  passphrase: string;
  /** null = relay only, the local clipboard is not used. */
  clipboard: ClipboardWatcher | null;
  maxTextBytes: number;
  localName: string;
  version: string;
  log: Logger;
  timings?: Partial<Timings>;
  kdf?: KdfParams;
}

interface HubEvents {
  'peer-connected': [session: Session];
  'peer-disconnected': [session: Session];
  'auth-failed': [remoteAddress: string];
}

export class Hub extends EventEmitter<HubEvents> {
  readonly #options: HubOptions;
  readonly #timings: Timings;
  readonly #server: net.Server;
  readonly #sessions = new Set<Session>();
  /** Connections in the handshake, with their address key. */
  readonly #pending = new Map<net.Socket, string>();
  readonly #kdfLimiter = new Limiter(MAX_CONCURRENT_KDF);
  /** Wrong-passphrase history per address key, to slow down online guessing. */
  readonly #authFailures = new Map<string, { count: number; blockedUntil: number }>();
  #closing = false;

  constructor(options: HubOptions) {
    super();
    this.#options = options;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#server = net.createServer((socket) => void this.#accept(socket));
    this.#server.maxConnections = MAX_CONNECTIONS;
    this.#server.on('drop', (data) => options.log.debug(`dropped a connection from ${formatAddress(data?.remoteAddress, data?.remotePort)}: too many connections`));
    options.clipboard?.on('change', (text) => this.#onLocalChange(text));
  }

  get peers(): Session[] {
    return [...this.#sessions];
  }

  /** Starts listening. Rejects when the port is busy or the address is invalid. */
  async listen(): Promise<net.AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(this.#options.port, this.#options.host);
    });
    this.#server.on('error', (error) => this.#options.log.error(`server: ${error.message}`));
    return this.#server.address() as net.AddressInfo;
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#options.clipboard?.stop();
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
    for (const socket of this.#pending.keys()) socket.destroy();
    for (const session of this.#sessions) session.close();
    await closed;
  }

  async #accept(socket: net.Socket): Promise<void> {
    const { log } = this.#options;
    const remote = formatAddress(socket.remoteAddress, socket.remotePort);
    const key = addressKey(socket.remoteAddress);
    const refuse = (reason: string) => {
      log.debug(`refused ${remote}: ${reason}`);
      socket.destroy();
    };
    if (this.#closing) return refuse('the hub is stopping');
    const blockedFor = this.#blockedFor(key);
    if (blockedFor > 0) return refuse(`wrong passphrase recently, blocked for ${Math.ceil(blockedFor / 1000)} s`);
    if (this.#sessions.size >= MAX_SESSIONS) return refuse(`the hub already has ${MAX_SESSIONS} peers`);
    if (this.#pending.size >= MAX_PENDING) return refuse('too many connections without a passphrase');
    if (this.#pendingFrom(key) >= MAX_PENDING_PER_ADDRESS) return refuse('too many connections without a passphrase from this address');

    socket.setNoDelay(true);
    socket.setKeepAlive(true, this.#timings.heartbeatIntervalMs);
    this.#pending.set(socket, key);
    log.debug(`connection from ${remote}`);

    const reader = new FrameReader(socket, HANDSHAKE_MAX_BODY_BYTES);
    const timer = setTimeout(() => socket.destroy(new Error('handshake timed out')), this.#timings.handshakeTimeoutMs);
    let blockMs = 0;
    let channel;
    try {
      channel = await serverHandshake(socket, reader, {
        passphrase: this.#options.passphrase,
        kdfLimiter: this.#kdfLimiter,
        authFailureDelayMs: this.#timings.authFailureDelayMs,
        admit: () => !this.#closing && this.#blockedFor(key) === 0,
        onWrongPassphrase: () => {
          blockMs = this.#recordAuthFailure(key);
          // Other connections from the same address must not keep guessing in parallel.
          for (const [other, otherKey] of this.#pending) if (otherKey === key && other !== socket) other.destroy();
        },
        ...(this.#options.kdf ? { kdf: this.#options.kdf } : {}),
      });
    } catch (error) {
      socket.destroy();
      if (error instanceof HandshakeError && error.failure === 'peer-unverified') {
        log.warn(`rejected ${remote}: wrong passphrase; the address is blocked for ${Math.round(blockMs / 1000)} s`);
        this.emit('auth-failed', remote);
      } else if (error instanceof HandshakeError) {
        log.warn(`rejected ${remote}: ${error.message}`);
      } else {
        log.debug(`handshake with ${remote} failed: ${(error as Error).message}`);
      }
      return;
    } finally {
      clearTimeout(timer);
      this.#pending.delete(socket);
    }
    this.#authFailures.delete(key);

    const session = new Session(socket, reader, channel, {
      maxTextBytes: this.#options.maxTextBytes,
      heartbeatIntervalMs: this.#timings.heartbeatIntervalMs,
      idleTimeoutMs: this.#timings.idleTimeoutMs,
      localName: this.#options.localName,
      version: this.#options.version,
    });
    this.#sessions.add(session);
    session.once('info', () => {
      log.info(`connected: ${session.label}; peers online: ${this.#sessions.size}`);
      this.#updateClipboardWatcher();
      this.emit('peer-connected', session);
    });
    session.on('clip', (text) => this.#onRemoteClip(session, text));
    session.on('close', (error) => {
      this.#sessions.delete(session);
      const reason = error ? `: ${error.message}` : '';
      if (!this.#closing) log.info(`disconnected: ${session.label}${reason}`);
      this.#updateClipboardWatcher();
      this.emit('peer-disconnected', session);
    });
    session.start();
  }

  #pendingFrom(key: string): number {
    let count = 0;
    for (const pendingKey of this.#pending.values()) if (pendingKey === key) count++;
    return count;
  }

  /** Milliseconds the address is still blocked, or 0. */
  #blockedFor(key: string): number {
    const entry = this.#authFailures.get(key);
    return entry ? Math.max(0, entry.blockedUntil - Date.now()) : 0;
  }

  /** Records a wrong passphrase and returns how long the address is now blocked. */
  #recordAuthFailure(key: string): number {
    const now = Date.now();
    if (this.#authFailures.size > 1000) {
      for (const [other, entry] of this.#authFailures) if (entry.blockedUntil < now) this.#authFailures.delete(other);
    }
    const count = (this.#authFailures.get(key)?.count ?? 0) + 1;
    const blockMs = Math.min(this.#timings.authBlockMaxMs, this.#timings.authBlockBaseMs * 2 ** Math.min(count - 1, 20));
    // The block starts now, but the ERROR goes out only after the failure delay: count the block from then.
    this.#authFailures.set(key, { count, blockedUntil: now + this.#timings.authFailureDelayMs + blockMs });
    return blockMs;
  }

  /** Reads the clipboard only while at least one peer is ready to receive. */
  #updateClipboardWatcher(): void {
    const { clipboard } = this.#options;
    if (!clipboard || this.#closing) return;
    if ([...this.#sessions].some((session) => session.peer !== null)) void clipboard.start();
    else clipboard.stop();
  }

  #onRemoteClip(from: Session, text: string): void {
    const { log, clipboard } = this.#options;
    log.info(`← ${formatCount(text.length)} chars from ${from.label}`);
    void clipboard?.apply(text);
    const forwarded = this.#broadcast(text, from);
    if (forwarded > 0) log.debug(`  forwarded to ${forwarded} peer${forwarded === 1 ? '' : 's'}`);
  }

  #onLocalChange(text: string): void {
    const { log } = this.#options;
    const sent = this.#broadcast(text, null);
    if (sent > 0) log.info(`→ ${formatCount(text.length)} chars sent to ${sent} peer${sent === 1 ? '' : 's'}`);
    else log.debug(`local copy of ${formatCount(text.length)} chars: no peer received it`);
  }

  /** Sends to every ready peer except `except`; returns how many peers got the text. */
  #broadcast(text: string, except: Session | null): number {
    let sent = 0;
    for (const session of this.#sessions) {
      if (session === except) continue;
      const result = session.sendClip(text);
      if (result === 'sent') sent++;
      else if (result === 'too-large') {
        this.#options.log.warn(`not sent to ${session.label}: ${formatCount(Buffer.byteLength(text))} bytes is above the size limit`);
      } else if (result === 'too-slow') {
        this.#options.log.warn(`not sent to ${session.label}: the peer has not received the earlier data yet`);
      }
    }
    return sent;
  }
}
