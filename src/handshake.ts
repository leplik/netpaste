/**
 * Mutual passphrase authentication and key agreement.
 *
 *   client                                              server
 *     │── HELLO  "NETPASTE" | ver | role=0 | X25519 eC ──▶│
 *     │◀── HELLO "NETPASTE" | ver | role=1 | X25519 eS ───│
 *     │   transcript = SHA-256(label | helloC | helloS)    │
 *     │   pk = scrypt(passphrase, SHA-256(label | transcript))
 *     │   keys = HKDF(X25519(e, e') | pk, transcript)      │
 *     │── AUTH   HMAC(clientProofKey, transcript) ────────▶│ wrong → block address, delay, ERROR, close
 *     │◀── AUTH  HMAC(serverProofKey, transcript) ────────│
 *     │════════ Sealed frames, AES-256-GCM ════════════════│
 *
 * - A passive eavesdropper cannot test passphrase guesses: the proofs depend on the X25519 secret.
 * - The server proves nothing before the client does, so a stranger that connects learns nothing.
 * - The server runs scrypt only after it has the client proof, so each scrypt run costs the
 *   other side a passphrase attempt (and a wrong attempt blocks its address).
 * - Both sides add a fresh key to the scrypt salt, so a fake server cannot reuse precomputed guesses.
 * - An active man-in-the-middle (or a fake server) can still guess the passphrase offline from the
 *   client proof, one scrypt run per guess. A long passphrase makes this impractical.
 */
import type { Duplex } from 'node:stream';
import {
  type KdfParams,
  SecureChannel,
  constantTimeEqual,
  derivePassphraseKey,
  deriveSessionSecrets,
  generateEphemeralKey,
  hmacSha256,
  sha256,
  x25519,
} from './crypto.ts';
import { PROTOCOL_VERSION } from './config.ts';
import { type Frame, FrameError, FrameType, encodeFrame } from './frame.ts';
import { ConnectionClosedError, type FrameReader } from './frame-reader.ts';
import type { Limiter } from './limiter.ts';

const MAGIC = Buffer.from('NETPASTE', 'ascii');
const HELLO_BYTES = MAGIC.length + 1 + 1 + 32;
const PROOF_BYTES = 32;

/** Largest frame body allowed before authentication. */
export const HANDSHAKE_MAX_BODY_BYTES = 256;

const Role = { Client: 0, Server: 1 } as const;
type RoleValue = (typeof Role)[keyof typeof Role];

export const HandshakeErrorCode = {
  AuthFailed: 1,
  VersionMismatch: 2,
  ProtocolError: 3,
} as const;

export type HandshakeFailure =
  /** The peer reported that our passphrase is wrong. */
  | 'rejected'
  /** The peer sent a wrong proof: different passphrase or an impostor. */
  | 'peer-unverified'
  | 'version-mismatch'
  | 'protocol';

export class HandshakeError extends Error {
  override name = 'HandshakeError';
  readonly failure: HandshakeFailure;

  constructor(failure: HandshakeFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

export interface HandshakeOptions {
  passphrase: string;
  kdf?: KdfParams;
  /** Server: limits parallel scrypt runs (each needs ~128 MiB). */
  kdfLimiter?: Limiter;
  /** Server: wait this long before it reports a wrong passphrase. */
  authFailureDelayMs?: number;
  /** Server: asked right before scrypt; false drops the connection (for example, its address was blocked meanwhile). */
  admit?: () => boolean;
  /** Server: called at once when the client proof is wrong, before the delay. */
  onWrongPassphrase?: () => void;
}

export async function clientHandshake(socket: Duplex, reader: FrameReader, options: HandshakeOptions): Promise<SecureChannel> {
  const ephemeral = generateEphemeralKey();
  const helloClient = encodeHello(Role.Client, ephemeral.publicKey);
  socket.write(encodeFrame(FrameType.Hello, helloClient));

  const helloServer = expectFrame(await readHandshakeFrame(reader, false), FrameType.Hello).body;
  const peerKey = parseHello(helloServer, Role.Server);
  const transcript = transcriptHash(helloClient, helloServer);
  const shared = x25519(ephemeral.privateKey, peerKey);
  const passphraseKey = await derivePassphraseKey(options.passphrase, kdfSalt(transcript), options.kdf);
  const secrets = deriveSessionSecrets(shared, passphraseKey, transcript);

  socket.write(encodeFrame(FrameType.Auth, proof(secrets.clientProofKey, 'client', transcript)));

  const serverProof = expectFrame(await readHandshakeFrame(reader, true), FrameType.Auth).body;
  if (!constantTimeEqual(serverProof, proof(secrets.serverProofKey, 'server', transcript))) {
    throw new HandshakeError('peer-unverified', 'the server could not prove that it knows the passphrase');
  }
  return new SecureChannel(secrets.clientToServer, secrets.serverToClient);
}

export async function serverHandshake(socket: Duplex, reader: FrameReader, options: HandshakeOptions): Promise<SecureChannel> {
  const helloClient = expectFrame(await readHandshakeFrame(reader, false), FrameType.Hello).body;
  let peerKey: Buffer;
  try {
    peerKey = parseHello(helloClient, Role.Client);
  } catch (error) {
    if (error instanceof HandshakeError) {
      const code = error.failure === 'version-mismatch' ? HandshakeErrorCode.VersionMismatch : HandshakeErrorCode.ProtocolError;
      socket.end(encodeFrame(FrameType.Error, Buffer.of(code)));
    }
    throw error;
  }

  const ephemeral = generateEphemeralKey();
  const helloServer = encodeHello(Role.Server, ephemeral.publicKey);
  socket.write(encodeFrame(FrameType.Hello, helloServer));

  const transcript = transcriptHash(helloClient, helloServer);
  const shared = x25519(ephemeral.privateKey, peerKey);

  // Wait for the client proof before the expensive scrypt run: then every scrypt run on the hub
  // belongs to a passphrase attempt, and a wrong attempt blocks the address.
  const clientProof = expectFrame(await readHandshakeFrame(reader, false), FrameType.Auth).body;
  const derive = async () => {
    if (socket.destroyed || options.admit?.() === false) throw new ConnectionClosedError('the connection was dropped');
    return derivePassphraseKey(options.passphrase, kdfSalt(transcript), options.kdf);
  };
  const passphraseKey = await (options.kdfLimiter ? options.kdfLimiter.run(derive) : derive());
  // The connection can be dropped during scrypt (another wrong guess from the same address): no answer then.
  if (socket.destroyed) throw new ConnectionClosedError('the connection was dropped');
  const secrets = deriveSessionSecrets(shared, passphraseKey, transcript);

  if (!constantTimeEqual(clientProof, proof(secrets.clientProofKey, 'client', transcript))) {
    options.onWrongPassphrase?.();
    await delay(options.authFailureDelayMs ?? 0);
    if (!socket.destroyed) socket.end(encodeFrame(FrameType.Error, Buffer.of(HandshakeErrorCode.AuthFailed)));
    throw new HandshakeError('peer-unverified', 'the client sent a wrong passphrase');
  }

  socket.write(encodeFrame(FrameType.Auth, proof(secrets.serverProofKey, 'server', transcript)));
  return new SecureChannel(secrets.serverToClient, secrets.clientToServer);
}

function encodeHello(role: RoleValue, publicKey: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.of(PROTOCOL_VERSION, role), publicKey]);
}

