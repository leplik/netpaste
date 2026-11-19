import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { Client, FatalError } from '../src/client.ts';
import { ClipboardWatcher } from '../src/clipboard.ts';
import { FrameType, encodeFrame } from '../src/frame.ts';
import { FrameReader } from '../src/frame-reader.ts';
import { MAX_CONCURRENT_KDF, MAX_PENDING_PER_ADDRESS } from '../src/config.ts';
import { HANDSHAKE_MAX_BODY_BYTES, HandshakeErrorCode, clientHandshake, serverHandshake } from '../src/handshake.ts';
import { Hub } from '../src/server.ts';
import { Session } from '../src/session.ts';
import { FAST_KDF, FAST_TIMINGS, MemoryClipboard, type RecordingLogger, recordingLogger, socketPair, waitFor } from './helpers.ts';

const PASSPHRASE = 'correct horse battery staple';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface Machine {
  backend: MemoryClipboard;
  watcher: ClipboardWatcher;
  log: RecordingLogger;
}

function machine(initial: string): Machine {
  const backend = new MemoryClipboard(initial);
  const log = recordingLogger();
  const watcher = new ClipboardWatcher(backend, { intervalMs: 20, log });
  cleanups.push(() => watcher.stop());
  return { backend, watcher, log };
}

async function startHub(options: { clipboard?: Machine; port?: number; maxTextBytes?: number; host?: string } = {}) {
  const log = options.clipboard?.log ?? recordingLogger();
  const hub = new Hub({
    port: options.port ?? 0,
    host: options.host ?? '127.0.0.1',
    passphrase: PASSPHRASE,
    clipboard: options.clipboard?.watcher ?? null,
    maxTextBytes: options.maxTextBytes ?? 10 * 1024 * 1024,
    localName: 'hub',
    version: 'test',
    log,
    timings: FAST_TIMINGS,
    kdf: FAST_KDF,
  });
  const { port } = await hub.listen();
  cleanups.push(() => hub.close());
  return { hub, port, log };
}

interface ClientTestOptions {
  passphrase?: string;
  maxTextBytes?: number;
  host?: string;
  /** Simulates mDNS discovery: the client gets the address from this function. */
  findServer?: (signal: AbortSignal) => Promise<{ host: string; port: number }>;
}

async function startClient(port: number, name: string, m: Machine | null, options: ClientTestOptions = {}) {
  const log = m?.log ?? recordingLogger();
  const client = new Client({
    target: options.findServer ? null : { host: options.host ?? '127.0.0.1', port },
    findServer: options.findServer,
    passphrase: options.passphrase ?? PASSPHRASE,
    clipboard: m?.watcher ?? null,
    maxTextBytes: options.maxTextBytes ?? 10 * 1024 * 1024,
    localName: name,
    version: 'test',
    log,
    timings: FAST_TIMINGS,
    kdf: FAST_KDF,
  });
  const running = client.run();
  cleanups.push(async () => {
    await client.close();
    await running.catch(() => undefined);
  });
  return { client, running, log };
}

const connectedPeers = (hub: Hub) => hub.peers.filter((session) => session.peer !== null).length;

/** A TCP server for fake hubs; `onConnection` gets every accepted socket. */
async function fakeServer(onConnection: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => sockets.add(socket));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as net.AddressInfo).port;
}

/** A proxy that forwards client→hub at full speed and hub→client at `bytesPerSecond`. */
async function throttledProxy(hubPort: number, bytesPerSecond: number): Promise<number> {
  return fakeServer((client) => {
    const upstream = net.connect(hubPort, '127.0.0.1');
    upstream.on('error', () => undefined);
    client.pipe(upstream);
    const queue: Buffer[] = [];
    upstream.on('data', (data: Buffer) => queue.push(data));
    const timer = setInterval(() => {
      let budget = bytesPerSecond / 20;
      while (budget > 0 && queue.length > 0) {
        const head = queue[0]!;
        const part = head.subarray(0, budget);
        client.write(part);
        budget -= part.length;
        if (part.length === head.length) queue.shift();
        else queue[0] = head.subarray(part.length);
      }
    }, 50);
    const end = () => {
      clearInterval(timer);
      client.destroy();
      upstream.destroy();
    };
    client.on('close', end);
    upstream.on('close', end);
  });
}

