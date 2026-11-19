import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Timings } from '../src/config.ts';
import type { KdfParams } from '../src/crypto.ts';
import type { Logger } from '../src/log.ts';

/** Cheap scrypt cost for tests. Production uses DEFAULT_KDF. */
export const FAST_KDF: KdfParams = { N: 2 ** 10, r: 8, p: 1 };

export const FAST_TIMINGS: Partial<Timings> = {
  handshakeTimeoutMs: 2000,
  heartbeatIntervalMs: 100,
  idleTimeoutMs: 600,
  reconnectMinMs: 50,
  reconnectMaxMs: 200,
  authFailureDelayMs: 10,
  authBlockBaseMs: 400,
  authBlockMaxMs: 1000,
  connectTimeoutMs: 1000,
};

/**
 * In-memory clipboard (a ClipboardBackend by its shape).
 * `read()` captures the text when the read starts, like a real subprocess.
 */
export class MemoryClipboard {
  text: string;
  reads = 0;
  writes: string[] = [];
  readDelayMs = 0;
  failReads = false;
  failNextWrite = false;

  constructor(text = '') {
    this.text = text;
  }

  async read(): Promise<string> {
    this.reads++;
    if (this.failReads) throw new Error("Can't open display");
    const value = this.text;
    if (this.readDelayMs > 0) await sleep(this.readDelayMs);
    return value;
  }

  async write(text: string): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('pbcopy failed');
    }
    this.writes.push(text);
    this.text = text;
  }
}

export interface RecordingLogger extends Logger {
  lines: Array<{ level: 'info' | 'warn' | 'error' | 'debug'; message: string }>;
  has(level: 'info' | 'warn' | 'error' | 'debug', pattern: RegExp): boolean;
}

export function recordingLogger(): RecordingLogger {
  const lines: RecordingLogger['lines'] = [];
  return {
    lines,
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
    debug: (message) => lines.push({ level: 'debug', message }),
    has: (level, pattern) => lines.some((line) => line.level === level && pattern.test(line.message)),
  };
}

/** Two connected TCP sockets on the loopback interface. */
export async function socketPair(host = '127.0.0.1'): Promise<{ client: net.Socket; server: net.Socket }> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, host, resolve));
  const { port } = listener.address() as net.AddressInfo;
  const accepted = once(listener, 'connection');
  const client = net.connect(port, host);
  const connected = once(client, 'connect');
  const [server] = (await accepted) as [net.Socket];
  await connected;
  listener.close();
  return { client, server };
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}
