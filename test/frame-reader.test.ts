import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { FrameType, encodeFrame } from '../src/frame.ts';
import { FrameReader } from '../src/frame-reader.ts';
import { socketPair } from './helpers.ts';

describe('FrameReader', () => {
  it('stops reading when nobody consumes frames, so a flood cannot fill the memory', { timeout: 20_000 }, async () => {
    const { client, server } = await socketPair();
    try {
      const reader = new FrameReader(server, 256);
      const frame = encodeFrame(FrameType.Hello, Buffer.alloc(200, 1));
      const chunk = Buffer.concat(Array.from({ length: 5000 }, () => frame)); // ~1 MB of valid frames
      const total = 20 * chunk.length;
      let written = 0;
      const writeMore = () => {
        while (written < total) {
          written += chunk.length;
          if (!client.write(chunk)) {
            client.once('drain', writeMore);
            return;
          }
        }
      };
      writeMore();

      await sleep(300); // like the hub during scrypt: nobody calls next()
      assert.ok(reader.bufferedBytes < 256 + 64 * 1024 + 128 * 1024, `buffered ${reader.bufferedBytes} bytes`);

      // Consuming frames resumes the socket, and every frame arrives.
      for (let i = 0; i < 100_000; i++) await reader.next();
    } finally {
      client.destroy();
      server.destroy();
    }
  });

  it('returns frames that arrived before the peer closed, then the close reason', { timeout: 5_000 }, async () => {
    const { client, server } = await socketPair();
    try {
      const reader = new FrameReader(server, 256);
      client.end(Buffer.concat([encodeFrame(FrameType.Hello, Buffer.from('a')), encodeFrame(FrameType.Auth, Buffer.from('b'))]));
      assert.equal((await reader.next()).type, FrameType.Hello);
      assert.equal((await reader.next()).type, FrameType.Auth);
      await assert.rejects(reader.next(), { name: 'ConnectionClosedError' });
    } finally {
      client.destroy();
      server.destroy();
    }
  });
});