const hasIPv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = net.createServer().once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});

describe('hub with clients', () => {
  it('syncs text between all machines without echo and without changing it', async () => {
    const hubMachine = machine('hub initial');
    const a = machine('a initial');
    const b = machine('b initial');
    const { hub, port } = await startHub({ clipboard: hubMachine });
    const ca = await startClient(port, 'a', a);
    const cb = await startClient(port, 'b', b);
    await waitFor(() => connectedPeers(hub) === 2 && !!ca.client.session?.peer && !!cb.client.session?.peer, 'two clients');

    const fromA = '    indented();\n';
    a.backend.text = fromA;
    await waitFor(() => hubMachine.backend.text === fromA && b.backend.text === fromA, 'A → hub and B');

    const fromB = 'Привет 🙂\r\n';
    b.backend.text = fromB;
    await waitFor(() => hubMachine.backend.text === fromB && a.backend.text === fromB, 'B → hub and A');

    const fromHub = '\tfrom the hub\n\n';
    hubMachine.backend.text = fromHub;
    await waitFor(() => a.backend.text === fromHub && b.backend.text === fromHub, 'hub → A and B');

    await sleep(200); // room for an echo, if there was one
    assert.deepEqual(a.backend.writes, [fromB, fromHub]);
    assert.deepEqual(b.backend.writes, [fromA, fromHub]);
    assert.deepEqual(hubMachine.backend.writes, [fromA, fromB]);
  });

  it('reads the clipboard only while a peer is connected', async () => {
    const hubMachine = machine('hub');
    const a = machine('a');
    const { hub, port } = await startHub({ clipboard: hubMachine });
    await sleep(150);
    assert.equal(hubMachine.backend.reads, 0, 'no reads without peers');

    const ca = await startClient(port, 'a', a);
    await waitFor(() => connectedPeers(hub) === 1 && hubMachine.backend.reads > 2 && a.backend.reads > 2, 'polling while connected');

    await ca.client.close();
    await waitFor(() => connectedPeers(hub) === 0, 'disconnect');
    await sleep(50);
    const hubReads = hubMachine.backend.reads;
    const clientReads = a.backend.reads;
    await sleep(200);
    assert.equal(hubMachine.backend.reads, hubReads, 'hub stopped reading');
    assert.equal(a.backend.reads, clientReads, 'client stopped reading');
  });

  it('relays between clients when the hub has no clipboard', async () => {
    const a = machine('a');
    const b = machine('b');
    const { hub, port } = await startHub();
    await startClient(port, 'a', a);
    await startClient(port, 'b', b);
    await waitFor(() => connectedPeers(hub) === 2, 'two clients');
    a.backend.text = 'relayed';
    await waitFor(() => b.backend.text === 'relayed', 'A → B through a relay');
  });

  it('delivers a 3 MB text intact', async () => {
    const a = machine('a');
    const b = machine('b');
    const { hub, port } = await startHub();
    await startClient(port, 'a', a);
    await startClient(port, 'b', b);
    await waitFor(() => connectedPeers(hub) === 2, 'two clients');
    const big = 'строка текста 0123456789\n'.repeat(80_000);
    a.backend.text = big;
    await waitFor(() => b.backend.text === big, '3 MB text', 8000);
  });

  it('does not forward text above the receiver limit and keeps the connection', async () => {
    const a = machine('a');
    const b = machine('b');
    const { hub, port, log } = await startHub();
    await startClient(port, 'a', a);
    await startClient(port, 'b', b, { maxTextBytes: 2048 });
    await waitFor(() => connectedPeers(hub) === 2, 'two clients');
    a.backend.text = 'x'.repeat(4096);
    await waitFor(() => log.has('warn', /above the size limit/), 'size warning');
    a.backend.text = 'small';
    await waitFor(() => b.backend.text === 'small', 'small text after the big one');
    assert.deepEqual(b.backend.writes, ['small']);
  });
});