function parseHello(body: Buffer, expectedRole: RoleValue): Buffer {
  if (body.length < MAGIC.length + 1 || !body.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new HandshakeError('protocol', 'the peer is not a netpaste 2 endpoint');
  }
  const version = body.readUInt8(MAGIC.length);
  if (version !== PROTOCOL_VERSION) {
    throw new HandshakeError('version-mismatch', `the peer speaks protocol version ${version}, this build speaks ${PROTOCOL_VERSION}`);
  }
  if (body.length !== HELLO_BYTES) throw new HandshakeError('protocol', 'malformed HELLO message');
  if (body.readUInt8(MAGIC.length + 1) !== expectedRole) throw new HandshakeError('protocol', 'the peer has the wrong role');
  return body.subarray(MAGIC.length + 2);
}

/** `proofSent`: whether we already sent our AUTH; a "wrong passphrase" error before that is not believable. */
async function readHandshakeFrame(reader: FrameReader, proofSent: boolean): Promise<Frame> {
  let frame: Frame;
  try {
    frame = await reader.next();
  } catch (error) {
    if (error instanceof FrameError) {
      throw new HandshakeError('protocol', 'unexpected data from the peer (is it netpaste 1.x or another program?)');
    }
    throw error;
  }
  if (frame.type === FrameType.Error) throw remoteError(frame.body, proofSent);
  return frame;
}

function expectFrame(frame: Frame, type: number): Frame {
  if (frame.type !== type) throw new HandshakeError('protocol', `unexpected message type 0x${frame.type.toString(16)} during the handshake`);
  return frame;
}

/**
 * Maps the peer's error code to our own text; the peer's bytes never reach the terminal.
 * ERROR frames are not authenticated, so callers must not trust them too much.
 */
function remoteError(body: Buffer, proofSent: boolean): HandshakeError {
  switch (body.length > 0 ? body.readUInt8(0) : 0) {
    case HandshakeErrorCode.AuthFailed:
      if (!proofSent) return new HandshakeError('protocol', 'the peer reported a wrong passphrase before the passphrase check');
      return new HandshakeError('rejected', 'the server rejected the passphrase');
    case HandshakeErrorCode.VersionMismatch:
      return new HandshakeError('version-mismatch', 'the server speaks a different protocol version; update netpaste on both machines');
    default:
      return new HandshakeError('protocol', 'the peer reported a protocol error');
  }
}

function transcriptHash(helloClient: Buffer, helloServer: Buffer): Buffer {
  return sha256(Buffer.from('netpaste/2 transcript'), helloClient, helloServer);
}

function kdfSalt(transcript: Buffer): Buffer {
  return sha256(Buffer.from('netpaste/2 kdf salt'), transcript);
}

function proof(key: Buffer, role: 'client' | 'server', transcript: Buffer): Buffer {
  const value = hmacSha256(key, Buffer.from(`netpaste/2 ${role} proof`), transcript);
  if (value.length !== PROOF_BYTES) throw new Error('unexpected proof length');
  return value;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
