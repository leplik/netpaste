import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Frame, FrameDecoder, FrameError, FrameType, encodeFrame } from '../src/frame.ts';

const frames = [
  encodeFrame(FrameType.Hello, Buffer.from('first')),
  encodeFrame(FrameType.Sealed, Buffer.alloc(3000, 0x61)),
  encodeFrame(FrameType.Auth),
  encodeFrame(FrameType.Sealed, Buffer.from('Ünïcødé 🙂')),
];
const stream = Buffer.concat(frames);

function decodeAll(decoder: FrameDecoder): Frame[] {
  const out: Frame[] = [];
  for (let frame = decoder.next(); frame; frame = decoder.next()) out.push(frame);
  return out;
}

function assertSameFrames(actual: Frame[]): void {
  assert.equal(actual.length, frames.length);
  actual.forEach((frame, i) => assert.deepEqual(Buffer.concat([frame.header, frame.body]), frames[i]));
}

describe('FrameDecoder', () => {
  it('decodes frames that arrive in one chunk', () => {
    const decoder = new FrameDecoder(10_000);
    decoder.push(stream);
    assertSameFrames(decodeAll(decoder));
    assert.equal(decoder.bufferedBytes, 0);
  });

  it('decodes the same frames for a split at every byte position', () => {
    for (let split = 0; split <= stream.length; split++) {
      const decoder = new FrameDecoder(10_000);
      const out: Frame[] = [];
      decoder.push(stream.subarray(0, split));
      out.push(...decodeAll(decoder));
      decoder.push(stream.subarray(split));
      out.push(...decodeAll(decoder));
      assertSameFrames(out);
    }
  });

  it('decodes a stream fed one byte at a time and in MSS-sized chunks', () => {
    for (const size of [1, 7, 1448]) {
      const decoder = new FrameDecoder(10_000);
      const out: Frame[] = [];
      for (let i = 0; i < stream.length; i += size) {
        decoder.push(stream.subarray(i, i + size));
        out.push(...decodeAll(decoder));
      }
      assertSameFrames(out);
    }
  });

  it('rejects a frame above the limit as soon as the length is known', () => {
    const decoder = new FrameDecoder(100);
    decoder.push(encodeFrame(FrameType.Sealed, Buffer.alloc(101)).subarray(0, 4));
    assert.throws(() => decoder.next(), FrameError);
  });

  it('rejects a zero-length frame', () => {
    const decoder = new FrameDecoder(100);
    decoder.push(Buffer.alloc(4));
    assert.throws(() => decoder.next(), FrameError);
  });

  it('applies a raised limit to the following frames', () => {
    const decoder = new FrameDecoder(10);
    decoder.push(Buffer.concat([encodeFrame(FrameType.Hello, Buffer.alloc(5)), encodeFrame(FrameType.Sealed, Buffer.alloc(500))]));
    assert.equal(decoder.next()?.type, FrameType.Hello);
    decoder.maxBodyBytes = 1000;
    assert.equal(decoder.next()?.body.length, 500);
  });

  it('treats the 4 bytes "NetP" (netpaste 1.x crash input) as an incomplete or oversized frame, not a crash', () => {
    const decoder = new FrameDecoder(256);
    decoder.push(Buffer.from('NetP'));
    assert.throws(() => decoder.next(), FrameError);
  });
});