describe('security and robustness', () => {
  it('stops a client with a wrong passphrase and reports it on the hub', async () => {
    const { hub, port } = await startHub();
    const failed = once(hub, 'auth-failed');
    const { running } = await startClient(port, 'intruder', null, { passphrase: 'wrong passphrase' });
    await assert.rejects(running, (error: unknown) => error instanceof FatalError && /wrong passphrase/.test(error.message));
    await failed;
  });

  it('blocks an address for a while after a wrong passphrase', async () => {
    const { hub, port, log } = await startHub();
    const intruder = await startClient(port, 'intruder', null, { passphrase: 'wrong passphrase' });
    await assert.rejects(intruder.running, FatalError);
    const blockedAt = Date.now();
    await startClient(port, 'owner', null);
    await waitFor(() => connectedPeers(hub) === 1, 'connection after the block');
    assert.ok(Date.now() - blockedAt >= 300, 'the address was blocked first');
    assert.ok(log.has('debug', /refused .*blocked for/));
  });

  it('survives junk from the network (1.x crashed on 4 bytes)', async () => {
    const { hub, port } = await startHub();
    for (const junk of [Buffer.from('NetP'), Buffer.from('3ef272b5:83ec914f:143cf00c'), Buffer.from([0, 0, 0, 0]), Buffer.from([0xff, 0xff, 0xff, 0xff, 1])]) {
      const socket = net.connect(port, '127.0.0.1');
      await once(socket, 'connect');
      socket.on('error', () => undefined);
      socket.end(junk);
      await once(socket, 'close');
    }
    const a = machine('a');
    await startClient(port, 'a', a);
    await waitFor(() => connectedPeers(hub) === 1, 'a normal client after the junk');
  });

  it('sends nothing but its HELLO to a peer that has not proved the passphrase', async () => {
    const hubMachine = machine('hub');
    const { port } = await startHub({ clipboard: hubMachine });
    const socket = net.connect(port, '127.0.0.1');
    cleanups.push(() => void socket.destroy());
    await once(socket, 'connect');
    let received = 0;
    socket.on('data', (data: Buffer) => (received += data.length));
    socket.write(encodeFrame(FrameType.Hello, Buffer.concat([Buffer.from('NETPASTE'), Buffer.of(2, 0), Buffer.alloc(32, 7)])));
    await sleep(100);
    hubMachine.backend.text = 'secret text';
    await sleep(300);
    assert.equal(received, 5 + 42, 'only the server HELLO');
  });

  it('reconnects after the hub restarts', async () => {
    const first = await startHub();
    const a = machine('a');
    const { client } = await startClient(first.port, 'a', a);
    await waitFor(() => connectedPeers(first.hub) === 1, 'first connection');
    await first.hub.close();
    await waitFor(() => client.session === null, 'disconnect');
    const second = await startHub({ port: first.port });
    await waitFor(() => connectedPeers(second.hub) === 1, 'reconnection', 5000);
  });

  it('drops a peer that stops answering and keeps a quiet but healthy one', async () => {
    // A fake server: it completes the handshake, then never sends anything (no INFO, no PONG).
    const silent = net.createServer((socket) => {
      socket.on('error', () => undefined);
      void serverHandshake(socket, new FrameReader(socket, HANDSHAKE_MAX_BODY_BYTES), { passphrase: PASSPHRASE, kdf: FAST_KDF }).catch(() => undefined);
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => silent.close(() => resolve())));
    const silentPort = (silent.address() as net.AddressInfo).port;
    const { log } = await startClient(silentPort, 'a', null);
    await waitFor(() => log.has('info', /no data from the peer/), 'idle timeout');

    const { hub, port } = await startHub();
    const healthy = await startClient(port, 'b', null);
    await waitFor(() => connectedPeers(hub) === 1, 'healthy connection');
    const session = healthy.client.session;
    await sleep(1500); // well above idleTimeoutMs: heartbeats keep it open
    assert.equal(healthy.client.session, session);
    assert.equal(session?.closed, false);
  });
});

