import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import {
  DEFAULT_KDF,
  IntegrityError,
  SecureChannel,
  derivePassphraseKey,
  deriveSessionSecrets,
  generateEphemeralKey,
  x25519,
} from '../src/crypto.ts';
import { FrameDecoder, FrameType } from '../src/frame.ts';
import { FAST_KDF } from './helpers.ts';

function pair(): { a: SecureChannel; b: SecureChannel } {
  const k1 = crypto.randomBytes(32);
  const k2 = crypto.randomBytes(32);
  return { a: new SecureChannel(k1, k2), b: new SecureChannel(k2, k1) };
}

function decode(bytes: Buffer) {
  const decoder = new FrameDecoder(1 << 20);
  decoder.push(bytes);
  const frame = decoder.next();
  assert.ok(frame);
  return frame;
}

describe('SecureChannel', () => {
  it('round-trips messages in both directions', () => {
    const { a, b } = pair();
    for (const text of ['one', '', 'three 🙂']) {
      assert.equal(b.open(decode(a.seal(Buffer.from(text)))).toString(), text);
      assert.equal(a.open(decode(b.seal(Buffer.from(text)))).toString(), text);
    }
  });

  it('rejects a changed ciphertext (AES-CTR in 1.x accepted this)', () => {
    const { a, b } = pair();
    const sealed = a.seal(Buffer.from('ls -la ~/project'));
    sealed[8] = sealed[8]! ^ 0x01;
    assert.throws(() => b.open(decode(sealed)), IntegrityError);
  });

  it('rejects a changed header (the header is authenticated)', () => {
    const { a, b } = pair();
    const frame = decode(a.seal(Buffer.from('hello')));
    const header = Buffer.from(frame.header);
    header[4] = FrameType.Hello;
    assert.throws(() => b.open({ ...frame, header, type: FrameType.Sealed }), IntegrityError);
  });

  it('rejects a replayed and a reordered message', () => {
    const { a, b } = pair();
    const first = a.seal(Buffer.from('first'));
    const second = a.seal(Buffer.from('second'));
    assert.throws(() => b.open(decode(second)), IntegrityError, 'reordered');
    assert.equal(b.open(decode(first)).toString(), 'first');
    assert.throws(() => b.open(decode(first)), IntegrityError, 'replayed');
    assert.equal(b.open(decode(second)).toString(), 'second');
  });

  it('does not accept its own messages back (separate keys per direction)', () => {
    const { a } = pair();
    assert.throws(() => a.open(decode(a.seal(Buffer.from('echo')))), IntegrityError);
  });
});

describe('key agreement and derivation', () => {
  it('gives both sides the same X25519 secret', () => {
    const alice = generateEphemeralKey();
    const bob = generateEphemeralKey();
    assert.deepEqual(x25519(alice.privateKey, bob.publicKey), x25519(bob.privateKey, alice.publicKey));
  });

  it('rejects malformed and low-order X25519 keys', () => {
    const key = generateEphemeralKey();
    assert.throws(() => x25519(key.privateKey, Buffer.alloc(31)), IntegrityError);
    assert.throws(() => x25519(key.privateKey, Buffer.alloc(32)), IntegrityError);
  });

  it('derives the same passphrase key for NFC and NFD spellings', async () => {
    const salt = crypto.randomBytes(32);
    const composed = 'пароль-й'.normalize('NFC');
    const decomposed = 'пароль-й'.normalize('NFD');
    assert.notEqual(composed, decomposed);
    assert.deepEqual(await derivePassphraseKey(composed, salt, FAST_KDF), await derivePassphraseKey(decomposed, salt, FAST_KDF));
  });

  it('runs scrypt with the production cost (128 MiB)', async () => {
    const key = await derivePassphraseKey('correct horse battery staple', crypto.randomBytes(32), DEFAULT_KDF);
    assert.equal(key.length, 32);
  });

  it('splits the key material into four different keys', () => {
    const secrets = deriveSessionSecrets(crypto.randomBytes(32), crypto.randomBytes(32), crypto.randomBytes(32));
    const keys = Object.values(secrets).map((key) => key.toString('hex'));
    assert.equal(new Set(keys).size, 4);
  });
});
