/**
 * Cryptographic building blocks. Only `node:crypto` is used.
 *
 * - Passphrase key: scrypt (memory-hard), salted per connection.
 * - Key agreement: ephemeral X25519 (forward secrecy).
 * - Key schedule: HKDF-SHA256 over (X25519 secret || passphrase key).
 * - Messages: AES-256-GCM. The nonce is a per-direction counter, so a replayed,
 *   reordered or dropped message fails authentication.
 */
import crypto from 'node:crypto';
import { type Frame, FrameType, frameHeader } from './frame.ts';

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP-recommended scrypt cost: 128 MiB of memory, about 0.2 s on a laptop. */
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

export const KEY_BYTES = 32;
export const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MAX_COUNTER = 2n ** 64n - 1n;

export class IntegrityError extends Error {
  override name = 'IntegrityError';
}

export function sha256(...parts: Uint8Array[]): Buffer {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function hmacSha256(key: Uint8Array, ...parts: Uint8Array[]): Buffer {
  const mac = crypto.createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Unicode NFC normalization: the same passphrase typed on macOS and Linux can arrive
 * in different normalization forms (for example "й" as one or as two code points).
 */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize('NFC');
}

export function derivePassphraseKey(passphrase: string, salt: Uint8Array, params: KdfParams = DEFAULT_KDF): Promise<Buffer> {
  const maxmem = 128 * params.N * params.r * params.p + 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    crypto.scrypt(normalizePassphrase(passphrase), salt, KEY_BYTES, { ...params, maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export interface EphemeralKey {
  privateKey: crypto.KeyObject;
  /** Raw 32-byte X25519 public key. */
  publicKey: Buffer;
}

export function generateEphemeralKey(): EphemeralKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const { x } = publicKey.export({ format: 'jwk' });
  if (!x) throw new Error('cannot export the X25519 public key');
  return { privateKey, publicKey: Buffer.from(x, 'base64url') };
}

export function x25519(privateKey: crypto.KeyObject, peerPublicKey: Uint8Array): Buffer {
  if (peerPublicKey.length !== KEY_BYTES) throw new IntegrityError('invalid X25519 public key length');
  const publicKey = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(peerPublicKey).toString('base64url') },
    format: 'jwk',
  });
  let shared: Buffer;
  try {
    shared = crypto.diffieHellman({ privateKey, publicKey });
  } catch {
    throw new IntegrityError('invalid X25519 public key');
  }
  // An all-zero result means a low-order public key: the peer would control the secret.
  if (shared.every((byte) => byte === 0)) throw new IntegrityError('invalid X25519 public key (low-order point)');
  return shared;
}

export interface SessionSecrets {
  clientToServer: Buffer;
  serverToClient: Buffer;
  clientProofKey: Buffer;
  serverProofKey: Buffer;
}

export function deriveSessionSecrets(sharedSecret: Buffer, passphraseKey: Buffer, transcriptHash: Buffer): SessionSecrets {
  const okm = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.concat([sharedSecret, passphraseKey]), transcriptHash, 'netpaste/2 session keys', 4 * KEY_BYTES),
  );
  return {
    clientToServer: okm.subarray(0, KEY_BYTES),
    serverToClient: okm.subarray(KEY_BYTES, 2 * KEY_BYTES),
    clientProofKey: okm.subarray(2 * KEY_BYTES, 3 * KEY_BYTES),
    serverProofKey: okm.subarray(3 * KEY_BYTES, 4 * KEY_BYTES),
  };
}

/** Encrypts outgoing and decrypts incoming `Sealed` frames of one connection. */
export class SecureChannel {
  #sendKey: Buffer;
  #receiveKey: Buffer;
  #sendCounter = 0n;
  #receiveCounter = 0n;

  constructor(sendKey: Buffer, receiveKey: Buffer) {
    this.#sendKey = sendKey;
    this.#receiveKey = receiveKey;
  }

  /** Returns a complete frame (header + ciphertext + tag). The header is authenticated too. */
  seal(plaintext: Uint8Array): Buffer {
    const header = frameHeader(FrameType.Sealed, plaintext.length + TAG_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#sendKey, nonce(this.#sendCounter), { authTagLength: TAG_BYTES });
    this.#sendCounter++;
    cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  }

  open(frame: Frame): Buffer {
    if (frame.type !== FrameType.Sealed) throw new IntegrityError(`expected an encrypted frame, got type 0x${frame.type.toString(16)}`);
    if (frame.body.length < TAG_BYTES) throw new IntegrityError('encrypted frame is too short');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.#receiveKey, nonce(this.#receiveCounter), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(frame.header);
    decipher.setAuthTag(frame.body.subarray(frame.body.length - TAG_BYTES));
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(frame.body.subarray(0, frame.body.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new IntegrityError('message failed authentication: it was changed, replayed or reordered');
    }
    this.#receiveCounter++;
    return plaintext;
  }
}

function nonce(counter: bigint): Buffer {
  if (counter > MAX_COUNTER) throw new IntegrityError('message counter exhausted; reconnect');
  const value = Buffer.alloc(NONCE_BYTES);
  value.writeBigUInt64BE(counter, NONCE_BYTES - 8);
  return value;
}