describe('connections without the passphrase', () => {
  it('are limited per address, so other machines still get in', { skip: !hasIPv6Loopback }, async () => {
    const { hub, port } = await startHub({ host: '::' });
    let closed = 0;
    for (let i = 0; i < 8; i++) {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => undefined);
      socket.on('close', () => closed++);
      cleanups.push(() => void socket.destroy());
    }
    await waitFor(() => closed === 8 - MAX_PENDING_PER_ADDRESS, 'the hub refuses the extra connections');
    await startClient(port, 'other machine', null, { host: '::1' });
    await waitFor(() => connectedPeers(hub) === 1, 'a client from another address');
  });

  it('cannot test many passphrases in parallel from one address', async () => {
    const { hub, port } = await startHub();
    let checked = 0;
    hub.on('auth-failed', () => checked++);
    const attempts = Array.from({ length: MAX_PENDING_PER_ADDRESS }, async () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => undefined);
      cleanups.push(() => void socket.destroy());
      await once(socket, 'connect');
      return clientHandshake(socket, new FrameReader(socket, HANDSHAKE_MAX_BODY_BYTES), { passphrase: 'a wrong guess', kdf: FAST_KDF });
    });
    const results = await Promise.allSettled(attempts);
    assert.ok(results.every((result) => result.status === 'rejected'));
    await sleep(100);
    assert.ok(checked >= 1 && checked <= MAX_CONCURRENT_KDF, `${checked} guesses were checked`);
  });
});

describe('client lifecycle', () => {
  it('stops when it is closed during discovery', async () => {
    const { hub, port } = await startHub();
    const { client, running } = await startClient(port, 'a', null, {
      // Ignores the signal on purpose: the client must still stop after it returns.
      findServer: async () => {
        await sleep(300);
        return { host: '127.0.0.1', port };
      },
    });
    await sleep(100);
    await client.close();
    const state = await Promise.race([running.then(() => 'stopped'), sleep(1000).then(() => 'still running')]);
    assert.equal(state, 'stopped');
    await sleep(200);
    assert.equal(hub.peers.length, 0);
  });

  it('keeps trying after a forged "wrong passphrase" that came before its own proof', async () => {
    const port = await fakeServer((socket) => socket.end(encodeFrame(FrameType.Error, Buffer.of(HandshakeErrorCode.AuthFailed))));
    const { running, log } = await startClient(port, 'a', null);
    const state = await Promise.race([running.then(() => 'stopped', () => 'stopped'), sleep(500).then(() => 'running')]);
    assert.equal(state, 'running');
    assert.ok(log.has('warn', /before the passphrase check/));
  });

  it('does not stop when a server found by mDNS rejects the passphrase (it may be an impostor)', async () => {
    const { port } = await startHub();
    const { running, log } = await startClient(port, 'a', null, {
      passphrase: 'wrong passphrase',
      findServer: async () => ({ host: '127.0.0.1', port }),
    });
    await waitFor(() => log.has('error', /wrong passphrase/), 'an error message');
    const state = await Promise.race([running.then(() => 'stopped', () => 'stopped'), sleep(300).then(() => 'running')]);
    assert.equal(state, 'running');
  });
});

describe('session', () => {
  it('does not cut a large text on a slow link with the idle timeout', { timeout: 20_000 }, async () => {
    const a = machine('a');
    const b = machine('b');
    const { hub, port } = await startHub();
    await startClient(port, 'a', a);
    const slowPort = await throttledProxy(port, 100 * 1024);
    await startClient(slowPort, 'b', b);
    await waitFor(() => connectedPeers(hub) === 2, 'two clients');
    const text = 'x'.repeat(300 * 1024); // 3 s at 100 KB/s; the idle timeout is 0.6 s
    a.backend.text = text;
    await waitFor(() => b.backend.text === text, 'the text over the slow link', 15_000);
  });

  it('does not send text to a peer that has not introduced itself yet', async () => {
    const pair = await socketPair();
    cleanups.push(() => {
      pair.client.destroy();
      pair.server.destroy();
    });
    const serverReader = new FrameReader(pair.server, HANDSHAKE_MAX_BODY_BYTES);
    const [, serverChannel] = await Promise.all([
      clientHandshake(pair.client, new FrameReader(pair.client, HANDSHAKE_MAX_BODY_BYTES), { passphrase: PASSPHRASE, kdf: FAST_KDF }),
      serverHandshake(pair.server, serverReader, { passphrase: PASSPHRASE, kdf: FAST_KDF }),
    ]);
    const session = new Session(pair.server, serverReader, serverChannel, {
      maxTextBytes: 1024 * 1024,
      heartbeatIntervalMs: 1000,
      idleTimeoutMs: 5000,
      localName: 'hub',
      version: 'test',
    });
    session.start();
    assert.equal(session.sendClip('text'), 'not-ready');
    session.close();
  });
});
