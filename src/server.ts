/**
 * The hub: accepts clients, checks the passphrase, and relays clipboard text.
 *
 *   client A ──▶ hub ──▶ client B, client C …   (never back to A)
 *                 └────▶ local clipboard (unless --no-clipboard)
 *   local clipboard change ──▶ all clients
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { ClipboardWatcher } from './clipboard.ts';
import { DEFAULT_TIMINGS, MAX_CONCURRENT_KDF, MAX_CONNECTIONS, type Timings } from './config.ts';
import type { KdfParams } from './crypto.ts';
import { FrameReader } from './frame-reader.ts';
import { HANDSHAKE_MAX_BODY_BYTES, HandshakeError, serverHandshake } from './handshake.ts';
import { Limiter } from './limiter.ts';
import { type Logger, formatCount } from './log.ts';
import { Session, formatAddress } from './session.ts';

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
  readonly #pending = new Set<net.Socket>();
  readonly #kdfLimiter = new Limiter(MAX_CONCURRENT_KDF);
  /** Wrong-passphrase history per IP address, to slow down online guessing. */
  readonly #authFailures = new Map<string, { count: number; blockedUntil: number }>();
  #closing = false;

  constructor(options: HubOptions) {
    super();
    this.#options = options;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#server = net.createServer((socket) => void this.#accept(socket));
    this.#server.maxConnections = MAX_CONNECTIONS;
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
    for (const socket of this.#pending) socket.destroy();
    for (const session of this.#sessions) session.close();
    await closed;
  }

  /** Returns how long the address is now blocked. */
  #recordAuthFailure(ip: string): number {
    const now = Date.now();
    if (this.#authFailures.size > 1000) {
      for (const [key, entry] of this.#authFailures) {
        if (entry.blockedUntil < now) this.#authFailures.delete(key);
      }
    }
    const count = (this.#authFailures.get(ip)?.count ?? 0) + 1;
    const blockMs = Math.min(this.#timings.authBlockMaxMs, this.#timings.authBlockBaseMs * 2 ** Math.min(count - 1, 20));
    this.#authFailures.set(ip, { count, blockedUntil: now + blockMs });
    return blockMs;
  }

  /** Reads the clipboard only while at least one peer is ready to receive. */
  #updateClipboardWatcher(): void {
    const { clipboard } = this.#options;
    if (!clipboard || this.#closing) return;
    if ([...this.#sessions].some((session) => session.peer !== null)) void clipboard.start();
    else clipboard.stop();
  }

  async #accept(socket: net.Socket): Promise<void> {
    const { log } = this.#options;
    const remote = formatAddress(socket.remoteAddress, socket.remotePort);
    const ip = formatAddress(socket.remoteAddress, undefined);
    if (this.#closing) {
      socket.destroy();
      return;
    }
    const blocked = this.#authFailures.get(ip);
    if (blocked && Date.now() < blocked.blockedUntil) {
      log.debug(`refused ${remote}: wrong passphrase recently, blocked for ${Math.ceil((blocked.blockedUntil - Date.now()) / 1000)} s`);
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, this.#timings.heartbeatIntervalMs);
    this.#pending.add(socket);
    log.debug(`connection from ${remote}`);

    const reader = new FrameReader(socket, HANDSHAKE_MAX_BODY_BYTES);
    const timer = setTimeout(() => socket.destroy(new Error('handshake timed out')), this.#timings.handshakeTimeoutMs);
    let channel;
    try {
      channel = await serverHandshake(socket, reader, {
        passphrase: this.#options.passphrase,
        kdfLimiter: this.#kdfLimiter,
        authFailureDelayMs: this.#timings.authFailureDelayMs,
        ...(this.#options.kdf ? { kdf: this.#options.kdf } : {}),
      });
    } catch (error) {
      socket.destroy();
      if (error instanceof HandshakeError && error.failure === 'peer-unverified') {
        const blockMs = this.#recordAuthFailure(ip);
        log.warn(`rejected ${remote}: wrong passphrase; this address is blocked for ${(blockMs / 1000).toFixed(0)} s`);
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
    this.#authFailures.delete(ip);

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

  #onRemoteClip(from: Session, text: string): void {
    const { log, clipboard } = this.#options;
    log.info(`← ${formatCount(text.length)} chars from ${from.label}`);
    void clipboard?.apply(text);
    const forwarded = this.#broadcast(text, from);
    if (forwarded > 0) log.debug(`  forwarded to ${forwarded} peer${forwarded === 1 ? '' : 's'}`);
  }

  #onLocalChange(text: string): void {
    const { log } = this.#options;
    if (this.#sessions.size === 0) {
      log.debug(`local copy of ${formatCount(text.length)} chars: no peers connected`);
      return;
    }
    const sent = this.#broadcast(text, null);
    if (sent > 0) log.info(`→ ${formatCount(text.length)} chars sent to ${sent} peer${sent === 1 ? '' : 's'}`);
  }

  #broadcast(text: string, except: Session | null): number {
    let sent = 0;
    for (const session of this.#sessions) {
      if (session === except) continue;
      const result = session.sendClip(text);
      if (result === 'sent') sent++;
      else if (result === 'too-large') {
        this.#options.log.warn(`not sent to ${session.label}: ${formatCount(Buffer.byteLength(text))} bytes is above the size limit`);
      }
    }
    return sent;
  }
}
