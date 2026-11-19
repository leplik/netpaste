import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { IntegrityError, generateEphemeralKey } from '../src/crypto.ts';
import { FrameDecoder, FrameType, encodeFrame } from '../src/frame.ts';
import { FrameReader } from '../src/frame-reader.ts';
import {
  HANDSHAKE_MAX_BODY_BYTES,
  HandshakeError,
  HandshakeErrorCode,
  clientHandshake,
  serverHandshake,
} from '../src/handshake.ts';
import type { Limiter } from '../src/limiter.ts';
import { FAST_KDF, socketPair } from './helpers.ts';

function handshakes(pair: { client: net.Socket; server: net.Socket }, clientPassphrase: string, serverPassphrase: string) {
  return Promise.allSettled([
    clientHandshake(pair.client, new FrameReader(pair.client, HANDSHAKE_MAX_BODY_BYTES), { passphrase: clientPassphrase, kdf: FAST_KDF }),
    serverHandshake(pair.server, new FrameReader(pair.server, HANDSHAKE_MAX_BODY_BYTES), { passphrase: serverPassphrase, kdf: FAST_KDF }),
  ]);
}

function failure(result: PromiseSettledResult<unknown>): string {
  assert.equal(result.status, 'rejected');
  const reason = (result as PromiseRejectedResult).reason;
  assert.ok(reason instanceof HandshakeError, `expected HandshakeError, got ${reason}`);
  return reason.failure;
}

describe('handshake', () => {
  it('connects peers with the same passphrase and gives working channels', async () => {
    const pair = await socketPair();
    const [client, server] = await handshakes(pair, 'correct horse battery staple', 'correct horse battery staple');
    assert.equal(client.status, 'fulfilled');
    assert.equal(server.status, 'fulfilled');
    const decoder = new FrameDecoder(1024);
    decoder.push(client.value.seal(Buffer.from('hello hub')));
    assert.equal(server.value.open(decoder.next()!).toString(), 'hello hub');
    pair.client.destroy();
    pair.server.destroy();
  });

  it('rejects a different passphrase on both sides', async () => {
    const pair = await socketPair();
    const [client, server] = await handshakes(pair, 'passphrase one', 'passphrase two');
    assert.equal(failure(client), 'rejected');
    assert.equal(failure(server), 'peer-unverified');
    pair.client.destroy();
  });

  it('fails when a man-in-the-middle changes one byte of the server key', async () => {
    const left = await socketPair();
    const right = await socketPair();
    left.server.on('data', (data: Buffer) => right.client.write(data));
    let offset = 0;
    right.client.on('data', (data: Buffer) => {
      const copy = Buffer.from(data);
      const target = 20 - offset; // inside the X25519 key of the server HELLO
      if (target >= 0 && target < copy.length) copy[target] = copy[target]! ^ 0x01;
      offset += data.length;
      left.server.write(copy);
    });
    const [client, server] = await Promise.allSettled([
      clientHandshake(left.client, new FrameReader(left.client, HANDSHAKE_MAX_BODY_BYTES), { passphrase: 'same', kdf: FAST_KDF }),
      serverHandshake(right.server, new FrameReader(right.server, HANDSHAKE_MAX_BODY_BYTES), { passphrase: 'same', kdf: FAST_KDF }),
    ]);
    assert.equal(client.status, 'rejected');
    assert.equal(server.status, 'rejected');
    for (const socket of [left.client, left.server, right.client, right.server]) socket.destroy();
  });

  it('answers another protocol version with an error code', async () => {
    const pair = await socketPair();
    const serverDone = assert.rejects(
      serverHandshake(pair.server, new FrameReader(pair.server, HANDSHAKE_MAX_BODY_BYTES), { passphrase: 'x', kdf: FAST_KDF }),
      (error: unknown) => error instanceof HandshakeError && error.failure === 'version-mismatch',
    );
    const reader = new FrameReader(pair.client, HANDSHAKE_MAX_BODY_BYTES);
    pair.client.write(encodeFrame(FrameType.Hello, Buffer.concat([Buffer.from('NETPASTE'), Buffer.of(3, 0), Buffer.alloc(32, 9)])));
    const reply = await reader.next();
    assert.equal(reply.type, FrameType.Error);
    assert.equal(reply.body.readUInt8(0), HandshakeErrorCode.VersionMismatch);
    await serverDone;
    pair.client.destroy();
  });

  it('runs scrypt on the server only after the client proof arrives', async () => {
    const pair = await socketPair();
    let runs = 0;
    const limiter = { run: async <T>(task: () => Promise<T>) => (runs++, task()) } as unknown as Limiter;
    const serverDone = serverHandshake(pair.server, new FrameReader(pair.server, HANDSHAKE_MAX_BODY_BYTES), {
      passphrase: 'x',
      kdf: FAST_KDF,
      kdfLimiter: limiter,
    }).catch(() => undefined);
    pair.client.write(encodeFrame(FrameType.Hello, Buffer.concat([Buffer.from('NETPASTE'), Buffer.of(2, 0), generateEphemeralKey().publicKey])));
    await sleep(200);
    assert.equal(runs, 0, 'a HELLO without AUTH costs the server nothing');
    pair.client.destroy();
    await serverDone;
  });

  it('does not believe a "wrong passphrase" error that arrives before its own proof', async () => {
    const pair = await socketPair();
    const clientDone = clientHandshake(pair.client, new FrameReader(pair.client, HANDSHAKE_MAX_BODY_BYTES), { passphrase: 'x', kdf: FAST_KDF });
    pair.server.write(encodeFrame(FrameType.Error, Buffer.of(HandshakeErrorCode.AuthFailed)));
    await assert.rejects(clientDone, (error: unknown) => error instanceof HandshakeError && error.failure === 'protocol');
    pair.client.destroy();
    pair.server.destroy();
  });

  it('rejects a low-order X25519 key', async () => {
    const pair = await socketPair();
    const serverDone = serverHandshake(pair.server, new FrameReader(pair.server, HANDSHAKE_MAX_BODY_BYTES), { passphrase: 'x', kdf: FAST_KDF });
    pair.client.write(encodeFrame(FrameType.Hello, Buffer.concat([Buffer.from('NETPASTE'), Buffer.of(2, 0), Buffer.alloc(32)])));
    await assert.rejects(serverDone, IntegrityError);
    pair.client.destroy();
    pair.server.destroy();
  });

  it('turns netpaste 1.x traffic into a protocol error', async () => {
    const pair = await socketPair();
    const serverDone = serverHandshake(pair.server, new FrameReader(pair.server, HANDSHAKE_MAX_BODY_BYTES), { passphrase: 'x', kdf: FAST_KDF });
    pair.client.write('3ef272b5cddc68b4154a11c50ed1dd65:83ec914fc393d2a4ac95cfa93475d7fc:143cf00c');
    await assert.rejects(serverDone, (error: unknown) => error instanceof HandshakeError && error.failure === 'protocol');
    pair.client.destroy();
    pair.server.destroy();
  });
});
