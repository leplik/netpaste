# netpaste protocol, version 2

This document describes the wire protocol and the security design of netpaste 2.
Version 1 (netpaste 1.x) is not compatible.

## Overview

```
client                                                     hub
  │── TCP connect ─────────────────────────────────────────▶│
  │── HELLO  "NETPASTE" | 2 | role=0 | X25519 key eC ───────▶│
  │◀── HELLO "NETPASTE" | 2 | role=1 | X25519 key eS ────────│
  │   both: transcript, scrypt, X25519, HKDF (see below)     │
  │── AUTH   client proof ─────────────────────────────────▶│  wrong → wait 1 s, ERROR, close,
  │◀── AUTH  hub proof ──────────────────────────────────────│          block the IP address
  │══ SEALED INFO ═══════════════════════════════════════════│  both directions
  │══ SEALED CLIP / PING / PONG ══════════════════════════════│
```

## Framing

TCP is a byte stream, so every message is a frame:

```
length (u32, big-endian; counts type + body) | type (u8) | body
```

| Type | Name | When | Body |
|---|---|---|---|
| `0x01` | HELLO | handshake | 42 bytes, see below |
| `0x02` | AUTH | handshake | 32-byte proof |
| `0x03` | ERROR | handshake | 1-byte code: 1 wrong passphrase, 2 other version, 3 protocol error |
| `0x10` | SEALED | after the handshake | AES-256-GCM ciphertext + 16-byte tag |

The receiver checks the length before it buffers the body:

- before authentication, the largest body is 256 bytes;
- after authentication, the largest body is the text limit (`--max-size`, at least 4 KiB) + 17 bytes.

A frame above the limit, an unknown frame type during the handshake, or a failed decryption
closes the connection.

## Handshake

`HELLO` body: `"NETPASTE"` (8 bytes) | protocol version (u8, = 2) | role (u8: 0 client, 1 hub) | ephemeral X25519 public key (32 bytes).

Both sides compute:

```
transcript = SHA-256("netpaste/2 transcript" | helloClient | helloHub)
salt       = SHA-256("netpaste/2 kdf salt" | transcript)
pk         = scrypt(NFC(passphrase), salt, N = 2^17, r = 8, p = 1, 32 bytes)
dh         = X25519(own ephemeral private key, peer ephemeral public key)   (all-zero result is rejected)
keys       = HKDF-SHA256(ikm = dh | pk, salt = transcript, info = "netpaste/2 session keys", 128 bytes)
           = clientToHub | hubToClient | clientProofKey | hubProofKey
```

- The client sends `AUTH = HMAC-SHA256(clientProofKey, "netpaste/2 client proof" | transcript)`.
- The hub checks the client proof with a constant-time comparison.
  - **Wrong proof:** the hub waits 1 s, sends `ERROR 1`, and closes the connection. It also blocks the IP address for 1 s; every further failure doubles the block, up to 60 s.
  - **Correct proof:** the hub sends `AUTH = HMAC-SHA256(hubProofKey, "netpaste/2 server proof" | transcript)`.
- The client checks the hub proof. If it is wrong, the client closes the connection and tries again later.

The passphrase is normalized to Unicode NFC, so the same passphrase typed on macOS and on Linux gives the same key.
The hub runs at most 2 scrypt computations at the same time (each needs 128 MiB).
The whole handshake must finish within 10 s.

## Messages

Every message after the handshake is a SEALED frame:

- **Key:** `clientToHub` or `hubToClient`, depending on the direction.
- **Nonce:** 12 bytes: 4 zero bytes | 64-bit message counter of that direction, starting at 0.
- **Additional authenticated data:** the 5-byte frame header.

The plaintext is `kind (u8) | payload`:

| Kind | Name | Payload |
|---|---|---|
| 1 | CLIP | clipboard text, UTF-8, unchanged |
| 2 | PING | empty; the peer answers with PONG |
| 3 | PONG | empty |
| 4 | INFO | JSON `{"name": string, "version": string, "maxTextBytes": number}`, sent first by both sides |

A receiver ignores unknown kinds, so later versions can add messages.
The sender never sends text above `min(own limit, peer limit)`.
The receiver closes the connection when the text is above its own limit.

Liveness:

- A side sends PING when it sent nothing for 15 s.
- A side closes the connection when it received nothing for 45 s.
- TCP keepalive is on as well.

## Hub behaviour

- **Text from a client:** the hub writes it to its own clipboard (unless `--no-clipboard`) and forwards it to all other clients. The sender does not get it back.
- **Local copy on the hub:** the hub sends it to all clients.
- **No peers connected:** the clipboard is not read.
- **Echo suppression:** based on content, not on a time window. The text that netpaste writes becomes the "last known" value, so the next poll sees no change. A poll that overlaps a write is discarded.

## Discovery

The hub announces `_netpaste._tcp.local` with TXT `v=2`. The instance name is the computer name.

The SRV target is a separate name for each run, `netpaste-<name>-<random>.local`, not the computer's own
`<name>.local`. The system mDNS responder (mDNSResponder on macOS, Avahi on Linux) owns `<name>.local`.
If a second responder announces A/AAAA records for that name, the system sees a conflict and renames the
computer, for example to `<name>-2.local`. Clients connect to the address the answer came from.

`netpaste connect` without HOST searches for 3 s:

- exactly one hub found: the client connects to it;
- several hubs found: the client stops and lists them;
- no hub found: the client tries again with backoff.

## Security properties

| Threat | Result |
|---|---|
| Passive eavesdropper | Cannot read messages. Cannot test passphrase guesses: the proofs depend on the X25519 secret. |
| Stranger connects to the hub | Receives only the hub's HELLO: one ephemeral key, nothing that depends on the passphrase. Gets one online guess per connection, then the IP address is blocked. |
| Changed, replayed, reordered or reflected message | GCM authentication fails, the connection closes. Keys differ per direction and per connection. |
| Recorded traffic, passphrase leaks later | Old sessions stay secret: the keys also depend on ephemeral X25519 keys (forward secrecy). |
| Active attacker poses as the hub (mDNS spoofing, MITM) | Can try passphrase guesses **offline** against the client proof, one scrypt run per guess. Both sides contribute to the salt, so precomputed tables do not help. Only a long passphrase protects here; a PAKE (for example CPace) would remove this attack. |
| Malformed input | Closes that connection. Frame sizes are checked before buffering. |

Not hidden: the size of each message, and the time of each copy.

## Changes from version 1

Version 1 had these problems:

- unauthenticated AES-CTR: anyone could change text, and could forge messages from the known HELLO plaintext;
- the HELLO message gave material for offline passphrase guessing to anyone who connected;
- the framing broke on normal TCP segmentation;
- input of 4 bytes crashed the process.

Version 2 replaces the whole wire format.
